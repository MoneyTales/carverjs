import { useState, useEffect, useCallback, useRef } from "react";
import { useMultiplayerContext } from "../core/MultiplayerContext";
import type { CarverChannel, EntityState } from "../types";

// ── Message protocol ──

interface NetworkStateMessage {
  action: "spawn" | "despawn" | "request-spawn";
  id: string;
  state?: EntityState | Record<string, unknown>;
}

// ── Return type ──

export interface UseNetworkStateReturn {
  /** Host only. Create a networked entity and broadcast its existence to all peers. */
  spawn: (id: string, initialState: EntityState) => void;
  /** Host only. Remove a networked entity and broadcast removal to all peers. */
  despawn: (id: string) => void;
  /** Client sends a spawn request to the host, who validates and spawns if the id is not taken. */
  requestSpawn: (id: string, config: Record<string, unknown>) => void;
  /** Read the current state of a networked entity by id. */
  getState: (id: string) => EntityState | undefined;
  /** Write a partial update to a networked entity. Host-authoritative: only the host may call this. */
  setState: (id: string, partialState: Partial<EntityState>) => void;
  /** Reactive map of all current networked entity states. */
  entities: Map<string, EntityState>;
}

const CHANNEL_NAME = "carver:network-state";

/**
 * Phase 4.4 – Advanced escape-hatch hook for direct networked entity management.
 *
 * Provides host-authoritative spawn / despawn, client requestSpawn,
 * and direct state read / write over a reliable+ordered data channel.
 */
