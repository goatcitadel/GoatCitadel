import { APPROVAL_EXPIRY_ACTOR_ID, type ApprovalEffectRecord, type ApprovalRequest, type DurableRunRecord } from "@goatcitadel/contracts";

/** A rejected approval's own wait workflow records resolution; it cannot apply
 * the Change Plan. This does not recognize a wake of Chat or any action workflow. */
export function isKnownExpiredReviewWaitEffect({ approval, effect, reservation, run }: {
  approval: ApprovalRequest;
  effect: ApprovalEffectRecord;
  reservation?: { approvalId: string; runId: string };
  run?: Pick<DurableRunRecord, "runId" | "workflowKey" | "payload">;
}): boolean {
  if (
    approval.kind !== "change_plan_effect" || approval.status !== "rejected" || approval.resolutionOutcome !== "expired" ||
    effect.approvalId !== approval.approvalId || effect.status !== "completed" || effect.targetKind !== "durable_run" ||
    !["approval_wait_materialize", "approval_wait_wake"].includes(effect.effectKind) ||
    !reservation || reservation.approvalId !== approval.approvalId || reservation.runId !== effect.targetId ||
    approval.linkage?.durableRunId !== reservation.runId || !run || run.runId !== reservation.runId ||
    run.workflowKey !== "approval.wait" || run.payload.version !== "approval.wait.v1" ||
    run.payload.approvalId !== approval.approvalId || run.payload.approvalKind !== approval.kind
  ) return false;
  const payload = effect.payload ?? {}, result = effect.result ?? {};
  if (result.approvalId !== approval.approvalId || result.runId !== run.runId ||
      (result.targetId !== undefined && result.targetId !== run.runId)) return false;
  if (effect.effectKind === "approval_wait_materialize")
    return payload.approvalId === approval.approvalId && payload.runId === run.runId && result.materialized === true;
  const resolution = payload.payload;
  return payload.eventKey === "approval.resolved" && payload.correlationId === approval.approvalId &&
    Boolean(resolution && typeof resolution === "object" && !Array.isArray(resolution) &&
      (resolution as Record<string, unknown>).approvalId === approval.approvalId &&
      (resolution as Record<string, unknown>).status === "rejected" &&
      (resolution as Record<string, unknown>).decision === "reject" &&
      (resolution as Record<string, unknown>).resolvedBy === APPROVAL_EXPIRY_ACTOR_ID);
}
