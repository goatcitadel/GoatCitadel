import { randomUUID } from "node:crypto";
import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import type {
  ChannelCapabilities,
  ChannelRuntimeStatus,
  ChannelTypingInput,
  ChannelTypingResult,
  ConnectorDiagnosticReport,
  DiscordPairingRecord,
  DiscordRuntimeStatus,
  IntegrationConnection,
  IntegrationConnectionCreateInput,
  IntegrationConnectionUpdateInput,
  IntegrationKind,
  IntegrationPluginInstallInput,
  IntegrationPluginRecord,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway-service.js";
import { INTEGRATION_CATALOG } from "./integration-catalog.js";
import {
  buildInstalledIntegrationPluginRecord,
  resolveIntegrationPluginInstallMetadata,
} from "./integration-plugin-author-contract.js";
import { sendTelegramTypingIndicator } from "./telegram-typing.js";

export interface IntegrationChannelHost {
  storage: {
    integrationConnections: {
      list(kind?: IntegrationKind, limit?: number): IntegrationConnection[];
      get(connectionId: string): IntegrationConnection;
      create(
        input: IntegrationConnectionCreateInput & {
          catalogId: string;
          kind: IntegrationKind;
          key: string;
          label: string;
          pluginId?: string;
        },
      ): IntegrationConnection;
      update(connectionId: string, input: IntegrationConnectionUpdateInput): IntegrationConnection;
      delete(connectionId: string): boolean;
    };
  };
  publishRealtime(scope: string, channel: string, payload: Record<string, unknown>): void;
  requireFeatureEnabled(flag: keyof RuntimeSettings["features"]): void;
  buildIntegrationConnectionChecks(connection: IntegrationConnection): ConnectorDiagnosticReport["checks"];
  runIntegrationConnectionLiveChecks(
    connection: IntegrationConnection,
    options: { includeSandboxSend: boolean },
  ): Promise<{ checks: ConnectorDiagnosticReport["checks"]; probe?: ConnectorDiagnosticReport["probe"] }>;
  pickConnectorDiagnosticAction(checks: ConnectorDiagnosticReport["checks"]): string | undefined;
  recordConnectorHealthRun(report: ConnectorDiagnosticReport): void;
  syncDiscordRuntime(): Promise<void>;
  getDiscordRuntimeStatus(connectionId: string): DiscordRuntimeStatus | undefined;
  getIntegrationConnection(connectionId: string): IntegrationConnection;
  assertDiscordConnection(connection: IntegrationConnection): void;
  readDiscordPairings(): DiscordPairingRecord[];
  writeDiscordPairings(records: DiscordPairingRecord[]): void;
  discordRuntimeService: {
    reconnectConnection(connectionId: string): Promise<DiscordRuntimeStatus | undefined>;
    sendTyping(connectionId: string, target: string, durationMs?: number, signal?: AbortSignal): Promise<ChannelTypingResult>;
  };
  resolveConnectionSecret(config: Record<string, unknown>, directKey: string, envKey: string): string | undefined;
  readConnectionConfigValue(config: Record<string, unknown>, key: string): string | undefined;
  isConnectionUrlAllowlisted(urlValue: string): boolean;
  fetchWithDiagnosticsTimeout(url: string, init?: RequestInit): Promise<Response>;
  readIntegrationPlugins(): IntegrationPluginRecord[];
  writeIntegrationPlugins(plugins: IntegrationPluginRecord[]): void;
}

function sanitizePluginId(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!sanitized) {
    return `plugin-${randomUUID().slice(0, 8)}`;
  }
  return sanitized.slice(0, 80);
}

export function listIntegrationConnections(
  host: IntegrationChannelHost,
  kind?: IntegrationKind,
  limit = 300,
): IntegrationConnection[] {
  return host.storage.integrationConnections.list(kind, limit);
}

export function getIntegrationConnection(host: IntegrationChannelHost, connectionId: string): IntegrationConnection {
  return host.storage.integrationConnections.get(connectionId);
}

export function getIntegrationConnectionChannelCapabilities(
  host: IntegrationChannelHost,
  connectionId: string,
): ChannelCapabilities {
  const connection = host.storage.integrationConnections.get(connectionId);
  if (!connection) {
    throw new Error(`Unknown integration connection: ${connectionId}`);
  }
  if (connection.kind !== "channel") {
    throw new Error(`Integration connection ${connectionId} is not a channel connection.`);
  }
  return describeChannelCapabilities(connection.key, connection.config);
}

