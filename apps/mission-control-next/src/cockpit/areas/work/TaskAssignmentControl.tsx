import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { fetchAgents } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { useTaskDetailReview } from "../../../features/native-routes/ops/use-task-detail-review";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";

export function TaskAssignmentControl({ task, workspaceId }: { task: TaskRecord; workspaceId: string }) {
  const client = useQueryClient();
  const agents = useQuery({
    queryKey: ["work", "active-agents"],
    queryFn: () => fetchAgents("active", 300),
    staleTime: 60_000,
  });
  const [target, setTarget] = useState(task.assignedAgentId ?? "");
  const owner = useTaskDetailReview(task, workspaceId);
  const { busy, uncertain } = owner;
  const [notice, setNotice] = useState<string | null>(null);
  const error = owner.message;
  const reviewed =
    owner.review?.change.kind === "assignment"
      ? { task: owner.review.task, target: owner.review.change.assignedAgentId }
      : null;
  const executionOwned = Boolean(task.agenticContext || task.proactiveContext);
  const active = agents.isError ? [] : (agents.data?.items.filter((item) => item.lifecycleStatus === "active") ?? []);
  const currentAgent = active.find((item) => item.agentId === task.assignedAgentId);
  const targetAgent = active.find((item) => item.agentId === target);
  const canReview =
    !executionOwned &&
    task.status !== "done" &&
    !agents.isError &&
    agents.data &&
    !owner.locked &&
    target !== (task.assignedAgentId ?? "") &&
    (!target || Boolean(targetAgent));

  async function assign(): Promise<void> {
    await owner.confirm((updated) => {
      setTarget(updated.assignedAgentId ?? "");
      setNotice("Gateway recorded the task assignment. This does not start a run or transfer runtime ownership.");
      void Promise.allSettled([
        client.invalidateQueries({ queryKey: ["tasks", "work-task", workspaceId, updated.taskId] }),
        client.invalidateQueries({ queryKey: queryKeys.workTasks(workspaceId) }),
      ]);
    });
  }

  return (
    <section aria-label="Task assignment" className="rounded-lg border border-line bg-raised p-4">
      <h2 className="font-display text-lg font-semibold text-fg">Task assignment</h2>
      <p className="mt-1 text-sm text-fg-secondary">
        Assign a board owner. This does not launch, resume, or transfer a running execution.
      </p>
      {task.assignedAgentId && !currentAgent && !agents.isLoading ? (
        <p className="mt-2 text-sm text-fg-muted">The current owner is outside the active agent list.</p>
      ) : null}
      {executionOwned ? (
        <p className="mt-2 text-sm text-fg-muted">
          A runtime execution owns this task. Review its run before changing ownership.
        </p>
      ) : null}
      {task.status === "done" ? (
        <p className="mt-2 text-sm text-fg-muted">Completed tasks are not available for reassignment here.</p>
      ) : null}
      {agents.isLoading ? (
        <p role="status" className="mt-2 text-sm text-fg-muted">
          Loading active agents…
        </p>
      ) : null}
      {agents.isError ? (
        <p role="alert" className="mt-2 text-sm text-status-failed">
          Agents unavailable: {describeApiError(agents.error).summary}
        </p>
      ) : null}
      {!executionOwned && task.status !== "done" && agents.data && !agents.isError && !uncertain ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="grid min-w-40 flex-1 gap-1 text-sm text-fg-secondary">
            Agent
            <select
              aria-label="Agent"
              value={target}
              disabled={busy}
              onChange={(event) => {
                setTarget(event.target.value);
                owner.invalidate();
              }}
              className="min-h-10 rounded-md border border-line bg-sunken px-3 text-fg"
            >
              <option value="">Unassigned</option>
              {task.assignedAgentId && !currentAgent ? (
                <option value={task.assignedAgentId}>Current agent unavailable</option>
              ) : null}
              {active.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            disabled={!canReview}
            onClick={() => {
              owner.begin(task, { kind: "assignment", assignedAgentId: target || null });
              setNotice(null);
            }}
          >
            Review assignment
          </Button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="mt-2 text-sm text-status-done">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-status-failed">
          {error}
        </p>
      ) : null}
      {uncertain ? (
        <ClassicOwnerLink
          href={`/ops/kanban?taskId=${encodeURIComponent(task.taskId)}&shell=classic`}
          scope={`${workspaceId}:${task.taskId}`}
          label="Review task in Ops"
          className="mt-2 inline-block text-sm font-medium text-accent underline"
        />
      ) : null}
      <Dialog
        open={Boolean(reviewed)}
        onOpenChange={(open) => {
          if (!open && !busy) owner.invalidate();
        }}
        title="Confirm task assignment"
        description={`Change the board owner for ${reviewed?.task.title ?? "this task"} to ${
          reviewed?.target
            ? (active.find((agent) => agent.agentId === reviewed.target)?.name ?? "the selected agent")
            : "unassigned"
        }. The Gateway will check the current task revision. No run starts from this change.`}
      >
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => void assign()}>
            Confirm assignment
          </Button>
          <Button size="sm" disabled={busy} onClick={owner.invalidate}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
