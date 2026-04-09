import type {
  ApprovalBulkResolveResult,
  ApprovalRequest,
  ToolAccessEvaluateRequest,
  ToolAccessEvaluateResponse,
  ToolCatalogEntry,
  ToolGrantCreateInput,
  ToolGrantRecord,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ApprovalReplayResponse, ApprovalResolveResponse, ApprovalsResponse } from "./types.js";
import { request } from "./client-core.js";

export async function fetchApprovals(status = "pending"): Promise<ApprovalsResponse> {
  return request<ApprovalsResponse>(`/api/v1/approvals?status=${encodeURIComponent(status)}`);
}

export async function resolveApproval(
  approvalId: string,
  decision: "approve" | "reject",
): Promise<ApprovalResolveResponse> {
  return request<ApprovalResolveResponse>(`/api/v1/approvals/${approvalId}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      decision,
      resolvedBy: "operator",
    }),
  });
}

export async function resolveApprovalsBulk(input: {
  decision: "approve" | "reject";
  resolvedBy?: string;
  resolutionNote?: string;
  status?: "pending";
}): Promise<ApprovalBulkResolveResult> {
  return request<ApprovalBulkResolveResult>("/api/v1/approvals/bulk-resolve", {
    method: "POST",
    body: JSON.stringify({
      ...input,
      resolvedBy: input.resolvedBy ?? "operator",
    }),
  });
}

export async function resolveApprovalWithRemoteToken(
  token: string,
  decision: "approve" | "reject",
): Promise<{ approval: ApprovalRequest; executedAction?: ToolInvokeResult }> {
  return request("/api/v1/approvals/remote-resolve", {
    method: "POST",
    body: JSON.stringify({
      token,
      decision,
    }),
  });
}

export async function fetchApprovalReplay(approvalId: string): Promise<ApprovalReplayResponse> {
  return request<ApprovalReplayResponse>(`/api/v1/approvals/${approvalId}/replay`);
}

export async function fetchToolCatalog(): Promise<{ items: ToolCatalogEntry[] }> {
  return request<{ items: ToolCatalogEntry[] }>("/api/v1/tools/catalog");
}

export async function evaluateToolAccess(input: ToolAccessEvaluateRequest): Promise<ToolAccessEvaluateResponse> {
  return request<ToolAccessEvaluateResponse>("/api/v1/tools/access/evaluate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchToolGrants(input?: {
  scope?: "global" | "session" | "agent" | "task";
  scopeRef?: string;
  limit?: number;
}): Promise<{ items: ToolGrantRecord[] }> {
  const search = new URLSearchParams();
  if (input?.scope) {
    search.set("scope", input.scope);
  }
  if (input?.scopeRef) {
    search.set("scopeRef", input.scopeRef);
  }
  search.set("limit", String(input?.limit ?? 300));
  return request<{ items: ToolGrantRecord[] }>(`/api/v1/tools/grants?${search.toString()}`);
}

export async function createToolGrant(input: ToolGrantCreateInput): Promise<ToolGrantRecord> {
  return request<ToolGrantRecord>("/api/v1/tools/grants", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokeToolGrant(grantId: string): Promise<{ revoked: boolean; grantId: string }> {
  return request<{ revoked: boolean; grantId: string }>(`/api/v1/tools/grants/${encodeURIComponent(grantId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function invokeTool(input: {
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  sessionId: string;
  taskId?: string;
  dryRun?: boolean;
  consentContext?: {
    operatorId?: string;
    source?: "ui" | "tui" | "agent";
    reason?: string;
  };
}): Promise<ToolInvokeResult> {
  return request<ToolInvokeResult>("/api/v1/tools/invoke", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
