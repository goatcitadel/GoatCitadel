import { randomUUID } from "node:crypto";
import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import type {
  ChannelActivityEffectResult,
  ChannelActivityInput,
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
  RealtimeEvent,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { INTEGRATION_CATALOG } from "./integration-catalog.js";
import {
  buildInstalledIntegrationPluginRecord,
  resolveIntegrationPluginInstallMetadata,
} from "./integration-plugin-author-contract.js";
import { resolveChannelConfigTarget } from "./channel-config.js";
import { sendTelegramTypingIndicator } from "./telegram-typing.js";
import { emitChannelActivityImpl } from "./integration-channel-activity.js";

export interface IntegrationChannelPort {
  storage: {
    integrationConnections: {
      list(kind?: IntegrationKind, limit?: number): Promise<IntegrationConnection[]>;
      get(connectionId: string): Promise<IntegrationConnection>;
      create(
        input: IntegrationConnectionCreateInput & {
          catalogId: string;
          kind: IntegrationKind;
          key: string;
          label: string;
          pluginId?: string;
        },
      ): Promise<IntegrationConnection>;
      update(connectionId: string, input: IntegrationConnectionUpdateInput): Promise<IntegrationConnection>;
      delete(connectionId: string): Promise<boolean>;
    };
  };
  publishRealtime(
    scope: string,
    channel: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<void>;
  requireFeatureEnabled(flag: keyof RuntimeSettings["features"]): Promise<void>;
  isFeatureEnabled(flag: keyof RuntimeSettings["features"]): Promise<boolean>;
  buildIntegrationConnectionChecks(connection: IntegrationConnection): ConnectorDiagnosticReport["checks"];
  runIntegrationConnectionLiveChecks(
    connection: IntegrationConnection,
    options: { includeSandboxSend: boolean },
  ): Promise<{ checks: ConnectorDiagnosticReport["checks"]; probe?: ConnectorDiagnosticReport["probe"] }>;
  pickConnectorDiagnosticAction(checks: ConnectorDiagnosticReport["checks"]): string | undefined;
  recordConnectorHealthRun(report: ConnectorDiagnosticReport): Promise<void>;
  syncDiscordRuntime(): Promise<void>;
  syncSignalInboundRuntime(): Promise<void>;
  getDiscordRuntimeStatus(connectionId: string): DiscordRuntimeStatus | undefined;
  getIntegrationConnection(connectionId: string): Promise<IntegrationConnection>;
  assertDiscordConnection(connection: IntegrationConnection): void;
  readDiscordPairings(): Promise<DiscordPairingRecord[]>;
  writeDiscordPairings(records: DiscordPairingRecord[]): Promise<void>;
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
  readIntegrationPlugins(): Promise<IntegrationPluginRecord[]>;
  writeIntegrationPlugins(plugins: IntegrationPluginRecord[]): Promise<void>;
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

  public listIntegrationConnections(kind?: IntegrationKind, limit = 300): Promise<IntegrationConnection[]> {
    return listIntegrationConnections(this.deps, kind, limit);
  }

  public getIntegrationConnection(connectionId: string): Promise<IntegrationConnection> {
    return getIntegrationConnection(this.deps, connectionId);
  }

  public getIntegrationConnectionChannelCapabilities(connectionId: string): Promise<ChannelCapabilities> {
    return getIntegrationConnectionChannelCapabilities(this.deps, connectionId);
  }

  public getIntegrationConnectionChannelRuntimeStatus(connectionId: string): Promise<ChannelRuntimeStatus> {
    return getIntegrationConnectionChannelRuntimeStatus(this.deps, connectionId);
  }

  public runIntegrationConnectionDiagnostics(connectionId: string): Promise<ConnectorDiagnosticReport> {
    return runIntegrationConnectionDiagnostics(this.deps, connectionId);
  }

  public createIntegrationConnection(input: IntegrationConnectionCreateInput): Promise<IntegrationConnection> {
    return createIntegrationConnection(this.deps, input);
  }

  public updateIntegrationConnection(
    connectionId: string,
    input: IntegrationConnectionUpdateInput,
  ): Promise<IntegrationConnection> {
    return updateIntegrationConnection(this.deps, connectionId, input);
  }

  public deleteIntegrationConnection(connectionId: string): Promise<boolean> {
    return deleteIntegrationConnection(this.deps, connectionId);
  }

  public listDiscordPairings(
    connectionId: string,
  ): Promise<{ runtime?: DiscordRuntimeStatus; items: DiscordPairingRecord[] }> {
    return listDiscordPairings(this.deps, connectionId);
  }

  public approveDiscordPairing(connectionId: string, pairingId: string): Promise<DiscordPairingRecord> {
    return approveDiscordPairing(this.deps, connectionId, pairingId);
  }

  public revokeDiscordPairing(connectionId: string, pairingId: string): Promise<DiscordPairingRecord> {
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

  public emitChannelActivity(
    connection: IntegrationConnection,
    input: ChannelActivityInput,
    options: {
      emoji?: string;
      activityReactions: string[];
      typing: boolean;
    },
  ): Promise<ChannelActivityEffectResult[]> {
    return emitChannelActivityImpl(this.deps, connection, input, options);
  }

  public listIntegrationPlugins(): Promise<IntegrationPluginRecord[]> {
    return listIntegrationPlugins(this.deps);
  }

  public installIntegrationPlugin(input: IntegrationPluginInstallInput): Promise<IntegrationPluginRecord> {
    return installIntegrationPlugin(this.deps, input);
  }

  public setIntegrationPluginEnabled(pluginId: string, enabled: boolean): Promise<IntegrationPluginRecord> {
    return setIntegrationPluginEnabled(this.deps, pluginId, enabled);
  }
}

/**
 * Channel keys that intentionally stay open (no inbound sender allowlist) on a
 * NEW connection. These are channels with no per-sender inbound model, so an
 * allowlist would be meaningless or would break their normal operation:
 *
 *   - `tui`  : local terminal; the operator is the local user, there is no
 *              remote sender `actorId` to gate on.
 *   - `ntfy` : outbound-only notification delivery (no inbound messages).
 *
 * Every other inbound-capable channel (Discord, Telegram, Slack, WhatsApp,
 * LINE, Nextcloud Talk, Matrix, Mattermost, Teams, ...) is default-safe
 * (allowlist) so unknown senders are denied until an operator explicitly allows
 * them. An operator who genuinely wants an open posture for one of those
 * channels must opt in via `inboundAccessMode: "open_legacy"`.
 */
export const OPEN_INBOUND_CHANNELS: ReadonlySet<string> = new Set(["tui", "ntfy"]);

export async function listIntegrationConnections(
  deps: IntegrationChannelPort,
  kind?: IntegrationKind,
  limit = 300,
): Promise<IntegrationConnection[]> {
  return await deps.storage.integrationConnections.list(kind, limit);
}

export async function getIntegrationConnection(
  deps: IntegrationChannelPort,
  connectionId: string,
): Promise<IntegrationConnection> {
  return await deps.storage.integrationConnections.get(connectionId);
}

export async function getIntegrationConnectionChannelCapabilities(
  deps: IntegrationChannelPort,
  connectionId: string,
): Promise<ChannelCapabilities> {
  const connection = await deps.storage.integrationConnections.get(connectionId);
  if (!connection) {
    throw new Error(`Unknown integration connection: ${connectionId}`);
  }
  if (connection.kind !== "channel") {
    throw new Error(`Integration connection ${connectionId} is not a channel connection.`);
  }
  return describeChannelCapabilities(connection.key, connection.config);
}

export async function getIntegrationConnectionChannelRuntimeStatus(
  deps: IntegrationChannelPort,
  connectionId: string,
): Promise<ChannelRuntimeStatus> {
  const connection = await deps.storage.integrationConnections.get(connectionId);
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

  const legacySignalFeatureEnabled =
    connection.key === "signal" && (await deps.isFeatureEnabled("signalInboundV1Enabled"));
  const legacySignalInboundValue = connection.config.inboundEnabled;
  const legacySignalConnectionInboundEnabled =
    connection.key === "signal" &&
    (legacySignalInboundValue === true ||
      (typeof legacySignalInboundValue === "string" && legacySignalInboundValue.trim().toLowerCase() === "true"));
  if (connection.key === "signal" && (legacySignalFeatureEnabled || legacySignalConnectionInboundEnabled)) {
    const metadata = runtimeStatus.metadata ?? {};
    const setupDiagnostics = Array.isArray(metadata.setupDiagnostics) ? metadata.setupDiagnostics : [];
    return {
      ...runtimeStatus,
      ready: false,
      lastReadyAt: undefined,
      metadata: {
        ...metadata,
        readinessSource: "blocked_legacy_inbound",
        authoritative: true,
        featureFlag: "signalInboundV1Enabled",
        featureEnabled: legacySignalFeatureEnabled,
        legacyConnectionInboundEnabled: legacySignalConnectionInboundEnabled,
        setupDiagnostics: [
          ...setupDiagnostics,
          "Signal inbound is blocked: the current bridge receive endpoint has no acknowledgement/replay contract. Legacy inbound settings never start polling; outbound sends remain available.",
        ],
      },
      runtimePosture: {
        outboundTransport: "api",
        lifecycle: "stateless",
        inboundReadiness: "unsupported",
        operatorSummary:
          "Signal is outbound-only. Legacy inbound=true is deprecated and blocked because the current bridge cannot safely replay or acknowledge received messages.",
      },
    };
  }

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
  await deps.requireFeatureEnabled("connectorDiagnosticsV1Enabled");
  const connection = await deps.storage.integrationConnections.get(connectionId);
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
  await deps.recordConnectorHealthRun(report);
  return report;
}

export async function createIntegrationConnection(
  deps: IntegrationChannelPort,
  input: IntegrationConnectionCreateInput,
): Promise<IntegrationConnection> {
  if (input.catalogId.startsWith("external_connector.")) {
    throw new Error(
      "External connector catalog entries are review-only and cannot be connected until promoted through a governed capability proposal.",
    );
  }
  const catalog = INTEGRATION_CATALOG.find((entry) => entry.catalogId === input.catalogId);
  if (!catalog) {
    throw new Error(`Unknown integration catalog id: ${input.catalogId}`);
  }

  const created = await deps.storage.integrationConnections.create({
    ...input,
    config: applyChannelInboundAccessDefaults(catalog.kind, catalog.key, input.config),
    catalogId: catalog.catalogId,
    kind: catalog.kind,
    key: catalog.key,
    label: input.label?.trim() || catalog.label,
    pluginId: input.pluginId ?? catalog.pluginId,
  });

  await deps.publishRealtime("system", "integrations", {
    type: "integration_connection_created",
    connectionId: created.connectionId,
    catalogId: created.catalogId,
    kind: created.kind,
    key: created.key,
    enabled: created.enabled,
    status: created.status,
  });
  await deps.syncDiscordRuntime();
  await deps.syncSignalInboundRuntime();

  return created;
}

export async function updateIntegrationConnection(
  deps: IntegrationChannelPort,
  connectionId: string,
  input: IntegrationConnectionUpdateInput,
): Promise<IntegrationConnection> {
  const current = await deps.storage.integrationConnections.get(connectionId);
  const updated = await deps.storage.integrationConnections.update(connectionId, {
    ...input,
    config:
      input.config && current
        ? applyChannelInboundAccessDefaults(current.kind, current.key, input.config, current.config)
        : input.config,
  });
  await deps.publishRealtime("system", "integrations", {
    type: "integration_connection_updated",
    connectionId: updated.connectionId,
    enabled: updated.enabled,
    status: updated.status,
    lastError: updated.lastError,
  });
  await deps.syncDiscordRuntime();
  await deps.syncSignalInboundRuntime();
  return updated;
}

/**
 * Stamp a default inbound trust posture onto a connection's config.
 *
 * New connections default-safe: every inbound-capable channel gets
 * `inboundAccessMode: "allowlist"` (empty allowlist = deny-until-allowed), so an
 * unknown sender can never open a session by default. An operator must
 * explicitly choose an open posture (`open_legacy`) per connection.
 *
 * Legacy stays open-with-warning until migrated: this only stamps a mode when
 * the incoming config does NOT already carry one. EXISTING connections that
 * were persisted before this default (unset mode + empty senders) are never
 * rewritten here, so `evaluateChannelInboundAccess` keeps returning
 * `legacy_open_unset` + a migration warning for them rather than locking out
 * current users. When replacing config on such a connection we also carry the
 * existing mode forward so an update does not silently change its posture.
 */
function applyChannelInboundAccessDefaults(
  kind: IntegrationKind,
  key: string,
  config: Record<string, unknown> | undefined,
  existingConfig?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!config) {
    return config;
  }
  if (config.inboundAccessMode !== undefined) {
    return config;
  }
  if (typeof existingConfig?.inboundAccessMode === "string") {
    // Preserve the posture an existing connection already had (including a
    // legacy connection that was migrated to an explicit mode), instead of
    // re-defaulting it on a config replacement.
    return {
      ...config,
      inboundAccessMode: existingConfig.inboundAccessMode,
    };
  }
  // Replacing the config of an EXISTING connection that never had a mode: leave
  // it unset so the legacy open-with-warning path stays in effect until the
  // operator migrates it. Only NEW connections get the default-safe mode.
  if (existingConfig !== undefined) {
    return config;
  }
  if (kind !== "channel" || OPEN_INBOUND_CHANNELS.has(key)) {
    return config;
  }
  return {
    ...config,
    inboundAccessMode: "allowlist",
  };
}

export async function deleteIntegrationConnection(
  deps: IntegrationChannelPort,
  connectionId: string,
): Promise<boolean> {
  const deleted = await deps.storage.integrationConnections.delete(connectionId);
  if (deleted) {
    await deps.publishRealtime("system", "integrations", {
      type: "integration_connection_deleted",
      connectionId,
    });
  }
  await deps.syncDiscordRuntime();
  await deps.syncSignalInboundRuntime();
  return deleted;
}

export async function listDiscordPairings(
  deps: IntegrationChannelPort,
  connectionId: string,
): Promise<{ runtime?: DiscordRuntimeStatus; items: DiscordPairingRecord[] }> {
  const connection = await deps.getIntegrationConnection(connectionId);
  deps.assertDiscordConnection(connection);
  return {
    runtime: deps.getDiscordRuntimeStatus(connectionId),
    items: (await deps.readDiscordPairings())
      .filter((item) => item.connectionId === connectionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  };
}

export async function approveDiscordPairing(
  deps: IntegrationChannelPort,
  connectionId: string,
  pairingId: string,
): Promise<DiscordPairingRecord> {
  const connection = await deps.getIntegrationConnection(connectionId);
  deps.assertDiscordConnection(connection);
  const pairings = await deps.readDiscordPairings();
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
  await deps.writeDiscordPairings(next);
  return next.find((item) => item.pairingId === pairingId)!;
}

export async function revokeDiscordPairing(
  deps: IntegrationChannelPort,
  connectionId: string,
  pairingId: string,
): Promise<DiscordPairingRecord> {
  const connection = await deps.getIntegrationConnection(connectionId);
  deps.assertDiscordConnection(connection);
  const pairings = await deps.readDiscordPairings();
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
  await deps.writeDiscordPairings(pairings.map((item) => (item.pairingId === pairingId ? revoked : item)));
  return revoked;
}

export async function reconnectDiscordRuntime(
  deps: IntegrationChannelPort,
  connectionId: string,
): Promise<DiscordRuntimeStatus | undefined> {
  const connection = await deps.getIntegrationConnection(connectionId);
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
  const chatId = input.target.trim() || resolveChannelConfigTarget("telegram", connection.config);
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

export async function listIntegrationPlugins(deps: IntegrationChannelPort): Promise<IntegrationPluginRecord[]> {
  return await deps.readIntegrationPlugins();
}

export async function installIntegrationPlugin(
  deps: IntegrationChannelPort,
  input: IntegrationPluginInstallInput,
): Promise<IntegrationPluginRecord> {
  const now = new Date().toISOString();
  const plugins = await deps.readIntegrationPlugins();
  const installMetadata = resolveIntegrationPluginInstallMetadata(input.source);
  const nextId = sanitizePluginId(input.pluginId ?? installMetadata.manifest?.pluginId ?? input.source);
  const existing = plugins.find((item) => item.pluginId === nextId);
  if (existing) {
    const updated = buildInstalledIntegrationPluginRecord({
      now,
      pluginId: nextId,
      source: input.source,
      sourceType: input.sourceType,
      expectedIntegrity: input.expectedIntegrity,
      existing,
    });
    await deps.writeIntegrationPlugins(plugins.map((item) => (item.pluginId === nextId ? updated : item)));
    return updated;
  }

  const created = buildInstalledIntegrationPluginRecord({
    now,
    pluginId: nextId,
    source: input.source,
    sourceType: input.sourceType,
    expectedIntegrity: input.expectedIntegrity,
  });
  await deps.writeIntegrationPlugins([created, ...plugins]);
  await deps.publishRealtime("system", "integrations", {
    type: "integration_plugin_installed",
    pluginId: created.pluginId,
    source: input.source,
  });
  return created;
}

export async function setIntegrationPluginEnabled(
  deps: IntegrationChannelPort,
  pluginId: string,
  enabled: boolean,
): Promise<IntegrationPluginRecord> {
  const now = new Date().toISOString();
  const plugins = await deps.readIntegrationPlugins();
  const current = plugins.find((item) => item.pluginId === pluginId);
  if (!current) {
    throw new Error(`Unknown integration plugin: ${pluginId}`);
  }
  const updated: IntegrationPluginRecord = {
    ...current,
    enabled,
    updatedAt: now,
  };
  await deps.writeIntegrationPlugins(plugins.map((item) => (item.pluginId === pluginId ? updated : item)));
  await deps.publishRealtime("system", "integrations", {
    type: enabled ? "integration_plugin_enabled" : "integration_plugin_disabled",
    pluginId,
  });
  return updated;
}
