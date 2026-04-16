import type {
  AssetType,
  AssetEntry,
  AssetManifest,
  LoadingProgress,
  AssetLoadError,
  CacheEntry,
} from "../types";

// ── Format Detection ────────────────────────────────────────────────────────────

const EXTENSION_MAP: ReadonlyMap<string, AssetType> = new Map([
  [".gltf", "gltf"],
  [".glb", "gltf"],
  [".png", "texture"],
  [".jpg", "texture"],
  [".jpeg", "texture"],
  [".webp", "texture"],
  [".svg", "texture"],
  [".mp3", "audio"],
  [".ogg", "audio"],
  [".wav", "audio"],
  [".m4a", "audio"],
  [".json", "json"],
  [".bin", "binary"],
  [".dat", "binary"],
]);

/**
 * Detect asset type from a URL's file extension.
 * Handles query params, hashes, and data URLs.
 */
export function detectAssetType(url: string): AssetType | undefined {
  // Strip query string and hash
  const clean = url.split("?")[0].split("#")[0];
  const dot = clean.lastIndexOf(".");
  if (dot !== -1) {
    const ext = clean.slice(dot).toLowerCase();
    return EXTENSION_MAP.get(ext);
  }

  // Check data URL MIME types
  if (url.startsWith("data:")) {
    const mime = url.slice(5, url.indexOf(";"));
    if (mime.includes("gltf")) return "gltf";
    if (mime.startsWith("image/")) return "texture";
    if (mime.startsWith("audio/")) return "audio";
    if (mime === "application/json") return "json";
  }

  return undefined;
}

// ── Priority Resolution ─────────────────────────────────────────────────────────

function resolvePriority(p?: AssetEntry["priority"]): number {
  if (typeof p === "number") return p;
  switch (p) {
    case "critical":
      return 100;
    case "high":
      return 75;
    case "low":
      return 25;
    case "lazy":
      return 0;
    case "normal":
    default:
      return 50;
  }
}

// ── Loader Function Type ────────────────────────────────────────────────────────

type LoaderFn = (
  url: string,
  options: Record<string, unknown>,
) => Promise<unknown>;

// ── Built-in Loaders ────────────────────────────────────────────────────────────

const _loaders: Record<AssetType, LoaderFn> = {
  gltf: async (url, options) => {
    const { GLTFLoader } = await import("three-stdlib");
    const loader = new GLTFLoader();

    if (options.draco) {
      const { DRACOLoader } = await import("three-stdlib");
      const draco = new DRACOLoader();
      draco.setDecoderPath(
        typeof options.draco === "string"
          ? options.draco
          : "https://www.gstatic.com/draco/versioned/decoders/1.5.7/",
      );
      loader.setDRACOLoader(draco);
    }

    if (options.meshopt) {
      const { MeshoptDecoder } = await import("three-stdlib");
      loader.setMeshoptDecoder(MeshoptDecoder);
    }

    return new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    });
  },

  texture: async (url) => {
    const { TextureLoader } = await import("three");
    return new Promise((resolve, reject) => {
      new TextureLoader().load(url, resolve, undefined, reject);
    });
  },

  audio: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.arrayBuffer();
  },

  json: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
  },

  binary: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.arrayBuffer();
  },
};

// ── Size Estimation ─────────────────────────────────────────────────────────────

function estimateSize(data: unknown, type: AssetType): number {
  switch (type) {
    case "audio":
    case "binary":
      return (data as ArrayBuffer).byteLength;
    case "texture": {
      const tex = data as { image?: { width?: number; height?: number } };
      if (tex.image)
        return (tex.image.width ?? 256) * (tex.image.height ?? 256) * 4;
      return 1024;
    }
    case "json":
      try {
        return JSON.stringify(data).length * 2;
      } catch {
        return 1024;
      }
    case "gltf":
      return 1024 * 1024; // Rough estimate; GLTF size varies widely
    default:
      return 1024;
  }
}

// ── Three.js Resource Disposal ──────────────────────────────────────────────────

function disposeAsset(data: unknown, type: AssetType): void {
  try {
    if (type === "texture") {
      (data as { dispose?: () => void }).dispose?.();
    } else if (type === "gltf") {
      const gltf = data as {
        scene?: {
          traverse?: (fn: (child: unknown) => void) => void;
        };
      };
      gltf.scene?.traverse?.((child: unknown) => {
        const c = child as Record<string, unknown>;
        (c.geometry as { dispose?: () => void })?.dispose?.();
        if (c.material) {
          const mats = Array.isArray(c.material)
            ? c.material
            : [c.material];
          for (const m of mats) {
            const mat = m as Record<string, unknown>;
            (mat.map as { dispose?: () => void })?.dispose?.();
            (mat.normalMap as { dispose?: () => void })?.dispose?.();
            (mat.roughnessMap as { dispose?: () => void })?.dispose?.();
            (mat.metalnessMap as { dispose?: () => void })?.dispose?.();
            (mat as { dispose?: () => void }).dispose?.();
          }
        }
      });
    }
  } catch {
    // Disposal errors must never propagate
  }
}

