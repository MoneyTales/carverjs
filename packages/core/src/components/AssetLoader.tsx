import { useState, useEffect, useRef, type ReactNode } from "react";
import { useGLTF, useTexture, Html } from "@react-three/drei";
import {
  getAssetManager,
  detectAssetType,
} from "../systems/AssetManager";
import { useGameStore } from "../store/gameStore";
import type {
  AssetManifest,
  AssetEntry,
  LoadingProgress,
  AssetLoadError,
} from "../types";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface AssetLoaderProps {
  /**
   * Asset manifest or array of asset entries to preload.
   * Can also be a URL to a JSON manifest file.
   */
  manifest: AssetManifest | AssetEntry[] | string;
  /**
   * React element to render while loading. Receives progress as render prop.
   * Rendered as an HTML overlay via a portal to document.body.
   */
  fallback?: ReactNode | ((progress: LoadingProgress) => ReactNode);
  /** Maximum number of assets to load in parallel. Default: 6. */
  concurrency?: number;
  /** Number of retry attempts for failed loads. Default: 3. */
  retries?: number;
  /** Base delay between retries in ms (with exponential backoff). Default: 1000. */
  retryDelay?: number;
  /** Timeout per asset in milliseconds. Default: 30000. */
  timeout?: number;
  /** Minimum time to show loading screen (prevents flash). Default: 0. */
  minLoadTime?: number;
  /** Called when all assets finish loading successfully. */
  onComplete?: () => void;
  /** Called when any asset fails to load (after all retries). */
  onError?: (errors: AssetLoadError[]) => void;
  /** Called on each progress update. */
  onProgress?: (progress: LoadingProgress) => void;
  /** Children to render once all assets are loaded. */
  children: ReactNode;
}

// ── Idle progress constant ────────────────────────────────────────────────────

const IDLE_PROGRESS: LoadingProgress = {
  phase: "idle",
  loaded: 0,
  total: 0,
  progress: 0,
  currentAsset: null,
  currentGroup: null,
  errors: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveEntries(
  manifest: AssetManifest | AssetEntry[],
): { entries: AssetEntry[]; baseUrl: string } {
  if (Array.isArray(manifest)) {
    return { entries: manifest, baseUrl: "" };
  }
  return { entries: manifest.assets, baseUrl: manifest.baseUrl ?? "" };
}

function resolveUrl(url: string, baseUrl: string): string {
  if (
    url.startsWith("http") ||
    url.startsWith("/") ||
    url.startsWith("data:")
  ) {
    return url;
  }
  return baseUrl + url;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Declarative asset preloader. Loads all assets in the manifest before
 * rendering children. Shows the fallback during loading.
 *
 * Place inside <Game> (requires R3F context).
 *
 * Usage:
 *   <AssetLoader
 *     manifest={[{ url: "/models/hero.glb" }, { url: "/textures/bg.png" }]}
 *     fallback={(p) => <LoadingScreen progress={p} />}
 *   >
 *     <World>
 *       <Actor type="model" src="/models/hero.glb" />
 *     </World>
 *   </AssetLoader>
 */
export function AssetLoader({
  manifest,
  fallback,
  concurrency,
  retries,
  retryDelay,
  timeout,
  minLoadTime = 0,
  onComplete,
  onError,
  onProgress,
  children,
}: AssetLoaderProps) {
  const [progress, setProgress] = useState<LoadingProgress>(IDLE_PROGRESS);
  const [ready, setReady] = useState(false);
  const startRef = useRef(0);

  useEffect(() => {
    const manager = getAssetManager();

    // Apply configuration overrides
    manager.configure({
      ...(concurrency !== undefined && { maxConcurrent: concurrency }),
      ...(retries !== undefined && { retries }),
      ...(retryDelay !== undefined && { retryDelay }),
      ...(timeout !== undefined && { timeout }),
    });

    // Handle URL-based manifest (fetch JSON then start loading)
    if (typeof manifest === "string") {
      fetch(manifest)
        .then((r) => r.json())
        .then((json: AssetManifest) => startLoad(json))
        .catch((err) => {
          const errorProgress: LoadingProgress = {
            ...IDLE_PROGRESS,
            phase: "error",
            errors: [
              {
                key: manifest,
                url: manifest,
                message:
                  err instanceof Error ? err.message : String(err),
                retries: 0,
                recoverable: false,
              },
            ],
          };
          setProgress(errorProgress);
          onError?.(errorProgress.errors);
        });
      return;
    }

    startLoad(manifest);

    function startLoad(m: AssetManifest | AssetEntry[]) {
      const { entries, baseUrl } = resolveEntries(m);

      // Warm drei's internal cache for GLTF and texture assets.
      // Both our AssetManager and drei load the same URL; the browser's
      // HTTP cache ensures only one network request per asset.
      for (const entry of entries) {
        const url = resolveUrl(entry.url, baseUrl);
        const type = entry.type ?? detectAssetType(url);

        if (type === "gltf") {
          useGLTF.preload(
            url,
            entry.loaderOptions?.draco as boolean | string | undefined,
            entry.loaderOptions?.meshopt as boolean | undefined,
          );
        }
        if (type === "texture") {
          useTexture.preload(url as never);
        }
      }

      startRef.current = performance.now();

      manager.loadManifest(m, {
        onProgress: (p) => {
          // Clone for React state (progress object is mutated in place)
          const cloned: LoadingProgress = {
            ...p,
            errors: [...p.errors],
          };
          setProgress(cloned);
          onProgress?.(cloned);
        },
        onComplete: () => {
          const elapsed = performance.now() - startRef.current;
          const remaining = Math.max(0, minLoadTime - elapsed);

          setTimeout(() => {
            setReady(true);

            // Transition game phase from "loading" to "playing"
            const state = useGameStore.getState();
            if (state.phase === "loading") {
              state.setPhase("playing");
            }

            onComplete?.();
          }, remaining);
        },
        onError,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render ──
  //
  // Children are ALWAYS mounted so that SceneManager (and other systems)
  // initialize at the same time as the rest of the R3F tree — matching
  // the behavior of a game without AssetLoader. During loading the
  // children group is hidden and an Html overlay shows the fallback.

  return (
    <>
      {/* Loading screen overlay via drei's Html (designed for R3F) */}
      {!ready && fallback && (
        <Html fullscreen zIndexRange={[100, 0]}>
          {typeof fallback === "function" ? fallback(progress) : fallback}
        </Html>
      )}

      {/* Children are always in the tree but hidden until loading completes */}
      <group visible={ready}>
        {children}
      </group>
    </>
  );
}
