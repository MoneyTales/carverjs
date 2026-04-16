// ─── Asset Types ──────────────────────────────────────────────────────────────

/** Supported asset format categories */
export type AssetType =
  | "gltf"
  | "texture"
  | "audio"
  | "json"
  | "binary";

/** Single asset entry in a manifest */
export interface AssetEntry {
  /** Unique key for referencing this asset. Defaults to the resolved URL. */
  key?: string;
  /** URL to load the asset from (relative or absolute) */
  url: string;
  /** Asset type override. Auto-detected from file extension if omitted. */
  type?: AssetType;
  /**
   * Loading priority. Higher numbers load first.
   * - "critical" (100): Must load before any rendering
   * - "high" (75): Load during initial preload screen
   * - "normal" (50): Default priority
   * - "low" (25): Load after initial scene is interactive
   * - "lazy" (0): Only load on first access (skipped by AssetLoader)
   * - number: Custom priority value (0-100)
   */
  priority?: "critical" | "high" | "normal" | "low" | "lazy" | number;
  /** Group name for batch loading/unloading (e.g., "level-1") */
  group?: string;
  /** Expected file size in bytes (for accurate progress estimation) */
  sizeHint?: number;
  /**
   * Loader-specific options passed to the underlying loader.
   * GLTF: { draco?: boolean | string; meshopt?: boolean }
   * Audio: { streaming?: boolean }
   */
  loaderOptions?: Record<string, unknown>;
}

/** Complete asset manifest */
export interface AssetManifest {
  /** Schema version for forward compatibility */
  version?: 1;
  /** Base URL prepended to all relative asset URLs */
  baseUrl?: string;
  /** Array of asset entries to load */
  assets: AssetEntry[];
  /** Named group configuration for batch operations */
  groups?: Record<string, AssetGroupConfig>;
}

/** Configuration for an asset group */
export interface AssetGroupConfig {
  /** Human-readable label (shown in loading UI if desired) */
  label?: string;
  /** Whether to preload this group upfront. Default: true */
  preload?: boolean;
  /** Auto-unload assets when another exclusive group loads. Default: false */
  exclusive?: boolean;
}

// ─── Loading Progress ─────────────────────────────────────────────────────────

/** Granular loading progress state */
export interface LoadingProgress {
  /** Current loading phase */
  phase: "idle" | "loading" | "complete" | "error";
  /** Number of assets that have finished loading */
  loaded: number;
  /** Total number of assets to load */
  total: number;
  /** Fraction complete (0 to 1) */
  progress: number;
  /** Key of the asset currently being loaded */
  currentAsset: string | null;
  /** Group currently being loaded */
  currentGroup: string | null;
  /** Array of errors encountered during loading */
  errors: AssetLoadError[];
}

/** Error information for a failed asset load */
export interface AssetLoadError {
  /** Asset key that failed */
  key: string;
  /** Asset URL that failed */
  url: string;
  /** Error message */
  message: string;
  /** Number of retry attempts made */
  retries: number;
  /** Whether this error is recoverable */
  recoverable: boolean;
}

// ─── Internal Cache ───────────────────────────────────────────────────────────

/** Internal cache entry metadata */
export interface CacheEntry<T = unknown> {
  /** The cached asset data */
  data: T;
  /** Key used for lookup */
  key: string;
  /** Asset type */
  type: AssetType;
  /** Estimated size in bytes */
  sizeBytes: number;
  /** Timestamp of last access (for LRU eviction) */
  lastAccessedAt: number;
  /** Number of active references (prevents eviction while in use) */
  refCount: number;
}
