import type {
  SignalingStrategy,
  PeerMetadata,
  RoomAnnouncement,
  FirebaseStrategyConfig,
} from "./types";
import {
  generatePeerId,
  firebasePaths,
  removeFromArray,
  ROOM_ANNOUNCE_EXPIRY_MS,
  ROOM_ANNOUNCE_INTERVAL_MS,
} from "./utils";

/**
 * Firebase Realtime Database signaling strategy.
 *
 * Requires the `firebase` package as a peer dependency.
 * Pass either a `databaseURL` (auto-creates a namespaced Firebase app)
 * or an existing `firebaseApp` instance.
 *
 * Presence cleanup is automatic via Firebase onDisconnect().
 */
export class FirebaseStrategy implements SignalingStrategy {
  readonly selfId: string;

  private _appId: string;
  private _config: FirebaseStrategyConfig;
  private _db: any = null;
  private _firebaseApp: any = null;
  private _ownApp = false;
  private _roomId: string | null = null;
  private _peerMeta: PeerMetadata = {};
  /** Monotonic counter to detect stale leaveRoom completions */
  private _joinGeneration = 0;

  // Lazy init
  private _initPromise: Promise<void> | null = null;

  // Firebase module references (filled after dynamic import)
  private _fb: {
    ref: any;
    set: any;
    push: any;
    remove: any;
    onValue: any;
    onChildAdded: any;
    onChildRemoved: any;
    onDisconnect: any;
  } | null = null;

  // Unsubscribe handles for Firebase listeners
  private _listeners: (() => void)[] = [];

  // Callbacks
  private _onPeerDiscovered: ((peerId: string, meta: PeerMetadata) => void)[] = [];
  private _onPeerLeft: ((peerId: string) => void)[] = [];
  private _onSignal: ((fromPeerId: string, data: unknown) => void)[] = [];
  private _onLobby: ((rooms: RoomAnnouncement[]) => void)[] = [];

  // State
  private _knownPeers = new Set<string>();
  private _lobbyAnnounceTimer: ReturnType<typeof setInterval> | null = null;
  private _destroyed = false;

  constructor(appId: string, config: FirebaseStrategyConfig) {
    this.selfId = generatePeerId();
    this._appId = appId;
    this._config = config;
  }

  // ── Public API ──

  async init(): Promise<void> {
    return this._ensureInit();
  }

  async joinRoom(roomId: string, peerMeta: PeerMetadata): Promise<void> {
    await this._ensureInit();
    if (!this._db || !this._fb) throw new Error('Firebase not initialized');

    // Bump generation so any in-flight leaveRoom from a prior call won't
    // null out _roomId after we set it here (React StrictMode race fix).
    this._joinGeneration++;

    this._roomId = roomId;
    this._peerMeta = peerMeta;
    const { ref, set, onChildAdded, onChildRemoved, onDisconnect, remove } = this._fb;
    const paths = firebasePaths(this._appId, roomId, this.selfId);

    // Clean stale signals from our inbox before listening (prevents
    // replaying SDP from a previous session that wasn't cleaned up).
    await remove(ref(this._db, paths.peerSignalInbox)).catch(() => {});

    // 1. Write presence with auto-cleanup on disconnect
    const presenceRef = ref(this._db, paths.peerPresence);
    await set(presenceRef, {
      peerId: this.selfId,
      meta: peerMeta,
      ts: Date.now(),
    });
    onDisconnect(presenceRef).remove();

    // 2. Listen for peers joining
    const peersRef = ref(this._db, paths.peers);
    const addedUnsub = onChildAdded(peersRef, (snapshot: any) => {
      const data = snapshot.val();
      if (!data || data.peerId === this.selfId) return;
      if (!this._knownPeers.has(data.peerId)) {
        this._knownPeers.add(data.peerId);
        for (const cb of this._onPeerDiscovered) cb(data.peerId, data.meta ?? {});
      }
    });
    this._listeners.push(() => addedUnsub());

    // 3. Listen for peers leaving
    const removedUnsub = onChildRemoved(peersRef, (snapshot: any) => {
      const data = snapshot.val();
      const peerId = data?.peerId ?? snapshot.key;
      if (peerId && this._knownPeers.has(peerId)) {
        this._knownPeers.delete(peerId);
        for (const cb of this._onPeerLeft) cb(peerId);
      }
    });
    this._listeners.push(() => removedUnsub());

    // 4. Listen for signals addressed to us
    const signalRef = ref(this._db, paths.peerSignalInbox);
    const signalUnsub = onChildAdded(signalRef, (snapshot: any) => {
      const msg = snapshot.val();
      if (!msg || msg.from === this.selfId) return;
      for (const cb of this._onSignal) cb(msg.from, msg.data);
      // Remove processed signal to keep the inbox clean
      remove(snapshot.ref);
    });
    this._listeners.push(() => signalUnsub());
  }

