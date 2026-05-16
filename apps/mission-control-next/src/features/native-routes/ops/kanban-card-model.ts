import type { TaskRecord, TaskStatus, TaskDistressSignal } from "@goatcitadel/contracts";

export type KanbanColumnId = "backlog" | "in_progress" | "blocked" | "done";

export interface KanbanCardModel {
  taskId: string;
  title: string;
  priority: TaskRecord["priority"];
  assignedAgentId?: string;
  column: KanbanColumnId;
  distressSummary: { info: number; warn: number; critical: number };
  unresolvedDistress: TaskDistressSignal[];
  retryDisplay?: string;
  lastHeartbeatAgeSeconds?: number;
}

export function toKanbanColumn(status: TaskStatus): KanbanColumnId {
  if (status === "planning" || status === "inbox" || status === "assigned") {
    return "backlog";
  }
  if (status === "in_progress" || status === "testing" || status === "review") {
    return "in_progress";
  }
  if (status === "blocked") {
    return "blocked";
  }
  return "done";
}

export interface ToKanbanCardOptions {
  now?: () => number;
}

export function toKanbanCard(task: TaskRecord, options: ToKanbanCardOptions = {}): KanbanCardModel {
  const nowMs = options.now ? options.now() : Date.now();
  const unresolved = (task.distressSignals ?? []).filter((s) => !s.resolvedAt);
  const distressSummary = { info: 0, warn: 0, critical: 0 };
  for (const s of unresolved) {
    distressSummary[s.severity] += 1;
  }
  const heartbeat = task.agenticContext?.heartbeatAt;
  const heartbeatMs = heartbeat ? Date.parse(heartbeat) : Number.NaN;
  return {
    taskId: task.taskId,
    title: task.title,
    priority: task.priority,
    assignedAgentId: task.assignedAgentId,
    column: toKanbanColumn(task.status),
    distressSummary,
    unresolvedDistress: unresolved,
    retryDisplay: task.retryBudget ? `${task.retryBudget.retryCount} / ${task.retryBudget.maxRetries}` : undefined,
    lastHeartbeatAgeSeconds: Number.isFinite(heartbeatMs) ? Math.round((nowMs - heartbeatMs) / 1000) : undefined,
  };
}
