import type { ToolAccessEvaluateRequest, ToolInvokeRequest } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { resolveToolTrustLevel } from "./tool-security.js";

const DEFAULT_APPROVAL_TTL_MS = 15 * 60_000;
const APPROVAL_REASON_RE = /^approval:([A-Za-z0-9_-]+)$/;

export async function hasVerifiedApprovalBypass(
  request: ToolAccessEvaluateRequest | ToolInvokeRequest,
  storage: AsyncStorage,
): Promise<boolean> {
  return (await getVerifiedApprovalBypassId(request, storage)) !== undefined;
}

export async function getVerifiedApprovalBypassId(
  request: ToolAccessEvaluateRequest | ToolInvokeRequest,
  storage: AsyncStorage,
): Promise<string | undefined> {
  const approvalId = extractApprovalId(request);
  if (!approvalId) {
    return undefined;
  }
  const pendingActions = storage.pendingApprovalActions as AsyncStorage["pendingApprovalActions"] & {
    findFreshPending?: AsyncStorage["pendingApprovalActions"]["findFreshPending"];
  };
  if (typeof pendingActions.findFreshPending !== "function") {
    return undefined;
  }
  const pending = await pendingActions.findFreshPending(approvalId, DEFAULT_APPROVAL_TTL_MS);
  if (!pending || pending.actionType !== "tool.invoke" || pending.resolutionStatus !== "pending") {
    return undefined;
  }
  try {
    const approval = await storage.approvals.get(approvalId);
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
    (storedRequest.turnId ?? undefined) === ((request as Partial<ToolInvokeRequest>).turnId ?? undefined) &&
    (storedRequest.workspaceId ?? undefined) === (request.workspaceId ?? undefined) &&
    (storedRequest.taskId ?? undefined) === (request.taskId ?? undefined) &&
    (storedRequest.runId ?? undefined) === (request.runId ?? undefined) &&
    resolveToolTrustLevel(storedRequest) === resolveToolTrustLevel(request) &&
    governanceField(storedRequest, "permissionProfileId") === governanceField(request, "permissionProfileId") &&
    governanceField(storedRequest, "localOperatorOverrideId") === governanceField(request, "localOperatorOverrideId") &&
    governanceField(storedRequest, "surface") === governanceField(request, "surface") &&
    stableStringify(storedRequest.sourceAttribution ?? []) ===
      stableStringify((request as Partial<ToolInvokeRequest>).sourceAttribution ?? []) &&
    stableStringify(storedRequest.authContext ?? {}) ===
      stableStringify((request as Partial<ToolInvokeRequest>).authContext ?? {}) &&
    (storedRequest.dryRun ?? undefined) === ((request as ToolInvokeRequest).dryRun ?? undefined) &&
    (storedRequest.externalRuntime ?? undefined) === ((request as ToolInvokeRequest).externalRuntime ?? undefined) &&
    stableStringify(storedRequest.runtimeSkillApplications ?? []) ===
      stableStringify((request as Partial<ToolInvokeRequest>).runtimeSkillApplications ?? []) &&
    stableStringify(storedRequest.writePathRepair ?? {}) ===
      stableStringify((request as Partial<ToolInvokeRequest>).writePathRepair ?? {}) &&
    stableStringify(storedRequest.presentationGrounding ?? {}) ===
      stableStringify((request as Partial<ToolInvokeRequest>).presentationGrounding ?? {}) &&
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
