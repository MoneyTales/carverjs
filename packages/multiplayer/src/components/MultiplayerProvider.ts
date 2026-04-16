import { createElement, useRef, useEffect } from "react";
import type { ReactNode } from "react";
import type { StrategyConfig } from "../transport/strategy/types";
import { MqttStrategy } from "../transport/strategy/mqtt";
import { FirebaseStrategy } from "../transport/strategy/firebase";
import { NetworkManager } from "../core/NetworkManager";
import { MultiplayerContext } from "../core/MultiplayerContext";
import type { MultiplayerContextValue } from "../core/MultiplayerContext";
import type { SignalingStrategy } from "../transport/strategy/types";

export interface MultiplayerProviderProps {
  /**
   * Unique application identifier. Used to namespace rooms across the
   * signaling network so different games don't interfere.
   */
  appId: string;
  /**
   * Signaling strategy configuration. Defaults to MQTT (free public brokers).
   *
   * ```tsx
   * // Free (MQTT, zero config)
   * <MultiplayerProvider appId="my-game">
   *
   * // Firebase (your own project)
   * <MultiplayerProvider
   *   appId="my-game"
   *   strategy={{ type: 'firebase', databaseURL: 'https://my-project.firebaseio.com' }}
   * >
   * ```
   */
  strategy?: StrategyConfig;
  /**
   * ICE servers (STUN + TURN). Defaults to public Google/Cloudflare STUN.
   *
   * To add your own TURN server (e.g. Cloudflare TURN):
   * ```tsx
   * <MultiplayerProvider
   *   appId="my-game"
   *   iceServers={[
   *     { urls: 'stun:stun.cloudflare.com:3478' },
   *     { urls: 'turn:turn.cloudflare.com:3478', username: '...', credential: '...' },
   *   ]}
   * >
   * ```
   */
  iceServers?: RTCIceServer[];
  children: ReactNode;
}

function createStrategy(appId: string, config?: StrategyConfig): SignalingStrategy {
  if (!config || config.type === 'mqtt') {
    return new MqttStrategy(appId, config ?? { type: 'mqtt' });
  }
  if (config.type === 'firebase') {
    return new FirebaseStrategy(appId, config);
  }
  throw new Error(`Unknown strategy type: ${(config as any).type}`);
}

export function MultiplayerProvider({
  appId,
  strategy: strategyConfig,
  iceServers,
  children,
}: MultiplayerProviderProps) {
  const managerRef = useRef<NetworkManager | null>(null);
  const strategyRef = useRef<SignalingStrategy | null>(null);

  if (!managerRef.current) {
    managerRef.current = new NetworkManager();
  }
  if (!strategyRef.current) {
    strategyRef.current = createStrategy(appId, strategyConfig);
  }

  useEffect(() => {
    return () => {
      strategyRef.current?.destroy();
      strategyRef.current = null;
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, []);

  const value: MultiplayerContextValue = {
    appId,
    strategy: strategyRef.current,
    iceServers,
    networkManager: managerRef.current,
  };

  return createElement(MultiplayerContext.Provider, { value }, children);
}
