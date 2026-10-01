import { WindowedRecordList } from "../../ui/WindowedRecordList";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { fetchObserveRunTrace } from "@goatcitadel/mission-control-shared/api/durable";
import { fetchTasks } from "@goatcitadel/mission-control-shared/api/tasks";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { formatCostUsd } from "@goatcitadel/mission-control-shared/content/cost-summary";
import { humanizeToken, presentApprovalStatus, presentEventType, presentRiskLevel, presentRunStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { queryKeys } from "../../data/query-keys";
import { durableRunWorkspaceId } from "../../data/durable-run-scope";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { StatusBadge } from "../../ui/StatusBadge";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { projectWorkBoard, workRunTitle, type WorkBoardGroup } from "./work-board";
import { WorkHistory } from "./WorkHistory";
import { WorkSchedules } from "./WorkSchedules";
import { RunEvidenceSections } from "./RunEvidenceSections";
import { RunSignedReceipt } from "./RunSignedReceipt";
import { WorkRunControls } from "./WorkRunControls";
import { projectWorkTasks } from "./work-tasks";
import { WorkTaskDetail } from "./WorkTaskDetail";
import { WorkTaskCreate } from "./WorkTaskCreate";
import { useWorkspaceDurableRuns } from "./useWorkspaceDurableRuns";
import { RunArtifacts } from "./RunArtifacts";
import { RunWorkspaceContext } from "./RunWorkspaceContext";
import { RunLineage } from "./RunLineage";

const COLUMNS: readonly { id: WorkBoardGroup; title: string; description: string }[] = [
  { id: "running", title: "Running", description: "Queued or executing" },
  { id: "waiting", title: "Waiting", description: "Waiting or paused; review the run for its cause" },
  { id: "failed", title: "Failed", description: "Failed or needs recovery" },
  { id: "done", title: "Done", description: "Completed or cancelled" },
];

function formattedTime(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed)
    : "Time unavailable";
}

