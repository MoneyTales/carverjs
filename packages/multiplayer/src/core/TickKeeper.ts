/**
 * Accumulator-based fixed timestep with drift-aware time dilation.
 * Adapted from lumbernet's LumberTickKeeper.
 */
export class TickKeeper {
  private _tickRate: number;
  private _tickDelta: number;
  private _accumulator = 0;
  private _tick = 0;
  private _serverTick = 0;
  private _alpha = 0;
  private _timeScale = 1;

  // Drift correction zones
  private static readonly DRIFT_BEHIND_THRESHOLD = -5;
  private static readonly DRIFT_AHEAD_THRESHOLD = 5;
  private static readonly SPEED_UP_SCALE = 1.5;
  private static readonly SLOW_DOWN_SCALE = 0.1;
  private static readonly NORMAL_SCALE = 1.0;

  constructor(tickRate = 60) {
    this._tickRate = tickRate;
    this._tickDelta = 1 / tickRate;
  }

  get tick(): number {
    return this._tick;
  }

  get serverTick(): number {
    return this._serverTick;
  }

  get tickDelta(): number {
    return this._tickDelta;
  }

  get tickRate(): number {
    return this._tickRate;
  }

  /** Interpolation alpha for rendering between ticks (0-1) */
  get alpha(): number {
    return this._alpha;
  }

  /** Current time scale (affected by drift correction) */
  get timeScale(): number {
    return this._timeScale;
  }

  /** Ticks ahead of server (positive = ahead, negative = behind) */
  get drift(): number {
    return this._tick - this._serverTick;
  }

  /** Update server tick from received snapshot */
  setServerTick(serverTick: number): void {
    this._serverTick = serverTick;
    this._updateDriftCorrection();
  }

  /**
   * Accumulate time and return the number of fixed ticks to process.
   * Call this once per render frame with the raw frame delta.
   */
  update(rawDelta: number): number {
    // Cap delta to prevent spiral-of-death (e.g., after tab switch)
    const maxDelta = this._tickDelta * 8;
    const delta = Math.min(rawDelta, maxDelta) * this._timeScale;

    this._accumulator += delta;

    let ticksThisFrame = 0;
    while (this._accumulator >= this._tickDelta) {
      this._accumulator -= this._tickDelta;
      this._tick++;
      ticksThisFrame++;
    }

    // Compute interpolation alpha
    this._alpha = this._accumulator / this._tickDelta;

    return ticksThisFrame;
  }

  /** Reset to initial state */
  reset(): void {
    this._accumulator = 0;
    this._tick = 0;
    this._serverTick = 0;
    this._alpha = 0;
    this._timeScale = 1;
  }

  /** Set tick rate (updates tickDelta accordingly) */
  setTickRate(rate: number): void {
    this._tickRate = rate;
    this._tickDelta = 1 / rate;
  }

  private _updateDriftCorrection(): void {
    const drift = this.drift;
    if (drift < TickKeeper.DRIFT_BEHIND_THRESHOLD) {
      // Too far behind server -- speed up
      this._timeScale = TickKeeper.SPEED_UP_SCALE;
    } else if (drift > TickKeeper.DRIFT_AHEAD_THRESHOLD) {
      // Too far ahead of server -- slow down
      this._timeScale = TickKeeper.SLOW_DOWN_SCALE;
    } else {
      // Healthy zone
      this._timeScale = TickKeeper.NORMAL_SCALE;
    }
  }
}
