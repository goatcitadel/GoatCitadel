import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DurableDeadLetterRecord, DurableRunRecord } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  cancelDurableRun,
  fetchDurableDeadLetters,
  fetchDurableRun,
  pauseDurableRun,
  recoverDurableDeadLetter,
  resumeDurableRun,
  retryDurableRun,
} from "@goatcitadel/mission-control-shared/api/durable";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { sameDurableRecoveryEvidence } from "../../data/durable-run-recovery";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { canControlWorkRun, sameWorkRunEvidence, type WorkRunAction } from "./work-run-control-guard";

const ACTIONS: readonly { id: WorkRunAction; label: string; description: string }[] = [
  { id: "pause", label: "Pause", description: "Stops active processing and leaves the run paused." },
  { id: "resume", label: "Resume", description: "Queues a paused run to continue." },
  { id: "cancel", label: "Cancel", description: "Stops this run. Completed external effects may remain." },
  { id: "retry", label: "Retry", description: "Requests another attempt. Steps and external effects may run again." },
  {
    id: "recover",
    label: "Recover",
    description: "Requeues this dead-lettered run. Steps and external effects may run again.",
  },
];

async function applyAction(
  runId: string,
  action: WorkRunAction,
  letter?: DurableDeadLetterRecord,
): Promise<DurableRunRecord> {
  if (action === "pause") return pauseDurableRun(runId);
  if (action === "resume") return resumeDurableRun(runId);
  if (action === "cancel") return cancelDurableRun(runId);
  if (action === "retry") return retryDurableRun(runId, { reason: "operator_work_retry" });
  if (!letter) throw new Error("The current dead letter is unavailable.");
  return recoverDurableDeadLetter(letter.deadLetterId);
}

