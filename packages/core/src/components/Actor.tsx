import React, { forwardRef, useMemo, useEffect, useRef, useCallback } from "react";
import {
  useGLTF,
  useTexture,
  SpriteAnimator,
  Billboard,
} from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { SkeletonUtils } from "three-stdlib";
import { Mesh, Group, RepeatWrapping, SpriteMaterial } from "three";
import type { ReactNode } from "react";
import type { ThreeElements } from "@react-three/fiber";
import type { SpriteAnimatorProps } from "@react-three/drei";
import type { ColorRepresentation } from "three";
import type {
  ActorTransformProps,
  ActorEventProps,
  ActorPhysicsProps,
  PrimitiveShape,
  PrimitiveMaterialType,
} from "../types";
import type { NetworkedConfig } from "../types/network";
import { useAnimation } from "../hooks/useAnimation";
import { PhysicsBodyWrapper } from "../systems/PhysicsProvider";
import { getActorRegistry } from "../systems/ActorRegistry";

// ─── Actor Props ─────────────────

interface ActorBaseProps extends ActorTransformProps, ActorEventProps {
  name?: string;
  userData?: Record<string, unknown>;
  visible?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  renderOrder?: number;
  /** Rapier physics properties. Only active when the parent World has a `physics` config. */
  physics?: ActorPhysicsProps;
  /** Enable networking for this actor. Pass `true` for defaults or a NetworkedConfig for fine control. */
  networked?: boolean | NetworkedConfig;
  children?: ReactNode;
}

export interface ModelActorProps extends ActorBaseProps {
  type: "model";
  src: string;
  useDraco?: boolean | string;
  useMeshopt?: boolean;
  animationName?: string;
  animationPaused?: boolean;
  animationSpeed?: number;
  animationLoop?: boolean;
}

export interface SpriteActorProps extends ActorBaseProps {
  type: "sprite";
  src: string;
  atlasUrl?: string;
  billboard?: boolean;
  billboardLockX?: boolean;
  billboardLockY?: boolean;
  billboardLockZ?: boolean;
  spriteAnimation?: Partial<
    Pick<
      SpriteAnimatorProps,
      | "startFrame"
      | "endFrame"
      | "fps"
      | "frameName"
      | "loop"
      | "numberOfFrames"
      | "autoPlay"
      | "play"
      | "pause"
      | "flipX"
      | "alphaTest"
      | "playBackwards"
      | "resetOnEnd"
      | "animationNames"
      | "onStart"
      | "onEnd"
      | "onLoopEnd"
      | "onFrame"
    >
  >;
}

export interface PrimitiveActorProps extends ActorBaseProps {
  type: "primitive";
  shape?: PrimitiveShape;
  geometryArgs?: number[];
  materialType?: PrimitiveMaterialType;
  color?: ColorRepresentation;
  materialProps?: Partial<ThreeElements["meshStandardMaterial"]>;
  wireframe?: boolean;
}

export type ActorProps =
  | ModelActorProps
  | SpriteActorProps
  | PrimitiveActorProps;

// ─── Sub-Renderers (private) ────────────────────────────────────────────────

const DEFAULT_GEOMETRY_ARGS: Record<PrimitiveShape, number[]> = {
  box: [1, 1, 1],
  sphere: [0.5, 32, 32],
  cylinder: [0.5, 0.5, 1, 32],
  cone: [0.5, 1, 32],
  torus: [0.5, 0.2, 16, 32],
  plane: [1, 1],
  circle: [0.5, 32],
  capsule: [0.5, 1, 4, 16],
  ring: [0.3, 0.5, 32],
};

function ModelRenderer({
  src,
  useDraco,
  useMeshopt,
  animationName,
  animationPaused,
  animationSpeed,
  animationLoop,
  castShadow,
  receiveShadow,
}: Pick<
  ModelActorProps,
  | "src"
  | "useDraco"
  | "useMeshopt"
  | "animationName"
  | "animationPaused"
  | "animationSpeed"
  | "animationLoop"
  | "castShadow"
  | "receiveShadow"
>) {
  const { scene, animations } = useGLTF(src, useDraco, useMeshopt);

  const clone = useMemo(() => {
    return animations.length > 0
      ? SkeletonUtils.clone(scene)
      : scene.clone(true);
  }, [scene, animations]);

  const { ref } = useAnimation(animations, {
    clipName: animationName,
    paused: animationPaused,
    speed: animationSpeed,
    loop: animationLoop ?? true,
  });

  useEffect(() => {
    clone.traverse((child) => {
      if (child instanceof Mesh) {
        child.castShadow = castShadow ?? false;
        child.receiveShadow = receiveShadow ?? false;
      }
    });
  }, [clone, castShadow, receiveShadow]);

  return <primitive object={clone} ref={ref} />;
}

