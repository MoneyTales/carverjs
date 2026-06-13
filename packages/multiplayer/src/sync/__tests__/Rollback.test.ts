import { describe, expect, it } from "vitest";

import { InputBuffer } from "../../core/InputBuffer";
import {
  applyRollback,
  quatAngle,
  quatInvert,
  quatMultiply,
  quatNormalize,
  quatScaleAngle,
} from "../Rollback";
import type { Quat, RollbackParams } from "../Rollback";
import type {
  EntityState,
  EntityState2D,
  EntityState3D,
  ErrorOffset,
  PhysicsStepCallback,
  PlayerInput,
  PredictionWorldDriver,
} from "../../types";

const DT = 1 / 60;

const IDENTITY_OFFSET: ErrorOffset = { x: 0, y: 0, z: 0, a: 0, qx: 0, qy: 0, qz: 0, qw: 1 };

function mustGet<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`missing map entry: ${String(key)}`);
  return value;
}

// ── 2D fake world ──

interface FakeEntity {
  x: number;
  y: number;
  vx: number;
  vy: number;
  a: number;
}

type World2D = Map<string, FakeEntity>;

function state2D(id: string, x = 0, y = 0, a = 0, vx = 0, vy = 0): EntityState2D {
  return { id, x, y, a, vx, vy, va: 0 };
}

function makeDriver2D(world: World2D): PredictionWorldDriver {
  return {
    captureState(): Map<string, EntityState> {
      const out = new Map<string, EntityState>();
      for (const [id, e] of world) {
        out.set(id, { id, x: e.x, y: e.y, a: e.a, vx: e.vx, vy: e.vy, va: 0 });
      }
      return out;
    },
    applyState(entities: Iterable<EntityState>): void {
      for (const s of entities) {
        const s2 = s as EntityState2D;
        const e = world.get(s2.id);
        if (e) {
          e.x = s2.x;
          e.y = s2.y;
          e.a = s2.a;
          e.vx = s2.vx;
          e.vy = s2.vy;
        } else {
          world.set(s2.id, { x: s2.x, y: s2.y, vx: s2.vx, vy: s2.vy, a: s2.a });
        }
      }
    },
    stepWorld(): void {
      for (const e of world.values()) {
        e.x += e.vx * DT;
        e.y += e.vy * DT;
      }
    },
  };
}

/** Sets entity `player-${peerId}`.vx from left/right input, 10 units/s. */
function makeMovementCallback(world: World2D): PhysicsStepCallback {
  return (inputs) => {
    for (const [peerId, inp] of inputs) {
      const e = world.get(`player-${peerId}`);
      if (!e) continue;
      e.vx = ((inp.right === true ? 1 : 0) - (inp.left === true ? 1 : 0)) * 10;
    }
  };
}

function withLoggedStep(driver: PredictionWorldDriver, onStep: () => void): PredictionWorldDriver {
  const base = driver.stepWorld;
  return {
    captureState: () => driver.captureState(),
    applyState: (entities) => {
      driver.applyState(entities);
    },
    stepWorld: () => {
      onStep();
      base?.();
    },
  };
}

// ── 3D fake world ──

interface FakeEntity3D {
  x: number;
  y: number;
  z: number;
  q: Quat;
  vx: number;
  vy: number;
  vz: number;
  spinning: boolean;
}

const SPIN_PER_TICK = 0.1;

function state3D(
  id: string,
  x = 0,
  y = 0,
  z = 0,
  q: Quat = { x: 0, y: 0, z: 0, w: 1 },
  vx = 0,
  vy = 0,
  vz = 0,
): EntityState3D {
  return { id, x, y, z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, vx, vy, vz, wx: 0, wy: 0, wz: 0 };
}

