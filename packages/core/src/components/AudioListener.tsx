import { useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { getAudioManager } from "../systems/AudioManager";
import type { AudioListenerConfig } from "../types";

/**
 * Optional component that overrides the audio listener position.
 * By default the listener follows the active R3F camera. Mount this
 * component to follow a different Object3D (e.g., a player ref).
 *
 * Place inside a <World> (must be a child of <Canvas>).
 */
export function AudioListener({ listenerRef }: AudioListenerConfig) {
  // Update custom listener from ref each frame (before AudioFlush at -48)
  useFrame(() => {
    getAudioManager().setCustomListener(listenerRef?.current ?? null);
  }, -49);

  // Clear override on unmount (falls back to camera)
  useEffect(() => {
    return () => {
      getAudioManager().setCustomListener(null);
    };
  }, []);

  return null;
}
