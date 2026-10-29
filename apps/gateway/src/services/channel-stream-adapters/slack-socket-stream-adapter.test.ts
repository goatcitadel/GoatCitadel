import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { ChannelStreamAuthError, type ChannelStreamRunContext } from "../channel-stream-runtime-service.js";
import {
  HELLO_TIMEOUT_MS,
  OPEN_TIMEOUT_MS,
  QUIET_RECONNECT_MS,
  createSlackSocketStreamAdapter,
  type SlackSocketLike,
  type SlackSocketStreamAdapterDeps,
} from "./slack-socket-stream-adapter.js";

const APP_TOKEN = "xapp-1";
const SOCKET_URL = "wss://wss-primary.slack.com/link/?ticket=secret-ticket&app_id=A1";
const SECOND_SOCKET_URL = "wss://wss-backup.slack.com/link/?ticket=second-ticket&app_id=A1";

const NO_TOKEN = "Slack has no app-level token.";
const NOT_ALLOWED = "GoatCitadel isn't allowed to reach slack.com.";
const REJECTED_TOKEN = "Slack didn't accept the app-level token.";
const RATE_LIMITED = "Slack asked GoatCitadel to wait before connecting again.";
const CANT_OPEN = "Slack couldn't open a connection.";
const UNREACHABLE = "GoatCitadel couldn't reach Slack.";
const BAD_ADDRESS = "Slack returned an address GoatCitadel won't open.";
const LINK_DISABLED = "Slack turned Socket Mode off for this app.";
const CLOSED = "The connection to Slack closed.";

function connection(config: Record<string, unknown> = {}): IntegrationConnection {
  return {
    connectionId: "conn-1",
    revision: "r1",
    catalogId: "channel.slack",
    kind: "channel",
    key: "slack",
    label: "Slack",
    enabled: true,
    status: "connected",
    config: { receiveMode: "socket", appToken: APP_TOKEN, ...config },
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function opened(url = SOCKET_URL): Response {
  return json({ ok: true, url });
}

class FakeSocket implements SlackSocketLike {
  readonly sent: string[] = [];
  closeCalls = 0;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(
    readonly url: string,
    private readonly log: string[],
  ) {}

  send(data: string): void {
    if (this.closeCalls > 0) throw new Error(`socket is closed (${APP_TOKEN} ticket=secret-ticket)`);
    this.log.push(`ack:${data}`);
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  fire(type: "open" | "message" | "close" | "error", event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  frame(value: unknown): void {
    this.fire("message", { data: typeof value === "string" ? value : JSON.stringify(value) });
  }
}

interface RecordedOpen {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}

interface HarnessOptions {
  /** One answer per apps.connections.open call, in order; after they run out the call waits for its signal. */
  opens?: Array<() => Response | Promise<Response>>;
  token?: string | undefined;
  allowlisted?: boolean;
  processEvent?: (connectionId: string, payload: unknown) => Promise<unknown>;
}

function harness(options: HarnessOptions = {}) {
  const openQueue = [...(options.opens ?? [() => opened()])];
  const opens: RecordedOpen[] = [];
  const sockets: FakeSocket[] = [];
  const log: string[] = [];
  let controller = new AbortController();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    opens.push({
      url: String(input),
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      signal: init?.signal ?? undefined,
    });
    const answer = openQueue.shift();
    if (answer) return await answer();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        {
          once: true,
        },
      );
    });
  });
  const createWebSocket = vi.fn((url: string) => {
    const socket = new FakeSocket(url, log);
    sockets.push(socket);
    return socket;
  });
  const processEvent = vi.fn(async (connectionId: string, payload: unknown) => {
    log.push(`process:${(payload as { id?: string } | undefined)?.id ?? "?"}`);
    return options.processEvent ? await options.processEvent(connectionId, payload) : undefined;
  });
  const resolveSecret = vi.fn(() => ("token" in options ? options.token : APP_TOKEN));
  const deps: SlackSocketStreamAdapterDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    resolveSecret,
    isUrlAllowlisted: vi.fn(() => options.allowlisted ?? true),
    createWebSocket,
    processEvent,
  };
  const adapter = createSlackSocketStreamAdapter(deps);
  const markReady = vi.fn();
  const touch = vi.fn();
  const diagnostic = vi.fn();
  const handle = vi.fn(async (work: () => Promise<unknown>) => {
    await work();
  });
  function ctx(config?: Record<string, unknown>): ChannelStreamRunContext {
    controller = new AbortController();
    return {
      connection: connection(config),
      signal: controller.signal,
      cursor: undefined,
      markReady,
      touch,
      emit: vi.fn(async () => {
        throw new Error("the Slack adapter must not emit");
      }),
      handle,
      diagnostic,
    };
  }
  /** Starts a run and tracks how it ends, so a test can tell "still running" from "resolved" and "rejected". */
  function start(runCtx: ChannelStreamRunContext = ctx()) {
    const state: { value: "running" | "resolved" | "rejected"; error?: unknown } = { value: "running" };
    const done = adapter.run(runCtx).then(
      () => {
        state.value = "resolved";
      },
      (error: unknown) => {
        state.value = "rejected";
        state.error = error;
      },
    );
    return { state, done };
  }
  return {
    adapter,
    deps,
    fetchMock,
    opens,
    sockets,
    log,
    createWebSocket,
    processEvent,
    resolveSecret,
    markReady,
    touch,
    diagnostic,
    handle,
    ctx,
    start,
    abort: () => controller.abort(),
  };
}

