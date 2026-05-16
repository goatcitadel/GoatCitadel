import type { TaskLifecycleService } from "./task-lifecycle-service.js";

export type TasksRoutePort = Pick<
  TaskLifecycleService,
  | "appendTaskActivity"
  | "appendTaskDeliverable"
  | "createTask"
  | "getTask"
  | "getAgenticRunTree"
  | "hardDeleteTask"
  | "invokeAgenticControl"
  | "appendTaskDiagnostic"
  | "listTaskActivities"
  | "listAgenticRuns"
  | "listTaskDeliverables"
  | "listTasks"
  | "listTaskSubagents"
  | "registerTaskSubagent"
  | "restoreTask"
  | "softDeleteTask"
  | "updateTask"
  | "updateTaskSubagent"
  | "emitDistressSignal"
  | "resolveDistressSignal"
  | "setRetryBudget"
  | "recordRetryAttempt"
  | "verifyTaskArtifacts"
  | "autoBlockOnIncompleteExit"
  | "bulkUpdateTasks"
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

  public listAgenticRuns(...args: Parameters<TasksRoutePort["listAgenticRuns"]>) {
    return this.tasks.listAgenticRuns(...args);
  }

  public getAgenticRunTree(runId: string) {
    return this.tasks.getAgenticRunTree(runId);
  }

  public invokeAgenticControl(runId: string, input: Parameters<TasksRoutePort["invokeAgenticControl"]>[1]) {
    return this.tasks.invokeAgenticControl(runId, input);
  }

  public appendTaskDiagnostic(taskId: string, input: Parameters<TasksRoutePort["appendTaskDiagnostic"]>[1]) {
    return this.tasks.appendTaskDiagnostic(taskId, input);
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

  public emitDistressSignal(taskId: string, input: Parameters<TasksRoutePort["emitDistressSignal"]>[1]) {
    return this.tasks.emitDistressSignal(taskId, input);
  }

  public resolveDistressSignal(
    taskId: string,
    signalId: string,
    input?: Parameters<TasksRoutePort["resolveDistressSignal"]>[2],
  ) {
    return this.tasks.resolveDistressSignal(taskId, signalId, input);
  }

  public setRetryBudget(taskId: string, maxRetries: number) {
    return this.tasks.setRetryBudget(taskId, maxRetries);
  }

  public verifyTaskArtifacts(taskId: string, claims: Parameters<TasksRoutePort["verifyTaskArtifacts"]>[1]) {
    return this.tasks.verifyTaskArtifacts(taskId, claims);
  }

  public bulkUpdateTasks(input: Parameters<TasksRoutePort["bulkUpdateTasks"]>[0]) {
    return this.tasks.bulkUpdateTasks(input);
  }
}
