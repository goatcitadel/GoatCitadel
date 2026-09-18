import type { ApprovalEffectRecord, ApprovalRequest, DurableRunRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

export function isNativeExecutionApproval(approval: ApprovalRequest): boolean {
  return approval.kind === "remote_worker.native_runtime" || approval.kind === "remote_worker.native_runtime_install";
}

/** Read-only sequencing decision. Claim ownership and retry writes remain with
 * the approval-effect processor, not this parent-authority reader. */
export async function readPendingNativeApprovalParentWake(
  storage: {
    approvals: Pick<AsyncStorage["approvals"], "get">;
    approvalWaitRuns: Pick<AsyncStorage["approvalWaitRuns"], "get">;
    approvalEffects: Pick<AsyncStorage["approvalEffects"], "listByApproval">;
  },
  effect: ApprovalEffectRecord,
): Promise<{ runId: string; turnId: string } | undefined> {
  if (effect.payload.nativeRuntimeParent === undefined) return undefined;
  const value = effect.payload.nativeRuntimeParent;
  const parent = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const approval = await storage.approvals.get(effect.approvalId);
  const wait = await storage.approvalWaitRuns.get(effect.approvalId);
  if (!parent || !isNativeExecutionApproval(approval) || approval.linkage?.actionType !== approval.kind ||
      typeof parent.runId !== "string" || !parent.runId || typeof parent.turnId !== "string" || !parent.turnId ||
      parent.runId !== approval.linkage.durableRunId || parent.turnId !== approval.linkage.turnId || !approval.linkage.sessionId ||
      parent.runId === effect.targetId || wait?.runId !== effect.targetId) {
    throw new Error("Native runtime wait lost its exact parent wake binding.");
  }
  const parentWake = (await storage.approvalEffects.listByApproval(effect.approvalId)).find(candidate =>
    candidate.effectKind === "linked_chat_turn_wake" && candidate.targetKind === "chat_turn" &&
    candidate.targetId === parent.turnId && candidate.payload.runId === parent.runId);
  return parentWake?.status === "completed" ? undefined : { runId: parent.runId, turnId: parent.turnId };
}

/** Both installation and execution reviews retain their admitted parent. The
 * approval wait is a separate run; a missing parent is never recreated here. */
export async function requireNativeApprovalParent(
  deps: { getDurableRun(runId: string): Promise<DurableRunRecord> },
  approval: ApprovalRequest,
): Promise<DurableRunRecord> {
  const runId = approval.linkage?.durableRunId;
  if (!isNativeExecutionApproval(approval) || !runId?.trim() || runId !== runId.trim() || approval.linkage?.actionType !== approval.kind) {
    throw new Error("Native runtime approval requires its original execution run.");
  }
  const run = await deps.getDurableRun(runId);
  if (run.runId !== runId || run.workflowKey === "approval.wait") {
    throw new Error("Native runtime approval requires its original execution run.");
  }
  return run;
}
