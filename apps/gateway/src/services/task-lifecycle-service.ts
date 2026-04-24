import type {
  RealtimeEvent,
  TaskActivityCreateInput,
  TaskActivityRecord,
  TaskCreateInput,
  TaskDeliverableCreateInput,
  TaskDeliverableRecord,
  TaskRecord,
  TaskStatus,
  TaskSubagentCreateInput,
  TaskSubagentSession,
  TaskSubagentUpdateInput,
  TaskUpdateInput,
} from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

const DEFAULT_WORKSPACE_ID = "default";

type TaskStorage = Pick<Storage, "taskActivities" | "taskDeliverables" | "tasks" | "taskSubagents">;

type TaskRealtimeOptions = {
  eventAuthority: NonNullable<RealtimeEvent["eventAuthority"]>;
  eventClass: NonNullable<RealtimeEvent["eventClass"]>;
  links?: RealtimeEvent["links"];
};

export interface TaskLifecycleServiceDependencies {
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: TaskRealtimeOptions,
  ): void;
  storage: TaskStorage;
}

export class TaskLifecycleService {
  public constructor(private readonly deps: TaskLifecycleServiceDependencies) {}

  public listTasks(
    limit: number,
    status?: TaskStatus,
    cursor?: string,
    view: "active" | "trash" | "all" = "active",
    workspaceId?: string,
  ): TaskRecord[] {
    return this.deps.storage.tasks.list({
      workspaceId: this.normalizeWorkspaceId(workspaceId),
      status,
      limit,
      cursor,
      view,
    });
  }

  public getTask(taskId: string): TaskRecord {
    return this.deps.storage.tasks.get(taskId);
  }

  public createTask(input: TaskCreateInput): TaskRecord {
    const created = this.deps.storage.tasks.create({
      ...input,
      workspaceId: this.normalizeWorkspaceId(input.workspaceId),
    });
    this.publishTaskEvent("task_created", { task: created }, buildTaskRealtimeLinks(created));
    return created;
  }

  public updateTask(taskId: string, input: TaskUpdateInput): TaskRecord {
    if (input.status === "done") {
      const deliverables = this.deps.storage.taskDeliverables.countByTask(taskId);
      if (deliverables < 1) {
        throw new ValidationError({
          message: "Cannot mark task done without at least one deliverable",
        });
      }
    }

    const updated = this.deps.storage.tasks.update(taskId, input);
    this.publishTaskEvent("task_updated", { task: updated }, buildTaskRealtimeLinks(updated));
    return updated;
  }

  public softDeleteTask(taskId: string, deletedBy?: string, deleteReason?: string): boolean {
    const existing = this.deps.storage.tasks.find(taskId);
    const deleted = this.deps.storage.tasks.softDelete(taskId, deletedBy, deleteReason);
    if (deleted) {
      this.publishTaskEvent("task_deleted", { taskId, mode: "soft" }, buildTaskRealtimeLinks(existing, taskId));
    }
    return deleted;
  }

  public restoreTask(taskId: string): boolean {
    const restored = this.deps.storage.tasks.restore(taskId);
    if (restored) {
      this.publishTaskEvent(
        "task_restored",
        { taskId },
        buildTaskRealtimeLinks(this.deps.storage.tasks.find(taskId), taskId),
      );
    }
    return restored;
  }

  public hardDeleteTask(taskId: string): boolean {
    const existing = this.deps.storage.tasks.find(taskId);
    const deleted = this.deps.storage.tasks.hardDelete(taskId);
    if (deleted) {
      this.publishTaskEvent("task_deleted", { taskId, mode: "hard" }, buildTaskRealtimeLinks(existing, taskId));
    }
    return deleted;
  }

  public listTaskActivities(taskId: string, limit = 200): TaskActivityRecord[] {
    this.deps.storage.tasks.get(taskId);
    return this.deps.storage.taskActivities.listByTask(taskId, limit);
  }

  public appendTaskActivity(taskId: string, input: TaskActivityCreateInput): TaskActivityRecord {
    const task = this.deps.storage.tasks.get(taskId);
    const activity = this.deps.storage.taskActivities.append(taskId, input);
    this.publishTaskEvent("activity_logged", { taskId, activity }, buildTaskRealtimeLinks(task));
    return activity;
  }

  public listTaskDeliverables(taskId: string, limit = 200): TaskDeliverableRecord[] {
    this.deps.storage.tasks.get(taskId);
    return this.deps.storage.taskDeliverables.listByTask(taskId, limit);
  }

  public appendTaskDeliverable(taskId: string, input: TaskDeliverableCreateInput): TaskDeliverableRecord {
    const task = this.deps.storage.tasks.get(taskId);
    const deliverable = this.deps.storage.taskDeliverables.append(taskId, input);
    this.publishTaskEvent("deliverable_added", { taskId, deliverable }, buildTaskRealtimeLinks(task));
    return deliverable;
  }

  public listTaskSubagents(taskId: string, limit = 200): TaskSubagentSession[] {
    this.deps.storage.tasks.get(taskId);
    return this.deps.storage.taskSubagents.listByTask(taskId, limit);
  }

  public registerTaskSubagent(taskId: string, input: TaskSubagentCreateInput): TaskSubagentSession {
    const task = this.deps.storage.tasks.get(taskId);
    const session = this.deps.storage.taskSubagents.create(taskId, input);
    this.publishTaskEvent("subagent_registered", { taskId, session }, buildTaskRealtimeLinks(task));
    return session;
  }

  public updateTaskSubagent(agentSessionId: string, input: TaskSubagentUpdateInput): TaskSubagentSession {
    const updated = this.deps.storage.taskSubagents.updateByAgentSessionId(agentSessionId, {
      ...input,
      endedAt: input.endedAt ?? (input.status && input.status !== "active" ? new Date().toISOString() : undefined),
    });

    this.publishTaskEvent(
      "subagent_updated",
      { taskId: updated.taskId, session: updated },
      buildTaskRealtimeLinks(this.deps.storage.tasks.find(updated.taskId), updated.taskId),
    );
    return updated;
  }

  private normalizeWorkspaceId(workspaceId?: string): string {
    if (!workspaceId?.trim()) {
      return DEFAULT_WORKSPACE_ID;
    }
    const normalized = workspaceId.trim();
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(normalized)) {
      throw new Error("workspaceId contains unsupported characters");
    }
    return normalized;
  }

  private publishTaskEvent(eventType: string, payload: Record<string, unknown>, links: RealtimeEvent["links"]): void {
    this.deps.publishRealtime(eventType, "tasks", payload, {
      eventClass: "domain_fact",
      eventAuthority: "retained_stream",
      links,
    });
  }
}

export function buildTaskRealtimeLinks(
  task?: TaskRecord,
  fallbackTaskId?: string,
): NonNullable<RealtimeEvent["links"]> {
  return {
    ...(task?.taskId || fallbackTaskId ? { taskId: task?.taskId ?? fallbackTaskId } : {}),
    ...(task?.workspaceId ? { workspaceId: task.workspaceId } : {}),
    ...(task?.proactiveContext?.sessionId ? { sessionId: task.proactiveContext.sessionId } : {}),
    ...(task?.proactiveContext?.durableRunId ? { runId: task.proactiveContext.durableRunId } : {}),
    ...(task?.proactiveContext?.proactiveRunId ? { proactiveRunId: task.proactiveContext.proactiveRunId } : {}),
    ...(task?.proactiveContext?.approvalId ? { approvalId: task.proactiveContext.approvalId } : {}),
  };
}
