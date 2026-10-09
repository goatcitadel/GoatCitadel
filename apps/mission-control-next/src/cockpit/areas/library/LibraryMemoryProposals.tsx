import { useLibraryOperation } from "./use-library-operation";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canonicalJsonString, type TraceMemoryCandidateRecord } from "@goatcitadel/contracts";
import { fetchTraceMemoryCandidates, fetchTraceMemoryCandidate, promoteTraceMemoryCandidate, rejectTraceMemoryCandidate } from "@goatcitadel/mission-control-shared/api/memory";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

export function LibraryMemoryProposals(props: Parameters<typeof LibraryMemoryProposalsContent>[0]) {
 const access = useLibraryOperation(JSON.stringify(["memory-proposals", props.workspaceId]));
 return <LibraryMemoryProposalsContent key={access.identity} {...props} />;
}
function LibraryMemoryProposalsContent({ workspaceId }: { workspaceId: string }) {
  const operation = useLibraryOperation(JSON.stringify(["memory-proposals", workspaceId]));
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["library", "memory-proposals", workspaceId, operation.identity], queryFn: () => fetchTraceMemoryCandidates({ workspaceId, limit: 100 }), staleTime: 0 });
  const settings = useQuery({ queryKey: ["library", "memory-settings", workspaceId, operation.identity], queryFn: () => fetchSettings(), staleTime: 0 });
  const enabled = settings.data?.features.memoryLifecycleAdminV1Enabled === true && !settings.isError && !settings.isFetching;
  const [review, setReview] = useState<{ item: TraceMemoryCandidateRecord; action: "promote" | "reject" }>(), [busy, setBusy] = useState(false), [outcome, setOutcome] = useState<{ error: boolean; text: string }>();
  async function confirm() {
    if (!review || operation.locked || outcome || !enabled || query.isFetching || query.isError) return;
    setBusy(true);
    try {
      const completed = await operation.run(review.item.updatedAt, async () => {
      const fresh = await fetchTraceMemoryCandidate(review.item.candidateId, { workspaceId });
      if (fresh.workspaceId !== workspaceId || fresh.status !== "proposed" || canonicalJsonString(fresh) !== canonicalJsonString(review.item)) throw new Error("The memory proposal changed during review. Refresh before deciding.");
      return fresh;
      }, async fresh => {
      if (review.action === "promote") {
        const result = await promoteTraceMemoryCandidate(fresh.candidateId);
        if (result.workspaceId !== workspaceId || result.status !== "trusted" || result.insight !== fresh.proposedInsight || canonicalJsonString(result.sourceRefs) !== canonicalJsonString(fresh.sourceRefs)) throw new Error("The learning receipt does not confirm this proposal.");
      } else {
        const result = await rejectTraceMemoryCandidate(fresh.candidateId);
        if (result.workspaceId !== workspaceId || result.candidateId !== fresh.candidateId || result.status !== "rejected") throw new Error("Rejection is not confirmed by the owner.");
      }
      return true;
      });
      if (!completed) return;
      setOutcome({ error: false, text: review.action === "promote" ? "Gateway confirmed promotion into a trusted workspace learning." : "Gateway confirmed rejection." });
      await client.invalidateQueries({ queryKey: ["library", "memory-proposals", workspaceId, operation.identity] });
    } catch (cause) { if (operation.current()) setOutcome({ error: true, text: `${describeApiError(cause).summary} The decision is not confirmed. Refresh the canonical proposal before retrying.` }); }
    finally { setBusy(false); }
  }
  return <section className="grid gap-3 rounded-lg border border-line p-3" aria-label="Memory proposals"><h2 className="font-display text-lg text-fg">Memory proposals</h2><p className="text-sm text-fg-secondary">Proposals are not trusted memory. Promotion is an explicit operator decision governed by the memory owner.</p>
    {query.isFetching ? <p role="status">Reading memory proposals…</p> : null}{query.error ? <Callout tone="error">{describeApiError(query.error).summary}</Callout> : null}
    {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
    <Button disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh memory proposals</Button>
    <ul className="grid gap-2">{query.data?.items.filter(item => item.workspaceId === workspaceId).map(item => <li key={item.candidateId} className="rounded-md border border-line p-3"><p className="whitespace-pre-wrap break-words">{item.proposedInsight}</p><p className="text-sm text-fg-secondary">{item.status} · {item.authority.replaceAll("_", " ")} · {item.sourceRefs.length} source references</p><TechnicalDetails label="Proposal provenance"><p>Conversation: {item.sourceSessionId ?? "Not recorded"}</p><p>Message: {item.sourceMessageId ?? item.sourceTurnId ?? "Not recorded"}</p><p>Candidate: {item.candidateId}</p></TechnicalDetails>{item.status === "proposed" ? <div className="flex gap-2">{(["promote", "reject"] as const).map(action => <Button key={action} disabled={!enabled || query.isFetching || query.isError || busy} onClick={() => { if (operation.locked || !operation.current()) return; setOutcome(undefined); setReview({ item, action }); }}>{action === "promote" ? "Review promotion" : "Review rejection"}</Button>)}</div> : null}</li>)}</ul>
    <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !busy) setReview(undefined); }} title="Review memory proposal" description="Review the insight, workspace and durable-memory consequence."><div className="grid gap-3"><p>Workspace {workspaceId}</p><p className="whitespace-pre-wrap break-words">{review?.item.proposedInsight}</p><Callout tone="warning">{review?.action === "promote" ? "Promotion writes this proposed insight into trusted durable memory." : "Rejection leaves this proposal unpromoted."}</Callout>{outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}<Button disabled={busy || operation.locked || Boolean(outcome) || !enabled || query.isFetching || query.isError} onClick={() => void confirm()}>{review?.action === "promote" ? "Confirm memory promotion" : "Confirm memory rejection"}</Button></div></Dialog>
  </section>;
}
