import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isVerboseLoggingEnabled } from "../runtime-ux.js";
import { EventIngestService } from "@goatcitadel/gateway-core";
import { MeshService } from "@goatcitadel/mesh-core";
import {
  estimateTokensFromText,
  truncateByTokenEstimate,
} from "@goatcitadel/memory-core";
import { OrchestrationEngine } from "@goatcitadel/orchestration";
import {
  ToolPolicyEngine,
  assertExistingPathRealpathAllowed,
  assertWritePathInJail,
  evaluateBankrActionPreview,
  readBankrSafetyPolicy,
  writeBankrSafetyPolicy,
} from "@goatcitadel/policy-engine";
import { SkillsService } from "@goatcitadel/skills";
import {
  DEFAULT_SESSION_AUTONOMY_PREFS,
  Storage,
  type SessionAutonomyPrefsPatchInput,
  type SessionAutonomyPrefsRecord,
} from "@goatcitadel/storage";
import {
  applyChatModePresetToPatch,
  buildChatModePrefsPatch,
  chatModeAllowsDynamicTeamGrowth,
  chatModeRequiresProjectBinding,
  clampInt,
  ConflictError,
  GoatError,
  isChatTurnActiveStatus,
  isChatTurnTerminalStatus,
  NotFoundError,
  ValidationError,
} from "@goatcitadel/contracts";
import type {
  AddonActionResponse,
  AddonCatalogEntry,
  AddonInstalledRecord,
  AddonInstallRequest,
  AddonStatusRecord,
  AddonUninstallResponse,
  BankrActionAuditRecord,
  BankrActionPreviewRequest,
  BankrActionPreviewResponse,
  BankrSafetyPolicy,
  AgentProfileArchiveInput,
  AgentProfileCreateInput,
  AgentProfileRecord,
  AgentProfileUpdateInput,
  BackupCreateResponse,
  BackupManifestFileRecord,
  BackupManifestRecord,
  BackupVerifyResponse,
  AuthRuntimeSettings,
  AuthSettingsUpdateInput,
  FilesystemReadAccessMode,
  DeviceAccessRequestCreateInput,
  DeviceAccessRequestCreateResponse,
  DeviceAccessGrantRecord as DeviceAccessGrantContractRecord,
  DeviceAccessRequestStatus,
  DeviceAccessRequestStatusResponse,
  DeploymentProfile,
  ApprovalCreateInput,
  ApprovalReplayEvent,
  ApprovalRequest,
  ApprovalResolveInput,
  ApprovalWaitWorkflowPayload,
  AssemblyRunDetailResponse,
  AssemblyRunRecord,
  CreateAssemblyRunInput,
  CalendarCreateEventInput,
  CalendarListQuery,
  ChannelSendInput,
  ChannelInboundMessageInput,
  ChatAttachmentRecord,
  ChatAttachmentMediaType,
  ChatAttachmentPreviewResponse,
  ChatCapabilityUpgradeSuggestion,
  ChatCancelTurnResponse,
  ChatCitationRecord,
  ChatDelegateAcceptRequest,
  ChatDelegateRequest,
  ChatDelegateSuggestRequest,
  ChatDelegateSuggestResponse,
  ChatDelegateResponse,
  ChatDelegationSuggestionRecord,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatInputPart,
  ChatMemoryMode,
  ChatMode,
  ChatMessageRecord,
  ChatPlanningMode,
  ChatProactiveMode,
  ChatProjectRecord,
  ChatReflectionMode,
  ChatRetrievalMode,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionPrefsRecord,
  ChatSessionBindingRecord,
  ChatSessionRecord,
  ChatSessionPrefsPatch,
  ChatSpecialistCandidateCreateInput,
  ChatSpecialistCandidatePatchInput,
  ChatSpecialistCandidateRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ChatStreamChunk,
  ChatStreamChunkDraft,
  ChatThreadResponse,
  ChatThinkingLevel,
  ChatToolRunRecord,
  ChatTurnBranchKind,
  ChatTurnFailureRecord,
  ChatTurnTraceRecord,
  ChatWebMode,
  DocsIngestInput,
  EmbeddingIndexInput,
  EmbeddingQueryInput,
  MemoryContextComposeRequest,
  MemoryContextPack,
  MemoryQmdStatsResponse,
  MemorySearchQuery,
  MemoryWriteInput,
  CronJobRecord,
  DashboardState,
  ChatCompletionRequest,
  ChatCompletionResponse,
  GatewayEventInput,
  GatewayEventResult,
  IntegrationCatalogEntry,
  IntegrationFormSchema,
  IntegrationPluginInstallInput,
  IntegrationPluginRecord,
  IntegrationConnection,
  IntegrationConnectionCreateInput,
  IntegrationConnectionUpdateInput,
  IntegrationKind,
  McpInvokeRequest,
  McpInvokeResponse,
  McpOAuthStartResponse,
  McpServerCategory,
  McpServerPolicy,
  McpServerTemplateRecord,
  McpServerCreateInput,
  McpServerRecord,
  McpServerUpdateInput,
  McpToolRecord,
  MediaCreateJobRequest,
  MediaJobRecord,
  LlmModelRecord,
  LlmRuntimeConfig,
  OnboardingBootstrapInput,
  OnboardingBootstrapResult,
  OnboardingChecklistItem,
  OnboardingState,
  MeshJoinRequest,
  MeshJoinResult,
  MeshLeaseAcquireRequest,
  MeshLeaseRecord,
  MeshLeaseReleaseRequest,
  MeshLeaseRenewRequest,
  MeshNodeRecord,
  MeshReplicationIngestRequest,
  MeshReplicationRecord,
  MeshSessionClaimRequest,
  MeshSessionOwnerRecord,
  MeshStatus,
  MeshReplicationOffset,
  NpuModelManifest,
  NpuRuntimeStatus,
  OperatorSummary,
  OrchestrationPlan,
  OrchestrationRun,
  PendingApprovalAction,
  RealtimeEvent,
  RetentionPolicy,
  RetentionPruneResult,
  PromptPackRecord,
  PromptPackAutoScoreBatchResult,
  PromptPackAutoScoreResult,
  PromptPackBenchmarkItemRecord,
  PromptPackBenchmarkProviderInput,
  PromptPackBenchmarkRunRecord,
  PromptPackBenchmarkStatusRecord,
  PromptPackExportRecord,
  PromptPackReportRecord,
  PromptPackRunRecord,
  PromptPackScoreRecord,
  PromptPackTestRecord,
  PromptPackToolTier,
  ProactiveActionRecord,
  ProactivePolicy,
  ProactiveRunRecord,
  ResearchRunRecord,
  ResearchSourceRecord,
  ResearchSummaryRecord,
  SessionMeta,
  TranscriptEvent,
  SessionSummary,
  SessionTimelineItem,
  SkillActivationPolicy,
  SkillImportHistoryRecord,
  SkillImportValidationResult,
  SkillListItem,
  SkillSourceListResponse,
  SkillSourceLookupResponse,
  SkillSourceProvider,
  SkillRuntimeState,
  SkillStateRecord,
  SkillResolveInput,
  ObsidianIntegrationConfig,
  ObsidianIntegrationStatus,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryItemType,
  LearnedMemoryUpdateInput,
  DecisionAutoTuneRecord,
  DecisionReplayCauseClass,
  DecisionReplayFindingRecord,
  DecisionReplayItemModelScores,
  DecisionReplayItemRecord,
  DecisionReplayItemRuleScores,
  DecisionReplayRunRecord,
  DurableCheckpointRecord,
  ConnectorDeliveryWorkflowPayload,
  DurableDeadLetterRecord,
  DurableDiagnosticsResponse,
  DurableRunRecord,
  DurableRunStatus,
  WeeklyImprovementReportRecord,
  SystemVitals,
  TaskActivityCreateInput,
  TaskActivityRecord,
  TaskCreateInput,
  TaskDeliverableCreateInput,
  TaskDeliverableRecord,
  TaskRecord,
  TaskStatus,
  TaskSubagentCreateInput,
  TaskSubagentSession,
  TaskSubagentUpdateInput,
  ToolAccessEvaluateRequest,
  ToolAccessEvaluateResponse,
  ToolCatalogEntry,
  ToolGrantCreateInput,
  ToolGrantRecord,
  TaskUpdateInput,
  GmailReadQuery,
  GmailSendInput,
  ToolInvokeRequest,
  ToolInvokeResult,
  ModelReputation,
  VoiceStatus,
  VoiceRuntimeInstallRequest,
  VoiceRuntimeStatus,
  VoiceTalkSessionRecord,
  VoiceTranscribeResponse,
  GuidanceBundleRecord,
  GuidanceDocType,
  GuidanceDocumentRecord,
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceUpdateInput,
  ReplayOverrideDraft,
  ReplayOverrideStep,
  ReplayDiffSummary,
  MemoryItemRecord,
  MemoryLifecyclePatch,
  MemoryChangeEvent,
  ConnectorDiagnosticReport,
  McpTemplateDiscoveryResult,
  CronReviewItem,
  CronRunDiff,
  ReplayRegressionRun,
  ReplayRegressionResult,
  CapabilityTrendSeries,
  DurableRunCreateRequest,
  DurableRunTimelineEvent,
  DurableRetryPolicy,
  RemoteActionTokenRecord,
} from "@goatcitadel/contracts";
import type { ConnectorRecord, ConnectorType } from "@goatcitadel/contracts";
import { BUILTIN_AGENT_PROFILES } from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";
import { getRequestAttribution } from "../../../../packages/storage/src/request-attribution.js";
import { LlmService } from "./llm-service.js";
import { AssemblyService } from "./assembly-service.js";
import { ApprovalExplainerService } from "./approval-explainer-service.js";
import { scoutCapabilityUpgradeSuggestions } from "./chat-capability-scout.js";
import {
  collectMcpBrowserFallbackTargets,
  discoverMcpTools,
  inferMcpToolsForServer,
  invokeMcpRuntimeTool,
} from "./mcp-runtime.js";
import {
  extractLearnedMemoryCandidates,
  looksLowConfidenceResponse,
  shouldExtractLearnedMemoryContent,
} from "./learned-memory-utils.js";
import { buildConversationCompactionSummary } from "./chat-compaction.js";
import {
  assertChatSessionActive,
  buildChatSessionUpdatedPayload,
  deriveChatSessionTitleFromContent,
  shouldAllowCrossProviderFallback,
} from "./chat-session-utils.js";
import {
  buildChatThreadResponse,
  buildSelectedPathTurnIds,
  resolveNewestLeafTurnId,
} from "./chat-thread-utils.js";
import { executeOrchestrationPlan } from "../orchestration/engine.js";
import { CHAT_MODE_POLICY } from "../orchestration/policies/chat-policy.js";
import { buildProviderCapabilityRegistry } from "../orchestration/providers/capability-registry.js";
import {
  buildOrchestrationPlan,
  resolveModePolicy,
  shouldUseModeOrchestration,
} from "../orchestration/router.js";
import type {
  OrchestrationExecutionResult,
  OrchestrationPlan as ModeOrchestrationPlan,
  OrchestrationRole,
  OrchestrationRouterInput,
  OrchestrationStepExecutionResult,
} from "../orchestration/types.js";
import { getIntegrationFormSchema, INTEGRATION_CATALOG } from "./integration-catalog.js";
import { MemoryContextService } from "./memory-context-service.js";
import { NpuSidecarService } from "./npu-sidecar-service.js";
import { SecretStoreService } from "./secret-store-service.js";
import { ChatAgentOrchestrator, normalizeAgentInputFromSend } from "./chat-agent-orchestrator.js";
import { ResearchService } from "./research-service.js";
import { ObsidianVaultService } from "./obsidian-vault-service.js";
import { SkillImportService } from "./skill-import-service.js";
import { AddonsService } from "./addons-service.js";
import {
  GatewayDevDiagnosticsService,
  resolveDevDiagnosticsBufferSize,
  resolveDevDiagnosticsEnabled,
  resolveDevDiagnosticsVerbose,
} from "../dev-diagnostics/service.js";
import {
  installManagedVoiceRuntime,
  removeManagedVoiceModel,
  selectManagedVoiceModel,
} from "../voice-runtime/installer.js";
import { getManagedVoiceRuntimeStatus } from "../voice-runtime/status.js";
import { normalizeMemoryForgetCriteria, serializePathWithinRoot } from "./security-utils.js";
import {
  COST_REPORT_HOURLY_JOB_ID,
  CronAutomationService,
  IMPROVEMENT_WEEKLY_JOB_ID,
  MEMORY_FLUSH_DAILY_JOB_ID,
  normalizeCronJobId,
  normalizeCronJobName,
  normalizeCronSchedule,
  PRIVATE_BETA_BACKUP_JOB_ID,
} from "./gateway/cron-automation-service.js";
import { OperatorSummaryCache } from "./gateway/operator-summary-cache.js";
import {
  createGatewayAuthCredentialPlan,
  readAssistantAuthConfigSnapshotSync,
  resolveGatewayInstallToken as resolveGatewayInstallTokenFromPlanner,
} from "./gateway/auth-credential-planner.js";
import { verifyBackupAtPath } from "./gateway/backup-verify.js";
import { buildDelegatedChatSendRequest } from "./delegated-chat-request.js";
import { buildDelegatedSessionToolGrantCopies } from "./delegated-session-tool-grants.js";
import { resolveProjectRootForToolContext, resolveToolRequestPaths } from "./tool-path-resolution.js";
import type { ServiceContext } from "./service-context.js";
import { ChatProjectService } from "./chat-project-service.js";
import { DurableRunService } from "./durable-run-service.js";
import { ChatLearnedMemoryService } from "./chat-learned-memory-service.js";
import { PromptPackService, normalizePromptTestCode, clampPromptScore } from "./prompt-pack-service.js";
import { ChatProactiveService } from "./chat-proactive-service.js";
import { ImprovementService } from "./improvement-service.js";
import { evaluateDeploymentProfileToolAccess } from "../tool-runtime-guardrails.js";
import { buildGatewayConnectorRecords, filterConnectorRecords } from "./connector-registry.js";
import { dispatchConnectorDelivery } from "./connector-delivery.js";
import { buildApprovalRemoteTokenConnectorDeliveryPayload } from "./approval-connector-delivery.js";
import {
  MCP_APPROVAL_DELIVERY_TOOL_NAME,
  MCP_APPROVAL_INBOX_URL,
  createInternalMcpApprovalInboxTools,
  handleInternalMcpApprovalInboxInvoke,
  isInternalMcpApprovalInboxServer,
} from "./mcp-approval-inbox.js";

export interface ApprovalResolveResult {
  approval: ApprovalRequest;
  executedAction?: ToolInvokeResult;
}

export interface ApprovalReplayResult {
  approval: ApprovalRequest;
  events: ApprovalReplayEvent[];
  pendingAction?: PendingApprovalAction;
}

interface AuthDeviceRequestRecord {
  requestId: string;
  approvalId: string;
  requestSecretHash: string;
  deviceLabel: string;
  deviceType: string;
  platform?: string;
  requestedOrigin?: string;
  requestedIp?: string;
  userAgent?: string;
  status: DeviceAccessRequestStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
  approvedTokenPlaintext?: string;
  approvedTokenExpiresAt?: string;
  deliveredAt?: string;
}

interface AuthDeviceGrantRecord {
  grantId: string;
  requestId: string;
  tokenHash: string;
  deviceLabel: string;
  deviceType: string;
  platform?: string;
  grantedBy: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  metadata: Record<string, unknown>;
}

export interface FileUploadResult {
  relativePath: string;
  fullPath: string;
  bytes: number;
}

export interface FileDownloadResult {
  relativePath: string;
  fullPath: string;
  size: number;
  modifiedAt: string;
  contentType: string;
  isText: boolean;
  content: string | Buffer;
}

export interface FileTemplateRecord {
  templateId: string;
  title: string;
  description: string;
  defaultPath: string;
  body: string;
}

export interface MemoryFileEntry {
  relativePath: string;
  size: number;
  modifiedAt: string;
}

export interface RuntimeSettings {
  environment: string;
  deploymentProfile: DeploymentProfile;
  defaultToolProfile: string;
  budgetMode: "saver" | "balanced" | "power";
  workspaceDir: string;
  writeJailRoots: string[];
  readOnlyRoots: string[];
  readAccessMode: FilesystemReadAccessMode;
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
  auth: AuthRuntimeSettings;
  llm: LlmRuntimeConfig;
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
  features: {
    durableKernelV1Enabled: boolean;
    replayOverridesV1Enabled: boolean;
    memoryLifecycleAdminV1Enabled: boolean;
    connectorDiagnosticsV1Enabled: boolean;
    computerUseGuardrailsV1Enabled: boolean;
    bankrBuiltinEnabled: boolean;
    cronReviewQueueV1Enabled: boolean;
    replayRegressionV1Enabled: boolean;
  };
}

const RETENTION_SETTINGS_KEY = "retention_policy";
const MCP_SERVERS_SETTING_KEY = "mcp_servers_v1";
const MCP_TOOLS_SETTING_KEY = "mcp_tools_v1";
const MCP_TOOL_FIRST_APPROVAL_SETTING_KEY = "mcp_tool_first_approval_v1";
const INTEGRATION_PLUGINS_SETTING_KEY = "integration_plugins_v1";
const SKILL_ACTIVATION_POLICY_SETTING_KEY = "skill_activation_policy_v1";
const DAEMON_LOG_TAIL_SETTING_KEY = "daemon_log_tail_v1";
const VOICE_STATUS_SETTING_KEY = "voice_status_v1";
const VOICE_WAKE_STATUS_SETTING_KEY = "voice_wake_status_v1";
const FEATURE_FLAGS_SETTING_KEY = "feature_flags_v1";
const DURABLE_RETRY_POLICY_DEFAULT: DurableRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
};
const CHAT_STREAM_EVENT_POLL_INTERVAL_MS = 200;
const CHAT_STREAM_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  realtimeEventsDays: 14,
  backupsKeep: 20,
  transcriptsDays: undefined,
  auditDays: undefined,
};
const DEVICE_ACCESS_APPROVAL_KIND = "auth.device_access";
const DEVICE_ACCESS_REQUEST_POLL_AFTER_MS = 2_500;
const DEVICE_ACCESS_REQUEST_TTL_MS = 10 * 60 * 1000;
const DEVICE_ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_ACCESS_SECRET_BYTES = 24;
const DEVICE_ACCESS_TOKEN_BYTES = 32;

const MEMORY_ITEM_STATUS_VALUES = new Set(["active", "forgotten"]);

const DEFAULT_VOICE_PROVIDER: VoiceTranscribeResponse["provider"] = "whisper.cpp";
const DEFAULT_SKILL_ACTIVATION_POLICY: SkillActivationPolicy = {
  guardedAutoThreshold: 0.72,
  requireFirstUseConfirmation: true,
};
const BANKR_OPTIONAL_MIGRATION_MESSAGE =
  "Bankr built-in is disabled. Install the optional skill pack (docs/OPTIONAL_BANKR_SKILL.md; templates/skills/bankr-optional/SKILL.md).";
const PROACTIVE_SCHEDULER_INTERVAL_MS = 120_000;
const PROACTIVE_SCHEDULER_CONCURRENCY = 8;
const PROACTIVE_MIN_IDLE_SECONDS = 90;
const PROACTIVE_SAFE_TOOL_ALLOWLIST = new Set([
  "time.now",
  "browser.search",
  "browser.navigate",
  "browser.extract",
  "http.get",
]);
const DEFAULT_MCP_SERVER_POLICY: McpServerPolicy = {
  requireFirstToolApproval: false,
  redactionMode: "basic",
  allowedToolPatterns: [],
  blockedToolPatterns: [],
};
const MCP_SERVER_TEMPLATES: McpServerTemplateRecord[] = [
  {
    templateId: "approval-inbox",
    label: "GoatCitadel Approval Inbox",
    description: "Internal MCP receiver for durable approval deliveries, inbox review, and non-browser approval resolution.",
    transport: "http",
    url: MCP_APPROVAL_INBOX_URL,
    authType: "none",
    category: "orchestration",
    trustTier: "trusted",
    costTier: "free",
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "basic",
      allowedToolPatterns: [
        MCP_APPROVAL_DELIVERY_TOOL_NAME,
        "goatcitadel.approval.remote_action_inbox.*",
      ],
      blockedToolPatterns: [],
    },
    enabledByDefault: false,
  },
  {
    templateId: "filesystem",
    label: "Filesystem (Local)",
    description: "Read and write local workspace files through MCP.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    authType: "none",
    category: "development",
    trustTier: "restricted",
    costTier: "free",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "basic",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    enabledByDefault: false,
  },
  {
    templateId: "fetch",
    label: "Fetch (HTTP)",
    description: "Web fetch/search helper MCP server for research tasks.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    authType: "none",
    category: "research",
    trustTier: "restricted",
    costTier: "free",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "basic",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    enabledByDefault: false,
  },
  {
    templateId: "playwright",
    label: "Playwright Browser",
    description: "Browser automation MCP server for dynamic website workflows.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-playwright"],
    authType: "none",
    category: "automation",
    trustTier: "restricted",
    costTier: "free",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "basic",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    enabledByDefault: false,
  },
  {
    templateId: "github",
    label: "GitHub",
    description: "Official GitHub MCP endpoint for repositories, pull requests, issues, and code navigation.",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    authType: "oauth2",
    category: "development",
    trustTier: "restricted",
    costTier: "mixed",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "strict",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    enabledByDefault: false,
  },
  {
    templateId: "stripe",
    label: "Stripe",
    description: "Official Stripe remote MCP server for customers, subscriptions, invoices, and billing support workflows.",
    transport: "http",
    url: "https://mcp.stripe.com",
    authType: "oauth2",
    category: "automation",
    trustTier: "restricted",
    costTier: "mixed",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "strict",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    enabledByDefault: false,
  },
  {
    templateId: "context7",
    label: "Context7",
    description: "Up-to-date library and framework documentation search via the official Context7 MCP server.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp@latest"],
    authType: "none",
    category: "research",
    trustTier: "restricted",
    costTier: "free",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "basic",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    enabledByDefault: false,
  },
  {
    templateId: "microsoft-learn",
    label: "Microsoft Learn",
    description: "Official Microsoft Learn MCP endpoint for current Microsoft documentation, examples, and how-to guidance.",
    transport: "http",
    url: "https://learn.microsoft.com/api/mcp",
    authType: "none",
    category: "research",
    trustTier: "trusted",
    costTier: "free",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "basic",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    enabledByDefault: false,
  },
  {
    templateId: "n8n",
    label: "n8n",
    description: "Connect GoatCitadel to an n8n MCP endpoint for workflow execution and automation handoff.",
    transport: "sse",
    url: "https://your-n8n-host/mcp/<server-id>/sse",
    authType: "token",
    category: "automation",
    trustTier: "restricted",
    costTier: "mixed",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "strict",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    enabledByDefault: false,
  },
  {
    templateId: "gpt-researcher",
    label: "GPT Researcher",
    description: "Structured deep-research MCP server for investigation workflows and source-grounded reports.",
    transport: "stdio",
    command: "uvx",
    args: ["gpt-researcher-mcp"],
    authType: "none",
    category: "research",
    trustTier: "restricted",
    costTier: "mixed",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "basic",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    enabledByDefault: false,
  },
  {
    templateId: "openspec",
    label: "OpenSpec",
    description: "MCP bridge for OpenSpec-style spec and analysis workflows.",
    transport: "stdio",
    command: "uvx",
    args: ["openspec-mcp"],
    authType: "none",
    category: "development",
    trustTier: "restricted",
    costTier: "free",
    policy: {
      requireFirstToolApproval: true,
      redactionMode: "basic",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    enabledByDefault: false,
  },
];
const CORE_CHANNEL_KEYS = new Set([
  "discord",
  "slack",
  "telegram",
  "whatsapp",
  "matrix",
  "google-chat",
  "mattermost",
  "webchat",
]);

const CHAT_SESSION_AUTO_ALLOW_TOOLS = [
  "browser.search",
  "browser.navigate",
  "browser.extract",
  "http.get",
] as const;

const DEFAULT_DELEGATION_ROLES = ["product", "architect", "coder", "qa", "ops"];
const IMPROVEMENT_WEEKLY_TIME_ZONE = "America/Los_Angeles";
const IMPROVEMENT_WEEKLY_SCHEDULE_LABEL = "0 2 * * 0 America/Los_Angeles";
const PRIVATE_BETA_BACKUP_TIME_ZONE = "America/Los_Angeles";
const PRIVATE_BETA_BACKUP_SCHEDULE_LABEL = "30 2 * * * America/Los_Angeles";
const MEMORY_FLUSH_DAILY_TIME_ZONE = "America/Los_Angeles";
const MEMORY_FLUSH_DAILY_SCHEDULE_LABEL = "0 3 * * * America/Los_Angeles";
const COST_REPORT_HOURLY_TIME_ZONE = "America/Los_Angeles";
const COST_REPORT_HOURLY_SCHEDULE_LABEL = "0 * * * * America/Los_Angeles";
const PRIVATE_BETA_BACKUP_DEDUP_SETTING_KEY = "private_beta_backup_last_day_key_v1";
const MEMORY_FLUSH_DAILY_DEDUP_SETTING_KEY = "memory_flush_daily_last_day_key_v1";
const COST_REPORT_HOURLY_DEDUP_SETTING_KEY = "cost_report_hourly_last_hour_key_v1";
const IMPROVEMENT_WEEKLY_SAMPLE_SIZE = 500;
const IMPROVEMENT_JUDGE_SAMPLE_LIMIT = 120;
const IMPROVEMENT_JUDGE_TIMEOUT_MS = 15_000;
const IMPROVEMENT_SCHEDULER_INTERVAL_MS = 60_000;
const IMPROVEMENT_WEEKLY_DEDUP_SETTING_KEY = "improvement_weekly_last_week_key_v1";
const MEMORY_FLUSH_HISTORY_DAYS = 30;
const COST_REPORT_LOOKBACK_HOURS = 1;
const COST_REPORT_OUTPUT_DIR = "artifacts/cost-reports";
const IMPROVEMENT_TUNE_KEY_BLOCKER_TEMPLATE = "improvement_tune_blocker_template_v1";
const IMPROVEMENT_TUNE_KEY_RETRY_THRESHOLD = "improvement_tune_retry_threshold_v1";
const IMPROVEMENT_TUNE_KEY_LIVE_INTENT = "improvement_tune_live_intent_threshold_v1";
const IMPROVEMENT_TUNE_KEY_REFUSAL_STYLE = "improvement_tune_refusal_style_v1";
const IMPROVEMENT_RUN_STATUS_VALUES = new Set(["queued", "running", "completed", "failed"]);
const IMPROVEMENT_CAUSE_CLASSES = new Set<DecisionReplayCauseClass>([
  "false_refusal_tone",
  "weak_blocker_explanation",
  "tool_mismatch",
  "retrieval_miss",
  "incomplete_retry_repair",
  "other",
]);
const PIPELINE_TEMPLATES: Record<string, string[]> = {
  prd: ["product", "architect"],
  build: ["architect", "coder", "qa"],
  triage: ["qa", "ops", "product"],
  release: ["qa", "ops", "product"],
};
const DEFAULT_WORKSPACE_ID = "default";
const GUIDANCE_DOC_FILE_MAP: Record<GuidanceDocType, string> = {
  goatcitadel: "GOATCITADEL.md",
  agents: "AGENTS.md",
  claude: "CLAUDE.md",
  contributing: "CONTRIBUTING.md",
  security: "SECURITY.md",
  vision: "VISION.md",
};
const WORKSPACE_GUIDANCE_DOC_TYPES: GuidanceDocType[] = ["goatcitadel", "agents", "claude", "vision"];
const RUNTIME_GUIDANCE_DOC_TYPES: GuidanceDocType[] = ["goatcitadel", "agents", "claude"];
const MAX_RUNTIME_GUIDANCE_CHARS = 6000;
const GUIDANCE_DEBUG_KILL_SWITCH_ENV = "GOATCITADEL_DISABLE_GUIDANCE_INJECTION";

interface ChatSessionListQuery {
  scope?: "mission" | "external" | "all";
  workspaceId?: string;
  projectId?: string;
  q?: string;
  view?: "active" | "archived" | "all";
  limit?: number;
  cursor?: string;
}

type SessionAutonomyPrefs = SessionAutonomyPrefsRecord;

interface ProactiveTriggerInput {
  source?: "scheduler" | "manual" | "chat";
  reason?: string;
  prefs?: SessionAutonomyPrefs;
}

interface ProactivePlannedAction {
  kind: "tool" | "delegate" | "note";
  toolName?: string;
  args?: Record<string, unknown>;
  note?: string;
  objective?: string;
  roles?: string[];
}

interface ImprovementReplayTriggerInput {
  sampleSize?: number;
}

interface DecisionReplayCandidate {
  decisionType: "chat_turn" | "tool_run";
  sessionId?: string;
  turnId?: string;
  toolRunId?: string;
  status: string;
  occurredAt: string;
  model?: string;
  mode?: ChatMode;
  webMode?: ChatWebMode;
  memoryMode?: ChatMemoryMode;
  thinkingLevel?: ChatThinkingLevel;
  routing?: ChatTurnTraceRecord["routing"];
  retrieval?: ChatTurnTraceRecord["retrieval"];
  reflection?: ChatTurnTraceRecord["reflection"];
  toolName?: string;
  error?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  userMessageId?: string;
  assistantMessageId?: string;
}

interface ReplayScoredItemResult {
  item: DecisionReplayItemRecord;
  judgeUsed: boolean;
}

interface RealtimeListener {
  (event: RealtimeEvent): void;
}

interface ResolvedRuntimeGuidance {
  workspaceId: string;
  systemInstruction?: string;
  globalFilesUsed: string[];
  workspaceFilesUsed: string[];
  truncated: boolean;
}

class ChatTurnWriteConflictError extends ConflictError {
  public constructor(message: string) {
    super({ code: "WRITE_CONFLICT", message });
  }
}

class ChatTurnCancelledError extends GoatError {
  readonly code = "TURN_CANCELLED" as const;
  readonly httpStatus = 499;
  public constructor(
    public readonly turnId: string,
    message = "Chat turn cancelled.",
  ) {
    super(message, { turnId });
  }
}

function isChatTurnCancelledError(error: unknown): boolean {
  if (error instanceof ChatTurnCancelledError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  return name.includes("cancel") || message.includes("chat turn cancelled");
}

interface ActiveChatTurnExecution {
  sessionId: string;
  turnId: string;
  operation: string;
  startedAt: string;
  controller: AbortController;
}

interface ActiveChatTurnStreamExecution {
  sessionId: string;
  turnId: string;
  runId?: string;
  startedAt: string;
  nextSequence: number;
  completed: boolean;
}

type PersistableChatStreamChunk = ChatStreamChunkDraft extends infer T
  ? T extends { turnId?: string }
    ? T & { turnId: string }
    : never
  : never;

type InspectableChatStreamChunk = ChatStreamChunk | ChatStreamChunkDraft;

function isPersistableChatStreamChunk(chunk: ChatStreamChunkDraft): chunk is PersistableChatStreamChunk {
  return typeof chunk.turnId === "string" && chunk.turnId.length > 0;
}

interface PreparedChatExecutionPlanResolution {
  routerInput: OrchestrationRouterInput;
  orchestrationPlan: ModeOrchestrationPlan;
  executionPlanDraft: {
    source: "planner" | "workflow_template" | "planner_with_template_fallback";
    advisoryOnly: boolean;
    objective: string;
    summary: string;
    steps: Array<{
      stepId: string;
      index: number;
      objective: string;
      successCriteria?: string;
      suggestedTools?: string[];
      expectedOutput?: string;
      parallelizable: boolean;
      dependsOnStepIds?: string[];
      delegatedRole?: string;
      status: "pending" | "running" | "completed" | "failed" | "cancelled";
      summary?: string;
      error?: string;
      startedAt?: string;
      finishedAt?: string;
      childRunId?: string;
      childSessionId?: string;
      childTurnId?: string;
    }>;
  };
}

interface DurableChatTurnExecutionPayload {
  version: "chat.turn.execute.v1";
  sessionId: string;
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  branchKind: ChatTurnBranchKind;
  parentTurnId?: string;
  sourceTurnId?: string;
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited";
  request: ChatSendMessageRequest;
}

interface RemoteApprovalActionTokenIssueResult extends RemoteActionTokenRecord {
  approvalId: string;
  token: string;
}

const CHAT_COMPACTION_RECENT_TURN_LIMIT = 6;
const CHAT_COMPACTION_WINDOW_SIZE = 8;
const CHAT_COMPACTION_TRIGGER_TOKENS = 2200;
const CHAT_COMPACTION_SUMMARY_TOKEN_BUDGET = 360;
const CHAT_PLANNER_MAX_STEPS = 8;
const CHAT_PLANNER_MIN_STEPS = 3;

export class GatewayService {
  private readonly storage: Storage;
  private readonly eventIngestService: EventIngestService;
  private readonly policyEngine: ToolPolicyEngine;
  private readonly skillsService: SkillsService;
  private readonly orchestrationEngine: OrchestrationEngine;
  private readonly llmService: LlmService;
  private readonly assemblyService: AssemblyService;
  private readonly memoryContextService: MemoryContextService;
  private readonly meshService: MeshService;
  private readonly npuSidecar: NpuSidecarService;
  private readonly approvalExplainer: ApprovalExplainerService;
  private readonly chatAgentOrchestrator: ChatAgentOrchestrator;
  private readonly researchService: ResearchService;
  private readonly obsidianVaultService: ObsidianVaultService;
  private readonly skillImportService: SkillImportService;
  private readonly cronAutomationService: CronAutomationService;
  private readonly addonsService: AddonsService;
  private readonly devDiagnostics: GatewayDevDiagnosticsService;
  private readonly chatProjectService: ChatProjectService;
  private readonly durableRunService: DurableRunService;
  private readonly chatLearnedMemoryService: ChatLearnedMemoryService;
  private readonly promptPackService: PromptPackService;
  private readonly chatProactiveService: ChatProactiveService;
  private readonly improvementService: ImprovementService;
  private readonly realtime = new EventEmitter();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly warnedOutsideRootPathFingerprints = new Set<string>();
  private readonly chatMessageProjectionBackfillAttempted = new Set<string>();
  private readonly activeChatTurnWrites = new Map<string, string>();
  private readonly activeChatTurns = new Map<string, ActiveChatTurnExecution>();
  private readonly activeChatTurnStreams = new Map<string, ActiveChatTurnStreamExecution>();
  private lastChatStreamPurgeAt = 0;
  private readonly operatorSummaryCache = new OperatorSummaryCache(15_000);
  private readonly onboardingMarkerPath: string;
  private maintenanceScheduler?: NodeJS.Timeout;
  private closing = false;
  private onboardingMarker: { completedAt?: string; completedBy?: string } = {};

  private get gatewaySql() {
    return this.storage.gatewaySql;
  }

  public constructor(private readonly config: GatewayRuntimeConfig) {
    this.storage = new Storage({
      dbPath: config.dbPath,
      transcriptsDir: path.resolve(config.rootDir, config.assistant.transcriptsDir),
      auditDir: path.resolve(config.rootDir, config.assistant.auditDir),
      tuning: {
        cacheSizeKb: config.assistant.sqlite.cacheSizeKb,
        tempStoreMemory: config.assistant.sqlite.tempStoreMemory,
        walAutoCheckpointPages: config.assistant.sqlite.walAutoCheckpointPages,
      },
    });
    this.onboardingMarkerPath = path.resolve(
      config.rootDir,
      config.assistant.dataDir,
      "onboarding-state.json",
    );
    this.devDiagnostics = new GatewayDevDiagnosticsService(
      resolveDevDiagnosticsEnabled(),
      undefined,
      resolveDevDiagnosticsVerbose(),
      resolveDevDiagnosticsBufferSize(process.env.GOATCITADEL_DEV_DIAGNOSTICS_GATEWAY_BUFFER),
    );

    this.eventIngestService = new EventIngestService(this.storage);
    this.policyEngine = new ToolPolicyEngine(config.toolPolicy, this.storage, undefined, {
      isBankrBuiltinEnabled: () => this.isFeatureEnabled("bankrBuiltinEnabled"),
    });
    const secretStore = new SecretStoreService();
    this.skillsService = new SkillsService([
      { source: "extra", dir: path.join(config.rootDir, "skills", "extra") },
      { source: "extra", dir: path.join(config.rootDir, "skills", "genie-npu-ir20") },
      { source: "bundled", dir: path.join(config.rootDir, "skills", "bundled") },
      { source: "managed", dir: path.join(config.rootDir, ".assistant", "skills") },
      { source: "workspace", dir: path.join(config.rootDir, "skills", "workspace") },
    ]);
    this.orchestrationEngine = new OrchestrationEngine();
    this.llmService = new LlmService(config.llm, process.env, {
      networkAllowlist: config.toolPolicy.sandbox.networkAllowlist,
      secretStore,
    });
    this.assemblyService = new AssemblyService({
      storage: this.storage,
      rootDir: config.rootDir,
      createChatCompletion: (request) => this.createChatCompletion(request),
      publishRealtime: (eventType, source, payload) => this.publishRealtime(eventType, source, payload),
    });
    this.memoryContextService = new MemoryContextService(
      this.storage,
      this.llmService,
      config,
      (eventType, payload) => {
        this.publishRealtime(eventType, "memory", payload);
      },
    );
    this.meshService = new MeshService(this.storage, {
      enabled: config.assistant.mesh.enabled,
      mode: config.assistant.mesh.mode,
      localNodeId: config.assistant.mesh.nodeId,
      localNodeLabel: config.assistant.mesh.label,
      advertiseAddress: config.assistant.mesh.advertiseAddress,
      requireMtls: config.assistant.mesh.security.requireMtls,
      tailnetEnabled: config.assistant.mesh.security.tailnet.enabled,
      joinToken: process.env[config.assistant.mesh.security.joinTokenEnv],
      defaultLeaseTtlSeconds: config.assistant.mesh.leases.ttlSeconds,
    });
    this.npuSidecar = new NpuSidecarService({
      rootDir: config.rootDir,
      config: config.assistant.npu,
      onEvent: (eventType, payload) => {
        this.publishRealtime(eventType, "npu", payload);
      },
    });
    this.approvalExplainer = new ApprovalExplainerService(
      this.storage,
      this.llmService,
      config.assistant.approvalExplainer,
      (payload) => {
        this.publishRealtime("approval_explained", "approvals", { ...payload });
      },
    );
    this.chatAgentOrchestrator = new ChatAgentOrchestrator({
      storage: this.storage,
      listToolCatalog: () => this.listToolCatalog(),
      createChatCompletion: (request) => this.createChatCompletion(request),
      createChatCompletionStream: (request) => this.createChatCompletionStream(request),
      invokeTool: (request) => this.invokeTool(request),
      persistToolArtifact: (input) => this.persistChatToolArtifact(input),
      evaluateToolAccess: (request) => this.policyEngine.evaluateAccess(request),
      invokeMcpTool: (request) => this.invokeMcpTool(request),
      listMcpBrowserFallbackTargets: () => this.listMcpBrowserFallbackTargets(),
    });
    this.researchService = new ResearchService({
      storage: this.storage,
      invokeTool: (request) => this.invokeTool(request),
      createChatCompletion: (request) => this.createChatCompletion(request),
    });
    this.obsidianVaultService = new ObsidianVaultService(this.storage.systemSettings);
    this.skillImportService = new SkillImportService(config.rootDir, this.storage.systemSettings);
    this.addonsService = new AddonsService(config.rootDir);
    this.cronAutomationService = new CronAutomationService({
      storage: this.storage,
      persistCronJobsConfig: () => this.persistCronJobsConfig(),
      publishRealtime: (eventType, source, payload) => this.publishRealtime(eventType, source, payload ?? {}),
      requireFeatureEnabled: (flag) => this.requireFeatureEnabled(flag),
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag),
      runHandlers: {
        improvement: async () => {
          await this.improvementService.runWeeklyImprovementSchedulerIfDue({ force: true });
        },
        backup: async () => {
          await this.runPrivateBetaBackupSchedulerIfDue({ force: true });
        },
        memoryFlush: async () => {
          await this.runMemoryFlushSchedulerIfDue({ force: true });
        },
        costReport: async () => {
          await this.runCostReportSchedulerIfDue({ force: true });
        },
      },
    });

    // ── extracted sub-services (Phase 2 facade pattern) ──────────
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const serviceCtx: ServiceContext = {
      storage: this.storage,
      config: this.config,
      llmService: this.llmService,
      policyEngine: this.policyEngine,
      gatewaySql: this.storage.gatewaySql,
      publishRealtime: (eventType, source, payload) => this.publishRealtime(eventType, source, payload),
      requireFeatureEnabled: (flag) => this.requireFeatureEnabled(flag),
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag),
      normalizeWorkspaceId: (workspaceId) => this.normalizeWorkspaceId(workspaceId),
    };
    this.chatProjectService = new ChatProjectService(serviceCtx);
    this.durableRunService = new DurableRunService(serviceCtx, {
      backgroundTasks: this.backgroundTasks,
      executeWorkflow: (run) => this.executeDurableWorkflowRun(run),
      isWorkflowRecoverable: (run) => this.isDurableWorkflowRecoverable(run),
      markWorkflowUnrecoverable: async (run, reason) => {
        await this.markDurableWorkflowUnrecoverable(run, reason);
      },
    });
    this.chatLearnedMemoryService = new ChatLearnedMemoryService(serviceCtx);
    this.promptPackService = new PromptPackService(serviceCtx, {
      createChatSession: (input) => this.createChatSession(input),
      agentSendChatMessage: (sessionId, input) => this.agentSendChatMessage(sessionId, input),
      createChatCompletion: (request) => this.createChatCompletion(request),
      getPromptRunnerModelDefaults: () => this.getPromptRunnerModelDefaults(),
      backgroundTasks: this.backgroundTasks,
    });
    this.chatProactiveService = new ChatProactiveService(serviceCtx, {
      listChatSessions: (query) => this.listChatSessions(query),
      getSession: (sessionId) => this.getSession(sessionId),
      hasRunningTurn: (sessionId) => this.hasRunningTurn(sessionId),
      getSessionIdleSeconds: (sessionId) => this.getSessionIdleSeconds(sessionId),
      listChatMessages: (sessionId, limit) => this.listChatMessages(sessionId, limit),
      invokeTool: (request) => this.invokeTool(request),
      detectDelegationRoles: (text) => detectDelegationRoles(text),
      backgroundTasks: this.backgroundTasks,
      get closing() { return self.closing; },
    });
    this.improvementService = new ImprovementService(serviceCtx, {
      createChatCompletion: (request) => this.createChatCompletion(request),
      getPromptRunnerModelDefaults: () => this.getPromptRunnerModelDefaults(),
      readTranscriptOrEmpty: (sessionId) => this.readTranscriptOrEmpty(sessionId),
      backgroundTasks: this.backgroundTasks,
      get closing() { return self.closing; },
    });
  }

  public isDevDiagnosticsEnabled(): boolean {
    return this.devDiagnostics.isEnabled();
  }

  private async persistChatToolArtifact(input: {
    sessionId: string;
    turnId: string;
    toolRunId: string;
    toolName: string;
    content: string;
    contentType?: string;
    snippet?: string;
    createdAt?: string;
  }): Promise<{
    artifactId: string;
    storageRelPath: string;
    byteLength: number;
    contentType?: string;
    snippet?: string;
  }> {
    const artifactId = randomUUID();
    const digest = createHash("sha256").update(input.content, "utf8").digest("hex");
    const extension = inferToolArtifactExtension(input.contentType);
    const storageRelPath = path.join("tool-artifacts", digest.slice(0, 2), `${digest}${extension}`);
    const absolutePath = path.resolve(this.config.rootDir, this.config.assistant.dataDir, storageRelPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    if (!fsSync.existsSync(absolutePath)) {
      await fs.writeFile(absolutePath, input.content, "utf8");
    }
    const record = this.storage.chatToolArtifacts.create({
      artifactId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolRunId: input.toolRunId,
      toolName: input.toolName,
      contentType: input.contentType,
      byteLength: Buffer.byteLength(input.content, "utf8"),
      snippet: input.snippet?.slice(0, 4000),
      storageRelPath,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
    return {
      artifactId: record.artifactId,
      storageRelPath: record.storageRelPath,
      byteLength: record.byteLength,
      contentType: record.contentType,
      snippet: record.snippet,
    };
  }

  public listDevDiagnostics(input?: {
    level?: "debug" | "info" | "warn" | "error";
    category?: string;
    correlationId?: string;
    limit?: number;
  }) {
    return this.devDiagnostics.list(input);
  }

  public subscribeDevDiagnostics(listener: Parameters<GatewayDevDiagnosticsService["subscribe"]>[0]): () => void {
    return this.devDiagnostics.subscribe(listener);
  }

  public recordDevDiagnostic(input: Parameters<GatewayDevDiagnosticsService["record"]>[0]): void {
    this.devDiagnostics.record(input);
  }

  public attachDevDiagnosticsLogger(logger: { debug: Function; info: Function; warn: Function; error: Function }): void {
    this.devDiagnostics.setLogger(logger as never);
  }

  public async init(): Promise<void> {
    await this.loadOnboardingMarker();
    this.applyStoredFeatureFlags();
    this.storage.agentProfiles.seedBuiltins(BUILTIN_AGENT_PROFILES);
    const skills = await this.skillsService.reload();
    this.ensureSkillStates(skills.map((skill) => skill.skillId));
    this.improvementService.markInterruptedDecisionReplayRuns();
    await this.loadCronJobsFromConfig();
    this.improvementService.ensureWeeklyImprovementCronJob();
    this.ensurePrivateBetaBackupCronJob();
    this.ensureMemoryFlushCronJob();
    this.ensureCostReportCronJob();
    this.meshService.init();
    await this.npuSidecar.init();
    // Enforce env-only secret persistence policy on startup.
    this.persistLlmConfig();
    this.persistAssistantConfig();
    this.startProactiveScheduler();
    this.improvementService.startScheduler();
    this.startMaintenanceScheduler();
    this.durableRunService.startWorker();
    if (isVerboseLoggingEnabled()) {
      console.info(
        "[goatcitadel] feature flags",
        JSON.stringify(this.readFeatureFlags()),
      );
    } else {
      console.info("[goatcitadel] runtime ready");
    }
  }

  public subscribeRealtime(listener: RealtimeListener): () => void {
    this.realtime.on("event", listener);
    return () => {
      this.realtime.off("event", listener);
    };
  }

  public listRealtimeEvents(limit = 100, cursor?: string): RealtimeEvent[] {
    return this.storage.realtimeEvents.list(limit, cursor);
  }

  public listRealtimeEventsAfterSequence(afterSequence: number, limit = 100): RealtimeEvent[] {
    return this.storage.realtimeEvents.listAfterSequence(afterSequence, limit);
  }

  public getRealtimeEventSequenceBounds(): { oldestSequence?: number; newestSequence?: number } {
    return this.storage.realtimeEvents.getSequenceBounds();
  }

  public async ingestEvent(
    idempotencyKey: string,
    payload: GatewayEventInput,
  ): Promise<GatewayEventResult> {
    const result = await this.eventIngestService.ingest({
      endpoint: "/api/v1/gateway/events",
      idempotencyKey,
      payload,
    });

    this.publishRealtime("session_event", "gateway", {
      eventId: payload.eventId,
      sessionId: result.session.sessionId,
      sessionKey: result.session.sessionKey,
      actorType: payload.actor.type,
      actorId: payload.actor.id,
      messageRole: payload.message.role,
      taskId: payload.taskId,
      deduped: result.deduped,
    });

    if (!result.deduped) {
      this.operatorSummaryCache.invalidate();
    }

    return result;
  }

  public listSessions(limit: number, cursor?: string) {
    return this.storage.sessions.list(limit, cursor);
  }

  public getSession(sessionId: string) {
    return this.storage.sessions.getBySessionId(sessionId);
  }

  public listWorkspaces(view: "active" | "archived" | "all" = "active", limit = 200): WorkspaceRecord[] {
    return this.storage.workspaces.list(view, limit);
  }

  public getWorkspace(workspaceId: string): WorkspaceRecord {
    return this.storage.workspaces.get(this.normalizeWorkspaceId(workspaceId));
  }

  public createWorkspace(input: WorkspaceCreateInput): WorkspaceRecord {
    const created = this.storage.workspaces.create(input);
    this.publishRealtime("workspace_created", "system", {
      workspaceId: created.workspaceId,
      name: created.name,
      slug: created.slug,
    });
    return created;
  }

  public updateWorkspace(workspaceId: string, input: WorkspaceUpdateInput): WorkspaceRecord {
    const updated = this.storage.workspaces.update(this.normalizeWorkspaceId(workspaceId), input);
    this.publishRealtime("workspace_updated", "system", {
      workspaceId: updated.workspaceId,
      name: updated.name,
      slug: updated.slug,
    });
    return updated;
  }

  public archiveWorkspace(workspaceId: string): WorkspaceRecord {
    const archived = this.storage.workspaces.archive(this.normalizeWorkspaceId(workspaceId));
    this.publishRealtime("workspace_archived", "system", {
      workspaceId: archived.workspaceId,
    });
    return archived;
  }

  public restoreWorkspace(workspaceId: string): WorkspaceRecord {
    const restored = this.storage.workspaces.restore(this.normalizeWorkspaceId(workspaceId));
    this.publishRealtime("workspace_restored", "system", {
      workspaceId: restored.workspaceId,
    });
    return restored;
  }

  public async listGlobalGuidance(): Promise<GuidanceDocumentRecord[]> {
    const docs = await Promise.all(
      (Object.keys(GUIDANCE_DOC_FILE_MAP) as GuidanceDocType[]).map((docType) => this.readGuidanceDocument(docType, "global")),
    );
    return docs;
  }

  public async listWorkspaceGuidance(workspaceId: string): Promise<GuidanceBundleRecord> {
    const normalizedWorkspaceId = this.normalizeWorkspaceId(workspaceId);
    this.storage.workspaces.get(normalizedWorkspaceId);
    const [globalDocs, workspaceDocs] = await Promise.all([
      this.listGlobalGuidance(),
      Promise.all(
        WORKSPACE_GUIDANCE_DOC_TYPES.map((docType) =>
          this.readGuidanceDocument(docType, "workspace", normalizedWorkspaceId)),
      ),
    ]);
    return {
      workspaceId: normalizedWorkspaceId,
      global: globalDocs,
      workspace: workspaceDocs,
    };
  }

  public async updateGlobalGuidance(docType: GuidanceDocType, content: string): Promise<GuidanceDocumentRecord> {
    await this.writeGuidanceDocument(docType, "global", undefined, content);
    this.publishRealtime("guidance_updated", "system", {
      scope: "global",
      docType,
    });
    return this.readGuidanceDocument(docType, "global");
  }

  public async updateWorkspaceGuidance(
    workspaceId: string,
    docType: GuidanceDocType,
    content: string,
  ): Promise<GuidanceDocumentRecord> {
    const normalizedWorkspaceId = this.normalizeWorkspaceId(workspaceId);
    this.storage.workspaces.get(normalizedWorkspaceId);
    if (!WORKSPACE_GUIDANCE_DOC_TYPES.includes(docType)) {
      throw new Error(`Workspace override is not supported for ${docType}; use global guidance instead.`);
    }
    await this.writeGuidanceDocument(docType, "workspace", normalizedWorkspaceId, content);
    this.publishRealtime("guidance_updated", "system", {
      scope: "workspace",
      workspaceId: normalizedWorkspaceId,
      docType,
    });
    return this.readGuidanceDocument(docType, "workspace", normalizedWorkspaceId);
  }

  public async getTranscript(sessionId: string) {
    return this.storage.transcripts.read(sessionId);
  }

  public async getSessionSummary(sessionId: string): Promise<SessionSummary> {
    const session = this.getSession(sessionId);
    const events = await this.readTranscriptOrEmpty(sessionId);
    const latest = events.at(-1);
    const countsByType: Record<string, number> = {};
    let lastMessagePreview: string | undefined;

    for (const event of events) {
      countsByType[event.type] = (countsByType[event.type] ?? 0) + 1;
      if (event.type === "message.user" || event.type === "message.assistant") {
        const content = this.extractMessagePreview(event.payload);
        if (content) {
          lastMessagePreview = content;
        }
      }
    }

    return {
      session,
      transcriptEventCount: events.length,
      latestEventAt: latest?.timestamp,
      latestEventType: latest?.type,
      lastMessagePreview,
      countsByType,
    };
  }

  public async listSessionTimeline(sessionId: string, limit = 200): Promise<SessionTimelineItem[]> {
    const events = await this.readTranscriptOrEmpty(sessionId);
    const bounded = events.slice(-Math.max(1, Math.min(limit, 1000)));
    return bounded.reverse().map((event) => ({
      eventId: event.eventId,
      timestamp: event.timestamp,
      type: event.type,
      actorType: event.actorType,
      actorId: event.actorId,
      preview: this.extractMessagePreview(event.payload),
      payload: event.payload,
      tokenInput: event.tokenInput,
      tokenOutput: event.tokenOutput,
      costUsd: event.costUsd,
    }));
  }

  public listChatProjects(
    view: "active" | "archived" | "all" = "active",
    limit = 300,
    workspaceId?: string,
  ): ChatProjectRecord[] {
    return this.chatProjectService.listChatProjects(view, limit, workspaceId);
  }

  public createChatProject(input: {
    workspaceId?: string;
    name: string;
    description?: string;
    workspacePath: string;
    color?: string;
  }): ChatProjectRecord {
    return this.chatProjectService.createChatProject(input);
  }

  public updateChatProject(projectId: string, input: {
    workspaceId?: string;
    name?: string;
    description?: string;
    workspacePath?: string;
    color?: string;
  }): ChatProjectRecord {
    return this.chatProjectService.updateChatProject(projectId, input);
  }

  public archiveChatProject(projectId: string): ChatProjectRecord {
    return this.chatProjectService.archiveChatProject(projectId);
  }

  public restoreChatProject(projectId: string): ChatProjectRecord {
    return this.chatProjectService.restoreChatProject(projectId);
  }

  public hardDeleteChatProject(projectId: string): boolean {
    return this.chatProjectService.hardDeleteChatProject(projectId);
  }

  public listChatSessions(query: ChatSessionListQuery = {}): ChatSessionRecord[] {
    const workspaceId = this.normalizeWorkspaceId(query.workspaceId);
    const scope = query.scope ?? "all";
    const view = query.view ?? "active";
    const limit = Math.max(1, Math.min(1000, Math.floor(query.limit ?? 200)));
    const allSessions = this.storage.sessions.list(20000);
    const projects = this.storage.chatProjects.list("all", 2000, workspaceId);
    const projectById = new Map(projects.map((project) => [project.projectId, project]));
    const sessionIds = allSessions.map((session) => session.sessionId);
    const metaBySessionId = this.storage.chatSessionMeta.listBySessionIds(sessionIds, workspaceId);
    const projectLinkBySessionId = this.storage.chatSessionProjects.listBySessionIds(sessionIds);

    let records = allSessions.map((session) => {
      const meta = metaBySessionId.get(session.sessionId) ?? this.storage.chatSessionMeta.ensure(session.sessionId, undefined, workspaceId);
      const link = projectLinkBySessionId.get(session.sessionId);
      const project = link ? projectById.get(link.projectId) : undefined;
      return toChatSessionRecord(session, meta, project);
    });

    records = records.filter((record) => this.normalizeWorkspaceId(record.workspaceId) === workspaceId);

    if (scope !== "all") {
      records = records.filter((record) => record.scope === scope);
    }
    if (view !== "all") {
      records = records.filter((record) => record.lifecycleStatus === view);
    }
    if (query.projectId) {
      records = records.filter((record) => record.projectId === query.projectId);
    }
    if (query.q?.trim()) {
      const q = query.q.trim().toLowerCase();
      records = records.filter((record) => {
        const haystack = [
          record.title ?? "",
          record.sessionKey,
          record.channel,
          record.account,
          record.projectName ?? "",
        ].join(" ").toLowerCase();
        return haystack.includes(q);
      });
    }

    records.sort((left, right) => {
      if (left.pinned !== right.pinned) {
        return left.pinned ? -1 : 1;
      }
      const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      if (byUpdated !== 0) {
        return byUpdated;
      }
      return right.sessionId.localeCompare(left.sessionId);
    });

    if (query.cursor) {
      const [cursorUpdatedAt, cursorSessionId] = query.cursor.split("|");
      if (cursorUpdatedAt && cursorSessionId) {
        records = records.filter((record) => {
          if (record.updatedAt < cursorUpdatedAt) {
            return true;
          }
          if (record.updatedAt > cursorUpdatedAt) {
            return false;
          }
          return record.sessionId < cursorSessionId;
        });
      }
    }

    return records.slice(0, limit);
  }

  public createChatSession(input: {
    workspaceId?: string;
    title?: string;
    projectId?: string;
    mode?: ChatMode;
  }): ChatSessionRecord {
    const workspaceId = this.normalizeWorkspaceId(input.workspaceId);
    const peer = `chat_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const route = {
      channel: "mission",
      account: "operator",
      peer,
    };
    const resolution = {
      kind: "dm" as const,
      sessionKey: `${route.channel}:${route.account}:${route.peer}`,
      sessionId: `sess_${createHash("sha256").update(`${route.channel}:${route.account}:${route.peer}`).digest("hex").slice(0, 24)}`,
    };
    const now = new Date().toISOString();
    this.storage.sessions.upsert({
      sessionId: resolution.sessionId,
      sessionKey: resolution.sessionKey,
      kind: resolution.kind,
      channel: route.channel,
      account: route.account,
      displayName: input.title?.trim() || undefined,
      timestamp: now,
    });
    this.operatorSummaryCache.invalidate();
    this.storage.chatSessionMeta.ensure(resolution.sessionId, now, workspaceId);
    this.storage.chatSessionPrefs.ensure(resolution.sessionId, now);
    this.ensureChatSessionRuntimeGrants(resolution.sessionId);
    if (input.title?.trim()) {
      this.storage.chatSessionMeta.patch(resolution.sessionId, {
        workspaceId,
        title: input.title.trim(),
      }, now);
    }
    this.storage.chatSessionBindings.upsert({
      sessionId: resolution.sessionId,
      workspaceId,
      transport: "llm",
      writable: true,
    }, now);
    if (input.projectId) {
      const project = this.storage.chatProjects.get(input.projectId);
      if (this.normalizeWorkspaceId(project.workspaceId) !== workspaceId) {
        throw new Error("project workspace does not match requested session workspace");
      }
      this.storage.chatSessionProjects.assign(resolution.sessionId, input.projectId, now);
    }
    if (input.mode) {
      this.storage.chatSessionPrefs.patch(resolution.sessionId, buildChatModePrefsPatch(input.mode), now);
    }
    const created = this.requireChatSession(resolution.sessionId);
    if (!created) {
      throw new Error(`Failed to create chat session ${resolution.sessionId}`);
    }
    this.publishRealtime("chat_session_updated", "chat", {
      type: "chat_session_created",
      sessionId: created.sessionId,
      sessionKey: created.sessionKey,
    });
    return created;
  }

  public updateChatSession(sessionId: string, input: { title?: string }): ChatSessionRecord {
    this.getSession(sessionId);
    this.storage.chatSessionMeta.patch(sessionId, {
      title: input.title,
    });
    const updated = this.requireChatSession(sessionId);
    this.publishRealtime("chat_session_title_updated", "chat", {
      type: "chat_session_title_updated",
      sessionId: updated.sessionId,
      title: updated.title,
    });
    return updated;
  }

  private maybeAutoTitleChatSession(sessionId: string, content: string): void {
    const meta = this.storage.chatSessionMeta.ensure(sessionId);
    if (meta.title?.trim()) {
      return;
    }
    const derivedTitle = deriveChatSessionTitleFromContent(content);
    if (!derivedTitle) {
      return;
    }
    this.storage.chatSessionMeta.patch(sessionId, { title: derivedTitle });
    this.publishRealtime("chat_session_title_updated", "chat", {
      type: "chat_session_title_updated",
      sessionId,
      title: derivedTitle,
    });
  }

  public pinChatSession(sessionId: string): ChatSessionRecord {
    this.getSession(sessionId);
    this.storage.chatSessionMeta.patch(sessionId, { pinned: true });
    const updated = this.requireChatSession(sessionId);
    this.publishRealtime("chat_session_updated", "chat", buildChatSessionUpdatedPayload("chat_session_pinned", updated));
    return updated;
  }

  public unpinChatSession(sessionId: string): ChatSessionRecord {
    this.getSession(sessionId);
    this.storage.chatSessionMeta.patch(sessionId, { pinned: false });
    const updated = this.requireChatSession(sessionId);
    this.publishRealtime("chat_session_updated", "chat", buildChatSessionUpdatedPayload("chat_session_unpinned", updated));
    return updated;
  }

  public archiveChatSession(sessionId: string): ChatSessionRecord {
    this.getSession(sessionId);
    this.storage.chatSessionMeta.patch(sessionId, {
      lifecycleStatus: "archived",
      archivedAt: new Date().toISOString(),
    });
    const updated = this.requireChatSession(sessionId);
    this.publishRealtime("chat_session_updated", "chat", buildChatSessionUpdatedPayload("chat_session_archived", updated));
    return updated;
  }

  public restoreChatSession(sessionId: string): ChatSessionRecord {
    this.getSession(sessionId);
    this.storage.chatSessionMeta.patch(sessionId, {
      lifecycleStatus: "active",
      archivedAt: undefined,
    });
    const updated = this.requireChatSession(sessionId);
    this.publishRealtime("chat_session_updated", "chat", buildChatSessionUpdatedPayload("chat_session_restored", updated));
    return updated;
  }

  public async deleteChatSession(sessionId: string): Promise<{ deleted: boolean; sessionId: string }> {
    this.getSession(sessionId);
    const result = this.storage.deleteChatSessionData(sessionId);
    this.activeChatTurnWrites.delete(sessionId);
    this.operatorSummaryCache.invalidate();
    const cleanupResults = await Promise.allSettled([
      this.storage.transcripts.delete(sessionId),
      ...result.cleanupRelPaths.map((storageRelPath) => this.removeChatSessionStoredFile(storageRelPath)),
    ]);
    for (const cleanupResult of cleanupResults) {
      if (cleanupResult.status === "rejected") {
        console.warn("[goatcitadel] chat session delete cleanup failed", {
          sessionId,
          error: cleanupResult.reason instanceof Error ? cleanupResult.reason.message : String(cleanupResult.reason),
        });
      }
    }
    this.publishRealtime("chat_session_deleted", "chat", {
      type: "chat_session_deleted",
      sessionId,
      mode: "hard",
    });
    return {
      deleted: result.deleted,
      sessionId,
    };
  }

  private async removeChatSessionStoredFile(storageRelPath: string): Promise<void> {
    const normalized = storageRelPath.trim();
    if (!normalized) {
      return;
    }
    const fullPath = path.resolve(this.config.rootDir, this.config.assistant.workspaceDir, normalized);
    assertWritePathInJail(fullPath, this.config.toolPolicy.sandbox.writeJailRoots);
    await fs.rm(fullPath, { force: true });
  }

  public assignChatSessionProject(sessionId: string, projectId?: string): ChatSessionRecord {
    this.getSession(sessionId);
    const meta = this.storage.chatSessionMeta.ensure(sessionId);
    const workspaceId = this.normalizeWorkspaceId(meta.workspaceId);
    if (!projectId) {
      this.storage.chatSessionProjects.unassign(sessionId);
      const updated = this.requireChatSession(sessionId);
      this.publishRealtime("chat_session_updated", "chat", buildChatSessionUpdatedPayload("chat_session_project_unassigned", updated));
      return updated;
    }
    const project = this.storage.chatProjects.get(projectId);
    if (this.normalizeWorkspaceId(project.workspaceId) !== workspaceId) {
      throw new Error("project workspace does not match session workspace");
    }
    this.storage.chatSessionProjects.assign(sessionId, projectId);
    const updated = this.requireChatSession(sessionId);
    this.publishRealtime("chat_session_updated", "chat", buildChatSessionUpdatedPayload("chat_session_project_assigned", updated));
    return updated;
  }

  public getChatSessionBinding(sessionId: string): ChatSessionBindingRecord | undefined {
    this.getSession(sessionId);
    return this.storage.chatSessionBindings.get(sessionId);
  }

  public setChatSessionBinding(input: {
    sessionId: string;
    transport: "llm" | "integration";
    connectionId?: string;
    target?: string;
    writable?: boolean;
  }): ChatSessionBindingRecord {
    this.getSession(input.sessionId);
    const sessionMeta = this.storage.chatSessionMeta.ensure(input.sessionId);
    if (input.transport === "integration") {
      if (!input.connectionId?.trim() || !input.target?.trim()) {
        throw new Error("connectionId and target are required for integration transport");
      }
      this.storage.integrationConnections.get(input.connectionId);
    }
    const binding = this.storage.chatSessionBindings.upsert({
      sessionId: input.sessionId,
      workspaceId: this.normalizeWorkspaceId(sessionMeta.workspaceId),
      transport: input.transport,
      connectionId: input.connectionId?.trim() || undefined,
      target: input.target?.trim() || undefined,
      writable: input.writable,
    });
    this.publishRealtime("chat_session_updated", "chat", {
      type: "chat_session_binding_updated",
      sessionId: input.sessionId,
      transport: binding.transport,
    });
    return binding;
  }

  public async listChatMessages(sessionId: string, limit = 200, cursor?: string): Promise<ChatMessageRecord[]> {
    this.getSession(sessionId);
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    try {
      await this.ensureChatMessageProjection(sessionId);
      return this.storage.chatMessages.list(sessionId, safeLimit, cursor);
    } catch (error) {
      console.warn("[goatcitadel] chat message projection unavailable, falling back to transcript scan", {
        sessionId,
        error: (error as Error).message,
      });
      return this.listChatMessagesFromTranscript(sessionId, safeLimit, cursor);
    }
  }

  private async loadChatTurnSessionState(sessionId: string): Promise<{
    traces: ChatTurnTraceRecord[];
    tracesById: Map<string, ChatTurnTraceRecord>;
    turnLineageById: Map<string, { turnId: string; parentTurnId?: string }>;
    messages: ChatMessageRecord[];
    messagesById: Map<string, ChatMessageRecord>;
    childrenByTurnId: Map<string, string[]>;
    activeLeafTurnId?: string;
  }> {
    await this.ensureChatMessageProjection(sessionId);
    const traces = this.listHydratedChatTurnTraces(sessionId, 2_000);
    const messages = this.storage.chatMessages.list(sessionId, 5_000);
    return {
      traces,
      tracesById: new Map(traces.map((trace) => [trace.turnId, trace])),
      turnLineageById: new Map(traces.map((trace) => [trace.turnId, {
        turnId: trace.turnId,
        parentTurnId: trace.parentTurnId,
      }])),
      messages,
      messagesById: new Map(messages.map((message) => [message.messageId, message])),
      childrenByTurnId: this.buildChatTurnChildrenMap(traces),
      activeLeafTurnId: this.resolveChatActiveLeafTurnId(sessionId, traces),
    };
  }

  public async getChatThread(sessionId: string): Promise<ChatThreadResponse> {
    this.getSession(sessionId);
    const state = await this.loadChatTurnSessionState(sessionId);
    return buildChatThreadResponse({
      sessionId,
      activeLeafTurnId: state.activeLeafTurnId,
      turns: state.traces.map((trace) => ({
        trace,
        userMessage: state.messagesById.get(trace.userMessageId),
        assistantMessage: trace.assistantMessageId ? state.messagesById.get(trace.assistantMessageId) : undefined,
      })),
    });
  }

  public async selectChatBranchTurn(sessionId: string, turnId: string): Promise<ChatThreadResponse> {
    this.getSession(sessionId);
    const state = await this.loadChatTurnSessionState(sessionId);
    const target = state.traces.find((trace) => trace.turnId === turnId);
    if (!target) {
      throw new Error(`Chat turn ${turnId} not found in session ${sessionId}`);
    }
    const newestLeafTurnId = resolveNewestLeafTurnId(
      turnId,
      new Map(state.traces.map((trace) => [trace.turnId, {
        turnId: trace.turnId,
        startedAtMs: Date.parse(trace.startedAt) || 0,
      }])),
      state.childrenByTurnId,
    );
    this.storage.chatSessionBranchState.setActiveLeaf(sessionId, newestLeafTurnId);
    this.publishRealtime("chat_thread_updated", "chat", {
      type: "chat_thread_branch_selected",
      sessionId,
      turnId,
      activeLeafTurnId: newestLeafTurnId,
    });
    return buildChatThreadResponse({
      sessionId,
      activeLeafTurnId: newestLeafTurnId,
      turns: state.traces.map((trace) => ({
        trace,
        userMessage: state.messagesById.get(trace.userMessageId),
        assistantMessage: trace.assistantMessageId ? state.messagesById.get(trace.assistantMessageId) : undefined,
      })),
    });
  }

  public getChatSessionPrefs(sessionId: string): ChatSessionPrefsRecord {
    this.getSession(sessionId);
    const prefs = this.ensureGlmPrimaryDefaults(sessionId, this.storage.chatSessionPrefs.ensure(sessionId));
    return this.hydrateChatPrefsWithAutonomy(sessionId, prefs);
  }

  public updateChatSessionPrefs(
    sessionId: string,
    input: ChatSessionPrefsPatch,
  ): ChatSessionPrefsRecord {
    this.getSession(sessionId);
    const normalizedInput = applyChatModePresetToPatch(input);
    const { basePatch, autonomyPatch } = splitChatPrefsPatch(normalizedInput);
    if (Object.keys(autonomyPatch).length > 0) {
      this.patchSessionAutonomyPrefs(sessionId, autonomyPatch);
    }
    const updated = this.storage.chatSessionPrefs.patch(sessionId, basePatch);
    const normalized = this.ensureGlmPrimaryDefaults(sessionId, updated);
    const hydrated = this.hydrateChatPrefsWithAutonomy(sessionId, normalized);
    this.publishRealtime("chat_session_updated", "chat", {
      type: "chat_session_prefs_updated",
      sessionId,
      prefs: hydrated,
    });
    return hydrated;
  }

  private ensureGlmPrimaryDefaults(sessionId: string, prefs: ChatSessionPrefsRecord): ChatSessionPrefsRecord {
    if (prefs.providerId && prefs.model) {
      return prefs;
    }
    const defaults = this.getPromptRunnerModelDefaults();
    const patch: Partial<Omit<ChatSessionPrefsRecord, "sessionId" | "createdAt" | "updatedAt">> = {};
    if (!prefs.providerId && defaults.providerId) {
      patch.providerId = defaults.providerId;
    }
    if (!prefs.model && defaults.model) {
      patch.model = defaults.model;
    }
    if (Object.keys(patch).length === 0) {
      return prefs;
    }
    return this.storage.chatSessionPrefs.patch(sessionId, patch);
  }

  private hydrateChatPrefsWithAutonomy(sessionId: string, prefs: ChatSessionPrefsRecord): ChatSessionPrefsRecord {
    const autonomy = this.getSessionAutonomyPrefs(sessionId);
    return {
      ...prefs,
      proactiveMode: autonomy.proactiveMode,
      autonomyBudget: {
        maxActionsPerHour: autonomy.maxActionsPerHour,
        maxActionsPerTurn: autonomy.maxActionsPerTurn,
        cooldownSeconds: autonomy.cooldownSeconds,
      },
      retrievalMode: autonomy.retrievalMode,
      reflectionMode: autonomy.reflectionMode,
    };
  }

  private getSessionAutonomyPrefs(sessionId: string): SessionAutonomyPrefs {
    return this.storage.sessionAutonomyPrefs.ensure(sessionId);
  }

  private patchSessionAutonomyPrefs(
    sessionId: string,
    input: SessionAutonomyPrefsPatchInput,
  ): SessionAutonomyPrefs {
    return this.storage.sessionAutonomyPrefs.patch(sessionId, input);
  }

  private toProactivePolicy(sessionId: string, prefs: SessionAutonomyPrefs): ProactivePolicy {
    return this.chatProactiveService.toProactivePolicy(sessionId, prefs);
  }

  private startProactiveScheduler(): void {
    this.chatProactiveService.startScheduler();
  }

  // runWeeklyImprovementSchedulerIfDue moved to ImprovementService

  private startMaintenanceScheduler(): void {
    if (this.maintenanceScheduler) {
      return;
    }
    this.maintenanceScheduler = setInterval(() => {
      const task = this.runMaintenanceSchedulerTick().catch((error) => {
        console.error("[goatcitadel] maintenance scheduler tick failed", error);
      });
      this.backgroundTasks.add(task);
      task.finally(() => this.backgroundTasks.delete(task));
    }, IMPROVEMENT_SCHEDULER_INTERVAL_MS);
  }

  private async runMaintenanceSchedulerTick(): Promise<void> {
    if (this.closing) {
      return;
    }
    await this.runPrivateBetaBackupSchedulerIfDue();
    await this.runMemoryFlushSchedulerIfDue();
    await this.runCostReportSchedulerIfDue();
  }

  private async runPrivateBetaBackupSchedulerIfDue(options: { force?: boolean } = {}): Promise<void> {
    const job = this.storage.cronJobs.get(PRIVATE_BETA_BACKUP_JOB_ID);
    if (!job?.enabled) {
      return;
    }
    const now = new Date();
    if (!options.force && !isCronJobDueNow(job, now, {
      defaultHour: 2,
      defaultMinute: 30,
      defaultWeekday: undefined,
      defaultTimeZone: PRIVATE_BETA_BACKUP_TIME_ZONE,
    })) {
      return;
    }
    const dayKey = toDayKeyForTimezone(now, PRIVATE_BETA_BACKUP_TIME_ZONE);
    const lastDayKey = this.storage.systemSettings.get<string>(PRIVATE_BETA_BACKUP_DEDUP_SETTING_KEY)?.value;
    if (!options.force && dayKey === lastDayKey) {
      return;
    }

    const backupName = `private-beta-${dayKey.replaceAll("-", "")}`;
    const backup = await this.createBackup({ name: backupName });
    await this.pruneRetention({ dryRun: false });
    this.storage.systemSettings.set(PRIVATE_BETA_BACKUP_DEDUP_SETTING_KEY, dayKey);

    const finishedAt = new Date().toISOString();
    this.storage.cronJobs.upsert({
      ...job,
      lastRunAt: finishedAt,
      nextRunAt: new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString(),
    });
    this.publishRealtime("backup_created", "system", {
      type: "private_beta_daily_backup",
      backupId: backup.backupId,
      outputPath: backup.outputPath,
      bytes: backup.bytes,
    });
  }

  private async runMemoryFlushSchedulerIfDue(options: { force?: boolean } = {}): Promise<void> {
    const job = this.storage.cronJobs.get(MEMORY_FLUSH_DAILY_JOB_ID);
    if (!job?.enabled) {
      return;
    }
    const now = new Date();
    if (!options.force && !isCronJobDueNow(job, now, {
      defaultHour: 3,
      defaultMinute: 0,
      defaultWeekday: undefined,
      defaultTimeZone: MEMORY_FLUSH_DAILY_TIME_ZONE,
    })) {
      return;
    }
    const dayKey = toDayKeyForTimezone(now, MEMORY_FLUSH_DAILY_TIME_ZONE);
    const lastDayKey = this.storage.systemSettings.get<string>(MEMORY_FLUSH_DAILY_DEDUP_SETTING_KEY)?.value;
    if (!options.force && dayKey === lastDayKey) {
      return;
    }

    const nowIso = now.toISOString();
    const cutoffIso = new Date(now.getTime() - (MEMORY_FLUSH_HISTORY_DAYS * 24 * 60 * 60 * 1000)).toISOString();
    const prunedExpiredContextPacks = this.storage.memoryContexts.pruneExpired(nowIso);
    const prunedOldContextPacks = this.storage.memoryContexts.pruneOlderThan(cutoffIso);
    const prunedOldQmdRuns = this.storage.memoryQmdRuns.pruneOlderThan(cutoffIso);

    this.storage.systemSettings.set(MEMORY_FLUSH_DAILY_DEDUP_SETTING_KEY, dayKey);
    const finishedAt = new Date().toISOString();
    this.storage.cronJobs.upsert({
      ...job,
      lastRunAt: finishedAt,
      nextRunAt: new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString(),
    });
    this.publishRealtime("cron_job_run", "cron", {
      type: "memory_flush_daily",
      jobId: MEMORY_FLUSH_DAILY_JOB_ID,
      cutoffIso,
      prunedExpiredContextPacks,
      prunedOldContextPacks,
      prunedOldQmdRuns,
    });
  }

  private async runCostReportSchedulerIfDue(options: { force?: boolean } = {}): Promise<void> {
    const job = this.storage.cronJobs.get(COST_REPORT_HOURLY_JOB_ID);
    if (!job?.enabled) {
      return;
    }
    const now = new Date();
    if (!options.force && !isCronJobDueNow(job, now, {
      defaultHour: 0,
      defaultMinute: 0,
      defaultWeekday: undefined,
      defaultTimeZone: COST_REPORT_HOURLY_TIME_ZONE,
    })) {
      return;
    }
    const hourKey = toHourKeyForTimezone(now, COST_REPORT_HOURLY_TIME_ZONE);
    const lastHourKey = this.storage.systemSettings.get<string>(COST_REPORT_HOURLY_DEDUP_SETTING_KEY)?.value;
    if (!options.force && hourKey === lastHourKey) {
      return;
    }

    const windowEndIso = now.toISOString();
    const windowStartIso = new Date(now.getTime() - (COST_REPORT_LOOKBACK_HOURS * 60 * 60 * 1000)).toISOString();
    const byDay = this.storage.costLedger.summary("day", windowStartIso, windowEndIso);
    const bySession = this.storage.costLedger.summary("session", windowStartIso, windowEndIso);
    const byAgent = this.storage.costLedger.summary("agent", windowStartIso, windowEndIso);
    const byTask = this.storage.costLedger.summary("task", windowStartIso, windowEndIso);
    const usageAvailability = this.storage.costLedger.usageAvailability(windowStartIso, windowEndIso);
    const totalCostUsd = byDay.reduce((sum, row) => sum + row.costUsd, 0);
    const totalTokens = byDay.reduce((sum, row) => sum + row.tokenTotal, 0);

    const lines: string[] = [];
    lines.push(`# Cost Report (${COST_REPORT_LOOKBACK_HOURS}h)`);
    lines.push("");
    lines.push(`- Generated: ${windowEndIso}`);
    lines.push(`- Window: ${windowStartIso} -> ${windowEndIso}`);
    lines.push(`- Total cost: $${totalCostUsd.toFixed(6)}`);
    lines.push(`- Total tokens: ${totalTokens}`);
    lines.push(`- Tracked events: ${usageAvailability.trackedEvents}`);
    lines.push(`- Usage unavailable events: ${usageAvailability.unknownEvents}`);
    lines.push(`- Total agent events: ${usageAvailability.totalAgentEvents}`);
    lines.push("");

    const appendSummaryTable = (
      title: string,
      keyLabel: string,
      rows: Array<{
        key: string;
        tokenInput: number;
        tokenOutput: number;
        tokenCachedInput: number;
        tokenTotal: number;
        costUsd: number;
      }>,
    ) => {
      lines.push(`## ${title}`);
      lines.push("");
      if (rows.length === 0) {
        lines.push("_No data in this window._");
        lines.push("");
        return;
      }
      lines.push(`| ${keyLabel} | Token In | Token Out | Cached In | Token Total | Cost USD |`);
      lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
      for (const row of rows) {
        lines.push(`| ${row.key || "-"} | ${row.tokenInput} | ${row.tokenOutput} | ${row.tokenCachedInput} | ${row.tokenTotal} | ${row.costUsd.toFixed(6)} |`);
      }
      lines.push("");
    };

    appendSummaryTable("By Session", "Session", bySession.slice(0, 25));
    appendSummaryTable("By Agent", "Agent", byAgent.slice(0, 25));
    appendSummaryTable("By Task", "Task", byTask.slice(0, 25));
    appendSummaryTable("By Day", "Day", byDay.slice(0, 25));

    const reportDir = path.join(this.config.rootDir, COST_REPORT_OUTPUT_DIR);
    await fs.mkdir(reportDir, { recursive: true });
    const reportFileName = `cost-report-${hourKey}.md`;
    const outputPath = path.join(reportDir, reportFileName);
    await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");

    this.storage.systemSettings.set(COST_REPORT_HOURLY_DEDUP_SETTING_KEY, hourKey);
    const finishedAt = new Date().toISOString();
    this.storage.cronJobs.upsert({
      ...job,
      lastRunAt: finishedAt,
      nextRunAt: new Date(Date.now() + (60 * 60 * 1000)).toISOString(),
    });
    this.publishRealtime("cron_job_run", "cron", {
      type: "cost_report_hourly",
      jobId: COST_REPORT_HOURLY_JOB_ID,
      outputPath,
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      totalTokens,
      trackedEvents: usageAvailability.trackedEvents,
      unknownEvents: usageAvailability.unknownEvents,
      windowStartIso,
      windowEndIso,
    });
  }

  private hasRunningTurn(sessionId: string): boolean {
    const latest = this.storage.chatTurnTraces.listBySession(sessionId, 1)[0];
    return latest ? isChatTurnActiveStatus(latest.status) : false;
  }

  private beginActiveChatTurnExecution(
    sessionId: string,
    turnId: string,
    operation: string,
  ): AbortController {
    const controller = new AbortController();
    this.activeChatTurns.set(turnId, {
      sessionId,
      turnId,
      operation,
      startedAt: new Date().toISOString(),
      controller,
    });
    return controller;
  }

  private endActiveChatTurnExecution(turnId: string, controller: AbortController): void {
    const active = this.activeChatTurns.get(turnId);
    if (!active || active.controller !== controller) {
      return;
    }
    this.activeChatTurns.delete(turnId);
  }

  private isChatTurnCancellationRequested(turnId: string): boolean {
    return this.activeChatTurns.get(turnId)?.controller.signal.aborted ?? false;
  }

  private registerActiveChatTurnStream(sessionId: string, turnId: string, runId?: string): ActiveChatTurnStreamExecution {
    const state: ActiveChatTurnStreamExecution = {
      sessionId,
      turnId,
      runId,
      startedAt: new Date().toISOString(),
      nextSequence: this.storage.chatStreamEvents.getLatestSequence(turnId) + 1,
      completed: false,
    };
    this.activeChatTurnStreams.set(turnId, state);
    return state;
  }

  private completeActiveChatTurnStream(turnId: string): void {
    const active = this.activeChatTurnStreams.get(turnId);
    if (!active) {
      return;
    }
    active.completed = true;
  }

  private closeActiveChatTurnStream(turnId: string): void {
    this.activeChatTurnStreams.delete(turnId);
  }

  private persistChatStreamChunk(
    chunk: PersistableChatStreamChunk,
    runId?: string,
  ): ChatStreamChunk {
    const active = this.activeChatTurnStreams.get(chunk.turnId);
    const sequence = active?.nextSequence ?? (this.storage.chatStreamEvents.getLatestSequence(chunk.turnId) + 1);
    if (active) {
      active.nextSequence = sequence + 1;
    }
    const eventId = randomUUID();
    const enriched = {
      ...chunk,
      eventId,
      sequence,
      ...(runId ? { runId } : {}),
    } as ChatStreamChunk;
    this.storage.chatStreamEvents.append({
      eventId,
      sessionId: chunk.sessionId,
      turnId: chunk.turnId,
      sequence,
      runId,
      chunkType: enriched.type,
      payload: enriched as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    });
    this.purgeExpiredChatStreamEventsIfNeeded();
    return enriched;
  }

  private purgeExpiredChatStreamEventsIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastChatStreamPurgeAt < 60_000) {
      return;
    }
    this.lastChatStreamPurgeAt = now;
    const cutoffIso = new Date(now - CHAT_STREAM_EVENT_RETENTION_MS).toISOString();
    this.storage.chatStreamEvents.purgeBefore(cutoffIso);
  }

  private async *streamPersistedChatTurnEvents(
    sessionId: string,
    turnId: string,
    options?: {
      sinceEventId?: string;
      liveTail?: boolean;
    },
  ): AsyncGenerator<ChatStreamChunk> {
    let afterSequence = 0;
    if (options?.sinceEventId) {
      const priorEvent = this.storage.chatStreamEvents.getByEventId(options.sinceEventId);
      if (priorEvent?.turnId === turnId) {
        afterSequence = priorEvent.sequence;
      } else {
        yield* this.streamTurnStateFallback(sessionId, turnId);
        afterSequence = this.storage.chatStreamEvents.getLatestSequence(turnId);
        if (!options?.liveTail) {
          return;
        }
      }
    }

    while (true) {
      const events = this.storage.chatStreamEvents.listByTurn(turnId, afterSequence, 200);
      if (events.length > 0) {
        for (const event of events) {
          afterSequence = event.sequence;
          yield event.payload as unknown as ChatStreamChunk;
          if ((event.payload as { type?: string }).type === "done") {
            return;
          }
        }
        continue;
      }

      const active = this.activeChatTurnStreams.get(turnId);
      const durablePending = options?.liveTail ? this.isDurableTurnStillStreaming(turnId) : false;
      if (!options?.liveTail || ((!active || active.completed) && !durablePending)) {
        return;
      }
      await wait(CHAT_STREAM_EVENT_POLL_INTERVAL_MS);
    }
  }

  private isDurableTurnStillStreaming(turnId: string): boolean {
    const row = this.gatewaySql.prepare(`
      SELECT run_id
      FROM chat_stream_events
      WHERE turn_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(turnId) as { run_id: string | null } | undefined;
    if (!row?.run_id) {
      return false;
    }
    try {
      const run = this.storage.durableRuns.getRun(row.run_id);
      return run.status === "queued" || run.status === "running" || run.status === "waiting" || run.status === "paused";
    } catch {
      return false;
    }
  }

  private async *withEphemeralStreamEnvelope(
    source: AsyncGenerator<ChatStreamChunkDraft>,
    runId?: string,
  ): AsyncGenerator<ChatStreamChunk> {
    let sequence = 1;
    for await (const chunk of source) {
      yield {
        ...chunk,
        eventId: randomUUID(),
        sequence,
        ...(runId ? { runId } : {}),
      } as ChatStreamChunk;
      sequence += 1;
    }
  }

  private async *streamTurnStateFallback(
    sessionId: string,
    turnId: string,
  ): AsyncGenerator<ChatStreamChunk> {
    const trace = this.storage.chatTurnTraces.get(turnId);
    if (trace.sessionId !== sessionId) {
      return;
    }
    const hydratedTrace = this.createHydratedChatTurnTrace(turnId, trace);
    yield this.persistChatStreamChunk({
      type: "trace_update",
      sessionId,
      turnId,
      trace: hydratedTrace,
    }, hydratedTrace.durable?.runId);
    if (trace.assistantMessageId) {
      const assistantMessage = this.storage.chatMessages.get(trace.assistantMessageId);
      if (assistantMessage) {
        yield this.persistChatStreamChunk({
          type: "message_done",
          sessionId,
          turnId,
          messageId: assistantMessage.messageId,
          content: assistantMessage.content,
        }, hydratedTrace.durable?.runId);
        yield this.persistChatStreamChunk({
          type: "done",
          sessionId,
          turnId,
          messageId: assistantMessage.messageId,
        }, hydratedTrace.durable?.runId);
      }
    }
  }

  private createHydratedChatTurnTrace(turnId: string, trace: ChatTurnTraceRecord): ChatTurnTraceRecord {
    return {
      ...trace,
      toolRuns: this.storage.chatToolRuns.listByTurn(turnId),
      citations: trace.citations ?? [],
    };
  }

  private markChatTurnCancelled(
    sessionId: string,
    turnId: string,
    cancelledBy?: string,
  ): ChatTurnTraceRecord {
    const current = this.storage.chatTurnTraces.get(turnId);
    if (current.sessionId !== sessionId) {
      throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
    }
    if (current.status === "cancelled") {
      return this.createHydratedChatTurnTrace(turnId, current);
    }
    if (isChatTurnTerminalStatus(current.status)) {
      return this.createHydratedChatTurnTrace(turnId, current);
    }
    const trace = this.storage.chatTurnTraces.patch(turnId, {
      status: "cancelled",
      failure: undefined,
      completion: {
        finishReason: current.completion?.finishReason,
        status: "interrupted",
        repaired: Boolean(current.completion?.repaired),
      },
      finishedAt: new Date().toISOString(),
    });
    this.recordDevDiagnostic({
      level: "info",
      category: "chat",
      event: "chat.turn.cancelled",
      message: "Cancelled active chat turn",
      sessionId,
      turnId,
      context: {
        cancelledBy,
      },
    });
    this.publishRealtime("chat_thread_updated", "chat", {
      type: "chat_thread_turn_cancelled",
      sessionId,
      turnId,
    });
    return this.createHydratedChatTurnTrace(turnId, trace);
  }

  private getSessionIdleSeconds(sessionId: string): number {
    const session = this.getSession(sessionId);
    const lastActivity = Date.parse(session.lastActivityAt);
    if (!Number.isFinite(lastActivity)) {
      return 0;
    }
    return Math.max(0, Math.floor((Date.now() - lastActivity) / 1000));
  }

  // Proactive helpers moved to ChatProactiveService

  // planProactiveActions moved to ChatProactiveService

  // insertProactiveRun moved to ChatProactiveService

  // finishProactiveRun moved to ChatProactiveService

  // insertProactiveAction moved to ChatProactiveService

  // updateProactiveAction moved to ChatProactiveService

  // resolveProactiveAction moved to ChatProactiveService

  // executeProactiveToolAction, touchSessionProactiveTick moved to ChatProactiveService

  private async inferLatestUserObjective(sessionId: string): Promise<string> {
    const messages = await this.listChatMessages(sessionId, 40);
    const latestUser = [...messages].reverse().find((item) => item.role === "user");
    return latestUser?.content ?? "";
  }

  private computeDelegationSuggestionConfidence(objective: string, roles: string[]): number {
    let score = roles.length >= 3 ? 0.84 : roles.length >= 2 ? 0.72 : 0.58;
    if (/\b(prd|architecture|implement|qa|ops|handoff)\b/i.test(objective)) {
      score += 0.12;
    }
    return clamp01(score);
  }

  private collectSpecialistCandidateSuggestions(input: {
    sessionId: string;
    mode: ChatMode;
    content: string;
    capabilitySuggestions: ChatCapabilityUpgradeSuggestion[];
    trace: ChatTurnTraceRecord;
  }): ChatSpecialistCandidateSuggestionRecord[] {
    if (!chatModeAllowsDynamicTeamGrowth(input.mode)) {
      return [];
    }
    const existingCandidates = this.storage.chatSpecialistCandidates.listBySession(input.sessionId, 200);
    const seen = new Set<string>(existingCandidates
      .filter((candidate) => candidate.status !== "retired")
      .map((candidate) => normalizeSpecialistCandidateFingerprint(candidate)));
    const suggested = new Map<string, ChatSpecialistCandidateSuggestionRecord>();
    const objectiveKeywords = extractSpecialistObjectiveKeywords(input.content);
    const addSuggestion = (suggestion: ChatSpecialistCandidateSuggestionRecord): void => {
      const fingerprint = normalizeSpecialistCandidateFingerprint(suggestion);
      if (seen.has(fingerprint) || suggested.has(fingerprint)) {
        return;
      }
      suggested.set(fingerprint, suggestion);
    };

    for (const capability of input.capabilitySuggestions) {
      addSuggestion(buildSpecialistSuggestionFromCapability({
        capability,
        mode: input.mode,
        objectiveKeywords,
      }));
    }

    if (suggested.size === 0 && input.trace.orchestration) {
      const detectedRoles = normalizeDelegationRoles(detectDelegationRoles(input.content));
      for (const role of detectedRoles) {
        if (role === "coder") {
          continue;
        }
        addSuggestion(buildRoleGapSpecialistSuggestion({
          role,
          mode: input.mode,
          objective: input.content,
          objectiveKeywords,
          confidence: this.computeDelegationSuggestionConfidence(input.content, detectedRoles),
          runId: input.trace.orchestration.runId,
          turnId: input.trace.turnId,
        }));
      }
    }

    return [...suggested.values()].slice(0, 3);
  }

  private extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: {
      role: "user" | "assistant";
      sourceRef: string;
      trace?: Pick<ChatTurnTraceRecord, "status" | "toolRuns">;
    },
  ): void {
    return this.chatLearnedMemoryService.extractAndPersistLearnedMemory(sessionId, content, source);
  }

  private getPromptRunnerModelDefaults(): { providerId?: string; model?: string } {
    const runtime = this.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
    const glm = runtime.providers.find((provider) => provider.providerId === "glm" && provider.hasApiKey);
    if (glm) {
      return {
        providerId: glm.providerId,
        model: glm.defaultModel || "glm-5",
      };
    }
    const kimi = runtime.providers.find((provider) => provider.providerId === "moonshot" && provider.hasApiKey);
    if (kimi) {
      return {
        providerId: kimi.providerId,
        model: kimi.defaultModel,
      };
    }
    const active = runtime.providers.find((provider) => provider.providerId === runtime.activeProviderId);
    return {
      providerId: active?.providerId ?? runtime.activeProviderId,
      model: runtime.activeModel,
    };
  }

  private ensureChatSessionRuntimeGrants(sessionId: string): void {
    const existing = this.listToolGrants("session", sessionId, 1000);
    const active = existing.filter((grant) => isActiveToolGrant(grant));
    const inheritedDeny = [
      ...this.listToolGrants("global", "global", 1000),
      ...this.listToolGrants("agent", "assistant", 1000),
    ].filter((grant) => isActiveToolGrant(grant) && grant.decision === "deny");
    for (const toolName of CHAT_SESSION_AUTO_ALLOW_TOOLS) {
      const deniedByInheritedScope = inheritedDeny.some((grant) => grantPatternMatches(grant.toolPattern, toolName));
      if (deniedByInheritedScope) {
        continue;
      }
      const hasDeny = active.some((grant) => grant.decision === "deny" && grantPatternMatches(grant.toolPattern, toolName));
      if (hasDeny) {
        continue;
      }
      const hasAllow = active.some((grant) => grant.decision === "allow" && grantPatternMatches(grant.toolPattern, toolName));
      if (hasAllow) {
        continue;
      }
      this.createToolGrant({
        toolPattern: toolName,
        decision: "allow",
        scope: "session",
        scopeRef: sessionId,
        grantType: "persistent",
        createdBy: "system-chat-agent-bootstrap",
      });
    }
  }

  private inheritDelegatedSessionToolGrants(parentSessionId: string, childSessionId: string): void {
    const inheritedGrants = buildDelegatedSessionToolGrantCopies({
      parentSessionId,
      childSessionId,
      parentGrants: this.listToolGrants("session", parentSessionId, 1000),
      childGrants: this.listToolGrants("session", childSessionId, 1000),
    });

    for (const grantInput of inheritedGrants) {
      this.createToolGrant(grantInput);
    }
  }

  public listChatCommandCatalog(): Array<{
    command: string;
    usage: string;
    description: string;
  }> {
    return [
      { command: "/mode", usage: "/mode chat|cowork|code", description: "Switch session mode." },
      { command: "/plan", usage: "/plan [on|off]", description: "Show or set advisory planning mode." },
      { command: "/model", usage: "/model <model-id>", description: "Override model for this session." },
      { command: "/web", usage: "/web auto|off|quick|deep", description: "Set web retrieval behavior." },
      { command: "/memory", usage: "/memory auto|on|off", description: "Set memory behavior." },
      { command: "/think", usage: "/think minimal|standard|extended", description: "Set thinking depth." },
      { command: "/tool", usage: "/tool safe_auto|manual", description: "Set tool autonomy mode." },
      { command: "/proactive", usage: "/proactive off|suggest|auto_safe", description: "Set proactive mode." },
      { command: "/retrieval", usage: "/retrieval standard|layered", description: "Set retrieval routing mode." },
      { command: "/reflect", usage: "/reflect off|on", description: "Toggle reflection retry mode." },
      { command: "/research", usage: "/research <query>", description: "Run quick research for current session." },
      { command: "/delegate", usage: "/delegate <role1,role2,...> :: <objective>", description: "Run task-backed role delegation." },
      { command: "/pipeline", usage: "/pipeline prd|build|triage|release :: <objective>", description: "Run a built-in delegation template." },
      { command: "/score", usage: "/score <TEST-##> <routing> <honesty> <handoff> <robustness> <usability>", description: "Score the latest run for a prompt-pack test." },
      { command: "/pack", usage: "/pack run <TEST-##|all>", description: "Run prompt-pack tests from Prompt Lab." },
      { command: "/skills", usage: "/skills", description: "List installed skills and their runtime state." },
      { command: "/skill", usage: "/skill enable|sleep|disable <skillId>", description: "Change an installed skill's runtime state." },
      { command: "/skill", usage: "/skill search <query>", description: "Search skill import sources." },
      { command: "/skill", usage: "/skill lookup <query-or-url>", description: "Resolve the best-fit skill source or listing." },
      { command: "/skill", usage: "/skill install <sourceRef> [--confirm-high-risk]", description: "Validate and install a skill, disabled by default." },
      { command: "/mcp", usage: "/mcp", description: "List configured MCP servers and connection state." },
      { command: "/mcp", usage: "/mcp connect|disconnect <serverId>", description: "Connect or disconnect a configured MCP server." },
      { command: "/mcp", usage: "/mcp templates [query]", description: "List known MCP server templates." },
      { command: "/mcp", usage: "/mcp add-template <templateId>", description: "Add an MCP template definition in a disconnected state." },
      { command: "/project", usage: "/project <project-id|none>", description: "Assign or clear this session project." },
      { command: "/attach", usage: "/attach <attachment-id>", description: "Reference an attachment id in your next send." },
      { command: "/run", usage: "/run research <query>", description: "Run a named workflow from chat." },
      { command: "/approve", usage: "/approve <approval-id>", description: "Approve a pending inline tool request." },
      { command: "/deny", usage: "/deny <approval-id>", description: "Deny a pending inline tool request." },
      { command: "/help", usage: "/help", description: "Show command catalog." },
    ];
  }

  public async parseChatCommand(
    sessionId: string,
    commandText: string,
  ): Promise<{
    ok: boolean;
    command: string;
    args: string[];
    message: string;
    prefs?: ChatSessionPrefsRecord;
    research?: ResearchSummaryRecord;
  }> {
    this.getSession(sessionId);
    const parsed = parseSlashCommand(commandText);
    if (!parsed) {
      return {
        ok: false,
        command: "",
        args: [],
        message: "Command must start with '/'.",
      };
    }

    const [head, ...args] = parsed;
    const command = (head ?? "").toLowerCase();
    if (!command) {
      return {
        ok: false,
        command: "",
        args: [],
        message: "Command must include a command name after '/'.",
      };
    }

    if (command === "/help") {
      const help = this.listChatCommandCatalog()
        .map((item) => `${item.usage} - ${item.description}`)
        .join("\n");
      return {
        ok: true,
        command,
        args,
        message: help,
      };
    }

    if (command === "/mode") {
      const mode = (args[0] ?? "").toLowerCase() as ChatMode;
      if (mode !== "chat" && mode !== "cowork" && mode !== "code") {
        return { ok: false, command, args, message: "Usage: /mode chat|cowork|code" };
      }
      const prefs = this.updateChatSessionPrefs(sessionId, { mode });
      return { ok: true, command, args, prefs, message: `Mode set to ${prefs.mode}.` };
    }

    if (command === "/plan") {
      const next = (args[0] ?? "").toLowerCase();
      if (!next) {
        const prefs = this.getChatSessionPrefs(sessionId);
        return {
          ok: true,
          command,
          args,
          prefs,
          message: `Planning mode is ${prefs.planningMode}.`,
        };
      }
      if (next !== "on" && next !== "off") {
        return { ok: false, command, args, message: "Usage: /plan [on|off]" };
      }
      const prefs = this.updateChatSessionPrefs(sessionId, {
        planningMode: next === "on" ? "advisory" : "off",
      });
      return {
        ok: true,
        command,
        args,
        prefs,
        message: `Planning mode set to ${prefs.planningMode}.`,
      };
    }

    if (command === "/model") {
      const model = args.join(" ").trim();
      if (!model) {
        return { ok: false, command, args, message: "Usage: /model <model-id>" };
      }
      const prefs = this.updateChatSessionPrefs(sessionId, { model });
      return { ok: true, command, args, prefs, message: `Model set to ${prefs.model}.` };
    }

    if (command === "/web") {
      const webMode = (args[0] ?? "").toLowerCase() as ChatWebMode;
      if (!["auto", "off", "quick", "deep"].includes(webMode)) {
        return { ok: false, command, args, message: "Usage: /web auto|off|quick|deep" };
      }
      const prefs = this.updateChatSessionPrefs(sessionId, { webMode });
      return { ok: true, command, args, prefs, message: `Web mode set to ${prefs.webMode}.` };
    }

    if (command === "/memory") {
      const memoryMode = (args[0] ?? "").toLowerCase() as "auto" | "on" | "off";
      if (!["auto", "on", "off"].includes(memoryMode)) {
        return { ok: false, command, args, message: "Usage: /memory auto|on|off" };
      }
      const prefs = this.updateChatSessionPrefs(sessionId, { memoryMode });
      return { ok: true, command, args, prefs, message: `Memory mode set to ${prefs.memoryMode}.` };
    }

    if (command === "/think") {
      const thinkingLevel = (args[0] ?? "").toLowerCase() as ChatThinkingLevel;
      if (!["minimal", "standard", "extended"].includes(thinkingLevel)) {
        return { ok: false, command, args, message: "Usage: /think minimal|standard|extended" };
      }
      const prefs = this.updateChatSessionPrefs(sessionId, { thinkingLevel });
      return { ok: true, command, args, prefs, message: `Thinking level set to ${prefs.thinkingLevel}.` };
    }

    if (command === "/tool") {
      const toolAutonomy = (args[0] ?? "").toLowerCase() as "safe_auto" | "manual";
      if (!["safe_auto", "manual"].includes(toolAutonomy)) {
        return { ok: false, command, args, message: "Usage: /tool safe_auto|manual" };
      }
      const prefs = this.updateChatSessionPrefs(sessionId, { toolAutonomy });
      return { ok: true, command, args, prefs, message: `Tool autonomy set to ${prefs.toolAutonomy}.` };
    }

    if (command === "/proactive") {
      const proactiveMode = (args[0] ?? "").toLowerCase() as ChatProactiveMode;
      if (!["off", "suggest", "auto_safe"].includes(proactiveMode)) {
        return { ok: false, command, args, message: "Usage: /proactive off|suggest|auto_safe" };
      }
      const policy = this.updateChatSessionProactivePolicy(sessionId, { proactiveMode });
      const prefs = this.getChatSessionPrefs(sessionId);
      return {
        ok: true,
        command,
        args,
        prefs,
        message: `Proactive mode set to ${policy.mode}.`,
      };
    }

    if (command === "/retrieval") {
      const retrievalMode = (args[0] ?? "").toLowerCase() as ChatRetrievalMode;
      if (!["standard", "layered"].includes(retrievalMode)) {
        return { ok: false, command, args, message: "Usage: /retrieval standard|layered" };
      }
      this.updateChatSessionProactivePolicy(sessionId, { retrievalMode });
      const prefs = this.getChatSessionPrefs(sessionId);
      return {
        ok: true,
        command,
        args,
        prefs,
        message: `Retrieval mode set to ${retrievalMode}.`,
      };
    }

    if (command === "/reflect") {
      const reflectionMode = (args[0] ?? "").toLowerCase() as ChatReflectionMode;
      if (!["off", "on"].includes(reflectionMode)) {
        return { ok: false, command, args, message: "Usage: /reflect off|on" };
      }
      this.updateChatSessionProactivePolicy(sessionId, { reflectionMode });
      const prefs = this.getChatSessionPrefs(sessionId);
      return {
        ok: true,
        command,
        args,
        prefs,
        message: `Reflection mode set to ${reflectionMode}.`,
      };
    }

    if (command === "/research") {
      const query = args.join(" ").trim();
      if (!query) {
        return { ok: false, command, args, message: "Usage: /research <query>" };
      }
      const research = await this.runChatResearch(sessionId, {
        query,
        mode: "quick",
      });
      return {
        ok: true,
        command,
        args,
        research,
        message: research.summary,
      };
    }

    if (command === "/delegate") {
      const { roles, objective, error } = parseDelegateCommand(commandText);
      if (error || !objective || roles.length === 0) {
        return { ok: false, command, args, message: "Usage: /delegate <role1,role2,...> :: <objective>" };
      }
      const run = await this.runChatDelegation(sessionId, {
        objective,
        roles,
        mode: "sequential",
      });
      return {
        ok: true,
        command,
        args,
        message: `Delegation ${run.runId} completed with ${run.steps.length} steps.`,
      };
    }

    if (command === "/pipeline") {
      const parsedPipeline = parsePipelineCommand(commandText);
      if (!parsedPipeline) {
        return { ok: false, command, args, message: "Usage: /pipeline prd|build|triage|release :: <objective>" };
      }
      const run = await this.runChatDelegation(sessionId, {
        objective: parsedPipeline.objective,
        roles: parsedPipeline.roles,
        mode: "sequential",
      });
      return {
        ok: true,
        command,
        args,
        message: `Pipeline ${parsedPipeline.template} completed (${run.steps.length} steps).`,
      };
    }

    if (command === "/score") {
      const [testCodeRaw, routingRaw, honestyRaw, handoffRaw, robustnessRaw, usabilityRaw, ...noteParts] = args;
      if (!testCodeRaw || [routingRaw, honestyRaw, handoffRaw, robustnessRaw, usabilityRaw].some((item) => item === undefined)) {
        return {
          ok: false,
          command,
          args,
          message: "Usage: /score <TEST-##> <routing> <honesty> <handoff> <robustness> <usability>",
        };
      }
      const score = await this.scorePromptPackLatestRunByCode({
        sessionId,
        testCode: normalizePromptTestCode(testCodeRaw),
        routingScore: clampPromptScore(routingRaw!),
        honestyScore: clampPromptScore(honestyRaw!),
        handoffScore: clampPromptScore(handoffRaw!),
        robustnessScore: clampPromptScore(robustnessRaw!),
        usabilityScore: clampPromptScore(usabilityRaw!),
        notes: noteParts.join(" ").trim() || undefined,
      });
      return {
        ok: true,
        command,
        args,
        message: `Scored ${testCodeRaw}: total ${score.totalScore}/10.`,
      };
    }

    if (command === "/pack") {
      const subcommand = (args[0] ?? "").toLowerCase();
      if (subcommand !== "run") {
        return { ok: false, command, args, message: "Usage: /pack run <TEST-##|all>" };
      }
      const selector = normalizePromptTestCode(args[1] ?? "all");
      const results = await this.runPromptPackFromChat(sessionId, selector);
      return {
        ok: true,
        command,
        args,
        message: `Prompt pack run complete: ${results.length} test(s) executed.`,
      };
    }

    if (command === "/skills") {
      const skills = this.listSkills();
      if (skills.length === 0) {
        return { ok: true, command, args, message: "No installed skills found." };
      }
      return {
        ok: true,
        command,
        args,
        message: skills
          .slice(0, 20)
          .map((skill) => `- ${skill.skillId} [${skill.state}]${skill.note ? ` - ${skill.note}` : ""}`)
          .join("\n"),
      };
    }

    if (command === "/skill") {
      const action = (args[0] ?? "").toLowerCase();
      if (action === "enable" || action === "sleep" || action === "disable") {
        const skillId = args.slice(1).join(" ").trim();
        if (!skillId) {
          return { ok: false, command, args, message: `Usage: /skill ${action} <skillId>` };
        }
        const state = action === "enable" ? "enabled" : action === "sleep" ? "sleep" : "disabled";
        const updated = this.setSkillState(skillId, state, `Updated from chat command ${commandText.trim()}`);
        return {
          ok: true,
          command,
          args,
          message: `Skill ${updated.skillId} is now ${updated.state}.`,
        };
      }
      if (action === "search") {
        const query = args.slice(1).join(" ").trim();
        if (!query) {
          return { ok: false, command, args, message: "Usage: /skill search <query>" };
        }
        const results = await this.listSkillSources(query, 5);
        if (results.items.length === 0) {
          return { ok: true, command, args, message: `No skill source matches found for "${query}".` };
        }
        return {
          ok: true,
          command,
          args,
          message: results.items
            .slice(0, 5)
            .map((item) => {
              const reason = item.matchReason ? ` - ${item.matchReason}` : "";
              const installability = item.installability ? ` [${item.installability}]` : "";
              return `- ${item.name} (${item.sourceProvider}${installability})${reason} - ${item.sourceUrl}`;
            })
            .join("\n"),
        };
      }
      if (action === "lookup") {
        const query = args.slice(1).join(" ").trim();
        if (!query) {
          return { ok: false, command, args, message: "Usage: /skill lookup <query-or-url>" };
        }
        const result = await this.lookupSkillSources(query, 5);
        const bestMatch = result.bestMatch ?? result.items[0];
        if (!bestMatch) {
          return { ok: true, command, args, message: `No skill source resolution found for "${query}".` };
        }
        const lines = [
          `Best match: ${bestMatch.name} (${bestMatch.sourceProvider})`,
          `Why: ${bestMatch.matchReason ?? "best ranked match"}`,
          `Installability: ${bestMatch.installability ?? "review_only"}`,
          `Source: ${bestMatch.sourceUrl}`,
        ];
        if (bestMatch.upstreamUrl && bestMatch.upstreamUrl !== bestMatch.sourceUrl) {
          lines.push(`Upstream: ${bestMatch.upstreamUrl}`);
        }
        if (bestMatch.installHint) {
          lines.push(`Next step: ${bestMatch.installHint}`);
        }
        return {
          ok: true,
          command,
          args,
          message: lines.join("\n"),
        };
      }
      if (action === "install") {
        const confirmHighRisk = args.includes("--confirm-high-risk");
        const sourceRef = args
          .filter((item) => item !== "--confirm-high-risk")
          .slice(1)
          .join(" ")
          .trim();
        if (!sourceRef) {
          return {
            ok: false,
            command,
            args,
            message: "Usage: /skill install <sourceRef> [--confirm-high-risk]",
          };
        }
        const validation = await this.validateSkillImport({ sourceRef });
        if (!validation.valid) {
          return {
            ok: false,
            command,
            args,
            message: `Skill import rejected: ${validation.errors.join("; ") || "validation failed"}`,
          };
        }
        if (validation.riskLevel === "high" && !confirmHighRisk) {
          return {
            ok: false,
            command,
            args,
            message: "High-risk skill import requires --confirm-high-risk.",
          };
        }
        const installed = await this.installSkillImport({ sourceRef, confirmHighRisk });
        return {
          ok: true,
          command,
          args,
          message: `Installed ${installed.installedSkillId ?? validation.inferredSkillName ?? sourceRef}. Skill starts disabled by default.`,
        };
      }
      return {
        ok: false,
        command,
        args,
        message: "Usage: /skill enable|sleep|disable <skillId> | /skill search <query> | /skill lookup <query-or-url> | /skill install <sourceRef> [--confirm-high-risk]",
      };
    }

    if (command === "/mcp") {
      const action = (args[0] ?? "").toLowerCase();
      if (!action) {
        const servers = this.listMcpServers();
        if (servers.length === 0) {
          return { ok: true, command, args, message: "No MCP servers configured." };
        }
        return {
          ok: true,
          command,
          args,
          message: servers
            .slice(0, 20)
            .map((server) => `- ${server.serverId} ${server.label} [${server.status}]${server.enabled ? "" : " disabled"}`)
            .join("\n"),
        };
      }
      if (action === "connect" || action === "disconnect") {
        const serverId = args.slice(1).join(" ").trim();
        if (!serverId) {
          return { ok: false, command, args, message: `Usage: /mcp ${action} <serverId>` };
        }
        let updated: McpServerRecord;
        try {
          updated = action === "connect"
            ? await this.connectMcpServer(serverId)
            : this.disconnectMcpServer(serverId);
        } catch (error) {
          return {
            ok: false,
            command,
            args,
            message: (error as Error).message,
          };
        }
        return {
          ok: true,
          command,
          args,
          message: `MCP server ${updated.serverId} is now ${updated.status}.`,
        };
      }
      if (action === "templates") {
        const query = args.slice(1).join(" ").trim().toLowerCase();
        const templates = this.listMcpTemplates()
          .filter((template) => {
            if (!query) {
              return true;
            }
            const haystack = `${template.templateId} ${template.label} ${template.description}`.toLowerCase();
            return haystack.includes(query);
          });
        if (templates.length === 0) {
          return { ok: true, command, args, message: query ? `No MCP templates match "${query}".` : "No MCP templates available." };
        }
        return {
          ok: true,
          command,
          args,
          message: templates
            .slice(0, 10)
            .map((template) => `- ${template.templateId} ${template.label}${template.installed ? " [installed]" : ""}`)
            .join("\n"),
        };
      }
      if (action === "add-template") {
        const templateId = args.slice(1).join(" ").trim().toLowerCase();
        if (!templateId) {
          return { ok: false, command, args, message: "Usage: /mcp add-template <templateId>" };
        }
        const template = MCP_SERVER_TEMPLATES.find((item) => item.templateId.toLowerCase() === templateId);
        if (!template) {
          return { ok: false, command, args, message: `Unknown MCP template ${templateId}.` };
        }
        const existing = this.listMcpServers().find((server) => server.label.toLowerCase() === template.label.toLowerCase());
        if (existing) {
          return {
            ok: true,
            command,
            args,
            message: `MCP template ${template.templateId} already exists as ${existing.serverId}.`,
          };
        }
        const created = this.createMcpServer({
          label: template.label,
          transport: template.transport,
          command: template.command,
          args: template.args,
          url: template.url,
          authType: template.authType,
          enabled: false,
          category: template.category,
          trustTier: template.trustTier,
          costTier: template.costTier,
          policy: template.policy,
        });
        return {
          ok: true,
          command,
          args,
          message: `Added MCP template ${template.templateId} as ${created.serverId}. It is disconnected until you connect it.`,
        };
      }
      return {
        ok: false,
        command,
        args,
        message: "Usage: /mcp | /mcp connect <serverId> | /mcp disconnect <serverId> | /mcp templates [query] | /mcp add-template <templateId>",
      };
    }

    if (command === "/project") {
      const nextProject = args.join(" ").trim();
      const updated = this.assignChatSessionProject(
        sessionId,
        !nextProject || nextProject === "none" ? undefined : nextProject,
      );
      return {
        ok: true,
        command,
        args,
        message: updated.projectId
          ? `Session assigned to project ${updated.projectId}.`
          : "Session project cleared.",
      };
    }

    if (command === "/attach") {
      const attachmentId = args.join(" ").trim();
      if (!attachmentId) {
        return { ok: false, command, args, message: "Usage: /attach <attachment-id>" };
      }
      return {
        ok: true,
        command,
        args,
        message: `Attachment ${attachmentId} noted. Include it in your next message send.`,
      };
    }

    if (command === "/run") {
      const workflow = (args[0] ?? "").toLowerCase();
      if (workflow !== "research") {
        return { ok: false, command, args, message: "Usage: /run research <query>" };
      }
      const query = args.slice(1).join(" ").trim();
      if (!query) {
        return { ok: false, command, args, message: "Usage: /run research <query>" };
      }
      const research = await this.runChatResearch(sessionId, {
        query,
        mode: "quick",
      });
      return {
        ok: true,
        command,
        args,
        research,
        message: research.summary,
      };
    }

    if (command === "/approve") {
      const approvalId = args[0]?.trim();
      if (!approvalId) {
        return { ok: false, command, args, message: "Usage: /approve <approval-id>" };
      }
      await this.resolveChatToolApproval(sessionId, approvalId, "approve");
      return { ok: true, command, args, message: `Approved ${approvalId}.` };
    }

    if (command === "/deny") {
      const approvalId = args[0]?.trim();
      if (!approvalId) {
        return { ok: false, command, args, message: "Usage: /deny <approval-id>" };
      }
      await this.resolveChatToolApproval(sessionId, approvalId, "reject");
      return { ok: true, command, args, message: `Denied ${approvalId}.` };
    }

    return {
      ok: false,
      command,
      args,
      message: `Unknown command ${command}. Use /help.`,
    };
  }

  public async runChatResearch(
    sessionId: string,
    input: {
      query: string;
      mode: "quick" | "deep";
      providerId?: string;
      model?: string;
    },
  ): Promise<ResearchSummaryRecord> {
    this.getSession(sessionId);
    this.ensureChatSessionRuntimeGrants(sessionId);
    return this.researchService.run({
      sessionId,
      query: input.query,
      mode: input.mode,
      providerId: input.providerId,
      model: input.model,
    });
  }

  public getChatResearchRun(
    sessionId: string,
    runId: string,
  ): {
    run: ResearchRunRecord;
    sources: ResearchSourceRecord[];
  } {
    return this.researchService.getRun(sessionId, runId);
  }

  public async runChatDelegation(
    sessionId: string,
    input: ChatDelegateRequest,
  ): Promise<ChatDelegateResponse> {
    this.getSession(sessionId);
    const objective = input.objective.trim();
    if (!objective) {
      throw new Error("objective is required");
    }
    const roles = normalizeDelegationRoles(input.roles);
    if (roles.length === 0) {
      throw new Error("at least one role is required");
    }
    const mode = input.mode ?? "sequential";
    const prefs = this.ensureGlmPrimaryDefaults(sessionId, this.storage.chatSessionPrefs.ensure(sessionId));
    const providerId = input.providerId ?? prefs.providerId;
    const model = input.model ?? prefs.model;
    const sessionWorkspaceId = this.normalizeWorkspaceId(this.storage.chatSessionMeta.ensure(sessionId).workspaceId);

    const task = this.createTask({
      workspaceId: sessionWorkspaceId,
      title: `Delegation: ${objective.slice(0, 120)}`,
      description: objective,
      status: "in_progress",
      priority: "normal",
      createdBy: "chat",
    });

    const runId = randomUUID();
    this.storage.chatDelegationRuns.create({
      runId,
      sessionId,
      taskId: task.taskId,
      objective,
      roles,
      mode,
      providerId,
      model,
      status: "running",
      citations: [],
    });
    this.appendTaskActivity(task.taskId, {
      activityType: "comment",
      message: `Delegation started (${roles.join(" -> ")})`,
      metadata: { runId, sessionId, mode },
    });

    const stitchedSections: string[] = [];
    const citations: ChatCitationRecord[] = [];
    let trace: ChatTurnTraceRecord["routing"] | undefined;
    let failures = 0;
    const sharedContext: Array<{ role: string; output: string }> = [];

    for (let index = 0; index < roles.length; index += 1) {
      const role = roles[index]!;
      const stepId = randomUUID();
      const startedAt = new Date().toISOString();
      this.storage.chatDelegationSteps.create({
        stepId,
        runId,
        role,
        index,
        status: "running",
        startedAt,
      });

      const agentSessionId = `delegate:${runId}:${index + 1}`;
      this.registerTaskSubagent(task.taskId, {
        agentSessionId,
        agentName: role,
      });

      try {
        const completion = await this.createChatCompletion({
          providerId,
          model,
          stream: false,
          memory: {
            enabled: true,
            mode: "qmd",
            sessionId,
          },
          messages: [
            {
              role: "system",
              content: buildDelegationSystemPrompt(role),
            },
            {
              role: "user",
              content: buildDelegationUserPrompt({
                objective,
                role,
                mode,
                sharedContext,
              }),
            },
          ],
        });
        const output = extractCompletionText(completion).trim() || "(no output returned)";
        const finishedAt = new Date().toISOString();
        this.storage.chatDelegationSteps.patch(stepId, {
          status: "completed",
          output,
          finishedAt,
          durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        });
        this.updateTaskSubagent(agentSessionId, {
          status: "completed",
          endedAt: finishedAt,
        });
        this.appendTaskActivity(task.taskId, {
          activityType: "comment",
          agentId: role,
          message: `${role} completed delegation step ${index + 1}/${roles.length}.`,
          metadata: { runId, stepId },
        });
        this.appendTaskDeliverable(task.taskId, {
          deliverableType: "artifact",
          title: `${toTitleCase(role)} step`,
          description: output.slice(0, 6000),
        });
        stitchedSections.push(`### ${toTitleCase(role)}\n${output}`);
        sharedContext.push({
          role,
          output: output.slice(0, 4000),
        });

        const completionRouting = readCompletionRouting(completion);
        if (completionRouting) {
          trace = {
            ...(trace ?? {}),
            ...completionRouting,
          };
        }

        const completionCitations = readCompletionCitations(completion);
        for (const citation of completionCitations) {
          citations.push(citation);
        }
      } catch (error) {
        failures += 1;
        const finishedAt = new Date().toISOString();
        const message = (error as Error).message;
        this.storage.chatDelegationSteps.patch(stepId, {
          status: "failed",
          error: message,
          finishedAt,
          durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        });
        this.updateTaskSubagent(agentSessionId, {
          status: "failed",
          endedAt: finishedAt,
        });
        this.appendTaskActivity(task.taskId, {
          activityType: "comment",
          agentId: role,
          message: `${role} failed delegation step ${index + 1}/${roles.length}: ${message}`,
          metadata: { runId, stepId, error: message },
        });
        stitchedSections.push(`### ${toTitleCase(role)}\nFAILED: ${message}`);
        if (mode === "parallel") {
          continue;
        }
      }
    }

    const finishedAt = new Date().toISOString();
    const stitchedOutput = stitchedSections.join("\n\n").trim();
    const status: ChatDelegationRunRecord["status"] = failures === 0
      ? "completed"
      : stitchedSections.length > failures
        ? "partial"
        : "failed";
    this.storage.chatDelegationRuns.patch(runId, {
      status,
      stitchedOutput,
      citations,
      trace,
      finishedAt,
    });
    this.appendTaskActivity(task.taskId, {
      activityType: "comment",
      message: `Delegation ${status}.`,
      metadata: { runId, failures, steps: roles.length },
    });
    if (stitchedSections.length > 0) {
      this.updateTask(task.taskId, {
        status: status === "completed" ? "review" : "blocked",
      });
    } else {
      this.updateTask(task.taskId, {
        status: "blocked",
      });
    }

    this.extractAndPersistLearnedMemory(sessionId, objective, {
      role: "user",
      sourceRef: runId,
    });
    if (stitchedOutput.trim()) {
      this.extractAndPersistLearnedMemory(sessionId, stitchedOutput, {
        role: "assistant",
        sourceRef: runId,
      });
    }

    return {
      runId,
      taskId: task.taskId,
      steps: this.storage.chatDelegationSteps.listByRun(runId),
      stitchedOutput,
      citations,
      trace,
    };
  }

  public async *runChatDelegationStream(
    sessionId: string,
    input: ChatDelegateRequest,
  ): AsyncGenerator<{
    type: "status" | "step" | "done" | "error";
    runId?: string;
    taskId?: string;
    message?: string;
    step?: ChatDelegationStepRecord;
    result?: ChatDelegateResponse;
  }> {
    yield { type: "status", message: "Delegation started." };
    try {
      const result = await this.runChatDelegation(sessionId, input);
      for (const step of result.steps) {
        yield { type: "step", runId: result.runId, taskId: result.taskId, step };
      }
      yield { type: "done", runId: result.runId, taskId: result.taskId, result };
    } catch (error) {
      yield { type: "error", message: (error as Error).message };
    }
  }

  public getChatDelegationRun(
    sessionId: string,
    runId: string,
  ): {
    run: ChatDelegationRunRecord;
    steps: ChatDelegationStepRecord[];
  } {
    const run = this.storage.chatDelegationRuns.get(runId);
    if (run.sessionId !== sessionId) {
      throw new Error("Delegation run does not belong to this session.");
    }
    return {
      run,
      steps: this.storage.chatDelegationSteps.listByRun(runId),
    };
  }

  public getChatSessionProactiveStatus(sessionId: string): {
    policy: ProactivePolicy;
    idleSeconds: number;
    hasRunningTurn: boolean;
    pendingSuggestions: number;
    actionsLastHour: number;
    lastRun?: ProactiveRunRecord;
  } {
    return this.chatProactiveService.getChatSessionProactiveStatus(sessionId);
  }

  public updateChatSessionProactivePolicy(
    sessionId: string,
    input: Partial<{
      proactiveMode: ChatProactiveMode;
      autonomyBudget: {
        maxActionsPerHour?: number;
        maxActionsPerTurn?: number;
        cooldownSeconds?: number;
      };
      retrievalMode: ChatRetrievalMode;
      reflectionMode: ChatReflectionMode;
    }>,
  ): ProactivePolicy {
    return this.chatProactiveService.updateChatSessionProactivePolicy(sessionId, input);
  }

  public async triggerChatSessionProactive(
    sessionId: string,
    input: ProactiveTriggerInput = {},
  ): Promise<ProactiveRunRecord> {
    return this.chatProactiveService.triggerChatSessionProactive(sessionId, input);
  }

  // triggerChatSessionProactive body removed (moved to ChatProactiveService)

  // (triggerChatSessionProactive body removed - moved to ChatProactiveService)

  public listChatSessionProactiveRuns(sessionId: string, limit = 50): ProactiveRunRecord[] {
    return this.chatProactiveService.listChatSessionProactiveRuns(sessionId, limit);
  }

  public listChatSessionLearnedMemory(
    sessionId: string,
    limit = 200,
  ): {
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  } {
    return this.chatLearnedMemoryService.listChatSessionLearnedMemory(sessionId, limit);
  }

  public listChatSessionSpecialistCandidates(
    sessionId: string,
    limit = 200,
  ): {
    items: ChatSpecialistCandidateRecord[];
  } {
    this.getSession(sessionId);
    return {
      items: this.storage.chatSpecialistCandidates.listBySession(sessionId, limit),
    };
  }

  public createChatSessionSpecialistCandidate(
    sessionId: string,
    input: {
      turnId?: string;
      suggestion: ChatSpecialistCandidateSuggestionRecord;
    },
  ): ChatSpecialistCandidateRecord {
    this.getSession(sessionId);
    const session = this.requireChatSession(sessionId);
    const normalizedFingerprint = normalizeSpecialistCandidateFingerprint({
      title: input.suggestion.title,
      role: input.suggestion.role,
    });
    const existing = this.storage.chatSpecialistCandidates
      .listBySession(sessionId, 200)
      .find((candidate) => (
        candidate.status !== "retired"
        && normalizeSpecialistCandidateFingerprint(candidate) === normalizedFingerprint
      ));
    const trace = input.turnId
      ? this.storage.chatTurnTraces.listBySession(sessionId, 2000).find((item) => item.turnId === input.turnId)
      : undefined;
    if (existing) {
      return this.storage.chatSpecialistCandidates.patch(existing.candidateId, {
        summary: input.suggestion.summary,
        reason: input.suggestion.reason,
        confidence: Math.max(existing.confidence, input.suggestion.confidence),
        suggestedTools: dedupeStrings([
          ...(existing.suggestedTools ?? []),
          ...(input.suggestion.suggestedTools ?? []),
        ]),
        suggestedSkills: dedupeStrings([
          ...(existing.suggestedSkills ?? []),
          ...(input.suggestion.suggestedSkills ?? []),
        ]),
        routingHints: mergeSpecialistRoutingHints(existing.routingHints, input.suggestion.routingHints),
        evidence: mergeSpecialistEvidence(existing.evidence, input.suggestion.evidence),
      });
    }
    const createInput: ChatSpecialistCandidateCreateInput & { workspaceId?: string } = {
      workspaceId: session.workspaceId,
      leadTurnId: input.turnId,
      leadRunId: trace?.orchestration?.runId,
      title: input.suggestion.title,
      role: input.suggestion.role,
      summary: input.suggestion.summary,
      reason: input.suggestion.reason,
      source: input.suggestion.source,
      status: "drafted",
      routingMode: input.suggestion.suggestedRoutingMode,
      confidence: input.suggestion.confidence,
      requiresApproval: input.suggestion.requiresApproval,
      suggestedTools: input.suggestion.suggestedTools,
      suggestedSkills: input.suggestion.suggestedSkills,
      routingHints: input.suggestion.routingHints,
      evidence: input.suggestion.evidence,
    };
    return this.storage.chatSpecialistCandidates.create(sessionId, createInput);
  }

  public updateChatSessionSpecialistCandidate(
    sessionId: string,
    candidateId: string,
    input: ChatSpecialistCandidatePatchInput,
  ): ChatSpecialistCandidateRecord {
    this.getSession(sessionId);
    const current = this.storage.chatSpecialistCandidates.get(candidateId);
    if (current.sessionId !== sessionId) {
      throw new Error("Specialist candidate does not belong to this session.");
    }
    return this.storage.chatSpecialistCandidates.patch(candidateId, input);
  }

  public updateChatSessionLearnedMemory(
    sessionId: string,
    itemId: string,
    input: LearnedMemoryUpdateInput,
  ): LearnedMemoryItemRecord {
    return this.chatLearnedMemoryService.updateChatSessionLearnedMemory(sessionId, itemId, input);
  }

  public async rebuildChatSessionLearnedMemory(sessionId: string): Promise<{
    rebuiltAt: string;
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  }> {
    return this.chatLearnedMemoryService.rebuildChatSessionLearnedMemory(
      sessionId,
      (sid) => this.readTranscriptOrEmpty(sid),
    );
  }

  public async suggestChatDelegation(
    sessionId: string,
    input: ChatDelegateSuggestRequest = {},
  ): Promise<ChatDelegateSuggestResponse> {
    this.getSession(sessionId);
    const objective = (input.objective?.trim() || (await this.inferLatestUserObjective(sessionId))).trim();
    if (!objective) {
      throw new Error("No objective provided and no recent user request was found.");
    }
    const detectedRoles = normalizeDelegationRoles(input.roles?.length ? input.roles : detectDelegationRoles(objective));
    const roles = detectedRoles.length > 0 ? detectedRoles : DEFAULT_DELEGATION_ROLES.slice(0, 3);
    const confidence = this.computeDelegationSuggestionConfidence(objective, roles);
    const suggestion: ChatDelegationSuggestionRecord = {
      suggestionId: randomUUID(),
      sessionId,
      objective,
      roles,
      mode: input.mode ?? "sequential",
      confidence,
      reason: "Detected multi-role objective and generated delegation plan.",
      source: "manual",
      createdAt: new Date().toISOString(),
    };
    return { suggestion };
  }

  public async acceptChatDelegation(
    sessionId: string,
    input: ChatDelegateAcceptRequest,
  ): Promise<ChatDelegateResponse> {
    this.getSession(sessionId);
    if (input.suggestionId) {
      const actionRow = this.gatewaySql.prepare(`
        SELECT args_json
        FROM proactive_actions
        WHERE action_id = ? AND session_id = ?
      `).get(input.suggestionId, sessionId) as { args_json?: string } | undefined;
      if (actionRow?.args_json) {
        const parsed = safeJsonParse<Record<string, unknown>>(actionRow.args_json, {});
        const objectiveFromSuggestion = typeof parsed.objective === "string" ? parsed.objective.trim() : "";
        const rolesFromSuggestion = Array.isArray(parsed.roles)
          ? parsed.roles.map((item) => String(item))
          : [];
        return this.runChatDelegation(sessionId, {
          objective: objectiveFromSuggestion || input.objective,
          roles: rolesFromSuggestion.length > 0 ? rolesFromSuggestion : input.roles,
          mode: input.mode ?? "sequential",
          providerId: input.providerId,
          model: input.model,
        });
      }
    }
    return this.runChatDelegation(sessionId, {
      objective: input.objective,
      roles: input.roles,
      mode: input.mode ?? "sequential",
      providerId: input.providerId,
      model: input.model,
    });
  }

  public importPromptPack(input: {
    content: string;
    name?: string;
    sourceLabel?: string;
    packId?: string;
  }): {
    pack: PromptPackRecord;
    tests: PromptPackTestRecord[];
  } {
    return this.promptPackService.importPromptPack(input);
  }

  public listPromptPacks(limit = 100): PromptPackRecord[] {
    return this.promptPackService.listPromptPacks(limit);
  }

  public listPromptPackTests(packId: string, limit = 2000): PromptPackTestRecord[] {
    return this.promptPackService.listPromptPackTests(packId, limit);
  }

  public async runPromptPackTest(
    packId: string,
    testId: string,
    input?: {
      sessionId?: string;
      providerId?: string;
      model?: string;
      mode?: ChatMode;
      toolTier?: PromptPackToolTier;
      toolAutonomy?: "manual" | "safe_auto";
      webMode?: ChatWebMode;
      memoryMode?: ChatMemoryMode;
      thinkingLevel?: ChatThinkingLevel;
      placeholderValues?: Record<string, string>;
    },
  ): Promise<PromptPackRunRecord> {
    return this.promptPackService.runPromptPackTest(packId, testId, input);
  }

  public scorePromptPackTest(input: {
    packId: string;
    testId: string;
    runId: string;
    routingScore: 0 | 1 | 2;
    honestyScore: 0 | 1 | 2;
    handoffScore: 0 | 1 | 2;
    robustnessScore: 0 | 1 | 2;
    usabilityScore: 0 | 1 | 2;
    notes?: string;
  }): PromptPackScoreRecord {
    return this.promptPackService.scorePromptPackTest(input);
  }

  public async autoScorePromptPackTest(input: {
    packId: string;
    testId: string;
    runId?: string;
    providerId?: string;
    model?: string;
    force?: boolean;
  }): Promise<PromptPackAutoScoreResult> {
    return this.promptPackService.autoScorePromptPackTest(input);
  }

  public async autoScorePromptPackBatch(input: {
    packId: string;
    onlyUnscored?: boolean;
    limit?: number;
    providerId?: string;
    model?: string;
    force?: boolean;
  }): Promise<PromptPackAutoScoreBatchResult> {
    return this.promptPackService.autoScorePromptPackBatch(input);
  }

  public async scorePromptPackLatestRunByCode(input: {
    sessionId?: string;
    testCode: string;
    routingScore: 0 | 1 | 2;
    honestyScore: 0 | 1 | 2;
    handoffScore: 0 | 1 | 2;
    robustnessScore: 0 | 1 | 2;
    usabilityScore: 0 | 1 | 2;
    notes?: string;
  }): Promise<PromptPackScoreRecord> {
    return this.promptPackService.scorePromptPackLatestRunByCode(input);
  }

  public getPromptPackReport(packId: string): PromptPackReportRecord {
    return this.promptPackService.getPromptPackReport(packId);
  }

  public runPromptPackBenchmark(
    packId: string,
    input: {
      testCodes: string[];
      providers: PromptPackBenchmarkProviderInput[];
    },
  ): { benchmarkRunId: string } {
    return this.promptPackService.runPromptPackBenchmark(packId, input);
  }

  public getPromptPackBenchmarkStatus(benchmarkRunId: string): PromptPackBenchmarkStatusRecord {
    return this.promptPackService.getPromptPackBenchmarkStatus(benchmarkRunId);
  }

  public runPromptPackReplayRegression(
    packId: string,
    input: {
      testCodes: string[];
      baselineRef?: string;
    },
  ): { regressionRunId: string } {
    return this.promptPackService.runPromptPackReplayRegression(packId, input);
  }

  public getPromptPackReplayRegressionStatus(runId: string): {
    run: ReplayRegressionRun;
    results: ReplayRegressionResult[];
  } {
    return this.promptPackService.getPromptPackReplayRegressionStatus(runId);
  }

  public getPromptPackCapabilityTrends(packId: string): { items: CapabilityTrendSeries[] } {
    return this.promptPackService.getPromptPackCapabilityTrends(packId);
  }

  public getPromptPackExport(packId: string): PromptPackExportRecord {
    return this.promptPackService.getPromptPackExport(packId);
  }

  public exportPromptPack(packId: string): PromptPackExportRecord {
    return this.promptPackService.exportPromptPack(packId);
  }

  public resetPromptPackRunsAndScores(
    packId: string,
    options: {
      clearRuns?: boolean;
      clearScores?: boolean;
    } = {},
  ): {
    packId: string;
    deletedRuns: number;
    deletedScores: number;
    export: PromptPackExportRecord;
  } {
    return this.promptPackService.resetPromptPackRunsAndScores(packId, options);
  }

  public listImprovementReports(limit = 24): WeeklyImprovementReportRecord[] {
    return this.improvementService.listImprovementReports(limit);
  }

  public listDecisionReplayRuns(limit = 24): DecisionReplayRunRecord[] {
    return this.improvementService.listDecisionReplayRuns(limit);
  }

  public getDurableDiagnostics(): DurableDiagnosticsResponse {
    return this.durableRunService.getDurableDiagnostics();
  }

  public listDurableRuns(limit = 50): DurableRunRecord[] {
    return this.durableRunService.listDurableRuns(limit);
  }

  public listDurableDeadLetters(limit = 50): DurableDeadLetterRecord[] {
    return this.durableRunService.listDurableDeadLetters(limit);
  }

  public listDurableRunCheckpoints(runId: string, limit = 200): DurableCheckpointRecord[] {
    return this.durableRunService.listDurableRunCheckpoints(runId, limit);
  }

  public createDurableRun(input: DurableRunCreateRequest): DurableRunRecord {
    const run = this.durableRunService.createDurableRun(input);
    if (run.status === "queued") {
      this.durableRunService.requestRunProcessing(run.runId);
    }
    return run;
  }

  public getDurableRun(runId: string): DurableRunRecord {
    return this.durableRunService.getDurableRun(runId);
  }

  public listDurableRunTimeline(runId: string, limit = 300): DurableRunTimelineEvent[] {
    return this.durableRunService.listDurableRunTimeline(runId, limit);
  }

  public pauseDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    return this.durableRunService.pauseDurableRun(runId, actorId);
  }

  public resumeDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    const run = this.durableRunService.resumeDurableRun(runId, actorId);
    this.durableRunService.requestRunProcessing(runId);
    return run;
  }

  public cancelDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    return this.durableRunService.cancelDurableRun(runId, actorId);
  }

  public retryDurableRun(runId: string, reason = "manual_retry", actorId = "operator"): DurableRunRecord {
    const run = this.durableRunService.retryDurableRun(runId, reason, actorId);
    if (run.status === "queued") {
      this.durableRunService.requestRunProcessing(runId);
    }
    return run;
  }

  public wakeDurableRun(
    runId: string,
    event: {
      eventKey: string;
      payload?: Record<string, unknown>;
      correlationId?: string;
    },
  ): DurableRunRecord {
    const run = this.durableRunService.wakeDurableRun(runId, event);
    this.durableRunService.requestRunProcessing(runId);
    return run;
  }

  public recoverDurableDeadLetter(entryId: string, actorId = "operator"): DurableRunRecord {
    return this.durableRunService.recoverDurableDeadLetter(entryId, actorId);
  }

  public getImprovementReport(reportId: string): WeeklyImprovementReportRecord {
    return this.improvementService.getImprovementReport(reportId);
  }

  public getDecisionReplayRun(runId: string): {
    run: DecisionReplayRunRecord;
    items: DecisionReplayItemRecord[];
    findings: DecisionReplayFindingRecord[];
    autoTunes: DecisionAutoTuneRecord[];
    report?: WeeklyImprovementReportRecord;
  } {
    return this.improvementService.getDecisionReplayRun(runId);
  }

  public async runImprovementReplayManually(
    input: ImprovementReplayTriggerInput = {},
  ): Promise<{
    run: DecisionReplayRunRecord;
    report?: WeeklyImprovementReportRecord;
  }> {
    return this.improvementService.runImprovementReplayManually(input);
  }

  public createReplayOverrideDraft(
    sourceRunId: string,
    overrides: ReplayOverrideStep[] = [],
  ): ReplayOverrideDraft {
    return this.improvementService.createReplayOverrideDraft(sourceRunId, overrides);
  }

  public executeReplayOverride(
    sourceRunId: string,
    overrides: ReplayOverrideStep[] = [],
  ): ReplayOverrideDraft {
    return this.improvementService.executeReplayOverride(sourceRunId, overrides);
  }

  public getReplayDiffSummary(replayRunId: string): ReplayDiffSummary {
    return this.improvementService.getReplayDiffSummary(replayRunId);
  }

  private isDurableFoundationEnabled(): boolean {
    return this.durableRunService.isDurableFoundationEnabled();
  }

  // markInterruptedDecisionReplayRuns moved to ImprovementService

  public approveDecisionAutoTune(tuneId: string): DecisionAutoTuneRecord {
    return this.improvementService.approveDecisionAutoTune(tuneId);
  }

  public revertDecisionAutoTune(tuneId: string): DecisionAutoTuneRecord {
    return this.improvementService.revertDecisionAutoTune(tuneId);
  }


  // Improvement private helpers moved to ImprovementService

  private async runPromptPackFromChat(sessionId: string, selector: string): Promise<PromptPackRunRecord[]> {
    return this.promptPackService.runPromptPackFromChat(sessionId, selector);
  }

  private async ensurePromptPackLoaded(): Promise<PromptPackRecord | undefined> {
    return this.promptPackService.ensurePromptPackLoaded();
  }

  // All improvement private helpers moved to ImprovementService

  public async resolveChatToolApproval(
    sessionId: string,
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<void> {
    const approval = this.storage.approvals.get(approvalId);
    if (approval.status !== "pending") {
      return;
    }
    await this.resolveApproval(approvalId, {
      decision,
      resolvedBy: "chat-operator",
      resolutionNote: decision === "approve" ? "Approved from chat inline control." : "Denied from chat inline control.",
    });
    const turn = this.storage.chatToolRuns.listBySession(sessionId, 2000)
      .find((toolRun) => toolRun.approvalId === approvalId);
    this.storage.chatInlineApprovals.upsert({
      approvalId,
      sessionId,
      turnId: turn?.turnId ?? "unknown",
      toolName: turn?.toolName,
      status: decision === "approve" ? "approved" : "denied",
      reason: decision === "approve" ? "approved by operator" : "denied by operator",
      resolvedBy: "chat-operator",
    });
  }

  private async requireChatTurnContext(
    sessionId: string,
    turnId: string,
    state?: Awaited<ReturnType<GatewayService["loadChatTurnSessionState"]>>,
  ): Promise<{
    trace: ChatTurnTraceRecord;
    userMessage: ChatMessageRecord;
    assistantMessage?: ChatMessageRecord;
  }> {
    const sessionState = state ?? await this.loadChatTurnSessionState(sessionId);
    const trace = sessionState.traces.find((item) => item.turnId === turnId);
    if (!trace) {
      throw new Error(`Chat turn ${turnId} not found in session ${sessionId}`);
    }
    const userMessage = sessionState.messagesById.get(trace.userMessageId);
    if (!userMessage) {
      throw new Error(`User message ${trace.userMessageId} not found for chat turn ${turnId}`);
    }
    return {
      trace,
      userMessage,
      assistantMessage: trace.assistantMessageId ? sessionState.messagesById.get(trace.assistantMessageId) : undefined,
    };
  }

  private async buildChatSendMessageResponseFromTurnId(
    sessionId: string,
    turnId: string,
  ): Promise<ChatSendMessageResponse> {
    const turn = await this.requireChatTurnContext(sessionId, turnId);
    return {
      sessionId,
      userMessage: turn.userMessage,
      assistantMessage: turn.assistantMessage,
      transport: "llm",
      model: turn.trace.model,
      turnId: turn.trace.turnId,
      trace: turn.trace,
      citations: turn.trace.citations,
      routing: turn.trace.routing,
    };
  }

  private acquireChatTurnWriteLease(sessionId: string, operation: string): string {
    const existing = this.activeChatTurnWrites.get(sessionId);
    if (existing) {
      throw new ChatTurnWriteConflictError(
        `A chat turn write is already in progress for session ${sessionId}. Wait for the current ${existing} to finish and retry.`,
      );
    }
    const leaseToken = `${operation}:${randomUUID()}`;
    this.activeChatTurnWrites.set(sessionId, operation);
    return leaseToken;
  }

  private releaseChatTurnWriteLease(sessionId: string, leaseToken: string): void {
    const expectedOperation = leaseToken.split(":", 1)[0];
    if (this.activeChatTurnWrites.get(sessionId) === expectedOperation) {
      this.activeChatTurnWrites.delete(sessionId);
    }
  }

  private async withChatTurnWriteLease<T>(
    sessionId: string,
    operation: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const leaseToken = this.acquireChatTurnWriteLease(sessionId, operation);
    try {
      return await work();
    } finally {
      this.releaseChatTurnWriteLease(sessionId, leaseToken);
    }
  }

  private async *withChatTurnWriteLeaseStream(
    sessionId: string,
    operation: string,
    work: () => AsyncGenerator<ChatStreamChunk>,
  ): AsyncGenerator<ChatStreamChunk> {
    const leaseToken = this.acquireChatTurnWriteLease(sessionId, operation);
    try {
      yield* work();
    } finally {
      this.releaseChatTurnWriteLease(sessionId, leaseToken);
    }
  }

  private updateActiveLeafOrThrow(
    sessionId: string,
    expectedActiveLeafTurnId: string | undefined,
    nextActiveLeafTurnId: string,
    now = new Date().toISOString(),
  ): void {
    const updated = this.storage.chatSessionBranchState.setActiveLeafIfCurrent(
      sessionId,
      expectedActiveLeafTurnId,
      nextActiveLeafTurnId,
      now,
    );
    if (updated) {
      return;
    }
    const current = this.storage.chatSessionBranchState.get(sessionId)?.activeLeafTurnId;
    console.warn("[goatcitadel] chat turn branch-state conflict", {
      sessionId,
      expectedActiveLeafTurnId,
      nextActiveLeafTurnId,
      currentActiveLeafTurnId: current,
    });
    throw new ChatTurnWriteConflictError(
      `Chat branch state changed while writing session ${sessionId}. Refresh the session and retry.`,
    );
  }

  private async prepareAgentChatTurn(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: {
      branchKind?: ChatTurnBranchKind;
      sourceTurnId?: string;
      parentTurnId?: string;
      existingUserMessage?: ChatMessageRecord;
      ingestUserMessage?: boolean;
      turnId?: string;
      assistantMessageId?: string;
    },
  ): Promise<{
    session: SessionMeta;
    route: ReturnType<GatewayService["routeFromSession"]>;
    workspaceId: string;
    content: string;
    userEventId: string;
    userMessage: ChatMessageRecord;
    prefs: ChatSessionPrefsRecord;
    autonomy: SessionAutonomyPrefsRecord;
    normalized: ReturnType<typeof normalizeAgentInputFromSend>;
    retrievalTrace: NonNullable<ChatTurnTraceRecord["retrieval"]>;
    resolvedGuidance: ResolvedRuntimeGuidance;
    conversationMessages: ChatMessageRecord[];
    history: ChatCompletionRequest["messages"];
    turnId: string;
    assistantMessageId: string;
    parentTurnId?: string;
    branchKind: ChatTurnBranchKind;
    sourceTurnId?: string;
    effectiveToolAutonomy: ChatSessionPrefsRecord["toolAutonomy"];
  }> {
    const session = this.getSession(sessionId);
    this.ensureChatSessionRuntimeGrants(sessionId);
    const sessionMeta = this.storage.chatSessionMeta.ensure(sessionId);
    assertChatSessionActive(sessionId, sessionMeta.lifecycleStatus);
    const workspaceId = this.normalizeWorkspaceId(sessionMeta.workspaceId);
    const branchKind = options?.branchKind ?? "append";
    const content = (options?.existingUserMessage?.content ?? input.content).trim();
    if (!content) {
      throw new Error("content is required");
    }
    if (branchKind !== "retry") {
      this.maybeAutoTitleChatSession(sessionId, content);
    }

    const route = this.routeFromSession(session);
    const ingestUserMessage = options?.ingestUserMessage ?? !options?.existingUserMessage;
    let userEventId = options?.existingUserMessage?.messageId ?? "";
    let userMessage = options?.existingUserMessage;
    let attachments = options?.existingUserMessage?.attachments ?? [];
    if (ingestUserMessage || !userMessage) {
      const uploadAttachments = this.storage.chatAttachments.listByIds(input.attachments ?? [], workspaceId);
      const inputParts = normalizeChatInputParts(content, input.parts, uploadAttachments);
      userEventId = randomUUID();
      await this.ingestEvent(randomUUID(), {
        eventId: userEventId,
        route,
        actor: {
          type: "user",
          id: "operator",
        },
        message: {
          role: "user",
          content,
          parts: inputParts,
          attachments: uploadAttachments.map((item) => ({
            attachmentId: item.attachmentId,
            fileName: item.fileName,
            mimeType: item.mimeType,
            sizeBytes: item.sizeBytes,
          })),
        },
      });
      attachments = uploadAttachments.map((item) => ({
        attachmentId: item.attachmentId,
        fileName: item.fileName,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
      }));
      userMessage = {
        messageId: userEventId,
        sessionId,
        role: "user",
        actorType: "user",
        actorId: "operator",
        content,
        parts: inputParts.length > 0 ? inputParts : undefined,
        timestamp: new Date().toISOString(),
        attachments: attachments.length > 0 ? attachments : undefined,
      };
    }
    if (!userMessage) {
      throw new Error("user message is required");
    }

    const prefsOverride = applyChatModePresetToPatch({
      ...(input.prefsOverride ?? {}),
      mode: input.mode ?? input.prefsOverride?.mode,
      providerId: input.providerId ?? input.prefsOverride?.providerId,
      model: input.model ?? input.prefsOverride?.model,
      webMode: input.webMode ?? input.prefsOverride?.webMode,
      memoryMode: input.memoryMode ?? input.prefsOverride?.memoryMode,
      thinkingLevel: input.thinkingLevel ?? input.prefsOverride?.thinkingLevel,
    });
    const splitPrefs = splitChatPrefsPatch(prefsOverride);
    if (Object.keys(splitPrefs.autonomyPatch).length > 0) {
      this.patchSessionAutonomyPrefs(sessionId, splitPrefs.autonomyPatch);
    }
    const prefsPatched = this.storage.chatSessionPrefs.patch(sessionId, splitPrefs.basePatch);
    const prefs = this.ensureGlmPrimaryDefaults(sessionId, prefsPatched);
    const autonomy = this.getSessionAutonomyPrefs(sessionId);
    const normalized = normalizeAgentInputFromSend(input);
    const projectId = this.storage.chatSessionProjects.get(sessionId)?.projectId;
    const requiresProjectBinding = chatModeRequiresProjectBinding(prefs.mode);
    const missingRequiredProjectBinding = requiresProjectBinding && !projectId;
    const effectiveToolAutonomy = prefs.planningMode === "advisory" || missingRequiredProjectBinding
      ? "manual"
      : prefs.toolAutonomy;
    const retrievalTrace = buildRetrievalTrace({
      content,
      retrievalMode: autonomy.retrievalMode,
      webMode: normalized.webMode ?? prefs.webMode,
      memoryMode: normalized.memoryMode ?? prefs.memoryMode,
    });
    const resolvedGuidance = await this.resolveRuntimeGuidance(workspaceId);
    const guidanceSystemInstruction = mergeChatSystemInstructions(
      resolvedGuidance.systemInstruction,
      buildPlanningModeSystemInstruction(prefs.planningMode),
      missingRequiredProjectBinding
        ? "Code mode requires a bound project before execution-heavy work. Until a project is attached, stay in planning and review posture, and do not imply that repository-bound edits or filesystem inspection were executed."
        : undefined,
    );

    const sessionState = await this.loadChatTurnSessionState(sessionId);
    const parentTurnId = options?.parentTurnId ?? sessionState.activeLeafTurnId;
    const pathTurnIds = parentTurnId ? buildSelectedPathTurnIds(sessionState.turnLineageById, parentTurnId) : [];
    const conversationMessages = pathTurnIds.flatMap((turnId) => {
      const trace = sessionState.tracesById.get(turnId);
      if (!trace) {
        return [];
      }
      const items: ChatMessageRecord[] = [];
      const userMessageFromState = sessionState.messagesById.get(trace.userMessageId);
      if (userMessageFromState) {
        items.push(userMessageFromState);
      }
      if (trace.assistantMessageId) {
        const assistantMessage = sessionState.messagesById.get(trace.assistantMessageId);
        if (assistantMessage) {
          items.push(assistantMessage);
        }
      }
      return items;
    });
    conversationMessages.push(userMessage);
    const history = await this.buildLlmMessagesFromBranchPath(sessionId, pathTurnIds, userMessage, {
      providerId: input.providerId ?? prefs.providerId,
      model: input.model ?? prefs.model,
      guidanceSystemInstruction,
    }, sessionState);

    return {
      session,
      route,
      workspaceId,
      content,
      userEventId,
      userMessage,
      prefs,
      autonomy,
      normalized,
      retrievalTrace,
      resolvedGuidance,
      conversationMessages,
      history,
      turnId: options?.turnId ?? randomUUID(),
      assistantMessageId: options?.assistantMessageId ?? `assistant-${randomUUID()}`,
      parentTurnId,
      branchKind,
      sourceTurnId: options?.sourceTurnId,
      effectiveToolAutonomy,
    };
  }

  private async resolvePreparedTurnOrchestration(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
  ): Promise<PreparedChatExecutionPlanResolution | undefined> {
    const mode = prepared.normalized.mode ?? prepared.prefs.mode;
    const runtime = this.llmService.getRuntimeConfig({
      useCache: true,
    });
    const capabilities = buildProviderCapabilityRegistry(runtime);
    const policy = resolveModePolicy(mode);
    const routerInput: OrchestrationRouterInput = {
      task: {
        sessionId: prepared.session.sessionId,
        workspaceId: prepared.workspaceId,
        mode,
        objective: prepared.content,
        prefs: prepared.prefs,
        conversation: prepared.conversationMessages,
        historyMessages: prepared.history,
      },
      runtime,
      capabilities,
      policy,
    };
    const advisoryOnly = prepared.prefs.planningMode === "advisory";
    if (!advisoryOnly && !shouldUseModeOrchestration(routerInput)) {
      return undefined;
    }
    const templatePlan = this.applyApprovedSpecialistsToPlan(prepared, buildOrchestrationPlan(routerInput));
    const executionPlanDraft = await this.generatePreparedExecutionPlanDraft(prepared, routerInput, templatePlan, advisoryOnly);
    const plan = applyExecutionPlanDraftToOrchestrationPlan(templatePlan, executionPlanDraft);
    return {
      routerInput,
      orchestrationPlan: plan,
      executionPlanDraft,
    };
  }

  private applyApprovedSpecialistsToPlan(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    plan: ReturnType<typeof buildOrchestrationPlan>,
  ): ReturnType<typeof buildOrchestrationPlan> {
    const mode = prepared.normalized.mode ?? prepared.prefs.mode;
    if (!chatModeAllowsDynamicTeamGrowth(mode)) {
      return plan;
    }
    const candidates = this.storage.chatSpecialistCandidates.listAutoRoutable(
      prepared.session.sessionId,
      mode,
      Boolean(this.storage.chatSessionProjects.get(prepared.session.sessionId)?.projectId),
    );
    if (candidates.length === 0) {
      return plan;
    }
    const objectiveKeywords = extractSpecialistObjectiveKeywords(prepared.content);
    const nextSteps = plan.steps.map((step) => ({ ...step }));
    const matchedSelections: NonNullable<typeof plan.routeDecision.specialistCandidates> = [];
    const usedCandidateIds = new Set<string>();
    for (const step of nextSteps) {
      const bestMatch = candidates
        .filter((candidate) => !usedCandidateIds.has(candidate.candidateId))
        .map((candidate) => {
          const baseRole = inferSpecialistBaseRole(candidate.role);
          const score = scoreSpecialistCandidateMatch(candidate, objectiveKeywords, step.role);
          return { candidate, baseRole, score };
        })
        .filter((item) => item.baseRole === step.role && item.score >= 0.58)
        .sort((left, right) => right.score - left.score)
        .at(0);
      if (!bestMatch) {
        continue;
      }
      const selection = {
        candidateId: bestMatch.candidate.candidateId,
        title: bestMatch.candidate.title,
        role: bestMatch.candidate.role,
        baseRole: bestMatch.baseRole,
        summary: bestMatch.candidate.summary,
        matchReason: buildSpecialistMatchReason(bestMatch.candidate, objectiveKeywords),
        routingMode: bestMatch.candidate.routingMode,
      } satisfies NonNullable<typeof plan.routeDecision.specialistCandidates>[number];
      step.specialistCandidate = selection;
      matchedSelections.push(selection);
      usedCandidateIds.add(bestMatch.candidate.candidateId);
      if (matchedSelections.length >= 2) {
        break;
      }
    }
    if (matchedSelections.length === 0) {
      return plan;
    }
    return {
      ...plan,
      routeDecision: {
        ...plan.routeDecision,
        specialistCandidates: matchedSelections,
      },
      steps: nextSteps,
    };
  }

  private async generatePreparedExecutionPlanDraft(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    routerInput: OrchestrationRouterInput,
    templatePlan: ModeOrchestrationPlan,
    advisoryOnly: boolean,
  ): Promise<PreparedChatExecutionPlanResolution["executionPlanDraft"]> {
    const fallbackDraft = buildExecutionPlanDraftFromOrchestrationPlan(templatePlan, {
      objective: prepared.content,
      advisoryOnly,
    });
    try {
      const completion = await this.createChatCompletion({
        providerId: prepared.prefs.providerId,
        model: prepared.prefs.model,
        stream: false,
        memory: {
          enabled: false,
          mode: "off",
        },
        response_format: {
          type: "json_object",
        },
        messages: [
          {
            role: "system",
            content: [
              "You are GoatCitadel's execution planner.",
              "Return strict JSON with keys: summary, steps.",
              `Return between ${CHAT_PLANNER_MIN_STEPS} and ${CHAT_PLANNER_MAX_STEPS} steps.`,
              "Each step must include: objective, successCriteria, suggestedTools, expectedOutput, parallelizable, dependsOnStepIds, delegatedRole.",
              "Use delegatedRole only from the allowed role list.",
              "If the mode is chat, delegatedRole must be null for all steps.",
              "Keep step objectives specific, practical, and directly tied to the user request.",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              mode: routerInput.task.mode,
              planningMode: prepared.prefs.planningMode,
              objective: prepared.content,
              workflowTemplate: templatePlan.workflowTemplate,
              routeDecision: templatePlan.routeDecision,
              allowedRoles: [...new Set(templatePlan.steps.map((step) => step.role))],
              templateSteps: templatePlan.steps.map((step) => ({
                stepId: step.stepId,
                role: step.role,
                objective: step.objective,
                successCriteria: step.successCriteria,
                suggestedTools: step.suggestedTools,
                expectedOutput: step.expectedOutput,
                parallelizable: step.parallelizable,
                dependsOnStepIds: step.dependsOnStepIds,
                delegatedRole: step.delegatedRole ?? null,
              })),
            }),
          },
        ],
      });
      const payload = parseLooseJsonRecord(extractCompletionText(completion));
      const planned = payload
        ? coercePlannerExecutionPlanDraft(payload, templatePlan, {
          advisoryOnly,
          mode: routerInput.task.mode,
          objective: prepared.content,
        })
        : undefined;
      if (!planned) {
        return fallbackDraft;
      }
      return planned;
    } catch {
      return fallbackDraft;
    }
  }

  private buildChatOrchestrationSummary(input: {
    runId: string;
    objective: string;
    modePolicy: ChatMode;
    routeDecision: ReturnType<typeof buildOrchestrationPlan>["routeDecision"];
    stepResults: OrchestrationStepExecutionResult[];
    finalSummary?: string;
    finalized?: boolean;
    advisoryOnly?: boolean;
  }): NonNullable<ChatTurnTraceRecord["orchestration"]> {
    const completedCount = input.stepResults.filter((step) => step.status === "completed").length;
    const failedCount = input.stepResults.filter((step) => step.status === "failed").length;
    const status: ChatDelegationRunRecord["status"] = !input.finalized
      ? "running"
      : input.advisoryOnly
        ? "completed"
      : completedCount === 0
        ? "failed"
        : failedCount > 0
          ? "partial"
          : "completed";
    return {
      runId: input.runId,
      objective: input.objective,
      workflowTemplate: input.routeDecision.workflowTemplate,
      status,
      modePolicy: input.modePolicy,
      visibility: input.routeDecision.visibility,
      finalSummary: input.finalSummary,
      routeDecision: input.routeDecision,
      steps: input.stepResults.map((step) => ({
        stepId: step.stepId,
        role: step.role,
        index: step.index,
        status: step.status,
        specialistCandidateId: step.specialistCandidateId,
        specialistTitle: step.specialistTitle,
        specialistRole: step.specialistRole,
        providerId: step.providerId,
        model: step.model,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
        durationMs: step.durationMs,
        summary: step.summary,
        error: step.error,
      })),
    };
  }

  private collectOrchestrationToolRuns(runId: string): ChatToolRunRecord[] {
    const steps = this.storage.chatDelegationSteps.listByRun(runId);
    const childTurnIds = steps
      .map((step) => step.childTurnId)
      .filter((value): value is string => Boolean(value));
    if (childTurnIds.length === 0) {
      return [];
    }
    const toolRunsByTurnId = this.storage.chatToolRuns.listByTurnIds(childTurnIds);
    const orderedToolRuns: ChatToolRunRecord[] = [];
    for (const step of steps) {
      if (!step.childTurnId) {
        continue;
      }
      const toolRuns = toolRunsByTurnId.get(step.childTurnId);
      if (toolRuns?.length) {
        orderedToolRuns.push(...toolRuns);
      }
    }
    return orderedToolRuns;
  }

  private async executePreparedModeOrchestration(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    input: ChatSendMessageRequest,
    signal?: AbortSignal,
    onProgress?: (summary: NonNullable<ChatTurnTraceRecord["orchestration"]>) => Promise<void> | void,
    resolvedOrchestration?: PreparedChatExecutionPlanResolution,
  ): Promise<
    OrchestrationExecutionResult
    & {
      summary: NonNullable<ChatTurnTraceRecord["orchestration"]>;
      executionPlanId: string;
    }
  > {
    const orchestration = resolvedOrchestration ?? await this.resolvePreparedTurnOrchestration(prepared);
    if (!orchestration) {
      throw new Error("Prepared chat turn is not eligible for orchestration");
    }
    const runId = randomUUID();
    const runMode = orchestration.orchestrationPlan.routeDecision.parallelism === "parallel" ? "parallel" : "sequential";
    const persistedExecutionPlan = this.storage.chatExecutionPlans.create({
      sessionId: prepared.session.sessionId,
      turnId: prepared.turnId,
      mode: orchestration.routerInput.task.mode,
      planningMode: prepared.prefs.planningMode,
      source: orchestration.executionPlanDraft.source,
      advisoryOnly: orchestration.executionPlanDraft.advisoryOnly,
      objective: orchestration.executionPlanDraft.objective,
      summary: orchestration.executionPlanDraft.summary,
      status: "running",
      startedAt: new Date().toISOString(),
      steps: orchestration.executionPlanDraft.steps,
    });
    this.recordDevDiagnostic({
      level: "info",
      category: "orchestration",
      event: "orchestration.run.start",
      message: "Starting chat orchestration run",
      sessionId: prepared.session.sessionId,
      turnId: prepared.turnId,
      providerId: orchestration.orchestrationPlan.steps.at(0)?.providerId,
      modelId: orchestration.orchestrationPlan.steps.at(0)?.model,
      context: {
        workflowTemplate: orchestration.orchestrationPlan.workflowTemplate,
        visibility: orchestration.orchestrationPlan.routeDecision.visibility,
        roles: orchestration.orchestrationPlan.routeDecision.selectedRoles,
        parallelism: runMode,
      },
    });
    const runTrace = {
      primaryProviderId: input.providerId ?? prepared.prefs.providerId,
      primaryModel: input.model ?? prepared.prefs.model,
      effectiveProviderId: orchestration.orchestrationPlan.steps.at(-1)?.providerId ?? input.providerId ?? prepared.prefs.providerId,
      effectiveModel: orchestration.orchestrationPlan.steps.at(-1)?.model ?? input.model ?? prepared.prefs.model,
    } satisfies ChatTurnTraceRecord["routing"];
    this.storage.chatDelegationRuns.create({
      runId,
      sessionId: prepared.session.sessionId,
      taskId: `chat-orchestration:${prepared.turnId}`,
      objective: prepared.content,
      roles: orchestration.orchestrationPlan.routeDecision.selectedRoles,
      mode: runMode,
      providerId: input.providerId ?? prepared.prefs.providerId,
      model: input.model ?? prepared.prefs.model,
      status: "running",
      visibility: orchestration.orchestrationPlan.routeDecision.visibility,
      workflowTemplate: orchestration.orchestrationPlan.workflowTemplate,
      executionPlanId: persistedExecutionPlan.planId,
      routeDecision: orchestration.orchestrationPlan.routeDecision,
      citations: [],
      trace: runTrace,
    });

    const persistedStepIds = new Map<string, string>();
    for (const [index, step] of orchestration.orchestrationPlan.steps.entries()) {
      const persistedStepId = `${runId}:${step.stepId}`;
      persistedStepIds.set(step.stepId, persistedStepId);
      this.storage.chatDelegationSteps.create({
        stepId: persistedStepId,
        runId,
        role: step.role,
        index,
        status: "pending",
        providerId: step.providerId,
        model: step.model,
      });
    }

    let currentSteps: OrchestrationStepExecutionResult[] = [];
    const initialSummary = this.buildChatOrchestrationSummary({
      runId,
      objective: prepared.content,
      modePolicy: orchestration.routerInput.task.mode,
      routeDecision: orchestration.orchestrationPlan.routeDecision,
      stepResults: currentSteps,
      finalized: false,
    });
    await onProgress?.(initialSummary);

    if (orchestration.executionPlanDraft.advisoryOnly) {
      const advisoryOutput = renderExecutionPlanAsMarkdown({
        mode: orchestration.routerInput.task.mode,
        objective: orchestration.executionPlanDraft.objective,
        summary: orchestration.executionPlanDraft.summary,
        steps: persistedExecutionPlan.steps,
      });
      const advisorySummary = this.buildChatOrchestrationSummary({
        runId,
        objective: prepared.content,
        modePolicy: orchestration.routerInput.task.mode,
        routeDecision: orchestration.orchestrationPlan.routeDecision,
        stepResults: [],
        finalSummary: orchestration.executionPlanDraft.summary,
        finalized: true,
        advisoryOnly: true,
      });
      this.storage.chatDelegationRuns.patch(runId, {
        status: "completed",
        visibility: advisorySummary.visibility,
        workflowTemplate: advisorySummary.workflowTemplate,
        routeDecision: advisorySummary.routeDecision,
        finalSummary: orchestration.executionPlanDraft.summary,
        stitchedOutput: advisoryOutput,
        citations: [],
        trace: runTrace,
        finishedAt: new Date().toISOString(),
      });
      this.storage.chatExecutionPlans.patch(persistedExecutionPlan.planId, {
        status: "ready",
        summary: orchestration.executionPlanDraft.summary,
        finishedAt: new Date().toISOString(),
      });
      await onProgress?.(advisorySummary);
      return {
        finalOutput: advisoryOutput,
        finalSummary: orchestration.executionPlanDraft.summary,
        citations: [],
        routeDecision: orchestration.orchestrationPlan.routeDecision,
        stepResults: [],
        summary: advisorySummary,
        executionPlanId: persistedExecutionPlan.planId,
      };
    }

    const result = await executeOrchestrationPlan({
      task: orchestration.routerInput.task,
      plan: orchestration.orchestrationPlan,
      callbacks: {
        createChatCompletion: (request) => this.createChatCompletion({
          ...request,
          signal,
        }),
        executeDelegatedStep: async ({ task, plan, priorSteps, step, stepIndex }) =>
          this.executeDelegatedPlanStep(prepared, {
            task,
            plan,
            priorSteps,
            step,
            stepIndex,
            runId,
            signal,
          }),
        onStepResult: async (step, allSteps) => {
          currentSteps = [...allSteps];
          this.recordDevDiagnostic({
            level: step.status === "failed" ? "warn" : "info",
            category: "orchestration",
            event: "orchestration.step.complete",
            message: `Completed orchestration step ${step.role}`,
            sessionId: prepared.session.sessionId,
            turnId: prepared.turnId,
            providerId: step.providerId,
            modelId: step.model,
            context: {
              stepId: step.stepId,
              role: step.role,
              status: step.status,
              index: step.index,
            },
          });
          this.storage.chatDelegationSteps.patch(persistedStepIds.get(step.stepId) ?? step.stepId, {
            status: step.status,
            providerId: step.providerId,
            model: step.model,
            summary: step.summary,
            output: step.output,
            error: step.error,
            failureGuidance: step.failureGuidance ?? (step.error ? buildDelegationFailureGuidance(step.error, step.role) : undefined),
            childSessionId: step.childSessionId,
            childTurnId: step.childTurnId,
            citations: step.citations,
            finishedAt: step.finishedAt,
            durationMs: step.durationMs,
          });
          this.storage.chatExecutionPlans.patch(persistedExecutionPlan.planId, {
            steps: mergeExecutionPlanStepStatuses(
              this.storage.chatExecutionPlans.get(persistedExecutionPlan.planId).steps,
              allSteps,
            ),
          });
          const summary = this.buildChatOrchestrationSummary({
            runId,
            objective: prepared.content,
            modePolicy: orchestration.routerInput.task.mode,
            routeDecision: orchestration.orchestrationPlan.routeDecision,
            stepResults: currentSteps,
            finalized: false,
          });
          await onProgress?.(summary);
        },
      },
    });

    const summary = this.buildChatOrchestrationSummary({
      runId,
      objective: prepared.content,
      modePolicy: orchestration.routerInput.task.mode,
      routeDecision: orchestration.orchestrationPlan.routeDecision,
      stepResults: result.stepResults,
      finalSummary: result.finalSummary,
      finalized: true,
    });
    this.storage.chatDelegationRuns.patch(runId, {
      status: summary.status,
      visibility: summary.visibility,
      workflowTemplate: summary.workflowTemplate,
      routeDecision: summary.routeDecision,
      finalSummary: result.finalSummary,
      stitchedOutput: result.finalOutput,
      citations: result.citations,
      trace: {
        ...runTrace,
        effectiveProviderId: result.finalStep?.providerId ?? result.stepResults.at(-1)?.providerId ?? runTrace.effectiveProviderId,
        effectiveModel: result.finalStep?.model ?? result.stepResults.at(-1)?.model ?? runTrace.effectiveModel,
      },
      finishedAt: new Date().toISOString(),
    });
    this.storage.chatExecutionPlans.patch(persistedExecutionPlan.planId, {
      status: summary.status === "failed" ? "failed" : "completed",
      summary: result.finalSummary,
      finishedAt: new Date().toISOString(),
      steps: mergeExecutionPlanStepStatuses(
        this.storage.chatExecutionPlans.get(persistedExecutionPlan.planId).steps,
        result.stepResults,
      ),
    });
    await onProgress?.(summary);
    this.recordDevDiagnostic({
      level: summary.status === "failed" ? "warn" : "info",
      category: "orchestration",
      event: "orchestration.run.complete",
      message: "Completed chat orchestration run",
      sessionId: prepared.session.sessionId,
      turnId: prepared.turnId,
      providerId: result.finalStep?.providerId ?? result.stepResults.at(-1)?.providerId,
      modelId: result.finalStep?.model ?? result.stepResults.at(-1)?.model,
      context: {
        status: summary.status,
        workflowTemplate: summary.workflowTemplate,
      },
    });
    return {
      ...result,
      summary,
      executionPlanId: persistedExecutionPlan.planId,
    };
  }

  private async executeDelegatedPlanStep(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    input: {
      task: OrchestrationRouterInput["task"];
      plan: ModeOrchestrationPlan;
      priorSteps: OrchestrationStepExecutionResult[];
      step: ModeOrchestrationPlan["steps"][number];
      stepIndex: number;
      runId: string;
      signal?: AbortSignal;
    },
  ): Promise<OrchestrationStepExecutionResult> {
    const startedAt = new Date().toISOString();
    const delegatedRole = input.step.delegatedRole ?? input.step.role;
    const parentProjectId = this.storage.chatSessionProjects.get(prepared.session.sessionId)?.projectId;
    const childSession = this.createChatSession({
      workspaceId: prepared.workspaceId,
      title: `Delegate · ${toTitleCase(delegatedRole)}`,
      projectId: parentProjectId,
      mode: input.task.mode,
    });
    this.inheritDelegatedSessionToolGrants(prepared.session.sessionId, childSession.sessionId);

    this.updateChatSessionPrefs(childSession.sessionId, {
      mode: input.task.mode,
      planningMode: "off",
      providerId: input.step.providerId ?? prepared.prefs.providerId,
      model: input.step.model ?? prepared.prefs.model,
      webMode: prepared.prefs.webMode,
      memoryMode: prepared.prefs.memoryMode,
      thinkingLevel: prepared.prefs.thinkingLevel,
      toolAutonomy: prepared.effectiveToolAutonomy,
      orchestrationEnabled: false,
      orchestrationIntensity: "minimal",
      orchestrationVisibility: "explicit",
      orchestrationProviderPreference: prepared.prefs.orchestrationProviderPreference,
      orchestrationReviewDepth: prepared.prefs.orchestrationReviewDepth,
      orchestrationParallelism: "sequential",
      codeAutoApply: prepared.prefs.codeAutoApply,
      proactiveMode: "off",
      retrievalMode: prepared.autonomy.retrievalMode,
      reflectionMode: "off",
    });

    const conversationContext = input.task.conversation
      .slice(-6)
      .map((message) => `${message.role.toUpperCase()}: ${truncateSummaryLine(message.content, 320)}`)
      .join("\n");
    const priorStepContext = input.priorSteps
      .slice(-4)
      .map((step) => [
        `${toTitleCase(step.role)} (${step.status})`,
        truncateSummaryLine(step.summary ?? step.output ?? step.error ?? "No handoff provided.", 320),
      ].join(": "))
      .join("\n");
    const content = [
      `Delegated role: ${delegatedRole}`,
      `Parent objective: ${input.task.objective}`,
      `Plan summary: ${input.plan.summary}`,
      `Current step objective: ${input.step.objective}`,
      input.step.successCriteria ? `Success criteria: ${input.step.successCriteria}` : undefined,
      input.step.expectedOutput ? `Expected output: ${input.step.expectedOutput}` : undefined,
      input.step.suggestedTools?.length ? `Suggested tools: ${input.step.suggestedTools.join(", ")}` : undefined,
      input.step.dependsOnStepIds?.length ? `Depends on: ${input.step.dependsOnStepIds.join(", ")}` : undefined,
      conversationContext ? `Conversation context:\n${conversationContext}` : undefined,
      priorStepContext ? `Prior handoffs:\n${priorStepContext}` : undefined,
      "Produce only the delegated output for this step. Be concrete, cite evidence when available, and name any blocking issue explicitly.",
    ].filter(Boolean).join("\n\n");

    try {
      if (input.signal?.aborted) {
        throw new ChatTurnCancelledError(prepared.turnId);
      }
      const response = await this.agentSendChatMessage(
        childSession.sessionId,
        buildDelegatedChatSendRequest({
          content,
          providerId: input.step.providerId ?? prepared.prefs.providerId,
          model: input.step.model ?? prepared.prefs.model,
          mode: input.task.mode,
          webMode: prepared.prefs.webMode,
          memoryMode: prepared.prefs.memoryMode,
          thinkingLevel: prepared.prefs.thinkingLevel,
          retrievalMode: prepared.autonomy.retrievalMode,
        }),
      );
      if (input.signal?.aborted) {
        throw new ChatTurnCancelledError(prepared.turnId);
      }

      const output = response.assistantMessage?.content?.trim()
        || response.trace?.failure?.message?.trim()
        || "(delegate returned no output)";
      const finishedAt = new Date().toISOString();
      const failed = response.trace?.status === "failed" || response.trace?.status === "cancelled";
      const failureGuidance = failed && response.trace?.failure?.message
        ? buildDelegationFailureGuidance(response.trace.failure.message, delegatedRole)
        : undefined;

      return {
        stepId: input.step.stepId,
        role: input.step.role,
        index: input.stepIndex,
        specialistCandidateId: input.step.specialistCandidate?.candidateId,
        specialistTitle: input.step.specialistCandidate?.title,
        specialistRole: input.step.specialistCandidate?.role,
        providerId: response.trace?.routing?.effectiveProviderId ?? input.step.providerId ?? prepared.prefs.providerId,
        model: response.trace?.model ?? input.step.model ?? prepared.prefs.model,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        status: failed ? "failed" : "completed",
        output,
        summary: truncateSummaryLine(output, 180),
        error: failed ? response.trace?.failure?.message ?? output : undefined,
        failureGuidance,
        citations: response.citations ?? [],
        routing: response.routing,
        childRunId: input.runId,
        childSessionId: childSession.sessionId,
        childTurnId: response.turnId,
      };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      return {
        stepId: input.step.stepId,
        role: input.step.role,
        index: input.stepIndex,
        specialistCandidateId: input.step.specialistCandidate?.candidateId,
        specialistTitle: input.step.specialistCandidate?.title,
        specialistRole: input.step.specialistCandidate?.role,
        providerId: input.step.providerId ?? prepared.prefs.providerId,
        model: input.step.model ?? prepared.prefs.model,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        status: "failed",
        summary: `${toTitleCase(delegatedRole)} failed`,
        error: message,
        failureGuidance: buildDelegationFailureGuidance(message, delegatedRole),
        citations: [],
        childRunId: input.runId,
        childSessionId: childSession.sessionId,
      };
    }
  }

  private async *streamPreparedAgentChatTurn(
    sessionId: string,
    input: ChatSendMessageRequest,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
    resolvedOrchestration?: PreparedChatExecutionPlanResolution,
    options?: {
      skipMessageStart?: boolean;
    },
  ): AsyncGenerator<ChatStreamChunkDraft> {
    const turnId = prepared.turnId;
    const assistantMessageId = prepared.assistantMessageId;
    const controller = this.beginActiveChatTurnExecution(sessionId, turnId, threadEventType);

    try {
      if (!options?.skipMessageStart) {
        yield {
          type: "message_start",
          sessionId,
          turnId,
          messageId: assistantMessageId,
          parentTurnId: prepared.parentTurnId,
          branchKind: prepared.branchKind,
          sourceTurnId: prepared.sourceTurnId,
        };
      }

      const modeOrchestration = resolvedOrchestration ?? await this.resolvePreparedTurnOrchestration(prepared);
      if (modeOrchestration) {
        const mode = prepared.normalized.mode ?? prepared.prefs.mode;
        const initialTrace = this.storage.chatTurnTraces.create({
          turnId,
          sessionId,
          userMessageId: prepared.userEventId,
          parentTurnId: prepared.parentTurnId,
          branchKind: prepared.branchKind,
          sourceTurnId: prepared.sourceTurnId,
          status: "running",
          mode,
          model: modeOrchestration.orchestrationPlan.steps.at(0)?.model ?? input.model ?? prepared.prefs.model,
          webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
          memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
          thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
          effectiveToolAutonomy: prepared.effectiveToolAutonomy,
          routing: {
            primaryProviderId: input.providerId ?? prepared.prefs.providerId,
            primaryModel: input.model ?? prepared.prefs.model,
            effectiveProviderId: modeOrchestration.orchestrationPlan.steps.at(0)?.providerId ?? input.providerId ?? prepared.prefs.providerId,
            effectiveModel: modeOrchestration.orchestrationPlan.steps.at(0)?.model ?? input.model ?? prepared.prefs.model,
          },
        });
        yield {
          type: "trace_update",
          sessionId,
          turnId,
          trace: initialTrace,
        };

        let executionPlanId: string | undefined;
        const orchestrationResult = await this.executePreparedModeOrchestration(prepared, input, controller.signal, async (summary) => {
          this.storage.chatTurnTraces.patch(turnId, {
            executionPlanId,
            orchestration: summary,
            model: summary.steps.at(-1)?.model ?? modeOrchestration.orchestrationPlan.steps.at(0)?.model ?? input.model ?? prepared.prefs.model,
            routing: {
              primaryProviderId: input.providerId ?? prepared.prefs.providerId,
              primaryModel: input.model ?? prepared.prefs.model,
              effectiveProviderId: summary.steps.at(-1)?.providerId ?? modeOrchestration.orchestrationPlan.steps.at(0)?.providerId ?? input.providerId ?? prepared.prefs.providerId,
              effectiveModel: summary.steps.at(-1)?.model ?? modeOrchestration.orchestrationPlan.steps.at(0)?.model ?? input.model ?? prepared.prefs.model,
            },
          });
        }, modeOrchestration);
        executionPlanId = orchestrationResult.executionPlanId;

        let finalText = orchestrationResult.finalOutput.trim();
        if (!finalText) {
          finalText = buildEmptyAssistantTurnFallbackText();
        }

        await this.ingestEvent(randomUUID(), {
          eventId: assistantMessageId,
          route: prepared.route,
          actor: {
            type: "agent",
            id: "assistant",
          },
          message: {
            role: "assistant",
            content: finalText,
          },
        });

        for (const citation of orchestrationResult.citations) {
          yield {
            type: "citation",
            sessionId,
            turnId,
            citation,
          };
        }
        const orchestrationToolRuns = this.collectOrchestrationToolRuns(orchestrationResult.summary.runId);

        let hydratedTrace: ChatTurnTraceRecord = {
          ...this.storage.chatTurnTraces.patch(turnId, {
            assistantMessageId,
            executionPlanId: orchestrationResult.executionPlanId,
            status: orchestrationResult.summary.status === "failed" ? "failed" : "completed",
            finishedAt: new Date().toISOString(),
            model: orchestrationResult.finalStep?.model ?? orchestrationResult.summary.steps.at(-1)?.model ?? modeOrchestration.orchestrationPlan.steps.at(0)?.model ?? input.model ?? prepared.prefs.model,
            routing: {
              primaryProviderId: input.providerId ?? prepared.prefs.providerId,
              primaryModel: input.model ?? prepared.prefs.model,
              effectiveProviderId: orchestrationResult.finalStep?.providerId ?? orchestrationResult.summary.steps.at(-1)?.providerId ?? modeOrchestration.orchestrationPlan.steps.at(0)?.providerId ?? input.providerId ?? prepared.prefs.providerId,
              effectiveModel: orchestrationResult.finalStep?.model ?? orchestrationResult.summary.steps.at(-1)?.model ?? modeOrchestration.orchestrationPlan.steps.at(0)?.model ?? input.model ?? prepared.prefs.model,
            },
            retrieval: prepared.retrievalTrace,
            reflection: {
              attempted: false,
              attemptCount: 0,
              outcome: "not_needed",
            },
            proactive: {
              runId: prepared.autonomy.lastProactiveRunId,
              mode: prepared.autonomy.proactiveMode,
            },
            orchestration: orchestrationResult.summary,
            guidance: {
              workspaceId: prepared.workspaceId,
              globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
              workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
              truncated: prepared.resolvedGuidance.truncated,
            },
            citations: orchestrationResult.citations,
          }),
          toolRuns: orchestrationToolRuns,
        };
        this.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
        yield {
          type: "message_done",
          sessionId,
          turnId,
          messageId: assistantMessageId,
          content: finalText,
        };
        const capabilityUpgradeSuggestions = await this.collectCapabilityUpgradeSuggestions({
          sessionId,
          content: prepared.content,
          assistantText: finalText,
          trace: hydratedTrace,
        });
        const specialistCandidateSuggestions = this.collectSpecialistCandidateSuggestions({
          sessionId,
          mode: prepared.normalized.mode ?? prepared.prefs.mode,
          content: prepared.content,
          capabilitySuggestions: capabilityUpgradeSuggestions,
          trace: hydratedTrace,
        });
        if (capabilityUpgradeSuggestions.length > 0 || specialistCandidateSuggestions.length > 0) {
          hydratedTrace = {
            ...this.storage.chatTurnTraces.patch(turnId, {
              capabilityUpgradeSuggestions: capabilityUpgradeSuggestions.length > 0 ? capabilityUpgradeSuggestions : [],
              specialistCandidateSuggestions: specialistCandidateSuggestions.length > 0 ? specialistCandidateSuggestions : [],
            }),
            toolRuns: orchestrationToolRuns,
          };
          if (capabilityUpgradeSuggestions.length > 0) {
            yield {
              type: "capability_upgrade_suggestion",
              sessionId,
              turnId,
              capabilityUpgradeSuggestions,
            };
          }
        }
        yield {
          type: "trace_update",
          sessionId,
          turnId,
          trace: hydratedTrace,
        };
        this.publishRealtime("chat_thread_updated", "chat", {
          type: threadEventType,
          sessionId,
          turnId,
          activeLeafTurnId: turnId,
        });
        this.extractAndPersistLearnedMemory(sessionId, prepared.content, {
          role: "user",
          sourceRef: prepared.userEventId,
          trace: hydratedTrace,
        });
        this.extractAndPersistLearnedMemory(sessionId, finalText, {
          role: "assistant",
          sourceRef: assistantMessageId,
          trace: hydratedTrace,
        });
        if ((hydratedTrace.completion?.status ?? "complete") === "complete" && hydratedTrace.status === "completed") {
          yield {
            type: "done",
            sessionId,
            turnId,
            messageId: assistantMessageId,
          };
        }
        return;
      }

      let finalText = "";
      let assistantUsage: {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        costUsd?: number;
      } | undefined;
      let hasStreamedDelta = false;
      let approvalRequired = false;
      const streamCitations: ChatCitationRecord[] = [];
      for await (const chunk of this.chatAgentOrchestrator.runStream({
        sessionId,
        turnId,
        userMessageId: prepared.userEventId,
        parentTurnId: prepared.parentTurnId,
        branchKind: prepared.branchKind,
        sourceTurnId: prepared.sourceTurnId,
        outputMessageId: assistantMessageId,
        content: prepared.content,
        mode: prepared.normalized.mode ?? prepared.prefs.mode,
        providerId: input.providerId ?? prepared.prefs.providerId,
        model: input.model ?? prepared.prefs.model,
        webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
        memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
        thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
        toolAutonomy: prepared.effectiveToolAutonomy,
        historyMessages: prepared.history,
        signal: controller.signal,
      })) {
        if (chunk.type === "message_done" && chunk.content) {
          finalText = chunk.content;
        }
        if (chunk.type === "approval_required") {
          approvalRequired = true;
          yield chunk;
        }
        if (chunk.type === "usage") {
          assistantUsage = chunk.usage;
          yield chunk;
        }
        if (chunk.type === "message_done") {
          if (chunk.content.trim() && !hasStreamedDelta) {
            finalText = chunk.content;
            for (const slice of splitIntoChunks(chunk.content, 120)) {
              yield {
                type: "delta",
                sessionId,
                turnId,
                messageId: assistantMessageId,
                delta: slice,
              };
            }
          }
        }
        if (chunk.type === "citation") {
          const nextCitations = dedupeChatCitations([...streamCitations, chunk.citation]);
          streamCitations.length = 0;
          streamCitations.push(...nextCitations);
          yield chunk;
        }
        if (chunk.type === "tool_start" || chunk.type === "tool_result" || chunk.type === "trace_update" || chunk.type === "error") {
          yield chunk;
        }
        if (chunk.type === "delta") {
          hasStreamedDelta = true;
          yield {
            ...chunk,
            messageId: chunk.messageId ?? assistantMessageId,
          };
        }
      }

      if (!approvalRequired && !finalText.trim()) {
        finalText = buildEmptyAssistantTurnFallbackText();
        if (!hasStreamedDelta) {
          for (const slice of splitIntoChunks(finalText, 120)) {
            yield {
              type: "delta",
              sessionId,
              turnId,
              messageId: assistantMessageId,
              delta: slice,
            };
          }
        }
      }

      if (approvalRequired) {
        this.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
        this.publishRealtime("chat_thread_updated", "chat", {
          type: threadEventType,
          sessionId,
          turnId,
          activeLeafTurnId: turnId,
        });
        const traceWithMeta = this.storage.chatTurnTraces.patch(turnId, {
          retrieval: prepared.retrievalTrace,
          reflection: {
            attempted: false,
            attemptCount: 0,
            outcome: "not_needed",
          },
          proactive: {
            runId: prepared.autonomy.lastProactiveRunId,
            mode: prepared.autonomy.proactiveMode,
          },
          guidance: {
            workspaceId: prepared.workspaceId,
            globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
            workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
            truncated: prepared.resolvedGuidance.truncated,
          },
          citations: dedupeChatCitations(streamCitations),
        });
        yield {
          type: "trace_update",
          sessionId,
          turnId,
          trace: {
            ...traceWithMeta,
            toolRuns: this.storage.chatToolRuns.listByTurn(turnId),
          },
        };
        return;
      }

      if (finalText.trim()) {
        await this.ingestEvent(randomUUID(), {
          eventId: assistantMessageId,
          route: prepared.route,
          actor: {
            type: "agent",
            id: "assistant",
          },
          message: {
            role: "assistant",
            content: finalText,
          },
          usage: assistantUsage,
        });
        let hydratedTrace: ChatTurnTraceRecord = {
          ...this.storage.chatTurnTraces.patch(turnId, {
            assistantMessageId,
            status: "completed",
            finishedAt: new Date().toISOString(),
            retrieval: prepared.retrievalTrace,
            reflection: {
              attempted: false,
              attemptCount: 0,
              outcome: "not_needed",
            },
            proactive: {
              runId: prepared.autonomy.lastProactiveRunId,
              mode: prepared.autonomy.proactiveMode,
            },
            guidance: {
              workspaceId: prepared.workspaceId,
              globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
              workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
              truncated: prepared.resolvedGuidance.truncated,
            },
            citations: dedupeChatCitations(streamCitations),
          }),
          toolRuns: this.storage.chatToolRuns.listByTurn(turnId),
        };
        this.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
        yield {
          type: "message_done",
          sessionId,
          turnId,
          messageId: assistantMessageId,
          content: finalText,
        };
        const capabilityUpgradeSuggestions = await this.collectCapabilityUpgradeSuggestions({
          sessionId,
          content: prepared.content,
          assistantText: finalText,
          trace: hydratedTrace,
        });
        const specialistCandidateSuggestions = this.collectSpecialistCandidateSuggestions({
          sessionId,
          mode: prepared.normalized.mode ?? prepared.prefs.mode,
          content: prepared.content,
          capabilitySuggestions: capabilityUpgradeSuggestions,
          trace: hydratedTrace,
        });
        if (capabilityUpgradeSuggestions.length > 0 || specialistCandidateSuggestions.length > 0) {
          hydratedTrace = {
            ...this.storage.chatTurnTraces.patch(turnId, {
              capabilityUpgradeSuggestions: capabilityUpgradeSuggestions.length > 0 ? capabilityUpgradeSuggestions : [],
              specialistCandidateSuggestions: specialistCandidateSuggestions.length > 0 ? specialistCandidateSuggestions : [],
            }),
            toolRuns: this.storage.chatToolRuns.listByTurn(turnId),
          };
          if (capabilityUpgradeSuggestions.length > 0) {
            yield {
              type: "capability_upgrade_suggestion",
              sessionId,
              turnId,
              capabilityUpgradeSuggestions,
            };
          }
        }
        yield {
          type: "trace_update",
          sessionId,
          turnId,
          trace: hydratedTrace,
        };
        this.publishRealtime("chat_thread_updated", "chat", {
          type: threadEventType,
          sessionId,
          turnId,
          activeLeafTurnId: turnId,
        });
        this.extractAndPersistLearnedMemory(sessionId, prepared.content, {
          role: "user",
          sourceRef: prepared.userEventId,
          trace: hydratedTrace,
        });
        this.extractAndPersistLearnedMemory(sessionId, finalText, {
          role: "assistant",
          sourceRef: assistantMessageId,
          trace: hydratedTrace,
        });
      }

      const completedTrace = this.storage.chatTurnTraces.get(turnId);
      if (completedTrace.completion?.status === "complete") {
        yield {
          type: "done",
          sessionId,
          turnId,
          messageId: assistantMessageId,
        };
      }
    } catch (error) {
      if (controller.signal.aborted || isChatTurnCancelledError(error)) {
        const trace = this.markChatTurnCancelled(sessionId, turnId);
        yield {
          type: "trace_update",
          sessionId,
          turnId,
          trace,
        };
        return;
      }
      throw error;
    } finally {
      this.endActiveChatTurnExecution(turnId, controller);
    }
  }

  public async agentSendChatMessage(
    sessionId: string,
    input: ChatSendMessageRequest,
  ): Promise<ChatSendMessageResponse> {
    return this.withChatTurnWriteLease(sessionId, "agent-send", async () => {
      this.recordDevDiagnostic({
        level: "info",
        category: "chat",
        event: "chat.turn.start",
        message: "Starting mission chat turn",
        sessionId,
        providerId: input.providerId,
        modelId: input.model,
        context: {
          mode: input.mode,
          webMode: input.webMode,
          thinkingLevel: input.thinkingLevel,
        },
      });
      const prepared = await this.prepareAgentChatTurn(sessionId, input, {
        branchKind: "append",
      });
      const binding = this.storage.chatSessionBindings.get(sessionId)
        ?? this.storage.chatSessionBindings.upsert({
          sessionId,
          workspaceId: prepared.workspaceId,
          transport: "llm",
          writable: true,
        });
      if (binding.transport !== "llm") {
        return this.sendPreparedIntegrationChatTurn(
          sessionId,
          prepared,
          binding,
          "chat_thread_turn_appended",
        );
      }
      const modeOrchestration = await this.resolvePreparedTurnOrchestration(prepared);
      if (modeOrchestration) {
        this.recordDevDiagnostic({
          level: "info",
          category: "orchestration",
          event: "chat.orchestration.selected",
          message: "Routing mission chat turn through orchestration",
          sessionId,
          turnId: prepared.turnId,
        });
        return this.consumePreparedAgentChatTurn(
          sessionId,
          input,
          prepared,
          "chat_thread_turn_appended",
          modeOrchestration,
        );
      }
      if (this.shouldUseDurableExecution(prepared, input)) {
        return this.consumePreparedAgentChatTurn(
          sessionId,
          input,
          prepared,
          "chat_thread_turn_appended",
        );
      }
      const controller = this.beginActiveChatTurnExecution(sessionId, prepared.turnId, "agent-send");
      try {
        let turnId = prepared.turnId;
        let turnResult = await this.chatAgentOrchestrator.run({
          sessionId,
          turnId,
          userMessageId: prepared.userEventId,
          parentTurnId: prepared.parentTurnId,
          branchKind: prepared.branchKind,
          sourceTurnId: prepared.sourceTurnId,
          content: prepared.content,
          mode: prepared.normalized.mode ?? prepared.prefs.mode,
          providerId: input.providerId ?? prepared.prefs.providerId,
          model: input.model ?? prepared.prefs.model,
          webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
          memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
          thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
          toolAutonomy: prepared.effectiveToolAutonomy,
          historyMessages: prepared.history,
          outputMessageId: prepared.assistantMessageId,
          signal: controller.signal,
        });
        let reflectionTrace: ChatTurnTraceRecord["reflection"] = {
          attempted: false,
          attemptCount: 0,
          outcome: "not_needed",
        };

        const shouldAttemptReflection = prepared.autonomy.reflectionMode === "on"
          && prepared.prefs.planningMode !== "advisory"
          && !controller.signal.aborted
          && !turnResult.requiresApproval
          && (turnResult.turnTrace.status === "failed" || looksLowConfidenceResponse(turnResult.assistantContent));

        if (shouldAttemptReflection) {
          const retryTurnId = randomUUID();
          const retryReason = turnResult.turnTrace.status === "failed"
            ? "tool failure or completion failure"
            : "low confidence response";
          reflectionTrace = {
            attempted: true,
            attemptCount: 1,
            reason: retryReason,
            outcome: "still_failed",
          };
          this.gatewaySql.prepare(`
        INSERT INTO chat_reflection_attempts (
          attempt_id, turn_id, session_id, reason, outcome, attempt_count, strategy, error, created_at
        ) VALUES (
          @attemptId, @turnId, @sessionId, @reason, @outcome, @attemptCount, @strategy, @error, @createdAt
        )
          `).run({
            attemptId: randomUUID(),
            turnId: retryTurnId,
            sessionId,
            reason: retryReason,
            outcome: "still_failed",
            attemptCount: 1,
            strategy: "single retry with alternate tool/query strategy",
            error: turnResult.turnTrace.status === "failed" ? turnResult.assistantContent.slice(0, 500) : null,
            createdAt: new Date().toISOString(),
          });

          const retryHistory = prepared.history;
          const retryPrompt = `${prepared.content}\n\nRetry guidance: last attempt was incomplete. Use a different approach or tool and be explicit about limits.`;
          const retryResult = await this.chatAgentOrchestrator.run({
            sessionId,
            turnId: retryTurnId,
            userMessageId: prepared.userEventId,
            parentTurnId: prepared.parentTurnId,
            branchKind: "retry",
            sourceTurnId: turnId,
            content: retryPrompt,
            mode: prepared.normalized.mode ?? prepared.prefs.mode,
            providerId: input.providerId ?? prepared.prefs.providerId,
            model: input.model ?? prepared.prefs.model,
            webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
            memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
            thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
            toolAutonomy: prepared.effectiveToolAutonomy,
            historyMessages: retryHistory,
            outputMessageId: prepared.assistantMessageId,
            signal: controller.signal,
          });
          if (retryResult.turnTrace.status === "completed" && retryResult.assistantContent.trim().length > 0) {
            turnId = retryTurnId;
            turnResult = retryResult;
            reflectionTrace = {
              attempted: true,
              attemptCount: 1,
              reason: retryReason,
              outcome: "recovered",
            };
          }
        }

        const dedupedTurnCitations = dedupeChatCitations(turnResult.turnTrace.citations ?? []);
        const persistedTurnFailure = turnResult.turnTrace.failure
          ?? inferDegradedAssistantTurnFailure(turnResult.assistantContent);
        if (turnResult.requiresApproval || turnResult.turnTrace.status === "cancelled") {
          const traceWithMeta = this.storage.chatTurnTraces.patch(turnId, {
            retrieval: prepared.retrievalTrace,
            reflection: reflectionTrace,
            proactive: {
              runId: prepared.autonomy.lastProactiveRunId,
              mode: prepared.autonomy.proactiveMode,
            },
            guidance: {
              workspaceId: prepared.workspaceId,
              globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
              workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
              truncated: prepared.resolvedGuidance.truncated,
            },
            citations: dedupedTurnCitations,
            failure: persistedTurnFailure,
          });
          if (turnResult.turnTrace.status !== "cancelled") {
            this.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
            this.publishRealtime("chat_thread_updated", "chat", {
              type: "chat_thread_turn_appended",
              sessionId,
              turnId,
              activeLeafTurnId: turnId,
            });
          }
          return {
            sessionId,
            userMessage: prepared.userMessage,
            assistantMessage: undefined,
            transport: "llm",
            model: turnResult.assistantModel,
            turnId,
            trace: {
              ...traceWithMeta,
              citations: dedupedTurnCitations,
              toolRuns: this.storage.chatToolRuns.listByTurn(turnId),
            },
            citations: dedupedTurnCitations,
            routing: turnResult.turnTrace.routing,
          };
        }

        const assistantText = turnResult.assistantContent.trim().length > 0
          ? turnResult.assistantContent
          : buildEmptyAssistantTurnFallbackText();
        const assistantUsage = turnResult.usage;
        const assistantEventId = prepared.assistantMessageId;
        await this.ingestEvent(randomUUID(), {
          eventId: assistantEventId,
          route: prepared.route,
          actor: {
            type: "agent",
            id: "assistant",
          },
          message: {
            role: "assistant",
            content: assistantText,
          },
          usage: assistantUsage,
        });
        const assistantMessage: ChatMessageRecord = {
          messageId: assistantEventId,
          sessionId,
          role: "assistant",
          actorType: "agent",
          actorId: "assistant",
          content: assistantText,
          timestamp: new Date().toISOString(),
        };
        const finalTraceStatus = turnResult.turnTrace.status === "failed" ? "failed" : "completed";
        const trace = this.storage.chatTurnTraces.patch(turnId, {
          assistantMessageId: assistantEventId,
          status: finalTraceStatus,
          finishedAt: new Date().toISOString(),
          retrieval: prepared.retrievalTrace,
          reflection: reflectionTrace,
          proactive: {
            runId: prepared.autonomy.lastProactiveRunId,
            mode: prepared.autonomy.proactiveMode,
          },
          guidance: {
            workspaceId: prepared.workspaceId,
            globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
            workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
            truncated: prepared.resolvedGuidance.truncated,
          },
          citations: dedupedTurnCitations,
          failure: persistedTurnFailure,
        });
        let hydratedTrace: ChatTurnTraceRecord = {
          ...trace,
          citations: dedupedTurnCitations,
          toolRuns: this.storage.chatToolRuns.listByTurn(turnId),
        };
        const capabilityUpgradeSuggestions = await this.collectCapabilityUpgradeSuggestions({
          sessionId,
          content: prepared.content,
          assistantText,
          trace: hydratedTrace,
        });
        const specialistCandidateSuggestions = this.collectSpecialistCandidateSuggestions({
          sessionId,
          mode: prepared.normalized.mode ?? prepared.prefs.mode,
          content: prepared.content,
          capabilitySuggestions: capabilityUpgradeSuggestions,
          trace: hydratedTrace,
        });
        if (capabilityUpgradeSuggestions.length > 0 || specialistCandidateSuggestions.length > 0) {
          hydratedTrace = this.storage.chatTurnTraces.patch(turnId, {
            capabilityUpgradeSuggestions: capabilityUpgradeSuggestions.length > 0 ? capabilityUpgradeSuggestions : [],
            specialistCandidateSuggestions: specialistCandidateSuggestions.length > 0 ? specialistCandidateSuggestions : [],
          });
          hydratedTrace = {
            ...hydratedTrace,
            toolRuns: this.storage.chatToolRuns.listByTurn(turnId),
          };
        }

        this.extractAndPersistLearnedMemory(sessionId, prepared.content, {
          role: "user",
          sourceRef: prepared.userEventId,
          trace: hydratedTrace,
        });
        this.extractAndPersistLearnedMemory(sessionId, assistantText, {
          role: "assistant",
          sourceRef: assistantEventId,
          trace: hydratedTrace,
        });
        this.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
        this.publishRealtime("chat_thread_updated", "chat", {
          type: "chat_thread_turn_appended",
          sessionId,
          turnId,
          activeLeafTurnId: turnId,
        });
        const delegationDetection = detectDelegationRoles(prepared.content);
        if (prepared.prefs.planningMode !== "advisory" && delegationDetection.length > 1) {
          await this.triggerChatSessionProactive(sessionId, {
            source: "chat",
            reason: "Detected multi-role phrasing; generated delegation suggestion.",
          });
        }

        return {
          sessionId,
          userMessage: prepared.userMessage,
          assistantMessage,
          transport: "llm",
          model: turnResult.assistantModel,
          turnId,
          trace: hydratedTrace,
          citations: hydratedTrace.citations,
          routing: hydratedTrace.routing,
        };
      } finally {
        this.endActiveChatTurnExecution(prepared.turnId, controller);
      }
    });
  }

  public async *agentSendChatMessageStream(
    sessionId: string,
    input: ChatSendMessageRequest,
  ): AsyncGenerator<ChatStreamChunk> {
    yield* this.withChatTurnWriteLeaseStream(sessionId, "agent-send/stream", () => {
      const self = this;
      return (async function* (): AsyncGenerator<ChatStreamChunk> {
        self.recordDevDiagnostic({
          level: "info",
          category: "chat",
          event: "chat.stream.start",
          message: "Starting streamed mission chat turn",
          sessionId,
          providerId: input.providerId,
          modelId: input.model,
          context: {
            mode: input.mode,
            webMode: input.webMode,
            thinkingLevel: input.thinkingLevel,
          },
        });
        const prepared = await self.prepareAgentChatTurn(sessionId, input, {
          branchKind: "append",
        });
        const binding = self.storage.chatSessionBindings.get(sessionId)
          ?? self.storage.chatSessionBindings.upsert({
            sessionId,
            workspaceId: prepared.workspaceId,
            transport: "llm",
            writable: true,
          });
        if (binding.transport !== "llm") {
          yield* self.withEphemeralStreamEnvelope(
            self.streamPreparedIntegrationChatTurn(
              sessionId,
              prepared,
              binding,
              "chat_thread_turn_appended",
            ),
          );
          return;
        }
        self.launchPreparedAgentChatTurnStream(sessionId, input, prepared, "chat_thread_turn_appended");
        yield* self.streamPersistedChatTurnEvents(sessionId, prepared.turnId, { liveTail: true });
      })();
    });
  }

  public async retryChatTurn(
    sessionId: string,
    turnId: string,
    overrides: Partial<ChatSendMessageRequest> = {},
  ): Promise<ChatSendMessageResponse> {
    return this.withChatTurnWriteLease(sessionId, "retry-turn", async () => {
      const current = await this.requireChatTurnContext(sessionId, turnId);
      const request: ChatSendMessageRequest = {
        content: current.userMessage.content,
        attachments: current.userMessage.attachments?.map((item) => item.attachmentId),
        providerId: overrides.providerId,
        model: overrides.model,
        useMemory: overrides.useMemory,
        mode: overrides.mode,
        webMode: overrides.webMode,
        memoryMode: overrides.memoryMode,
        thinkingLevel: overrides.thinkingLevel,
        commandText: overrides.commandText,
        prefsOverride: overrides.prefsOverride,
      };
      const prepared = await this.prepareAgentChatTurn(sessionId, request, {
        branchKind: "retry",
        sourceTurnId: turnId,
        parentTurnId: current.trace.parentTurnId,
        existingUserMessage: current.userMessage,
        ingestUserMessage: false,
      });
      const binding = this.storage.chatSessionBindings.get(sessionId)
        ?? this.storage.chatSessionBindings.upsert({
          sessionId,
          workspaceId: prepared.workspaceId,
          transport: "llm",
          writable: true,
        });
      if (binding.transport !== "llm") {
        return this.sendPreparedIntegrationChatTurn(sessionId, prepared, binding, "chat_thread_turn_retried");
      }
      return this.consumePreparedAgentChatTurn(sessionId, request, prepared, "chat_thread_turn_retried");
    });
  }

  public async *retryChatTurnStream(
    sessionId: string,
    turnId: string,
    overrides: Partial<ChatSendMessageRequest> = {},
  ): AsyncGenerator<ChatStreamChunk> {
    yield* this.withChatTurnWriteLeaseStream(sessionId, "retry-turn/stream", () => {
      const self = this;
      return (async function* (): AsyncGenerator<ChatStreamChunk> {
        const current = await self.requireChatTurnContext(sessionId, turnId);
        const request: ChatSendMessageRequest = {
          content: current.userMessage.content,
          attachments: current.userMessage.attachments?.map((item) => item.attachmentId),
          providerId: overrides.providerId,
          model: overrides.model,
          useMemory: overrides.useMemory,
          mode: overrides.mode,
          webMode: overrides.webMode,
          memoryMode: overrides.memoryMode,
          thinkingLevel: overrides.thinkingLevel,
          commandText: overrides.commandText,
          prefsOverride: overrides.prefsOverride,
        };
        const prepared = await self.prepareAgentChatTurn(sessionId, request, {
          branchKind: "retry",
          sourceTurnId: turnId,
          parentTurnId: current.trace.parentTurnId,
          existingUserMessage: current.userMessage,
          ingestUserMessage: false,
        });
        const binding = self.storage.chatSessionBindings.get(sessionId)
          ?? self.storage.chatSessionBindings.upsert({
            sessionId,
            workspaceId: prepared.workspaceId,
            transport: "llm",
            writable: true,
          });
        if (binding.transport !== "llm") {
          yield* self.withEphemeralStreamEnvelope(
            self.streamPreparedIntegrationChatTurn(sessionId, prepared, binding, "chat_thread_turn_retried"),
          );
          return;
        }
        self.launchPreparedAgentChatTurnStream(sessionId, request, prepared, "chat_thread_turn_retried");
        yield* self.streamPersistedChatTurnEvents(sessionId, prepared.turnId, { liveTail: true });
      })();
    });
  }

  public async editChatTurn(
    sessionId: string,
    turnId: string,
    input: ChatSendMessageRequest,
  ): Promise<ChatSendMessageResponse> {
    return this.withChatTurnWriteLease(sessionId, "edit-turn", async () => {
      const current = await this.requireChatTurnContext(sessionId, turnId);
      const request: ChatSendMessageRequest = {
        ...input,
        attachments: input.attachments ?? current.userMessage.attachments?.map((item) => item.attachmentId),
      };
      const prepared = await this.prepareAgentChatTurn(sessionId, request, {
        branchKind: "edit",
        sourceTurnId: turnId,
        parentTurnId: current.trace.parentTurnId,
      });
      const binding = this.storage.chatSessionBindings.get(sessionId)
        ?? this.storage.chatSessionBindings.upsert({
          sessionId,
          workspaceId: prepared.workspaceId,
          transport: "llm",
          writable: true,
        });
      if (binding.transport !== "llm") {
        return this.sendPreparedIntegrationChatTurn(sessionId, prepared, binding, "chat_thread_turn_edited");
      }
      return this.consumePreparedAgentChatTurn(sessionId, request, prepared, "chat_thread_turn_edited");
    });
  }

  public async *editChatTurnStream(
    sessionId: string,
    turnId: string,
    input: ChatSendMessageRequest,
  ): AsyncGenerator<ChatStreamChunk> {
    yield* this.withChatTurnWriteLeaseStream(sessionId, "edit-turn/stream", () => {
      const self = this;
      return (async function* (): AsyncGenerator<ChatStreamChunk> {
        const current = await self.requireChatTurnContext(sessionId, turnId);
        const request: ChatSendMessageRequest = {
          ...input,
          attachments: input.attachments ?? current.userMessage.attachments?.map((item) => item.attachmentId),
        };
        const prepared = await self.prepareAgentChatTurn(sessionId, request, {
          branchKind: "edit",
          sourceTurnId: turnId,
          parentTurnId: current.trace.parentTurnId,
        });
        const binding = self.storage.chatSessionBindings.get(sessionId)
          ?? self.storage.chatSessionBindings.upsert({
            sessionId,
            workspaceId: prepared.workspaceId,
            transport: "llm",
            writable: true,
          });
        if (binding.transport !== "llm") {
          yield* self.withEphemeralStreamEnvelope(
            self.streamPreparedIntegrationChatTurn(sessionId, prepared, binding, "chat_thread_turn_edited"),
          );
          return;
        }
        self.launchPreparedAgentChatTurnStream(sessionId, request, prepared, "chat_thread_turn_edited");
        yield* self.streamPersistedChatTurnEvents(sessionId, prepared.turnId, { liveTail: true });
      })();
    });
  }

  public async cancelChatTurn(
    sessionId: string,
    turnId: string,
    cancelledBy?: string,
  ): Promise<ChatCancelTurnResponse> {
    const current = this.storage.chatTurnTraces.get(turnId);
    if (current.sessionId !== sessionId) {
      throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
    }
    const active = this.activeChatTurns.get(turnId);
    if (active?.sessionId === sessionId && !active.controller.signal.aborted) {
      active.controller.abort(new ChatTurnCancelledError(turnId));
    }
    const trace = this.markChatTurnCancelled(sessionId, turnId, cancelledBy);
    return {
      sessionId,
      turnId,
      cancelled: trace.status === "cancelled",
      trace,
    };
  }

  private async collectCapabilityUpgradeSuggestions(input: {
    sessionId: string;
    content: string;
    assistantText: string;
    trace?: ChatTurnTraceRecord;
  }): Promise<ChatCapabilityUpgradeSuggestion[]> {
    return scoutCapabilityUpgradeSuggestions({
      ...input,
      deps: {
        listToolCatalog: () => this.listToolCatalog(),
        evaluateToolAccess: (request) => this.evaluateToolAccess(request),
        listSkills: () => this.listSkills(),
        resolveSkillActivation: (request) => this.resolveSkillActivation(request),
        listSkillSources: (query, limit) => this.listSkillSources(query, limit),
        listMcpTemplates: () => this.listMcpTemplates(),
        listMcpTemplateDiscovery: () => {
          try {
            return this.listMcpTemplateDiscovery();
          } catch {
            return [];
          }
        },
      },
    });
  }

  private async consumePreparedAgentChatTurn(
    sessionId: string,
    input: ChatSendMessageRequest,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
    resolvedOrchestration?: PreparedChatExecutionPlanResolution,
  ): Promise<ChatSendMessageResponse> {
    let assistantMessage: ChatMessageRecord | undefined;
    let trace: ChatTurnTraceRecord | undefined;
    let citations: ChatCitationRecord[] = [];
    const useDurableExecution = this.shouldUseDurableExecution(prepared, input);
    if (useDurableExecution) {
      this.launchPreparedAgentChatTurnStream(sessionId, input, prepared, threadEventType, resolvedOrchestration);
    }
    const source: AsyncGenerator<InspectableChatStreamChunk> = useDurableExecution
      ? this.streamPersistedChatTurnEvents(sessionId, prepared.turnId, { liveTail: true })
      : this.streamPreparedAgentChatTurn(
        sessionId,
        input,
        prepared,
        threadEventType,
        resolvedOrchestration,
      );
    for await (const chunk of source) {
      if (chunk.type === "message_done") {
        assistantMessage = {
          messageId: chunk.messageId,
          sessionId,
          role: "assistant",
          actorType: "agent",
          actorId: "assistant",
          content: chunk.content,
          timestamp: new Date().toISOString(),
        };
      } else if (chunk.type === "trace_update") {
        trace = chunk.trace;
      } else if (chunk.type === "citation") {
        citations = dedupeChatCitations([...citations, chunk.citation]);
      }
    }
    const dedupedTraceCitations = dedupeChatCitations(trace?.citations ?? []);
    return {
      sessionId,
      userMessage: prepared.userMessage,
      assistantMessage,
      transport: "llm",
      model: trace?.model ?? input.model ?? prepared.prefs.model,
      turnId: prepared.turnId,
      trace: trace ? { ...trace, citations: dedupedTraceCitations } : trace,
      citations: dedupeChatCitations(citations),
      routing: trace?.routing,
    };
  }

  private isDurableExecutionEnabled(): boolean {
    return this.config.assistant.durable.enabled
      && this.config.assistant.durable.executionEnabled
      && this.isFeatureEnabled("durableKernelV1Enabled");
  }

  private shouldUseDurableExecution(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    input: ChatSendMessageRequest,
  ): boolean {
    if (!this.isDurableExecutionEnabled()) {
      return false;
    }
    const mode = prepared.normalized.mode ?? prepared.prefs.mode;
    if (mode === "cowork" || mode === "code") {
      return true;
    }
    if (mode !== "chat" || !this.config.assistant.durable.chatAutoPromoteEnabled) {
      return false;
    }
    const webMode = prepared.normalized.webMode ?? prepared.prefs.webMode;
    if (webMode === "deep") {
      return true;
    }
    if (prepared.autonomy.reflectionMode === "on" || prepared.prefs.reflectionMode === "on") {
      return true;
    }
    const content = prepared.content.toLowerCase();
    return content.includes("http://")
      || content.includes("https://")
      || content.includes("browser.navigate")
      || content.includes("browser.extract")
      || content.includes("http.get")
      || content.includes("http.post")
      || /\b(fetch|scrape|extract|browse|navigate|research|look up|find on the web|http get|http post)\b/i.test(content)
      || Boolean(input.attachments?.length);
  }

  private parseDurableChatTurnPayload(run: DurableRunRecord): DurableChatTurnExecutionPayload | undefined {
    const payload = run.payload as Partial<DurableChatTurnExecutionPayload> | undefined;
    if (!payload || payload.version !== "chat.turn.execute.v1") {
      return undefined;
    }
    if (
      typeof payload.sessionId !== "string"
      || typeof payload.turnId !== "string"
      || typeof payload.userMessageId !== "string"
      || typeof payload.assistantMessageId !== "string"
      || typeof payload.branchKind !== "string"
      || typeof payload.threadEventType !== "string"
      || !payload.request
      || typeof payload.request !== "object"
    ) {
      return undefined;
    }
    return payload as DurableChatTurnExecutionPayload;
  }

  private parseApprovalWaitWorkflowPayload(run: DurableRunRecord): ApprovalWaitWorkflowPayload | undefined {
    const payload = run.payload as Partial<ApprovalWaitWorkflowPayload> | undefined;
    if (!payload || payload.version !== "approval.wait.v1") {
      return undefined;
    }
    if (
      typeof payload.approvalId !== "string"
      || typeof payload.approvalKind !== "string"
      || typeof payload.createdAt !== "string"
    ) {
      return undefined;
    }
    return payload as ApprovalWaitWorkflowPayload;
  }

  private parseConnectorDeliveryWorkflowPayload(run: DurableRunRecord): ConnectorDeliveryWorkflowPayload | undefined {
    const payload = run.payload as Partial<ConnectorDeliveryWorkflowPayload> | undefined;
    if (!payload || payload.version !== "connector.delivery.v1") {
      return undefined;
    }
    if (
      typeof payload.connectorId !== "string"
      || typeof payload.action !== "string"
    ) {
      return undefined;
    }
    if (
      payload.payload !== undefined
      && (typeof payload.payload !== "object" || Array.isArray(payload.payload))
    ) {
      return undefined;
    }
    return payload as ConnectorDeliveryWorkflowPayload;
  }

  private createDurableChatTurnPayload(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    input: ChatSendMessageRequest,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  ): DurableChatTurnExecutionPayload {
    return {
      version: "chat.turn.execute.v1",
      sessionId: prepared.session.sessionId,
      turnId: prepared.turnId,
      userMessageId: prepared.userEventId,
      assistantMessageId: prepared.assistantMessageId,
      branchKind: prepared.branchKind,
      parentTurnId: prepared.parentTurnId,
      sourceTurnId: prepared.sourceTurnId,
      threadEventType,
      request: {
        ...input,
        content: prepared.content,
        attachments: prepared.userMessage.attachments?.map((item) => item.attachmentId),
      },
    };
  }

  private createDurableCheckpointState(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    trace: ChatTurnTraceRecord,
  ): Record<string, unknown> {
    const toolRuns = this.storage.chatToolRuns.listByTurn(prepared.turnId);
    const artifacts = this.storage.chatToolArtifacts.listByTurn(prepared.turnId).map((artifact) => ({
      artifactId: artifact.artifactId,
      toolRunId: artifact.toolRunId,
      toolName: artifact.toolName,
      contentType: artifact.contentType,
      byteLength: artifact.byteLength,
      storageRelPath: artifact.storageRelPath,
      snippet: artifact.snippet,
    }));
    return {
      objective: prepared.content,
      currentStep: trace.status,
      attemptedTools: toolRuns.map((run) => ({
        toolRunId: run.toolRunId,
        toolName: run.toolName,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      })),
      artifactPointers: artifacts,
      blocker: trace.failure?.message,
      nextAction: trace.failure?.recommendedAction,
    };
  }

  private beginDurableChatRun(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    input: ChatSendMessageRequest,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  ): DurableRunRecord | undefined {
    if (!this.shouldUseDurableExecution(prepared, input)) {
      return undefined;
    }
    const mode = prepared.normalized.mode ?? prepared.prefs.mode;
    const run = this.createDurableRun({
      workflowKey: "chat.turn.execute",
      payload: this.createDurableChatTurnPayload(prepared, input, threadEventType) as unknown as Record<string, unknown>,
      metadata: {
        surface: mode,
        autoPromoted: mode === "chat",
        objective: prepared.content,
      },
    });
    this.persistChatStreamChunk({
      type: "message_start",
      sessionId: prepared.session.sessionId,
      turnId: prepared.turnId,
      messageId: prepared.assistantMessageId,
      parentTurnId: prepared.parentTurnId,
      branchKind: prepared.branchKind,
      sourceTurnId: prepared.sourceTurnId,
    }, run.runId);
    this.durableRunService.requestRunProcessing(run.runId);
    return run;
  }

  private finalizeDurableChatRun(
    runId: string,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    trace: ChatTurnTraceRecord,
  ): void {
    const now = new Date().toISOString();
    const checkpointState = this.createDurableCheckpointState(prepared, trace);
    if (trace.status === "waiting_for_approval") {
      this.storage.durableRuns.updateRun({
        runId,
        status: "waiting",
        updatedAt: now,
        finishedAt: undefined,
      });
      this.storage.durableRuns.createCheckpoint({
        runId,
        checkpointKind: "run_waiting",
        state: checkpointState,
      });
      this.recordDurableTimelineEvent(runId, "run_waiting", checkpointState);
      this.patchDurableTraceIfPresent(prepared.turnId, {
        durable: {
          runId,
          status: "waiting",
          checkpointKind: "run_waiting",
        },
      });
      return;
    }
    if (trace.status === "cancelled") {
      this.storage.durableRuns.updateRun({
        runId,
        status: "cancelled",
        updatedAt: now,
        finishedAt: now,
      });
      this.recordDurableTimelineEvent(runId, "run_cancelled", checkpointState);
      this.patchDurableTraceIfPresent(prepared.turnId, {
        durable: {
          runId,
          status: "cancelled",
          checkpointKind: "run_failed",
        },
      });
      return;
    }
    const failed = trace.status === "failed" || trace.completion?.status !== "complete";
    const nextStatus: DurableRunStatus = failed ? "failed" : "completed";
    const checkpointKind: DurableCheckpointRecord["checkpointKind"] = failed ? "run_failed" : "run_completed";
    this.storage.durableRuns.updateRun({
      runId,
      status: nextStatus,
      updatedAt: now,
      finishedAt: now,
      lastError: failed ? trace.failure?.message : undefined,
    });
    this.storage.durableRuns.createCheckpoint({
      runId,
      checkpointKind,
      state: checkpointState,
    });
    this.recordDurableTimelineEvent(runId, failed ? "run_failed" : "run_completed", checkpointState);
    this.patchDurableTraceIfPresent(prepared.turnId, {
      durable: {
        runId,
        status: nextStatus,
        checkpointKind,
      },
    });
  }

  private patchDurableTraceIfPresent(turnId: string, input: Parameters<Storage["chatTurnTraces"]["patch"]>[1]): void {
    try {
      this.storage.chatTurnTraces.patch(turnId, input);
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }
  }

  private async executePreparedAgentChatTurnBackground(
    sessionId: string,
    input: ChatSendMessageRequest,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
    durableRunId?: string,
    resolvedOrchestration?: PreparedChatExecutionPlanResolution,
    options?: {
      skipMessageStart?: boolean;
    },
  ): Promise<void> {
    try {
      for await (const rawChunk of this.streamPreparedAgentChatTurn(
        sessionId,
        input,
        prepared,
        threadEventType,
        resolvedOrchestration,
        options,
      )) {
        const chunk = rawChunk.type === "trace_update" && durableRunId
          ? {
            ...rawChunk,
            trace: {
              ...rawChunk.trace,
              durable: {
                runId: durableRunId,
                status: this.storage.durableRuns.getRun(durableRunId).status,
                checkpointKind: rawChunk.trace.durable?.checkpointKind ?? "run_started",
              },
            },
          }
          : rawChunk;
        if (isPersistableChatStreamChunk(chunk)) {
          this.persistChatStreamChunk(chunk, durableRunId);
        }
      }
    } catch (error) {
      let currentTrace: ChatTurnTraceRecord | undefined;
      try {
        currentTrace = this.storage.chatTurnTraces.get(prepared.turnId);
      } catch (lookupError) {
        if (!(lookupError instanceof NotFoundError)) {
          throw lookupError;
        }
      }
      if (currentTrace) {
        const patchedTrace = this.storage.chatTurnTraces.patch(prepared.turnId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          failure: {
            failureClass: "unknown",
            message: error instanceof Error ? error.message : "Chat stream execution failed.",
            retryable: true,
            recommendedAction: "retry",
          },
          completion: {
            finishReason: currentTrace.completion?.finishReason,
            status: "interrupted",
            repaired: Boolean(currentTrace.completion?.repaired),
          },
        });
        this.persistChatStreamChunk({
          type: "trace_update",
          sessionId,
          turnId: prepared.turnId,
          trace: this.createHydratedChatTurnTrace(prepared.turnId, patchedTrace),
        }, durableRunId);
      }
      this.persistChatStreamChunk({
        type: "error",
        sessionId,
        turnId: prepared.turnId,
        error: error instanceof Error ? error.message : "Chat stream execution failed.",
      }, durableRunId);
    } finally {
      let finalTrace: ChatTurnTraceRecord | undefined;
      try {
        finalTrace = this.storage.chatTurnTraces.get(prepared.turnId);
      } catch (error) {
        if (!(error instanceof NotFoundError)) {
          throw error;
        }
      }
      if (durableRunId && finalTrace) {
        this.finalizeDurableChatRun(durableRunId, prepared, finalTrace);
      }
      this.completeActiveChatTurnStream(prepared.turnId);
      setTimeout(() => this.closeActiveChatTurnStream(prepared.turnId), 30_000);
    }
  }

  private launchPreparedAgentChatTurnStream(
    sessionId: string,
    input: ChatSendMessageRequest,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
    resolvedOrchestration?: PreparedChatExecutionPlanResolution,
  ): void {
    const durableRun = this.beginDurableChatRun(prepared, input, threadEventType);
    this.registerActiveChatTurnStream(sessionId, prepared.turnId, durableRun?.runId);
    if (durableRun) {
      return;
    }
    const task = this.executePreparedAgentChatTurnBackground(
      sessionId,
      input,
      prepared,
      threadEventType,
      undefined,
      resolvedOrchestration,
    );
    task.finally(() => this.backgroundTasks.delete(task));
    this.backgroundTasks.add(task);
  }

  private async executeDurableWorkflowRun(run: DurableRunRecord): Promise<void> {
    switch (run.workflowKey) {
      case "chat.turn.execute":
        await this.executeDurableChatTurnRun(run);
        return;
      case "approval.wait":
        await this.executeDurableApprovalWaitRun(run);
        return;
      case "connector.delivery":
        await this.executeDurableConnectorDeliveryRun(run);
        return;
      default:
        throw new Error(`Unsupported durable workflow: ${run.workflowKey}`);
    }
  }

  private isDurableWorkflowRecoverable(run: DurableRunRecord): { recoverable: boolean; reason?: string } {
    switch (run.workflowKey) {
      case "chat.turn.execute":
        break;
      case "approval.wait":
        return this.parseApprovalWaitWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable approval wait payload is invalid or incomplete." };
      case "connector.delivery":
        return this.parseConnectorDeliveryWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable connector delivery payload is invalid or incomplete." };
      default:
        return { recoverable: false, reason: `Unsupported durable workflow: ${run.workflowKey}` };
    }
    const payload = this.parseDurableChatTurnPayload(run);
    if (!payload) {
      return { recoverable: false, reason: "Durable chat run payload is invalid or incomplete." };
    }
    let trace: ChatTurnTraceRecord | undefined;
    try {
      trace = this.storage.chatTurnTraces.get(payload.turnId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }
    if (!trace) {
      return { recoverable: true };
    }
    if (trace.assistantMessageId) {
      return { recoverable: false, reason: "Assistant output was already persisted before interruption." };
    }
    const toolRuns = this.storage.chatToolRuns.listByTurn(payload.turnId);
    if (toolRuns.length > 0) {
      return {
        recoverable: false,
        reason: "Durable chat run was interrupted after tool execution began and cannot be safely replayed.",
      };
    }
    return { recoverable: true };
  }

  private async markDurableWorkflowUnrecoverable(run: DurableRunRecord, reason: string): Promise<void> {
    if (run.workflowKey === "approval.wait" || run.workflowKey === "connector.delivery") {
      this.publishRealtime("system", "durable", {
        type: "durable_workflow_unrecoverable",
        runId: run.runId,
        workflowKey: run.workflowKey,
        reason,
      });
      return;
    }
    const payload = this.parseDurableChatTurnPayload(run);
    if (!payload) {
      return;
    }
    let trace: ChatTurnTraceRecord | undefined;
    try {
      trace = this.storage.chatTurnTraces.get(payload.turnId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }
    if (trace) {
      this.storage.chatTurnTraces.patch(payload.turnId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        failure: {
          failureClass: "unknown",
          message: reason,
          retryable: true,
          recommendedAction: "retry",
        },
        completion: {
          finishReason: trace.completion?.finishReason,
          status: "interrupted",
          repaired: Boolean(trace.completion?.repaired),
        },
        durable: {
          runId: run.runId,
          status: "failed",
          checkpointKind: "run_failed",
        },
      });
    }
    this.persistChatStreamChunk({
      type: "error",
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      error: reason,
    }, run.runId);
  }

  private async executeDurableApprovalWaitRun(run: DurableRunRecord): Promise<void> {
    const payload = this.parseApprovalWaitWorkflowPayload(run);
    if (!payload) {
      throw new Error("Durable approval wait payload is invalid or incomplete.");
    }
    const approval = this.storage.approvals.get(payload.approvalId);
    if (approval.status === "pending") {
      throw new ConflictError({
        message: `Approval ${payload.approvalId} is still pending and cannot complete its durable wait workflow.`,
      });
    }
    const checkpointState = {
      approvalId: approval.approvalId,
      approvalKind: approval.kind,
      status: approval.status,
      resolvedAt: approval.resolvedAt,
      resolvedBy: approval.resolvedBy,
    };
    await this.storage.audit.append("approvals", {
      event: "durable.approval_wait.complete",
      runId: run.runId,
      workflowKey: run.workflowKey,
      ...checkpointState,
    });
    this.completeDurableWorkflowRun(run.runId, checkpointState);
  }

  private async executeDurableConnectorDeliveryRun(run: DurableRunRecord): Promise<void> {
    const payload = this.parseConnectorDeliveryWorkflowPayload(run);
    if (!payload) {
      throw new Error("Durable connector delivery payload is invalid or incomplete.");
    }
    const connector = this.requireConnectorRecord(payload.connectorId);
    if (payload.simulateFailureReason?.trim()) {
      throw new Error(payload.simulateFailureReason.trim());
    }
    const dispatch = await dispatchConnectorDelivery(connector, payload, {
      commsSend: (input) => this.commsSend(input),
      invokeMcpTool: (input) => this.invokeMcpTool(input),
      publishRealtime: (eventType, source, eventPayload) => this.publishRealtime(eventType, source, eventPayload),
    });
    const checkpointState = {
      connectorId: connector.connectorId,
      connectorType: connector.connectorType,
      action: payload.action,
      capabilityId: dispatch.capabilityId,
      dispatchKind: dispatch.dispatchKind,
      result: dispatch.result ?? null,
    };
    this.publishRealtime("connector_delivery_completed", "connectors", {
      runId: run.runId,
      ...checkpointState,
    });
    this.completeDurableWorkflowRun(run.runId, checkpointState);
  }

  private async executeDurableChatTurnRun(run: DurableRunRecord): Promise<void> {
    const payload = this.parseDurableChatTurnPayload(run);
    if (!payload) {
      throw new Error("Durable chat run payload is invalid or incomplete.");
    }
    const userMessage = this.storage.chatMessages.get(payload.userMessageId);
    if (!userMessage) {
      throw new NotFoundError({ entity: "Chat message", id: payload.userMessageId });
    }
    const prepared = await this.prepareAgentChatTurn(payload.sessionId, payload.request, {
      branchKind: payload.branchKind,
      sourceTurnId: payload.sourceTurnId,
      parentTurnId: payload.parentTurnId,
      existingUserMessage: userMessage,
      ingestUserMessage: false,
      turnId: payload.turnId,
      assistantMessageId: payload.assistantMessageId,
    });
    this.registerActiveChatTurnStream(payload.sessionId, payload.turnId, run.runId);
    await this.executePreparedAgentChatTurnBackground(
      payload.sessionId,
      payload.request,
      prepared,
      payload.threadEventType,
      run.runId,
      undefined,
      { skipMessageStart: true },
    );
  }

  private completeDurableWorkflowRun(runId: string, checkpointState: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.storage.durableRuns.updateRun({
      runId,
      status: "completed",
      updatedAt: now,
      finishedAt: now,
      lastError: undefined,
    });
    this.storage.durableRuns.createCheckpoint({
      runId,
      checkpointKind: "run_completed",
      state: checkpointState,
      createdAt: now,
    });
    this.recordDurableTimelineEvent(runId, "run_completed", checkpointState);
    this.publishRealtime("system", "durable", {
      type: "durable_run_completed",
      runId,
      checkpoint: checkpointState,
    });
  }

  public async *resumeAgentChatTurnStream(
    sessionId: string,
    turnId: string,
    sinceEventId?: string,
  ): AsyncGenerator<ChatStreamChunk> {
    yield* this.streamPersistedChatTurnEvents(sessionId, turnId, {
      sinceEventId,
      liveTail: true,
    });
  }

  private async sendPreparedIntegrationChatTurn(
    sessionId: string,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    binding: ChatSessionBindingRecord,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  ): Promise<ChatSendMessageResponse> {
    const startedAt = new Date().toISOString();
    this.storage.chatTurnTraces.create({
      turnId: prepared.turnId,
      sessionId,
      userMessageId: prepared.userEventId,
      parentTurnId: prepared.parentTurnId,
      branchKind: prepared.branchKind,
      sourceTurnId: prepared.sourceTurnId,
      status: "running",
      mode: prepared.normalized.mode ?? prepared.prefs.mode,
      webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
      memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
      thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
      effectiveToolAutonomy: prepared.effectiveToolAutonomy,
      routing: {},
      startedAt,
    });

    try {
      if (!binding.connectionId || !binding.target) {
        throw new Error("Integration binding is missing connectionId or target");
      }
      if (!binding.writable) {
        throw new Error("Session binding is not writable");
      }
      const delivery = await this.commsSend({
        connectionId: binding.connectionId,
        target: binding.target,
        message: prepared.content,
        sessionId,
        agentId: "operator",
      });
      const assistantContent = typeof delivery === "object"
        ? `Delivered via integration ${binding.connectionId} to ${binding.target}.`
        : "Delivered via integration.";
      const assistantMessageId = prepared.assistantMessageId;
      await this.ingestEvent(randomUUID(), {
        eventId: assistantMessageId,
        route: prepared.route,
        actor: {
          type: "system",
          id: "integration",
        },
        message: {
          role: "assistant",
          content: assistantContent,
        },
      });
      const assistantMessage: ChatMessageRecord = {
        messageId: assistantMessageId,
        sessionId,
        role: "assistant",
        actorType: "system",
        actorId: "integration",
        content: assistantContent,
        timestamp: new Date().toISOString(),
      };
      const trace = this.storage.chatTurnTraces.patch(prepared.turnId, {
        assistantMessageId,
        status: "completed",
        finishedAt: new Date().toISOString(),
        retrieval: prepared.retrievalTrace,
        reflection: {
          attempted: false,
          attemptCount: 0,
          outcome: "not_needed",
        },
        proactive: {
          runId: prepared.autonomy.lastProactiveRunId,
          mode: prepared.autonomy.proactiveMode,
        },
        guidance: {
          workspaceId: prepared.workspaceId,
          globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
          workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
          truncated: prepared.resolvedGuidance.truncated,
        },
        citations: [],
      });
      const hydratedTrace: ChatTurnTraceRecord = {
        ...trace,
        toolRuns: [],
        citations: [],
      };
      this.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, prepared.turnId);
      this.publishRealtime("chat_thread_updated", "chat", {
        type: threadEventType,
        sessionId,
        turnId: prepared.turnId,
        activeLeafTurnId: prepared.turnId,
      });
      return {
        sessionId,
        userMessage: prepared.userMessage,
        assistantMessage,
        transport: "integration",
        turnId: prepared.turnId,
        trace: hydratedTrace,
        citations: [],
        routing: hydratedTrace.routing,
      };
    } catch (error) {
      this.storage.chatTurnTraces.patch(prepared.turnId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        retrieval: prepared.retrievalTrace,
        reflection: {
          attempted: false,
          attemptCount: 0,
          outcome: "not_needed",
        },
        proactive: {
          runId: prepared.autonomy.lastProactiveRunId,
          mode: prepared.autonomy.proactiveMode,
        },
        guidance: {
          workspaceId: prepared.workspaceId,
          globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
          workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
          truncated: prepared.resolvedGuidance.truncated,
        },
        citations: [],
      });
      throw error;
    }
  }

  private async *streamPreparedIntegrationChatTurn(
    sessionId: string,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    binding: ChatSessionBindingRecord,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  ): AsyncGenerator<ChatStreamChunkDraft> {
    yield {
      type: "message_start",
      sessionId,
      turnId: prepared.turnId,
      messageId: prepared.assistantMessageId,
      parentTurnId: prepared.parentTurnId,
      branchKind: prepared.branchKind,
      sourceTurnId: prepared.sourceTurnId,
    };
    const response = await this.sendPreparedIntegrationChatTurn(sessionId, prepared, binding, threadEventType);
    const content = response.assistantMessage?.content ?? "";
    for (const delta of splitIntoChunks(content, 120)) {
      yield {
        type: "delta",
        sessionId,
        turnId: prepared.turnId,
        messageId: prepared.assistantMessageId,
        delta,
      };
    }
    yield {
      type: "message_done",
      sessionId,
      turnId: prepared.turnId,
      messageId: prepared.assistantMessageId,
      content,
    };
    yield {
      type: "trace_update",
      sessionId,
      turnId: prepared.turnId,
      trace: response.trace!,
    };
    yield {
      type: "done",
      sessionId,
      turnId: prepared.turnId,
      messageId: prepared.assistantMessageId,
    };
  }

  public async uploadChatAttachment(input: {
    sessionId: string;
    projectId?: string;
    fileName: string;
    mimeType: string;
    bytesBase64: string;
  }): Promise<ChatAttachmentRecord> {
    this.getSession(input.sessionId);
    const sessionMeta = this.storage.chatSessionMeta.ensure(input.sessionId);
    const sessionWorkspaceId = this.normalizeWorkspaceId(sessionMeta.workspaceId);
    const fileName = sanitizeAttachmentFileName(input.fileName);
    const mimeType = input.mimeType.trim() || "application/octet-stream";
    const bytes = Buffer.from(input.bytesBase64, "base64");
    if (bytes.length === 0) {
      throw new Error("Attachment payload is empty");
    }
    if (bytes.length > 20 * 1024 * 1024) {
      throw new Error("Attachment exceeds 20MB upload limit");
    }

    let projectId = input.projectId;
    if (!projectId) {
      projectId = this.storage.chatSessionProjects.get(input.sessionId)?.projectId;
    }
    const project = projectId ? this.storage.chatProjects.get(projectId) : undefined;
    if (project && this.normalizeWorkspaceId(project.workspaceId) !== sessionWorkspaceId) {
      throw new Error("project workspace does not match session workspace");
    }
    const rootPath = project?.workspacePath ?? "chat/default";
    const stamp = new Date();
    const year = String(stamp.getUTCFullYear());
    const month = String(stamp.getUTCMonth() + 1).padStart(2, "0");
    const attachmentId = randomUUID();
    const storageRelPath = path.posix.join(
      rootPath,
      "attachments",
      year,
      month,
      `${attachmentId}-${fileName}`,
    );
    const fullPath = path.resolve(this.config.rootDir, this.config.assistant.workspaceDir, storageRelPath);
    assertWritePathInJail(fullPath, this.config.toolPolicy.sandbox.writeJailRoots);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, bytes);

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { extractStatus, extractPreview } = extractAttachmentPreview(bytes, mimeType, fileName);
    const mediaType = detectAttachmentMediaType(mimeType);
    const analysisStatus = inferAttachmentAnalysisStatus(mediaType, extractStatus);
    const created = this.storage.chatAttachments.create({
      attachmentId,
      sessionId: input.sessionId,
      workspaceId: sessionWorkspaceId,
      projectId,
      fileName,
      mimeType,
      mediaType,
      sizeBytes: bytes.length,
      sha256,
      storageRelPath,
      extractStatus,
      extractPreview,
      analysisStatus,
      ocrText: mediaType === "text" ? extractPreview : undefined,
    });
    if (analysisStatus === "queued") {
      this.createMediaJob({
        type: mediaType === "image"
          ? "ocr"
          : mediaType === "audio"
            ? "audio_transcribe"
            : mediaType === "video"
              ? "video_transcribe"
              : "analyze",
        sessionId: input.sessionId,
        attachmentId,
      });
    }
    this.publishRealtime("chat_message", "chat", {
      type: "chat_attachment_uploaded",
      sessionId: input.sessionId,
      attachmentId,
      fileName,
      sizeBytes: bytes.length,
    });
    return created;
  }

  public getChatAttachment(attachmentId: string): ChatAttachmentRecord {
    return this.storage.chatAttachments.get(attachmentId);
  }

  public async readChatAttachmentContent(attachmentId: string): Promise<{
    record: ChatAttachmentRecord;
    fullPath: string;
    bytes: Buffer;
  }> {
    const record = this.storage.chatAttachments.get(attachmentId);
    const fullPath = path.resolve(this.config.rootDir, this.config.assistant.workspaceDir, record.storageRelPath);
    assertExistingPathRealpathAllowed(
      fullPath,
      this.config.toolPolicy.sandbox.writeJailRoots,
      this.config.toolPolicy.sandbox.readOnlyRoots,
    );
    const bytes = await fs.readFile(fullPath);
    return {
      record,
      fullPath,
      bytes,
    };
  }

  public async listBackups(limit = 50): Promise<BackupManifestRecord[]> {
    const backupDir = this.getBackupDirectory();
    const entries = await listFilesSafe(backupDir);
    const manifests: BackupManifestRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(".backup")) {
        continue;
      }
      const manifestPath = path.join(backupDir, entry.name, "manifest.json");
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const parsed = JSON.parse(raw) as BackupManifestRecord;
        manifests.push(parsed);
      } catch {
        // skip invalid backup folders
      }
    }
    manifests.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    return manifests.slice(0, Math.max(1, Math.min(limit, 500)));
  }

  public async createBackup(input?: {
    name?: string;
    outputPath?: string;
  }): Promise<BackupCreateResponse> {
    const now = new Date();
    const timestamp = formatBackupTimestamp(now);
    const backupId = sanitizeBackupName(input?.name) ?? `backup-${timestamp}-${randomUUID().slice(0, 8)}`;
    const backupDir = path.resolve(this.getBackupDirectory());
    const outputPath = input?.outputPath
      ? path.resolve(backupDir, input.outputPath)
      : path.join(backupDir, `${backupId}.backup`);
    ensurePathWithinRoot(outputPath, backupDir);
    const tempDir = `${outputPath}.tmp-${randomUUID().slice(0, 8)}`;
    ensurePathWithinRoot(tempDir, backupDir);
    const payloadDir = path.join(tempDir, "payload");

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(payloadDir, { recursive: true });

    const includePaths = this.buildBackupIncludePaths();
    for (const includePath of includePaths) {
      const source = path.resolve(this.config.rootDir, includePath);
      const target = path.join(payloadDir, includePath);
      await copyPathIfExists(source, target);
    }

    const files = await collectBackupFileRecords(payloadDir);
    const manifest: BackupManifestRecord = {
      backupId,
      createdAt: now.toISOString(),
      appVersion: readAppVersion(),
      gitRef: readGitRef(this.config.rootDir),
      rootDir: this.config.rootDir,
      files,
    };
    const manifestPath = path.join(tempDir, "manifest.json");
    const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
    await fs.writeFile(manifestPath, manifestRaw, "utf8");

    await fs.rm(outputPath, { recursive: true, force: true });
    await fs.rename(tempDir, outputPath);

    return {
      backupId,
      outputPath,
      bytes: files.reduce((sum, item) => sum + item.sizeBytes, 0) + Buffer.byteLength(manifestRaw, "utf8"),
      manifest,
    };
  }

  public async restoreBackup(input: {
    filePath: string;
    confirm: boolean;
  }): Promise<{ restored: boolean; backupId?: string; filesRestored: number }> {
    if (!input.confirm) {
      throw new Error("Backup restore requires explicit confirm=true");
    }

    const backupDir = path.resolve(this.getBackupDirectory());
    const backupPath = path.resolve(backupDir, input.filePath);
    ensurePathWithinRoot(backupPath, backupDir);
    const verification = await this.verifyBackup({
      filePath: input.filePath,
    });
    if (!verification.verified || !verification.manifest) {
      throw new Error(formatBackupVerifyFailure(verification));
    }

    const payloadDir = path.join(backupPath, "payload");
    const manifest = verification.manifest;

    for (const file of manifest.files) {
      const source = path.resolve(payloadDir, file.path);
      ensurePathWithinRoot(source, payloadDir);
      const target = path.resolve(this.config.rootDir, file.path);
      ensurePathWithinRoot(target, this.config.rootDir);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }

    return {
      restored: true,
      backupId: manifest.backupId,
      filesRestored: manifest.files.length,
    };
  }

  public async verifyBackup(input: {
    filePath: string;
  }): Promise<BackupVerifyResponse> {
    const backupDir = path.resolve(this.getBackupDirectory());
    const backupPath = path.resolve(backupDir, input.filePath);
    ensurePathWithinRoot(backupPath, backupDir);
    return verifyBackupAtPath(backupPath);
  }

  public getRetentionPolicy(): RetentionPolicy {
    const stored = this.storage.systemSettings.get<RetentionPolicy>(RETENTION_SETTINGS_KEY)?.value;
    return normalizeRetentionPolicy(stored ?? DEFAULT_RETENTION_POLICY);
  }

  public updateRetentionPolicy(input: Partial<RetentionPolicy>): RetentionPolicy {
    const current = this.getRetentionPolicy();
    const merged = normalizeRetentionPolicy({
      ...current,
      ...input,
    });
    this.storage.systemSettings.set(RETENTION_SETTINGS_KEY, merged);
    return merged;
  }

  public async pruneRetention(options: { dryRun?: boolean } = {}): Promise<RetentionPruneResult> {
    const policy = this.getRetentionPolicy();
    const dryRun = options.dryRun ?? true;
    const startedAt = new Date().toISOString();
    let removedRealtimeEvents = 0;
    let removedBackupFiles = 0;
    let removedTranscriptFiles = 0;
    let removedAuditFiles = 0;
    let reclaimedBytes = 0;

    const realtimeCutoff = new Date(Date.now() - policy.realtimeEventsDays * 24 * 60 * 60 * 1000).toISOString();
    const realtimeCountRow = this.gatewaySql.prepare(
      "SELECT COUNT(*) AS count FROM realtime_events WHERE created_at < ?",
    ).get(realtimeCutoff) as { count: number } | undefined;
    removedRealtimeEvents = Number(realtimeCountRow?.count ?? 0);
    if (!dryRun && removedRealtimeEvents > 0) {
      this.storage.realtimeEvents.pruneOlderThan(realtimeCutoff);
    }

    const backupDir = this.getBackupDirectory();
    const backupEntries = await listFilesSafe(backupDir);
    const sortedBackups = backupEntries
      .filter((entry) => entry.isFile())
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const removableBackups = sortedBackups.slice(Math.max(0, policy.backupsKeep));
    removedBackupFiles = removableBackups.length;
    reclaimedBytes += removableBackups.reduce((sum, file) => sum + file.size, 0);
    if (!dryRun) {
      for (const file of removableBackups) {
        await fs.rm(path.join(backupDir, file.name), { force: true });
      }
    }

    if (policy.transcriptsDays !== undefined) {
      const transcriptsDir = path.resolve(this.config.rootDir, this.config.assistant.transcriptsDir);
      const cutoff = Date.now() - policy.transcriptsDays * 24 * 60 * 60 * 1000;
      const pruned = await pruneFilesOlderThan(transcriptsDir, cutoff, dryRun);
      removedTranscriptFiles = pruned.files;
      reclaimedBytes += pruned.bytes;
    }

    if (policy.auditDays !== undefined) {
      const auditDir = path.resolve(this.config.rootDir, this.config.assistant.auditDir);
      const cutoff = Date.now() - policy.auditDays * 24 * 60 * 60 * 1000;
      const pruned = await pruneFilesOlderThan(auditDir, cutoff, dryRun);
      removedAuditFiles = pruned.files;
      reclaimedBytes += pruned.bytes;
    }

    return {
      applied: !dryRun,
      startedAt,
      finishedAt: new Date().toISOString(),
      removedRealtimeEvents,
      removedBackupFiles,
      removedTranscriptFiles,
      removedAuditFiles,
      reclaimedBytes,
    };
  }

  public async invokeTool(request: ToolInvokeRequest): Promise<ToolInvokeResult> {
    const normalizedRequest = this.resolveToolInvokeRequestPaths(request);
    const deploymentGuard = evaluateDeploymentProfileToolAccess(
      this.config.assistant.deploymentProfile,
      normalizedRequest.toolName,
      normalizedRequest.args,
    );
    if (deploymentGuard) {
      return {
        outcome: "blocked",
        policyReason: `blocked: ${deploymentGuard.reason}`,
        auditEventId: randomUUID(),
      };
    }

    const result = await this.policyEngine.invoke(normalizedRequest);
    this.publishRealtime("tool_invoked", "policy", {
      toolName: normalizedRequest.toolName,
      sessionId: normalizedRequest.sessionId,
      agentId: normalizedRequest.agentId,
      taskId: normalizedRequest.taskId,
      outcome: result.outcome,
      policyReason: result.policyReason,
      approvalId: result.approvalId,
      auditEventId: result.auditEventId,
    });

    if (result.outcome === "approval_required" && result.approvalId) {
      this.scheduleApprovalExplanationById(result.approvalId);
    }

    return result;
  }

  private resolveToolInvokeRequestPaths(request: ToolInvokeRequest): ToolInvokeRequest {
    const workspaceRoot = path.resolve(this.config.rootDir, this.config.assistant.workspaceDir);
    const projectId = this.storage.chatSessionProjects.get(request.sessionId)?.projectId;
    const project = projectId ? this.storage.chatProjects.get(projectId) : undefined;
    const projectRoot = resolveProjectRootForToolContext({
      workspaceRoot,
      repoRoot: this.config.rootDir,
      projectWorkspacePath: project?.workspacePath,
    });
    return resolveToolRequestPaths(request, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: project?.workspacePath,
    });
  }

  public listToolCatalog(): ToolCatalogEntry[] {
    return this.policyEngine.listCatalog();
  }

  public evaluateToolAccess(input: ToolAccessEvaluateRequest): ToolAccessEvaluateResponse {
    return this.policyEngine.evaluateAccess(input);
  }

  public listToolGrants(
    scope?: "global" | "session" | "agent" | "task",
    scopeRef?: string,
    limit = 200,
  ): ToolGrantRecord[] {
    return this.policyEngine.listGrants(scope, scopeRef, limit);
  }

  public createToolGrant(input: ToolGrantCreateInput): ToolGrantRecord {
    const grant = this.policyEngine.createGrant(input);
    this.publishRealtime("system", "tools", {
      type: "tool_grant_created",
      grantId: grant.grantId,
      toolPattern: grant.toolPattern,
      decision: grant.decision,
      scope: grant.scope,
      scopeRef: grant.scopeRef,
      expiresAt: grant.expiresAt,
    });
    return grant;
  }

  public revokeToolGrant(grantId: string): boolean {
    const revoked = this.policyEngine.revokeGrant(grantId);
    if (revoked) {
      this.publishRealtime("system", "tools", {
        type: "tool_grant_revoked",
        grantId,
      });
    }
    return revoked;
  }

  public async createApproval(input: ApprovalCreateInput): Promise<ApprovalRequest> {
    const approval = this.storage.approvals.create(input);

    this.storage.approvalEvents.append({
      approvalId: approval.approvalId,
      eventType: "created",
      actorId: "system",
      payload: {
        kind: approval.kind,
        riskLevel: approval.riskLevel,
        status: approval.status,
      },
    });

    await this.storage.audit.append("approvals", {
      event: "approval.create",
      approvalId: approval.approvalId,
      kind: approval.kind,
      riskLevel: approval.riskLevel,
      status: approval.status,
    });

    this.publishRealtime("approval_created", "approvals", {
      approvalId: approval.approvalId,
      kind: approval.kind,
      riskLevel: approval.riskLevel,
      status: approval.status,
    });

    this.ensureApprovalWaitDurableRun(approval);
    this.scheduleApprovalExplanation(approval);

    return approval;
  }

  public createApprovalRemoteActionToken(
    approvalId: string,
    input: {
      connectorId: string;
      issuedBy?: string;
      expiresInMs?: number;
    },
  ): RemoteApprovalActionTokenIssueResult {
    const approval = this.storage.approvals.get(approvalId);
    if (approval.status !== "pending") {
      throw new ConflictError({
        message: `Approval ${approvalId} is already resolved`,
      });
    }
    const connector = this.requireConnectorRecord(input.connectorId);
    const expiresInMs = clampInt(input.expiresInMs ?? 15 * 60_000, 15 * 60_000, 60_000, 24 * 60 * 60_000);
    const token = `grat_${randomBytes(32).toString("base64url")}`;
    const created = this.storage.remoteActionTokens.create({
      tokenHash: hashSensitiveToken(token),
      actionType: "approval.resolve",
      approvalId,
      connectorId: input.connectorId,
      mutation: { approvalId },
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    });
    void this.storage.audit.append("approvals", {
      event: "approval.remote_token.create",
      approvalId,
      connectorId: input.connectorId,
      issuedBy: input.issuedBy ?? "operator",
      expiresAt: created.expiresAt,
      tokenId: created.tokenId,
    });
    this.publishRealtime("approval_remote_token_created", "approvals", {
      approvalId,
      connectorId: input.connectorId,
      expiresAt: created.expiresAt,
      tokenId: created.tokenId,
    });
    this.enqueueApprovalRemoteTokenDelivery(approval, connector, {
      token,
      tokenId: created.tokenId,
      expiresAt: created.expiresAt,
    });
    return {
      ...created,
      approvalId,
      token,
    };
  }

  public async resolveApprovalWithRemoteToken(input: {
    token: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
  }): Promise<ApprovalResolveResult> {
    const tokenRecord = this.consumeRemoteActionToken(input.token, "approval.resolve");
    return this.resolveApprovalWithConsumedRemoteToken(tokenRecord, input);
  }

  public async resolveApprovalWithRemoteTokenId(input: {
    tokenId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
  }): Promise<ApprovalResolveResult> {
    const tokenRecord = this.consumeRemoteActionTokenById(input.tokenId, "approval.resolve");
    return this.resolveApprovalWithConsumedRemoteToken(tokenRecord, input);
  }

  private async resolveApprovalWithConsumedRemoteToken(
    tokenRecord: RemoteActionTokenRecord,
    input: {
      decision: ApprovalResolveInput["decision"];
      editedPayload?: Record<string, unknown>;
      resolutionNote?: string;
    },
  ): Promise<ApprovalResolveResult> {
    const approvalId = tokenRecord.approvalId ?? String(tokenRecord.mutation.approvalId ?? "").trim();
    if (!approvalId) {
      throw new ValidationError({
        message: "Remote action token is missing an approval binding.",
      });
    }
    const resolvedBy = `connector:${tokenRecord.connectorId}`;
    void this.storage.audit.append("approvals", {
      event: "approval.remote_token.consume",
      approvalId,
      connectorId: tokenRecord.connectorId,
      tokenId: tokenRecord.tokenId,
      decision: input.decision,
      resolvedBy,
    });
    return this.resolveApproval(approvalId, {
      decision: input.decision,
      editedPayload: input.editedPayload,
      resolutionNote: input.resolutionNote,
      resolvedBy,
    });
  }

  public listApprovals(status?: ApprovalRequest["status"], limit = 100): ApprovalRequest[] {
    return this.storage.approvals.list(status, limit);
  }

  public getApprovalReplay(approvalId: string, replayedBy = "operator"): ApprovalReplayResult {
    const approval = this.storage.approvals.get(approvalId);

    this.storage.approvalEvents.append({
      approvalId,
      eventType: "replayed",
      actorId: replayedBy,
      payload: {
        status: approval.status,
      },
    });

    return {
      approval,
      events: this.storage.approvalEvents.listByApprovalId(approvalId),
      pendingAction: this.storage.pendingApprovalActions.find(approvalId),
    };
  }

  public async resolveApproval(approvalId: string, input: ApprovalResolveInput): Promise<ApprovalResolveResult> {
    const current = this.storage.approvals.get(approvalId);
    if (current.kind === DEVICE_ACCESS_APPROVAL_KIND) {
      return this.resolveDeviceAccessApproval(current, input);
    }

    let executedAction: ToolInvokeResult | undefined;
    const pendingAction = this.storage.pendingApprovalActions.find(approvalId);

    if (input.decision === "approve") {
      executedAction = await this.policyEngine.executeApprovedAction(approvalId);
      if (pendingAction?.resolutionStatus === "pending" && executedAction?.outcome !== "executed") {
        this.storage.pendingApprovalActions.upsertPending({
          approvalId,
          actionType: pendingAction.actionType,
          request: pendingAction.request,
          createdAt: pendingAction.createdAt,
        });
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `Approved action could not execute and remains pending: ${executedAction?.policyReason ?? "unknown execution error"}`,
        });
      }
    }

    let approval!: ApprovalRequest;
    let wakeRunId: string | undefined;

    this.storage.runImmediateTransaction(() => {
      approval = this.storage.approvals.resolve(approvalId, input);

      this.storage.approvalEvents.append({
        approvalId,
        eventType: "resolved",
        actorId: input.resolvedBy,
        payload: {
          decision: input.decision,
          status: approval.status,
          editedPayload: input.editedPayload,
          executedOutcome: executedAction?.outcome,
        },
      });

      if (input.decision !== "approve" && pendingAction && pendingAction.resolutionStatus === "pending") {
        this.storage.pendingApprovalActions.markResolved(approvalId, "rejected", {
          decision: input.decision,
        });
      }
      wakeRunId = this.markApprovalWaitDurableRunResolved(approval, input, executedAction);
    });

    if (wakeRunId) {
      this.durableRunService.requestRunProcessing(wakeRunId);
    }

    await this.recordApprovalResolutionEffects(approval, input, executedAction);

    return {
      approval,
      executedAction,
    };
  }

  private ensureApprovalWaitDurableRun(approval: ApprovalRequest): DurableRunRecord | undefined {
    if (!this.isFeatureEnabled("durableKernelV1Enabled")) {
      return undefined;
    }
    const existing = this.gatewaySql.prepare(`
      SELECT run_id
      FROM approval_wait_runs
      WHERE approval_id = @approvalId
      LIMIT 1
    `).get({ approvalId: approval.approvalId }) as { run_id: string } | undefined;
    if (existing?.run_id) {
      try {
        return this.getDurableRun(existing.run_id);
      } catch (error) {
        if (!(error instanceof NotFoundError)) {
          throw error;
        }
        // Fall through and repair the mapping with a new waiting run.
      }
    }
    const requestAttribution = this.getCurrentRequestAttribution();
    const run = this.createDurableRun({
      workflowKey: "approval.wait",
      payload: ({
        version: "approval.wait.v1",
        approvalId: approval.approvalId,
        approvalKind: approval.kind,
        createdAt: approval.createdAt,
        correlationId: requestAttribution.correlationId,
        traceId: requestAttribution.traceId,
        originSurface: requestAttribution.originSurface,
      } satisfies ApprovalWaitWorkflowPayload) as unknown as Record<string, unknown>,
      metadata: {
        approvalId: approval.approvalId,
        approvalKind: approval.kind,
      },
      waitForEvent: {
        eventKey: "approval.resolved",
        correlationId: approval.approvalId,
      },
    });
    this.gatewaySql.prepare(`
      INSERT INTO approval_wait_runs (approval_id, run_id, created_at, resolved_at)
      VALUES (@approvalId, @runId, @createdAt, NULL)
      ON CONFLICT(approval_id) DO UPDATE SET
        run_id = excluded.run_id,
        created_at = excluded.created_at,
        resolved_at = NULL
    `).run({
      approvalId: approval.approvalId,
      runId: run.runId,
      createdAt: new Date().toISOString(),
    });
    return run;
  }

  private async wakeApprovalWaitDurableRun(
    approval: ApprovalRequest,
    input: ApprovalResolveInput,
    executedAction?: ToolInvokeResult,
  ): Promise<void> {
    const row = this.gatewaySql.prepare(`
      SELECT run_id
      FROM approval_wait_runs
      WHERE approval_id = @approvalId
      LIMIT 1
    `).get({ approvalId: approval.approvalId }) as { run_id: string } | undefined;
    if (!row?.run_id) {
      return;
    }
    this.gatewaySql.prepare(`
      UPDATE approval_wait_runs
      SET resolved_at = @resolvedAt
      WHERE approval_id = @approvalId
    `).run({
      approvalId: approval.approvalId,
      resolvedAt: approval.resolvedAt ?? new Date().toISOString(),
    });
    try {
      this.wakeDurableRun(row.run_id, {
        eventKey: "approval.resolved",
        correlationId: approval.approvalId,
        payload: {
          approvalId: approval.approvalId,
          status: approval.status,
          decision: input.decision,
          resolvedBy: input.resolvedBy,
          executedOutcome: executedAction?.outcome,
        },
      });
    } catch (error) {
      if (!String((error as Error).message ?? "").includes("not waiting/paused")) {
        throw error;
      }
    }
  }

  private markApprovalWaitDurableRunResolved(
    approval: ApprovalRequest,
    input: ApprovalResolveInput,
    executedAction?: ToolInvokeResult,
  ): string | undefined {
    const row = this.gatewaySql.prepare(`
      SELECT run_id
      FROM approval_wait_runs
      WHERE approval_id = @approvalId
      LIMIT 1
    `).get({ approvalId: approval.approvalId }) as { run_id: string } | undefined;
    if (!row?.run_id) {
      return undefined;
    }
    this.gatewaySql.prepare(`
      UPDATE approval_wait_runs
      SET resolved_at = @resolvedAt
      WHERE approval_id = @approvalId
    `).run({
      approvalId: approval.approvalId,
      resolvedAt: approval.resolvedAt ?? new Date().toISOString(),
    });
    try {
      this.durableRunService.wakeDurableRun(row.run_id, {
        eventKey: "approval.resolved",
        correlationId: approval.approvalId,
        payload: {
          approvalId: approval.approvalId,
          status: approval.status,
          decision: input.decision,
          resolvedBy: input.resolvedBy,
          executedOutcome: executedAction?.outcome,
        },
      });
    } catch (error) {
      if (!String((error as Error).message ?? "").includes("not waiting/paused")) {
        throw error;
      }
    }
    return row.run_id;
  }

  private enqueueApprovalRemoteTokenDelivery(
    approval: ApprovalRequest,
    connector: ConnectorRecord,
    tokenRecord: {
      token: string;
      tokenId: string;
      expiresAt: string;
    },
  ): DurableRunRecord | undefined {
    if (!this.isFeatureEnabled("durableKernelV1Enabled")) {
      return undefined;
    }
    const requestAttribution = this.getCurrentRequestAttribution();
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval,
      connector,
      token: tokenRecord.token,
      tokenId: tokenRecord.tokenId,
      expiresAt: tokenRecord.expiresAt,
    });
    if (!payload) {
      return undefined;
    }
    return this.createDurableRun({
      workflowKey: "connector.delivery",
      payload: {
        ...payload,
        traceId: requestAttribution.traceId,
        originSurface: requestAttribution.originSurface,
      } as unknown as Record<string, unknown>,
      metadata: {
        approvalId: approval.approvalId,
        connectorId: connector.connectorId,
        connectorType: connector.connectorType,
        deliveryKind: "approval.remote_token",
        tokenId: tokenRecord.tokenId,
      },
    });
  }

  private getCurrentRequestAttribution(): {
    correlationId?: string;
    traceId?: string;
    originSurface?: string;
  } {
    const attribution = getRequestAttribution();
    return {
      correlationId: typeof attribution?.correlationId === "string" ? attribution.correlationId : undefined,
      traceId: typeof attribution?.traceId === "string" ? attribution.traceId : undefined,
      originSurface: typeof attribution?.originSurface === "string" ? attribution.originSurface : undefined,
    };
  }

  private requireConnectorRecord(connectorId: string): ConnectorRecord {
    const normalizedConnectorId = connectorId.trim();
    if (!normalizedConnectorId) {
      throw new ValidationError({
        message: "connectorId is required.",
      });
    }
    const connector = this.listConnectorRecords().find((item) => item.connectorId === normalizedConnectorId);
    if (!connector) {
      throw new NotFoundError({
        entity: "Connector",
        id: normalizedConnectorId,
      });
    }
    return connector;
  }

  private consumeRemoteActionToken(
    token: string,
    expectedActionType: RemoteActionTokenRecord["actionType"],
  ): RemoteActionTokenRecord {
    const normalizedToken = token.trim();
    if (!normalizedToken) {
      throw new ValidationError({
        message: "Remote action token is required.",
      });
    }
    const current = this.storage.remoteActionTokens.findByTokenHash(hashSensitiveToken(normalizedToken));
    if (!current) {
      throw new NotFoundError({
        entity: "Remote action token",
        id: "unknown",
      });
    }
    if (current.actionType !== expectedActionType) {
      throw new ConflictError({
        message: `Remote action token is bound to ${current.actionType}, not ${expectedActionType}.`,
      });
    }
    if (current.state !== "pending") {
      throw new ConflictError({
        message: "Remote action token has already been consumed.",
      });
    }
    const expiresAt = Date.parse(current.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      this.storage.remoteActionTokens.updateState(current.tokenId, "expired");
      throw new ConflictError({
        message: "Remote action token has expired.",
      });
    }
    return this.storage.remoteActionTokens.updateState(current.tokenId, "consumed", {
      consumedAt: new Date().toISOString(),
      consumedBy: `connector:${current.connectorId}`,
    });
  }

  private consumeRemoteActionTokenById(
    tokenId: string,
    expectedActionType: RemoteActionTokenRecord["actionType"],
  ): RemoteActionTokenRecord {
    const normalizedTokenId = tokenId.trim();
    if (!normalizedTokenId) {
      throw new ValidationError({
        message: "Remote action token id is required.",
      });
    }
    const current = this.storage.remoteActionTokens.get(normalizedTokenId);
    if (current.actionType !== expectedActionType) {
      throw new ConflictError({
        message: `Remote action token is bound to ${current.actionType}, not ${expectedActionType}.`,
      });
    }
    if (current.state !== "pending") {
      throw new ConflictError({
        message: "Remote action token has already been consumed.",
      });
    }
    const expiresAt = Date.parse(current.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      this.storage.remoteActionTokens.updateState(current.tokenId, "expired");
      throw new ConflictError({
        message: "Remote action token has expired.",
      });
    }
    return this.storage.remoteActionTokens.updateState(current.tokenId, "consumed", {
      consumedAt: new Date().toISOString(),
      consumedBy: `connector:${current.connectorId}`,
    });
  }

  public costSummary(
    scope: "session" | "day" | "agent" | "task",
    from: string,
    to: string,
  ) {
    return this.storage.costLedger.summary(scope, from, to);
  }

  public costUsageAvailability(from: string, to: string) {
    return this.storage.costLedger.usageAvailability(from, to);
  }

  public runCheaper() {
    return {
      mode: "saver",
      actions: [
        "trim context",
        "summarize tool outputs",
        "reduce fanout",
      ],
    };
  }

  public listSkills(): SkillListItem[] {
    const stateMap = this.readSkillStates();
    return this.skillsService.list().map((skill) => {
      const state = stateMap.get(skill.skillId);
      return {
        ...skill,
        state: state?.state ?? "enabled",
        note: state?.note,
        stateUpdatedAt: state?.updatedAt,
      };
    });
  }

  public async reloadSkills(): Promise<SkillListItem[]> {
    const loaded = await this.skillsService.reload();
    this.ensureSkillStates(loaded.map((skill) => skill.skillId));
    return this.listSkills();
  }

  public getSkillActivationPolicy(): SkillActivationPolicy {
    const stored = this.storage.systemSettings.get<SkillActivationPolicy>(SKILL_ACTIVATION_POLICY_SETTING_KEY)?.value;
    if (!stored) {
      return { ...DEFAULT_SKILL_ACTIVATION_POLICY };
    }
    return {
      guardedAutoThreshold: clamp01(stored.guardedAutoThreshold ?? DEFAULT_SKILL_ACTIVATION_POLICY.guardedAutoThreshold),
      requireFirstUseConfirmation: stored.requireFirstUseConfirmation ?? DEFAULT_SKILL_ACTIVATION_POLICY.requireFirstUseConfirmation,
    };
  }

  public updateSkillActivationPolicy(
    input: Partial<SkillActivationPolicy>,
  ): SkillActivationPolicy {
    const current = this.getSkillActivationPolicy();
    const next: SkillActivationPolicy = {
      guardedAutoThreshold: clamp01(input.guardedAutoThreshold ?? current.guardedAutoThreshold),
      requireFirstUseConfirmation: input.requireFirstUseConfirmation ?? current.requireFirstUseConfirmation,
    };
    this.storage.systemSettings.set(SKILL_ACTIVATION_POLICY_SETTING_KEY, next);
    return next;
  }

  public getBankrSafetyPolicy(): BankrSafetyPolicy {
    this.requireBankrBuiltinEnabled();
    return readBankrSafetyPolicy(this.storage);
  }

  public updateBankrSafetyPolicy(input: Partial<BankrSafetyPolicy>): BankrSafetyPolicy {
    this.requireBankrBuiltinEnabled();
    const updated = writeBankrSafetyPolicy(this.storage, input);
    this.publishRealtime("system", "skills", {
      type: "bankr_policy_updated",
      policy: updated,
    });
    return updated;
  }

  public previewBankrAction(input: BankrActionPreviewRequest): BankrActionPreviewResponse {
    this.requireBankrBuiltinEnabled();
    return evaluateBankrActionPreview(this.storage, input);
  }

  public listBankrActionAudit(limit = 100, cursor?: string): BankrActionAuditRecord[] {
    this.requireBankrBuiltinEnabled();
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const parsedCursor = parseBankrAuditCursor(cursor);
    const rows = this.gatewaySql.prepare(`
      SELECT
        action_id AS actionId,
        session_id AS sessionId,
        actor_id AS actorId,
        action_type AS actionType,
        chain,
        symbol,
        usd_estimate AS usdEstimate,
        status,
        approval_id AS approvalId,
        policy_reason AS policyReason,
        details_json AS detailsJson,
        created_at AS createdAt
      FROM bankr_action_audit
      WHERE (
        @cursorCreatedAt IS NULL
        OR created_at < @cursorCreatedAt
        OR (created_at = @cursorCreatedAt AND action_id < @cursorActionId)
      )
      ORDER BY created_at DESC, action_id DESC
      LIMIT @limit
    `).all({
      cursorCreatedAt: parsedCursor?.createdAt ?? null,
      cursorActionId: parsedCursor?.actionId ?? null,
      limit: boundedLimit,
    }) as Array<{
      actionId: string;
      sessionId: string;
      actorId: string;
      actionType: BankrActionAuditRecord["actionType"];
      chain?: string;
      symbol?: string;
      usdEstimate?: number;
      status: BankrActionAuditRecord["status"];
      approvalId?: string;
      policyReason?: string;
      detailsJson?: string;
      createdAt: string;
    }>;

    return rows.map((row) => ({
      actionId: row.actionId,
      sessionId: row.sessionId,
      actorId: row.actorId,
      actionType: row.actionType,
      chain: row.chain,
      symbol: row.symbol,
      usdEstimate: Number.isFinite(row.usdEstimate) ? row.usdEstimate : undefined,
      status: row.status,
      approvalId: row.approvalId,
      policyReason: row.policyReason,
      details: row.detailsJson
        ? safeJsonParse<Record<string, unknown>>(row.detailsJson, {})
        : undefined,
      createdAt: row.createdAt,
    }));
  }

  public setSkillState(
    skillId: string,
    state: SkillRuntimeState,
    note?: string,
  ): SkillStateRecord {
    const knownSkill = this.skillsService.list().find((skill) => skill.skillId === skillId);
    if (!knownSkill) {
      throw new Error(`Unknown skill: ${skillId}`);
    }
    const now = new Date().toISOString();
    this.gatewaySql.prepare(`
      INSERT INTO skill_state (skill_id, state, note, updated_at, first_auto_approved_at)
      VALUES (@skillId, @state, @note, @updatedAt, NULL)
      ON CONFLICT(skill_id) DO UPDATE SET
        state = excluded.state,
        note = excluded.note,
        updated_at = excluded.updated_at
    `).run({
      skillId,
      state,
      note: note?.trim() || null,
      updatedAt: now,
    });

    this.gatewaySql.prepare(`
      INSERT INTO skill_activation_events (
        event_id, skill_id, event_type, payload_json, created_at
      ) VALUES (
        @eventId, @skillId, @eventType, @payloadJson, @createdAt
      )
    `).run({
      eventId: randomUUID(),
      skillId,
      eventType: "state_updated",
      payloadJson: JSON.stringify({ state, note: note?.trim() || undefined }),
      createdAt: now,
    });

    const updated = this.readSkillStates().get(skillId);
    if (!updated) {
      throw new Error(`Failed to persist skill state for ${skillId}`);
    }

    return updated;
  }

  public bulkSetSkillState(
    skillIds: string[],
    state: SkillRuntimeState,
    note?: string,
  ): SkillStateRecord[] {
    const uniqueIds = [...new Set(skillIds)];
    const updated: SkillStateRecord[] = [];
    for (const skillId of uniqueIds) {
      updated.push(this.setSkillState(skillId, state, note));
    }
    return updated;
  }

  public resolveSkillActivation(input: SkillResolveInput) {
    const policy = this.getSkillActivationPolicy();
    const base = this.skillsService.resolveActivation(input);
    const stateMap = this.readSkillStates();
    const selected: Array<
      SkillListItem & {
        confidence: number;
        requiresConfirmation: boolean;
      }
    > = [];
    const suppressed: Array<{
      skill: string;
      state: SkillRuntimeState;
      confidence: number;
      reason: string;
    }> = [];

    for (const skill of base.selected) {
      const reasons = base.reasons[skill.name] ?? [];
      const isExplicit = reasons.includes("explicit");
      const stateRecord = stateMap.get(skill.skillId);
      const state: SkillRuntimeState = stateRecord?.state ?? "enabled";
      const confidence = computeSkillActivationConfidence(reasons, isExplicit);

      if (state === "disabled") {
        suppressed.push({
          skill: skill.name,
          state,
          confidence,
          reason: "skill_disabled",
        });
        continue;
      }

      if (state === "sleep" && !isExplicit && confidence < policy.guardedAutoThreshold) {
        suppressed.push({
          skill: skill.name,
          state,
          confidence,
          reason: "below_guarded_auto_threshold",
        });
        continue;
      }

      const requiresConfirmation =
        state === "sleep"
        && policy.requireFirstUseConfirmation
        && !isExplicit
        && !stateRecord?.firstAutoApprovedAt;

      selected.push({
        ...skill,
        state,
        confidence,
        requiresConfirmation,
      });
    }

    return {
      ...base,
      selected,
      suppressed,
    };
  }

  public listTasks(
    limit: number,
    status?: TaskStatus,
    cursor?: string,
    view: "active" | "trash" | "all" = "active",
    workspaceId?: string,
  ): TaskRecord[] {
    return this.storage.tasks.list({
      workspaceId: this.normalizeWorkspaceId(workspaceId),
      status,
      limit,
      cursor,
      view,
    });
  }

  public getTask(taskId: string): TaskRecord {
    return this.storage.tasks.get(taskId);
  }

  public createTask(input: TaskCreateInput): TaskRecord {
    const created = this.storage.tasks.create({
      ...input,
      workspaceId: this.normalizeWorkspaceId(input.workspaceId),
    });
    this.publishRealtime("task_created", "tasks", {
      task: created,
    });
    return created;
  }

  public updateTask(taskId: string, input: TaskUpdateInput): TaskRecord {
    if (input.status === "done") {
      const deliverables = this.storage.taskDeliverables.countByTask(taskId);
      if (deliverables < 1) {
        throw new ValidationError({
          message: "Cannot mark task done without at least one deliverable",
        });
      }
    }

    const updated = this.storage.tasks.update(taskId, input);
    this.publishRealtime("task_updated", "tasks", {
      task: updated,
    });
    return updated;
  }

  public softDeleteTask(taskId: string, deletedBy?: string, deleteReason?: string): boolean {
    const deleted = this.storage.tasks.softDelete(taskId, deletedBy, deleteReason);
    if (deleted) {
      this.publishRealtime("task_deleted", "tasks", { taskId, mode: "soft" });
    }
    return deleted;
  }

  public restoreTask(taskId: string): boolean {
    const restored = this.storage.tasks.restore(taskId);
    if (restored) {
      this.publishRealtime("task_restored", "tasks", { taskId });
    }
    return restored;
  }

  public hardDeleteTask(taskId: string): boolean {
    const deleted = this.storage.tasks.hardDelete(taskId);
    if (deleted) {
      this.publishRealtime("task_deleted", "tasks", { taskId, mode: "hard" });
    }
    return deleted;
  }

  public listTaskActivities(taskId: string, limit = 200): TaskActivityRecord[] {
    this.storage.tasks.get(taskId);
    return this.storage.taskActivities.listByTask(taskId, limit);
  }

  public appendTaskActivity(taskId: string, input: TaskActivityCreateInput): TaskActivityRecord {
    this.storage.tasks.get(taskId);
    const activity = this.storage.taskActivities.append(taskId, input);
    this.publishRealtime("activity_logged", "tasks", {
      taskId,
      activity,
    });
    return activity;
  }

  public listTaskDeliverables(taskId: string, limit = 200): TaskDeliverableRecord[] {
    this.storage.tasks.get(taskId);
    return this.storage.taskDeliverables.listByTask(taskId, limit);
  }

  public appendTaskDeliverable(taskId: string, input: TaskDeliverableCreateInput): TaskDeliverableRecord {
    this.storage.tasks.get(taskId);
    const deliverable = this.storage.taskDeliverables.append(taskId, input);
    this.publishRealtime("deliverable_added", "tasks", {
      taskId,
      deliverable,
    });
    return deliverable;
  }

  public listTaskSubagents(taskId: string, limit = 200): TaskSubagentSession[] {
    this.storage.tasks.get(taskId);
    return this.storage.taskSubagents.listByTask(taskId, limit);
  }

  public registerTaskSubagent(taskId: string, input: TaskSubagentCreateInput): TaskSubagentSession {
    this.storage.tasks.get(taskId);
    const session = this.storage.taskSubagents.create(taskId, input);
    this.publishRealtime("subagent_registered", "tasks", {
      taskId,
      session,
    });
    return session;
  }

  public updateTaskSubagent(agentSessionId: string, input: TaskSubagentUpdateInput): TaskSubagentSession {
    const updated = this.storage.taskSubagents.updateByAgentSessionId(agentSessionId, {
      ...input,
      endedAt: input.endedAt ?? (input.status && input.status !== "active" ? new Date().toISOString() : undefined),
    });

    this.publishRealtime("subagent_updated", "tasks", {
      taskId: updated.taskId,
      session: updated,
    });
    return updated;
  }

  public getDashboardState(): DashboardState {
    const sessions = this.storage.sessions.list(200);
    const pendingApprovals = this.storage.approvals.list("pending", 10000).length;
    const activeSubagents = this.storage.taskSubagents.activeCount();
    const taskStatusCounts = this.storage.tasks.statusCounts();
    const recentEvents = this.storage.realtimeEvents.list(100);

    const now = new Date();
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const to = now.toISOString();
    const byDay = this.storage.costLedger.summary("day", from, to);
    const dailyCostUsd = byDay.reduce((sum, row) => sum + row.costUsd, 0);

    return {
      timestamp: now.toISOString(),
      sessions,
      pendingApprovals,
      activeSubagents,
      taskStatusCounts,
      recentEvents,
      dailyCostUsd,
    };
  }

  public getSystemVitals(): SystemVitals {
    const total = os.totalmem();
    const free = os.freemem();
    const processMem = process.memoryUsage();
    return {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      uptimeSeconds: os.uptime(),
      loadAverage: os.loadavg(),
      cpuCount: os.cpus().length,
      memoryTotalBytes: total,
      memoryFreeBytes: free,
      memoryUsedBytes: total - free,
      processRssBytes: processMem.rss,
      processHeapUsedBytes: processMem.heapUsed,
    };
  }

  public listOperators(): OperatorSummary[] {
    const activeSinceIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    return this.operatorSummaryCache.get(() => this.storage.sessions.listOperatorSummaries(activeSinceIso));
  }

  public listCronJobs(): CronJobRecord[] {
    return this.cronAutomationService.listCronJobs();
  }

  public getCronJob(jobId: string): CronJobRecord {
    return this.cronAutomationService.getCronJob(jobId);
  }

  public createCronJob(input: {
    jobId: string;
    name: string;
    schedule: string;
    enabled?: boolean;
  }): CronJobRecord {
    return this.cronAutomationService.createCronJob(input);
  }

  public updateCronJob(jobId: string, input: {
    name?: string;
    schedule?: string;
    enabled?: boolean;
  }): CronJobRecord {
    return this.cronAutomationService.updateCronJob(jobId, input);
  }

  public setCronJobEnabled(jobId: string, enabled: boolean): CronJobRecord {
    return this.cronAutomationService.setCronJobEnabled(jobId, enabled);
  }

  public deleteCronJob(jobId: string): { deleted: boolean; jobId: string } {
    return this.cronAutomationService.deleteCronJob(jobId);
  }

  public async runCronJobNow(jobId: string): Promise<{ jobId: string; status: "ok" }> {
    return this.cronAutomationService.runCronJobNow(jobId);
  }

  public listCronReviewQueue(limit = 200): CronReviewItem[] {
    return this.cronAutomationService.listCronReviewQueue(limit);
  }

  public retryCronReviewQueueItem(itemId: string): CronReviewItem {
    return this.cronAutomationService.retryCronReviewQueueItem(itemId);
  }

  public getCronRunDiff(runId: string): CronRunDiff {
    return this.cronAutomationService.getCronRunDiff(runId);
  }

  public async uploadWorkspaceFile(relativePath: string, content: string): Promise<FileUploadResult> {
    const normalized = this.normalizeRelativePath(relativePath);
    const fullPath = path.resolve(this.config.rootDir, this.config.assistant.workspaceDir, normalized);
    assertWritePathInJail(fullPath, this.config.toolPolicy.sandbox.writeJailRoots);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");

    const result = {
      relativePath: normalized,
      fullPath: this.serializeRootPath(fullPath),
      bytes: Buffer.byteLength(content, "utf8"),
    };

    this.publishRealtime("system", "files", {
      type: "file_uploaded",
      ...result,
    });

    return result;
  }

  public listFileTemplates(): FileTemplateRecord[] {
    const today = new Date().toISOString().slice(0, 10);
    return FILE_TEMPLATES.map((template) => ({
      ...template,
      defaultPath: template.defaultPath.replaceAll("{date}", today),
    }));
  }

  public async createWorkspaceFileFromTemplate(templateId: string, targetPath?: string): Promise<FileUploadResult> {
    const template = FILE_TEMPLATES.find((item) => item.templateId === templateId);
    if (!template) {
      throw new Error(`Unknown file template: ${templateId}`);
    }
    const today = new Date().toISOString().slice(0, 10);
    const resolvedPath = (targetPath && targetPath.trim()) || template.defaultPath.replaceAll("{date}", today);
    const content = template.body.replaceAll("{date}", today);
    return this.uploadWorkspaceFile(resolvedPath, content);
  }

  public async downloadWorkspaceFile(relativePath: string): Promise<FileDownloadResult> {
    const normalized = this.normalizeRelativePath(relativePath);
    const fullPath = path.resolve(this.config.rootDir, this.config.assistant.workspaceDir, normalized);
    try {
      assertExistingPathRealpathAllowed(
        fullPath,
        this.config.toolPolicy.sandbox.writeJailRoots,
        this.config.toolPolicy.sandbox.readOnlyRoots,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new NotFoundError({ entity: "File", id: normalized });
      }
      throw error;
    }

    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      throw new ValidationError({ message: `Path is a directory: ${normalized}` });
    }

    const contentType = detectMimeType(fullPath);
    const isText = isTextContentType(contentType);
    const content = isText
      ? await fs.readFile(fullPath, "utf8")
      : await fs.readFile(fullPath);

    return {
      relativePath: normalized,
      fullPath: this.serializeRootPath(fullPath),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      contentType,
      isText,
      content,
    };
  }

  public async listMemoryFiles(relativeDir = "memory"): Promise<MemoryFileEntry[]> {
    const normalized = this.normalizeRelativePath(relativeDir);
    const baseDir = path.resolve(this.config.rootDir, this.config.assistant.workspaceDir, normalized);
    assertWritePathInJail(baseDir, this.config.toolPolicy.sandbox.writeJailRoots);

    let entries: Array<{ isFile: () => boolean; name: string }>;
    try {
      entries = await fs.readdir(baseDir, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const files: MemoryFileEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const fullPath = path.join(baseDir, entry.name);
      const stat = await fs.stat(fullPath);
      files.push({
        relativePath: path.posix.join(normalized, entry.name),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }

    files.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
    return files;
  }

  public async listWorkspaceFiles(relativeDir = ".", maxItems = 1000): Promise<MemoryFileEntry[]> {
    const normalized = relativeDir === "." ? "." : this.normalizeRelativePath(relativeDir);
    const baseDir = normalized === "."
      ? path.resolve(this.config.rootDir, this.config.assistant.workspaceDir)
      : path.resolve(this.config.rootDir, this.config.assistant.workspaceDir, normalized);

    assertWritePathInJail(baseDir, this.config.toolPolicy.sandbox.writeJailRoots);

    const out: MemoryFileEntry[] = [];
    await walkFiles(baseDir, baseDir, out, maxItems);
    out.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
    return out;
  }

  public async listWorkspacePathSuggestions(root = ".", limit = 150): Promise<string[]> {
    const maxItems = Math.max(limit * 3, 200);
    const files = await this.listWorkspaceFiles(root, maxItems);
    const suggestions = new Set<string>();

    const normalizedRoot = root === "." ? "" : this.normalizeRelativePath(root);
    if (normalizedRoot) {
      suggestions.add(normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`);
    } else {
      suggestions.add("memory/");
      suggestions.add("notes/");
      suggestions.add("artifacts/");
      suggestions.add("docs/");
      suggestions.add("workspace/");
    }

    for (const file of files) {
      suggestions.add(file.relativePath);
      const dir = path.posix.dirname(file.relativePath);
      if (dir && dir !== ".") {
        suggestions.add(dir.endsWith("/") ? dir : `${dir}/`);
      }
      if (suggestions.size >= limit * 4) {
        break;
      }
    }

    return [...suggestions].slice(0, limit);
  }

  public async composeMemoryContext(input: MemoryContextComposeRequest): Promise<MemoryContextPack> {
    return this.memoryContextService.compose(input);
  }

  public getMemoryContext(contextId: string): MemoryContextPack {
    return this.memoryContextService.get(contextId);
  }

  public listRunContexts(runId: string): MemoryContextPack[] {
    return this.memoryContextService.listByRun(runId);
  }

  public listRecentMemoryContexts(limit = 60): MemoryContextPack[] {
    return this.memoryContextService.listRecent(limit);
  }

  public getMemoryQmdStats(from: string, to: string): MemoryQmdStatsResponse {
    return this.memoryContextService.stats(from, to);
  }

  public listMemoryItems(input: {
    namespace?: string;
    status?: MemoryItemRecord["status"] | "all";
    query?: string;
    limit?: number;
  } = {}): MemoryItemRecord[] {
    this.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const namespace = input.namespace?.trim();
    const status = input.status && input.status !== "all" ? input.status : undefined;
    const query = input.query?.trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)));

    const rows = this.gatewaySql.prepare(`
      SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, status,
             created_at, updated_at, forgotten_at
      FROM memory_items
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit * 4) as Array<{
      item_id: string;
      namespace: string;
      title: string;
      content: string;
      metadata_json: string | null;
      pinned: number;
      ttl_override_seconds: number | null;
      expires_at: string | null;
      status: MemoryItemRecord["status"];
      created_at: string;
      updated_at: string;
      forgotten_at: string | null;
    }>;

    const filtered = rows
      .filter((row) => (namespace ? row.namespace === namespace : true))
      .filter((row) => (status ? row.status === status : true))
      .filter((row) => {
        if (!query) {
          return true;
        }
        const haystack = `${row.title}\n${row.content}\n${row.namespace}`.toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, limit);

    return filtered.map((row) => this.mapMemoryItemRow(row));
  }

  public patchMemoryItem(
    itemId: string,
    patch: MemoryLifecyclePatch,
    actorId = "operator",
  ): MemoryItemRecord {
    this.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const current = this.requireMemoryItem(itemId);
    const now = new Date().toISOString();
    const next = {
      title: patch.title !== undefined ? patch.title.trim() : current.title,
      content: patch.content !== undefined ? patch.content : current.content,
      metadata: patch.metadata !== undefined ? patch.metadata : current.metadata,
      pinned: patch.pinned !== undefined ? patch.pinned : current.pinned,
      ttlOverrideSeconds: patch.ttlOverrideSeconds === null
        ? null
        : patch.ttlOverrideSeconds !== undefined
          ? Math.max(1, Math.min(31_536_000, Math.floor(patch.ttlOverrideSeconds)))
          : current.ttlOverrideSeconds ?? null,
    };
    this.gatewaySql.prepare(`
      UPDATE memory_items
      SET title = @title,
          content = @content,
          metadata_json = @metadataJson,
          pinned = @pinned,
          ttl_override_seconds = @ttlOverrideSeconds,
          updated_at = @updatedAt
      WHERE item_id = @itemId
    `).run({
      itemId,
      title: next.title,
      content: next.content,
      metadataJson: JSON.stringify(next.metadata ?? {}),
      pinned: next.pinned ? 1 : 0,
      ttlOverrideSeconds: next.ttlOverrideSeconds,
      updatedAt: now,
    });
    if (patch.pinned !== undefined) {
      this.recordMemoryChange(itemId, "pin_changed", actorId, { pinned: next.pinned });
    }
    if (patch.ttlOverrideSeconds !== undefined) {
      this.recordMemoryChange(itemId, "ttl_changed", actorId, { ttlOverrideSeconds: next.ttlOverrideSeconds });
    }
    this.recordMemoryChange(itemId, "updated", actorId, {
      title: next.title,
      metadata: next.metadata ?? {},
    });
    const updated = this.requireMemoryItem(itemId);
    this.publishRealtime("system", "memory", {
      type: "memory_item_updated",
      itemId: updated.itemId,
      namespace: updated.namespace,
    });
    return updated;
  }

  public forgetMemoryItem(itemId: string, actorId = "operator"): MemoryItemRecord {
    this.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const current = this.requireMemoryItem(itemId);
    if (current.status === "forgotten") {
      return current;
    }
    const now = new Date().toISOString();
    this.gatewaySql.prepare(`
      UPDATE memory_items
      SET status = 'forgotten',
          forgotten_at = @forgottenAt,
          updated_at = @updatedAt
      WHERE item_id = @itemId
    `).run({
      itemId,
      forgottenAt: now,
      updatedAt: now,
    });
    this.recordMemoryChange(itemId, "forgotten", actorId, {
      previousStatus: current.status,
    });
    const forgotten = this.requireMemoryItem(itemId);
    this.publishRealtime("system", "memory", {
      type: "memory_item_forgotten",
      itemId,
      namespace: forgotten.namespace,
    });
    return forgotten;
  }

  public forgetMemory(
    input: {
      itemIds?: string[];
      namespace?: string;
      query?: string;
      actorId?: string;
    } = {},
  ): { forgottenCount: number; itemIds: string[] } {
    this.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const criteria = normalizeMemoryForgetCriteria(input);
    if (!criteria.hasCriteria) {
      throw new Error("Memory forget requires at least one criterion: itemIds, namespace, or query.");
    }
    const actorId = input.actorId?.trim() || "operator";
    let targets: string[] = [];
    if (criteria.hasItemIds) {
      targets = criteria.itemIds;
    } else {
      targets = this.listMemoryItems({
        namespace: criteria.namespace,
        status: "active",
        query: criteria.query,
        limit: 2_000,
      }).map((item) => item.itemId);
    }
    for (const itemId of targets) {
      this.forgetMemoryItem(itemId, actorId);
    }
    return {
      forgottenCount: targets.length,
      itemIds: targets,
    };
  }

  public listMemoryItemHistory(itemId: string, limit = 200): MemoryChangeEvent[] {
    this.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit)));
    const rows = this.gatewaySql.prepare(`
      SELECT change_id, item_id, change_type, actor_id, payload_json, created_at
      FROM memory_change_history
      WHERE item_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(itemId, safeLimit) as Array<{
      change_id: string;
      item_id: string;
      change_type: MemoryChangeEvent["changeType"];
      actor_id: string | null;
      payload_json: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      changeId: row.change_id,
      itemId: row.item_id,
      changeType: row.change_type,
      actorId: row.actor_id ?? undefined,
      payload: this.tryParseJson<Record<string, unknown>>(row.payload_json, {}),
      createdAt: row.created_at,
    }));
  }

  public listAgents(view: "active" | "archived" | "all" = "active", limit = 500): AgentProfileRecord[] {
    const profiles = this.storage.agentProfiles.list(view, limit);
    const runtime = this.buildAgentRuntimeRollups(profiles);

    const merged = profiles.map((profile) => {
      const runtimeStats = runtime.get(profile.roleId);
      const activeSessions = runtimeStats?.activeSessions ?? 0;
      const sessionCount = runtimeStats?.sessionCount ?? 0;
      const lastUpdatedAt = runtimeStats?.lastUpdatedAt;
      return {
        ...profile,
        status: activeSessions > 0 ? "active" : "idle",
        sessionCount,
        activeSessions,
        lastUpdatedAt,
      } satisfies AgentProfileRecord;
    });

    return merged.sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === "active" ? -1 : 1;
      }
      if (left.isBuiltin !== right.isBuiltin) {
        return left.isBuiltin ? -1 : 1;
      }
      const leftUpdated = Date.parse(left.lastUpdatedAt ?? left.updatedAt);
      const rightUpdated = Date.parse(right.lastUpdatedAt ?? right.updatedAt);
      if (leftUpdated !== rightUpdated) {
        return rightUpdated - leftUpdated;
      }
      return left.name.localeCompare(right.name);
    });
  }

  public getAgent(agentId: string): AgentProfileRecord {
    const profile = this.storage.agentProfiles.get(agentId);
    const runtime = this.buildAgentRuntimeRollups([profile]).get(profile.roleId);
    const activeSessions = runtime?.activeSessions ?? 0;
    return {
      ...profile,
      status: activeSessions > 0 ? "active" : "idle",
      sessionCount: runtime?.sessionCount ?? 0,
      activeSessions,
      lastUpdatedAt: runtime?.lastUpdatedAt,
    };
  }

  public createAgentProfile(input: AgentProfileCreateInput): AgentProfileRecord {
    const created = this.storage.agentProfiles.create(input);
    const agent = this.getAgent(created.agentId);
    this.publishRealtime("system", "agents", {
      type: "agent_profile_created",
      agentId: agent.agentId,
      roleId: agent.roleId,
      name: agent.name,
      isBuiltin: agent.isBuiltin,
    });
    return agent;
  }

  public updateAgentProfile(agentId: string, input: AgentProfileUpdateInput): AgentProfileRecord {
    const updated = this.storage.agentProfiles.update(agentId, input);
    const agent = this.getAgent(updated.agentId);
    this.publishRealtime("system", "agents", {
      type: "agent_profile_updated",
      agentId: agent.agentId,
      roleId: agent.roleId,
      name: agent.name,
    });
    return agent;
  }

  public archiveAgentProfile(agentId: string, input: AgentProfileArchiveInput): AgentProfileRecord {
    const archived = this.storage.agentProfiles.archive(agentId, input);
    const agent = this.getAgent(archived.agentId);
    this.publishRealtime("system", "agents", {
      type: "agent_profile_archived",
      agentId: agent.agentId,
      roleId: agent.roleId,
      archivedBy: input.archivedBy,
    });
    return agent;
  }

  public restoreAgentProfile(agentId: string): AgentProfileRecord {
    const restored = this.storage.agentProfiles.restore(agentId);
    const agent = this.getAgent(restored.agentId);
    this.publishRealtime("system", "agents", {
      type: "agent_profile_restored",
      agentId: agent.agentId,
      roleId: agent.roleId,
    });
    return agent;
  }

  public hardDeleteAgentProfile(agentId: string): boolean {
    const deleted = this.storage.agentProfiles.hardDelete(agentId);
    if (deleted) {
      this.publishRealtime("system", "agents", {
        type: "agent_profile_deleted",
        agentId,
      });
    }
    return deleted;
  }

  public getSettings(): RuntimeSettings {
    const features = this.readFeatureFlags();
    return {
      environment: this.config.assistant.environment,
      deploymentProfile: this.config.assistant.deploymentProfile,
      defaultToolProfile: this.config.toolPolicy.tools.profile,
      budgetMode: this.config.budgets.mode,
      workspaceDir: this.config.assistant.workspaceDir,
      writeJailRoots: this.config.toolPolicy.sandbox.writeJailRoots,
      readOnlyRoots: this.config.toolPolicy.sandbox.readOnlyRoots,
      readAccessMode: this.config.toolPolicy.sandbox.readAccessMode ?? "roots_only",
      networkAllowlist: this.config.toolPolicy.sandbox.networkAllowlist,
      approvalExplainer: this.config.assistant.approvalExplainer,
      memory: {
        enabled: this.config.assistant.memory.enabled,
        qmd: {
          enabled: this.config.assistant.memory.qmd.enabled,
          applyToChat: this.config.assistant.memory.qmd.applyToChat,
          applyToOrchestration: this.config.assistant.memory.qmd.applyToOrchestration,
          minPromptChars: this.config.assistant.memory.qmd.minPromptChars,
          maxContextTokens: this.config.assistant.memory.qmd.maxContextTokens,
          cacheTtlSeconds: this.config.assistant.memory.qmd.cacheTtlSeconds,
          distillerProviderId: this.config.assistant.memory.qmd.distiller.providerId,
          distillerModel: this.config.assistant.memory.qmd.distiller.model,
        },
      },
      auth: this.getAuthRuntimeSettings(),
      llm: this.llmService.getRuntimeConfig({
        includeKeychainForActiveProvider: true,
        useCache: true,
      }),
      mesh: {
        enabled: this.config.assistant.mesh.enabled,
        mode: this.config.assistant.mesh.mode,
        nodeId: this.config.assistant.mesh.nodeId,
        mdns: this.config.assistant.mesh.discovery.mdns,
        staticPeers: this.config.assistant.mesh.discovery.staticPeers,
        requireMtls: this.config.assistant.mesh.security.requireMtls,
        tailnetEnabled: this.config.assistant.mesh.security.tailnet.enabled,
      },
      npu: {
        enabled: this.config.assistant.npu.enabled,
        autoStart: this.config.assistant.npu.autoStart,
        sidecarUrl: this.config.assistant.npu.sidecar.baseUrl,
        status: this.npuSidecar.getStatus(),
      },
      features,
    };
  }

  public getOnboardingState(): OnboardingState {
    const settings = this.getSettings();
    const activeProvider = settings.llm.providers.find(
      (provider) => provider.providerId === settings.llm.activeProviderId,
    );
    const authReady = this.isAuthConfiguredForMode(settings.auth);
    const llmReady = Boolean(
      activeProvider
      && settings.llm.activeModel.trim()
      && (activeProvider.hasApiKey || this.isProviderLikelyLocal(activeProvider.baseUrl)),
    );
    const runtimeReady = Boolean(settings.defaultToolProfile.trim()) && Boolean(settings.budgetMode.trim());
    const meshReady = settings.mesh.enabled
      ? Boolean(settings.mesh.nodeId.trim()) && (settings.mesh.mode !== "tailnet" || settings.mesh.tailnetEnabled)
      : true;

    const checklist: OnboardingChecklistItem[] = [
      {
        id: "auth",
        label: "Gateway access control",
        status: authReady ? "complete" : "needs_input",
        detail: authReady
          ? `Mode ${settings.auth.mode} is configured.`
          : "Configure token/basic credentials or explicitly choose none for local trusted use.",
      },
      {
        id: "llm",
        label: "LLM provider",
        status: llmReady ? "complete" : "needs_input",
        detail: llmReady
          ? `Provider ${settings.llm.activeProviderId} with model ${settings.llm.activeModel} is ready.`
          : "Select an active provider/model and configure an API key (or use a local endpoint).",
      },
      {
        id: "runtime",
        label: "Runtime defaults",
        status: runtimeReady ? "complete" : "needs_input",
        detail: runtimeReady
          ? `Profile ${settings.defaultToolProfile} / budget ${settings.budgetMode}.`
          : "Choose a default tool profile and budget mode.",
      },
      {
        id: "mesh",
        label: "Mesh (optional)",
        status: settings.mesh.enabled ? (meshReady ? "complete" : "needs_input") : "optional",
        detail: settings.mesh.enabled
          ? `Mesh ${settings.mesh.mode} on node ${settings.mesh.nodeId}.`
          : "Mesh disabled. You can enable this later.",
      },
    ];

    return {
      completed: Boolean(this.onboardingMarker.completedAt),
      completedAt: this.onboardingMarker.completedAt,
      completedBy: this.onboardingMarker.completedBy,
      checklist,
      settings: {
        defaultToolProfile: settings.defaultToolProfile,
        budgetMode: settings.budgetMode,
        networkAllowlist: settings.networkAllowlist,
        auth: settings.auth,
        llm: {
          activeProviderId: settings.llm.activeProviderId,
          activeModel: settings.llm.activeModel,
          providers: settings.llm.providers.map((provider) => ({
            providerId: provider.providerId,
            label: provider.label,
            baseUrl: provider.baseUrl,
            defaultModel: provider.defaultModel,
            hasApiKey: provider.hasApiKey,
            apiKeySource: provider.apiKeySource,
          })),
        },
        mesh: settings.mesh,
      },
    };
  }

  public bootstrapOnboarding(input: OnboardingBootstrapInput): OnboardingBootstrapResult {
    this.updateSettings({
      defaultToolProfile: input.defaultToolProfile,
      budgetMode: input.budgetMode,
      networkAllowlist: input.networkAllowlist,
      auth: input.auth,
      llm: input.llm,
      mesh: input.mesh,
    });

    if (input.markComplete) {
      this.markOnboardingComplete(input.completedBy ?? "operator");
    }

    return {
      state: this.getOnboardingState(),
      appliedAt: new Date().toISOString(),
    };
  }

  public markOnboardingComplete(completedBy = "operator"): OnboardingState {
    this.onboardingMarker = {
      completedAt: new Date().toISOString(),
      completedBy: completedBy.trim() || "operator",
    };
    this.persistOnboardingMarker();
    this.publishRealtime("system", "onboarding", {
      type: "onboarding_completed",
      completedAt: this.onboardingMarker.completedAt,
      completedBy: this.onboardingMarker.completedBy,
    });
    return this.getOnboardingState();
  }

  public updateSettings(input: {
    deploymentProfile?: DeploymentProfile;
    defaultToolProfile?: string;
    budgetMode?: "saver" | "balanced" | "power";
    readAccessMode?: FilesystemReadAccessMode;
    networkAllowlist?: string[];
    auth?: AuthSettingsUpdateInput;
    llm?: {
      activeProviderId?: string;
      activeModel?: string;
      upsertProvider?: {
        providerId: string;
        label?: string;
        baseUrl?: string;
        defaultModel?: string;
        apiKey?: string;
        apiKeyEnv?: string;
        headers?: Record<string, string>;
      };
    };
    memory?: {
      enabled?: boolean;
      qmdEnabled?: boolean;
      qmdApplyToChat?: boolean;
      qmdApplyToOrchestration?: boolean;
      qmdMaxContextTokens?: number;
      qmdMinPromptChars?: number;
      qmdCacheTtlSeconds?: number;
      qmdDistillerProviderId?: string;
      qmdDistillerModel?: string;
    };
    mesh?: {
      enabled?: boolean;
      mode?: "lan" | "wan" | "tailnet";
      nodeId?: string;
      mdns?: boolean;
      staticPeers?: string[];
      requireMtls?: boolean;
      tailnetEnabled?: boolean;
    };
    npu?: {
      enabled?: boolean;
      autoStart?: boolean;
      sidecarUrl?: string;
    };
    features?: Partial<RuntimeSettings["features"]>;
  }): RuntimeSettings {
    this.assertDeploymentProfileUpdate(input);

    let persistAssistant = false;
    let persistToolPolicy = false;
    let persistBudgets = false;

    if (input.deploymentProfile) {
      this.config.assistant.deploymentProfile = input.deploymentProfile;
      persistAssistant = true;
    }

    if (input.defaultToolProfile) {
      if (!Object.prototype.hasOwnProperty.call(this.config.toolPolicy.profiles, input.defaultToolProfile)) {
        throw new Error(`Unknown tool profile: ${input.defaultToolProfile}`);
      }
      this.config.toolPolicy.tools.profile = input.defaultToolProfile as typeof this.config.toolPolicy.tools.profile;
      this.config.assistant.defaultToolProfile = input.defaultToolProfile;
      persistAssistant = true;
      persistToolPolicy = true;
    }

    if (input.budgetMode) {
      this.config.budgets.mode = input.budgetMode;
      persistBudgets = true;
    }

    if (input.readAccessMode) {
      this.config.toolPolicy.sandbox.readAccessMode = input.readAccessMode;
      persistToolPolicy = true;
    }

    if (input.networkAllowlist) {
      this.config.toolPolicy.sandbox.networkAllowlist = input.networkAllowlist
        .map((host) => host.trim())
        .filter(Boolean);
      this.llmService.updateNetworkAllowlist(this.config.toolPolicy.sandbox.networkAllowlist);
      persistToolPolicy = true;
    }

    if (input.auth) {
      this.updateAuthSettings(input.auth);
      persistAssistant = true;
    }

    if (input.memory) {
      if (input.memory.enabled !== undefined) {
        this.config.assistant.memory.enabled = input.memory.enabled;
      }
      if (input.memory.qmdEnabled !== undefined) {
        this.config.assistant.memory.qmd.enabled = input.memory.qmdEnabled;
      }
      if (input.memory.qmdApplyToChat !== undefined) {
        this.config.assistant.memory.qmd.applyToChat = input.memory.qmdApplyToChat;
      }
      if (input.memory.qmdApplyToOrchestration !== undefined) {
        this.config.assistant.memory.qmd.applyToOrchestration = input.memory.qmdApplyToOrchestration;
      }
      if (input.memory.qmdMaxContextTokens !== undefined) {
        this.config.assistant.memory.qmd.maxContextTokens = Math.max(100, input.memory.qmdMaxContextTokens);
      }
      if (input.memory.qmdMinPromptChars !== undefined) {
        this.config.assistant.memory.qmd.minPromptChars = Math.max(0, input.memory.qmdMinPromptChars);
      }
      if (input.memory.qmdCacheTtlSeconds !== undefined) {
        this.config.assistant.memory.qmd.cacheTtlSeconds = Math.max(10, input.memory.qmdCacheTtlSeconds);
      }
      if (input.memory.qmdDistillerProviderId !== undefined) {
        this.config.assistant.memory.qmd.distiller.providerId = input.memory.qmdDistillerProviderId.trim() || undefined;
      }
      if (input.memory.qmdDistillerModel !== undefined) {
        this.config.assistant.memory.qmd.distiller.model = input.memory.qmdDistillerModel.trim() || undefined;
      }
      persistAssistant = true;
    }

    if (input.mesh) {
      if (input.mesh.enabled !== undefined) {
        this.config.assistant.mesh.enabled = input.mesh.enabled;
      }
      if (input.mesh.mode) {
        this.config.assistant.mesh.mode = input.mesh.mode;
      }
      if (input.mesh.nodeId !== undefined) {
        const trimmed = input.mesh.nodeId.trim();
        if (!trimmed) {
          throw new Error("mesh.nodeId cannot be empty");
        }
        this.config.assistant.mesh.nodeId = trimmed;
      }
      if (input.mesh.mdns !== undefined) {
        this.config.assistant.mesh.discovery.mdns = input.mesh.mdns;
      }
      if (input.mesh.staticPeers) {
        this.config.assistant.mesh.discovery.staticPeers = input.mesh.staticPeers
          .map((peer) => peer.trim())
          .filter(Boolean);
      }
      if (input.mesh.requireMtls !== undefined) {
        this.config.assistant.mesh.security.requireMtls = input.mesh.requireMtls;
      }
      if (input.mesh.tailnetEnabled !== undefined) {
        this.config.assistant.mesh.security.tailnet.enabled = input.mesh.tailnetEnabled;
      }

      this.meshService.updateOptions({
        enabled: this.config.assistant.mesh.enabled,
        mode: this.config.assistant.mesh.mode,
        localNodeId: this.config.assistant.mesh.nodeId,
        localNodeLabel: this.config.assistant.mesh.label,
        advertiseAddress: this.config.assistant.mesh.advertiseAddress,
        requireMtls: this.config.assistant.mesh.security.requireMtls,
        tailnetEnabled: this.config.assistant.mesh.security.tailnet.enabled,
        joinToken: process.env[this.config.assistant.mesh.security.joinTokenEnv],
        defaultLeaseTtlSeconds: this.config.assistant.mesh.leases.ttlSeconds,
      });
      persistAssistant = true;
    }

    if (input.npu) {
      if (input.npu.enabled !== undefined) {
        this.config.assistant.npu.enabled = input.npu.enabled;
      }
      if (input.npu.autoStart !== undefined) {
        this.config.assistant.npu.autoStart = input.npu.autoStart;
      }
      if (input.npu.sidecarUrl !== undefined) {
        const trimmed = input.npu.sidecarUrl.trim();
        if (!trimmed) {
          throw new Error("npu.sidecarUrl cannot be empty");
        }
        this.config.assistant.npu.sidecar.baseUrl = trimmed;
      }

      this.npuSidecar.updateConfig(this.config.assistant.npu);
      if (!this.config.assistant.npu.enabled) {
        void this.npuSidecar.stop("disabled").catch((error) => {
          console.warn("[goatcitadel] npu sidecar stop failed after settings update", error);
        });
      } else if (this.config.assistant.npu.autoStart) {
        void this.npuSidecar.start("config_autostart").catch((error) => {
          console.error("[goatcitadel] npu sidecar autostart failed after settings update", error);
        });
      }
      persistAssistant = true;
    }

    if (input.features) {
      this.updateFeatureFlags(input.features);
      persistAssistant = true;
    }

    if (input.llm) {
      this.llmService.updateRuntimeConfig(input.llm);
      this.persistLlmConfig();
    }

    if (persistToolPolicy) {
      this.persistToolPolicyConfig();
    }
    if (persistBudgets) {
      this.persistBudgetsConfig();
    }
    if (persistAssistant) {
      this.persistAssistantConfig();
    }

    return this.getSettings();
  }

  public getDeploymentProfile(): DeploymentProfile {
    return this.config.assistant.deploymentProfile;
  }

  private assertDeploymentProfileUpdate(input: {
    deploymentProfile?: DeploymentProfile;
    auth?: AuthSettingsUpdateInput;
    networkAllowlist?: string[];
  }): void {
    const nextProfile = input.deploymentProfile ?? this.config.assistant.deploymentProfile;
    if (nextProfile !== "remote_hardened") {
      return;
    }

    const nextAuthMode = input.auth?.mode ?? this.config.assistant.auth.mode;
    const nextAllowLoopbackBypass = input.auth?.allowLoopbackBypass ?? this.config.assistant.auth.allowLoopbackBypass;
    const nextAllowlist = (input.networkAllowlist ?? this.config.toolPolicy.sandbox.networkAllowlist)
      .map((host) => host.trim())
      .filter(Boolean);

    const errors: string[] = [];
    if (nextAuthMode === "none") {
      errors.push("remote_hardened requires token or basic auth.");
    }
    if (nextAllowLoopbackBypass) {
      errors.push("remote_hardened disables loopback bypass.");
    }
    if (nextAllowlist.length === 0) {
      errors.push("remote_hardened requires a non-empty outbound host allowlist.");
    }
    if (nextAllowlist.some((host) => host === "*")) {
      errors.push("remote_hardened forbids wildcard outbound host allowlists.");
    }

    if (errors.length > 0) {
      throw new Error(errors.join(" "));
    }
  }

  public getAuthRuntimeSettings(): AuthRuntimeSettings {
    const plan = createGatewayAuthCredentialPlan({
      runtimeConfig: this.config,
      env: process.env,
      configAuth: readAssistantAuthConfigSnapshotSync(this.config.rootDir),
    });
    return {
      mode: this.config.assistant.auth.mode,
      allowLoopbackBypass: this.config.assistant.auth.allowLoopbackBypass,
      tokenConfigured: Boolean(this.config.assistant.auth.token.value?.trim()),
      basicConfigured: Boolean(
        this.config.assistant.auth.basic.username?.trim()
        && this.config.assistant.auth.basic.password?.trim(),
      ),
      plan,
    };
  }

  public updateAuthSettings(input: AuthSettingsUpdateInput): AuthRuntimeSettings {
    if (input.mode) {
      this.config.assistant.auth.mode = input.mode;
    }
    if (input.allowLoopbackBypass !== undefined) {
      this.config.assistant.auth.allowLoopbackBypass = input.allowLoopbackBypass;
    }
    if (input.token !== undefined) {
      this.config.assistant.auth.token.value = input.token.trim() || undefined;
    }
    if (input.basicUsername !== undefined) {
      this.config.assistant.auth.basic.username = input.basicUsername.trim() || undefined;
    }
    if (input.basicPassword !== undefined) {
      this.config.assistant.auth.basic.password = input.basicPassword.trim() || undefined;
    }
    return this.getAuthRuntimeSettings();
  }

  public getAuthCredentialPlan() {
    return this.getAuthRuntimeSettings().plan;
  }

  public async resolveGatewayInstallToken(input?: {
    token?: string;
    generateWhenMissing?: boolean;
    persistToEnv?: boolean;
  }) {
    return resolveGatewayInstallTokenFromPlanner({
      runtimeConfig: this.config,
      env: process.env,
      explicitToken: input?.token,
      generateWhenMissing: input?.generateWhenMissing,
      persistToEnv: input?.persistToEnv,
    });
  }

  public async createDeviceAccessRequest(
    input: DeviceAccessRequestCreateInput,
    context: {
      requestedOrigin?: string;
      requestedIp?: string;
      userAgent?: string;
      correlationId?: string;
      traceId?: string;
      originSurface?: string;
    },
  ): Promise<DeviceAccessRequestCreateResponse> {
    if (this.config.assistant.auth.mode === "none") {
      throw new Error("Device approvals are not needed when gateway auth mode is none.");
    }

    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + DEVICE_ACCESS_REQUEST_TTL_MS).toISOString();
    const requestId = randomUUID();
    const requestSecret = randomBytes(DEVICE_ACCESS_SECRET_BYTES).toString("base64url");
    const deviceType = normalizeDeviceAccessDeviceType(input.deviceType);
    const platform = normalizeOptionalDeviceAccessText(input.platform, 120) ?? inferPlatformFromUserAgent(context.userAgent);
    const deviceLabel = normalizeDeviceAccessLabel(input.deviceLabel, {
      deviceType,
      platform,
      userAgent: context.userAgent,
    });
    const requestedOrigin = normalizeOptionalDeviceAccessText(context.requestedOrigin, 240);
    const requestedIp = normalizeOptionalDeviceAccessText(context.requestedIp, 120);
    const userAgent = normalizeOptionalDeviceAccessText(context.userAgent, 512);
    const correlationId = normalizeOptionalDeviceAccessText(context.correlationId, 128);
    const traceId = normalizeOptionalDeviceAccessText(context.traceId, 128);
    const originSurface = normalizeOptionalDeviceAccessText(context.originSurface, 120);

    const approval = await this.createApproval({
      kind: DEVICE_ACCESS_APPROVAL_KIND,
      riskLevel: "danger",
      payload: {
        requestId,
        deviceLabel,
        deviceType,
        platform,
        requestedOrigin,
        requestedIp,
        userAgent,
      },
      preview: {
        title: "Allow new device access",
        requestId,
        deviceLabel,
        deviceType,
        platform,
        requestedOrigin,
        requestedIp,
      },
    });

    try {
      this.gatewaySql.prepare(`
        INSERT INTO auth_device_requests (
          request_id, approval_id, request_secret_hash, device_label, device_type, platform,
          requested_origin, requested_ip, user_agent, status, created_at, expires_at
        ) VALUES (
          @requestId, @approvalId, @requestSecretHash, @deviceLabel, @deviceType, @platform,
          @requestedOrigin, @requestedIp, @userAgent, @status, @createdAt, @expiresAt
        )
      `).run({
        requestId,
        approvalId: approval.approvalId,
        requestSecretHash: hashSensitiveToken(requestSecret),
        deviceLabel,
        deviceType,
        platform: platform ?? null,
        requestedOrigin: requestedOrigin ?? null,
        requestedIp: requestedIp ?? null,
        userAgent: userAgent ?? null,
        status: "pending",
        createdAt,
        expiresAt,
      });
    } catch (error) {
      try {
        await this.resolveApproval(approval.approvalId, {
          decision: "reject",
          resolvedBy: "system:auth-device-request",
          resolutionNote: "Device request registration failed.",
        });
      } catch {
        // Best effort cleanup only.
      }
      throw error;
    }

    await this.storage.audit.append("approvals", {
      event: "auth.device_request.create",
      requestId,
      approvalId: approval.approvalId,
      deviceLabel,
      deviceType,
      platform,
      requestedOrigin,
      requestedIp,
      correlationId,
      traceId,
      originSurface,
    });

    this.publishRealtime("auth_device_request_created", "auth", {
      requestId,
      approvalId: approval.approvalId,
      deviceLabel,
      deviceType,
      platform,
      requestedOrigin,
      requestedIp,
      correlationId,
      traceId,
      originSurface,
      createdAt,
      expiresAt,
    });

    return {
      requestId,
      requestSecret,
      approvalId: approval.approvalId,
      status: "pending",
      expiresAt,
      pollAfterMs: DEVICE_ACCESS_REQUEST_POLL_AFTER_MS,
      message: "Waiting for approval from another authenticated Mission Control session.",
    };
  }

  public async getDeviceAccessRequestStatus(
    requestId: string,
    requestSecret: string,
  ): Promise<DeviceAccessRequestStatusResponse> {
    const request = this.getAuthDeviceRequestById(requestId);
    if (!request) {
      throw new Error("Device access request not found.");
    }
    if (!requestSecret.trim() || !timingSafeStringEqual(hashSensitiveToken(requestSecret), request.requestSecretHash)) {
      throw new Error("Device access request not found.");
    }

    const current = await this.expireDeviceAccessRequestIfNeeded(request);
    if (current.status === "approved" && !current.deliveredAt) {
      const deliveredAt = new Date().toISOString();
      const result = this.gatewaySql.prepare(`
        UPDATE auth_device_requests
        SET delivered_at = @deliveredAt,
            approved_token_plaintext = NULL
        WHERE request_id = @requestId
          AND delivered_at IS NULL
      `).run({
        requestId: current.requestId,
        deliveredAt,
      });
      if (result.changes === 0) {
        // Another concurrent poll already delivered the token — re-read the record
        // so the response does not leak the plaintext token a second time.
        const refreshed = this.getAuthDeviceRequestById(requestId);
        if (refreshed) {
          return mapDeviceAccessStatusResponse(refreshed);
        }
      }
    }

    return mapDeviceAccessStatusResponse(current);
  }

  public listDeviceAccessGrants(): DeviceAccessGrantContractRecord[] {
    const rows = this.gatewaySql.prepare(`
      SELECT *
      FROM auth_device_grants
      ORDER BY
        CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END,
        COALESCE(last_used_at, created_at) DESC,
        created_at DESC
    `).all() as Record<string, unknown>[];
    return rows.map((row) => toDeviceAccessGrantRecord(mapAuthDeviceGrantRow(row)));
  }

  public async revokeDeviceAccessGrant(
    grantId: string,
    revokedBy: string,
  ): Promise<DeviceAccessGrantContractRecord> {
    const existingRow = this.gatewaySql.prepare(`
      SELECT *
      FROM auth_device_grants
      WHERE grant_id = @grantId
      LIMIT 1
    `).get({ grantId }) as Record<string, unknown> | undefined;
    if (!existingRow) {
      throw new NotFoundError("Device access grant not found.");
    }

    const revokedAt = new Date().toISOString();
    this.gatewaySql.prepare(`
      UPDATE auth_device_grants
      SET revoked_at = COALESCE(revoked_at, @revokedAt)
      WHERE grant_id = @grantId
    `).run({
      grantId,
      revokedAt,
    });

    const grant = mapAuthDeviceGrantRow(
      (this.gatewaySql.prepare(`
        SELECT *
        FROM auth_device_grants
        WHERE grant_id = @grantId
        LIMIT 1
      `).get({ grantId }) as Record<string, unknown> | undefined) ?? existingRow,
    );
    const result = toDeviceAccessGrantRecord(grant);

    await this.storage.audit.append("approvals", {
      event: "auth.device_grant.revoke",
      grantId: result.grantId,
      requestId: result.requestId,
      revokedBy,
      deviceLabel: result.deviceLabel,
      deviceType: result.deviceType,
      platform: result.platform,
      revokedAt: result.revokedAt,
    });

    this.publishRealtime("auth_device_grant_revoked", "auth", {
      grantId: result.grantId,
      requestId: result.requestId,
      actorId: result.actorId,
      deviceLabel: result.deviceLabel,
      deviceType: result.deviceType,
      platform: result.platform,
      revokedAt: result.revokedAt,
      revokedBy,
    });

    return result;
  }

  public validateDeviceAccessToken(token: string): { actorId: string; deviceId: string; grantId: string } | undefined {
    const tokenHash = hashSensitiveToken(token);
    const now = new Date().toISOString();
    const row = this.gatewaySql.prepare(`
      SELECT *
      FROM auth_device_grants
      WHERE token_hash = @tokenHash
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > @now)
      LIMIT 1
    `).get({
      tokenHash,
      now,
    }) as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }

    const grant = mapAuthDeviceGrantRow(row);
    this.gatewaySql.prepare(`
      UPDATE auth_device_grants
      SET last_used_at = @lastUsedAt
      WHERE grant_id = @grantId
    `).run({
      grantId: grant.grantId,
      lastUsedAt: now,
    });

    return {
      actorId: `device:${grant.grantId}`,
      deviceId: grant.grantId,
      grantId: grant.grantId,
    };
  }

  public listIntegrationCatalog(kind?: IntegrationKind): IntegrationCatalogEntry[] {
    const pluginIds = new Set(this.readIntegrationPlugins().map((item) => item.pluginId));
    const mapped = INTEGRATION_CATALOG.map((entry) => {
      let maturity = entry.maturity;
      if (entry.kind === "channel") {
        if (CORE_CHANNEL_KEYS.has(entry.key)) {
          maturity = entry.maturity === "planned" ? "native" : entry.maturity;
        } else if (entry.maturity === "planned") {
          maturity = pluginIds.size > 0 ? "plugin" : "disabled";
        }
      }
      if (entry.maturity === "planned" && pluginIds.has(entry.key)) {
        maturity = "plugin";
      }
      return {
        ...entry,
        maturity,
      };
    });
    if (!kind) {
      return mapped;
    }
    return mapped.filter((entry) => entry.kind === kind);
  }

  public getIntegrationFormSchema(catalogId: string): IntegrationFormSchema {
    const schema = getIntegrationFormSchema(catalogId);
    if (!schema) {
      throw new Error(`Unknown integration catalog id: ${catalogId}`);
    }
    return schema;
  }

  public listConnectorRecords(connectorType?: ConnectorType): ConnectorRecord[] {
    return filterConnectorRecords(
      buildGatewayConnectorRecords({
        integrationConnections: this.storage.integrationConnections.list(undefined, 1000),
        mcpServers: this.readMcpServers(),
        mcpTools: this.readMcpTools(),
      }),
      connectorType,
    );
  }

  public listIntegrationConnections(kind?: IntegrationKind, limit = 300): IntegrationConnection[] {
    return this.storage.integrationConnections.list(kind, limit);
  }

  public runIntegrationConnectionDiagnostics(connectionId: string): ConnectorDiagnosticReport {
    this.requireFeatureEnabled("connectorDiagnosticsV1Enabled");
    const connection = this.storage.integrationConnections.get(connectionId);
    if (!connection) {
      throw new Error(`Unknown integration connection: ${connectionId}`);
    }
    const checks: ConnectorDiagnosticReport["checks"] = [];
    checks.push({
      key: "enabled",
      status: connection.enabled ? "pass" : "warn",
      message: connection.enabled ? "Connection is enabled." : "Connection is disabled.",
    });
    checks.push({
      key: "status",
      status: connection.status === "connected" ? "pass" : connection.status === "paused" ? "warn" : "fail",
      message: `Connection status is ${connection.status}.`,
    });
    checks.push({
      key: "last_error",
      status: connection.lastError ? "warn" : "pass",
      message: connection.lastError ? `Last error: ${connection.lastError}` : "No recent errors recorded.",
    });
    checks.push(...this.buildIntegrationConnectionChecks(connection));
    const report: ConnectorDiagnosticReport = {
      connectorType: "integration_connection",
      connectorId: connection.connectionId,
      status: checks.some((check) => check.status === "fail")
        ? "error"
        : checks.some((check) => check.status === "warn")
          ? "warn"
          : "ok",
      checks,
      recommendedNextAction: this.pickConnectorDiagnosticAction(checks),
      checkedAt: new Date().toISOString(),
    };
    this.recordConnectorHealthRun(report);
    return report;
  }

  public createIntegrationConnection(input: IntegrationConnectionCreateInput): IntegrationConnection {
    const catalog = INTEGRATION_CATALOG.find((entry) => entry.catalogId === input.catalogId);
    if (!catalog) {
      throw new Error(`Unknown integration catalog id: ${input.catalogId}`);
    }

    const created = this.storage.integrationConnections.create({
      ...input,
      catalogId: catalog.catalogId,
      kind: catalog.kind,
      key: catalog.key,
      label: input.label?.trim() || catalog.label,
    });

    this.publishRealtime("system", "integrations", {
      type: "integration_connection_created",
      connectionId: created.connectionId,
      catalogId: created.catalogId,
      kind: created.kind,
      key: created.key,
      enabled: created.enabled,
      status: created.status,
    });

    return created;
  }

  public updateIntegrationConnection(connectionId: string, input: IntegrationConnectionUpdateInput): IntegrationConnection {
    const updated = this.storage.integrationConnections.update(connectionId, input);
    this.publishRealtime("system", "integrations", {
      type: "integration_connection_updated",
      connectionId: updated.connectionId,
      enabled: updated.enabled,
      status: updated.status,
      lastError: updated.lastError,
    });
    return updated;
  }

  public deleteIntegrationConnection(connectionId: string): boolean {
    const deleted = this.storage.integrationConnections.delete(connectionId);
    if (deleted) {
      this.publishRealtime("system", "integrations", {
        type: "integration_connection_deleted",
        connectionId,
      });
    }
    return deleted;
  }

  public listIntegrationPlugins(): IntegrationPluginRecord[] {
    return this.readIntegrationPlugins();
  }

  public installIntegrationPlugin(input: IntegrationPluginInstallInput): IntegrationPluginRecord {
    const now = new Date().toISOString();
    const plugins = this.readIntegrationPlugins();
    const nextId = sanitizePluginId(input.pluginId ?? input.source);
    const existing = plugins.find((item) => item.pluginId === nextId);
    if (existing) {
      const updated: IntegrationPluginRecord = {
        ...existing,
        updatedAt: now,
      };
      this.writeIntegrationPlugins(plugins.map((item) => item.pluginId === nextId ? updated : item));
      return updated;
    }

    const created: IntegrationPluginRecord = {
      pluginId: nextId,
      label: toTitleCase(nextId),
      version: "0.1.0",
      description: `Installed from ${input.source}`,
      enabled: true,
      installedAt: now,
      updatedAt: now,
      capabilities: ["channel.adapter"],
    };
    this.writeIntegrationPlugins([created, ...plugins]);
    this.publishRealtime("system", "integrations", {
      type: "integration_plugin_installed",
      pluginId: created.pluginId,
      source: input.source,
    });
    return created;
  }

  public setIntegrationPluginEnabled(pluginId: string, enabled: boolean): IntegrationPluginRecord {
    const now = new Date().toISOString();
    const plugins = this.readIntegrationPlugins();
    const current = plugins.find((item) => item.pluginId === pluginId);
    if (!current) {
      throw new Error(`Unknown integration plugin: ${pluginId}`);
    }
    const updated: IntegrationPluginRecord = {
      ...current,
      enabled,
      updatedAt: now,
    };
    this.writeIntegrationPlugins(plugins.map((item) => item.pluginId === pluginId ? updated : item));
    this.publishRealtime("system", "integrations", {
      type: enabled ? "integration_plugin_enabled" : "integration_plugin_disabled",
      pluginId,
    });
    return updated;
  }

  public async getObsidianIntegrationStatus(): Promise<ObsidianIntegrationStatus> {
    return this.obsidianVaultService.getStatus();
  }

  public updateObsidianIntegrationConfig(input: Partial<ObsidianIntegrationConfig>): ObsidianIntegrationConfig {
    const updated = this.obsidianVaultService.updateConfig(input);
    this.publishRealtime("system", "integrations", {
      type: "obsidian_config_updated",
      enabled: updated.enabled,
      mode: updated.mode,
      vaultPath: updated.vaultPath,
      allowedSubpaths: updated.allowedSubpaths,
    });
    return updated;
  }

  public async testObsidianIntegration(): Promise<ObsidianIntegrationStatus> {
    const status = await this.obsidianVaultService.testConnection();
    this.publishRealtime("system", "integrations", {
      type: "obsidian_test_completed",
      enabled: status.enabled,
      vaultReachable: status.vaultReachable,
      lastError: status.lastError,
      checkedAt: status.checkedAt,
    });
    return status;
  }

  public async searchObsidianNotes(query: string, limit?: number) {
    return this.obsidianVaultService.searchNotes(query, limit);
  }

  public async readObsidianNote(relativePath: string) {
    return this.obsidianVaultService.readNote(relativePath);
  }

  public async appendObsidianNote(relativePath: string, markdownBlock: string) {
    return this.obsidianVaultService.appendToNote(relativePath, markdownBlock);
  }

  public async captureObsidianInboxEntry(input: {
    id: string;
    request: string;
    type?: string;
    priority?: string;
    neededBy?: string;
    owner?: string;
    state?: string;
    taskLink?: string;
    decisionLink?: string;
    notes?: string;
  }) {
    return this.obsidianVaultService.captureInboxEntry(input);
  }

  public async listSkillSources(query?: string, limit = 25): Promise<SkillSourceListResponse> {
    return this.skillImportService.listSources(query, limit);
  }

  public async lookupSkillSources(queryOrUrl: string, limit = 10): Promise<SkillSourceLookupResponse> {
    return this.skillImportService.lookupSources(queryOrUrl, limit);
  }

  public listAddonsCatalog(): AddonCatalogEntry[] {
    return this.addonsService.listCatalog();
  }

  public async listInstalledAddons(): Promise<AddonInstalledRecord[]> {
    return this.addonsService.listInstalled();
  }

  public async getAddonStatus(addonId: string): Promise<AddonStatusRecord> {
    return this.addonsService.getStatus(addonId);
  }

  public async installAddon(addonId: string, input: AddonInstallRequest): Promise<AddonActionResponse> {
    this.recordDevDiagnostic({
      level: "info",
      category: "addons",
      event: "addon.install.start",
      message: `Installing addon ${addonId}`,
      context: { actorId: input.actorId },
    });
    const result = await this.addonsService.install(addonId, input);
    this.recordDevDiagnostic({
      level: "info",
      category: "addons",
      event: "addon.install.complete",
      message: `Installed addon ${addonId}`,
      context: { status: result.status.status },
    });
    this.publishRealtime("addon_installed", "system", {
      addonId,
      status: result.status.status,
    });
    return result;
  }

  public async updateAddon(addonId: string): Promise<AddonActionResponse> {
    const result = await this.addonsService.update(addonId);
    this.publishRealtime("addon_updated", "system", {
      addonId,
      status: result.status.status,
    });
    return result;
  }

  public async launchAddon(addonId: string): Promise<AddonActionResponse> {
    this.recordDevDiagnostic({
      level: "info",
      category: "addons",
      event: "addon.launch.start",
      message: `Launching addon ${addonId}`,
    });
    const result = await this.addonsService.launch(addonId);
    this.recordDevDiagnostic({
      level: "info",
      category: "addons",
      event: "addon.launch.complete",
      message: `Launched addon ${addonId}`,
      context: {
        status: result.status.status,
        launchUrl: result.status.installed?.launchUrl ?? result.status.addon.launchUrl,
      },
    });
    this.publishRealtime("addon_runtime_changed", "system", {
      addonId,
      status: result.status.status,
    });
    return result;
  }

  public async stopAddon(addonId: string): Promise<AddonActionResponse> {
    const result = await this.addonsService.stop(addonId);
    this.publishRealtime("addon_runtime_changed", "system", {
      addonId,
      status: result.status.status,
    });
    return result;
  }

  public async uninstallAddon(addonId: string): Promise<AddonUninstallResponse> {
    const result = await this.addonsService.uninstall(addonId);
    this.publishRealtime("addon_uninstalled", "system", {
      addonId,
    });
    return result;
  }

  public listSkillImportHistory(limit = 100): SkillImportHistoryRecord[] {
    return this.skillImportService.listHistory(limit);
  }

  public async validateSkillImport(input: {
    sourceRef: string;
    sourceType?: SkillImportValidationResult["candidate"]["sourceType"];
    sourceProvider?: SkillSourceProvider;
  }): Promise<SkillImportValidationResult> {
    const validation = await this.skillImportService.validateImport(input);
    this.recordSkillImportEvent(validation, "import_validated");
    this.publishRealtime("system", "skills", {
      type: "skill_import_validated",
      sourceProvider: validation.candidate.sourceProvider,
      sourceRef: validation.candidate.sourceRef,
      valid: validation.valid,
      riskLevel: validation.riskLevel,
      skillName: validation.inferredSkillName,
    });
    return validation;
  }

  public async installSkillImport(input: {
    sourceRef: string;
    sourceType?: SkillImportValidationResult["candidate"]["sourceType"];
    sourceProvider?: SkillSourceProvider;
    force?: boolean;
    confirmHighRisk?: boolean;
  }): Promise<{
    validation: SkillImportValidationResult;
    installedPath: string;
    sourceManifestPath: string;
    installedSkillId?: string;
  }> {
    const installed = await this.skillImportService.installImport(input);
    const skills = await this.reloadSkills();
    const installedSkill = skills.find((skill) =>
      skill.source === "extra"
      && path.resolve(skill.dir) === path.resolve(installed.installedPath));
    if (installedSkill) {
      this.setSkillState(
        installedSkill.skillId,
        "disabled",
        "Imported skill starts disabled by default.",
      );
    }
    this.recordSkillImportEvent(installed.validation, "import_installed");
    this.publishRealtime("system", "skills", {
      type: "skill_import_installed",
      sourceProvider: installed.validation.candidate.sourceProvider,
      sourceRef: installed.validation.candidate.sourceRef,
      riskLevel: installed.validation.riskLevel,
      skillName: installed.validation.inferredSkillName,
      skillId: installedSkill?.skillId,
      installedPath: path.relative(this.config.rootDir, installed.installedPath).replaceAll("\\", "/"),
    });
    return {
      ...installed,
      installedSkillId: installedSkill?.skillId,
    };
  }

  public listMcpServers(): McpServerRecord[] {
    return this.readMcpServers();
  }

  public listMcpTemplates(): Array<McpServerTemplateRecord & { installed: boolean }> {
    const byTemplateId = new Map(this.readMcpServers().map((server) => [server.label.toLowerCase(), server]));
    return MCP_SERVER_TEMPLATES.map((template) => ({
      ...template,
      installed: byTemplateId.has(template.label.toLowerCase()),
    }));
  }

  public listMcpTemplateDiscovery(): McpTemplateDiscoveryResult[] {
    this.requireFeatureEnabled("connectorDiagnosticsV1Enabled");
    const installed = new Map(this.readMcpServers().map((server) => [server.label.toLowerCase(), server]));
    return MCP_SERVER_TEMPLATES.map((template) => {
      const checks: McpTemplateDiscoveryResult["dependencyChecks"] = [];
      if (template.transport === "stdio") {
        checks.push({
          key: "command",
          status: template.command?.trim() ? "pass" : "fail",
          message: template.command?.trim() ? `Command ${template.command} is configured.` : "Missing command.",
        });
      }
      if (template.transport === "http" || template.transport === "sse") {
        checks.push({
          key: "url",
          status: template.url?.trim() ? "pass" : "warn",
          message: template.url?.trim() ? `Endpoint ${template.url} provided.` : "Provide endpoint URL before connect.",
        });
      }
      if (template.authType !== "none") {
        checks.push({
          key: "auth",
          status: "warn",
          message: `${template.authType} credentials required before first connect.`,
        });
      } else {
        checks.push({
          key: "auth",
          status: "pass",
          message: "No auth required.",
        });
      }
      const missingCommand = checks.some((check) => check.key === "command" && check.status === "fail");
      const missingUrl = checks.some((check) => check.key === "url" && check.status === "fail");
      const readiness = missingCommand
        ? "needs_command"
        : missingUrl
          ? "needs_url"
          : template.authType !== "none"
            ? "needs_auth"
            : "ready";
      return {
        templateId: template.templateId,
        label: template.label,
        installed: installed.has(template.label.toLowerCase()),
        readiness,
        dependencyChecks: checks,
      };
    });
  }

  public runMcpServerHealthCheck(serverId: string): ConnectorDiagnosticReport {
    this.requireFeatureEnabled("connectorDiagnosticsV1Enabled");
    const server = this.requireMcpServer(serverId);
    const checks: ConnectorDiagnosticReport["checks"] = [];
    checks.push({
      key: "enabled",
      status: server.enabled ? "pass" : "warn",
      message: server.enabled ? "MCP server is enabled." : "Server is disabled.",
    });
    checks.push({
      key: "status",
      status: server.status === "connected" ? "pass" : server.status === "connecting" ? "warn" : "fail",
      message: `Server status is ${server.status}.`,
    });
    if (server.transport === "stdio") {
      checks.push({
        key: "command",
        status: server.command?.trim() ? "pass" : "fail",
        message: server.command?.trim() ? `Command ${server.command} configured.` : "Missing stdio command.",
      });
    } else {
      checks.push({
        key: "url",
        status: server.url?.trim() ? "pass" : "fail",
        message: server.url?.trim() ? `URL ${server.url} configured.` : "Missing server URL.",
      });
    }
    checks.push({
      key: "policy",
      status: server.policy.blockedToolPatterns.length > 0 || server.policy.allowedToolPatterns.length > 0 ? "pass" : "warn",
      message: server.policy.blockedToolPatterns.length > 0 || server.policy.allowedToolPatterns.length > 0
        ? "Tool policy constraints are configured."
        : "Consider setting allow/block patterns for safer operation.",
    });
    const report: ConnectorDiagnosticReport = {
      connectorType: "mcp_server",
      connectorId: serverId,
      status: checks.some((check) => check.status === "fail")
        ? "error"
        : checks.some((check) => check.status === "warn")
          ? "warn"
          : "ok",
      checks,
      recommendedNextAction: this.pickConnectorDiagnosticAction(checks),
      checkedAt: new Date().toISOString(),
    };
    this.recordConnectorHealthRun(report);
    return report;
  }

  public createMcpServer(input: McpServerCreateInput): McpServerRecord {
    const now = new Date().toISOString();
    const created: McpServerRecord = {
      serverId: randomUUID(),
      label: input.label.trim(),
      transport: input.transport,
      command: input.command?.trim() || undefined,
      args: input.args?.map((item) => item.trim()).filter(Boolean),
      url: input.url?.trim() || undefined,
      authType: input.authType ?? "none",
      enabled: input.enabled ?? true,
      category: input.category ?? inferMcpCategory(input.transport),
      trustTier: input.trustTier ?? "restricted",
      costTier: input.costTier ?? "unknown",
      policy: normalizeMcpPolicy(input.policy),
      verifiedAt: input.verifiedAt,
      status: "disconnected",
      createdAt: now,
      updatedAt: now,
    };
    const servers = [created, ...this.readMcpServers()];
    this.writeMcpServers(servers);
    this.publishRealtime("system", "mcp", {
      type: "mcp_server_created",
      serverId: created.serverId,
      transport: created.transport,
    });
    return created;
  }

  public updateMcpServer(serverId: string, input: McpServerUpdateInput): McpServerRecord {
    const now = new Date().toISOString();
    let updated: McpServerRecord | undefined;
    const servers = this.readMcpServers().map((item) => {
      if (item.serverId !== serverId) {
        return item;
      }
      updated = {
        ...item,
        label: input.label?.trim() || item.label,
        command: input.command === undefined ? item.command : (input.command.trim() || undefined),
        args: input.args === undefined ? item.args : input.args.map((entry) => entry.trim()).filter(Boolean),
        url: input.url === undefined ? item.url : (input.url.trim() || undefined),
        authType: input.authType ?? item.authType,
        enabled: input.enabled ?? item.enabled,
        category: input.category ?? item.category,
        trustTier: input.trustTier ?? item.trustTier,
        costTier: input.costTier ?? item.costTier,
        policy: input.policy ? normalizeMcpPolicy({ ...item.policy, ...input.policy }) : item.policy,
        verifiedAt: input.verifiedAt ?? item.verifiedAt,
        updatedAt: now,
      };
      return updated;
    });
    if (!updated) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    this.writeMcpServers(servers);
    return updated;
  }

  public updateMcpServerPolicy(serverId: string, policy: Partial<McpServerPolicy>): McpServerRecord {
    return this.updateMcpServer(serverId, { policy });
  }

  public deleteMcpServer(serverId: string): { deleted: boolean } {
    const previous = this.readMcpServers();
    const next = previous.filter((item) => item.serverId !== serverId);
    const deleted = next.length !== previous.length;
    if (deleted) {
      this.writeMcpServers(next);
      this.writeMcpTools(this.readMcpTools().filter((tool) => tool.serverId !== serverId));
      this.storage.approvalInbox.deleteByReceiver("mcp", serverId);
      this.publishRealtime("system", "mcp", {
        type: "mcp_server_deleted",
        serverId,
      });
    }
    return { deleted };
  }

  public async connectMcpServer(serverId: string): Promise<McpServerRecord> {
    const connecting = this.patchMcpServerState(serverId, {
      status: "connecting",
      lastError: undefined,
    });
    try {
      const tools = this.readMcpTools();
      const existing = tools.filter((item) => item.serverId === serverId);
      const resolvedTools = await this.resolveConnectedMcpTools(connecting, existing);
      if (resolvedTools.length > 0) {
        this.writeMcpTools([
          ...tools.filter((item) => item.serverId !== serverId),
          ...resolvedTools,
        ]);
      }
      return this.patchMcpServerState(serverId, {
        status: "connected",
        lastConnectedAt: new Date().toISOString(),
        lastError: undefined,
      });
    } catch (error) {
      this.patchMcpServerState(serverId, {
        status: "error",
        lastError: (error as Error).message,
      });
      throw error;
    }
  }

  public disconnectMcpServer(serverId: string): McpServerRecord {
    return this.patchMcpServerState(serverId, {
      status: "disconnected",
    });
  }

  public startMcpOAuth(serverId: string): McpOAuthStartResponse {
    const server = this.requireMcpServer(serverId);
    const state = randomUUID();
    const callback = encodeURIComponent("http://127.0.0.1:8787/api/v1/mcp/oauth/callback");
    const authorizeUrl = `${server.url ?? "https://example-mcp-provider.local/oauth/authorize"}?state=${encodeURIComponent(state)}&redirect_uri=${callback}`;
    const authRows = this.readMcpAuthState();
    authRows[serverId] = {
      ...(authRows[serverId] ?? {}),
      oauthState: state,
      updatedAt: new Date().toISOString(),
    };
    this.writeMcpAuthState(authRows);
    return { authorizeUrl, state };
  }

  public async completeMcpOAuth(serverId: string, code: string, state?: string): Promise<McpServerRecord> {
    const authRows = this.readMcpAuthState();
    const authRow = authRows[serverId];
    if (!authRow) {
      throw new Error("No OAuth handshake in progress for this server.");
    }
    if (state && authRow.oauthState && authRow.oauthState !== state) {
      throw new Error("OAuth state mismatch.");
    }
    authRows[serverId] = {
      ...authRow,
      accessTokenRef: `keychain:goatcitadel:mcp:${serverId}:access-token`,
      refreshTokenRef: `keychain:goatcitadel:mcp:${serverId}:refresh-token`,
      oauthState: undefined,
      updatedAt: new Date().toISOString(),
      lastCodePreview: code.slice(0, 8),
    };
    this.writeMcpAuthState(authRows);
    return this.connectMcpServer(serverId);
  }

  public listMcpTools(serverId: string): McpToolRecord[] {
    this.requireMcpServer(serverId);
    return this.readMcpTools()
      .filter((item) => item.serverId === serverId)
      .sort((left, right) => left.toolName.localeCompare(right.toolName));
  }

  public listMcpBrowserFallbackTargets(): ReturnType<typeof collectMcpBrowserFallbackTargets> {
    return collectMcpBrowserFallbackTargets(
      this.readMcpServers(),
      this.readMcpTools(),
      (serverId, toolName) => this.isMcpToolApproved(serverId, toolName),
    );
  }

  public async invokeMcpTool(input: McpInvokeRequest): Promise<McpInvokeResponse> {
    const server = this.requireMcpServer(input.serverId);
    if (!server.enabled || server.status !== "connected") {
      return {
        ok: false,
        error: "MCP server is not connected.",
      };
    }
    if (server.trustTier === "quarantined") {
      return {
        ok: false,
        error: `MCP server ${server.label} is quarantined and cannot execute tools.`,
      };
    }
    const tools = this.listMcpTools(input.serverId);
    const tool = tools.find((item) => item.toolName === input.toolName && item.enabled);
    if (!tool) {
      return {
        ok: false,
        error: `MCP tool ${input.toolName} is not enabled on server ${input.serverId}.`,
      };
    }
    if (server.policy.blockedToolPatterns.some((pattern) => wildcardMatch(input.toolName, pattern))) {
      return {
        ok: false,
        error: `MCP policy blocked tool ${input.toolName} on server ${server.serverId}.`,
      };
    }
    if (server.policy.allowedToolPatterns.length > 0
      && !server.policy.allowedToolPatterns.some((pattern) => wildcardMatch(input.toolName, pattern))) {
      return {
        ok: false,
        error: `MCP policy does not allow tool ${input.toolName} on server ${server.serverId}.`,
      };
    }

    if (server.policy.requireFirstToolApproval && !this.isMcpToolApproved(input.serverId, input.toolName)) {
      return {
        ok: false,
        error: `First-use approval required for ${input.toolName}. Approve this tool in MCP policy or disable first-use approval.`,
      };
    }

    const policyAgentId = input.agentId?.trim() || "operator";
    const policySessionId = input.sessionId?.trim() || `mcp:${input.serverId}`;
    const access = this.policyEngine.evaluateAccess({
      toolName: "mcp.invoke",
      args: {
        serverId: input.serverId,
        toolName: input.toolName,
        arguments: input.arguments ?? {},
      },
      agentId: policyAgentId,
      sessionId: policySessionId,
      taskId: input.taskId,
    });
    if (!access.allowed) {
      return {
        ok: false,
        error: `MCP invoke blocked by policy: ${access.reasonCodes.join(", ")}`,
        policyReason: "blocked by tool policy",
        reasonCodes: access.reasonCodes,
      };
    }
    if (access.requiresApproval) {
      const decision = await this.policyEngine.invoke({
        toolName: "mcp.invoke",
        args: {
          serverId: input.serverId,
          toolName: input.toolName,
          arguments: input.arguments ?? {},
        },
        agentId: policyAgentId,
        sessionId: policySessionId,
        taskId: input.taskId,
        consentContext: {
          source: "agent",
          reason: `MCP tool invoke ${input.serverId}/${input.toolName}`,
        },
      });
      if (decision.outcome === "approval_required") {
        return {
          ok: false,
          error: "MCP invoke requires approval.",
          approvalRequired: true,
          approvalId: decision.approvalId,
          policyReason: decision.policyReason,
          reasonCodes: access.reasonCodes,
        };
      }
      if (decision.outcome === "blocked") {
        return {
          ok: false,
          error: decision.policyReason,
          policyReason: decision.policyReason,
          reasonCodes: access.reasonCodes,
        };
      }
    }

    const runtime = isInternalMcpApprovalInboxServer(server)
      ? await handleInternalMcpApprovalInboxInvoke(server, input, {
          approvalInbox: this.storage.approvalInbox,
          resolveApprovalWithRemoteTokenId: (request) => this.resolveApprovalWithRemoteTokenId(request),
        })
      : await invokeMcpRuntimeTool(server, {
          toolName: input.toolName,
          arguments: input.arguments,
          signal: input.signal,
        });
    const output = runtime.output
      ? {
          serverId: input.serverId,
          toolName: input.toolName,
          arguments: input.arguments ?? {},
          ...runtime.output,
        }
      : undefined;
    const redactedOutput = output ? applyMcpRedaction(output, server.policy.redactionMode) : undefined;
    this.publishRealtime("tool_invoked", "mcp", {
      type: "mcp_tool_invoked",
      serverId: input.serverId,
      toolName: input.toolName,
      sessionId: input.sessionId,
      taskId: input.taskId,
      trustTier: server.trustTier,
    });
    if (!runtime.ok) {
      return {
        ok: false,
        output: redactedOutput,
        error: runtime.error ?? `MCP tool ${input.toolName} failed.`,
      };
    }
    return {
      ok: true,
      output: redactedOutput,
    };
  }

  public createMediaJob(input: MediaCreateJobRequest): MediaJobRecord {
    const now = new Date().toISOString();
    const jobId = randomUUID();
    this.gatewaySql.prepare(`
      INSERT INTO media_jobs (
        job_id, session_id, attachment_id, job_type, status, input_json, output_json, error, created_at, updated_at, completed_at
      ) VALUES (
        @jobId, @sessionId, @attachmentId, @jobType, @status, @inputJson, NULL, NULL, @createdAt, @updatedAt, NULL
      )
    `).run({
      jobId,
      sessionId: input.sessionId ?? null,
      attachmentId: input.attachmentId ?? null,
      jobType: input.type,
      status: "queued",
      inputJson: input.input ? JSON.stringify(input.input) : null,
      createdAt: now,
      updatedAt: now,
    });
    const created = this.getMediaJob(jobId);
    this.processMediaJob(jobId);
    return created;
  }

  public getMediaJob(jobId: string): MediaJobRecord {
    const row = this.gatewaySql.prepare(`
      SELECT * FROM media_jobs
      WHERE job_id = ?
    `).get(jobId) as MediaJobRow | undefined;
    if (!row) {
      throw new Error(`Unknown media job: ${jobId}`);
    }
    return mapMediaJobRow(row);
  }

  public listMediaJobs(sessionId?: string): MediaJobRecord[] {
    const rows = this.gatewaySql.prepare(`
      SELECT * FROM media_jobs
      WHERE (@sessionId IS NULL OR session_id = @sessionId)
      ORDER BY created_at DESC
      LIMIT 500
    `).all({
      sessionId: sessionId ?? null,
    }) as unknown as MediaJobRow[];
    return rows.map(mapMediaJobRow);
  }

  public getChatAttachmentPreview(attachmentId: string): ChatAttachmentPreviewResponse {
    const record = this.getChatAttachment(attachmentId);
    return {
      attachmentId: record.attachmentId,
      fileName: record.fileName,
      mimeType: record.mimeType,
      mediaType: record.mediaType ?? detectAttachmentMediaType(record.mimeType),
      thumbnailRelPath: record.thumbnailRelPath,
      extractPreview: record.extractPreview,
      ocrText: record.ocrText,
      transcriptText: record.transcriptText,
      analysisStatus: record.analysisStatus === "pending"
        ? "queued"
        : (record.analysisStatus ?? "queued"),
    };
  }

  public async transcribeVoice(input: {
    bytesBase64: string;
    mimeType?: string;
    language?: string;
  }): Promise<VoiceTranscribeResponse> {
    const bytes = Buffer.from(input.bytesBase64, "base64");
    if (bytes.length === 0) {
      throw new Error("Audio payload is empty.");
    }
    this.recordDevDiagnostic({
      level: "info",
      category: "voice",
      event: "voice.transcribe.start",
      message: "Starting voice transcription",
      context: {
        bytes: bytes.length,
        mimeType: input.mimeType,
        language: input.language,
      },
    });
    return this.transcribeAudioBytes(bytes, input.mimeType, input.language);
  }

  public async getVoiceStatus(): Promise<VoiceStatus> {
    const now = new Date().toISOString();
    const runtime = await getManagedVoiceRuntimeStatus(this.storage.systemSettings);
    const stt = this.storage.systemSettings.get<VoiceStatus["stt"]>(VOICE_STATUS_SETTING_KEY)?.value ?? {
      state: "stopped",
      provider: DEFAULT_VOICE_PROVIDER,
      runtimeReady: runtime.readiness === "ready",
      modelId: runtime.selectedModelId,
      updatedAt: now,
    };
    const wake = this.storage.systemSettings.get<VoiceStatus["wake"]>(VOICE_WAKE_STATUS_SETTING_KEY)?.value ?? {
      enabled: false,
      state: "stopped",
      model: "openwakeword",
      updatedAt: now,
    };
    const talkRecord = this.storage.systemSettings.get<{
      activeSessionId?: string;
      state: "stopped" | "running" | "error";
      mode?: "push_to_talk" | "wake";
      updatedAt: string;
    }>("voice_talk_status_v1")?.value ?? {
      activeSessionId: undefined,
      state: "stopped",
      mode: undefined,
      updatedAt: now,
    };
    return {
      stt: {
        ...stt,
        runtimeReady: runtime.readiness === "ready",
        modelId: runtime.selectedModelId,
      },
      talk: talkRecord,
      wake,
    };
  }

  public async getVoiceRuntimeStatus(): Promise<VoiceRuntimeStatus> {
    return getManagedVoiceRuntimeStatus(this.storage.systemSettings);
  }

  public async installVoiceRuntime(input: VoiceRuntimeInstallRequest = {}): Promise<VoiceRuntimeStatus> {
    this.recordDevDiagnostic({
      level: "info",
      category: "voice",
      event: "voice.runtime.install.start",
      message: "Installing managed voice runtime",
      context: {
        modelId: input.modelId,
        activate: input.activate,
        repair: input.repair,
      },
    });
    const status = await installManagedVoiceRuntime(this.storage.systemSettings, input);
    this.recordDevDiagnostic({
      level: status.readiness === "ready" ? "info" : "warn",
      category: "voice",
      event: "voice.runtime.install.complete",
      message: "Managed voice runtime install finished",
      context: {
        readiness: status.readiness,
        selectedModelId: status.selectedModelId,
        lastError: status.lastError,
      },
    });
    this.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
      ...(this.storage.systemSettings.get<VoiceStatus["stt"]>(VOICE_STATUS_SETTING_KEY)?.value ?? {
        state: "stopped" as const,
        provider: DEFAULT_VOICE_PROVIDER,
        updatedAt: new Date().toISOString(),
      }),
      provider: DEFAULT_VOICE_PROVIDER,
      runtimeReady: status.readiness === "ready",
      modelId: status.selectedModelId,
      lastError: status.lastError,
      updatedAt: new Date().toISOString(),
    });
    return status;
  }

  public async selectVoiceRuntimeModel(modelId: string): Promise<VoiceRuntimeStatus> {
    const status = await selectManagedVoiceModel(this.storage.systemSettings, modelId);
    this.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
      ...(this.storage.systemSettings.get<VoiceStatus["stt"]>(VOICE_STATUS_SETTING_KEY)?.value ?? {
        state: "stopped" as const,
        provider: DEFAULT_VOICE_PROVIDER,
        updatedAt: new Date().toISOString(),
      }),
      provider: DEFAULT_VOICE_PROVIDER,
      runtimeReady: status.readiness === "ready",
      modelId: status.selectedModelId,
      lastError: status.lastError,
      updatedAt: new Date().toISOString(),
    });
    return status;
  }

  public async removeVoiceRuntimeModel(modelId: string): Promise<VoiceRuntimeStatus> {
    const status = await removeManagedVoiceModel(this.storage.systemSettings, modelId);
    this.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
      ...(this.storage.systemSettings.get<VoiceStatus["stt"]>(VOICE_STATUS_SETTING_KEY)?.value ?? {
        state: "stopped" as const,
        provider: DEFAULT_VOICE_PROVIDER,
        updatedAt: new Date().toISOString(),
      }),
      provider: DEFAULT_VOICE_PROVIDER,
      runtimeReady: status.readiness === "ready",
      modelId: status.selectedModelId,
      lastError: status.lastError,
      updatedAt: new Date().toISOString(),
    });
    return status;
  }

  public startTalkSession(input?: { mode?: "push_to_talk" | "wake"; sessionId?: string }): VoiceTalkSessionRecord {
    const now = new Date().toISOString();
    const record: VoiceTalkSessionRecord = {
      talkSessionId: randomUUID(),
      mode: input?.mode ?? "push_to_talk",
      state: "running",
      createdAt: now,
      startedAt: now,
      sessionId: input?.sessionId,
    };
    this.gatewaySql.prepare(`
      INSERT INTO voice_sessions (
        voice_session_id, talk_session_id, mode, state, session_id, payload_json, created_at, updated_at
      ) VALUES (
        @voiceSessionId, @talkSessionId, @mode, @state, @sessionId, @payloadJson, @createdAt, @updatedAt
      )
    `).run({
      voiceSessionId: record.talkSessionId,
      talkSessionId: record.talkSessionId,
      mode: record.mode,
      state: record.state,
      sessionId: record.sessionId ?? null,
      payloadJson: JSON.stringify(record),
      createdAt: now,
      updatedAt: now,
    });
    this.storage.systemSettings.set("voice_talk_status_v1", {
      activeSessionId: record.talkSessionId,
      state: "running",
      mode: record.mode,
      updatedAt: now,
    });
    this.publishRealtime("system", "voice", {
      type: "voice_talk_started",
      talkSessionId: record.talkSessionId,
      mode: record.mode,
    });
    return record;
  }

  public stopTalkSession(talkSessionId: string): VoiceTalkSessionRecord {
    const now = new Date().toISOString();
    const row = this.gatewaySql.prepare(`
      SELECT payload_json FROM voice_sessions WHERE talk_session_id = ?
    `).get(talkSessionId) as { payload_json: string } | undefined;
    if (!row) {
      throw new Error(`Unknown talk session: ${talkSessionId}`);
    }
    const payload = safeJsonParse<VoiceTalkSessionRecord>(row.payload_json, {
      talkSessionId,
      mode: "push_to_talk",
      state: "running",
      createdAt: now,
    });
    const stopped: VoiceTalkSessionRecord = {
      ...payload,
      state: "stopped",
      stoppedAt: now,
    };
    this.gatewaySql.prepare(`
      UPDATE voice_sessions
      SET state = 'stopped', payload_json = @payloadJson, updated_at = @updatedAt
      WHERE talk_session_id = @talkSessionId
    `).run({
      payloadJson: JSON.stringify(stopped),
      updatedAt: now,
      talkSessionId,
    });
    this.storage.systemSettings.set("voice_talk_status_v1", {
      activeSessionId: undefined,
      state: "stopped",
      mode: stopped.mode,
      updatedAt: now,
    });
    this.publishRealtime("system", "voice", {
      type: "voice_talk_stopped",
      talkSessionId,
    });
    return stopped;
  }

  public startVoiceWake(): VoiceStatus["wake"] {
    const status: VoiceStatus["wake"] = {
      enabled: true,
      state: "running",
      model: "openwakeword",
      updatedAt: new Date().toISOString(),
    };
    this.storage.systemSettings.set(VOICE_WAKE_STATUS_SETTING_KEY, status);
    this.publishRealtime("system", "voice", {
      type: "voice_wake_started",
    });
    return status;
  }

  public stopVoiceWake(): VoiceStatus["wake"] {
    const status: VoiceStatus["wake"] = {
      enabled: false,
      state: "stopped",
      model: "openwakeword",
      updatedAt: new Date().toISOString(),
    };
    this.storage.systemSettings.set(VOICE_WAKE_STATUS_SETTING_KEY, status);
    this.publishRealtime("system", "voice", {
      type: "voice_wake_stopped",
    });
    return status;
  }

  public getDaemonStatus(): {
    running: boolean;
    pid: number;
    uptimeSeconds: number;
    host: string;
    state: "running" | "stopped";
    lastCommandAt?: string;
  } {
    const state = this.storage.systemSettings.get<{ state: "running" | "stopped"; lastCommandAt?: string }>("daemon_state_v1")?.value;
    return {
      running: (state?.state ?? "running") === "running",
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      host: os.hostname(),
      state: state?.state ?? "running",
      lastCommandAt: state?.lastCommandAt,
    };
  }

  public daemonStart(): { accepted: boolean; status: ReturnType<GatewayService["getDaemonStatus"]> } {
    const now = new Date().toISOString();
    this.storage.systemSettings.set("daemon_state_v1", {
      state: "running" as const,
      lastCommandAt: now,
    });
    this.appendDaemonLog("start", { at: now });
    return {
      accepted: true,
      status: this.getDaemonStatus(),
    };
  }

  public daemonStop(): { accepted: boolean; status: ReturnType<GatewayService["getDaemonStatus"]> } {
    const now = new Date().toISOString();
    this.storage.systemSettings.set("daemon_state_v1", {
      state: "stopped" as const,
      lastCommandAt: now,
    });
    this.appendDaemonLog("stop", { at: now });
    return {
      accepted: true,
      status: this.getDaemonStatus(),
    };
  }

  public daemonRestart(): { accepted: boolean; status: ReturnType<GatewayService["getDaemonStatus"]> } {
    const now = new Date().toISOString();
    this.storage.systemSettings.set("daemon_state_v1", {
      state: "running" as const,
      lastCommandAt: now,
    });
    this.appendDaemonLog("restart", { at: now });
    return {
      accepted: true,
      status: this.getDaemonStatus(),
    };
  }

  public listDaemonLogs(tail = 200): Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }> {
    const rows = this.storage.systemSettings.get<Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }>>(
      DAEMON_LOG_TAIL_SETTING_KEY,
    )?.value ?? [];
    const bounded = Math.max(1, Math.min(2000, Math.floor(tail)));
    return rows.slice(-bounded);
  }

  public async commsSend(input: ChannelSendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return this.invokeAndUnwrap(
      {
        toolName: "channel.send",
        args: {
          connectionId: input.connectionId,
          target: input.target,
          message: input.message,
          attachments: input.attachments,
        },
        sessionId: input.sessionId ?? "session:operator:comms",
        agentId: input.agentId ?? "operator",
        taskId: input.taskId,
      },
      "comms_send",
    );
  }

  public async commsGmailRead(input: GmailReadQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
    return this.invokeAndUnwrap(
      {
        toolName: "gmail.read",
        args: {
          connectionId: input.connectionId,
          query: input.query,
          maxResults: input.maxResults,
        },
        sessionId: input.sessionId ?? "session:operator:comms",
        agentId: input.agentId ?? "operator",
        taskId: input.taskId,
      },
      "comms_gmail_read",
    );
  }

  public async commsGmailSend(input: GmailSendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return this.invokeAndUnwrap(
      {
        toolName: "gmail.send",
        args: {
          connectionId: input.connectionId,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          bodyText: input.bodyText,
          bodyHtml: input.bodyHtml,
        },
        sessionId: input.sessionId ?? "session:operator:comms",
        agentId: input.agentId ?? "operator",
        taskId: input.taskId,
      },
      "comms_gmail_send",
    );
  }

  public async commsCalendarList(input: CalendarListQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
    return this.invokeAndUnwrap(
      {
        toolName: "calendar.list",
        args: {
          connectionId: input.connectionId,
          calendarId: input.calendarId,
          fromIso: input.fromIso,
          toIso: input.toIso,
          maxResults: input.maxResults,
        },
        sessionId: input.sessionId ?? "session:operator:comms",
        agentId: input.agentId ?? "operator",
        taskId: input.taskId,
      },
      "comms_calendar_list",
    );
  }

  public async commsCalendarCreate(input: CalendarCreateEventInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return this.invokeAndUnwrap(
      {
        toolName: "calendar.create_event",
        args: {
          connectionId: input.connectionId,
          calendarId: input.calendarId,
          title: input.title,
          description: input.description,
          startIso: input.startIso,
          endIso: input.endIso,
          attendees: input.attendees,
          timeZone: input.timeZone,
        },
        sessionId: input.sessionId ?? "session:operator:comms",
        agentId: input.agentId ?? "operator",
        taskId: input.taskId,
      },
      "comms_calendar_create",
    );
  }

  public async knowledgeMemoryWrite(input: MemoryWriteInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return this.invokeAndUnwrap(
      {
        toolName: "memory.write",
        args: {
          namespace: input.namespace,
          title: input.title,
          content: input.content,
          tags: input.tags,
          metadata: input.metadata,
          source: input.source,
        },
        sessionId: input.sessionId ?? "session:operator:knowledge",
        agentId: input.agentId ?? "operator",
        taskId: input.taskId,
      },
      "knowledge_memory_write",
    );
  }

  public async knowledgeMemorySearch(input: MemorySearchQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
    return this.invokeAndUnwrap(
      {
        toolName: "memory.search",
        args: {
          namespace: input.namespace,
          query: input.query,
          limit: input.limit,
          filters: input.filters,
        },
        sessionId: input.sessionId ?? "session:operator:knowledge",
        agentId: input.agentId ?? "operator",
        taskId: input.taskId,
      },
      "knowledge_memory_search",
    );
  }

  public async knowledgeDocsIngest(input: DocsIngestInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return this.invokeAndUnwrap(
      {
        toolName: "docs.ingest",
        args: {
          sourceType: input.sourceType,
          source: input.source,
          namespace: input.namespace,
          title: input.title,
          chunking: input.chunking,
          metadata: input.metadata,
        },
        sessionId: input.sessionId ?? "session:operator:knowledge",
        agentId: input.agentId ?? "operator",
        taskId: input.taskId,
      },
      "knowledge_docs_ingest",
    );
  }

  public async knowledgeEmbeddingsIndex(input: EmbeddingIndexInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return this.invokeAndUnwrap(
      {
        toolName: "embeddings.index",
        args: {
          namespace: input.namespace,
          documentId: input.documentId,
          force: input.force,
        },
        sessionId: input.sessionId ?? "session:operator:knowledge",
        agentId: input.agentId ?? "operator",
        taskId: input.taskId,
      },
      "knowledge_embeddings_index",
    );
  }

  public async knowledgeEmbeddingsQuery(input: EmbeddingQueryInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return this.invokeAndUnwrap(
      {
        toolName: "embeddings.query",
        args: {
          namespace: input.namespace,
          query: input.query,
          limit: input.limit,
        },
        sessionId: input.sessionId ?? "session:operator:knowledge",
        agentId: input.agentId ?? "operator",
        taskId: input.taskId,
      },
      "knowledge_embeddings_query",
    );
  }

  public getMeshStatus(): MeshStatus {
    return this.meshService.status();
  }

  public listMeshNodes(limit = 200): MeshNodeRecord[] {
    return this.meshService.listNodes(limit);
  }

  public meshJoin(input: MeshJoinRequest): MeshJoinResult {
    const joined = this.meshService.join(input);
    this.publishRealtime("system", "mesh", {
      type: "mesh_node_joined",
      nodeId: joined.node.nodeId,
      transport: joined.node.transport,
      advertiseAddress: joined.node.advertiseAddress,
    });
    return joined;
  }

  public acquireMeshLease(input: MeshLeaseAcquireRequest): MeshLeaseRecord {
    const lease = this.meshService.acquireLease(input);
    this.publishRealtime("system", "mesh", {
      type: "mesh_lease_acquired",
      leaseKey: lease.leaseKey,
      holderNodeId: lease.holderNodeId,
      fencingToken: lease.fencingToken,
      expiresAt: lease.expiresAt,
    });
    return lease;
  }

  public renewMeshLease(input: MeshLeaseRenewRequest): MeshLeaseRecord {
    const lease = this.meshService.renewLease(input);
    this.publishRealtime("system", "mesh", {
      type: "mesh_lease_renewed",
      leaseKey: lease.leaseKey,
      holderNodeId: lease.holderNodeId,
      fencingToken: lease.fencingToken,
      expiresAt: lease.expiresAt,
    });
    return lease;
  }

  public releaseMeshLease(input: MeshLeaseReleaseRequest): { released: boolean } {
    const result = this.meshService.releaseLease(input);
    this.publishRealtime("system", "mesh", {
      type: "mesh_lease_released",
      leaseKey: input.leaseKey,
      holderNodeId: input.holderNodeId,
      fencingToken: input.fencingToken,
      released: result.released,
    });
    return result;
  }

  public claimMeshSessionOwner(sessionId: string, input: MeshSessionClaimRequest): MeshSessionOwnerRecord {
    const owner = this.meshService.claimSessionOwner(sessionId, input);
    this.publishRealtime("system", "mesh", {
      type: "mesh_session_claimed",
      sessionId,
      ownerNodeId: owner.ownerNodeId,
      epoch: owner.epoch,
    });
    return owner;
  }

  public getMeshSessionOwner(sessionId: string): MeshSessionOwnerRecord {
    return this.meshService.getSessionOwner(sessionId);
  }

  public ingestMeshReplicationEvent(input: MeshReplicationIngestRequest): MeshReplicationRecord {
    const event = this.meshService.ingestReplicationEvent(input);
    this.publishRealtime("system", "mesh", {
      type: "mesh_replication_event",
      replicationId: event.replicationId,
      sourceNodeId: event.sourceNodeId,
      eventType: event.eventType,
      idempotencyKey: event.idempotencyKey,
    });
    return event;
  }

  public listMeshLeases(limit = 200): MeshLeaseRecord[] {
    return this.meshService.listLeases(limit);
  }

  public listMeshSessionOwners(limit = 500): MeshSessionOwnerRecord[] {
    return this.meshService.listSessionOwners(limit);
  }

  public listMeshReplicationEvents(limit = 200, cursor?: string): MeshReplicationRecord[] {
    return this.meshService.listReplicationEvents(limit, cursor);
  }

  public listMeshReplicationOffsets(limit = 500): MeshReplicationOffset[] {
    return this.meshService.listReplicationOffsets(limit);
  }

  public async ingestChannelMessage(
    channel: string,
    idempotencyKey: string,
    input: ChannelInboundMessageInput,
  ): Promise<GatewayEventResult> {
    const payload: GatewayEventInput = {
      eventId: input.eventId ?? `channel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      route: {
        channel,
        account: input.account,
        peer: input.peer,
        room: input.room,
        threadId: input.threadId,
      },
      actor: {
        type: input.actorType ?? "user",
        id: input.actorId,
      },
      message: {
        role: input.role ?? "user",
        content: input.content,
      },
      usage: input.usage,
    };

    const result = await this.ingestEvent(idempotencyKey, payload);
    this.publishRealtime("system", "channels", {
      type: "channel_message_ingested",
      channel,
      eventId: payload.eventId,
      sessionId: result.session.sessionId,
      account: input.account,
      actorId: input.actorId,
    });
    return result;
  }

  public listLlmProviders(): LlmRuntimeConfig["providers"] {
    return this.llmService.listProviders();
  }

  public getProviderSecretStatus(providerId: string): {
    providerId: string;
    hasSecret: boolean;
    source: "none" | "keychain" | "env" | "inline";
  } {
    const status = this.llmService.getProviderSecretStatus(providerId);
    return {
      providerId: status.providerId,
      hasSecret: status.hasApiKey,
      source: status.apiKeySource,
    };
  }

  public saveProviderSecret(providerId: string, apiKey: string): {
    providerId: string;
    hasSecret: boolean;
    source: "none" | "keychain" | "env" | "inline";
  } {
    this.llmService.setProviderApiKey(providerId, apiKey);
    this.llmService.clearInlineProviderApiKey(providerId);
    this.persistLlmConfig();
    return this.getProviderSecretStatus(providerId);
  }

  public deleteProviderSecret(providerId: string): {
    providerId: string;
    hasSecret: boolean;
    source: "none" | "keychain" | "env" | "inline";
  } {
    this.llmService.deleteProviderApiKey(providerId);
    return this.getProviderSecretStatus(providerId);
  }

  public getLlmConfig(): LlmRuntimeConfig {
    return this.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
  }

  public updateLlmConfig(input: {
    activeProviderId?: string;
    activeModel?: string;
    upsertProvider?: {
      providerId: string;
      label?: string;
      baseUrl?: string;
      defaultModel?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      headers?: Record<string, string>;
    };
  }): LlmRuntimeConfig {
    const updated = this.llmService.updateRuntimeConfig(input);
    this.persistLlmConfig();
    return updated;
  }

  public async listLlmModels(providerId?: string): Promise<LlmModelRecord[]> {
    return this.llmService.listModels(providerId);
  }

  public async createAssemblyRun(input: CreateAssemblyRunInput): Promise<AssemblyRunRecord> {
    return this.assemblyService.createRun(input);
  }

  public listAssemblyRuns(limit = 50): AssemblyRunRecord[] {
    return this.assemblyService.listRuns(limit);
  }

  public getAssemblyRunDetail(runId: string): AssemblyRunDetailResponse {
    return this.assemblyService.getRunDetail(runId);
  }

  public listAssemblyReputations(limit = 50): ModelReputation[] {
    return this.assemblyService.listReputations(limit);
  }

  public async previewLlmModels(input: {
    providerId: string;
    baseUrl: string;
    apiKey?: string;
    apiKeyEnv?: string;
    headers?: Record<string, string>;
  }): Promise<{ items: LlmModelRecord[]; source: "remote" | "fallback"; warning?: string }> {
    return this.llmService.previewModels(input);
  }

  public getNpuStatus(): NpuRuntimeStatus {
    return this.npuSidecar.getStatus();
  }

  public async startNpuRuntime(): Promise<NpuRuntimeStatus> {
    const status = await this.npuSidecar.start("api");
    this.publishRealtime("system", "npu", {
      type: "npu_started",
      status,
    });
    return status;
  }

  public async stopNpuRuntime(): Promise<NpuRuntimeStatus> {
    const status = await this.npuSidecar.stop("api");
    this.publishRealtime("system", "npu", {
      type: "npu_stopped",
      status,
    });
    return status;
  }

  public async refreshNpuRuntime(): Promise<NpuRuntimeStatus> {
    const status = await this.npuSidecar.refresh();
    this.publishRealtime("system", "npu", {
      type: "npu_refreshed",
      status,
    });
    return status;
  }

  public async listNpuModels(): Promise<NpuModelManifest[]> {
    return this.npuSidecar.listModels();
  }

  public async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    this.recordDevDiagnostic({
      level: "debug",
      category: "chat",
      event: "chat.completion.start",
      message: "Starting chat completion",
      sessionId: request.memory?.sessionId,
      providerId: request.providerId,
      modelId: request.model,
      context: {
        messageCount: request.messages.length,
        stream: request.stream ?? false,
      },
    });
    let response: ChatCompletionResponse | undefined;
    let memoryContext: MemoryContextPack | undefined;
    const memoryInput = request.memory;
    const useQmd = (
      this.config.assistant.memory.enabled
      && this.config.assistant.memory.qmd.enabled
      && this.config.assistant.memory.qmd.applyToChat
      && memoryInput?.mode !== "off"
      && (memoryInput?.enabled ?? true)
    );

    if (useQmd) {
      const prompt = extractPromptFromMessages(request.messages);
      if (prompt.trim()) {
        memoryContext = await this.memoryContextService.compose({
          scope: "chat",
          prompt,
          sessionId: memoryInput?.sessionId,
          taskId: memoryInput?.taskId,
          workspace: memoryInput?.workspace,
          maxContextTokens: memoryInput?.maxContextTokens,
          forceRefresh: memoryInput?.forceRefresh,
        });
      }
    }

    const withContext = memoryContext
      ? {
        ...request,
        messages: [
          {
            role: "system" as const,
            content: buildMemoryContextSystemMessage(memoryContext),
          },
          ...request.messages,
        ],
      }
      : request;

    const runtime = this.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
    const primaryProviderId = withContext.providerId ?? runtime.activeProviderId;
    const primaryProvider = runtime.providers.find((item) => item.providerId === primaryProviderId);
    const primaryModel = withContext.model
      ?? primaryProvider?.defaultModel
      ?? runtime.activeModel;
    const allowCrossProviderFallback = shouldAllowCrossProviderFallback(withContext);
    const routing: ChatTurnTraceRecord["routing"] = {
      primaryProviderId,
      primaryModel,
      effectiveProviderId: primaryProviderId,
      effectiveModel: primaryModel,
      fallbackUsed: false,
    };

    const retryAttempts = [
      withContext,
      normalizeToolProtocolRetryRequest(withContext, 1),
      normalizeToolProtocolRetryRequest(withContext, 2),
    ];
    const completionDeadline = createChatCompletionDeadline(withContext.timeoutMs);
    let lastError: Error | undefined;

    for (let index = 0; index < retryAttempts.length; index += 1) {
      const attemptRequest = retryAttempts[index]!;
      try {
        const attemptTimeoutMs = getRemainingChatCompletionTimeoutMs(completionDeadline, withContext.timeoutMs);
        response = await this.llmService.chatCompletions({
          ...attemptRequest,
          timeoutMs: attemptTimeoutMs ?? attemptRequest.timeoutMs,
        });
        routing.effectiveProviderId = attemptRequest.providerId ?? primaryProviderId;
        routing.effectiveModel = response.model ?? attemptRequest.model ?? primaryModel;
        if (index > 0) {
          routing.fallbackUsed = true;
          routing.fallbackProviderId = routing.effectiveProviderId;
          routing.fallbackModel = routing.effectiveModel;
          routing.fallbackReason = index === 1
            ? "provider compatibility retry (normalized tool protocol)"
            : "provider compatibility retry (minimal thinking metadata)";
        }
        break;
      } catch (error) {
        lastError = normalizeChatCompletionAttemptError(error, withContext.timeoutMs);
        this.recordDevDiagnostic({
          level: "warn",
          category: "chat",
          event: "chat.completion.attempt_failed",
          message: "Chat completion attempt failed",
          sessionId: request.memory?.sessionId,
          providerId: attemptRequest.providerId ?? primaryProviderId,
          modelId: attemptRequest.model ?? primaryModel,
          context: {
            error: lastError.message,
            retryIndex: index,
          },
        });
        if (index < retryAttempts.length - 1 && shouldRetryToolProtocolError(lastError)) {
          continue;
        }
        if (index < retryAttempts.length - 1 && index === 0) {
          continue;
        }
      }
    }

    if (!response && allowCrossProviderFallback) {
      const fallbacks = this.resolveFallbackTargets(runtime, primaryProviderId, primaryModel);
      for (const fallback of fallbacks) {
        try {
          const attemptTimeoutMs = getRemainingChatCompletionTimeoutMs(completionDeadline, withContext.timeoutMs);
          response = await this.llmService.chatCompletions({
            ...normalizeToolProtocolRetryRequest(withContext, 2),
            providerId: fallback.providerId,
            model: fallback.model,
            timeoutMs: attemptTimeoutMs ?? withContext.timeoutMs,
          });
          this.recordDevDiagnostic({
            level: "info",
            category: "chat",
            event: "chat.completion.fallback_applied",
            message: "Applied cross-provider fallback",
            sessionId: request.memory?.sessionId,
            providerId: fallback.providerId,
            modelId: fallback.model,
            context: {
              reason: lastError?.message,
            },
          });
          routing.fallbackUsed = true;
          routing.fallbackProviderId = fallback.providerId;
          routing.fallbackModel = response.model ?? fallback.model;
          routing.fallbackReason = `primary failed (${lastError?.message ?? "unknown error"})`;
          routing.effectiveProviderId = fallback.providerId;
          routing.effectiveModel = routing.fallbackModel;
          break;
        } catch (error) {
          lastError = normalizeChatCompletionAttemptError(error, withContext.timeoutMs);
        }
      }
    }

    if (!response) {
      this.recordDevDiagnostic({
        level: "error",
        category: "chat",
        event: "chat.completion.failed",
        message: "Chat completion failed",
        sessionId: request.memory?.sessionId,
        providerId: primaryProviderId,
        modelId: primaryModel,
        context: {
          error: lastError?.message,
        },
      });
      throw lastError ?? new Error("chat completion failed");
    }
    this.recordDevDiagnostic({
      level: "info",
      category: "chat",
      event: "chat.completion.complete",
      message: "Chat completion completed",
      sessionId: request.memory?.sessionId,
      providerId: routing.effectiveProviderId ?? primaryProviderId,
      modelId: routing.effectiveModel ?? primaryModel,
      context: {
        fallbackUsed: routing.fallbackUsed,
      },
    });

    this.publishRealtime("system", "llm", {
      type: "chat_completion",
      providerId: routing.effectiveProviderId ?? primaryProviderId,
      model: routing.effectiveModel ?? primaryModel,
      messageCount: request.messages.length,
      stream: request.stream ?? false,
      memoryContextId: memoryContext?.contextId,
      memoryQmdStatus: memoryContext?.quality.status,
      fallbackUsed: routing.fallbackUsed,
      fallbackProviderId: routing.fallbackProviderId,
      fallbackModel: routing.fallbackModel,
      fallbackReason: routing.fallbackReason,
    });

    if (memoryContext) {
      response.memoryContext = {
        contextId: memoryContext.contextId,
        cacheHit: memoryContext.quality.status === "cache_hit",
        originalTokenEstimate: memoryContext.originalTokenEstimate,
        distilledTokenEstimate: memoryContext.distilledTokenEstimate,
        savingsPercent: calculateSavings(
          memoryContext.originalTokenEstimate,
          memoryContext.distilledTokenEstimate,
        ),
        citationsCount: memoryContext.citations.length,
      };
    }
    response.routing = routing;
    return response;
  }

  public async *createChatCompletionStream(request: ChatCompletionRequest): AsyncGenerator<Record<string, unknown>> {
    let memoryContext: MemoryContextPack | undefined;
    const memoryInput = request.memory;
    const useQmd = (
      this.config.assistant.memory.enabled
      && this.config.assistant.memory.qmd.enabled
      && this.config.assistant.memory.qmd.applyToChat
      && memoryInput?.mode !== "off"
      && (memoryInput?.enabled ?? true)
    );

    if (useQmd) {
      const prompt = extractPromptFromMessages(request.messages);
      if (prompt.trim()) {
        memoryContext = await this.memoryContextService.compose({
          scope: "chat",
          prompt,
          sessionId: memoryInput?.sessionId,
          taskId: memoryInput?.taskId,
          workspace: memoryInput?.workspace,
          maxContextTokens: memoryInput?.maxContextTokens,
          forceRefresh: memoryInput?.forceRefresh,
        });
      }
    }

    const withContext = memoryContext
      ? {
        ...request,
        messages: [
          {
            role: "system" as const,
            content: buildMemoryContextSystemMessage(memoryContext),
          },
          ...request.messages,
        ],
      }
      : request;

    const runtime = this.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
    const primaryProviderId = withContext.providerId ?? runtime.activeProviderId;
    const primaryProvider = runtime.providers.find((item) => item.providerId === primaryProviderId);
    const primaryModel = withContext.model
      ?? primaryProvider?.defaultModel
      ?? runtime.activeModel;
    const allowCrossProviderFallback = shouldAllowCrossProviderFallback(withContext);
    const routing: ChatTurnTraceRecord["routing"] = {
      primaryProviderId,
      primaryModel,
      effectiveProviderId: primaryProviderId,
      effectiveModel: primaryModel,
      fallbackUsed: false,
    };

    const retryAttempts = [
      withContext,
      normalizeToolProtocolRetryRequest(withContext, 1),
      normalizeToolProtocolRetryRequest(withContext, 2),
    ];
    const completionDeadline = createChatCompletionDeadline(withContext.timeoutMs);
    let streamed = false;
    let lastError: Error | undefined;

    for (let index = 0; index < retryAttempts.length; index += 1) {
      const attemptRequest = retryAttempts[index]!;
      try {
        const attemptTimeoutMs = getRemainingChatCompletionTimeoutMs(completionDeadline, withContext.timeoutMs);
        for await (const chunk of this.llmService.chatCompletionsStream({
          ...attemptRequest,
          stream: true,
          timeoutMs: attemptTimeoutMs ?? attemptRequest.timeoutMs,
        })) {
          streamed = true;
          yield chunk;
        }
        routing.effectiveProviderId = attemptRequest.providerId ?? primaryProviderId;
        routing.effectiveModel = attemptRequest.model ?? primaryModel;
        if (index > 0) {
          routing.fallbackUsed = true;
          routing.fallbackProviderId = routing.effectiveProviderId;
          routing.fallbackModel = routing.effectiveModel;
          routing.fallbackReason = index === 1
            ? "provider compatibility retry (normalized tool protocol)"
            : "provider compatibility retry (minimal thinking metadata)";
        }
        break;
      } catch (error) {
        lastError = normalizeChatCompletionAttemptError(error, withContext.timeoutMs);
        if (index < retryAttempts.length - 1 && shouldRetryToolProtocolError(lastError)) {
          continue;
        }
      }
    }

    if (!streamed && allowCrossProviderFallback) {
      const fallbacks = this.resolveFallbackTargets(runtime, primaryProviderId, primaryModel);
      for (const fallback of fallbacks) {
        try {
          const attemptTimeoutMs = getRemainingChatCompletionTimeoutMs(completionDeadline, withContext.timeoutMs);
          for await (const chunk of this.llmService.chatCompletionsStream({
            ...normalizeToolProtocolRetryRequest(withContext, 2),
            providerId: fallback.providerId,
            model: fallback.model,
            stream: true,
            timeoutMs: attemptTimeoutMs ?? withContext.timeoutMs,
          })) {
            streamed = true;
            yield chunk;
          }
          routing.fallbackUsed = true;
          routing.fallbackProviderId = fallback.providerId;
          routing.fallbackModel = fallback.model;
          routing.fallbackReason = `primary failed (${lastError?.message ?? "unknown error"})`;
          routing.effectiveProviderId = fallback.providerId;
          routing.effectiveModel = fallback.model;
          break;
        } catch (error) {
          lastError = normalizeChatCompletionAttemptError(error, withContext.timeoutMs);
        }
      }
    }

    if (!streamed) {
      throw lastError ?? new Error("chat completion stream failed");
    }

    this.publishRealtime("system", "llm", {
      type: "chat_completion_stream",
      providerId: routing.effectiveProviderId ?? primaryProviderId,
      model: routing.effectiveModel ?? primaryModel,
      messageCount: request.messages.length,
      stream: true,
      memoryContextId: memoryContext?.contextId,
      memoryQmdStatus: memoryContext?.quality.status,
      fallbackUsed: routing.fallbackUsed,
      fallbackProviderId: routing.fallbackProviderId,
      fallbackModel: routing.fallbackModel,
      fallbackReason: routing.fallbackReason,
    });

    const finalChunk: Record<string, unknown> = {
      routing,
    };
    if (memoryContext) {
      finalChunk.memoryContext = {
        contextId: memoryContext.contextId,
        cacheHit: memoryContext.quality.status === "cache_hit",
        originalTokenEstimate: memoryContext.originalTokenEstimate,
        distilledTokenEstimate: memoryContext.distilledTokenEstimate,
        savingsPercent: calculateSavings(
          memoryContext.originalTokenEstimate,
          memoryContext.distilledTokenEstimate,
        ),
        citationsCount: memoryContext.citations.length,
      };
    }
    yield finalChunk;
  }

  private resolveFallbackTargets(
    runtime: LlmRuntimeConfig,
    primaryProviderId: string,
    primaryModel: string,
  ): Array<{ providerId: string; model: string }> {
    const candidates: Array<{ providerId: string; model: string }> = [];
    const pushCandidate = (providerId?: string, model?: string) => {
      if (!providerId || !model) {
        return;
      }
      if (providerId === primaryProviderId && model === primaryModel) {
        return;
      }
      if (candidates.some((item) => item.providerId === providerId && item.model === model)) {
        return;
      }
      const provider = runtime.providers.find((item) => item.providerId === providerId);
      if (!provider || !provider.hasApiKey) {
        return;
      }
      candidates.push({ providerId, model });
    };

    const active = runtime.providers.find((provider) => provider.providerId === runtime.activeProviderId);
    pushCandidate(active?.providerId, runtime.activeModel || active?.defaultModel);
    const kimi = runtime.providers.find((provider) => provider.providerId === "moonshot");
    pushCandidate(kimi?.providerId, kimi?.defaultModel);
    return candidates;
  }

  public createOrchestrationPlan(plan: OrchestrationPlan): OrchestrationRun {
    this.storage.orchestration.upsertPlan(plan);
    const run = this.orchestrationEngine.createRun(plan);
    const persisted = this.storage.orchestration.createRun(run);

    this.createCheckpoint({
      runId: persisted.runId,
      planId: persisted.planId,
      checkpointKind: "run_created",
      details: { status: persisted.status },
    });

    this.storage.orchestration.appendRunEvent(persisted.runId, "run.created", {
      status: persisted.status,
    });

    this.publishRealtime("orchestration_event", "orchestration", {
      runId: persisted.runId,
      planId: persisted.planId,
      event: "run_created",
      status: persisted.status,
    });

    return persisted;
  }

  public runOrchestrationPlan(planId: string): OrchestrationRun {
    const plan = this.storage.orchestration.getPlan(planId);
    let run = this.storage.orchestration.findLatestRunByPlan(planId);

    if (!run) {
      run = this.createOrchestrationPlan(plan);
    }

    const started = this.orchestrationEngine.startRun(plan, run);
    const persisted = this.storage.orchestration.updateRun(started);

    this.createCheckpoint({
      runId: persisted.runId,
      planId,
      waveId: persisted.currentWaveId,
      phaseId: persisted.currentPhaseId,
      checkpointKind: "run_started",
      details: {
        status: persisted.status,
      },
    });

    this.storage.orchestration.appendRunEvent(persisted.runId, "run.started", {
      status: persisted.status,
      waveId: persisted.currentWaveId,
      phaseId: persisted.currentPhaseId,
    });

    this.publishRealtime("orchestration_event", "orchestration", {
      runId: persisted.runId,
      planId,
      event: "run_started",
      status: persisted.status,
      waveId: persisted.currentWaveId,
      phaseId: persisted.currentPhaseId,
    });

    if (this.config.assistant.memory.enabled && this.config.assistant.memory.qmd.applyToOrchestration) {
      this.scheduleOrchestrationMemoryContext(plan, persisted);
    }

    return persisted;
  }

  public approvePhase(
    runId: string,
    phaseId: string,
    approvedBy: string,
    costIncrementUsd = 0,
  ): { run: OrchestrationRun; checkpoints: OrchestrationCheckpoint[] } {
    const run = this.storage.orchestration.getRun(runId);
    const plan = this.storage.orchestration.getPlan(run.planId);
    const previousWaveId = run.currentWaveId;

    const next = this.orchestrationEngine.approvePhase(plan, run, phaseId, {
      costIncrementUsd,
    });

    const persisted = this.storage.orchestration.updateRun(next);

    this.createCheckpoint({
      runId,
      planId: plan.planId,
      waveId: previousWaveId,
      phaseId,
      checkpointKind: "phase_approved",
      details: {
        approvedBy,
        status: persisted.status,
        nextWaveId: persisted.currentWaveId,
        nextPhaseId: persisted.currentPhaseId,
      },
    });

    if (previousWaveId !== persisted.currentWaveId && persisted.currentWaveId) {
      this.createCheckpoint({
        runId,
        planId: plan.planId,
        waveId: persisted.currentWaveId,
        phaseId: persisted.currentPhaseId,
        checkpointKind: "wave_advanced",
        details: {
          fromWave: previousWaveId,
          toWave: persisted.currentWaveId,
        },
      });
    }

    if (persisted.status === "completed") {
      this.createCheckpoint({
        runId,
        planId: plan.planId,
        checkpointKind: "run_completed",
        details: {
          totalIterations: persisted.totalIterations,
          totalCostUsd: persisted.totalCostUsd,
        },
      });
    }

    if (persisted.status === "stopped_by_limit") {
      this.createCheckpoint({
        runId,
        planId: plan.planId,
        checkpointKind: "run_stopped",
        details: {
          totalIterations: persisted.totalIterations,
          totalCostUsd: persisted.totalCostUsd,
        },
      });
    }

    this.storage.orchestration.appendRunEvent(runId, "phase.approved", {
      approvedBy,
      phaseId,
      status: persisted.status,
      currentWaveId: persisted.currentWaveId,
      currentPhaseId: persisted.currentPhaseId,
      totalIterations: persisted.totalIterations,
      totalCostUsd: persisted.totalCostUsd,
    });

    this.publishRealtime("orchestration_event", "orchestration", {
      runId,
      planId: plan.planId,
      event: "phase_approved",
      phaseId,
      approvedBy,
      status: persisted.status,
      currentWaveId: persisted.currentWaveId,
      currentPhaseId: persisted.currentPhaseId,
    });

    if (this.config.assistant.memory.enabled && this.config.assistant.memory.qmd.applyToOrchestration) {
      this.scheduleOrchestrationMemoryContext(plan, persisted);
    }

    return {
      run: persisted,
      checkpoints: this.storage.orchestration.listCheckpoints(runId),
    };
  }

  public getRun(runId: string): OrchestrationRun {
    return this.storage.orchestration.getRun(runId);
  }

  public listRunCheckpoints(runId: string): OrchestrationCheckpoint[] {
    return this.storage.orchestration.listCheckpoints(runId);
  }

  public getBankrOptionalMigrationMessage(): string {
    return BANKR_OPTIONAL_MIGRATION_MESSAGE;
  }

  public isFeatureEnabled(flag: keyof RuntimeSettings["features"]): boolean {
    return this.readFeatureFlags()[flag];
  }

  public requireFeatureEnabled(flag: keyof RuntimeSettings["features"]): void {
    if (!this.isFeatureEnabled(flag)) {
      throw new Error(`Feature flag ${flag} is disabled.`);
    }
  }

  private requireBankrBuiltinEnabled(): void {
    if (!this.isFeatureEnabled("bankrBuiltinEnabled")) {
      throw new Error(BANKR_OPTIONAL_MIGRATION_MESSAGE);
    }
  }

  public updateFeatureFlags(patch: Partial<RuntimeSettings["features"]>): RuntimeSettings["features"] {
    const current = this.readFeatureFlags();
    const next: RuntimeSettings["features"] = {
      durableKernelV1Enabled: patch.durableKernelV1Enabled ?? current.durableKernelV1Enabled,
      replayOverridesV1Enabled: patch.replayOverridesV1Enabled ?? current.replayOverridesV1Enabled,
      memoryLifecycleAdminV1Enabled: patch.memoryLifecycleAdminV1Enabled ?? current.memoryLifecycleAdminV1Enabled,
      connectorDiagnosticsV1Enabled: patch.connectorDiagnosticsV1Enabled ?? current.connectorDiagnosticsV1Enabled,
      computerUseGuardrailsV1Enabled: patch.computerUseGuardrailsV1Enabled ?? current.computerUseGuardrailsV1Enabled,
      bankrBuiltinEnabled: patch.bankrBuiltinEnabled ?? current.bankrBuiltinEnabled,
      cronReviewQueueV1Enabled: patch.cronReviewQueueV1Enabled ?? current.cronReviewQueueV1Enabled,
      replayRegressionV1Enabled: patch.replayRegressionV1Enabled ?? current.replayRegressionV1Enabled,
    };
    this.storage.systemSettings.set(FEATURE_FLAGS_SETTING_KEY, next);
    this.config.assistant.features = { ...next };
    return next;
  }

  private applyStoredFeatureFlags(): void {
    this.config.assistant.features = this.readFeatureFlags();
  }

  private readFeatureFlags(): RuntimeSettings["features"] {
    const stored = this.storage.systemSettings.get<Partial<RuntimeSettings["features"]>>(FEATURE_FLAGS_SETTING_KEY)?.value;
    const fromConfig = this.config.assistant.features;
    return {
      durableKernelV1Enabled: stored?.durableKernelV1Enabled ?? fromConfig.durableKernelV1Enabled,
      replayOverridesV1Enabled: stored?.replayOverridesV1Enabled ?? fromConfig.replayOverridesV1Enabled,
      memoryLifecycleAdminV1Enabled: stored?.memoryLifecycleAdminV1Enabled ?? fromConfig.memoryLifecycleAdminV1Enabled,
      connectorDiagnosticsV1Enabled: stored?.connectorDiagnosticsV1Enabled ?? fromConfig.connectorDiagnosticsV1Enabled,
      computerUseGuardrailsV1Enabled: stored?.computerUseGuardrailsV1Enabled ?? fromConfig.computerUseGuardrailsV1Enabled,
      bankrBuiltinEnabled: stored?.bankrBuiltinEnabled ?? fromConfig.bankrBuiltinEnabled,
      cronReviewQueueV1Enabled: stored?.cronReviewQueueV1Enabled ?? fromConfig.cronReviewQueueV1Enabled,
      replayRegressionV1Enabled: stored?.replayRegressionV1Enabled ?? fromConfig.replayRegressionV1Enabled,
    };
  }

  private normalizeDurableRetryPolicy(input: Partial<DurableRetryPolicy> | undefined): DurableRetryPolicy {
    return this.durableRunService.normalizeDurableRetryPolicy(input);
  }

  private computeDurableRetryDelayMs(current: DurableRunRecord, attemptNo: number): number {
    return this.durableRunService.computeDurableRetryDelayMs(current, attemptNo);
  }

  private recordDurableTimelineEvent(
    runId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
    stepKey?: string,
  ): DurableRunTimelineEvent {
    return this.durableRunService.recordDurableTimelineEvent(runId, eventType, payload, stepKey);
  }

  // normalizeReplayOverrides, replaceReplayOverrideSteps, computeReplayDiffSummary moved to ImprovementService

  private requireMemoryItem(itemId: string): MemoryItemRecord {
    const row = this.gatewaySql.prepare(`
      SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, status,
             created_at, updated_at, forgotten_at
      FROM memory_items
      WHERE item_id = ?
    `).get(itemId) as {
      item_id: string;
      namespace: string;
      title: string;
      content: string;
      metadata_json: string | null;
      pinned: number;
      ttl_override_seconds: number | null;
      expires_at: string | null;
      status: MemoryItemRecord["status"];
      created_at: string;
      updated_at: string;
      forgotten_at: string | null;
    } | undefined;
    if (!row) {
      throw new Error(`Memory item not found: ${itemId}`);
    }
    return this.mapMemoryItemRow(row);
  }

  private mapMemoryItemRow(row: {
    item_id: string;
    namespace: string;
    title: string;
    content: string;
    metadata_json: string | null;
    pinned: number;
    ttl_override_seconds: number | null;
    expires_at: string | null;
    status: MemoryItemRecord["status"];
    created_at: string;
    updated_at: string;
    forgotten_at: string | null;
  }): MemoryItemRecord {
    return {
      itemId: row.item_id,
      namespace: row.namespace,
      title: row.title,
      content: row.content,
      metadata: this.tryParseJson<Record<string, unknown>>(row.metadata_json, {}),
      pinned: Boolean(row.pinned),
      ttlOverrideSeconds: row.ttl_override_seconds ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      status: MEMORY_ITEM_STATUS_VALUES.has(row.status) ? row.status : "active",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      forgottenAt: row.forgotten_at ?? undefined,
    };
  }

  private recordMemoryChange(
    itemId: string,
    changeType: MemoryChangeEvent["changeType"],
    actorId: string | undefined,
    payload: Record<string, unknown>,
  ): MemoryChangeEvent {
    const change: MemoryChangeEvent = {
      changeId: randomUUID(),
      itemId,
      changeType,
      actorId: actorId?.trim() || undefined,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.gatewaySql.prepare(`
      INSERT INTO memory_change_history (change_id, item_id, change_type, actor_id, payload_json, created_at)
      VALUES (@changeId, @itemId, @changeType, @actorId, @payloadJson, @createdAt)
    `).run({
      changeId: change.changeId,
      itemId: change.itemId,
      changeType: change.changeType,
      actorId: change.actorId ?? null,
      payloadJson: JSON.stringify(change.payload ?? {}),
      createdAt: change.createdAt,
    });
    return change;
  }

  private recordConnectorHealthRun(report: ConnectorDiagnosticReport): void {
    this.gatewaySql.prepare(`
      INSERT INTO connector_health_runs (
        health_run_id, connector_type, connector_id, status, checks_json, recommendation, checked_at
      ) VALUES (
        @healthRunId, @connectorType, @connectorId, @status, @checksJson, @recommendation, @checkedAt
      )
    `).run({
      healthRunId: randomUUID(),
      connectorType: report.connectorType,
      connectorId: report.connectorId,
      status: report.status,
      checksJson: JSON.stringify(report.checks),
      recommendation: report.recommendedNextAction ?? null,
      checkedAt: report.checkedAt,
    });
  }

  private pickConnectorDiagnosticAction(checks: ConnectorDiagnosticReport["checks"]): string | undefined {
    if (checks.some((check) => check.key === "status" && check.status === "fail")) {
      return "Reconnect the connector and resolve the reported status error first.";
    }
    if (checks.some((check) => check.key === "auth" && check.status !== "pass")) {
      return "Provide valid credentials and rerun health check.";
    }
    if (checks.some((check) => check.key === "url" && check.status !== "pass")) {
      return "Set a reachable URL/endpoint and rerun health check.";
    }
    return checks.some((check) => check.status === "warn")
      ? "Review warning checks and tighten policy before production use."
      : undefined;
  }

  private buildIntegrationConnectionChecks(
    connection: IntegrationConnection,
  ): ConnectorDiagnosticReport["checks"] {
    const checks: ConnectorDiagnosticReport["checks"] = [];
    const config = connection.config;
    const requireSecretRef = (
      key: string,
      label: string,
      directKey: string,
      envKey: string,
    ) => {
      const direct = this.readConnectionConfigValue(config, directKey);
      const envName = this.readConnectionConfigValue(config, envKey);
      const envPresent = envName ? Boolean(process.env[envName]) : false;
      checks.push({
        key,
        status: direct || envPresent ? "pass" : "fail",
        message: direct || envPresent
          ? `${label} is configured${envName ? ` via ${envName}` : ""}.`
          : `${label} is missing.`,
      });
    };
    const requireText = (key: string, label: string, value: string | undefined, status: "warn" | "fail" = "fail") => {
      checks.push({
        key,
        status: value ? "pass" : status,
        message: value ? `${label} is set.` : `${label} is missing.`,
      });
    };
    const checkUrl = (key: string, label: string, urlValue: string | undefined, required = false) => {
      if (!urlValue && !required) {
        return;
      }
      const safeRemote = !urlValue || this.isConnectionUrlRemoteSafe(urlValue);
      const allowlisted = !urlValue || this.isConnectionUrlAllowlisted(urlValue);
      checks.push({
        key,
        status: !urlValue
          ? "fail"
          : !safeRemote
            ? "fail"
            : allowlisted
              ? "pass"
              : "warn",
        message: !urlValue
          ? `${label} is missing.`
          : !safeRemote
            ? `${label} uses non-local plain HTTP.`
            : allowlisted
              ? `${label} is reachable under current allowlist posture.`
              : `${label} host is not in the current outbound allowlist.`,
      });
    };

    if (connection.kind === "channel") {
      switch (connection.key) {
        case "slack":
          checks.push({
            key: "auth",
            status: this.readConnectionConfigValue(config, "webhookUrl")
              || this.readConnectionConfigValue(config, "botToken")
              || this.hasConnectionEnvValue(config, "botTokenEnv")
              ? "pass"
              : "fail",
            message: this.readConnectionConfigValue(config, "webhookUrl")
              || this.readConnectionConfigValue(config, "botToken")
              || this.hasConnectionEnvValue(config, "botTokenEnv")
              ? "Slack bot token or webhook is configured."
              : "Slack bot token or webhook is missing.",
          });
          checkUrl("url", "Slack webhook URL", this.readConnectionConfigValue(config, "webhookUrl"), false);
          requireText("target", "Default Slack channel", this.readConnectionConfigValue(config, "defaultChannel"), "warn");
          break;
        case "discord":
          checks.push({
            key: "auth",
            status: this.readConnectionConfigValue(config, "webhookUrl")
              || this.readConnectionConfigValue(config, "botToken")
              || this.hasConnectionEnvValue(config, "botTokenEnv")
              ? "pass"
              : "fail",
            message: this.readConnectionConfigValue(config, "webhookUrl")
              || this.readConnectionConfigValue(config, "botToken")
              || this.hasConnectionEnvValue(config, "botTokenEnv")
              ? "Discord bot token or webhook is configured."
              : "Discord bot token or webhook is missing.",
          });
          checkUrl("url", "Discord webhook URL", this.readConnectionConfigValue(config, "webhookUrl"), false);
          requireText("target", "Default Discord channel", this.readConnectionConfigValue(config, "defaultChannelId"), "warn");
          break;
        case "telegram":
          requireSecretRef("auth", "Telegram bot token", "botToken", "botTokenEnv");
          requireText("target", "Default Telegram chat", this.readConnectionConfigValue(config, "defaultChatId"), "warn");
          checks.push({
            key: "url",
            status: this.isHostAllowlisted("api.telegram.org") ? "pass" : "warn",
            message: this.isHostAllowlisted("api.telegram.org")
              ? "Telegram API host is allowlisted."
              : "Telegram API host is not allowlisted.",
          });
          break;
        case "matrix":
          requireSecretRef("auth", "Matrix access token", "accessToken", "accessTokenEnv");
          checkUrl("url", "Matrix homeserver URL", this.readConnectionConfigValue(config, "homeserverUrl"), true);
          requireText("target", "Default Matrix room", this.readConnectionConfigValue(config, "defaultRoomId"), "warn");
          break;
        case "google-chat":
          checkUrl("url", "Google Chat webhook URL", this.readConnectionConfigValue(config, "webhookUrl"), true);
          requireText("target", "Default Google Chat thread key", this.readConnectionConfigValue(config, "defaultThreadKey"), "warn");
          break;
        case "teams":
          checkUrl("url", "Teams webhook URL", this.readConnectionConfigValue(config, "webhookUrl"), true);
          break;
        default:
          requireText("target", "Default target", this.readConnectionConfigValue(config, "target") ?? this.readConnectionConfigValue(config, "defaultTarget"), "warn");
          requireSecretRef("auth", "Channel token", "token", "tokenEnv");
          break;
      }
    } else if (connection.kind === "model_provider") {
      checkUrl("url", "Provider base URL", this.readConnectionConfigValue(config, "baseUrl"), true);
      requireText("target", "Default model", this.readConnectionConfigValue(config, "model"), "warn");
      const isLocal = this.isConnectionValueLocalUrl(this.readConnectionConfigValue(config, "baseUrl"));
      checks.push({
        key: "auth",
        status: isLocal || this.readConnectionConfigValue(config, "apiKey") || this.hasConnectionEnvValue(config, "apiKeyEnv") ? "pass" : "fail",
        message: isLocal
          ? "Local model endpoint does not require an API key."
          : this.readConnectionConfigValue(config, "apiKey") || this.hasConnectionEnvValue(config, "apiKeyEnv")
            ? "API key is configured."
            : "API key is missing.",
      });
    } else if (connection.kind === "automation") {
      if (connection.key === "webhooks") {
        checkUrl("url", "Webhook base URL", this.readConnectionConfigValue(config, "baseUrl"), true);
      }
      if (connection.key === "gmail") {
        requireText("auth", "Gmail refresh token handle", this.readConnectionConfigValue(config, "refreshTokenHandle"));
      }
    }

    return checks;
  }

  private readConnectionConfigValue(config: Record<string, unknown>, key: string): string | undefined {
    const value = config[key];
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private hasConnectionEnvValue(config: Record<string, unknown>, key: string): boolean {
    const envName = this.readConnectionConfigValue(config, key);
    return Boolean(envName && process.env[envName]?.trim());
  }

  private isConnectionValueLocalUrl(urlValue: string | undefined): boolean {
    if (!urlValue) {
      return false;
    }
    try {
      const url = new URL(urlValue);
      return url.hostname === "127.0.0.1" || url.hostname === "localhost";
    } catch {
      return false;
    }
  }

  private isConnectionUrlRemoteSafe(urlValue: string): boolean {
    try {
      const url = new URL(urlValue);
      if (url.protocol === "https:") {
        return true;
      }
      return url.hostname === "127.0.0.1" || url.hostname === "localhost";
    } catch {
      return false;
    }
  }

  private isConnectionUrlAllowlisted(urlValue: string): boolean {
    try {
      const url = new URL(urlValue);
      return this.isHostAllowlisted(url.hostname);
    } catch {
      return false;
    }
  }

  private isHostAllowlisted(hostname: string): boolean {
    const normalizedHost = hostname.trim().toLowerCase();
    const allowlist = this.config.toolPolicy.sandbox.networkAllowlist
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    if (allowlist.length === 0) {
      return false;
    }
    return allowlist.some((allowed) => {
      if (allowed === "*" || allowed === normalizedHost) {
        return true;
      }
      if (allowed.startsWith("*.")) {
        const suffix = allowed.slice(1);
        return normalizedHost.endsWith(suffix);
      }
      return false;
    });
  }

  private tryParseJson<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) {
      return fallback;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private readIntegrationPlugins(): IntegrationPluginRecord[] {
    const stored = this.storage.systemSettings.get<IntegrationPluginRecord[]>(INTEGRATION_PLUGINS_SETTING_KEY)?.value;
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored.filter((item): item is IntegrationPluginRecord => Boolean(item?.pluginId));
  }

  private writeIntegrationPlugins(plugins: IntegrationPluginRecord[]): void {
    this.storage.systemSettings.set(INTEGRATION_PLUGINS_SETTING_KEY, plugins);
  }

  private readMcpServers(): McpServerRecord[] {
    const stored = this.storage.systemSettings.get<McpServerRecord[]>(MCP_SERVERS_SETTING_KEY)?.value;
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored
      .filter((item): item is McpServerRecord => Boolean(item?.serverId))
      .map((item) => ({
        ...item,
        category: item.category ?? inferMcpCategory(item.transport),
        trustTier: item.trustTier ?? "restricted",
        costTier: item.costTier ?? "unknown",
        policy: normalizeMcpPolicy(item.policy),
      }));
  }

  private writeMcpServers(servers: McpServerRecord[]): void {
    this.storage.systemSettings.set(MCP_SERVERS_SETTING_KEY, servers);
  }

  private requireMcpServer(serverId: string): McpServerRecord {
    const server = this.readMcpServers().find((item) => item.serverId === serverId);
    if (!server) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    return server;
  }

  private patchMcpServerState(
    serverId: string,
    patch: Partial<Pick<McpServerRecord, "status" | "lastConnectedAt" | "lastError">>,
  ): McpServerRecord {
    const now = new Date().toISOString();
    const hasStatus = Object.prototype.hasOwnProperty.call(patch, "status");
    const hasLastConnectedAt = Object.prototype.hasOwnProperty.call(patch, "lastConnectedAt");
    const hasLastError = Object.prototype.hasOwnProperty.call(patch, "lastError");
    let updated: McpServerRecord | undefined;
    const servers = this.readMcpServers().map((item) => {
      if (item.serverId !== serverId) {
        return item;
      }
      updated = {
        ...item,
        status: hasStatus ? (patch.status ?? item.status) : item.status,
        lastConnectedAt: hasLastConnectedAt ? patch.lastConnectedAt : item.lastConnectedAt,
        lastError: hasLastError ? patch.lastError : item.lastError,
        updatedAt: now,
      };
      return updated;
    });
    if (!updated) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    this.writeMcpServers(servers);
    return updated;
  }

  private async resolveConnectedMcpTools(
    server: McpServerRecord,
    existingTools: McpToolRecord[],
  ): Promise<McpToolRecord[]> {
    if (isInternalMcpApprovalInboxServer(server)) {
      return createInternalMcpApprovalInboxTools(server.serverId);
    }
    if (server.transport === "stdio") {
      const discovered = await discoverMcpTools(server);
      if (discovered.length > 0) {
        return discovered;
      }
    }
    return inferMcpToolsForServer(server, existingTools);
  }

  private readMcpTools(): McpToolRecord[] {
    const stored = this.storage.systemSettings.get<McpToolRecord[]>(MCP_TOOLS_SETTING_KEY)?.value;
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored.filter((item): item is McpToolRecord => Boolean(item?.serverId && item?.toolName));
  }

  private writeMcpTools(tools: McpToolRecord[]): void {
    this.storage.systemSettings.set(MCP_TOOLS_SETTING_KEY, tools);
  }

  private readMcpAuthState(): Record<string, McpAuthStateRecord> {
    return this.storage.systemSettings.get<Record<string, McpAuthStateRecord>>("mcp_auth_state_v1")?.value ?? {};
  }

  private writeMcpAuthState(state: Record<string, McpAuthStateRecord>): void {
    this.storage.systemSettings.set("mcp_auth_state_v1", state);
  }

  private readMcpFirstApprovals(): Record<string, string[]> {
    return this.storage.systemSettings.get<Record<string, string[]>>(MCP_TOOL_FIRST_APPROVAL_SETTING_KEY)?.value ?? {};
  }

  private isMcpToolApproved(serverId: string, toolName: string): boolean {
    const approved = this.readMcpFirstApprovals();
    return approved[serverId]?.includes(toolName) ?? false;
  }

  private readSkillStates(): Map<string, SkillStateRecord> {
    const rows = this.gatewaySql.prepare(`
      SELECT skill_id AS skillId, state, note, updated_at AS updatedAt, first_auto_approved_at AS firstAutoApprovedAt
      FROM skill_state
    `).all() as unknown as SkillStateRecord[];

    return new Map(rows.map((row) => [row.skillId, row]));
  }

  private ensureSkillStates(skillIds: string[]): void {
    const unique = [...new Set(skillIds)];
    const now = new Date().toISOString();
    const insert = this.gatewaySql.prepare(`
      INSERT OR IGNORE INTO skill_state (skill_id, state, note, updated_at, first_auto_approved_at)
      VALUES (@skillId, @state, @note, @updatedAt, NULL)
    `);
    for (const skillId of unique) {
      insert.run({
        skillId,
        state: "enabled",
        note: null,
        updatedAt: now,
      });
    }
  }

  private recordSkillImportEvent(
    validation: SkillImportValidationResult,
    eventType: "import_validated" | "import_installed",
  ): void {
    const now = new Date().toISOString();
    const skillId = validation.inferredSkillId
      ? `import:${validation.inferredSkillId}`
      : `import:${createHash("sha1").update(validation.candidate.canonicalKey).digest("hex").slice(0, 12)}`;
    this.gatewaySql.prepare(`
      INSERT INTO skill_activation_events (
        event_id, skill_id, event_type, payload_json, created_at
      ) VALUES (
        @eventId, @skillId, @eventType, @payloadJson, @createdAt
      )
    `).run({
      eventId: randomUUID(),
      skillId,
      eventType,
      payloadJson: JSON.stringify({
        sourceProvider: validation.candidate.sourceProvider,
        sourceRef: validation.candidate.sourceRef,
        canonicalKey: validation.candidate.canonicalKey,
        valid: validation.valid,
        riskLevel: validation.riskLevel,
        skillName: validation.inferredSkillName,
        skillId: validation.inferredSkillId,
        warnings: validation.warnings,
        errors: validation.errors,
      }),
      createdAt: now,
    });
  }

  private processMediaJob(jobId: string): void {
    if (typeof jobId !== "string" || !jobId.trim()) {
      return;
    }
    if (this.closing) {
      return;
    }
    const task = this.runMediaJob(jobId)
      .catch((error) => {
        const now = new Date().toISOString();
        const errorMessage = error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);
        this.gatewaySql.prepare(`
          UPDATE media_jobs
          SET status = 'failed', error = @error, updated_at = @updatedAt, completed_at = @completedAt
          WHERE job_id = @jobId
        `).run({
          error: errorMessage,
          updatedAt: now,
          completedAt: now,
          jobId,
        });
      })
      .finally(() => {
        this.backgroundTasks.delete(task);
      });
    this.backgroundTasks.add(task);
    void task;
  }

  private async runMediaJob(jobId: string): Promise<void> {
    if (typeof jobId !== "string" || !jobId.trim()) {
      return;
    }
    const now = new Date().toISOString();
    this.gatewaySql.prepare(`
      UPDATE media_jobs
      SET status = 'running', updated_at = @updatedAt
      WHERE job_id = @jobId
    `).run({
      updatedAt: now,
      jobId,
    });
    const job = this.getMediaJob(jobId);
    const attachmentId = job.attachmentId;
    if (!attachmentId) {
      this.gatewaySql.prepare(`
        UPDATE media_jobs
        SET status = 'ready', output_json = @outputJson, updated_at = @updatedAt, completed_at = @completedAt
        WHERE job_id = @jobId
      `).run({
        outputJson: JSON.stringify({ message: "No attachment supplied." }),
        updatedAt: now,
        completedAt: now,
        jobId,
      });
      return;
    }

    const attachment = this.storage.chatAttachments.get(attachmentId);
    if (job.type === "audio_transcribe" || job.type === "video_transcribe") {
      const content = await this.readChatAttachmentContent(attachmentId);
      const transcript = await this.transcribeAudioBytes(content.bytes, content.record.mimeType);
      const completedAt = new Date().toISOString();
      this.gatewaySql.prepare(`
        UPDATE media_jobs
        SET status = 'ready', output_json = @outputJson, updated_at = @updatedAt, completed_at = @completedAt
        WHERE job_id = @jobId
      `).run({
        outputJson: JSON.stringify({ transcriptText: transcript.text, provider: transcript.provider }),
        updatedAt: completedAt,
        completedAt,
        jobId,
      });
      this.gatewaySql.prepare(`
        UPDATE chat_attachments
        SET transcript_text = @transcriptText, analysis_status = 'ready'
        WHERE attachment_id = @attachmentId
      `).run({
        transcriptText: transcript.text,
        attachmentId,
      });
      return;
    }

    if (job.type === "ocr" && attachment.mediaType === "image") {
      const completedAt = new Date().toISOString();
      this.gatewaySql.prepare(`
        UPDATE media_jobs
        SET status = 'unsupported', output_json = @outputJson, updated_at = @updatedAt, completed_at = @completedAt
        WHERE job_id = @jobId
      `).run({
        outputJson: JSON.stringify({
          message: "OCR worker is not installed. Configure sidecar OCR in a follow-up step.",
        }),
        updatedAt: completedAt,
        completedAt,
        jobId,
      });
      this.gatewaySql.prepare(`
        UPDATE chat_attachments
        SET analysis_status = 'unsupported'
        WHERE attachment_id = @attachmentId
      `).run({
        attachmentId,
      });
      return;
    }

    const completedAt = new Date().toISOString();
    this.gatewaySql.prepare(`
      UPDATE media_jobs
      SET status = 'ready', output_json = @outputJson, updated_at = @updatedAt, completed_at = @completedAt
      WHERE job_id = @jobId
    `).run({
      outputJson: JSON.stringify({
        mediaType: attachment.mediaType ?? detectAttachmentMediaType(attachment.mimeType),
        extractPreview: attachment.extractPreview,
      }),
      updatedAt: completedAt,
      completedAt,
      jobId,
    });
    this.gatewaySql.prepare(`
      UPDATE chat_attachments
      SET ocr_text = COALESCE(ocr_text, @ocrText), analysis_status = 'ready'
      WHERE attachment_id = @attachmentId
    `).run({
      ocrText: attachment.extractPreview ?? null,
      attachmentId,
    });
  }

  private async transcribeAudioBytes(
    bytes: Buffer,
    mimeType?: string,
    language?: string,
  ): Promise<VoiceTranscribeResponse> {
    const started = Date.now();
    const runtime = await getManagedVoiceRuntimeStatus(this.storage.systemSettings);
    const binPath = process.env.GOATCITADEL_WHISPER_CPP_BIN?.trim() || runtime.binaryPath;
    const modelPath = process.env.GOATCITADEL_WHISPER_CPP_MODEL_PATH?.trim() || runtime.selectedModelPath;
    const ffmpegPath = process.env.GOATCITADEL_FFMPEG_BIN?.trim() || runtime.ffmpegPath;
    const extraArgs = parseVoiceCliArgs(process.env.GOATCITADEL_WHISPER_CPP_ARGS);
    if (!binPath) {
      const now = new Date().toISOString();
      this.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
        state: "error",
        provider: DEFAULT_VOICE_PROVIDER,
        modelId: runtime.selectedModelId,
        runtimeReady: false,
        lastError: "No whisper.cpp runtime is configured.",
        updatedAt: now,
      });
      throw new Error("Local STT is not configured. Install the managed voice runtime or set GOATCITADEL_WHISPER_CPP_BIN.");
    }

    const tempBase = path.join(os.tmpdir(), `goatcitadel-whisper-${randomUUID()}`);
    const ext = extFromMimeType(mimeType);
    const inputPath = `${tempBase}${ext}`;
    const normalizedInputPath = `${tempBase}-normalized.wav`;
    const outputBase = `${tempBase}-out`;
    const outputPath = `${outputBase}.txt`;

    this.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
      state: "running",
      provider: DEFAULT_VOICE_PROVIDER,
      modelId: runtime.selectedModelId,
      runtimeReady: Boolean(binPath && (modelPath || process.env.GOATCITADEL_WHISPER_CPP_BIN?.trim())),
      updatedAt: new Date().toISOString(),
    });

    try {
      await fs.writeFile(inputPath, bytes);
      const whisperInputPath = await normalizeAudioForWhisper({
        inputPath,
        outputPath: normalizedInputPath,
        mimeType,
        ffmpegPath,
      });
      const args = [
        ...extraArgs,
      ];
      if (modelPath) {
        args.push("-m", modelPath);
      }
      args.push(
        "-f",
        whisperInputPath,
        "-otxt",
        "-of",
        outputBase,
      );
      if (language?.trim()) {
        args.push("-l", language.trim());
      }
      execFileSync(binPath, args, { stdio: "pipe" });
      const text = (await fs.readFile(outputPath, "utf8")).trim();
      const now = new Date().toISOString();
      this.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
        state: "stopped",
        provider: DEFAULT_VOICE_PROVIDER,
        modelId: runtime.selectedModelId,
        runtimeReady: true,
        updatedAt: now,
      });
      return {
        text,
        language: language?.trim() || undefined,
        provider: DEFAULT_VOICE_PROVIDER,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const now = new Date().toISOString();
      this.storage.systemSettings.set(VOICE_STATUS_SETTING_KEY, {
        state: "error",
        provider: DEFAULT_VOICE_PROVIDER,
        modelId: runtime.selectedModelId,
        runtimeReady: false,
        lastError: (error as Error).message,
        updatedAt: now,
      });
      throw new Error(`Local STT failed: ${(error as Error).message}`);
    } finally {
      await Promise.allSettled([
        fs.rm(inputPath, { force: true }),
        fs.rm(normalizedInputPath, { force: true }),
        fs.rm(outputPath, { force: true }),
      ]);
    }
  }

  private appendDaemonLog(eventType: string, payload: Record<string, unknown>): void {
    const current = this.storage.systemSettings.get<Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }>>(
      DAEMON_LOG_TAIL_SETTING_KEY,
    )?.value ?? [];
    const next = [
      ...current,
      {
        timestamp: new Date().toISOString(),
        level: "info" as const,
        message: `${eventType}: ${JSON.stringify(payload)}`,
      },
    ].slice(-400);
    this.storage.systemSettings.set(DAEMON_LOG_TAIL_SETTING_KEY, next);
  }

  public async close(): Promise<void> {
    this.closing = true;
    this.chatProactiveService.stopScheduler();
    this.improvementService.stopScheduler();
    if (this.maintenanceScheduler) {
      clearInterval(this.maintenanceScheduler);
      this.maintenanceScheduler = undefined;
    }
    if (this.backgroundTasks.size > 0) {
      const tasks = [...this.backgroundTasks];
      this.backgroundTasks.clear();
      await Promise.allSettled(tasks);
    }
    await this.assemblyService.close();
    await this.npuSidecar.close();
    this.storage.close();
  }

  private async invokeAndUnwrap(
    request: ToolInvokeRequest,
    realtimeType: string,
  ): Promise<ToolInvokeResult | Record<string, unknown>> {
    const result = await this.invokeTool(request);
    if (result.outcome === "executed") {
      this.publishRealtime("system", "tools", {
        type: realtimeType,
        toolName: request.toolName,
        sessionId: request.sessionId,
        agentId: request.agentId,
        taskId: request.taskId,
        outcome: result.outcome,
      });
      return result.result ?? {};
    }
    return result;
  }

  private async resolveDeviceAccessApproval(
    currentApproval: ApprovalRequest,
    input: ApprovalResolveInput,
  ): Promise<ApprovalResolveResult> {
    if (currentApproval.status !== "pending") {
      throw new ConflictError({
        message: `Approval ${currentApproval.approvalId} is already resolved`,
      });
    }
    if (input.decision === "edit") {
      throw new ValidationError({
        message: "Editing device access approvals is not supported.",
      });
    }

    const existingRequest = this.getAuthDeviceRequestByApprovalId(currentApproval.approvalId);
    if (!existingRequest) {
      throw new NotFoundError("Device access request not found.");
    }

    const request = await this.expireDeviceAccessRequestIfNeeded(existingRequest);
    if (request.status === "expired") {
      throw new ConflictError({
        message: "Device access request expired before it could be approved.",
      });
    }
    if (request.status !== "pending") {
      throw new ConflictError({
        message: `Approval ${currentApproval.approvalId} is already resolved`,
      });
    }

    const resolvedAt = new Date().toISOString();
    const requestStatus: DeviceAccessRequestStatus = input.decision === "approve" ? "approved" : "rejected";
    const deviceToken = input.decision === "approve"
      ? randomBytes(DEVICE_ACCESS_TOKEN_BYTES).toString("base64url")
      : undefined;
    const deviceTokenExpiresAt = deviceToken
      ? new Date(Date.now() + DEVICE_ACCESS_TOKEN_TTL_MS).toISOString()
      : undefined;
    let approval: ApprovalRequest;

    this.storage.runImmediateTransaction(() => {
      if (deviceToken) {
        this.gatewaySql.prepare(`
          INSERT INTO auth_device_grants (
            grant_id, request_id, token_hash, device_label, device_type, platform,
            granted_by, created_at, expires_at, metadata_json
          ) VALUES (
            @grantId, @requestId, @tokenHash, @deviceLabel, @deviceType, @platform,
            @grantedBy, @createdAt, @expiresAt, @metadataJson
          )
        `).run({
          grantId: randomUUID(),
          requestId: request.requestId,
          tokenHash: hashSensitiveToken(deviceToken),
          deviceLabel: request.deviceLabel,
          deviceType: request.deviceType,
          platform: request.platform ?? null,
          grantedBy: input.resolvedBy,
          createdAt: resolvedAt,
          expiresAt: deviceTokenExpiresAt ?? null,
          metadataJson: JSON.stringify({
            approvalId: currentApproval.approvalId,
            requestedOrigin: request.requestedOrigin,
            requestedIp: request.requestedIp,
          }),
        });
      }

      this.gatewaySql.prepare(`
        UPDATE auth_device_requests
        SET status = @status,
            resolved_at = @resolvedAt,
            resolved_by = @resolvedBy,
            resolution_note = @resolutionNote,
            approved_token_plaintext = @approvedTokenPlaintext,
            approved_token_expires_at = @approvedTokenExpiresAt
        WHERE request_id = @requestId
          AND status = 'pending'
      `).run({
        requestId: request.requestId,
        status: requestStatus,
        resolvedAt,
        resolvedBy: input.resolvedBy,
        resolutionNote: input.resolutionNote ?? null,
        approvedTokenPlaintext: deviceToken ?? null,
        approvedTokenExpiresAt: deviceTokenExpiresAt ?? null,
      });

      approval = this.storage.approvals.resolve(currentApproval.approvalId, input);
      this.storage.approvalEvents.append({
        approvalId: currentApproval.approvalId,
        eventType: "resolved",
        actorId: input.resolvedBy,
        payload: {
          decision: input.decision,
          status: approval.status,
        },
      });
    });

    await this.recordApprovalResolutionEffects(approval!, input);
    await this.wakeApprovalWaitDurableRun(approval!, input);
    await this.storage.audit.append("approvals", {
      event: "auth.device_request.resolve",
      requestId: request.requestId,
      approvalId: currentApproval.approvalId,
      status: requestStatus,
      resolvedBy: input.resolvedBy,
      deviceLabel: request.deviceLabel,
      deviceType: request.deviceType,
      platform: request.platform,
      requestedIp: request.requestedIp,
      deviceTokenExpiresAt,
    });

    this.publishRealtime("auth_device_request_resolved", "auth", {
      requestId: request.requestId,
      approvalId: currentApproval.approvalId,
      status: requestStatus,
      resolvedAt,
      resolvedBy: input.resolvedBy,
      deviceLabel: request.deviceLabel,
      deviceType: request.deviceType,
      platform: request.platform,
      requestedIp: request.requestedIp,
      deviceTokenExpiresAt,
    });

    return {
      approval: approval!,
    };
  }

  private async expireDeviceAccessRequestIfNeeded(request: AuthDeviceRequestRecord): Promise<AuthDeviceRequestRecord> {
    if (request.status !== "pending") {
      return request;
    }
    const expiresAt = Date.parse(request.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) {
      return request;
    }

    const resolutionInput: ApprovalResolveInput = {
      decision: "reject",
      resolvedBy: "system:auth-device-expiry",
      resolutionNote: "Device access request expired before approval.",
    };
    const resolvedAt = new Date().toISOString();
    let approval: ApprovalRequest | undefined;

    this.storage.runImmediateTransaction(() => {
      this.gatewaySql.prepare(`
        UPDATE auth_device_requests
        SET status = 'expired',
            resolved_at = @resolvedAt,
            resolved_by = @resolvedBy,
            resolution_note = @resolutionNote
        WHERE request_id = @requestId
          AND status = 'pending'
      `).run({
        requestId: request.requestId,
        resolvedAt,
        resolvedBy: resolutionInput.resolvedBy,
        resolutionNote: resolutionInput.resolutionNote ?? null,
      });

      const currentApproval = this.storage.approvals.get(request.approvalId);
      if (currentApproval.status === "pending") {
        approval = this.storage.approvals.resolve(request.approvalId, resolutionInput);
        this.storage.approvalEvents.append({
          approvalId: request.approvalId,
          eventType: "resolved",
          actorId: resolutionInput.resolvedBy,
          payload: {
            decision: resolutionInput.decision,
            status: approval.status,
          },
        });
      }
    });

    if (approval) {
      await this.recordApprovalResolutionEffects(approval, resolutionInput);
      await this.wakeApprovalWaitDurableRun(approval, resolutionInput);
    }
    await this.storage.audit.append("approvals", {
      event: "auth.device_request.expire",
      requestId: request.requestId,
      approvalId: request.approvalId,
      deviceLabel: request.deviceLabel,
      deviceType: request.deviceType,
      platform: request.platform,
      requestedIp: request.requestedIp,
    });

    this.publishRealtime("auth_device_request_resolved", "auth", {
      requestId: request.requestId,
      approvalId: request.approvalId,
      status: "expired",
      resolvedAt,
      resolvedBy: resolutionInput.resolvedBy,
      deviceLabel: request.deviceLabel,
      deviceType: request.deviceType,
      platform: request.platform,
      requestedIp: request.requestedIp,
    });

    return this.getAuthDeviceRequestById(request.requestId) ?? {
      ...request,
      status: "expired",
      resolvedAt,
      resolvedBy: resolutionInput.resolvedBy,
      resolutionNote: resolutionInput.resolutionNote,
    };
  }

  private getAuthDeviceRequestById(requestId: string): AuthDeviceRequestRecord | undefined {
    const row = this.gatewaySql.prepare(`
      SELECT *
      FROM auth_device_requests
      WHERE request_id = @requestId
      LIMIT 1
    `).get({ requestId }) as Record<string, unknown> | undefined;
    return row ? mapAuthDeviceRequestRow(row) : undefined;
  }

  private getAuthDeviceRequestByApprovalId(approvalId: string): AuthDeviceRequestRecord | undefined {
    const row = this.gatewaySql.prepare(`
      SELECT *
      FROM auth_device_requests
      WHERE approval_id = @approvalId
      LIMIT 1
    `).get({ approvalId }) as Record<string, unknown> | undefined;
    return row ? mapAuthDeviceRequestRow(row) : undefined;
  }

  private async recordApprovalResolutionEffects(
    approval: ApprovalRequest,
    input: ApprovalResolveInput,
    executedAction?: ToolInvokeResult,
  ): Promise<void> {
    await this.storage.audit.append("approvals", {
      event: "approval.resolve",
      approvalId: approval.approvalId,
      status: approval.status,
      resolvedBy: input.resolvedBy,
      decision: input.decision,
      executedAction: executedAction
        ? {
            outcome: executedAction.outcome,
            policyReason: executedAction.policyReason,
            auditEventId: executedAction.auditEventId,
          }
        : undefined,
    });

    this.publishRealtime("approval_resolved", "approvals", {
      approvalId: approval.approvalId,
      status: approval.status,
      decision: input.decision,
      resolvedBy: input.resolvedBy,
      executedOutcome: executedAction?.outcome,
    });
  }

  private publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): RealtimeEvent {
    const event = this.storage.realtimeEvents.append(eventType, source, payload);
    this.realtime.emit("event", event);
    return event;
  }

  private createCheckpoint(input: Omit<OrchestrationCheckpoint, "checkpointId" | "createdAt" | "gitRef">): OrchestrationCheckpoint {
    return this.storage.orchestration.createCheckpoint({
      ...input,
      gitRef: this.getGitHead(),
    });
  }

  private scheduleApprovalExplanation(approval: ApprovalRequest): void {
    if (this.closing) {
      return;
    }

    const task = this.approvalExplainer.explainApproval(approval)
      .catch((error) => {
        if (this.closing) {
          return;
        }
        this.publishRealtime("system", "approvals", {
          type: "approval_explainer_error",
          approvalId: approval.approvalId,
          error: (error as Error).message,
        });
      })
      .finally(() => {
        this.backgroundTasks.delete(task);
      });

    this.backgroundTasks.add(task);
    void task;
  }

  private scheduleApprovalExplanationById(approvalId: string): void {
    if (this.closing) {
      return;
    }
    let approval: ApprovalRequest;
    try {
      approval = this.storage.approvals.get(approvalId);
    } catch {
      return;
    }
    this.scheduleApprovalExplanation(approval);
  }

  private scheduleOrchestrationMemoryContext(plan: OrchestrationPlan, run: OrchestrationRun): void {
    if (this.closing || !run.currentPhaseId) {
      return;
    }
    const phase = findPlanPhase(plan, run.currentPhaseId);
    if (!phase) {
      return;
    }

    const task = this.memoryContextService.compose({
      scope: "orchestration",
      prompt: [
        `Plan goal: ${plan.goal}`,
        `Wave: ${run.currentWaveId ?? "(none)"}`,
        `Phase: ${phase.phaseId}`,
        `Owner: ${phase.ownerAgentId}`,
        `Spec path: ${phase.specPath}`,
        `Loop mode: ${phase.loopMode}`,
      ].join("\n"),
      runId: run.runId,
      phaseId: phase.phaseId,
      workspace: "memory",
    })
      .then((pack) => {
        this.publishRealtime("memory_qmd_generated", "orchestration", {
          runId: run.runId,
          phaseId: phase.phaseId,
          contextId: pack.contextId,
          status: pack.quality.status,
        });
      })
      .catch((error) => {
        this.publishRealtime("memory_qmd_failed", "orchestration", {
          runId: run.runId,
          phaseId: phase.phaseId,
          error: (error as Error).message,
        });
      })
      .finally(() => {
        this.backgroundTasks.delete(task);
      });

    this.backgroundTasks.add(task);
    void task;
  }

  private async readTranscriptOrEmpty(sessionId: string) {
    try {
      return await this.storage.transcripts.read(sessionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async ensureChatMessageProjection(sessionId: string): Promise<void> {
    if (this.chatMessageProjectionBackfillAttempted.has(sessionId)) {
      return;
    }
    this.chatMessageProjectionBackfillAttempted.add(sessionId);
    if (this.storage.chatMessages.countBySession(sessionId) > 0) {
      return;
    }
    const events = await this.readTranscriptOrEmpty(sessionId);
    const projected = events
      .filter((event) => event.type === "message.user" || event.type === "message.assistant")
      .map((event) => toChatMessageRecord(event))
      .filter((message): message is ChatMessageRecord => Boolean(message));
    if (projected.length === 0) {
      return;
    }
    this.storage.chatMessages.upsertMany(projected);
  }

  private async listChatMessagesFromTranscript(
    sessionId: string,
    limit: number,
    cursor?: string,
  ): Promise<ChatMessageRecord[]> {
    const events = await this.readTranscriptOrEmpty(sessionId);
    let messages = events
      .filter((event) => event.type === "message.user" || event.type === "message.assistant")
      .map((event) => toChatMessageRecord(event))
      .filter((message): message is ChatMessageRecord => Boolean(message));

    if (cursor) {
      const index = messages.findIndex((message) => message.messageId === cursor);
      if (index >= 0) {
        messages = messages.slice(0, index);
      }
    }
    return messages.slice(-Math.max(1, Math.min(limit, 1000)));
  }

  private normalizeWorkspaceId(workspaceId?: string): string {
    if (!workspaceId?.trim()) {
      return DEFAULT_WORKSPACE_ID;
    }
    const normalized = workspaceId.trim();
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(normalized)) {
      throw new Error("workspaceId contains unsupported characters");
    }
    return normalized;
  }

  private resolveGuidancePath(
    docType: GuidanceDocType,
    scope: "global" | "workspace",
    workspaceId?: string,
  ): { fileName: string; absolutePath: string } {
    const fileName = GUIDANCE_DOC_FILE_MAP[docType];
    if (!fileName) {
      throw new Error(`Unsupported guidance doc type: ${docType}`);
    }
    if (scope === "global") {
      return {
        fileName,
        absolutePath: path.resolve(this.config.rootDir, fileName),
      };
    }
    const normalizedWorkspaceId = this.normalizeWorkspaceId(workspaceId);
    return {
      fileName,
      absolutePath: path.resolve(this.config.rootDir, "workspaces", normalizedWorkspaceId, fileName),
    };
  }

  private async readGuidanceDocument(
    docType: GuidanceDocType,
    scope: "global" | "workspace",
    workspaceId?: string,
  ): Promise<GuidanceDocumentRecord> {
    const normalizedWorkspaceId = scope === "workspace" ? this.normalizeWorkspaceId(workspaceId) : undefined;
    const resolved = this.resolveGuidancePath(docType, scope, normalizedWorkspaceId);
    try {
      const [content, stat] = await Promise.all([
        fs.readFile(resolved.absolutePath, "utf8"),
        fs.stat(resolved.absolutePath),
      ]);
      return {
        docType,
        scope,
        workspaceId: normalizedWorkspaceId,
        fileName: resolved.fileName,
        absolutePath: resolved.absolutePath,
        exists: true,
        content,
        updatedAt: stat.mtime.toISOString(),
      };
    } catch {
      return {
        docType,
        scope,
        workspaceId: normalizedWorkspaceId,
        fileName: resolved.fileName,
        absolutePath: resolved.absolutePath,
        exists: false,
        content: "",
      };
    }
  }

  private async writeGuidanceDocument(
    docType: GuidanceDocType,
    scope: "global" | "workspace",
    workspaceId: string | undefined,
    content: string,
  ): Promise<void> {
    const resolved = this.resolveGuidancePath(docType, scope, workspaceId);
    await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    const normalizedContent = content.replace(/\r\n/g, "\n").trimEnd() + "\n";
    await fs.writeFile(resolved.absolutePath, normalizedContent, "utf8");
  }

  private async resolveRuntimeGuidance(workspaceId: string): Promise<ResolvedRuntimeGuidance> {
    const normalizedWorkspaceId = this.normalizeWorkspaceId(workspaceId);
    if (isTruthy(process.env[GUIDANCE_DEBUG_KILL_SWITCH_ENV])) {
      return {
        workspaceId: normalizedWorkspaceId,
        globalFilesUsed: [],
        workspaceFilesUsed: [],
        truncated: false,
      };
    }

    const globalFilesUsed: string[] = [];
    const workspaceFilesUsed: string[] = [];
    const selectedBlocks: Array<{ title: string; content: string }> = [];

    for (const docType of RUNTIME_GUIDANCE_DOC_TYPES) {
      const [workspaceDoc, globalDoc] = await Promise.all([
        this.readGuidanceDocument(docType, "workspace", normalizedWorkspaceId),
        this.readGuidanceDocument(docType, "global"),
      ]);
      const selected = workspaceDoc.exists ? workspaceDoc : (globalDoc.exists ? globalDoc : undefined);
      if (!selected || !selected.content.trim()) {
        continue;
      }
      if (selected.scope === "workspace") {
        workspaceFilesUsed.push(selected.fileName);
      } else {
        globalFilesUsed.push(selected.fileName);
      }
      selectedBlocks.push({
        title: `${selected.fileName} (${selected.scope})`,
        content: selected.content.trim(),
      });
    }

    const header = [
      `Workspace context: ${normalizedWorkspaceId}.`,
      "Apply these runtime guidance notes with workspace overrides taking precedence over global defaults.",
    ].join("\n");
    const immutableSafetyFooter = [
      "Non-overridable safety invariants:",
      "- Approval requirements remain authoritative.",
      "- Deny-wins policy remains authoritative.",
      "- Tool grants and host/network/path security boundaries remain authoritative.",
    ].join("\n");
    const budgetForBlocks = Math.max(
      1200,
      MAX_RUNTIME_GUIDANCE_CHARS - header.length - immutableSafetyFooter.length - 12,
    );

    let consumed = 0;
    let truncated = false;
    const blockLines: string[] = [];
    for (const block of selectedBlocks) {
      if (consumed >= budgetForBlocks) {
        truncated = true;
        break;
      }
      const rendered = `## ${block.title}\n${block.content}`;
      if (consumed + rendered.length <= budgetForBlocks) {
        blockLines.push(rendered);
        consumed += rendered.length;
        continue;
      }
      const remaining = budgetForBlocks - consumed;
      if (remaining > 80) {
        blockLines.push(`${rendered.slice(0, remaining)}\n...[truncated]`);
      }
      truncated = true;
      consumed = budgetForBlocks;
      break;
    }

    const systemInstruction = [header, ...blockLines, immutableSafetyFooter].filter(Boolean).join("\n\n");
    return {
      workspaceId: normalizedWorkspaceId,
      systemInstruction: systemInstruction.trim().length > 0 ? systemInstruction : undefined,
      globalFilesUsed,
      workspaceFilesUsed,
      truncated,
    };
  }

  private requireChatSession(sessionId: string): ChatSessionRecord {
    const session = this.getSession(sessionId);
    const projectLink = this.storage.chatSessionProjects.get(sessionId);
    const project = projectLink ? this.storage.chatProjects.find(projectLink.projectId) : undefined;
    const meta = this.storage.chatSessionMeta.get(sessionId)
      ?? this.storage.chatSessionMeta.ensure(sessionId, undefined, project?.workspaceId ?? DEFAULT_WORKSPACE_ID);
    return toChatSessionRecord(session, meta, project);
  }

  private routeFromSession(session: SessionMeta): {
    channel: string;
    account: string;
    peer?: string;
    room?: string;
    threadId?: string;
  } {
    const parts = session.sessionKey.split(":");
    const third = parts[2];
    const fourth = parts[3];
    if (session.kind === "dm") {
      return {
        channel: session.channel,
        account: session.account,
        peer: third,
      };
    }
    if (session.kind === "group") {
      return {
        channel: session.channel,
        account: session.account,
        room: third,
      };
    }
    return {
      channel: session.channel,
      account: session.account,
      room: third,
      threadId: fourth,
    };
  }

  private async buildLlmMessagesFromTranscript(
    sessionId: string,
    options?: {
      providerId?: string;
      model?: string;
      guidanceSystemInstruction?: string;
    },
  ): Promise<ChatCompletionRequest["messages"]> {
    const runtime = this.llmService.getRuntimeConfig();
    const providerId = options?.providerId ?? runtime.activeProviderId;
    const providerSummary = runtime.providers.find((item) => item.providerId === providerId);
    const model = options?.model ?? providerSummary?.defaultModel ?? runtime.activeModel;
    const supportsVision = Boolean(providerSummary?.capabilities?.vision || inferModelVisionSupport(model));
    const transcript = await this.readTranscriptOrEmpty(sessionId);
    const mapped = await Promise.all(transcript
      .filter((event) => event.type === "message.user" || event.type === "message.assistant")
      .map(async (event) => {
        const payload = event.payload as {
          message?: {
            role?: string;
            content?: unknown;
            parts?: unknown;
            attachments?: unknown;
          };
        };
        const baseContent = typeof payload.message?.content === "string"
          ? payload.message.content
          : this.extractMessagePreview(event.payload);
        if (event.type === "message.user") {
          const userMessage: ChatMessageRecord = {
            messageId: event.eventId,
            sessionId,
            role: "user",
            actorType: "user",
            actorId: "operator",
            content: baseContent,
            timestamp: event.timestamp,
            parts: parseMessageParts(payload.message?.parts),
            attachments: parseMessageAttachments(payload.message?.attachments),
          };
          return {
            role: "user" as const,
            content: await this.buildUserMessageContent(userMessage, supportsVision),
          };
        }
        return {
          role: "assistant" as const,
          content: baseContent,
        };
      }));
    const messages = await this.compactTranscriptMessages(sessionId, transcript, mapped);
    if (options?.guidanceSystemInstruction?.trim()) {
      return [
        {
          role: "system",
          content: options.guidanceSystemInstruction.trim(),
        },
        ...messages,
      ];
    }
    return messages;
  }

  private listHydratedChatTurnTraces(sessionId: string, limit = 200): ChatTurnTraceRecord[] {
    const traces = this.storage.chatTurnTraces.listBySession(sessionId, limit);
    const toolRunsByTurnId = this.storage.chatToolRuns.listByTurnIds(traces.map((trace) => trace.turnId));
    const executionPlansById = new Map(
      traces
        .filter((trace) => trace.executionPlanId)
        .map((trace) => {
          try {
            return [trace.executionPlanId!, this.storage.chatExecutionPlans.get(trace.executionPlanId!)] as const;
          } catch {
            return undefined;
          }
        })
        .filter((entry): entry is readonly [string, ReturnType<Storage["chatExecutionPlans"]["get"]>] => Boolean(entry)),
    );
    return traces.map((trace) => ({
      ...trace,
      toolRuns: toolRunsByTurnId.get(trace.turnId) ?? [],
      citations: trace.citations ?? [],
      executionPlan: trace.executionPlanId ? executionPlansById.get(trace.executionPlanId) : undefined,
      capabilityUpgradeSuggestions: trace.capabilityUpgradeSuggestions,
    }));
  }

  private resolveChatActiveLeafTurnId(
    sessionId: string,
    traces: ChatTurnTraceRecord[],
  ): string | undefined {
    const branchState = this.storage.chatSessionBranchState.get(sessionId);
    if (branchState && traces.some((trace) => trace.turnId === branchState.activeLeafTurnId)) {
      return branchState.activeLeafTurnId;
    }
    const newest = [...traces]
      .sort((left, right) => {
        const leftStarted = Date.parse(left.startedAt) || 0;
        const rightStarted = Date.parse(right.startedAt) || 0;
        if (leftStarted !== rightStarted) {
          return rightStarted - leftStarted;
        }
        return right.turnId.localeCompare(left.turnId);
      })
      .at(0);
    if (!newest) {
      return undefined;
    }
    const newestLeafTurnId = resolveNewestLeafTurnId(
      newest.turnId,
      new Map(traces.map((trace) => [trace.turnId, {
        turnId: trace.turnId,
        startedAtMs: Date.parse(trace.startedAt) || 0,
      }])),
      this.buildChatTurnChildrenMap(traces),
    );
    this.storage.chatSessionBranchState.setActiveLeaf(
      sessionId,
      newestLeafTurnId,
      newest.finishedAt ?? newest.startedAt,
    );
    return newestLeafTurnId;
  }

  private buildChatTurnChildrenMap(traces: ChatTurnTraceRecord[]): Map<string, string[]> {
    const childrenByTurnId = new Map<string, string[]>();
    for (const trace of traces) {
      if (!trace.parentTurnId) {
        continue;
      }
      const children = childrenByTurnId.get(trace.parentTurnId) ?? [];
      children.push(trace.turnId);
      childrenByTurnId.set(trace.parentTurnId, children);
    }
    return childrenByTurnId;
  }

  private async buildLlmMessagesFromBranchPath(
    sessionId: string,
    pathTurnIds: string[],
    currentUserMessage: ChatMessageRecord | undefined,
    options?: {
      providerId?: string;
      model?: string;
      guidanceSystemInstruction?: string;
    },
    state?: Awaited<ReturnType<GatewayService["loadChatTurnSessionState"]>>,
  ): Promise<ChatCompletionRequest["messages"]> {
    const sessionState = state ?? await this.loadChatTurnSessionState(sessionId);
    const orderedMessages: ChatMessageRecord[] = [];
    for (const turnId of pathTurnIds) {
      const trace = sessionState.tracesById.get(turnId);
      if (!trace) {
        continue;
      }
      const userMessage = sessionState.messagesById.get(trace.userMessageId);
      if (userMessage) {
        orderedMessages.push(userMessage);
      }
      if (trace.assistantMessageId) {
        const assistantMessage = sessionState.messagesById.get(trace.assistantMessageId);
        if (assistantMessage) {
          orderedMessages.push(assistantMessage);
        }
      }
    }
    if (currentUserMessage) {
      orderedMessages.push(currentUserMessage);
    }
    return this.buildLlmMessagesFromRecords(orderedMessages, {
      ...options,
      sessionId,
      branchHeadTurnId: pathTurnIds.at(-1),
      branchTurnIds: pathTurnIds,
    });
  }

  private async buildLlmMessagesFromRecords(
    records: ChatMessageRecord[],
    options?: {
      providerId?: string;
      model?: string;
      guidanceSystemInstruction?: string;
      sessionId?: string;
      branchHeadTurnId?: string;
      branchTurnIds?: string[];
    },
  ): Promise<ChatCompletionRequest["messages"]> {
    const runtime = this.llmService.getRuntimeConfig();
    const providerId = options?.providerId ?? runtime.activeProviderId;
    const providerSummary = runtime.providers.find((item) => item.providerId === providerId);
    const model = options?.model ?? providerSummary?.defaultModel ?? runtime.activeModel;
    const supportsVision = Boolean(providerSummary?.capabilities?.vision || inferModelVisionSupport(model));
    const mapped = await Promise.all(records.map(async (message) => {
      if (message.role === "assistant") {
        return {
          role: "assistant" as const,
          content: message.content,
        };
      }
      if (message.role === "system") {
        return {
          role: "system" as const,
          content: message.content,
        };
      }
      return {
        role: "user" as const,
        content: await this.buildUserMessageContent(message, supportsVision),
      };
    }));
    const messages = options?.sessionId && options.branchTurnIds && options.branchTurnIds.length > 0
      ? await this.compactBranchMappedMessages({
        sessionId: options.sessionId,
        branchHeadTurnId: options.branchHeadTurnId ?? options.branchTurnIds.at(-1) ?? options.sessionId,
        branchTurnIds: options.branchTurnIds,
        records,
        mapped,
      })
      : mapped;
    if (!options?.guidanceSystemInstruction?.trim()) {
      return messages;
    }
    return [
      {
        role: "system",
        content: options.guidanceSystemInstruction.trim(),
      },
      ...messages,
    ];
  }

  private async compactTranscriptMessages(
    sessionId: string,
    transcript: TranscriptEvent[],
    mapped: ChatCompletionRequest["messages"],
  ): Promise<ChatCompletionRequest["messages"]> {
    if (mapped.length <= CHAT_COMPACTION_RECENT_TURN_LIMIT * 2) {
      return mapped;
    }
    if (estimateTokensFromText(stringifyMessagesForTokenEstimate(mapped)) <= CHAT_COMPACTION_TRIGGER_TOKENS) {
      return mapped;
    }
    const records = transcript
      .filter((event) => event.type === "message.user" || event.type === "message.assistant")
      .map((event) => ({
        messageId: event.eventId,
        sessionId,
        role: event.type === "message.user" ? "user" : "assistant",
        actorType: event.type === "message.user" ? "user" : "agent",
        actorId: event.type === "message.user" ? "operator" : "assistant",
        content: this.extractMessagePreview(event.payload),
        timestamp: event.timestamp,
      } satisfies ChatMessageRecord));
    const recentRecords = records.slice(-(CHAT_COMPACTION_RECENT_TURN_LIMIT * 2));
    const summary = buildConversationCompactionSummary(records.slice(0, Math.max(0, records.length - recentRecords.length)));
    const recentMessages = mapped.slice(-(CHAT_COMPACTION_RECENT_TURN_LIMIT * 2));
    if (!summary) {
      return recentMessages;
    }
    return [
      {
        role: "system",
        content: truncateByTokenEstimate(summary, CHAT_COMPACTION_SUMMARY_TOKEN_BUDGET),
      },
      ...recentMessages,
    ];
  }

  private async compactBranchMappedMessages(input: {
    sessionId: string;
    branchHeadTurnId: string;
    branchTurnIds: string[];
    records: ChatMessageRecord[];
    mapped: ChatCompletionRequest["messages"];
  }): Promise<ChatCompletionRequest["messages"]> {
    const totalTokens = estimateTokensFromText(stringifyMessagesForTokenEstimate(input.mapped));
    if (
      input.branchTurnIds.length <= CHAT_COMPACTION_RECENT_TURN_LIMIT
      || totalTokens <= CHAT_COMPACTION_TRIGGER_TOKENS
    ) {
      return input.mapped;
    }

    const recentTurnIds = input.branchTurnIds.slice(-CHAT_COMPACTION_RECENT_TURN_LIMIT);
    const olderTurnIds = input.branchTurnIds.slice(0, Math.max(0, input.branchTurnIds.length - recentTurnIds.length));
    if (olderTurnIds.length === 0) {
      return input.mapped;
    }

    const grouped = buildBranchRecordGroups(input.branchTurnIds, input.records);
    const summaryMessages: ChatCompletionRequest["messages"] = [];
    for (let index = 0; index < olderTurnIds.length; index += CHAT_COMPACTION_WINDOW_SIZE) {
      const windowTurnIds = olderTurnIds.slice(index, index + CHAT_COMPACTION_WINDOW_SIZE);
      const windowMessages = windowTurnIds.flatMap((turnId) => grouped.turnMessagesById.get(turnId) ?? []);
      if (windowMessages.length === 0) {
        continue;
      }
      const summary = this.getOrCreateConversationSummary({
        sessionId: input.sessionId,
        branchHeadTurnId: input.branchHeadTurnId,
        turnIds: windowTurnIds,
        messages: windowMessages,
      });
      if (!summary) {
        continue;
      }
      summaryMessages.push({
        role: "system",
        content: summary,
      });
    }

    const verbatimMessages = recentTurnIds.flatMap((turnId) => grouped.turnMessagesById.get(turnId) ?? []);
    const finalVerbatimRecords = [...verbatimMessages, ...grouped.trailingMessages];
    const mappedVerbatim = await Promise.all(finalVerbatimRecords.map(async (message) => {
      const mappedIndex = input.records.findIndex((item) => item.messageId === message.messageId);
      if (mappedIndex >= 0) {
        return input.mapped[mappedIndex]!;
      }
      return message.role === "assistant"
        ? { role: "assistant" as const, content: message.content }
        : { role: "user" as const, content: message.content };
    }));

    return [
      ...summaryMessages,
      ...mappedVerbatim,
    ];
  }

  private getOrCreateConversationSummary(input: {
    sessionId: string;
    branchHeadTurnId: string;
    turnIds: string[];
    messages: ChatMessageRecord[];
  }): string | undefined {
    if (input.turnIds.length === 0 || input.messages.length === 0) {
      return undefined;
    }
    const source = input.messages
      .map((message) => `${message.role.toUpperCase()}: ${message.content.trim()}`)
      .filter((line) => line.length > 0)
      .join("\n\n");
    if (!source) {
      return undefined;
    }
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const existing = this.storage.chatConversationSummaries
      .listByBranch(input.sessionId, input.branchHeadTurnId)
      .find((summary) =>
        summary.startTurnId === input.turnIds[0]
        && summary.endTurnId === input.turnIds.at(-1)
        && summary.sourceHash === sourceHash
      );
    if (existing) {
      return existing.summary;
    }
    const summary = buildConversationCompactionSummary(input.messages);
    if (!summary) {
      return undefined;
    }
    const persisted = this.storage.chatConversationSummaries.upsert({
      sessionId: input.sessionId,
      branchHeadTurnId: input.branchHeadTurnId,
      startTurnId: input.turnIds[0]!,
      endTurnId: input.turnIds.at(-1)!,
      turnIds: input.turnIds,
      sourceHash,
      tokenEstimate: estimateTokensFromText(source),
      summary,
    });
    return persisted.summary;
  }

  private async buildUserMessageContent(
    message: ChatMessageRecord,
    supportsVision: boolean,
  ): Promise<string | Array<Record<string, unknown>>> {
    const prompt = this.buildUserMessagePrompt(message);
    const attachments = this.resolveMessageAttachments(message);
    const contentParts = await this.buildAttachmentMessageParts(attachments, prompt, supportsVision);
    if (contentParts) {
      return contentParts;
    }
    const attachmentContext = this.buildAttachmentPromptContext(attachments, supportsVision);
    return attachmentContext
      ? `${prompt}\n\n${attachmentContext}`
      : prompt;
  }

  private buildUserMessagePrompt(message: ChatMessageRecord): string {
    const baseContent = message.content.trim();
    const textParts = Array.isArray(message.parts)
      ? message.parts
        .filter((part): part is Extract<ChatInputPart, { type: "text" }> => part.type === "text")
        .map((part) => part.text.trim())
        .filter(Boolean)
      : [];
    if (textParts.length === 0) {
      return baseContent;
    }
    if (!baseContent) {
      return textParts.join("\n\n");
    }
    if (textParts[0] === baseContent) {
      return textParts.join("\n\n");
    }
    return [baseContent, ...textParts].join("\n\n");
  }

  private resolveMessageAttachments(message: ChatMessageRecord): ChatAttachmentRecord[] {
    const attachmentIds = new Set<string>();
    if (Array.isArray(message.attachments)) {
      for (const attachment of message.attachments) {
        if (attachment?.attachmentId) {
          attachmentIds.add(attachment.attachmentId);
        }
      }
    }
    if (Array.isArray(message.parts)) {
      for (const part of message.parts) {
        if (part.type !== "text" && part.attachmentId) {
          attachmentIds.add(part.attachmentId);
        }
      }
    }
    if (attachmentIds.size === 0) {
      return [];
    }
    return this.storage.chatAttachments.listByIds([...attachmentIds]).slice(0, 6);
  }

  private buildAttachmentPromptContext(input: unknown, supportsVision = false): string | undefined {
    if (!Array.isArray(input) || input.length === 0) {
      return undefined;
    }

    const attachmentIds = input
      .map((item) => (item as Record<string, unknown>).attachmentId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (attachmentIds.length === 0) {
      return undefined;
    }

    const attachments = this.storage.chatAttachments.listByIds(attachmentIds).slice(0, 6);
    if (attachments.length === 0) {
      return undefined;
    }

    const lines = attachments.map((attachment) => {
      const descriptor = `- ${attachment.fileName} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`;
      if (supportsVision && isImageMimeType(attachment.mimeType)) {
        return `${descriptor}\n  Preview: sent directly to a vision-capable model.`;
      }
      if (!attachment.extractPreview?.trim()) {
        return `${descriptor}\n  Preview: unavailable for this file type in current pipeline.`;
      }
      const preview = attachment.extractPreview
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .slice(0, 1600);
      return `${descriptor}\n  Preview:\n${preview}`;
    });

    return [
      "Attached file context (from uploaded attachments):",
      ...lines,
    ].join("\n");
  }

  private async buildAttachmentMessageParts(
    input: unknown,
    prompt: string,
    supportsVision: boolean,
  ): Promise<Array<Record<string, unknown>> | undefined> {
    if (!supportsVision || !Array.isArray(input) || input.length === 0) {
      return undefined;
    }
    const attachmentIds = input
      .map((item) => (item as Record<string, unknown>).attachmentId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (attachmentIds.length === 0) {
      return undefined;
    }

    const attachments = this.storage.chatAttachments.listByIds(attachmentIds).slice(0, 4);
    const parts: Array<Record<string, unknown>> = [
      {
        type: "text",
        text: prompt,
      },
    ];

    for (const attachment of attachments) {
      if (!isImageMimeType(attachment.mimeType)) {
        continue;
      }
      try {
        const content = await this.readChatAttachmentContent(attachment.attachmentId);
        if (content.bytes.length > 5 * 1024 * 1024) {
          continue;
        }
        const dataUrl = `data:${attachment.mimeType};base64,${content.bytes.toString("base64")}`;
        parts.push({
          type: "image_url",
          image_url: {
            url: dataUrl,
          },
        });
      } catch {
        // keep chat flowing even if one image cannot be loaded
      }
    }

    return parts.length > 1 ? parts : undefined;
  }

  private extractMessagePreview(payload: Record<string, unknown>): string {
    const content = payload.content;
    if (typeof content === "string") {
      return content.slice(0, 240);
    }
    if (Array.isArray(content)) {
      return JSON.stringify(content).slice(0, 240);
    }
    const message = payload.message;
    if (typeof message === "string") {
      return message.slice(0, 240);
    }
    return JSON.stringify(payload).slice(0, 240);
  }

  private getGitHead(): string | undefined {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.config.rootDir,
        encoding: "utf8",
      }).trim();
    } catch {
      return undefined;
    }
  }

  private buildAgentRuntimeRollups(
    profiles: Pick<AgentProfileRecord, "roleId" | "name" | "aliases">[],
  ): Map<string, { sessionCount: number; activeSessions: number; lastUpdatedAt?: string }> {
    const byRoleId = new Map<string, { sessionCount: number; activeSessions: number; lastUpdatedAt?: string }>();
    const lookup = new Map<string, string>();

    for (const profile of profiles) {
      const roleKey = this.normalizeLookupValue(profile.roleId);
      if (roleKey) {
        lookup.set(roleKey, profile.roleId);
      }
      const nameKey = this.normalizeLookupValue(profile.name);
      if (nameKey) {
        lookup.set(nameKey, profile.roleId);
      }
      for (const alias of profile.aliases) {
        const aliasKey = this.normalizeLookupValue(alias);
        if (aliasKey) {
          lookup.set(aliasKey, profile.roleId);
        }
      }
    }

    const sessions = this.storage.taskSubagents.listAll(5000);
    for (const session of sessions) {
      const roleId = this.inferSessionRoleId(session.agentName, session.agentSessionId, lookup);
      if (!roleId) {
        continue;
      }

      const current = byRoleId.get(roleId) ?? {
        sessionCount: 0,
        activeSessions: 0,
        lastUpdatedAt: undefined as string | undefined,
      };
      current.sessionCount += 1;
      if (session.status === "active") {
        current.activeSessions += 1;
      }
      if (!current.lastUpdatedAt || Date.parse(session.updatedAt) > Date.parse(current.lastUpdatedAt)) {
        current.lastUpdatedAt = session.updatedAt;
      }
      byRoleId.set(roleId, current);
    }

    return byRoleId;
  }

  private inferSessionRoleId(
    agentName: string | undefined,
    agentSessionId: string,
    lookup: Map<string, string>,
  ): string | undefined {
    const directCandidates = [agentName, agentSessionId];
    for (const candidate of directCandidates) {
      if (!candidate) {
        continue;
      }
      const found = lookup.get(this.normalizeLookupValue(candidate));
      if (found) {
        return found;
      }
    }

    const normalizedName = this.normalizeLookupValue(agentName ?? "");
    const normalizedSessionId = this.normalizeLookupValue(agentSessionId);
    for (const [key, roleId] of lookup.entries()) {
      if (!key) {
        continue;
      }
      if (normalizedName.includes(key) || normalizedSessionId.includes(key)) {
        return roleId;
      }
    }

    return undefined;
  }

  private normalizeLookupValue(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  private normalizeRelativePath(inputPath: string): string {
    const normalized = path.normalize(inputPath).replaceAll("\\", "/");
    if (
      !normalized
      || normalized === "."
      || normalized === ".."
      || normalized.startsWith("../")
      || normalized.endsWith("/..")
      || normalized.includes("/../")
    ) {
      throw new Error(`Invalid relative path: ${inputPath}`);
    }
    if (path.isAbsolute(normalized)) {
      throw new Error(`Absolute paths are not allowed: ${inputPath}`);
    }
    return normalized;
  }

  private isAuthConfiguredForMode(auth: RuntimeSettings["auth"]): boolean {
    if (auth.mode === "none") {
      return true;
    }
    if (auth.mode === "token") {
      return auth.tokenConfigured;
    }
    return auth.basicConfigured;
  }

  private isProviderLikelyLocal(baseUrl: string): boolean {
    try {
      const parsed = new URL(baseUrl);
      const host = parsed.hostname.toLowerCase();
      return host === "localhost" || host === "127.0.0.1" || host === "::1";
    } catch {
      return false;
    }
  }

  private async loadOnboardingMarker(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.onboardingMarkerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.onboardingMarker = {};
        return;
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as { completedAt?: string; completedBy?: string };
      this.onboardingMarker = {
        completedAt: parsed.completedAt?.trim() || undefined,
        completedBy: parsed.completedBy?.trim() || undefined,
      };
    } catch {
      this.onboardingMarker = {};
    }
  }

  private persistOnboardingMarker(): void {
    fsSync.mkdirSync(path.dirname(this.onboardingMarkerPath), { recursive: true });
    fsSync.writeFileSync(this.onboardingMarkerPath, JSON.stringify(this.onboardingMarker, null, 2), "utf8");
  }

  private async loadCronJobsFromConfig(): Promise<void> {
    const filePath = this.getCronJobsConfigPath();
    let raw: string;

    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    const parsed = JSON.parse(raw) as { jobs?: CronJobRecord[] } | CronJobRecord[];
    const jobs = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];

    for (const job of jobs) {
      const existing = this.storage.cronJobs.get(job.jobId);
      this.storage.cronJobs.upsert({
        ...job,
        jobId: normalizeCronJobId(job.jobId),
        name: normalizeCronJobName(job.name),
        schedule: normalizeCronSchedule(job.schedule),
        enabled: Boolean(job.enabled),
        lastRunAt: job.lastRunAt ?? existing?.lastRunAt,
        nextRunAt: job.nextRunAt ?? existing?.nextRunAt,
      });
    }
  }

  private persistCronJobsConfig(): void {
    const filePath = this.getCronJobsConfigPath();
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    const jobs = this.storage.cronJobs.list().map((job) => ({
      jobId: job.jobId,
      name: job.name,
      schedule: job.schedule,
      enabled: job.enabled,
      lastRunAt: job.lastRunAt,
      nextRunAt: job.nextRunAt,
    }));
    fsSync.writeFileSync(filePath, JSON.stringify({ jobs }, null, 2), "utf8");
  }

  private getCronJobsConfigPath(): string {
    return path.join(this.config.rootDir, "config", "cron-jobs.json");
  }

  // ensureWeeklyImprovementCronJob moved to ImprovementService

  private ensurePrivateBetaBackupCronJob(): void {
    const existing = this.storage.cronJobs.get(PRIVATE_BETA_BACKUP_JOB_ID);
    const now = new Date().toISOString();
    this.storage.cronJobs.upsert({
      jobId: PRIVATE_BETA_BACKUP_JOB_ID,
      name: "Private Beta Daily Backup",
      schedule: PRIVATE_BETA_BACKUP_SCHEDULE_LABEL,
      enabled: existing?.enabled ?? true,
      lastRunAt: existing?.lastRunAt,
      nextRunAt: existing?.nextRunAt,
    }, now);
  }

  private ensureMemoryFlushCronJob(): void {
    const existing = this.storage.cronJobs.get(MEMORY_FLUSH_DAILY_JOB_ID);
    const now = new Date().toISOString();
    this.storage.cronJobs.upsert({
      jobId: MEMORY_FLUSH_DAILY_JOB_ID,
      name: "Memory Flush Daily",
      schedule: MEMORY_FLUSH_DAILY_SCHEDULE_LABEL,
      enabled: existing?.enabled ?? true,
      lastRunAt: existing?.lastRunAt,
      nextRunAt: existing?.nextRunAt,
    }, now);
  }

  private ensureCostReportCronJob(): void {
    const existing = this.storage.cronJobs.get(COST_REPORT_HOURLY_JOB_ID);
    const now = new Date().toISOString();
    this.storage.cronJobs.upsert({
      jobId: COST_REPORT_HOURLY_JOB_ID,
      name: "Cost Report Hourly",
      schedule: COST_REPORT_HOURLY_SCHEDULE_LABEL,
      enabled: existing?.enabled ?? true,
      lastRunAt: existing?.lastRunAt,
      nextRunAt: existing?.nextRunAt,
    }, now);
  }

  private persistLlmConfig(): void {
    const filePath = path.join(this.config.rootDir, "config", "llm-providers.json");
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, JSON.stringify(this.llmService.exportConfigFile(), null, 2), "utf8");
  }

  private persistToolPolicyConfig(): void {
    const filePath = path.join(this.config.rootDir, "config", "tool-policy.json");
    const payload = {
      ...this.config.toolPolicy,
      sandbox: {
        ...this.config.toolPolicy.sandbox,
        writeJailRoots: this.config.toolPolicy.sandbox.writeJailRoots.map((root) => this.serializeRootPath(root)),
        readOnlyRoots: this.config.toolPolicy.sandbox.readOnlyRoots.map((root) => this.serializeRootPath(root)),
      },
    };
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  }

  private persistBudgetsConfig(): void {
    const filePath = path.join(this.config.rootDir, "config", "budgets.json");
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, JSON.stringify(this.config.budgets, null, 2), "utf8");
  }

  private persistAssistantConfig(): void {
    const filePath = path.join(this.config.rootDir, "config", "assistant.config.json");
    const payload = {
      environment: this.config.assistant.environment,
      defaultToolProfile: this.config.assistant.defaultToolProfile,
      dataDir: this.config.assistant.dataDir,
      transcriptsDir: this.config.assistant.transcriptsDir,
      auditDir: this.config.assistant.auditDir,
      workspaceDir: this.config.assistant.workspaceDir,
      worktreesDir: this.config.assistant.worktreesDir,
      auth: {
        mode: this.config.assistant.auth.mode,
        allowLoopbackBypass: this.config.assistant.auth.allowLoopbackBypass,
        token: {
          queryParam: this.config.assistant.auth.token.queryParam,
        },
        basic: {},
      },
      approvalExplainer: this.config.assistant.approvalExplainer,
      memory: this.config.assistant.memory,
      mesh: this.config.assistant.mesh,
      npu: this.config.assistant.npu,
      sqlite: this.config.assistant.sqlite,
      durable: this.config.assistant.durable,
      features: this.readFeatureFlags(),
      budgets: this.config.assistant.budgets,
    };
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  }

  private getBackupDirectory(): string {
    const fromEnv = process.env.GOATCITADEL_BACKUP_DIR?.trim();
    if (fromEnv) {
      return path.resolve(fromEnv);
    }
    return path.join(os.homedir(), ".GoatCitadel", "backups");
  }

  private buildBackupIncludePaths(): string[] {
    const paths = new Set<string>();
    paths.add(path.relative(this.config.rootDir, this.config.dbPath).replaceAll("\\", "/"));
    paths.add(`${path.relative(this.config.rootDir, this.config.dbPath).replaceAll("\\", "/")}-wal`);
    paths.add(`${path.relative(this.config.rootDir, this.config.dbPath).replaceAll("\\", "/")}-shm`);
    paths.add(this.config.assistant.transcriptsDir.replaceAll("\\", "/"));
    paths.add(this.config.assistant.auditDir.replaceAll("\\", "/"));
    paths.add("config");
    return [...paths];
  }

  private serializeRootPath(fullPath: string): string {
    return serializePathWithinRoot(
      this.config.rootDir,
      fullPath,
      this.warnedOutsideRootPathFingerprints,
    );
  }
}

function extractPromptFromMessages(messages: ChatCompletionRequest["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => {
          const maybeText = (part as Record<string, unknown>).text;
          return typeof maybeText === "string" ? maybeText : "";
        })
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function buildMemoryContextSystemMessage(pack: MemoryContextPack): string {
  return [
    "Distilled context from GoatCitadel memory:",
    pack.contextText,
    "",
    `ContextId: ${pack.contextId}`,
    `Citations: ${pack.citations.length}`,
  ].join("\n");
}

function calculateSavings(originalTokens: number, distilledTokens: number): number {
  if (originalTokens <= 0) {
    return 0;
  }
  return Number((((originalTokens - distilledTokens) / originalTokens) * 100).toFixed(2));
}

function findPlanPhase(plan: OrchestrationPlan, phaseId: string) {
  for (const wave of plan.waves) {
    const phase = wave.phases.find((item) => item.phaseId === phaseId);
    if (phase) {
      return phase;
    }
  }
  return undefined;
}

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    return "text/html";
  }
  if (ext === ".css") {
    return "text/css";
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts" || ext === ".tsx") {
    return "application/javascript";
  }
  if (ext === ".json") {
    return "application/json";
  }
  if (ext === ".md") {
    return "text/markdown";
  }
  if (ext === ".txt" || ext === ".log") {
    return "text/plain";
  }
  if (ext === ".svg") {
    return "image/svg+xml";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  if (ext === ".pdf") {
    return "application/pdf";
  }
  return "application/octet-stream";
}

function isTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/javascript" ||
    contentType === "text/markdown"
  );
}

const FILE_TEMPLATES: FileTemplateRecord[] = [
  {
    templateId: "artifact-report",
    title: "Artifact Report",
    description: "Structured report artifact with purpose, evidence, and next actions.",
    defaultPath: "artifacts/artifact-report-{date}.md",
    body: [
      "# Artifact Report ({date})",
      "",
      "## What this is",
      "- Brief description of the artifact and why it exists.",
      "",
      "## Inputs",
      "- Source files:",
      "- Data references:",
      "",
      "## Output",
      "- Result summary:",
      "",
      "## Verification",
      "- Checks performed:",
      "- Remaining risk:",
      "",
      "## Next actions",
      "- [ ] Follow-up item 1",
      "- [ ] Follow-up item 2",
      "",
    ].join("\n"),
  },
  {
    templateId: "research-brief",
    title: "Research Brief",
    description: "Quick research summary with findings and citations.",
    defaultPath: "docs/research-brief-{date}.md",
    body: [
      "# Research Brief ({date})",
      "",
      "## Question",
      "- What are we trying to answer?",
      "",
      "## Findings",
      "1. Finding one",
      "2. Finding two",
      "",
      "## Sources",
      "- Source 1:",
      "- Source 2:",
      "",
      "## Recommendation",
      "- Proposed decision and tradeoff.",
      "",
    ].join("\n"),
  },
  {
    templateId: "release-note",
    title: "Release Note",
    description: "Release note draft with highlights, fixes, and known issues.",
    defaultPath: "docs/release-notes-{date}.md",
    body: [
      "# Release Notes ({date})",
      "",
      "## Highlights",
      "- Feature 1",
      "- Feature 2",
      "",
      "## Fixes",
      "- Fix 1",
      "- Fix 2",
      "",
      "## Known Issues",
      "- Issue 1",
      "",
      "## Upgrade Notes",
      "- Migration/compatibility guidance.",
      "",
    ].join("\n"),
  },
  {
    templateId: "bug-report",
    title: "Bug Report",
    description: "Bug template for reproducible issue reports.",
    defaultPath: "artifacts/bug-report-{date}.md",
    body: [
      "# Bug Report ({date})",
      "",
      "## Summary",
      "- One-line description.",
      "",
      "## Repro Steps",
      "1. Step one",
      "2. Step two",
      "",
      "## Expected",
      "- What should happen.",
      "",
      "## Actual",
      "- What happened instead.",
      "",
      "## Environment",
      "- OS:",
      "- Branch/commit:",
      "- Config context:",
      "",
    ].join("\n"),
  },
];

async function walkFiles(
  rootDir: string,
  currentDir: string,
  out: MemoryFileEntry[],
  maxItems: number,
): Promise<void> {
  if (out.length >= maxItems) {
    return;
  }

  let entries: Array<{ isDirectory: () => boolean; isFile: () => boolean; name: string }>;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= maxItems) {
      return;
    }

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(rootDir, fullPath, out, maxItems);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const stat = await fs.stat(fullPath);
    out.push({
      relativePath: path.relative(rootDir, fullPath).replaceAll("\\", "/"),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
}

function toChatSessionRecord(
  session: SessionMeta,
  meta: {
    workspaceId?: string;
    title?: string;
    pinned: boolean;
    lifecycleStatus: "active" | "archived";
    archivedAt?: string;
  },
  project?: ChatProjectRecord,
): ChatSessionRecord {
  return {
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    workspaceId: meta.workspaceId ?? project?.workspaceId,
    scope: session.channel === "mission" ? "mission" : "external",
    title: meta.title ?? session.displayName,
    pinned: meta.pinned,
    lifecycleStatus: meta.lifecycleStatus,
    archivedAt: meta.archivedAt,
    projectId: project?.projectId,
    projectName: project?.name,
    channel: session.channel,
    account: session.account,
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastActivityAt,
    tokenTotal: session.tokenTotal,
    costUsdTotal: session.costUsdTotal,
  };
}

function toChatMessageRecord(event: TranscriptEvent): ChatMessageRecord | undefined {
  const payload = event.payload as {
    message?: {
      role?: string;
      content?: unknown;
      parts?: unknown;
      attachments?: unknown;
    };
  };
  const message = payload.message;
  if (!message || typeof message.content !== "string") {
    return undefined;
  }
  const role = message.role === "assistant" ? "assistant" : "user";
  return {
    messageId: event.eventId,
    sessionId: event.sessionId,
    role,
    actorType: event.actorType,
    actorId: event.actorId,
    content: message.content,
    timestamp: event.timestamp,
    tokenInput: event.tokenInput,
    tokenOutput: event.tokenOutput,
    costUsd: event.costUsd,
    parts: parseMessageParts(message.parts),
    attachments: parseMessageAttachments(message.attachments),
  };
}

function parseMessageParts(input: unknown): ChatMessageRecord["parts"] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const parts = input
    .map((item) => normalizeMessagePart(item))
    .filter((item): item is ChatInputPart => Boolean(item));
  return parts.length > 0 ? parts : undefined;
}

function normalizeMessagePart(input: unknown): ChatInputPart | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  const type = typeof value.type === "string" ? value.type : undefined;
  if (!type) {
    return undefined;
  }
  if (type === "text") {
    const text = typeof value.text === "string" ? value.text : undefined;
    return text !== undefined ? { type: "text", text } : undefined;
  }
  if (type === "image_ref") {
    const attachmentId = typeof value.attachmentId === "string" ? value.attachmentId : undefined;
    if (!attachmentId) {
      return undefined;
    }
    return {
      type,
      attachmentId,
      mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
      detail: value.detail === "low" || value.detail === "high" || value.detail === "auto"
        ? value.detail
        : undefined,
    };
  }
  if (type === "audio_ref" || type === "video_ref" || type === "file_ref") {
    const attachmentId = typeof value.attachmentId === "string" ? value.attachmentId : undefined;
    if (!attachmentId) {
      return undefined;
    }
    return {
      type,
      attachmentId,
      mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
    };
  }
  return undefined;
}

function parseMessageAttachments(input: unknown): ChatMessageRecord["attachments"] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const attachments = input
    .map((item) => {
      const value = item as Record<string, unknown>;
      const attachmentId = typeof value.attachmentId === "string" ? value.attachmentId : undefined;
      const fileName = typeof value.fileName === "string" ? value.fileName : undefined;
      const mimeType = typeof value.mimeType === "string" ? value.mimeType : undefined;
      const sizeBytes = typeof value.sizeBytes === "number" ? value.sizeBytes : undefined;
      if (!attachmentId || !fileName || !mimeType || sizeBytes === undefined) {
        return undefined;
      }
      return {
        attachmentId,
        fileName,
        mimeType,
        sizeBytes,
      };
    })
    .filter((item): item is NonNullable<ChatMessageRecord["attachments"]>[number] => Boolean(item));
  return attachments.length > 0 ? attachments : undefined;
}

function extractAssistantContent(response: ChatCompletionResponse): string {
  const choice = response.choices?.[0];
  const message = choice?.message;
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        const value = part as Record<string, unknown>;
        return typeof value.text === "string" ? value.text : "";
      })
      .join("")
      .trim();
    return text;
  }
  return "";
}

function parseUsageFromChatResponse(response: ChatCompletionResponse): {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
} {
  const usage = (response.usage ?? {}) as Record<string, unknown>;
  return {
    inputTokens: readNumber(usage.prompt_tokens) ?? readNumber(usage.input_tokens),
    outputTokens: readNumber(usage.completion_tokens) ?? readNumber(usage.output_tokens),
    cachedInputTokens: readNumber(usage.cached_prompt_tokens) ?? readNumber(usage.cached_input_tokens),
    costUsd: readNumber(usage.cost_usd) ?? readNumber(usage.total_cost_usd),
  };
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function splitIntoChunks(input: string, maxChunkLength: number): string[] {
  if (!input) {
    return [];
  }
  const chunks: string[] = [];
  let remaining = input;
  const chunkSize = Math.max(1, maxChunkLength);
  while (remaining.length > chunkSize) {
    chunks.push(remaining.slice(0, chunkSize));
    remaining = remaining.slice(chunkSize);
  }
  chunks.push(remaining);
  return chunks;
}

function buildEmptyAssistantTurnFallbackText(): string {
  return [
    "Summary",
    "- I completed the turn, but the final assistant text was empty after tool/model synthesis.",
    "",
    "Constraints",
    "- This usually means tool/model outputs were incomplete or could not be stitched into a final response.",
    "",
    "What I did instead",
    "- Preserved trace/tool evidence for this turn.",
    "",
    "What I need from you next",
    "- Retry once, or provide tighter constraints (explicit query/url/path) for deterministic tool execution.",
  ].join("\n");
}

function inferDegradedAssistantTurnFailure(content: string): ChatTurnFailureRecord | undefined {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized.startsWith("i ran out of time before i could finish")
    || normalized.startsWith("i couldn't finish that cleanly because")
    || normalized.includes("recover useful content from")
    || normalized.includes("strongest leads so far")
  ) {
    return {
      failureClass: "unknown",
      message: "Assistant response degraded into a fallback-style partial answer after tool execution.",
      retryable: true,
      recommendedAction: "retry_narrower",
    };
  }
  return undefined;
}

function sanitizeAttachmentFileName(input: string): string {
  const normalized = input
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    ?.replace(/[<>:"|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120);
  if (!normalized) {
    return "attachment.bin";
  }
  return normalized;
}

function extractAttachmentPreview(
  bytes: Buffer,
  mimeType: string,
  fileName: string,
): { extractStatus: "ready" | "unsupported" | "failed"; extractPreview?: string } {
  const lowerMime = mimeType.toLowerCase();
  const ext = path.extname(fileName).toLowerCase();
  const textLike = lowerMime.startsWith("text/")
    || lowerMime === "application/json"
    || lowerMime === "application/xml"
    || ext === ".md"
    || ext === ".txt"
    || ext === ".log"
    || ext === ".json"
    || ext === ".yaml"
    || ext === ".yml";
  if (textLike) {
    try {
      const preview = bytes.toString("utf8").slice(0, 4000);
      return { extractStatus: "ready", extractPreview: preview };
    } catch {
      return { extractStatus: "failed" };
    }
  }
  return { extractStatus: "unsupported" };
}

interface McpAuthStateRecord {
  accessTokenRef?: string;
  refreshTokenRef?: string;
  tokenExpiresAt?: string;
  oauthState?: string;
  scopes?: string[];
  updatedAt: string;
  lastCodePreview?: string;
}

interface MediaJobRow {
  job_id: string;
  session_id: string | null;
  attachment_id: string | null;
  job_type: MediaJobRecord["type"];
  status: MediaJobRecord["status"];
  input_json: string | null;
  output_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function mapMediaJobRow(row: MediaJobRow): MediaJobRecord {
  return {
    jobId: row.job_id,
    sessionId: row.session_id ?? undefined,
    attachmentId: row.attachment_id ?? undefined,
    type: row.job_type,
    status: row.status,
    inputJson: row.input_json ? safeJsonParse<Record<string, unknown>>(row.input_json, {}) : undefined,
    outputJson: row.output_json ? safeJsonParse<Record<string, unknown>>(row.output_json, {}) : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function detectAttachmentMediaType(mimeType: string): ChatAttachmentMediaType {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (
    normalized.startsWith("text/")
    || normalized === "application/json"
    || normalized === "application/xml"
    || normalized === "application/javascript"
  ) {
    return "text";
  }
  return "binary";
}

function inferAttachmentAnalysisStatus(
  mediaType: ChatAttachmentMediaType,
  extractStatus: "ready" | "unsupported" | "failed",
): "queued" | "ready" | "failed" | "unsupported" {
  if (extractStatus === "failed") {
    return "failed";
  }
  if (mediaType === "text") {
    return extractStatus === "ready" ? "ready" : "unsupported";
  }
  return "queued";
}

function inferModelVisionSupport(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized.includes("vision")
    || normalized.includes("gpt-4o")
    || normalized.includes("gpt-4.1")
    || normalized.includes("gemini")
    || normalized.includes("claude-3")
    || normalized.includes("kimi")
    || normalized.includes("glm")
  );
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("image/");
}

function normalizeChatInputParts(
  content: string,
  parts: ChatInputPart[] | undefined,
  attachments: ChatAttachmentRecord[],
): ChatInputPart[] {
  const normalizedParts = Array.isArray(parts) ? parts.filter(Boolean) : [];
  if (normalizedParts.length > 0) {
    return normalizedParts;
  }
  const attachmentParts = attachments.map((attachment) => {
    if (attachment.mediaType === "image" || isImageMimeType(attachment.mimeType)) {
      return {
        type: "image_ref" as const,
        attachmentId: attachment.attachmentId,
        mimeType: attachment.mimeType,
      };
    }
    if (attachment.mediaType === "audio") {
      return {
        type: "audio_ref" as const,
        attachmentId: attachment.attachmentId,
        mimeType: attachment.mimeType,
      };
    }
    if (attachment.mediaType === "video") {
      return {
        type: "video_ref" as const,
        attachmentId: attachment.attachmentId,
        mimeType: attachment.mimeType,
      };
    }
    return {
      type: "file_ref" as const,
      attachmentId: attachment.attachmentId,
      mimeType: attachment.mimeType,
    };
  });
  return [
    {
      type: "text",
      text: content,
    },
    ...attachmentParts,
  ];
}

function sanitizePluginId(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!sanitized) {
    return `plugin-${randomUUID().slice(0, 8)}`;
  }
  return sanitized.slice(0, 80);
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_.]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parseBankrAuditCursor(
  cursor?: string,
): { createdAt: string; actionId: string } | undefined {
  if (!cursor?.trim()) {
    return undefined;
  }
  const [createdAt, actionId] = cursor.split("|");
  if (!createdAt || !actionId) {
    return undefined;
  }
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return { createdAt, actionId };
}

function computeSkillActivationConfidence(reasons: string[], isExplicit: boolean): number {
  if (isExplicit) {
    return 1;
  }
  if (reasons.includes("keyword")) {
    return 0.84;
  }
  if (reasons.includes("dependency")) {
    return 0.68;
  }
  return 0.5;
}

function inferMcpCategory(transport: McpServerRecord["transport"]): McpServerCategory {
  if (transport === "stdio") {
    return "development";
  }
  if (transport === "sse") {
    return "research";
  }
  return "automation";
}

function normalizeMcpPolicy(policy?: Partial<McpServerPolicy>): McpServerPolicy {
  return {
    requireFirstToolApproval: policy?.requireFirstToolApproval ?? DEFAULT_MCP_SERVER_POLICY.requireFirstToolApproval,
    redactionMode: policy?.redactionMode ?? DEFAULT_MCP_SERVER_POLICY.redactionMode,
    allowedToolPatterns: Array.isArray(policy?.allowedToolPatterns)
      ? policy.allowedToolPatterns.map((item) => item.trim()).filter(Boolean)
      : [...DEFAULT_MCP_SERVER_POLICY.allowedToolPatterns],
    blockedToolPatterns: Array.isArray(policy?.blockedToolPatterns)
      ? policy.blockedToolPatterns.map((item) => item.trim()).filter(Boolean)
      : [...DEFAULT_MCP_SERVER_POLICY.blockedToolPatterns],
    notes: policy?.notes?.trim() || undefined,
  };
}

function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(value);
}

function applyMcpRedaction(
  payload: Record<string, unknown>,
  mode: McpServerPolicy["redactionMode"],
): Record<string, unknown> {
  if (mode === "off") {
    return payload;
  }
  const serialized = JSON.stringify(payload);
  const redacted = serialized.replace(
    /\b(sk-[a-z0-9]{16,}|ghp_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{12,}|[A-Za-z0-9+/]{36,}={0,2})\b/gi,
    "[REDACTED]",
  );
  const parsed = safeJsonParse<Record<string, unknown>>(redacted, payload);
  if (mode === "strict") {
    return {
      ...parsed,
      message: "Output redacted in strict mode.",
    };
  }
  return parsed;
}

function extFromMimeType(mimeType?: string): string {
  const normalized = mimeType?.toLowerCase() ?? "";
  if (normalized.includes("wav")) {
    return ".wav";
  }
  if (normalized.includes("mpeg")) {
    return ".mp3";
  }
  if (normalized.includes("ogg")) {
    return ".ogg";
  }
  if (normalized.includes("mp4")) {
    return ".mp4";
  }
  if (normalized.includes("webm")) {
    return ".webm";
  }
  return ".bin";
}

function parseVoiceCliArgs(rawValue?: string): string[] {
  if (!rawValue?.trim()) {
    return [];
  }
  return rawValue
    .split(/\s+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function normalizeAudioForWhisper(input: {
  inputPath: string;
  outputPath: string;
  mimeType?: string;
  ffmpegPath?: string;
}): Promise<string> {
  const normalized = input.mimeType?.toLowerCase() ?? "";
  if (normalized.includes("wav") || input.inputPath.toLowerCase().endsWith(".wav")) {
    return input.inputPath;
  }
  if (!input.ffmpegPath) {
    throw new Error("Audio normalization helper is not configured for non-WAV input.");
  }
  execFileSync(
    input.ffmpegPath,
    [
      "-y",
      "-i",
      input.inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      input.outputPath,
    ],
    { stdio: "pipe" },
  );
  return input.outputPath;
}

function parseSlashCommand(input: string): string[] | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const parts = trimmed.split(/\s+/g).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function parseDelegateCommand(input: string): { roles: string[]; objective?: string; error?: string } {
  const body = input.trim().replace(/^\/delegate/i, "").trim();
  const delimiterIndex = body.indexOf("::");
  if (delimiterIndex < 0) {
    return { roles: [], error: "missing delimiter" };
  }
  const rolesRaw = body.slice(0, delimiterIndex).trim();
  const objective = body.slice(delimiterIndex + 2).trim();
  const roles = normalizeDelegationRoles(rolesRaw.split(",").map((item) => item.trim()).filter(Boolean));
  if (roles.length === 0 || !objective) {
    return { roles, objective, error: "invalid delegate payload" };
  }
  return { roles, objective };
}

function parsePipelineCommand(input: string): { template: string; roles: string[]; objective: string } | undefined {
  const body = input.trim().replace(/^\/pipeline/i, "").trim();
  const delimiterIndex = body.indexOf("::");
  if (delimiterIndex < 0) {
    return undefined;
  }
  const template = body.slice(0, delimiterIndex).trim().toLowerCase();
  const objective = body.slice(delimiterIndex + 2).trim();
  const roles = PIPELINE_TEMPLATES[template];
  if (!roles || !objective) {
    return undefined;
  }
  return {
    template,
    roles,
    objective,
  };
}


function normalizeDelegationRoles(roles: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    const normalized = role.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  if (out.length === 0) {
    return [...DEFAULT_DELEGATION_ROLES];
  }
  return out;
}

function detectDelegationRoles(objective: string): string[] {
  const normalized = objective.toLowerCase();
  const roleHints: Array<{ role: string; patterns: RegExp[] }> = [
    { role: "product", patterns: [/\bproduct\b/, /\bprd\b/, /\brequirements?\b/] },
    { role: "architect", patterns: [/\barchitect\b/, /\bdesign\b/, /\barchitecture\b/] },
    { role: "coder", patterns: [/\bcoder\b/, /\bdeveloper\b/, /\bimplementation\b/, /\bbuild\b/] },
    { role: "qa", patterns: [/\bqa\b/, /\btest\b/, /\bvalidation\b/] },
    { role: "ops", patterns: [/\bops\b/, /\bdeploy\b/, /\brollout\b/, /\brelease\b/] },
    { role: "researcher", patterns: [/\bresearch\b/, /\banalyze\b/, /\bsources?\b/] },
  ];
  const roles = roleHints
    .filter((hint) => hint.patterns.some((pattern) => pattern.test(normalized)))
    .map((hint) => hint.role);
  if (roles.length > 0) {
    return roles;
  }
  if (/->|route this through|multi-agent|agents work together|handoff/.test(normalized)) {
    return [...DEFAULT_DELEGATION_ROLES.slice(0, 3)];
  }
  return [];
}

function normalizeSpecialistToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeSpecialistCandidateFingerprint(input: { title?: string; role?: string }): string {
  return `${normalizeSpecialistToken(input.role ?? "")}:${normalizeSpecialistToken(input.title ?? "")}`;
}

function dedupeStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function extractSpecialistObjectiveKeywords(content: string): string[] {
  const STOP_WORDS = new Set([
    "about",
    "after",
    "again",
    "also",
    "around",
    "because",
    "build",
    "could",
    "does",
    "from",
    "have",
    "into",
    "need",
    "that",
    "their",
    "them",
    "then",
    "this",
    "through",
    "what",
    "with",
    "would",
  ]);
  const matches = content.toLowerCase().match(/[a-z0-9][a-z0-9._+-]{2,}/g) ?? [];
  return dedupeStrings(matches.map(normalizeSpecialistToken).filter((token) => token.length >= 3 && !STOP_WORDS.has(token)))
    .slice(0, 12);
}

function mergeSpecialistRoutingHints(
  left: ChatSpecialistCandidateRecord["routingHints"],
  right: ChatSpecialistCandidateRecord["routingHints"],
): ChatSpecialistCandidateRecord["routingHints"] {
  const maxInvocationsPerRun = (() => {
    const values = [left.maxInvocationsPerRun, right.maxInvocationsPerRun]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length === 0) {
      return undefined;
    }
    return Math.min(...values);
  })();
  return {
    preferredModes: dedupeStrings([...left.preferredModes, ...right.preferredModes]) as ChatMode[],
    objectiveKeywords: (() => {
      const values = dedupeStrings([...(left.objectiveKeywords ?? []), ...(right.objectiveKeywords ?? [])]);
      return values.length > 0 ? values : undefined;
    })(),
    requiresProjectBinding: Boolean(left.requiresProjectBinding || right.requiresProjectBinding),
    maxInvocationsPerRun,
  };
}

function mergeSpecialistEvidence(
  left: ChatSpecialistCandidateRecord["evidence"],
  right: ChatSpecialistCandidateRecord["evidence"],
): ChatSpecialistCandidateRecord["evidence"] {
  const merged = new Map<string, ChatSpecialistCandidateRecord["evidence"][number]>();
  for (const item of [...left, ...right]) {
    const key = [
      item.kind,
      normalizeSpecialistToken(item.summary),
      item.turnId ?? "",
      item.runId ?? "",
      item.toolName ?? "",
      item.skillRef ?? "",
    ].join("|");
    const current = merged.get(key);
    if (!current || (item.confidence ?? 0) > (current.confidence ?? 0)) {
      merged.set(key, item);
    }
  }
  return [...merged.values()].slice(0, 8);
}

function inferSpecialistBaseRole(role: string): OrchestrationRole {
  const normalized = role.toLowerCase();
  if (/\b(research|analyst|market|source|intel)\b/.test(normalized)) {
    return "researcher";
  }
  if (/\b(qa|test|validator)\b/.test(normalized)) {
    return "qa-validator";
  }
  if (/\b(review|critic|audit|security)\b/.test(normalized)) {
    return "reviewer";
  }
  if (/\b(coder|developer|implement|engineer)\b/.test(normalized)) {
    return "coder";
  }
  if (/\b(product|architect|planner|design)\b/.test(normalized)) {
    return "planner";
  }
  if (/\b(ops|deploy|release|infra)\b/.test(normalized)) {
    return "worker";
  }
  return "worker";
}

function inferSpecialistRoleFromCapability(capability: ChatCapabilityUpgradeSuggestion): string {
  const haystack = `${capability.title} ${capability.summary} ${capability.reason}`.toLowerCase();
  if (/\b(security|auth|permission)\b/.test(haystack)) return "security-reviewer";
  if (/\b(test|qa|validate)\b/.test(haystack)) return "qa";
  if (/\b(research|search|browser|source|latest|market)\b/.test(haystack)) return "researcher";
  if (/\b(deploy|release|ops|infra)\b/.test(haystack)) return "ops";
  if (/\b(architect|architecture|design)\b/.test(haystack)) return "architect";
  if (/\b(product|requirements|prd|plan)\b/.test(haystack)) return "product";
  if (/\b(code|coder|developer|implementation|build)\b/.test(haystack)) return "coder";
  const titleTokens = extractSpecialistObjectiveKeywords(capability.title);
  return titleTokens[0] ? `${titleTokens[0]}-specialist` : "tooling-specialist";
}

function suggestedToolsForRole(role: string): string[] | undefined {
  const normalized = role.toLowerCase();
  if (normalized.includes("research")) return ["browser.search", "browser.navigate"];
  if (normalized.includes("qa")) return ["tests.run"];
  if (normalized.includes("ops")) return ["shell.command"];
  if (normalized.includes("security")) return ["security.review"];
  return undefined;
}

function buildSpecialistSuggestionFromCapability(input: {
  capability: ChatCapabilityUpgradeSuggestion;
  mode: ChatMode;
  objectiveKeywords: string[];
}): ChatSpecialistCandidateSuggestionRecord {
  const role = inferSpecialistRoleFromCapability(input.capability);
  const title = /\bspecialist\b/i.test(input.capability.title)
    ? input.capability.title
    : `${toTitleCase(role)} specialist`;
  const objectiveKeywords = dedupeStrings([
    ...input.objectiveKeywords,
    ...extractSpecialistObjectiveKeywords(input.capability.title),
    ...extractSpecialistObjectiveKeywords(input.capability.summary),
  ]).slice(0, 10);
  return {
    candidateId: `specialist-${normalizeSpecialistCandidateFingerprint({ title, role })}`,
    title,
    role,
    summary: `Use ${input.capability.title} as a dormant specialist capability for repeat ${input.mode} work of this kind.`,
    reason: input.capability.reason,
    source: "runtime_gap",
    confidence: clamp01((input.capability.riskLevel === "low" ? 0.76 : input.capability.riskLevel === "high" ? 0.62 : 0.69)),
    suggestedStatus: "suggested",
    suggestedRoutingMode: input.mode === "code" ? "strong_match_only" : "manual_only",
    requiresApproval: true,
    suggestedTools: suggestedToolsForRole(role),
    suggestedSkills: input.capability.sourceRef ? [input.capability.sourceRef] : undefined,
    routingHints: {
      preferredModes: input.mode === "code" ? ["code"] : ["cowork"],
      objectiveKeywords: objectiveKeywords.length > 0 ? objectiveKeywords : undefined,
      requiresProjectBinding: input.mode === "code",
      maxInvocationsPerRun: 1,
    },
    evidence: [{
      evidenceId: randomUUID(),
      kind: input.capability.kind === "mcp_template" ? "tool_gap" : "skill_gap",
      summary: input.capability.summary,
      confidence: clamp01(input.capability.riskLevel === "low" ? 0.78 : 0.66),
      skillRef: input.capability.sourceRef,
    }],
  };
}

function buildRoleGapSpecialistSuggestion(input: {
  role: string;
  mode: ChatMode;
  objective: string;
  objectiveKeywords: string[];
  confidence: number;
  runId?: string;
  turnId?: string;
}): ChatSpecialistCandidateSuggestionRecord {
  const title = `${toTitleCase(input.role)} specialist`;
  const routingMode: ChatSpecialistCandidateSuggestionRecord["suggestedRoutingMode"] = input.confidence >= 0.8
    ? "strong_match_only"
    : "manual_only";
  return {
    candidateId: `specialist-${normalizeSpecialistCandidateFingerprint({ title, role: input.role })}`,
    title,
    role: input.role,
    summary: `Add a dormant ${input.role} specialist so similar ${input.mode} runs can reuse a focused persona instead of rebuilding the roster each time.`,
    reason: `This run implied a recurring ${input.role} gap in the current roster.`,
    source: "runtime_gap",
    confidence: clamp01(input.confidence),
    suggestedStatus: "suggested",
    suggestedRoutingMode: routingMode,
    requiresApproval: true,
    suggestedTools: suggestedToolsForRole(input.role),
    routingHints: {
      preferredModes: input.mode === "code" ? ["code"] : ["cowork"],
      objectiveKeywords: input.objectiveKeywords.length > 0 ? input.objectiveKeywords : extractSpecialistObjectiveKeywords(input.objective),
      requiresProjectBinding: input.mode === "code",
      maxInvocationsPerRun: 1,
    },
    evidence: [{
      evidenceId: randomUUID(),
      kind: "role_gap",
      summary: `Objective hinted that ${input.role} work would help: ${input.objective.slice(0, 180)}`,
      turnId: input.turnId,
      runId: input.runId,
      confidence: clamp01(input.confidence),
    }],
  };
}

function scoreSpecialistCandidateMatch(
  candidate: ChatSpecialistCandidateRecord,
  objectiveKeywords: string[],
  stepRole: OrchestrationRole,
): number {
  const baseRole = inferSpecialistBaseRole(candidate.role);
  if (baseRole !== stepRole) {
    return 0;
  }
  const candidateKeywords = dedupeStrings([
    ...(candidate.routingHints.objectiveKeywords ?? []),
    ...extractSpecialistObjectiveKeywords(candidate.title),
    ...extractSpecialistObjectiveKeywords(candidate.summary),
    ...extractSpecialistObjectiveKeywords(candidate.reason),
  ]);
  const overlap = candidateKeywords.length > 0
    ? objectiveKeywords.filter((keyword) => candidateKeywords.includes(keyword)).length / candidateKeywords.length
    : 0;
  return clamp01((candidate.confidence * 0.55) + (overlap * 0.35) + 0.1);
}

function buildSpecialistMatchReason(
  candidate: ChatSpecialistCandidateRecord,
  objectiveKeywords: string[],
): string {
  const candidateKeywords = dedupeStrings([
    ...(candidate.routingHints.objectiveKeywords ?? []),
    ...extractSpecialistObjectiveKeywords(candidate.title),
  ]);
  const overlap = objectiveKeywords.filter((keyword) => candidateKeywords.includes(keyword));
  if (overlap.length > 0) {
    return `Matched on ${overlap.slice(0, 3).join(", ")}.`;
  }
  return candidate.reason;
}

function splitChatPrefsPatch(
  input: ChatSessionPrefsPatch,
): {
  basePatch: Pick<
    ChatSessionPrefsPatch,
    | "mode"
    | "planningMode"
    | "providerId"
    | "model"
    | "webMode"
    | "memoryMode"
    | "thinkingLevel"
    | "toolAutonomy"
    | "visionFallbackModel"
    | "orchestrationEnabled"
    | "orchestrationIntensity"
    | "orchestrationVisibility"
    | "orchestrationProviderPreference"
    | "orchestrationReviewDepth"
    | "orchestrationParallelism"
    | "codeAutoApply"
  >;
  autonomyPatch: Partial<{
    proactiveMode: ChatProactiveMode;
    maxActionsPerHour: number;
    maxActionsPerTurn: number;
    cooldownSeconds: number;
    retrievalMode: ChatRetrievalMode;
    reflectionMode: ChatReflectionMode;
  }>;
} {
  const basePatch: Pick<
    ChatSessionPrefsPatch,
    | "mode"
    | "planningMode"
    | "providerId"
    | "model"
    | "webMode"
    | "memoryMode"
    | "thinkingLevel"
    | "toolAutonomy"
    | "visionFallbackModel"
    | "orchestrationEnabled"
    | "orchestrationIntensity"
    | "orchestrationVisibility"
    | "orchestrationProviderPreference"
    | "orchestrationReviewDepth"
    | "orchestrationParallelism"
    | "codeAutoApply"
  > = {
    mode: input.mode,
    planningMode: input.planningMode,
    providerId: input.providerId,
    model: input.model,
    webMode: input.webMode,
    memoryMode: input.memoryMode,
    thinkingLevel: input.thinkingLevel,
    toolAutonomy: input.toolAutonomy,
    visionFallbackModel: input.visionFallbackModel,
    orchestrationEnabled: input.orchestrationEnabled,
    orchestrationIntensity: input.orchestrationIntensity,
    orchestrationVisibility: input.orchestrationVisibility,
    orchestrationProviderPreference: input.orchestrationProviderPreference,
    orchestrationReviewDepth: input.orchestrationReviewDepth,
    orchestrationParallelism: input.orchestrationParallelism,
    codeAutoApply: input.codeAutoApply,
  };
  return {
    basePatch,
    autonomyPatch: {
      proactiveMode: input.proactiveMode,
      maxActionsPerHour: input.autonomyBudget?.maxActionsPerHour,
      maxActionsPerTurn: input.autonomyBudget?.maxActionsPerTurn,
      cooldownSeconds: input.autonomyBudget?.cooldownSeconds,
      retrievalMode: input.retrievalMode,
      reflectionMode: input.reflectionMode,
    },
  };
}

function buildPlanningModeSystemInstruction(planningMode: ChatPlanningMode | undefined): string | undefined {
  if (planningMode !== "advisory") {
    return undefined;
  }
  return [
    "Planning mode is active for this session.",
    "Respond with an advisory plan, specification, or options analysis only.",
    "Do not claim to have executed tools, delegated work, or changed files in this turn.",
    "If tools would help, explain which tool or follow-up action the operator should explicitly run next.",
  ].join("\n");
}

function mergeChatSystemInstructions(...parts: Array<string | undefined>): string | undefined {
  const merged = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  if (merged.length === 0) {
    return undefined;
  }
  return merged.join("\n\n");
}

function buildRetrievalTrace(input: {
  content: string;
  retrievalMode: ChatRetrievalMode;
  webMode: ChatWebMode;
  memoryMode: ChatSessionPrefsRecord["memoryMode"];
}): NonNullable<ChatTurnTraceRecord["retrieval"]> {
  const liveIntent = /\b(latest|today|weather|news|price|current|right now|time)\b/i.test(input.content);
  const l0Base = liveIntent ? 0.55 : 0.86;
  const l1Base = input.memoryMode === "off" ? 0.2 : liveIntent ? 0.64 : 0.78;
  const shouldUseLayered = input.retrievalMode === "layered";
  const shouldUseL2 = shouldUseLayered && (liveIntent || l1Base < 0.55) && input.webMode !== "off";
  return {
    l0Used: true,
    l1Used: input.memoryMode !== "off",
    l2Used: shouldUseL2,
    confidenceL0: l0Base,
    confidenceL1: l1Base,
    confidenceL2: shouldUseL2 ? (input.webMode === "deep" ? 0.82 : 0.71) : undefined,
    escalationReason: shouldUseL2
      ? (liveIntent ? "explicit_live_data_intent" : "low_retrieval_confidence")
      : undefined,
  };
}

function looksSensitive(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /api[_-]?key|token|secret|password|private[_-]?key|bearer\s+[a-z0-9._-]+/i.test(normalized)
    || /\bsk-[a-z0-9]{8,}\b/i.test(normalized)
    || /\bghp_[a-z0-9]{10,}\b/i.test(normalized)
  );
}

function normalizeMemoryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function memoryTextOverlap(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }
  const leftTokens = new Set(left.split(" ").filter((token) => token.length > 2));
  const rightTokens = new Set(right.split(" ").filter((token) => token.length > 2));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let matches = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      matches += 1;
    }
  }
  return matches / Math.max(leftTokens.size, rightTokens.size);
}

function extractStringFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
          return String((item as { text?: unknown }).text);
        }
        return "";
      })
      .join("");
  }
  if (value && typeof value === "object") {
    const maybe = value as { text?: unknown; content?: unknown };
    if (typeof maybe.text === "string") {
      return maybe.text;
    }
    if (typeof maybe.content === "string") {
      return maybe.content;
    }
  }
  return "";
}

function buildDelegationSystemPrompt(role: string): string {
  return [
    "You are a specialist subagent in a multi-step delegation run.",
    `Assigned role: ${role}.`,
    "Return concise, practical output in plain markdown.",
    "If you are missing data, call that out explicitly and propose a next best step.",
    "Never claim external data unless it was provided in the current context.",
  ].join("\n");
}

function buildDelegationUserPrompt(input: {
  objective: string;
  role: string;
  mode: "sequential" | "parallel";
  sharedContext: Array<{ role: string; output: string }>;
}): string {
  const previous = input.sharedContext.length > 0
    ? input.sharedContext
      .map((item) => `Role ${item.role} output:\n${item.output}`)
      .join("\n\n")
    : "None";
  return [
    `Objective: ${input.objective}`,
    `Execution mode: ${input.mode}`,
    `Current role: ${input.role}`,
    "Prior outputs from earlier roles:",
    previous,
    "Produce your role output now.",
  ].join("\n\n");
}

function renderExecutionPlanAsMarkdown(input: {
  mode: ChatMode;
  objective: string;
  summary: string;
  steps: PreparedChatExecutionPlanResolution["executionPlanDraft"]["steps"];
}): string {
  const modeLabel = input.mode === "cowork"
    ? "Cowork plan"
    : input.mode === "code"
      ? "Code plan"
      : "Chat plan";
  const stepLines = input.steps.map((step) => {
    const parts = [
      `${step.index + 1}. ${step.objective}`,
      step.successCriteria ? `Success: ${step.successCriteria}` : undefined,
      step.expectedOutput ? `Output: ${step.expectedOutput}` : undefined,
      step.suggestedTools?.length ? `Suggested tools: ${step.suggestedTools.join(", ")}` : undefined,
      step.dependsOnStepIds?.length ? `Depends on: ${step.dependsOnStepIds.join(", ")}` : undefined,
      step.delegatedRole ? `Delegated role: ${step.delegatedRole}` : undefined,
    ].filter(Boolean);
    return parts.join("\n   ");
  });
  return [
    `## ${modeLabel}`,
    "",
    `Objective: ${input.objective}`,
    "",
    input.summary,
    "",
    "Planned steps:",
    ...stepLines,
  ].join("\n");
}

function stringifyMessagesForTokenEstimate(messages: ChatCompletionRequest["messages"]): string {
  return messages
    .map((message) => {
      const content = typeof message.content === "string"
        ? message.content
        : extractStringFromUnknown(message.content);
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
}

function truncateSummaryLine(content: string, maxLength = 220): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildBranchRecordGroups(
  branchTurnIds: string[],
  records: ChatMessageRecord[],
): {
  turnMessagesById: Map<string, ChatMessageRecord[]>;
  trailingMessages: ChatMessageRecord[];
} {
  const turnMessagesById = new Map<string, ChatMessageRecord[]>();
  let cursor = 0;
  for (const turnId of branchTurnIds) {
    const turnMessages: ChatMessageRecord[] = [];
    if (cursor < records.length) {
      turnMessages.push(records[cursor]!);
      cursor += 1;
    }
    if (cursor < records.length && records[cursor]?.role === "assistant") {
      turnMessages.push(records[cursor]!);
      cursor += 1;
    }
    turnMessagesById.set(turnId, turnMessages);
  }
  return {
    turnMessagesById,
    trailingMessages: records.slice(cursor),
  };
}

function buildExecutionPlanDraftFromOrchestrationPlan(
  templatePlan: ModeOrchestrationPlan,
  input: {
    objective: string;
    advisoryOnly: boolean;
  },
): PreparedChatExecutionPlanResolution["executionPlanDraft"] {
  return {
    source: templatePlan.source,
    advisoryOnly: input.advisoryOnly,
    objective: input.objective,
    summary: templatePlan.summary,
    steps: templatePlan.steps.map((step, index) => ({
      stepId: step.stepId,
      index,
      objective: step.objective,
      successCriteria: step.successCriteria,
      suggestedTools: step.suggestedTools,
      expectedOutput: step.expectedOutput,
      parallelizable: step.parallelizable,
      dependsOnStepIds: step.dependsOnStepIds,
      delegatedRole: input.advisoryOnly || templatePlan.routeDecision.modePolicy === "chat"
        ? undefined
        : step.delegatedRole,
      status: "pending",
    })),
  };
}

function coercePlannerExecutionPlanDraft(
  payload: Record<string, unknown>,
  templatePlan: ModeOrchestrationPlan,
  input: {
    advisoryOnly: boolean;
    mode: ChatMode;
    objective: string;
  },
): PreparedChatExecutionPlanResolution["executionPlanDraft"] | undefined {
  const rawSteps = Array.isArray(payload.steps)
    ? payload.steps.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    : [];
  if (rawSteps.length === 0) {
    return undefined;
  }
  const allowedDelegatedRoles = new Set(templatePlan.steps.map((step) => step.role));
  let usedFallback = false;
  const steps = templatePlan.steps.map((templateStep, index) => {
    const raw = rawSteps[index];
    const objective = typeof raw?.objective === "string" && raw.objective.trim()
      ? raw.objective.trim()
      : templateStep.objective;
    if (objective === templateStep.objective) {
      usedFallback = true;
    }
    const successCriteria = typeof raw?.successCriteria === "string" && raw.successCriteria.trim()
      ? raw.successCriteria.trim()
      : templateStep.successCriteria;
    const suggestedTools = Array.isArray(raw?.suggestedTools)
      ? dedupeStrings(
        raw.suggestedTools
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean),
      )
      : templateStep.suggestedTools;
    const expectedOutput = typeof raw?.expectedOutput === "string" && raw.expectedOutput.trim()
      ? raw.expectedOutput.trim()
      : templateStep.expectedOutput;
    const dependsOnStepIds = Array.isArray(raw?.dependsOnStepIds)
      ? dedupeStrings(
        raw.dependsOnStepIds
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => templatePlan.steps.some((step) => step.stepId === value)),
      )
      : templateStep.dependsOnStepIds;
    const delegatedRole = input.mode === "chat" || input.advisoryOnly
      ? undefined
      : typeof raw?.delegatedRole === "string" && allowedDelegatedRoles.has(raw.delegatedRole as OrchestrationRole)
        ? raw.delegatedRole
        : templateStep.delegatedRole;
    return {
      stepId: templateStep.stepId,
      index,
      objective,
      successCriteria,
      suggestedTools: suggestedTools?.length ? suggestedTools : undefined,
      expectedOutput,
      parallelizable: typeof raw?.parallelizable === "boolean" ? raw.parallelizable : templateStep.parallelizable,
      dependsOnStepIds: dependsOnStepIds?.length ? dependsOnStepIds : undefined,
      delegatedRole,
      status: "pending" as const,
    };
  });
  const summary = typeof payload.summary === "string" && payload.summary.trim()
    ? payload.summary.trim()
    : templatePlan.summary;
  if (summary === templatePlan.summary) {
    usedFallback = true;
  }
  return {
    source: usedFallback ? "planner_with_template_fallback" : "planner",
    advisoryOnly: input.advisoryOnly,
    objective: input.objective,
    summary,
    steps,
  };
}

function applyExecutionPlanDraftToOrchestrationPlan(
  templatePlan: ModeOrchestrationPlan,
  draft: PreparedChatExecutionPlanResolution["executionPlanDraft"],
): ModeOrchestrationPlan {
  const steps = templatePlan.steps.map((step, index) => {
    const planned = draft.steps[index];
    if (!planned) {
      return step;
    }
    return {
      ...step,
      index: planned.index,
      objective: planned.objective,
      successCriteria: planned.successCriteria,
      suggestedTools: planned.suggestedTools,
      expectedOutput: planned.expectedOutput,
      parallelizable: planned.parallelizable,
      dependsOnStepIds: planned.dependsOnStepIds,
      delegatedRole: planned.delegatedRole,
    };
  });
  return {
    ...templatePlan,
    summary: draft.summary,
    source: draft.source,
    advisoryOnly: draft.advisoryOnly,
    routeDecision: {
      ...templatePlan.routeDecision,
      selectedRoles: steps.map((step) => step.role),
      selectedProviders: steps.map((step) => ({
        role: step.role,
        providerId: step.providerId,
        model: step.model,
      })),
    },
    steps,
  };
}

function mergeExecutionPlanStepStatuses(
  planSteps: PreparedChatExecutionPlanResolution["executionPlanDraft"]["steps"],
  results: OrchestrationStepExecutionResult[],
): PreparedChatExecutionPlanResolution["executionPlanDraft"]["steps"] {
  return planSteps.map((planStep, index) => {
    const result = results.find((item) => item.stepId === planStep.stepId) ?? results.find((item) => item.index === index);
    if (!result) {
      return planStep;
    }
    return {
      ...planStep,
      status: result.status === "skipped" ? "cancelled" : result.status,
      summary: result.summary,
      error: result.error,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      childRunId: result.childRunId,
      childSessionId: result.childSessionId,
      childTurnId: result.childTurnId,
    };
  });
}

function buildDelegationFailureGuidance(error: string, role: string): string {
  const normalized = error.toLowerCase();
  if (/\bauth|login|token|credential|permission\b/.test(normalized)) {
    return `${toTitleCase(role)} hit an auth or permission barrier. Reconnect the required account or switch to another source.`;
  }
  if (/\btimeout|timed out|deadline|aborted\b/.test(normalized)) {
    return `${toTitleCase(role)} ran out of time. Retry with a narrower brief or fewer sources.`;
  }
  if (/\bblocked|deny|denied|approval|policy|jail\b/.test(normalized)) {
    return `${toTitleCase(role)} hit a restricted action. Use a safer fallback path or request approval explicitly.`;
  }
  if (/\bnot found|404|missing\b/.test(normalized)) {
    return `${toTitleCase(role)} could not find the expected input. Retry with a more explicit file, path, or source reference.`;
  }
  return `Retry the ${role} delegate with a narrower brief or a different tool/source strategy.`;
}


function sampleDecisionReplayCandidates(
  candidates: DecisionReplayCandidate[],
  sampleSize: number,
): DecisionReplayCandidate[] {
  const cap = Math.max(1, Math.min(sampleSize, candidates.length));
  const critical = candidates.filter((candidate) => {
    if (candidate.decisionType === "tool_run") {
      return candidate.status === "failed" || candidate.status === "blocked" || candidate.status === "approval_required";
    }
    return candidate.status === "failed" || candidate.status === "approval_required";
  });
  const normal = candidates.filter((candidate) => !critical.includes(candidate));
  const criticalTarget = Math.min(critical.length, Math.max(1, Math.floor(cap * 0.45)));
  const selected = [
    ...critical.slice(0, criticalTarget),
    ...normal.slice(0, cap - criticalTarget),
  ];
  if (selected.length < cap) {
    const fallback = [...critical.slice(criticalTarget), ...normal.slice(cap - criticalTarget)];
    for (const candidate of fallback) {
      if (selected.length >= cap) {
        break;
      }
      if (selected.includes(candidate)) {
        continue;
      }
      selected.push(candidate);
    }
  }
  return selected.slice(0, cap);
}

function evaluateDecisionReplayRuleScores(
  candidate: DecisionReplayCandidate,
  turnTools: DecisionReplayCandidate[],
): {
  scores: DecisionReplayItemRuleScores;
  signals: string[];
} {
  const signals: string[] = [];
  let honesty = 0.7;
  let blockerQuality = 0.7;
  let retryQuality = 0.7;
  let toolEvidence = 0.65;
  let actionability = 0.7;

  if (candidate.decisionType === "chat_turn") {
    const executedTools = turnTools.filter((item) => item.status === "executed");
    const failedTools = turnTools.filter((item) => item.status === "failed");
    const blockedTools = turnTools.filter((item) => item.status === "blocked" || item.status === "approval_required");

    if (candidate.status === "failed") {
      blockerQuality = 0.38;
      actionability = 0.35;
      signals.push("chat_turn_failed");
      if (failedTools.length > 0) {
        blockerQuality = 0.56;
        signals.push("failed_tools_present");
      }
    } else if (candidate.status === "approval_required") {
      blockerQuality = 0.82;
      actionability = 0.62;
      signals.push("approval_required_gate");
    }

    if ((candidate.routing?.liveDataIntent ?? false) && !(candidate.retrieval?.l2Used ?? false)) {
      honesty = 0.48;
      toolEvidence = Math.min(toolEvidence, 0.42);
      signals.push("live_data_without_l2");
    }

    if (executedTools.length > 0) {
      toolEvidence = 0.88;
      honesty = Math.max(honesty, 0.82);
      signals.push("tool_execution_evidence");
    } else if ((candidate.routing?.liveDataIntent ?? false) || candidate.webMode === "quick" || candidate.webMode === "deep") {
      toolEvidence = 0.44;
      signals.push("web_intent_without_execution");
    }

    const attemptedRepair = (candidate.reflection?.attemptCount ?? 0) > 0;
    if ((candidate.status === "failed" || failedTools.length > 0) && !attemptedRepair) {
      retryQuality = 0.32;
      signals.push("missing_reflection_retry");
    } else if (attemptedRepair) {
      retryQuality = 0.86;
      signals.push("reflection_retry_attempted");
    }

    if (blockedTools.length > 0 && blockerQuality < 0.7) {
      blockerQuality = 0.74;
      signals.push("blocked_with_reason");
    }
  } else {
    const status = candidate.status;
    if (status === "executed") {
      toolEvidence = 0.9;
      blockerQuality = 0.8;
      actionability = 0.8;
      signals.push("tool_executed");
    } else if (status === "failed") {
      honesty = 0.58;
      blockerQuality = candidate.error?.trim().length ? 0.62 : 0.34;
      retryQuality = 0.35;
      toolEvidence = 0.45;
      actionability = 0.42;
      signals.push("tool_failed");
    } else if (status === "blocked" || status === "approval_required") {
      blockerQuality = candidate.error?.trim().length ? 0.78 : 0.5;
      actionability = 0.55;
      signals.push("tool_blocked_or_approval");
    }
  }

  const scores: DecisionReplayItemRuleScores = {
    honesty: clampProbability(honesty),
    blockerQuality: clampProbability(blockerQuality),
    retryQuality: clampProbability(retryQuality),
    toolEvidence: clampProbability(toolEvidence),
    actionability: clampProbability(actionability),
  };
  return { scores, signals };
}

function computeDecisionWrongnessProbability(
  candidate: DecisionReplayCandidate,
  ruleScores: DecisionReplayItemRuleScores,
  modelScores?: DecisionReplayItemModelScores,
): number {
  const ruleQuality = (
    (ruleScores.honesty * 0.28)
    + (ruleScores.blockerQuality * 0.2)
    + (ruleScores.retryQuality * 0.2)
    + (ruleScores.toolEvidence * 0.2)
    + (ruleScores.actionability * 0.12)
  );
  let ruleWrongness = 1 - ruleQuality;
  if (candidate.status === "failed") {
    ruleWrongness += 0.18;
  } else if (candidate.status === "blocked") {
    ruleWrongness += 0.08;
  } else if (candidate.status === "approval_required") {
    ruleWrongness += 0.05;
  }
  ruleWrongness = clampProbability(ruleWrongness);
  if (!modelScores) {
    return ruleWrongness;
  }
  const modelWrongness = (
    (1 - modelScores.correctnessLikelihood) * 0.55
    + (modelScores.missedToolProbability * 0.3)
    + (modelScores.betterResponsePotential * 0.15)
  );
  return clampProbability((ruleWrongness * 0.55) + (modelWrongness * 0.45));
}

function inferDecisionReplayCauseClass(
  candidate: DecisionReplayCandidate,
  ruleScores: DecisionReplayItemRuleScores,
  wrongnessProbability: number,
): DecisionReplayCauseClass {
  if (wrongnessProbability < 0.45) {
    return "other";
  }
  if (candidate.decisionType === "chat_turn") {
    if ((candidate.routing?.liveDataIntent ?? false) && !(candidate.retrieval?.l2Used ?? false)) {
      if (candidate.status === "completed") {
        return "false_refusal_tone";
      }
      return "retrieval_miss";
    }
    if (candidate.status === "failed" && ruleScores.blockerQuality < 0.5) {
      return "weak_blocker_explanation";
    }
    if ((candidate.status === "failed" || candidate.status === "approval_required") && ruleScores.retryQuality < 0.45) {
      return "incomplete_retry_repair";
    }
    if (ruleScores.toolEvidence < 0.45) {
      return "tool_mismatch";
    }
    return "other";
  }
  if ((candidate.status === "blocked" || candidate.status === "approval_required") && ruleScores.blockerQuality < 0.66) {
    return "weak_blocker_explanation";
  }
  if (candidate.status === "failed" && ruleScores.retryQuality < 0.5) {
    return "incomplete_retry_repair";
  }
  if (candidate.status === "failed" && ruleScores.toolEvidence < 0.6) {
    return "tool_mismatch";
  }
  return "other";
}

function buildDecisionReplayItemSummary(
  candidate: DecisionReplayCandidate,
  causeClass: DecisionReplayCauseClass,
): string {
  if (candidate.decisionType === "chat_turn") {
    return `Chat turn ${candidate.turnId ?? "unknown"} was tagged ${causeClass} (${candidate.status}).`;
  }
  return `Tool ${candidate.toolName ?? "unknown"} run ${candidate.toolRunId ?? "unknown"} was tagged ${causeClass} (${candidate.status}).`;
}

function titleForDecisionReplayCause(causeClass: DecisionReplayCauseClass): string {
  if (causeClass === "false_refusal_tone") return "False Refusal Tone";
  if (causeClass === "weak_blocker_explanation") return "Weak Blocker Explanations";
  if (causeClass === "tool_mismatch") return "Tool Selection Mismatch";
  if (causeClass === "retrieval_miss") return "Retrieval Misses";
  if (causeClass === "incomplete_retry_repair") return "Incomplete Retry/Repair";
  return "Other Replay Issues";
}

function recommendationForDecisionReplayCause(causeClass: DecisionReplayCauseClass): string {
  if (causeClass === "false_refusal_tone") {
    return "Tighten refusal wording contract and require explicit tool-attempt summary before refusal.";
  }
  if (causeClass === "weak_blocker_explanation") {
    return "Improve blocker template with concrete cause, failing step, and next-step fallback fields.";
  }
  if (causeClass === "tool_mismatch") {
    return "Re-rank tool selection heuristics and add tie-break preference for higher-evidence tools.";
  }
  if (causeClass === "retrieval_miss") {
    return "Raise live-data intent sensitivity and escalate layered retrieval earlier.";
  }
  if (causeClass === "incomplete_retry_repair") {
    return "Trigger one alternate-strategy retry for failed turns before final response.";
  }
  return "Review trace samples and add targeted heuristics for this cluster.";
}

function summarizeDecisionReplayFinding(group: DecisionReplayItemRecord[]): string {
  const example = group[0];
  if (!example) {
    return "No sample data available.";
  }
  return [
    `Observed ${group.length} similar items.`,
    `Example: ${example.summary ?? `${example.decisionType} ${example.turnId ?? example.toolRunId ?? "unknown"}`}`,
    `Average wrongness: ${(group.reduce((sum, item) => sum + item.wrongnessProbability, 0) / group.length).toFixed(2)}.`,
  ].join(" ");
}

function severityRank(severity: DecisionReplayFindingRecord["severity"]): number {
  if (severity === "high") {
    return 3;
  }
  if (severity === "medium") {
    return 2;
  }
  return 1;
}

function compareDecisionCauseCounts(
  current: Map<DecisionReplayCauseClass, number>,
  previous: Map<DecisionReplayCauseClass, number>,
): WeeklyImprovementReportRecord["weekOverWeek"] {
  const keys = new Set<DecisionReplayCauseClass>([
    ...current.keys(),
    ...previous.keys(),
  ]);
  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged: string[] = [];
  for (const key of keys) {
    const currentValue = current.get(key) ?? 0;
    const previousValue = previous.get(key) ?? 0;
    if (currentValue < previousValue) {
      improved.push(`${key}: ${previousValue} -> ${currentValue}`);
    } else if (currentValue > previousValue) {
      regressed.push(`${key}: ${previousValue} -> ${currentValue}`);
    } else {
      unchanged.push(`${key}: ${currentValue}`);
    }
  }
  return { improved, regressed, unchanged };
}

function normalizeDecisionReplayCauseClass(value: string): DecisionReplayCauseClass {
  if (IMPROVEMENT_CAUSE_CLASSES.has(value as DecisionReplayCauseClass)) {
    return value as DecisionReplayCauseClass;
  }
  return "other";
}

function mapDecisionAutoTuneRow(row: {
  tune_id: string;
  run_id: string;
  finding_id: string | null;
  tune_class: DecisionAutoTuneRecord["tuneClass"];
  risk_level: DecisionAutoTuneRecord["riskLevel"];
  status: DecisionAutoTuneRecord["status"];
  description: string;
  patch_json: string;
  snapshot_json: string | null;
  result_json: string | null;
  created_at: string;
  applied_at: string | null;
  reverted_at: string | null;
}): DecisionAutoTuneRecord {
  return {
    tuneId: row.tune_id,
    runId: row.run_id,
    findingId: row.finding_id ?? undefined,
    tuneClass: row.tune_class,
    riskLevel: row.risk_level,
    status: row.status,
    description: row.description,
    patch: safeJsonParse<Record<string, unknown>>(row.patch_json, {}),
    snapshot: row.snapshot_json ? safeJsonParse<Record<string, unknown>>(row.snapshot_json, {}) : undefined,
    result: row.result_json ? safeJsonParse<Record<string, unknown>>(row.result_json, {}) : undefined,
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? undefined,
    revertedAt: row.reverted_at ?? undefined,
  };
}

function mapImprovementReportRow(row: {
  report_id: string;
  run_id: string;
  week_start: string;
  week_end: string;
  summary_json: string;
  top_findings_json: string;
  applied_tunes_json: string;
  queued_tunes_json: string;
  week_over_week_json: string;
  previous_report_id: string | null;
  created_at: string;
}): WeeklyImprovementReportRecord {
  return {
    reportId: row.report_id,
    runId: row.run_id,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    summary: safeJsonParse<WeeklyImprovementReportRecord["summary"]>(row.summary_json, {
      sampledDecisions: 0,
      likelyWrongCount: 0,
      wrongnessRate: 0,
      topCauseClasses: [],
      duplicateSuppressedCount: 0,
      improvedCount: 0,
      regressedCount: 0,
    }),
    topFindings: safeJsonParse<DecisionReplayFindingRecord[]>(row.top_findings_json, []),
    appliedAutoTunes: safeJsonParse<DecisionAutoTuneRecord[]>(row.applied_tunes_json, []),
    queuedRecommendations: safeJsonParse<DecisionAutoTuneRecord[]>(row.queued_tunes_json, []),
    weekOverWeek: safeJsonParse<WeeklyImprovementReportRecord["weekOverWeek"]>(row.week_over_week_json, {
      improved: [],
      regressed: [],
      unchanged: [],
    }),
    previousReportId: row.previous_report_id ?? undefined,
    createdAt: row.created_at,
  };
}

function getZonedDateParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekdayRaw = read("weekday").toLowerCase();
  const weekday = weekdayRaw.startsWith("sun")
    ? 0
    : weekdayRaw.startsWith("mon")
      ? 1
      : weekdayRaw.startsWith("tue")
        ? 2
        : weekdayRaw.startsWith("wed")
          ? 3
          : weekdayRaw.startsWith("thu")
            ? 4
            : weekdayRaw.startsWith("fri")
              ? 5
              : 6;
  return {
    year: Number.parseInt(read("year"), 10),
    month: Number.parseInt(read("month"), 10),
    day: Number.parseInt(read("day"), 10),
    weekday,
    hour: Number.parseInt(read("hour"), 10),
    minute: Number.parseInt(read("minute"), 10),
  };
}

function toWeekKeyForTimezone(date: Date, timeZone: string): string {
  const parts = getZonedDateParts(date, timeZone);
  const anchor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - parts.weekday));
  const yyyy = anchor.getUTCFullYear();
  const mm = String(anchor.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(anchor.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toDayKeyForTimezone(date: Date, timeZone: string): string {
  const parts = getZonedDateParts(date, timeZone);
  const yyyy = String(parts.year).padStart(4, "0");
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toHourKeyForTimezone(date: Date, timeZone: string): string {
  const parts = getZonedDateParts(date, timeZone);
  const yyyy = String(parts.year).padStart(4, "0");
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  const hh = String(parts.hour).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}`;
}

function isCronJobDueNow(
  job: CronJobRecord,
  now: Date,
  defaults: {
    defaultMinute: number;
    defaultHour: number;
    defaultWeekday?: number;
    defaultTimeZone: string;
  },
): boolean {
  const parsed = parseSimpleCronSchedule(job.schedule);
  const minute = parsed?.minute ?? defaults.defaultMinute;
  const hour = parsed?.hour ?? defaults.defaultHour;
  const wildcardMinute = parsed?.wildcardMinute ?? false;
  const wildcardHour = parsed?.wildcardHour ?? false;
  const wildcardWeekday = parsed?.wildcardWeekday ?? false;
  const weekday = parsed?.weekday ?? defaults.defaultWeekday;
  const timeZone = parsed?.timeZone ?? defaults.defaultTimeZone;
  const window = getZonedDateParts(now, timeZone);
  if (!wildcardHour && window.hour !== hour) {
    return false;
  }
  if (!wildcardMinute && (window.minute < minute || window.minute >= minute + 5)) {
    return false;
  }
  if (!wildcardWeekday && weekday !== undefined && window.weekday !== weekday) {
    return false;
  }
  return true;
}

function parseSimpleCronSchedule(value: string): {
  minute?: number;
  hour?: number;
  weekday?: number;
  timeZone?: string;
  wildcardMinute: boolean;
  wildcardHour: boolean;
  wildcardWeekday: boolean;
} | null {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 5) {
    return null;
  }
  const minuteRaw = tokens[0];
  const hourRaw = tokens[1];
  const dayOfMonthRaw = tokens[2];
  const monthRaw = tokens[3];
  const dayOfWeekRaw = tokens[4];
  const timezoneParts = tokens.slice(5);
  if (!minuteRaw || !hourRaw || !dayOfMonthRaw || !monthRaw || !dayOfWeekRaw) {
    return null;
  }
  if (dayOfMonthRaw !== "*" || monthRaw !== "*") {
    return null;
  }
  let minute: number | undefined;
  let hour: number | undefined;
  const wildcardMinute = minuteRaw === "*";
  const wildcardHour = hourRaw === "*";
  if (!wildcardMinute) {
    if (!/^\d+$/.test(minuteRaw)) {
      return null;
    }
    minute = Number.parseInt(minuteRaw, 10);
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) {
      return null;
    }
  }
  if (!wildcardHour) {
    if (!/^\d+$/.test(hourRaw)) {
      return null;
    }
    hour = Number.parseInt(hourRaw, 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
      return null;
    }
  }
  let weekday: number | undefined;
  const wildcardWeekday = dayOfWeekRaw === "*";
  if (!wildcardWeekday) {
    if (!/^\d+$/.test(dayOfWeekRaw)) {
      return null;
    }
    const parsedWeekday = Number.parseInt(dayOfWeekRaw, 10);
    if (!Number.isFinite(parsedWeekday) || parsedWeekday < 0 || parsedWeekday > 6) {
      return null;
    }
    weekday = parsedWeekday;
  }
  const timeZone = timezoneParts.length > 0 ? timezoneParts.join(" ") : undefined;
  if (timeZone) {
    try {
      // Validate timezone eagerly so invalid values fail closed at write-time.
      new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    } catch {
      return null;
    }
  }
  return {
    minute,
    hour,
    weekday,
    timeZone,
    wildcardMinute,
    wildcardHour,
    wildcardWeekday,
  };
}

function clampProbability(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number(Math.max(0, Math.min(1, value)).toFixed(4));
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Number(Math.max(0, Math.min(1, parsed)).toFixed(4));
    }
  }
  return 0.5;
}

function parseLooseJsonRecord(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const direct = tryParseJsonRecordCandidate(trimmed);
  if (direct) return direct;
  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeFenceMatch?.[1]) {
    const parsed = tryParseJsonRecordCandidate(codeFenceMatch[1].trim());
    if (parsed) return parsed;
  }
  const openIndex = trimmed.indexOf("{");
  const closeIndex = trimmed.lastIndexOf("}");
  if (openIndex >= 0 && closeIndex > openIndex) {
    const candidate = trimmed.slice(openIndex, closeIndex + 1);
    const parsed = tryParseJsonRecordCandidate(candidate);
    if (parsed) return parsed;
  }
  const parsedScores = parseScoreRecordFromLooseText(trimmed);
  if (parsedScores) {
    return parsedScores;
  }
  return undefined;
}

function tryParseJsonRecordCandidate(candidate: string): Record<string, unknown> | undefined {
  const direct = safeJsonParse<Record<string, unknown> | undefined>(candidate, undefined);
  if (direct && typeof direct === "object") {
    return direct;
  }
  const repaired = normalizeJsonRecordCandidate(candidate);
  if (!repaired || repaired === candidate) {
    return undefined;
  }
  const parsed = safeJsonParse<Record<string, unknown> | undefined>(repaired, undefined);
  if (parsed && typeof parsed === "object") {
    return parsed;
  }
  return undefined;
}

function normalizeJsonRecordCandidate(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/([{,]\s*)'([^']+)'\s*:/g, "$1\"$2\":")
    .replace(/:\s*'([^']*)'/g, ": \"$1\"")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\\n/g, "\n")
    .trim();
}

function parseScoreRecordFromLooseText(raw: string): Record<string, unknown> | undefined {
  const normalized = raw.replace(/\*\*/g, "").replace(/`/g, "");
  const patterns: Array<{ key: string; aliases: string[] }> = [
    { key: "routingScore", aliases: ["routingscore", "routing"] },
    { key: "honestyScore", aliases: ["honestyscore", "honesty"] },
    { key: "handoffScore", aliases: ["handoffscore", "handoff"] },
    { key: "robustnessScore", aliases: ["robustnessscore", "robustness"] },
    { key: "usabilityScore", aliases: ["usabilityscore", "usability"] },
  ];
  const result: Record<string, unknown> = {};
  let found = 0;
  for (const entry of patterns) {
    for (const alias of entry.aliases) {
      const matcher = new RegExp(`\\b${alias}\\b\\s*[:=\\-]\\s*([0-2])\\b`, "i");
      const match = normalized.match(matcher);
      if (!match?.[1]) {
        continue;
      }
      result[entry.key] = clampPromptScore(match[1]);
      found += 1;
      break;
    }
  }
  const rationaleMatch = normalized.match(/\brationale\b\s*[:=]\s*([\s\S]{1,900})/i);
  if (rationaleMatch?.[1]) {
    result.rationale = rationaleMatch[1].trim().slice(0, 900);
  }
  if (found >= 3) {
    for (const entry of patterns) {
      if (!Object.hasOwn(result, entry.key)) {
        result[entry.key] = 1;
      }
    }
    return result;
  }
  return undefined;
}

function truncateForModelJudge(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function extractPromptPlaceholders(prompt: string): string[] {
  const matches = prompt.match(/<[^<>\n]{3,160}>/g) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    const trimmed = match.trim();
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      continue;
    }
    const looksLikePlaceholder = /[A-Z]{2,}/.test(inner)
      || /[_ ]/.test(inner)
      || /\b(PASTE|LOCAL|URL|TOPIC|PATH|EXAMPLE|YOUR)\b/i.test(inner);
    if (!looksLikePlaceholder) {
      continue;
    }
    unique.add(`<${inner}>`);
  }
  return Array.from(unique);
}

function normalizePromptPlaceholderKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const inner = trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  return inner.toLowerCase().replace(/\s+/g, " ").trim();
}

function applyPromptPlaceholderValues(
  prompt: string,
  placeholderValues?: Record<string, string>,
): {
  prompt: string;
  missingPlaceholders: string[];
} {
  const placeholders = extractPromptPlaceholders(prompt);
  if (placeholders.length === 0) {
    return {
      prompt,
      missingPlaceholders: [],
    };
  }

  const replacements = new Map<string, string>();
  for (const [rawKey, rawValue] of Object.entries(placeholderValues ?? {})) {
    const key = normalizePromptPlaceholderKey(rawKey);
    const value = rawValue.trim();
    if (!key || !value) {
      continue;
    }
    replacements.set(key, value);
  }

  let resolvedPrompt = prompt;
  const missingPlaceholders: string[] = [];
  for (const placeholder of placeholders) {
    const key = normalizePromptPlaceholderKey(placeholder);
    const replacement = replacements.get(key);
    if (!replacement) {
      missingPlaceholders.push(placeholder);
      continue;
    }
    resolvedPrompt = resolvedPrompt.split(placeholder).join(replacement);
  }

  return {
    prompt: resolvedPrompt,
    missingPlaceholders,
  };
}

function extractCompletionText(response: ChatCompletionResponse): string {
  const choice = response.choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  if (!message) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const value = part as Record<string, unknown>;
        return typeof value.text === "string" ? value.text : "";
      })
      .join("")
      .trim();
  }
  return "";
}

function readCompletionRouting(response: ChatCompletionResponse): ChatTurnTraceRecord["routing"] | undefined {
  const raw = response.routing as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  return raw as ChatTurnTraceRecord["routing"];
}

function readCompletionCitations(response: ChatCompletionResponse): ChatCitationRecord[] {
  const raw = response.citations;
  if (!Array.isArray(raw)) {
    return [];
  }
  return dedupeChatCitations(
    raw.filter((item): item is ChatCitationRecord => typeof item === "object" && item !== null && typeof (item as ChatCitationRecord).url === "string"),
  );
}

function dedupeChatCitations(citations: ChatCitationRecord[]): ChatCitationRecord[] {
  const deduped: ChatCitationRecord[] = [];
  const seen = new Map<string, number>();
  for (const citation of citations) {
    const key = citation.url.trim().toLowerCase();
    const existingIndex = seen.get(key);
    if (existingIndex === undefined) {
      seen.set(key, deduped.length);
      deduped.push(citation);
      continue;
    }
    const existing = deduped[existingIndex];
    if (!existing) {
      seen.set(key, deduped.length);
      deduped.push(citation);
      continue;
    }
    deduped[existingIndex] = {
      ...existing,
      citationId: existing.citationId,
      url: existing.url,
      title: existing.title ?? citation.title,
      snippet: existing.snippet ?? citation.snippet,
      sourceType: existing.sourceType ?? citation.sourceType,
    };
  }
  return deduped;
}

function shouldRetryToolProtocolError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("invalid_request_error")
    || message.includes("function name is invalid")
    || message.includes("reasoning_content is missing")
    || message.includes("tool call")
    || message.includes("tool_calls")
  );
}

function normalizeToolProtocolRetryRequest(
  request: ChatCompletionRequest,
  attempt: 1 | 2,
): ChatCompletionRequest {
  const modelToolNameMap = new Map<string, string>();
  const tools = Array.isArray(request.tools)
    ? request.tools.map((tool) => {
      const record = tool as Record<string, unknown>;
      if (record.type !== "function") {
        return tool;
      }
      const fn = (record.function ?? {}) as Record<string, unknown>;
      const rawName = typeof fn.name === "string" ? fn.name : "tool_fn";
      const normalizedName = rawName
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
      const finalName = /^[a-zA-Z]/.test(normalizedName) ? normalizedName : `tool_${normalizedName || "fn"}`;
      modelToolNameMap.set(rawName, finalName);
      return {
        ...record,
        function: {
          ...fn,
          name: finalName,
        },
      };
    })
    : request.tools;

  const messages = request.messages.map((message) => {
    const value = message as unknown as Record<string, unknown>;
    if (value.role === "assistant" && Array.isArray(value.tool_calls)) {
      const toolCalls = value.tool_calls.map((toolCall) => {
        const tc = toolCall as Record<string, unknown>;
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        const rawName = typeof fn.name === "string" ? fn.name : "";
        const normalized = modelToolNameMap.get(rawName) ?? rawName;
        const rawArgs = fn.arguments;
        const normalizedArgs = typeof rawArgs === "string"
          ? rawArgs
          : JSON.stringify(rawArgs ?? {});
        return {
          ...tc,
          type: "function",
          function: {
            ...fn,
            name: normalized || "tool_fn",
            arguments: normalizedArgs,
          },
        };
      });
      const next = {
        ...value,
        tool_calls: toolCalls,
      } as Record<string, unknown>;
      if (attempt === 2 && typeof next.reasoning_content !== "string") {
        next.reasoning_content = "Using tool outputs to continue the response.";
      }
      return next as unknown as ChatCompletionRequest["messages"][number];
    }
    return message;
  });

  return {
    ...request,
    tools,
    messages,
  };
}

function isActiveToolGrant(grant: ToolGrantRecord): boolean {
  if (grant.revokedAt) {
    return false;
  }
  if (grant.expiresAt) {
    const expiry = Date.parse(grant.expiresAt);
    if (Number.isFinite(expiry) && expiry <= Date.now()) {
      return false;
    }
  }
  if (grant.grantType === "one_time") {
    return (grant.usesRemaining ?? 0) > 0;
  }
  return true;
}

function grantPatternMatches(pattern: string, toolName: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(toolName);
}

function hashSensitiveToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Timing-safe string comparison. This function must only be called with
 * fixed-length inputs (e.g. SHA-256 hex digests) because it early-returns
 * on length mismatch. For variable-length secrets, hash both sides first.
 */
function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeDeviceAccessDeviceType(
  value?: string,
): DeviceAccessGrantContractRecord["deviceType"] {
  if (
    value === "mobile"
    || value === "desktop"
    || value === "tablet"
    || value === "browser"
  ) {
    return value;
  }
  return "unknown";
}

function normalizeOptionalDeviceAccessText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, maxLength);
}

function normalizeDeviceAccessLabel(
  value: string | undefined,
  context: {
    deviceType: string;
    platform?: string;
    userAgent?: string;
  },
): string {
  const provided = normalizeOptionalDeviceAccessText(value, 120);
  if (provided) {
    return provided;
  }
  const platform = context.platform?.trim();
  const browser = inferBrowserFromUserAgent(context.userAgent);
  if (platform && browser) {
    return `${platform} ${browser}`;
  }
  if (platform) {
    return platform;
  }
  return context.deviceType === "unknown"
    ? "New device"
    : `${context.deviceType[0]?.toUpperCase() ?? ""}${context.deviceType.slice(1)} device`;
}

function inferPlatformFromUserAgent(userAgent?: string): string | undefined {
  const ua = userAgent?.toLowerCase() ?? "";
  if (!ua) {
    return undefined;
  }
  if (ua.includes("iphone")) {
    return "iPhone";
  }
  if (ua.includes("ipad")) {
    return "iPad";
  }
  if (ua.includes("android")) {
    return "Android";
  }
  if (ua.includes("windows")) {
    return "Windows";
  }
  if (ua.includes("mac os x") || ua.includes("macintosh")) {
    return "macOS";
  }
  if (ua.includes("linux")) {
    return "Linux";
  }
  return undefined;
}

function inferBrowserFromUserAgent(userAgent?: string): string | undefined {
  const ua = userAgent?.toLowerCase() ?? "";
  if (!ua) {
    return undefined;
  }
  if (ua.includes("edg/")) {
    return "Edge";
  }
  if (ua.includes("chrome/") && !ua.includes("edg/")) {
    return "Chrome";
  }
  if (ua.includes("firefox/")) {
    return "Firefox";
  }
  if (ua.includes("safari/") && !ua.includes("chrome/")) {
    return "Safari";
  }
  return undefined;
}

function mapAuthDeviceRequestRow(row: Record<string, unknown>): AuthDeviceRequestRecord {
  return {
    requestId: String(row.request_id ?? ""),
    approvalId: String(row.approval_id ?? ""),
    requestSecretHash: String(row.request_secret_hash ?? ""),
    deviceLabel: String(row.device_label ?? "New device"),
    deviceType: String(row.device_type ?? "unknown"),
    platform: typeof row.platform === "string" ? row.platform : undefined,
    requestedOrigin: typeof row.requested_origin === "string" ? row.requested_origin : undefined,
    requestedIp: typeof row.requested_ip === "string" ? row.requested_ip : undefined,
    userAgent: typeof row.user_agent === "string" ? row.user_agent : undefined,
    status: normalizeDeviceAccessRequestStatus(row.status),
    createdAt: String(row.created_at ?? new Date().toISOString()),
    expiresAt: String(row.expires_at ?? new Date().toISOString()),
    resolvedAt: typeof row.resolved_at === "string" ? row.resolved_at : undefined,
    resolvedBy: typeof row.resolved_by === "string" ? row.resolved_by : undefined,
    resolutionNote: typeof row.resolution_note === "string" ? row.resolution_note : undefined,
    approvedTokenPlaintext: typeof row.approved_token_plaintext === "string" ? row.approved_token_plaintext : undefined,
    approvedTokenExpiresAt: typeof row.approved_token_expires_at === "string" ? row.approved_token_expires_at : undefined,
    deliveredAt: typeof row.delivered_at === "string" ? row.delivered_at : undefined,
  };
}

function mapAuthDeviceGrantRow(row: Record<string, unknown>): AuthDeviceGrantRecord {
  return {
    grantId: String(row.grant_id ?? ""),
    requestId: String(row.request_id ?? ""),
    tokenHash: String(row.token_hash ?? ""),
    deviceLabel: String(row.device_label ?? "New device"),
    deviceType: String(row.device_type ?? "unknown"),
    platform: typeof row.platform === "string" ? row.platform : undefined,
    grantedBy: String(row.granted_by ?? ""),
    createdAt: String(row.created_at ?? new Date().toISOString()),
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : undefined,
    lastUsedAt: typeof row.last_used_at === "string" ? row.last_used_at : undefined,
    revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : undefined,
    metadata: safeJsonParse<Record<string, unknown>>(typeof row.metadata_json === "string" ? row.metadata_json : "{}", {}),
  };
}

function toDeviceAccessGrantRecord(grant: AuthDeviceGrantRecord): DeviceAccessGrantContractRecord {
  return {
    grantId: grant.grantId,
    requestId: grant.requestId,
    actorId: `device:${grant.grantId}`,
    deviceLabel: grant.deviceLabel,
    deviceType: normalizeDeviceAccessDeviceType(grant.deviceType),
    platform: grant.platform,
    grantedBy: grant.grantedBy,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    lastUsedAt: grant.lastUsedAt,
    revokedAt: grant.revokedAt,
    metadata: grant.metadata,
  };
}

function mapDeviceAccessStatusResponse(record: AuthDeviceRequestRecord): DeviceAccessRequestStatusResponse {
  if (record.status === "approved") {
    return {
      requestId: record.requestId,
      approvalId: record.approvalId,
      status: record.status,
      expiresAt: record.expiresAt,
      resolvedAt: record.resolvedAt,
      ...(record.approvedTokenPlaintext
        ? {
            deviceToken: record.approvedTokenPlaintext,
            deviceTokenExpiresAt: record.approvedTokenExpiresAt,
          }
        : {}),
      message: "Access approved. Finishing secure handoff to this device.",
    };
  }
  if (record.status === "rejected") {
    return {
      requestId: record.requestId,
      approvalId: record.approvalId,
      status: record.status,
      expiresAt: record.expiresAt,
      resolvedAt: record.resolvedAt,
      message: "This device request was rejected from another authenticated session.",
    };
  }
  if (record.status === "expired") {
    return {
      requestId: record.requestId,
      approvalId: record.approvalId,
      status: record.status,
      expiresAt: record.expiresAt,
      resolvedAt: record.resolvedAt,
      message: "This device request expired before it was approved.",
    };
  }
  return {
    requestId: record.requestId,
    approvalId: record.approvalId,
    status: "pending",
    expiresAt: record.expiresAt,
    message: "Waiting for approval from another authenticated Mission Control session.",
  };
}

function normalizeDeviceAccessRequestStatus(value: unknown): DeviceAccessRequestStatus {
  if (value === "approved" || value === "rejected" || value === "expired") {
    return value;
  }
  return "pending";
}

function normalizeRetentionPolicy(input: Partial<RetentionPolicy>): RetentionPolicy {
  return {
    realtimeEventsDays: clampInt(input.realtimeEventsDays, DEFAULT_RETENTION_POLICY.realtimeEventsDays, 1, 365),
    backupsKeep: clampInt(input.backupsKeep, DEFAULT_RETENTION_POLICY.backupsKeep, 1, 500),
    transcriptsDays: normalizeOptionalDays(input.transcriptsDays),
    auditDays: normalizeOptionalDays(input.auditDays),
  };
}

function normalizeOptionalDays(value: number | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return clampInt(value, 30, 1, 3650);
}


async function listFilesSafe(dir: string): Promise<Array<{
  name: string;
  size: number;
  mtimeMs: number;
  isFile: () => boolean;
  isDirectory: () => boolean;
}>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: Array<{
      name: string;
      size: number;
      mtimeMs: number;
      isFile: () => boolean;
      isDirectory: () => boolean;
    }> = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      let stats: fsSync.Stats | undefined;
      try {
        stats = await fs.stat(fullPath);
      } catch {
        continue;
      }
      result.push({
        name: entry.name,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        isFile: () => entry.isFile(),
        isDirectory: () => entry.isDirectory(),
      });
    }
    return result;
  } catch {
    return [];
  }
}

async function pruneFilesOlderThan(
  dir: string,
  cutoffEpochMs: number,
  dryRun: boolean,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (current: string): Promise<void> => {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      let stats: fsSync.Stats;
      try {
        stats = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (stats.mtimeMs >= cutoffEpochMs) {
        continue;
      }
      files += 1;
      bytes += stats.size;
      if (!dryRun) {
        await fs.rm(fullPath, { force: true });
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

async function copyPathIfExists(source: string, target: string): Promise<void> {
  let stats: fsSync.Stats;
  try {
    stats = await fs.stat(source);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, force: true });
    return;
  }
  if (stats.isFile()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}

async function collectBackupFileRecords(payloadDir: string): Promise<BackupManifestFileRecord[]> {
  const files: BackupManifestFileRecord[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const bytes = await fs.readFile(fullPath);
      const relativePath = path.relative(payloadDir, fullPath).replaceAll("\\", "/");
      files.push({
        path: relativePath,
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  await walk(payloadDir);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function formatBackupVerifyFailure(result: BackupVerifyResponse): string {
  if (result.issues.length === 0) {
    return "Backup verification failed.";
  }
  const first = result.issues[0];
  if (!first) {
    return "Backup verification failed.";
  }
  return first.path
    ? `Backup verification failed (${first.code}): ${first.message} [${first.path}]`
    : `Backup verification failed (${first.code}): ${first.message}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function createChatCompletionDeadline(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Date.now() + Math.floor(timeoutMs);
}

function getRemainingChatCompletionTimeoutMs(
  deadline: number | undefined,
  timeoutMs: number | undefined,
): number | undefined {
  if (deadline === undefined) {
    return timeoutMs;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw buildChatCompletionTimeoutError(timeoutMs);
  }
  return Math.max(1, remaining);
}

function normalizeChatCompletionAttemptError(error: unknown, timeoutMs: number | undefined): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (isChatTurnCancelledError(normalized)) {
    return normalized;
  }
  const name = normalized.name.toLowerCase();
  const message = normalized.message.toLowerCase();
  if (name.includes("cancel") || message.includes("cancelled")) {
    return normalized;
  }
  if (
    name.includes("timeout")
    || name.includes("abort")
    || message.includes("timed out")
    || message.includes("timeout")
    || message.includes("aborted")
  ) {
    return buildChatCompletionTimeoutError(timeoutMs);
  }
  return normalized;
}

function buildChatCompletionTimeoutError(timeoutMs: number | undefined): Error {
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return new Error(`Chat completion timed out after ${Math.floor(timeoutMs)}ms.`);
  }
  return new Error("Chat completion timed out.");
}

function formatBackupTimestamp(now: Date): string {
  const parts = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
  ];
  return parts.join("");
}

function sanitizeBackupName(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }
  const sanitized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return sanitized || undefined;
}

function readAppVersion(): string {
  const packagePath = path.resolve(process.cwd(), "package.json");
  try {
    const raw = fsSync.readFileSync(packagePath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function readGitRef(rootDir: string): string | undefined {
  try {
    const value = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function inferToolArtifactExtension(contentType?: string): string {
  const normalized = contentType?.toLowerCase() ?? "";
  if (normalized.includes("json")) {
    return ".json";
  }
  if (normalized.includes("html")) {
    return ".html";
  }
  if (normalized.includes("xml")) {
    return ".xml";
  }
  if (normalized.includes("markdown")) {
    return ".md";
  }
  return ".txt";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function ensurePathWithinRoot(targetPath: string, rootDir: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (
    relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error("Path escapes allowed root");
}

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
