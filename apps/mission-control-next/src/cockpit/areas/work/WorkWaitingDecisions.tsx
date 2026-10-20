import { useOperatorInbox } from "../../data/use-operator-inbox";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { inboxViewGroup } from "../inbox/inbox-triage";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

/** Shows only decisions the Inbox links to a run; never infer approvals from a run's waiting status. */
export function WorkWaitingDecisions({ workspaceId }: { workspaceId: string }) {
  const inbox = useOperatorInbox(workspaceId);
  const decisions =
    !inbox.isError && inbox.data?.workspaceId === workspaceId
      ? // Expired approvals can no longer be decided; Inbox lists them under Expired (WK-N06).
        inbox.data.items.filter((item) => inboxViewGroup(item, Date.now()) === "needs_decision" && item.source.runId)
      : [];
  const empty = !inbox.isError && Boolean(inbox.data) && !decisions.length;
  // Nothing waiting collapses to one line; the Inbox caveat only matters while decisions are listed or checked.
  return (
    <section className="grid gap-2" aria-label="Runs waiting on your decision">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold text-fg">Waiting on your decision</h2>
        {empty ? <p className="text-sm text-fg-muted">No decisions linked to runs right now.</p> : null}
      </div>
      {empty ? null : (
        <p className="text-xs text-fg-muted">
          From your Inbox. A run that is waiting does not always need a decision from you.
        </p>
      )}
      {inbox.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Checking current decisions…
        </p>
      ) : null}
      {inbox.isFetching && inbox.data ? (
        <p role="status" className="text-xs text-fg-muted">
          Checking for changes. These decisions may have changed; each decision is checked again when you open it.
        </p>
      ) : null}
      {inbox.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          Decisions unavailable: {describeApiError(inbox.error).summary}
        </p>
      ) : null}
      {decisions.length ? (
        <div className="divide-y divide-line-subtle">
          {decisions.map((item) => (
            <article key={item.id} className="py-2 text-sm text-fg-secondary">
              <p className="font-medium text-fg">{item.title}</p>
              <p>{item.summary}</p>
              <div className="flex flex-wrap gap-3">
                <NativeOwnerLink href={item.href} scope={[workspaceId, item.id]}>
                  Review current decision<span className="sr-only">: {item.title}</span>
                </NativeOwnerLink>
                <NativeOwnerLink
                  href={`/work/runs/${encodeURIComponent(item.source.runId!)}`}
                  scope={[workspaceId, item.id, item.source.runId]}
                >
                  Open run<span className="sr-only">: {item.title}</span>
                </NativeOwnerLink>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {inbox.data && !inbox.data.counts.needs_decision.complete ? (
        <p className="text-xs text-fg-muted">Some decisions couldn't be checked, so a decision may still be waiting.</p>
      ) : null}
    </section>
  );
}
