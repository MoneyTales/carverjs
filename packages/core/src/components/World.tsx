import { Children, isValidElement } from "react";
import {
  OrthographicCamera,
  PerspectiveCamera,
  OrbitControls,
} from "@react-three/drei";
import { Camera } from "./Camera";
import { useGameContext } from "./GameContext";
import { PhysicsGate } from "../systems/PhysicsProvider";
import type {
  CameraProps2D,
  CameraProps3D,
  OrbitControlsProps,
  WorldPhysicsConfig,
} from "../types";

export interface WorldProps {
  /** Overrides for the default OrthographicCamera (2D mode, no custom Camera) */
  cameraProps2D?: CameraProps2D;
  /** Overrides for the default PerspectiveCamera (3D mode, no custom Camera) */
  cameraProps3D?: CameraProps3D;
  /** Overrides for the default OrbitControls (3D mode, no custom Camera) */
  orbitControlsProps?: OrbitControlsProps;
  /** Enable Rapier physics. Requires @react-three/rapier to be installed. */
  physics?: WorldPhysicsConfig;
  /** Whether this world is active. Inactive worlds are hidden and skip rendering. Default: true */
  active?: boolean;
  children?: React.ReactNode;
}

export function World({
  cameraProps2D,
  cameraProps3D,
  orbitControlsProps,
  physics,
  active = true,
  children,
}: WorldProps) {
  const { mode } = useGameContext();
  const is2D = mode === "2d";

  const hasCustomCamera = Children.toArray(children).some(
    (child) => isValidElement(child) && child.type === Camera
  );

  return (
    <group visible={active}>
      {!hasCustomCamera &&
        (is2D ? (
          <OrthographicCamera
            makeDefault
            position={[0, 0, 100]}
            zoom={50}
            near={0.1}
            far={1000}
            {...cameraProps2D}
          />
        ) : (
          <PerspectiveCamera
            makeDefault
            position={[0, 5, 10]}
            fov={75}
            near={0.1}
            far={1000}
            {...cameraProps3D}
          />
        ))}

      {!is2D && !hasCustomCamera && (
        <OrbitControls enableZoom={true} {...orbitControlsProps} />
      )}

      <PhysicsGate config={physics} mode={mode}>
        {children}
      </PhysicsGate>
    </group>
  );
}
