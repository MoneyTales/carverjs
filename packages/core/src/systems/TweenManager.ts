import { resolveEasing } from "./Easing";
import { useGameStore } from "../store/gameStore";
import type {
  EasingFn,
  TweenState,
  TweenDirection,
  TweenConfig,
  NumberTweenConfig,
  TweenControls,
  TimelineConfig,
  TimelineControls,
  TimelinePosition,
  TweenGroupControls,
} from "../types";

// ─── Constants ───────────────────────────────────────────────────────────────

const INITIAL_POOL_SIZE = 64;
const MAX_POOL_SIZE = 512;
const MAX_PROPERTIES = 16;

// ─── Internal Property Data ──────────────────────────────────────────────────

interface PropData {
  key: string;
  parts: string[];
  from: number;
  to: number;
  delta: number;
}

// ─── Tween Class (internal, never exported) ──────────────────────────────────

let _tweenIdCounter = 0;

class Tween {
  id = 0;
  state: TweenState = "idle";
  direction: TweenDirection = "forward";

  // Target
  target: Record<string, unknown> | null = null;

  // Config
  duration = 0.3;
  delay = 0;
  easeFn: EasingFn = (t) => t;
  repeat = 0;
  repeatDelay = 0;
  yoyo = false;
  speed = 1;
  group = "";
  persist = false;
  ignorePause = false;

  // Property data (pre-allocated, reused via propCount)
  props: PropData[];
  propCount = 0;

  // Timing
  elapsed = 0;
  delayElapsed = 0;
  repeatCount = 0;
  progress = 0;
  _totalRepeat = 0; // original repeat value for restart

  // Callbacks
  onStart: (() => void) | null = null;
  onUpdate: ((progress: number) => void) | null = null;
  onComplete: (() => void) | null = null;
  onRepeat: ((count: number) => void) | null = null;
  onYoyo: ((direction: TweenDirection) => void) | null = null;
  onKill: (() => void) | null = null;

  // Number tween
  _isNumberTween = false;
  _numberOnUpdate: ((value: number, progress: number) => void) | null = null;

  // Chain
  _chainConfigs: TweenConfig[] = [];

  // Promise (.finished) — lazy
  _resolve: (() => void) | null = null;
  _promise: Promise<void> | null = null;

  constructor() {
    this.props = [];
    for (let i = 0; i < MAX_PROPERTIES; i++) {
      this.props.push({ key: "", parts: [], from: 0, to: 0, delta: 0 });
    }
  }

  reset(): void {
    this.id = 0;
    this.state = "idle";
    this.direction = "forward";
    this.target = null;
    this.duration = 0.3;
    this.delay = 0;
    this.easeFn = (t) => t;
    this.repeat = 0;
    this.repeatDelay = 0;
    this.yoyo = false;
    this.speed = 1;
    this.group = "";
    this.persist = false;
    this.ignorePause = false;
    this.propCount = 0;
    this.elapsed = 0;
    this.delayElapsed = 0;
    this.repeatCount = 0;
    this.progress = 0;
    this._totalRepeat = 0;
    this.onStart = null;
    this.onUpdate = null;
    this.onComplete = null;
    this.onRepeat = null;
    this.onYoyo = null;
    this.onKill = null;
    this._isNumberTween = false;
    this._numberOnUpdate = null;
    this._chainConfigs.length = 0;
    // Resolve any pending promise so it doesn't hang
    if (this._resolve) this._resolve();
    this._resolve = null;
    this._promise = null;
  }
}

// ─── Controls Wrapper (fresh per create call, captures tween ID) ─────────────

