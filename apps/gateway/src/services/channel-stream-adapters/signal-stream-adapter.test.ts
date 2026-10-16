import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { dispatchInboundWebhookMessage } from "../channel-inbound-dispatch.js";
import {
  ChannelStreamAuthError,
  ChannelStreamRuntimeService,
  type ChannelStreamEvent,
  type ChannelStreamRunContext,
} from "../channel-stream-runtime-service.js";
import { createSignalStreamAdapter, type SignalStreamAdapterDeps } from "./signal-stream-adapter.js";

const ACCOUNT = "+15550000000";

function connection(config: Record<string, unknown> = {}): IntegrationConnection {
  return {
    connectionId: "conn-signal",
    revision: "r1",
    catalogId: "channel.signal",
    kind: "channel",
    key: "signal",
    label: "Signal",
    enabled: true,
    status: "connected",
    config: {
      baseUrl: "http://127.0.0.1:8080",
      accountId: ACCOUNT,
      defaultRecipient: "+15557654321",
      receiveEvents: true,
      ...config,
    },
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
  };
}

function notification(envelope: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", method: "receive", params: { envelope, account: ACCOUNT } };
}

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": keepalive\n\n"));
      for (const event of events) {
        const data = typeof event === "string" ? event : JSON.stringify(event);
        controller.enqueue(encoder.encode(`event: receive\ndata: ${data}\n\n`));
      }
      controller.close();
    },
  });
}

function streamResponse(events: unknown[], status = 200): Response {
  return new Response(status === 200 ? sse(events) : "denied", { status });
}

function harness(options: { response?: () => Response; allowlisted?: boolean } = {}) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    options.response ? options.response() : streamResponse([]),
  );
  const deps: SignalStreamAdapterDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    isUrlAllowlisted: vi.fn(() => options.allowlisted ?? true),
  };
  const adapter = createSignalStreamAdapter(deps);
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
  return { adapter, deps, fetchMock, emitted, markReady, touch, ctx };
}

const DIRECT = {
  source: "+15551112222",
  sourceNumber: "+15551112222",
  sourceUuid: "a1b2c3d4-0000-4000-8000-000000000001",
  sourceName: "Alice",
  timestamp: 1760000000000,
  dataMessage: { timestamp: 1760000000001, message: "hello goat" },
};

const GROUP = {
  source: "+15553334444",
  sourceNumber: "+15553334444",
  sourceUuid: "a1b2c3d4-0000-4000-8000-000000000002",
  sourceName: "Bob",
  timestamp: 1760000000100,
  dataMessage: { timestamp: 1760000000101, message: "group hello", groupInfo: { groupId: "R3JvdXBJZA==" } },
};

