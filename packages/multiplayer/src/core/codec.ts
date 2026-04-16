import { pack, unpack } from "msgpackr";
import type { EntityState, EntityState2D, EntityState3D } from "../types";

/** Configuration for delta thresholds */
export interface DeltaThresholds {
  position: number;
  rotation: number;
  velocity: number;
  custom: 'strict' | number;
}

/** Quantization config: number of decimal places to keep */
export interface QuantizeConfig {
  position?: number;
  rotation?: number;
  velocity?: number;
}

const DEFAULT_THRESHOLDS: DeltaThresholds = {
  position: 0.01,
  rotation: 0.001,
  velocity: 0.05,
  custom: 'strict',
};

/**
 * Snapshot ring buffer: stores recent snapshots for delta computation.
 */
export class SnapshotBuffer {
  private _buffer: Map<number, Map<string, EntityState>>; // tick -> (entityId -> state)
  private _capacity: number;

  constructor(capacity = 120) {
    this._capacity = capacity;
    this._buffer = new Map();
  }

  /** Store a snapshot at the given tick */
  store(tick: number, entities: Map<string, EntityState>): void {
    this._buffer.set(tick, entities);
    // Evict old entries by iterating actual keys (handles non-contiguous ticks)
    if (this._buffer.size > this._capacity) {
      const sortedTicks = Array.from(this._buffer.keys()).sort((a, b) => a - b);
      const toRemove = sortedTicks.length - this._capacity;
      for (let i = 0; i < toRemove; i++) {
        this._buffer.delete(sortedTicks[i]);
      }
    }
  }

  /** Get a snapshot at the given tick */
  get(tick: number): Map<string, EntityState> | undefined {
    return this._buffer.get(tick);
  }

  /** Clear all stored snapshots */
  clear(): void {
    this._buffer.clear();
  }
}

/**
 * Codec handles serialization and delta compression for network state.
 */
export class Codec {
  private _thresholds: DeltaThresholds;
  private _quantize: QuantizeConfig | undefined;
  private _is2D: boolean;

  constructor(options?: {
    thresholds?: Partial<DeltaThresholds>;
    quantize?: QuantizeConfig;
    is2D?: boolean;
  }) {
    this._thresholds = { ...DEFAULT_THRESHOLDS, ...options?.thresholds };
    this._quantize = options?.quantize;
    this._is2D = options?.is2D ?? false;
  }

  /** Serialize entity states to binary (msgpackr) */
  serialize(entities: EntityState[]): Uint8Array {
    const quantized = this._quantize ? entities.map(e => this._quantizeEntity(e)) : entities;
    return pack(quantized);
  }

  /** Deserialize binary to entity states */
  deserialize(data: Uint8Array): EntityState[] {
    return unpack(data) as EntityState[];
  }

  /**
   * Compute delta: only include entities that changed beyond thresholds
   * since the baseline snapshot.
   * Returns null if nothing changed.
   */
  computeDelta(
    current: Map<string, EntityState>,
    baseline: Map<string, EntityState> | undefined,
  ): EntityState[] | null {
    // No baseline = keyframe (send everything)
    if (!baseline) {
      return Array.from(current.values());
    }

    const changed: EntityState[] = [];
    for (const [id, entity] of current) {
      const prev = baseline.get(id);
      if (!prev || this._hasChanged(entity, prev)) {
        changed.push(entity);
      }
    }

    // Include removed entities as tombstones (entities in baseline but not in current)
    // Tombstones are indicated by entities with only an id field
    for (const id of baseline.keys()) {
      if (!current.has(id)) {
        // Tombstone: minimal entity state signaling removal
        if (this._is2D) {
          changed.push({ id, x: 0, y: 0, a: 0, vx: 0, vy: 0, va: 0, c: { __removed: true } } as EntityState2D);
        } else {
          changed.push({ id, x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, c: { __removed: true } } as EntityState3D);
        }
      }
    }

    return changed.length > 0 ? changed : null;
  }

  /** Serialize a delta snapshot packet */
  serializeDelta(
    tick: number,
    baseTick: number,
    current: Map<string, EntityState>,
    baseline: Map<string, EntityState> | undefined,
  ): Uint8Array | null {
    const delta = this.computeDelta(current, baseline);
    if (!delta) return null;

    const packet = {
      t: tick,
      b: baseline ? baseTick : -1, // -1 = keyframe
      s: this.serialize(delta),
    };

    return pack(packet);
  }

