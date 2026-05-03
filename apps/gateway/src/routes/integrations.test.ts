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
import { createTelegramChannelSessionPatch } from "../services/telegram-channel-sessions.js";
import { buildWhatsAppWebhookSignature } from "../services/whatsapp-webhook.js";
import { buildInstalledIntegrationPluginRecord } from "../services/integration-plugin-author-contract.js";
import { buildSlackOAuthStart } from "../services/slack-oauth-service.js";
import type { FastifyPluginAsync } from "fastify";
import { integrationWebhookRoutes } from "./integration-webhooks.js";
import { integrationsRoutes as baseIntegrationsRoutes } from "./integrations.js";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

const integrationsRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(baseIntegrationsRoutes);
  await fastify.register(integrationWebhookRoutes);
};

const gatewayAuthMethodNames = new Set([
  "validateDeviceAccessToken",
  "validateCompanionAccessToken",
  "verifyCompanionRequestSignature",
]);

function decorateIntegrationServices(app: FastifyInstance, methods: Record<string, unknown>) {
  const routeMethods: Record<string, unknown> = {};
  const gatewayMethods: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(methods)) {
    if (gatewayAuthMethodNames.has(key)) {
      gatewayMethods[key] = value;
      continue;
    }
    routeMethods[key] = value;
  }
  if (Object.keys(routeMethods).length > 0) {
    app.decorate("services", {
      channelSetup: routeMethods,
      integrations: routeMethods,
      obsidian: routeMethods,
      integrationWebhooks: routeMethods,
    } as never);
  }
  app.decorate("gatewayAuth", {
    getOnboardingStartupState: () => ({ completed: true }),
    validateDeviceAccessToken: () => undefined,
    validateCompanionAccessToken: () => undefined,
    verifyCompanionRequestSignature: () => undefined,
    ...gatewayMethods,
  } as never);
}

