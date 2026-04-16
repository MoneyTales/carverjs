import { useRef, useEffect, useCallback, useSyncExternalStore } from "react";
import { getAudioManager } from "../systems/AudioManager";
import type {
  UseAudioOptions,
  UseAudioReturn,
  SoundMap,
  PlaySoundOptions,
  SoundHandle,
  AudioChannel,
  MusicOptions,
} from "../types";

export function useAudio(options: UseAudioOptions = {}): UseAudioReturn {
  const { sounds = {}, enabled = true } = options;

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // Register sounds on mount, unregister on unmount.
  // Uses a ref to avoid re-registration on re-renders.
  // To change the sound set, remount the component via key prop.
  const initialSoundsRef = useRef<SoundMap>(sounds);

  useEffect(() => {
    const mgr = getAudioManager();
    const soundMap = initialSoundsRef.current;
    const names = Object.keys(soundMap);

    for (const name of names) {
      mgr.registerSound(name, soundMap[name]);
    }

    return () => {
      for (const name of names) {
        mgr.unregisterSound(name);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe for reactive state changes (isUnlocked, isReady)
  const mgr = getAudioManager();
  useSyncExternalStore(mgr.subscribe, mgr.getSnapshot);

  // ── Stable function references ──

  const play = useCallback((name: string, opts?: PlaySoundOptions): SoundHandle | null => {
    if (!enabledRef.current) return null;
    return getAudioManager().play(name, opts);
  }, []);

  const stop = useCallback((name: string) => {
    getAudioManager().stopByName(name);
  }, []);

  const pause = useCallback((name: string) => {
    getAudioManager().pauseByName(name);
  }, []);

  const resume = useCallback((name: string) => {
    getAudioManager().resumeByName(name);
  }, []);

  const isPlaying = useCallback((name: string) => {
    return getAudioManager().isSoundPlaying(name);
  }, []);

  const playMusic = useCallback((src: string | string[], opts?: MusicOptions) => {
    if (!enabledRef.current) return;
    getAudioManager().playMusic(src, opts);
  }, []);

  const stopMusic = useCallback((fadeOut?: number) => {
    getAudioManager().stopMusic(fadeOut);
  }, []);

  const pauseMusic = useCallback(() => {
    getAudioManager().pauseMusic();
  }, []);

  const resumeMusic = useCallback(() => {
    getAudioManager().resumeMusic();
  }, []);

  const isMusicPlaying = useCallback(() => {
    return getAudioManager().isMusicPlaying();
  }, []);

  const setVolume = useCallback((channel: AudioChannel, volume: number) => {
    getAudioManager().setChannelVolume(channel, volume);
  }, []);

  const getVolume = useCallback((channel: AudioChannel) => {
    return getAudioManager().getChannelVolume(channel);
  }, []);

  const setMute = useCallback((channel: AudioChannel, muted: boolean) => {
    getAudioManager().setChannelMute(channel, muted);
  }, []);

  const isMuted = useCallback((channel: AudioChannel) => {
    return getAudioManager().isChannelMuted(channel);
  }, []);

  const setMasterMute = useCallback((muted: boolean) => {
    getAudioManager().setMasterMute(muted);
  }, []);

  const preload = useCallback(async (name: string) => {
    await getAudioManager().preload(name);
  }, []);

  const preloadAll = useCallback(async (names: string[]) => {
    await getAudioManager().preloadAll(names);
  }, []);

  return {
    play,
    stop,
    pause,
    resume,
    isPlaying,
    playMusic,
    stopMusic,
    pauseMusic,
    resumeMusic,
    isMusicPlaying,
    setVolume,
    getVolume,
    setMute,
    isMuted,
    setMasterMute,
    preload,
    preloadAll,
    isUnlocked: mgr.isUnlocked,
    isReady: mgr.isReady,
  };
}