function createControls(tween: Tween, manager: TweenManager): TweenControls {
  const capturedId = tween.id;

  function isAlive(): boolean {
    return tween.id === capturedId && tween.state !== "killed";
  }

  const controls: TweenControls = {
    get id() {
      return capturedId;
    },
    get state() {
      return tween.id === capturedId ? tween.state : ("killed" as TweenState);
    },
    get progress() {
      return tween.id === capturedId ? tween.progress : 0;
    },
    pause() {
      if (isAlive() && tween.state === "playing") {
        tween.state = "pending"; // paused tweens go to pending, won't tick
      }
      return controls;
    },
    resume() {
      if (isAlive() && tween.state === "pending") {
        tween.state = "playing";
      }
      return controls;
    },
    kill() {
      if (isAlive()) {
        manager._killTween(tween);
      }
      return controls;
    },
    restart() {
      if (tween.id === capturedId) {
        tween.elapsed = 0;
        tween.delayElapsed = 0;
        tween.repeatCount = 0;
        tween.direction = "forward";
        tween.repeat = tween._totalRepeat;
        tween.state = tween.delay > 0 ? "delayed" : "playing";
        tween.onStart?.();
      }
      return controls;
    },
    seek(p: number) {
      if (!isAlive()) return controls;
      const clamped = Math.max(0, Math.min(1, p));
      tween.elapsed = clamped * tween.duration;
      tween.progress = clamped;

      // Apply values at this progress
      const eased = tween.easeFn(
        tween.direction === "reverse" ? 1 - clamped : clamped,
      );
      for (let i = 0; i < tween.propCount; i++) {
        const prop = tween.props[i];
        writeProperty(
          tween.target as Record<string, unknown>,
          prop.parts,
          prop.from + prop.delta * eased,
        );
      }
      return controls;
    },
    setSpeed(multiplier: number) {
      if (isAlive()) tween.speed = Math.max(0, multiplier);
      return controls;
    },
    chain(config: TweenConfig) {
      if (isAlive()) tween._chainConfigs.push(config);
      return controls;
    },
    get finished() {
      if (tween.id !== capturedId) return Promise.resolve();
      if (tween.state === "completed") return Promise.resolve();
      if (!tween._promise) {
        tween._promise = new Promise<void>((resolve) => {
          tween._resolve = resolve;
        });
      }
      return tween._promise;
    },
  };

  return controls;
}

// ─── Property Read/Write Helpers ─────────────────────────────────────────────

function readProperty(
  target: Record<string, unknown>,
  parts: string[],
): number {
  let obj: unknown = target;
  for (let i = 0; i < parts.length; i++) {
    obj = (obj as Record<string, unknown>)[parts[i]];
  }
  return obj as number;
}

function writeProperty(
  target: Record<string, unknown>,
  parts: string[],
  value: number,
): void {
  let obj: unknown = target;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = (obj as Record<string, unknown>)[parts[i]];
  }
  (obj as Record<string, number>)[parts[parts.length - 1]] = value;
}

// ─── Dead Controls (returned when pool is exhausted) ─────────────────────────

const DEAD_CONTROLS: TweenControls = {
  get id() { return -1; },
  get state(): TweenState { return "killed"; },
  get progress() { return 0; },
  pause() { return DEAD_CONTROLS; },
  resume() { return DEAD_CONTROLS; },
  kill() { return DEAD_CONTROLS; },
  restart() { return DEAD_CONTROLS; },
  seek() { return DEAD_CONTROLS; },
  setSpeed() { return DEAD_CONTROLS; },
  chain() { return DEAD_CONTROLS; },
  get finished() { return Promise.resolve(); },
};

// ─── Timeline Class ──────────────────────────────────────────────────────────

interface TimelineEntry {
  type: "tween" | "callback" | "label";
  startTime: number;
  duration: number;
  tweenConfig?: TweenConfig;
  numberConfig?: NumberTweenConfig;
  callback?: () => void;
  label?: string;
  controls?: TweenControls;
  started: boolean;
  completed: boolean;
}

let _timelineIdCounter = 0;

class Timeline {
  id: number;
  state: TweenState = "idle";
  ignorePause = false;
  speed = 1;
  repeat = 0;
  repeatDelay = 0;
  yoyo = false;
  group = "";

  private _entries: TimelineEntry[] = [];
  private _labels = new Map<string, number>();
  private _playhead = 0;
  private _totalDuration = 0;
  private _lastEntryEnd = 0;
  private _direction: TweenDirection = "forward";
  private _repeatCount = 0;
  private _totalRepeat = 0;
  private _started = false;
  private _manager: TweenManager;

  // Callbacks
  onStart: (() => void) | null = null;
  onUpdate: ((progress: number) => void) | null = null;
  onComplete: (() => void) | null = null;
  onRepeat: ((count: number) => void) | null = null;