function makeDriver3D(world: Map<string, FakeEntity3D>): PredictionWorldDriver {
  const spinQ: Quat = {
    x: 0,
    y: 0,
    z: Math.sin(SPIN_PER_TICK / 2),
    w: Math.cos(SPIN_PER_TICK / 2),
  };
  return {
    captureState(): Map<string, EntityState> {
      const out = new Map<string, EntityState>();
      for (const [id, e] of world) {
        out.set(id, {
          id,
          x: e.x,
          y: e.y,
          z: e.z,
          qx: e.q.x,
          qy: e.q.y,
          qz: e.q.z,
          qw: e.q.w,
          vx: e.vx,
          vy: e.vy,
          vz: e.vz,
          wx: 0,
          wy: 0,
          wz: 0,
        });
      }
      return out;
    },
    applyState(entities: Iterable<EntityState>): void {
      for (const s of entities) {
        const s3 = s as EntityState3D;
        const e = world.get(s3.id);
        if (!e) continue;
        e.x = s3.x;
        e.y = s3.y;
        e.z = s3.z;
        e.q = { x: s3.qx, y: s3.qy, z: s3.qz, w: s3.qw };
        e.vx = s3.vx;
        e.vy = s3.vy;
        e.vz = s3.vz;
      }
    },
    stepWorld(): void {
      for (const e of world.values()) {
        e.x += e.vx * DT;
        e.y += e.vy * DT;
        e.z += e.vz * DT;
        if (e.spinning) e.q = quatMultiply(spinQ, e.q);
      }
    },
  };
}

/** Sets the per-entity spin flag from the `spin` input. */
function makeSpinCallback(world: Map<string, FakeEntity3D>): PhysicsStepCallback {
  return (inputs) => {
    for (const [peerId, inp] of inputs) {
      const e = world.get(`player-${peerId}`);
      if (e) e.spinning = inp.spin === true;
    }
  };
}

// ── Param builder ──

type ParamOverrides = Partial<RollbackParams> &
  Pick<RollbackParams, "serverTick" | "serverState" | "localTick" | "driver">;

function makeParams(overrides: ParamOverrides): RollbackParams {
  return {
    localPeerId: "A",
    inputs: new InputBuffer<PlayerInput>({ left: false, right: false, jump: false, spin: false }),
    currentErrors: new Map<string, ErrorOffset>(),
    callback: null,
    dt: DT,
    driftTargetTicks: 4,
    maxRewindTicks: 15,
    snapThreshold: 150,
    ...overrides,
  };
}

// ── Tests ──

