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
  type IntegrationDiagnosticsHost,
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

function createHost(): IntegrationDiagnosticsHost {
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
    } as unknown as IntegrationDiagnosticsHost["config"],
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
    const host = createHost();
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
    const host = createHost();
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
});
