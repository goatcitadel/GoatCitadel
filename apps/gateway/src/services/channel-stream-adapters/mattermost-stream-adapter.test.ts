import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { dispatchInboundWebhookMessage } from "../channel-inbound-dispatch.js";
import {
  ChannelStreamAuthError,
  ChannelStreamRuntimeService,
  type ChannelStreamEvent,
  type ChannelStreamRunContext,
} from "../channel-stream-runtime-service.js";
import {
  createMattermostStreamAdapter,
  type MattermostStreamAdapterDeps,
  type MattermostWebSocketLike,
} from "./mattermost-stream-adapter.js";

function connection(config: Record<string, unknown> = {}): IntegrationConnection {
  return {
    connectionId: "conn-mm",
    revision: "r1",
    catalogId: "channel.mattermost",
    kind: "channel",
    key: "mattermost",
    label: "Mattermost",
    enabled: true,
    status: "connected",
    config: {
      serverUrl: "https://chat.example.test",
      botTokenEnv: "MATTERMOST_BOT_TOKEN",
      defaultChannel: "town-square",
      inboundStreamEnabled: true,
      ...config,
    },
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
  };
}

class FakeWebSocket extends EventTarget implements MattermostWebSocketLike {
  readonly sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.dispatchEvent(new Event("open"));
  }
  push(payload: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: typeof payload === "string" ? payload : JSON.stringify(payload) }),
    );
  }
  end(): void {
    this.dispatchEvent(new Event("close"));
  }
  fail(): void {
    this.dispatchEvent(new Event("error"));
  }
}

const BOT_ID = "bot-user-id";

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: "post1",
    channel_id: "chan1",
    user_id: "user1",
    root_id: "",
    type: "",
    message: "hello bot",
    ...overrides,
  };
}

function posted(postBody: Record<string, unknown>, data: Record<string, unknown> = {}, seq = 7) {
  return {
    event: "posted",
    seq,
    data: {
      channel_type: "O",
      channel_name: "town-square",
      sender_name: "@alice",
      team_id: "team1",
      post: JSON.stringify(postBody),
      ...data,
    },
  };
}

function harness(
  options: { me?: () => Response; allowlisted?: (url: string) => boolean; token?: string | undefined } = {},
) {
  const sockets: FakeWebSocket[] = [];
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    options.me ? options.me() : new Response(JSON.stringify({ id: BOT_ID }), { status: 200 }),
  );
  const deps: MattermostStreamAdapterDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    resolveSecret: vi.fn(() => ("token" in options ? options.token : "bot-secret")),
    isUrlAllowlisted: vi.fn((url: string) => (options.allowlisted ? options.allowlisted(url) : true)),
    createWebSocket: (url: string) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
  };
  const adapter = createMattermostStreamAdapter(deps);
  const emitted: Array<{ event: ChannelStreamEvent; cursor?: string }> = [];
  const markReady = vi.fn();
  const touch = vi.fn();
  function ctx(overrides: Partial<ChannelStreamRunContext> & { config?: Record<string, unknown> } = {}) {
    const { config, ...rest } = overrides;
    return {
      connection: connection(config),
      signal: new AbortController().signal,
      cursor: undefined,
      markReady,
      touch,
      emit: async (event: ChannelStreamEvent, cursor?: string) => {
        emitted.push({ event, cursor });
      },
      diagnostic: vi.fn(),
      ...rest,
    } as ChannelStreamRunContext;
  }
  async function socketOf(): Promise<FakeWebSocket> {
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    return sockets[sockets.length - 1]!;
  }
  return { adapter, deps, fetchMock, sockets, emitted, markReady, touch, ctx, socketOf };
}

