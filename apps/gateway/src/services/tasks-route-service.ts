import type { TaskLifecycleService, TaskWorkspaceAccessOptions } from "./task-lifecycle-service.js";

export type TasksRoutePort = Pick<
  TaskLifecycleService,
  | "appendTaskActivity"
  | "appendTaskDeliverable"
  | "createTask"
  | "getTask"
  | "getAgenticRunTree"
  | "hardDeleteTask"
  | "hardDeleteTaskWithRevision"
  | "invokeAgenticControl"
  | "appendTaskDiagnostic"
  | "listTaskActivities"
  | "listAgenticRuns"
  | "listTaskDeliverables"
  | "listTasks"
  | "listTaskSubagents"
  | "registerTaskSubagent"
  | "restoreTask"
  | "restoreTaskWithRevision"
  | "softDeleteTask"
  | "softDeleteTaskWithRevision"
  | "updateTask"
  | "updateTaskWithRevision"
  | "updateTaskSubagent"
  | "emitDistressSignal"
  | "emitDistressSignalWithRevision"
  | "resolveDistressSignal"
  | "resolveDistressSignalWithRevision"
  | "setRetryBudget"
  | "setRetryBudgetWithRevision"
  | "recordRetryAttempt"
  | "verifyTaskArtifacts"
  | "verifyTaskArtifactsWithRevision"
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

  public getTask(taskId: string, options?: TaskWorkspaceAccessOptions) {
    if (options === undefined) {
      return this.tasks.getTask(taskId);
    }
    return this.tasks.getTask(taskId, options);
  }

  public listAgenticRuns(...args: Parameters<TasksRoutePort["listAgenticRuns"]>) {
    return this.tasks.listAgenticRuns(...args);
  }

  public getAgenticRunTree(runId: string, options?: TaskWorkspaceAccessOptions) {
    if (options === undefined) {
      return this.tasks.getAgenticRunTree(runId);
    }
    return this.tasks.getAgenticRunTree(runId, options);
  }

  public invokeAgenticControl(
    runId: string,
    input: Parameters<TasksRoutePort["invokeAgenticControl"]>[1],
    options?: TaskWorkspaceAccessOptions,
  ) {
    if (options === undefined) {
      return this.tasks.invokeAgenticControl(runId, input);
    }
    return this.tasks.invokeAgenticControl(runId, input, options);
  }

  public appendTaskDiagnostic(
    taskId: string,
    input: Parameters<TasksRoutePort["appendTaskDiagnostic"]>[1],
    options?: TaskWorkspaceAccessOptions,
  ) {
    if (options === undefined) {
      return this.tasks.appendTaskDiagnostic(taskId, input);
    }
    return this.tasks.appendTaskDiagnostic(taskId, input, options);
  }

  public updateTask(
    taskId: string,
    input: Parameters<TasksRoutePort["updateTask"]>[1],
    options?: TaskWorkspaceAccessOptions,
  ) {
    if (options === undefined) {
      return this.tasks.updateTask(taskId, input);
    }
    return this.tasks.updateTask(taskId, input, options);
  }

  public updateTaskWithRevision(
    taskId: string,
    input: Parameters<TasksRoutePort["updateTaskWithRevision"]>[1],
    expectedRevision: number,
    options?: TaskWorkspaceAccessOptions,
  ) {
    return options === undefined
      ? this.tasks.updateTaskWithRevision(taskId, input, expectedRevision)
      : this.tasks.updateTaskWithRevision(taskId, input, expectedRevision, options);
  }

  public softDeleteTask(
    taskId: string,
    deletedBy?: string,
    deleteReason?: string,
    options?: TaskWorkspaceAccessOptions,
  ) {
    if (options === undefined) {
      return this.tasks.softDeleteTask(taskId, deletedBy, deleteReason);
    }
    return this.tasks.softDeleteTask(taskId, deletedBy, deleteReason, options);
  }

  public softDeleteTaskWithRevision(
    taskId: string,
    expectedRevision: number,
    deletedBy?: string,
    deleteReason?: string,
    options?: TaskWorkspaceAccessOptions,
  ) {
    return options === undefined
      ? this.tasks.softDeleteTaskWithRevision(taskId, expectedRevision, deletedBy, deleteReason)
      : this.tasks.softDeleteTaskWithRevision(taskId, expectedRevision, deletedBy, deleteReason, options);
  }

  public hardDeleteTask(taskId: string, options?: TaskWorkspaceAccessOptions) {
    if (options === undefined) {
      return this.tasks.hardDeleteTask(taskId);
    }
    return this.tasks.hardDeleteTask(taskId, options);
  }

  public hardDeleteTaskWithRevision(taskId: string, expectedRevision: number, options?: TaskWorkspaceAccessOptions) {
    return options === undefined
      ? this.tasks.hardDeleteTaskWithRevision(taskId, expectedRevision)
      : this.tasks.hardDeleteTaskWithRevision(taskId, expectedRevision, options);
  }

  public restoreTask(taskId: string, options?: TaskWorkspaceAccessOptions) {
    if (options === undefined) {
      return this.tasks.restoreTask(taskId);
    }
    return this.tasks.restoreTask(taskId, options);
  }

  public restoreTaskWithRevision(taskId: string, expectedRevision: number, options?: TaskWorkspaceAccessOptions) {
    return options === undefined
      ? this.tasks.restoreTaskWithRevision(taskId, expectedRevision)
      : this.tasks.restoreTaskWithRevision(taskId, expectedRevision, options);
  }

  public listTaskActivities(taskId: string, limit?: number, options?: TaskWorkspaceAccessOptions) {
    if (options === undefined) {
      return limit === undefined ? this.tasks.listTaskActivities(taskId) : this.tasks.listTaskActivities(taskId, limit);
    }
    return this.tasks.listTaskActivities(taskId, limit, options);
  }

  public appendTaskActivity(
    taskId: string,
    input: Parameters<TasksRoutePort["appendTaskActivity"]>[1],
    options?: TaskWorkspaceAccessOptions,
  ) {
    if (options === undefined) {
      return this.tasks.appendTaskActivity(taskId, input);
    }
    return this.tasks.appendTaskActivity(taskId, input, options);
  }

  public listTaskDeliverables(taskId: string, limit?: number, options?: TaskWorkspaceAccessOptions) {
    if (options === undefined) {
      return limit === undefined
        ? this.tasks.listTaskDeliverables(taskId)
        : this.tasks.listTaskDeliverables(taskId, limit);
    }
    return this.tasks.listTaskDeliverables(taskId, limit, options);
  }

  public appendTaskDeliverable(
    taskId: string,
    input: Parameters<TasksRoutePort["appendTaskDeliverable"]>[1],
    options?: TaskWorkspaceAccessOptions,
  ) {
    if (options === undefined) {
      return this.tasks.appendTaskDeliverable(taskId, input);
    }
    return this.tasks.appendTaskDeliverable(taskId, input, options);
  }

  public listTaskSubagents(taskId: string, limit?: number, options?: TaskWorkspaceAccessOptions) {
    if (options === undefined) {
      return limit === undefined ? this.tasks.listTaskSubagents(taskId) : this.tasks.listTaskSubagents(taskId, limit);
    }
    return this.tasks.listTaskSubagents(taskId, limit, options);
  }

  public registerTaskSubagent(
    taskId: string,
    input: Parameters<TasksRoutePort["registerTaskSubagent"]>[1],
    options?: TaskWorkspaceAccessOptions,
  ) {
    if (options === undefined) {
      return this.tasks.registerTaskSubagent(taskId, input);
    }
    return this.tasks.registerTaskSubagent(taskId, input, options);
  }

  public updateTaskSubagent(
    agentSessionId: string,
    input: Parameters<TasksRoutePort["updateTaskSubagent"]>[1],
    options?: TaskWorkspaceAccessOptions,
  ) {
    if (options === undefined) {
      return this.tasks.updateTaskSubagent(agentSessionId, input);
    }
    return this.tasks.updateTaskSubagent(agentSessionId, input, options);
  }

  public emitDistressSignal(
    taskId: string,
    input: Parameters<TasksRoutePort["emitDistressSignal"]>[1],
    options?: TaskWorkspaceAccessOptions,
  ) {
    if (options === undefined) {
      return this.tasks.emitDistressSignal(taskId, input);
    }
    return this.tasks.emitDistressSignal(taskId, input, options);
  }

  public emitDistressSignalWithRevision(
    taskId: string,
    input: Parameters<TasksRoutePort["emitDistressSignalWithRevision"]>[1],
    expectedRevision: number,
    options?: TaskWorkspaceAccessOptions,
  ) {
    return options === undefined
      ? this.tasks.emitDistressSignalWithRevision(taskId, input, expectedRevision)
      : this.tasks.emitDistressSignalWithRevision(taskId, input, expectedRevision, options);
  }

  public resolveDistressSignal(
    taskId: string,
    signalId: string,
    input?: Parameters<TasksRoutePort["resolveDistressSignal"]>[2],
    options?: TaskWorkspaceAccessOptions,
  ) {
    if (options === undefined) {
      return input === undefined
        ? this.tasks.resolveDistressSignal(taskId, signalId)
        : this.tasks.resolveDistressSignal(taskId, signalId, input);
    }
    return this.tasks.resolveDistressSignal(taskId, signalId, input, options);
  }

  public resolveDistressSignalWithRevision(
    taskId: string,
    signalId: string,
    input: Parameters<TasksRoutePort["resolveDistressSignalWithRevision"]>[2],
    expectedRevision: number,
    options?: TaskWorkspaceAccessOptions,
  ) {
    return options === undefined
      ? this.tasks.resolveDistressSignalWithRevision(taskId, signalId, input, expectedRevision)
      : this.tasks.resolveDistressSignalWithRevision(taskId, signalId, input, expectedRevision, options);
  }

  public setRetryBudget(taskId: string, maxRetries: number, options?: TaskWorkspaceAccessOptions) {
    if (options === undefined) {
      return this.tasks.setRetryBudget(taskId, maxRetries);
    }
    return this.tasks.setRetryBudget(taskId, maxRetries, options);
  }

  public setRetryBudgetWithRevision(
    taskId: string,
    maxRetries: number,
    expectedRevision: number,
    options?: TaskWorkspaceAccessOptions,
  ) {
    return options === undefined
      ? this.tasks.setRetryBudgetWithRevision(taskId, maxRetries, expectedRevision)
      : this.tasks.setRetryBudgetWithRevision(taskId, maxRetries, expectedRevision, options);
  }

  public verifyTaskArtifacts(
    taskId: string,
    claims: Parameters<TasksRoutePort["verifyTaskArtifacts"]>[1],
    options?: TaskWorkspaceAccessOptions,
  ) {
    if (options === undefined) {
      return this.tasks.verifyTaskArtifacts(taskId, claims);
    }
    return this.tasks.verifyTaskArtifacts(taskId, claims, options);
  }

  public verifyTaskArtifactsWithRevision(
    taskId: string,
    claims: Parameters<TasksRoutePort["verifyTaskArtifactsWithRevision"]>[1],
    expectedRevision: number,
    options?: TaskWorkspaceAccessOptions,
  ) {
    return options === undefined
      ? this.tasks.verifyTaskArtifactsWithRevision(taskId, claims, expectedRevision)
      : this.tasks.verifyTaskArtifactsWithRevision(taskId, claims, expectedRevision, options);
  }

  public bulkUpdateTasks(
    input: Parameters<TasksRoutePort["bulkUpdateTasks"]>[0],
    options?: TaskWorkspaceAccessOptions,
  ) {
    if (options === undefined) {
      return this.tasks.bulkUpdateTasks(input);
    }
    return this.tasks.bulkUpdateTasks(input, options);
  }
}