describe("integrations inbound route guards", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("rejects channel inbound payloads with oversized content-length", async () => {
    const ingestChannelMessage = vi.fn();
    app = Fastify();
    decorateIntegrationServices(app, {
      ingestChannelMessage,
    });
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

  it("starts Slack OAuth with a signed authorization URL", async () => {
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_CLIENT_ID", "123.abc");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_REDIRECT_URI", "https://goatcitadel.test/slack/callback");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_STATE_SECRET", "state-secret");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_BROKER_AUTHORIZE_URL", "https://broker.goatcitadel.test/slack/authorize");
    app = Fastify();
    decorateIntegrationServices(app, {
      listIntegrationConnections: () => [],
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/slack/oauth/start",
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.configured).toBe(true);
    expect(payload.mode).toBe("hosted");
    expect(payload.authorizationUrl).toContain("https://broker.goatcitadel.test/slack/authorize");
    expect(payload.scopes).toContain("chat:write");
  });

  it("stores Slack OAuth callback metadata without returning the raw bot token", async () => {
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_CLIENT_ID", "123.abc");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_REDIRECT_URI", "https://goatcitadel.test/slack/callback");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_STATE_SECRET", "state-secret");
    const start = buildSlackOAuthStart({
      clientId: "123.abc",
      clientSecret: "client-secret",
      redirectUri: "https://goatcitadel.test/slack/callback",
      stateSecret: "state-secret",
    });
    const createIntegrationConnection = vi.fn((input) => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      kind: "channel",
      key: "slack",
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
      ...input,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-secret",
            scope: "chat:write,channels:read",
            bot_user_id: "U-BOT",
            app_id: "A123",
            team: { id: "T123", name: "Citadel" },
            authed_user: { id: "U-INSTALLER" },
          }),
          { status: 200 },
        );
      }),
    );
    app = Fastify();
    decorateIntegrationServices(app, {
      createIntegrationConnection,
      listIntegrationConnections: () => [],
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/slack/oauth/callback?code=code-123&state=${encodeURIComponent(start.state ?? "")}`,
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(createIntegrationConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: "channel.slack",
        config: expect.objectContaining({
          authMode: "oauth",
          botToken: "xoxb-secret",
          slackTeamId: "T123",
        }),
      }),
    );
    expect(payload.connection.config.botToken).toBe("[redacted]");
    expect(JSON.stringify(payload)).not.toContain("xoxb-secret");
    expect(payload.install.teamName).toBe("Citadel");
  });

  it("updates an existing Slack OAuth workspace install without wiping configured targets", async () => {
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_CLIENT_ID", "123.abc");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_REDIRECT_URI", "https://goatcitadel.test/slack/callback");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_STATE_SECRET", "state-secret");
    const start = buildSlackOAuthStart({
      clientId: "123.abc",
      clientSecret: "client-secret",
      redirectUri: "https://goatcitadel.test/slack/callback",
      stateSecret: "state-secret",
    });
    const existingConnection = {
      connectionId: "11111111-1111-1111-1111-111111111111",
      catalogId: "channel.slack",
      kind: "channel",
      key: "slack",
      label: "Slack - Old",
      enabled: true,
      status: "connected",
      config: {
        authMode: "oauth",
        slackTeamId: "T123",
        slackInstallId: "slack:T123",
        botToken: "xoxb-old",
        targets: [{ id: "ops", label: "Ops", channel: "#ops", default: true }],
        defaultChannel: "#ops",
      },
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    };
    const updateIntegrationConnection = vi.fn((connectionId, patch) => ({
      ...existingConnection,
      ...patch,
      connectionId,
      config: patch.config,
    }));
    const createIntegrationConnection = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-new",
            scope: "chat:write,channels:read",
            bot_user_id: "U-BOT",
            app_id: "A123",
            team: { id: "T123", name: "Citadel" },
            authed_user: { id: "U-INSTALLER" },
          }),
          { status: 200 },
        );
      }),
    );
    app = Fastify();
    decorateIntegrationServices(app, {
      createIntegrationConnection,
      updateIntegrationConnection,
      listIntegrationConnections: () => [existingConnection],
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/slack/oauth/callback?code=code-123&state=${encodeURIComponent(start.state ?? "")}`,
    });

    expect(response.statusCode).toBe(200);
    expect(createIntegrationConnection).not.toHaveBeenCalled();
    expect(updateIntegrationConnection).toHaveBeenCalledWith(
      existingConnection.connectionId,
      expect.objectContaining({
        status: "connected",
        config: expect.objectContaining({
          botToken: "xoxb-new",
          targets: existingConnection.config.targets,
          defaultChannel: "#ops",
        }),
      }),
    );
  });

  it("rejects Slack OAuth disconnect for non-Slack OAuth connections", async () => {
    const getIntegrationConnection = vi.fn(() => ({
      connectionId: "22222222-2222-2222-2222-222222222222",
      catalogId: "channel.telegram",
      kind: "channel",
      key: "telegram",
      label: "Telegram",
      enabled: true,
      status: "connected",
      config: {
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
      },
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    }));
    const updateIntegrationConnection = vi.fn();
    app = Fastify();
    decorateIntegrationServices(app, {
      getIntegrationConnection,
      updateIntegrationConnection,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/slack/oauth/disconnect",
      payload: {
        connectionId: "22222222-2222-2222-2222-222222222222",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Connection is not a Slack OAuth install.",
    });
    expect(updateIntegrationConnection).not.toHaveBeenCalled();
  });

  it("accepts bounded inbound payloads and forwards to gateway ingest", async () => {
    const ingestChannelMessage = vi.fn(async () => ({
      accepted: true,
      sessionId: "sess-1",
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      ingestChannelMessage,
    });
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
    decorateIntegrationServices(app, {
      runIntegrationConnectionDiagnostics,
    });
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

  it("invokes shared operator actions through the integration action route", async () => {
    const invokeIntegrationConnectionAction = vi.fn(async () => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      catalogId: "productivity.apple-notes",
      actionId: "read",
      status: "executed",
      message: "Fetched sample note payload.",
      checkedAt: "2026-04-10T00:00:00.000Z",
      output: {
        items: [{ title: "Sample note" }],
      },
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      invokeIntegrationConnectionAction,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/actions/read",
      payload: {
        input: {
          query: "sample",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(invokeIntegrationConnectionAction).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", "read", {
      input: { query: "sample" },
    });
    expect(response.json()).toEqual(
      expect.objectContaining({
        catalogId: "productivity.apple-notes",
        actionId: "read",
        status: "executed",
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
    decorateIntegrationServices(app, {
      listDiscordPairings,
    });
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
    decorateIntegrationServices(app, {
      approveDiscordPairing,
      revokeDiscordPairing,
    });
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
    decorateIntegrationServices(app, {
      reconnectDiscordRuntime,
    });
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
    decorateIntegrationServices(app, {
      listIntegrationPlugins,
      installIntegrationPlugin,
      setIntegrationPluginEnabled,
    });
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
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
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
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
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
    expect(updateIntegrationConnection).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      expect.objectContaining({
        config: expect.objectContaining({
          defaultChannelId: "-1001234567890",
          defaultChatId: "-1001234567890",
        }),
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
          telegramChannelSessions: expect.any(Object),
        }),
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
    expect(ingestChannelMessage).toHaveBeenCalledWith(
      "telegram",
      expect.any(String),
      expect.objectContaining({
        room: expect.stringMatching(/^-1001234567890~tg_/),
        content: "start fresh",
      }),
    );
    expect(setChatSessionBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-telegram-rotated",
        target: "-1001234567890",
      }),
    );
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
    expect(cancelLatestActiveChatTurnForSession).toHaveBeenCalledWith(expect.stringMatching(/^sess_/), "telegram:777");
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
    expect(resolveApprovalWithRemoteToken).toHaveBeenCalledWith({
      token: "grat_secret",
      decision: "approve",
      resolvedBy: "telegram:777",
    });
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
    decorateIntegrationServices(app, {
      getChannelSetupDefinition,
    });
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
    decorateIntegrationServices(app, {
      listChannelSetupDefinitions,
    });
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
    decorateIntegrationServices(app, {
      listChannelSetupDrafts,
    });
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
    decorateIntegrationServices(app, {
      createChannelSetupDraft,
      updateChannelSetupDraft,
    });
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
    decorateIntegrationServices(app, {
      validateChannelSetupDraft,
      testChannelSetupDraft,
      finalizeChannelSetupDraft,
    });
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
    decorateIntegrationServices(app, {
      createChannelSetupRepairDraft,
      createChannelSetupRotateSecretDraft,
      retestChannelConnection,
    });
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
