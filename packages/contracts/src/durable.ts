import type { OrchestrationRunPolicyContext } from "./orchestration.js";

export type DurableRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "dead_lettered";

export interface DurableRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export interface DurableEventWait {
  eventKey: string;
  timeoutMs?: number;
  correlationId?: string;
}

export type DurableSupportedWorkflowKey =
  | "chat.turn.execute"
  | "proactive.tick"
  | "approval.wait"
  | "connector.delivery"
  | "hook.delivery"
  | "memory.maintenance"
  | "orchestration.plan.execute"
  | "external_side_effect.replay"
  | "curator.tick";

export interface ProactiveTickWorkflowPayload {
  version: "proactive.tick.v1";
  sessionId: string;
  proactiveRunId: string;
  taskId?: string;
  originSurface: import("./proactive.js").ProactiveOriginSurface;
  triggerSource: import("./proactive.js").ProactiveTriggerSource;
  policySnapshot: import("./proactive.js").ProactivePolicy;
  requestedAt: string;
}

export interface ApprovalWaitWorkflowPayload {
  version: "approval.wait.v1";
  approvalId: string;
  approvalKind: string;
  createdAt: string;
  correlationId?: string;
  traceId?: string;
  originSurface?: string;
}

export interface ConnectorDeliveryWorkflowPayload {
  version: "connector.delivery.v1";
  connectorId: string;
  connectorType?: string;
  action: string;
  workspaceId?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  runId?: string;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: import("./policy.js").ToolPolicyActorContext["authActorSource"];
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  payload?: Record<string, unknown>;
  /** Opaque keychain references; raw secret values must never enter a durable payload. */
  secretRefs?: {
    approvalActionToken?: string;
  };
  /** Expiry truth for a connector-delivered approval action. */
  approvalAction?: {
    tokenId: string;
    expiresAt: string;
  };
  correlationId?: string;
  traceId?: string;
  originSurface?: string;
  simulateFailureReason?: string;
}

export interface OrchestrationPlanWorkflowPayload extends OrchestrationRunPolicyContext {
  version: "orchestration.plan.execute.v1";
  orchestrationRunId: string;
  planId: string;
  workspaceId: string;
  requestedAt: string;
}

export interface CuratorTickWorkflowPayload {
  version: "curator.tick.v1";
  runId: string;
  triggerMode: "scheduled" | "manual";
  cycleDays: number;
  requestedAt: string;
}

export interface ExternalSideEffectReplayWorkflowPayload {
  version: "external_side_effect.replay.v1";
  workspaceId: string;
  requestedBy: string;
  requestedAt: string;
  runIds?: string[];
  connectionId?: string;
  limit?: number;
  staleClaimedNotSentAfterMs?: number;
}

export interface DurableRunCreateRequest {
  /** Optional internally reserved identity for cross-transaction handoff. */
  runId?: string;
  workflowKey: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  retryPolicy?: Partial<DurableRetryPolicy>;
  waitForEvent?: DurableEventWait;
}

export type DurableWorkerHealth = "unknown" | "idle" | "active" | "stale_heartbeat" | "expired_lease" | "released";

export type DurableRecoveryState =
  | "none"
  | "reclaiming"
  | "reclaimable"
  | "retry_budget_exhausted"
  | "dead_lettered"
  | "incomplete_worker_exit";

export interface DurableRunRecord {
  runId: string;
  workflowKey: string;
  status: DurableRunStatus;
  attemptCount: number;
  maxAttempts: number;
  version: number;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
  leaseOwnerId?: string;
  leaseExpiresAt?: string;
  leaseHeartbeatAt?: string;
  workerHealth?: DurableWorkerHealth;
  recoveryState?: DurableRecoveryState;
  recoverySummary?: string;
  createdAt: string;
  updatedAt: string;
}

export type DurableWakeOutcome =
  | "woke"
  | "skipped_paused"
  | "skipped_not_waiting"
  | "skipped_event_key_mismatch"
  | "skipped_correlation_mismatch"
  | "failed";

export interface DurableWakeResult {
  runId: string;
  eventKey: string;
  correlationId?: string;
  outcome: DurableWakeOutcome;
  run?: DurableRunRecord;
  detail?: string;
}

