import { forwardRef, useEffect, useRef } from "react";
import {
  OrthographicCamera,
  PerspectiveCamera,
  OrbitControls,
  MapControls,
  PointerLockControls,
} from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { Vector3 } from "three";
import { useCamera } from "../hooks/useCamera";
import type {
  PerspectiveCamera as ThreePerspectiveCamera,
  OrthographicCamera as ThreeOrthographicCamera,
} from "three";
import type {
  CameraType,
  CameraControlsType,
  CameraFollowConfig,
  PerspectiveCameraProps,
  OrthographicCameraProps,
  OrbitControlsProps,
  MapControlsProps,
  PointerLockControlsProps,
  UseCameraReturn,
} from "../types";

// ── Internal: updates OrbitControls target to follow a moving object ──
function OrbitFollow({ follow }: { follow: CameraFollowConfig }) {
  const controlsRef = useRef<any>(null);
  const _targetPos = useRef(new Vector3());

  useFrame(() => {
    if (!controlsRef.current || !follow.target?.current) return;
    const obj = follow.target.current;
    const lookAtOffset = follow.lookAtOffset ?? [0, 0, 0];

    obj.getWorldPosition(_targetPos.current);
    _targetPos.current.x += lookAtOffset[0];
    _targetPos.current.y += lookAtOffset[1];
    _targetPos.current.z += lookAtOffset[2];

    // Smoothly move the orbit target toward the followed object
    const smoothing = follow.smoothing ?? 0.1;
    controlsRef.current.target.lerp(_targetPos.current, smoothing);
    controlsRef.current.update();
  });

  return <OrbitControls ref={controlsRef} enableZoom />;
}

export interface CameraProps {
  /** Camera projection type. Default: "perspective" */
  type?: CameraType;
  /** Controls mode. Default: "none" */
  controls?: CameraControlsType;
  /** Follow configuration. Omit for a static camera. */
  follow?: CameraFollowConfig;
  /** Props passed through to the drei PerspectiveCamera (when type="perspective") */
  perspectiveProps?: PerspectiveCameraProps;
  /** Props passed through to the drei OrthographicCamera (when type="orthographic") */
  orthographicProps?: OrthographicCameraProps;
  /** Props passed through to OrbitControls (when controls="orbit") */
  orbitControlsProps?: OrbitControlsProps;
  /** Props passed through to MapControls (when controls="map") */
  mapControlsProps?: MapControlsProps;
  /** Props passed through to PointerLockControls (when controls="pointerlock") */
  pointerLockControlsProps?: PointerLockControlsProps;
  /** Callback receiving the imperative camera API (shake, moveTo, lookAt) */
  onReady?: (api: UseCameraReturn) => void;
}

export const Camera = forwardRef<
  ThreePerspectiveCamera | ThreeOrthographicCamera,
  CameraProps
>(
  (
    {
      type = "perspective",
      controls = "none",
      follow,
      perspectiveProps,
      orthographicProps,
      orbitControlsProps,
      mapControlsProps,
      pointerLockControlsProps,
      onReady,
    },
    ref
  ) => {
    // When orbit + follow are both active, OrbitFollow handles following
    // via the controls target instead of useCamera's direct camera manipulation.
    const useOrbitFollow = controls === "orbit" && !!follow;
    const api = useCamera({ follow: useOrbitFollow ? undefined : follow });

    useEffect(() => {
      onReady?.(api);
    }, [onReady, api]);

    return (
      <>
        {/* ── Camera ── */}
        {type === "perspective" ? (
          <PerspectiveCamera
            ref={ref as React.Ref<ThreePerspectiveCamera>}
            makeDefault
            position={[0, 5, 10]}
            fov={75}
            near={0.1}
            far={1000}
            {...perspectiveProps}
          />
        ) : (
          <OrthographicCamera
            ref={ref as React.Ref<ThreeOrthographicCamera>}
            makeDefault
            position={[0, 0, 100]}
            zoom={50}
            near={0.1}
            far={1000}
            {...orthographicProps}
          />
        )}

        {/* ── Controls ── */}
        {controls === "orbit" && (
          useOrbitFollow
            ? <OrbitFollow follow={follow!} />
            : <OrbitControls enableZoom {...orbitControlsProps} />
        )}
        {controls === "map" && (
          <MapControls enableZoom {...mapControlsProps} />
        )}
        {controls === "pointerlock" && (
          <PointerLockControls {...pointerLockControlsProps} />
        )}
      </>
    );
  }
);

Camera.displayName = "Camera";
