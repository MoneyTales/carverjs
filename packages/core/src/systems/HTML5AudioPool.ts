import type { SoundState } from "../types";

// ── HTML5 Audio Fallback ────────────────────────────────────────────────────────
// Used when Web Audio API is unavailable. Provides basic playback via a pool of
// pre-created <audio> elements. No spatial audio, no gain automation.

const UNLOCK_EVENTS = [
  "click", "touchstart", "touchend", "keydown", "keyup",
  "mousedown", "pointerdown", "pointerup",
];

export interface HTML5Instance {
  id: number;
  element: HTMLAudioElement;
  state: SoundState;
  onEnd: (() => void) | null;
}

export class HTML5AudioPool {
  private _pool: HTMLAudioElement[] = [];
  private _active = new Map<number, HTML5Instance>();
  private _nextId = 0;
  private _unlocked = false;
  private _poolSize: number;

  // Music state (two elements for crossfade)
  private _musicElement: HTMLAudioElement | null = null;
  private _musicFadingOut: HTMLAudioElement | null = null;
  private _musicPlaying = false;
  private _musicPaused = false;
  private _musicVolume = 1;
  private _fadeOutStart = 0;
  private _fadeOutDuration = 0;

  constructor(poolSize = 10) {
    this._poolSize = poolSize;
    this._createPool();
    this._setupUnlock();
  }

  private _createPool(): void {
    for (let i = 0; i < this._poolSize; i++) {
      this._pool.push(new Audio());
    }
  }

  private _setupUnlock(): void {
    const unlock = () => {
      if (this._unlocked) return;

      // iOS Safari requires each <audio> element to be "touched" during a user gesture
      for (const audio of this._pool) {
        audio.load();
      }

      this._unlocked = true;
      UNLOCK_EVENTS.forEach((e) =>
        document.removeEventListener(e, unlock, true),
      );
    };

    UNLOCK_EVENTS.forEach((e) =>
      document.addEventListener(e, unlock, true),
    );
  }

  get isUnlocked(): boolean {
    return this._unlocked;
  }

  /** Acquire a free audio element from the pool. Steals oldest if full. */
  private _acquire(): HTMLAudioElement | null {
    // Find a free element (not currently playing)
    for (const audio of this._pool) {
      if (audio.paused && !audio.src) return audio;
    }
    // Find any paused element
    for (const audio of this._pool) {
      if (audio.paused) return audio;
    }
    // Steal the first pool element
    const stolen = this._pool[0];
    if (stolen) {
      stolen.pause();
      stolen.currentTime = 0;
      stolen.src = "";
      return stolen;
    }
    return null;
  }

  play(
    url: string,
    volume: number,
    loop: boolean,
    rate: number,
    spriteOffset?: number,
    spriteDuration?: number,
    onEnd?: () => void,
  ): HTML5Instance | null {
    const audio = this._acquire();
    if (!audio) return null;

    const id = ++this._nextId;

    audio.src = url;
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.loop = loop && !spriteDuration; // Can't loop sprites with HTML5
    audio.playbackRate = rate;

    // Sprite: seek to offset and stop at offset + duration
    let spriteTimer: ReturnType<typeof setTimeout> | null = null;
    if (spriteOffset !== undefined && spriteOffset > 0) {
      audio.currentTime = spriteOffset;
    }

    const instance: HTML5Instance = { id, element: audio, state: "playing", onEnd: onEnd ?? null };
    this._active.set(id, instance);

    const cleanup = () => {
      if (instance.state !== "playing") return;
      instance.state = "stopped";
      instance.onEnd?.();
      this._active.delete(id);
      audio.pause();
      audio.src = "";
      if (spriteTimer) clearTimeout(spriteTimer);
    };

    // Sprite duration: manually stop after duration
    if (spriteDuration && spriteDuration > 0) {
      spriteTimer = setTimeout(cleanup, (spriteDuration / rate) * 1000);
    }

    audio.onended = () => {
      if (spriteTimer) clearTimeout(spriteTimer);
      cleanup();
    };

    audio.play().catch(() => {
      instance.state = "stopped";
      this._active.delete(id);
    });

    return instance;
  }

  stop(instance: HTML5Instance): void {
    if (instance.state === "stopped") return;
    instance.state = "stopped";
    this._active.delete(instance.id);
    instance.element.pause();
    instance.element.currentTime = 0;
    instance.element.src = "";
  }

