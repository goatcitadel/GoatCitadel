import type { IntegrationCatalogEntry, IntegrationConnection } from "../api/client";
import type { ChannelAttachmentInput, ChatAttachmentRecord, ConnectorRecord } from "@goatcitadel/contracts";

export type UiRiskLevel = "safe" | "warning" | "critical";
export type UiRiskItem = { field: string; level: UiRiskLevel; hint?: string };

export type ChannelSetupPath = "guided" | "manual" | "blocked" | "not_channel";

export function sanitizeGuidedConfig(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === null || value === undefined) {
        return false;
      }
      if (typeof value === "string") {
        return value.trim().length > 0;
      }
      return true;
    }),
  );
}

export function evaluateLocalRisk(input: {
  selectedCatalog?: IntegrationCatalogEntry;
  selectedCatalogId: string;
  configJson: string;
  status: IntegrationConnection["status"];
  enabled: boolean;
}): { items: UiRiskItem[] } {
  const items: UiRiskItem[] = [];

  if (!input.selectedCatalogId.trim()) {
    items.push({
      field: "integration.catalogId",
      level: "warning",
      hint: "Choose a catalog entry before creating a connection.",
    });
  }

  if (input.status === "connected" && !input.enabled) {
    items.push({
      field: "integration.enabled",
      level: "warning",
      hint: "Status says connected while enabled is off.",
    });
  }

  if (input.selectedCatalog?.runtimeAvailability === "blocked") {
    items.push({
      field: "integration.runtimeAvailability",
      level: "critical",
      hint: "This integration is cataloged for planning, but it is not runnable in the current runtime.",
    });
  } else if (input.selectedCatalog?.maturity === "planned") {
    items.push({
      field: "integration.maturity",
      level: "warning",
      hint: "This integration is still parity-incomplete. Expect manual setup and follow-on proof before claiming it as finished.",
    });
  }

  try {
    const parsed = JSON.parse(input.configJson) as Record<string, unknown>;
    const flattened = JSON.stringify(parsed).toLowerCase();
    if (
      flattened.includes("password") ||
      flattened.includes("apikey") ||
      flattened.includes("secret") ||
      flattened.includes("token")
    ) {
      items.push({
        field: "integration.configJson",
        level: "warning",
        hint: "Config includes secret-like keys. Prefer env-backed references when possible.",
      });
    }
    const urls = extractUrlCandidates(parsed);
    if (urls.some((url) => url.startsWith("http://") && !url.includes("127.0.0.1") && !url.includes("localhost"))) {
      items.push({
        field: "integration.configJson",
        level: "critical",
        hint: "Non-local plain HTTP URL detected in config. Use HTTPS for remote endpoints.",
      });
    }
  } catch {
    items.push({
      field: "integration.configJson",
      level: "critical",
      hint: "Config JSON is invalid and cannot be saved safely.",
    });
  }

  return { items };
}

export function extractUrlCandidates(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      out.push(trimmed.toLowerCase());
    }
    return out;
  }
  if (!value || typeof value !== "object") {
    return out;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    extractUrlCandidates(child, out);
  }
  return out;
}

export function mergeRiskItems(localItems: UiRiskItem[], remoteItems: UiRiskItem[]): UiRiskItem[] {
  const merged = new Map<string, UiRiskItem>();

  for (const item of [...localItems, ...remoteItems]) {
    const existing = merged.get(item.field);
    if (!existing) {
      merged.set(item.field, item);
      continue;
    }
    const stronger = maxRisk(existing.level, item.level);
    const hint = [existing.hint, item.hint].filter(Boolean).join(" ");
    merged.set(item.field, {
      field: item.field,
      level: stronger,
      hint: hint || undefined,
    });
  }

  return [...merged.values()];
}

export function maxRisk(a: UiRiskLevel, b: UiRiskLevel): UiRiskLevel {
  if (a === "critical" || b === "critical") {
    return "critical";
  }
  if (a === "warning" || b === "warning") {
    return "warning";
  }
  return "safe";
}

export function deriveOverallRisk(items: UiRiskItem[]): UiRiskLevel {
  if (items.some((item) => item.level === "critical")) {
    return "critical";
  }
  if (items.some((item) => item.level === "warning")) {
    return "warning";
  }
  return "safe";
}

export function formatKind(kind: IntegrationCatalogEntry["kind"]): string {
  switch (kind) {
    case "channel":
      return "Channel";
    case "model_provider":
      return "Model provider";
    case "productivity":
      return "Productivity";
    case "automation":
      return "Automation";
    case "platform":
      return "Platform";
    default:
      return kind;
  }
}

export function formatStatus(status: IntegrationConnection["status"]): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "disconnected":
      return "Disconnected";
    case "paused":
      return "Paused";
    case "error":
      return "Error";
    default:
      return status;
  }
}

