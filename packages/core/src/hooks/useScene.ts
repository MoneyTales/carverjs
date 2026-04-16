import { useRef, useEffect, useCallback } from "react";
import { useSceneStore } from "../store/sceneStore";
import type {
  UseSceneReturn,
  UseSceneDataReturn,
  UseSceneTransitionReturn,
  SceneLifecycleCallbacks,
  SceneStatus,
  TransitionConfig,
} from "../types";

// ── useScene ─────────────────────────────────────────────────────────────────

/** Primary hook for scene navigation. Can be called from any component inside <SceneManager>. */
export function useScene(): UseSceneReturn {
  const current = useSceneStore(
    (s) => s.stack[s.stack.length - 1] ?? null,
  );
  const stack = useSceneStore((s) => s.stack);
  const isTransitioning = useSceneStore((s) => s.transition.active);

  const go = useCallback(
    <TData = unknown>(
      name: string,
      data?: TData,
      transition?: TransitionConfig,
    ) => {
      useSceneStore.getState().go(name, data, transition);
    },
    [],
  );

  const push = useCallback(
    <TData = unknown>(
      name: string,
      data?: TData,
      transition?: TransitionConfig,
    ) => {
      useSceneStore.getState().push(name, data, transition);
    },
    [],
  );

  const pop = useCallback((transition?: TransitionConfig) => {
    useSceneStore.getState().pop(transition);
  }, []);

  const replace = useCallback(
    <TData = unknown>(
      name: string,
      data?: TData,
      transition?: TransitionConfig,
    ) => {
      useSceneStore.getState().replace(name, data, transition);
    },
    [],
  );

  return { go, push, pop, replace, current, stack, isTransitioning };
}

// ── useSceneData ─────────────────────────────────────────────────────────────

/** Access the data passed to the current scene and cross-scene shared data. */
export function useSceneData<T = unknown>(): UseSceneDataReturn<T> {
  const currentName = useSceneStore(
    (s) => s.stack[s.stack.length - 1] ?? null,
  );

  const data = useSceneStore((s) => {
    if (!currentName) return undefined;
    return s.scenes.get(currentName)?.data as T | undefined;
  });

  const setShared = useCallback((key: string, value: unknown) => {
    useSceneStore.getState().setShared(key, value);
  }, []);

  const getShared = useCallback(<V = unknown>(key: string): V | undefined => {
    return useSceneStore.getState().getShared<V>(key);
  }, []);

  return { data, setShared, getShared };
}

// ── useSceneTransition ───────────────────────────────────────────────────────

/** Read-only transition status for UI effects (e.g., dim during transition). */
export function useSceneTransition(): UseSceneTransitionReturn {
  const active = useSceneStore((s) => s.transition.active);
  const progress = useSceneStore((s) => s.transition.progress);
  const from = useSceneStore((s) => s.transition.from);
  const to = useSceneStore((s) => s.transition.to);

  return { active, progress, from, to };
}

// ── useSceneLifecycle ────────────────────────────────────────────────────────

/**
 * Register lifecycle callbacks for a specific scene.
 * Uses the callback-ref pattern so the latest closures are always called
 * without re-subscribing to the store.
 *
 * Must be called inside a scene component rendered by <SceneManager>.
 */
export function useSceneLifecycle(
  sceneName: string,
  callbacks: SceneLifecycleCallbacks,
): void {
  // Callback-ref pattern — always calls the latest closure
  const callbacksRef = useRef<SceneLifecycleCallbacks>(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  const prevStatusRef = useRef<SceneStatus | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const unsub = useSceneStore.subscribe((state) => {
      const entry = state.scenes.get(sceneName);
      if (!entry) return;

      const prev = prevStatusRef.current;
      const next = entry.status;

      // No change
      if (prev === next) return;
      prevStatusRef.current = next;

      const cbs = callbacksRef.current;

      // Entering "running"
      if (next === "running" && prev !== "running") {
        if (prev === "sleeping") {
          cbs.onWake?.();
        } else if (prev === "paused") {
          cbs.onResume?.();
        } else {
          // First time entering running (from created/preloading)
          const result = cbs.onEnter?.();
          if (typeof result === "function") {
            cleanupRef.current = result;
          }
        }
      }

      // Leaving "running"
      if (prev === "running" && next !== "running") {
        cbs.onExit?.();
      }

      // Entering specific states
      if (next === "sleeping" && prev !== "sleeping") {
        cbs.onSleep?.();
      }

      if (next === "paused" && prev !== "paused") {
        cbs.onPause?.();
      }

      // Destroyed — run onEnter cleanup
      if (next === "destroyed") {
        cleanupRef.current?.();
        cleanupRef.current = null;
      }
    });

    return () => {
      unsub();
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [sceneName]);
}
