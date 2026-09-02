import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CarverIceMessage,
  CarverInboundMessage,
  CarverInitMessage,
  CarverProgressMessage,
  CarverTelemetryTuple,
} from "../index";

/**
 * The SDK keeps its subscriber list, its config and its "listener already
 * installed" flag in module scope, so every case loads a FRESH copy through
 * `vi.resetModules()` + `import()`. Old copies keep their `message` listener
 * on the shared jsdom window forever — harmless only because `afterEach`
 * unsubscribes everything, leaving them with nobody to dispatch to.
 */
type Sdk = typeof import("../index");
type Carver = Sdk["carver"];

/** One captured `window.parent.postMessage(data, targetOrigin)` call. */
type Sent = { data: unknown; targetOrigin: string };

const SHELL_ORIGIN = "https://shell.example";

const TUPLE: CarverTelemetryTuple = {
  objectId: "task-3",
  kcCode: "NCERT.G6.FRAC.EQUIV",
  success: true,
  attempts: 2,
  hintsUsed: 1,
  latencyBucket: "lt15s",
};

/**
 * Every outbound message the SDK can produce, in one fixed order, so the
 * iframe transport and the native bridge can be compared message for message.
 */
function emitAll(carver: Carver): void {
  carver.ready();
  carver.progress(55);
  carver.score(1280, "points");
  carver.event("level-complete", { level: 3 });
  carver.error("asset-load-failed", "texture atlas 404");
  carver.requestFullscreen();
  carver.exit();
  carver.requestInit();
  carver.telemetry(TUPLE);
  carver.iceExpired();
}

const EXPECTED_OUTBOUND: unknown[] = [
  { type: "carver:ready" },
  { type: "carver:progress", percent: 55 },
  { type: "carver:score", value: 1280, label: "points" },
  { type: "carver:event", name: "level-complete", payload: { level: 3 } },
  {
    type: "carver:error",
    code: "asset-load-failed",
    message: "texture atlas 404",
  },
  { type: "carver:request-fullscreen", v: 2 },
  { type: "carver:exit", v: 2 },
  { type: "carver:init-request", v: 2 },
  { type: "carver:telemetry", v: 2, tuple: TUPLE },
  { type: "carver:ice-expired", v: 2 },
];

let sent: Sent[] = [];
let bridgeSent: string[] = [];
const cleanups: Array<() => void> = [];

async function loadSdk(): Promise<Sdk> {
  vi.resetModules();
  return import("../index");
}

/**
 * jsdom's own `window.postMessage` delivers an event with `source === null`,
 * which can never satisfy the SDK's `e.source === window.parent` check. So the
 * shell is a plain object installed AS `window.parent`: that makes
 * `isEmbedded()` true, captures outbound, and gives inbound events a `source`
 * that passes. Everything between those two points is the SDK's real code.
 */
function installFakeParent(): void {
  const parent = {
    postMessage: (data: unknown, targetOrigin: string): void => {
      sent.push({ data, targetOrigin });
    },
  } as unknown as Window;
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
}

/** Top-level again: `window.parent === window`, i.e. not embedded. */
function restoreParent(): void {
  Object.defineProperty(window, "parent", { value: window, configurable: true });
}

function installBridge(): void {
  window.__carverNativeBridge = {
    postMessage: (json: string): void => {
      bridgeSent.push(json);
    },
  };
}

function bridgeMessages(): unknown[] {
  return bridgeSent.map((json) => JSON.parse(json) as unknown);
}

function dispatchFromParent(data: unknown, origin = SHELL_ORIGIN): void {
  window.dispatchEvent(
    new MessageEvent<unknown>("message", {
      data,
      source: window.parent,
      origin,
    }),
  );
}

function record(into: CarverInboundMessage[]): (m: CarverInboundMessage) => void {
  return (message) => {
    into.push(message);
  };
}

beforeEach(() => {
  sent = [];
  bridgeSent = [];
});

afterEach(() => {
  let off = cleanups.pop();
  while (off !== undefined) {
    off();
    off = cleanups.pop();
  }
  delete window.__carverNativeBridge;
  delete window.__carverShellDeliver;
  restoreParent();
});

