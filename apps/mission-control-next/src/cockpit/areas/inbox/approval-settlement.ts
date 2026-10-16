import { APPROVAL_EXPIRY_ACTOR_ID, type ApprovalRequest, type ApprovalEffectRecord } from "@goatcitadel/contracts";
import { presentApprovalStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { presentActor } from "./inbox-vocabulary";

/** The Gateway sweeps an approval that expired before any operator decision as a rejection by its expiry actor. */
export function approvalExpiredUnresolved(approval: ApprovalRequest): boolean {
  return approval.status === "rejected" && approval.resolvedBy === APPROVAL_EXPIRY_ACTOR_ID;
}

/** "Expired" for an expiry sweep; otherwise the shared status label ("Approved", "Denied", "Approved with edits"). */
export function approvalOutcomeLabel(approval: ApprovalRequest): string {
  return approvalExpiredUnresolved(approval) ? "Expired" : presentApprovalStatus(approval.status).label;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function decidedBy(actorId: string): string {
  const actor = presentActor(actorId);
  return `Decided by ${actor === "An operator" ? "an operator" : actor}`;
}

/** Who settled a decided record, in plain words (the actor id stays in technical details), and their note. */
export function approvalResolutionLine(approval: ApprovalRequest): string | null {
  if (approval.status === "pending") return null;
  const parts: string[] = [];
  if (approval.resolvedBy)
    parts.push(
      approvalExpiredUnresolved(approval) ? "Expired without an operator decision" : decidedBy(approval.resolvedBy),
    );
  if (approval.resolutionNote?.trim()) parts.push(approval.resolutionNote);
  return parts.length ? parts.map(sentence).join(" ") : null;
}

export function approvalDecisionMessage(approval: ApprovalRequest, effects: ApprovalEffectRecord[] = []): string {
  if (approvalExpiredUnresolved(approval)) return "Expired before an operator decision; recorded as denied.";
  const decision = `Decision recorded: ${presentApprovalStatus(approval.status).label}. `;
  if (approval.actionOutcome === "policy_blocked") return decision + "Follow-on action is blocked by policy.";
  if (
    approval.actionOutcome === "delivery_failed" ||
    approval.followUp?.status === "failed" ||
    effects.some((effect) => effect.status === "failed")
  )
    return decision + "Follow-on work failed. Check its saved outcome before retrying.";
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
