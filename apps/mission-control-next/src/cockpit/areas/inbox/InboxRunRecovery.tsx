import { useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  fetchDurableDeadLetter,
  fetchDurableRun,
  recoverDurableDeadLetter,
  retryDurableRun,
} from "@goatcitadel/mission-control-shared/api/durable";
import { presentRunStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../data/query-keys";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordView } from "../../data/record-view";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { presentWorkflow } from "./inbox-vocabulary";
import { classifyOperationFailure } from "./approval-operation-attempts";
import { canRequestRunRecovery, sameRunRecoveryEvidence, type RunRecoveryEvidence } from "./run-recovery-guard";
import { nullWhenMissing } from "./inbox-record-read";

async function readRecoveryEvidence(item: OperatorInboxItem): Promise<RunRecoveryEvidence> {
  if (!item.source.runId) throw new Error("The run ID is missing from this Inbox item.");
  const run = await fetchDurableRun(item.source.runId);
  if (item.kind !== "dead_letter") return { run };
  const deadLetter = item.source.deadLetterId
    ? await nullWhenMissing(fetchDurableDeadLetter(item.source.deadLetterId))
    : null;
  return { run, deadLetter: deadLetter ?? undefined };
}

export function InboxRunRecovery({ item, workspaceId }: { item: OperatorInboxItem; workspaceId: string }) {
  const queryClient = useQueryClient();
  const { activeWorkspaceId } = useUiPreferences();
  const scopeRef = useRef(activeWorkspaceId ?? "default");
  scopeRef.current = activeWorkspaceId ?? "default";
  const locked = useRef(false);
  const [reviewed, setReviewed] = useState<RunRecoveryEvidence | null>(null);
  const [pending, setPending] = useState(false);
  const [outcomeUncertain, setOutcomeUncertain] = useState(false);
  const [completed, setCompleted] = useState(false);
  // A sentence that sends the operator to the run carries its own link (IN-04), so the notice and error are nodes.
  const [notice, setNotice] = useState<ReactNode>("");
  const [error, setError] = useState<ReactNode>("");
  const openRun = (runId: string, purpose: string) => (
    <>
      <NativeOwnerLink
        href={`/work/runs/${encodeURIComponent(runId)}`}
        scope={[workspaceId, item.id, runId]}
        className="font-medium"
      >
        Open the run
      </NativeOwnerLink>{" "}
      {purpose}
    </>
  );
  const queryKey = ["tasks", "inbox-recovery", workspaceId, item.id];
  const query = useQuery({
    queryKey,
    queryFn: () => readRecoveryEvidence(item),
    enabled: Boolean(item.source.runId),
    staleTime: 0,
  });
  const scopeChanged = scopeRef.current !== workspaceId;
  const view = recordView(query);
  const checking = view.phase === "checking";
  const lastVersion = lastVersionNote(view);
  const evidence = view.record;
  // A recovered or changed run is superseded: drop it while it is read again (T15-M1).
  const rereadSuperseded = () => void queryClient.resetQueries({ queryKey, exact: true });
  const eligible = Boolean(evidence && canRequestRunRecovery(item, evidence, workspaceId));
  const label = item.kind === "dead_letter" ? "Recover run" : "Retry run";

  async function requestRecovery() {
    if (!reviewed || locked.current || pending || outcomeUncertain || completed || scopeRef.current !== workspaceId)
      return;
    locked.current = true;
    setPending(true);
    setError("");
    let mutationAttempted = false;
    try {
      const latest = await readRecoveryEvidence(item);
      if (
        scopeRef.current !== workspaceId ||
        !canRequestRunRecovery(item, latest, workspaceId) ||
        !sameRunRecoveryEvidence(reviewed, latest)
      ) {
        setReviewed(null);
        setError("The run changed. Refresh it before requesting recovery.");
        rereadSuperseded();
        return;
      }
      mutationAttempted = true;
      const result =
        item.kind === "dead_letter"
          ? await recoverDurableDeadLetter(item.source.deadLetterId!)
          : await retryDurableRun(item.source.runId!, { reason: "operator_inbox_retry" });
      setReviewed(null);
      setCompleted(true);
      setNotice(
        <>
          Recovery requested. Run status: {presentRunStatus(result.status).label}.{" "}
          {openRun(result.runId, "to check what it did.")}
        </>,
      );
      rereadSuperseded();
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.durableRuns() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runTrace(result.runId) });
    } catch (cause) {
      setReviewed(null);
      if (mutationAttempted && classifyOperationFailure(cause) === "refused") {
        // Gateway answered and recorded nothing: recovery stays available.
        setError(`Recovery was not accepted. ${describeApiError(cause).summary}`);
      } else if (mutationAttempted) {
        setOutcomeUncertain(true);
        setError(
          <>
            Recovery outcome is uncertain. {describeApiError(cause).summary}{" "}
            {openRun(item.source.runId!, "to check its status before taking another action.")}
          </>,
        );
      } else {
        setError(`Could not check the current run. ${describeApiError(cause).summary}`);
      }
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-label="Current run recovery" className="space-y-3 border-t border-line-subtle pt-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-fg">Current run</h3>
        <Button
          size="sm"
          disabled={query.isFetching || pending}
          onClick={() => {
            setReviewed(null);
            setError("");
            void query.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
      {view.phase === "loading" ? (
        <p role="status" className="text-fg-muted">
          Loading the current run…
        </p>
      ) : checking ? (
        <p role="status" className="text-fg-muted">
          {CHECKING_FOR_CHANGES}
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="text-status-failed">
          {describeApiError(query.error).summary}
        </p>
      ) : null}
      {lastVersion ? <p className="text-fg-muted">{lastVersion}</p> : null}
      {!item.source.runId ? (
        <p role="alert" className="text-status-failed">
          This Inbox item is not linked to a run.
        </p>
      ) : null}
      {evidence ? (
        <>
          <p className="text-fg-secondary">
            Workflow: {presentWorkflow(evidence.run.workflowKey)}. Status: {presentRunStatus(evidence.run.status).label}
            . Attempts: {evidence.run.attemptCount} of {evidence.run.maxAttempts}.
          </p>
          <NativeOwnerLink
            href={`/work/runs/${encodeURIComponent(evidence.run.runId)}`}
            scope={[workspaceId, item.id, evidence.run.runId]}
            className="w-fit text-sm font-medium text-accent hover:underline"
          >
            Open run
          </NativeOwnerLink>
          <TechnicalDetails label="Run identifiers">
            <p className="break-all font-mono text-xs">
              Workflow {evidence.run.workflowKey} · Run {evidence.run.runId}
              {evidence.deadLetter ? ` · Dead letter ${item.source.deadLetterId}` : ""}
            </p>
          </TechnicalDetails>
          {item.kind === "dead_letter" && !evidence.deadLetter ? (
            <p className="text-fg-muted">
              This stopped run is no longer waiting for recovery. Its current status is shown above.
            </p>
          ) : null}
          {!eligible ? (
            <p className="text-fg-muted">
              This run can&apos;t be recovered from Inbox. Chat runs are retried by sending the message again in Chat;
              other runs may have changed since this item was listed or have used all their retries.
            </p>
          ) : null}
        </>
      ) : null}
      {eligible && !scopeChanged && !completed && !outcomeUncertain ? (
        <>
          <p className="text-xs text-fg-muted">
            Recovery can rerun steps and external effects. GoatCitadel policy and workflow checks still decide whether
            this request is allowed.
          </p>
          <Button
            size="sm"
            variant="danger"
            disabled={pending || checking}
            onClick={() => {
              setReviewed(evidence!);
              setNotice("");
              setError("");
            }}
          >
            {label}
          </Button>
        </>
      ) : null}
      {scopeChanged ? (
        <p role="alert" className="text-fg-secondary">
          The selected workspace changed. Open this item again in the current Inbox.
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="text-fg-muted">
          Checking the run and requesting recovery…
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-status-done">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-status-failed">
          {error}
        </p>
      ) : null}
      <Dialog
        open={Boolean(reviewed)}
        onOpenChange={(open) => {
          if (!open && !pending) setReviewed(null);
        }}
        title={`${label} from Inbox`}
        description="This request may rerun steps or external effects. Review the current run and its prior effects before continuing."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="danger"
            disabled={pending || scopeChanged || checking}
            onClick={() => void requestRecovery()}
          >
            Confirm {label.toLowerCase()}
          </Button>
          <Button size="sm" disabled={pending} onClick={() => setReviewed(null)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
