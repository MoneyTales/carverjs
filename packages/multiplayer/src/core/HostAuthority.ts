import type { CarverTransport, CarverChannel, EntityState } from "../types";
import { Codec, SnapshotBuffer } from "./codec";

/**
 * Host-side authority: reads networked actor states, serializes with delta compression,
 * and broadcasts to all clients at the configured broadcast rate.
 */
export class HostAuthority {
  private _transport: CarverTransport;
  private _codec: Codec;
  private _snapshotBuffer: SnapshotBuffer;
  private _snapshotChannel: CarverChannel<Uint8Array>;
  private _ackChannel: CarverChannel<string>;
  private _tick = 0;
  private _broadcastRate: number;
  private _broadcastAccumulator = 0;
  private _keyframeInterval: number;

  // Per-client last ACK'd tick for delta compression
  private _clientBaselines = new Map<string, number>();
  // Per-client last keyframe tick for scheduling
  private _clientLastKeyframeTick = new Map<string, number>();

  // Interest management callback (optional)
  private _interestFilter:
    | ((entityId: string, peerId: string) => boolean)
    | null = null;

  constructor(
    transport: CarverTransport,
    codec: Codec,
    snapshotBuffer: SnapshotBuffer,
    options?: {
      broadcastRate?: number;
      keyframeInterval?: number;
    },
  ) {
    this._transport = transport;
    this._codec = codec;
    this._snapshotBuffer = snapshotBuffer;
    this._broadcastRate = options?.broadcastRate ?? 20;
    this._keyframeInterval = options?.keyframeInterval ?? 300;

    // Unreliable channel for snapshots (fast, may drop)
    this._snapshotChannel = transport.createChannel<Uint8Array>(
      "carver:snapshots",
      {
        reliable: false,
        ordered: false,
        maxRetransmits: 0,
      },
    );

    // Reliable channel for ACKs
    this._ackChannel = transport.createChannel<string>("carver:acks", {
      reliable: true,
      ordered: true,
    });

    // Listen for client ACKs
    this._ackChannel.onReceive((data: string, peerId: string) => {
      try {
        const ackTick =
          typeof data === "string"
            ? parseInt(data, 10)
            : (data as unknown as number);
        if (ackTick === -1) {
          // Client requesting keyframe
          this._clientBaselines.delete(peerId);
        } else {
          this._clientBaselines.set(peerId, ackTick);
        }
      } catch {
        /* ignore malformed ACKs */
      }
    });

    // Handle new peer joins — they need a keyframe
    transport.onPeerJoin((peerId) => {
      this._clientBaselines.delete(peerId); // Will force keyframe
    });

    transport.onPeerLeave((peerId) => {
      this._clientBaselines.delete(peerId);
    });
  }

  /** Set optional interest management filter */
  setInterestFilter(
    filter: ((entityId: string, peerId: string) => boolean) | null,
  ): void {
    this._interestFilter = filter;
  }

  /**
   * Called every fixed tick by the sync engine.
   * Collects entity states and decides whether to broadcast.
   */
  tick(
    currentTick: number,
    entities: Map<string, EntityState>,
    delta: number,
  ): void {
    this._tick = currentTick;

    // Store snapshot in ring buffer
    this._snapshotBuffer.store(currentTick, new Map(entities));

    // Check if we should broadcast this tick
    this._broadcastAccumulator += delta;
    const broadcastInterval = 1 / this._broadcastRate;
    if (this._broadcastAccumulator < broadcastInterval) return;
    this._broadcastAccumulator -= broadcastInterval;

    // Broadcast to each connected client
    for (const peerId of this._transport.peers) {
      this._broadcastToClient(peerId, currentTick, entities);
    }
  }

  /** Force a keyframe broadcast to all clients (e.g., after host migration) */
  forceKeyframe(
    currentTick: number,
    entities: Map<string, EntityState>,
  ): void {
    this._clientBaselines.clear();
    this._clientLastKeyframeTick.clear();
    this._snapshotBuffer.store(currentTick, new Map(entities));
    for (const peerId of this._transport.peers) {
      this._broadcastToClient(peerId, currentTick, entities);
    }
  }

  destroy(): void {
    this._snapshotChannel.close();
    this._ackChannel.close();
    this._clientBaselines.clear();
    this._clientLastKeyframeTick.clear();
  }

  private _broadcastToClient(
    peerId: string,
    currentTick: number,
    entities: Map<string, EntityState>,
  ): void {
    // Apply interest management filter
    let clientEntities = entities;
    if (this._interestFilter) {
      clientEntities = new Map<string, EntityState>();
      for (const [id, entity] of entities) {
        if (this._interestFilter(id, peerId)) {
          clientEntities.set(id, entity);
        }
      }
    }

    // Determine baseline for delta compression (per-client keyframe scheduling)
    const clientBaseTick = this._clientBaselines.get(peerId);
    const clientLastKeyframe = this._clientLastKeyframeTick.get(peerId) ?? 0;
    const needsKeyframe =
      clientBaseTick === undefined ||
      currentTick - clientLastKeyframe >= this._keyframeInterval;

    let baseline: Map<string, EntityState> | undefined;
    if (!needsKeyframe && clientBaseTick !== undefined) {
      baseline = this._snapshotBuffer.get(clientBaseTick);
    }

    if (needsKeyframe) {
      this._clientLastKeyframeTick.set(peerId, currentTick);
    }

    // Serialize (delta or keyframe)
    const packet = this._codec.serializeDelta(
      currentTick,
      needsKeyframe ? -1 : (clientBaseTick ?? -1),
      clientEntities,
      baseline,
    );

    if (packet) {
      this._snapshotChannel.send(packet, peerId);
    }
  }
}
