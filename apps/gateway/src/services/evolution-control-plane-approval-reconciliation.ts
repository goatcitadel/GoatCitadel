import { ConflictError, ServiceUnavailableError, type ChangePlanRecord } from "@goatcitadel/contracts";
import type {
  EvolutionControlPlaneRepositoryPort,
  EvolutionControlPlaneServiceDependencies,
} from "./evolution-control-plane-service.js";
import {
  OPERATOR_CAPABILITIES_PLAN_KINDS,
  OPERATOR_SAVE_EVIDENCE,
} from "./evolution-control-plane-operator-approval-skip.js";

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
  if (plan.status !== "awaiting_approval" || !approvalId)
    throw new ConflictError({ message: "Change Plan is not awaiting canonical approval." });
  const rollback = plan.result?.failureCode === "rollback_approval_pending";
  const repository = deps.repository;
  const current = await repository.get(plan.planId);
  if (current.revision !== plan.revision) return current;
  // Keep the target claim until the existing idempotent cleanup has succeeded.
  // An unavailable cleanup owner leaves this refusal retryable by the durable signal.
  if (!rollback) await discardTemporaryInput();
  let settled: ChangePlanRecord;
  try {
    settled = await repository.transition(plan.planId, {
      expectedRevision: plan.revision,
      status: rollback ? "manual_required" : disposition === "denied" ? "cancelled" : "failed",
      internal: true,
      requiredAction: null,
      approvalRefs: [approvalId],
      result: {
        summary: rollback
          ? `Rollback approval is ${disposition}. The existing effect remains unchanged and needs operator review.`
          : `Approval is ${disposition}. This plan cannot apply its pending effect. Review a new plan to continue.`,
        failureCode: `${rollback ? "rollback_" : ""}approval_${disposition}`,
      },
      eventType: `approval_${disposition}`,
      actorId,
      eventPayload: { approvalId, disposition },
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

interface ChangePlanApprovalReconciliationDependencies {
  readonly repository: {
    get: EvolutionControlPlaneRepositoryPort["get"];
    transition: EvolutionControlPlaneRepositoryPort["transition"];
    listAwaitingApproval?: EvolutionControlPlaneRepositoryPort["listAwaitingApproval"];
  };
  readonly getApprovalDisposition?: EvolutionControlPlaneServiceDependencies["getApprovalDisposition"];
}

type SettleRefusedApproval = (
  plan: ChangePlanRecord,
  disposition: "denied" | "expired",
  actorId: string,
) => Promise<ChangePlanRecord>;
type ResumeApprovedApproval = (
  plan: ChangePlanRecord,
  actorId: string,
  approvalId: string,
) => Promise<ChangePlanRecord>;

/** Bounded canonical refusal delivery. A full batch remains retryable. */
export async function reconcileChangePlanApproval(
  deps: ChangePlanApprovalReconciliationDependencies,
  id: string,
  settle: SettleRefusedApproval,
  resumeApproved?: ResumeApprovedApproval,
): Promise<number> {
  if (!deps.getApprovalDisposition) throw new ServiceUnavailableError("The canonical approval owner is unavailable.");
  const disposition = await deps.getApprovalDisposition(id);
  if (disposition !== "denied" && disposition !== "expired" && disposition !== "approved") return 0;
  if (!deps.repository.listAwaitingApproval)
    throw new ServiceUnavailableError("The Change Plan approval lookup is unavailable.");
  const plans = await deps.repository.listAwaitingApproval(id, 100);
  let settledCount = 0;
  for (const plan of plans) {
    if (
      plan.status !== "awaiting_approval" ||
      plan.requiredAction?.kind !== "approval" ||
      plan.requiredAction.approvalId !== id
    )
      throw new ConflictError({ message: "The current Change Plan approval binding is inconsistent." });
    if (disposition === "approved") {
      if (!resumeApproved || !isAutoResumeOnApprovalPlan(plan)) continue;
      try {
        await resumeApproved(plan, "gateway-approval-resolution", id);
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        const current = await deps.repository.get(plan.planId);
        if (current.status === "awaiting_approval" && current.revision === plan.revision) throw error;
      }
    } else {
      await settle(plan, disposition, "gateway-approval-resolution");
    }
    settledCount += 1;
  }
  // The durable signal retries a full batch instead of silently losing waits
  // beyond the bounded read. Already committed transitions are not repeated.
  if (plans.length === 100)
    throw new ServiceUnavailableError("Another Change Plan approval reconciliation batch is required.");
  return settledCount;
}

function isLlamaCppAutoResumePlan(plan: ChangePlanRecord): boolean {
  return (
    plan.request.kind === "runtime_configuration" &&
    (plan.request.change.operation === "llama_cpp_configuration" || plan.request.change.operation === "llama_cpp_setup")
  );
}

/**
 * Plans whose approval is the operator's last word, so approving applies them. Besides llama.cpp setup, that is any
 * runtime setting the operator saved in Settings: a separate "Continue approved change" step after approving only
 * made the one decision two (#496). The same holds for a connector the operator installed from Capabilities, and a
 * plugin the operator installed or uninstalled there. A rollback approval, anything proposed from Chat, and a Gateway
 * authentication change (which still needs its credential after approval) keep their explicit continuation.
 */
export function isAutoResumeOnApprovalPlan(plan: ChangePlanRecord): boolean {
  if (isLlamaCppAutoResumePlan(plan)) return true;
  if (
    // The generic create route accepts a caller-chosen surface, so a plan with Chat linkage keeps its continuation.
    plan.origin.sessionId ||
    plan.origin.turnId ||
    plan.result?.failureCode === "rollback_approval_pending"
  )
    return false;
  if (plan.origin.surface === "capabilities") return OPERATOR_CAPABILITIES_PLAN_KINDS.has(plan.request.kind);
  return (
    plan.origin.surface === "settings" &&
    // Bound to the server-owned Settings save, not the caller-chosen surface the generic create route accepts.
    plan.evidenceRefs.includes(OPERATOR_SAVE_EVIDENCE) &&
    plan.request.kind === "runtime_configuration" &&
    plan.request.change.operation !== "gateway_auth_configuration"
  );
}

/** Recover a canonical approval decision without replaying an applied effect. */
export async function reconcileAwaitingChangePlanApproval(
  deps: ChangePlanApprovalReconciliationDependencies,
  plan: ChangePlanRecord,
  actorId: string,
  settle: SettleRefusedApproval,
  resumeApproved?: ResumeApprovedApproval,
): Promise<ChangePlanRecord> {
  if (plan.requiredAction?.kind !== "approval" || !plan.requiredAction.approvalId || !deps.getApprovalDisposition)
    return plan;
  const approvalId = plan.requiredAction.approvalId;
  const disposition = await deps.getApprovalDisposition(approvalId);
  if (disposition === "denied" || disposition === "expired") return settle(plan, disposition, actorId);
  if (
    disposition !== "approved" ||
    !resumeApproved ||
    plan.status !== "awaiting_approval" ||
    !isAutoResumeOnApprovalPlan(plan)
  )
    return plan;
  try {
    return await resumeApproved(plan, actorId, approvalId);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const current = await deps.repository.get(plan.planId);
    if (current.revision === plan.revision) throw error;
    return current;
  }
}
