import type {
  AgenticControlDescriptor,
  AgenticDiagnosticSignal,
  AgenticRunListItem,
  AgenticRunStatus,
  AgenticRunTreeEdge,
  AgenticRunTreeNode,
  AgenticRunTreeResponse,
  AgenticSurface,
  ChatDelegationRunRecord,
  ChatDelegationRunStatus,
  ChatDelegationStepRecord,
  ChatMode,
  ChatTurnTraceRecord,
  DurableRunRecord,
  DurableRunStatus,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

const DEFAULT_WORKSPACE_ID = "default";
const STALE_ACTIVE_STEP_MS = 24 * 60 * 60 * 1000;

export type CoworkAgenticProjectionStorage = Partial<
  Pick<Storage, "chatDelegationRuns" | "chatDelegationSteps" | "chatExecutionPlans" | "chatSessionMeta">
> &
  Pick<Storage, "chatTurnTraces" | "durableRuns">;

export interface CoworkAgenticProjectionListInput {
  workspaceId?: string;
  limit?: number;
  status?: AgenticRunStatus;
  surface?: AgenticSurface;
  sessionId?: string;
  boardId?: string;
  parentRunId?: string;
}

export class CoworkAgenticProjectionService {
  public constructor(private readonly storage: CoworkAgenticProjectionStorage) {}

  public isAvailable(): boolean {
    return Boolean(this.storage.chatDelegationRuns && this.storage.chatDelegationSteps);
  }

  public listAgenticRuns(input: CoworkAgenticProjectionListInput = {}): AgenticRunListItem[] {
    if (!this.storage.chatDelegationRuns?.listRecent || !this.shouldProjectSurface(input.surface)) {
      return [];
    }
    if (input.parentRunId?.trim()) {
      return [];
    }
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const runs = this.storage.chatDelegationRuns.listRecent({
      workspaceId,
      sessionId: input.sessionId,
      limit: Math.max(1, Math.min(input.limit ?? 100, 500)),
    });
    const items: AgenticRunListItem[] = [];
    for (const run of runs) {
      const surface = this.resolveRunSurface(run);
      if (input.surface && surface !== input.surface) {
        continue;
      }
      const status = mapDelegationRunStatus(run.status, run);
      if (input.status && status !== input.status) {
        continue;
      }
      const boardId = `cowork:${workspaceId}`;
      if (input.boardId && input.boardId !== boardId) {
        continue;
      }
      items.push({
        taskId: run.taskId,
        runId: run.runId,
        boardId,
        title: renderRunTitle(run),
        summary: run.finalSummary ?? run.objective,
        taskStatus: status === "completed" ? "done" : status === "failed" ? "blocked" : "in_progress",
        status,
        surface,
        parentSessionId: run.sessionId,
        updatedAt: run.finishedAt ?? run.startedAt,
        diagnostics: this.deriveStoredRunDiagnostics(run),
      });
    }
    return items;
  }

  public getAgenticRunTree(runId: string, options?: { workspaceId?: string }): AgenticRunTreeResponse | undefined {
    if (!this.storage.chatDelegationRuns || !this.storage.chatDelegationSteps) {
      return undefined;
    }
    const run = readOptional(() => this.storage.chatDelegationRuns!.get(runId));
    if (!run) {
      return undefined;
    }
    const workspaceId = normalizeWorkspaceId(this.resolveRunWorkspaceId(run) ?? options?.workspaceId);
    if (options?.workspaceId && workspaceId !== normalizeWorkspaceId(options.workspaceId)) {
      return undefined;
    }

    const diagnostics: AgenticDiagnosticSignal[] = [];
    diagnostics.push(...this.reconcileParentDurableTrace(run));
    const steps = this.reconcileRunSteps(run, diagnostics);
    const currentRun = readOptional(() => this.storage.chatDelegationRuns!.get(runId)) ?? run;
    const status = mapDelegationRunStatus(currentRun.status, currentRun);
    const rootNodeId = `run:${currentRun.runId}`;
    const nodes: AgenticRunTreeNode[] = [
      {
        id: rootNodeId,
        kind: "run",
        label: renderRunTitle(currentRun),
        status,
        taskId: currentRun.taskId,
        summary: currentRun.finalSummary ?? currentRun.objective,
        metadata: compactRecord({
          projectionSource: "chat_delegation_runs",
          sessionId: currentRun.sessionId,
          workflowTemplate: currentRun.workflowTemplate,
          visibility: currentRun.visibility,
          executionPlanId: currentRun.executionPlanId,
          mode: currentRun.mode,
          providerId: currentRun.providerId,
          model: currentRun.model,
          startedAt: currentRun.startedAt,
          finishedAt: currentRun.finishedAt,
        }),
      },
    ];
    const edges: AgenticRunTreeEdge[] = [];

    const parentTrace = this.resolveParentTurnTrace(currentRun);
    const parentDurableRun = readDurableRun(this.storage, parentTrace?.durable?.runId);
    if (parentDurableRun) {
      const durableNodeId = `durable:${parentDurableRun.runId}`;
      nodes.push({
        id: durableNodeId,
        kind: "run",
        label: "Parent durable run",
        status: parentDurableRun.status,
        parentId: rootNodeId,
        taskId: currentRun.taskId,
        summary: parentDurableRun.lastError,
        metadata: compactRecord({
          runtimeKind: "durable",
          workflowKey: parentDurableRun.workflowKey,
          startedAt: parentDurableRun.startedAt,
          finishedAt: parentDurableRun.finishedAt,
          leaseHeartbeatAt: parentDurableRun.leaseHeartbeatAt,
        }),
      });
      edges.push({ from: rootNodeId, to: durableNodeId, kind: "contains" });
    }

    for (const step of steps) {
      const stepNodeId = `subagent:${step.stepId}`;
      const childTrace = step.childTurnId
        ? readOptional(() => this.storage.chatTurnTraces.get(step.childTurnId!))
        : undefined;
      nodes.push({
        id: stepNodeId,
        kind: "subagent",
        label: step.label ?? step.role,
        status: step.status,
        parentId: rootNodeId,
        taskId: currentRun.taskId,
        agentSessionId: step.childSessionId,
        summary: step.summary ?? step.error,
        metadata: compactRecord({
          projectionSource: "chat_delegation_steps",
          role: step.role,
          index: step.index,
          providerId: step.providerId,
          model: step.model,
          durableRunId: step.durableRunId,
          childSessionId: step.childSessionId,
          childTurnId: step.childTurnId,
          childTraceStatus: childTrace?.status,
          startedAt: step.startedAt,
          finishedAt: step.finishedAt,
          durationMs: step.durationMs,
          citationCount: step.citations?.length,
          failureGuidance: step.failureGuidance,
          degradedHandoffStepIds: step.degradedHandoffStepIds,
        }),
      });
      edges.push({ from: rootNodeId, to: stepNodeId, kind: "spawned" });

      const childDurableRun = readDurableRun(this.storage, step.durableRunId);
      if (childDurableRun) {
        const durableNodeId = `durable:${childDurableRun.runId}`;
        nodes.push({
          id: durableNodeId,
          kind: "run",
          label: `${step.label ?? step.role} durable run`,
          status: childDurableRun.status,
          parentId: stepNodeId,
          taskId: currentRun.taskId,
          summary: childDurableRun.lastError,
          metadata: compactRecord({
            runtimeKind: "durable",
            workflowKey: childDurableRun.workflowKey,
            startedAt: childDurableRun.startedAt,
            finishedAt: childDurableRun.finishedAt,
            leaseHeartbeatAt: childDurableRun.leaseHeartbeatAt,
          }),
        });
        edges.push({ from: stepNodeId, to: durableNodeId, kind: "contains" });
      }
    }

    diagnostics.push(...this.deriveStoredRunDiagnostics(currentRun));
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
      runId: currentRun.runId,
      boardId: `cowork:${workspaceId}`,
      generatedAt: new Date().toISOString(),
      nodes,
      edges,
      diagnostics,
      controls: buildProjectedControls(status, parentDurableRun?.runId),
    };
  }

  private shouldProjectSurface(surface?: AgenticSurface): boolean {
    return !surface || surface === "cowork";
  }

  private resolveRunSurface(run: ChatDelegationRunRecord): ChatMode {
    const plan = readOptional(() =>
      run.executionPlanId && this.storage.chatExecutionPlans
        ? this.storage.chatExecutionPlans.get(run.executionPlanId)
        : undefined,
    );
    if (plan?.mode) {
      return plan.mode;
    }
    const trace = this.resolveParentTurnTrace(run);
    return trace?.mode ?? "cowork";
  }

  private resolveRunWorkspaceId(run: ChatDelegationRunRecord): string | undefined {
    return this.storage.chatSessionMeta?.get(run.sessionId)?.workspaceId;
  }

  private resolveParentTurnTrace(run: ChatDelegationRunRecord): ChatTurnTraceRecord | undefined {
    const turnId = parseTurnIdFromChatOrchestrationTaskId(run.taskId);
    if (!turnId) {
      return undefined;
    }
    return readOptional(() => this.storage.chatTurnTraces.get(turnId));
  }

  private reconcileParentDurableTrace(run: ChatDelegationRunRecord): AgenticDiagnosticSignal[] {
    const trace = this.resolveParentTurnTrace(run);
    const durableRun = readDurableRun(this.storage, trace?.durable?.runId);
    if (!trace?.durable?.runId || !durableRun || trace.durable.status === durableRun.status) {
      return [];
    }
    const now = new Date().toISOString();
    this.storage.chatTurnTraces.patch(trace.turnId, {
      durable: {
        ...trace.durable,
        status: durableRun.status,
      },
    });
    return [
      {
        signalId: `projection-status-drift-${run.runId}-${durableRun.runId}`,
        code: "projection_status_drift",
        severity: isTerminalDurableStatus(durableRun.status) ? "warning" : "info",
        title: "Durable trace status reconciled",
        summary: `Stored turn trace reported durable status ${trace.durable.status}; durable run ${durableRun.runId} is ${durableRun.status}.`,
        evidenceRef: `durable-run:${durableRun.runId}`,
        createdAt: now,
      },
    ];
  }

  private reconcileRunSteps(
    run: ChatDelegationRunRecord,
    diagnostics: AgenticDiagnosticSignal[],
  ): ChatDelegationStepRecord[] {
    const steps = this.storage.chatDelegationSteps?.listByRun(run.runId) ?? [];
    const reconciled = steps.map((step) => this.reconcileStep(step, diagnostics));
    const activeCount = reconciled.filter((step) => step.status === "running" || step.status === "pending").length;
    if (run.status === "running" && activeCount === 0 && reconciled.length > 0 && this.storage.chatDelegationRuns) {
      const completedCount = reconciled.filter((step) => step.status === "completed").length;
      const nextStatus: ChatDelegationRunStatus =
        completedCount === reconciled.length ? "completed" : completedCount > 0 ? "partial" : "failed";
      return readOptional(() =>
        this.storage.chatDelegationRuns!.patch(run.runId, {
          status: nextStatus,
          finalSummary:
            run.finalSummary ??
            (nextStatus === "completed"
              ? "All delegated steps completed after projection reconciliation."
              : "Delegation reconciled from child runtime state."),
          stitchedOutput: run.stitchedOutput ?? buildStitchedOutputFromSteps(reconciled),
          finishedAt: new Date().toISOString(),
        }),
      )
        ? this.storage.chatDelegationSteps!.listByRun(run.runId)
        : reconciled;
    }
    return reconciled;
  }

  private reconcileStep(
    step: ChatDelegationStepRecord,
    diagnostics: AgenticDiagnosticSignal[],
  ): ChatDelegationStepRecord {
    if (step.status !== "running" && step.status !== "pending") {
      return step;
    }
    const now = new Date().toISOString();
    const childDurableRun = readDurableRun(this.storage, step.durableRunId);
    if (childDurableRun && isTerminalDurableStatus(childDurableRun.status)) {
      diagnostics.push(
        buildProjectionDriftDiagnostic({
          runId: step.runId,
          stepId: step.stepId,
          durableRun: childDurableRun,
          previousStatus: step.status,
          now,
        }),
      );
      return this.storage.chatDelegationSteps!.patch(step.stepId, {
        status: mapDurableStatusToStepStatus(childDurableRun.status),
        summary:
          step.summary ??
          (childDurableRun.status === "completed"
            ? "Child durable run completed; step state was reconciled."
            : `Child durable run ${childDurableRun.status}; step state was reconciled.`),
        error:
          childDurableRun.status === "failed" || childDurableRun.status === "dead_lettered"
            ? (childDurableRun.lastError ?? "Child durable run failed.")
            : step.error,
        failureGuidance:
          childDurableRun.status === "failed" || childDurableRun.status === "dead_lettered"
            ? (step.failureGuidance ?? "Continue from gathered evidence or inspect the child durable run diagnostics.")
            : step.failureGuidance,
        finishedAt: step.finishedAt ?? childDurableRun.finishedAt ?? now,
        durationMs: step.durationMs ?? durationMs(step.startedAt, childDurableRun.finishedAt ?? now),
      });
    }

    const childTrace = step.childTurnId
      ? readOptional(() => this.storage.chatTurnTraces.get(step.childTurnId!))
      : undefined;
    if (childTrace && isTerminalTraceStatus(childTrace.status)) {
      diagnostics.push({
        signalId: `projection-status-drift-${step.runId}-${step.stepId}`,
        code: "projection_status_drift",
        severity: "warning",
        title: "Child trace status reconciled",
        summary: `Delegation step ${step.label ?? step.role} was ${step.status}, but child turn ${step.childTurnId} is ${childTrace.status}.`,
        evidenceRef: `chat-turn:${step.childTurnId}`,
        createdAt: now,
      });
      return this.storage.chatDelegationSteps!.patch(step.stepId, {
        status:
          childTrace.status === "cancelled" ? "cancelled" : childTrace.status === "failed" ? "failed" : "completed",
        summary: step.summary ?? `Child turn ${childTrace.status}; step state was reconciled.`,
        error: childTrace.status === "failed" ? (childTrace.failure?.message ?? step.error) : step.error,
        finishedAt: step.finishedAt ?? now,
        durationMs: step.durationMs ?? durationMs(step.startedAt, now),
      });
    }

    if (!childDurableRun && step.output?.trim()) {
      diagnostics.push({
        signalId: `durable-missing-after-completion-${step.runId}-${step.stepId}`,
        code: "durable_missing_after_completion",
        severity: "warning",
        title: "Child durable linkage missing after handoff",
        summary: `Delegation step ${step.label ?? step.role} has handoff output but no readable durable run; completed state was reconciled from persisted output.`,
        evidenceRef: step.childTurnId ? `chat-turn:${step.childTurnId}` : `delegation-step:${step.stepId}`,
        createdAt: now,
      });
      return this.storage.chatDelegationSteps!.patch(step.stepId, {
        status: "completed",
        summary: step.summary ?? step.output.slice(0, 180),
        finishedAt: step.finishedAt ?? now,
        durationMs: step.durationMs ?? durationMs(step.startedAt, now),
      });
    }

    if (!childDurableRun && Date.now() - Date.parse(step.startedAt) > STALE_ACTIVE_STEP_MS) {
      diagnostics.push({
        signalId: `stale-worker-${step.runId}-${step.stepId}`,
        code: "stale_worker",
        severity: "critical",
        title: "Delegation step lost runtime evidence",
        summary: `Delegation step ${step.label ?? step.role} stayed ${step.status} without durable evidence for over 24 hours.`,
        evidenceRef: `delegation-step:${step.stepId}`,
        createdAt: now,
      });
      return this.storage.chatDelegationSteps!.patch(step.stepId, {
        status: "failed",
        summary: "Step blocked: runtime evidence was lost.",
        error: "Delegation step had no durable run, terminal trace, or handoff output after the stale window.",
        failureGuidance: "Continue from gathered evidence or restart this child step with a narrower source target.",
        finishedAt: now,
        durationMs: step.durationMs ?? durationMs(step.startedAt, now),
      });
    }

    return step;
  }

  private deriveStoredRunDiagnostics(run: ChatDelegationRunRecord): AgenticDiagnosticSignal[] {
    const diagnostics: AgenticDiagnosticSignal[] = [];
    const trace = this.resolveParentTurnTrace(run);
    const durableRun = readDurableRun(this.storage, trace?.durable?.runId);
    if (trace?.durable?.runId && durableRun && trace.durable.status !== durableRun.status) {
      diagnostics.push(
        buildProjectionDriftDiagnostic({
          runId: run.runId,
          durableRun,
          previousStatus: trace.durable.status ?? "unknown",
          now: new Date().toISOString(),
        }),
      );
    }
    return diagnostics;
  }
}

