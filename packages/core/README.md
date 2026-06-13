# @carverjs/core

[![npm](https://img.shields.io/npm/v/@carverjs/core)](https://www.npmjs.com/package/@carverjs/core)
[![license](https://img.shields.io/npm/l/@carverjs/core)](https://github.com/MoneyTales/carverjs/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5ymwfD4hYE)

The CarverJS game engine — build declarative 2D and 3D games as composable React components, on top of [Three.js](https://threejs.org/) and [React Three Fiber](https://docs.pmnd.rs/react-three-fiber).

> **Beta:** CarverJS is under active development. APIs may change between minor versions until 1.0.

## Install

```bash
npm install @carverjs/core
# peer dependencies (most React + Three projects already have these)
npm install react react-dom three @react-three/fiber @react-three/drei zustand
# optional — rigid-body physics (usePhysics, powered by Rapier)
npm install @react-three/rapier
```

## Quick start

A complete 2D game — a circle you move with WASD:

```tsx
import { useRef } from "react";
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

Switch to 3D by changing a single prop: `<Game mode="3d">`.

## Entry points

`@carverjs/core` ships as focused subpath exports, so you import only what you use:

| Import | Contents |
| --- | --- |
| `@carverjs/core/components` | `<Game>`, `<World>`, `<Actor>`, `<Camera>`, `<Scene>`, `<SceneManager>`, `<AssetLoader>`, `<LoadingScreen>`, `<ParticleEmitter>`, `<AudioListener>` |
| `@carverjs/core/hooks` | game loop, input, collision, physics, camera, animation, audio, assets, particles, tweening |
| `@carverjs/core/systems` | engine systems — actor registry, asset / audio / collision managers, easing |
| `@carverjs/core/store` | Zustand stores (`gameStore`, `sceneStore`) |
| `@carverjs/core/types` | shared TypeScript types |

## Components

| Component | Purpose |
| --- | --- |
| `<Game>` | Root canvas. Set `mode` to `2d` or `3d`; configure lighting, sky, DPR, and shadows. |
| `<World>` | Scene-graph container for your actors. |
| `<Actor>` | A game object — `primitive`, `sprite`, or `model`. Forwards a ref to its `Object3D`. |
| `<Camera>` | Perspective or orthographic camera with optional follow controls. |
| `<Scene>` / `<SceneManager>` | Multi-scene apps and transitions. |
| `<AssetLoader>` / `<LoadingScreen>` | Preload models, textures, and audio behind a loading screen. |
| `<ParticleEmitter>` | Particle effects. |
| `<AudioListener>` | Spatial audio listener. |

## Hooks

| Hook | Purpose |
| --- | --- |
| `useGameLoop(cb)` | Fixed / variable-step update loop with delta time. |
| `useInput()` | Keyboard and pointer state, axes, and action maps. |
| `useCollision()` / `useGridCollision()` | AABB / sphere / circle and grid collision. |
| `usePhysics()` | Rigid-body physics (requires the optional `@react-three/rapier` peer). |
| `useCamera()` / `useCameraDirection()` | Camera control and facing. |
| `useAnimation()` | Skeletal and clip animation playback. |
| `useAudio()` | Sound effects and music with channels and audio sprites. |
| `useAssets()` / `useAssetProgress()` | Access loaded assets and load progress. |
| `useParticles()` | Imperative particle bursts. |
| `useTween()` | Value tweening with easing. |
| `useScene()` | Scene navigation. |
| `useActorRegistry()` | Look up live actors by id. |

## Add multiplayer

Make any CarverJS game networked with [`@carverjs/multiplayer`](https://www.npmjs.com/package/@carverjs/multiplayer) — serverless peer-to-peer over WebRTC, with no game server to run.

## Links

- Documentation: [docs.carverjs.dev](https://docs.carverjs.dev)
- Community: [Discord](https://discord.gg/5ymwfD4hYE)
- Issues: [github.com/MoneyTales/carverjs/issues](https://github.com/MoneyTales/carverjs/issues)

## License

[MIT](https://github.com/MoneyTales/carverjs/blob/main/LICENSE) — MoneyTales EduTech Private Limited
