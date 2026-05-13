/**
 * Orchestration lifecycle service.
 *
 * Owns orchestration plan/run/phase lifecycle behavior behind an explicit host
 * contract while GatewayService remains the composition root.
 */

import {
  ConflictError,
  type DurableRunCreateRequest,
  type DurableRunRecord,
  type DurableRunTimelineEvent,
  type HookTrigger,
  NotFoundError,
  type OrchestrationPlan,
  type OrchestrationPlanWorkflowPayload,
  type OrchestrationPhase,
  type OrchestrationPhaseExecutionResult,
  type OrchestrationRun,
  type RealtimeEvent,
  ValidationError,
} from "@goatcitadel/contracts";
import type { OrchestrationEngine } from "@goatcitadel/orchestration";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";
import type { DurableWorkflowExecutionContext } from "./durable-execution-service.js";
import {
  applyOrchestrationPhaseHookPatch,
  parseOrchestrationPhaseHookPatch,
  parseOrchestrationRunHookPatch,
} from "./hook-patch-helpers.js";

const DEFAULT_WORKSPACE_ID = "default";
const DEFAULT_WORKTREE_BASE_REF = "HEAD";
const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;

type OrchestrationRunHookPatch = {
  maxIterations?: number;
  maxRuntimeMinutes?: number;
  maxCostUsd?: number;
};

type OrchestrationPhaseHookPatch = {
  ownerAgentId?: string;
  specPath?: string;
  loopMode?: "fresh-context" | "compaction";
  requiresApproval?: boolean;
};

type OrchestrationExecutionResult = {
  outcome: "paused" | "completed" | "failed";
  checkpointState: Record<string, unknown>;
};

export interface OrchestrationLifecycleHost {
  readonly config: {
    assistant: {
      memory: {
        enabled: boolean;
        qmd: {
          applyToOrchestration: boolean;
        };
      };
    };
  };
  readonly storage: {
    orchestration: {
      upsertPlan(plan: OrchestrationPlan): void;
      getPlan(planId: string): OrchestrationPlan;
      createRun(run: OrchestrationRun): OrchestrationRun;
      findLatestRunByPlan(planId: string): OrchestrationRun | undefined;
      updateRun(run: OrchestrationRun): OrchestrationRun;
      updateRunIfCurrentState(
        run: OrchestrationRun,
        expected: Pick<OrchestrationRun, "status" | "executionState">,
      ): OrchestrationRun | undefined;
      appendRunEvent(runId: string, event: string, payload: Record<string, unknown>): void;
      listCheckpoints(runId: string): OrchestrationCheckpoint[];
      getRun(runId: string): OrchestrationRun;
    };
  };
  readonly orchestrationEngine: Pick<
    OrchestrationEngine,
    "advancePhase" | "approvePhase" | "createRun" | "startRun" | "validate"
  >;
  readonly hooksService: {
    runInlineHooks<T extends Record<string, unknown>>(input: {
      workspaceId?: string;
      trigger: HookTrigger;
      entityType: string;
      entityId: string;
      payload: Record<string, unknown>;
      parsePatch?: (value: Record<string, unknown>) => T | undefined;
      mergePatch?: (current: T | undefined, next: T) => T;
    }): Promise<{ blockedBy?: { reason: string }; patch?: T }>;
    enqueueAfterHooks(input: {
      workspaceId?: string;
      trigger: HookTrigger;
      entityType: string;
      entityId: string;
      payload: Record<string, unknown>;
    }): void;
  };
  createCheckpoint(
    input: Omit<OrchestrationCheckpoint, "checkpointId" | "createdAt" | "gitRef">,
  ): OrchestrationCheckpoint;
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
  scheduleOrchestrationMemoryContext(plan: OrchestrationPlan, run: OrchestrationRun): void;
  createDurableRun(input: DurableRunCreateRequest): DurableRunRecord;
  getDurableRun(runId: string): DurableRunRecord;
  requestDurableRunProcessing(runId: string): void;
  pauseDurableRun(runId: string, actorId?: string): DurableRunRecord;
  resumeDurableRun(runId: string, actorId?: string): DurableRunRecord;
  updateDurableRunState(input: {
    runId: string;
    status?: DurableRunRecord["status"];
    metadata?: Record<string, unknown>;
    lastError?: string;
    clearLastError?: boolean;
    finishedAt?: string;
    clearFinishedAt?: boolean;
  }): DurableRunRecord;
  allocateOrchestrationWorktree(input: { runId: string; workspaceId: string; baseRef?: string }): Promise<{
    worktreePath: string;
    worktreeStatus: NonNullable<OrchestrationRun["worktreeStatus"]>;
    worktreeBaseRef: string;
  }>;
  recordDurableTimelineEvent(
    runId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
  ): void;
  executeOrchestrationPhase(input: {
    plan: OrchestrationPlan;
    run: OrchestrationRun;
    phase: OrchestrationPhase;
    durableRun: DurableRunRecord;
    signal?: AbortSignal;
  }): Promise<OrchestrationPhaseExecutionResult>;
  releaseOrchestrationWorktree?(input: {
    run: OrchestrationRun;
    reason: "completed" | "failed" | "stopped_by_limit" | "cancelled";
  }): Promise<void>;
}

