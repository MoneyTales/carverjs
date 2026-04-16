# Contributing to CarverJS

Thanks for your interest in contributing. CarverJS is in early beta and we welcome contributions of all kinds -- bug reports, feature requests, documentation improvements, and code.

## Getting Started

```bash
git clone https://github.com/het-dave/carverjs.git
cd carverjs
pnpm install
pnpm build
```

### Run examples locally

```bash
# 2D example
pnpm --filter @carverjs/example-basic-2d dev

# 3D example
pnpm --filter @carverjs/example-basic-3d dev

# Multiplayer example (requires Firebase RTDB -- see examples/multiplayer-2d/.env.example)
pnpm --filter @carverjs/example-multiplayer-2d dev
```

## Development Workflow

1. Fork the repo and create a branch from `main`.
2. `pnpm install` at the root.
3. Make your changes in `packages/core/` or `packages/multiplayer/`.
4. Run `pnpm build` to verify everything compiles.
5. Test your changes against the examples.
6. Open a pull request with a clear description.

## Project Structure

```
packages/
  core/          # @carverjs/core -- game engine components, hooks, systems
  multiplayer/   # @carverjs/multiplayer -- P2P networking (WebRTC + signaling strategies)
examples/
  basic-2d/      # Minimal 2D demo
  basic-3d/      # Minimal 3D demo
  multiplayer-2d/# Coin Chase -- multiplayer demo with Firebase signaling
```

## Code Style

- TypeScript strict mode, no `any` types (except for third-party interop).
- Prefer explicit types over inference for public APIs.
- No default exports in library code.
- Keep files under 400 lines. Split large files into focused modules.

## Commit Messages

Use conventional commits:

```
feat(core): add usePhysics hook
fix(multiplayer): ICE candidate buffering race condition
docs: update getting started guide
```

## What We Need Help With

- Bug reports with reproduction steps
- Performance profiling and optimization
- Additional signaling strategies (Nostr, Supabase, etc.)
- More example games
- Documentation improvements
- Test coverage

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