describe("iframe transport", () => {
  it("requestInit posts carver:init-request with v", async () => {
    const { carver } = await loadSdk();
    installFakeParent();

    carver.requestInit();

    expect(sent).toEqual([
      { data: { type: "carver:init-request", v: 2 }, targetOrigin: "*" },
    ]);
  });

  it("carver:init reaches onInit and is acknowledged automatically", async () => {
    const { carver } = await loadSdk();
    installFakeParent();
    const got: Array<CarverInitMessage | CarverIceMessage> = [];
    cleanups.push(
      carver.onInit((message) => {
        got.push(message);
      }),
    );

    const init = {
      type: "carver:init",
      v: 2,
      payload: { locale: "en-IN", consent: { granted: true } },
    };
    dispatchFromParent(init);

    expect(got).toEqual([init]);
    expect(sent).toEqual([
      { data: { type: "carver:init-ack", v: 2 }, targetOrigin: "*" },
    ]);
  });

  it("carver:ice reaches onInit without producing an ack", async () => {
    const { carver } = await loadSdk();
    installFakeParent();
    const got: Array<CarverInitMessage | CarverIceMessage> = [];
    cleanups.push(
      carver.onInit((message) => {
        got.push(message);
      }),
    );

    const ice = {
      type: "carver:ice",
      v: 2,
      payload: {
        iceServers: [{ urls: "turn:turn.example:3478", credential: "s3cret" }],
        expiresAt: "2026-01-01T00:00:00.000Z",
      },
    };
    dispatchFromParent(ice);

    expect(got).toEqual([ice]);
    expect(sent).toEqual([]);
  });

  it("carver:pause and carver:resume arrive through subscribe", async () => {
    const { carver } = await loadSdk();
    installFakeParent();
    const got: CarverInboundMessage[] = [];
    cleanups.push(carver.subscribe(record(got)));

    dispatchFromParent({ type: "carver:pause", v: 2 });
    dispatchFromParent({ type: "carver:resume", v: 2 });

    expect(got).toEqual([
      { type: "carver:pause", v: 2 },
      { type: "carver:resume", v: 2 },
    ]);
  });

  it("exit and request-fullscreen carry v", async () => {
    const { carver, PROTOCOL_VERSION } = await loadSdk();
    installFakeParent();

    carver.exit();
    carver.requestFullscreen();

    expect(PROTOCOL_VERSION).toBe(2);
    expect(sent.map((s) => s.data)).toEqual([
      { type: "carver:exit", v: 2 },
      { type: "carver:request-fullscreen", v: 2 },
    ]);
  });

  it("telemetry posts the tuple verbatim", async () => {
    const { carver } = await loadSdk();
    installFakeParent();

    carver.telemetry(TUPLE);

    expect(sent.map((s) => s.data)).toEqual([
      { type: "carver:telemetry", v: 2, tuple: TUPLE },
    ]);
  });

  it("picks the tuple's known fields and drops anything smuggled alongside", async () => {
    const { carver } = await loadSdk();
    installFakeParent();

    // A VARIABLE, not a fresh literal: TypeScript's excess-property check does
    // not fire here, which is exactly how a session token would have reached
    // the shell if telemetry() forwarded its argument.
    const smuggled = {
      ...TUPLE,
      misconceptions: ["frac.denominator-added", 42, "frac.whole-ignored"],
      probeItemId: 7,
      sessionToken: "eyJ-a-real-secret",
      deviceId: "device-abcdef",
      answeredAt: 1_700_000_000_000,
    } as unknown as CarverTelemetryTuple;

    carver.telemetry(smuggled);

    expect(sent.map((s) => s.data)).toEqual([
      {
        type: "carver:telemetry",
        v: 2,
        tuple: {
          ...TUPLE,
          // The non-string entry is dropped: misconception codes are
          // IR-registered detector ids, and 42 is not one.
          misconceptions: ["frac.denominator-added", "frac.whole-ignored"],
          probeItemId: 7,
        },
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain("eyJ-a-real-secret");
    expect(JSON.stringify(sent)).not.toContain("device-abcdef");
  });

  it("does not share the caller's misconceptions array with the shell", async () => {
    const { carver } = await loadSdk();
    installFakeParent();

    const codes = ["frac.denominator-added"];
    carver.telemetry({ ...TUPLE, misconceptions: codes });
    codes.push("added-after-the-fact");

    const first = sent[0]?.data as { tuple: CarverTelemetryTuple };
    expect(first.tuple.misconceptions).toEqual(["frac.denominator-added"]);
  });

  it("iceExpired posts carver:ice-expired and no credential material", async () => {
    const { carver } = await loadSdk();
    installFakeParent();

    carver.iceExpired();

    expect(sent.map((s) => s.data)).toEqual([
      { type: "carver:ice-expired", v: 2 },
    ]);
  });

  it("drops a message whose source is not the parent window", async () => {
    const { carver } = await loadSdk();
    installFakeParent();
    const got: CarverInboundMessage[] = [];
    cleanups.push(carver.subscribe(record(got)));

    const impostor = { postMessage: (): void => {} } as unknown as Window;
    window.dispatchEvent(
      new MessageEvent<unknown>("message", {
        data: { type: "carver:init", v: 2, payload: { sessionToken: "nope" } },
        source: impostor,
        origin: SHELL_ORIGIN,
      }),
    );
    window.dispatchEvent(
      new MessageEvent<unknown>("message", {
        data: { type: "carver:pause", v: 2 },
        source: null,
        origin: SHELL_ORIGIN,
      }),
    );

    expect(got).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("drops a message from another origin once parentOrigin is pinned", async () => {
    const { carver } = await loadSdk();
    installFakeParent();
    carver.configure({ parentOrigin: SHELL_ORIGIN });
    const got: CarverInboundMessage[] = [];
    cleanups.push(carver.subscribe(record(got)));

    dispatchFromParent({ type: "carver:pause", v: 2 }, "https://evil.example");
    expect(got).toEqual([]);

    dispatchFromParent({ type: "carver:resume", v: 2 }, SHELL_ORIGIN);
    expect(got).toEqual([{ type: "carver:resume", v: 2 }]);
  });

  it("ignores junk without throwing", async () => {
    const { carver } = await loadSdk();
    installFakeParent();
    const got: CarverInboundMessage[] = [];
    cleanups.push(carver.subscribe(record(got)));

    const junk: unknown[] = [
      "hello",
      "",
      null,
      undefined,
      42,
      {},
      { type: 7 },
      { type: "other:thing", payload: { a: 1 } },
      // What a cross-frame library posts: an object, but nothing to do with us.
      { source: "react-devtools-bridge", payload: {} },
    ];
    for (const data of junk) {
      expect(() => {
        dispatchFromParent(data);
      }).not.toThrow();
    }

    expect(got).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("a throwing handler does not stop the next one", async () => {
    const { carver } = await loadSdk();
    installFakeParent();
    const got: CarverInboundMessage[] = [];
    cleanups.push(
      carver.subscribe(() => {
        throw new Error("handler blew up");
      }),
    );
    cleanups.push(carver.subscribe(record(got)));

    expect(() => {
      dispatchFromParent({ type: "carver:pause", v: 2 });
    }).not.toThrow();
    expect(got).toEqual([{ type: "carver:pause", v: 2 }]);
  });
});

describe("native bridge transport", () => {
  it("sends the identical schemas the iframe transport sends, as JSON text", async () => {
    const iframeSdk = await loadSdk();
    installFakeParent();
    emitAll(iframeSdk.carver);
    const overIframe = sent.map((s) => s.data);

    restoreParent();
    const bridgeSdk = await loadSdk();
    installBridge();
    emitAll(bridgeSdk.carver);

    expect(bridgeSent.every((json) => typeof json === "string")).toBe(true);
    // Anchored to a literal as well as to each other, so the two transports
    // cannot drift together into the same wrong shape.
    expect(overIframe).toEqual(EXPECTED_OUTBOUND);
    expect(bridgeMessages()).toEqual(EXPECTED_OUTBOUND);
    expect(bridgeMessages()).toEqual(overIframe);
  });

  it("installs __carverShellDeliver on subscribe and accepts an object or its JSON", async () => {
    installBridge();
    const { carver } = await loadSdk();
    expect(window.__carverShellDeliver).toBeUndefined();

    const got: CarverInboundMessage[] = [];
    cleanups.push(carver.subscribe(record(got)));
    expect(typeof window.__carverShellDeliver).toBe("function");

    window.__carverShellDeliver?.({ type: "carver:pause", v: 2 });
    window.__carverShellDeliver?.(
      JSON.stringify({ type: "carver:resume", v: 2 }),
    );

    expect(got).toEqual([
      { type: "carver:pause", v: 2 },
      { type: "carver:resume", v: 2 },
    ]);
  });

  it("acknowledges carver:init back over the bridge", async () => {
    installBridge();
    const { carver } = await loadSdk();
    const got: Array<CarverInitMessage | CarverIceMessage> = [];
    cleanups.push(
      carver.onInit((message) => {
        got.push(message);
      }),
    );

    const init = {
      type: "carver:init",
      v: 2,
      payload: { sessionToken: "shell-minted", locale: "hi-IN" },
    };
    window.__carverShellDeliver?.(init);

    expect(got).toEqual([init]);
    expect(bridgeMessages()).toEqual([{ type: "carver:init-ack", v: 2 }]);
    expect(sent).toEqual([]);
  });

  it("delivers carver:pause and carver:resume to subscribers", async () => {
    installBridge();
    const { carver } = await loadSdk();
    const got: CarverInboundMessage[] = [];
    cleanups.push(carver.subscribe(record(got)));

    window.__carverShellDeliver?.({ type: "carver:pause", v: 2 });
    window.__carverShellDeliver?.({ type: "carver:resume", v: 2 });

    expect(got.map((m) => m.type)).toEqual(["carver:pause", "carver:resume"]);
  });

  it("ignores junk handed to __carverShellDeliver", async () => {
    installBridge();
    const { carver } = await loadSdk();
    const got: CarverInboundMessage[] = [];
    cleanups.push(carver.subscribe(record(got)));

    const junk: unknown[] = [
      "{ not json",
      "",
      null,
      undefined,
      0,
      [],
      { nope: true },
      JSON.stringify({ type: "other:thing" }),
    ];
    for (const data of junk) {
      expect(() => {
        window.__carverShellDeliver?.(data);
      }).not.toThrow();
    }

    expect(got).toEqual([]);
    expect(bridgeSent).toEqual([]);
  });
});

describe("v1 backward compatibility", () => {
  it("v1 messages keep their exact 1.0.x bytes and carry no v", async () => {
    const { carver } = await loadSdk();
    installFakeParent();

    carver.ready();
    carver.error("asset-load-failed", "texture atlas 404");
    carver.event("level-complete", { level: 3 });
    carver.event("plain");
    carver.score(1280, "points");
    carver.score(7);
    carver.progress(40);

    expect(sent.map((s) => JSON.stringify(s.data))).toEqual([
      '{"type":"carver:ready"}',
      '{"type":"carver:error","code":"asset-load-failed","message":"texture atlas 404"}',
      '{"type":"carver:event","name":"level-complete","payload":{"level":3}}',
      '{"type":"carver:event","name":"plain"}',
      '{"type":"carver:score","value":1280,"label":"points"}',
      '{"type":"carver:score","value":7}',
      '{"type":"carver:progress","percent":40}',
    ]);
    expect(sent.every((s) => s.targetOrigin === "*")).toBe(true);
  });

  it("progress clamps to [0, 100] and maps non-finite to 0", async () => {
    const { carver } = await loadSdk();
    installFakeParent();

    carver.progress(-10);
    carver.progress(250);
    carver.progress(Number.NaN);
    carver.progress(Number.POSITIVE_INFINITY);
    carver.progress(Number.NEGATIVE_INFINITY);
    carver.progress(42.5);

    expect(sent.map((s) => (s.data as CarverProgressMessage).percent)).toEqual([
      0, 100, 0, 0, 0, 42.5,
    ]);
  });

  it("subscribing the same function twice delivers twice", async () => {
    const { carver } = await loadSdk();
    installFakeParent();
    let calls = 0;
    const handler = (): void => {
      calls += 1;
    };
    cleanups.push(carver.subscribe(handler));
    cleanups.push(carver.subscribe(handler));

    dispatchFromParent({ type: "carver:pause", v: 2 });

    expect(calls).toBe(2);
  });

  it("unsubscribe removes exactly one registration", async () => {
    const { carver } = await loadSdk();
    installFakeParent();
    let calls = 0;
    const handler = (): void => {
      calls += 1;
    };
    const off = carver.subscribe(handler);
    cleanups.push(carver.subscribe(handler));

    off();
    dispatchFromParent({ type: "carver:pause", v: 2 });
    expect(calls).toBe(1);

    off();
    dispatchFromParent({ type: "carver:resume", v: 2 });
    expect(calls).toBe(2);
  });
});

describe("unembedded", () => {
  it("every method is a silent no-op with no parent frame and no bridge", async () => {
    const { carver } = await loadSdk();
    restoreParent();

    expect(carver.isEmbedded()).toBe(false);
    expect(() => {
      emitAll(carver);
      carver.configure({ targetOrigin: "https://carverjs.dev" });
      cleanups.push(carver.subscribe(() => {}));
      cleanups.push(carver.onInit(() => {}));
      emitAll(carver);
    }).not.toThrow();

    expect(sent).toEqual([]);
    expect(bridgeSent).toEqual([]);
    await expect(carver.getIdentity()).resolves.toEqual({
      ok: false,
      reason: "not-embedded",
    });
  });
});
