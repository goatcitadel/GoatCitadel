import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import {
  createIntegrationConnection,
  updateIntegrationConnection,
  type IntegrationChannelPort,
} from "./integration-channel-service.js";

function createDeps(): IntegrationChannelPort {
  const connections = new Map<string, IntegrationConnection>();
  let sequence = 0;
  return {
    storage: {
      integrationConnections: {
        list: vi.fn(() => [...connections.values()]),
        get: vi.fn((connectionId: string) => {
          const connection = connections.get(connectionId);
          if (!connection) {
            throw new Error(`Unknown integration connection: ${connectionId}`);
          }
          return connection;
        }),
        create: vi.fn((input) => {
          const now = "2026-06-18T00:00:00.000Z";
          const connection: IntegrationConnection = {
            connectionId: `11111111-1111-1111-1111-${String(++sequence).padStart(12, "0")}`,
            catalogId: input.catalogId,
            kind: input.kind,
            key: input.key,
            label: input.label,
            enabled: input.enabled ?? true,
            status: input.status ?? "connected",
            config: input.config ?? {},
            pluginId: input.pluginId,
            createdAt: now,
            updatedAt: now,
          };
          connections.set(connection.connectionId, connection);
          return connection;
        }),
        update: vi.fn((connectionId: string, input) => {
          const current = connections.get(connectionId);
          if (!current) {
            throw new Error(`Unknown integration connection: ${connectionId}`);
          }
          const updated: IntegrationConnection = {
            ...current,
            ...input,
            config: input.config ?? current.config,
            updatedAt: "2026-06-18T00:00:01.000Z",
          };
          connections.set(connectionId, updated);
          return updated;
        }),
        delete: vi.fn((connectionId: string) => connections.delete(connectionId)),
      },
    },
    publishRealtime: vi.fn(),
    requireFeatureEnabled: vi.fn(),
    buildIntegrationConnectionChecks: vi.fn(() => []),
    runIntegrationConnectionLiveChecks: vi.fn(async () => ({ checks: [] })),
    pickConnectorDiagnosticAction: vi.fn(),
    recordConnectorHealthRun: vi.fn(),
    syncDiscordRuntime: vi.fn(async () => undefined),
    getDiscordRuntimeStatus: vi.fn(),
    getIntegrationConnection: (connectionId: string) =>
      connections.get(connectionId) ??
      (() => {
        throw new Error(`Unknown integration connection: ${connectionId}`);
      })(),
    assertDiscordConnection: vi.fn(),
    readDiscordPairings: vi.fn(() => []),
    writeDiscordPairings: vi.fn(),
    discordRuntimeService: {
      reconnectConnection: vi.fn(async () => undefined),
      sendTyping: vi.fn(async () => ({
        channelKey: "discord",
        connectionId: "connection-1",
        target: "target",
        supported: false,
        status: "unsupported",
        reason: "test",
      })),
    },
    resolveConnectionSecret: vi.fn(),
    readConnectionConfigValue: vi.fn((config: Record<string, unknown>, key: string) => {
      const value = config[key];
      return typeof value === "string" ? value : undefined;
    }),
    isConnectionUrlAllowlisted: vi.fn(() => true),
    fetchWithDiagnosticsTimeout: vi.fn(async () => new Response("{}")),
    readIntegrationPlugins: vi.fn(() => []),
    writeIntegrationPlugins: vi.fn(),
  };
}

describe("integration-channel-service inbound access defaults", () => {
  it("defaults new generic webhook channel connections to allowlist mode", () => {
    const deps = createDeps();

    const connection = createIntegrationConnection(deps, {
      catalogId: "channel.slack",
      label: "Slack",
      config: {
        botTokenEnv: "SLACK_BOT_TOKEN",
        signingSecretEnv: "SLACK_SIGNING_SECRET",
      },
    });

    expect(connection.config).toMatchObject({
      botTokenEnv: "SLACK_BOT_TOKEN",
      signingSecretEnv: "SLACK_SIGNING_SECRET",
      inboundAccessMode: "allowlist",
    });
  });

  it("preserves explicit legacy-open mode when an operator chooses it", () => {
    const deps = createDeps();

    const connection = createIntegrationConnection(deps, {
      catalogId: "channel.line",
      label: "LINE",
      config: {
        channelSecretEnv: "LINE_CHANNEL_SECRET",
        inboundAccessMode: "open_legacy",
      },
    });

    expect(connection.config.inboundAccessMode).toBe("open_legacy");
  });

  it("does not add the generic allowlist mode to channels with stronger pairing posture", () => {
    const deps = createDeps();

    const telegram = createIntegrationConnection(deps, {
      catalogId: "channel.telegram",
      label: "Telegram",
      config: {
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET",
      },
    });
    const discord = createIntegrationConnection(deps, {
      catalogId: "channel.discord",
      label: "Discord",
      config: {
        runtimeMode: "gateway",
        botTokenEnv: "DISCORD_BOT_TOKEN",
      },
    });

    expect(telegram.config.inboundAccessMode).toBeUndefined();
    expect(discord.config.inboundAccessMode).toBeUndefined();
  });

  it("preserves an existing inbound access mode when replacing connection config", () => {
    const deps = createDeps();
    const connection = createIntegrationConnection(deps, {
      catalogId: "channel.whatsapp",
      label: "WhatsApp",
      config: {
        accessTokenEnv: "WHATSAPP_TOKEN",
        inboundAccessMode: "open_legacy",
      },
    });

    const updated = updateIntegrationConnection(deps, connection.connectionId, {
      config: {
        accessTokenEnv: "WHATSAPP_TOKEN_V2",
      },
    });

    expect(updated.config).toEqual({
      accessTokenEnv: "WHATSAPP_TOKEN_V2",
      inboundAccessMode: "open_legacy",
    });
  });
});
