import type { ApprovalRequest, RuntimeLifecycleResponse } from "@goatcitadel/contracts";
import { presentApprovalOutcome, presentApprovalStatus } from "./status-vocabulary.js";
export {
  buildApprovalEvidenceModel,
  buildApprovalReviewEvidenceModel,
  type ApprovalEvidenceBlock,
  type ApprovalEvidenceModel,
  type ApprovalTargetEntry,
} from "./approval-generic-evidence.js";
export * from "./approval-purpose-evidence.js";

/** Display canonical reasons without treating legacy notes as operator intent. */
export function approvalResolutionLabel(approval: ApprovalRequest): string {
  if (isExpiredApproval(approval)) return presentApprovalOutcome("expired").label.toLowerCase();
  if (approval.status === "pending") return "pending";
  if (approval.resolutionOutcome) return presentApprovalOutcome(approval.resolutionOutcome).label.toLowerCase();
  return presentApprovalStatus(approval.status).label.toLowerCase();
}

export function findTraceMetadata(payload: unknown): { correlationId?: string; traceId?: string } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    const record = current as Record<string, unknown>;
    const correlationId = typeof record.correlationId === "string" ? record.correlationId : undefined;
    const traceId = typeof record.traceId === "string" ? record.traceId : undefined;
    if (correlationId || traceId) {
      return { correlationId, traceId };
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return null;
}

export function mergeApprovals(groups: ApprovalRequest[][]): ApprovalRequest[] {
  const byId = new Map<string, ApprovalRequest>();
  for (const items of groups) {
    for (const item of items) {
      const current = byId.get(item.approvalId);
      if (!current || Date.parse(item.createdAt) >= Date.parse(current.createdAt)) {
        byId.set(item.approvalId, item);
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function hasRecoveryLinkage(approval: ApprovalRequest): boolean {
  return Boolean(
    approval.linkage?.durableRunId ||
    approval.linkage?.proactiveRunId ||
    approval.linkage?.taskId ||
    approval.linkage?.correlationId ||
    approval.linkage?.traceId,
  );
}

export function isExpiredApproval(approval: ApprovalRequest): boolean {
  if (approval.status !== "pending" || !approval.expiresAt) {
    return false;
  }
  const expiresAtMs = Date.parse(approval.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

export function getCanonicalDurableRunId(lifecycle: RuntimeLifecycleResponse): string | null {
  return lifecycle.canonical?.runId ?? lifecycle.approval?.linkage?.durableRunId ?? null;
}

export function isBlockedDurableStatus(status: string): boolean {
  return status === "paused" || status === "waiting";
}

export function formatInferredIds(ids: string[], canonicalId?: string | null): string {
  const inferred = ids.filter((id) => id !== canonicalId);
  return inferred.length > 0 ? inferred.join(", ") : "none";
}
