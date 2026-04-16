import { createElement, useContext } from "react";
import type { ReactNode } from "react";
import { MultiplayerContext } from "../core/MultiplayerContext";

export interface MultiplayerBridgeProps {
  children: ReactNode;
}

/**
 * Bridges the MultiplayerContext from the parent React tree into an R3F Canvas.
 *
 * R3F's `<Canvas>` uses a separate React reconciler, so React contexts from the
 * parent tree are not automatically available inside the Canvas. This component
 * reads the MultiplayerContext value from the parent tree and re-provides it
 * inside the Canvas, making all CarverJS multiplayer hooks work seamlessly.
 *
 * Place `<MultiplayerBridge>` as a direct child of `<Game>`, wrapping `<World>`
 * and all scene content that uses multiplayer hooks.
 *
 * @example
 * ```tsx
 * <MultiplayerProvider appId="my-game">
 *   <Game mode="2d">
 *     <MultiplayerBridge>
 *       <World>
 *         <MyScene />
 *       </World>
 *     </MultiplayerBridge>
 *   </Game>
 * </MultiplayerProvider>
 * ```
 */
export function MultiplayerBridge({ children }: MultiplayerBridgeProps) {
  const ctx = useContext(MultiplayerContext);
  if (!ctx) return createElement("group", null, children);
  return createElement(MultiplayerContext.Provider, { value: ctx }, children);
}