  async leaveRoom(): Promise<void> {
    if (!this._db || !this._fb || !this._roomId) return;

    // Capture current state so async cleanup targets the correct room
    // even if joinRoom() is called concurrently (React StrictMode).
    const leavingRoomId = this._roomId;
    const generation = this._joinGeneration;

    const { ref, remove } = this._fb;
    const paths = firebasePaths(this._appId, leavingRoomId, this.selfId);

    // Detach listeners
    for (const unsub of this._listeners) unsub();
    this._listeners = [];

    // Remove presence and signal inbox
    await Promise.all([
      remove(ref(this._db, paths.peerPresence)),
      remove(ref(this._db, paths.peerSignalInbox)),
    ]).catch(() => {});

    if (this._lobbyAnnounceTimer) {
      clearInterval(this._lobbyAnnounceTimer);
      this._lobbyAnnounceTimer = null;
    }

    this._knownPeers.clear();

    // Only null out _roomId if no new joinRoom() has run since we started.
    // This prevents the StrictMode race: old leaveRoom completing after
    // new joinRoom already set _roomId to the fresh value.
    if (this._joinGeneration === generation) {
      this._roomId = null;
    }
  }

  signal(targetPeerId: string, data: unknown): void {
    if (!this._db || !this._fb || !this._roomId) return;
    const { ref, push } = this._fb;

    // Atomic push: single operation writes the key + data together.
    // Avoids the push() + set() two-step that can cause onChildAdded to
    // fire with null if the listener catches the intermediate state.
    const inboxPath = firebasePaths(this._appId, this._roomId, targetPeerId).peerSignalInbox;
    push(ref(this._db, inboxPath), {
      from: this.selfId,
      data: sanitizeForFirebase(data),
      ts: Date.now(),
    });
  }

  subscribeToLobby(cb: (rooms: RoomAnnouncement[]) => void): () => void {
    this._onLobby.push(cb);

    this._ensureInit().then(() => {
      if (!this._db || !this._fb || this._destroyed) return;
      const { ref, onValue } = this._fb;
      const paths = firebasePaths(this._appId, '', '');
      const lobbyRef = ref(this._db, paths.lobby);

      const unsub = onValue(lobbyRef, (snapshot: any) => {
        const data = snapshot.val();
        if (!data) {
          for (const lcb of this._onLobby) lcb([]);
          return;
        }
        const now = Date.now();
        const rooms: RoomAnnouncement[] = Object.values(data).filter(
          (r: any) => r && now - (r.lastSeen ?? 0) < ROOM_ANNOUNCE_EXPIRY_MS,
        ) as RoomAnnouncement[];
        for (const lcb of this._onLobby) lcb(rooms);
      });
      this._listeners.push(() => unsub());
    });

    return () => {
      removeFromArray(this._onLobby, cb);
    };
  }

  announceRoom(announcement: RoomAnnouncement): void {
    if (!this._db || !this._fb) return;
    const { ref, set } = this._fb;
    const paths = firebasePaths(this._appId, announcement.roomId, '');

    announcement.lastSeen = Date.now();
    set(ref(this._db, paths.roomLobbyEntry), announcement);

    // Periodic heartbeat
    if (this._lobbyAnnounceTimer) clearInterval(this._lobbyAnnounceTimer);
    this._lobbyAnnounceTimer = setInterval(() => {
      announcement.lastSeen = Date.now();
      set(ref(this._db, paths.roomLobbyEntry), announcement);
    }, ROOM_ANNOUNCE_INTERVAL_MS);
  }

