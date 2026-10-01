import { canonicalJsonString } from "@goatcitadel/contracts";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { fetchTask, fetchTaskDeliverables, updateTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { fetchAgents } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { acquireTaskMutations, taskMutationKey } from "./task-mutation-state";

export type TaskDetailChange =
  | { kind: "details"; title: string; description: string; priority: TaskRecord["priority"] }
  | { kind: "status"; status: TaskRecord["status"] }
  | { kind: "assignment"; assignedAgentId: string | null };
export const taskRecordsEqual = (left: TaskRecord, right: TaskRecord) =>
  canonicalJsonString(left) === canonicalJsonString(right);
export type TaskDetailResult =
  | { kind: "confirmed"; task: TaskRecord }
  | { kind: "blocked" | "cancelled" | "uncertain"; message: string };

export async function commitTaskDetailReview(review: {
  task: TaskRecord;
  workspaceId: string;
  base: string;
  change: TaskDetailChange;
  current: () => boolean;
}): Promise<TaskDetailResult> {
  const { task: before, workspaceId, base, change } = review;
  const current = () => review.current() && getGatewayApiBaseUrl() === base;
  if (!current()) return { kind: "cancelled", message: "The task review changed before dispatch." };
  const admission = acquireTaskMutations([taskMutationKey(base, workspaceId, before.taskId)]);
  if (!admission)
    return { kind: "blocked", message: "This task has a pending or unconfirmed action in this app session." };
  let dispatched = false;
  const installation = () => {
    if (getGatewayApiBaseUrl() !== base) throw new Error("The original Gateway installation is no longer selected.");
  };
  const read = async () => {
    installation();
    const record = await fetchTask(before.taskId, workspaceId, undefined, { signal: new AbortController().signal });
    installation();
    if (record.taskId !== before.taskId || (record.workspaceId ?? "default") !== workspaceId || record.deletedAt)
      throw new Error("Task evidence does not match the reviewed workspace and identity.");
    return record;
  };
  try {
    const fresh = await read();
    if (!current()) return { kind: "cancelled", message: "The task review changed before dispatch." };
    if (
      !taskRecordsEqual(before, fresh) ||
      fresh.agenticContext ||
      fresh.proactiveContext ||
      (fresh.status === "done" && change.kind !== "status") ||
      (change.kind === "status" && fresh.status === change.status)
    )
      return {
        kind: "blocked",
        message: "This task changed during review. Refresh its current record before editing.",
      };
    if (change.kind === "assignment" && change.assignedAgentId) {
      const agents = await fetchAgents("active", 300, { signal: new AbortController().signal });
      if (!current()) return { kind: "cancelled", message: "The assignment review changed before dispatch." };
      if (!agents.items.some((agent) => agent.agentId === change.assignedAgentId && agent.lifecycleStatus === "active"))
        return {
          kind: "blocked",
          message: "The selected agent is no longer in the active catalog. Refresh and choose again.",
        };
    }
    if (change.kind === "status" && change.status === "done") {
      const deliverables = await fetchTaskDeliverables(before.taskId, workspaceId, undefined, {
        signal: new AbortController().signal,
      });
      if (!current()) return { kind: "cancelled", message: "The task review changed before dispatch." };
      if (!deliverables.items.length || deliverables.items.some((item) => item.taskId !== before.taskId))
        return { kind: "blocked", message: "Done requires a current deliverable from this task's owner." };
    }
    if (!current()) return { kind: "cancelled", message: "The task review changed before dispatch." };
    const fields =
      change.kind === "details"
        ? { title: change.title, description: change.description, priority: change.priority }
        : change.kind === "status"
          ? { status: change.status }
          : { assignedAgentId: change.assignedAgentId };
    dispatched = true;
    const receipt = await updateTask(before.taskId, { workspaceId, expectedRevision: fresh.revision, ...fields });
    installation();
    const expected: TaskRecord = {
      ...fresh,
      ...fields,
      revision: fresh.revision + 1,
      updatedAt: receipt.updatedAt,
      assignedAgentId: change.kind === "assignment" ? (change.assignedAgentId ?? undefined) : fresh.assignedAgentId,
    };
    if (!taskRecordsEqual(receipt, expected)) throw new Error("The task receipt differs from the reviewed change.");
    const saved = await read();
    if (!taskRecordsEqual(saved, receipt)) throw new Error("The task readback differs from the mutation receipt.");
    return { kind: "confirmed", task: saved };
  } catch (cause) {
    if (dispatched) {
      const message =
        "The task action outcome is unconfirmed. Further actions for this task are locked in both shells for this app session. Inspect its current Gateway record before continuing.";
      admission.uncertain(message);
      return { kind: "uncertain", message };
    }
    return {
      kind: "blocked",
      message: cause instanceof Error ? cause.message : "The task owner could not be checked.",
    };
  } finally {
    admission.settle();
  }
}
