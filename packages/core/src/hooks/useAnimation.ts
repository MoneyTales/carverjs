import { useRef, useEffect, useCallback } from "react";
import { useAnimations } from "@react-three/drei";
import {
  AnimationClip,
  AnimationAction,
  AnimationMixer,
  LoopRepeat,
  LoopOnce,
} from "three";
import type { Object3D } from "three";

export interface UseAnimationOptions {
  clipName?: string;
  paused?: boolean;
  speed?: number;
  loop?: boolean;
}

export interface UseAnimationReturn {
  ref: React.RefObject<Object3D | undefined | null>;
  clipNames: string[];
  activeAction: AnimationAction | null;
  mixer: AnimationMixer;
  actions: Record<string, AnimationAction | null>;
  play: (name: string) => void;
  stopAll: () => void;
  crossFadeTo: (name: string, duration?: number) => void;
}

export function useAnimation(
  clips: AnimationClip[],
  options: UseAnimationOptions = {}
): UseAnimationReturn {
  const { clipName, paused = false, speed = 1, loop = true } = options;

  const { ref, mixer, actions, names } = useAnimations(clips);
  const previousAction = useRef<AnimationAction | null>(null);

  // Play/switch animation when clipName changes
  useEffect(() => {
    if (!clipName || !actions[clipName]) return;

    const action = actions[clipName]!;

    if (previousAction.current && previousAction.current !== action) {
      previousAction.current.fadeOut(0.2);
    }

    action.reset();
    action.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.fadeIn(0.2).play();
    previousAction.current = action;
  }, [clipName, actions, loop]);

  // Toggle pause
  useEffect(() => {
    if (previousAction.current) {
      previousAction.current.paused = paused;
    }
  }, [paused]);

  // Adjust playback speed
  useEffect(() => {
    mixer.timeScale = speed;
  }, [speed, mixer]);

  const play = useCallback(
    (name: string) => {
      const action = actions[name];
      if (!action) return;

      if (previousAction.current && previousAction.current !== action) {
        previousAction.current.fadeOut(0.2);
      }

      action.reset();
      action.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
      action.clampWhenFinished = !loop;
      action.fadeIn(0.2).play();
      previousAction.current = action;
    },
    [actions, loop]
  );

  const stopAll = useCallback(() => {
    mixer.stopAllAction();
    previousAction.current = null;
  }, [mixer]);

  const crossFadeTo = useCallback(
    (name: string, duration = 0.3) => {
      const action = actions[name];
      if (!action) return;

      if (previousAction.current) {
        previousAction.current.crossFadeTo(action, duration, true);
      }

      action.reset();
      action.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
      action.clampWhenFinished = !loop;
      action.play();
      previousAction.current = action;
    },
    [actions, loop]
  );

  return {
    ref,
    clipNames: names,
    activeAction: previousAction.current,
    mixer,
    actions,
    play,
    stopAll,
    crossFadeTo,
  };
}
