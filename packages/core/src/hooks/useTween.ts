import { useRef, useEffect, useCallback } from "react";
import { getTweenManager } from "../systems/TweenManager";
import type {
  TweenConfig,
  NumberTweenConfig,
  TimelineConfig,
  TweenControls,
  TimelineControls,
  UseTweenReturn,
} from "../types";

export function useTween(): UseTweenReturn {
  // Track all tween IDs created by this hook instance for cleanup
  const ownedIdsRef = useRef<Set<number>>(new Set());

  // Cleanup on unmount: kill all tweens created by this hook
  useEffect(() => {
    return () => {
      const mgr = getTweenManager();
      for (const id of ownedIdsRef.current) {
        mgr.killById(id);
      }
      ownedIdsRef.current.clear();
    };
  }, []);

  const tween = useCallback(
    <T extends object>(config: TweenConfig<T>): TweenControls => {
      const controls = getTweenManager().create(config);
      ownedIdsRef.current.add(controls.id);
      return controls;
    },
    [],
  );

  const tweenNumber = useCallback(
    (config: NumberTweenConfig): TweenControls => {
      const controls = getTweenManager().createNumber(config);
      ownedIdsRef.current.add(controls.id);
      return controls;
    },
    [],
  );

  const timeline = useCallback(
    (config?: TimelineConfig): TimelineControls => {
      return getTweenManager().createTimeline(config);
    },
    [],
  );

  const killAll = useCallback(() => {
    const mgr = getTweenManager();
    for (const id of ownedIdsRef.current) {
      mgr.killById(id);
    }
    ownedIdsRef.current.clear();
  }, []);

  const pauseAll = useCallback(() => {
    // Note: pauseAll only affects tweens still in the active list
    // Completed/killed tweens are safely skipped by killById
    getTweenManager().pauseAll();
  }, []);

  const resumeAll = useCallback(() => {
    getTweenManager().resumeAll();
  }, []);

  // Stable return object (same pattern as useCollision)
  const returnRef = useRef<UseTweenReturn>({
    tween: null!,
    tweenNumber: null!,
    timeline: null!,
    killAll: null!,
    pauseAll: null!,
    resumeAll: null!,
  });

  returnRef.current.tween = tween;
  returnRef.current.tweenNumber = tweenNumber;
  returnRef.current.timeline = timeline;
  returnRef.current.killAll = killAll;
  returnRef.current.pauseAll = pauseAll;
  returnRef.current.resumeAll = resumeAll;

  return returnRef.current;
}
