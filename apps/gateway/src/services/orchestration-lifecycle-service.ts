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
  type OrchestrationPhase,
  type OrchestrationPhaseExecutionResult,
  type OrchestrationRun,
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

export async function createOrchestrationPlan(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  plan: OrchestrationPlan,
  policyContext: OrchestrationRunPolicyContext = {},
): Promise<OrchestrationRun> {
  const workspaceId = normalizeRouteWorkspaceId(policyContext.workspaceId);
  host.storage.orchestration.upsertPlan(plan, workspaceId);
  const created = host.orchestrationEngine.createRun(plan);
  const persisted = host.storage.orchestration.createRun({
    ...created,
    ...policyContext,
    workspaceId,
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

  return allocateOrchestrationOwnership(host, runtime, plan, persisted);
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
    if (activeRun.durableRunId && activeRun.executionState === "queued") {
      host.requestDurableRunProcessing(activeRun.durableRunId);
    }
    if (activeRun.durableRunId && activeRun.executionState === "worktree_ready") {
      return queueOrchestrationRun(host, plan, activeRun);
    }
    return activeRun;
  }
  const run = await createOrchestrationPlan(host, runtime, plan, policyContext);
  if (run.status === "failed") {
    return run;
  }

  return queueOrchestrationRun(host, plan, run);
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
    const waitingChildPhase = readWaitingChildPhase(durableRun, run.currentPhaseId);
    if (resumedFrom === "paused_for_approval" && waitingChildPhase) {
      const childRun = getDurableRunIfAvailable(host, waitingChildPhase.childRunId);
      if (!childRun) {
        const missingChildError = `Child durable run ${waitingChildPhase.childRunId} is missing; refusing to duplicate orchestration phase ${run.currentPhaseId}.`;
        const failedPhase = {
          ...waitingChildPhase.payload,
          phaseId: run.currentPhaseId,
          status: "failed",
          childRunId: waitingChildPhase.childRunId,
          error: missingChildError,
        };
        recordUpdate(
          {
            ...run,
            status: "failed",
            executionState: "failed",
            endedAt: new Date().toISOString(),
            lastError: missingChildError,
          },
          "run_failed",
          {
            failedPhase,
          },
        );
        host.recordDurableTimelineEvent(durableRun.runId, "run_failed", {
          phaseId: run.currentPhaseId,
          waveId: run.currentWaveId,
          childRunId: waitingChildPhase.childRunId,
          reason: "child_durable_run_missing",
          error: missingChildError,
        });
        persistRunEvent(host, run, "run.child_durable_missing", {
          phaseId: run.currentPhaseId,
          waveId: run.currentWaveId,
          childRunId: waitingChildPhase.childRunId,
          error: missingChildError,
        });
        publishRunRealtime(host, plan, run, {
          event: "run_failed",
          error: missingChildError,
        });
        await releaseOrchestrationWorktreeIfAvailable(runtime, host, run, "failed");
        return {
          outcome: "failed",
          checkpointState: buildCheckpointDetails(plan, run, durableRun.runId, {
            failedPhase,
          }),
        };
      }
      if (childRun && !isDurableRunTerminal(childRun)) {
        host.updateDurableRunState({
          runId: durableRun.runId,
          status: "waiting",
          metadata: durableRun.metadata,
          clearFinishedAt: true,
          clearLastError: true,
        });
        host.requestDurableRunProcessing(waitingChildPhase.childRunId);
        host.recordDurableTimelineEvent(durableRun.runId, "run_waiting", {
          phaseId: run.currentPhaseId,
          waveId: run.currentWaveId,
          childRunId: waitingChildPhase.childRunId,
          reason: "child_durable_run_not_terminal",
        });
        persistRunEvent(host, run, "run.waiting_for_child", {
          phaseId: run.currentPhaseId,
          waveId: run.currentWaveId,
          childRunId: waitingChildPhase.childRunId,
          childStatus: childRun.status,
        });
        return {
          outcome: "paused",
          checkpointState: buildCheckpointDetails(plan, run, durableRun.runId, {
            waitingPhase: waitingChildPhase.payload,
            waitingForChildRunId: waitingChildPhase.childRunId,
          }),
        };
      }
      if (childRun) {
        harvestedWaitingExecution = buildHarvestedWaitingExecution(waitingChildPhase.payload, childRun);
      }
    }
    recordUpdate(
      {
        ...run,
        executionState: "running",
        lastError: undefined,
      },
      resumedFrom === "paused_for_approval" ? "run_resumed" : undefined,
      {
        resumedFrom,
      },
    );
    if (resumedFrom === "paused_for_approval") {
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

function readWaitingChildPhase(
  durableRun: DurableRunRecord,
  currentPhaseId: string,
): { childRunId: string; payload: Record<string, unknown> } | undefined {
  const metadata = asRecord(durableRun.metadata);
  const waitingPhase = asRecord(metadata?.waitingPhase);
  if (!waitingPhase) {
    return undefined;
  }
  const phaseId = asString(waitingPhase.phaseId);
  const childRunId = asString(waitingPhase.childRunId);
  if (!phaseId || phaseId !== currentPhaseId || !childRunId) {
    return undefined;
  }
  return { childRunId, payload: waitingPhase };
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
