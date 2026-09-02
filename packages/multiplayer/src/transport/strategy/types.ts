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
  /** Live room state, refreshed via updateRoomOccupancy. Default: 'lobby' */
  state?: 'lobby' | 'playing' | 'ended';
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

  /**
   * Supply a Firebase Auth **custom token** to sign in with before any RTDB
   * traffic. Omit it and the strategy connects anonymously: no token is
   * fetched, no sign-in happens, and `firebase/auth` is never even imported.
   *
   * Called once during `init()`, and again for a single re-auth cycle when a
   * write or listener comes back `permission_denied` (a revoked session or an
   * expired token). Return a FRESH token each call; do not cache one that the
   * server has already handed out for a finished session.
   *
   * Custom tokens are minted by your backend, never in the browser. See the
   * README's "Authenticated signaling" section for the claims contract.
   */
  authTokenProvider?: () => Promise<string>;

  /**
   * Firebase Web API key. **Required whenever `authTokenProvider` is set and
   * no `firebaseApp` is supplied** -- Firebase Auth cannot sign in on an app
   * initialized with `databaseURL` alone, so a missing key fails `init()` with
   * a clear error rather than a confusing Auth internal one. Not needed when
   * you pass your own already-configured `firebaseApp`.
   *
   * The Web API key is a PUBLIC project identifier, not a secret (it ships in
   * every Firebase web app's bundle; access control is the job of the RTDB
   * security rules). It must still arrive through this config -- from your
   * shell, env, or server -- and never be hardcoded in engine or game source.
   */
  apiKey?: string;

  /**
   * Called when authentication fails in a way the strategy cannot recover
   * from on its own: the provider or sign-in failing during `init()`, a
   * re-auth cycle failing, or a signaling listener being cancelled by the
   * server. A cancelled listener is NOT re-subscribed automatically -- the
   * application should rejoin the room in response.
   */
  onAuthError?: (error: Error) => void;
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

  /**
   * Refresh the lobby announcement with live occupancy (optional).
   * Only meaningful on the peer that originally announced the room.
   */
  updateRoomOccupancy?(roomId: string, playerCount: number, state?: 'lobby' | 'playing' | 'ended'): void;

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
