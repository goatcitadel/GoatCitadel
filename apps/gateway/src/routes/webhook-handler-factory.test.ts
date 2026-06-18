import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_INBOUND_MAX_BYTES,
  createWebhookHandler,
  createWebhookPreParsing,
  dispatchInboundWebhookMessage,
  type WebhookRawBodyRequest,
} from "./webhook-handler-factory.js";
import { ChannelBotLoopGuard } from "../services/channel-bot-loop-guard.js";

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
    const integrationWebhooks = {
      getIntegrationConnection: vi.fn(),
    };
    const handler = createWebhookHandler({ services: { integrationWebhooks } } as any, {
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
    expect(integrationWebhooks.getIntegrationConnection).not.toHaveBeenCalled();
  });

  it("logs verification failures and returns the declared status without dispatching", async () => {
    const dispatch = vi.fn();
    const handler = createWebhookHandler(
      {
        services: {
          integrationWebhooks: {
            getIntegrationConnection: vi.fn(() => ({ key: "telegram", config: {} })),
          },
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
        services: {
          integrationWebhooks: {
            getIntegrationConnection: vi.fn(() => ({ key: "telegram", config: {} })),
          },
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

  it("ignores inbound webhooks for a disabled connection without verifying or dispatching", async () => {
    const verifySignature = vi.fn(() => ({ ok: true as const }));
    const dispatch = vi.fn();
    const handler = createWebhookHandler(
      {
        services: {
          integrationWebhooks: {
            getIntegrationConnection: vi.fn(() => ({ key: "telegram", enabled: false, config: {} })),
          },
        },
      } as any,
      {
        source: "telegram",
        connectorKey: "telegram",
        connectorLabel: "Telegram",
        rawBodyKey: "telegramRawBody",
        missingRawBodyError: "raw body missing",
        verifySignature,
        parsePayload: () => ({ kind: "dispatch" as const, parsed: { ok: true } }),
        dispatch,
      },
    );

    const reply = createReply();
    await handler(createRequest(), reply as any);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({
      accepted: true,
      ignored: true,
      eventType: undefined,
      reason: "connection_disabled",
    });
    expect(verifySignature).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ignores inbound webhooks for a disconnected connection", async () => {
    const dispatch = vi.fn();
    const handler = createWebhookHandler(
      {
        services: {
          integrationWebhooks: {
            getIntegrationConnection: vi.fn(() => ({ key: "telegram", status: "disconnected", config: {} })),
          },
        },
      } as any,
      {
        source: "telegram",
        connectorKey: "telegram",
        connectorLabel: "Telegram",
        rawBodyKey: "telegramRawBody",
        missingRawBodyError: "raw body missing",
        verifySignature: () => ({ ok: true as const }),
        parsePayload: () => ({ kind: "dispatch" as const, parsed: { ok: true } }),
        dispatch,
      },
    );

    const reply = createReply();
    await handler(createRequest(), reply as any);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual(
      expect.objectContaining({ accepted: true, ignored: true, reason: "connection_disabled" }),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("caps a runaway self-reply loop via the bot-loop guard and records a diagnostic", async () => {
    let now = 1_000_000;
    const guard = new ChannelBotLoopGuard(
      { maxEventsPerWindow: 3, windowSeconds: 60, cooldownSeconds: 60, enabled: true },
      () => now,
    );
    const recordDevDiagnostic = vi.fn();
    const gateway = {
      ingestChannelMessage: vi.fn(async () => ({
        deduped: false,
        session: { sessionId: "session-loop" },
      })),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(async () => ({ turnId: "turn-loop" })),
      emitChannelActivity: vi.fn(async () => ({ effects: [] })),
      recordDevDiagnostic,
    };

    const dispatchOnce = (eventId: string) =>
      dispatchInboundWebhookMessage(
        gateway as any,
        {
          channel: "slack",
          connectionId: "11111111-1111-1111-1111-111111111111",
          idempotencyKey: `slack:${eventId}`,
          eventType: "message",
          bindingTarget: "C1",
          message: {
            eventId,
            account: "11111111-1111-1111-1111-111111111111",
            room: "C1",
            actorId: "U-BOT",
            content: "loop",
          },
        },
        guard,
      );

    for (let i = 0; i < 3; i++) {
      now += 100;
      const result = await dispatchOnce(`event-${i}`);
      expect(result.replied).toBe(true);
    }

    now += 100;
    const suppressed = await dispatchOnce("event-overflow");
    expect(suppressed).toEqual(
      expect.objectContaining({
        accepted: true,
        replied: false,
        suppressed: true,
        suppressedReason: "rate-cap",
        sessionId: "session-loop",
      }),
    );

    // The over-cap event is still ingested but never produces a reply turn.
    expect(gateway.ingestChannelMessage).toHaveBeenCalledTimes(4);
    expect(gateway.respondToExistingChatMessage).toHaveBeenCalledTimes(3);
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.bot_loop_suppressed", category: "channels" }),
    );
  });

  it("drops an inbound message from a sender that is not on a non-empty allowlist", async () => {
    const recordDevDiagnostic = vi.fn();
    const gateway = {
      ingestChannelMessage: vi.fn(),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
      emitChannelActivity: vi.fn(),
      recordDevDiagnostic,
    };

    const result = await dispatchInboundWebhookMessage(gateway as any, {
      channel: "slack",
      connectionId: "11111111-1111-1111-1111-111111111111",
      idempotencyKey: "slack:event-blocked",
      eventType: "message",
      bindingTarget: "C1",
      allowedSenders: ["U-OWNER"],
      message: {
        eventId: "event-blocked",
        account: "11111111-1111-1111-1111-111111111111",
        room: "C1",
        actorId: "U-Intruder",
        content: "let me in",
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        replied: false,
        ignored: true,
        reason: "sender_not_allowlisted",
        eventType: "message",
      }),
    );
    // No session is opened, no binding is set, and no turn is dispatched.
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.setChatSessionBinding).not.toHaveBeenCalled();
    expect(gateway.respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.sender_not_allowlisted", category: "channels" }),
    );
  });

  it("drops inbound messages when allowlist mode is enabled before senders are configured", async () => {
    const recordDevDiagnostic = vi.fn();
    const gateway = {
      ingestChannelMessage: vi.fn(),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
      emitChannelActivity: vi.fn(),
      recordDevDiagnostic,
    };

    const result = await dispatchInboundWebhookMessage(gateway as any, {
      channel: "slack",
      connectionId: "11111111-1111-1111-1111-111111111111",
      idempotencyKey: "slack:event-empty-allowlist",
      eventType: "message",
      bindingTarget: "C1",
      inboundAccessConfig: { inboundAccessMode: "allowlist" },
      message: {
        eventId: "event-empty-allowlist",
        account: "11111111-1111-1111-1111-111111111111",
        room: "C1",
        actorId: "U-Owner",
        content: "hello",
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        replied: false,
        ignored: true,
        reason: "allowlist_empty",
        inboundAccess: {
          mode: "allowlist",
          reason: "allowlist_empty",
        },
      }),
    );
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.inbound_allowlist_empty", category: "channels" }),
    );
  });

  it("drops inbound messages before ingest when stored inbound access config is malformed", async () => {
    const recordDevDiagnostic = vi.fn();
    const gateway = {
      ingestChannelMessage: vi.fn(),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
      emitChannelActivity: vi.fn(),
      recordDevDiagnostic,
    };

    const result = await dispatchInboundWebhookMessage(gateway as any, {
      channel: "slack",
      connectionId: "11111111-1111-1111-1111-111111111111",
      idempotencyKey: "slack:event-invalid-config",
      eventType: "message",
      bindingTarget: "C1",
      inboundAccessConfig: { inboundAccessMode: "allow_list", allowedSenders: ["U-OWNER"] },
      message: {
        eventId: "event-invalid-config",
        account: "11111111-1111-1111-1111-111111111111",
        room: "C1",
        actorId: "U-Intruder",
        content: "hello",
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        replied: false,
        ignored: true,
        reason: "invalid_config",
        inboundAccess: {
          mode: "allowlist",
          reason: "invalid_config",
        },
      }),
    );
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.setChatSessionBinding).not.toHaveBeenCalled();
    expect(gateway.respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.inbound_access_invalid_config", category: "channels" }),
    );
  });

  it("allows a listed sender through the allowlist using a case-insensitive trimmed match", async () => {
    const gateway = {
      ingestChannelMessage: vi.fn(async () => ({
        deduped: false,
        session: { sessionId: "session-allow" },
      })),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(async () => ({ turnId: "turn-allow" })),
      emitChannelActivity: vi.fn(async () => ({ effects: [] })),
      recordDevDiagnostic: vi.fn(),
    };

    const result = await dispatchInboundWebhookMessage(gateway as any, {
      channel: "slack",
      connectionId: "11111111-1111-1111-1111-111111111111",
      idempotencyKey: "slack:event-allow",
      eventType: "message",
      bindingTarget: "C1",
      allowedSenders: ["u-owner"],
      message: {
        eventId: "event-allow",
        account: "11111111-1111-1111-1111-111111111111",
        room: "C1",
        actorId: "  U-Owner  ",
        content: "hello",
      },
    });

    expect(result.replied).toBe(true);
    expect(gateway.ingestChannelMessage).toHaveBeenCalledTimes(1);
    expect(gateway.respondToExistingChatMessage).toHaveBeenCalledTimes(1);
  });

  it("treats an empty/unset allowlist as legacy-open for old connections and records migration evidence", async () => {
    const gateway = {
      ingestChannelMessage: vi.fn(async () => ({
        deduped: false,
        session: { sessionId: "session-open" },
      })),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(async () => ({ turnId: "turn-open" })),
      emitChannelActivity: vi.fn(async () => ({ effects: [] })),
      recordDevDiagnostic: vi.fn(),
    };

    const result = await dispatchInboundWebhookMessage(gateway as any, {
      channel: "slack",
      connectionId: "11111111-1111-1111-1111-111111111111",
      idempotencyKey: "slack:event-open",
      eventType: "message",
      bindingTarget: "C1",
      allowedSenders: [],
      message: {
        eventId: "event-open",
        account: "11111111-1111-1111-1111-111111111111",
        room: "C1",
        actorId: "anyone-at-all",
        content: "hello",
      },
    });

    expect(result.replied).toBe(true);
    expect(gateway.ingestChannelMessage).toHaveBeenCalledTimes(1);
    expect(gateway.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.inbound_access_legacy_open", category: "channels" }),
    );
  });

  it("binds the chat session and replies only when the inbound webhook event is new", async () => {
    const gateway = {
      ingestChannelMessage: vi.fn(async () => ({
        deduped: false,
        session: { sessionId: "session-1" },
      })),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(async () => ({ turnId: "turn-1" })),
      emitChannelActivity: vi.fn(async () => ({
        channelKey: "telegram",
        connectionId: "11111111-1111-1111-1111-111111111111",
        target: "room-1",
        messageId: "event-1",
        phase: "thinking",
        status: "sent",
        effects: [],
      })),
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
    expect(gateway.emitChannelActivity).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "seen", messageId: "event-1", target: "room-1" }),
    );
    expect(gateway.emitChannelActivity).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "thinking", messageId: "event-1", target: "room-1" }),
    );
    expect(gateway.emitChannelActivity).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "clear", messageId: "event-1", target: "room-1", turnId: "turn-1" }),
    );
  });
});
