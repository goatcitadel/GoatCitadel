import type { ChannelProbeReport } from "./channel-probes.js";

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
  taskId?: string;
  signal?: AbortSignal;
}

export interface McpInvokeResponse {
  ok: boolean;
  output?: Record<string, unknown>;
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
