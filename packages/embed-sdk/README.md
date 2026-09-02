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
| `requestInit()` | v2 — ask the shell for runtime config. Safe to call twice. |
| `onInit(handler)` | v2 — receive `carver:init` (auto-acknowledged) and every `carver:ice` refresh; returns an unsubscribe function. |
| `telemetry(tuple)` | v2 — report one learning interaction. |
| `iceExpired()` | v2 — the current ICE credentials stopped working; ask for fresh ones. |

## Protocol v2

1.0 was outbound-only: the game talked, the shell listened. **Protocol v2**, added in 1.1.0, opens the other direction — a versioned shell to game channel that hands your game its runtime configuration at boot (a session token, a locale, a consent flag, ephemeral TURN credentials, multiplayer room details) instead of you baking any of it into the bundle. It also adds one closed outbound telemetry envelope and a second transport for native WebViews. **v2 is fully additive.** No v1 message changed shape, `subscribe()` keeps its exact 1.0.x signature, and a 1.0.x game recompiles against 1.1.0 with no edits.

```ts
const off = carver.onInit((msg) => {
  if (msg.type === "carver:init") boot(msg.payload);   // acknowledged for you
  else refreshIce(msg.payload.iceServers);             // carver:ice
});
carver.requestInit();                                  // ask; then wait

carver.telemetry({
  objectId: "task-3",
  kcCode: "NCERT.G6.FRAC.EQUIV",
  success: true,
  attempts: 2,
  hintsUsed: 1,
  latencyBucket: "lt15s",
});

carver.iceExpired();                                   // TURN stopped working
```

### Messages

The whole protocol, v1 and v2. A `yes` in the `v` column means the message is new in v2 and always carries the revision; **optional** marks the two v1 messages that started sending a `v` in 1.1.0, which an older shell simply ignores.

| Message | Direction | `v` | What it is for |
| --- | --- | --- | --- |
| `carver:ready` | game -> shell | no | First frame rendered — the shell hides its loader. |
| `carver:progress` | game -> shell | no | Load / level progress, clamped to 0–100. |
| `carver:error` | game -> shell | no | Fatal error — the shell swaps in an error card. |
| `carver:event` | game -> shell | no | Free-form play data for stat aggregation. Shell-local; see below. |
| `carver:score` | game -> shell | no | Score for player-profile stats. |
| `carver:request-fullscreen` | game -> shell | optional | Ask the shell to go fullscreen. |
| `carver:exit` | game -> shell | optional | Game finished — hand control back to the shell. |
| `carver:identity-request` | game -> shell | no | Internal to `getIdentity()` — ask for a signed player token. |
| `carver:identity-result` | shell -> game | no | Internal to `getIdentity()` — the token, or a failure reason. |
| `carver:init-request` | game -> shell | yes | Ask the shell to send (or re-send) `carver:init`. |
| `carver:init` | shell -> game | yes | Runtime config: session token, locale, consent, ICE, player, room, API base URL. |
| `carver:init-ack` | game -> shell | yes | Sent automatically by `onInit()` — proof the game took its config. |
| `carver:ice` | shell -> game | yes | Fresh ICE servers, replacing whatever `carver:init` carried. |
| `carver:ice-expired` | game -> shell | yes | The current ICE credentials stopped working. Carries no credential material, only the fact. |
| `carver:pause` | shell -> game | yes | The shell backgrounded the game — halt timers, audio and the render loop. |
| `carver:resume` | shell -> game | yes | The shell foregrounded the game again. |
| `carver:telemetry` | game -> shell | yes | One learning interaction, in the closed tuple below. |

Unknown message types are no-ops on both sides, which is what makes the matrix below work.

### Compatibility

| | old shell (v1) | **new shell (v2)** |
| --- | --- | --- |
| **old game (1.0.x)** | Unchanged. Nothing in this release touches this pair. | The shell sends `carver:init`, the game never subscribes, and nothing happens. A v2 shell must therefore **not block on `carver:init-ack`** — treat a missing ack as an old game and play it anyway. |
| **new game (1.1.0)** | The game sends `carver:init-request`, no answer ever comes, and `onInit` never fires — so fall back to your own defaults rather than waiting on config that will not arrive. The optional `v` on `carver:exit` and `carver:request-fullscreen` is one extra field that an old shell's parser ignores. | Full v2: config on request, ICE refreshes, pause / resume, telemetry. |

### Native bridge

