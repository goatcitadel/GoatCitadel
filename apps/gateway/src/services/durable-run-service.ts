/* eslint-disable max-lines -- Durable run lifecycle service intentionally centralizes lease, recovery, timeline, and diagnostics behavior. */
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type {
  ChatTurnTraceRecord,
  DurableChildWatcherCatchUpResult,
  DurableChildWatcherCreateRequest,
  DurableChildWatcherRecord,
  DurableBackgroundTaskControlRequest,
  DurableBackgroundTaskControlResponse,
  DurableBackgroundTaskRailResponse,
  DurableCheckpointRecord,
  ContinuationGateDecision,
  DurableDeadLetterRecord,
  DurableDiagnosticsResponse,
  RealtimeEvent,
  DurableRetryRecord,
  DurableRetryPolicy,
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunTimelineEvent,
  DurableWakeResult,
} from "@goatcitadel/contracts";
import {
  CHAT_TURN_ACTIVE_STATUSES,
  canonicalJsonString,
  isChatTurnTerminalStatus,
  isDurableRunTerminal,
  NotFoundError,
  redactStructuredSecrets,
  assertDurableChildWatcherCreateRequestBounds,
  assertDurableChildWatcherIdBounds,
  assertDurableChildWatcherRunIdBounds,
} from "@goatcitadel/contracts";
import {
  computePostCommitChildAdmissionMaterialSha256,
  type PostCommitChildAdmissionIdentity,
  type PostCommitEligibility,
  type SessionMutationAdmissionRecord,
  type AsyncStorage as Storage,
} from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { trackBackgroundTask } from "./background-scheduler.js";
import type { DurableWorkflowExecutorRegistry } from "./durable-execution-service.js";
import type { EvidenceEnvelopeCreateRequest } from "./evidence-envelope-service.js";
import type { SharedHostLifecycleAdmissionPort } from "./shared-host-lifecycle-service.js";
import { projectDurableBackgroundTaskRail } from "./durable-background-task-projection.js";
import {
  CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY,
  HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY,
  HEARTBEAT_DECISION_RECEIPT_METADATA_KEY,
  buildHeartbeatDecisionReceipt,
  buildChatTurnRuntimeAuthoritySeal,
  hashChatTurnRuntimeAuthorityValue,
  readChatTurnRuntimeAuthoritySeal,
  readExactAutonomousChatPostCommitSettlement,
  readExactChatTurnAdmissionHandoff,
  readExactGeneralChatPostCommitSettlement,
  readExactLegacyGeneralChatPostCommitPendingMarker,
  readExactLinkedFinalizationPendingMarker,
  readExactLinkedFinalizationSettlement,
  selectCanonicalGeneralChatPostCommitResolution,
  verifyCheckpointAnchoredChatTurnRuntimeAuthority,
  verifyAutonomousChatAdmissionRunMetadata,
  withChatTurnRuntimeAuthority,
  withChatTurnRuntimeAuthorityCheckpoint,
  type ChatTurnRuntimeAuthoritySealV1,
  type ExactLinkedFinalizationPendingMarker,
} from "./chat-durable-runtime-authority.js";
import {
  DURABLE_RETRY_POLICY_DEFAULT,
  assertDurableRetryPolicyMatchesRun,
  normalizeDurableRetryPolicy,
} from "./durable-retry-policy.js";
import {
  AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY,
  GENERAL_CHAT_POST_COMMIT_DURABLE_EFFECTS,
  GENERAL_CHAT_POST_COMMIT_EFFECTS,
  GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY,
  type AutonomousChatPostCommitPendingMarker,
  type GeneralChatPostCommitEffect,
  type GeneralChatPostCommitDurableEffectInput,
  type GeneralChatPostCommitEffectWorkflowPayload,
  type GeneralChatPostCommitPendingMarker,
  type GeneralChatPostCommitProgress,
  hasAutonomousChatPostCommitPending,
  hasGeneralChatPostCommitPending,
  markGeneralChatPostCommitPending,
  mergeCanonicalDurableChatTerminalOutputMetadata,
  readAutonomousChatPostCommitPendingMarker,
  readGeneralChatPostCommitCompletedEffects,
  readGeneralChatPostCommitPendingMarker,
  resetChatTurnRuntimeTransitionMetadata,
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
  ): Promise<unknown>;
  requireFeatureEnabled(flag: keyof RuntimeSettings["features"]): Promise<void>;
  isFeatureEnabled(flag: keyof RuntimeSettings["features"]): Promise<boolean>;
}

export interface DurableRunServiceLogger {
  info(data: unknown, msg: string): void;
  debug(data: unknown, msg: string): void;
  warn(data: unknown, msg: string): void;
  error(data: unknown, msg: string): void;
}

export interface DurableBackgroundAttentionNotificationInput {
  eventId: string;
  workspaceId: string;
  sessionId: string;
  watcherId: string;
  childRunId: string;
  title: string;
  message: string;
}

