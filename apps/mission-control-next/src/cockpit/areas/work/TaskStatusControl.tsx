import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TaskRecord } from "@goatcitadel/contracts";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useTaskDetailReview } from "../../../features/native-routes/ops/use-task-detail-review";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { TASK_STATUSES } from "./work-tasks";

export function TaskStatusControl({
  task,
  workspaceId,
  canMarkDone,
}: {
  task: TaskRecord;
  workspaceId: string;
  canMarkDone: boolean;
}) {
  const queryClient = useQueryClient();
  const owner = useTaskDetailReview(task, workspaceId);
  const [target, setTarget] = useState(task.status);
  const [notice, setNotice] = useState("");
  const executionOwned = Boolean(task.agenticContext || task.proactiveContext);
  async function changeStatus() {
    await owner.confirm((updated) => {
      setTarget(updated.status);
      setNotice(
        `Gateway recorded ${humanizeToken(updated.status).toLowerCase()} for this task. This board change does not control an execution.`,
      );
      void Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["tasks", "work-task", workspaceId, updated.taskId] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workTasks(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) }),
      ]);
    }, { kind: "status", status: target });
  }
  return (
    <section aria-label="Task status" className="rounded-lg border border-line bg-raised p-4">
      <h2 className="font-display text-lg font-semibold text-fg">Task status</h2>
      {executionOwned ? (
        <p className="mt-2 text-sm text-fg-secondary">
          This task has a runtime execution owner. Review its run before changing execution state.
        </p>
      ) : (
        <p className="mt-2 text-sm text-fg-secondary">
          This control changes the task board record. It does not start, stop, or resume a run.
        </p>
      )}
      {!executionOwned && !owner.uncertain ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="grid min-w-40 gap-1 text-sm text-fg-secondary">
            Status
            <select
              aria-label="Status"
              value={target}
              disabled={owner.locked}
              onChange={(event) => {
                owner.invalidate();
                setTarget(event.target.value as TaskRecord["status"]);
              }}
              className="min-h-10 rounded-md border border-line bg-sunken px-3 text-fg"
            >
              {TASK_STATUSES.filter((status) => status !== "done" || canMarkDone || task.status === "done").map(
                (status) => (
                  <option key={status} value={status}>
                    {humanizeToken(status)}
                  </option>
                ),
              )}
            </select>
          </label>
          <Button
            size="sm"
            disabled={owner.locked || target === task.status}
            onClick={() => {
              void changeStatus();
              setNotice("");
            }}
          >
            Save task status
          </Button>
        </div>
      ) : null}
      {!executionOwned && !canMarkDone && task.status !== "done" ? (
        <p className="mt-2 text-xs text-fg-muted">
          Done requires at least one recorded deliverable. The option appears when the owner confirms one.
        </p>
      ) : null}
      {owner.busy ? (
        <p role="status" className="mt-2 text-sm text-fg-muted">
          Checking the task and requesting the change…
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-2 text-sm text-status-done">
          {notice}
        </p>
      ) : null}
      {owner.message ? (
        <p role="alert" className="mt-2 text-sm text-status-failed">
          {owner.message}
        </p>
      ) : null}
      {owner.uncertain ? (
        <ClassicOwnerLink
          href={`/ops/kanban?taskId=${encodeURIComponent(task.taskId)}&shell=classic`}
          scope={`${workspaceId}:${task.taskId}`}
          label="Review task in Ops"
        />
      ) : null}

    </section>
  );
}