function WorkBoard() {
  const { navigate } = useCockpitRoute();
  const [creating, setCreating] = useState(false);
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const runs = useWorkspaceDurableRuns(workspaceId);
  const tasks = useInfiniteQuery({ queryKey: queryKeys.workTasks(workspaceId), initialPageParam: "",
    queryFn: ({ pageParam }) => fetchTasks(undefined, workspaceId, { limit: 200, cursor: pageParam || undefined }),
    getNextPageParam: (last) => last.nextCursor, refetchInterval: 30_000 });
  const board = runs.data ? projectWorkBoard(runs.data.pages.flatMap((page) => page.items), workspaceId) : null;
  const taskBoard = !tasks.isError && tasks.data ? projectWorkTasks(tasks.data.pages.flatMap((page) => page.items), workspaceId) : null;
  return <section className="flex min-h-full flex-col gap-5 p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-display text-xl font-semibold text-fg">Work</h1>
        <p className="text-sm text-fg-secondary">Workspace tasks and recent Chat or supervised plan runs.</p>
        <p className="mt-1 text-xs text-fg-muted">Workspace tasks and saved run pages. Records without matching workspace evidence are omitted. Counts cover only loaded records.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => setCreating(true)} disabled={creating}>New task</Button>
        <Button size="sm" onClick={() => { void runs.refetch(); void tasks.refetch(); }} disabled={runs.isFetching || tasks.isFetching}><RefreshCw aria-hidden="true" className="size-4" /> Refresh</Button>
      </div>
    </header>
    {creating ? <WorkTaskCreate key={workspaceId} workspaceId={workspaceId} onClose={() => setCreating(false)}
      onCreated={(task) => { setCreating(false); navigate(`/work/tasks/${encodeURIComponent(task.taskId)}`); }} /> : null}
    {runs.isLoading || tasks.isLoading ? <p role="status" className="text-sm text-fg-muted">Loading recent work…</p> : null}
    {runs.isError ? <p role="alert" className="text-sm text-status-failed">Run list could not be refreshed: {describeApiError(runs.error).summary} {runs.data ? "Previously loaded records remain visible; their status may have changed." : ""}</p> : null}
    {tasks.isError ? <p role="alert" className="text-sm text-status-failed">Task list unavailable: {describeApiError(tasks.error).summary}</p> : null}
    {!tasks.isError && tasks.hasNextPage ? <p className="text-xs text-fg-muted">More tasks exist beyond the loaded pages.</p> : null}
    {board || taskBoard ? <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">{COLUMNS.map((column) => <section key={column.id} aria-label={column.title} className="min-w-0 rounded-lg border border-line bg-sunken p-3">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div><h2 className="font-display text-md font-semibold text-fg">{column.title}</h2><p className="text-xs text-fg-muted">{column.description}</p></div>
        <span className="text-sm tabular-nums text-fg-secondary">{(board?.[column.id].length ?? 0) + (taskBoard?.[column.id].length ?? 0)}</span>
      </div>
      <WindowedRecordList label={column.title + " records"} items={[
        ...(taskBoard?.[column.id] ?? []).map((task) => ({ kind: "task" as const, key: "task:" + task.taskId, task })),
        ...(board?.[column.id] ?? []).map((run) => ({ kind: "run" as const, key: "run:" + run.runId, run })),
      ]} itemKey={(item) => item.key}>{(item) => {
        if (item.kind === "task") { const task = item.task;
        const path = `/work/tasks/${encodeURIComponent(task.taskId)}`;
        return <a key={`task:${task.taskId}`} href={path} onClick={(event) => { event.preventDefault(); navigate(path); }} className="block rounded-md border border-line bg-raised p-3 hover:border-line-strong">
          <span className="text-xs font-semibold text-accent">Task · {humanizeToken(task.status)}</span>
          <span className="mt-1 line-clamp-3 block text-sm font-medium text-fg">{task.title}</span>
          <span className="mt-2 block text-xs text-fg-muted">Updated {formattedTime(task.updatedAt)}</span>
        </a>;
      }
        const run = item.run;
        const path = `/work/runs/${encodeURIComponent(run.runId)}`;
        return <a key={`run:${run.runId}`} href={path} onClick={(event) => { event.preventDefault(); navigate(path); }} className="block rounded-md border border-line bg-raised p-3 hover:border-line-strong">
          <span className="text-xs font-semibold text-accent">Durable run</span>
          <span className="line-clamp-3 text-sm font-medium text-fg">{workRunTitle(run)}</span>
          <span className="mt-2 flex flex-wrap items-center justify-between gap-2"><StatusBadge status={presentRunStatus(run.status)} /><span className="text-xs text-fg-muted">{formattedTime(run.updatedAt)}</span></span>
        </a>;
      }}</WindowedRecordList>{!board?.[column.id].length && !taskBoard?.[column.id].length ? <p className="text-xs text-fg-muted">No recent work in this state.</p> : null}
    </section>)}</div> : null}
    {runs.hasNextPage ? <Button size="sm" variant="secondary" disabled={runs.isFetching}
      onClick={() => void runs.fetchNextPage()}>{runs.isFetchingNextPage ? "Loading runs…" : "Load more runs"}</Button> : null}
    {!tasks.isError && tasks.hasNextPage ? <Button size="sm" variant="secondary" disabled={tasks.isFetchingNextPage}
      onClick={() => void tasks.fetchNextPage()}>{tasks.isFetchingNextPage ? "Loading tasks…" : "Load more tasks"}</Button> : null}
    <p className="text-sm text-fg-muted">Open a task or run for owner evidence and available controls. Additional recovery options remain in <ClassicOwnerLink className="font-medium text-accent underline-offset-2 hover:underline" href="/ops/kanban?shell=classic" scope={workspaceId} label="current Ops Kanban" />.</p>
  </section>;
}

