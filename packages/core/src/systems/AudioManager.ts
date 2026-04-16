import { Vector3 } from "three";
import type { Object3D } from "three";
import type { RefObject } from "react";
import { MusicEngine } from "./MusicEngine";
import { HTML5AudioPool, type HTML5Instance } from "./HTML5AudioPool";
import type {
  AudioChannel,
  SoundState,
  SoundDefinition,
  PlaySoundOptions,
  SoundHandle,
  MusicOptions,
  GamePhase,
} from "../types";

// ── Pre-allocated vectors for zero-GC spatial updates ───────────────────────────

const _emitterPos = new Vector3();
const _listenerPos = new Vector3();
const _listenerDir = new Vector3();
const _listenerUp = new Vector3();

// ── Format detection (runs once at module load) ─────────────────────────────────

const _supportedFormats: Map<string, boolean> = /* @__PURE__ */ (() => {
  if (typeof Audio === "undefined") return new Map();
  const audio = new Audio();
  return new Map([
    ["mp3", audio.canPlayType("audio/mpeg") !== ""],
    ["ogg", audio.canPlayType('audio/ogg; codecs="vorbis"') !== ""],
    ["wav", audio.canPlayType('audio/wav; codecs="1"') !== ""],
    ["webm", audio.canPlayType('audio/webm; codecs="vorbis"') !== ""],
    ["aac", audio.canPlayType("audio/aac") !== ""],
    ["flac", audio.canPlayType("audio/flac") !== ""],
  ]);
})();

function resolveUrl(src: string | string[]): string | null {
  const urls = Array.isArray(src) ? src : [src];
  for (const url of urls) {
    const ext = url.split(".").pop()?.toLowerCase();
    if (ext && (_supportedFormats.get(ext) ?? true)) return url;
  }
  return urls[0] ?? null;
}

// ── Internal types ──────────────────────────────────────────────────────────────

interface SoundInstance {
  id: number;
  name: string;
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  pannerNode: PannerNode | null;
  state: SoundState;
  startTime: number;
  pauseOffset: number;
  buffer: AudioBuffer;
  loop: boolean;
  rate: number;
  volume: number;
  channel: AudioChannel;
  spriteOffset: number;
  spriteDuration: number;
  onEnd: (() => void) | null;
}

interface SpatialTracker {
  instanceId: number;
  ref: RefObject<Object3D | null>;
  pannerNode: PannerNode;
}

interface QueuedPlay {
  name: string;
  options?: PlaySoundOptions;
}

interface QueuedMusic {
  src: string | string[];
  options?: MusicOptions;
}

// HTML5 wrapper for uniform SoundHandle interface
interface HTML5SoundRef {
  id: number;
  name: string;
  instance: HTML5Instance;
}

const CHANNELS: AudioChannel[] = ["master", "sfx", "music", "ui", "ambient", "voice"];

const UNLOCK_EVENTS = [
  "click", "touchstart", "touchend", "keydown", "keyup",
  "mousedown", "pointerdown", "pointerup",
];

// ── AudioManager class ──────────────────────────────────────────────────────────

class AudioManager {
  // Web Audio API state
  private _context: AudioContext | null = null;
  private _masterGain: GainNode | null = null;
  private _channelGains = new Map<AudioChannel, GainNode>();
  private _musicEngine: MusicEngine | null = null;

  // HTML5 fallback
  private _useHTML5 = false;
  private _html5Pool: HTML5AudioPool | null = null;
  private _html5Refs = new Map<number, HTML5SoundRef>();

  // Shared state
  private _channelVolumes = new Map<AudioChannel, number>();
  private _channelMuted = new Map<AudioChannel, boolean>();
  private _bufferCache = new Map<string, AudioBuffer>();
  private _pendingLoads = new Map<string, Promise<AudioBuffer>>();
  private _definitions = new Map<string, SoundDefinition>();
  private _active = new Map<number, SoundInstance>();
  private _activeByName = new Map<string, Set<number>>();
  private _spatialTrackers = new Map<number, SpatialTracker>();
  private _listenerSource: Object3D | null = null;
  private _customListener: Object3D | null = null;

