import type { ColorRepresentation, Texture, Object3D } from "three";
import type {
  Vector3 as FiberVector3,
  Euler as FiberEuler,
} from "@react-three/fiber";
import type { RefObject } from "react";
import type { WorldMode } from "./core";

// ─── Emitter Shape ──────────────────────────────────────────────────────────

export type EmitterShape =
  | "point"
  | "cone"
  | "sphere"
  | "rectangle"
  | "edge"
  | "ring";

export interface PointShapeConfig {
  shape: "point";
}

export interface ConeShapeConfig {
  shape: "cone";
  /** Half-angle of the cone in radians. Default: Math.PI / 4 */
  angle?: number;
  /** Radius of the cone base. Default: 1 */
  radius?: number;
  /** Emit from surface only. Default: false (volume) */
  surface?: boolean;
}

export interface SphereShapeConfig {
  shape: "sphere";
  /** Radius. Default: 1 */
  radius?: number;
  /** Emit from surface only. Default: false (volume) */
  surface?: boolean;
}

export interface RectangleShapeConfig {
  shape: "rectangle";
  /** Width. Default: 1 */
  width?: number;
  /** Height. Default: 1 */
  height?: number;
}

export interface EdgeShapeConfig {
  shape: "edge";
  /** Start point [x, y, z]. Default: [-0.5, 0, 0] */
  from?: [number, number, number];
  /** End point [x, y, z]. Default: [0.5, 0, 0] */
  to?: [number, number, number];
}

export interface RingShapeConfig {
  shape: "ring";
  /** Outer radius. Default: 1 */
  radius?: number;
  /** Inner radius. Default: 0.8 */
  innerRadius?: number;
}

export type EmitterShapeConfig =
  | PointShapeConfig
  | ConeShapeConfig
  | SphereShapeConfig
  | RectangleShapeConfig
  | EdgeShapeConfig
  | RingShapeConfig;

// ─── Value Ranges ───────────────────────────────────────────────────────────

/** A single value or [min, max] range for randomized properties */
export type ValueRange = number | [number, number];

/** A single color or [startColor, endColor] for random interpolation */
export type ColorRange =
  | ColorRepresentation
  | [ColorRepresentation, ColorRepresentation];

// ─── Over-Lifetime Curves ───────────────────────────────────────────────────

/** Keyframe: `t` is normalized lifetime (0 = birth, 1 = death) */
export interface CurveKeyframe {
  t: number;
  value: number;
}

/** Over-lifetime curve: keyframes linearly interpolated */
export type LifetimeCurve = CurveKeyframe[];

/** Color gradient stop */
export interface ColorGradientStop {
  t: number;
  color: ColorRepresentation;
}

export type ColorGradient = ColorGradientStop[];

// ─── Blend Modes ────────────────────────────────────────────────────────────

export type ParticleBlendMode = "normal" | "additive" | "multiply" | "screen";

// ─── Sprite Sheet ───────────────────────────────────────────────────────────

export interface SpriteSheetConfig {
  /** Texture or URL */
  texture: Texture | string;
  /** Grid columns */
  columns: number;
  /** Grid rows */
  rows: number;
  /** Total frames (may be < columns * rows). Default: columns * rows */
  totalFrames?: number;
  /** Frames per second. Default: 30 */
  fps?: number;
  /** Starting frame index. Default: 0 */
  startFrame?: number;
  /** Loop animation. Default: true */
  loop?: boolean;
  /** Randomize start frame per particle. Default: false */
  randomStart?: boolean;
}

// ─── Emission ───────────────────────────────────────────────────────────────

export type EmissionMode = "stream" | "burst";

export interface BurstConfig {
  /** Time offset from emitter start (seconds). Default: 0 */
  time?: number;
  /** Number of particles */
  count: ValueRange;
  /** Burst cycles. 0 = infinite. Default: 1 */
  cycles?: number;
  /** Interval between cycles (seconds). Default: 1 */
  interval?: number;
}

// ─── Coordinate Space ───────────────────────────────────────────────────────

export type ParticleSpace = "world" | "local";

// ─── Particle Properties ────────────────────────────────────────────────────

export interface ParticlePropertyConfig {
  /** Initial speed. Default: 5 */
  speed?: ValueRange;
  /** Lifetime in seconds. Default: 1 */
  lifetime?: ValueRange;
  /** Initial uniform scale. Default: 1 */
  size?: ValueRange;
  /** Initial rotation in radians. Default: 0 */
  rotation?: ValueRange;
  /** Rotation speed in radians/sec. Default: 0 */
  rotationSpeed?: ValueRange;
  /** Initial color. Default: "#ffffff" */
  color?: ColorRange;
  /** Initial alpha. Default: 1 */
  alpha?: ValueRange;
  /** Constant acceleration [x, y, z]. Default: [0, 0, 0] */
  acceleration?: [number, number, number];
  /** Gravity multiplier (applies downward force). Default: 0 */
  gravity?: number;
  /** Linear drag (0 = none, 1 = full stop). Default: 0 */
  drag?: number;
}

