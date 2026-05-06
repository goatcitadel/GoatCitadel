import type {
  AgenticCapabilityAvailability,
  AgenticHarnessAvailabilityRecord,
  AgenticPluginProviderRuntimeStatus,
  AgenticRuntimeAvailabilityResponse,
} from "@goatcitadel/contracts";
import type { IntegrationCatalogEntry, IntegrationConnection } from "@goatcitadel/contracts";
import type { LlmProviderSummary } from "@goatcitadel/contracts";
import type { IntegrationPluginRecord } from "@goatcitadel/contracts";
import {
  normalizePluginProviderRuntimeStatus,
  runtimeStatusToCapabilityAvailability,
} from "./plugin-provider-governance-service.js";

export type AgenticCapabilityFamily = AgenticCapabilityAvailability["family"];

export interface AgenticCapabilityRuntimeAvailabilityInput {
  capabilityId: string;
  label: string;
  family: AgenticCapabilityFamily;
  inspectable: boolean;
  callable: boolean;
  configured?: boolean;
  reasons?: string[];
  unavailableReason?: string;
  blockedReason?: string;
  notConfiguredReason?: string;
  checkedAt?: string;
}

export interface AgenticRuntimeAvailabilityBuildInput {
  generatedAt?: string;
  harnesses?: AgenticHarnessAvailabilityRecord[];
  providers?: LlmProviderSummary[];
  plugins?: IntegrationPluginRecord[];
  channelCatalog?: IntegrationCatalogEntry[];
  channelConnections?: IntegrationConnection[];
}

