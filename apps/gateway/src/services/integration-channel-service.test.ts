import { describe, expect, it, vi } from "vitest";
import { evaluateChannelInboundAccess, type IntegrationConnection } from "@goatcitadel/contracts";
import {
  createIntegrationConnection,
  getIntegrationConnectionChannelRuntimeStatus,
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
    isFeatureEnabled: vi.fn(() => true),
    buildIntegrationConnectionChecks: vi.fn(() => []),
    runIntegrationConnectionLiveChecks: vi.fn(async () => ({ checks: [] })),
    pickConnectorDiagnosticAction: vi.fn(),
    recordConnectorHealthRun: vi.fn(),
    syncDiscordRuntime: vi.fn(async () => undefined),
    syncSignalInboundRuntime: vi.fn(),
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

  it("defaults new Telegram and Discord connections to allowlist (deny unknown senders)", () => {
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

    expect(telegram.config.inboundAccessMode).toBe("allowlist");
    expect(discord.config.inboundAccessMode).toBe("allowlist");

    // Default-safe: an unknown sender is denied until explicitly allowlisted.
    expect(evaluateChannelInboundAccess({ config: telegram.config, actorId: "tg-stranger" })).toMatchObject({
      allowed: false,
      mode: "allowlist",
      reason: "allowlist_empty",
    });
    expect(evaluateChannelInboundAccess({ config: discord.config, actorId: "dc-stranger" })).toMatchObject({
      allowed: false,
      mode: "allowlist",
      reason: "allowlist_empty",
    });
  });

  it("keeps outbound-only and local channels open (tui, ntfy do not get an allowlist)", () => {
    const deps = createDeps();

    const tui = createIntegrationConnection(deps, {
      catalogId: "channel.tui",
      label: "Terminal",
      config: {},
    });
    const ntfy = createIntegrationConnection(deps, {
      catalogId: "channel.ntfy",
      label: "ntfy",
      config: {
        baseUrl: "https://ntfy.sh",
        topic: "goatcitadel-ops",
      },
    });

    expect(tui.config.inboundAccessMode).toBeUndefined();
    expect(ntfy.config.inboundAccessMode).toBeUndefined();
  });

  it("lets an operator pick an explicit open ('allow all') posture for an inbound channel", () => {
    const deps = createDeps();

    const discord = createIntegrationConnection(deps, {
      catalogId: "channel.discord",
      label: "Discord",
      config: {
        runtimeMode: "gateway",
        botTokenEnv: "DISCORD_BOT_TOKEN",
        inboundAccessMode: "open_legacy",
      },
    });

    expect(discord.config.inboundAccessMode).toBe("open_legacy");
    expect(evaluateChannelInboundAccess({ config: discord.config, actorId: "anyone" })).toMatchObject({
      allowed: true,
      mode: "open_legacy",
      reason: "legacy_open_explicit",
    });
  });

  it("does not retroactively lock out a legacy connection persisted without a mode", () => {
    const deps = createDeps();

    // Simulate a pre-existing connection that predates default-safe inbound
    // access: no inboundAccessMode was ever stamped on it.
    const legacy = deps.storage.integrationConnections.create({
      catalogId: "channel.slack",
      kind: "channel",
      key: "slack",
      label: "Legacy Slack",
      config: { botTokenEnv: "SLACK_BOT_TOKEN" },
    });
    expect(legacy.config.inboundAccessMode).toBeUndefined();

    // Replacing its config (without choosing a mode) must NOT silently flip it
    // to a denying allowlist — it stays legacy-open with a migration warning.
    const updated = updateIntegrationConnection(deps, legacy.connectionId, {
      config: { botTokenEnv: "SLACK_BOT_TOKEN_V2" },
    });
    expect(updated.config.inboundAccessMode).toBeUndefined();
    expect(evaluateChannelInboundAccess({ config: updated.config, actorId: "anyone" })).toMatchObject({
      allowed: true,
      mode: "open_legacy",
      reason: "legacy_open_unset",
    });
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

describe("integration-channel-service runtime status", () => {
  it("marks configured Signal inbound polling unready when the feature flag is disabled", () => {
    const deps = createDeps();
    deps.isFeatureEnabled = vi.fn((flag) => flag !== "signalInboundV1Enabled");
    const connection = createIntegrationConnection(deps, {
      catalogId: "channel.signal",
      label: "Signal",
      config: {
        baseUrl: "http://127.0.0.1:8080",
        accountId: "+15550001111",
        inboundEnabled: true,
      },
    });
    updateIntegrationConnection(deps, connection.connectionId, {
      status: "connected",
      lastSyncAt: "2026-07-05T12:00:00.000Z",
    });

    const status = getIntegrationConnectionChannelRuntimeStatus(deps, connection.connectionId);

    expect(status.ready).toBe(false);
    expect(status.runtimePosture.inboundReadiness).toBe("unsupported");
    expect(status.metadata).toMatchObject({
      readinessSource: "feature_flag",
      featureFlag: "signalInboundV1Enabled",
      featureEnabled: false,
    });
    expect(status.metadata.setupDiagnostics).toEqual(
      expect.arrayContaining([
        "Signal inbound polling is configured on this connection, but signalInboundV1Enabled is disabled.",
      ]),
    );
  });
});
