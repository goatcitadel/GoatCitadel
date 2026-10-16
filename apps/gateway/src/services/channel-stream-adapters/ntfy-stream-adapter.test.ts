import { describe, expect, it, vi } from "vitest";
import { NTFY_OUTBOUND_MARKER_TAG, type IntegrationConnection } from "@goatcitadel/contracts";
import { dispatchInboundWebhookMessage } from "../channel-inbound-dispatch.js";
import {
  ChannelStreamAuthError,
  ChannelStreamRuntimeService,
  type ChannelStreamEvent,
  type ChannelStreamRunContext,
} from "../channel-stream-runtime-service.js";
import { createNtfyStreamAdapter, type NtfyStreamAdapterDeps } from "./ntfy-stream-adapter.js";

function connection(config: Record<string, unknown> = {}): IntegrationConnection {
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
      ...config,
    },
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
  };
}

function ndjson(lines: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${typeof line === "string" ? line : JSON.stringify(line)}\n`));
      }
      controller.close();
    },
  });
}

function streamResponse(lines: unknown[], status = 200): Response {
  return new Response(status === 200 ? ndjson(lines) : "denied", { status });
}

function harness(options: { response?: () => Response; allowlisted?: boolean; token?: string | undefined } = {}) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    options.response ? options.response() : streamResponse([]),
  );
  const deps: NtfyStreamAdapterDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    resolveSecret: vi.fn(() => ("token" in options ? options.token : "secret-token")),
    isUrlAllowlisted: vi.fn(() => options.allowlisted ?? true),
  };
  const adapter = createNtfyStreamAdapter(deps);
  const emitted: Array<{ event: ChannelStreamEvent; cursor?: string }> = [];
  const markReady = vi.fn();
  function ctx(overrides: Partial<ChannelStreamRunContext> & { config?: Record<string, unknown> } = {}) {
    const { config, ...rest } = overrides;
    return {
      connection: connection(config),
      signal: new AbortController().signal,
      cursor: undefined,
      markReady,
      emit: async (event: ChannelStreamEvent, cursor?: string) => {
        emitted.push({ event, cursor });
      },
      diagnostic: vi.fn(),
      ...rest,
    } as ChannelStreamRunContext;
  }
  return { adapter, deps, fetchMock, emitted, markReady, ctx };
}

const MESSAGE = {
  id: "msg1",
  time: 1760000000,
  event: "message",
  topic: "ops",
  title: "Deploy",
  message: "ship it",
  tags: ["rocket"],
  priority: 4,
};

describe("ntfy stream adapter", () => {
  it("is inbound-enabled only with the opt-in, base URL, topic and a token", () => {
    const { adapter } = harness();
    expect(adapter.isInboundEnabled(connection())).toBe(true);
    expect(adapter.isInboundEnabled(connection({ inboundStreamEnabled: false }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ inboundStreamEnabled: undefined }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ baseUrl: "" }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ topic: "" }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ tokenEnv: undefined }))).toBe(false);
    expect(adapter.isInboundEnabled(connection({ tokenEnv: undefined, token: "keychain:x" }))).toBe(true);
    expect(adapter.isInboundEnabled(connection({ topic: undefined, subscribeTopic: "sub" }))).toBe(true);
  });

  it("marks ready on open, ignores keepalive, and emits the normalized message with the id cursor", async () => {
    const h = harness({
      response: () =>
        streamResponse([
          { id: "o1", event: "open", topic: "ops" },
          { id: "k1", event: "keepalive", topic: "ops" },
          MESSAGE,
        ]),
    });
    await h.adapter.run(h.ctx());
    expect(h.markReady).toHaveBeenCalledTimes(1);
    expect(h.emitted).toEqual([
      {
        cursor: "msg1",
        event: {
          idempotencyKey: "ntfy:conn-ntfy:msg1",
          eventType: "ntfy-message",
          bindingTarget: "ops",
          message: {
            eventId: "msg1",
            account: "conn-ntfy",
            room: "ops",
            actorId: "ntfy-topic:ops",
            actorType: "user",
            content: "Deploy\nship it",
            metadata: { topic: "ops", title: "Deploy", tags: ["rocket"], priority: 4, time: 1760000000 },
          },
        },
      },
    ]);
  });

  it("omits the title prefix when there is no title and skips empty messages", async () => {
    const h = harness({
      response: () =>
        streamResponse([
          { id: "a", event: "message", message: "plain" },
          { id: "b", event: "message", message: "   " },
          "not json at all",
        ]),
    });
    await h.adapter.run(h.ctx());
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.event.message.content).toBe("plain");
  });

  it("ignores its own outbound publishes by marker tag", async () => {
    const h = harness({
      response: () =>
        streamResponse([
          { ...MESSAGE, id: "echo", tags: ["rocket", NTFY_OUTBOUND_MARKER_TAG] },
          { ...MESSAGE, id: "human" },
        ]),
    });
    await h.adapter.run(h.ctx());
    expect(h.emitted.map((entry) => entry.event.message.eventId)).toEqual(["human"]);
  });

  it("requests the json stream with bearer auth and since only when a cursor exists", async () => {
    const h = harness();
    await h.adapter.run(h.ctx({ cursor: "abc" }));
    await h.adapter.run(h.ctx());
    const [withCursor, withoutCursor] = h.fetchMock.mock.calls;
    expect(String(withCursor?.[0])).toBe("https://ntfy.example.test/ops/json?since=abc");
    expect(String(withoutCursor?.[0])).toBe("https://ntfy.example.test/ops/json");
    const headers = new Headers(withCursor?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("subscribes to subscribeTopic when set and encodes the topic", async () => {
    const h = harness();
    await h.adapter.run(h.ctx({ config: { subscribeTopic: "in box", baseUrl: "https://ntfy.example.test/" } }));
    expect(String(h.fetchMock.mock.calls[0]?.[0])).toBe("https://ntfy.example.test/in%20box/json");
  });

  it("throws ChannelStreamAuthError on 401 and 403, and a plain error on other failures", async () => {
    for (const status of [401, 403]) {
      const h = harness({ response: () => streamResponse([], status) });
      await expect(h.adapter.run(h.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);
    }
    const h = harness({ response: () => streamResponse([], 500) });
    const error = await h.adapter.run(h.ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChannelStreamAuthError);
  });

  it("throws ChannelStreamAuthError when the host is not allowlisted, before any request", async () => {
    const h = harness({ allowlisted: false });
    await expect(h.adapter.run(h.ctx())).rejects.toThrow(/ntfy host is not in the outbound allowlist/);
    await expect(h.adapter.run(h.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("throws ChannelStreamAuthError when the token cannot be resolved", async () => {
    const h = harness({ token: undefined });
    await expect(h.adapter.run(h.ctx())).rejects.toBeInstanceOf(ChannelStreamAuthError);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("derives identical idempotency keys when the same message is replayed in two sessions", async () => {
    const h = harness({ response: () => streamResponse([MESSAGE]) });
    await h.adapter.run(h.ctx());
    await h.adapter.run(h.ctx());
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[0]?.event.idempotencyKey).toBe(h.emitted[1]?.event.idempotencyKey);
    expect(h.emitted[0]?.event).toEqual(h.emitted[1]?.event);
  });

  it("never reaches durable acceptance for a topic sender missing from an allowlist (real dispatch gate)", async () => {
    const h = harness({ response: () => streamResponse([{ id: "o", event: "open" }, MESSAGE]) });
    const acceptInboundChannelEvent = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const recordDevDiagnostic = vi.fn();
    const conn = connection({ inboundAccessMode: "allowlist", allowedSenders: ["ntfy-topic:someone-else"] });
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