  pause(instance: HTML5Instance): void {
    if (instance.state !== "playing") return;
    instance.state = "paused";
    instance.element.pause();
  }

  resume(instance: HTML5Instance): void {
    if (instance.state !== "paused") return;
    instance.state = "playing";
    instance.element.play().catch(() => {
      instance.state = "stopped";
      this._active.delete(instance.id);
    });
  }

  setVolume(instance: HTML5Instance, volume: number): void {
    instance.element.volume = Math.max(0, Math.min(1, volume));
  }

  setRate(instance: HTML5Instance, rate: number): void {
    instance.element.playbackRate = rate;
  }

  // ── Music (HTML5 fallback) ──────────────────────────────────────────────────

  playMusic(url: string, volume: number, loop: boolean, crossfadeDuration: number): void {
    // Fade out current music
    if (this._musicElement && this._musicPlaying) {
      this._musicFadingOut = this._musicElement;
      this._fadeOutStart = performance.now();
      this._fadeOutDuration = crossfadeDuration * 1000;
    }

    // Start new music
    const audio = new Audio(url);
    audio.loop = loop;
    audio.volume = this._musicPlaying ? 0 : volume; // Start at 0 if crossfading
    this._musicElement = audio;
    this._musicVolume = volume;
    this._musicPlaying = true;
    this._musicPaused = false;

    audio.play().catch(() => {
      this._musicPlaying = false;
    });

    audio.onended = () => {
      if (this._musicElement === audio) {
        this._musicPlaying = false;
        this._musicElement = null;
      }
    };
  }

  stopMusic(fadeOut = 0): void {
    if (!this._musicElement) return;

    if (fadeOut > 0) {
      this._musicFadingOut = this._musicElement;
      this._fadeOutStart = performance.now();
      this._fadeOutDuration = fadeOut * 1000;
    } else {
      this._musicElement.pause();
      this._musicElement.src = "";
    }

    this._musicElement = null;
    this._musicPlaying = false;
    this._musicPaused = false;
  }

  pauseMusic(): void {
    if (!this._musicPlaying || this._musicPaused || !this._musicElement) return;
    this._musicElement.pause();
    this._musicPaused = true;
  }

  resumeMusic(): void {
    if (!this._musicPaused || !this._musicElement) return;
    this._musicElement.play().catch(() => {});
    this._musicPaused = false;
  }

  isMusicPlaying(): boolean {
    return this._musicPlaying && !this._musicPaused;
  }

  /** Called per-frame by AudioManager to drive HTML5 music crossfade interpolation. */
  flushMusic(): void {
    // Drive crossfade for music (fade in new, fade out old)
    if (this._musicFadingOut && this._fadeOutDuration > 0) {
      const elapsed = performance.now() - this._fadeOutStart;
      const t = Math.min(elapsed / this._fadeOutDuration, 1);

      // Fade out old
      this._musicFadingOut.volume = Math.max(0, (1 - t) * this._musicVolume);

      // Fade in new
      if (this._musicElement) {
        this._musicElement.volume = Math.min(1, t * this._musicVolume);
      }

      // Done fading
      if (t >= 1) {
        this._musicFadingOut.pause();
        this._musicFadingOut.src = "";
        this._musicFadingOut = null;
      }
    }
  }

  /** Pause all active sounds (for game phase pause). */
  pauseAll(): void {
    for (const [, inst] of this._active) {
      if (inst.state === "playing") {
        inst.element.pause();
      }
    }
    if (this._musicElement && this._musicPlaying && !this._musicPaused) {
      this._musicElement.pause();
    }
  }

  /** Resume all sounds (for game phase resume). */
  resumeAll(): void {
    for (const [, inst] of this._active) {
      if (inst.state === "playing") {
        inst.element.play().catch(() => {});
      }
    }
    if (this._musicElement && this._musicPlaying && !this._musicPaused) {
      this._musicElement.play().catch(() => {});
    }
  }

  destroy(): void {
    for (const [, inst] of this._active) {
      inst.element.pause();
      inst.element.src = "";
    }
    this._active.clear();

    if (this._musicElement) {
      this._musicElement.pause();
      this._musicElement.src = "";
      this._musicElement = null;
    }
    if (this._musicFadingOut) {
      this._musicFadingOut.pause();
      this._musicFadingOut.src = "";
      this._musicFadingOut = null;
    }

    this._pool = [];
    this._musicPlaying = false;

    UNLOCK_EVENTS.forEach((e) =>
      document.removeEventListener(e, () => {}, true),
    );
  }
}
