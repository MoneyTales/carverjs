import type {
  CarverTransport,
  CarverChannel,
  ChannelOptions,
  TransportConfig,
  Player,
  Room,
  RoomState,
} from "../../types";
import type { TransportCallbacks, RateLimitConfig } from "../types";
import type { SignalingStrategy, PeerMetadata } from "../strategy/types";
import { buildICEConfig } from "./ice";
import { PeerConnection } from "./peer";

const ROOM_CONTROL_CHANNEL = 'carver:room-control';

/**
 * STUN-only reliability: how long to wait for a pair to reach 'connected'
 * before the deterministic initiator re-sends its offer, and how many times.
 * A handshake that loses its offer/answer/candidate in signaling — or whose
 * STUN server-reflexive candidates gather slowly — otherwise sits in
 * 'connecting' forever: it never reaches 'failed', so the drop handler never
 * fires and the pair stays mutually invisible for the whole session.
 */
const CONNECT_RETRY_DELAY_MS = 4000;
const CONNECT_RETRY_MAX_ATTEMPTS = 5;

interface ChannelState<T> {
  name: string;
  options: ChannelOptions;
  receivers: ((data: T, peerId: string) => void)[];
}

/** Room control messages exchanged over the room-control data channel */
type RoomControlMessage =
  | { type: 'player-updated'; player: Player }
  | { type: 'room-updated'; room: Partial<Room> }
  | { type: 'kick'; peerId: string; reason?: string }
  | { type: 'host-changed'; newHostId: string }
  | { type: 'request-ready'; ready: boolean }
  | { type: 'request-metadata'; metadata: Record<string, unknown> }
  | { type: 'request-room-metadata'; metadata: Record<string, unknown> }
  | { type: 'request-room-state'; state: RoomState }
  | { type: 'request-max-players'; maxPlayers: number }
  | { type: 'request-lock' }
  | { type: 'request-unlock' }
  | { type: 'request-transfer-host'; peerId: string }
  | { type: 'sync-state'; room: Room; players: Player[] };

/**
 * Deterministic, globally-consistent host election.
 *
 * Lowest hostPriority wins; ties are broken by lowest peerId. A peer advertises
 * its priority via player metadata (`metadata.hostPriority`, lower = preferred)
 * so the room creator / world owner can pin itself as host regardless of its
 * random peerId. With no priorities advertised this reduces exactly to the
 * previous "lowest peerId" election (backwards compatible).
 */
