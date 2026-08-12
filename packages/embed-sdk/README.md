# @carverjs/embed-sdk

[![npm](https://img.shields.io/npm/v/@carverjs/embed-sdk)](https://www.npmjs.com/package/@carverjs/embed-sdk)
[![license](https://img.shields.io/npm/l/@carverjs/embed-sdk)](https://github.com/MoneyTales/carverjs/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5ymwfD4hYE)

Talk to the CarverJS marketplace shell from inside your game. Dependency-free, ~1 KB.

Games on the marketplace run inside a sandboxed `<iframe>` on their own origin. The shell (the play page) listens for a small set of typed `postMessage` signals — this SDK sends them so you never hand-roll `postMessage` shapes, and it stays in lockstep with the shell's validator.

> **Stable:** `@carverjs/embed-sdk` 1.0 is released. It is versioned independently of the engine and follows [semantic versioning](https://semver.org/) — breaking changes ship only in a new major version.

## Install

```bash
npm install @carverjs/embed-sdk
```

## Usage

```ts
import { carver } from "@carverjs/embed-sdk";

carver.progress(40);                    // loading bar in the shell (0–100)
carver.ready();                         // hides the shell loader — call on first frame
carver.score(1280, "points");           // feeds player-profile stats
carver.event("level-complete", { level: 3 });
carver.requestFullscreen();             // call from a click / keypress handler
carver.error("asset-load-failed", "texture atlas 404");
carver.exit();                          // game over; hand control back to the shell

// prove which signed-in player this is, to YOUR OWN backend
const id = await carver.getIdentity();
if (id.ok) saveToMyBackend(id.token, id.userId);

// future shell -> game hints (pause / resume, etc.)
const unsubscribe = carver.subscribe((msg) => {
  if (msg.type === "carver:pause") {
    /* pause your loop */
  }
});
```

Every call is a **safe no-op** outside an iframe (for example when you open your build locally) and in non-browser environments (SSR, tests) — nothing here ever throws, so you can leave the calls in during development.

## API

| Method | When to call it |
| --- | --- |
| `ready()` | First frame rendered. Required — the shell loader waits for it. |
| `progress(percent)` | Loading progress, clamped to 0–100. |
| `error(code, message)` | Fatal error — the shell shows an error card. |
| `event(name, payload?)` | Gameplay events for stat aggregation. |
| `score(value, label?)` | Score reporting (finite numbers only). |
| `requestFullscreen()` | Ask the shell to go fullscreen (needs a user gesture). |
| `exit()` | Game finished. |
| `getIdentity()` | `Promise` — a signed token proving which signed-in player this is, for your own backend. See below. |
| `subscribe(handler)` | Shell to game messages; returns an unsubscribe function. |
| `configure({ targetOrigin?, parentOrigin? })` | Optional origin pinning. |
| `isEmbedded()` | `true` when running inside the marketplace shell. |

## Player identity (`getIdentity`)

If your game keeps player data on **your own backend**, `getIdentity()`
lets that backend know which marketplace user it's talking to — without
the game ever handling a marketplace credential.

```ts
const id = await carver.getIdentity();
if (id.ok) {
  // id.token     — short-lived signed JWT (RS256)
  // id.userId    — stable, opaque id for THIS player in THIS game
  // id.expiresAt — Unix epoch (ms)
  await fetch("https://my-game-backend.com/save", {
    method: "POST",
    headers: { Authorization: `Bearer ${id.token}` },
    body: JSON.stringify({ progress: 12 }),
  });
} else if (id.reason === "signin-required") {
  // the player isn't signed in to the marketplace — prompt them
}
```

It always resolves (never throws). On failure you get
`{ ok: false, reason }` where `reason` is one of `"signin-required"`,
`"not-embedded"`, `"timeout"`, `"rate-limited"`, or `"error"`.

**Verify the token on your server** — never trust it in the browser.
It's a standard RS256 JWT; verify it against the marketplace JWKS and
check the claims:

```ts
// any backend / language with a JWT library — example uses `jose`
import { jwtVerify, createRemoteJWKSet } from "jose";

const JWKS = createRemoteJWKSet(
  new URL("https://www.carverjs.dev/.well-known/jwks.json"),
);

const { payload } = await jwtVerify(token, JWKS, {
  issuer: "https://www.carverjs.dev",
  audience: "<your-game-id>", // also present as payload.gameId
});
// payload.sub === id.userId — your stable key for this player
```

`userId` (the token's `sub`) is **per-game**: the same person gets a
different id in a different game, so it can't be used to track players
across the marketplace. It requires a **real signed-in account** —
anonymous play sessions resolve `signin-required`.

## Security

Outbound messages are posted with `targetOrigin: "*"` by default. They intentionally carry **no secrets** — only `ready` / `score` / `progress`-style signals — and a sandboxed game cannot know which shell origin embeds it (production, staging, or a local preview). Inbound messages are only delivered when their `source` is the direct parent window. If your game ships to exactly one shell, pin it:

```ts
carver.configure({ targetOrigin: "https://carverjs.dev" });
```

## Links

- Documentation: [docs.carverjs.dev](https://docs.carverjs.dev)
- Community: [Discord](https://discord.gg/5ymwfD4hYE)
- Issues: [github.com/MoneyTales/carverjs/issues](https://github.com/MoneyTales/carverjs/issues)

## License

[MIT](https://github.com/MoneyTales/carverjs/blob/main/LICENSE) — MoneyTales EduTech Private Limited
