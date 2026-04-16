# CarverJS [BETA]

A declarative React game engine built on [Three.js](https://threejs.org/) and [React Three Fiber](https://docs.pmnd.rs/react-three-fiber). Build 2D and 3D multiplayer games with simple, composable React components.

> **Beta:** CarverJS is under active development. APIs may change between minor versions until 1.0.

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| `@carverjs/core` | Game engine -- components, hooks, systems, store | [![npm](https://img.shields.io/npm/v/@carverjs/core)](https://www.npmjs.com/package/@carverjs/core) |
| `@carverjs/multiplayer` | P2P multiplayer -- WebRTC, signaling strategies, sync | [![npm](https://img.shields.io/npm/v/@carverjs/multiplayer)](https://www.npmjs.com/package/@carverjs/multiplayer) |

## Features

**Core Engine**
- Hybrid 2D/3D -- switch camera modes with a single prop
- `<Game>`, `<World>`, `<Actor>`, `<Camera>` -- declarative scene graph
- `useGameLoop`, `useInput`, `useCollision`, `useCamera`, `useAnimation` -- game hooks
- Asset loader with preloading and loading screens
- Scene management, tweening, particle system
- TypeScript-first with full type safety

**Multiplayer**
- Peer-to-peer via WebRTC data channels -- no game server required
- Serverless signaling via MQTT (free) or Firebase RTDB (bring your own)
- Configurable STUN/TURN servers (Cloudflare TURN, or any provider)
- Three sync modes: events, snapshots with delta compression, client prediction with rollback
- Host authority model with automatic host migration
- Interest management, interpolation, and network simulation tools

## Community

[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5ymwfD4hYE)

Ask questions, share what you build, and follow development on **[Discord](https://discord.gg/5ymwfD4hYE)**.

## Documentation

Full API reference, guides, and examples at **[docs.carverjs.dev](https://docs.carverjs.dev)**.

## Quick Start

```bash
npm install @carverjs/core
# or
pnpm add @carverjs/core
```

### Minimal 2D Game

```tsx
import { Game, World, Actor } from "@carverjs/core/components";
import { useGameLoop, useInput } from "@carverjs/core/hooks";

function Player() {
  const ref = useRef(null);
  const { getAxis } = useInput();

  useGameLoop((dt) => {
    if (!ref.current) return;
    ref.current.position.x += getAxis("KeyA", "KeyD") * 5 * dt;
    ref.current.position.y += getAxis("KeyS", "KeyW") * 5 * dt;
  });

  return (
    <Actor ref={ref} type="primitive" shape="circle" color="royalblue"
      geometryArgs={[0.5, 24]} />
  );
}

export default function App() {
  return (
    <Game mode="2d">
      <World>
        <Player />
      </World>
    </Game>
  );
}
```

### Adding Multiplayer

```bash
npm install @carverjs/multiplayer
# Firebase signaling (optional -- MQTT is free and zero-config)
npm install firebase
```

```tsx
import { MultiplayerProvider, useRoom, usePlayers } from "@carverjs/multiplayer";

function App() {
  return (
    // Zero-config: uses free public MQTT brokers for signaling
    <MultiplayerProvider appId="my-game">
      <Game mode="2d">
        <World>
          <GameScene />
        </World>
      </Game>
    </MultiplayerProvider>
  );
}
```

#### Signaling Strategies

```tsx
// Free (MQTT, zero config, default)
<MultiplayerProvider appId="my-game">

// Firebase Realtime Database (bring your own project)
<MultiplayerProvider
  appId="my-game"
  strategy={{ type: 'firebase', databaseURL: 'https://your-project.firebaseio.com' }}
>

// With TURN server for NAT traversal (optional)
<MultiplayerProvider
  appId="my-game"
  iceServers={[
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:turn.cloudflare.com:3478', username: '...', credential: '...' },
  ]}
>
```

## Project Structure

```
carverjs/
  packages/
    core/             @carverjs/core -- game engine
    multiplayer/      @carverjs/multiplayer -- P2P networking
  examples/
    basic-2d/         Minimal 2D demo
    basic-3d/         Minimal 3D demo
    multiplayer-2d/   Coin Chase -- multiplayer game (Firebase + Cloudflare TURN)
```

## Examples

### Running Examples Locally

```bash
git clone https://github.com/moneytales/carverjs.git
cd carverjs
pnpm install
pnpm build
```

```bash
# 2D example
pnpm --filter @carverjs/example-basic-2d dev

# 3D example
pnpm --filter @carverjs/example-basic-3d dev
```

### Multiplayer Example (Coin Chase)

The multiplayer example uses Firebase Realtime Database for signaling and optionally Cloudflare TURN for NAT traversal.

```bash
# 1. Copy the example env file
cp examples/multiplayer-2d/.env.example examples/multiplayer-2d/.env

# 2. Add your Firebase RTDB URL (see setup below)
# 3. Optionally add Cloudflare TURN credentials

# 4. Run
pnpm --filter @carverjs/example-multiplayer-2d dev
```

**Firebase RTDB Setup:**
1. Go to [Firebase Console](https://console.firebase.google.com) and create a project
2. Enable Realtime Database (start in test mode)
3. Copy the database URL into your `.env` as `VITE_FIREBASE_RTDB_URL`

**Cloudflare TURN Setup (optional):**
1. Cloudflare Dashboard > Calls > TURN Keys > Create
2. Copy the Token ID and API Token into your `.env`

TURN is only needed when peers can't connect directly (restrictive NAT/firewall). For same-network testing, STUN alone is sufficient.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Monorepo | [Turborepo](https://turbo.build/) + [pnpm](https://pnpm.io/) |
| Core | TypeScript + [tsup](https://tsup.egoist.dev/) |
| 3D | [Three.js](https://threejs.org/) via [React Three Fiber](https://docs.pmnd.rs/react-three-fiber) |
| Multiplayer | WebRTC + [MQTT](https://mqtt.org/) / [Firebase RTDB](https://firebase.google.com/docs/database) |
| Examples | [Vite](https://vite.dev/) + React |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) -- MoneyTales EduTech Private Limited
