import { describe, expect, it } from "vitest";

import { TickKeeper } from "../../core/TickKeeper";
import { PredictionSync } from "../PredictionSync";
import type {
  CarverChannel,
  CarverTransport,
  ChannelOptions,
  EntityState,
  EntityState2D,
  InputPacket,
  Player,
  PlayerInput,
  PredictionSyncOptions,
  PredictionWorldDriver,
  SnapshotListener,
  SnapshotSource,
} from "../../types";

// ── Fakes ──

class FakeChannel<T = unknown> implements CarverChannel<T> {
  readonly sent: Array<{ data: T; target: string | string[] | undefined }> = [];
  closed = false;
  private readonly _receivers: Array<(data: T, peerId: string) => void> = [];

  send(data: T, target?: string | string[]): void {
    this.sent.push({ data, target });
  }

  onReceive(cb: (data: T, peerId: string) => void): void {
    this._receivers.push(cb);
  }

  close(): void {
    this.closed = true;
  }

  /** Test helper: simulate an incoming message from a peer. */
  deliver(data: T, peerId: string): void {
    for (const cb of this._receivers) cb(data, peerId);
  }
}

class FakeTransport implements CarverTransport {
  peerId: string;
  hostId: string;
  isHost: boolean;
  peers: ReadonlySet<string>;
  readonly channels = new Map<string, FakeChannel<unknown>>();
  readonly peerLeaveCallbacks: Array<(peerId: string) => void> = [];

  constructor(opts: { peerId: string; hostId: string; isHost: boolean; peers?: string[] }) {
    this.peerId = opts.peerId;
    this.hostId = opts.hostId;
    this.isHost = opts.isHost;
    this.peers = new Set(opts.peers ?? []);
  }

  onPeerJoin(_cb: (peerId: string) => void): void {}

  onPeerLeave(cb: (peerId: string) => void): void {
    this.peerLeaveCallbacks.push(cb);
  }

  onPeerUpdated(_cb: (player: Player) => void): void {}

  onHostChanged(_cb: (newHostId: string) => void): void {}

  createChannel<T = unknown>(name: string, _options?: ChannelOptions): CarverChannel<T> {
    let channel = this.channels.get(name);
    if (!channel) {
      channel = new FakeChannel<unknown>();
      this.channels.set(name, channel);
    }
    return channel as unknown as CarverChannel<T>;
  }

  connect(_roomId: string): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): void {}

  /** Test helper: the carver:inputs channel created by PredictionSync. */
  inputChannel(): FakeChannel<unknown> {
    const channel = this.channels.get("carver:inputs");
    if (!channel) throw new Error("carver:inputs channel was not created");
    return channel;
  }
}

class FakeSnapshotSource implements SnapshotSource {
  readonly listeners: SnapshotListener[] = [];

  onSnapshot(cb: SnapshotListener): void {
    this.listeners.push(cb);
  }

  emit(tick: number, entities: Map<string, EntityState>, hostInput?: PlayerInput): void {
    for (const cb of this.listeners) cb(tick, entities, hostInput);
  }
}

class RecordingDriver implements PredictionWorldDriver {
  readonly world = new Map<string, EntityState2D>();
  readonly appliedBatches: EntityState2D[][] = [];

  captureState(): Map<string, EntityState> {
    const out = new Map<string, EntityState>();
    for (const [id, s] of this.world) out.set(id, { ...s });
    return out;
  }

  applyState(entities: Iterable<EntityState>): void {
    const batch: EntityState2D[] = [];
    for (const s of entities) {
      const s2 = s as EntityState2D;
      batch.push({ ...s2 });
      this.world.set(s2.id, { ...s2 });
    }
    this.appliedBatches.push(batch);
  }
}

function entity2D(id: string, x = 0): EntityState2D {
  return { id, x, y: 0, a: 0, vx: 0, vy: 0, va: 0 };
}