function mapDelegationRunStatus(status: ChatDelegationRunStatus, run: ChatDelegationRunRecord): AgenticRunStatus {
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "partial") {
    return run.stitchedOutput || run.finalSummary ? "completed" : "failed";
  }
  return "running";
}

function mapDurableStatusToStepStatus(status: DurableRunStatus): ChatDelegationStepRecord["status"] {
  if (status === "completed") {
    return "completed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  return "failed";
}

function isTerminalDurableStatus(status: DurableRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "dead_lettered";
}

function isTerminalTraceStatus(status: ChatTurnTraceRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function readDurableRun(
  storage: CoworkAgenticProjectionStorage,
  runId: string | undefined,
): DurableRunRecord | undefined {
  if (!runId) {
    return undefined;
  }
  return readOptional(() => storage.durableRuns.getRun(runId));
}

function readOptional<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof NotFoundError || /not found/i.test(error instanceof Error ? error.message : String(error))) {
      return undefined;
    }
    throw error;
  }
}

function parseTurnIdFromChatOrchestrationTaskId(taskId: string): string | undefined {
  const prefix = "chat-orchestration:";
  return taskId.startsWith(prefix) ? taskId.slice(prefix.length).trim() || undefined : undefined;
}

function renderRunTitle(run: ChatDelegationRunRecord): string {
  const objective = run.objective.replace(/\s+/g, " ").trim();
  const label = objective.length > 120 ? `${objective.slice(0, 117)}...` : objective;
  return run.workflowTemplate ? `${run.workflowTemplate}: ${label}` : `Cowork: ${label}`;
}

