import type { ApprovalRequest, ApprovalResolutionOutcome } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";

/** Projects the canonical resolution and approved-action outcomes recorded in approval events. */
export async function withCanonicalApprovalOutcome(
  storage: Pick<Storage, "approvalEvents">,
  approval: ApprovalRequest,
): Promise<ApprovalRequest> {
  if (approval.status === "pending") return approval;
  const events = await storage.approvalEvents.listByApprovalId(approval.approvalId);
  const event = [...events].reverse().find((item) => item.eventType === "resolved");
  const outcomes: readonly ApprovalResolutionOutcome[] = [
    "approved",
    "denied",
    "withdrawn",
    "expired",
    "policy_blocked",
    "delivery_failed",
    "unknown",
  ];
  const value = event?.payload.outcome;
  const resolutionOutcome =
    typeof value === "string" && outcomes.includes(value as ApprovalResolutionOutcome)
      ? (value as ApprovalResolutionOutcome)
      : "unknown";
  const action = [...events]
    .reverse()
    .find((item) => item.eventType === "approved_action_executed" && item.actorId === "system");
  const recordedAction = action?.payload.actionOutcome;
  const actionOutcome =
    recordedAction === "executed" || recordedAction === "policy_blocked" || recordedAction === "delivery_failed"
      ? recordedAction
      : action
        ? "unknown"
        : undefined;
  return { ...approval, resolutionOutcome, ...(actionOutcome ? { actionOutcome } : {}) };
}
