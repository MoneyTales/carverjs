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
} as const;

export default carver;