describe("applyRollback (2D)", () => {
  it("applies server state to all entities including the local player", () => {
    const world: World2D = new Map([
      ["player-A", { x: 1, y: 2, vx: 3, vy: 4, a: 0.5 }],
      ["player-B", { x: 5, y: 6, vx: 7, vy: 8, a: 1.0 }],
      ["crate", { x: 9, y: 10, vx: 11, vy: 12, a: 1.5 }],
    ]);
    const driver = makeDriver2D(world);
    const serverState = new Map<string, EntityState>([
      ["player-A", state2D("player-A", 100, 200, 0.1, -1, -2)],
      ["player-B", state2D("player-B", 300, 400, 0.2, -3, -4)],
      ["crate", state2D("crate", 500, 600, 0.3, -5, -6)],
    ]);

    const result = applyRollback(
      makeParams({ serverTick: 10, serverState, localTick: 10, driver }),
    );

    expect(result.snapped).toBe(false);
    expect(result.newLocalTick).toBe(10);
    for (const [id, expected] of serverState) {
      const s2 = expected as EntityState2D;
      const e = mustGet(world, id);
      expect(e.x).toBe(s2.x);
      expect(e.y).toBe(s2.y);
      expect(e.a).toBe(s2.a);
      expect(e.vx).toBe(s2.vx);
      expect(e.vy).toBe(s2.vy);
    }
  });

  it("resim invokes callback and stepWorld exactly localTick - serverTick times with ticks serverTick+1..localTick and isRollback=true", () => {
    const world: World2D = new Map([["player-B", { x: 0, y: 0, vx: 0, vy: 0, a: 0 }]]);
    const events: string[] = [];
    const driver = withLoggedStep(makeDriver2D(world), () => events.push("step"));
    const callback: PhysicsStepCallback = (_inputs, _justPressed, tick, isRollback, dt) => {
      expect(isRollback).toBe(true);
      expect(dt).toBeCloseTo(DT, 12);
      events.push(`cb:${tick}`);
    };

    const result = applyRollback(
      makeParams({
        serverTick: 4,
        serverState: new Map([["player-B", state2D("player-B")]]),
        localTick: 10,
        driver,
        callback,
      }),
    );

    expect(events).toEqual([
      "cb:5", "step",
      "cb:6", "step",
      "cb:7", "step",
      "cb:8", "step",
      "cb:9", "step",
      "cb:10", "step",
    ]);
    expect(result.snapped).toBe(false);
    expect(result.newLocalTick).toBe(10);
  });

  it("rollback resim replays remote inputs per tick and converges fake world to host result", () => {
    const bInputAt = (tick: number): PlayerInput => ({ right: tick <= 5, left: false });

    // Authoritative host run: ticks 1..10 with B's true inputs (right held 1-5, released 6-10).
    const hostWorld: World2D = new Map([["player-B", { x: 0, y: 0, vx: 0, vy: 0, a: 0 }]]);
    const hostDriver = makeDriver2D(hostWorld);
    const hostCallback = makeMovementCallback(hostWorld);
    let serverState: Map<string, EntityState> | undefined;
    for (let t = 1; t <= 10; t++) {
      hostCallback(new Map([["B", bInputAt(t)]]), new Map(), t, false, DT);
      hostDriver.stepWorld?.();
      if (t === 4) serverState = hostDriver.captureState();
    }
    if (!serverState) throw new Error("missing tick-4 snapshot");
    const hostFinal = mustGet(hostWorld, "player-B");

    // Diverged client run: B extrapolated as holding right for all 10 ticks.
    const clientWorld: World2D = new Map([["player-B", { x: 0, y: 0, vx: 0, vy: 0, a: 0 }]]);
    const clientDriver = makeDriver2D(clientWorld);
    const clientCallback = makeMovementCallback(clientWorld);
    for (let t = 1; t <= 10; t++) {
      clientCallback(new Map([["B", { right: true, left: false }]]), new Map(), t, false, DT);
      clientDriver.stepWorld?.();
    }
    expect(Math.abs(mustGet(clientWorld, "player-B").x - hostFinal.x)).toBeGreaterThan(0.1);

    // True per-tick inputs arrive; rollback from the tick-4 snapshot.
    const inputs = new InputBuffer<PlayerInput>({ left: false, right: false });
    for (let t = 1; t <= 10; t++) inputs.setRemote("B", bInputAt(t), t);

    const result = applyRollback(
      makeParams({
        serverTick: 4,
        serverState,
        localTick: 10,
        driver: clientDriver,
        callback: clientCallback,
        inputs,
      }),
    );

    const converged = mustGet(clientWorld, "player-B");
    expect(result.snapped).toBe(false);
    expect(converged.x).toBeCloseTo(hostFinal.x, 10);
    expect(converged.y).toBeCloseTo(hostFinal.y, 10);
    expect(converged.vx).toBeCloseTo(hostFinal.vx, 10);
  });

  it("resim replays local inputs from the local ring buffer", () => {
    const world: World2D = new Map([["player-A", { x: 99, y: 0, vx: 99, vy: 0, a: 0 }]]);
    const driver = makeDriver2D(world);
    const callback = makeMovementCallback(world);
    const inputs = new InputBuffer<PlayerInput>({ left: false, right: false });
    // Local player A: right held ticks 5-7, released 8-10.
    for (let t = 1; t <= 10; t++) {
      inputs.storeTick(t, { right: t >= 5 && t <= 7, left: false });
    }

    applyRollback(
      makeParams({
        serverTick: 4,
        serverState: new Map([["player-A", state2D("player-A")]]),
        localTick: 10,
        driver,
        callback,
        inputs,
        localPeerId: "A",
      }),
    );

    // 3 ticks of vx=10 then 3 ticks of vx=0: x = 3 * 10 * DT = 0.5
    const e = mustGet(world, "player-A");
    expect(e.x).toBeCloseTo(0.5, 10);
    expect(e.vx).toBe(0);
  });

  it("falls back to last-known input for ticks missing from peer history", () => {
    const world: World2D = new Map([["player-B", { x: 99, y: 0, vx: 0, vy: 0, a: 0 }]]);
    const driver = makeDriver2D(world);
    const callback = makeMovementCallback(world);
    const inputs = new InputBuffer<PlayerInput>({ left: false, right: false });
    // Last-known only -- no tick history at all.
    inputs.setRemote("B", { right: true, left: false });

    applyRollback(
      makeParams({
        serverTick: 4,
        serverState: new Map([["player-B", state2D("player-B")]]),
        localTick: 10,
        driver,
        callback,
        inputs,
      }),
    );

    // All 6 resim ticks use the last-known held input: x = 6 * 10 * DT = 1.0
    expect(mustGet(world, "player-B").x).toBeCloseTo(1.0, 10);
  });

  it("error vectors equal pre-visual minus post-resim", () => {
    const world: World2D = new Map([["e1", { x: 10, y: 5, vx: 0, vy: 0, a: 1.0 }]]);
    const driver = makeDriver2D(world);
    const currentErrors = new Map<string, ErrorOffset>([
      ["e1", { x: 2, y: 1, z: 0, a: 0.5, qx: 0, qy: 0, qz: 0, qw: 1 }],
    ]);

    const result = applyRollback(
      makeParams({
        serverTick: 10,
        serverState: new Map([["e1", state2D("e1", 3, 4, 0.25)]]),
        localTick: 10,
        driver,
        currentErrors,
      }),
    );

    const err = mustGet(result.errors, "e1");
    expect(err.x).toBeCloseTo(9, 10); // (10 + 2) - 3
    expect(err.y).toBeCloseTo(2, 10); // (5 + 1) - 4
    expect(err.a).toBeCloseTo(1.25, 10); // (1.0 + 0.5) - 0.25
    expect(err.z).toBe(0);
    expect(err.qx).toBe(0);
    expect(err.qy).toBe(0);
    expect(err.qz).toBe(0);
    expect(err.qw).toBe(1);
  });

  it("angle error wraps to (-pi, pi]", () => {
    const world: World2D = new Map([["e1", { x: 0, y: 0, vx: 0, vy: 0, a: 3.0 }]]);
    const driver = makeDriver2D(world);

    const result = applyRollback(
      makeParams({
        serverTick: 10,
        serverState: new Map([["e1", state2D("e1", 0, 0, -3.0)]]),
        localTick: 10,
        driver,
      }),
    );

    const err = mustGet(result.errors, "e1");
    // Raw difference is 6.0; wrapped it must be 6.0 - 2*pi (about -0.2832), not 6.0.
    expect(err.a).toBeCloseTo(6.0 - Math.PI * 2, 4);
    expect(Math.abs(err.a)).toBeLessThan(Math.PI);
  });

  it("error suppressed when per-axis jump exceeds snapThreshold", () => {
    const world: World2D = new Map([["e1", { x: 300, y: 0, vx: 0, vy: 0, a: 1.0 }]]);
    const driver = makeDriver2D(world);

    const result = applyRollback(
      makeParams({
        serverTick: 10,
        serverState: new Map([["e1", state2D("e1", 100, 0, 0)]]),
        localTick: 10,
        driver,
      }),
    );

    // 200-unit X teleport: ALL correction suppressed, including rotation.
    expect(mustGet(result.errors, "e1")).toEqual(IDENTITY_OFFSET);
  });

  it("tick snap when drift exceeds maxRewindTicks", () => {
    const world: World2D = new Map([["e1", { x: 50, y: 0, vx: 0, vy: 0, a: 0 }]]);
    let callbackCalls = 0;
    let stepCalls = 0;
    const driver = withLoggedStep(makeDriver2D(world), () => stepCalls++);
    const callback: PhysicsStepCallback = () => {
      callbackCalls++;
    };

    const result = applyRollback(
      makeParams({
        serverTick: 100,
        serverState: new Map([["e1", state2D("e1", 5)]]),
        localTick: 200,
        driver,
        callback,
      }),
    );

    expect(result.snapped).toBe(true);
    expect(result.newLocalTick).toBe(104); // serverTick + driftTargetTicks
    expect(callbackCalls).toBe(0);
    expect(stepCalls).toBe(0);
    expect(mustGet(world, "e1").x).toBe(5);
    // Errors are computed in the snapped path too (post = raw server state).
    expect(mustGet(result.errors, "e1").x).toBeCloseTo(45, 10);
  });

  it("no snap returns original localTick", () => {
    const world: World2D = new Map([["e1", { x: 0, y: 0, vx: 0, vy: 0, a: 0 }]]);
    const driver = makeDriver2D(world);

    const result = applyRollback(
      makeParams({
        serverTick: 100,
        serverState: new Map([["e1", state2D("e1")]]),
        localTick: 110,
        driver,
      }),
    );

    expect(result.snapped).toBe(false);
    expect(result.newLocalTick).toBe(110);
  });

  it("justPressed does not double-fire across rollback", () => {
    const inputs = new InputBuffer<PlayerInput>({ jump: false });
    for (let t = 1; t <= 4; t++) inputs.setRemote("B", { jump: false }, t);
    for (let t = 5; t <= 10; t++) inputs.setRemote("B", { jump: true }, t);

    const world: World2D = new Map([["player-B", { x: 0, y: 0, vx: 0, vy: 0, a: 0 }]]);
    const driver = makeDriver2D(world);
    const serverState = new Map<string, EntityState>([["player-B", state2D("player-B")]]);

    const runResim = (serverTick: number): number[] => {
      const fired: number[] = [];
      const callback: PhysicsStepCallback = (_inputs, justPressed, tick) => {
        if (justPressed.get("B")?.jump === true) fired.push(tick);
      };
      applyRollback(
        makeParams({ serverTick, serverState, localTick: 10, driver, callback, inputs }),
      );
      return fired;
    };

    // Resim 3..10: edge fires exactly at the tick it originally fired.
    expect(runResim(2)).toEqual([5]);
    // Second snapshot, same window: still exactly tick 5, no double-fire.
    expect(runResim(2)).toEqual([5]);
    // Resim 7..10: the edge at tick 5 precedes the window and never re-fires,
    // including at the resim-start tick.
    expect(runResim(6)).toEqual([]);
  });

  it("stepWorld runs even when callback is null", () => {
    const world: World2D = new Map([["e1", { x: 0, y: 0, vx: 0, vy: 0, a: 0 }]]);
    let stepCalls = 0;
    const driver = withLoggedStep(makeDriver2D(world), () => stepCalls++);

    applyRollback(
      makeParams({
        serverTick: 4,
        serverState: new Map([["e1", state2D("e1")]]),
        localTick: 10,
        driver,
        callback: null,
      }),
    );

    expect(stepCalls).toBe(6);
  });
});

