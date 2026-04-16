// ── Connection & Room Types ──

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'migrating' | 'reconnecting';

export type RoomState = 'lobby' | 'playing' | 'ended';

export interface Room {
  id: string;
  name: string;
  hostId: string;
  playerCount: number;
  maxPlayers: number;
  gameMode?: string;
  isPrivate: boolean;
  metadata: Record<string, unknown>;
  createdAt: number;
  state: RoomState;
}

export interface RoomConfig {
  name: string;
  maxPlayers?: number;
  gameMode?: string;
  password?: string;
  isPrivate?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Player {
  peerId: string;
  displayName: string;
  isHost: boolean;
  isSelf: boolean;
  isReady: boolean;
  isConnected: boolean;
  metadata: Record<string, unknown>;
  latencyMs: number;
  joinedAt: number;
}

// ── Transport Types ──

export interface CarverTransport {
  readonly peerId: string;
  readonly peers: ReadonlySet<string>;
  readonly hostId: string;
  readonly isHost: boolean;
  readonly room?: Room;
  readonly initialPlayers?: Player[];

  onPeerJoin(cb: (peerId: string) => void): void;
  onPeerLeave(cb: (peerId: string) => void): void;
  onPeerUpdated(cb: (player: Player) => void): void;
  onHostChanged(cb: (newHostId: string) => void): void;

  createChannel<T = unknown>(name: string, options?: ChannelOptions): CarverChannel<T>;
  connect(roomId: string, config?: TransportConfig): Promise<void>;
  disconnect(): void;

  // Room management (optional -- transports that don't support these should no-op)
  setReady?(ready: boolean): void;
  setMetadata?(metadata: Record<string, unknown>): void;
  setRoomMetadata?(metadata: Record<string, unknown>): void;
  kick?(peerId: string, reason?: string): void;
  transferHost?(peerId: string): void;
  setRoomState?(state: RoomState): void;
  setMaxPlayers?(n: number): void;
  lockRoom?(): void;
  unlockRoom?(): void;
  requestRoomList?(): void;
}

export interface CarverChannel<T = unknown> {
  send(data: T, target?: string | string[]): void;
  onReceive(cb: (data: T, peerId: string) => void): void;
  close(): void;
}

export interface ChannelOptions {
  reliable?: boolean;
  ordered?: boolean;
  maxRetransmits?: number;
}

export interface TransportConfig {
  displayName?: string;
  playerMetadata?: Record<string, unknown>;
  password?: string;
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  maxPlayers?: number;
  roomConfig?: RoomConfig;
}

// ── Strategy Config (re-export for convenience) ──

export type {
  StrategyConfig,
  MqttStrategyConfig,
  FirebaseStrategyConfig,
  SignalingStrategy,
  PeerMetadata,
  RoomAnnouncement,
} from "../transport/strategy/types";

// ── Sync Types ──

export type SyncMode = 'events' | 'snapshot' | 'prediction';

export type NetworkQuality = 'good' | 'degraded' | 'poor';

export interface EntityState2D {
  id: string;
  x: number; y: number;
  a: number;
  vx: number; vy: number;
  va: number;
  c?: Record<string, unknown>;
}

export interface EntityState3D {
  id: string;
  x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
  vx: number; vy: number; vz: number;
  wx: number; wy: number; wz: number;
  c?: Record<string, unknown>;
}

export type EntityState = EntityState2D | EntityState3D;

export interface SnapshotPacket {
  t: number;
  b: number;
  s: Uint8Array;
  hi?: unknown;
}

export interface InputPacket {
  t: number;
  i: unknown;
  p: string;
}

export interface EventPacket {
  type: string;
  payload: unknown;
  sender: string;
  target?: string;
}

// ── Error Types ──

export type CarverErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_LOCKED'
  | 'INVALID_PASSWORD'
  | 'CONNECTION_FAILED'
  | 'HOST_UNREACHABLE'
  | 'KICKED'
  | 'SIGNALING_ERROR'
  | 'TURN_CREDENTIAL_ERROR'
  | 'TRANSPORT_ERROR'
  | 'MIGRATION_FAILED';

export interface CarverMultiplayerError {
  code: CarverErrorCode;
  message: string;
  recoverable: boolean;
}

// ── Hook Option Types ──

export interface UseRoomOptions {
  /** Supply a custom CarverTransport instance to bypass the built-in WebRTCTransport. */
  transport?: CarverTransport;
  password?: string;
  displayName?: string;
  playerMetadata?: Record<string, unknown>;
  /** Override ICE servers for this room (overrides provider-level config). */
  iceServers?: RTCIceServer[];
  hostMigration?: boolean;
  reconnectAttempts?: number;
  reconnectIntervalMs?: number;
  /** ICE transport policy: 'all' (default) or 'relay' (force TURN only). */
  privacy?: 'all' | 'relay';
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onHostMigration?: (newHostId: string) => void;
  onError?: (error: CarverMultiplayerError) => void;
}

export interface UseLobbyOptions {
  autoRefresh?: boolean;
  filter?: {
    maxPlayers?: number;
    gameMode?: string;
    hasPassword?: boolean;
  };
}

export interface UseMultiplayerOptions {
  mode?: SyncMode;
  tickRate?: number;
  broadcastRate?: number;
  keyframeInterval?: number;
  quantize?: {
    position?: number;
    rotation?: number;
    velocity?: number;
  };
  deltaThresholds?: {
    position?: number;
    rotation?: number;
    velocity?: number;
    custom?: 'strict' | number;
  };
  prediction?: {
    maxRewindTicks?: number;
    errorSmoothingDecay?: number;
    maxErrorPerFrame?: number;
    snapThreshold?: number;
    lagCompensation?: boolean;
  };
  interpolation?: {
    bufferSize?: number;
    method?: 'hermite' | 'linear';
    extrapolateMs?: number;
  };
  interestManagement?: {
    enabled?: boolean;
    cellSize?: number;
    defaultRadius?: number;
    alwaysRelevant?: string[];
  };
  debug?: {
    overlay?: boolean;
    simulatedLatencyMs?: number;
    simulatedPacketLoss?: number;
    logLevel?: 'none' | 'error' | 'warn' | 'verbose';
  };
  onPhysicsStep?: (inputs: Map<string, unknown>, tick: number, isRollback: boolean) => void;
}

// ── Multiplayer Context Types ──

export interface MultiplayerContextValue {
  appId: string;
  strategy: import("../transport/strategy/types").SignalingStrategy;
  iceServers?: RTCIceServer[];
  networkManager: import("../core/NetworkManager").NetworkManager;
}

export interface JoinOptions {
  password?: string;
  displayName?: string;
  playerMetadata?: Record<string, unknown>;
}
