/* eslint-disable max-lines */
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
  type OrchestrationDecisionEvent,
  type OrchestrationDecisionKind,
  type OrchestrationDecisionTrace,
  type OrchestrationPhase,
  type OrchestrationPhaseChildDispatch,
  type OrchestrationPhaseExecutionResult,
  type OrchestrationRun,
  type OrchestrationRunEventRecord,
  type OrchestrationRunPolicyContext,
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
import {
  buildCheckpointDetails,
  buildDurableMetadata,
  parseOrchestrationWorkflowPayload,
} from "./orchestration-lifecycle-state-helpers.js";
import { publishOrchestrationRealtime, throwIfWorkflowAborted } from "./orchestration-realtime-helpers.js";

export { parseOrchestrationWorkflowPayload } from "./orchestration-lifecycle-state-helpers.js";

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
  outcome: "paused" | "completed" | "failed" | "cancelled";
  checkpointState: Record<string, unknown>;
};

export interface OrchestrationLifecycleRuntimeDeps {
  readonly worktrees: {
    allocate(input: { runId: string; workspaceId: string; baseRef?: string }): Promise<{
      worktreePath: string;
      worktreeStatus: NonNullable<OrchestrationRun["worktreeStatus"]>;
      worktreeBaseRef: string;
    }>;
    release(input: {
      run: OrchestrationRun;
      reason: "completed" | "failed" | "stopped_by_limit" | "cancelled";
    }): Promise<void>;
  };
  readonly phaseExecutor: {
    execute(input: {
      plan: OrchestrationPlan;
      run: OrchestrationRun;
      phase: OrchestrationPhase;
      durableRun: DurableRunRecord;
      policyContext?: OrchestrationRunPolicyContext;
      signal?: AbortSignal;
      onChildDispatched?: (dispatch: OrchestrationPhaseChildDispatch) => void;
    }): Promise<OrchestrationPhaseExecutionResult>;
  };
}

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
    runImmediateTransaction<T>(callback: () => T): T;
    orchestration: {
      upsertPlan(plan: OrchestrationPlan, workspaceId?: string): void;
      getPlan(planId: string, workspaceId?: string): OrchestrationPlan;
      createRun(run: OrchestrationRun): OrchestrationRun;
      findLatestRunByPlan(planId: string): OrchestrationRun | undefined;
      findActiveRunByPlan(planId: string, workspaceId?: string): OrchestrationRun | undefined;
      updateRun(run: OrchestrationRun): OrchestrationRun;
      updateRunIfCurrentState(
        run: OrchestrationRun,
        expected: Pick<OrchestrationRun, "status" | "executionState">,
      ): OrchestrationRun | undefined;
      appendRunEvent(runId: string, event: string, payload: Record<string, unknown>): void;
      listCheckpoints(runId: string): OrchestrationCheckpoint[];
      listRunEvents?(runId: string): OrchestrationRunEventRecord[];
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
  cancelDurableRun(runId: string, actorId?: string): DurableRunRecord;
  updateDurableRunState(input: {
    runId: string;
    status?: DurableRunRecord["status"];
    metadata?: Record<string, unknown>;
    lastError?: string;
    clearLastError?: boolean;
    finishedAt?: string;
    clearFinishedAt?: boolean;
  }): DurableRunRecord;
  recordDurableTimelineEvent(
    runId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
  ): void;
}

