import { ConflictError, type ChangePlanRecord } from "@goatcitadel/contracts";
import type { EvolutionControlPlaneRepositoryPort } from "./evolution-control-plane-service.js";

/** Canonical parent settlement after the control plane reads a terminal refusal.
 * Apply and rollback are never invoked. Temporary inputs use their existing
 * discard owner; refusing rollback preserves the earlier effect and evidence. */
export async function settleRefusedChangePlanApproval(
  repository: EvolutionControlPlaneRepositoryPort,
  signal: (event: string, plan: ChangePlanRecord) => Promise<void>,
  plan: ChangePlanRecord,
  disposition: "denied" | "expired",
  actorId: string,
  discardTemporaryInput: () => Promise<void>,
): Promise<ChangePlanRecord> {
  const approvalId = plan.requiredAction?.kind === "approval" ? plan.requiredAction.approvalId : undefined;
  if (plan.status !== "awaiting_approval" || !approvalId) throw new ConflictError({ message: "Change Plan is not awaiting canonical approval." });
  const rollback = plan.result?.failureCode === "rollback_approval_pending";
  const current = await repository.get(plan.planId);
  if (current.revision !== plan.revision) return current;
  // Keep the target claim until the existing idempotent cleanup has succeeded.
  // An unavailable cleanup owner leaves this refusal retryable by the durable signal.
  if (!rollback) await discardTemporaryInput();
  let settled: ChangePlanRecord;
  try {
    settled = await repository.transition(plan.planId, {
      expectedRevision: plan.revision, status: rollback ? "manual_required" : disposition === "denied" ? "cancelled" : "failed",
      internal: true, requiredAction: null, approvalRefs: [approvalId],
      result: { summary: rollback
        ? `Rollback approval is ${disposition}. The existing effect remains unchanged and needs operator review.`
        : `Approval is ${disposition}. This plan cannot apply its pending effect. Review a new plan to continue.`,
      failureCode: `${rollback ? "rollback_" : ""}approval_${disposition}` },
      eventType: `approval_${disposition}`, actorId, eventPayload: { approvalId, disposition },
    });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const current = await repository.get(plan.planId);
    if (current.revision === plan.revision) throw error;
    return current;
  }
  await signal(`change_plan.${settled.status}`, settled);
  return settled;
}
