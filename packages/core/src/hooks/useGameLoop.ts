import { useRef, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { useGameStore } from "../store/gameStore";
import type {
  UseGameLoopOptions,
  UseGameLoopReturn,
  GameLoopCallback,
  GameLoopStage,
} from "../types";

// Negative priorities = ordering only, R3F auto-render still fires at priority 0
// R3F useFrame executes in ascending priority order (lowest number first).
// earlyUpdate(-40) → fixedUpdate(-30) → update(-20) → lateUpdate(-10) → GameLoopTick(-5) → render(0)
const STAGE_PRIORITY: Record<GameLoopStage, number> = {
  earlyUpdate: -40,
  fixedUpdate: -30,
  update: -20,
  lateUpdate: -10,
};

const DEFAULT_FIXED_DELTA = 1 / 60;
const DEFAULT_MAX_DELTA = 0.1;

export function useGameLoop(
  callback: GameLoopCallback,
  options: UseGameLoopOptions = {}
): UseGameLoopReturn {
  const {
    stage = "update",
    fixedTimestep = false,
    fixedDelta = DEFAULT_FIXED_DELTA,
    maxDelta = DEFAULT_MAX_DELTA,
    enabled = true,
  } = options;

  // Callback ref pattern — always calls the latest closure without re-registering useFrame
  const callbackRef = useRef<GameLoopCallback>(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // Fixed-timestep accumulator (pre-allocated, no GC pressure per frame)
  const accumulatorRef = useRef(0);

  useFrame((_, rawDelta) => {
    if (!enabledRef.current) return;

    // Read store via getState() — zero React re-renders
    const { phase, elapsed } = useGameStore.getState();
    if (phase !== "playing") return;

    // Cap delta to prevent spiral-of-death after tab switches
    const delta = Math.min(rawDelta, maxDelta);

    if (fixedTimestep && stage === "fixedUpdate") {
      // Gaffer on Games fixed timestep with accumulator
      accumulatorRef.current += delta;
      let localElapsed = elapsed;

      while (accumulatorRef.current >= fixedDelta) {
        callbackRef.current(fixedDelta, localElapsed);
        accumulatorRef.current -= fixedDelta;
        localElapsed += fixedDelta;
      }
    } else {
      // Variable timestep (default)
      callbackRef.current(delta, elapsed);
    }
  }, STAGE_PRIORITY[stage]);

  // Return values use React subscriptions — phase changes are infrequent, safe to re-render
  const phase = useGameStore((s) => s.phase);
  const elapsed = useGameStore((s) => s.elapsed);

  return {
    phase,
    isPaused: phase === "paused" || phase === "gameover",
    elapsed,
  };
}
