import type { RefObject } from "react";
import type { Object3D } from "three";

// ── Core Audio Types ────────────────────────────────────────────────────────────

/** Volume channel names. "master" controls the global output. */
export type AudioChannel =
  | "master"
  | "sfx"
  | "music"
  | "ui"
  | "ambient"
  | "voice";

/** Supported audio formats for codec negotiation */
export type AudioFormat = "mp3" | "ogg" | "wav" | "webm" | "aac" | "flac";

/** Playback state of a single sound instance */
export type SoundState = "playing" | "paused" | "stopped";

// ── Audio Sprites ───────────────────────────────────────────────────────────────

/** Defines a named region within an audio file */
export interface AudioSpriteRegion {
  /** Start offset in seconds */
  start: number;
  /** Duration in seconds */
  duration: number;
  /** Whether this region should loop. Default: false */
  loop?: boolean;
}

/** Map of sprite name to region definition */
export type AudioSpriteMap = Record<string, AudioSpriteRegion>;

// ── Sound Definition ────────────────────────────────────────────────────────────

/** Configuration for registering a sound with the AudioManager */
export interface SoundDefinition {
  /**
   * URL(s) of the audio file.
   * - Single string: used as-is
   * - Array: format auto-detection picks the first supported format
   */
  src: string | string[];
  /** Volume channel this sound belongs to. Default: "sfx" */
  channel?: AudioChannel;
  /** Base volume (0-1). Default: 1 */
  volume?: number;
  /** Playback rate (0.5 = half speed, 2 = double speed). Default: 1 */
  rate?: number;
  /** Whether to loop. Default: false */
  loop?: boolean;
  /** Maximum simultaneous instances. Default: 5 */
  maxInstances?: number;
  /** Whether to preload on registration. Default: true */
  preload?: boolean;
  /** Audio sprite regions, if this is a sprite sheet */
  sprites?: AudioSpriteMap;
  /** Minimum seconds between play calls. Requests within cooldown are dropped. */
  cooldown?: number;
}

// ── Spatial Audio ───────────────────────────────────────────────────────────────

/** Panning model for spatial audio */
export type PanningModel = "HRTF" | "equalpower";

/** Distance model for spatial attenuation */
export type DistanceModel = "linear" | "inverse" | "exponential";

/** Configuration for 3D spatial audio on a sound instance */
export interface SpatialAudioOptions {
  /** Ref to the Three.js Object3D emitting the sound */
  ref: RefObject<Object3D | null>;
  /** Panning model. Default: "HRTF" */
  panningModel?: PanningModel;
  /** Distance model for volume rolloff. Default: "inverse" */
  distanceModel?: DistanceModel;
  /** Distance at which volume starts to decrease. Default: 1 */
  refDistance?: number;
  /** Maximum distance at which sound is still audible. Default: 100 */
  maxDistance?: number;
  /** How quickly volume decreases with distance. Default: 1 */
  rolloffFactor?: number;
  /** Inner cone angle in degrees (full volume). Default: 360 */
  coneInnerAngle?: number;
  /** Outer cone angle in degrees. Default: 360 */
  coneOuterAngle?: number;
  /** Volume outside the outer cone (0-1). Default: 0 */
  coneOuterGain?: number;
  /** Update position every frame from the Object3D ref. Default: true */
  trackPosition?: boolean;
}

// ── Play Options ────────────────────────────────────────────────────────────────

/** Options passed when playing a sound */
export interface PlaySoundOptions {
  /** Override volume for this instance (0-1) */
  volume?: number;
  /** Override playback rate */
  rate?: number;
  /** Override loop setting */
  loop?: boolean;
  /** If this sound has sprites, play this named sprite */
  sprite?: string;
  /** Spatial audio configuration for 3D positioning */
  spatial?: SpatialAudioOptions;
  /** Fade in duration in seconds. Default: 0 */
  fadeIn?: number;
  /** Delay before playback starts, in seconds. Default: 0 */
  delay?: number;
  /** Callback when playback finishes (not called if looping) */
  onEnd?: () => void;
  /** Callback if playback fails */
  onError?: (error: Error) => void;
}