  // Promise
  _resolve: (() => void) | null = null;
  _promise: Promise<void> | null = null;

  controls: TimelineControls;

  constructor(manager: TweenManager, config?: TimelineConfig) {
    this._manager = manager;
    this.id = ++_timelineIdCounter;

    if (config) {
      this.repeat = config.repeat ?? 0;
      this.repeatDelay = config.repeatDelay ?? 0;
      this.yoyo = config.yoyo ?? false;
      this.speed = config.speed ?? 1;
      this.ignorePause = config.ignorePause ?? false;
      this.group = config.group ?? "";
      this.onStart = config.onStart ?? null;
      this.onUpdate = config.onUpdate ?? null;
      this.onComplete = config.onComplete ?? null;
      this.onRepeat = config.onRepeat ?? null;
    }

    this._totalRepeat = this.repeat;
    this.state = config?.paused ? "pending" : "playing";
    this.controls = this._createControls();
  }

  private _createControls(): TimelineControls {
    const self = this;
    const ctrl: TimelineControls = {
      get id() { return self.id; },
      get state() { return self.state; },
      get progress() {
        return self._totalDuration > 0 ? self._playhead / self._totalDuration : 0;
      },
      get duration() { return self._totalDuration; },
      add<T extends object>(config: TweenConfig<T>, position?: TimelinePosition) {
        self._addTween(config as TweenConfig, position);
        return ctrl;
      },
      addCallback(callback: () => void, position?: TimelinePosition) {
        const time = self._resolvePosition(position);
        self._entries.push({
          type: "callback",
          startTime: time,
          duration: 0,
          callback,
          started: false,
          completed: false,
        });
        self._recalcDuration();
        return ctrl;
      },
      addLabel(name: string, position?: TimelinePosition) {
        const time = self._resolvePosition(position);
        self._labels.set(name, time);
        self._entries.push({
          type: "label",
          startTime: time,
          duration: 0,
          label: name,
          started: false,
          completed: false,
        });
        if (time > self._lastEntryEnd) self._lastEntryEnd = time;
        return ctrl;
      },
      play() {
        if (self.state === "pending" || self.state === "idle") {
          self.state = "playing";
        }
        return ctrl;
      },
      pause() {
        if (self.state === "playing") self.state = "pending";
        return ctrl;
      },
      resume() {
        if (self.state === "pending") self.state = "playing";
        return ctrl;
      },
      kill() {
        self._killAll();
        self.state = "killed";
        if (self._resolve) self._resolve();
        return ctrl;
      },
      restart() {
        self._killAll();
        self._playhead = 0;
        self._repeatCount = 0;
        self._direction = "forward";
        self.repeat = self._totalRepeat;
        self._started = false;
        for (let i = 0; i < self._entries.length; i++) {
          self._entries[i].started = false;
          self._entries[i].completed = false;
          self._entries[i].controls = undefined;
        }
        self.state = "playing";
        return ctrl;
      },
      seek(timeOrLabel: number | string) {
        let targetTime: number;
        if (typeof timeOrLabel === "string") {
          targetTime = self._labels.get(timeOrLabel) ?? 0;
        } else {
          targetTime = timeOrLabel;
        }
        self._playhead = Math.max(0, Math.min(targetTime, self._totalDuration));
        return ctrl;
      },
      setSpeed(multiplier: number) {
        self.speed = Math.max(0, multiplier);
        return ctrl;
      },
      get finished() {
        if (self.state === "completed") return Promise.resolve();
        if (!self._promise) {
          self._promise = new Promise<void>((resolve) => {
            self._resolve = resolve;
          });
        }
        return self._promise;
      },
    };
    return ctrl;
  }

  private _addTween(config: TweenConfig, position?: TimelinePosition): void {
    const time = this._resolvePosition(position);
    const dur = config.duration ?? 0.3;

    this._entries.push({
      type: "tween",
      startTime: time,
      duration: dur,
      tweenConfig: config,
      started: false,
      completed: false,
    });

    const end = time + dur;
    if (end > this._lastEntryEnd) this._lastEntryEnd = end;
    this._recalcDuration();
  }

