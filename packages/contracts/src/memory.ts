export type MemoryContextScope = "chat" | "orchestration";
export type MemoryQmdStatus = "generated" | "cache_hit" | "fallback" | "failed";

export interface MemoryContextComposeRequest {
  scope: MemoryContextScope;
  prompt: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  phaseId?: string;
  workspace?: string;
  maxContextTokens?: number;
  forceRefresh?: boolean;
}

export interface MemoryCitation {
  candidateId: string;
  sourceType: "transcript" | "file";
  sourceRef: string;
  snippet?: string;
  score: number;
}

export interface MemoryContextPack {
  contextId: string;
  scope: MemoryContextScope;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  phaseId?: string;
  queryHash: string;
  sourcesHash: string;
  contextText: string;
  citations: MemoryCitation[];
  quality: {
    status: MemoryQmdStatus;
    reason?: string;
  };
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

export interface MemoryItemRecord {
  itemId: string;
  namespace: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  pinned: boolean;
  ttlOverrideSeconds?: number;
  expiresAt?: string;
  status: "active" | "forgotten";
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

export interface MemoryChangeEvent {
  changeId: string;
  itemId: string;
  changeType: "created" | "updated" | "forgotten" | "ttl_changed" | "pin_changed";
  actorId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type MemoryMaintenanceRunMode = "manual" | "scheduled" | "hybrid";
export type MemoryMaintenanceTimingStrategy = "fixed" | "recommendation_first";
export type MemoryMaintenanceExecutionTarget = "auto" | "local" | "cloud";
export type MemoryMaintenanceUnavailableModelPolicy = "skip" | "error";
export type MemoryMaintenanceTriggerSource = "manual" | "scheduled" | "hybrid_due" | "recommendation";
export type MemoryMaintenanceRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";
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
