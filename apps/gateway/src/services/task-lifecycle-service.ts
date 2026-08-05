/* eslint-disable max-lines -- TaskLifecycleService centralizes task state transitions, agentic context, distress signals, retry budget, artifact verification, and worker crash bridging. */
import type {
  AgenticControlRequest,
  AgenticControlResponse,
  AgenticDiagnosticSignal,
  AgenticRunListItem,
  AgenticRunTreeEdge,
  AgenticRunTreeNode,
  AgenticRunTreeResponse,
  AgenticSurface,
  AgenticTaskContext,
  DurableRunStatus,
  RealtimeEvent,
  TaskActivityCreateInput,
  TaskActivityRecord,
  TaskArtifactClaim,
  TaskCreateInput,
  TaskDeliverableCreateInput,
  TaskDeliverableRecord,
  TaskRecord,
  TaskRetryBudget,
  TaskStatus,
  TaskSubagentCreateInput,
  TaskSubagentSession,
  TaskSubagentUpdateInput,
  TaskUpdateInput,
} from "@goatcitadel/contracts";
import { ConflictError, isDurableRunStatus, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { emitDistressSignal, resolveDistressSignal, type EmitDistressInput } from "./task-distress-engine.js";
import { verifyClaimedArtifacts, type ArtifactProbers } from "./task-artifact-verifier.js";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { createHash, randomUUID } from "node:crypto";
import { CoworkAgenticProjectionService } from "./cowork-agentic-projection-service.js";
import { canonicalJsonString } from "./evidence-receipt-service.js";

const DEFAULT_WORKSPACE_ID = "default";
const AGENTIC_CONTROL_IDEMPOTENCY_METHOD = "AGENTIC_CONTROL";
const AGENTIC_CONTROL_IDEMPOTENCY_ROUTE = "/internal/agentic-controls";
const AGENTIC_RUNTIME_CONTROL_CLAIM_LEASE_MS = 60_000;

type BulkTaskRevisionGuard = {
  expectedRevisionsByTaskId: Record<string, number>;
};

export type BulkTaskAction = BulkTaskRevisionGuard &
  (
    | { action: "unblock"; taskIds: string[] }
    | { action: "retry"; taskIds: string[]; reason: string }
    | { action: "reassign"; taskIds: string[]; assignedAgentId: string }
    | { action: "close"; taskIds: string[] }
  );

type TaskStorage = Pick<
  Storage,
  "taskActivities" | "taskDeliverables" | "tasks" | "taskSubagents" | "mutationIdempotency" | "runImmediateTransaction"
> &
  Partial<Pick<Storage, "chatDelegationRuns" | "chatDelegationSteps" | "chatExecutionPlans" | "chatSessionMeta">> &
  Partial<Pick<Storage, "chatTurnTraces" | "durableRuns">>;

type TaskRealtimeOptions = {
  eventAuthority: NonNullable<RealtimeEvent["eventAuthority"]>;
  eventClass: NonNullable<RealtimeEvent["eventClass"]>;
  links?: RealtimeEvent["links"];
};

interface AgenticControlMutationClaim {
  identity: {
    method: string;
    routePath: string;
    idempotencyKey: string;
    actorScope: string;
  };
  claimToken: string;
  claimKind: "new" | "retry_after_failure" | "retry_after_stale_claim";
}

interface AgenticControlCommitOutcome {
  nextStatus?: TaskStatus;
  nextAgenticStatus?: AgenticTaskContext["status"];
  responseStatus: AgenticControlResponse["status"];
  runtimeEffect: AgenticControlResponse["runtimeEffect"];
  responseMessage: string;
  canonicalDurableStatus?: DurableRunStatus;
  superseded?: boolean;
}

export interface TaskLifecycleServiceDependencies {
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: TaskRealtimeOptions,
  ): Promise<unknown>;
  pauseDurableRun?(runId: string, actorId?: string): Promise<{ status: string }>;
  cancelDurableRun?(runId: string, actorId?: string): Promise<{ status: string }>;
  recordAgenticDiagnosticSignal?(input: { task: TaskRecord; diagnostic: AgenticDiagnosticSignal }): void;
  storage: TaskStorage;
  probers?: ArtifactProbers;
}

export interface TaskWorkspaceAccessOptions {
  citadelId?: string;
  workspaceId?: string;
}

export class TaskLifecycleService {
  public constructor(private readonly deps: TaskLifecycleServiceDependencies) {}

  public async listTasks(
    limit: number,
    status?: TaskStatus,
    cursor?: string,
    view: "active" | "trash" | "all" = "active",
    workspaceId?: string,
  ): Promise<TaskRecord[]> {
    return await this.deps.storage.tasks.list({
      workspaceId: this.normalizeWorkspaceId(workspaceId),
      status,
      limit,
      cursor,
      view,
    });
  }

  public async getTask(taskId: string, options?: TaskWorkspaceAccessOptions): Promise<TaskRecord> {
    return await this.requireTaskInWorkspace(taskId, options);
  }

  /** Locks a task for a caller-owned cross-repository transaction. */
  public async lockTaskForDelegationAggregate(taskId: string): Promise<TaskRecord> {
    return await this.deps.storage.tasks.getForUpdate(taskId);
  }

  /** Locks a task subagent after the parent/run/step/task lock order is established. */
  public async lockDelegationSubagentProjection(agentSessionId: string): Promise<TaskSubagentSession> {
    return await this.deps.storage.taskSubagents.getByAgentSessionIdForUpdate(agentSessionId);
  }

  /** Persists delegation-owned task truth without publishing before commit. */
  public async persistDelegationAggregateTask(
    taskId: string,
    input: { status: TaskStatus; agenticContext: Partial<AgenticTaskContext> },
  ): Promise<TaskRecord> {
    const current = await this.deps.storage.tasks.get(taskId);
    return await this.deps.storage.tasks.updateWithRevision(
      taskId,
      {
        status: input.status,
        agenticContext: mergeAgenticContext(current.agenticContext, input.agenticContext),
      },
      current.revision,
    );
  }

  /** Publishes the already-committed aggregate task snapshot. */
  public async publishDelegationAggregateTask(task: TaskRecord): Promise<void> {
    await this.publishTaskEvent("task_updated", { task }, buildTaskRealtimeLinks(task));
  }

