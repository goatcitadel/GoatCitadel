export type ContinuationGateDecisionKind = "continue" | "checkpoint" | "throttle" | "pause" | "stop";

export interface ContinuationGateMetrics {
  stepsSinceCheckpoint: number;
  toolRunCount: number;
  failedToolRunCount: number;
  retryFailureStreak: number;
  approvalWait: boolean;
  userInputWait: boolean;
  elapsedMs?: number;
  tokenTotal?: number;
  costUsd?: number;
  evidenceGapCount: number;
}

export interface ContinuationGateDecision {
  decision: ContinuationGateDecisionKind;
  reasonCodes: string[];
  summary: string;
  metrics: ContinuationGateMetrics;
  recommendedAction: string;
  createdAt: string;
}
