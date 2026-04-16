import { pack, unpack } from "msgpackr";
import type {
  CarverTransport,
  CarverChannel,
  EntityState,
  EntityState3D,
  InputPacket,
} from "../types";
import { Codec } from "../core/codec";
import { TickKeeper } from "../core/TickKeeper";

interface PredictionOptions {
  maxRewindTicks: number;
  errorSmoothingDecay: number;
  maxErrorPerFrame: number;
  snapThreshold: number;
  lagCompensation: boolean;
}

interface InputBufferEntry {
  tick: number;
  input: unknown;
}

interface ErrorCorrection {
  x: number;
  y: number;
  z: number;
}

const DEFAULT_OPTIONS: PredictionOptions = {
  maxRewindTicks: 15,
  errorSmoothingDecay: 0.85,
  maxErrorPerFrame: 5,
  snapThreshold: 15,
  lagCompensation: false,
};

/**
 * Layer 3: Client-side prediction with server reconciliation.
 * Builds on top of Layer 2 (SnapshotSync).
 *
 * Flow:
 *   Client: input -> apply locally (predict) -> store in buffer -> send to host
 *   Host: receive input -> apply to simulation -> broadcast state + lastProcessedInputTick
 *   Client: receive state -> compare with prediction ->
 *           if mismatch: reset to server state + replay unacked inputs -> visual smoothing
 */
export class PredictionSync {
  private _transport: CarverTransport;
  private _codec: Codec;
  private _tickKeeper: TickKeeper;
  private _options: PredictionOptions;

  // Channels
  private _inputChannel: CarverChannel<string>;
  private _stateChannel: CarverChannel<Uint8Array>;
  private _ackChannel: CarverChannel<string>;

  // Input buffer: ring buffer of recent inputs keyed by tick
  private _inputBuffer: InputBufferEntry[] = [];
  // Per-client last processed input tick (host-side tracking)
  private _clientLastProcessedTick = new Map<string, number>();

  // Predicted state (client-side)
  private _predictedState = new Map<string, EntityState>();

  // Error correction vectors per entity
  private _errorCorrections = new Map<string, ErrorCorrection>();

  // Server state (last received authoritative snapshot)
  private _serverState = new Map<string, EntityState>();
  private _serverTick = 0;

  // Physics step callback (provided by developer)
  private _onPhysicsStep:
    | ((inputs: Map<string, unknown>, tick: number, isRollback: boolean) => void)
    | null = null;

  // Own input for current tick
  private _currentInput: unknown = null;

  // Is host
  private _isHost: boolean;

  constructor(
    transport: CarverTransport,
    codec: Codec,
    tickKeeper: TickKeeper,
    options?: Partial<PredictionOptions>,
  ) {
    this._transport = transport;
    this._codec = codec;
    this._tickKeeper = tickKeeper;
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._isHost = transport.isHost;

    // Reliable channel for inputs (client -> host)
    this._inputChannel = transport.createChannel<string>("carver:inputs", {
      reliable: true,
      ordered: true,
    });

    // Unreliable channel for state (host -> clients)
    this._stateChannel = transport.createChannel<Uint8Array>("carver:pred-state", {
      reliable: false,
      ordered: false,
      maxRetransmits: 0,
    });

    // Reliable ACK channel
    this._ackChannel = transport.createChannel<string>("carver:pred-acks", {
      reliable: true,
      ordered: true,
    });

    if (this._isHost) {
      this._setupHostListeners();
    } else {
      this._setupClientListeners();
    }
  }

  /** Set the physics step callback (required for rollback re-simulation) */
  setPhysicsStep(
    cb: (inputs: Map<string, unknown>, tick: number, isRollback: boolean) => void,
  ): void {
    this._onPhysicsStep = cb;
  }

  /** Set the current input for this tick (client-side) */
  setInput(input: unknown): void {
    this._currentInput = input;
  }

  /**
   * Called every fixed tick on the client.
   * Applies input locally (prediction), buffers it, and sends to host.
   */
  clientTick(tick: number): void {
    if (this._isHost) return;

    // Buffer the input
    if (this._currentInput !== null) {
      this._inputBuffer.push({ tick, input: this._currentInput });

      // Send input to host
      const packet: InputPacket = {
        t: tick,
        i: this._currentInput,
        p: this._transport.peerId,
      };
      this._inputChannel.send(JSON.stringify(packet));

      // Apply input locally (prediction)
      if (this._onPhysicsStep) {
        const inputs = new Map<string, unknown>();
        inputs.set(this._transport.peerId, this._currentInput);
        this._onPhysicsStep(inputs, tick, false);
      }

      this._currentInput = null;
    }

    // Trim old inputs from buffer
    const minTick = tick - this._options.maxRewindTicks * 2;
    while (this._inputBuffer.length > 0 && this._inputBuffer[0].tick < minTick) {
      this._inputBuffer.shift();
    }
  }

  /**
   * Called every fixed tick on the host.
   * Processes received inputs and broadcasts authoritative state.
   */
  hostTick(tick: number, entities: Map<string, EntityState>, _delta: number): void {
    if (!this._isHost) return;

    // Broadcast authoritative state with per-client last processed input tick
    const stateArray = Array.from(entities.values());
    const data = this._codec.serialize(stateArray);

    // Send per-client packets with each client's own last processed input tick
    for (const peerId of this._transport.peers) {
      const lastTick = this._clientLastProcessedTick.get(peerId) ?? -1;
      const packet = {
        t: tick,
        s: data,
        li: lastTick,
      };
      this._stateChannel.send(pack(packet), peerId);
    }
  }

