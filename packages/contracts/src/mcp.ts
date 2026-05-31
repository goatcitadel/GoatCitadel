import type { ChannelProbeReport } from "./channel-probes.js";
import type { CapabilityCatalogEntry, CapabilityKind } from "./capabilities.js";
import type { PermissionSurface, ToolPolicyActorContext } from "./policy.js";

export type McpTransport = "stdio" | "http" | "sse";
export type McpServerStatus = "disconnected" | "connecting" | "connected" | "error";
export type McpServerCategory =
  | "development"
  | "browser"
  | "automation"
  | "research"
  | "data"
  | "creative"
  | "orchestration"
  | "other";
export type McpTrustTier = "trusted" | "restricted" | "quarantined";
export type McpCostTier = "free" | "mixed" | "paid" | "unknown";

export interface McpServerPolicy {
  requireFirstToolApproval: boolean;
  redactionMode: "off" | "basic" | "strict";
  allowedToolPatterns: string[];
  blockedToolPatterns: string[];
  /** Explicit env var keys this server needs passed through (e.g. auth tokens, config). */
  allowedEnvKeys?: string[];
  notes?: string;
}

export interface McpServerRecord {
  serverId: string;
  label: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  authType: "none" | "token" | "oauth2";
  enabled: boolean;
  status: McpServerStatus;
  category: McpServerCategory;
  trustTier: McpTrustTier;
  costTier: McpCostTier;
  policy: McpServerPolicy;
  verifiedAt?: string;
  lastError?: string;
  lastConnectedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerTemplateRecord {
  templateId: string;
  label: string;
  description: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  authType: "none" | "token" | "oauth2";
  category: McpServerCategory;
  trustTier: McpTrustTier;
  costTier: McpCostTier;
  policy: McpServerPolicy;
  enabledByDefault: boolean;
}

export interface McpToolRecord {
  serverId: string;
  toolName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  enabled: boolean;
  updatedAt: string;
}

export interface McpServerCreateInput {
  label: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  authType?: "none" | "token" | "oauth2";
  enabled?: boolean;
  category?: McpServerCategory;
  trustTier?: McpTrustTier;
  costTier?: McpCostTier;
  policy?: Partial<McpServerPolicy>;
  verifiedAt?: string;
}

export interface McpServerUpdateInput {
  label?: string;
  command?: string;
  args?: string[];
  url?: string;
  authType?: "none" | "token" | "oauth2";
  enabled?: boolean;
  category?: McpServerCategory;
  trustTier?: McpTrustTier;
  costTier?: McpCostTier;
  policy?: Partial<McpServerPolicy>;
  verifiedAt?: string;
}

export interface McpOAuthStartResponse {
  authorizeUrl: string;
  state: string;
}

export interface McpInvokeRequest {
  serverId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  agentId?: string;
  sessionId?: string;
  workspaceId?: string;
  taskId?: string;
  runId?: string;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  surface?: PermissionSurface;
  policyContext?: ToolPolicyActorContext;
  consentContext?: {
    operatorId?: string;
    source?: "ui" | "tui" | "agent";
    reason?: string;
  };
  signal?: AbortSignal;
}

export type McpNormalizedContentItem =
  | { type: "text"; text: string }
  | { type: "json"; data: unknown }
  | { type: "image"; mimeType?: string; data?: string; url?: string; resourceUri?: string; name?: string }
  | { type: "resource"; uri?: string; mimeType?: string; text?: string; blob?: string; name?: string }
  | { type: "error"; text: string };

export interface McpInvokeDiagnostics {
  transport: McpTransport;
  degraded?: boolean;
  retryCount?: number;
  sanitizedError?: string;
}

export interface McpInvokeResponse {
  ok: boolean;
  output?: Record<string, unknown>;
  contentItems?: McpNormalizedContentItem[];
  diagnostics?: McpInvokeDiagnostics;
  error?: string;
  approvalRequired?: boolean;
  approvalId?: string;
  policyReason?: string;
  reasonCodes?: string[];
}

export interface McpTemplateDiscoveryResult {
  templateId: string;
  label: string;
  installed: boolean;
  readiness: "ready" | "needs_auth" | "needs_command" | "needs_url" | "unknown";
  dependencyChecks: Array<{
    key: string;
    status: "pass" | "warn" | "fail";
    message: string;
  }>;
}

export type McpRemotePreviewPosture =
  | "runtime_supported"
  | "configured_only"
  | "experimental_record_allowed"
  | "blocked";
export type McpRemotePreviewCallableState = "runtime_invokable" | "not_callable";

export interface McpRemotePreviewItem {
  source: "server" | "template";
  id: string;
  label: string;
  transport: Extract<McpTransport, "http" | "sse">;
  url?: string;
  authType: "none" | "token" | "oauth2";
  trustTier: McpTrustTier;
  status?: McpServerStatus;
  enabled?: boolean;
  installed?: boolean;
  posture: McpRemotePreviewPosture;
  callableState: McpRemotePreviewCallableState;
  createAllowed: boolean;
  runtimeSupported: boolean;
  blockers: string[];
  governance: string[];
  evidence: {
    policyNotes?: string;
    verifiedAt?: string;
    lastConnectedAt?: string;
    lastError?: string;
  };
}

export interface McpRemotePreviewResponse {
  generatedAt: string;
  readOnly: true;
  mutationSemantics: "none";
  experimentalRemoteRecordsAllowed: boolean;
  runtimeSupport: "internal_approval_inbox_only" | "experimental_records_only" | "not_available";
  summary: {
    remoteServers: number;
    remoteTemplates: number;
    runtimeSupported: number;
    blocked: number;
    configuredOnly: number;
  };
  items: McpRemotePreviewItem[];
}

export type McpServerModeStatus = "preview";
export type McpServerModeRuntimeSupport = "manifest_only" | "not_available";
export type McpServerModeToolState = "descriptor_only" | "blocked";

export interface McpServerModeToolDescriptor {
  name: string;
  title: string;
  description: string;
  capabilityId: string;
  capabilityKind: CapabilityKind;
  sourceRef?: string;
  inputSchema: Record<string, unknown>;
  gatewayCallable: boolean;
  serverModeState: McpServerModeToolState;
  blockers: string[];
  governance: string[];
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

export interface McpServerModeManifestResponse {
  generatedAt: string;
  readOnly: true;
  mutationSemantics: "none";
  status: McpServerModeStatus;
  protocol: "mcp";
  runtimeSupport: McpServerModeRuntimeSupport;
  server: {
    name: "goatcitadel";
    label: string;
    version: string;
    transport: Extract<McpTransport, "stdio">;
  };
  launch: {
    supported: false;
    command?: string;
    args?: string[];
    reason: string;
  };
  summary: {
    inspectableCapabilities: number;
    gatewayCallableCapabilities: number;
    exportedToolDescriptors: number;
    blockedDescriptors: number;
  };
  tools: McpServerModeToolDescriptor[];
  governance: string[];
  limitations: string[];
  evidence: {
    catalogScope: "callable";
    catalogSnapshot?: Pick<CapabilityCatalogEntry, "capabilityId" | "kind" | "callable">[];
  };
}

export interface ConnectorDiagnosticReport {
  connectorType: "mcp_server" | "integration_connection";
  connectorId: string;
  status: "ok" | "warn" | "error";
  checks: Array<{
    key: string;
    status: "pass" | "warn" | "fail";
    message: string;
  }>;
  recommendedNextAction?: string;
  checkedAt: string;
  probe?: ChannelProbeReport;
}
