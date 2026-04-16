import type { CarverTransport, CarverChannel, ChannelOptions, TransportConfig, Player } from "../types";

export type { CarverTransport, CarverChannel, ChannelOptions, TransportConfig };

/** Internal callback store for a transport implementation */
export interface TransportCallbacks {
  onPeerJoin: ((peerId: string) => void)[];
  onPeerLeave: ((peerId: string) => void)[];
  onPeerUpdated: ((player: Player) => void)[];
  onHostChanged: ((newHostId: string) => void)[];
}

/** Configuration for rate limiting */
export interface RateLimitConfig {
  /** Maximum messages per second per peer. Default: 60 */
  maxMessagesPerSecond: number;
  /** Window size in ms for rate calculation. Default: 1000 */
  windowMs: number;
}

/** Peer connection state */
export type PeerState = 'connecting' | 'connected' | 'disconnected' | 'failed';
