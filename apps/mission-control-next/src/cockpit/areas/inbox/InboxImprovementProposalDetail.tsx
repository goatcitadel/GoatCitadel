import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CuratorReviewItem, OperatorInboxItem, OperatorInboxResponse } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  approveImprovementCandidate,
  fetchCuratorReviewItem,
  rejectImprovementCandidate,
} from "@goatcitadel/mission-control-shared/api/improvement";
import { fetchOperatorInbox } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../data/query-keys";
import {
  CHECKING_FOR_CHANGES,
  keepRecordForSameItem,
  lastVersionNote,
  recordAnswered,
  recordView,
} from "../../data/record-view";
import { useCachedInboxItem } from "../../data/use-operator-inbox";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

type Decision = "approve" | "reject";

export function canDecideImprovementProposal(
  item: OperatorInboxItem,
  review: CuratorReviewItem | undefined,
  workspaceId: string,
  decision: Decision,
): boolean {
  const binding = review?.reviewPrecondition;
  return Boolean(
    item.kind === "improvement_proposal" &&
    item.source.workspaceId === workspaceId &&
    item.source.proposalId &&
    review?.candidate.candidateId === item.source.proposalId &&
    review.candidate.workspaceId === workspaceId &&
    review.actionStatuses[decision] === "ready" &&
    review.corruptionStatus === "clean" &&
    binding?.workspaceId === workspaceId &&
    binding.expectedStatus === review.candidate.status &&
    binding.expectedRevisionId === (review.candidate.currentRevisionId ?? null) &&
    binding.expectedRevisionId === (review.currentRevision?.revisionId ?? null) &&
    binding.expectedChangeHash === (review.currentRevision?.changeHash ?? null) &&
    (!review.currentRevision || review.currentRevision.candidateId === item.source.proposalId),
  );
}

/**
 * The review, still in this workspace's Inbox. Opening the detail checks the cached Inbox; the decision
 * re-reads the Inbox once (no `cached`) so it never acts on a superseded item.
 */
async function readCurrentReview(
  item: OperatorInboxItem,
  workspaceId: string,
  cached?: OperatorInboxResponse,
): Promise<CuratorReviewItem | null> {
  if (!item.source.proposalId) return null;
  const projection = cached ?? (await fetchOperatorInbox(workspaceId));
  if (
    projection.workspaceId !== workspaceId ||
    !projection.items.some(
      (current) =>
        current.id === item.id &&
        current.kind === item.kind &&
        current.source.workspaceId === workspaceId &&
        current.source.proposalId === item.source.proposalId,
    )
  )
    return null;
  const review = await fetchCuratorReviewItem(item.source.proposalId);
  return review.candidate.workspaceId === workspaceId && review.candidate.candidateId === item.source.proposalId
    ? review
    : null;
}

