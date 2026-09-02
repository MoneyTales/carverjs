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
 *
 * AUTHENTICATION IS OPTIONAL. Without `authTokenProvider` the strategy
 * connects anonymously and never loads `firebase/auth` at all, which is both
 * the historical behaviour and the smaller bundle. With a provider, a custom
 * token is exchanged for a session BEFORE any RTDB handle is created, so no
 * unauthenticated read or write can slip out ahead of sign-in.
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

  // Auth state. All three stay null on the anonymous path -- their presence is
  // what "auth is active" means everywhere below.
  /** Narrow structural view of the Auth instance: only signed-in-ness matters
   *  here, and typing it this way keeps `firebase/auth` out of the type graph
   *  of consumers who never use it. */
  private _auth: { currentUser: object | null } | null = null;
  /** Closure over the imported `signInWithCustomToken` + the Auth instance. */
  private _signIn: ((token: string) => Promise<void>) | null = null;
  /** In-flight re-auth cycle, shared by every concurrent caller so a burst of
   *  permission_denied events produces exactly ONE cycle. */
  private _reauthCycle: Promise<void> | null = null;
  /** A re-auth already failed on this RTDB connection. Cleared on the next
   *  `.info/connected` transition -- a new connection earns a new attempt. */
  private _reauthFailed = false;

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
  private _lastAnnouncement: RoomAnnouncement | null = null;
  private _lobbyWired = false;
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
    const { ref, set, onChildAdded, onChildRemoved, onDisconnect, onValue, remove } = this._fb;
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

    // 1b. Re-arm presence on every reconnection -- see _rearmPresence for why
    // this is load-bearing and what it has to survive.
    const generation = this._joinGeneration;
    const connectedRef = ref(this._db, '.info/connected');
    // `.info/connected` is a client-side pseudo-path: it is never subject to
    // security rules and so is never cancelled. It stays the reliable heartbeat
    // that drives recovery even when every rules-governed listener is gone.
    const connectedUnsub = onValue(connectedRef, (snap: any) => {
      if (snap.val() !== true) return;
      if (this._destroyed || this._joinGeneration !== generation || this._roomId !== roomId) return;
      // A fresh connection earns a fresh re-auth attempt.
      this._reauthFailed = false;
      void this._rearmPresence(presenceRef, peerMeta, generation, roomId);
    });
    this._listeners.push(() => connectedUnsub());

    // 1c. Defend our own presence node against deletion by anyone else.
    // A room-scoped token necessarily lets every member of a room write
    // anywhere in it, so a co-player can delete this node. When that happens
    // every other peer sees onChildRemoved, tears down its link, and we become
    // invisible -- with no error to surface and, crucially, no reconnect, so
    // the `.info/connected` re-arm above never fires and we stay a ghost for
    // the rest of the session. Watching our own node turns a permanent
    // eviction into a blip: we put it back, and the other peers rediscover us
    // through the onChildAdded they were always listening for.
    //
    // This cannot spin: a restore only runs when the value transitions to
    // null, and the restore itself writes a non-null value. Our own
    // onDisconnect removal is not a case here -- by the time it fires on the
    // server we are disconnected and this listener is not running either.
    // No staleness check here: _rearmPresence re-checks the identical predicate
    // after every await, which is the only place it can be checked correctly.
    const selfPresenceUnsub = onValue(presenceRef, (snap: any) => {
      if (snap.val() !== null) return;
      void this._rearmPresence(presenceRef, peerMeta, generation, roomId);
    }, this._cancelHandler('own presence'));
    this._listeners.push(() => selfPresenceUnsub());

    // 2. Listen for peers joining
    const peersRef = ref(this._db, paths.peers);
    const addedUnsub = onChildAdded(peersRef, (snapshot: any) => {
      const data = snapshot.val();
      // A presence node is only believable if it names its peer. Well-written
      // security rules can enforce that, but this is a public engine: the
      // default Firebase project has open rules, and a strategy pointed at one
      // will happily surface a node with no `peerId` as a peer called
      // `undefined` that the mesh then tries to dial. Cheap to refuse here,
      // and it holds whatever the backend's rules happen to be.
      if (!isPeerId(data?.peerId) || data.peerId === this.selfId) return;
      if (!this._knownPeers.has(data.peerId)) {
        this._knownPeers.add(data.peerId);
        for (const cb of this._onPeerDiscovered) cb(data.peerId, data.meta ?? {});
      }
    }, this._cancelHandler('peers joined'));
    this._listeners.push(() => addedUnsub());

    // 3. Listen for peers leaving
    const removedUnsub = onChildRemoved(peersRef, (snapshot: any) => {
      const data = snapshot.val();
      const peerId: unknown = data?.peerId ?? snapshot.key;
      // Only ever forget a peer we actually knew, so a malformed node cannot
      // evict anyone: _knownPeers only ever holds validated ids.
      if (isPeerId(peerId) && this._knownPeers.has(peerId)) {
        this._knownPeers.delete(peerId);
        for (const cb of this._onPeerLeft) cb(peerId);
      }
    }, this._cancelHandler('peers left'));
    this._listeners.push(() => removedUnsub());

    // 4. Listen for signals addressed to us
    const signalRef = ref(this._db, paths.peerSignalInbox);
    const signalUnsub = onChildAdded(signalRef, (snapshot: any) => {
      const msg = snapshot.val();
      // Same reasoning as presence: an entry with no usable `from` cannot be
      // answered, and handing it to the transport opens a connection attempt
      // against a peer id that does not exist.
      if (!isPeerId(msg?.from) || msg.from === this.selfId) return;
      for (const cb of this._onSignal) cb(msg.from, msg.data);
      // Remove processed signal to keep the inbox clean
      swallow(remove(snapshot.ref));
    }, this._cancelHandler('signal inbox'));
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
    // Fire-and-forget, but never unhandled: under security rules a rejected
    // push is a real signal (stale token, wrong room claim), and an
    // unhandled rejection would hide it behind a console warning.
    const pushed: unknown = push(ref(this._db, inboxPath), {
      from: this.selfId,
      data: sanitizeForFirebase(data),
      ts: Date.now(),
    });
    swallow(pushed, (err) => {
      if (isPermissionDenied(err)) void this._reauth().catch(() => {});
    });
  }

  subscribeToLobby(cb: (rooms: RoomAnnouncement[]) => void): () => void {
    this._onLobby.push(cb);

    // Wire the underlying RTDB listener exactly once — repeated subscribe/
    // unsubscribe cycles (React StrictMode, route changes) must not stack
    // duplicate onValue listeners.
    if (this._lobbyWired) {
      return () => {
        removeFromArray(this._onLobby, cb);
      };
    }
    this._lobbyWired = true;

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
      // No re-auth on this one. A deployment may deliberately deny the lobby
      // (rooms handed out by a server instead of discovered), and that is a
      // rules decision, not a stale token -- retrying auth would never fix it.
      }, this._cancelHandler('lobby', false));
      this._listeners.push(() => unsub());
    }).catch((err: unknown) => {
      this._reportAuthError(toError(err, 'Firebase signaling init failed'));
    });

    return () => {
      removeFromArray(this._onLobby, cb);
    };
  }

  announceRoom(announcement: RoomAnnouncement): void {
    if (!this._db || !this._fb) return;
    const { ref, set } = this._fb;
    const paths = firebasePaths(this._appId, announcement.roomId, '');

    this._lastAnnouncement = announcement;
    announcement.lastSeen = Date.now();
    swallow(set(ref(this._db, paths.roomLobbyEntry), sanitizeForFirebase(announcement)));

    // Periodic heartbeat
    if (this._lobbyAnnounceTimer) clearInterval(this._lobbyAnnounceTimer);
    this._lobbyAnnounceTimer = setInterval(() => {
      announcement.lastSeen = Date.now();
      swallow(set(ref(this._db, paths.roomLobbyEntry), sanitizeForFirebase(announcement)));
    }, ROOM_ANNOUNCE_INTERVAL_MS);
  }

  updateRoomOccupancy(roomId: string, playerCount: number, state?: 'lobby' | 'playing' | 'ended'): void {
    const ann = this._lastAnnouncement;
    if (!ann || ann.roomId !== roomId || !this._db || !this._fb) return;
    ann.playerCount = playerCount;
    if (state) ann.state = state;
    ann.lastSeen = Date.now();
    const { ref, set } = this._fb;
    const paths = firebasePaths(this._appId, roomId, '');
    swallow(set(ref(this._db, paths.roomLobbyEntry), sanitizeForFirebase(ann)));
  }

  removeRoomAnnouncement(roomId: string): void {
    if (!this._db || !this._fb) return;
    const { ref, remove } = this._fb;
    swallow(remove(ref(this._db, firebasePaths(this._appId, roomId, '').roomLobbyEntry)));
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
    this._auth = null;
    this._signIn = null;
    this._reauthCycle = null;
    this._knownPeers.clear();
    this._onPeerDiscovered = [];
    this._onPeerLeft = [];
    this._onSignal = [];
    this._onLobby = [];
  }

  // ── Private ──

  private _ensureInit(): Promise<void> {
    if (!this._initPromise) {
      // A FAILED init is deliberately not cached. Auth can fail for reasons
      // that later go away -- a token endpoint that was briefly down, a
      // session the shell has since refreshed -- and the caller must be able
      // to retry by joining again rather than by rebuilding the strategy.
      this._initPromise = this._doInit().catch((err: unknown) => {
        this._initPromise = null;
        throw err;
      });
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

    const provider = this._config.authTokenProvider;
    const ownsApp = !this._config.firebaseApp;

    // Fail before creating anything. `initializeApp({databaseURL})` produces an
    // app Auth cannot sign in on, and the error it raises much later points at
    // the SDK rather than at the missing key.
    if (provider && ownsApp && !this._config.apiKey) {
      throw this._reportAuthError(
        new Error(
          'FirebaseStrategyConfig.apiKey is required when authTokenProvider is set ' +
            'and no firebaseApp is supplied: Firebase Auth cannot sign in on an app ' +
            'initialized with databaseURL alone.',
        ),
      );
    }

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
        // The anonymous path keeps its exact original options object: adding a
        // key here, even an undefined one, would change app identity for
        // callers who already share this named app.
        this._firebaseApp = initializeApp(
          provider
            ? { databaseURL: this._config.databaseURL, apiKey: this._config.apiKey }
            : { databaseURL: this._config.databaseURL },
          appName,
        );
        this._ownApp = true;
      }
    }

    // Anonymous path stops here, having never touched `firebase/auth`: the
    // import below is inside the branch precisely so bundlers can drop it.
    if (provider) {
      const { getAuth, signInWithCustomToken } = await import('firebase/auth');
      const auth = getAuth(this._firebaseApp);
      this._auth = auth;
      this._signIn = async (token: string): Promise<void> => {
        await signInWithCustomToken(auth, token);
      };
      // BEFORE getDatabase: no RTDB handle exists until the session does, so
      // there is no window in which an unauthenticated read or write is
      // possible.
      await this._authenticate(provider);
    }

    this._db = getDatabase(this._firebaseApp);
  }

  /**
   * Initial sign-in: fetch a custom token and exchange it, retrying the pair
   * as one unit. A provider that throws and a token the backend has already
   * expired are the same failure from here -- both are fixed by asking again.
   */
  private async _authenticate(provider: () => Promise<string>): Promise<void> {
    const signIn = this._signIn;
    if (!signIn) return;
    let lastError: unknown;
    for (let attempt = 0; attempt <= AUTH_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(AUTH_RETRY_DELAYS_MS[attempt - 1]);
      if (this._destroyed) throw new Error('FirebaseStrategy destroyed during sign-in');
      try {
        await signIn(await provider());
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw this._reportAuthError(
      toError(lastError, 'Firebase custom-token sign-in failed after retries'),
    );
  }

  /**
   * ONE re-auth cycle -- a fresh token and a fresh sign-in -- shared by every
   * caller that hits it. Concurrent callers get the same in-flight promise, and
   * a cycle that has already failed is not retried until `.info/connected`
   * reports a new connection. Together that is the "exactly once" the
   * permission_denied paths need: a denied room does not become a token loop.
   */
  private _reauth(): Promise<void> {
    const provider = this._config.authTokenProvider;
    const signIn = this._signIn;
    if (!provider || !signIn || this._destroyed) return Promise.resolve();
    if (this._reauthFailed) {
      return Promise.reject(
        new Error('Firebase re-authentication already failed on this connection'),
      );
    }
    if (this._reauthCycle) return this._reauthCycle;

    const cycle = (async (): Promise<void> => {
      try {
        await signIn(await provider());
      } catch (err) {
        this._reauthFailed = true;
        throw this._reportAuthError(toError(err, 'Firebase re-authentication failed'));
      } finally {
        this._reauthCycle = null;
      }
    })();
    this._reauthCycle = cycle;
    return cycle;
  }

  /**
   * Re-establish presence on every reconnection to the RTDB. Firebase
   * onDisconnect handlers fire only once and remove our presence node; the SDK
   * does NOT re-create the value when it reconnects. Without this, a transient
   * RTDB disconnect (tab backgrounding, network handoff, server recycling)
   * permanently deletes our presence even though the P2P WebRTC links stay
   * healthy -- every other peer then sees onChildRemoved, tears down our
   * connection, and the room fragments into isolated single-player sessions.
   * Canonical presence pattern: re-arm onDisconnect BEFORE re-writing the
   * value, on every transition to connected.
   *
   * Under auth there is a second failure to absorb. A reconnect can land after
   * the session was revoked or the token expired, in which case the write is
   * denied rather than dropped. So: verify we are still signed in first, and
   * treat a denial as one chance to re-auth and write again.
   */
  private async _rearmPresence(
    presenceRef: unknown,
    peerMeta: PeerMetadata,
    generation: number,
    roomId: string,
  ): Promise<void> {
    const fb = this._fb;
    if (!fb) return;
    const stale = (): boolean =>
      this._destroyed || this._joinGeneration !== generation || this._roomId !== roomId;

    // Signed out while disconnected: writing first would only produce a denial
    // we already know is coming.
    if (this._auth && this._auth.currentUser === null) {
      if (!(await this._reauth().then(() => true, () => false))) return;
    }
    if (stale()) return;

    const write = async (): Promise<void> => {
      await fb.onDisconnect(presenceRef).remove();
      if (stale()) return;
      await fb.set(presenceRef, { peerId: this.selfId, meta: peerMeta, ts: Date.now() });
    };

    try {
      await write();
    } catch (err) {
      if (stale() || !isPermissionDenied(err)) return;
      // Anonymous: a denial is a rules problem and there is no token to
      // refresh, so retrying would just be the same denied write again.
      if (!this._config.authTokenProvider) return;
      if (!(await this._reauth().then(() => true, () => false))) return;
      if (stale()) return;
      await write().catch((retryErr: unknown) => {
        this._reportAuthError(
          toError(retryErr, 'Firebase presence write denied after re-authentication'),
        );
      });
    }
  }

  /**
   * Build the cancel callback for an RTDB listener (the second argument of
   * onValue/onChildAdded/onChildRemoved). Without one, a server-side
   * cancellation -- always permission_denied in practice -- silently drops the
   * subscription and the peer quietly stops discovering peers or receiving
   * signals, looking to the player like a game that simply never connects.
   *
   * The subscription itself is gone for good; the SDK does not retry it, and
   * re-subscribing here would duplicate the wiring joinRoom already owns. So
   * the cancellation is always surfaced through onAuthError -- the application
   * recovers by rejoining -- while a re-auth cycle runs alongside it so writes
   * on the surviving `.info/connected` path can recover.
   */
  private _cancelHandler(what: string, reauth = true): (error: Error) => void {
    return (error: Error): void => {
      if (this._destroyed) return;
      if (reauth && this._config.authTokenProvider && isPermissionDenied(error)) {
        this._reauth().catch(() => {});
      }
      this._reportAuthError(
        toError(error, `Firebase signaling listener cancelled (${what})`),
      );
    };
  }

  /** Hand an error to the caller's onAuthError and give it back, so callers
   *  can `throw this._reportAuthError(...)`. A callback that itself throws
   *  must not replace the error it was told about. */
  private _reportAuthError(error: Error): Error {
    try {
      this._config.onAuthError?.(error);
    } catch {
      // The application's error handler is not this strategy's problem.
    }
    return error;
  }
}

/** Backoff before each retry of the initial provider + sign-in pair. Three
 *  delays, so four attempts in all. */
const AUTH_RETRY_DELAYS_MS = [250, 1000, 4000];

/** Shape of an id from `generatePeerId()`: 20 URL-safe alphanumerics. Anything
 *  else reaching us over the signaling network is not one of our peers. */
function isPeerId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{20}$/.test(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Turn anything thrown into an Error that still says WHERE it came from.
 *
 * Returning the original untouched would be simpler and was wrong: RTDB always
 * throws real Errors, so `onAuthError` received a bare "permission_denied" with
 * no indication of which listener died or which write was refused -- and since
 * the application's only recovery is to rejoin, that context is the whole point
 * of the callback. The original is kept as `cause`, and its `code` is copied
 * across because that is what callers branch on.
 */
function toError(err: unknown, context: string): Error {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return Object.assign(new Error(`${context}: ${err.message}`), {
      cause: err,
      ...(typeof code === 'string' ? { code } : {}),
    });
  }
  const detail = typeof err === 'string' && err.length > 0 ? `: ${err}` : '';
  return new Error(`${context}${detail}`);
}

/**
 * Is this the RTDB's permission_denied? Both spellings are checked because the
 * shape differs by call site: listener cancellations carry `code`, write
 * rejections carry it only in the message, and the emulator and production
 * have differed on casing.
 */
function isPermissionDenied(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  const text = `${typeof code === 'string' ? code : ''} ${
    typeof message === 'string' ? message : ''
  }`.toUpperCase();
  return text.includes('PERMISSION_DENIED') || text.includes('PERMISSION DENIED');
}

/**
 * Attach a handler to a fire-and-forget RTDB write so a rejection is never
 * unhandled. `push()` returns a ThenableReference and `set()`/`remove()` a
 * plain promise; both are typed loosely here because they come from the
 * dynamically imported module holder.
 */
function swallow(result: unknown, onError?: (err: unknown) => void): void {
  if (typeof (result as { catch?: unknown } | null)?.catch !== 'function') return;
  (result as Promise<unknown>).catch((err: unknown) => {
    onError?.(err);
  });
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
      if (value === undefined) continue; // RTDB rejects undefined anywhere in the payload
      result[key] = value === null ? '__null__' : sanitizeForFirebase(value);
    }
    return result;
  }
  return obj;
}
