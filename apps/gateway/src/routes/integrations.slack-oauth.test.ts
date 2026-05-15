import { buildSlackOAuthStart } from "../services/slack-oauth-service.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  cleanupIntegrationTestApp,
  decorateIntegrationServices,
  integrationsRoutes,
} from "./integrations-test-fixtures.js";

describe("integrations Slack OAuth routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await cleanupIntegrationTestApp(app);
    app = null;
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

  it("reports Slack OAuth status with redacted installs", async () => {
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_CLIENT_ID", "123.abc");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_REDIRECT_URI", "https://goatcitadel.test/slack/callback");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_STATE_SECRET", "state-secret");
    app = Fastify();
    decorateIntegrationServices(app, {
      listIntegrationConnections: () => [
        {
          connectionId: "11111111-1111-1111-1111-111111111111",
          catalogId: "channel.slack",
          kind: "channel",
          key: "slack",
          label: "Slack - Citadel",
          enabled: true,
          status: "connected",
          config: {
            authMode: "oauth",
            botToken: "xoxb-secret",
            slackInstallId: "slack:T123",
            slackTeamId: "T123",
            slackTeamName: "Citadel",
            slackScopes: "chat:write channels:read",
          },
          createdAt: "2026-05-02T00:00:00.000Z",
          updatedAt: "2026-05-02T00:00:00.000Z",
        },
        {
          connectionId: "22222222-2222-2222-2222-222222222222",
          catalogId: "channel.slack",
          kind: "channel",
          key: "slack",
          label: "Webhook Slack",
          enabled: true,
          status: "connected",
          config: { authMode: "bot_token", botToken: "xoxb-other" },
          createdAt: "2026-05-02T00:00:00.000Z",
          updatedAt: "2026-05-02T00:00:00.000Z",
        },
      ],
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/slack/oauth/status",
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.configured).toBe(true);
    expect(payload.connections).toHaveLength(1);
    expect(payload.connections[0].connection.config.botToken).toBe("[redacted]");
    expect(payload.connections[0].install).toMatchObject({ teamId: "T123", teamName: "Citadel" });
    expect(JSON.stringify(payload)).not.toContain("xoxb-secret");
  });

  it("rejects Slack OAuth start and callback requests that cannot be trusted", async () => {
    app = Fastify();
    decorateIntegrationServices(app, {
      listIntegrationConnections: () => [],
    });
    await app.register(integrationsRoutes);

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/slack/oauth/start",
    });
    expect(start.statusCode).toBe(400);
    expect(start.json().missing).toContain("GOATCITADEL_SLACK_OAUTH_CLIENT_ID");

    const malformedCallback = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/slack/oauth/callback?state=only-state",
    });
    expect(malformedCallback.statusCode).toBe(400);

    const unconfiguredCallback = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/slack/oauth/callback?code=code-123&state=bad-state",
    });
    expect(unconfiguredCallback.statusCode).toBe(400);
    expect(unconfiguredCallback.json()).toEqual({ error: "Slack OAuth is not configured." });

    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_CLIENT_ID", "123.abc");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_REDIRECT_URI", "https://goatcitadel.test/slack/callback");
    vi.stubEnv("GOATCITADEL_SLACK_OAUTH_STATE_SECRET", "state-secret");

    const invalidState = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/slack/oauth/callback?code=code-123&state=bad-state",
    });
    expect(invalidState.statusCode).toBe(400);
    expect(invalidState.json()).toEqual({ error: "Invalid or expired Slack OAuth state." });
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

  it("renders an escaped Slack OAuth success page for browser callbacks", async () => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-secret",
            scope: "chat:write",
            team: { id: "T123", name: `Citadel <Ops> & "QA"` },
          }),
          { status: 200 },
        );
      }),
    );
    app = Fastify();
    decorateIntegrationServices(app, {
      createIntegrationConnection: vi.fn((input) => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        kind: "channel",
        key: "slack",
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
        ...input,
      })),
      listIntegrationConnections: () => [],
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/slack/oauth/callback?code=code-123&state=${encodeURIComponent(start.state ?? "")}`,
      headers: { accept: "text/html" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Citadel &lt;Ops&gt; &amp; &quot;QA&quot;");
    expect(response.body).toContain("goatcitadel.slackOAuth.connected");
    expect(response.body).not.toContain("<Ops>");
  });

  it("surfaces Slack OAuth exchange failures as gateway errors", async () => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ ok: false, error: "invalid_code" }), { status: 200 });
      }),
    );
    app = Fastify();
    decorateIntegrationServices(app, {
      listIntegrationConnections: () => [],
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/slack/oauth/callback?code=code-123&state=${encodeURIComponent(start.state ?? "")}`,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Slack OAuth failed: invalid_code" });
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
      listIntegrationConnections: () => [
        {
          connectionId: "22222222-2222-2222-2222-222222222222",
          catalogId: "channel.telegram",
          kind: "channel",
          key: "telegram",
          label: "Telegram",
          enabled: true,
          status: "connected",
          config: {},
          createdAt: "2026-05-02T00:00:00.000Z",
          updatedAt: "2026-05-02T00:00:00.000Z",
        },
        existingConnection,
      ],
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

  it("disconnects Slack OAuth installs and reports missing installs", async () => {
    const current = {
      connectionId: "11111111-1111-1111-1111-111111111111",
      catalogId: "channel.slack",
      kind: "channel",
      key: "slack",
      label: "Slack - Citadel",
      enabled: true,
      status: "connected",
      config: {
        authMode: "oauth",
        botToken: "xoxb-secret",
        slackTeamId: "T123",
      },
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    };
    const getIntegrationConnection = vi
      .fn()
      .mockReturnValueOnce(current)
      .mockImplementationOnce(() => {
        throw new Error("connection not found");
      });
    const updateIntegrationConnection = vi.fn((connectionId, patch) => ({
      ...current,
      ...patch,
      connectionId,
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      getIntegrationConnection,
      updateIntegrationConnection,
    });
    await app.register(integrationsRoutes);

    const disconnected = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/slack/oauth/disconnect",
      payload: {
        connectionId: "11111111-1111-1111-1111-111111111111",
      },
    });
    expect(disconnected.statusCode).toBe(200);
    expect(updateIntegrationConnection).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", {
      enabled: false,
      status: "disconnected",
      lastError: undefined,
    });
    expect(disconnected.json().connection.config.botToken).toBe("[redacted]");

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/slack/oauth/disconnect",
      payload: {
        connectionId: "11111111-1111-1111-1111-111111111111",
      },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "connection not found" });
  });

  it("rejects malformed Slack OAuth disconnect payloads", async () => {
    const getIntegrationConnection = vi.fn();
    app = Fastify();
    decorateIntegrationServices(app, {
      getIntegrationConnection,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/slack/oauth/disconnect",
      payload: {
        connectionId: "not-a-uuid",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(getIntegrationConnection).not.toHaveBeenCalled();
  });
});
