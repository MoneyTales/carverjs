import type {
  SignalingStrategy,
  PeerMetadata,
  RoomAnnouncement,
  MqttStrategyConfig,
} from "./types";
import {
  generatePeerId,
  mqttTopics,
  removeFromArray,
  DEFAULT_MQTT_BROKERS,
  ROOM_ANNOUNCE_EXPIRY_MS,
  ROOM_ANNOUNCE_INTERVAL_MS,
  PRESENCE_HEARTBEAT_MS,
  PEER_EXPIRY_MS,
  PRESENCE_WARMUP_DELAYS_MS,
} from "./utils";

// mqtt.MqttClient type (avoid hard import at module level)
type MqttClient = {
  on(event: string, cb: (...args: any[]) => void): void;
  subscribe(topic: string | string[], opts: Record<string, unknown>, cb?: (err: Error | null) => void): void;
  unsubscribe(topic: string | string[]): void;
  publish(topic: string, payload: string | Buffer, opts?: Record<string, unknown>): void;
  end(force?: boolean): void;
};

/**
 * MQTT-based signaling strategy.
 *
 * Connects to public MQTT brokers over WebSocket. Peer discovery uses
 * retained presence messages with periodic heartbeats. SDP/ICE relay
 * uses per-peer signal topics. Room discovery uses retained lobby topics.
 *
 * Zero infrastructure cost -- uses free public brokers by default.
 */
export class MqttStrategy implements SignalingStrategy {
  readonly selfId: string;

  private _appId: string;
  private _config: MqttStrategyConfig;
  private _client: MqttClient | null = null;
  private _roomId: string | null = null;
  private _peerMeta: PeerMetadata = {};
  /** Monotonic counter to detect stale leaveRoom completions */
  private _joinGeneration = 0;

  // Lazy init
  private _initPromise: Promise<void> | null = null;

  // Callbacks
  private _onPeerDiscovered: ((peerId: string, meta: PeerMetadata) => void)[] = [];
  private _onPeerLeft: ((peerId: string) => void)[] = [];
  private _onSignal: ((fromPeerId: string, data: unknown) => void)[] = [];
  private _onLobby: ((rooms: RoomAnnouncement[]) => void)[] = [];

  // State
  private _knownPeers = new Map<string, { meta: PeerMetadata; lastSeen: number }>();
  private _lobbyRooms = new Map<string, RoomAnnouncement>();
  private _presenceTimer: ReturnType<typeof setInterval> | null = null;
  private _warmupTimers: ReturnType<typeof setTimeout>[] = [];
  private _lobbyAnnounceTimer: ReturnType<typeof setInterval> | null = null;
  private _peerExpiryTimer: ReturnType<typeof setInterval> | null = null;
  private _lobbySubscribed = false;
  private _destroyed = false;

  constructor(appId: string, config: MqttStrategyConfig = { type: 'mqtt' }) {
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
    if (!this._client) throw new Error('MQTT client not available');

    this._joinGeneration++;
    this._roomId = roomId;
    this._peerMeta = peerMeta;

    const topics = mqttTopics(this._appId, roomId, this.selfId);

    // Subscribe to room presence (discover peers) and own signal inbox
    await new Promise<void>((resolve, reject) => {
      this._client!.subscribe(
        [topics.roomPresenceWildcard, topics.peerSignalInbox],
        { qos: 1 },
        (err: Error | null) => (err ? reject(err) : resolve()),
      );
    });

    // Publish retained presence
    this._publishPresence();

    // Rapid warmup announces for fast peer discovery
    for (const delay of PRESENCE_WARMUP_DELAYS_MS) {
      this._warmupTimers.push(setTimeout(() => this._publishPresence(), delay));
    }

    // Periodic heartbeat
    this._presenceTimer = setInterval(() => this._publishPresence(), PRESENCE_HEARTBEAT_MS);

    // Periodic peer expiry check
    this._peerExpiryTimer = setInterval(() => this._checkPeerExpiry(), PRESENCE_HEARTBEAT_MS);
  }

  async leaveRoom(): Promise<void> {
    if (!this._client || !this._roomId) return;

    const generation = this._joinGeneration;
    const topics = mqttTopics(this._appId, this._roomId, this.selfId);
    this._clearRoomTimers();

    // Clear retained presence
    this._client.publish(topics.peerPresence, '', { retain: true, qos: 1 });

    // Unsubscribe from room topics
    this._client.unsubscribe([topics.roomPresenceWildcard, topics.peerSignalInbox]);

    this._knownPeers.clear();

    // Only null out _roomId if no new joinRoom() has run since we started.
    if (this._joinGeneration === generation) {
      this._roomId = null;
    }
  }

  signal(targetPeerId: string, data: unknown): void {
    if (!this._client || !this._roomId) return;
    const targetTopic = `carver/${this._appId}/room/${this._roomId}/signal/${targetPeerId}`;
    this._client.publish(
      targetTopic,
      JSON.stringify({ from: this.selfId, data, ts: Date.now() }),
      { qos: 1 },
    );
  }

  subscribeToLobby(cb: (rooms: RoomAnnouncement[]) => void): () => void {
    this._onLobby.push(cb);

    // Subscribe to lobby topic (lazy -- waits for init)
    if (!this._lobbySubscribed) {
      this._lobbySubscribed = true;
      this._ensureInit().then(() => {
        if (this._client && !this._destroyed) {
          const lobbyTopic = mqttTopics(this._appId, '', '').lobbyWildcard;
          this._client.subscribe(lobbyTopic, { qos: 0 });
        }
      });
    }

    return () => {
      removeFromArray(this._onLobby, cb);
    };
  }

