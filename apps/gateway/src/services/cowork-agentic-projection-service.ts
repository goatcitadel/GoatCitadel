/* eslint-disable max-lines */
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
  ChatToolRunRecord,
  ChatTurnTraceRecord,
  DurableRunRecord,
  DurableRunStatus,
} from "@goatcitadel/contracts";
import {
  NotFoundError,
  isDurableRunTerminal,
  isDurableRunStatus,
  isChatTurnWaitingStatus,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { buildLocalBusinessResearchAnnotationFromEvidence } from "./local-business-research-service.js";

const DEFAULT_WORKSPACE_ID = "default";
const STALE_ACTIVE_STEP_MS = 24 * 60 * 60 * 1000;

export type CoworkAgenticProjectionStorage = Partial<
  Pick<
    Storage,
    "chatDelegationRuns" | "chatDelegationSteps" | "chatExecutionPlans" | "chatSessionMeta" | "chatToolRuns" | "tasks"
  >
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
    const parentTurnIds = runs.map((run) => parseTurnIdFromChatOrchestrationTaskId(run.taskId));
    const traceMap = readOptional(() => this.storage.chatTurnTraces.getByTurnIds(parentTurnIds)) ?? new Map();
    const durableRunIds = [...traceMap.values()].map((trace) => trace.durable?.runId);
    const durableMap = readOptional(() => this.storage.durableRuns.getRunsByIds(durableRunIds)) ?? new Map();
    const toolRunMap = readOptional(() => this.storage.chatToolRuns?.listByTurnIds([...traceMap.keys()])) ?? new Map();
    const ctx = new ProjectionReadContext(this.storage, traceMap, durableMap, toolRunMap);
    const items: AgenticRunListItem[] = [];
    for (const run of runs) {
      const initialSteps = readOptional(() => this.storage.chatDelegationSteps?.listByRun(run.runId)) ?? [];
      const runCtx = initialSteps.length > 0 ? this.buildReadContext(run, initialSteps) : ctx;
      const surface = this.resolveRunSurface(run, runCtx);
      if (input.surface && surface !== input.surface) {
        continue;
      }
      const diagnostics: AgenticDiagnosticSignal[] = [];
      diagnostics.push(...this.reconcileParentDurableTrace(run, runCtx));
      const steps = this.reconcileRunSteps(run, initialSteps, diagnostics, runCtx);
      const parentTrace = this.resolveParentTurnTrace(run, runCtx);
      const status = mapDelegationRunStatus(run.status, run, parentTrace, steps);
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
        diagnostics: dedupeDiagnostics([
          ...diagnostics,
          ...this.deriveStoredRunDiagnostics(run, steps, parentTrace, runCtx),
        ]),
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

    // Bulk-fetch every related row ONCE so neither workspace resolution, reconciliation,
    // nor projection re-issues per-step trace/durable/tool-run queries.
    const initialSteps = readOptional(() => this.storage.chatDelegationSteps!.listByRun(runId)) ?? [];
    const ctx = this.buildReadContext(run, initialSteps);

    const ownerWorkspaceId = this.resolveRunWorkspaceId(run, initialSteps, ctx);
    if (!ownerWorkspaceId) {
      return undefined;
    }
    const workspaceId = normalizeWorkspaceId(ownerWorkspaceId);
    if (options?.workspaceId && workspaceId !== normalizeWorkspaceId(options.workspaceId)) {
      return undefined;
    }

    const diagnostics: AgenticDiagnosticSignal[] = [];
    diagnostics.push(...this.reconcileParentDurableTrace(run, ctx));
    const steps = this.reconcileRunSteps(run, initialSteps, diagnostics, ctx);
    const currentRun = run;
    const parentTrace = this.resolveParentTurnTrace(currentRun, ctx);
    const status = mapDelegationRunStatus(currentRun.status, currentRun, parentTrace, steps);
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

    const parentDurableRun = ctx.getDurableRun(parentTrace?.durable?.runId);
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

    let blockedByOperatorGate = false;
    for (const step of steps) {
      const stepNodeId = `subagent:${step.stepId}`;
      const childTrace = ctx.getTrace(step.childTurnId);
      const childDurableRun = ctx.getDurableRun(step.durableRunId);
      const childToolRuns = this.readTraceToolRuns(childTrace, ctx);
      const childLocalBusinessResearch = collectProjectedLocalBusinessResearchForStep(currentRun, step, childToolRuns);
      const stepNodeStatus = projectStepNodeStatus(step, childTrace, childDurableRun, blockedByOperatorGate);
      const stepBlockedByOperatorGate = blockedByOperatorGate && step.status === "pending";
      if (stepNodeStatus === "approval_required" || stepNodeStatus === "paused") {
        blockedByOperatorGate = true;
      }
      nodes.push({
        id: stepNodeId,
        kind: "subagent",
        label: step.label ?? step.role,
        status: stepNodeStatus,
        parentId: rootNodeId,
        taskId: currentRun.taskId,
        agentSessionId: step.childSessionId,
        summary:
          step.summary ??
          step.error ??
          (stepBlockedByOperatorGate ? "Waiting for an earlier operator gate before this step can start." : undefined),
        metadata: compactRecord({
          projectionSource: "chat_delegation_steps",
          role: step.role,
          index: step.index,
          blockedByOperatorGate: stepBlockedByOperatorGate ? true : undefined,
          providerId: step.providerId,
          model: step.model,
          durableRunId: step.durableRunId,
          childSessionId: step.childSessionId,
          childTurnId: step.childTurnId,
          childTraceStatus: childTrace?.status,
          toolRunCount: childToolRuns.length > 0 ? childToolRuns.length : undefined,
          localBusinessResearch: childLocalBusinessResearch.length > 0 ? childLocalBusinessResearch : undefined,
          startedAt: step.startedAt,
          finishedAt: step.finishedAt,
          durationMs: step.durationMs,
          citationCount: step.citations?.length,
          failureGuidance: step.failureGuidance,
          degradedHandoffStepIds: step.degradedHandoffStepIds,
        }),
      });
      edges.push({ from: rootNodeId, to: stepNodeId, kind: "spawned" });

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

    diagnostics.push(...this.deriveStoredRunDiagnostics(currentRun, steps, parentTrace, ctx));
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

  private resolveRunSurface(run: ChatDelegationRunRecord, ctx: ProjectionReadContext): ChatMode {
    const plan = readOptional(() =>
      run.executionPlanId && this.storage.chatExecutionPlans
        ? this.storage.chatExecutionPlans.get(run.executionPlanId)
        : undefined,
    );
    if (plan?.mode) {
      return plan.mode;
    }
    const trace = this.resolveParentTurnTrace(run, ctx);
    return trace?.mode ?? "cowork";
  }

  private resolveRunWorkspaceId(
    run: ChatDelegationRunRecord,
    steps: ChatDelegationStepRecord[],
    ctx: ProjectionReadContext,
  ): string | undefined {
    const sessionWorkspaceId = this.resolveSessionWorkspaceId(run.sessionId);
    if (sessionWorkspaceId) {
      return sessionWorkspaceId;
    }

    const taskWorkspaceId = normalizeOptionalWorkspaceId(this.storage.tasks?.find(run.taskId)?.workspaceId);
    if (taskWorkspaceId) {
      return taskWorkspaceId;
    }

    const parentTurnId = parseTurnIdFromChatOrchestrationTaskId(run.taskId);
    const parentTrace = this.resolveParentTurnTrace(run, ctx);
    const parentTraceWorkspaceId = this.resolveTraceWorkspaceId(parentTrace, {
      sessionId: run.sessionId,
      turnId: parentTurnId,
    });
    if (parentTraceWorkspaceId) {
      return parentTraceWorkspaceId;
    }

    const parentDurableRun = ctx.getDurableRun(parentTrace?.durable?.runId);
    const parentDurableWorkspaceId = resolveLinkedDurableWorkspaceId(parentDurableRun, {
      sessionId: run.sessionId,
      turnId: parentTurnId,
      taskId: run.taskId,
    });
    if (parentDurableWorkspaceId) {
      return parentDurableWorkspaceId;
    }

    const linkedWorkspaceIds = new Set<string>();
    for (const step of steps) {
      const childSessionWorkspaceId = this.resolveSessionWorkspaceId(step.childSessionId);
      if (childSessionWorkspaceId) {
        linkedWorkspaceIds.add(childSessionWorkspaceId);
      }

      const childTrace = ctx.getTrace(step.childTurnId);
      const childTraceWorkspaceId = this.resolveTraceWorkspaceId(childTrace, {
        sessionId: step.childSessionId,
        turnId: step.childTurnId,
      });
      if (childTraceWorkspaceId) {
        linkedWorkspaceIds.add(childTraceWorkspaceId);
      }

      const childDurableWorkspaceId = resolveLinkedDurableWorkspaceId(ctx.getDurableRun(step.durableRunId), {
        sessionId: step.childSessionId,
        turnId: step.childTurnId,
      });
      if (childDurableWorkspaceId) {
        linkedWorkspaceIds.add(childDurableWorkspaceId);
      }
    }
    return linkedWorkspaceIds.size === 1 ? [...linkedWorkspaceIds][0] : undefined;
  }

  private resolveSessionWorkspaceId(sessionId: string | undefined): string | undefined {
    if (!sessionId) {
      return undefined;
    }
    return normalizeOptionalWorkspaceId(this.storage.chatSessionMeta?.get(sessionId)?.workspaceId);
  }

  private resolveTraceWorkspaceId(
    trace: ChatTurnTraceRecord | undefined,
    expected: { sessionId?: string; turnId?: string },
  ): string | undefined {
    if (!trace) {
      return undefined;
    }
    const expectedSessionId = normalizeOptionalWorkspaceId(expected.sessionId);
    const expectedTurnId = normalizeOptionalWorkspaceId(expected.turnId);
    if (expectedSessionId && trace.sessionId !== expectedSessionId) {
      return undefined;
    }
    if (expectedTurnId && trace.turnId !== expectedTurnId) {
      return undefined;
    }
    return normalizeOptionalWorkspaceId(trace.guidance?.workspaceId) ?? this.resolveSessionWorkspaceId(trace.sessionId);
  }

  private resolveParentTurnTrace(
    run: ChatDelegationRunRecord,
    ctx: ProjectionReadContext,
  ): ChatTurnTraceRecord | undefined {
    const turnId = parseTurnIdFromChatOrchestrationTaskId(run.taskId);
    if (!turnId) {
      return undefined;
    }
    return ctx.getTrace(turnId);
  }

  private reconcileParentDurableTrace(
    run: ChatDelegationRunRecord,
    ctx: ProjectionReadContext,
  ): AgenticDiagnosticSignal[] {
    const trace = this.resolveParentTurnTrace(run, ctx);
    const durableRun = ctx.getDurableRun(trace?.durable?.runId);
    if (!trace?.durable?.runId || !durableRun || trace.durable.status === durableRun.status) {
      return [];
    }
    const now = new Date().toISOString();
    return [
      {
        signalId: `projection-status-drift-${run.runId}-${durableRun.runId}`,
        code: "projection_status_drift",
        severity: isDurableRunTerminal(durableRun.status) ? "warning" : "info",
        title: "Durable trace status reconciled",
        summary: `Stored turn trace reported durable status ${trace.durable.status}; durable run ${durableRun.runId} is ${durableRun.status}.`,
        evidenceRef: `durable-run:${durableRun.runId}`,
        createdAt: now,
      },
    ];
  }

  private reconcileRunSteps(
    run: ChatDelegationRunRecord,
    steps: ChatDelegationStepRecord[],
    diagnostics: AgenticDiagnosticSignal[],
    ctx: ProjectionReadContext,
  ): ChatDelegationStepRecord[] {
    const reconciled = steps.map((step) => this.reconcileStep(step, diagnostics, ctx));
    const activeCount = reconciled.filter((step) => step.status === "running" || step.status === "pending").length;
    if (run.status === "running" && activeCount === 0 && reconciled.length > 0) {
      const completedCount = reconciled.filter((step) => step.status === "completed").length;
      const nextStatus: ChatDelegationRunStatus =
        completedCount === reconciled.length ? "completed" : completedCount > 0 ? "partial" : "failed";
      diagnostics.push({
        signalId: `projection-run-status-drift-${run.runId}`,
        code: "projection_status_drift",
        severity: nextStatus === "completed" ? "info" : "warning",
        title: "Delegation run status projected",
        summary: `Delegation run remained ${run.status}, but child runtime state projects it as ${nextStatus}.`,
        evidenceRef: `delegation-run:${run.runId}`,
        createdAt: new Date().toISOString(),
      });
    }
    return reconciled;
  }

  private reconcileStep(
    step: ChatDelegationStepRecord,
    diagnostics: AgenticDiagnosticSignal[],
    ctx: ProjectionReadContext,
  ): ChatDelegationStepRecord {
    if (step.status !== "running" && step.status !== "pending") {
      return step;
    }
    const now = new Date().toISOString();
    const childDurableRun = ctx.getDurableRun(step.durableRunId);
    if (childDurableRun && isDurableRunTerminal(childDurableRun.status)) {
      diagnostics.push(
        buildProjectionDriftDiagnostic({
          runId: step.runId,
          stepId: step.stepId,
          durableRun: childDurableRun,
          previousStatus: step.status,
          now,
        }),
      );
      return {
        ...step,
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
      };
    }
    if (childDurableRun) {
      return step;
    }

    const childTrace = ctx.getTrace(step.childTurnId);
    if (childTrace && isChatTurnWaitingStatus(childTrace.status)) {
      return step;
    }
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
      return {
        ...step,
        status:
          childTrace.status === "cancelled" ? "cancelled" : childTrace.status === "failed" ? "failed" : "completed",
        summary: step.summary ?? `Child turn ${childTrace.status}; step state was reconciled.`,
        error: childTrace.status === "failed" ? (childTrace.failure?.message ?? step.error) : step.error,
        finishedAt: step.finishedAt ?? now,
        durationMs: step.durationMs ?? durationMs(step.startedAt, now),
      };
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
      return {
        ...step,
        status: "completed",
        summary: step.summary ?? step.output.slice(0, 180),
        finishedAt: step.finishedAt ?? now,
        durationMs: step.durationMs ?? durationMs(step.startedAt, now),
      };
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
      return {
        ...step,
        status: "failed",
        summary: "Step blocked: runtime evidence was lost.",
        error: "Delegation step had no durable run, terminal trace, or handoff output after the stale window.",
        failureGuidance: "Continue from gathered evidence or restart this child step with a narrower source target.",
        finishedAt: now,
        durationMs: step.durationMs ?? durationMs(step.startedAt, now),
      };
    }

    return step;
  }

  private deriveStoredRunDiagnostics(
    run: ChatDelegationRunRecord,
    steps: ChatDelegationStepRecord[],
    parentTrace: ChatTurnTraceRecord | undefined,
    ctx: ProjectionReadContext,
  ): AgenticDiagnosticSignal[] {
    const diagnostics: AgenticDiagnosticSignal[] = [];
    const now = new Date().toISOString();
    const durableRun = ctx.getDurableRun(parentTrace?.durable?.runId);
    if (parentTrace?.durable?.runId && durableRun && parentTrace.durable.status !== durableRun.status) {
      diagnostics.push(
        buildProjectionDriftDiagnostic({
          runId: run.runId,
          durableRun,
          previousStatus: parentTrace.durable.status ?? "unknown",
          now,
        }),
      );
    }
    const parentToolRuns = this.readTraceToolRuns(parentTrace, ctx);
    diagnostics.push(
      ...deriveCoworkResearchDiagnostics({
        runId: run.runId,
        sourceId: parentTrace?.turnId ?? run.runId,
        sourceLabel: "parent turn trace",
        text: joinDiagnosticText(parentTrace?.failure?.message, parentTrace?.routing?.fallbackReason),
        toolRuns: parentToolRuns,
        now,
      }),
    );
    for (const step of steps) {
      const childTrace = ctx.getTrace(step.childTurnId);
      if (shouldDeriveResearchDiagnosticsForStep(step)) {
        diagnostics.push(
          ...deriveCoworkResearchDiagnostics({
            runId: run.runId,
            sourceId: childTrace?.turnId ?? step.stepId,
            sourceLabel: `handoff ${step.label ?? step.role}`,
            text: joinDiagnosticText(
              step.output,
              step.summary,
              step.error,
              step.failureGuidance,
              childTrace?.failure?.message,
              childTrace?.routing?.fallbackReason,
            ),
            toolRuns: this.readTraceToolRuns(childTrace, ctx),
            now,
          }),
        );
      }
    }
    return dedupeDiagnostics(diagnostics);
  }

  private readTraceToolRuns(trace: ChatTurnTraceRecord | undefined, ctx: ProjectionReadContext): ChatToolRunRecord[] {
    if (!trace) {
      return [];
    }
    if (trace.toolRuns.length > 0) {
      return trace.toolRuns;
    }
    return ctx.getToolRuns(trace.turnId);
  }

  private buildReadContext(run: ChatDelegationRunRecord, steps: ChatDelegationStepRecord[]): ProjectionReadContext {
    const turnIds: Array<string | undefined> = [parseTurnIdFromChatOrchestrationTaskId(run.taskId)];
    const durableRunIds: Array<string | undefined> = [];
    for (const step of steps) {
      turnIds.push(step.childTurnId);
      durableRunIds.push(step.durableRunId);
    }
    const traceMap = readOptional(() => this.storage.chatTurnTraces.getByTurnIds(turnIds)) ?? new Map();
    // The parent durable run is linked through the parent trace, which is only known once traces load.
    for (const trace of traceMap.values()) {
      if (trace.durable?.runId) {
        durableRunIds.push(trace.durable.runId);
      }
    }
    const durableMap = readOptional(() => this.storage.durableRuns.getRunsByIds(durableRunIds)) ?? new Map();
    const toolRunMap = readOptional(() => this.storage.chatToolRuns?.listByTurnIds([...traceMap.keys()])) ?? new Map();
    return new ProjectionReadContext(this.storage, traceMap, durableMap, toolRunMap);
  }
}

class ProjectionReadContext {
  public runChanged = false;
  private readonly toolRunCache = new Map<string, ChatToolRunRecord[]>();

  public constructor(
    private readonly storage: CoworkAgenticProjectionStorage,
    private readonly traceMap: Map<string, ChatTurnTraceRecord>,
    private readonly durableMap: Map<string, DurableRunRecord> = new Map(),
    preloadedToolRuns?: Map<string, ChatToolRunRecord[]>,
  ) {
    if (preloadedToolRuns) {
      for (const [turnId, records] of preloadedToolRuns) {
        this.toolRunCache.set(turnId, records);
      }
      for (const turnId of traceMap.keys()) {
        if (!this.toolRunCache.has(turnId)) {
          this.toolRunCache.set(turnId, []);
        }
      }
    }
  }

  public getTrace(turnId: string | undefined): ChatTurnTraceRecord | undefined {
    const key = turnId?.trim();
    return key ? this.traceMap.get(key) : undefined;
  }

  public recordTraceWrite(trace: ChatTurnTraceRecord): void {
    this.traceMap.set(trace.turnId, trace);
  }

  public getDurableRun(runId: string | undefined): DurableRunRecord | undefined {
    const key = runId?.trim();
    return key ? this.durableMap.get(key) : undefined;
  }

  public getToolRuns(turnId: string): ChatToolRunRecord[] {
    const cached = this.toolRunCache.get(turnId);
    if (cached) {
      return cached;
    }
    const records = readOptional(() => this.storage.chatToolRuns?.listByTurn(turnId)) ?? [];
    this.toolRunCache.set(turnId, records);
    return records;
  }
}

type CoworkResearchDiagnosticCode = Extract<
  AgenticDiagnosticSignal["code"],
  "research_evidence_incomplete" | "candidate_discovery_incomplete" | "source_access_blocked"
>;

interface CoworkLocalBusinessResearchMetadata {
  hasMetadata: boolean;
  candidateKeys: Set<string>;
  verifiedCandidateKeys: Set<string>;
  sourceUrls: Set<string>;
  blockerKeys: Set<string>;
  blockedSourceKeys: Set<string>;
  unresolvedNextStepKeys: Set<string>;
}

const COWORK_RESEARCH_DIAGNOSTIC_TITLES = {
  research_evidence_incomplete: "Cowork research evidence incomplete",
  candidate_discovery_incomplete: "Cowork candidate discovery incomplete",
  source_access_blocked: "Cowork source access blocked",
} as const satisfies Record<CoworkResearchDiagnosticCode, string>;

function mapDelegationRunStatus(
  status: ChatDelegationRunStatus | string,
  run: ChatDelegationRunRecord,
  parentTrace?: ChatTurnTraceRecord,
  steps: ChatDelegationStepRecord[] = [],
): AgenticRunStatus {
  if (status === "stopped_by_limit") {
    return "stopped_by_limit";
  }
  const operatorWaitStatus = projectOperatorWaitStatus(parentTrace, readDurableStatus(parentTrace));
  if (operatorWaitStatus) {
    return operatorWaitStatus;
  }
  if (traceProjectsBlockedCowork(parentTrace)) {
    return "blocked";
  }
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "partial") {
    if (steps.some(stepProjectsBlockedRuntimeLoss)) {
      return "blocked";
    }
    return run.stitchedOutput || run.finalSummary ? "checkpointing" : "blocked";
  }
  if (status === "running" && steps.length > 0) {
    const activeCount = steps.filter((step) => step.status === "running" || step.status === "pending").length;
    if (activeCount === 0) {
      const completedCount = steps.filter((step) => step.status === "completed").length;
      if (completedCount === steps.length) {
        return "completed";
      }
      if (steps.some(stepProjectsBlockedRuntimeLoss)) {
        return "blocked";
      }
      return run.stitchedOutput || run.finalSummary ? "checkpointing" : "blocked";
    }
  }
  return "running";
}

