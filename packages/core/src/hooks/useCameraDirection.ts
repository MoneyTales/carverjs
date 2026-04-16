import { useRef, useCallback } from "react";
import { useThree } from "@react-three/fiber";
import { Vector3 } from "three";

export interface UseCameraDirectionReturn {
  /** Camera's forward direction projected onto the XZ plane (normalized). */
  getForward: () => [number, number, number];
  /** Camera's right direction projected onto the XZ plane (normalized). */
  getRight: () => [number, number, number];
}

/**
 * Returns the camera's forward and right directions projected onto the
 * horizontal (XZ) plane. Useful for camera-relative movement — W moves
 * toward where the camera is looking, A/D strafe relative to that.
 */
export function useCameraDirection(): UseCameraDirectionReturn {
  const { camera } = useThree();
  const _dir = useRef(new Vector3());

  const getForward = useCallback((): [number, number, number] => {
    camera.getWorldDirection(_dir.current);
    // Project onto XZ plane
    _dir.current.y = 0;
    _dir.current.normalize();
    return [_dir.current.x, 0, _dir.current.z];
  }, [camera]);

  const getRight = useCallback((): [number, number, number] => {
    camera.getWorldDirection(_dir.current);
    // Project onto XZ plane, then rotate 90° clockwise for right
    _dir.current.y = 0;
    _dir.current.normalize();
    return [_dir.current.z, 0, -_dir.current.x];
  }, [camera]);

  return { getForward, getRight };
}
