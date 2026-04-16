import { useRef, useEffect, useCallback } from "react";
import { useThree } from "@react-three/fiber";
import { getParticleManager } from "../systems/ParticleManager";
import { getParticlePreset } from "../systems/ParticlePresets";
import type {
  UseParticlesOptions,
  UseParticlesReturn,
  ParticleEmitterConfig,
} from "../types";
import type { Object3D } from "three";

export function useParticles(options: UseParticlesOptions): UseParticlesReturn {
  const { preset, enabled = true, ...configOverrides } = options;

  const scene = useThree((s) => s.scene);
  const emitterIdRef = useRef<string>("");
  const sourceRef = useRef<Object3D | null>(null);

  // Merge preset with overrides once at mount
  const configRef = useRef<ParticleEmitterConfig | null>(null);
  if (configRef.current === null) {
    const base = preset ? getParticlePreset(preset) : {};
    configRef.current = { ...base, ...configOverrides };
  }

  // Create emitter on mount, destroy on unmount
  useEffect(() => {
    const mgr = getParticleManager();
    const config = configRef.current!;
    const id = mgr.createEmitter(config);
    emitterIdRef.current = id;

    const emitter = mgr.getEmitter(id)!;

    // Attach source ref (populated by R3F before effects run)
    emitter.source = sourceRef.current;

    // Add mesh to scene graph
    const space = config.space ?? "world";
    if (space === "world") {
      scene.add(emitter.mesh);
    } else if (sourceRef.current) {
      sourceRef.current.add(emitter.mesh);
    }

    return () => {
      mgr.destroyEmitter(id);
      emitterIdRef.current = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  // Handle enabled toggle
  useEffect(() => {
    const emitter = getParticleManager().getEmitter(emitterIdRef.current);
    if (!emitter) return;
    if (enabled) emitter.start();
    else emitter.stop();
  }, [enabled]);

  // Imperative controls
  const burst = useCallback((count?: number) => {
    getParticleManager().getEmitter(emitterIdRef.current)?.burst(count);
  }, []);

  const start = useCallback(() => {
    getParticleManager().getEmitter(emitterIdRef.current)?.start();
  }, []);

  const stop = useCallback(() => {
    getParticleManager().getEmitter(emitterIdRef.current)?.stop();
  }, []);

  const clear = useCallback(() => {
    getParticleManager().getEmitter(emitterIdRef.current)?.clear();
  }, []);

  const setRate = useCallback((rate: number) => {
    getParticleManager().getEmitter(emitterIdRef.current)?.setRate(rate);
  }, []);

  const getActiveCount = useCallback(() => {
    return (
      getParticleManager().getEmitter(emitterIdRef.current)?.getActiveCount() ??
      0
    );
  }, []);

  const isEmitting = useCallback(() => {
    return (
      getParticleManager().getEmitter(emitterIdRef.current)?.isEmitting() ??
      false
    );
  }, []);

  const reset = useCallback(() => {
    getParticleManager().getEmitter(emitterIdRef.current)?.reset();
  }, []);

  // Stable return object (same pattern as useCollision, useTween)
  const returnRef = useRef<UseParticlesReturn>({
    ref: sourceRef,
    burst: null!,
    start: null!,
    stop: null!,
    clear: null!,
    setRate: null!,
    getActiveCount: null!,
    isEmitting: null!,
    reset: null!,
  });

  returnRef.current.burst = burst;
  returnRef.current.start = start;
  returnRef.current.stop = stop;
  returnRef.current.clear = clear;
  returnRef.current.setRate = setRate;
  returnRef.current.getActiveCount = getActiveCount;
  returnRef.current.isEmitting = isEmitting;
  returnRef.current.reset = reset;

  return returnRef.current;
}