function stepProjectsBlockedRuntimeLoss(step: ChatDelegationStepRecord): boolean {
  if (step.status !== "failed") {
    return false;
  }
  const text = joinDiagnosticText(step.summary, step.error, step.failureGuidance).toLowerCase();
  return text.includes("runtime evidence was lost") || text.includes("stale_worker");
}

function projectStepNodeStatus(
  step: ChatDelegationStepRecord,
  childTrace: ChatTurnTraceRecord | undefined,
  childDurableRun: DurableRunRecord | undefined,
  blockedByOperatorGate: boolean,
): string {
  const operatorWaitStatus = projectOperatorWaitStatus(childTrace, childDurableRun?.status);
  if (operatorWaitStatus) {
    return operatorWaitStatus;
  }
  if (blockedByOperatorGate && step.status === "pending") {
    return "blocked";
  }
  return step.status;
}

function projectOperatorWaitStatus(
  trace: ChatTurnTraceRecord | undefined,
  durableStatus: DurableRunStatus | undefined,
): AgenticRunStatus | undefined {
  if (trace?.status === "waiting_for_approval") {
    return "approval_required";
  }
  if (trace?.status === "waiting_for_user_input") {
    return "paused";
  }
  if (durableStatus === "waiting") {
    return "approval_required";
  }
  if (durableStatus === "paused") {
    return "paused";
  }
  return undefined;
}

