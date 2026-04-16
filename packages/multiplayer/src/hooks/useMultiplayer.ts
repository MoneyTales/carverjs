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
} from "../types";
import { useMultiplayerContext } from "../core/MultiplayerContext";
import { EventSync } from "../sync/EventSync";
import { SnapshotSync } from "../sync/SnapshotSync";
import type { SnapshotSyncOptions } from "../sync/SnapshotSync";
import { PredictionSync } from "../sync/PredictionSync";
import { NetworkSimulator } from "../core/NetworkSimulator";

// ── Return type ──

export interface UseMultiplayerReturn {
  isActive: boolean;
  networkQuality: NetworkQuality;
  tick: number;
  serverTick: number;
  drift: number;
  syncEngine: SyncMode;
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
      predictionSyncRef.current = new PredictionSync(
        transport,
        networkManager.codec,
        networkManager.tickKeeper,
        options.prediction,
      );

      // Wire up the physics step callback if provided
      if (options.onPhysicsStep) {
        predictionSyncRef.current.setPhysicsStep(options.onPhysicsStep);
      }
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
      setIsActive(false);
    };
  }, [networkManager, mode, buildSnapshotOpts, options.prediction, options.onPhysicsStep, options.debug]);

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

    // Advance tick accumulator
    const ticksThisFrame = tickKeeper.update(delta);

    // ── Fixed-step processing ──
    for (let i = 0; i < ticksThisFrame; i++) {
      const currentTick = tickKeeper.tick - (ticksThisFrame - 1 - i);

      if (isHost) {
        // Host: read actor state and broadcast
        const networked = actorRegistry.current.getNetworked();
        const entities = buildEntityMap(networked, is2D);

        if (mode === "snapshot" || mode === "prediction") {
          snapshotSyncRef.current?.hostTick(currentTick, entities, tickKeeper.tickDelta);
        }

        if (mode === "prediction") {
          predictionSyncRef.current?.hostTick(currentTick, entities, tickKeeper.tickDelta);
        }
      } else {
        // Client in prediction mode: run client tick
        if (mode === "prediction" && predictionSyncRef.current) {
          predictionSyncRef.current.clientTick(currentTick);
        }
      }
    }

    // ── Render-phase interpolation / smoothing (runs every frame) ──
    if (!isHost) {
      if (mode === "snapshot" && snapshotSyncRef.current) {
        // Client interpolation: use performance.now() as render time
        const renderTime = performance.now();
        const interpolated = snapshotSyncRef.current.clientInterpolate(renderTime);
        applyStatesToActors(interpolated, actorRegistry.current, is2D);
      } else if (mode === "prediction" && predictionSyncRef.current) {
        // Apply error smoothing on top of predicted state
        const predicted = predictionSyncRef.current.predictedState;
        const smoothed = predictionSyncRef.current.applyErrorSmoothing(predicted);
        applyStatesToActors(smoothed, actorRegistry.current, is2D);
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
  };
}
