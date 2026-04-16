// Components
export { MultiplayerProvider } from "./components/MultiplayerProvider";
export type { MultiplayerProviderProps } from "./components/MultiplayerProvider";
export { MultiplayerBridge } from "./components/MultiplayerBridge";

// Hooks
export { useRoom } from "./hooks/useRoom";
export { useLobby } from "./hooks/useLobby";
export { usePlayers } from "./hooks/usePlayers";
export { useHost } from "./hooks/useHost";
export { useMultiplayer } from "./hooks/useMultiplayer";
export { useNetworkEvents } from "./hooks/useNetworkEvents";
export { useNetworkState } from "./hooks/useNetworkState";

// Strategy (for advanced users who want direct access)
export { MqttStrategy, FirebaseStrategy } from "./transport/strategy";

// Core utilities (advanced)
export { DebugOverlay } from "./core/DebugOverlay";
export type { DebugStats, DebugOverlayOptions } from "./core/DebugOverlay";
export { NetworkSimulator } from "./core/NetworkSimulator";
export type { NetworkSimulatorOptions } from "./core/NetworkSimulator";
export { InterestManager } from "./core/InterestManager";
export type { InterestManagerOptions } from "./core/InterestManager";

// Re-export types
export type * from "./types";
