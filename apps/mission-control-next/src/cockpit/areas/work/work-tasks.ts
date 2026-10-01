import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import type { WorkBoardGroup } from "./work-board";

export const TASK_STATUSES: readonly TaskRecord["status"][] = [
  "planning", "inbox", "assigned", "in_progress", "testing", "review", "done", "blocked",
];

export function taskMatchesWorkspace(task: TaskRecord, workspaceId: string): boolean {
  return task.workspaceId === workspaceId && !task.deletedAt;
}

export function taskBoardGroup(status: TaskRecord["status"]): WorkBoardGroup {
  if (status === "done") return "done";
  if (status === "blocked" || status === "review" || status === "inbox") return "waiting";
  return "running";
}

export function projectWorkTasks(tasks: TaskRecord[], workspaceId: string): Record<WorkBoardGroup, TaskRecord[]> {
  const result: Record<WorkBoardGroup, TaskRecord[]> = { running: [], waiting: [], failed: [], done: [] };
  const latest = new Map<string, TaskRecord>();
  for (const task of tasks) {
    const previous = latest.get(task.taskId);
    if (!previous || task.revision > previous.revision
      || (task.revision === previous.revision && task.updatedAt > previous.updatedAt)) latest.set(task.taskId, task);
  }
  for (const task of latest.values()) if (taskMatchesWorkspace(task, workspaceId)) result[taskBoardGroup(task.status)].push(task);
  for (const group of Object.values(result)) group.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return result;
}

export function sameTaskEvidence(reviewed: TaskRecord, current: TaskRecord): boolean {
  return reviewed.taskId === current.taskId && reviewed.revision === current.revision
    && reviewed.workspaceId === current.workspaceId && reviewed.status === current.status
    && reviewed.title === current.title && reviewed.priority === current.priority
    && reviewed.assignedAgentId === current.assignedAgentId && reviewed.deletedAt === current.deletedAt;
}