function buildDurableBackgroundAttentionEventId(task: DurableBackgroundTaskRailResponse["tasks"][number]): string {
  const material = canonicalJsonString({
    version: 1,
    watcherId: task.watcherId,
    watcherRevision: task.watcherRevision,
    childRunId: task.childRunId,
    childVersion: task.childVersion ?? null,
    canonicalStatus: task.canonicalStatus,
    attentionReason: task.attention.requiredReason ?? null,
    approvals: task.approvals
      .map((approval) => ({ approvalId: approval.approvalId, status: approval.status }))
      .sort((left, right) => left.approvalId.localeCompare(right.approvalId)),
    tools: task.tools
      .map((tool) => ({
        toolRunId: tool.toolRunId,
        status: tool.status,
        approvalId: tool.approvalId ?? null,
      }))
      .sort((left, right) => left.toolRunId.localeCompare(right.toolRunId)),
  });
  return `durable-attention:${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

function isBackgroundAttentionCandidateEvent(eventType: DurableRunTimelineEvent["eventType"]): boolean {
  return [
    "run_waiting",
    "run_paused",
    "run_failed",
    "run_cancelled",
    "run_dead_lettered",
    "run_retry_budget_exhausted",
    "run_incomplete_worker_exit",
  ].includes(eventType);
}

function readBoundedPayloadId(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 200 ? normalized : undefined;
}

// The lease must survive sustained event-loop starvation: a single native
// browser navigation or repo-wide search can stall the loop for 60-90s on a
// loaded workstation, and a 15s TTL caused the reaper to fail healthy runs at
// checkpoint run_started while their turns completed normally.
const DURABLE_LEASE_TTL_MS = 120_000;
const DURABLE_WORKER_POLL_MIN_MS = 750;
const DURABLE_WORKER_POLL_JITTER_MS = 500;
const DURABLE_LEASE_HEARTBEAT_MS = 5_000;
const DETACHED_WATCHER_NOTIFICATION_BATCH_SIZE = 100;
// Transient lease-renewal errors (storage contention, CAS retry exhaustion)
// should not abort an in-flight run; only repeated consecutive failures may.
const DURABLE_LEASE_HEARTBEAT_MAX_CONSECUTIVE_FAILURES = 3;
const DURABLE_EVENT_LOOP_LAG_WARN_MS = 1_000;
const DURABLE_EVENT_LOOP_LAG_PAUSE_MS = 2_000;
const DURABLE_CHECKPOINT_KEEP_PER_RUN_DEFAULT = 50;
const LEGACY_GENERAL_CHAT_POST_COMMIT_SETTLEMENT_METADATA_KEY = "legacyGeneralChatPostCommitSettlement" as const;
const LEGACY_GENERAL_CHAT_POST_COMMIT_SETTLEMENT_VERSION = "chat.post_commit.legacy-settlement.v1" as const;
const DURABLE_CHECKPOINT_DISK_BUDGET_BYTES_DEFAULT = 64 * 1024 * 1024;
const TERMINAL_CHAT_ADMISSION_RELEASE_POLL_MS = 25;
const TERMINAL_CHAT_ADMISSION_RECOVERY_TIMEOUT_MS = 5_000;
const DURABLE_LOCAL_PROCESS_LEASE_VERSION = "local-process-v1";
const DURABLE_LOCAL_HOST_FINGERPRINT = createHash("sha256")
  .update(hostname().trim().toLowerCase(), "utf8")
  .digest("hex")
  .slice(0, 16);

export interface TerminalChatAdmissionReleaseOutcome {
  recoveryOutcome:
    | "released"
    | "already_released"
    | "not_bound"
    | "not_terminal"
    | "reconciliation_pending"
    | "lineage_mismatch"
    | "recovery_failed";
  durableRunId?: string;
  durableRunStatus?: DurableRunRecord["status"];
  admissionId?: string;
  admissionStatus?: SessionMutationAdmissionRecord["status"];
  elapsedMs: number;
  remainingBudgetMs: number;
  error?: string;
}

function readExactSystemHeartbeatFailurePayload(
  run: DurableRunRecord,
  payload: {
    heartbeatOccurrenceId?: unknown;
    heartbeatClaimSha256?: unknown;
    heartbeatEvaluatedPolicySha256?: unknown;
    heartbeatFrozenObjectiveSha256?: unknown;
    requestActor?: unknown;
  },
): boolean {
  const fields = [
    payload.heartbeatOccurrenceId,
    payload.heartbeatClaimSha256,
    payload.heartbeatEvaluatedPolicySha256,
    payload.heartbeatFrozenObjectiveSha256,
  ];
  if (fields.every((value) => value === undefined)) {
    if (
      run.metadata?.[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY] !== undefined ||
      run.metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY] !== undefined
    ) {
      throw new Error(`Non-heartbeat Chat run ${run.runId} contains heartbeat decision evidence.`);
    }
    return false;
  }
  const requestActor =
    payload.requestActor && typeof payload.requestActor === "object" && !Array.isArray(payload.requestActor)
      ? (payload.requestActor as Record<string, unknown>)
      : undefined;
  const autonomous =
    run.metadata?.autonomous && typeof run.metadata.autonomous === "object" && !Array.isArray(run.metadata.autonomous)
      ? (run.metadata.autonomous as Record<string, unknown>)
      : undefined;
  if (
    typeof payload.heartbeatOccurrenceId !== "string" ||
    !payload.heartbeatOccurrenceId.trim() ||
    typeof payload.heartbeatClaimSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.heartbeatClaimSha256) ||
    typeof payload.heartbeatEvaluatedPolicySha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.heartbeatEvaluatedPolicySha256) ||
    typeof payload.heartbeatFrozenObjectiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.heartbeatFrozenObjectiveSha256) ||
    requestActor?.actorKind !== "system" ||
    requestActor.actorId !== "system-heartbeat" ||
    autonomous?.kind !== "heartbeat" ||
    autonomous.systemActorId !== "system-heartbeat" ||
    run.metadata?.[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY] !== undefined ||
    run.metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY] !== undefined
  ) {
    throw new Error(`Durable Chat run ${run.runId} has malformed system-heartbeat failure evidence.`);
  }
  return true;
}
const COWORK_WORKFLOW_TIMEOUT_RESUME_EVENT = "cowork.turn.operator_resume";
const AUTONOMY_KILL_SWITCH_RESUME_EVENT = "autonomy.v1.enabled";
const RAW_REMOTE_APPROVAL_BEARER_PATTERN = /grat_[A-Za-z0-9_-]{43}/;
const RAW_REMOTE_APPROVAL_BEARER_GLOBAL_PATTERN = /grat_[A-Za-z0-9_-]{43}/g;
const CHAT_TERMINAL_OUTPUT_METADATA_KEYS = [
  "outputText",
  "finalOutput",
  "outputSummary",
  "finalSummary",
  "outputMessageId",
  "outputTraceStatus",
] as const;
const CHAT_TERMINAL_OUTPUT_CHECKPOINT_KEYS = ["assistantMessageId", "outputText", "outputSummary"] as const;
const CHAT_RETRY_EXHAUSTION_DEAD_LETTER_PENDING_METADATA_KEY = "chatRetryExhaustionDeadLetterPending" as const;

interface ChatRetryExhaustionDeadLetterPending {
  version: 1;
  attemptNo: number;
  maxAttempts: number;
  actorId: string;
  reason: string;
  reasonSha256: string;
  requestedAt: string;
}

function readChatRetryExhaustionDeadLetterPending(value: unknown): ChatRetryExhaustionDeadLetterPending | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Chat retry-exhaustion dead-letter marker must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "actorId,attemptNo,maxAttempts,reason,reasonSha256,requestedAt,version" ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.attemptNo) ||
    !Number.isSafeInteger(record.maxAttempts) ||
    Number(record.attemptNo) <= Number(record.maxAttempts) ||
    Number(record.maxAttempts) < 1 ||
    typeof record.actorId !== "string" ||
    !record.actorId.trim() ||
    typeof record.reason !== "string" ||
    !record.reason.trim() ||
    typeof record.reasonSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.reasonSha256) ||
    record.reasonSha256 !== hashChatTurnRuntimeAuthorityValue(record.reason) ||
    typeof record.requestedAt !== "string" ||
    Number.isNaN(Date.parse(record.requestedAt))
  ) {
    throw new Error("Chat retry-exhaustion dead-letter marker is invalid.");
  }
  return record as unknown as ChatRetryExhaustionDeadLetterPending;
}

function sameGeneralChatPostCommitGeneration(
  left: GeneralChatPostCommitPendingMarker,
  right: GeneralChatPostCommitPendingMarker,
): boolean {
  return (
    left.generationId === right.generationId &&
    left.traceStatus === right.traceStatus &&
    canonicalJsonString(left.postCommitEligibility) === canonicalJsonString(right.postCommitEligibility)
  );
}

function buildGeneralChatPostCommitEffectRunId(
  parentRunId: string,
  generationId: string,
  effect: GeneralChatPostCommitDurableEffectInput["effect"],
): string {
  const digest = createHash("sha256")
    .update(`${parentRunId}\u0000${generationId}\u0000${effect}`)
    .digest("hex")
    .slice(0, 32);
  return `chat-post-commit-${digest}`;
}

function assertGeneralChatPostCommitEffectChild(
  child: DurableRunRecord,
  expected: GeneralChatPostCommitEffectWorkflowPayload,
): void {
  if (
    child.workflowKey !== "chat.post_commit.effect" ||
    canonicalJsonString(child.payload) !== canonicalJsonString(expected)
  ) {
    throw new Error(
      `Durable Chat post-commit child ${child.runId} does not match its parent generation and effect payload.`,
    );
  }
}

async function findDurableRun(storage: Storage, runId: string): Promise<DurableRunRecord | undefined> {
  try {
    return await storage.durableRuns.getRun(runId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return undefined;
    }
    throw error;
  }
}

function assertIdempotentDurableRunMatches(
  existing: DurableRunRecord,
  workflowKey: string,
  payload: Record<string, unknown>,
  retryPolicy: DurableRetryPolicy,
): void {
  if (existing.workflowKey !== workflowKey || JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
    throw new Error(`Durable run ${existing.runId} is already owned by a different immutable workflow payload.`);
  }
  assertDurableRetryPolicyMatchesRun(existing.metadata?.retryPolicy, existing.maxAttempts, retryPolicy);
}

function assertGeneralChatPostCommitEffectChildLink(
  child: DurableRunRecord,
  parentRunId: string,
  generationId: string,
  effect: GeneralChatPostCommitDurableEffectInput["effect"],
): void {
  const payload = child.payload as Partial<GeneralChatPostCommitEffectWorkflowPayload>;
  if (
    child.workflowKey !== "chat.post_commit.effect" ||
    payload.version !== "chat.post_commit.effect.v2" ||
    payload.parentRunId !== parentRunId ||
    payload.postCommitGenerationId !== generationId ||
    payload.effect !== effect ||
    payload.input?.effect !== effect ||
    child.metadata?.parentRunId !== parentRunId ||
    child.metadata?.postCommitGenerationId !== generationId ||
    child.metadata?.effect !== effect
  ) {
    throw new Error(`Durable Chat post-commit child ${child.runId} has inconsistent parent linkage.`);
  }
}

function isGeneralChatPostCommitDurableEffect(
  effect: GeneralChatPostCommitEffect,
): effect is GeneralChatPostCommitDurableEffectInput["effect"] {
  return (GENERAL_CHAT_POST_COMMIT_DURABLE_EFFECTS as readonly string[]).includes(effect);
}

function readGeneralChatPostCommitWorkspaceId(input: GeneralChatPostCommitDurableEffectInput): string {
  return input.workspaceId;
}

function readGeneralChatPostCommitTurnId(input: GeneralChatPostCommitDurableEffectInput): string {
  return input.turnId;
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

type LinkedFinalizationPending = ExactLinkedFinalizationPendingMarker;

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
    (payload.version !== "chat.turn.execute.v1" && payload.version !== "chat.turn.execute.v2") ||
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

function isLegacyUnadmittedDurableChatTurn(run: DurableRunRecord): boolean {
  return (
    run.workflowKey === "chat.turn.execute" &&
    (run.payload as { version?: unknown } | undefined)?.version === "chat.turn.execute.v1"
  );
}

function isAdmittedV2ChatRun(run: DurableRunRecord): boolean {
  return (
    run.workflowKey === "chat.turn.execute" &&
    (run.payload as { version?: unknown } | undefined)?.version === "chat.turn.execute.v2"
  );
}

function isAutonomousAdmittedV2ChatRun(run: DurableRunRecord): boolean {
  return isAdmittedV2ChatRun(run) && run.metadata?.autonomousAdmission !== undefined;
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

function normalizeDurableCancellationReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  if (!trimmed) return undefined;
  if (Buffer.byteLength(trimmed, "utf8") > 240) {
    throw new Error("Durable cancellation reason exceeds 240 bytes.");
  }
  const redacted = redactStructuredSecrets(trimmed).value.trim();
  return redacted || undefined;
}

const LINKED_FINALIZATION_CLAIM_TTL_MS = 30_000;
const LINKED_FINALIZATION_TIMEOUT_MS = 60_000;
const AUTONOMOUS_CHAT_POST_COMMIT_CLAIM_TTL_MS = 30_000;
const AUTONOMOUS_CHAT_POST_COMMIT_TIMEOUT_MS = 60_000;
// General Chat post-commit effects are locally receipt/idempotency guarded, but
// their composite callback does not expose a safely propagated AbortSignal.
// Bound only the process-local attempt ownership so a hung callback can be
// retried without allowing its stale completion to release a newer owner.
const GENERAL_CHAT_POST_COMMIT_IN_FLIGHT_TTL_MS = TERMINAL_CHAT_ADMISSION_RECOVERY_TIMEOUT_MS;
const GENERAL_CHAT_POST_COMMIT_SWEEP_CONCURRENCY = 8;

interface GeneralChatPostCommitInFlight {
  ownershipGeneration: string;
  marker: GeneralChatPostCommitPendingMarker | undefined;
  expiresAtMs: number;
  work: Promise<boolean>;
}

export interface AutonomousChatPostCommitContext {
  claimId: string;
  signal: AbortSignal;
}

function sameAutonomousChatPostCommitGeneration(
  left: AutonomousChatPostCommitPendingMarker,
  right: AutonomousChatPostCommitPendingMarker,
): boolean {
  return (
    left.version === right.version && left.requestedAt === right.requestedAt && left.generationId === right.generationId
  );
}

function readLinkedFinalizationPending(run: DurableRunRecord): LinkedFinalizationPending | undefined {
  const value = (run.metadata as { linkedFinalizationPending?: unknown } | undefined)?.linkedFinalizationPending;
  if (value === undefined) return undefined;
  try {
    return readExactLinkedFinalizationPendingMarker(value);
  } catch (error) {
    // Explicit compatibility for pre-finalization-id rows. New writers always
    // persist exact keyed receipts, but old rows remain recoverable under a
    // deterministic synthetic identity.
    if (!value || typeof value !== "object" || Array.isArray(value)) throw error;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "reason,requestedAt" ||
      typeof record.reason !== "string" ||
      !record.reason ||
      typeof record.requestedAt !== "string" ||
      Number.isNaN(Date.parse(record.requestedAt))
    ) {
      throw error;
    }
    return {
      reason: record.reason,
      requestedAt: record.requestedAt,
      finalizationId: `legacy:${run.runId}:${record.requestedAt}`,
    };
  }
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

class DurableChatParentAuthoritySupersededError extends Error {
  public constructor(public readonly runId: string) {
    super(`Durable Chat parent ${runId} no longer owns the current session authority.`);
    this.name = "DurableChatParentAuthoritySupersededError";
  }
}

export class DurableWorkerInterruptionError extends Error {
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
  private readonly workerId = buildDurableLocalProcessLeaseOwnerId();
  private readonly activeRunAbortControllers = new Map<string, { controller: AbortController; leaseOwnerId: string }>();
  private readonly generalChatPostCommitInFlight = new Map<string, GeneralChatPostCommitInFlight>();
  private readonly deliveredBackgroundAttentionEvents = new Set<string>();
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
      onBackgroundAttentionRequired?: (
        input: DurableBackgroundAttentionNotificationInput,
      ) => Promise<boolean | void> | boolean | void;
      beforeBackgroundTaskRailProjection?: (
        parentRunId: string,
        input: { workspaceId: string; sessionId: string },
      ) => Promise<void> | void;
      onAutonomousChatPostCommit?: (
        run: DurableRunRecord,
        context: AutonomousChatPostCommitContext,
      ) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
      onGeneralChatPostCommit?: (
        run: DurableRunRecord,
        progress: GeneralChatPostCommitProgress,
      ) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
      resolvePostCommitEligibility?: (sessionId: string) => Promise<PostCommitEligibility>;
      evaluateContinuationGate?: (run: DurableRunRecord) => Promise<ContinuationGateDecision | undefined>;
      recordEvidenceEnvelope?: (input: EvidenceEnvelopeCreateRequest) => Promise<unknown>;
      taskLifecycle?: {
        autoBlockOnIncompleteExit(taskId: string, runId: string): unknown | Promise<unknown>;
      };
      sharedHostLifecycle?: SharedHostLifecycleAdmissionPort;
      isLocalProcessAlive?: (pid: number) => boolean;
    },
  ) {}

  // ── queries ──────────────────────────────────────────────────────

  async getDurableDiagnostics(): Promise<DurableDiagnosticsResponse> {
    const [statusCounts, runCount, deadLetters, recentRuns, recentDeadLetters] = await Promise.all([
      this.ctx.storage.durableRuns.statusCounts(),
      this.ctx.storage.durableRuns.countRuns(),
      this.ctx.storage.durableRuns.listDeadLetters(1000),
      this.ctx.storage.durableRuns.listRuns(25),
      this.ctx.storage.durableRuns.listDeadLetters(25),
    ]);
    const durableFoundationReady = this.isDurableFoundationEnabled() && Boolean(this.deps?.workflowRegistry);
    return {
      enabled: this.isDurableFoundationEnabled(),
      replayFoundationReady: durableFoundationReady,
      runCount,
      queuedCount: statusCounts.queued ?? 0,
      runningCount: statusCounts.running ?? 0,
      waitingCount: statusCounts.waiting ?? 0,
      failedCount: statusCounts.failed ?? 0,
      deadLetterCount: deadLetters.length,
      recentRuns: recentRuns.map((run) => deriveDurableRunOperationalState(run)),
      recentDeadLetters,
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

  async listDurableRuns(limit = 50): Promise<DurableRunRecord[]> {
    return (await this.ctx.storage.durableRuns.listRuns(limit)).map((run) => deriveDurableRunOperationalState(run));
  }

  async listDurableDeadLetters(limit = 50): Promise<DurableDeadLetterRecord[]> {
    return await this.ctx.storage.durableRuns.listDeadLetters(limit);
  }

  async listDurableRunCheckpoints(runId: string, limit = 200): Promise<DurableCheckpointRecord[]> {
    return await this.ctx.storage.durableRuns.listCheckpoints(runId, limit);
  }

  async getDurableRun(runId: string): Promise<DurableRunRecord> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    return deriveDurableRunOperationalState(await this.ctx.storage.durableRuns.getRun(runId));
  }

  async listDurableRunTimeline(runId: string, limit = 300): Promise<DurableRunTimelineEvent[]> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    return await this.ctx.storage.durableRunEvents.listByRun(runId, limit);
  }

  async watchDurableChildRun(input: DurableChildWatcherCreateRequest): Promise<DurableChildWatcherRecord> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const parentRunId = input.parentRunId.trim();
    const childRunId = input.childRunId.trim();
    if (!parentRunId || !childRunId) {
      throw new Error("Both parentRunId and childRunId are required for a durable child watcher");
    }
    if (parentRunId === childRunId) {
      throw new Error("A durable run cannot watch itself");
    }
    const watcherId =
      input.watcherId?.trim() ||
      `durable-child-watcher-${createHash("sha256")
        .update(`${parentRunId}\u0000${childRunId}`)
        .digest("hex")
        .slice(0, 32)}`;
    const source = input.source?.trim() || undefined;
    const boundedInput: DurableChildWatcherCreateRequest = {
      parentRunId,
      childRunId,
      watcherId,
      source,
      metadata: input.metadata ?? {},
    };
    assertDurableChildWatcherCreateRequestBounds(boundedInput);
    await this.ctx.storage.durableRuns.getRun(parentRunId);
    await this.ctx.storage.durableRuns.getRun(childRunId);
    const metadata = redactStructuredSecrets(redactRawRemoteApprovalBearers(boundedInput.metadata ?? {})).value;
    assertDurableChildWatcherCreateRequestBounds({ ...boundedInput, metadata });
    let watcher!: DurableChildWatcherRecord;
    await this.ctx.storage.runImmediateTransaction(async () => {
      const created = await this.ctx.storage.durableChildWatchers.create({
        watcherId,
        parentRunId,
        childRunId,
        source,
        metadata,
      });
      watcher = (await this.ctx.storage.durableChildWatchers.catchUpWatcher(created.watcherId, 100)).watcher;
    });
    return watcher;
  }

  async listDurableChildWatchers(parentRunId: string, limit = 200): Promise<DurableChildWatcherRecord[]> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertDurableChildWatcherRunIdBounds(parentRunId);
    await this.ctx.storage.durableRuns.getRun(parentRunId);
    return await this.ctx.storage.durableChildWatchers.listByParent(parentRunId, limit);
  }

  async detachDurableChildWatcher(watcherId: string): Promise<DurableChildWatcherRecord> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertDurableChildWatcherIdBounds(watcherId);
    return await this.ctx.storage.durableChildWatchers.detach(watcherId);
  }

  async reattachDurableChildWatcher(watcherId: string): Promise<DurableChildWatcherCatchUpResult> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertDurableChildWatcherIdBounds(watcherId);
    let result!: DurableChildWatcherCatchUpResult;
    await this.ctx.storage.runImmediateTransaction(async () => {
      const watcher = await this.ctx.storage.durableChildWatchers.reattach(watcherId);
      result = await this.ctx.storage.durableChildWatchers.catchUpWatcher(watcher.watcherId, 100);
    });
    return result;
  }

  async closeDurableChildWatcher(watcherId: string): Promise<DurableChildWatcherRecord> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertDurableChildWatcherIdBounds(watcherId);
    return await this.ctx.storage.durableChildWatchers.close(watcherId);
  }

  async getDurableBackgroundTaskRail(
    parentRunId: string,
    input: { workspaceId: string; sessionId: string },
  ): Promise<DurableBackgroundTaskRailResponse> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertDurableChildWatcherRunIdBounds(parentRunId);
    await this.deps?.beforeBackgroundTaskRailProjection?.(parentRunId, input);
    const rail = await projectDurableBackgroundTaskRail(this.ctx.storage, { parentRunId, ...input });
    // Notification routing is advisory and may perform external I/O. Never let
    // it delay or decide the canonical rail/control response.
    void this.notifyBackgroundAttentionSafely(rail).catch(() => undefined);
    return rail;
  }

  private async notifyBackgroundAttentionSafely(rail: DurableBackgroundTaskRailResponse): Promise<void> {
    const notify = this.deps?.onBackgroundAttentionRequired;
    if (!notify) return;
    for (const task of rail.tasks) {
      if (task.attention.state !== "background" || !task.attention.required || !task.attention.requiredReason) {
        continue;
      }
      const eventId = buildDurableBackgroundAttentionEventId(task);
      if (this.deliveredBackgroundAttentionEvents.has(eventId)) continue;
      if (this.deliveredBackgroundAttentionEvents.size >= 5_000) {
        const oldest = this.deliveredBackgroundAttentionEvents.values().next().value as string | undefined;
        if (oldest) this.deliveredBackgroundAttentionEvents.delete(oldest);
      }
      this.deliveredBackgroundAttentionEvents.add(eventId);
      try {
        const accepted = await notify({
          eventId,
          workspaceId: rail.scope.workspaceId,
          sessionId: rail.scope.sessionId,
          watcherId: task.watcherId,
          childRunId: task.childRunId,
          title: "Background task needs attention",
          message: `${task.label} needs attention: ${task.attention.requiredReason.replaceAll("_", " ")}.`,
        });
        if (accepted === false) this.deliveredBackgroundAttentionEvents.delete(eventId);
      } catch {
        // A later projection may retry the same stable event ID. The
        // notification repository's event/delivery idempotency prevents a
        // successful earlier side effect from being duplicated.
        this.deliveredBackgroundAttentionEvents.delete(eventId);
        this.ctx.logger?.warn(
          {
            watcherId: task.watcherId,
            childRunId: task.childRunId,
            eventId,
            error: "Notification delivery failed.",
          },
          "background attention notification failed without changing durable execution",
        );
      }
    }
  }

  async controlDurableBackgroundTask(
    parentRunId: string,
    watcherId: string,
    input: DurableBackgroundTaskControlRequest,
    actorId = "operator",
  ): Promise<DurableBackgroundTaskControlResponse> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertDurableChildWatcherRunIdBounds(parentRunId);
    assertDurableChildWatcherIdBounds(watcherId);
    assertNoRawRemoteApprovalBearer(actorId);

    const before = await this.getDurableBackgroundTaskRail(parentRunId, input);
    const task = before.tasks.find((candidate) => candidate.watcherId === watcherId);
    if (!task) {
      throw new NotFoundError({ entity: "Durable background task", id: watcherId });
    }
    const alreadyConverged =
      (input.action === "detach" && task.watcherState === "detached") ||
      (input.action === "reattach" && task.watcherState === "attached") ||
      (input.action === "cancel" && task.canonicalStatus === "cancelled");
    if (!alreadyConverged && task.watcherRevision !== input.expectedWatcherRevision) {
      throw new Error(`Durable child watcher ${watcherId} changed before ${input.action} could be applied.`);
    }

    let outcome: DurableBackgroundTaskControlResponse["outcome"] = alreadyConverged ? "converged" : "applied";
    if (input.action === "detach") {
      if (!alreadyConverged) {
        if (!task.controls.detach.enabled) {
          throw new Error(task.controls.detach.reason ?? `Durable child watcher ${watcherId} cannot be detached.`);
        }
        const transition = await this.ctx.storage.runImmediateTransaction(() =>
          this.ctx.storage.durableChildWatchers.detachIfRevision(watcherId, parentRunId, input.expectedWatcherRevision),
        );
        outcome = transition.outcome;
      }
    } else if (input.action === "reattach") {
      if (!alreadyConverged) {
        if (!task.controls.reattach.enabled) {
          throw new Error(task.controls.reattach.reason ?? `Durable child watcher ${watcherId} cannot be reattached.`);
        }
        const transition = await this.ctx.storage.runImmediateTransaction(async () => {
          const result = await this.ctx.storage.durableChildWatchers.reattachIfRevision(
            watcherId,
            parentRunId,
            input.expectedWatcherRevision,
          );
          await this.ctx.storage.durableChildWatchers.catchUpWatcher(watcherId, 100);
          return result;
        });
        outcome = transition.outcome;
      }
    } else {
      if (!alreadyConverged) {
        if (!task.controls.cancel.enabled || task.childVersion === undefined) {
          throw new Error(task.controls.cancel.reason ?? `Durable child run ${task.childRunId} cannot be cancelled.`);
        }
        if (input.expectedChildVersion === undefined) {
          throw new Error("expectedChildVersion is required to cancel a background task.");
        }
        const cancelled = await this.cancelDurableRun(task.childRunId, `background-task-rail:${actorId}`, {
          expectedVersion: input.expectedChildVersion,
          reason: input.reason,
          assertLockedPrecondition: async () => {
            await this.ctx.storage.durableChildWatchers.claimControlRevision(
              watcherId,
              parentRunId,
              input.expectedWatcherRevision,
            );
          },
        });
        if (cancelled.version !== input.expectedChildVersion + 1) outcome = "converged";
      }
    }

    return {
      version: "durable.background_task_control.v1",
      action: input.action,
      watcherId,
      childRunId: task.childRunId,
      outcome,
      rail: await this.getDurableBackgroundTaskRail(parentRunId, input),
    };
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
    const bootTask = Promise.resolve()
      .then(() =>
        this.runWithSharedHostWorkerAdmission(async () => {
          try {
            await this.performBootRecovery();
          } catch (error) {
            await this.reportWorkerBackgroundFailure("boot_recovery", error);
          }
          try {
            await this.runWorkerProcessingLoop();
          } catch (error) {
            await this.reportWorkerBackgroundFailure("run_processing", error);
          }
        }),
      )
      .catch(async (error) => {
        await this.reportWorkerBackgroundFailure("run_processing", error);
      })
      .finally(() => {
        this.workerActive = false;
      });
    trackBackgroundTask(backgroundTasks, bootTask);
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
      pruneCheckpoints?: (input: { keepPerRun: number; diskBudgetBytes: number }) => Promise<{
        prunedOrphans: number;
        prunedAged: number;
        finalBytes: number;
        diskBudgetBytes: number;
      }>;
    };
    const pruneSummary = (await durableRunsRepo.pruneCheckpoints?.(pruneConfig)) ?? {
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

  private async reportWorkerBackgroundFailure(
    stage: "boot_recovery" | "run_processing",
    error: unknown,
  ): Promise<void> {
    const message = redactRawRemoteApprovalBearerText(error instanceof Error ? error.message : String(error));
    const publishFailure = async () => {
      await this.publishRealtimeSafely(
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
      await publishFailure();
      return;
    }
    await publishFailure();
  }

  async stopWorker(): Promise<void> {
    this.workerStopped = true;
    this.workerRequested = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    const leaseRevocations: Promise<void>[] = [];
    for (const [runId, activeExecution] of this.activeRunAbortControllers) {
      leaseRevocations.push(this.revokeActiveExecutionLease(runId, activeExecution.leaseOwnerId));
      activeExecution.controller.abort(
        new DurableWorkerInterruptionError(
          "worker_stopped",
          `Durable worker ${this.workerId} stopped while ${runId} was running.`,
        ),
      );
    }
    await Promise.all(leaseRevocations);
    this.activeRunAbortControllers.clear();
  }

  /** Stop future claims without interrupting the currently admitted execution. */
  stopAdmission(): void {
    this.workerStopped = true;
    this.workerRequested = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
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
      .then(() => this.runWithSharedHostWorkerAdmission(() => this.runWorkerProcessingLoop()))
      .catch(async (error) => {
        await this.reportWorkerBackgroundFailure("run_processing", error);
      })
      .finally(() => {
        this.workerActive = false;
      });
    trackBackgroundTask(backgroundTasks, task);
  }

  private async runWithSharedHostWorkerAdmission(work: () => Promise<void>): Promise<void> {
    const admission = this.deps?.sharedHostLifecycle?.tryReserve(
      "worker",
      `durable-worker:${this.workerId}:${randomUUID()}`,
    );
    if (admission && !admission.admitted) return;
    const reservation = admission?.admitted ? admission.reservation : undefined;
    const stopOnForceDrain = () => void this.stopWorker();
    reservation?.signal.addEventListener("abort", stopOnForceDrain, { once: true });
    try {
      await work();
    } finally {
      reservation?.signal.removeEventListener("abort", stopOnForceDrain);
      reservation?.release();
    }
  }

  private async runWorkerProcessingLoop(): Promise<void> {
    do {
      this.workerRequested = false;
      if (!(await this.ctx.isFeatureEnabled("autonomyV1Disabled"))) {
        await this.resumeRunsWaitingForAutonomyKillSwitch();
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
  async updateRunState(input: {
    runId: string;
    status?: DurableRunRecord["status"];
    metadata?: Record<string, unknown>;
    lastError?: string;
    clearLastError?: boolean;
    finishedAt?: string;
    clearFinishedAt?: boolean;
    clearLease?: boolean;
    expectedLeaseOwnerId?: string;
  }): Promise<DurableRunRecord> {
    assertNoRawRemoteApprovalBearer(input);
    if (
      input.metadata &&
      ("linkedFinalizationPending" in input.metadata ||
        AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY in input.metadata ||
        GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY in input.metadata)
    ) {
      throw new Error("durable recovery metadata is reserved for internal state transitions");
    }
    const update = async (current: DurableRunRecord) =>
      await this.ctx.storage.durableRuns.updateRun({
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
    if (!input.expectedLeaseOwnerId) {
      return await update(await this.ctx.storage.durableRuns.getRun(input.runId));
    }
    let next!: DurableRunRecord;
    await this.ctx.storage.runImmediateTransaction(async () => {
      const current = await this.lockFreshLeaseOwnerForTransition(input.runId, input.expectedLeaseOwnerId!);
      if (!current) {
        throw new DurableWorkerInterruptionError(
          "lease_lost",
          `Durable run ${input.runId} lease ownership moved before its workflow state could commit.`,
        );
      }
      next = await update(current);
    });
    return next;
  }

  async reconcileAutonomousChatPostCommit(runId: string): Promise<boolean> {
    if (!this.deps?.onAutonomousChatPostCommit) {
      return false;
    }
    try {
      let observed = await this.ctx.storage.durableRuns.getRun(runId);
      const linkedPending = readLinkedFinalizationPending(observed);
      if (linkedPending) {
        await this.finalizePendingLinkedState(observed);
        observed = await this.ctx.storage.durableRuns.getRun(runId);
        if (readLinkedFinalizationPending(observed)) {
          return false;
        }
      }
      const observedPending = readAutonomousChatPostCommitPendingMarker(observed);
      if (!observedPending) {
        if (AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY in (observed.metadata ?? {})) {
          throw new Error(`Autonomous Chat post-commit ${runId} has an invalid pending marker.`);
        }
        await this.closeTerminalChatTurnAdmissionIfReady(observed);
        return true;
      }
      await this.verifyAutonomousChatTerminalAuthority(observed, observedPending);
      const claim = await this.claimAutonomousChatPostCommit(observed);
      if (!claim) {
        return false;
      }
      await this.verifyAutonomousChatTerminalAuthority(claim.run, claim.pending);
      let resolution: Record<string, unknown> | void;
      const canonicalAutonomousAdmission = isAutonomousAdmittedV2ChatRun(claim.run);
      const authoritySupersededBeforeSideEffect =
        canonicalAutonomousAdmission &&
        (await this.settleCanonicalAutonomousChatWriteAuthority(claim.run)) === "authority_superseded";
      if (!authoritySupersededBeforeSideEffect) {
        const postCommitAbort = new AbortController();
        const claimHeartbeat = setInterval(
          async () => {
            try {
              if (!(await this.renewAutonomousChatPostCommitClaim(claim.run.runId, claim.pending))) {
                postCommitAbort.abort(
                  new DurableWorkerInterruptionError(
                    "lease_lost",
                    `Autonomous Chat post-commit ${claim.run.runId} lost claim ownership.`,
                  ),
                );
              }
            } catch (error) {
              await this.reportDurableRunRecoveryFailure(claim.run.runId, error);
              postCommitAbort.abort(error);
            }
          },
          Math.floor(AUTONOMOUS_CHAT_POST_COMMIT_CLAIM_TTL_MS / 3),
        );
        claimHeartbeat.unref?.();
        const postCommitTimeout = setTimeout(() => {
          postCommitAbort.abort(
            new DurableWorkflowTimeoutError(claim.run.runId, AUTONOMOUS_CHAT_POST_COMMIT_TIMEOUT_MS),
          );
        }, AUTONOMOUS_CHAT_POST_COMMIT_TIMEOUT_MS);
        postCommitTimeout.unref?.();
        let rejectOnAbort: (() => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
          rejectOnAbort = () => {
            const reason = postCommitAbort.signal.reason;
            reject(reason instanceof Error ? reason : new Error(String(reason ?? "autonomous post-commit aborted")));
          };
          postCommitAbort.signal.addEventListener("abort", rejectOnAbort, { once: true });
        });
        try {
          resolution = await Promise.race([
            this.deps.onAutonomousChatPostCommit(claim.run, {
              claimId: claim.pending.claimId!,
              signal: postCommitAbort.signal,
            }),
            aborted,
          ]);
        } finally {
          clearInterval(claimHeartbeat);
          clearTimeout(postCommitTimeout);
          if (rejectOnAbort) {
            postCommitAbort.signal.removeEventListener("abort", rejectOnAbort);
          }
        }
        if (postCommitAbort.signal.aborted) {
          return false;
        }
      }
      let clearedClaim = false;
      const cleared = await this.retryDurableRunUpdate(runId, async (current) => {
        const currentPending = readAutonomousChatPostCommitPendingMarker(current);
        if (
          current.status !== "completed" ||
          !currentPending ||
          !sameAutonomousChatPostCommitGeneration(claim.pending, currentPending) ||
          currentPending.claimId !== claim.pending.claimId
        ) {
          return current;
        }
        await this.verifyAutonomousChatTerminalAuthority(current, currentPending);
        const authoritySuperseded =
          authoritySupersededBeforeSideEffect ||
          (canonicalAutonomousAdmission &&
            (await this.settleCanonicalAutonomousChatWriteAuthority(current)) === "authority_superseded");
        const metadata = { ...(current.metadata ?? {}) };
        delete metadata[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY];
        const generalPending = readGeneralChatPostCommitPendingMarker(current);
        const generalSettlementGeneration =
          metadata.generalChatPostCommit &&
          typeof metadata.generalChatPostCommit === "object" &&
          !Array.isArray(metadata.generalChatPostCommit) &&
          typeof (metadata.generalChatPostCommit as Record<string, unknown>).generationId === "string"
            ? ((metadata.generalChatPostCommit as Record<string, unknown>).generationId as string)
            : undefined;
        const generationId =
          currentPending.generationId ??
          generalPending?.generationId ??
          generalSettlementGeneration ??
          `legacy:${hashChatTurnRuntimeAuthorityValue([current.runId, currentPending.requestedAt]).slice(0, 32)}`;
        if (
          currentPending.generationId &&
          generalPending?.generationId &&
          currentPending.generationId !== generalPending.generationId
        ) {
          throw new Error(`Autonomous Chat post-commit ${runId} generation conflicts with general settlement.`);
        }
        const resolutionRecord = authoritySuperseded ? {} : (resolution ?? {});
        const autonomousSettlement = {
          delivery: authoritySuperseded
            ? { status: "skipped", reason: "authority_superseded" }
            : (resolutionRecord.delivery ?? { status: "skipped", reason: "delivery_not_reported" }),
          heartbeatCleanup: authoritySuperseded
            ? { status: "not_required" }
            : (resolutionRecord.heartbeatCleanup ?? { status: "not_required" }),
          generationId,
          requestedAt: currentPending.requestedAt,
          completedAt: new Date().toISOString(),
        };
        readExactAutonomousChatPostCommitSettlement(autonomousSettlement);
        metadata.autonomousChatPostCommit = autonomousSettlement;
        const updated = await this.ctx.storage.durableRuns.updateRun({
          runId: current.runId,
          status: current.status,
          metadata,
          updatedAt: new Date().toISOString(),
          expectedVersion: current.version,
        });
        clearedClaim = true;
        return updated;
      });
      if (clearedClaim && !hasAutonomousChatPostCommitPending(cleared)) {
        if (!hasGeneralChatPostCommitPending(cleared)) {
          await this.closeTerminalChatTurnAdmissionIfReady(cleared);
        }
      }
      return clearedClaim && !hasAutonomousChatPostCommitPending(cleared);
    } catch (error) {
      await this.reportDurableRunRecoveryFailure(runId, error);
      return false;
    }
  }

  private async verifyAutonomousChatTerminalAuthority(
    run: DurableRunRecord,
    pending: AutonomousChatPostCommitPendingMarker,
  ): Promise<void> {
    const payload = run.payload as { version?: unknown; turnId?: unknown } | undefined;
    if (run.workflowKey !== "chat.turn.execute" || payload?.version !== "chat.turn.execute.v2") {
      if (run.metadata?.[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY] !== undefined) {
        throw new Error(`Autonomous Chat post-commit ${run.runId} carries unauthorized runtime authority.`);
      }
      return;
    }
    await this.requireExactParentTurnAdmission(run, { requireActive: false });
    if (run.metadata?.autonomousAdmission === undefined) {
      throw new Error(`Autonomous Chat post-commit ${run.runId} has no autonomous admission seal.`);
    }
    await this.verifyCanonicalAutonomousChatAdmission(run);
    const authority = readChatTurnRuntimeAuthoritySeal(run.metadata[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]);
    if (
      !authority ||
      authority.material.transitionKind !== "terminal" ||
      authority.material.durableStatus !== "completed" ||
      (authority.material.traceStatus !== "completed" && authority.material.traceStatus !== "partial") ||
      authority.material.runId !== run.runId ||
      authority.material.turnId !== payload.turnId ||
      !pending.generationId ||
      pending.generationId !== authority.material.postCommitGenerationId ||
      pending.requestedAt !== authority.material.transitionAt
    ) {
      throw new Error(`Autonomous Chat post-commit ${run.runId} has no exact terminal runtime authority.`);
    }
    assertDurableRetryPolicyMatchesRun(run.metadata.retryPolicy, run.maxAttempts, DURABLE_RETRY_POLICY_DEFAULT);
    const checkpoint = await this.ctx.storage.durableRuns.getLatestCheckpointByKind(run.runId, "run_completed");
    if (!checkpoint) {
      throw new Error(`Autonomous Chat post-commit ${run.runId} has no authority-anchored terminal checkpoint.`);
    }
    verifyCheckpointAnchoredChatTurnRuntimeAuthority(run.metadata, checkpoint.state);
    const generalPending = readGeneralChatPostCommitPendingMarker(run);
    if (
      !generalPending ||
      generalPending.generationId !== authority.material.postCommitGenerationId ||
      generalPending.traceStatus !== authority.material.traceStatus ||
      generalPending.requestedAt !== authority.material.transitionAt ||
      canonicalJsonString(generalPending.postCommitEligibility) !==
        canonicalJsonString(authority.material.postCommitEligibility)
    ) {
      throw new Error(`Autonomous Chat post-commit ${run.runId} has no matching general generation.`);
    }
    if (await this.verifyCompletedSystemHeartbeatOutputBinding(run, authority, checkpoint)) return;
    const terminalOutput = authority.material.terminalOutput;
    if (
      !terminalOutput ||
      typeof run.metadata.outputText !== "string" ||
      typeof run.metadata.outputSummary !== "string" ||
      run.metadata.outputMessageId !== undefined ||
      run.metadata.outputTraceStatus !== undefined ||
      run.metadata.finalOutput !== run.metadata.outputText ||
      run.metadata.finalSummary !== run.metadata.outputSummary ||
      hashChatTurnRuntimeAuthorityValue(run.metadata.outputText) !== terminalOutput.outputTextSha256 ||
      hashChatTurnRuntimeAuthorityValue(run.metadata.outputSummary) !== terminalOutput.outputSummarySha256 ||
      checkpoint.state.assistantMessageId !== terminalOutput.assistantMessageId ||
      checkpoint.state.outputText !== run.metadata.outputText ||
      checkpoint.state.outputSummary !== run.metadata.outputSummary
    ) {
      throw new Error(`Autonomous Chat post-commit ${run.runId} terminal output drifted from its authority.`);
    }
  }

  private async readCheckpointAnchoredChatTurnRuntimeAuthority(
    run: DurableRunRecord,
  ): Promise<ChatTurnRuntimeAuthoritySealV1 | undefined> {
    const payload = run.payload as { version?: unknown; turnId?: unknown } | undefined;
    const authorityValue = run.metadata?.[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY];
    const admittedV2Chat = run.workflowKey === "chat.turn.execute" && payload?.version === "chat.turn.execute.v2";
    if (authorityValue === undefined) {
      if (admittedV2Chat && run.metadata?.autonomousAdmission !== undefined) {
        throw new Error(`Autonomous Chat run ${run.runId} has no checkpoint-anchored runtime authority.`);
      }
      return undefined;
    }
    if (!admittedV2Chat) {
      throw new Error(`Durable run ${run.runId} carries runtime authority without an admitted v2 Chat turn.`);
    }
    await this.requireExactParentTurnAdmission(run, { requireActive: false });
    if (run.metadata?.autonomousAdmission !== undefined) await this.verifyCanonicalAutonomousChatAdmission(run);
    if (
      !(run.status === "waiting" || run.status === "completed" || run.status === "failed" || run.status === "cancelled")
    ) {
      throw new Error(
        `Durable Chat run ${run.runId} has runtime authority for an unrepresentable status ${run.status}.`,
      );
    }
    const authority = readChatTurnRuntimeAuthoritySeal(authorityValue);
    if (
      !authority ||
      authority.material.runId !== run.runId ||
      authority.material.turnId !== payload.turnId ||
      authority.material.durableStatus !== run.status
    ) {
      throw new Error(`Durable Chat run ${run.runId} runtime authority does not match its current state.`);
    }
    const checkpointKind =
      run.status === "waiting"
        ? "run_waiting"
        : run.status === "completed"
          ? "run_completed"
          : run.status === "failed"
            ? "run_failed"
            : "run_cancelled";
    const checkpoint = await this.ctx.storage.durableRuns.getLatestCheckpointByKind(run.runId, checkpointKind);
    if (!checkpoint) {
      throw new Error(`Durable Chat run ${run.runId} has no checkpoint for its runtime authority.`);
    }
    verifyCheckpointAnchoredChatTurnRuntimeAuthority(run.metadata, checkpoint.state);
    assertDurableRetryPolicyMatchesRun(run.metadata?.retryPolicy, run.maxAttempts, DURABLE_RETRY_POLICY_DEFAULT);
    if (authority.material.durableStatus !== "completed") {
      this.assertNoCanonicalChatTerminalOutput(run, checkpoint.state);
    }
    return authority;
  }

  private assertNoCanonicalChatTerminalOutput(run: DurableRunRecord, checkpointState?: Record<string, unknown>): void {
    const metadata = run.metadata ?? {};
    if (
      CHAT_TERMINAL_OUTPUT_METADATA_KEYS.some((key) => metadata[key] !== undefined) ||
      (checkpointState && CHAT_TERMINAL_OUTPUT_CHECKPOINT_KEYS.some((key) => checkpointState[key] !== undefined))
    ) {
      throw new Error(`Durable Chat run ${run.runId} carries stale output evidence for a no-output transition.`);
    }
  }

  private async verifyGeneralChatPostCommitRuntimeAuthority(
    run: DurableRunRecord,
    marker: GeneralChatPostCommitPendingMarker,
  ): Promise<ChatTurnRuntimeAuthoritySealV1> {
    const payload = run.payload as { version?: unknown } | undefined;
    if (run.workflowKey !== "chat.turn.execute" || payload?.version !== "chat.turn.execute.v2") {
      throw new Error(
        `Durable Chat post-commit ${run.runId} has no exact admitted v2 authority and is quarantined from reconciliation.`,
      );
    }
    const authority = await this.readCheckpointAnchoredChatTurnRuntimeAuthority(run);
    if (!authority) {
      throw new Error(`Durable Chat post-commit ${run.runId} has no checkpoint-anchored runtime authority.`);
    }
    if (
      marker.generationId !== authority.material.postCommitGenerationId ||
      marker.traceStatus !== authority.material.traceStatus ||
      marker.requestedAt !== authority.material.transitionAt ||
      canonicalJsonString(marker.postCommitEligibility) !==
        canonicalJsonString(authority.material.postCommitEligibility)
    ) {
      throw new Error(`Durable Chat post-commit ${run.runId} drifted from its checkpoint-anchored runtime authority.`);
    }
    return authority;
  }

  private arePriorChatTurnFinalizersSettled(
    run: DurableRunRecord,
    authority: ChatTurnRuntimeAuthoritySealV1 | undefined,
  ): boolean {
    if (!authority) return true;
    if (authority.material.requiredFinalizers.includes("linked")) {
      const linkedAuthority = authority.material.linkedFinalization;
      if (!linkedAuthority) {
        throw new Error(`Durable linked finalization ${run.runId} has incomplete runtime authority.`);
      }
      const pending = readLinkedFinalizationPending(run);
      if (pending) {
        if (run.metadata?.linkedFinalization !== undefined) {
          throw new Error(`Durable linked finalization ${run.runId} has both pending and settled evidence.`);
        }
        if (
          pending.finalizationId !== linkedAuthority.finalizationId ||
          pending.requestedAt !== linkedAuthority.requestedAt ||
          hashChatTurnRuntimeAuthorityValue(pending.reason) !== linkedAuthority.reasonSha256
        ) {
          throw new Error(`Durable linked finalization ${run.runId} drifted from its runtime authority.`);
        }
        return false;
      }
      if (run.metadata?.linkedFinalizationPending !== undefined) {
        throw new Error(`Durable linked finalization ${run.runId} has an invalid pending marker.`);
      }
      const settlement = readExactLinkedFinalizationSettlement(run.metadata?.linkedFinalization);
      if (
        !settlement ||
        settlement.finalizationId !== linkedAuthority.finalizationId ||
        settlement.requestedAt !== linkedAuthority.requestedAt ||
        settlement.reasonSha256 !== linkedAuthority.reasonSha256
      ) {
        throw new Error(`Durable linked finalization ${run.runId} has no exact settlement receipt.`);
      }
    } else if (
      run.metadata?.linkedFinalizationPending !== undefined ||
      run.metadata?.linkedFinalization !== undefined
    ) {
      throw new Error(`Durable Chat run ${run.runId} carries stray linked-finalization evidence.`);
    }
    if (authority.material.requiredFinalizers.includes("autonomous")) {
      const pending = readAutonomousChatPostCommitPendingMarker(run);
      if (pending) {
        if (run.metadata?.autonomousChatPostCommit !== undefined) {
          throw new Error(`Autonomous Chat post-commit ${run.runId} has both pending and settled evidence.`);
        }
        if (
          pending.generationId !== authority.material.postCommitGenerationId ||
          pending.requestedAt !== authority.material.transitionAt
        ) {
          throw new Error(`Autonomous Chat post-commit ${run.runId} drifted from its runtime authority.`);
        }
        return false;
      }
      if (run.metadata?.[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined) {
        throw new Error(`Autonomous Chat post-commit ${run.runId} has an invalid pending marker.`);
      }
      const settlement = readExactAutonomousChatPostCommitSettlement(run.metadata?.autonomousChatPostCommit);
      if (
        !settlement ||
        settlement.generationId !== authority.material.postCommitGenerationId ||
        settlement.requestedAt !== authority.material.transitionAt
      ) {
        throw new Error(`Autonomous Chat post-commit ${run.runId} has no exact settlement receipt.`);
      }
    } else if (
      run.metadata?.[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined ||
      run.metadata?.autonomousChatPostCommit !== undefined
    ) {
      throw new Error(`Durable Chat run ${run.runId} carries stray autonomous finalizer evidence.`);
    }
    return true;
  }

  private async verifyCanonicalTerminalOutputAgainstAuthority(
    run: DurableRunRecord,
    authority: ChatTurnRuntimeAuthoritySealV1,
  ): Promise<void> {
    if (authority.material.durableStatus !== "completed") return;
    const terminalOutput = authority.material.terminalOutput;
    const payload = run.payload as { sessionId?: unknown } | undefined;
    const checkpoint = await this.ctx.storage.durableRuns.getLatestCheckpointByKind(run.runId, "run_completed");
    if (checkpoint && (await this.verifyCompletedSystemHeartbeatOutputBinding(run, authority, checkpoint))) return;
    if (
      !terminalOutput ||
      !checkpoint ||
      typeof payload?.sessionId !== "string" ||
      typeof run.metadata?.outputText !== "string" ||
      typeof run.metadata.outputSummary !== "string" ||
      run.metadata.outputMessageId !== undefined ||
      run.metadata.outputTraceStatus !== undefined ||
      run.metadata.finalOutput !== run.metadata.outputText ||
      run.metadata.finalSummary !== run.metadata.outputSummary ||
      hashChatTurnRuntimeAuthorityValue(run.metadata.outputText) !== terminalOutput.outputTextSha256 ||
      hashChatTurnRuntimeAuthorityValue(run.metadata.outputSummary) !== terminalOutput.outputSummarySha256 ||
      checkpoint.state.assistantMessageId !== terminalOutput.assistantMessageId ||
      checkpoint.state.outputText !== run.metadata.outputText ||
      checkpoint.state.outputSummary !== run.metadata.outputSummary
    ) {
      throw new Error(`Durable Chat run ${run.runId} terminal output drifted from its runtime authority.`);
    }
    const message = await this.ctx.storage.chatMessages.get(terminalOutput.assistantMessageId);
    if (
      !message ||
      message.messageId !== terminalOutput.assistantMessageId ||
      message.sessionId !== payload.sessionId ||
      message.role !== "assistant" ||
      message.actorType !== "agent" ||
      message.content !== run.metadata.outputText
    ) {
      throw new Error(`Durable Chat run ${run.runId} canonical assistant output no longer matches its authority.`);
    }
  }

  private async verifyCompletedSystemHeartbeatOutputBinding(
    run: DurableRunRecord,
    authority: ChatTurnRuntimeAuthoritySealV1,
    checkpoint: DurableCheckpointRecord,
  ): Promise<boolean> {
    const payload = run.payload as
      | {
          sessionId?: unknown;
          assistantMessageId?: unknown;
          heartbeatOccurrenceId?: unknown;
          heartbeatClaimSha256?: unknown;
          heartbeatEvaluatedPolicySha256?: unknown;
          heartbeatFrozenObjectiveSha256?: unknown;
          requestActor?: unknown;
        }
      | undefined;
    const heartbeatFields = [
      payload?.heartbeatOccurrenceId,
      payload?.heartbeatClaimSha256,
      payload?.heartbeatEvaluatedPolicySha256,
      payload?.heartbeatFrozenObjectiveSha256,
    ];
    if (heartbeatFields.every((value) => value === undefined)) {
      if (
        run.metadata?.[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY] !== undefined ||
        run.metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY] !== undefined ||
        authority.material.heartbeatDecisionReceipt !== undefined ||
        checkpoint.state[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY] !== undefined ||
        checkpoint.state[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY] !== undefined
      ) {
        throw new Error(`Non-heartbeat Chat run ${run.runId} contains heartbeat decision evidence.`);
      }
      return false;
    }

    const requestActor =
      payload?.requestActor && typeof payload.requestActor === "object" && !Array.isArray(payload.requestActor)
        ? (payload.requestActor as Record<string, unknown>)
        : undefined;
    const autonomous =
      run.metadata?.autonomous && typeof run.metadata.autonomous === "object" && !Array.isArray(run.metadata.autonomous)
        ? (run.metadata.autonomous as Record<string, unknown>)
        : undefined;
    if (
      typeof payload?.sessionId !== "string" ||
      !payload.sessionId.trim() ||
      typeof payload.assistantMessageId !== "string" ||
      !payload.assistantMessageId.trim() ||
      typeof payload.heartbeatOccurrenceId !== "string" ||
      !payload.heartbeatOccurrenceId.trim() ||
      typeof payload.heartbeatClaimSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(payload.heartbeatClaimSha256) ||
      typeof payload.heartbeatEvaluatedPolicySha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(payload.heartbeatEvaluatedPolicySha256) ||
      typeof payload.heartbeatFrozenObjectiveSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(payload.heartbeatFrozenObjectiveSha256) ||
      requestActor?.actorKind !== "system" ||
      requestActor.actorId !== "system-heartbeat" ||
      autonomous?.kind !== "heartbeat" ||
      autonomous.systemActorId !== "system-heartbeat"
    ) {
      throw new Error(`Durable Chat run ${run.runId} has malformed system-heartbeat identity evidence.`);
    }

    const rawOutput = run.metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY];
    const observedReceipt = run.metadata?.[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY];
    if (typeof rawOutput !== "string" || observedReceipt === undefined) {
      throw new Error(`Completed system heartbeat ${run.runId} has no exact decision evidence.`);
    }
    const decision = buildHeartbeatDecisionReceipt({
      occurrenceId: payload.heartbeatOccurrenceId,
      claimSha256: payload.heartbeatClaimSha256,
      rawOutput,
    });
    const systemHeartbeatPostCommitEligibility: PostCommitEligibility = {
      version: 1,
      autonomyEnabledAtParentSettlement: false,
      evalIntegrityTurn: false,
      humanSession: false,
    };
    if (
      authority.material.durableStatus !== "completed" ||
      authority.material.traceStatus !== "completed" ||
      canonicalJsonString(observedReceipt) !== canonicalJsonString(decision.receipt) ||
      canonicalJsonString(authority.material.heartbeatDecisionReceipt) !== canonicalJsonString(decision.receipt) ||
      canonicalJsonString(checkpoint.state[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]) !==
        canonicalJsonString(decision.receipt) ||
      checkpoint.state[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY] !== rawOutput ||
      canonicalJsonString(authority.material.postCommitEligibility) !==
        canonicalJsonString(systemHeartbeatPostCommitEligibility)
    ) {
      throw new Error(`System heartbeat ${run.runId} decision evidence drifted from its runtime authority.`);
    }

    const metadata = run.metadata ?? {};
    const terminalOutput = authority.material.terminalOutput;
    const message = await this.ctx.storage.chatMessages.get(payload.assistantMessageId);
    if (!decision.decision.notify) {
      if (
        terminalOutput ||
        message ||
        CHAT_TERMINAL_OUTPUT_METADATA_KEYS.some((key) => metadata[key] !== undefined) ||
        ["assistantMessageId", ...CHAT_TERMINAL_OUTPUT_METADATA_KEYS].some((key) => checkpoint.state[key] !== undefined)
      ) {
        throw new Error(`Silent system heartbeat ${run.runId} contains visible output.`);
      }
      return true;
    }

    const normalizedMessage = decision.decision.normalizedMessage;
    if (
      !terminalOutput ||
      terminalOutput.assistantMessageId !== payload.assistantMessageId ||
      metadata.outputText !== normalizedMessage ||
      metadata.outputSummary !== normalizedMessage ||
      metadata.finalOutput !== normalizedMessage ||
      metadata.finalSummary !== normalizedMessage ||
      metadata.outputMessageId !== undefined ||
      metadata.outputTraceStatus !== undefined ||
      hashChatTurnRuntimeAuthorityValue(normalizedMessage) !== terminalOutput.outputTextSha256 ||
      hashChatTurnRuntimeAuthorityValue(normalizedMessage) !== terminalOutput.outputSummarySha256 ||
      checkpoint.state.assistantMessageId !== terminalOutput.assistantMessageId ||
      checkpoint.state.outputText !== normalizedMessage ||
      checkpoint.state.outputSummary !== normalizedMessage ||
      checkpoint.state.finalOutput !== undefined ||
      checkpoint.state.finalSummary !== undefined ||
      checkpoint.state.outputMessageId !== undefined ||
      checkpoint.state.outputTraceStatus !== undefined ||
      !message ||
      message.messageId !== terminalOutput.assistantMessageId ||
      message.sessionId !== payload.sessionId ||
      message.role !== "assistant" ||
      message.actorType !== "system" ||
      message.actorId !== "system-heartbeat" ||
      message.content !== normalizedMessage
    ) {
      throw new Error(`Notifying system heartbeat ${run.runId} output drifted from its runtime authority.`);
    }
    return true;
  }

  private async claimAutonomousChatPostCommit(
    observed: DurableRunRecord,
  ): Promise<{ run: DurableRunRecord; pending: AutonomousChatPostCommitPendingMarker } | undefined> {
    const observedPending = readAutonomousChatPostCommitPendingMarker(observed);
    if (!observedPending) {
      return undefined;
    }
    const claimId = randomUUID();
    let claim: { run: DurableRunRecord; pending: AutonomousChatPostCommitPendingMarker } | undefined;
    await this.retryDurableRunUpdate(observed.runId, async (current) => {
      claim = undefined;
      const pending = readAutonomousChatPostCommitPendingMarker(current);
      if (
        current.status !== "completed" ||
        !pending ||
        !sameAutonomousChatPostCommitGeneration(observedPending, pending)
      ) {
        return current;
      }
      const claimedAt = await this.readDurableDatabaseNow();
      const claimedAtMs = Date.parse(claimedAt);
      const activeClaimExpiresAt = pending.claimExpiresAt ? Date.parse(pending.claimExpiresAt) : Number.NaN;
      if (pending.claimId && Number.isFinite(activeClaimExpiresAt) && activeClaimExpiresAt > claimedAtMs) {
        return current;
      }
      const claimedPending: AutonomousChatPostCommitPendingMarker = {
        ...pending,
        claimId,
        claimExpiresAt: new Date(claimedAtMs + AUTONOMOUS_CHAT_POST_COMMIT_CLAIM_TTL_MS).toISOString(),
      };
      const claimedRun = await this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: current.status,
        metadata: {
          ...(current.metadata ?? {}),
          [AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY]: claimedPending,
        },
        updatedAt: claimedAt,
        expectedVersion: current.version,
      });
      claim = { run: claimedRun, pending: claimedPending };
      return claimedRun;
    });
    return claim;
  }

  private async renewAutonomousChatPostCommitClaim(
    runId: string,
    claimed: AutonomousChatPostCommitPendingMarker,
  ): Promise<boolean> {
    let renewed = false;
    await this.retryDurableRunUpdate(runId, async (current) => {
      const pending = readAutonomousChatPostCommitPendingMarker(current);
      if (
        current.status !== "completed" ||
        !pending ||
        !sameAutonomousChatPostCommitGeneration(claimed, pending) ||
        pending.claimId !== claimed.claimId
      ) {
        return current;
      }
      const now = await this.readDurableDatabaseNow();
      const nowMs = Date.parse(now);
      const next = await this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: current.status,
        metadata: {
          ...(current.metadata ?? {}),
          [AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY]: {
            ...pending,
            claimExpiresAt: new Date(nowMs + AUTONOMOUS_CHAT_POST_COMMIT_CLAIM_TTL_MS).toISOString(),
          },
        },
        updatedAt: now,
        expectedVersion: current.version,
      });
      renewed = true;
      return next;
    });
    return renewed;
  }

  async reconcileGeneralChatPostCommit(runId: string): Promise<boolean> {
    let observed: DurableRunRecord;
    try {
      observed = await this.ctx.storage.durableRuns.getRun(runId);
      const legacySettlement = await this.settleLegacyGeneralChatPostCommit(observed);
      if (legacySettlement?.retired) {
        return true;
      }
      // A concurrent owner may have retired or upgraded the marker after our
      // initial read. Continue from the canonical row returned by the bounded
      // update loop, never the stale v1 row or a redundant storage reread.
      if (legacySettlement) observed = legacySettlement.run;
      if (readLinkedFinalizationPending(observed)) {
        await this.finalizePendingLinkedState(observed);
        observed = await this.ctx.storage.durableRuns.getRun(runId);
        if (readLinkedFinalizationPending(observed)) {
          return false;
        }
      }
      if (hasAutonomousChatPostCommitPending(observed)) {
        await this.reconcileAutonomousChatPostCommit(runId);
        observed = await this.ctx.storage.durableRuns.getRun(runId);
        if (hasAutonomousChatPostCommitPending(observed)) {
          return false;
        }
      }
    } catch (error) {
      await this.reportDurableRunRecoveryFailure(runId, error);
      return false;
    }
    const nowMs = Date.now();
    const marker = readGeneralChatPostCommitPendingMarker(observed);
    const inFlight = this.generalChatPostCommitInFlight.get(runId);
    if (
      inFlight &&
      inFlight.expiresAtMs > nowMs &&
      ((inFlight.marker === undefined && marker === undefined) ||
        (inFlight.marker !== undefined &&
          marker !== undefined &&
          sameGeneralChatPostCommitGeneration(inFlight.marker, marker)))
    ) {
      return this.awaitGeneralChatPostCommitInFlight(runId, inFlight);
    }
    if (inFlight) {
      this.releaseGeneralChatPostCommitInFlight(runId, inFlight.ownershipGeneration);
    }
    const ownershipGeneration = randomUUID();
    // Schedule internal work for the next microtask so ownership is visible
    // before a synchronous progress callback can attempt its first effect.
    const work = Promise.resolve().then(() => this.reconcileGeneralChatPostCommitInternal(runId, ownershipGeneration));
    const inFlightEntry: GeneralChatPostCommitInFlight = {
      ownershipGeneration,
      marker,
      expiresAtMs: nowMs + GENERAL_CHAT_POST_COMMIT_IN_FLIGHT_TTL_MS,
      work,
    };
    this.generalChatPostCommitInFlight.set(runId, inFlightEntry);
    return this.awaitGeneralChatPostCommitInFlight(runId, inFlightEntry);
  }

  private async settleLegacyGeneralChatPostCommit(
    observed: DurableRunRecord,
  ): Promise<{ run: DurableRunRecord; retired: boolean } | undefined> {
    const legacyMarker = readExactLegacyGeneralChatPostCommitPendingMarker(
      observed.metadata?.[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY],
    );
    if (!legacyMarker) return undefined;
    const payloadVersion = (observed.payload as { version?: unknown } | undefined)?.version;
    if (
      observed.workflowKey !== "chat.turn.execute" ||
      payloadVersion !== "chat.turn.execute.v1" ||
      !isRepresentableTerminalChatRun(observed) ||
      observed.metadata?.[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY] !== undefined ||
      observed.metadata?.[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined ||
      observed.metadata?.linkedFinalizationPending !== undefined ||
      observed.metadata?.generalChatPostCommit !== undefined ||
      observed.metadata?.[LEGACY_GENERAL_CHAT_POST_COMMIT_SETTLEMENT_METADATA_KEY] !== undefined
    ) {
      throw new Error(
        `Legacy Durable Chat post-commit ${observed.runId} has conflicting authority or settlement evidence.`,
      );
    }

    const expectedMarkerSha256 = hashChatTurnRuntimeAuthorityValue(legacyMarker);
    let retired = false;
    const settled = await this.retryDurableRunUpdate(observed.runId, async (current) => {
      retired = false;
      const currentMarker = readExactLegacyGeneralChatPostCommitPendingMarker(
        current.metadata?.[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY],
      );
      if (!currentMarker) return current;
      if (
        current.workflowKey !== "chat.turn.execute" ||
        (current.payload as { version?: unknown } | undefined)?.version !== "chat.turn.execute.v1" ||
        !isRepresentableTerminalChatRun(current) ||
        current.metadata?.[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY] !== undefined ||
        current.metadata?.[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined ||
        current.metadata?.linkedFinalizationPending !== undefined ||
        current.metadata?.generalChatPostCommit !== undefined ||
        current.metadata?.[LEGACY_GENERAL_CHAT_POST_COMMIT_SETTLEMENT_METADATA_KEY] !== undefined ||
        hashChatTurnRuntimeAuthorityValue(currentMarker) !== expectedMarkerSha256
      ) {
        throw new Error(`Legacy Durable Chat post-commit ${current.runId} changed before safe retirement.`);
      }
      const retiredAt = new Date().toISOString();
      const metadata = { ...(current.metadata ?? {}) };
      delete metadata[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY];
      metadata[LEGACY_GENERAL_CHAT_POST_COMMIT_SETTLEMENT_METADATA_KEY] = {
        version: LEGACY_GENERAL_CHAT_POST_COMMIT_SETTLEMENT_VERSION,
        disposition: "terminal_v1_effects_not_replayed",
        generationId: currentMarker.generationId,
        traceStatus: currentMarker.traceStatus,
        requestedAt: currentMarker.requestedAt,
        completedEffects: [...currentMarker.completedEffects],
        durableEffectRunIds: { ...currentMarker.durableEffectRunIds },
        pendingMarkerSha256: expectedMarkerSha256,
        retiredAt,
      };
      retired = true;
      return this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: current.status,
        metadata,
        updatedAt: retiredAt,
        expectedVersion: current.version,
      });
    });
    if (!retired) return { run: settled, retired: false };
    this.resolveLogger().info(
      {
        runId: settled.runId,
        generationId: legacyMarker.generationId,
        completedEffectCount: legacyMarker.completedEffects.length,
        durableEffectCount: Object.keys(legacyMarker.durableEffectRunIds).length,
      },
      "retired terminal legacy Chat post-commit marker without replaying side effects",
    );
    return { run: settled, retired: true };
  }

  private awaitGeneralChatPostCommitInFlight(runId: string, inFlight: GeneralChatPostCommitInFlight): Promise<boolean> {
    const remainingMs = Math.max(0, inFlight.expiresAtMs - Date.now());
    if (remainingMs === 0) {
      this.releaseGeneralChatPostCommitInFlight(runId, inFlight.ownershipGeneration);
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(expiryTimer);
        this.releaseGeneralChatPostCommitInFlight(runId, inFlight.ownershipGeneration);
        resolve(result);
      };
      const expiryTimer = setTimeout(() => settle(false), remainingMs);
      expiryTimer.unref?.();
      void inFlight.work.then(
        (result) => settle(result),
        () => settle(false),
      );
    });
  }

  private releaseGeneralChatPostCommitInFlight(runId: string, ownershipGeneration: string): void {
    if (this.generalChatPostCommitInFlight.get(runId)?.ownershipGeneration === ownershipGeneration) {
      this.generalChatPostCommitInFlight.delete(runId);
    }
  }

  private ownsGeneralChatPostCommitInFlight(runId: string, ownershipGeneration: string): boolean {
    const current = this.generalChatPostCommitInFlight.get(runId);
    return Boolean(current && current.ownershipGeneration === ownershipGeneration && current.expiresAtMs > Date.now());
  }

  /**
   * Terminal stream delivery is not completion authority. Hold a durable `done`
   * projection until the exact bound run reaches a representable terminal state
   * and its canonical post-commit handoff closes the turn admission. The wait is
   * bounded so reconnect/live-tail subscribers cannot hang forever on a broken
   * finalizer.
   */
  async awaitTerminalChatAdmissionRelease(input: {
    runId: string;
    workspaceId?: string;
    sessionId: string;
    turnId: string;
    timeoutMs: number;
  }): Promise<TerminalChatAdmissionReleaseOutcome> {
    return this.reconcileExactTerminalChatAdmission({
      runId: input.runId,
      expectedWorkspaceId: input.workspaceId,
      expectedSessionId: input.sessionId,
      expectedTurnId: input.turnId,
      timeoutMs: input.timeoutMs,
    });
  }

  /**
   * Admission fallback for the narrow race where a canonical terminal durable
   * run still owns the session. Unlike stream delivery this never waits for, or
   * infers authority from, a persisted terminal event: the immutable binding and
   * durable terminal status must already exist before reconciliation is tried.
   */
  async reconcileTerminalChatAdmission(
    activeAdmission: SessionMutationAdmissionRecord,
  ): Promise<TerminalChatAdmissionReleaseOutcome> {
    const startedAt = Date.now();
    if (activeAdmission.admissionKind !== "turn_write" || !activeAdmission.turnId) {
      return terminalChatAdmissionOutcome("not_bound", startedAt, 0, {
        admissionId: activeAdmission.admissionId,
        admissionStatus: activeAdmission.status,
      });
    }
    try {
      const canonical = await this.ctx.storage.sessionMutationAdmissions.require(activeAdmission.admissionId);
      if (!sameTurnAdmissionIdentity(canonical, activeAdmission)) {
        return terminalChatAdmissionOutcome("lineage_mismatch", startedAt, 0, {
          admissionId: canonical.admissionId,
          admissionStatus: canonical.status,
        });
      }
      const binding = await this.ctx.storage.sessionMutationAdmissions.findDurableRunBinding({
        admissionId: canonical.admissionId,
        workspaceId: canonical.workspaceId,
        sessionId: canonical.sessionId,
        sessionIncarnationId: canonical.sessionIncarnationId,
        turnId: canonical.turnId!,
      });
      if (!binding) {
        return terminalChatAdmissionOutcome("not_bound", startedAt, 0, {
          admissionId: canonical.admissionId,
          admissionStatus: canonical.status,
        });
      }
      const run = await this.ctx.storage.durableRuns.getRun(binding.durableRunId);
      if (!isTerminalChatRunRecoveryCandidate(run)) {
        return terminalChatAdmissionOutcome("not_terminal", startedAt, 0, {
          durableRunId: run.runId,
          durableRunStatus: run.status,
          admissionId: canonical.admissionId,
          admissionStatus: canonical.status,
        });
      }
      return this.reconcileExactTerminalChatAdmission({
        runId: run.runId,
        expectedWorkspaceId: canonical.workspaceId,
        expectedSessionId: canonical.sessionId,
        expectedTurnId: canonical.turnId!,
        expectedAdmissionId: canonical.admissionId,
        timeoutMs: TERMINAL_CHAT_ADMISSION_RECOVERY_TIMEOUT_MS,
      });
    } catch (error) {
      return terminalChatAdmissionOutcome("recovery_failed", startedAt, 0, {
        admissionId: activeAdmission.admissionId,
        admissionStatus: activeAdmission.status,
        error: safeRecoveryError(error),
      });
    }
  }

  private async reconcileExactTerminalChatAdmission(input: {
    runId: string;
    expectedWorkspaceId?: string;
    expectedSessionId: string;
    expectedTurnId: string;
    expectedAdmissionId?: string;
    timeoutMs: number;
  }): Promise<TerminalChatAdmissionReleaseOutcome> {
    const startedAt = Date.now();
    const timeoutMs = Math.max(0, Math.min(input.timeoutMs, 30_000));
    const deadline = startedAt + timeoutMs;
    let observedActive = false;
    try {
      while (true) {
        const run = await this.ctx.storage.durableRuns.getRun(input.runId);
        if (!isExactChatRunProjection(run, input)) {
          return terminalChatAdmissionOutcome("lineage_mismatch", startedAt, deadline, {
            durableRunId: run.runId,
            durableRunStatus: run.status,
          });
        }
        if (!isTerminalChatRunRecoveryCandidate(run)) {
          if (Date.now() >= deadline) {
            return terminalChatAdmissionOutcome("not_terminal", startedAt, deadline, {
              durableRunId: run.runId,
              durableRunStatus: run.status,
            });
          }
          await waitForTerminalChatAdmissionPoll(deadline);
          continue;
        }

        const admission = await this.requireExactParentTurnAdmission(run, { requireActive: false });
        if (input.expectedAdmissionId !== undefined && admission.admissionId !== input.expectedAdmissionId) {
          return terminalChatAdmissionOutcome("lineage_mismatch", startedAt, deadline, {
            durableRunId: run.runId,
            durableRunStatus: run.status,
            admissionId: admission.admissionId,
            admissionStatus: admission.status,
          });
        }
        const binding = await this.ctx.storage.sessionMutationAdmissions.findDurableRunBinding({
          admissionId: admission.admissionId,
          workspaceId: admission.workspaceId,
          sessionId: admission.sessionId,
          sessionIncarnationId: admission.sessionIncarnationId,
          turnId: admission.turnId,
        });
        if (!binding) {
          return terminalChatAdmissionOutcome("not_bound", startedAt, deadline, {
            durableRunId: run.runId,
            durableRunStatus: run.status,
            admissionId: admission.admissionId,
            admissionStatus: admission.status,
          });
        }
        if (binding.durableRunId !== run.runId) {
          return terminalChatAdmissionOutcome("lineage_mismatch", startedAt, deadline, {
            durableRunId: run.runId,
            durableRunStatus: run.status,
            admissionId: admission.admissionId,
            admissionStatus: admission.status,
          });
        }
        if (admission.status !== "active") {
          const exactTerminalRelease = isExactDurableTerminalAdmissionRelease(admission, run);
          return terminalChatAdmissionOutcome(
            exactTerminalRelease ? (observedActive ? "released" : "already_released") : "lineage_mismatch",
            startedAt,
            deadline,
            {
              durableRunId: run.runId,
              durableRunStatus: run.status,
              admissionId: admission.admissionId,
              admissionStatus: admission.status,
            },
          );
        }
        observedActive = true;
        const reconciliationSettled = await settleTerminalChatReconciliationBeforeDeadline(
          this.reconcileGeneralChatPostCommit(run.runId),
          deadline,
        );
        if (!reconciliationSettled) {
          return terminalChatAdmissionOutcome("reconciliation_pending", startedAt, deadline, {
            durableRunId: run.runId,
            durableRunStatus: run.status,
            admissionId: admission.admissionId,
            admissionStatus: admission.status,
          });
        }
        const settledAdmission = await this.ctx.storage.sessionMutationAdmissions.require(admission.admissionId);
        if (settledAdmission.status !== "active") {
          const reconciledRun = await this.ctx.storage.durableRuns.getRun(run.runId);
          return terminalChatAdmissionOutcome(
            isExactDurableTerminalAdmissionRelease(settledAdmission, reconciledRun) ? "released" : "lineage_mismatch",
            startedAt,
            deadline,
            {
              durableRunId: reconciledRun.runId,
              durableRunStatus: reconciledRun.status,
              admissionId: settledAdmission.admissionId,
              admissionStatus: settledAdmission.status,
            },
          );
        }
        if (Date.now() >= deadline) {
          return terminalChatAdmissionOutcome("reconciliation_pending", startedAt, deadline, {
            durableRunId: run.runId,
            durableRunStatus: run.status,
            admissionId: settledAdmission.admissionId,
            admissionStatus: settledAdmission.status,
          });
        }
        await waitForTerminalChatAdmissionPoll(deadline);
      }
    } catch (error) {
      return terminalChatAdmissionOutcome("recovery_failed", startedAt, deadline, {
        durableRunId: input.runId,
        error: safeRecoveryError(error),
      });
    }
  }

  private async reconcileGeneralChatPostCommitInternal(runId: string, ownershipGeneration: string): Promise<boolean> {
    if (!this.deps?.onGeneralChatPostCommit) {
      return false;
    }
    try {
      for (let generationAttempt = 0; generationAttempt < 8; generationAttempt += 1) {
        if (!this.ownsGeneralChatPostCommitInFlight(runId, ownershipGeneration)) {
          return false;
        }
        const observed = await this.ctx.storage.durableRuns.getRun(runId);
        const marker = readGeneralChatPostCommitPendingMarker(observed);
        if (!marker) {
          if (GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY in (observed.metadata ?? {})) {
            throw new Error(`Durable Chat post-commit ${runId} has an invalid pending marker.`);
          }
          await this.closeTerminalChatTurnAdmissionIfReady(observed);
          return true;
        }
        const authority = await this.verifyGeneralChatPostCommitRuntimeAuthority(observed, marker);
        if (!this.arePriorChatTurnFinalizersSettled(observed, authority)) {
          return false;
        }
        if (this.hasSettledGeneralChatPostCommitParentEffects(observed, marker)) {
          const settlement = await this.settleGeneralChatPostCommitGeneration(runId, marker);
          if (settlement.generationChanged) {
            continue;
          }
          for (const childRunId of settlement.queuedChildRunIds) {
            this.requestRunProcessing(childRunId);
          }
          await this.closeTerminalChatTurnAdmissionIfReady(settlement.run);
          return settlement.complete;
        }
        const completedEffects = new Set(readGeneralChatPostCommitCompletedEffects(observed));
        const progress: GeneralChatPostCommitProgress = {
          generationId: marker.generationId,
          requestedAt: marker.requestedAt,
          targetTraceStatus: marker.traceStatus,
          completedEffects: [...completedEffects],
          runEffect: async (effect, callback) =>
            this.ownsGeneralChatPostCommitInFlight(runId, ownershipGeneration)
              ? this.runGeneralChatPostCommitEffect(runId, marker, effect, callback, completedEffects)
              : false,
          publishEffect: async (effect, callback) =>
            this.ownsGeneralChatPostCommitInFlight(runId, ownershipGeneration)
              ? this.publishGeneralChatPostCommitEffect(runId, marker, effect, callback, completedEffects)
              : false,
          enqueueDurableEffect: async (input) =>
            this.ownsGeneralChatPostCommitInFlight(runId, ownershipGeneration)
              ? this.enqueueGeneralChatPostCommitEffect(runId, marker, input, completedEffects)
              : undefined,
        };
        const resolution = await this.deps.onGeneralChatPostCommit(observed, progress);
        if (!this.ownsGeneralChatPostCommitInFlight(runId, ownershipGeneration)) {
          return false;
        }
        const reconciled = await this.ctx.storage.durableRuns.getRun(runId);
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
        const settlement = await this.settleGeneralChatPostCommitGeneration(runId, marker, resolution);
        if (settlement.generationChanged) {
          continue;
        }
        for (const childRunId of settlement.queuedChildRunIds) {
          this.requestRunProcessing(childRunId);
        }
        await this.closeTerminalChatTurnAdmissionIfReady(settlement.run);
        return settlement.complete;
      }
      throw new Error(`Durable Chat post-commit ${runId} changed generations too many times to reconcile safely.`);
    } catch (error) {
      if (!this.ownsGeneralChatPostCommitInFlight(runId, ownershipGeneration)) {
        return false;
      }
      if (error instanceof DurableChatParentAuthoritySupersededError) {
        await this.settleAuthoritySupersededGeneralChatPostCommit(runId);
        return true;
      }
      await this.reportDurableRunRecoveryFailure(runId, error);
      return false;
    }
  }

  private hasSettledGeneralChatPostCommitParentEffects(
    run: DurableRunRecord,
    marker: GeneralChatPostCommitPendingMarker,
  ): boolean {
    const settled = run.metadata?.generalChatPostCommit;
    if (!settled || typeof settled !== "object" || Array.isArray(settled)) return false;
    const value = settled as Record<string, unknown>;
    return value.generationId === marker.generationId && value.parentLocalEffectsStatus === "settled";
  }

  private async settleGeneralChatPostCommitGeneration(
    runId: string,
    expectedMarker: GeneralChatPostCommitPendingMarker,
    resolution?: Record<string, unknown> | void,
  ): Promise<{
    run: DurableRunRecord;
    generationChanged: boolean;
    complete: boolean;
    queuedChildRunIds: string[];
  }> {
    let generationChanged = false;
    const queuedChildRunIds: string[] = [];
    let settled = await this.ctx.storage.durableRuns.getRun(runId);
    await this.ctx.storage.runImmediateTransaction(async () => {
      const current = await this.ctx.storage.durableRuns.getRunForUpdate(runId);
      const currentMarker = readGeneralChatPostCommitPendingMarker(current);
      if (!currentMarker) {
        settled = current;
        return;
      }
      if (!sameGeneralChatPostCommitGeneration(expectedMarker, currentMarker)) {
        generationChanged = true;
        settled = current;
        return;
      }
      const runtimeAuthority = await this.verifyGeneralChatPostCommitRuntimeAuthority(current, currentMarker);
      if (!this.arePriorChatTurnFinalizersSettled(current, runtimeAuthority)) {
        throw new Error(`Durable Chat post-commit ${runId} cannot settle before its prior finalizers.`);
      }
      const currentEffects = new Set(readGeneralChatPostCommitCompletedEffects(current));
      const currentPayload = current.payload as {
        heartbeatOccurrenceId?: unknown;
        requestActor?: unknown;
      };
      const requestActor =
        currentPayload.requestActor &&
        typeof currentPayload.requestActor === "object" &&
        !Array.isArray(currentPayload.requestActor)
          ? (currentPayload.requestActor as Record<string, unknown>)
          : undefined;
      const autonomous =
        current.metadata?.autonomous &&
        typeof current.metadata.autonomous === "object" &&
        !Array.isArray(current.metadata.autonomous)
          ? (current.metadata.autonomous as Record<string, unknown>)
          : undefined;
      const systemHeartbeatTerminal =
        typeof currentPayload.heartbeatOccurrenceId === "string" &&
        Boolean(currentPayload.heartbeatOccurrenceId.trim()) &&
        requestActor?.actorKind === "system" &&
        requestActor.actorId === "system-heartbeat" &&
        autonomous?.kind === "heartbeat" &&
        autonomous.systemActorId === "system-heartbeat";
      if (systemHeartbeatTerminal) currentEffects.clear();
      const missingEffects = systemHeartbeatTerminal
        ? []
        : GENERAL_CHAT_POST_COMMIT_EFFECTS.filter(
            (effect) =>
              !currentEffects.has(effect) &&
              (!isGeneralChatPostCommitDurableEffect(effect) || !currentMarker.durableEffectRunIds[effect]),
          );
      if (missingEffects.length > 0) {
        throw new Error(
          `Durable Chat post-commit ${runId} returned before reconciling effects: ${missingEffects.join(", ")}.`,
        );
      }

      let childrenPending = false;
      let childFailure = false;
      const durableEffectOutcomes: Record<string, Record<string, unknown>> = {};
      for (const effect of GENERAL_CHAT_POST_COMMIT_DURABLE_EFFECTS) {
        const childRunId = currentMarker.durableEffectRunIds[effect];
        if (!childRunId) continue;
        const expectedChildRunId = buildGeneralChatPostCommitEffectRunId(runId, currentMarker.generationId, effect);
        if (childRunId !== expectedChildRunId) {
          throw new Error(`Durable Chat post-commit ${runId} has an invalid ${effect} child-run receipt.`);
        }
        const child = await this.ctx.storage.durableRuns.getRunForUpdate(childRunId);
        assertGeneralChatPostCommitEffectChildLink(child, runId, currentMarker.generationId, effect);
        if (!isDurableRunTerminal(child.status)) {
          childrenPending = true;
          durableEffectOutcomes[effect] = {
            runId: childRunId,
            status: child.status,
            observedAt: child.updatedAt,
          };
          if (child.status === "queued") queuedChildRunIds.push(childRunId);
          continue;
        }
        durableEffectOutcomes[effect] = {
          runId: childRunId,
          status: child.status,
          settledAt: child.finishedAt ?? child.updatedAt,
          ...(child.lastError ? { error: child.lastError } : {}),
        };
        if (child.status === "completed") {
          currentEffects.add(effect);
        } else {
          childFailure = true;
        }
      }

      const metadata = { ...(current.metadata ?? {}) };
      const existingSettlement =
        metadata.generalChatPostCommit &&
        typeof metadata.generalChatPostCommit === "object" &&
        !Array.isArray(metadata.generalChatPostCommit)
          ? (metadata.generalChatPostCommit as Record<string, unknown>)
          : {};
      const localSettledAt =
        typeof existingSettlement.parentLocalEffectsSettledAt === "string"
          ? existingSettlement.parentLocalEffectsSettledAt
          : new Date().toISOString();
      const terminalParent =
        current.status === "completed" || current.status === "failed" || current.status === "cancelled";
      const admittedV2Parent =
        current.workflowKey === "chat.turn.execute" &&
        (current.payload as { version?: unknown } | undefined)?.version === "chat.turn.execute.v2";
      if (isDurableRunTerminal(current.status) && !terminalParent && admittedV2Parent) {
        throw new Error(
          `Durable Chat parent ${runId} cannot hand off unrepresentable terminal status ${current.status}.`,
        );
      }
      const parentFinalizationBlocked = false;
      const committedAt = new Date().toISOString();
      const childRunIds = [...new Set(Object.values(currentMarker.durableEffectRunIds))]
        .filter((childRunId): childRunId is string => typeof childRunId === "string" && Boolean(childRunId))
        .sort((left, right) => left.localeCompare(right));

      if (terminalParent && admittedV2Parent && !parentFinalizationBlocked) {
        const admission = await this.requireExactParentTurnAdmission(current, { requireActive: false });
        const expectedHandoff = {
          version: 1 as const,
          admissionId: admission.admissionId,
          sessionIncarnationId: admission.sessionIncarnationId,
          turnId: admission.turnId,
          parentRunId: current.runId,
          postCommitGenerationId: currentMarker.generationId,
          parentLocalEffectsStatus: "settled" as const,
          childRunIds,
          childRunIdsSha256: createHash("sha256").update(canonicalJsonString(childRunIds)).digest("hex"),
          committedAt,
        };
        const existingHandoff = metadata.chatTurnAdmissionHandoff;
        if (existingHandoff === undefined) {
          metadata.chatTurnAdmissionHandoff = expectedHandoff;
        } else if (!this.isExactChatTurnAdmissionHandoff(existingHandoff, expectedHandoff)) {
          throw new Error(`Durable Chat parent ${runId} has a conflicting terminal handoff marker.`);
        }
      }

      const shouldRetainPending = terminalParent && (childrenPending || parentFinalizationBlocked);
      if (!shouldRetainPending) {
        delete metadata[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY];
      }
      const completedAt = new Date().toISOString();
      metadata.generalChatPostCommit = {
        ...existingSettlement,
        ...selectCanonicalGeneralChatPostCommitResolution(resolution),
        generationId: currentMarker.generationId,
        traceStatus: currentMarker.traceStatus,
        requestedAt: currentMarker.requestedAt,
        postCommitEligibility: currentMarker.postCommitEligibility,
        parentLocalEffectsStatus: "settled",
        parentLocalEffectsSettledAt: localSettledAt,
        completedEffects: [...currentEffects],
        durableEffectRunIds: { ...currentMarker.durableEffectRunIds },
        durableEffectOutcomes,
        childOutcomeAuthority: "child_durable_runs",
        settlementStatus: parentFinalizationBlocked
          ? "waiting_for_parent_finalization"
          : childrenPending
            ? "children_pending"
            : childFailure
              ? "settled_with_failures"
              : "completed",
        ...(shouldRetainPending ? {} : { completedAt }),
      };
      readExactGeneralChatPostCommitSettlement(metadata.generalChatPostCommit);
      settled = await this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: current.status,
        metadata,
        updatedAt: completedAt,
        expectedVersion: current.version,
      });
      if (!hasGeneralChatPostCommitPending(settled) && terminalParent) {
        await this.closeTerminalChatTurnAdmissionIfReady(settled);
      }
    });
    return {
      run: settled,
      generationChanged,
      complete: !hasGeneralChatPostCommitPending(settled),
      queuedChildRunIds: [...new Set(queuedChildRunIds)],
    };
  }

  private isExactChatTurnAdmissionHandoff(
    value: unknown,
    expected: {
      version: 1;
      admissionId: string;
      sessionIncarnationId: string;
      turnId: string;
      parentRunId: string;
      postCommitGenerationId: string;
      parentLocalEffectsStatus: "settled";
      childRunIds: string[];
      childRunIdsSha256: string;
      committedAt: string;
    },
  ): boolean {
    try {
      const record = readExactChatTurnAdmissionHandoff(value);
      return Boolean(
        record &&
        record.version === expected.version &&
        record.admissionId === expected.admissionId &&
        record.sessionIncarnationId === expected.sessionIncarnationId &&
        record.turnId === expected.turnId &&
        record.parentRunId === expected.parentRunId &&
        record.postCommitGenerationId === expected.postCommitGenerationId &&
        record.parentLocalEffectsStatus === expected.parentLocalEffectsStatus &&
        canonicalJsonString(record.childRunIds) === canonicalJsonString(expected.childRunIds) &&
        record.childRunIdsSha256 === expected.childRunIdsSha256,
      );
    } catch {
      return false;
    }
  }

  private async settleAuthoritySupersededGeneralChatPostCommit(runId: string): Promise<void> {
    await this.ctx.storage.runImmediateTransaction(async () => {
      const current = await this.ctx.storage.durableRuns.getRunForUpdate(runId);
      const marker = readGeneralChatPostCommitPendingMarker(current);
      if (!marker) return;
      const admission = await this.requireExactParentTurnAdmission(current, { requireActive: false });
      if (admission.status !== "cancelled" || admission.terminalAuthorityKind !== "authority_superseded") {
        throw new Error(`Durable Chat parent ${runId} has no authority-superseded terminal evidence.`);
      }
      const completedEffects = readGeneralChatPostCommitCompletedEffects(current);
      const blockedEffects = GENERAL_CHAT_POST_COMMIT_EFFECTS.filter(
        (effect) =>
          !completedEffects.includes(effect) &&
          (!isGeneralChatPostCommitDurableEffect(effect) || !marker.durableEffectRunIds[effect]),
      );
      const metadata = { ...(current.metadata ?? {}) };
      delete metadata[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY];
      metadata.generalChatPostCommit = {
        generationId: marker.generationId,
        traceStatus: marker.traceStatus,
        requestedAt: marker.requestedAt,
        postCommitEligibility: marker.postCommitEligibility,
        settlementStatus: "authority_superseded",
        completedEffects,
        blockedEffects,
        durableEffectRunIds: { ...marker.durableEffectRunIds },
        childOutcomeAuthority: "child_durable_runs",
        terminalControlEventId: admission.terminalControlEventId,
        settledAt: new Date().toISOString(),
      };
      readExactGeneralChatPostCommitSettlement(metadata.generalChatPostCommit);
      await this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: current.status,
        metadata,
        updatedAt: new Date().toISOString(),
        expectedVersion: current.version,
      });
    });
  }

  /**
   * Atomically applies one local consumer and records its per-turn
   * receipt. PostgreSQL workers serialize on the parent row before invoking
   * the callback, so two processes cannot both run the same callback. This
   * guarantee covers only work awaited on the same transaction connection;
   * provider-backed consumers use deterministic child runs below.
   */
  private async runGeneralChatPostCommitEffect(
    runId: string,
    expectedMarker: GeneralChatPostCommitPendingMarker,
    effect: GeneralChatPostCommitEffect,
    callback: () => void | Promise<void>,
    completedEffects: Set<GeneralChatPostCommitEffect>,
  ): Promise<boolean> {
    if (completedEffects.has(effect)) {
      return false;
    }
    let applied = false;
    await this.ctx.storage.runImmediateTransaction(async () => {
      const current = await this.ctx.storage.durableRuns.getRunForUpdate(runId);
      const currentMarker = readGeneralChatPostCommitPendingMarker(current);
      if (!currentMarker || !sameGeneralChatPostCommitGeneration(expectedMarker, currentMarker)) {
        return;
      }
      const currentEffects = readGeneralChatPostCommitCompletedEffects(current);
      if (currentEffects.includes(effect)) {
        completedEffects.add(effect);
        return;
      }
      await callback();
      const metadata = {
        ...(current.metadata ?? {}),
        [GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY]: {
          ...currentMarker,
          completedEffects: [...currentEffects, effect],
        },
      };
      await this.ctx.storage.durableRuns.updateRun({
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

  /**
   * Receipt-first notification path. The publisher runs only after the parent
   * transaction commits, and it also runs when the receipt already exists so an
   * idempotent retained delivery closes a crash gap without emitting ghosts.
   */
  private async publishGeneralChatPostCommitEffect(
    runId: string,
    expectedMarker: GeneralChatPostCommitPendingMarker,
    effect: GeneralChatPostCommitEffect,
    callback: () => void | Promise<void>,
    completedEffects: Set<GeneralChatPostCommitEffect>,
  ): Promise<boolean> {
    const applied = await this.runGeneralChatPostCommitEffect(
      runId,
      expectedMarker,
      effect,
      () => undefined,
      completedEffects,
    );
    const committed = await this.ctx.storage.durableRuns.getRun(runId);
    const currentMarker = readGeneralChatPostCommitPendingMarker(committed);
    if (
      currentMarker &&
      sameGeneralChatPostCommitGeneration(expectedMarker, currentMarker) &&
      currentMarker.completedEffects.includes(effect)
    ) {
      await callback();
    }
    return applied;
  }

  private async enqueueGeneralChatPostCommitEffect(
    parentRunId: string,
    expectedMarker: GeneralChatPostCommitPendingMarker,
    input: GeneralChatPostCommitDurableEffectInput,
    completedEffects: Set<GeneralChatPostCommitEffect>,
  ): Promise<string | undefined> {
    const effect = input.effect;
    const childRunId = buildGeneralChatPostCommitEffectRunId(parentRunId, expectedMarker.generationId, effect);
    const dispatchedChildRunId = expectedMarker.durableEffectRunIds[effect];
    if (dispatchedChildRunId) {
      if (dispatchedChildRunId !== childRunId) {
        throw new Error(`Durable Chat post-commit ${parentRunId} has an invalid ${effect} child-run receipt.`);
      }
      const child = await this.ctx.storage.durableRuns.getRun(childRunId);
      assertGeneralChatPostCommitEffectChildLink(child, parentRunId, expectedMarker.generationId, effect);
      if (child.status === "queued") {
        this.requestRunProcessing(childRunId);
      }
      return undefined;
    }
    if (completedEffects.has(effect)) {
      return undefined;
    }
    let committedChildRunId: string | undefined;
    let createdChild: DurableRunRecord | undefined;
    await this.ctx.storage.runImmediateTransaction(async () => {
      const current = await this.ctx.storage.durableRuns.getRunForUpdate(parentRunId);
      const currentMarker = readGeneralChatPostCommitPendingMarker(current);
      if (!currentMarker || !sameGeneralChatPostCommitGeneration(expectedMarker, currentMarker)) {
        return;
      }
      const currentEffects = readGeneralChatPostCommitCompletedEffects(current);
      const recordedChildRunId = currentMarker.durableEffectRunIds[effect];
      if (recordedChildRunId) {
        if (recordedChildRunId !== childRunId) {
          throw new Error(`Durable Chat post-commit ${parentRunId} has an invalid ${effect} child-run receipt.`);
        }
        committedChildRunId = childRunId;
        return;
      }
      if (currentEffects.includes(effect)) {
        completedEffects.add(effect);
        return;
      }

      const childAdmission = await this.admitGeneralChatPostCommitChild(current, currentMarker, input, childRunId);
      const payload: GeneralChatPostCommitEffectWorkflowPayload = {
        version: "chat.post_commit.effect.v2",
        parentRunId,
        postCommitGenerationId: expectedMarker.generationId,
        effect,
        traceStatus: expectedMarker.traceStatus,
        input,
        childAdmission,
        postCommitEligibility: expectedMarker.postCommitEligibility,
      };
      let child: DurableRunRecord | undefined;
      try {
        child = await this.ctx.storage.durableRuns.getRun(childRunId);
      } catch (error) {
        if (!(error instanceof NotFoundError)) {
          throw error;
        }
      }
      if (child) {
        assertGeneralChatPostCommitEffectChild(child, payload);
      } else {
        const now = new Date().toISOString();
        child = await this.ctx.storage.durableRuns.createRun({
          runId: childRunId,
          workflowKey: "chat.post_commit.effect",
          status: "queued",
          attemptCount: 0,
          maxAttempts: DURABLE_RETRY_POLICY_DEFAULT.maxAttempts,
          payload: payload as unknown as Record<string, unknown>,
          metadata: {
            retryPolicy: DURABLE_RETRY_POLICY_DEFAULT,
            parentRunId,
            postCommitGenerationId: expectedMarker.generationId,
            effect,
            workspaceId: readGeneralChatPostCommitWorkspaceId(input),
            sessionId: input.sessionId,
            ...(readGeneralChatPostCommitTurnId(input) ? { turnId: readGeneralChatPostCommitTurnId(input) } : {}),
            childAdmission,
            postCommitEligibility: expectedMarker.postCommitEligibility,
          },
          now,
        });
        await this.ctx.storage.durableRuns.createCheckpoint({
          runId: childRunId,
          checkpointKind: "run_created",
          state: {
            workflowKey: child.workflowKey,
            status: child.status,
            parentRunId,
            postCommitGenerationId: expectedMarker.generationId,
            effect,
          },
          createdAt: now,
        });
        await this.recordDurableTimelineEvent(childRunId, "run_created", {
          workflowKey: child.workflowKey,
          status: child.status,
          parentRunId,
          postCommitGenerationId: expectedMarker.generationId,
          effect,
          workspaceId: readGeneralChatPostCommitWorkspaceId(input),
          sessionId: input.sessionId,
          ...(readGeneralChatPostCommitTurnId(input) ? { turnId: readGeneralChatPostCommitTurnId(input) } : {}),
        });
        createdChild = child;
      }

      await this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: current.status,
        metadata: {
          ...(current.metadata ?? {}),
          [GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY]: {
            ...currentMarker,
            completedEffects: currentEffects,
            durableEffectRunIds: {
              ...currentMarker.durableEffectRunIds,
              [effect]: childRunId,
            },
          },
        },
        updatedAt: new Date().toISOString(),
        expectedVersion: current.version,
      });
      committedChildRunId = childRunId;
    });
    if (createdChild) {
      await this.ctx.publishRealtime(
        "system",
        "durable",
        {
          type: "durable_run_created",
          runId: createdChild.runId,
          workflowKey: createdChild.workflowKey,
          status: createdChild.status,
          parentRunId,
          postCommitGenerationId: expectedMarker.generationId,
          effect,
        },
        buildDurableRealtimeOptions(createdChild.runId),
      );
    }
    if (committedChildRunId) {
      this.requestRunProcessing(committedChildRunId);
    }
    return committedChildRunId;
  }

  private async requireExactParentTurnAdmission(
    parentRun: DurableRunRecord,
    options: { requireActive?: boolean } = {},
  ): Promise<SessionMutationAdmissionRecord & { turnId: string }> {
    const payload = parentRun.payload as Record<string, unknown>;
    const admissionId = typeof payload.admissionId === "string" ? payload.admissionId : "";
    const requestActor =
      payload.requestActor && typeof payload.requestActor === "object" && !Array.isArray(payload.requestActor)
        ? (payload.requestActor as Record<string, unknown>)
        : undefined;
    const admission = admissionId ? await this.ctx.storage.sessionMutationAdmissions.require(admissionId) : undefined;
    if (
      payload.version !== "chat.turn.execute.v2" ||
      !admission ||
      admission.admissionKind !== "turn_write" ||
      (options.requireActive !== false && admission.status !== "active") ||
      typeof admission.turnId !== "string" ||
      payload.sessionIncarnationId !== admission.sessionIncarnationId ||
      payload.workspaceId !== admission.workspaceId ||
      payload.sessionId !== admission.sessionId ||
      payload.turnId !== admission.turnId ||
      payload.admissionMaterialSha256 !== admission.materialSha256 ||
      payload.admissionAggregateRevision !== admission.aggregateRevision ||
      payload.admissionControllerGeneration !== admission.controllerGeneration ||
      requestActor?.actorKind !== admission.actorKind ||
      requestActor.actorId !== admission.actorId
    ) {
      throw new Error(`Durable Chat parent ${parentRun.runId} has no exact turn admission lineage.`);
    }
    return admission as SessionMutationAdmissionRecord & { turnId: string };
  }

  private async verifyCanonicalAutonomousChatAdmission(
    run: DurableRunRecord,
  ): Promise<ReturnType<typeof verifyAutonomousChatAdmissionRunMetadata>> {
    const admission = await this.requireExactParentTurnAdmission(run, { requireActive: false });
    const turnId = (run.payload as { turnId?: unknown } | undefined)?.turnId;
    if (typeof turnId !== "string" || !turnId.trim()) {
      throw new Error(`Autonomous Chat run ${run.runId} has no canonical turn identity.`);
    }
    const trace = await this.ctx.storage.chatTurnTraces.get(turnId);
    if (!trace) {
      throw new Error(`Autonomous Chat run ${run.runId} has no canonical trace binding.`);
    }
    return verifyAutonomousChatAdmissionRunMetadata(run, { admission, trace });
  }

  private async settleCanonicalAutonomousChatWriteAuthority(
    run: DurableRunRecord,
  ): Promise<"current" | "authority_superseded"> {
    const admission = await this.requireExactParentTurnAdmission(run, { requireActive: false });
    await this.verifyCanonicalAutonomousChatAdmission(run);
    const authority = await this.ctx.storage.sessionMutationAdmissions.settleTurnWriteAuthority({
      admissionId: admission.admissionId,
      sessionIncarnationId: admission.sessionIncarnationId,
      workspaceId: admission.workspaceId,
      sessionId: admission.sessionId,
      turnId: admission.turnId,
    });
    if (authority.disposition === "authority_superseded") return "authority_superseded";
    if (authority.admission.status !== "active") {
      throw new Error(`Autonomous Chat run ${run.runId} admission is already closed.`);
    }
    return "current";
  }

  private async closeTerminalChatTurnAdmissionIfReady(run: DurableRunRecord): Promise<void> {
    const admittedV2Parent =
      run.workflowKey === "chat.turn.execute" &&
      (run.payload as { version?: unknown } | undefined)?.version === "chat.turn.execute.v2";
    if (!admittedV2Parent) return;
    if (!(run.status === "completed" || run.status === "failed" || run.status === "cancelled")) {
      if (isDurableRunTerminal(run.status)) {
        throw new Error(
          `Durable Chat parent ${run.runId} cannot close admission from unrepresentable status ${run.status}.`,
        );
      }
      return;
    }
    const metadata = run.metadata ?? {};
    const retryExhaustion = readChatRetryExhaustionDeadLetterPending(
      metadata[CHAT_RETRY_EXHAUSTION_DEAD_LETTER_PENDING_METADATA_KEY],
    );
    if (AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY in metadata) {
      readAutonomousChatPostCommitPendingMarker(run);
      return;
    }
    if ("linkedFinalizationPending" in metadata) {
      readLinkedFinalizationPending(run);
      return;
    }
    if (GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY in metadata) {
      readGeneralChatPostCommitPendingMarker(run);
      return;
    }
    if (metadata.chatTurnAdmissionHandoff === undefined) {
      throw new Error(`Durable Chat parent ${run.runId} has no committed terminal handoff marker.`);
    }
    const admission = await this.requireExactParentTurnAdmission(run, { requireActive: false });
    const handoff = readExactChatTurnAdmissionHandoff(metadata.chatTurnAdmissionHandoff);
    const generalSettlement = readExactGeneralChatPostCommitSettlement(metadata.generalChatPostCommit);
    if (
      !handoff ||
      !generalSettlement ||
      generalSettlement.settlementStatus === "authority_superseded" ||
      (generalSettlement.settlementStatus !== "completed" &&
        generalSettlement.settlementStatus !== "settled_with_failures") ||
      typeof generalSettlement.completedAt !== "string"
    ) {
      throw new Error(`Durable Chat parent ${run.runId} has no exact completed general settlement.`);
    }
    const runtimeAuthority = await this.readCheckpointAnchoredChatTurnRuntimeAuthority(run);
    if (runtimeAuthority) {
      if (
        !runtimeAuthority.material.requiredFinalizers.includes("general") ||
        generalSettlement.generationId !== runtimeAuthority.material.postCommitGenerationId ||
        generalSettlement.traceStatus !== runtimeAuthority.material.traceStatus ||
        generalSettlement.requestedAt !== runtimeAuthority.material.transitionAt ||
        canonicalJsonString(generalSettlement.postCommitEligibility) !==
          canonicalJsonString(runtimeAuthority.material.postCommitEligibility) ||
        !this.arePriorChatTurnFinalizersSettled(run, runtimeAuthority)
      ) {
        throw new Error(`Durable Chat parent ${run.runId} finalizer settlements do not match runtime authority.`);
      }
      await this.verifyCanonicalTerminalOutputAgainstAuthority(run, runtimeAuthority);
    }
    const childRunIds = [
      ...new Set(Object.values(generalSettlement.durableEffectRunIds as Record<string, string>)),
    ].sort((left, right) => left.localeCompare(right));
    if (
      handoff.admissionId !== admission.admissionId ||
      handoff.sessionIncarnationId !== admission.sessionIncarnationId ||
      handoff.turnId !== admission.turnId ||
      handoff.parentRunId !== run.runId ||
      handoff.postCommitGenerationId !== generalSettlement.generationId ||
      canonicalJsonString(handoff.childRunIds) !== canonicalJsonString(childRunIds) ||
      handoff.childRunIdsSha256 !== hashChatTurnRuntimeAuthorityValue(childRunIds)
    ) {
      throw new Error(`Durable Chat parent ${run.runId} terminal handoff drifted from its settlement evidence.`);
    }
    if (admission.status !== "active") {
      if (
        admission.terminalAuthorityKind === "authority_superseded" ||
        admission.terminalAuthorityKind === "lifecycle_delete"
      ) {
        if (retryExhaustion) await this.projectChatRetryExhaustionDeadLetter(run, retryExhaustion);
        return;
      }
      if (
        admission.terminalAuthorityKind === "durable_terminal" &&
        admission.terminalDurableRunId === run.runId &&
        admission.terminalDurableRunStatus === run.status
      ) {
        await this.settleSystemHeartbeatOccurrenceIfPresent(run, admission);
        if (retryExhaustion) await this.projectChatRetryExhaustionDeadLetter(run, retryExhaustion);
        return;
      }
      throw new Error(`Durable Chat parent ${run.runId} admission was closed by conflicting authority.`);
    }
    const authority = await this.ctx.storage.sessionMutationAdmissions.settleTurnWriteAuthority({
      admissionId: admission.admissionId,
      sessionIncarnationId: admission.sessionIncarnationId,
      workspaceId: admission.workspaceId,
      sessionId: admission.sessionId,
      turnId: admission.turnId,
    });
    if (authority.disposition === "authority_superseded") {
      if (retryExhaustion) await this.projectChatRetryExhaustionDeadLetter(run, retryExhaustion);
      return;
    }
    await this.ctx.storage.sessionMutationAdmissions.closeTurnWrite({
      admissionId: admission.admissionId,
      sessionIncarnationId: admission.sessionIncarnationId,
      workspaceId: admission.workspaceId,
      sessionId: admission.sessionId,
      turnId: admission.turnId,
      status: run.status === "completed" ? "completed" : "cancelled",
      actorId: admission.actorId,
      idempotencyKey: `chat-turn-handoff:${run.runId}`,
      correlationId: run.runId,
    });
    await this.settleSystemHeartbeatOccurrenceIfPresent(run, admission);
    if (retryExhaustion) await this.projectChatRetryExhaustionDeadLetter(run, retryExhaustion);
  }

  private async settleSystemHeartbeatOccurrenceIfPresent(
    run: DurableRunRecord,
    admission: SessionMutationAdmissionRecord & { turnId: string },
  ): Promise<void> {
    const payload = run.payload as {
      heartbeatOccurrenceId?: unknown;
      capabilityProfileId?: unknown;
      capabilityProfileHash?: unknown;
    };
    if (payload.heartbeatOccurrenceId === undefined) return;
    const occurrences = (this.ctx.storage as Partial<Storage>).heartbeatOccurrences;
    if (!occurrences) {
      if (process.env.NODE_ENV === "test") return;
      throw new Error("Heartbeat occurrence repository is unavailable during terminal Chat handoff.");
    }
    if (
      typeof payload.heartbeatOccurrenceId !== "string" ||
      !payload.heartbeatOccurrenceId.trim() ||
      typeof payload.capabilityProfileId !== "string" ||
      !payload.capabilityProfileId.trim() ||
      typeof payload.capabilityProfileHash !== "string" ||
      !payload.capabilityProfileHash.trim()
    ) {
      throw new Error(`System heartbeat ${run.runId} has no exact occurrence settlement identity.`);
    }
    const settlement = await occurrences.markTerminal({
      occurrenceId: payload.heartbeatOccurrenceId,
      workspaceId: admission.workspaceId,
      sessionId: admission.sessionId,
      sessionIncarnationId: admission.sessionIncarnationId,
      admissionId: admission.admissionId,
      turnId: admission.turnId,
      durableRunId: run.runId,
      capabilityProfileId: payload.capabilityProfileId,
      capabilityProfileHash: payload.capabilityProfileHash,
    });
    if (settlement.disposition === "still_bound") {
      throw new Error(`System heartbeat ${run.runId} terminal handoff did not settle its occurrence.`);
    }
  }

  private async projectChatRetryExhaustionDeadLetter(
    run: DurableRunRecord,
    marker: ChatRetryExhaustionDeadLetterPending,
  ): Promise<void> {
    const current = await this.ctx.storage.durableRuns.getRun(run.runId);
    if (
      current.status === "dead_lettered" &&
      current.metadata?.[CHAT_RETRY_EXHAUSTION_DEAD_LETTER_PENDING_METADATA_KEY] === undefined
    ) {
      return;
    }
    const currentMarker = readChatRetryExhaustionDeadLetterPending(
      current.metadata?.[CHAT_RETRY_EXHAUSTION_DEAD_LETTER_PENDING_METADATA_KEY],
    );
    if (
      !currentMarker ||
      canonicalJsonString(currentMarker) !== canonicalJsonString(marker) ||
      current.status !== "failed" ||
      current.attemptCount !== marker.attemptNo ||
      current.maxAttempts !== marker.maxAttempts ||
      current.lastError !== marker.reason
    ) {
      throw new Error(`Durable Chat run ${run.runId} retry-exhaustion projection conflicts with terminal truth.`);
    }
    this.assertExactAdmittedChatRetryAuthority(current);
    await this.ctx.storage.durableRuns.upsertDeadLetter({
      runId: run.runId,
      reason: marker.reason,
      payload: {
        actorId: marker.actorId,
        attemptNo: marker.attemptNo,
        maxAttempts: marker.maxAttempts,
        failedAt: marker.requestedAt,
      },
    });
    const metadata = { ...(current.metadata ?? {}) };
    delete metadata[CHAT_RETRY_EXHAUSTION_DEAD_LETTER_PENDING_METADATA_KEY];
    await this.ctx.storage.durableRuns.updateRun({
      runId: run.runId,
      status: "dead_lettered",
      metadata,
      updatedAt: new Date().toISOString(),
      clearLease: true,
      expectedVersion: current.version,
    });
    await this.recordDurableTimelineEvent(run.runId, "run_dead_lettered", {
      actorId: marker.actorId,
      reason: marker.reason,
      attemptNo: marker.attemptNo,
      maxAttempts: marker.maxAttempts,
      admissionFinalized: true,
    });
  }

  private async admitGeneralChatPostCommitChild(
    parentRun: DurableRunRecord,
    marker: GeneralChatPostCommitPendingMarker,
    input: GeneralChatPostCommitDurableEffectInput,
    childRunId: string,
  ): Promise<PostCommitChildAdmissionIdentity> {
    const parentAdmission = await this.requireExactParentTurnAdmission(parentRun, { requireActive: false });
    const authority = await this.ctx.storage.sessionMutationAdmissions.settleTurnWriteAuthority({
      admissionId: parentAdmission.admissionId,
      sessionIncarnationId: parentAdmission.sessionIncarnationId,
      workspaceId: parentAdmission.workspaceId,
      sessionId: parentAdmission.sessionId,
      turnId: parentAdmission.turnId,
    });
    if (authority.disposition === "authority_superseded") {
      throw new DurableChatParentAuthoritySupersededError(parentRun.runId);
    }
    if (authority.admission.status !== "active") {
      throw new Error(`Durable Chat post-commit parent ${parentRun.runId} admission is already closed.`);
    }
    const sessionIncarnationId = parentAdmission.sessionIncarnationId;
    if (
      parentAdmission.workspaceId !== input.workspaceId ||
      parentAdmission.sessionId !== input.sessionId ||
      parentAdmission.turnId !== input.turnId
    ) {
      throw new Error(`Durable Chat post-commit parent ${parentRun.runId} has no exact turn admission lineage.`);
    }
    const sessionMeta = await this.ctx.storage.chatSessionMeta.get(input.sessionId);
    if (
      !sessionMeta ||
      sessionMeta.workspaceId !== input.workspaceId ||
      sessionMeta.revision < parentAdmission.aggregateRevision
    ) {
      throw new Error(`Durable Chat post-commit parent ${parentRun.runId} session authority is unavailable.`);
    }
    const materialSha256 = computePostCommitChildAdmissionMaterialSha256({
      parentRunId: parentRun.runId,
      postCommitGenerationId: marker.generationId,
      effect: input.effect,
      childRunId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sourceTurnId: input.turnId,
      sessionIncarnationId,
      postCommitEligibility: marker.postCommitEligibility,
    });
    const outcome = await this.ctx.storage.sessionMutationAdmissions.admit({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      expectedSessionIncarnationId: sessionIncarnationId,
      admissionKind: "synchronous",
      aggregateRevision: sessionMeta.revision,
      controllerGeneration: parentAdmission.controllerGeneration,
      actorKind: parentAdmission.actorKind,
      actorId: parentAdmission.actorId,
      operation: "chat_post_commit_child",
      materialSha256,
      idempotencyKey: `chat-post-commit-child:${childRunId}`,
      correlationId: childRunId,
    });
    const child = outcome.admission;
    if (
      child.status !== "active" ||
      child.admissionKind !== "synchronous" ||
      child.turnId !== undefined ||
      child.sessionIncarnationId !== sessionIncarnationId ||
      child.workspaceId !== input.workspaceId ||
      child.sessionId !== input.sessionId ||
      child.aggregateRevision !== sessionMeta.revision ||
      child.controllerGeneration !== parentAdmission.controllerGeneration ||
      child.actorKind !== parentAdmission.actorKind ||
      child.actorId !== parentAdmission.actorId ||
      child.operation !== "chat_post_commit_child" ||
      child.materialSha256 !== materialSha256
    ) {
      throw new Error(`Durable Chat post-commit child ${childRunId} admission conflicts with its frozen lineage.`);
    }
    return {
      admissionId: child.admissionId,
      sessionIncarnationId: child.sessionIncarnationId,
      workspaceId: child.workspaceId,
      sessionId: child.sessionId,
      aggregateRevision: child.aggregateRevision,
      controllerGeneration: child.controllerGeneration,
      actorKind: child.actorKind,
      actorId: child.actorId,
      operation: "chat_post_commit_child",
      materialSha256: child.materialSha256,
    };
  }

  private async resolvePostCommitEligibility(sessionId: string): Promise<PostCommitEligibility> {
    const resolved = await this.deps?.resolvePostCommitEligibility?.(sessionId);
    if (resolved) return resolved;
    const origin = (await this.ctx.storage.chatSessionMeta?.get?.(sessionId))?.origin;
    return {
      version: 1,
      autonomyEnabledAtParentSettlement: !(await this.ctx.isFeatureEnabled("autonomyV1Disabled")),
      evalIntegrityTurn: origin === "prompt_pack",
      humanSession: origin !== "system" && origin !== "prompt_pack",
    };
  }

  async createDurableRun(
    input: DurableRunCreateRequest,
    options: { publishRealtime?: boolean; idempotentIfExists?: boolean } = {},
  ): Promise<DurableRunRecord> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
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
    if (
      workflowKey === "chat.turn.execute" &&
      (input.payload as { version?: unknown } | undefined)?.version === "chat.turn.execute.v2" &&
      canonicalJsonString(retryPolicy) !== canonicalJsonString(DURABLE_RETRY_POLICY_DEFAULT)
    ) {
      throw new Error("Admitted v2 Chat runs require the exact canonical retry policy.");
    }
    const now = new Date().toISOString();
    const status: DurableRunRecord["status"] = input.waitForEvent ? "waiting" : "queued";
    const metadata = {
      ...(input.metadata ?? {}),
      retryPolicy,
      waitForEvent: input.waitForEvent ?? null,
    };
    const stableRunId =
      (options.idempotentIfExists ?? workflowKey === "chat.turn.execute") ? input.runId?.trim() : undefined;
    if (stableRunId) {
      const existing = await findDurableRun(this.ctx.storage, stableRunId);
      if (existing) {
        assertIdempotentDurableRunMatches(existing, workflowKey, input.payload ?? {}, retryPolicy);
        return existing;
      }
    }
    let run!: DurableRunRecord;
    try {
      await this.ctx.storage.runImmediateTransaction(async () => {
        run = await this.ctx.storage.durableRuns.createRun({
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
        await this.createDurableCheckpoint({
          runId: run.runId,
          checkpointKind: "run_created",
          state: {
            workflowKey: run.workflowKey,
            status: run.status,
          },
          createdAt: now,
        });
        await this.recordDurableTimelineEvent(run.runId, "run_created", {
          workflowKey: run.workflowKey,
          status: run.status,
        });
        if (status === "waiting") {
          await this.createDurableCheckpoint({
            runId: run.runId,
            checkpointKind: "run_waiting",
            state: {
              waitForEvent: input.waitForEvent ?? null,
            },
          });
          await this.recordDurableTimelineEvent(run.runId, "run_waiting", {
            waitForEvent: input.waitForEvent ?? null,
          });
        }
      });
    } catch (error) {
      if (!stableRunId) {
        throw error;
      }
      const existing = await findDurableRun(this.ctx.storage, stableRunId);
      if (!existing) {
        throw error;
      }
      assertIdempotentDurableRunMatches(existing, workflowKey, input.payload ?? {}, retryPolicy);
      return existing;
    }
    if (status === "waiting") {
      this.scheduleCommittedBackgroundAttention(run.runId, "run_waiting");
    }
    if (options.publishRealtime !== false) {
      await this.publishDurableRealtimeSafely(run.runId, {
        type: "durable_run_created",
        runId: run.runId,
        workflowKey: run.workflowKey,
        status: run.status,
      });
    }
    return run;
  }

  async pauseDurableRun(runId: string, actorId = "operator"): Promise<DurableRunRecord> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer(actorId);
    const current = await this.ctx.storage.durableRuns.getRun(runId);
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
    await this.ctx.storage.runImmediateTransaction(async () => {
      next = await this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "paused",
        startedAt: current.startedAt ?? new Date().toISOString(),
        clearFinishedAt: true,
        clearLastError: true,
        clearLease: true,
        updatedAt: new Date().toISOString(),
        expectedVersion: current.version,
      });
      await this.recordDurableTimelineEvent(runId, "run_paused", {
        actorId,
        previousStatus: current.status,
      });
    });
    await this.abortActiveRun(runId, `Durable run ${runId} paused by ${actorId}.`, "paused");
    await this.publishDurableRealtimeSafely(runId, {
      type: "durable_run_paused",
      runId,
      actorId,
    });
    return next;
  }

  async resumeDurableRun(runId: string, actorId = "operator"): Promise<DurableRunRecord> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer(actorId);
    const current = await this.ctx.storage.durableRuns.getRun(runId);
    if (current.status !== "paused") {
      throw new Error(`Durable run ${runId} cannot be resumed from ${current.status}`);
    }
    if (isAutonomousDurableRunForKillSwitch(current) && (await this.ctx.isFeatureEnabled("autonomyV1Disabled"))) {
      throw new Error(
        `Autonomous durable run ${runId} cannot be resumed while the autonomy kill switch is engaged (autonomyV1Disabled).`,
      );
    }
    let next!: DurableRunRecord;
    await this.ctx.storage.runImmediateTransaction(async () => {
      const metadata = await this.prepareQueuedTransitionMetadata(current, "resume");
      next = await this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "queued",
        startedAt: current.startedAt ?? new Date().toISOString(),
        clearFinishedAt: true,
        clearLease: true,
        updatedAt: new Date().toISOString(),
        clearLastError: true,
        metadata,
        expectedVersion: current.version,
      });
      await this.createDurableCheckpoint({
        runId,
        checkpointKind: "run_resumed",
        state: { actorId, previousStatus: current.status },
      });
      await this.recordDurableTimelineEvent(runId, "run_resumed", {
        actorId,
        previousStatus: current.status,
      });
    });
    await this.publishDurableRealtimeSafely(runId, {
      type: "durable_run_resumed",
      runId,
      actorId,
    });
    return next;
  }

  private async prepareQueuedTransitionMetadata(
    run: DurableRunRecord,
    transition: "wake" | "resume",
  ): Promise<Record<string, unknown>> {
    this.assertExactAdmittedChatRetryAuthority(run);
    const metadata = { ...(run.metadata ?? {}) };
    const payload = run.payload as { version?: unknown; turnId?: unknown } | undefined;
    const hasAutonomousAdmission = metadata.autonomousAdmission !== undefined;
    const admittedV2 = isAdmittedV2ChatRun(run);
    const admittedAutonomousV2 = admittedV2 && hasAutonomousAdmission;
    if (admittedAutonomousV2) await this.verifyCanonicalAutonomousChatAdmission(run);
    const carriesWaitingAuthority =
      metadata[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY] !== undefined ||
      (metadata.waitForEvent !== undefined && metadata.waitForEvent !== null);
    if (admittedV2 && (transition === "wake" || carriesWaitingAuthority)) {
      const authority = readChatTurnRuntimeAuthoritySeal(metadata[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]);
      if (
        !authority ||
        authority.material.transitionKind !== "waiting" ||
        authority.material.durableStatus !== "waiting" ||
        authority.material.runId !== run.runId ||
        authority.material.turnId !== payload?.turnId
      ) {
        throw new Error(`Admitted Chat run ${run.runId} has no exact waiting runtime authority.`);
      }
      if (canonicalJsonString(metadata.waitForEvent) !== canonicalJsonString(authority.material.waitForEvent)) {
        throw new Error(`Admitted Chat run ${run.runId} wait registration drifted from its runtime authority.`);
      }
      const waitingCheckpoint = await this.ctx.storage.durableRuns.getLatestCheckpointByKind(run.runId, "run_waiting");
      if (!waitingCheckpoint) {
        throw new Error(`Admitted Chat run ${run.runId} has no authority-anchored waiting checkpoint.`);
      }
      verifyCheckpointAnchoredChatTurnRuntimeAuthority(metadata, waitingCheckpoint.state);
      if (metadata[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined) {
        throw new Error(`Admitted Chat run ${run.runId} cannot queue before its waiting generation settles.`);
      }
      if (
        metadata[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined ||
        metadata.linkedFinalizationPending !== undefined ||
        metadata.chatTurnAdmissionHandoff !== undefined
      ) {
        throw new Error(`Admitted Chat run ${run.runId} carries terminal finalization evidence while waiting.`);
      }
      const settlement = readExactGeneralChatPostCommitSettlement(metadata.generalChatPostCommit);
      if (
        !settlement ||
        settlement.generationId !== authority.material.postCommitGenerationId ||
        settlement.traceStatus !== authority.material.traceStatus ||
        settlement.requestedAt !== authority.material.transitionAt ||
        settlement.settlementStatus !== "completed" ||
        typeof settlement.completedAt !== "string" ||
        canonicalJsonString(settlement.postCommitEligibility) !==
          canonicalJsonString(authority.material.postCommitEligibility)
      ) {
        throw new Error(`Admitted Chat run ${run.runId} has no exact settled waiting generation.`);
      }
      delete metadata[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY];
    } else if (!admittedV2 && metadata[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY] !== undefined) {
      throw new Error(`Durable run ${run.runId} carries runtime authority without an admitted v2 Chat run.`);
    }
    delete metadata.waitForEvent;
    return metadata;
  }

  async cancelDurableRun(
    runId: string,
    actorId = "operator",
    options?: { expectedVersion?: number; reason?: string; assertLockedPrecondition?: () => void | Promise<void> },
  ): Promise<DurableRunRecord> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer(actorId);
    const cancellationReason = normalizeDurableCancellationReason(options?.reason);
    const current = await this.ctx.storage.durableRuns.getRun(runId);
    if (current.status === "cancelled") {
      return current;
    }
    if (options?.expectedVersion !== undefined && current.version !== options.expectedVersion) {
      throw new Error(
        `Durable run ${runId} changed from version ${options.expectedVersion} to ${current.version} before cancellation.`,
      );
    }
    if (current.status === "completed" || current.status === "failed" || current.status === "dead_lettered") {
      throw new Error(`Durable run ${runId} is already terminal (${current.status})`);
    }
    const now = new Date().toISOString();
    let chatLink: DurableChatCancellationLink | undefined;
    let transitioned = false;
    let next!: DurableRunRecord;
    await this.ctx.storage.runImmediateTransaction(async () => {
      const lockedCurrent = await this.ctx.storage.durableRuns.getRunForUpdate(runId);
      if (lockedCurrent.status === "cancelled") {
        next = lockedCurrent;
        return;
      }
      await options?.assertLockedPrecondition?.();
      if (options?.expectedVersion !== undefined && lockedCurrent.version !== options.expectedVersion) {
        throw new Error(
          `Durable run ${runId} changed from version ${options.expectedVersion} to ${lockedCurrent.version} before cancellation.`,
        );
      }
      if (
        lockedCurrent.status === "completed" ||
        lockedCurrent.status === "failed" ||
        lockedCurrent.status === "dead_lettered"
      ) {
        throw new Error(`Durable run ${runId} is already terminal (${lockedCurrent.status})`);
      }
      chatLink = readDurableChatCancellationLink(lockedCurrent);
      if (chatLink) {
        let latestTrace: ChatTurnTraceRecord;
        try {
          latestTrace = await this.ctx.storage.chatTurnTraces.get(chatLink.turnId);
        } catch (error) {
          if (error instanceof NotFoundError) {
            throw new Error(`Durable Chat run ${runId} cannot be cancelled without its canonical turn trace.`, {
              cause: error,
            });
          }
          throw error;
        }
        assertDurableChatCancellationTraceLink(runId, chatLink, latestTrace);
        if (isChatTurnTerminalStatus(latestTrace.status) && latestTrace.status !== "cancelled") {
          throw new Error(
            `Durable Chat run ${runId} cannot be cancelled because turn ${chatLink.turnId} is already ${latestTrace.status}.`,
          );
        }
        if (latestTrace.status !== "cancelled") {
          const cancelledTrace = await this.ctx.storage.chatTurnTraces.patchIfStatus(
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
      let cancellationMetadata = lockedCurrent.metadata;
      let cancellationCheckpointState: Record<string, unknown> = {
        actorId,
        previousStatus: lockedCurrent.status,
        ...(cancellationReason ? { reason: cancellationReason } : {}),
        ...(chatLink ? { sessionId: chatLink.sessionId, turnId: chatLink.turnId } : {}),
      };
      if (chatLink) {
        const generationId = randomUUID();
        const eligibility = await this.resolvePostCommitEligibility(chatLink.sessionId);
        cancellationMetadata = markGeneralChatPostCommitPending(
          resetChatTurnRuntimeTransitionMetadata(
            mergeCanonicalDurableChatTerminalOutputMetadata(lockedCurrent.metadata, undefined),
          ),
          now,
          "cancelled",
          eligibility,
          generationId,
        );
        if (isAdmittedV2ChatRun(lockedCurrent)) {
          this.assertExactAdmittedChatRetryAuthority(lockedCurrent);
          await this.requireExactParentTurnAdmission(lockedCurrent);
          if (lockedCurrent.metadata?.autonomousAdmission !== undefined) {
            await this.verifyCanonicalAutonomousChatAdmission(lockedCurrent);
          }
          const authority = buildChatTurnRuntimeAuthoritySeal({
            runId,
            turnId: chatLink.turnId,
            transitionKind: "terminal",
            durableStatus: "cancelled",
            traceStatus: "cancelled",
            transitionAt: now,
            postCommitGenerationId: generationId,
            postCommitEligibility: eligibility,
            requiredFinalizers: ["general"],
          });
          cancellationMetadata = withChatTurnRuntimeAuthority(cancellationMetadata, authority);
          cancellationCheckpointState = withChatTurnRuntimeAuthorityCheckpoint(cancellationCheckpointState, authority);
        }
      }
      next = await this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "cancelled",
        finishedAt: now,
        clearLease: true,
        updatedAt: now,
        lastError: `cancelled by ${actorId}`,
        ...(chatLink ? { metadata: cancellationMetadata } : {}),
        expectedVersion: lockedCurrent.version,
      });
      await this.createDurableCheckpoint({
        runId,
        checkpointKind: "run_cancelled",
        state: cancellationCheckpointState,
      });
      await this.recordDurableTimelineEvent(runId, "run_cancelled", {
        actorId,
        previousStatus: lockedCurrent.status,
        ...(cancellationReason ? { reason: cancellationReason } : {}),
      });
      transitioned = true;
    });
    if (!transitioned) {
      return next;
    }
    this.scheduleCommittedBackgroundAttention(runId, "run_cancelled");
    await this.abortActiveRun(runId, `Durable run ${runId} cancelled by ${actorId}.`, "cancelled");
    await this.publishDurableRealtimeSafely(runId, {
      type: "durable_run_cancelled",
      runId,
      actorId,
    });
    if (chatLink) {
      this.requestRunProcessing(runId);
    }
    return next;
  }

  async retryDurableRun(runId: string, reason = "manual_retry", actorId = "operator"): Promise<DurableRunRecord> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer({ reason, actorId });
    const current = await this.ctx.storage.durableRuns.getRun(runId);
    this.assertExactAdmittedChatRetryAuthority(current);
    if (current.status !== "failed") {
      throw new Error(`Durable run ${runId} cannot be retried from ${current.status}`);
    }
    if (readLinkedFinalizationPending(current)) {
      throw new Error(`Durable run ${runId} cannot be retried until linked-state finalization completes`);
    }
    const recoverability = await this.deps?.workflowRegistry.isWorkflowRecoverable(current);
    if (recoverability && !recoverability.recoverable) {
      throw new Error(recoverability.reason ?? `Durable run ${runId} cannot be safely retried.`);
    }
    if (isAdmittedV2ChatRun(current)) {
      throw new Error(`Durable Chat run ${runId} requires a new mutation admission instead of manual replay.`);
    }
    return this.scheduleDurableRunRetry(current, reason, actorId);
  }

  async scheduleRunningWorkflowRetry(
    runId: string,
    reason = "workflow_retry",
    actorId = "worker",
    expectedLeaseOwnerId?: string,
  ): Promise<DurableRunRecord> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer({ reason, actorId });
    const observed = await this.ctx.storage.durableRuns.getRun(runId);
    let scheduled!: Awaited<ReturnType<DurableRunService["persistDurableRunRetry"]>>;
    await this.ctx.storage.runImmediateTransaction(async () => {
      const current = expectedLeaseOwnerId
        ? await this.lockFreshLeaseOwnerForTransition(runId, expectedLeaseOwnerId)
        : undefined;
      if (!current) {
        throw new Error(`Durable run ${runId} cannot schedule running retry from ${observed.status}`);
      }
      this.assertExactAdmittedChatRetryAuthority(current);
      const recoverability = await this.deps?.workflowRegistry.isWorkflowRecoverable(current);
      if (recoverability && !recoverability.recoverable) {
        throw new Error(recoverability.reason ?? `Durable run ${runId} cannot be safely retried.`);
      }
      scheduled = await this.persistDurableRunRetry(current, reason, actorId);
    });
    await this.publishDurableRunRetryResult(scheduled);
    return scheduled.run;
  }

  private async scheduleDurableRunRetry(
    current: DurableRunRecord,
    reason: string,
    actorId: string,
  ): Promise<DurableRunRecord> {
    let scheduled!: Awaited<ReturnType<DurableRunService["persistDurableRunRetry"]>>;
    await this.ctx.storage.runImmediateTransaction(async () => {
      scheduled = await this.persistDurableRunRetry(current, reason, actorId);
    });
    await this.publishDurableRunRetryResult(scheduled);
    return scheduled.run;
  }

  /** Persists a retry/dead-letter transition. The caller owns the transaction. */
  private async persistDurableRunRetry(
    current: DurableRunRecord,
    reason: string,
    actorId: string,
  ): Promise<
    | { outcome: "dead_lettered"; run: DurableRunRecord; attemptNo: number; reason: string }
    | { outcome: "terminal_finalization_pending"; run: DurableRunRecord; attemptNo: number; reason: string }
    | { outcome: "scheduled"; run: DurableRunRecord; attemptNo: number; nextRetryAt: string }
  > {
    const runId = current.runId;
    this.assertExactAdmittedChatRetryAuthority(current);
    const attemptNo = current.attemptCount + 1;
    if (attemptNo > current.maxAttempts) {
      if (isAdmittedV2ChatRun(current)) {
        const requestedAt = await this.readDurableDatabaseNow();
        const exhaustedReason = redactRawRemoteApprovalBearerText(`retry_exhausted:${reason}`);
        const retryExhaustion: ChatRetryExhaustionDeadLetterPending = {
          version: 1,
          attemptNo,
          maxAttempts: current.maxAttempts,
          actorId,
          reason: exhaustedReason,
          reasonSha256: hashChatTurnRuntimeAuthorityValue(exhaustedReason),
          requestedAt,
        };
        const failed = await this.persistCanonicalAdmittedChatFailureInTransaction(
          current,
          exhaustedReason,
          requestedAt,
          {
            attemptCount: attemptNo,
            retryExhaustion,
          },
        );
        await this.recordDurableTimelineEvent(runId, "run_retry_budget_exhausted", {
          actorId,
          reason: exhaustedReason,
          attemptNo,
          maxAttempts: current.maxAttempts,
          finalizationPending: true,
        });
        return {
          outcome: "terminal_finalization_pending",
          run: failed,
          attemptNo,
          reason: exhaustedReason,
        };
      }
      const now = new Date().toISOString();
      const deadLetter = await this.ctx.storage.durableRuns.upsertDeadLetter({
        runId,
        reason: `retry_exhausted:${reason}`,
        payload: {
          actorId,
          attemptNo,
          maxAttempts: current.maxAttempts,
        },
      });
      const deadLettered = await this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "dead_lettered",
        attemptCount: attemptNo,
        updatedAt: now,
        finishedAt: now,
        clearLease: true,
        lastError: deadLetter.reason,
        expectedVersion: current.version,
      });
      await this.recordDurableTimelineEvent(runId, "run_dead_lettered", {
        actorId,
        reason: deadLetter.reason,
      });
      await this.recordDurableTimelineEvent(runId, "run_retry_budget_exhausted", {
        actorId,
        reason: deadLetter.reason,
        attemptNo,
        maxAttempts: current.maxAttempts,
      });
      return { outcome: "dead_lettered", run: deadLettered, attemptNo, reason: deadLetter.reason };
    }
    const delayMs = this.computeDurableRetryDelayMs(current, attemptNo);
    const retry = await this.upsertRetryWithDatabaseClock({ runId, attemptNo, reason, delayMs });
    if (!retry.nextRetryAt) {
      throw new Error(`Durable retry ${runId}/${attemptNo} is missing database-clock readiness.`);
    }
    await this.recordDurableTimelineEvent(runId, "run_retry_scheduled", {
      actorId,
      reason,
      nextRetryAt: retry.nextRetryAt,
      attemptNo,
    });
    const next = await this.ctx.storage.durableRuns.updateRun({
      runId,
      status: "queued",
      attemptCount: attemptNo,
      updatedAt: retry.createdAt,
      clearFinishedAt: true,
      clearLease: true,
      clearLastError: true,
      expectedVersion: current.version,
    });
    return { outcome: "scheduled", run: next, attemptNo, nextRetryAt: retry.nextRetryAt };
  }

  private async publishDurableRunRetryResult(
    result: Awaited<ReturnType<DurableRunService["persistDurableRunRetry"]>>,
  ): Promise<void> {
    if (result.outcome === "terminal_finalization_pending") {
      this.scheduleCommittedBackgroundAttention(result.run.runId, "run_retry_budget_exhausted");
      await this.publishDurableRealtimeSafely(result.run.runId, {
        type: "durable_run_failed",
        runId: result.run.runId,
        error: result.reason,
        retryExhausted: true,
      });
      this.requestRunProcessing(result.run.runId);
      return;
    }
    if (result.outcome === "dead_lettered") {
      this.scheduleCommittedBackgroundAttention(result.run.runId, "run_dead_lettered");
      await this.publishDurableRealtimeSafely(result.run.runId, {
        type: "durable_run_dead_lettered",
        runId: result.run.runId,
        reason: result.reason,
      });
      return;
    }
    await this.publishDurableRealtimeSafely(result.run.runId, {
      type: "durable_run_retry_scheduled",
      runId: result.run.runId,
      attemptNo: result.attemptNo,
      nextRetryAt: result.nextRetryAt,
    });
  }

  async wakeDurableRun(
    runId: string,
    event: {
      eventKey: string;
      payload?: Record<string, unknown>;
      correlationId?: string;
    },
  ): Promise<DurableWakeResult> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer(event);
    const current = await this.ctx.storage.durableRuns.getRun(runId);
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
      await this.ctx.storage.runImmediateTransaction(async () => {
        const metadata = await this.prepareQueuedTransitionMetadata(current, "wake");
        next = await this.ctx.storage.durableRuns.updateRun({
          runId,
          status: "queued",
          updatedAt: now,
          startedAt: current.startedAt ?? now,
          clearFinishedAt: true,
          clearLease: true,
          clearLastError: true,
          metadata,
          expectedVersion: current.version,
        });
        await this.recordDurableTimelineEvent(runId, "run_woken", {
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
        run: await this.ctx.storage.durableRuns.getRun(runId),
        detail: error instanceof Error ? error.message : "Wake failed",
      };
    }
    await this.publishDurableRealtimeSafely(runId, {
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
  async resumeRunsWaitingForAutonomyKillSwitch(): Promise<{ woken: string[] }> {
    if (!(await this.ctx.isFeatureEnabled("durableKernelV1Enabled"))) {
      return { woken: [] };
    }
    const woken: string[] = [];
    for (const runId of await this.ctx.storage.durableRuns.listRunIdsByStatus("waiting")) {
      let run: DurableRunRecord;
      try {
        run = await this.ctx.storage.durableRuns.getRun(runId);
      } catch {
        // Run vanished between the id scan and the read — nothing to resume.
        continue;
      }
      const waitForEvent = (run.metadata as { waitForEvent?: { eventKey?: string } } | undefined)?.waitForEvent;
      if (waitForEvent?.eventKey !== AUTONOMY_KILL_SWITCH_RESUME_EVENT) {
        continue;
      }
      const result = await this.wakeDurableRun(runId, {
        eventKey: AUTONOMY_KILL_SWITCH_RESUME_EVENT,
        correlationId: runId,
      });
      if (result.outcome === "woke") {
        woken.push(runId);
      }
    }
    return { woken };
  }

  async recoverDurableDeadLetter(
    entryId: string,
    actorId = "operator",
    options?: { maxAttempts?: number },
  ): Promise<DurableRunRecord> {
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    assertNoRawRemoteApprovalBearer(actorId);
    const deadLetter = await this.ctx.storage.durableRuns.getDeadLetterById(entryId);
    if (deadLetter.resolvedAt) {
      throw new Error(`Durable dead letter ${entryId} is already resolved`);
    }
    const current = await this.ctx.storage.durableRuns.getRun(deadLetter.runId);
    if (current.status !== "dead_lettered") {
      throw new Error(`Durable run ${deadLetter.runId} cannot be recovered from ${current.status}`);
    }
    if (current.attemptCount >= 20) {
      throw new Error(`Durable run ${deadLetter.runId} exhausted the hard 20-attempt recovery ceiling`);
    }
    const recoverability = await this.deps?.workflowRegistry.isWorkflowRecoverable(current);
    if (recoverability && !recoverability.recoverable) {
      throw new Error(recoverability.reason ?? `Durable run ${deadLetter.runId} cannot be safely recovered.`);
    }
    const newMaxAttempts = options?.maxAttempts
      ? Math.min(20, Math.max(current.attemptCount + 1, Math.floor(options.maxAttempts)))
      : undefined;
    let next!: DurableRunRecord;
    const recoveredAt = new Date().toISOString();
    await this.ctx.storage.runImmediateTransaction(async () => {
      await this.ctx.storage.durableRuns.resolveDeadLetter(entryId, {
        resolvedAt: recoveredAt,
        resolutionNote: `recovered by ${actorId}${newMaxAttempts ? `, maxAttempts raised to ${newMaxAttempts}` : ""}`,
      });
      next = await this.ctx.storage.durableRuns.updateRun({
        runId: deadLetter.runId,
        status: "queued",
        updatedAt: recoveredAt,
        clearFinishedAt: true,
        clearLease: true,
        clearLastError: true,
        ...(newMaxAttempts ? { maxAttempts: newMaxAttempts } : {}),
        expectedVersion: current.version,
      });
      await this.recordDurableTimelineEvent(deadLetter.runId, "dead_letter_recovered", {
        actorId,
        deadLetterId: entryId,
        ...(newMaxAttempts ? { maxAttemptsOverride: newMaxAttempts } : {}),
      });
    });
    this.requestRunProcessing(deadLetter.runId);
    await this.publishDurableRealtimeSafely(deadLetter.runId, {
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

  private async publishRealtimeSafely(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<void> {
    try {
      await this.ctx.publishRealtime(eventType, source, redactRawRemoteApprovalBearers(payload), options);
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

  private async publishDurableRealtimeSafely(runId: string, payload: Record<string, unknown>): Promise<void> {
    await this.publishRealtimeSafely("system", "durable", payload, buildDurableRealtimeOptions(runId));
  }

  normalizeDurableRetryPolicy(input: Partial<DurableRetryPolicy> | undefined): DurableRetryPolicy {
    return normalizeDurableRetryPolicy(input);
  }

  private assertExactAdmittedChatRetryAuthority(run: DurableRunRecord): void {
    if (!isAdmittedV2ChatRun(run)) return;
    assertDurableRetryPolicyMatchesRun(run.metadata?.retryPolicy, run.maxAttempts, DURABLE_RETRY_POLICY_DEFAULT);
  }

  computeDurableRetryDelayMs(current: DurableRunRecord, attemptNo: number): number {
    this.assertExactAdmittedChatRetryAuthority(current);
    const metadataPolicy = (current.metadata as { retryPolicy?: Partial<DurableRetryPolicy> } | undefined)?.retryPolicy;
    const policy = this.normalizeDurableRetryPolicy(metadataPolicy);
    const raw = policy.baseDelayMs * policy.backoffMultiplier ** Math.max(0, attemptNo - 1);
    return Math.max(100, Math.min(policy.maxDelayMs, Math.floor(raw)));
  }

  async recordDurableTimelineEvent(
    runId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
    stepKey?: string,
  ): Promise<DurableRunTimelineEvent> {
    const event: Omit<DurableRunTimelineEvent, "sequence"> = {
      eventId: randomUUID(),
      runId,
      eventType,
      stepKey: stepKey?.trim() || undefined,
      payload: redactRawRemoteApprovalBearers(payload ?? {}),
      createdAt: new Date().toISOString(),
    };
    const appended = await this.ctx.storage.durableRunEvents.append(event);
    try {
      await this.ctx.storage.durableChildWatchers.catchUpAttachedByChild(runId, {
        watcherLimit: 100,
        eventLimitPerWatcher: 100,
      });
    } catch (error) {
      // Child state is canonical and must not be rolled back because an
      // observational projection is temporarily unavailable. Startup and the
      // normal durable maintenance loop resume from the persisted watermark.
      this.resolveLogger().warn(
        {
          runId,
          error: error instanceof Error ? error.message : String(error),
        },
        "durable child watcher projection deferred to reconciliation",
      );
    }
    return appended;
  }

  /**
   * Notification routing is external I/O and must only begin after the caller's
   * canonical durable transaction has committed. Call this from post-commit
   * transition seams, never from recordDurableTimelineEvent itself.
   */
  private scheduleCommittedBackgroundAttention(
    childRunId: string,
    eventType: DurableRunTimelineEvent["eventType"],
  ): void {
    if (!isBackgroundAttentionCandidateEvent(eventType) || !this.deps?.onBackgroundAttentionRequired) return;
    void this.notifyDetachedWatchersForChild(childRunId).catch((error) => {
      try {
        this.ctx.logger?.warn(
          {
            childRunId,
            eventType,
            error: error instanceof Error ? error.message : String(error),
          },
          "background attention notification scan failed after durable commit",
        );
      } catch {
        // Best-effort notification observability cannot take ownership of
        // durable state.
      }
    });
  }

  private async notifyDetachedWatchersForChild(childRunId: string): Promise<void> {
    if (!this.deps?.onBackgroundAttentionRequired) return;
    let afterParentRunId = "";
    while (true) {
      const rows = await this.ctx.storage.gatewaySql
        .prepare(
          `SELECT DISTINCT parent_run_id
           FROM durable_child_watchers
           WHERE child_run_id = ? AND state = 'detached' AND parent_run_id > ?
           ORDER BY parent_run_id ASC
           LIMIT ?`,
        )
        .all<{ parent_run_id: string }>(childRunId, afterParentRunId, DETACHED_WATCHER_NOTIFICATION_BATCH_SIZE);
      for (const row of rows) {
        try {
          const parent = await this.ctx.storage.durableRuns.getRun(row.parent_run_id);
          const sessionId = readBoundedPayloadId(parent.payload, "sessionId");
          if (!sessionId) continue;
          const session = await this.ctx.storage.chatSessionMeta.get(sessionId);
          if (!session) continue;
          await this.notifyBackgroundAttentionSafely(
            await projectDurableBackgroundTaskRail(this.ctx.storage, {
              parentRunId: parent.runId,
              workspaceId: session.workspaceId ?? "default",
              sessionId,
            }),
          );
        } catch {
          // Intentionally ignore projection or notification failure here; it
          // cannot affect the canonical child event.
        }
      }
      if (rows.length < DETACHED_WATCHER_NOTIFICATION_BATCH_SIZE) return;
      afterParentRunId = rows.at(-1)!.parent_run_id;
    }
  }

  private async recordDurableTimelineEventSafely(
    runId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
    stepKey?: string,
  ): Promise<void> {
    try {
      await this.recordDurableTimelineEvent(runId, eventType, payload, stepKey);
    } catch (error) {
      await this.reportDurableRunRecoveryFailure(runId, error);
    }
  }

  private async createDurableCheckpoint(input: {
    runId: string;
    checkpointKind: DurableCheckpointRecord["checkpointKind"];
    state?: Record<string, unknown>;
    createdAt?: string;
  }): Promise<DurableCheckpointRecord> {
    return this.ctx.storage.durableRuns.createCheckpoint({
      ...input,
      state: redactRawRemoteApprovalBearers(input.state ?? {}),
    });
  }

  private async reconcileRecoverableRuns(): Promise<number> {
    if (!this.deps) {
      return 0;
    }
    await this.reconcileDurableChildWatchers();
    const recoveryObservedAt = new Date().toISOString();
    let reclaimedCount = await this.reconcileExitedLocalProcessRuns(recoveryObservedAt);
    const runningRunIds = await this.ctx.storage.durableRuns.listExpiredRunningRunIds(recoveryObservedAt);
    for (const runId of runningRunIds) {
      try {
        const run = await this.ctx.storage.durableRuns.getRun(runId);
        if (run.status !== "running" || !run.leaseExpiresAt) {
          continue;
        }
        const recoverability = await this.deps.workflowRegistry.isWorkflowRecoverable(run);
        if (!recoverability.recoverable) {
          const reason = recoverability.reason ?? "Run could not be recovered after restart.";
          await this.transitionRunToPendingFinalization(run, reason, recoveryObservedAt, { kind: "expired" });
          continue;
        }
        let reclaimedByThisPass = false;
        let reclaimed!: DurableRunRecord;
        await this.ctx.storage.runImmediateTransaction(async () => {
          const current = await this.lockExpiredExecutionLeaseForRecovery(run);
          if (!current) {
            return;
          }
          await this.recordDurableTimelineEvent(current.runId, "run_lease_expired", {
            leaseOwnerId: current.leaseOwnerId,
            leaseExpiresAt: current.leaseExpiresAt,
          });
          reclaimed = await this.ctx.storage.durableRuns.updateRun({
            runId: current.runId,
            status: "queued",
            clearFinishedAt: true,
            clearLease: true,
            clearLastError: true,
            updatedAt: recoveryObservedAt,
            expectedVersion: current.version,
          });
          reclaimedByThisPass = true;
          await this.recordDurableTimelineEvent(reclaimed.runId, "run_reclaimed", {
            previousLeaseOwnerId: current.leaseOwnerId,
            previousLeaseExpiresAt: current.leaseExpiresAt,
          });
        });
        if (!reclaimedByThisPass) {
          continue;
        }
        reclaimedCount += 1;
      } catch (error) {
        await this.reportDurableRunRecoveryFailure(runId, error);
      }
    }
    await this.reconcilePendingLinkedFinalizations();
    await this.reconcilePendingAutonomousChatPostCommits();
    await this.reconcilePendingGeneralChatPostCommits();
    return reclaimedCount;
  }

  private async reconcileExitedLocalProcessRuns(recoveryObservedAt: string): Promise<number> {
    if (this.deps?.sharedHostLifecycle?.snapshot().mode !== "local_always_available") {
      return 0;
    }
    let reclaimedCount = 0;
    for (const runId of await this.ctx.storage.durableRuns.listRunIdsByStatus("running")) {
      try {
        const observed = await this.ctx.storage.durableRuns.getRun(runId);
        if (!this.isConfirmedExitedLocalProcessOwner(observed.leaseOwnerId)) {
          continue;
        }
        const recoverability = await this.deps.workflowRegistry.isWorkflowRecoverable(observed);
        if (!recoverability.recoverable) {
          await this.transitionRunToPendingFinalization(
            observed,
            recoverability.reason ?? "Run could not be recovered after its local worker process exited.",
            recoveryObservedAt,
            { kind: "exited_local_process", leaseOwnerId: observed.leaseOwnerId! },
          );
          continue;
        }
        let reclaimedByThisPass = false;
        await this.ctx.storage.runImmediateTransaction(async () => {
          const current = await this.lockFreshLeaseOwnerForTransition(observed.runId, observed.leaseOwnerId!);
          if (!current || !this.isConfirmedExitedLocalProcessOwner(current.leaseOwnerId)) {
            return;
          }
          await this.recordDurableTimelineEvent(current.runId, "run_incomplete_worker_exit", {
            leaseOwnerId: current.leaseOwnerId,
            leaseHeartbeatAt: current.leaseHeartbeatAt,
            leaseExpiresAt: current.leaseExpiresAt,
            recovery: "confirmed_dead_local_process",
          });
          const reclaimed = await this.ctx.storage.durableRuns.updateRun({
            runId: current.runId,
            status: "queued",
            clearFinishedAt: true,
            clearLease: true,
            clearLastError: true,
            updatedAt: recoveryObservedAt,
            expectedVersion: current.version,
          });
          reclaimedByThisPass = true;
          await this.recordDurableTimelineEvent(reclaimed.runId, "run_reclaimed", {
            previousLeaseOwnerId: current.leaseOwnerId,
            previousLeaseExpiresAt: current.leaseExpiresAt,
            recovery: "confirmed_dead_local_process",
          });
        });
        if (reclaimedByThisPass) {
          reclaimedCount += 1;
        }
      } catch (error) {
        await this.reportDurableRunRecoveryFailure(runId, error);
      }
    }
    return reclaimedCount;
  }

  private async reconcileDurableChildWatchers(): Promise<void> {
    try {
      await this.ctx.storage.durableChildWatchers.catchUpAttached({
        watcherLimit: 100,
        eventLimitPerWatcher: 100,
      });
    } catch (error) {
      this.resolveLogger().warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "durable child watcher reconciliation deferred",
      );
    }
  }

  private async transitionRunToPendingFinalization(
    observed: DurableRunRecord,
    reason: string,
    recoveryObservedAt: string,
    recovery: { kind: "expired" } | { kind: "exited_local_process"; leaseOwnerId: string },
  ): Promise<DurableRunRecord | undefined> {
    const safeReason = redactRawRemoteApprovalBearerText(reason);
    let transitioned = false;
    let failed = observed;
    await this.ctx.storage.runImmediateTransaction(async () => {
      const current =
        recovery.kind === "expired"
          ? await this.lockExpiredExecutionLeaseForRecovery(observed)
          : await this.lockFreshLeaseOwnerForTransition(observed.runId, recovery.leaseOwnerId);
      if (!current) {
        return;
      }
      if (recovery.kind === "exited_local_process") {
        if (!this.isConfirmedExitedLocalProcessOwner(current.leaseOwnerId)) {
          return;
        }
        await this.recordDurableTimelineEvent(current.runId, "run_incomplete_worker_exit", {
          leaseOwnerId: current.leaseOwnerId,
          leaseHeartbeatAt: current.leaseHeartbeatAt,
          leaseExpiresAt: current.leaseExpiresAt,
          recovery: "confirmed_dead_local_process",
        });
      } else {
        await this.recordDurableTimelineEvent(current.runId, "run_lease_expired", {
          leaseOwnerId: current.leaseOwnerId,
          leaseExpiresAt: current.leaseExpiresAt,
        });
      }
      this.assertExactAdmittedChatRetryAuthority(current);
      const priorMetadata = {
        ...(mergeCanonicalDurableChatTerminalOutputMetadata(current.metadata, undefined) ?? {}),
      };
      delete (priorMetadata as { linkedFinalizationPending?: unknown }).linkedFinalizationPending;
      const linkedFinalizationPending: LinkedFinalizationPending = {
        reason: safeReason,
        requestedAt: recoveryObservedAt,
        finalizationId: randomUUID(),
      };
      let metadata: Record<string, unknown> = {
        ...priorMetadata,
        linkedFinalizationPending,
      };
      let checkpointState: Record<string, unknown> = {
        workflowKey: current.workflowKey,
        error: safeReason,
      };
      const payload = current.payload as { version?: unknown; sessionId?: unknown; turnId?: unknown } | undefined;
      if (
        current.workflowKey === "chat.turn.execute" &&
        payload?.version === "chat.turn.execute.v2" &&
        typeof payload.sessionId === "string" &&
        payload.sessionId.trim() &&
        typeof payload.turnId === "string" &&
        payload.turnId.trim()
      ) {
        if (priorMetadata[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY] !== undefined) {
          throw new Error(`Running admitted Chat run ${current.runId} carries conflicting runtime authority.`);
        }
        delete (metadata as { waitForEvent?: unknown }).waitForEvent;
        const generationId = randomUUID();
        const postCommitEligibility = await this.resolvePostCommitEligibility(payload.sessionId);
        metadata = markGeneralChatPostCommitPending(
          metadata,
          recoveryObservedAt,
          "failed",
          postCommitEligibility,
          generationId,
        );
        await this.requireExactParentTurnAdmission(current);
        if (metadata.autonomousAdmission !== undefined) await this.verifyCanonicalAutonomousChatAdmission(current);
        const authority = buildChatTurnRuntimeAuthoritySeal({
          runId: current.runId,
          turnId: payload.turnId,
          transitionKind: "linked_finalization",
          durableStatus: "failed",
          traceStatus: "failed",
          transitionAt: recoveryObservedAt,
          postCommitGenerationId: generationId,
          postCommitEligibility,
          linkedFinalization: {
            finalizationId: linkedFinalizationPending.finalizationId,
            requestedAt: linkedFinalizationPending.requestedAt,
            reason: linkedFinalizationPending.reason,
          },
          requiredFinalizers: ["linked", "general"],
        });
        metadata = withChatTurnRuntimeAuthority(metadata, authority);
        checkpointState = withChatTurnRuntimeAuthorityCheckpoint(checkpointState, authority);
      }
      failed = await this.persistFailedRunInTransaction(
        current,
        safeReason,
        recoveryObservedAt,
        metadata,
        checkpointState,
      );
      transitioned = true;
    });
    if (!transitioned) {
      return undefined;
    }
    this.scheduleCommittedBackgroundAttention(failed.runId, "run_failed");
    await this.publishDurableRealtimeSafely(failed.runId, {
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
      const runIds = await this.ctx.storage.durableRuns.listPendingLinkedFinalizationRunIds(batchSize, afterRunId);
      for (const runId of runIds) {
        try {
          const run = await this.ctx.storage.durableRuns.getRun(runId);
          if (readLinkedFinalizationPending(run)) {
            await this.finalizePendingLinkedState(run);
          }
        } catch (error) {
          await this.reportDurableRunRecoveryFailure(runId, error);
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
      const runIds = await this.ctx.storage.durableRuns.listPendingAutonomousChatPostCommitRunIds(
        batchSize,
        afterRunId,
      );
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
      const runIds =
        (await this.ctx.storage.durableRuns.listPendingGeneralChatPostCommitRunIds?.(batchSize, afterRunId)) ?? [];
      let nextIndex = 0;
      const reconcileNext = async () => {
        while (nextIndex < runIds.length) {
          const runId = runIds[nextIndex++];
          if (!runId) continue;
          try {
            await settleTerminalChatReconciliationBeforeDeadline(
              this.reconcileGeneralChatPostCommit(runId),
              Date.now() + GENERAL_CHAT_POST_COMMIT_IN_FLIGHT_TTL_MS,
            );
          } catch (error) {
            await this.reportDurableRunRecoveryFailure(runId, error);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(GENERAL_CHAT_POST_COMMIT_SWEEP_CONCURRENCY, runIds.length) }, () =>
          reconcileNext(),
        ),
      );
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
    const observedPending = readLinkedFinalizationPending(run);
    if (!observedPending) {
      return;
    }
    await this.verifyLinkedFinalizationAuthority(run, observedPending);
    const claim = await this.claimPendingLinkedFinalization(run);
    if (!claim) {
      return;
    }
    await this.verifyLinkedFinalizationAuthority(claim.run, claim.pending);
    const finalizationAbort = new AbortController();
    const claimHeartbeat = setInterval(
      () => {
        void (async () => {
          try {
            if (!(await this.renewPendingLinkedFinalizationClaim(claim.run.runId, claim.pending))) {
              finalizationAbort.abort(
                new DurableWorkerInterruptionError(
                  "lease_lost",
                  `Durable linked finalization ${claim.pending.finalizationId} lost claim ownership.`,
                ),
              );
            }
          } catch (error) {
            await this.reportDurableRunRecoveryFailure(claim.run.runId, error);
            finalizationAbort.abort(error);
          }
        })().catch((error) => finalizationAbort.abort(error));
      },
      Math.floor(LINKED_FINALIZATION_CLAIM_TTL_MS / 3),
    );
    claimHeartbeat.unref?.();
    const finalizationTimeout = setTimeout(() => {
      finalizationAbort.abort(new DurableWorkflowTimeoutError(claim.run.runId, LINKED_FINALIZATION_TIMEOUT_MS));
    }, LINKED_FINALIZATION_TIMEOUT_MS);
    finalizationTimeout.unref?.();
    let rejectOnAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => {
        const reason = finalizationAbort.signal.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason ?? "linked finalization aborted")));
      };
      finalizationAbort.signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    try {
      await Promise.race([
        this.deps.workflowRegistry.markWorkflowUnrecoverable(claim.run, claim.pending.reason, {
          finalizationId: claim.pending.finalizationId,
          signal: finalizationAbort.signal,
        }),
        aborted,
      ]);
    } finally {
      clearInterval(claimHeartbeat);
      clearTimeout(finalizationTimeout);
      if (rejectOnAbort) {
        finalizationAbort.signal.removeEventListener("abort", rejectOnAbort);
      }
    }
    if (finalizationAbort.signal.aborted) {
      return;
    }
    const cleared = await this.retryDurableRunUpdate(run.runId, async (current) => {
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
      const completedAt = new Date().toISOString();
      const settlement = {
        version: 1 as const,
        finalizationId: currentPending.finalizationId,
        requestedAt: currentPending.requestedAt,
        reasonSha256: hashChatTurnRuntimeAuthorityValue(currentPending.reason),
        completedAt,
      };
      readExactLinkedFinalizationSettlement(settlement);
      const authority = readChatTurnRuntimeAuthoritySeal(metadata[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY]);
      if (authority) {
        if (
          authority.material.transitionKind !== "linked_finalization" ||
          authority.material.linkedFinalization?.finalizationId !== currentPending.finalizationId ||
          authority.material.linkedFinalization.requestedAt !== currentPending.requestedAt ||
          authority.material.linkedFinalization.reasonSha256 !== settlement.reasonSha256
        ) {
          throw new Error(`Durable linked finalization ${current.runId} conflicts with its runtime authority.`);
        }
      }
      metadata.linkedFinalization = settlement;
      return this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: current.status,
        metadata,
        updatedAt: completedAt,
        expectedVersion: current.version,
      });
    });
    if (!readLinkedFinalizationPending(cleared)) {
      if (!hasAutonomousChatPostCommitPending(cleared) && !hasGeneralChatPostCommitPending(cleared)) {
        await this.closeTerminalChatTurnAdmissionIfReady(cleared);
      }
    }
  }

  private async verifyLinkedFinalizationAuthority(
    run: DurableRunRecord,
    pending: LinkedFinalizationPending,
  ): Promise<void> {
    const payload = run.payload as { version?: unknown; turnId?: unknown } | undefined;
    const authorityValue = run.metadata?.[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY];
    if (run.workflowKey !== "chat.turn.execute" || payload?.version !== "chat.turn.execute.v2") {
      if (authorityValue !== undefined) {
        throw new Error(`Durable linked finalization ${run.runId} carries unauthorized runtime authority.`);
      }
      return;
    }
    await this.requireExactParentTurnAdmission(run, { requireActive: false });
    if (run.metadata?.autonomousAdmission !== undefined) await this.verifyCanonicalAutonomousChatAdmission(run);
    assertDurableRetryPolicyMatchesRun(run.metadata?.retryPolicy, run.maxAttempts, DURABLE_RETRY_POLICY_DEFAULT);
    const authority = readChatTurnRuntimeAuthoritySeal(authorityValue);
    if (
      !authority ||
      authority.material.transitionKind !== "linked_finalization" ||
      authority.material.durableStatus !== "failed" ||
      authority.material.traceStatus !== "failed" ||
      authority.material.runId !== run.runId ||
      authority.material.turnId !== payload.turnId ||
      authority.material.linkedFinalization?.finalizationId !== pending.finalizationId ||
      authority.material.linkedFinalization.requestedAt !== pending.requestedAt ||
      authority.material.linkedFinalization.reasonSha256 !== hashChatTurnRuntimeAuthorityValue(pending.reason)
    ) {
      throw new Error(`Durable linked finalization ${run.runId} has no exact runtime authority.`);
    }
    const generalPending = readGeneralChatPostCommitPendingMarker(run);
    if (
      !generalPending ||
      generalPending.generationId !== authority.material.postCommitGenerationId ||
      generalPending.traceStatus !== authority.material.traceStatus ||
      generalPending.requestedAt !== authority.material.transitionAt ||
      canonicalJsonString(generalPending.postCommitEligibility) !==
        canonicalJsonString(authority.material.postCommitEligibility)
    ) {
      throw new Error(`Durable linked finalization ${run.runId} has no matching general generation.`);
    }
    const checkpoint = await this.ctx.storage.durableRuns.getLatestCheckpointByKind(run.runId, "run_failed");
    if (!checkpoint) {
      throw new Error(`Durable linked finalization ${run.runId} has no authority-anchored failure checkpoint.`);
    }
    verifyCheckpointAnchoredChatTurnRuntimeAuthority(run.metadata, checkpoint.state);
  }

  private async claimPendingLinkedFinalization(
    observed: DurableRunRecord,
  ): Promise<{ run: DurableRunRecord; pending: LinkedFinalizationPending } | undefined> {
    const observedPending = readLinkedFinalizationPending(observed);
    if (!observedPending) {
      return undefined;
    }
    const claimId = randomUUID();
    let claim: { run: DurableRunRecord; pending: LinkedFinalizationPending } | undefined;
    await this.retryDurableRunUpdate(observed.runId, async (current) => {
      claim = undefined;
      const pending = readLinkedFinalizationPending(current);
      if (current.status !== "failed" || !pending || pending.finalizationId !== observedPending.finalizationId) {
        return current;
      }
      const claimedAt = await this.readDurableDatabaseNow();
      const claimedAtMs = Date.parse(claimedAt);
      const activeClaimExpiresAt = pending.claimExpiresAt ? Date.parse(pending.claimExpiresAt) : Number.NaN;
      if (pending.claimId && Number.isFinite(activeClaimExpiresAt) && activeClaimExpiresAt > claimedAtMs) {
        return current;
      }
      const claimedPending: LinkedFinalizationPending = {
        ...pending,
        claimId,
        claimExpiresAt: new Date(claimedAtMs + LINKED_FINALIZATION_CLAIM_TTL_MS).toISOString(),
      };
      const metadata = {
        ...(current.metadata ?? {}),
        linkedFinalizationPending: claimedPending,
      };
      const claimedRun = await this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: current.status,
        metadata,
        updatedAt: claimedAt,
        expectedVersion: current.version,
      });
      claim = { run: claimedRun, pending: claimedPending };
      return claimedRun;
    });
    return claim;
  }

  private async renewPendingLinkedFinalizationClaim(
    runId: string,
    claimed: LinkedFinalizationPending,
  ): Promise<boolean> {
    let renewed = false;
    await this.retryDurableRunUpdate(runId, async (current) => {
      const pending = readLinkedFinalizationPending(current);
      if (
        current.status !== "failed" ||
        !pending ||
        pending.finalizationId !== claimed.finalizationId ||
        pending.claimId !== claimed.claimId
      ) {
        return current;
      }
      const now = await this.readDurableDatabaseNow();
      const nowMs = Date.parse(now);
      const next = await this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: current.status,
        metadata: {
          ...(current.metadata ?? {}),
          linkedFinalizationPending: {
            ...pending,
            claimExpiresAt: new Date(nowMs + LINKED_FINALIZATION_CLAIM_TTL_MS).toISOString(),
          },
        },
        updatedAt: now,
        expectedVersion: current.version,
      });
      renewed = true;
      return next;
    });
    return renewed;
  }

  private async reportDurableRunRecoveryFailure(runId: string, error: unknown): Promise<void> {
    const message = redactRawRemoteApprovalBearerText(error instanceof Error ? error.message : String(error));
    const publishFailure = async () => {
      await this.publishRealtimeSafely(
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
      await publishFailure();
      return;
    }
    await publishFailure();
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
      const run = await this.claimNextQueuedRun();
      if (!run) {
        return;
      }
      let preserveForLeaseRecovery = false;
      try {
        const gateDecision = await deps.evaluateContinuationGate?.(run);
        if (gateDecision && gateDecision.decision !== "continue") {
          if (await this.recordContinuationGateDecision(run, gateDecision, deps)) {
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
        const current = await this.ctx.storage.durableRuns.getRun(run.runId);
        if (!preserveForLeaseRecovery && current.status === "running" && current.leaseOwnerId === run.leaseOwnerId) {
          const incompleteMessage = "Durable workflow exited without marking a terminal or waiting state.";
          const failedByThisPass = await this.failWorkflowRun(current, incompleteMessage);
          if (failedByThisPass) {
            await this.recordDurableTimelineEventSafely(current.runId, "run_incomplete_worker_exit", {
              leaseOwnerId: current.leaseOwnerId,
              leaseExpiresAt: current.leaseExpiresAt,
            });
            const taskId = typeof current.payload?.taskId === "string" ? current.payload.taskId : undefined;
            if (taskId && this.deps?.taskLifecycle) {
              try {
                await this.deps.taskLifecycle.autoBlockOnIncompleteExit(taskId, current.runId);
              } catch (error) {
                await this.publishDurableRealtimeSafely(current.runId, {
                  kind: "task_auto_block_failed",
                  runId: current.runId,
                  taskId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
        }
        const finalized = await this.ctx.storage.durableRuns.getRun(run.runId);
        if (
          !preserveForLeaseRecovery &&
          isRepresentableTerminalChatRun(finalized) &&
          isExactChatRunProjection(finalized, {
            expectedSessionId: String(finalized.payload?.sessionId ?? ""),
            expectedTurnId: String(finalized.payload?.turnId ?? ""),
          })
        ) {
          // The persisted terminal stream event can be observed before the
          // workflow handler returns. Start canonical post-commit settlement in
          // this same worker pass so admission release is not deferred until a
          // later poll/restart recovery sweep.
          try {
            await settleTerminalChatReconciliationBeforeDeadline(
              this.reconcileGeneralChatPostCommit(finalized.runId),
              Date.now() + TERMINAL_CHAT_ADMISSION_RECOVERY_TIMEOUT_MS,
            );
          } catch (error) {
            // Terminal reconciliation is owned by this run and remains
            // recoverable on a later sweep. One corrupt/incomplete run must not
            // abort the shared drain before unrelated queued work can execute.
            await this.reportDurableRunRecoveryFailure(finalized.runId, error);
          }
        }
      }
    }
  }

  private async recordContinuationGateDecision(
    run: DurableRunRecord,
    gateDecision: ContinuationGateDecision,
    deps: NonNullable<typeof this.deps>,
  ): Promise<boolean> {
    const shouldBlock = this.shouldBlockContinuationGateDecision(gateDecision);
    const now = new Date().toISOString();
    const blockedStatus = gateDecision.decision === "stop" ? "cancelled" : "paused";
    const blockedEventType = blockedStatus === "cancelled" ? "run_cancelled" : "run_paused";
    await this.ctx.storage.runImmediateTransaction(async () => {
      const current = await this.lockFreshExecutionLeaseForTransition(run);
      if (!current) {
        throw new DurableWorkerInterruptionError(
          "lease_lost",
          `Durable run ${run.runId} lease ownership moved before its continuation gate could commit.`,
        );
      }
      await this.createDurableCheckpoint({
        runId: run.runId,
        checkpointKind: "continuation_gate",
        state: { continuationGate: gateDecision },
        createdAt: gateDecision.createdAt,
      });
      await this.recordDurableTimelineEvent(run.runId, "continuation_gate", {
        decision: gateDecision.decision,
        reasonCodes: gateDecision.reasonCodes,
        recommendedAction: gateDecision.recommendedAction,
      });
      if (shouldBlock) {
        await this.ctx.storage.durableRuns.updateRun({
          runId: run.runId,
          status: blockedStatus,
          updatedAt: now,
          ...(blockedStatus === "cancelled" ? { finishedAt: now } : { clearFinishedAt: true }),
          clearLease: true,
          clearLastError: true,
          expectedVersion: current.version,
        });
        await this.recordDurableTimelineEvent(run.runId, blockedEventType, {
          actorId: "continuation_gate",
          previousStatus: run.status,
          decision: gateDecision.decision,
          reasonCodes: gateDecision.reasonCodes,
        });
      }
    });
    if (shouldBlock) {
      this.scheduleCommittedBackgroundAttention(run.runId, blockedEventType);
    }
    await this.publishDurableRealtimeSafely(run.runId, {
      type: "durable_continuation_gate",
      runId: run.runId,
      decision: gateDecision.decision,
      reasonCodes: gateDecision.reasonCodes,
      recommendedAction: gateDecision.recommendedAction,
    });
    try {
      await deps.recordEvidenceEnvelope?.({
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
      await this.publishDurableRealtimeSafely(run.runId, {
        type: "durable_continuation_gate_evidence_failed",
        runId: run.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (shouldBlock) {
      await this.publishDurableRealtimeSafely(run.runId, {
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
    let waiting = await this.ctx.storage.durableRuns.getRun(run.runId);
    await this.ctx.storage.runImmediateTransaction(async () => {
      const current = await this.lockFreshExecutionLeaseForTransition(run);
      if (!current) {
        return;
      }
      waiting = await this.ctx.storage.durableRuns.updateRun({
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
      await this.createDurableCheckpoint({
        runId: waiting.runId,
        checkpointKind: "run_waiting",
        state: checkpointState,
        createdAt: now,
      });
      await this.recordDurableTimelineEvent(waiting.runId, "run_waiting", checkpointState);
    });
    if (waiting.status !== "waiting") {
      return;
    }
    this.scheduleCommittedBackgroundAttention(waiting.runId, "run_waiting");
    await this.publishDurableRealtimeSafely(waiting.runId, {
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
    let waiting = await this.ctx.storage.durableRuns.getRun(run.runId);
    await this.ctx.storage.runImmediateTransaction(async () => {
      const current = await this.lockFreshExecutionLeaseForTransition(run);
      if (!current) {
        return;
      }
      waiting = await this.ctx.storage.durableRuns.updateRun({
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
      await this.createDurableCheckpoint({
        runId: waiting.runId,
        checkpointKind: "run_waiting",
        state: checkpointState,
        createdAt: now,
      });
      await this.recordDurableTimelineEvent(waiting.runId, "run_waiting", checkpointState);
    });
    if (waiting.status !== "waiting") {
      return;
    }
    this.scheduleCommittedBackgroundAttention(waiting.runId, "run_waiting");
    await this.publishDurableRealtimeSafely(waiting.runId, {
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

  private async revokeActiveExecutionLease(runId: string, expectedLeaseOwnerId: string): Promise<void> {
    try {
      await this.retryDurableRunUpdate(runId, async (current) => {
        if (current.status !== "running" || current.leaseOwnerId !== expectedLeaseOwnerId) {
          return current;
        }
        return this.ctx.storage.durableRuns.updateRun({
          runId,
          status: current.status,
          leaseOwnerId: buildDurableLocalProcessLeaseOwnerId(),
          leaseHeartbeatAt: current.leaseHeartbeatAt,
          leaseExpiresAt: current.leaseExpiresAt,
          updatedAt: new Date().toISOString(),
          expectedVersion: current.version,
        });
      });
    } catch (error) {
      await this.reportDurableRunRecoveryFailure(runId, error);
    }
  }

  private async executeWithLeaseHeartbeat<T>(
    run: DurableRunRecord,
    execute: (context: { signal: AbortSignal; controller: AbortController }) => Promise<T>,
  ): Promise<T> {
    const owned = await this.ctx.storage.durableRuns.getRun(run.runId);
    if (owned.status !== "running" || owned.leaseOwnerId !== run.leaseOwnerId || this.workerStopped) {
      throw new DurableWorkerInterruptionError(
        this.workerStopped ? "worker_stopped" : "lease_lost",
        `Durable run ${run.runId} lease ownership was lost before workflow execution.`,
      );
    }
    const renewedBeforeExecution = await this.renewLeaseWithDatabaseClock({
      runId: run.runId,
      workerId: run.leaseOwnerId!,
      leaseDurationMs: DURABLE_LEASE_TTL_MS,
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
      await this.recordEventLoopLag(Date.now() - expectedAtMs, run.runId);
      let current: DurableRunRecord;
      try {
        current = await this.ctx.storage.durableRuns.getRun(run.runId);
      } catch (error) {
        consecutiveHeartbeatFailures += 1;
        if (!heartbeatToleranceExhausted()) {
          scheduleHeartbeat();
          return;
        }
        active = false;
        await this.revokeActiveExecutionLease(run.runId, run.leaseOwnerId!);
        const interruption = new DurableWorkerInterruptionError(
          "heartbeat_unavailable",
          error instanceof Error ? error.message : String(error),
        );
        controller.abort(interruption);
        rejectHeartbeatFailure(interruption);
        return;
      }
      if (current.status !== "running" || current.leaseOwnerId !== run.leaseOwnerId) {
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
        const renewed = await this.renewLeaseWithDatabaseClock({
          runId: run.runId,
          workerId: run.leaseOwnerId!,
          leaseDurationMs: DURABLE_LEASE_TTL_MS,
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
        await this.revokeActiveExecutionLease(run.runId, run.leaseOwnerId!);
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

  private async recordEventLoopLag(lagMs: number, runId: string): Promise<void> {
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
    await this.recordDurableTimelineEventSafely(runId, "worker_event_loop_lag", {
      lagMs: boundedLagMs,
      thresholdMs: DURABLE_EVENT_LOOP_LAG_WARN_MS,
      leaseAcquisitionPausedUntil:
        this.leaseAcquisitionPausedUntilMs > Date.now()
          ? new Date(this.leaseAcquisitionPausedUntilMs).toISOString()
          : undefined,
    });
    await this.publishDurableRealtimeSafely(runId, {
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

  private async claimNextQueuedRun(): Promise<DurableRunRecord | undefined> {
    const queuedRunIds = await this.ctx.storage.durableRuns.listRunIdsByStatus("queued");
    if (queuedRunIds.length === 0) {
      return undefined;
    }
    let run: DurableRunRecord | undefined;
    for (const runId of queuedRunIds) {
      if (await this.terminalizeQueuedLegacyUnadmittedChatTurn(runId)) {
        continue;
      }
      try {
        this.assertExactAdmittedChatRetryAuthority(await this.ctx.storage.durableRuns.getRun(runId));
      } catch (error) {
        await this.reportDurableRunRecoveryFailure(runId, error);
        continue;
      }
      const leaseOwnerId = buildDurableLocalProcessLeaseOwnerId();
      await this.ctx.storage.runImmediateTransaction(async () => {
        run = await this.tryClaimQueuedRunWithDatabaseClock({
          runId,
          workerId: leaseOwnerId,
          leaseDurationMs: DURABLE_LEASE_TTL_MS,
        });
        if (!run) {
          return;
        }
        await this.createDurableCheckpoint({
          runId: run.runId,
          checkpointKind: "run_started",
          state: {
            workflowKey: run.workflowKey,
            status: run.status,
          },
          createdAt: run.leaseHeartbeatAt ?? run.updatedAt,
        });
        await this.recordDurableTimelineEvent(run.runId, "run_started", {
          workflowKey: run.workflowKey,
          status: run.status,
        });
      });
      if (run) {
        break;
      }
    }
    if (!run) {
      return undefined;
    }
    await this.publishDurableRealtimeSafely(run.runId, {
      type: "durable_run_started",
      runId: run.runId,
      workflowKey: run.workflowKey,
    });
    return run;
  }

  /**
   * v1 Chat payloads predate immutable session-incarnation admission. They are
   * quarantined before lease acquisition, so they cannot execute and do not
   * consume a retry attempt merely to discover that authority is absent.
   */
  private async terminalizeQueuedLegacyUnadmittedChatTurn(runId: string): Promise<boolean> {
    const observed = await this.ctx.storage.durableRuns.getRun(runId);
    if (observed.status !== "queued" || !isLegacyUnadmittedDurableChatTurn(observed)) {
      return false;
    }
    const reason =
      "Legacy durable Chat run lacks immutable session-incarnation admission and requires manual reconciliation.";
    let failed: DurableRunRecord | undefined;
    await this.ctx.storage.runImmediateTransaction(async () => {
      const current = await this.ctx.storage.durableRuns.getRun(runId);
      if (current.status !== "queued" || !isLegacyUnadmittedDurableChatTurn(current)) {
        return;
      }
      const now = await this.readDurableDatabaseNow();
      const metadata = { ...(current.metadata ?? {}) };
      delete (metadata as { linkedFinalizationPending?: unknown }).linkedFinalizationPending;
      failed = await this.persistFailedRunInTransaction(current, reason, now, {
        ...metadata,
        linkedFinalizationPending: {
          reason,
          requestedAt: now,
          finalizationId: randomUUID(),
        },
      });
    });
    if (!failed) {
      return false;
    }
    this.scheduleCommittedBackgroundAttention(failed.runId, "run_failed");
    await this.publishDurableRealtimeSafely(failed.runId, {
      type: "durable_run_failed",
      runId: failed.runId,
      error: reason,
    });
    void this.notifyRunFailedSafely(failed, reason).catch(() => undefined);
    this.requestRunProcessing(failed.runId);
    return true;
  }

  private async tryClaimQueuedRunWithDatabaseClock(input: {
    runId: string;
    workerId: string;
    leaseDurationMs: number;
  }): Promise<DurableRunRecord | undefined> {
    const durableRuns = this.ctx.storage.durableRuns;
    const claim = durableRuns.tryClaimQueuedRunWithDatabaseClock;
    if (typeof claim === "function") {
      return claim.call(durableRuns, input);
    }
    if (process.env.NODE_ENV === "test") {
      const leaseHeartbeatAt = new Date().toISOString();
      return durableRuns.tryClaimQueuedRun({
        runId: input.runId,
        workerId: input.workerId,
        leaseHeartbeatAt,
        leaseExpiresAt: new Date(Date.now() + input.leaseDurationMs).toISOString(),
        updatedAt: leaseHeartbeatAt,
      });
    }
    throw new Error("Durable run repository is missing database-clock lease claim authority");
  }

  private async renewLeaseWithDatabaseClock(input: {
    runId: string;
    workerId: string;
    leaseDurationMs: number;
  }): Promise<DurableRunRecord | undefined> {
    const durableRuns = this.ctx.storage.durableRuns;
    const renew = durableRuns.renewLeaseWithDatabaseClock;
    if (typeof renew === "function") {
      return renew.call(durableRuns, input);
    }
    if (process.env.NODE_ENV === "test") {
      const leaseHeartbeatAt = new Date().toISOString();
      return durableRuns.renewLease({
        runId: input.runId,
        workerId: input.workerId,
        leaseHeartbeatAt,
        leaseExpiresAt: new Date(Date.now() + input.leaseDurationMs).toISOString(),
        updatedAt: leaseHeartbeatAt,
      });
    }
    throw new Error("Durable run repository is missing database-clock lease renewal authority");
  }

  private async upsertRetryWithDatabaseClock(input: {
    runId: string;
    attemptNo: number;
    reason: string;
    delayMs: number;
  }): Promise<DurableRetryRecord> {
    const durableRuns = this.ctx.storage.durableRuns;
    const upsert = durableRuns.upsertRetryWithDatabaseClock;
    if (typeof upsert === "function") {
      return upsert.call(durableRuns, input);
    }
    if (process.env.NODE_ENV === "test") {
      const createdAt = new Date().toISOString();
      return durableRuns.upsertRetry({
        runId: input.runId,
        attemptNo: input.attemptNo,
        reason: input.reason,
        createdAt,
        nextRetryAt: new Date(Date.now() + input.delayMs).toISOString(),
      });
    }
    throw new Error("Durable run repository is missing database-clock retry scheduling authority");
  }

  private async readDurableDatabaseNow(): Promise<string> {
    const durableRuns = this.ctx.storage.durableRuns;
    const read = durableRuns.readDatabaseNow;
    if (typeof read === "function") {
      return read.call(durableRuns);
    }
    if (process.env.NODE_ENV === "test") {
      return new Date().toISOString();
    }
    throw new Error("Durable run repository is missing database-clock recovery claim authority");
  }

  private async persistCanonicalAdmittedChatFailureInTransaction(
    current: DurableRunRecord,
    message: string,
    now: string,
    options: {
      attemptCount?: number;
      retryExhaustion?: ChatRetryExhaustionDeadLetterPending;
    } = {},
  ): Promise<DurableRunRecord> {
    if (!isAdmittedV2ChatRun(current)) {
      throw new Error(`Durable run ${current.runId} is not an admitted v2 Chat turn.`);
    }
    this.assertExactAdmittedChatRetryAuthority(current);
    const payload = current.payload as {
      sessionId?: unknown;
      turnId?: unknown;
      heartbeatOccurrenceId?: unknown;
      heartbeatClaimSha256?: unknown;
      heartbeatEvaluatedPolicySha256?: unknown;
      heartbeatFrozenObjectiveSha256?: unknown;
      requestActor?: unknown;
    };
    if (
      typeof payload.sessionId !== "string" ||
      !payload.sessionId.trim() ||
      typeof payload.turnId !== "string" ||
      !payload.turnId.trim()
    ) {
      throw new Error(`Durable Chat run ${current.runId} has no canonical failure identity.`);
    }
    await this.requireExactParentTurnAdmission(current);
    const currentMetadata = current.metadata ?? {};
    if (
      currentMetadata[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY] !== undefined ||
      currentMetadata[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined ||
      currentMetadata[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined ||
      currentMetadata.linkedFinalizationPending !== undefined ||
      currentMetadata.chatTurnAdmissionHandoff !== undefined ||
      currentMetadata[CHAT_RETRY_EXHAUSTION_DEAD_LETTER_PENDING_METADATA_KEY] !== undefined
    ) {
      throw new Error(`Durable Chat run ${current.runId} carries conflicting terminal authority evidence.`);
    }
    const generationId = randomUUID();
    const heartbeatPayload = readExactSystemHeartbeatFailurePayload(current, payload);
    const postCommitEligibility = heartbeatPayload
      ? {
          version: 1 as const,
          autonomyEnabledAtParentSettlement: false,
          evalIntegrityTurn: false,
          humanSession: false,
        }
      : await this.resolvePostCommitEligibility(payload.sessionId);
    const linkedFinalizationPending: LinkedFinalizationPending = {
      reason: message,
      requestedAt: now,
      finalizationId: randomUUID(),
    };
    let metadata = markGeneralChatPostCommitPending(
      mergeCanonicalDurableChatTerminalOutputMetadata(currentMetadata, undefined),
      now,
      "failed",
      postCommitEligibility,
      generationId,
    );
    delete metadata.waitForEvent;
    metadata.linkedFinalizationPending = linkedFinalizationPending;
    if (options.retryExhaustion) {
      readChatRetryExhaustionDeadLetterPending(options.retryExhaustion);
      metadata[CHAT_RETRY_EXHAUSTION_DEAD_LETTER_PENDING_METADATA_KEY] = options.retryExhaustion;
    }
    const authority = buildChatTurnRuntimeAuthoritySeal({
      runId: current.runId,
      turnId: payload.turnId,
      transitionKind: "linked_finalization",
      durableStatus: "failed",
      traceStatus: "failed",
      transitionAt: now,
      postCommitGenerationId: generationId,
      postCommitEligibility,
      linkedFinalization: {
        finalizationId: linkedFinalizationPending.finalizationId,
        requestedAt: linkedFinalizationPending.requestedAt,
        reason: linkedFinalizationPending.reason,
      },
      requiredFinalizers: ["linked", "general"],
    });
    metadata = withChatTurnRuntimeAuthority(metadata, authority);
    const checkpointState = withChatTurnRuntimeAuthorityCheckpoint(
      { workflowKey: current.workflowKey, error: message },
      authority,
    );
    return this.persistFailedRunInTransaction(current, message, now, metadata, checkpointState, {
      attemptCount: options.attemptCount,
    });
  }

  private async failWorkflowRun(run: DurableRunRecord, message: string): Promise<boolean> {
    const now = new Date().toISOString();
    const safeMessage = redactRawRemoteApprovalBearerText(message);
    let transitioned = false;
    let failed = await this.ctx.storage.durableRuns.getRun(run.runId);
    await this.ctx.storage.runImmediateTransaction(async () => {
      const current = await this.lockFreshExecutionLeaseForTransition(run);
      if (!current) {
        return;
      }
      failed = isAdmittedV2ChatRun(current)
        ? await this.persistCanonicalAdmittedChatFailureInTransaction(current, safeMessage, now)
        : await this.persistFailedRunInTransaction(current, safeMessage, now);
      transitioned = true;
    });
    if (!transitioned) {
      if (failed.leaseOwnerId !== run.leaseOwnerId) {
        await this.publishRealtimeSafely(
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
    this.scheduleCommittedBackgroundAttention(failed.runId, "run_failed");
    await this.publishDurableRealtimeSafely(failed.runId, {
      type: "durable_run_failed",
      runId: failed.runId,
      error: safeMessage,
    });
    await this.notifyRunFailedSafely(failed, safeMessage);
    if (isAdmittedV2ChatRun(failed)) this.requestRunProcessing(failed.runId);
    return true;
  }

  private async notifyRunFailedSafely(run: DurableRunRecord, message: string): Promise<void> {
    try {
      await this.deps?.onRunFailed?.(run, message);
    } catch (error) {
      await this.reportDurableRunRecoveryFailure(run.runId, error);
    }
  }

  private async persistFailedRunInTransaction(
    current: DurableRunRecord,
    message: string,
    now: string,
    metadata: Record<string, unknown> | undefined = current.metadata,
    checkpointState: Record<string, unknown> = {
      workflowKey: current.workflowKey,
      error: message,
    },
    options: { attemptCount?: number } = {},
  ): Promise<DurableRunRecord> {
    const next = await this.ctx.storage.durableRuns.updateRun({
      runId: current.runId,
      status: "failed",
      finishedAt: now,
      clearLease: true,
      lastError: message,
      ...(options.attemptCount === undefined ? {} : { attemptCount: options.attemptCount }),
      metadata,
      updatedAt: now,
      expectedVersion: current.version,
    });
    await this.createDurableCheckpoint({
      runId: next.runId,
      checkpointKind: "run_failed",
      state: checkpointState,
      createdAt: now,
    });
    await this.recordDurableTimelineEvent(next.runId, "run_failed", {
      workflowKey: next.workflowKey,
      error: message,
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

  private async lockFreshExecutionLeaseForTransition(run: DurableRunRecord): Promise<DurableRunRecord | undefined> {
    const expectedLeaseOwnerId = run.leaseOwnerId?.trim();
    if (!expectedLeaseOwnerId) {
      return undefined;
    }
    return this.lockFreshLeaseOwnerForTransition(run.runId, expectedLeaseOwnerId);
  }

  private async lockFreshLeaseOwnerForTransition(
    runId: string,
    expectedLeaseOwnerId: string,
  ): Promise<DurableRunRecord | undefined> {
    const durableRuns = this.ctx.storage.durableRuns;
    const lock = durableRuns.lockFreshActiveLeaseForUpdate;
    if (typeof lock === "function") {
      return lock.call(durableRuns, runId, expectedLeaseOwnerId);
    }
    if (process.env.NODE_ENV === "test") {
      const current = await durableRuns.getRun(runId);
      return this.hasActiveLeaseOwner(current, expectedLeaseOwnerId) ? current : undefined;
    }
    throw new Error("Durable run repository is missing the database-clock transition fence");
  }

  private async lockExpiredExecutionLeaseForRecovery(
    observed: DurableRunRecord,
  ): Promise<DurableRunRecord | undefined> {
    if (!observed.leaseExpiresAt) {
      return undefined;
    }
    const durableRuns = this.ctx.storage.durableRuns;
    const lock = durableRuns.lockExpiredLeaseForUpdate;
    if (typeof lock === "function") {
      return lock.call(durableRuns, {
        runId: observed.runId,
        expectedLeaseOwnerId: observed.leaseOwnerId,
        expectedLeaseExpiresAt: observed.leaseExpiresAt,
      });
    }
    if (process.env.NODE_ENV === "test") {
      const current = await durableRuns.getRun(observed.runId);
      return current.status === "running" &&
        current.leaseOwnerId === observed.leaseOwnerId &&
        current.leaseExpiresAt === observed.leaseExpiresAt &&
        this.isLeaseExpiredAt(current, new Date().toISOString())
        ? current
        : undefined;
    }
    throw new Error("Durable run repository is missing the database-clock recovery fence");
  }

  private isConfirmedExitedLocalProcessOwner(leaseOwnerId: string | undefined): boolean {
    const identity = parseDurableLocalProcessLeaseOwnerId(leaseOwnerId);
    if (!identity || identity.hostFingerprint !== DURABLE_LOCAL_HOST_FINGERPRINT || identity.pid === process.pid) {
      return false;
    }
    return !(this.deps?.isLocalProcessAlive ?? isLocalProcessAlive)(identity.pid);
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

  private async retryDurableRunUpdate(
    runId: string,
    update: (current: DurableRunRecord) => DurableRunRecord | Promise<DurableRunRecord>,
    maxAttempts = 3,
  ): Promise<DurableRunRecord> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const current = await this.ctx.storage.durableRuns.getRun(runId);
      try {
        return await update(current);
      } catch (error) {
        if (!isDurableRunUpdateConflict(error) || attempt === maxAttempts - 1) {
          throw error;
        }
        lastError = error;
      }
    }
    await this.publishRealtimeSafely(
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

function terminalChatAdmissionOutcome(
  recoveryOutcome: TerminalChatAdmissionReleaseOutcome["recoveryOutcome"],
  startedAt: number,
  deadline: number,
  detail: Omit<TerminalChatAdmissionReleaseOutcome, "recoveryOutcome" | "elapsedMs" | "remainingBudgetMs"> = {},
): TerminalChatAdmissionReleaseOutcome {
  const now = Date.now();
  return {
    recoveryOutcome,
    ...detail,
    elapsedMs: Math.max(0, now - startedAt),
    remainingBudgetMs: Math.max(0, deadline - now),
  };
}

function isRepresentableTerminalChatRun(run: DurableRunRecord): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
}

function isTerminalChatRunRecoveryCandidate(run: DurableRunRecord): boolean {
  return isRepresentableTerminalChatRun(run) || run.status === "dead_lettered";
}

function isExactDurableTerminalAdmissionRelease(
  admission: SessionMutationAdmissionRecord,
  run: DurableRunRecord,
): boolean {
  const terminalStatus = admission.terminalDurableRunStatus;
  return (
    admission.terminalAuthorityKind === "durable_terminal" &&
    admission.terminalDurableRunId === run.runId &&
    (terminalStatus === "completed" || terminalStatus === "failed" || terminalStatus === "cancelled") &&
    (run.status === terminalStatus || (run.status === "dead_lettered" && terminalStatus === "failed"))
  );
}

function isExactChatRunProjection(
  run: DurableRunRecord,
  expected: {
    expectedWorkspaceId?: string;
    expectedSessionId: string;
    expectedTurnId: string;
  },
): boolean {
  const payload = run.payload as { version?: unknown; workspaceId?: unknown; sessionId?: unknown; turnId?: unknown };
  return (
    run.workflowKey === "chat.turn.execute" &&
    payload.version === "chat.turn.execute.v2" &&
    (expected.expectedWorkspaceId === undefined || payload.workspaceId === expected.expectedWorkspaceId) &&
    payload.sessionId === expected.expectedSessionId &&
    payload.turnId === expected.expectedTurnId
  );
}

function sameTurnAdmissionIdentity(
  left: SessionMutationAdmissionRecord,
  right: SessionMutationAdmissionRecord,
): boolean {
  return (
    left.admissionId === right.admissionId &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId &&
    left.sessionIncarnationId === right.sessionIncarnationId &&
    left.turnId === right.turnId
  );
}

async function waitForTerminalChatAdmissionPoll(deadline: number): Promise<void> {
  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0) return;
  await new Promise<void>((resolve) =>
    setTimeout(resolve, Math.min(TERMINAL_CHAT_ADMISSION_RELEASE_POLL_MS, remainingMs)),
  );
}

async function settleTerminalChatReconciliationBeforeDeadline(
  work: Promise<unknown>,
  deadline: number,
): Promise<boolean> {
  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0) return false;
  return new Promise<boolean>((resolve, reject) => {
    // Node timers can fire a fraction early relative to the requested delay; if we
    // resolved on that early tick the caller would recompute a non-zero
    // `remainingBudgetMs` even though the deadline was reached. Re-arm until the
    // wall clock has actually crossed the deadline so budget exhaustion is exact.
    let timer: ReturnType<typeof setTimeout>;
    const armDeadline = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        resolve(false);
        return;
      }
      timer = setTimeout(armDeadline, remaining);
    };
    armDeadline();
    void work.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function safeRecoveryError(error: unknown): string {
  return redactRawRemoteApprovalBearerText(error instanceof Error ? error.message : String(error));
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
    payload?.version === "chat.turn.execute.v2" &&
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

interface DurableLocalProcessLeaseOwnerIdentity {
  hostFingerprint: string;
  pid: number;
}

export function buildDurableLocalProcessLeaseOwnerId(input?: {
  hostFingerprint?: string;
  pid?: number;
  nonce?: string;
}): string {
  const hostFingerprint = input?.hostFingerprint ?? DURABLE_LOCAL_HOST_FINGERPRINT;
  const pid = input?.pid ?? process.pid;
  const nonce = input?.nonce ?? randomUUID();
  return `${DURABLE_LOCAL_PROCESS_LEASE_VERSION}:${hostFingerprint}:${pid}:${nonce}`;
}

function parseDurableLocalProcessLeaseOwnerId(
  leaseOwnerId: string | undefined,
): DurableLocalProcessLeaseOwnerIdentity | undefined {
  if (!leaseOwnerId) {
    return undefined;
  }
  const match = /^local-process-v1:([0-9a-f]{16}):(\d+):([0-9a-f-]{36})$/u.exec(leaseOwnerId);
  if (!match) {
    return undefined;
  }
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  return { hostFingerprint: match[1]!, pid };
}

function isLocalProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
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
