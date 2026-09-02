/**
 * @carverjs/embed-sdk
 *
 * Tiny, dependency-free SDK for games embedded in the CarverJS
 * marketplace. Games run inside a sandboxed <iframe> on a per-game
 * origin (`https://g-{gameId}.carverjs.dev`) and talk to the parent
 * shell exclusively through `window.parent.postMessage`. This SDK
 * wraps that channel so game code never hand-rolls message shapes.
 *
 * Shell-side counterpart: `src/lib/games/embed-protocol.ts` in
 * carverjs-web. The shell validates `event.origin` against the exact
 * per-game origin and strictly validates every message shape — a
 * malformed message is silently dropped, never an error. Keep the
 * shapes here in lockstep with that parser.
 *
 * Usage:
 *
 *   import { carver } from "@carverjs/embed-sdk";
 *
 *   carver.progress(40);                  // loading…
 *   carver.ready();                       // first frame rendered
 *   carver.score(1280, "points");
 *   carver.event("level-complete", { level: 3 });
 *   carver.requestFullscreen();
 *   carver.error("asset-load-failed", "texture atlas 404");
 *   carver.exit();
 *
 *   // Prove which signed-in marketplace user is playing — to YOUR own
 *   // game backend. The shell mints a short-lived signed token from the
 *   // player's session; your server verifies it against the published
 *   // JWKS and ties its saved data to `userId`.
 *   const id = await carver.getIdentity();
 *   if (id.ok) saveToMyBackend(id.token, id.userId);
 *   else if (id.reason === "signin-required") promptSignIn();
 *
 *   const unsubscribe = carver.subscribe((msg) => {
 *     if (msg.type === "carver:pause") {/* pause loop *\/}
 *   });
 *
 * Every method is a safe no-op when the game runs outside an iframe
 * (local dev by opening index.html directly) or in a non-browser
 * environment (SSR, tests). Nothing here ever throws.
 *
 * Security note: outbound messages are posted with targetOrigin "*"
 * by default. They intentionally carry NO secrets — ready/score/
 * progress signals only — and the game cannot know which shell origin
 * embeds it (production, staging, localhost preview). If you ship a
 * game exclusively for one shell, pin it with
 * `carver.configure({ targetOrigin: "https://carverjs.dev" })`.
 *
 * ---------------------------------------------------------------------
 * PROTOCOL v2 — the inbound channel (added in 1.1.0, fully additive)
 * ---------------------------------------------------------------------
 *
 * v1 was outbound-only. v2 adds a versioned SHELL -> GAME channel so a
 * shell can hand a game its runtime configuration instead of baking it
 * into the bundle: ephemeral TURN credentials, a session token, locale,
 * a consent flag, and multiplayer room details. It also adds one closed,
 * whitelisted outbound telemetry envelope.
 *
 *   carver.requestInit();                 // ask the shell for config
 *   const off = carver.onInit((msg) => {  // auto-ACKs carver:init
 *     if (msg.type === "carver:init") boot(msg.payload);
 *     else refreshIce(msg.payload.iceServers);   // carver:ice
 *   });
 *
 *   carver.telemetry({
 *     objectId: "task-3", kcCode: "NCERT.G6.FRAC.EQUIV",
 *     success: true, attempts: 2, hintsUsed: 1, latencyBucket: "lt15s",
 *   });
 *
 * DIRECTION OF SECRETS. v2 inverts the v1 rule in one direction only.
 * Secrets may flow SHELL -> GAME (`sessionToken`, TURN `credential`,
 * `room.signalingToken`): the shell already holds them and the game
 * needs them to reach its own backend. Secrets must NEVER flow
 * GAME -> SHELL. Every outbound message in this file — v1 and v2 —
 * is still free of them, which is what keeps `targetOrigin: "*"` safe.
 * `carver.telemetry()` takes a CLOSED struct precisely so a game cannot
 * smuggle a token out through a free-form field.
 *
 * BECAUSE THE INBOUND CHANNEL NOW CARRIES SECRETS, a game that ships to
 * exactly one shell should pin BOTH directions:
 *
 *   carver.configure({
 *     targetOrigin: "https://carverjs.dev",
 *     parentOrigin: "https://carverjs.dev",
 *   });
 *
 * Without `parentOrigin` the only inbound check is `event.source ===
 * window.parent` — which is sound (nothing but the real embedder can be
 * that object) but does not tell you WHO the embedder is. MDN's guidance
 * is to verify identity with `origin` and `source`, then still validate
 * the syntax of what arrives; this SDK does the source check and the
 * shape check for you, and `parentOrigin` adds the origin check.
 *
 * DUAL TRANSPORT. A game also runs top-level inside a native WebView,
 * where there is no parent frame to post to. When `window.parent ===
 * window` AND `window.__carverNativeBridge` exists, every outbound
 * message is routed through `__carverNativeBridge.postMessage(JSON)`
 * instead, and the native shell delivers inbound messages by calling
 * `window.__carverShellDeliver(msg)`. The message schemas are IDENTICAL
 * on both transports — there are no bridge-specific types — and with
 * neither a parent frame nor a bridge everything stays a safe no-op.
 *
 * ONE HONEST EXCEPTION TO "IDENTICAL", and it is about VALUES, not shapes.
 * The iframe path hands `postMessage` a live object (structured clone); the
 * bridge path hands it `JSON.stringify` text. Every field of every closed
 * message here is a JSON primitive, so those are byte-for-byte the same on
 * both. `carver:event.payload` is free-form and the two serializers disagree
 * about the edges: a cycle clones but does not stringify (the bridge drops the
 * message), a function stringifies-by-omission but does not clone (the iframe
 * drops the message), and NaN/Infinity/undefined survive a clone but become
 * null or vanish in JSON. `carver.score(NaN)` is the same story — the shell
 * drops it either way, but it arrives as NaN over one transport and null over
 * the other. Keep `carver:event` payloads to plain JSON data and the two
 * transports stay indistinguishable.
 */

