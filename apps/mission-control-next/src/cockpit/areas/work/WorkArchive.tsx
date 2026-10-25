import { useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { TaskRecord } from "@goatcitadel/contracts";
import { fetchTasksByView } from "@goatcitadel/mission-control-shared/api/tasks";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { presentTaskStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { performTaskArchiveAction } from "../../../features/native-routes/ops/task-archive-operation";
import {
  readTaskMutation,
  taskMutationKey,
  useTaskMutations,
} from "../../../features/native-routes/ops/task-mutation-state";
import { useIsMounted } from "../../../hooks/use-is-mounted";
import { RefreshCw } from "lucide-react";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { EmptyState } from "../../ui/EmptyState";
import { Field } from "../../ui/Field";
import { WindowedRecordList } from "../../ui/WindowedRecordList";
import { StatusBadge } from "../../ui/StatusBadge";
import { useActiveWorkspaceLabel } from "../../data/use-workspace-name";

export function WorkArchive() {
  const { activeWorkspaceId } = useUiPreferences();
  return <ArchiveWorkspace key={activeWorkspaceId ?? "default"} workspaceId={activeWorkspaceId ?? "default"} />;
}
function ArchiveWorkspace({ workspaceId }: { workspaceId: string }) {
  const [view, setView] = useState<"active" | "trash">("trash");
  const [review, setReview] = useState<TaskRecord | null>(null);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const generation = useRef(0);
  const mounted = useIsMounted();
  useTaskMutations();
  const base = getGatewayApiBaseUrl();
  const workspaceLabel = useActiveWorkspaceLabel();
  const tasks = useInfiniteQuery({
    queryKey: ["tasks", "archive", workspaceId, view],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      fetchTasksByView(view, undefined, workspaceId, {
        limit: 100,
        cursor: pageParam || undefined,
      }),
    getNextPageParam: (page) => page.nextCursor,
    refetchOnMount: "always",
  });
  const available = tasks.isSuccess && tasks.isFetchedAfterMount && !tasks.isFetching && !tasks.isPlaceholderData;
  const listed = tasks.isSuccess
    ? tasks.data.pages
        .flatMap((page) => page.items)
        .filter(
          (task) =>
            (task.workspaceId ?? "default") === workspaceId && task.title.toLowerCase().includes(search.toLowerCase()),
        )
    : undefined;
  const locked = review ? readTaskMutation(taskMutationKey(base, workspaceId, review.taskId)).phase !== "idle" : false;
  async function confirm() {
    if (!review || !available || locked) return;
    const identity = generation.current;
    try {
      const saved = await performTaskArchiveAction(
        review,
        workspaceId,
        view === "trash" ? "restore" : "archive",
        () => mounted() && generation.current === identity,
      );
      if (saved) {
        setReview(null);
        setMessage(
          view === "trash"
            ? "Task restored and independently verified."
            : "Task archived and independently verified. Restore it from Archived tasks.",
        );
        await tasks.refetch();
      }
    } catch (error) {
      if (mounted()) setMessage(describeApiError(error).summary);
    }
  }
  return (
    <section className={AREA_PAGE}>
      <AreaHeader
        title="Archived tasks"
        description="Workspace operator tasks. Archive removes a task from active lists and can be reversed. It does not cancel a run."
        actions={
          <Button
            size="sm"
            disabled={tasks.isFetching || locked}
            onClick={() => {
              generation.current++;
              setReview(null);
              void tasks.refetch();
            }}
          >
            <RefreshCw aria-hidden="true" className="size-4" /> Refresh tasks
          </Button>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Task list">
          {(props) => (
            <select
              {...props}
              value={view}
              className="rounded-md border border-line bg-sunken p-2"
              onChange={(event) => {
                generation.current++;
                setReview(null);
                setView(event.target.value as typeof view);
              }}
            >
              <option value="trash">Archived tasks</option>
              <option value="active">Active tasks to archive</option>
            </select>
          )}
        </Field>
        <Field label="Search loaded tasks">
          {(props) => (
            <input
              {...props}
              value={search}
              className="rounded-md border border-line bg-sunken p-2"
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </Field>
      </div>
      {message ? (
        <p role="status" className="text-sm text-fg-secondary">
          {message}
        </p>
      ) : null}
      {tasks.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading tasks…
        </p>
      ) : null}
      {tasks.isError ? (
        <EmptyState title="Task archive unavailable" description={describeApiError(tasks.error).summary} />
      ) : null}
      {listed && !listed.length && !tasks.hasNextPage ? (
        <EmptyState
          title={
            search ? "No loaded tasks match the search" : view === "trash" ? "No archived tasks" : "No active tasks"
          }
          description={
            view === "trash"
              ? "Tasks you archive appear here, ready to restore."
              : "Active workspace tasks appear here, ready to archive."
          }
        />
      ) : null}
      {listed?.length ? (
        <WindowedRecordList label="Archive tasks" items={listed} itemKey={(task) => task.taskId}>
          {(task) => (
            <article className="border-b border-line-subtle py-3">
              <h2 className="text-sm font-medium text-fg">{task.title}</h2>
              <p className="flex flex-wrap items-center gap-2 text-xs text-fg-secondary">
                Operator task <StatusBadge status={presentTaskStatus(task.status)} />
              </p>
              <Button
                disabled={
                  !available ||
                  readTaskMutation(taskMutationKey(base, workspaceId, task.taskId)).phase !== "idle" ||
                  Boolean(task.agenticContext || task.proactiveContext)
                }
                onClick={() => {
                  generation.current++;
                  setReview(task);
                }}
              >
                {view === "trash" ? "Review restore" : "Review archive"}
                <span className="sr-only">: {task.title}</span>
              </Button>
              {task.agenticContext || task.proactiveContext ? (
                <p className="text-sm text-fg-secondary">
                  A run or background job manages this task, so it can't be archived or restored here.
                </p>
              ) : null}
            </article>
          )}
        </WindowedRecordList>
      ) : null}
      {tasks.hasNextPage ? (
        <Button className="self-start" disabled={tasks.isFetching} onClick={() => void tasks.fetchNextPage()}>
          Load more tasks
        </Button>
      ) : null}
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open) {
            generation.current++;
            setReview(null);
          }
        }}
        title={view === "trash" ? "Restore this task?" : "Archive this task?"}
        description={`${review?.title ?? "Task"} · ${workspaceLabel}. The task is rechecked before anything is saved.`}
      >
        <div className="grid gap-3 text-sm">
          <p>
            {view === "trash"
              ? "This task returns to active task lists."
              : "This task leaves active task lists. You can restore it from Archived tasks."}
          </p>
          {review ? <p>{readTaskMutation(taskMutationKey(base, workspaceId, review.taskId)).message}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={!available || locked} onClick={() => void confirm()}>
              {view === "trash" ? "Restore task" : "Archive task"}
            </Button>
            <Button
              disabled={locked}
              onClick={() => {
                generation.current++;
                setReview(null);
              }}
            >
              Keep task
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