// ─── Over-Lifetime Modifiers ────────────────────────────────────────────────

export interface OverLifetimeConfig {
  /** Size multiplier curve */
  size?: LifetimeCurve;
  /** Alpha multiplier curve */
  alpha?: LifetimeCurve;
  /** Color gradient (replaces initial color) */
  color?: ColorGradient;
  /** Rotation speed multiplier curve */
  rotationSpeed?: LifetimeCurve;
  /** Speed multiplier curve */
  speed?: LifetimeCurve;
}

// ─── Emitter Config ─────────────────────────────────────────────────────────

export interface ParticleEmitterConfig {
  /** Unique name for imperative lookups */
  name?: string;
  /** Max alive particles. Default: 1000 */
  maxParticles?: number;

  // Emission
  /** Emission mode. Default: "stream" */
  emission?: EmissionMode;
  /** Particles per second (stream mode). Default: 50 */
  rate?: ValueRange;
  /** Burst configs (burst mode) */
  bursts?: BurstConfig[];
  /** Emission duration (seconds). 0 = one-shot, Infinity = forever. Default: Infinity */
  duration?: number;
  /** Loop after duration ends. Default: true */
  loop?: boolean;
  /** Delay before start (seconds). Default: 0 */
  startDelay?: number;

  // Shape
  /** Emitter shape. Default: { shape: "point" } */
  shape?: EmitterShapeConfig;

  // Particle props
  /** Per-particle initial properties */
  particle?: ParticlePropertyConfig;

  // Over-lifetime
  /** Over-lifetime modifiers */
  overLifetime?: OverLifetimeConfig;

  // Rendering
  /** Blend mode. Default: "normal" */
  blendMode?: ParticleBlendMode;
  /** Single particle texture */
  texture?: Texture | string;
  /** Sprite sheet config */
  spriteSheet?: SpriteSheetConfig;
  /** Billboard particles (face camera). Default: true */
  billboard?: boolean;

  // Space
  /** Coordinate space. Default: "world" */
  space?: ParticleSpace;

  // Sorting
  /** Sort back-to-front for transparency. Default: false */
  sortByDistance?: boolean;

  // Lifecycle
  /** Auto-start. Default: true */
  autoPlay?: boolean;
  /** Callback when a particle is born */
  onParticleBorn?: (index: number) => void;
  /** Callback when a particle dies */
  onParticleDeath?: (index: number) => void;
  /** Callback when all particles have died after emission stops */
  onComplete?: () => void;
}

// ─── Preset Names ───────────────────────────────────────────────────────────

export type ParticlePreset =
  | "fire"
  | "smoke"
  | "explosion"
  | "sparks"
  | "rain"
  | "snow"
  | "magic"
  | "confetti";

// ─── Internal Particle Data (SoA) ──────────────────────────────────────────

export interface ParticleData {
  posX: Float32Array;
  posY: Float32Array;
  posZ: Float32Array;
  velX: Float32Array;
  velY: Float32Array;
  velZ: Float32Array;
  accX: Float32Array;
  accY: Float32Array;
  accZ: Float32Array;
  age: Float32Array;
  lifetime: Float32Array;
  size: Float32Array;
  initialSize: Float32Array;
  rotation: Float32Array;
  rotationSpeed: Float32Array;
  initialRotationSpeed: Float32Array;
  alpha: Float32Array;
  initialAlpha: Float32Array;
  initialSpeed: Float32Array;
  drag: Float32Array;
  colorR: Float32Array;
  colorG: Float32Array;
  colorB: Float32Array;
  spriteFrame: Float32Array;
  spriteElapsed: Float32Array;
  alive: Uint8Array;
}

// ─── useParticles Return ────────────────────────────────────────────────────

export interface UseParticlesReturn {
  /** Ref to attach to a <group> for emitter positioning */
  ref: RefObject<Object3D | null>;
  /** Emit a burst of particles */
  burst: (count?: number) => void;
  /** Start continuous emission */
  start: () => void;
  /** Stop emission (existing particles live out their lifetime) */
  stop: () => void;
  /** Stop and kill all particles immediately */
  clear: () => void;
  /** Change emission rate (stream mode) */
  setRate: (rate: number) => void;
  /** Current alive particle count */
  getActiveCount: () => number;
  /** Whether currently emitting */
  isEmitting: () => boolean;
  /** Reset to initial state */
  reset: () => void;
}

// ─── useParticles Options ───────────────────────────────────────────────────

export interface UseParticlesOptions extends ParticleEmitterConfig {
  /** Base preset to merge with */
  preset?: ParticlePreset;
  /** Enable/disable. Default: true */
  enabled?: boolean;
}

// ─── ParticleEmitter Props ──────────────────────────────────────────────────

export interface ParticleEmitterProps extends ParticleEmitterConfig {
  /** Base preset to merge with */
  preset?: ParticlePreset;
  /** Emitter position */
  position?: FiberVector3;
  /** Emitter rotation */
  rotation?: FiberEuler;
  /** Enable/disable. Default: true */
  enabled?: boolean;
}