function electHost(peerIds: string[], rankOf: (peerId: string) => number): string {
  let best = peerIds[0];
  let bestRank = rankOf(best);
  for (const id of peerIds) {
    const rank = rankOf(id);
    if (rank < bestRank || (rank === bestRank && id < best)) {
      best = id;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Implements CarverTransport using WebRTC data channels for game data
 * and a pluggable SignalingStrategy for peer discovery + SDP/ICE relay.
 *
 * No WebSocket server required. The strategy handles signaling through
 * MQTT brokers, Firebase RTDB, or any other network.
 */
export class WebRTCTransport implements CarverTransport {
  private _strategy: SignalingStrategy;
  private _peers = new Map<string, PeerConnection>();
  private _peerSet = new Set<string>();
  private _peerId: string;
  private _hostId = '';
  private _isHost = false;
  private _callbacks: TransportCallbacks = {
    onPeerJoin: [],
    onPeerLeave: [],
    onPeerUpdated: [],
    onHostChanged: [],
  };
  private _roomUpdatedCallbacks: ((room: Room) => void)[] = [];
  private _channels = new Map<string, ChannelState<any>>();
  private _iceConfig: RTCConfiguration;
  private _rateLimitConfig: RateLimitConfig = { maxMessagesPerSecond: 60, windowMs: 1000 };
  private _rateLimitCounters = new Map<string, { count: number; resetAt: number }>();
  private _connected = false;
  private _room: Room | null = null;
  private _playerMap = new Map<string, Player>();
  private _initialPeers: Player[] = [];
  private _strategyUnsubs: (() => void)[] = [];

  /**
   * @param strategy  Shared SignalingStrategy instance (managed by MultiplayerProvider)
   * @param iceServers  Optional ICE servers (STUN + TURN). Defaults to public STUN.
   * @param iceTransportPolicy  'all' (default) or 'relay' (force TURN only).
   */
  constructor(
    strategy: SignalingStrategy,
    iceServers?: RTCIceServer[],
    iceTransportPolicy?: RTCIceTransportPolicy,
  ) {
    this._strategy = strategy;
    this._peerId = strategy.selfId;
    this._iceConfig = buildICEConfig({ iceServers, iceTransportPolicy });
  }

  // ── CarverTransport getters ──

  get peerId(): string { return this._peerId; }
  get peers(): ReadonlySet<string> { return this._peerSet; }
  get hostId(): string { return this._hostId; }
  get isHost(): boolean { return this._isHost; }
  get room(): Room | undefined { return this._room ?? undefined; }
  get initialPlayers(): Player[] { return this._initialPeers; }

  // ── Event registration ──

  onPeerJoin(cb: (peerId: string) => void): void { this._callbacks.onPeerJoin.push(cb); }
  onPeerLeave(cb: (peerId: string) => void): void { this._callbacks.onPeerLeave.push(cb); }
  onPeerUpdated(cb: (player: Player) => void): void { this._callbacks.onPeerUpdated.push(cb); }
  onRoomUpdated(cb: (room: Room) => void): void { this._roomUpdatedCallbacks.push(cb); }
  onHostChanged(cb: (newHostId: string) => void): void { this._callbacks.onHostChanged.push(cb); }

  // ── Channel management ──

  createChannel<T>(name: string, options?: ChannelOptions): CarverChannel<T> {
    // Idempotent: return existing channel if already created
    const existing = this._channels.get(name);
    if (existing) {
      return {
        send: (data: T, target?: string | string[]) => this._sendOnChannel(name, data, target),
        onReceive: (cb: (data: T, peerId: string) => void) => { existing.receivers.push(cb); },
        close: () => { this._channels.delete(name); },
      };
    }

    const state: ChannelState<T> = {
      name,
      options: options ?? { reliable: true, ordered: true },
      receivers: [],
    };
    this._channels.set(name, state);

    // Create data channels on existing peers if already connected
    if (this._connected) {
      for (const peer of this._peers.values()) {
        this._createDataChannelOnPeer(peer, name, state.options);
      }
    }

    return {
      send: (data: T, target?: string | string[]) => this._sendOnChannel(name, data, target),
      onReceive: (cb: (data: T, peerId: string) => void) => { state.receivers.push(cb); },
      close: () => { this._channels.delete(name); },
    };
  }

  // ── Connect / Disconnect ──

  async connect(roomId: string, config?: TransportConfig): Promise<void> {
    // Override ICE config if user passed custom servers
    if (config?.iceServers) {
      this._iceConfig = buildICEConfig({
        iceServers: config.iceServers,
        iceTransportPolicy: config.iceTransportPolicy,
      });
    }

    // Pre-register ALL standard channels so the initiator includes them
    // in the initial WebRTC offer. Channels created after the peer connection
    // is established won't get a proper data channel on the remote side.
    this._setupRoomControlChannel();
    this._preRegisterChannel('carver:events', { reliable: true, ordered: true });
    this._preRegisterChannel('carver:snapshots', { reliable: false, ordered: false });
    this._preRegisterChannel('carver:acks', { reliable: true, ordered: true });
    this._preRegisterChannel('carver:inputs', { reliable: true, ordered: true });
    this._preRegisterChannel('carver:network-state', { reliable: true, ordered: true });

    // Bind strategy callbacks (store unsubs for cleanup)
    this._strategyUnsubs.push(
      this._strategy.onPeerDiscovered((peerId, meta) => {
        this._onStrategyPeerDiscovered(peerId, meta);
      }),
    );
    this._strategyUnsubs.push(
      this._strategy.onPeerLeft((peerId) => {
        this._onStrategyPeerLeft(peerId);
      }),
    );
    this._strategyUnsubs.push(
      this._strategy.onSignal((fromPeerId, data) => {
        this._handleSignal(fromPeerId, data);
      }),
    );

    // Join room via strategy (publishes presence, subscribes to room)
    await this._strategy.joinRoom(roomId, {
      displayName: config?.displayName,
      ...(config?.playerMetadata ?? {}),
    });

    // Create self Player
    const selfPlayer: Player = {
      peerId: this._peerId,
      displayName: config?.displayName ?? `Player-${this._peerId.slice(0, 4)}`,
      isHost: false,
      isSelf: true,
      isReady: false,
      isConnected: true,
      metadata: config?.playerMetadata ?? {},
      latencyMs: 0,
      joinedAt: Date.now(),
    };
    this._playerMap.set(this._peerId, selfPlayer);

    // Elect host (may just be us if we're the first in the room)
    this._electAndSetHost();

    // Create initial Room object
    this._room = {
      id: roomId,
      name: roomId,
      hostId: this._hostId,
      playerCount: this._playerMap.size,
      maxPlayers: config?.maxPlayers ?? 8,
      isPrivate: false,
      metadata: {},
      createdAt: Date.now(),
      state: 'lobby',
    };

    this._initialPeers = Array.from(this._playerMap.values());
    this._connected = true;
  }

  disconnect(): void {
    this._connected = false;

    // Unsubscribe from strategy callbacks
    for (const unsub of this._strategyUnsubs) unsub();
    this._strategyUnsubs = [];

    // Close all peer connections
    for (const peer of this._peers.values()) peer.close();
    this._peers.clear();
    this._peerSet.clear();
    // Cancel any in-flight establishment re-offer timers
    for (const t of this._connectRetryTimers.values()) clearTimeout(t);
    this._connectRetryTimers.clear();
    this._connectAttempts.clear();
    this._channels.clear();
    this._rateLimitCounters.clear();
    this._playerMap.clear();

    // Leave room via strategy (don't destroy -- provider manages lifecycle)
    this._strategy.leaveRoom().catch(() => {});

    this._hostId = '';
    this._isHost = false;
    this._room = null;
  }

  /** Expose strategy for lobby hooks */
  get strategy(): SignalingStrategy { return this._strategy; }

  // ── Channel pre-registration ──

  /**
   * Register a channel name and options without creating data channels yet.
   * When _connectToPeer runs, it iterates this._channels and creates data
   * channels for every registered name in the initial WebRTC offer.
   * Later, when EventSync/SnapshotSync call createChannel(), the idempotent
   * check returns the pre-registered entry and they just attach receivers.
   */
  private _preRegisterChannel(name: string, options: ChannelOptions): void {
    if (this._channels.has(name)) return;
    this._channels.set(name, { name, options, receivers: [] });
  }

  // ── Room management (over WebRTC data channels) ──

  setReady(ready: boolean): void {
    this._sendControlMessage({ type: 'request-ready', ready });
  }

  setMetadata(metadata: Record<string, unknown>): void {
    this._sendControlMessage({ type: 'request-metadata', metadata });
  }

  setRoomMetadata(metadata: Record<string, unknown>): void {
    if (!this._isHost) return;
    this._sendControlMessage({ type: 'request-room-metadata', metadata });
  }

  kick(peerId: string, reason?: string): void {
    if (!this._isHost) return;
    // Broadcast kick so the target peer and everyone else knows
    this._broadcastControlMessage({ type: 'kick', peerId, reason });
  }

  transferHost(peerId: string): void {
    if (!this._isHost) return;
    this._sendControlMessage({ type: 'request-transfer-host', peerId });
  }

  setRoomState(state: RoomState): void {
    if (!this._isHost) return;
    this._sendControlMessage({ type: 'request-room-state', state });
  }

  setMaxPlayers(n: number): void {
    if (!this._isHost) return;
    this._sendControlMessage({ type: 'request-max-players', maxPlayers: n });
  }

  lockRoom(): void {
    if (!this._isHost) return;
    this._sendControlMessage({ type: 'request-lock' });
  }

  unlockRoom(): void {
    if (!this._isHost) return;
    this._sendControlMessage({ type: 'request-unlock' });
  }

  /** No-op: lobby uses strategy.subscribeToLobby() directly */
  requestRoomList(): void {}

  // ── Private: Strategy callbacks ──

  private _onStrategyPeerDiscovered(peerId: string, meta: PeerMetadata): void {
    this._connectToPeer(peerId);
    this._peerSet.add(peerId);

    // Preserve prior player fields if this is a RE-discovery (e.g. the peer's
    // signaling presence flapped and was re-announced after a transient RTDB
    // reconnect) so we don't reset joinedAt / isReady / latency on a peer whose
    // P2P link never actually dropped.
    const existing = this._playerMap.get(peerId);
    const player: Player = {
      peerId,
      displayName: (meta.displayName as string) ?? existing?.displayName ?? `Player-${peerId.slice(0, 4)}`,
      isHost: false,
      isSelf: false,
      isReady: existing?.isReady ?? false,
      isConnected: true,
      metadata: meta as Record<string, unknown>,
      latencyMs: existing?.latencyMs ?? 0,
      joinedAt: existing?.joinedAt ?? Date.now(),
    };
    this._playerMap.set(peerId, player);
    this._electAndSetHost();

    for (const cb of this._callbacks.onPeerJoin) cb(peerId);
    for (const cb of this._callbacks.onPeerUpdated) cb(player);
  }

  // ── Private: Room control channel ──

  private _setupRoomControlChannel(): void {
    const ch = this.createChannel<RoomControlMessage>(ROOM_CONTROL_CHANNEL, {
      reliable: true,
      ordered: true,
    });
    ch.onReceive((msg, peerId) => {
      this._handleControlMessage(msg, peerId);
    });
  }

  private _handleControlMessage(msg: RoomControlMessage, fromPeerId: string): void {
    switch (msg.type) {
      case 'player-updated': {
        this._playerMap.set(msg.player.peerId, msg.player);
        for (const cb of this._callbacks.onPeerUpdated) cb(msg.player);
        break;
      }
      case 'room-updated': {
        if (this._room) {
          Object.assign(this._room, msg.room);
          for (const cb of this._roomUpdatedCallbacks) cb(this._room);
        }
        break;
      }
      case 'kick': {
        if (msg.peerId === this._peerId) {
          // We were kicked
          this.disconnect();
        }
        break;
      }
      case 'host-changed': {
        this._hostId = msg.newHostId;
        this._isHost = msg.newHostId === this._peerId;
        for (const cb of this._callbacks.onHostChanged) cb(msg.newHostId);
        break;
      }
      case 'sync-state': {
        // Full state sync from host (sent to newly connected peers)
        this._room = msg.room;
        for (const p of msg.players) {
          this._playerMap.set(p.peerId, { ...p, isSelf: p.peerId === this._peerId });
          for (const cb of this._callbacks.onPeerUpdated) cb(p);
        }
        for (const cb of this._roomUpdatedCallbacks) cb(msg.room);
        break;
      }

      // Host processes requests from peers
      case 'request-ready': {
        if (!this._isHost) break;
        const p = this._playerMap.get(fromPeerId);
        if (p) {
          p.isReady = msg.ready;
          this._broadcastControlMessage({ type: 'player-updated', player: p });
        }
        break;
      }
      case 'request-metadata': {
        if (!this._isHost) break;
        const pm = this._playerMap.get(fromPeerId);
        if (pm) {
          pm.metadata = { ...pm.metadata, ...msg.metadata };
          this._broadcastControlMessage({ type: 'player-updated', player: pm });
        }
        break;
      }
      case 'request-room-metadata': {
        if (!this._isHost || !this._room) break;
        this._room.metadata = { ...this._room.metadata, ...msg.metadata };
        this._broadcastControlMessage({ type: 'room-updated', room: this._room });
        break;
      }
      case 'request-room-state': {
        if (!this._isHost || !this._room) break;
        this._room.state = msg.state;
        this._strategy.updateRoomOccupancy?.(this._room.id, this._room.playerCount, this._room.state);
        this._broadcastControlMessage({ type: 'room-updated', room: this._room });
        break;
      }
      case 'request-max-players': {
        if (!this._isHost || !this._room) break;
        this._room.maxPlayers = msg.maxPlayers;
        this._broadcastControlMessage({ type: 'room-updated', room: this._room });
        break;
      }
      case 'request-lock': {
        if (!this._isHost || !this._room) break;
        (this._room as any).locked = true;
        this._broadcastControlMessage({ type: 'room-updated', room: this._room });
        break;
      }
      case 'request-unlock': {
        if (!this._isHost || !this._room) break;
        (this._room as any).locked = false;
        this._broadcastControlMessage({ type: 'room-updated', room: this._room });
        break;
      }
      case 'request-transfer-host': {
        if (!this._isHost) break;
        this._hostId = msg.peerId;
        this._isHost = false;
        this._broadcastControlMessage({ type: 'host-changed', newHostId: msg.peerId });
        break;
      }
    }
  }

  private _sendControlMessage(msg: RoomControlMessage): void {
    if (this._isHost && msg.type.startsWith('request-')) {
      // Host processes locally and broadcasts result
      this._handleControlMessage(msg, this._peerId);
      return;
    }
    // Non-host: send to host
    if (this._hostId && this._hostId !== this._peerId) {
      this._sendOnChannel(ROOM_CONTROL_CHANNEL, msg, this._hostId);
    }
  }

  private _broadcastControlMessage(msg: RoomControlMessage): void {
    this._sendOnChannel(ROOM_CONTROL_CHANNEL, msg);
    // Handle locally too so host updates its own state
    this._handleControlMessage(msg, this._peerId);
  }

  // ── Private: Host election ──

  /**
   * Host-election rank for a peer: lower wins. Reads `metadata.hostPriority`
   * (advertised via player metadata / signaling presence, so every peer sees
   * the same value). Peers that don't advertise a priority rank last, which
   * preserves the legacy lowest-peerId election among them.
   */
  private _hostRank(peerId: string): number {
    const meta = this._playerMap.get(peerId)?.metadata as Record<string, unknown> | undefined;
    const priority = meta?.hostPriority;
    return typeof priority === 'number' && Number.isFinite(priority)
      ? priority
      : Number.POSITIVE_INFINITY;
  }

  private _electAndSetHost(): void {
    const allIds = [this._peerId, ...this._peerSet];
    const newHostId = electHost(allIds, (id) => this._hostRank(id));
    const changed = newHostId !== this._hostId;
    this._hostId = newHostId;
    this._isHost = newHostId === this._peerId;

    for (const [id, p] of this._playerMap) {
      p.isHost = id === newHostId;
    }
    if (this._room) {
      this._room.hostId = newHostId;
      this._room.playerCount = this._playerMap.size;
      // Keep the lobby announcement's occupancy fresh (no-op on non-announcers)
      this._strategy.updateRoomOccupancy?.(this._room.id, this._room.playerCount, this._room.state);
    }

    if (changed) {
      for (const cb of this._callbacks.onHostChanged) cb(newHostId);
    }
  }

  // ── Private: WebRTC peer management ──

  /** Grace timers for transient ICE 'disconnected' states */
  private _disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Re-offer timers for pairs still establishing (STUN-only reliability) */
  private _connectRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Re-offer attempt counts, keyed by peerId */
  private _connectAttempts = new Map<string, number>();
  /** Sends queued while a data channel is not yet open: key = peerId channel */
  private _pendingSends = new Map<string, (string | ArrayBuffer | Uint8Array)[]>();

  private _connectToPeer(peerId: string): PeerConnection {
    const existing = this._peers.get(peerId);
    if (existing) return existing;

    const peer = new PeerConnection(peerId, this._iceConfig, {
      onStateChange: (state) => {
        if (state === 'connected') {
          // ICE recovered — cancel any pending transient-disconnect teardown
          const timer = this._disconnectTimers.get(peerId);
          if (timer) {
            clearTimeout(timer);
            this._disconnectTimers.delete(peerId);
          }
          // Pair established — stop the establishment re-offer loop.
          this._clearConnectRetry(peerId);
        }
        if (state === 'connected' && this._isHost && this._room) {
          // Send full state sync to the new peer
          const syncMsg: RoomControlMessage = {
            type: 'sync-state',
            room: this._room,
            players: Array.from(this._playerMap.values()),
          };
          setTimeout(() => {
            this._sendOnChannel(ROOM_CONTROL_CHANNEL, syncMsg, peerId);
          }, 100);
        }
        if (state === 'failed' || state === 'disconnected') {
          this._handleConnectionDrop(peerId, state);
        }
      },
      onDataChannel: (channel) => {
        this._setupDataChannelReceiver(channel, peerId);
      },
      onIceCandidate: (candidate) => {
        this._strategy.signal(peerId, { type: 'ice-candidate', candidate: candidate.toJSON() });
      },
    });

    this._peers.set(peerId, peer);
    this._peerSet.add(peerId);

    // Deterministic initiator: lower peerId creates the offer
    if (this._peerId < peerId) {
      for (const [name, state] of this._channels) {
        this._createDataChannelOnPeer(peer, name, state.options);
      }
      peer.createOffer().then((offer) => {
        this._strategy.signal(peerId, { type: 'offer', sdp: offer });
      }).catch(() => { /* the connect-retry loop will re-attempt */ });
      // STUN-only reliability net: re-offer (with ICE restart) if this pair
      // doesn't reach 'connected' — recovers a lost offer/answer/candidate or
      // a slow STUN gather without waiting for an ICE 'failed' that never comes
      // for a handshake that never started.
      this._armConnectRetry(peerId);
    }

    return peer;
  }

  /**
   * Schedule the initiator's establishment re-offers. Only the deterministic
   * initiator (lower peerId) drives this, mirroring initial-offer ownership.
   * Each tick: if the peer still isn't 'connected', re-create and re-send the
   * offer with `iceRestart` (a full offer, so it also recovers a lost initial
   * offer) and reschedule, up to CONNECT_RETRY_MAX_ATTEMPTS. The drop handler
   * owns 'failed'/'disconnected' recovery, so back off while it is active.
   */
  private _armConnectRetry(peerId: string): void {
    if (this._peerId >= peerId) return; // only the initiator re-offers
    if (this._connectRetryTimers.has(peerId)) return;

    const tick = (): void => {
      this._connectRetryTimers.delete(peerId);
      const peer = this._peers.get(peerId);
      if (!peer || peer.state === 'connected') {
        this._connectAttempts.delete(peerId);
        return;
      }
      // Let the failed/disconnected self-heal own recovery while it runs.
      if (this._disconnectTimers.has(peerId)) {
        this._connectRetryTimers.set(peerId, setTimeout(tick, CONNECT_RETRY_DELAY_MS));
        return;
      }
      const attempts = (this._connectAttempts.get(peerId) ?? 0) + 1;
      if (attempts > CONNECT_RETRY_MAX_ATTEMPTS) {
        this._connectAttempts.delete(peerId);
        return; // give up: pair is unreachable on STUN (no TURN to relay)
      }
      this._connectAttempts.set(peerId, attempts);

      peer.createOffer({ iceRestart: true })
        .then((offer) => {
          // Bail if the peer was replaced/removed or connected mid-create.
          if (this._peers.get(peerId) === peer && peer.state !== 'connected') {
            this._strategy.signal(peerId, { type: 'offer', sdp: offer });
          }
        })
        .catch(() => { /* next tick retries */ });

      this._connectRetryTimers.set(peerId, setTimeout(tick, CONNECT_RETRY_DELAY_MS));
    };

    this._connectRetryTimers.set(peerId, setTimeout(tick, CONNECT_RETRY_DELAY_MS));
  }

  private _clearConnectRetry(peerId: string): void {
    const timer = this._connectRetryTimers.get(peerId);
    if (timer) { clearTimeout(timer); this._connectRetryTimers.delete(peerId); }
    this._connectAttempts.delete(peerId);
  }

  private async _handleSignal(peerId: string, data: unknown): Promise<void> {
    try {
      const signal = data as {
        type: string;
        sdp?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit;
      };

      let peer = this._peers.get(peerId);

      if (signal.type === 'offer') {
        if (!peer) peer = this._connectToPeer(peerId);
        const answer = await peer.handleOffer(signal.sdp!);
        this._strategy.signal(peerId, { type: 'answer', sdp: answer });
      } else if (signal.type === 'answer') {
        // An answer only arrives in response to an offer we already sent, so the
        // peer must exist. A stray answer with no peer is meaningless — ignore.
        if (peer) await peer.handleAnswer(signal.sdp!);
      } else if (signal.type === 'ice-candidate') {
        // Create the peer if a candidate arrives before discovery/offer so it is
        // buffered (PeerConnection) instead of dropped. The buffer flushes once
        // the remote description is set.
        if (!peer) peer = this._connectToPeer(peerId);
        await peer.addIceCandidate(signal.candidate!);
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.error('[CarverJS] Signal handling failed:', err);
      }
    }
  }

  // ── Private: Data channel helpers ──

  private _createDataChannelOnPeer(peer: PeerConnection, name: string, options: ChannelOptions): void {
    const channel = peer.createDataChannel(name, options);
    this._setupDataChannelReceiver(channel, peer.peerId);
  }

  private _setupDataChannelReceiver(dataChannel: RTCDataChannel, peerId: string): void {
    const channelName = dataChannel.label;
    dataChannel.onmessage = (event) => {
      if (!this._checkRateLimit(peerId)) return;
      const channelState = this._channels.get(channelName);
      if (!channelState) return;
      try {
        const data =
          typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        for (const receiver of channelState.receivers) receiver(data, peerId);
      } catch {
        // Ignore malformed messages
      }
    };
    // Flush any sends that were queued before this channel was usable
    dataChannel.onopen = () => this._flushPendingSends(peerId, channelName);
    if (dataChannel.readyState === 'open') this._flushPendingSends(peerId, channelName);
  }

  private _sendOnChannel<T>(channelName: string, data: T, target?: string | string[]): void {
    const serialized =
      typeof data === 'object' &&
      data !== null &&
      !(data instanceof ArrayBuffer) &&
      !(data instanceof Uint8Array)
        ? JSON.stringify(data)
        : data;

    const targets = target
      ? Array.isArray(target) ? target : [target]
      : Array.from(this._peers.keys());

    for (const pid of targets) {
      const peer = this._peers.get(pid);
      if (!peer) continue;
      const ch = peer.getDataChannel(channelName);
      if (ch?.readyState === 'open') {
        try { ch.send(serialized as string); } catch { /* closed between check and send */ }
      } else {
        // Channel not open yet (the answering side waits for ondatachannel).
        // Queue instead of silently dropping — flushed on channel open.
        const key = pid + ' ' + channelName;
        const q = this._pendingSends.get(key) ?? [];
        if (q.length < 200) q.push(serialized as string | ArrayBuffer | Uint8Array);
        this._pendingSends.set(key, q);
      }
    }
  }

  private _flushPendingSends(peerId: string, channelName: string): void {
    const key = peerId + ' ' + channelName;
    const q = this._pendingSends.get(key);
    if (!q || q.length === 0) return;
    const ch = this._peers.get(peerId)?.getDataChannel(channelName);
    if (ch?.readyState !== 'open') return;
    this._pendingSends.delete(key);
    for (const msg of q) {
      try { ch.send(msg as string); } catch { break; }
    }
  }

  /**
   * Signaling presence reports a peer left. This is NOT authoritative for an
   * established session: a transient signaling (Firebase/MQTT) disconnect can
   * remove a peer's presence while the direct WebRTC link is perfectly healthy.
   * Keep the peer if its connection is still 'connected'; genuine departures
   * are also surfaced by the WebRTC connection-state machine
   * (failed/disconnected -> _handleConnectionDrop), which tears the peer down.
   */
  private _onStrategyPeerLeft(peerId: string): void {
    const peer = this._peers.get(peerId);
    if (peer && peer.state === 'connected') return;
    this._teardownPeer(peerId);
  }

  /**
   * Self-heal a dropped P2P link instead of tearing it down immediately. ICE
   * 'disconnected' is frequently transient and 'failed' can often recover via
   * an ICE restart. The deterministic initiator (lower peerId) renegotiates by
   * sending a fresh offer with iceRestart; the answerer replies through the
   * existing _handleSignal('offer') path. A grace timer is the fallback: tear
   * the peer down only if it doesn't return to 'connected'. Recovery to
   * 'connected' cancels the timer (see onStateChange in _connectToPeer).
   */
  private _handleConnectionDrop(peerId: string, state: 'failed' | 'disconnected'): void {
    if (this._disconnectTimers.has(peerId)) return; // already self-healing

    // Initiator drives the ICE restart, mirroring initial-offer ownership.
    if (this._peerId < peerId) {
      const peer = this._peers.get(peerId);
      peer?.createOffer({ iceRestart: true })
        .then((offer) => {
          // Bail if the peer was replaced/removed while creating the offer.
          if (this._peers.get(peerId) === peer) {
            this._strategy.signal(peerId, { type: 'offer', sdp: offer });
          }
        })
        .catch(() => { /* restart failed; grace timer tears it down */ });
    }

    const graceMs = state === 'failed' ? 8000 : 5000;
    this._disconnectTimers.set(peerId, setTimeout(() => {
      this._disconnectTimers.delete(peerId);
      const p = this._peers.get(peerId);
      if (p && p.state !== 'connected') this._teardownPeer(peerId);
    }, graceMs));
  }

  private _teardownPeer(peerId: string): void {
    this._removePeer(peerId);
    this._playerMap.delete(peerId);
    this._electAndSetHost();
    for (const cb of this._callbacks.onPeerLeave) cb(peerId);
  }

  private _removePeer(peerId: string): void {
    const peer = this._peers.get(peerId);
    if (peer) { peer.close(); this._peers.delete(peerId); }
    this._peerSet.delete(peerId);
    this._rateLimitCounters.delete(peerId);
    const timer = this._disconnectTimers.get(peerId);
    if (timer) { clearTimeout(timer); this._disconnectTimers.delete(peerId); }
    this._clearConnectRetry(peerId);
    for (const key of [...this._pendingSends.keys()]) {
      if (key.startsWith(peerId + ' ')) this._pendingSends.delete(key);
    }
  }

  private _checkRateLimit(peerId: string): boolean {
    const now = Date.now();
    let c = this._rateLimitCounters.get(peerId);
    if (!c || now >= c.resetAt) {
      c = { count: 0, resetAt: now + this._rateLimitConfig.windowMs };
      this._rateLimitCounters.set(peerId, c);
    }
    c.count++;
    return c.count <= this._rateLimitConfig.maxMessagesPerSecond;
  }
}
