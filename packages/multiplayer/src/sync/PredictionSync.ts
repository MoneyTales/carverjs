/**
 * Layer 3: Full-world prediction with full-world rollback.
 * Ported from LumberNet, built on top of Layer 2 (SnapshotSync) as the
 * authoritative state channel.
 *
 * Flow:
 *   Every peer (host included): broadcast tick-stamped input to ALL peers each
 *   fixed tick on carver:inputs, simulate EVERY networked entity forward with
 *   last-known remote inputs (hold-last-input extrapolation).
 *
 *   Host: stays authoritative; SnapshotSync broadcasts delta-compressed,
 *   ACK-driven snapshots with the host's own input embedded (`hi`).
 *
 *   Client: on each accepted snapshot, reset ALL networked entities to server
 *   state, resimulate from serverTick + 1 to localTick replaying per-tick
 *   inputs for every peer, and convert the visual discontinuity into
 *   per-entity error offsets decayed per render frame.
 *
 * Role is checked dynamically via transport.isHost at every use site (host
 * migration is best-effort).
 */

import type {
  CarverTransport,
  CarverChannel,
  EntityState,
  ErrorOffset,
  InputPacket,
  PhysicsStepCallback,
  PlayerInput,
  PredictionSyncOptions,
  PredictionWorldDriver,
  SnapshotSource,
} from "../types";
import { TickKeeper } from "../core/TickKeeper";
import { InputBuffer } from "../core/InputBuffer";
import { computeJustPressed } from "../core/InputUtils";
import { applyRollback, quatAngle, quatScaleAngle } from "./Rollback";

const DEFAULT_OPTIONS: Required<PredictionSyncOptions> = {
  maxRewindTicks: 15,
  snapThreshold: 150,
  errorDecay: 0.85,
  maxErrorPerFrame: 0,
  neutralInput: {},
  inputHistorySize: 120,
  driftTargetTicks: 4,
};

interface PendingSnapshot {
  t: number;
  entities: Map<string, EntityState>;
  hostInput: PlayerInput | undefined;
}

export class PredictionSync {
  private _transport: CarverTransport;
  private _tickKeeper: TickKeeper;
  private _options: Required<PredictionSyncOptions>;

  // Reliable ordered all-to-all input channel
  private _inputChannel: CarverChannel<InputPacket>;

  // Local + per-peer tick-stamped input history
  private _inputs: InputBuffer;

  // Local input; persists across ticks until replaced (hold-input semantics)
  private _currentInput: PlayerInput | null = null;

  // Newest pending server snapshot awaiting rollback (only the newest survives)
  private _pending: PendingSnapshot | null = null;

  // Per-entity accumulated visual error offsets
  private _errors = new Map<string, ErrorOffset>();

  private _serverTick = 0;
  private _lastAppliedServerTick = 0;

  private _worldDriver: PredictionWorldDriver | null = null;
  private _onPhysicsStep: PhysicsStepCallback | null = null;

  constructor(
    transport: CarverTransport,
    tickKeeper: TickKeeper,
    snapshots: SnapshotSource,
    options?: PredictionSyncOptions,
  ) {
    this._transport = transport;
    this._tickKeeper = tickKeeper;
    this._options = { ...DEFAULT_OPTIONS, ...options };

    this._inputs = new InputBuffer(
      this._options.neutralInput,
      this._options.inputHistorySize,
    );

    // All-to-all input broadcast channel (registered regardless of role)
    this._inputChannel = transport.createChannel<InputPacket>("carver:inputs", {
      reliable: true,
      ordered: true,
    });

    this._inputChannel.onReceive(
      (data: InputPacket | string, peerId: string) => {
        try {
          const packet =
            typeof data === "string" ? (JSON.parse(data) as InputPacket) : data;
          if (
            typeof packet.t === "number" &&
            packet.i !== null &&
            typeof packet.i === "object"
          ) {
            // Key by the transport-provided sender id; never trust packet.p
            this._inputs.setRemote(peerId, packet.i, packet.t);
          }
        } catch (err) {
          if (typeof console !== "undefined")
            console.debug("[CarverJS] Malformed input packet:", err);
        }
      },
    );

    // Accepted snapshots become pending rollbacks (clients only)
    snapshots.onSnapshot((tick, entities, hostInput) => {
      if (this._transport.isHost) return;
      if (tick <= this._lastAppliedServerTick) return;
      this._serverTick = tick;
      this._tickKeeper.setServerTick(tick);
      if (!this._pending || tick > this._pending.t) {
        this._pending = { t: tick, entities, hostInput };
      }
    });

    // Drop input state for departed peers
    transport.onPeerLeave(() => {
      this._inputs.setPeerIds(this._transport.peers);
    });
  }

  // ── Wiring ──

  /** Set the game simulation callback (forward sim + rollback resim). */
  setPhysicsStep(cb: PhysicsStepCallback): void {
    this._onPhysicsStep = cb;
  }

  /** Set the world driver used for forward stepping and rollback. */
  setWorldDriver(driver: PredictionWorldDriver): void {
    this._worldDriver = driver;
  }

  // ── Input ──

  /** Set the local player's input. PERSISTS across ticks until replaced. */
  setInput(input: PlayerInput): void {
    this._currentInput = input;
  }

  /** Local input stored at the given tick (neutral fallback). Used by the host to embed `hi`. */
  getLocalInput(tick: number): PlayerInput {
    return this._inputs.getTick(tick);
  }

  // ── Frame lifecycle ──