describe("applyRollback (3D)", () => {
  it("3D: quaternion error is preQ * inverse(postQ), identity when equal", () => {
    // Divergent rotation: client at 90 degrees about z, server at identity.
    const qPre: Quat = { x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) };
    const world = new Map<string, FakeEntity3D>([
      ["e1", { x: 1, y: 2, z: 3, q: { ...qPre }, vx: 0, vy: 0, vz: 0, spinning: false }],
    ]);

    const result = applyRollback(
      makeParams({
        serverTick: 10,
        serverState: new Map([["e1", state3D("e1", 0.5, 1.5, 2.5)]]),
        localTick: 10,
        driver: makeDriver3D(world),
      }),
    );

    const err = mustGet(result.errors, "e1");
    expect(err.x).toBeCloseTo(0.5, 10);
    expect(err.y).toBeCloseTo(0.5, 10);
    expect(err.z).toBeCloseTo(0.5, 10);
    expect(err.a).toBe(0);
    expect(err.qx).toBeCloseTo(0, 10);
    expect(err.qy).toBeCloseTo(0, 10);
    expect(err.qz).toBeCloseTo(qPre.z, 10);
    expect(err.qw).toBeCloseTo(qPre.w, 10);

    // Identical client and server state: identity rotation error.
    const world2 = new Map<string, FakeEntity3D>([
      ["e1", { x: 1, y: 1, z: 1, q: { ...qPre }, vx: 0, vy: 0, vz: 0, spinning: false }],
    ]);
    const result2 = applyRollback(
      makeParams({
        serverTick: 10,
        serverState: new Map([["e1", state3D("e1", 1, 1, 1, qPre)]]),
        localTick: 10,
        driver: makeDriver3D(world2),
      }),
    );
    const err2 = mustGet(result2.errors, "e1");
    expect(err2.x).toBeCloseTo(0, 10);
    expect(err2.y).toBeCloseTo(0, 10);
    expect(err2.z).toBeCloseTo(0, 10);
    expect(quatAngle({ x: err2.qx, y: err2.qy, z: err2.qz, w: err2.qw })).toBeCloseTo(0, 6);
    expect(err2.qw).toBeGreaterThan(0);
  });

  it("3D: error quaternion is canonicalized to w >= 0", () => {
    // 270 degrees about z has a negative-w representation.
    const q270: Quat = {
      x: 0,
      y: 0,
      z: Math.sin((3 * Math.PI) / 4),
      w: Math.cos((3 * Math.PI) / 4),
    };
    const world = new Map<string, FakeEntity3D>([
      ["e1", { x: 0, y: 0, z: 0, q: { ...q270 }, vx: 0, vy: 0, vz: 0, spinning: false }],
    ]);

    const result = applyRollback(
      makeParams({
        serverTick: 10,
        serverState: new Map([["e1", state3D("e1")]]),
        localTick: 10,
        driver: makeDriver3D(world),
      }),
    );

    const err = mustGet(result.errors, "e1");
    expect(err.qw).toBeGreaterThan(0);
    expect(err.qw).toBeCloseTo(Math.SQRT1_2, 10);
    expect(err.qz).toBeCloseTo(-Math.SQRT1_2, 10);
    expect(quatAngle({ x: err.qx, y: err.qy, z: err.qz, w: err.qw })).toBeCloseTo(Math.PI / 2, 10);
  });

  it("3D: resim integrates per-tick spin inputs from the input buffer", () => {
    const world = new Map<string, FakeEntity3D>([
      [
        "player-B",
        { x: 0, y: 0, z: 0, q: { x: 0, y: 0, z: 0, w: 1 }, vx: 0, vy: 0, vz: 0, spinning: false },
      ],
    ]);
    const driver = makeDriver3D(world);
    const inputs = new InputBuffer<PlayerInput>({ spin: false });
    inputs.setRemote("B", { spin: false }, 4);
    inputs.setRemote("B", { spin: true }, 5);
    inputs.setRemote("B", { spin: true }, 6);

    const result = applyRollback(
      makeParams({
        serverTick: 4,
        serverState: new Map([["player-B", state3D("player-B")]]),
        localTick: 6,
        driver,
        callback: makeSpinCallback(world),
        inputs,
      }),
    );

    // Two resim ticks of spin: total rotation 2 * SPIN_PER_TICK about z.
    const e = mustGet(world, "player-B");
    expect(e.q.z).toBeCloseTo(Math.sin(SPIN_PER_TICK), 10);
    expect(e.q.w).toBeCloseTo(Math.cos(SPIN_PER_TICK), 10);

    // Pre-visual was identity, so the error rotation undoes the resim spin.
    const err = mustGet(result.errors, "player-B");
    expect(quatAngle({ x: err.qx, y: err.qy, z: err.qz, w: err.qw })).toBeCloseTo(
      SPIN_PER_TICK * 2,
      9,
    );
    expect(err.qz).toBeCloseTo(-Math.sin(SPIN_PER_TICK), 10);
  });

  it("3D: suppression zeroes rotation error too", () => {
    const qPre: Quat = { x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) };
    const world = new Map<string, FakeEntity3D>([
      ["e1", { x: 0, y: 0, z: 250, q: { ...qPre }, vx: 0, vy: 0, vz: 0, spinning: false }],
    ]);

    const result = applyRollback(
      makeParams({
        serverTick: 10,
        serverState: new Map([["e1", state3D("e1", 0, 0, 0)]]),
        localTick: 10,
        driver: makeDriver3D(world),
      }),
    );

    // 250-unit Z teleport: identity offset, rotation correction suppressed as well.
    expect(mustGet(result.errors, "e1")).toEqual(IDENTITY_OFFSET);
  });
});

