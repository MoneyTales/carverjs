import { Vector3 } from "three";
import type { Object3D } from "three";
import type {
  ColliderDef,
  CollisionCallback,
  CollisionEvent,
  WorldMode,
} from "../types";
import type { RefObject } from "react";

// ── Internal entry stored per registered collider ──

interface ColliderEntry {
  id: string;
  ref: RefObject<Object3D | null>;
  collider: ColliderDef;
  name: string;
  userData: Record<string, unknown>;
  layer: number;
  mask: number;
  sensor: boolean;
  onEnter: CollisionCallback | null;
  onExit: CollisionCallback | null;
  onStay: CollisionCallback | null;
  enabled: boolean;
  /** Set of collider IDs currently overlapping */
  overlaps: Set<string>;
}

// ── Pre-allocated temporaries for zero-GC hot loop ──

const _posA = new Vector3();
const _posB = new Vector3();

// ── Narrow-phase overlap tests ──

function aabbOverlap(
  posA: Vector3,
  a: { halfExtents: [number, number, number]; offset?: [number, number, number] },
  posB: Vector3,
  b: { halfExtents: [number, number, number]; offset?: [number, number, number] },
  is2D: boolean,
): boolean {
  const aoX = a.offset?.[0] ?? 0;
  const aoY = a.offset?.[1] ?? 0;
  const aoZ = a.offset?.[2] ?? 0;
  const boX = b.offset?.[0] ?? 0;
  const boY = b.offset?.[1] ?? 0;
  const boZ = b.offset?.[2] ?? 0;

  const ax = posA.x + aoX;
  const ay = posA.y + aoY;
  const bx = posB.x + boX;
  const by = posB.y + boY;

  if (
    Math.abs(ax - bx) > a.halfExtents[0] + b.halfExtents[0] ||
    Math.abs(ay - by) > a.halfExtents[1] + b.halfExtents[1]
  ) {
    return false;
  }

  if (!is2D) {
    const az = posA.z + aoZ;
    const bz = posB.z + boZ;
    if (Math.abs(az - bz) > a.halfExtents[2] + b.halfExtents[2]) {
      return false;
    }
  }

  return true;
}

function sphereOverlap(
  posA: Vector3,
  a: { radius: number; offset?: [number, number, number] },
  posB: Vector3,
  b: { radius: number; offset?: [number, number, number] },
  is2D: boolean,
): boolean {
  const aoX = a.offset?.[0] ?? 0;
  const aoY = a.offset?.[1] ?? 0;
  const boX = b.offset?.[0] ?? 0;
  const boY = b.offset?.[1] ?? 0;

  const dx = (posA.x + aoX) - (posB.x + boX);
  const dy = (posA.y + aoY) - (posB.y + boY);
  let distSq = dx * dx + dy * dy;

  if (!is2D) {
    const aoZ = a.offset?.[2] ?? 0;
    const boZ = b.offset?.[2] ?? 0;
    const dz = (posA.z + aoZ) - (posB.z + boZ);
    distSq += dz * dz;
  }

  const r = a.radius + b.radius;
  return distSq <= r * r;
}

function aabbSphereOverlap(
  posAABB: Vector3,
  aabb: { halfExtents: [number, number, number]; offset?: [number, number, number] },
  posSphere: Vector3,
  sphere: { radius: number; offset?: [number, number, number] },
  is2D: boolean,
): boolean {
  const aoX = aabb.offset?.[0] ?? 0;
  const aoY = aabb.offset?.[1] ?? 0;
  const soX = sphere.offset?.[0] ?? 0;
  const soY = sphere.offset?.[1] ?? 0;

  const cx = posAABB.x + aoX;
  const cy = posAABB.y + aoY;
  const sx = posSphere.x + soX;
  const sy = posSphere.y + soY;

  // Clamp sphere center to AABB, compute distance squared
  const clampedX = Math.max(cx - aabb.halfExtents[0], Math.min(sx, cx + aabb.halfExtents[0]));
  const clampedY = Math.max(cy - aabb.halfExtents[1], Math.min(sy, cy + aabb.halfExtents[1]));

  let distSq = (sx - clampedX) ** 2 + (sy - clampedY) ** 2;

  if (!is2D) {
    const aoZ = aabb.offset?.[2] ?? 0;
    const soZ = sphere.offset?.[2] ?? 0;
    const cz = posAABB.z + aoZ;
    const sz = posSphere.z + soZ;
    const clampedZ = Math.max(cz - aabb.halfExtents[2], Math.min(sz, cz + aabb.halfExtents[2]));
    distSq += (sz - clampedZ) ** 2;
  }

  return distSq <= sphere.radius * sphere.radius;
}

