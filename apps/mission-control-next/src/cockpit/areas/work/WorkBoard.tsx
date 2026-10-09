import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { humanizeToken, presentRunStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { WindowedRecordList } from "../../ui/WindowedRecordList";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { AREA_PAGE } from "../../ui/area-layout";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { projectWorkBoard, workRunTitle, type WorkBoardGroup } from "./work-board";
import { projectWorkTasks } from "./work-tasks";
import { WorkTaskCreate } from "./WorkTaskCreate";
import { useWorkspaceDurableRuns } from "./useWorkspaceDurableRuns";
import { workspaceTasksOptions } from "./work-queries";
import { formattedWorkTime } from "./work-format";
import { Field } from "../../ui/Field";
import { WorkWaitingDecisions } from "./WorkWaitingDecisions";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { recordView } from "../../data/record-view";
import { workColumnStatus } from "./work-column-status";
import { WorkTaskBulkActions } from "./WorkTaskBulkActions";

const COLUMNS: readonly { id: WorkBoardGroup; title: string; description: string }[] = [
  { id: "running", title: "Active", description: "Tasks being prepared or worked; runs queued or executing" },
  { id: "waiting", title: "Needs attention", description: "Tasks in inbox, blocked or review; runs waiting or paused" },
  { id: "failed", title: "Failed runs", description: "Runtime failures and recovery" },
  { id: "done", title: "Done", description: "Completed or cancelled" },
];

const CARD = "block rounded-md border border-line bg-raised p-3 hover:border-line-strong";

export function WorkBoard() {
  const { navigate } = useCockpitRoute();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  // Select mode turns operator task cards into checkboxes for reviewed task actions; runtime runs stay links.
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkNotice, setBulkNotice] = useState<string>();
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const runs = useWorkspaceDurableRuns(workspaceId);
  const tasks = useInfiniteQuery(workspaceTasksOptions(workspaceId));
  const writable = tasks.isSuccess && tasks.isFetchedAfterMount && !tasks.isFetching && !tasks.isPlaceholderData;
  const board = runs.data
    ? projectWorkBoard(
        runs.data.pages.flatMap((page) => page.items),
        workspaceId,
      )
    : null;
  const taskBoard =
    tasks.data
      ? projectWorkTasks(
          tasks.data.pages.flatMap((page) => page.items),
          workspaceId,
        )
      : null;
  const loadedTasks = taskBoard ? Object.values(taskBoard).flat() : [];
  const taskView = recordView(tasks);
  const runView = recordView(runs);
  const selectedTasks = loadedTasks.filter((task) => selectedIds.has(task.taskId));
  const toggle = (taskId: string) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  const open = (path: string) => (event: { preventDefault: () => void }) => {
    event.preventDefault();
    navigate(path);
  };
  return (
    <section className={`${AREA_PAGE} min-h-full`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-fg">Work</h1>
          <p className="text-sm text-fg-secondary">Workspace tasks and recent Chat or supervised plan runs.</p>
          <p className="mt-1 text-xs text-fg-muted">
            Workspace tasks and saved run pages. Records without matching workspace evidence are omitted. Counts cover
            only loaded records.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={() => setCreating(true)} disabled={creating || !writable}>
            New task
          </Button>
          <Button
            size="sm"
            aria-pressed={selecting}
            disabled={!selecting && !tasks.data}
            onClick={() => {
              setSelecting((value) => !value);
              setSelectedIds(new Set());
              setBulkNotice(undefined);
            }}
          >
            {selecting ? "Done selecting" : "Select tasks"}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void runs.refetch();
              void tasks.refetch();
            }}
            disabled={runs.isFetching || tasks.isFetching}
          >
            <RefreshCw aria-hidden="true" className="size-4" /> Refresh
          </Button>
        </div>
      </header>
      <WorkWaitingDecisions workspaceId={workspaceId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Search loaded work">{props => <input {...props} value={search} onChange={event => setSearch(event.target.value)} className="rounded-md border border-line bg-sunken p-2 text-fg" />}</Field>
        <Field label="Record type">{props => <select {...props} value={kind} onChange={event => setKind(event.target.value)} className="rounded-md border border-line bg-sunken p-2 text-fg"><option value="all">Tasks and runtime runs</option><option value="task">Operator tasks</option><option value="run">Runtime runs</option></select>}</Field>
      </div>
      {selecting ? (
        <WorkTaskBulkActions
          workspaceId={workspaceId}
          selected={selectedTasks}
          onClear={() => setSelectedIds(new Set())}
          onRefresh={() => void tasks.refetch()}
          onSettled={(notice) => {
            setSelectedIds(new Set());
            setBulkNotice(notice);
            void tasks.refetch();
          }}
        />
      ) : null}
      {bulkNotice ? (
        <p role="status" className="rounded-md border border-line bg-sunken p-3 text-sm text-fg">
          {bulkNotice}
        </p>
      ) : null}
      {creating ? (
        <WorkTaskCreate
          key={workspaceId}
          workspaceId={workspaceId}
          accessAvailable={writable}
          onClose={() => setCreating(false)}
          onCreated={(task) => {
            setCreating(false);
            navigate(`/work/tasks/${encodeURIComponent(task.taskId)}`);
          }}
        />
      ) : null}
      {runs.isLoading || tasks.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading recent work…
        </p>
      ) : null}
      {runs.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          Run list could not be refreshed: {describeApiError(runs.error).summary}{" "}
          {runs.data ? "Previously loaded records remain visible; their status may have changed." : ""}
        </p>
      ) : null}
      {tasks.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          Task list unavailable: {describeApiError(tasks.error).summary}
        </p>
      ) : null}
      {!tasks.isError && tasks.hasNextPage ? (
        <p className="text-xs text-fg-muted">More tasks exist beyond the loaded pages.</p>
      ) : null}
      {board || taskBoard ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {COLUMNS.map((column) => (
            <section
              key={column.id}
              aria-label={column.title}
              className="min-w-0 rounded-lg border border-line bg-sunken p-3"
            >
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <div>
                  <h2 className="font-display text-md font-semibold text-fg">{column.title}</h2>
                  <p className="text-xs text-fg-muted">{column.description}</p>
                </div>
                <span className="text-sm tabular-nums text-fg-secondary">
                  {workColumnStatus(taskView, taskBoard?.[column.id].length, "tasks")} · {workColumnStatus(runView, board?.[column.id].length, "runs")}
                </span>
              </div>
              {(["task", "run"] as const).filter(recordKind => kind === "all" || kind === recordKind).map(recordKind => <section key={recordKind} aria-label={recordKind === "task" ? "Operator tasks" : "Runtime runs"}>
                <h3 className="mb-2 text-xs font-semibold text-fg-secondary">{recordKind === "task" ? "Operator tasks" : "Runtime runs"}</h3>
              <WindowedRecordList
                label={column.title + " records"}
                items={[
                  ...(taskBoard?.[column.id] ?? []).map((task) => ({
                    kind: "task" as const,
                    key: "task:" + task.taskId,
                    task,
                  })),
                  ...(board?.[column.id] ?? []).map((run) => ({ kind: "run" as const, key: "run:" + run.runId, run })),
                ].filter(item => item.kind === recordKind && (item.kind === "task" ? `${item.task.title} ${item.task.status} ${item.task.description ?? ""}` : `${workRunTitle(item.run)} ${item.run.status} ${item.run.lastError ?? ""}`).toLowerCase().includes(search.trim().toLowerCase())).slice(0, column.id === "done" ? 25 : undefined)}
                itemKey={(item) => item.key}
              >
                {(item) => {
                  if (item.kind === "task") {
                    const task = item.task;
                    const path = `/work/tasks/${encodeURIComponent(task.taskId)}`;
                    if (selecting)
                      return (
                        <label key={`task:${task.taskId}`} className={`${CARD} flex min-h-11 cursor-pointer items-start gap-2`}>
                          <input
                            type="checkbox"
                            className="mt-0.5 size-5 shrink-0"
                            checked={selectedIds.has(task.taskId)}
                            onChange={() => toggle(task.taskId)}
                          />
                          <span className="min-w-0">
                            <span className="text-xs font-semibold text-accent">Operator task · {humanizeToken(task.status)}</span>
                            <span className="mt-1 line-clamp-3 block text-sm font-medium text-fg">{task.title}</span>
                          </span>
                        </label>
                      );
                    return (
                      <a key={`task:${task.taskId}`} href={path} onClick={open(path)} className={CARD}>
                        <span className="text-xs font-semibold text-accent">Operator task · {humanizeToken(task.status)}</span>
                        <span className="mt-1 line-clamp-3 block text-sm font-medium text-fg">{task.title}</span>
                        <span className="mt-2 block text-xs text-fg-muted">
                          Updated {formattedWorkTime(task.updatedAt)}
                        </span>
                      </a>
                    );
                  }
                  const run = item.run;
                  const path = `/work/runs/${encodeURIComponent(run.runId)}`;
                  return (
                    <a key={`run:${run.runId}`} href={path} onClick={open(path)} className={CARD}>
                      <span className="text-xs font-semibold text-accent">Runtime run</span>
                      <span className="line-clamp-3 text-sm font-medium text-fg">{workRunTitle(run)}</span>
                      <span className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <StatusBadge status={presentRunStatus(run.status)} />
                        <span className="text-xs text-fg-muted">{formattedWorkTime(run.updatedAt)}</span>
                      </span>
                      {run.lastError || run.recoverySummary ? <span className="mt-2 block text-xs text-status-failed">{run.lastError ?? run.recoverySummary}</span> : null}
                    </a>
                  );
                }}
              </WindowedRecordList>
              </section>)}
              {column.id === "done" ? <p className="mt-2 text-xs text-fg-muted">Overview shows up to 25 matching tasks and 25 matching runs. <NativeOwnerLink href="/work/history" scope={workspaceId}>Open run history</NativeOwnerLink> or <NativeOwnerLink href="/work/kanban" scope={workspaceId}>all loaded task actions</NativeOwnerLink> for older records.</p> : null}
              {!runs.isError && !tasks.isError && !board?.[column.id].length && !taskBoard?.[column.id].length ? (
                <p className="text-xs text-fg-muted">No recent work in this state.</p>
              ) : null}
            </section>
          ))}
        </div>
      ) : null}
      {runs.hasNextPage ? (
        <Button size="sm" variant="secondary" disabled={runs.isFetching} onClick={() => void runs.fetchNextPage()}>
          {runs.isFetchingNextPage ? "Loading runs…" : "Load more runs"}
        </Button>
      ) : null}
      {!tasks.isError && tasks.hasNextPage ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={tasks.isFetchingNextPage}
          onClick={() => void tasks.fetchNextPage()}
        >
          {tasks.isFetchingNextPage ? "Loading tasks…" : "Load more tasks"}
        </Button>
      ) : null}
      <p className="text-sm text-fg-muted">
        Open a task or run for owner evidence and available controls. Additional recovery options remain in the{" "}
        <ClassicOwnerLink
          className="font-medium text-accent underline-offset-2 hover:underline"
          href="/ops/kanban?shell=classic"
          scope={workspaceId}
          label="classic Kanban view"
        />
        .
      </p>
    </section>
  );
}
