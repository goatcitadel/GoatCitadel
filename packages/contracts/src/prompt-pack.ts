import type { ChatCitationRecord, ChatMode, ChatTurnTraceRecord } from "./chat.js";
import type { ChatMemoryMode, ChatThinkingLevel, ChatWebMode } from "./chat.js";

export type PromptPackToolTier = "no-tools" | "implicit-tools" | "explicit-tools";

export type PromptPackExecutionStyle = "single_turn_harness" | "agentic_surface";

export interface PromptPackDiagnosticMetadata {
  capabilityTargets: string[];
  expectedRuntimeSignals: string[];
  likelyFailureClasses: string[];
}

export type PromptPackScoreDimensionV2 = "taskSuccess" | "honesty" | "executionQuality" | "robustness" | "usability";

export type PromptPackDimensionScoreV2 = 0 | 1 | 2 | 3 | 4;

export type PromptPackScoringSchemaVersion = "v2" | "v3";

export type PromptPackOutcomeScoreDimensionV3 =
  | "taskSuccess"
  | "truthfulness"
  | "evidenceGrounding"
  | "formatAdherence"
  | "operatorUsefulness";

export type PromptPackExecutionScoreDimensionV3 =
  | "toolUseQuality"
  | "orchestrationQuality"
  | "efficiency"
  | "recoveryQuality";

export type PromptPackScoreDimensionV3 = PromptPackOutcomeScoreDimensionV3 | PromptPackExecutionScoreDimensionV3;

export type PromptPackDimensionScoreV3 = 0 | 1 | 2 | 3 | 4;

export type PromptPackVerdict = "pass" | "fail" | "review";

export type PromptPackPolicySource = "inherited_default" | "pack_override";

export type PromptPackJudgeStatusV2 = "valid" | "repaired" | "fallback" | "invalid" | "timeout" | "skipped";

export type PromptPackScoreState = "unavailable" | "auto_valid" | "auto_degraded" | "human_override_present";

export type PromptPackReasonCode =
  | "tool_tier_violation"
  | "unsupported_access_claim"
  | "run_failed"
  | "approval_paused"
  | "missing_required_json"
  | "missing_required_table"
  | "missing_required_citation_evidence"
  | "self_reported_incomplete"
  | "off_target_meta_analysis"
  | "judge_fallback"
  | "judge_schema_repair"
  | "judge_invalid"
  | "judge_timeout"
  | "major_disagreement"
  | "critical_dimension_not_applicable";

export type PromptPackFailureAttributionCode =
  | "model_reasoning_failure"
  | "bad_prompt_or_rubric"
  | "wrong_model_routed"
  | "missing_tool"
  | "tool_call_wrong_args"
  | "retrieval_or_context_gap"
  | "orchestration_synthesis_failure"
  | "ui_operator_truth_gap"
  | "harness_or_judge_failure"
  | "runtime_or_infra_failure"
  | "insufficient_evidence"
  | "not_applicable";

export type PromptPackFailureAttributionConfidence = "low" | "medium" | "high";

export interface PromptPackPolicyV2 {
  scoringSchemaVersion: "v2";
  threshold: number;
  weights: Record<PromptPackScoreDimensionV2, number>;
  minScores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
  judgeRequired: boolean;
  reviewOnDisagreementAt: number;
  criticalDimensionsMustBeApplicable: boolean;
  hardFailSignals: PromptPackReasonCode[];
}

export interface PromptPackPolicyV3 {
  scoringSchemaVersion: "v3";
  threshold: number;
  weights: Record<PromptPackScoreDimensionV3, number>;
  minScores: Partial<Record<PromptPackScoreDimensionV3, PromptPackDimensionScoreV3>>;
  judgeRequired: boolean;
  reviewOnDisagreementAt: number;
  criticalDimensionsMustBeApplicable: boolean;
  hardFailSignals: PromptPackReasonCode[];
  attributionRequiredFor: Array<Exclude<PromptPackVerdict, "pass">>;
}

export interface PromptPackProtocolResultV2 {
  protocolPass: boolean;
  reasonCodes: PromptPackReasonCode[];
}

export type PromptPackMergeStrategyV2 = "rule_authoritative" | "judge_authoritative" | "mixed";

export interface PromptPackMergeProvenanceEntryV2 {
  rule?: PromptPackDimensionScoreV2;
  judge?: PromptPackDimensionScoreV2;
  final?: PromptPackDimensionScoreV2;
  strategy: PromptPackMergeStrategyV2;
  caps?: PromptPackReasonCode[];
}

export interface PromptPackRecord {
  packId: string;
  name: string;
  sourceLabel?: string;
  testCount: number;
  policyV2?: PromptPackPolicyV2;
  policyHash?: string;
  policySource?: PromptPackPolicySource;
  createdAt: string;
  updatedAt: string;
}

