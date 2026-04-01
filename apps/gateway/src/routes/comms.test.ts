import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { commsRoutes } from "./comms.js";

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
    app.decorate("gateway", { commsGmailSend } as never);
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
    app.decorate("gateway", { commsCalendarCreate } as never);
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
    expect(commsCalendarCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: "Review",
    }));
  });

  it("allows attachment-only channel sends", async () => {
    const commsSend = vi.fn(async () => ({ deliveryId: "delivery-1", status: "sent" }));
    app = Fastify();
    app.decorate("gateway", { commsSend } as never);
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
    expect(commsSend).toHaveBeenCalledWith(expect.objectContaining({
      attachmentIds: ["22222222-2222-4222-8222-222222222222"],
      message: "",
    }));
  });

  it("forwards explicit channel replies to the gateway", async () => {
    const commsReply = vi.fn(async () => ({ deliveryId: "delivery-reply", status: "sent" }));
    app = Fastify();
    app.decorate("gateway", { commsReply } as never);
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
    expect(commsReply).toHaveBeenCalledWith(expect.objectContaining({
      replyToMessageId: "msg-789",
      message: "Reply body",
    }));
  });

  it("forwards channel reactions to the gateway", async () => {
    const commsReact = vi.fn(async () => ({ deliveryId: "delivery-2", status: "sent" }));
    app = Fastify();
    app.decorate("gateway", { commsReact } as never);
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
    expect(commsReact).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "msg-123",
      reaction: "love",
    }));
  });

  it("forwards channel unsend requests to the gateway", async () => {
    const commsUnsend = vi.fn(async () => ({ deliveryId: "delivery-3", status: "sent" }));
    app = Fastify();
    app.decorate("gateway", { commsUnsend } as never);
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
    expect(commsUnsend).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "msg-456",
    }));
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
    app.decorate("gateway", { commsTyping } as never);
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
    expect(commsTyping).toHaveBeenCalledWith(expect.objectContaining({
      target: "channel:123",
      durationMs: 5000,
    }));
  });

  it("returns channel capabilities from the gateway", async () => {
    const getIntegrationConnectionChannelCapabilities = vi.fn(() => ({
      channelKey: "discord",
      supportedActions: ["channel.send", "channel.reply", "channel.react", "channel.unsend", "channel.typing"],
      supportedDeliveryActions: ["channel.send", "channel.reply", "channel.react", "channel.unsend", "channel.typing"],
      supportedAttachmentSources: ["url", "inline"],
      inboundModes: ["gateway"],
      threadCapabilities: { rooms: true, threads: true, replies: true, direct: true, groups: true },
      runtimePolicy: { pairing: true, allowlist: true, mentionGating: true, typing: true, presence: true },
      runtimePosture: {
        outboundTransport: "api",
        inboundTransport: "gateway",
        lifecycle: "persistent",
        inboundReadiness: "ready",
        operatorSummary: "Persistent gateway runtime keeps Discord inbound messages, typing, and presence synchronized in-process.",
      },
      chunkingMode: "fallback",
      supportsStreaming: false,
      supportNotes: [],
      setupDiagnostics: [],
      setupReady: true,
    }));
    app = Fastify();
    app.decorate("gateway", { getIntegrationConnectionChannelCapabilities } as never);
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/comms/capabilities/11111111-1111-4111-8111-111111111111",
    });

    expect(response.statusCode).toBe(200);
    expect(getIntegrationConnectionChannelCapabilities).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("returns normalized channel runtime status from the gateway", async () => {
    const getIntegrationConnectionChannelRuntimeStatus = vi.fn(() => ({
      connectionId: "11111111-1111-4111-8111-111111111111",
      channelKey: "discord",
      enabled: true,
      ready: true,
      inboundModes: ["gateway"],
      runtimePolicy: { pairing: true, allowlist: true, mentionGating: true, typing: true, presence: true },
      runtimePosture: {
        outboundTransport: "api",
        inboundTransport: "gateway",
        lifecycle: "persistent",
        inboundReadiness: "ready",
        operatorSummary: "Persistent gateway runtime keeps Discord inbound messages, typing, and presence synchronized in-process.",
      },
      lastReadyAt: "2026-03-31T00:00:00.000Z",
      metadata: { setupReady: true },
    }));
    app = Fastify();
    app.decorate("gateway", { getIntegrationConnectionChannelRuntimeStatus } as never);
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/comms/runtime/11111111-1111-4111-8111-111111111111",
    });

    expect(response.statusCode).toBe(200);
    expect(getIntegrationConnectionChannelRuntimeStatus).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("proxies channel diagnostics through the comms route", async () => {
    const runIntegrationConnectionDiagnostics = vi.fn(async () => ({
      connectorType: "integration_connection",
      connectorId: "11111111-1111-4111-8111-111111111111",
      status: "ok",
      checks: [],
      checkedAt: "2026-03-29T00:00:00.000Z",
    }));
    app = Fastify();
    app.decorate("gateway", { runIntegrationConnectionDiagnostics } as never);
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/comms/diagnostics/11111111-1111-4111-8111-111111111111",
    });

    expect(response.statusCode).toBe(200);
    expect(runIntegrationConnectionDiagnostics).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });
});
