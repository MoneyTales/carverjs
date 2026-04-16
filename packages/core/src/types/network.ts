import type { Object3D } from "three";

/** Reference to a registered Actor for networking purposes */
export interface ActorRef {
  id: string;
  object3D: Object3D;
  rigidBody?: any; // RapierRigidBody - using any to avoid hard dependency
  userData: Record<string, unknown>;
}

/** Configuration for networked Actor sync behavior */
export interface NetworkedConfig {
  /** What to synchronize. Default: 'transform' */
  sync?: 'transform' | 'physics' | false;
  /** PeerId of the owning player. Undefined = host-owned */
  owner?: string;
  /** Custom properties to sync across the network */
  custom?: Record<string, unknown>;
  /** Per-property interpolation toggle. Keys match custom property names */
  interpolate?: Record<string, boolean>;
}