export type PromptPackSecurityEvalPackStatus = "available" | "imported" | "unavailable";

export interface PromptPackSecurityEvalPackRecord {
  packKey: string;
  title: string;
  sourceLabel: string;
  status: PromptPackSecurityEvalPackStatus;
  importedPackId?: string;
  importedPackName?: string;
  testCount: number;
  modeCounts: Partial<Record<ChatMode, number>>;
  toolTierCounts: Partial<Record<PromptPackToolTier, number>>;
  capabilityTargets: string[];
  likelyFailureClasses: string[];
  safetyPosture: {
    definitionOnly: true;
    requiresOperatorRun: true;
    callsProviders: false;
    mutationPerformed: false;
    note: string;
  };
  blockers: string[];
}

export interface PromptPackSecurityEvalPacksResponse {
  generatedAt: string;
  items: PromptPackSecurityEvalPackRecord[];
  warnings: string[];
}

export interface PromptPackTestRecord {
  testId: string;
  packId: string;
  code: string;
  title: string;
  prompt: string;
  orderIndex: number;
  mode?: ChatMode;
  toolTier?: PromptPackToolTier;
  diagnosticMetadata?: PromptPackDiagnosticMetadata;
  createdAt: string;
}

export interface PromptPackRunRecord {
  runId: string;
  packId: string;
  testId: string;
  sessionId?: string;
  status: "queued" | "running" | "completed" | "failed" | "approval_paused";
  providerId?: string;
  model?: string;
  mode?: ChatMode;
  toolTier?: PromptPackToolTier;
  toolAutonomy?: "safe_auto" | "manual";
  webMode?: ChatWebMode;
  memoryMode?: ChatMemoryMode;
  thinkingLevel?: ChatThinkingLevel;
  executionStyle?: PromptPackExecutionStyle;
  diagnosticMetadata?: PromptPackDiagnosticMetadata;
  /** Raw canonical assistant output captured from the turn transcript. */
  responseText?: string;
  /** Optional harness-derived operator aid; never the scored assistant answer. */
  derivedResponseText?: string;
  /** Signals describing how derived harness text was synthesized. */
  derivedResponseSignals?: string[];
  trace?: ChatTurnTraceRecord;
  citations?: ChatCitationRecord[];
  integrity?: PromptPackRunIntegrityRecord;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface PromptPackRunIntegrityRecord {
  validationStatus: "valid" | "invalid" | "unknown";
  signals: string[];
  completionStatus?: "complete" | "truncated" | "interrupted" | "backgrounded";
  finishReason?: string;
  outputTokenCount?: number;
  responseChecksumSha256?: string;
}

export interface PromptPackScoreRecord {
  scoreId: string;
  packId: string;
  testId: string;
  runId: string;
  routingScore: 0 | 1 | 2;
  honestyScore: 0 | 1 | 2;
  handoffScore: 0 | 1 | 2;
  robustnessScore: 0 | 1 | 2;
  usabilityScore: 0 | 1 | 2;
  totalScore: number;
  judge?: PromptPackJudgeRecord;
  notes?: string;
  createdAt: string;
}

export interface PromptPackJudgeRecord {
  usedModelJudge: boolean;
  status: "ok" | "fallback" | "schema_repair" | "rate_limited" | "error" | "skipped_invalid_run";
  attemptCount: number;
  ruleSignals: string[];
  modelJudgeError?: string;
  modelJudgeRationale?: string;
}

export interface PromptPackScoreRecordV2 {
  autoScoreId: string;
  packId: string;
  testId: string;
  runId: string;
  scoringSchemaVersion: "v2";
  scorerVersion: string;
  judgeRubricVersion: string;
  policyHash: string;
  policySource: PromptPackPolicySource;
  assertionSetVersion?: string;
  scoreState: PromptPackScoreState;
  protocol: PromptPackProtocolResultV2;
  hardFailReasons: PromptPackReasonCode[];
  applicability: Partial<Record<PromptPackScoreDimensionV2, boolean>>;
  ruleScores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
  judgeScores?: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
  finalScores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
  disagreement: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
  weightedScore: number;
  autoVerdict: PromptPackVerdict;
  reviewReasons: PromptPackReasonCode[];
  degradedReasons: PromptPackReasonCode[];
  mergeProvenance: Partial<Record<PromptPackScoreDimensionV2, PromptPackMergeProvenanceEntryV2>>;
  judgeStatus: PromptPackJudgeStatusV2;
  judgeProviderId?: string;
  judgeModel?: string;
  notes?: string;
  createdAt: string;
}

export interface PromptPackFailureAttributionRecordV3 {
  primary: PromptPackFailureAttributionCode;
  secondary?: PromptPackFailureAttributionCode[];
  confidence: PromptPackFailureAttributionConfidence;
  evidence: string[];
}

export interface PromptPackScoreRecordV3 {
  autoScoreId: string;
  packId: string;
  testId: string;
  runId: string;
  scoringSchemaVersion: "v3";
  scorerVersion: string;
  judgeRubricVersion: string;
  policyHash: string;
  policySource: PromptPackPolicySource;
  assertionSetVersion?: string;
  scoreState: PromptPackScoreState;
  protocol: PromptPackProtocolResultV2;
  hardFailReasons: PromptPackReasonCode[];
  applicability: Partial<Record<PromptPackScoreDimensionV3, boolean>>;
  outcomeScores: Partial<Record<PromptPackOutcomeScoreDimensionV3, PromptPackDimensionScoreV3>>;
  executionScores: Partial<Record<PromptPackExecutionScoreDimensionV3, PromptPackDimensionScoreV3>>;
  ruleScores: Partial<Record<PromptPackScoreDimensionV3, PromptPackDimensionScoreV3>>;
  judgeScores?: Partial<Record<PromptPackScoreDimensionV3, PromptPackDimensionScoreV3>>;
  finalScores: Partial<Record<PromptPackScoreDimensionV3, PromptPackDimensionScoreV3>>;
  disagreement: Partial<Record<PromptPackScoreDimensionV3, PromptPackDimensionScoreV3>>;
  weightedScore: number;
  autoVerdict: PromptPackVerdict;
  reviewReasons: PromptPackReasonCode[];
  degradedReasons: PromptPackReasonCode[];
  mergeProvenance: Partial<Record<PromptPackScoreDimensionV3, PromptPackMergeProvenanceEntryV2>>;
  attribution: PromptPackFailureAttributionRecordV3;
  judgeStatus: PromptPackJudgeStatusV2;
  judgeProviderId?: string;
  judgeModel?: string;
  notes?: string;
  createdAt: string;
}

export type PromptPackAutoScoreRecord = PromptPackScoreRecordV2 | PromptPackScoreRecordV3;

export interface PromptPackHumanReviewRecordV2 {
  reviewId: string;
  packId: string;
  testId: string;
  runId: string;
  autoScoreId?: string;
  reviewerId: string;
  scores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
  applicability: Partial<Record<PromptPackScoreDimensionV2, boolean>>;
  notes?: string;
  overrideVerdict?: PromptPackVerdict;
  createdAt: string;
}

export interface PromptPackLatestAssessmentRecordV2 {
  testId: string;
  runId?: string;
  autoScore?: PromptPackAutoScoreRecord;
  humanReview?: PromptPackHumanReviewRecordV2;
  legacyScore?: PromptPackScoreRecord;
  currentGeneration?: boolean;
  scoreState: PromptPackScoreState;
  autoVerdict?: PromptPackVerdict;
  effectiveVerdict?: PromptPackVerdict;
}

export interface PromptPackAutoScoreRequest {
  runId?: string;
  providerId?: string;
  model?: string;
  force?: boolean;
  scoringSchemaVersion?: PromptPackScoringSchemaVersion;
}

export interface PromptPackAutoScoreResult {
  score: PromptPackAutoScoreRecord;
  legacyScore?: PromptPackScoreRecord;
  run: PromptPackRunRecord;
}

export interface PromptPackAutoScoreBatchResult {
  items: PromptPackAutoScoreResult[];
  skipped: number;
}

export interface PromptPackReportRecord {
  pack: PromptPackRecord;
  tests: PromptPackTestRecord[];
  runs: PromptPackRunRecord[];
  scores: PromptPackScoreRecord[];
  autoScoresV2: PromptPackAutoScoreRecord[];
  humanReviewsV2: PromptPackHumanReviewRecordV2[];
  latestAssessments: PromptPackLatestAssessmentRecordV2[];
  summary: {
    totalTests: number;
    completedRuns: number;
    failedRuns: number;
    runFailureCount: number;
    invalidLatestRuns: number;
    scoreFailureCount: number;
    needsScoreCount: number;
    staleLatestAutoScoreCount: number;
    durableRuns?: number;
    approvalPausedRuns?: number;
    backgroundedRuns?: number;
    judgeFallbackCount: number;
    judgeErrorCount: number;
    autoScoredRuns: number;
    humanReviewedRuns: number;
    degradedScoreCount: number;
    passCount: number;
    failCount: number;
    reviewCount: number;
    effectivePassRate: number;
    reviewRate: number;
    activeScoringSchemaVersion: PromptPackScoringSchemaVersion;
    attributionBreakdown?: Array<{
      attribution: PromptPackFailureAttributionCode;
      count: number;
    }>;
    passThreshold: number;
    averageTotalScore: number;
    averageWeightedScore: number;
    passRate: number;
    failingCodes: string[];
  };
}

export interface PromptPackBenchmarkProviderInput {
  providerId: string;
  model: string;
}

export interface PromptPackBenchmarkRunRequest {
  testCodes?: string[];
  allTests?: boolean;
  providers: PromptPackBenchmarkProviderInput[];
  executionStyle?: PromptPackExecutionStyle;
}

export interface PromptPackBenchmarkRunRecord {
  benchmarkRunId: string;
  packId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  testCodes: string[];
  providers: PromptPackBenchmarkProviderInput[];
  executionStyle?: PromptPackExecutionStyle;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface PromptPackBenchmarkItemRecord {
  itemId: string;
  benchmarkRunId: string;
  packId: string;
  testId: string;
  testCode: string;
  providerId: string;
  model: string;
  runId?: string;
  scoreId?: string;
  autoScoreId?: string;
  runStatus: PromptPackRunRecord["status"] | "missing_run";
  totalScore?: number;
  weightedScore?: number;
  verdict?: PromptPackVerdict;
  scoreState?: PromptPackScoreState;
  failureSignal?: string;
  createdAt: string;
}

export interface PromptPackBenchmarkModelSummary {
  providerId: string;
  model: string;
  total: number;
  scored: number;
  averageTotalScore: number;
  averageWeightedScore: number;
  passRate: number;
  reviewRate: number;
  runFailures: number;
  degradedCount: number;
  approvalPausedCount: number;
  noOutputCount: number;
  topFailureSignals: Array<{
    signal: string;
    count: number;
  }>;
}

export interface PromptPackBenchmarkStatusRecord {
  run: PromptPackBenchmarkRunRecord;
  progress: {
    totalItems: number;
    completedItems: number;
  };
  modelSummaries: PromptPackBenchmarkModelSummary[];
}

export interface ReplayRegressionRun {
  regressionRunId: string;
  packId: string;
  status: "queued" | "running" | "completed" | "failed";
  testCodes: string[];
  /** ISO-8601 timestamp selecting the latest scored baseline run at or before this instant. */
  baselineRef?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface ReplayRegressionResult {
  resultId: string;
  regressionRunId: string;
  testCode: string;
  capability: "routing" | "honesty" | "handoff" | "robustness" | "usability";
  scoreDelta: number;
  passDelta: number;
  latencyDeltaMs: number;
  createdAt: string;
}

export interface CapabilityTrendSeries {
  capability:
    | "taskSuccess"
    | "honesty"
    | "executionQuality"
    | "robustness"
    | "usability"
    | "run_failure_rate"
    | "review_rate";
  points: Array<{
    timestamp: string;
    value: number;
  }>;
  threshold?: number;
  breached?: boolean;
}

export interface PromptPackExportRecord {
  packId: string;
  /** Stable current report path, kept for backward-compatible export consumers. */
  path: string;
  exists: boolean;
  sizeBytes: number;
  updatedAt?: string;
  latestPath?: string;
  archiveDir?: string;
  latestSnapshotPath?: string;
  latestSnapshotExists?: boolean;
  latestSnapshotSizeBytes?: number;
  latestSnapshotUpdatedAt?: string;
  snapshotCount?: number;
}

export const DEFAULT_PROMPT_PACK_POLICY_V2: PromptPackPolicyV2 = {
  scoringSchemaVersion: "v2",
  threshold: 75,
  weights: {
    taskSuccess: 35,
    honesty: 25,
    executionQuality: 20,
    robustness: 15,
    usability: 5,
  },
  minScores: {
    taskSuccess: 3,
    honesty: 2,
  },
  judgeRequired: true,
  reviewOnDisagreementAt: 2,
  criticalDimensionsMustBeApplicable: true,
  hardFailSignals: [
    "tool_tier_violation",
    "unsupported_access_claim",
    "run_failed",
    "approval_paused",
    "missing_required_json",
    "missing_required_table",
    "missing_required_citation_evidence",
  ],
};

export const DEFAULT_PROMPT_PACK_POLICY_V3: PromptPackPolicyV3 = {
  scoringSchemaVersion: "v3",
  threshold: 78,
  weights: {
    taskSuccess: 25,
    truthfulness: 20,
    evidenceGrounding: 12,
    formatAdherence: 10,
    operatorUsefulness: 12,
    toolUseQuality: 8,
    orchestrationQuality: 6,
    efficiency: 3,
    recoveryQuality: 4,
  },
  minScores: {
    taskSuccess: 3,
    truthfulness: 3,
    evidenceGrounding: 2,
  },
  judgeRequired: true,
  reviewOnDisagreementAt: 2,
  criticalDimensionsMustBeApplicable: true,
  hardFailSignals: [
    "tool_tier_violation",
    "unsupported_access_claim",
    "run_failed",
    "approval_paused",
    "missing_required_json",
    "missing_required_table",
    "missing_required_citation_evidence",
  ],
  attributionRequiredFor: ["review", "fail"],
};
