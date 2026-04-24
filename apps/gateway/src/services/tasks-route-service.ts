import type { TaskLifecycleService } from "./task-lifecycle-service.js";

export type TasksRoutePort = Pick<
  TaskLifecycleService,
  | "appendTaskActivity"
  | "appendTaskDeliverable"
  | "createTask"
  | "getTask"
  | "hardDeleteTask"
  | "listTaskActivities"
  | "listTaskDeliverables"
  | "listTasks"
  | "listTaskSubagents"
  | "registerTaskSubagent"
  | "restoreTask"
  | "softDeleteTask"
  | "updateTask"
  | "updateTaskSubagent"
>;

export class TasksRouteService {
  public constructor(private readonly tasks: TasksRoutePort) {}

  public listTasks(...args: Parameters<TasksRoutePort["listTasks"]>) {
    return this.tasks.listTasks(...args);
  }

  public createTask(input: Parameters<TasksRoutePort["createTask"]>[0]) {
    return this.tasks.createTask(input);
  }

  public getTask(taskId: string) {
    return this.tasks.getTask(taskId);
  }

  public updateTask(taskId: string, input: Parameters<TasksRoutePort["updateTask"]>[1]) {
    return this.tasks.updateTask(taskId, input);
  }

  public softDeleteTask(taskId: string, deletedBy?: string, deleteReason?: string) {
    return this.tasks.softDeleteTask(taskId, deletedBy, deleteReason);
  }

  public hardDeleteTask(taskId: string) {
    return this.tasks.hardDeleteTask(taskId);
  }

  public restoreTask(taskId: string) {
    return this.tasks.restoreTask(taskId);
  }

  public listTaskActivities(taskId: string) {
    return this.tasks.listTaskActivities(taskId);
  }

  public appendTaskActivity(taskId: string, input: Parameters<TasksRoutePort["appendTaskActivity"]>[1]) {
    return this.tasks.appendTaskActivity(taskId, input);
  }

  public listTaskDeliverables(taskId: string) {
    return this.tasks.listTaskDeliverables(taskId);
  }

  public appendTaskDeliverable(taskId: string, input: Parameters<TasksRoutePort["appendTaskDeliverable"]>[1]) {
    return this.tasks.appendTaskDeliverable(taskId, input);
  }

  public listTaskSubagents(taskId: string) {
    return this.tasks.listTaskSubagents(taskId);
  }

  public registerTaskSubagent(taskId: string, input: Parameters<TasksRoutePort["registerTaskSubagent"]>[1]) {
    return this.tasks.registerTaskSubagent(taskId, input);
  }

  public updateTaskSubagent(agentSessionId: string, input: Parameters<TasksRoutePort["updateTaskSubagent"]>[1]) {
    return this.tasks.updateTaskSubagent(agentSessionId, input);
  }
}
