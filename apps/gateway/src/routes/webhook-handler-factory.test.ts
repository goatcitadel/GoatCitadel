import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_INBOUND_MAX_BYTES,
  createWebhookHandler,
  createWebhookPreParsing,
  dispatchInboundWebhookCommand,
  dispatchInboundVoiceWebhookMessage,
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

  it("maps streamed oversized pre-parsing payloads to a 413 error", async () => {
    const preParsing = createWebhookPreParsing("telegramRawBody");
    const request = createRequest({ telegramRawBody: undefined });
    const payload = Readable.from([Buffer.alloc(CHANNEL_INBOUND_MAX_BYTES + 1)]);

    await expect(preParsing(request, createReply() as any, payload)).rejects.toMatchObject({
      statusCode: 413,
      message: `Inbound channel payload too large. Max ${CHANNEL_INBOUND_MAX_BYTES} bytes.`,
    });
    expect((request as WebhookRawBodyRequest).telegramRawBody).toBeUndefined();
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

  it("delegates every allowed message to durable acceptance without inline side effects", async () => {
    const acceptInboundChannelEvent = vi.fn(async (input: { eventType: string; message: { eventId: string } }) => ({
      accepted: true as const,
      durableAccepted: true as const,
      deduped: false,
      replied: false as const,
      queued: true,
      eventType: input.eventType,
      inboundEventId: `inbound:${input.message.eventId}`,
    }));
    const gateway = {
      acceptInboundChannelEvent,
      ingestChannelMessage: vi.fn(),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
      emitChannelActivity: vi.fn(),
      recordDevDiagnostic: vi.fn(),
    };

    const dispatchOnce = (eventId: string) =>
      dispatchInboundWebhookMessage(gateway as any, {
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
      });

    for (let i = 0; i < 4; i++) {
      const result = await dispatchOnce(`event-${i}`);
      expect(result).toEqual(
        expect.objectContaining({ durableAccepted: true, replied: false, inboundEventId: `inbound:event-${i}` }),
      );
    }

    expect(acceptInboundChannelEvent).toHaveBeenCalledTimes(4);
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.setChatSessionBinding).not.toHaveBeenCalled();
    expect(gateway.respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(gateway.emitChannelActivity).not.toHaveBeenCalled();
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
    const acceptInboundChannelEvent = vi.fn(async () => ({
      accepted: true as const,
      durableAccepted: true as const,
      deduped: false,
      replied: false as const,
      queued: true,
      eventType: "message",
      inboundEventId: "inbound:event-allow",
    }));
    const gateway = {
      acceptInboundChannelEvent,
      ingestChannelMessage: vi.fn(),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
      emitChannelActivity: vi.fn(),
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

    expect(result).toEqual(expect.objectContaining({ durableAccepted: true, replied: false, queued: true }));
    expect(acceptInboundChannelEvent).toHaveBeenCalledTimes(1);
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.respondToExistingChatMessage).not.toHaveBeenCalled();
  });

  it("treats an empty/unset allowlist as legacy-open for old connections and records migration evidence", async () => {
    const acceptInboundChannelEvent = vi.fn(async () => ({
      accepted: true as const,
      durableAccepted: true as const,
      deduped: false,
      replied: false as const,
      queued: true,
      eventType: "message",
      inboundEventId: "inbound:event-open",
    }));
    const gateway = {
      acceptInboundChannelEvent,
      ingestChannelMessage: vi.fn(),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
      emitChannelActivity: vi.fn(),
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

    expect(result).toEqual(expect.objectContaining({ durableAccepted: true, replied: false, queued: true }));
    expect(acceptInboundChannelEvent).toHaveBeenCalledTimes(1);
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.inbound_access_legacy_open", category: "channels" }),
    );
  });

  it("durably accepts a new inbound event without inline session mutation", async () => {
    const acceptInboundChannelEvent = vi.fn(async () => ({
      accepted: true as const,
      durableAccepted: true as const,
      deduped: false,
      replied: false as const,
      queued: true,
      eventType: "message.created",
      inboundEventId: "inbound:event-1",
    }));
    const gateway = {
      acceptInboundChannelEvent,
      ingestChannelMessage: vi.fn(),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
      emitChannelActivity: vi.fn(),
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
      durableAccepted: true,
      deduped: false,
      replied: false,
      queued: true,
      eventType: "message.created",
      inboundEventId: "inbound:event-1",
    });
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({ bindingTarget: "room-1", dispatchKind: "agent_turn" }),
    );
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.setChatSessionBinding).not.toHaveBeenCalled();
    expect(gateway.respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(gateway.emitChannelActivity).not.toHaveBeenCalled();
  });
});