  announceRoom(announcement: RoomAnnouncement): void {
    if (!this._client) return;
    const topic = mqttTopics(this._appId, announcement.roomId, '').roomLobbyEntry;

    announcement.lastSeen = Date.now();
    this._client.publish(topic, JSON.stringify(announcement), { retain: true, qos: 1 });

    // Periodic heartbeat
    if (this._lobbyAnnounceTimer) clearInterval(this._lobbyAnnounceTimer);
    this._lobbyAnnounceTimer = setInterval(() => {
      announcement.lastSeen = Date.now();
      this._client?.publish(topic, JSON.stringify(announcement), { retain: true, qos: 1 });
    }, ROOM_ANNOUNCE_INTERVAL_MS);
  }

  removeRoomAnnouncement(roomId: string): void {
    if (!this._client) return;
    const topic = mqttTopics(this._appId, roomId, '').roomLobbyEntry;
    this._client.publish(topic, '', { retain: true, qos: 1 });
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
    this._clearRoomTimers();

    // Clean up retained presence
    if (this._client && this._roomId) {
      const topics = mqttTopics(this._appId, this._roomId, this.selfId);
      this._client.publish(topics.peerPresence, '', { retain: true, qos: 1 });
    }

    this._client?.end(true);
    this._client = null;
    this._knownPeers.clear();
    this._lobbyRooms.clear();
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
    const mqtt = await import('mqtt');
    const brokers = this._config.brokerUrls ?? DEFAULT_MQTT_BROKERS;
    // Pick a random broker from the available pool
    const brokerUrl = brokers[Math.floor(Math.random() * brokers.length)];

    return new Promise<void>((resolve, reject) => {
      const connectFn = mqtt.default?.connect ?? mqtt.connect;
      this._client = connectFn(brokerUrl, {
        clientId: `carver_${this.selfId}`,
        clean: true,
        connectTimeout: 10_000,
        keepalive: 30,
      }) as MqttClient;

      this._client.on('connect', () => {
        if (!this._destroyed) resolve();
      });

      this._client.on('error', (err: Error) => {
        if (!this._initPromise) return; // already resolved
        reject(err);
      });

      this._client.on('message', (topic: string, payload: Buffer) => {
        this._handleMessage(topic, payload);
      });
    });
  }

  private _publishPresence(): void {
    if (!this._client || !this._roomId) return;
    const topics = mqttTopics(this._appId, this._roomId, this.selfId);
    this._client.publish(
      topics.peerPresence,
      JSON.stringify({ peerId: this.selfId, meta: this._peerMeta, ts: Date.now() }),
      { retain: true, qos: 1 },
    );
  }

  private _handleMessage(topic: string, payload: Buffer): void {
    const raw = payload.toString();

    // ── Presence message ──
    const presenceMatch = topic.match(/\/room\/[^/]+\/presence\/([^/]+)$/);
    if (presenceMatch) {
      const peerId = presenceMatch[1];
      if (peerId === this.selfId) return;

      if (!raw) {
        // Empty retained = peer left
        if (this._knownPeers.has(peerId)) {
          this._knownPeers.delete(peerId);
          for (const cb of this._onPeerLeft) cb(peerId);
        }
        return;
      }
      try {
        const msg = JSON.parse(raw);
        const isNew = !this._knownPeers.has(peerId);
        this._knownPeers.set(peerId, { meta: msg.meta ?? {}, lastSeen: msg.ts ?? Date.now() });
        if (isNew) {
          for (const cb of this._onPeerDiscovered) cb(peerId, msg.meta ?? {});
        }
      } catch { /* ignore malformed */ }
      return;
    }

    // ── Signal message (SDP / ICE) ──
    const signalMatch = topic.match(/\/room\/[^/]+\/signal\/([^/]+)$/);
    if (signalMatch) {
      try {
        const msg = JSON.parse(raw);
        if (msg.from && msg.from !== this.selfId) {
          for (const cb of this._onSignal) cb(msg.from, msg.data);
        }
      } catch { /* ignore malformed */ }
      return;
    }

    // ── Lobby announcement ──
    const lobbyMatch = topic.match(/\/lobby\/([^/]+)$/);
    if (lobbyMatch) {
      const roomId = lobbyMatch[1];
      if (!raw) {
        this._lobbyRooms.delete(roomId);
      } else {
        try {
          const ann = JSON.parse(raw) as RoomAnnouncement;
          if (Date.now() - ann.lastSeen < ROOM_ANNOUNCE_EXPIRY_MS) {
            this._lobbyRooms.set(roomId, ann);
          } else {
            this._lobbyRooms.delete(roomId);
          }
        } catch { /* ignore */ }
      }
      const rooms = Array.from(this._lobbyRooms.values());
      for (const cb of this._onLobby) cb(rooms);
    }
  }

  private _checkPeerExpiry(): void {
    const now = Date.now();
    for (const [peerId, data] of this._knownPeers) {
      if (now - data.lastSeen > PEER_EXPIRY_MS) {
        this._knownPeers.delete(peerId);
        for (const cb of this._onPeerLeft) cb(peerId);
      }
    }
  }

  private _clearRoomTimers(): void {
    if (this._presenceTimer) { clearInterval(this._presenceTimer); this._presenceTimer = null; }
    for (const t of this._warmupTimers) clearTimeout(t);
    this._warmupTimers = [];
    if (this._lobbyAnnounceTimer) { clearInterval(this._lobbyAnnounceTimer); this._lobbyAnnounceTimer = null; }
    if (this._peerExpiryTimer) { clearInterval(this._peerExpiryTimer); this._peerExpiryTimer = null; }
  }
}
