import type {
  CarverTransport,
  CarverChannel,
  EntityState,
  EntityState2D,
  EntityState3D,
  NetworkQuality,
} from "../types";
import { Codec } from "./codec";

interface BufferedSnapshot {
  tick: number;
  entities: Map<string, EntityState>;
  receivedAt: number;
}

/**
 * Client-side state receiver: buffers incoming snapshots and interpolates
 * between them for smooth rendering.
 */
export class ClientReceiver {
  private _transport: CarverTransport;
  private _codec: Codec;
  private _snapshotChannel: CarverChannel<Uint8Array>;
  private _ackChannel: CarverChannel<string>;

  // Snapshot buffer (ring buffer of last N snapshots)
  private _buffer: BufferedSnapshot[] = [];
  private _bufferSize: number;

  // Interpolation settings
  private _method: "hermite" | "linear";
  private _extrapolateMs: number;

  // Current interpolated state
  private _interpolatedState = new Map<string, EntityState>();

  // Network quality tracking
  private _lastSnapshotTime = 0;
  private _networkQuality: NetworkQuality = "good";
  private _packetLossCount = 0;
  private _packetCount = 0;

  // Is2D mode
  private _is2D: boolean;

  // Entity state: full accumulated state from keyframes + deltas
  private _fullState = new Map<string, EntityState>();

  constructor(
    transport: CarverTransport,
    codec: Codec,
    options?: {
      bufferSize?: number;
      method?: "hermite" | "linear";
      extrapolateMs?: number;
      is2D?: boolean;
    },
  ) {
    this._transport = transport;
    this._codec = codec;
    this._bufferSize = options?.bufferSize ?? 3;
    this._method = options?.method ?? "hermite";
    this._extrapolateMs = options?.extrapolateMs ?? 250;
    this._is2D = options?.is2D ?? false;

    // Listen on the unreliable snapshot channel
    this._snapshotChannel = transport.createChannel<Uint8Array>(
      "carver:snapshots",
      {
        reliable: false,
        ordered: false,
        maxRetransmits: 0,
      },
    );

    this._ackChannel = transport.createChannel<string>("carver:acks", {
      reliable: true,
      ordered: true,
    });

    this._snapshotChannel.onReceive((data: Uint8Array) => {
      this._handleSnapshot(data);
    });
  }

  /** Get the current interpolated entity states */
  get state(): Map<string, EntityState> {
    return this._interpolatedState;
  }

  get networkQuality(): NetworkQuality {
    return this._networkQuality;
  }

  /**
   * Called every render frame to interpolate between buffered snapshots.
   * @param renderTime - current render time in ms
   */
  interpolate(renderTime: number): Map<string, EntityState> {
    if (this._buffer.length < 2) {
      // Not enough snapshots to interpolate, return latest
      return this._buffer.length > 0
        ? this._buffer[this._buffer.length - 1].entities
        : this._interpolatedState;
    }

    // Find two snapshots to interpolate between
    // We render "behind" by one buffer interval
    const interpDelay = (this._bufferSize - 1) * (1000 / 20); // Assume ~20 pps
    const targetTime = renderTime - interpDelay;

    let from: BufferedSnapshot | null = null;
    let to: BufferedSnapshot | null = null;

    for (let i = 0; i < this._buffer.length - 1; i++) {
      if (
        this._buffer[i].receivedAt <= targetTime &&
        this._buffer[i + 1].receivedAt > targetTime
      ) {
        from = this._buffer[i];
        to = this._buffer[i + 1];
        break;
      }
    }

    if (!from || !to) {
      // Extrapolation case: we're past all buffered snapshots
      const latest = this._buffer[this._buffer.length - 1];
      const timeSinceLatest = renderTime - latest.receivedAt;

      if (timeSinceLatest > this._extrapolateMs) {
        // Too far behind, just use latest snapshot
        this._updateNetworkQuality("poor");
        return latest.entities;
      }

      if (this._buffer.length >= 2) {
        from = this._buffer[this._buffer.length - 2];
        to = latest;
        this._updateNetworkQuality("degraded");
      } else {
        return latest.entities;
      }
    } else {
      this._updateNetworkQuality("good");
    }

    // Compute interpolation factor
    const range = to.receivedAt - from.receivedAt;
    const t =
      range > 0
        ? Math.min(1, Math.max(0, (targetTime - from.receivedAt) / range))
        : 1;

    // Interpolate all entities
    const result = new Map<string, EntityState>();
    const allIds = new Set([...from.entities.keys(), ...to.entities.keys()]);

    for (const id of allIds) {
      const fromEntity = from.entities.get(id);
      const toEntity = to.entities.get(id);

      if (toEntity && toEntity.c?.__removed) continue; // Removed entity

      if (fromEntity && toEntity) {
        result.set(id, this._interpolateEntity(fromEntity, toEntity, t));
      } else if (toEntity) {
        result.set(id, toEntity);
      }
    }

    this._interpolatedState = result;
    return result;
  }

