import { useCallback } from "react";
import { useMultiplayerContext } from "../core/MultiplayerContext";
import type { RoomState } from "../types";

export interface UseHostReturn {
  kick: (peerId: string, reason?: string) => void;
  transferHost: (peerId: string) => void;
  setRoomState: (state: RoomState) => void;
  setMaxPlayers: (n: number) => void;
  lockRoom: () => void;
  unlockRoom: () => void;
}

export function useHost(): UseHostReturn {
  const { networkManager } = useMultiplayerContext();

  const getTransport = useCallback(() => {
    const transport = networkManager.transport;
    if (!transport || !networkManager.isHost) return null;
    return transport;
  }, [networkManager]);

  const kick = useCallback((peerId: string, reason?: string) => {
    getTransport()?.kick?.(peerId, reason);
  }, [getTransport]);

  const transferHost = useCallback((peerId: string) => {
    getTransport()?.transferHost?.(peerId);
  }, [getTransport]);

  const setRoomState = useCallback((state: RoomState) => {
    getTransport()?.setRoomState?.(state);
  }, [getTransport]);

  const setMaxPlayers = useCallback((n: number) => {
    getTransport()?.setMaxPlayers?.(n);
  }, [getTransport]);

  const lockRoom = useCallback(() => {
    getTransport()?.lockRoom?.();
  }, [getTransport]);

  const unlockRoom = useCallback(() => {
    getTransport()?.unlockRoom?.();
  }, [getTransport]);

  return {
    kick,
    transferHost,
    setRoomState,
    setMaxPlayers,
    lockRoom,
    unlockRoom,
  };
}
