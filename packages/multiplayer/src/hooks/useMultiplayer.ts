import { useEffect, useRef, useState, useCallback } from "react";
import { useFrame } from "@react-three/fiber";
import { getActorRegistry } from "@carverjs/core/systems";
import type { ActorRef, NetworkedConfig } from "@carverjs/core/types";
import type {
  UseMultiplayerOptions,
  NetworkQuality,
  SyncMode,
  EntityState,
  EntityState2D,
  EntityState3D,
  PlayerInput,
  PredictionWorldDriver,
} from "../types";
import { useMultiplayerContext } from "../core/MultiplayerContext";
import { EventSync } from "../sync/EventSync";
import { SnapshotSync } from "../sync/SnapshotSync";
import type { SnapshotSyncOptions } from "../sync/SnapshotSync";
import { PredictionSync } from "../sync/PredictionSync";
import { quatMultiply, quatInvert } from "../sync/Rollback";
import type { Quat } from "../sync/Rollback";
import { NetworkSimulator } from "../core/NetworkSimulator";

// ── Return type ──

export interface UseMultiplayerReturn {
  isActive: boolean;
  networkQuality: NetworkQuality;
  tick: number;
  serverTick: number;
  drift: number;
  syncEngine: SyncMode;
  /** Set the local player's input (prediction mode). Stable callback; no-op in events/snapshot modes. */
  setInput: (input: PlayerInput) => void;
}

// ── Helpers: read / write actor state ──

const Z_THRESHOLD = 0.01;

function detect2D(actors: Map<string, ActorRef>): boolean {
  for (const [, ref] of actors) {
    if (Math.abs(ref.object3D.position.z) > Z_THRESHOLD) return false;
  }
  return true;
}

function readEntityState2D(ref: ActorRef): EntityState2D {
  const pos = ref.object3D.position;
  const rot = ref.object3D.rotation;
  const rb = ref.rigidBody;

  let vx = 0;
  let vy = 0;
  let va = 0;

  if (rb) {
    try {
      const lv = rb.linvel();
      vx = lv.x;
      vy = lv.y;
    } catch { /* rigid body may not support linvel */ }
    try {
      const av = rb.angvel();
      // 2D angular velocity is a scalar in Rapier 2D, but in 3D mode it's a vec3
      va = typeof av === "number" ? av : (av?.z ?? 0);
    } catch { /* rigid body may not support angvel */ }
  }

  const nc = ref.userData.networked as NetworkedConfig | undefined;
  const custom = nc?.custom;

  return {
    id: ref.id,
    x: pos.x,
    y: pos.y,
    a: rot.z,
    vx,
    vy,
    va,
    ...(custom ? { c: custom } : {}),
  };
}

function readEntityState3D(ref: ActorRef): EntityState3D {
  const pos = ref.object3D.position;
  const quat = ref.object3D.quaternion;
  const rb = ref.rigidBody;

  let vx = 0;
  let vy = 0;
  let vz = 0;
  let wx = 0;
  let wy = 0;
  let wz = 0;

  if (rb) {
    try {
      const lv = rb.linvel();
      vx = lv.x;
      vy = lv.y;
      vz = lv.z ?? 0;
    } catch { /* no linvel */ }
    try {
      const av = rb.angvel();
      wx = av.x ?? 0;
      wy = av.y ?? 0;
      wz = av.z ?? 0;
    } catch { /* no angvel */ }
  }

  const nc = ref.userData.networked as NetworkedConfig | undefined;
  const custom = nc?.custom;

  return {
    id: ref.id,
    x: pos.x,
    y: pos.y,
    z: pos.z,
    qx: quat.x,
    qy: quat.y,
    qz: quat.z,
    qw: quat.w,
    vx,
    vy,
    vz,
    wx,
    wy,
    wz,
    ...(custom ? { c: custom } : {}),
  };
}

function buildEntityMap(
  actors: Map<string, ActorRef>,
  is2D: boolean,
): Map<string, EntityState> {
  const entities = new Map<string, EntityState>();
  for (const [id, ref] of actors) {
    const nc = ref.userData.networked as NetworkedConfig | undefined;
    if (nc && nc.sync === false) continue;
    entities.set(id, is2D ? readEntityState2D(ref) : readEntityState3D(ref));
  }
  return entities;
}