describe("signal stream adapter", () => {
  it("is inbound-enabled only when receiveEvents is set and a bridge URL is configured", () => {
    const { adapter } = harness();
    expect(adapter.channelKey).toBe("signal");
    expect(adapter.isInboundEnabled(connection())).toBe(true);
    expect(adapter.isInboundEnabled(connection({ receiveEvents: " TRUE " }))).toBe(true);
    expect(adapter.isInboundEnabled(connection({ receiveEvents: false }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ receiveEvents: undefined }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ receiveEvents: undefined, inboundEnabled: true }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ baseUrl: "" }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ baseUrl: undefined, bridgeUrl: "http://127.0.0.1:9000" }))).toBe(true);
  });

  it("marks ready on a 2xx response and emits the exact direct-message event", async () => {
    const h = harness({ response: () => streamResponse([notification(DIRECT)]) });
    await h.adapter.run(h.ctx());
    expect(h.markReady).toHaveBeenCalledTimes(1);
    expect(h.emitted).toEqual([
      {
        cursor: undefined,
        event: {
          idempotencyKey: "signal:conn-signal:a1b2c3d4-0000-4000-8000-000000000001:1760000000001",
          eventType: "signal-receive",
          bindingTarget: "a1b2c3d4-0000-4000-8000-000000000001",
          message: {
            eventId: "a1b2c3d4-0000-4000-8000-000000000001:1760000000001",
            account: "conn-signal",
            actorId: "a1b2c3d4-0000-4000-8000-000000000001",
            actorType: "user",
            displayName: "Alice",
            content: "hello goat",
            room: undefined,
            peer: "a1b2c3d4-0000-4000-8000-000000000001",
            metadata: {
              sourceNumber: "+15551112222",
              sourceUuid: "a1b2c3d4-0000-4000-8000-000000000001",
              timestamp: 1760000000001,
              groupId: undefined,
            },
          },
        },
      },
    ]);
  });

  it("emits the exact group-message event bound to the group", async () => {
    const h = harness({ response: () => streamResponse([notification(GROUP)]) });
    await h.adapter.run(h.ctx());
    expect(h.emitted.map((entry) => entry.event)).toEqual([
      {
        idempotencyKey: "signal:conn-signal:a1b2c3d4-0000-4000-8000-000000000002:1760000000101",
        eventType: "signal-receive",
        bindingTarget: "group:R3JvdXBJZA==",
        message: {
          eventId: "a1b2c3d4-0000-4000-8000-000000000002:1760000000101",
          account: "conn-signal",
          actorId: "a1b2c3d4-0000-4000-8000-000000000002",
          actorType: "user",
          displayName: "Bob",
          content: "group hello",
          room: "group:R3JvdXBJZA==",
          peer: undefined,
          metadata: {
            sourceNumber: "+15553334444",
            sourceUuid: "a1b2c3d4-0000-4000-8000-000000000002",
            timestamp: 1760000000101,
            groupId: "R3JvdXBJZA==",
          },
        },
      },
    ]);
  });

  it("falls back to sourceNumber, then source, and to the envelope timestamp", async () => {
    const h = harness({
      response: () =>
        streamResponse([
          notification({ sourceNumber: "+15559990000", timestamp: 7, dataMessage: { message: "a" } }),
          notification({ source: "+15558880000", timestamp: 8, dataMessage: { message: "b" } }),
        ]),
    });
    await h.adapter.run(h.ctx());
    expect(h.emitted.map((entry) => entry.event.idempotencyKey)).toEqual([
      "signal:conn-signal:+15559990000:7",
      "signal:conn-signal:+15558880000:8",
    ]);
  });

  it("ignores syncMessage self-echo of our own sends", async () => {
    const h = harness({
      response: () =>
        streamResponse([
          notification({
            ...DIRECT,
            dataMessage: undefined,
            syncMessage: { sentMessage: { timestamp: 1, message: "sent by us", destination: "+15551112222" } },
          }),
        ]),
    });
    await h.adapter.run(h.ctx());
    expect(h.emitted).toEqual([]);
  });

  it("ignores receipt and typing messages, empty text and malformed data", async () => {
    const h = harness({
      response: () =>
        streamResponse([
          notification({ ...DIRECT, dataMessage: undefined, receiptMessage: { isDelivery: true, timestamps: [1] } }),
          notification({ ...DIRECT, dataMessage: undefined, typingMessage: { action: "STARTED", timestamp: 2 } }),
          notification({ ...DIRECT, dataMessage: { timestamp: 3, message: "   " } }),
          notification({ ...DIRECT, dataMessage: { timestamp: 4, message: null } }),
          { jsonrpc: "2.0", method: "somethingElse", params: { envelope: DIRECT } },
          "not json at all",
        ]),
    });
    const ctx = h.ctx();
    await h.adapter.run(ctx);
    expect(h.emitted).toEqual([]);
    expect(ctx.diagnostic).toHaveBeenCalledWith("event_unparseable", expect.any(String));
  });

  it("ignores messages from the configured account itself", async () => {
    const h = harness({
      response: () =>
        streamResponse([
          notification({ ...DIRECT, sourceNumber: ACCOUNT, source: ACCOUNT }),
          notification({ ...DIRECT, sourceUuid: "self-uuid", sourceNumber: "+15551112222" }),
        ]),
    });
    await h.adapter.run(h.ctx({ config: { accountId: undefined, account: "self-uuid" } }));
    // With account=self-uuid the first envelope (from the number in params.account) is still ours.
    expect(h.emitted).toEqual([]);
  });

  it("requests the events endpoint with the encoded account query parameter and no redirects", async () => {
    const h = harness();
    await h.adapter.run(h.ctx());
    await h.adapter.run(h.ctx({ config: { accountId: undefined, baseUrl: "http://127.0.0.1:8080/" } }));
    await h.adapter.run(h.ctx({ config: { accountId: undefined, account: "+15551230000" } }));
    const urls = h.fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      "http://127.0.0.1:8080/api/v1/events?account=%2B15550000000",
      "http://127.0.0.1:8080/api/v1/events",
      "http://127.0.0.1:8080/api/v1/events?account=%2B15551230000",
    ]);
    const init = h.fetchMock.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("accept")).toBe("text/event-stream");
  });

  it("uses bridgeUrl when baseUrl is absent", async () => {
    const h = harness();
    await h.adapter.run(
      h.ctx({ config: { baseUrl: undefined, bridgeUrl: "http://bridge.local:9000", accountId: undefined } }),
    );
    expect(String(h.fetchMock.mock.calls[0]?.[0])).toBe("http://bridge.local:9000/api/v1/events");
  });

  it("throws ChannelStreamAuthError on 401 and 403, and a plain error on other failures", async () => {
    for (const status of [401, 403]) {
      const h = harness({ response: () => streamResponse([], status) });
      await expect(h.adapter.run(h.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);
      expect(h.markReady).not.toHaveBeenCalled();
    }
    const h = harness({ response: () => streamResponse([], 500) });
    const error = await h.adapter.run(h.ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChannelStreamAuthError);
  });

  it("throws ChannelStreamAuthError when the bridge host is not allowlisted, before any request", async () => {
    const h = harness({ allowlisted: false });
    await expect(h.adapter.run(h.ctx())).rejects.toThrow(/Signal bridge host is not in the outbound allowlist/);
    await expect(h.adapter.run(h.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("derives identical idempotency keys when the same envelope is replayed in two sessions", async () => {
    const h = harness({ response: () => streamResponse([notification(DIRECT), notification(GROUP)]) });
    await h.adapter.run(h.ctx());
    await h.adapter.run(h.ctx());
    expect(h.emitted).toHaveLength(4);
    expect(h.emitted[0]?.event).toEqual(h.emitted[2]?.event);
    expect(h.emitted[1]?.event).toEqual(h.emitted[3]?.event);
  });

  it("never reaches durable acceptance for a sender missing from the allowlist (real dispatch gate)", async () => {
    const h = harness({ response: () => streamResponse([notification(DIRECT)]) });
    const acceptInboundChannelEvent = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const recordDevDiagnostic = vi.fn();
    const conn = connection({ inboundAccessMode: "allowlist", allowedSenders: ["+15550009999"] });
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
    await vi.waitFor(() =>
      expect(recordDevDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ event: "channel.sender_not_allowlisted" }),
      ),
    );
    await runtime.close();
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });
});

describe("signal stream liveness", () => {
  it("declares a 90s idle timeout and touches the session for SSE comment keepalives", async () => {
    const h = harness({ response: () => streamResponse([]) });
    expect(h.adapter.idleTimeoutMs).toBe(90_000);
    await h.adapter.run(h.ctx());
    // The fixture stream opens with a ": keepalive" comment and carries no events.
    expect(h.touch).toHaveBeenCalled();
    expect(h.emitted).toEqual([]);
  });
});