function readDurableStatus(trace: ChatTurnTraceRecord | undefined): DurableRunStatus | undefined {
  const status = trace?.durable?.status;
  return isDurableRunStatus(status) ? status : undefined;
}

function shouldDeriveResearchDiagnosticsForStep(step: ChatDelegationStepRecord): boolean {
  const label = `${step.role} ${step.label ?? ""}`.toLowerCase();
  return !/\bplanner\b/.test(label);
}

function traceProjectsBlockedCowork(trace: ChatTurnTraceRecord | undefined): boolean {
  if (!trace) {
    return false;
  }
  const diagnosticText = joinDiagnosticText(trace.failure?.message, trace.routing?.fallbackReason);
  if (/\brepeated_tool_loop\b|\bsource_access_blocked\b|\bcandidate_discovery_incomplete\b/i.test(diagnosticText)) {
    return true;
  }
  if (trace.status !== "failed") {
    return false;
  }
  return (
    trace.failure?.failureClass === "tool_loop_guard" ||
    trace.failure?.failureClass === "tool_blocked" ||
    trace.failure?.failureClass === "tool_run_budget_exceeded" ||
    trace.failure?.failureClass === "global_circuit_breaker"
  );
}

function deriveCoworkResearchDiagnostics(input: {
  runId: string;
  sourceId: string;
  sourceLabel: string;
  text: string;
  toolRuns: ChatToolRunRecord[];
  now: string;
}): AgenticDiagnosticSignal[] {
  const codes = inferCoworkResearchDiagnosticCodesFromText(input.text);
  const localBusiness = collectCoworkLocalBusinessResearchMetadata(input.toolRuns);
  if (localBusiness.hasMetadata) {
    if (localBusiness.blockedSourceKeys.size > 0) {
      codes.add("source_access_blocked");
    }
    if (localBusiness.candidateKeys.size === 0) {
      codes.add("candidate_discovery_incomplete");
    }
    if (
      localBusiness.candidateKeys.size > 0 &&
      localBusiness.verifiedCandidateKeys.size === 0 &&
      (localBusiness.blockerKeys.size > 0 ||
        localBusiness.blockedSourceKeys.size > 0 ||
        localBusiness.unresolvedNextStepKeys.size > 0)
    ) {
      codes.add("research_evidence_incomplete");
    }
  }
  return [...codes].map((code) => ({
    signalId: `cowork-${code}-${input.runId}-${input.sourceId}`,
    code,
    severity: code === "source_access_blocked" ? "warning" : "critical",
    title: COWORK_RESEARCH_DIAGNOSTIC_TITLES[code],
    summary: buildCoworkResearchDiagnosticSummary(code, input.sourceLabel, localBusiness),
    evidenceRef: input.sourceId,
    createdAt: input.now,
  }));
}

