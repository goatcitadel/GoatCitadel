import type { ToolAccessEvaluateRequest, ToolInvokeRequest } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

const DEFAULT_APPROVAL_TTL_MS = 15 * 60_000;
const APPROVAL_REASON_RE = /^approval:([A-Za-z0-9_-]+)$/;

export function hasVerifiedApprovalBypass(
  request: ToolAccessEvaluateRequest | ToolInvokeRequest,
  storage: Storage,
): boolean {
  return getVerifiedApprovalBypassId(request, storage) !== undefined;
}

export function getVerifiedApprovalBypassId(
  request: ToolAccessEvaluateRequest | ToolInvokeRequest,
  storage: Storage,
): string | undefined {
  const approvalId = extractApprovalId(request);
  if (!approvalId) {
    return undefined;
  }
  const pending = storage.pendingApprovalActions.find(approvalId);
  if (!pending || pending.actionType !== "tool.invoke" || pending.resolutionStatus !== "pending") {
    return undefined;
  }
  if (!isPendingApprovalStillFresh(pending.createdAt, pending.expiresAt)) {
    return undefined;
  }
  try {
    const approval = storage.approvals.get(approvalId);
    if (approval.status !== "approved") {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const storedRequest = pending.request as Partial<ToolInvokeRequest>;
  return requestMatchesPendingApproval(request, storedRequest) ? approvalId : undefined;
}

function extractApprovalId(request: ToolAccessEvaluateRequest | ToolInvokeRequest): string | undefined {
  const reason = (request as ToolInvokeRequest).consentContext?.reason;
  if (typeof reason !== "string") {
    return undefined;
  }
  const match = APPROVAL_REASON_RE.exec(reason.trim());
  return match?.[1];
}

function requestMatchesPendingApproval(
  request: ToolAccessEvaluateRequest | ToolInvokeRequest,
  storedRequest: Partial<ToolInvokeRequest>,
): boolean {
  return (
    storedRequest.toolName === request.toolName &&
    storedRequest.agentId === request.agentId &&
    storedRequest.sessionId === request.sessionId &&
    (storedRequest.workspaceId ?? undefined) === (request.workspaceId ?? undefined) &&
    (storedRequest.taskId ?? undefined) === (request.taskId ?? undefined) &&
    (storedRequest.runId ?? undefined) === (request.runId ?? undefined) &&
    (storedRequest.trustLevel ?? undefined) === (request.trustLevel ?? undefined) &&
    governanceField(storedRequest, "permissionProfileId") === governanceField(request, "permissionProfileId") &&
    governanceField(storedRequest, "localOperatorOverrideId") === governanceField(request, "localOperatorOverrideId") &&
    governanceField(storedRequest, "surface") === governanceField(request, "surface") &&
    stableStringify(storedRequest.sourceAttribution ?? []) ===
      stableStringify((request as Partial<ToolInvokeRequest>).sourceAttribution ?? []) &&
    stableStringify(storedRequest.authContext ?? {}) ===
      stableStringify((request as Partial<ToolInvokeRequest>).authContext ?? {}) &&
    (storedRequest.dryRun ?? undefined) === ((request as ToolInvokeRequest).dryRun ?? undefined) &&
    (storedRequest.externalRuntime ?? undefined) === ((request as ToolInvokeRequest).externalRuntime ?? undefined) &&
    stableStringify(storedRequest.args ?? {}) === stableStringify(request.args ?? {})
  );
}

function governanceField(
  request: Partial<ToolInvokeRequest> | ToolAccessEvaluateRequest | ToolInvokeRequest,
  key: "permissionProfileId" | "localOperatorOverrideId" | "surface",
): string | undefined {
  const topLevelValue = request[key];
  if (typeof topLevelValue === "string") {
    return topLevelValue;
  }
  const contextValue = request.policyContext?.[key];
  return typeof contextValue === "string" ? contextValue : undefined;
}

function isPendingApprovalStillFresh(createdAt: string, expiresAt?: string): boolean {
  if (expiresAt) {
    const explicitExpiry = Date.parse(expiresAt);
    if (!Number.isFinite(explicitExpiry)) {
      return false;
    }
    return explicitExpiry > Date.now();
  }

  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }
  return createdAtMs + DEFAULT_APPROVAL_TTL_MS > Date.now();
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortValue((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}
