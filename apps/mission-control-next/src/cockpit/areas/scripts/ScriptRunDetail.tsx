import { useQuery } from "@tanstack/react-query";
import { fetchCodeModeRun } from "@goatcitadel/mission-control-shared/api/capabilities";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { presentCodeModeRunStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { ScriptInventoryItem } from "@goatcitadel/contracts";
import { StatusBadge } from "../../ui/StatusBadge";
import { TimeText } from "../../ui/TimeText";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

/** Read the run through its existing scoped operator API; no execution controls live here. */
export function ScriptRunDetail({
  item,
  identity,
  current,
}: {
  item: ScriptInventoryItem;
  identity: string;
  current: () => boolean;
}) {
  const query = useQuery({
    queryKey: ["scripts-run", identity, item.workspaceId, item.runId],
    queryFn: async () => {
      const record = await fetchCodeModeRun(item.runId!, {
        workspaceId: item.workspaceId,
        sessionId: item.sessionId,
        turnId: item.turnId,
      });
      if (!current()) throw new Error("Workspace access changed. Reopen Scripts.");
      return record;
    },
  });
  const run = current() ? query.data : undefined;
  return (
    <div className="grid min-w-0 gap-3">
      <p role="status">
        {query.isPending ? "Loading run…" : query.isError ? describeApiError(query.error).summary : ""}
      </p>
      {run ? (
        <>
          <h2 className="text-base font-semibold">{item.title}</h2>
          <StatusBadge className="w-fit" status={presentCodeModeRunStatus(run.status)} />
          <p className="text-sm text-fg-secondary">
            Code Mode run. Retention labels do not change this saved execution record.
          </p>
          <TimeText prefix="Created" value={run.createdAt} />
          {run.finishedAt ? <TimeText prefix="Finished" value={run.finishedAt} /> : null}
          <TechnicalDetails label="Run details">
            <p className="break-all">Run: {run.runId}</p>
            <p className="break-all">Source hash: {run.codeArtifact.sha256}</p>
          </TechnicalDetails>
        </>
      ) : null}
    </div>
  );
}
