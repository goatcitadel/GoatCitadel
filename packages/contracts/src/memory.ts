export type MemoryContextScope = "chat" | "orchestration";
export type MemoryQmdStatus = "generated" | "cache_hit" | "fallback" | "failed";
export type MemoryRelationScope = "self" | "peer" | "project";
export type MemoryFreshness = "fresh" | "recent" | "stale" | "unknown";
export type MemoryEngineeringKind = "working" | "episodic" | "semantic" | "procedural";
export type MemoryRetrievalStrategy = "lexical_recency" | "semantic_hints" | "semantic_vector" | "hybrid_rank";
export type MemoryRetrievalModeStatus =
  | "disabled"
  | "fallback_only"
  | "lexical_recency"
  | "semantic_hints"
  | "semantic_vector"
  | "hybrid_rank";
export type MemoryRerankStatus = "none" | "hybrid_rank" | "distillation";
export type MemoryFallbackModeStatus =
  | "disabled"
  | "available"
  | "short_prompt_or_disabled"
  | "no_candidates"
  | "distiller_fallback";
export type MemoryEmbeddingProfileStatus = "active" | "fallback" | "unavailable";
export type MemoryEmbeddingProfileSource = "default" | "environment" | "request";

export interface MemoryEmbeddingProfile {
  profileId: string;
  provider: string;
  modelId: string;
  dimensions: number;
  version: string;
  status: MemoryEmbeddingProfileStatus;
  source: MemoryEmbeddingProfileSource;
  requestedProvider?: string;
  fallbackReason?: string;
}

export interface MemoryEmbeddingProfileRequest {
  provider?: string;
  modelId?: string;
  dimensions?: number;
  profileId?: string;
}

export interface MemoryRetrievalMatchSignals {
  lexicalScore: number;
  lexicalBm25Score?: number;
  semanticHintScore: number;
  semanticVectorScore?: number;
  embeddingScore?: number;
  embeddingStatus?: "used" | "missing" | "invalid" | "dimension_mismatch";
  embeddingDimensions?: {
    query?: number;
    candidate?: number;
  };
  recencyScore: number;
  diversityScore: number;
  totalScore: number;
}

export interface MemoryContextComposeRequest {
  scope: MemoryContextScope;
  prompt: string;
  signal?: AbortSignal;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  phaseId?: string;
  citadelId?: string;
  workspaceId?: string;
  workspace?: string;
  relationScope?: MemoryRelationScope;
  maxContextTokens?: number;
  forceRefresh?: boolean;
  queryEmbedding?: number[];
}

export interface MemoryContextAssemblyReport {
  availableCandidateCount: number;
  selectedCandidateCount: number;
  droppedCandidateCount: number;
  availableTokenEstimate: number;
  selectedTokenEstimate: number;
  evidenceTokenBudget: number;
}

export interface MemoryContextPlacement {
  position: "before_final_user_message" | "after_leading_system_messages";
  insertedIndex: number;
  finalUserMessageIndex?: number;
  leadingSystemMessageCount: number;
  copyMode: "retrieved_non_authoritative";
}

export interface MemoryContextQuality {
  status: MemoryQmdStatus;
  reason?: string;
  assembly?: MemoryContextAssemblyReport;
}

export interface MemoryCitationProvenance {
  relationScope: MemoryRelationScope;
  freshness: MemoryFreshness;
  selectionReason: string;
  retrievalStrategy?: MemoryRetrievalStrategy;
  matchSignals?: MemoryRetrievalMatchSignals;
  sourceTimestamp?: string;
}

export interface MemoryCitation {
  candidateId: string;
  sourceType: "transcript" | "file" | "memory_item";
  sourceRef: string;
  snippet?: string;
  score: number;
  provenance?: MemoryCitationProvenance;
}

export interface MemoryContextPack {
  contextId: string;
  scope: MemoryContextScope;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  phaseId?: string;
  relationScope?: MemoryRelationScope;
  queryHash: string;
  sourcesHash: string;
  contextText: string;
  citations: MemoryCitation[];
  quality: MemoryContextQuality;
  originalTokenEstimate: number;
  distilledTokenEstimate: number;
  createdAt: string;
  expiresAt: string;
}

