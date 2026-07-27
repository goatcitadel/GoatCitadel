/**
 * Shared API response & resource type definitions.
 *
 * Extracted from api/client.ts as the first stage of the Step 9 barrel split.
 * Pure type-only declarations — no runtime code, no helpers.
 */
import type {
  AgentProfileRecord,
  ApprovalEffectRecord,
  ApprovalReplaySnapshot,
  ApprovalRequest,
  A2UIProofLaneDraft,
  BrowserProofLaneDraft,
  CronReviewItem,
  FollowOnParityReport,
  FollowOnProofLaneArtifactRecord,
  GatewayAuthCredentialPlan,
  IntegrationActionInvokeInput,
  IntegrationActionInvokeResult,
  IntegrationFormSchema,
  IntegrationOperatorAction,
  LlmProviderAuthReadiness,
  LlmProviderConfig,
  NpuRuntimeStatus,
  OnboardingState,
  OrchestrationRun,
  OpenclawParityProgramReport,
  PackagingProofLaneDraft,
  LlamaCppRuntimeStatus,
  SessionMeta,
  ToolInvokeResult,
  VoiceProofLaneDraft,
} from "@goatcitadel/contracts";

export interface SessionsResponse {
  items: SessionMeta[];
  nextCursor?: string;
}

export interface ApprovalsResponse {
  items: ApprovalRequest[];
  nextCursor?: string;
}

export type ApprovalReplayResponse = ApprovalReplaySnapshot;

export interface ApprovalResolveResponse {
  approval: ApprovalRequest;
  executedAction?: ToolInvokeResult;
  effects: ApprovalEffectRecord[];
  replay: ApprovalReplayResponse;
  durableRunId?: string;
}

export interface CostSummaryResponse {
  scope: string;
  from: string;
  to: string;
  usageAvailability?: {
    trackedEvents: number;
    unknownEvents: number;
    totalAgentEvents: number;
    metricAvailability?: CostMetricAvailability;
  };
  items: Array<{
    key: string;
    tokenInput: number;
    tokenOutput: number;
    tokenCachedInput: number;
    tokenTotal: number;
    costUsd: number;
    metricAvailability?: CostMetricCompleteness;
  }>;
  dailySeries?: Array<{
    isoDate: string;
    shortLabel?: string;
    tokenInput?: number;
    tokenOutput?: number;
    tokenCachedInput?: number;
    tokenTotal?: number;
    costUsd?: number;
    metricAvailability?: CostMetricCompleteness;
    segments: Array<{
      providerKey: string;
      label: string;
      tokenInput?: number;
      tokenOutput?: number;
      tokenCachedInput?: number;
      tokenTotal?: number;
      costUsd: number;
      models?: string[];
      metricAvailability?: CostMetricCompleteness;
    }>;
  }>;
}

export interface CostMetricCompleteness {
  inputTokensComplete: boolean;
  outputTokensComplete: boolean;
  cachedInputTokensComplete: boolean;
  costUsdComplete: boolean;
}

export interface CostMetricAvailability {
  inputTokens: CostMetricCoverage;
  outputTokens: CostMetricCoverage;
  cachedInputTokens: CostMetricCoverage;
  costUsd: CostMetricCoverage;
}

export interface CostMetricCoverage {
  knownAttemptCount: number;
  unknownAttemptCount: number;
  complete: boolean;
}

export interface TaskRecord {
  taskId: string;
  revision: number;
  workspaceId?: string;
  title: string;
  description?: string;
  status: "planning" | "inbox" | "assigned" | "in_progress" | "testing" | "review" | "done" | "blocked";
  priority: "low" | "normal" | "high" | "urgent";
  assignedAgentId?: string;
  createdBy?: string;
  dueAt?: string;
  deletedAt?: string;
  deletedBy?: string;
  deleteReason?: string;
  createdAt: string;
  updatedAt: string;
  proactiveContext?: {
    sessionId: string;
    originSurface: "chat" | "cowork" | "code";
    proactiveRunId?: string;
    durableRunId?: string;
    approvalId?: string;
    nextWakeAt?: string;
    stopReason?: string;
    externalReferenceRoots?: Array<{
      label: string;
      rootPath: string;
      access: "read_only";
    }>;
  };
  agenticContext?: {
    runId?: string;
    durableRunId?: string;
    status?: string;
  };
}