function buildCoworkResearchDiagnosticSummary(
  code: CoworkResearchDiagnosticCode,
  sourceLabel: string,
  metadata: CoworkLocalBusinessResearchMetadata,
): string {
  if (code === "source_access_blocked") {
    return `${sourceLabel} recorded blocked source access while gathering Cowork research evidence.`;
  }
  if (code === "candidate_discovery_incomplete") {
    return `${sourceLabel} did not produce source-backed research candidates; continue with a narrower source path or operator-approved provider.`;
  }
  const detail =
    metadata.candidateKeys.size > 0
      ? `${metadata.candidateKeys.size} candidate(s), ${metadata.verifiedCandidateKeys.size} verified candidate(s), ${metadata.blockerKeys.size} blocker(s), and ${metadata.unresolvedNextStepKeys.size} unresolved next step(s).`
      : "The handoff reported incomplete research evidence.";
  return `${sourceLabel} has incomplete source-backed evidence: ${detail}`;
}

function inferCoworkResearchDiagnosticCodesFromText(text: string): Set<CoworkResearchDiagnosticCode> {
  const normalized = text.toLowerCase();
  const codes = new Set<CoworkResearchDiagnosticCode>();
  if (normalized.includes("research_evidence_incomplete") || /\bsynthesis incomplete\b/.test(normalized)) {
    codes.add("research_evidence_incomplete");
  }
  if (
    normalized.includes("candidate_discovery_incomplete") ||
    /\b(?:no|zero)\s+(?:source-backed\s+)?candidates?\b/.test(normalized)
  ) {
    codes.add("candidate_discovery_incomplete");
  }
  if (
    normalized.includes("source_access_blocked") ||
    /\b(?:source|host|site)\s+(?:access\s+)?blocked\b/.test(normalized) ||
    /\b(?:blocked automated|not allowlisted|captcha|403)\b/.test(normalized)
  ) {
    codes.add("source_access_blocked");
  }
  return codes;
}

