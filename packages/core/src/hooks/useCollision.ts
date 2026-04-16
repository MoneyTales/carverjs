import { useRef, useEffect } from "react";
import { getCollisionManager } from "../systems/CollisionManager";
import type {
  UseCollisionOptions,
  UseCollisionReturn,
  CollisionCallback,
} from "../types";

let _idCounter = 0;

export function useCollision(options: UseCollisionOptions): UseCollisionReturn {
  const {
    ref,
    name = "",
    userData = {},
    collider,
    layer = 0xFFFFFFFF,
    mask = 0xFFFFFFFF,
    sensor = false,
    onCollisionEnter,
    onCollisionExit,
    onCollisionStay,
    enabled = true,
  } = options;

  // Stable unique ID for this collider instance
  const idRef = useRef<string>("");
  if (idRef.current === "") {
    idRef.current = `col_${++_idCounter}`;
  }
  const id = idRef.current;

  // Callback refs — always call the latest closure without re-registering
  const onEnterRef = useRef<CollisionCallback | undefined>(onCollisionEnter);
  const onExitRef = useRef<CollisionCallback | undefined>(onCollisionExit);
  const onStayRef = useRef<CollisionCallback | undefined>(onCollisionStay);

  useEffect(() => {
    onEnterRef.current = onCollisionEnter;
    onExitRef.current = onCollisionExit;
    onStayRef.current = onCollisionStay;
  });

  // Register/unregister with CollisionManager
  useEffect(() => {
    const mgr = getCollisionManager();
    mgr.register(id, {
      ref,
      collider,
      name,
      userData,
      layer,
      mask,
      sensor,
      onEnter: (e) => onEnterRef.current?.(e) ?? undefined,
      onExit: (e) => onExitRef.current?.(e) ?? undefined,
      onStay: (e) => onStayRef.current?.(e) ?? undefined,
      enabled,
    });

    return () => {
      mgr.unregister(id);
    };
  // Re-register when shape/layer/mask/sensor config changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, collider, name, layer, mask, sensor]);

  // Update enabled state via ref (no re-registration needed)
  useEffect(() => {
    getCollisionManager().updateEnabled(id, enabled);
  }, [id, enabled]);

  // Imperative query API
  const returnRef = useRef<UseCollisionReturn>({
    isOverlapping: (targetName: string) =>
      getCollisionManager().isOverlapping(id, targetName),
    getOverlaps: () => getCollisionManager().getOverlaps(id),
  });

  return returnRef.current;
}
