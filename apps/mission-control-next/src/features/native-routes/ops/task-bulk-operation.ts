import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { bulkTaskAction, fetchTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { taskRecordsEqual } from "./task-detail-mutation";
import { acquireTaskMutations, taskMutationKey } from "./task-mutation-state";

export type TaskBulkAction = "unblock" | "retry" | "close";
export type TaskBulkResult =
  | { kind: "confirmed"; tasks: TaskRecord[]; changed: number; matched: number }
  | { kind: "cancelled" }
  | { kind: "locked" | "changed" | "conflict" | "refused" | "uncertain"; message: string };

const UNCERTAIN =
  "The task action outcome is unconfirmed. Further actions for these tasks are locked in both shells for this app session.";

/** Fields a review shows; any change to them after review means the operator approved something else. */
function sameReviewed(reviewed: TaskRecord, current: TaskRecord) {
  return (
    reviewed.taskId === current.taskId &&
    reviewed.workspaceId === current.workspaceId &&
    reviewed.revision === current.revision &&
    reviewed.status === current.status &&
    reviewed.title === current.title
  );
}

/** The bulk owner validates revisions, workspace and deliverables inside its transaction: these refuse before commit. */
function refusedBeforeCommit(error: unknown): error is ApiRequestError {
  return (
    error instanceof ApiRequestError &&
    error.method === "POST" &&
    error.path === "/api/v1/tasks/bulk" &&
    (error.status === 400 || error.status === 404 || error.status === 409)
  );
}

function receiptMatches(action: TaskBulkAction, reviewed: TaskRecord[], tasks: unknown, workspaceId: string) {
  if (!Array.isArray(tasks) || tasks.length !== reviewed.length) return false;
  const byId = new Map((tasks as TaskRecord[]).map((task) => [task.taskId, task]));
  if (byId.size !== reviewed.length) return false;
  return reviewed.every((before) => {
    const after = byId.get(before.taskId);
    if (!after || after.workspaceId !== workspaceId) return false;
    if (after.revision === before.revision + 1) return true;
    // An idempotent action on a task already in the target state keeps its revision.
    if (after.revision !== before.revision) return false;
    if (action === "close") return after.status === "done";
    return (
      action === "unblock" &&
      after.status === "assigned" &&
      (!after.retryBudget || (after.retryBudget.retryCount === 0 && !after.retryBudget.exhaustedAt))
    );
  });
}

/**
 * Applies one reviewed bulk action: fresh owner reads must still match the review, one expected-revision request is
 * sent, and the receipt must match and be confirmed by independent owner reads. Unknown outcomes lock the tasks.
 */
export async function commitTaskBulkAction(input: {
  action: TaskBulkAction;
  reviewed: TaskRecord[];
  workspaceId: string;
  citadelId?: string;
  isCurrent: () => boolean;
}): Promise<TaskBulkResult> {
  const { action, reviewed, workspaceId, citadelId } = input;
  const base = getGatewayApiBaseUrl();
  const current = () => input.isCurrent() && getGatewayApiBaseUrl() === base;
  const ids = reviewed.map((task) => task.taskId);
  const admission = acquireTaskMutations(ids.map((id) => taskMutationKey(base, workspaceId, id)));
  if (!admission)
    return {
      kind: "locked",
      message:
        "A selected task has a pending or unconfirmed action in this app session. Inspect its owner record before continuing.",
    };
  let dispatched = false;
  try {
    const fresh = await Promise.all(
      ids.map((id) => fetchTask(id, workspaceId, citadelId, { signal: new AbortController().signal })),
    );
    if (!current()) return { kind: "cancelled" };
    if (reviewed.some((before, index) => !sameReviewed(before, fresh[index]!)))
      return {
        kind: "changed",
        message: "A selected task changed after your review. Nothing was sent; review the current tasks and try again.",
      };
    const expectedRevisionsByTaskId = Object.fromEntries(reviewed.map((task) => [task.taskId, task.revision]));
    dispatched = true;
    const result = await bulkTaskAction(
      action === "retry"
        ? { action, taskIds: ids, expectedRevisionsByTaskId, reason: "operator-bulk-retry", workspaceId }
        : { action, taskIds: ids, expectedRevisionsByTaskId, workspaceId },
    );
    if (!receiptMatches(action, reviewed, result.tasks, workspaceId)) {
      admission.uncertain(UNCERTAIN);
      return {
        kind: "uncertain",
        message: "The Gateway did not confirm every selected task update. Review their recorded state before retrying.",
      };
    }
    if (getGatewayApiBaseUrl() !== base) {
      admission.uncertain(UNCERTAIN);
      return { kind: "uncertain", message: "The original Gateway installation is no longer selected." };
    }
    const readback = await Promise.all(
      result.tasks.map((task) =>
        fetchTask(task.taskId, workspaceId, citadelId, { signal: new AbortController().signal }),
      ),
    );
    if (
      getGatewayApiBaseUrl() !== base ||
      readback.some((task, index) => !taskRecordsEqual(task, result.tasks[index]!))
    ) {
      admission.uncertain(UNCERTAIN);
      return { kind: "uncertain", message: "Independent task owner reads did not confirm the bulk action receipt." };
    }
    const changed = result.tasks.filter((task) => task.revision > expectedRevisionsByTaskId[task.taskId]!).length;
    return { kind: "confirmed", tasks: result.tasks, changed, matched: ids.length - changed };
  } catch (error) {
    if (!dispatched) return { kind: "refused", message: error instanceof Error ? error.message : String(error) };
    if (refusedBeforeCommit(error))
      return error.status === 409
        ? {
            kind: "conflict",
            message:
              "One or more selected tasks changed on the Gateway. Nothing was applied; review the current tasks.",
          }
        : { kind: "refused", message: `Nothing was applied. ${error.message}` };
    admission.uncertain(UNCERTAIN);
    return { kind: "uncertain", message: error instanceof Error ? error.message : String(error) };
  } finally {
    admission.settle();
  }
}