  /** Deserialize a snapshot packet */
  deserializePacket(data: Uint8Array): { tick: number; baseTick: number; entities: EntityState[] } {
    const packet = unpack(data) as { t: number; b: number; s: Uint8Array };
    return {
      tick: packet.t,
      baseTick: packet.b,
      entities: this.deserialize(packet.s),
    };
  }

  private _hasChanged(current: EntityState, prev: EntityState): boolean {
    const t = this._thresholds;

    // Position
    if (Math.abs(current.x - prev.x) > t.position) return true;
    if (Math.abs(current.y - prev.y) > t.position) return true;

    if ('z' in current && 'z' in prev) {
      // 3D
      const c = current as EntityState3D;
      const p = prev as EntityState3D;
      if (Math.abs(c.z - p.z) > t.position) return true;

      // Rotation (quaternion)
      if (Math.abs(c.qx - p.qx) > t.rotation) return true;
      if (Math.abs(c.qy - p.qy) > t.rotation) return true;
      if (Math.abs(c.qz - p.qz) > t.rotation) return true;
      if (Math.abs(c.qw - p.qw) > t.rotation) return true;

      // Velocity
      if (Math.abs(c.vx - p.vx) > t.velocity) return true;
      if (Math.abs(c.vy - p.vy) > t.velocity) return true;
      if (Math.abs(c.vz - p.vz) > t.velocity) return true;

      // Angular velocity
      if (Math.abs(c.wx - p.wx) > t.velocity) return true;
      if (Math.abs(c.wy - p.wy) > t.velocity) return true;
      if (Math.abs(c.wz - p.wz) > t.velocity) return true;
    } else {
      // 2D
      const c = current as EntityState2D;
      const p = prev as EntityState2D;

      // Rotation
      if (Math.abs(c.a - p.a) > t.rotation) return true;

      // Velocity
      if (Math.abs(c.vx - p.vx) > t.velocity) return true;
      if (Math.abs(c.vy - p.vy) > t.velocity) return true;

      // Angular velocity
      if (Math.abs(c.va - p.va) > t.velocity) return true;
    }

    // Custom properties
    if (current.c || prev.c) {
      const cc = current.c ?? {};
      const pc = prev.c ?? {};
      const allKeys = new Set([...Object.keys(cc), ...Object.keys(pc)]);
      for (const key of allKeys) {
        if (t.custom === 'strict') {
          if (cc[key] !== pc[key]) return true;
        } else {
          const diff = typeof cc[key] === 'number' && typeof pc[key] === 'number'
            ? Math.abs((cc[key] as number) - (pc[key] as number))
            : cc[key] === pc[key] ? 0 : 1;
          if (diff > t.custom) return true;
        }
      }
    }

    return false;
  }

  private _quantizeEntity(entity: EntityState): EntityState {
    const q = this._quantize!;
    const result = { ...entity };

    if (q.position !== undefined) {
      const m = Math.pow(10, q.position);
      result.x = Math.round(result.x * m) / m;
      result.y = Math.round(result.y * m) / m;
      if ('z' in result) {
        (result as EntityState3D).z = Math.round((result as EntityState3D).z * m) / m;
      }
    }

    if (q.rotation !== undefined) {
      const m = Math.pow(10, q.rotation);
      if ('a' in result) {
        (result as EntityState2D).a = Math.round((result as EntityState2D).a * m) / m;
      } else if ('qx' in result) {
        const r = result as EntityState3D;
        r.qx = Math.round(r.qx * m) / m;
        r.qy = Math.round(r.qy * m) / m;
        r.qz = Math.round(r.qz * m) / m;
        r.qw = Math.round(r.qw * m) / m;
      }
    }

    if (q.velocity !== undefined) {
      const m = Math.pow(10, q.velocity);
      result.vx = Math.round(result.vx * m) / m;
      result.vy = Math.round(result.vy * m) / m;
      if ('vz' in result) {
        const r = result as EntityState3D;
        r.vz = Math.round(r.vz * m) / m;
        r.wx = Math.round(r.wx * m) / m;
        r.wy = Math.round(r.wy * m) / m;
        r.wz = Math.round(r.wz * m) / m;
      }
      if ('va' in result) {
        (result as EntityState2D).va = Math.round((result as EntityState2D).va * m) / m;
      }
    }

    return result;
  }
}