export function WorkRunControls({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const scopeRef = useRef(workspaceId);
  scopeRef.current = workspaceId;
  const locked = useRef(false);
  const [reviewed, setReviewed] = useState<{
    run: DurableRunRecord;
    action: WorkRunAction;
    deadLetter?: DurableDeadLetterRecord;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [outcomeUncertain, setOutcomeUncertain] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["tasks", "work-run-controls", runId],
    queryFn: () => fetchDurableRun(runId),
    staleTime: 0,
  });
  const run = query.isError ? undefined : query.data;
  const letterQuery = useQuery({
    queryKey: ["tasks", "work-run-dead-letter", runId],
    queryFn: () => fetchDurableDeadLetters(200),
    enabled: run?.status === "dead_lettered",
    staleTime: 0,
  });
  const matchingLetters =
    !letterQuery.isFetching && !letterQuery.isError
      ? (letterQuery.data?.items.filter((entry) => entry.runId === runId && !entry.resolvedAt) ?? [])
      : [];
  const deadLetter = matchingLetters.length === 1 ? matchingLetters[0] : undefined;
  const available = run ? ACTIONS.filter((action) => canControlWorkRun(run, action.id, workspaceId, deadLetter)) : [];
  const admittedChatNeedsNewMutation =
    run?.status === "failed" &&
    run.workflowKey === "chat.turn.execute" &&
    run.payload.version === "chat.turn.execute.v2";
  const description = ACTIONS.find((entry) => entry.id === reviewed?.action)?.description;

  async function requestAction() {
    if (!reviewed || locked.current || pending || outcomeUncertain || completed || scopeRef.current !== workspaceId)
      return;
    locked.current = true;
    setPending(true);
    setError("");
    let mutationAttempted = false;
    try {
      const latest = await fetchDurableRun(runId);
      const currentLetters =
        reviewed.action === "recover"
          ? (await fetchDurableDeadLetters(200)).items.filter((entry) => entry.runId === runId && !entry.resolvedAt)
          : [];
      const currentLetter = currentLetters.length === 1 ? currentLetters[0] : undefined;
      if (
        scopeRef.current !== workspaceId ||
        !sameWorkRunEvidence(reviewed.run, latest) ||
        !sameDurableRecoveryEvidence(
          { run: reviewed.run, deadLetter: reviewed.deadLetter },
          { run: latest, deadLetter: currentLetter },
        ) ||
        !canControlWorkRun(latest, reviewed.action, workspaceId, currentLetter)
      ) {
        setReviewed(null);
        setError(
          "The run changed or its recovery record changed. Refresh and review the current record before another action.",
        );
        void query.refetch();
        if (reviewed.action === "recover") void letterQuery.refetch();
        return;
      }
      mutationAttempted = true;
      const result = await applyAction(runId, reviewed.action, currentLetter);
      setReviewed(null);
      setCompleted(true);
      setNotice(
        `Gateway returned ${result.status} for this run. Refresh to review its current state and any follow-on effects.`,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.durableRuns() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runTrace(runId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: ["tasks", "work-run-dead-letter", runId] });
      void query.refetch();
    } catch (cause) {
      setReviewed(null);
      if (mutationAttempted) {
        setOutcomeUncertain(true);
        setError(
          `Action outcome is uncertain. Inspect the current run in Ops before another action. ${describeApiError(cause).summary}`,
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
    <section aria-label="Run controls" className="space-y-3 rounded-lg border border-line bg-raised p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-fg">Run controls</h2>
        <Button
          size="sm"
          disabled={query.isFetching || pending}
          onClick={() => {
            setReviewed(null);
            setCompleted(false);
            setError("");
            setNotice("");
            void query.refetch();
            if (run?.status === "dead_lettered") void letterQuery.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
      {query.isLoading ? (
        <p role="status" className="text-fg-muted">
          Checking the current run…
        </p>
      ) : query.isFetching ? (
        <p role="status" className="text-fg-muted">
          Checking for changes…
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="text-status-failed">
          {describeApiError(query.error).summary}
        </p>
      ) : null}
      {run ? (
        <p className="text-fg-secondary">
          {query.isFetching ? "Last known owner status" : "Current owner status"}: {run.status}. These controls are
          available only for runs scoped to the selected workspace.
        </p>
      ) : null}
      {run?.status === "dead_lettered" && letterQuery.isFetching ? (
        <p role="status" className="text-fg-muted">
          Checking the current recovery record…
        </p>
      ) : null}
      {run?.status === "dead_lettered" && letterQuery.isError ? (
        <p role="alert" className="text-status-failed">
          Recovery record unavailable: {describeApiError(letterQuery.error).summary}
        </p>
      ) : null}
      {run?.status === "dead_lettered" && !letterQuery.isFetching && !letterQuery.isError && !deadLetter ? (
        <p className="text-fg-muted">
          No unique unresolved dead letter was found in the current bounded owner list. Review recovery in Ops.
        </p>
      ) : null}
      {run &&
      available.length === 0 &&
      !(run.status === "dead_lettered" && (letterQuery.isFetching || letterQuery.isError || !deadLetter)) ? (
        <p className="text-fg-muted">
          {admittedChatNeedsNewMutation
            ? "This admitted Chat run needs a new mutation instead of manual replay."
            : "No direct control is available from this run state or workspace."}{" "}
          Inspect the owner record in Ops.
        </p>
      ) : null}
      {run && available.length > 0 && !completed && !outcomeUncertain ? (
        <div className="flex flex-wrap gap-2">
          {available.map((entry) => (
            <Button
              key={entry.id}
              size="sm"
              variant={entry.id === "cancel" || entry.id === "retry" || entry.id === "recover" ? "danger" : "secondary"}
              disabled={pending}
              onClick={() => {
                setReviewed({ run, action: entry.id, deadLetter });
                setError("");
                setNotice("");
              }}
            >
              {entry.label}
            </Button>
          ))}
        </div>
      ) : null}
      {pending ? (
        <p role="status" className="text-fg-muted">
          Checking the current run and requesting the action…
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
        title={`${ACTIONS.find((entry) => entry.id === reviewed?.action)?.label ?? "Change"} this run?`}
        description={`${description ?? "This changes the run."} Gateway will recheck policy and state.`}
      >
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={
              reviewed?.action === "cancel" || reviewed?.action === "retry" || reviewed?.action === "recover"
                ? "danger"
                : "primary"
            }
            disabled={pending || scopeRef.current !== workspaceId}
            onClick={() => void requestAction()}
          >
            Confirm {reviewed?.action ?? "action"}
          </Button>
          <Button size="sm" disabled={pending} onClick={() => setReviewed(null)}>
            {reviewed?.action === "cancel" ? "Keep running" : "Go back"}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
