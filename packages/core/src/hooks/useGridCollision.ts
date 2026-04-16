import { useRef, useEffect } from "react";
import {
  getGridCollisionManager,
  destroyGridCollisionManager,
} from "../systems/GridCollisionManager";
import type { UseGridCollisionOptions, UseGridCollisionReturn } from "../types";

export function useGridCollision(
  options: UseGridCollisionOptions,
): UseGridCollisionReturn {
  const { config } = options;

  // Initialize the grid on mount / when config changes
  useEffect(() => {
    getGridCollisionManager().create(config);
    return () => {
      destroyGridCollisionManager();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.width, config.height, config.cellSize, config.origin?.[0], config.origin?.[1]]);

  // Stable imperative API — delegates to singleton
  const returnRef = useRef<UseGridCollisionReturn>({
    setCell: (x, y, value) => getGridCollisionManager().setCell(x, y, value),
    getCell: (x, y) => getGridCollisionManager().getCell(x, y),
    clearCell: (x, y) => getGridCollisionManager().clearCell(x, y),
    isCellOccupied: (x, y) => getGridCollisionManager().isCellOccupied(x, y),
    worldToGrid: (wx, wy) => getGridCollisionManager().worldToGrid(wx, wy),
    gridToWorld: (gx, gy) => getGridCollisionManager().gridToWorld(gx, gy),
    getNeighbors4: (x, y) => getGridCollisionManager().getNeighbors4(x, y),
    getNeighbors8: (x, y) => getGridCollisionManager().getNeighbors8(x, y),
    clearAll: () => getGridCollisionManager().clearAll(),
  });

  return returnRef.current;
}
