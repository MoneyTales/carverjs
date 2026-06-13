import { describe, expect, it } from "vitest";

import { InputBuffer } from "../InputBuffer";
import type { PlayerInput } from "../../types";

type TestInput = {
  left: boolean;
  right: boolean;
  jump: boolean;
  axis: number;
};

const NEUTRAL: TestInput = { left: false, right: false, jump: false, axis: 0 };

function input(overrides: Partial<TestInput> = {}): TestInput {
  return { ...NEUTRAL, ...overrides };
}

function makeBuffer(historySize = 10): InputBuffer<TestInput> {
  return new InputBuffer<TestInput>(NEUTRAL, historySize);
}

describe("InputBuffer", () => {
  it("storeTick/getTick roundtrip returns a copy", () => {
    const buf = makeBuffer();
    const original = input({ jump: true, axis: 1 });
    buf.storeTick(5, original);
    original.jump = false;
    original.axis = 99;
    expect(buf.getTick(5)).toEqual({ left: false, right: false, jump: true, axis: 1 });
  });

  it("getTick returns neutral copy for unknown tick", () => {
    const buf = makeBuffer();
    const first = buf.getTick(42);
    expect(first).toEqual(NEUTRAL);
    first.jump = true;
    first.axis = 7;
    expect(buf.getTick(42)).toEqual(NEUTRAL);
    expect(buf.getTick(42).jump).toBe(false);
  });

  it("ring eviction removes tick exactly historySize back", () => {
    const buf = makeBuffer(10);
    for (let t = 1; t <= 11; t++) buf.storeTick(t, input({ axis: t }));
    expect(buf.hasTick(1)).toBe(false);
    expect(buf.hasTick(2)).toBe(true);
    expect(buf.getTick(1)).toEqual(NEUTRAL);
    expect(buf.getTick(2).axis).toBe(2);
    expect(buf.getTick(11).axis).toBe(11);
  });

  it("hasTick reflects only locally stored ticks", () => {
    const buf = makeBuffer();
    buf.storeTick(3, input());
    buf.setRemote("p1", input({ jump: true }), 4);
    expect(buf.hasTick(3)).toBe(true);
    expect(buf.hasTick(4)).toBe(false);
    expect(buf.hasTick(2)).toBe(false);
  });

  it("getJustPressedZero forces booleans false, passes numbers through", () => {
    const buf = makeBuffer();
    expect(buf.getJustPressedZero()).toEqual({ left: false, right: false, jump: false, axis: 0 });

    const buf2 = new InputBuffer<PlayerInput>({ autoRun: true, axis: 0.5 });
    expect(buf2.getJustPressedZero()).toEqual({ autoRun: false, axis: 0.5 });
  });

  it("setRemote without tick updates last-known only", () => {
    const buf = makeBuffer();
    const a = input({ jump: true });
    buf.setRemote("p1", a);
    expect(buf.getRemote("p1")).toEqual(a);
    // No tick history exists, so any tick lookup falls back to last-known.
    expect(buf.getRemoteAtTick("p1", 7)).toEqual(a);
    expect(buf.getRemoteAtTick("p1", -100)).toEqual(a);
  });

  it("getRemoteAtTick returns input stored for that tick, not last-known", () => {
    const buf = makeBuffer();
    const a = input({ left: true });
    const b = input({ right: true });
    buf.setRemote("p1", a, 5);
    buf.setRemote("p1", b, 6);
    expect(buf.getRemoteAtTick("p1", 5)).toEqual(a);
    expect(buf.getRemoteAtTick("p1", 6)).toEqual(b);
    expect(buf.getRemote("p1")).toEqual(b);
  });

  it("getRemoteAtTick falls back tick-history -> last-known -> neutral", () => {
    const buf = makeBuffer();
    const a = input({ left: true });
    const b = input({ right: true });
    buf.setRemote("p1", a, 5);
    buf.setRemote("p1", b, 7);
    // Stage 1: exact tick history.
    expect(buf.getRemoteAtTick("p1", 5)).toEqual(a);
    // Stage 2: tick 6 was never stored -- falls back to last-known (b).
    expect(buf.getRemoteAtTick("p1", 6)).toEqual(b);
    // Stage 3: unknown peer -- neutral.
    expect(buf.getRemoteAtTick("ghost", 5)).toEqual(NEUTRAL);
  });

  it("per-peer tick history evicts at historySize", () => {
    const buf = makeBuffer(10);
    for (let t = 1; t <= 11; t++) buf.setRemote("p1", input({ axis: t }), t);
    // Tick 1 was evicted (11 - 10), so the lookup falls back to last-known.
    expect(buf.getRemoteAtTick("p1", 1).axis).toBe(11);
    expect(buf.getRemoteAtTick("p1", 2).axis).toBe(2);
    expect(buf.getRemoteAtTick("p1", 11).axis).toBe(11);
  });

  it("allRemotes returns a snapshot", () => {
    const buf = makeBuffer();
    buf.setRemote("p1", input({ jump: true }));
    const snapshot = buf.allRemotes();
    snapshot.delete("p1");
    snapshot.set("p2", input());
    expect(buf.getRemote("p1")).toEqual(input({ jump: true }));
    expect(buf.getRemote("p2")).toEqual(NEUTRAL);
    expect(buf.peerCount).toBe(1);
  });

  it("overrideRemote replaces last-known but not tick history", () => {
    const buf = makeBuffer();
    const a = input({ left: true });
    const b = input({ right: true });
    buf.setRemote("p1", a, 5);
    buf.overrideRemote("p1", b);
    expect(buf.getRemoteAtTick("p1", 5)).toEqual(a);
    expect(buf.getRemote("p1")).toEqual(b);
    // Unknown tick falls back to the overridden last-known input.
    expect(buf.getRemoteAtTick("p1", 9)).toEqual(b);
  });

  it("peerCount and peerIds track remotes", () => {
    const buf = makeBuffer();
    expect(buf.peerCount).toBe(0);
    expect([...buf.peerIds()]).toEqual([]);
    buf.setRemote("p1", input());
    buf.setRemote("p2", input(), 3);
    expect(buf.peerCount).toBe(2);
    expect([...buf.peerIds()].sort()).toEqual(["p1", "p2"]);
  });

  it("setPeerIds removes departed peers from both stores", () => {
    const buf = makeBuffer();
    buf.setRemote("p1", input({ left: true }), 5);
    buf.setRemote("p2", input({ right: true }), 5);
    buf.setPeerIds(new Set(["p1"]));
    expect(buf.peerCount).toBe(1);
    expect(buf.getRemote("p2")).toEqual(NEUTRAL);
    expect(buf.getRemoteAtTick("p2", 5)).toEqual(NEUTRAL);
    expect(buf.getRemoteAtTick("p1", 5)).toEqual(input({ left: true }));
    // Array form is also accepted.
    buf.setPeerIds([]);
    expect(buf.peerCount).toBe(0);
    expect(buf.getRemote("p1")).toEqual(NEUTRAL);
  });

  it("clear empties local, remotes, and tick history", () => {
    const buf = makeBuffer();
    buf.storeTick(3, input({ jump: true }));
    buf.setRemote("p1", input({ left: true }), 4);
    buf.clear();
    expect(buf.hasTick(3)).toBe(false);
    expect(buf.getTick(3)).toEqual(NEUTRAL);
    expect(buf.peerCount).toBe(0);
    expect(buf.getRemote("p1")).toEqual(NEUTRAL);
    expect(buf.getRemoteAtTick("p1", 4)).toEqual(NEUTRAL);
  });
});