export interface MemoryQmdRunRecord {
  runEventId: string;
  scope: MemoryContextScope;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  phaseId?: string;
  status: MemoryQmdStatus;
  providerId?: string;
  model?: string;
  durationMs: number;
  candidateCount: number;
  citationsCount: number;
  originalTokenEstimate: number;
  distilledTokenEstimate: number;
  savingsPercent: number;
  errorText?: string;
  createdAt: string;
}

export interface MemoryQmdStatsResponse {
  from: string;
  to: string;
  totalRuns: number;
  generatedRuns: number;
  cacheHitRuns: number;
  fallbackRuns: number;
  failedRuns: number;
  originalTokenEstimate: number;
  distilledTokenEstimate: number;
  savingsPercent: number;
  netTokenDelta: number;
  compressionPercent: number;
  expansionPercent: number;
  efficiencyLabel: "reduced" | "expanded" | "neutral";
}

export interface MemoryRetrievalBenchmarkRequest {
  prompts: string[];
  workspace?: string;
  relationScope?: MemoryRelationScope;
  maxContextTokens?: number;
}

export interface MemoryRetrievalBenchmarkItem {
  prompt: string;
  status: "completed" | "failed";
  latencyMs: number;
  contextId?: string;
  citationsCount: number;
  originalTokenEstimate: number;
  distilledTokenEstimate: number;
  overlapScore: number;
  retrievalStrategy?: MemoryRetrievalStrategy;
  semanticCoverageNote?: string;
  qmdStatus?: MemoryQmdStatus;
  error?: string;
}

export interface MemoryRetrievalBenchmarkResponse {
  generatedAt: string;
  itemCount: number;
  avgLatencyMs: number;
  avgOverlapScore: number;
  retrievalStrategies: MemoryRetrievalStrategy[];
  semanticCoverageNote: string;
  items: MemoryRetrievalBenchmarkItem[];
  warnings: string[];
}

export interface MemoryRetrievalStatusResponse {
  checkedAt: string;
  enabled: boolean;
  retrievalMode: MemoryRetrievalModeStatus;
  rerankAvailable: boolean;
  rerankMode: MemoryRerankStatus;
  fallbackMode: MemoryFallbackModeStatus;
  lastRefresh?: string;
  lastError?: string;
  qmd: {
    enabled: boolean;
    applyToChat: boolean;
    applyToOrchestration: boolean;
    minPromptChars: number;
    cacheTtlSeconds: number;
    distillerProviderId?: string;
    distillerModel?: string;
    distillerTimeoutMs: number;
  };
  recent: {
    totalRuns: number;
    generatedRuns: number;
    cacheHitRuns: number;
    fallbackRuns: number;
    failedRuns: number;
    retrievalStrategies: MemoryRetrievalStrategy[];
  };
}

export type ContextManifestScope = "chat_turn";
export type ContextManifestEntryKind = "system_message" | "memory_context";

export interface ContextManifestRecord {
  manifestId: string;
  scope: ContextManifestScope;
  turnId: string;
  sessionId?: string;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  entryCount: number;
}

