import type { TaskRecord } from "@goatcitadel/contracts";
import { fetchTask, deleteTask, restoreTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { taskRecordsEqual } from "./task-detail-mutation";
import { acquireTaskMutations, taskMutationKey } from "./task-mutation-state";

export async function performTaskArchiveAction(task: TaskRecord, workspaceId: string, kind: "archive" | "restore", isCurrent: () => boolean) {
  const base = getGatewayApiBaseUrl();
  const current = () => isCurrent() && getGatewayApiBaseUrl() === base;
  const admission = acquireTaskMutations([taskMutationKey(base, workspaceId, task.taskId)]);
  if (!admission) throw new Error("This task has a pending or unconfirmed action.");
  let dispatched = false;
  try {
    const read = () => fetchTask(task.taskId, workspaceId, undefined, { signal: new AbortController().signal });
    const fresh = await read();
    if (!current()) return;
    if (!taskRecordsEqual(task, fresh) || (fresh.workspaceId ?? "default") !== workspaceId) throw new Error("The task changed. Your selection is preserved; refresh and review its current revision.");
    dispatched = true;
    if (kind === "archive") {
      const receipt = await deleteTask(task.taskId, { expectedRevision: task.revision, workspaceId, mode: "soft" });
      if (!receipt.deleted || receipt.taskId !== task.taskId || receipt.mode !== "soft") throw new Error("Archive receipt was not confirmed.");
    } else {
      const receipt = await restoreTask(task.taskId, task.revision, workspaceId);
      if (!receipt.restored || receipt.taskId !== task.taskId) throw new Error("Restore receipt was not confirmed.");
    }
    const saved = await read();
    if (getGatewayApiBaseUrl() !== base || saved.taskId !== task.taskId || (saved.workspaceId ?? "default") !== workspaceId || saved.revision <= task.revision || Boolean(saved.deletedAt) !== (kind === "archive")) throw new Error("The task action could not be independently verified.");
    return current() ? saved : undefined;
  } catch (error) {
    if (dispatched && !(isApiRequestError(error) && error.status === 409)) admission.uncertain("The archive or restore outcome is unconfirmed. Further task actions are locked for this app session.");
    throw error;
  } finally { admission.settle(); }
}