function SpriteRenderer({
  src,
  atlasUrl,
  billboard = true,
  billboardLockX,
  billboardLockY,
  billboardLockZ,
  spriteAnimation,
}: Pick<
  SpriteActorProps,
  | "src"
  | "atlasUrl"
  | "billboard"
  | "billboardLockX"
  | "billboardLockY"
  | "billboardLockZ"
  | "spriteAnimation"
>) {
  if (atlasUrl && spriteAnimation) {
    // JSON atlas animated spritesheet
    const content = (
      <SpriteAnimator
        textureImageURL={src}
        textureDataURL={atlasUrl}
        autoPlay={true}
        {...spriteAnimation}
      />
    );

    if (billboard) {
      return (
        <Billboard
          follow
          lockX={billboardLockX}
          lockY={billboardLockY}
          lockZ={billboardLockZ}
        >
          {content}
        </Billboard>
      );
    }

    return content;
  }

  if (spriteAnimation && !atlasUrl) {
    // Grid-based animated spritesheet (no JSON atlas)
    const content = (
      <AnimatedGridSprite
        src={src}
        numberOfFrames={spriteAnimation.numberOfFrames ?? 1}
        fps={spriteAnimation.fps ?? 10}
        loop={spriteAnimation.loop ?? true}
        startFrame={spriteAnimation.startFrame}
        endFrame={spriteAnimation.endFrame}
        autoPlay={spriteAnimation.autoPlay ?? true}
        flipX={spriteAnimation.flipX}
      />
    );

    if (billboard) {
      return (
        <Billboard
          follow
          lockX={billboardLockX}
          lockY={billboardLockY}
          lockZ={billboardLockZ}
        >
          {content}
        </Billboard>
      );
    }

    return content;
  }

  // Static sprite
  return (
    <StaticSprite
      src={src}
      billboard={billboard}
      billboardLockX={billboardLockX}
      billboardLockY={billboardLockY}
      billboardLockZ={billboardLockZ}
    />
  );
}

function AnimatedGridSprite({
  src,
  numberOfFrames,
  fps = 10,
  loop = true,
  startFrame = 0,
  endFrame,
  autoPlay = true,
  flipX = false,
}: {
  src: string;
  numberOfFrames: number;
  fps?: number;
  loop?: boolean;
  startFrame?: number;
  endFrame?: number;
  autoPlay?: boolean;
  flipX?: boolean;
}) {
  const texture = useTexture(src);
  const matRef = useRef<SpriteMaterial>(null);
  const frameRef = useRef(startFrame);
  const elapsedRef = useRef(0);

  const grid = useMemo(() => {
    const img = texture.image as { width: number; height: number };
    const cols = Math.round(Math.sqrt(numberOfFrames * (img.width / img.height)));
    const rows = Math.ceil(numberOfFrames / cols);
    return { cols, rows };
  }, [texture, numberOfFrames]);

  useEffect(() => {
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    const repeatX = 1 / grid.cols;
    const repeatY = 1 / grid.rows;
    texture.repeat.set(flipX ? -repeatX : repeatX, repeatY);
    texture.needsUpdate = true;
  }, [texture, grid, flipX]);

  useFrame((_, delta) => {
    if (!autoPlay || !matRef.current?.map) return;
    elapsedRef.current += delta;
    const interval = 1 / fps;
    if (elapsedRef.current < interval) return;
    elapsedRef.current -= interval;

    const last = endFrame ?? numberOfFrames - 1;
    const frame = frameRef.current;
    const col = frame % grid.cols;
    const row = Math.floor(frame / grid.cols);

    const map = matRef.current.map;
    map.offset.x = (flipX ? (col + 1) : col) / grid.cols;
    map.offset.y = 1 - (row + 1) / grid.rows;

    let next = frame + 1;
    if (next > last) {
      next = loop ? startFrame : last;
    }
    frameRef.current = next;
  });

  return (
    <sprite>
      <spriteMaterial ref={matRef} map={texture} />
    </sprite>
  );
}

function StaticSprite({
  src,
  billboard = true,
  billboardLockX,
  billboardLockY,
  billboardLockZ,
}: {
  src: string;
  billboard?: boolean;
  billboardLockX?: boolean;
  billboardLockY?: boolean;
  billboardLockZ?: boolean;
}) {
  const texture = useTexture(src);

  const content = (
    <sprite>
      <spriteMaterial map={texture} />
    </sprite>
  );

  if (billboard) {
    return (
      <Billboard
        follow
        lockX={billboardLockX}
        lockY={billboardLockY}
        lockZ={billboardLockZ}
      >
        {content}
      </Billboard>
    );
  }

  return content;
}

