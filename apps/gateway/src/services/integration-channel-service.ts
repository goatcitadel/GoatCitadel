import { publishIntegrationConnectionCommit } from "./integration-connection-commit-service.js";
import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
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
  RealtimeEvent,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import type { AsyncStorage } from "@goatcitadel/storage";
import { INTEGRATION_CATALOG } from "./integration-catalog.js";
import { emitProviderTypingWithDeps } from "./channel-typing-adapters.js";
import type { ChannelStreamRuntimeStatus } from "./channel-stream-runtime-service.js";
import { parseChannelSecretRef, type ChannelSecretCustodyService } from "./channel-secret-custody-service.js";
import type { ChannelSecretOwner } from "./channel-secret-resolution.js";
import { resolveChannelConfigTarget } from "./channel-config.js";
import { sendTelegramTypingIndicator } from "./telegram-typing.js";
import { emitChannelActivityImpl } from "./integration-channel-activity.js";

export interface IntegrationChannelPort {
  storage: {
    channelSetupDrafts?: Pick<AsyncStorage["channelSetupDrafts"], "finalizeConnection">;
    integrationConnections: {
      list(kind?: IntegrationKind, limit?: number): Promise<IntegrationConnection[]>;
      get(connectionId: string): Promise<IntegrationConnection>;
      create(
        input: IntegrationConnectionCreateInput & {
          catalogId: string;
          kind: IntegrationKind;
          key: string;
          label: string;
        },
      ): Promise<IntegrationConnection>;
      update(connectionId: string, input: IntegrationConnectionUpdateInput): Promise<IntegrationConnection>;
      delete(connectionId: string, expectedRevision?: string): Promise<boolean>;
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
  /** Syncs Discord and the channel stream runtime after a committed connection change. */
  syncChannelRuntimes(): Promise<void>;
  getChannelStreamRuntimeStatus(connectionId: string): ChannelStreamRuntimeStatus | undefined;
  getDiscordRuntimeStatus(connectionId: string): DiscordRuntimeStatus | undefined;
  latestAcceptedInboundAt?(channelKey: string, connectionId: string): Promise<string | undefined>;
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
  /** Keychain custody of channel keys; absent where the host has no OS keychain. Removing a channel deletes its keys here. */
  channelSecrets?: Pick<ChannelSecretCustodyService, "delete">;
  resolveConnectionSecret(
    config: Record<string, unknown>,
    directKey: string,
    envKey: string,
    catalogId: string,
    owner: ChannelSecretOwner,
  ): string | undefined;
  readConnectionConfigValue(config: Record<string, unknown>, key: string): string | undefined;
  isConnectionUrlAllowlisted(urlValue: string): boolean;
  fetchWithDiagnosticsTimeout(url: string, init?: RequestInit): Promise<Response>;
  recordDevDiagnostic?(entry: {
    level: "warn";
    category: string;
    event: string;
    message: string;
    context: Record<string, unknown>;
  }): void;
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

  public createIntegrationConnection(
    input: IntegrationConnectionCreateInput,
    onCommitted?: () => Promise<void>,
  ): Promise<IntegrationConnection> {
    return createIntegrationConnection(this.deps, input, onCommitted);
  }

  public async finalizeChannelSetupConnection(
    draftId: string,
    expectedRevision: number,
    input: Parameters<AsyncStorage["channelSetupDrafts"]["finalizeConnection"]>[2],
    onCommitted?: () => Promise<void>,
  ): Promise<IntegrationConnection> {
    if (!this.deps.storage.channelSetupDrafts)
      throw new ValidationError({ message: "Channel finalization storage is unavailable." });
    const catalog = INTEGRATION_CATALOG.find((entry) => entry.catalogId === input.catalogId);
    if (!catalog || catalog.kind !== "channel" || catalog.key !== input.key)
      throw new ValidationError({ message: "The channel catalog does not match its setup draft." });
    const connection = await this.deps.storage.channelSetupDrafts.finalizeConnection(draftId, expectedRevision, {
      ...input,
      kind: catalog.kind,
      config: applyChannelInboundAccessDefaults(catalog.kind, catalog.key, input.config) ?? {},
    });
    await publishIntegrationConnectionCommit(
      this.deps,
      {
        type: "channel_setup_finalized",
        connectionId: connection.connectionId,
        draftId,
        enabled: connection.enabled,
        status: connection.status,
      },
      onCommitted,
    );
    return connection;
  }

  public updateIntegrationConnection(
    connectionId: string,
    input: IntegrationConnectionUpdateInput,
    onCommitted?: () => Promise<void>,
  ): Promise<IntegrationConnection> {
    return updateIntegrationConnection(this.deps, connectionId, input, onCommitted);
  }

  public deleteIntegrationConnection(
    connectionId: string,
    expectedRevision?: string,
    onCommitted?: () => Promise<void>,
  ): Promise<boolean> {
    return deleteIntegrationConnection(this.deps, connectionId, expectedRevision, onCommitted);
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

  public emitProviderTyping(
    connection: IntegrationConnection,
    input: ChannelTypingInput,
  ): Promise<ChannelTypingResult> {
    if (connection.key === "telegram") {
      return emitTelegramTypingImpl(this.deps, connection, input);
    }
    return emitProviderTypingWithDeps(this.deps, connection, input);
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
}

/**
 * Channel keys that intentionally stay open (no inbound sender allowlist) on a
 * NEW connection. These are channels with no per-sender inbound model, so an
 * allowlist would be meaningless or would break their normal operation:
 *
 *   - `tui`  : local terminal; the operator is the local user, there is no
 *              remote sender `actorId` to gate on.
 *
 * ntfy is deliberately NOT here: its opt-in stream inbound has a sender (the
 * topic) that the allowlist gates, so every ntfy connection defaults to allowlist.
 *
 * Every other inbound-capable channel (Discord, Telegram, Slack, WhatsApp,
 * LINE, Nextcloud Talk, Matrix, Mattermost, Teams, ...) is default-safe
 * (allowlist) so unknown senders are denied until an operator explicitly allows
 * them. An operator who genuinely wants an open posture for one of those
 * channels must opt in via `inboundAccessMode: "open_legacy"`.
 */
export const OPEN_INBOUND_CHANNELS: ReadonlySet<string> = new Set(["tui"]);

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
    lastInboundAt: await deps.latestAcceptedInboundAt?.(connection.key, connectionId),
    metadata: {
      setupReady: capabilities.setupReady,
      setupDiagnostics: capabilities.setupDiagnostics,
      supportNotes: capabilities.supportNotes,
      connectionStatus: connection.status,
      readinessSource: connection.key === "discord" ? "live_runtime" : "last_live_probe",
      authoritative: connection.key === "discord" || Boolean(connection.lastSyncAt),
    },
  };

  if (capabilities.inboundModes.includes("stream") || capabilities.inboundModes.includes("poll")) {
    const stream = deps.getChannelStreamRuntimeStatus(connectionId);
    return {
      ...runtimeStatus,
      ready: Boolean(stream?.ready),
      lastReadyAt: stream?.lastReadyAt,
      lastInboundAt: runtimeStatus.lastInboundAt ?? stream?.lastInboundAt,
      lastReconnectAt: stream?.lastReconnectAt,
      lastError: stream?.lastError ?? runtimeStatus.lastError,
      metadata: {
        ...runtimeStatus.metadata,
        readinessSource: "live_runtime",
        authoritative: true,
        streamStoppedReason: stream?.stoppedReason,
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
    lastInboundAt: runtimeStatus.lastInboundAt ?? discordRuntime.lastInboundAt,
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
  onCommitted?: () => Promise<void>,
): Promise<IntegrationConnection> {
  if (input.catalogId.startsWith("external_connector.")) {
    throw new ValidationError({
      message:
        "External connector catalog entries are review-only and cannot be connected until promoted through a governed capability proposal.",
    });
  }
  const catalog = INTEGRATION_CATALOG.find((entry) => entry.catalogId === input.catalogId);
  if (!catalog) {
    throw new ValidationError({ message: `Unknown integration catalog id: ${input.catalogId}` });
  }

  const created = await deps.storage.integrationConnections.create({
    ...input,
    config: applyChannelInboundAccessDefaults(catalog.kind, catalog.key, input.config),
    catalogId: catalog.catalogId,
    kind: catalog.kind,
    key: catalog.key,
    label: input.label?.trim() || catalog.label,
  });

  await publishIntegrationConnectionCommit(
    deps,
    {
      type: "integration_connection_created",
      connectionId: created.connectionId,
      catalogId: created.catalogId,
      kind: created.kind,
      key: created.key,
      enabled: created.enabled,
      status: created.status,
    },
    onCommitted,
  );

  return created;
}

export async function updateIntegrationConnection(
  deps: IntegrationChannelPort,
  connectionId: string,
  input: IntegrationConnectionUpdateInput,
  onCommitted?: () => Promise<void>,
): Promise<IntegrationConnection> {
  const current = await deps.storage.integrationConnections.get(connectionId);
  const updated = await deps.storage.integrationConnections.update(connectionId, {
    ...input,
    expectedRevision: input.expectedRevision ?? current.revision,
    config:
      input.config && current
        ? applyChannelInboundAccessDefaults(current.kind, current.key, input.config, current.config)
        : input.config,
  });
  await publishIntegrationConnectionCommit(
    deps,
    {
      type: "integration_connection_updated",
      connectionId: updated.connectionId,
      enabled: updated.enabled,
      status: updated.status,
      lastError: updated.lastError,
    },
    onCommitted,
  );
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

/** Where the keychain refs of a channel connection start; the connection id and a colon follow. */
const CONNECTION_SECRET_REF_PREFIX = "keychain:goatcitadel:channel-connection:";

/**
 * Every keychain reference this connection owns, anywhere in its config, once each. Only the exact
 * `<prefix><connectionId>:` form counts, so a draft's key, another connection's key (even one whose id
 * extends this one) and text that merely mentions a reference are never returned.
 */
export function collectConnectionSecretRefs(connectionId: string, config: Record<string, unknown>): string[] {
  const prefix = `${CONNECTION_SECRET_REF_PREFIX}${connectionId}:`;
  const found = new Set<string>();
  const seen = new Set<object>();
  const queue: unknown[] = [config];
  for (let index = 0; index < queue.length; index += 1) {
    const value = queue[index];
    if (typeof value === "string") {
      if (value.startsWith(prefix)) found.add(value);
    } else if (value !== null && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      queue.push(...Object.values(value));
    }
  }
  return [...found];
}

/**
 * Removes a channel connection. The connection row, its keys and its Discord pairings go; its sessions,
 * bindings and transcripts stay, so the conversations remain readable under a removed channel.
 *
 * The keys and pairings are released only after the delete committed, and nothing about releasing them can
 * undo or fail the removal: a failure is logged by field name and the caller still sees the delete.
 */
export async function deleteIntegrationConnection(
  deps: IntegrationChannelPort,
  connectionId: string,
  expectedRevision?: string,
  onCommitted?: () => Promise<void>,
): Promise<boolean> {
  const connections = deps.storage.integrationConnections;
  const removed = await readConnectionBeforeRemoval(connections, connectionId);
  // Pinning the revision read here makes the keys released below exactly the ones of the row that is deleted.
  const deleted = await connections.delete(connectionId, expectedRevision ?? removed?.revision);
  if (!deleted) {
    return false;
  }
  try {
    await publishIntegrationConnectionCommit(
      deps,
      {
        type: "integration_connection_deleted",
        connectionId,
      },
      onCommitted,
    );
  } finally {
    if (removed) {
      await releaseRemovedConnection(deps, removed);
    }
  }
  return true;
}

async function readConnectionBeforeRemoval(
  connections: IntegrationChannelPort["storage"]["integrationConnections"],
  connectionId: string,
): Promise<IntegrationConnection | undefined> {
  try {
    return await connections.get(connectionId);
  } catch (error) {
    // A connection that is already gone has nothing to release; any other failure stops before anything changes.
    if (error instanceof NotFoundError) {
      return undefined;
    }
    throw error;
  }
}

/** Deletes the removed connection's keys and Discord pairings. A failure is reported, never thrown: the removal has committed. */
async function releaseRemovedConnection(deps: IntegrationChannelPort, removed: IntegrationConnection): Promise<void> {
  const { connectionId } = removed;
  const refs = collectConnectionSecretRefs(connectionId, removed.config);
  const custody = deps.channelSecrets;
  const failedFields: string[] = [];
  let failure: unknown;
  for (const ref of refs) {
    try {
      if (!custody) {
        throw new Error("The OS keychain is unavailable.");
      }
      custody.delete(ref);
    } catch (error) {
      failedFields.push(secretFieldName(ref));
      failure ??= error;
    }
  }
  if (failedFields.length > 0) {
    reportReleaseFailure(
      deps,
      "channel.connection.secret_cleanup_failed",
      "A removed channel left keys in the OS keychain.",
      {
        connectionId,
        fields: [...new Set(failedFields)],
        errorName: errorNameOf(failure),
      },
    );
  }
  if (removed.kind === "channel" && removed.key === "discord") {
    try {
      const pairings = await deps.readDiscordPairings();
      const kept = pairings.filter((item) => item.connectionId !== connectionId);
      if (kept.length !== pairings.length) {
        await deps.writeDiscordPairings(kept);
      }
    } catch (error) {
      reportReleaseFailure(
        deps,
        "channel.connection.pairing_cleanup_failed",
        "A removed channel left Discord pairings behind.",
        {
          connectionId,
          errorName: errorNameOf(error),
        },
      );
    }
  }
}

/** The field a keychain reference belongs to (for example `botToken`), or `unknown`; never any other part of it. */
function secretFieldName(secretRef: string): string {
  try {
    return parseChannelSecretRef(secretRef).fieldKey;
  } catch {
    return "unknown";
  }
}

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function reportReleaseFailure(
  deps: IntegrationChannelPort,
  event: string,
  message: string,
  context: Record<string, unknown>,
): void {
  deps.recordDevDiagnostic?.({ level: "warn", category: "channels", event, message, context });
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
    deps.resolveConnectionSecret(connection.config, "botToken", "botTokenEnv", connection.catalogId, connection) ??
    deps.resolveConnectionSecret(connection.config, "token", "tokenEnv", connection.catalogId, connection);
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