/** Lets pending promise work (and one real macrotask) run. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** A promise a test settles by hand, to hold an event handler open. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function eventsApi(envelopeId: string, payload: unknown) {
  return { type: "events_api", envelope_id: envelopeId, payload, accepts_response_payload: false };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("slack socket stream adapter", () => {
  it("runs only for Socket Mode connections", () => {
    const { adapter } = harness();
    expect(adapter.channelKey).toBe("slack");
    expect(adapter.idleTimeoutMs).toBeUndefined();
    expect(adapter.isInboundEnabled(connection({ receiveMode: "socket" }))).toBe(true);
    expect(adapter.isInboundEnabled(connection({ receiveMode: "webhook" }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ receiveMode: undefined, signingSecret: "s" }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ receiveMode: undefined }))).toBe(false);
  });

  it("opens the address Slack returns and is ready on hello", async () => {
    const h = harness();
    const run = h.start();
    await until(() => h.sockets.length === 1, "the first socket");

    expect(h.resolveSecret).toHaveBeenCalledWith(
      expect.objectContaining({ appToken: APP_TOKEN }),
      "appToken",
      "appTokenEnv",
      "channel.slack",
      expect.objectContaining({ connectionId: "conn-1" }),
    );
    expect(h.opens).toHaveLength(1);
    expect(h.opens[0]).toMatchObject({
      url: "https://slack.com/api/apps.connections.open",
      method: "POST",
      headers: { Authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(h.createWebSocket).toHaveBeenCalledWith(SOCKET_URL);
    expect(h.markReady).not.toHaveBeenCalled();

    h.sockets[0]!.frame({ type: "hello", num_connections: 1 });
    expect(h.markReady).toHaveBeenCalledTimes(1);

    h.abort();
    await run.done;
    expect(run.state.value).toBe("resolved");
  });

  it("gives the open request a timeout that follows the session", async () => {
    const h = harness();
    const run = h.start();
    await until(() => h.sockets.length === 1, "the first socket");

    expect(OPEN_TIMEOUT_MS).toBe(15_000);
    const signal = h.opens[0]!.signal!;
    expect(signal.aborted).toBe(false);
    h.abort();
    await run.done;
    expect(signal.aborted).toBe(true);
  });

  it("handles an event, then acknowledges it", async () => {
    const gate = deferred();
    const h = harness({ processEvent: () => gate.promise });
    const run = h.start();
    await until(() => h.sockets.length === 1, "the first socket");
    const payload = { id: "P" };

    h.sockets[0]!.frame(eventsApi("e1", payload));
    await until(() => h.processEvent.mock.calls.length === 1, "the event to reach the handler");
    expect(h.processEvent).toHaveBeenCalledWith("conn-1", payload);
    expect(h.handle).toHaveBeenCalledTimes(1);
    // Not acknowledged while it is still being handled.
    expect(h.sockets[0]!.sent).toEqual([]);

    gate.resolve();
    await until(() => h.sockets[0]!.sent.length === 1, "the acknowledgement");
    expect(h.sockets[0]!.sent).toEqual(['{"envelope_id":"e1"}']);

    h.abort();
    await run.done;
  });

  it("handles two events in order, acknowledging each after its own handling", async () => {
    const first = deferred();
    const h = harness({
      processEvent: (_connectionId, payload) =>
        (payload as { id: string }).id === "A" ? first.promise : Promise.resolve(),
    });
    const run = h.start();
    await until(() => h.sockets.length === 1, "the first socket");

    h.sockets[0]!.frame(eventsApi("e1", { id: "A" }));
    h.sockets[0]!.frame(eventsApi("e2", { id: "B" }));
    await until(() => h.processEvent.mock.calls.length === 1, "the first event");
    await tick();
    // The second waits for the first.
    expect(h.processEvent).toHaveBeenCalledTimes(1);

    first.resolve();
    await until(() => h.sockets[0]!.sent.length === 2, "both acknowledgements");
    expect(h.log).toEqual(["process:A", 'ack:{"envelope_id":"e1"}', "process:B", 'ack:{"envelope_id":"e2"}']);

    h.abort();
    await run.done;
  });

  it("acknowledges commands and interactions without handling them", async () => {
    const gate = deferred();
    const h = harness({ processEvent: () => gate.promise });
    const run = h.start();
    await until(() => h.sockets.length === 1, "the first socket");

    // An event is still being handled; the others are answered at once.
    h.sockets[0]!.frame(eventsApi("e1", { id: "A" }));
    await until(() => h.processEvent.mock.calls.length === 1, "the event to reach the handler");
    h.sockets[0]!.frame({ type: "slash_commands", envelope_id: "c1", payload: { command: "/go" } });
    h.sockets[0]!.frame({ type: "interactive", envelope_id: "i1", payload: { type: "block_actions" } });
    h.sockets[0]!.frame({ type: "something_new", envelope_id: "n1", payload: {} });

    expect(h.sockets[0]!.sent).toEqual(['{"envelope_id":"c1"}', '{"envelope_id":"i1"}', '{"envelope_id":"n1"}']);
    expect(h.processEvent).toHaveBeenCalledTimes(1);
    expect(h.handle).toHaveBeenCalledTimes(1);

    gate.resolve();
    await until(() => h.sockets[0]!.sent.length === 4, "the event acknowledgement");
    h.abort();
    await run.done;
    expect(run.state.value).toBe("resolved");
  });

  it("touches on every frame and ignores frames it cannot read", async () => {
    const h = harness();
    const run = h.start();
    await until(() => h.sockets.length === 1, "the first socket");
    const socket = h.sockets[0]!;
    const touchesBefore = h.touch.mock.calls.length;

    socket.fire("message", { data: new Uint8Array([1, 2, 3]) });
    socket.fire("message", { data: "not json" });
    socket.fire("message", { data: "[1,2]" });
    socket.fire("message", {});
    socket.frame({ type: "events_api", payload: { id: "no-envelope" } });
    socket.frame({ type: "events_api", envelope_id: "", payload: {} });
    socket.frame({ type: "hello" });

    expect(h.touch.mock.calls.length - touchesBefore).toBe(7);
    expect(socket.sent).toEqual([]);
    expect(h.processEvent).not.toHaveBeenCalled();
    expect(h.markReady).toHaveBeenCalledTimes(1);

    h.abort();
    await run.done;
    expect(run.state.value).toBe("resolved");
  });

  it.each(["refresh_requested", "warning"])("reconnects at once when Slack sends %s", async (reason) => {
    const h = harness({ opens: [() => opened(SOCKET_URL), () => opened(SECOND_SOCKET_URL)] });
    const run = h.start();
    await until(() => h.sockets.length === 1, "the first socket");
    h.sockets[0]!.frame({ type: "hello" });

    h.sockets[0]!.frame({ type: "disconnect", reason, debug_info: { host: "applink-1" } });
    await until(() => h.sockets.length === 2, "the second socket");

    expect(h.sockets[0]!.closeCalls).toBeGreaterThan(0);
    expect(h.opens).toHaveLength(2);
    expect(h.opens[1]).toMatchObject({
      url: "https://slack.com/api/apps.connections.open",
      method: "POST",
      headers: { Authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(h.createWebSocket).toHaveBeenNthCalledWith(2, SECOND_SOCKET_URL);
    // The run neither rejected nor resolved: the runtime would back off on either.
    expect(run.state.value).toBe("running");

    h.sockets[1]!.frame({ type: "hello" });
    expect(h.markReady).toHaveBeenCalledTimes(2);

    h.abort();
    await run.done;
    expect(run.state.value).toBe("resolved");
    expect(h.sockets[1]!.closeCalls).toBeGreaterThan(0);
  });

  it("finishes an event in progress before it closes for a refresh", async () => {
    const gate = deferred();
    const h = harness({
      opens: [() => opened(SOCKET_URL), () => opened(SECOND_SOCKET_URL)],
      processEvent: () => gate.promise,
    });
    const run = h.start();
    await until(() => h.sockets.length === 1, "the first socket");

    h.sockets[0]!.frame(eventsApi("e1", { id: "A" }));
    await until(() => h.processEvent.mock.calls.length === 1, "the event to reach the handler");
    h.sockets[0]!.frame({ type: "disconnect", reason: "refresh_requested" });
    await tick();
    expect(h.sockets[0]!.closeCalls).toBe(0);
    expect(h.sockets).toHaveLength(1);

    gate.resolve();
    await until(() => h.sockets.length === 2, "the second socket");
    expect(h.sockets[0]!.sent).toEqual(['{"envelope_id":"e1"}']);
    expect(h.sockets[0]!.closeCalls).toBeGreaterThan(0);
    expect(run.state.value).toBe("running");

    h.abort();
    await run.done;
  });

  it("reconnects after an hour of quiet", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness({ opens: [() => opened(SOCKET_URL), () => opened(SECOND_SOCKET_URL)] });
    const run = h.start();
    await vi.advanceTimersByTimeAsync(0);
    await until(() => h.sockets.length === 1, "the first socket");
    h.sockets[0]!.frame({ type: "hello" });
    expect(QUIET_RECONNECT_MS).toBe(3_600_000);

    // A frame an hour in restarts the wait.
    await vi.advanceTimersByTimeAsync(QUIET_RECONNECT_MS - 60_000);
    h.sockets[0]!.frame({ type: "hello" });
    await vi.advanceTimersByTimeAsync(QUIET_RECONNECT_MS - 1);
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.closeCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await until(() => h.sockets.length === 2, "the second socket");
    expect(h.sockets[0]!.closeCalls).toBeGreaterThan(0);
    expect(h.opens).toHaveLength(2);
    expect(h.createWebSocket).toHaveBeenNthCalledWith(2, SECOND_SOCKET_URL);
    expect(run.state.value).toBe("running");

    h.abort();
    await run.done;
    expect(run.state.value).toBe("resolved");
    // The new socket's timer is gone with the run.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the run when Slack sends no hello within 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    const run = h.start();
    await vi.advanceTimersByTimeAsync(0);
    await until(() => h.sockets.length === 1, "the first socket");
    expect(HELLO_TIMEOUT_MS).toBe(30_000);

    // A frame that is not hello does not count.
    await vi.advanceTimersByTimeAsync(10_000);
    h.sockets[0]!.frame({ type: "something_else" });
    await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS - 10_001);
    expect(run.state.value).toBe("running");
    expect(h.sockets[0]!.closeCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await run.done;
    expect(run.state.value).toBe("rejected");
    expect(run.state.error).toBeInstanceOf(Error);
    expect(run.state.error).not.toBeInstanceOf(ChannelStreamAuthError);
    expect((run.state.error as Error).message).toBe(CLOSED);
    expect(h.sockets[0]!.closeCalls).toBeGreaterThan(0);
    expect(h.opens).toHaveLength(1);
    expect(h.markReady).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a socket whose hello arrives in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    const run = h.start();
    await vi.advanceTimersByTimeAsync(0);
    await until(() => h.sockets.length === 1, "the first socket");

    await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS - 1);
    h.sockets[0]!.frame({ type: "hello" });
    await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS * 2);

    expect(run.state.value).toBe("running");
    expect(h.sockets[0]!.closeCalls).toBe(0);
    expect(h.opens).toHaveLength(1);
    expect(h.markReady).toHaveBeenCalledTimes(1);

    h.abort();
    await run.done;
    expect(run.state.value).toBe("resolved");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives a socket opened for a refresh its own hello deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness({ opens: [() => opened(SOCKET_URL), () => opened(SECOND_SOCKET_URL)] });
    const run = h.start();
    await vi.advanceTimersByTimeAsync(0);
    await until(() => h.sockets.length === 1, "the first socket");
    h.sockets[0]!.frame({ type: "hello" });
    await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS * 2);

    h.sockets[0]!.frame({ type: "disconnect", reason: "refresh_requested" });
    await until(() => h.sockets.length === 2, "the second socket");
    await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS - 1);
    expect(run.state.value).toBe("running");
    expect(h.sockets[1]!.closeCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await run.done;
    expect(run.state.value).toBe("rejected");
    expect((run.state.error as Error).message).toBe(CLOSED);
    expect(h.sockets[1]!.closeCalls).toBeGreaterThan(0);
    expect(h.opens).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops when Socket Mode is turned off", async () => {
    const h = harness();
    const run = h.start();
    await until(() => h.sockets.length === 1, "the first socket");

    h.sockets[0]!.frame({ type: "disconnect", reason: "link_disabled" });
    await run.done;

    expect(run.state.value).toBe("rejected");
    expect(run.state.error).toBeInstanceOf(Error);
    expect(run.state.error).not.toBeInstanceOf(ChannelStreamAuthError);
    expect((run.state.error as Error).message).toBe(LINK_DISABLED);
    expect(h.sockets[0]!.closeCalls).toBeGreaterThan(0);
    expect(h.opens).toHaveLength(1);
  });

  it.each([
    ["a host outside slack.com", "wss://evil.example/link"],
    ["a plain ws: address", "ws://wss.slack.com/x"],
    ["slack.com as a prefix of another host", "wss://slack.com.evil.example/x"],
    ["a host that only ends in slack.com", "wss://notslack.com/x"],
    ["bare slack.com", "wss://slack.com/x"],
    ["an https: address", "https://wss-primary.slack.com/x"],
    ["something that is not an address", "not a url"],
  ])("won't open %s", async (_label, address) => {
    const h = harness({ opens: [() => opened(address)] });
    const run = h.start();
    await run.done;

    expect(run.state.value).toBe("rejected");
    expect((run.state.error as Error).message).toBe(BAD_ADDRESS);
    expect(h.createWebSocket).not.toHaveBeenCalled();
  });

  it("ends quietly when the session is stopped while the address is being fetched", async () => {
    const h = harness({ opens: [] });
    const run = h.start();
    await until(() => h.opens.length === 1, "the open request");
    h.abort();
    await run.done;

    expect(run.state.value).toBe("resolved");
    expect(h.createWebSocket).not.toHaveBeenCalled();
  });

  it("closes the socket and ends quietly when the session is stopped", async () => {
    const h = harness();
    const run = h.start();
    await until(() => h.sockets.length === 1, "the first socket");
    h.sockets[0]!.frame({ type: "hello" });

    h.abort();
    await run.done;

    expect(run.state.value).toBe("resolved");
    expect(h.sockets[0]!.closeCalls).toBeGreaterThan(0);
    // The closing socket's own close event does not start another connection.
    h.sockets[0]!.fire("close");
    await tick();
    expect(h.opens).toHaveLength(1);
  });

  it("ends the run, without acknowledging, when handling an event fails", async () => {
    const failure = new Error("could not accept the event");
    const h = harness({ processEvent: async () => Promise.reject(failure) });
    const run = h.start();
    await until(() => h.sockets.length === 1, "the first socket");

    h.sockets[0]!.frame(eventsApi("e1", { id: "A" }));
    h.sockets[0]!.frame(eventsApi("e2", { id: "B" }));
    await run.done;

    expect(run.state.value).toBe("rejected");
    expect(run.state.error).toBe(failure);
    expect(h.sockets[0]!.sent).toEqual([]);
    expect(h.sockets[0]!.closeCalls).toBeGreaterThan(0);
    // The second event never reached the handler.
    expect(h.processEvent).toHaveBeenCalledTimes(1);
  });

  it("still ends the run, with a fixed sentence, if finishing a socket ever fails", async () => {
    const h = harness();
    const runCtx = h.ctx();
    const run = h.start(runCtx);
    await until(() => h.sockets.length === 1, "the first socket");

    runCtx.signal.removeEventListener = () => {
      throw new Error(`cleanup failed: ${APP_TOKEN} ticket=secret-ticket`);
    };
    h.sockets[0]!.frame({ type: "disconnect", reason: "refresh_requested" });
    await run.done;

    expect(run.state.value).toBe("rejected");
    const error = run.state.error as Error;
    expect(error.message).toBe(CLOSED);
    expect(error.cause).toBeUndefined();
    expect([error.message, error.stack ?? ""].join("\n")).not.toMatch(/xapp-1|ticket=/);
  });

  describe("failures", () => {
    const secretish = `leaked ${APP_TOKEN} wss://wss-primary.slack.com/link/?ticket=secret-ticket`;

    interface FailureCase {
      name: string;
      options: HarnessOptions;
      expected: string;
      auth: boolean;
      /** Drives the socket after it opens, for failures that happen on it. */
      onOpen?: (socket: FakeSocket) => void;
    }

    const authRejections = [
      "invalid_auth",
      "not_authed",
      "token_revoked",
      "token_expired",
      "account_inactive",
      "not_allowed_token_type",
      "missing_scope",
    ];

    const cases: FailureCase[] = [
      { name: "no app-level token", options: { token: undefined }, expected: NO_TOKEN, auth: true },
      { name: "slack.com isn't allowed", options: { allowlisted: false }, expected: NOT_ALLOWED, auth: false },
      ...authRejections.map(
        (code): FailureCase => ({
          name: `ok:false with ${code}`,
          options: { opens: [() => json({ ok: false, error: code })] },
          expected: REJECTED_TOKEN,
          auth: true,
        }),
      ),
      {
        name: "HTTP 429",
        options: { opens: [() => new Response(secretish, { status: 429, headers: { "retry-after": "30" } })] },
        expected: RATE_LIMITED,
        auth: false,
      },
      {
        name: "ok:false with ratelimited",
        options: { opens: [() => json({ ok: false, error: "ratelimited" })] },
        expected: RATE_LIMITED,
        auth: false,
      },
      {
        name: "any other ok:false",
        options: { opens: [() => json({ ok: false, error: secretish })] },
        expected: CANT_OPEN,
        auth: false,
      },
      {
        name: "ok:false with no error",
        options: { opens: [() => json({ ok: false })] },
        expected: CANT_OPEN,
        auth: false,
      },
      {
        name: "an HTTP error",
        options: { opens: [() => new Response(secretish, { status: 500 })] },
        expected: CANT_OPEN,
        auth: false,
      },
      {
        name: "a reply that is not JSON",
        options: { opens: [() => new Response(`<html>${secretish}</html>`, { status: 200 })] },
        expected: CANT_OPEN,
        auth: false,
      },
      {
        name: "a reply that breaks off while it is read",
        options: {
          opens: [
            () =>
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.error(new Error(`stream failed: ${secretish}`));
                  },
                }),
                { status: 200 },
              ),
          ],
        },
        expected: UNREACHABLE,
        auth: false,
      },
      {
        name: "ok:true with no address",
        options: { opens: [() => json({ ok: true })] },
        expected: CANT_OPEN,
        auth: false,
      },
      {
        name: "a network failure that quotes the request",
        options: {
          opens: [
            () => {
              throw new TypeError(`fetch failed: POST https://slack.com/api/apps.connections.open with ${secretish}`);
            },
          ],
        },
        expected: UNREACHABLE,
        auth: false,
      },
      {
        name: "an address outside slack.com",
        options: { opens: [() => opened("wss://evil.example/link?ticket=secret-ticket")] },
        expected: BAD_ADDRESS,
        auth: false,
      },
      {
        name: "link_disabled",
        options: {},
        expected: LINK_DISABLED,
        auth: false,
        onOpen: (socket) => socket.frame({ type: "disconnect", reason: "link_disabled" }),
      },
      {
        name: "a close without a disconnect",
        options: {},
        expected: CLOSED,
        auth: false,
        onOpen: (socket) => socket.fire("close"),
      },
      {
        name: "an error event that quotes the address",
        options: {},
        expected: CLOSED,
        auth: false,
        onOpen: (socket) => socket.fire("error", { data: secretish }),
      },
      {
        name: "a disconnect with a reason it doesn't know",
        options: {},
        expected: CLOSED,
        auth: false,
        onOpen: (socket) => socket.frame({ type: "disconnect", reason: "too_many_websockets" }),
      },
    ];

    it.each(cases)("maps $name to a fixed sentence", async ({ options, expected, auth, onOpen }) => {
      const h = harness(options);
      const run = h.start();
      if (onOpen) {
        await until(() => h.sockets.length === 1, "the first socket");
        onOpen(h.sockets[0]!);
      }
      await run.done;

      expect(run.state.value).toBe("rejected");
      const error = run.state.error as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(expected);
      if (auth) expect(error).toBeInstanceOf(ChannelStreamAuthError);
      else expect(error).not.toBeInstanceOf(ChannelStreamAuthError);
      // Nothing from the request, the reply or the socket rides along on the error.
      expect(error.cause).toBeUndefined();
      const shown = [error.message, error.stack ?? "", JSON.stringify(h.diagnostic.mock.calls)].join("\n");
      expect(shown).not.toContain(APP_TOKEN);
      expect(shown).not.toContain("ticket=");
      expect(shown).not.toContain("secret-ticket");
    });

    it("stops opening after a rejected app-level token", async () => {
      const h = harness({ opens: [() => json({ ok: false, error: "invalid_auth" })] });
      const run = h.start();
      await run.done;
      expect(h.opens).toHaveLength(1);
      expect(h.createWebSocket).not.toHaveBeenCalled();
    });

    it("asks nothing of Slack when there is no token or slack.com is blocked", async () => {
      for (const options of [{ token: undefined }, { allowlisted: false }] as HarnessOptions[]) {
        const h = harness(options);
        await h.start().done;
        expect(h.fetchMock).not.toHaveBeenCalled();
      }
    });

    it("checks slack.com against the allowlist", async () => {
      const h = harness();
      const run = h.start();
      await until(() => h.sockets.length === 1, "the first socket");
      expect(h.deps.isUrlAllowlisted).toHaveBeenCalledWith("https://slack.com/");
      h.abort();
      await run.done;
    });
  });
});
