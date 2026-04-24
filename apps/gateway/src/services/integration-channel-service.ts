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
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { INTEGRATION_CATALOG } from "./integration-catalog.js";
import {
  buildInstalledIntegrationPluginRecord,
  resolveIntegrationPluginInstallMetadata,
} from "./integration-plugin-author-contract.js";
import { sendTelegramTypingIndicator } from "./telegram-typing.js";

export interface IntegrationChannelPort {
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
    sendTyping(
      connectionId: string,
      target: string,
      durationMs?: number,
      signal?: AbortSignal,
    ): Promise<ChannelTypingResult>;
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

export class IntegrationChannelService {
  public constructor(private readonly deps: IntegrationChannelPort) {}

  public listIntegrationConnections(kind?: IntegrationKind, limit = 300): IntegrationConnection[] {
    return listIntegrationConnections(this.deps, kind, limit);
  }

  public getIntegrationConnection(connectionId: string): IntegrationConnection {
    return getIntegrationConnection(this.deps, connectionId);
  }

  public getIntegrationConnectionChannelCapabilities(connectionId: string): ChannelCapabilities {
    return getIntegrationConnectionChannelCapabilities(this.deps, connectionId);
  }

  public getIntegrationConnectionChannelRuntimeStatus(connectionId: string): ChannelRuntimeStatus {
    return getIntegrationConnectionChannelRuntimeStatus(this.deps, connectionId);
  }

  public runIntegrationConnectionDiagnostics(connectionId: string): Promise<ConnectorDiagnosticReport> {
    return runIntegrationConnectionDiagnostics(this.deps, connectionId);
  }

  public createIntegrationConnection(input: IntegrationConnectionCreateInput): IntegrationConnection {
    return createIntegrationConnection(this.deps, input);
  }

  public updateIntegrationConnection(
    connectionId: string,
    input: IntegrationConnectionUpdateInput,
  ): IntegrationConnection {
    return updateIntegrationConnection(this.deps, connectionId, input);
  }

  public deleteIntegrationConnection(connectionId: string): boolean {
    return deleteIntegrationConnection(this.deps, connectionId);
  }

  public listDiscordPairings(connectionId: string): { runtime?: DiscordRuntimeStatus; items: DiscordPairingRecord[] } {
    return listDiscordPairings(this.deps, connectionId);
  }

  public approveDiscordPairing(connectionId: string, pairingId: string): DiscordPairingRecord {
    return approveDiscordPairing(this.deps, connectionId, pairingId);
  }

  public revokeDiscordPairing(connectionId: string, pairingId: string): DiscordPairingRecord {
    return revokeDiscordPairing(this.deps, connectionId, pairingId);
  }

  public reconnectDiscordRuntime(connectionId: string): Promise<DiscordRuntimeStatus | undefined> {
    return reconnectDiscordRuntime(this.deps, connectionId);
  }

  public emitTelegramTyping(
    connection: IntegrationConnection,
    input: ChannelTypingInput,
  ): Promise<ChannelTypingResult> {
    return emitTelegramTypingImpl(this.deps, connection, input);
  }

  public listIntegrationPlugins(): IntegrationPluginRecord[] {
    return listIntegrationPlugins(this.deps);
  }

  public installIntegrationPlugin(input: IntegrationPluginInstallInput): IntegrationPluginRecord {
    return installIntegrationPlugin(this.deps, input);
  }

  public setIntegrationPluginEnabled(pluginId: string, enabled: boolean): IntegrationPluginRecord {
    return setIntegrationPluginEnabled(this.deps, pluginId, enabled);
  }
}

export function listIntegrationConnections(
  deps: IntegrationChannelPort,
  kind?: IntegrationKind,
  limit = 300,
): IntegrationConnection[] {
  return deps.storage.integrationConnections.list(kind, limit);
}

export function getIntegrationConnection(deps: IntegrationChannelPort, connectionId: string): IntegrationConnection {
  return deps.storage.integrationConnections.get(connectionId);
}

export function getIntegrationConnectionChannelCapabilities(
  deps: IntegrationChannelPort,
  connectionId: string,
): ChannelCapabilities {
  const connection = deps.storage.integrationConnections.get(connectionId);
  if (!connection) {
    throw new Error(`Unknown integration connection: ${connectionId}`);
  }
  if (connection.kind !== "channel") {
    throw new Error(`Integration connection ${connectionId} is not a channel connection.`);
  }
  return describeChannelCapabilities(connection.key, connection.config);
}

export function getIntegrationConnectionChannelRuntimeStatus(
  deps: IntegrationChannelPort,
  connectionId: string,
): ChannelRuntimeStatus {
  const connection = deps.storage.integrationConnections.get(connectionId);
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

  const discordRuntime = deps.getDiscordRuntimeStatus(connectionId);
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
  deps: IntegrationChannelPort,
  connectionId: string,
): Promise<ConnectorDiagnosticReport> {
  deps.requireFeatureEnabled("connectorDiagnosticsV1Enabled");
  const connection = deps.storage.integrationConnections.get(connectionId);
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
  checks.push(...deps.buildIntegrationConnectionChecks(connection));
  const liveChecks = await deps.runIntegrationConnectionLiveChecks(connection, { includeSandboxSend: false });
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
    recommendedNextAction: deps.pickConnectorDiagnosticAction(checks),
    checkedAt: new Date().toISOString(),
    probe: liveChecks.probe,
  };
  deps.recordConnectorHealthRun(report);
  return report;
}