function buildOrchestrationRealtimeLinks(input: {
  runId: string;
  workspaceId?: string;
}): NonNullable<RealtimeEvent["links"]> {
  return {
    runId: input.runId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  };
}

function publishOrchestrationRealtime(
  host: OrchestrationLifecycleHost,
  payload: {
    runId: string;
    planId?: string;
    durableRunId?: string;
    workspaceId?: string;
    event: string;
    status: string;
    executionState?: string;
    worktreeStatus?: string;
    worktreePath?: string;
    waveId?: string;
    phaseId?: string;
    approvedBy?: string;
    nextWaveId?: string;
    nextPhaseId?: string;
    error?: string;
  },
): void {
  host.publishRealtime("orchestration_event", "orchestration", payload, {
    eventClass: "domain_fact",
    eventAuthority: "retained_stream",
    links: buildOrchestrationRealtimeLinks({
      runId: payload.runId,
      workspaceId: payload.workspaceId,
    }),
  });
}

function throwIfWorkflowAborted(context?: DurableWorkflowExecutionContext): void {
  if (!context?.signal?.aborted) {
    return;
  }
  throw context.signal.reason instanceof Error
    ? context.signal.reason
    : new Error("Durable orchestration workflow aborted.");
}

async function releaseOrchestrationWorktreeIfAvailable(
  host: OrchestrationLifecycleHost,
  run: OrchestrationRun,
  reason: "completed" | "failed" | "stopped_by_limit" | "cancelled",
): Promise<void> {
  if (!host.releaseOrchestrationWorktree) {
    return;
  }
  try {
    await host.releaseOrchestrationWorktree({ run, reason });
  } catch (error) {
    persistRunEvent(host, run, "run.worktree_cleanup_failed", {
      reason,
      worktreePath: run.worktreePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseOrchestrationWorkflowPayload(run: DurableRunRecord): OrchestrationPlanWorkflowPayload | undefined {
  const payload = run.payload as Partial<OrchestrationPlanWorkflowPayload> | undefined;
  if (!payload || payload.version !== "orchestration.plan.execute.v1") {
    return undefined;
  }
  if (
    typeof payload.orchestrationRunId !== "string" ||
    typeof payload.planId !== "string" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.requestedAt !== "string"
  ) {
    return undefined;
  }
  return payload as OrchestrationPlanWorkflowPayload;
}

function buildDurableMetadata(
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    orchestration: {
      planId: plan.planId,
      runId: run.runId,
      workspaceId: run.workspaceId ?? DEFAULT_WORKSPACE_ID,
      executionState: run.executionState ?? "created",
      worktreePath: run.worktreePath ?? null,
      worktreeStatus: run.worktreeStatus ?? "uninitialized",
      worktreeBaseRef: run.worktreeBaseRef ?? DEFAULT_WORKTREE_BASE_REF,
      currentWaveId: run.currentWaveId ?? null,
      currentPhaseId: run.currentPhaseId ?? null,
      pendingApprovalPhaseId: run.pendingApprovalPhaseId ?? null,
      ...overrides,
    },
  };
}

function buildCheckpointDetails(
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  durableRunId?: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    planState: {
      planId: plan.planId,
      status: run.status,
      currentWaveId: run.currentWaveId ?? null,
      currentPhaseId: run.currentPhaseId ?? null,
      totalIterations: run.totalIterations,
      totalCostUsd: run.totalCostUsd,
    },
    durableWorkerState: {
      durableRunId: durableRunId ?? run.durableRunId ?? null,
      executionState: run.executionState ?? null,
    },
    worktreeState: {
      worktreePath: run.worktreePath ?? null,
      worktreeStatus: run.worktreeStatus ?? null,
      worktreeBaseRef: run.worktreeBaseRef ?? null,
    },
    approvalState: {
      pendingApprovalPhaseId: run.pendingApprovalPhaseId ?? null,
      pendingApprovedBy: run.pendingApprovedBy ?? null,
      pendingCostIncrementUsd: run.pendingCostIncrementUsd ?? null,
    },
    ...extras,
  };
}

function persistCheckpoint(
  host: OrchestrationLifecycleHost,
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  checkpointKind: OrchestrationCheckpoint["checkpointKind"],
  details: Record<string, unknown>,
): void {
  host.createCheckpoint({
    runId: run.runId,
    planId: plan.planId,
    waveId: run.currentWaveId,
    phaseId: run.currentPhaseId,
    checkpointKind,
    details,
  });
}

function persistRunEvent(
  host: OrchestrationLifecycleHost,
  run: OrchestrationRun,
  event: string,
  payload: Record<string, unknown>,
): void {
  host.storage.orchestration.appendRunEvent(run.runId, event, payload);
}

function publishRunRealtime(
  host: OrchestrationLifecycleHost,
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  input: {
    event: string;
    approvedBy?: string;
    nextWaveId?: string;
    nextPhaseId?: string;
    error?: string;
  },
): void {
  publishOrchestrationRealtime(host, {
    runId: run.runId,
    planId: plan.planId,
    durableRunId: run.durableRunId,
    workspaceId: run.workspaceId,
    event: input.event,
    status: run.status,
    executionState: run.executionState,
    worktreeStatus: run.worktreeStatus,
    worktreePath: run.worktreePath,
    waveId: run.currentWaveId,
    phaseId: run.currentPhaseId,
    approvedBy: input.approvedBy,
    nextWaveId: input.nextWaveId,
    nextPhaseId: input.nextPhaseId,
    error: input.error,
  });
}

async function allocateOrchestrationOwnership(
  host: OrchestrationLifecycleHost,
  plan: OrchestrationPlan,
  run: OrchestrationRun,
): Promise<OrchestrationRun> {
  const workspaceId = run.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const durable = host.createDurableRun({
    workflowKey: "orchestration.plan.execute",
    payload: {
      version: "orchestration.plan.execute.v1",
      orchestrationRunId: run.runId,
      planId: plan.planId,
      workspaceId,
      requestedAt: new Date().toISOString(),
    },
    metadata: buildDurableMetadata(plan, run, {
      lifecycleState: "linked",
    }),
  });
  host.pauseDurableRun(durable.runId, "orchestration");
  let linked = host.storage.orchestration.updateRun({
    ...run,
    workspaceId,
    durableRunId: durable.runId,
    executionState: "worktree_allocating",
    worktreeStatus: "allocating",
    worktreeBaseRef: run.worktreeBaseRef ?? DEFAULT_WORKTREE_BASE_REF,
  });

  persistCheckpoint(
    host,
    plan,
    linked,
    "durable_run_linked",
    buildCheckpointDetails(plan, linked, durable.runId, {
      workflowKey: "orchestration.plan.execute",
    }),
  );
  persistRunEvent(host, linked, "run.durable_linked", {
    durableRunId: durable.runId,
    workspaceId,
  });
  publishRunRealtime(host, plan, linked, { event: "durable_run_linked" });

  try {
    const worktree = await host.allocateOrchestrationWorktree({
      runId: linked.runId,
      workspaceId,
      baseRef: linked.worktreeBaseRef ?? DEFAULT_WORKTREE_BASE_REF,
    });
    linked = host.storage.orchestration.updateRun({
      ...linked,
      worktreePath: worktree.worktreePath,
      worktreeStatus: worktree.worktreeStatus,
      worktreeBaseRef: worktree.worktreeBaseRef,
      executionState: "worktree_ready",
    });
    host.updateDurableRunState({
      runId: durable.runId,
      metadata: buildDurableMetadata(plan, linked, {
        lifecycleState: "worktree_ready",
      }),
    });
    persistCheckpoint(host, plan, linked, "worktree_allocated", buildCheckpointDetails(plan, linked, durable.runId));
    persistRunEvent(host, linked, "run.worktree_allocated", {
      worktreePath: linked.worktreePath,
      worktreeStatus: linked.worktreeStatus,
      worktreeBaseRef: linked.worktreeBaseRef,
    });
    publishRunRealtime(host, plan, linked, { event: "worktree_allocated" });
    return linked;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to allocate orchestration worktree.";
    const failed = host.storage.orchestration.updateRun({
      ...linked,
      status: "failed",
      executionState: "failed",
      worktreeStatus: "blocked",
      lastError: message,
      endedAt: new Date().toISOString(),
    });
    host.updateDurableRunState({
      runId: durable.runId,
      status: "failed",
      metadata: buildDurableMetadata(plan, failed, {
        lifecycleState: "worktree_failed",
      }),
      lastError: message,
      finishedAt: failed.endedAt,
    });
    host.recordDurableTimelineEvent(durable.runId, "run_failed", {
      reason: message,
      phase: "worktree_allocation",
    });
    persistCheckpoint(
      host,
      plan,
      failed,
      "run_failed",
      buildCheckpointDetails(plan, failed, durable.runId, {
        error: message,
      }),
    );
    persistRunEvent(host, failed, "run.failed", {
      error: message,
      phase: "worktree_allocation",
    });
    publishRunRealtime(host, plan, failed, { event: "run_failed", error: message });
    return failed;
  }
}

export async function createOrchestrationPlan(
  host: OrchestrationLifecycleHost,
  plan: OrchestrationPlan,
): Promise<OrchestrationRun> {
  host.storage.orchestration.upsertPlan(plan);
  const created = host.orchestrationEngine.createRun(plan);
  const persisted = host.storage.orchestration.createRun({
    ...created,
    workspaceId: DEFAULT_WORKSPACE_ID,
    executionState: "created",
    worktreeStatus: "uninitialized",
    worktreeBaseRef: DEFAULT_WORKTREE_BASE_REF,
  });

  persistCheckpoint(host, plan, persisted, "run_created", buildCheckpointDetails(plan, persisted));
  persistRunEvent(host, persisted, "run.created", {
    status: persisted.status,
    executionState: persisted.executionState,
  });
  publishRunRealtime(host, plan, persisted, { event: "run_created" });

  return allocateOrchestrationOwnership(host, plan, persisted);
}

export async function runOrchestrationPlan(
  host: OrchestrationLifecycleHost,
  planId: string,
): Promise<OrchestrationRun> {
  let plan = host.storage.orchestration.getPlan(planId);
  host.orchestrationEngine.validate(plan);
  const run = await createOrchestrationPlan(host, plan);
  if (run.status === "failed") {
    return run;
  }

  const runBeforeHook = await host.hooksService.runInlineHooks<OrchestrationRunHookPatch>({
    workspaceId: run.workspaceId ?? DEFAULT_WORKSPACE_ID,
    trigger: "orchestration.run.before",
    entityType: "orchestration_run",
    entityId: run.runId,
    payload: {
      planId: plan.planId,
      goal: plan.goal,
      maxIterations: plan.maxIterations,
      maxRuntimeMinutes: plan.maxRuntimeMinutes,
      maxCostUsd: plan.maxCostUsd,
    },
    parsePatch: (value) => parseOrchestrationRunHookPatch(value),
    mergePatch: (current, next) => ({
      ...(current ?? {}),
      ...next,
    }),
  });
  if (runBeforeHook.blockedBy) {
    throw new Error(runBeforeHook.blockedBy.reason);
  }
  if (runBeforeHook.patch) {
    plan = {
      ...plan,
      ...(runBeforeHook.patch.maxIterations !== undefined ? { maxIterations: runBeforeHook.patch.maxIterations } : {}),
      ...(runBeforeHook.patch.maxRuntimeMinutes !== undefined
        ? { maxRuntimeMinutes: runBeforeHook.patch.maxRuntimeMinutes }
        : {}),
      ...(runBeforeHook.patch.maxCostUsd !== undefined ? { maxCostUsd: runBeforeHook.patch.maxCostUsd } : {}),
    };
    host.orchestrationEngine.validate(plan);
    host.storage.orchestration.upsertPlan(plan);
  }

  const queued = host.storage.orchestration.updateRun({
    ...run,
    executionState: "queued",
  });
  host.resumeDurableRun(queued.durableRunId!, "orchestration");
  host.updateDurableRunState({
    runId: queued.durableRunId!,
    metadata: buildDurableMetadata(plan, queued, {
      lifecycleState: "queued",
    }),
  });
  persistCheckpoint(host, plan, queued, "run_queued", buildCheckpointDetails(plan, queued));
  persistRunEvent(host, queued, "run.queued", {
    durableRunId: queued.durableRunId,
    worktreePath: queued.worktreePath,
  });
  publishRunRealtime(host, plan, queued, { event: "run_queued" });

  if (host.config.assistant.memory.enabled && host.config.assistant.memory.qmd.applyToOrchestration) {
    host.scheduleOrchestrationMemoryContext(plan, queued);
  }

  if (queued.durableRunId) {
    host.requestDurableRunProcessing(queued.durableRunId);
  }

  return queued;
}

export async function approvePhase(
  host: OrchestrationLifecycleHost,
  runId: string,
  phaseId: string,
  approvedBy: string,
  costIncrementUsd = 0,
  workspaceId?: string,
): Promise<{ run: OrchestrationRun; checkpoints: OrchestrationCheckpoint[] }> {
  const run = assertRunWorkspaceAccess(host.storage.orchestration.getRun(runId), workspaceId);
  let plan = host.storage.orchestration.getPlan(run.planId);
  host.orchestrationEngine.validate(plan);
  const currentPhase = findPhaseInPlan(plan, phaseId);

  if (run.status !== "paused") {
    throw new Error(`Run ${run.runId} is not waiting for approval: ${run.status}`);
  }
  if (run.currentPhaseId !== phaseId) {
    throw new Error(
      `Run ${run.runId} expected phase ${run.currentPhaseId ?? "<none>"} but received approval for ${phaseId}`,
    );
  }
  if (plan.mode !== "hitl" && !currentPhase.requiresApproval) {
    throw new Error(`Phase ${phaseId} is not approval-gated for run ${runId}`);
  }

  const phaseBeforeHook = await host.hooksService.runInlineHooks<OrchestrationPhaseHookPatch>({
    workspaceId: run.workspaceId ?? DEFAULT_WORKSPACE_ID,
    trigger: "orchestration.phase.before",
    entityType: "orchestration_phase",
    entityId: `${runId}:${phaseId}`,
    payload: {
      runId,
      phaseId,
      approvedBy,
      costIncrementUsd,
    },
    parsePatch: (value) => parseOrchestrationPhaseHookPatch(value),
    mergePatch: (current, next) => ({
      ...(current ?? {}),
      ...next,
    }),
  });
  if (phaseBeforeHook.blockedBy) {
    throw new Error(phaseBeforeHook.blockedBy.reason);
  }
  if (phaseBeforeHook.patch) {
    plan = applyOrchestrationPhaseHookPatch(plan, phaseId, phaseBeforeHook.patch);
    host.orchestrationEngine.validate(plan);
    host.storage.orchestration.upsertPlan(plan);
    const patchedPhase = findPhaseInPlan(plan, phaseId);
    if (plan.mode !== "hitl" && !patchedPhase.requiresApproval) {
      throw new Error(`Phase ${phaseId} is not approval-gated for run ${runId}`);
    }
  }

  const nextRun: OrchestrationRun = {
    ...run,
    executionState: "resume_requested",
    pendingApprovalPhaseId: phaseId,
    pendingApprovedBy: approvedBy,
    pendingCostIncrementUsd: costIncrementUsd,
  };
  const persisted = host.storage.orchestration.updateRunIfCurrentState(nextRun, {
    status: run.status,
    executionState: run.executionState,
  });
  if (!persisted) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `Run ${run.runId} approval was already requested or the run state changed.`,
      details: { runId: run.runId, phaseId },
    });
  }

  if (persisted.durableRunId) {
    host.updateDurableRunState({
      runId: persisted.durableRunId,
      metadata: buildDurableMetadata(plan, persisted, {
        lifecycleState: "resume_requested",
      }),
    });
  }

  persistCheckpoint(
    host,
    plan,
    persisted,
    "phase_approved",
    buildCheckpointDetails(plan, persisted, undefined, {
      approvedBy,
    }),
  );
  persistRunEvent(host, persisted, "phase.approved", {
    approvedBy,
    phaseId,
    resumeRequested: true,
  });
  publishRunRealtime(host, plan, persisted, { event: "phase_approved", approvedBy });

  host.hooksService.enqueueAfterHooks({
    workspaceId: persisted.workspaceId ?? DEFAULT_WORKSPACE_ID,
    trigger: "orchestration.phase.after",
    entityType: "orchestration_phase",
    entityId: `${runId}:${phaseId}`,
    payload: {
      runId,
      planId: plan.planId,
      phaseId,
      approvedBy,
      status: persisted.status,
      currentWaveId: persisted.currentWaveId,
      currentPhaseId: persisted.currentPhaseId,
      executionState: persisted.executionState,
    },
  });

  if (persisted.durableRunId) {
    host.resumeDurableRun(persisted.durableRunId, "orchestration");
    host.requestDurableRunProcessing(persisted.durableRunId);
  }

  return {
    run: persisted,
    checkpoints: host.storage.orchestration.listCheckpoints(runId),
  };
}