// ── Sound Handle ────────────────────────────────────────────────────────────────

/** Handle to a playing sound instance, returned by play() */
export interface SoundHandle {
  /** Unique instance ID */
  readonly id: number;
  /** Current state */
  readonly state: SoundState;
  /** Stop and release this instance */
  stop: () => void;
  /** Pause this instance */
  pause: () => void;
  /** Resume this instance */
  resume: () => void;
  /** Fade volume over duration (seconds) */
  fade: (from: number, to: number, duration: number) => void;
  /** Set volume (0-1) for this instance */
  setVolume: (volume: number) => void;
  /** Set playback rate */
  setRate: (rate: number) => void;
}

// ── Music Types ─────────────────────────────────────────────────────────────────

/** Configuration for music crossfading */
export interface CrossfadeOptions {
  /** Duration of the crossfade in seconds. Default: 2 */
  duration?: number;
}

/** Options for the music system */
export interface MusicOptions {
  /** Volume (0-1). Default: 1 */
  volume?: number;
  /** Whether to loop the track. Default: true */
  loop?: boolean;
  /** Crossfade settings when switching tracks */
  crossfade?: CrossfadeOptions;
  /** If using sprites from a registered sound, the sprite name */
  sprite?: string;
}

// ── useAudio Types ──────────────────────────────────────────────────────────────

/** Sounds map passed to useAudio for registration */
export type SoundMap = Record<string, SoundDefinition>;

/** Options for the useAudio hook */
export interface UseAudioOptions {
  /** Map of sound names to definitions. Registered on mount, unregistered on unmount. */
  sounds?: SoundMap;
  /** Whether audio from this hook is active. Default: true */
  enabled?: boolean;
}

/** Return value of the useAudio hook */
export interface UseAudioReturn {
  /** Play a registered sound by name */
  play: (name: string, options?: PlaySoundOptions) => SoundHandle | null;
  /** Stop all instances of a named sound */
  stop: (name: string) => void;
  /** Pause all instances of a named sound */
  pause: (name: string) => void;
  /** Resume all paused instances of a named sound */
  resume: (name: string) => void;
  /** Check if any instance of a named sound is currently playing */
  isPlaying: (name: string) => boolean;
  /** Play a music track (crossfades from current if one is playing) */
  playMusic: (src: string | string[], options?: MusicOptions) => void;
  /** Stop the current music track */
  stopMusic: (fadeOut?: number) => void;
  /** Pause the music */
  pauseMusic: () => void;
  /** Resume the music */
  resumeMusic: () => void;
  /** Check if music is currently playing */
  isMusicPlaying: () => boolean;
  /** Set volume for a channel (0-1) */
  setVolume: (channel: AudioChannel, volume: number) => void;
  /** Get current volume for a channel */
  getVolume: (channel: AudioChannel) => number;
  /** Mute/unmute a channel */
  setMute: (channel: AudioChannel, muted: boolean) => void;
  /** Check if a channel is muted */
  isMuted: (channel: AudioChannel) => boolean;
  /** Set the master mute */
  setMasterMute: (muted: boolean) => void;
  /** Preload a sound by name */
  preload: (name: string) => Promise<void>;
  /** Preload multiple sounds */
  preloadAll: (names: string[]) => Promise<void>;
  /** Whether the AudioContext has been unlocked */
  isUnlocked: boolean;
  /** Whether the audio system is ready */
  isReady: boolean;
}

// ── AudioListener Types ─────────────────────────────────────────────────────────

/** Configuration for the AudioListener component */
export interface AudioListenerConfig {
  /** Override the listener position source. Defaults to the active R3F camera. */
  listenerRef?: RefObject<Object3D | null>;
}
