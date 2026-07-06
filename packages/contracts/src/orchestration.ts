import type { ToolPolicyActorContext } from "./policy.js";
import type { RuntimeDecisionTraceRecord } from "./runtime-decision-trace.js";

export type LoopMode = "fresh-context" | "compaction";
export type RunMode = "auto" | "hitl";
export type OrchestrationExecutionState =
  | "created"
  | "worktree_allocating"
  | "worktree_ready"
  | "queued"
  | "running"
  | "paused_for_approval"
  | "resume_requested"
  | "completed"
  | "failed"
  | "stopped_by_limit"
  | "cancelled";
export type OrchestrationWorktreeStatus = "uninitialized" | "allocating" | "ready" | "blocked";

/**
 * Why an orchestration run reached the `stopped_by_limit` status.
 *
 * - `plan_limit`: a plan-level cap was reached (`maxIterations`, `maxRuntimeMinutes`, or `maxCostUsd`).
 * - `wave_budget_exceeded`: a wave's accumulated cost reached or exceeded its `budgetUsd`.
 */
export type OrchestrationStopReason = "plan_limit" | "wave_budget_exceeded";

export interface OrchestrationPhase {
  phaseId: string;
  ownerAgentId: string;
  specPath: string;
  loopMode: LoopMode;
  requiresApproval: boolean;
}

export interface OrchestrationPhaseExecutionResult {
  phaseId: string;
  ownerAgentId: string;
  status: "completed" | "failed" | "waiting";
  startedAt: string;
  finishedAt: string;
  outputSummary?: string;
  outputText?: string;
  childSessionId?: string;
  childTurnId?: string;
  childRunId?: string;
  approvalId?: string;
  responseId?: string;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  citations?: unknown[];
  artifacts?: unknown[];
  prompt?: OrchestrationPromptReference;
  error?: string;
}

export interface OrchestrationPromptReference {
  promptId: string;
  promptVersion: string;
  promptHash: string;
}

/**
 * Linkage breadcrumb reported the moment an orchestration phase dispatches its
 * child Cowork turn. Persisted into the parent durable run's metadata so that a
 * crash mid-phase leaves enough state to harvest/reattach the existing child on
 * resume instead of re-dispatching it (ORCH-002).
 *
 * The child session id is known synchronously before the turn is launched; the
 * child durable run id only becomes known once the durable child run has been
 * created, so it is reported in a second callback invocation.
 */
export interface OrchestrationPhaseChildDispatch {
  phaseId: string;
  childSessionId?: string;
  childTurnId?: string;
  childRunId?: string;
}

export interface OrchestrationWave {
  waveId: string;
  verify: string[];
  budgetUsd: number;
  ownership: { agentId: string; paths: string[] }[];
  phases: OrchestrationPhase[];
}

export interface OrchestrationPlan {
  planId: string;
  goal: string;
  mode: RunMode;
  maxIterations: number;
  maxRuntimeMinutes: number;
  maxCostUsd: number;
  waves: OrchestrationWave[];
}

export interface OrchestrationRunPolicyContext {
  workspaceId?: string;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ToolPolicyActorContext["authActorSource"];
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
}

export type OrchestrationRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "failed"
  | "completed"
  | "stopped_by_limit"
  | "cancelled";

export interface OrchestrationRun extends OrchestrationRunPolicyContext {
  runId: string;
  planId: string;
  status: OrchestrationRunStatus;
  startedAt: string;
  endedAt?: string;
  currentWaveId?: string;
  currentPhaseId?: string;
  totalCostUsd: number;
  totalIterations: number;
  /**
   * Accumulated cost (USD) attributed to each wave, keyed by `waveId`. Used to enforce
   * per-wave `budgetUsd` independently of the plan-level `maxCostUsd` cap. Persisted with
   * the run so wave budgets remain enforced across durable resume.
   */
  waveCostUsdByWaveId?: Record<string, number>;
  /** Populated only when `status` is `stopped_by_limit`, distinguishing plan vs wave caps. */
  stopReason?: OrchestrationStopReason;
  workspaceId?: string;
  durableRunId?: string;
  executionState?: OrchestrationExecutionState;
  worktreePath?: string;
  worktreeStatus?: OrchestrationWorktreeStatus;
  worktreeBaseRef?: string;
  pendingApprovalPhaseId?: string;
  pendingApprovedBy?: string;
  pendingCostIncrementUsd?: number;
  lastError?: string;
}

export type OrchestrationDecisionSource = "checkpoint" | "run_event" | "runtime_decision";

export type OrchestrationDecisionKind =
  | "run_created"
  | "durable_run_linked"
  | "worktree_allocated"
  | "run_queued"
  | "run_started"
  | "policy_checked"
  | "phase_started"
  | "phase_child_dispatched"
  | "phase_wait_registered"
  | "phase_completed"
  | "phase_failed"
  | "phase_advanced"
  | "run_resumed"
  | "run_completed"
  | "run_stopped"
  | "run_failed"
  | "run_cancelled"
  | "cost_recorded"
  | "unknown";

export interface OrchestrationRunEventRecord {
  eventId: string;
  runId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface OrchestrationTraceCheckpoint {
  checkpointId: string;
  runId: string;
  planId: string;
  waveId?: string;
  phaseId?: string;
  checkpointKind: string;
  gitRef?: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface OrchestrationDecisionEvent {
  decisionId: string;
  runId: string;
  kind: OrchestrationDecisionKind;
  source: OrchestrationDecisionSource;
  sourceId: string;
  eventType?: string;
  checkpointKind?: string;
  planId?: string;
  waveId?: string;
  phaseId?: string;
  createdAt: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface OrchestrationDecisionTrace {
  run: OrchestrationRun;
  checkpoints: OrchestrationTraceCheckpoint[];
  runEvents: OrchestrationRunEventRecord[];
  decisions: OrchestrationDecisionEvent[];
  runtimeDecisions?: RuntimeDecisionTraceRecord[];
  generatedAt: string;
  warnings: string[];
}