interface Harness {
  transport: FakeTransport;
  tickKeeper: TickKeeper;
  snapshots: FakeSnapshotSource;
  sync: PredictionSync;
}

function makeHarness(opts: { isHost?: boolean; options?: PredictionSyncOptions } = {}): Harness {
  const isHost = opts.isHost === true;
  const transport = new FakeTransport({
    peerId: isHost ? "host" : "me",
    hostId: "host",
    isHost,
    peers: isHost ? ["me"] : ["host"],
  });
  const tickKeeper = new TickKeeper(60);
  const snapshots = new FakeSnapshotSource();
  const sync = new PredictionSync(transport, tickKeeper, snapshots, opts.options);
  return { transport, tickKeeper, snapshots, sync };
}

interface StepRecord {
  tick: number;
  isRollback: boolean;
  dt: number;
  inputs: Map<string, PlayerInput>;
  justPressed: Map<string, PlayerInput>;
}

function recordSteps(sync: PredictionSync): StepRecord[] {
  const records: StepRecord[] = [];
  sync.setPhysicsStep((inputs, justPressed, tick, isRollback, dt) => {
    records.push({
      tick,
      isRollback,
      dt,
      inputs: new Map(inputs),
      justPressed: new Map(justPressed),
    });
  });
  return records;
}

// ── Tests ──