export function isDiscordGatewayConnection(connection: IntegrationConnection): boolean {
  if (connection.key !== "discord") {
    return false;
  }
  return (connection.config as Record<string, unknown>).runtimeMode === "gateway";
}

export function guessDefaultChannelTarget(connection: IntegrationConnection): string {
  const config = connection.config as Record<string, unknown>;
  const candidates = [
    config.defaultChannel,
    config.defaultChannelId,
    config.defaultChatId,
    config.defaultRoomId,
    config.defaultConversationId,
    config.defaultThreadKey,
    config.defaultRecipient,
    config.defaultHandle,
    config.defaultRecipientId,
    config.defaultUserId,
    config.defaultGroupId,
    config.defaultTarget,
    config.target,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

export function requiresExplicitChannelTarget(connection: IntegrationConnection): boolean {
  return !["teams", "google-chat"].includes(connection.key);
}

export function getConnectorMetadataStringList(connector: ConnectorRecord | undefined, key: string): string[] {
  const rawValue = connector?.metadata?.[key];
  if (!Array.isArray(rawValue)) {
    return [];
  }
  return rawValue.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function getConnectorSupportedDeliveryActions(connector: ConnectorRecord | undefined): string[] {
  const channelCapabilities = connector?.metadata?.channelCapabilities;
  if (channelCapabilities && typeof channelCapabilities === "object") {
    const supportedActions = (channelCapabilities as { supportedActions?: unknown }).supportedActions;
    if (Array.isArray(supportedActions)) {
      return supportedActions.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  }
  return getConnectorMetadataStringList(connector, "supportedDeliveryActions");
}

export function getConnectorSupportedAttachmentSources(connector: ConnectorRecord | undefined): string[] {
  const channelCapabilities = connector?.metadata?.channelCapabilities;
  if (channelCapabilities && typeof channelCapabilities === "object") {
    const sources = (channelCapabilities as { supportedAttachmentSources?: unknown }).supportedAttachmentSources;
    if (Array.isArray(sources)) {
      return sources.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  }
  return getConnectorMetadataStringList(connector, "supportedAttachmentSources");
}

export function getConnectorSupportNotes(connector: ConnectorRecord | undefined): string[] {
  const channelCapabilities = connector?.metadata?.channelCapabilities;
  if (channelCapabilities && typeof channelCapabilities === "object") {
    const notes = (channelCapabilities as { supportNotes?: unknown }).supportNotes;
    if (Array.isArray(notes)) {
      return notes.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  }
  return getConnectorMetadataStringList(connector, "channelSupportNotes");
}

export function getConnectorRuntimePostureSummary(connector: ConnectorRecord | undefined): string | undefined {
  const channelCapabilities = connector?.metadata?.channelCapabilities;
  if (channelCapabilities && typeof channelCapabilities === "object") {
    const runtimePosture = (
      channelCapabilities as {
        runtimePosture?: { operatorSummary?: unknown };
      }
    ).runtimePosture;
    if (
      runtimePosture &&
      typeof runtimePosture === "object" &&
      typeof runtimePosture.operatorSummary === "string" &&
      runtimePosture.operatorSummary.trim().length > 0
    ) {
      return runtimePosture.operatorSummary;
    }
  }
  const metadata = connector?.metadata as { runtimePosture?: { operatorSummary?: unknown } } | undefined;
  if (
    metadata?.runtimePosture &&
    typeof metadata.runtimePosture === "object" &&
    typeof metadata.runtimePosture.operatorSummary === "string" &&
    metadata.runtimePosture.operatorSummary.trim().length > 0
  ) {
    return metadata.runtimePosture.operatorSummary;
  }
  return undefined;
}

export function getConnectorSetupDiagnostics(connector: ConnectorRecord | undefined): string[] {
  const channelCapabilities = connector?.metadata?.channelCapabilities;
  if (channelCapabilities && typeof channelCapabilities === "object") {
    const diagnostics = (channelCapabilities as { setupDiagnostics?: unknown }).setupDiagnostics;
    if (Array.isArray(diagnostics)) {
      return diagnostics.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  }
  return getConnectorMetadataStringList(connector, "setupDiagnostics");
}

export function connectorSupportsDeliveryAction(connector: ConnectorRecord | undefined, action: string): boolean {
  return getConnectorSupportedDeliveryActions(connector).includes(action);
}

export function connectorSetupReady(connector: ConnectorRecord | undefined): boolean {
  const channelCapabilities = connector?.metadata?.channelCapabilities;
  if (channelCapabilities && typeof channelCapabilities === "object") {
    const setupReady = (channelCapabilities as { setupReady?: unknown }).setupReady;
    if (typeof setupReady === "boolean") {
      return setupReady;
    }
  }
  const explicit = connector?.metadata?.setupReady;
  if (typeof explicit === "boolean") {
    return explicit;
  }
  return getConnectorSetupDiagnostics(connector).length === 0;
}

export function formatConnectorList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none advertised";
}

export function parseAttachmentUrlInputs(value: string): ChannelAttachmentInput[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((url) => ({ url }));
}

export function parseAttachmentIdInputs(value: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const item of value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    if (!seen.has(item)) {
      seen.add(item);
      ordered.push(item);
    }
  }
  return ordered;
}

export function dedupeUploadedAttachments(items: ChatAttachmentRecord[]): ChatAttachmentRecord[] {
  const seen = new Set<string>();
  const ordered: ChatAttachmentRecord[] = [];
  for (const item of items) {
    if (seen.has(item.attachmentId)) {
      continue;
    }
    seen.add(item.attachmentId);
    ordered.push(item);
  }
  return ordered;
}

export function renderConnectorApprovalDeliverySummary(
  connector: ConnectorRecord | undefined,
  connection: IntegrationConnection,
) {
  const mode =
    typeof connector?.metadata?.approvalDeliveryMode === "string" ? connector.metadata.approvalDeliveryMode : undefined;
  const target =
    typeof connector?.metadata?.approvalDeliveryTarget === "string"
      ? connector.metadata.approvalDeliveryTarget
      : guessDefaultChannelTarget(connection);
  const reason =
    typeof connector?.metadata?.approvalDeliveryReason === "string"
      ? connector.metadata.approvalDeliveryReason
      : undefined;
  const ready = connector?.capabilities.some((item) => item.id === "approvals" && item.enabled) ?? false;
  const supportedActions = getConnectorSupportedDeliveryActions(connector);
  const setupState = connectorSetupReady(connector) ? "setup ready" : "setup attention";

  return (
    <>
      {ready ? "ready" : "not ready"}
      <div className="table-subtext">{mode ? `${mode}${target ? ` -> ${target}` : ""}` : "no delivery mode"}</div>
      <div className="table-subtext">
        {supportedActions.length > 0 ? `actions: ${supportedActions.join(", ")}` : "actions: channel.send"}
        {" · "}
        {setupState}
      </div>
      <div className="table-subtext">{reason ?? "No approval delivery reason available."}</div>
    </>
  );
}

export function formatMaturity(maturity: IntegrationCatalogEntry["maturity"]): string {
  switch (maturity) {
    case "native":
      return "Native";
    case "plugin":
      return "Plugin";
    case "disabled":
      return "Disabled";
    case "beta":
      return "Beta";
    case "planned":
      return "Planned";
    default:
      return maturity;
  }
}

export function formatRuntimeAvailability(availability: IntegrationCatalogEntry["runtimeAvailability"]): string {
  switch (availability) {
    case "runnable":
      return "Runnable now";
    case "blocked":
      return "Blocked";
    default:
      return "Depends on catalog maturity";
  }
}

export function resolveChannelSetupPath(
  entry: IntegrationCatalogEntry,
  guidedChannelCatalogIds: Set<string>,
): ChannelSetupPath {
  if (entry.kind !== "channel") {
    return "not_channel";
  }
  if (entry.runtimeAvailability === "blocked") {
    return "blocked";
  }
  if (guidedChannelCatalogIds.has(entry.catalogId)) {
    return "guided";
  }
  return "manual";
}

export function formatChannelSetupPath(path: ChannelSetupPath): string {
  switch (path) {
    case "guided":
      return "Guided setup available";
    case "manual":
      return "Manual path only for now";
    case "blocked":
      return "Unavailable in current runtime";
    default:
      return "Not a channel";
  }
}

export function describeChannelSetupPath(path: ChannelSetupPath): string {
  switch (path) {
    case "guided":
      return "This channel already has guided setup coverage in the dedicated Channel Setup workflow. Use the simple form here for straightforward connection records or edge-case edits.";
    case "manual":
      return "This channel is runnable, but the guided channel wizard does not cover it yet. Expect a more manual, proof-heavy setup path until the rollout catches up.";
    case "blocked":
      return "This channel is still visible for planning, but GoatCitadel does not expose a runnable guided or manual path for it in the current runtime.";
    default:
      return "";
  }
}

export function getChannelSetupPathTone(path: ChannelSetupPath): "success" | "warning" | "critical" | "muted" {
  switch (path) {
    case "guided":
      return "success";
    case "manual":
      return "warning";
    case "blocked":
      return "critical";
    default:
      return "muted";
  }
}

export function describeMaturity(maturity: IntegrationCatalogEntry["maturity"]): string {
  switch (maturity) {
    case "native":
      return "Built-in and supported in this runtime.";
    case "plugin":
      return "Supported through a plugin adapter.";
    case "disabled":
      return "Known integration, currently disabled in this runtime.";
    case "beta":
      return "Available, but still stabilizing.";
    case "planned":
      return "Roadmapped. May need plugin or manual setup before use.";
    default:
      return "";
  }
}
