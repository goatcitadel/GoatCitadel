import { useOperatorInbox } from "../../data/use-operator-inbox";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

/** Shows only decisions the Inbox links to a run; never infer approvals from a run's waiting status. */
export function WorkWaitingDecisions({ workspaceId }: { workspaceId: string }) {
  const inbox = useOperatorInbox(workspaceId);
  const decisions =
    !inbox.isError && inbox.data?.workspaceId === workspaceId
      ? inbox.data.items.filter((item) => item.group === "needs_decision" && item.source.runId)
      : [];
  return (
    <section
      className="grid gap-2 rounded-lg border border-line bg-raised p-4"
      aria-label="Runs waiting on your decision"
    >
      <h2 className="font-display text-lg font-semibold text-fg">Waiting on your decision</h2>
      <p className="text-xs text-fg-muted">
        From your Inbox. A run that is waiting does not always need a decision from you.
      </p>
      {inbox.isLoading ? <p role="status">Checking current decisions…</p> : null}
      {inbox.isFetching && inbox.data ? (
        <p role="status">
          Checking for changes. These decisions may have changed; each decision is checked again when you open it.
        </p>
      ) : null}
      {inbox.isError ? <p role="alert">Decisions unavailable: {describeApiError(inbox.error).summary}</p> : null}
      {decisions.map((item) => (
        <article key={item.id} className="text-sm text-fg-secondary">
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
      {!inbox.isError && inbox.data && !decisions.length ? (
        <p className="text-sm text-fg-secondary">No decisions linked to runs right now.</p>
      ) : null}
      {inbox.data && !inbox.data.counts.needs_decision.complete ? (
        <p className="text-xs text-fg-muted">Some decisions couldn't be checked, so a decision may still be waiting.</p>
      ) : null}
    </section>
  );
}
