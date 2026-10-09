import { useOperatorInbox } from "../../data/use-operator-inbox";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

/** Display Gateway-authored decision linkage; never infer approvals from a run's waiting status. */
export function WorkWaitingDecisions({ workspaceId }: { workspaceId: string }) {
  const inbox = useOperatorInbox(workspaceId);
  const decisions = !inbox.isError && inbox.data?.workspaceId === workspaceId ? inbox.data.items.filter(item => item.group === "needs_decision" && item.source.runId) : [];
  return <section className="grid gap-2 rounded-lg border border-line bg-raised p-4" aria-label="Runtime runs waiting on decisions"><h2 className="font-display text-lg font-semibold text-fg">Waiting on your decision</h2>
    <p className="text-xs text-fg-muted">Gateway-authored Inbox projection. A waiting run alone does not prove an operator decision is needed.</p>
    {inbox.isLoading ? <p role="status">Checking current decisions…</p> : null}
    {inbox.isFetching && inbox.data ? <p role="status">Checking for changes. Previously loaded decision links may have changed; the decision page rechecks the current record.</p> : null}
    {inbox.isError ? <p role="alert">Decision linkage unavailable: {describeApiError(inbox.error).summary}</p> : null}
    {decisions.map(item => <article key={item.id} className="text-sm text-fg-secondary"><p className="font-medium text-fg">{item.title}</p><p>{item.summary}</p><div className="flex flex-wrap gap-3"><NativeOwnerLink href={item.href} scope={[workspaceId, item.id]}>Review current decision</NativeOwnerLink><NativeOwnerLink href={`/work/runs/${encodeURIComponent(item.source.runId!)}`} scope={[workspaceId, item.id, item.source.runId]}>Open linked runtime run</NativeOwnerLink></div></article>)}
    {!inbox.isError && inbox.data && !decisions.length ? <p className="text-sm text-fg-secondary">No run-linked decisions were returned in this snapshot.</p> : null}
    {inbox.data && !inbox.data.counts.needs_decision.complete ? <p className="text-xs text-fg-muted">Decision coverage is incomplete. Missing linkage does not prove no decision is waiting.</p> : null}
  </section>;
}
