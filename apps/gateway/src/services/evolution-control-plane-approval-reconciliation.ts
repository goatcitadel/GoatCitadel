import { ConflictError, ServiceUnavailableError, type ChangePlanRecord } from "@goatcitadel/contracts";
import type { EvolutionControlPlaneRepositoryPort, EvolutionControlPlaneServiceDependencies } from "./evolution-control-plane-service.js";

/** Canonical parent settlement after the control plane reads a terminal refusal.
 * Apply and rollback are never invoked. Temporary inputs use their existing
 * discard owner; refusing rollback preserves the earlier effect and evidence. */
export async function settleRefusedChangePlanApproval(
  deps: ChangePlanApprovalReconciliationDependencies,
  signal: (event: string, plan: ChangePlanRecord) => Promise<void>,
  plan: ChangePlanRecord,
  disposition: "denied" | "expired",
  actorId: string,
  discardTemporaryInput: () => Promise<void>,
): Promise<ChangePlanRecord> {
  const approvalId = plan.requiredAction?.kind === "approval" ? plan.requiredAction.approvalId : undefined;
  if (plan.status !== "awaiting_approval" || !approvalId) throw new ConflictError({ message: "Change Plan is not awaiting canonical approval." });
  const rollback = plan.result?.failureCode === "rollback_approval_pending";
  const current = await deps.repository.get(plan.planId);
  if (current.revision !== plan.revision) return current;
  // Keep the target claim until the existing idempotent cleanup has succeeded.
  // An unavailable cleanup owner leaves this refusal retryable by the durable signal.
  if (!rollback) await discardTemporaryInput();
  let settled: ChangePlanRecord;
  try {
    settled = await deps.repository.transition(plan.planId, {
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
    const current = await deps.repository.get(plan.planId);
    if (current.revision === plan.revision) throw error;
    return current;
  }
  await signal(`change_plan.${settled.status}`, settled);
  return settled;
}

interface ChangePlanApprovalReconciliationDependencies {
  readonly repository: {
    get: EvolutionControlPlaneRepositoryPort["get"];
    transition: EvolutionControlPlaneRepositoryPort["transition"];
    listAwaitingApproval?: EvolutionControlPlaneRepositoryPort["listAwaitingApproval"];
  };
  readonly getApprovalDisposition?: EvolutionControlPlaneServiceDependencies["getApprovalDisposition"];
}

type SettleRefusedApproval = (plan: ChangePlanRecord, disposition: "denied" | "expired", actorId: string) => Promise<ChangePlanRecord>;

/** Bounded canonical refusal delivery. A full batch remains retryable. */
export async function reconcileChangePlanApproval(
  deps: ChangePlanApprovalReconciliationDependencies,
  id: string,
  settle: SettleRefusedApproval,
): Promise<number> {
  if (!deps.getApprovalDisposition) throw new ServiceUnavailableError("The canonical approval owner is unavailable.");
  const disposition = await deps.getApprovalDisposition(id);
  if (disposition !== "denied" && disposition !== "expired") return 0;
  if (!deps.repository.listAwaitingApproval) throw new ServiceUnavailableError("The Change Plan approval lookup is unavailable.");
  const plans = await deps.repository.listAwaitingApproval(id, 100);
  for (const plan of plans) {
    if (plan.status !== "awaiting_approval" || plan.requiredAction?.kind !== "approval" || plan.requiredAction.approvalId !== id)
      throw new ConflictError({ message: "The current Change Plan approval binding is inconsistent." });
    await settle(plan, disposition, "gateway-approval-resolution");
  }
  // The durable signal retries a full batch instead of silently losing waits
  // beyond the bounded read. Already committed transitions are not repeated.
  if (plans.length === 100) throw new ServiceUnavailableError("Another Change Plan approval reconciliation batch is required.");
  return plans.length;
}

/** Read refusal state without executing approved or pending effects. */
export async function reconcileAwaitingChangePlanApproval(
  deps: ChangePlanApprovalReconciliationDependencies,
  plan: ChangePlanRecord,
  actorId: string,
  settle: SettleRefusedApproval,
): Promise<ChangePlanRecord> {
  if (plan.requiredAction?.kind !== "approval" || !plan.requiredAction.approvalId || !deps.getApprovalDisposition) return plan;
  const disposition = await deps.getApprovalDisposition(plan.requiredAction.approvalId);
  return disposition === "denied" || disposition === "expired" ? settle(plan, disposition, actorId) : plan;
}