function testOverlap(
  posA: Vector3,
  colA: ColliderDef,
  posB: Vector3,
  colB: ColliderDef,
  is2D: boolean,
): boolean {
  const shapeA = colA.shape;
  const shapeB = colB.shape;

  // AABB vs AABB
  if (shapeA === "aabb" && shapeB === "aabb") {
    return aabbOverlap(posA, colA, posB, colB, is2D);
  }

  // Sphere/Circle vs Sphere/Circle
  if (
    (shapeA === "sphere" || shapeA === "circle") &&
    (shapeB === "sphere" || shapeB === "circle")
  ) {
    return sphereOverlap(posA, colA, posB, colB, is2D);
  }

  // AABB vs Sphere/Circle
  if (shapeA === "aabb" && (shapeB === "sphere" || shapeB === "circle")) {
    return aabbSphereOverlap(posA, colA, posB, colB, is2D);
  }
  if ((shapeA === "sphere" || shapeA === "circle") && shapeB === "aabb") {
    return aabbSphereOverlap(posB, colB, posA, colA, is2D);
  }

  return false;
}

// ── Spatial Hash for broad phase ──

class SpatialHash {
  private _cellSize = 2;
  private _cells = new Map<number, string[]>();

  setCellSize(size: number): void {
    this._cellSize = Math.max(size, 0.01);
  }

  clear(): void {
    this._cells.clear();
  }

  private _key(cx: number, cy: number): number {
    // Simple hash combining two ints
    return ((cx * 92837111) ^ (cy * 689287499)) | 0;
  }

  insert(id: string, x: number, y: number, radius: number): void {
    const cs = this._cellSize;
    const minCX = Math.floor((x - radius) / cs);
    const maxCX = Math.floor((x + radius) / cs);
    const minCY = Math.floor((y - radius) / cs);
    const maxCY = Math.floor((y + radius) / cs);

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cy = minCY; cy <= maxCY; cy++) {
        const key = this._key(cx, cy);
        let bucket = this._cells.get(key);
        if (!bucket) {
          bucket = [];
          this._cells.set(key, bucket);
        }
        bucket.push(id);
      }
    }
  }

  getPotentialPairs(): Set<string> {
    const pairs = new Set<string>();
    for (const bucket of this._cells.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          // Ensure consistent pair ordering
          const a = bucket[i];
          const b = bucket[j];
          const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
          pairs.add(pairKey);
        }
      }
    }
    return pairs;
  }
}

// ── CollisionManager class ──

class CollisionManager {
  private _entries = new Map<string, ColliderEntry>();
  private _mode: WorldMode = "3d";
  private _spatialHash = new SpatialHash();

  setMode(mode: WorldMode): void {
    this._mode = mode;
  }

  register(id: string, entry: Omit<ColliderEntry, "id" | "overlaps">): void {
    this._entries.set(id, { ...entry, id, overlaps: new Set() });
  }

  unregister(id: string): void {
    const entry = this._entries.get(id);
    if (!entry) return;

    // Fire exit events for any remaining overlaps
    for (const otherId of entry.overlaps) {
      const other = this._entries.get(otherId);
      if (other) {
        other.overlaps.delete(id);
        if (other.onExit && other.enabled) {
          other.onExit({
            otherName: entry.name,
            otherUserData: entry.userData,
            otherRef: entry.ref,
            isSensor: entry.sensor,
          });
        }
      }
    }

    this._entries.delete(id);
  }

  updateCallbacks(
    id: string,
    onEnter: CollisionCallback | null,
    onExit: CollisionCallback | null,
    onStay: CollisionCallback | null,
  ): void {
    const entry = this._entries.get(id);
    if (entry) {
      entry.onEnter = onEnter;
      entry.onExit = onExit;
      entry.onStay = onStay;
    }
  }

  updateEnabled(id: string, enabled: boolean): void {
    const entry = this._entries.get(id);
    if (entry) entry.enabled = enabled;
  }

  getOverlaps(id: string): string[] {
    const entry = this._entries.get(id);
    if (!entry) return [];
    const result: string[] = [];
    for (const otherId of entry.overlaps) {
      const other = this._entries.get(otherId);
      if (other) result.push(other.name);
    }
    return result;
  }

