import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";

const runDiscordBotLiveChecksMock = vi.hoisted(() => vi.fn());
const runNtfyLiveChecksMock = vi.hoisted(() => vi.fn());

vi.mock("./channel-bot-live-probes.js", () => ({
  runDiscordBotLiveChecks: runDiscordBotLiveChecksMock,
  runLineBotLiveChecks: vi.fn(),
  runMattermostBotLiveChecks: vi.fn(),
  runNtfyLiveChecks: runNtfyLiveChecksMock,
  runSlackBotLiveChecks: vi.fn(),
  runTelegramBotLiveChecks: vi.fn(),
  runWhatsAppCloudLiveChecks: vi.fn(),
  runZaloBotLiveChecks: vi.fn(),
}));

import {
  buildIntegrationConnectionChecks,
  IntegrationDiagnosticsService,
  runIntegrationConnectionLiveChecks,
  type IntegrationDiagnosticsPort,
} from "./integration-diagnostics-service.js";
import { isPermittedIntegrationSecretEnvVarName } from "./gateway/integration-secret-envvar-guard.js";

function createDiscordConnection(config: Record<string, unknown>): IntegrationConnection {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    catalogId: "channel.discord",
    kind: "channel",
    key: "discord",
    label: "Discord Primary",
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
  };
}

function createIntegrationConnection(
  key: string,
  kind: IntegrationConnection["kind"],
  config: Record<string, unknown>,
): IntegrationConnection {
  return {
    connectionId: "22222222-2222-2222-2222-222222222222",
    catalogId: `${kind}.${key}`,
    kind,
    key,
    label: key,
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
  };
}

function createPort(): IntegrationDiagnosticsPort {
  return {
    config: {
      toolPolicy: {
        tools: {
          profile: "default",
        },
        sandbox: {
          networkAllowlist: [],
        },
      },
    } as unknown as IntegrationDiagnosticsPort["config"],
    fetchWithDiagnosticsTimeout: vi.fn(async () => new Response("{}")),
    getDiscordRuntimeStatus: vi.fn(() => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      runtimeMode: "gateway" as const,
      status: "connected",
      enabled: true,
      ready: true,
      guildIds: [],
      startedAt: "2026-04-08T00:00:00.000Z",
    })),
    isConnectionUrlAllowlisted: vi.fn(() => false),
    readConnectionConfigValue: vi.fn((config: Record<string, unknown>, key: string) => {
      const value = config[key];
      return typeof value === "string" ? value : undefined;
    }),
    resolveConnectionSecret: vi.fn(resolveLikeTheGateway),
  };
}

/**
 * What `GatewayService.resolveConnectionSecret` does with a plain config: the direct value, else the variable the
 * config names, but only when the credential guard permits that name for the connection's catalog entry.
 */
function resolveLikeTheGateway(
  config: Record<string, unknown>,
  directKey: string,
  envKey: string,
  catalogId?: string,
): string | undefined {
  const direct = config[directKey];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const envName = config[envKey];
  if (typeof envName !== "string" || !envName.trim()) return undefined;
  return isPermittedIntegrationSecretEnvVarName(envName, catalogId) ? process.env[envName.trim()] : undefined;
}

