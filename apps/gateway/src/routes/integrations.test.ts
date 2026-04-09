import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { IntegrationPluginRecord } from "@goatcitadel/contracts";
import { authPlugin } from "../plugins/auth.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { buildLineWebhookSignature } from "../services/line-webhook.js";
import { buildNextcloudTalkSignature } from "../services/nextcloud-talk-webhook.js";
import { buildSlackSignature } from "../services/slack-webhook.js";
import { verifyTelegramWebhookSecretToken } from "../services/telegram-webhook.js";
import { buildWhatsAppWebhookSignature } from "../services/whatsapp-webhook.js";
import { buildInstalledIntegrationPluginRecord } from "../services/integration-plugin-author-contract.js";
import type { FastifyPluginAsync } from "fastify";
import { integrationWebhookRoutes } from "./integration-webhooks.js";
import { integrationsRoutes as baseIntegrationsRoutes } from "./integrations.js";

const integrationsRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(baseIntegrationsRoutes);
  await fastify.register(integrationWebhookRoutes);
};

describe("integrations inbound route guards", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("rejects channel inbound payloads with oversized content-length", async () => {
    const ingestChannelMessage = vi.fn();
    app = Fastify();
    app.decorate("gateway", {
      ingestChannelMessage,
    } as never);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/channels/discord/inbound",
      headers: {
        "content-length": String(300 * 1024),
      },
      payload: {
        account: "acct-1",
        actorId: "user-1",
        content: "hello",
      },
    });

    expect(response.statusCode).toBe(413);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
  });

  it("accepts bounded inbound payloads and forwards to gateway ingest", async () => {
    const ingestChannelMessage = vi.fn(async () => ({
      accepted: true,
      sessionId: "sess-1",
    }));
    app = Fastify();
    app.decorate("gateway", {
      ingestChannelMessage,
    } as never);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/channels/discord/inbound",
      payload: {
        account: "acct-1",
        actorId: "user-1",
        content: "hello from inbound",
        metadata: {
          source: "test",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(ingestChannelMessage).toHaveBeenCalledWith(
      "discord",
      undefined,
      expect.objectContaining({
        account: "acct-1",
        actorId: "user-1",
        content: "hello from inbound",
      }),
    );
  });

  it("runs connector diagnostics through the integration diagnostics route", async () => {
    const runIntegrationConnectionDiagnostics = vi.fn(async () => ({
      connectorType: "integration_connection",
      connectorId: "11111111-1111-1111-1111-111111111111",
      status: "warn",
      checks: [
        {
          key: "smoke_mode",
          status: "pass",
          message: "Smoke probes are configured.",
        },
      ],
      checkedAt: "2026-03-22T00:00:00.000Z",
    }));
    app = Fastify();
    app.decorate("gateway", {
      runIntegrationConnectionDiagnostics,
    } as never);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/diagnostics",
    });

    expect(response.statusCode).toBe(200);
    expect(runIntegrationConnectionDiagnostics).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    expect(response.json()).toEqual(
      expect.objectContaining({
        connectorType: "integration_connection",
        connectorId: "11111111-1111-1111-1111-111111111111",
        status: "warn",
      }),
    );
  });

  it("lists Discord pairings through the integration route", async () => {
    const listDiscordPairings = vi.fn(() => ({
      runtime: {
        connectionId: "11111111-1111-1111-1111-111111111111",
        runtimeMode: "gateway",
        enabled: true,
        ready: true,
        guildIds: ["guild-1"],
      },
      items: [],
    }));
    app = Fastify();
    app.decorate("gateway", {
      listDiscordPairings,
    } as never);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/discord/pairings",
    });

    expect(response.statusCode).toBe(200);
    expect(listDiscordPairings).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    expect(response.json()).toEqual(
      expect.objectContaining({
        runtime: expect.objectContaining({
          connectionId: "11111111-1111-1111-1111-111111111111",
          ready: true,
        }),
      }),
    );
  });

  it("approves and revokes Discord pairings through the integration routes", async () => {
    const approveDiscordPairing = vi.fn(() => ({
      pairingId: "22222222-2222-2222-2222-222222222222",
      connectionId: "11111111-1111-1111-1111-111111111111",
      userId: "discord-user",
      code: "ABC123",
      status: "approved",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T01:00:00.000Z",
    }));
    const revokeDiscordPairing = vi.fn(() => ({
      pairingId: "22222222-2222-2222-2222-222222222222",
      connectionId: "11111111-1111-1111-1111-111111111111",
      userId: "discord-user",
      code: "ABC123",
      status: "revoked",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T02:00:00.000Z",
      revokedAt: "2026-03-29T02:00:00.000Z",
    }));
    app = Fastify();
    app.decorate("gateway", {
      approveDiscordPairing,
      revokeDiscordPairing,
    } as never);
    await app.register(integrationsRoutes);

    const approveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/discord/pairings/22222222-2222-2222-2222-222222222222/approve",
    });
    expect(approveResponse.statusCode).toBe(200);
    expect(approveDiscordPairing).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const revokeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/discord/pairings/22222222-2222-2222-2222-222222222222/revoke",
    });
    expect(revokeResponse.statusCode).toBe(200);
    expect(revokeDiscordPairing).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );
  });

  it("reconnects the Discord gateway runtime through the integration route", async () => {
    const reconnectDiscordRuntime = vi.fn(async () => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      runtimeMode: "gateway",
      enabled: true,
      ready: false,
      guildIds: [],
      lastReconnectAt: "2026-03-29T03:00:00.000Z",
    }));
    app = Fastify();
    app.decorate("gateway", {
      reconnectDiscordRuntime,
    } as never);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/discord/reconnect",
    });

    expect(response.statusCode).toBe(200);
    expect(reconnectDiscordRuntime).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    expect(response.json()).toEqual(
      expect.objectContaining({
        connectionId: "11111111-1111-1111-1111-111111111111",
        lastReconnectAt: "2026-03-29T03:00:00.000Z",
      }),
    );
  });

  it("supports reference plugin install, list, and enable-disable lifecycle routes", async () => {
    const source = path.resolve(process.cwd(), "../../templates/integration-plugins/reference-integration-plugin");
    let plugins: IntegrationPluginRecord[] = [
      buildInstalledIntegrationPluginRecord({
        now: "2026-03-30T08:00:00.000Z",
        pluginId: "reference-integration-plugin",
        source,
      }),
    ];
    plugins = [{ ...plugins[0]!, enabled: false }];
    const listIntegrationPlugins = vi.fn(() => plugins);
    const installIntegrationPlugin = vi.fn((input: { source: string; pluginId?: string }) => {
      const created = buildInstalledIntegrationPluginRecord({
        now: "2026-03-30T09:00:00.000Z",
        pluginId: input.pluginId ?? "reference-integration-plugin",
        source: input.source,
      });
      plugins = [created];
      return created;
    });
    const setIntegrationPluginEnabled = vi.fn((pluginId: string, enabled: boolean) => {
      plugins = plugins.map((plugin) => (plugin.pluginId === pluginId ? { ...plugin, enabled } : plugin));
      return plugins.find((plugin) => plugin.pluginId === pluginId)!;
    });
    app = Fastify();
    app.decorate("gateway", {
      listIntegrationPlugins,
      installIntegrationPlugin,
      setIntegrationPluginEnabled,
    } as never);
    await app.register(integrationsRoutes);

    const installResponse = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/plugins/install",
      payload: { source },
    });
    expect(installResponse.statusCode).toBe(201);
    expect(installIntegrationPlugin).toHaveBeenCalledWith({ source });
    expect(installResponse.json()).toEqual(
      expect.objectContaining({
        pluginId: "reference-integration-plugin",
        label: "Reference Integration Plugin",
        source,
        enabled: true,
      }),
    );

    const disableResponse = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/plugins/reference-integration-plugin/disable",
    });
    expect(disableResponse.statusCode).toBe(200);
    expect(setIntegrationPluginEnabled).toHaveBeenCalledWith("reference-integration-plugin", false);
    expect(disableResponse.json()).toEqual(
      expect.objectContaining({
        pluginId: "reference-integration-plugin",
        enabled: false,
      }),
    );

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/plugins",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listIntegrationPlugins).toHaveBeenCalled();
    expect(listResponse.json()).toEqual({
      items: expect.arrayContaining([
        expect.objectContaining({
          pluginId: "reference-integration-plugin",
          label: "Reference Integration Plugin",
          source,
          enabled: false,
        }),
      ]),
    });

    const enableResponse = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/plugins/reference-integration-plugin/enable",
    });
    expect(enableResponse.statusCode).toBe(200);
    expect(setIntegrationPluginEnabled).toHaveBeenCalledWith("reference-integration-plugin", true);
    expect(enableResponse.json()).toEqual(
      expect.objectContaining({
        pluginId: "reference-integration-plugin",
        enabled: true,
      }),
    );
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
    app = Fastify();
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
      recordDevDiagnostic: vi.fn(),
    } as never);
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
    expect(ingestChannelMessage).toHaveBeenCalledWith(
      "nextcloud-talk",
      expect.stringContaining("nextcloud-talk:11111111-1111-1111-1111-111111111111:"),
      expect.objectContaining({
        eventId: "1567",
        account: "11111111-1111-1111-1111-111111111111",
        room: "room-42",
        actorId: "users/ada-lovelace",
        content: "hi world !",
        displayName: "Ada Lovelace",
      }),
    );
    expect(setChatSessionBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-nextcloud",
        transport: "integration",
        connectionId: "11111111-1111-1111-1111-111111111111",
        target: "room-42",
        writable: true,
      }),
    );
    expect(respondToExistingChatMessage).toHaveBeenCalledWith("sess-nextcloud", "1567");
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        replied: true,
        sessionId: "sess-nextcloud",
        turnId: "turn-1",
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
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
      recordDevDiagnostic: vi.fn(),
    } as never);
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
    expect(ingestChannelMessage).toHaveBeenCalledWith(
      "slack",
      "slack:11111111-1111-1111-1111-111111111111:Ev123Slack",
      expect.objectContaining({
        eventId: "1712109984.200000",
        account: "11111111-1111-1111-1111-111111111111",
        room: "C111",
        threadId: "1712109984.100000",
        actorId: "U111",
        content: "please help",
      }),
    );
    expect(setChatSessionBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-slack",
        transport: "integration",
        connectionId: "11111111-1111-1111-1111-111111111111",
        target: "C111",
        writable: true,
      }),
    );
    expect(respondToExistingChatMessage).toHaveBeenCalledWith("sess-slack", "1712109984.200000", {
      deliveryReplyToMessageId: "1712109984.100000",
    });
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        replied: true,
        sessionId: "sess-slack",
        turnId: "turn-slack-1",
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
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
    } as never);
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
    expect(ingestChannelMessage).toHaveBeenCalledWith(
      "telegram",
      "telegram:11111111-1111-1111-1111-111111111111:9001",
      expect.objectContaining({
        eventId: "456",
        account: "11111111-1111-1111-1111-111111111111",
        room: "-1001234567890",
        actorId: "777",
        content: "please help",
      }),
    );
    expect(setChatSessionBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-telegram",
        transport: "integration",
        connectionId: "11111111-1111-1111-1111-111111111111",
        target: "-1001234567890",
        writable: true,
      }),
    );
    expect(respondToExistingChatMessage).toHaveBeenCalledWith("sess-telegram", "456", {
      deliveryReplyToMessageId: "456",
    });
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        replied: true,
        sessionId: "sess-telegram",
        turnId: "turn-telegram-1",
        eventType: "message",
      }),
    );
  });

  it("completes the WhatsApp webhook verification challenge", async () => {
    app = Fastify();
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "whatsapp",
        config: {
          webhookVerifyToken: "whatsapp-verify-token",
        },
      })),
    } as never);
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
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
    } as never);
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
    expect(ingestChannelMessage).toHaveBeenCalledWith(
      "whatsapp",
      "whatsapp:11111111-1111-1111-1111-111111111111:wamid.HBgLNDU2",
      expect.objectContaining({
        eventId: "wamid.HBgLNDU2",
        account: "11111111-1111-1111-1111-111111111111",
        peer: "15558675309",
        actorId: "15558675309",
        content: "Need an operator check-in",
        displayName: "Ada Lovelace",
      }),
    );
    expect(setChatSessionBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-whatsapp",
        transport: "integration",
        connectionId: "11111111-1111-1111-1111-111111111111",
        target: "15558675309",
        writable: true,
      }),
    );
    expect(respondToExistingChatMessage).toHaveBeenCalledWith("sess-whatsapp", "wamid.HBgLNDU2", {
      deliveryReplyToMessageId: "wamid.HBgLNDU2",
    });
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        replied: true,
        sessionId: "sess-whatsapp",
        turnId: "turn-whatsapp-1",
        eventType: "text",
      }),
    );
  });

  it("rejects unsigned WhatsApp webhooks", async () => {
    app = Fastify();
    const warn = vi.spyOn(app.log, "warn").mockImplementation(() => undefined);
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "whatsapp",
        config: {
          appSecret: "whatsapp-app-secret",
          webhookVerifyToken: "whatsapp-verify-token",
        },
      })),
    } as never);
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
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
    } as never);
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
    expect(ingestChannelMessage).toHaveBeenCalledWith(
      "line",
      "line:11111111-1111-1111-1111-111111111111:01HV5R0EVTQ6AY9QX4QFTRMNY9",
      expect.objectContaining({
        eventId: "325708",
        account: "11111111-1111-1111-1111-111111111111",
        room: "Cgroup123",
        actorId: "Uuser123",
        content: "Please open the Office Lab view",
      }),
    );
    expect(setChatSessionBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-line",
        transport: "integration",
        connectionId: "11111111-1111-1111-1111-111111111111",
        target: "Cgroup123",
        writable: true,
      }),
    );
    expect(respondToExistingChatMessage).toHaveBeenCalledWith("sess-line", "325708", {
      deliveryReplyToMessageId: "325708",
    });
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        replied: true,
        sessionId: "sess-line",
        turnId: "turn-line-1",
        eventType: "message",
      }),
    );
  });

  it("rejects unsigned LINE webhooks", async () => {
    app = Fastify();
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "line",
        config: {
          channelSecret: "line-channel-secret",
        },
      })),
    } as never);
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
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "slack",
        config: { signingSecret: "slack-signing-secret" },
      })),
      ingestChannelMessage,
    } as never);
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
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "slack",
        config: { signingSecret: "slack-signing-secret" },
      })),
    } as never);
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
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "telegram",
        config: { webhookSecret: "telegram-webhook-secret" },
      })),
    } as never);
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
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "nextcloud-talk",
        config: { token: "nextcloud-secret" },
      })),
      recordDevDiagnostic: vi.fn(),
    } as never);
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
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "discord",
        config: { token: "discord-token" },
      })),
      recordDevDiagnostic: vi.fn(),
    } as never);
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
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "nextcloud-talk",
        config: { token: "nextcloud-secret" },
      })),
      ingestChannelMessage,
      recordDevDiagnostic,
    } as never);
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

