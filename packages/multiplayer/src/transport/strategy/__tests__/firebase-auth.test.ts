import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import type { FirebaseStrategyConfig, PeerMetadata } from "../types";

// ── Mock plumbing ───────────────────────────────────────────────────────────
//
// Everything the mock factories touch has to be created inside vi.hoisted(),
// because vi.mock() factories are lifted to the top of the module.
//
// The one non-obvious piece is `state.authImported`: it is set INSIDE the
// 'firebase/auth' factory, and a factory only runs when something actually
// imports the module. vi.resetModules() in beforeEach drops the module cache so
// the factory is armed again for every test. That flag is the proof that the
// anonymous path never pulls `firebase/auth` into the graph.

type Snapshot = { val: () => unknown; key: string | null; ref: unknown };
type ValueCb = (snap: Snapshot) => void;
type CancelCb = (error: Error) => void;

interface Registered {
  kind: "onValue" | "onChildAdded" | "onChildRemoved";
  path: string;
  cb: ValueCb;
  cancel: CancelCb | undefined;
}

const m = vi.hoisted(() => {
  const order: string[] = [];
  const listeners: Registered[] = [];
  const refs = new Map<string, { __path: string }>();

  const state = {
    /** Set by the 'firebase/auth' mock factory. */
    authImported: false,
    /** Live-read by the strategy through the Auth instance below. */
    currentUser: null as object | null,
    /** One entry consumed per set() call: an Error rejects, null resolves, and
     *  a promise hands the test control of when -- and how -- the write
     *  settles, which is the only way to hold a re-arm open mid-flight. */
    setQueue: [] as Array<Error | null | Promise<void>>,
    /** When set, onDisconnect().remove() parks on this instead of resolving,
     *  so a teardown or a rejoin can land inside an in-flight re-arm. */
    disconnectGate: null as Promise<void> | null,
  };

  const authInstance = {
    get currentUser(): object | null {
      return state.currentUser;
    },
  };

  const reset = (): void => {
    order.length = 0;
    listeners.length = 0;
    refs.clear();
    state.authImported = false;
    state.currentUser = null;
    state.setQueue.length = 0;
    state.disconnectGate = null;
  };

  // firebase/app
  const initializeApp = vi.fn((options: unknown, name?: string) => {
    order.push("initializeApp");
    return { name: name ?? "[DEFAULT]", options };
  });
  const getApps = vi.fn(() => [] as Array<{ name: string }>);
  const deleteApp = vi.fn(() => Promise.resolve());

  // firebase/auth
  const getAuth = vi.fn(() => {
    order.push("getAuth");
    return authInstance;
  });
  const signInWithCustomToken = vi.fn((_auth: unknown, _token: string) => {
    order.push("signIn");
    state.currentUser = { uid: "test-uid" };
    return Promise.resolve({ user: state.currentUser });
  });

  // firebase/database
  const getDatabase = vi.fn(() => {
    order.push("getDatabase");
    return { __db: true };
  });
  const ref = vi.fn((_db: unknown, path: string) => {
    order.push("ref");
    let r = refs.get(path);
    if (!r) {
      r = { __path: path };
      refs.set(path, r);
    }
    return r;
  });
  const set = vi.fn((_ref: unknown, _value: unknown): Promise<void> => {
    order.push("set");
    const next = state.setQueue.shift();
    if (next instanceof Error) return Promise.reject(next);
    return next ?? Promise.resolve();
  });
  const push = vi.fn(() => {
    order.push("push");
    return Promise.resolve({ key: "pushid" });
  });
  const remove = vi.fn(() => {
    order.push("remove");
    return Promise.resolve();
  });
  const onDisconnect = vi.fn(() => {
    order.push("onDisconnect");
    return { remove: (): Promise<void> => state.disconnectGate ?? Promise.resolve() };
  });

  const register =
    (kind: Registered["kind"]) =>
    (target: { __path: string }, cb: ValueCb, cancel?: CancelCb) => {
      order.push(kind);
      listeners.push({ kind, path: target.__path, cb, cancel });
      return () => {};
    };

  const onValue = vi.fn(register("onValue"));
  const onChildAdded = vi.fn(register("onChildAdded"));
  const onChildRemoved = vi.fn(register("onChildRemoved"));

  return {
    order,
    listeners,
    state,
    reset,
    initializeApp,
    getApps,
    deleteApp,
    getAuth,
    signInWithCustomToken,
    getDatabase,
    ref,
    set,
    push,
    remove,
    onDisconnect,
    onValue,
    onChildAdded,
    onChildRemoved,
  };
});

vi.mock("firebase/app", () => ({
  initializeApp: m.initializeApp,
  getApps: m.getApps,
  deleteApp: m.deleteApp,
}));

vi.mock("firebase/auth", () => {
  // Executes only if something really imports this module.
  m.state.authImported = true;
  return { getAuth: m.getAuth, signInWithCustomToken: m.signInWithCustomToken };
});

