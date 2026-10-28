import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import {
  getChannelStreamRuntime,
  provideTelegramUpdateDeps,
  type ChannelStreamRuntimeHost,
} from "./channel-stream-runtime-registry.js";
import {
  integrationWebhookRouteMethods,
  type IntegrationWebhookRouteMethod,
  type IntegrationWebhookRoutePort,
} from "./integration-webhook-route-service.js";

function ntfyConnection(): IntegrationConnection {
  return {
    connectionId: "conn-ntfy",
    revision: "r1",
    catalogId: "channel.ntfy",
    kind: "channel",
    key: "ntfy",
    label: "ntfy",
    enabled: true,
    status: "connected",
    config: {
      baseUrl: "https://ntfy.example.test",
      topic: "ops",
      tokenEnv: "NTFY_TOKEN",
      inboundStreamEnabled: true,
      inboundAccessMode: "allowlist",
      allowedSenders: ["ntfy-topic:ops"],
    },
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
  };
}

function ndjson(lines: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      controller.close();
    },
  });
}

function host() {
  const acceptInboundChannelEvent = vi.fn(async (input: unknown) => ({
    accepted: true,
    durableAccepted: true,
    deduped: false,
    replied: false,
    queued: true,
    eventType: "ntfy-message",
    inboundEventId: "e1",
    input,
  }));
  const value = {
    storage: { integrationConnections: { list: vi.fn(async () => [ntfyConnection()]) } },
    acceptInboundChannelEvent,
    recordDevDiagnostic: vi.fn(),
    resolveConnectionSecret: vi.fn(() => "secret"),
    isConnectionUrlAllowlisted: vi.fn(() => true),
  } as unknown as ChannelStreamRuntimeHost;
  return { value, acceptInboundChannelEvent };
}

function telegramConnection(): IntegrationConnection {
  return {
    connectionId: "conn-tg",
    revision: "r1",
    catalogId: "channel.telegram",
    kind: "channel",
    key: "telegram",
    label: "Telegram",
    enabled: true,
    status: "connected",
    config: { botTokenEnv: "TELEGRAM_BOT_TOKEN", receiveMode: "poll" },
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
}

function telegramTextUpdate(updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 777, is_bot: false, first_name: "Ada" },
      chat: { id: 777, type: "private" },
      text: "hello",
    },
  };
}

function telegramHost() {
  const settings = new Map<string, unknown>();
  const value = {
    storage: {
      integrationConnections: { list: vi.fn(async () => [telegramConnection()]) },
      systemSettings: {
        get: vi.fn(async (key: string) =>
          settings.has(key) ? { key, value: settings.get(key), updatedAt: "2026-10-26T00:00:00.000Z" } : undefined,
        ),
        set: vi.fn(async (key: string, next: unknown) => {
          settings.set(key, next);
        }),
      },
    },
    acceptInboundChannelEvent: vi.fn(),
    recordDevDiagnostic: vi.fn(),
    resolveConnectionSecret: vi.fn(() => "123:abc"),
    isConnectionUrlAllowlisted: vi.fn(() => true),
  } as unknown as ChannelStreamRuntimeHost;
  return { value, settings };
}

/** A Bot API stand-in: getUpdates honours offset; with nothing pending it holds the long poll until aborted. */
function telegramFetch(pending: Array<{ update_id: number }>) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/getUpdates")) {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const result = offset === -1 ? [] : pending.filter((update) => update.update_id >= offset);
      if (result.length > 0 || offset === -1) return new Response(JSON.stringify({ ok: true, result }));
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
}

function fakeWebhooks(
  overrides: Partial<Record<IntegrationWebhookRouteMethod, (...args: never[]) => unknown>>,
): IntegrationWebhookRoutePort {
  const port = Object.fromEntries(integrationWebhookRouteMethods.map((method) => [method, vi.fn()]));
  return { ...port, ...overrides } as unknown as IntegrationWebhookRoutePort;
}

class FakeMattermostSocket extends EventTarget {
  constructor() {
    super();
    setTimeout(() => {
      this.dispatchEvent(new Event("open"));
      const post = { id: "p1", channel_id: "c1", user_id: "u1", root_id: "", type: "", message: "hi" };
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ event: "posted", seq: 3, data: { channel_type: "O", post: JSON.stringify(post) } }),
        }),
      );
    }, 0);
  }
  send(): void {}
  close(): void {}
}