  private _resolvePosition(pos?: TimelinePosition): number {
    if (pos === undefined) return this._lastEntryEnd;
    if (typeof pos === "number") return Math.max(0, pos);

    // "<" — start of previous entry
    if (pos === "<") {
      return this._entries.length > 0
        ? this._entries[this._entries.length - 1].startTime
        : 0;
    }

    // "<+=N" or "<-=N" — relative to start of previous entry
    const prevRelMatch = pos.match(/^<([+-]=)(\d+\.?\d*)$/);
    if (prevRelMatch) {
      const base =
        this._entries.length > 0
          ? this._entries[this._entries.length - 1].startTime
          : 0;
      const sign = prevRelMatch[1] === "+=" ? 1 : -1;
      return Math.max(0, base + sign * parseFloat(prevRelMatch[2]));
    }

    // "+=N" or "-=N" — relative to end of timeline
    const relMatch = pos.match(/^([+-]=)(\d+\.?\d*)$/);
    if (relMatch) {
      const sign = relMatch[1] === "+=" ? 1 : -1;
      return Math.max(0, this._lastEntryEnd + sign * parseFloat(relMatch[2]));
    }

    // "label" or "label+=N" or "label-=N"
    const labelMatch = pos.match(/^([a-zA-Z_]\w*)(?:([+-]=)(\d+\.?\d*))?$/);
    if (labelMatch) {
      const labelTime = this._labels.get(labelMatch[1]) ?? this._lastEntryEnd;
      if (labelMatch[2]) {
        const sign = labelMatch[2] === "+=" ? 1 : -1;
        return Math.max(0, labelTime + sign * parseFloat(labelMatch[3]));
      }
      return labelTime;
    }

    return this._lastEntryEnd;
  }

  private _recalcDuration(): void {
    let max = 0;
    for (let i = 0; i < this._entries.length; i++) {
      const end = this._entries[i].startTime + this._entries[i].duration;
      if (end > max) max = end;
    }
    this._totalDuration = max;
  }

  private _killAll(): void {
    for (let i = 0; i < this._entries.length; i++) {
      const entry = this._entries[i];
      if (entry.controls && entry.controls.state !== "completed" && entry.controls.state !== "killed") {
        entry.controls.kill();
      }
    }
  }

  tick(delta: number): void {
    if (this.state !== "playing") return;

    if (!this._started) {
      this._started = true;
      this.onStart?.();
    }

    const dt = delta * this.speed;
    this._playhead += dt;

    // Process entries
    for (let i = 0; i < this._entries.length; i++) {
      const entry = this._entries[i];

      if (entry.started || this._playhead < entry.startTime) continue;

      // Time to start this entry
      entry.started = true;

      if (entry.type === "tween" && entry.tweenConfig) {
        entry.controls = this._manager.create(entry.tweenConfig);
      } else if (entry.type === "callback" && entry.callback) {
        entry.callback();
        entry.completed = true;
      }
    }

    // Report progress
    if (this._totalDuration > 0) {
      this.onUpdate?.(Math.min(this._playhead / this._totalDuration, 1));
    }

    // Check completion
    if (this._playhead >= this._totalDuration) {
      if (this.repeat === -1 || this._repeatCount < this.repeat) {
        this._repeatCount++;
        this._playhead = 0;
        this._started = false;

        if (this.yoyo) {
          this._direction =
            this._direction === "forward" ? "reverse" : "forward";
        }

        // Reset entries for replay
        for (let i = 0; i < this._entries.length; i++) {
          this._entries[i].started = false;
          this._entries[i].completed = false;
          this._entries[i].controls = undefined;
        }

        this.onRepeat?.(this._repeatCount);
      } else {
        this.state = "completed";
        this.onComplete?.();
        if (this._resolve) this._resolve();
      }
    }
  }
}

// ─── TweenManager Class ─────────────────────────────────────────────────────

class TweenManager {
  // Object pool
  private _pool: Tween[] = [];
  private _freeStack: number[] = [];

  // Active list (swap-and-pop)
  private _active: Tween[] = [];
  private _activeCount = 0;

  // Groups
  private _groups = new Map<string, Set<Tween>>();

  // Timelines
  private _timelines: Timeline[] = [];
  private _timelineCount = 0;

