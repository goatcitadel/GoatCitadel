import type { TaskActivityRecord, TaskDeliverableRecord, TaskRecord, TaskSubagentSession } from "./types.js";
import type { TaskArtifactClaim, TaskDistressSignalCode, TaskDistressSeverity } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

function withWorkspaceQuery(path: string, workspaceId?: string, citadelId?: string): string {
  const query = new URLSearchParams();
  const trimmedCitadelId = citadelId?.trim();
  const trimmedWorkspaceId = workspaceId?.trim();
  if (trimmedCitadelId) {
    query.set("citadelId", trimmedCitadelId);
  }
  if (trimmedWorkspaceId) {
    query.set("workspaceId", trimmedWorkspaceId);
  }
  const suffix = query.toString();
  if (!suffix) {
    return path;
  }
  return `${path}${path.includes("?") ? "&" : "?"}${suffix}`;
}

interface FetchTasksOptions {
  citadelId?: string;
  limit?: number;
  cursor?: string;
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
  return request<{ items: TaskRecord[]; nextCursor?: string }>(`/api/v1/tasks?${query.toString()}`);
}

export async function fetchTasksByView(
  view: "active" | "trash" | "all",
  status?: TaskRecord["status"],
  workspaceId?: string,
  options: FetchTasksOptions = {},
): Promise<{ items: TaskRecord[]; nextCursor?: string; view: "active" | "trash" | "all" }> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 100), view });
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
  return request<{ items: TaskRecord[]; nextCursor?: string; view: "active" | "trash" | "all" }>(
    `/api/v1/tasks?${query.toString()}`,
  );
}

