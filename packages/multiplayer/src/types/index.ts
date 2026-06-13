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

/** Flat per-tick input payload. Booleans get edge detection; numbers pass through. */
export type PlayerInput = Record<string, boolean | number | undefined>;

/**
 * Game simulation callback for prediction mode.
 * Keys of both maps are peer ids (the local player appears under transport.peerId).
 * Invoked once per fixed tick (isRollback=false) and once per resimulated tick (isRollback=true).
 */
export type PhysicsStepCallback = (
  inputs: Map<string, PlayerInput>,
  justPressed: Map<string, PlayerInput>,
  tick: number,
  isRollback: boolean,
  dt: number,
) => void;

/** Per-entity visual error offset produced by rollback. 2D uses x/y/a (z=0, q=identity); 3D uses x/y/z + quaternion (a=0). */
export interface ErrorOffset {
  x: number;
  y: number;
  z: number;
  a: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** World access used by PredictionSync for forward stepping and rollback. */
export interface PredictionWorldDriver {
  /** Read current state of every networked entity (raw physics, no error offsets). */
  captureState(): Map<string, EntityState>;
  /** Hard-apply states (position, rotation, velocities) to actors and rigid bodies, waking them. Skips tombstones. */
  applyState(entities: Iterable<EntityState>): void;
  /** Optional: step the physics world one fixed tick. If omitted, the game steps inside onPhysicsStep. */
  stepWorld?(): void;
}

export interface PredictionSyncOptions {
  /** Max |localTick - (serverTick + driftTargetTicks)| before hard tick snap (no resim). Default 15. */
  maxRewindTicks?: number;
  /** Per-axis positional jump (units) above which a rollback error vector is suppressed (intentional teleport). Default 150. */
  snapThreshold?: number;
  /** Multiplicative error decay per render frame. Default 0.85. */
  errorDecay?: number;
  /** Max positional correction magnitude applied per render frame. 0 = disabled (full decaying error applied). Default 0. */
  maxErrorPerFrame?: number;
  /** Neutral input payload used as fallback for unknown ticks/peers. Default {}. */
  neutralInput?: PlayerInput;
  /** Tick-history ring size for local and per-peer inputs. Default 120. */
  inputHistorySize?: number;
  /** Rollback snap target offset: snap target = serverTick + driftTargetTicks. Default 4. */
  driftTargetTicks?: number;
}

/** Fired by ClientReceiver after each snapshot is merged into the full world state. */
export type SnapshotListener = (
  tick: number,
  entities: Map<string, EntityState>,
  hostInput: PlayerInput | undefined,
) => void;

/** Minimal structural source of merged snapshots (implemented by SnapshotSync). */
export interface SnapshotSource {
  onSnapshot(cb: SnapshotListener): void;
}

export interface SnapshotPacket {
  t: number;
  b: number;
  s: Uint8Array;
  hi?: PlayerInput;
}

export interface InputPacket {
  /** Sender's local tick. */
  t: number;
  /** Per-tick input payload. */
  i: PlayerInput;
  /** Sender peerId (informational; receivers MUST key by transport-provided peerId). */
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
  prediction?: PredictionSyncOptions;
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
  /** Optional: step the physics world one fixed tick. Used for both forward sim and rollback resim. */
  stepWorld?: () => void;
  onPhysicsStep?: PhysicsStepCallback;
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
