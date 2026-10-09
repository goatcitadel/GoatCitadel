import { useQuery } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { readApprovalFollowOn } from "./approval-follow-on";
import { approvalDecisionMessage } from "./approval-settlement";
import { Button } from "../../ui/Button";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

export function ApprovalSettlement({ approval, workspaceId }: { approval: ApprovalRequest; workspaceId: string }) {
  const access = useProjectAccess(workspaceId);
  const query = useQuery({
    queryKey: ["approval-settlement", workspaceId, approval.approvalId, access.identity],
    queryFn: () => readApprovalFollowOn(approval, workspaceId, access.current),
    retry: false,
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const data = query.state.data;
      return data?.replay.effects.some((effect) => effect.status === "pending" || effect.status === "running") ||
        [data?.run, data?.wait].some(
          (run) => run && !["completed", "failed", "cancelled", "dead_lettered"].includes(run.status),
        )
        ? 2000
        : false;
    },
  });
  const state = query.data;
  const run = state?.run;
  return (
    <section aria-label="Decision and follow-on work" className="space-y-2 rounded border border-line p-3">
      <p role="status">{approvalDecisionMessage(state?.replay.approval ?? approval, state?.replay.effects)}</p>
      {state ? (
        <details>
          <summary>Decision history and replay</summary>
          <ol className="space-y-2 pt-2">
            {state.replay.events.map((event) => (
              <li key={event.eventId}>
                {event.eventType.replaceAll("_", " ")} · {event.timestamp}
              </li>
            ))}
          </ol>
          {state.replay.effects.map((effect) => (
            <p key={effect.effectId}>Follow-on effect: {effect.status}</p>
          ))}
        </details>
      ) : null}
      {state?.replay.approval.followUp?.reason ? (
        <TechnicalDetails>
          <p>Wake reason: {state.replay.approval.followUp.reason}</p>
        </TechnicalDetails>
      ) : null}
      {query.isError ? (
        <p role="alert">
          Decision retained; follow-on refresh unavailable. {describeApiError(query.error).summary} Retained outcomes
          may be stale.
        </p>
      ) : null}
      {query.isFetching ? <p role="status">Checking canonical follow-on work…</p> : null}
      {state?.wait ? (
        <p>Approval wait settlement: {state.wait.status}. This records approval bookkeeping, not original execution.</p>
      ) : null}
      {run ? (
        <p role={run.status === "failed" || run.status === "dead_lettered" ? "alert" : "status"}>
          Original linked work: {run.status === "running" ? "resumed" : run.status}. {run.lastError}
        </p>
      ) : state ? (
        <p>No original durable execution was returned. Approval settlement is separate from execution.</p>
      ) : (
        <p>Original linked work outcome is not yet verified.</p>
      )}
      <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
        Refresh follow-on work
      </Button>
      <div className="pt-3">
        <ClassicOwnerLink
          href={`/ops/approvals?approvalId=${encodeURIComponent(approval.approvalId)}&shell=classic`}
          scope={JSON.stringify([access.identity, approval.approvalId])}
          label="Inspect decision and execution record"
        />
      </div>
    </section>
  );
}
