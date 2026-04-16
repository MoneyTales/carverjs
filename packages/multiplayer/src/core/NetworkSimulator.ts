/* ------------------------------------------------------------------- */
/*  NetworkSimulator – latency / packet-loss / jitter injection layer  */
/* ------------------------------------------------------------------- */

export interface NetworkSimulatorOptions {
  /** Additional one-way latency in milliseconds (default 0) */
  latencyMs?: number;
  /** Packet drop rate, 0-1 (default 0) */
  packetLoss?: number;
  /** Random jitter +/- milliseconds (default 0) */
  jitterMs?: number;
}

interface SimulatorStats {
  sentCount: number;
  droppedCount: number;
  avgLatencyMs: number;
}

export class NetworkSimulator {
  private latencyMs: number;
  private packetLoss: number;
  private jitterMs: number;

  private sentCount = 0;
  private droppedCount = 0;
  private latencySum = 0; // running sum of applied latencies

  /** Active timeout handles so we can cancel them on destroy() */
  private pending: Set<ReturnType<typeof setTimeout>> = new Set();

  constructor(options?: NetworkSimulatorOptions) {
    const opts = options ?? {};
    this.latencyMs = opts.latencyMs ?? 0;
    this.packetLoss = opts.packetLoss ?? 0;
    this.jitterMs = opts.jitterMs ?? 0;
  }

  /* ---- public API ---- */

  /** Update simulation parameters at runtime. */
  setOptions(options: Partial<NetworkSimulatorOptions>): void {
    if (options.latencyMs !== undefined) this.latencyMs = options.latencyMs;
    if (options.packetLoss !== undefined) this.packetLoss = options.packetLoss;
    if (options.jitterMs !== undefined) this.jitterMs = options.jitterMs;
  }

  /**
   * Wrap an existing send function so that every call goes through the
   * simulated network conditions (latency, jitter, packet loss).
   */
  wrapSend<T>(
    originalSend: (data: T, target?: string | string[]) => void,
  ): (data: T, target?: string | string[]) => void {
    return (data: T, target?: string | string[]) => {
      /* 1. Packet-loss check */
      if (Math.random() < this.packetLoss) {
        this.droppedCount++;
        return;
      }

      this.sentCount++;

      /* 2. Compute effective delay */
      const jitter =
        this.jitterMs > 0
          ? Math.random() * 2 * this.jitterMs - this.jitterMs
          : 0;
      const delay = Math.max(0, this.latencyMs + jitter);

      /* Track latency for stats */
      this.latencySum += delay;

      /* 3. Dispatch */
      if (delay === 0) {
        originalSend(data, target);
      } else {
        const handle = setTimeout(() => {
          this.pending.delete(handle);
          originalSend(data, target);
        }, delay);
        this.pending.add(handle);
      }
    };
  }

  /** Current statistics snapshot. */
  get stats(): SimulatorStats {
    return {
      sentCount: this.sentCount,
      droppedCount: this.droppedCount,
      avgLatencyMs:
        this.sentCount > 0 ? this.latencySum / this.sentCount : 0,
    };
  }

  /** Cancel all pending delayed sends and clean up. */
  destroy(): void {
    for (const handle of this.pending) {
      clearTimeout(handle);
    }
    this.pending.clear();
  }
}
