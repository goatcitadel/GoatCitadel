import { useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { TaskRecord } from "@goatcitadel/contracts";
import { fetchTasksByView } from "@goatcitadel/mission-control-shared/api/tasks";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { performTaskArchiveAction } from "../../../features/native-routes/ops/task-archive-operation";
import {
  readTaskMutation,
  taskMutationKey,
  useTaskMutations,
} from "../../../features/native-routes/ops/task-mutation-state";
import { useIsMounted } from "../../../hooks/use-is-mounted";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { EmptyState } from "../../ui/EmptyState";
import { Field } from "../../ui/Field";
import { WindowedRecordList } from "../../ui/WindowedRecordList";

export function WorkArchive() {
  const { activeWorkspaceId } = useUiPreferences();
  return (
    <ArchiveWorkspace
      key={activeWorkspaceId ?? "default"}
      workspaceId={activeWorkspaceId ?? "default"}
    />
  );
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
  const available =
    tasks.isSuccess && tasks.isFetchedAfterMount && !tasks.isFetching && !tasks.isPlaceholderData;
  const locked = review
    ? readTaskMutation(taskMutationKey(base, workspaceId, review.taskId)).phase !== "idle"
    : false;
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
    <section className="mx-auto grid max-w-5xl gap-4 p-4 sm:p-6">
      <h1 className="font-display text-xl font-semibold text-fg">Task archive and restore</h1>
      <p className="text-sm text-fg-secondary">
        Workspace operator tasks. Archive removes a task from active lists and can be reversed. It
        does not cancel a runtime run.
      </p>
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
      <Button
        disabled={tasks.isFetching || locked}
        onClick={() => {
          generation.current++;
          setReview(null);
          void tasks.refetch();
        }}
      >
        Refresh tasks
      </Button>
      {message ? <p role="status">{message}</p> : null}
      {tasks.isLoading ? <p role="status">Loading tasks…</p> : null}
      {tasks.isError ? (
        <EmptyState
          title="Task archive unavailable"
          description={describeApiError(tasks.error).summary}
        />
      ) : null}
      {tasks.isSuccess ? (
        <WindowedRecordList
          label="Archive tasks"
          items={tasks.data.pages
            .flatMap((page) => page.items)
            .filter(
              (task) =>
                (task.workspaceId ?? "default") === workspaceId &&
                task.title.toLowerCase().includes(search.toLowerCase()),
            )}
          itemKey={(task) => task.taskId}
        >
          {(task) => (
            <article className="rounded-md border border-line p-3">
              <h2 className="text-sm font-medium text-fg">{task.title}</h2>
              <p className="text-xs text-fg-secondary">Operator task · {task.status}</p>
              <Button
                disabled={
                  !available ||
                  readTaskMutation(taskMutationKey(base, workspaceId, task.taskId)).phase !==
                    "idle" ||
                  Boolean(task.agenticContext || task.proactiveContext)
                }
                onClick={() => {
                  generation.current++;
                  setReview(task);
                }}
              >
                {view === "trash" ? "Review restore" : "Review archive"}
              </Button>
              {task.agenticContext || task.proactiveContext ? (
                <p className="text-sm text-fg-secondary">
                  A runtime owns this task. Review its execution before changing lifecycle.
                </p>
              ) : null}
            </article>
          )}
        </WindowedRecordList>
      ) : null}
      {tasks.hasNextPage ? (
        <Button disabled={tasks.isFetching} onClick={() => void tasks.fetchNextPage()}>
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
        description={`${review?.title ?? "Task"} · Workspace ${workspaceId}. Revision is rechecked before persistence.`}
      >
        <div className="grid gap-3 text-sm">
          <p>
            {view === "trash"
              ? "This task returns to active task lists."
              : "This task leaves active task lists. You can restore it from Archived tasks."}
          </p>
          {review ? (
            <p>{readTaskMutation(taskMutationKey(base, workspaceId, review.taskId)).message}</p>
          ) : null}
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
      </Dialog>
    </section>
  );
}
