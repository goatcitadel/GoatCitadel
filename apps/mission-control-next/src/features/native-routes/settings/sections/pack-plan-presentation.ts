import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { PackPlanAction } from "./pack-plan-binding";

export const PACK_SETUP_WARNING =
  "Creating a setup plan does not execute it. A later explicit confirmation can register, enable or connect shared MCP servers, obtain a pinned server package, or create governed capability/runtime child plans. Existing approvals, network policy, grants and owner checks still apply.";
export function packActionDescription(plan: ChangePlanRecord, action: PackPlanAction) {
  if (action === "verify")
    return "Ask the Gateway to record current linked-owner evidence for this monitoring plan. This is a verification request, not a read-only refresh or proof of readiness.";
  if (action === "rollback")
    return "Request an owner-authored rollback review for this exact revision. No rollback is applied by this request. The next confirmation can revert recorded setup effects.";
  if (action === "cancel")
    return "Cancel this exact pending setup action. Already recorded effects and shared resources are not automatically undone.";
  if (action === "continue")
    return `Re-read the exact canonical approval and resume this ${plan.result?.failureCode === "rollback_approval_pending" ? "rollback" : "setup"} through its owner. Approval alone does not prove the effect ran.`;
  if (plan.requiredAction?.kind === "confirmation" && plan.requiredAction.purpose === "rollback")
    return "Apply the reviewed rollback through its owner. This can disable or disconnect previously configured shared resources; owner conflicts may require manual action.";
  return PACK_SETUP_WARNING + " Confirming this action authorizes the selected setup effects now.";
}
export function packChildItem(child: ChangePlanRecord): string | undefined {
  if (child.request.kind === "capability_candidate") {
    const ref = `capability_proposal:${child.request.proposalId}`;
    return child.evidenceRefs.includes(ref) ? ref : undefined;
  }
  return child.request.kind === "runtime_configuration" ? `change_plan:${child.planId}` : undefined;
}
export function packInboxUrl(item: string, workspaceId: string) {
  return `/inbox?item=${encodeURIComponent(item)}&workspaceId=${encodeURIComponent(workspaceId)}`;
}