export function getIntegrationConnectionChannelRuntimeStatus(
  host: IntegrationChannelHost,
  connectionId: string,
): ChannelRuntimeStatus {
  const connection = host.storage.integrationConnections.get(connectionId);
  if (!connection) {
    throw new Error(`Unknown integration connection: ${connectionId}`);
  }
  if (connection.kind !== "channel") {
    throw new Error(`Integration connection ${connectionId} is not a channel connection.`);
  }
  const capabilities = describeChannelCapabilities(connection.key, connection.config);
  const baseReady =
    connection.enabled &&
    connection.status === "connected" &&
    capabilities.setupReady &&
    Boolean(connection.lastSyncAt) &&
    !connection.lastError;
  const runtimeStatus: ChannelRuntimeStatus = {
    connectionId: connection.connectionId,
    channelKey: connection.key,
    enabled: connection.enabled,
    ready: Boolean(baseReady),
    inboundModes: capabilities.inboundModes,
    runtimePolicy: capabilities.runtimePolicy,
    runtimePosture: capabilities.runtimePosture,
    lastReadyAt: baseReady ? (connection.lastSyncAt ?? connection.updatedAt) : undefined,
    lastError: connection.lastError,
    metadata: {
      setupReady: capabilities.setupReady,
      setupDiagnostics: capabilities.setupDiagnostics,
      supportNotes: capabilities.supportNotes,
      connectionStatus: connection.status,
      readinessSource: connection.key === "discord" ? "live_runtime" : "last_live_probe",
      authoritative: connection.key === "discord" || Boolean(connection.lastSyncAt),
    },
  };

  if (connection.key !== "discord") {
    return runtimeStatus;
  }

  const discordRuntime = host.getDiscordRuntimeStatus(connectionId);
  if (!discordRuntime) {
    return runtimeStatus;
  }

  return {
    ...runtimeStatus,
    ready: discordRuntime.ready,
    lastReadyAt: discordRuntime.lastReadyAt ?? runtimeStatus.lastReadyAt,
    lastInboundAt: discordRuntime.lastInboundAt,
    lastReconnectAt: discordRuntime.lastReconnectAt,
    lastError: discordRuntime.lastError ?? runtimeStatus.lastError,
    metadata: {
      ...runtimeStatus.metadata,
      connectedBotId: discordRuntime.connectedBotId,
      connectedBotTag: discordRuntime.connectedBotTag,
      guildIds: discordRuntime.guildIds,
      runtimeMode: discordRuntime.runtimeMode,
    },
  };
}

export async function runIntegrationConnectionDiagnostics(
  host: IntegrationChannelHost,
  connectionId: string,
): Promise<ConnectorDiagnosticReport> {
  host.requireFeatureEnabled("connectorDiagnosticsV1Enabled");
  const connection = host.storage.integrationConnections.get(connectionId);
  if (!connection) {
    throw new Error(`Unknown integration connection: ${connectionId}`);
  }
  const checks: ConnectorDiagnosticReport["checks"] = [];
  checks.push({
    key: "enabled",
    status: connection.enabled ? "pass" : "warn",
    message: connection.enabled ? "Connection is enabled." : "Connection is disabled.",
  });
  checks.push({
    key: "status",
    status: connection.status === "connected" ? "pass" : connection.status === "paused" ? "warn" : "fail",
    message: `Connection status is ${connection.status}.`,
  });
  checks.push({
    key: "last_error",
    status: connection.lastError ? "warn" : "pass",
    message: connection.lastError ? `Last error: ${connection.lastError}` : "No recent errors recorded.",
  });
  checks.push(...host.buildIntegrationConnectionChecks(connection));
  const liveChecks = await host.runIntegrationConnectionLiveChecks(connection, { includeSandboxSend: false });
  checks.push(...liveChecks.checks);
  const report: ConnectorDiagnosticReport = {
    connectorType: "integration_connection",
    connectorId: connection.connectionId,
    status: checks.some((check) => check.status === "fail")
      ? "error"
      : checks.some((check) => check.status === "warn")
        ? "warn"
        : "ok",
    checks,
    recommendedNextAction: host.pickConnectorDiagnosticAction(checks),
    checkedAt: new Date().toISOString(),
    probe: liveChecks.probe,
  };
  host.recordConnectorHealthRun(report);
  return report;
}

