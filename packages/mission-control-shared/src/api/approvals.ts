import type {
  ApprovalBulkResolveResult,
  ApprovalRequest,
  LocalOperatorOverrideCreateInput,
  LocalOperatorOverrideRecord,
  PermissionProfileActivationInput,
  PermissionProfileActivationRecord,
  PermissionProfileCreateInput,
  PermissionProfileRecord,
  PermissionProfileUpdateInput,
  ToolAccessEvaluateRequest,
  ToolAccessEvaluateResponse,
  ToolCatalogEntry,
  ToolGrantCreateInput,
  ToolGrantRecord,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ApprovalReplayResponse, ApprovalResolveResponse, ApprovalsResponse } from "./types.js";
import { request } from "./client-core.js";

type ToolGrantCreateRequestInput = Omit<ToolGrantCreateInput, "createdBy">;
type PermissionProfileCreateRequestInput = Omit<PermissionProfileCreateInput, "createdBy" | "scope"> & {
  scope?: Exclude<NonNullable<PermissionProfileCreateInput["scope"]>, "global">;
};
export interface ApprovalFetchOptions {
  status?: ApprovalRequest["status"];
  limit?: number;
  cursor?: string;
}

export async function fetchApprovals(
  input?: ApprovalRequest["status"] | ApprovalFetchOptions,
): Promise<ApprovalsResponse> {
  const options = typeof input === "string" ? { status: input } : (input ?? {});
  const query = new URLSearchParams();
  if (options.status) {
    query.set("status", options.status);
  }
  if (options.limit !== undefined) {
    query.set("limit", String(Math.max(1, Math.min(Math.floor(options.limit), 200))));
  }
  if (options.cursor?.trim()) {
    query.set("cursor", options.cursor.trim());
  }
  return request<ApprovalsResponse>(`/api/v1/approvals${query.size > 0 ? `?${query.toString()}` : ""}`);
}

export async function resolveApproval(
  approvalId: string,
  decision: "approve" | "reject",
): Promise<ApprovalResolveResponse> {
  return request<ApprovalResolveResponse>(`/api/v1/approvals/${approvalId}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      decision,
    }),
  });
}

export async function resolveApprovalsBulk(input: {
  decision: "approve" | "reject";
  resolutionNote?: string;
  status?: "pending";
}): Promise<ApprovalBulkResolveResult> {
  return request<ApprovalBulkResolveResult>("/api/v1/approvals/bulk-resolve", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function resolveApprovalWithRemoteToken(
  token: string,
  decision: "approve" | "reject",
): Promise<ApprovalResolveResponse> {
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
  scope?: "global" | "session" | "workspace" | "agent" | "task";
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

export async function fetchPermissionProfiles(input?: {
  includeArchived?: boolean;
  workspaceId?: string;
}): Promise<{ items: PermissionProfileRecord[] }> {
  const search = new URLSearchParams();
  if (input?.includeArchived) {
    search.set("includeArchived", "true");
  }
  if (input?.workspaceId) {
    search.set("workspaceId", input.workspaceId);
  }
  return request<{ items: PermissionProfileRecord[] }>(
    `/api/v1/tools/permission-profiles${search.size > 0 ? `?${search.toString()}` : ""}`,
  );
}

export async function fetchEffectivePermissionProfile(input?: {
  workspaceId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  surface?: "chat" | "cowork" | "code" | "tools" | "mcp" | "all";
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
}): Promise<Record<string, unknown>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value) search.set(key, value);
  }
  return request<Record<string, unknown>>(
    `/api/v1/tools/permission-profiles/effective${search.size > 0 ? `?${search.toString()}` : ""}`,
  );
}

export async function fetchActiveLocalOperatorOverrides(): Promise<{ items: LocalOperatorOverrideRecord[] }> {
  return request<{ items: LocalOperatorOverrideRecord[] }>("/api/v1/tools/local-operator-overrides");
}

export async function createPermissionProfile(
  input: PermissionProfileCreateRequestInput,
): Promise<PermissionProfileRecord> {
  return request<PermissionProfileRecord>("/api/v1/tools/permission-profiles", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updatePermissionProfile(
  profileId: string,
  input: Omit<PermissionProfileUpdateInput, "updatedBy">,
): Promise<PermissionProfileRecord> {
  return request<PermissionProfileRecord>(`/api/v1/tools/permission-profiles/${encodeURIComponent(profileId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function archivePermissionProfile(profileId: string): Promise<{ archived: boolean; profileId: string }> {
  return request<{ archived: boolean; profileId: string }>(
    `/api/v1/tools/permission-profiles/${encodeURIComponent(profileId)}/archive`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function activatePermissionProfile(
  input: Omit<PermissionProfileActivationInput, "createdBy">,
): Promise<PermissionProfileActivationRecord> {
  return request<PermissionProfileActivationRecord>("/api/v1/tools/permission-profiles/activate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createLocalOperatorOverride(
  input: Omit<LocalOperatorOverrideCreateInput, "operatorId" | "createdBy">,
): Promise<LocalOperatorOverrideRecord> {
  return request<LocalOperatorOverrideRecord>("/api/v1/tools/local-operator-overrides", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokeLocalOperatorOverride(overrideId: string): Promise<{
  revoked: boolean;
  overrideId: string;
  status?: LocalOperatorOverrideRecord["status"];
  revokedAt?: string;
  revokedBy?: string;
  override?: LocalOperatorOverrideRecord;
}> {
  return request<{
    revoked: boolean;
    overrideId: string;
    status?: LocalOperatorOverrideRecord["status"];
    revokedAt?: string;
    revokedBy?: string;
    override?: LocalOperatorOverrideRecord;
  }>(`/api/v1/tools/local-operator-overrides/${encodeURIComponent(overrideId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function createToolGrant(input: ToolGrantCreateRequestInput): Promise<ToolGrantRecord> {
  return request<ToolGrantRecord>("/api/v1/tools/grants", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokeToolGrant(
  grantId: string,
): Promise<{ revoked: boolean; grantId: string; revokedBy?: string }> {
  return request<{ revoked: boolean; grantId: string; revokedBy?: string }>(
    `/api/v1/tools/grants/${encodeURIComponent(grantId)}/revoke`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function invokeTool(input: {
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  sessionId: string;
  workspaceId?: string;
  taskId?: string;
  dryRun?: boolean;
  consentContext?: {
    source?: "ui" | "tui" | "agent";
    reason?: string;
  };
}): Promise<ToolInvokeResult> {
  return request<ToolInvokeResult>("/api/v1/tools/invoke", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
