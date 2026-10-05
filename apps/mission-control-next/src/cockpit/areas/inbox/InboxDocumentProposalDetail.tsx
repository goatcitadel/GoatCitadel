import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DocumentPatchProposalRecord, OperatorInboxItem } from "@goatcitadel/contracts";
import {
  applyDocumentPatchProposal,
  listDocumentPatchProposals,
  rejectDocumentPatchProposal,
} from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchOperatorInbox } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import {
  canReviewInboxDocumentProposal,
  currentInboxDocumentProposal,
  hasCurrentInboxDocumentProposalItem,
} from "./inbox-document-proposal-guard";

async function readCurrentProposal(
  item: OperatorInboxItem,
  workspaceId: string,
): Promise<DocumentPatchProposalRecord | null> {
  if (!item.source.proposalId) return null;
  const projection = await fetchOperatorInbox(workspaceId);
  if (!hasCurrentInboxDocumentProposalItem(item, projection, workspaceId)) return null;
  const response = await listDocumentPatchProposals({ workspaceId, state: "pending" });
  const proposal = response.items.find((record) => record.proposalId === item.source.proposalId);
  return proposal ? (currentInboxDocumentProposal(item, projection, proposal, workspaceId) ?? null) : null;
}

type Decision = "apply" | "reject";

