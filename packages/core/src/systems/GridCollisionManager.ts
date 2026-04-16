import type { GridCollisionConfig } from "../types";

class GridCollisionManager {
  private _grid: Int32Array = new Int32Array(0);
  private _width = 0;
  private _height = 0;
  private _cellSize = 1;
  private _originX = 0;
  private _originY = 0;

  create(config: GridCollisionConfig): void {
    this._width = config.width;
    this._height = config.height;
    this._cellSize = config.cellSize ?? 1;
    this._originX = config.origin?.[0] ?? 0;
    this._originY = config.origin?.[1] ?? 0;
    this._grid = new Int32Array(this._width * this._height);
  }

  private _inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this._width && y >= 0 && y < this._height;
  }

  private _index(x: number, y: number): number {
    return y * this._width + x;
  }

  setCell(x: number, y: number, value: number): void {
    if (!this._inBounds(x, y)) return;
    this._grid[this._index(x, y)] = value;
  }

  getCell(x: number, y: number): number {
    if (!this._inBounds(x, y)) return 0;
    return this._grid[this._index(x, y)];
  }

  clearCell(x: number, y: number): void {
    this.setCell(x, y, 0);
  }

  isCellOccupied(x: number, y: number): boolean {
    return this.getCell(x, y) !== 0;
  }

  worldToGrid(worldX: number, worldY: number): [number, number] {
    return [
      Math.floor((worldX - this._originX) / this._cellSize),
      Math.floor((worldY - this._originY) / this._cellSize),
    ];
  }

  gridToWorld(gridX: number, gridY: number): [number, number] {
    return [
      this._originX + gridX * this._cellSize + this._cellSize / 2,
      this._originY + gridY * this._cellSize + this._cellSize / 2,
    ];
  }

  getNeighbors4(x: number, y: number): [number, number, number, number] {
    return [
      this.getCell(x, y - 1), // up
      this.getCell(x + 1, y), // right
      this.getCell(x, y + 1), // down
      this.getCell(x - 1, y), // left
    ];
  }

  getNeighbors8(x: number, y: number): number[] {
    return [
      this.getCell(x, y - 1),     // up
      this.getCell(x + 1, y - 1), // up-right
      this.getCell(x + 1, y),     // right
      this.getCell(x + 1, y + 1), // down-right
      this.getCell(x, y + 1),     // down
      this.getCell(x - 1, y + 1), // down-left
      this.getCell(x - 1, y),     // left
      this.getCell(x - 1, y - 1), // up-left
    ];
  }

  clearAll(): void {
    this._grid.fill(0);
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  get cellSize(): number {
    return this._cellSize;
  }
}

// ── Singleton accessor ──

let _instance: GridCollisionManager | null = null;

export function getGridCollisionManager(): GridCollisionManager {
  if (!_instance) _instance = new GridCollisionManager();
  return _instance;
}

export function destroyGridCollisionManager(): void {
  _instance = null;
}
