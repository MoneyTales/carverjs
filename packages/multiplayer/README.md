# @carverjs/multiplayer

[![npm](https://img.shields.io/npm/v/@carverjs/multiplayer)](https://www.npmjs.com/package/@carverjs/multiplayer)
[![license](https://img.shields.io/npm/l/@carverjs/multiplayer)](https://github.com/MoneyTales/carverjs/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5ymwfD4hYE)

Serverless peer-to-peer multiplayer for [CarverJS](https://www.npmjs.com/package/@carverjs/core) games. A WebRTC data-channel mesh with pluggable signaling (MQTT or Firebase), lobbies, host authority, and three sync engines — **no game server required**.

> **Beta:** CarverJS is under active development. APIs may change between minor versions until 1.0.

## Install

```bash
npm install @carverjs/multiplayer
# optional — Firebase RTDB signaling (MQTT is the zero-config default)
npm install firebase
```

Peer dependencies: `@carverjs/core`, `@react-three/fiber`, `react`, `react-dom`. `firebase` is an optional peer, needed only when you choose the Firebase strategy.

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