function applyState2D(ref: ActorRef, state: EntityState2D): void {
  ref.object3D.position.set(state.x, state.y, 0);
  ref.object3D.rotation.z = state.a;

  if (ref.rigidBody) {
    try {
      if (typeof ref.rigidBody.setTranslation === "function") {
        ref.rigidBody.setTranslation({ x: state.x, y: state.y }, true);
      }
      if (typeof ref.rigidBody.setRotation === "function") {
        ref.rigidBody.setRotation(state.a, true);
      }
    } catch { /* kinematic API may not be available */ }
  }
}

function applyState3D(ref: ActorRef, state: EntityState3D): void {
  ref.object3D.position.set(state.x, state.y, state.z);
  ref.object3D.quaternion.set(state.qx, state.qy, state.qz, state.qw);

  if (ref.rigidBody) {
    try {
      if (typeof ref.rigidBody.setTranslation === "function") {
        ref.rigidBody.setTranslation({ x: state.x, y: state.y, z: state.z }, true);
      }
      if (typeof ref.rigidBody.setRotation === "function") {
        ref.rigidBody.setRotation(
          { x: state.qx, y: state.qy, z: state.qz, w: state.qw },
          true,
        );
      }
    } catch { /* kinematic API may not be available */ }
  }
}

/** Hard state apply for prediction/rollback: transform plus linear and angular velocity. */
function applyStateHard2D(ref: ActorRef, state: EntityState2D): void {
  applyState2D(ref, state);

  if (ref.rigidBody) {
    try {
      if (typeof ref.rigidBody.setLinvel === "function") {
        ref.rigidBody.setLinvel({ x: state.vx, y: state.vy }, true);
      }
      if (typeof ref.rigidBody.setAngvel === "function") {
        ref.rigidBody.setAngvel(state.va, true);
      }
    } catch { /* velocity API may not be available */ }
  }
}

/** Hard state apply for prediction/rollback: transform plus linear and angular velocity. */
function applyStateHard3D(ref: ActorRef, state: EntityState3D): void {
  applyState3D(ref, state);

  if (ref.rigidBody) {
    try {
      if (typeof ref.rigidBody.setLinvel === "function") {
        ref.rigidBody.setLinvel({ x: state.vx, y: state.vy, z: state.vz }, true);
      }
      if (typeof ref.rigidBody.setAngvel === "function") {
        ref.rigidBody.setAngvel({ x: state.wx, y: state.wy, z: state.wz }, true);
      }
    } catch { /* velocity API may not be available */ }
  }
}

function applyEntityState(
  ref: ActorRef,
  state: EntityState,
  is2D: boolean,
): void {
  if (is2D) {
    applyState2D(ref, state as EntityState2D);
  } else {
    applyState3D(ref, state as EntityState3D);
  }
}

function applyStatesToActors(
  states: Map<string, EntityState>,
  registry: ReturnType<typeof getActorRegistry>,
  is2D: boolean,
): void {
  for (const [id, state] of states) {
    // Skip tombstones
    if (state.c && (state.c as Record<string, unknown>).__removed) continue;

    const ref = registry.get(id);
    if (!ref) continue;

    applyEntityState(ref, state, is2D);
  }
}

// ── Applied error-offset bookkeeping (prediction mode, render-only) ──

interface AppliedErrorRecord {
  x: number;
  y: number;
  z: number;
  a: number;
  q: Quat;
  px: number;
  py: number;
  pz: number;
}

const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

function isIdentityQuat(q: Quat): boolean {
  return q.x === 0 && q.y === 0 && q.z === 0 && q.w === 1;
}

// ── Hook ──

