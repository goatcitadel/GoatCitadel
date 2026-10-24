import { useQuery } from "@tanstack/react-query";
import type { ApprovalRequest, ChangePlanRecord, ChangePlanStatus } from "@goatcitadel/contracts";
import { fetchChangePlan } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { presentChangePlanStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

const IN_PROGRESS: readonly ChangePlanStatus[] = ["staging", "applying", "verifying", "monitoring", "rolling_back"];
const FAILED: readonly ChangePlanStatus[] = ["failed", "rollback_failed", "manual_required"];

/** The change plan this approval decides, when its payload names one. */
export function approvalChangePlanId(approval: ApprovalRequest): string | undefined {
  const planId = approval.kind === "change_plan_effect" ? approval.payload?.planId : undefined;
  return typeof planId === "string" && planId.trim() ? planId : undefined;
}

/** How a plan ended; `decision` is the deciding approval's status, when the line sits under an approval. */
export function changePlanOutcomeLine(plan: ChangePlanRecord, decision?: ApprovalRequest["status"]): string {
  const result = plan.result?.summary?.trim();
  if (plan.status === "completed" || plan.status === "applied") return result ? `Applied. ${result}` : "Applied.";
  if (plan.status === "awaiting_approval")
    return decision === "approved"
      ? "Approved. The change has not been applied yet."
      : "The change has not been applied.";
  if (plan.status === "rolling_back") return "Rolling back the change…";
  if (IN_PROGRESS.includes(plan.status)) return "Applying the change…";
  const label = `${presentChangePlanStatus(plan.status).label}.`;
  return result ? `${label} ${result}` : label;
}

/**
 * Under the ["change-plan"] prefix, so the realtime change-plan events that re-read every plan view also re-read
 * this one: a read made before approval reconciliation applied the change must not stick on "not applied yet".
 */
export function approvalChangePlanQueryKey(approval: ApprovalRequest, workspaceId: string) {
  return ["change-plan", "approval-outcome", workspaceId, approval.approvalId] as const;
}

/**
 * A change-plan approval has no original run: what it decides is the plan, so the settled view reports the
 * plan's own outcome ("Applied. … is now off.") instead of "No original run was found" (#496). The decision line
 * above it is the announced outcome, so this text is not a live region.
 */
export function ApprovalChangePlanOutcome({
  approval,
  planId,
  workspaceId,
}: {
  approval: ApprovalRequest;
  planId: string;
  workspaceId: string;
}) {
  // A plan proposed from Chat is visible only with its conversation, which the approval's linkage carries.
  const sessionId = approval.linkage?.sessionId;
  const turnId = approval.linkage?.turnId;
  const query = useQuery({
    queryKey: [...approvalChangePlanQueryKey(approval, workspaceId), planId, sessionId, turnId],
    queryFn: async () => {
      const plan = await fetchChangePlan(planId, {
        workspaceId,
        ...(sessionId ? { sessionId } : {}),
        ...(turnId ? { turnId } : {}),
      });
      if (
        plan.planId !== planId ||
        plan.origin.workspaceId !== workspaceId ||
        !plan.approvalRefs?.includes(approval.approvalId)
      )
        throw new Error("The linked change does not match this approval.");
      return plan;
    },
    retry: false,
    refetchInterval: (current) =>
      current.state.data && IN_PROGRESS.includes(current.state.data.status) ? 2000 : false,
  });
  if (query.isError) return <p>The linked change could not be checked. {describeApiError(query.error).summary}</p>;
  if (!query.data) return <p>Linked change outcome is not yet verified.</p>;
  return (
    <p className={FAILED.includes(query.data.status) ? "text-status-failed" : undefined}>
      Linked change: {changePlanOutcomeLine(query.data, approval.status)}
    </p>
  );
}
