import type { ComponentProps, RefObject } from "react";
import type {
  OrthographicCamera,
  PerspectiveCamera,
  Sky,
  Environment,
  OrbitControls,
  MapControls,
  PointerLockControls,
} from "@react-three/drei";
import type {
  ThreeElements,
  Vector3 as FiberVector3,
  Euler as FiberEuler,
} from "@react-three/fiber";
import type { Object3D } from "three";

// Re-export Three.js types that consumers need
export type { Group, Object3D } from "three";

// ─── World Types ────────────────────────────────────────────────────────────

export type WorldMode = "2d" | "3d";

export type CameraProps2D = Partial<
  Omit<ComponentProps<typeof OrthographicCamera>, "makeDefault">
>;
export type CameraProps3D = Partial<
  Omit<ComponentProps<typeof PerspectiveCamera>, "makeDefault">
>;
export type SkyProps = Partial<ComponentProps<typeof Sky>>;
export type EnvironmentProps = Partial<ComponentProps<typeof Environment>>;
export type OrbitControlsProps = Partial<ComponentProps<typeof OrbitControls>>;
export type AmbientLightProps = Partial<ThreeElements["ambientLight"]>;
export type DirectionalLightProps = Partial<ThreeElements["directionalLight"]>;

// ─── Actor Types ─────────────────────────────────────────────────────

export interface ActorTransformProps {
  position?: FiberVector3;
  rotation?: FiberEuler;
  scale?: FiberVector3;
  size?: number;
}

export interface ActorEventProps {
  onClick?: ThreeElements["group"]["onClick"];
  onContextMenu?: ThreeElements["group"]["onContextMenu"];
  onDoubleClick?: ThreeElements["group"]["onDoubleClick"];
  onPointerUp?: ThreeElements["group"]["onPointerUp"];
  onPointerDown?: ThreeElements["group"]["onPointerDown"];
  onPointerOver?: ThreeElements["group"]["onPointerOver"];
  onPointerOut?: ThreeElements["group"]["onPointerOut"];
  onPointerEnter?: ThreeElements["group"]["onPointerEnter"];
  onPointerLeave?: ThreeElements["group"]["onPointerLeave"];
  onPointerMove?: ThreeElements["group"]["onPointerMove"];
  onPointerMissed?: ThreeElements["group"]["onPointerMissed"];
  onWheel?: ThreeElements["group"]["onWheel"];
}

export type PrimitiveShape =
  | "box"
  | "sphere"
  | "cylinder"
  | "cone"
  | "torus"
  | "plane"
  | "circle"
  | "capsule"
  | "ring";

export type PrimitiveMaterialType =
  | "standard"
  | "basic"
  | "phong"
  | "lambert"
  | "toon";

// ─── Camera Types ────────────────────────────────────────────────────────────

export type CameraType = "perspective" | "orthographic";

export type CameraControlsType = "orbit" | "map" | "pointerlock" | "none";

export type PerspectiveCameraProps = Partial<
  Omit<ComponentProps<typeof PerspectiveCamera>, "makeDefault">
>;
export type OrthographicCameraProps = Partial<
  Omit<ComponentProps<typeof OrthographicCamera>, "makeDefault">
>;
export type MapControlsProps = Partial<ComponentProps<typeof MapControls>>;
export type PointerLockControlsProps = Partial<
  ComponentProps<typeof PointerLockControls>
>;

export interface CameraFollowConfig {
  /** Ref to the Three.js Object3D (typically a Group from an Actor ref) to follow */
  target: RefObject<Object3D | null>;
  /** Position offset from the target in [x, y, z]. Default: [0, 5, 10] */
  offset?: [number, number, number];
  /** Lerp smoothing factor, 0-1. Lower = smoother/laggier, higher = snappier. Default: 0.1 */
  smoothing?: number;
  /** Whether the camera should look at the target. Default: true */
  lookAt?: boolean;
  /** Fixed offset for the look-at point. Default: [0, 0, 0] */
  lookAtOffset?: [number, number, number];
}

export interface UseCameraOptions {
  follow?: CameraFollowConfig;
}

