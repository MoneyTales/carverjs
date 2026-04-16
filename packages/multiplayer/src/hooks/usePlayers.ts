import { useState, useEffect, useCallback } from "react";
import { useMultiplayerContext } from "../core/MultiplayerContext";
import type { Player } from "../types";

export interface UsePlayersReturn {
  players: Player[];
  self: Player | null;
  host: Player | null;
  count: number;
  allReady: boolean;
  getPlayer: (peerId: string) => Player | undefined;
}

export function usePlayers(): UsePlayersReturn {
  const { networkManager } = useMultiplayerContext();
  const [players, setPlayers] = useState<Player[]>([]);
  const [, setVersion] = useState(0);

  useEffect(() => {
    const unsubscribe = networkManager.onPlayersChange(() => {
      setPlayers(Array.from(networkManager.players.values()));
      setVersion((v) => v + 1);
    });

    // Initialize with current players
    setPlayers(Array.from(networkManager.players.values()));

    return unsubscribe;
  }, [networkManager]);

  const self = players.find((p) => p.isSelf) ?? null;
  const host = players.find((p) => p.isHost) ?? null;
  const allReady = players.length > 0 && players.every((p) => p.isReady);

  const getPlayer = useCallback(
    (peerId: string) => players.find((p) => p.peerId === peerId),
    [players]
  );

  return {
    players,
    self,
    host,
    count: players.length,
    allReady,
    getPlayer,
  };
}