function collectCoworkLocalBusinessResearchMetadata(
  toolRuns: ChatToolRunRecord[],
): CoworkLocalBusinessResearchMetadata {
  const metadata = createEmptyLocalBusinessResearchMetadata();
  for (const run of toolRuns) {
    collectLocalBusinessResearchMetadataFromValue(metadata, run.result, 0);
    if (run.status === "blocked" || run.status === "failed") {
      const failureText = joinDiagnosticText(run.error, run.failureGuidance);
      if (/\b(?:blocked|captcha|403|not allowlisted|access denied)\b/i.test(failureText)) {
        metadata.blockerKeys.add(`tool:${run.toolRunId}:${normalizeDiagnosticKey(failureText)}`);
        metadata.blockedSourceKeys.add(`tool:${run.toolRunId}:${normalizeDiagnosticKey(failureText)}`);
      }
    }
  }
  return metadata;
}

function createEmptyLocalBusinessResearchMetadata(): CoworkLocalBusinessResearchMetadata {
  return {
    hasMetadata: false,
    candidateKeys: new Set<string>(),
    verifiedCandidateKeys: new Set<string>(),
    sourceUrls: new Set<string>(),
    blockerKeys: new Set<string>(),
    blockedSourceKeys: new Set<string>(),
    unresolvedNextStepKeys: new Set<string>(),
  };
}

