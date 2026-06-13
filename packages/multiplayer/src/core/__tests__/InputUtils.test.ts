import { describe, expect, it } from "vitest";

import { computeJustPressed } from "../InputUtils";
import type { PlayerInput } from "../../types";

describe("computeJustPressed", () => {
  it("rising edge fires when prev false and curr true", () => {
    expect(computeJustPressed({ jump: true }, { jump: false })).toEqual({ jump: true });
  });

  it("held button does not fire", () => {
    expect(computeJustPressed({ jump: true }, { jump: true })).toEqual({ jump: false });
  });

  it("release does not fire", () => {
    expect(computeJustPressed({ jump: false }, { jump: true })).toEqual({ jump: false });
  });

  it("missing prev key counts as not pressed -- edge fires", () => {
    expect(computeJustPressed({ jump: true }, {})).toEqual({ jump: true });
    expect(computeJustPressed({ jump: true, fire: true }, { fire: true })).toEqual({
      jump: true,
      fire: false,
    });
  });

  it("numbers pass through unchanged", () => {
    expect(computeJustPressed({ axis: 0.7 }, { axis: 0.1 })).toEqual({ axis: 0.7 });
    expect(computeJustPressed({ axis: 0.7 }, {})).toEqual({ axis: 0.7 });
    expect(computeJustPressed({ axis: 0.7, jump: true }, { axis: 0.9, jump: true })).toEqual({
      axis: 0.7,
      jump: false,
    });
  });

  it("undefined values pass through", () => {
    const curr: PlayerInput = { ghost: undefined, jump: true };
    const out = computeJustPressed(curr, { jump: false });
    expect(out.jump).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, "ghost")).toBe(true);
    expect(out.ghost).toBeUndefined();
  });

  it("output has exactly currs keys", () => {
    const out = computeJustPressed({ a: true }, { a: false, b: true, axis: 1 });
    expect(Object.keys(out)).toEqual(["a"]);
    expect(out).toEqual({ a: true });
  });
});
