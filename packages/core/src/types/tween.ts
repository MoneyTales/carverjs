// ─── Easing Types ────────────────────────────────────────────────────────────

/** A normalized easing function: takes t in [0,1], returns eased value */
export type EasingFn = (t: number) => number;

/** Named easing preset identifier */
export type EasingPreset =
  | "linear"
  | "quad.in"
  | "quad.out"
  | "quad.inOut"
  | "cubic.in"
  | "cubic.out"
  | "cubic.inOut"
  | "quart.in"
  | "quart.out"
  | "quart.inOut"
  | "quint.in"
  | "quint.out"
  | "quint.inOut"
  | "sine.in"
  | "sine.out"
  | "sine.inOut"
  | "expo.in"
  | "expo.out"
  | "expo.inOut"
  | "circ.in"
  | "circ.out"
  | "circ.inOut"
  | "back.in"
  | "back.out"
  | "back.inOut"
  | "elastic.in"
  | "elastic.out"
  | "elastic.inOut"
  | "bounce.in"
  | "bounce.out"
  | "bounce.inOut"
  | "spring";

/** Easing can be a preset name, a custom function, or a cubic-bezier tuple [x1,y1,x2,y2] */
export type EasingInput =
  | EasingPreset
  | EasingFn
  | [number, number, number, number];

// ─── Tween State Machine ─────────────────────────────────────────────────────

export type TweenState =
  | "idle"
  | "pending"
  | "delayed"
  | "playing"
  | "completed"
  | "killed";

export type TweenDirection = "forward" | "reverse";

// ─── Tween Configuration ─────────────────────────────────────────────────────

export interface TweenConfig<T extends object = Record<string, unknown>> {
  /** The object whose properties will be animated */
  target: T;
  /** Properties to animate to (end values). Supports dot-notation: "position.x" */
  to: Partial<Record<string, number>>;
  /** Explicit start values. If omitted, current values are captured at creation. */
  from?: Partial<Record<string, number>>;
  /** Duration in seconds. Default: 0.3 */
  duration?: number;
  /** Easing function or preset name. Default: "quad.out" */
  ease?: EasingInput;
  /** Delay before starting, in seconds. Default: 0 */
  delay?: number;
  /** Number of additional repeats. -1 for infinite. Default: 0 */
  repeat?: number;
  /** Delay between repeats, in seconds. Default: 0 */
  repeatDelay?: number;
  /** Reverse direction on each repeat. Default: false */
  yoyo?: boolean;
  /** Playback speed multiplier. Default: 1 */
  speed?: number;
  /** Named group for batch control. Default: "" */
  group?: string;
  /** Keep tween alive after completion (not auto-released). Default: false */
  persist?: boolean;
  /** Continue updating when game is paused. Default: false */
  ignorePause?: boolean;

  // ── Callbacks ──
  onStart?: () => void;
  onUpdate?: (progress: number) => void;
  onComplete?: () => void;
  onRepeat?: (count: number) => void;
  onYoyo?: (direction: TweenDirection) => void;
  onKill?: () => void;
}

/** Configuration for a target-less number tween */
export interface NumberTweenConfig {
  from: number;
  to: number;
  duration?: number;
  ease?: EasingInput;
  delay?: number;
  repeat?: number;
  repeatDelay?: number;
  yoyo?: boolean;
  speed?: number;
  group?: string;
  ignorePause?: boolean;

  onStart?: () => void;
  onUpdate?: (value: number, progress: number) => void;
  onComplete?: () => void;
  onRepeat?: (count: number) => void;
  onYoyo?: (direction: TweenDirection) => void;
  onKill?: () => void;
}

// ─── Tween Controls ──────────────────────────────────────────────────────────

export interface TweenControls {
  readonly id: number;
  readonly state: TweenState;
  readonly progress: number;
  pause: () => TweenControls;
  resume: () => TweenControls;
  kill: () => TweenControls;
  restart: () => TweenControls;
  seek: (progress: number) => TweenControls;
  setSpeed: (multiplier: number) => TweenControls;
  chain: (config: TweenConfig) => TweenControls;
  readonly finished: Promise<void>;
}

// ─── Group Controls ──────────────────────────────────────────────────────────

export interface TweenGroupControls {
  pause: () => void;
  resume: () => void;
  kill: () => void;
  readonly count: number;
}

// ─── Timeline Types ──────────────────────────────────────────────────────────

/**
 * Timeline position specifier.
 * - number: absolute time in seconds
 * - "+=0.5": relative to end of previous entry
 * - "-=0.2": overlap with previous entry
 * - "label": at a named label
 * - "label+=0.3": offset from label
 * - "<": start of previous entry (parallel)
 * - "<+=0.5": offset from start of previous entry
 */
export type TimelinePosition = number | string;

export interface TimelineConfig {
  /** Number of additional repeats. -1 for infinite. Default: 0 */
  repeat?: number;
  /** Delay between repeats, in seconds. Default: 0 */
  repeatDelay?: number;
  /** Reverse direction on each repeat. Default: false */
  yoyo?: boolean;
  /** Playback speed multiplier. Default: 1 */
  speed?: number;
  /** Start paused. Default: false */
  paused?: boolean;
  /** Continue updating when game is paused. Default: false */
  ignorePause?: boolean;
  /** Named group for batch control */
  group?: string;

  onStart?: () => void;
  onUpdate?: (progress: number) => void;
  onComplete?: () => void;
  onRepeat?: (count: number) => void;
}

export interface TimelineControls {
  readonly id: number;
  readonly state: TweenState;
  readonly progress: number;
  readonly duration: number;
  add: <T extends object>(
    config: TweenConfig<T>,
    position?: TimelinePosition,
  ) => TimelineControls;
  addCallback: (
    callback: () => void,
    position?: TimelinePosition,
  ) => TimelineControls;
  addLabel: (
    name: string,
    position?: TimelinePosition,
  ) => TimelineControls;
  play: () => TimelineControls;
  pause: () => TimelineControls;
  resume: () => TimelineControls;
  kill: () => TimelineControls;
  restart: () => TimelineControls;
  seek: (timeOrLabel: number | string) => TimelineControls;
  setSpeed: (multiplier: number) => TimelineControls;
  readonly finished: Promise<void>;
}

// ─── Hook Types ──────────────────────────────────────────────────────────────

export interface UseTweenReturn {
  /** Create and start a property tween */
  tween: <T extends object>(config: TweenConfig<T>) => TweenControls;
  /** Create and start a target-less number tween */
  tweenNumber: (config: NumberTweenConfig) => TweenControls;
  /** Create a timeline for sequenced animations */
  timeline: (config?: TimelineConfig) => TimelineControls;
  /** Kill all tweens created by this hook instance */
  killAll: () => void;
  /** Pause all tweens created by this hook instance */
  pauseAll: () => void;
  /** Resume all tweens created by this hook instance */
  resumeAll: () => void;
}