export function normalizeAgenticCapabilityAvailability(
  input: AgenticCapabilityRuntimeAvailabilityInput,
): AgenticCapabilityAvailability {
  const reasons = normalizeReasons([
    ...(input.reasons ?? []),
    input.unavailableReason,
    input.notConfiguredReason,
    input.blockedReason,
  ]);
  const inspectable = input.inspectable;
  const callable = inspectable && input.callable;

  return {
    capabilityId: input.capabilityId.trim(),
    label: input.label.trim(),
    family: input.family,
    status: resolveAvailabilityStatus({
      inspectable,
      callable,
      configured: input.configured,
      unavailableReason: input.unavailableReason,
      notConfiguredReason: input.notConfiguredReason,
      reasons,
    }),
    callable,
    reasons,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

export function normalizeAgenticCapabilityAvailabilitySet(input: {
  providers?: AgenticCapabilityRuntimeAvailabilityInput[];
  harnesses?: AgenticCapabilityRuntimeAvailabilityInput[];
  channels?: AgenticCapabilityRuntimeAvailabilityInput[];
  other?: AgenticCapabilityRuntimeAvailabilityInput[];
}): AgenticCapabilityAvailability[] {
  return [
    ...(input.providers ?? []).map((item) => normalizeAgenticCapabilityAvailability({ ...item, family: "provider" })),
    ...(input.harnesses ?? []).map((item) => normalizeAgenticCapabilityAvailability({ ...item, family: "harness" })),
    ...(input.channels ?? []).map((item) => normalizeAgenticCapabilityAvailability({ ...item, family: "channel" })),
    ...(input.other ?? []).map((item) => normalizeAgenticCapabilityAvailability(item)),
  ];
}

export function buildAgenticRuntimeAvailability(
  input: AgenticRuntimeAvailabilityBuildInput,
): AgenticRuntimeAvailabilityResponse {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const harnesses = input.harnesses ?? [];
  const providers = (input.providers ?? []).map((provider) => providerSummaryToRuntimeStatus(provider, generatedAt));
  const plugins = (input.plugins ?? []).map((plugin) => integrationPluginToRuntimeStatus(plugin, generatedAt));
  const channels = buildChannelAvailability(input.channelCatalog ?? [], input.channelConnections ?? [], generatedAt);
  const items = [
    ...harnesses.map(harnessAvailabilityToCapabilityAvailability),
    ...providers.map(runtimeStatusToCapabilityAvailability),
    ...plugins.map(runtimeStatusToCapabilityAvailability),
    ...channels,
  ];

  return {
    generatedAt,
    items,
    harnesses,
    plugins,
    providers,
    channels,
  };
}

export function harnessAvailabilityToCapabilityAvailability(
  input: AgenticHarnessAvailabilityRecord,
): AgenticCapabilityAvailability {
  return {
    capabilityId: `harness:${input.harnessId}`,
    label: input.label,
    family: "harness",
    status: input.status,
    callable: input.callable && input.status === "callable",
    reasons: input.reasons,
    checkedAt: input.checkedAt,
  };
}

function resolveAvailabilityStatus(input: {
  inspectable: boolean;
  callable: boolean;
  configured?: boolean;
  unavailableReason?: string;
  notConfiguredReason?: string;
  reasons: string[];
}): AgenticCapabilityAvailability["status"] {
  if (input.callable) {
    return "callable";
  }
  if (!input.inspectable) {
    return "unavailable";
  }
  if (input.unavailableReason) {
    return "unavailable";
  }
  if (input.configured === false || input.notConfiguredReason) {
    return "not_configured";
  }
  return "blocked";
}

function normalizeReasons(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    reasons.push(normalized);
  }
  return reasons;
}

function providerSummaryToRuntimeStatus(
  provider: LlmProviderSummary,
  checkedAt: string,
): AgenticPluginProviderRuntimeStatus {
  const configured = provider.hasApiKey || provider.oauthStatus?.connected === true;
  return normalizePluginProviderRuntimeStatus({
    runtimeId: provider.providerId,
    kind: "provider",
    label: provider.label,
    manifestSource: provider.baseUrl,
    integrityStatus: "verified",
    runtimeAvailable: configured,
    approvedForCallableUse: true,
    healthOk: configured,
    secretsRequired: configured ? [] : [`${provider.providerId} credential`],
    checkedAt,
    healthMessage: configured ? undefined : "Provider is inspectable but no usable credential is configured.",
  });
}

function integrationPluginToRuntimeStatus(
  plugin: IntegrationPluginRecord,
  checkedAt: string,
): AgenticPluginProviderRuntimeStatus {
  const integrityStatus = mapPluginIntegrityStatus(plugin);
  const hasCriticalWarning = (plugin.trustWarnings ?? []).some((warning) => warning.severity === "critical");
  return normalizePluginProviderRuntimeStatus({
    runtimeId: plugin.pluginId,
    kind: "plugin",
    label: plugin.label,
    manifestSource: plugin.sourceMetadata?.display ?? plugin.source,
    integrityStatus,
    runtimeAvailable: plugin.enabled && integrityStatus !== "corrupt" && !hasCriticalWarning,
    approvedForCallableUse: plugin.enabled && !hasCriticalWarning,
    healthOk: plugin.enabled && integrityStatus === "verified" && !hasCriticalWarning,
    permissions: plugin.capabilities,
    rollbackRef: plugin.version,
    checkedAt,
    healthMessage: hasCriticalWarning
      ? "Plugin has a critical trust warning and is excluded from callable runtime."
      : undefined,
  });
}

function mapPluginIntegrityStatus(
  plugin: IntegrationPluginRecord,
): AgenticPluginProviderRuntimeStatus["integrityStatus"] {
  switch (plugin.integrityStatus ?? plugin.sourceMetadata?.integrityStatus ?? "unknown") {
    case "verified":
    case "not_applicable":
      return "verified";
    case "missing":
    case "mismatch":
      return "corrupt";
    case "unknown":
    default:
      return "unverified";
  }
}

function buildChannelAvailability(
  catalog: IntegrationCatalogEntry[],
  connections: IntegrationConnection[],
  checkedAt: string,
): AgenticCapabilityAvailability[] {
  const connectionsByCatalog = new Map<string, IntegrationConnection[]>();
  for (const connection of connections) {
    const current = connectionsByCatalog.get(connection.catalogId) ?? [];
    current.push(connection);
    connectionsByCatalog.set(connection.catalogId, current);
  }

  return catalog
    .filter((entry) => entry.kind === "channel")
    .map((entry) => {
      const matchingConnections = connectionsByCatalog.get(entry.catalogId) ?? [];
      const enabledConnected = matchingConnections.find(
        (connection) => connection.enabled && connection.status === "connected",
      );
      const anyConnection = matchingConnections[0];
      const runnable = entry.runtimeAvailability === "runnable";
      const configured = matchingConnections.length > 0;
      const unavailableReason = runnable ? undefined : "Channel runtime is catalog-only or blocked.";
      const notConfiguredReason = configured ? undefined : "No channel connection is configured.";
      const blockedReason =
        configured && !enabledConnected
          ? (anyConnection?.lastError ??
            (anyConnection?.enabled === false
              ? "Channel connection is disabled."
              : `Channel connection is ${anyConnection?.status ?? "not connected"}.`))
          : undefined;

      return normalizeAgenticCapabilityAvailability({
        capabilityId: `channel:${entry.key}`,
        label: entry.label,
        family: "channel",
        inspectable: true,
        callable: Boolean(runnable && enabledConnected),
        configured,
        unavailableReason,
        notConfiguredReason,
        blockedReason,
        checkedAt,
      });
    });
}
