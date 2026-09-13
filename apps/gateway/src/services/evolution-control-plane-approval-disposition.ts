import type { ApprovalRequest } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

export async function readChangePlanApprovalDisposition(
  approvals: Pick<AsyncStorage["approvals"], "get" | "isExpiredPendingAtDatabaseNow">,
  approvalId: string,
): Promise<"approved" | "denied" | "pending" | "expired"> {
  const approval = await approvals.get(approvalId);
  const pendingExpired = approval.status === "pending" && await approvals.isExpiredPendingAtDatabaseNow(approvalId);
  return changePlanApprovalDisposition(approval, pendingExpired);
}

/** Approval expiry is a canonical rejection resolved at/after its deadline.
 * A rejection made earlier remains a refusal when inspected after expiry.
 * Approved effects retain their original decision; their mutation owner still
 * checks expiry and exact authority before any new effect. Pending expiry must
 * come from the database-clock owner, never the Gateway's wall clock. */
export function changePlanApprovalDisposition(
  approval: Pick<ApprovalRequest, "status" | "expiresAt" | "resolvedAt">,
  pendingExpiredAtDatabaseNow = false,
): "approved" | "denied" | "pending" | "expired" {
  if (approval.status === "approved") return "approved";
  const expiresAt = Date.parse(approval.expiresAt ?? "");
  if (approval.status === "rejected") {
    return Date.parse(approval.resolvedAt ?? "") >= expiresAt ? "expired" : "denied";
  }
  if (approval.status === "edited") return "denied";
  return pendingExpiredAtDatabaseNow ? "expired" : "pending";
}