export interface UseCameraReturn {
  /** Trigger a camera shake effect */
  shake: (intensity?: number, duration?: number) => void;
  /** Smoothly transition the camera to a world position */
  moveTo: (position: [number, number, number], duration?: number) => void;
  /** Make the camera look at a specific world point */
  lookAt: (target: [number, number, number]) => void;
}

// ─── Game Loop Types ──────────────────────────────────────────────────────────

/**
 * Lifecycle stage in which a useGameLoop callback fires each frame.
 *
 * Execution order per frame:
 *   earlyUpdate (-10) → fixedUpdate (-20) → update (-30) → lateUpdate (-40) → R3F render (0)
 */
export type GameLoopStage =
  | "earlyUpdate"
  | "fixedUpdate"
  | "update"
  | "lateUpdate";

/**
 * Global game phase managed by the Zustand game store.
 * Callbacks only fire when phase is "playing".
 */
export type GamePhase = "loading" | "playing" | "paused" | "gameover";

/** Options accepted by useGameLoop */
export interface UseGameLoopOptions {
  /** Which update stage this callback belongs to. Default: "update" */
  stage?: GameLoopStage;
  /** Use fixed-timestep accumulator. Only meaningful on "fixedUpdate" stage. Default: false */
  fixedTimestep?: boolean;
  /** Seconds per fixed tick. Default: 1/60 */
  fixedDelta?: number;
  /** Max raw delta cap to prevent spiral-of-death after tab switches. Default: 0.1 */
  maxDelta?: number;
  /** Per-instance toggle, independent of global game phase. Default: true */
  enabled?: boolean;
}

/** Callback signature for useGameLoop */
export type GameLoopCallback = (delta: number, elapsed: number) => void;

/** Return value of useGameLoop */
export interface UseGameLoopReturn {
  /** Current game phase from the store */
  phase: GamePhase;
  /** True when phase is "paused" or "gameover" */
  isPaused: boolean;
  /** Total elapsed seconds while in the "playing" phase */
  elapsed: number;
}

// ─── Input Types ─────────────────────────────────────────────────────────────

/** State of a single key/button for the current frame */
export interface KeyState {
  /** True while the key is physically held down */
  pressed: boolean;
  /** True only on the frame the key was first pressed */
  justPressed: boolean;
  /** True only on the frame the key was released */
  justReleased: boolean;
}

/** Pointer (mouse or touch) state */
export interface PointerState {
  /** Screen-space position in pixels */
  position: { x: number; y: number };
  /** Whether the primary pointer button is down */
  isDown: boolean;
  /** True only on the frame the pointer was pressed */
  justDown: boolean;
  /** True only on the frame the pointer was released */
  justUp: boolean;
}

/** Maps logical action names to physical key codes */
export type ActionMap = Record<string, string[]>;

/** Options for the useInput hook */
export interface UseInputOptions {
  /** Subscribe to specific keys only (KeyboardEvent.code values). If omitted, all keys tracked. */
  keys?: string[];
  /** Logical action map, e.g. { jump: ["Space", "KeyW"], moveLeft: ["KeyA", "ArrowLeft"] } */
  actions?: ActionMap;
  /** Whether this hook instance is active. Default: true */
  enabled?: boolean;
}

/** Return value of useInput */
export interface UseInputReturn {
  /** Check if a key code is currently held */
  isPressed: (code: string) => boolean;
  /** Check if a key code was pressed this frame */
  isJustPressed: (code: string) => boolean;
  /** Check if a key code was released this frame */
  isJustReleased: (code: string) => boolean;
  /** Check if a named action is currently active (any bound key held) */
  isAction: (action: string) => boolean;
  /** Check if a named action was just triggered this frame */
  isActionJustPressed: (action: string) => boolean;
  /** Get the current pointer (mouse/primary touch) state */
  pointer: PointerState;
  /** Get a horizontal axis value: -1 (left), 0 (none), +1 (right) */
  getAxis: (negative: string, positive: string) => number;
}

// ─── Collision Types (Built-in, lightweight) ──────────────────────────────────