export async function executeDurableOrchestrationRun(
  host: OrchestrationLifecycleHost,
  durableRun: DurableRunRecord,
  context?: DurableWorkflowExecutionContext,
): Promise<OrchestrationExecutionResult> {
  throwIfWorkflowAborted(context);
  const payload = parseOrchestrationWorkflowPayload(durableRun);
  if (!payload) {
    throw new Error("Durable orchestration payload is invalid or incomplete.");
  }
  const plan = host.storage.orchestration.getPlan(payload.planId);
  host.orchestrationEngine.validate(plan);
  let run = host.storage.orchestration.getRun(payload.orchestrationRunId);
  if (run.durableRunId !== durableRun.runId) {
    throw new Error(`Orchestration run ${run.runId} is not linked to durable run ${durableRun.runId}.`);
  }

  const recordUpdate = (
    next: OrchestrationRun,
    checkpointKind?: OrchestrationCheckpoint["checkpointKind"],
    checkpointExtras: Record<string, unknown> = {},
  ): void => {
    run = host.storage.orchestration.updateRun(next);
    host.updateDurableRunState({
      runId: durableRun.runId,
      metadata: buildDurableMetadata(plan, run),
    });
    if (checkpointKind) {
      persistCheckpoint(
        host,
        plan,
        run,
        checkpointKind,
        buildCheckpointDetails(plan, run, durableRun.runId, checkpointExtras),
      );
    }
  };

  if (run.executionState === "resume_requested") {
    if (!run.pendingApprovalPhaseId || !run.pendingApprovedBy) {
      throw new Error(`Run ${run.runId} is missing pending approval state for durable resume.`);
    }
    recordUpdate(
      {
        ...host.orchestrationEngine.approvePhase(plan, run, run.pendingApprovalPhaseId, {
          costIncrementUsd: run.pendingCostIncrementUsd ?? 0,
        }),
        executionState: "running",
        pendingApprovalPhaseId: undefined,
        pendingApprovedBy: undefined,
        pendingCostIncrementUsd: undefined,
        lastError: undefined,
      },
      "run_resumed",
    );
    host.recordDurableTimelineEvent(durableRun.runId, "run_resumed", {
      phaseId: run.currentPhaseId,
      waveId: run.currentWaveId,
    });
    persistRunEvent(host, run, "run.resumed", {
      phaseId: run.currentPhaseId,
      waveId: run.currentWaveId,
    });
    publishRunRealtime(host, plan, run, { event: "run_resumed" });
  } else {
    recordUpdate(
      {
        ...host.orchestrationEngine.startRun(plan, run),
        executionState: "running",
        lastError: undefined,
      },
      "run_started",
    );
    host.recordDurableTimelineEvent(durableRun.runId, "run_started", {
      phaseId: run.currentPhaseId,
      waveId: run.currentWaveId,
    });
    persistRunEvent(host, run, "run.started", {
      phaseId: run.currentPhaseId,
      waveId: run.currentWaveId,
    });
    publishRunRealtime(host, plan, run, { event: "run_started" });
  }

  while (run.status === "running" && run.currentPhaseId) {
    throwIfWorkflowAborted(context);
    const previousWaveId = run.currentWaveId;
    const previousPhaseId = run.currentPhaseId;
    const phase = findPhaseInPlan(plan, previousPhaseId);
    persistRunEvent(host, run, "phase.started", {
      phaseId: previousPhaseId,
      waveId: previousWaveId,
      ownerAgentId: phase.ownerAgentId,
      specPath: phase.specPath,
    });
    publishRunRealtime(host, plan, run, {
      event: "phase_started",
    });

    const execution = await host.executeOrchestrationPhase({
      plan,
      run,
      phase,
      durableRun,
      signal: context?.signal,
    });
    const executionPayload = {
      phaseId: execution.phaseId,
      ownerAgentId: execution.ownerAgentId,
      status: execution.status,
      startedAt: execution.startedAt,
      finishedAt: execution.finishedAt,
      outputSummary: execution.outputSummary,
      childSessionId: execution.childSessionId,
      childTurnId: execution.childTurnId,
      childRunId: execution.childRunId,
      responseId: execution.responseId,
      model: execution.model,
      costUsd: execution.costUsd ?? 0,
      inputTokens: execution.inputTokens,
      outputTokens: execution.outputTokens,
      citations: execution.citations,
      artifacts: execution.artifacts,
      error: execution.error,
    };
    persistRunEvent(host, run, execution.status === "failed" ? "phase.failed" : "phase.executed", executionPayload);

    if (execution.status === "failed") {
      recordUpdate(
        {
          ...run,
          status: "failed",
          executionState: "failed",
          endedAt: execution.finishedAt,
          lastError: execution.error ?? `Phase ${previousPhaseId} failed.`,
        },
        "run_failed",
        {
          failedPhase: executionPayload,
        },
      );
      host.recordDurableTimelineEvent(durableRun.runId, "run_failed", {
        phaseId: previousPhaseId,
        error: execution.error ?? `Phase ${previousPhaseId} failed.`,
      });
      publishRunRealtime(host, plan, run, {
        event: "run_failed",
        error: execution.error ?? `Phase ${previousPhaseId} failed.`,
      });
      await releaseOrchestrationWorktreeIfAvailable(host, run, "failed");
      return {
        outcome: "failed",
        checkpointState: buildCheckpointDetails(plan, run, durableRun.runId, {
          failedPhase: executionPayload,
        }),
      };
    }

    recordUpdate(
      {
        ...host.orchestrationEngine.advancePhase(plan, run, previousPhaseId, {
          costIncrementUsd: execution.costUsd ?? 0,
        }),
        executionState: "running",
      },
      "phase_executed",
      {
        executedPhase: executionPayload,
      },
    );
    persistRunEvent(host, run, "phase.advanced", {
      phaseId: previousPhaseId,
      nextPhaseId: run.currentPhaseId,
      nextWaveId: run.currentWaveId,
      costIncrementUsd: execution.costUsd ?? 0,
      totalCostUsd: run.totalCostUsd,
    });
    publishRunRealtime(host, plan, run, {
      event: "phase_executed",
      nextWaveId: run.currentWaveId,
      nextPhaseId: run.currentPhaseId,
    });
    if (previousWaveId !== run.currentWaveId && run.currentWaveId) {
      persistCheckpoint(
        host,
        plan,
        run,
        "wave_advanced",
        buildCheckpointDetails(plan, run, durableRun.runId, {
          fromWave: previousWaveId,
          toWave: run.currentWaveId,
        }),
      );
    }
  }

  if (run.status === "paused") {
    recordUpdate(
      {
        ...run,
        executionState: "paused_for_approval",
      },
      "run_paused_for_approval",
    );
    host.pauseDurableRun(durableRun.runId, "orchestration");
    persistRunEvent(host, run, "run.paused_for_approval", {
      phaseId: run.currentPhaseId,
      waveId: run.currentWaveId,
    });
    publishRunRealtime(host, plan, run, { event: "run_paused_for_approval" });
    return {
      outcome: "paused",
      checkpointState: buildCheckpointDetails(plan, run, durableRun.runId),
    };
  }

  const terminalExecutionState = run.status === "stopped_by_limit" ? "stopped_by_limit" : "completed";
  recordUpdate(
    {
      ...run,
      executionState: terminalExecutionState,
    },
    run.status === "stopped_by_limit" ? "run_stopped" : "run_completed",
  );
  persistRunEvent(host, run, run.status === "stopped_by_limit" ? "run.stopped" : "run.completed", {
    totalIterations: run.totalIterations,
    totalCostUsd: run.totalCostUsd,
  });
  publishRunRealtime(host, plan, run, {
    event: run.status === "stopped_by_limit" ? "run_stopped" : "run_completed",
  });
  await releaseOrchestrationWorktreeIfAvailable(
    host,
    run,
    run.status === "stopped_by_limit" ? "stopped_by_limit" : "completed",
  );
  return {
    outcome: "completed",
    checkpointState: buildCheckpointDetails(plan, run, durableRun.runId),
  };
}

