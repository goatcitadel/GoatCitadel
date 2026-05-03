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
  | "orchestration.plan.execute";

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
  payload?: Record<string, unknown>;
  correlationId?: string;
  traceId?: string;
  originSurface?: string;
  simulateFailureReason?: string;
}

export interface OrchestrationPlanWorkflowPayload {
  version: "orchestration.plan.execute.v1";
  orchestrationRunId: string;
  planId: string;
  workspaceId: string;
  requestedAt: string;
}

export interface DurableRunCreateRequest {
  workflowKey: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  retryPolicy?: Partial<DurableRetryPolicy>;
  waitForEvent?: DurableEventWait;
}

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
    | "manual_replay_requested";
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
  generatedAt: string;
}

export interface DurableRunTimelineEvent {
  eventId: string;
  runId: string;
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
    | "run_dead_lettered"
    | "worker_event_loop_lag"
    | "dead_letter_recovered";
  stepKey?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}
