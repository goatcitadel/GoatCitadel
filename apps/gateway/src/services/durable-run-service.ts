/* eslint-disable max-lines -- Durable run lifecycle service intentionally centralizes lease, recovery, timeline, and diagnostics behavior. */
import { randomUUID } from "node:crypto";
import type {
  ChatTurnTraceRecord,
  DurableCheckpointRecord,
  ContinuationGateDecision,
  DurableDeadLetterRecord,
  DurableDiagnosticsResponse,
  RealtimeEvent,
  DurableRetryPolicy,
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunTimelineEvent,
  DurableWakeResult,
} from "@goatcitadel/contracts";
import { CHAT_TURN_ACTIVE_STATUSES, isChatTurnTerminalStatus, NotFoundError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import type { DurableWorkflowExecutorRegistry } from "./durable-execution-service.js";
import type { EvidenceEnvelopeCreateRequest } from "./evidence-envelope-service.js";
import {
  AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY,
  GENERAL_CHAT_POST_COMMIT_EFFECTS,
  GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY,
  type GeneralChatPostCommitEffect,
  type GeneralChatPostCommitPendingMarker,
  type GeneralChatPostCommitProgress,
  hasAutonomousChatPostCommitPending,
  hasGeneralChatPostCommitPending,
  markGeneralChatPostCommitPending,
  readGeneralChatPostCommitCompletedEffects,
  readGeneralChatPostCommitPendingMarker,
} from "./chat-durable-run-service.js";

export interface DurableRunServiceContext {
  readonly config: GatewayRuntimeConfig;
  readonly storage: Storage;
  readonly logger?: DurableRunServiceLogger;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
  requireFeatureEnabled(flag: keyof RuntimeSettings["features"]): void;
  isFeatureEnabled(flag: keyof RuntimeSettings["features"]): boolean;
}

export interface DurableRunServiceLogger {
  info(data: unknown, msg: string): void;
  debug(data: unknown, msg: string): void;
  warn(data: unknown, msg: string): void;
  error(data: unknown, msg: string): void;
}

const DURABLE_RETRY_POLICY_DEFAULT: DurableRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
};
// The lease must survive sustained event-loop starvation: a single native
// browser navigation or repo-wide search can stall the loop for 60-90s on a
// loaded workstation, and a 15s TTL caused the reaper to fail healthy runs at
// checkpoint run_started while their turns completed normally.
const DURABLE_LEASE_TTL_MS = 120_000;
const DURABLE_WORKER_POLL_MIN_MS = 750;
const DURABLE_WORKER_POLL_JITTER_MS = 500;
const DURABLE_LEASE_HEARTBEAT_MS = 5_000;
// Transient lease-renewal errors (storage contention, CAS retry exhaustion)
// should not abort an in-flight run; only repeated consecutive failures may.
const DURABLE_LEASE_HEARTBEAT_MAX_CONSECUTIVE_FAILURES = 3;
const DURABLE_EVENT_LOOP_LAG_WARN_MS = 1_000;
const DURABLE_EVENT_LOOP_LAG_PAUSE_MS = 2_000;
const DURABLE_CHECKPOINT_KEEP_PER_RUN_DEFAULT = 50;
const DURABLE_CHECKPOINT_DISK_BUDGET_BYTES_DEFAULT = 64 * 1024 * 1024;
const COWORK_WORKFLOW_TIMEOUT_RESUME_EVENT = "cowork.turn.operator_resume";
const AUTONOMY_KILL_SWITCH_RESUME_EVENT = "autonomy.v1.enabled";
const RAW_REMOTE_APPROVAL_BEARER_PATTERN = /grat_[A-Za-z0-9_-]{43}/;
const RAW_REMOTE_APPROVAL_BEARER_GLOBAL_PATTERN = /grat_[A-Za-z0-9_-]{43}/g;

function sameGeneralChatPostCommitGeneration(
  left: GeneralChatPostCommitPendingMarker,
  right: GeneralChatPostCommitPendingMarker,
): boolean {
  return left.generationId === right.generationId && left.traceStatus === right.traceStatus;
}

function containsRawRemoteApprovalBearer(value: unknown): boolean {
  try {
    return RAW_REMOTE_APPROVAL_BEARER_PATTERN.test(JSON.stringify(value));
  } catch {
    return false;
  }
}

function assertNoRawRemoteApprovalBearer(value: unknown): void {
  if (containsRawRemoteApprovalBearer(value)) {
    throw new Error("Raw remote approval bearer cannot be persisted in durable run state; use a secret reference.");
  }
}

function redactRawRemoteApprovalBearers<T>(value: T): T {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || !RAW_REMOTE_APPROVAL_BEARER_PATTERN.test(serialized)) {
      return value;
    }
    return JSON.parse(serialized.replace(RAW_REMOTE_APPROVAL_BEARER_GLOBAL_PATTERN, "[REDACTED]")) as T;
  } catch {
    return value;
  }
}

function redactRawRemoteApprovalBearerText(value: string): string {
  return value.replace(RAW_REMOTE_APPROVAL_BEARER_GLOBAL_PATTERN, "[REDACTED]");
}

interface LinkedFinalizationPending {
  reason: string;
  requestedAt: string;
  finalizationId: string;
  claimId?: string;
  claimExpiresAt?: string;
}

interface DurableChatCancellationLink {
  sessionId: string;
  turnId: string;
  userMessageId: string;
}

function readDurableChatCancellationLink(run: DurableRunRecord): DurableChatCancellationLink | undefined {
  if (run.workflowKey !== "chat.turn.execute") {
    return undefined;
  }
  const payload = run.payload as Partial<DurableChatCancellationLink> & { version?: unknown };
  if (
    payload.version !== "chat.turn.execute.v1" ||
    typeof payload.sessionId !== "string" ||
    typeof payload.turnId !== "string" ||
    typeof payload.userMessageId !== "string"
  ) {
    return undefined;
  }
  return {
    sessionId: payload.sessionId,
    turnId: payload.turnId,
    userMessageId: payload.userMessageId,
  };
}

function assertDurableChatCancellationTraceLink(
  runId: string,
  link: DurableChatCancellationLink,
  trace: ChatTurnTraceRecord,
): void {
  if (
    trace.turnId !== link.turnId ||
    trace.sessionId !== link.sessionId ||
    trace.userMessageId !== link.userMessageId ||
    (trace.durable?.runId !== undefined && trace.durable.runId !== runId)
  ) {
    throw new Error(`Durable Chat run ${runId} cancellation trace linkage does not match its payload.`);
  }
}

const LINKED_FINALIZATION_CLAIM_TTL_MS = 30_000;

function readLinkedFinalizationPending(run: DurableRunRecord): LinkedFinalizationPending | undefined {
  const value = (run.metadata as { linkedFinalizationPending?: unknown } | undefined)?.linkedFinalizationPending;
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const reason = (value as { reason?: unknown }).reason;
  const requestedAt = (value as { requestedAt?: unknown }).requestedAt;
  if (!(typeof reason === "string" && reason && typeof requestedAt === "string" && requestedAt)) {
    return undefined;
  }
  const finalizationId = (value as { finalizationId?: unknown }).finalizationId;
  const claimId = (value as { claimId?: unknown }).claimId;
  const claimExpiresAt = (value as { claimExpiresAt?: unknown }).claimExpiresAt;
  return {
    reason,
    requestedAt,
    finalizationId:
      typeof finalizationId === "string" && finalizationId ? finalizationId : `legacy:${run.runId}:${requestedAt}`,
    ...(typeof claimId === "string" && claimId ? { claimId } : {}),
    ...(typeof claimExpiresAt === "string" && claimExpiresAt ? { claimExpiresAt } : {}),
  };
}

