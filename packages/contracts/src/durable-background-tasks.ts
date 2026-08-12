import type { ApprovalStatus } from "./approvals.js";
import type {
  DurableChildWatcherState,
  DurableRecoveryState,
  DurableRunStatus,
  DurableWorkerHealth,
} from "./durable.js";

export type DurableBackgroundTaskSemanticLinkKind =
  | "durable_run"
  | "chat_session"
  | "chat_turn"
  | "approval"
  | "delegation_run"
  | "delegation_step"
  | "task";

/** A typed identifier. Clients decide how a known kind is opened; arbitrary URLs are never supplied. */
export interface DurableBackgroundTaskSemanticLink {
  kind: DurableBackgroundTaskSemanticLinkKind;
  id: string;
  label: string;
}

export interface DurableBackgroundTaskScope {
  workspaceId: string;
  sessionId: string;
  verified: boolean;
}

export interface DurableBackgroundTaskToolState {
  toolRunId: string;
  toolName: string;
  status: "started" | "executed" | "blocked" | "approval_required" | "failed";
  approvalId?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  failureGuidance?: string;
  links: DurableBackgroundTaskSemanticLink[];
}

export interface DurableBackgroundTaskApprovalState {
  approvalId: string;
  status: ApprovalStatus | "missing";
  riskLevel?: "safe" | "caution" | "danger" | "nuclear";
  createdAt?: string;
  expiresAt?: string;
  links: DurableBackgroundTaskSemanticLink[];
}

export interface DurableBackgroundTaskOutputEvidence {
  availability: "available" | "missing" | "not_terminal" | "unknown";
  source?: "delegation_step" | "assistant_message";
  sourceId?: string;
  summary?: string;
  sha256?: string;
  byteCount?: number;
}

export type DurableBackgroundTaskBlockerKind =
  | "approval_required"
  | "paused"
  | "waiting"
  | "failed"
  | "cancelled"
  | "dead_lettered"
  | "detached"
  | "missing_child"
  | "missing_output"
  | "projection_incomplete"
  | "scope_unverified"
  | "signal_integrity";

export interface DurableBackgroundTaskBlocker {
  kind: DurableBackgroundTaskBlockerKind;
  message: string;
  link?: DurableBackgroundTaskSemanticLink;
}

export interface DurableBackgroundTaskSignalIntegrity {
  observedCount: number;
  acceptedCount: number;
  duplicateCount: number;
  outOfOrderCount: number;
  conflictingSequenceCount: number;
  highestAcceptedSequence?: number;
  observationComplete: boolean;
  posture: "clean" | "degraded" | "unobserved";
}

/**
 * Operator attention is presentation state only. It never changes the child
 * run, its tool grants, approval requirements, recovery, or scheduling.
 */
export interface DurableBackgroundTaskAttention {
  state: "foreground" | "background" | "stopped";
  reason: "watcher_attached" | "operator_continued_in_background" | "watcher_closed";
  updatedAt: string;
  required: boolean;
  requiredReason?: DurableBackgroundTaskBlockerKind;
}

export interface DurableBackgroundTaskControls {
  detach: { enabled: boolean; reason?: string };
  reattach: { enabled: boolean; reason?: string };
  cancel: { enabled: boolean; reason?: string };
}

export interface DurableBackgroundTaskItem {
  watcherId: string;
  /** Monotonic persisted watcher generation used for control CAS. */
  watcherRevision: number;
  watcherState: DurableChildWatcherState;
  watcherUpdatedAt: string;
  childRunId: string;
  delegationRunId?: string;
  delegationStepId?: string;
  canonicalStatus: DurableRunStatus | "missing" | "unknown";
  childVersion?: number;
  workerHealth?: DurableWorkerHealth;
  recoveryState?: DurableRecoveryState;
  recoverySummary?: string;
  label: string;
  role?: string;
  startedAt?: string;
  finishedAt?: string;
  scope: DurableBackgroundTaskScope;
  tools: DurableBackgroundTaskToolState[];
  toolCoverage: { complete: boolean; observedCount: number; limit: number };
  approvals: DurableBackgroundTaskApprovalState[];
  output: DurableBackgroundTaskOutputEvidence;
  blockers: DurableBackgroundTaskBlocker[];
  attention: DurableBackgroundTaskAttention;
  signalIntegrity: DurableBackgroundTaskSignalIntegrity;
  controls: DurableBackgroundTaskControls;
  links: DurableBackgroundTaskSemanticLink[];
}

export interface DurableBackgroundTaskLineageEntry {
  watcherId: string;
  childRunId: string;
  source: "delegation_step" | "assistant_message";
  sourceId: string;
  sha256: string;
  byteCount: number;
  links: DurableBackgroundTaskSemanticLink[];
}

export interface DurableBackgroundTaskRailResponse {
  version: "durable.background_task_rail.v1";
  generatedAt: string;
  scope: DurableBackgroundTaskScope;
  parent: {
    runId: string;
    status: DurableRunStatus;
    version: number;
    workerHealth?: DurableWorkerHealth;
    recoveryState?: DurableRecoveryState;
    links: DurableBackgroundTaskSemanticLink[];
  };
  coverage: {
    watchers: { complete: boolean; observedCount: number; limit: number };
    parentSignals: { complete: boolean; observedCount: number; limit: number };
  };
  tasks: DurableBackgroundTaskItem[];
  synthesis: {
    availability: "available" | "partial" | "missing" | "not_terminal";
    summary?: string;
    delegationRunId?: string;
    lineage: DurableBackgroundTaskLineageEntry[];
    missingTerminalChildRunIds: string[];
    /** Watched children not cited by the selected synthesis generation. */
    uncoveredChildRunIds: string[];
    /** Delegation steps in the selected generation with no verified watched child. */
    uncoveredStepIds: string[];
  };
  unknowns: string[];
}

export type DurableBackgroundTaskControlAction = "detach" | "reattach" | "cancel";

export interface DurableBackgroundTaskControlRequest {
  workspaceId: string;
  sessionId: string;
  action: DurableBackgroundTaskControlAction;
  expectedWatcherRevision: number;
  expectedChildVersion?: number;
  reason?: string;
}

export interface DurableBackgroundTaskControlResponse {
  version: "durable.background_task_control.v1";
  action: DurableBackgroundTaskControlAction;
  watcherId: string;
  childRunId: string;
  outcome: "applied" | "converged";
  rail: DurableBackgroundTaskRailResponse;
}
