import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { commsRoutes } from "./comms.js";

function decorateComms(app: FastifyInstance, methods: Record<string, unknown>) {
  app.decorate("services", { comms: methods } as never);
}

describe("comms routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("validates gmail send payloads", async () => {
    const commsGmailSend = vi.fn();
    app = Fastify();
    decorateComms(app, { commsGmailSend });
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comms/gmail/send",
      payload: {
        connectionId: "not-a-uuid",
        to: ["bad-email"],
        subject: "",
        bodyText: "",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(commsGmailSend).not.toHaveBeenCalled();
  });

  it("forwards calendar create requests to the gateway", async () => {
    const commsCalendarCreate = vi.fn(async () => ({ eventId: "evt-1" }));
    app = Fastify();
    decorateComms(app, { commsCalendarCreate });
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comms/calendar/create",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        title: "Review",
        startIso: "2026-03-05T10:00:00.000Z",
        endIso: "2026-03-05T10:30:00.000Z",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(commsCalendarCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Review",
      }),
    );
  });

  it("allows attachment-only channel sends", async () => {
    const rawSendResult = {
      deliveryId: "delivery-1",
      status: "sent",
      providerMessageId: "provider-message-1",
      providerPayload: {
        authorization: "Bearer send-short",
        receiptUrl: "https://provider.example.test/token/send-path?token=send-query",
        tokenId: "send-token-id",
        requestCount: 4,
      },
    };
    const commsSend = vi.fn(async () => rawSendResult);
    app = Fastify();
    decorateComms(app, { commsSend });
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comms/send",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        target: "imessage:+15551234567",
        attachmentIds: ["22222222-2222-4222-8222-222222222222"],
        message: "",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(commsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentIds: ["22222222-2222-4222-8222-222222222222"],
        message: "",
      }),
    );
    expect(response.json()).toMatchObject({
      deliveryId: "delivery-1",
      providerMessageId: "provider-message-1",
      providerPayload: {
        authorization: "[REDACTED]",
        receiptUrl: "https://provider.example.test/token/[REDACTED]?token=[REDACTED]",
        tokenId: "send-token-id",
        requestCount: 4,
      },
    });
    expect(rawSendResult.providerPayload.authorization).toBe("Bearer send-short");
    expect(rawSendResult.providerPayload.receiptUrl).toContain("send-path");
  });

  it("forwards explicit channel replies to the gateway", async () => {
    const commsReply = vi.fn(async () => ({ deliveryId: "delivery-reply", status: "sent" }));
    app = Fastify();
    decorateComms(app, { commsReply });
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comms/reply",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        target: "channel:123",
        replyToMessageId: "msg-789",
        message: "Reply body",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(commsReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "msg-789",
        message: "Reply body",
      }),
    );
  });

  it("forwards channel reactions to the gateway", async () => {
    const commsReact = vi.fn(async () => ({ deliveryId: "delivery-2", status: "sent" }));
    app = Fastify();
    decorateComms(app, { commsReact });
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comms/react",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        target: "imessage:+15551234567",
        messageId: "msg-123",
        reaction: "love",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(commsReact).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-123",
        reaction: "love",
      }),
    );
  });

  it("forwards channel unsend requests to the gateway", async () => {
    const commsUnsend = vi.fn(async () => ({ deliveryId: "delivery-3", status: "sent" }));
    app = Fastify();
    decorateComms(app, { commsUnsend });
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comms/unsend",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        messageId: "msg-456",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(commsUnsend).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-456",
      }),
    );
  });

  it("forwards typing requests to the gateway", async () => {
    const commsTyping = vi.fn(async () => ({
      channelKey: "discord",
      connectionId: "11111111-1111-4111-8111-111111111111",
      target: "channel:123",
      supported: true,
      status: "sent",
    }));
    app = Fastify();
    decorateComms(app, { commsTyping });
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comms/typing",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        target: "channel:123",
        durationMs: 5000,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(commsTyping).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "channel:123",
        durationMs: 5000,
      }),
    );
  });

  it("forwards channel activity requests to the gateway", async () => {
    const commsActivity = vi.fn(async () => ({
      channelKey: "telegram",
      connectionId: "11111111-1111-4111-8111-111111111111",
      target: "chat:123",
      messageId: "msg-1",
      phase: "thinking",
      status: "sent",
      emoji: "🧠",
      effects: [{ effect: "mission_control", supported: true, status: "sent" }],
    }));
    app = Fastify();
    decorateComms(app, { commsActivity });
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comms/activity",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        target: "chat:123",
        messageId: "msg-1",
        phase: "thinking",
        sessionId: "session-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(commsActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "chat:123",
        messageId: "msg-1",
        phase: "thinking",
        sessionId: "session-1",
      }),
    );
  });

  it("lists channel delivery runtime records with retry and stale state visible", async () => {
    const listChannelDeliveryRuntime = vi.fn(() => [
      {
        deliveryId: "delivery-retry",
        connectionId: "11111111-1111-4111-8111-111111111111",
        channelKey: "discord",
        target: "channel:123",
        status: "retrying",
        deliveryStatus: "retrying",
        attempts: 2,
        maxAttempts: 3,
        nextAttemptAt: "2026-05-05T12:00:00.000Z",
        fallbackReason: "rate limited",
        deliveryDiagnostics: {
          chunking: {
            mode: "unicode_safe",
            originalCodePointLength: 4100,
            partCount: 3,
            maxPartUtf16Length: 1900,
            parts: [
              { partIndex: 0, codePointLength: 1900, utf16Length: 1900 },
              { partIndex: 1, codePointLength: 1900, utf16Length: 1900 },
              { partIndex: 2, codePointLength: 300, utf16Length: 300 },
            ],
          },
          provider: {
            authorization: "Bearer delivery-short",
            statusUrl: "https://provider.example.test/access-token/delivery-path?token=delivery-query",
            tokenId: "delivery-token-id",
            requestCount: 7,
          },
        },
        createdAt: "2026-05-05T11:00:00.000Z",
        updatedAt: "2026-05-05T11:30:00.000Z",
      },
      {
        deliveryId: "delivery-stale",
        connectionId: "22222222-2222-4222-8222-222222222222",
        channelKey: "telegram",
        target: "chat:456",
        status: "stale",
        deliveryStatus: "degraded",
        attempts: 0,
        maxAttempts: 3,
        staleReason: "Delivery became stale before it could be sent.",
        error: "stale",
        fallbackReason: "Delivery became stale before it could be sent.",
        providerMessageId: "telegram-msg-1",
        createdAt: "2026-05-05T10:00:00.000Z",
        updatedAt: "2026-05-05T10:20:00.000Z",
      },
    ]);
    app = Fastify();
    decorateComms(app, { listChannelDeliveryRuntime });
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/comms/deliveries",
    });

    expect(response.statusCode).toBe(200);
    expect(listChannelDeliveryRuntime).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({
      count: 2,
      deliveries: [
        expect.objectContaining({
          deliveryId: "delivery-retry",
          status: "retrying",
          deliveryStatus: "retrying",
          attempts: 2,
          maxAttempts: 3,
          nextAttemptAt: "2026-05-05T12:00:00.000Z",
          fallbackReason: "rate limited",
          deliveryDiagnostics: expect.objectContaining({
            chunking: expect.objectContaining({
              mode: "unicode_safe",
              partCount: 3,
            }),
            provider: {
              authorization: "[REDACTED]",
              statusUrl: "https://provider.example.test/access-token/[REDACTED]?token=[REDACTED]",
              tokenId: "delivery-token-id",
              requestCount: 7,
            },
          }),
        }),
        expect.objectContaining({
          deliveryId: "delivery-stale",
          status: "stale",
          deliveryStatus: "degraded",
          staleReason: "Delivery became stale before it could be sent.",
          providerMessageId: "telegram-msg-1",
          error: "stale",
        }),
      ],
    });
  });

  it("filters channel delivery runtime records by connection id and caps the limit", async () => {
    const listChannelDeliveryRuntime = vi.fn(() => [
      {
        deliveryId: "delivery-one",
        connectionId: "11111111-1111-4111-8111-111111111111",
        channelKey: "discord",
        target: "channel:123",
        status: "queued",
        attempts: 0,
        maxAttempts: 3,
        createdAt: "2026-05-05T11:00:00.000Z",
        updatedAt: "2026-05-05T11:00:00.000Z",
      },
      {
        deliveryId: "delivery-two",
        connectionId: "11111111-1111-4111-8111-111111111111",
        channelKey: "discord",
        target: "channel:456",
        status: "queued",
        attempts: 0,
        maxAttempts: 3,
        createdAt: "2026-05-05T11:01:00.000Z",
        updatedAt: "2026-05-05T11:01:00.000Z",
      },
      {
        deliveryId: "delivery-other",
        connectionId: "22222222-2222-4222-8222-222222222222",
        channelKey: "telegram",
        target: "chat:456",
        status: "queued",
        attempts: 0,
        maxAttempts: 3,
        createdAt: "2026-05-05T11:02:00.000Z",
        updatedAt: "2026-05-05T11:02:00.000Z",
      },
    ]);
    app = Fastify();
    decorateComms(app, { listChannelDeliveryRuntime });
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/comms/deliveries?connectionId=11111111-1111-4111-8111-111111111111&limit=1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      count: 1,
      deliveries: [
        expect.objectContaining({
          deliveryId: "delivery-one",
          connectionId: "11111111-1111-4111-8111-111111111111",
        }),
      ],
    });
  });

  it("returns channel capabilities from the gateway", async () => {
    const getIntegrationConnectionChannelCapabilities = vi.fn(() => ({
      channelKey: "discord",
      supportedActions: [
        "channel.send",
        "channel.reply",
        "channel.react",
        "channel.unsend",
        "channel.typing",
        "channel.activity",
      ],
      supportedDeliveryActions: [
        "channel.send",
        "channel.reply",
        "channel.react",
        "channel.unsend",
        "channel.typing",
        "channel.activity",
      ],
      supportedAttachmentSources: ["url", "inline"],
      inboundModes: ["gateway"],
      threadCapabilities: { rooms: true, threads: true, replies: true, direct: true, groups: true },
      runtimePolicy: {
        pairing: true,
        allowlist: true,
        mentionGating: true,
        typing: true,
        activity: true,
        presence: true,
      },
      activityCapabilities: {
        supported: true,
        phases: ["seen", "thinking", "tooling", "waiting_approval", "failed", "clear"],
        nativeEffects: ["mission_control", "reaction", "reaction_clear", "typing"],
        clearOnTerminal: true,
        activityEmoji: { seen: "👀" },
      },
      runtimePosture: {
        outboundTransport: "api",
        inboundTransport: "gateway",
        lifecycle: "persistent",
        inboundReadiness: "ready",
        operatorSummary:
          "Persistent gateway runtime keeps Discord inbound messages, typing, and presence synchronized in-process.",
      },
      chunkingMode: "fallback",
      supportsStreaming: false,
      supportNotes: [],
      setupDiagnostics: [],
      setupReady: true,
    }));
    app = Fastify();
    decorateComms(app, { getIntegrationConnectionChannelCapabilities });
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/comms/capabilities/11111111-1111-4111-8111-111111111111",
    });

    expect(response.statusCode).toBe(200);
    expect(getIntegrationConnectionChannelCapabilities).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("returns normalized channel runtime status from the gateway", async () => {
    const rawRuntime = {
      connectionId: "11111111-1111-4111-8111-111111111111",
      channelKey: "discord",
      enabled: true,
      ready: true,
      inboundModes: ["gateway"],
      runtimePolicy: {
        pairing: true,
        allowlist: true,
        mentionGating: true,
        typing: true,
        activity: true,
        presence: true,
      },
      runtimePosture: {
        outboundTransport: "api",
        inboundTransport: "gateway",
        lifecycle: "persistent",
        inboundReadiness: "ready",
        operatorSummary:
          "Persistent gateway runtime keeps Discord inbound messages, typing, and presence synchronized in-process.",
      },
      lastReadyAt: "2026-03-31T00:00:00.000Z",
      lastError: "Authorization: Bearer runtime-short",
      metadata: {
        setupReady: true,
        providerEndpoint: "https://discord.example.test/client-secret/runtime-path?token=runtime-query",
        tokenId: "runtime-token-id",
        reconnectCount: 3,
      },
    };
    const getIntegrationConnectionChannelRuntimeStatus = vi.fn(() => rawRuntime);
    app = Fastify();
    decorateComms(app, { getIntegrationConnectionChannelRuntimeStatus });
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/comms/runtime/11111111-1111-4111-8111-111111111111",
    });

    expect(response.statusCode).toBe(200);
    expect(getIntegrationConnectionChannelRuntimeStatus).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(response.json()).toMatchObject({
      connectionId: "11111111-1111-4111-8111-111111111111",
      lastError: "Authorization: [REDACTED]",
      metadata: {
        providerEndpoint: "https://discord.example.test/client-secret/[REDACTED]?token=[REDACTED]",
        tokenId: "runtime-token-id",
        reconnectCount: 3,
      },
    });
    expect(rawRuntime.lastError).toContain("runtime-short");
    expect(rawRuntime.metadata.providerEndpoint).toContain("runtime-path");
  });

  it("proxies channel diagnostics through the comms route", async () => {
    const rawDiagnostics = {
      connectorType: "integration_connection",
      connectorId: "11111111-1111-4111-8111-111111111111",
      status: "ok",
      checks: [
        {
          key: "provider",
          status: "warn",
          message: "Probe https://discord.example.test/api-key/diagnostic-path?token=diagnostic-query failed.",
          metadata: {
            authorization: "Bearer diagnostic-short",
            tokenId: "diagnostic-token-id",
            latencyMs: 42,
          },
        },
      ],
      checkedAt: "2026-03-29T00:00:00.000Z",
    };
    const runIntegrationConnectionDiagnostics = vi.fn(async () => rawDiagnostics);
    app = Fastify();
    decorateComms(app, { runIntegrationConnectionDiagnostics });
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/comms/diagnostics/11111111-1111-4111-8111-111111111111",
    });

    expect(response.statusCode).toBe(200);
    expect(runIntegrationConnectionDiagnostics).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(response.json()).toMatchObject({
      connectorId: "11111111-1111-4111-8111-111111111111",
      checks: [
        {
          message: "Probe https://discord.example.test/api-key/[REDACTED]?token=[REDACTED] failed.",
          metadata: {
            authorization: "[REDACTED]",
            tokenId: "diagnostic-token-id",
            latencyMs: 42,
          },
        },
      ],
    });
    expect(rawDiagnostics.checks[0]!.message).toContain("diagnostic-path");
    expect(rawDiagnostics.checks[0]!.metadata.authorization).toBe("Bearer diagnostic-short");
  });

  it("rejects malformed comms payloads before invoking channel services", async () => {
    const methods = {
      listChannelDeliveryRuntime: vi.fn(),
      commsSend: vi.fn(),
      commsReply: vi.fn(),
      commsReact: vi.fn(),
      commsUnsend: vi.fn(),
      commsTyping: vi.fn(),
      commsGmailRead: vi.fn(),
      commsCalendarList: vi.fn(),
    };
    app = Fastify();
    decorateComms(app, methods);
    await app.register(commsRoutes);

    const cases = [
      { method: "GET", url: "/api/v1/comms/deliveries?limit=500" },
      {
        method: "POST",
        url: "/api/v1/comms/send",
        payload: { connectionId: "11111111-1111-4111-8111-111111111111", target: "channel:123", message: "   " },
      },
      {
        method: "POST",
        url: "/api/v1/comms/reply",
        payload: {
          connectionId: "11111111-1111-4111-8111-111111111111",
          target: "channel:123",
          replyToMessageId: "msg-1",
          message: "",
        },
      },
      {
        method: "POST",
        url: "/api/v1/comms/react",
        payload: { connectionId: "not-a-uuid", messageId: "", reaction: "" },
      },
      {
        method: "POST",
        url: "/api/v1/comms/unsend",
        payload: { connectionId: "not-a-uuid", messageId: "" },
      },
      {
        method: "POST",
        url: "/api/v1/comms/typing",
        payload: {
          connectionId: "11111111-1111-4111-8111-111111111111",
          target: "channel:123",
          durationMs: 120_000,
        },
      },
      {
        method: "POST",
        url: "/api/v1/comms/gmail/read",
        payload: { connectionId: "not-a-uuid", maxResults: 101 },
      },
      {
        method: "POST",
        url: "/api/v1/comms/calendar/list",
        payload: { connectionId: "not-a-uuid", maxResults: 500 },
      },
      {
        method: "POST",
        url: "/api/v1/comms/calendar/create",
        payload: {
          connectionId: "11111111-1111-4111-8111-111111111111",
          title: "Review",
          startIso: "not-a-date",
          endIso: "also-not-a-date",
        },
      },
    ] as const;

    for (const item of cases) {
      const response = await app.inject(item);
      expect(response.statusCode).toBe(400);
    }

    for (const method of Object.values(methods)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("normalizes comms lookup failures into not-found and conflict responses", async () => {
    const capabilityError =
      "Capability probe https://provider.example.test/token/capability-error-path?token=capability-error-query failed with Bearer capability-error-short";
    const runtimeError =
      "Runtime probe https://provider.example.test/client-secret/runtime-error-path?token=runtime-error-query failed";
    app = Fastify();
    decorateComms(app, {
      getIntegrationConnectionChannelCapabilities: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("unknown integration connection conn-1");
        })
        .mockImplementationOnce(() => {
          throw new Error(capabilityError);
        }),
      getIntegrationConnectionChannelRuntimeStatus: vi.fn(() => {
        throw new Error(runtimeError);
      }),
      runIntegrationConnectionDiagnostics: vi.fn(async () => {
        throw new Error("unknown integration connection conn-1");
      }),
    });
    await app.register(commsRoutes);

    const invalidParams = await app.inject({
      method: "GET",
      url: "/api/v1/comms/capabilities/not-a-uuid",
    });
    expect(invalidParams.statusCode).toBe(400);

    const notFound = await app.inject({
      method: "GET",
      url: "/api/v1/comms/capabilities/11111111-1111-4111-8111-111111111111",
    });
    expect(notFound.statusCode).toBe(404);

    const conflict = await app.inject({
      method: "GET",
      url: "/api/v1/comms/capabilities/11111111-1111-4111-8111-111111111111",
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).not.toContain("capability-error-path");
    expect(conflict.body).not.toContain("capability-error-query");
    expect(conflict.body).not.toContain("capability-error-short");

    const runtimeConflict = await app.inject({
      method: "GET",
      url: "/api/v1/comms/runtime/11111111-1111-4111-8111-111111111111",
    });
    expect(runtimeConflict.statusCode).toBe(409);
    expect(runtimeConflict.body).not.toContain("runtime-error-path");
    expect(runtimeConflict.body).not.toContain("runtime-error-query");
    expect(capabilityError).toContain("capability-error-path");
    expect(runtimeError).toContain("runtime-error-path");

    const diagnosticsNotFound = await app.inject({
      method: "GET",
      url: "/api/v1/comms/diagnostics/11111111-1111-4111-8111-111111111111",
    });
    expect(diagnosticsNotFound.statusCode).toBe(404);
  });

  it("forwards remaining successful comms productivity requests", async () => {
    const commsGmailRead = vi.fn(async () => ({ messages: [] }));
    const commsGmailSend = vi.fn(async () => ({ messageId: "gmail-1" }));
    const commsCalendarList = vi.fn(async () => ({ items: [] }));
    app = Fastify();
    decorateComms(app, { commsGmailRead, commsGmailSend, commsCalendarList });
    await app.register(commsRoutes);

    const gmailRead = await app.inject({
      method: "POST",
      url: "/api/v1/comms/gmail/read",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        query: "from:ops@example.test",
        maxResults: 10,
      },
    });
    expect(gmailRead.statusCode).toBe(200);
    expect(commsGmailRead).toHaveBeenCalledWith(
      expect.objectContaining({ query: "from:ops@example.test", maxResults: 10 }),
    );

    const gmailSend = await app.inject({
      method: "POST",
      url: "/api/v1/comms/gmail/send",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        to: ["ops@example.test"],
        subject: "Status",
        bodyText: "Ready",
      },
    });
    expect(gmailSend.statusCode).toBe(200);
    expect(commsGmailSend).toHaveBeenCalledWith(expect.objectContaining({ subject: "Status" }));

    const calendarList = await app.inject({
      method: "POST",
      url: "/api/v1/comms/calendar/list",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        fromIso: "2026-03-05T10:00:00.000Z",
        toIso: "2026-03-05T11:00:00.000Z",
      },
    });
    expect(calendarList.statusCode).toBe(200);
    expect(commsCalendarList).toHaveBeenCalledWith(expect.objectContaining({ fromIso: "2026-03-05T10:00:00.000Z" }));
  });

  it("rejects malformed runtime and diagnostics params before service lookup", async () => {
    const getIntegrationConnectionChannelRuntimeStatus = vi.fn();
    const runIntegrationConnectionDiagnostics = vi.fn();
    app = Fastify();
    decorateComms(app, {
      getIntegrationConnectionChannelRuntimeStatus,
      runIntegrationConnectionDiagnostics,
    });
    await app.register(commsRoutes);

    const runtime = await app.inject({
      method: "GET",
      url: "/api/v1/comms/runtime/not-a-uuid",
    });
    expect(runtime.statusCode).toBe(400);

    const diagnostics = await app.inject({
      method: "GET",
      url: "/api/v1/comms/diagnostics/not-a-uuid",
    });
    expect(diagnostics.statusCode).toBe(400);
    expect(getIntegrationConnectionChannelRuntimeStatus).not.toHaveBeenCalled();
    expect(runIntegrationConnectionDiagnostics).not.toHaveBeenCalled();
  });
});
