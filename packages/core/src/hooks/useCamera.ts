import { useRef, useCallback } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import type { UseCameraOptions, UseCameraReturn } from "../types";

export function useCamera(options: UseCameraOptions = {}): UseCameraReturn {
  const { follow } = options;
  const { camera } = useThree();

  // Pre-allocated Vector3 instances to avoid GC pressure in the render loop
  const _targetPos = useRef(new Vector3());
  const _desiredPos = useRef(new Vector3());
  const _lookAtPos = useRef(new Vector3());

  // Shake state
  const shakeRef = useRef({ active: false, intensity: 0, remaining: 0 });

  // Transition state
  const transitionRef = useRef<{
    active: boolean;
    from: Vector3;
    to: Vector3;
    duration: number;
    elapsed: number;
  } | null>(null);

  useFrame((_, delta) => {
    // ── Follow logic ──
    if (follow?.target?.current) {
      const obj = follow.target.current;
      const offset = follow.offset ?? [0, 5, 10];
      const smoothing = follow.smoothing ?? 0.1;
      const shouldLookAt = follow.lookAt ?? true;
      const lookAtOffset = follow.lookAtOffset ?? [0, 0, 0];

      // Compute desired camera position: target world position + offset
      obj.getWorldPosition(_targetPos.current);
      _desiredPos.current.set(
        _targetPos.current.x + offset[0],
        _targetPos.current.y + offset[1],
        _targetPos.current.z + offset[2]
      );

      // Lerp camera position toward the desired position
      camera.position.lerp(_desiredPos.current, smoothing);

      // Look at target (plus optional offset)
      if (shouldLookAt) {
        _lookAtPos.current.set(
          _targetPos.current.x + lookAtOffset[0],
          _targetPos.current.y + lookAtOffset[1],
          _targetPos.current.z + lookAtOffset[2]
        );
        camera.lookAt(_lookAtPos.current);
      }
    }

    // ── Transition logic ──
    if (transitionRef.current?.active) {
      const t = transitionRef.current;
      t.elapsed += delta;
      const progress = Math.min(t.elapsed / t.duration, 1);
      // Smooth-step easing
      const eased = progress * progress * (3 - 2 * progress);
      camera.position.lerpVectors(t.from, t.to, eased);
      if (progress >= 1) {
        transitionRef.current = null;
      }
    }

    // ── Shake logic ──
    if (shakeRef.current.active) {
      shakeRef.current.remaining -= delta;
      if (shakeRef.current.remaining <= 0) {
        shakeRef.current.active = false;
      } else {
        const intensity = shakeRef.current.intensity;
        camera.position.x += (Math.random() - 0.5) * intensity;
        camera.position.y += (Math.random() - 0.5) * intensity;
      }
    }
  });

  const shake = useCallback((intensity = 0.3, duration = 0.3) => {
    shakeRef.current = { active: true, intensity, remaining: duration };
  }, []);

  const moveTo = useCallback(
    (position: [number, number, number], duration = 1) => {
      transitionRef.current = {
        active: true,
        from: camera.position.clone(),
        to: new Vector3(...position),
        duration,
        elapsed: 0,
      };
    },
    [camera]
  );

  const lookAtFn = useCallback(
    (target: [number, number, number]) => {
      camera.lookAt(new Vector3(...target));
    },
    [camera]
  );

  return { shake, moveTo, lookAt: lookAtFn };
}
