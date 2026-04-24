import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";

const runDiscordBotLiveChecksMock = vi.hoisted(() => vi.fn());

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
  runZaloUserBridgeLiveChecks: vi.fn(),
}));

import {
  buildIntegrationConnectionChecks,
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
});
