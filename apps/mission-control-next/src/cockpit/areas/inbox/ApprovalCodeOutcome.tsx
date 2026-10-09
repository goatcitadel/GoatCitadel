import { useQuery } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { fetchCodeModeRun } from "@goatcitadel/mission-control-shared/api/capabilities";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { Button } from "../../ui/Button";
export function ApprovalCodeOutcome({ approval, workspaceId }: { approval: ApprovalRequest; workspaceId: string }) {
  const access = useProjectAccess(workspaceId),
    runId = typeof approval.payload.runId === "string" ? approval.payload.runId : undefined;
  const query = useQuery({
    queryKey: ["approvals", "code-outcome", access.identity, approval.approvalId, runId],
    queryFn: async () => {
      const run = await fetchCodeModeRun(runId!, {
        workspaceId,
        sessionId: approval.linkage?.sessionId,
        turnId: approval.linkage?.turnId,
      });
      if (
        run.runId !== runId ||
        run.approvalId !== approval.approvalId ||
        run.workspaceId !== workspaceId ||
        run.codeHash !== approval.payload.codeHash ||
        run.wrapperManifestHash !== approval.payload.wrapperManifestHash
      )
        throw new Error("Code outcome does not match the original approval and artifact binding.");
      return run;
    },
    enabled: Boolean(runId),
    retry: false,
    refetchInterval: (query) =>
      query.state.error || ["completed", "failed", "expired", "rejected"].includes(query.state.data?.status ?? "")
        ? false
        : 2000,
  });
  return (
    <section aria-label="Original code run outcome" className="grid min-w-0 gap-2 rounded border border-line p-3">
      <h4 className="font-semibold">Original code run outcome</h4>
      {query.isFetching ? <p role="status">Checking original code work…</p> : null}
      {query.error ? (
        <p role="alert">Code outcome is not currently verified. {describeApiError(query.error).summary}</p>
      ) : query.data ? (
        <>
          <p role="status">
            Code work: {query.data.status.replaceAll("_", " ")}. {query.data.error}
          </p>
          <p>Approval does not by itself confirm completion.</p>
          {query.data.stdoutPreview ? (
            <pre className="overflow-auto whitespace-pre-wrap break-all">{query.data.stdoutPreview}</pre>
          ) : null}
          {query.data.stderrPreview ? (
            <pre className="overflow-auto whitespace-pre-wrap break-all">{query.data.stderrPreview}</pre>
          ) : null}
          <TechnicalDetails label="Original code result and artifact diagnostics">
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(query.data, null, 2)}
            </pre>
          </TechnicalDetails>
        </>
      ) : (
        <p>Original code outcome is not verified.</p>
      )}
      <Button disabled={query.isFetching || !runId} onClick={() => void query.refetch()}>
        Refresh code outcome
      </Button>
    </section>
  );
}
