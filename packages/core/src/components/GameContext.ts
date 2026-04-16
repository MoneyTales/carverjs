import { createContext, useContext } from "react";
import type { WorldMode } from "../types";

export interface GameContextValue {
  mode: WorldMode;
}

export const GameContext = createContext<GameContextValue | null>(null);

export function useGameContext(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) {
    throw new Error("useGameContext must be used inside a <Game> component.");
  }
  return ctx;
}
