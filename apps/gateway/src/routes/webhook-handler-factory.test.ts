import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_INBOUND_MAX_BYTES,
  createWebhookHandler,
  createWebhookPreParsing,
  dispatchInboundWebhookMessage,
  type WebhookRawBodyRequest,
} from "./webhook-handler-factory.js";

function createReply() {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    code(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return payload;
    },
  };
  return reply;
}

function createRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    headers: {},
    params: {
      connectionId: "11111111-1111-1111-1111-111111111111",
    },
    log: {
      warn: vi.fn(),
    },
    telegramRawBody: Buffer.from("{}"),
    ...overrides,
  } as any;
}

describe("webhook-handler-factory contract behavior", () => {
  it("captures the inbound raw body during pre-parsing", async () => {
    const preParsing = createWebhookPreParsing("telegramRawBody");
    const request = createRequest();
    const payload = Readable.from([Buffer.from("hello "), Buffer.from("world")]);

    const replay = await preParsing(request, createReply() as any, payload);
    const replayed = await (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of replay) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    })();

    expect((request as WebhookRawBodyRequest).telegramRawBody?.toString("utf8")).toBe("hello world");
    expect(replayed.toString("utf8")).toBe("hello world");
  });

  it("rejects oversized inbound payloads before connector lookup", async () => {
    const gateway = {
      getIntegrationConnection: vi.fn(),
    };
    const handler = createWebhookHandler({ gateway } as any, {
      source: "telegram",
      connectorKey: "telegram",
      connectorLabel: "Telegram",
      rawBodyKey: "telegramRawBody",
      missingRawBodyError: "raw body missing",
      verifySignature: () => ({ ok: true as const }),
      parsePayload: () => ({ kind: "dispatch" as const, parsed: { ok: true } }),
      dispatch: vi.fn(),
    });

    const request = createRequest({
      headers: {
        "content-length": String(CHANNEL_INBOUND_MAX_BYTES + 1),
      },
    });
    const reply = createReply();

    await handler(request, reply as any);

    expect(reply.statusCode).toBe(413);
    expect(reply.payload).toEqual({
      error: `Inbound channel payload too large. Max ${CHANNEL_INBOUND_MAX_BYTES} bytes.`,
    });
    expect(gateway.getIntegrationConnection).not.toHaveBeenCalled();
  });

  it("logs verification failures and returns the declared status without dispatching", async () => {
    const dispatch = vi.fn();
    const handler = createWebhookHandler(
      {
        gateway: {
          getIntegrationConnection: vi.fn(() => ({ key: "telegram", config: {} })),
        },
      } as any,
      {
        source: "telegram",
        connectorKey: "telegram",
        connectorLabel: "Telegram",
        rawBodyKey: "telegramRawBody",
        missingRawBodyError: "raw body missing",
        verifySignature: () => ({
          ok: false as const,
          error: "bad signature",
          statusCode: 401,
          logReason: "signature_mismatch",
        }),
        parsePayload: () => ({ kind: "dispatch" as const, parsed: { ok: true } }),
        dispatch,
      },
    );

    const request = createRequest();
    const reply = createReply();

    await handler(request, reply as any);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: "bad signature" });
    expect(request.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        connectionId: "11111111-1111-1111-1111-111111111111",
        reason: "signature_mismatch",
      }),
      "Rejected inbound webhook because verification failed.",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("supports verification replies without ingesting or dispatching a message", async () => {
    const dispatch = vi.fn();
    const handler = createWebhookHandler(
      {
        gateway: {
          getIntegrationConnection: vi.fn(() => ({ key: "telegram", config: {} })),
        },
      } as any,
      {
        source: "telegram",
        connectorKey: "telegram",
        connectorLabel: "Telegram",
        rawBodyKey: "telegramRawBody",
        missingRawBodyError: "raw body missing",
        verifySignature: () => ({ ok: true as const }),
        parsePayload: () => ({ kind: "reply" as const, payload: { challenge: "ok" } }),
        dispatch,
      },
    );

    const request = createRequest();
    const reply = createReply();

    await handler(request, reply as any);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ challenge: "ok" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("binds the chat session and replies only when the inbound webhook event is new", async () => {
    const gateway = {
      ingestChannelMessage: vi.fn(async () => ({
        deduped: false,
        session: { sessionId: "session-1" },
      })),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(async () => ({ turnId: "turn-1" })),
    };

    const result = await dispatchInboundWebhookMessage(gateway as any, {
      channel: "telegram",
      connectionId: "11111111-1111-1111-1111-111111111111",
      idempotencyKey: "telegram:event-1",
      eventType: "message.created",
      bindingTarget: "room-1",
      message: {
        eventId: "event-1",
        account: "11111111-1111-1111-1111-111111111111",
        actorId: "user-1",
        content: "hello",
      },
    });

    expect(result).toEqual({
      accepted: true,
      deduped: false,
      replied: true,
      sessionId: "session-1",
      turnId: "turn-1",
      eventType: "message.created",
    });
    expect(gateway.setChatSessionBinding).toHaveBeenCalledWith({
      sessionId: "session-1",
      transport: "integration",
      connectionId: "11111111-1111-1111-1111-111111111111",
      target: "room-1",
      writable: true,
    });
    expect(gateway.respondToExistingChatMessage).toHaveBeenCalledWith("session-1", "event-1");
  });
});
