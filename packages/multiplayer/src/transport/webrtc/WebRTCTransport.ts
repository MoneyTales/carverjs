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

/** Deterministic host election: lowest peerId alphabetically */
function electHost(peerIds: string[]): string {
  return [...peerIds].sort()[0];
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
        this._removePeer(peerId);
        this._playerMap.delete(peerId);
        this._electAndSetHost();
        for (const cb of this._callbacks.onPeerLeave) cb(peerId);
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

    const player: Player = {
      peerId,
      displayName: (meta.displayName as string) ?? `Player-${peerId.slice(0, 4)}`,
      isHost: false,
      isSelf: false,
      isReady: false,
      isConnected: true,
      metadata: meta as Record<string, unknown>,
      latencyMs: 0,
      joinedAt: Date.now(),
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

  private _electAndSetHost(): void {
    const allIds = [this._peerId, ...this._peerSet];
    const newHostId = electHost(allIds);
    const changed = newHostId !== this._hostId;
    this._hostId = newHostId;
    this._isHost = newHostId === this._peerId;

    for (const [id, p] of this._playerMap) {
      p.isHost = id === newHostId;
    }
    if (this._room) {
      this._room.hostId = newHostId;
      this._room.playerCount = this._playerMap.size;
    }

    if (changed) {
      for (const cb of this._callbacks.onHostChanged) cb(newHostId);
    }
  }

  // ── Private: WebRTC peer management ──

  private _connectToPeer(peerId: string): void {
    if (this._peers.has(peerId)) return;

    const peer = new PeerConnection(peerId, this._iceConfig, {
      onStateChange: (state) => {
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
          this._removePeer(peerId);
          this._playerMap.delete(peerId);
          this._electAndSetHost();
          for (const cb of this._callbacks.onPeerLeave) cb(peerId);
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
      });
    }
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
        if (!peer) {
          this._connectToPeer(peerId);
          peer = this._peers.get(peerId)!;
        }
        const answer = await peer.handleOffer(signal.sdp!);
        this._strategy.signal(peerId, { type: 'answer', sdp: answer });
      } else if (signal.type === 'answer' && peer) {
        await peer.handleAnswer(signal.sdp!);
      } else if (signal.type === 'ice-candidate' && peer) {
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
      const ch = peer?.getDataChannel(channelName);
      if (ch?.readyState === 'open') {
        try { ch.send(serialized as string); } catch { /* closed between check and send */ }
      }
    }
  }

  private _removePeer(peerId: string): void {
    const peer = this._peers.get(peerId);
    if (peer) { peer.close(); this._peers.delete(peerId); }
    this._peerSet.delete(peerId);
    this._rateLimitCounters.delete(peerId);
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
