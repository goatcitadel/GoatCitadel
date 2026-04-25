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
  FollowOnParityReport,
  FollowOnProofLaneArtifactRecord,
  IntegrationActionInvokeInput,
  IntegrationActionInvokeResult,
  IntegrationFormSchema,
  IntegrationOperatorAction,
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
  };
  items: Array<{
    key: string;
    tokenInput: number;
    tokenOutput: number;
    tokenCachedInput: number;
    tokenTotal: number;
    costUsd: number;
  }>;
}

export interface TaskRecord {
  taskId: string;
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
    | "phase_approved"
    | "phase_executed"
    | "wave_advanced"
    | "run_completed"
    | "run_stopped"
    | "run_failed";
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
    reviewQueue: Array<{
      itemId: string;
      jobId?: string;
      scheduledFor?: string;
      status?: string;
      reason?: string;
    }>;
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

export interface HealthSummaryResponse {
  generatedAt: string;
  systemVitals: SystemVitalsResponse;
  daemonStatus: {
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
  };
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
  items: Array<{
    jobId: string;
    name: string;
    action: "task" | "improvement" | "backup" | "memory_flush" | "cost_report" | "update_review";
    description?: string;
    schedule: string;
    enabled: boolean;
    endAt?: string;
    lastRunAt?: string;
    nextRunAt?: string;
    updatedAt?: string;
  }>;
}

export interface CronJobRecordResponse {
  jobId: string;
  name: string;
  action: "task" | "improvement" | "backup" | "memory_flush" | "cost_report" | "update_review";
  description?: string;
  schedule: string;
  enabled: boolean;
  endAt?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  updatedAt?: string;
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
  environment: string;
  deploymentProfile: "local_dev" | "trusted_local" | "remote_hardened";
  defaultToolProfile: string;
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
  };
  llm: {
    activeProviderId: string;
    activeModel: string;
    providers: Array<{
      providerId: string;
      label: string;
      baseUrl: string;
      apiStyle: "openai-chat-completions" | "openai-responses" | "openai-codex-responses" | "anthropic-messages";
      resolvedApiStyle?:
        | "openai-chat-completions"
        | "openai-responses"
        | "openai-codex-responses"
        | "anthropic-messages";
      defaultModel: string;
      authMode?: "api-key" | "codex-oauth";
      oauthStatus?: {
        connected: boolean;
        accountLabel?: string;
        expiresAt?: string;
        requiresReauth?: boolean;
      };
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
    bankrBuiltinEnabled: boolean;
    cronReviewQueueV1Enabled: boolean;
    replayRegressionV1Enabled: boolean;
  };
}

export interface OnboardingCompleteResponse {
  state: OnboardingState;
}

export interface IntegrationCatalogEntry {
  catalogId: string;
  kind: "channel" | "model_provider" | "productivity" | "automation" | "platform";
  key: string;
  label: string;
  description: string;
  maturity: "native" | "plugin" | "disabled" | "beta";
  runtimeAvailability?: "runnable" | "blocked";
  authMethods: string[];
  capabilities: string[];
  docsUrl?: string;
  formSchema?: IntegrationFormSchema;
  pluginId?: string;
  operatorActions?: IntegrationOperatorAction[];
}

export interface IntegrationConnection {
  connectionId: string;
  catalogId: string;
  kind: "channel" | "model_provider" | "productivity" | "automation" | "platform";
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