function findPhaseInPlan(plan: OrchestrationPlan, phaseId: string) {
  for (const wave of plan.waves) {
    const phase = wave.phases.find((candidate) => candidate.phaseId === phaseId);
    if (phase) {
      return phase;
    }
  }
  throw new Error(`Phase ${phaseId} not found in plan ${plan.planId}`);
}

export function getRun(host: OrchestrationLifecycleHost, runId: string, workspaceId?: string): OrchestrationRun {
  return assertRunWorkspaceAccess(host.storage.orchestration.getRun(runId), workspaceId);
}

export function listRunCheckpoints(
  host: OrchestrationLifecycleHost,
  runId: string,
  workspaceId?: string,
): OrchestrationCheckpoint[] {
  assertRunWorkspaceAccess(host.storage.orchestration.getRun(runId), workspaceId);
  return host.storage.orchestration.listCheckpoints(runId);
}

function assertRunWorkspaceAccess(run: OrchestrationRun, workspaceId?: string): OrchestrationRun {
  const expectedWorkspaceId = normalizeRouteWorkspaceId(workspaceId);
  const actualWorkspaceId = normalizeRouteWorkspaceId(run.workspaceId);
  if (actualWorkspaceId !== expectedWorkspaceId) {
    throw new NotFoundError({ entity: "Orchestration run", id: run.runId });
  }
  return run;
}

function normalizeRouteWorkspaceId(workspaceId?: string): string {
  if (!workspaceId?.trim()) {
    return DEFAULT_WORKSPACE_ID;
  }
  const normalized = workspaceId.trim();
  if (!WORKSPACE_ID_PATTERN.test(normalized)) {
    throw new ValidationError({ field: "workspaceId", message: "workspaceId contains unsupported characters" });
  }
  return normalized;
}