  removeRoomAnnouncement(roomId: string): void {
    if (!this._db || !this._fb) return;
    const { ref, remove } = this._fb;
    remove(ref(this._db, firebasePaths(this._appId, roomId, '').roomLobbyEntry));
    if (this._lobbyAnnounceTimer) {
      clearInterval(this._lobbyAnnounceTimer);
      this._lobbyAnnounceTimer = null;
    }
  }

  onPeerDiscovered(cb: (peerId: string, meta: PeerMetadata) => void): () => void {
    this._onPeerDiscovered.push(cb);
    return () => { removeFromArray(this._onPeerDiscovered, cb); };
  }

  onPeerLeft(cb: (peerId: string) => void): () => void {
    this._onPeerLeft.push(cb);
    return () => { removeFromArray(this._onPeerLeft, cb); };
  }

  onSignal(cb: (fromPeerId: string, data: unknown) => void): () => void {
    this._onSignal.push(cb);
    return () => { removeFromArray(this._onSignal, cb); };
  }

  destroy(): void {
    this._destroyed = true;
    for (const unsub of this._listeners) unsub();
    this._listeners = [];

    if (this._lobbyAnnounceTimer) {
      clearInterval(this._lobbyAnnounceTimer);
      this._lobbyAnnounceTimer = null;
    }

    // Best-effort cleanup
    if (this._db && this._fb && this._roomId) {
      const { ref, remove } = this._fb;
      const paths = firebasePaths(this._appId, this._roomId, this.selfId);
      remove(ref(this._db, paths.peerPresence)).catch(() => {});
      remove(ref(this._db, paths.peerSignalInbox)).catch(() => {});
    }

    // Delete own Firebase app if we created it
    if (this._ownApp && this._firebaseApp) {
      import('firebase/app').then(({ deleteApp }) => {
        deleteApp(this._firebaseApp).catch(() => {});
      });
    }

    this._db = null;
    this._firebaseApp = null;
    this._fb = null;
    this._knownPeers.clear();
    this._onPeerDiscovered = [];
    this._onPeerLeft = [];
    this._onSignal = [];
    this._onLobby = [];
  }

  // ── Private ──

  private _ensureInit(): Promise<void> {
    if (!this._initPromise) {
      this._initPromise = this._doInit();
    }
    return this._initPromise;
  }

  private async _doInit(): Promise<void> {
    const { initializeApp, getApps } = await import('firebase/app');
    const {
      getDatabase,
      ref,
      set,
      push,
      remove,
      onValue,
      onChildAdded,
      onChildRemoved,
      onDisconnect,
    } = await import('firebase/database');

    this._fb = { ref, set, push, remove, onValue, onChildAdded, onChildRemoved, onDisconnect };

    if (this._config.firebaseApp) {
      this._firebaseApp = this._config.firebaseApp;
      this._ownApp = false;
    } else {
      const appName = `carver_${this._appId}`;
      const existing = getApps().find((a: any) => a.name === appName);
      if (existing) {
        this._firebaseApp = existing;
        this._ownApp = false;
      } else {
        this._firebaseApp = initializeApp({ databaseURL: this._config.databaseURL }, appName);
        this._ownApp = true;
      }
    }

    this._db = getDatabase(this._firebaseApp);
  }
}

/**
 * Firebase RTDB deletes any key whose value is `null` (treats null as "remove").
 * ICE candidates from `toJSON()` can contain `null` fields (e.g. usernameFragment).
 * We recursively replace `null` with a sentinel so Firebase preserves the key.
 * On the receiving end, `_handleSignal` doesn't need to reverse this because
 * `new RTCIceCandidate()` / `new RTCSessionDescription()` accept missing fields.
 */
function sanitizeForFirebase(obj: unknown): unknown {
  if (obj === null) return '__null__';
  if (Array.isArray(obj)) return obj.map(sanitizeForFirebase);
  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = value === null ? '__null__' : sanitizeForFirebase(value);
    }
    return result;
  }
  return obj;
}