describe("mattermost stream adapter", () => {
  it("is inbound-enabled only with the opt-in, server URL and a bot token", () => {
    const { adapter } = harness();
    expect(adapter.isInboundEnabled(connection())).toBe(true);
    expect(adapter.isInboundEnabled(connection({ inboundStreamEnabled: "true" }))).toBe(true);
    expect(adapter.isInboundEnabled(connection({ inboundStreamEnabled: false }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ inboundStreamEnabled: undefined }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ serverUrl: "" }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ botTokenEnv: undefined }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ botTokenEnv: undefined, botToken: "keychain:x" }))).toBe(true);
    expect(adapter.isInboundEnabled(connection({ botTokenEnv: undefined, tokenEnv: "T" }))).toBe(true);
  });

  it("looks up the bot id, opens the derived wss URL, sends the auth challenge and marks ready on hello", async () => {
    const h = harness();
    const run = h.adapter.run(h.ctx());
    const socket = await h.socketOf();
    expect(String(h.fetchMock.mock.calls[0]?.[0])).toBe("https://chat.example.test/api/v4/users/me");
    const headers = new Headers(h.fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer bot-secret");
    expect(h.fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(socket.url).toBe("wss://chat.example.test/api/v4/websocket");
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      seq: 1,
      action: "authentication_challenge",
      data: { token: "bot-secret" },
    });
    expect(h.markReady).not.toHaveBeenCalled();
    socket.push({ event: "hello", seq: 0, data: { server_version: "9.0.0" } });
    expect(h.markReady).toHaveBeenCalledTimes(1);
    socket.push({ status: "OK", seq_reply: 1 });
    expect(h.markReady).toHaveBeenCalledTimes(1);
    socket.end();
    await run;
  });

  it("maps http servers to ws and keeps a base path", async () => {
    const h = harness();
    const run = h.adapter.run(h.ctx({ config: { serverUrl: "http://chat.local:8065/mm/" } }));
    const socket = await h.socketOf();
    expect(socket.url).toBe("ws://chat.local:8065/mm/api/v4/websocket");
    expect(String(h.fetchMock.mock.calls[0]?.[0])).toBe("http://chat.local:8065/mm/api/v4/users/me");
    socket.end();
    await run;
  });

  it("marks ready on an OK auth response when no hello arrives", async () => {
    const h = harness();
    const run = h.adapter.run(h.ctx());
    const socket = await h.socketOf();
    socket.open();
    socket.push({ status: "OK", seq_reply: 1 });
    expect(h.markReady).toHaveBeenCalledTimes(1);
    socket.end();
    await run;
  });

  it("emits the normalized event for a channel post with the seq cursor", async () => {
    const h = harness();
    const run = h.adapter.run(h.ctx());
    const socket = await h.socketOf();
    socket.open();
    socket.push(posted(post({ root_id: "root9" })));
    socket.end();
    await run;
    expect(h.emitted).toEqual([
      {
        cursor: "7",
        event: {
          idempotencyKey: "mattermost:conn-mm:post1",
          eventType: "mattermost-posted",
          bindingTarget: "chan1",
          message: {
            eventId: "post1",
            account: "conn-mm",
            room: "chan1",
            threadId: "root9",
            actorId: "user1",
            actorType: "user",
            displayName: "alice",
            content: "hello bot",
            metadata: { channelType: "O", channelName: "town-square", teamId: "team1", rootId: "root9" },
          },
        },
      },
    ]);
  });

  it("sets peer for a direct message and omits threadId when the post is not a reply", async () => {
    const h = harness();
    const run = h.adapter.run(h.ctx());
    const socket = await h.socketOf();
    socket.open();
    socket.push(posted(post(), { channel_type: "D" }));
    socket.end();
    await run;
    const message = h.emitted[0]?.event.message;
    expect(message?.peer).toBe("user1");
    expect(message?.threadId).toBeUndefined();
    expect(message?.metadata).toMatchObject({ channelType: "D" });
  });

  it("ignores the bot's own posts, system posts, empty messages and malformed frames", async () => {
    const h = harness();
    const run = h.adapter.run(h.ctx());
    const socket = await h.socketOf();
    socket.open();
    socket.push(posted(post({ id: "self", user_id: BOT_ID })));
    socket.push(posted(post({ id: "sys", type: "system_join_channel" })));
    socket.push(posted(post({ id: "blank", message: "   " })));
    socket.push(posted(post({ id: "human" })));
    socket.push("not json");
    socket.push({ event: "typing", data: {} });
    socket.push({ event: "posted", seq: 9, data: { post: "{broken" } });
    socket.end();
    await run;
    expect(h.emitted.map((entry) => entry.event.message.eventId)).toEqual(["human"]);
  });

  it("throws ChannelStreamAuthError when the websocket auth challenge fails", async () => {
    const h = harness();
    const run = h.adapter.run(h.ctx());
    const socket = await h.socketOf();
    socket.open();
    socket.push({ status: "FAIL", seq_reply: 1, error: { message: "bad token" } });
    await expect(run).rejects.toBeInstanceOf(ChannelStreamAuthError);
    expect(socket.closed).toBe(true);
  });

  it("throws ChannelStreamAuthError on a users/me 401 or 403 before opening a socket", async () => {
    for (const status of [401, 403]) {
      const h = harness({ me: () => new Response("denied", { status }) });
      await expect(h.adapter.run(h.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);
      expect(h.sockets).toHaveLength(0);
    }
    const h = harness({ me: () => new Response("boom", { status: 500 }) });
    const error = await h.adapter.run(h.ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChannelStreamAuthError);
  });

  it("throws ChannelStreamAuthError when the host is not allowlisted, before any request", async () => {
    const h = harness({ allowlisted: () => false });
    await expect(h.adapter.run(h.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.sockets).toHaveLength(0);
  });

  it("checks the websocket endpoint against the allowlist in its http(s) form", async () => {
    const h = harness();
    const run = h.adapter.run(h.ctx());
    const socket = await h.socketOf();
    const checked = (h.deps.isUrlAllowlisted as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(checked).toContain("https://chat.example.test/api/v4/websocket");
    expect(checked.every((url) => url.startsWith("http"))).toBe(true);
    socket.end();
    await run;
  });

  it("throws ChannelStreamAuthError when the token cannot be resolved", async () => {
    const h = harness({ token: undefined });
    await expect(h.adapter.run(h.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects on a socket error", async () => {
    const h = harness();
    const run = h.adapter.run(h.ctx());
    const socket = await h.socketOf();
    socket.fail();
    await expect(run).rejects.toThrow(/websocket error/i);
  });

  it("closes the socket and resolves when the signal aborts", async () => {
    const h = harness();
    const abort = new AbortController();
    const run = h.adapter.run(h.ctx({ signal: abort.signal }));
    const socket = await h.socketOf();
    socket.open();
    abort.abort();
    await run;
    expect(socket.closed).toBe(true);
  });

  it("derives identical idempotency keys when the same post is replayed in two sessions", async () => {
    const h = harness();
    for (const seq of [7, 31]) {
      const run = h.adapter.run(h.ctx());
      await vi.waitFor(() => expect(h.sockets.length).toBeGreaterThan(seq === 7 ? 0 : 1));
      const socket = h.sockets[h.sockets.length - 1]!;
      socket.open();
      socket.push(posted(post(), {}, seq));
      socket.end();
      await run;
    }
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[0]?.event).toEqual(h.emitted[1]?.event);
    expect(h.emitted[0]?.event.idempotencyKey).toBe("mattermost:conn-mm:post1");
  });

  it("never reaches durable acceptance for a user id missing from the allowlist (real dispatch gate)", async () => {
    const h = harness();
    const acceptInboundChannelEvent = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const recordDevDiagnostic = vi.fn();
    const conn = connection({ inboundAccessMode: "allowlist", allowedSenders: ["someone-else"] });
    const runtime = new ChannelStreamRuntimeService({
      listConnections: async () => [conn],
      adapters: [h.adapter],
      dispatch: (c, event) =>
        dispatchInboundWebhookMessage({ acceptInboundChannelEvent, recordDevDiagnostic } as never, {
          channel: c.key,
          connectionId: c.connectionId,
          idempotencyKey: event.idempotencyKey,
          eventType: event.eventType,
          bindingTarget: event.bindingTarget,
          inboundAccessConfig: c.config,
          acceptedConnectionRevision: c.revision,
          message: event.message,
        }),
      recordDevDiagnostic,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    });
    await runtime.sync();
    const socket = await h.socketOf();
    socket.open();
    socket.push(posted(post()));
    await vi.waitFor(() =>
      expect(recordDevDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ event: "channel.sender_not_allowlisted" }),
      ),
    );
    await runtime.close();
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });
});

describe("mattermost stream liveness", () => {
  it("pings after authentication, touches on every frame including the pong, and stops pinging on close", async () => {
    const h = harness();
    expect(h.adapter.idleTimeoutMs).toBe(90_000);
    const fastPing = createMattermostStreamAdapter(h.deps, { pingIntervalMs: 20 });
    const run = fastPing.run(h.ctx());
    const socket = await h.socketOf();
    socket.open();
    expect(socket.sent).toHaveLength(1);
    socket.push({ event: "hello", seq: 0 });
    expect(h.touch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThanOrEqual(2));
    const ping = JSON.parse(socket.sent[1]!) as { action: string; seq: number };
    expect(ping).toEqual({ action: "ping", seq: 2 });
    socket.push({ status: "OK", seq_reply: 2, data: { text: "pong" } });
    expect(h.touch).toHaveBeenCalledTimes(2);
    expect(h.markReady).toHaveBeenCalledTimes(1);
    socket.end();
    await run;
    const sentAtClose = socket.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(socket.sent).toHaveLength(sentAtClose);
  });
});