describe("stream dispatch never applies legacy-open inbound access", () => {
  const cases = [
    { channel: "ntfy", legacy: {} },
    { channel: "ntfy", legacy: { inboundAccessMode: "open_legacy" } },
    { channel: "mattermost", legacy: {} },
    { channel: "mattermost", legacy: { inboundAccessMode: "open_legacy" } },
  ] as const;
  for (const { channel, legacy } of cases) {
    it(`drops a ${channel} event with ${JSON.stringify(legacy)} and no allowed senders`, async () => {
      const h = host();
      const base = ntfyConnection();
      const config: Record<string, unknown> =
        channel === "ntfy"
          ? { baseUrl: "https://ntfy.example.test", topic: "ops", tokenEnv: "NTFY_TOKEN", inboundStreamEnabled: true }
          : {
              serverUrl: "https://chat.example.test",
              botTokenEnv: "MM_TOKEN",
              defaultChannel: "town-square",
              inboundStreamEnabled: true,
            };
      const conn = { ...base, key: channel, catalogId: `channel.${channel}`, config: { ...config, ...legacy } };
      (h.value.storage.integrationConnections.list as ReturnType<typeof vi.fn>).mockResolvedValue([conn]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          String(url).endsWith("/users/me")
            ? new Response(JSON.stringify({ id: "bot" }), { status: 200 })
            : new Response(ndjson([{ id: "m1", event: "message", message: "hello", topic: "ops" }]), { status: 200 }),
        ),
      );
      vi.stubGlobal("WebSocket", FakeMattermostSocket);
      const runtime = getChannelStreamRuntime(h.value);
      try {
        await runtime.sync();
        await vi.waitFor(() =>
          expect(h.value.recordDevDiagnostic).toHaveBeenCalledWith(
            expect.objectContaining({ event: "channel.inbound_allowlist_empty" }),
          ),
        );
        expect(h.acceptInboundChannelEvent).not.toHaveBeenCalled();
      } finally {
        await runtime.close();
        vi.unstubAllGlobals();
      }
    });
  }
});

describe("retired stream channels", () => {
  it("opens no event stream for a saved Signal connection that still has receiveEvents on", async () => {
    const h = host();
    const conn = {
      ...ntfyConnection(),
      connectionId: "conn-signal",
      key: "signal",
      catalogId: "channel.signal",
      config: {
        baseUrl: "http://127.0.0.1:8080",
        defaultRecipient: "+15550000001",
        receiveEvents: true,
        inboundAccessMode: "allowlist",
        allowedSenders: ["+15550000002"],
      },
    };
    (h.value.storage.integrationConnections.list as ReturnType<typeof vi.fn>).mockResolvedValue([conn]);
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = getChannelStreamRuntime(h.value);
    try {
      await runtime.sync();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(h.acceptInboundChannelEvent).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
      vi.unstubAllGlobals();
    }
  });
});