/**
 * The inbound/outbound protocol revision this SDK speaks. Sent as `v`
 * on every v2 message so a shell can tell an old game from a new one, and
 * on the two v1 messages that gained an optional `v` in 1.1.0
 * (`carver:exit`, `carver:request-fullscreen`). The rest of v1 —
 * `carver:ready` and friends — carries no `v` and never will.
 */
export const PROTOCOL_VERSION = 2;

// ---------------------------------------------------------------------------
// Message types — keep in lockstep with carverjs-web embed-protocol.ts
// ---------------------------------------------------------------------------

/** Game booted and rendered its first frame. Shell hides the loader. */
export type CarverReadyMessage = {
  type: "carver:ready";
};

/** Fatal game error. Shell swaps the iframe for an error card. */
export type CarverErrorMessage = {
  type: "carver:error";
  /** Machine-readable code, e.g. `asset-load-failed`. Shell truncates at 64 chars. */
  code: string;
  /** Human-readable description. Shell truncates at 500 chars. */
  message: string;
};

/**
 * Arbitrary gameplay event for play-stat aggregation.
 *
 * FREE-FORM, AND THEREFORE SHELL-LOCAL. Because `payload` is author
 * controlled and unvalidated, a shell must treat `carver:event` as
 * play telemetry that stops at the shell: aggregate it, log it, show it
 * on a dashboard — but never relay it to a learning-telemetry endpoint.
 * The message for that is `carver:telemetry`, whose closed tuple is the
 * privacy whitelist. See {@link CarverTelemetryTuple}.
 */
export type CarverEventMessage = {
  type: "carver:event";
  /** Event name, e.g. `level-complete`. Shell rejects names over 128 chars. */
  name: string;
  /** Free-form JSON-cloneable payload. */
  payload?: unknown;
};

/** Ask the shell to toggle fullscreen on the game's behalf. */
export type CarverRequestFullscreenMessage = {
  type: "carver:request-fullscreen";
  /**
   * Protocol revision, present from 1.1.0 on. OPTIONAL so that code
   * written against 1.0.x, which constructed this message without a
   * `v`, still type-checks unchanged.
   */
  v?: number;
};

/** Game is done; shell may navigate back / show an end card. */
export type CarverExitMessage = {
  type: "carver:exit";
  /**
   * Protocol revision, present from 1.1.0 on. OPTIONAL for the same
   * reason as on {@link CarverRequestFullscreenMessage}.
   */
  v?: number;
};

/** Score report for player profile stats. */
export type CarverScoreMessage = {
  type: "carver:score";
  /** Finite number — NaN/±Infinity are dropped by the shell. */
  value: number;
  /** Optional display label, e.g. `coins`. Shell truncates at 64 chars. */
  label?: string;
};