function PrimitiveRenderer({
  shape = "box",
  geometryArgs,
  materialType = "standard",
  color = "#6366f1",
  materialProps,
  wireframe,
  castShadow,
  receiveShadow,
}: Pick<
  PrimitiveActorProps,
  | "shape"
  | "geometryArgs"
  | "materialType"
  | "color"
  | "materialProps"
  | "wireframe"
  | "castShadow"
  | "receiveShadow"
>) {
  const args = geometryArgs ?? DEFAULT_GEOMETRY_ARGS[shape ?? "box"];

  const geometryElement = {
    box: <boxGeometry args={args as ConstructorParameters<typeof import("three").BoxGeometry>} />,
    sphere: <sphereGeometry args={args as ConstructorParameters<typeof import("three").SphereGeometry>} />,
    cylinder: <cylinderGeometry args={args as ConstructorParameters<typeof import("three").CylinderGeometry>} />,
    cone: <coneGeometry args={args as ConstructorParameters<typeof import("three").ConeGeometry>} />,
    torus: <torusGeometry args={args as ConstructorParameters<typeof import("three").TorusGeometry>} />,
    plane: <planeGeometry args={args as ConstructorParameters<typeof import("three").PlaneGeometry>} />,
    circle: <circleGeometry args={args as ConstructorParameters<typeof import("three").CircleGeometry>} />,
    capsule: <capsuleGeometry args={args as ConstructorParameters<typeof import("three").CapsuleGeometry>} />,
    ring: <ringGeometry args={args as ConstructorParameters<typeof import("three").RingGeometry>} />,
  }[shape ?? "box"];

  const sharedMaterialProps = { color, wireframe, ...materialProps } as Record<
    string,
    unknown
  >;

  const materialElement = {
    standard: <meshStandardMaterial {...sharedMaterialProps} />,
    basic: <meshBasicMaterial {...sharedMaterialProps} />,
    phong: <meshPhongMaterial {...sharedMaterialProps} />,
    lambert: <meshLambertMaterial {...sharedMaterialProps} />,
    toon: <meshToonMaterial {...sharedMaterialProps} />,
  }[materialType ?? "standard"];

  return (
    <mesh castShadow={castShadow} receiveShadow={receiveShadow}>
      {geometryElement}
      {materialElement}
    </mesh>
  );
}

// ─── Actor Component ────────────────────────────────────────────────────────

export const Actor = forwardRef<Group, ActorProps>((props, ref) => {
  const {
    type,
    name,
    position,
    rotation,
    scale,
    size,
    visible = true,
    userData,
    renderOrder,
    castShadow,
    receiveShadow,
    physics,
    networked,
    children,
    onClick,
    onContextMenu,
    onDoubleClick,
    onPointerUp,
    onPointerDown,
    onPointerOver,
    onPointerOut,
    onPointerEnter,
    onPointerLeave,
    onPointerMove,
    onPointerMissed,
    onWheel,
  } = props;

  // Combined ref: both the forwarded ref and an internal ref for registry use
  const internalRef = useRef<Group>(null);
  const setRefs = useCallback((node: Group | null) => {
    internalRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) (ref as React.MutableRefObject<Group | null>).current = node;
  }, [ref]);

  // Register / unregister this Actor in the ActorRegistry
  useEffect(() => {
    if (!name || !internalRef.current) return;
    const registry = getActorRegistry();
    registry.register(name, {
      id: name,
      object3D: internalRef.current,
      rigidBody: undefined, // Will be set by PhysicsBodyWrapper
      userData: { ...userData, networked },
    });
    return () => {
      registry.unregister(name);
    };
  }, [name, networked]);

  return (
    <PhysicsBodyWrapper physics={physics} name={name} userData={userData}>
    <group
      ref={setRefs}
      name={name}
      position={position}
      rotation={rotation}
      scale={scale ?? (size != null ? [size, size, size] : undefined)}
      visible={visible}
      userData={userData}
      renderOrder={renderOrder}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onPointerUp={onPointerUp}
      onPointerDown={onPointerDown}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerMove={onPointerMove}
      onPointerMissed={onPointerMissed}
      onWheel={onWheel}
    >
      {type === "model" && (
        <ModelRenderer
          src={(props as ModelActorProps).src}
          useDraco={(props as ModelActorProps).useDraco}
          useMeshopt={(props as ModelActorProps).useMeshopt}
          animationName={(props as ModelActorProps).animationName}
          animationPaused={(props as ModelActorProps).animationPaused}
          animationSpeed={(props as ModelActorProps).animationSpeed}
          animationLoop={(props as ModelActorProps).animationLoop}
          castShadow={castShadow}
          receiveShadow={receiveShadow}
        />
      )}
      {type === "sprite" && (
        <SpriteRenderer
          src={(props as SpriteActorProps).src}
          atlasUrl={(props as SpriteActorProps).atlasUrl}
          billboard={(props as SpriteActorProps).billboard}
          billboardLockX={(props as SpriteActorProps).billboardLockX}
          billboardLockY={(props as SpriteActorProps).billboardLockY}
          billboardLockZ={(props as SpriteActorProps).billboardLockZ}
          spriteAnimation={(props as SpriteActorProps).spriteAnimation}
        />
      )}
      {type === "primitive" && (
        <PrimitiveRenderer
          shape={(props as PrimitiveActorProps).shape}
          geometryArgs={(props as PrimitiveActorProps).geometryArgs}
          materialType={(props as PrimitiveActorProps).materialType}
          color={(props as PrimitiveActorProps).color}
          materialProps={(props as PrimitiveActorProps).materialProps}
          wireframe={(props as PrimitiveActorProps).wireframe}
          castShadow={castShadow}
          receiveShadow={receiveShadow}
        />
      )}
      {children}
    </group>
    </PhysicsBodyWrapper>
  );
});

Actor.displayName = "Actor";
