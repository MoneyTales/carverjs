import { useState, useEffect, useCallback, useRef } from "react";
import { useMultiplayerContext } from "../core/MultiplayerContext";
import { WebRTCTransport } from "../transport/webrtc/WebRTCTransport";
import type {
  ConnectionState,
  CarverMultiplayerError,
  CarverTransport,
  UseRoomOptions,
  Room,
} from "../types";

export interface UseRoomReturn {
  roomId: string | null;
  connectionState: ConnectionState;
  isHost: boolean;
  hostId: string | null;
  selfId: string | null;
  room: Room | null;
  error: CarverMultiplayerError | null;
  join: (roomId: string, options?: { password?: string }) => Promise<void>;
  leave: () => void;
  setReady: (ready: boolean) => void;
  setMetadata: (meta: Record<string, unknown>) => void;
  setRoomMetadata: (meta: Record<string, unknown>) => void;
  transport: CarverTransport | null;
}

export function useRoom(roomId?: string, options?: UseRoomOptions): UseRoomReturn {
  const { strategy, iceServers, networkManager } = useMultiplayerContext();
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null);
  const [error, setError] = useState<CarverMultiplayerError | null>(null);
  const [transport, setTransport] = useState<CarverTransport | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = options?.reconnectAttempts ?? 3;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Create transport based on options
  const createTransport = useCallback((): CarverTransport => {
    const opt = optionsRef.current;
    // Allow fully custom transport instances
    if (opt?.transport && typeof opt.transport === 'object' && 'connect' in opt.transport) {
      return opt.transport as CarverTransport;
    }
    // Default: WebRTC with shared strategy and configurable ICE servers
    const servers = opt?.iceServers ?? iceServers;
    const policy = opt?.privacy === 'relay' ? 'relay' as const : 'all' as const;
    return new WebRTCTransport(strategy, servers, policy);
  }, [strategy, iceServers]);

  // Track transport ref for cleanup
  const transportRef = useRef<CarverTransport | null>(null);

  const doJoin = useCallback(async (targetRoomId: string, joinOptions?: { password?: string }) => {
    // Disconnect any existing transport (handles StrictMode re-mount)
    if (transportRef.current) {
      transportRef.current.disconnect();
      transportRef.current = null;
    }

    const t = createTransport();
    transportRef.current = t;

    try {
      setError(null);
      setConnectionState('connecting');
      networkManager.setConnectionState('connecting');
      setTransport(t);
      networkManager.setTransport(t);

      // Setup transport event listeners
      t.onPeerJoin(() => {
        // Player list updates handled by NetworkManager
      });

      t.onPeerLeave(() => {
        // Player list updates handled by NetworkManager
      });

      t.onHostChanged((newHostId) => {
        setHostId(newHostId);
        setIsHost(t.peerId === newHostId);
        optionsRef.current?.onHostMigration?.(newHostId);
      });

      // Listen for room updates
      if ('onRoomUpdated' in t && typeof (t as any).onRoomUpdated === 'function') {
        (t as any).onRoomUpdated((updatedRoom: Room) => {
          networkManager.setRoom(updatedRoom);
        });
      }

      await t.connect(targetRoomId, {
        displayName: optionsRef.current?.displayName,
        playerMetadata: optionsRef.current?.playerMetadata,
        password: joinOptions?.password ?? optionsRef.current?.password,
        iceServers: optionsRef.current?.iceServers,
        iceTransportPolicy: optionsRef.current?.privacy === 'relay' ? 'relay' : 'all',
      });

      // If this transport was replaced by a StrictMode re-mount, bail out
      if (transportRef.current !== t) return;

      setCurrentRoomId(targetRoomId);
      setSelfId(t.peerId);
      setHostId(t.hostId);
      setIsHost(t.isHost);
      setConnectionState('connected');
      networkManager.setConnectionState('connected');

      // Populate NetworkManager with initial room state and players
      if (t.room) {
        networkManager.setRoom(t.room);
      }
      if (t.initialPlayers) {
        const players = t.initialPlayers.map((p) => ({
          ...p,
          isSelf: p.peerId === t.peerId,
        }));
        networkManager.setPlayers(players);
      }

      reconnectAttemptsRef.current = 0;
      optionsRef.current?.onConnected?.();
    } catch (err) {
      // If this transport was replaced, ignore
      if (transportRef.current !== t) return;

      const carverError: CarverMultiplayerError = {
        code: 'CONNECTION_FAILED',
        message: err instanceof Error ? err.message : 'Connection failed',
        recoverable: reconnectAttemptsRef.current < maxReconnectAttempts,
      };
      setError(carverError);
      networkManager.emitError(carverError);
      setConnectionState('disconnected');
      networkManager.setConnectionState('disconnected');
      optionsRef.current?.onError?.(carverError);
    }
  }, [createTransport, networkManager, maxReconnectAttempts]);

  const leave = useCallback(() => {
    if (transportRef.current) {
      transportRef.current.disconnect();
      transportRef.current = null;
    }
    setTransport(null);
    setConnectionState('disconnected');
    setCurrentRoomId(null);
    setSelfId(null);
    setHostId(null);
    setIsHost(false);
    setError(null);
    networkManager.setConnectionState('disconnected');
    optionsRef.current?.onDisconnected?.('user_left');
  }, [networkManager]);

  const setReady = useCallback((ready: boolean) => {
    transport?.setReady?.(ready);
    // Optimistic self-update so local UI responds immediately
    const selfPlayer = networkManager.players.get(transport?.peerId ?? '');
    if (selfPlayer) {
      networkManager.updatePlayer({ ...selfPlayer, isReady: ready });
    }
  }, [transport, networkManager]);

  const setMetadata = useCallback((meta: Record<string, unknown>) => {
    transport?.setMetadata?.(meta);
  }, [transport]);

  const setRoomMetadata = useCallback((meta: Record<string, unknown>) => {
    transport?.setRoomMetadata?.(meta);
  }, [transport]);

  // Auto-join if roomId is provided
  useEffect(() => {
    if (roomId) {
      doJoin(roomId);
    }
    return () => {
      if (transportRef.current) {
        transportRef.current.disconnect();
        transportRef.current = null;
      }
    };
  }, [roomId, doJoin]);

  // Listen for room updates
  useEffect(() => {
    const unsub = networkManager.onRoomChange(() => {
      setRoom(networkManager.room);
    });
    setRoom(networkManager.room);
    return unsub;
  }, [networkManager]);

  return {
    roomId: currentRoomId,
    connectionState,
    isHost,
    hostId,
    selfId,
    room,
    error,
    join: doJoin,
    leave,
    setReady,
    setMetadata,
    setRoomMetadata,
    transport,
  };
}
