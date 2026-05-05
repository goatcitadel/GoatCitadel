import type { ContinuationGateDecision, ContinuationGateMetrics } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

export interface ContinuationGateEvaluateInput {
  metrics: Partial<ContinuationGateMetrics>;
  checkpointIntervalSteps?: number;
  toolRunBudget?: number;
  timeBudgetMs?: number;
  costBudgetUsd?: number;
  createdAt?: string;
}

export interface ContinuationGateRecordInput {
  runId: string;
  decision: ContinuationGateDecision;
}

export interface ContinuationGateServiceDependencies {
  storage: Storage;
  publishRealtime?: (eventType: string, source: string, payload: Record<string, unknown>) => void;
}

export class ContinuationGateService {
  public constructor(private readonly deps: ContinuationGateServiceDependencies) {}

  public evaluate(input: ContinuationGateEvaluateInput): ContinuationGateDecision {
    const metrics = normalizeMetrics(input.metrics);
    const reasonCodes: string[] = [];
    let decision: ContinuationGateDecision["decision"] = "continue";
    let recommendedAction = "Continue the run.";

    if (metrics.approvalWait) {
      decision = "pause";
      reasonCodes.push("approval_wait");
      recommendedAction = "Wait for the operator to resolve the approval.";
    } else if (metrics.userInputWait) {
      decision = "pause";
      reasonCodes.push("user_input_wait");
      recommendedAction = "Wait for the operator to provide the missing input.";
    } else if (metrics.retryFailureStreak >= 2 || metrics.failedToolRunCount >= 3) {
      decision = "pause";
      reasonCodes.push("failure_streak");
      recommendedAction = "Pause and inspect the failing tool/run state before retrying.";
    } else if (metrics.evidenceGapCount > 0) {
      decision = "checkpoint";
      reasonCodes.push("evidence_gap");
      recommendedAction = "Checkpoint and surface the missing evidence before continuing.";
    } else if (input.toolRunBudget !== undefined && metrics.toolRunCount >= input.toolRunBudget) {
      decision = "throttle";
      reasonCodes.push("tool_budget_exhausted");
      recommendedAction = "Throttle automatic continuation until the operator extends the tool budget.";
    } else if (input.timeBudgetMs !== undefined && (metrics.elapsedMs ?? 0) >= input.timeBudgetMs) {
      decision = "checkpoint";
      reasonCodes.push("time_budget_checkpoint");
      recommendedAction = "Checkpoint progress before spending more runtime.";
    } else if (input.costBudgetUsd !== undefined && (metrics.costUsd ?? 0) >= input.costBudgetUsd) {
      decision = "throttle";
      reasonCodes.push("cost_budget_exhausted");
      recommendedAction = "Throttle automatic continuation until the operator extends the cost budget.";
    } else if (metrics.stepsSinceCheckpoint >= (input.checkpointIntervalSteps ?? 8)) {
      decision = "checkpoint";
      reasonCodes.push("checkpoint_interval");
      recommendedAction = "Create a checkpoint before continuing to the next step.";
    }

    return {
      decision,
      reasonCodes,
      summary: summarizeDecision(decision, reasonCodes),
      metrics,
      recommendedAction,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
  }

  public recordNonContinueCheckpoint(input: ContinuationGateRecordInput): { checkpointId: string } | undefined {
    if (input.decision.decision === "continue") {
      return undefined;
    }
    const checkpoint = this.deps.storage.durableRuns.createCheckpoint({
      runId: input.runId,
      checkpointKind: "continuation_gate",
      state: {
        continuationGate: input.decision,
      },
      createdAt: input.decision.createdAt,
    });
    this.deps.publishRealtime?.("continuation_gate_checkpoint", "cowork", {
      runId: input.runId,
      checkpointId: checkpoint.checkpointId,
      decision: input.decision.decision,
      reasonCodes: input.decision.reasonCodes,
      recommendedAction: input.decision.recommendedAction,
    });
    return { checkpointId: checkpoint.checkpointId };
  }
}

function normalizeMetrics(metrics: Partial<ContinuationGateMetrics>): ContinuationGateMetrics {
  return {
    stepsSinceCheckpoint: Math.max(0, Math.floor(metrics.stepsSinceCheckpoint ?? 0)),
    toolRunCount: Math.max(0, Math.floor(metrics.toolRunCount ?? 0)),
    failedToolRunCount: Math.max(0, Math.floor(metrics.failedToolRunCount ?? 0)),
    retryFailureStreak: Math.max(0, Math.floor(metrics.retryFailureStreak ?? 0)),
    approvalWait: Boolean(metrics.approvalWait),
    userInputWait: Boolean(metrics.userInputWait),
    elapsedMs: metrics.elapsedMs,
    tokenTotal: metrics.tokenTotal,
    costUsd: metrics.costUsd,
    evidenceGapCount: Math.max(0, Math.floor(metrics.evidenceGapCount ?? 0)),
  };
}

function summarizeDecision(decision: ContinuationGateDecision["decision"], reasonCodes: string[]): string {
  if (decision === "continue") {
    return "Continue gate clear.";
  }
  return `Continue gate set to ${decision}: ${reasonCodes.join(", ") || "operator checkpoint"}.`;
}