/** Load/level progress. Shell clamps to [0, 100]. */
export type CarverProgressMessage = {
  type: "carver:progress";
  percent: number;
};

// --- v2 outbound -----------------------------------------------------------

/** Ask the shell to send (or re-send) `carver:init`. Safe to call twice. */
export type CarverInitRequestMessage = {
  type: "carver:init-request";
  v: number;
};

/** The game received and accepted a `carver:init`. Sent automatically by
 *  {@link carver.onInit}, so a shell can prove the handshake completed. */
export type CarverInitAckMessage = {
  type: "carver:init-ack";
  v: number;
};

/**
 * The game's ICE credentials stopped working (a TURN allocation was
 * refused, or `expiresAt` has passed). Asks the shell for a fresh
 * `carver:ice`. Carries no credential material — only the fact.
 */
export type CarverIceExpiredMessage = {
  type: "carver:ice-expired";
  v: number;
};

/** How long the learner took, coarsened into buckets on purpose: an exact
 *  millisecond latency is a behavioural fingerprint, a bucket is not. */
export type CarverLatencyBucket = "lt5s" | "lt15s" | "lt60s" | "gte60s";

/**
 * THE CANONICAL LEARNING-TELEMETRY UNIT. One interaction, one tuple.
 *
 * This struct is CLOSED — there is deliberately no free-form payload
 * field — because THE CLOSED TYPE IS THE PRIVACY WHITELIST. A game
 * cannot attach a name, a device id, a raw timestamp or a session token
 * to a learning event, because there is nowhere to put one. Widening
 * this type is a privacy review, not a refactor.
 *
 * It maps 1:1 onto the server's whitelisted telemetry columns:
 *
 *   objectId                        the IR object the learner acted on
 *   kcCode            -> kc_code    knowledge component, or null when
 *                                   the interaction maps to none
 *   success/attempts/hintsUsed
 *                     -> the closed evidence enum (the three fields are
 *                        folded server-side into one evidence value;
 *                        they are never stored raw)
 *   latencyBucket     -> latency_bucket
 *   misconceptions    -> misconception_code, one row per entry. Entries
 *                        are IR-REGISTERED DETECTOR IDS, not free text:
 *                        an id the IR does not declare is dropped.
 *   probeItemId                     correlates a retention-probe answer
 *                                   back to the probe item that asked it
 *
 * `carver:telemetry` is the ONLY message a shell may relay to a
 * learning-telemetry endpoint. `carver:event` stays free-form for
 * non-learning play stats and must never leave the shell.
 */
export type CarverTelemetryTuple = {
  /** The IR object this interaction was about, e.g. a task or item id. */
  objectId: string;
  /** Knowledge component code, or `null` when the interaction maps to none. */
  kcCode: string | null;
  /** Did the learner get it right. */
  success: boolean;
  /** Attempts spent on this object, including the successful one. */
  attempts: number;
  /** Scaffolds/hints revealed before answering. */
  hintsUsed: number;
  /** Time-to-answer, bucketed. */
  latencyBucket: CarverLatencyBucket;
  /** IR-registered misconception detector ids that fired. */
  misconceptions?: string[];
  /** Retention-probe item this answer belongs to, when it is one. */
  probeItemId?: number;
};

/** One learning interaction, in the only shape a shell may forward. */
export type CarverTelemetryMessage = {
  type: "carver:telemetry";
  v: number;
  tuple: CarverTelemetryTuple;
};

/**
 * Every message kind the game can send to the shell.
 *
 * v2 WIDENS THIS UNION. A shell that switches exhaustively over it will
 * see new arms; that is the intended, documented cost of a minor bump,
 * and every new arm is safely ignorable by a shell that does not know
 * it. No existing arm changed except for an OPTIONAL `v` on
 * `carver:exit` and `carver:request-fullscreen`.
 */
export type CarverOutboundMessage =
  | CarverReadyMessage
  | CarverErrorMessage
  | CarverEventMessage
  | CarverRequestFullscreenMessage
  | CarverExitMessage
  | CarverScoreMessage
  | CarverProgressMessage
  | CarverInitRequestMessage
  | CarverInitAckMessage
  | CarverIceExpiredMessage
  | CarverTelemetryMessage;

