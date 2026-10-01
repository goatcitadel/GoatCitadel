import type {
  McpElicitationRequest,
  McpRemotePreviewResponse,
  McpServerModeManifestResponse,
  McpServerRecord,
} from "@goatcitadel/contracts";
import { formatDateTime } from "./input-format";

const INTERNAL_APPROVAL_INBOX_URL = "goatcitadel://approval-inbox";

export function isRuntimeInvokableMcpServer(server: {
  transport: string;
  url?: string;
  trustTier?: string;
  authType?: string;
  oauth?: McpServerRecord["oauth"];
  authState?: McpServerRecord["authState"];
  policy?: { allowedEnvKeys?: string[] };
}) {
  const authSupported =
    !server.authType ||
    server.authType === "none" ||
    (server.authType === "token" && (server.policy?.allowedEnvKeys ?? []).some((item) => item.trim())) ||
    (server.authType === "oauth2" &&
      Boolean(server.oauth?.authorizationUrl?.trim() && server.oauth.tokenUrl?.trim()) &&
      server.authState?.readiness === "ready");
  return (
    server.trustTier !== "quarantined" &&
    (server.transport === "stdio" ||
      server.url?.trim().toLowerCase() === INTERNAL_APPROVAL_INBOX_URL ||
      ((server.transport === "http" || server.transport === "sse") && Boolean(server.url?.trim()) && authSupported))
  );
}

export function createEmptyMcpRemotePreview(): McpRemotePreviewResponse {
  return {
    generatedAt: new Date(0).toISOString(),
    readOnly: true,
    mutationSemantics: "none",
    experimentalRemoteRecordsAllowed: false,
    runtimeSupport: "internal_approval_inbox_only",
    summary: {
      remoteServers: 0,
      remoteTemplates: 0,
      runtimeSupported: 0,
      blocked: 0,
      configuredOnly: 0,
      notCallable: 0,
      experimentalRecords: 0,
      quarantined: 0,
      needsAuth: 0,
    },
    items: [],
  };
}

export function createEmptyMcpServerModeManifest(): McpServerModeManifestResponse {
  return {
    generatedAt: new Date(0).toISOString(),
    readOnly: true,
    mutationSemantics: "none",
    status: "preview",
    protocol: "mcp",
    runtimeSupport: "not_available",
    server: {
      name: "goatcitadel",
      label: "GoatCitadel governed capability export",
      version: "1.0.0",
      transport: "stdio",
    },
    launch: {
      supported: true,
      command: "goatcitadel",
      args: ["mcp-server"],
      reason: "MCP server-mode manifest is unavailable.",
    },
    runtime: {
      callPreview: {
        supported: false,
        endpoint: "/api/v1/mcp/server-mode/call",
        requiresGatewayAuth: true,
        readOnlyOnly: true,
        requiredCallContext: ["agentId", "sessionId"],
        reason: "MCP server-mode manifest is unavailable.",
      },
      stdio: {
        supported: true,
        command: "goatcitadel",
        args: ["mcp-server"],
        requiresGatewayAuth: true,
        gatewayEndpoint: "/api/v1/mcp/server-mode/manifest",
        reason: "The stdio proxy command is available, but the manifest could not be loaded.",
      },
    },
    summary: {
      inspectableCapabilities: 0,
      gatewayCallableCapabilities: 0,
      exportedToolDescriptors: 0,
      blockedDescriptors: 0,
    },
    tools: [],
    governance: [],
    limitations: ["MCP server-mode manifest is unavailable."],
    evidence: {
      catalogScope: "callable",
      catalogSnapshot: [],
    },
  };
}

export function formatMcpRemotePreviewItem(item: McpRemotePreviewResponse["items"][number]): string {
  const blocker = item.blockers[0] ?? "No runtime blocker recorded.";
  const governance = item.governance[0] ?? "No governance note recorded.";
  const authReadiness = item.authReadiness?.replaceAll("_", " ") ?? "unknown";
  return `${item.posture.replaceAll("_", " ")} · auth ${authReadiness} · ${item.operatorNextAction} · ${blocker} · ${governance}`;
}

export function formatMcpElicitationMeta(item: McpElicitationRequest): string {
  const source = [
    item.source.serverId ? `server ${item.source.serverId}` : item.source.sourceType.replaceAll("_", " "),
    item.source.toolName ? `tool ${item.source.toolName}` : undefined,
    item.source.transport ? `transport ${item.source.transport}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const owner = [
    item.owner.workspaceId ? `workspace ${item.owner.workspaceId}` : undefined,
    item.owner.sessionId ? `session ${item.owner.sessionId}` : undefined,
    item.owner.runId ? `run ${item.owner.runId}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const redaction =
    item.prompt.redactedSecretCount + item.requestedSchema.redactedSecretCount > 0
      ? ` · ${item.prompt.redactedSecretCount + item.requestedSchema.redactedSecretCount} redacted`
      : "";
  return `${source || "gateway"} · ${owner || "operator"} · updated ${formatDateTime(item.updatedAt)}${redaction}`;
}

export function parseMcpElicitationDraft(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP elicitation accept response must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}
