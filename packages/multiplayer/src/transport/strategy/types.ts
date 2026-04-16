/** Metadata attached to a peer in the signaling layer */
export interface PeerMetadata {
  displayName?: string;
  [key: string]: unknown;
}

/** Room announcement visible in the lobby */
export interface RoomAnnouncement {
  roomId: string;
  name: string;
  hostId: string;
  playerCount: number;
  maxPlayers: number;
  gameMode?: string;
  isPrivate: boolean;
  metadata: Record<string, unknown>;
  createdAt: number;
  /** Timestamp of last heartbeat (used for expiry detection) */
  lastSeen: number;
}

/** Configuration for the MQTT signaling strategy */
export interface MqttStrategyConfig {
  type: 'mqtt';
  /** MQTT broker URLs (WebSocket). Defaults to public brokers. */
  brokerUrls?: string[];
  /** How many brokers to connect to for redundancy. Default: 2 */
  redundancy?: number;
}

/** Configuration for the Firebase RTDB signaling strategy */
export interface FirebaseStrategyConfig {
  type: 'firebase';
  /** Firebase Realtime Database URL (required) */
  databaseURL: string;
  /** Existing Firebase app instance (optional -- avoids double-init) */
  firebaseApp?: unknown;
}

export type StrategyConfig = MqttStrategyConfig | FirebaseStrategyConfig;

/**
 * Signaling strategy interface.
 *
 * Each implementation handles peer discovery and SDP/ICE relay through a
 * specific signaling network (MQTT brokers, Firebase RTDB, etc.).
 *
 * After peers discover each other and exchange WebRTC offers/answers, all
 * game data flows peer-to-peer over WebRTC data channels. The signaling
 * network is only used for the initial handshake.
 */
export interface SignalingStrategy {
  /** Unique peer ID for this session (generated locally) */
  readonly selfId: string;

  /** Connect to the signaling network */
  init(): Promise<void>;

  /** Join a room: announce presence, listen for peers and signals */
  joinRoom(roomId: string, peerMeta: PeerMetadata): Promise<void>;

  /** Leave the current room: clean up presence */
  leaveRoom(): Promise<void>;

  /** Send a signaling message (SDP offer/answer, ICE candidate) to a specific peer */
  signal(targetPeerId: string, data: unknown): void;

  // -- Room discovery (lobby) --

  /** Subscribe to room announcements for lobby. Returns unsubscribe function. */
  subscribeToLobby(cb: (rooms: RoomAnnouncement[]) => void): () => void;

  /** Publish room announcement (called by host) */
  announceRoom(announcement: RoomAnnouncement): void;

  /** Remove room announcement (called on room close) */
  removeRoomAnnouncement(roomId: string): void;

  // -- Callbacks (all return unsubscribe functions) --

  /** Called when a new peer is discovered in the room */
  onPeerDiscovered(cb: (peerId: string, meta: PeerMetadata) => void): () => void;

  /** Called when a peer leaves the room */
  onPeerLeft(cb: (peerId: string) => void): () => void;

  /** Called when a signaling message is received from a peer */
  onSignal(cb: (fromPeerId: string, data: unknown) => void): () => void;

  /** Tear down all connections to the signaling network */
  destroy(): void;
}
