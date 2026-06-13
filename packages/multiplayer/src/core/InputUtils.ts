/**
 * Input utilities for prediction mode.
 * Ported from LumberNet's InputUtils.
 */

import type { PlayerInput } from "../types";

/**
 * Given the input state at the current tick and the previous tick, return a new
 * input object where each boolean field is `true` only if it transitioned
 * false -> true (a "rising edge" / "just pressed").
 *
 * Non-boolean fields are passed through unchanged from `curr`.
 * Iterates `curr` keys only; keys present only in `prev` are absent from the result.
 *
 * PredictionSync calls this automatically and passes the result as `justPressed`
 * to every onPhysicsStep callback, so games normally do not call it directly.
 */
export function computeJustPressed<I extends PlayerInput>(curr: I, prev: I): I {
  const out = {} as I;
  for (const key in curr) {
    const c = curr[key];
    (out as Record<string, boolean | number | undefined>)[key] =
      typeof c === "boolean" ? c === true && prev[key] !== true : c;
  }
  return out;
}