class DurableWorkflowTimeoutError extends Error {
  public constructor(
    public readonly runId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Durable workflow ${runId} exceeded ${timeoutMs}ms execution timeout.`);
    this.name = "DurableWorkflowTimeoutError";
  }
}

class DurableWorkerInterruptionError extends Error {
  public constructor(
    public readonly kind: "worker_stopped" | "lease_lost" | "heartbeat_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "DurableWorkerInterruptionError";
  }
}

function buildDurableControlInterruptionError(kind: "paused" | "cancelled", message: string): Error {
  const error = new Error(message);
  error.name = kind === "paused" ? "DurableRunPausedError" : "DurableRunCancelledError";
  return error;
}

function buildDurableRealtimeOptions(runId: string): Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links"> {
  return {
    eventClass: "domain_fact",
    eventAuthority: "retained_stream",
    links: { runId },
  };
}

export function deriveDurableRunOperationalState(run: DurableRunRecord, nowMs = Date.now()): DurableRunRecord {
  const leaseExpiresAtMs = run.leaseExpiresAt ? Date.parse(run.leaseExpiresAt) : Number.NaN;
  const heartbeatAtMs = run.leaseHeartbeatAt ? Date.parse(run.leaseHeartbeatAt) : Number.NaN;
  const leaseExpired = Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs <= nowMs;
  const heartbeatStale =
    run.status === "running" &&
    Number.isFinite(heartbeatAtMs) &&
    nowMs - heartbeatAtMs > DURABLE_LEASE_HEARTBEAT_MS * 2;
  if (run.status === "dead_lettered") {
    return {
      ...run,
      workerHealth: "released",
      recoveryState: run.lastError?.startsWith("retry_exhausted:") ? "retry_budget_exhausted" : "dead_lettered",
      recoverySummary: run.lastError ?? "Run is in the durable dead-letter queue.",
    };
  }
  if (run.lastError?.startsWith("retry_exhausted:")) {
    return {
      ...run,
      workerHealth: "released",
      recoveryState: "retry_budget_exhausted",
      recoverySummary: run.lastError,
    };
  }
  if (/exited without marking/i.test(run.lastError ?? "")) {
    return {
      ...run,
      workerHealth: "released",
      recoveryState: "incomplete_worker_exit",
      recoverySummary: run.lastError,
    };
  }
  if (run.status === "running" && leaseExpired) {
    return {
      ...run,
      workerHealth: "expired_lease",
      recoveryState: "reclaimable",
      recoverySummary: `Lease expired at ${run.leaseExpiresAt}; the run can be reclaimed by a worker.`,
    };
  }
  if (heartbeatStale) {
    return {
      ...run,
      workerHealth: "stale_heartbeat",
      recoveryState: "reclaiming",
      recoverySummary: `No heartbeat recorded since ${run.leaseHeartbeatAt}.`,
    };
  }
  if (run.status === "running") {
    return {
      ...run,
      workerHealth: "active",
      recoveryState: "none",
      recoverySummary: run.leaseOwnerId ? `Lease held by worker ${run.leaseOwnerId}.` : undefined,
    };
  }
  return {
    ...run,
    workerHealth: run.status === "queued" || run.status === "waiting" ? "idle" : "released",
    recoveryState: "none",
    recoverySummary: undefined,
  };
}

/**
 * Encapsulates all durable-run lifecycle operations previously inlined
 * in GatewayService.
 */
export class DurableRunService {
  private workerActive = false;
  private workerRequested = false;
  private workerStopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly workerId = randomUUID();
  private readonly activeRunAbortControllers = new Map<string, { controller: AbortController; leaseOwnerId: string }>();
  private readonly generalChatPostCommitInFlight = new Map<string, Promise<boolean>>();
  private lastEventLoopLagMs = 0;
  private lastEventLoopLagAt: string | undefined;
  private leaseAcquisitionPausedUntilMs = 0;
  private lastBootRecovery: DurableDiagnosticsResponse["lastBootRecovery"];

  constructor(
    private readonly ctx: DurableRunServiceContext,
    private readonly deps?: {
      backgroundTasks: Set<Promise<void>>;
      workflowRegistry: Pick<
        DurableWorkflowExecutorRegistry,
        "executeWorkflow" | "isWorkflowRecoverable" | "markWorkflowUnrecoverable"
      >;
      onRunFailed?: (run: DurableRunRecord, message: string) => Promise<void> | void;
      onAutonomousChatPostCommit?: (
        run: DurableRunRecord,
      ) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
      onGeneralChatPostCommit?: (
        run: DurableRunRecord,
        progress: GeneralChatPostCommitProgress,
      ) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
      evaluateContinuationGate?: (run: DurableRunRecord) => ContinuationGateDecision | undefined;
      recordEvidenceEnvelope?: (input: EvidenceEnvelopeCreateRequest) => void;
      taskLifecycle?: {
        autoBlockOnIncompleteExit(taskId: string, runId: string): unknown;
      };
    },
  ) {}

  // ── queries ──────────────────────────────────────────────────────

  getDurableDiagnostics(): DurableDiagnosticsResponse {
    const statusCounts = this.ctx.storage.durableRuns.statusCounts();
    const durableFoundationReady = this.isDurableFoundationEnabled() && Boolean(this.deps?.workflowRegistry);
    return {
      enabled: this.isDurableFoundationEnabled(),
      replayFoundationReady: durableFoundationReady,
      runCount: this.ctx.storage.durableRuns.countRuns(),
      queuedCount: statusCounts.queued ?? 0,
      runningCount: statusCounts.running ?? 0,
      waitingCount: statusCounts.waiting ?? 0,
      failedCount: statusCounts.failed ?? 0,
      deadLetterCount: this.ctx.storage.durableRuns.listDeadLetters(1000).length,
      recentRuns: this.ctx.storage.durableRuns.listRuns(25).map((run) => deriveDurableRunOperationalState(run)),
      recentDeadLetters: this.ctx.storage.durableRuns.listDeadLetters(25),
      ...(this.lastEventLoopLagAt
        ? {
            eventLoopLag: {
              lastMs: this.lastEventLoopLagMs,
              lastObservedAt: this.lastEventLoopLagAt,
              ...(this.leaseAcquisitionPausedUntilMs > Date.now()
                ? { leaseAcquisitionPausedUntil: new Date(this.leaseAcquisitionPausedUntilMs).toISOString() }
                : {}),
            },
          }
        : {}),
      ...(this.lastBootRecovery ? { lastBootRecovery: this.lastBootRecovery } : {}),
      generatedAt: new Date().toISOString(),
    };
  }

  listDurableRuns(limit = 50): DurableRunRecord[] {
    return this.ctx.storage.durableRuns.listRuns(limit).map((run) => deriveDurableRunOperationalState(run));
  }

  listDurableDeadLetters(limit = 50): DurableDeadLetterRecord[] {
    return this.ctx.storage.durableRuns.listDeadLetters(limit);
  }

  listDurableRunCheckpoints(runId: string, limit = 200): DurableCheckpointRecord[] {
    return this.ctx.storage.durableRuns.listCheckpoints(runId, limit);
  }

  getDurableRun(runId: string): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    return deriveDurableRunOperationalState(this.ctx.storage.durableRuns.getRun(runId));
  }

  listDurableRunTimeline(runId: string, limit = 300): DurableRunTimelineEvent[] {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    return this.ctx.storage.durableRunEvents.listByRun(runId, limit);
  }

  startWorker(): void {
    if (!this.isDurableFoundationEnabled() || !this.deps) {
      return;
    }
    this.workerStopped = false;
    if (this.workerActive) {
      this.workerRequested = true;
      return;
    }
    this.workerRequested = true;
    this.workerActive = true;
    const backgroundTasks = this.deps.backgroundTasks;
    const bootTask = Promise.resolve().then(async () => {
      try {
        await this.performBootRecovery();
      } catch (error) {
        this.reportWorkerBackgroundFailure("boot_recovery", error);
      }
      try {
        await this.runWorkerProcessingLoop();
      } catch (error) {
        this.reportWorkerBackgroundFailure("run_processing", error);
      } finally {
        this.workerActive = false;
      }
    });
    backgroundTasks.add(bootTask);
    void bootTask.finally(() => {
      backgroundTasks.delete(bootTask);
    });
    this.ensurePollLoop();
  }

  private async performBootRecovery(): Promise<void> {
    if (!this.deps) {
      return;
    }
    const log = this.resolveLogger();
    const resumedCount = await this.reconcileRecoverableRuns();
    const pruneConfig = resolveCheckpointPruneConfig();
    const durableRunsRepo = this.ctx.storage.durableRuns as unknown as {
      pruneCheckpoints?: (input: { keepPerRun: number; diskBudgetBytes: number }) => {
        prunedOrphans: number;
        prunedAged: number;
        finalBytes: number;
        diskBudgetBytes: number;
      };
    };
    const pruneSummary = durableRunsRepo.pruneCheckpoints?.(pruneConfig) ?? {
      prunedOrphans: 0,
      prunedAged: 0,
      finalBytes: 0,
      diskBudgetBytes: pruneConfig.diskBudgetBytes,
    };
    this.lastBootRecovery = {
      observedAt: new Date().toISOString(),
      resumedCount,
      prunedOrphanCheckpoints: pruneSummary.prunedOrphans,
      prunedAgedCheckpoints: pruneSummary.prunedAged,
      finalCheckpointBytes: pruneSummary.finalBytes,
      diskBudgetBytes: pruneSummary.diskBudgetBytes,
    };
    if (resumedCount > 0) {
      log.info(
        {
          resumedCount,
          prunedOrphanCheckpoints: pruneSummary.prunedOrphans,
          prunedAgedCheckpoints: pruneSummary.prunedAged,
          finalCheckpointBytes: pruneSummary.finalBytes,
          diskBudgetBytes: pruneSummary.diskBudgetBytes,
        },
        "durable runs resumed after restart",
      );
    } else {
      log.debug(
        {
          prunedOrphanCheckpoints: pruneSummary.prunedOrphans,
          prunedAgedCheckpoints: pruneSummary.prunedAged,
          finalCheckpointBytes: pruneSummary.finalBytes,
          diskBudgetBytes: pruneSummary.diskBudgetBytes,
        },
        "no durable runs required resume after restart",
      );
    }
  }

  private resolveLogger(): DurableRunServiceLogger {
    if (this.ctx.logger) {
      return this.ctx.logger;
    }
    return {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  private reportWorkerBackgroundFailure(stage: "boot_recovery" | "run_processing", error: unknown): void {
    const message = redactRawRemoteApprovalBearerText(error instanceof Error ? error.message : String(error));
    const publishFailure = () => {
      this.publishRealtimeSafely(
        "system",
        "durable",
        {
          type: "durable_worker_background_failure",
          stage,
          error: message,
        },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
        },
      );
    };
    try {
      this.resolveLogger().error(
        {
          stage,
          error: message,
        },
        "durable worker background task failed",
      );
    } catch {
      // A reporter must never create a second unhandled worker failure.
      publishFailure();
      return;
    }
    publishFailure();
  }

  stopWorker(): void {
    this.workerStopped = true;
    this.workerRequested = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const [runId, activeExecution] of this.activeRunAbortControllers) {
      this.revokeActiveExecutionLease(runId, activeExecution.leaseOwnerId);
      activeExecution.controller.abort(
        new DurableWorkerInterruptionError(
          "worker_stopped",
          `Durable worker ${this.workerId} stopped while ${runId} was running.`,
        ),
      );
    }
    this.activeRunAbortControllers.clear();
  }

  requestRunProcessing(_runId?: string): void {
    if (!this.isDurableFoundationEnabled() || !this.deps || this.workerStopped) {
      return;
    }
    this.workerRequested = true;
    if (this.workerActive) {
      return;
    }
    this.workerActive = true;
    const backgroundTasks = this.deps.backgroundTasks;
    const task = Promise.resolve()
      .then(() => this.runWorkerProcessingLoop())
      .catch((error) => {
        this.reportWorkerBackgroundFailure("run_processing", error);
      })
      .finally(() => {
        this.workerActive = false;
        backgroundTasks.delete(task);
      });
    backgroundTasks.add(task);
  }

  private async runWorkerProcessingLoop(): Promise<void> {
    do {
      this.workerRequested = false;
      if (!this.ctx.isFeatureEnabled("autonomyV1Disabled")) {
        this.resumeRunsWaitingForAutonomyKillSwitch();
      }
      await this.reconcileRecoverableRuns();
      await this.drainQueuedRuns();
    } while (this.workerRequested && !this.workerStopped);
  }

  // ── mutations ────────────────────────────────────────────────────

  /**
   * Optimistic read-modify-write of a run's coarse state. Unspecified fields keep
   * the current record's values; the update is versioned against the record read
   * here, so a concurrent writer surfaces as a version conflict instead of a
   * silent lost update.
   */
  updateRunState(input: {
    runId: string;
    status?: DurableRunRecord["status"];
    metadata?: Record<string, unknown>;
    lastError?: string;
    clearLastError?: boolean;
    finishedAt?: string;
    clearFinishedAt?: boolean;
    clearLease?: boolean;
    expectedLeaseOwnerId?: string;
  }): DurableRunRecord {
    assertNoRawRemoteApprovalBearer(input);
    if (
      input.metadata &&
      ("linkedFinalizationPending" in input.metadata ||
        AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY in input.metadata ||
        GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY in input.metadata)
    ) {
      throw new Error("durable recovery metadata is reserved for internal state transitions");
    }
    const current = this.ctx.storage.durableRuns.getRun(input.runId);
    if (input.expectedLeaseOwnerId && !this.hasActiveLeaseOwner(current, input.expectedLeaseOwnerId)) {
      throw new DurableWorkerInterruptionError(
        "lease_lost",
        `Durable run ${input.runId} lease ownership moved before its workflow state could commit.`,
      );
    }
    return this.ctx.storage.durableRuns.updateRun({
      runId: input.runId,
      status: input.status ?? current.status,
      metadata: input.metadata ?? current.metadata,
      lastError: input.lastError,
      clearLastError: input.clearLastError,
      finishedAt: input.finishedAt,
      clearFinishedAt: input.clearFinishedAt,
      clearLease: input.clearLease,
      updatedAt: new Date().toISOString(),
      expectedVersion: current.version,
    });
  }

  async reconcileAutonomousChatPostCommit(runId: string): Promise<boolean> {
    if (!this.deps?.onAutonomousChatPostCommit) {
      return false;
    }
    try {
      const observed = this.ctx.storage.durableRuns.getRun(runId);
      if (!hasAutonomousChatPostCommitPending(observed)) {
        return true;
      }
      const resolution = await this.deps.onAutonomousChatPostCommit(observed);
      const cleared = this.retryDurableRunUpdate(runId, (current) => {
        if (current.status !== "completed" || !hasAutonomousChatPostCommitPending(current)) {
          return current;
        }
        const metadata = { ...(current.metadata ?? {}) };
        delete metadata[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY];
        metadata.autonomousChatPostCommit = {
          ...(resolution ?? {}),
          completedAt: new Date().toISOString(),
        };
        return this.ctx.storage.durableRuns.updateRun({
          runId: current.runId,
          status: current.status,
          metadata,
          updatedAt: new Date().toISOString(),
          expectedVersion: current.version,
        });
      });
      return !hasAutonomousChatPostCommitPending(cleared);
    } catch (error) {
      this.reportDurableRunRecoveryFailure(runId, error);
      return false;
    }
  }

  async reconcileGeneralChatPostCommit(runId: string): Promise<boolean> {
    const inFlight = this.generalChatPostCommitInFlight.get(runId);
    if (inFlight) {
      return inFlight;
    }
    const work = this.reconcileGeneralChatPostCommitInternal(runId);
    this.generalChatPostCommitInFlight.set(runId, work);
    try {
      return await work;
    } finally {
      if (this.generalChatPostCommitInFlight.get(runId) === work) {
        this.generalChatPostCommitInFlight.delete(runId);
      }
    }
  }

  private async reconcileGeneralChatPostCommitInternal(runId: string): Promise<boolean> {
    if (!this.deps?.onGeneralChatPostCommit) {
      return false;
    }
    try {
      for (let generationAttempt = 0; generationAttempt < 8; generationAttempt += 1) {
        const observed = this.ctx.storage.durableRuns.getRun(runId);
        const marker = readGeneralChatPostCommitPendingMarker(observed);
        if (!marker) {
          if (GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY in (observed.metadata ?? {})) {
            throw new Error(`Durable Chat post-commit ${runId} has an invalid pending marker.`);
          }
          return true;
        }
        const completedEffects = new Set(readGeneralChatPostCommitCompletedEffects(observed));
        const progress: GeneralChatPostCommitProgress = {
          generationId: marker.generationId,
          targetTraceStatus: marker.traceStatus,
          completedEffects: [...completedEffects],
          runEffect: (effect, callback) =>
            this.runGeneralChatPostCommitEffect(runId, marker, effect, callback, completedEffects),
        };
        const resolution = await this.deps.onGeneralChatPostCommit(observed, progress);
        const reconciled = this.ctx.storage.durableRuns.getRun(runId);
        const reconciledMarker = readGeneralChatPostCommitPendingMarker(reconciled);
        if (!reconciledMarker) {
          if (GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY in (reconciled.metadata ?? {})) {
            throw new Error(`Durable Chat post-commit ${runId} has an invalid pending marker.`);
          }
          return true;
        }
        if (!sameGeneralChatPostCommitGeneration(marker, reconciledMarker)) {
          continue;
        }
        const reconciledEffects = new Set(readGeneralChatPostCommitCompletedEffects(reconciled));
        const missingEffects = GENERAL_CHAT_POST_COMMIT_EFFECTS.filter((effect) => !reconciledEffects.has(effect));
        if (missingEffects.length > 0) {
          throw new Error(
            `Durable Chat post-commit ${runId} returned before reconciling effects: ${missingEffects.join(", ")}.`,
          );
        }
        let generationChanged = false;
        const cleared = this.retryDurableRunUpdate(runId, (current) => {
          const currentMarker = readGeneralChatPostCommitPendingMarker(current);
          if (!currentMarker) {
            return current;
          }
          if (!sameGeneralChatPostCommitGeneration(marker, currentMarker)) {
            generationChanged = true;
            return current;
          }
          const metadata = { ...(current.metadata ?? {}) };
          delete metadata[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY];
          metadata.generalChatPostCommit = {
            ...(resolution ?? {}),
            generationId: marker.generationId,
            traceStatus: marker.traceStatus,
            completedAt: new Date().toISOString(),
          };
          return this.ctx.storage.durableRuns.updateRun({
            runId: current.runId,
            status: current.status,
            metadata,
            updatedAt: new Date().toISOString(),
            expectedVersion: current.version,
          });
        });
        if (generationChanged) {
          continue;
        }
        return !hasGeneralChatPostCommitPending(cleared);
      }
      throw new Error(`Durable Chat post-commit ${runId} changed generations too many times to reconcile safely.`);
    } catch (error) {
      this.reportDurableRunRecoveryFailure(runId, error);
      return false;
    }
  }

  /**
   * Atomically applies one synchronous consumer and records its per-turn
   * receipt. If the callback or the receipt write fails, the storage
   * transaction rolls both back; if a prior attempt committed, a retry skips
   * the callback. This is the canonical crash-gap boundary for general Chat
   * post-commit work.
   */
  private runGeneralChatPostCommitEffect(
    runId: string,
    expectedMarker: GeneralChatPostCommitPendingMarker,
    effect: GeneralChatPostCommitEffect,
    callback: () => void,
    completedEffects: Set<GeneralChatPostCommitEffect>,
  ): boolean {
    if (completedEffects.has(effect)) {
      return false;
    }
    let applied = false;
    this.ctx.storage.runImmediateTransaction(() => {
      const current = this.ctx.storage.durableRuns.getRun(runId);
      const currentMarker = readGeneralChatPostCommitPendingMarker(current);
      if (!currentMarker || !sameGeneralChatPostCommitGeneration(expectedMarker, currentMarker)) {
        return;
      }
      const currentEffects = readGeneralChatPostCommitCompletedEffects(current);
      if (currentEffects.includes(effect)) {
        completedEffects.add(effect);
        return;
      }
      const callbackResult = callback() as unknown;
      if (
        callbackResult &&
        typeof callbackResult === "object" &&
        "then" in callbackResult &&
        typeof (callbackResult as { then?: unknown }).then === "function"
      ) {
        throw new Error(`Durable Chat post-commit effect ${effect} must commit synchronously.`);
      }
      const metadata = {
        ...(current.metadata ?? {}),
        [GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY]: {
          ...currentMarker,
          completedEffects: [...currentEffects, effect],
        },
      };
      this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: current.status,
        metadata,
        updatedAt: new Date().toISOString(),
        expectedVersion: current.version,
      });
      completedEffects.add(effect);
      applied = true;
    });
    return applied;
  }

  createDurableRun(input: DurableRunCreateRequest): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer(input);
    if (
      input.metadata &&
      ("linkedFinalizationPending" in input.metadata ||
        AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY in input.metadata ||
        GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY in input.metadata)
    ) {
      throw new Error("durable recovery metadata is reserved for internal state transitions");
    }
    const workflowKey = input.workflowKey.trim();
    if (!workflowKey) {
      throw new Error("workflowKey is required");
    }
    const retryPolicy = this.normalizeDurableRetryPolicy(input.retryPolicy);
    const now = new Date().toISOString();
    const status: DurableRunRecord["status"] = input.waitForEvent ? "waiting" : "queued";
    const metadata = {
      ...(input.metadata ?? {}),
      retryPolicy,
      waitForEvent: input.waitForEvent ?? null,
    };
    let run!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      run = this.ctx.storage.durableRuns.createRun({
        runId: input.runId,
        workflowKey,
        status,
        attemptCount: 0,
        maxAttempts: retryPolicy.maxAttempts,
        payload: input.payload ?? {},
        metadata,
        startedAt: status === "queued" ? undefined : now,
        now,
      });
      this.createDurableCheckpoint({
        runId: run.runId,
        checkpointKind: "run_created",
        state: {
          workflowKey: run.workflowKey,
          status: run.status,
        },
        createdAt: now,
      });
      this.recordDurableTimelineEvent(run.runId, "run_created", {
        workflowKey: run.workflowKey,
        status: run.status,
      });
      if (status === "waiting") {
        this.createDurableCheckpoint({
          runId: run.runId,
          checkpointKind: "run_waiting",
          state: {
            waitForEvent: input.waitForEvent ?? null,
          },
        });
        this.recordDurableTimelineEvent(run.runId, "run_waiting", {
          waitForEvent: input.waitForEvent ?? null,
        });
      }
    });
    this.publishDurableRealtimeSafely(run.runId, {
      type: "durable_run_created",
      runId: run.runId,
      workflowKey: run.workflowKey,
      status: run.status,
    });
    return run;
  }

  pauseDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer(actorId);
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status === "paused") {
      return current;
    }
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "cancelled" ||
      current.status === "dead_lettered"
    ) {
      throw new Error(`Durable run ${runId} is already terminal (${current.status})`);
    }
    let next!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      next = this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "paused",
        startedAt: current.startedAt ?? new Date().toISOString(),
        clearFinishedAt: true,
        clearLastError: true,
        clearLease: true,
        updatedAt: new Date().toISOString(),
        expectedVersion: current.version,
      });
      this.recordDurableTimelineEvent(runId, "run_paused", {
        actorId,
        previousStatus: current.status,
      });
    });
    this.abortActiveRun(runId, `Durable run ${runId} paused by ${actorId}.`, "paused");
    this.publishDurableRealtimeSafely(runId, {
      type: "durable_run_paused",
      runId,
      actorId,
    });
    return next;
  }

  resumeDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer(actorId);
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status !== "paused") {
      throw new Error(`Durable run ${runId} cannot be resumed from ${current.status}`);
    }
    if (isAutonomousDurableRunForKillSwitch(current) && this.ctx.isFeatureEnabled("autonomyV1Disabled")) {
      throw new Error(
        `Autonomous durable run ${runId} cannot be resumed while the autonomy kill switch is engaged (autonomyV1Disabled).`,
      );
    }
    let next!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      next = this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "queued",
        startedAt: current.startedAt ?? new Date().toISOString(),
        clearFinishedAt: true,
        clearLease: true,
        updatedAt: new Date().toISOString(),
        clearLastError: true,
        expectedVersion: current.version,
      });
      this.createDurableCheckpoint({
        runId,
        checkpointKind: "run_resumed",
        state: { actorId, previousStatus: current.status },
      });
      this.recordDurableTimelineEvent(runId, "run_resumed", {
        actorId,
        previousStatus: current.status,
      });
    });
    this.publishDurableRealtimeSafely(runId, {
      type: "durable_run_resumed",
      runId,
      actorId,
    });
    return next;
  }

  cancelDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer(actorId);
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status === "cancelled") {
      return current;
    }
    if (current.status === "completed" || current.status === "failed" || current.status === "dead_lettered") {
      throw new Error(`Durable run ${runId} is already terminal (${current.status})`);
    }
    const now = new Date().toISOString();
    const chatLink = readDurableChatCancellationLink(current);
    let chatTrace: ChatTurnTraceRecord | undefined;
    if (chatLink) {
      try {
        chatTrace = this.ctx.storage.chatTurnTraces.get(chatLink.turnId);
      } catch (error) {
        if (error instanceof NotFoundError) {
          throw new Error(`Durable Chat run ${runId} cannot be cancelled without its canonical turn trace.`, {
            cause: error,
          });
        }
        throw error;
      }
      assertDurableChatCancellationTraceLink(runId, chatLink, chatTrace);
      if (isChatTurnTerminalStatus(chatTrace.status) && chatTrace.status !== "cancelled") {
        throw new Error(
          `Durable Chat run ${runId} cannot be cancelled because turn ${chatLink.turnId} is already ${chatTrace.status}.`,
        );
      }
    }
    let next!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      if (chatLink && chatTrace?.status !== "cancelled") {
        const latestTrace = this.ctx.storage.chatTurnTraces.get(chatLink.turnId);
        assertDurableChatCancellationTraceLink(runId, chatLink, latestTrace);
        if (isChatTurnTerminalStatus(latestTrace.status) && latestTrace.status !== "cancelled") {
          throw new Error(
            `Durable Chat run ${runId} cannot be cancelled because turn ${chatLink.turnId} is already ${latestTrace.status}.`,
          );
        }
        if (latestTrace.status !== "cancelled") {
          const cancelledTrace = this.ctx.storage.chatTurnTraces.patchIfStatus(
            chatLink.turnId,
            CHAT_TURN_ACTIVE_STATUSES,
            {
              status: "cancelled",
              pendingUserInput: null,
              completion: {
                finishReason: latestTrace.completion?.finishReason,
                status: "interrupted",
                repaired: Boolean(latestTrace.completion?.repaired),
              },
              durable: {
                runId,
                status: "cancelled",
                checkpointKind: "run_cancelled",
              },
              finishedAt: now,
            },
          );
          if (!cancelledTrace) {
            throw new Error(`Durable Chat run ${runId} cancellation lost the turn-state transition race.`);
          }
        }
      }
      next = this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "cancelled",
        finishedAt: now,
        clearLease: true,
        updatedAt: now,
        lastError: `cancelled by ${actorId}`,
        ...(chatLink ? { metadata: markGeneralChatPostCommitPending(current.metadata, now, "cancelled") } : {}),
        expectedVersion: current.version,
      });
      this.createDurableCheckpoint({
        runId,
        checkpointKind: "run_cancelled",
        state: {
          actorId,
          previousStatus: current.status,
          ...(chatLink ? { sessionId: chatLink.sessionId, turnId: chatLink.turnId } : {}),
        },
      });
      this.recordDurableTimelineEvent(runId, "run_cancelled", {
        actorId,
        previousStatus: current.status,
      });
    });
    this.abortActiveRun(runId, `Durable run ${runId} cancelled by ${actorId}.`, "cancelled");
    this.publishDurableRealtimeSafely(runId, {
      type: "durable_run_cancelled",
      runId,
      actorId,
    });
    if (chatLink) {
      this.requestRunProcessing(runId);
    }
    return next;
  }

  retryDurableRun(runId: string, reason = "manual_retry", actorId = "operator"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer({ reason, actorId });
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status !== "failed") {
      throw new Error(`Durable run ${runId} cannot be retried from ${current.status}`);
    }
    if (readLinkedFinalizationPending(current)) {
      throw new Error(`Durable run ${runId} cannot be retried until linked-state finalization completes`);
    }
    const recoverability = this.deps?.workflowRegistry.isWorkflowRecoverable(current);
    if (recoverability && !recoverability.recoverable) {
      throw new Error(recoverability.reason ?? `Durable run ${runId} cannot be safely retried.`);
    }
    return this.scheduleDurableRunRetry(current, reason, actorId);
  }

  scheduleRunningWorkflowRetry(
    runId: string,
    reason = "workflow_retry",
    actorId = "worker",
    expectedLeaseOwnerId?: string,
  ): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer({ reason, actorId });
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (!this.hasActiveLeaseOwner(current, expectedLeaseOwnerId)) {
      throw new Error(`Durable run ${runId} cannot schedule running retry from ${current.status}`);
    }
    const recoverability = this.deps?.workflowRegistry.isWorkflowRecoverable(current);
    if (recoverability && !recoverability.recoverable) {
      throw new Error(recoverability.reason ?? `Durable run ${runId} cannot be safely retried.`);
    }
    return this.scheduleDurableRunRetry(current, reason, actorId);
  }

  private scheduleDurableRunRetry(current: DurableRunRecord, reason: string, actorId: string): DurableRunRecord {
    const runId = current.runId;
    const attemptNo = current.attemptCount + 1;
    if (attemptNo > current.maxAttempts) {
      const now = new Date().toISOString();
      let deadLetterReason = `retry_exhausted:${reason}`;
      let deadLettered!: DurableRunRecord;
      this.ctx.storage.runImmediateTransaction(() => {
        const deadLetter = this.ctx.storage.durableRuns.upsertDeadLetter({
          runId,
          reason: deadLetterReason,
          payload: {
            actorId,
            attemptNo,
            maxAttempts: current.maxAttempts,
          },
        });
        deadLetterReason = deadLetter.reason;
        deadLettered = this.ctx.storage.durableRuns.updateRun({
          runId,
          status: "dead_lettered",
          attemptCount: attemptNo,
          updatedAt: now,
          finishedAt: now,
          clearLease: true,
          lastError: deadLetter.reason,
          expectedVersion: current.version,
        });
        this.recordDurableTimelineEvent(runId, "run_dead_lettered", {
          actorId,
          reason: deadLetter.reason,
        });
        this.recordDurableTimelineEvent(runId, "run_retry_budget_exhausted", {
          actorId,
          reason: deadLetter.reason,
          attemptNo,
          maxAttempts: current.maxAttempts,
        });
      });
      this.publishDurableRealtimeSafely(runId, {
        type: "durable_run_dead_lettered",
        runId,
        reason: deadLetterReason,
      });
      return deadLettered;
    }
    const delayMs = this.computeDurableRetryDelayMs(current, attemptNo);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    let next!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      this.ctx.storage.durableRuns.upsertRetry({
        runId,
        attemptNo,
        reason,
        nextRetryAt,
      });
      this.recordDurableTimelineEvent(runId, "run_retry_scheduled", {
        actorId,
        reason,
        nextRetryAt,
        attemptNo,
      });
      next = this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "queued",
        attemptCount: attemptNo,
        updatedAt: new Date().toISOString(),
        clearFinishedAt: true,
        clearLease: true,
        clearLastError: true,
        expectedVersion: current.version,
      });
    });
    this.publishDurableRealtimeSafely(runId, {
      type: "durable_run_retry_scheduled",
      runId,
      attemptNo,
      nextRetryAt,
    });
    return next;
  }

  wakeDurableRun(
    runId: string,
    event: {
      eventKey: string;
      payload?: Record<string, unknown>;
      correlationId?: string;
    },
  ): DurableWakeResult {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer(event);
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status === "paused") {
      return {
        runId,
        eventKey: event.eventKey,
        correlationId: event.correlationId,
        outcome: "skipped_paused",
        run: current,
        detail: `Durable run ${runId} is operator-paused.`,
      };
    }
    if (current.status !== "waiting") {
      return {
        runId,
        eventKey: event.eventKey,
        correlationId: event.correlationId,
        outcome: "skipped_not_waiting",
        run: current,
        detail: `Durable run ${runId} is ${current.status}.`,
      };
    }
    const waitForEvent = ((
      current.metadata as { waitForEvent?: { eventKey?: string; correlationId?: string } } | undefined
    )?.waitForEvent ?? {}) as { eventKey?: string; correlationId?: string };
    // Wake-registration guard. The rule (see also `resolveChatDurableWaitForEvent`):
    //   (a) run declares waitForEvent.eventKey  => caller's eventKey MUST match it.
    //   (b) run declares none, caller passes an eventKey => REJECT. A run parked
    //       without a registered key accepts no keyed wake; otherwise a stale or
    //       cross-type wake would prematurely resume a still-waiting turn (Finding 3).
    //   (c) run declares none, caller passes none => ALLOW (back-compat). No production
    //       waker currently wakes keyless — operator wakes require a non-empty eventKey
    //       and the autonomy kill-switch sweep matches case (a) — but this preserves the
    //       only legitimate keyless path for legacy/other-path parks.
    if (waitForEvent.eventKey) {
      if (waitForEvent.eventKey !== event.eventKey) {
        return {
          runId,
          eventKey: event.eventKey,
          correlationId: event.correlationId,
          outcome: "skipped_event_key_mismatch",
          run: current,
          detail: `Wake event key mismatch: expected ${waitForEvent.eventKey}`,
        };
      }
    } else if (event.eventKey) {
      return {
        runId,
        eventKey: event.eventKey,
        correlationId: event.correlationId,
        outcome: "skipped_event_key_mismatch",
        run: current,
        detail: `Durable run ${runId} parked without a wake registration and cannot accept event key ${event.eventKey}.`,
      };
    }
    if (waitForEvent.correlationId && waitForEvent.correlationId !== event.correlationId) {
      return {
        runId,
        eventKey: event.eventKey,
        correlationId: event.correlationId,
        outcome: "skipped_correlation_mismatch",
        run: current,
        detail: "Wake correlation mismatch",
      };
    }
    const now = new Date().toISOString();
    let next!: DurableRunRecord;
    try {
      this.ctx.storage.runImmediateTransaction(() => {
        next = this.ctx.storage.durableRuns.updateRun({
          runId,
          status: "queued",
          updatedAt: now,
          startedAt: current.startedAt ?? now,
          clearFinishedAt: true,
          clearLease: true,
          clearLastError: true,
          expectedVersion: current.version,
        });
        this.recordDurableTimelineEvent(runId, "run_woken", {
          eventKey: event.eventKey,
          correlationId: event.correlationId,
          payload: event.payload ?? {},
        });
      });
    } catch (error) {
      return {
        runId,
        eventKey: event.eventKey,
        correlationId: event.correlationId,
        outcome: "failed",
        run: this.ctx.storage.durableRuns.getRun(runId),
        detail: error instanceof Error ? error.message : "Wake failed",
      };
    }
    this.publishDurableRealtimeSafely(runId, {
      type: "durable_run_woken",
      runId,
      eventKey: event.eventKey,
    });
    return {
      runId,
      eventKey: event.eventKey,
      correlationId: event.correlationId,
      outcome: "woke",
      run: next,
    };
  }

  /**
   * Resume autonomous durable runs that were parked while the autonomy kill
   * switch was engaged. Each such run waits on {@link AUTONOMY_KILL_SWITCH_RESUME_EVENT}
   * keyed to its own runId — an event nothing else ever emits — so without this
   * sweep they stay "waiting" forever once the switch is turned back off. Call
   * this when `autonomyV1Disabled` flips true -> false and on worker startup
   * (when autonomy is enabled) so runs parked before a restart also recover.
   * Idempotent: this sweep itself pre-filters to runs whose registered
   * `waitForEvent.eventKey` is {@link AUTONOMY_KILL_SWITCH_RESUME_EVENT} (the
   * `continue` below), so differently-parked runs are never passed to
   * {@link wakeDurableRun}; wakeDurableRun independently skips non-"waiting" runs
   * and re-checks the same event-key/correlation match.
   */
  resumeRunsWaitingForAutonomyKillSwitch(): { woken: string[] } {
    if (!this.ctx.isFeatureEnabled("durableKernelV1Enabled")) {
      return { woken: [] };
    }
    const woken: string[] = [];
    for (const runId of this.ctx.storage.durableRuns.listRunIdsByStatus("waiting")) {
      let run: DurableRunRecord;
      try {
        run = this.ctx.storage.durableRuns.getRun(runId);
      } catch {
        // Run vanished between the id scan and the read — nothing to resume.
        continue;
      }
      const waitForEvent = (run.metadata as { waitForEvent?: { eventKey?: string } } | undefined)?.waitForEvent;
      if (waitForEvent?.eventKey !== AUTONOMY_KILL_SWITCH_RESUME_EVENT) {
        continue;
      }
      const result = this.wakeDurableRun(runId, {
        eventKey: AUTONOMY_KILL_SWITCH_RESUME_EVENT,
        correlationId: runId,
      });
      if (result.outcome === "woke") {
        woken.push(runId);
      }
    }
    return { woken };
  }

  recoverDurableDeadLetter(
    entryId: string,
    actorId = "operator",
    options?: { maxAttempts?: number },
  ): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer(actorId);
    const deadLetter = this.ctx.storage.durableRuns.getDeadLetterById(entryId);
    if (deadLetter.resolvedAt) {
      throw new Error(`Durable dead letter ${entryId} is already resolved`);
    }
    const current = this.ctx.storage.durableRuns.getRun(deadLetter.runId);
    if (current.status !== "dead_lettered") {
      throw new Error(`Durable run ${deadLetter.runId} cannot be recovered from ${current.status}`);
    }
    if (current.attemptCount >= 20) {
      throw new Error(`Durable run ${deadLetter.runId} exhausted the hard 20-attempt recovery ceiling`);
    }
    const recoverability = this.deps?.workflowRegistry.isWorkflowRecoverable(current);
    if (recoverability && !recoverability.recoverable) {
      throw new Error(recoverability.reason ?? `Durable run ${deadLetter.runId} cannot be safely recovered.`);
    }
    const newMaxAttempts = options?.maxAttempts
      ? Math.min(20, Math.max(current.attemptCount + 1, Math.floor(options.maxAttempts)))
      : undefined;
    let next!: DurableRunRecord;
    const recoveredAt = new Date().toISOString();
    this.ctx.storage.runImmediateTransaction(() => {
      this.ctx.storage.durableRuns.resolveDeadLetter(entryId, {
        resolvedAt: recoveredAt,
        resolutionNote: `recovered by ${actorId}${newMaxAttempts ? `, maxAttempts raised to ${newMaxAttempts}` : ""}`,
      });
      next = this.ctx.storage.durableRuns.updateRun({
        runId: deadLetter.runId,
        status: "queued",
        updatedAt: recoveredAt,
        clearFinishedAt: true,
        clearLease: true,
        clearLastError: true,
        ...(newMaxAttempts ? { maxAttempts: newMaxAttempts } : {}),
        expectedVersion: current.version,
      });
      this.recordDurableTimelineEvent(deadLetter.runId, "dead_letter_recovered", {
        actorId,
        deadLetterId: entryId,
        ...(newMaxAttempts ? { maxAttemptsOverride: newMaxAttempts } : {}),
      });
    });
    this.requestRunProcessing(deadLetter.runId);
    this.publishDurableRealtimeSafely(deadLetter.runId, {
      type: "durable_dead_letter_recovered",
      runId: deadLetter.runId,
      deadLetterId: entryId,
    });
    return next;
  }

  // ── helpers (previously private on GatewayService) ───────────────

  isDurableFoundationEnabled(): boolean {
    return this.ctx.config.assistant.durable.enabled;
  }

  private publishRealtimeSafely(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void {
    try {
      this.ctx.publishRealtime(eventType, source, redactRawRemoteApprovalBearers(payload), options);
    } catch (error) {
      try {
        this.ctx.logger?.warn(
          {
            runId: options?.links?.runId,
            eventType: typeof payload.type === "string" ? payload.type : eventType,
            error: redactRawRemoteApprovalBearerText(error instanceof Error ? error.message : String(error)),
          },
          "Durable state transition continued after retained realtime publication failed",
        );
      } catch {
        // Observability sinks cannot take ownership of durable control flow.
        return;
      }
    }
  }

  private publishDurableRealtimeSafely(runId: string, payload: Record<string, unknown>): void {
    this.publishRealtimeSafely("system", "durable", payload, buildDurableRealtimeOptions(runId));
  }

  normalizeDurableRetryPolicy(input: Partial<DurableRetryPolicy> | undefined): DurableRetryPolicy {
    return {
      maxAttempts: Math.max(
        1,
        Math.min(20, Math.floor(input?.maxAttempts ?? DURABLE_RETRY_POLICY_DEFAULT.maxAttempts)),
      ),
      baseDelayMs: Math.max(
        100,
        Math.min(300_000, Math.floor(input?.baseDelayMs ?? DURABLE_RETRY_POLICY_DEFAULT.baseDelayMs)),
      ),
      maxDelayMs: Math.max(
        100,
        Math.min(900_000, Math.floor(input?.maxDelayMs ?? DURABLE_RETRY_POLICY_DEFAULT.maxDelayMs)),
      ),
      backoffMultiplier: Math.max(
        1,
        Math.min(8, input?.backoffMultiplier ?? DURABLE_RETRY_POLICY_DEFAULT.backoffMultiplier),
      ),
    };
  }

  computeDurableRetryDelayMs(current: DurableRunRecord, attemptNo: number): number {
    const metadataPolicy = (current.metadata as { retryPolicy?: Partial<DurableRetryPolicy> } | undefined)?.retryPolicy;
    const policy = this.normalizeDurableRetryPolicy(metadataPolicy);
    const raw = policy.baseDelayMs * policy.backoffMultiplier ** Math.max(0, attemptNo - 1);
    return Math.max(100, Math.min(policy.maxDelayMs, Math.floor(raw)));
  }

  recordDurableTimelineEvent(
    runId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
    stepKey?: string,
  ): DurableRunTimelineEvent {
    const event: DurableRunTimelineEvent = {
      eventId: randomUUID(),
      runId,
      eventType,
      stepKey: stepKey?.trim() || undefined,
      payload: redactRawRemoteApprovalBearers(payload ?? {}),
      createdAt: new Date().toISOString(),
    };
    return this.ctx.storage.durableRunEvents.append(event);
  }

  private recordDurableTimelineEventSafely(
    runId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
    stepKey?: string,
  ): void {
    try {
      this.recordDurableTimelineEvent(runId, eventType, payload, stepKey);
    } catch (error) {
      this.reportDurableRunRecoveryFailure(runId, error);
    }
  }

  private createDurableCheckpoint(input: {
    runId: string;
    checkpointKind: DurableCheckpointRecord["checkpointKind"];
    state?: Record<string, unknown>;
    createdAt?: string;
  }): DurableCheckpointRecord {
    return this.ctx.storage.durableRuns.createCheckpoint({
      ...input,
      state: redactRawRemoteApprovalBearers(input.state ?? {}),
    });
  }

  private async reconcileRecoverableRuns(): Promise<number> {
    if (!this.deps) {
      return 0;
    }
    let reclaimedCount = 0;
    const recoveryObservedAt = new Date().toISOString();
    const runningRunIds = this.ctx.storage.durableRuns.listExpiredRunningRunIds(recoveryObservedAt);
    for (const runId of runningRunIds) {
      try {
        const run = this.ctx.storage.durableRuns.getRun(runId);
        if (run.status !== "running" || !this.isLeaseExpiredAt(run, recoveryObservedAt)) {
          continue;
        }
        this.recordDurableTimelineEventSafely(run.runId, "run_lease_expired", {
          leaseOwnerId: run.leaseOwnerId,
          leaseExpiresAt: run.leaseExpiresAt,
        });
        const recoverability = this.deps.workflowRegistry.isWorkflowRecoverable(run);
        if (!recoverability.recoverable) {
          const reason = recoverability.reason ?? "Run could not be recovered after restart.";
          await this.transitionExpiredRunToPendingFinalization(run, reason, recoveryObservedAt);
          continue;
        }
        let reclaimedByThisPass = false;
        let reclaimed!: DurableRunRecord;
        this.ctx.storage.runImmediateTransaction(() => {
          reclaimed = this.retryDurableRunUpdate(run.runId, (current) => {
            if (
              current.status !== "running" ||
              !this.isLeaseExpiredAt(current, recoveryObservedAt) ||
              current.leaseOwnerId !== run.leaseOwnerId ||
              current.leaseExpiresAt !== run.leaseExpiresAt
            ) {
              return current;
            }
            const next = this.ctx.storage.durableRuns.updateRun({
              runId: current.runId,
              status: "queued",
              clearFinishedAt: true,
              clearLease: true,
              clearLastError: true,
              updatedAt: new Date().toISOString(),
              expectedVersion: current.version,
            });
            reclaimedByThisPass = true;
            return next;
          });
          if (reclaimedByThisPass) {
            this.recordDurableTimelineEvent(reclaimed.runId, "run_reclaimed", {
              previousLeaseOwnerId: run.leaseOwnerId,
              previousLeaseExpiresAt: run.leaseExpiresAt,
            });
          }
        });
        if (!reclaimedByThisPass) {
          continue;
        }
        reclaimedCount += 1;
      } catch (error) {
        this.reportDurableRunRecoveryFailure(runId, error);
      }
    }
    await this.reconcilePendingLinkedFinalizations();
    await this.reconcilePendingGeneralChatPostCommits();
    await this.reconcilePendingAutonomousChatPostCommits();
    return reclaimedCount;
  }

  private async transitionExpiredRunToPendingFinalization(
    observed: DurableRunRecord,
    reason: string,
    recoveryObservedAt: string,
  ): Promise<DurableRunRecord | undefined> {
    const safeReason = redactRawRemoteApprovalBearerText(reason);
    let transitioned = false;
    const failed = this.retryDurableRunUpdate(observed.runId, (current) => {
      if (
        current.status !== "running" ||
        !this.isLeaseExpiredAt(current, recoveryObservedAt) ||
        current.leaseOwnerId !== observed.leaseOwnerId ||
        current.leaseExpiresAt !== observed.leaseExpiresAt
      ) {
        return current;
      }
      const priorMetadata = { ...(current.metadata ?? {}) };
      delete (priorMetadata as { linkedFinalizationPending?: unknown }).linkedFinalizationPending;
      const next = this.persistFailedRun(current, safeReason, recoveryObservedAt, {
        linkedFinalizationPending: {
          reason: safeReason,
          requestedAt: recoveryObservedAt,
          finalizationId: randomUUID(),
        },
        ...priorMetadata,
      });
      transitioned = true;
      return next;
    });
    if (!transitioned) {
      return undefined;
    }
    this.publishDurableRealtimeSafely(failed.runId, {
      type: "durable_run_failed",
      runId: failed.runId,
      error: safeReason,
    });
    await this.notifyRunFailedSafely(failed, safeReason);
    return failed;
  }

  private async reconcilePendingLinkedFinalizations(): Promise<void> {
    if (!this.deps) {
      return;
    }
    const batchSize = 500;
    let afterRunId: string | undefined;
    while (true) {
      const runIds = this.ctx.storage.durableRuns.listPendingLinkedFinalizationRunIds(batchSize, afterRunId);
      for (const runId of runIds) {
        try {
          const run = this.ctx.storage.durableRuns.getRun(runId);
          if (readLinkedFinalizationPending(run)) {
            await this.finalizePendingLinkedState(run);
          }
        } catch (error) {
          this.reportDurableRunRecoveryFailure(runId, error);
        }
      }
      if (runIds.length < batchSize) {
        return;
      }
      afterRunId = runIds.at(-1);
    }
  }

  private async reconcilePendingAutonomousChatPostCommits(): Promise<void> {
    if (!this.deps?.onAutonomousChatPostCommit) {
      return;
    }
    const batchSize = 500;
    let afterRunId: string | undefined;
    while (true) {
      const runIds = this.ctx.storage.durableRuns.listPendingAutonomousChatPostCommitRunIds(batchSize, afterRunId);
      for (const runId of runIds) {
        await this.reconcileAutonomousChatPostCommit(runId);
      }
      if (runIds.length < batchSize) {
        return;
      }
      afterRunId = runIds.at(-1);
    }
  }

  private async reconcilePendingGeneralChatPostCommits(): Promise<void> {
    if (!this.deps?.onGeneralChatPostCommit) {
      return;
    }
    const batchSize = 500;
    let afterRunId: string | undefined;
    while (true) {
      const runIds = this.ctx.storage.durableRuns.listPendingGeneralChatPostCommitRunIds?.(batchSize, afterRunId) ?? [];
      for (const runId of runIds) {
        await this.reconcileGeneralChatPostCommit(runId);
      }
      if (runIds.length < batchSize) {
        return;
      }
      afterRunId = runIds.at(-1);
    }
  }

  private async finalizePendingLinkedState(run: DurableRunRecord): Promise<void> {
    if (!this.deps) {
      return;
    }
    const claim = this.claimPendingLinkedFinalization(run);
    if (!claim) {
      return;
    }
    const claimHeartbeat = setInterval(
      () => {
        try {
          this.renewPendingLinkedFinalizationClaim(claim.run.runId, claim.pending);
        } catch (error) {
          this.reportDurableRunRecoveryFailure(claim.run.runId, error);
        }
      },
      Math.floor(LINKED_FINALIZATION_CLAIM_TTL_MS / 3),
    );
    claimHeartbeat.unref?.();
    try {
      await this.deps.workflowRegistry.markWorkflowUnrecoverable(claim.run, claim.pending.reason);
    } finally {
      clearInterval(claimHeartbeat);
    }
    this.retryDurableRunUpdate(run.runId, (current) => {
      const currentPending = readLinkedFinalizationPending(current);
      if (
        current.status !== "failed" ||
        !currentPending ||
        currentPending.finalizationId !== claim.pending.finalizationId ||
        currentPending.claimId !== claim.pending.claimId
      ) {
        return current;
      }
      const metadata = { ...(current.metadata ?? {}) };
      delete (metadata as { linkedFinalizationPending?: unknown }).linkedFinalizationPending;
      return this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: current.status,
        metadata,
        updatedAt: new Date().toISOString(),
        expectedVersion: current.version,
      });
    });
  }

  private claimPendingLinkedFinalization(
    observed: DurableRunRecord,
  ): { run: DurableRunRecord; pending: LinkedFinalizationPending } | undefined {
    const observedPending = readLinkedFinalizationPending(observed);
    if (!observedPending) {
      return undefined;
    }
    const claimId = randomUUID();
    const claimedAtMs = Date.now();
    const claimExpiresAt = new Date(claimedAtMs + LINKED_FINALIZATION_CLAIM_TTL_MS).toISOString();
    let claim: { run: DurableRunRecord; pending: LinkedFinalizationPending } | undefined;
    this.retryDurableRunUpdate(observed.runId, (current) => {
      claim = undefined;
      const pending = readLinkedFinalizationPending(current);
      if (current.status !== "failed" || !pending || pending.finalizationId !== observedPending.finalizationId) {
        return current;
      }
      const activeClaimExpiresAt = pending.claimExpiresAt ? Date.parse(pending.claimExpiresAt) : Number.NaN;
      if (pending.claimId && Number.isFinite(activeClaimExpiresAt) && activeClaimExpiresAt > claimedAtMs) {
        return current;
      }
      const claimedPending: LinkedFinalizationPending = {
        ...pending,
        claimId,
        claimExpiresAt,
      };
      const metadata = {
        ...(current.metadata ?? {}),
        linkedFinalizationPending: claimedPending,
      };
      const claimedRun = this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: current.status,
        metadata,
        updatedAt: new Date(claimedAtMs).toISOString(),
        expectedVersion: current.version,
      });
      claim = { run: claimedRun, pending: claimedPending };
      return claimedRun;
    });
    return claim;
  }

  private renewPendingLinkedFinalizationClaim(runId: string, claimed: LinkedFinalizationPending): void {
    const nowMs = Date.now();
    this.retryDurableRunUpdate(runId, (current) => {
      const pending = readLinkedFinalizationPending(current);
      if (
        current.status !== "failed" ||
        !pending ||
        pending.finalizationId !== claimed.finalizationId ||
        pending.claimId !== claimed.claimId
      ) {
        return current;
      }
      return this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: current.status,
        metadata: {
          ...(current.metadata ?? {}),
          linkedFinalizationPending: {
            ...pending,
            claimExpiresAt: new Date(nowMs + LINKED_FINALIZATION_CLAIM_TTL_MS).toISOString(),
          },
        },
        updatedAt: new Date(nowMs).toISOString(),
        expectedVersion: current.version,
      });
    });
  }

  private reportDurableRunRecoveryFailure(runId: string, error: unknown): void {
    const message = redactRawRemoteApprovalBearerText(error instanceof Error ? error.message : String(error));
    const publishFailure = () => {
      this.publishRealtimeSafely(
        "system",
        "durable",
        { type: "durable_run_recovery_failed", runId, error: message },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: { runId },
        },
      );
    };
    try {
      this.resolveLogger().error({ runId, error: message }, "durable run recovery failed; continuing with other runs");
    } catch {
      // Recovery isolation must not depend on the logger.
      publishFailure();
      return;
    }
    publishFailure();
  }

  private async drainQueuedRuns(): Promise<void> {
    if (!this.deps) {
      return;
    }
    const deps = this.deps;
    while (true) {
      if (this.workerStopped || this.isLeaseAcquisitionPaused()) {
        return;
      }
      const run = this.claimNextQueuedRun();
      if (!run) {
        return;
      }
      let preserveForLeaseRecovery = false;
      try {
        const gateDecision = deps.evaluateContinuationGate?.(run);
        if (gateDecision && gateDecision.decision !== "continue") {
          if (this.recordContinuationGateDecision(run, gateDecision, deps)) {
            continue;
          }
        }
        const timeoutMs = resolveDurableWorkflowTimeoutMs(run, this.ctx.config.assistant.durable.workflowTimeoutMs);
        await this.executeWithLeaseHeartbeat(run, ({ signal, controller }) =>
          timeoutMs === undefined
            ? deps.workflowRegistry.executeWorkflow(run, { signal })
            : this.executeWithTimeout(
                () => deps.workflowRegistry.executeWorkflow(run, { signal }),
                timeoutMs,
                run.runId,
                controller,
              ),
        );
      } catch (error) {
        if (error instanceof DurableWorkerInterruptionError) {
          preserveForLeaseRecovery = true;
        } else if (isDurableWorkflowTimeoutError(error) && isCoworkDurableChatTurnRun(run)) {
          await this.markCoworkRunWaitingForOperator(run, error);
        } else if (isAutonomousDurableRunDisabledError(error)) {
          await this.markAutonomousRunWaitingForKillSwitch(run, error);
        } else {
          await this.failWorkflowRun(
            run,
            error instanceof Error ? error.message : "Durable workflow execution failed.",
          );
        }
      } finally {
        const current = this.ctx.storage.durableRuns.getRun(run.runId);
        if (!preserveForLeaseRecovery && this.hasExpectedActiveLease(current, run)) {
          const incompleteMessage = "Durable workflow exited without marking a terminal or waiting state.";
          const failedByThisPass = await this.failWorkflowRun(current, incompleteMessage);
          if (failedByThisPass) {
            this.recordDurableTimelineEventSafely(current.runId, "run_incomplete_worker_exit", {
              leaseOwnerId: current.leaseOwnerId,
              leaseExpiresAt: current.leaseExpiresAt,
            });
            const taskId = typeof current.payload?.taskId === "string" ? current.payload.taskId : undefined;
            if (taskId && this.deps?.taskLifecycle) {
              try {
                this.deps.taskLifecycle.autoBlockOnIncompleteExit(taskId, current.runId);
              } catch (error) {
                this.publishDurableRealtimeSafely(current.runId, {
                  kind: "task_auto_block_failed",
                  runId: current.runId,
                  taskId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
        }
      }
    }
  }

  private recordContinuationGateDecision(
    run: DurableRunRecord,
    gateDecision: ContinuationGateDecision,
    deps: NonNullable<typeof this.deps>,
  ): boolean {
    const shouldBlock = this.shouldBlockContinuationGateDecision(gateDecision);
    const now = new Date().toISOString();
    const blockedStatus = gateDecision.decision === "stop" ? "cancelled" : "paused";
    const blockedEventType = blockedStatus === "cancelled" ? "run_cancelled" : "run_paused";
    this.ctx.storage.runImmediateTransaction(() => {
      const current = this.ctx.storage.durableRuns.getRun(run.runId);
      if (!this.hasExpectedActiveLease(current, run)) {
        throw new DurableWorkerInterruptionError(
          "lease_lost",
          `Durable run ${run.runId} lease ownership moved before its continuation gate could commit.`,
        );
      }
      this.createDurableCheckpoint({
        runId: run.runId,
        checkpointKind: "continuation_gate",
        state: { continuationGate: gateDecision },
        createdAt: gateDecision.createdAt,
      });
      this.recordDurableTimelineEvent(run.runId, "continuation_gate", {
        decision: gateDecision.decision,
        reasonCodes: gateDecision.reasonCodes,
        recommendedAction: gateDecision.recommendedAction,
      });
      if (shouldBlock) {
        this.ctx.storage.durableRuns.updateRun({
          runId: run.runId,
          status: blockedStatus,
          updatedAt: now,
          ...(blockedStatus === "cancelled" ? { finishedAt: now } : { clearFinishedAt: true }),
          clearLease: true,
          clearLastError: true,
          expectedVersion: current.version,
        });
        this.recordDurableTimelineEvent(run.runId, blockedEventType, {
          actorId: "continuation_gate",
          previousStatus: run.status,
          decision: gateDecision.decision,
          reasonCodes: gateDecision.reasonCodes,
        });
      }
    });
    this.publishDurableRealtimeSafely(run.runId, {
      type: "durable_continuation_gate",
      runId: run.runId,
      decision: gateDecision.decision,
      reasonCodes: gateDecision.reasonCodes,
      recommendedAction: gateDecision.recommendedAction,
    });
    try {
      deps.recordEvidenceEnvelope?.({
        eventKind: "continuation_gate",
        runId: run.runId,
        metadata: {
          workflowKey: run.workflowKey,
          decision: gateDecision.decision,
          reasonCodes: gateDecision.reasonCodes,
          recommendedAction: gateDecision.recommendedAction,
        },
      });
    } catch (error) {
      this.publishDurableRealtimeSafely(run.runId, {
        type: "durable_continuation_gate_evidence_failed",
        runId: run.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (shouldBlock) {
      this.publishDurableRealtimeSafely(run.runId, {
        type: blockedStatus === "cancelled" ? "durable_run_cancelled" : "durable_run_paused",
        runId: run.runId,
        actorId: "continuation_gate",
        decision: gateDecision.decision,
      });
    }
    return shouldBlock;
  }

  private shouldBlockContinuationGateDecision(gateDecision: ContinuationGateDecision): boolean {
    return (
      gateDecision.decision === "pause" || gateDecision.decision === "throttle" || gateDecision.decision === "stop"
    );
  }

  private executeWithTimeout<T>(
    execute: () => Promise<T>,
    timeoutMs: number,
    runId: string,
    controller: AbortController,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new DurableWorkflowTimeoutError(runId, timeoutMs);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
      execute().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private async markCoworkRunWaitingForOperator(
    run: DurableRunRecord,
    error: DurableWorkflowTimeoutError,
  ): Promise<void> {
    const now = new Date().toISOString();
    const safeErrorMessage = redactRawRemoteApprovalBearerText(error.message);
    const waitForEvent = {
      eventKey: COWORK_WORKFLOW_TIMEOUT_RESUME_EVENT,
      correlationId: run.runId,
    };
    const checkpointState = {
      workflowKey: run.workflowKey,
      reason: "cowork_workflow_timeout",
      message: safeErrorMessage,
      timeoutMs: error.timeoutMs,
      waitForEvent,
    };
    const waiting = this.retryDurableRunUpdate(run.runId, (current) => {
      if (this.isTerminalRunStatus(current.status)) {
        return current;
      }
      if (!this.hasExpectedActiveLease(current, run, now)) {
        return current;
      }
      let next!: DurableRunRecord;
      this.ctx.storage.runImmediateTransaction(() => {
        next = this.ctx.storage.durableRuns.updateRun({
          runId: current.runId,
          status: "waiting",
          clearFinishedAt: true,
          clearLease: true,
          clearLastError: true,
          updatedAt: now,
          metadata: {
            ...current.metadata,
            waitForEvent,
            coworkWatchdog: {
              reason: "workflow_timeout",
              timedOutAt: now,
              timeoutMs: error.timeoutMs,
              message: safeErrorMessage,
            },
          },
          expectedVersion: current.version,
        });
        this.createDurableCheckpoint({
          runId: next.runId,
          checkpointKind: "run_waiting",
          state: checkpointState,
          createdAt: now,
        });
        this.recordDurableTimelineEvent(next.runId, "run_waiting", checkpointState);
      });
      return next;
    });
    if (waiting.status !== "waiting") {
      return;
    }
    this.publishDurableRealtimeSafely(waiting.runId, {
      type: "durable_run_waiting",
      runId: waiting.runId,
      reason: "cowork_workflow_timeout",
      waitForEvent,
    });
  }

  private async markAutonomousRunWaitingForKillSwitch(run: DurableRunRecord, error: Error): Promise<void> {
    const now = new Date().toISOString();
    const safeErrorMessage = redactRawRemoteApprovalBearerText(error.message);
    const waitForEvent = {
      eventKey: AUTONOMY_KILL_SWITCH_RESUME_EVENT,
      correlationId: run.runId,
    };
    const checkpointState = {
      workflowKey: run.workflowKey,
      reason: "autonomy_kill_switch",
      message: safeErrorMessage,
      waitForEvent,
    };
    const waiting = this.retryDurableRunUpdate(run.runId, (current) => {
      if (this.isTerminalRunStatus(current.status)) {
        return current;
      }
      if (!this.hasExpectedActiveLease(current, run, now)) {
        return current;
      }
      let next!: DurableRunRecord;
      this.ctx.storage.runImmediateTransaction(() => {
        next = this.ctx.storage.durableRuns.updateRun({
          runId: current.runId,
          status: "waiting",
          clearFinishedAt: true,
          clearLease: true,
          clearLastError: true,
          updatedAt: now,
          metadata: {
            ...current.metadata,
            waitForEvent,
            autonomyKillSwitch: {
              reason: "autonomyV1Disabled",
              blockedAt: now,
              message: safeErrorMessage,
            },
          },
          expectedVersion: current.version,
        });
        this.createDurableCheckpoint({
          runId: next.runId,
          checkpointKind: "run_waiting",
          state: checkpointState,
          createdAt: now,
        });
        this.recordDurableTimelineEvent(next.runId, "run_waiting", checkpointState);
      });
      return next;
    });
    if (waiting.status !== "waiting") {
      return;
    }
    this.publishDurableRealtimeSafely(waiting.runId, {
      type: "durable_run_waiting",
      runId: waiting.runId,
      reason: "autonomy_kill_switch",
      waitForEvent,
    });
  }

  private abortActiveRun(runId: string, reason: string, kind: "paused" | "cancelled"): void {
    const activeExecution = this.activeRunAbortControllers.get(runId);
    if (!activeExecution || activeExecution.controller.signal.aborted) {
      return;
    }
    activeExecution.controller.abort(buildDurableControlInterruptionError(kind, reason));
  }

  private revokeActiveExecutionLease(runId: string, expectedLeaseOwnerId: string): void {
    try {
      this.retryDurableRunUpdate(runId, (current) => {
        if (current.status !== "running" || current.leaseOwnerId !== expectedLeaseOwnerId) {
          return current;
        }
        return this.ctx.storage.durableRuns.updateRun({
          runId,
          status: current.status,
          leaseOwnerId: randomUUID(),
          leaseHeartbeatAt: current.leaseHeartbeatAt,
          leaseExpiresAt: current.leaseExpiresAt,
          updatedAt: new Date().toISOString(),
          expectedVersion: current.version,
        });
      });
    } catch (error) {
      this.reportDurableRunRecoveryFailure(runId, error);
    }
  }

  private async executeWithLeaseHeartbeat<T>(
    run: DurableRunRecord,
    execute: (context: { signal: AbortSignal; controller: AbortController }) => Promise<T>,
  ): Promise<T> {
    const owned = this.ctx.storage.durableRuns.getRun(run.runId);
    const executionStartedAtMs = Date.now();
    if (
      owned.status !== "running" ||
      owned.leaseOwnerId !== run.leaseOwnerId ||
      this.isLeaseExpiredAt(owned, new Date().toISOString()) ||
      this.workerStopped
    ) {
      throw new DurableWorkerInterruptionError(
        this.workerStopped ? "worker_stopped" : "lease_lost",
        `Durable run ${run.runId} lease ownership was lost before workflow execution.`,
      );
    }
    const executionStartedAt = new Date(executionStartedAtMs).toISOString();
    const renewedBeforeExecution = this.ctx.storage.durableRuns.renewLease({
      runId: run.runId,
      workerId: run.leaseOwnerId!,
      leaseHeartbeatAt: executionStartedAt,
      leaseExpiresAt: new Date(executionStartedAtMs + DURABLE_LEASE_TTL_MS).toISOString(),
      updatedAt: executionStartedAt,
    });
    if (!renewedBeforeExecution) {
      throw new DurableWorkerInterruptionError(
        "lease_lost",
        `Durable run ${run.runId} lease renewal lost ownership before workflow execution.`,
      );
    }
    let active = true;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectHeartbeatFailure!: (error: Error) => void;
    const controller = new AbortController();
    this.activeRunAbortControllers.set(run.runId, { controller, leaseOwnerId: run.leaseOwnerId! });
    const heartbeatFailure = new Promise<never>((_, reject) => {
      rejectHeartbeatFailure = reject;
    });
    const scheduleHeartbeat = () => {
      if (!active || this.workerStopped) {
        return;
      }
      const expectedAtMs = Date.now() + DURABLE_LEASE_HEARTBEAT_MS;
      heartbeatTimer = setTimeout(() => void heartbeat(expectedAtMs), DURABLE_LEASE_HEARTBEAT_MS);
    };
    let consecutiveHeartbeatFailures = 0;
    let lastSuccessfulRenewalMs = Date.now();
    const heartbeatToleranceExhausted = (): boolean =>
      consecutiveHeartbeatFailures >= DURABLE_LEASE_HEARTBEAT_MAX_CONSECUTIVE_FAILURES ||
      // Wall-clock bound: regardless of attempt count, once the lease could
      // have expired from another worker's perspective we must stop executing
      // or risk a double-run after the reaper reclaims it.
      Date.now() - lastSuccessfulRenewalMs >= DURABLE_LEASE_TTL_MS;
    const heartbeat = async (expectedAtMs: number) => {
      if (!active) {
        return;
      }
      if (this.workerStopped) {
        active = false;
        const error = new DurableWorkerInterruptionError(
          "worker_stopped",
          `Durable worker stopped while ${run.runId} was running.`,
        );
        controller.abort(error);
        rejectHeartbeatFailure(error);
        return;
      }
      this.recordEventLoopLag(Date.now() - expectedAtMs, run.runId);
      let current: DurableRunRecord;
      try {
        current = this.ctx.storage.durableRuns.getRun(run.runId);
      } catch (error) {
        consecutiveHeartbeatFailures += 1;
        if (!heartbeatToleranceExhausted()) {
          scheduleHeartbeat();
          return;
        }
        active = false;
        this.revokeActiveExecutionLease(run.runId, run.leaseOwnerId!);
        const interruption = new DurableWorkerInterruptionError(
          "heartbeat_unavailable",
          error instanceof Error ? error.message : String(error),
        );
        controller.abort(interruption);
        rejectHeartbeatFailure(interruption);
        return;
      }
      const now = new Date().toISOString();
      if (!this.hasExpectedActiveLease(current, run, now)) {
        // Definitive ownership loss is not retryable: another worker (or the
        // reaper) owns the run now, so executing further would double-run it.
        active = false;
        const error = new DurableWorkerInterruptionError(
          "lease_lost",
          `Durable run ${run.runId} lease ownership moved to another worker.`,
        );
        controller.abort(error);
        rejectHeartbeatFailure(error);
        return;
      }
      try {
        const renewed = this.ctx.storage.durableRuns.renewLease({
          runId: run.runId,
          workerId: run.leaseOwnerId!,
          leaseHeartbeatAt: now,
          leaseExpiresAt: new Date(Date.now() + DURABLE_LEASE_TTL_MS).toISOString(),
          updatedAt: now,
        });
        if (!renewed) {
          // A clean false/undefined from renewLease is a definitive CAS loss
          // (another worker holds the lease) — abort immediately, no strikes.
          active = false;
          const error = new DurableWorkerInterruptionError(
            "lease_lost",
            `Durable run ${run.runId} lease renewal lost ownership.`,
          );
          controller.abort(error);
          rejectHeartbeatFailure(error);
          return;
        }
        consecutiveHeartbeatFailures = 0;
        lastSuccessfulRenewalMs = Date.now();
      } catch (error) {
        consecutiveHeartbeatFailures += 1;
        if (!heartbeatToleranceExhausted()) {
          scheduleHeartbeat();
          return;
        }
        active = false;
        this.revokeActiveExecutionLease(run.runId, run.leaseOwnerId!);
        const interruption = new DurableWorkerInterruptionError(
          "heartbeat_unavailable",
          error instanceof Error ? error.message : `Durable run ${run.runId} lease heartbeat failed.`,
        );
        controller.abort(interruption);
        rejectHeartbeatFailure(interruption);
        return;
      }
      scheduleHeartbeat();
    };

    scheduleHeartbeat();
    try {
      return await Promise.race([execute({ signal: controller.signal, controller }), heartbeatFailure]);
    } finally {
      active = false;
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
      }
      if (this.activeRunAbortControllers.get(run.runId)?.controller === controller) {
        this.activeRunAbortControllers.delete(run.runId);
      }
    }
  }

  private recordEventLoopLag(lagMs: number, runId: string): void {
    const boundedLagMs = Math.max(0, Math.floor(lagMs));
    this.lastEventLoopLagMs = boundedLagMs;
    this.lastEventLoopLagAt = new Date().toISOString();
    if (boundedLagMs < DURABLE_EVENT_LOOP_LAG_WARN_MS) {
      return;
    }
    if (boundedLagMs >= DURABLE_EVENT_LOOP_LAG_PAUSE_MS) {
      this.leaseAcquisitionPausedUntilMs = Math.max(
        this.leaseAcquisitionPausedUntilMs,
        Date.now() + Math.min(30_000, Math.max(5_000, boundedLagMs)),
      );
    }
    this.recordDurableTimelineEventSafely(runId, "worker_event_loop_lag", {
      lagMs: boundedLagMs,
      thresholdMs: DURABLE_EVENT_LOOP_LAG_WARN_MS,
      leaseAcquisitionPausedUntil:
        this.leaseAcquisitionPausedUntilMs > Date.now()
          ? new Date(this.leaseAcquisitionPausedUntilMs).toISOString()
          : undefined,
    });
    this.publishDurableRealtimeSafely(runId, {
      type: "durable_worker_event_loop_lag",
      runId,
      lagMs: boundedLagMs,
      leaseAcquisitionPausedUntil:
        this.leaseAcquisitionPausedUntilMs > Date.now()
          ? new Date(this.leaseAcquisitionPausedUntilMs).toISOString()
          : undefined,
    });
  }

  private isLeaseAcquisitionPaused(): boolean {
    return this.leaseAcquisitionPausedUntilMs > Date.now();
  }

  private claimNextQueuedRun(): DurableRunRecord | undefined {
    const queuedRunIds = this.ctx.storage.durableRuns.listRunIdsByStatus("queued");
    if (queuedRunIds.length === 0) {
      return undefined;
    }
    const now = new Date().toISOString();
    const runId = queuedRunIds.find((candidate) => !this.hasFutureRetryGate(candidate, now));
    if (!runId) {
      return undefined;
    }
    const leaseExpiresAt = new Date(Date.now() + DURABLE_LEASE_TTL_MS).toISOString();
    const leaseOwnerId = randomUUID();
    let run: DurableRunRecord | undefined;
    this.ctx.storage.runImmediateTransaction(() => {
      run = this.ctx.storage.durableRuns.tryClaimQueuedRun({
        runId,
        workerId: leaseOwnerId,
        leaseHeartbeatAt: now,
        leaseExpiresAt,
        updatedAt: now,
      });
      if (!run) {
        return;
      }
      this.createDurableCheckpoint({
        runId: run.runId,
        checkpointKind: "run_started",
        state: {
          workflowKey: run.workflowKey,
          status: run.status,
        },
        createdAt: now,
      });
      this.recordDurableTimelineEvent(run.runId, "run_started", {
        workflowKey: run.workflowKey,
        status: run.status,
      });
    });
    if (!run) {
      return undefined;
    }
    this.publishDurableRealtimeSafely(run.runId, {
      type: "durable_run_started",
      runId: run.runId,
      workflowKey: run.workflowKey,
    });
    return run;
  }

  private hasFutureRetryGate(runId: string, nowIso: string): boolean {
    const latestRetry = this.ctx.storage.durableRuns.listRetries(runId, 100).at(-1);
    if (!latestRetry?.nextRetryAt) {
      return false;
    }
    const nextRetryAt = Date.parse(latestRetry.nextRetryAt);
    const now = Date.parse(nowIso);
    if (!Number.isFinite(nextRetryAt) || !Number.isFinite(now)) {
      return false;
    }
    return nextRetryAt > now;
  }

  private async failWorkflowRun(run: DurableRunRecord, message: string): Promise<boolean> {
    const now = new Date().toISOString();
    const safeMessage = redactRawRemoteApprovalBearerText(message);
    let transitioned = false;
    const failed = this.retryDurableRunUpdate(run.runId, (current) => {
      if (this.isTerminalRunStatus(current.status)) {
        return current;
      }
      if (!this.hasExpectedActiveLease(current, run, now)) {
        return current;
      }
      const next = this.persistFailedRun(current, safeMessage, now);
      transitioned = true;
      return next;
    });
    if (!transitioned) {
      if (failed.leaseOwnerId !== run.leaseOwnerId) {
        this.publishRealtimeSafely(
          "system",
          "durable",
          {
            type: "durable_run_failure_skipped_lease_lost",
            runId: failed.runId,
            error: safeMessage,
            status: failed.status,
            leaseOwnerId: failed.leaseOwnerId,
          },
          {
            eventClass: "operational_signal",
            eventAuthority: "retained_stream",
            links: { runId: failed.runId },
          },
        );
      }
      return false;
    }
    this.publishDurableRealtimeSafely(failed.runId, {
      type: "durable_run_failed",
      runId: failed.runId,
      error: safeMessage,
    });
    await this.notifyRunFailedSafely(failed, safeMessage);
    return true;
  }

  private async notifyRunFailedSafely(run: DurableRunRecord, message: string): Promise<void> {
    try {
      await this.deps?.onRunFailed?.(run, message);
    } catch (error) {
      this.reportDurableRunRecoveryFailure(run.runId, error);
    }
  }

  private persistFailedRun(
    current: DurableRunRecord,
    message: string,
    now: string,
    metadata: Record<string, unknown> | undefined = current.metadata,
  ): DurableRunRecord {
    let next!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      next = this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: "failed",
        finishedAt: now,
        clearLease: true,
        lastError: message,
        metadata,
        updatedAt: now,
        expectedVersion: current.version,
      });
      this.createDurableCheckpoint({
        runId: next.runId,
        checkpointKind: "run_failed",
        state: {
          workflowKey: next.workflowKey,
          error: message,
        },
        createdAt: now,
      });
      this.recordDurableTimelineEvent(next.runId, "run_failed", {
        workflowKey: next.workflowKey,
        error: message,
      });
    });
    return next;
  }

  private isLeaseExpiredAt(run: DurableRunRecord, nowIso: string): boolean {
    return (
      typeof run.leaseExpiresAt === "string" &&
      Number.isFinite(Date.parse(run.leaseExpiresAt)) &&
      Date.parse(run.leaseExpiresAt) <= Date.parse(nowIso)
    );
  }

  private hasExpectedActiveLease(
    current: DurableRunRecord,
    claimed: DurableRunRecord,
    nowIso = new Date().toISOString(),
  ): boolean {
    return this.hasActiveLeaseOwner(current, claimed.leaseOwnerId, nowIso);
  }

  private hasActiveLeaseOwner(
    current: DurableRunRecord,
    expectedLeaseOwnerId: string | undefined,
    nowIso = new Date().toISOString(),
  ): boolean {
    return (
      current.status === "running" &&
      Boolean(expectedLeaseOwnerId) &&
      current.leaseOwnerId === expectedLeaseOwnerId &&
      typeof current.leaseExpiresAt === "string" &&
      Number.isFinite(Date.parse(current.leaseExpiresAt)) &&
      Date.parse(current.leaseExpiresAt) > Date.parse(nowIso)
    );
  }

  private isTerminalRunStatus(status: DurableRunRecord["status"]): boolean {
    return status === "completed" || status === "failed" || status === "cancelled" || status === "dead_lettered";
  }

  private retryDurableRunUpdate(
    runId: string,
    update: (current: DurableRunRecord) => DurableRunRecord,
    maxAttempts = 3,
  ): DurableRunRecord {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const current = this.ctx.storage.durableRuns.getRun(runId);
      try {
        return update(current);
      } catch (error) {
        if (!isDurableRunUpdateConflict(error) || attempt === maxAttempts - 1) {
          throw error;
        }
        lastError = error;
      }
    }
    this.publishRealtimeSafely(
      "durable_run_update_conflict_exhausted",
      "durable",
      {
        runId,
        attempts: maxAttempts,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          runId,
        },
      },
    );
    throw lastError instanceof Error ? lastError : new Error(`Durable run ${runId} update conflict`);
  }

  private ensurePollLoop(): void {
    if (this.pollTimer || this.workerStopped) {
      return;
    }
    const scheduleNext = () => {
      if (this.workerStopped) {
        return;
      }
      const jitter = Math.floor(Math.random() * DURABLE_WORKER_POLL_JITTER_MS);
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        if (this.workerStopped) {
          return;
        }
        this.requestRunProcessing();
        scheduleNext();
      }, DURABLE_WORKER_POLL_MIN_MS + jitter);
    };
    scheduleNext();
  }
}

export function resolveDurableWorkflowTimeoutMs(_run: DurableRunRecord, defaultTimeoutMs: number): number | undefined {
  return defaultTimeoutMs;
}

function isDurableWorkflowTimeoutError(error: unknown): error is DurableWorkflowTimeoutError {
  return error instanceof DurableWorkflowTimeoutError;
}

function isAutonomousDurableRunDisabledError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AutonomousDurableRunDisabledError";
}

function isCoworkDurableChatTurnRun(run: DurableRunRecord): boolean {
  if (run.workflowKey !== "chat.turn.execute") {
    return false;
  }
  const payload = run.payload as
    | {
        version?: unknown;
        request?: {
          mode?: unknown;
          normalizationProfile?: unknown;
        };
      }
    | undefined;
  return (
    payload?.version === "chat.turn.execute.v1" &&
    payload.request?.mode === "cowork" &&
    payload.request?.normalizationProfile !== "prompt_pack_harness"
  );
}

function isAutonomousDurableRunForKillSwitch(run: DurableRunRecord): boolean {
  if (run.workflowKey === "proactive.tick") {
    return true;
  }
  const metadata = run.metadata as Record<string, unknown> | undefined;
  const autonomous = metadata?.autonomous;
  return (
    autonomous === true ||
    (typeof autonomous === "object" && autonomous !== null) ||
    metadata?.deliveryKind === "autonomous.assistant_message"
  );
}

function isDurableRunUpdateConflict(error: unknown): boolean {
  return error instanceof Error && /durable run .* update conflict/i.test(error.message);
}

/**
 * Durable execution is a shipped always-on baseline: report every config/stored-flag
 * field that has drifted away from it. Pure — the caller decides how to surface drift.
 */
export function computeDurableBaselineDrift(input: {
  durable: { enabled: boolean; executionEnabled: boolean; chatAutoPromoteEnabled: boolean };
  configuredFeatureFlag: boolean | undefined;
  storedDurableKernelFlag: boolean | undefined;
}): string[] {
  const driftedFields: string[] = [];
  if (!input.durable.enabled) {
    driftedFields.push("assistant.durable.enabled");
  }
  if (!input.durable.executionEnabled) {
    driftedFields.push("assistant.durable.executionEnabled");
  }
  if (!input.durable.chatAutoPromoteEnabled) {
    driftedFields.push("assistant.durable.chatAutoPromoteEnabled");
  }
  if (!input.configuredFeatureFlag) {
    driftedFields.push("features.durableKernelV1Enabled");
  }
  if (input.storedDurableKernelFlag === false) {
    driftedFields.push("feature_flags_v1.durableKernelV1Enabled");
  }
  return driftedFields;
}

function resolveCheckpointPruneConfig(): { keepPerRun: number; diskBudgetBytes: number } {
  const keepRaw = process.env.GOATCITADEL_DURABLE_CHECKPOINT_KEEP_PER_RUN?.trim();
  const budgetRaw = process.env.GOATCITADEL_DURABLE_CHECKPOINT_DISK_BUDGET_BYTES?.trim();
  const keepParsed = keepRaw ? Number.parseInt(keepRaw, 10) : Number.NaN;
  const budgetParsed = budgetRaw ? Number.parseInt(budgetRaw, 10) : Number.NaN;
  return {
    keepPerRun: Number.isFinite(keepParsed) && keepParsed > 0 ? keepParsed : DURABLE_CHECKPOINT_KEEP_PER_RUN_DEFAULT,
    diskBudgetBytes:
      Number.isFinite(budgetParsed) && budgetParsed >= 0 ? budgetParsed : DURABLE_CHECKPOINT_DISK_BUDGET_BYTES_DEFAULT,
  };
}