export interface TaskActivityRecord {
  activityId: string;
  taskId: string;
  agentId?: string;
  activityType: "spawned" | "updated" | "completed" | "file_created" | "status_changed" | "comment";
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface TaskDeliverableRecord {
  deliverableId: string;
  taskId: string;
  deliverableType: "file" | "url" | "artifact";
  title: string;
  path?: string;
  description?: string;
  createdAt: string;
}

export interface TaskSubagentSession {
  subagentSessionId: string;
  taskId: string;
  agentSessionId: string;
  agentName?: string;
  status: "active" | "completed" | "failed" | "killed";
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface RealtimeEvent {
  eventId: string;
  sequence: number;
  eventType: string;
  source: string;
  timestamp: string;
  eventClass?: "domain_fact" | "operational_signal" | "ui_notification";
  eventAuthority?: "retained_stream" | "durable_history" | "derived_projection";
  links?: {
    sessionId?: string;
    turnId?: string;
    runId?: string;
    durableRunId?: string;
    proactiveRunId?: string;
    approvalId?: string;
    taskId?: string;
    workspaceId?: string;
    connectorId?: string;
    tokenId?: string;
    messageId?: string;
  };
  correlationId?: string;
  traceId?: string;
  originSurface?: string;
  payload: Record<string, unknown>;
}

export interface DashboardStateResponse {
  timestamp: string;
  sessions: SessionsResponse["items"];
  pendingApprovals: number;
  activeSubagents: number;
  taskStatusCounts: Array<{ status: string; count: number }>;
  recentEvents: RealtimeEvent[];
  dailyCostUsd: number;
}

export type OrchestrationRunResponse = OrchestrationRun;

export interface OrchestrationCheckpointRecord {
  checkpointId: string;
  runId: string;
  planId: string;
  waveId?: string;
  phaseId?: string;
  checkpointKind:
    | "run_created"
    | "durable_run_linked"
    | "worktree_allocated"
    | "run_queued"
    | "run_started"
    | "run_paused_for_approval"
    | "run_resumed"
    | "continuation_gate"
    | "phase_approved"
    | "phase_executed"
    | "wave_advanced"
    | "run_completed"
    | "run_stopped"
    | "run_failed"
    | "run_cancelled";
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TimelineSummaryResponse {
  generatedAt: string;
  events: {
    items: RealtimeEvent[];
  };
  sessions: {
    items: SessionsResponse["items"];
  };
  scheduler: {
    jobs: CronJobsResponse["items"];
    reviewQueue: CronReviewItem[];
  };
  improvement: {
    reports: Array<{
      reportId: string;
      runId?: string;
      createdAt?: string;
      title?: string;
      summary?: Record<string, unknown>;
      [key: string]: unknown;
    }>;
    replayRuns: Array<{
      runId: string;
      status?: string;
      createdAt?: string;
      updatedAt?: string;
      reportId?: string;
      [key: string]: unknown;
    }>;
  };
}

export interface SystemVitalsResponse {
  hostname: string;
  platform: string;
  release: string;
  uptimeSeconds: number;
  loadAverage: number[];
  cpuCount: number;
  memoryTotalBytes: number;
  memoryFreeBytes: number;
  memoryUsedBytes: number;
  processRssBytes: number;
  processHeapUsedBytes: number;
}

export interface DaemonControlHandoff {
  owner: string;
  serviceName: string;
  reason: string;
  desktopControl: string;
  commands: Array<{
    label: string;
    command: string;
    description: string;
  }>;
}

export type DaemonRuntimeDiagnosticSeverity = "info" | "pass" | "warn" | "critical";

export interface DaemonRuntimeDiagnostic {
  id: string;
  title: string;
  severity: DaemonRuntimeDiagnosticSeverity;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface DaemonRepairAction {
  id: string;
  label: string;
  severity: Exclude<DaemonRuntimeDiagnosticSeverity, "pass">;
  description: string;
  command?: string;
  autoRunAllowed: boolean;
  requiresOwnerProof: boolean;
}

export interface DaemonStatusResponse {
  running: boolean;
  pid: number;
  uptimeSeconds: number;
  host: string;
  state: "running" | "stopped";
  lastCommandAt?: string;
  requestedState?: "running" | "stopped";
  supported: boolean;
  controllable: boolean;
  controlMessage: string;
  controlHandoff?: DaemonControlHandoff;
  diagnostics?: DaemonRuntimeDiagnostic[];
  repairActions?: DaemonRepairAction[];
}

export interface HealthSummaryResponse {
  generatedAt: string;
  systemVitals: SystemVitalsResponse;
  daemonStatus: DaemonStatusResponse;
  daemonLogs: {
    items: Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }>;
  };
  costs: {
    summary: CostSummaryResponse;
    qmd: {
      totalRuns: number;
      compressionPercent: number;
      expansionPercent: number;
      efficiencyLabel: "reduced" | "expanded" | "neutral";
      originalTokenEstimate?: number;
      distilledTokenEstimate?: number;
      netTokenDelta?: number;
    };
  };
  backups: {
    items: Array<{
      backupId: string;
      createdAt: string;
      files: Array<{ path?: string; [key: string]: unknown }>;
      [key: string]: unknown;
    }>;
    latest: {
      backupId: string;
      createdAt: string;
      files: Array<{ path?: string; [key: string]: unknown }>;
      [key: string]: unknown;
    } | null;
  };
}

export type {
  A2UIProofLaneDraft,
  BrowserProofLaneDraft,
  FollowOnParityReport,
  FollowOnProofLaneArtifactRecord,
  OpenclawParityProgramReport,
  PackagingProofLaneDraft,
  VoiceProofLaneDraft,
};

export interface CronJobsResponse {
  items: CronJobRecordResponse[];
}

export interface CronJobRecordResponse {
  jobId: string;
  revision: number;
  name: string;
  action:
    | "task"
    | "improvement"
    | "curator"
    | "backup"
    | "memory_flush"
    | "memory_consolidation"
    | "cost_report"
    | "update_review"
    | "watchdog"
    | "no_agent"
    | "agent_turn";
  actionConfig?: Record<string, unknown>;
  description?: string;
  schedule: string;
  enabled: boolean;
  endAt?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  updatedAt?: string;
  workdir?: string;
  contextFrom?: string;
  lastRunOutput?: string;
  lastRunId?: string;
  lastRunStatus?: "ok" | "failed";
  /** Signed evidence envelope recorded for the last run (cronEvidenceV1Enabled). */
  lastRunEvidenceEnvelopeId?: string;
  failureCount?: number;
  backoffUntil?: string;
}

export interface OperatorsResponse {
  items: Array<{
    operatorId: string;
    sessionCount: number;
    activeSessions: number;
    lastActivityAt?: string;
  }>;
}

export interface AgentsResponse {
  items: AgentProfileRecord[];
  view?: "active" | "archived" | "all";
}

export interface RuntimeSettingsResponse {
  /** Opaque monotonic revision required by settings mutation requests. */
  revision: number;
  environment: string;
  deploymentProfile: "local_dev" | "trusted_local" | "remote_hardened";
  toolApprovalMode: "approve_all" | "approve_risky" | "bypass";
  defaultToolProfile?: string;
  budgetMode: "saver" | "balanced" | "power";
  workspaceDir: string;
  writeJailRoots: string[];
  readOnlyRoots: string[];
  readAccessMode?: "roots_only" | "approval_required" | "full_disk";
  networkAllowlist: string[];
  approvalExplainer: {
    enabled: boolean;
    mode: "async";
    minRiskLevel: "caution" | "danger" | "nuclear";
    providerId?: string;
    model?: string;
    timeoutMs: number;
    maxPayloadChars: number;
  };
  memory: {
    enabled: boolean;
    qmd: {
      enabled: boolean;
      applyToChat: boolean;
      applyToOrchestration: boolean;
      minPromptChars: number;
      maxContextTokens: number;
      cacheTtlSeconds: number;
      distillerProviderId?: string;
      distillerModel?: string;
    };
  };
  web?: {
    firecrawl: {
      enabled: boolean;
      baseUrl: string;
      apiKeyEnv?: string;
      timeoutMs: number;
      defaultReadBackend: "native" | "firecrawl";
      fallbackToNative: boolean;
    };
  };
  auth: {
    mode: "none" | "token" | "basic";
    allowLoopbackBypass: boolean;
    tokenConfigured: boolean;
    basicConfigured: boolean;
    plan?: GatewayAuthCredentialPlan;
  };
  llm: {
    activeProviderId: string;
    activeModel: string;
    providers: Array<{
      providerId: string;
      label: string;
      baseUrl: string;
      apiStyle:
        | "openai-chat-completions"
        | "openai-responses"
        | "openai-codex-responses"
        | "anthropic-messages"
        | "bedrock-messages";
      resolvedApiStyle?:
        | "openai-chat-completions"
        | "openai-responses"
        | "openai-codex-responses"
        | "anthropic-messages"
        | "bedrock-messages";
      defaultModel: string;
      authMode?: LlmProviderConfig["authMode"];
      googleCloud?: LlmProviderConfig["googleCloud"];
      oauthStatus?: {
        connected: boolean;
        accountLabel?: string;
        expiresAt?: string;
        requiresReauth?: boolean;
      };
      authReadiness?: LlmProviderAuthReadiness;
      hasApiKey: boolean;
      apiKeySource: "inline" | "env" | "keychain" | "none";
      hasKeychainSecret?: boolean;
      apiKeyRef?: string;
      capabilities?: {
        vision: boolean;
        audio: boolean;
        video: boolean;
        toolCalling: boolean;
        jsonMode: boolean;
        webSearch?: boolean;
        reasoning?: boolean;
        reasoningEfforts?: NonNullable<LlmProviderConfig["capabilities"]>["reasoningEfforts"];
        voiceInput?: boolean;
        voiceOutput?: boolean;
        imageGenerate?: boolean;
        imageEdit?: boolean;
        artifacts?: boolean;
      };
    }>;
  };
  mesh: {
    enabled: boolean;
    mode: "lan" | "wan" | "tailnet";
    nodeId: string;
    mdns: boolean;
    staticPeers: string[];
    requireMtls: boolean;
    tailnetEnabled: boolean;
  };
  npu: {
    enabled: boolean;
    autoStart: boolean;
    sidecarUrl: string;
    status: NpuRuntimeStatus;
  };
  llamaCpp: {
    enabled: boolean;
    autoStart: boolean;
    baseUrl: string;
    command: string;
    extraArgs: string[];
    modelsRootPath?: string;
    modelPath?: string;
    alias: string;
    ctxSize?: number;
    threads?: number;
    gpuLayers?: number;
    parallel?: number;
    batchSize?: number;
    ubatchSize?: number;
    flashAttention?: boolean;
    status: LlamaCppRuntimeStatus;
  };
  features: {
    durableKernelV1Enabled: boolean;
    memoryMaintenanceV1Enabled: boolean;
    replayOverridesV1Enabled: boolean;
    memoryLifecycleAdminV1Enabled: boolean;
    memoryLifecycleAutoForgetEnabled: boolean;
    connectorDiagnosticsV1Enabled: boolean;
    computerUseGuardrailsV1Enabled: boolean;
    cronReviewQueueV1Enabled: boolean;
    replayRegressionV1Enabled: boolean;
    codeModeV1Enabled?: boolean;
    improvementLedgerV1Enabled?: boolean;
    improvementActivationV1Enabled?: boolean;
    coworkRuntimeQualityV1Disabled?: boolean;
    orchestrationFinalStreamingV1Disabled?: boolean;
    autonomyV1Disabled?: boolean;
    chatThinkingStreamV1Enabled?: boolean;
    unifiedComposerPaletteV1Enabled?: boolean;
    channelVoiceInboundV1Enabled?: boolean;
    /** @deprecated Signal is outbound-only; true is retained only for blocked legacy-posture evidence. */
    signalInboundV1Enabled?: boolean;
    plannerFastPathV1Disabled?: boolean;
    parallelToolExecutionV1Disabled?: boolean;
    streamIdleWatchdogV1Disabled?: boolean;
    plannerFanoutV1Disabled?: boolean;
    subagentFanoutV1Disabled?: boolean;
    channelVoiceReplyV1Enabled?: boolean;
    memoryConsolidationV1Enabled?: boolean;
    cronEvidenceV1Enabled?: boolean;
    utilityModelRoutingV1Enabled?: boolean;
    chatTurnInterruptionRecoveryV1Disabled?: boolean;
  };
}

export interface OnboardingCompleteResponse {
  state: OnboardingState;
}

export interface IntegrationCatalogEntry {
  catalogId: string;
  kind: "channel" | "model_provider" | "productivity" | "automation" | "platform" | "external_connector";
  key: string;
  label: string;
  description: string;
  maturity: "native" | "plugin" | "disabled" | "beta" | "planned";
  runtimeAvailability?: "runnable" | "blocked";
  authMethods: string[];
  capabilities: string[];
  docsUrl?: string;
  formSchema?: IntegrationFormSchema;
  pluginId?: string;
  operatorActions?: IntegrationOperatorAction[];
  externalConnector?: {
    sourceId: string;
    serviceId: string;
    sourceCommit: string;
    actionCount: number;
    activeActionCount: number;
    runtimePosture: "catalog_only";
    callable: false;
  };
}

export interface IntegrationConnection {
  connectionId: string;
  catalogId: string;
  kind: "channel" | "model_provider" | "productivity" | "automation" | "platform" | "external_connector";
  key: string;
  label: string;
  enabled: boolean;
  status: "connected" | "disconnected" | "error" | "paused";
  config: Record<string, unknown>;
  pluginId?: string;
  pluginVersion?: string;
  pluginEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string;
  lastError?: string;
}

export type { IntegrationActionInvokeInput, IntegrationActionInvokeResult, IntegrationOperatorAction };

export interface LlmChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index: number;
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      [key: string]: unknown;
    };
  }>;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MeshStatusResponse {
  enabled: boolean;
  mode: "lan" | "wan" | "tailnet";
  localNodeId: string;
  tailnetEnabled: boolean;
  nodesOnline: number;
  activeLeases: number;
  ownedSessions: number;
}

export interface MeshNodeRecord {
  nodeId: string;
  label?: string;
  advertiseAddress?: string;
  transport: "lan" | "wan" | "tailnet";
  status: "online" | "suspect" | "offline";
  capabilities: string[];
  tlsFingerprint?: string;
  joinedAt: string;
  lastSeenAt: string;
}

export interface MeshLeaseRecord {
  leaseKey: string;
  holderNodeId: string;
  fencingToken: number;
  expiresAt: string;
  updatedAt: string;
}

export interface MeshSessionOwnerRecord {
  sessionId: string;
  ownerNodeId: string;
  epoch: number;
  claimedAt: string;
  updatedAt: string;
}

export interface MeshReplicationOffsetRecord {
  consumerNodeId: string;
  sourceNodeId: string;
  lastReplicationId?: string;
  updatedAt: string;
}
