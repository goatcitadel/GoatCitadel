import { authPlugin } from "../plugins/auth.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { buildLineWebhookSignature } from "../services/line-webhook.js";
import { buildNextcloudTalkSignature } from "../services/nextcloud-talk-webhook.js";
import { buildSlackSignature } from "../services/slack-webhook.js";
import { createTelegramChannelSessionPatch } from "../services/telegram-channel-sessions.js";
import { verifyTelegramWebhookSecretToken } from "../services/telegram-webhook.js";
import { buildWhatsAppWebhookSignature } from "../services/whatsapp-webhook.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  cleanupIntegrationTestApp,
  decorateIntegrationServices,
  integrationsRoutes,
} from "./integrations-test-fixtures.js";

function createDurableAcceptanceMock() {
  return vi.fn(async (input: { eventType: string; message: { eventId: string } }) => ({
    accepted: true as const,
    durableAccepted: true as const,
    deduped: false,
    replied: false as const,
    queued: true,
    eventType: input.eventType,
    inboundEventId: `inbound:${input.message.eventId}`,
  }));
}

describe("integration provider webhook routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await cleanupIntegrationTestApp(app);
    app = null;
  });

  it("accepts signed Nextcloud Talk webhooks without standard auth or idempotency headers", async () => {
    const getIntegrationConnection = vi.fn(() => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      key: "nextcloud-talk",
      config: {
        baseUrl: "https://cloud.example.com",
        token: "nextcloud-secret",
      },
    }));
    const ingestChannelMessage = vi.fn(async () => ({
      accepted: true,
      deduped: false,
      session: { sessionId: "sess-nextcloud" },
      transcriptOffset: 1,
    }));
    const setChatSessionBinding = vi.fn();
    const respondToExistingChatMessage = vi.fn(async () => ({
      sessionId: "sess-nextcloud",
      userMessage: { messageId: "1567", content: "hi world !" },
      assistantMessage: { messageId: "assistant-1", content: "hello back" },
      transport: "integration",
      turnId: "turn-1",
    }));
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
      acceptInboundChannelEvent,
      recordDevDiagnostic: vi.fn(),
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const payload = JSON.stringify({
      type: "Create",
      actor: {
        type: "Person",
        id: "users/ada-lovelace",
        name: "Ada Lovelace",
      },
      object: {
        type: "Note",
        id: "1567",
        name: "message",
        content:
          '{"message":"hi {mention-call1} !","parameters":{"mention-call1":{"type":"call","id":"room-42","name":"world"}}}',
        mediaType: "text/markdown",
      },
      target: {
        type: "Collection",
        id: "room-42",
        name: "world",
      },
    });
    const random = "abcdef0123456789";
    const signature = buildNextcloudTalkSignature(random, payload, "nextcloud-secret");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/nextcloud-talk/webhook",
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
        "x-nextcloud-talk-backend": "https://cloud.example.com",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "nextcloud-talk",
        idempotencyKey: expect.stringContaining("nextcloud-talk:11111111-1111-1111-1111-111111111111:"),
        eventType: "Create",
        bindingTarget: "room-42",
        dispatchKind: "agent_turn",
        message: expect.objectContaining({
          eventId: "1567",
          account: "11111111-1111-1111-1111-111111111111",
          room: "room-42",
          actorId: "users/ada-lovelace",
          content: "hi world !",
          displayName: "Ada Lovelace",
        }),
      }),
    );
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(setChatSessionBinding).not.toHaveBeenCalled();
    expect(respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        durableAccepted: true,
        replied: false,
        queued: true,
        eventType: "Create",
      }),
    );
  });

  it("accepts signed Slack webhooks without standard auth or idempotency headers", async () => {
    const getIntegrationConnection = vi.fn(() => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      key: "slack",
      config: {
        botToken: "xoxb-slack-token",
        signingSecret: "slack-signing-secret",
        defaultChannel: "#ops-sandbox",
      },
    }));
    const ingestChannelMessage = vi.fn(async () => ({
      accepted: true,
      deduped: false,
      session: { sessionId: "sess-slack" },
      transcriptOffset: 1,
    }));
    const setChatSessionBinding = vi.fn();
    const respondToExistingChatMessage = vi.fn(async () => ({
      sessionId: "sess-slack",
      userMessage: { messageId: "1712109984.200000", content: "please help" },
      assistantMessage: { messageId: "assistant-2", content: "handled" },
      transport: "integration",
      turnId: "turn-slack-1",
    }));
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const nowMs = Date.now();
    const timestamp = String(Math.floor(nowMs / 1000));
    const payload = JSON.stringify({
      type: "event_callback",
      event_id: "Ev123Slack",
      team_id: "T111",
      event: {
        type: "message",
        user: "U111",
        text: "please help",
        channel: "C111",
        channel_type: "channel",
        ts: "1712109984.200000",
        thread_ts: "1712109984.100000",
      },
    });
    const signature = buildSlackSignature(timestamp, payload, "slack-signing-secret");

    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
      acceptInboundChannelEvent,
      recordDevDiagnostic: vi.fn(),
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/slack/webhook",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        idempotencyKey: "slack:11111111-1111-1111-1111-111111111111:Ev123Slack",
        eventType: "message",
        bindingTarget: "C111",
        dispatchKind: "agent_turn",
        responseOptions: { deliveryReplyToMessageId: "1712109984.100000" },
        message: expect.objectContaining({
          eventId: "1712109984.200000",
          account: "11111111-1111-1111-1111-111111111111",
          room: "C111",
          threadId: "1712109984.100000",
          actorId: "U111",
          content: "please help",
        }),
      }),
    );
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(setChatSessionBinding).not.toHaveBeenCalled();
    expect(respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        durableAccepted: true,
        replied: false,
        queued: true,
        eventType: "message",
      }),
    );
  });

  it("accepts Telegram webhooks without standard auth or idempotency headers", async () => {
    const getIntegrationConnection = vi.fn(() => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      key: "telegram",
      config: {
        botToken: "telegram-bot-token",
        webhookSecret: "telegram-webhook-secret",
        defaultChatId: "-1001234567890",
        telegramPairing: {
          approved: [{ actorId: "777", approvedAt: "2026-05-02T12:00:00.000Z", displayName: "Ada Lovelace" }],
          pending: [],
        },
      },
    }));
    const ingestChannelMessage = vi.fn(async () => ({
      accepted: true,
      deduped: false,
      session: { sessionId: "sess-telegram" },
      transcriptOffset: 1,
    }));
    const setChatSessionBinding = vi.fn();
    const respondToExistingChatMessage = vi.fn(async () => ({
      sessionId: "sess-telegram",
      userMessage: { messageId: "456", content: "please help" },
      assistantMessage: { messageId: "assistant-telegram-1", content: "handled" },
      transport: "integration",
      turnId: "turn-telegram-1",
    }));
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const payload = JSON.stringify({
      update_id: 9001,
      message: {
        message_id: 456,
        from: {
          id: 777,
          is_bot: false,
          first_name: "Ada",
          last_name: "Lovelace",
          username: "ada",
        },
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Ops Room",
        },
        text: "please help",
      },
    });

    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
      acceptInboundChannelEvent,
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/telegram/webhook",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-webhook-secret",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(verifyTelegramWebhookSecretToken("telegram-webhook-secret", "telegram-webhook-secret")).toBe(true);
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        idempotencyKey: "telegram:11111111-1111-1111-1111-111111111111:9001",
        eventType: "message",
        bindingTarget: "-1001234567890",
        dispatchKind: "agent_turn",
        responseOptions: { deliveryReplyToMessageId: "456" },
        message: expect.objectContaining({
          eventId: "456",
          account: "11111111-1111-1111-1111-111111111111",
          room: "-1001234567890",
          actorId: "777",
          content: "please help",
        }),
      }),
    );
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(setChatSessionBinding).not.toHaveBeenCalled();
    expect(respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        durableAccepted: true,
        replied: false,
        queued: true,
        eventType: "message",
      }),
    );
  });

  it("handles Telegram /sethome before normal chat dispatch", async () => {
    const getIntegrationConnection = vi.fn(() => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      catalogId: "channel.telegram",
      kind: "channel",
      key: "telegram",
      label: "Telegram",
      enabled: true,
      status: "connected",
      config: {
        botToken: "telegram-bot-token",
        webhookSecret: "telegram-webhook-secret",
        telegramOperatorActors: ["777"],
        telegramPairing: {
          approved: [{ actorId: "777", approvedAt: "2026-05-02T12:00:00.000Z", displayName: "Ada" }],
          pending: [],
        },
      },
      createdAt: "2026-05-02T12:00:00.000Z",
      updatedAt: "2026-05-02T12:00:00.000Z",
    }));
    const updateIntegrationConnection = vi.fn((connectionId, patch) => ({
      ...getIntegrationConnection(),
      connectionId,
      ...patch,
    }));
    const ingestChannelMessage = vi.fn();
    const respondToExistingChatMessage = vi.fn();
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const awaitInboundChannelCommandResult = vi.fn(async () => ({
      status: "completed" as const,
      resultText: "Home channel set.",
    }));
    const payload = JSON.stringify({
      update_id: 9002,
      message: {
        message_id: 457,
        from: { id: 777, is_bot: false, first_name: "Ada" },
        chat: { id: -1001234567890, type: "supergroup", title: "Ops Room" },
        text: "/sethome",
      },
    });

    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      updateIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage,
      acceptInboundChannelEvent,
      awaitInboundChannelCommandResult,
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/telegram/webhook",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-webhook-secret",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(updateIntegrationConnection).not.toHaveBeenCalled();
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchKind: "command",
        eventType: "telegram-channel-command",
        message: expect.objectContaining({ content: "/sethome" }),
      }),
    );
    expect(response.json()).toEqual(
      expect.objectContaining({
        method: "sendMessage",
        chat_id: "-1001234567890",
        text: expect.stringContaining("Home channel set"),
      }),
    );
  });

  it("handles Telegram /new by rotating the channel session before normal chat dispatch", async () => {
    const getIntegrationConnection = vi.fn(() => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      catalogId: "channel.telegram",
      kind: "channel",
      key: "telegram",
      label: "Telegram",
      enabled: true,
      status: "connected",
      config: {
        botToken: "telegram-bot-token",
        webhookSecret: "telegram-webhook-secret",
        telegramPairing: {
          approved: [{ actorId: "777", approvedAt: "2026-05-02T12:00:00.000Z", displayName: "Ada" }],
          pending: [],
        },
      },
      createdAt: "2026-05-02T12:00:00.000Z",
      updatedAt: "2026-05-02T12:00:00.000Z",
    }));
    const updateIntegrationConnection = vi.fn((connectionId, patch) => ({
      ...getIntegrationConnection(),
      connectionId,
      ...patch,
    }));
    const ingestChannelMessage = vi.fn();
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const awaitInboundChannelCommandResult = vi.fn(async () => ({
      status: "completed" as const,
      resultText:
        "New Telegram channel session started. The next normal message in this chat will route to a fresh GoatCitadel session.",
    }));
    const payload = JSON.stringify({
      update_id: 9008,
      message: {
        message_id: 462,
        from: { id: 777, is_bot: false, first_name: "Ada" },
        chat: { id: -1001234567890, type: "supergroup", title: "Ops Room" },
        text: "/new",
      },
    });

    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      updateIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
      acceptInboundChannelEvent,
      awaitInboundChannelCommandResult,
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/telegram/webhook",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-webhook-secret",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(updateIntegrationConnection).not.toHaveBeenCalled();
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchKind: "command",
        eventType: "telegram-channel-command",
        message: expect.objectContaining({ content: "/new" }),
      }),
    );
    expect(response.json()).toEqual(
      expect.objectContaining({
        method: "sendMessage",
        chat_id: "-1001234567890",
        text: expect.stringContaining("fresh GoatCitadel session"),
      }),
    );
  });

  it("routes normal Telegram messages through a rotated channel session while preserving delivery target binding", async () => {
    const rotatedConfig = {
      botToken: "telegram-bot-token",
      webhookSecret: "telegram-webhook-secret",
      telegramPairing: {
        approved: [{ actorId: "777", approvedAt: "2026-05-02T12:00:00.000Z", displayName: "Ada" }],
        pending: [],
      },
      ...createTelegramChannelSessionPatch({
        config: {},
        chatId: "-1001234567890",
        actorId: "777",
        now: new Date("2026-05-02T12:30:00.000Z"),
      }),
    };
    const ingestChannelMessage = vi.fn(async () => ({
      deduped: false,
      session: { sessionId: "sess-telegram-rotated" },
    }));
    const setChatSessionBinding = vi.fn();
    const respondToExistingChatMessage = vi.fn(async () => ({ turnId: "turn-rotated" }));
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const payload = JSON.stringify({
      update_id: 9009,
      message: {
        message_id: 463,
        from: { id: 777, is_bot: false, first_name: "Ada" },
        chat: { id: -1001234567890, type: "supergroup", title: "Ops Room" },
        text: "start fresh",
      },
    });

    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        catalogId: "channel.telegram",
        kind: "channel",
        key: "telegram",
        label: "Telegram",
        enabled: true,
        status: "connected",
        config: rotatedConfig,
        createdAt: "2026-05-02T12:00:00.000Z",
        updatedAt: "2026-05-02T12:00:00.000Z",
      })),
      updateIntegrationConnection: vi.fn(),
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
      acceptInboundChannelEvent,
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/telegram/webhook",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-webhook-secret",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        idempotencyKey: expect.any(String),
        bindingTarget: "-1001234567890",
        dispatchKind: "agent_turn",
        message: expect.objectContaining({
          room: expect.stringMatching(/^-1001234567890~tg_/),
          content: "start fresh",
        }),
      }),
    );
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(setChatSessionBinding).not.toHaveBeenCalled();
    expect(respondToExistingChatMessage).not.toHaveBeenCalled();
  });

  it("handles Telegram /stop by cancelling the latest active channel session", async () => {
    const cancelLatestActiveChatTurnForSession = vi.fn(async () => ({
      status: "cancelled" as const,
      sessionId: "sess-telegram",
      turnId: "turn-1",
      durableRunId: "run-1",
      durableCancelled: true,
    }));
    const ingestChannelMessage = vi.fn();
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const awaitInboundChannelCommandResult = vi.fn(async () => ({
      status: "completed" as const,
      resultText: "Stopped the active Telegram channel run.",
    }));
    const payload = JSON.stringify({
      update_id: 9010,
      message: {
        message_id: 464,
        from: { id: 777, is_bot: false, first_name: "Ada" },
        chat: { id: -1001234567890, type: "supergroup", title: "Ops Room" },
        text: "/stop",
      },
    });

    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        catalogId: "channel.telegram",
        kind: "channel",
        key: "telegram",
        label: "Telegram",
        enabled: true,
        status: "connected",
        config: {
          botToken: "telegram-bot-token",
          webhookSecret: "telegram-webhook-secret",
          telegramPairing: {
            approved: [{ actorId: "777", approvedAt: "2026-05-02T12:00:00.000Z", displayName: "Ada" }],
            pending: [],
          },
        },
        createdAt: "2026-05-02T12:00:00.000Z",
        updatedAt: "2026-05-02T12:00:00.000Z",
      })),
      cancelLatestActiveChatTurnForSession,
      updateIntegrationConnection: vi.fn(),
      ingestChannelMessage,
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
      acceptInboundChannelEvent,
      awaitInboundChannelCommandResult,
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/telegram/webhook",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-webhook-secret",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(cancelLatestActiveChatTurnForSession).not.toHaveBeenCalled();
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchKind: "command",
        eventType: "telegram-channel-command",
        message: expect.objectContaining({ content: "/stop" }),
      }),
    );
    expect(response.json()).toEqual(
      expect.objectContaining({
        method: "sendMessage",
        text: expect.stringContaining("Stopped the active Telegram channel run"),
      }),
    );
  });

  it("blocks unpaired Telegram users before command or normal chat dispatch", async () => {
    const getIntegrationConnection = vi.fn(() => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      catalogId: "channel.telegram",
      kind: "channel",
      key: "telegram",
      label: "Telegram",
      enabled: true,
      status: "connected",
      config: {
        botToken: "telegram-bot-token",
        webhookSecret: "telegram-webhook-secret",
      },
      createdAt: "2026-05-02T12:00:00.000Z",
      updatedAt: "2026-05-02T12:00:00.000Z",
    }));
    const updateIntegrationConnection = vi.fn((connectionId, patch) => ({
      ...getIntegrationConnection(),
      connectionId,
      ...patch,
    }));
    const ingestChannelMessage = vi.fn();
    const payload = JSON.stringify({
      update_id: 9003,
      message: {
        message_id: 458,
        from: { id: 888, is_bot: false, first_name: "Grace" },
        chat: { id: -1001234567890, type: "supergroup", title: "Ops Room" },
        text: "/status",
      },
    });

    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      updateIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/telegram/webhook",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-webhook-secret",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(updateIntegrationConnection).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      expect.objectContaining({
        config: expect.objectContaining({
          telegramPairing: expect.objectContaining({
            pending: expect.arrayContaining([expect.objectContaining({ actorId: "888", chatId: "-1001234567890" })]),
          }),
        }),
      }),
    );
    expect(response.json()).toEqual(
      expect.objectContaining({
        method: "sendMessage",
        text: expect.stringContaining("Pairing code:"),
      }),
    );
  });

  it("reuses an existing Telegram pairing code without rewriting the connection config", async () => {
    const updateIntegrationConnection = vi.fn();
    const ingestChannelMessage = vi.fn();
    const payload = JSON.stringify({
      update_id: 9011,
      message: {
        message_id: 465,
        from: { id: 888, is_bot: false, first_name: "Grace" },
        chat: { id: -1001234567890, type: "supergroup", title: "Ops Room" },
        text: "/status",
      },
    });

    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        catalogId: "channel.telegram",
        kind: "channel",
        key: "telegram",
        label: "Telegram",
        enabled: true,
        status: "connected",
        config: {
          botToken: "telegram-bot-token",
          webhookSecret: "telegram-webhook-secret",
          telegramPairing: {
            approved: [],
            pending: [
              {
                code: "ABCDEFGH",
                actorId: "888",
                chatId: "-1001234567890",
                displayName: "Grace",
                createdAt: "2026-05-02T12:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
              },
            ],
          },
        },
        createdAt: "2026-05-02T12:00:00.000Z",
        updatedAt: "2026-05-02T12:00:00.000Z",
      })),
      updateIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/telegram/webhook",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-webhook-secret",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(updateIntegrationConnection).not.toHaveBeenCalled();
    expect(response.json()).toEqual(
      expect.objectContaining({
        method: "sendMessage",
        text: expect.stringContaining("ABCDEFGH"),
      }),
    );
  });

  it("resolves Telegram approval callback buttons for paired users", async () => {
    const resolveApprovalWithRemoteToken = vi.fn(async () => ({
      approval: {
        approvalId: "approval-1",
        status: "approved",
      },
    }));
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const awaitInboundChannelCommandResult = vi.fn(async () => ({
      status: "completed" as const,
      resultText: "Approved approval-1.",
    }));
    const payload = JSON.stringify({
      update_id: 9004,
      callback_query: {
        id: "callback-1",
        from: { id: 777, is_bot: false, first_name: "Ada" },
        message: {
          message_id: 459,
          chat: { id: -1001234567890, type: "supergroup", title: "Ops Room" },
          text: "Approval requested",
        },
        data: "gca:grat_secret:a",
      },
    });

    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        catalogId: "channel.telegram",
        kind: "channel",
        key: "telegram",
        label: "Telegram",
        enabled: true,
        status: "connected",
        config: {
          botToken: "telegram-bot-token",
          webhookSecret: "telegram-webhook-secret",
          telegramPairing: {
            approved: [{ actorId: "777", approvedAt: "2026-05-02T12:00:00.000Z", displayName: "Ada" }],
            pending: [],
          },
        },
        createdAt: "2026-05-02T12:00:00.000Z",
        updatedAt: "2026-05-02T12:00:00.000Z",
      })),
      updateIntegrationConnection: vi.fn(),
      ingestChannelMessage: vi.fn(),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
      resolveApprovalWithRemoteToken,
      findRemoteActionTokenId: vi.fn(() => "approval-action-1"),
      acceptInboundChannelEvent,
      awaitInboundChannelCommandResult,
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/telegram/webhook",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-webhook-secret",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(resolveApprovalWithRemoteToken).not.toHaveBeenCalled();
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchKind: "command",
        eventType: "telegram-approval-callback",
        message: expect.objectContaining({
          content: "/approve",
          metadata: expect.objectContaining({
            approvalActionId: "approval-action-1",
            approvalDecision: "approve",
          }),
        }),
      }),
    );
    const acceptedApproval = acceptInboundChannelEvent.mock.calls[0]?.[0] as {
      message?: { metadata?: Record<string, unknown> };
    };
    expect(acceptedApproval.message?.metadata).not.toHaveProperty("callbackQueryId");
    expect(JSON.stringify(acceptInboundChannelEvent.mock.calls)).not.toContain("grat_secret");
    expect(JSON.stringify(acceptInboundChannelEvent.mock.calls)).not.toContain("callback-1");
    expect(response.json()).toEqual(
      expect.objectContaining({
        method: "answerCallbackQuery",
        callback_query_id: "callback-1",
        text: "Approved approval-1.",
      }),
    );
  });

  it("approves Telegram pairing codes through the channel pairing API", async () => {
    const getIntegrationConnection = vi.fn(() => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      catalogId: "channel.telegram",
      kind: "channel",
      key: "telegram",
      label: "Telegram",
      enabled: true,
      status: "connected",
      config: {
        telegramPairing: {
          approved: [],
          pending: [
            {
              code: "ABCDEFGH",
              actorId: "777",
              chatId: "-1001234567890",
              displayName: "Ada",
              createdAt: "2026-05-02T12:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          ],
        },
      },
      createdAt: "2026-05-02T12:00:00.000Z",
      updatedAt: "2026-05-02T12:00:00.000Z",
    }));
    const updateIntegrationConnection = vi.fn((connectionId, patch) => ({
      ...getIntegrationConnection(),
      connectionId,
      ...patch,
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      updateIntegrationConnection,
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/telegram/pairing/approve",
      headers: {
        authorization: "Bearer gateway-token",
      },
      payload: {
        code: "ABCDEFGH",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateIntegrationConnection).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      expect.objectContaining({
        config: expect.objectContaining({
          telegramPairing: expect.objectContaining({
            approved: expect.arrayContaining([expect.objectContaining({ actorId: "777" })]),
            pending: [],
          }),
        }),
      }),
    );
    expect(response.json()).toEqual(expect.objectContaining({ approved: true, actorId: "777" }));
  });

  it("does not refresh the Telegram target directory when refresh=false", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "telegram",
        config: {
          botToken: "telegram-bot-token",
          targets: [{ label: "Ops Room", chatId: "-100123" }],
        },
      })),
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/target-directory?refresh=false&query=ops",
      headers: { authorization: "Bearer gateway-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
    expect(response.json()).toEqual(
      expect.objectContaining({
        resolution: expect.objectContaining({ status: "resolved" }),
      }),
    );
  });

  it("completes the WhatsApp webhook verification challenge", async () => {
    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "whatsapp",
        config: {
          webhookVerifyToken: "whatsapp-verify-token",
        },
      })),
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=whatsapp-verify-token&hub.challenge=challenge-123",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("challenge-123");
  });

  it("accepts signed WhatsApp webhooks without standard auth or idempotency headers", async () => {
    const getIntegrationConnection = vi.fn(() => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      key: "whatsapp",
      config: {
        accessToken: "whatsapp-access-token",
        appSecret: "whatsapp-app-secret",
        webhookVerifyToken: "whatsapp-verify-token",
        phoneNumberId: "123456789012345",
        defaultTarget: "+15551234567",
      },
    }));
    const ingestChannelMessage = vi.fn(async () => ({
      accepted: true,
      deduped: false,
      session: { sessionId: "sess-whatsapp" },
      transcriptOffset: 1,
    }));
    const setChatSessionBinding = vi.fn();
    const respondToExistingChatMessage = vi.fn(async () => ({
      sessionId: "sess-whatsapp",
      userMessage: { messageId: "wamid.HBgLNDU2", content: "Need an operator check-in" },
      assistantMessage: { messageId: "assistant-whatsapp-1", content: "handled" },
      transport: "integration",
      turnId: "turn-whatsapp-1",
    }));
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: {
                  phone_number_id: "123456789012345",
                  display_phone_number: "+15551234567",
                },
                contacts: [
                  {
                    wa_id: "15558675309",
                    profile: {
                      name: "Ada Lovelace",
                    },
                  },
                ],
                messages: [
                  {
                    from: "15558675309",
                    id: "wamid.HBgLNDU2",
                    timestamp: "1712182068",
                    type: "text",
                    text: {
                      body: "Need an operator check-in",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = buildWhatsAppWebhookSignature(payload, "whatsapp-app-secret");

    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
      acceptInboundChannelEvent,
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/whatsapp/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        idempotencyKey: "whatsapp:11111111-1111-1111-1111-111111111111:wamid.HBgLNDU2",
        eventType: "text",
        bindingTarget: "15558675309",
        dispatchKind: "agent_turn",
        responseOptions: { deliveryReplyToMessageId: "wamid.HBgLNDU2" },
        message: expect.objectContaining({
          eventId: "wamid.HBgLNDU2",
          account: "11111111-1111-1111-1111-111111111111",
          peer: "15558675309",
          actorId: "15558675309",
          content: "Need an operator check-in",
          displayName: "Ada Lovelace",
        }),
      }),
    );
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(setChatSessionBinding).not.toHaveBeenCalled();
    expect(respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        durableAccepted: true,
        replied: false,
        queued: true,
        eventType: "text",
      }),
    );
  });

  it("rejects unsigned WhatsApp webhooks", async () => {
    app = Fastify();
    const warn = vi.spyOn(app.log, "warn").mockImplementation(() => undefined);
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "whatsapp",
        config: {
          appSecret: "whatsapp-app-secret",
          webhookVerifyToken: "whatsapp-verify-token",
        },
      })),
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/whatsapp/webhook",
      headers: {
        "content-type": "application/json",
      },
      payload: JSON.stringify({ object: "whatsapp_business_account" }),
    });

    expect(response.statusCode).toBe(401);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        connectionId: "11111111-1111-1111-1111-111111111111",
        reason: "signature_mismatch",
      }),
      "Rejected inbound webhook because verification failed.",
    );
    warn.mockRestore();
  });

  it("accepts signed LINE webhooks without standard auth or idempotency headers", async () => {
    const getIntegrationConnection = vi.fn(() => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      key: "line",
      config: {
        channelAccessToken: "line-channel-access-token",
        channelSecret: "line-channel-secret",
        defaultTarget: "U1234567890",
      },
    }));
    const ingestChannelMessage = vi.fn(async () => ({
      accepted: true,
      deduped: false,
      session: { sessionId: "sess-line" },
      transcriptOffset: 1,
    }));
    const setChatSessionBinding = vi.fn();
    const respondToExistingChatMessage = vi.fn(async () => ({
      sessionId: "sess-line",
      userMessage: { messageId: "325708", content: "Please open the Office Lab view" },
      assistantMessage: { messageId: "assistant-line-1", content: "handled" },
      transport: "integration",
      turnId: "turn-line-1",
    }));
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const payload = JSON.stringify({
      destination: "Ubot123",
      events: [
        {
          type: "message",
          mode: "active",
          webhookEventId: "01HV5R0EVTQ6AY9QX4QFTRMNY9",
          replyToken: "reply-token-1",
          deliveryContext: {
            isRedelivery: false,
          },
          source: {
            type: "group",
            groupId: "Cgroup123",
            userId: "Uuser123",
          },
          message: {
            id: "325708",
            type: "text",
            text: "Please open the Office Lab view",
          },
        },
      ],
    });
    const signature = buildLineWebhookSignature(payload, "line-channel-secret");

    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
      acceptInboundChannelEvent,
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/line/webhook",
      headers: {
        "content-type": "application/json",
        "x-line-signature": signature,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "line",
        idempotencyKey: "line:11111111-1111-1111-1111-111111111111:01HV5R0EVTQ6AY9QX4QFTRMNY9",
        eventType: "message",
        bindingTarget: "Cgroup123",
        dispatchKind: "agent_turn",
        responseOptions: { deliveryReplyToMessageId: "325708" },
        message: expect.objectContaining({
          eventId: "325708",
          account: "11111111-1111-1111-1111-111111111111",
          room: "Cgroup123",
          actorId: "Uuser123",
          content: "Please open the Office Lab view",
        }),
      }),
    );
    expect(JSON.stringify(acceptInboundChannelEvent.mock.calls[0]?.[0])).not.toContain("reply-token-1");
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(setChatSessionBinding).not.toHaveBeenCalled();
    expect(respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        durableAccepted: true,
        replied: false,
        queued: true,
        eventType: "message",
      }),
    );
  });

  it("rejects unsigned LINE webhooks", async () => {
    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "line",
        config: {
          channelSecret: "line-channel-secret",
        },
      })),
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/line/webhook",
      headers: {
        "content-type": "application/json",
      },
      payload: JSON.stringify({ events: [] }),
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns Slack url verification challenges without ingesting chat turns", async () => {
    const nowMs = Date.now();
    const timestamp = String(Math.floor(nowMs / 1000));
    const payload = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-token",
    });
    const signature = buildSlackSignature(timestamp, payload, "slack-signing-secret");
    const ingestChannelMessage = vi.fn();

    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "slack",
        config: { signingSecret: "slack-signing-secret" },
      })),
      ingestChannelMessage,
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/slack/webhook",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(response.json()).toEqual({ challenge: "challenge-token" });
  });

  it("rejects unsigned Slack webhooks", async () => {
    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "slack",
        config: { signingSecret: "slack-signing-secret" },
      })),
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/slack/webhook",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(Math.floor(Date.UTC(2026, 2, 31, 12, 0, 0) / 1000)),
      },
      payload: JSON.stringify({ type: "event_callback" }),
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects Telegram webhooks with the wrong secret token", async () => {
    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "telegram",
        config: { webhookSecret: "telegram-webhook-secret" },
      })),
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/telegram/webhook",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong-secret",
      },
      payload: JSON.stringify({ update_id: 1, message: { message_id: 2 } }),
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects unsigned Nextcloud Talk webhooks", async () => {
    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "nextcloud-talk",
        config: { token: "nextcloud-secret" },
      })),
      recordDevDiagnostic: vi.fn(),
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/nextcloud-talk/webhook",
      headers: {
        "content-type": "application/json",
      },
      payload: JSON.stringify({ type: "Create" }),
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects Nextcloud webhooks for non-Nextcloud connectors", async () => {
    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "discord",
        config: { token: "discord-token" },
      })),
      recordDevDiagnostic: vi.fn(),
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const payload = JSON.stringify({ type: "Create" });
    const signature = buildNextcloudTalkSignature("abcdef0123456789", payload, "discord-token");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/nextcloud-talk/webhook",
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": "abcdef0123456789",
        "x-nextcloud-talk-signature": signature,
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
  });

  it("accepts non-message Nextcloud activity hooks without ingesting chat turns", async () => {
    const ingestChannelMessage = vi.fn();
    const recordDevDiagnostic = vi.fn();
    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "nextcloud-talk",
        config: { token: "nextcloud-secret" },
      })),
      ingestChannelMessage,
      recordDevDiagnostic,
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);

    const payload = JSON.stringify({
      type: "Like",
      actor: { id: "users/ada-lovelace", name: "Ada Lovelace" },
      object: { id: "1567", content: '{"message":"hi","parameters":{}}' },
      target: { id: "room-42", name: "world" },
      content: "😆",
    });
    const random = "abcdef0123456789";
    const signature = buildNextcloudTalkSignature(random, payload, "nextcloud-secret");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/nextcloud-talk/webhook",
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(recordDevDiagnostic).toHaveBeenCalled();
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        handled: true,
        eventType: "Like",
      }),
    );
  });
});

