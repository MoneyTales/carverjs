import { useRef } from "react";
import {
  usePhysicsContext,
  useRigidBodyRef,
} from "../systems/PhysicsProvider";
import type { UsePhysicsReturn } from "../types";

/**
 * Provides an imperative API for controlling the Rapier rigid body
 * associated with the nearest parent Actor that has a `physics` prop.
 *
 * Returns `null` when no physics context is available (no `<World physics={...}>`)
 * or when the component is not inside a physics-enabled Actor.
 */
export function usePhysics(): UsePhysicsReturn | null {
  const ctx = usePhysicsContext();
  const rigidBodyRef = useRigidBodyRef();

  // Stable return object — delegates to the ref so it always reads live state
  const returnRef = useRef<UsePhysicsReturn | null>(null);

  if (!ctx?.available || !rigidBodyRef) {
    return null;
  }

  if (!returnRef.current) {
    returnRef.current = {
      applyImpulse: (impulse) => {
        const rb = rigidBodyRef.current;
        if (rb) rb.applyImpulse({ x: impulse[0], y: impulse[1], z: impulse[2] }, true);
      },

      applyForce: (force) => {
        const rb = rigidBodyRef.current;
        if (rb) rb.addForce({ x: force[0], y: force[1], z: force[2] }, true);
      },

      setLinearVelocity: (velocity) => {
        const rb = rigidBodyRef.current;
        if (rb) rb.setLinvel({ x: velocity[0], y: velocity[1], z: velocity[2] }, true);
      },

      getLinearVelocity: () => {
        const rb = rigidBodyRef.current;
        if (!rb) return [0, 0, 0];
        const v = rb.linvel();
        return [v.x, v.y, v.z];
      },

      setAngularVelocity: (velocity) => {
        const rb = rigidBodyRef.current;
        if (rb) rb.setAngvel({ x: velocity[0], y: velocity[1], z: velocity[2] }, true);
      },

      setTranslation: (position) => {
        const rb = rigidBodyRef.current;
        if (rb) rb.setTranslation({ x: position[0], y: position[1], z: position[2] }, true);
      },

      getTranslation: () => {
        const rb = rigidBodyRef.current;
        if (!rb) return [0, 0, 0];
        const t = rb.translation();
        return [t.x, t.y, t.z];
      },

      setRotation: (rotation) => {
        const rb = rigidBodyRef.current;
        if (rb) rb.setRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] }, true);
      },

      setEnabled: (enabled) => {
        const rb = rigidBodyRef.current;
        if (rb) rb.setEnabled(enabled);
      },

      resetForces: () => {
        const rb = rigidBodyRef.current;
        if (rb) rb.resetForces(true);
      },
    };
  }

  return returnRef.current;
}