/**
 * Messages the SHELL sends to the game. v1 defined the channel but never
 * used it; v2 fills it with `carver:init`, `carver:ice`, `carver:pause`
 * and `carver:resume` (see {@link CarverInboundV2Message}). Treat unknown
 * types as no-ops — that is what keeps the channel forward-compatible.
 *
 * DELIBERATELY STILL OPEN in v2. The concrete v2 inbound shapes below
 * are all assignable to it, so `subscribe()` keeps its exact 1.0.x
 * signature and no existing handler breaks. Narrow on `msg.type` and
 * cast to the concrete type, or use {@link carver.onInit}, which hands
 * you `carver:init` / `carver:ice` already typed.
 */
export type CarverInboundMessage = {
  type: `carver:${string}`;
  payload?: unknown;
};

export type CarverInboundHandler = (message: CarverInboundMessage) => void;

// --- v2 inbound ------------------------------------------------------------

/** Whether the player (or their guardian) consented to data collection. */
export type CarverConsent = {
  granted: boolean;
};

/**
 * ICE servers for WebRTC, as `RTCPeerConnection` takes them.
 *
 * TURN entries carry a `credential`. This is the one place a secret
 * legitimately crosses into the game, and it only ever travels
 * shell -> game. Never echo one back out.
 */
export type CarverIceBundle = {
  iceServers: RTCIceServer[];
  /** ISO-8601 instant after which these credentials stop working. */
  expiresAt?: string;
};

/** Who the shell says is playing. Display data, not proof of identity. */
export type CarverPlayerInfo = {
  displayName?: string;
  id?: string;
};

/** Multiplayer room the shell has already placed this player in. */
export type CarverRoomInfo = {
  roomId: string;
  role: "host" | "peer";
  /** Short-lived credential for the signaling backend. A secret. */
  signalingToken?: string;
  /** Backend-specific namespace/app id the room lives under. */
  signalingNamespace?: string;
};

/** Where the game's own backend lives, when the shell chooses it. */
export type CarverApiInfo = {
  baseUrl: string;
};

/**
 * Everything a shell can hand a game at boot. EVERY FIELD IS OPTIONAL:
 * a shell sends what it has, a game requires what it needs, and neither
 * has to agree with the other for the channel to work.
 *
 * INTENTIONALLY GENERIC. This is the public engine contract, so it
 * carries no product's vocabulary. A product narrows it to its own
 * strict type on arrival — `@moneytales/shell-config` is one such
 * narrowing — rather than pushing product fields down into here.
 */
export type CarverInitPayload = {
  /** Bearer token for the game's own backend. A secret. */
  sessionToken?: string;
  /** BCP-47-ish language tag the shell wants the game rendered in. */
  locale?: string;
  consent?: CarverConsent;
  ice?: CarverIceBundle;
  player?: CarverPlayerInfo;
  room?: CarverRoomInfo;
  api?: CarverApiInfo;
  /** Shell-specific extras. Unvalidated — narrow before you trust it. */
  extra?: Record<string, unknown>;
};

/** Runtime configuration, sent by the shell at boot or on request. */
export type CarverInitMessage = {
  type: "carver:init";
  v: number;
  payload: CarverInitPayload;
};

/**
 * Fresh ICE credentials, replacing whatever `carver:init` carried.
 * Shells send this unprompted before `expiresAt`, or in answer to
 * `carver:ice-expired`.
 */
export type CarverIceMessage = {
  type: "carver:ice";
  v: number;
  payload: CarverIceBundle;
};

/** The shell backgrounded the game: halt timers, audio and the render loop. */
export type CarverPauseMessage = {
  type: "carver:pause";
  v: number;
};

/** The shell foregrounded the game again. */
export type CarverResumeMessage = {
  type: "carver:resume";
  v: number;
};

/** The concrete inbound shapes v2 defines. All assignable to
 *  {@link CarverInboundMessage}, which stays open. */
export type CarverInboundV2Message =
  | CarverInitMessage
  | CarverIceMessage
  | CarverPauseMessage
  | CarverResumeMessage;

/** What {@link carver.onInit} delivers: config, and later ICE refreshes. */
export type CarverInitHandler = (
  message: CarverInitMessage | CarverIceMessage,
) => void;

// ---------------------------------------------------------------------------
// Native bridge — the second transport
// ---------------------------------------------------------------------------

/**
 * The object a native WebView shell injects to receive outbound
 * messages. Both WKWebView (`window.webkit.messageHandlers.<name>`) and
 * Android's `addJavascriptInterface` expose exactly this shape, so a
 * native shell aliases one onto `window.__carverNativeBridge`.
 */