async function releaseOrchestrationWorktreeIfAvailable(
  runtime: OrchestrationLifecycleRuntimeDeps,
  host: OrchestrationLifecycleHost,
  run: OrchestrationRun,
  reason: "completed" | "failed" | "stopped_by_limit" | "cancelled",
): Promise<void> {
  try {
    await runtime.worktrees.release({ run, reason });
  } catch (error) {
    persistRunEvent(host, run, "run.worktree_cleanup_failed", {
      reason,
      worktreePath: run.worktreePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isOrchestrationRunTerminal(run: OrchestrationRun): boolean {
  return ["completed", "failed", "stopped_by_limit", "cancelled"].includes(run.status);
}

function isDurableRunTerminal(run: DurableRunRecord): boolean {
  return ["completed", "failed", "cancelled", "dead_lettered"].includes(run.status);
}

function isWorkflowAbort(error: unknown, context?: DurableWorkflowExecutionContext): boolean {
  if (context?.signal?.aborted) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || error.name === "OrchestrationWorkflowAbortedError";
}

async function markOrchestrationRunCancelled(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  actorId: string,
  reason: string,
): Promise<OrchestrationRun> {
  if (isOrchestrationRunTerminal(run)) {
    return run;
  }
  const cancelled = host.storage.orchestration.updateRun({
    ...run,
    status: "cancelled",
    executionState: "cancelled",
    endedAt: new Date().toISOString(),
    lastError: reason,
    pendingApprovalPhaseId: undefined,
    pendingApprovedBy: undefined,
    pendingCostIncrementUsd: undefined,
  });
  if (cancelled.durableRunId) {
    const durable = host.getDurableRun(cancelled.durableRunId);
    if (!["completed", "failed", "cancelled", "dead_lettered"].includes(durable.status)) {
      host.cancelDurableRun(cancelled.durableRunId, actorId);
      host.updateDurableRunState({
        runId: cancelled.durableRunId,
        metadata: buildDurableMetadata(plan, cancelled, {
          lifecycleState: "cancelled",
        }),
      });
    } else {
      host.updateDurableRunState({
        runId: cancelled.durableRunId,
        metadata: buildDurableMetadata(plan, cancelled, {
          lifecycleState: "cancelled",
        }),
      });
      host.recordDurableTimelineEvent(cancelled.durableRunId, "run_cancelled", {
        actorId,
        reason,
        orchestrationRunId: cancelled.runId,
      });
    }
  }
  persistCheckpoint(
    host,
    plan,
    cancelled,
    "run_cancelled",
    buildCheckpointDetails(plan, cancelled, cancelled.durableRunId, {
      actorId,
      reason,
    }),
  );
  persistRunEvent(host, cancelled, "run.cancelled", {
    actorId,
    reason,
  });
  publishRunRealtime(host, plan, cancelled, {
    event: "run_cancelled",
    error: reason,
  });
  await releaseOrchestrationWorktreeIfAvailable(runtime, host, cancelled, "cancelled");
  return cancelled;
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
  runtime: OrchestrationLifecycleRuntimeDeps,
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
      operatorId: run.operatorId,
      authActorId: run.authActorId,
      authActorSource: run.authActorSource,
      permissionProfileId: run.permissionProfileId,
      localOperatorOverrideId: run.localOperatorOverrideId,
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
    const worktree = await runtime.worktrees.allocate({
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

/**
 * Atomically reserves the single active run row for a plan.
 *
 * ORCH-001: two concurrent starts for the same plan/workspace can both observe
 * "no active run" and each insert a run, producing duplicate worktrees and
 * doubled cost. To close that race, the active-run re-check and the run-row
 * insert are performed together inside a single synchronous IMMEDIATE
 * transaction. The transaction callback must stay synchronous and side-effect
 * free with respect to the filesystem / git / durable worker — worktree
 * allocation and durable-run setup happen OUTSIDE the transaction.
 *
 * Returns `{ created: false }` with the pre-existing active run when the guard
 * detects a concurrently (or previously) created run, so callers can behave
 * idempotently instead of duplicating work.
 */
function createOrchestrationRunRecord(
  host: OrchestrationLifecycleHost,
  plan: OrchestrationPlan,
  workspaceId: string,
  policyContext: OrchestrationRunPolicyContext,
): { created: boolean; run: OrchestrationRun } {
  // `upsertPlan` is idempotent on (planId, workspaceId) and `engine.createRun`
  // is a pure computation, so both can run outside the transaction.
  host.storage.orchestration.upsertPlan(plan, workspaceId);
  const candidate = host.orchestrationEngine.createRun(plan);

  return host.storage.runImmediateTransaction(() => {
    const existing = host.storage.orchestration.findActiveRunByPlan(plan.planId, workspaceId);
    if (existing) {
      return { created: false, run: existing };
    }
    const persisted = host.storage.orchestration.createRun({
      ...candidate,
      ...policyContext,
      workspaceId,
      executionState: "created",
      worktreeStatus: "uninitialized",
      worktreeBaseRef: DEFAULT_WORKTREE_BASE_REF,
    });
    return { created: true, run: persisted };
  });
}

export async function createOrchestrationPlan(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  plan: OrchestrationPlan,
  policyContext: OrchestrationRunPolicyContext = {},
): Promise<OrchestrationRun> {
  const workspaceId = normalizeRouteWorkspaceId(policyContext.workspaceId);
  const { created, run } = createOrchestrationRunRecord(host, plan, workspaceId, policyContext);
  if (!created) {
    // A run for this plan/workspace is already active; return it idempotently
    // rather than allocating a second worktree / durable run.
    return run;
  }

  return finishOrchestrationRunCreation(host, runtime, plan, run);
}

export async function runOrchestrationPlan(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  planId: string,
  policyContext: OrchestrationRunPolicyContext = {},
): Promise<OrchestrationRun> {
  const workspaceId = normalizeRouteWorkspaceId(policyContext.workspaceId);
  const plan = host.storage.orchestration.getPlan(planId, workspaceId);
  host.orchestrationEngine.validate(plan);
  const activeRun = host.storage.orchestration.findActiveRunByPlan(planId, workspaceId);
  if (activeRun) {
    return resumeExistingActiveRun(host, plan, activeRun);
  }

  const { created, run } = createOrchestrationRunRecord(host, plan, workspaceId, policyContext);
  if (!created) {
    // Lost the create race to a concurrent start: adopt the active run the
    // winner inserted instead of queueing a second durable run.
    return resumeExistingActiveRun(host, plan, run);
  }

  const allocated = await finishOrchestrationRunCreation(host, runtime, plan, run);
  if (allocated.status === "failed") {
    return allocated;
  }

  return queueOrchestrationRun(host, plan, allocated);
}

/**
 * Emits the `run_created` lifecycle truth for a freshly inserted run and then
 * allocates its durable-run + worktree ownership (the async work that must stay
 * outside the run-reservation transaction).
 */
async function finishOrchestrationRunCreation(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  plan: OrchestrationPlan,
  run: OrchestrationRun,
): Promise<OrchestrationRun> {
  persistCheckpoint(host, plan, run, "run_created", buildCheckpointDetails(plan, run));
  persistRunEvent(host, run, "run.created", {
    status: run.status,
    executionState: run.executionState,
  });
  publishRunRealtime(host, plan, run, { event: "run_created" });

  return allocateOrchestrationOwnership(host, runtime, plan, run);
}

/**
 * Idempotently nudges an already-active run for a plan toward execution:
 * requeue a worktree-ready run, request processing for a queued run, or simply
 * return the active run unchanged. Shared by the fast-path active check and the
 * concurrent-create loser path so both behave identically.
 */
function resumeExistingActiveRun(
  host: OrchestrationLifecycleHost,
  plan: OrchestrationPlan,
  activeRun: OrchestrationRun,
): OrchestrationRun | Promise<OrchestrationRun> {
  if (activeRun.durableRunId && activeRun.executionState === "queued") {
    host.requestDurableRunProcessing(activeRun.durableRunId);
  }
  if (activeRun.durableRunId && activeRun.executionState === "worktree_ready") {
    return queueOrchestrationRun(host, plan, activeRun);
  }
  return activeRun;
}

async function queueOrchestrationRun(
  host: OrchestrationLifecycleHost,
  planInput: OrchestrationPlan,
  run: OrchestrationRun,
): Promise<OrchestrationRun> {
  let plan = planInput;
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
    host.storage.orchestration.upsertPlan(plan, run.workspaceId ?? DEFAULT_WORKSPACE_ID);
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
  let plan = host.storage.orchestration.getPlan(run.planId, run.workspaceId ?? DEFAULT_WORKSPACE_ID);
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
    const patchedPhase = findPhaseInPlan(plan, phaseId);
    if (plan.mode !== "hitl" && !patchedPhase.requiresApproval) {
      throw new Error(`Phase ${phaseId} is not approval-gated for run ${runId}`);
    }
    host.storage.orchestration.upsertPlan(plan, run.workspaceId ?? DEFAULT_WORKSPACE_ID);
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

export async function cancelOrchestrationRun(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  runId: string,
  actorId = "operator",
  workspaceId?: string,
): Promise<{ run: OrchestrationRun; checkpoints: OrchestrationCheckpoint[] }> {
  const run = assertRunWorkspaceAccess(host.storage.orchestration.getRun(runId), workspaceId);
  const plan = host.storage.orchestration.getPlan(run.planId, run.workspaceId ?? DEFAULT_WORKSPACE_ID);
  host.orchestrationEngine.validate(plan);
  const cancelled = await markOrchestrationRunCancelled(host, runtime, plan, run, actorId, `cancelled by ${actorId}`);
  return {
    run: cancelled,
    checkpoints: host.storage.orchestration.listCheckpoints(runId),
  };
}

export async function executeDurableOrchestrationRun(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  durableRun: DurableRunRecord,
  context?: DurableWorkflowExecutionContext,
): Promise<OrchestrationExecutionResult> {
  throwIfWorkflowAborted(context);
  const payload = parseOrchestrationWorkflowPayload(durableRun);
  if (!payload) {
    const malformedWorkspacePayload = readMalformedWorkspacePayload(durableRun);
    if (malformedWorkspacePayload) {
      const run = host.storage.orchestration.getRun(malformedWorkspacePayload.orchestrationRunId);
      if (run.durableRunId !== durableRun.runId) {
        throw new Error(`Orchestration run ${run.runId} is not linked to durable run ${durableRun.runId}.`);
      }
      const runWorkspaceId = normalizeRouteWorkspaceId(run.workspaceId);
      const mismatchError = `Durable orchestration payload workspace ${malformedWorkspacePayload.payloadWorkspaceId} is invalid for run ${run.runId}: workspaceId must be a string.`;
      return failDurableOrchestrationWorkspaceMismatch({
        host,
        runtime,
        durableRun,
        run,
        planId: malformedWorkspacePayload.planId,
        payloadWorkspaceId: malformedWorkspacePayload.payloadWorkspaceId,
        runWorkspaceId,
        error: mismatchError,
      });
    }
    throw new Error("Durable orchestration payload is invalid or incomplete.");
  }
  let run = host.storage.orchestration.getRun(payload.orchestrationRunId);
  if (run.durableRunId !== durableRun.runId) {
    throw new Error(`Orchestration run ${run.runId} is not linked to durable run ${durableRun.runId}.`);
  }
  const runWorkspaceId = normalizeRouteWorkspaceId(run.workspaceId);
  let payloadWorkspaceId: string;
  try {
    payloadWorkspaceId = normalizeRouteWorkspaceId(payload.workspaceId);
  } catch (error) {
    const mismatchError = `Durable orchestration payload workspace ${payload.workspaceId} is invalid for run ${run.runId}: ${
      error instanceof Error ? error.message : String(error)
    }.`;
    return failDurableOrchestrationWorkspaceMismatch({
      host,
      runtime,
      durableRun,
      run,
      planId: payload.planId,
      payloadWorkspaceId: payload.workspaceId,
      runWorkspaceId,
      error: mismatchError,
    });
  }
  if (payloadWorkspaceId !== runWorkspaceId) {
    const mismatchError = `Durable orchestration payload workspace ${payloadWorkspaceId} does not match run ${run.runId} workspace ${runWorkspaceId}.`;
    return failDurableOrchestrationWorkspaceMismatch({
      host,
      runtime,
      durableRun,
      run,
      planId: payload.planId,
      payloadWorkspaceId,
      runWorkspaceId,
      error: mismatchError,
    });
  }
  const plan = host.storage.orchestration.getPlan(payload.planId, runWorkspaceId);
  host.orchestrationEngine.validate(plan);
  const policyContext: OrchestrationRunPolicyContext = {
    operatorId: payload.operatorId ?? run.operatorId,
    authActorId: payload.authActorId ?? run.authActorId,
    authActorSource: payload.authActorSource ?? run.authActorSource,
    permissionProfileId: payload.permissionProfileId ?? run.permissionProfileId,
    localOperatorOverrideId: payload.localOperatorOverrideId ?? run.localOperatorOverrideId,
  };

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
  let harvestedWaitingExecution: OrchestrationPhaseExecutionResult | undefined;

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
  } else if (run.status === "running" && run.currentPhaseId) {
    const resumedFrom = run.executionState;
    // A phase that was already dispatched (approval wait OR an ordinary
    // in-flight child turn that crashed mid-execution) carries a linkage
    // breadcrumb in the durable metadata. We MUST harvest/reattach that child
    // instead of re-dispatching it (ORCH-002 hard invariant: a phase with an
    // already-dispatched child is never re-dispatched on resume).
    const recoverableChildPhase = readRecoverableChildPhase(durableRun, run.currentPhaseId);
    const isApprovalResume = resumedFrom === "paused_for_approval";
    if (recoverableChildPhase) {
      const childRunId = recoverableChildPhase.childRunId;
      if (!childRunId) {
        // The phase dispatched a child whose durable run id was never recorded
        // (e.g. durable execution was disabled and the child ran inline, so its
        // state died with the parent). We cannot safely harvest or reattach it,
        // so fail the phase recoverably rather than blindly re-running it.
        const unlinkedChildError = `Orchestration phase ${run.currentPhaseId} dispatched a child without a durable run id before interruption; refusing to duplicate the dispatch.`;
        return failResumeWithoutChildLinkage({
          host,
          runtime,
          plan,
          run,
          durableRun,
          recordUpdate,
          phaseId: run.currentPhaseId,
          payload: recoverableChildPhase.payload,
          error: unlinkedChildError,
        });
      }
      const childRun = getDurableRunIfAvailable(host, childRunId);
      if (!childRun) {
        const missingChildError = `Child durable run ${childRunId} is missing; refusing to duplicate orchestration phase ${run.currentPhaseId}.`;
        return failResumeWithoutChildLinkage({
          host,
          runtime,
          plan,
          run,
          durableRun,
          recordUpdate,
          phaseId: run.currentPhaseId,
          payload: recoverableChildPhase.payload,
          error: missingChildError,
          timelineReason: "child_durable_run_missing",
          runEvent: "run.child_durable_missing",
        });
      }
      if (!isDurableRunTerminal(childRun)) {
        host.updateDurableRunState({
          runId: durableRun.runId,
          status: "waiting",
          metadata: durableRun.metadata,
          clearFinishedAt: true,
          clearLastError: true,
        });
        host.requestDurableRunProcessing(childRunId);
        host.recordDurableTimelineEvent(durableRun.runId, "run_waiting", {
          phaseId: run.currentPhaseId,
          waveId: run.currentWaveId,
          childRunId,
          reason: "child_durable_run_not_terminal",
        });
        persistRunEvent(host, run, "run.waiting_for_child", {
          phaseId: run.currentPhaseId,
          waveId: run.currentWaveId,
          childRunId,
          childStatus: childRun.status,
        });
        return {
          outcome: "paused",
          checkpointState: buildCheckpointDetails(plan, run, durableRun.runId, {
            waitingPhase: recoverableChildPhase.payload,
            waitingForChildRunId: childRunId,
          }),
        };
      }
      harvestedWaitingExecution = buildHarvestedWaitingExecution(recoverableChildPhase.payload, childRun);
    }
    const resumedFromChild = isApprovalResume || Boolean(recoverableChildPhase);
    recordUpdate(
      {
        ...run,
        executionState: "running",
        lastError: undefined,
      },
      resumedFromChild ? "run_resumed" : undefined,
      {
        resumedFrom,
      },
    );
    if (resumedFromChild) {
      host.recordDurableTimelineEvent(durableRun.runId, "run_resumed", {
        phaseId: run.currentPhaseId,
        waveId: run.currentWaveId,
        resumedFrom: "child_phase_wait",
      });
      persistRunEvent(host, run, "run.resumed", {
        phaseId: run.currentPhaseId,
        waveId: run.currentWaveId,
        resumedFrom: "child_phase_wait",
      });
      publishRunRealtime(host, plan, run, { event: "run_resumed" });
    }
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
    if (context?.signal?.aborted) {
      const cancelled = await markOrchestrationRunCancelled(
        host,
        runtime,
        plan,
        run,
        "durable-worker",
        "Durable orchestration workflow aborted.",
      );
      return {
        outcome: "cancelled",
        checkpointState: buildCheckpointDetails(plan, cancelled, durableRun.runId),
      };
    }
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

    let execution: OrchestrationPhaseExecutionResult;
    try {
      if (harvestedWaitingExecution && harvestedWaitingExecution.phaseId === previousPhaseId) {
        execution = harvestedWaitingExecution;
        harvestedWaitingExecution = undefined;
      } else {
        execution = await runtime.phaseExecutor.execute({
          plan,
          run,
          phase,
          durableRun,
          policyContext,
          signal: context?.signal,
          onChildDispatched: (dispatch) => persistDispatchedChildPhase(host, plan, run, durableRun, dispatch),
        });
      }
      throwIfWorkflowAborted(context);
    } catch (error) {
      if (!isWorkflowAbort(error, context)) {
        throw error;
      }
      const cancelled = await markOrchestrationRunCancelled(
        host,
        runtime,
        plan,
        run,
        "durable-worker",
        error instanceof Error ? error.message : "Durable orchestration workflow aborted.",
      );
      return {
        outcome: "cancelled",
        checkpointState: buildCheckpointDetails(plan, cancelled, durableRun.runId),
      };
    }
    const unsupportedWaitError =
      execution.status === "waiting" && !execution.approvalId
        ? "Phase child turn entered a wait state without an approval id; durable orchestration only supports approval-correlated child waits."
        : execution.status === "waiting" && !execution.childRunId
          ? "Phase child turn entered a wait state without a child durable run id; durable orchestration cannot resume an unlinked child wait."
          : undefined;
    const executionStatus = unsupportedWaitError ? "failed" : execution.status;
    const executionPayload = {
      phaseId: execution.phaseId,
      ownerAgentId: execution.ownerAgentId,
      status: executionStatus,
      startedAt: execution.startedAt,
      finishedAt: execution.finishedAt,
      outputSummary: execution.outputSummary ?? unsupportedWaitError,
      outputText: execution.outputText ?? unsupportedWaitError,
      childSessionId: execution.childSessionId,
      childTurnId: execution.childTurnId,
      childRunId: execution.childRunId,
      approvalId: execution.approvalId,
      responseId: execution.responseId,
      model: execution.model,
      costUsd: execution.costUsd ?? 0,
      inputTokens: execution.inputTokens,
      outputTokens: execution.outputTokens,
      citations: execution.citations,
      artifacts: execution.artifacts,
      error: unsupportedWaitError ?? execution.error,
    };
    persistRunEvent(
      host,
      run,
      executionStatus === "failed"
        ? "phase.failed"
        : executionStatus === "waiting"
          ? "phase.waiting"
          : "phase.executed",
      executionPayload,
    );

    if (executionStatus === "waiting") {
      const waitForEvent = execution.approvalId
        ? {
            eventKey: "approval.resolved",
            correlationId: execution.approvalId,
          }
        : undefined;
      recordUpdate(
        {
          ...run,
          status: waitForEvent ? "running" : "paused",
          executionState: "paused_for_approval",
          lastError: undefined,
        },
        waitForEvent ? "run_paused_for_approval" : undefined,
        waitForEvent
          ? {
              waitingPhase: executionPayload,
              waitForEvent,
            }
          : {},
      );
      publishRunRealtime(host, plan, run, {
        event: "phase_waiting",
      });
      if (waitForEvent) {
        const metadata = {
          ...buildDurableMetadata(plan, run),
          waitForEvent,
          waitingPhase: executionPayload,
        };
        host.updateDurableRunState({
          runId: durableRun.runId,
          status: "waiting",
          metadata,
          clearFinishedAt: true,
          clearLastError: true,
        });
        host.recordDurableTimelineEvent(durableRun.runId, "run_waiting", {
          waitForEvent,
          phaseId: previousPhaseId,
          childSessionId: execution.childSessionId,
          childTurnId: execution.childTurnId,
          childRunId: execution.childRunId,
          approvalId: execution.approvalId,
        });
        persistRunEvent(host, run, "run.paused_for_approval", {
          phaseId: run.currentPhaseId,
          waveId: run.currentWaveId,
          waitForEvent,
          childSessionId: execution.childSessionId,
          childTurnId: execution.childTurnId,
          childRunId: execution.childRunId,
          approvalId: execution.approvalId,
        });
        publishRunRealtime(host, plan, run, { event: "run_paused_for_approval" });
        return {
          outcome: "paused",
          checkpointState: buildCheckpointDetails(plan, run, durableRun.runId, {
            waitingPhase: executionPayload,
            waitForEvent,
          }),
        };
      }
      continue;
    }

    if (executionStatus === "failed") {
      const phaseError = unsupportedWaitError ?? execution.error ?? `Phase ${previousPhaseId} failed.`;
      recordUpdate(
        {
          ...run,
          status: "failed",
          executionState: "failed",
          endedAt: execution.finishedAt,
          lastError: phaseError,
        },
        "run_failed",
        {
          failedPhase: executionPayload,
        },
      );
      host.recordDurableTimelineEvent(durableRun.runId, "run_failed", {
        phaseId: previousPhaseId,
        error: phaseError,
      });
      publishRunRealtime(host, plan, run, {
        event: "run_failed",
        error: phaseError,
      });
      await releaseOrchestrationWorktreeIfAvailable(runtime, host, run, "failed");
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
    ...(run.status === "stopped_by_limit" ? { stopReason: run.stopReason ?? "plan_limit" } : {}),
  });
  publishRunRealtime(host, plan, run, {
    event: run.status === "stopped_by_limit" ? "run_stopped" : "run_completed",
  });
  await releaseOrchestrationWorktreeIfAvailable(
    runtime,
    host,
    run,
    run.status === "stopped_by_limit" ? "stopped_by_limit" : "completed",
  );
  return {
    outcome: "completed",
    checkpointState: buildCheckpointDetails(plan, run, durableRun.runId),
  };
}

/**
 * Reads the linkage breadcrumb for a phase that already dispatched its child
 * turn, so resume can harvest/reattach the existing child instead of
 * re-dispatching it (ORCH-002).
 *
 * Two breadcrumb shapes are recognized, both keyed on the current phase id:
 *  - `waitingPhase`: written by the approval-wait path. Always carries a child
 *    durable run id (approval waits require a linked child).
 *  - `dispatchedPhase`: written the instant a non-approval in-flight phase
 *    dispatches its child. May lack a child durable run id when durable
 *    execution was not used for the child (the unlinked case, handled by the
 *    caller as a recoverable failure rather than a re-dispatch).
 *
 * `waitingPhase` is preferred when both are present because it is the richer,
 * approval-correlated record.
 */
function readRecoverableChildPhase(
  durableRun: DurableRunRecord,
  currentPhaseId: string,
): { childRunId?: string; payload: Record<string, unknown> } | undefined {
  const metadata = asRecord(durableRun.metadata);
  const waitingPhase = asRecord(metadata?.waitingPhase);
  if (waitingPhase && asString(waitingPhase.phaseId) === currentPhaseId) {
    const childRunId = asString(waitingPhase.childRunId);
    if (childRunId) {
      return { childRunId, payload: waitingPhase };
    }
  }
  const dispatchedPhase = asRecord(metadata?.dispatchedPhase);
  if (dispatchedPhase && asString(dispatchedPhase.phaseId) === currentPhaseId) {
    return { childRunId: asString(dispatchedPhase.childRunId), payload: dispatchedPhase };
  }
  return undefined;
}

/**
 * Persists the in-flight child linkage breadcrumb for a phase into the parent
 * durable run's metadata at (or before) dispatch. Merges with the freshly
 * rebuilt orchestration metadata so an interruption during the child turn
 * leaves a harvestable record. The breadcrumb is naturally dropped on the next
 * lifecycle metadata write (phase advance / wait / failure) because those
 * rebuild metadata from `buildDurableMetadata` without it.
 */
function persistDispatchedChildPhase(
  host: OrchestrationLifecycleHost,
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  durableRun: DurableRunRecord,
  dispatch: OrchestrationPhaseChildDispatch,
): void {
  if (dispatch.phaseId !== run.currentPhaseId) {
    return;
  }
  const dispatchedPhase: Record<string, unknown> = {
    phaseId: dispatch.phaseId,
    ownerAgentId: findPhaseInPlan(plan, dispatch.phaseId).ownerAgentId,
    dispatchInFlight: true,
    ...(dispatch.childSessionId ? { childSessionId: dispatch.childSessionId } : {}),
    ...(dispatch.childTurnId ? { childTurnId: dispatch.childTurnId } : {}),
    ...(dispatch.childRunId ? { childRunId: dispatch.childRunId } : {}),
  };
  host.updateDurableRunState({
    runId: durableRun.runId,
    metadata: {
      ...buildDurableMetadata(plan, run),
      dispatchedPhase,
    },
  });
  persistRunEvent(host, run, "phase.child_dispatched", {
    phaseId: dispatch.phaseId,
    waveId: run.currentWaveId,
    childSessionId: dispatch.childSessionId,
    childTurnId: dispatch.childTurnId,
    childRunId: dispatch.childRunId,
  });
}

/**
 * Fails an orchestration run on resume when a phase has an already-dispatched
 * child that cannot be harvested or reattached (missing child durable run, or a
 * child that was never linked to a durable run). This preserves the ORCH-002
 * invariant: such a phase is never re-dispatched.
 */
async function failResumeWithoutChildLinkage(input: {
  host: OrchestrationLifecycleHost;
  runtime: OrchestrationLifecycleRuntimeDeps;
  plan: OrchestrationPlan;
  run: OrchestrationRun;
  durableRun: DurableRunRecord;
  recordUpdate: (
    next: OrchestrationRun,
    checkpointKind?: OrchestrationCheckpoint["checkpointKind"],
    checkpointExtras?: Record<string, unknown>,
  ) => void;
  phaseId: string;
  payload: Record<string, unknown>;
  error: string;
  timelineReason?: string;
  runEvent?: string;
}): Promise<OrchestrationExecutionResult> {
  const { host, runtime, plan, durableRun } = input;
  const childRunId = asString(input.payload.childRunId);
  const failedPhase = {
    ...input.payload,
    phaseId: input.phaseId,
    status: "failed",
    ...(childRunId ? { childRunId } : {}),
    error: input.error,
  };
  const failedRun: OrchestrationRun = {
    ...input.run,
    status: "failed",
    executionState: "failed",
    endedAt: new Date().toISOString(),
    lastError: input.error,
  };
  input.recordUpdate(failedRun, "run_failed", { failedPhase });
  host.recordDurableTimelineEvent(durableRun.runId, "run_failed", {
    phaseId: input.phaseId,
    waveId: failedRun.currentWaveId,
    childRunId,
    reason: input.timelineReason ?? "child_dispatch_unrecoverable",
    error: input.error,
  });
  persistRunEvent(host, failedRun, input.runEvent ?? "run.child_dispatch_unrecoverable", {
    phaseId: input.phaseId,
    waveId: failedRun.currentWaveId,
    childRunId,
    error: input.error,
  });
  publishRunRealtime(host, plan, failedRun, {
    event: "run_failed",
    error: input.error,
  });
  await releaseOrchestrationWorktreeIfAvailable(runtime, host, failedRun, "failed");
  return {
    outcome: "failed",
    checkpointState: buildCheckpointDetails(plan, failedRun, durableRun.runId, {
      failedPhase,
    }),
  };
}

function readMalformedWorkspacePayload(
  durableRun: DurableRunRecord,
): { orchestrationRunId: string; planId: string; payloadWorkspaceId: string } | undefined {
  const payload = asRecord(durableRun.payload);
  if (!payload || payload.version !== "orchestration.plan.execute.v1") {
    return undefined;
  }
  if (
    typeof payload.orchestrationRunId !== "string" ||
    typeof payload.planId !== "string" ||
    typeof payload.requestedAt !== "string" ||
    typeof payload.workspaceId === "string"
  ) {
    return undefined;
  }
  return {
    orchestrationRunId: payload.orchestrationRunId,
    planId: payload.planId,
    payloadWorkspaceId: describeMalformedWorkspaceId(payload.workspaceId),
  };
}

function describeMalformedWorkspaceId(value: unknown): string {
  if (value === undefined) {
    return "<missing>";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function getDurableRunIfAvailable(host: OrchestrationLifecycleHost, runId: string): DurableRunRecord | undefined {
  try {
    return host.getDurableRun(runId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
    return undefined;
  }
}

async function failDurableOrchestrationWorkspaceMismatch(input: {
  host: OrchestrationLifecycleHost;
  runtime: OrchestrationLifecycleRuntimeDeps;
  durableRun: DurableRunRecord;
  run: OrchestrationRun;
  planId: string;
  payloadWorkspaceId: string;
  runWorkspaceId: string;
  error: string;
}): Promise<OrchestrationExecutionResult> {
  const failed = input.host.storage.orchestration.updateRun({
    ...input.run,
    status: "failed",
    executionState: "failed",
    endedAt: new Date().toISOString(),
    lastError: input.error,
  });
  persistRunEvent(input.host, failed, "run.workspace_mismatch", {
    durableRunId: input.durableRun.runId,
    payloadWorkspaceId: input.payloadWorkspaceId,
    runWorkspaceId: input.runWorkspaceId,
    error: input.error,
  });
  await releaseOrchestrationWorktreeIfAvailable(input.runtime, input.host, failed, "failed");
  return {
    outcome: "failed",
    checkpointState: {
      durableRunId: input.durableRun.runId,
      workflowKey: input.durableRun.workflowKey,
      planId: input.planId,
      runId: failed.runId,
      status: failed.status,
      executionState: failed.executionState,
      worktreePath: failed.worktreePath,
      worktreeStatus: failed.worktreeStatus,
      payloadWorkspaceId: input.payloadWorkspaceId,
      runWorkspaceId: input.runWorkspaceId,
      error: input.error,
      reason: "workspace_mismatch",
    },
  };
}

function buildHarvestedWaitingExecution(
  waitingPhase: Record<string, unknown>,
  childRun: DurableRunRecord,
): OrchestrationPhaseExecutionResult {
  const failed = childRun.status !== "completed";
  const childRunId = asString(waitingPhase.childRunId) ?? childRun.runId;
  const waitingOutputText = asString(waitingPhase.outputText);
  const childOutputText = asString(childRun.metadata?.outputText) ?? asString(childRun.metadata?.finalOutput);
  return {
    phaseId: asString(waitingPhase.phaseId) ?? "unknown",
    ownerAgentId: asString(waitingPhase.ownerAgentId) ?? "unknown",
    status: failed ? "failed" : "completed",
    startedAt: asString(waitingPhase.startedAt) ?? childRun.startedAt ?? childRun.createdAt,
    finishedAt: childRun.finishedAt ?? new Date().toISOString(),
    outputSummary: failed
      ? `Child phase durable run ${childRunId} ended as ${childRun.status}.`
      : (asString(childRun.metadata?.outputSummary) ??
        asString(childRun.metadata?.finalSummary) ??
        asString(waitingPhase.outputSummary) ??
        `Child phase durable run ${childRunId} completed after approval.`),
    outputText: failed ? (childRun.lastError ?? waitingOutputText) : (childOutputText ?? waitingOutputText),
    childSessionId: asString(waitingPhase.childSessionId),
    childTurnId: asString(waitingPhase.childTurnId),
    childRunId,
    approvalId: asString(waitingPhase.approvalId),
    responseId: asString(waitingPhase.responseId),
    model: asString(waitingPhase.model),
    costUsd: asNumber(waitingPhase.costUsd),
    inputTokens: asNumber(waitingPhase.inputTokens),
    outputTokens: asNumber(waitingPhase.outputTokens),
    citations: Array.isArray(waitingPhase.citations) ? (waitingPhase.citations as unknown[]) : undefined,
    artifacts: Array.isArray(waitingPhase.artifacts) ? (waitingPhase.artifacts as unknown[]) : undefined,
    error: failed
      ? (childRun.lastError ?? `Child phase durable run ${childRunId} ended as ${childRun.status}.`)
      : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

export function getRunTrace(
  host: OrchestrationLifecycleHost,
  runId: string,
  workspaceId?: string,
): OrchestrationDecisionTrace {
  const run = assertRunWorkspaceAccess(host.storage.orchestration.getRun(runId), workspaceId);
  // `lastError` is free-form text that can be large or echo upstream provider errors; bound it
  // to the same cap as every other trace string. Remaining run fields are ids, numbers, or
  // closed-enum statuses (e.g. executionState), so there is nothing secret-shaped left to redact.
  const sanitizedRun: OrchestrationRun =
    run.lastError === undefined ? run : { ...run, lastError: capTraceString(run.lastError) };
  const checkpoints = host.storage.orchestration.listCheckpoints(runId).map((checkpoint) => ({
    ...checkpoint,
    details: sanitizeTraceDetails(checkpoint.details),
  }));
  const warnings: string[] = [];
  const runEvents = host.storage.orchestration.listRunEvents
    ? host.storage.orchestration
        .listRunEvents(runId)
        .map((event) => ({ ...event, payload: sanitizeTraceDetails(event.payload) }))
    : [];
  if (!host.storage.orchestration.listRunEvents) {
    warnings.push("Run event storage does not expose listRunEvents; trace is checkpoint-only.");
  }

  const decisions = [
    ...checkpoints.map((checkpoint): OrchestrationDecisionEvent => {
      const kind = mapCheckpointDecisionKind(checkpoint.checkpointKind);
      return {
        decisionId: `checkpoint:${checkpoint.checkpointId}`,
        runId: checkpoint.runId,
        kind,
        source: "checkpoint",
        sourceId: checkpoint.checkpointId,
        checkpointKind: checkpoint.checkpointKind,
        planId: checkpoint.planId,
        waveId: checkpoint.waveId,
        phaseId: checkpoint.phaseId,
        createdAt: checkpoint.createdAt,
        summary: summarizeDecision(kind, checkpoint.checkpointKind, checkpoint.details),
        details: checkpoint.details,
      };
    }),
    ...runEvents.map((event): OrchestrationDecisionEvent => {
      const kind = mapRunEventDecisionKind(event.eventType, event.payload);
      return {
        decisionId: `event:${event.eventId}`,
        runId: event.runId,
        kind,
        source: "run_event",
        sourceId: event.eventId,
        eventType: event.eventType,
        phaseId: asString(event.payload.phaseId),
        createdAt: event.createdAt,
        summary: summarizeDecision(kind, event.eventType, event.payload),
        details: event.payload,
      };
    }),
  ].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.decisionId.localeCompare(right.decisionId),
  );

  return {
    run: sanitizedRun,
    checkpoints,
    runEvents,
    decisions,
    generatedAt: new Date().toISOString(),
    warnings,
  };
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

function mapCheckpointDecisionKind(checkpointKind: string): OrchestrationDecisionKind {
  switch (checkpointKind) {
    case "run_created":
    case "durable_run_linked":
    case "worktree_allocated":
    case "run_queued":
    case "run_started":
    case "run_resumed":
    case "run_completed":
    case "run_failed":
    case "run_cancelled":
      return checkpointKind;
    case "phase_approved":
      return "policy_checked";
    case "phase_executed":
      return "phase_completed";
    case "wave_advanced":
      return "phase_advanced";
    case "run_paused_for_approval":
      return "phase_wait_registered";
    case "run_stopped":
      return "run_stopped";
    default:
      return "unknown";
  }
}

function mapRunEventDecisionKind(eventType: string, _payload: Record<string, unknown>): OrchestrationDecisionKind {
  switch (eventType) {
    case "run.created":
      return "run_created";
    case "run.queued":
      return "run_queued";
    case "run.started":
      return "run_started";
    case "run.resumed":
      return "run_resumed";
    case "run.completed":
      return "run_completed";
    case "run.stopped":
      return "run_stopped";
    case "run.failed":
      return "run_failed";
    case "run.cancelled":
      return "run_cancelled";
    case "phase.started":
      return "phase_started";
    case "phase.child_dispatched":
      return "phase_child_dispatched";
    case "phase.waiting":
    case "run.paused_for_approval":
      return "phase_wait_registered";
    case "phase.completed":
    case "phase.executed":
      return "phase_completed";
    case "cost.recorded":
      return "cost_recorded";
    case "phase.failed":
      return "phase_failed";
    case "phase.advanced":
    case "wave.advanced":
      return "phase_advanced";
    case "policy.checked":
      return "policy_checked";
    default:
      return "unknown";
  }
}

function summarizeDecision(
  kind: OrchestrationDecisionKind,
  sourceName: string,
  details: Record<string, unknown>,
): string {
  const phaseId = asString(details.phaseId);
  const model = asString(details.model);
  const status = asString(details.status);
  const parts = [kind.replace(/_/g, " ")];
  if (phaseId) {
    parts.push(`phase ${phaseId}`);
  }
  if (model) {
    parts.push(`model ${model}`);
  }
  if (status) {
    parts.push(`status ${status}`);
  }
  if (parts.length === 1) {
    parts.push(sourceName);
  }
  return parts.join(" · ");
}

function sanitizeTraceDetails(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeTraceValue(value, 0) as Record<string, unknown>;
}

function sanitizeTraceValue(value: unknown, depth: number): unknown {
  if (depth > 3) {
    return "[Max depth]";
  }
  if (typeof value === "string") {
    return capTraceString(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeTraceValue(item, depth + 1));
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 50)) {
    sanitized[key] = shouldRedactTraceKey(key) ? "[redacted]" : sanitizeTraceValue(child, depth + 1);
  }
  return sanitized;
}

function capTraceString(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}... [truncated]` : value;
}

function shouldRedactTraceKey(key: string): boolean {
  return /secret|token|api[-_]?key|authorization|password|credential|cookie/i.test(key);
}