  private _unlocked = false;
  private _ready = false;
  private _gamePaused = false;
  private _nextId = 0;
  private _lastPlayed = new Map<string, number>();
  private _queuedPlays: QueuedPlay[] = [];
  private _queuedMusic: QueuedMusic | null = null;

  // ── useSyncExternalStore subscriber pattern ──

  private _stateVersion = 0;
  private _subscribers = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this._subscribers.add(cb);
    return () => { this._subscribers.delete(cb); };
  };

  getSnapshot = (): number => this._stateVersion;

  private _notify(): void {
    this._stateVersion++;
    for (const cb of this._subscribers) cb();
  }

  get isUnlocked(): boolean { return this._unlocked; }
  get isReady(): boolean { return this._ready; }

  // ── Initialization ──────────────────────────────────────────────────────────

  init(): void {
    if (this._context || this._html5Pool) return;

    // Initialize default channel volumes
    for (const ch of CHANNELS) {
      this._channelVolumes.set(ch, 1);
      this._channelMuted.set(ch, false);
    }

    // Detect Web Audio API availability
    if (typeof AudioContext === "undefined") {
      // HTML5 Audio fallback
      this._useHTML5 = true;
      this._html5Pool = new HTML5AudioPool();
      this._ready = true;
      this._unlocked = true; // HTML5 pool handles its own unlock
      this._notify();
      return;
    }

    // Web Audio API path
    this._context = new AudioContext();

    // Build gain chain: channelGain → masterGain → destination
    this._masterGain = this._context.createGain();
    this._masterGain.connect(this._context.destination);

    for (const ch of CHANNELS) {
      if (ch === "master") {
        this._channelGains.set(ch, this._masterGain);
      } else {
        const gain = this._context.createGain();
        gain.connect(this._masterGain);
        this._channelGains.set(ch, gain);
      }
    }

    // Music engine
    this._musicEngine = new MusicEngine(
      this._context,
      this._channelGains.get("music")!,
    );

    // Unlock strategy
    this._setupUnlock();

    // Already running (user already interacted before <Game> mounted)
    if (this._context.state === "running") {
      this._onUnlocked();
    }
  }

  destroy(): void {
    // Stop all Web Audio instances
    for (const [, inst] of this._active) {
      try { inst.source.stop(); } catch { /* already stopped */ }
      inst.gainNode.disconnect();
      if (inst.pannerNode) inst.pannerNode.disconnect();
    }
    this._active.clear();
    this._activeByName.clear();
    this._spatialTrackers.clear();

    // Destroy music engine
    this._musicEngine?.destroy();

    // Close AudioContext
    this._context?.close();
    this._context = null;
    this._masterGain = null;
    this._channelGains.clear();
    this._musicEngine = null;

    // Destroy HTML5 pool
    this._html5Pool?.destroy();
    this._html5Pool = null;
    this._html5Refs.clear();

    // Clear caches
    this._bufferCache.clear();
    this._pendingLoads.clear();
    this._definitions.clear();
    this._lastPlayed.clear();
    this._queuedPlays = [];
    this._queuedMusic = null;
    this._unlocked = false;
    this._ready = false;
    this._gamePaused = false;

    // Remove DOM listeners
    UNLOCK_EVENTS.forEach((e) =>
      document.removeEventListener(e, this._unlockHandler, true),
    );
    document.removeEventListener("visibilitychange", this._visibilityHandler);
  }

  // ── AudioContext Unlock ─────────────────────────────────────────────────────

  private _unlockHandler = (): void => {
    if (this._unlocked || !this._context) return;

    if (this._context.state === "suspended") {
      this._context.resume().then(() => {
        if (!this._unlocked) this._onUnlocked();
      });
    } else {
      this._onUnlocked();
    }

    // iOS: play and stop a silent buffer during the user gesture
    const silentBuffer = this._context.createBuffer(1, 1, 22050);
    const source = this._context.createBufferSource();
    source.buffer = silentBuffer;
    source.connect(this._context.destination);
    source.start(0);
    source.stop(0);
  };

  private _visibilityHandler = (): void => {
    if (!this._context) return;
    if (!document.hidden && this._context.state === "suspended" && this._unlocked) {
      this._context.resume();
    }
  };

  private _setupUnlock(): void {
    UNLOCK_EVENTS.forEach((e) =>
      document.addEventListener(e, this._unlockHandler, true),
    );

    document.addEventListener("visibilitychange", this._visibilityHandler);

    if (this._context) {
      this._context.onstatechange = () => {
        if (!this._context) return;

        if (this._context.state === "running" && !this._unlocked) {
          this._onUnlocked();
        }

        // iOS interruption: context goes to "suspended" or "interrupted"
        if (
          this._context.state === "suspended" ||
          (this._context.state as string) === "interrupted"
        ) {
          if (this._unlocked) {
            this._unlocked = false;
            this._notify();
            // Re-register unlock listeners for next gesture
            UNLOCK_EVENTS.forEach((e) =>
              document.addEventListener(e, this._unlockHandler, true),
            );
          }
        }
      };
    }
  }

  private _onUnlocked(): void {
    this._unlocked = true;
    this._ready = true;

    // Remove unlock listeners
    UNLOCK_EVENTS.forEach((e) =>
      document.removeEventListener(e, this._unlockHandler, true),
    );

    // Play queued music
    if (this._queuedMusic) {
      const { src, options } = this._queuedMusic;
      this._queuedMusic = null;
      this.playMusic(src, options);
    }

    // Play queued sounds (looping/ambient only)
    const queued = this._queuedPlays.splice(0);
    for (const { name, options } of queued) {
      this.play(name, options);
    }

    this._notify();
  }

  // ── Sound Registration ──────────────────────────────────────────────────────

  registerSound(name: string, def: SoundDefinition): void {
    this._definitions.set(name, def);
    if (def.preload !== false && !this._useHTML5) {
      this._loadByName(name).catch(() => {});
    }
  }

  unregisterSound(name: string): void {
    this._definitions.delete(name);
    this.stopByName(name);
  }

  // ── Buffer Loading (Web Audio only) ─────────────────────────────────────────

  private async _loadByName(name: string): Promise<AudioBuffer> {
    const def = this._definitions.get(name);
    if (!def) throw new Error(`Sound "${name}" is not registered`);
    return this._loadBuffer(def.src);
  }

  private async _loadBuffer(src: string | string[]): Promise<AudioBuffer> {
    if (!this._context) throw new Error("AudioManager not initialized");

    const url = resolveUrl(src);
    if (!url) throw new Error("No supported audio format found");

    // Check cache
    const cached = this._bufferCache.get(url);
    if (cached) return cached;

    // Deduplicate pending loads
    const pending = this._pendingLoads.get(url);
    if (pending) return pending;

    const promise = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this._context!.decodeAudioData(arrayBuffer);
      this._bufferCache.set(url, audioBuffer);
      return audioBuffer;
    })();

    this._pendingLoads.set(url, promise);
    try {
      return await promise;
    } finally {
      this._pendingLoads.delete(url);
    }
  }

  // ── Sound Playback ──────────────────────────────────────────────────────────

  play(name: string, options: PlaySoundOptions = {}): SoundHandle | null {
    const def = this._definitions.get(name);
    if (!def) {
      console.warn(`[CarverJS Audio] Sound "${name}" is not registered`);
      return null;
    }

    // Queue if not ready
    if (!this._ready) {
      if (options.loop || def.loop || def.channel === "music" || def.channel === "ambient") {
        this._queuedPlays.push({ name, options });
      }
      return null;
    }

    // HTML5 fallback path
    if (this._useHTML5) {
      return this._playHTML5(name, def, options);
    }

    // Web Audio path
    return this._playWebAudio(name, def, options);
  }

  private _playHTML5(
    name: string,
    def: SoundDefinition,
    options: PlaySoundOptions,
  ): SoundHandle | null {
    if (!this._html5Pool) return null;

    const url = resolveUrl(def.src);
    if (!url) return null;

    const volume = options.volume ?? def.volume ?? 1;
    const rate = options.rate ?? def.rate ?? 1;
    const loop = options.loop ?? def.loop ?? false;

    // Resolve sprite
    let spriteOffset: number | undefined;
    let spriteDuration: number | undefined;
    if (options.sprite && def.sprites?.[options.sprite]) {
      const region = def.sprites[options.sprite];
      spriteOffset = region.start;
      spriteDuration = region.duration;
    }

    // Channel volume
    const channelVol = this._channelMuted.get(def.channel ?? "sfx")
      ? 0
      : (this._channelVolumes.get(def.channel ?? "sfx") ?? 1);
    const masterVol = this._channelMuted.get("master")
      ? 0
      : (this._channelVolumes.get("master") ?? 1);
    const finalVol = volume * channelVol * masterVol;

    const instance = this._html5Pool.play(
      url, finalVol, loop, rate, spriteOffset, spriteDuration, options.onEnd,
    );
    if (!instance) return null;

    const ref: HTML5SoundRef = { id: instance.id, name, instance };
    this._html5Refs.set(instance.id, ref);

    // Track by name
    let nameSet = this._activeByName.get(name);
    if (!nameSet) { nameSet = new Set(); this._activeByName.set(name, nameSet); }
    nameSet.add(instance.id);

    return this._createHTML5Handle(ref);
  }

  private _createHTML5Handle(ref: HTML5SoundRef): SoundHandle {
    const pool = this._html5Pool!;
    return {
      get id() { return ref.instance.id; },
      get state() { return ref.instance.state; },
      stop: () => {
        pool.stop(ref.instance);
        this._html5Refs.delete(ref.id);
        this._activeByName.get(ref.name)?.delete(ref.id);
      },
      pause: () => pool.pause(ref.instance),
      resume: () => pool.resume(ref.instance),
      fade: () => { /* Not supported in HTML5 mode */ },
      setVolume: (v) => pool.setVolume(ref.instance, v),
      setRate: (r) => pool.setRate(ref.instance, r),
    };
  }

  private _playWebAudio(
    name: string,
    def: SoundDefinition,
    options: PlaySoundOptions,
  ): SoundHandle | null {
    if (!this._context) return null;
    const ctx = this._context;

    // Cooldown check
    if (def.cooldown) {
      const now = ctx.currentTime;
      const lastPlayed = this._lastPlayed.get(name) ?? 0;
      if (now - lastPlayed < def.cooldown) return null;
      this._lastPlayed.set(name, now);
    }

    // maxInstances: steal oldest if at limit
    const maxInstances = def.maxInstances ?? 5;
    const activeSet = this._activeByName.get(name);
    if (activeSet && activeSet.size >= maxInstances) {
      const oldestId = activeSet.values().next().value;
      if (oldestId !== undefined) {
        const oldest = this._active.get(oldestId);
        if (oldest) this._stopInstance(oldest);
      }
    }

    // Get buffer (must be preloaded or cached)
    const url = resolveUrl(def.src);
    if (!url) return null;
    const buffer = this._bufferCache.get(url);

    if (!buffer) {
      // Buffer not loaded yet — load and play async (no handle returned)
      this._loadByName(name)
        .then((buf) => this._playWithBuffer(name, buf, def, options))
        .catch((err) => {
          console.warn(`[CarverJS Audio] Failed to load "${name}":`, err);
          options.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
      return null;
    }

    return this._playWithBuffer(name, buffer, def, options);
  }

  private _playWithBuffer(
    name: string,
    buffer: AudioBuffer,
    def: SoundDefinition,
    options: PlaySoundOptions,
  ): SoundHandle | null {
    if (!this._context) return null;
    const ctx = this._context;
    const channel = def.channel ?? "sfx";
    const channelGain = this._channelGains.get(channel);
    if (!channelGain) return null;

    // Resolve sprite
    let spriteOffset = 0;
    let spriteDuration = 0;
    let spriteLoop = false;
    if (options.sprite && def.sprites?.[options.sprite]) {
      const region = def.sprites[options.sprite];
      spriteOffset = region.start;
      spriteDuration = region.duration;
      spriteLoop = region.loop ?? false;
    }

    const instanceVolume = options.volume ?? def.volume ?? 1;
    const instanceRate = options.rate ?? def.rate ?? 1;
    const instanceLoop = options.loop ?? spriteLoop ?? def.loop ?? false;

    // Create source node
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = instanceRate;

    if (instanceLoop) {
      source.loop = true;
      if (spriteDuration > 0) {
        source.loopStart = spriteOffset;
        source.loopEnd = spriteOffset + spriteDuration;
      }
    }

    // Instance gain node
    const gainNode = ctx.createGain();
    if (options.fadeIn && options.fadeIn > 0) {
      gainNode.gain.setValueAtTime(0, ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(instanceVolume, ctx.currentTime + options.fadeIn);
    } else {
      gainNode.gain.setValueAtTime(instanceVolume, ctx.currentTime);
    }

    // Spatial audio (PannerNode)
    let pannerNode: PannerNode | null = null;
    if (options.spatial) {
      pannerNode = new PannerNode(ctx, {
        panningModel: options.spatial.panningModel ?? "HRTF",
        distanceModel: options.spatial.distanceModel ?? "inverse",
        refDistance: options.spatial.refDistance ?? 1,
        maxDistance: options.spatial.maxDistance ?? 100,
        rolloffFactor: options.spatial.rolloffFactor ?? 1,
        coneInnerAngle: options.spatial.coneInnerAngle ?? 360,
        coneOuterAngle: options.spatial.coneOuterAngle ?? 360,
        coneOuterGain: options.spatial.coneOuterGain ?? 0,
      });

      // Set initial position from Object3D ref
      const obj = options.spatial.ref.current;
      if (obj) {
        obj.getWorldPosition(_emitterPos);
        pannerNode.positionX.value = _emitterPos.x;
        pannerNode.positionY.value = _emitterPos.y;
        pannerNode.positionZ.value = _emitterPos.z;
      }

      source.connect(pannerNode);
      pannerNode.connect(gainNode);
    } else {
      source.connect(gainNode);
    }

    gainNode.connect(channelGain);

    // Create instance
    const id = ++this._nextId;
    const instance: SoundInstance = {
      id,
      name,
      source,
      gainNode,
      pannerNode,
      state: "playing",
      startTime: ctx.currentTime,
      pauseOffset: 0,
      buffer,
      loop: instanceLoop,
      rate: instanceRate,
      volume: instanceVolume,
      channel,
      spriteOffset,
      spriteDuration,
      onEnd: options.onEnd ?? null,
    };

    // Track
    this._active.set(id, instance);
    let nameSet = this._activeByName.get(name);
    if (!nameSet) { nameSet = new Set(); this._activeByName.set(name, nameSet); }
    nameSet.add(id);

    // Spatial tracking
    if (pannerNode && options.spatial && options.spatial.trackPosition !== false) {
      this._spatialTrackers.set(id, {
        instanceId: id,
        ref: options.spatial.ref,
        pannerNode,
      });
    }

    // Start playback
    const delay = options.delay ?? 0;
    if (spriteDuration > 0 && !instanceLoop) {
      source.start(ctx.currentTime + delay, spriteOffset, spriteDuration);
    } else {
      source.start(ctx.currentTime + delay, spriteOffset);
    }

    // Handle natural end
    source.addEventListener("ended", () => {
      if (instance.state !== "playing") return;
      instance.state = "stopped";
      instance.onEnd?.();
      this._removeInstance(instance);
    });

    return this._createHandle(instance);
  }

  // ── Sound Handle (Web Audio) ────────────────────────────────────────────────

  private _createHandle(instance: SoundInstance): SoundHandle {
    return {
      get id() { return instance.id; },
      get state() { return instance.state; },
      stop: () => this._stopInstance(instance),
      pause: () => this._pauseInstance(instance),
      resume: () => this._resumeInstance(instance),
      fade: (from, to, dur) => this._fadeInstance(instance, from, to, dur),
      setVolume: (v) => this._setInstanceVolume(instance, v),
      setRate: (r) => this._setInstanceRate(instance, r),
    };
  }

  private _stopInstance(instance: SoundInstance): void {
    if (instance.state === "stopped") return;
    instance.state = "stopped";
    this._removeInstance(instance);
    try { instance.source.stop(); } catch { /* already stopped */ }
    instance.gainNode.disconnect();
    if (instance.pannerNode) instance.pannerNode.disconnect();
  }

  private _pauseInstance(instance: SoundInstance): void {
    if (instance.state !== "playing" || !this._context) return;
    instance.pauseOffset += this._context.currentTime - instance.startTime;
    instance.state = "paused";
    try { instance.source.stop(); } catch { /* already stopped */ }
  }

  private _resumeInstance(instance: SoundInstance): void {
    if (instance.state !== "paused" || !this._context) return;

    const ctx = this._context;
    const source = ctx.createBufferSource();
    source.buffer = instance.buffer;
    source.playbackRate.value = instance.rate;

    if (instance.loop) {
      source.loop = true;
      if (instance.spriteDuration > 0) {
        source.loopStart = instance.spriteOffset;
        source.loopEnd = instance.spriteOffset + instance.spriteDuration;
      }
    }

    if (instance.pannerNode) {
      source.connect(instance.pannerNode);
    } else {
      source.connect(instance.gainNode);
    }

    const offset = instance.spriteOffset + instance.pauseOffset;
    if (instance.spriteDuration > 0 && !instance.loop) {
      const remaining = instance.spriteDuration - instance.pauseOffset;
      if (remaining <= 0) {
        instance.state = "stopped";
        instance.onEnd?.();
        this._removeInstance(instance);
        return;
      }
      source.start(0, offset, remaining);
    } else {
      source.start(0, offset);
    }

    instance.source = source;
    instance.startTime = ctx.currentTime;
    instance.state = "playing";

    source.addEventListener("ended", () => {
      if (instance.state !== "playing") return;
      instance.state = "stopped";
      instance.onEnd?.();
      this._removeInstance(instance);
    });
  }

  private _fadeInstance(instance: SoundInstance, from: number, to: number, duration: number): void {
    if (!this._context || instance.state === "stopped") return;
    instance.gainNode.gain.setValueAtTime(from, this._context.currentTime);
    instance.gainNode.gain.linearRampToValueAtTime(to, this._context.currentTime + duration);
    instance.volume = to;
  }

  private _setInstanceVolume(instance: SoundInstance, volume: number): void {
    if (!this._context || instance.state === "stopped") return;
    instance.gainNode.gain.setValueAtTime(volume, this._context.currentTime);
    instance.volume = volume;
  }

  private _setInstanceRate(instance: SoundInstance, rate: number): void {
    if (instance.state === "stopped") return;
    instance.source.playbackRate.value = rate;
    instance.rate = rate;
  }

  private _removeInstance(instance: SoundInstance): void {
    this._active.delete(instance.id);
    const nameSet = this._activeByName.get(instance.name);
    if (nameSet) {
      nameSet.delete(instance.id);
      if (nameSet.size === 0) this._activeByName.delete(instance.name);
    }
    this._spatialTrackers.delete(instance.id);
  }

  // ── Global Sound Operations ─────────────────────────────────────────────────

  stopByName(name: string): void {
    if (this._useHTML5) {
      for (const [id, ref] of this._html5Refs) {
        if (ref.name === name) {
          this._html5Pool!.stop(ref.instance);
          this._html5Refs.delete(id);
        }
      }
      this._activeByName.delete(name);
      return;
    }

    const nameSet = this._activeByName.get(name);
    if (!nameSet) return;
    for (const id of [...nameSet]) {
      const inst = this._active.get(id);
      if (inst) this._stopInstance(inst);
    }
  }

  pauseByName(name: string): void {
    if (this._useHTML5) {
      for (const [, ref] of this._html5Refs) {
        if (ref.name === name) this._html5Pool!.pause(ref.instance);
      }
      return;
    }

    const nameSet = this._activeByName.get(name);
    if (!nameSet) return;
    for (const id of nameSet) {
      const inst = this._active.get(id);
      if (inst) this._pauseInstance(inst);
    }
  }

  resumeByName(name: string): void {
    if (this._useHTML5) {
      for (const [, ref] of this._html5Refs) {
        if (ref.name === name) this._html5Pool!.resume(ref.instance);
      }
      return;
    }

    const nameSet = this._activeByName.get(name);
    if (!nameSet) return;
    for (const id of nameSet) {
      const inst = this._active.get(id);
      if (inst) this._resumeInstance(inst);
    }
  }

  isSoundPlaying(name: string): boolean {
    if (this._useHTML5) {
      for (const [, ref] of this._html5Refs) {
        if (ref.name === name && ref.instance.state === "playing") return true;
      }
      return false;
    }

    const nameSet = this._activeByName.get(name);
    if (!nameSet) return false;
    for (const id of nameSet) {
      const inst = this._active.get(id);
      if (inst && inst.state === "playing") return true;
    }
    return false;
  }

  // ── Volume Control ──────────────────────────────────────────────────────────

  setChannelVolume(channel: AudioChannel, volume: number): void {
    this._channelVolumes.set(channel, volume);
    if (this._channelMuted.get(channel)) return;

    if (!this._useHTML5) {
      const gain = this._channelGains.get(channel);
      if (gain && this._context) {
        gain.gain.setValueAtTime(volume, this._context.currentTime);
      }
    }
    // HTML5: volume applied at play time, not retroactively
  }

  getChannelVolume(channel: AudioChannel): number {
    return this._channelVolumes.get(channel) ?? 1;
  }

  setChannelMute(channel: AudioChannel, muted: boolean): void {
    this._channelMuted.set(channel, muted);

    if (!this._useHTML5) {
      const gain = this._channelGains.get(channel);
      if (gain && this._context) {
        const volume = muted ? 0 : (this._channelVolumes.get(channel) ?? 1);
        gain.gain.setValueAtTime(volume, this._context.currentTime);
      }
    }
  }

  isChannelMuted(channel: AudioChannel): boolean {
    return this._channelMuted.get(channel) ?? false;
  }

  setMasterMute(muted: boolean): void {
    this.setChannelMute("master", muted);
  }

  // ── Music ───────────────────────────────────────────────────────────────────

  async playMusic(src: string | string[], options: MusicOptions = {}): Promise<void> {
    if (!this._ready) {
      this._queuedMusic = { src, options };
      return;
    }

    const url = resolveUrl(src);
    if (!url) return;

    const volume = options.volume ?? 1;
    const loop = options.loop ?? true;
    const crossfade = options.crossfade?.duration ?? 2;

    if (this._useHTML5) {
      this._html5Pool!.playMusic(url, volume, loop, crossfade);
      return;
    }

    try {
      const buffer = await this._loadBuffer(src);
      this._musicEngine?.play(buffer, volume, loop, crossfade);
    } catch (err) {
      console.warn("[CarverJS Audio] Failed to load music:", err);
    }
  }

  stopMusic(fadeOut = 0): void {
    this._queuedMusic = null;
    if (this._useHTML5) {
      this._html5Pool?.stopMusic(fadeOut);
    } else {
      this._musicEngine?.stop(fadeOut);
    }
  }

  pauseMusic(): void {
    if (this._useHTML5) {
      this._html5Pool?.pauseMusic();
    } else {
      this._musicEngine?.pause();
    }
  }

  resumeMusic(): void {
    if (this._useHTML5) {
      this._html5Pool?.resumeMusic();
    } else {
      this._musicEngine?.resume();
    }
  }

  isMusicPlaying(): boolean {
    if (this._useHTML5) return this._html5Pool?.isMusicPlaying() ?? false;
    return this._musicEngine?.isPlaying() ?? false;
  }

  // ── Listener ────────────────────────────────────────────────────────────────

  setListenerSource(source: Object3D): void {
    this._listenerSource = source;
  }

  setCustomListener(source: Object3D | null): void {
    this._customListener = source;
  }

  // ── Preloading ──────────────────────────────────────────────────────────────

  async preload(name: string): Promise<void> {
    if (this._useHTML5) return; // HTML5 Audio streams on play
    await this._loadByName(name);
  }

  async preloadAll(names: string[]): Promise<void> {
    if (this._useHTML5) return;
    await Promise.all(names.map((n) => this._loadByName(n)));
  }

  /** Unload a sound's buffer from memory. Re-fetched on next play. */
  unloadBuffer(name: string): void {
    const def = this._definitions.get(name);
    if (!def) return;
    const urls = Array.isArray(def.src) ? def.src : [def.src];
    for (const url of urls) this._bufferCache.delete(url);
  }

  // ── Per-Frame Flush ─────────────────────────────────────────────────────────

  flush(phase: GamePhase): void {
    try {
      // HTML5 path
      if (this._useHTML5) {
        const shouldPause = phase === "paused" || phase === "gameover";
        if (shouldPause && !this._gamePaused) {
          this._gamePaused = true;
          this._html5Pool?.pauseAll();
        } else if (!shouldPause && this._gamePaused) {
          this._gamePaused = false;
          this._html5Pool?.resumeAll();
        }
        if (!this._gamePaused) {
          this._html5Pool?.flushMusic();
        }
        return;
      }

      // Web Audio path
      if (!this._context || !this._unlocked) return;

      const shouldPause = phase === "paused" || phase === "gameover";
      if (shouldPause && !this._gamePaused) {
        this._gamePaused = true;
        this._context.suspend();
      } else if (!shouldPause && this._gamePaused) {
        this._gamePaused = false;
        this._context.resume();
      }

      if (this._gamePaused) return;

      this._updateSpatialPositions();
      this._syncListener();
    } catch {
      // Audio errors must never crash the render loop
    }
  }

  // ── Spatial Updates ─────────────────────────────────────────────────────────

  private _updateSpatialPositions(): void {
    for (const [, tracker] of this._spatialTrackers) {
      const obj = tracker.ref.current;
      if (!obj) continue;

      obj.getWorldPosition(_emitterPos);
      const panner = tracker.pannerNode;
      panner.positionX.value = _emitterPos.x;
      panner.positionY.value = _emitterPos.y;
      panner.positionZ.value = _emitterPos.z;
    }
  }

  private _syncListener(): void {
    if (!this._context) return;
    const source = this._customListener ?? this._listenerSource;
    if (!source) return;

    const listener = this._context.listener;

    source.getWorldPosition(_listenerPos);
    source.getWorldDirection(_listenerDir);
    _listenerUp.set(0, 1, 0).applyQuaternion(source.quaternion);

    // Modern API (AudioParam-based)
    if (listener.positionX !== undefined) {
      listener.positionX.value = _listenerPos.x;
      listener.positionY.value = _listenerPos.y;
      listener.positionZ.value = _listenerPos.z;
      listener.forwardX.value = _listenerDir.x;
      listener.forwardY.value = _listenerDir.y;
      listener.forwardZ.value = _listenerDir.z;
      listener.upX.value = _listenerUp.x;
      listener.upY.value = _listenerUp.y;
      listener.upZ.value = _listenerUp.z;
    } else {
      // Deprecated fallback for older Safari
      (listener as unknown as { setPosition: (x: number, y: number, z: number) => void })
        .setPosition(_listenerPos.x, _listenerPos.y, _listenerPos.z);
      (listener as unknown as { setOrientation: (x: number, y: number, z: number, ux: number, uy: number, uz: number) => void })
        .setOrientation(
          _listenerDir.x, _listenerDir.y, _listenerDir.z,
          _listenerUp.x, _listenerUp.y, _listenerUp.z,
        );
    }
  }
}

// ── Singleton accessor ──────────────────────────────────────────────────────────

let _instance: AudioManager | null = null;

export function getAudioManager(): AudioManager {
  if (!_instance) _instance = new AudioManager();
  return _instance;
}

export function destroyAudioManager(): void {
  _instance?.destroy();
  _instance = null;
}
