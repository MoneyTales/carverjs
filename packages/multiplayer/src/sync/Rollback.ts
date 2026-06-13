/**
 * Rollback — full-world rollback for prediction mode.
 *
 * Ported from LumberNet's LumberRollback, adapted to CarverJS entity state
 * (2D and 3D). On each accepted server snapshot the client:
 *   1. captures the pre-rollback visual pose (raw physics + accumulated error),
 *   2. hard-applies server state to EVERY networked entity,
 *   3. resimulates from serverTick + 1 to localTick replaying per-tick inputs
 *      (or hard-snaps the tick when drift exceeds maxRewindTicks),
 *   4. converts the visual discontinuity into per-entity error offsets.
 *
 * Pure module: no transport, no React, no three.js. Quaternion math is
 * hand-rolled below.
 */

import type { InputBuffer } from "../core/InputBuffer";
import { computeJustPressed } from "../core/InputUtils";
import type {
  EntityState,
  ErrorOffset,
  PhysicsStepCallback,
  PlayerInput,
  PredictionWorldDriver,
} from "../types";

// ── Quaternion helpers ──

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

/** Hamilton product (a ⊗ b). */
export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Conjugate (inputs assumed normalized). */
export function quatInvert(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Normalize; degenerate (near-zero) quaternions return identity. */
export function quatNormalize(q: Quat): Quat {
  const mag = Math.hypot(q.x, q.y, q.z, q.w);
  if (mag < 1e-12) return { ...IDENTITY_QUAT };
  return { x: q.x / mag, y: q.y / mag, z: q.z / mag, w: q.w / mag };
}

/** Rotation angle in radians: 2*acos(clamp(|w|, 0, 1)). */
export function quatAngle(q: Quat): number {
  return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
}

/** Scale the rotation angle toward identity by `factor`, preserving the axis. */
export function quatScaleAngle(q: Quat, factor: number): Quat {
  let n = quatNormalize(q);
  if (n.w < 0) n = { x: -n.x, y: -n.y, z: -n.z, w: -n.w };
  const angle = 2 * Math.acos(Math.min(1, n.w));
  if (angle < 1e-6) return { ...IDENTITY_QUAT };
  const s = Math.sin(angle / 2);
  const ax = n.x / s;
  const ay = n.y / s;
  const az = n.z / s;
  const na = angle * factor;
  const ns = Math.sin(na / 2);
  return { x: ax * ns, y: ay * ns, z: az * ns, w: Math.cos(na / 2) };
}

// ── Rollback ──

export interface RollbackParams {
  /** Tick embedded in the accepted server snapshot. */
  serverTick: number;
  /** Authoritative full-world state from the snapshot. */
  serverState: ReadonlyMap<string, EntityState>;
  /** Client's current simulation tick. */
  localTick: number;
  /** This peer's id (local inputs are replayed from the local ring buffer). */
  localPeerId: string;
  /** Input buffer holding local and per-peer tick history. */
  inputs: InputBuffer;
  /** Currently accumulated visual error offsets (kept continuous across rollbacks). */
  currentErrors: ReadonlyMap<string, ErrorOffset>;
  /** World access for capture/apply/step. */
  driver: PredictionWorldDriver;
  /** Game physics-step callback, re-invoked during resimulation. */
  callback: PhysicsStepCallback | null;
  /** Fixed timestep in seconds. */
  dt: number;
  /** Snap target offset: snap target = serverTick + driftTargetTicks. */
  driftTargetTicks: number;
  /** Max |localTick - (serverTick + driftTargetTicks)| before hard tick snap. */
  maxRewindTicks: number;
  /** Per-axis positional jump above which correction is suppressed (teleport). */
  snapThreshold: number;
}

export interface RollbackResult {
  /** New local tick (differs from localTick only when a hard snap occurred). */
  newLocalTick: number;
  snapped: boolean;
  /** Per-entity visual error offsets (pre-visual minus post-resim). */
  errors: Map<string, ErrorOffset>;
}

interface PreVisualPose {
  x: number;
  y: number;
  z: number;
  a: number;
  q: Quat;
  is3D: boolean;
}

/**
 * Apply a server snapshot to the whole world and resimulate forward.
 * Returns the new local tick and per-entity visual error offsets.
 */
export function applyRollback(params: RollbackParams): RollbackResult {
  const {
    serverTick,
    serverState,
    localTick,
    localPeerId,
    inputs,
    currentErrors,
    driver,
    callback,
    dt,
    driftTargetTicks,
    maxRewindTicks,
    snapThreshold,
  } = params;

  // Step 0: pre-rollback visual pose (raw physics + accumulated error)
  const preState = driver.captureState();
  const preMap = new Map<string, PreVisualPose>();
  for (const [id, s] of preState) {
    const e = currentErrors.get(id);
    const ex = e?.x ?? 0;
    const ey = e?.y ?? 0;
    if ("z" in s) {
      const errQ: Quat = e
        ? { x: e.qx, y: e.qy, z: e.qz, w: e.qw }
        : { ...IDENTITY_QUAT };
      preMap.set(id, {
        x: s.x + ex,
        y: s.y + ey,
        z: s.z + (e?.z ?? 0),
        a: 0,
        q: quatMultiply(errQ, { x: s.qx, y: s.qy, z: s.qz, w: s.qw }),
        is3D: true,
      });
    } else {
      preMap.set(id, {
        x: s.x + ex,
        y: s.y + ey,
        z: 0,
        a: s.a + (e?.a ?? 0),
        q: { ...IDENTITY_QUAT },
        is3D: false,
      });
    }
  }

  // Step 1: hard-apply server state to the WHOLE world (local player included)
  driver.applyState(serverState.values());

  // Step 2: snap-vs-resim decision
  const targetTick = serverTick + driftTargetTicks;
  const tickDiff = localTick - targetTick;
  let newLocalTick = localTick;
  let snapped = false;

  if (Math.abs(tickDiff) > maxRewindTicks) {
    newLocalTick = targetTick;
    snapped = true;
  } else {
    // Step 3: resimulate from serverTick + 1 to localTick replaying tick-exact inputs
    for (let i = serverTick + 1; i <= localTick; i++) {
      if (callback) {
        const tickInputs = new Map<string, PlayerInput>();
        const justPressed = new Map<string, PlayerInput>();
        for (const peerId of inputs.peerIds()) {
          if (peerId === localPeerId) continue;
          const curr = inputs.getRemoteAtTick(peerId, i);
          tickInputs.set(peerId, curr);
          justPressed.set(
            peerId,
            computeJustPressed(curr, inputs.getRemoteAtTick(peerId, i - 1)),
          );
        }
        const localCurr = inputs.getTick(i);
        tickInputs.set(localPeerId, localCurr);
        justPressed.set(
          localPeerId,
          computeJustPressed(localCurr, inputs.getTick(i - 1)),
        );
        callback(tickInputs, justPressed, i, true, dt);
      }
      driver.stepWorld?.();
    }
  }

  // Step 4: error vectors = pre-rollback visual pose minus post-resim state
  const postState = driver.captureState();
  const errors = new Map<string, ErrorOffset>();
  for (const [id, post] of postState) {
    const pre = preMap.get(id);
    if (!pre) continue;

    const errX = pre.x - post.x;
    const errY = pre.y - post.y;
    let errZ = 0;
    let errA = 0;
    let q: Quat = { ...IDENTITY_QUAT };

    if ("z" in post) {
      errZ = pre.z - post.z;
      let dq = quatNormalize(
        quatMultiply(
          pre.q,
          quatInvert({ x: post.qx, y: post.qy, z: post.qz, w: post.qw }),
        ),
      );
      if (dq.w < 0) dq = { x: -dq.x, y: -dq.y, z: -dq.z, w: -dq.w };
      q = dq;
    } else {
      const ad = pre.a - post.a;
      // Wrap to (-PI, PI]
      errA = ad - Math.PI * 2 * Math.floor((ad + Math.PI) / (Math.PI * 2));
    }

    // Large per-axis jump -> suppress ALL correction (intentional teleport)
    if (
      Math.abs(errX) > snapThreshold ||
      Math.abs(errY) > snapThreshold ||
      Math.abs(errZ) > snapThreshold
    ) {
      errors.set(id, { x: 0, y: 0, z: 0, a: 0, qx: 0, qy: 0, qz: 0, qw: 1 });
    } else {
      errors.set(id, {
        x: errX,
        y: errY,
        z: errZ,
        a: errA,
        qx: q.x,
        qy: q.y,
        qz: q.z,
        qw: q.w,
      });
    }
  }

  return { newLocalTick, snapped, errors };
}
