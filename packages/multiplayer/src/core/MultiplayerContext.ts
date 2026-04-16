import { createContext, useContext } from "react";
import type { SignalingStrategy } from "../transport/strategy/types";
import type { NetworkManager } from "./NetworkManager";

export interface MultiplayerContextValue {
  appId: string;
  strategy: SignalingStrategy;
  iceServers?: RTCIceServer[];
  networkManager: NetworkManager;
}

export const MultiplayerContext = createContext<MultiplayerContextValue | null>(null);

export function useMultiplayerContext(): MultiplayerContextValue {
  const ctx = useContext(MultiplayerContext);
  if (!ctx) {
    throw new Error("useMultiplayerContext must be used inside a <MultiplayerProvider>.");
  }
  return ctx;
}