describe("dispatchInboundWebhookCommand", () => {
  const input = {
    channel: "telegram",
    connectionId: "11111111-1111-1111-1111-111111111111",
    idempotencyKey: "telegram:command-1",
    eventType: "telegram-channel-command",
    bindingTarget: "chat-1",
    inboundAccessConfig: { botToken: "must-not-persist", inboundAccessMode: "allowlist" },
    allowedSenders: ["user-1"],
    message: {
      eventId: "command-1",
      account: "11111111-1111-1111-1111-111111111111",
      actorId: "user-1",
      content: "/status",
    },
  };

  it("commits a secret-free command before waiting for its durable result", async () => {
    const order: string[] = [];
    const gateway = {
      acceptInboundChannelEvent: vi.fn(async () => {
        order.push("accepted");
        return {
          accepted: true as const,
          durableAccepted: true as const,
          deduped: false,
          replied: false as const,
          queued: true,
          eventType: input.eventType,
          inboundEventId: "inbound-command-1",
        };
      }),
      awaitInboundChannelCommandResult: vi.fn(async () => {
        order.push("settled");
        return { status: "completed" as const, resultText: "Status ready." };
      }),
    };

    const result = await dispatchInboundWebhookCommand(gateway as any, input);

    expect(order).toEqual(["accepted", "settled"]);
    expect(result.result).toEqual({ status: "completed", resultText: "Status ready." });
    expect(gateway.acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchKind: "command" }),
    );
    const accepted = gateway.acceptInboundChannelEvent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(accepted).not.toHaveProperty("inboundAccessConfig");
    expect(accepted).not.toHaveProperty("allowedSenders");
    expect(JSON.stringify(accepted)).not.toContain("must-not-persist");
  });

  it("replays a terminal duplicate result without waiting or executing again", async () => {
    const gateway = {
      acceptInboundChannelEvent: vi.fn(async () => ({
        accepted: true as const,
        durableAccepted: true as const,
        deduped: true,
        replied: false as const,
        queued: false,
        eventType: input.eventType,
        inboundEventId: "inbound-command-1",
        commandResultText: "Stored result.",
      })),
      awaitInboundChannelCommandResult: vi.fn(),
    };

    const result = await dispatchInboundWebhookCommand(gateway as any, input);

    expect(result.result).toEqual({ status: "completed", resultText: "Stored result." });
    expect(gateway.awaitInboundChannelCommandResult).not.toHaveBeenCalled();
  });

  it("fails closed when the durable command owner is unavailable", async () => {
    await expect(dispatchInboundWebhookCommand({} as any, input)).rejects.toThrow(
      "Durable inbound command acceptance is unavailable",
    );
  });
});

