import React, { createContext, useContext, useRef, Suspense, useState, useEffect } from "react";
import type { ReactNode, RefObject } from "react";
import type {
  WorldMode,
  WorldPhysicsConfig,
  ActorPhysicsProps,
  CollisionCallback,
  CollisionEvent,
} from "../types";

// ── Lazy-loaded Rapier components via dynamic import ──

interface RapierModules {
  Physics: React.ComponentType<any>;
  RigidBody: React.ComponentType<any>;
}

let _rapierModules: RapierModules | null = null;
let _rapierLoadPromise: Promise<RapierModules | null> | null = null;
let _rapierLoadFailed = false;

function loadRapier(): Promise<RapierModules | null> {
  if (_rapierModules) return Promise.resolve(_rapierModules);
  if (_rapierLoadFailed) return Promise.resolve(null);
  if (_rapierLoadPromise) return _rapierLoadPromise;

  _rapierLoadPromise = import("@react-three/rapier")
    .then((mod) => {
      _rapierModules = {
        Physics: mod.Physics,
        RigidBody: mod.RigidBody,
      };
      return _rapierModules;
    })
    .catch(() => {
      _rapierLoadFailed = true;
      return null;
    });

  return _rapierLoadPromise;
}

// ── Hook to access loaded Rapier modules ──

function useRapierModules(): RapierModules | null {
  const [modules, setModules] = useState<RapierModules | null>(_rapierModules);

  useEffect(() => {
    if (_rapierModules) {
      setModules(_rapierModules);
      return;
    }
    let cancelled = false;
    loadRapier().then((m) => {
      if (!cancelled) setModules(m);
    });
    return () => { cancelled = true; };
  }, []);

  return modules;
}

// ── Physics Context ──

interface PhysicsContextValue {
  available: boolean;
  is2D: boolean;
  config: WorldPhysicsConfig;
  modules: RapierModules;
}

const PhysicsContext = createContext<PhysicsContextValue | null>(null);

export function usePhysicsContext(): PhysicsContextValue | null {
  return useContext(PhysicsContext);
}

// ── PhysicsGate — conditionally wraps children in Rapier <Physics> ──

export interface PhysicsGateProps {
  config?: WorldPhysicsConfig;
  mode: WorldMode;
  children: ReactNode;
}

export function PhysicsGate({ config, mode, children }: PhysicsGateProps) {
  const modules = useRapierModules();

  if (!config) {
    return <>{children}</>;
  }

  if (!modules) {
    if (_rapierLoadFailed) {
      console.warn(
        "[@carverjs/core] World has a `physics` prop but @react-three/rapier is not installed. " +
          "Install it with: pnpm add @react-three/rapier"
      );
    }
    // Still loading or failed — render children without physics
    return <>{children}</>;
  }

  const is2D = mode === "2d";
  const gravity = config.gravity ?? [0, -9.81, 0];
  const timestep = config.timestep ?? 1 / 60;
  const interpolate = config.interpolation ?? true;
  const debug = config.debug ?? false;

  // Run the Rapier physics step BEFORE all useGameLoop stages so that
  // setLinvel / linearDamping / getLinearVelocity work correctly in game code.
  // Priority chain: InputFlush(-50) → Rapier(-45) → earlyUpdate(-40) → … → update(-20)
  const updatePriority = config.updatePriority ?? -45;

  const contextValue: PhysicsContextValue = {
    available: true,
    is2D,
    config,
    modules,
  };

  const { Physics } = modules;

  return (
    <PhysicsContext.Provider value={contextValue}>
      <Suspense fallback={null}>
        <Physics
          gravity={gravity}
          timeStep={timestep}
          interpolate={interpolate}
          debug={debug}
          updatePriority={updatePriority}
        >
          {children}
        </Physics>
      </Suspense>
    </PhysicsContext.Provider>
  );
}

// ── RigidBody Ref Context — allows usePhysics to access the body instance ──

// The RapierRigidBody type from @dimforge/rapier3d-compat. We use `any`
// to avoid a hard dependency on the rapier types at the type level.
type RapierRigidBodyRef = RefObject<any>;

