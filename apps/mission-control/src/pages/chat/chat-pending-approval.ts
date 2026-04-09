import type { ChatThreadResponse } from "@goatcitadel/contracts";

export interface PendingApprovalRecord {
  approvalId: string;
  kind?: string;
  toolName?: string;
  reason?: string;
  riskLevel?: "safe" | "caution" | "danger" | "nuclear";
  expiresAt?: string;
  codeHash?: string;
  wrapperManifestHash?: string;
  capabilitySnapshotId?: string;
  inspectPath?: string;
  requestedOutputIntent?: string;
  saveCandidateOnSuccess?: boolean;
  remainingCount?: number;
  affectedResources?: string[];
  codePreview?: string;
}

export function deriveThreadPendingApproval(thread: ChatThreadResponse | null): PendingApprovalRecord | null {
  if (!thread) {
    return null;
  }
  const selectedTurn =
    thread.turns.find((turn) => turn.turnId === (thread.selectedTurnId ?? thread.activeLeafTurnId)) ??
    thread.turns.at(-1) ??
    null;
  if (!selectedTurn || selectedTurn.trace.status !== "waiting_for_approval") {
    return null;
  }
  const approvalToolRun = [...selectedTurn.trace.toolRuns]
    .reverse()
    .find((toolRun) => toolRun.status === "approval_required" && toolRun.approvalId);
  if (!approvalToolRun?.approvalId) {
    return null;
  }
  return {
    approvalId: approvalToolRun.approvalId,
    kind: "tool.invoke",
    toolName: approvalToolRun.toolName,
    reason: approvalToolRun.failureGuidance ?? selectedTurn.trace.failure?.message,
  };
}

export function mergePendingApproval(
  current: PendingApprovalRecord | null,
  next: PendingApprovalRecord | null,
): PendingApprovalRecord | null {
  if (!next) {
    return current;
  }
  if (!current) {
    return next;
  }
  if (current.approvalId !== next.approvalId) {
    return next;
  }
  if (current.toolName === next.toolName && current.reason === next.reason) {
    return current;
  }
  return {
    approvalId: current.approvalId,
    kind: next.kind ?? current.kind,
    toolName: next.toolName ?? current.toolName,
    reason: next.reason ?? current.reason,
    riskLevel: next.riskLevel ?? current.riskLevel,
    expiresAt: next.expiresAt ?? current.expiresAt,
    codeHash: next.codeHash ?? current.codeHash,
    wrapperManifestHash: next.wrapperManifestHash ?? current.wrapperManifestHash,
    capabilitySnapshotId: next.capabilitySnapshotId ?? current.capabilitySnapshotId,
    inspectPath: next.inspectPath ?? current.inspectPath,
    requestedOutputIntent: next.requestedOutputIntent ?? current.requestedOutputIntent,
    saveCandidateOnSuccess: next.saveCandidateOnSuccess ?? current.saveCandidateOnSuccess,
    remainingCount: next.remainingCount ?? current.remainingCount,
    affectedResources: next.affectedResources ?? current.affectedResources,
    codePreview: next.codePreview ?? current.codePreview,
  };
}