export function createIntegrationConnection(
  host: IntegrationChannelHost,
  input: IntegrationConnectionCreateInput,
): IntegrationConnection {
  const catalog = INTEGRATION_CATALOG.find((entry) => entry.catalogId === input.catalogId);
  if (!catalog) {
    throw new Error(`Unknown integration catalog id: ${input.catalogId}`);
  }

  const created = host.storage.integrationConnections.create({
    ...input,
    catalogId: catalog.catalogId,
    kind: catalog.kind,
    key: catalog.key,
    label: input.label?.trim() || catalog.label,
    pluginId: input.pluginId ?? catalog.pluginId,
  });

  host.publishRealtime("system", "integrations", {
    type: "integration_connection_created",
    connectionId: created.connectionId,
    catalogId: created.catalogId,
    kind: created.kind,
    key: created.key,
    enabled: created.enabled,
    status: created.status,
  });
  void host.syncDiscordRuntime();

  return created;
}

export function updateIntegrationConnection(
  host: IntegrationChannelHost,
  connectionId: string,
  input: IntegrationConnectionUpdateInput,
): IntegrationConnection {
  const updated = host.storage.integrationConnections.update(connectionId, input);
  host.publishRealtime("system", "integrations", {
    type: "integration_connection_updated",
    connectionId: updated.connectionId,
    enabled: updated.enabled,
    status: updated.status,
    lastError: updated.lastError,
  });
  void host.syncDiscordRuntime();
  return updated;
}

export function deleteIntegrationConnection(host: IntegrationChannelHost, connectionId: string): boolean {
  const deleted = host.storage.integrationConnections.delete(connectionId);
  if (deleted) {
    host.publishRealtime("system", "integrations", {
      type: "integration_connection_deleted",
      connectionId,
    });
  }
  void host.syncDiscordRuntime();
  return deleted;
}

