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
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
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
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { classifyOperationFailure } from "./approval-operation-attempts";
import { callableImpactLabels, curatorRiskAsApprovalRisk, improvementEvaluationLabels } from "./inbox-vocabulary";

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

  async function decide(reviewing: { review: CuratorReviewItem; decision: Decision }) {
    if (
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
        throw new Error("The saved result did not match the reviewed proposal.");
      setCompleted(true);
      setNotice(
        reviewing.decision === "approve"
          ? "Proposal kept. It is not active yet; turning it on is a separate step."
          : "Proposal discarded.",
      );
      rereadSuperseded();
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
    } catch (cause) {
      if (mutationAttempted && classifyOperationFailure(cause) === "refused") {
        // Gateway answered and recorded nothing: the decisions stay available.
        setError(`The decision was not accepted. ${describeApiError(cause).summary}`);
      } else if (mutationAttempted) {
        setUncertain(true);
        setError(
          `Decision outcome is uncertain. Use Open Curator to check the proposal before trying again. ${describeApiError(cause).summary}`,
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
        <h3 className="font-semibold text-fg">Current improvement proposal</h3>
        <Button
          size="sm"
          disabled={query.isFetching || pending || !item.source.proposalId}
          onClick={() => {
            setError("");
            void query.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
      {!item.source.proposalId ? (
        <p role="alert" className="text-status-failed">
          This item has no candidate ID, so it can&apos;t be reviewed here. Use Open Curator to find it.
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
          The proposal is no longer in this workspace&apos;s Inbox. Use Open Curator to check its current status.
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
            Risk: {presentRiskLevel(curatorRiskAsApprovalRisk[current.risk]).label} ·{" "}
            {callableImpactLabels[current.callableImpact] ?? "Callable impact unknown"} · Sources:{" "}
            {plural(current.evidence.length, "reference")}
          </p>
          {current.latestEvaluation ? (
            <p className="text-xs text-fg-muted">
              Latest evaluation: {improvementEvaluationLabels[current.latestEvaluation.status] ?? "Status unknown"}
            </p>
          ) : null}
          {current.corruptionStatus !== "clean" ? (
            <p role="alert">This candidate is {current.corruptionStatus}; decisions are unavailable here.</p>
          ) : null}
          {!current.reviewPrecondition ? (
            <p role="status" className="text-status-waiting">
              This GoatCitadel version can&apos;t tie a decision to the version you reviewed. Update GoatCitadel before
              deciding from Inbox.
            </p>
          ) : null}
          {!completed && !uncertain && !scopeChanged ? (
            <div className="flex flex-wrap gap-2">
              {(["approve", "reject"] as const).map((decision) =>
                canDecideImprovementProposal(item, current, workspaceId, decision) ? (
                  <Button
                    key={decision}
                    size="sm"
                    variant={decision === "reject" ? "secondary" : "primary"}
                    disabled={pending || checking}
                    onClick={() => void decide({ review: current, decision })}
                  >
                    {decision === "approve" ? "Keep proposal" : "Discard proposal"}
                  </Button>
                ) : (
                  <p key={decision} className="text-xs text-fg-muted">
                    {decision === "approve" ? "Keep" : "Discard"} unavailable:{" "}
                    {current.disabledReasons[decision] ?? "Curator has not marked this action ready."}
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
      <NativeOwnerLink
        href="/library/curator"
        scope={[workspaceId, item.id]}
        className="w-fit text-sm font-medium text-accent hover:underline"
      >
        Open Curator
      </NativeOwnerLink>
    </section>
  );
}