// ── AssetManager ────────────────────────────────────────────────────────────────

class AssetManager {
  // ── Cache ──
  private _cache = new Map<string, CacheEntry>();
  private _groups = new Map<string, Set<string>>();
  private _totalBytes = 0;
  private _maxBytes = 256 * 1024 * 1024; // 256 MB

  // ── Custom loaders (override built-in) ──
  private _customLoaders = new Map<string, LoaderFn>();

  // ── Loading state ──
  private _activeLoads = new Map<string, Promise<unknown>>();

  // ── Configuration ──
  private _maxConcurrent = 6;
  private _retries = 3;
  private _retryDelay = 1000;
  private _timeout = 30000;

  // ── Progress (pre-allocated, mutated in place for zero-GC) ──
  private _progress: LoadingProgress = {
    phase: "idle",
    loaded: 0,
    total: 0,
    progress: 0,
    currentAsset: null,
    currentGroup: null,
    errors: [],
  };

  // ── useSyncExternalStore subscriber pattern ──

  private _stateVersion = 0;
  private _subscribers = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this._subscribers.add(cb);
    return () => {
      this._subscribers.delete(cb);
    };
  };

  getSnapshot = (): number => this._stateVersion;

  private _notify(): void {
    this._stateVersion++;
    for (const cb of this._subscribers) cb();
  }

  /** Current loading progress (read-only snapshot) */
  get progress(): Readonly<LoadingProgress> {
    return this._progress;
  }

  // ── Configuration ───────────────────────────────────────────────────────────

  configure(options: {
    maxConcurrent?: number;
    maxCacheBytes?: number;
    retries?: number;
    retryDelay?: number;
    timeout?: number;
  }): void {
    if (options.maxConcurrent !== undefined)
      this._maxConcurrent = options.maxConcurrent;
    if (options.maxCacheBytes !== undefined)
      this._maxBytes = options.maxCacheBytes;
    if (options.retries !== undefined) this._retries = options.retries;
    if (options.retryDelay !== undefined) this._retryDelay = options.retryDelay;
    if (options.timeout !== undefined) this._timeout = options.timeout;
  }

  // ── Cache Access ────────────────────────────────────────────────────────────

  /** Get a loaded asset synchronously. Returns undefined if not cached. */
  get<T = unknown>(key: string): T | undefined {
    const entry = this._cache.get(key);
    if (!entry) return undefined;
    entry.lastAccessedAt = Date.now();
    return entry.data as T;
  }

  /** Check if an asset is loaded and cached. */
  has(key: string): boolean {
    return this._cache.has(key);
  }

  /** Check if an asset is currently loading. */
  isLoading(key: string): boolean {
    return this._activeLoads.has(key);
  }

  // ── Single Asset Load ───────────────────────────────────────────────────────

  /**
   * Load a single asset by URL. Returns cached result if available.
   * Deduplicates concurrent requests for the same key.
   */
  async load<T = unknown>(
    url: string,
    options?: {
      type?: AssetType;
      key?: string;
      loaderOptions?: Record<string, unknown>;
    },
  ): Promise<T> {
    const key = options?.key ?? url;

    // Cache hit
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const type = options?.type ?? detectAssetType(url);
    if (!type)
      throw new Error(
        `[CarverJS] Cannot detect asset type for "${url}". Specify type explicitly.`,
      );

    return this._loadWithRetry(
      url,
      key,
      type,
      options?.loaderOptions ?? {},
    ) as Promise<T>;
  }

  // ── Manifest Load ──────────────────────────────────────────────────────────

  /**
   * Load all assets from a manifest with progress tracking.
   * Assets with priority "lazy" are skipped (loaded on-demand via useAssets).
   * Already-cached assets are skipped.
   */
  async loadManifest(
    manifest: AssetManifest | AssetEntry[],
    callbacks?: {
      onProgress?: (progress: LoadingProgress) => void;
      onComplete?: () => void;
      onError?: (errors: AssetLoadError[]) => void;
    },
  ): Promise<void> {
    const entries = this._parseManifest(manifest);

    // Filter out lazy and already-cached
    const toLoad = entries.filter(
      (e) => resolvePriority(e.priority) > 0 && !this.has(e.key ?? e.url),
    );

    if (toLoad.length === 0) {
      const p = this._progress;
      p.phase = "complete";
      p.progress = 1;
      p.loaded = 0;
      p.total = 0;
      this._notify();
      callbacks?.onProgress?.(p);
      callbacks?.onComplete?.();
      return;
    }

    // Sort by priority (highest first)
    toLoad.sort(
      (a, b) => resolvePriority(b.priority) - resolvePriority(a.priority),
    );

    // Track group membership
    for (const entry of toLoad) {
      if (entry.group) {
        let set = this._groups.get(entry.group);
        if (!set) {
          set = new Set();
          this._groups.set(entry.group, set);
        }
        set.add(entry.key ?? entry.url);
      }
    }

    // Reset progress
    const p = this._progress;
    p.phase = "loading";
    p.loaded = 0;
    p.total = toLoad.length;
    p.progress = 0;
    p.currentAsset = null;
    p.currentGroup = null;
    p.errors = [];
    this._notify();
    callbacks?.onProgress?.(p);

    // Concurrency-limited loading via worker pool pattern.
    // Each worker pulls the next task from a shared index (safe in single-threaded JS).
    let idx = 0;
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(this._maxConcurrent, toLoad.length);

    for (let w = 0; w < workerCount; w++) {
      workers.push(
        (async () => {
          while (idx < toLoad.length) {
            const entry = toLoad[idx++];
            const key = entry.key ?? entry.url;
            const type = entry.type ?? detectAssetType(entry.url);

            if (!type) {
              p.errors.push({
                key,
                url: entry.url,
                message: `Cannot detect asset type for "${entry.url}"`,
                retries: 0,
                recoverable: false,
              });
              p.loaded++;
              p.progress = p.total > 0 ? p.loaded / p.total : 1;
              this._notify();
              callbacks?.onProgress?.(p);
              continue;
            }

            p.currentAsset = key;
            p.currentGroup = entry.group ?? null;
            this._notify();
            callbacks?.onProgress?.(p);

            try {
              await this._loadWithRetry(
                entry.url,
                key,
                type,
                entry.loaderOptions ?? {},
              );
            } catch (err) {
              p.errors.push({
                key,
                url: entry.url,
                message:
                  err instanceof Error ? err.message : String(err),
                retries: this._retries,
                recoverable: false,
              });
            }

            p.loaded++;
            p.progress = p.total > 0 ? p.loaded / p.total : 1;
            this._notify();
            callbacks?.onProgress?.(p);
          }
        })(),
      );
    }

    await Promise.all(workers);

    // Finalize
    p.phase = p.errors.length > 0 ? "error" : "complete";
    p.currentAsset = null;
    p.currentGroup = null;
    this._notify();
    callbacks?.onProgress?.(p);

    if (p.errors.length > 0) callbacks?.onError?.(p.errors);
    callbacks?.onComplete?.();
  }

  // ── Load Group ──────────────────────────────────────────────────────────────

  /**
   * Load all assets in a named group.
   * Only works for groups that were registered via a previous loadManifest call.
   */
  async loadGroup(name: string): Promise<void> {
    const keys = this._groups.get(name);
    if (!keys) return;
    const toLoad: AssetEntry[] = [];
    for (const key of keys) {
      if (!this.has(key)) {
        const type = detectAssetType(key);
        if (type) toLoad.push({ url: key, key, type });
      }
    }
    if (toLoad.length === 0) return;
    await this.loadManifest(toLoad);
  }

  // ── Retry Logic ─────────────────────────────────────────────────────────────

  private _loadWithRetry(
    url: string,
    key: string,
    type: AssetType,
    options: Record<string, unknown>,
  ): Promise<unknown> {
    // Cache hit
    const cached = this._cache.get(key);
    if (cached) return Promise.resolve(cached.data);

    // Deduplicate in-flight loads
    const existing = this._activeLoads.get(key);
    if (existing) return existing;

    const promise = this._executeLoad(url, key, type, options);
    this._activeLoads.set(key, promise);
    return promise.finally(() => this._activeLoads.delete(key));
  }

  private async _executeLoad(
    url: string,
    key: string,
    type: AssetType,
    options: Record<string, unknown>,
  ): Promise<unknown> {
    const loader = this._customLoaders.get(type) ?? _loaders[type];
    if (!loader)
      throw new Error(`[CarverJS] No loader registered for type "${type}"`);

    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= this._retries; attempt++) {
      try {
        const result = await Promise.race([
          loader(url, options),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Timeout loading "${url}"`)),
              this._timeout,
            ),
          ),
        ]);

        // Cache the result
        const sizeBytes = estimateSize(result, type);
        this._evictIfNeeded(sizeBytes);
        this._cache.set(key, {
          data: result,
          key,
          type,
          sizeBytes,
          lastAccessedAt: Date.now(),
          refCount: 0,
        });
        this._totalBytes += sizeBytes;

        return result;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < this._retries) {
          // Exponential backoff with jitter
          const delay =
            this._retryDelay *
            Math.pow(2, attempt) *
            (0.5 + Math.random());
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastErr;
  }

  // ── Manifest Parsing ────────────────────────────────────────────────────────

  private _parseManifest(input: AssetManifest | AssetEntry[]): AssetEntry[] {
    const manifest: AssetManifest = Array.isArray(input)
      ? { assets: input }
      : input;
    const base = manifest.baseUrl ?? "";

    return manifest.assets.map((entry) => {
      const isAbsolute =
        entry.url.startsWith("http") ||
        entry.url.startsWith("/") ||
        entry.url.startsWith("data:");
      const url = isAbsolute ? entry.url : base + entry.url;
      return { ...entry, url, key: entry.key ?? url };
    });
  }

  // ── Cache Eviction (LRU with reference counting) ────────────────────────────

  private _evictIfNeeded(neededBytes: number): void {
    while (
      this._totalBytes + neededBytes > this._maxBytes &&
      this._cache.size > 0
    ) {
      let oldest: CacheEntry | null = null;
      for (const entry of this._cache.values()) {
        if (entry.refCount > 0) continue;
        if (!oldest || entry.lastAccessedAt < oldest.lastAccessedAt) {
          oldest = entry;
        }
      }
      if (!oldest) break; // All entries are retained — cannot evict
      disposeAsset(oldest.data, oldest.type);
      this._totalBytes -= oldest.sizeBytes;
      this._cache.delete(oldest.key);
    }
  }

  // ── Cache Management ────────────────────────────────────────────────────────

  /** Unload a specific asset, freeing memory. Three.js resources are disposed. */
  unload(key: string): void {
    const entry = this._cache.get(key);
    if (!entry) return;
    disposeAsset(entry.data, entry.type);
    this._totalBytes -= entry.sizeBytes;
    this._cache.delete(key);
  }

  /** Unload all assets in a group. */
  unloadGroup(group: string): void {
    const keys = this._groups.get(group);
    if (!keys) return;
    for (const key of keys) this.unload(key);
    this._groups.delete(group);
  }

  /** Clear all cached assets. */
  clearAll(): void {
    for (const entry of this._cache.values()) {
      disposeAsset(entry.data, entry.type);
    }
    this._cache.clear();
    this._groups.clear();
    this._totalBytes = 0;
  }

  /** Get current memory usage estimate in bytes. */
  getMemoryUsage(): number {
    return this._totalBytes;
  }

  // ── Reference Counting ──────────────────────────────────────────────────────

  /** Increment reference count. Assets with refCount > 0 are never evicted. */
  retain(key: string): void {
    const entry = this._cache.get(key);
    if (entry) entry.refCount++;
  }

  /** Decrement reference count. */
  release(key: string): void {
    const entry = this._cache.get(key);
    if (entry && entry.refCount > 0) entry.refCount--;
  }

  // ── Custom Loaders ──────────────────────────────────────────────────────────

  /** Register a custom loader for an asset type. Overrides built-in loaders. */
  registerLoader(
    type: string,
    loader: (
      url: string,
      options: Record<string, unknown>,
    ) => Promise<unknown>,
  ): void {
    this._customLoaders.set(type, loader);
  }

  // ── Preload Helpers ─────────────────────────────────────────────────────────

  /** Fire-and-forget preload for one or more URLs. */
  preload(urls: string | string[]): void {
    const list = Array.isArray(urls) ? urls : [urls];
    for (const url of list) {
      if (!this.has(url) && !this.isLoading(url)) {
        this.load(url).catch(() => {});
      }
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  destroy(): void {
    this.clearAll();
    this._activeLoads.clear();
    this._customLoaders.clear();
    this._subscribers.clear();

    const p = this._progress;
    p.phase = "idle";
    p.loaded = 0;
    p.total = 0;
    p.progress = 0;
    p.currentAsset = null;
    p.currentGroup = null;
    p.errors = [];
  }
}

// ── Singleton accessor (same pattern as AudioManager, InputManager) ─────────

let _instance: AssetManager | null = null;

export function getAssetManager(): AssetManager {
  if (!_instance) _instance = new AssetManager();
  return _instance;
}

export function destroyAssetManager(): void {
  _instance?.destroy();
  _instance = null;
}
