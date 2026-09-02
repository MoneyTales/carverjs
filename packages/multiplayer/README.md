# @carverjs/multiplayer

[![npm](https://img.shields.io/npm/v/@carverjs/multiplayer)](https://www.npmjs.com/package/@carverjs/multiplayer)
[![license](https://img.shields.io/npm/l/@carverjs/multiplayer)](https://github.com/MoneyTales/carverjs/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5ymwfD4hYE)

Serverless peer-to-peer multiplayer for [CarverJS](https://www.npmjs.com/package/@carverjs/core) games. A WebRTC data-channel mesh with pluggable signaling (MQTT or Firebase), lobbies, host authority, and three sync engines — **no game server required**.

> **Stable:** `@carverjs/multiplayer` 1.0 is released. The public API follows [semantic versioning](https://semver.org/) — breaking changes ship only in a new major version.

## Install

```bash
npm install @carverjs/multiplayer
# optional — Firebase RTDB signaling (MQTT is the zero-config default)
npm install firebase
```

Peer dependencies: `@carverjs/core`, `@react-three/fiber`, `react`, `react-dom`. `firebase` is an optional peer, needed only when you choose the Firebase strategy.

Releases are published to npm manually by the maintainer — this repo does not auto-publish.

## How it works

Signaling (MQTT or Firebase) is used only to introduce peers and relay SDP/ICE. Once the WebRTC connection is established, **all game data flows directly peer-to-peer** over data channels — the signaling backend never sees gameplay traffic. One peer acts as the authoritative host; host migrates automatically if it leaves.

## Quick start

Wrap your game in a provider, join a room, and exchange typed events:

```tsx
import {
  MultiplayerProvider, MultiplayerBridge,
  useRoom, usePlayers, useNetworkEvents,
} from "@carverjs/multiplayer";
import { Game, World } from "@carverjs/core/components";

function App() {
  return (
    // Zero-config: free public MQTT brokers handle signaling
    <MultiplayerProvider appId="my-game">
      <Game mode="2d">
        <MultiplayerBridge>
          <World>
            <Lobby />
          </World>
        </MultiplayerBridge>
      </Game>
    </MultiplayerProvider>
  );
}

function Lobby() {
  const room = useRoom("room-code-1234", { displayName: "Ada" });
  const { players, self } = usePlayers();
  const { broadcast, onEvent } = useNetworkEvents();

  // room.connectionState, room.isHost, room.selfId, room.leave(), ...
  return <span>{players.length} players · {room.isHost ? "host" : "client"}</span>;
}
```

`MultiplayerBridge` connects the engine's render loop to the network layer; place it inside `<Game>` and around the scene that uses sync hooks.

## Signaling strategies

```tsx
// Free, zero-config (default): public MQTT brokers
<MultiplayerProvider appId="my-game">

// Firebase Realtime Database (bring your own project)
<MultiplayerProvider
  appId="my-game"
  strategy={{ type: "firebase", databaseURL: "https://your-project.firebaseio.com" }}
>
```

## Authenticated signaling (Firebase)

Auth is entirely optional and additive. With no `authTokenProvider` there is no token fetch and no sign-in, and `firebase/auth` is never imported — so the anonymous bundle does not grow and existing code needs no change.

```tsx
<MultiplayerProvider
  appId="my-game"
  strategy={{
    type: "firebase",
    databaseURL: "https://your-project.firebaseio.com",
    apiKey: "AIza...", // public project identifier, not a secret
    authTokenProvider: async () => {
      // fetch a fresh custom token from your own backend on every call
      const res = await fetch("/api/rtdb-token");
      const { token } = await res.json();
      return token;
    },
    onAuthError: (error) => {
      console.error("signaling auth failed", error);
      // treat as fatal for the current room — rejoin to recover
    },
  }}
>
```

Never hardcode a token or embed a service account in the browser — always fetch from your backend.

`apiKey` is a public project identifier, not a secret — it ships in every Firebase web bundle, and access control is the job of your security rules, not the key. It's still required whenever `authTokenProvider` is set and you don't supply your own `firebaseApp` (Auth cannot sign in on an app initialized with `databaseURL` alone), and it must arrive through config, never hardcoded in game source.

**Claims contract.** Your backend mints a Firebase Auth custom token with `uid` set to an opaque per-player-session id (no PII) and custom claims `{ roomId, ns }` — both required. Your security rules bind reads and writes to those two claims; any other claims (e.g. a role) are informational and ignored by the rules. Custom tokens expire in 1 hour by SDK design — the strategy calls `authTokenProvider` again when it needs to re-auth, so your provider must return a new token on every call, not a cached one. Note that the *session* does not expire with the token: `signInWithCustomToken` exchanges it for a refresh token that the SDK renews indefinitely with the same claims. If access must end when the game session does, revoke it server-side (Admin SDK `revokeRefreshTokens(uid)`) or mint a time-bound claim your rules check — your security rules cannot see this on their own.

**Failure and recovery.** On init, the strategy retries `authTokenProvider` + sign-in up to 4 times total (250ms, 1s, 4s backoff) before giving up and calling `onAuthError`. Once connected, a `permission_denied` on the presence re-arm, or a cancelled RTDB listener, triggers exactly one re-auth cycle for that connection. A cancelled listener is *not* automatically re-subscribed — `onAuthError` is your app's signal to rejoin the room.

The strategy also watches its own presence node and rewrites it if it vanishes. Any backend whose rules grant write access at room scope lets one player delete another's presence entry, which would otherwise evict that player from everyone's peer list with no error and no reconnect to recover from.

**Security rules.** The strategy writes under `${appId}/__carver__/...` (a slash-containing `appId` simply nests further). Bind each room's subtree to `auth.token.roomId` and `auth.token.ns` from the custom token claims above. This README keeps the rule shape generic — write the actual ruleset alongside your own backend, not in this package.

## STUN / TURN

Defaults to public STUN. Add a TURN relay so peers behind restrictive NATs or firewalls can still connect:

```tsx
<MultiplayerProvider
  appId="my-game"
  iceServers={[
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "turn:turn.cloudflare.com:3478", username: "...", credential: "..." },
  ]}
>
```

TURN is only used when a direct connection fails. For same-network testing, STUN alone is enough.

## Connection reliability

The WebRTC mesh self-heals while peers are connecting — no configuration required. Each link has a single deterministic initiator (the peer with the lower id); if a pair hasn't reached `connected` shortly after the first offer, the initiator automatically re-sends it with an ICE restart, a few times over roughly 20 seconds, until the link comes up. This transparently recovers the transient failures of serverless signaling:

- an offer, answer, or ICE candidate dropped in transit;
- ICE candidates that arrive before the peer is ready (buffered, not discarded);
- slow STUN candidate gathering on a cold network.

Every pair in the mesh establishes independently and recovers on its own, so a hiccup on one link no longer leaves two players unable to see each other — the rest of the room is unaffected and the stalled pair re-handshakes itself. This makes **STUN-only** deployments reliable in practice. A TURN relay is still required only for pairs that genuinely can't traverse each other's NAT (e.g. two symmetric/CGNAT endpoints) — STUN cannot relay those no matter how many times the handshake retries.

## Sync modes

`useMultiplayer({ mode })` selects how world state is replicated:

| Mode | Use it for | How |
| --- | --- | --- |
| `events` | turn-based, sandbox, chat, infrequent state changes | typed messages over a reliable, ordered channel |
| `snapshot` | real-time movement | host broadcasts delta-compressed snapshots; clients interpolate |
| `prediction` | fast-paced action | client-side prediction with server reconciliation and rollback |

```tsx
import { useMultiplayer } from "@carverjs/multiplayer";

function Scene() {
  useMultiplayer({ mode: "snapshot", tickRate: 60 });
  // ... actors marked networked are replicated automatically
}
```

## Hooks

| Hook | Purpose |
| --- | --- |
| `useRoom(roomId, opts)` | Join / leave a room; exposes connection state, host, and self id. |
| `useLobby()` | Browse advertised rooms. |
| `usePlayers()` | Live player list plus `self`. |
| `useHost()` | Host-only room controls — room state, lock, kick, host transfer. |
| `useMultiplayer({ mode })` | Drive the sync engine for a scene. |
| `useNetworkEvents()` | Typed `broadcast` / `sendEvent` / `onEvent` messaging. |
| `useNetworkState()` | Networked spawn / despawn helpers. |

## Host authority & migration

Exactly one peer is the authoritative host. If it disconnects, the engine migrates host to another peer automatically, and host election is deterministic and consistent across all peers.

To pin a specific peer as host — for example the room creator that owns the world — advertise a host priority in player metadata. The lowest priority wins; peers that advertise none rank last (preserving the default lowest-peer-id election among them):

```tsx
useRoom(roomId, {
  displayName: name,
  playerMetadata: { hostPriority: isCreator ? 0 : 1 },
});
```

## Advanced exports

For lower-level control, the package also exports:

- `MqttStrategy`, `FirebaseStrategy` — construct or inject a signaling strategy directly.
- `NetworkSimulator` — inject artificial latency and packet loss during development.
- `InterestManager` — area-of-interest filtering for large worlds.
- `InputBuffer`, `computeJustPressed` — input history and edge detection for prediction.
- `DebugOverlay` — on-screen network stats.

## Links

- Documentation: [docs.carverjs.dev](https://docs.carverjs.dev)
- Community: [Discord](https://discord.gg/5ymwfD4hYE)
- Issues: [github.com/MoneyTales/carverjs/issues](https://github.com/MoneyTales/carverjs/issues)

## License

[MIT](https://github.com/MoneyTales/carverjs/blob/main/LICENSE) — MoneyTales EduTech Private Limited