describe("PredictionSync", () => {
  it("tick stores local input every tick and broadcasts InputPacket {t, i, p} with no target", () => {
    const { transport, sync } = makeHarness();
    expect(transport.channels.has("carver:inputs")).toBe(true);

    sync.setInput({ jump: true, axis: 0.5 });
    sync.tick(1);
    sync.tick(2);

    const sent = transport.inputChannel().sent;
    expect(sent).toHaveLength(2);
    expect(sent[0].target).toBeUndefined();
    expect(sent[1].target).toBeUndefined();
    expect(sent[0].data as InputPacket).toEqual({ t: 1, i: { jump: true, axis: 0.5 }, p: "me" });
    // Held input persists across ticks (no null-reset after use).
    expect(sent[1].data as InputPacket).toEqual({ t: 2, i: { jump: true, axis: 0.5 }, p: "me" });
  });

  it("tick keys local input by transport.peerId in both maps passed to onPhysicsStep", () => {
    const { sync, tickKeeper } = makeHarness();
    const records = recordSteps(sync);

    sync.setInput({ jump: true });
    sync.tick(1);

    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.tick).toBe(1);
    expect(r.isRollback).toBe(false);
    expect(r.dt).toBeCloseTo(tickKeeper.tickDelta, 12);
    expect([...r.inputs.keys()]).toEqual(["me"]);
    expect(r.inputs.get("me")).toEqual({ jump: true });
    expect(r.justPressed.has("me")).toBe(true);
    expect(r.inputs.has("__local__")).toBe(false);
    expect(r.justPressed.has("__local__")).toBe(false);
  });

  it("received input packets populate remote tick history keyed by sender peerId", () => {
    const { transport, sync } = makeHarness();
    const records = recordSteps(sync);
    const channel = transport.inputChannel();

    // The p field lies; receivers must key by the transport-provided sender id.
    channel.deliver({ t: 0, i: { jump: false }, p: "liar" }, "peer-b");
    channel.deliver({ t: 1, i: { jump: true }, p: "liar" }, "peer-b");
    // JSON string packets are also accepted.
    channel.deliver(JSON.stringify({ t: 0, i: { axis: 0.25 }, p: "whoever" }), "peer-c");

    sync.tick(1);

    const r = records[0];
    expect(r.inputs.has("liar")).toBe(false);
    expect(r.inputs.has("whoever")).toBe(false);
    expect(r.inputs.get("peer-b")).toEqual({ jump: true });
    expect(r.inputs.get("peer-c")).toEqual({ axis: 0.25 });
    // Forward justPressed for remotes uses exact tick history for prev:
    // prev = tick 0 ({jump:false}), curr = last-known ({jump:true}) -> edge fires.
    // If only last-known were stored, prev would be {jump:true} and no edge would fire.
    expect(r.justPressed.get("peer-b")?.jump).toBe(true);
  });

  it("forward justPressed uses hasTick guard", () => {
    const { sync } = makeHarness({ options: { neutralInput: { jump: false } } });
    const records = recordSteps(sync);

    sync.setInput({ jump: true });
    sync.tick(1); // no stored tick 0 -> getJustPressedZero path, no spurious edge
    sync.tick(2); // held -> no edge
    sync.setInput({ jump: false });
    sync.tick(3); // released -> no edge
    sync.setInput({ jump: true });
    sync.tick(4); // pressed again -> fires once

    const jp = records.map((r) => r.justPressed.get("me")?.jump);
    expect(jp).toEqual([false, false, false, true]);
  });

  it("same setInput across two ticks fires justPressed only on the first", () => {
    const { sync } = makeHarness();
    const records = recordSteps(sync);

    sync.setInput({ jump: false });
    sync.tick(1);
    sync.setInput({ jump: true });
    sync.tick(2);
    sync.tick(3); // same input object held -- per-tick copies prevent a re-fire

    expect(records[1].justPressed.get("me")?.jump).toBe(true);
    expect(records[2].justPressed.get("me")?.jump).toBe(false);
  });

  it("beginFrame applies only the newest pending snapshot and ignores stale ticks", () => {
    const { sync, snapshots } = makeHarness();
    const driver = new RecordingDriver();
    sync.setWorldDriver(driver);

    snapshots.emit(10, new Map([["e1", entity2D("e1", 111)]]));
    snapshots.emit(8, new Map([["e1", entity2D("e1", 888)]]));
    sync.beginFrame();

    expect(driver.appliedBatches).toHaveLength(1);
    expect(driver.appliedBatches[0][0].x).toBe(111);
    expect(driver.world.get("e1")?.x).toBe(111);
    expect(sync.lastAppliedServerTick).toBe(10);

    // Re-emitting an already-applied tick is ignored entirely.
    snapshots.emit(10, new Map([["e1", entity2D("e1", 999)]]));
    sync.beginFrame();
    expect(driver.appliedBatches).toHaveLength(1);
    expect(driver.world.get("e1")?.x).toBe(111);
    expect(sync.lastAppliedServerTick).toBe(10);
  });

  it("host input embedding: hi is written into remote history at the snapshot tick under transport.hostId", () => {
    const { sync, snapshots, transport, tickKeeper } = makeHarness();
    const driver = new RecordingDriver();
    sync.setWorldDriver(driver);
    const records = recordSteps(sync);
    const channel = transport.inputChannel();

    // Direct host packets: jump held at ticks 20..25.
    for (let t = 20; t <= 25; t++) {
      channel.deliver({ t, i: { jump: true }, p: "host" }, "host");
    }
    tickKeeper.snapTick(25);

    // Snapshot at tick 20 embeds hi = {jump:false}, overwriting the host's
    // tick-20 history entry (and its last-known input).
    snapshots.emit(20, new Map<string, EntityState>(), { jump: false });
    sync.beginFrame();

    const rollbackRecords = records.filter((r) => r.isRollback);
    expect(rollbackRecords.map((r) => r.tick)).toEqual([21, 22, 23, 24, 25]);
    expect(rollbackRecords[0].inputs.get("host")).toEqual({ jump: true });
    // prev at tick 21 is the embedded hi at tick 20 ({jump:false}), so the
    // held jump re-fires as a rising edge. If hi had only updated last-known
    // (or not been consumed at all), prev would be {jump:true} and no edge
    // would fire.
    expect(rollbackRecords[0].justPressed.get("host")?.jump).toBe(true);
    for (const r of rollbackRecords.slice(1)) {
      expect(r.justPressed.get("host")?.jump).toBe(false);
    }

    expect(sync.lastAppliedServerTick).toBe(20);
    expect(tickKeeper.tick).toBe(25); // drift within window -> no snap
  });

  it("beginFrame is a no-op on host", () => {
    const { sync, snapshots, tickKeeper } = makeHarness({ isHost: true });
    const driver = new RecordingDriver();
    driver.world.set("e1", entity2D("e1", 50));
    sync.setWorldDriver(driver);

    snapshots.emit(10, new Map([["e1", entity2D("e1", 5)]]), { jump: true });
    sync.beginFrame();

    expect(driver.appliedBatches).toHaveLength(0);
    expect(driver.world.get("e1")?.x).toBe(50);
    expect(tickKeeper.tick).toBe(0);
    expect(sync.serverTick).toBe(0);
    expect(sync.lastAppliedServerTick).toBe(0);
  });

  it("tick snap propagates to TickKeeper.snapTick", () => {
    const { sync, snapshots, tickKeeper } = makeHarness();
    const driver = new RecordingDriver();
    driver.world.set("e1", entity2D("e1", 50));
    sync.setWorldDriver(driver);

    // localTick 0 vs target 104: drift exceeds maxRewindTicks -> hard snap.
    snapshots.emit(100, new Map([["e1", entity2D("e1", 5)]]));
    sync.beginFrame();

    expect(tickKeeper.tick).toBe(104); // serverTick + driftTargetTicks
    expect(driver.world.get("e1")?.x).toBe(5);
    expect(sync.lastAppliedServerTick).toBe(100);
  });

  it("getRenderErrorOffsets decays errors by errorDecay per call and deletes consumed entries", () => {
    const { sync, snapshots } = makeHarness();
    const driver = new RecordingDriver();
    driver.world.set("e1", entity2D("e1", 10));
    sync.setWorldDriver(driver);

    // Rollback with no resim: error = pre (10) - post (0) = 10 on x.
    snapshots.emit(1, new Map([["e1", entity2D("e1", 0)]]));
    sync.beginFrame();

    const first = sync.getRenderErrorOffsets();
    expect(first.get("e1")?.x).toBeCloseTo(10 * 0.85, 10);
    const second = sync.getRenderErrorOffsets();
    expect(second.get("e1")?.x).toBeCloseTo(10 * 0.85 * 0.85, 10);
    expect(second.get("e1")?.x).toBeCloseTo((first.get("e1")?.x ?? 0) * 0.85, 10);

    // With maxErrorPerFrame > 0 and a small error, the full decayed error is
    // applied and consumed on the first call; the entry is then deleted.
    const capped = makeHarness({ options: { maxErrorPerFrame: 10 } });
    const cappedDriver = new RecordingDriver();
    cappedDriver.world.set("e1", entity2D("e1", 0.5));
    capped.sync.setWorldDriver(cappedDriver);
    capped.snapshots.emit(1, new Map([["e1", entity2D("e1", 0)]]));
    capped.sync.beginFrame();

    const firstCapped = capped.sync.getRenderErrorOffsets();
    expect(firstCapped.get("e1")?.x).toBeCloseTo(0.5 * 0.85, 10);
    const secondCapped = capped.sync.getRenderErrorOffsets();
    expect(secondCapped.has("e1")).toBe(false);
  });

  it("destroy clears state", () => {
    const { sync, snapshots } = makeHarness();
    const driver = new RecordingDriver();
    driver.world.set("e1", entity2D("e1", 10));
    sync.setWorldDriver(driver);

    snapshots.emit(1, new Map([["e1", entity2D("e1", 0)]]));
    sync.beginFrame();
    expect(sync.getRenderErrorOffsets().size).toBe(1);

    sync.destroy();
    expect(sync.getRenderErrorOffsets().size).toBe(0);
  });
});