function buildStitchedOutputFromSteps(steps: ChatDelegationStepRecord[]): string {
  return steps
    .map((step) => {
      const body = step.output?.trim() || step.error?.trim() || step.summary?.trim() || `Step ${step.status}.`;
      return `### ${step.label ?? step.role}\n${body}`;
    })
    .join("\n\n")
    .trim();
}

function buildProjectionDriftDiagnostic(input: {
  runId: string;
  stepId?: string;
  durableRun: DurableRunRecord;
  previousStatus: string;
  now: string;
}): AgenticDiagnosticSignal {
  const suffix = input.stepId ? `${input.stepId}-${input.durableRun.runId}` : input.durableRun.runId;
  return {
    signalId: `projection-status-drift-${input.runId}-${suffix}`,
    code: "projection_status_drift",
    severity: isTerminalDurableStatus(input.durableRun.status) ? "warning" : "info",
    title: "Runtime status projection reconciled",
    summary: `Projection reported ${input.previousStatus}; durable run ${input.durableRun.runId} is ${input.durableRun.status}.`,
    evidenceRef: `durable-run:${input.durableRun.runId}`,
    createdAt: input.now,
  };
}

function buildProjectedControls(_status: AgenticRunStatus, durableRunId?: string): AgenticControlDescriptor[] {
  const reason = durableRunId
    ? "Projected Cowork runs are view-only until projected durable-run controls are wired through TaskLifecycleService."
    : "Projected Cowork runs are view-only until they have a task-backed control path.";
  return [
    {
      action: "pause",
      label: durableRunId ? "Pause durable run" : "Record pause intent",
      enabled: false,
      runtimeEffect: "state_only",
      reason,
    },
    {
      action: "cancel",
      label: durableRunId ? "Cancel durable run" : "Record cancel intent",
      enabled: false,
      runtimeEffect: "state_only",
      reason,
    },
    {
      action: "retry",
      label: "Continue from gathered evidence",
      enabled: false,
      runtimeEffect: "state_only",
      reason,
    },
    {
      action: "steer",
      label: "Steer run",
      enabled: false,
      runtimeEffect: "state_only",
      reason,
    },
  ];
}

function normalizeWorkspaceId(value: string | undefined): string {
  return value?.trim() || DEFAULT_WORKSPACE_ID;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null));
}

function durationMs(startedAt: string, finishedAt: string): number {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  return Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;
}