export function listDiscordPairings(
  host: IntegrationChannelHost,
  connectionId: string,
): { runtime?: DiscordRuntimeStatus; items: DiscordPairingRecord[] } {
  const connection = host.getIntegrationConnection(connectionId);
  host.assertDiscordConnection(connection);
  return {
    runtime: host.getDiscordRuntimeStatus(connectionId),
    items: host
      .readDiscordPairings()
      .filter((item) => item.connectionId === connectionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  };
}

export function approveDiscordPairing(
  host: IntegrationChannelHost,
  connectionId: string,
  pairingId: string,
): DiscordPairingRecord {
  const connection = host.getIntegrationConnection(connectionId);
  host.assertDiscordConnection(connection);
  const pairings = host.readDiscordPairings();
  const existing = pairings.find((item) => item.connectionId === connectionId && item.pairingId === pairingId);
  if (!existing) {
    throw new Error(`Unknown Discord pairing: ${pairingId}`);
  }
  const now = new Date().toISOString();
  const next = pairings.map((item) => {
    if (item.connectionId !== connectionId) {
      return item;
    }
    if (item.pairingId === pairingId) {
      return {
        ...item,
        status: "approved" as const,
        approvedAt: now,
        revokedAt: undefined,
        updatedAt: now,
      };
    }
    if (item.userId === existing.userId && item.status === "approved") {
      return {
        ...item,
        status: "revoked" as const,
        revokedAt: now,
        updatedAt: now,
      };
    }
    return item;
  });
  host.writeDiscordPairings(next);
  return next.find((item) => item.pairingId === pairingId)!;
}

export function revokeDiscordPairing(
  host: IntegrationChannelHost,
  connectionId: string,
  pairingId: string,
): DiscordPairingRecord {
  const connection = host.getIntegrationConnection(connectionId);
  host.assertDiscordConnection(connection);
  const pairings = host.readDiscordPairings();
  const existing = pairings.find((item) => item.connectionId === connectionId && item.pairingId === pairingId);
  if (!existing) {
    throw new Error(`Unknown Discord pairing: ${pairingId}`);
  }
  const now = new Date().toISOString();
  const revoked: DiscordPairingRecord = {
    ...existing,
    status: "revoked",
    revokedAt: now,
    updatedAt: now,
  };
  host.writeDiscordPairings(pairings.map((item) => (item.pairingId === pairingId ? revoked : item)));
  return revoked;
}

export async function reconnectDiscordRuntime(
  host: IntegrationChannelHost,
  connectionId: string,
): Promise<DiscordRuntimeStatus | undefined> {
  const connection = host.getIntegrationConnection(connectionId);
  host.assertDiscordConnection(connection);
  return host.discordRuntimeService.reconnectConnection(connectionId);
}

export async function emitTelegramTypingImpl(
  host: IntegrationChannelHost,
  connection: IntegrationConnection,
  input: ChannelTypingInput,
): Promise<ChannelTypingResult> {
  const token =
    host.resolveConnectionSecret(connection.config, "botToken", "botTokenEnv") ??
    host.resolveConnectionSecret(connection.config, "token", "tokenEnv");
  const chatId = input.target.trim() || host.readConnectionConfigValue(connection.config, "defaultChatId");
  if (!token) {
    return {
      channelKey: "telegram",
      connectionId: connection.connectionId,
      target: input.target,
      supported: false,
      status: "unsupported",
      reason: `${connection.label} is missing a Telegram bot token.`,
    };
  }
  if (!chatId) {
    return {
      channelKey: "telegram",
      connectionId: connection.connectionId,
      target: input.target,
      supported: false,
      status: "unsupported",
      reason: `${connection.label} is missing a Telegram chat target.`,
    };
  }
  const telegramApiUrl = `https://api.telegram.org/bot${token}/sendChatAction`;
  if (!host.isConnectionUrlAllowlisted(telegramApiUrl)) {
    return {
      channelKey: "telegram",
      connectionId: connection.connectionId,
      target: input.target,
      supported: false,
      status: "unsupported",
      reason: "Telegram API host is not in the current outbound allowlist.",
    };
  }
  try {
    return await sendTelegramTypingIndicator({
      connectionId: connection.connectionId,
      target: input.target,
      token,
      chatId,
      threadId: input.threadId,
      durationMs: input.durationMs,
      signal: input.signal,
      fetcher: (url, init) => host.fetchWithDiagnosticsTimeout(url, init),
    });
  } catch (error) {
    return {
      channelKey: "telegram",
      connectionId: connection.connectionId,
      target: input.target,
      supported: false,
      status: "unsupported",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function listIntegrationPlugins(host: IntegrationChannelHost): IntegrationPluginRecord[] {
  return host.readIntegrationPlugins();
}

export function installIntegrationPlugin(
  host: IntegrationChannelHost,
  input: IntegrationPluginInstallInput,
): IntegrationPluginRecord {
  const now = new Date().toISOString();
  const plugins = host.readIntegrationPlugins();
  const installMetadata = resolveIntegrationPluginInstallMetadata(input.source);
  const nextId = sanitizePluginId(input.pluginId ?? installMetadata.manifest?.pluginId ?? input.source);
  const existing = plugins.find((item) => item.pluginId === nextId);
  if (existing) {
    const updated = buildInstalledIntegrationPluginRecord({
      now,
      pluginId: nextId,
      source: input.source,
      existing,
    });
    host.writeIntegrationPlugins(plugins.map((item) => (item.pluginId === nextId ? updated : item)));
    return updated;
  }

  const created = buildInstalledIntegrationPluginRecord({
    now,
    pluginId: nextId,
    source: input.source,
  });
  host.writeIntegrationPlugins([created, ...plugins]);
  host.publishRealtime("system", "integrations", {
    type: "integration_plugin_installed",
    pluginId: created.pluginId,
    source: input.source,
  });
  return created;
}

export function setIntegrationPluginEnabled(
  host: IntegrationChannelHost,
  pluginId: string,
  enabled: boolean,
): IntegrationPluginRecord {
  const now = new Date().toISOString();
  const plugins = host.readIntegrationPlugins();
  const current = plugins.find((item) => item.pluginId === pluginId);
  if (!current) {
    throw new Error(`Unknown integration plugin: ${pluginId}`);
  }
  const updated: IntegrationPluginRecord = {
    ...current,
    enabled,
    updatedAt: now,
  };
  host.writeIntegrationPlugins(plugins.map((item) => (item.pluginId === pluginId ? updated : item)));
  host.publishRealtime("system", "integrations", {
    type: enabled ? "integration_plugin_enabled" : "integration_plugin_disabled",
    pluginId,
  });
  return updated;
}
