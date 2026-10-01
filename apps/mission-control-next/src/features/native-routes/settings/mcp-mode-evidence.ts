import type { McpRemotePreviewResponse, McpServerModeManifestResponse } from "@goatcitadel/contracts";
import { fetchMcpRemotePreview, fetchMcpServerModeManifest } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

export interface McpModeEvidence {
  serverMode?: McpServerModeManifestResponse;
  remotePreview?: McpRemotePreviewResponse;
  issues: string[];
}
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const counts = (value: unknown, keys: string[]) =>
  Boolean(
    value &&
    typeof value === "object" &&
    keys.every((key) => {
      const count = (value as Record<string, unknown>)[key];
      return typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
    }),
  );
const readOnly = (value: { readOnly?: unknown; mutationSemantics?: unknown; generatedAt?: string } | null) =>
  value?.readOnly === true &&
  value.mutationSemantics === "none" &&
  typeof value.generatedAt === "string" &&
  Number.isFinite(Date.parse(value.generatedAt));

function validManifest(value: McpServerModeManifestResponse) {
  return (
    readOnly(value) &&
    value.protocol === "mcp" &&
    value.status === "preview" &&
    ["stdio_proxy", "call_preview", "manifest_only", "not_available"].includes(value.runtimeSupport) &&
    value.server?.name === "goatcitadel" &&
    text(value.server.label) &&
    value.server.transport === "stdio" &&
    typeof value.launch?.supported === "boolean" &&
    typeof value.launch.reason === "string" &&
    (value.launch.command === undefined || typeof value.launch.command === "string") &&
    (value.launch.args === undefined || strings(value.launch.args)) &&
    typeof value.runtime?.stdio?.supported === "boolean" &&
    typeof value.runtime.stdio.reason === "string" &&
    typeof value.runtime?.callPreview?.supported === "boolean" &&
    value.runtime.callPreview.requiresGatewayAuth === true &&
    value.runtime.callPreview.readOnlyOnly === true &&
    value.runtime.callPreview.endpoint === "/api/v1/mcp/server-mode/call" &&
    strings(value.runtime.callPreview.requiredCallContext) &&
    value.runtime.callPreview.requiredCallContext.includes("agentId") &&
    value.runtime.callPreview.requiredCallContext.includes("sessionId") &&
    counts(value.summary, [
      "inspectableCapabilities",
      "gatewayCallableCapabilities",
      "exportedToolDescriptors",
      "blockedDescriptors",
    ]) &&
    strings(value.governance) &&
    strings(value.limitations) &&
    value.evidence?.catalogScope === "callable" &&
    Array.isArray(value.tools) &&
    value.tools.every(
      (item) =>
        item &&
        text(item.name) &&
        text(item.title) &&
        text(item.capabilityId) &&
        text(item.capabilityKind) &&
        typeof item.description === "string" &&
        typeof item.gatewayCallable === "boolean" &&
        ["call_preview", "descriptor_only", "blocked"].includes(item.serverModeState) &&
        strings(item.blockers) &&
        strings(item.governance) &&
        typeof item.annotations?.readOnlyHint === "boolean" &&
        typeof item.annotations.destructiveHint === "boolean" &&
        typeof item.annotations.openWorldHint === "boolean",
    ) &&
    new Set(value.tools.map((item) => item.name)).size === value.tools.length &&
    value.summary.exportedToolDescriptors === value.tools.length
  );
}

function validRemote(value: McpRemotePreviewResponse) {
  return (
    readOnly(value) &&
    typeof value.experimentalRemoteRecordsAllowed === "boolean" &&
    ["internal_approval_inbox_only", "remote_http_sse_bridge", "experimental_records_only", "not_available"].includes(
      value.runtimeSupport,
    ) &&
    counts(value.summary, [
      "remoteServers",
      "remoteTemplates",
      "runtimeSupported",
      "blocked",
      "configuredOnly",
      "notCallable",
      "experimentalRecords",
      "quarantined",
      "needsAuth",
    ]) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        item &&
        ["server", "template"].includes(item.source) &&
        text(item.id) &&
        text(item.label) &&
        ["http", "sse"].includes(item.transport) &&
        ["none", "token", "oauth2"].includes(item.authType) &&
        text(item.authReadiness) &&
        text(item.trustTier) &&
        text(item.posture) &&
        text(item.invocationState) &&
        typeof item.runtimeSupported === "boolean" &&
        typeof item.transportRuntimeSupported === "boolean" &&
        typeof item.operatorNextAction === "string" &&
        strings(item.blockers) &&
        strings(item.governance),
    ) &&
    new Set(value.items.map((item) => `${item.source}:${item.id}`)).size === value.items.length &&
    value.summary.remoteServers === value.items.filter((item) => item.source === "server").length &&
    value.summary.remoteTemplates === value.items.filter((item) => item.source === "template").length
  );
}

/** Independent installation projections, not a joined execution or connectivity guarantee. GET only. */
export async function readMcpModeEvidence(signal: AbortSignal): Promise<McpModeEvidence> {
  const [manifest, remote] = await Promise.allSettled([
    fetchMcpServerModeManifest(signal),
    fetchMcpRemotePreview(signal),
  ]);
  const result: McpModeEvidence = { issues: [] };
  if (manifest.status === "fulfilled" && validManifest(manifest.value)) result.serverMode = manifest.value;
  else
    result.issues.push(
      manifest.status === "rejected"
        ? `Server mode evidence unavailable: ${describeApiError(manifest.reason).summary}`
        : "Server mode evidence is incomplete or inconsistent. Refresh to inspect it.",
    );
  if (remote.status === "fulfilled" && validRemote(remote.value)) result.remotePreview = remote.value;
  else
    result.issues.push(
      remote.status === "rejected"
        ? `Remote preview unavailable: ${describeApiError(remote.reason).summary}`
        : "Remote preview is incomplete or inconsistent. Refresh to inspect it.",
    );
  return result;
}