vi.mock("firebase/database", () => ({
  getDatabase: m.getDatabase,
  ref: m.ref,
  set: m.set,
  push: m.push,
  remove: m.remove,
  onValue: m.onValue,
  onChildAdded: m.onChildAdded,
  onChildRemoved: m.onChildRemoved,
  onDisconnect: m.onDisconnect,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const DB_URL = "https://carver-test.firebaseio.com";
const API_KEY = "test-api-key";
const APP_ID = "gamegen/ns1";

function denied(message = "permission_denied at /gamegen/ns1"): Error & { code: string } {
  return Object.assign(new Error(message), { code: "PERMISSION_DENIED" });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Yield properly: `await Promise.resolve()` only drains microtasks, and the
 * strategy's `await import(...)` needs the event loop to reach its I/O phase.
 * setImmediate is deliberately left un-faked (see FAKE_TIMERS) so this still
 * turns the loop while the clock is mocked.
 */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Turn the event loop until `pred` holds. */
async function until(pred: () => boolean, label: string, ticks = 500): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (pred()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** Fake only the clock the backoff uses; setImmediate must stay real. */
const FAKE_TIMERS = { toFake: ["setTimeout", "clearTimeout"] as const };

/**
 * Fake timers cannot be installed before `init()`: resolving the strategy's
 * dynamic `import()`s needs real event-loop turns, which a faked clock plus a
 * drained microtask queue never gives them. So the provider installs the fake
 * clock on its own first call -- by then every module is loaded, and the
 * backoff sleep that follows is the first thing to touch setTimeout.
 *
 * `outcomes` is consumed one per call; the last entry repeats forever.
 */
let autoFakeClock = true;

function scriptedProvider(outcomes: ReadonlyArray<string | Error>): Mock<() => Promise<string>> {
  let i = 0;
  return vi.fn(() => {
    if (autoFakeClock && !vi.isFakeTimers()) {
      vi.useFakeTimers({ toFake: [...FAKE_TIMERS.toFake] });
    }
    const next = outcomes[Math.min(i, outcomes.length - 1)];
    i++;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
}

function listener(kind: Registered["kind"], pathFragment: string): Registered {
  const found = m.listeners.find((l) => l.kind === kind && l.path.includes(pathFragment));
  if (!found) throw new Error(`no ${kind} listener for path containing "${pathFragment}"`);
  return found;
}

/**
 * Most recent matching registration. Unsubscribing does not remove anything
 * from the mock's list, so after a rejoin `listener()` still hands back the
 * detached listener from the previous generation.
 */
function latest(kind: Registered["kind"], pathFragment: string): Registered {
  const all = m.listeners.filter((l) => l.kind === kind && l.path.includes(pathFragment));
  const found = all[all.length - 1];
  if (!found) throw new Error(`no ${kind} listener for path containing "${pathFragment}"`);
  return found;
}

/** Fire `.info/connected` with the given value. */
function drainConnection(value: unknown = true, reg?: Registered): void {
  (reg ?? listener("onValue", ".info/connected")).cb({ val: () => value, key: null, ref: null });
}

/** Fire a child listener with the snapshot RTDB would hand it. */
function fireChild(reg: Registered, value: unknown, key: string | null = "node"): void {
  reg.cb({ val: () => value, key, ref: { __path: `${reg.path}/${key}` } });
}

/** A well-formed id: the 20 URL-safe alphanumerics generatePeerId() emits. */
const PEER_A = "AbCdEfGhIjKlMnOpQrSt";

/**
 * Everything a co-player can leave in a presence node or a signal that is NOT
 * a peer id. `undefined` models a stripped key -- a partial delete, which no
 * `.validate` rule catches because RTDB skips validation on deletes -- and the
 * last entry is the right length but outside the alphabet.
 */
const NOT_PEER_IDS: readonly unknown[] = [
  undefined,
  "",
  42,
  { nested: true },
  "tooshort",
  "AbCdEfGhIjKlMnOpQr-t",
];

/** Settle a promise without ever leaving it momentarily unhandled. */
function settle(p: Promise<void>): Promise<Error | null> {
  return p.then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  );
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe("FirebaseStrategy auth", () => {
  let FirebaseStrategy: typeof import("../firebase").FirebaseStrategy;

  beforeEach(async () => {
    vi.useRealTimers();
    autoFakeClock = true;
    vi.resetModules(); // re-arms the 'firebase/auth' factory flag
    vi.clearAllMocks();
    m.reset();
    ({ FirebaseStrategy } = await import("../firebase"));
  });

  function make(overrides: Partial<FirebaseStrategyConfig> = {}) {
    const onAuthError = vi.fn();
    const config: FirebaseStrategyConfig = {
      type: "firebase",
      databaseURL: DB_URL,
      onAuthError,
      ...overrides,
    };
    return { strategy: new FirebaseStrategy(APP_ID, config), onAuthError };
  }

  // (a) ─────────────────────────────────────────────────────────────────────
  describe("anonymous path", () => {
    it("never imports firebase/auth and initializes with databaseURL alone", async () => {
      const { strategy, onAuthError } = make();

      await strategy.init();

      expect(m.state.authImported).toBe(false);
      expect(m.getAuth).not.toHaveBeenCalled();
      expect(m.signInWithCustomToken).not.toHaveBeenCalled();
      expect(onAuthError).not.toHaveBeenCalled();

      expect(m.initializeApp).toHaveBeenCalledTimes(1);
      const [options, name] = m.initializeApp.mock.calls[0];
      // Exact shape: an `apiKey: undefined` key would change app identity.
      expect(options).toEqual({ databaseURL: DB_URL });
      expect(Object.keys(options as object)).toEqual(["databaseURL"]);
      expect(name).toBe(`carver_${APP_ID}`);

      expect(m.getDatabase).toHaveBeenCalledTimes(1);
      expect(m.order).not.toContain("signIn");
    });

    it("stays anonymous through a full join", async () => {
      const { strategy } = make();
      await strategy.init();
      await strategy.joinRoom("room-1", { displayName: "p1" });

      expect(m.state.authImported).toBe(false);
      expect(m.set).toHaveBeenCalledTimes(1);
      expect(m.listeners.length).toBe(5);
    });
  });

  // (b) ─────────────────────────────────────────────────────────────────────
  describe("auth path ordering", () => {
    it("signs in before getDatabase and before any ref()", async () => {
      const provider = vi.fn(() => Promise.resolve("custom-token"));
      const { strategy, onAuthError } = make({ authTokenProvider: provider, apiKey: API_KEY });

      await strategy.init();
      // joinRoom is what makes ref() calls exist at all, so the "no ref before
      // sign-in" claim has something to bite on.
      await strategy.joinRoom("room-1", {});

      expect(m.state.authImported).toBe(true);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(m.signInWithCustomToken).toHaveBeenCalledTimes(1);
      expect(m.signInWithCustomToken.mock.calls[0][1]).toBe("custom-token");
      expect(onAuthError).not.toHaveBeenCalled();

      const signInIdx = m.order.indexOf("signIn");
      const dbIdx = m.order.indexOf("getDatabase");
      const refIdx = m.order.indexOf("ref");

      expect(signInIdx).toBeGreaterThanOrEqual(0);
      expect(dbIdx).toBeGreaterThan(signInIdx);
      expect(refIdx).toBeGreaterThan(signInIdx);
      // getAuth itself must also precede the RTDB handle.
      expect(m.order.indexOf("getAuth")).toBeLessThan(dbIdx);

      expect(m.initializeApp.mock.calls[0][0]).toEqual({
        databaseURL: DB_URL,
        apiKey: API_KEY,
      });
    });
  });

  // (c) ─────────────────────────────────────────────────────────────────────
  describe("missing apiKey", () => {
    it("rejects init before touching firebase/auth", async () => {
      const provider = vi.fn(() => Promise.resolve("custom-token"));
      const { strategy, onAuthError } = make({ authTokenProvider: provider });

      const err = await settle(strategy.init());

      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toMatch(/apiKey/);
      expect(onAuthError).toHaveBeenCalledTimes(1);
      expect(onAuthError.mock.calls[0][0]).toBe(err);

      expect(m.state.authImported).toBe(false);
      expect(m.getAuth).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(m.getDatabase).not.toHaveBeenCalled();
    });

    it("does not require apiKey when the caller supplies the app", async () => {
      const provider = vi.fn(() => Promise.resolve("custom-token"));
      const { strategy, onAuthError } = make({
        authTokenProvider: provider,
        firebaseApp: { name: "caller-app" },
      });

      await strategy.init();

      expect(onAuthError).not.toHaveBeenCalled();
      expect(m.initializeApp).not.toHaveBeenCalled();
      expect(m.signInWithCustomToken).toHaveBeenCalledTimes(1);
    });
  });

  // (d) ─────────────────────────────────────────────────────────────────────
  describe("initial sign-in retries", () => {
    it("tries exactly 4 times over 250/1000/4000ms then fails", async () => {
      const boom = new Error("token endpoint down");
      const provider = scriptedProvider([boom]);
      const { strategy, onAuthError } = make({ authTokenProvider: provider, apiKey: API_KEY });

      const settled = settle(strategy.init());

      // Attempt 1 runs with no delay (and installs the fake clock).
      await until(() => provider.mock.calls.length === 1, "first sign-in attempt");
      expect(vi.isFakeTimers()).toBe(true);

      for (const [delay, expected] of [
        [250, 2],
        [1000, 3],
        [4000, 4],
      ] as const) {
        // Just short of the delay: still parked.
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(provider).toHaveBeenCalledTimes(expected - 1);
        await vi.advanceTimersByTimeAsync(1);
        await until(() => provider.mock.calls.length === expected, `attempt ${expected}`);
      }

      await vi.advanceTimersByTimeAsync(60_000); // nothing left to fire
      const err = await settled;
      vi.useRealTimers();

      expect(provider).toHaveBeenCalledTimes(4);
      expect(err).toBeInstanceOf(Error);
      // The last failure is wrapped, not handed back raw: the message has to
      // say this was sign-in giving up rather than one provider hiccup.
      const failure = err as Error & { cause?: unknown };
      expect(failure.message).toContain("sign-in failed after retries");
      expect(failure.message).toContain(boom.message);
      expect(failure.cause).toBe(boom);
      expect(onAuthError).toHaveBeenCalledTimes(1);
      expect(onAuthError.mock.calls[0][0]).toBe(err);
      // No RTDB handle is ever created when sign-in fails.
      expect(m.getDatabase).not.toHaveBeenCalled();
      expect(m.signInWithCustomToken).not.toHaveBeenCalled();
    });

    it("recovers when the provider fails twice then succeeds", async () => {
      const provider = scriptedProvider([
        new Error("transient"),
        new Error("transient"),
        "good-token",
      ]);
      const { strategy, onAuthError } = make({ authTokenProvider: provider, apiKey: API_KEY });

      const settled = settle(strategy.init());
      await until(() => provider.mock.calls.length === 1, "attempt 1");
      await vi.advanceTimersByTimeAsync(250);
      await until(() => provider.mock.calls.length === 2, "attempt 2");
      await vi.advanceTimersByTimeAsync(1000);
      await until(() => provider.mock.calls.length === 3, "attempt 3");
      const err = await settled;
      vi.useRealTimers();

      expect(err).toBeNull();
      expect(provider).toHaveBeenCalledTimes(3);
      expect(m.signInWithCustomToken).toHaveBeenCalledTimes(1);
      expect(m.signInWithCustomToken.mock.calls[0][1]).toBe("good-token");
      expect(onAuthError).not.toHaveBeenCalled();
      expect(m.getDatabase).toHaveBeenCalledTimes(1);
    });
  });

  // (e) ─────────────────────────────────────────────────────────────────────
  describe("retry after a failed init", () => {
    it("does not cache the rejected init promise", async () => {
      const provider = scriptedProvider([
        new Error("token endpoint down"),
        new Error("token endpoint down"),
        new Error("token endpoint down"),
        new Error("token endpoint down"),
        "late-token",
      ]);
      const { strategy, onAuthError } = make({ authTokenProvider: provider, apiKey: API_KEY });

      const first = settle(strategy.init());
      await until(() => provider.mock.calls.length === 1, "attempt 1");
      for (const delay of [250, 1000, 4000]) await vi.advanceTimersByTimeAsync(delay);
      expect(await first).toBeInstanceOf(Error);
      expect(provider).toHaveBeenCalledTimes(4);
      expect(m.getDatabase).not.toHaveBeenCalled();

      // A later join must be able to retry: _initPromise was not cached.
      autoFakeClock = false;
      vi.useRealTimers();
      expect(await settle(strategy.init())).toBeNull();

      expect(provider).toHaveBeenCalledTimes(5);
      expect(m.signInWithCustomToken).toHaveBeenCalledTimes(1);
      expect(onAuthError).toHaveBeenCalledTimes(1); // only the first init failed
      expect(m.getDatabase).toHaveBeenCalledTimes(1);
    });
  });

  // Shared setup for the reconnection tests: a joined, authenticated strategy.
  async function joined(tokenSource: () => Promise<string>) {
    const provider = vi.fn(() => tokenSource());
    const { strategy, onAuthError } = make({ authTokenProvider: provider, apiKey: API_KEY });
    await strategy.init();
    await strategy.joinRoom("room-1", { displayName: "p1" });
    return { strategy, provider, onAuthError };
  }

  // (f) ─────────────────────────────────────────────────────────────────────
  describe("permission denied on presence re-arm", () => {
    it("re-auths once and retries the write once", async () => {
      const { strategy, provider, onAuthError } = await joined(() => Promise.resolve("tok"));
      expect(m.set).toHaveBeenCalledTimes(1); // the join write
      provider.mockClear();
      m.signInWithCustomToken.mockClear();
      m.set.mockClear();

      m.state.setQueue.push(denied()); // the re-arm write is denied once
      drainConnection(true);

      await vi.waitFor(() => expect(m.set).toHaveBeenCalledTimes(2));
      await flush();

      expect(provider).toHaveBeenCalledTimes(1);
      expect(m.signInWithCustomToken).toHaveBeenCalledTimes(1);
      expect(m.set).toHaveBeenCalledTimes(2); // denied + successful retry
      // `results[i].type` is "return" for a rejected promise too, so it said
      // nothing about the retry. Settle the promise the strategy awaited, and
      // check the presence node it restored is the one peers look for.
      await expect(m.set.mock.results[1].value as Promise<void>).resolves.toBeUndefined();
      const [retryRef, retryValue] = m.set.mock.calls[1];
      expect((retryRef as { __path: string }).__path).toBe(
        `${APP_ID}/__carver__/rooms/room-1/peers/${strategy.selfId}`,
      );
      expect(retryValue).toEqual({
        peerId: strategy.selfId,
        meta: { displayName: "p1" },
        ts: expect.any(Number),
      });
      expect(onAuthError).not.toHaveBeenCalled(); // recovered on its own
    });

    it("reports through onAuthError when the retry is denied too", async () => {
      const { provider, onAuthError } = await joined(() => Promise.resolve("tok"));
      provider.mockClear();
      m.set.mockClear();

      m.state.setQueue.push(denied(), denied());
      drainConnection(true);

      await vi.waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
      expect(provider).toHaveBeenCalledTimes(1);
      expect(m.set).toHaveBeenCalledTimes(2);
    });
  });

  // (g) ─────────────────────────────────────────────────────────────────────
  describe("burst of permission_denied", () => {
    it("runs exactly one re-auth cycle for the whole burst", async () => {
      const gate = deferred<string>();
      let source: () => Promise<string> = () => Promise.resolve("tok");
      const { provider, onAuthError } = await joined(() => source());
      provider.mockClear();
      m.signInWithCustomToken.mockClear();
      m.set.mockClear();

      // Next token request parks until we open the gate, so every event in the
      // burst lands while the same cycle is still in flight.
      source = () => gate.promise;

      // Event 1 + 2: two cancelled room listeners.
      listener("onChildAdded", "/peers").cancel?.(denied());
      listener("onChildRemoved", "/peers").cancel?.(denied());
      // Event 3: a denied presence write on reconnect.
      m.state.setQueue.push(denied());
      drainConnection(true);

      await flush(10);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(m.signInWithCustomToken).not.toHaveBeenCalled();

      gate.resolve("fresh-token");
      await vi.waitFor(() => expect(m.set).toHaveBeenCalledTimes(2));
      await flush(10);

      expect(provider).toHaveBeenCalledTimes(1);
      expect(m.signInWithCustomToken).toHaveBeenCalledTimes(1);
      // The two cancellations are still surfaced to the app.
      expect(onAuthError).toHaveBeenCalledTimes(2);
    });
  });

  // (h) ─────────────────────────────────────────────────────────────────────
  describe("failed re-auth latch", () => {
    it("latches per connection and clears on the next .info/connected", async () => {
      let source: () => Promise<string> = () => Promise.resolve("tok");
      const { provider, onAuthError } = await joined(() => source());
      provider.mockClear();
      m.signInWithCustomToken.mockClear();

      source = () => Promise.reject(new Error("token endpoint down"));

      // First denial: one cycle, which fails.
      listener("onChildAdded", "/peers").cancel?.(denied());
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
      await flush(10);
      expect(onAuthError).toHaveBeenCalledTimes(2); // cancellation + re-auth failure

      // Second denial on the SAME connection: latched, no provider call.
      listener("onChildRemoved", "/peers").cancel?.(denied());
      await flush(10);
      expect(provider).toHaveBeenCalledTimes(1);

      // A new connection clears the latch.
      drainConnection(true);
      await flush(10);
      expect(provider).toHaveBeenCalledTimes(1); // currentUser is still set, no re-auth needed

      source = () => Promise.resolve("fresh");
      listener("onChildAdded", "/signals").cancel?.(denied());
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(2));
      expect(m.signInWithCustomToken).toHaveBeenCalledTimes(1);
    });
  });

  /** A snapshot of our own presence node, as onValue would deliver it. */
  const snapshot = (value: unknown): Snapshot => ({ val: () => value, key: null, ref: {} });

  // Presence self-defence ────────────────────────────────────────────────────
  // A room-scoped token lets every member of a room write anywhere in it, so a
  // co-player can delete our presence node. Nothing about that looks like an
  // error: the write succeeds, no permission_denied fires, and our own RTDB
  // connection never drops -- so the `.info/connected` re-arm never runs and,
  // without this, we would stay invisible for the rest of the session.
  describe("own presence node deleted by another player", () => {
    it("puts the node back so other peers rediscover us", async () => {
      const { strategy } = await joined(() => Promise.resolve("tok"));
      m.set.mockClear();

      const self = listener("onValue", `peers/${strategy.selfId}`);
      expect(self, "the strategy must watch its own presence node").toBeTruthy();

      // A co-player removes it. The engine sees the value go to null.
      self.cb(snapshot(null));
      await flush(10);

      expect(m.set).toHaveBeenCalledTimes(1);
      const [, written] = m.set.mock.calls[0];
      expect(written).toMatchObject({ peerId: strategy.selfId });
      expect(typeof (written as { ts: unknown }).ts).toBe("number");
    });

    it("does nothing while the node is present", async () => {
      const { strategy } = await joined(() => Promise.resolve("tok"));
      m.set.mockClear();
      listener("onValue", `peers/${strategy.selfId}`).cb(
        snapshot({ peerId: strategy.selfId, ts: 1 }),
      );
      await flush(10);
      expect(m.set).not.toHaveBeenCalled();
    });

    it("does not resurrect presence after leaveRoom detaches the listener", async () => {
      const { strategy } = await joined(() => Promise.resolve("tok"));
      const self = listener("onValue", `peers/${strategy.selfId}`);
      await strategy.leaveRoom();
      m.set.mockClear();

      // leaveRoom() unsubscribes before it removes the node, so a real SDK
      // would never deliver this. Drive it anyway: the staleness guards must
      // hold even if it did, or leaving a room would write presence back.
      self.cb(snapshot(null));
      await flush(10);
      expect(m.set).not.toHaveBeenCalled();
    });
  });

  // (i) ─────────────────────────────────────────────────────────────────────
  describe("listener cancel callbacks", () => {
    it("passes a cancel callback for every rules-governed listener", async () => {
      const { strategy, onAuthError } = await joined(() => Promise.resolve("tok"));
      strategy.subscribeToLobby(() => {});
      await vi.waitFor(() => expect(m.listeners.length).toBe(6));

      const rules = m.listeners.filter((l) => !l.path.startsWith(".info/"));
      expect(rules.length).toBe(5);
      for (const l of rules) {
        expect(typeof l.cancel, `${l.kind} ${l.path}`).toBe("function");
      }
      // The pseudo-path heartbeat is never cancelled, so it needs none.
      expect(listener("onValue", ".info/connected").cancel).toBeUndefined();

      // Every kind is represented on the room paths.
      expect(m.listeners.map((l) => `${l.kind}:${l.path.split("/").slice(-2).join("/")}`)).toEqual([
        "onValue:.info/connected",
        `onValue:peers/${strategy.selfId}`,
        "onChildAdded:room-1/peers",
        "onChildRemoved:room-1/peers",
        `onChildAdded:signals/${strategy.selfId}`,
        "onValue:__carver__/lobby",
      ]);

      // The reported error must name WHICH listener died -- the app's only
      // recovery is to rejoin, so a bare permission_denied is not actionable --
      // while keeping the original as `cause` and its `code` for branching.
      const error = denied();
      listener("onChildRemoved", "/peers").cancel?.(error);
      expect(onAuthError).toHaveBeenCalledTimes(1);
      const reported = onAuthError.mock.calls[0][0] as Error & { cause?: unknown; code?: string };
      expect(reported).not.toBe(error);
      expect(reported.message).toContain("peers left");
      expect(reported.message).toContain(error.message);
      expect(reported.cause).toBe(error);
      expect(reported.code).toBe(error.code);
    });

    it("reports a cancelled lobby without re-authenticating", async () => {
      const { strategy, provider, onAuthError } = await joined(() => Promise.resolve("tok"));
      strategy.subscribeToLobby(() => {});
      await vi.waitFor(() => expect(m.listeners.length).toBe(6));
      provider.mockClear();

      listener("onValue", "__carver__/lobby").cancel?.(denied());
      await flush(10);

      expect(onAuthError).toHaveBeenCalledTimes(1);
      expect(provider).not.toHaveBeenCalled();
    });
  });

  // (j) ─────────────────────────────────────────────────────────────────────
  describe("auth active but signed out", () => {
    it("re-auths before attempting the presence write", async () => {
      const { provider, onAuthError } = await joined(() => Promise.resolve("tok"));
      provider.mockClear();
      m.signInWithCustomToken.mockClear();
      m.set.mockClear();
      m.order.length = 0;

      m.state.currentUser = null; // session dropped while disconnected
      drainConnection(true);

      await vi.waitFor(() => expect(m.set).toHaveBeenCalledTimes(1));
      await flush();

      expect(provider).toHaveBeenCalledTimes(1);
      expect(m.signInWithCustomToken).toHaveBeenCalledTimes(1);

      const signInIdx = m.order.indexOf("signIn");
      expect(signInIdx).toBeGreaterThanOrEqual(0);
      expect(m.order.indexOf("onDisconnect")).toBeGreaterThan(signInIdx);
      expect(m.order.indexOf("set")).toBeGreaterThan(signInIdx);
      expect(onAuthError).not.toHaveBeenCalled();
    });

    it("skips the presence write entirely when the re-auth fails", async () => {
      let source: () => Promise<string> = () => Promise.resolve("tok");
      const { provider, onAuthError } = await joined(() => source());
      provider.mockClear();
      m.set.mockClear();

      m.state.currentUser = null;
      source = () => Promise.reject(new Error("token endpoint down"));
      drainConnection(true);

      await vi.waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
      await flush(10);

      expect(provider).toHaveBeenCalledTimes(1);
      expect(m.set).not.toHaveBeenCalled();
    });
  });

  // (k) ─────────────────────────────────────────────────────────────────────
  //
  // `_rearmPresence` re-checks staleness after every await because each await
  // is a window in which the join it belongs to can be superseded. A write that
  // lands after that window re-creates a presence node nobody will ever clean
  // up -- its onDisconnect was armed on a connection the strategy has left --
  // so the room keeps a ghost player until the node expires with the tab.
  describe("stale re-arm guards", () => {
    it("does not touch presence when destroy() lands during the re-auth", async () => {
      const gate = deferred<string>();
      let source: () => Promise<string> = () => Promise.resolve("tok");
      const { strategy, provider } = await joined(() => source());
      provider.mockClear();
      m.set.mockClear();
      m.onDisconnect.mockClear();

      source = () => gate.promise;
      m.state.currentUser = null; // forces the re-auth that precedes the write
      drainConnection(true);
      await until(() => provider.mock.calls.length === 1, "re-auth in flight");

      strategy.destroy();
      gate.resolve("fresh");
      await flush(10);

      // Not even the onDisconnect re-arm: destroy() already removed presence,
      // and re-arming here would resurrect the node it just deleted.
      expect(m.onDisconnect).not.toHaveBeenCalled();
      expect(m.set).not.toHaveBeenCalled();
    });

    it("does not write presence when destroy() lands during the onDisconnect re-arm", async () => {
      const gate = deferred<void>();
      const { strategy } = await joined(() => Promise.resolve("tok"));
      m.set.mockClear();
      m.onDisconnect.mockClear();
      m.state.disconnectGate = gate.promise;

      drainConnection(true);
      await until(() => m.onDisconnect.mock.calls.length === 1, "re-arm parked");

      strategy.destroy();
      gate.resolve();
      await flush(10);

      expect(m.set).not.toHaveBeenCalled();
    });

    it("drops a re-arm from a superseded join and leaves the new one working", async () => {
      const gate = deferred<void>();
      const { strategy } = await joined(() => Promise.resolve("tok"));
      m.set.mockClear();
      m.onDisconnect.mockClear();
      m.state.disconnectGate = gate.promise;

      drainConnection(true);
      await until(() => m.onDisconnect.mock.calls.length === 1, "old re-arm parked");
      m.state.disconnectGate = null; // only the parked re-arm stays held

      // The StrictMode double-mount: same room, new generation. _roomId ends up
      // identical, so the generation counter is the only thing that can tell
      // the in-flight re-arm it no longer speaks for this join.
      await strategy.leaveRoom();
      await strategy.joinRoom("room-1", { displayName: "p2" });
      const joinWrites = m.set.mock.calls.length;

      gate.resolve();
      await flush(10);
      expect(m.set).toHaveBeenCalledTimes(joinWrites);

      // The live generation still re-arms, with its own meta.
      drainConnection(true, latest("onValue", ".info/connected"));
      await vi.waitFor(() => expect(m.set).toHaveBeenCalledTimes(joinWrites + 1));
      expect(m.set.mock.calls[joinWrites][1]).toEqual({
        peerId: strategy.selfId,
        meta: { displayName: "p2" },
        ts: expect.any(Number),
      });

      // ...and so does its peers listener.
      const discovered: string[] = [];
      strategy.onPeerDiscovered((id) => discovered.push(id));
      fireChild(latest("onChildAdded", "/peers"), { peerId: PEER_A, meta: {} }, PEER_A);
      expect(discovered).toEqual([PEER_A]);
    });

    it("does not re-arm presence for a room the strategy has already left", async () => {
      const gate = deferred<void>();
      const { strategy } = await joined(() => Promise.resolve("tok"));
      m.set.mockClear();
      m.onDisconnect.mockClear();
      m.state.disconnectGate = gate.promise;

      drainConnection(true);
      await until(() => m.onDisconnect.mock.calls.length === 1, "re-arm parked");
      m.state.disconnectGate = null;

      // leaveRoom() without a rejoin: the generation never moves, so _roomId is
      // the only guard left holding.
      await strategy.leaveRoom();
      gate.resolve();
      await flush(10);

      expect(m.set).not.toHaveBeenCalled();
    });

    it("does not re-auth for a denial that arrives after the room was left", async () => {
      const write = deferred<void>();
      const { strategy, provider } = await joined(() => Promise.resolve("tok"));
      provider.mockClear();
      m.set.mockClear();
      m.state.setQueue.push(write.promise);

      drainConnection(true);
      await until(() => m.set.mock.calls.length === 1, "re-arm write in flight");

      await strategy.leaveRoom();
      write.reject(denied());
      await flush(10);

      // A denial for a room we have left says nothing about the token, so it
      // must not spend a re-auth cycle or repeat the write.
      expect(provider).not.toHaveBeenCalled();
      expect(m.set).toHaveBeenCalledTimes(1);
    });

    it("does not retry the presence write when the room is left during the re-auth", async () => {
      const gate = deferred<string>();
      let source: () => Promise<string> = () => Promise.resolve("tok");
      const { strategy, provider } = await joined(() => source());
      provider.mockClear();
      m.set.mockClear();
      m.onDisconnect.mockClear();

      source = () => gate.promise;
      m.state.setQueue.push(denied());
      drainConnection(true);
      await until(() => provider.mock.calls.length === 1, "re-auth after the denial");

      await strategy.leaveRoom();
      gate.resolve("fresh");
      await flush(10);

      expect(m.set).toHaveBeenCalledTimes(1); // denied once, never retried
      expect(m.onDisconnect).toHaveBeenCalledTimes(1);
    });
  });

  // (l) ─────────────────────────────────────────────────────────────────────
  //
  // Anything reaching these listeners was written by another room member, so
  // the peer id in it is untrusted input, not a schema guarantee.
  describe("listener payload guards", () => {
    /** A joined anonymous strategy plus recorders for the three peer callbacks. */
    async function wired() {
      const { strategy } = make();
      await strategy.init();
      await strategy.joinRoom("room-1", {});
      const discovered: Array<[string, PeerMetadata]> = [];
      const left: string[] = [];
      const signals: Array<[string, unknown]> = [];
      strategy.onPeerDiscovered((id, meta) => discovered.push([id, meta]));
      strategy.onPeerLeft((id) => left.push(id));
      strategy.onSignal((from, data) => signals.push([from, data]));
      return { strategy, discovered, left, signals };
    }

    it("ignores a presence node whose peerId is not a peer id", async () => {
      const { discovered, left } = await wired();

      const added = listener("onChildAdded", "/peers");
      for (const peerId of NOT_PEER_IDS) {
        fireChild(added, { peerId, meta: { displayName: "ghost" } }, PEER_A);
      }
      expect(discovered).toEqual([]);

      // And it never entered _knownPeers: removing the same node falls back to
      // its key, which IS well-formed and would evict if the add had landed.
      fireChild(listener("onChildRemoved", "/peers"), null, PEER_A);
      expect(left).toEqual([]);
    });

    it("does not fire onPeerLeft for a node that was never a known peer", async () => {
      const { discovered, left } = await wired();
      const removed = listener("onChildRemoved", "/peers");

      fireChild(removed, { peerId: "" }, "not-a-peer-id");
      fireChild(removed, null, null);
      fireChild(removed, { peerId: PEER_A }, PEER_A); // well-formed, never seen

      expect(left).toEqual([]);
      expect(discovered).toEqual([]);
    });

    it("drops a signal whose `from` is not a peer id", async () => {
      const { signals } = await wired();

      const inbox = listener("onChildAdded", "/signals");
      for (const from of NOT_PEER_IDS) fireChild(inbox, { from, data: { sdp: "offer" } }, "sig");

      expect(signals).toEqual([]);
    });

    it("still discovers a well-formed peer and delivers its signal", async () => {
      const { strategy, discovered, left, signals } = await wired();
      m.remove.mockClear();

      fireChild(
        listener("onChildAdded", "/peers"),
        { peerId: PEER_A, meta: { displayName: "p2" } },
        PEER_A,
      );
      expect(discovered).toEqual([[PEER_A, { displayName: "p2" }]]);

      fireChild(listener("onChildAdded", "/signals"), { from: PEER_A, data: { sdp: "offer" } }, "s1");
      expect(signals).toEqual([[PEER_A, { sdp: "offer" }]]);
      expect(m.remove).toHaveBeenCalledTimes(1); // processed signals leave the inbox

      fireChild(listener("onChildRemoved", "/peers"), { peerId: PEER_A }, PEER_A);
      expect(left).toEqual([PEER_A]);

      // The guard is only safe while it matches what we ourselves publish.
      expect(strategy.selfId).toMatch(/^[A-Za-z0-9]{20}$/);
    });
  });

  // Anonymous strategies must not gain any of the above behaviour.
  describe("anonymous reconnection", () => {
    it("re-arms presence without ever reaching for a token", async () => {
      const { strategy, onAuthError } = make();
      await strategy.init();
      await strategy.joinRoom("room-1", {});
      m.set.mockClear();

      m.state.setQueue.push(denied());
      drainConnection(true);
      await flush(10);

      expect(m.state.authImported).toBe(false);
      // No provider means no token to refresh, so a denied write is NOT retried:
      // the retry only exists to follow a re-auth, and repeating the identical
      // write would be denied identically.
      expect(m.set).toHaveBeenCalledTimes(1);
      expect(m.getAuth).not.toHaveBeenCalled();
      expect(m.signInWithCustomToken).not.toHaveBeenCalled();
      expect(onAuthError).not.toHaveBeenCalled();

      listener("onChildAdded", "/peers").cancel?.(denied());
      expect(onAuthError).toHaveBeenCalledTimes(1); // still reported
      expect(m.state.authImported).toBe(false);
    });
  });
});