describe("dispatchInboundVoiceWebhookMessage (channelVoiceInboundV1Enabled)", () => {
  function createVoiceGateway() {
    const acceptedPayloads = new Map<string, string>();
    return {
      ingestChannelMessage: vi.fn(async () => ({
        deduped: false,
        session: { sessionId: "session-voice" },
      })),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(async () => ({ turnId: "turn-voice" })),
      emitChannelActivity: vi.fn(async () => ({ effects: [] })),
      recordDevDiagnostic: vi.fn(),
      parseChatCommand: vi.fn(),
      resolveApprovalWithRemoteToken: vi.fn(),
      acceptInboundChannelEvent: vi.fn(async (input: { idempotencyKey: string; eventType: string }) => {
        const payload = JSON.stringify(input);
        const existing = acceptedPayloads.get(input.idempotencyKey);
        if (existing !== undefined && existing !== payload) {
          throw new Error("durable payload mismatch");
        }
        acceptedPayloads.set(input.idempotencyKey, payload);
        return {
          accepted: true as const,
          durableAccepted: true as const,
          deduped: existing !== undefined,
          replied: false as const,
          queued: true,
          eventType: input.eventType,
          inboundEventId: `inbound:${input.idempotencyKey}`,
        };
      }),
    };
  }

  const baseOptions = {
    channel: "telegram",
    connectionId: "11111111-1111-1111-1111-111111111111",
    idempotencyKey: "telegram:voice-1",
    eventType: "message",
    bindingTarget: "chat-1",
    message: {
      eventId: "voice-1",
      account: "11111111-1111-1111-1111-111111111111",
      peer: "chat-1",
      actorId: "U-OWNER",
      content: "[telegram voice message]",
    },
  };

  it("runs the sender trust gate BEFORE any download/transcription", async () => {
    const gateway = createVoiceGateway();
    const transcribe = vi.fn(async () => ({ ok: true as const, transcript: "should never run" }));

    const result = await dispatchInboundVoiceWebhookMessage(gateway as any, {
      ...baseOptions,
      allowedSenders: ["someone-else"],
      voice: {
        request: { channel: "telegram", connectionConfig: {}, fileId: "voice-file-1", mimeType: "audio/ogg" },
        fallbackContent: baseOptions.message.content,
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        replied: false,
        ignored: true,
        reason: "sender_not_allowlisted",
      }),
    );
    // Governance-critical pin: a non-allowlisted sender never triggers a media
    // download or a whisper subprocess spawn.
    expect(transcribe).not.toHaveBeenCalled();
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.setChatSessionBinding).not.toHaveBeenCalled();
  });

  it("acknowledges only after the secret-free voice reference is durably accepted", async () => {
    const gateway = createVoiceGateway();

    const result = await dispatchInboundVoiceWebhookMessage(gateway as any, {
      ...baseOptions,
      allowedSenders: ["u-owner"],
      voice: {
        request: { channel: "telegram", connectionConfig: {}, fileId: "voice-file-1", mimeType: "audio/ogg" },
        fallbackContent: baseOptions.message.content,
      },
    });

    expect(result).toEqual({
      accepted: true,
      durableAccepted: true,
      deduped: false,
      replied: false,
      queued: true,
      eventType: "message",
      inboundEventId: "inbound:telegram:voice-1",
    });
    expect(gateway.acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchKind: "voice_agent_turn",
        voiceRequest: {
          channel: "telegram",
          connectionConfig: {},
          fileId: "voice-file-1",
          mimeType: "audio/ogg",
        },
        voiceFallbackContent: "[telegram voice message]",
      }),
    );
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
    expect(gateway.respondToExistingChatMessage).not.toHaveBeenCalled();
  });

  it("delegates duplicate voice callbacks to the persistent acceptance owner", async () => {
    const gateway = createVoiceGateway();
    const options = {
      ...baseOptions,
      allowedSenders: ["u-owner"],
      voice: {
        request: {
          channel: "telegram" as const,
          connectionConfig: {},
          fileId: "voice-file-1",
          mimeType: "audio/ogg",
        },
        fallbackContent: baseOptions.message.content,
      },
    };

    const first = await dispatchInboundVoiceWebhookMessage(gateway as any, options);
    const duplicate = await dispatchInboundVoiceWebhookMessage(gateway as any, options);

    expect(first).toMatchObject({ durableAccepted: true, deduped: false });
    expect(duplicate).toMatchObject({ durableAccepted: true, deduped: true });
    expect(gateway.acceptInboundChannelEvent).toHaveBeenCalledTimes(2);
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
  });

  it("fails closed instead of acknowledging through process-local fallback state", async () => {
    const gateway = createVoiceGateway();
    Reflect.deleteProperty(gateway, "acceptInboundChannelEvent");

    await expect(
      dispatchInboundVoiceWebhookMessage(gateway as any, {
        ...baseOptions,
        allowedSenders: ["u-owner"],
        voice: {
          request: { channel: "telegram", connectionConfig: {}, fileId: "voice-file-1" },
          fallbackContent: baseOptions.message.content,
        },
      }),
    ).rejects.toThrow("Durable inbound channel acceptance is unavailable for voice events");
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
  });

  it("propagates durable acceptance failure so the provider can retry", async () => {
    const gateway = createVoiceGateway();
    gateway.acceptInboundChannelEvent.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      dispatchInboundVoiceWebhookMessage(gateway as any, {
        ...baseOptions,
        allowedSenders: ["u-owner"],
        voice: {
          request: { channel: "telegram", connectionConfig: {}, fileId: "voice-file-1" },
          fallbackContent: baseOptions.message.content,
        },
      }),
    ).rejects.toThrow("storage unavailable");
    expect(gateway.ingestChannelMessage).not.toHaveBeenCalled();
  });
});
