import type { EntityState } from "../types";

// ── Options ──

export interface InterestManagerOptions {
  /** Spatial hash cell size in world units. Default: 50 */
  cellSize?: number;
  /** Default relevance radius around a client's position. Default: 200 */
  defaultRadius?: number;
  /** Entity ids/names that are always sent to every client. */
  alwaysRelevant?: string[];
}

// ── InterestManager ──

/**
 * Spatial-hash-grid area-of-interest filter.
 *
 * Runs on the host side. Each tick the host feeds the full entity map via
 * `updateEntities`, then queries per-client relevance with
 * `getRelevantEntities` (or creates a single filter callback via
 * `createFilter` for `HostAuthority.setInterestFilter`).
 */
export class InterestManager {
  /** cell-key -> set of entity ids occupying that cell */
  private _cells: Map<string, Set<string>>;
  /** entity id -> last-known 3D position */
  private _entityPositions: Map<string, { x: number; y: number; z: number }>;
  private _cellSize: number;
  private _defaultRadius: number;
  private _alwaysRelevant: Set<string>;

  constructor(options?: InterestManagerOptions) {
    this._cellSize = options?.cellSize ?? 50;
    this._defaultRadius = options?.defaultRadius ?? 200;
    this._alwaysRelevant = new Set(options?.alwaysRelevant ?? []);
    this._cells = new Map();
    this._entityPositions = new Map();
  }

  // ── Public API ──

  /**
   * Rebuild the spatial hash from the authoritative entity map.
   * Called once per host tick before any relevance queries.
   */
  updateEntities(entities: Map<string, EntityState>): void {
    // Clear previous grid state
    this._cells.clear();
    this._entityPositions.clear();

    for (const [id, entity] of entities) {
      const z = "z" in entity ? (entity as { z: number }).z : 0;
      const pos = { x: entity.x, y: entity.y, z };
      this._entityPositions.set(id, pos);

      const key = this._cellKey(pos.x, pos.y, pos.z);
      let bucket = this._cells.get(key);
      if (!bucket) {
        bucket = new Set();
        this._cells.set(key, bucket);
      }
      bucket.add(id);
    }
  }

  /**
   * Return the set of entity ids relevant to a single client.
   *
   * Relevance is the *union* of:
   *  1. Entities whose cell overlaps the client's bounding sphere
   *  2. Entities in the `alwaysRelevant` set
   *  3. Entities owned by this client
   */
  getRelevantEntities(
    clientPosition: { x: number; y: number; z?: number },
    clientId: string,
    owners: Map<string, string>,
    overrideRadius?: number,
  ): Set<string> {
    const radius = overrideRadius ?? this._defaultRadius;
    const cx = clientPosition.x;
    const cy = clientPosition.y;
    const cz = clientPosition.z ?? 0;

    const result = new Set<string>();

    // 1. Spatial query — iterate every cell that the bounding box of the
    //    sphere overlaps.
    const minCellX = Math.floor((cx - radius) / this._cellSize);
    const maxCellX = Math.floor((cx + radius) / this._cellSize);
    const minCellY = Math.floor((cy - radius) / this._cellSize);
    const maxCellY = Math.floor((cy + radius) / this._cellSize);
    const minCellZ = Math.floor((cz - radius) / this._cellSize);
    const maxCellZ = Math.floor((cz + radius) / this._cellSize);

    for (let ix = minCellX; ix <= maxCellX; ix++) {
      for (let iy = minCellY; iy <= maxCellY; iy++) {
        for (let iz = minCellZ; iz <= maxCellZ; iz++) {
          const key = `${ix},${iy},${iz}`;
          const bucket = this._cells.get(key);
          if (bucket) {
            for (const entityId of bucket) {
              result.add(entityId);
            }
          }
        }
      }
    }

    // 2. Always-relevant entities (must still exist in the current frame)
    for (const id of this._alwaysRelevant) {
      if (this._entityPositions.has(id)) {
        result.add(id);
      }
    }

    // 3. Self-owned entities
    for (const [entityId, ownerId] of owners) {
      if (ownerId === clientId && this._entityPositions.has(entityId)) {
        result.add(entityId);
      }
    }

    return result;
  }

  /**
   * Build a filter callback compatible with
   * `HostAuthority.setInterestFilter`.
   *
   * The returned function closes over a single relevance pass for every
   * known client so that per-entity filtering during broadcast is a cheap
   * `Set.has` lookup.
   *
   * @param clientPositions  peerId -> position of that client's camera/player
   * @param owners           entityId -> ownerPeerId
   */
  createFilter(
    clientPositions: Map<string, { x: number; y: number; z?: number }>,
    owners: Map<string, string>,
  ): (entityId: string, peerId: string) => boolean {
    // Pre-compute the relevant set for every known client once.
    const relevanceSets = new Map<string, Set<string>>();
    for (const [peerId, pos] of clientPositions) {
      relevanceSets.set(
        peerId,
        this.getRelevantEntities(pos, peerId, owners),
      );
    }

    return (entityId: string, peerId: string): boolean => {
      const set = relevanceSets.get(peerId);
      // If we have no position info for this client, include everything
      // (fail-open so new joiners still receive data).
      if (!set) return true;
      return set.has(entityId);
    };
  }

  /** Remove all data from the grid. */
  clear(): void {
    this._cells.clear();
    this._entityPositions.clear();
  }

  // ── Private helpers ──

  private _cellKey(x: number, y: number, z: number): string {
    const cx = Math.floor(x / this._cellSize);
    const cy = Math.floor(y / this._cellSize);
    const cz = Math.floor(z / this._cellSize);
    return `${cx},${cy},${cz}`;
  }
}
