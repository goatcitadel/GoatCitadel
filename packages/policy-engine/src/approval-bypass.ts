import type { ToolAccessEvaluateRequest, ToolInvokeRequest } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

const APPROVAL_REASON_RE = /^approval:([A-Za-z0-9_-]+)$/;

export function hasVerifiedApprovalBypass(
  request: ToolAccessEvaluateRequest | ToolInvokeRequest,
  storage: Storage,
): boolean {
  const approvalId = extractApprovalId(request);
  if (!approvalId) {
    return false;
  }
  const pending = storage.pendingApprovalActions.find(approvalId);
  if (!pending || pending.actionType !== "tool.invoke" || pending.resolutionStatus !== "pending") {
    return false;
  }
  const storedRequest = pending.request as Partial<ToolInvokeRequest>;
  return requestMatchesPendingApproval(request, storedRequest);
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
    storedRequest.toolName === request.toolName
    && storedRequest.agentId === request.agentId
    && storedRequest.sessionId === request.sessionId
    && (storedRequest.taskId ?? undefined) === (request.taskId ?? undefined)
    && stableStringify(storedRequest.args ?? {}) === stableStringify(request.args ?? {})
  );
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
