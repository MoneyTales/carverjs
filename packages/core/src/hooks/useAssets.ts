import { useEffect, useRef } from "react";
import { getAssetManager } from "../systems/AssetManager";

/**
 * Access one or more preloaded assets by key.
 *
 * Single asset:
 *   const model = useAssets<GLTF>("/models/hero.glb");
 *
 * Multiple assets:
 *   const [hero, bg] = useAssets<[GLTF, Texture]>(["/models/hero.glb", "/textures/bg.png"]);
 *
 * Assets must be preloaded via <AssetLoader>. Throws if not found.
 * Automatically retains the asset (prevents LRU eviction) while the component is mounted.
 */
export function useAssets<T = unknown>(key: string): T;
export function useAssets<T = unknown>(keys: string[]): T[];
export function useAssets<T = unknown>(keyOrKeys: string | string[]): T | T[] {
  const manager = getAssetManager();
  const keysRef = useRef(keyOrKeys);

  // Retain on mount, release on unmount (prevents eviction while in use)
  useEffect(() => {
    const keys = Array.isArray(keysRef.current)
      ? keysRef.current
      : [keysRef.current];
    const mgr = getAssetManager();
    for (const k of keys) mgr.retain(k);
    return () => {
      for (const k of keys) mgr.release(k);
    };
  }, []);

  if (Array.isArray(keyOrKeys)) {
    return keyOrKeys.map((k) => {
      const asset = manager.get<T>(k);
      if (asset === undefined) {
        throw new Error(
          `[CarverJS] Asset "${k}" not loaded. Preload via <AssetLoader>.`,
        );
      }
      return asset;
    }) as T[];
  }

  const asset = manager.get<T>(keyOrKeys);
  if (asset === undefined) {
    throw new Error(
      `[CarverJS] Asset "${keyOrKeys}" not loaded. Preload via <AssetLoader>.`,
    );
  }
  return asset;
}
