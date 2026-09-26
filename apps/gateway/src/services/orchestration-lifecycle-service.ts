/* eslint-disable max-lines */
/**
 * Orchestration lifecycle service.
 *
 * Owns orchestration plan/run/phase lifecycle behavior behind an explicit host
 * contract while GatewayService remains the composition root.
 */

import {
  ConflictError,
  isChatTurnTerminalStatus,
  redactSecretText,
  redactStructuredSecrets,
  type ChatTurnTraceRecord,
  type DurableChildWatcherCreateRequest,
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
  type RuntimeDecisionTraceAppendInput,
  type RuntimeDecisionTraceRecord,
  type RuntimeDecisionTraceQuery,
  ValidationError,
} from "@goatcitadel/contracts";
import { listLimitOverruns, type OrchestrationEngine } from "@goatcitadel/orchestration";
import type { OrchestrationCheckpoint, AsyncStorage as Storage } from "@goatcitadel/storage";
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
import type { OrchestrationWorktreeReleaseResult } from "./orchestration-worktree-service.js";

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

type OrchestrationDurableCommitOptions = {
  durableState?: {
    status?: DurableRunRecord["status"];
    lastError?: string;
    clearLastError?: boolean;
    finishedAt?: string;
    clearFinishedAt?: boolean;
    clearLease?: boolean;
  };
  durableMetadata?: Record<string, unknown>;
  durableMetadataExtras?: Record<string, unknown>;
  durableTimeline?: {
    eventType: DurableRunTimelineEvent["eventType"];
    payload?: Record<string, unknown>;
  };
};

export interface OrchestrationLifecycleRuntimeDeps {
  readonly worktrees: {
    allocate(input: { runId: string; workspaceId: string; baseRef?: string }): Promise<{
      worktreePath: string;
      worktreeStatus: NonNullable<OrchestrationRun["worktreeStatus"]>;
      worktreeBaseRef: string;
      worktreeLeaseOwnerId?: string;
      worktreeLeaseGeneration?: number;
      worktreeLeaseExpiresAt?: string;
    }>;
    release(input: {
      run: OrchestrationRun;
      reason: "completed" | "failed" | "stopped_by_limit" | "cancelled";
    }): Promise<OrchestrationWorktreeReleaseResult | void>;
    ensureLeaseForExecution(run: OrchestrationRun): Promise<OrchestrationRun>;
  };
  readonly phaseExecutor: {
    execute(input: {
      plan: OrchestrationPlan;
      run: OrchestrationRun;
      phase: OrchestrationPhase;
      durableRun: DurableRunRecord;
      policyContext?: OrchestrationRunPolicyContext;
      signal?: AbortSignal;
      onChildDispatched?: (dispatch: OrchestrationPhaseChildDispatch) => Promise<void>;
    }): Promise<OrchestrationPhaseExecutionResult>;
    /**
     * Reads a parked phase's settled child turn from canonical records, or
     * returns undefined while the child is still working.
     */
    harvest?(input: {
      phaseId: string;
      ownerAgentId: string;
      childRunId: string;
      childSessionId?: string;
      childTurnId?: string;
      startedAt?: string;
      prompt?: OrchestrationPhaseExecutionResult["prompt"];
    }): Promise<OrchestrationPhaseExecutionResult | undefined>;
  };
}

/**
 * Wake key a parent orchestration run parks on while its phase's child Chat
 * turn runs. The correlation id is the child's durable run id.
 */
export const ORCHESTRATION_PHASE_CHILD_WAKE_EVENT = "orchestration.phase_child.settled";

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
    runImmediateTransaction<T>(callback: () => T | Promise<T>): Promise<Awaited<T>>;
    durableRuns: Pick<Storage["durableRuns"], "lockFreshActiveLeaseForUpdate"> &
      Partial<Pick<Storage["durableRuns"], "listUnstartedOrchestrationRunIds">>;
    orchestration: {
      upsertPlan(plan: OrchestrationPlan, workspaceId?: string): Promise<void>;
      getPlan(planId: string, workspaceId?: string): Promise<OrchestrationPlan>;
      createRun(run: OrchestrationRun): Promise<OrchestrationRun>;
      findLatestRunByPlan(planId: string): Promise<OrchestrationRun | undefined>;
      findActiveRunByPlan(planId: string, workspaceId?: string): Promise<OrchestrationRun | undefined>;
      updateRun(run: OrchestrationRun): Promise<OrchestrationRun>;
      updateRunIfCurrentState(
        run: OrchestrationRun,
        expected: Pick<OrchestrationRun, "status" | "executionState">,
      ): Promise<OrchestrationRun | undefined>;
      appendRunEvent(runId: string, event: string, payload: Record<string, unknown>): Promise<void>;
      listCheckpoints(runId: string): Promise<OrchestrationCheckpoint[]>;
      listRunEvents?(runId: string): Promise<OrchestrationRunEventRecord[]>;
      getRun(runId: string): Promise<OrchestrationRun>;
      /** Active runs whose linked durable run has already ended, oldest first. */
      listActiveRunsWithEndedDurableRun?(limit?: number): Promise<OrchestrationRun[]>;
      /** Active ownership setups with no durable link, paged by run id. */
      listUnlinkedCreatedRuns?(limit?: number, afterRunId?: string): Promise<OrchestrationRun[]>;
    };
    runtimeDecisionTraces?: {
      append(input: RuntimeDecisionTraceAppendInput): Promise<RuntimeDecisionTraceRecord>;
      list(query: RuntimeDecisionTraceQuery): Promise<RuntimeDecisionTraceRecord[]>;
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
    }): Promise<unknown>;
  };
  createCheckpoint(
    input: Omit<OrchestrationCheckpoint, "checkpointId" | "createdAt" | "gitRef">,
  ): Promise<OrchestrationCheckpoint>;
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<unknown>;
  scheduleOrchestrationMemoryContext(plan: OrchestrationPlan, run: OrchestrationRun): Promise<unknown>;
  createDurableRun(
    input: DurableRunCreateRequest,
    internalOptions?: { initialStatus: "paused" },
  ): Promise<DurableRunRecord>;
  getDurableRun(runId: string): Promise<DurableRunRecord>;
  requestDurableRunProcessing(runId: string): Promise<unknown>;
  pauseDurableRun(runId: string, actorId?: string): Promise<DurableRunRecord>;
  resumeDurableRun(runId: string, actorId?: string): Promise<DurableRunRecord>;
  cancelDurableRun(runId: string, actorId?: string): Promise<DurableRunRecord>;
  updateDurableRunState(input: {
    runId: string;
    status?: DurableRunRecord["status"];
    metadata?: Record<string, unknown>;
    lastError?: string;
    clearLastError?: boolean;
    finishedAt?: string;
    clearFinishedAt?: boolean;
    clearLease?: boolean;
    expectedLeaseOwnerId?: string;
  }): Promise<DurableRunRecord>;
  recordDurableTimelineEvent(
    runId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
  ): Promise<unknown>;
  watchDurableChildRun?(input: DurableChildWatcherCreateRequest): Promise<unknown>;
}

