import { getActorRegistry } from "../systems/ActorRegistry";
import type { ActorRef } from "../types/network";

/**
 * Returns the ActorRegistry singleton for reading registered actors.
 * Used by @carverjs/multiplayer to discover networked actors.
 */
export function useActorRegistry() {
  const registry = getActorRegistry();
  return {
    get: (id: string) => registry.get(id),
    getAll: () => registry.getAll(),
    getNetworked: () => registry.getNetworked(),
    onRegister: (cb: (id: string, ref: ActorRef) => void) => registry.onRegister(cb),
    onUnregister: (cb: (id: string) => void) => registry.onUnregister(cb),
  };
}
