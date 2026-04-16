import { useSceneStore } from "../store/sceneStore";
import type { TransitionConfig } from "../types";

/**
 * Imperative scene navigation API for use outside React components.
 * Thin passthrough to the Zustand sceneStore — all state lives in the store.
 *
 * Follows the singleton pattern of InputManager / AudioManager.
 */
class SceneManagerImpl {
  /** Navigate to a scene, clearing the stack */
  go<TData = unknown>(
    name: string,
    data?: TData,
    transition?: TransitionConfig,
  ): void {
    useSceneStore.getState().go(name, data, transition);
  }

  /** Push a scene onto the stack (current scene sleeps) */
  push<TData = unknown>(
    name: string,
    data?: TData,
    transition?: TransitionConfig,
  ): void {
    useSceneStore.getState().push(name, data, transition);
  }

  /** Pop the top scene, returning to the previous one */
  pop(transition?: TransitionConfig): void {
    useSceneStore.getState().pop(transition);
  }

  /** Replace the current scene without changing stack depth */
  replace<TData = unknown>(
    name: string,
    data?: TData,
    transition?: TransitionConfig,
  ): void {
    useSceneStore.getState().replace(name, data, transition);
  }

  /** Get the current active scene name */
  getCurrent(): string | null {
    const stack = useSceneStore.getState().stack;
    return stack[stack.length - 1] ?? null;
  }

  /** Get the full navigation stack */
  getStack(): string[] {
    return useSceneStore.getState().stack;
  }

  /** Whether a transition is currently in progress */
  isTransitioning(): boolean {
    return useSceneStore.getState().transition.active;
  }

  /** Set shared cross-scene data */
  setShared(key: string, value: unknown): void {
    useSceneStore.getState().setShared(key, value);
  }

  /** Get shared cross-scene data */
  getShared<T = unknown>(key: string): T | undefined {
    return useSceneStore.getState().getShared<T>(key);
  }

  /** Reset the store (called on destroy) */
  destroy(): void {
    // Reset scene store to initial state
    useSceneStore.setState({
      scenes: new Map(),
      stack: [],
      transition: {
        active: false,
        from: null,
        to: null,
        progress: 0,
        config: { type: "none" },
        swapped: false,
        targetStack: null,
      },
      shared: {},
    });
  }
}

// ── Singleton accessor ──────────────────────────────────────────────────────

let _instance: SceneManagerImpl | null = null;

export function getSceneManager(): SceneManagerImpl {
  if (!_instance) _instance = new SceneManagerImpl();
  return _instance;
}

export function destroySceneManager(): void {
  _instance?.destroy();
  _instance = null;
}
