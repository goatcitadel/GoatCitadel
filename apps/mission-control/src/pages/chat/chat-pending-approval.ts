import type { ChatThreadResponse } from "@goatcitadel/contracts";

export interface PendingApprovalRecord {
  approvalId: string;
  toolName?: string;
  reason?: string;
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
    toolName: next.toolName ?? current.toolName,
    reason: next.reason ?? current.reason,
  };
}
