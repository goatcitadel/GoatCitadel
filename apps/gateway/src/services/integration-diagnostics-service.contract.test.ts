import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";

const runDiscordBotLiveChecksMock = vi.hoisted(() => vi.fn());
const runZaloUserBridgeLiveChecksMock = vi.hoisted(() => vi.fn());

vi.mock("./channel-bot-live-probes.js", () => ({
  runDiscordBotLiveChecks: runDiscordBotLiveChecksMock,
  runIMessageBridgeLiveChecks: vi.fn(),
  runLineBotLiveChecks: vi.fn(),
  runMattermostBotLiveChecks: vi.fn(),
  runSignalBridgeLiveChecks: vi.fn(),
  runSlackBotLiveChecks: vi.fn(),
  runTelegramBotLiveChecks: vi.fn(),
  runWhatsAppCloudLiveChecks: vi.fn(),
  runZaloBotLiveChecks: vi.fn(),
  runZaloUserBridgeLiveChecks: runZaloUserBridgeLiveChecksMock,
}));

import {
  buildIntegrationConnectionChecks,
  IntegrationDiagnosticsService,
  runIntegrationConnectionLiveChecks,
  type IntegrationDiagnosticsPort,
} from "./integration-diagnostics-service.js";

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
    resolveConnectionSecret: vi.fn((config: Record<string, unknown>, key: string) => {
      const value = config[key];
      return typeof value === "string" ? value : undefined;
    }),
  };
}

describe("integration-diagnostics-service contract behavior", () => {
  beforeEach(() => {
    runDiscordBotLiveChecksMock.mockReset();
    runZaloUserBridgeLiveChecksMock.mockReset();
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
        runtimeMode: "gateway",
        webhookUrl: "https://discord.example.test/webhook",
        includeSandboxSend: true,
        fetcher: expect.any(Function),
      }),
    );
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

  it("treats gmail connections as operator-ready when token handles and oauth env references exist", () => {
    const host = createPort();
    host.readConnectionConfigValue = vi.fn((config: Record<string, unknown>, key: string) => {
      const value = config[key];
      return typeof value === "string" ? value : undefined;
    });
    const originalEnv = process.env.GMAIL_CLIENT_ID;
    const originalSecret = process.env.GMAIL_CLIENT_SECRET;
    process.env.GMAIL_CLIENT_ID = "client-id";
    process.env.GMAIL_CLIENT_SECRET = "client-secret";
    try {
      const connection = createIntegrationConnection("gmail", "automation", {
        refreshTokenHandle: "gmail-primary",
        clientIdEnv: "GMAIL_CLIENT_ID",
        clientSecretEnv: "GMAIL_CLIENT_SECRET",
      });

      const checks = buildIntegrationConnectionChecks(host, connection);

      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "auth",
            status: "pass",
          }),
          expect.objectContaining({
            key: "auth_mode",
            status: "pass",
          }),
        ]),
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GMAIL_CLIENT_ID;
      } else {
        process.env.GMAIL_CLIENT_ID = originalEnv;
      }
      if (originalSecret === undefined) {
        delete process.env.GMAIL_CLIENT_SECRET;
      } else {
        process.env.GMAIL_CLIENT_SECRET = originalSecret;
      }
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
      GIF_API_KEY: process.env.GIF_API_KEY,
    };
    process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
    process.env.MATTERMOST_TOKEN = "mattermost-token";
    process.env.TRELLO_KEY = "trello-key";
    process.env.TRELLO_TOKEN = "trello-token";
    process.env.GIF_API_KEY = "gif-key";
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
        createIntegrationConnection("imessage", "channel", {
          bridgeUrl: "http://127.0.0.1:1234",
          password: "bridge-password",
          defaultHandle: "+15551234567",
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
        createIntegrationConnection("zalouser", "channel", {
          baseUrl: "http://127.0.0.1:9876",
          defaultTarget: "group:ops",
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
      expect(
        buildIntegrationConnectionChecks(
          host,
          createIntegrationConnection("signal", "channel", {
            baseUrl: "http://127.0.0.1:8190",
            defaultRecipient: "+15551234567",
          }),
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "url", status: "warn" }),
          expect.objectContaining({ key: "target", status: "pass" }),
        ]),
      );

      const automation = [
        createIntegrationConnection("webhooks", "automation", {
          baseUrl: "https://hooks.example.test/inbound",
        }),
        createIntegrationConnection("gif-search", "automation", {
          provider: "giphy",
          apiKeyEnv: "GIF_API_KEY",
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
        webhookUrl: "https://hooks.slack.test/services/T/B/C",
      }),
      { includeSandboxSend: false },
    );
    expect(slackWebhookOnly.checks).toEqual([
      expect.objectContaining({
        key: "auth_live",
        status: "warn",
        message: expect.stringContaining("Webhook-mode Slack connections cannot be probed"),
      }),
    ]);

    const missingRuntimeInput = await runIntegrationConnectionLiveChecks(
      host,
      createIntegrationConnection("telegram", "channel", {
        defaultChatId: "12345",
      }),
      { includeSandboxSend: true },
    );
    expect(missingRuntimeInput).toEqual({ checks: [] });
  });

  it("resolves Zalo User bridge authorization from explicit, bearer, and basic config sources", async () => {
    const host = createPort();
    const connection = createIntegrationConnection("zalouser", "channel", {
      baseUrl: "https://zca.example.test",
      defaultTarget: "group:thread-1",
      basicAuth: "operator:secret",
      profile: "ops",
    });
    runZaloUserBridgeLiveChecksMock.mockResolvedValue({
      checks: [{ key: "zalouser_sandbox_send", status: "pass", message: "sent" }],
      probe: { canSend: true },
    });

    const result = await runIntegrationConnectionLiveChecks(host, connection, { includeSandboxSend: true });

    expect(result.checks).toEqual([{ key: "zalouser_sandbox_send", status: "pass", message: "sent" }]);
    expect(runZaloUserBridgeLiveChecksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://zca.example.test",
        defaultTarget: "group:thread-1",
        profile: "ops",
        includeSandboxSend: true,
        authorizationHeader: `Basic ${Buffer.from("operator:secret", "utf8").toString("base64")}`,
      }),
    );

    runZaloUserBridgeLiveChecksMock.mockClear();
    await runIntegrationConnectionLiveChecks(
      host,
      createIntegrationConnection("zalouser", "channel", {
        baseUrl: "https://zca.example.test",
        authorization: "Bearer explicit",
      }),
      { includeSandboxSend: false },
    );
    expect(runZaloUserBridgeLiveChecksMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ authorizationHeader: "Bearer explicit" }),
    );

    runZaloUserBridgeLiveChecksMock.mockClear();
    await runIntegrationConnectionLiveChecks(
      host,
      createIntegrationConnection("zalouser", "channel", {
        baseUrl: "https://zca.example.test",
        authToken: "token-1",
      }),
      { includeSandboxSend: false },
    );
    expect(runZaloUserBridgeLiveChecksMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ authorizationHeader: "Bearer token-1" }),
    );
  });
});