export function useMultiplayer(
  options: UseMultiplayerOptions = {},
): UseMultiplayerReturn {
  const { networkManager } = useMultiplayerContext();
  const mode: SyncMode = options.mode ?? networkManager.syncMode;

  // Refs for sync engines (mutable across renders, don't trigger re-render)
  const eventSyncRef = useRef<EventSync | null>(null);
  const snapshotSyncRef = useRef<SnapshotSync | null>(null);
  const predictionSyncRef = useRef<PredictionSync | null>(null);
  const networkSimulatorRef = useRef<NetworkSimulator | null>(null);
  const is2DRef = useRef<boolean | null>(null);

  // Observable state exposed to consumers
  const [isActive, setIsActive] = useState(false);
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality>("good");
  const [tick, setTick] = useState(0);
  const [serverTick, setServerTick] = useState(0);
  const [drift, setDrift] = useState(0);

  const actorRegistry = useRef(getActorRegistry());

  // Track whether we were the host last frame to detect migration
  const wasHostRef = useRef<boolean | null>(null);

  // Error offsets applied to rendered transforms last frame (prediction mode).
  // px/py/pz fingerprint the post-application position so we only undo when
  // nothing else rewrote the transform in between.
  const appliedErrorsRef = useRef(new Map<string, AppliedErrorRecord>());

  // Build SnapshotSyncOptions from user options
  const buildSnapshotOpts = useCallback((): SnapshotSyncOptions => {
    return {
      broadcastRate: options.broadcastRate,
      keyframeInterval: options.keyframeInterval,
      bufferSize: options.interpolation?.bufferSize,
      interpolationMethod: options.interpolation?.method,
      extrapolateMs: options.interpolation?.extrapolateMs,
      is2D: is2DRef.current ?? true,
    };
  }, [
    options.broadcastRate,
    options.keyframeInterval,
    options.interpolation?.bufferSize,
    options.interpolation?.method,
    options.interpolation?.extrapolateMs,
  ]);

  // Undo last frame's render-only error offsets so physics/rollback sees raw transforms.
  const undoAppliedErrorOffsets = useCallback(() => {
    const registry = actorRegistry.current;
    for (const [id, e] of appliedErrorsRef.current) {
      const ref = registry.get(id);
      if (!ref) {
        appliedErrorsRef.current.delete(id);
        continue;
      }
      const pos = ref.object3D.position;
      const untouched =
        Math.abs(pos.x - e.px) < 1e-9 &&
        Math.abs(pos.y - e.py) < 1e-9 &&
        Math.abs(pos.z - e.pz) < 1e-9;
      if (untouched) {
        pos.x -= e.x;
        pos.y -= e.y;
        pos.z -= e.z;
        if (e.a !== 0) {
          ref.object3D.rotation.z -= e.a;
        }
        if (!isIdentityQuat(e.q)) {
          const inv = quatInvert(e.q);
          const cur = ref.object3D.quaternion;
          const r = quatMultiply(inv, { x: cur.x, y: cur.y, z: cur.z, w: cur.w });
          cur.set(r.x, r.y, r.z, r.w);
        }
      }
      // Fingerprint mismatch: something rewrote the transform — drop the record.
    }
    appliedErrorsRef.current.clear();
  }, []);

  // Stable input setter — delegates to PredictionSync; no-op in events/snapshot modes.
  const setInput = useCallback((input: PlayerInput) => {
    predictionSyncRef.current?.setInput(input);
  }, []);

  // ── Setup & teardown sync engines ──
  useEffect(() => {
    const transport = networkManager.transport;
    if (!transport) return;

    // Setup network simulator if debug options are configured
    const debugOpts = options.debug;
    let simulator: NetworkSimulator | null = null;
    if (debugOpts?.simulatedLatencyMs || debugOpts?.simulatedPacketLoss) {
      simulator = new NetworkSimulator({
        latencyMs: debugOpts.simulatedLatencyMs,
        packetLoss: debugOpts.simulatedPacketLoss,
      });
      networkSimulatorRef.current = simulator;

      // Wrap transport.createChannel so all new channels go through the simulator
      const origCreateChannel = transport.createChannel.bind(transport);
      transport.createChannel = <T>(name: string, channelOpts?: import("../types").ChannelOptions) => {
        const ch = origCreateChannel<T>(name, channelOpts);
        const wrappedSend = simulator!.wrapSend(ch.send.bind(ch));
        return { ...ch, send: wrappedSend };
      };
    }

    // Always create EventSync (Layer 1) - it's lightweight and useful for all modes
    eventSyncRef.current = new EventSync(transport);

    // Create Layer 2 / Layer 3 based on mode
    if (mode === "snapshot" || mode === "prediction") {
      snapshotSyncRef.current = new SnapshotSync(
        transport,
        networkManager.codec,
        networkManager.snapshotBuffer,
        buildSnapshotOpts(),
      );
    }

    if (mode === "prediction") {
      // World driver: full-world capture/apply for forward sim and rollback.
      // Closures read live refs so the driver tracks registry and 2D detection.
      const driver: PredictionWorldDriver = {
        captureState: () =>
          buildEntityMap(actorRegistry.current.getNetworked(), is2DRef.current ?? true),
        applyState: (entities) => {
          const is2D = is2DRef.current ?? true;
          for (const state of entities) {
            if (state.c && (state.c as Record<string, unknown>).__removed) continue;
            const ref = actorRegistry.current.get(state.id);
            if (!ref) continue;
            if (is2D) applyStateHard2D(ref, state as EntityState2D);
            else applyStateHard3D(ref, state as EntityState3D);
          }
        },
        ...(options.stepWorld ? { stepWorld: options.stepWorld } : {}),
      };

      predictionSyncRef.current = new PredictionSync(
        transport,
        networkManager.tickKeeper,
        snapshotSyncRef.current!,
        options.prediction,
      );
      if (options.onPhysicsStep) {
        predictionSyncRef.current.setPhysicsStep(options.onPhysicsStep);
      }
      predictionSyncRef.current.setWorldDriver(driver);
    }

    wasHostRef.current = networkManager.isHost;
    setIsActive(true);

    // Listen for host migration
    const unsubHostChanged = (() => {
      const onHostChanged = (newHostId: string) => {
        const amNewHost = newHostId === transport.peerId;
        const wasPreviouslyHost = wasHostRef.current;
        wasHostRef.current = amNewHost;

        if (amNewHost && !wasPreviouslyHost) {
          // Promoted to host
          snapshotSyncRef.current?.promoteToHost(buildSnapshotOpts());
        } else if (!amNewHost && wasPreviouslyHost) {
          // Demoted to client
          snapshotSyncRef.current?.demoteToClient(buildSnapshotOpts());
        }
      };

      transport.onHostChanged(onHostChanged);
      // transport.onHostChanged doesn't return an unsub - we rely on destroy
      return () => {}; // no-op cleanup for this listener
    })();

    // Cleanup on unmount or when deps change
    return () => {
      unsubHostChanged();
      eventSyncRef.current?.destroy();
      snapshotSyncRef.current?.destroy();
      predictionSyncRef.current?.destroy();
      networkSimulatorRef.current?.destroy();
      eventSyncRef.current = null;
      snapshotSyncRef.current = null;
      predictionSyncRef.current = null;
      networkSimulatorRef.current = null;
      appliedErrorsRef.current.clear();
      setIsActive(false);
    };
  }, [networkManager, mode, buildSnapshotOpts, options.prediction, options.onPhysicsStep, options.stepWorld, options.debug]);

  // ── Sync network quality from manager ──
  useEffect(() => {
    const unsub = networkManager.onConnectionStateChange(() => {
      setNetworkQuality(networkManager.networkQuality);
    });
    return unsub;
  }, [networkManager]);

  // ── R3F render loop at priority -55 ──
  useFrame((_state: unknown, delta: number) => {
    const transport = networkManager.transport;
    if (!transport) return;

    const tickKeeper = networkManager.tickKeeper;
    const isHost = networkManager.isHost;

    // Detect 2D/3D on first frame with actors
    if (is2DRef.current === null) {
      const networked = actorRegistry.current.getNetworked();
      if (networked.size > 0) {
        is2DRef.current = detect2D(networked);
      }
    }

    const is2D = is2DRef.current ?? true;

    // Events-only mode: no per-frame state sync needed
    if (mode === "events") return;

    // Prediction: undo render-only error offsets, then apply any pending server
    // snapshot (full-world rollback). MUST run before tickKeeper.update because
    // beginFrame may snap the local tick.
    if (mode === "prediction" && predictionSyncRef.current) {
      undoAppliedErrorOffsets();
      predictionSyncRef.current.beginFrame();
    }

    // Advance tick accumulator
    const ticksThisFrame = tickKeeper.update(delta);

    // ── Fixed-step processing ──
    for (let i = 0; i < ticksThisFrame; i++) {
      const currentTick = tickKeeper.tick - (ticksThisFrame - 1 - i);

      if (mode === "prediction" && predictionSyncRef.current) {
        // Host AND client: full forward simulation of every networked entity
        predictionSyncRef.current.tick(currentTick);

        if (isHost) {
          const entities = buildEntityMap(actorRegistry.current.getNetworked(), is2D);
          snapshotSyncRef.current?.hostTick(
            currentTick,
            entities,
            tickKeeper.tickDelta,
            predictionSyncRef.current.getLocalInput(currentTick),
          );
        }
      } else if (mode === "snapshot" && isHost) {
        // Host: read actor state and broadcast
        const networked = actorRegistry.current.getNetworked();
        const entities = buildEntityMap(networked, is2D);
        snapshotSyncRef.current?.hostTick(currentTick, entities, tickKeeper.tickDelta);
      }
    }

    // ── Render-phase interpolation / smoothing (runs every frame) ──
    if (!isHost && mode === "snapshot" && snapshotSyncRef.current) {
      // Client interpolation: use performance.now() as render time
      const renderTime = performance.now();
      const interpolated = snapshotSyncRef.current.clientInterpolate(renderTime);
      applyStatesToActors(interpolated, actorRegistry.current, is2D);
    }

    // Prediction: apply decayed error offsets to rendered transforms only.
    // Rigid bodies are never touched here — physics owns transforms via the
    // tick loop; offsets are an Object3D-only render adjustment. The host's
    // offset map is simply empty.
    if (mode === "prediction" && predictionSyncRef.current) {
      const offsets = predictionSyncRef.current.getRenderErrorOffsets();
      for (const [id, off] of offsets) {
        const ref = actorRegistry.current.get(id);
        if (!ref) continue;

        const pos = ref.object3D.position;
        pos.x += off.x;
        pos.y += off.y;
        if (!is2D) pos.z += off.z;

        let appliedA = 0;
        let appliedQ: Quat = IDENTITY_QUAT;
        if (is2D) {
          ref.object3D.rotation.z += off.a;
          appliedA = off.a;
        } else {
          appliedQ = { x: off.qx, y: off.qy, z: off.qz, w: off.qw };
          if (!isIdentityQuat(appliedQ)) {
            const cur = ref.object3D.quaternion;
            const r = quatMultiply(appliedQ, { x: cur.x, y: cur.y, z: cur.z, w: cur.w });
            cur.set(r.x, r.y, r.z, r.w);
          }
        }

        appliedErrorsRef.current.set(id, {
          x: off.x,
          y: off.y,
          z: is2D ? 0 : off.z,
          a: appliedA,
          q: appliedQ,
          px: pos.x,
          py: pos.y,
          pz: pos.z,
        });
      }
    }

    // ── Update observable state (throttled — only when values actually change) ──
    if (ticksThisFrame > 0) {
      const newTick = tickKeeper.tick;
      const newServerTick = tickKeeper.serverTick;
      const newDrift = tickKeeper.drift;
      const newQuality = networkManager.networkQuality;
      setTick((prev) => prev !== newTick ? newTick : prev);
      setServerTick((prev) => prev !== newServerTick ? newServerTick : prev);
      setDrift((prev) => prev !== newDrift ? newDrift : prev);
      setNetworkQuality((prev) => prev !== newQuality ? newQuality : prev);
    }
  }, -55);

  return {
    isActive,
    networkQuality,
    tick,
    serverTick,
    drift,
    syncEngine: mode,
    setInput,
  };
}
