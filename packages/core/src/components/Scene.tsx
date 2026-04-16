import { useEffect, useRef } from "react";
import { useSceneStore } from "../store/sceneStore";
import type { SceneConfig } from "../types";

export interface SceneProps<TData = unknown> extends SceneConfig<TData> {}

/**
 * Declarative scene registration.
 *
 * Registers a SceneConfig into the scene store on mount and unregisters on unmount.
 * Does NOT render scene content — that's handled by <SceneManager>.
 *
 * Usage:
 *   <Scene name="menu" component={MenuScene} />
 *   <Scene name="gameplay" loader={() => import("./GameplayScene")} persistent />
 */
export function Scene<TData = unknown>(props: SceneProps<TData>): null {
  const { name, component, loader, transition, persistent } = props;

  // Use ref to avoid re-registration on re-renders.
  // Config is registered once on mount. To change config, remount via key prop.
  const configRef = useRef<SceneConfig<TData>>({
    name,
    component,
    loader,
    transition,
    persistent,
  });

  useEffect(() => {
    useSceneStore
      .getState()
      ._registerScene(configRef.current as SceneConfig);

    return () => {
      useSceneStore.getState()._unregisterScene(configRef.current.name);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