  /** Request a keyframe from the host */
  requestKeyframe(): void {
    this._ackChannel.send("-1");
  }

  destroy(): void {
    this._snapshotChannel.close();
    this._ackChannel.close();
    this._buffer = [];
    this._interpolatedState.clear();
    this._fullState.clear();
  }

  private _handleSnapshot(data: Uint8Array): void {
    try {
      const { tick, baseTick, entities } = this._codec.deserializePacket(data);
      const now = performance.now();

      if (baseTick === -1) {
        // Keyframe: replace full state
        this._fullState.clear();
        for (const entity of entities) {
          this._fullState.set(entity.id, entity);
        }
      } else {
        // Delta: apply changes to full state
        for (const entity of entities) {
          if (entity.c?.__removed) {
            this._fullState.delete(entity.id);
          } else {
            this._fullState.set(entity.id, entity);
          }
        }
      }

      // Buffer the full state snapshot
      this._buffer.push({
        tick,
        entities: new Map(this._fullState),
        receivedAt: now,
      });

      // Keep buffer bounded
      while (this._buffer.length > this._bufferSize * 2) {
        this._buffer.shift();
      }

      // Send ACK
      this._ackChannel.send(String(tick));

      // Track timing for network quality
      this._lastSnapshotTime = now;
      this._packetCount++;
    } catch {
      this._packetLossCount++;
    }
  }

  private _interpolateEntity(
    from: EntityState,
    to: EntityState,
    t: number,
  ): EntityState {
    if (this._is2D || !("z" in from)) {
      return this._interpolateEntity2D(
        from as EntityState2D,
        to as EntityState2D,
        t,
      );
    }
    return this._interpolateEntity3D(
      from as EntityState3D,
      to as EntityState3D,
      t,
    );
  }

  private _interpolateEntity2D(
    from: EntityState2D,
    to: EntityState2D,
    t: number,
  ): EntityState2D {
    if (this._method === "hermite") {
      return {
        id: to.id,
        x: hermite(from.x, from.vx, to.x, to.vx, t),
        y: hermite(from.y, from.vy, to.y, to.vy, t),
        a: lerpAngle(from.a, to.a, t),
        vx: lerp(from.vx, to.vx, t),
        vy: lerp(from.vy, to.vy, t),
        va: lerp(from.va, to.va, t),
        c: interpolateCustom(from.c, to.c, t),
      };
    }
    // Linear
    return {
      id: to.id,
      x: lerp(from.x, to.x, t),
      y: lerp(from.y, to.y, t),
      a: lerpAngle(from.a, to.a, t),
      vx: lerp(from.vx, to.vx, t),
      vy: lerp(from.vy, to.vy, t),
      va: lerp(from.va, to.va, t),
      c: interpolateCustom(from.c, to.c, t),
    };
  }

