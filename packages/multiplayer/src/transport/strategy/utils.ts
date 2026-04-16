/** Generate a random peer ID (20 chars, URL-safe) */
export function generatePeerId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < 20; i++) {
    id += chars[bytes[i] % chars.length];
  }
  return id;
}

/** Build MQTT topic paths for a given appId + roomId */
export function mqttTopics(appId: string, roomId: string, peerId?: string) {
  const base = `carver/${appId}`;
  return {
    /** Lobby wildcard: subscribe to discover all room announcements */
    lobbyWildcard: `${base}/lobby/+`,
    /** Single room lobby entry */
    roomLobbyEntry: `${base}/lobby/${roomId}`,
    /** Wildcard for all peer presence in a room */
    roomPresenceWildcard: `${base}/room/${roomId}/presence/+`,
    /** This peer's presence topic */
    peerPresence: peerId ? `${base}/room/${roomId}/presence/${peerId}` : '',
    /** This peer's signal inbox */
    peerSignalInbox: peerId ? `${base}/room/${roomId}/signal/${peerId}` : '',
  };
}

/** Build Firebase RTDB paths for a given appId + roomId */
export function firebasePaths(appId: string, roomId: string, peerId?: string) {
  const base = `${appId}/__carver__`;
  return {
    lobby: `${base}/lobby`,
    roomLobbyEntry: `${base}/lobby/${roomId}`,
    peers: `${base}/rooms/${roomId}/peers`,
    peerPresence: peerId ? `${base}/rooms/${roomId}/peers/${peerId}` : '',
    peerSignalInbox: peerId ? `${base}/rooms/${roomId}/signals/${peerId}` : '',
  };
}

/** Default MQTT brokers (WebSocket endpoints, free/public) */
export const DEFAULT_MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

/** Room announcement expiry time (30s without heartbeat = stale) */
export const ROOM_ANNOUNCE_EXPIRY_MS = 30_000;

/** Room announcement heartbeat interval */
export const ROOM_ANNOUNCE_INTERVAL_MS = 10_000;

/** Peer presence heartbeat interval */
export const PRESENCE_HEARTBEAT_MS = 5_000;

/** Peer expiry: 3 missed heartbeats */
export const PEER_EXPIRY_MS = PRESENCE_HEARTBEAT_MS * 3;

/** Rapid warmup announces for faster initial peer discovery */
export const PRESENCE_WARMUP_DELAYS_MS = [200, 500, 1500];

/** Remove an item from an array by reference. Returns true if found. */
export function removeFromArray<T>(arr: T[], item: T): boolean {
  const idx = arr.indexOf(item);
  if (idx >= 0) {
    arr.splice(idx, 1);
    return true;
  }
  return false;
}