function collectLocalBusinessResearchMetadataFromValue(
  metadata: CoworkLocalBusinessResearchMetadata,
  value: unknown,
  depth: number,
): void {
  if (depth > 6 || !value) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLocalBusinessResearchMetadataFromValue(metadata, item, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (isLocalBusinessResearchRecord(value)) {
    collectLocalBusinessResearchRecord(metadata, value);
  }
  for (const nested of Object.values(value)) {
    collectLocalBusinessResearchMetadataFromValue(metadata, nested, depth + 1);
  }
}

function isLocalBusinessResearchRecord(value: Record<string, unknown>): boolean {
  return value.kind === "local_business_contact_research" || value.workflow === "local_business.research";
}

function collectLocalBusinessResearchRecord(
  metadata: CoworkLocalBusinessResearchMetadata,
  record: Record<string, unknown>,
): void {
  metadata.hasMetadata = true;
  for (const candidate of readRecordArray(record.candidates)) {
    const key = readString(candidate.storeName) ?? readString(candidate.name) ?? readString(candidate.website);
    const urls = readStringArray(candidate.sourceUrls);
    const candidateKey = key ?? urls[0] ?? JSON.stringify(candidate).slice(0, 120);
    metadata.candidateKeys.add(normalizeDiagnosticKey(candidateKey));
    for (const url of urls) {
      metadata.sourceUrls.add(url);
    }
    addOptionalUrl(metadata.sourceUrls, candidate.website);
    if (readString(candidate.verificationStatus)?.toLowerCase() === "verified") {
      metadata.verifiedCandidateKeys.add(normalizeDiagnosticKey(candidateKey));
    }
    for (const blocker of readStringArray(candidate.blockers)) {
      addLocalBusinessBlocker(metadata, blocker);
    }
    for (const evidence of readRecordArray(candidate.evidence)) {
      addOptionalUrl(metadata.sourceUrls, evidence.url);
      if (readString(evidence.evidenceKind) === "blocked") {
        addLocalBusinessBlockedSource(metadata, readString(evidence.url) ?? readString(evidence.title) ?? "blocked");
      }
    }
  }
  for (const excluded of readRecordArray(record.excluded)) {
    addOptionalUrl(metadata.sourceUrls, excluded.sourceUrl);
    const reason = readString(excluded.reason);
    if (reason) {
      addLocalBusinessBlocker(metadata, reason);
      if (/\bblocked|secondary_listing|403|captcha\b/i.test(reason)) {
        addLocalBusinessBlockedSource(metadata, readString(excluded.sourceUrl) ?? reason);
      }
    }
  }
  for (const stage of readRecordArray(record.stages)) {
    for (const url of readStringArray(stage.sourceUrls)) {
      metadata.sourceUrls.add(url);
    }
    for (const blocker of readStringArray(stage.blockers)) {
      addLocalBusinessBlocker(metadata, blocker);
    }
    if (readString(stage.status) === "blocked") {
      addLocalBusinessBlockedSource(metadata, readString(stage.summary) ?? readString(stage.name) ?? "stage_blocked");
    }
  }
  for (const blocker of readStringArray(record.blockers)) {
    addLocalBusinessBlocker(metadata, blocker);
  }
  for (const nextStep of readUnresolvedNextSteps(record)) {
    metadata.unresolvedNextStepKeys.add(normalizeDiagnosticKey(nextStep));
  }
}

function readUnresolvedNextSteps(record: Record<string, unknown>): string[] {
  return [
    ...readStringArray(record.unresolvedNextSteps),
    ...readStringArray(record.unresolved_next_steps),
    ...readStringArray(record.requiredNextSteps),
    ...readStringArray(record.required_next_steps),
    ...readStringArray(record.nextSteps),
    ...readStringArray(record.next_steps),
    ...readStringArray(record.unresolved),
  ];
}

function addLocalBusinessBlocker(metadata: CoworkLocalBusinessResearchMetadata, blocker: string): void {
  metadata.blockerKeys.add(normalizeDiagnosticKey(blocker));
  if (/\b(?:blocked|403|captcha|not allowlisted|access denied)\b/i.test(blocker)) {
    addLocalBusinessBlockedSource(metadata, blocker);
  }
}

function addLocalBusinessBlockedSource(metadata: CoworkLocalBusinessResearchMetadata, value: string): void {
  metadata.blockedSourceKeys.add(normalizeDiagnosticKey(value));
}

function addOptionalUrl(urls: Set<string>, value: unknown): void {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    urls.add(value);
  }
}