  private _interpolateEntity3D(
    from: EntityState3D,
    to: EntityState3D,
    t: number,
  ): EntityState3D {
    // Quaternion SLERP for rotation
    const [qx, qy, qz, qw] = slerp(
      from.qx,
      from.qy,
      from.qz,
      from.qw,
      to.qx,
      to.qy,
      to.qz,
      to.qw,
      t,
    );

    if (this._method === "hermite") {
      return {
        id: to.id,
        x: hermite(from.x, from.vx, to.x, to.vx, t),
        y: hermite(from.y, from.vy, to.y, to.vy, t),
        z: hermite(from.z, from.vz, to.z, to.vz, t),
        qx,
        qy,
        qz,
        qw,
        vx: lerp(from.vx, to.vx, t),
        vy: lerp(from.vy, to.vy, t),
        vz: lerp(from.vz, to.vz, t),
        wx: lerp(from.wx, to.wx, t),
        wy: lerp(from.wy, to.wy, t),
        wz: lerp(from.wz, to.wz, t),
        c: interpolateCustom(from.c, to.c, t),
      };
    }

    // Linear
    return {
      id: to.id,
      x: lerp(from.x, to.x, t),
      y: lerp(from.y, to.y, t),
      z: lerp(from.z, to.z, t),
      qx,
      qy,
      qz,
      qw,
      vx: lerp(from.vx, to.vx, t),
      vy: lerp(from.vy, to.vy, t),
      vz: lerp(from.vz, to.vz, t),
      wx: lerp(from.wx, to.wx, t),
      wy: lerp(from.wy, to.wy, t),
      wz: lerp(from.wz, to.wz, t),
      c: interpolateCustom(from.c, to.c, t),
    };
  }

  private _updateNetworkQuality(quality: NetworkQuality): void {
    this._networkQuality = quality;
  }
}

// ── Math utilities ──

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  // Wrap to [-PI, PI]
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/**
 * Hermite spline interpolation using velocity for smooth curves.
 * h(t) = (2t^3 - 3t^2 + 1)p0 + (t^3 - 2t^2 + t)v0 + (-2t^3 + 3t^2)p1 + (t^3 - t^2)v1
 */
function hermite(
  p0: number,
  v0: number,
  p1: number,
  v1: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * p0 +
    (t3 - 2 * t2 + t) * v0 +
    (-2 * t3 + 3 * t2) * p1 +
    (t3 - t2) * v1
  );
}

/**
 * Quaternion SLERP (Spherical Linear Interpolation).
 */
function slerp(
  ax: number,
  ay: number,
  az: number,
  aw: number,
  bx: number,
  by: number,
  bz: number,
  bw: number,
  t: number,
): [number, number, number, number] {
  // Compute dot product
  let dot = ax * bx + ay * by + az * bz + aw * bw;

  // Ensure shortest path
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }

  if (dot > 0.9995) {
    // Very close, use linear interpolation
    return [lerp(ax, bx, t), lerp(ay, by, t), lerp(az, bz, t), lerp(aw, bw, t)];
  }

  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;

  return [
    ax * wa + bx * wb,
    ay * wa + by * wb,
    az * wa + bz * wb,
    aw * wa + bw * wb,
  ];
}

/**
 * Interpolate custom properties: lerp numbers, instant-swap others.
 */
function interpolateCustom(
  from: Record<string, unknown> | undefined,
  to: Record<string, unknown> | undefined,
  t: number,
): Record<string, unknown> | undefined {
  if (!from && !to) return undefined;
  if (!from) return to;
  if (!to) return from;

  const result: Record<string, unknown> = {};
  const allKeys = new Set([...Object.keys(from), ...Object.keys(to)]);

  for (const key of allKeys) {
    const fromVal = from[key];
    const toVal = to[key];
    if (typeof fromVal === "number" && typeof toVal === "number") {
      result[key] = lerp(fromVal, toVal, t);
    } else {
      // Instant swap: use target value after halfway
      result[key] = t >= 0.5 ? toVal : fromVal;
    }
  }

  return result;
}
