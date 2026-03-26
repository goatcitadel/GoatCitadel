export type DecisionReplayRunStatus = "queued" | "running" | "completed" | "failed";
export type DecisionReplayTriggerMode = "scheduled" | "manual";
export type DecisionReplayDecisionType = "chat_turn" | "tool_run";
export type DecisionReplayLabel = "ok" | "uncertain" | "likely_wrong";
export type DecisionReplayCauseClass =
  | "false_refusal_tone"
  | "weak_blocker_explanation"
  | "tool_mismatch"
  | "retrieval_miss"
  | "incomplete_retry_repair"
  | "other";

export interface DecisionReplayRunRecord {
  runId: string;
  triggerMode: DecisionReplayTriggerMode;
  sampleSize: number;
  windowStart: string;
  windowEnd: string;
  status: DecisionReplayRunStatus;
  reportId?: string;
  totalCandidates: number;
  totalScored: number;
  likelyWrongCount: number;
  modelJudgedCount: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface DecisionReplayItemRuleScores {
  honesty: number;
  blockerQuality: number;
  retryQuality: number;
  toolEvidence: number;
  actionability: number;
}

export interface DecisionReplayItemModelScores {
  correctnessLikelihood: number;
  missedToolProbability: number;
  betterResponsePotential: number;
  rationale?: string;
}

export interface DecisionReplayItemRecord {
  itemId: string;
  runId: string;
  decisionType: DecisionReplayDecisionType;
  sessionId?: string;
  turnId?: string;
  toolRunId?: string;
  occurredAt: string;
  wrongnessProbability: number;
  label: DecisionReplayLabel;
  causeClass: DecisionReplayCauseClass;
  clusterKey: string;
  ruleScores: DecisionReplayItemRuleScores;
  modelScores?: DecisionReplayItemModelScores;
  evidence: string[];
  summary?: string;
  inputExcerpt?: string;
  outputExcerpt?: string;
  createdAt: string;
}

export interface DecisionReplayFindingRecord {
  findingId: string;
  runId: string;
  fingerprint: string;
  causeClass: DecisionReplayCauseClass;
  clusterKey: string;
  severity: "low" | "medium" | "high";
  recurrenceCount: number;
  impactedSessions: number;
  impactedTurns: number;
  avgWrongness: number;
  title: string;
  summary: string;
  recommendation?: string;
  isDuplicate: boolean;
  duplicateOfFingerprint?: string;
  createdAt: string;
}

export interface DecisionAutoTuneRecord {
  tuneId: string;
  runId: string;
  findingId?: string;
  tuneClass: "prompt_contract" | "threshold" | "ranking_weight" | "other";
  riskLevel: "low" | "medium" | "high";
  status: "queued" | "applied" | "reverted" | "rejected" | "blocked";
  description: string;
  patch: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  result?: Record<string, unknown>;
  createdAt: string;
  appliedAt?: string;
  revertedAt?: string;
}

export interface WeeklyImprovementReportRecord {
  reportId: string;
  runId: string;
  weekStart: string;
  weekEnd: string;
  summary: {
    sampledDecisions: number;
    likelyWrongCount: number;
    wrongnessRate: number;
    topCauseClasses: Array<{ causeClass: DecisionReplayCauseClass; count: number }>;
    duplicateSuppressedCount: number;
    improvedCount: number;
    regressedCount: number;
  };
  topFindings: DecisionReplayFindingRecord[];
  appliedAutoTunes: DecisionAutoTuneRecord[];
  queuedRecommendations: DecisionAutoTuneRecord[];
  weekOverWeek: {
    improved: string[];
    regressed: string[];
    unchanged: string[];
  };
  previousReportId?: string;
  createdAt: string;
}

export type CapabilityGapCauseClass =
  | "tool_exists_but_not_in_profile"
  | "tool_requires_approval_but_not_exposed"
  | "skill_missing"
  | "provider_tool_mismatch"
  | "retryable_network_failure"
  | "policy_denied_by_config"
  | "missing_required_tool_evidence"
  | "routing_profile_mismatch";

export interface CapabilityGapEventRecord {
  eventId: string;
  sessionId: string;
  turnId?: string;
  runId?: string;
  causeClass: CapabilityGapCauseClass;
  failureClass?: string;
  promptExcerpt?: string;
  promptRef?: string;
  requestedTool?: string;
  toolFamily?: string;
  toolProfile?: string;
  policyReason?: string;
  providerId?: string;
  model?: string;
  configArea?: string;
  suggestedRepairClass?: string;
  confidence: number;
  repeatCount: number;
  recoveryOptions: Array<
    | "temporary_session_allow"
    | "switch_tool_profile"
    | "request_approval"
    | "install_skill"
    | "reroute_provider"
    | "retry_once"
    | "replay_failed_turn"
    | "patch_config"
  >;
  replayRunId?: string;
  replayStatus: "not_run" | "queued" | "running" | "completed" | "failed";
  repairCandidateId?: string;
  createdAt: string;
  updatedAt: string;
}

export type RepairValidationStatus =
  | "not_started"
  | "queued"
  | "running"
  | "needs_review"
  | "passed"
  | "failed";

export interface RepairCandidateRecord {
  candidateId: string;
  fingerprint: string;
  causeClass: CapabilityGapCauseClass;
  title: string;
  summary: string;
  requestedTool?: string;
  toolProfile?: string;
  providerId?: string;
  configArea?: string;
  suggestedPatch?: string;
  replayRunId?: string;
  validationStatus: RepairValidationStatus;
  validationSummary?: string;
  eventCount: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}