export interface ContextManifestEntryRecord {
  entryId: string;
  manifestId: string;
  kind: ContextManifestEntryKind;
  entryIndex: number;
  title?: string;
  sourceRef?: string;
  contentText?: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ContextManifestDetail {
  manifest: ContextManifestRecord;
  entries: ContextManifestEntryRecord[];
}

export type MemoryItemStatus = "active" | "forgotten";
export type MemoryItemLifecycleState = "active" | "expired" | "forgotten";
export type StructuredMemoryScope = "global" | "workspace" | "session" | "run";
export type StructuredMemoryStatus = "active" | "forgotten" | "superseded";
export type StructuredMemoryAuthority = "operator" | "agent_proposed" | "trusted_lifecycle" | "imported_skill";

export interface StructuredMemorySourceRef {
  sourceType: "manual" | "memory_item" | "session" | "run" | "artifact" | "summary" | "turn" | "external";
  sourceRef: string;
  title?: string;
}

export interface StructuredMemoryLineage {
  sourceTurnId?: string;
  sourceRunId?: string;
  sourceSummaryRef?: string;
  mentionCount?: number;
  freshness?: MemoryFreshness;
  supersedesIds?: string[];
  forgottenByChangeId?: string;
}

export interface StructuredMemoryBaseRecord {
  id: string;
  workspaceId: string;
  scope: StructuredMemoryScope;
  title: string;
  status: StructuredMemoryStatus;
  confidence: number;
  sourceRefs: StructuredMemorySourceRef[];
  metadata: Record<string, unknown>;
  authority: StructuredMemoryAuthority;
  lineage?: StructuredMemoryLineage;
  createdAt: string;
  updatedAt: string;
  forgottenAt?: string;
  supersededById?: string;
}

export interface MemoryEntityRecord extends StructuredMemoryBaseRecord {
  entityType: string;
  aliases: string[];
  summary?: string;
}

export interface MemoryRelationRecord extends StructuredMemoryBaseRecord {
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  degradedReason?: string;
}

export interface MemoryDecisionRetrospective {
  reviewedAt: string;
  outcome: "unknown" | "validated" | "partially_validated" | "invalidated";
  notes: string;
  improvementCandidateId?: string;
}

export interface MemoryDecisionRecord extends StructuredMemoryBaseRecord {
  decision: string;
  alternatives: string[];
  rationale: string;
  expectedOutcome?: string;
  reviewAt?: string;
  retrospective?: MemoryDecisionRetrospective;
  linkedEntityIds: string[];
  linkedRelationIds: string[];
  sessionId?: string;
  runId?: string;
  improvementCandidateId?: string;
}

export interface MemoryEntityInput {
  workspaceId?: string;
  scope?: StructuredMemoryScope;
  title: string;
  entityType?: string;
  aliases?: string[];
  summary?: string;
  confidence?: number;
  sourceRefs?: StructuredMemorySourceRef[];
  metadata?: Record<string, unknown>;
  authority?: StructuredMemoryAuthority;
}

export interface MemoryRelationInput {
  workspaceId?: string;
  scope?: StructuredMemoryScope;
  title?: string;
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  confidence?: number;
  sourceRefs?: StructuredMemorySourceRef[];
  metadata?: Record<string, unknown>;
  authority?: StructuredMemoryAuthority;
}

export interface MemoryDecisionInput {
  workspaceId?: string;
  scope?: StructuredMemoryScope;
  title?: string;
  decision: string;
  alternatives?: string[];
  rationale: string;
  expectedOutcome?: string;
  reviewAt?: string;
  linkedEntityIds?: string[];
  linkedRelationIds?: string[];
  sessionId?: string;
  runId?: string;
  confidence?: number;
  sourceRefs?: StructuredMemorySourceRef[];
  metadata?: Record<string, unknown>;
  authority?: StructuredMemoryAuthority;
}

export interface MemoryDecisionRetrospectiveInput {
  outcome: MemoryDecisionRetrospective["outcome"];
  notes: string;
  improvementCandidateId?: string;
}

export type MemoryLearningType = "workflow" | "bug_pattern" | "operator_preference" | "repo_fact" | "tooling";
export type MemoryLearningStatus = "proposed" | "trusted" | "superseded" | "forgotten";

export interface MemoryLearningFileRef {
  path: string;
  contentHash?: string;
}

export interface MemoryLearningRecord {
  learningId: string;
  workspaceId: string;
  key: string;
  type: MemoryLearningType;
  insight: string;
  confidence: number;
  status: MemoryLearningStatus;
  sourceRefs: StructuredMemorySourceRef[];
  fileRefs: MemoryLearningFileRef[];
  authority: StructuredMemoryAuthority;
  supersededById?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryLearningInput {
  workspaceId?: string;
  key: string;
  type?: MemoryLearningType;
  insight: string;
  confidence?: number;
  sourceRefs?: StructuredMemorySourceRef[];
  fileRefs?: MemoryLearningFileRef[];
  authority?: StructuredMemoryAuthority;
}

export interface MemoryLearningStalenessIssue {
  learningId: string;
  path?: string;
  issue: "missing_file" | "changed_hash" | "stale_source_ref" | "low_confidence" | "likely_contradiction";
  message: string;
}

export interface MemoryLearningStalenessReport {
  checkedAt: string;
  issues: MemoryLearningStalenessIssue[];
}

export type MemoryFeedbackKind = "stale" | "missing" | "irrelevant" | "useful";
export type MemoryFeedbackStatus = "open" | "reviewed" | "dismissed";
export type MemoryFeedbackTargetKind =
  | "context"
  | "citation"
  | "memory_item"
  | "entity"
  | "relation"
  | "decision"
  | "learning"
  | "trace_candidate";

export interface MemoryFeedbackInput {
  workspaceId?: string;
  kind: MemoryFeedbackKind;
  targetKind: MemoryFeedbackTargetKind;
  targetRef?: string;
  contextId?: string;
  citationId?: string;
  note?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryFeedbackRecord extends MemoryFeedbackInput {
  feedbackId: string;
  workspaceId: string;
  status: MemoryFeedbackStatus;
  actorId?: string;
  createdAt: string;
  updatedAt: string;
}

export type MemoryQualityIssueKind =
  | "stale_low_value"
  | "near_duplicate"
  | "likely_contradiction"
  | "source_drift"
  | "retrieval_gap";
export type MemoryQualityIssueStatus = "open" | "resolved" | "dismissed";
export type MemoryQualityIssueSeverity = "low" | "medium" | "high";

export interface MemoryQualityIssueInput {
  workspaceId?: string;
  kind: MemoryQualityIssueKind;
  severity?: MemoryQualityIssueSeverity;
  targetKind: MemoryFeedbackTargetKind;
  targetRef: string;
  relatedRefs?: string[];
  evidenceRefs?: StructuredMemorySourceRef[];
  summary: string;
  rationale?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryQualityIssueRecord {
  issueId: string;
  workspaceId: string;
  kind: MemoryQualityIssueKind;
  status: MemoryQualityIssueStatus;
  severity: MemoryQualityIssueSeverity;
  targetKind: MemoryFeedbackTargetKind;
  targetRef: string;
  relatedRefs: string[];
  evidenceRefs: StructuredMemorySourceRef[];
  summary: string;
  rationale?: string;
  metadata: Record<string, unknown>;
  dedupKey: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

export interface MemoryQualityIssueListRequest {
  workspaceId?: string;
  kind?: MemoryQualityIssueKind | "all";
  status?: MemoryQualityIssueStatus | "all";
  targetKind?: MemoryFeedbackTargetKind;
  limit?: number;
}

export interface MemoryQualityIssuePatchInput {
  status: MemoryQualityIssueStatus;
  resolutionNote?: string;
}

export interface MemoryQualityScanRequest {
  workspaceId?: string;
  limit?: number;
  dryRun?: boolean;
}

export interface MemoryQualityScanResponse {
  generatedAt: string;
  workspaceId: string;
  scannedCount: number;
  issueCount: number;
  createdCount: number;
  updatedCount: number;
  dryRun: boolean;
  issues: MemoryQualityIssueRecord[];
  warnings: string[];
}

export type TraceMemoryCandidateType =
  | "fact"
  | "decision"
  | "tool_outcome"
  | "operator_preference"
  | "repo_fact"
  | "workflow";
export type TraceMemoryCandidateStatus = "proposed" | "rejected" | "promoted";

export interface TraceMemoryCandidateInput {
  workspaceId?: string;
  candidateType?: TraceMemoryCandidateType;
  sourceText?: string;
  sourceSessionId?: string;
  sourceRunId?: string;
  sourceTurnId?: string;
  toolCallId?: string;
  proposedInsight: string;
  confidence?: number;
  sourceRefs?: StructuredMemorySourceRef[];
  metadata?: Record<string, unknown>;
}

export interface TraceMemoryCandidateRecord extends TraceMemoryCandidateInput {
  candidateId: string;
  workspaceId: string;
  candidateType: TraceMemoryCandidateType;
  status: TraceMemoryCandidateStatus;
  sourceText: string;
  confidence: number;
  sourceRefs: StructuredMemorySourceRef[];
  authority: Extract<StructuredMemoryAuthority, "agent_proposed">;
  actorId?: string;
  promotedLearningId?: string;
  createdAt: string;
  updatedAt: string;
}

export type MemoryRecallMode = "targeted" | "summary" | "post_compaction_resume";

export interface MemoryRecallRequest {
  mode: MemoryRecallMode;
  scope?: MemoryContextScope;
  prompt?: string;
  workspace?: string;
  workspaceId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  phaseId?: string;
  relationScope?: MemoryRelationScope;
  maxContextTokens?: number;
  limit?: number;
  queryEmbedding?: number[];
}

export interface MemoryRecallResponse {
  mode: MemoryRecallMode;
  generatedAt: string;
  summary: string;
  context?: MemoryContextPack;
  recentContexts: MemoryContextPack[];
  feedback: MemoryFeedbackRecord[];
  traceCandidates: TraceMemoryCandidateRecord[];
  qualityIssues: MemoryQualityIssueRecord[];
  warnings: string[];
}

export interface MemoryItemRecord {
  itemId: string;
  namespace: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  pinned: boolean;
  ttlOverrideSeconds?: number;
  expiresAt?: string;
  status: MemoryItemStatus;
  lifecycleState: MemoryItemLifecycleState;
  /** Citadel/workspace scope. Undefined means a global memory item (visible to every workspace). */
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
  forgottenAt?: string;
}

export interface MemoryLifecyclePatch {
  title?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  pinned?: boolean;
  ttlOverrideSeconds?: number | null;
}

/**
 * Upper bound on operations in one atomic batch mutation request. Mirrors the
 * gateway's request schema (routes/memory.ts) and MemoryLifecycleService guard
 * so clients can fail fast — or disable batch verbs — before submitting.
 */
export const MEMORY_BATCH_MAX_OPERATIONS = 100;

export type MemoryBatchMutationOperationKind = "patch_item" | "forget_item";
export type MemoryActionLedgerOperationKind = MemoryBatchMutationOperationKind | "mixed";
export type MemoryActionLedgerStatus = "applied" | "failed" | "rejected";

export interface MemoryBatchPatchItemMutation {
  kind: "patch_item";
  itemId: string;
  patch: MemoryLifecyclePatch;
}

export interface MemoryBatchForgetItemMutation {
  kind: "forget_item";
  itemId: string;
}

export type MemoryBatchMutationOperation = MemoryBatchPatchItemMutation | MemoryBatchForgetItemMutation;

export interface MemoryBatchMutationRequest {
  actionId?: string;
  source?: string;
  operations: MemoryBatchMutationOperation[];
}

export interface MemoryActionLedgerNote {
  feasible: boolean;
  note: string;
}

export interface MemoryActionLedgerEvidence {
  storesRawContent: boolean;
  redactionNote: string;
  changedFields?: Record<string, string[]>;
  failureReason?: string;
}

export interface MemoryActionLedgerEntry {
  actionId: string;
  ownerId: string;
  source: string;
  timestamp: string;
  status: MemoryActionLedgerStatus;
  targetItemIds: string[];
  operationKind: MemoryActionLedgerOperationKind;
  operationCount: number;
  reversal: MemoryActionLedgerNote;
  reapply: MemoryActionLedgerNote;
  evidence: MemoryActionLedgerEvidence;
}

export interface MemoryBatchMutationResult {
  operationIndex: number;
  kind: MemoryBatchMutationOperationKind;
  itemId: string;
  status: "applied";
  item: MemoryItemRecord;
}

export interface MemoryBatchMutationResponse {
  actionId: string;
  status: Extract<MemoryActionLedgerStatus, "applied">;
  appliedCount: number;
  targetItemIds: string[];
  results: MemoryBatchMutationResult[];
  ledger: MemoryActionLedgerEntry;
}

export interface MemoryChangeEvent {
  changeId: string;
  itemId: string;
  changeType: "created" | "updated" | "forgotten" | "ttl_changed" | "pin_changed" | "retrospective_added";
  actorId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type MemoryMaintenanceRunMode = "manual" | "scheduled" | "hybrid";
export type MemoryMaintenanceTimingStrategy = "fixed" | "recommendation_first";
export type MemoryMaintenanceExecutionTarget = "auto" | "local" | "cloud";
export type MemoryMaintenanceUnavailableModelPolicy = "skip" | "error";
export type MemoryMaintenanceTriggerSource = "manual" | "scheduled" | "hybrid_due" | "recommendation";
export type MemoryMaintenanceRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "skipped";
export type MemoryMaintenanceRecommendationStatus = "queued" | "accepted" | "rejected" | "applied";
export type MemoryMaintenanceSourceKind = "transcript" | "file" | "memory_item" | "artifact";
export type MemoryMaintenanceChangeKind = "created" | "updated" | "mirrored";
export type MemoryMaintenanceTargetKind = "file" | "memory_item";
export type MemoryMaintenanceRecommendationKind =
  | "schedule_adjustment"
  | "threshold_adjustment"
  | "execution_target_adjustment"
  | "model_adjustment";

export interface MemoryMaintenanceSchedule {
  frequency: "daily" | "weekly";
  hour: number;
  minute: number;
  weekday?: number;
}

export interface MemoryMaintenancePolicyRecord {
  workspaceId: string;
  enabled: boolean;
  runMode: MemoryMaintenanceRunMode;
  timingStrategy: MemoryMaintenanceTimingStrategy;
  schedule?: MemoryMaintenanceSchedule;
  timeZone: string;
  minHoursSinceLastSuccess: number;
  minChangedSessions: number;
  providerId?: string;
  model?: string;
  executionTarget: MemoryMaintenanceExecutionTarget;
  unavailableModelPolicy: MemoryMaintenanceUnavailableModelPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryMaintenanceStateRecord {
  workspaceId: string;
  lastEligibilityAt?: string;
  lastSuccessfulRunAt?: string;
  changedSessionCount: number;
  activeRunId?: string;
  lastRecommendationAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryMaintenanceRunRecord {
  runId: string;
  durableRunId?: string;
  workspaceId: string;
  triggerSource: MemoryMaintenanceTriggerSource;
  status: MemoryMaintenanceRunStatus;
  providerId?: string;
  model?: string;
  policySnapshot: Record<string, unknown>;
  sourceSessionCount: number;
  changedArtifactCount: number;
  summary?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface MemoryMaintenanceRunSourceRecord {
  sourceId: string;
  runId: string;
  sourceKind: MemoryMaintenanceSourceKind;
  sourceRef: string;
  modifiedAt?: string;
  excerpt?: string;
  tokenEstimate?: number;
  createdAt: string;
}

export interface MemoryMaintenanceChangeRecord {
  changeId: string;
  runId: string;
  changeKind: MemoryMaintenanceChangeKind;
  targetKind: MemoryMaintenanceTargetKind;
  targetRef: string;
  beforeRef?: string;
  afterRef?: string;
  summary: string;
  createdAt: string;
}

export interface MemoryMaintenanceRecommendationRecord {
  recommendationId: string;
  workspaceId: string;
  kind: MemoryMaintenanceRecommendationKind;
  status: MemoryMaintenanceRecommendationStatus;
  summary: string;
  proposedPatch: Record<string, unknown>;
  rationale?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

export interface MemoryMaintenanceStatusRecord {
  workspaceId: string;
  policy: MemoryMaintenancePolicyRecord;
  state: MemoryMaintenanceStateRecord;
  lastRun?: MemoryMaintenanceRunRecord;
  nextDueAt?: string;
}

export interface MemoryMaintenancePolicyPatchInput {
  enabled?: boolean;
  runMode?: MemoryMaintenanceRunMode;
  timingStrategy?: MemoryMaintenanceTimingStrategy;
  schedule?: MemoryMaintenanceSchedule | null;
  timeZone?: string;
  minHoursSinceLastSuccess?: number;
  minChangedSessions?: number;
  providerId?: string | null;
  model?: string | null;
  executionTarget?: MemoryMaintenanceExecutionTarget;
  unavailableModelPolicy?: MemoryMaintenanceUnavailableModelPolicy;
}

export interface MemoryMaintenanceRunNowInput {
  workspaceId: string;
  triggerSource?: Extract<MemoryMaintenanceTriggerSource, "manual" | "recommendation">;
}

export interface MemoryMaintenanceProvenanceRecord {
  run: MemoryMaintenanceRunRecord;
  sources: MemoryMaintenanceRunSourceRecord[];
  changes: MemoryMaintenanceChangeRecord[];
}

export function deriveMemoryItemLifecycleState(
  input: {
    status: MemoryItemStatus;
    expiresAt?: string;
    forgottenAt?: string;
  },
  now: string | Date = new Date(),
): MemoryItemLifecycleState {
  if (input.status === "forgotten" || input.forgottenAt) {
    return "forgotten";
  }
  if (!input.expiresAt) {
    return "active";
  }
  const expiresAtMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return "active";
  }
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (!Number.isFinite(nowMs)) {
    return "active";
  }
  return expiresAtMs <= nowMs ? "expired" : "active";
}