export type CarverNativeBridge = {
  postMessage: (json: string) => void;
};

declare global {
  interface Window {
    /** Set by a native WebView shell. See {@link CarverNativeBridge}. */
    __carverNativeBridge?: CarverNativeBridge;
    /**
     * Set by this SDK once something subscribes. A native shell calls it
     * to deliver an inbound message, passing either the object or its
     * JSON text. Junk is ignored, never thrown.
     */
    __carverShellDeliver?: (message: unknown) => void;
  }
}

// ---------------------------------------------------------------------------
// Identity — carver.getIdentity()
// ---------------------------------------------------------------------------

/** Why an identity request could not return a token. */
export type CarverIdentityFailureReason =
  /** No marketplace user is signed in (or the visitor is anonymous). */
  | "signin-required"
  /** Not running inside the marketplace shell (e.g. local dev). */
  | "not-embedded"
  /** The shell did not answer in time. */
  | "timeout"
  /** Too many identity requests in a short window. */
  | "rate-limited"
  /** Any other failure (network, shell error). */
  | "error";

/**
 * Result of `carver.getIdentity()`.
 *
 * On success, `token` is a short-lived RS256 JWT proving which
 * marketplace user is playing. Send it to YOUR OWN backend and verify it
 * against the marketplace JWKS (`https://www.carverjs.dev/.well-known/jwks.json`):
 * check `iss`, `aud === <your gameId>`, and `exp`. `userId` is a stable,
 * opaque per-game id (the token's `sub`) — the same player keeps the
 * same id for your game across sessions, and it cannot be correlated to
 * other games. `expiresAt` is a Unix epoch in milliseconds.
 */
export type CarverIdentity =
  | { ok: true; token: string; userId: string; expiresAt: number }
  | { ok: false; reason: CarverIdentityFailureReason };

export type CarverConfig = {
  /**
   * targetOrigin for outbound postMessage. Default "*" — outbound
   * messages carry no secrets and the embedding shell origin is not
   * knowable from inside the sandbox. Pin to a single origin if your
   * game only ever ships to one shell.
   */
  targetOrigin?: string;
  /**
   * When set, inbound messages are additionally required to come from
   * this exact origin (on top of the always-on `event.source ===
   * window.parent` check). Default: source check only.
   */
  parentOrigin?: string;
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const config: Required<CarverConfig> = {
  targetOrigin: "*",
  parentOrigin: "",
};

/** True when running in a browser AND inside someone else's frame. */
function isEmbedded(): boolean {
  try {
    return typeof window !== "undefined" && window.parent !== window;
  } catch {
    return false;
  }
}

/**
 * The native bridge, when this game is top-level in a WebView that
 * injected one.
 *
 * RESOLVED PER CALL, not cached at module load. A WebView routinely
 * injects its bridge after the document starts evaluating scripts, so a
 * value captured at import time would be `undefined` on exactly the
 * shells this exists for. The check is three property reads.
 *
 * An iframe ALWAYS wins: if there is a parent frame, postMessage is the
 * transport, bridge or no bridge. A page cannot be in both situations,
 * and preferring the frame keeps the marketplace path untouched.
 */
function nativeBridge(): CarverNativeBridge | null {
  try {
    if (typeof window === "undefined") return null;
    if (window.parent !== window) return null;
    const bridge = window.__carverNativeBridge;
    return bridge != null && typeof bridge.postMessage === "function"
      ? bridge
      : null;
  } catch {
    return null;
  }
}

/**
 * Post to the shell over whichever transport exists. Never throws;
 * silently no-ops when there is neither a parent frame nor a bridge.
 */
function post(message: CarverOutboundMessage): void {
  const bridge = nativeBridge();
  if (bridge !== null) {
    try {
      bridge.postMessage(JSON.stringify(message));
    } catch {
      // A cyclic carver:event payload (JSON.stringify throws on those,
      // where structuredClone throws on functions) or a bridge the
      // WebView already tore down. Same rule as the iframe path: a
      // telemetry message must never crash the game.
    }
    return;
  }
  if (!isEmbedded()) return;
  try {
    window.parent.postMessage(message, config.targetOrigin);
  } catch {
    // DataCloneError (non-cloneable payload) or a detached parent.
    // Swallow — telemetry messages must never crash the game.
  }
}

// ---------------------------------------------------------------------------
// Inbound dispatch — one path, both transports
// ---------------------------------------------------------------------------

/**
 * Subscribers, in an ARRAY rather than a Set.
 *
 * `subscribe(fn)` twice with the same function reference registered two
 * listeners in 1.0.x and called the handler twice; a Set would silently
 * dedupe it. Each entry is its own object so unsubscribe removes
 * exactly the registration it was handed back for.
 */
type Subscription = { handler: CarverInboundHandler };
const subscriptions: Subscription[] = [];
let inboundInstalled = false;

/**
 * Validate an inbound message and hand it to every subscriber.
 *
 * THE ONLY DELIVERY PATH. Both the `message` listener and
 * `window.__carverShellDeliver` funnel through here, which is what
 * makes the two transports carry identical schemas rather than
 * near-identical ones that drift.
 *
 * Trust is established by the CALLER (source/origin for postMessage,
 * being on our own window for the bridge); this function only decides
 * whether the thing is shaped like a carver message at all. MDN's rule:
 * having verified identity, still verify the syntax.
 */
function deliver(raw: unknown): void {
  let data: unknown = raw;
  // A native shell that mirrors our own outbound encoding hands us JSON
  // text. Accept both rather than making the bridge asymmetric.
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return;
    }
  }
  if (typeof data !== "object" || data === null) return;
  const type = (data as { type?: unknown }).type;
  if (typeof type !== "string" || !type.startsWith("carver:")) return;
  const message = data as CarverInboundMessage;
  // Copied first: a handler that unsubscribes itself (or subscribes
  // another) must not reindex the array mid-dispatch.
  for (const subscription of [...subscriptions]) {
    try {
      subscription.handler(message);
    } catch {
      // A throwing handler must not kill the message channel.
    }
  }
}

