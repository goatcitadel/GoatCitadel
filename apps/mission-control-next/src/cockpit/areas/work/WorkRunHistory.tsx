import { WindowedRecordList } from "../../ui/WindowedRecordList";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { presentRunStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { durableRunWorkspaceId } from "../../data/durable-run-scope";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { StatusBadge } from "../../ui/StatusBadge";
import { workRunTitle } from "./work-board";
import { useWorkspaceDurableRuns } from "./useWorkspaceDurableRuns";

function formattedTime(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed) : "Time unavailable";
}

export function WorkRunHistory({ workspaceId }: { workspaceId: string }) {
  const query = useWorkspaceDurableRuns(workspaceId);
  const runs = query.data?.pages.flatMap((page) => page.items)
    .filter((run) => durableRunWorkspaceId(run) === workspaceId) ?? [];
  return <section aria-labelledby="durable-history-heading" className="grid gap-3">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="durable-history-heading" className="font-display text-md font-semibold text-fg">Durable runs</h2>
        <p className="text-sm text-fg-secondary">Saved run records for this workspace, newest created first.</p></div>
      <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh runs</Button>
    </header>
    {query.isPending ? <p role="status" className="text-sm text-fg-muted">Loading durable history…</p> : null}
    {query.isError ? <div role="alert" className="grid gap-2 text-sm text-status-failed">
      <p>{query.isFetchNextPageError ? "Older runs could not be loaded." : "Durable history could not be refreshed."} {describeApiError(query.error).summary}</p>
      {runs.length > 0 ? <p>Previously loaded records remain visible; their status may have changed.</p> : null}
      <Button size="sm" disabled={query.isFetching} onClick={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())}>Try runs again</Button>
    </div> : null}
    {!query.isPending && !query.isError && runs.length === 0 ? <EmptyState title="No saved runs returned" description="Runs without a recorded workspace binding are excluded." /> : null}
    {runs.length > 0 ? <>
      <p className="text-xs text-fg-muted">{runs.length} saved runs loaded. {query.hasNextPage ? "Older runs are available." : "End of saved run history."}</p>
      <WindowedRecordList items={runs} itemKey={(run) => run.runId} label="Durable run history" ordered>{(run) => <article className="rounded-lg border border-line bg-raised p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="text-sm font-medium text-fg">{workRunTitle(run)}</p><StatusBadge status={presentRunStatus(run.status)} />
        </div>
        <p className="mt-1 text-xs text-fg-muted">Created <time dateTime={run.createdAt}>{formattedTime(run.createdAt)}</time> · Updated <time dateTime={run.updatedAt}>{formattedTime(run.updatedAt)}</time></p>
        <NativeOwnerLink scope={[workspaceId, run.runId]} href={`/work/runs/${encodeURIComponent(run.runId)}`} className="mt-2 inline-block text-sm font-medium text-accent hover:underline">Open run record</NativeOwnerLink>
      </article>}</WindowedRecordList>
    </> : null}
    {query.hasNextPage ? <Button size="sm" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading older runs…" : "Load older runs"}</Button> : null}
  </section>;
}
