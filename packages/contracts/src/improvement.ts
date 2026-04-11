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

export type RepairValidationStatus = "not_started" | "queued" | "running" | "needs_review" | "passed" | "failed";

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

export type ImprovementCandidateKind = "repair_policy" | "routing_policy";

export type ImprovementSignalOrigin = "runtime" | "human" | "evaluation" | "improvement_internal";

export type ImprovementSignalClass = "runtime" | "approval" | "evaluation";

export type ImprovementSignalOutcome = "positive" | "negative" | "neutral";

export type ImprovementSignalSeverity = "low" | "medium" | "high";

export type ImprovementEvidenceRefType =
  | "durable_run"
  | "approval"
  | "prompt_pack_run"
  | "prompt_pack_benchmark"
  | "decision_replay_run"
  | "repair_candidate"
  | "artifact_manifest";

export type ImprovementCandidateStatus =
  | "proposed"
  | "evaluating"
  | "ready_for_approval"
  | "approval_pending"
  | "approved"
  | "rejected"
  | "superseded";

export type ImprovementEvaluationStatus = "queued" | "running" | "passed" | "failed";

export type ImprovementEvaluationKind = "repair_replay_validation" | "prompt_lab_regression" | "prompt_lab_benchmark";

export type ImprovementActivationStatus = "pending" | "active" | "paused" | "rolled_back" | "failed";

export type ImprovementActivationWatchStatus = "watching" | "stable" | "alerting" | "paused" | "failed";

export type ImprovementActorType = "system" | "operator" | "service" | "approval";

export interface ImprovementRef {
  refType: string;
  refId: string;
  hash?: string;
  metadata?: Record<string, unknown>;
}

export interface ImprovementEvidenceRef extends ImprovementRef {
  refType: ImprovementEvidenceRefType;
}

export interface ImprovementSignalRecord {
  signalId: string;
  schemaVersion: string;
  sourceService: string;
  sourceType: string;
  sourceId: string;
  sourceEventId: string;
  idempotencyKey: string;
  workspaceId: string;
  occurredAt: string;
  recordedAt: string;
  origin: ImprovementSignalOrigin;
  signalClass: ImprovementSignalClass;
  signalKind: string;
  outcome: ImprovementSignalOutcome;
  fingerprint: string;
  sessionId?: string;
  turnId?: string;
  durableRunId?: string;
  approvalId?: string;
  taskId?: string;
  toolName?: string;
  capabilityId?: string;
  memoryItemId?: string;
  severity?: ImprovementSignalSeverity;
  costDeltaUsd?: number;
  latencyDeltaMs?: number;
  scoreDelta?: number;
  evidenceRefs: ImprovementEvidenceRef[];
  metadata?: Record<string, unknown>;
}

export interface ImprovementCandidateRecord {
  candidateId: string;
  workspaceId: string;
  kind: ImprovementCandidateKind;
  status: ImprovementCandidateStatus;
  targetKey: string;
  fingerprint: string;
  summary: string;
  currentRevisionId?: string;
  supportingSignalCount: number;
  negativeSignalCount: number;
  severity?: ImprovementSignalSeverity;
  suppressionUntil?: string;
  latestSignalAt?: string;
  createdAt: string;
  updatedAt: string;
  createdByActorId?: string;
  createdByActorType?: ImprovementActorType;
  updatedByActorId?: string;
  updatedByActorType?: ImprovementActorType;
}

export interface ImprovementCandidateRevisionRecord {
  revisionId: string;
  candidateId: string;
  candidateRef: ImprovementRef;
  changeHash: string;
  createdAt: string;
  createdByActorId: string;
  createdByActorType: ImprovementActorType;
}

export interface ImprovementEvaluationRecord {
  evaluationId: string;
  candidateId: string;
  revisionId: string;
  status: ImprovementEvaluationStatus;
  baselineRef: ImprovementRef;
  candidateRef: ImprovementRef;
  evaluatorKind: ImprovementEvaluationKind;
  evaluatorVersion: string;
  datasetOrPackRef?: ImprovementRef;
  changeHash: string;
  metrics: Record<string, number>;
  resultSummary: string;
  createdAt: string;
  completedAt?: string;
  createdByActorId: string;
  createdByActorType: ImprovementActorType;
  completedByActorId?: string;
  completedByActorType?: ImprovementActorType;
}

export interface ImprovementActivationRecord {
  activationId: string;
  candidateId: string;
  revisionId: string;
  approvalId: string;
  status: ImprovementActivationStatus;
  scope: "workspace";
  activationTarget: ImprovementRef;
  preActivationSnapshot: ImprovementRef;
  appliedChangeHash: string;
  watchStatus: ImprovementActivationWatchStatus;
  watchStartedAt?: string;
  watchEndsAt?: string;
  watchSignalTarget: number;
  watchSignalCount: number;
  regressionCount: number;
  createdAt: string;
  updatedAt: string;
  requestedByActorId: string;
  requestedByActorType: ImprovementActorType;
  approvedByActorId?: string;
  approvedByActorType?: ImprovementActorType;
  pausedByActorId?: string;
  pausedByActorType?: ImprovementActorType;
  rolledBackByActorId?: string;
  rolledBackByActorType?: ImprovementActorType;
  stableAt?: string;
  pausedAt?: string;
  rolledBackAt?: string;
  failureReason?: string;
}

export interface ImprovementAttemptManifestSummary {
  signalId?: string;
  durableRunId?: string;
  promptSnapshotHash?: string;
  providerId?: string;
  model?: string;
  toolSpans?: Array<{
    toolName: string;
    status?: string;
    failureClass?: string;
  }>;
  outputSummary?: string;
  replayRefs?: ImprovementRef[];
  evalRefs?: ImprovementRef[];
}

export interface ImprovementCandidateDetailResponse {
  candidate: ImprovementCandidateRecord;
  currentRevision?: ImprovementCandidateRevisionRecord;
  supportingSignals: ImprovementSignalRecord[];
  latestEvaluation?: ImprovementEvaluationRecord;
  latestActivation?: ImprovementActivationRecord;
  attemptManifestSummary: ImprovementAttemptManifestSummary[];
}