describe("channel setup routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns a channel setup definition", async () => {
    const getChannelSetupDefinition = vi.fn(() => ({
      catalog: { catalogId: "channel.discord", label: "Discord" },
      wizard: { steps: [] },
    }));
    app = Fastify();
    app.decorate("gateway", {
      getChannelSetupDefinition,
    } as never);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/channels/catalog/channel.discord/setup-definition",
    });

    expect(response.statusCode).toBe(200);
    expect(getChannelSetupDefinition).toHaveBeenCalledWith("channel.discord");
    expect(response.json()).toEqual(
      expect.objectContaining({
        catalog: expect.objectContaining({ catalogId: "channel.discord" }),
      }),
    );
  });

  it("lists available channel setup definitions", async () => {
    const listChannelSetupDefinitions = vi.fn(() => [
      {
        catalog: { catalogId: "channel.discord", label: "Discord" },
        wizard: { steps: [] },
      },
    ]);
    app = Fastify();
    app.decorate("gateway", {
      listChannelSetupDefinitions,
    } as never);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/channels/setup-definitions",
    });

    expect(response.statusCode).toBe(200);
    expect(listChannelSetupDefinitions).toHaveBeenCalledOnce();
    expect(response.json()).toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            catalog: expect.objectContaining({ catalogId: "channel.discord" }),
          }),
        ]),
      }),
    );
  });

  it("lists channel setup drafts", async () => {
    const listChannelSetupDrafts = vi.fn(() => [
      {
        draftId: "11111111-1111-1111-1111-111111111111",
        catalogId: "channel.discord",
        lifecycleMode: "repair",
        enabled: true,
        draft: {},
        contentVersion: "content.v1",
        adapterVersion: "adapter.v1",
        validationVersion: "validation.v1",
        testVersion: "test.v1",
        createdAt: "2026-03-29T00:00:00.000Z",
        updatedAt: "2026-03-29T00:10:00.000Z",
      },
    ]);
    app = Fastify();
    app.decorate("gateway", {
      listChannelSetupDrafts,
    } as never);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/channels/drafts?catalogId=channel.discord&limit=10",
    });

    expect(response.statusCode).toBe(200);
    expect(listChannelSetupDrafts).toHaveBeenCalledWith({
      catalogId: "channel.discord",
      limit: 10,
    });
    expect(response.json()).toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            draftId: "11111111-1111-1111-1111-111111111111",
          }),
        ]),
      }),
    );
  });

  it("creates and updates channel setup drafts", async () => {
    const createChannelSetupDraft = vi.fn(() => ({
      draftId: "11111111-1111-1111-1111-111111111111",
      catalogId: "channel.discord",
      lifecycleMode: "create",
      enabled: true,
      draft: {},
      contentVersion: "content.v1",
      adapterVersion: "adapter.v1",
      validationVersion: "validation.v1",
      testVersion: "test.v1",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    }));
    const updateChannelSetupDraft = vi.fn(() => ({
      draftId: "11111111-1111-1111-1111-111111111111",
      catalogId: "channel.discord",
      lifecycleMode: "create",
      enabled: true,
      draft: { defaultChannelId: "123456789012345678" },
      contentVersion: "content.v1",
      adapterVersion: "adapter.v1",
      validationVersion: "validation.v1",
      testVersion: "test.v1",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:10:00.000Z",
    }));
    app = Fastify();
    app.decorate("gateway", {
      createChannelSetupDraft,
      updateChannelSetupDraft,
    } as never);
    await app.register(integrationsRoutes);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/drafts",
      payload: {
        catalogId: "channel.discord",
        lifecycleMode: "create",
      },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createChannelSetupDraft).toHaveBeenCalledWith({
      catalogId: "channel.discord",
      lifecycleMode: "create",
    });

    const updateResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/channels/drafts/11111111-1111-1111-1111-111111111111",
      payload: {
        draft: {
          defaultChannelId: "123456789012345678",
        },
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateChannelSetupDraft).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", {
      draft: {
        defaultChannelId: "123456789012345678",
      },
    });
  });

  it("validates, tests, and finalizes channel setup drafts", async () => {
    const validateChannelSetupDraft = vi.fn(() => ({
      draftId: "11111111-1111-1111-1111-111111111111",
      status: "ok",
      levels: ["structural", "semantic"],
      issues: [],
      checkedAt: "2026-03-29T00:00:00.000Z",
    }));
    const testChannelSetupDraft = vi.fn(async () => ({
      draftId: "11111111-1111-1111-1111-111111111111",
      status: "ok",
      levels: ["live-auth"],
      issues: [],
      checkedAt: "2026-03-29T00:05:00.000Z",
      recommendedNextAction: "Finalize the connection.",
    }));
    const finalizeChannelSetupDraft = vi.fn(async () => ({
      connection: {
        connectionId: "22222222-2222-2222-2222-222222222222",
        catalogId: "channel.discord",
        kind: "channel",
        key: "discord",
        label: "Discord Primary",
        enabled: true,
        status: "connected",
        config: {},
        createdAt: "2026-03-29T00:00:00.000Z",
        updatedAt: "2026-03-29T00:10:00.000Z",
      },
      validation: {
        draftId: "11111111-1111-1111-1111-111111111111",
        status: "ok",
        levels: ["structural", "semantic"],
        issues: [],
        checkedAt: "2026-03-29T00:00:00.000Z",
      },
      test: {
        draftId: "11111111-1111-1111-1111-111111111111",
        status: "ok",
        levels: ["live-auth"],
        issues: [],
        checkedAt: "2026-03-29T00:05:00.000Z",
      },
    }));
    app = Fastify();
    app.decorate("gateway", {
      validateChannelSetupDraft,
      testChannelSetupDraft,
      finalizeChannelSetupDraft,
    } as never);
    await app.register(integrationsRoutes);

    const validateResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/drafts/11111111-1111-1111-1111-111111111111/validate",
    });
    expect(validateResponse.statusCode).toBe(200);
    expect(validateChannelSetupDraft).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");

    const testResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/drafts/11111111-1111-1111-1111-111111111111/test",
    });
    expect(testResponse.statusCode).toBe(200);
    expect(testChannelSetupDraft).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");

    const finalizeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/drafts/11111111-1111-1111-1111-111111111111/finalize",
    });
    expect(finalizeResponse.statusCode).toBe(200);
    expect(finalizeChannelSetupDraft).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    expect(finalizeResponse.json()).toEqual(
      expect.objectContaining({
        connection: expect.objectContaining({
          connectionId: "22222222-2222-2222-2222-222222222222",
        }),
      }),
    );
  });

  it("creates repair and rotate-secret drafts and supports re-test", async () => {
    const createChannelSetupRepairDraft = vi.fn(() => ({
      draftId: "11111111-1111-1111-1111-111111111111",
      catalogId: "channel.discord",
      lifecycleMode: "repair",
      enabled: true,
      draft: {},
      contentVersion: "content.v1",
      adapterVersion: "adapter.v1",
      validationVersion: "validation.v1",
      testVersion: "test.v1",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    }));
    const createChannelSetupRotateSecretDraft = vi.fn(() => ({
      draftId: "33333333-3333-3333-3333-333333333333",
      catalogId: "channel.discord",
      lifecycleMode: "rotate_secret",
      enabled: true,
      draft: {},
      contentVersion: "content.v1",
      adapterVersion: "adapter.v1",
      validationVersion: "validation.v1",
      testVersion: "test.v1",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    }));
    const retestChannelConnection = vi.fn(async () => ({
      draftId: "44444444-4444-4444-4444-444444444444",
      status: "ok",
      levels: ["live-auth"],
      issues: [],
      checkedAt: "2026-03-29T00:05:00.000Z",
      recommendedNextAction: "Finalize the connection.",
    }));
    app = Fastify();
    app.decorate("gateway", {
      createChannelSetupRepairDraft,
      createChannelSetupRotateSecretDraft,
      retestChannelConnection,
    } as never);
    await app.register(integrationsRoutes);

    const repairResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/repair-draft",
    });
    expect(repairResponse.statusCode).toBe(201);
    expect(createChannelSetupRepairDraft).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");

    const rotateResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/rotate-secret-draft",
    });
    expect(rotateResponse.statusCode).toBe(201);
    expect(createChannelSetupRotateSecretDraft).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");

    const retestResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/retest",
    });
    expect(retestResponse.statusCode).toBe(200);
    expect(retestChannelConnection).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
  });
});
