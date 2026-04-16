import type {
  CarverTransport,
  ConnectionState,
  CarverMultiplayerError,
  UseMultiplayerOptions,
  Player,
  Room,
  SyncMode,
  NetworkQuality,
} from "../types";
import { TickKeeper } from "./TickKeeper";
import { Codec, SnapshotBuffer } from "./codec";

/**
 * Central orchestrator for the multiplayer system.
 * Holds references to the active transport, sync engine, room state, and codec.
 * One instance per MultiplayerProvider.
 */
export class NetworkManager {
  // Transport
  private _transport: CarverTransport | null = null;
  private _connectionState: ConnectionState = 'disconnected';

  // Room state
  private _room: Room | null = null;
  private _players = new Map<string, Player>();

  // Sync state
  private _syncMode: SyncMode = 'snapshot';
  private _tickKeeper: TickKeeper;
  private _codec: Codec;
  private _snapshotBuffer: SnapshotBuffer;
  private _networkQuality: NetworkQuality = 'good';

  // Options
  private _options: UseMultiplayerOptions;

  // Change listeners
  private _connectionListeners: ((state: ConnectionState) => void)[] = [];
  private _playerListeners: (() => void)[] = [];
  private _roomListeners: (() => void)[] = [];
  private _errorListeners: ((error: CarverMultiplayerError) => void)[] = [];

  constructor(options: UseMultiplayerOptions = {}) {
    this._options = options;
    this._syncMode = options.mode ?? 'snapshot';
    this._tickKeeper = new TickKeeper(options.tickRate ?? 60);
    this._codec = new Codec({
      thresholds: options.deltaThresholds,
      quantize: options.quantize,
    });
    this._snapshotBuffer = new SnapshotBuffer();
  }

  // -- Getters --

  get transport(): CarverTransport | null {
    return this._transport;
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  get room(): Room | null {
    return this._room;
  }

  get players(): Map<string, Player> {
    return this._players;
  }

  get selfId(): string | null {
    return this._transport?.peerId || null;
  }

  get isHost(): boolean {
    return this._transport?.isHost ?? false;
  }

  get hostId(): string | null {
    return this._transport?.hostId ?? null;
  }

  get syncMode(): SyncMode {
    return this._syncMode;
  }

  get tickKeeper(): TickKeeper {
    return this._tickKeeper;
  }

  get codec(): Codec {
    return this._codec;
  }

  get snapshotBuffer(): SnapshotBuffer {
    return this._snapshotBuffer;
  }

  get networkQuality(): NetworkQuality {
    return this._networkQuality;
  }

  get options(): UseMultiplayerOptions {
    return this._options;
  }

  // -- Transport management --

  setTransport(transport: CarverTransport): void {
    this._transport = transport;

    transport.onPeerJoin((peerId) => {
      // Add a player entry if not already present
      if (!this._players.has(peerId)) {
        this._players.set(peerId, {
          peerId,
          displayName: `Player-${peerId.slice(0, 4)}`,
          isHost: peerId === transport.hostId,
          isSelf: false,
          isReady: false,
          isConnected: true,
          metadata: {},
          latencyMs: 0,
          joinedAt: Date.now(),
        });
      }
      this._notifyPlayerListeners();
    });

    transport.onPeerUpdated((player) => {
      this._players.set(player.peerId, {
        ...player,
        isSelf: player.peerId === this.selfId,
      });
      this._notifyPlayerListeners();
    });

    transport.onPeerLeave((peerId) => {
      this._players.delete(peerId);
      this._notifyPlayerListeners();
    });

    transport.onHostChanged((_newHostId) => {
      this._notifyRoomListeners();
    });
  }

  // -- Connection state --

  setConnectionState(state: ConnectionState): void {
    this._connectionState = state;
    for (const listener of this._connectionListeners) listener(state);
  }

  onConnectionStateChange(cb: (state: ConnectionState) => void): () => void {
    this._connectionListeners.push(cb);
    return () => {
      const idx = this._connectionListeners.indexOf(cb);
      if (idx >= 0) this._connectionListeners.splice(idx, 1);
    };
  }

  // -- Room state --

  setRoom(room: Room): void {
    this._room = room;
    this._notifyRoomListeners();
  }

  onRoomChange(cb: () => void): () => void {
    this._roomListeners.push(cb);
    return () => {
      const idx = this._roomListeners.indexOf(cb);
      if (idx >= 0) this._roomListeners.splice(idx, 1);
    };
  }

  // -- Players --

  setPlayers(players: Player[]): void {
    this._players.clear();
    for (const p of players) {
      this._players.set(p.peerId, p);
    }
    this._notifyPlayerListeners();
  }

  updatePlayer(player: Player): void {
    this._players.set(player.peerId, player);
    this._notifyPlayerListeners();
  }

  removePlayer(peerId: string): void {
    this._players.delete(peerId);
    this._notifyPlayerListeners();
  }

  onPlayersChange(cb: () => void): () => void {
    this._playerListeners.push(cb);
    return () => {
      const idx = this._playerListeners.indexOf(cb);
      if (idx >= 0) this._playerListeners.splice(idx, 1);
    };
  }

  // -- Errors --

  emitError(error: CarverMultiplayerError): void {
    for (const listener of this._errorListeners) listener(error);
  }

  onError(cb: (error: CarverMultiplayerError) => void): () => void {
    this._errorListeners.push(cb);
    return () => {
      const idx = this._errorListeners.indexOf(cb);
      if (idx >= 0) this._errorListeners.splice(idx, 1);
    };
  }

  // -- Network quality --

  setNetworkQuality(quality: NetworkQuality): void {
    this._networkQuality = quality;
  }

  // -- Sync options --

  updateOptions(options: UseMultiplayerOptions): void {
    this._options = options;
    if (options.mode) this._syncMode = options.mode;
    if (options.tickRate) this._tickKeeper.setTickRate(options.tickRate);
    if (options.deltaThresholds || options.quantize) {
      this._codec = new Codec({
        thresholds: options.deltaThresholds,
        quantize: options.quantize,
      });
    }
  }

  // -- Cleanup --

  destroy(): void {
    this._transport?.disconnect();
    this._transport = null;
    this._connectionState = 'disconnected';
    this._room = null;
    this._players.clear();
    this._tickKeeper.reset();
    this._snapshotBuffer.clear();
    this._connectionListeners = [];
    this._playerListeners = [];
    this._roomListeners = [];
    this._errorListeners = [];
  }

  // -- Private --

  private _notifyPlayerListeners(): void {
    for (const listener of this._playerListeners) listener();
  }

  private _notifyRoomListeners(): void {
    for (const listener of this._roomListeners) listener();
  }
}
