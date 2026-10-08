import { useQuery } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { fetchDurableRun } from "@goatcitadel/mission-control-shared/api/durable";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { queryKeys } from "../../data/query-keys";
import { durableRunWorkspaceId } from "../../data/durable-run-scope";
import { recordView } from "../../data/record-view";

export function InboxApprovalOutcome({ approval, workspaceId }: { approval: ApprovalRequest; workspaceId: string }) {
  const runId = approval.linkage?.durableRunId;
  const query = useQuery({
    queryKey: [...queryKeys.runTrace(runId ?? ""), workspaceId],
    queryFn: () => fetchDurableRun(runId!),
    enabled: Boolean(runId),
    staleTime: 0,
  });
  const view = recordView(query);
  const run = view.record;
  const scope = run ? durableRunWorkspaceId(run) : null;
  return (
    <section aria-label="Follow-on execution" className="space-y-1 text-sm text-fg-secondary">
      <h4 className="font-medium text-fg">Follow-on execution</h4>
      {approval.followUp ? <p>Action status: {humanizeToken(approval.followUp.status)}</p> : null}
      {runId ? (
        query.isError || (run && (run.runId !== runId || scope !== workspaceId)) ? (
          <p role="alert">The linked run could not be verified in this workspace.</p>
        ) : run ? (
          <>
            <p>Run status: {humanizeToken(run.status)}</p>
            {view.phase === "checking" ? <p role="status">Checking for changes…</p> : null}
          </>
        ) : (
          <p role="status">Loading the linked run…</p>
        )
      ) : (
        <p>No linked run evidence is available here. Approval alone does not prove execution.</p>
      )}
    </section>
  );
}
