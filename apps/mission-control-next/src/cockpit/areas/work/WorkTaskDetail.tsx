import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchTask, fetchTaskActivities, fetchTaskDeliverables } from "@goatcitadel/mission-control-shared/api/tasks";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { TaskStatusControl } from "./TaskStatusControl";
import { EmptyState } from "../../ui/EmptyState";
import { taskMatchesWorkspace } from "./work-tasks";
import { TaskAssignmentControl } from "./TaskAssignmentControl";
import { TaskDetailsEditor } from "./TaskDetailsEditor";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

function formattedTime(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed)
    : "Time unavailable";
}

export function WorkTaskDetail({ taskId }: { taskId: string }) {
  const { navigate } = useCockpitRoute();
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const taskQuery = useQuery({
    queryKey: ["tasks", "work-task", workspaceId, taskId],
    refetchOnMount: "always",
    queryFn: () => fetchTask(taskId, workspaceId),
    refetchInterval: 30_000,
  });
  const task =
    !taskQuery.isError && taskQuery.data && taskMatchesWorkspace(taskQuery.data, workspaceId)
      ? taskQuery.data
      : undefined;
  const taskSessionId = task?.proactiveContext?.sessionId ?? task?.agenticContext?.childSessionId ?? task?.agenticContext?.parentSessionId;
  const activities = useQuery({
    queryKey: ["tasks", "work-task-activities", workspaceId, taskId],
    queryFn: () => fetchTaskActivities(taskId, workspaceId),
    enabled: Boolean(task),
    refetchInterval: 30_000,
  });
  const deliverables = useQuery({
    queryKey: ["tasks", "work-task-deliverables", workspaceId, taskId],
    queryFn: () => fetchTaskDeliverables(taskId, workspaceId),
    enabled: Boolean(task),
    refetchInterval: 30_000,
  });

  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <a
        href="/work"
        onClick={(event) => {
          event.preventDefault();
          navigate("/work");
        }}
        className="inline-flex items-center gap-2 text-sm text-accent"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to Work
      </a>
      {taskQuery.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading task…
        </p>
      ) : null}
      {taskQuery.isError ? (
        <EmptyState
          title="Task unavailable"
          description={describeApiError(taskQuery.error).summary}
          action={<Button onClick={() => void taskQuery.refetch()}>Try again</Button>}
        />
      ) : null}
      {taskQuery.data && !task && !taskQuery.isError ? (
        <EmptyState
          title="Task outside this workspace"
          description="This task has no matching active workspace record."
        />
      ) : null}
      {!taskQuery.isLoading && !taskQuery.isError && !taskQuery.data ? <EmptyState title="Task not found" description="The Gateway returned no task record for this link." /> : null}
      {task ? (
        <>
          <header>
            <p className="text-xs font-semibold text-accent">Task record</p>
            <h1 className="font-display text-xl font-semibold text-fg">{task.title}</h1>
            <p className="mt-1 text-xs text-fg-muted">
              {humanizeToken(task.status)} · {humanizeToken(task.priority)} priority · Updated{" "}
              {formattedTime(task.updatedAt)}
            </p>
          </header>
          {task.distressSignals?.filter(signal => !signal.resolvedAt).map(signal => <p key={signal.signalId} role="status" className="rounded-md border border-line p-3 text-sm text-fg-secondary">{signal.title}: {signal.summary}</p>)}
          {task.status === "blocked" && !task.distressSignals?.some(signal => !signal.resolvedAt) ? <p className="text-sm text-fg-secondary">This task is blocked. No blocker reason was recorded; review its activity.</p> : null}
          {task.proactiveContext?.durableRunId || task.agenticContext?.durableRunId ? <NativeOwnerLink scope={[workspaceId, taskId]} href={`/work/runs/${encodeURIComponent((task.proactiveContext?.durableRunId ?? task.agenticContext?.durableRunId)!)}`}>Open linked runtime run</NativeOwnerLink> : null}
          {taskSessionId ? <NativeOwnerLink scope={[workspaceId, taskId]} href={`/chat?sessionId=${encodeURIComponent(taskSessionId)}`}>Open linked conversation</NativeOwnerLink> : null}
          {task.description ? (
            <section className="rounded-lg border border-line bg-raised p-4">
              <h2 className="font-display text-lg font-semibold text-fg">Description</h2>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-fg-secondary">{task.description}</p>
            </section>
          ) : null}
          <fieldset disabled={taskQuery.isFetching || !taskQuery.isFetchedAfterMount || taskQuery.isPlaceholderData} className="grid gap-4">
          <TaskStatusControl
            key={`${workspaceId}:${task.taskId}`}
            task={task}
            workspaceId={workspaceId}
            canMarkDone={!deliverables.isError && Boolean(deliverables.data?.items.length)}
          />
          <TaskAssignmentControl
            key={`${workspaceId}:${task.taskId}:assignment`}
            task={task}
            workspaceId={workspaceId}
          />
          <TaskDetailsEditor key={`${workspaceId}:${task.taskId}:details`} task={task} workspaceId={workspaceId} />
          </fieldset>
          <div className="grid gap-3 md:grid-cols-2">
            <section className="rounded-lg border border-line bg-raised p-4">
              <h2 className="font-display text-lg font-semibold text-fg">Activity</h2>
              {activities.isLoading ? <p className="mt-2 text-sm text-fg-muted">Loading activity…</p> : null}
              {activities.isError ? (
                <p role="alert" className="mt-2 text-sm text-status-failed">
                  Activity unavailable: {describeApiError(activities.error).summary}
                </p>
              ) : null}
              {!activities.isError && activities.data?.items.length ? (
                <ol className="mt-2 grid gap-2">
                  {activities.data.items.slice(0, 20).map((item) => (
                    <li key={item.activityId} className="border-b border-line-subtle py-2 text-sm">
                      <p className="break-words text-fg">{item.message}</p>
                      <p className="text-xs text-fg-muted">
                        {humanizeToken(item.activityType)} · {formattedTime(item.createdAt)}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : activities.data && !activities.isError ? (
                <p className="mt-2 text-sm text-fg-muted">No activity was returned.</p>
              ) : null}
              {!activities.isError && activities.data && activities.data.items.length >= 200 ? (
                <p className="mt-2 text-xs text-fg-muted">The owner returns at most 200 recent activities.</p>
              ) : null}
            </section>
            <section className="rounded-lg border border-line bg-raised p-4">
              <h2 className="font-display text-lg font-semibold text-fg">Deliverables</h2>
              {deliverables.isLoading ? <p className="mt-2 text-sm text-fg-muted">Loading deliverables…</p> : null}
              {deliverables.isError ? (
                <p role="alert" className="mt-2 text-sm text-status-failed">
                  Deliverables unavailable: {describeApiError(deliverables.error).summary}
                </p>
              ) : null}
              {!deliverables.isError && deliverables.data?.items.length ? (
                <ul className="mt-2 grid gap-2">
                  {deliverables.data.items.slice(0, 20).map((item) => (
                    <li key={item.deliverableId} className="border-b border-line-subtle py-2 text-sm">
                      <p className="break-words font-medium text-fg">{item.title}</p>
                      {item.description ? <p className="break-words text-fg-secondary">{item.description}</p> : null}
                      <p className="text-xs text-fg-muted">
                        {humanizeToken(item.deliverableType)} · {formattedTime(item.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : deliverables.data && !deliverables.isError ? (
                <p className="mt-2 text-sm text-fg-muted">No deliverables were returned.</p>
              ) : null}
              {!deliverables.isError && deliverables.data && deliverables.data.items.length >= 200 ? (
                <p className="mt-2 text-xs text-fg-muted">The owner returns at most 200 recent deliverables.</p>
              ) : null}
            </section>
          </div>
          <p className="text-sm text-fg-muted">
            For other task details and controls, open the{" "}
            <ClassicOwnerLink
              href={`/ops/kanban?taskId=${encodeURIComponent(task.taskId)}&shell=classic`}
              scope={`${workspaceId}:${task.taskId}`}
              label="classic Kanban view"
              className="font-medium text-accent"
            />
            .
          </p>
        </>
      ) : null}
    </section>
  );
}
