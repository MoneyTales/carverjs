/** Default STUN servers (free, public) */
const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * Build RTCConfiguration from user-provided ICE servers.
 *
 * If the user provides `iceServers`, those are used as-is (STUN + TURN).
 * Otherwise, default public STUN servers are used.
 *
 * TURN servers should be included in the `iceServers` array by the user:
 * ```ts
 * iceServers: [
 *   { urls: 'stun:stun.cloudflare.com:3478' },
 *   { urls: 'turn:turn.cloudflare.com:3478', username: '...', credential: '...' },
 * ]
 * ```
 */
export function buildICEConfig(options?: {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
}): RTCConfiguration {
  const servers: RTCIceServer[] =
    options?.iceServers && options.iceServers.length > 0
      ? options.iceServers
      : DEFAULT_STUN_SERVERS;

  return {
    iceServers: servers,
    iceCandidatePoolSize: 10,
    iceTransportPolicy: options?.iceTransportPolicy ?? 'all',
  };
}
