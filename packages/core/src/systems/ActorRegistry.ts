import type { ActorRef } from "../types/network";

type RegistryCallback = (id: string, ref: ActorRef) => void;
type UnregistryCallback = (id: string) => void;

class ActorRegistry {
  private _entries = new Map<string, ActorRef>();
  private _onRegisterCallbacks: RegistryCallback[] = [];
  private _onUnregisterCallbacks: UnregistryCallback[] = [];

  register(id: string, ref: ActorRef): void {
    this._entries.set(id, ref);
    for (const cb of this._onRegisterCallbacks) cb(id, ref);
  }

  unregister(id: string): void {
    this._entries.delete(id);
    for (const cb of this._onUnregisterCallbacks) cb(id);
  }

  get(id: string): ActorRef | undefined {
    return this._entries.get(id);
  }

  getAll(): Map<string, ActorRef> {
    return this._entries;
  }

  getNetworked(): Map<string, ActorRef> {
    const result = new Map<string, ActorRef>();
    for (const [id, ref] of this._entries) {
      if (ref.userData.networked) {
        result.set(id, ref);
      }
    }
    return result;
  }

  onRegister(cb: RegistryCallback): () => void {
    this._onRegisterCallbacks.push(cb);
    return () => {
      const idx = this._onRegisterCallbacks.indexOf(cb);
      if (idx >= 0) this._onRegisterCallbacks.splice(idx, 1);
    };
  }

  onUnregister(cb: UnregistryCallback): () => void {
    this._onUnregisterCallbacks.push(cb);
    return () => {
      const idx = this._onUnregisterCallbacks.indexOf(cb);
      if (idx >= 0) this._onUnregisterCallbacks.splice(idx, 1);
    };
  }
}

// Singleton accessor
let _instance: ActorRegistry | null = null;

export function getActorRegistry(): ActorRegistry {
  if (!_instance) _instance = new ActorRegistry();
  return _instance;
}

export function destroyActorRegistry(): void {
  _instance = null;
}