/** Shape types for the built-in collision system */
export type ColliderShape = "aabb" | "sphere" | "circle";

export interface AABBColliderDef {
  shape: "aabb";
  /** Half-extents [halfWidth, halfHeight, halfDepth]. For 2D, halfDepth is ignored. */
  halfExtents: [number, number, number];
  /** Offset from the Actor's position. Default: [0, 0, 0] */
  offset?: [number, number, number];
}

export interface SphereColliderDef {
  shape: "sphere";
  radius: number;
  /** Offset from the Actor's position. Default: [0, 0, 0] */
  offset?: [number, number, number];
}

export interface CircleColliderDef {
  shape: "circle";
  radius: number;
  /** Offset from the Actor's position. Default: [0, 0, 0] */
  offset?: [number, number, number];
}

export type ColliderDef = AABBColliderDef | SphereColliderDef | CircleColliderDef;

/** Unified collision event — same shape whether from built-in or Rapier backend */
export interface CollisionEvent {
  /** The "other" collider's name */
  otherName: string;
  /** The "other" collider's userData */
  otherUserData: Record<string, unknown>;
  /** The "other" collider's Object3D ref */
  otherRef: RefObject<Object3D | null>;
  /** Whether this is a sensor (trigger) overlap vs a solid collision */
  isSensor: boolean;
}

export type CollisionCallback = (event: CollisionEvent) => void;

/** Options for the useCollision hook */
export interface UseCollisionOptions {
  /** Ref to the Actor's Group (from Actor's forwardRef) */
  ref: RefObject<Object3D | null>;
  /** Name for identification in collision events */
  name?: string;
  /** Arbitrary data passed through to collision events */
  userData?: Record<string, unknown>;
  /** Collider definition */
  collider: ColliderDef;
  /** Collision layer bitmask. Default: 0xFFFFFFFF (collides with everything) */
  layer?: number;
  /** Mask of layers this collider checks against. Default: 0xFFFFFFFF */
  mask?: number;
  /** Whether this is a sensor/trigger (detects overlap, no physics response). Default: false */
  sensor?: boolean;
  /** Fired on the first frame of overlap */
  onCollisionEnter?: CollisionCallback;
  /** Fired on the last frame of overlap */
  onCollisionExit?: CollisionCallback;
  /** Fired every frame while overlapping */
  onCollisionStay?: CollisionCallback;
  /** Whether this collider is active. Default: true */
  enabled?: boolean;
}

/** Return value of useCollision */
export interface UseCollisionReturn {
  /** Check if currently overlapping with a named collider */
  isOverlapping: (name: string) => boolean;
  /** Get all current overlap names */
  getOverlaps: () => string[];
}

// ─── Grid Collision Types (Built-in, tile-based) ─────────────────────────────

/** Configuration for a grid collision system */
export interface GridCollisionConfig {
  /** Number of cells along the X axis */
  width: number;
  /** Number of cells along the Y axis */
  height: number;
  /** World-space size of each cell. Default: 1 */
  cellSize?: number;
  /** World-space origin offset [x, y]. Default: [0, 0] */
  origin?: [number, number];
}

/** Callback for grid cell events */
export type GridCellCallback = (x: number, y: number, value: number) => void;

/** Options for the useGridCollision hook */
export interface UseGridCollisionOptions {
  /** Grid configuration */
  config: GridCollisionConfig;
}

/** Return value of useGridCollision */
export interface UseGridCollisionReturn {
  /** Set a cell value. 0 = empty, positive integers = occupied by type. */
  setCell: (x: number, y: number, value: number) => void;
  /** Get the value at a cell. Returns 0 if empty or out of bounds. */
  getCell: (x: number, y: number) => number;
  /** Clear a cell (set to 0) */
  clearCell: (x: number, y: number) => void;
  /** Check if a cell is occupied (non-zero) */
  isCellOccupied: (x: number, y: number) => boolean;
  /** Convert world coordinates to grid coordinates */
  worldToGrid: (worldX: number, worldY: number) => [number, number];
  /** Convert grid coordinates to world coordinates (cell center) */
  gridToWorld: (gridX: number, gridY: number) => [number, number];
  /** Get values of 4 cardinal neighbors [up, right, down, left] */
  getNeighbors4: (x: number, y: number) => [number, number, number, number];
  /** Get values of 8 neighbors (cardinal + diagonal) */
  getNeighbors8: (x: number, y: number) => number[];
  /** Clear the entire grid */
  clearAll: () => void;
}

