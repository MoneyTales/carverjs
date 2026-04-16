import { useState, useEffect, useCallback, useRef } from "react";
import { useMultiplayerContext } from "../core/MultiplayerContext";
import type { Room, RoomConfig, UseLobbyOptions, CarverMultiplayerError } from "../types";
import type { RoomAnnouncement } from "../transport/strategy/types";

export interface UseLobbyReturn {
  rooms: Room[];
  isLoading: boolean;
  error: CarverMultiplayerError | null;
  refresh: () => void;
  createRoom: (config: RoomConfig) => Promise<string>;
}

/** Convert a RoomAnnouncement (from strategy) to a Room (public API type) */
function announcementToRoom(ann: RoomAnnouncement): Room {
  return {
    id: ann.roomId,
    name: ann.name,
    hostId: ann.hostId,
    playerCount: ann.playerCount,
    maxPlayers: ann.maxPlayers,
    gameMode: ann.gameMode,
    isPrivate: ann.isPrivate,
    metadata: ann.metadata,
    createdAt: ann.createdAt,
    state: 'lobby',
  };
}

export function useLobby(options?: UseLobbyOptions): UseLobbyReturn {
  const { strategy } = useMultiplayerContext();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<CarverMultiplayerError | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Filter rooms based on options
  const filterRooms = useCallback((roomList: Room[]): Room[] => {
    const filter = optionsRef.current?.filter;
    if (!filter) return roomList;
    return roomList.filter((room) => {
      if (filter.maxPlayers !== undefined && room.maxPlayers > filter.maxPlayers) return false;
      if (filter.gameMode !== undefined && room.gameMode !== filter.gameMode) return false;
      if (filter.hasPassword !== undefined && room.isPrivate !== filter.hasPassword) return false;
      return true;
    });
  }, []);

  // Subscribe to lobby via strategy
  useEffect(() => {
    setIsLoading(true);
    setError(null);

    const unsub = strategy.subscribeToLobby((announcements: RoomAnnouncement[]) => {
      const converted = announcements.map(announcementToRoom);
      setRooms(filterRooms(converted));
      setIsLoading(false);
    });

    // After a short timeout, if we haven't received any data, stop loading
    const timeout = setTimeout(() => setIsLoading(false), 3000);

    return () => {
      unsub();
      clearTimeout(timeout);
    };
  }, [strategy, filterRooms]);

  const refresh = useCallback(() => {
    // With MQTT/Firebase, the lobby is live-updating.
    // Refresh is a no-op since we're subscribed to real-time updates.
    // But we reset loading to give visual feedback.
    setIsLoading(true);
    setTimeout(() => setIsLoading(false), 1000);
  }, []);

  const createRoom = useCallback(async (config: RoomConfig): Promise<string> => {
    // In serverless mode, "creating a room" just means announcing it.
    // The room ID is generated locally. The actual room is established
    // when the first peer joins via useRoom.
    const roomId = `${config.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now().toString(36)}`;

    const announcement: RoomAnnouncement = {
      roomId,
      name: config.name,
      hostId: strategy.selfId,
      playerCount: 0,
      maxPlayers: config.maxPlayers ?? 8,
      gameMode: config.metadata?.gameMode as string | undefined,
      isPrivate: config.isPrivate ?? false,
      metadata: config.metadata ?? {},
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };

    strategy.announceRoom(announcement);
    return roomId;
  }, [strategy]);

  return {
    rooms,
    isLoading,
    error,
    refresh,
    createRoom,
  };
}