describe("integration-diagnostics-service contract behavior", () => {
  beforeEach(() => {
    runDiscordBotLiveChecksMock.mockReset();
    runNtfyLiveChecksMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("a channel's variable is checked through the name rule its sends use (C6)", () => {
    const SECRET = "must-not-leak-this-value";
    const authOf = (connection: IntegrationConnection, port = createPort()) =>
      buildIntegrationConnectionChecks(port, connection).find((check) => check.key === "auth");

    it("fails a variable that is set but whose name the Gateway refuses, naming the prefix it needs", () => {
      vi.stubEnv("MY_TOKEN", SECRET);
      const port = createPort();
      const connection = createIntegrationConnection("mattermost", "channel", {
        serverUrl: "https://chat.example.test",
        botTokenEnv: "MY_TOKEN",
        defaultChannel: "town-square",
      });

      const checks = buildIntegrationConnectionChecks(port, connection);

      expect(checks.find((check) => check.key === "auth")).toEqual({
        key: "auth",
        status: "fail",
        message: "The variable name must start with MATTERMOST_. Rename it and restart GoatCitadel.",
      });
      // It asks the same resolver the live probes ask, with the connection's catalog entry.
      expect(port.resolveConnectionSecret).toHaveBeenCalledWith(
        connection.config,
        "botToken",
        "botTokenEnv",
        "channel.mattermost",
      );
      expect(JSON.stringify(checks)).not.toContain(SECRET);
    });

    it("also names the suffix when the field is one a webhook reads too", () => {
      vi.stubEnv("MY_SECRET", SECRET);
      const qqbot = authOf(
        createIntegrationConnection("qqbot", "channel", { appId: "102000", appSecretEnv: "MY_SECRET" }),
      );
      const nextcloud = authOf(
        createIntegrationConnection("nextcloud-talk", "channel", {
          baseUrl: "https://cloud.example.test",
          tokenEnv: "MY_SECRET",
        }),
      );

      expect(qqbot).toEqual({
        key: "auth",
        status: "fail",
        message:
          "The variable name must start with QQBOT_. Rename it and restart GoatCitadel. The name must also end in _TOKEN or _SECRET.",
      });
      expect(nextcloud?.message).toBe(
        "The variable name must start with NEXTCLOUD_TALK_. Rename it and restart GoatCitadel. The name must also end in _TOKEN or _SECRET.",
      );
      expect(JSON.stringify([qqbot, nextcloud])).not.toContain(SECRET);
    });

    it("passes a variable whose name the Gateway reads, and says which one", () => {
      vi.stubEnv("MATTERMOST_BOT_TOKEN", SECRET);
      const auth = authOf(
        createIntegrationConnection("mattermost", "channel", {
          serverUrl: "https://chat.example.test",
          botTokenEnv: "MATTERMOST_BOT_TOKEN",
        }),
      );

      expect(auth).toEqual({
        key: "auth",
        status: "pass",
        message: "Mattermost bot token is configured via MATTERMOST_BOT_TOKEN.",
      });
    });

    it("says a rightly named variable is missing when it is not set, and still fails a wrong name that is not set", () => {
      const connection = (name: string) =>
        createIntegrationConnection("mattermost", "channel", {
          serverUrl: "https://chat.example.test",
          botTokenEnv: name,
        });

      expect(authOf(connection("MATTERMOST_BOT_TOKEN"))).toMatchObject({
        status: "fail",
        message: "Mattermost bot token is missing.",
      });
      expect(authOf(connection("NOT_SET_ANYWHERE"))).toMatchObject({
        status: "fail",
        message: expect.stringContaining("MATTERMOST_"),
      });
    });

    it("lets a direct value win, whatever the variable is called", () => {
      vi.stubEnv("MY_TOKEN", SECRET);

      expect(
        authOf(
          createIntegrationConnection("mattermost", "channel", {
            serverUrl: "https://chat.example.test",
            botToken: "keychain:goatcitadel:channel-connection:x:botToken",
            botTokenEnv: "MY_TOKEN",
          }),
        ),
      ).toMatchObject({ status: "pass" });
    });

    it("does not name the variable when a direct value is what answered", () => {
      vi.stubEnv("MATTERMOST_BOT_TOKEN", SECRET);

      expect(
        authOf(
          createIntegrationConnection("mattermost", "channel", {
            serverUrl: "https://chat.example.test",
            botToken: "pasted-direct-value",
            botTokenEnv: "MATTERMOST_BOT_TOKEN",
          }),
        ),
      ).toEqual({ key: "auth", status: "pass", message: "Mattermost bot token is configured." });
    });

    it.each([
      ["a token pasted into the name field while a direct value answers", { botToken: "pasted-direct-value" }],
      ["a token pasted into the name field and nothing else", {}],
    ])("never prints %s", (_label, direct) => {
      const pasted = "xoxb-pasted-token-0005-not-a-name";
      vi.stubEnv(pasted, SECRET);
      const auth = authOf(
        createIntegrationConnection("mattermost", "channel", {
          serverUrl: "https://chat.example.test",
          botTokenEnv: pasted,
          ...direct,
        }),
      );

      expect(auth).toBeDefined();
      expect(JSON.stringify(auth)).not.toContain(pasted);
      expect(JSON.stringify(auth)).not.toContain(SECRET);
      if (Object.keys(direct).length > 0) {
        expect(auth).toMatchObject({ status: "pass", message: "Mattermost bot token is configured." });
      } else {
        expect(auth).toMatchObject({ status: "fail", message: expect.stringContaining("MATTERMOST_") });
      }
    });

    it("keeps a model provider's key variable a plain is-it-set check, since no resolver reads it", () => {
      vi.stubEnv("OPENAI_API_KEY", SECRET);
      const connection = (apiKeyEnv: string) =>
        createIntegrationConnection("openai", "model_provider", {
          baseUrl: "https://api.openai.example.test/v1",
          model: "gpt-test",
          apiKeyEnv,
        });

      // The form suggests the provider's own variable, which the credential guard forbids for an integration secret.
      expect(authOf(connection("OPENAI_API_KEY"))).toMatchObject({ status: "pass", message: "API key is configured." });
      expect(authOf(connection("NOT_SET_ANYWHERE"))).toMatchObject({ status: "fail", message: "API key is missing." });
    });

    it("applies the same rule to the variables that GIF search, Trello and a remote bridge read", () => {
      vi.stubEnv("GIF_API_KEY", SECRET);
      vi.stubEnv("GIPHY_API_KEY", SECRET);
      vi.stubEnv("TRELLO_KEY", SECRET);
      vi.stubEnv("TRELLO_TOKEN", SECRET);
      vi.stubEnv("MY_BRIDGE_TOKEN", SECRET);
      const bridge = (authTokenEnv: string) =>
        buildIntegrationConnectionChecks(
          createPort(),
          createIntegrationConnection("peekaboo-screen", "automation", {
            bridgeUrl: "https://remote-screen.example.test",
            authTokenEnv,
          }),
        ).find((check) => check.key === "bridge_auth");

      expect(
        authOf(
          createIntegrationConnection("gif-search", "automation", { provider: "giphy", apiKeyEnv: "GIF_API_KEY" }),
        ),
      ).toMatchObject({ status: "fail" });
      expect(
        authOf(
          createIntegrationConnection("gif-search", "automation", { provider: "giphy", apiKeyEnv: "GIPHY_API_KEY" }),
        ),
      ).toMatchObject({ status: "pass" });
      expect(
        authOf(
          createIntegrationConnection("trello", "productivity", {
            apiKeyEnv: "TRELLO_KEY",
            tokenEnv: "MY_BRIDGE_TOKEN",
          }),
        ),
      ).toMatchObject({ status: "fail" });
      expect(
        authOf(
          createIntegrationConnection("trello", "productivity", { apiKeyEnv: "TRELLO_KEY", tokenEnv: "TRELLO_TOKEN" }),
        ),
      ).toMatchObject({ status: "pass" });
      expect(bridge("MY_BRIDGE_TOKEN")).toMatchObject({ status: "warn" });
    });

    it("applies the same rule to a Slack or Discord bot token variable", () => {
      vi.stubEnv("MY_TOKEN", SECRET);
      vi.stubEnv("DISCORD_BOT_TOKEN", SECRET);
      vi.stubEnv("SLACK_BOT_TOKEN", SECRET);

      expect(authOf(createIntegrationConnection("discord", "channel", { botTokenEnv: "MY_TOKEN" }))).toMatchObject({
        status: "fail",
        message: "Discord bot token or webhook is missing.",
      });
      expect(
        authOf(createIntegrationConnection("discord", "channel", { botTokenEnv: "DISCORD_BOT_TOKEN" })),
      ).toMatchObject({ status: "pass" });
      expect(authOf(createIntegrationConnection("slack", "channel", { botTokenEnv: "MY_TOKEN" }))).toMatchObject({
        status: "fail",
        message: "Slack bot token or webhook is missing.",
      });
      expect(authOf(createIntegrationConnection("slack", "channel", { botTokenEnv: "SLACK_BOT_TOKEN" }))).toMatchObject(
        { status: "pass" },
      );
    });
  });

  it("marks remote plain-http webhook URLs as unsafe while still recognizing configured auth", () => {
    const host = createPort();
    const connection = createDiscordConnection({
      webhookUrl: "http://discord.example.test/webhook",
      defaultChannelId: "123456789012345678",
      runtimeMode: "bridge",
    });

    const checks = buildIntegrationConnectionChecks(host, connection);
    const authCheck = checks.find((item) => item.key === "auth");
    const urlCheck = checks.find((item) => item.key === "url");

    expect(authCheck).toMatchObject({
      status: "pass",
      message: expect.stringContaining("configured"),
    });
    expect(urlCheck).toMatchObject({
      status: "fail",
      message: expect.stringContaining("non-local plain HTTP"),
    });
  });

  it("composes discord live-check inputs from connection config and runtime state", async () => {
    const host = createPort();
    const connection = createDiscordConnection({
      runtimeMode: "gateway",
      botToken: "discord-token",
      defaultChannelId: "channel_1",
      defaultGuildId: "guild_1",
      webhookUrl: "https://discord.example.test/webhook",
    });
    runDiscordBotLiveChecksMock.mockResolvedValue({
      checks: [{ key: "auth_live", status: "pass", message: "connected" }],
      probe: { canSend: true },
    });

    const result = await runIntegrationConnectionLiveChecks(host, connection, { includeSandboxSend: true });

    expect(result).toMatchObject({
      checks: [{ key: "auth_live", status: "pass", message: "connected" }],
      probe: { canSend: true },
    });
    expect(runDiscordBotLiveChecksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "discord-token",
        runtimeStatus: expect.objectContaining({
          status: "connected",
          startedAt: "2026-04-08T00:00:00.000Z",
        }),
        channelId: "channel_1",
        guildId: "guild_1",
        runtimeMode: "gateway",
        webhookUrl: "https://discord.example.test/webhook",
        includeSandboxSend: true,
        fetcher: expect.any(Function),
      }),
    );
  });

  it("defers Discord runtime lookup for pre-finalize setup probes", async () => {
    const host = createPort();
    const getDiscordRuntimeStatus = vi.fn(() => undefined);
    host.getDiscordRuntimeStatus = getDiscordRuntimeStatus;
    const connection = createDiscordConnection({
      runtimeMode: "gateway",
      botToken: "discord-token",
      defaultChannelId: "channel_1",
    });
    runDiscordBotLiveChecksMock.mockResolvedValue({
      checks: [],
      probe: { kind: "discord_gateway", mode: "gateway", checkedAt: "2026-08-07T00:00:00.000Z", steps: [] },
    });

    await runIntegrationConnectionLiveChecks(host, connection, {
      includeSandboxSend: true,
      discordRuntimeReadiness: "deferred",
    });

    expect(getDiscordRuntimeStatus).not.toHaveBeenCalled();
    expect(runDiscordBotLiveChecksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeMode: "gateway",
        runtimeReadiness: "deferred",
        runtimeStatus: undefined,
      }),
    );
  });

  it("routes ntfy diagnostics through the single-send governed probe owner", async () => {
    const host = createPort();
    const connection = createIntegrationConnection("ntfy", "channel", {
      baseUrl: "https://ntfy.example.test",
      topic: "goatcitadel-ops",
      token: "ntfy-secret",
      priority: "4",
      dryRun: true,
    });
    runNtfyLiveChecksMock.mockResolvedValue({
      checks: [],
      probe: {
        kind: "ntfy_publish",
        mode: "dry_run",
        checkedAt: "2026-07-13T20:00:00.000Z",
        steps: [{ key: "ntfy_sandbox_send", label: "Sandbox send", status: "skipped", message: "dry-run" }],
      },
    });

    const checks = buildIntegrationConnectionChecks(host, connection);
    const result = await runIntegrationConnectionLiveChecks(host, connection, { includeSandboxSend: true });

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "delivery_posture", status: "pass" }),
        expect.objectContaining({ key: "target", status: "pass" }),
      ]),
    );
    expect(runNtfyLiveChecksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://ntfy.example.test",
        topic: "goatcitadel-ops",
        token: "ntfy-secret",
        priority: "4",
        dryRun: true,
        includeSandboxSend: true,
        fetcher: expect.any(Function),
      }),
    );
    expect(result.probe).toMatchObject({ kind: "ntfy_publish", mode: "dry_run" });
  });

  it("reports QQBot and WeCom structural checks with default-deny inbound copy", () => {
    const host = createPort();
    const qq = buildIntegrationConnectionChecks(
      host,
      createIntegrationConnection("qqbot", "channel", {
        appId: "102000",
        appSecret: "qq-secret",
        defaultTarget: "group:G1",
      }),
    );
    expect(qq).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "auth", status: "pass" }),
        expect.objectContaining({ key: "target", status: "pass" }),
        expect.objectContaining({
          key: "delivery_posture",
          status: "pass",
          message: expect.stringContaining("default-deny"),
        }),
        expect.objectContaining({ key: "inbound_access_allowlist_empty", status: "warn" }),
      ]),
    );
    expect(JSON.stringify(qq)).not.toMatch(/anyone can/i);

    const noTarget = buildIntegrationConnectionChecks(
      host,
      createIntegrationConnection("qqbot", "channel", { appId: "102000", appSecret: "qq-secret" }),
    );
    expect(noTarget.find((check) => check.key === "target")).toMatchObject({ status: "warn" });

    const missingId = buildIntegrationConnectionChecks(
      host,
      createIntegrationConnection("qqbot", "channel", { appSecret: "qq-secret" }),
    );
    expect(missingId.find((check) => check.key === "app_id")).toMatchObject({ status: "fail" });

    const wecom = buildIntegrationConnectionChecks(
      host,
      createIntegrationConnection("wecom", "channel", {
        corpId: "ww1",
        agentId: "1000002",
        secret: "wecom-secret",
        callbackTokenEnv: "WECOM_CALLBACK_TOKEN",
        encodingAesKeyEnv: "WECOM_ENCODING_AES_KEY",
        allowedSenders: ["zhangsan"],
      }),
    );
    expect(wecom).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "auth", status: "pass" }),
        expect.objectContaining({
          key: "delivery_posture",
          status: "pass",
          message: expect.stringContaining("default-deny"),
        }),
        expect.objectContaining({ key: "inbound_access", status: "pass" }),
      ]),
    );

    const outboundOnly = buildIntegrationConnectionChecks(
      host,
      createIntegrationConnection("wecom", "channel", { corpId: "ww1", agentId: "1", secret: "wecom-secret" }),
    );
    expect(outboundOnly.find((check) => check.key === "inbound_callback")).toMatchObject({
      status: "pass",
      message: expect.stringContaining("inbound is disabled"),
    });
    expect(outboundOnly.some((check) => check.key.startsWith("inbound_access"))).toBe(false);
  });

  it("asks an incoming Google Chat webhook for nothing but its link: the thread key is optional", () => {
    const host = createPort();
    host.isConnectionUrlAllowlisted = vi.fn(() => true);
    const webhook = "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t";

    const checks = buildIntegrationConnectionChecks(
      host,
      createIntegrationConnection("google-chat", "channel", { webhookUrl: webhook }),
    );

    expect(checks.map((check) => check.key)).not.toContain("target");
    expect(checks.filter((check) => check.status !== "pass")).toEqual([]);
  });

  it("still asks a Google Chat app for its default space, as a warning that does not fail the check", () => {
    const host = createPort();
    const app = {
      serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
      audienceType: "project_number",
      audience: "123456789012",
    };

    const without = buildIntegrationConnectionChecks(host, createIntegrationConnection("google-chat", "channel", app));
    const withSpace = buildIntegrationConnectionChecks(
      host,
      createIntegrationConnection("google-chat", "channel", { ...app, defaultSpace: "spaces/AAAA" }),
    );

    expect(without.find((check) => check.key === "target")).toMatchObject({ status: "warn" });
    expect(withSpace.find((check) => check.key === "target")).toMatchObject({ status: "pass" });
  });

  it("requires local bridge posture for local-app productivity entries", () => {
    const host = createPort();
    const connection = createIntegrationConnection("apple-notes", "productivity", {
      bridgeUrl: "https://remote-agent.example.test",
    });

    const checks = buildIntegrationConnectionChecks(host, connection);

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "url",
          status: "warn",
        }),
        expect.objectContaining({
          key: "host_requirement",
          status: "warn",
        }),
      ]),
    );
  });

  it("checks a Google connection's client ID and capability switches, and flags a pasted token as ignored", () => {
    const host = createPort();
    const ready = buildIntegrationConnectionChecks(
      host,
      createIntegrationConnection("gmail", "automation", {
        clientId: "1234567890-abc.apps.googleusercontent.com",
        gmailRead: true,
        calendarWrite: true,
      }),
    );
    expect(ready).toEqual([
      expect.objectContaining({ key: "oauth_client", status: "pass" }),
      expect.objectContaining({
        key: "capabilities",
        status: "pass",
        message: "Turned on: Read Gmail, Create Calendar events.",
      }),
    ]);
    const legacy = buildIntegrationConnectionChecks(
      host,
      createIntegrationConnection("gmail", "automation", {
        refreshTokenHandle: "gmail-primary",
        accessToken: "ya29.x",
      }),
    );
    expect(legacy).toEqual([
      expect.objectContaining({ key: "oauth_client", status: "fail" }),
      expect.objectContaining({ key: "capabilities", status: "warn" }),
      expect.objectContaining({ key: "legacy_access_token", status: "warn" }),
    ]);
  });

  it("reports Google sign-in readiness and each switched-on scope without contacting Google", async () => {
    const fetchWithDiagnosticsTimeout = vi.fn();
    const port = {
      ...createPort(),
      fetchWithDiagnosticsTimeout,
      getGoogleWorkspaceOAuthStatus: vi.fn(async (connectionId: string) => ({
        connectionId,
        keychainAvailable: true,
        clientIdConfigured: true,
        clientSecretSource: "keychain" as const,
        redirectUri: "http://127.0.0.1:8787/api/v1/integrations/google/oauth/callback",
        connected: true,
        requiresReauth: false,
        accountLabel: "operator@example.com",
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        capabilities: [
          {
            capability: "gmail.read" as const,
            scope: "https://www.googleapis.com/auth/gmail.readonly",
            write: false,
            enabled: true,
            granted: true,
          },
          {
            capability: "gmail.send" as const,
            scope: "https://www.googleapis.com/auth/gmail.send",
            write: true,
            enabled: true,
            granted: false,
          },
          {
            capability: "calendar.read" as const,
            scope: "https://www.googleapis.com/auth/calendar.events.readonly",
            write: false,
            enabled: false,
            granted: false,
          },
          {
            capability: "calendar.write" as const,
            scope: "https://www.googleapis.com/auth/calendar.events",
            write: true,
            enabled: false,
            granted: false,
          },
        ],
        legacyAccessTokenConfigured: false,
      })),
    };
    const connection = createIntegrationConnection("gmail", "automation", {
      clientId: "1234567890-abc.apps.googleusercontent.com",
    });
    const { checks } = await runIntegrationConnectionLiveChecks(port, connection, { includeSandboxSend: true });
    expect(checks).toEqual([
      expect.objectContaining({ key: "client_secret", status: "pass" }),
      expect.objectContaining({
        key: "sign_in",
        status: "pass",
        message: "Signed in to Google as operator@example.com.",
      }),
      expect.objectContaining({ key: "scope:gmail.read", status: "pass" }),
      expect.objectContaining({ key: "scope:gmail.send", status: "fail" }),
    ]);
    expect(fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("checks the Notion token structurally and with a live users/me probe", async () => {
    vi.stubEnv("NOTION_INTEGRATION_TOKEN", "notion-secret");
    vi.stubEnv("GOATCITADEL_NOTION_API_BASE_URL", "http://notion.test");
    try {
      const configured = createIntegrationConnection("notion", "productivity", {
        tokenEnv: "NOTION_INTEGRATION_TOKEN",
        token: "notion-secret",
        defaultParentPageId: "parent-1",
      });
      expect(buildIntegrationConnectionChecks(createPort(), configured)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "auth", status: "pass" }),
          expect.objectContaining({ key: "target", status: "pass" }),
        ]),
      );
      const missing = createIntegrationConnection("notion", "productivity", {});
      expect(buildIntegrationConnectionChecks(createPort(), missing)).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: "auth", status: "fail" })]),
      );

      const port = createPort();
      vi.mocked(port.fetchWithDiagnosticsTimeout).mockResolvedValueOnce(
        new Response('{"object":"user"}', { status: 200 }),
      );
      const live = await runIntegrationConnectionLiveChecks(port, configured, { includeSandboxSend: false });
      expect(live.checks).toEqual([expect.objectContaining({ key: "auth_live", status: "pass" })]);
      expect(vi.mocked(port.fetchWithDiagnosticsTimeout).mock.calls[0]![0]).toBe("http://notion.test/v1/users/me");

      vi.mocked(port.fetchWithDiagnosticsTimeout).mockResolvedValueOnce(new Response("{}", { status: 401 }));
      const rejected = await runIntegrationConnectionLiveChecks(port, configured, { includeSandboxSend: false });
      expect(rejected.checks).toEqual([expect.objectContaining({ key: "auth_live", status: "fail" })]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("checks the GitHub token and default repository structurally and with a live repo probe", async () => {
    vi.stubEnv("GITHUB_INTEGRATION_TOKEN", "github-secret");
    vi.stubEnv("GOATCITADEL_GITHUB_API_BASE_URL", "http://github.test");
    try {
      const configured = createIntegrationConnection("github", "productivity", {
        tokenEnv: "GITHUB_INTEGRATION_TOKEN",
        token: "github-secret",
        defaultRepo: "octo/widgets",
      });
      expect(buildIntegrationConnectionChecks(createPort(), configured)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "auth", status: "pass" }),
          expect.objectContaining({ key: "target", status: "pass" }),
        ]),
      );
      const missing = createIntegrationConnection("github", "productivity", {});
      expect(buildIntegrationConnectionChecks(createPort(), missing)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "auth", status: "fail" }),
          expect.objectContaining({ key: "target", status: "fail" }),
        ]),
      );

      const port = createPort();
      vi.mocked(port.fetchWithDiagnosticsTimeout).mockResolvedValueOnce(
        new Response('{"full_name":"octo/widgets"}', { status: 200 }),
      );
      const live = await runIntegrationConnectionLiveChecks(port, configured, { includeSandboxSend: false });
      expect(live.checks).toEqual([expect.objectContaining({ key: "auth_live", status: "pass" })]);
      expect(vi.mocked(port.fetchWithDiagnosticsTimeout).mock.calls[0]![0]).toBe(
        "http://github.test/repos/octo/widgets",
      );

      vi.mocked(port.fetchWithDiagnosticsTimeout).mockResolvedValueOnce(new Response("{}", { status: 401 }));
      const rejected = await runIntegrationConnectionLiveChecks(port, configured, { includeSandboxSend: false });
      expect(rejected.checks).toEqual([expect.objectContaining({ key: "auth_live", status: "fail" })]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports forbidden GitHub/Notion token env names as failing auth and live checks", async () => {
    for (const [key, envName, suggested] of [
      ["github", "GITHUB_TOKEN", "GITHUB_INTEGRATION_TOKEN"],
      ["notion", "OPENAI_API_KEY", "NOTION_INTEGRATION_TOKEN"],
    ] as const) {
      vi.stubEnv(envName, "must-not-leak");
      try {
        const port = createPort();
        port.resolveConnectionSecret = vi.fn(() => undefined);
        const connection = createIntegrationConnection(key, "productivity", { tokenEnv: envName });
        const auth = buildIntegrationConnectionChecks(port, connection).find((check) => check.key === "auth");
        expect(auth).toEqual(expect.objectContaining({ status: "fail" }));
        expect(auth?.message).toContain(envName);
        expect(auth?.message).toContain(suggested);
        expect(auth?.message).not.toContain("must-not-leak");
        const live = await runIntegrationConnectionLiveChecks(port, connection, { includeSandboxSend: false });
        expect(live.checks).toEqual([expect.objectContaining({ key: "auth_live", status: "fail" })]);
        expect(port.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  it("passes the structural token check for a direct token resolved through the guarded path", () => {
    const port = createPort();
    port.resolveConnectionSecret = vi.fn(() => "resolved-secret");
    for (const key of ["github", "notion"]) {
      const connection = createIntegrationConnection(key, "productivity", { token: "keychain:opaque" });
      expect(buildIntegrationConnectionChecks(port, connection)).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: "auth", status: "pass" })]),
      );
    }
  });

  it("uses the service wrapper while checking local model-provider and platform readiness", async () => {
    const host = createPort();
    host.isConnectionUrlAllowlisted = vi.fn(() => true);
    const service = new IntegrationDiagnosticsService(host);

    const modelChecks = service.buildIntegrationConnectionChecks(
      createIntegrationConnection("local-openai", "model_provider", {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama-local",
      }),
    );
    const platformChecks = service.buildIntegrationConnectionChecks(
      createIntegrationConnection("ios-canvas-camera-voice", "platform", {
        deviceId: "ipad-ops",
        companionSessionId: "companion-1",
      }),
    );
    const nonChannelLive = await service.runIntegrationConnectionLiveChecks(
      createIntegrationConnection("gmail", "automation", {}),
      { includeSandboxSend: false },
    );

    expect(modelChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "url", status: "pass" }),
        expect.objectContaining({ key: "target", status: "pass" }),
        expect.objectContaining({
          key: "auth",
          status: "pass",
          message: "Local model endpoint does not require an API key.",
        }),
      ]),
    );
    expect(platformChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "device", status: "pass" }),
        expect.objectContaining({ key: "companion", status: "pass" }),
      ]),
    );
    expect(nonChannelLive).toEqual({ checks: [] });
  });

  it("builds static readiness checks across channel, automation, productivity, and platform connection shapes", () => {
    const host = createPort();
    host.isConnectionUrlAllowlisted = vi.fn((urlValue: string) => urlValue.includes("hooks.example.test"));
    host.config.toolPolicy.sandbox.networkAllowlist = ["api.telegram.org"];
    const originalEnv = {
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      MATTERMOST_TOKEN: process.env.MATTERMOST_TOKEN,
      TRELLO_KEY: process.env.TRELLO_KEY,
      TRELLO_TOKEN: process.env.TRELLO_TOKEN,
      GIPHY_API_KEY: process.env.GIPHY_API_KEY,
    };
    process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
    process.env.MATTERMOST_TOKEN = "mattermost-token";
    process.env.TRELLO_KEY = "trello-key";
    process.env.TRELLO_TOKEN = "trello-token";
    process.env.GIPHY_API_KEY = "gif-key";
    try {
      const telegram = buildIntegrationConnectionChecks(
        host,
        createIntegrationConnection("telegram", "channel", {
          botTokenEnv: "TELEGRAM_BOT_TOKEN",
          defaultChatId: "12345",
        }),
      );
      expect(telegram).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "auth", status: "pass" }),
          expect.objectContaining({ key: "target", status: "pass" }),
          expect.objectContaining({ key: "url", status: "pass" }),
        ]),
      );

      const webhookChannels = [
        createIntegrationConnection("google-chat", "channel", {
          webhookUrl: "https://hooks.example.test/google",
          defaultThreadKey: "thread-1",
        }),
        createIntegrationConnection("teams", "channel", {
          webhookUrl: "https://hooks.example.test/teams",
        }),
      ];
      for (const connection of webhookChannels) {
        expect(buildIntegrationConnectionChecks(host, connection)).toEqual(
          expect.arrayContaining([expect.objectContaining({ key: "url", status: "pass" })]),
        );
      }

      const directChannels = [
        createIntegrationConnection("whatsapp", "channel", {
          accessToken: "wa-token",
          phoneNumberId: "phone-1",
          defaultTarget: "15551234567",
        }),
        createIntegrationConnection("mattermost", "channel", {
          serverUrl: "https://chat.example.test",
          botTokenEnv: "MATTERMOST_TOKEN",
          defaultChannel: "town-square",
        }),
        createIntegrationConnection("nextcloud-talk", "channel", {
          baseUrl: "https://cloud.example.test",
          token: "talk-token",
          defaultTarget: "ops",
        }),
        createIntegrationConnection("line", "channel", {
          channelAccessToken: "line-token",
          defaultTarget: "U123",
        }),
        createIntegrationConnection("zalo", "channel", {
          accessToken: "zalo-token",
          defaultTarget: "user-1",
        }),
      ];
      for (const connection of directChannels) {
        expect(buildIntegrationConnectionChecks(host, connection)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ key: "auth", status: "pass" }),
            expect.objectContaining({ key: "target", status: "pass" }),
          ]),
        );
      }
      const automation = [
        createIntegrationConnection("webhooks", "automation", {
          baseUrl: "https://hooks.example.test/inbound",
        }),
        createIntegrationConnection("gif-search", "automation", {
          provider: "giphy",
          apiKeyEnv: "GIPHY_API_KEY",
        }),
        createIntegrationConnection("peekaboo-screen", "automation", {
          bridgeUrl: "https://remote-screen.example.test",
          authToken: "screen-token",
        }),
      ];
      expect(buildIntegrationConnectionChecks(host, automation[0]!)).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: "url", status: "pass" })]),
      );
      expect(buildIntegrationConnectionChecks(host, automation[1]!)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "provider", status: "pass" }),
          expect.objectContaining({ key: "auth", status: "pass" }),
        ]),
      );
      expect(buildIntegrationConnectionChecks(host, automation[2]!)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "url", status: "warn" }),
          expect.objectContaining({ key: "bridge_auth", status: "pass" }),
        ]),
      );

      const productivity = buildIntegrationConnectionChecks(
        host,
        createIntegrationConnection("trello", "productivity", {
          apiKeyEnv: "TRELLO_KEY",
          tokenEnv: "TRELLO_TOKEN",
          defaultBoardId: "board-1",
        }),
      );
      expect(productivity).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "auth", status: "pass" }),
          expect.objectContaining({ key: "target", status: "pass" }),
        ]),
      );

      const platform = buildIntegrationConnectionChecks(
        host,
        createIntegrationConnection("macos-menubar-voice", "platform", {
          bridgeUrl: "http://127.0.0.1:4317",
        }),
      );
      expect(platform).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "url", status: "warn" }),
          expect.objectContaining({ key: "host_requirement", status: "pass" }),
        ]),
      );
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("reports auth-denied and runtime-unavailable live-check fallbacks without probing unsafe paths", async () => {
    const host = createPort();

    const slackWebhookOnly = await runIntegrationConnectionLiveChecks(
      host,
      createIntegrationConnection("slack", "channel", {
        webhookUrl: "https://10.0.0.5/services/T/B/C",
      }),
      { includeSandboxSend: false },
    );
    expect(slackWebhookOnly.checks).toEqual([
      expect.objectContaining({
        key: "slack_sandbox_send",
        status: "fail",
        message: expect.stringContaining("public HTTPS"),
      }),
    ]);

    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();

    const missingRuntimeInput = await runIntegrationConnectionLiveChecks(
      host,
      createIntegrationConnection("telegram", "channel", {
        defaultChatId: "12345",
      }),
      { includeSandboxSend: true },
    );
    expect(missingRuntimeInput).toEqual({ checks: [] });
  });

  it("surfaces inbound access migration posture for generic webhook channels", () => {
    const host = createPort();

    const legacyChecks = buildIntegrationConnectionChecks(
      host,
      createIntegrationConnection("slack", "channel", {
        botToken: "slack-token",
        signingSecret: "slack-secret",
      }),
    );
    const emptyAllowlistChecks = buildIntegrationConnectionChecks(
      host,
      createIntegrationConnection("line", "channel", {
        channelAccessToken: "line-token",
        channelSecret: "line-secret",
        inboundAccessMode: "allowlist",
      }),
    );
    const configuredAllowlistChecks = buildIntegrationConnectionChecks(
      host,
      createIntegrationConnection("nextcloud-talk", "channel", {
        baseUrl: "https://cloud.example.test",
        token: "talk-token",
        defaultRoomId: "ops",
        inboundAccessMode: "allowlist",
        allowedSenders: ["operator"],
      }),
    );

    expect(legacyChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "inbound_access_legacy_open",
          status: "warn",
        }),
      ]),
    );

    // A connection the boot migration stamped (inboundAccessMigratedAt present)
    // gets the auto-migrated copy variant on the same warn check.
    const migratedChecks = buildIntegrationConnectionChecks(
      host,
      createIntegrationConnection("slack", "channel", {
        botToken: "slack-token",
        signingSecret: "slack-secret",
        inboundAccessMode: "open_legacy",
        inboundAccessMigratedAt: "2026-07-07T12:00:00.000Z",
      }),
    );
    expect(migratedChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "inbound_access_legacy_open",
          status: "warn",
          message: expect.stringContaining("auto-migrated from the legacy open default"),
        }),
      ]),
    );
    expect(emptyAllowlistChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "inbound_access_allowlist_empty",
          status: "warn",
        }),
      ]),
    );
    expect(configuredAllowlistChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "inbound_access",
          status: "pass",
        }),
      ]),
    );
  });

  it("reports forced allowlist, never legacy-open, for migrated open_legacy stream and Chat app inbound", () => {
    const host = createPort();
    const migrated = { inboundAccessMode: "open_legacy", inboundAccessMigratedAt: "2026-07-07T12:00:00.000Z" };
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "mattermost",
        {
          serverUrl: "https://chat.example.test",
          botTokenEnv: "MM_TOKEN",
          defaultChannel: "town-square",
          inboundStreamEnabled: true,
        },
      ],
      [
        "ntfy",
        { baseUrl: "https://ntfy.example.test", topic: "ops", tokenEnv: "NTFY_TOKEN", inboundStreamEnabled: true },
      ],
      [
        "google-chat",
        { serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY", audienceType: "project_number", audience: "123456789012" },
      ],
    ];
    for (const [key, config] of cases) {
      const empty = buildIntegrationConnectionChecks(
        host,
        createIntegrationConnection(key, "channel", { ...config, ...migrated }),
      );
      expect(
        empty.map((check) => check.key),
        key,
      ).not.toContain("inbound_access_legacy_open");
      expect(empty, key).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "inbound_access_allowlist_empty",
            status: "warn",
            message: expect.stringContaining("all inbound is dropped"),
          }),
        ]),
      );
      const allowed = buildIntegrationConnectionChecks(
        host,
        createIntegrationConnection(key, "channel", { ...config, ...migrated, allowedSenders: ["operator"] }),
      );
      expect(allowed, key).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "inbound_access",
            status: "pass",
            message: expect.stringContaining("allowlist-only"),
          }),
        ]),
      );
    }
  });

  it.each([
    [
      "Zalo Personal",
      "zalouser",
      { baseUrl: "https://zca.example.test", authToken: "token-1", defaultTarget: "group:thread-1" },
    ],
    [
      "Signal",
      "signal",
      {
        baseUrl: "http://127.0.0.1:8080",
        defaultRecipient: "+15551234567",
        receiveEvents: true,
        inboundAccessMode: "allowlist",
        allowedSenders: ["operator"],
      },
    ],
    [
      "iMessage",
      "imessage",
      {
        bridgeProvider: "bluebubbles",
        bridgeUrl: "http://127.0.0.1:1234",
        password: "bridge-password",
        defaultHandle: "imessage:+15551234567",
      },
    ],
  ] as const)("reports a saved %s connection as retired and runs no live probe for it", async (label, key, config) => {
    const host = createPort();
    const connection = createIntegrationConnection(key, "channel", config);

    expect(buildIntegrationConnectionChecks(host, connection)).toEqual([
      {
        key: "retired",
        status: "fail",
        message: expect.stringMatching(new RegExp(`^${label} is not supported anymore`)),
      },
    ]);
    const live = await runIntegrationConnectionLiveChecks(host, connection, { includeSandboxSend: true });
    expect(live).toEqual({ checks: [] });
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("warns when '*' is present in connection-level allowlist or global networkAllowlist", () => {
    const host = createPort();
    // 1. Global allowlist check
    host.config.toolPolicy.sandbox.networkAllowlist = ["*", "example.com"];
    const connectionNormal = createIntegrationConnection("google-chat", "channel", {
      webhookUrl: "https://hooks.example.test/google",
    });
    const checksNormal = buildIntegrationConnectionChecks(host, connectionNormal);
    const globalWarn = checksNormal.find((item) => item.key === "global_allowlist_wildcard");
    expect(globalWarn).toMatchObject({
      status: "warn",
      message: expect.stringContaining("Global network allowlist contains '*'"),
    });

    // 2. Connection-level allowlist check
    host.config.toolPolicy.sandbox.networkAllowlist = ["example.com"];
    const connectionWildcard = createIntegrationConnection("google-chat", "channel", {
      webhookUrl: "https://hooks.example.test/google",
      urlAllowlist: ["*", "another.com"],
    });
    const checksWildcard = buildIntegrationConnectionChecks(host, connectionWildcard);
    const connectionWarn = checksWildcard.find((item) => item.key === "allowlist_wildcard_urlAllowlist");
    expect(connectionWarn).toMatchObject({
      status: "warn",
      message: expect.stringContaining("Connection-level urlAllowlist contains a wildcard"),
    });
  });
});