export function useNetworkState(): UseNetworkStateReturn {
  const { networkManager } = useMultiplayerContext();

  // Entity state map – drives reactive re-renders.
  const [entities, setEntities] = useState<Map<string, EntityState>>(
    () => new Map(),
  );

  // Keep a mutable ref mirror so callbacks always see the latest map
  // without needing to re-create the channel listener on every state change.
  const entitiesRef = useRef<Map<string, EntityState>>(entities);
  entitiesRef.current = entities;

  // Channel ref – created once and cleaned up on unmount.
  const channelRef = useRef<CarverChannel<NetworkStateMessage> | null>(null);

  // ── Helpers (internal, not exposed) ──

  /** Immutably replace the entities map so React picks up the change. */
  const replaceEntities = useCallback(
    (updater: (prev: Map<string, EntityState>) => Map<string, EntityState>) => {
      setEntities((prev) => {
        const next = updater(prev);
        entitiesRef.current = next;
        return next;
      });
    },
    [],
  );

  /** Apply a spawn locally and update React state. */
  const applySpawn = useCallback(
    (id: string, state: EntityState) => {
      replaceEntities((prev) => {
        const next = new Map(prev);
        next.set(id, state);
        return next;
      });
    },
    [replaceEntities],
  );

  /** Apply a despawn locally and update React state. */
  const applyDespawn = useCallback(
    (id: string) => {
      replaceEntities((prev) => {
        if (!prev.has(id)) return prev; // no-op
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    },
    [replaceEntities],
  );

  // ── Channel setup ──

  useEffect(() => {
    const transport = networkManager.transport;
    if (!transport) return;

    const channel = transport.createChannel<NetworkStateMessage>(CHANNEL_NAME, {
      reliable: true,
      ordered: true,
    });
    channelRef.current = channel;

    channel.onReceive((msg: NetworkStateMessage, _peerId: string) => {
      switch (msg.action) {
        // --- Spawn broadcast (sent by host to everyone) ---
        case "spawn": {
          if (msg.state) {
            applySpawn(msg.id, msg.state as EntityState);
          }
          break;
        }

        // --- Despawn broadcast (sent by host to everyone) ---
        case "despawn": {
          applyDespawn(msg.id);
          break;
        }

        // --- Request-spawn (client -> host only) ---
        case "request-spawn": {
          // Only the host processes spawn requests.
          if (!transport.isHost) break;

          // Validate: reject if id already exists.
          if (entitiesRef.current.has(msg.id)) break;

          // Build an EntityState from the config the client sent.
          // The config should at minimum contain an id. We merge defaults
          // for a 2D entity so the state is always well-formed.
          const config = (msg.state ?? {}) as Record<string, unknown>;
          const newState: EntityState = {
            id: msg.id,
            x: 0,
            y: 0,
            a: 0,
            vx: 0,
            vy: 0,
            va: 0,
            ...config,
            // Ensure id is authoritative.
            ...(config.id !== undefined ? {} : {}),
          } as EntityState;
          // Force the id to match the message id (authoritative).
          (newState as { id: string }).id = msg.id;

          // Apply locally on the host.
          applySpawn(msg.id, newState);

          // Broadcast spawn to all peers (including the requester).
          channel.send({ action: "spawn", id: msg.id, state: newState });
          break;
        }
      }
    });

    return () => {
      channel.close();
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [networkManager.transport, applySpawn, applyDespawn]);

  // ── Public API ──

  /**
   * Host only. Creates a networked entity and broadcasts a spawn event to all peers.
   */
  const spawn = useCallback(
    (id: string, initialState: EntityState) => {
      const transport = networkManager.transport;
      if (!transport) {
        console.warn("[useNetworkState] spawn called before transport is ready.");
        return;
      }
      if (!transport.isHost) {
        console.warn(
          "[useNetworkState] spawn is host-only. Use requestSpawn() from a client.",
        );
        return;
      }
      if (entitiesRef.current.has(id)) {
        console.warn(
          `[useNetworkState] entity "${id}" already exists. Ignoring spawn.`,
        );
        return;
      }

      // Ensure the id field matches.
      const state: EntityState = { ...initialState, id } as EntityState;

      // Apply locally.
      applySpawn(id, state);

      // Broadcast to all peers.
      channelRef.current?.send({ action: "spawn", id, state });
    },
    [networkManager, applySpawn],
  );

  /**
   * Host only. Removes a networked entity and broadcasts a despawn event to all peers.
   */
  const despawn = useCallback(
    (id: string) => {
      const transport = networkManager.transport;
      if (!transport) {
        console.warn("[useNetworkState] despawn called before transport is ready.");
        return;
      }
      if (!transport.isHost) {
        console.warn("[useNetworkState] despawn is host-only.");
        return;
      }
      if (!entitiesRef.current.has(id)) {
        console.warn(
          `[useNetworkState] entity "${id}" does not exist. Ignoring despawn.`,
        );
        return;
      }

      // Apply locally.
      applyDespawn(id);

      // Broadcast to all peers.
      channelRef.current?.send({ action: "despawn", id });
    },
    [networkManager, applyDespawn],
  );

  /**
   * Client sends a spawn request to the host. The host validates the request
   * (no duplicate id) and, if valid, spawns the entity and broadcasts to everyone.
   */
  const requestSpawn = useCallback(
    (id: string, config: Record<string, unknown>) => {
      const transport = networkManager.transport;
      if (!transport) {
        console.warn(
          "[useNetworkState] requestSpawn called before transport is ready.",
        );
        return;
      }

      // If we ARE the host, just handle it inline for convenience.
      if (transport.isHost) {
        if (entitiesRef.current.has(id)) {
          console.warn(
            `[useNetworkState] entity "${id}" already exists. Ignoring requestSpawn.`,
          );
          return;
        }
        const newState: EntityState = {
          id,
          x: 0,
          y: 0,
          a: 0,
          vx: 0,
          vy: 0,
          va: 0,
          ...config,
        } as EntityState;
        (newState as { id: string }).id = id;
        applySpawn(id, newState);
        channelRef.current?.send({ action: "spawn", id, state: newState });
        return;
      }

      // Send request to host.
      channelRef.current?.send(
        { action: "request-spawn", id, state: config },
        transport.hostId,
      );
    },
    [networkManager, applySpawn],
  );

  /**
   * Read the current state of a networked entity by id.
   */
  const getState = useCallback(
    (id: string): EntityState | undefined => {
      return entitiesRef.current.get(id);
    },
    [],
  );

  /**
   * Write a partial update to a networked entity's state.
   * Host-authoritative: only the host may call this.
   */
  const setState = useCallback(
    (id: string, partialState: Partial<EntityState>) => {
      const transport = networkManager.transport;
      if (!transport) {
        console.warn("[useNetworkState] setState called before transport is ready.");
        return;
      }
      if (!transport.isHost) {
        console.warn("[useNetworkState] setState is host-only.");
        return;
      }

      const existing = entitiesRef.current.get(id);
      if (!existing) {
        console.warn(
          `[useNetworkState] entity "${id}" does not exist. Cannot setState.`,
        );
        return;
      }

      const updated: EntityState = {
        ...existing,
        ...partialState,
        id, // id is immutable
      } as EntityState;

      replaceEntities((prev) => {
        const next = new Map(prev);
        next.set(id, updated);
        return next;
      });

      // Broadcast the full updated state so clients stay in sync.
      channelRef.current?.send({ action: "spawn", id, state: updated });
    },
    [networkManager, replaceEntities],
  );

  return {
    spawn,
    despawn,
    requestSpawn,
    getState,
    setState,
    entities,
  };
}
