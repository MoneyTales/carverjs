# @carverjs/embed-sdk

talk to the carverjs marketplace shell from inside your game. no deps, ~1kb.

games on carverjs run in a sandboxed iframe on their own origin. the shell
(play page) listens for a small set of typed postMessage signals — this sdk
sends them so you never write `postMessage` by hand.

## install

```bash
npm i @carverjs/embed-sdk
```

## use

```ts
import { carver } from "@carverjs/embed-sdk";

carver.progress(40);                    // loading bar in the shell
carver.ready();                         // hides the shell loader — call on first frame
carver.score(1280, "points");           // feeds player profile stats
carver.event("level-complete", { level: 3 });
carver.requestFullscreen();             // call from a click/keypress handler
carver.error("asset-load-failed", "texture atlas 404");
carver.exit();                          // game over screen done, hand back to shell

// future shell -> game hints (pause/resume etc.)
const unsubscribe = carver.subscribe((msg) => {
  if (msg.type === "carver:pause") {
    /* pause your loop */
  }
});
```

every call is a safe no-op outside an iframe (e.g. opening your build
locally), so you can leave the calls in during development.

## api

| method | when |
| --- | --- |
| `ready()` | first frame rendered. required — the shell loader waits for it |
| `progress(percent)` | loading progress, 0–100 |
| `error(code, message)` | fatal error — shell shows an error card |
| `event(name, payload?)` | gameplay events for stats |
| `score(value, label?)` | score reporting (finite numbers only) |
| `requestFullscreen()` | ask the shell to go fullscreen (needs a user gesture) |
| `exit()` | game finished |
| `subscribe(handler)` | shell → game messages; returns unsubscribe |
| `configure({ targetOrigin?, parentOrigin? })` | optional origin pinning |
| `isEmbedded()` | true when running inside the marketplace |
