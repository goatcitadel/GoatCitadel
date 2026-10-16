import { useId, useState, type MouseEvent } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { presentRunStatus, presentTaskStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { isModifiedClick } from "../../lib/modified-click";
import { projectWorkBoard, workRunTitle, type WorkBoardGroup } from "./work-board";
import { projectWorkTasks } from "./work-tasks";
import { WorkTaskCreate } from "./WorkTaskCreate";
import { useWorkspaceDurableRuns } from "./useWorkspaceDurableRuns";
import { workspaceTasksOptions } from "./work-queries";
import { WorkWaitingDecisions } from "./WorkWaitingDecisions";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { recordView } from "../../data/record-view";
import { workColumnStatus } from "./work-column-status";
import { WorkTaskBulkActions } from "./WorkTaskBulkActions";
import { WorkBoardColumn } from "./WorkBoardColumn";

const COLUMNS: readonly { id: WorkBoardGroup; title: string; description: string }[] = [
  { id: "running", title: "Active", description: "Tasks being prepared or worked; runs queued or executing" },
  { id: "waiting", title: "Needs attention", description: "Tasks in inbox, blocked or review; runs waiting or paused" },
  { id: "failed", title: "Failed runs", description: "Run failures and recovery" },
  { id: "done", title: "Done", description: "Completed or cancelled" },
];
/** The Done column is an overview; history and the Kanban own older records. */
const DONE_LIMIT = 25;
const CONTROL = "rounded-md border border-line bg-sunken py-2 text-sm text-fg";

export function WorkBoard() {
  const { navigate } = useCockpitRoute();
  const searchId = useId();
  const kindId = useId();
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
  const taskBoard = tasks.data
    ? projectWorkTasks(
        tasks.data.pages.flatMap((page) => page.items),
        workspaceId,
      )
    : null;
  const loadedTasks = taskBoard ? Object.values(taskBoard).flat() : [];
  const taskView = recordView(tasks);
  const runView = recordView(runs);
  const query = search.trim().toLowerCase();
  const taskMatches = (task: (typeof loadedTasks)[number]) =>
    `${task.title} ${task.status} ${presentTaskStatus(task.status).label} ${task.description ?? ""}`
      .toLowerCase()
      .includes(query);
  const limit = (group: WorkBoardGroup) => (group === "done" ? DONE_LIMIT : undefined);
  const visibleTasks = (group: WorkBoardGroup) =>
    kind === "run" ? [] : (taskBoard?.[group] ?? []).filter(taskMatches).slice(0, limit(group));
  const visibleRuns = (group: WorkBoardGroup) =>
    kind === "task"
      ? []
      : (board?.[group] ?? [])
          .filter((run) =>
            `${workRunTitle(run)} ${run.status} ${presentRunStatus(run.status).label} ${run.lastError ?? ""}`
              .toLowerCase()
              .includes(query),
          )
          .slice(0, limit(group));
  // A bulk action applies only to the selected tasks the operator can see; the filter never hides a target.
  const visibleTaskIds = new Set(COLUMNS.flatMap((column) => visibleTasks(column.id).map((task) => task.taskId)));
  const selectedTasks = loadedTasks.filter((task) => selectedIds.has(task.taskId) && visibleTaskIds.has(task.taskId));
  const hiddenSelected = loadedTasks.filter(
    (task) => selectedIds.has(task.taskId) && !visibleTaskIds.has(task.taskId),
  ).length;
  const toggle = (taskId: string) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  const open = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (isModifiedClick(event)) return;
    event.preventDefault();
    navigate(path);
  };
  return (
    <section className={`${AREA_PAGE} min-h-full`}>
      <AreaHeader
        title="Work"
        description="Workspace tasks and recent Chat or supervised plan runs."
        actions={
          <>
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
          </>
        }
      />
      <WorkWaitingDecisions workspaceId={workspaceId} />
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={searchId} className="sr-only">
          Search loaded work
        </label>
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
          />
          <input
            id={searchId}
            type="search"
            value={search}
            placeholder="Search loaded tasks and runs"
            onChange={(event) => setSearch(event.target.value)}
            className={`${CONTROL} w-full pl-8 pr-2 placeholder:text-fg-muted`}
          />
        </div>
        <label htmlFor={kindId} className="sr-only">
          Record type
        </label>
        <select
          id={kindId}
          value={kind}
          onChange={(event) => setKind(event.target.value)}
          className={`${CONTROL} px-2`}
        >
          <option value="all">Tasks and runs</option>
          <option value="task">Operator tasks</option>
          <option value="run">Runs</option>
        </select>
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
      {selecting && hiddenSelected ? (
        <p role="status" className="text-sm text-fg-secondary">
          {hiddenSelected === 1
            ? "1 selected task is hidden by the filter and won't change."
            : `${hiddenSelected} selected tasks are hidden by the filter and won't change.`}
        </p>
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
      {board || taskBoard ? (
        <>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {COLUMNS.map((column) => (
              <WorkBoardColumn
                key={column.id}
                title={column.title}
                description={column.description}
                count={`${workColumnStatus(taskView, taskBoard?.[column.id].length, "tasks")} · ${workColumnStatus(runView, board?.[column.id].length, "runs")}`}
                tasks={visibleTasks(column.id)}
                runs={visibleRuns(column.id)}
                empty={!runs.isError && !tasks.isError && !board?.[column.id].length && !taskBoard?.[column.id].length}
                selecting={selecting}
                selectedIds={selectedIds}
                onToggle={toggle}
                onOpen={open}
              />
            ))}
          </div>
          <p className="text-xs text-fg-muted">
            {`Counts cover only loaded records; records without matching workspace evidence are omitted. Done shows up to ${DONE_LIMIT} matching tasks and ${DONE_LIMIT} matching runs. `}
            <NativeOwnerLink href="/work/history" scope={workspaceId}>
              Open run history
            </NativeOwnerLink>
            {" or "}
            <NativeOwnerLink href="/work/kanban" scope={workspaceId}>
              the Kanban
            </NativeOwnerLink>
            {" for older records."}
          </p>
        </>
      ) : null}
      {!tasks.isError && tasks.hasNextPage ? (
        <p className="text-xs text-fg-muted">More tasks exist beyond the loaded pages.</p>
      ) : null}
      {runs.hasNextPage || (!tasks.isError && tasks.hasNextPage) ? (
        <div className="flex flex-wrap gap-2">
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
        </div>
      ) : null}
    </section>
  );
}
