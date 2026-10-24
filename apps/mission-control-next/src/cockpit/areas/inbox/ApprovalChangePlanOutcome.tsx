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

export function changePlanOutcomeLine(plan: ChangePlanRecord): string {
  const result = plan.result?.summary?.trim();
  if (plan.status === "completed" || plan.status === "applied") return result ? `Applied. ${result}` : "Applied.";
  if (plan.status === "awaiting_approval") return "Approved. The change has not been applied yet.";
  if (IN_PROGRESS.includes(plan.status)) return "Applying the change…";
  const label = `${presentChangePlanStatus(plan.status).label}.`;
  return result ? `${label} ${result}` : label;
}

/**
 * A change-plan approval has no original run: what it decides is the plan, so the settled view reports the
 * plan's own outcome ("Applied. … is now off.") instead of "No original run was found" (#496).
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
  const query = useQuery({
    queryKey: ["approval-change-plan", workspaceId, approval.approvalId, planId],
    queryFn: async () => {
      const plan = await fetchChangePlan(planId, { workspaceId });
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
  if (query.isError)
    return <p role="alert">The linked change could not be checked. {describeApiError(query.error).summary}</p>;
  if (!query.data) return <p>Linked change outcome is not yet verified.</p>;
  return (
    <p role={FAILED.includes(query.data.status) ? "alert" : "status"}>
      Linked change: {changePlanOutcomeLine(query.data)}
    </p>
  );
}