/**
 * Install the `message` listener and the native deliver hook, once.
 *
 * LAZY, NOT AT MODULE LOAD, because this package declares
 * `sideEffects: false` — a bundler is entitled to drop a module whose
 * only effect is at import time, and a game that tree-shook its own
 * inbound channel away would be a very quiet bug. Called from every
 * entry point that needs inbound to work.
 */
function ensureInbound(): void {
  if (inboundInstalled || typeof window === "undefined") return;
  inboundInstalled = true;

  window.addEventListener("message", (e: MessageEvent): void => {
    // Only the direct embedding frame is trusted — not siblings, not
    // nested children, not random windows holding a reference to us.
    if (e.source !== window.parent) return;
    if (config.parentOrigin.length > 0 && e.origin !== config.parentOrigin) {
      return;
    }
    deliver(e.data);
  });

  // The bridge's inbound half. It lives on our own window, so anything
  // that can call it already runs in this game's document — there is no
  // origin to check, only a shape.
  window.__carverShellDeliver = (message: unknown): void => {
    deliver(message);
  };
}

// ---------------------------------------------------------------------------
// Identity internals (request/response over postMessage, correlated by id)
// ---------------------------------------------------------------------------

/** How long to wait for the shell to answer an identity request. */
const IDENTITY_TIMEOUT_MS = 10_000;

