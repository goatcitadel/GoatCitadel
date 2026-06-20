import type {
  ConnectorDiagnosticReport,
  McpInvokeResponse,
  McpElicitationRequest,
  McpElicitationResponseAction,
  McpElicitationStatus,
  McpOAuthStartResponse,
  McpRemotePreviewResponse,
  McpServerModeCallRequest,
  McpServerModeCallResponse,
  McpServerModeManifestResponse,
  McpServerRecord,
  McpServerTemplateRecord,
  McpTemplateDiscoveryResult,
  McpToolRecord,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchMcpServers(): Promise<{ items: McpServerRecord[] }> {
  return request<{ items: McpServerRecord[] }>("/api/v1/mcp/servers");
}

export async function fetchMcpTemplates(): Promise<{ items: Array<McpServerTemplateRecord & { installed: boolean }> }> {
  return request<{ items: Array<McpServerTemplateRecord & { installed: boolean }> }>("/api/v1/mcp/templates");
}

export async function fetchMcpTemplateDiscovery(): Promise<{ items: McpTemplateDiscoveryResult[] }> {
  return request<{ items: McpTemplateDiscoveryResult[] }>("/api/v1/mcp/templates/discovery");
}

export async function fetchMcpRemotePreview(): Promise<McpRemotePreviewResponse> {
  return request<McpRemotePreviewResponse>("/api/v1/mcp/remote-preview");
}

export async function fetchMcpServerModeManifest(): Promise<McpServerModeManifestResponse> {
  return request<McpServerModeManifestResponse>("/api/v1/mcp/server-mode/manifest");
}

export async function fetchMcpElicitations(input: {
  status?: McpElicitationStatus;
  serverId?: string;
  sessionId?: string;
} = {}): Promise<{ items: McpElicitationRequest[] }> {
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.serverId) params.set("serverId", input.serverId);
  if (input.sessionId) params.set("sessionId", input.sessionId);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request<{ items: McpElicitationRequest[] }>(`/api/v1/mcp/elicitations${suffix}`);
}

export async function createMcpElicitation(input: {
  prompt: string;
  requestedSchema: Record<string, unknown>;
  owner?: McpElicitationRequest["owner"];
  source?: Partial<McpElicitationRequest["source"]>;
  serverId?: string;
  toolName?: string;
  jsonRpcRequestId?: string | number;
  transport?: McpElicitationRequest["source"]["transport"];
}): Promise<McpElicitationRequest> {
  return request<McpElicitationRequest>("/api/v1/mcp/elicitations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function respondMcpElicitation(
  elicitationId: string,
  input: {
    action: McpElicitationResponseAction;
    content?: Record<string, unknown>;
    owner?: McpElicitationRequest["owner"];
  },
): Promise<McpElicitationRequest> {
  return request<McpElicitationRequest>(`/api/v1/mcp/elicitations/${encodeURIComponent(elicitationId)}/respond`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function callMcpServerModePreview(input: McpServerModeCallRequest): Promise<McpServerModeCallResponse> {
  return request<McpServerModeCallResponse>("/api/v1/mcp/server-mode/call", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createMcpServer(input: {
  label: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  authType?: "none" | "token" | "oauth2";
  oauth?: McpServerRecord["oauth"];
  enabled?: boolean;
  category?: McpServerRecord["category"];
  trustTier?: McpServerRecord["trustTier"];
  costTier?: McpServerRecord["costTier"];
  policy?: Partial<McpServerRecord["policy"]>;
  verifiedAt?: string;
}): Promise<McpServerRecord> {
  return request<McpServerRecord>("/api/v1/mcp/servers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateMcpServer(
  serverId: string,
  input: {
    label?: string;
    command?: string;
    args?: string[];
    url?: string;
    authType?: "none" | "token" | "oauth2";
    oauth?: McpServerRecord["oauth"];
    enabled?: boolean;
    category?: McpServerRecord["category"];
    trustTier?: McpServerRecord["trustTier"];
    costTier?: McpServerRecord["costTier"];
    policy?: Partial<McpServerRecord["policy"]>;
    verifiedAt?: string;
  },
): Promise<McpServerRecord> {
  return request<McpServerRecord>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function updateMcpServerPolicy(
  serverId: string,
  policy: Partial<McpServerRecord["policy"]>,
): Promise<McpServerRecord> {
  return request<McpServerRecord>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/policy`, {
    method: "PATCH",
    body: JSON.stringify(policy),
  });
}

export async function deleteMcpServer(serverId: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

export async function connectMcpServer(serverId: string): Promise<McpServerRecord> {
  return request<McpServerRecord>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/connect`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function disconnectMcpServer(serverId: string): Promise<McpServerRecord> {
  return request<McpServerRecord>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/disconnect`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function startMcpOAuth(serverId: string): Promise<McpOAuthStartResponse> {
  return request<McpOAuthStartResponse>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/oauth/start`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function completeMcpOAuth(
  serverId: string,
  input: { code: string; state?: string },
): Promise<McpServerRecord> {
  return request<McpServerRecord>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/oauth/complete`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMcpTools(serverId: string): Promise<{ items: McpToolRecord[] }> {
  return request<{ items: McpToolRecord[] }>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/tools`);
}

export async function invokeMcpTool(input: {
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
  surface?: "chat" | "cowork" | "code" | "tools" | "mcp" | "all";
  autonomousActivation?: boolean;
  estimatedCostUsd?: number;
}): Promise<McpInvokeResponse> {
  return request<McpInvokeResponse>("/api/v1/mcp/invoke", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function runMcpServerHealthCheck(serverId: string): Promise<ConnectorDiagnosticReport> {
  return request<ConnectorDiagnosticReport>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/health-check`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
