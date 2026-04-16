import { create } from "zustand";
import type {
  SceneStoreState,
  SceneConfig,
  SceneEntry,
  SceneStatus,
  TransitionConfig,
  TransitionState,
} from "../types";

const DEFAULT_TRANSITION: TransitionState = {
  active: false,
  from: null,
  to: null,
  progress: 0,
  config: { type: "none" },
  swapped: false,
  targetStack: null,
};

function resolveTransition(
  config: TransitionConfig | undefined,
  sceneConfig: SceneConfig | undefined,
): TransitionConfig {
  // Explicit transition > scene default transition > instant
  return config ?? sceneConfig?.transition ?? { type: "none" };
}

export const useSceneStore = create<SceneStoreState>()((set, get) => ({
  scenes: new Map<string, SceneEntry>(),
  stack: [],
  transition: { ...DEFAULT_TRANSITION },
  shared: {},

  // ── Navigation Actions ────────────────────────────────────────────────────

  go: (name, data, transition) => {
    const state = get();
    const entry = state.scenes.get(name);
    if (!entry) {
      console.warn(`[CarverJS Scene] Scene "${name}" is not registered`);
      return;
    }

    // Don't navigate if already transitioning
    if (state.transition.active) return;

    const currentName = state.stack[state.stack.length - 1] ?? null;
    const resolved = resolveTransition(transition, entry.config);

    if (resolved.type === "none") {
      // Instant swap
      _exitStack(state, set);
      entry.status = "running";
      entry.data = data;
      set({
        scenes: new Map(state.scenes),
        stack: [name],
      });
      return;
    }

    // Start transition
    if (currentName) {
      const current = state.scenes.get(currentName);
      if (current) current.status = "shutting_down";
    }

    entry.data = data;

    set({
      scenes: new Map(state.scenes),
      transition: {
        active: true,
        from: currentName,
        to: name,
        progress: 0,
        config: resolved,
        swapped: false,
        targetStack: [name],
      },
    });
  },

  push: (name, data, transition) => {
    const state = get();
    const entry = state.scenes.get(name);
    if (!entry) {
      console.warn(`[CarverJS Scene] Scene "${name}" is not registered`);
      return;
    }

    if (state.transition.active) return;

    const currentName = state.stack[state.stack.length - 1] ?? null;
    const resolved = resolveTransition(transition, entry.config);

    if (resolved.type === "none") {
      // Instant push
      if (currentName) {
        const current = state.scenes.get(currentName);
        if (current) current.status = "sleeping";
      }
      entry.status = "running";
      entry.data = data;
      set({
        scenes: new Map(state.scenes),
        stack: [...state.stack, name],
      });
      return;
    }

    // Start transition
    if (currentName) {
      const current = state.scenes.get(currentName);
      if (current) current.status = "shutting_down";
    }

    entry.data = data;

    set({
      scenes: new Map(state.scenes),
      stack: [...state.stack, name],
      transition: {
        active: true,
        from: currentName,
        to: name,
        progress: 0,
        config: resolved,
        swapped: false,
        targetStack: null,
      },
    });
  },

  pop: (transition) => {
    const state = get();
    if (state.stack.length <= 1) return;
    if (state.transition.active) return;

    const currentName = state.stack[state.stack.length - 1];
    const previousName = state.stack[state.stack.length - 2];
    const currentEntry = state.scenes.get(currentName);
    const previousEntry = state.scenes.get(previousName);

    const resolved = resolveTransition(
      transition,
      previousEntry?.config,
    );

    if (resolved.type === "none") {
      // Instant pop
      _destroyOrSleep(currentEntry);
      if (previousEntry) previousEntry.status = "running";
      set({
        scenes: new Map(state.scenes),
        stack: state.stack.slice(0, -1),
      });
      return;
    }

    // Start transition
    if (currentEntry) currentEntry.status = "shutting_down";

    set({
      scenes: new Map(state.scenes),
      transition: {
        active: true,
        from: currentName,
        to: previousName,
        progress: 0,
        config: resolved,
        swapped: false,
        targetStack: state.stack.slice(0, -1),
      },
    });
  },

  replace: (name, data, transition) => {
    const state = get();
    const entry = state.scenes.get(name);
    if (!entry) {
      console.warn(`[CarverJS Scene] Scene "${name}" is not registered`);
      return;
    }

    if (state.transition.active) return;

    const currentName = state.stack[state.stack.length - 1] ?? null;
    const resolved = resolveTransition(transition, entry.config);

    if (resolved.type === "none") {
      // Instant replace
      if (currentName) {
        const current = state.scenes.get(currentName);
        _destroyOrSleep(current);
      }
      entry.status = "running";
      entry.data = data;
      const newStack = [...state.stack];
      if (newStack.length > 0) {
        newStack[newStack.length - 1] = name;
      } else {
        newStack.push(name);
      }
      set({
        scenes: new Map(state.scenes),
        stack: newStack,
      });
      return;
    }

    // Start transition
    if (currentName) {
      const current = state.scenes.get(currentName);
      if (current) current.status = "shutting_down";
    }

    entry.data = data;

    const newStack = [...state.stack];
    if (newStack.length > 0) {
      newStack[newStack.length - 1] = name;
    } else {
      newStack.push(name);
    }

    set({
      scenes: new Map(state.scenes),
      stack: newStack,
      transition: {
        active: true,
        from: currentName,
        to: name,
        progress: 0,
        config: resolved,
        swapped: false,
        targetStack: null,
      },
    });
  },

  // ── Shared Data ───────────────────────────────────────────────────────────

  setShared: (key, value) => {
    set((s) => ({ shared: { ...s.shared, [key]: value } }));
  },

  getShared: <T = unknown>(key: string): T | undefined => {
    return get().shared[key] as T | undefined;
  },

  // ── Internal Actions ──────────────────────────────────────────────────────

  _registerScene: (config: SceneConfig) => {
    const state = get();
    const existing = state.scenes.get(config.name);

    // Idempotent: update config if already registered, preserve runtime state
    if (existing) {
      existing.config = config;
      set({ scenes: new Map(state.scenes) });
      return;
    }

    const entry: SceneEntry = {
      config,
      status: "created",
      data: undefined,
    };
    state.scenes.set(config.name, entry);
    set({ scenes: new Map(state.scenes) });
  },

  _unregisterScene: (name: string) => {
    const state = get();
    state.scenes.delete(name);
    set({
      scenes: new Map(state.scenes),
      stack: state.stack.filter((s) => s !== name),
    });
  },

  _setStatus: (name: string, status: SceneStatus) => {
    const state = get();
    const entry = state.scenes.get(name);
    if (!entry) return;
    entry.status = status;
    set({ scenes: new Map(state.scenes) });
  },

  _tickTransition: (delta: number) => {
    const state = get();
    const t = state.transition;
    if (!t.active || !t.to) return;

    const duration = t.config.duration ?? 0.5;
    const newProgress = Math.min(t.progress + delta / duration, 1);

    // Midpoint swap: at progress >= 0.5, swap scene visibility
    if (!t.swapped && newProgress >= 0.5) {
      const fromEntry = t.from ? state.scenes.get(t.from) : null;
      const toEntry = state.scenes.get(t.to);

      // Handle "from" scene
      if (fromEntry) {
        // For "go" and "replace": check if this is a go/replace (from not in new stack)
        // For "push": from scene sleeps
        // For "pop": from scene gets destroyed/slept
        _destroyOrSleep(fromEntry);
      }

      // Activate "to" scene
      if (toEntry) {
        toEntry.status = "running";
      }

      // Apply the target stack at midpoint (when fade is fully opaque,
      // so HTML overlay switches are invisible to the user)
      const updates: Partial<SceneStoreState> = {
        scenes: new Map(state.scenes),
        transition: { ...t, progress: newProgress, swapped: true },
      };
      if (t.targetStack) {
        updates.stack = t.targetStack;
      }

      set(updates);
      return;
    }

    // Transition complete
    if (newProgress >= 1) {
      set({
        transition: { ...DEFAULT_TRANSITION },
      });
      return;
    }

    // Normal progress update (avoid set() for minor numeric changes — use direct mutation + set)
    set({
      transition: { ...t, progress: newProgress },
    });
  },

  _startInitial: (name: string) => {
    const state = get();
    const entry = state.scenes.get(name);
    if (!entry) {
      console.warn(`[CarverJS Scene] Initial scene "${name}" is not registered`);
      return;
    }
    entry.status = "running";
    set({
      scenes: new Map(state.scenes),
      stack: [name],
    });
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Destroy or sleep a scene entry based on its persistent config */
function _destroyOrSleep(entry: SceneEntry | undefined): void {
  if (!entry) return;
  entry.status = entry.config.persistent ? "sleeping" : "destroyed";
}

/** Exit all scenes in the current stack */
function _exitStack(
  state: SceneStoreState,
  set: (partial: Partial<SceneStoreState>) => void,
): void {
  for (const name of state.stack) {
    const entry = state.scenes.get(name);
    _destroyOrSleep(entry);
  }
  set({ scenes: new Map(state.scenes) });
}