describe("telegram inbound voice webhooks (channelVoiceInboundV1Enabled)", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await cleanupIntegrationTestApp(app);
    app = null;
  });

  function createTelegramVoiceConnection() {
    return {
      connectionId: "11111111-1111-1111-1111-111111111111",
      key: "telegram",
      label: "Telegram",
      enabled: true,
      status: "connected" as const,
      config: {
        botToken: "telegram-bot-token",
        webhookSecret: "telegram-webhook-secret",
        telegramPairing: {
          approved: [{ actorId: "777", approvedAt: "2026-05-02T12:00:00.000Z", displayName: "Ada" }],
          pending: [],
        },
      },
    };
  }

  const voiceWebhookPayload = JSON.stringify({
    update_id: 9400,
    message: {
      message_id: 640,
      from: { id: 777, is_bot: false, first_name: "Ada" },
      chat: { id: 777, type: "private" },
      voice: { file_id: "voice-file-640", duration: 3, mime_type: "audio/ogg" },
    },
  });

  async function buildVoiceApp(methods: Record<string, unknown>) {
    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      ...methods,
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);
    return app;
  }

  async function postVoiceWebhook(target: FastifyInstance) {
    return target.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/telegram/webhook",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-webhook-secret",
      },
      payload: voiceWebhookPayload,
    });
  }

  it("keeps dropping voice notes when the flag is off (byte-identical default)", async () => {
    const ingestChannelMessage = vi.fn();
    const transcribeChannelVoice = vi.fn();
    const built = await buildVoiceApp({
      getIntegrationConnection: vi.fn(() => createTelegramVoiceConnection()),
      isVoiceInboundEnabled: () => false,
      transcribeChannelVoice,
      ingestChannelMessage,
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
    });

    const response = await postVoiceWebhook(built);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        ignored: true,
        reason: "Missing Telegram chat, message id, content, or actor id",
      }),
    );
    expect(transcribeChannelVoice).not.toHaveBeenCalled();
    expect(ingestChannelMessage).not.toHaveBeenCalled();
  });

  it("durably accepts a voice event while its channel session is busy", async () => {
    const hasRunningTurn = vi.fn(() => true);
    const transcribeChannelVoice = vi.fn();
    const ingestChannelMessage = vi.fn();
    const acceptInboundChannelEvent = vi.fn(async (input: { eventType: string; message: { eventId: string } }) => ({
      accepted: true as const,
      durableAccepted: true as const,
      deduped: false,
      replied: false as const,
      queued: true,
      eventType: input.eventType,
      inboundEventId: `inbound:${input.message.eventId}`,
    }));
    const built = await buildVoiceApp({
      getIntegrationConnection: vi.fn(() => createTelegramVoiceConnection()),
      isVoiceInboundEnabled: () => true,
      hasRunningTurn,
      transcribeChannelVoice,
      acceptInboundChannelEvent,
      ingestChannelMessage,
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
      recordDevDiagnostic: vi.fn(),
    });

    const response = await postVoiceWebhook(built);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accepted: true,
      durableAccepted: true,
      replied: false,
      queued: true,
    });
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        dispatchKind: "voice_agent_turn",
        message: expect.objectContaining({ eventId: "640", content: "[telegram voice message]" }),
        voiceRequest: {
          channel: "telegram",
          connectionConfig: {},
          fileId: "voice-file-640",
          mimeType: "audio/ogg",
        },
      }),
    );
    expect(hasRunningTurn).not.toHaveBeenCalled();
    expect(transcribeChannelVoice).not.toHaveBeenCalled();
    expect(ingestChannelMessage).not.toHaveBeenCalled();
  });
});