type PendingIdentity = {
  resolve: (value: CarverIdentity) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingIdentity = new Map<string, PendingIdentity>();
let identityListenerInstalled = false;
let identityCounter = 0;

const IDENTITY_REASONS: ReadonlySet<string> = new Set([
  "signin-required",
  "not-embedded",
  "timeout",
  "rate-limited",
  "error",
]);

function toReason(value: unknown): CarverIdentityFailureReason {
  return typeof value === "string" && IDENTITY_REASONS.has(value)
    ? (value as CarverIdentityFailureReason)
    : "error";
}

/** Correlation id for an identity round-trip. Uniqueness within one game
 *  session is all that's needed — a counter plus a random suffix. */
function nextRequestId(): string {
  identityCounter += 1;
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `cjs-id-${identityCounter}-${rand}`;
}

/** Lazily install the single listener that resolves identity results. */
function ensureIdentityListener(): void {
  if (identityListenerInstalled || typeof window === "undefined") return;
  identityListenerInstalled = true;

  window.addEventListener("message", (e: MessageEvent): void => {
    // Same trust rules as subscribe(): the direct parent only, plus the
    // optional pinned parentOrigin.
    if (e.source !== window.parent) return;
    if (config.parentOrigin.length > 0 && e.origin !== config.parentOrigin) {
      return;
    }
    const data: unknown = e.data;
    if (typeof data !== "object" || data === null) return;
    const d = data as {
      type?: unknown;
      requestId?: unknown;
      ok?: unknown;
      token?: unknown;
      userId?: unknown;
      expiresAt?: unknown;
      reason?: unknown;
    };
    if (d.type !== "carver:identity-result") return;
    if (typeof d.requestId !== "string") return;

    const pending = pendingIdentity.get(d.requestId);
    if (!pending) return;
    pendingIdentity.delete(d.requestId);
    clearTimeout(pending.timer);

    if (
      d.ok === true &&
      typeof d.token === "string" &&
      typeof d.userId === "string" &&
      typeof d.expiresAt === "number"
    ) {
      pending.resolve({
        ok: true,
        token: d.token,
        userId: d.userId,
        expiresAt: d.expiresAt,
      });
    } else {
      pending.resolve({ ok: false, reason: toReason(d.reason) });
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Override targetOrigin / parentOrigin. Call once at boot, before subscribe. */
function configure(next: CarverConfig): void {
  if (typeof next.targetOrigin === "string" && next.targetOrigin.length > 0) {
    config.targetOrigin = next.targetOrigin;
  }
  if (typeof next.parentOrigin === "string") {
    config.parentOrigin = next.parentOrigin;
  }
}

/** Signal the game booted and rendered its first frame. */
function ready(): void {
  post({ type: "carver:ready" });
}

/** Report a fatal error. The shell replaces the game with an error card. */
function error(code: string, message: string): void {
  post({ type: "carver:error", code, message });
}

/** Emit a gameplay event for play-stat aggregation. */
function event(name: string, payload?: unknown): void {
  const msg: CarverEventMessage = { type: "carver:event", name };
  if (payload !== undefined) msg.payload = payload;
  post(msg);
}

/** Ask the shell to toggle fullscreen. Call from a user-gesture handler. */
function requestFullscreen(): void {
  post({ type: "carver:request-fullscreen", v: PROTOCOL_VERSION });
}

/** Signal the game is finished and ask the shell to close the player. */
function exit(): void {
  post({ type: "carver:exit", v: PROTOCOL_VERSION });
}

/** Report a score. `value` must be a finite number. */
function score(value: number, label?: string): void {
  const msg: CarverScoreMessage = { type: "carver:score", value };
  if (label !== undefined) msg.label = label;
  post(msg);
}

/** Report load/level progress. Clamped to [0, 100] on both ends. */
function progress(percent: number): void {
  const clamped = Number.isFinite(percent)
    ? Math.min(100, Math.max(0, percent))
    : 0;
  post({ type: "carver:progress", percent: clamped });
}

/**
 * Listen for shell -> game messages. Only events whose `source` is the
 * direct parent window are delivered (plus an origin check when
 * `parentOrigin` is configured), and — in a native WebView — whatever
 * the shell hands to `window.__carverShellDeliver`. Returns an
 * unsubscribe function.
 */
function subscribe(handler: CarverInboundHandler): () => void {
  if (typeof window === "undefined") return () => {};
  ensureInbound();

  const subscription: Subscription = { handler };
  subscriptions.push(subscription);

  return () => {
    const at = subscriptions.indexOf(subscription);
    if (at !== -1) subscriptions.splice(at, 1);
  };
}

/**
 * Ask the shell for a short-lived signed token identifying the
 * signed-in marketplace player, to send to YOUR OWN game backend.
 *
 * Always resolves (never rejects): `{ ok: true, token, userId, expiresAt }`
 * on success, or `{ ok: false, reason }` otherwise — `"signin-required"`
 * when no real account is signed in, `"not-embedded"` outside the
 * marketplace, `"timeout"` if the shell doesn't answer. Verify the token
 * server-side against the marketplace JWKS; never trust it client-side.
 *
 * IFRAME ONLY, BY DESIGN. This is the marketplace's identity feature and
 * it resolves `"not-embedded"` over the native bridge. A native shell
 * already holds the player's session and hands the game a `sessionToken`
 * through `carver:init` — that is the same job, done by the transport
 * that actually has the credential.
 */
function getIdentity(): Promise<CarverIdentity> {
  if (!isEmbedded()) {
    return Promise.resolve({ ok: false, reason: "not-embedded" });
  }
  ensureIdentityListener();

  const requestId = nextRequestId();
  return new Promise<CarverIdentity>((resolve) => {
    const timer = setTimeout(() => {
      pendingIdentity.delete(requestId);
      resolve({ ok: false, reason: "timeout" });
    }, IDENTITY_TIMEOUT_MS);

    pendingIdentity.set(requestId, { resolve, timer });

    try {
      window.parent.postMessage(
        { type: "carver:identity-request", requestId },
        config.targetOrigin,
      );
    } catch {
      clearTimeout(timer);
      pendingIdentity.delete(requestId);
      resolve({ ok: false, reason: "error" });
    }
  });
}

// --- v2 helpers ------------------------------------------------------------

/**
 * Ask the shell to send `carver:init`.
 *
 * Installs the inbound plumbing first, so a shell that answers
 * synchronously cannot beat the listener into place. Idempotent from
 * the game's side, and shells are required to treat a repeat as a
 * re-send rather than an error, so calling it on a retry is fine.
 */
function requestInit(): void {
  ensureInbound();
  post({ type: "carver:init-request", v: PROTOCOL_VERSION });
}

/**
 * Subscribe to runtime configuration: `carver:init` once, then every
 * `carver:ice` refresh. ACKs each `carver:init` automatically with
 * `carver:init-ack` so the shell can prove the game took its config.
 *
 * Returns an unsubscribe function. Does NOT send `carver:init-request`
 * — call {@link carver.requestInit} for that, after subscribing.
 */
function onInit(handler: CarverInitHandler): () => void {
  return subscribe((message) => {
    if (message.type === "carver:init") {
      const init = message as CarverInitMessage;
      // ACK BEFORE the handler runs: a handler that throws is caught by
      // deliver() and would otherwise swallow the acknowledgement too,
      // leaving the shell waiting on a game that did receive its config.
      post({ type: "carver:init-ack", v: PROTOCOL_VERSION });
      handler(init);
      return;
    }
    if (message.type === "carver:ice") {
      handler(message as CarverIceMessage);
    }
  });
}

/**
 * Report one learning interaction. See {@link CarverTelemetryTuple} —
 * the tuple is closed on purpose and is the whole privacy whitelist.
 *
 * THE FIELDS ARE PICKED, NOT FORWARDED. TypeScript's excess-property check
 * fires only on a fresh object literal at the call site, so
 *
 *     const t = { ...internalEvent, objectId, kcCode, success, attempts,
 *                 hintsUsed, latencyBucket };
 *     carver.telemetry(t);            // compiles clean
 *
 * would have shipped every other property of `internalEvent` — a device id, a
 * raw timestamp, a session token — out to the shell, and `carver:telemetry` is
 * the one message a shell is allowed to relay onward to a server. A
 * compile-time whitelist is not a whitelist when a variable defeats it, so the
 * eight known keys are copied out by hand and nothing else can ride along.
 */
function telemetry(tuple: CarverTelemetryTuple): void {
  const picked: CarverTelemetryTuple = {
    objectId: tuple.objectId,
    kcCode: tuple.kcCode,
    success: tuple.success,
    attempts: tuple.attempts,
    hintsUsed: tuple.hintsUsed,
    latencyBucket: tuple.latencyBucket,
  };
  // Copied element by element: the caller's array is theirs to mutate after
  // this call, and a shared reference would let it change under the shell.
  if (Array.isArray(tuple.misconceptions)) {
    picked.misconceptions = tuple.misconceptions.filter(
      (code): code is string => typeof code === "string",
    );
  }
  if (typeof tuple.probeItemId === "number") {
    picked.probeItemId = tuple.probeItemId;
  }
  post({ type: "carver:telemetry", v: PROTOCOL_VERSION, tuple: picked });
}

/**
 * Tell the shell the current ICE credentials no longer work, and ask
 * for a fresh `carver:ice`. Sends no credential material, only the fact.
 */
function iceExpired(): void {
  post({ type: "carver:ice-expired", v: PROTOCOL_VERSION });
}

export const carver = {
  configure,
  isEmbedded,
  ready,
  error,
  event,
  requestFullscreen,
  exit,
  score,
  progress,
  subscribe,
  getIdentity,
  requestInit,
  onInit,
  telemetry,
  iceExpired,
} as const;

export default carver;
