import type { TaskRecord } from "./types.js";
import type { TaskDistressSignalCode, TaskDistressSeverity } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

interface FetchTasksOptions {
  citadelId?: string;
  limit?: number;
  cursor?: string;
  /** Aborts the read when its query is superseded or cancelled. */
  signal?: AbortSignal;
}

export async function fetchTasks(
  status?: TaskRecord["status"],
  workspaceId?: string,
  options: FetchTasksOptions = {},
): Promise<{ items: TaskRecord[]; nextCursor?: string }> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 100), view: "active" });
  if (status) {
    query.set("status", status);
  }
  if (options.cursor?.trim()) {
    query.set("cursor", options.cursor.trim());
  }
  if (options.citadelId?.trim()) {
    query.set("citadelId", options.citadelId.trim());
  }
  if (workspaceId?.trim()) {
    query.set("workspaceId", workspaceId.trim());
  }
  return request<{ items: TaskRecord[]; nextCursor?: string }>(
    `/api/v1/tasks?${query.toString()}`,
    options.signal ? { signal: options.signal } : undefined,
  );
}

export interface EmitTaskDistressBody {
  expectedRevision: number;
  code: TaskDistressSignalCode;
  severity: TaskDistressSeverity;
  title: string;
  summary: string;
  emittedBy?: string;
  evidenceRef?: string;
}

export type BulkTaskActionInput = (
  | { action: "unblock"; taskIds: string[] }
  | { action: "retry"; taskIds: string[]; reason: string }
  | { action: "reassign"; taskIds: string[]; assignedAgentId: string }
  | { action: "close"; taskIds: string[] }
) & { expectedRevisionsByTaskId: Record<string, number> };

// Optional destination operations retain their public bindings and shared request owner.
export {
  fetchTasksByView,
  fetchTask,
  createTask,
  updateTask,
  deleteTask,
  restoreTask,
  fetchTaskActivities,
  addTaskActivity,
  fetchTaskDeliverables,
  addTaskDeliverable,
  fetchTaskSubagents,
  registerTaskSubagent,
  updateTaskSubagent,
  emitTaskDistress,
  resolveTaskDistress,
  setTaskRetryBudget,
  verifyTaskArtifacts,
  bulkTaskAction,
} from "./tasks-operations.js";
