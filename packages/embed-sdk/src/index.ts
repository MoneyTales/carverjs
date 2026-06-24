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
 */

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

/** Arbitrary gameplay event for play-stat aggregation. */
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
};

/** Game is done; shell may navigate back / show an end card. */
export type CarverExitMessage = {
  type: "carver:exit";
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

/** Every message kind the game can send to the shell. */
export type CarverOutboundMessage =
  | CarverReadyMessage
  | CarverErrorMessage
  | CarverEventMessage
  | CarverRequestFullscreenMessage
  | CarverExitMessage
  | CarverScoreMessage
  | CarverProgressMessage;

/**
 * Messages the SHELL sends to the game. None are emitted today; the
 * channel exists so future hints (pause/resume on tab-hide, volume,
 * locale) arrive without an SDK upgrade. Treat unknown types as no-ops.
 */
export type CarverInboundMessage = {
  type: `carver:${string}`;
  payload?: unknown;
};

export type CarverInboundHandler = (message: CarverInboundMessage) => void;

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

/** Post to the parent. Never throws; silently no-ops when not embedded. */
function post(message: CarverOutboundMessage): void {
  if (!isEmbedded()) return;
  try {
    window.parent.postMessage(message, config.targetOrigin);
  } catch {
    // DataCloneError (non-cloneable payload) or a detached parent.
    // Swallow — telemetry messages must never crash the game.
  }
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
  post({ type: "carver:request-fullscreen" });
}

/** Signal the game is finished. */
function exit(): void {
  post({ type: "carver:exit" });
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
 * `parentOrigin` is configured). Returns an unsubscribe function.
 */
function subscribe(handler: CarverInboundHandler): () => void {
  if (typeof window === "undefined") return () => {};

  const listener = (e: MessageEvent): void => {
    // Only the direct embedding frame is trusted — not siblings, not
    // nested children, not random windows holding a reference to us.
    if (e.source !== window.parent) return;
    if (config.parentOrigin.length > 0 && e.origin !== config.parentOrigin) {
      return;
    }
    const data: unknown = e.data;
    if (typeof data !== "object" || data === null) return;
    const type = (data as { type?: unknown }).type;
    if (typeof type !== "string" || !type.startsWith("carver:")) return;
    try {
      handler(data as CarverInboundMessage);
    } catch {
      // A throwing handler must not kill the message channel.
    }
  };

  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
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
} as const;

export default carver;
