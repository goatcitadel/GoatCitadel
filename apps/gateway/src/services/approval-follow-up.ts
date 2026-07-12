import type { ApprovalEffectRecord, ApprovalRequest } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { deriveApprovalResolutionEffectsResult } from "./approval-resolution-effects-service.js";
import { readApprovalReplay } from "./approval-replay-reader.js";
import type { ApprovalResolveResult } from "./approval-types.js";

type ApprovalResultStorage = Pick<
  Storage,
  "approvals" | "approvalEffects" | "approvalEvents" | "pendingApprovalActions"
>;

/** Projects durable follow-up delivery state onto an approval API record. */
export function withApprovalFollowUp(approval: ApprovalRequest, effects: ApprovalEffectRecord[]): ApprovalRequest {
  return {
    ...approval,
    followUp: deriveApprovalFollowUp(effects),
  };
}

/** Re-reads effect truth after commit and projects the truthful API result. */
export function buildApprovalResolveResult(
  storage: ApprovalResultStorage,
  approvalInput: ApprovalRequest,
  effects: ApprovalEffectRecord[],
): ApprovalResolveResult {
  const resolutionEffects = deriveApprovalResolutionEffectsResult(effects);
  const wakeRunId = resolutionEffects?.approvalWaitDurableRunId;
  let approval = approvalInput;
  if (wakeRunId && approval.linkage?.durableRunId !== wakeRunId) {
    approval = storage.approvals.mergeLinkage(approval.approvalId, { durableRunId: wakeRunId });
  }
  approval = withApprovalFollowUp(approval, effects);
  return {
    approval,
    effects,
    replay: readApprovalReplay(storage, approval, effects),
    durableRunId: wakeRunId,
    resolutionEffects,
  };
}

function deriveApprovalFollowUp(effects: ApprovalEffectRecord[]): ApprovalRequest["followUp"] {
  const runtimeEffects = effects.filter(
    (effect) =>
      effect.effectKind !== "approval_observability" &&
      effect.effectKind !== "approval_resolution_signals" &&
      effect.effectKind !== "approval_wait_materialize",
  );
  if (runtimeEffects.length === 0) {
    return { status: "none" };
  }

  const ranked = [...runtimeEffects].sort(
    (left, right) => followUpStatusRank(left.status) - followUpStatusRank(right.status),
  );
  const effect = ranked[0] as ApprovalEffectRecord;
  const status = effect.status === "pending" ? "queued" : effect.status;
  return {
    status,
    effectId: effect.effectId,
    effectKind: effect.effectKind,
    targetKind: effect.targetKind,
    targetId: effect.targetId,
    reason: effect.lastError ?? readFollowUpReason(effect.result),
    updatedAt: effect.updatedAt,
    completedAt: effect.completedAt,
  };
}

function followUpStatusRank(status: ApprovalEffectRecord["status"]): number {
  switch (status) {
    case "running":
      return 0;
    case "pending":
      return 1;
    case "failed":
      return 2;
    case "skipped":
      return 3;
    case "completed":
      return 4;
  }
}

function readFollowUpReason(result: Record<string, unknown>): string | undefined {
  const reason = result.reason ?? result.outcome ?? result.detail ?? result.error;
  return typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
}
