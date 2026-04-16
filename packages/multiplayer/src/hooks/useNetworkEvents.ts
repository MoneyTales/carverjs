import { useRef, useEffect, useCallback } from "react";
import { useMultiplayerContext } from "../core/MultiplayerContext";
import { EventSync } from "../sync/EventSync";

export interface UseNetworkEventsReturn<T extends { [K in keyof T]: unknown } = Record<string, unknown>> {
  sendEvent: <K extends keyof T & string>(type: K, payload: T[K], target?: string) => void;
  broadcast: <K extends keyof T & string>(type: K, payload: T[K]) => void;
  onEvent: <K extends keyof T & string>(type: K, callback: (data: T[K], peerId: string) => void) => () => void;
}

/**
 * Layer 1: Typed event-based messaging between peers.
 * Uses a single reliable+ordered channel.
 *
 * @example
 * ```tsx
 * interface MyEvents {
 *   'chat': { message: string };
 *   'turn-end': { playerId: string; action: string };
 * }
 *
 * const { sendEvent, broadcast, onEvent } = useNetworkEvents<MyEvents>();
 *
 * broadcast('chat', { message: 'hello' });
 * onEvent('chat', (data, peerId) => console.log(data.message));
 * ```
 */
interface PendingListener {
  type: string;
  callback: (payload: unknown, peerId: string) => void;
  unsub: (() => void) | null;
}

export function useNetworkEvents<
  T extends { [K in keyof T]: unknown } = Record<string, unknown>
>(options?: { hostValidation?: boolean }): UseNetworkEventsReturn<T> {
  const { networkManager } = useMultiplayerContext();
  const eventSyncRef = useRef<EventSync | null>(null);
  const pendingRef = useRef<PendingListener[]>([]);
  const drainedUnsubsRef = useRef<(() => void)[]>([]);

  // Initialize EventSync when transport is available
  useEffect(() => {
    const transport = networkManager.transport;
    if (!transport) return;

    const eventSync = new EventSync(transport, {
      hostValidation: options?.hostValidation,
    });
    eventSyncRef.current = eventSync;

    // Drain pending listener queue
    const unsubs: (() => void)[] = [];
    for (const entry of pendingRef.current) {
      const unsub = eventSync.onEvent(entry.type, entry.callback);
      entry.unsub = unsub;
      unsubs.push(unsub);
    }
    pendingRef.current = [];
    drainedUnsubsRef.current = unsubs;

    return () => {
      // Clean up any drained listeners that are still active
      for (const unsub of drainedUnsubsRef.current) {
        unsub();
      }
      drainedUnsubsRef.current = [];
      eventSync.destroy();
      eventSyncRef.current = null;
    };
  }, [networkManager.transport, options?.hostValidation]);

  const sendEvent = useCallback(<K extends keyof T & string>(
    type: K,
    payload: T[K],
    target?: string,
  ) => {
    eventSyncRef.current?.sendEvent(type, payload, target);
  }, []);

  const broadcast = useCallback(<K extends keyof T & string>(
    type: K,
    payload: T[K],
  ) => {
    eventSyncRef.current?.broadcast(type, payload);
  }, []);

  const onEvent = useCallback(<K extends keyof T & string>(
    type: K,
    callback: (data: T[K], peerId: string) => void,
  ): (() => void) => {
    const castCallback = callback as (payload: unknown, peerId: string) => void;

    if (eventSyncRef.current) {
      return eventSyncRef.current.onEvent(type, castCallback);
    }

    // Buffer the listener until EventSync initializes
    const entry: PendingListener = { type, callback: castCallback, unsub: null };
    pendingRef.current.push(entry);

    return () => {
      if (entry.unsub) {
        // Already drained and registered with EventSync -- unsubscribe normally
        entry.unsub();
        drainedUnsubsRef.current = drainedUnsubsRef.current.filter((u) => u !== entry.unsub);
      } else {
        // Still pending -- remove from queue
        pendingRef.current = pendingRef.current.filter((e) => e !== entry);
      }
    };
  }, []);

  return { sendEvent, broadcast, onEvent };
}
