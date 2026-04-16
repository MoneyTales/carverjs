import { useSyncExternalStore } from "react";
import { getAssetManager } from "../systems/AssetManager";
import type { LoadingProgress } from "../types";

/**
 * Subscribe to real-time loading progress from the AssetManager.
 * Does NOT suspend — returns the current progress snapshot.
 *
 * Usage:
 *   const progress = useAssetProgress();
 *   // progress.progress → 0.0 to 1.0
 *   // progress.loaded → 12
 *   // progress.total → 20
 *   // progress.currentAsset → "hero.glb"
 */
export function useAssetProgress(): Readonly<LoadingProgress> {
  const manager = getAssetManager();
  useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  return manager.progress;
}