function collectProjectedLocalBusinessResearch(toolRuns: ChatToolRunRecord[]): Record<string, unknown>[] {
  const annotations: Record<string, unknown>[] = [];
  for (const run of toolRuns) {
    collectProjectedLocalBusinessResearchFromValue(annotations, run.result, 0);
  }
  return annotations.slice(0, 8);
}

function collectProjectedLocalBusinessResearchForStep(
  run: ChatDelegationRunRecord,
  step: ChatDelegationStepRecord,
  toolRuns: ChatToolRunRecord[],
): Record<string, unknown>[] {
  const annotations = collectProjectedLocalBusinessResearch(toolRuns);
  const handoffText = joinDiagnosticText(step.output, step.summary);
  if (
    !handoffText ||
    step.status === "pending" ||
    step.status === "running" ||
    !shouldDeriveResearchDiagnosticsForStep(step)
  ) {
    return annotations;
  }
  const handoffAnnotation = buildLocalBusinessResearchAnnotationFromEvidence({
    userContent: run.objective,
    finalAnswer: handoffText,
    citations: step.citations ?? [],
  });
  if (handoffAnnotation) {
    const compacted = compactProjectedLocalBusinessResearchRecord(
      handoffAnnotation as unknown as Record<string, unknown>,
    );
    if (hasSubstantiveProjectedLocalBusinessResearch(compacted)) {
      annotations.push(compacted);
    }
  }
  return dedupeProjectedLocalBusinessResearch(annotations).slice(0, 8);
}