export function InboxDocumentProposalDetail({ item, workspaceId }: { item: OperatorInboxItem; workspaceId: string }) {
  const queryClient = useQueryClient();
  const { activeWorkspaceId } = useUiPreferences();
  const scopeRef = useRef(activeWorkspaceId ?? "default");
  scopeRef.current = activeWorkspaceId ?? "default";
  const locked = useRef(false);
  const [review, setReview] = useState<{ proposal: DocumentPatchProposalRecord; decision: Decision } | null>(null);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [outcomeUncertain, setOutcomeUncertain] = useState(false);
  const [result, setResult] = useState<DocumentPatchProposalRecord | null>(null);
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["document-patch-proposal", "inbox-detail", workspaceId, item.id, item.source.sessionId],
    queryFn: () => readCurrentProposal(item, workspaceId),
    enabled: Boolean(item.source.proposalId),
    staleTime: 0,
  });
  const scopeChanged = scopeRef.current !== workspaceId;
  const proposal = query.isFetching || query.isError ? undefined : query.data;
  const reviewable = canReviewInboxDocumentProposal(proposal ?? undefined);
  const canDecide = reviewable && !scopeChanged && !completed && !outcomeUncertain;

  async function decide() {
    if (
      !review ||
      !item.source.proposalId ||
      locked.current ||
      pending ||
      completed ||
      outcomeUncertain ||
      scopeRef.current !== workspaceId
    )
      return;
    locked.current = true;
    setPending(true);
    setError("");
    let mutationAttempted = false;
    try {
      const latest = await readCurrentProposal(item, workspaceId);
      if (
        scopeRef.current !== workspaceId ||
        !canReviewInboxDocumentProposal(latest ?? undefined) ||
        JSON.stringify(latest) !== JSON.stringify(review.proposal)
      ) {
        setReview(null);
        setError("The document proposal changed or left the pending queue. Refresh its current diff before deciding.");
        void query.refetch();
        return;
      }
      mutationAttempted = true;
      const response =
        review.decision === "apply"
          ? await applyDocumentPatchProposal(item.source.proposalId, workspaceId)
          : await rejectDocumentPatchProposal(item.source.proposalId, workspaceId);
      const updated = response.item;
      if (
        !updated ||
        updated.proposalId !== review.proposal.proposalId ||
        updated.workspaceId !== workspaceId ||
        updated.state !== (review.decision === "apply" ? "applied" : "rejected") ||
        updated.targetKind !== review.proposal.targetKind ||
        updated.targetId !== review.proposal.targetId ||
        updated.baseRevision !== review.proposal.baseRevision ||
        updated.baseContentHash !== review.proposal.baseContentHash ||
        updated.proposedContent !== review.proposal.proposedContent ||
        updated.derivedDiff !== review.proposal.derivedDiff ||
        (review.decision === "apply" && (!updated.appliedTargetId || !updated.appliedContentHash))
      ) {
        throw new Error("Gateway returned an unexpected document-proposal receipt.");
      }
      setReview(null);
      setResult(updated);
      setCompleted(true);
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
    } catch (cause) {
      setReview(null);
      if (mutationAttempted) {
        setOutcomeUncertain(true);
        setError(
          `Document decision outcome is uncertain. Inspect the current proposal in its owner before trying again. ${describeApiError(cause).summary}`,
        );
      } else {
        setError(`Could not check the current document proposal. ${describeApiError(cause).summary}`);
      }
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-label="Current document proposal" className="space-y-3 border-t border-line-subtle pt-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display font-semibold text-fg">Current document proposal</h3>
        <Button
          size="sm"
          disabled={query.isFetching || pending || !item.source.proposalId}
          onClick={() => {
            setReview(null);
            setError("");
            void query.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
      {!item.source.proposalId ? (
        <p role="alert" className="text-status-failed">
          This Inbox item has no proposal ID. Open its owner to review it.
        </p>
      ) : null}
      {query.isFetching ? (
        <p role="status" className="text-fg-muted">
          Loading the current proposal and diff…
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="text-status-failed">
          {describeApiError(query.error).summary}
        </p>
      ) : null}
      {!query.isFetching && !query.isError && !proposal ? (
        <p className="text-fg-muted">
          This proposal was not found in the current bounded pending list for this workspace. Open its owner for the
          latest status.
        </p>
      ) : null}
      {scopeChanged ? (
        <p role="alert" className="text-fg-secondary">
          The selected workspace changed. Open this item again in the current Inbox.
        </p>
      ) : null}
      {proposal ? (
        <>
          <p className="text-fg-secondary">
            {proposal.authorKind === "assistant" ? "Assistant" : "Operator"} proposed a full replacement of this{" "}
            {proposal.targetKind === "personal_note" ? "note" : "generated artifact"}.
          </p>
          <p className="break-words text-xs text-fg-muted">
            Target: {proposal.targetId} · State: {proposal.state}
            {proposal.baseRevision ? ` · Base revision ${proposal.baseRevision}` : " · Base content hash recorded"}
          </p>
          <div className="space-y-2 rounded-md border border-line bg-sunken p-3">
            <h4 className="font-medium text-fg">Server-derived replacement diff</h4>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-fg-secondary">
              {reviewable ? proposal.derivedDiff : proposal.derivedDiff.slice(0, 4_000)}
            </pre>
          </div>
          {!reviewable ? (
            <p className="text-fg-secondary">
              This diff is empty or too large for bounded Inbox review. Open its owning document flow to inspect it; no
              decision is available here.
            </p>
          ) : null}
          {canDecide ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="danger"
                disabled={pending}
                onClick={() => setReview({ proposal, decision: "apply" })}
              >
                Review apply
              </Button>
              <Button size="sm" disabled={pending} onClick={() => setReview({ proposal, decision: "reject" })}>
                Review rejection
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {pending ? (
        <p role="status" className="text-fg-muted">
          Checking the current diff and recording the document decision…
        </p>
      ) : null}
      {result ? (
        <p role="status" className="text-fg-secondary">
          Gateway recorded this document proposal as {result.state}. Open its owner to inspect the current document
          version and evidence.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-status-failed">
          {error}
        </p>
      ) : null}
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open && !pending) setReview(null);
        }}
        title={review?.decision === "apply" ? "Apply document patch" : "Reject document patch"}
        description={
          review?.decision === "apply"
            ? "This replaces the reviewed note body or creates a new artifact version. The Gateway checks the target base before applying."
            : "This rejects the reviewed proposal without changing the target document."
        }
      >
        {review ? (
          <div className="mb-3 space-y-2 text-sm text-fg-secondary">
            <p className="break-words">Target: {review.proposal.targetId}</p>
            <p>
              Author: {review.proposal.authorKind} · Proposal: {review.proposal.proposalId}
            </p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={review?.decision === "apply" ? "danger" : "primary"}
            disabled={pending || scopeChanged}
            onClick={() => void decide()}
          >
            Confirm {review?.decision === "apply" ? "apply" : "rejection"}
          </Button>
          <Button size="sm" disabled={pending} onClick={() => setReview(null)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
