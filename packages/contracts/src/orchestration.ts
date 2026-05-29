import type { ToolPolicyActorContext } from "./policy.js";

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
  error?: string;
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

export interface OrchestrationRun extends OrchestrationRunPolicyContext {
  runId: string;
  planId: string;
  status: "queued" | "running" | "paused" | "failed" | "completed" | "stopped_by_limit" | "cancelled";
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
