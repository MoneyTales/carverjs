import { useMemo, useEffect } from "react";
import { Canvas, useFrame, useThree, type CanvasProps } from "@react-three/fiber";
import { Sky, Environment } from "@react-three/drei";
import { useGameStore } from "../store/gameStore";
import { getInputManager, destroyInputManager } from "../systems/InputManager";
import {
  getCollisionManager,
  destroyCollisionManager,
} from "../systems/CollisionManager";
import {
  getAudioManager,
  destroyAudioManager,
} from "../systems/AudioManager";
import {
  getTweenManager,
  destroyTweenManager,
} from "../systems/TweenManager";
import {
  getParticleManager,
  destroyParticleManager,
} from "../systems/ParticleManager";
import { GameContext, useGameContext, type GameContextValue } from "./GameContext";
import type {
  WorldMode,
  SkyProps,
  EnvironmentProps,
  AmbientLightProps,
  DirectionalLightProps,
} from "../types";

const MAX_DELTA = 0.1;

/** Internal master clock — increments store elapsed once per frame at priority -5 */
function GameLoopTick() {
  useFrame((_, rawDelta) => {
    useGameStore.getState()._tick(Math.min(rawDelta, MAX_DELTA));
  }, -5);
  return null;
}

/** Runs built-in collision detection at priority -25 (after fixedUpdate, before update) */
function CollisionFlush() {
  const { mode } = useGameContext();

  useEffect(() => {
    getCollisionManager().setMode(mode);
  }, [mode]);

  useEffect(() => {
    return () => destroyCollisionManager();
  }, []);

  useFrame(() => {
    getCollisionManager().tick();
  }, -25);

  return null;
}

/** Initializes AudioManager, syncs listener to camera, and flushes audio state per frame */
function AudioFlush() {
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    const mgr = getAudioManager();
    mgr.init();
    return () => destroyAudioManager();
  }, []);

  // Sync listener to active camera
  useEffect(() => {
    getAudioManager().setListenerSource(camera);
  }, [camera]);

  useFrame(() => {
    getAudioManager().flush(useGameStore.getState().phase);
  }, -48);

  return null;
}

/** Advances all active tweens/timelines at priority -15 (after update, before lateUpdate) */
function TweenFlush() {
  useEffect(() => {
    return () => destroyTweenManager();
  }, []);

  useFrame((_, rawDelta) => {
    getTweenManager().tick(Math.min(rawDelta, MAX_DELTA));
  }, -15);

  return null;
}

/** Updates all particle emitters at priority -12 (after tweens, before lateUpdate) */
function ParticleFlush() {
  const { mode } = useGameContext();

  useEffect(() => {
    getParticleManager().setMode(mode);
  }, [mode]);

  useEffect(() => {
    return () => destroyParticleManager();
  }, []);

  useFrame((_, rawDelta) => {
    const { phase } = useGameStore.getState();
    if (phase === "loading" || phase === "paused") return;
    getParticleManager().tick(Math.min(rawDelta, MAX_DELTA));
  }, -12);

  return null;
}

/** Attaches InputManager to the canvas and flushes per-frame state before all game logic */
function InputFlush() {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const mgr = getInputManager();
    mgr.attach(gl.domElement);
    return () => destroyInputManager();
  }, [gl.domElement]);

  useFrame(() => {
    getInputManager().flush();
  }, -50);

  return null;
}

export interface GameProps extends Omit<CanvasProps, "camera"> {
  /** Scene mode — controls default camera, lighting, and features in child Worlds. Default: "3d" */
  mode?: WorldMode;
  /** Overrides for the ambient light */
  ambientLightProps?: AmbientLightProps;
  /** Overrides for the directional light (3D only) */
  directionalLightProps?: DirectionalLightProps;
  /** Overrides for the Sky (3D only) */
  skyProps?: SkyProps;
  /** Overrides for the Environment (3D only) */
  environmentProps?: EnvironmentProps;
}

export function Game({
  mode = "3d",
  ambientLightProps,
  directionalLightProps,
  skyProps,
  environmentProps,
  children,
  ...canvasProps
}: GameProps) {
  const is2D = mode === "2d";

  const contextValue = useMemo<GameContextValue>(() => ({ mode }), [mode]);

  return (
    <Canvas shadows={!is2D} {...canvasProps}>
      <GameContext.Provider value={contextValue}>
        <GameLoopTick />
        <InputFlush />
        <CollisionFlush />
        <AudioFlush />
        <TweenFlush />
        <ParticleFlush />

        {/* Lighting */}
        <ambientLight intensity={is2D ? 1 : 0.4} {...ambientLightProps} />

        {!is2D && (
          <>
            <directionalLight
              position={[10, 15, 10]}
              intensity={1}
              castShadow
              shadow-mapSize-width={1024}
              shadow-mapSize-height={1024}
              {...directionalLightProps}
            />
            <Sky sunPosition={[100, 20, 100]} {...skyProps} />
            <Environment preset="sunset" background {...environmentProps} />
          </>
        )}

        {children}
      </GameContext.Provider>
    </Canvas>
  );
}