export function InboxImprovementProposalDetail({
  item,
  workspaceId,
}: {
  item: OperatorInboxItem;
  workspaceId: string;
}) {
  const { activeWorkspaceId } = useUiPreferences();
  const scopeRef = useRef(activeWorkspaceId ?? "default");
  scopeRef.current = activeWorkspaceId ?? "default";
  const locked = useRef(false);
  const queryClient = useQueryClient();
  const [reviewing, setReviewing] = useState<{ review: CuratorReviewItem; decision: Decision } | null>(null);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const cached = useCachedInboxItem(workspaceId, item.id);
  const queryKey = ["improvement", "inbox-review", workspaceId, item.source.proposalId, cached.fingerprint];
  const query = useQuery({
    queryKey,
    queryFn: () => readCurrentReview(item, workspaceId, cached.projection),
    placeholderData: keepRecordForSameItem(queryKey),
    enabled: Boolean(item.source.proposalId) && Boolean(cached.projection),
    staleTime: 0,
  });
  const scopeChanged = scopeRef.current !== workspaceId;
  const view = recordView(query);
  const checking = view.phase === "checking";
  const lastVersion = lastVersionNote(view);
  const current = view.record;
  // A decided or changed proposal is superseded: drop it while it is read again (T15-M1).
  const rereadSuperseded = () => void queryClient.resetQueries({ queryKey, exact: true });

  async function decide() {
    if (
      !reviewing ||
      !item.source.proposalId ||
      locked.current ||
      pending ||
      completed ||
      uncertain ||
      scopeRef.current !== workspaceId
    )
      return;
    locked.current = true;
    setPending(true);
    setError("");
    let mutationAttempted = false;
    try {
      const latest = await readCurrentReview(item, workspaceId);
      if (
        scopeRef.current !== workspaceId ||
        !latest ||
        !canDecideImprovementProposal(item, latest, workspaceId, reviewing.decision) ||
        JSON.stringify(latest) !== JSON.stringify(reviewing.review)
      ) {
        setReviewing(null);
        setError("The proposal or its action readiness changed. Refresh its current review before deciding.");
        rereadSuperseded();
        return;
      }
      mutationAttempted = true;
      const input = { reviewPrecondition: reviewing.review.reviewPrecondition };
      const result =
        reviewing.decision === "approve"
          ? await approveImprovementCandidate(item.source.proposalId, input)
          : await rejectImprovementCandidate(item.source.proposalId, input);
      if (
        result.action !== reviewing.decision ||
        result.status !== (reviewing.decision === "approve" ? "approved" : "rejected") ||
        result.review.candidate.candidateId !== item.source.proposalId ||
        result.review.candidate.workspaceId !== workspaceId ||
        result.review.candidate.currentRevisionId !== reviewing.review.candidate.currentRevisionId ||
        result.review.currentRevision?.changeHash !== reviewing.review.currentRevision?.changeHash ||
        result.review.candidate.status !== result.status
      )
        throw new Error("Gateway returned an unexpected proposal receipt.");
      setReviewing(null);
      setCompleted(true);
      setNotice(
        reviewing.decision === "approve"
          ? "Gateway approved the reviewed candidate. Activation is a separate governed action."
          : "Gateway rejected the reviewed candidate.",
      );
      rereadSuperseded();
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
    } catch (cause) {
      setReviewing(null);
      if (mutationAttempted) {
        setUncertain(true);
        setError(
          `Decision outcome is uncertain. Inspect the current Curator record before trying again. ${describeApiError(cause).summary}`,
        );
      } else setError(`Could not check the current proposal. ${describeApiError(cause).summary}`);
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-label="Current improvement proposal" className="space-y-3 border-t border-line-subtle pt-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display font-semibold text-fg">Current improvement proposal</h3>
        <Button
          size="sm"
          disabled={query.isFetching || pending || !item.source.proposalId}
          onClick={() => {
            setReviewing(null);
            setError("");
            void query.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
      {!item.source.proposalId ? (
        <p role="alert" className="text-status-failed">
          This item has no candidate ID. Open Curator for its current record.
        </p>
      ) : null}
      {view.phase === "loading" ? (
        <p role="status" className="text-fg-muted">
          Loading the current review…
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
      {recordAnswered(view) && !current ? (
        <p className="text-fg-muted">
          The proposal is no longer in the selected workspace Inbox. Open Curator for its current status.
        </p>
      ) : null}
      {scopeChanged ? (
        <p role="alert" className="text-fg-secondary">
          The selected workspace changed. Open this item again in the current Inbox.
        </p>
      ) : null}
      {current ? (
        <div className="space-y-2 text-fg-secondary">
          <p className="font-medium text-fg">{current.candidate.summary}</p>
          {current.observedIssue ? <p>Observed issue: {current.observedIssue}</p> : null}
          {current.proposedChange ? <p>Proposed change: {current.proposedChange}</p> : null}
          <p className="text-xs text-fg-muted">
            Risk: {current.risk} · Callable impact: {current.callableImpact.replaceAll("_", " ")} · Evidence:{" "}
            {current.evidence.length} references
          </p>
          {current.latestEvaluation ? (
            <p className="text-xs text-fg-muted">
              Latest evaluation: {current.latestEvaluation.status.replaceAll("_", " ")}
            </p>
          ) : null}
          {current.corruptionStatus !== "clean" ? (
            <p role="alert">This candidate is {current.corruptionStatus}; decisions are unavailable here.</p>
          ) : null}
          {!current.reviewPrecondition ? (
            <p role="status" className="text-status-waiting">
              This Gateway cannot bind a decision to the reviewed version. Update the Gateway before deciding from
              Inbox.
            </p>
          ) : null}
          {!completed && !uncertain && !scopeChanged ? (
            <div className="flex flex-wrap gap-2">
              {(["approve", "reject"] as const).map((decision) =>
                canDecideImprovementProposal(item, current, workspaceId, decision) ? (
                  <Button
                    key={decision}
                    size="sm"
                    variant={decision === "reject" ? "danger" : "primary"}
                    disabled={pending || checking}
                    onClick={() => setReviewing({ review: current, decision })}
                  >
                    {decision === "approve" ? "Keep proposal" : "Discard proposal"}
                  </Button>
                ) : (
                  <p key={decision} className="text-xs text-fg-muted">
                    {decision === "approve" ? "Keep" : "Discard"} unavailable:{" "}
                    {current.disabledReasons[decision] ?? "The owner has not marked this action ready."}
                  </p>
                ),
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {pending ? (
        <p role="status" className="text-fg-muted">
          Checking the current proposal and recording the decision…
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
        open={Boolean(reviewing)}
        onOpenChange={(open) => {
          if (!open && !pending) setReviewing(null);
        }}
        title={reviewing?.decision === "approve" ? "Keep improvement proposal" : "Discard improvement proposal"}
        description="The Gateway will check this workspace, status, and reviewed version before saving. Keeping a proposal does not activate it."
      >
        {reviewing ? <p className="mb-3 text-sm text-fg-secondary">{reviewing.review.candidate.summary}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={reviewing?.decision === "reject" ? "danger" : "primary"}
            disabled={pending || scopeChanged || checking}
            onClick={() => void decide()}
          >
            Confirm {reviewing?.decision === "approve" ? "keep" : "discard"}
          </Button>
          <Button size="sm" disabled={pending} onClick={() => setReviewing(null)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