  /** Links an A2A task to canonical durable execution inside a caller-owned transaction. */
  public async persistA2ADurableRunLink(taskId: string, durableRunId: string): Promise<TaskRecord> {
    const current = await this.deps.storage.tasks.getForUpdate(taskId);
    const existingDurableRunId = current.agenticContext?.durableRunId?.trim();
    if (existingDurableRunId && existingDurableRunId !== durableRunId) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `Task ${taskId} is already linked to durable run ${existingDurableRunId}.`,
      });
    }
    if (existingDurableRunId === durableRunId) {
      return current;
    }
    return await this.deps.storage.tasks.updateWithRevision(
      taskId,
      {
        agenticContext: mergeAgenticContext(current.agenticContext, { durableRunId }),
      },
      current.revision,
    );
  }

  /** Publishes an A2A durable-run link only after the caller commits binding and task truth. */
  public async publishA2ADurableRunLink(task: TaskRecord): Promise<void> {
    await this.publishTaskEvent("task_updated", { task }, buildTaskRealtimeLinks(task));
  }

  /** Persists a dispatch-fenced waiting subagent projection without publishing before commit. */
  public async persistDelegationSubagentProjection(
    agentSessionId: string,
    input: TaskSubagentUpdateInput,
  ): Promise<TaskSubagentSession> {
    const current = await this.deps.storage.taskSubagents.findByAgentSessionId(agentSessionId);
    if (!current) {
      throw new NotFoundError({ entity: "Sub-agent session", id: agentSessionId });
    }
    return input.metadata
      ? await this.deps.storage.taskSubagents.updateByAgentSessionIdWithMetadataPatch(agentSessionId, {
          status: input.status,
          endedAt: input.endedAt,
          metadataPatch: input.metadata,
        })
      : await this.deps.storage.taskSubagents.updateByAgentSessionId(agentSessionId, input);
  }

  /** Publishes an already-committed dispatch-fenced subagent projection. */
  public async publishDelegationSubagentProjection(session: TaskSubagentSession): Promise<void> {
    await this.publishTaskEvent(
      "subagent_updated",
      { taskId: session.taskId, session },
      buildTaskRealtimeLinks(await this.deps.storage.tasks.find(session.taskId), session.taskId),
    );
  }

  /** Persists delegation evidence inside a caller-owned outcome transaction. */
  public async persistDelegationActivity(
    taskId: string,
    input: TaskActivityCreateInput,
    createdAt: string,
  ): Promise<TaskActivityRecord> {
    return await this.deps.storage.taskActivities.append(taskId, input, createdAt);
  }

  public async persistDelegationActivityOnce(
    activityId: string,
    taskId: string,
    input: TaskActivityCreateInput,
    createdAt: string,
  ): Promise<{ activity: TaskActivityRecord; created: boolean }> {
    return await this.deps.storage.taskActivities.appendOnce(activityId, taskId, input, createdAt);
  }

  public async publishDelegationActivity(activity: TaskActivityRecord): Promise<void> {
    await this.publishTaskEvent(
      "activity_logged",
      { taskId: activity.taskId, activity },
      buildTaskRealtimeLinks(await this.deps.storage.tasks.find(activity.taskId), activity.taskId),
    );
  }

  /** Persists a delegation deliverable inside a caller-owned outcome transaction. */
  public async persistDelegationDeliverable(
    taskId: string,
    input: TaskDeliverableCreateInput,
    createdAt: string,
  ): Promise<TaskDeliverableRecord> {
    return await this.deps.storage.taskDeliverables.append(taskId, input, createdAt);
  }

  public async publishDelegationDeliverable(deliverable: TaskDeliverableRecord): Promise<void> {
    await this.publishTaskEvent(
      "deliverable_added",
      { taskId: deliverable.taskId, deliverable },
      buildTaskRealtimeLinks(await this.deps.storage.tasks.find(deliverable.taskId), deliverable.taskId),
    );
  }

  public async createTask(input: TaskCreateInput, options?: { taskId?: string }): Promise<TaskRecord> {
    const normalizedInput = {
      ...input,
      workspaceId: this.normalizeWorkspaceId(input.workspaceId),
    };
    const created = options?.taskId
      ? await this.deps.storage.tasks.create(normalizedInput, undefined, { taskId: options.taskId })
      : await this.deps.storage.tasks.create(normalizedInput);
    await this.publishTaskEvent("task_created", { task: created }, buildTaskRealtimeLinks(created));
    return created;
  }

  public async updateTask(
    taskId: string,
    input: TaskUpdateInput,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskRecord> {
    const current = await this.requireTaskInWorkspace(taskId, options);
    return await this.updateTaskWithRevision(taskId, input, current.revision, options);
  }

  public async updateTaskWithRevision(
    taskId: string,
    input: TaskUpdateInput,
    expectedRevision: number,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskRecord> {
    const current = await this.requireTaskInWorkspace(taskId, options);
    assertTaskExpectedRevision(current, expectedRevision);
    if (input.status === "done") {
      const deliverables = await this.deps.storage.taskDeliverables.countByTask(taskId);
      if (deliverables < 1) {
        throw new ValidationError({
          message: "Cannot mark task done without at least one deliverable",
        });
      }
    }

    const updated = await this.deps.storage.tasks.updateWithRevision(taskId, input, expectedRevision);
    await this.publishTaskEvent("task_updated", { task: updated }, buildTaskRealtimeLinks(updated));
    return updated;
  }

  public async emitDistressSignal(
    taskId: string,
    input: EmitDistressInput,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskRecord> {
    const current = await this.requireTaskInWorkspace(taskId, options);
    return await this.emitDistressSignalWithRevision(taskId, input, current.revision, options);
  }

  public async emitDistressSignalWithRevision(
    taskId: string,
    input: EmitDistressInput,
    expectedRevision: number,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskRecord> {
    const current = await this.requireTaskInWorkspace(taskId, options);
    assertTaskExpectedRevision(current, expectedRevision);
    const next = emitDistressSignal(current.distressSignals, input);
    const updated = await this.deps.storage.tasks.updateWithRevision(
      taskId,
      { distressSignals: next },
      expectedRevision,
    );
    const newSignal = next.find((s) => !current.distressSignals?.some((existing) => existing.signalId === s.signalId));
    await this.publishTaskEvent(
      "task_distress_emitted",
      { taskId, signal: newSignal ?? next[0] },
      buildTaskRealtimeLinks(updated),
    );
    return updated;
  }

  public async resolveDistressSignal(
    taskId: string,
    signalId: string,
    input: { resolvedBy?: string } = {},
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskRecord> {
    const current = await this.requireTaskInWorkspace(taskId, options);
    return await this.resolveDistressSignalWithRevision(taskId, signalId, input, current.revision, options);
  }

  public async resolveDistressSignalWithRevision(
    taskId: string,
    signalId: string,
    input: { resolvedBy?: string },
    expectedRevision: number,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskRecord> {
    const current = await this.requireTaskInWorkspace(taskId, options);
    assertTaskExpectedRevision(current, expectedRevision);
    const next = resolveDistressSignal(current.distressSignals, signalId, input);
    const matched = current.distressSignals?.some((s) => s.signalId === signalId && !s.resolvedAt);
    if (!matched) {
      throw new ValidationError({
        message: `No unresolved distress signal with signalId="${signalId}" on task ${taskId}`,
      });
    }
    const updated = await this.deps.storage.tasks.updateWithRevision(
      taskId,
      { distressSignals: next },
      expectedRevision,
    );
    await this.publishTaskEvent(
      "task_distress_resolved",
      { taskId, signalId, resolvedBy: input.resolvedBy },
      buildTaskRealtimeLinks(updated),
    );
    return updated;
  }

  public async setRetryBudget(
    taskId: string,
    maxRetries: number,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskRecord> {
    const current = await this.requireTaskInWorkspace(taskId, options);
    return await this.setRetryBudgetWithRevision(taskId, maxRetries, current.revision, options);
  }

  public async setRetryBudgetWithRevision(
    taskId: string,
    maxRetries: number,
    expectedRevision: number,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskRecord> {
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new ValidationError({ message: "maxRetries must be a non-negative integer" });
    }
    const current = await this.requireTaskInWorkspace(taskId, options);
    assertTaskExpectedRevision(current, expectedRevision);
    const retryBudget: TaskRetryBudget = {
      maxRetries,
      retryCount: current.retryBudget?.retryCount ?? 0,
    };
    return await this.deps.storage.tasks.updateWithRevision(taskId, { retryBudget }, expectedRevision);
  }

  public async recordRetryAttempt(
    taskId: string,
    reason: string,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskRecord> {
    const current = await this.requireTaskInWorkspace(taskId, options);
    const budget = current.retryBudget ?? { maxRetries: 0, retryCount: 0 };
    const nextCount = budget.retryCount + 1;
    const now = new Date().toISOString();
    const exhausted = nextCount > budget.maxRetries;
    const retryBudget: TaskRetryBudget = {
      ...budget,
      retryCount: nextCount,
      lastAttemptAt: now,
      exhaustedAt: exhausted ? now : budget.exhaustedAt,
    };
    if (!exhausted) {
      const updated = await this.deps.storage.tasks.updateWithRevision(taskId, { retryBudget }, current.revision);
      await this.publishTaskEvent(
        "task_retry_attempted",
        { taskId, retryCount: nextCount, reason },
        buildTaskRealtimeLinks(updated),
      );
      return updated;
    }
    const distressSignals = emitDistressSignal(current.distressSignals, {
      code: "retry_budget_exhausted",
      severity: "critical",
      title: "Retry budget exhausted",
      summary: reason,
    });
    const updated = await this.deps.storage.tasks.updateWithRevision(
      taskId,
      {
        retryBudget,
        distressSignals,
        status: "blocked",
      },
      current.revision,
    );
    await this.publishTaskEvent(
      "task_retry_budget_exhausted",
      { taskId, retryCount: nextCount, reason },
      buildTaskRealtimeLinks(updated),
    );
    return updated;
  }

  public async autoBlockOnIncompleteExit(taskId: string, runId: string): Promise<TaskRecord> {
    const current = await this.deps.storage.tasks.get(taskId);
    if (current.status === "done" || current.status === "blocked") {
      return current;
    }
    const diagnostic: AgenticDiagnosticSignal = {
      signalId: `worker-incomplete-exit-${runId}`,
      code: "worker_crash",
      severity: "critical",
      title: "Worker exited without closing the task",
      summary: `Durable run ${runId} exited without a terminal close.`,
      evidenceRef: `durable-run:${runId}`,
      createdAt: new Date().toISOString(),
    };
    const distressSignals = emitDistressSignal(current.distressSignals, {
      code: "worker_crash",
      severity: "critical",
      title: diagnostic.title,
      summary: diagnostic.summary,
      evidenceRef: diagnostic.evidenceRef,
    });
    const agenticContext = current.agenticContext
      ? {
          ...current.agenticContext,
          status: "failed" as const,
          failureClass: "crash" as const,
          diagnostics: [...(current.agenticContext.diagnostics ?? []), diagnostic],
        }
      : undefined;
    const update: TaskUpdateInput = { distressSignals, status: "blocked" };
    if (agenticContext) {
      update.agenticContext = agenticContext;
    }
    const updated = await this.deps.storage.tasks.updateWithRevision(taskId, update, current.revision);
    if (agenticContext) {
      this.deps.recordAgenticDiagnosticSignal?.({ task: updated, diagnostic });
    }
    await this.publishTaskEvent(
      "task_auto_blocked",
      { taskId, runId, reason: "worker_incomplete_exit", diagnostic },
      buildTaskRealtimeLinks(updated),
    );
    return updated;
  }

  public async bulkUpdateTasks(input: BulkTaskAction, options?: TaskWorkspaceAccessOptions): Promise<TaskRecord[]> {
    validateBulkTaskRevisionSet(input);
    const committed = await this.deps.storage.runImmediateTransaction(async () => {
      const lockedByTaskId = new Map<string, TaskRecord>();
      for (const taskId of [...input.taskIds].sort()) {
        const task = await this.deps.storage.tasks.getForUpdate(taskId);
        if (!this.isTaskAllowedForWorkspace(task, options)) {
          throw new NotFoundError({ entity: "Task", id: taskId });
        }
        assertTaskExpectedRevision(task, input.expectedRevisionsByTaskId[taskId]!);
        lockedByTaskId.set(taskId, task);
      }
      if (input.action === "close") {
        for (const taskId of input.taskIds) {
          if ((await this.deps.storage.taskDeliverables.countByTask(taskId)) < 1) {
            throw new ValidationError({
              message: `Cannot mark task ${taskId} done without at least one deliverable`,
            });
          }
        }
      }

      return await Promise.all(
        input.taskIds.map(async (taskId) => {
          const current = lockedByTaskId.get(taskId)!;
          const expectedRevision = input.expectedRevisionsByTaskId[taskId]!;
          return await this.deps.storage.tasks.updateWithRevision(
            taskId,
            buildBulkTaskUpdate(current, input),
            expectedRevision,
          );
        }),
      );
    });

    for (const task of committed) {
      const eventType = input.action === "retry" ? retryTaskEventType(task) : "task_updated";
      await this.publishTaskEvent(
        eventType,
        input.action === "retry"
          ? {
              taskId: task.taskId,
              retryCount: task.retryBudget?.retryCount ?? 0,
              reason: input.reason,
            }
          : { task },
        buildTaskRealtimeLinks(task),
      );
    }
    return committed;
  }

  public async verifyTaskArtifacts(
    taskId: string,
    claims: TaskArtifactClaim[],
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskRecord> {
    const current = await this.requireTaskInWorkspace(taskId, options);
    return await this.verifyTaskArtifactsWithRevision(taskId, claims, current.revision, options);
  }

  public async verifyTaskArtifactsWithRevision(
    taskId: string,
    claims: TaskArtifactClaim[],
    expectedRevision: number,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskRecord> {
    const current = await this.requireTaskInWorkspace(taskId, options);
    assertTaskExpectedRevision(current, expectedRevision);
    if (!this.deps.probers) {
      throw new ValidationError({ message: "Artifact verification probers not configured" });
    }
    const verification = await verifyClaimedArtifacts(claims, this.deps.probers);
    const merged = [...(current.artifactVerification ?? []), ...verification];
    const missingCount = verification.filter((v) => v.status === "missing").length;
    const failedCount = verification.filter((v) => v.status === "failed").length;
    const hasFailures = missingCount + failedCount > 0;
    const distressSignals = hasFailures
      ? emitDistressSignal(current.distressSignals, {
          code: "artifact_missing",
          severity: "critical",
          title: "Claimed artifacts not found",
          summary: `${missingCount} missing, ${failedCount} unreachable`,
        })
      : current.distressSignals;
    const updated = await this.deps.storage.tasks.updateWithRevision(
      taskId,
      {
        artifactVerification: merged,
        distressSignals,
        status: hasFailures ? "blocked" : current.status,
      },
      expectedRevision,
    );
    await this.publishTaskEvent(
      "task_artifacts_verified",
      { taskId, verifiedCount: verification.filter((v) => v.status === "verified").length, missingCount, failedCount },
      buildTaskRealtimeLinks(updated),
    );
    return updated;
  }

  public async listAgenticRuns(
    input: {
      workspaceId?: string;
      limit?: number;
      cursor?: string;
      status?: AgenticTaskContext["status"];
      surface?: AgenticSurface;
      sessionId?: string;
      boardId?: string;
      parentRunId?: string;
    } = {},
  ): Promise<{ items: AgenticRunListItem[]; nextCursor?: string }> {
    const limit = clampLimit(input.limit, 200);
    const workspaceId = this.normalizeWorkspaceId(input.workspaceId);
    const matched: TaskRecord[] = [];
    let cursor = input.cursor;
    let exhausted = false;
    const pageLimit = Math.max(limit + 1, Math.min(500, limit * 2));
    while (matched.length <= limit && !exhausted) {
      const tasks = await this.deps.storage.tasks.list({
        workspaceId,
        limit: pageLimit,
        cursor,
        view: "active",
      });
      if (tasks.length === 0) {
        break;
      }
      for (const task of tasks) {
        if (isAgenticRunListMatch(task, input)) {
          matched.push(task);
          if (matched.length > limit) {
            break;
          }
        }
      }
      const lastTask = tasks[tasks.length - 1]!;
      cursor = buildTaskCursor(lastTask);
      exhausted = tasks.length < pageLimit;
    }
    const page = matched.slice(0, limit);
    const taskItems = page.map(mapAgenticRunListItem);
    const projectedRuns = input.cursor
      ? []
      : await this.listProjectedCoworkRuns({
          workspaceId,
          limit,
          status: input.status,
          surface: input.surface,
          sessionId: input.sessionId,
          boardId: input.boardId,
          parentRunId: input.parentRunId,
        });
    const seenRunIds = new Set(taskItems.map((item) => item.runId).filter(Boolean));
    const projectedPage = projectedRuns.filter((item) => !seenRunIds.has(item.runId)).slice(0, limit);
    const combinedPage = [...taskItems, ...projectedPage].sort(compareAgenticRunListItems).slice(0, limit);
    const pageTaskIds = new Set(page.map((task) => task.taskId));
    const lastReturnedTaskItem = [...combinedPage].reverse().find((item) => pageTaskIds.has(item.taskId));
    const lastReturnedTask = lastReturnedTaskItem
      ? page.find((task) => task.taskId === lastReturnedTaskItem.taskId)
      : undefined;
    const lastReturnedTaskIndex = lastReturnedTask
      ? matched.findIndex((task) => task.taskId === lastReturnedTask.taskId)
      : -1;
    const hasMoreTaskMatches = lastReturnedTaskIndex >= 0 && lastReturnedTaskIndex < matched.length - 1;
    return {
      items: combinedPage,
      ...(hasMoreTaskMatches && lastReturnedTask ? { nextCursor: buildTaskCursor(lastReturnedTask) } : {}),
    };
  }

  public async getAgenticRunTree(runId: string, options?: TaskWorkspaceAccessOptions): Promise<AgenticRunTreeResponse> {
    const normalizedRunId = sanitizeRequired(runId, "runId");
    const workspaceOptions = this.normalizeWorkspaceAccessOptions(options);
    const tasks = await this.listTasksInAgenticRun(normalizedRunId, workspaceOptions);
    if (tasks.length === 0) {
      const projected = await this.buildProjectedCoworkRunTree(normalizedRunId, workspaceOptions);
      if (projected) {
        return projected;
      }
      throw new ValidationError({ message: `Agentic run not found: ${normalizedRunId}` });
    }

    const rootTask = tasks.find((task) => task.agenticContext?.runId === normalizedRunId) ?? tasks[0]!;
    const nodes: AgenticRunTreeNode[] = [];
    const edges: AgenticRunTreeEdge[] = [];
    const diagnostics: AgenticDiagnosticSignal[] = [];
    const rootNodeId = `run:${normalizedRunId}`;
    nodes.push({
      id: rootNodeId,
      kind: "run",
      label: rootTask.title,
      status: rootTask.agenticContext?.status ?? rootTask.status,
      taskId: rootTask.taskId,
      summary: rootTask.description,
      metadata: compactRecord({
        surface: rootTask.agenticContext?.surface,
        contextMode: rootTask.agenticContext?.contextMode,
        parentSessionId: rootTask.agenticContext?.parentSessionId,
        workspaceScope: rootTask.agenticContext?.workspaceScope,
      }),
    });

    for (const task of tasks) {
      const taskNodeId = `task:${task.taskId}`;
      const parentId =
        task.taskId === rootTask.taskId ? rootNodeId : `run:${task.agenticContext?.parentRunId ?? normalizedRunId}`;
      nodes.push({
        id: taskNodeId,
        kind: "task",
        label: task.title,
        status: task.agenticContext?.status ?? task.status,
        parentId,
        taskId: task.taskId,
        summary: task.description,
        metadata: compactRecord({
          assignedAgentId: task.assignedAgentId,
          profileId: task.agenticContext?.profileId,
          assigneeProfileId: task.agenticContext?.assigneeProfileId,
          failureClass: task.agenticContext?.failureClass,
          heartbeatAt: task.agenticContext?.heartbeatAt,
          filesTouched: task.agenticContext?.filesTouched,
          tokenTotal: task.agenticContext?.tokenTotal,
          costUsd: task.agenticContext?.costUsd,
        }),
      });
      edges.push({ from: parentId, to: taskNodeId, kind: "contains" });
      diagnostics.push(...(task.agenticContext?.diagnostics ?? []));

      for (const subagent of await this.deps.storage.taskSubagents.listByTask(task.taskId, 200)) {
        const subagentNodeId = `subagent:${subagent.agentSessionId}`;
        const waiting = subagent.metadata?.waiting;
        nodes.push({
          id: subagentNodeId,
          kind: "subagent",
          label: subagent.agentName ?? subagent.agentSessionId,
          status: subagent.status,
          parentId: taskNodeId,
          taskId: task.taskId,
          agentSessionId: subagent.agentSessionId,
          summary: waiting?.reason,
          metadata: compactRecord({
            role: subagent.metadata?.profileId ?? subagent.agentName,
            index: subagent.metadata?.index,
            depth: subagent.metadata?.depth,
            dependsOnStepIds: subagent.metadata?.dependsOnStepIds,
            profileId: subagent.metadata?.profileId,
            contextMode: subagent.metadata?.contextMode,
            heartbeatAt: subagent.metadata?.heartbeatAt,
            timeoutAt: subagent.metadata?.timeoutAt,
            failureClass: subagent.metadata?.failureClass,
            filesTouched: subagent.metadata?.filesTouched,
            tokenTotal: subagent.metadata?.tokenTotal,
            costUsd: subagent.metadata?.costUsd,
            childTraceStatus: waiting?.status,
            childSessionId: waiting ? subagent.agentSessionId : undefined,
            childTurnId: waiting?.childTurnId,
            durableRunId: waiting?.durableRunId,
            waitObservedAt: waiting?.observedAt,
          }),
        });
        edges.push({ from: taskNodeId, to: subagentNodeId, kind: "spawned" });
        diagnostics.push(...(subagent.metadata?.diagnostics ?? []));
      }

      for (const deliverable of await this.deps.storage.taskDeliverables.listByTask(task.taskId, 200)) {
        const artifactNodeId = `artifact:${deliverable.deliverableId}`;
        nodes.push({
          id: artifactNodeId,
          kind: "artifact",
          label: deliverable.title,
          status: deliverable.deliverableType,
          parentId: taskNodeId,
          taskId: task.taskId,
          summary: deliverable.description,
          metadata: compactRecord({ path: deliverable.path }),
        });
        edges.push({ from: taskNodeId, to: artifactNodeId, kind: "produced" });
      }
    }

    const derivedDiagnostics = deriveAgenticDiagnostics({ rootTask, tasks, diagnostics, nodes });
    diagnostics.push(...derivedDiagnostics);
    const renderedDiagnosticIds = new Set<string>();
    for (const diagnostic of diagnostics) {
      if (renderedDiagnosticIds.has(diagnostic.signalId)) {
        continue;
      }
      renderedDiagnosticIds.add(diagnostic.signalId);
      const diagnosticNodeId = `diagnostic:${diagnostic.signalId}`;
      nodes.push({
        id: diagnosticNodeId,
        kind: "diagnostic",
        label: diagnostic.title,
        status: diagnostic.severity,
        parentId: rootNodeId,
        summary: diagnostic.summary,
        metadata: compactRecord({ code: diagnostic.code, evidenceRef: diagnostic.evidenceRef }),
      });
      edges.push({ from: rootNodeId, to: diagnosticNodeId, kind: "blocked_by" });
    }

    return {
      runId: normalizedRunId,
      taskRevision: rootTask.revision,
      boardId: rootTask.agenticContext?.boardId,
      generatedAt: new Date().toISOString(),
      nodes,
      edges,
      diagnostics,
      controls: buildAgenticControls(rootTask),
    };
  }

  private async listProjectedCoworkRuns(input: {
    workspaceId?: string;
    limit?: number;
    status?: AgenticTaskContext["status"];
    surface?: AgenticSurface;
    sessionId?: string;
    boardId?: string;
    parentRunId?: string;
  }): Promise<AgenticRunListItem[]> {
    const projection = this.createCoworkProjectionService();
    return (
      projection?.listAgenticRuns({
        ...input,
        status: input.status,
      }) ?? []
    );
  }

  private async buildProjectedCoworkRunTree(
    runId: string,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<AgenticRunTreeResponse | undefined> {
    return this.createCoworkProjectionService()?.getAgenticRunTree(runId, { workspaceId: options?.workspaceId });
  }

  private createCoworkProjectionService(): CoworkAgenticProjectionService | undefined {
    if (
      !this.deps.storage.chatDelegationRuns ||
      !this.deps.storage.chatDelegationSteps ||
      !this.deps.storage.chatTurnTraces ||
      !this.deps.storage.durableRuns
    ) {
      return undefined;
    }
    return new CoworkAgenticProjectionService({
      chatDelegationRuns: this.deps.storage.chatDelegationRuns,
      chatDelegationSteps: this.deps.storage.chatDelegationSteps,
      chatExecutionPlans: this.deps.storage.chatExecutionPlans,
      chatSessionMeta: this.deps.storage.chatSessionMeta,
      chatTurnTraces: this.deps.storage.chatTurnTraces,
      durableRuns: this.deps.storage.durableRuns,
    });
  }

  public async updateTaskAgenticContext(taskId: string, patch: Partial<AgenticTaskContext>): Promise<TaskRecord> {
    const updated = await this.deps.storage.runImmediateTransaction(async () => {
      const current = await this.deps.storage.tasks.getForUpdate(taskId);
      return await this.deps.storage.tasks.updateWithRevision(
        taskId,
        {
          agenticContext: mergeAgenticContext(current.agenticContext, patch),
        },
        current.revision,
      );
    });
    await this.publishTaskEvent(
      "agentic_context_updated",
      { taskId, agenticContext: updated.agenticContext },
      buildTaskRealtimeLinks(updated),
    );
    return updated;
  }

  public async recordTaskHeartbeat(
    taskId: string,
    input: { summary?: string; agentSessionId?: string },
  ): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const task = await this.updateTaskAgenticContext(taskId, { heartbeatAt: now });
    if (input.agentSessionId) {
      const subagent = await this.deps.storage.taskSubagents.findByAgentSessionId(input.agentSessionId);
      if (subagent) {
        await this.deps.storage.taskSubagents.updateByAgentSessionIdWithMetadataPatch(input.agentSessionId, {
          metadataPatch: { heartbeatAt: now },
        });
      }
    }
    await this.appendTaskActivity(taskId, {
      activityType: "heartbeat",
      message: input.summary ?? "Agentic task heartbeat recorded.",
      metadata: compactRecord({ heartbeatAt: now, agentSessionId: input.agentSessionId }),
    });
    return task;
  }

  public async appendTaskDiagnostic(
    taskId: string,
    input: Omit<AgenticDiagnosticSignal, "signalId" | "createdAt"> & {
      signalId?: string;
      createdAt?: string;
    },
    options?: TaskWorkspaceAccessOptions,
  ): Promise<AgenticDiagnosticSignal> {
    const task = await this.requireTaskInWorkspace(taskId, options);
    const diagnostic: AgenticDiagnosticSignal = {
      signalId: input.signalId ?? randomUUID(),
      code: input.code,
      severity: input.severity,
      title: input.title,
      summary: input.summary,
      evidenceRef: input.evidenceRef,
      createdAt: input.createdAt ?? new Date().toISOString(),
      resolvedAt: input.resolvedAt,
    };
    const updatedTask = await this.deps.storage.tasks.updateWithRevision(
      taskId,
      {
        agenticContext: {
          ...(task.agenticContext ?? {}),
          diagnostics: [...(task.agenticContext?.diagnostics ?? []), diagnostic],
          failureClass: task.agenticContext?.failureClass ?? mapDiagnosticToFailureClass(diagnostic.code),
        },
      },
      task.revision,
    );
    await this.appendTaskActivity(
      taskId,
      {
        activityType: "diagnostic",
        message: diagnostic.summary,
        metadata: diagnostic as unknown as Record<string, unknown>,
      },
      options,
    );
    try {
      this.deps.recordAgenticDiagnosticSignal?.({ task: updatedTask, diagnostic });
    } catch (error) {
      try {
        await this.appendTaskActivity(
          taskId,
          {
            activityType: "diagnostic",
            message: "Agentic diagnostic was saved, but improvement-ledger mirroring failed.",
            metadata: {
              code: "agentic_diagnostic_mirror_failed",
              diagnosticSignalId: diagnostic.signalId,
              error: error instanceof Error ? error.message : String(error),
            },
          },
          options,
        );
      } catch (activityError) {
        process.stderr.write(
          `[task-lifecycle] failed to record agentic diagnostic mirror failure: ${
            activityError instanceof Error ? activityError.message : String(activityError)
          }\n`,
        );
      }
    }
    return diagnostic;
  }

  public async invokeAgenticControl(
    runId: string,
    input: AgenticControlRequest,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<AgenticControlResponse> {
    const task = await this.findRootTaskForRun(runId, this.normalizeWorkspaceAccessOptions(options));
    const now = new Date().toISOString();
    const controlId = input.controlId?.trim() || (await this.buildImplicitAgenticControlId(task, runId, input));
    input = { ...input, controlId };
    const existing = await findControlActivityForReplay(this.deps.storage.taskActivities, task.taskId, controlId);
    if (existing) {
      return buildValidatedIdempotentControlReplay(task, input, existing);
    }
    const expectedRevision = input.expectedRevision ?? task.revision;
    assertTaskExpectedRevision(task, expectedRevision);

    const identity = {
      method: AGENTIC_CONTROL_IDEMPOTENCY_METHOD,
      routePath: AGENTIC_CONTROL_IDEMPOTENCY_ROUTE,
      idempotencyKey: controlId,
      actorScope: task.taskId,
    };
    const claim = await this.deps.storage.mutationIdempotency.claim({
      ...identity,
      payloadHash: hashAgenticControlPayload(runId, task.taskId, input),
      leaseDurationMs: AGENTIC_RUNTIME_CONTROL_CLAIM_LEASE_MS,
    });
    if (claim.outcome === "payload_mismatch") {
      throw new ValidationError({
        field: "controlId",
        message: "controlId has already been used for a different agentic control payload.",
      });
    }
    if (claim.outcome === "duplicate" || claim.outcome === "in_progress") {
      const receipt = await findControlActivityForReplay(this.deps.storage.taskActivities, task.taskId, controlId);
      if (receipt) {
        return buildValidatedIdempotentControlReplay(task, input, receipt);
      }
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message:
          claim.outcome === "in_progress"
            ? `Agentic control ${controlId} is already in progress.`
            : `Agentic control ${controlId} is completed without its durable activity receipt.`,
      });
    }
    const claimToken = claim.record.claimToken?.trim();
    if (!claimToken) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `Agentic control ${controlId} was claimed without an ownership token.`,
      });
    }
    const mutationClaim: AgenticControlMutationClaim = { identity, claimToken, claimKind: claim.claimKind };

    const reason = input.reason?.trim() || input.instruction?.trim() || "Operator control recorded.";
    let nextStatus: TaskStatus | undefined;
    let nextAgenticStatus: AgenticTaskContext["status"] | undefined;
    let runtimeEffect: AgenticControlResponse["runtimeEffect"] = "state_only";
    let responseStatus: AgenticControlResponse["status"] = "recorded";
    let runtimeReportedStatus: string | undefined;
    const currentStatus = task.agenticContext?.status ?? task.status;
    const rejectionReason = validateAgenticControlTransition(currentStatus, input);

    if (rejectionReason) {
      return await this.recordRejectedAgenticControl(task, input, {
        controlId,
        mutationClaim,
        message: rejectionReason,
        now,
        runtimeEffect,
        signalPrefix: "unsafe-control",
        title: "Unsafe run control rejected",
      });
    }

    let runtimeEffectAlreadyApplied =
      mutationClaim && mutationClaim.claimKind !== "new"
        ? await this.probeAgenticRuntimeControlOutcome(task, input, controlId!)
        : false;

    if (input.action === "pause") {
      const durableRunId = task.agenticContext?.durableRunId?.trim();
      if (durableRunId && this.deps.pauseDurableRun) {
        try {
          if (!runtimeEffectAlreadyApplied) {
            runtimeReportedStatus = (await this.deps.pauseDurableRun(durableRunId, input.actorId ?? "operator")).status;
          }
        } catch (error) {
          runtimeEffectAlreadyApplied = await this.probeAgenticRuntimeControlOutcome(
            task,
            input,
            controlId ?? input.action,
          );
          if (!runtimeEffectAlreadyApplied) {
            return await this.recordRejectedAgenticControl(task, input, {
              controlId,
              mutationClaim,
              evidenceRef: durableRunId,
              message: `Could not pause attached durable run: ${formatErrorMessage(error)}`,
              now,
              runtimeEffect: "state_only",
              signalPrefix: "durable-control",
              title: "Durable run control rejected",
            });
          }
        }
        runtimeEffect = "runtime_pause";
        responseStatus = "applied";
        nextAgenticStatus = "paused";
      }
    } else if (input.action === "cancel") {
      const durableRunId = task.agenticContext?.durableRunId?.trim();
      if (durableRunId && this.deps.cancelDurableRun) {
        try {
          if (!runtimeEffectAlreadyApplied) {
            runtimeReportedStatus = (await this.deps.cancelDurableRun(durableRunId, input.actorId ?? "operator"))
              .status;
          }
        } catch (error) {
          runtimeEffectAlreadyApplied = await this.probeAgenticRuntimeControlOutcome(
            task,
            input,
            controlId ?? input.action,
          );
          if (!runtimeEffectAlreadyApplied) {
            return await this.recordRejectedAgenticControl(task, input, {
              controlId,
              mutationClaim,
              evidenceRef: durableRunId,
              message: `Could not cancel attached durable run: ${formatErrorMessage(error)}`,
              now,
              runtimeEffect: "state_only",
              signalPrefix: "durable-control",
              title: "Durable run control rejected",
            });
          }
        }
        runtimeEffect = "runtime_cancel";
        responseStatus = "applied";
        nextStatus = "blocked";
        nextAgenticStatus = "cancelled";
      }
    } else if (input.action === "kill_child") {
      if (!input.agentSessionId) {
        await this.failAgenticControlMutation(mutationClaim, now);
        throw new ValidationError({ field: "agentSessionId", message: "agentSessionId is required for kill_child." });
      }
      const subagent = await this.deps.storage.taskSubagents.findByAgentSessionId(input.agentSessionId);
      const runTasks = await this.listTasksInAgenticRun(runId, this.normalizeWorkspaceAccessOptions(options), {
        includeParentRunLinks: false,
      });
      const allowedTaskIds = new Set(runTasks.map((candidate) => candidate.taskId));
      if (!subagent || !allowedTaskIds.has(subagent.taskId)) {
        await this.failAgenticControlMutation(mutationClaim, now);
        throw new NotFoundError({ entity: "Sub-agent session", id: input.agentSessionId });
      }
    } else if (input.action === "open_child") {
      runtimeEffect = "navigation";
    }

    const responseMessage =
      (input.action === "approve" || input.action === "reject") && runtimeEffect === "state_only"
        ? "No approval was resolved. Use the canonical approval-resolution endpoint to approve or reject the request."
        : runtimeEffect === "state_only"
          ? "Control was recorded in the durable board. Live runtime effects are only applied where an executor is attached."
          : runtimeEffect === "runtime_pause"
            ? "Durable run pause was applied and mirrored into the Cowork board."
            : runtimeEffect === "runtime_cancel"
              ? "Durable run cancellation was applied and mirrored into the Cowork board."
              : "Control was recorded with an operator-visible runtime effect.";
    try {
      const committed = await this.deps.storage.runImmediateTransaction(async () => {
        const current = await this.deps.storage.tasks.getForUpdate(task.taskId);
        assertTaskExpectedRevision(current, expectedRevision);
        const outcome = await this.reconcileAgenticControlCommit(
          current,
          input,
          {
            nextStatus,
            nextAgenticStatus,
            responseStatus,
            runtimeEffect,
            responseMessage,
          },
          runtimeReportedStatus,
          controlId,
        );
        const updatedTask =
          outcome.nextStatus || outcome.nextAgenticStatus
            ? await this.deps.storage.tasks.updateWithRevision(
                task.taskId,
                {
                  ...(outcome.nextStatus ? { status: outcome.nextStatus } : {}),
                  agenticContext: mergeAgenticContext(current.agenticContext, {
                    ...(outcome.nextAgenticStatus ? { status: outcome.nextAgenticStatus } : {}),
                  }),
                },
                expectedRevision,
              )
            : current;
        const persistedActivity = await this.deps.storage.taskActivities.append(
          task.taskId,
          {
            activityType: "control",
            message: outcome.superseded
              ? `${input.action} control superseded: ${outcome.responseMessage}`
              : `${input.action} control recorded: ${reason}`,
            agentId: input.actorId,
            metadata: buildAgenticControlActivityMetadata(input, {
              controlId,
              responseMessage: outcome.responseMessage,
              resultStatus: outcome.responseStatus,
              runtimeEffect: outcome.runtimeEffect,
              recordedAt: now,
              canonicalDurableStatus: outcome.canonicalDurableStatus,
              superseded: outcome.superseded,
            }),
          },
          now,
        );
        await this.completeAgenticControlMutation(mutationClaim, now);
        const response: AgenticControlResponse = {
          action: input.action,
          taskId: task.taskId,
          taskRevision: updatedTask.revision,
          runId: current.agenticContext?.runId,
          status: outcome.responseStatus,
          runtimeEffect: outcome.runtimeEffect,
          controlId,
          message: outcome.responseMessage,
        };
        return { persistedActivity, response };
      });
      await this.publishDelegationActivity(committed.persistedActivity);
      return committed.response;
    } catch (error) {
      await this.failAgenticControlMutation(mutationClaim, now);
      throw error;
    }
  }

  private async reconcileAgenticControlCommit(
    currentTask: TaskRecord,
    input: AgenticControlRequest,
    planned: AgenticControlCommitOutcome,
    runtimeReportedStatus: string | undefined,
    controlId: string,
  ): Promise<AgenticControlCommitOutcome> {
    if (
      (input.action !== "pause" && input.action !== "cancel") ||
      (planned.runtimeEffect !== "runtime_pause" && planned.runtimeEffect !== "runtime_cancel")
    ) {
      return planned;
    }
    const durableRunId = currentTask.agenticContext?.durableRunId?.trim();
    if (!durableRunId) {
      return planned;
    }

    let canonicalDurableStatus = isDurableRunStatus(runtimeReportedStatus) ? runtimeReportedStatus : undefined;
    if (this.deps.storage.durableRuns) {
      try {
        // The task row is already locked. This is intentionally a committed-state
        // read, not a second row lock that would invert durable-run -> task order.
        canonicalDurableStatus = (await this.deps.storage.durableRuns.getRun(durableRunId)).status;
      } catch (error) {
        if (!(error instanceof NotFoundError) || !canonicalDurableStatus) {
          throw new ConflictError({
            code: "WRITE_CONFLICT",
            message: `Agentic control ${controlId} could not reconcile canonical durable status: ${formatErrorMessage(error)}`,
          });
        }
      }
    }
    if (!canonicalDurableStatus) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `Agentic control ${controlId} could not reconcile canonical durable status.`,
      });
    }

    const requestedDurableStatus: DurableRunStatus = input.action === "pause" ? "paused" : "cancelled";
    if (canonicalDurableStatus === requestedDurableStatus) {
      return { ...planned, canonicalDurableStatus };
    }

    const canonicalProjection = mapDurableStatusToTaskProjection(canonicalDurableStatus);
    const effectiveRuntimeEffect: AgenticControlResponse["runtimeEffect"] =
      canonicalDurableStatus === "cancelled"
        ? "runtime_cancel"
        : canonicalDurableStatus === "paused"
          ? "runtime_pause"
          : planned.runtimeEffect;
    return {
      ...planned,
      ...canonicalProjection,
      runtimeEffect: effectiveRuntimeEffect,
      responseMessage: `Durable run ${input.action} was superseded by ${describeDurableSupersession(
        canonicalDurableStatus,
      )}; canonical ${canonicalDurableStatus} state was mirrored into the Cowork board.`,
      canonicalDurableStatus,
      superseded: true,
    };
  }

  private async recordRejectedAgenticControl(
    task: TaskRecord,
    input: AgenticControlRequest,
    options: {
      controlId: string | undefined;
      mutationClaim?: AgenticControlMutationClaim;
      evidenceRef?: string;
      message: string;
      now: string;
      runtimeEffect: AgenticControlResponse["runtimeEffect"];
      signalPrefix: string;
      title: string;
    },
  ): Promise<AgenticControlResponse> {
    const diagnostic: AgenticDiagnosticSignal = {
      signalId: `${options.signalPrefix}-${input.action}-${options.controlId ?? randomUUID()}`,
      code: "unsafe_status_transition",
      severity: "warning",
      title: options.title,
      summary: options.message,
      evidenceRef: options.evidenceRef,
      createdAt: options.now,
    };
    const response: AgenticControlResponse = {
      action: input.action,
      taskId: task.taskId,
      taskRevision: task.revision,
      runId: task.agenticContext?.runId,
      status: "rejected",
      runtimeEffect: options.runtimeEffect,
      controlId: options.controlId,
      message: options.message,
    };
    try {
      const committed = await this.deps.storage.runImmediateTransaction(async () => {
        const current = await this.deps.storage.tasks.getForUpdate(task.taskId);
        const expectedRevision = input.expectedRevision ?? task.revision;
        assertTaskExpectedRevision(current, expectedRevision);
        const updatedTask = await this.deps.storage.tasks.updateWithRevision(
          task.taskId,
          {
            agenticContext: {
              ...(current.agenticContext ?? {}),
              diagnostics: [...(current.agenticContext?.diagnostics ?? []), diagnostic],
              failureClass: current.agenticContext?.failureClass ?? mapDiagnosticToFailureClass(diagnostic.code),
            },
          },
          expectedRevision,
        );
        const diagnosticActivity = await this.deps.storage.taskActivities.append(
          task.taskId,
          {
            activityType: "diagnostic",
            message: diagnostic.summary,
            metadata: diagnostic as unknown as Record<string, unknown>,
          },
          options.now,
        );
        const controlActivity = await this.deps.storage.taskActivities.append(
          task.taskId,
          {
            activityType: "control",
            message: `${input.action} control rejected: ${options.message}`,
            agentId: input.actorId,
            metadata: buildAgenticControlActivityMetadata(input, {
              controlId: options.controlId,
              diagnosticSignalId: diagnostic.signalId,
              responseMessage: options.message,
              recordedAt: options.now,
              resultStatus: "rejected",
              runtimeEffect: options.runtimeEffect,
            }),
          },
          options.now,
        );
        await this.completeAgenticControlMutation(options.mutationClaim, options.now);
        return { updatedTask, diagnosticActivity, controlActivity };
      });
      await this.publishDelegationActivity(committed.diagnosticActivity);
      await this.publishDelegationActivity(committed.controlActivity);
      await this.mirrorAgenticControlDiagnostic(committed.updatedTask, diagnostic);
      return { ...response, taskRevision: committed.updatedTask.revision };
    } catch (error) {
      await this.failAgenticControlMutation(options.mutationClaim, options.now);
      throw error;
    }
  }

  private async completeAgenticControlMutation(
    claim: AgenticControlMutationClaim | undefined,
    updatedAt: string,
  ): Promise<void> {
    if (!claim) {
      return;
    }
    const completed = await this.deps.storage.mutationIdempotency.markCompleted({
      ...claim.identity,
      claimToken: claim.claimToken,
      updatedAt,
    });
    if (!completed) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `Agentic control ${claim.identity.idempotencyKey} lost idempotency ownership before commit.`,
      });
    }
  }

  private async buildImplicitAgenticControlId(
    task: TaskRecord,
    runId: string,
    input: AgenticControlRequest,
  ): Promise<string> {
    const durableRunId = task.agenticContext?.durableRunId?.trim();
    if ((input.action === "pause" || input.action === "cancel") && durableRunId) {
      let generation: string = `task:${task.updatedAt}`;
      try {
        const durableRun = await this.deps.storage.durableRuns?.getRun(durableRunId);
        if (durableRun) {
          const alreadyAtTarget =
            (input.action === "pause" && durableRun.status === "paused") ||
            (input.action === "cancel" && durableRun.status === "cancelled");
          generation = `durable:${alreadyAtTarget ? Math.max(0, durableRun.version - 1) : durableRun.version}`;
        }
      } catch {
        // Fallback: a missing projection still gets a same-task-generation reservation;
        // runtime reconciliation will fail closed if the effect becomes ambiguous.
      }
      const digest = createHash("sha256")
        .update(
          canonicalJsonString({
            domain: "agentic-control-implicit-v1",
            runId: runId.trim(),
            taskId: task.taskId,
            durableRunId,
            generation,
            action: input.action,
            actorId: normalizeControlPayloadString(input.actorId),
            reason: normalizeControlPayloadString(input.reason),
            instruction: normalizeControlPayloadString(input.instruction),
            agentSessionId: normalizeControlPayloadString(input.agentSessionId),
            approvalId: normalizeControlPayloadString(input.approvalId),
          }),
        )
        .digest("hex")
        .slice(0, 32);
      return `implicit-agentic-control-${digest}`;
    }
    return `generated-agentic-control-${randomUUID()}`;
  }

  private async failAgenticControlMutation(
    claim: AgenticControlMutationClaim | undefined,
    updatedAt: string,
  ): Promise<void> {
    if (!claim) {
      return;
    }
    await this.deps.storage.mutationIdempotency.markFailed({
      ...claim.identity,
      claimToken: claim.claimToken,
      updatedAt,
    });
  }

  private async probeAgenticRuntimeControlOutcome(
    task: TaskRecord,
    input: AgenticControlRequest,
    controlId: string,
  ): Promise<boolean> {
    if (input.action !== "pause" && input.action !== "cancel") {
      return false;
    }
    const durableRunId = task.agenticContext?.durableRunId?.trim();
    if (!durableRunId) {
      return false;
    }
    const durableRuns = this.deps.storage.durableRuns;
    if (!durableRuns) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `Agentic control ${controlId} has an ambiguous stale runtime claim; durable status is unavailable.`,
      });
    }
    try {
      const durableRun = await durableRuns.getRun(durableRunId);
      return input.action === "pause" ? durableRun.status === "paused" : durableRun.status === "cancelled";
    } catch (error) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `Agentic control ${controlId} has an ambiguous stale runtime claim; durable status could not be verified: ${formatErrorMessage(error)}`,
      });
    }
  }

  private async mirrorAgenticControlDiagnostic(task: TaskRecord, diagnostic: AgenticDiagnosticSignal): Promise<void> {
    try {
      this.deps.recordAgenticDiagnosticSignal?.({ task, diagnostic });
    } catch (error) {
      try {
        await this.appendTaskActivity(task.taskId, {
          activityType: "diagnostic",
          message: "Agentic diagnostic was saved, but improvement-ledger mirroring failed.",
          metadata: {
            code: "agentic_diagnostic_mirror_failed",
            diagnosticSignalId: diagnostic.signalId,
            error: formatErrorMessage(error),
          },
        });
      } catch (activityError) {
        process.stderr.write(
          `[task-lifecycle] failed to record agentic diagnostic mirror failure: ${formatErrorMessage(activityError)}\n`,
        );
      }
    }
  }

  public async softDeleteTask(
    taskId: string,
    deletedBy?: string,
    deleteReason?: string,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<boolean> {
    const existing = await this.findTaskInWorkspace(taskId, options);
    if (!existing) {
      return false;
    }
    return await this.softDeleteTaskWithRevision(taskId, existing.revision, deletedBy, deleteReason, options);
  }

  public async softDeleteTaskWithRevision(
    taskId: string,
    expectedRevision: number,
    deletedBy?: string,
    deleteReason?: string,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<boolean> {
    const existing = await this.findTaskInWorkspace(taskId, options);
    if (!existing) {
      return false;
    }
    assertTaskExpectedRevision(existing, expectedRevision);
    const deleted = await this.deps.storage.tasks.softDeleteWithRevision(
      taskId,
      expectedRevision,
      deletedBy,
      deleteReason,
    );
    if (deleted) {
      await this.publishTaskEvent("task_deleted", { taskId, mode: "soft" }, buildTaskRealtimeLinks(existing, taskId));
    }
    return deleted;
  }

  public async restoreTask(taskId: string, options?: TaskWorkspaceAccessOptions): Promise<boolean> {
    const existing = await this.findTaskInWorkspace(taskId, options);
    if (!existing) {
      return false;
    }
    return await this.restoreTaskWithRevision(taskId, existing.revision, options);
  }

  public async restoreTaskWithRevision(
    taskId: string,
    expectedRevision: number,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<boolean> {
    const existing = await this.findTaskInWorkspace(taskId, options);
    if (!existing) {
      return false;
    }
    assertTaskExpectedRevision(existing, expectedRevision);
    const restored = await this.deps.storage.tasks.restoreWithRevision(taskId, expectedRevision);
    if (restored) {
      await this.publishTaskEvent(
        "task_restored",
        { taskId },
        buildTaskRealtimeLinks(await this.deps.storage.tasks.find(taskId), taskId),
      );
    }
    return restored;
  }

  public async hardDeleteTask(taskId: string, options?: TaskWorkspaceAccessOptions): Promise<boolean> {
    const existing = await this.findTaskInWorkspace(taskId, options);
    if (!existing) {
      return false;
    }
    return await this.hardDeleteTaskWithRevision(taskId, existing.revision, options);
  }

  public async hardDeleteTaskWithRevision(
    taskId: string,
    expectedRevision: number,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<boolean> {
    const existing = await this.findTaskInWorkspace(taskId, options);
    if (!existing) {
      return false;
    }
    assertTaskExpectedRevision(existing, expectedRevision);
    const deleted = await this.deps.storage.tasks.hardDeleteWithRevision(taskId, expectedRevision);
    if (deleted) {
      await this.publishTaskEvent("task_deleted", { taskId, mode: "hard" }, buildTaskRealtimeLinks(existing, taskId));
    }
    return deleted;
  }

  private async findRootTaskForRun(runId: string, options?: TaskWorkspaceAccessOptions): Promise<TaskRecord> {
    const normalizedRunId = sanitizeRequired(runId, "runId");
    const task = await this.findTaskByAgenticRunId(normalizedRunId, options);
    if (!task) {
      throw new ValidationError({ message: `Agentic run not found: ${normalizedRunId}` });
    }
    return task;
  }

  private async listTasksInAgenticRun(
    runId: string,
    options?: TaskWorkspaceAccessOptions,
    control?: { includeParentRunLinks?: boolean },
  ): Promise<TaskRecord[]> {
    const includeParentRunLinks = control?.includeParentRunLinks ?? true;
    return await this.scanActiveTasks(
      (task) =>
        isTaskInAgenticRun(task, runId, { includeParentRunLinks }) && this.isTaskAllowedForWorkspace(task, options),
    );
  }

  private async findTaskByAgenticRunId(
    runId: string,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskRecord | undefined> {
    return (
      await this.scanActiveTasks(
        (task) => task.agenticContext?.runId === runId && this.isTaskAllowedForWorkspace(task, options),
        { stopAfterFirst: true },
      )
    )[0];
  }

  private async scanActiveTasks(
    predicate: (task: TaskRecord) => boolean,
    options: { stopAfterFirst?: boolean } = {},
  ): Promise<TaskRecord[]> {
    const matched: TaskRecord[] = [];
    let cursor: string | undefined;
    const pageLimit = 500;
    while (true) {
      const tasks = await this.deps.storage.tasks.list({ limit: pageLimit, cursor, view: "active" });
      if (tasks.length === 0) {
        return matched;
      }
      for (const task of tasks) {
        if (!predicate(task)) {
          continue;
        }
        matched.push(task);
        if (options.stopAfterFirst) {
          return matched;
        }
      }
      cursor = buildTaskCursor(tasks[tasks.length - 1]!);
      if (tasks.length < pageLimit) {
        return matched;
      }
    }
  }

  public async listTaskActivities(
    taskId: string,
    limit = 200,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskActivityRecord[]> {
    await this.requireTaskInWorkspace(taskId, options);
    return await this.deps.storage.taskActivities.listByTask(taskId, limit);
  }

  public async appendTaskActivity(
    taskId: string,
    input: TaskActivityCreateInput,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskActivityRecord> {
    const task = await this.requireTaskInWorkspace(taskId, options);
    const activity = await this.deps.storage.taskActivities.append(taskId, input);
    await this.publishTaskEvent("activity_logged", { taskId, activity }, buildTaskRealtimeLinks(task));
    return activity;
  }

  public async listTaskDeliverables(
    taskId: string,
    limit = 200,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskDeliverableRecord[]> {
    await this.requireTaskInWorkspace(taskId, options);
    return await this.deps.storage.taskDeliverables.listByTask(taskId, limit);
  }

  public async appendTaskDeliverable(
    taskId: string,
    input: TaskDeliverableCreateInput,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskDeliverableRecord> {
    const task = await this.requireTaskInWorkspace(taskId, options);
    const deliverable = await this.deps.storage.taskDeliverables.append(taskId, input);
    await this.publishTaskEvent("deliverable_added", { taskId, deliverable }, buildTaskRealtimeLinks(task));
    return deliverable;
  }

  public async listTaskSubagents(
    taskId: string,
    limit = 200,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskSubagentSession[]> {
    await this.requireTaskInWorkspace(taskId, options);
    return await this.deps.storage.taskSubagents.listByTask(taskId, limit);
  }

  public async registerTaskSubagent(
    taskId: string,
    input: TaskSubagentCreateInput,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskSubagentSession> {
    const task = await this.requireTaskInWorkspace(taskId, options);
    const session = await this.deps.storage.taskSubagents.create(taskId, input);
    await this.publishTaskEvent("subagent_registered", { taskId, session }, buildTaskRealtimeLinks(task));
    return session;
  }

  public async updateTaskSubagent(
    agentSessionId: string,
    input: TaskSubagentUpdateInput,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskSubagentSession> {
    const current = await this.deps.storage.taskSubagents.findByAgentSessionId(agentSessionId);
    if (!current) {
      throw new NotFoundError({ entity: "Sub-agent session", id: agentSessionId });
    }
    await this.requireTaskInWorkspace(current.taskId, options);
    const updated = await this.deps.storage.taskSubagents.updateByAgentSessionId(agentSessionId, {
      ...input,
      endedAt: input.endedAt ?? (input.status && input.status !== "active" ? new Date().toISOString() : undefined),
    });

    await this.publishTaskEvent(
      "subagent_updated",
      { taskId: updated.taskId, session: updated },
      buildTaskRealtimeLinks(await this.deps.storage.tasks.find(updated.taskId), updated.taskId),
    );
    return updated;
  }

  private async requireTaskInWorkspace(taskId: string, options?: TaskWorkspaceAccessOptions): Promise<TaskRecord> {
    const task = await this.deps.storage.tasks.get(taskId);
    if (!this.isTaskAllowedForWorkspace(task, options)) {
      throw new NotFoundError({ entity: "Task", id: taskId });
    }
    return task;
  }

  private async findTaskInWorkspace(
    taskId: string,
    options?: TaskWorkspaceAccessOptions,
  ): Promise<TaskRecord | undefined> {
    const task = await this.deps.storage.tasks.find(taskId);
    if (!task || !this.isTaskAllowedForWorkspace(task, options)) {
      return undefined;
    }
    return task;
  }

  private isTaskAllowedForWorkspace(task: TaskRecord, options?: TaskWorkspaceAccessOptions): boolean {
    if (!options) {
      return true;
    }
    return (task.workspaceId ?? DEFAULT_WORKSPACE_ID) === this.normalizeWorkspaceId(options.workspaceId);
  }

  private normalizeWorkspaceAccessOptions(options?: TaskWorkspaceAccessOptions): TaskWorkspaceAccessOptions {
    return { workspaceId: this.normalizeWorkspaceId(options?.workspaceId) };
  }

  private normalizeWorkspaceId(workspaceId?: string): string {
    if (!workspaceId?.trim()) {
      return DEFAULT_WORKSPACE_ID;
    }
    const normalized = workspaceId.trim();
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(normalized)) {
      throw new ValidationError({ field: "workspaceId", message: "workspaceId contains unsupported characters" });
    }
    return normalized;
  }

  private async publishTaskEvent(
    eventType: string,
    payload: Record<string, unknown>,
    links: RealtimeEvent["links"],
  ): Promise<void> {
    await this.deps.publishRealtime(eventType, "tasks", payload, {
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
    ...(task?.agenticContext?.runId ? { runId: task.agenticContext.runId } : {}),
    ...(task?.proactiveContext?.durableRunId || task?.agenticContext?.durableRunId
      ? { durableRunId: task.proactiveContext?.durableRunId ?? task.agenticContext?.durableRunId }
      : {}),
    ...(task?.proactiveContext?.proactiveRunId ? { proactiveRunId: task.proactiveContext.proactiveRunId } : {}),
    ...(task?.proactiveContext?.approvalId ? { approvalId: task.proactiveContext.approvalId } : {}),
  };
}

function validateBulkTaskRevisionSet(input: BulkTaskAction): void {
  if (input.taskIds.length === 0) {
    throw new ValidationError({ field: "taskIds", message: "At least one taskId is required." });
  }
  const taskIds = new Set(input.taskIds);
  if (taskIds.size !== input.taskIds.length) {
    throw new ValidationError({ field: "taskIds", message: "Bulk taskIds must be unique." });
  }
  const revisionTaskIds = Object.keys(input.expectedRevisionsByTaskId);
  for (const taskId of taskIds) {
    if (!Object.prototype.hasOwnProperty.call(input.expectedRevisionsByTaskId, taskId)) {
      throw new ValidationError({
        field: `expectedRevisionsByTaskId.${taskId}`,
        message: `A positive expected revision is required for task ${taskId}.`,
      });
    }
    validateExpectedRevision(input.expectedRevisionsByTaskId[taskId]!, `expectedRevisionsByTaskId.${taskId}`);
  }
  const extraTaskId = revisionTaskIds.find((taskId) => !taskIds.has(taskId));
  if (extraTaskId) {
    throw new ValidationError({
      field: `expectedRevisionsByTaskId.${extraTaskId}`,
      message: `Revision supplied for task ${extraTaskId}, which is not part of this bulk action.`,
    });
  }
}

function buildBulkTaskUpdate(current: TaskRecord, input: BulkTaskAction): TaskUpdateInput {
  if (input.action === "unblock") {
    return {
      status: "assigned",
      retryBudget: current.retryBudget ? { ...current.retryBudget, retryCount: 0, exhaustedAt: undefined } : undefined,
    };
  }
  if (input.action === "retry") {
    const budget = current.retryBudget ?? { maxRetries: 0, retryCount: 0 };
    const retryCount = budget.retryCount + 1;
    const now = new Date().toISOString();
    const exhausted = retryCount > budget.maxRetries;
    const retryBudget: TaskRetryBudget = {
      ...budget,
      retryCount,
      lastAttemptAt: now,
      exhaustedAt: exhausted ? now : budget.exhaustedAt,
    };
    if (!exhausted) {
      return { retryBudget };
    }
    return {
      retryBudget,
      distressSignals: emitDistressSignal(current.distressSignals, {
        code: "retry_budget_exhausted",
        severity: "critical",
        title: "Retry budget exhausted",
        summary: input.reason,
      }),
      status: "blocked",
    };
  }
  if (input.action === "reassign") {
    return { assignedAgentId: input.assignedAgentId };
  }
  return { status: "done" };
}

function retryTaskEventType(task: TaskRecord): "task_retry_attempted" | "task_retry_budget_exhausted" {
  return task.retryBudget?.exhaustedAt ? "task_retry_budget_exhausted" : "task_retry_attempted";
}

function assertTaskExpectedRevision(task: TaskRecord, expectedRevision: number): void {
  validateExpectedRevision(expectedRevision);
  if (task.revision === expectedRevision) {
    return;
  }
  throw new ConflictError({
    code: "WRITE_CONFLICT",
    message: `Task ${task.taskId} changed since revision ${expectedRevision}.`,
    details: {
      resourceKind: "task",
      resourceId: task.taskId,
      expectedRevision,
      currentRevision: task.revision,
    },
  });
}

function validateExpectedRevision(expectedRevision: number, field = "expectedRevision"): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field,
      message: `${field} must be a positive integer.`,
    });
  }
}

function isTaskInAgenticRun(task: TaskRecord, runId: string, control?: { includeParentRunLinks?: boolean }): boolean {
  const includeParentRunLinks = control?.includeParentRunLinks ?? true;
  return (
    task.agenticContext?.runId === runId ||
    task.agenticContext?.parentRunId === runId ||
    (includeParentRunLinks && Boolean(task.agenticContext?.childRunIds?.includes(runId)))
  );
}

function isAgenticRunListMatch(
  task: TaskRecord,
  input: {
    status?: AgenticTaskContext["status"];
    surface?: AgenticSurface;
    sessionId?: string;
    boardId?: string;
    parentRunId?: string;
  },
): boolean {
  const context = task.agenticContext;
  return (
    Boolean(context?.runId) &&
    (!input.status || context?.status === input.status) &&
    (!input.surface || context?.surface === input.surface) &&
    (!input.sessionId || context?.parentSessionId === input.sessionId || context?.childSessionId === input.sessionId) &&
    (!input.boardId || context?.boardId === input.boardId) &&
    (!input.parentRunId || context?.parentRunId === input.parentRunId)
  );
}

function mapAgenticRunListItem(task: TaskRecord): AgenticRunListItem {
  const context = task.agenticContext;
  return {
    taskId: task.taskId,
    taskRevision: task.revision,
    runId: context?.runId ?? task.taskId,
    boardId: context?.boardId,
    title: task.title,
    summary: task.description,
    taskStatus: task.status,
    status: context?.status,
    surface: context?.surface,
    parentSessionId: context?.parentSessionId,
    parentRunId: context?.parentRunId,
    contextMode: context?.contextMode,
    profileId: context?.profileId,
    updatedAt: task.updatedAt,
    diagnostics: context?.diagnostics,
  };
}

function compareAgenticRunListItems(left: AgenticRunListItem, right: AgenticRunListItem): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  const normalizedLeftTime = Number.isFinite(leftTime) ? leftTime : 0;
  const normalizedRightTime = Number.isFinite(rightTime) ? rightTime : 0;
  if (normalizedLeftTime !== normalizedRightTime) {
    return normalizedRightTime - normalizedLeftTime;
  }
  return right.runId.localeCompare(left.runId);
}

function buildTaskCursor(task: TaskRecord): string {
  return `${task.updatedAt}|${task.taskId}`;
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? NaN)) {
    return fallback;
  }
  return Math.max(1, Math.min(500, Math.floor(value!)));
}

function sanitizeRequired(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return trimmed;
}

function mergeAgenticContext(
  current: AgenticTaskContext | undefined,
  patch: Partial<AgenticTaskContext>,
): AgenticTaskContext {
  return {
    ...(current ?? {}),
    ...patch,
    diagnostics: patch.diagnostics ?? current?.diagnostics,
    handoffEvidence: patch.handoffEvidence ?? current?.handoffEvidence,
    childRunIds: patch.childRunIds ?? current?.childRunIds,
    filesTouched: patch.filesTouched ?? current?.filesTouched,
  };
}

function buildAgenticControls(task: TaskRecord): AgenticRunTreeResponse["controls"] {
  const status = task.agenticContext?.status ?? task.status;
  const hasDurableExecutor = Boolean(task.agenticContext?.durableRunId);
  return [
    {
      action: "pause",
      label: hasDurableExecutor ? "Pause durable run" : "Pause unavailable",
      enabled: hasDurableExecutor && (status === "running" || status === "in_progress"),
      runtimeEffect: hasDurableExecutor ? "runtime_pause" : "state_only",
      reason: hasDurableExecutor
        ? "Calls the attached durable run pause path and mirrors the result into Cowork state."
        : "No executor is attached; a direct request records intent only and does not pause execution.",
    },
    {
      action: "cancel",
      label: hasDurableExecutor ? "Cancel durable run" : "Cancel unavailable",
      enabled:
        hasDurableExecutor &&
        status !== "completed" &&
        status !== "done" &&
        status !== "failed" &&
        status !== "cancelled" &&
        status !== "stopped_by_limit",
      runtimeEffect: hasDurableExecutor ? "runtime_cancel" : "state_only",
      reason: hasDurableExecutor
        ? "Calls the attached durable run cancel path and mirrors the result into Cowork state."
        : "No executor is attached; a direct request records intent only and does not cancel execution.",
    },
    {
      action: "retry",
      label: "Retry unavailable",
      enabled: false,
      runtimeEffect: "state_only",
      reason: "No retry executor is attached; a direct request records intent without restarting execution.",
    },
    {
      action: "steer",
      label: "Steer run",
      enabled: status === "running" || status === "in_progress" || status === "paused",
      runtimeEffect: "state_only",
      reason: "Records steering guidance for the next attached worker turn.",
    },
    {
      action: "kill_child",
      label: "Kill child agent",
      enabled: false,
      runtimeEffect: "state_only",
      reason: "Requires an agentSessionId.",
    },
  ];
}

function deriveAgenticDiagnostics(input: {
  rootTask: TaskRecord;
  tasks: TaskRecord[];
  diagnostics: AgenticDiagnosticSignal[];
  nodes: AgenticRunTreeNode[];
}): AgenticDiagnosticSignal[] {
  const now = new Date().toISOString();
  const derived: AgenticDiagnosticSignal[] = [];
  const hasDeliverable = input.nodes.some((node) => node.kind === "artifact");
  const rootStatus = input.rootTask.agenticContext?.status ?? input.rootTask.status;

  if ((rootStatus === "completed" || rootStatus === "done") && !hasDeliverable) {
    derived.push({
      signalId: `derived-missing-artifact-${input.rootTask.taskId}`,
      code: "missing_claimed_artifact",
      severity: "warning",
      title: "Completed run has no attached artifact",
      summary: "The run is complete, but no durable artifact or deliverable is attached to the board.",
      createdAt: now,
    });
  }

  for (const task of input.tasks) {
    const heartbeatAt = task.agenticContext?.heartbeatAt;
    const timeoutAt = task.agenticContext?.timeoutAt;
    if (timeoutAt && Date.parse(timeoutAt) < Date.now() && task.status === "in_progress") {
      derived.push({
        signalId: `derived-child-timeout-${task.taskId}`,
        code: "child_timeout",
        severity: "critical",
        title: "Task exceeded timeout",
        summary: `Task ${task.title} is still in progress after its timeout.`,
        evidenceRef: heartbeatAt,
        createdAt: now,
      });
    }
  }

  for (const node of input.nodes) {
    if (node.kind !== "subagent") {
      continue;
    }
    const timeoutAt = typeof node.metadata?.timeoutAt === "string" ? node.metadata.timeoutAt : undefined;
    const heartbeatAt = typeof node.metadata?.heartbeatAt === "string" ? node.metadata.heartbeatAt : undefined;
    if (timeoutAt && Date.parse(timeoutAt) < Date.now() && (node.status === "active" || node.status === "paused")) {
      derived.push({
        signalId: `derived-subagent-timeout-${node.agentSessionId ?? node.id}`,
        code: "child_timeout",
        severity: "critical",
        title: "Child agent exceeded timeout",
        summary: `Child agent ${node.label} is still ${node.status} after its timeout.`,
        evidenceRef: heartbeatAt ?? timeoutAt,
        createdAt: now,
      });
    }
    if (heartbeatAt && Date.now() - Date.parse(heartbeatAt) > 30 * 60 * 1000 && node.status === "active") {
      derived.push({
        signalId: `derived-stale-worker-${node.agentSessionId ?? node.id}`,
        code: "stale_worker",
        severity: "warning",
        title: "Child agent heartbeat is stale",
        summary: `Child agent ${node.label} has not reported a heartbeat in over 30 minutes.`,
        evidenceRef: heartbeatAt,
        createdAt: now,
      });
    }
  }

  return derived.filter(
    (candidate) =>
      !input.diagnostics.some(
        (existing) => existing.code === candidate.code && existing.signalId === candidate.signalId,
      ),
  );
}

async function findControlActivityForReplay(
  taskActivities: TaskStorage["taskActivities"],
  taskId: string,
  controlId: string,
): Promise<TaskActivityRecord | undefined> {
  const repository = taskActivities as TaskStorage["taskActivities"] & {
    findControlByTaskAndControlId?: (taskId: string, controlId: string) => TaskActivityRecord | undefined;
  };
  return repository.findControlByTaskAndControlId
    ? await repository.findControlByTaskAndControlId(taskId, controlId)
    : findControlActivityById(await repository.listByTask(taskId, Number.MAX_SAFE_INTEGER), controlId);
}

function findControlActivityById(activities: TaskActivityRecord[], controlId: string): TaskActivityRecord | undefined {
  return activities.find(
    (activity) => activity.activityType === "control" && activity.metadata?.controlId === controlId,
  );
}

function findAgenticControlReplayMismatch(
  input: AgenticControlRequest,
  existing: TaskActivityRecord,
): "action" | "actorId" | "agentSessionId" | "approvalId" | "reason" | "instruction" | undefined {
  const existingAction = readActivityMetadataString(existing, "action");
  if (existingAction && existingAction !== input.action) {
    return "action";
  }
  for (const field of ["actorId", "agentSessionId", "approvalId", "reason", "instruction"] as const) {
    const existingValue = normalizeControlPayloadString(
      readActivityMetadataString(existing, field) ?? (field === "actorId" ? existing.agentId : undefined),
    );
    const inputValue = normalizeControlPayloadString(input[field]);
    if (existingValue !== inputValue) {
      return field;
    }
  }
  return undefined;
}

function buildValidatedIdempotentControlReplay(
  task: TaskRecord,
  input: AgenticControlRequest,
  existing: TaskActivityRecord,
): AgenticControlResponse {
  const mismatch = findAgenticControlReplayMismatch(input, existing);
  if (mismatch === "action") {
    throw new ValidationError({
      field: "controlId",
      message: "controlId has already been used for a different agentic control action.",
    });
  }
  if (mismatch) {
    throw new ValidationError({
      field: "controlId",
      message: "controlId has already been used for a different agentic control payload.",
    });
  }
  return buildIdempotentControlReplay(task, input, existing);
}

function readActivityMetadataString(activity: TaskActivityRecord, field: string): string | undefined {
  const value = activity.metadata?.[field];
  return typeof value === "string" ? value : undefined;
}

function normalizeControlPayloadString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function buildIdempotentControlReplay(
  task: TaskRecord,
  input: AgenticControlRequest,
  existing: TaskActivityRecord,
): AgenticControlResponse {
  const runtimeEffect = isAgenticRuntimeEffect(existing.metadata?.runtimeEffect)
    ? existing.metadata.runtimeEffect
    : "state_only";
  const status = isAgenticControlStatus(existing.metadata?.resultStatus) ? existing.metadata.resultStatus : "recorded";
  return {
    action: input.action,
    taskId: task.taskId,
    taskRevision: task.revision,
    runId: task.agenticContext?.runId,
    status,
    runtimeEffect,
    controlId: input.controlId?.trim() || undefined,
    idempotentReplay: true,
    message:
      readActivityMetadataString(existing, "responseMessage") ??
      "Control was already recorded; the duplicate request was treated as an idempotent replay.",
  };
}

function hashAgenticControlPayload(runId: string, taskId: string, input: AgenticControlRequest): string {
  return createHash("sha256")
    .update(
      canonicalJsonString({
        runId: runId.trim(),
        taskId,
        action: input.action,
        actorId: normalizeControlPayloadString(input.actorId),
        agentSessionId: normalizeControlPayloadString(input.agentSessionId),
        approvalId: normalizeControlPayloadString(input.approvalId),
        reason: normalizeControlPayloadString(input.reason),
        instruction: normalizeControlPayloadString(input.instruction),
      }),
    )
    .digest("hex");
}

function isAgenticControlStatus(value: unknown): value is AgenticControlResponse["status"] {
  return value === "recorded" || value === "applied" || value === "rejected";
}

function isAgenticRuntimeEffect(value: unknown): value is AgenticControlResponse["runtimeEffect"] {
  return (
    value === "state_only" ||
    value === "runtime_pause" ||
    value === "runtime_cancel" ||
    value === "approval_resolution" ||
    value === "navigation"
  );
}

function mapDurableStatusToTaskProjection(
  status: DurableRunStatus,
): Pick<AgenticControlCommitOutcome, "nextStatus" | "nextAgenticStatus"> {
  switch (status) {
    case "queued":
      return { nextStatus: "planning", nextAgenticStatus: "queued" };
    case "running":
      return { nextStatus: "in_progress", nextAgenticStatus: "running" };
    case "waiting":
      return { nextStatus: "blocked", nextAgenticStatus: "blocked" };
    case "paused":
      return { nextAgenticStatus: "paused" };
    case "completed":
      return { nextStatus: "done", nextAgenticStatus: "completed" };
    case "failed":
    case "dead_lettered":
      return { nextStatus: "blocked", nextAgenticStatus: "failed" };
    case "cancelled":
      return { nextStatus: "blocked", nextAgenticStatus: "cancelled" };
  }
}

function describeDurableSupersession(status: DurableRunStatus): string {
  switch (status) {
    case "cancelled":
      return "cancellation";
    case "completed":
      return "completion";
    case "failed":
      return "failure";
    case "dead_lettered":
      return "dead-lettering";
    case "paused":
      return "a pause transition";
    case "running":
      return "a running-state transition";
    case "queued":
      return "a queued-state transition";
    case "waiting":
      return "a wait transition";
  }
}

function validateAgenticControlTransition(
  currentStatus: TaskStatus | AgenticTaskContext["status"] | undefined,
  input: AgenticControlRequest,
): string | undefined {
  if (input.action === "pause" && currentStatus !== "running" && currentStatus !== "in_progress") {
    return `Cannot pause a run while it is ${currentStatus ?? "unknown"}.`;
  }
  if (
    input.action === "cancel" &&
    (currentStatus === "completed" ||
      currentStatus === "done" ||
      currentStatus === "failed" ||
      currentStatus === "cancelled" ||
      currentStatus === "stopped_by_limit")
  ) {
    return `Cannot cancel a run while it is already ${currentStatus}.`;
  }
  if (
    input.action === "retry" &&
    currentStatus !== "failed" &&
    currentStatus !== "blocked" &&
    currentStatus !== "cancelled"
  ) {
    return `Cannot retry a run while it is ${currentStatus ?? "unknown"}.`;
  }
  if (input.action === "steer" && !input.instruction?.trim()) {
    return "Steering a run requires an instruction for the next worker turn.";
  }
  return undefined;
}

function mapDiagnosticToFailureClass(code: AgenticDiagnosticSignal["code"]): AgenticTaskContext["failureClass"] {
  switch (code) {
    case "child_timeout":
    case "timeout_exceeded":
      return "timeout";
    case "max_depth_exceeded":
      return "spawn_failure";
    case "spawn_failure":
      return "spawn_failure";
    case "worker_crash":
      return "crash";
    case "stale_worker":
      return "stale_worker";
    case "invalid_assignee_profile":
      return "invalid_assignee";
    case "unsafe_status_transition":
      return "unsafe_transition";
    case "missing_claimed_artifact":
    case "missing_claimed_file":
    case "missing_claimed_test":
      return "missing_artifact";
    case "repeated_tool_result":
    case "post_compaction_loop":
      return "repeated_tool_loop";
    case "stale_approval":
      return "approval_stale";
    case "final_delivery_retry":
      return "delivery_failed";
    case "provider_fallback_loop":
      return "provider_fallback_loop";
    default:
      return "other";
  }
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null));
}

function buildAgenticControlActivityMetadata(
  input: AgenticControlRequest,
  extra: {
    controlId: string | undefined;
    canonicalDurableStatus?: DurableRunStatus;
    diagnosticSignalId?: string;
    responseMessage: string;
    recordedAt: string;
    resultStatus: AgenticControlResponse["status"];
    runtimeEffect: AgenticControlResponse["runtimeEffect"];
    superseded?: boolean;
  },
): Record<string, unknown> {
  return compactRecord({
    action: input.action,
    controlId: extra.controlId,
    actorId: input.actorId?.trim() || undefined,
    agentSessionId: input.agentSessionId,
    approvalId: input.approvalId,
    reason: input.reason?.trim() || undefined,
    instruction: input.instruction?.trim() || undefined,
    resultStatus: extra.resultStatus,
    runtimeEffect: extra.runtimeEffect,
    canonicalDurableStatus: extra.canonicalDurableStatus,
    superseded: extra.superseded,
    diagnosticSignalId: extra.diagnosticSignalId,
    responseMessage: extra.responseMessage,
    recordedAt: extra.recordedAt,
  });
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