// ─── Physics Types (Rapier-backed, opt-in) ────────────────────────────────────

/** Rigid body types matching Rapier's classification */
export type RigidBodyType =
  | "dynamic"
  | "kinematicPosition"
  | "kinematicVelocity"
  | "fixed";

/** Physics collider shapes supported by the Rapier integration */
export type PhysicsColliderType =
  | "cuboid"
  | "ball"
  | "capsule"
  | "trimesh"
  | "convexHull"
  | "auto";

/** Physics properties for an Actor. Only active when a Physics context exists. */
export interface ActorPhysicsProps {
  /** Rigid body type. Default: "dynamic" */
  bodyType?: RigidBodyType;
  /** Collider shape. "auto" matches the Actor's visual. Default: "auto" */
  collider?: PhysicsColliderType;
  /** Mass. Default: 1 */
  mass?: number;
  /** Bounciness (0-1). Default: 0 */
  restitution?: number;
  /** Friction coefficient. Default: 0.5 */
  friction?: number;
  /** Enable/disable translation per axis [x, y, z]. In 2D mode, Z is auto-locked. */
  enabledTranslations?: [boolean, boolean, boolean];
  /** Enable/disable rotation per axis [x, y, z]. In 2D mode, X/Y are auto-locked. */
  enabledRotations?: [boolean, boolean, boolean];
  /** Whether this is a sensor (trigger volume). Default: false */
  sensor?: boolean;
  /** Gravity scale for this body. 0 = no gravity. Default: 1 */
  gravityScale?: number;
  /** Linear damping. Default: 0 */
  linearDamping?: number;
  /** Angular damping. Default: 0 */
  angularDamping?: number;
  /** Enable continuous collision detection for fast-moving objects. Default: false */
  ccd?: boolean;
  /** Collision callback when another body starts touching */
  onCollisionEnter?: CollisionCallback;
  /** Collision callback when another body stops touching */
  onCollisionExit?: CollisionCallback;
}

/** Physics configuration for a World */
export interface WorldPhysicsConfig {
  /** Gravity vector [x, y, z]. Default: [0, -9.81, 0] */
  gravity?: [number, number, number];
  /** Enable interpolation for smoother rendering. Default: true */
  interpolation?: boolean;
  /** Physics timestep. "vary" uses variable timestep. Default: 1/60 */
  timestep?: number | "vary";
  /** Show debug wireframes for all colliders. Default: false */
  debug?: boolean;
  /** R3F useFrame priority for the physics step. Default: -45 (runs before all useGameLoop stages) */
  updatePriority?: number;
}

/** Return value of usePhysics */
export interface UsePhysicsReturn {
  /** Apply an impulse (instantaneous force) to the rigid body */
  applyImpulse: (impulse: [number, number, number]) => void;
  /** Apply a continuous force (resets each physics step) */
  applyForce: (force: [number, number, number]) => void;
  /** Set the linear velocity directly */
  setLinearVelocity: (velocity: [number, number, number]) => void;
  /** Get the current linear velocity */
  getLinearVelocity: () => [number, number, number];
  /** Set the angular velocity */
  setAngularVelocity: (velocity: [number, number, number]) => void;
  /** Teleport the rigid body to a new position */
  setTranslation: (position: [number, number, number]) => void;
  /** Get the current translation */
  getTranslation: () => [number, number, number];
  /** Set the rotation */
  setRotation: (rotation: [number, number, number, number]) => void;
  /** Enable or disable the rigid body */
  setEnabled: (enabled: boolean) => void;
  /** Clear all accumulated forces on the rigid body */
  resetForces: () => void;
}