describe("quaternion helpers", () => {
  const q90: Quat = { x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) };

  function expectQuatClose(actual: Quat, expected: Quat, digits = 10): void {
    expect(actual.x).toBeCloseTo(expected.x, digits);
    expect(actual.y).toBeCloseTo(expected.y, digits);
    expect(actual.z).toBeCloseTo(expected.z, digits);
    expect(actual.w).toBeCloseTo(expected.w, digits);
  }

  it("quatMultiply satisfies identity laws and composes rotations", () => {
    const id: Quat = { x: 0, y: 0, z: 0, w: 1 };
    expectQuatClose(quatMultiply(q90, id), q90);
    expectQuatClose(quatMultiply(id, q90), q90);
    const q45: Quat = { x: 0, y: 0, z: Math.sin(Math.PI / 8), w: Math.cos(Math.PI / 8) };
    expect(quatAngle(quatMultiply(q45, q45))).toBeCloseTo(Math.PI / 2, 10);
  });

  it("quatInvert composes with the original to identity", () => {
    const composed = quatMultiply(q90, quatInvert(q90));
    expect(composed.x).toBeCloseTo(0, 10);
    expect(composed.y).toBeCloseTo(0, 10);
    expect(composed.z).toBeCloseTo(0, 10);
    expect(Math.abs(composed.w)).toBeCloseTo(1, 10);
  });

  it("quatNormalize returns identity for the zero quaternion and unit length otherwise", () => {
    expect(quatNormalize({ x: 0, y: 0, z: 0, w: 0 })).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    const n = quatNormalize({ x: 0, y: 0, z: 2, w: 0 });
    expect(n.z).toBeCloseTo(1, 10);
    expect(n.w).toBeCloseTo(0, 10);
    expect(Math.hypot(n.x, n.y, n.z, n.w)).toBeCloseTo(1, 10);
  });

  it("quatAngle measures rotation angle after canonicalization", () => {
    expect(quatAngle({ x: 0, y: 0, z: 0, w: 1 })).toBeCloseTo(0, 10);
    expect(quatAngle(q90)).toBeCloseTo(Math.PI / 2, 10);
    // Negated quaternion represents the same rotation.
    expect(quatAngle({ x: 0, y: 0, z: -q90.z, w: -q90.w })).toBeCloseTo(Math.PI / 2, 10);
  });

  it("quatScaleAngle halves the angle with factor 0.5 and returns identity for factor 0", () => {
    expect(quatAngle(quatScaleAngle(q90, 0.5))).toBeCloseTo(Math.PI / 4, 10);
    const zero = quatScaleAngle(q90, 0);
    expect(zero.x).toBeCloseTo(0, 12);
    expect(zero.y).toBeCloseTo(0, 12);
    expect(zero.z).toBeCloseTo(0, 12);
    expect(zero.w).toBeCloseTo(1, 12);
  });
});