A game also runs top-level inside a native WebView, where there is no parent frame to post to. When `window.parent === window` **and** the shell has injected `window.__carverNativeBridge` (an object with a single `postMessage(json: string)` method — the shape both WKWebView's `messageHandlers` and Android's `addJavascriptInterface` already expose), every outbound message goes through that bridge as JSON text instead. Inbound, the native shell calls `window.__carverShellDeliver(msg)`, which the SDK installs the moment anything subscribes and which accepts either the object or its JSON string.

**The message schemas are identical on both transports.** There are no bridge-specific types and no bridge-specific fields — the same `carver:init` reaches your `onInit` whichever way it travelled. An iframe always wins: if there is a parent frame, `postMessage` is the transport, bridge or no bridge. With neither, every call stays the same safe no-op it has always been.

One caveat, about *values* rather than shapes: the iframe path structured-clones, the bridge path `JSON.stringify`s. Every field of every closed message here is a JSON primitive, so those are identical either way. `carver:event.payload` is free-form and the two serializers disagree at the edges — a cycle clones but does not stringify (the bridge drops the message), a function stringifies-by-omission but does not clone (the iframe drops it), and `NaN` / `Infinity` / `undefined` survive a clone but become `null` or vanish in JSON. Keep `carver:event` payloads to plain JSON data and the transports stay indistinguishable.

### Learning telemetry

`carver:telemetry` carries a **closed** tuple — `objectId`, `kcCode`, `success`, `attempts`, `hintsUsed`, `latencyBucket`, and optionally `misconceptions` and `probeItemId`. There is deliberately no free-form field, because **the closed type is the privacy whitelist**: a game cannot attach a name, a device id, a raw timestamp or a session token to a learning event, because there is nowhere to put one. `telemetry()` **copies those eight keys out by hand** rather than forwarding your object, so the guarantee survives the case TypeScript cannot catch — excess-property checking fires only on a fresh object literal, and `carver.telemetry(someVariable)` would otherwise have shipped every extra property on it. Widening the tuple is a privacy review, not a refactor. Latency is bucketed on purpose — an exact millisecond reading is a behavioural fingerprint, a bucket is not.

`carver:telemetry` is the only message a shell may relay to a learning-telemetry endpoint. `carver:event` stays free-form for play stats and, being author-controlled and unvalidated, **must never leave the shell** — aggregate it, log it, chart it, but do not forward it.

> **Not published yet.** 1.1.0 is not on npm; `pnpm publish` is run by hand.

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

Outbound messages are posted with `targetOrigin: "*"` by default. They intentionally carry **no secrets** — only `ready` / `score` / `progress`-style signals — and a sandboxed game cannot know which shell origin embeds it (production, staging, or a local preview). Inbound messages are only delivered when their `source` is the direct parent window.

**Secrets run one way.** v2 lets them flow **shell to game** — `sessionToken`, a TURN `credential`, `room.signalingToken` — because the shell already holds them and the game needs them to reach its own backend. They must never flow **game to shell**. Every outbound message, v1 and v2, is still free of them, which is what keeps `targetOrigin: "*"` safe; `telemetry()` takes a closed struct precisely so a game cannot smuggle a token out through a free-form field.

Because the inbound channel now carries secrets, a game that ships to exactly one shell should pin **both** directions:

```ts
carver.configure({
  targetOrigin: "https://carverjs.dev",   // outbound: who may read us
  parentOrigin: "https://carverjs.dev",   // inbound: who we accept from
});
```

Without `parentOrigin` the only inbound check is `source === window.parent` — sound, since nothing but the real embedder can be that object, but it does not tell you *who* the embedder is. **For a v2 game that is not a nicety.** A published game is loadable by anyone, so anyone can iframe it, and by framing it their page *is* `window.parent`. It can then send a `carver:init` of its own and choose your signaling backend and your TURN servers. `event.origin` is set by the browser and cannot be forged, so pinning `parentOrigin` is what makes the difference between "the shell said so" and "somebody said so". If your game consumes `carver:init` at all, pin it.

## Links

- Documentation: [docs.carverjs.dev](https://docs.carverjs.dev)
- Community: [Discord](https://discord.gg/5ymwfD4hYE)
- Issues: [github.com/MoneyTales/carverjs/issues](https://github.com/MoneyTales/carverjs/issues)

## License

[MIT](https://github.com/MoneyTales/carverjs/blob/main/LICENSE) — MoneyTales EduTech Private Limited