async function releaseOrchestrationWorktreeIfAvailable(
  runtime: OrchestrationLifecycleRuntimeDeps,
  host: OrchestrationLifecycleHost,
  run: OrchestrationRun,
  reason: "completed" | "failed" | "stopped_by_limit" | "cancelled",
): Promise<void> {
  try {
    const released = await runtime.worktrees.release({ run, reason });
    if (released?.outcome === "retained_dirty") {
      await persistRunEvent(host, run, "run.worktree_retained_dirty", {
        reason,
        worktreePath: released.worktreePath,
        changedPathCount: released.changedPathCount,
        changedPaths: released.changedPaths,
      });
    } else if (released?.outcome === "retained_unverified") {
      await persistRunEvent(host, run, "run.worktree_retained_unverified", {
        reason,
        worktreePath: released.worktreePath,
        error: released.error,
      });
    }
  } catch (error) {
    await persistRunEvent(host, run, "run.worktree_cleanup_failed", {
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

const RUN_ERROR_MAX_CHARACTERS = 2000;
const OWNERSHIP_SETUP_GRACE_MS = 5 * 60_000;
const OWNERSHIP_RECOVERY_INTERVAL_MS = 30_000;
const ownershipRecoveryLastScanByStorage = new WeakMap<OrchestrationLifecycleHost["storage"], number>();

/** Redacts secrets from, and bounds, error text copied into run state, events, and realtime payloads. */
function boundRunError(message: string): string {
  const redacted = redactSecretText(message).value;
  return redacted.length > RUN_ERROR_MAX_CHARACTERS
    ? `${redacted.slice(0, RUN_ERROR_MAX_CHARACTERS)} [truncated]`
    : redacted;
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

function readDurableRecoveryInterruption(
  context?: DurableWorkflowExecutionContext,
  error?: unknown,
): Error | undefined {
  for (const candidate of [context?.signal?.aborted ? context.signal.reason : undefined, error]) {
    if (
      candidate instanceof Error &&
      (candidate.name === "DurableWorkerInterruptionError" || candidate.name === "DurableRunPausedError")
    ) {
      return candidate;
    }
  }
  return undefined;
}

function readDurableWorkflowTimeout(context?: DurableWorkflowExecutionContext, error?: unknown): Error | undefined {
  return [context?.signal?.aborted ? context.signal.reason : undefined, error].find(
    (candidate): candidate is Error => candidate instanceof Error && candidate.name === "DurableWorkflowTimeoutError",
  );
}

function requireDurableExecutionLeaseOwner(run: DurableRunRecord): string {
  const leaseOwnerId = run.leaseOwnerId?.trim();
  if (run.status !== "running" || !leaseOwnerId) {
    const error = new Error(`Durable orchestration run ${run.runId} is not executing under an active worker lease.`);
    error.name = "DurableWorkerInterruptionError";
    throw error;
  }
  return leaseOwnerId;
}

async function lockFreshDurableExecutionLease(
  host: OrchestrationLifecycleHost,
  runId: string,
  expectedLeaseOwnerId: string,
): Promise<DurableRunRecord> {
  const locked = await host.storage.durableRuns.lockFreshActiveLeaseForUpdate(runId, expectedLeaseOwnerId);
  if (!locked) {
    const error = new Error(`Durable orchestration run ${runId} lost its execution lease before commit.`);
    error.name = "DurableWorkerInterruptionError";
    throw error;
  }
  return locked;
}

interface OrchestrationWorktreeExecutionFence {
  worktreePath: string;
  ownerId: string;
  generation: number;
}

function readOrchestrationWorktreeExecutionFence(
  run: OrchestrationRun,
): OrchestrationWorktreeExecutionFence | undefined {
  const worktreePath = run.worktreePath?.trim();
  const ownerId = run.worktreeLeaseOwnerId?.trim();
  const generation = run.worktreeLeaseGeneration;
  if (!worktreePath || !ownerId || !Number.isSafeInteger(generation) || (generation ?? 0) < 1) {
    return undefined;
  }
  return { worktreePath, ownerId, generation: generation! };
}

async function assertFreshOrchestrationWorktreeExecutionFence(
  host: OrchestrationLifecycleHost,
  runId: string,
  expected: OrchestrationWorktreeExecutionFence | undefined,
): Promise<void> {
  if (!expected) {
    return;
  }
  const current = await host.storage.orchestration.getRun(runId);
  if (
    current.worktreeStatus === "ready" &&
    current.worktreePath === expected.worktreePath &&
    current.worktreeLeaseOwnerId === expected.ownerId &&
    current.worktreeLeaseGeneration === expected.generation
  ) {
    return;
  }
  const error = new Error(
    `Orchestration run ${runId} lost worktree owner ${expected.ownerId} generation ${expected.generation}.`,
  );
  error.name = "DurableWorkerInterruptionError";
  throw error;
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
  const storage = host.storage;
  const commitRunCandidate = async (
    candidate: OrchestrationRun,
  ): Promise<{ run: OrchestrationRun; transitioned: boolean }> => {
    const updated = await storage.orchestration.updateRunIfCurrentState(candidate, {
      status: run.status,
      executionState: run.executionState,
    });
    if (updated) {
      return { run: updated, transitioned: true };
    }
    const current = await storage.orchestration.getRun(run.runId);
    if (isOrchestrationRunTerminal(current)) {
      return { run: current, transitioned: false };
    }
    throw new ConflictError({
      message: `Orchestration run ${run.runId} changed before its terminal state could commit.`,
      details: {
        runId: run.runId,
        expectedStatus: run.status,
        expectedExecutionState: run.executionState,
        actualStatus: current.status,
        actualExecutionState: current.executionState,
      },
    });
  };
  const linkedDurable = run.durableRunId ? await host.getDurableRun(run.durableRunId) : undefined;
  const durableWinnerDetails = { actorId, requestedCancellationReason: reason };
  if (linkedDurable && isDurableRunTerminal(linkedDurable) && linkedDurable.status !== "cancelled") {
    return commitLinkedDurableTerminalWinner(host, runtime, plan, run, linkedDurable, durableWinnerDetails);
  }
  const cancellationCandidate: OrchestrationRun = {
    ...run,
    status: "cancelled",
    executionState: "cancelled",
    endedAt: new Date().toISOString(),
    lastError: reason,
    pendingApprovalPhaseId: undefined,
    pendingApprovedBy: undefined,
    pendingCostIncrementUsd: undefined,
  };
  const persistCancellationCheckpoint = async (cancelled: OrchestrationRun): Promise<void> => {
    await persistCheckpoint(
      host,
      plan,
      cancelled,
      "run_cancelled",
      buildCheckpointDetails(plan, cancelled, cancelled.durableRunId, {
        actorId,
        reason,
      }),
    );
  };
  let cancellation!: { run: OrchestrationRun; transitioned: boolean };
  if (!linkedDurable || linkedDurable.status === "cancelled") {
    await storage.runImmediateTransaction(async () => {
      cancellation = await commitRunCandidate(cancellationCandidate);
      if (!cancellation.transitioned) {
        return;
      }
      if (linkedDurable && cancellation.run.durableRunId) {
        await host.updateDurableRunState({
          runId: cancellation.run.durableRunId,
          metadata: buildDurableMetadata(plan, cancellation.run, {
            lifecycleState: "cancelled",
          }),
        });
        await host.recordDurableTimelineEvent(cancellation.run.durableRunId, "run_cancelled", {
          actorId,
          reason,
          orchestrationRunId: cancellation.run.runId,
        });
      }
      await persistCancellationCheckpoint(cancellation.run);
    });
  } else {
    let observedVersion = linkedDurable.version;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await host.cancelDurableRun(linkedDurable.runId, actorId);
        break;
      } catch (error) {
        const raced = await host.getDurableRun(linkedDurable.runId);
        if (raced.status === "cancelled") {
          // A post-commit publication failure must not undo canonical cancellation.
          break;
        }
        if (isDurableRunTerminal(raced)) {
          return commitLinkedDurableTerminalWinner(host, runtime, plan, run, raced, durableWinnerDetails);
        }
        if (attempt === 0 && raced.version !== observedVersion) {
          observedVersion = raced.version;
          continue;
        }
        throw error;
      }
    }
    await storage.runImmediateTransaction(async () => {
      cancellation = await commitRunCandidate(cancellationCandidate);
      if (!cancellation.transitioned || !cancellation.run.durableRunId) {
        return;
      }
      await host.updateDurableRunState({
        runId: cancellation.run.durableRunId,
        metadata: buildDurableMetadata(plan, cancellation.run, {
          lifecycleState: "cancelled",
        }),
      });
      await persistCancellationCheckpoint(cancellation.run);
    });
  }
  if (!cancellation.transitioned) {
    return cancellation.run;
  }
  const cancelled = cancellation.run;
  if (linkedDurable && run.currentPhaseId) {
    await cancelOrphanedPhaseChild(
      host,
      cancelled,
      readRecoverableChildPhase(linkedDurable, run.currentPhaseId)?.childRunId,
      actorId,
    );
  }
  await persistRunEvent(host, cancelled, "run.cancelled", {
    actorId,
    reason,
  });
  await publishRunRealtime(host, plan, cancelled, {
    event: "run_cancelled",
    error: reason,
  });
  await releaseOrchestrationWorktreeIfAvailable(runtime, host, cancelled, "cancelled");
  return cancelled;
}

/**
 * Settles an active orchestration run to the outcome of its linked durable
 * run, which has already ended. The write is a compare-and-set on the run's
 * current status and execution state: when the run already reached a terminal
 * state, that state stands. A phase child that has not finished is cancelled,
 * since nothing will harvest it.
 */
async function commitLinkedDurableTerminalWinner(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  linked: DurableRunRecord,
  details: Record<string, unknown>,
): Promise<OrchestrationRun> {
  const durableOrchestration = asRecord(linked.metadata?.orchestration);
  const winnerStatus: "stopped_by_limit" | "completed" | "cancelled" | "failed" =
    linked.status === "completed"
      ? durableOrchestration?.executionState === "stopped_by_limit"
        ? "stopped_by_limit"
        : "completed"
      : linked.status === "cancelled"
        ? "cancelled"
        : "failed";
  const winner: OrchestrationRun = {
    ...run,
    status: winnerStatus,
    executionState: winnerStatus,
    endedAt: linked.finishedAt ?? new Date().toISOString(),
    lastError:
      winnerStatus === "failed" || winnerStatus === "cancelled"
        ? boundRunError(linked.lastError ?? `Linked durable run ${linked.runId} finished as ${linked.status}.`)
        : undefined,
    pendingApprovalPhaseId: undefined,
    pendingApprovedBy: undefined,
    pendingCostIncrementUsd: undefined,
  };
  const winnerDetails = { ...details, durableTerminalStatus: linked.status, terminalWinner: "durable_run" };
  let terminal!: { run: OrchestrationRun; transitioned: boolean };
  await host.storage.runImmediateTransaction(async () => {
    const updated = await host.storage.orchestration.updateRunIfCurrentState(winner, {
      status: run.status,
      executionState: run.executionState,
    });
    if (!updated) {
      const current = await host.storage.orchestration.getRun(run.runId);
      if (!isOrchestrationRunTerminal(current)) {
        throw new ConflictError({
          message: `Orchestration run ${run.runId} changed before its terminal state could commit.`,
          details: {
            runId: run.runId,
            expectedStatus: run.status,
            expectedExecutionState: run.executionState,
            actualStatus: current.status,
            actualExecutionState: current.executionState,
          },
        });
      }
      terminal = { run: current, transitioned: false };
      return;
    }
    terminal = { run: updated, transitioned: true };
    await persistCheckpoint(
      host,
      plan,
      updated,
      winnerStatus === "stopped_by_limit"
        ? "run_stopped"
        : winnerStatus === "completed"
          ? "run_completed"
          : winnerStatus === "cancelled"
            ? "run_cancelled"
            : "run_failed",
      buildCheckpointDetails(plan, updated, linked.runId, winnerDetails),
    );
  });
  if (!terminal.transitioned) {
    return terminal.run;
  }
  const event =
    winnerStatus === "stopped_by_limit"
      ? "run.stopped"
      : winnerStatus === "completed"
        ? "run.completed"
        : winnerStatus === "cancelled"
          ? "run.cancelled"
          : "run.failed";
  try {
    await persistRunEvent(host, terminal.run, event, winnerDetails);
    await publishRunRealtime(host, plan, terminal.run, {
      event: event.replace("run.", "run_"),
      ...(winnerStatus === "failed" || winnerStatus === "cancelled" ? { error: terminal.run.lastError } : {}),
    });
  } finally {
    try {
      if ((winnerStatus === "failed" || winnerStatus === "cancelled") && run.currentPhaseId) {
        await cancelOrphanedPhaseChild(
          host,
          terminal.run,
          readRecoverableChildPhase(linked, run.currentPhaseId)?.childRunId,
          "orchestration",
        );
      }
    } finally {
      await releaseOrchestrationWorktreeIfAvailable(runtime, host, terminal.run, winnerStatus);
    }
  }
  return terminal.run;
}

/**
 * Cancels a phase's child Chat run that can no longer report to its parent,
 * because the run was cancelled or the phase failed. A parked parent does not
 * hold the child's abort signal, so this is how either outcome reaches the
 * child. A child that settles concurrently keeps its own terminal state.
 */
async function cancelOrphanedPhaseChild(
  host: OrchestrationLifecycleHost,
  run: OrchestrationRun,
  childRunId: string | undefined,
  actorId: string,
): Promise<void> {
  if (!childRunId) {
    return;
  }
  const child = await getDurableRunIfAvailable(host, childRunId);
  if (!child || isDurableRunTerminal(child)) {
    return;
  }
  try {
    await host.cancelDurableRun(childRunId, actorId);
  } catch (error) {
    const current = await getDurableRunIfAvailable(host, childRunId);
    if (current && !isDurableRunTerminal(current)) {
      await persistRunEvent(host, run, "phase.child_cancel_failed", {
        phaseId: run.currentPhaseId,
        childRunId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function persistCheckpoint(
  host: OrchestrationLifecycleHost,
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  checkpointKind: OrchestrationCheckpoint["checkpointKind"],
  details: Record<string, unknown>,
): Promise<void> {
  const checkpoint = await host.createCheckpoint({
    runId: run.runId,
    planId: plan.planId,
    waveId: run.currentWaveId,
    phaseId: run.currentPhaseId,
    checkpointKind,
    details,
  });
  await appendOrchestrationRuntimeDecision(host, {
    kind: "durable_checkpoint",
    scope: buildOrchestrationDecisionScope(run, plan.planId, run.currentPhaseId),
    selected: `Recorded orchestration checkpoint ${checkpointKind}`,
    rationale: "Durable execution persisted an orchestration checkpoint for replay and operator inspection.",
    signals: [
      {
        source: "durable",
        key: "checkpointKind",
        value: checkpointKind,
        weight: "informational",
      },
      {
        source: "orchestration",
        key: "runStatus",
        value: run.status,
        weight: "informational",
      },
    ],
    evidenceRefs: [
      { refType: "run", refId: run.runId },
      { refType: "plan", refId: plan.planId },
      { refType: "checkpoint", refId: checkpoint.checkpointId, label: checkpointKind },
    ],
  });
}

async function persistRunEvent(
  host: OrchestrationLifecycleHost,
  run: OrchestrationRun,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await host.storage.orchestration.appendRunEvent(run.runId, event, payload);
  const kind = mapRunEventRuntimeDecisionKind(event);
  if (!kind) {
    return;
  }
  const phaseId = asString(payload.phaseId) ?? run.currentPhaseId;
  await appendOrchestrationRuntimeDecision(host, {
    kind,
    scope: buildOrchestrationDecisionScope(run, run.planId, phaseId),
    selected: summarizeRunEventSelection(event, run),
    rationale: summarizeRunEventRuntimeRationale(event, payload),
    signals: [
      {
        source: "orchestration",
        key: "eventType",
        value: event,
        weight: "strong",
      },
      {
        source: "orchestration",
        key: "runStatus",
        value: run.status,
        weight: "informational",
      },
      ...(phaseId
        ? [
            {
              source: "execution_plan" as const,
              key: "phaseId",
              value: phaseId,
              weight: "informational" as const,
            },
          ]
        : []),
    ],
    evidenceRefs: [
      { refType: "run", refId: run.runId },
      ...(run.planId ? [{ refType: "plan" as const, refId: run.planId }] : []),
      ...(phaseId ? [{ refType: "step" as const, refId: phaseId }] : []),
      ...(run.durableRunId ? [{ refType: "durable_run" as const, refId: run.durableRunId }] : []),
    ],
  });
}

async function appendOrchestrationRuntimeDecision(
  host: OrchestrationLifecycleHost,
  input: RuntimeDecisionTraceAppendInput,
): Promise<void> {
  try {
    await host.storage.runtimeDecisionTraces?.append(input);
  } catch {
    // Best-effort decision traces are non-fatal; orchestration lifecycle mutations remain authoritative.
  }
}

function buildOrchestrationDecisionScope(
  run: OrchestrationRun,
  planId: string | undefined,
  phaseId: string | undefined,
): RuntimeDecisionTraceAppendInput["scope"] {
  return {
    ...(run.workspaceId ? { workspaceId: run.workspaceId } : {}),
    runId: run.runId,
    ...(planId ? { planId } : {}),
    ...(phaseId ? { stepId: phaseId } : {}),
    ...(run.durableRunId ? { durableRunId: run.durableRunId } : {}),
  };
}

function mapRunEventRuntimeDecisionKind(event: string): RuntimeDecisionTraceAppendInput["kind"] | undefined {
  switch (event) {
    case "run.started":
      return "orchestration_run_started";
    case "phase.advanced":
      return "orchestration_phase_advanced";
    case "run.paused_for_approval":
      return "runtime_paused";
    case "run.resumed":
      return "runtime_resumed";
    case "run.completed":
    case "run.stopped":
      return "orchestration_run_completed";
    case "run.failed":
      return "orchestration_run_failed";
    case "run.cancelled":
      return "orchestration_run_cancelled";
    default:
      return undefined;
  }
}

function summarizeRunEventSelection(event: string, run: OrchestrationRun): string {
  switch (event) {
    case "run.started":
      return "Started orchestration run";
    case "phase.advanced":
      return "Advanced orchestration phase";
    case "run.paused_for_approval":
      return "Paused run for approval";
    case "run.resumed":
      return "Resumed orchestration run";
    case "run.completed":
      return "Completed orchestration run";
    case "run.stopped":
      return "Stopped orchestration run at configured limit";
    case "run.failed":
      return "Marked orchestration run failed";
    case "run.cancelled":
      return "Cancelled orchestration run";
    default:
      return `Recorded ${event} for ${run.runId}`;
  }
}

function summarizeRunEventRuntimeRationale(event: string, payload: Record<string, unknown>): string {
  const reason = asString(payload.reason) ?? asString(payload.error) ?? asString(payload.message);
  if (reason) {
    return reason;
  }
  switch (event) {
    case "run.started":
      return "The orchestration engine accepted the run and began durable execution.";
    case "phase.advanced":
      return "The current phase completed and the engine selected the next executable phase.";
    case "run.paused_for_approval":
      return "Execution reached an approval-gated point and must wait for an operator decision.";
    case "run.resumed":
      return "A wait condition cleared and durable execution was re-entered.";
    case "run.completed":
      return "All required orchestration phases completed successfully.";
    case "run.stopped":
      return "The run stopped after reaching a configured execution limit.";
    case "run.failed":
      return "The orchestration lifecycle recorded a terminal failure.";
    case "run.cancelled":
      return "The orchestration lifecycle recorded an operator or system cancellation.";
    default:
      return "The orchestration lifecycle recorded a retained run event.";
  }
}

async function persistPolicyGateEvent(
  host: OrchestrationLifecycleHost,
  run: OrchestrationRun,
  input: {
    gate: "pre_input" | "pre_phase" | "pre_tool" | "post_tool" | "pre_output";
    trigger: HookTrigger;
    entityType: string;
    entityId: string;
    outcome: "allowed" | "blocked" | "approval_required";
    phaseId?: string;
    blockedReason?: string;
    patch?: Record<string, unknown>;
    approvalRequired?: boolean;
  },
): Promise<void> {
  // Evidence writing is best-effort: a failure here must never alter the gate's own
  // allow/block/approval outcome (e.g. mask the hook's blocked reason thrown by the caller).
  try {
    await persistRunEvent(host, run, "policy.checked", {
      gate: input.gate,
      trigger: input.trigger,
      entityType: input.entityType,
      entityId: input.entityId,
      outcome: input.outcome,
      phaseId: input.phaseId,
      blockedReason: input.blockedReason === undefined ? undefined : boundRunError(input.blockedReason),
      patchKeys: input.patch ? Object.keys(input.patch).sort() : [],
      approvalRequired: input.approvalRequired ?? false,
    });
  } catch {
    // Best-effort policy evidence is observability only; swallow persistence errors so run control flow is unchanged.
  }
}

async function publishRunRealtime(
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
): Promise<void> {
  await publishOrchestrationRealtime(host, {
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
  const durable = await host.createDurableRun(
    {
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
        lifecycleState: "ownership_setup",
      }),
    },
    { initialStatus: "paused" },
  );
  if (durable.status !== "paused") {
    await cancelUnusedDurableRun(host, run, durable.runId);
    throw new Error("Orchestration ownership durable run was not created paused.");
  }
  const link = await commitRunIfUnchanged(host, run, {
    ...run,
    workspaceId,
    durableRunId: durable.runId,
    executionState: "worktree_allocating",
    worktreeStatus: "allocating",
    worktreeBaseRef: run.worktreeBaseRef ?? DEFAULT_WORKTREE_BASE_REF,
  });
  if (!link.committed) {
    // The run changed before it was linked (for example it was cancelled);
    // cancel the durable run created for it rather than leave it paused.
    await cancelUnusedDurableRun(host, link.run, durable.runId);
    return link.run;
  }
  let linked = link.run;

  await persistCheckpoint(
    host,
    plan,
    linked,
    "durable_run_linked",
    buildCheckpointDetails(plan, linked, durable.runId, {
      workflowKey: "orchestration.plan.execute",
    }),
  );
  await persistRunEvent(host, linked, "run.durable_linked", {
    durableRunId: durable.runId,
    workspaceId,
  });
  await publishRunRealtime(host, plan, linked, { event: "durable_run_linked" });

  try {
    const worktree = await runtime.worktrees.allocate({
      runId: linked.runId,
      workspaceId,
      baseRef: linked.worktreeBaseRef ?? DEFAULT_WORKTREE_BASE_REF,
    });
    const allocatedWorktree = {
      worktreePath: worktree.worktreePath,
      worktreeStatus: worktree.worktreeStatus,
      worktreeBaseRef: worktree.worktreeBaseRef,
      worktreeLeaseOwnerId: worktree.worktreeLeaseOwnerId,
      worktreeLeaseGeneration: worktree.worktreeLeaseGeneration,
      worktreeLeaseExpiresAt: worktree.worktreeLeaseExpiresAt,
    };
    const ready = await commitRunIfUnchanged(host, linked, {
      ...linked,
      ...allocatedWorktree,
      executionState: "worktree_ready",
    });
    if (!ready.committed) {
      // Cancelled while the worktree was being allocated: give the worktree
      // back instead of recording it on a run that will never use it.
      await releaseOrchestrationWorktreeIfAvailable(
        runtime,
        host,
        { ...ready.run, ...allocatedWorktree },
        releaseReasonFor(ready.run),
      );
      return ready.run;
    }
    linked = ready.run;
    await host.updateDurableRunState({
      runId: durable.runId,
      metadata: buildDurableMetadata(plan, linked, {
        lifecycleState: "worktree_ready",
      }),
    });
    await persistCheckpoint(
      host,
      plan,
      linked,
      "worktree_allocated",
      buildCheckpointDetails(plan, linked, durable.runId),
    );
    await persistRunEvent(host, linked, "run.worktree_allocated", {
      worktreePath: linked.worktreePath,
      worktreeStatus: linked.worktreeStatus,
      worktreeBaseRef: linked.worktreeBaseRef,
      worktreeLeaseOwnerId: linked.worktreeLeaseOwnerId,
      worktreeLeaseGeneration: linked.worktreeLeaseGeneration,
      worktreeLeaseExpiresAt: linked.worktreeLeaseExpiresAt,
    });
    await publishRunRealtime(host, plan, linked, { event: "worktree_allocated" });
    return linked;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to allocate orchestration worktree.";
    let failed!: OrchestrationRun;
    let transitioned = false;
    await host.storage.runImmediateTransaction(async () => {
      const committed = await commitRunIfUnchanged(host, linked, {
        ...linked,
        status: "failed",
        executionState: "failed",
        worktreeStatus: "blocked",
        lastError: message,
        endedAt: new Date().toISOString(),
      });
      failed = committed.run;
      if (!committed.committed) {
        // The run already moved on (for example it was cancelled); leave it.
        return;
      }
      transitioned = true;
      await host.updateDurableRunState({
        runId: durable.runId,
        status: "failed",
        metadata: buildDurableMetadata(plan, failed, {
          lifecycleState: "worktree_failed",
        }),
        lastError: message,
        finishedAt: failed.endedAt,
      });
      await host.recordDurableTimelineEvent(durable.runId, "run_failed", {
        reason: message,
        phase: "worktree_allocation",
      });
      await persistCheckpoint(
        host,
        plan,
        failed,
        "run_failed",
        buildCheckpointDetails(plan, failed, durable.runId, {
          error: message,
        }),
      );
    });
    if (!transitioned) {
      return failed;
    }
    await persistRunEvent(host, failed, "run.failed", {
      error: message,
      phase: "worktree_allocation",
    });
    await publishRunRealtime(host, plan, failed, { event: "run_failed", error: message });
    return failed;
  }
}

/**
 * Commits `next` only while the run still has `current`'s status and
 * execution state, so a concurrent cancel is never overwritten. Returns the
 * committed run, or the run as it is now when it changed underneath.
 */
async function commitRunIfUnchanged(
  host: OrchestrationLifecycleHost,
  current: OrchestrationRun,
  next: OrchestrationRun,
): Promise<{ run: OrchestrationRun; committed: boolean }> {
  const updated = await host.storage.orchestration.updateRunIfCurrentState(next, {
    status: current.status,
    executionState: current.executionState,
  });
  return updated
    ? { run: updated, committed: true }
    : { run: await host.storage.orchestration.getRun(current.runId), committed: false };
}

/** Cancels an unstarted durable run that its orchestration run will never use. */
async function cancelUnusedDurableRun(
  host: OrchestrationLifecycleHost,
  run: OrchestrationRun,
  durableRunId: string,
): Promise<boolean> {
  try {
    await host.cancelDurableRun(durableRunId, "orchestration");
    return true;
  } catch (error) {
    // Operator cancellation can commit and then fail while publishing its
    // after-commit event. The durable row, not the thrown error, is authority.
    let durableStatus: DurableRunRecord["status"] | undefined;
    try {
      const current = await host.getDurableRun(durableRunId);
      durableStatus = current.status;
      if (current.status === "cancelled") {
        return true;
      }
    } catch {
      // Keep the original failure as the diagnostic if the reread also fails.
    }
    await persistRunEvent(host, run, "run.durable_cleanup_failed", {
      durableRunId,
      durableStatus,
      error: boundRunError(error instanceof Error ? error.message : String(error)),
    });
    return false;
  }
}

function releaseReasonFor(run: OrchestrationRun): "completed" | "failed" | "stopped_by_limit" | "cancelled" {
  return run.status === "completed" || run.status === "failed" || run.status === "stopped_by_limit"
    ? run.status
    : "cancelled";
}

/**
 * Atomically reserves the single active run row for a plan.
 *
 * ORCH-001: two concurrent starts for the same plan/workspace can both observe
 * "no active run" and each insert a run, producing duplicate worktrees and
 * doubled cost. To close that race, the active-run re-check and the run-row
 * insert are performed together inside a single awaited IMMEDIATE transaction.
 * The callback may await database operations but remains side-effect free with
 * respect to the filesystem, git, and durable worker — worktree allocation and
 * durable-run setup happen OUTSIDE the transaction.
 *
 * Returns `{ created: false }` with the pre-existing active run when the guard
 * detects a concurrently (or previously) created run, so callers can behave
 * idempotently instead of duplicating work.
 */
async function createOrchestrationRunRecord(
  host: OrchestrationLifecycleHost,
  plan: OrchestrationPlan,
  workspaceId: string,
  policyContext: OrchestrationRunPolicyContext,
): Promise<{ created: boolean; run: OrchestrationRun }> {
  // `upsertPlan` is idempotent on (planId, workspaceId) and `engine.createRun`
  // is a pure computation, so both can run outside the transaction.
  await host.storage.orchestration.upsertPlan(plan, workspaceId);
  const candidate = host.orchestrationEngine.createRun(plan);

  return await host.storage.runImmediateTransaction(async () => {
    const existing = await host.storage.orchestration.findActiveRunByPlan(plan.planId, workspaceId);
    if (existing) {
      return { created: false, run: existing };
    }
    const persisted = await host.storage.orchestration.createRun({
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
  const { created, run } = await createOrchestrationRunRecord(host, plan, workspaceId, policyContext);
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
  const plan = await host.storage.orchestration.getPlan(planId, workspaceId);
  host.orchestrationEngine.validate(plan);
  const activeRun = await host.storage.orchestration.findActiveRunByPlan(planId, workspaceId);
  if (activeRun) {
    return resumeExistingActiveRun(host, runtime, plan, activeRun);
  }

  const { created, run } = await createOrchestrationRunRecord(host, plan, workspaceId, policyContext);
  if (!created) {
    // Lost the create race to a concurrent start: adopt the active run the
    // winner inserted instead of queueing a second durable run.
    return resumeExistingActiveRun(host, runtime, plan, run);
  }

  const allocated = await finishOrchestrationRunCreation(host, runtime, plan, run);
  // Allocation can end the run (failed, or cancelled while allocating).
  if (isOrchestrationRunTerminal(allocated) || allocated.executionState !== "worktree_ready") {
    return allocated;
  }

  return queueOrchestrationRun(host, runtime, plan, allocated);
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
  await persistCheckpoint(host, plan, run, "run_created", buildCheckpointDetails(plan, run));
  await persistRunEvent(host, run, "run.created", {
    status: run.status,
    executionState: run.executionState,
  });
  await publishRunRealtime(host, plan, run, { event: "run_created" });

  return await allocateOrchestrationOwnership(host, runtime, plan, run);
}

function isInterruptedQueueResume(owner: OrchestrationRun | undefined, durable: DurableRunRecord | undefined): boolean {
  const payload =
    durable?.workflowKey === "orchestration.plan.execute" ? parseOrchestrationWorkflowPayload(durable) : undefined;
  return Boolean(
    owner &&
    durable &&
    payload &&
    owner.status === "queued" &&
    owner.executionState === "queued" &&
    owner.worktreeStatus === "ready" &&
    owner.worktreePath &&
    owner.durableRunId === durable.runId &&
    durable.status === "paused" &&
    durable.startedAt === undefined &&
    payload.orchestrationRunId === owner.runId &&
    payload.planId === owner.planId &&
    payload.workspaceId === (owner.workspaceId ?? DEFAULT_WORKSPACE_ID),
  );
}

/** Repairs only the initial pause left by a crash after the queue commit. */
async function recoverInterruptedQueueResume(
  host: OrchestrationLifecycleHost,
  owner: OrchestrationRun,
  durable: DurableRunRecord,
): Promise<boolean> {
  if (!isInterruptedQueueResume(owner, durable)) {
    return false;
  }
  const currentOwner = await getOrchestrationRunIfAvailable(host, owner.runId);
  const currentDurable = await getDurableRunIfAvailable(host, durable.runId);
  if (!currentOwner || !currentDurable || !isInterruptedQueueResume(currentOwner, currentDurable)) {
    return false;
  }
  try {
    await host.resumeDurableRun(durable.runId, "orchestration_recovery");
  } catch (error) {
    const racedOwner = await getOrchestrationRunIfAvailable(host, owner.runId);
    const racedDurable = await getDurableRunIfAvailable(host, durable.runId);
    if (!racedOwner || !racedDurable || isOrchestrationRunTerminal(racedOwner) || isDurableRunTerminal(racedDurable)) {
      return false;
    }
    if (
      racedOwner.durableRunId !== durable.runId ||
      racedOwner.planId !== owner.planId ||
      (racedOwner.workspaceId ?? DEFAULT_WORKSPACE_ID) !== (owner.workspaceId ?? DEFAULT_WORKSPACE_ID) ||
      racedDurable.startedAt === undefined
    ) {
      throw error;
    }
    if (racedOwner.status !== "queued" || racedOwner.executionState !== "queued" || racedDurable.status !== "queued") {
      // Another resume already advanced this run, possibly into a later pause.
      return true;
    }
  }
  await persistRunEvent(host, currentOwner, "run.queue_resume_recovered", { durableRunId: durable.runId });
  await host.requestDurableRunProcessing(durable.runId);
  return true;
}

/**
 * Idempotently nudges an already-active run for a plan toward execution:
 * requeue a worktree-ready run, request processing for a queued run, or simply
 * return the active run unchanged. Shared by the fast-path active check and the
 * concurrent-create loser path so both behave identically.
 */
async function resumeExistingActiveRun(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  plan: OrchestrationPlan,
  activeRun: OrchestrationRun,
): Promise<OrchestrationRun> {
  if (activeRun.durableRunId && activeRun.executionState === "queued") {
    const durable = await getDurableRunIfAvailable(host, activeRun.durableRunId);
    if (durable?.status === "paused") {
      await recoverInterruptedQueueResume(host, activeRun, durable);
      return await host.storage.orchestration.getRun(activeRun.runId);
    }
    await host.requestDurableRunProcessing(activeRun.durableRunId);
  }
  if (activeRun.durableRunId && activeRun.executionState === "worktree_ready") {
    return await queueOrchestrationRun(host, runtime, plan, activeRun);
  }
  return activeRun;
}

async function queueOrchestrationRun(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  planInput: OrchestrationPlan,
  run: OrchestrationRun,
): Promise<OrchestrationRun> {
  if (isOrchestrationRunTerminal(run)) {
    return run;
  }
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
  await persistPolicyGateEvent(host, run, {
    gate: "pre_input",
    trigger: "orchestration.run.before",
    entityType: "orchestration_run",
    entityId: run.runId,
    outcome: runBeforeHook.blockedBy ? "blocked" : "allowed",
    blockedReason: runBeforeHook.blockedBy?.reason,
    patch: runBeforeHook.patch,
  });
  if (runBeforeHook.blockedBy) {
    return await failRunBlockedByHook(host, runtime, plan, run, runBeforeHook.blockedBy.reason);
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
    await host.storage.orchestration.upsertPlan(plan, run.workspaceId ?? DEFAULT_WORKSPACE_ID);
  }

  const queuedCommit = await commitRunIfUnchanged(host, run, {
    ...run,
    executionState: "queued",
  });
  if (!queuedCommit.committed) {
    // The run moved on before it was queued (for example it was cancelled);
    // never resume its durable run.
    return queuedCommit.run;
  }
  const queued = queuedCommit.run;
  try {
    await host.resumeDurableRun(queued.durableRunId!, "orchestration");
  } catch (error) {
    // A cancel that lands between queueing and resuming wins.
    const current = await host.storage.orchestration.getRun(queued.runId);
    if (isOrchestrationRunTerminal(current)) {
      return current;
    }
    const durable = await getDurableRunIfAvailable(host, queued.durableRunId!);
    if (durable?.status !== "queued" && durable?.status !== "running") {
      throw error;
    }
  }
  const current = await host.storage.orchestration.getRun(queued.runId);
  const durable = await getDurableRunIfAvailable(host, queued.durableRunId!);
  if (current.status !== "queued" || current.executionState !== "queued" || durable?.status !== "queued") {
    return current;
  }
  // The worker may claim the durable immediately after this read. Never replace
  // its metadata here: it may already hold a child-dispatch recovery breadcrumb.
  await persistCheckpoint(host, plan, queued, "run_queued", buildCheckpointDetails(plan, queued));
  await persistRunEvent(host, queued, "run.queued", {
    durableRunId: queued.durableRunId,
    worktreePath: queued.worktreePath,
  });
  await publishRunRealtime(host, plan, queued, { event: "run_queued" });

  if (host.config.assistant.memory.enabled && host.config.assistant.memory.qmd.applyToOrchestration) {
    await host.scheduleOrchestrationMemoryContext(plan, queued);
  }

  if (queued.durableRunId) {
    await host.requestDurableRunProcessing(queued.durableRunId);
  }

  return queued;
}

/**
 * Ends a run that an `orchestration.run.before` hook refused to start: the run
 * fails with the hook's reason, its paused durable run is cancelled, and its
 * worktree is released. Throws a conflict that carries the reason.
 */
async function failRunBlockedByHook(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  reason: string,
): Promise<never> {
  const message = boundRunError(`Blocked by orchestration.run.before hook: ${reason}`);
  const blocked = await commitRunIfUnchanged(host, run, {
    ...run,
    status: "failed",
    executionState: "failed",
    endedAt: new Date().toISOString(),
    lastError: message,
  });
  if (blocked.committed) {
    const failed = blocked.run;
    if (failed.durableRunId) {
      await cancelUnusedDurableRun(host, failed, failed.durableRunId);
    }
    await persistCheckpoint(
      host,
      plan,
      failed,
      "run_failed",
      buildCheckpointDetails(plan, failed, failed.durableRunId, { error: message, reason: "run_before_hook_blocked" }),
    );
    await persistRunEvent(host, failed, "run.failed", { error: message, reason: "run_before_hook_blocked" });
    await publishRunRealtime(host, plan, failed, { event: "run_failed", error: message });
    await releaseOrchestrationWorktreeIfAvailable(runtime, host, failed, "failed");
  }
  throw new ConflictError({ message, details: { runId: run.runId, planId: plan.planId } });
}

export async function approvePhase(
  host: OrchestrationLifecycleHost,
  runId: string,
  phaseId: string,
  approvedBy: string,
  costIncrementUsd = 0,
  workspaceId?: string,
): Promise<{ run: OrchestrationRun; checkpoints: OrchestrationCheckpoint[] }> {
  // Approval lets the phase run; its cost is measured when it executes. An
  // operator-supplied cost would let the approver move the plan budgets.
  if (costIncrementUsd !== 0) {
    throw new ValidationError({
      message: "costIncrementUsd is no longer accepted on phase approval; phase cost is measured from execution.",
    });
  }
  const run = assertRunWorkspaceAccess(await host.storage.orchestration.getRun(runId), workspaceId);
  let plan = await host.storage.orchestration.getPlan(run.planId, run.workspaceId ?? DEFAULT_WORKSPACE_ID);
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
  // The run stays paused until the durable worker applies the approval, so a
  // repeated approval must be refused explicitly rather than by the status check.
  if (run.executionState === "resume_requested" || run.pendingApprovalPhaseId) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `Run ${run.runId} approval was already requested or the run state changed.`,
      details: { runId: run.runId, phaseId },
    });
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
  await persistPolicyGateEvent(host, run, {
    gate: "pre_phase",
    trigger: "orchestration.phase.before",
    entityType: "orchestration_phase",
    entityId: `${runId}:${phaseId}`,
    outcome: phaseBeforeHook.blockedBy ? "blocked" : "allowed",
    phaseId,
    blockedReason: phaseBeforeHook.blockedBy?.reason,
    patch: phaseBeforeHook.patch,
    approvalRequired: true,
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
    await host.storage.orchestration.upsertPlan(plan, run.workspaceId ?? DEFAULT_WORKSPACE_ID);
  }

  // Approval records intent only: the run stays paused and the durable worker,
  // which owns execution, applies the approval and runs the approved phase.
  const nextRun: OrchestrationRun = {
    ...run,
    executionState: "resume_requested",
    pendingApprovalPhaseId: phaseId,
    pendingApprovedBy: approvedBy,
    pendingCostIncrementUsd: undefined,
  };
  const persisted = await host.storage.orchestration.updateRunIfCurrentState(nextRun, {
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
    await host.updateDurableRunState({
      runId: persisted.durableRunId,
      metadata: buildDurableMetadata(plan, persisted, {
        lifecycleState: "resume_requested",
      }),
    });
  }

  await persistCheckpoint(
    host,
    plan,
    persisted,
    "phase_approved",
    buildCheckpointDetails(plan, persisted, undefined, {
      approvedBy,
    }),
  );
  await persistRunEvent(host, persisted, "phase.approved", {
    approvedBy,
    phaseId,
    resumeRequested: true,
  });
  await publishRunRealtime(host, plan, persisted, { event: "phase_approved", approvedBy });

  if (persisted.durableRunId) {
    await host.resumeDurableRun(persisted.durableRunId, "orchestration");
    await host.requestDurableRunProcessing(persisted.durableRunId);
  }

  return {
    run: persisted,
    checkpoints: await host.storage.orchestration.listCheckpoints(runId),
  };
}

export async function cancelOrchestrationRun(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  runId: string,
  actorId = "operator",
  workspaceId?: string,
): Promise<{ run: OrchestrationRun; checkpoints: OrchestrationCheckpoint[] }> {
  const run = assertRunWorkspaceAccess(await host.storage.orchestration.getRun(runId), workspaceId);
  const plan = await host.storage.orchestration.getPlan(run.planId, run.workspaceId ?? DEFAULT_WORKSPACE_ID);
  host.orchestrationEngine.validate(plan);
  const cancelled = await markOrchestrationRunCancelled(host, runtime, plan, run, actorId, `cancelled by ${actorId}`);
  return {
    run: cancelled,
    checkpoints: await host.storage.orchestration.listCheckpoints(runId),
  };
}

/**
 * Settles active orchestration runs whose linked durable run already ended
 * without the run being told: a workflow error that could not settle it, an
 * operator cancel through the durable API, a continuation gate, or a dead
 * letter. Without this their rows stay queued, running or paused.
 */
export async function reconcileTerminalOrchestrationRuns(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  limit = 200,
): Promise<void> {
  const activeRuns = (await host.storage.orchestration.listActiveRunsWithEndedDurableRun?.(limit)) ?? [];
  const failures: unknown[] = [];
  for (const run of activeRuns) {
    try {
      const linked = run.durableRunId ? await getDurableRunIfAvailable(host, run.durableRunId) : undefined;
      if (!linked || !isDurableRunTerminal(linked)) {
        continue;
      }
      const plan = await host.storage.orchestration.getPlan(run.planId, run.workspaceId ?? DEFAULT_WORKSPACE_ID);
      await commitLinkedDurableTerminalWinner(host, runtime, plan, run, linked, {
        reconciledBy: "orchestration_terminal_reconciler",
      });
    } catch (error) {
      // One unreadable run must not starve the others; report after the scan.
      failures.push(error);
    }
  }
  // Ownership setup has two crash gaps: a created run before its durable is
  // linked, and a paused durable before its owner is linked. A complete sweep
  // per recovery pass avoids losing a volatile page cursor on gateway restart.
  // Throttle the sweep because this reconciler also runs on the worker poll.
  const now = Date.now();
  const lastScan = ownershipRecoveryLastScanByStorage.get(host.storage);
  if (lastScan !== undefined && now >= lastScan && now - lastScan < OWNERSHIP_RECOVERY_INTERVAL_MS) {
    if (failures.length > 0) {
      throw new AggregateError(failures, "Orchestration recovery could not settle every run.");
    }
    return;
  }
  ownershipRecoveryLastScanByStorage.set(host.storage, now);
  const pageSize = Math.max(1, Math.min(200, Math.floor(limit)));
  const listUnlinked = host.storage.orchestration.listUnlinkedCreatedRuns;
  if (!listUnlinked) {
    failures.push(new Error("Unlinked orchestration ownership recovery is unavailable."));
  } else {
    let afterRunId: string | undefined;
    try {
      for (;;) {
        const page = await listUnlinked.call(host.storage.orchestration, pageSize, afterRunId);
        for (const run of page) {
          try {
            const startedAt = Date.parse(run.startedAt);
            if (!Number.isFinite(startedAt) || now - startedAt < OWNERSHIP_SETUP_GRACE_MS) {
              continue;
            }
            const message = "Orchestration ownership setup was interrupted before its durable run was linked.";
            const stopped = await commitRunIfUnchanged(host, run, {
              ...run,
              status: "failed",
              executionState: "failed",
              worktreeStatus: "blocked",
              endedAt: new Date(now).toISOString(),
              lastError: message,
            });
            if (!stopped.committed) {
              continue;
            }
            const plan = await host.storage.orchestration.getPlan(run.planId, run.workspaceId ?? DEFAULT_WORKSPACE_ID);
            await persistCheckpoint(
              host,
              plan,
              stopped.run,
              "run_failed",
              buildCheckpointDetails(plan, stopped.run, undefined, {
                error: message,
                reason: "ownership_setup_interrupted",
              }),
            );
            await persistRunEvent(host, stopped.run, "run.failed", {
              error: message,
              reason: "ownership_setup_interrupted",
            });
            await publishRunRealtime(host, plan, stopped.run, { event: "run_failed", error: message });
          } catch (error) {
            failures.push(error);
          }
        }
        if (page.length < pageSize) {
          break;
        }
        afterRunId = page[page.length - 1]!.runId;
      }
    } catch (error) {
      failures.push(error);
    }
  }

  const listUnstarted = host.storage.durableRuns.listUnstartedOrchestrationRunIds;
  if (!listUnstarted) {
    failures.push(new Error("Unstarted orchestration durable-run recovery is unavailable."));
  } else {
    let afterRunId: string | undefined;
    try {
      for (;;) {
        const page = await listUnstarted.call(host.storage.durableRuns, pageSize, afterRunId);
        for (const durableRunId of page) {
          try {
            const durable = await getDurableRunIfAvailable(host, durableRunId);
            const payload =
              (durable?.status === "queued" || durable?.status === "paused") &&
              durable.workflowKey === "orchestration.plan.execute"
                ? parseOrchestrationWorkflowPayload(durable)
                : undefined;
            if (!payload) {
              continue;
            }
            const owner = await getOrchestrationRunIfAvailable(host, payload.orchestrationRunId);
            if (owner && durable && (await recoverInterruptedQueueResume(host, owner, durable))) {
              continue;
            }
            if (
              !owner ||
              (owner.status !== "cancelled" && owner.status !== "failed") ||
              owner.planId !== payload.planId ||
              (owner.workspaceId ?? DEFAULT_WORKSPACE_ID) !== payload.workspaceId ||
              (owner.durableRunId && owner.durableRunId !== durableRunId)
            ) {
              continue;
            }
            if (!(await cancelUnusedDurableRun(host, owner, durableRunId))) {
              failures.push(new Error(`Unstarted orchestration durable run ${durableRunId} still needs cleanup.`));
            }
          } catch (error) {
            failures.push(error);
          }
        }
        if (page.length < pageSize) {
          break;
        }
        afterRunId = page[page.length - 1]!;
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Orchestration recovery could not settle every run.");
  }
}

/**
 * The durable outcome for an orchestration run that is already terminal. A
 * cancelled run cancels its durable run, since the worker does not settle a
 * cancelled outcome itself.
 */
async function settleDurableRunForTerminalOrchestrationRun(
  host: OrchestrationLifecycleHost,
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  durableRun: DurableRunRecord,
): Promise<OrchestrationExecutionResult> {
  const checkpointState = buildCheckpointDetails(plan, run, durableRun.runId, { alreadyTerminal: run.status });
  if (run.status === "cancelled") {
    await host.cancelDurableRun(durableRun.runId, "orchestration");
    return { outcome: "cancelled", checkpointState };
  }
  return { outcome: run.status === "failed" ? "failed" : "completed", checkpointState };
}

/**
 * Settles the orchestration run linked to a durable orchestration run that has
 * just ended, such as one the durable worker failed after its workflow threw.
 * It runs only after the durable run's own terminal transition has committed,
 * so an orchestration run never ends ahead of its durable run; if the durable
 * transition did not happen (an operator pause or cancel took the lease
 * first), the orchestration run is left to that owner. The terminal reconciler
 * retries anything this misses.
 */
export async function settleOrchestrationRunForEndedDurableRun(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  durableRun: DurableRunRecord,
  details: Record<string, unknown>,
): Promise<void> {
  if (!isDurableRunTerminal(durableRun)) {
    return;
  }
  const payload = parseOrchestrationWorkflowPayload(durableRun);
  if (!payload) {
    return;
  }
  const run = await getOrchestrationRunIfAvailable(host, payload.orchestrationRunId);
  if (!run || run.durableRunId !== durableRun.runId || isOrchestrationRunTerminal(run)) {
    return;
  }
  const plan = await host.storage.orchestration.getPlan(run.planId, run.workspaceId ?? DEFAULT_WORKSPACE_ID);
  await commitLinkedDurableTerminalWinner(host, runtime, plan, run, durableRun, details);
}

/** Server-owned records read to decide whether a parked phase's child has settled. */
export interface OrchestrationPhaseChildWakeHost {
  readonly storage: {
    orchestration: Pick<OrchestrationLifecycleHost["storage"]["orchestration"], "getRun">;
    durableRuns: Pick<Storage["durableRuns"], "listRunIdsByStatus">;
    durableChildWatchers: Pick<Storage["durableChildWatchers"], "getByPair">;
    chatTurnTraces: Pick<Storage["chatTurnTraces"], "get">;
  };
  getDurableRun(runId: string): Promise<DurableRunRecord>;
  wakeDurableRun(
    runId: string,
    event: { eventKey: string; correlationId?: string; payload?: Record<string, unknown> },
  ): Promise<{ outcome: string }>;
}

/**
 * Wakes the orchestration run whose parked phase waits on this durable Chat
 * run. `orchestrationRunId` is the child's admitted policy run id. The parent
 * wakes only when it registered exactly this child (wait correlation, phase
 * breadcrumb and watcher agree) and the child has settled.
 */
export async function wakeOrchestrationPhaseParent(
  host: OrchestrationPhaseChildWakeHost,
  childRunId: string,
  orchestrationRunId: string | undefined,
): Promise<boolean> {
  const runId = orchestrationRunId?.trim();
  if (!runId) {
    return false;
  }
  const run = await getOrchestrationRunIfAvailable(host, runId);
  if (!run?.durableRunId || run.executionState !== "waiting_for_child") {
    return false;
  }
  const parent = await getDurableRunIfAvailable(host, run.durableRunId);
  return parent ? await wakeParkedOrchestrationPhase(host, parent, run, childRunId) : false;
}

/**
 * Catches up wakes that were missed, for example when a child settled before
 * its parent finished parking or the gateway restarted in between.
 */
export async function reconcileWaitingOrchestrationPhases(host: OrchestrationPhaseChildWakeHost): Promise<void> {
  const failures: unknown[] = [];
  for (const runId of await host.storage.durableRuns.listRunIdsByStatus("waiting")) {
    try {
      const parent = await getDurableRunIfAvailable(host, runId);
      const childRunId = parent ? readPhaseChildWaitCorrelation(parent) : undefined;
      const payload = parent && childRunId ? parseOrchestrationWorkflowPayload(parent) : undefined;
      if (!parent || !childRunId || !payload) {
        continue;
      }
      const run = await getOrchestrationRunIfAvailable(host, payload.orchestrationRunId);
      if (run) {
        await wakeParkedOrchestrationPhase(host, parent, run, childRunId);
      }
    } catch (error) {
      // One unreadable parent must not starve the others; report after the scan.
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Orchestration phase wake reconciliation could not check every parked run.");
  }
}

async function wakeParkedOrchestrationPhase(
  host: OrchestrationPhaseChildWakeHost,
  parent: DurableRunRecord,
  run: OrchestrationRun,
  childRunId: string,
): Promise<boolean> {
  if (
    parent.status !== "waiting" ||
    readPhaseChildWaitCorrelation(parent) !== childRunId ||
    run.durableRunId !== parent.runId ||
    run.executionState !== "waiting_for_child" ||
    !run.currentPhaseId
  ) {
    return false;
  }
  const phase = readRecoverableChildPhase(parent, run.currentPhaseId);
  if (phase?.childRunId !== childRunId) {
    return false;
  }
  const watcher = await host.storage.durableChildWatchers.getByPair(parent.runId, childRunId);
  if (watcher?.source !== "orchestration_phase") {
    return false;
  }
  if (!(await isPhaseChildSettled(host, childRunId, asString(phase.payload.childTurnId)))) {
    return false;
  }
  const result = await host.wakeDurableRun(parent.runId, {
    eventKey: ORCHESTRATION_PHASE_CHILD_WAKE_EVENT,
    correlationId: childRunId,
    payload: { orchestrationRunId: run.runId, phaseId: run.currentPhaseId },
  });
  return result.outcome === "woke";
}

/**
 * A phase child has settled once it cannot produce more phase output on its
 * own: its durable run ended (or is gone), or its turn finished or stopped to
 * ask for user input. A child waiting on an approval is still working; the
 * operator resolves that approval in Chat.
 */
async function isPhaseChildSettled(
  host: OrchestrationPhaseChildWakeHost,
  childRunId: string,
  childTurnId: string | undefined,
): Promise<boolean> {
  const child = await getDurableRunIfAvailable(host, childRunId);
  if (!child || isDurableRunTerminal(child)) {
    return true;
  }
  if (!childTurnId) {
    return false;
  }
  let traceStatus: ChatTurnTraceRecord["status"];
  try {
    traceStatus = (await host.storage.chatTurnTraces.get(childTurnId)).status;
  } catch (error) {
    if (error instanceof NotFoundError) {
      return false;
    }
    throw error;
  }
  return traceStatus === "waiting_for_user_input" || isChatTurnTerminalStatus(traceStatus);
}

function readPhaseChildWaitCorrelation(run: DurableRunRecord): string | undefined {
  const wait = asRecord(asRecord(run.metadata)?.waitForEvent);
  return wait?.eventKey === ORCHESTRATION_PHASE_CHILD_WAKE_EVENT ? asString(wait.correlationId) : undefined;
}

async function getOrchestrationRunIfAvailable(
  host: { readonly storage: { orchestration: { getRun(runId: string): Promise<OrchestrationRun> } } },
  runId: string,
): Promise<OrchestrationRun | undefined> {
  try {
    return await host.storage.orchestration.getRun(runId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return undefined;
    }
    throw error;
  }
}

export async function executeDurableOrchestrationRun(
  host: OrchestrationLifecycleHost,
  runtime: OrchestrationLifecycleRuntimeDeps,
  durableRun: DurableRunRecord,
  context?: DurableWorkflowExecutionContext,
): Promise<OrchestrationExecutionResult> {
  throwIfWorkflowAborted(context);
  const expectedLeaseOwnerId = requireDurableExecutionLeaseOwner(durableRun);
  const payload = parseOrchestrationWorkflowPayload(durableRun);
  if (!payload) {
    const malformedWorkspacePayload = readMalformedWorkspacePayload(durableRun);
    if (malformedWorkspacePayload) {
      const run = await host.storage.orchestration.getRun(malformedWorkspacePayload.orchestrationRunId);
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
  let run = await host.storage.orchestration.getRun(payload.orchestrationRunId);
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
  const plan = await host.storage.orchestration.getPlan(payload.planId, runWorkspaceId);
  host.orchestrationEngine.validate(plan);
  if (isOrchestrationRunTerminal(run)) {
    // The run already ended, but its durable run did not: something (such as
    // an operator pause) took the lease between the two terminal writes. Settle
    // the durable run to the run's outcome without executing anything.
    return await settleDurableRunForTerminalOrchestrationRun(host, plan, run, durableRun);
  }
  run = await runtime.worktrees.ensureLeaseForExecution(run);
  const worktreeExecutionFence = readOrchestrationWorktreeExecutionFence(run);
  const policyContext: OrchestrationRunPolicyContext = {
    operatorId: payload.operatorId ?? run.operatorId,
    authActorId: payload.authActorId ?? run.authActorId,
    authActorSource: payload.authActorSource ?? run.authActorSource,
    permissionProfileId: payload.permissionProfileId ?? run.permissionProfileId,
    localOperatorOverrideId: payload.localOperatorOverrideId ?? run.localOperatorOverrideId,
  };

  const recordUpdate = async (
    next: OrchestrationRun,
    checkpointKind?: OrchestrationCheckpoint["checkpointKind"],
    checkpointExtras: Record<string, unknown> = {},
    commitOptions: OrchestrationDurableCommitOptions = {},
  ): Promise<void> => {
    let committedRun!: OrchestrationRun;
    await host.storage.runImmediateTransaction(async () => {
      await lockFreshDurableExecutionLease(host, durableRun.runId, expectedLeaseOwnerId);
      await assertFreshOrchestrationWorktreeExecutionFence(host, run.runId, worktreeExecutionFence);
      await host.updateDurableRunState({
        runId: durableRun.runId,
        metadata: commitOptions.durableMetadata ?? {
          ...buildDurableMetadata(plan, next),
          ...(commitOptions.durableMetadataExtras ?? {}),
        },
        expectedLeaseOwnerId,
        ...(commitOptions.durableState ?? {}),
      });
      committedRun = await host.storage.orchestration.updateRun(next);
      if (checkpointKind) {
        await persistCheckpoint(
          host,
          plan,
          committedRun,
          checkpointKind,
          buildCheckpointDetails(plan, committedRun, durableRun.runId, checkpointExtras),
        );
      }
      if (commitOptions.durableTimeline) {
        await host.recordDurableTimelineEvent(
          durableRun.runId,
          commitOptions.durableTimeline.eventType,
          commitOptions.durableTimeline.payload,
        );
      }
    });
    run = committedRun;
  };
  let harvestedWaitingExecution: OrchestrationPhaseExecutionResult | undefined;

  if (run.executionState === "resume_requested") {
    if (!run.pendingApprovalPhaseId || !run.pendingApprovedBy) {
      throw new Error(`Run ${run.runId} is missing pending approval state for durable resume.`);
    }
    // Approvals recorded before approval became intent-only stored the run as
    // running; apply them to the paused run they were approving.
    const pendingApproval: OrchestrationRun = run.status === "running" ? { ...run, status: "paused" } : run;
    // The engine keeps the approval marker on the run until the approved phase
    // has executed, so a crash mid-phase still advances it after recovery.
    const approved = host.orchestrationEngine.approvePhase(plan, pendingApproval, run.pendingApprovalPhaseId);
    if (approved.status !== "running" && approved.status !== "stopped_by_limit") {
      throw new Error(`Run ${run.runId} approval produced unexpected status ${approved.status}.`);
    }
    if (approved.status === "running") {
      const resumedRun: OrchestrationRun = {
        ...approved,
        executionState: "running",
        pendingCostIncrementUsd: undefined,
        lastError: undefined,
      };
      await recordUpdate(
        resumedRun,
        "run_resumed",
        {},
        {
          durableTimeline: {
            eventType: "run_resumed",
            payload: {
              phaseId: resumedRun.currentPhaseId,
              waveId: resumedRun.currentWaveId,
            },
          },
        },
      );
      await persistRunEvent(host, run, "run.resumed", {
        phaseId: run.currentPhaseId,
        waveId: run.currentWaveId,
      });
      await publishRunRealtime(host, plan, run, { event: "run_resumed" });
    } else {
      // A plan limit was reached while the run waited for approval. The
      // terminal section below records the stop without running the phase.
      run = { ...approved, lastError: undefined };
    }
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
      const childRun = await getDurableRunIfAvailable(host, childRunId);
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
      // Prefer the child's canonical Chat records: they carry its output, its
      // full cost, and whether it stopped to ask for user input.
      const settledChild = await runtime.phaseExecutor.harvest?.({
        phaseId: run.currentPhaseId,
        ownerAgentId:
          asString(recoverableChildPhase.payload.ownerAgentId) ??
          findPhaseInPlan(plan, run.currentPhaseId).ownerAgentId,
        childRunId,
        childSessionId: asString(recoverableChildPhase.payload.childSessionId),
        childTurnId: asString(recoverableChildPhase.payload.childTurnId),
        startedAt: asString(recoverableChildPhase.payload.startedAt),
        prompt: asPromptReference(recoverableChildPhase.payload.prompt),
      });
      if (settledChild) {
        harvestedWaitingExecution = settledChild;
      } else if (isDurableRunTerminal(childRun)) {
        harvestedWaitingExecution = buildHarvestedWaitingExecution(recoverableChildPhase.payload, childRun);
      } else {
        // The child is still working. Park again on the child wake: a wake clears
        // waitForEvent, and a run parked without one refuses keyed wakes.
        const waitForEvent = { eventKey: ORCHESTRATION_PHASE_CHILD_WAKE_EVENT, correlationId: childRunId };
        await recordUpdate(
          { ...run, executionState: "waiting_for_child" },
          undefined,
          {},
          {
            durableState: {
              status: "waiting",
              clearFinishedAt: true,
              clearLastError: true,
              clearLease: true,
            },
            durableMetadata: {
              ...(durableRun.metadata ?? {}),
              waitingPhase: recoverableChildPhase.payload,
              waitForEvent,
            },
            durableTimeline: {
              eventType: "run_waiting",
              payload: {
                phaseId: run.currentPhaseId,
                waveId: run.currentWaveId,
                childRunId,
                reason: "child_durable_run_not_terminal",
              },
            },
          },
        );
        await host.requestDurableRunProcessing(childRunId);
        await persistRunEvent(host, run, "run.waiting_for_child", {
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
    }
    const resumedFromChild = isApprovalResume || Boolean(recoverableChildPhase);
    const resumedRun: OrchestrationRun = {
      ...run,
      executionState: "running",
      lastError: undefined,
    };
    const resumeCommit: OrchestrationDurableCommitOptions = {};
    if (recoverableChildPhase) {
      // Keep the child breadcrumb until the phase advance (or failure) commits:
      // an interruption before then must harvest this child again, never
      // dispatch the phase a second time.
      resumeCommit.durableMetadataExtras = {
        [recoverableChildPhase.breadcrumbKey]: recoverableChildPhase.payload,
      };
    }
    if (resumedFromChild) {
      resumeCommit.durableTimeline = {
        eventType: "run_resumed",
        payload: {
          phaseId: resumedRun.currentPhaseId,
          waveId: resumedRun.currentWaveId,
          resumedFrom: "child_phase_wait",
        },
      };
    }
    await recordUpdate(
      resumedRun,
      resumedFromChild ? "run_resumed" : undefined,
      {
        resumedFrom,
      },
      resumeCommit,
    );
    if (resumedFromChild) {
      await persistRunEvent(host, run, "run.resumed", {
        phaseId: run.currentPhaseId,
        waveId: run.currentWaveId,
        resumedFrom: "child_phase_wait",
      });
      await publishRunRealtime(host, plan, run, { event: "run_resumed" });
    }
  } else {
    const startedRun: OrchestrationRun = {
      ...host.orchestrationEngine.startRun(plan, run),
      executionState: "running",
      lastError: undefined,
    };
    await recordUpdate(
      startedRun,
      "run_started",
      {},
      {
        durableTimeline: {
          eventType: "run_started",
          payload: {
            phaseId: startedRun.currentPhaseId,
            waveId: startedRun.currentWaveId,
          },
        },
      },
    );
    await persistRunEvent(host, run, "run.started", {
      phaseId: run.currentPhaseId,
      waveId: run.currentWaveId,
    });
    await publishRunRealtime(host, plan, run, { event: "run_started" });
  }

  while (run.status === "running" && run.currentPhaseId) {
    if (context?.signal?.aborted) {
      const interruption = readDurableRecoveryInterruption(context);
      if (interruption) {
        throw interruption;
      }
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
    const harvested = harvestedWaitingExecution?.phaseId === previousPhaseId ? harvestedWaitingExecution : undefined;
    harvestedWaitingExecution = undefined;
    // A harvested phase already recorded its start when it dispatched the child.
    if (!harvested) {
      await persistRunEvent(host, run, "phase.started", {
        phaseId: previousPhaseId,
        waveId: previousWaveId,
        ownerAgentId: phase.ownerAgentId,
        specPath: phase.specPath,
      });
      await publishRunRealtime(host, plan, run, {
        event: "phase_started",
      });
    }

    let execution: OrchestrationPhaseExecutionResult;
    try {
      if (harvested) {
        execution = harvested;
      } else {
        execution = await runtime.phaseExecutor.execute({
          plan,
          run,
          phase,
          durableRun,
          policyContext,
          signal: context?.signal,
          onChildDispatched: async (dispatch) =>
            await persistDispatchedChildPhase(host, plan, run, durableRun, dispatch),
        });
      }
      throwIfWorkflowAborted(context);
    } catch (error) {
      if (!isWorkflowAbort(error, context)) {
        throw error;
      }
      const interruption = readDurableRecoveryInterruption(context, error);
      if (interruption) {
        throw interruption;
      }
      const timeout = readDurableWorkflowTimeout(context, error);
      if (timeout) {
        const failedAt = new Date().toISOString();
        execution = {
          phaseId: previousPhaseId,
          ownerAgentId: phase.ownerAgentId,
          status: "failed",
          startedAt: failedAt,
          finishedAt: failedAt,
          outputSummary: timeout.message,
          outputText: timeout.message,
          costUsd: 0,
          error: timeout.message,
        };
      } else {
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
    }
    const unsupportedWaitError =
      execution.status === "waiting" && !execution.childRunId
        ? "Phase child turn entered a wait state without a child durable run id; durable orchestration cannot resume an unlinked child wait."
        : undefined;
    const executionStatus = unsupportedWaitError ? "failed" : execution.status;
    // Cost a provider did not report is unknown, not zero. Record that so the
    // plan's cost limits are not mistaken for enforced on this phase.
    const costUnreported =
      executionStatus !== "waiting" && (execution.costUnreported === true || execution.costUsd === undefined);
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
      ...(costUnreported ? { costUnreported: true } : {}),
      inputTokens: execution.inputTokens,
      outputTokens: execution.outputTokens,
      citations: execution.citations,
      artifacts: execution.artifacts,
      prompt: execution.prompt,
      error: unsupportedWaitError ?? execution.error,
    };
    await persistRunEvent(
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
      // The phase's child turn was admitted and runs on its own durable run,
      // including any approval it waits on in Chat. Park this run so the single
      // durable worker can execute the child; the child settling wakes this run
      // to harvest it.
      const waitForEvent = { eventKey: ORCHESTRATION_PHASE_CHILD_WAKE_EVENT, correlationId: execution.childRunId! };
      await recordUpdate(
        {
          ...run,
          status: "running",
          executionState: "waiting_for_child",
          lastError: undefined,
        },
        undefined,
        {},
        {
          durableState: {
            status: "waiting",
            clearFinishedAt: true,
            clearLastError: true,
            clearLease: true,
          },
          durableMetadataExtras: {
            waitForEvent,
            waitingPhase: executionPayload,
          },
          durableTimeline: {
            eventType: "run_waiting",
            payload: {
              waitForEvent,
              phaseId: previousPhaseId,
              childSessionId: execution.childSessionId,
              childTurnId: execution.childTurnId,
              childRunId: execution.childRunId,
              approvalId: execution.approvalId,
            },
          },
        },
      );
      await publishRunRealtime(host, plan, run, {
        event: "phase_waiting",
      });
      await persistRunEvent(host, run, "run.waiting_for_child", {
        phaseId: run.currentPhaseId,
        waveId: run.currentWaveId,
        waitForEvent,
        childSessionId: execution.childSessionId,
        childTurnId: execution.childTurnId,
        childRunId: execution.childRunId,
        approvalId: execution.approvalId,
      });
      return {
        outcome: "paused",
        checkpointState: buildCheckpointDetails(plan, run, durableRun.runId, {
          waitingPhase: executionPayload,
          waitForEvent,
        }),
      };
    }

    if (executionStatus === "failed") {
      const phaseError = unsupportedWaitError ?? execution.error ?? `Phase ${previousPhaseId} failed.`;
      await recordUpdate(
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
        {
          durableTimeline: {
            eventType: "run_failed",
            payload: {
              phaseId: previousPhaseId,
              error: phaseError,
            },
          },
        },
      );
      await publishRunRealtime(host, plan, run, {
        event: "run_failed",
        error: phaseError,
      });
      // A child stopped for user input stays waiting; nothing will answer it now.
      await cancelOrphanedPhaseChild(host, run, execution.childRunId, "orchestration");
      await releaseOrchestrationWorktreeIfAvailable(runtime, host, run, "failed");
      return {
        outcome: "failed",
        checkpointState: buildCheckpointDetails(plan, run, durableRun.runId, {
          failedPhase: executionPayload,
        }),
      };
    }

    // Advancing consumes the approval marker, so read the approver first.
    const approvedBy = run.pendingApprovalPhaseId === previousPhaseId ? run.pendingApprovedBy : undefined;
    await recordUpdate(
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
    await persistRunEvent(host, run, "phase.advanced", {
      phaseId: previousPhaseId,
      nextPhaseId: run.currentPhaseId,
      nextWaveId: run.currentWaveId,
      costIncrementUsd: execution.costUsd ?? 0,
      ...(costUnreported ? { costUnreported: true } : {}),
      totalCostUsd: run.totalCostUsd,
    });
    if (approvedBy) {
      // The approval-gated phase has now run; its after-phase gate and hooks fire here, not at approval time.
      await persistPolicyGateEvent(host, run, {
        gate: "pre_output",
        trigger: "orchestration.phase.after",
        entityType: "orchestration_phase",
        entityId: `${run.runId}:${previousPhaseId}`,
        outcome: "allowed",
        phaseId: previousPhaseId,
        approvalRequired: true,
      });
      try {
        await host.hooksService.enqueueAfterHooks({
          workspaceId: run.workspaceId ?? DEFAULT_WORKSPACE_ID,
          trigger: "orchestration.phase.after",
          entityType: "orchestration_phase",
          entityId: `${run.runId}:${previousPhaseId}`,
          payload: {
            runId: run.runId,
            planId: plan.planId,
            phaseId: previousPhaseId,
            approvedBy,
            status: run.status,
            currentWaveId: run.currentWaveId,
            currentPhaseId: run.currentPhaseId,
            executionState: run.executionState,
          },
        });
      } catch (error) {
        // The phase advance is already committed. Failing the durable run here
        // would split it from the orchestration record, so record the missed
        // after-phase hooks where operators can see them and carry on.
        await persistRunEvent(host, run, "phase.after_hooks_failed", {
          phaseId: previousPhaseId,
          trigger: "orchestration.phase.after",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await publishRunRealtime(host, plan, run, {
      event: "phase_executed",
      nextWaveId: run.currentWaveId,
      nextPhaseId: run.currentPhaseId,
    });
    if (previousWaveId !== run.currentWaveId && run.currentWaveId) {
      await persistCheckpoint(
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
    await recordUpdate(
      {
        ...run,
        executionState: "paused_for_approval",
      },
      "run_paused_for_approval",
      {},
      {
        durableState: {
          status: "paused",
          clearFinishedAt: true,
          clearLastError: true,
          clearLease: true,
        },
        durableTimeline: {
          eventType: "run_paused",
          payload: {
            actorId: "orchestration",
            previousStatus: durableRun.status,
            phaseId: run.currentPhaseId,
          },
        },
      },
    );
    await persistRunEvent(host, run, "run.paused_for_approval", {
      phaseId: run.currentPhaseId,
      waveId: run.currentWaveId,
    });
    await publishRunRealtime(host, plan, run, { event: "run_paused_for_approval" });
    return {
      outcome: "paused",
      checkpointState: buildCheckpointDetails(plan, run, durableRun.runId),
    };
  }

  const terminalExecutionState = run.status === "stopped_by_limit" ? "stopped_by_limit" : "completed";
  // A final phase can finish past a budget (limits only stop further work); report it rather than hide it.
  const limitOverruns = listLimitOverruns(plan, run);
  await recordUpdate(
    {
      ...run,
      executionState: terminalExecutionState,
    },
    run.status === "stopped_by_limit" ? "run_stopped" : "run_completed",
    limitOverruns.length > 0 ? { limitOverruns } : {},
  );
  await persistRunEvent(host, run, run.status === "stopped_by_limit" ? "run.stopped" : "run.completed", {
    totalIterations: run.totalIterations,
    totalCostUsd: run.totalCostUsd,
    ...(run.status === "stopped_by_limit" ? { stopReason: run.stopReason ?? "plan_limit" } : {}),
    ...(limitOverruns.length > 0 ? { limitOverruns } : {}),
  });
  await publishRunRealtime(host, plan, run, {
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
):
  | { childRunId?: string; payload: Record<string, unknown>; breadcrumbKey: "waitingPhase" | "dispatchedPhase" }
  | undefined {
  const metadata = asRecord(durableRun.metadata);
  const waitingPhase = asRecord(metadata?.waitingPhase);
  if (waitingPhase && asString(waitingPhase.phaseId) === currentPhaseId) {
    const childRunId = asString(waitingPhase.childRunId);
    if (childRunId) {
      return { childRunId, payload: waitingPhase, breadcrumbKey: "waitingPhase" };
    }
  }
  const dispatchedPhase = asRecord(metadata?.dispatchedPhase);
  if (dispatchedPhase && asString(dispatchedPhase.phaseId) === currentPhaseId) {
    return {
      childRunId: asString(dispatchedPhase.childRunId),
      payload: dispatchedPhase,
      breadcrumbKey: "dispatchedPhase",
    };
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
async function persistDispatchedChildPhase(
  host: OrchestrationLifecycleHost,
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  durableRun: DurableRunRecord,
  dispatch: OrchestrationPhaseChildDispatch,
): Promise<void> {
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
  const expectedLeaseOwnerId = requireDurableExecutionLeaseOwner(durableRun);
  await host.storage.runImmediateTransaction(async () => {
    await lockFreshDurableExecutionLease(host, durableRun.runId, expectedLeaseOwnerId);
    await host.updateDurableRunState({
      runId: durableRun.runId,
      expectedLeaseOwnerId,
      metadata: {
        ...buildDurableMetadata(plan, run),
        dispatchedPhase,
      },
    });
    await persistRunEvent(host, run, "phase.child_dispatched", {
      phaseId: dispatch.phaseId,
      waveId: run.currentWaveId,
      childSessionId: dispatch.childSessionId,
      childTurnId: dispatch.childTurnId,
      childRunId: dispatch.childRunId,
    });
    if (dispatch.childRunId && host.watchDurableChildRun) {
      await host.watchDurableChildRun({
        watcherId: `orchestration-child:${durableRun.runId}:${dispatch.phaseId}`,
        parentRunId: durableRun.runId,
        childRunId: dispatch.childRunId,
        source: "orchestration_phase",
        metadata: {
          orchestrationRunId: run.runId,
          planId: plan.planId,
          phaseId: dispatch.phaseId,
          ...(dispatch.childSessionId ? { childSessionId: dispatch.childSessionId } : {}),
          ...(dispatch.childTurnId ? { childTurnId: dispatch.childTurnId } : {}),
        },
      });
    }
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
    commitOptions?: OrchestrationDurableCommitOptions,
  ) => Promise<void>;
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
  await input.recordUpdate(
    failedRun,
    "run_failed",
    { failedPhase },
    {
      durableTimeline: {
        eventType: "run_failed",
        payload: {
          phaseId: input.phaseId,
          waveId: failedRun.currentWaveId,
          childRunId,
          reason: input.timelineReason ?? "child_dispatch_unrecoverable",
          error: input.error,
        },
      },
    },
  );
  await persistRunEvent(host, failedRun, input.runEvent ?? "run.child_dispatch_unrecoverable", {
    phaseId: input.phaseId,
    waveId: failedRun.currentWaveId,
    childRunId,
    error: input.error,
  });
  await publishRunRealtime(host, plan, failedRun, {
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

async function getDurableRunIfAvailable(
  host: Pick<OrchestrationLifecycleHost, "getDurableRun">,
  runId: string,
): Promise<DurableRunRecord | undefined> {
  try {
    return await host.getDurableRun(runId);
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
  const expectedLeaseOwnerId = requireDurableExecutionLeaseOwner(input.durableRun);
  let failed!: OrchestrationRun;
  await input.host.storage.runImmediateTransaction(async () => {
    await lockFreshDurableExecutionLease(input.host, input.durableRun.runId, expectedLeaseOwnerId);
    await input.host.updateDurableRunState({
      runId: input.durableRun.runId,
      expectedLeaseOwnerId,
    });
    failed = await input.host.storage.orchestration.updateRun({
      ...input.run,
      status: "failed",
      executionState: "failed",
      endedAt: new Date().toISOString(),
      lastError: input.error,
    });
    await persistRunEvent(input.host, failed, "run.workspace_mismatch", {
      durableRunId: input.durableRun.runId,
      payloadWorkspaceId: input.payloadWorkspaceId,
      runWorkspaceId: input.runWorkspaceId,
      error: input.error,
    });
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

/**
 * Fallback harvest from durable metadata when the child's canonical Chat
 * records are unavailable. The waiting payload was captured before the child
 * finished, so its cost is at most a lower bound and is flagged as unreported.
 */
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
    costUnreported: true,
    inputTokens: asNumber(waitingPhase.inputTokens),
    outputTokens: asNumber(waitingPhase.outputTokens),
    citations: Array.isArray(waitingPhase.citations) ? (waitingPhase.citations as unknown[]) : undefined,
    artifacts: Array.isArray(waitingPhase.artifacts) ? (waitingPhase.artifacts as unknown[]) : undefined,
    prompt: asPromptReference(waitingPhase.prompt),
    error: failed
      ? (childRun.lastError ?? `Child phase durable run ${childRunId} ended as ${childRun.status}.`)
      : undefined,
  };
}

function asPromptReference(value: unknown): OrchestrationPhaseExecutionResult["prompt"] {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.promptId !== "string" ||
    typeof record.promptVersion !== "string" ||
    typeof record.promptHash !== "string"
  ) {
    return undefined;
  }
  return {
    promptId: record.promptId,
    promptVersion: record.promptVersion,
    promptHash: record.promptHash,
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

export async function getRun(
  host: OrchestrationLifecycleHost,
  runId: string,
  workspaceId?: string,
): Promise<OrchestrationRun> {
  return assertRunWorkspaceAccess(await host.storage.orchestration.getRun(runId), workspaceId);
}

export async function listRunCheckpoints(
  host: OrchestrationLifecycleHost,
  runId: string,
  workspaceId?: string,
): Promise<OrchestrationCheckpoint[]> {
  assertRunWorkspaceAccess(await host.storage.orchestration.getRun(runId), workspaceId);
  return await host.storage.orchestration.listCheckpoints(runId);
}

export async function getRunTrace(
  host: OrchestrationLifecycleHost,
  runId: string,
  workspaceId?: string,
): Promise<OrchestrationDecisionTrace> {
  const run = assertRunWorkspaceAccess(await host.storage.orchestration.getRun(runId), workspaceId);
  const sanitizedRun = projectOrchestrationPublicValue(run) as OrchestrationRun;
  const checkpoints = (await host.storage.orchestration.listCheckpoints(runId)).map((checkpoint) => ({
    ...checkpoint,
    details: sanitizeTraceDetails(checkpoint.details),
  }));
  const warnings: string[] = [];
  const runEvents = host.storage.orchestration.listRunEvents
    ? (await host.storage.orchestration.listRunEvents(runId)).map((event) => ({
        ...event,
        payload: sanitizeTraceDetails(event.payload),
      }))
    : [];
  if (!host.storage.orchestration.listRunEvents) {
    warnings.push("Run event storage does not expose listRunEvents; trace is checkpoint-only.");
  }
  const runtimeDecisions = ((await host.storage.runtimeDecisionTraces?.list({ runId, limit: 300 })) ?? []).map(
    (decision) => projectOrchestrationPublicValue(decision) as RuntimeDecisionTraceRecord,
  );

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
    ...runtimeDecisions.map((decision): OrchestrationDecisionEvent => {
      const kind = mapRuntimeDecisionKind(decision);
      return {
        decisionId: `runtime:${decision.decisionId}`,
        runId,
        kind,
        source: "runtime_decision",
        sourceId: decision.decisionId,
        eventType: decision.kind,
        planId: decision.scope.planId,
        phaseId: decision.scope.stepId,
        createdAt: decision.createdAt,
        summary: summarizeRuntimeDecision(decision),
        details: sanitizeTraceDetails({
          kind: decision.kind,
          selected: decision.selected,
          rationale: decision.rationale,
          alternatives: decision.alternatives,
          signals: decision.signals,
          evidenceRefs: decision.evidenceRefs,
          scope: decision.scope,
        }),
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
    runtimeDecisions,
    generatedAt: new Date().toISOString(),
    warnings,
  };
}

function mapRuntimeDecisionKind(decision: RuntimeDecisionTraceRecord): OrchestrationDecisionKind {
  switch (decision.kind) {
    case "orchestration_run_started":
      return "run_started";
    case "orchestration_phase_advanced":
      return "phase_advanced";
    case "durable_checkpoint":
      return "durable_run_linked";
    case "runtime_resumed":
      return "run_resumed";
    case "orchestration_run_completed":
      return "run_completed";
    case "orchestration_run_failed":
      return "run_failed";
    case "orchestration_run_cancelled":
      return "run_cancelled";
    case "approval_requested":
    case "runtime_paused":
      return "phase_wait_registered";
    default:
      return "unknown";
  }
}

function summarizeRuntimeDecision(decision: RuntimeDecisionTraceRecord): string {
  return capTraceString(`${decision.selected}: ${decision.rationale}`);
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
    case "run.waiting_for_child":
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
  return projectOrchestrationPublicValue(value) as Record<string, unknown>;
}

/**
 * Projects operator-visible orchestration state without mutating canonical storage.
 * The bounded pass runs first so hostile retained payloads cannot expand the public
 * response, then the canonical structured projector handles keyed and embedded secrets.
 */
export function projectOrchestrationPublicValue(value: unknown): unknown {
  return redactStructuredSecrets(boundTraceValue(value, 0), { marker: "[redacted]" }).value;
}

function boundTraceValue(value: unknown, depth: number): unknown {
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
    return value.slice(0, 20).map((item) => boundTraceValue(item, depth + 1));
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 50)) {
    sanitized[key] = boundTraceValue(child, depth + 1);
  }
  return sanitized;
}

function capTraceString(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}... [truncated]` : value;
}
