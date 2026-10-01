import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OperatorInboxItem, TraceMemoryCandidateRecord } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  fetchTraceMemoryCandidates,
  promoteTraceMemoryCandidate,
  rejectTraceMemoryCandidate,
} from "@goatcitadel/mission-control-shared/api/memory";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { canResolveInboxMemoryProposal } from "./memory-proposal-guard";

async function readCandidate(workspaceId: string, candidateId: string): Promise<TraceMemoryCandidateRecord | undefined> {
  const response = await fetchTraceMemoryCandidates({ workspaceId, status: "proposed", limit: 500 });
  return response.items.find((candidate) => candidate.candidateId === candidateId);
}

export function InboxMemoryProposalDetail({ item, workspaceId }: { item: OperatorInboxItem; workspaceId: string }) {
  const candidateId = item.source.proposalId;
  const queryClient = useQueryClient();
  const { activeWorkspaceId } = useUiPreferences();
  const scopeRef = useRef(activeWorkspaceId ?? "default");
  scopeRef.current = activeWorkspaceId ?? "default";
  const locked = useRef(false);
  const [review, setReview] = useState<{ candidate: TraceMemoryCandidateRecord; action: "promote" | "reject" } | null>(null);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [outcomeUncertain, setOutcomeUncertain] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["memory", "inbox-proposal", workspaceId, candidateId],
    queryFn: () => readCandidate(workspaceId, candidateId!),
    enabled: Boolean(candidateId),
    staleTime: 0,
  });
  const scopeChanged = scopeRef.current !== workspaceId;
  const candidate = query.isFetching || query.isError ? undefined : query.data;
  const eligible = Boolean(candidate && !scopeChanged && canResolveInboxMemoryProposal(item, candidate, candidate, workspaceId));

  async function resolve() {
    if (!review || !candidateId || locked.current || pending || completed || outcomeUncertain || scopeRef.current !== workspaceId) return;
    locked.current = true;
    setPending(true);
    setError("");
    let mutationAttempted = false;
    try {
      const latest = await readCandidate(workspaceId, candidateId);
      if (scopeRef.current !== workspaceId || !canResolveInboxMemoryProposal(item, review.candidate, latest, workspaceId)) {
        setReview(null);
        setError("The proposal changed or left the pending queue. Refresh its current record before deciding.");
        void query.refetch();
        return;
      }
      mutationAttempted = true;
      if (review.action === "promote") {
        const learning = await promoteTraceMemoryCandidate(candidateId);
        if (learning.workspaceId !== workspaceId || learning.status !== "trusted"
          || learning.insight !== review.candidate.proposedInsight
          || JSON.stringify(learning.sourceRefs) !== JSON.stringify(review.candidate.sourceRefs)) {
          throw new Error("Gateway returned an unexpected memory learning.");
        }
        setNotice("Gateway promoted the proposal to a memory learning. Review Memory for the current learning record.");
      } else {
        const rejected = await rejectTraceMemoryCandidate(candidateId);
        if (rejected.candidateId !== candidateId || rejected.workspaceId !== workspaceId || rejected.status !== "rejected") {
          throw new Error("Gateway returned an unexpected proposal status.");
        }
        setNotice("Gateway rejected the proposal. Review Memory for its current status.");
      }
      setReview(null);
      setCompleted(true);
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
    } catch (cause) {
      setReview(null);
      if (mutationAttempted) {
        setOutcomeUncertain(true);
        setError(`Decision outcome is uncertain. Inspect the current proposal in Memory before taking another action. ${describeApiError(cause).summary}`);
      } else {
        setError(`Could not check the current proposal. ${describeApiError(cause).summary}`);
      }
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  return <section aria-label="Current memory proposal" className="space-y-3 border-t border-line-subtle pt-3 text-sm">
    <div className="flex items-center justify-between gap-2">
      <h3 className="font-display font-semibold text-fg">Current memory proposal</h3>
      <Button size="sm" disabled={query.isFetching || pending || !candidateId} onClick={() => { setReview(null); setError(""); void query.refetch(); }}>Refresh</Button>
    </div>
    {!candidateId ? <p role="alert" className="text-status-failed">This Inbox item has no proposal ID. Open Memory for the current record.</p> : null}
    {query.isFetching ? <p role="status" className="text-fg-muted">Loading the current proposal…</p> : null}
    {query.isError ? <p role="alert" className="text-status-failed">{describeApiError(query.error).summary}</p> : null}
    {!query.isFetching && !query.isError && candidateId && !candidate ? <p className="text-fg-muted">This proposal was not found in the first 500 pending records. Open Memory to check its current status.</p> : null}
    {candidate && candidate.workspaceId === workspaceId ? <>
      <p className="text-fg-secondary">Proposed insight: {candidate.proposedInsight}</p>
      <p className="text-xs text-fg-muted">Type: {candidate.candidateType.replaceAll("_", " ")} · Source: {candidate.authority.replaceAll("_", " ")} · {candidate.sourceRefs.length} source {candidate.sourceRefs.length === 1 ? "reference" : "references"}</p>
      {candidate.sourceText ? <details className="rounded-md border border-line bg-sunken p-3 text-fg-secondary"><summary className="cursor-pointer font-medium">Source excerpt</summary><p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">{candidate.sourceText}</p></details> : null}
      <p className="text-xs text-fg-muted">Promotion writes this insight into durable memory for this workspace. The Gateway owns the final decision.</p>
    </> : null}
    {scopeChanged ? <p role="alert" className="text-fg-secondary">The selected workspace changed. Open this item again in the current Inbox.</p> : null}
    {candidate && candidate.workspaceId !== workspaceId ? <p role="alert" className="text-fg-secondary">The current proposal belongs to another workspace. No decision is available here.</p> : null}
    {eligible && !completed && !outcomeUncertain ? <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={pending} onClick={() => setReview({ candidate: candidate!, action: "promote" })}>Promote to memory</Button>
      <Button size="sm" variant="danger" disabled={pending} onClick={() => setReview({ candidate: candidate!, action: "reject" })}>Reject proposal</Button>
    </div> : null}
    {pending ? <p role="status" className="text-fg-muted">Checking the current proposal and recording the decision…</p> : null}
    {notice ? <p role="status" className="text-status-done">{notice}</p> : null}
    {error ? <p role="alert" className="text-status-failed">{error}</p> : null}
    <Dialog open={Boolean(review)} onOpenChange={(open) => { if (!open && !pending) setReview(null); }}
      title={review?.action === "promote" ? "Promote this proposal" : "Reject this proposal"}
      description={review?.action === "promote" ? "This writes the reviewed insight into durable workspace memory." : "This records a rejection of the reviewed proposal."}>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={review?.action === "reject" ? "danger" : "primary"} disabled={pending || scopeChanged} onClick={() => void resolve()}>
          Confirm {review?.action === "promote" ? "promotion" : "rejection"}
        </Button>
        <Button size="sm" disabled={pending} onClick={() => setReview(null)}>Cancel</Button>
      </div>
    </Dialog>
  </section>;
}
