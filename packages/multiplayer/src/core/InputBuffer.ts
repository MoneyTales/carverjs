/**
 * InputBuffer — unified ring-buffer for local and peer inputs.
 *
 * Ported from LumberNet's LumberInputBuffer. Stores:
 *   - local player tick-keyed inputs (storeTick / getTick / hasTick)
 *   - last-received input per remote peer (setRemote / getRemote / allRemotes)
 *   - per-peer tick-keyed inputs for accurate rollback resimulation (getRemoteAtTick)
 *
 * Generic over per-tick payload I. Caller supplies the neutral payload.
 */

import type { PlayerInput } from "../types";

export class InputBuffer<I extends PlayerInput = PlayerInput> {
  private readonly _historySize: number;
  private readonly _neutral: I;

  /** Local player tick-keyed inputs (ring buffer). */
  private readonly _local = new Map<number, I>();

  /** Last-received input per remote peer. */
  private readonly _remotes = new Map<string, I>();

  /** Per-peer tick-keyed inputs for accurate rollback re-simulation. */
  private readonly _peerTicks = new Map<string, Map<number, I>>();

  constructor(neutralInput: I, historySize = 120) {
    this._neutral = { ...neutralInput } as I;
    this._historySize = historySize;
  }

  // ── Local input ──

  /** Record a snapshot of the local input at the given tick. Evicts the entry exactly historySize back. */
  storeTick(tick: number, input: I): void {
    this._local.set(tick, { ...input } as I);
    this._local.delete(tick - this._historySize);
  }

  /** Return the local input at `tick`, or a neutral copy if out of range. */
  getTick(tick: number): I {
    return this._local.get(tick) ?? ({ ...this._neutral } as I);
  }

  /** True if we have a stored local input for this tick (used to avoid spurious justPressed after snap/rejoin). */
  hasTick(tick: number): boolean {
    return this._local.has(tick);
  }

  /** Neutral payload with every boolean field forced false (use for justPressed when prev tick is unknown). */
  getJustPressedZero(): I {
    const out = {} as I;
    for (const key in this._neutral) {
      const v = this._neutral[key];
      (out as Record<string, boolean | number | undefined>)[key] =
        typeof v === "boolean" ? false : v;
    }
    return out;
  }

  // ── Remote (peer) inputs ──

  /**
   * Record a remote peer's input. If `tick` is given (the sender's local tick),
   * also store it in the per-peer ring buffer for rollback.
   */
  setRemote(peerId: string, input: I, tick?: number): void {
    this._remotes.set(peerId, input);
    if (tick !== undefined) {
      let peerMap = this._peerTicks.get(peerId);
      if (!peerMap) {
        peerMap = new Map();
        this._peerTicks.set(peerId, peerMap);
      }
      peerMap.set(tick, input);
      peerMap.delete(tick - this._historySize);
    }
  }

  /** Last-known input for a peer, or a neutral copy if never received. */
  getRemote(peerId: string): I {
    return this._remotes.get(peerId) ?? ({ ...this._neutral } as I);
  }

  /** Snapshot of all remote peers' last-known inputs (shallow copy of the map). */
  allRemotes(): Map<string, I> {
    return new Map(this._remotes);
  }

  /**
   * Return a peer's exact input at the given tick (for rollback accuracy),
   * falling back to their last-known input when history does not reach that far.
   */
  getRemoteAtTick(peerId: string, tick: number): I {
    return this._peerTicks.get(peerId)?.get(tick) ?? this.getRemote(peerId);
  }

  /** Override the last-known input for a peer (does NOT touch tick history). */
  overrideRemote(peerId: string, input: I): void {
    this._remotes.set(peerId, input);
  }

  /** Number of currently tracked remote peers. */
  get peerCount(): number {
    return this._remotes.size;
  }

  /** Iterate tracked peer IDs. */
  peerIds(): IterableIterator<string> {
    return this._remotes.keys();
  }

  /**
   * Keep only these peer IDs; remove any other remotes (e.g. after leave/rejoin).
   * Call when the room's peer list changes so stale peers stop receiving input.
   */
  setPeerIds(peerIds: ReadonlySet<string> | string[]): void {
    const set = peerIds instanceof Set ? peerIds : new Set(peerIds);
    for (const id of this._remotes.keys()) {
      if (!set.has(id)) {
        this._remotes.delete(id);
        this._peerTicks.delete(id);
      }
    }
  }

  // ── Lifecycle ──

  /** Clear local history, remote last-known inputs, and per-peer tick history. */
  clear(): void {
    this._local.clear();
    this._remotes.clear();
    this._peerTicks.clear();
  }
}