export async function createTask(input: {
  citadelId?: string;
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
    citadelId?: string;
    workspaceId?: string;
  },
): Promise<TaskRecord> {
  return request<TaskRecord>(
    withWorkspaceQuery(`/api/v1/tasks/${encodeURIComponent(taskId)}`, input.workspaceId, input.citadelId),
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function deleteTask(
  taskId: string,
  input?: {
    mode?: "soft" | "hard";
    deletedBy?: string;
    deleteReason?: string;
    confirmToken?: string;
    citadelId?: string;
    workspaceId?: string;
  },
): Promise<{ deleted: boolean; taskId: string; mode: "soft" | "hard" }> {
  const mode = input?.mode ?? "soft";
  return request<{ deleted: boolean; taskId: string; mode: "soft" | "hard" }>(
    withWorkspaceQuery(
      `/api/v1/tasks/${encodeURIComponent(taskId)}?mode=${mode}`,
      input?.workspaceId,
      input?.citadelId,
    ),
    {
      method: "DELETE",
      body: JSON.stringify({
        mode,
        deletedBy: input?.deletedBy,
        deleteReason: input?.deleteReason,
        confirmToken: input?.confirmToken,
        citadelId: input?.citadelId,
        workspaceId: input?.workspaceId,
      }),
    },
  );
}

export async function restoreTask(
  taskId: string,
  workspaceId?: string,
  citadelId?: string,
): Promise<{ restored: boolean; taskId: string }> {
  return request<{ restored: boolean; taskId: string }>(
    withWorkspaceQuery(`/api/v1/tasks/${encodeURIComponent(taskId)}/restore`, workspaceId, citadelId),
    {
      method: "POST",
      body: JSON.stringify({ citadelId, workspaceId }),
    },
  );
}

export async function fetchTaskActivities(
  taskId: string,
  workspaceId?: string,
  citadelId?: string,
): Promise<{ items: TaskActivityRecord[] }> {
  return request<{ items: TaskActivityRecord[] }>(
    withWorkspaceQuery(`/api/v1/tasks/${encodeURIComponent(taskId)}/activities`, workspaceId, citadelId),
  );
}

export async function addTaskActivity(
  taskId: string,
  input: {
    message: string;
    activityType?: TaskActivityRecord["activityType"];
    agentId?: string;
    citadelId?: string;
    workspaceId?: string;
  },
): Promise<TaskActivityRecord> {
  return request<TaskActivityRecord>(
    withWorkspaceQuery(`/api/v1/tasks/${encodeURIComponent(taskId)}/activities`, input.workspaceId, input.citadelId),
    {
      method: "POST",
      body: JSON.stringify({
        citadelId: input.citadelId,
        workspaceId: input.workspaceId,
        activityType: input.activityType ?? "comment",
        message: input.message,
        agentId: input.agentId,
      }),
    },
  );
}

export async function fetchTaskDeliverables(
  taskId: string,
  workspaceId?: string,
  citadelId?: string,
): Promise<{ items: TaskDeliverableRecord[] }> {
  return request<{ items: TaskDeliverableRecord[] }>(
    withWorkspaceQuery(`/api/v1/tasks/${encodeURIComponent(taskId)}/deliverables`, workspaceId, citadelId),
  );
}

export async function addTaskDeliverable(
  taskId: string,
  input: {
    title: string;
    deliverableType?: TaskDeliverableRecord["deliverableType"];
    path?: string;
    description?: string;
    citadelId?: string;
    workspaceId?: string;
  },
): Promise<TaskDeliverableRecord> {
  return request<TaskDeliverableRecord>(
    withWorkspaceQuery(`/api/v1/tasks/${encodeURIComponent(taskId)}/deliverables`, input.workspaceId, input.citadelId),
    {
      method: "POST",
      body: JSON.stringify({
        citadelId: input.citadelId,
        workspaceId: input.workspaceId,
        deliverableType: input.deliverableType ?? "artifact",
        title: input.title,
        path: input.path,
        description: input.description,
      }),
    },
  );
}

export async function fetchTaskSubagents(
  taskId: string,
  workspaceId?: string,
  citadelId?: string,
): Promise<{ items: TaskSubagentSession[] }> {
  return request<{ items: TaskSubagentSession[] }>(
    withWorkspaceQuery(`/api/v1/tasks/${encodeURIComponent(taskId)}/subagents`, workspaceId, citadelId),
  );
}

export async function registerTaskSubagent(
  taskId: string,
  input: { agentSessionId: string; agentName?: string; citadelId?: string; workspaceId?: string },
): Promise<TaskSubagentSession> {
  return request<TaskSubagentSession>(
    withWorkspaceQuery(`/api/v1/tasks/${encodeURIComponent(taskId)}/subagents`, input.workspaceId, input.citadelId),
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
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

export async function emitTaskDistress(
  taskId: string,
  input: EmitTaskDistressBody & { citadelId?: string; workspaceId?: string },
): Promise<TaskRecord> {
  return request<TaskRecord>(
    withWorkspaceQuery(`/api/v1/tasks/${encodeURIComponent(taskId)}/distress`, input.workspaceId, input.citadelId),
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function resolveTaskDistress(
  taskId: string,
  signalId: string,
  input?: { citadelId?: string; workspaceId?: string },
): Promise<TaskRecord> {
  return request<TaskRecord>(
    withWorkspaceQuery(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/distress/${encodeURIComponent(signalId)}`,
      input?.workspaceId,
      input?.citadelId,
    ),
    {
      method: "DELETE",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function setTaskRetryBudget(
  taskId: string,
  maxRetries: number,
  workspaceId?: string,
  citadelId?: string,
): Promise<TaskRecord> {
  return request<TaskRecord>(
    withWorkspaceQuery(`/api/v1/tasks/${encodeURIComponent(taskId)}/retry-budget`, workspaceId, citadelId),
    {
      method: "POST",
      body: JSON.stringify({ citadelId, maxRetries, workspaceId }),
    },
  );
}

export async function verifyTaskArtifacts(
  taskId: string,
  claims: TaskArtifactClaim[],
  workspaceId?: string,
  citadelId?: string,
): Promise<TaskRecord> {
  return request<TaskRecord>(
    withWorkspaceQuery(`/api/v1/tasks/${encodeURIComponent(taskId)}/verify-artifacts`, workspaceId, citadelId),
    {
      method: "POST",
      body: JSON.stringify({ citadelId, claims, workspaceId }),
    },
  );
}

export type BulkTaskActionInput =
  | { action: "unblock"; taskIds: string[] }
  | { action: "retry"; taskIds: string[]; reason: string }
  | { action: "reassign"; taskIds: string[]; assignedAgentId: string }
  | { action: "close"; taskIds: string[] };

export async function bulkTaskAction(
  input: BulkTaskActionInput & { citadelId?: string; workspaceId?: string },
): Promise<{ tasks: TaskRecord[] }> {
  return request<{ tasks: TaskRecord[] }>(`/api/v1/tasks/bulk`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