function RunDetail({ runId }: { runId: string }) {
  const { navigate } = useCockpitRoute();
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const trace = useQuery({ queryKey: queryKeys.runTrace(runId), queryFn: () => fetchObserveRunTrace(runId), refetchInterval: 15_000 });
  const data = trace.isError ? undefined : trace.data;
  const run = data?.run && durableRunWorkspaceId(data.run) === workspaceId ? data.run : undefined;
  const sessionId = typeof run?.payload.sessionId === "string" && run.payload.sessionId.trim() ? run.payload.sessionId : null;
  const pendingApproval = run && data ? data.approvals.items.some((item) => item.status === "pending") : false;
  const recordedCost = run && data?.providerUsage.state === "available" ? data.providerUsage.totals.costUsd : undefined;
  const costLabel = typeof recordedCost === "number" && Number.isFinite(recordedCost) && recordedCost > 0 ? `${formatCostUsd(recordedCost)}+` : "Unknown";
  return <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
    <a href="/work" onClick={(event) => { event.preventDefault(); navigate("/work"); }} className="inline-flex items-center gap-2 text-sm text-accent"><ArrowLeft aria-hidden="true" className="size-4" />Back to Work</a>
    {trace.isLoading ? <p role="status" className="text-sm text-fg-muted">Loading run evidence…</p> : null}
    {trace.isError ? <EmptyState title="Run evidence unavailable" description={describeApiError(trace.error).summary} action={<Button onClick={() => void trace.refetch()}>Try again</Button>} /> : null}
    {data?.run && !run ? <EmptyState title="Run outside this workspace" description="This run has no matching workspace evidence. Choose its workspace or return to Work." /> : null}
    {run && data ? <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-xs font-semibold text-accent">Durable run</p><h1 className="max-w-3xl font-display text-xl font-semibold text-fg">{workRunTitle(run)}</h1><p className="mt-1 text-xs text-fg-muted">Updated {formattedTime(run.updatedAt)}</p></div>
        <StatusBadge status={presentRunStatus(run.status, { waitingOnOperator: pendingApproval })} />
      </header>
      <p className="rounded-md border border-line bg-sunken p-3 text-sm text-fg-secondary">This page reads Gateway evidence. {sessionId
        ? <><NativeOwnerLink scope={[workspaceId, runId, sessionId]} className="font-medium text-accent" href={`/chat?sessionId=${encodeURIComponent(sessionId)}&shell=cockpit`}>Open this conversation in Chat</NativeOwnerLink> for its conversation context. </>
        : null}<ClassicOwnerLink className="font-medium text-accent" href="/ops/runtime?shell=classic" scope={JSON.stringify([workspaceId, runId])} label="Open current Ops" /> for additional owner controls.</p>
      <WorkRunControls runId={runId} />
      <div className="grid gap-3 sm:grid-cols-3">
        <EvidenceCount title="Checkpoints" count={data.durable.checkpoints.items.length} state={data.durable.checkpoints.state} />
        <EvidenceCount title="Tool calls" count={data.toolCalls.items.length} state={data.toolCalls.state} />
        <EvidenceCount title="Recorded cost" count={costLabel} state={data.providerUsage.state} />
      </div>
      <section className="rounded-lg border border-line bg-raised p-4">
        <h2 className="font-display text-lg font-semibold text-fg">Run history</h2>
        {data.durable.timeline.state === "available" ? data.durable.timeline.items.length ? <ol className="mt-3 grid gap-2">{data.durable.timeline.items.slice(-12).map((event) => <li key={event.eventId} className="flex justify-between gap-3 border-b border-line-subtle py-2 text-sm"><span className="text-fg">{presentEventType(event.eventType)}</span><time className="shrink-0 text-xs text-fg-muted">{formattedTime(event.createdAt)}</time></li>)}</ol> : <p className="mt-2 text-sm text-fg-muted">No timeline events were returned.</p> : <p className="mt-2 text-sm text-fg-muted">Timeline evidence is {humanizeToken(data.durable.timeline.state).toLowerCase()}.</p>}
      </section>
      <RunEvidenceSections trace={data} />
      <RunLineage trace={data} workspaceId={workspaceId} />
      <RunSignedReceipt key={runId} runId={runId} />
      <section className="rounded-lg border border-line bg-raised p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-display text-lg font-semibold text-fg">Approvals</h2><ClassicOwnerLink className="text-sm text-accent" href="/ops/approvals?shell=classic" scope={JSON.stringify([workspaceId, runId])} label="Open current approvals" /></div>
        {data.approvals.state === "available" ? data.approvals.items.length ? <ul className="mt-3 grid gap-2">{data.approvals.items.map((approval) => <li key={approval.approvalId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3 text-sm"><span className="text-fg">{humanizeToken(approval.kind)}</span><span className="flex gap-2"><StatusBadge status={presentRiskLevel(approval.riskLevel)} /><StatusBadge status={presentApprovalStatus(approval.status)} /></span></li>)}</ul> : <p className="mt-2 text-sm text-fg-muted">No approvals were linked to this run.</p> : <p className="mt-2 text-sm text-fg-muted">Approval evidence is {humanizeToken(data.approvals.state).toLowerCase()}.</p>}
      </section>
      <RunArtifacts trace={data} workspaceId={workspaceId} />
      <RunWorkspaceContext trace={data} workspaceId={workspaceId} />
      {data.errors.items.length ? <p className="rounded-md border border-status-failed p-3 text-sm text-fg">{data.errors.items.length} recorded {data.errors.items.length === 1 ? "error needs" : "errors need"} review in <ClassicOwnerLink className="font-medium text-accent" href="/ops/runtime?shell=classic" scope={JSON.stringify([workspaceId, runId])} label="current Ops" />.</p> : null}
    </> : null}
  </section>;
}

function EvidenceCount({ title, count, state }: { title: string; count: number | string; state: string }) {
  return <div className="rounded-lg border border-line bg-raised p-4"><p className="text-xs text-fg-muted">{title}</p><p className="mt-1 font-display text-xl font-semibold tabular-nums text-fg">{state === "available" ? count : "Unknown"}</p></div>;
}

export function WorkArea() {
  const { rest, navigate } = useCockpitRoute();
  if (rest[0] === "tasks" && rest[1]) {
    try { return <WorkTaskDetail taskId={decodeURIComponent(rest[1])} />; }
    catch { return <EmptyState title="Task link unavailable" description="This task link could not be read." />; }
  }
  if (rest[0] === "runs" && rest[1]) {
    try { return <RunDetail runId={decodeURIComponent(rest[1])} />; }
    catch { return <EmptyState title="Run link unavailable" description="This run link could not be read." />; }
  }
  const view = rest[0] === "history" ? "history" : rest[0] === "schedules" ? "schedules" : "board";
  return <>
    <nav aria-label="Work views" className="mx-auto flex max-w-5xl gap-1 border-b border-line-subtle px-4 pt-3 sm:px-6">
      {[{ id: "board", label: "Board", path: "/work" }, { id: "history", label: "History", path: "/work/history" }, { id: "schedules", label: "Schedules", path: "/work/schedules" }].map((item) => <a
        key={item.id} href={item.path} aria-current={view === item.id ? "page" : undefined}
        onClick={(event) => { event.preventDefault(); navigate(item.path); }}
        className="border-b-2 border-transparent px-3 py-2 text-sm text-fg-secondary hover:text-fg aria-[current=page]:border-accent aria-[current=page]:text-fg"
      >{item.label}</a>)}
    </nav>
    {view === "history" ? <WorkHistory /> : view === "schedules" ? <WorkSchedules /> : <WorkBoard />}
  </>;
}
