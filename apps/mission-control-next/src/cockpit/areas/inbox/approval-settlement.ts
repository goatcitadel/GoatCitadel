import type { ApprovalRequest, ApprovalEffectRecord } from "@goatcitadel/contracts";
export function approvalDecisionMessage(approval: ApprovalRequest, effects: ApprovalEffectRecord[] = []): string {
  const decision = `Decision recorded: ${approval.status}. `;
  if (approval.actionOutcome === "policy_blocked") return decision + "Follow-on action is blocked by policy.";
  if (
    approval.actionOutcome === "delivery_failed" ||
    approval.followUp?.status === "failed" ||
    effects.some((effect) => effect.status === "failed")
  )
    return decision + "Follow-on work failed. Inspect the persisted outcome before retrying.";
  if (
    approval.followUp?.status === "pending" ||
    approval.followUp?.status === "queued" ||
    approval.followUp?.status === "running" ||
    effects.some((effect) => effect.status === "pending" || effect.status === "running")
  )
    return decision + "Follow-on settlement is pending.";
  if (approval.followUp?.status === "completed")
    return decision + "Approval effects settled. Linked work has its own execution outcome.";
  return decision + "Follow-on execution needs separate verification.";
}