const RigidBodyRefContext = createContext<RapierRigidBodyRef | null>(null);

export function useRigidBodyRef(): RapierRigidBodyRef | null {
  return useContext(RigidBodyRefContext);
}

// ── PhysicsBodyWrapper — conditionally wraps children in Rapier <RigidBody> ──

export interface PhysicsBodyWrapperProps {
  physics?: ActorPhysicsProps;
  name?: string;
  userData?: Record<string, unknown>;
  children: ReactNode;
}

function mapColliderType(
  collider: ActorPhysicsProps["collider"],
): string | false {
  if (!collider || collider === "auto") return "cuboid";
  if (collider === "convexHull") return "hull";
  return collider;
}

function buildCollisionHandler(
  callback: CollisionCallback | undefined,
  isSensor: boolean,
): ((payload: any) => void) | undefined {
  if (!callback) return undefined;
  return (payload: any) => {
    const other = payload.other;
    const otherObject = other?.rigidBodyObject ?? other?.object;
    const event: CollisionEvent = {
      otherName: otherObject?.name ?? "",
      otherUserData: otherObject?.userData ?? {},
      otherRef: { current: otherObject ?? null },
      isSensor,
    };
    callback(event);
  };
}

export function PhysicsBodyWrapper({
  physics,
  name,
  userData,
  children,
}: PhysicsBodyWrapperProps) {
  const ctx = usePhysicsContext();

  if (!physics || !ctx?.available) {
    return <>{children}</>;
  }

  const rigidBodyRef = useRef<any>(null);
  const { RigidBody } = ctx.modules;
  const bodyType = physics.bodyType ?? "dynamic";
  const collider = mapColliderType(physics.collider);
  const sensor = physics.sensor ?? false;

  // In 2D mode, auto-lock Z translation and X/Y rotation
  let enabledTranslations = physics.enabledTranslations;
  let enabledRotations = physics.enabledRotations;
  if (ctx.is2D) {
    enabledTranslations = enabledTranslations ?? [true, true, false];
    enabledRotations = enabledRotations ?? [false, false, true];
  }

  const rigidBodyProps: Record<string, unknown> = {
    type: bodyType,
    colliders: collider,
    sensor,
    name,
    userData,
  };

  if (physics.mass !== undefined) rigidBodyProps.mass = physics.mass;
  if (physics.restitution !== undefined) rigidBodyProps.restitution = physics.restitution;
  if (physics.friction !== undefined) rigidBodyProps.friction = physics.friction;
  if (enabledTranslations) rigidBodyProps.enabledTranslations = enabledTranslations;
  if (enabledRotations) rigidBodyProps.enabledRotations = enabledRotations;
  if (physics.gravityScale !== undefined) rigidBodyProps.gravityScale = physics.gravityScale;
  if (physics.linearDamping !== undefined) rigidBodyProps.linearDamping = physics.linearDamping;
  if (physics.angularDamping !== undefined) rigidBodyProps.angularDamping = physics.angularDamping;
  if (physics.ccd !== undefined) rigidBodyProps.ccd = physics.ccd;

  // Collision event handlers
  const onCollisionEnter = buildCollisionHandler(physics.onCollisionEnter, false);
  const onCollisionExit = buildCollisionHandler(physics.onCollisionExit, false);
  const onIntersectionEnter = sensor
    ? buildCollisionHandler(physics.onCollisionEnter, true)
    : undefined;
  const onIntersectionExit = sensor
    ? buildCollisionHandler(physics.onCollisionExit, true)
    : undefined;

  if (onCollisionEnter) rigidBodyProps.onCollisionEnter = onCollisionEnter;
  if (onCollisionExit) rigidBodyProps.onCollisionExit = onCollisionExit;
  if (onIntersectionEnter) rigidBodyProps.onIntersectionEnter = onIntersectionEnter;
  if (onIntersectionExit) rigidBodyProps.onIntersectionExit = onIntersectionExit;

  return (
    <RigidBody ref={rigidBodyRef} {...rigidBodyProps}>
      <RigidBodyRefContext.Provider value={rigidBodyRef}>
        {children}
      </RigidBodyRefContext.Provider>
    </RigidBody>
  );
}
