import type { ComponentType } from "react";

// ─── Scene Lifecycle ─────────────────────────────────────────────────────────

/** States a scene can be in */
export type SceneStatus =
  | "created"       // Registered but not yet started
  | "preloading"    // Lazy loading in progress (Suspense)
  | "running"       // Active, visible, receiving updates
  | "paused"        // Mounted and visible but updates disabled
  | "sleeping"      // Mounted but hidden, updates disabled, preserves state
  | "shutting_down"  // Transitioning out
  | "destroyed";    // Unmounted and cleaned up

// ─── Transition Types ────────────────────────────────────────────────────────

export type TransitionType = "none" | "fade" | "custom";

export interface TransitionConfig {
  /** Transition type. Default: "none" */
  type?: TransitionType;
  /** Duration in seconds. Default: 0.5 */
  duration?: number;
  /** Color for fade transition. Default: "#000000" */
  color?: string;
  /** Custom fragment shader source. Receives uniform float uProgress (0-1). */
  fragmentShader?: string;
  /** Custom vertex shader source. Default: passthrough NDC quad. */
  vertexShader?: string;
  /** Additional uniforms for custom shaders. */
  uniforms?: Record<string, { value: unknown }>;
}

export interface TransitionState {
  active: boolean;
  from: string | null;
  to: string | null;
  progress: number;
  config: TransitionConfig;
  /** Whether the scene swap has occurred (at midpoint) */
  swapped: boolean;
  /** Stack to apply at midpoint (when fade is opaque, so HTML overlay switch is invisible) */
  targetStack: string[] | null;
}

// ─── Scene Configuration ─────────────────────────────────────────────────────

export interface SceneConfig<TData = unknown> {
  /** Unique scene name */
  name: string;
  /** React component to render as scene content */
  component?: ComponentType<{ data?: TData }>;
  /** Lazy loader for code-splitting */
  loader?: () => Promise<{ default: ComponentType<{ data?: TData }> }>;
  /** Default transition when navigating TO this scene */
  transition?: TransitionConfig;
  /** Keep scene mounted when not active (sleep instead of destroy). Default: false */
  persistent?: boolean;
}

// ─── Scene Runtime State ─────────────────────────────────────────────────────

export interface SceneEntry {
  config: SceneConfig;
  status: SceneStatus;
  data: unknown;
}

// ─── Scene Store ─────────────────────────────────────────────────────────────

export interface SceneStoreState {
  /** All registered scenes */
  scenes: Map<string, SceneEntry>;
  /** Scene navigation stack. Last element = current active scene. */
  stack: string[];
  /** Active transition state */
  transition: TransitionState;
  /** Cross-scene shared data */
  shared: Record<string, unknown>;

  // ── Navigation Actions ──

  /** Navigate to a scene, clearing the stack */
  go: <TData = unknown>(
    name: string,
    data?: TData,
    transition?: TransitionConfig,
  ) => void;
  /** Push a scene onto the stack (current scene sleeps) */
  push: <TData = unknown>(
    name: string,
    data?: TData,
    transition?: TransitionConfig,
  ) => void;
  /** Pop the top scene, returning to the previous one */
  pop: (transition?: TransitionConfig) => void;
  /** Replace the current scene without changing stack depth */
  replace: <TData = unknown>(
    name: string,
    data?: TData,
    transition?: TransitionConfig,
  ) => void;

  // ── Shared Data ──

  /** Set shared cross-scene data */
  setShared: (key: string, value: unknown) => void;
  /** Get shared cross-scene data */
  getShared: <T = unknown>(key: string) => T | undefined;

  // ── Internal Actions ──

  /** Register a scene config. Called by <Scene> on mount. */
  _registerScene: (config: SceneConfig) => void;
  /** Unregister a scene. Called by <Scene> on unmount. */
  _unregisterScene: (name: string) => void;
  /** Update a scene's status */
  _setStatus: (name: string, status: SceneStatus) => void;
  /** Advance transition progress. Called per-frame by SceneTransitionFlush. */
  _tickTransition: (delta: number) => void;
  /** Start the initial scene (called once by SceneManager on mount) */
  _startInitial: (name: string) => void;
}

// ─── Hook Return Types ───────────────────────────────────────────────────────

export interface UseSceneReturn {
  /** Navigate to a named scene, clearing the stack */
  go: <TData = unknown>(
    name: string,
    data?: TData,
    transition?: TransitionConfig,
  ) => void;
  /** Push a scene onto the stack */
  push: <TData = unknown>(
    name: string,
    data?: TData,
    transition?: TransitionConfig,
  ) => void;
  /** Pop the top scene */
  pop: (transition?: TransitionConfig) => void;
  /** Replace the current scene */
  replace: <TData = unknown>(
    name: string,
    data?: TData,
    transition?: TransitionConfig,
  ) => void;
  /** Current active scene name */
  current: string | null;
  /** The full navigation stack */
  stack: readonly string[];
  /** Whether a transition is in progress */
  isTransitioning: boolean;
}

export interface UseSceneDataReturn<T = unknown> {
  /** Data passed to the current scene */
  data: T | undefined;
  /** Set shared cross-scene data */
  setShared: (key: string, value: unknown) => void;
  /** Get shared cross-scene data */
  getShared: <V = unknown>(key: string) => V | undefined;
}

export interface UseSceneTransitionReturn {
  /** Whether a transition is active */
  active: boolean;
  /** Transition progress 0-1 */
  progress: number;
  /** Source scene name */
  from: string | null;
  /** Target scene name */
  to: string | null;
}

export interface SceneLifecycleCallbacks {
  /** Called when scene transitions to "running" */
  onEnter?: () => void | (() => void);
  /** Called when scene leaves "running" (sleep, pause, or destroy) */
  onExit?: () => void;
  /** Called when scene transitions to "sleeping" */
  onSleep?: () => void;
  /** Called when scene transitions from "sleeping" to "running" */
  onWake?: () => void;
  /** Called when scene transitions to "paused" */
  onPause?: () => void;
  /** Called when scene transitions from "paused" to "running" */
  onResume?: () => void;
}