  constructor() {
    this._growPool(INITIAL_POOL_SIZE);
  }

  // ── Pool Management ──

  private _growPool(count: number): void {
    const newTotal = Math.min(this._pool.length + count, MAX_POOL_SIZE);
    for (let i = this._pool.length; i < newTotal; i++) {
      this._pool.push(new Tween());
      this._freeStack.push(i);
    }
  }

  private _acquire(): Tween | null {
    if (this._freeStack.length === 0) {
      if (this._pool.length < MAX_POOL_SIZE) {
        this._growPool(Math.min(64, MAX_POOL_SIZE - this._pool.length));
      }
    }
    if (this._freeStack.length === 0) {
      return null;
    }
    return this._pool[this._freeStack.pop()!];
  }

  private _release(tween: Tween): void {
    const idx = this._pool.indexOf(tween);
    if (idx !== -1) {
      tween.reset();
      this._freeStack.push(idx);
    }
  }

  // ── Active List (swap-and-pop) ──

  private _addActive(tween: Tween): void {
    if (this._activeCount < this._active.length) {
      this._active[this._activeCount] = tween;
    } else {
      this._active.push(tween);
    }
    this._activeCount++;
  }

  private _removeActive(index: number): void {
    const last = this._activeCount - 1;
    if (index !== last) {
      this._active[index] = this._active[last];
    }
    this._activeCount--;
  }

  // ── Create API ──

  create<T extends object>(config: TweenConfig<T>): TweenControls {
    const tween = this._acquire();
    if (!tween) return DEAD_CONTROLS;

    tween.id = ++_tweenIdCounter;
    tween.target = config.target as unknown as Record<string, unknown>;
    tween.duration = config.duration ?? 0.3;
    tween.delay = config.delay ?? 0;
    tween.easeFn = resolveEasing(config.ease ?? "quad.out");
    tween.repeat = config.repeat ?? 0;
    tween.repeatDelay = config.repeatDelay ?? 0;
    tween.yoyo = config.yoyo ?? false;
    tween.speed = config.speed ?? 1;
    tween.group = config.group ?? "";
    tween.persist = config.persist ?? false;
    tween.ignorePause = config.ignorePause ?? false;
    tween._totalRepeat = tween.repeat;

    tween.onStart = config.onStart ?? null;
    tween.onUpdate = config.onUpdate ?? null;
    tween.onComplete = config.onComplete ?? null;
    tween.onRepeat = config.onRepeat ?? null;
    tween.onYoyo = config.onYoyo ?? null;
    tween.onKill = config.onKill ?? null;

    // Resolve properties
    this._resolveProps(tween, config.to as Record<string, number>, config.from as Record<string, number> | undefined);

    // Add to group
    if (tween.group) {
      let set = this._groups.get(tween.group);
      if (!set) {
        set = new Set();
        this._groups.set(tween.group, set);
      }
      set.add(tween);
    }

    // Activate
    if (tween.delay > 0) {
      tween.state = "delayed";
    } else {
      tween.state = "playing";
      tween.onStart?.();
    }
    this._addActive(tween);

    return createControls(tween, this);
  }

  createNumber(config: NumberTweenConfig): TweenControls {
    const tween = this._acquire();
    if (!tween) return DEAD_CONTROLS;

    tween.id = ++_tweenIdCounter;
    tween._isNumberTween = true;

    // Scratch target
    const scratchTarget = { value: config.from };
    tween.target = scratchTarget;
    tween.duration = config.duration ?? 0.3;
    tween.delay = config.delay ?? 0;
    tween.easeFn = resolveEasing(config.ease ?? "quad.out");
    tween.repeat = config.repeat ?? 0;
    tween.repeatDelay = config.repeatDelay ?? 0;
    tween.yoyo = config.yoyo ?? false;
    tween.speed = config.speed ?? 1;
    tween.group = config.group ?? "";
    tween.persist = false;
    tween.ignorePause = config.ignorePause ?? false;
    tween._totalRepeat = tween.repeat;

    tween.onStart = config.onStart ?? null;
    tween.onComplete = config.onComplete ?? null;
    tween.onRepeat = config.onRepeat ?? null;
    tween.onYoyo = config.onYoyo ?? null;
    tween.onKill = config.onKill ?? null;
    tween._numberOnUpdate = config.onUpdate ?? null;

    // Single property: "value"
    tween.propCount = 1;
    const prop = tween.props[0];
    prop.key = "value";
    prop.parts = ["value"];
    prop.from = config.from;
    prop.to = config.to;
    prop.delta = config.to - config.from;

    // Add to group
    if (tween.group) {
      let set = this._groups.get(tween.group);
      if (!set) {
        set = new Set();
        this._groups.set(tween.group, set);
      }
      set.add(tween);
    }

    // Activate
    if (tween.delay > 0) {
      tween.state = "delayed";
    } else {
      tween.state = "playing";
      tween.onStart?.();
    }
    this._addActive(tween);

    return createControls(tween, this);
  }

