import { useRef, useEffect, forwardRef } from "react";
import { useThree } from "@react-three/fiber";
import { getParticleManager } from "../systems/ParticleManager";
import { getParticlePreset } from "../systems/ParticlePresets";
import type { ParticleEmitterProps, ParticleEmitterConfig } from "../types";
import type { Group } from "three";

export const ParticleEmitter = forwardRef<Group, ParticleEmitterProps>(
  function ParticleEmitter(
    { preset, position, rotation, enabled = true, ...configOverrides },
    ref,
  ) {
    const scene = useThree((s) => s.scene);
    const groupRef = useRef<Group>(null);
    const emitterIdRef = useRef<string>("");

    // Merge preset + overrides once at mount
    const configRef = useRef<ParticleEmitterConfig | null>(null);
    if (configRef.current === null) {
      const base = preset ? getParticlePreset(preset) : {};
      configRef.current = { ...base, ...configOverrides };
    }

    // Combined ref forwarding
    const setRefs = (node: Group | null) => {
      (groupRef as React.MutableRefObject<Group | null>).current = node;
      if (typeof ref === "function") ref(node);
      else if (ref)
        (ref as React.MutableRefObject<Group | null>).current = node;
    };

    // Create emitter on mount
    useEffect(() => {
      const mgr = getParticleManager();
      const config = configRef.current!;
      const id = mgr.createEmitter(config);
      emitterIdRef.current = id;

      const emitter = mgr.getEmitter(id)!;
      emitter.source = groupRef.current;

      const space = config.space ?? "world";
      if (space === "world") {
        scene.add(emitter.mesh);
      } else if (groupRef.current) {
        groupRef.current.add(emitter.mesh);
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

    return <group ref={setRefs} position={position} rotation={rotation} />;
  },
);
