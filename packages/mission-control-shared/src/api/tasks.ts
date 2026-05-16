import type { TaskActivityRecord, TaskDeliverableRecord, TaskRecord, TaskSubagentSession } from "./types.js";
import type { TaskArtifactClaim, TaskDistressSignalCode, TaskDistressSeverity } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchTasks(
  status?: TaskRecord["status"],
  workspaceId?: string,
): Promise<{ items: TaskRecord[]; nextCursor?: string }> {
  const query = new URLSearchParams({ limit: "100", view: "active" });
  if (status) {
    query.set("status", status);
  }
  if (workspaceId?.trim()) {
    query.set("workspaceId", workspaceId.trim());
  }
  return request<{ items: TaskRecord[]; nextCursor?: string }>(`/api/v1/tasks?${query.toString()}`);
}

export async function fetchTasksByView(
  view: "active" | "trash" | "all",
  status?: TaskRecord["status"],
  workspaceId?: string,
): Promise<{ items: TaskRecord[]; nextCursor?: string; view: "active" | "trash" | "all" }> {
  const query = new URLSearchParams({ limit: "100", view });
  if (status) {
    query.set("status", status);
  }
  if (workspaceId?.trim()) {
    query.set("workspaceId", workspaceId.trim());
  }
  return request<{ items: TaskRecord[]; nextCursor?: string; view: "active" | "trash" | "all" }>(
    `/api/v1/tasks?${query.toString()}`,
  );
}

export async function createTask(input: {
  workspaceId?: string;
  title: string;
  description?: string;
  priority?: TaskRecord["priority"];
}): Promise<TaskRecord> {
  return request<TaskRecord>("/api/v1/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateTask(
  taskId: string,
  input: Partial<Pick<TaskRecord, "status" | "priority" | "title" | "description" | "dueAt">> & {
    assignedAgentId?: string | null;
  },
): Promise<TaskRecord> {
  return request<TaskRecord>(`/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteTask(
  taskId: string,
  input?: { mode?: "soft" | "hard"; deletedBy?: string; deleteReason?: string; confirmToken?: string },
): Promise<{ deleted: boolean; taskId: string; mode: "soft" | "hard" }> {
  const mode = input?.mode ?? "soft";
  return request<{ deleted: boolean; taskId: string; mode: "soft" | "hard" }>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}?mode=${mode}`,
    {
      method: "DELETE",
      body: JSON.stringify({
        mode,
        deletedBy: input?.deletedBy,
        deleteReason: input?.deleteReason,
        confirmToken: input?.confirmToken,
      }),
    },
  );
}

export async function restoreTask(taskId: string): Promise<{ restored: boolean; taskId: string }> {
  return request<{ restored: boolean; taskId: string }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchTaskActivities(taskId: string): Promise<{ items: TaskActivityRecord[] }> {
  return request<{ items: TaskActivityRecord[] }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/activities`);
}

export async function addTaskActivity(
  taskId: string,
  input: {
    message: string;
    activityType?: TaskActivityRecord["activityType"];
    agentId?: string;
  },
): Promise<TaskActivityRecord> {
  return request<TaskActivityRecord>(`/api/v1/tasks/${encodeURIComponent(taskId)}/activities`, {
    method: "POST",
    body: JSON.stringify({
      activityType: input.activityType ?? "comment",
      message: input.message,
      agentId: input.agentId,
    }),
  });
}

export async function fetchTaskDeliverables(taskId: string): Promise<{ items: TaskDeliverableRecord[] }> {
  return request<{ items: TaskDeliverableRecord[] }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/deliverables`);
}

export async function addTaskDeliverable(
  taskId: string,
  input: {
    title: string;
    deliverableType?: TaskDeliverableRecord["deliverableType"];
    path?: string;
    description?: string;
  },
): Promise<TaskDeliverableRecord> {
  return request<TaskDeliverableRecord>(`/api/v1/tasks/${encodeURIComponent(taskId)}/deliverables`, {
    method: "POST",
    body: JSON.stringify({
      deliverableType: input.deliverableType ?? "artifact",
      title: input.title,
      path: input.path,
      description: input.description,
    }),
  });
}

export async function fetchTaskSubagents(taskId: string): Promise<{ items: TaskSubagentSession[] }> {
  return request<{ items: TaskSubagentSession[] }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/subagents`);
}

export async function registerTaskSubagent(
  taskId: string,
  input: { agentSessionId: string; agentName?: string },
): Promise<TaskSubagentSession> {
  return request<TaskSubagentSession>(`/api/v1/tasks/${encodeURIComponent(taskId)}/subagents`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateTaskSubagent(
  agentSessionId: string,
  input: { status?: TaskSubagentSession["status"]; endedAt?: string },
): Promise<TaskSubagentSession> {
  return request<TaskSubagentSession>(`/api/v1/subagents/${encodeURIComponent(agentSessionId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export interface EmitTaskDistressBody {
  code: TaskDistressSignalCode;
  severity: TaskDistressSeverity;
  title: string;
  summary: string;
  emittedBy?: string;
  evidenceRef?: string;
}

export async function emitTaskDistress(taskId: string, input: EmitTaskDistressBody): Promise<TaskRecord> {
  return request<TaskRecord>(`/api/v1/tasks/${encodeURIComponent(taskId)}/distress`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function resolveTaskDistress(
  taskId: string,
  signalId: string,
  input?: { resolvedBy?: string },
): Promise<TaskRecord> {
  return request<TaskRecord>(`/api/v1/tasks/${encodeURIComponent(taskId)}/distress/${encodeURIComponent(signalId)}`, {
    method: "DELETE",
    body: JSON.stringify(input ?? {}),
  });
}

export async function setTaskRetryBudget(taskId: string, maxRetries: number): Promise<TaskRecord> {
  return request<TaskRecord>(`/api/v1/tasks/${encodeURIComponent(taskId)}/retry-budget`, {
    method: "POST",
    body: JSON.stringify({ maxRetries }),
  });
}

export async function verifyTaskArtifacts(taskId: string, claims: TaskArtifactClaim[]): Promise<TaskRecord> {
  return request<TaskRecord>(`/api/v1/tasks/${encodeURIComponent(taskId)}/verify-artifacts`, {
    method: "POST",
    body: JSON.stringify({ claims }),
  });
}

export type BulkTaskActionInput =
  | { action: "unblock"; taskIds: string[] }
  | { action: "retry"; taskIds: string[]; reason: string }
  | { action: "reassign"; taskIds: string[]; assignedAgentId: string }
  | { action: "close"; taskIds: string[] };

export async function bulkTaskAction(input: BulkTaskActionInput): Promise<{ tasks: TaskRecord[] }> {
  return request<{ tasks: TaskRecord[] }>(`/api/v1/tasks/bulk`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
