import { create } from "zustand";
import type { GamePhase } from "../types";

export interface GameStoreState {
  /** Current game phase */
  phase: GamePhase;
  /** Total elapsed time in seconds (only increments while playing) */
  elapsed: number;
  /** Number of frames rendered while playing */
  frameCount: number;

  // ── Actions ──
  setPhase: (phase: GamePhase) => void;
  /** Internal — called by GameLoopTick once per frame. Do not call manually. */
  _tick: (delta: number) => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
}

export const useGameStore = create<GameStoreState>()((set, get) => ({
  phase: "loading" as GamePhase,
  elapsed: 0,
  frameCount: 0,

  setPhase: (phase) => set({ phase }),

  _tick: (delta) => {
    if (get().phase !== "playing") return;
    set((s) => ({
      elapsed: s.elapsed + delta,
      frameCount: s.frameCount + 1,
    }));
  },

  pause: () => {
    if (get().phase === "playing") set({ phase: "paused" });
  },

  resume: () => {
    if (get().phase === "paused") set({ phase: "playing" });
  },

  reset: () => set({ phase: "playing", elapsed: 0, frameCount: 0 }),
}));
