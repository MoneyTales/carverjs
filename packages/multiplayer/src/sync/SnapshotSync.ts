import type { CarverTransport, EntityState } from "../types";
import { Codec, SnapshotBuffer } from "../core/codec";
import { HostAuthority } from "../core/HostAuthority";
import { ClientReceiver } from "../core/ClientReceiver";

export interface SnapshotSyncOptions {
  broadcastRate?: number;
  keyframeInterval?: number;
  bufferSize?: number;
  interpolationMethod?: "hermite" | "linear";
  extrapolateMs?: number;
  is2D?: boolean;
}

/**
 * Layer 2: Snapshot interpolation sync engine.
 * Host broadcasts state at fixed intervals, clients interpolate.
 */
export class SnapshotSync {
  private _transport: CarverTransport;
  private _hostAuthority: HostAuthority | null = null;
  private _clientReceiver: ClientReceiver | null = null;
  private _codec: Codec;
  private _snapshotBuffer: SnapshotBuffer;

  constructor(
    transport: CarverTransport,
    codec: Codec,
    snapshotBuffer: SnapshotBuffer,
    options?: SnapshotSyncOptions,
  ) {
    this._transport = transport;
    this._codec = codec;
    this._snapshotBuffer = snapshotBuffer;

    if (transport.isHost) {
      this._hostAuthority = new HostAuthority(
        transport,
        codec,
        snapshotBuffer,
        {
          broadcastRate: options?.broadcastRate,
          keyframeInterval: options?.keyframeInterval,
        },
      );
    } else {
      this._clientReceiver = new ClientReceiver(transport, codec, {
        bufferSize: options?.bufferSize,
        method: options?.interpolationMethod,
        extrapolateMs: options?.extrapolateMs,
        is2D: options?.is2D,
      });
    }
  }

  get isHost(): boolean {
    return this._hostAuthority !== null;
  }

  get hostAuthority(): HostAuthority | null {
    return this._hostAuthority;
  }

  get clientReceiver(): ClientReceiver | null {
    return this._clientReceiver;
  }

  /** Host: called every fixed tick to potentially broadcast state */
  hostTick(
    tick: number,
    entities: Map<string, EntityState>,
    delta: number,
  ): void {
    this._hostAuthority?.tick(tick, entities, delta);
  }

  /** Client: called every render frame to interpolate */
  clientInterpolate(renderTime: number): Map<string, EntityState> {
    return this._clientReceiver?.interpolate(renderTime) ?? new Map();
  }

  /** Set interest filter on host authority */
  setInterestFilter(
    filter: ((entityId: string, peerId: string) => boolean) | null,
  ): void {
    this._hostAuthority?.setInterestFilter(filter);
  }

  /** Handle host migration: switch from client to host mode */
  promoteToHost(options?: SnapshotSyncOptions): void {
    this._clientReceiver?.destroy();
    this._clientReceiver = null;
    this._hostAuthority = new HostAuthority(
      this._transport,
      this._codec,
      this._snapshotBuffer,
      {
        broadcastRate: options?.broadcastRate,
        keyframeInterval: options?.keyframeInterval,
      },
    );
  }

  /** Handle host migration: switch from host to client mode */
  demoteToClient(options?: SnapshotSyncOptions): void {
    this._hostAuthority?.destroy();
    this._hostAuthority = null;
    this._clientReceiver = new ClientReceiver(
      this._transport,
      this._codec,
      {
        bufferSize: options?.bufferSize,
        method: options?.interpolationMethod,
        extrapolateMs: options?.extrapolateMs,
        is2D: options?.is2D,
      },
    );
  }

  destroy(): void {
    this._hostAuthority?.destroy();
    this._clientReceiver?.destroy();
    this._hostAuthority = null;
    this._clientReceiver = null;
  }
}