describe("getChannelStreamRuntime", () => {
  it("reads only host.storage at creation; every other member is read when the runtime runs", () => {
    const reads: string[] = [];
    const guarded = new Proxy(
      { storage: {} },
      {
        get: (target, property) => {
          reads.push(String(property));
          return (target as Record<string | symbol, unknown>)[property];
        },
      },
    );
    expect(() => getChannelStreamRuntime(guarded as unknown as ChannelStreamRuntimeHost)).not.toThrow();
    expect(reads).toEqual(["storage"]);
  });

  it("shares one runtime between hosts that expose the same storage, and separates different storage", () => {
    const a = host();
    const sameStorage = { ...host().value, storage: a.value.storage } as ChannelStreamRuntimeHost;
    const b = host();
    expect(getChannelStreamRuntime(a.value)).toBe(getChannelStreamRuntime(a.value));
    expect(getChannelStreamRuntime(sameStorage)).toBe(getChannelStreamRuntime(a.value));
    expect(getChannelStreamRuntime(a.value)).not.toBe(getChannelStreamRuntime(b.value));
  });

  it("dispatches an accepted stream message through durable acceptance without connection secrets", async () => {
    const h = host();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(ndjson([{ id: "m1", event: "message", message: "hello", topic: "ops" }]), { status: 200 }),
      ),
    );
    const runtime = getChannelStreamRuntime(h.value);
    try {
      await runtime.sync();
      await vi.waitFor(() => expect(h.acceptInboundChannelEvent).toHaveBeenCalledTimes(1));
      const accepted = h.acceptInboundChannelEvent.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(accepted).toMatchObject({
        channel: "ntfy",
        connectionId: "conn-ntfy",
        idempotencyKey: "ntfy:conn-ntfy:m1",
        eventType: "ntfy-message",
        bindingTarget: "ops",
        dispatchKind: "agent_turn",
        acceptedConnectionRevision: "r1",
      });
      expect(accepted).not.toHaveProperty("inboundAccessConfig");
      expect(JSON.stringify(accepted)).not.toContain("secret");
    } finally {
      await runtime.close();
      vi.unstubAllGlobals();
    }
  });

  it("has a telegram adapter whose updates wait until the Telegram handler is provided", async () => {
    const h = telegramHost();
    vi.stubGlobal("fetch", telegramFetch([telegramTextUpdate(5)]));
    const runtime = getChannelStreamRuntime(h.value);
    try {
      await runtime.sync();
      await vi.waitFor(() =>
        expect(runtime.getStatus("conn-tg")?.lastError).toBe("Telegram receiving isn't ready yet."),
      );
      expect(runtime.getStatus("conn-tg")?.channelKey).toBe("telegram");
      expect(h.value.acceptInboundChannelEvent).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
      vi.unstubAllGlobals();
    }
  });

  it("routes polled Telegram updates through the provided handler and stores the cursor", async () => {
    const h = telegramHost();
    const getIntegrationConnection = vi.fn(async () => ({
      ...telegramConnection(),
      config: {
        ...telegramConnection().config,
        telegramPairing: { approved: [{ actorId: "777", approvedAt: "2026-10-26T00:00:00.000Z" }], pending: [] },
      },
    }));
    const acceptInboundChannelEvent = vi.fn(async (input: { eventType: string }) => ({
      accepted: true,
      durableAccepted: true,
      deduped: false,
      replied: false,
      queued: true,
      eventType: input.eventType,
      inboundEventId: "e1",
    }));
    provideTelegramUpdateDeps(h.value, {
      webhooks: fakeWebhooks({ getIntegrationConnection, acceptInboundChannelEvent }),
      readPersonalityCatalog: async () => ({ items: [], defaultPersonalityId: "default" }),
    });
    const fetchMock = telegramFetch([telegramTextUpdate(5)]);
    vi.stubGlobal("fetch", fetchMock);
    const runtime = getChannelStreamRuntime(h.value);
    try {
      await runtime.sync();
      await vi.waitFor(() =>
        expect(h.settings.get("channel_stream_cursor_v1:telegram:conn-tg")).toMatchObject({
          cursor: "6",
          scope: "123",
        }),
      );
      expect(getIntegrationConnection).toHaveBeenCalledWith("conn-tg");
      expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "telegram", idempotencyKey: "telegram:conn-tg:5" }),
      );
      expect(h.value.acceptInboundChannelEvent).not.toHaveBeenCalled();
      expect(runtime.getStatus("conn-tg")).toMatchObject({ ready: true });
      expect(runtime.getStatus("conn-tg")?.lastInboundAt).toBeTruthy();
    } finally {
      await runtime.close();
      vi.unstubAllGlobals();
    }
  });

  it("forwards a stream event reply target into durable acceptance (Mattermost replies in-thread)", async () => {
    const h = host();
    const conn = {
      ...ntfyConnection(),
      connectionId: "conn-mm",
      key: "mattermost",
      catalogId: "channel.mattermost",
      config: {
        serverUrl: "https://chat.example.test",
        botTokenEnv: "MM_TOKEN",
        defaultChannel: "town-square",
        inboundStreamEnabled: true,
        allowedSenders: ["u1"],
      },
    };
    (h.value.storage.integrationConnections.list as ReturnType<typeof vi.fn>).mockResolvedValue([conn]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "bot" }), { status: 200 })),
    );
    vi.stubGlobal("WebSocket", FakeMattermostSocket);
    const runtime = getChannelStreamRuntime(h.value);
    try {
      await runtime.sync();
      await vi.waitFor(() => expect(h.acceptInboundChannelEvent).toHaveBeenCalledTimes(1));
      expect(h.acceptInboundChannelEvent.mock.calls[0]?.[0]).toMatchObject({
        channel: "mattermost",
        idempotencyKey: "mattermost:conn-mm:p1",
        responseOptions: { deliveryReplyToMessageId: "p1" },
      });
    } finally {
      await runtime.close();
      vi.unstubAllGlobals();
    }
  });
});