  /**
   * Apply the newest pending server snapshot (full-world rollback).
   * Call once per render frame BEFORE tickKeeper.update().
   * No-op on host or when nothing is pending.
   */
  beginFrame(): void {
    if (this._transport.isHost || !this._pending) return;

    const pending = this._pending;
    this._pending = null;
    this._lastAppliedServerTick = pending.t;

    // Consume the host's embedded input: last-known AND tick history at the snapshot tick
    if (pending.hostInput !== undefined) {
      this._inputs.setRemote(
        this._transport.hostId,
        pending.hostInput,
        pending.t,
      );
    }

    // Rollback is impossible without world access (bookkeeping above still happened)
    if (!this._worldDriver) return;

    const result = applyRollback({
      serverTick: pending.t,
      serverState: pending.entities,
      localTick: this._tickKeeper.tick,
      localPeerId: this._transport.peerId,
      inputs: this._inputs,
      currentErrors: this._errors,
      driver: this._worldDriver,
      callback: this._onPhysicsStep,
      dt: this._tickKeeper.tickDelta,
      driftTargetTicks: this._options.driftTargetTicks,
      maxRewindTicks: this._options.maxRewindTicks,
      snapThreshold: this._options.snapThreshold,
    });
    this._errors = result.errors;
    if (result.newLocalTick !== this._tickKeeper.tick) {
      this._tickKeeper.snapTick(result.newLocalTick);
    }
  }

  /**
   * Run one forward fixed tick (host AND client): store + broadcast input,
   * build per-tick input maps, invoke the callback, then step the world.
   */
  tick(tick: number): void {
    const localInput = this._currentInput ?? { ...this._options.neutralInput };

    // Store a copy so each tick gets its own history entry
    this._inputs.storeTick(tick, localInput);

    // Broadcast to ALL peers every tick (reliable-ordered guarantees tick history)
    this._inputChannel.send({
      t: tick,
      i: localInput,
      p: this._transport.peerId,
    });

    // Build per-tick maps: last-known remote inputs (hold-last-input extrapolation)
    const prevTick = tick - 1;
    const tickInputs = this._inputs.allRemotes();
    tickInputs.delete(this._transport.peerId); // defensive: never simulate self as remote
    const justPressed = new Map<string, PlayerInput>();
    for (const [peerId, inp] of tickInputs) {
      justPressed.set(
        peerId,
        computeJustPressed(inp, this._inputs.getRemoteAtTick(peerId, prevTick)),
      );
    }
    tickInputs.set(this._transport.peerId, localInput);
    justPressed.set(
      this._transport.peerId,
      this._inputs.hasTick(prevTick)
        ? computeJustPressed(localInput, this._inputs.getTick(prevTick))
        : this._inputs.getJustPressedZero(), // suppress spurious edges after snap/rejoin
    );

    if (this._onPhysicsStep) {
      this._onPhysicsStep(
        tickInputs,
        justPressed,
        tick,
        false,
        this._tickKeeper.tickDelta,
      );
    }

    // Callback first (applies forces), then step
    this._worldDriver?.stepWorld?.();
  }

  /**
   * Decay stored error offsets and return the portion to ADD to rendered
   * transforms this frame. Call exactly once per render frame.
   */
  getRenderErrorOffsets(): Map<string, ErrorOffset> {
    const result = new Map<string, ErrorOffset>();
    const decay = this._options.errorDecay;
    const maxErr = this._options.maxErrorPerFrame;

    for (const [id, e] of this._errors) {
      // Decay
      e.x *= decay;
      e.y *= decay;
      e.z *= decay;
      e.a *= decay;
      let q = quatScaleAngle({ x: e.qx, y: e.qy, z: e.qz, w: e.qw }, decay);

      // Zero-clamp
      if (Math.abs(e.x) < 0.1) e.x = 0;
      if (Math.abs(e.y) < 0.1) e.y = 0;
      if (Math.abs(e.z) < 0.1) e.z = 0;
      if (Math.abs(e.a) < 0.001) e.a = 0;
      if (quatAngle(q) < 0.001) q = { x: 0, y: 0, z: 0, w: 1 };
      e.qx = q.x;
      e.qy = q.y;
      e.qz = q.z;
      e.qw = q.w;

      // Applied portion (position cap only; angular error always applied in full)
      let ax = e.x;
      let ay = e.y;
      let az = e.z;
      if (maxErr > 0) {
        const mag = Math.hypot(e.x, e.y, e.z);
        if (mag > maxErr) {
          const s = maxErr / mag;
          ax = e.x * s;
          ay = e.y * s;
          az = e.z * s;
          e.x -= ax;
          e.y -= ay;
          e.z -= az;
        } else {
          // Fully applied and consumed
          e.x = 0;
          e.y = 0;
          e.z = 0;
        }
      }

      const quatIsIdentity =
        e.qx === 0 && e.qy === 0 && e.qz === 0 && e.qw === 1;

      if (ax !== 0 || ay !== 0 || az !== 0 || e.a !== 0 || !quatIsIdentity) {
        result.set(id, {
          x: ax,
          y: ay,
          z: az,
          a: e.a,
          qx: e.qx,
          qy: e.qy,
          qz: e.qz,
          qw: e.qw,
        });
      }

      if (e.x === 0 && e.y === 0 && e.z === 0 && e.a === 0 && quatIsIdentity) {
        this._errors.delete(id);
      }
    }

    return result;
  }

  // ── State ──

  /** Tick of the newest RECEIVED snapshot. */
  get serverTick(): number {
    return this._serverTick;
  }

  /** Tick of the newest APPLIED (rolled-back) snapshot, 0 initially. */
  get lastAppliedServerTick(): number {
    return this._lastAppliedServerTick;
  }

  destroy(): void {
    this._inputChannel.close();
    this._inputs.clear();
    this._errors.clear();
    this._pending = null;
    this._currentInput = null;
  }
}
