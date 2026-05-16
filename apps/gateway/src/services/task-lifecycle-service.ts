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
  RealtimeEvent,
  TaskActivityCreateInput,
  TaskActivityRecord,
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
import { ValidationError } from "@goatcitadel/contracts";
import { emitDistressSignal, resolveDistressSignal, type EmitDistressInput } from "./task-distress-engine.js";
import type { Storage } from "@goatcitadel/storage";
import { randomUUID } from "node:crypto";

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
  pauseDurableRun?(runId: string, actorId?: string): { status: string };
  recordAgenticDiagnosticSignal?(input: { task: TaskRecord; diagnostic: AgenticDiagnosticSignal }): void;
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

  public emitDistressSignal(taskId: string, input: EmitDistressInput): TaskRecord {
    const current = this.deps.storage.tasks.get(taskId);
    const next = emitDistressSignal(current.distressSignals, input);
    const updated = this.deps.storage.tasks.update(taskId, { distressSignals: next });
    const newSignal = next.find((s) => !current.distressSignals?.some((existing) => existing.signalId === s.signalId));
    this.publishTaskEvent(
      "task_distress_emitted",
      { taskId, signal: newSignal ?? next[0] },
      buildTaskRealtimeLinks(updated),
    );
    return updated;
  }

  public resolveDistressSignal(taskId: string, signalId: string, input: { resolvedBy?: string } = {}): TaskRecord {
    const current = this.deps.storage.tasks.get(taskId);
    const next = resolveDistressSignal(current.distressSignals, signalId, input);
    const matched = current.distressSignals?.some((s) => s.signalId === signalId && !s.resolvedAt);
    if (!matched) {
      throw new ValidationError({
        message: `No unresolved distress signal with signalId="${signalId}" on task ${taskId}`,
      });
    }
    const updated = this.deps.storage.tasks.update(taskId, { distressSignals: next });
    this.publishTaskEvent(
      "task_distress_resolved",
      { taskId, signalId, resolvedBy: input.resolvedBy },
      buildTaskRealtimeLinks(updated),
    );
    return updated;
  }

  public setRetryBudget(taskId: string, maxRetries: number): TaskRecord {
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new ValidationError({ message: "maxRetries must be a non-negative integer" });
    }
    const current = this.deps.storage.tasks.get(taskId);
    const retryBudget: TaskRetryBudget = {
      maxRetries,
      retryCount: current.retryBudget?.retryCount ?? 0,
    };
    return this.deps.storage.tasks.update(taskId, { retryBudget });
  }

  public recordRetryAttempt(taskId: string, reason: string): TaskRecord {
    const current = this.deps.storage.tasks.get(taskId);
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
      const updated = this.deps.storage.tasks.update(taskId, { retryBudget });
      this.publishTaskEvent(
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
    return this.deps.storage.tasks.update(taskId, {
      retryBudget,
      distressSignals,
      status: "blocked",
    });
  }

  public listAgenticRuns(
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
  ): { items: AgenticRunListItem[]; nextCursor?: string } {
    const limit = clampLimit(input.limit, 200);
    const matched: TaskRecord[] = [];
    let cursor = input.cursor;
    let exhausted = false;
    const pageLimit = Math.max(limit + 1, Math.min(500, limit * 2));
    while (matched.length <= limit && !exhausted) {
      const tasks = this.deps.storage.tasks.list({
        workspaceId: input.workspaceId ? this.normalizeWorkspaceId(input.workspaceId) : undefined,
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
    return {
      items: page.map(mapAgenticRunListItem),
      ...(matched.length > limit && page.length > 0 ? { nextCursor: buildTaskCursor(page[page.length - 1]!) } : {}),
    };
  }

  public getAgenticRunTree(runId: string): AgenticRunTreeResponse {
    const normalizedRunId = sanitizeRequired(runId, "runId");
    const tasks = this.listTasksInAgenticRun(normalizedRunId);
    if (tasks.length === 0) {
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

      for (const subagent of this.deps.storage.taskSubagents.listByTask(task.taskId, 200)) {
        const subagentNodeId = `subagent:${subagent.agentSessionId}`;
        nodes.push({
          id: subagentNodeId,
          kind: "subagent",
          label: subagent.agentName ?? subagent.agentSessionId,
          status: subagent.status,
          parentId: taskNodeId,
          taskId: task.taskId,
          agentSessionId: subagent.agentSessionId,
          metadata: compactRecord({
            profileId: subagent.metadata?.profileId,
            contextMode: subagent.metadata?.contextMode,
            heartbeatAt: subagent.metadata?.heartbeatAt,
            timeoutAt: subagent.metadata?.timeoutAt,
            failureClass: subagent.metadata?.failureClass,
            filesTouched: subagent.metadata?.filesTouched,
            tokenTotal: subagent.metadata?.tokenTotal,
            costUsd: subagent.metadata?.costUsd,
          }),
        });
        edges.push({ from: taskNodeId, to: subagentNodeId, kind: "spawned" });
        diagnostics.push(...(subagent.metadata?.diagnostics ?? []));
      }

      for (const deliverable of this.deps.storage.taskDeliverables.listByTask(task.taskId, 200)) {
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
      boardId: rootTask.agenticContext?.boardId,
      generatedAt: new Date().toISOString(),
      nodes,
      edges,
      diagnostics,
      controls: buildAgenticControls(rootTask),
    };
  }

  public updateTaskAgenticContext(taskId: string, patch: Partial<AgenticTaskContext>): TaskRecord {
    const current = this.deps.storage.tasks.get(taskId);
    const updated = this.deps.storage.tasks.update(taskId, {
      agenticContext: mergeAgenticContext(current.agenticContext, patch),
    });
    this.publishTaskEvent(
      "agentic_context_updated",
      { taskId, agenticContext: updated.agenticContext },
      buildTaskRealtimeLinks(updated),
    );
    return updated;
  }

  public recordTaskHeartbeat(taskId: string, input: { summary?: string; agentSessionId?: string }): TaskRecord {
    const now = new Date().toISOString();
    const task = this.updateTaskAgenticContext(taskId, { heartbeatAt: now });
    if (input.agentSessionId) {
      const subagent = this.deps.storage.taskSubagents.findByAgentSessionId(input.agentSessionId);
      if (subagent) {
        this.deps.storage.taskSubagents.updateByAgentSessionId(input.agentSessionId, {
          metadata: { ...(subagent.metadata ?? {}), heartbeatAt: now },
        });
      }
    }
    this.appendTaskActivity(taskId, {
      activityType: "heartbeat",
      message: input.summary ?? "Agentic task heartbeat recorded.",
      metadata: compactRecord({ heartbeatAt: now, agentSessionId: input.agentSessionId }),
    });
    return task;
  }

  public appendTaskDiagnostic(
    taskId: string,
    input: Omit<AgenticDiagnosticSignal, "signalId" | "createdAt"> & {
      signalId?: string;
      createdAt?: string;
    },
  ): AgenticDiagnosticSignal {
    const task = this.deps.storage.tasks.get(taskId);
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
    this.deps.storage.tasks.update(taskId, {
      agenticContext: {
        ...(task.agenticContext ?? {}),
        diagnostics: [...(task.agenticContext?.diagnostics ?? []), diagnostic],
        failureClass: task.agenticContext?.failureClass ?? mapDiagnosticToFailureClass(diagnostic.code),
      },
    });
    this.appendTaskActivity(taskId, {
      activityType: "diagnostic",
      message: diagnostic.summary,
      metadata: diagnostic as unknown as Record<string, unknown>,
    });
    try {
      this.deps.recordAgenticDiagnosticSignal?.({ task, diagnostic });
    } catch (error) {
      try {
        this.appendTaskActivity(taskId, {
          activityType: "diagnostic",
          message: "Agentic diagnostic was saved, but improvement-ledger mirroring failed.",
          metadata: {
            code: "agentic_diagnostic_mirror_failed",
            diagnosticSignalId: diagnostic.signalId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
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

  public invokeAgenticControl(runId: string, input: AgenticControlRequest): AgenticControlResponse {
    const task = this.findRootTaskForRun(runId);
    const now = new Date().toISOString();
    const controlId = input.controlId?.trim();
    if (controlId) {
      const existing = findControlActivityById(
        this.deps.storage.taskActivities.listByTask(task.taskId, 200),
        controlId,
      );
      if (existing) {
        const existingAction = typeof existing.metadata?.action === "string" ? existing.metadata.action : undefined;
        if (existingAction && existingAction !== input.action) {
          throw new ValidationError({
            field: "controlId",
            message: "controlId has already been used for a different agentic control action.",
          });
        }
        return buildIdempotentControlReplay(task, input, existing);
      }
    }

    const reason = input.reason?.trim() || input.instruction?.trim() || "Operator control recorded.";
    let nextStatus: TaskStatus | undefined;
    let nextAgenticStatus: AgenticTaskContext["status"] | undefined;
    let runtimeEffect: AgenticControlResponse["runtimeEffect"] = "state_only";
    let responseStatus: AgenticControlResponse["status"] = "recorded";
    const currentStatus = task.agenticContext?.status ?? task.status;
    const rejectionReason = validateAgenticControlTransition(currentStatus, input);

    if (rejectionReason) {
      const diagnostic = this.appendTaskDiagnostic(task.taskId, {
        signalId: `unsafe-control-${input.action}-${controlId ?? randomUUID()}`,
        code: "unsafe_status_transition",
        severity: "warning",
        title: "Unsafe run control rejected",
        summary: rejectionReason,
        createdAt: now,
      });
      this.appendTaskActivity(task.taskId, {
        activityType: "control",
        message: `${input.action} control rejected: ${rejectionReason}`,
        agentId: input.actorId,
        metadata: compactRecord({
          action: input.action,
          controlId,
          resultStatus: "rejected",
          runtimeEffect,
          diagnosticSignalId: diagnostic.signalId,
          recordedAt: now,
        }),
      });
      return {
        action: input.action,
        taskId: task.taskId,
        runId: task.agenticContext?.runId,
        status: "rejected",
        runtimeEffect,
        controlId,
        message: rejectionReason,
      };
    }

    if (input.action === "pause") {
      const durableRunId = task.agenticContext?.durableRunId?.trim();
      if (durableRunId && this.deps.pauseDurableRun) {
        this.deps.pauseDurableRun(durableRunId, input.actorId ?? "operator");
        runtimeEffect = "runtime_pause";
        responseStatus = "applied";
      }
      nextAgenticStatus = "paused";
    } else if (input.action === "cancel") {
      nextStatus = "blocked";
      nextAgenticStatus = "cancelled";
    } else if (input.action === "retry") {
      nextStatus = "in_progress";
      nextAgenticStatus = "running";
    } else if (input.action === "kill_child") {
      if (!input.agentSessionId) {
        throw new ValidationError({ field: "agentSessionId", message: "agentSessionId is required for kill_child." });
      }
      this.deps.storage.taskSubagents.updateByAgentSessionId(input.agentSessionId, {
        status: "killed",
        endedAt: now,
      });
    } else if (input.action === "open_child") {
      runtimeEffect = "navigation";
    } else if (input.action === "approve" || input.action === "reject") {
      runtimeEffect = "approval_resolution";
    }

    if (nextStatus || nextAgenticStatus) {
      this.deps.storage.tasks.update(task.taskId, {
        ...(nextStatus ? { status: nextStatus } : {}),
        agenticContext: mergeAgenticContext(task.agenticContext, {
          ...(nextAgenticStatus ? { status: nextAgenticStatus } : {}),
        }),
      });
    }

    this.appendTaskActivity(task.taskId, {
      activityType: "control",
      message: `${input.action} control recorded: ${reason}`,
      agentId: input.actorId,
      metadata: compactRecord({
        action: input.action,
        controlId,
        agentSessionId: input.agentSessionId,
        approvalId: input.approvalId,
        resultStatus: responseStatus,
        runtimeEffect,
        recordedAt: now,
      }),
    });

    return {
      action: input.action,
      taskId: task.taskId,
      runId: task.agenticContext?.runId,
      status: responseStatus,
      runtimeEffect,
      controlId,
      message:
        runtimeEffect === "state_only"
          ? "Control was recorded in the durable board. Live runtime effects are only applied where an executor is attached."
          : runtimeEffect === "runtime_pause"
            ? "Durable run pause was applied and mirrored into the Cowork board."
            : "Control was recorded with an operator-visible runtime effect.",
    };
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

  private findRootTaskForRun(runId: string): TaskRecord {
    const normalizedRunId = sanitizeRequired(runId, "runId");
    const task = this.findTaskByAgenticRunId(normalizedRunId);
    if (!task) {
      throw new ValidationError({ message: `Agentic run not found: ${normalizedRunId}` });
    }
    return task;
  }

  private listTasksInAgenticRun(runId: string): TaskRecord[] {
    return this.scanActiveTasks((task) => isTaskInAgenticRun(task, runId));
  }

  private findTaskByAgenticRunId(runId: string): TaskRecord | undefined {
    return this.scanActiveTasks((task) => task.agenticContext?.runId === runId, { stopAfterFirst: true })[0];
  }

  private scanActiveTasks(
    predicate: (task: TaskRecord) => boolean,
    options: { stopAfterFirst?: boolean } = {},
  ): TaskRecord[] {
    const matched: TaskRecord[] = [];
    let cursor: string | undefined;
    const pageLimit = 500;
    while (true) {
      const tasks = this.deps.storage.tasks.list({ limit: pageLimit, cursor, view: "active" });
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
    ...(task?.proactiveContext?.durableRunId || task?.agenticContext?.runId
      ? { runId: task.proactiveContext?.durableRunId ?? task.agenticContext?.runId }
      : {}),
    ...(task?.proactiveContext?.proactiveRunId ? { proactiveRunId: task.proactiveContext.proactiveRunId } : {}),
    ...(task?.proactiveContext?.approvalId ? { approvalId: task.proactiveContext.approvalId } : {}),
  };
}

function isTaskInAgenticRun(task: TaskRecord, runId: string): boolean {
  return (
    task.agenticContext?.runId === runId ||
    task.agenticContext?.parentRunId === runId ||
    Boolean(task.agenticContext?.childRunIds?.includes(runId))
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
  return [
    {
      action: "pause",
      label: task.agenticContext?.durableRunId ? "Pause durable run" : "Record pause intent",
      enabled: status === "running" || status === "in_progress",
      runtimeEffect: task.agenticContext?.durableRunId ? "runtime_pause" : "state_only",
      reason: task.agenticContext?.durableRunId
        ? "Calls the attached durable run pause path and mirrors the result into Cowork state."
        : "Records local Cowork intent only because no attached durable run is available.",
    },
    {
      action: "cancel",
      label: "Cancel run",
      enabled: status !== "completed" && status !== "done" && status !== "cancelled" && status !== "stopped_by_limit",
      runtimeEffect: "state_only",
      reason:
        "Cancels the durable board state; live runtime cancellation is only applied where an executor is attached.",
    },
    {
      action: "retry",
      label: "Retry task",
      enabled: status === "failed" || status === "blocked" || status === "cancelled",
      runtimeEffect: "state_only",
      reason: "Moves the task back into a retryable state; command replay is not automatic.",
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

function findControlActivityById(activities: TaskActivityRecord[], controlId: string): TaskActivityRecord | undefined {
  return activities.find(
    (activity) => activity.activityType === "control" && activity.metadata?.controlId === controlId,
  );
}

function buildIdempotentControlReplay(
  task: TaskRecord,
  input: AgenticControlRequest,
  existing: TaskActivityRecord,
): AgenticControlResponse {
  const runtimeEffect = isAgenticRuntimeEffect(existing.metadata?.runtimeEffect)
    ? existing.metadata.runtimeEffect
    : "state_only";
  const status = existing.metadata?.resultStatus === "rejected" ? "rejected" : "recorded";
  return {
    action: input.action,
    taskId: task.taskId,
    runId: task.agenticContext?.runId,
    status,
    runtimeEffect,
    controlId: input.controlId,
    idempotentReplay: true,
    message: "Control was already recorded; the duplicate request was treated as an idempotent replay.",
  };
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
      return "timeout";
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
