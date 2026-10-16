import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { getChannelStreamRuntime, type ChannelStreamRuntimeHost } from "./channel-stream-runtime-registry.js";

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

function signalSse(): ReadableStream<Uint8Array> {
  const envelope = { sourceNumber: "+15550000002", timestamp: 5, dataMessage: { timestamp: 5, message: "hello" } };
  const data = JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope } });
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
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
    { channel: "signal", legacy: {} },
    { channel: "signal", legacy: { inboundAccessMode: "open_legacy" } },
  ] as const;
  for (const { channel, legacy } of cases) {
    it(`drops a ${channel} event with ${JSON.stringify(legacy)} and no allowed senders`, async () => {
      const h = host();
      const base = ntfyConnection();
      const config: Record<string, unknown> =
        channel === "ntfy"
          ? { baseUrl: "https://ntfy.example.test", topic: "ops", tokenEnv: "NTFY_TOKEN", inboundStreamEnabled: true }
          : channel === "signal"
            ? { baseUrl: "http://127.0.0.1:8080", defaultRecipient: "+15550000001", receiveEvents: true }
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
            : String(url).includes("/api/v1/events")
              ? new Response(signalSse(), { status: 200 })
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