export function createIntegrationConnection(
  deps: IntegrationChannelPort,
  input: IntegrationConnectionCreateInput,
): IntegrationConnection {
  const catalog = INTEGRATION_CATALOG.find((entry) => entry.catalogId === input.catalogId);
  if (!catalog) {
    throw new Error(`Unknown integration catalog id: ${input.catalogId}`);
  }

  const created = deps.storage.integrationConnections.create({
    ...input,
    catalogId: catalog.catalogId,
    kind: catalog.kind,
    key: catalog.key,
    label: input.label?.trim() || catalog.label,
    pluginId: input.pluginId ?? catalog.pluginId,
  });

  deps.publishRealtime("system", "integrations", {
    type: "integration_connection_created",
    connectionId: created.connectionId,
    catalogId: created.catalogId,
    kind: created.kind,
    key: created.key,
    enabled: created.enabled,
    status: created.status,
  });
  void deps.syncDiscordRuntime();

  return created;
}

export function updateIntegrationConnection(
  deps: IntegrationChannelPort,
  connectionId: string,
  input: IntegrationConnectionUpdateInput,
): IntegrationConnection {
  const updated = deps.storage.integrationConnections.update(connectionId, input);
  deps.publishRealtime("system", "integrations", {
    type: "integration_connection_updated",
    connectionId: updated.connectionId,
    enabled: updated.enabled,
    status: updated.status,
    lastError: updated.lastError,
  });
  void deps.syncDiscordRuntime();
  return updated;
}

export function deleteIntegrationConnection(deps: IntegrationChannelPort, connectionId: string): boolean {
  const deleted = deps.storage.integrationConnections.delete(connectionId);
  if (deleted) {
    deps.publishRealtime("system", "integrations", {
      type: "integration_connection_deleted",
      connectionId,
    });
  }
  void deps.syncDiscordRuntime();
  return deleted;
}

export function listDiscordPairings(
  deps: IntegrationChannelPort,
  connectionId: string,
): { runtime?: DiscordRuntimeStatus; items: DiscordPairingRecord[] } {
  const connection = deps.getIntegrationConnection(connectionId);
  deps.assertDiscordConnection(connection);
  return {
    runtime: deps.getDiscordRuntimeStatus(connectionId),
    items: deps
      .readDiscordPairings()
      .filter((item) => item.connectionId === connectionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  };
}

export function approveDiscordPairing(
  deps: IntegrationChannelPort,
  connectionId: string,
  pairingId: string,
): DiscordPairingRecord {
  const connection = deps.getIntegrationConnection(connectionId);
  deps.assertDiscordConnection(connection);
  const pairings = deps.readDiscordPairings();
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
  deps.writeDiscordPairings(next);
  return next.find((item) => item.pairingId === pairingId)!;
}

export function revokeDiscordPairing(
  deps: IntegrationChannelPort,
  connectionId: string,
  pairingId: string,
): DiscordPairingRecord {
  const connection = deps.getIntegrationConnection(connectionId);
  deps.assertDiscordConnection(connection);
  const pairings = deps.readDiscordPairings();
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
  deps.writeDiscordPairings(pairings.map((item) => (item.pairingId === pairingId ? revoked : item)));
  return revoked;
}

export async function reconnectDiscordRuntime(
  deps: IntegrationChannelPort,
  connectionId: string,
): Promise<DiscordRuntimeStatus | undefined> {
  const connection = deps.getIntegrationConnection(connectionId);
  deps.assertDiscordConnection(connection);
  return deps.discordRuntimeService.reconnectConnection(connectionId);
}

export async function emitTelegramTypingImpl(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelTypingInput,
): Promise<ChannelTypingResult> {
  const token =
    deps.resolveConnectionSecret(connection.config, "botToken", "botTokenEnv") ??
    deps.resolveConnectionSecret(connection.config, "token", "tokenEnv");
  const chatId = input.target.trim() || deps.readConnectionConfigValue(connection.config, "defaultChatId");
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
  if (!deps.isConnectionUrlAllowlisted(telegramApiUrl)) {
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
      fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
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

export function listIntegrationPlugins(deps: IntegrationChannelPort): IntegrationPluginRecord[] {
  return deps.readIntegrationPlugins();
}

export function installIntegrationPlugin(
  deps: IntegrationChannelPort,
  input: IntegrationPluginInstallInput,
): IntegrationPluginRecord {
  const now = new Date().toISOString();
  const plugins = deps.readIntegrationPlugins();
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
    deps.writeIntegrationPlugins(plugins.map((item) => (item.pluginId === nextId ? updated : item)));
    return updated;
  }

  const created = buildInstalledIntegrationPluginRecord({
    now,
    pluginId: nextId,
    source: input.source,
  });
  deps.writeIntegrationPlugins([created, ...plugins]);
  deps.publishRealtime("system", "integrations", {
    type: "integration_plugin_installed",
    pluginId: created.pluginId,
    source: input.source,
  });
  return created;
}

export function setIntegrationPluginEnabled(
  deps: IntegrationChannelPort,
  pluginId: string,
  enabled: boolean,
): IntegrationPluginRecord {
  const now = new Date().toISOString();
  const plugins = deps.readIntegrationPlugins();
  const current = plugins.find((item) => item.pluginId === pluginId);
  if (!current) {
    throw new Error(`Unknown integration plugin: ${pluginId}`);
  }
  const updated: IntegrationPluginRecord = {
    ...current,
    enabled,
    updatedAt: now,
  };
  deps.writeIntegrationPlugins(plugins.map((item) => (item.pluginId === pluginId ? updated : item)));
  deps.publishRealtime("system", "integrations", {
    type: enabled ? "integration_plugin_enabled" : "integration_plugin_disabled",
    pluginId,
  });
  return updated;
}