  createTimeline(config?: TimelineConfig): TimelineControls {
    const tl = new Timeline(this, config);

    if (this._timelineCount < this._timelines.length) {
      this._timelines[this._timelineCount] = tl;
    } else {
      this._timelines.push(tl);
    }
    this._timelineCount++;

    return tl.controls;
  }

  // ── Property Resolution ──

  private _resolveProps(
    tween: Tween,
    to: Record<string, number>,
    from?: Record<string, number>,
  ): void {
    let count = 0;
    for (const key in to) {
      if (count >= MAX_PROPERTIES) break;
      const prop = tween.props[count];
      prop.key = key;
      // Reuse or create parts array
      const parts = key.split(".");
      prop.parts = parts;
      prop.to = to[key];
      prop.from =
        from?.[key] ??
        readProperty(tween.target as Record<string, unknown>, parts);
      prop.delta = prop.to - prop.from;
      count++;
    }
    tween.propCount = count;
  }

  // ── Tick (Hot Path) ──

  tick(delta: number): void {
    const phase = useGameStore.getState().phase;
    if (phase === "loading") return;

    const isPlaying = phase === "playing";

    // Iterate backwards for safe swap-and-pop removal
    for (let i = this._activeCount - 1; i >= 0; i--) {
      const tw = this._active[i];

      // Skip paused-game tweens unless they ignore pause
      if (!isPlaying && !tw.ignorePause) continue;

      // Skip manually paused tweens
      if (tw.state === "pending") continue;

      const dt = delta * tw.speed;

      // Handle delay phase
      if (tw.state === "delayed") {
        tw.delayElapsed += dt;
        if (tw.delayElapsed < tw.delay) continue;

        // Delay expired — carry overflow into playing
        const overflow = tw.delayElapsed - tw.delay;
        tw.state = "playing";
        tw.delayElapsed = 0;
        tw.onStart?.();

        // Apply overflow
        if (overflow > 0) {
          tw.elapsed += overflow;
        }

        // If duration is 0, immediate completion will be caught below
      }

      // Playing phase
      if (tw.state === "playing") {
        tw.elapsed += dt;

        // Compute raw progress
        let rawProgress: number;
        if (tw.duration <= 0) {
          rawProgress = 1;
        } else {
          rawProgress = Math.min(tw.elapsed / tw.duration, 1);
        }

        // Apply direction for yoyo
        const effectiveProgress =
          tw.direction === "reverse" ? 1 - rawProgress : rawProgress;

        // Apply easing
        const eased = tw.easeFn(effectiveProgress);
        tw.progress = eased;

        // Interpolate and write properties
        for (let p = 0; p < tw.propCount; p++) {
          const prop = tw.props[p];
          const value = prop.from + prop.delta * eased;
          writeProperty(
            tw.target as Record<string, unknown>,
            prop.parts,
            value,
          );
        }

        // Callbacks
        if (tw._isNumberTween && tw._numberOnUpdate) {
          tw._numberOnUpdate(
            (tw.target as Record<string, number>).value,
            eased,
          );
        }
        tw.onUpdate?.(eased);

        // Check completion
        if (rawProgress >= 1) {
          this._onComplete(tw, i);
        }
      }
    }

    // Tick timelines
    for (let i = this._timelineCount - 1; i >= 0; i--) {
      const tl = this._timelines[i];
      if (!isPlaying && !tl.ignorePause) continue;
      tl.tick(delta);
      if (tl.state === "completed" || tl.state === "killed") {
        const last = this._timelineCount - 1;
        if (i !== last) this._timelines[i] = this._timelines[last];
        this._timelineCount--;
      }
    }
  }