export interface DurableCheckpointRecord {
  checkpointId: string;
  runId: string;
  checkpointKind:
    | "run_created"
    | "run_started"
    | "run_waiting"
    | "run_resumed"
    | "run_completed"
    | "run_failed"
    | "run_cancelled"
    | "manual_replay_requested"
    | "continuation_gate"
    | "run_lease_expired"
    | "run_reclaimed"
    | "run_incomplete_worker_exit"
    | "run_retry_budget_exhausted";
  state: Record<string, unknown>;
  createdAt: string;
}

export interface DurableRetryRecord {
  retryId: string;
  runId: string;
  attemptNo: number;
  reason: string;
  nextRetryAt?: string;
  createdAt: string;
}

export interface DurableDeadLetterRecord {
  deadLetterId: string;
  runId: string;
  reason: string;
  payload: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

export interface DurableDiagnosticsResponse {
  enabled: boolean;
  replayFoundationReady: boolean;
  runCount: number;
  queuedCount: number;
  runningCount: number;
  waitingCount: number;
  failedCount: number;
  deadLetterCount: number;
  recentRuns: DurableRunRecord[];
  recentDeadLetters: DurableDeadLetterRecord[];
  eventLoopLag?: {
    lastMs: number;
    lastObservedAt: string;
    leaseAcquisitionPausedUntil?: string;
  };
  lastBootRecovery?: {
    observedAt: string;
    resumedCount: number;
    prunedOrphanCheckpoints: number;
    prunedAgedCheckpoints: number;
    finalCheckpointBytes: number;
    diskBudgetBytes: number;
  };
  generatedAt: string;
}

export interface DurableRunTimelineEvent {
  eventId: string;
  runId: string;
  /** Monotonic, gap-tolerant ordering scoped to this run. */
  sequence: number;
  eventType:
    | "run_created"
    | "run_started"
    | "run_paused"
    | "run_resumed"
    | "run_waiting"
    | "run_woken"
    | "run_retry_scheduled"
    | "run_cancelled"
    | "run_completed"
    | "run_failed"
    | "continuation_gate"
    | "run_dead_lettered"
    | "run_lease_expired"
    | "run_reclaimed"
    | "run_incomplete_worker_exit"
    | "run_retry_budget_exhausted"
    | "worker_event_loop_lag"
    | "dead_letter_recovered"
    | "child_state_changed";
  stepKey?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export type DurableChildWatcherState = "attached" | "detached" | "closed";

/**
 * Durable cursor from a parent run to one child run. Watchers are observational:
 * advancing one never wakes, resumes, retries, or otherwise mutates either run.
 */
export interface DurableChildWatcherRecord {
  watcherId: string;
  /** Monotonic persisted generation for cross-process compare-and-swap controls. */
  revision: number;
  parentRunId: string;
  childRunId: string;
  state: DurableChildWatcherState;
  /** First child sequence that has not yet been consumed. */
  nextSequence: number;
  /** Highest child sequence consumed, including non-projectable operational events. */
  lastConsumedSequence: number;
  projectedNoticeCount: number;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  detachedAt?: string;
  reattachedAt?: string;
  closedAt?: string;
}

export interface DurableChildWatcherCreateRequest {
  parentRunId: string;
  childRunId: string;
  watcherId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

/** Payload stored on a parent's deterministic `child_state_changed` notice. */
export interface DurableChildStateChangedPayload {
  watcherId: string;
  parentRunId: string;
  childRunId: string;
  childEventId: string;
  childSequence: number;
  childEventType: Exclude<DurableRunTimelineEvent["eventType"], "child_state_changed">;
  childStepKey?: string;
  /** Present only when the source payload fits the fixed projection boundary. */
  childPayload?: Record<string, unknown>;
  /** Exact-byte evidence and bounded projection posture for the source payload. */
  childPayloadEvidence: {
    hashAlgorithm: "sha256";
    originalSha256: string;
    originalByteCount: number;
    disposition: "included_redacted" | "omitted";
    omissionReason?: "byte_limit" | "depth_limit" | "item_limit" | "invalid_json" | "invalid_shape";
    redactionCount?: number;
    preview?: {
      topLevelType: "object" | "array" | "primitive" | "unknown";
      topLevelKeyCount?: number;
      topLevelKeys?: string[];
      summary: string;
    };
  };
  childCreatedAt: string;
  observedAt: string;
}

export interface DurableChildWatcherCatchUpResult {
  watcher: DurableChildWatcherRecord;
  consumedCount: number;
  projectedCount: number;
  hasMore: boolean;
  notices: DurableRunTimelineEvent[];
}