function collectProjectedLocalBusinessResearchFromValue(
  annotations: Record<string, unknown>[],
  value: unknown,
  depth: number,
): void {
  if (depth > 6 || !value || annotations.length >= 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectProjectedLocalBusinessResearchFromValue(annotations, item, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (isLocalBusinessResearchRecord(value)) {
    annotations.push(compactProjectedLocalBusinessResearchRecord(value));
    return;
  }
  for (const nested of Object.values(value)) {
    collectProjectedLocalBusinessResearchFromValue(annotations, nested, depth + 1);
  }
}

function compactProjectedLocalBusinessResearchRecord(record: Record<string, unknown>): Record<string, unknown> {
  return compactRecord({
    kind: record.kind,
    workflow: record.workflow,
    plan: isRecord(record.plan) ? record.plan : undefined,
    stages: readRecordArray(record.stages).slice(0, 8),
    candidates: readRecordArray(record.candidates).slice(0, 20),
    excluded: readRecordArray(record.excluded).slice(0, 20),
    blockers: readStringArray(record.blockers).slice(0, 20),
    verificationNote: readString(record.verificationNote),
  });
}

function hasSubstantiveProjectedLocalBusinessResearch(record: Record<string, unknown>): boolean {
  return (
    readRecordArray(record.candidates).length > 0 ||
    readRecordArray(record.excluded).length > 0 ||
    readRecordArray(record.stages).length > 0 ||
    readStringArray(record.blockers).length > 0
  );
}

function dedupeProjectedLocalBusinessResearch(annotations: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const deduped: Record<string, unknown>[] = [];
  for (const annotation of annotations) {
    const plan = isRecord(annotation.plan) ? annotation.plan : {};
    const key = [
      readString(plan.location) ?? "",
      readString(plan.primaryQuery) ?? "",
      readRecordArray(annotation.candidates)
        .map((candidate) => readString(candidate.storeName) ?? readString(candidate.website) ?? "")
        .join("|"),
      readStringArray(annotation.blockers).join("|"),
    ]
      .join("::")
      .toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(annotation);
  }
  return deduped;
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function joinDiagnosticText(...values: Array<string | undefined>): string {
  return values
    .map((value) => value?.trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeDiagnosticKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 180);
}

function dedupeDiagnostics(diagnostics: AgenticDiagnosticSignal[]): AgenticDiagnosticSignal[] {
  const seen = new Set<string>();
  const deduped: AgenticDiagnosticSignal[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.signalId}:${diagnostic.code}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(diagnostic);
  }
  return deduped;
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

// NOTE: `isTerminalTraceStatus` intentionally excludes `partial` (unlike the
// shared `isChatTurnTerminalStatus`), so it stays local to preserve behavior.
function isTerminalTraceStatus(status: ChatTurnTraceRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function resolveLinkedDurableWorkspaceId(
  durableRun: DurableRunRecord | undefined,
  expected: { sessionId?: string; turnId?: string; taskId?: string },
): string | undefined {
  if (!durableRun || !durablePayloadHasExpectedLink(durableRun.payload, expected)) {
    return undefined;
  }
  return (
    readPayloadWorkspaceId(durableRun.payload) ??
    normalizeOptionalWorkspaceId(readLinkedPayloadString(durableRun.payload, "workspaceId"))
  );
}

function durablePayloadHasExpectedLink(
  payload: Record<string, unknown>,
  expected: { sessionId?: string; turnId?: string; taskId?: string },
): boolean {
  const expectedSessionId = normalizeOptionalWorkspaceId(expected.sessionId);
  const expectedTurnId = normalizeOptionalWorkspaceId(expected.turnId);
  const expectedTaskId = normalizeOptionalWorkspaceId(expected.taskId);
  return (
    Boolean(expectedSessionId && readLinkedPayloadString(payload, "sessionId") === expectedSessionId) ||
    Boolean(expectedTurnId && readLinkedPayloadString(payload, "turnId") === expectedTurnId) ||
    Boolean(expectedTaskId && readLinkedPayloadString(payload, "taskId") === expectedTaskId)
  );
}

function readPayloadWorkspaceId(payload: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalWorkspaceId(readRecordString(payload, "workspaceId")) ??
    normalizeOptionalWorkspaceId(readNestedRecordString(payload, "request", "workspaceId")) ??
    normalizeOptionalWorkspaceId(readNestedRecordString(payload, "payload", "workspaceId"))
  );
}

function readLinkedPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  return (
    normalizeOptionalWorkspaceId(readRecordString(payload, key)) ??
    normalizeOptionalWorkspaceId(readNestedRecordString(payload, "request", key)) ??
    normalizeOptionalWorkspaceId(readNestedRecordString(payload, "payload", key))
  );
}

function readNestedRecordString(payload: Record<string, unknown>, nestedKey: string, key: string): string | undefined {
  const nested = payload[nestedKey];
  return isRecord(nested) ? readRecordString(nested, key) : undefined;
}

function readRecordString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
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
    severity: isDurableRunTerminal(input.durableRun.status) ? "warning" : "info",
    title: "Runtime status projection reconciled",
    summary: `Projection reported ${input.previousStatus}; durable run ${input.durableRun.runId} is ${input.durableRun.status}.`,
    evidenceRef: `durable-run:${input.durableRun.runId}`,
    createdAt: input.now,
  };
}

function buildProjectedControls(status: AgenticRunStatus, durableRunId?: string): AgenticControlDescriptor[] {
  const reason = durableRunId
    ? "Projected Cowork runs are view-only until projected durable-run controls are wired through TaskLifecycleService."
    : "Projected Cowork runs are view-only until they have a task-backed control path.";
  const canCancelOperatorGate = Boolean(durableRunId) && (status === "approval_required" || status === "paused");
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
      enabled: canCancelOperatorGate,
      runtimeEffect: "state_only",
      reason: canCancelOperatorGate
        ? "Projected durable run is waiting at an operator gate; cancel records a visible operator intent."
        : reason,
    },
    {
      action: "retry",
      label: "Continue from gathered evidence",
      enabled:
        status === "failed" ||
        status === "blocked" ||
        status === "cancelled" ||
        status === "checkpointing" ||
        status === "stopped_by_limit",
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

function normalizeOptionalWorkspaceId(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null));
}

function durationMs(startedAt: string, finishedAt: string): number {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  return Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;
}