  /**
   * Called every render frame on the client to apply visual error smoothing.
   * Returns the corrected entity states.
   */
  applyErrorSmoothing(entities: Map<string, EntityState>): Map<string, EntityState> {
    const result = new Map<string, EntityState>();
    const decay = this._options.errorSmoothingDecay;

    for (const [id, entity] of entities) {
      const correction = this._errorCorrections.get(id);
      if (!correction) {
        result.set(id, entity);
        continue;
      }

      // Apply correction and decay
      const corrected = { ...entity };
      corrected.x += correction.x;
      corrected.y += correction.y;
      if ("z" in corrected) {
        (corrected as EntityState3D).z += correction.z;
      }

      // Decay the correction
      correction.x *= decay;
      correction.y *= decay;
      correction.z *= decay;

      // Remove if negligible
      const mag = Math.abs(correction.x) + Math.abs(correction.y) + Math.abs(correction.z);
      if (mag < 0.001) {
        this._errorCorrections.delete(id);
      }

      result.set(id, corrected);
    }

    return result;
  }

  get predictedState(): Map<string, EntityState> {
    return this._predictedState;
  }

  get serverTick(): number {
    return this._serverTick;
  }

  destroy(): void {
    this._inputChannel.close();
    this._stateChannel.close();
    this._ackChannel.close();
    this._inputBuffer = [];
    this._predictedState.clear();
    this._errorCorrections.clear();
    this._serverState.clear();
  }

  // ── Private: Host-side ──

  private _setupHostListeners(): void {
    // Receive inputs from clients
    this._inputChannel.onReceive((rawData: string, peerId: string) => {
      try {
        const packet: InputPacket = JSON.parse(rawData);
        // Apply input to simulation via callback
        if (this._onPhysicsStep) {
          const inputs = new Map<string, unknown>();
          inputs.set(peerId, packet.i);
          this._onPhysicsStep(inputs, packet.t, false);
        }
        const prevTick = this._clientLastProcessedTick.get(peerId) ?? -1;
        this._clientLastProcessedTick.set(peerId, Math.max(prevTick, packet.t));
      } catch (err) {
        if (typeof console !== 'undefined') console.debug('[CarverJS] Malformed input packet:', err);
      }
    });
  }

  // ── Private: Client-side ──

  private _setupClientListeners(): void {
    // Receive authoritative state from host
    this._stateChannel.onReceive((data: Uint8Array) => {
      try {
        const packet = unpack(data) as { t: number; s: Uint8Array; li: number };

        const entities = this._codec.deserialize(packet.s);
        const serverTick = packet.t;
        const lastInputTick = packet.li;

        this._serverTick = serverTick;
        this._tickKeeper.setServerTick(serverTick);

        // Build server state map
        this._serverState.clear();
        for (const entity of entities) {
          this._serverState.set(entity.id, entity);
        }

        // Reconciliation: compare predicted state with server state
        this._reconcile(lastInputTick);
      } catch (err) {
        if (typeof console !== 'undefined') console.debug('[CarverJS] Malformed state packet:', err);
      }
    });
  }

  private _reconcile(lastInputTick: number): void {
    // Remove acknowledged inputs from buffer
    this._inputBuffer = this._inputBuffer.filter((entry) => entry.tick > lastInputTick);

    // Compare predicted state with server state
    let needsRollback = false;
    let maxError = 0;

    for (const [id, serverEntity] of this._serverState) {
      const predicted = this._predictedState.get(id);
      if (!predicted) continue;

      const error = this._computeError(predicted, serverEntity);
      maxError = Math.max(maxError, error);

      if (error > this._options.maxErrorPerFrame) {
        needsRollback = true;
      }
    }

    if (maxError > this._options.snapThreshold) {
      // Error too large -- hard snap to server state
      this._predictedState = new Map(this._serverState);
      this._errorCorrections.clear();
      return;
    }

    if (needsRollback) {
      // Store current positions for visual smoothing
      const oldPositions = new Map<string, { x: number; y: number; z: number }>();
      for (const [id, entity] of this._predictedState) {
        oldPositions.set(id, {
          x: entity.x,
          y: entity.y,
          z: "z" in entity ? (entity as EntityState3D).z : 0,
        });
      }

      // Reset to server state
      this._predictedState = new Map(this._serverState);

      // Replay unacked inputs
      if (this._onPhysicsStep) {
        for (const entry of this._inputBuffer) {
          const inputs = new Map<string, unknown>();
          inputs.set(this._transport.peerId, entry.input);
          this._onPhysicsStep(inputs, entry.tick, true); // isRollback = true
        }
      }

      // Compute visual error correction vectors
      for (const [id, newEntity] of this._predictedState) {
        const oldPos = oldPositions.get(id);
        if (oldPos) {
          this._errorCorrections.set(id, {
            x: oldPos.x - newEntity.x,
            y: oldPos.y - newEntity.y,
            z: oldPos.z - ("z" in newEntity ? (newEntity as EntityState3D).z : 0),
          });
        }
      }
    }
  }

  private _computeError(predicted: EntityState, server: EntityState): number {
    const dx = predicted.x - server.x;
    const dy = predicted.y - server.y;
    let dz = 0;
    if ("z" in predicted && "z" in server) {
      dz = (predicted as EntityState3D).z - (server as EntityState3D).z;
    }
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}
