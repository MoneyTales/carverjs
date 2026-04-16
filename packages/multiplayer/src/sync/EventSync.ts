import type { CarverTransport, CarverChannel, EventPacket } from "../types";

/**
 * Layer 1: Event-based messaging over a reliable+ordered channel.
 * Used for turn-based games, chat, and infrequent state changes.
 */
export class EventSync {
  private _transport: CarverTransport;
  private _channel: CarverChannel<string>;
  private _handlers = new Map<string, ((payload: unknown, peerId: string) => void)[]>();
  private _hostValidation: boolean;

  constructor(transport: CarverTransport, options?: { hostValidation?: boolean }) {
    this._transport = transport;
    this._hostValidation = options?.hostValidation ?? false;

    // Create a single reliable+ordered channel for events
    this._channel = transport.createChannel<string>('carver:events', {
      reliable: true,
      ordered: true,
    });

    // Listen for incoming events
    this._channel.onReceive((rawData: string, peerId: string) => {
      try {
        const packet: EventPacket = typeof rawData === 'string' ? JSON.parse(rawData) : rawData as unknown as EventPacket;

        // If host validation is enabled and we're the host, rebroadcast
        if (this._hostValidation && this._transport.isHost && packet.sender !== this._transport.peerId) {
          // Rebroadcast to all peers (except the original sender)
          const targets = Array.from(this._transport.peers).filter(p => p !== peerId);
          if (targets.length > 0) {
            this._channel.send(JSON.stringify(packet), targets);
          }
        }

        // If host validation is enabled and we're NOT the host,
        // only accept events from host (who rebroadcasts validated events)
        if (this._hostValidation && !this._transport.isHost && peerId !== this._transport.hostId) {
          return;
        }

        // Fire handlers for this event type
        const handlers = this._handlers.get(packet.type);
        if (handlers) {
          for (const handler of handlers) {
            handler(packet.payload, packet.sender);
          }
        }
      } catch {
        // Ignore malformed events
      }
    });
  }

  /**
   * Send a typed event to a specific peer or all peers.
   */
  sendEvent(type: string, payload: unknown, target?: string): void {
    const packet: EventPacket = {
      type,
      payload,
      sender: this._transport.peerId,
      target,
    };
    const serialized = JSON.stringify(packet);

    if (this._hostValidation && !this._transport.isHost) {
      // Route through host for validation
      this._channel.send(serialized, this._transport.hostId);
    } else if (target) {
      this._channel.send(serialized, target);
    } else {
      // Broadcast to all peers
      this._channel.send(serialized);
    }
  }

  /**
   * Broadcast a typed event to all connected peers.
   */
  broadcast(type: string, payload: unknown): void {
    this.sendEvent(type, payload);
  }

  /**
   * Register a handler for a specific event type.
   * Returns an unsubscribe function.
   */
  onEvent(type: string, callback: (payload: unknown, peerId: string) => void): () => void {
    let handlers = this._handlers.get(type);
    if (!handlers) {
      handlers = [];
      this._handlers.set(type, handlers);
    }
    handlers.push(callback);

    return () => {
      const arr = this._handlers.get(type);
      if (arr) {
        const idx = arr.indexOf(callback);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) this._handlers.delete(type);
      }
    };
  }

  /**
   * Clean up the event channel.
   */
  destroy(): void {
    this._channel.close();
    this._handlers.clear();
  }
}