  isOverlapping(id: string, name: string): boolean {
    const entry = this._entries.get(id);
    if (!entry) return false;
    for (const otherId of entry.overlaps) {
      const other = this._entries.get(otherId);
      if (other && other.name === name) return true;
    }
    return false;
  }

  /** Called once per frame at priority -25. */
  tick(): void {
    const entries = this._entries;
    if (entries.size < 2) return;

    const is2D = this._mode === "2d";

    // Compute bounding radius and insert into spatial hash
    this._spatialHash.clear();
    let maxRadius = 0;

    for (const [id, entry] of entries) {
      if (!entry.enabled || !entry.ref.current) continue;

      entry.ref.current.getWorldPosition(_posA);

      const col = entry.collider;
      let radius: number;
      if (col.shape === "aabb") {
        radius = Math.sqrt(
          col.halfExtents[0] ** 2 +
          col.halfExtents[1] ** 2 +
          (is2D ? 0 : col.halfExtents[2] ** 2),
        );
      } else {
        radius = col.radius;
      }

      if (radius > maxRadius) maxRadius = radius;
      this._spatialHash.insert(id, _posA.x, _posA.y, radius);
    }

    this._spatialHash.setCellSize(maxRadius * 2 || 2);

    // Broad phase: get potential pairs from spatial hash
    const potentialPairs = this._spatialHash.getPotentialPairs();

    // Track which pairs overlap this frame
    const currentOverlaps = new Set<string>();

    for (const pairKey of potentialPairs) {
      const [idA, idB] = pairKey.split("|");
      const entryA = entries.get(idA);
      const entryB = entries.get(idB);
      if (!entryA || !entryB) continue;
      if (!entryA.enabled || !entryB.enabled) continue;
      if (!entryA.ref.current || !entryB.ref.current) continue;

      // Layer/mask filtering
      if ((entryA.layer & entryB.mask) === 0 || (entryB.layer & entryA.mask) === 0) {
        continue;
      }

      // Get world positions
      entryA.ref.current.getWorldPosition(_posA);
      entryB.ref.current.getWorldPosition(_posB);

      // Narrow phase
      if (!testOverlap(_posA, entryA.collider, _posB, entryB.collider, is2D)) {
        continue;
      }

      currentOverlaps.add(pairKey);

      const wasOverlapping = entryA.overlaps.has(idB);

      if (!wasOverlapping) {
        // New overlap — fire enter
        entryA.overlaps.add(idB);
        entryB.overlaps.add(idA);

        const eventForA: CollisionEvent = {
          otherName: entryB.name,
          otherUserData: entryB.userData,
          otherRef: entryB.ref,
          isSensor: entryB.sensor,
        };
        const eventForB: CollisionEvent = {
          otherName: entryA.name,
          otherUserData: entryA.userData,
          otherRef: entryA.ref,
          isSensor: entryA.sensor,
        };

        entryA.onEnter?.(eventForA);
        entryB.onEnter?.(eventForB);
      } else {
        // Continuing overlap — fire stay
        const eventForA: CollisionEvent = {
          otherName: entryB.name,
          otherUserData: entryB.userData,
          otherRef: entryB.ref,
          isSensor: entryB.sensor,
        };
        const eventForB: CollisionEvent = {
          otherName: entryA.name,
          otherUserData: entryA.userData,
          otherRef: entryA.ref,
          isSensor: entryA.sensor,
        };

        entryA.onStay?.(eventForA);
        entryB.onStay?.(eventForB);
      }
    }

    // Check for exits: overlaps that existed last frame but not this frame
    for (const [id, entry] of entries) {
      if (!entry.enabled) continue;

      const toRemove: string[] = [];
      for (const otherId of entry.overlaps) {
        const pairKey = id < otherId ? `${id}|${otherId}` : `${otherId}|${id}`;
        if (!currentOverlaps.has(pairKey)) {
          toRemove.push(otherId);
        }
      }

      for (const otherId of toRemove) {
        entry.overlaps.delete(otherId);
        const other = entries.get(otherId);
        if (other) {
          other.overlaps.delete(id);
          if (entry.onExit) {
            entry.onExit({
              otherName: other.name,
              otherUserData: other.userData,
              otherRef: other.ref,
              isSensor: other.sensor,
            });
          }
        }
      }
    }
  }
}

// ── Singleton accessor ──

let _instance: CollisionManager | null = null;

export function getCollisionManager(): CollisionManager {
  if (!_instance) _instance = new CollisionManager();
  return _instance;
}

export function destroyCollisionManager(): void {
  _instance = null;
}