  private _onComplete(tw: Tween, activeIndex: number): void {
    // Check for repeat
    if (tw.repeat === -1 || tw.repeatCount < tw.repeat) {
      tw.repeatCount++;
      const overflow = tw.elapsed - tw.duration;
      tw.elapsed = 0;

      if (tw.yoyo) {
        tw.direction = tw.direction === "forward" ? "reverse" : "forward";
        tw.onYoyo?.(tw.direction);
      }

      if (tw.repeatDelay > 0) {
        tw.state = "delayed";
        tw.delay = tw.repeatDelay;
        tw.delayElapsed = 0;
      } else if (overflow > 0) {
        tw.elapsed = overflow;
      }

      tw.onRepeat?.(tw.repeatCount);
      return;
    }

    // Final completion
    tw.state = "completed";
    tw.onComplete?.();
    if (tw._resolve) tw._resolve();

    // Fire chain
    for (let c = 0; c < tw._chainConfigs.length; c++) {
      this.create(tw._chainConfigs[c]);
    }

    // Remove from active list
    this._removeActive(activeIndex);

    // Remove from group
    if (tw.group) {
      this._groups.get(tw.group)?.delete(tw);
    }

    // Return to pool unless persisted
    if (!tw.persist) {
      this._release(tw);
    }
  }

  // ── Kill ──

  _killTween(tween: Tween): void {
    if (tween.state === "killed" || tween.state === "idle") return;

    tween.state = "killed";
    tween.onKill?.();
    if (tween._resolve) tween._resolve();

    // Remove from group
    if (tween.group) {
      this._groups.get(tween.group)?.delete(tween);
    }

    // Remove from active list
    for (let i = 0; i < this._activeCount; i++) {
      if (this._active[i] === tween) {
        this._removeActive(i);
        break;
      }
    }

    this._release(tween);
  }

  // ── Kill by ID (for hook cleanup) ──

  killById(id: number): void {
    for (let i = 0; i < this._activeCount; i++) {
      if (this._active[i].id === id) {
        this._killTween(this._active[i]);
        return;
      }
    }
  }

  // ── Group API ──

  getGroup(name: string): TweenGroupControls {
    const self = this;
    return {
      pause() {
        const set = self._groups.get(name);
        if (!set) return;
        for (const tw of set) {
          if (tw.state === "playing") tw.state = "pending";
        }
      },
      resume() {
        const set = self._groups.get(name);
        if (!set) return;
        for (const tw of set) {
          if (tw.state === "pending") tw.state = "playing";
        }
      },
      kill() {
        const set = self._groups.get(name);
        if (!set) return;
        const tweens = Array.from(set);
        for (const tw of tweens) {
          self._killTween(tw);
        }
      },
      get count() {
        return self._groups.get(name)?.size ?? 0;
      },
    };
  }

  // ── Global Controls ──

  pauseAll(): void {
    for (let i = 0; i < this._activeCount; i++) {
      if (this._active[i].state === "playing") {
        this._active[i].state = "pending";
      }
    }
  }

  resumeAll(): void {
    for (let i = 0; i < this._activeCount; i++) {
      if (this._active[i].state === "pending") {
        this._active[i].state = "playing";
      }
    }
  }

  killAll(): void {
    for (let i = this._activeCount - 1; i >= 0; i--) {
      this._killTween(this._active[i]);
    }
    for (let i = this._timelineCount - 1; i >= 0; i--) {
      this._timelines[i].controls.kill();
    }
    this._timelineCount = 0;
  }

  // ── Destroy ──

  destroy(): void {
    this.killAll();
    this._pool.length = 0;
    this._freeStack.length = 0;
    this._active.length = 0;
    this._activeCount = 0;
    this._groups.clear();
    this._timelines.length = 0;
    this._timelineCount = 0;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: TweenManager | null = null;

export function getTweenManager(): TweenManager {
  if (!_instance) _instance = new TweenManager();
  return _instance;
}

export function destroyTweenManager(): void {
  _instance?.destroy();
  _instance = null;
}
