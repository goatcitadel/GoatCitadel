import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  fetchDurableDeadLetters,
  fetchDurableRun,
  recoverDurableDeadLetter,
  retryDurableRun,
} from "@goatcitadel/mission-control-shared/api/durable";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { canRequestRunRecovery, sameRunRecoveryEvidence, type RunRecoveryEvidence } from "./run-recovery-guard";

async function readRecoveryEvidence(item: OperatorInboxItem): Promise<RunRecoveryEvidence> {
  if (!item.source.runId) throw new Error("The run ID is missing from this Inbox item.");
  const run = await fetchDurableRun(item.source.runId);
  if (item.kind !== "dead_letter") return { run };
  const letters = await fetchDurableDeadLetters(200);
  return { run, deadLetter: letters.items.find((entry) => entry.deadLetterId === item.source.deadLetterId) };
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
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["tasks", "inbox-recovery", workspaceId, item.id],
    queryFn: () => readRecoveryEvidence(item),
    enabled: Boolean(item.source.runId),
    staleTime: 0,
  });
  const scopeChanged = scopeRef.current !== workspaceId;
  const evidence = query.isFetching || query.isError ? undefined : query.data;
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
        setError("The run or dead letter changed. Refresh the current record before requesting recovery.");
        void query.refetch();
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
        `Gateway recorded the request; the run is ${result.status}. Inspect the current run to verify execution and effects.`,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.durableRuns() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runTrace(result.runId) });
    } catch (cause) {
      setReviewed(null);
      if (mutationAttempted) {
        setOutcomeUncertain(true);
        setError(
          `Recovery outcome is uncertain. Inspect the current run in Ops before taking another action. ${describeApiError(cause).summary}`,
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
        <h3 className="font-display font-semibold text-fg">Current run</h3>
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
      {query.isFetching ? (
        <p role="status" className="text-fg-muted">
          Loading the current run…
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="text-status-failed">
          {describeApiError(query.error).summary}
        </p>
      ) : null}
      {!item.source.runId ? (
        <p role="alert" className="text-status-failed">
          This Inbox item has no run ID.
        </p>
      ) : null}
      {evidence ? (
        <>
          <p className="text-fg-secondary">
            Workflow: {evidence.run.workflowKey}. Status: {evidence.run.status}. Attempts: {evidence.run.attemptCount}{" "}
            of {evidence.run.maxAttempts}.
          </p>
          {item.kind === "dead_letter" && !evidence.deadLetter ? (
            <p className="text-fg-muted">
              The dead letter was not found in the current bounded owner list. Open Ops for its current record.
            </p>
          ) : null}
          {!eligible ? (
            <p className="text-fg-muted">
              This item cannot be recovered here from the current owner record. Admitted Chat runs need a new mutation;
              other runs may need an owner review or have exhausted their retry budget.
            </p>
          ) : null}
        </>
      ) : null}
      {eligible && !scopeChanged && !completed && !outcomeUncertain ? (
        <>
          <p className="text-xs text-fg-muted">
            Recovery can rerun steps and external effects. Gateway policy and workflow checks still decide whether this
            request is allowed.
          </p>
          <Button
            size="sm"
            variant="danger"
            disabled={pending}
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
          Checking the owner record and requesting recovery…
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
          <Button size="sm" variant="danger" disabled={pending || scopeChanged} onClick={() => void requestRecovery()}>
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
