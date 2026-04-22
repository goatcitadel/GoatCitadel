/* eslint-disable @typescript-eslint/no-unused-vars, max-lines */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { isVerboseLoggingEnabled } from "../runtime-ux.js";
import { EventIngestService, logger } from "@goatcitadel/gateway-core";

const log = logger.child("gateway-service");
const onboardingTimingEnabled = process.env.GOATCITADEL_DEBUG_ONBOARDING_TIMING === "1";
import { MeshService } from "@goatcitadel/mesh-core";
import { estimateTokensFromText, truncateByTokenEstimate } from "@goatcitadel/memory-core";
import {
  buildInstalledIntegrationPluginRecord,
  resolveIntegrationPluginInstallMetadata,
} from "./integration-plugin-author-contract.js";
import { deleteProviderApiKeyWithFallback, persistProviderApiKeyWithFallback } from "./provider-secret-persistence.js";
import { sendTelegramTypingIndicator } from "./telegram-typing.js";
import { OrchestrationEngine, WorktreeManager, type TurnRuntime } from "@goatcitadel/orchestration";
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
  type Storage,
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
  findProviderTemplate,
  GoatError,
  inferProviderForModelId,
  isChatTurnActiveStatus,
  isChatTurnTerminalStatus,
  NotFoundError,
  providerAllowsForeignModelIds,
  ValidationError,
} from "@goatcitadel/contracts";
import { buildUnifiedConfigPayload } from "../config-sync-lib.js";
import { createGatewayStorage } from "../storage-factory.js";
import { DatabaseCutoverService } from "./database-cutover-service.js";
import {
  importAgencyCatalog,
  suggestImportedCatalogEntries,
  buildCatalogSpecialistSuggestion,
} from "./agency-agent-catalog-service.js";
import * as chatWorkbenchService from "./chat-workbench-service.js";
import { ApprovalRuntimeService } from "./approval-runtime-service.js";
import type {
  DatabaseCutoverProfile,
  DatabaseCutoverResponse,
  DatabaseHealthSnapshot,
  DatabaseVerifyResponse,
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
  AgencyCatalogImportRequest,
  AgencyCatalogImportResponse,
  AgentProfileCreateInput,
  AgentProfileRecord,
  AgentProfileUpdateInput,
  BackupCreateResponse,
  BackupManifestFileRecord,
  BackupManifestRecord,
  BackupVerifyResponse,
  AuthRuntimeSettings,
  CompanionAuditEventRecord,
  CompanionSessionExchangeInput,
  CompanionSessionExchangeResponse,
  CompanionSessionAdminRecord,
  CompanionSessionInfoResponse,
  CompanionSessionListResponse,
  CompanionSessionRefreshInput,
  CompanionSessionRefreshResponse,
  CompanionSessionRevokeResponse,
  CompanionSignatureAlgorithm,
  AuthSettingsUpdateInput,
  FilesystemReadAccessMode,
  FollowOnProfileCoverageRecord,
  FollowOnProofLaneArtifactIndex,
  FollowOnProofLaneArtifactLaneId,
  FollowOnProofLaneArtifactRecord,
  DeviceAccessRequestCreateInput,
  DeviceAccessRequestCreateResponse,
  DeviceAccessGrantRecord as DeviceAccessGrantContractRecord,
  DeviceAccessRequestStatus,
  DeviceAccessRequestStatusResponse,
  DeploymentProfile,
  ApprovalEffectRecord,
  ApprovalBulkResolveInput,
  ApprovalBulkResolveResult,
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
  ChannelCapabilities,
  ChannelRuntimeStatus,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelSendInput,
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupDraftCreateInput,
  ChannelSetupDraftUpdateInput,
  ChannelSetupFinalizeResult,
  ChannelProbeReport,
  ChannelSetupTestResult,
  ChannelSetupValidationResult,
  ChannelTypingInput,
  ChannelTypingResult,
  ChannelUnsendInput,
  ChannelInboundMessageInput,
  DiscordPairingRecord,
  DiscordRuntimeStatus,
  ChatAttachmentRecord,
  ChatAttachmentMediaType,
  ChatAttachmentPreviewResponse,
  ChatCapabilityUpgradeSuggestion,
  ChatCancelTurnResponse,
  ChatCitationRecord,
  ChatGeneratedArtifactKind,
  ChatGeneratedArtifactRecord,
  ChatGeneratedArtifactSourceSurface,
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
  ChatSessionBulkArchiveInput,
  ChatSessionBulkArchiveResult,
  ChatSessionCreateInput,
  ChatSessionPrefsRecord,
  ChatSessionBindingRecord,
  ChatSessionListQuery,
  ChatSessionRecord,
  ChatSessionPrefsPatch,
  ChatSpecialistCandidateCreateInput,
  ChatSpecialistCandidatePatchInput,
  ChatSpecialistCandidateRecord,
  ChatSpecialistCandidateSuggestionRecord,
  RoutingPreflightRequest,
  RoutingPreflightResult,
  ChatStreamChunk,
  ChatStreamChunkDraft,
  ChatStreamUsageRecord,
  ChatThreadResponse,
  ChatThinkingLevel,
  ChatUserInputPromptAnswerResponse,
  ChatUserInputPromptResponse,
  CapabilityCatalogScope,
  CapabilityCatalogSnapshotRecord,
  CapabilityGapEventRecord,
  CapabilityProposalRecord,
  CodeModeRunRecord,
  CodeModeRunRequest,
  ChatToolRunRecord,
  ChatTurnBranchKind,
  ChatTurnFailureRecord,
  ChatTurnRepairRecord,
  ChatTurnTraceRecord,
  ChatWebMode,
  DocsIngestInput,
  EmbeddingIndexInput,
  EmbeddingQueryInput,
  ContextManifestDetail,
  MemoryContextComposeRequest,
  MemoryContextPack,
  MemoryRelationScope,
  ThreadKnowledgeAttachmentRecord,
  MemoryMaintenancePolicyPatchInput,
  MemoryMaintenancePolicyRecord,
  MemoryMaintenanceProvenanceRecord,
  MemoryMaintenanceRecommendationRecord,
  MemoryMaintenanceRunNowInput,
  MemoryMaintenanceRunRecord,
  MemoryMaintenanceStatusRecord,
  MemoryQmdStatsResponse,
  MemorySearchQuery,
  MemoryWriteInput,
  CronJobRecord,
  DashboardState,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  GatewayEventInput,
  GatewayEventResult,
  IntegrationCatalogEntry,
  ImportedAgentCatalogListInput,
  ImportedAgentCatalogRecord,
  ImportedAgentCatalogStatePatchInput,
  IntegrationFormSchema,
  IntegrationPluginInstallInput,
  IntegrationPluginRecord,
  IntegrationConnection,
  IntegrationConnectionCreateInput,
  IntegrationConnectionUpdateInput,
  IntegrationActionInvokeInput,
  IntegrationActionInvokeResult,
  IntegrationKind,
  HookCreateInput,
  HookDecisionBlock,
  HookRecord,
  HookRunRecord,
  HookUpdateInput,
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
  LlmConfigFile,
  LlmModelRecord,
  LlmProviderRequestConfig,
  LlmRuntimeConfig,
  LlamaCppAdvisorRecommendation,
  LlamaCppAdvisorRequest,
  LlamaCppModelManifest,
  LlamaCppRuntimeStatus,
  OnboardingBootstrapInput,
  OnboardingBootstrapResult,
  OnboardingChecklistItem,
  OnboardingState,
  OnboardingStartupState,
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
  RuntimeLifecycleResponse,
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
  PromptPackHumanReviewRecordV2,
  PromptPackReportRecord,
  PromptPackRunRecord,
  PromptPackTestRecord,
  PromptPackToolTier,
  ProactiveTickWorkflowPayload,
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
  WeeklyImprovementReportRecord,
  HarnessAuditReportRecord,
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
  RepairCandidateRecord,
  RepairValidationStatus,
  ImprovementActivationRecord,
  ImprovementCandidateDetailResponse,
  ImprovementCandidateRecord,
  ImprovementRef,
  ImprovementSignalRecord,
  MemoryItemRecord,
  MemoryLifecyclePatch,
  MemoryChangeEvent,
  ConnectorDiagnosticReport,
  OrchestrationPlanWorkflowPayload,
  McpTemplateDiscoveryResult,
  CronReviewItem,
  CronRunDiff,
  ReplayRegressionRun,
  ReplayRegressionResult,
  CapabilityTrendSeries,
  DurableRunCreateRequest,
  DurableRunTimelineEvent,
  DurableWakeResult,
  DurableRetryPolicy,
  RemoteActionTokenRecord,
} from "@goatcitadel/contracts";
import type { ConnectorRecord, ConnectorType } from "@goatcitadel/contracts";
import { BUILTIN_AGENT_PROFILES } from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";
import { getRequestAttribution } from "@goatcitadel/storage";
import { LlmService } from "./llm-service.js";
import { AssemblyService } from "./assembly-service.js";
import { ApprovalExplainerService } from "./approval-explainer-service.js";
import { ApprovalWaitRunService } from "./approval-wait-run-service.js";
import { scoutCapabilityUpgradeSuggestions } from "./chat-capability-scout.js";
import { classifyCapabilityGapFromTrace } from "./capability-gap-classifier.js";
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
import { buildConversationCompactionSummary, trimNewestContextMessagesForPromptCache } from "./chat-compaction.js";
import {
  assertChatSessionActive,
  buildChatSessionUpdatedPayload,
  deriveChatSessionTitleFromContent,
  shouldAllowCrossProviderFallback,
} from "./chat-session-utils.js";
import { buildChatThreadResponse, buildSelectedPathTurnIds, resolveNewestLeafTurnId } from "./chat-thread-utils.js";
import * as chatGeneratedArtifactService from "./chat-generated-artifact-service.js";
import * as chatThreadKnowledgeService from "./chat-thread-knowledge-service.js";
import { executeOrchestrationPlan } from "../orchestration/engine.js";
import { CHAT_MODE_POLICY } from "../orchestration/policies/chat-policy.js";
import { buildProviderCapabilityRegistry } from "../orchestration/providers/capability-registry.js";
import { buildOrchestrationPlan, resolveModePolicy, shouldUseModeOrchestration } from "../orchestration/router.js";
import type {
  OrchestrationExecutionResult,
  OrchestrationPlan as ModeOrchestrationPlan,
  OrchestrationRole,
  OrchestrationRouterInput,
  OrchestrationStepExecutionResult,
} from "../orchestration/types.js";
import {
  getIntegrationFormSchema,
  INTEGRATION_CATALOG,
  resolveIntegrationCatalogMaturity,
  resolveIntegrationCatalogRuntimeAvailability,
} from "./integration-catalog.js";
import { type ChannelSetupRecentTestCacheEntry } from "./channel-setup-test-cache.js";
import { MemoryContextService } from "./memory-context-service.js";
import { LlamaCppRuntimeService } from "./llama-cpp-runtime-service.js";
import { NpuSidecarService } from "./npu-sidecar-service.js";
import { SecretStoreService } from "./secret-store-service.js";
import { normalizeAgentInputFromSend } from "./chat-agent-orchestrator.js";
import { GatewayTurnRuntime } from "./chat-turn-runtime.js";
import { ResearchService } from "./research-service.js";
import { ObsidianVaultService } from "./obsidian-vault-service.js";
import { SkillImportService } from "./skill-import-service.js";
import { buildHarnessAuditReport } from "./harness-audit.js";
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
import { serializePathWithinRoot } from "./security-utils.js";
import { buildVoiceControlStartFailure } from "./voice-control-guard.js";
import { MediaVoiceService, detectAttachmentMediaType } from "./media-voice-service.js";
import {
  COST_REPORT_HOURLY_JOB_ID,
  CronAutomationService,
  IMPROVEMENT_WEEKLY_JOB_ID,
  MEMORY_FLUSH_DAILY_JOB_ID,
  normalizeCronJobId,
  normalizeCronJobName,
  normalizeCronSchedule,
  PRIVATE_BETA_BACKUP_JOB_ID,
  UPDATE_REVIEW_DAILY_JOB_ID,
} from "./gateway/cron-automation-service.js";
import * as cronSchedulerService from "./cron-scheduler-service.js";
import * as orchestrationLifecycleService from "./orchestration-lifecycle-service.js";
import { OperatorSummaryCache } from "./gateway/operator-summary-cache.js";
import { DiscordRuntimeService } from "./discord-runtime-service.js";
import { createDailyUpdateReview, renderUpdateReviewMarkdown } from "./gateway/update-review.js";
import {
  createGatewayAuthCredentialPlan,
  readAssistantAuthConfigSnapshotSync,
  resolveGatewayInstallToken as resolveGatewayInstallTokenFromPlanner,
} from "./gateway/auth-credential-planner.js";
import { verifyBackupAtPath } from "./gateway/backup-verify.js";
import { BackupRetentionService } from "./backup-retention-service.js";
import * as settingsAuthService from "./settings-auth-service.js";
import * as mcpDiagnosticsService from "./mcp-diagnostics-service.js";
import * as mcpServerAdminService from "./mcp-server-admin-service.js";
import * as connectorDiagnosticsHelpers from "./connector-diagnostics-helpers.js";
import * as discordPairingHelpers from "./discord-pairing-helpers.js";
import * as discordRuntimeBridgeService from "./discord-runtime-bridge-service.js";
import * as channelSetupService from "./channel-setup-service.js";
import * as integrationDiagnosticsService from "./integration-diagnostics-service.js";
import * as connectionUrlHelpers from "./connection-url-helpers.js";
import * as onboardingMarkerHelpers from "./onboarding-marker-helpers.js";
import * as guidanceDocumentHelpers from "./guidance-document-helpers.js";
import * as cronJobConfigHelpers from "./cron-job-config-helpers.js";
import * as chatCommandService from "./chat-command-service.js";
import * as chatSessionService from "./chat-session-service.js";
import * as llmCompletionService from "./llm-completion-service.js";
import * as durableExecutionService from "./durable-execution-service.js";
import * as chatDurableRunService from "./chat-durable-run-service.js";
import * as chatTurnPrepService from "./chat-turn-prep-service.js";
import * as chatTurnTraceHydration from "./chat-turn-trace-hydration.js";
import * as chatTurnUserMessage from "./chat-turn-user-message.js";
import { buildDelegatedChatSendRequest } from "./delegated-chat-request.js";
import * as chatTurnStreamService from "./chat-turn-stream-service.js";
import * as chatTurnDispatchService from "./chat-turn-dispatch-service.js";
import { ChatTurnRuntimeService } from "./chat-turn-runtime-service.js";
import { ToolInvocationCoordinatorService } from "./tool-invocation-coordinator-service.js";
import {
  ChatTurnExecutionRegistry,
  type ActiveChatTurnExecution,
  type ActiveChatTurnStreamExecution,
  ChatTurnWriteConflictError,
} from "./chat-turn-execution-registry.js";
import { buildDelegatedSessionToolGrantCopies } from "./delegated-session-tool-grants.js";
import { resolveProjectRootForToolContext, resolveToolRequestPaths } from "./tool-path-resolution.js";
import type { ServiceContext } from "./service-context.js";
import { buildGatewayServiceContext } from "./gateway/build-service-context.js";
import { ChatProjectService } from "./chat-project-service.js";
import { DurableRunService } from "./durable-run-service.js";
import { HooksService } from "./hooks-service.js";
import { ChatLearnedMemoryService } from "./chat-learned-memory-service.js";
import { parseChatModelCommandTarget } from "./chat-model-command.js";
import { PromptPackService, normalizePromptTestCode, clampPromptScore } from "./prompt-pack-service.js";
import { ChatProactiveService } from "./chat-proactive-service.js";
import { ImprovementService } from "./improvement-service.js";
import { MemoryMaintenanceService } from "./memory-maintenance-service.js";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { RuntimeLifecycleReadService } from "./runtime-lifecycle-read-service.js";
import { CapabilitySystemService } from "./capability-system-service.js";
import type { CodeModeApprovalQueueItem } from "./capability-system-service.js";
import { ReplayExecutionSkippedError } from "./replay-execution.js";
import { evaluateDeploymentProfileToolAccess } from "../tool-runtime-guardrails.js";
import { buildGatewayConnectorRecords, filterConnectorRecords } from "./connector-registry.js";
import { buildApprovalRemoteTokenConnectorDeliveryPayload } from "./approval-connector-delivery.js";
import { resolveChannelSendAttachments } from "./channel-attachment-payload.js";
import {
  commsSend as commsSendImpl,
  commsReply as commsReplyImpl,
  commsReact as commsReactImpl,
  commsUnsend as commsUnsendImpl,
  commsTyping as commsTypingImpl,
  commsGmailRead as commsGmailReadImpl,
  commsGmailSend as commsGmailSendImpl,
  commsCalendarList as commsCalendarListImpl,
  commsCalendarCreate as commsCalendarCreateImpl,
} from "./comms-service.js";
import {
  knowledgeMemoryWrite as knowledgeMemoryWriteImpl,
  knowledgeMemorySearch as knowledgeMemorySearchImpl,
  knowledgeDocsIngest as knowledgeDocsIngestImpl,
  knowledgeEmbeddingsIndex as knowledgeEmbeddingsIndexImpl,
  knowledgeEmbeddingsQuery as knowledgeEmbeddingsQueryImpl,
} from "./memory-facade-service.js";
import {
  listIntegrationConnections as listIntegrationConnectionsImpl,
  getIntegrationConnection as getIntegrationConnectionImpl,
  getIntegrationConnectionChannelCapabilities as getIntegrationConnectionChannelCapabilitiesImpl,
  getIntegrationConnectionChannelRuntimeStatus as getIntegrationConnectionChannelRuntimeStatusImpl,
  runIntegrationConnectionDiagnostics as runIntegrationConnectionDiagnosticsImpl,
  createIntegrationConnection as createIntegrationConnectionImpl,
  updateIntegrationConnection as updateIntegrationConnectionImpl,
  deleteIntegrationConnection as deleteIntegrationConnectionImpl,
  listDiscordPairings as listDiscordPairingsImpl,
  approveDiscordPairing as approveDiscordPairingImpl,
  revokeDiscordPairing as revokeDiscordPairingImpl,
  reconnectDiscordRuntime as reconnectDiscordRuntimeImpl,
  emitTelegramTypingImpl,
  listIntegrationPlugins as listIntegrationPluginsImpl,
  installIntegrationPlugin as installIntegrationPluginImpl,
  setIntegrationPluginEnabled as setIntegrationPluginEnabledImpl,
} from "./integration-channel-service.js";
import { invokeIntegrationConnectionAction as invokeIntegrationConnectionActionImpl } from "./integration-action-service.js";
import {
  mergeLatestFollowOnParityArtifacts,
  readLatestFollowOnParityArtifactsByProfile,
  readLatestVoiceEvidenceArtifactsByProfile,
} from "./follow-on-parity-artifacts.js";
import {
  MCP_APPROVAL_DELIVERY_TOOL_NAME,
  MCP_APPROVAL_INBOX_URL,
  createInternalMcpApprovalInboxTools,
  isInternalMcpApprovalInboxServer,
} from "./mcp-approval-inbox.js";
import { isVisibleMcpTemplateRecord } from "./mcp-template-visibility.js";
import {
  ApprovalEffectsService,
  deriveApprovalResolutionEffectsResult,
  type ApprovalResolutionEffectsResult,
} from "./approval-resolution-effects-service.js";

export interface ApprovalResolveResult {
  approval: ApprovalRequest;
  effects: ApprovalEffectRecord[];
  replay: ApprovalReplayResult;
  durableRunId?: string;
  resolutionEffects?: ApprovalResolutionEffectsResult;
}

export interface ApprovalReplayResult {
  approval: ApprovalRequest;
  events: ApprovalReplayEvent[];
  pendingAction?: PendingApprovalAction;
  durableRunId?: string;
  effects: ApprovalEffectRecord[];
}

export interface CompanionSessionRecord {
  sessionId: string;
  grantId: string;
  accessTokenHash: string;
  accessTokenExpiresAt: string;
  refreshTokenHash: string;
  refreshTokenExpiresAt: string;
  signingPublicKeyPem: string;
  signatureAlgorithm: CompanionSignatureAlgorithm;
  createdAt: string;
  lastRotatedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  metadata: Record<string, unknown>;
  deviceLabel: string;
  deviceType: string;
  platform?: string;
  grantExpiresAt?: string;
  grantRevokedAt?: string;
}

export interface CompanionAccessValidationResult {
  actorId: string;
  deviceId: string;
  grantId: string;
  sessionId: string;
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
  web: {
    firecrawl: {
      enabled: boolean;
      baseUrl: string;
      apiKeyEnv?: string;
      timeoutMs: number;
      defaultReadBackend: "native" | "firecrawl";
      fallbackToNative: boolean;
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
    replayOverridesV1Enabled: boolean;
    memoryLifecycleAdminV1Enabled: boolean;
    memoryMaintenanceV1Enabled: boolean;
    connectorDiagnosticsV1Enabled: boolean;
    computerUseGuardrailsV1Enabled: boolean;
    bankrBuiltinEnabled: boolean;
    cronReviewQueueV1Enabled: boolean;
    replayRegressionV1Enabled: boolean;
    codeModeV1Enabled: boolean;
    improvementLedgerV1Enabled: boolean;
    improvementActivationV1Enabled: boolean;
  };
}

const MCP_SERVERS_SETTING_KEY = "mcp_servers_v1";
const MCP_TOOLS_SETTING_KEY = "mcp_tools_v1";
const MCP_TOOL_FIRST_APPROVAL_SETTING_KEY = "mcp_tool_first_approval_v1";
const INTEGRATION_PLUGINS_SETTING_KEY = "integration_plugins_v1";
const DISCORD_PAIRINGS_SETTING_KEY = "discord_pairings_v1";
const SKILL_ACTIVATION_POLICY_SETTING_KEY = "skill_activation_policy_v1";
const DAEMON_LOG_TAIL_SETTING_KEY = "daemon_log_tail_v1";
const FEATURE_FLAGS_SETTING_KEY = "feature_flags_v1";
const DURABLE_RETRY_POLICY_DEFAULT: DurableRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
};
const CHAT_STREAM_EVENT_POLL_INTERVAL_MS = 200;
const CHAT_STREAM_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
import {
  COMPANION_ACCESS_TOKEN_BYTES,
  COMPANION_ACCESS_TOKEN_TTL_MS,
  COMPANION_CONTRACT_ID,
  COMPANION_MAX_PUBLIC_KEY_PEM_LENGTH,
  COMPANION_REFRESH_TOKEN_BYTES,
  COMPANION_REFRESH_TOKEN_TTL_MS,
  COMPANION_REQUEST_CLOCK_SKEW_MS,
  COMPANION_REQUEST_NONCE_MAX_LENGTH,
  COMPANION_REQUEST_REPLAY_TTL_MS,
  COMPANION_REQUEST_SIGNATURE_MAX_LENGTH,
  COMPANION_SIGNATURE_ALGORITHM,
  DEVICE_ACCESS_APPROVAL_KIND,
  DEVICE_ACCESS_REQUEST_POLL_AFTER_MS,
  DEVICE_ACCESS_REQUEST_TTL_MS,
  DEVICE_ACCESS_SECRET_BYTES,
  DEVICE_ACCESS_TOKEN_BYTES,
  DEVICE_ACCESS_TOKEN_TTL_MS,
  assertCompanionSigningPublicKeyPem,
  hashSensitiveToken,
  inferBrowserFromUserAgent,
  inferPlatformFromUserAgent,
  mapAuthDeviceGrantRow,
  mapAuthDeviceRequestRow,
  mapDeviceAccessStatusResponse,
  normalizeCompanionSigningPublicKeyPem,
  normalizeDeviceAccessDeviceType,
  normalizeDeviceAccessLabel,
  normalizeDeviceAccessRequestStatus,
  normalizeOptionalDeviceAccessText,
  timingSafeStringEqual,
  toDeviceAccessGrantRecord,
  type AuthDeviceGrantRecord,
  type AuthDeviceRequestRecord,
} from "./device-access-helpers.js";

export const MEMORY_ITEM_STATUS_VALUES = new Set(["active", "forgotten"]);

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
export const MCP_SERVER_TEMPLATES: McpServerTemplateRecord[] = [
  {
    templateId: "approval-inbox",
    label: "GoatCitadel Approval Inbox",
    description:
      "Internal MCP receiver for durable approval deliveries, inbox review, and non-browser approval resolution.",
    transport: "http",
    url: MCP_APPROVAL_INBOX_URL,
    authType: "none",
    category: "orchestration",
    trustTier: "trusted",
    costTier: "free",
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "basic",
      allowedToolPatterns: [MCP_APPROVAL_DELIVERY_TOOL_NAME, "goatcitadel.approval.remote_action_inbox.*"],
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
    description:
      "Official Stripe remote MCP server for customers, subscriptions, invoices, and billing support workflows.",
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
    description:
      "Official Microsoft Learn MCP endpoint for current Microsoft documentation, examples, and how-to guidance.",
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
const CHAT_SESSION_AUTO_ALLOW_TOOLS = ["browser.search", "browser.navigate", "browser.extract", "http.get"] as const;

const DEFAULT_DELEGATION_ROLES = ["product", "architect", "coder", "qa", "ops"];
const IMPROVEMENT_WEEKLY_TIME_ZONE = "America/Los_Angeles";
const IMPROVEMENT_WEEKLY_SCHEDULE_LABEL = "0 2 * * 0 America/Los_Angeles";
const PRIVATE_BETA_BACKUP_TIME_ZONE = "America/Los_Angeles";
export const PRIVATE_BETA_BACKUP_SCHEDULE_LABEL = "30 2 * * * America/Los_Angeles";
const MEMORY_FLUSH_DAILY_TIME_ZONE = "America/Los_Angeles";
export const MEMORY_FLUSH_DAILY_SCHEDULE_LABEL = "0 3 * * * America/Los_Angeles";
const COST_REPORT_HOURLY_TIME_ZONE = "America/Los_Angeles";
export const COST_REPORT_HOURLY_SCHEDULE_LABEL = "0 * * * * America/Los_Angeles";
const UPDATE_REVIEW_DAILY_TIME_ZONE = "America/Los_Angeles";
export const UPDATE_REVIEW_DAILY_SCHEDULE_LABEL = "15 4 * * * America/Los_Angeles";
const PRIVATE_BETA_BACKUP_DEDUP_SETTING_KEY = "private_beta_backup_last_day_key_v1";
const MEMORY_FLUSH_DAILY_DEDUP_SETTING_KEY = "memory_flush_daily_last_day_key_v1";
const COST_REPORT_HOURLY_DEDUP_SETTING_KEY = "cost_report_hourly_last_hour_key_v1";
const UPDATE_REVIEW_DAILY_DEDUP_SETTING_KEY = "update_review_daily_last_day_key_v1";
const IMPROVEMENT_WEEKLY_SAMPLE_SIZE = 500;
const IMPROVEMENT_JUDGE_SAMPLE_LIMIT = 120;
const IMPROVEMENT_JUDGE_TIMEOUT_MS = 15_000;
const IMPROVEMENT_SCHEDULER_INTERVAL_MS = 60_000;
const maintenanceSchedulerDisabled =
  process.env.GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER?.trim().toLowerCase() === "true";
const IMPROVEMENT_WEEKLY_DEDUP_SETTING_KEY = "improvement_weekly_last_week_key_v1";
const MEMORY_FLUSH_HISTORY_DAYS = 30;
const COST_REPORT_LOOKBACK_HOURS = 1;
const COST_REPORT_OUTPUT_DIR = "artifacts/cost-reports";
const UPDATE_REVIEW_OUTPUT_DIR = "artifacts/update-review";
const IMPROVEMENT_TUNE_KEY_BLOCKER_TEMPLATE = "improvement_tune_blocker_template_v1";
const IMPROVEMENT_TUNE_KEY_RETRY_THRESHOLD = "improvement_tune_retry_threshold_v1";
const IMPROVEMENT_TUNE_KEY_LIVE_INTENT = "improvement_tune_live_intent_threshold_v1";
const IMPROVEMENT_TUNE_KEY_REFUSAL_STYLE = "improvement_tune_refusal_style_v1";
const IMPROVEMENT_REPAIR_POLICY_CONFIG_SETTING_KEY = "improvement_repair_policy_config_v1";
const IMPROVEMENT_ROUTING_POLICY_CONFIG_SETTING_KEY = "improvement_routing_policy_config_v1";
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
export const DEFAULT_WORKSPACE_ID = "default";
const REPLAY_SCRATCH_SESSION_TITLE_PREFIX = "[Replay scratch]";
export const GUIDANCE_DOC_FILE_MAP: Record<GuidanceDocType, string> = {
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

interface ChatDelegationProgressStatusEvent {
  runId: string;
  taskId: string;
  message: string;
}

interface ChatDelegationProgressCallbacks {
  onStatus?: (event: ChatDelegationProgressStatusEvent) => Promise<void> | void;
  onStep?: (step: ChatDelegationStepRecord) => Promise<void> | void;
}

interface NormalizedDelegationStep {
  stepId: string;
  index: number;
  role: string;
  parallelizable: boolean;
  dependsOnStepIds: string[];
}

interface DelegationStepExecutionResult {
  step: ChatDelegationStepRecord;
  output?: string;
  citations: ChatCitationRecord[];
  trace?: ChatTurnTraceRecord["routing"];
  completed: boolean;
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

export interface ResolvedRuntimeGuidance {
  workspaceId: string;
  systemInstruction?: string;
  globalFilesUsed: string[];
  workspaceFilesUsed: string[];
  truncated: boolean;
}

export class ChatTurnCancelledError extends GoatError {
  readonly code = "TURN_CANCELLED" as const;
  readonly httpStatus = 499;
  public constructor(
    public readonly turnId: string,
    message = "Chat turn cancelled.",
  ) {
    super(message, { turnId });
  }
}

const VALID_TOOL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

function isValidToolName(name: string): boolean {
  return VALID_TOOL_NAME_PATTERN.test(name);
}

export function isChatTurnCancelledError(error: unknown): boolean {
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

export type PersistableChatStreamChunk = ChatStreamChunkDraft extends infer T
  ? T extends { turnId?: string }
    ? T & { turnId: string }
    : never
  : never;

export type InspectableChatStreamChunk = ChatStreamChunk | ChatStreamChunkDraft;

export function isPersistableChatStreamChunk(chunk: ChatStreamChunkDraft): chunk is PersistableChatStreamChunk {
  return typeof chunk.turnId === "string" && chunk.turnId.length > 0;
}

export interface PreparedChatExecutionPlanResolution {
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

export interface DurableChatTurnExecutionPayload {
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
  userInputResponses?: DurableChatTurnUserInputResumeRecord[];
}

export interface DurableChatTurnUserInputResumeRecord {
  promptId: string;
  kind: "single_select" | "text";
  title?: string;
  question: string;
  answeredAt: string;
  response: ChatUserInputPromptResponse;
  selectedOption?: {
    optionId: string;
    label: string;
    description?: string;
  };
}

export interface RemoteApprovalActionTokenIssueResult extends RemoteActionTokenRecord {
  approvalId: string;
  token: string;
}

const CHAT_COMPACTION_RECENT_TURN_LIMIT = 6;
const CHAT_COMPACTION_WINDOW_SIZE = 8;
const CHAT_COMPACTION_TRIGGER_TOKENS = 2200;
const CHAT_COMPACTION_SUMMARY_TOKEN_BUDGET = 360;
export const CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT = 3;
export const CHAT_PLANNER_MAX_STEPS = 8;
export const CHAT_PLANNER_MIN_STEPS = 3;
const FOLLOW_ON_PARITY_ARTIFACTS_SETTING_KEY = "follow_on_parity_artifacts_v1";
const FOLLOW_ON_PARITY_ARTIFACT_FRESHNESS_WINDOW_DAYS = 7;

function normalizeFollowOnParityArtifactIndex(value: unknown): FollowOnProofLaneArtifactIndex {
  if (!value || typeof value !== "object") {
    return {};
  }
  const normalized: FollowOnProofLaneArtifactIndex = {};
  for (const laneId of ["browser", "packaging", "a2ui", "voice", "companion", "extensions"] as const) {
    const artifact = normalizeFollowOnParityArtifactRecord(laneId, (value as Record<string, unknown>)[laneId]);
    if (artifact) {
      normalized[laneId] = artifact;
    }
  }
  return normalized;
}

function normalizeFollowOnParityArtifactRecord(
  laneId: FollowOnProofLaneArtifactLaneId,
  value: unknown,
): FollowOnProofLaneArtifactRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const generatedAt = typeof record.generatedAt === "string" ? record.generatedAt : undefined;
  const summary = typeof record.summary === "string" ? record.summary : undefined;
  const relativePath = typeof record.relativePath === "string" ? record.relativePath : undefined;
  const fullPath = typeof record.fullPath === "string" ? record.fullPath : undefined;
  const bytes = typeof record.bytes === "number" && Number.isFinite(record.bytes) ? record.bytes : undefined;
  const proofState =
    record.proofState === "draft" || record.proofState === "complete" || record.proofState === "evidence"
      ? record.proofState
      : undefined;
  if (!generatedAt || !summary || !relativePath || !fullPath || bytes === undefined) {
    return undefined;
  }
  return {
    laneId,
    generatedAt,
    summary,
    relativePath,
    fullPath,
    bytes,
    proofState,
  };
}

function isCurrentFollowOnParityArtifact(
  artifact: FollowOnProofLaneArtifactRecord | undefined,
  now = new Date(),
  acceptedProofStates?: Array<NonNullable<FollowOnProofLaneArtifactRecord["proofState"]>>,
): boolean {
  if (!artifact) {
    return false;
  }
  if (acceptedProofStates && acceptedProofStates.length > 0) {
    const proofState = artifact.proofState ?? "complete";
    if (!acceptedProofStates.includes(proofState)) {
      return false;
    }
  }
  const generatedAt = Date.parse(artifact.generatedAt);
  if (!Number.isFinite(generatedAt)) {
    return false;
  }
  const ageDays = Math.floor((now.getTime() - generatedAt) / (1000 * 60 * 60 * 24));
  return ageDays <= FOLLOW_ON_PARITY_ARTIFACT_FRESHNESS_WINDOW_DAYS;
}

function buildFollowOnProfileCoverage(input: {
  currentProfiles: DeploymentProfile[];
  staleProfiles?: DeploymentProfile[];
}): FollowOnProfileCoverageRecord {
  const knownProfiles: DeploymentProfile[] = ["local_dev", "trusted_local", "remote_hardened"];
  const uniqueCurrent = knownProfiles.filter((profile) => input.currentProfiles.includes(profile));
  const uniqueStale = knownProfiles.filter(
    (profile) => !uniqueCurrent.includes(profile) && Boolean(input.staleProfiles?.includes(profile)),
  );
  return {
    currentProfiles: uniqueCurrent,
    staleProfiles: uniqueStale,
    missingProfiles: knownProfiles.filter(
      (profile) => !uniqueCurrent.includes(profile) && !uniqueStale.includes(profile),
    ),
  };
}

function applyDurableExecutionBaselineToConfig(config: GatewayRuntimeConfig): GatewayRuntimeConfig {
  return {
    ...config,
    assistant: {
      ...config.assistant,
      durable: {
        ...config.assistant.durable,
        enabled: true,
        executionEnabled: true,
        chatAutoPromoteEnabled: true,
      },
      features: {
        ...config.assistant.features,
        durableKernelV1Enabled: true,
      },
    },
  };
}

export class GatewayService {
  /** @internal */ public config: GatewayRuntimeConfig;
  /** @internal */ public readonly storage: Storage;
  private readonly eventIngestService: EventIngestService;
  /** @internal */ public readonly policyEngine: ToolPolicyEngine;
  private readonly skillsService: SkillsService;
  /** @internal */ public readonly orchestrationEngine: OrchestrationEngine;
  /** @internal */ public readonly llmService: LlmService;
  private readonly assemblyService: AssemblyService;
  private readonly memoryContextService: MemoryContextService;
  /** @internal */ public readonly meshService: MeshService;
  /** @internal */ public readonly npuSidecar: NpuSidecarService;
  /** @internal */ public readonly llamaCppRuntime: LlamaCppRuntimeService;
  private readonly approvalExplainer: ApprovalExplainerService;
  /** @internal */ public readonly turnRuntime: TurnRuntime;
  private readonly researchService: ResearchService;
  private readonly obsidianVaultService: ObsidianVaultService;
  private readonly skillImportService: SkillImportService;
  /** @internal */ public readonly cronAutomationService: CronAutomationService;
  private readonly addonsService: AddonsService;
  private readonly devDiagnostics: GatewayDevDiagnosticsService;
  /** @internal */ public readonly discordRuntimeService: DiscordRuntimeService;
  private readonly chatProjectService: ChatProjectService;
  /** @internal */ public readonly durableRunService: DurableRunService;
  private readonly durableWorkflowRegistry: durableExecutionService.DurableWorkflowExecutorRegistry;
  /** @internal */ public readonly hooksService: HooksService;
  /** @internal */ public readonly approvalWaitRunService: ApprovalWaitRunService;
  /** @internal */ public readonly approvalEffectsService: ApprovalEffectsService;
  private readonly approvalRuntime: ApprovalRuntimeService;
  private readonly chatTurnRuntime: ChatTurnRuntimeService;
  private readonly toolInvocationCoordinator: ToolInvocationCoordinatorService;
  private readonly runtimeLifecycleReadService: RuntimeLifecycleReadService;
  private readonly chatLearnedMemoryService: ChatLearnedMemoryService;
  private readonly promptPackService: PromptPackService;
  /** @internal */ public readonly chatProactiveService: ChatProactiveService;
  private readonly improvementService: ImprovementService;
  private readonly memoryMaintenanceService: MemoryMaintenanceService;
  /** @internal */ public readonly memoryLifecycleService: MemoryLifecycleService;
  private readonly capabilitySystemService: CapabilitySystemService;
  private readonly backupRetentionService: BackupRetentionService;
  private readonly databaseCutoverService: DatabaseCutoverService;
  private readonly mediaVoiceService: MediaVoiceService;
  /** @internal */ public readonly chatTurnExecutionRegistry = new ChatTurnExecutionRegistry();
  private readonly realtime = new EventEmitter();
  /** @internal */ public readonly backgroundTasks = new Set<Promise<void>>();
  private readonly warnedOutsideRootPathFingerprints = new Set<string>();
  private readonly chatMessageProjectionBackfillAttempted = new Set<string>();
  /** @internal */ public readonly recentChannelSetupTests = new Map<string, ChannelSetupRecentTestCacheEntry>();
  private lastChatStreamPurgeAt = 0;
  /** @internal */ public readonly operatorSummaryCache = new OperatorSummaryCache(15_000);
  /** @internal */ public readonly onboardingMarkerPath: string;
  private maintenanceScheduler?: NodeJS.Timeout;
  private closing = false;
  /** @internal */ public onboardingMarker: { completedAt?: string; completedBy?: string } = {};
  private criticalInitComplete = false;
  private deferredInitPromise?: Promise<void>;

  /** @internal */ public get gatewaySql() {
    return this.storage.gatewaySql;
  }

  public constructor(inputConfig: GatewayRuntimeConfig) {
    this.config = applyDurableExecutionBaselineToConfig(inputConfig);
    const config = this.config;
    this.storage = createGatewayStorage(config);
    this.enforceDurableExecutionBaseline();
    this.onboardingMarkerPath = path.resolve(config.rootDir, config.assistant.dataDir, "onboarding-state.json");
    this.devDiagnostics = new GatewayDevDiagnosticsService(
      resolveDevDiagnosticsEnabled(),
      undefined,
      resolveDevDiagnosticsVerbose(),
      resolveDevDiagnosticsBufferSize(process.env.GOATCITADEL_DEV_DIAGNOSTICS_GATEWAY_BUFFER),
    );

    this.backupRetentionService = new BackupRetentionService({
      storage: this.storage,
      config,
    });
    this.databaseCutoverService = new DatabaseCutoverService({
      config,
      createBackup: (input) => this.backupRetentionService.createBackup(input),
      persistAssistantConfig: () => this.persistAssistantConfig(),
    });
    this.mediaVoiceService = new MediaVoiceService({
      gatewaySql: this.gatewaySql,
      storage: this.storage,
      backgroundTasks: this.backgroundTasks,
      isClosing: () => this.closing,
      publishRealtime: (eventType, source, payload) => {
        this.publishRealtime(eventType, source, payload);
      },
      recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
      readChatAttachmentContent: (id) => this.readChatAttachmentContent(id),
      getChatAttachment: (id) => this.getChatAttachment(id),
    });
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
    this.capabilitySystemService = new CapabilitySystemService({
      rootDir: config.rootDir,
      runtimeConfig: config.assistant.capabilities,
      storage: this.storage,
      readFeatureFlags: () => this.readFeatureFlags(),
      listToolCatalog: () => this.listToolCatalog(),
      listLoadedSkills: () => this.skillsService.list(),
      readSkillStates: () => this.readSkillStates(),
      invokeTool: (request) => this.invokeTool(request),
      createApproval: (input) => this.createApproval(input),
      publishRealtime: (eventType, source, payload) => {
        this.publishRealtime(eventType, source, payload);
      },
      readPolicySnapshot: () => ({
        toolPolicy: this.config.toolPolicy,
        features: this.readFeatureFlags(),
      }),
    });
    this.orchestrationEngine = new OrchestrationEngine();
    this.llmService = new LlmService(config.llm, process.env, {
      networkAllowlist: config.toolPolicy.sandbox.networkAllowlist,
      enforceNetworkAllowlist: config.toolPolicy.tools.profile !== "danger",
      secretStore,
    });
    this.assemblyService = new AssemblyService({
      storage: this.storage,
      rootDir: config.rootDir,
      createChatCompletion: (request) => this.createChatCompletion(request),
      publishRealtime: (eventType, source, payload) => {
        this.publishRealtime(eventType, source, payload);
      },
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
    this.llamaCppRuntime = new LlamaCppRuntimeService({
      rootDir: config.rootDir,
      config: config.assistant.llamaCpp,
      onEvent: (eventType, payload) => {
        this.publishRealtime(eventType, "llamacpp", payload);
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
    this.turnRuntime = new GatewayTurnRuntime({
      storage: this.storage,
      listToolCatalog: () => this.listToolCatalog(),
      createChatCompletion: (request) => this.createChatCompletion(request),
      createChatCompletionStream: (request) => this.createChatCompletionStream(request),
      invokeTool: (request) => this.invokeTool(request),
      persistToolArtifact: (input) => this.persistChatToolArtifact(input),
      evaluateToolAccess: (request) => this.policyEngine.evaluateAccess(request),
      invokeMcpTool: (request) => this.invokeMcpTool(request),
      listMcpBrowserFallbackTargets: () => this.listMcpBrowserFallbackTargets(),
      toolLoopDetection: this.config.toolPolicy.tools.loopDetection,
    });
    this.researchService = new ResearchService({
      storage: this.storage,
      invokeTool: (request) => this.invokeTool(request),
      createChatCompletion: (request) => this.createChatCompletion(request),
    });
    this.obsidianVaultService = new ObsidianVaultService(this.storage.systemSettings);
    this.skillImportService = new SkillImportService(config.rootDir, this.storage.systemSettings);
    this.addonsService = new AddonsService(config.rootDir);
    this.discordRuntimeService = new DiscordRuntimeService({
      listConnections: () => this.storage.integrationConnections.list(undefined, 1000),
      findApprovedPairing: (connectionId, userId) => this.findApprovedDiscordPairing(connectionId, userId),
      ensurePendingPairing: (connectionId, userId, displayName) =>
        this.ensurePendingDiscordPairing(connectionId, userId, displayName),
      touchPairing: (pairingId) => this.touchDiscordPairing(pairingId),
      onInboundMessage: (input) => this.handleDiscordRuntimeInbound(input),
      onSlashCommand: (input) => this.handleDiscordRuntimeSlashCommand(input),
      listModelSuggestions: (query, limit) => this.listChatModelSuggestions(query, limit),
      publishDiagnostic: (event, message, context) => {
        this.recordDevDiagnostic({
          level: context.error ? "warn" : "info",
          category: "channels",
          event,
          message,
          context,
        });
      },
    });
    this.cronAutomationService = new CronAutomationService({
      storage: this.storage,
      persistCronJobsConfig: () => this.persistCronJobsConfig(),
      publishRealtime: (eventType, source, payload) => {
        this.publishRealtime(eventType, source, payload ?? {});
      },
      requireFeatureEnabled: (flag) => this.requireFeatureEnabled(flag),
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag),
      runHandlers: {
        task: async (job) => {
          const task = this.createTask({
            title: job.name,
            description: [
              job.description?.trim() || "Scheduled task created by cron job.",
              "",
              `Cron job: ${job.jobId}`,
              `Triggered at: ${new Date().toISOString()}`,
            ].join("\n"),
            status: "inbox",
            priority: "normal",
            createdBy: "scheduler",
          });
          return { taskId: task.taskId };
        },
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
        updateReview: async () => {
          await this.runUpdateReviewSchedulerIfDue({ force: true });
        },
      },
    });

    // ── extracted sub-services and narrowed runtime contexts ─────
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const serviceCtx: ServiceContext = buildGatewayServiceContext({
      storage: this.storage,
      config: this.config,
      llmService: this.llmService,
      policyEngine: this.policyEngine,
      publishRealtime: (eventType, source, payload, options) => {
        this.publishRealtime(eventType, source, payload, options);
      },
      requireFeatureEnabled: (flag) => this.requireFeatureEnabled(flag),
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag),
      normalizeWorkspaceId: (workspaceId) => this.normalizeWorkspaceId(workspaceId),
    });
    this.chatProjectService = new ChatProjectService(serviceCtx);
    this.durableRunService = new DurableRunService(serviceCtx, {
      backgroundTasks: this.backgroundTasks,
      workflowRegistry: {
        executeWorkflow: (run) => this.durableWorkflowRegistry.executeWorkflow(run),
        isWorkflowRecoverable: (run) => this.durableWorkflowRegistry.isWorkflowRecoverable(run),
        markWorkflowUnrecoverable: (run, reason) => this.durableWorkflowRegistry.markWorkflowUnrecoverable(run, reason),
      },
      onRunFailed: async (run, message) => {
        this.improvementService.recordDurableRunFailureSignal({
          run,
          message,
        });
      },
    });
    this.hooksService = new HooksService(serviceCtx, {
      createDurableRun: (input) => this.durableRunService.createDurableRun(input),
      requestDurableRunProcessing: (runId) => this.durableRunService.requestRunProcessing(runId),
    });
    this.approvalWaitRunService = new ApprovalWaitRunService(serviceCtx, {
      createDurableRun: (input) => this.createDurableRun(input),
      getDurableRun: (runId) => this.getDurableRun(runId),
      getRequestAttribution,
    });
    this.chatLearnedMemoryService = new ChatLearnedMemoryService(serviceCtx);
    this.promptPackService = new PromptPackService(serviceCtx, {
      createChatSession: (input) => this.createChatSession(input),
      agentSendChatMessage: (sessionId, input) => this.agentSendChatMessage(sessionId, input),
      createChatCompletion: (request) => this.createChatCompletion(request),
      getPromptRunnerModelDefaults: () => this.getPromptRunnerModelDefaults(),
      getPromptJudgeModelDefaults: () => this.getPromptJudgeModelDefaults(),
      backgroundTasks: this.backgroundTasks,
      recordImprovementBenchmarkSignal: (input) => {
        this.improvementService.recordPromptLabBenchmarkCompletionSignal(input);
      },
      recordImprovementRegressionSignal: (input) => {
        this.improvementService.recordPromptLabRegressionCompletionSignal(input);
      },
    });
    this.chatProactiveService = new ChatProactiveService(serviceCtx, {
      listChatSessions: (query) => this.listChatSessions(query),
      getSession: (sessionId) => this.getSession(sessionId),
      hasRunningTurn: (sessionId) => this.hasRunningTurn(sessionId),
      getSessionIdleSeconds: (sessionId) => this.getSessionIdleSeconds(sessionId),
      listChatMessages: (sessionId, limit) => this.listChatMessages(sessionId, limit),
      invokeTool: (request) => this.invokeTool(request),
      detectDelegationRoles: (text) => detectDelegationRoles(text),
      createDurableRun: (input) => this.createDurableRun(input),
      requestDurableRunProcessing: (runId) => this.durableRunService.requestRunProcessing(runId),
      backgroundTasks: this.backgroundTasks,
      get closing() {
        return self.closing;
      },
    });
    this.approvalEffectsService = new ApprovalEffectsService(serviceCtx, {
      backgroundTasks: this.backgroundTasks,
      wakeDurableRun: (runId, event) => this.wakeDurableRun(runId, event),
      requestRunProcessing: (runId) => this.durableRunService.requestRunProcessing(runId),
      findProactiveDurableRunIdsForApproval: (approvalId) => this.findProactiveDurableRunIdsForApproval(approvalId),
      executeCodeModePendingApproval: (approvalId, signal) => this.executeCodeModePendingApproval(approvalId, signal),
      executeApprovedPendingAction: (approvalId, signal) => this.policyEngine.executeApprovedAction(approvalId, signal),
      enqueueAfterHooks: (input) => this.hooksService.enqueueAfterHooks(input),
      resolveApprovalHookWorkspaceId: (payload) => this.resolveApprovalHookWorkspaceId(payload),
    });
    this.approvalRuntime = new ApprovalRuntimeService({
      storage: this.storage,
      policyEngine: this.policyEngine,
      hooksService: this.hooksService,
      approvalWaitRunService: this.approvalWaitRunService,
      publishRealtime: (eventType, source, payload, options) =>
        this.publishRealtime(eventType, source, payload, options),
      requireConnectorRecord: (connectorId) => this.requireConnectorRecord(connectorId),
      consumeRemoteActionToken: (token, actionType) => this.consumeRemoteActionToken(token, actionType),
      consumeRemoteActionTokenById: (tokenId, actionType) => this.consumeRemoteActionTokenById(tokenId, actionType),
      resolveApproval: (approvalId, input) => this.approvalRuntime.resolveApproval(approvalId, input),
      resolveDeviceAccessApproval: (current, input) => this.resolveDeviceAccessApproval(current, input),
      executeCodeModePendingApproval: (approvalId, signal) => this.executeCodeModePendingApproval(approvalId, signal),
      resolveApprovalHookWorkspaceId: (payload) => this.resolveApprovalHookWorkspaceId(payload),
      parseApprovalCreateHookPatch: (value) => this.parseApprovalCreateHookPatch(value as Record<string, unknown>),
      scheduleApprovalExplanation: (approval) => this.scheduleApprovalExplanation(approval),
      findProactiveDurableRunIdsForApproval: (approvalId) => this.findProactiveDurableRunIdsForApproval(approvalId),
      wakeDurableRun: (runId, event) => this.wakeDurableRun(runId, event),
      recordApprovalResolution: (approval, input) => this.recordApprovalResolution(approval, input),
      enqueueApprovalResolutionEffects: (approval, input) => this.enqueueApprovalResolutionEffects(approval, input),
      enqueueApprovalRemoteTokenDelivery: (approval, connector, tokenRecord) =>
        this.enqueueApprovalRemoteTokenDelivery(approval, connector, tokenRecord),
    });
    this.chatTurnRuntime = new ChatTurnRuntimeService(this);
    this.toolInvocationCoordinator = new ToolInvocationCoordinatorService({
      approvalInbox: this.storage.approvalInbox,
      policyEngine: this.policyEngine,
      hooksService: this.hooksService,
      normalizeToolInvokeRequest: (request) =>
        this.applyRuntimeBrowserBackendDefaults(
          this.resolveToolInvokeRequestPaths({
            ...request,
            workspaceId:
              request.workspaceId ??
              this.storage.chatSessionMeta.get(request.sessionId)?.workspaceId ??
              DEFAULT_WORKSPACE_ID,
          }),
        ),
      isValidToolName: (name) => isValidToolName(name),
      evaluateToolDeploymentGuard: (request) =>
        evaluateDeploymentProfileToolAccess(this.config.assistant.deploymentProfile, request.toolName, request.args),
      resolveToolHookWorkspaceId: (request) => this.resolveToolHookWorkspaceId(request),
      parseToolCallHookPatch: (value) => this.parseToolCallHookPatch(value),
      primeToolApprovalLifecycle: (approvalId, request) =>
        this.primeApprovalLifecycle(
          approvalId,
          this.buildApprovalLinkage({
            sessionId: request.sessionId,
            taskId: request.taskId,
            toolName: request.toolName,
            actionType: "tool.invoke",
          }),
        ),
      scheduleApprovalExplanationById: (approvalId) => this.scheduleApprovalExplanationById(approvalId),
      publishRealtime: (eventType, source, payload, options) =>
        this.publishRealtime(eventType, source, payload, options),
      requireMcpServer: (serverId) => this.requireMcpServer(serverId),
      listMcpTools: (serverId) => this.listMcpTools(serverId),
      matchesWildcard: (value, pattern) => wildcardMatch(value, pattern),
      isMcpToolApproved: (serverId, toolName) => this.isMcpToolApproved(serverId, toolName),
      invokeMcpRuntimeTool: (server, input) => invokeMcpRuntimeTool(server, input),
      resolveApprovalWithRemoteTokenId: (input) => this.resolveApprovalWithRemoteTokenId(input),
      applyMcpRedaction: (output, mode) => applyMcpRedaction(output, mode),
    });
    this.runtimeLifecycleReadService = new RuntimeLifecycleReadService({
      getApproval: (approvalId) => this.storage.approvals.get(approvalId),
      getApprovalWaitRunId: (approvalId) => this.storage.approvalWaitRuns.getRunId(approvalId),
      getDurableRun: (runId) => this.storage.durableRuns.getRun(runId),
      findDurableRunMaybe: (runId) => this.findDurableRunMaybe(runId),
      findTask: (taskId) => this.storage.tasks.find(taskId),
      getTurnTrace: (turnId) => this.storage.chatTurnTraces.get(turnId),
      listHydratedChatTurnTraces: (sessionId, limit) => this.listHydratedChatTurnTraces(sessionId, limit),
      listChatExecutionPlans: (sessionId, limit) => this.storage.chatExecutionPlans.listBySession(sessionId, limit),
      listChatDelegationRuns: (sessionId, limit) => this.storage.chatDelegationRuns.listBySession(sessionId, limit),
      listChatDelegationSteps: (runId) => this.storage.chatDelegationSteps.listByRun(runId),
      getSession: (sessionId) => this.getSession(sessionId),
      getSessionSummary: (sessionId) => this.getSessionSummary(sessionId),
      listChatSessionProactiveRuns: (sessionId, limit) => this.listChatSessionProactiveRuns(sessionId, limit),
      listApprovalEffects: (approvalId) => this.approvalEffectsService.listByApproval(approvalId),
    });
    this.improvementService = new ImprovementService(serviceCtx, {
      createApproval: (input) => this.createApproval(input),
      captureRepairPolicySnapshot: (targetKey) => this.captureRepairPolicySnapshot(targetKey),
      applyRepairPolicyCandidate: (targetKey, revisionRef) => this.applyRepairPolicyCandidate(targetKey, revisionRef),
      restoreRepairPolicySnapshot: (snapshotRef) => this.restoreRepairPolicySnapshot(snapshotRef),
      captureRoutingPolicySnapshot: (targetKey) => this.captureRoutingPolicySnapshot(targetKey),
      applyRoutingPolicyCandidate: (targetKey, revisionRef) => this.applyRoutingPolicyCandidate(targetKey, revisionRef),
      restoreRoutingPolicySnapshot: (snapshotRef) => this.restoreRoutingPolicySnapshot(snapshotRef),
      createChatCompletion: (request) => this.createChatCompletion(request),
      getPromptRunnerModelDefaults: () => this.getPromptRunnerModelDefaults(),
      readTranscriptOrEmpty: (sessionId) => this.readTranscriptOrEmpty(sessionId),
      retryChatTurn: (sessionId, turnId, overrides) => this.retryChatTurnInScratchSession(sessionId, turnId, overrides),
      backgroundTasks: this.backgroundTasks,
      get closing() {
        return self.closing;
      },
    });
    this.memoryMaintenanceService = new MemoryMaintenanceService(serviceCtx, {
      createDurableRun: (input) => this.createDurableRun(input),
      getDurableRun: (runId) => this.getDurableRun(runId),
    });
    this.memoryLifecycleService = new MemoryLifecycleService({
      context: this.memoryContextService,
      learned: this.chatLearnedMemoryService,
      maintenance: this.memoryMaintenanceService,
      admin: {
        gatewaySql: this.gatewaySql,
        tryParseJson: (raw, fallback) => this.tryParseJson(raw, fallback),
        requireFeatureEnabled: (flag) => this.requireFeatureEnabled(flag as keyof RuntimeSettings["features"]),
        publishRealtime: (channel, topic, payload) => {
          this.publishRealtime(channel, topic, payload);
        },
      },
      files: {
        rootDir: config.rootDir,
        workspaceDir: config.assistant.workspaceDir,
        writeJailRoots: config.toolPolicy.sandbox.writeJailRoots,
        normalizeRelativePath: (relativePath) => this.normalizeRelativePath(relativePath),
      },
      resolveLearnedMemoryPolicy: (sessionId) => {
        if (this.isReplayScratchSession(sessionId)) {
          return {
            allowWrite: false,
            reason: "replay_scratch" as const,
          };
        }
        const prefs = this.storage.chatSessionPrefs.ensure(sessionId);
        return {
          allowWrite: prefs.memoryMode !== "off",
          memoryMode: prefs.memoryMode,
          reason: prefs.memoryMode === "off" ? ("memory_mode_off" as const) : ("allowed" as const),
        };
      },
      readTranscriptOrEmpty: (sessionId) => this.readTranscriptOrEmpty(sessionId),
    });
    this.durableWorkflowRegistry = durableExecutionService.createDurableWorkflowExecutorRegistry(
      durableExecutionService.buildDurableWorkflowExecutors({
        memoryMaintenance: {
          storage: this.storage,
          memoryLifecycleService: this.memoryLifecycleService,
          publishRealtime: (eventType, source, payload, options) => {
            this.publishRealtime(eventType, source, payload, options);
          },
          recordDurableTimelineEvent: (runId, eventType, payload) =>
            this.recordDurableTimelineEvent(runId, eventType, payload),
          recordImprovementDurableRunCompletion: (run, checkpointState) =>
            this.recordImprovementDurableRunCompletion(run, checkpointState),
        },
        chatTurn: this.buildDurableChatTurnWorkflowHost(),
        proactiveTick: {
          chatProactiveService: this.chatProactiveService,
          gatewaySql: this.gatewaySql,
          listChatSessionProactiveRuns: (sessionId, limit) => this.listChatSessionProactiveRuns(sessionId, limit),
          publishRealtime: (eventType, source, payload, options) => {
            this.publishRealtime(eventType, source, payload, options);
          },
        },
        approvalWait: {
          storage: this.storage,
          publishRealtime: (eventType, source, payload, options) => {
            this.publishRealtime(eventType, source, payload, options);
          },
          recordDurableTimelineEvent: (runId, eventType, payload) =>
            this.recordDurableTimelineEvent(runId, eventType, payload),
          recordImprovementDurableRunCompletion: (run, checkpointState) =>
            this.recordImprovementDurableRunCompletion(run, checkpointState),
        },
        connectorDelivery: {
          storage: this.storage,
          requireConnectorRecord: (connectorId) => this.requireConnectorRecord(connectorId),
          commsSend: (input) => this.commsSend(input),
          commsReply: (input) => this.commsReply(input),
          commsReact: (input) => this.commsReact(input),
          commsUnsend: (input) => this.commsUnsend(input),
          commsTyping: (input) => this.commsTyping(input),
          invokeMcpTool: (input) => this.invokeMcpTool(input),
          publishRealtime: (eventType, source, payload, options) => {
            this.publishRealtime(eventType, source, payload, options);
          },
          recordDurableTimelineEvent: (runId, eventType, payload) =>
            this.recordDurableTimelineEvent(runId, eventType, payload),
          recordImprovementDurableRunCompletion: (run, checkpointState) =>
            this.recordImprovementDurableRunCompletion(run, checkpointState),
        },
        hookDelivery: {
          storage: this.storage,
          hooksService: this.hooksService,
          durableRunService: this.durableRunService,
          computeDurableRetryDelayMs: (current, attemptNo) => this.computeDurableRetryDelayMs(current, attemptNo),
          publishRealtime: (eventType, source, payload, options) => {
            this.publishRealtime(eventType, source, payload, options);
          },
          recordDurableTimelineEvent: (runId, eventType, payload) =>
            this.recordDurableTimelineEvent(runId, eventType, payload),
          recordImprovementDurableRunCompletion: (run, checkpointState) =>
            this.recordImprovementDurableRunCompletion(run, checkpointState),
        },
        orchestration: {
          storage: this.storage,
          durableRunService: this.durableRunService,
          publishRealtime: (eventType, source, payload, options) => {
            this.publishRealtime(eventType, source, payload, options);
          },
          recordDurableTimelineEvent: (runId, eventType, payload) =>
            this.recordDurableTimelineEvent(runId, eventType, payload),
          recordImprovementDurableRunCompletion: (run, checkpointState) =>
            this.recordImprovementDurableRunCompletion(run, checkpointState),
          executeDurableOrchestrationRun: (run, context) => this.executeDurableOrchestrationRun(run, context),
        },
      }),
    );
  }

  public isDevDiagnosticsEnabled(): boolean {
    return this.devDiagnostics.isEnabled();
  }

  private buildDurableChatTurnWorkflowHost(): durableExecutionService.DurableChatTurnWorkflowHost {
    return {
      config: this.config,
      storage: this.storage,
      backgroundTasks: this.backgroundTasks,
      turnRuntime: this.turnRuntime,
      resolvePreparedTurnOrchestration: (prepared) => this.resolvePreparedTurnOrchestration(prepared),
      createChatCompletion: (request) => this.createChatCompletion(request),
      recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
      buildChatOrchestrationSummary: (input) => this.buildChatOrchestrationSummary(input),
      createChatSession: (input) => this.createChatSession(input),
      inheritDelegatedSessionToolGrants: (sessionId, delegatedSessionId) =>
        this.inheritDelegatedSessionToolGrants(sessionId, delegatedSessionId),
      updateChatSessionPrefs: (sessionId, input) => this.updateChatSessionPrefs(sessionId, input),
      agentSendChatMessage: (sessionId, input) => this.agentSendChatMessage(sessionId, input),
      beginActiveChatTurnExecution: (sessionId, turnId, operation) =>
        this.beginActiveChatTurnExecution(sessionId, turnId, operation),
      endActiveChatTurnExecution: (turnId, controller) => this.endActiveChatTurnExecution(turnId, controller),
      ingestEvent: (idempotencyKey, payload) => this.ingestEvent(idempotencyKey, payload),
      updateActiveLeafOrThrow: (sessionId, previousActiveTurnId, nextActiveTurnId) =>
        this.updateActiveLeafOrThrow(sessionId, previousActiveTurnId, nextActiveTurnId),
      collectCapabilityUpgradeSuggestions: (input) => this.collectCapabilityUpgradeSuggestions(input),
      collectSpecialistCandidateSuggestions: (input) => this.collectSpecialistCandidateSuggestions(input),
      publishRealtime: (channel, topic, payload, options) => this.publishRealtime(channel, topic, payload, options),
      extractAndPersistLearnedMemory: (sessionId, content, source) =>
        this.extractAndPersistLearnedMemory(sessionId, content, source),
      scheduleChatMemoryContextPrewarm: (input) => this.scheduleChatMemoryContextPrewarm(input),
      scheduleMemoryMaintenancePostTurnEvaluation: (sessionId, parentTurnId) =>
        this.scheduleMemoryMaintenancePostTurnEvaluation(sessionId, parentTurnId),
      recordCapabilityGapFromTrace: (input) => this.recordCapabilityGapFromTrace(input),
      markChatTurnCancelled: (sessionId, turnId) => this.markChatTurnCancelled(sessionId, turnId),
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag as keyof RuntimeSettings["features"]),
      streamPersistedChatTurnEvents: (sessionId, turnId, options) =>
        this.streamPersistedChatTurnEvents(sessionId, turnId, options),
      persistChatStreamChunk: (chunk, durableRunId) => {
        if (!chunk.turnId) {
          throw new Error("Persistable chat stream chunk is missing a turn id.");
        }
        this.persistChatStreamChunk(chunk as PersistableChatStreamChunk, durableRunId);
      },
      createHydratedChatTurnTrace: (turnId, trace) => this.createHydratedChatTurnTrace(turnId, trace),
      finalizeDurableChatRun: (runId, prepared, trace) => this.finalizeDurableChatRun(runId, prepared, trace),
      completeActiveChatTurnStream: (turnId) => this.completeActiveChatTurnStream(turnId),
      closeActiveChatTurnStream: (turnId) => this.closeActiveChatTurnStream(turnId),
      beginDurableChatRun: (prepared, input, threadEventType) =>
        this.beginDurableChatRun(prepared, input, threadEventType),
      registerActiveChatTurnStream: (sessionId, turnId, durableRunId) =>
        this.registerActiveChatTurnStream(sessionId, turnId, durableRunId),
      ensureSessionInternalToolGrant: (sessionId, toolName, reason) =>
        this.ensureSessionInternalToolGrant(sessionId, toolName, reason),
      requireExecutedToolResult: (toolName, result) => this.requireExecutedToolResult(toolName, result),
      commsSend: (input) => this.commsSend(input),
      prepareAgentChatTurn: (sessionId, input, options) => this.prepareAgentChatTurn(sessionId, input, options),
    };
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

  public async getChatToolArtifactContent(artifactId: string): Promise<{
    artifact: {
      artifactId: string;
      sessionId: string;
      turnId: string;
      toolRunId: string;
      toolName: string;
      contentType?: string;
      byteLength: number;
      snippet?: string;
      storageRelPath: string;
      createdAt: string;
    };
    content: string;
  }> {
    const artifact = this.storage.chatToolArtifacts.get(artifactId);
    const artifactRoot = path.resolve(this.config.rootDir, this.config.assistant.dataDir);
    const absolutePath = path.resolve(artifactRoot, artifact.storageRelPath);
    const normalizedRoot = `${artifactRoot}${path.sep}`;
    if (absolutePath !== artifactRoot && !absolutePath.startsWith(normalizedRoot)) {
      throw new ValidationError({ message: "Artifact path escapes the configured data directory." });
    }
    const content = await fs.readFile(absolutePath, "utf8");
    return {
      artifact,
      content,
    };
  }

  public listChatGeneratedArtifacts(
    input: {
      sessionId?: string;
      workspaceId?: string;
      sourceSurface?: ChatGeneratedArtifactSourceSurface;
      kind?: ChatGeneratedArtifactKind;
      limit?: number;
    } = {},
  ): ChatGeneratedArtifactRecord[] {
    return chatGeneratedArtifactService.listChatGeneratedArtifacts(this, input);
  }

  public getChatGeneratedArtifact(artifactId: string): ChatGeneratedArtifactRecord {
    return chatGeneratedArtifactService.getChatGeneratedArtifact(this, artifactId);
  }

  public createChatGeneratedArtifactFromTurn(input: {
    sessionId: string;
    turnId: string;
    supersedeLatest?: boolean;
  }): ChatGeneratedArtifactRecord {
    return chatGeneratedArtifactService.createChatGeneratedArtifactFromTurn(this, input);
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

  public attachDevDiagnosticsLogger(logger: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  }): void {
    this.devDiagnostics.setLogger(logger as never);
  }

  public async init(): Promise<void> {
    await this.initCritical();
    await this.startDeferredInit();
  }

  public async initCritical(): Promise<void> {
    if (this.criticalInitComplete) {
      return;
    }
    await this.loadOnboardingMarker();
    this.applyStoredFeatureFlags();
    this.storage.agentProfiles.seedBuiltins(BUILTIN_AGENT_PROFILES);
    const skills = await this.skillsService.reload();
    this.ensureSkillStates(skills.map((skill) => skill.skillId));
    this.criticalInitComplete = true;
  }

  public startDeferredInit(): Promise<void> {
    if (!this.criticalInitComplete) {
      throw new Error("Gateway critical init must complete before deferred init starts.");
    }
    if (this.deferredInitPromise) {
      return this.deferredInitPromise;
    }
    const task = this.runDeferredInit().catch((error) => {
      log.error("deferred startup failed", error);
      throw error;
    });
    this.deferredInitPromise = task;
    task.catch(() => {});
    this.backgroundTasks.add(task);
    task.finally(() => this.backgroundTasks.delete(task));
    return task;
  }

  private async runDeferredInit(): Promise<void> {
    if (this.closing) {
      return;
    }
    const closedLeaseCount = this.storage.realtimeStreamLeases.closeOpenForNode({
      gatewayNodeId: this.config.assistant.mesh.nodeId,
      closeReason: "process_restart",
    });
    if (closedLeaseCount > 0) {
      log.warn("closed stale realtime stream leases after restart", {
        gatewayNodeId: this.config.assistant.mesh.nodeId,
        closedLeaseCount,
      });
    }
    const flushedTranscriptCount = await this.eventIngestService.flushPendingTranscriptOutbox();
    if (flushedTranscriptCount > 0) {
      log.info("flushed pending transcript outbox entries", {
        flushedTranscriptCount,
      });
    }
    await this.discordRuntimeService.sync();
    this.improvementService.markInterruptedDecisionReplayRuns();
    await this.loadCronJobsFromConfig();
    this.improvementService.ensureWeeklyImprovementCronJob();
    this.ensurePrivateBetaBackupCronJob();
    this.ensureMemoryFlushCronJob();
    this.ensureCostReportCronJob();
    this.ensureUpdateReviewCronJob();
    this.meshService.init();
    await this.npuSidecar.init();
    await this.llamaCppRuntime.init();
    if (this.closing) {
      return;
    }
    // Enforce env-only secret persistence policy on startup.
    this.persistLlmConfig();
    this.persistAssistantConfig();
    this.startProactiveScheduler();
    this.improvementService.startScheduler();
    if (!maintenanceSchedulerDisabled) {
      this.startMaintenanceScheduler();
    }
    this.durableRunService.startWorker();
    this.approvalEffectsService.startWorker();
    this.promptPackService.resumeInterruptedBenchmarkRuns();
    if (isVerboseLoggingEnabled()) {
      log.info("feature flags", { flags: this.readFeatureFlags() });
    } else {
      log.info("runtime ready");
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

  public openRealtimeStreamLease(input: {
    streamName: string;
    clientId: string;
    requestedCursor?: number;
    connectedAt?: string;
  }) {
    return this.storage.realtimeStreamLeases.open({
      streamName: input.streamName,
      clientId: input.clientId,
      gatewayNodeId: this.config.assistant.mesh.nodeId,
      requestedCursor: input.requestedCursor,
      openedAt: input.connectedAt,
    });
  }

  public touchRealtimeStreamLease(input: {
    leaseId: string;
    at?: string;
    requestedCursor?: number;
    lastSentSequence?: number;
    lastEventAt?: string;
  }) {
    return this.storage.realtimeStreamLeases.touch(input);
  }

  public closeRealtimeStreamLease(input: { leaseId: string; closedAt?: string; closeReason?: string }) {
    return this.storage.realtimeStreamLeases.close(input);
  }

  public async ingestEvent(idempotencyKey: string, payload: GatewayEventInput): Promise<GatewayEventResult> {
    const result = await this.eventIngestService.ingest({
      endpoint: "/api/v1/gateway/events",
      idempotencyKey,
      payload,
    });

    this.publishRealtime(
      "session_event",
      "gateway",
      {
        eventId: payload.eventId,
        sessionId: result.session.sessionId,
        sessionKey: result.session.sessionKey,
        actorType: payload.actor.type,
        actorId: payload.actor.id,
        messageRole: payload.message.role,
        taskId: payload.taskId,
        deduped: result.deduped,
      },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: {
          sessionId: result.session.sessionId,
          taskId: payload.taskId,
        },
      },
    );

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

  public listWorkspaceHooks(workspaceId: string, limit = 200): HookRecord[] {
    return this.hooksService.listWorkspaceHooks(this.normalizeWorkspaceId(workspaceId), limit);
  }

  public listWorkspaceHookRuns(workspaceId: string, limit = 200): HookRunRecord[] {
    return this.hooksService.listWorkspaceHookRuns(this.normalizeWorkspaceId(workspaceId), limit);
  }

  public createWorkspaceHook(input: HookCreateInput): HookRecord {
    return this.hooksService.createWorkspaceHook({
      ...input,
      workspaceId: this.normalizeWorkspaceId(input.workspaceId),
    });
  }

  public updateWorkspaceHook(workspaceId: string, hookId: string, input: HookUpdateInput): HookRecord {
    return this.hooksService.updateWorkspaceHook(this.normalizeWorkspaceId(workspaceId), hookId, input);
  }

  public deleteWorkspaceHook(workspaceId: string, hookId: string): boolean {
    return this.hooksService.deleteWorkspaceHook(this.normalizeWorkspaceId(workspaceId), hookId);
  }

  public async listGlobalGuidance(): Promise<GuidanceDocumentRecord[]> {
    const docs = await Promise.all(
      (Object.keys(GUIDANCE_DOC_FILE_MAP) as GuidanceDocType[]).map((docType) =>
        this.readGuidanceDocument(docType, "global"),
      ),
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
          this.readGuidanceDocument(docType, "workspace", normalizedWorkspaceId),
        ),
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

  public async getRuntimeLifecycle(input: {
    sessionId?: string;
    turnId?: string;
    runId?: string;
    approvalId?: string;
    taskId?: string;
  }): Promise<RuntimeLifecycleResponse> {
    return this.runtimeLifecycleReadService.getRuntimeLifecycle(input);
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

  public importChatProject(input: {
    workspaceId?: string;
    name?: string;
    sourceType: "local_folder" | "github_repo";
    sourcePath?: string;
    repoUrl?: string;
    ref?: string;
  }) {
    return this.chatProjectService.importChatProject(input);
  }

  public updateChatProject(
    projectId: string,
    input: {
      workspaceId?: string;
      name?: string;
      description?: string;
      workspacePath?: string;
      color?: string;
    },
  ): ChatProjectRecord {
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
    return chatSessionService.listChatSessions(this, query);
  }

  public createChatSession(input: ChatSessionCreateInput = {}): ChatSessionRecord {
    return chatSessionService.createChatSession(this, input);
  }

  public updateChatSession(
    sessionId: string,
    input: { title?: string; folderId?: string; folderName?: string; tags?: string[] },
  ): ChatSessionRecord {
    return chatSessionService.updateChatSession(this, sessionId, input);
  }

  /** @internal */ public maybeAutoTitleChatSession(sessionId: string, content: string): void {
    chatSessionService.maybeAutoTitleChatSession(this, sessionId, content);
  }

  public pinChatSession(sessionId: string): ChatSessionRecord {
    return chatSessionService.pinChatSession(this, sessionId);
  }

  public unpinChatSession(sessionId: string): ChatSessionRecord {
    return chatSessionService.unpinChatSession(this, sessionId);
  }

  public archiveChatSession(sessionId: string): ChatSessionRecord {
    return chatSessionService.archiveChatSession(this, sessionId);
  }

  public restoreChatSession(sessionId: string): ChatSessionRecord {
    return chatSessionService.restoreChatSession(this, sessionId);
  }

  public async deleteChatSession(sessionId: string): Promise<{ deleted: boolean; sessionId: string }> {
    return chatSessionService.deleteChatSession(this, sessionId);
  }

  public async archiveChatSessionsBulk(input: ChatSessionBulkArchiveInput = {}): Promise<ChatSessionBulkArchiveResult> {
    return chatSessionService.archiveChatSessionsBulk(this, input);
  }

  /** @internal */ public async removeChatSessionStoredFile(storageRelPath: string): Promise<void> {
    const normalized = storageRelPath.trim();
    if (!normalized) {
      return;
    }
    const fullPath = path.resolve(this.config.rootDir, this.config.assistant.workspaceDir, normalized);
    assertWritePathInJail(fullPath, this.config.toolPolicy.sandbox.writeJailRoots);
    await fs.rm(fullPath, { force: true });
  }

  public assignChatSessionProject(sessionId: string, projectId?: string): ChatSessionRecord {
    return chatSessionService.assignChatSessionProject(this, sessionId, projectId);
  }

  public getChatSessionBinding(sessionId: string): ChatSessionBindingRecord | undefined {
    return chatSessionService.getChatSessionBinding(this, sessionId);
  }

  public async getChatSessionWorkbench(
    sessionId: string,
  ): Promise<import("@goatcitadel/contracts").ChatSessionWorkbenchRecord> {
    return chatWorkbenchService.getChatSessionWorkbench(this, sessionId);
  }

  public async createChatSessionWorkbenchWorktree(
    sessionId: string,
    input: { baseRef?: string } = {},
  ): Promise<import("@goatcitadel/contracts").ChatSessionWorkbenchRecord> {
    return chatWorkbenchService.createChatSessionWorkbenchWorktree(this, sessionId, input);
  }

  public async getChatSessionWorkbenchTree(
    sessionId: string,
  ): Promise<import("@goatcitadel/contracts").ChatSessionWorkbenchTreeResponse> {
    return chatWorkbenchService.getChatSessionWorkbenchTree(this, sessionId);
  }

  public async getChatSessionWorkbenchFile(
    sessionId: string,
    relativePath: string,
  ): Promise<import("@goatcitadel/contracts").ChatSessionWorkbenchFileResponse> {
    return chatWorkbenchService.getChatSessionWorkbenchFile(this, sessionId, relativePath);
  }

  public async saveChatSessionWorkbenchFile(
    sessionId: string,
    input: import("@goatcitadel/contracts").ChatSessionWorkbenchSaveFileRequest,
  ): Promise<import("@goatcitadel/contracts").ChatSessionWorkbenchFileResponse> {
    return chatWorkbenchService.saveChatSessionWorkbenchFile(this, sessionId, input);
  }

  public async getChatSessionWorkbenchFileDiff(
    sessionId: string,
    relativePath: string,
  ): Promise<import("@goatcitadel/contracts").ChatSessionWorkbenchFileDiffResponse> {
    return chatWorkbenchService.getChatSessionWorkbenchFileDiff(this, sessionId, relativePath);
  }

  public async getChatSessionWorkbenchDiff(
    sessionId: string,
  ): Promise<import("@goatcitadel/contracts").ChatSessionWorkbenchDiffResponse> {
    return chatWorkbenchService.getChatSessionWorkbenchDiff(this, sessionId);
  }

  public async getChatSessionWorkbenchOutput(
    sessionId: string,
  ): Promise<import("@goatcitadel/contracts").ChatSessionWorkbenchOutputResponse> {
    return chatWorkbenchService.getChatSessionWorkbenchOutput(this, sessionId);
  }

  public setChatSessionBinding(input: {
    sessionId: string;
    transport: "llm" | "integration";
    connectionId?: string;
    target?: string;
    writable?: boolean;
  }): ChatSessionBindingRecord {
    return chatSessionService.setChatSessionBinding(this, input);
  }

  public async respondToExistingChatMessage(
    sessionId: string,
    userMessageId: string,
    input: Partial<ChatSendMessageRequest> & { deliveryReplyToMessageId?: string } = {},
  ): Promise<ChatSendMessageResponse> {
    return this.withChatTurnWriteLease(sessionId, "integration-reply", async () => {
      await this.ensureChatMessageProjection(sessionId);
      const userMessage = this.storage.chatMessages.get(userMessageId);
      if (!userMessage || userMessage.sessionId !== sessionId || userMessage.role !== "user") {
        throw new Error("existing user message was not found in the requested session");
      }
      const binding = this.storage.chatSessionBindings.get(sessionId);
      if (!binding || binding.transport !== "integration" || !binding.connectionId || !binding.target) {
        throw new Error("session is not bound to a writable integration target");
      }
      if (!binding.writable) {
        throw new Error("session binding is not writable");
      }

      const request: ChatSendMessageRequest = {
        content: userMessage.content,
        ...input,
      };
      const prepared = await this.prepareAgentChatTurn(sessionId, request, {
        branchKind: "append",
        existingUserMessage: userMessage,
        ingestUserMessage: false,
      });
      const response = await this.consumePreparedAgentChatTurn(
        sessionId,
        request,
        prepared,
        "chat_thread_turn_appended",
      );
      const assistantContent = response.assistantMessage?.content?.trim();
      if (assistantContent) {
        this.ensureSessionInternalToolGrant(sessionId, "channel.send", "system-integration-reply");
        this.requireExecutedToolResult(
          "channel.send",
          await this.commsSend({
            connectionId: binding.connectionId,
            target: binding.target,
            message: assistantContent,
            replyToMessageId: input.deliveryReplyToMessageId?.trim() || prepared.userEventId,
            sessionId,
            agentId: "assistant",
          }),
        );
      }
      return {
        ...response,
        transport: "integration",
      };
    });
  }

  public async listChatMessages(sessionId: string, limit = 200, cursor?: string): Promise<ChatMessageRecord[]> {
    this.getSession(sessionId);
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    try {
      await this.ensureChatMessageProjection(sessionId);
      return this.storage.chatMessages.list(sessionId, safeLimit, cursor);
    } catch (error) {
      log.warn("chat message projection unavailable, falling back to transcript scan", {
        sessionId,
        error: (error as Error).message,
      });
      return this.listChatMessagesFromTranscript(sessionId, safeLimit, cursor);
    }
  }

  /** @internal */ public async loadChatTurnSessionState(sessionId: string): Promise<{
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
      turnLineageById: new Map(
        traces.map((trace) => [
          trace.turnId,
          {
            turnId: trace.turnId,
            parentTurnId: trace.parentTurnId,
          },
        ]),
      ),
      messages,
      messagesById: new Map(messages.map((message) => [message.messageId, message])),
      childrenByTurnId: this.buildChatTurnChildrenMap(traces),
      activeLeafTurnId: this.resolveChatActiveLeafTurnId(sessionId, traces),
    };
  }

  public async getChatThread(sessionId: string): Promise<ChatThreadResponse> {
    this.getSession(sessionId);
    const state = await this.loadChatTurnSessionState(sessionId);
    const generatedArtifactsByTurnId = this.storage.chatGeneratedArtifacts.listByTurnIds(
      state.traces.map((trace) => trace.turnId),
    );
    return buildChatThreadResponse({
      sessionId,
      activeLeafTurnId: state.activeLeafTurnId,
      turns: state.traces.map((trace) => ({
        trace,
        userMessage: state.messagesById.get(trace.userMessageId),
        assistantMessage: trace.assistantMessageId ? state.messagesById.get(trace.assistantMessageId) : undefined,
        generatedArtifacts: (generatedArtifactsByTurnId.get(trace.turnId) ?? []).map(
          chatGeneratedArtifactService.buildGeneratedArtifactReference,
        ),
      })),
    });
  }

  public async selectChatBranchTurn(sessionId: string, turnId: string): Promise<ChatThreadResponse> {
    this.getSession(sessionId);
    const state = await this.loadChatTurnSessionState(sessionId);
    const generatedArtifactsByTurnId = this.storage.chatGeneratedArtifacts.listByTurnIds(
      state.traces.map((trace) => trace.turnId),
    );
    const target = state.traces.find((trace) => trace.turnId === turnId);
    if (!target) {
      throw new Error(`Chat turn ${turnId} not found in session ${sessionId}`);
    }
    const newestLeafTurnId = resolveNewestLeafTurnId(
      turnId,
      new Map(
        state.traces.map((trace) => [
          trace.turnId,
          {
            turnId: trace.turnId,
            startedAtMs: Date.parse(trace.startedAt) || 0,
          },
        ]),
      ),
      state.childrenByTurnId,
    );
    this.storage.chatSessionBranchState.setActiveLeaf(sessionId, newestLeafTurnId);
    this.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: "chat_thread_branch_selected",
        sessionId,
        turnId,
        activeLeafTurnId: newestLeafTurnId,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          sessionId,
          turnId,
        },
      },
    );
    return buildChatThreadResponse({
      sessionId,
      activeLeafTurnId: newestLeafTurnId,
      turns: state.traces.map((trace) => ({
        trace,
        userMessage: state.messagesById.get(trace.userMessageId),
        assistantMessage: trace.assistantMessageId ? state.messagesById.get(trace.assistantMessageId) : undefined,
        generatedArtifacts: (generatedArtifactsByTurnId.get(trace.turnId) ?? []).map(
          chatGeneratedArtifactService.buildGeneratedArtifactReference,
        ),
      })),
    });
  }

  public listChatThreadKnowledgeAttachments(sessionId: string): ThreadKnowledgeAttachmentRecord[] {
    return chatThreadKnowledgeService.listChatThreadKnowledgeAttachments(this, sessionId);
  }

  public async attachChatThreadKnowledgeAttachment(
    sessionId: string,
    input: chatThreadKnowledgeService.AttachThreadKnowledgeAttachmentInput,
  ): Promise<ThreadKnowledgeAttachmentRecord> {
    return chatThreadKnowledgeService.attachChatThreadKnowledgeAttachment(this, sessionId, input);
  }

  public removeChatThreadKnowledgeAttachment(
    sessionId: string,
    attachmentId: string,
  ): { deleted: boolean; attachmentId: string } {
    return chatThreadKnowledgeService.removeChatThreadKnowledgeAttachment(this, sessionId, attachmentId);
  }

  public getChatSessionPrefs(sessionId: string): ChatSessionPrefsRecord {
    return chatSessionService.getChatSessionPrefs(this, sessionId);
  }

  public updateChatSessionPrefs(sessionId: string, input: ChatSessionPrefsPatch): ChatSessionPrefsRecord {
    return chatSessionService.updateChatSessionPrefs(this, sessionId, input);
  }

  /** @internal */ public ensureChatSessionModelDefaults(
    sessionId: string,
    prefs: ChatSessionPrefsRecord,
  ): ChatSessionPrefsRecord {
    if (!prefs.providerId || !prefs.model) {
      return prefs;
    }

    const runtime = this.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
    const provider = runtime.providers.find((item) => item.providerId === prefs.providerId);
    if (!provider) {
      return prefs;
    }

    if (providerAllowsForeignModelIds(provider.providerId)) {
      return prefs;
    }

    const ownerProviderId = inferProviderForModelId(prefs.model);
    if (!ownerProviderId || ownerProviderId === provider.providerId) {
      return prefs;
    }

    return this.storage.chatSessionPrefs.patch(sessionId, {
      model: provider.defaultModel,
    });
  }

  /** @internal */ public hydrateChatPrefsWithAutonomy(
    sessionId: string,
    prefs: ChatSessionPrefsRecord,
  ): ChatSessionPrefsRecord {
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

  /** @internal */ public getSessionAutonomyPrefs(sessionId: string): SessionAutonomyPrefs {
    return this.storage.sessionAutonomyPrefs.ensure(sessionId);
  }

  /** @internal */ public patchSessionAutonomyPrefs(
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
        log.error("maintenance scheduler tick failed", error);
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
    await this.runUpdateReviewSchedulerIfDue();
    await this.cronAutomationService.runDueTaskCronJobs();
    await this.memoryLifecycleService.runDueEvaluation();
  }

  /** @internal */ public scheduleMemoryMaintenancePostTurnEvaluation(sessionId: string, parentTurnId?: string): void {
    if (this.closing || parentTurnId) {
      return;
    }
    const task = this.memoryLifecycleService.noteSuccessfulRootTurn(sessionId).catch((error) => {
      log.error("memory maintenance post-turn evaluation failed", error);
    });
    this.backgroundTasks.add(task);
    task.finally(() => this.backgroundTasks.delete(task));
  }

  /** @internal */ public scheduleChatMemoryContextPrewarm(input: {
    sessionId: string;
    prompt: string;
    relationScope?: MemoryRelationScope;
  }): void {
    const prewarmContext = this.memoryLifecycleService?.prewarmContext?.bind(this.memoryLifecycleService);
    if (this.closing || !input.prompt.trim() || typeof prewarmContext !== "function") {
      return;
    }
    const task = prewarmContext({
      scope: "chat",
      sessionId: input.sessionId,
      prompt: input.prompt,
      relationScope: input.relationScope,
      workspace: this.resolveMemoryWorkspaceRelativeDir(undefined, input.sessionId),
      forceRefresh: true,
    }).catch((error) => {
      log.error("chat memory prewarm failed", error);
    });
    this.backgroundTasks.add(task);
    task.finally(() => this.backgroundTasks.delete(task));
  }

  private async runPrivateBetaBackupSchedulerIfDue(options: { force?: boolean } = {}): Promise<void> {
    const job = this.storage.cronJobs.get(PRIVATE_BETA_BACKUP_JOB_ID);
    if (!job?.enabled) {
      return;
    }
    const now = new Date();
    if (
      !options.force &&
      !isCronJobDueNow(job, now, {
        defaultHour: 2,
        defaultMinute: 30,
        defaultWeekday: undefined,
        defaultTimeZone: PRIVATE_BETA_BACKUP_TIME_ZONE,
      })
    ) {
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
      nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
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
    if (
      !options.force &&
      !isCronJobDueNow(job, now, {
        defaultHour: 3,
        defaultMinute: 0,
        defaultWeekday: undefined,
        defaultTimeZone: MEMORY_FLUSH_DAILY_TIME_ZONE,
      })
    ) {
      return;
    }
    const dayKey = toDayKeyForTimezone(now, MEMORY_FLUSH_DAILY_TIME_ZONE);
    const lastDayKey = this.storage.systemSettings.get<string>(MEMORY_FLUSH_DAILY_DEDUP_SETTING_KEY)?.value;
    if (!options.force && dayKey === lastDayKey) {
      return;
    }

    const nowIso = now.toISOString();
    const cutoffIso = new Date(now.getTime() - MEMORY_FLUSH_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const prunedExpiredContextPacks = this.storage.memoryContexts.pruneExpired(nowIso);
    const prunedOldContextPacks = this.storage.memoryContexts.pruneOlderThan(cutoffIso);
    const prunedOldQmdRuns = this.storage.memoryQmdRuns.pruneOlderThan(cutoffIso);

    this.storage.systemSettings.set(MEMORY_FLUSH_DAILY_DEDUP_SETTING_KEY, dayKey);
    const finishedAt = new Date().toISOString();
    this.storage.cronJobs.upsert({
      ...job,
      lastRunAt: finishedAt,
      nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
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
    if (
      !options.force &&
      !isCronJobDueNow(job, now, {
        defaultHour: 0,
        defaultMinute: 0,
        defaultWeekday: undefined,
        defaultTimeZone: COST_REPORT_HOURLY_TIME_ZONE,
      })
    ) {
      return;
    }
    const hourKey = toHourKeyForTimezone(now, COST_REPORT_HOURLY_TIME_ZONE);
    const lastHourKey = this.storage.systemSettings.get<string>(COST_REPORT_HOURLY_DEDUP_SETTING_KEY)?.value;
    if (!options.force && hourKey === lastHourKey) {
      return;
    }

    const windowEndIso = now.toISOString();
    const windowStartIso = new Date(now.getTime() - COST_REPORT_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
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
        lines.push(
          `| ${row.key || "-"} | ${row.tokenInput} | ${row.tokenOutput} | ${row.tokenCachedInput} | ${row.tokenTotal} | ${row.costUsd.toFixed(6)} |`,
        );
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
      nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
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

  private async runUpdateReviewSchedulerIfDue(options: { force?: boolean } = {}): Promise<void> {
    const job = this.storage.cronJobs.get(UPDATE_REVIEW_DAILY_JOB_ID);
    if (!job?.enabled) {
      return;
    }
    const now = new Date();
    if (
      !options.force &&
      !isCronJobDueNow(job, now, {
        defaultHour: 4,
        defaultMinute: 15,
        defaultWeekday: undefined,
        defaultTimeZone: UPDATE_REVIEW_DAILY_TIME_ZONE,
      })
    ) {
      return;
    }
    const dayKey = toDayKeyForTimezone(now, UPDATE_REVIEW_DAILY_TIME_ZONE);
    const lastDayKey = this.storage.systemSettings.get<string>(UPDATE_REVIEW_DAILY_DEDUP_SETTING_KEY)?.value;
    if (!options.force && dayKey === lastDayKey) {
      return;
    }

    const report = await createDailyUpdateReview(this.config.rootDir);
    const reportDir = path.join(this.config.rootDir, UPDATE_REVIEW_OUTPUT_DIR);
    await fs.mkdir(reportDir, { recursive: true });
    const reportFileName = `update-review-${dayKey}.md`;
    const outputPath = path.join(reportDir, reportFileName);
    await fs.writeFile(outputPath, `${renderUpdateReviewMarkdown(report)}\n`, "utf8");

    this.storage.systemSettings.set(UPDATE_REVIEW_DAILY_DEDUP_SETTING_KEY, dayKey);
    const finishedAt = new Date().toISOString();
    this.storage.cronJobs.upsert({
      ...job,
      lastRunAt: finishedAt,
      nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    const hasAlerts =
      report.summary.outdatedDependencyCount > 0 ||
      report.summary.changedSkillSourceCount > 0 ||
      report.summary.warningCount > 0;
    if (this.isFeatureEnabled("cronReviewQueueV1Enabled")) {
      this.cronAutomationService.recordCronReviewItem({
        jobId: UPDATE_REVIEW_DAILY_JOB_ID,
        runId: randomUUID(),
        severity: hasAlerts ? "medium" : "low",
        status: hasAlerts ? "open" : "resolved",
        summary: {
          trigger: options.force ? "manual_run" : "scheduler",
          outputPath: path.relative(this.config.rootDir, outputPath).replaceAll("\\", "/"),
          outdatedDependencyCount: report.summary.outdatedDependencyCount,
          changedSkillSourceCount: report.summary.changedSkillSourceCount,
          warningCount: report.summary.warningCount,
          checkedSkillCount: report.summary.checkedSkillCount,
        },
        diff: {
          type: "update_review_daily",
          changed: hasAlerts,
          outdatedDependencyCount: report.summary.outdatedDependencyCount,
          changedSkillSourceCount: report.summary.changedSkillSourceCount,
          warningCount: report.summary.warningCount,
        },
      });
    }

    this.publishRealtime("cron_job_run", "cron", {
      type: "update_review_daily",
      jobId: UPDATE_REVIEW_DAILY_JOB_ID,
      outputPath,
      outdatedDependencyCount: report.summary.outdatedDependencyCount,
      changedSkillSourceCount: report.summary.changedSkillSourceCount,
      warningCount: report.summary.warningCount,
      checkedSkillCount: report.summary.checkedSkillCount,
    });
  }

  private hasRunningTurn(sessionId: string): boolean {
    const latest = this.storage.chatTurnTraces.listBySession(sessionId, 1)[0];
    return latest ? isChatTurnActiveStatus(latest.status) : false;
  }

  /** @internal */ public beginActiveChatTurnExecution(
    sessionId: string,
    turnId: string,
    operation: string,
  ): AbortController {
    return this.chatTurnExecutionRegistry.beginActiveExecution(sessionId, turnId, operation);
  }

  /** @internal */ public endActiveChatTurnExecution(turnId: string, controller: AbortController): void {
    this.chatTurnExecutionRegistry.endActiveExecution(turnId, controller);
  }

  private isChatTurnCancellationRequested(turnId: string): boolean {
    return this.chatTurnExecutionRegistry.isCancellationRequested(turnId);
  }

  /** @internal */ public getActiveChatTurnExecution(turnId: string): ActiveChatTurnExecution | undefined {
    return this.chatTurnExecutionRegistry.getActiveExecution(turnId);
  }

  /** @internal */ public registerActiveChatTurnStream(
    sessionId: string,
    turnId: string,
    runId?: string,
  ): ActiveChatTurnStreamExecution {
    return this.chatTurnExecutionRegistry.registerActiveStream(
      sessionId,
      turnId,
      this.storage.chatStreamEvents.getLatestSequence(turnId),
      runId,
    );
  }

  /** @internal */ public completeActiveChatTurnStream(turnId: string): void {
    this.chatTurnExecutionRegistry.completeActiveStream(turnId);
  }

  /** @internal */ public closeActiveChatTurnStream(turnId: string): void {
    this.chatTurnExecutionRegistry.closeActiveStream(turnId);
  }

  /** @internal */ public persistChatStreamChunk(chunk: PersistableChatStreamChunk, runId?: string): ChatStreamChunk {
    const active = this.chatTurnExecutionRegistry.getActiveStream(chunk.turnId);
    const sequence = active?.nextSequence ?? this.storage.chatStreamEvents.getLatestSequence(chunk.turnId) + 1;
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
      payload: chatStreamChunkToRecord(enriched),
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

  /** @internal */ public async *streamPersistedChatTurnEvents(
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
          const payload = toChatStreamChunk(event.payload);
          if (!payload) {
            continue;
          }
          yield payload;
          if (payload.type === "done") {
            return;
          }
        }
        continue;
      }

      const active = this.chatTurnExecutionRegistry.getActiveStream(turnId);
      const durablePending = options?.liveTail ? this.isDurableTurnStillStreaming(turnId) : false;
      if (!options?.liveTail || ((!active || active.completed) && !durablePending)) {
        return;
      }
      await wait(CHAT_STREAM_EVENT_POLL_INTERVAL_MS);
    }
  }

  private isDurableTurnStillStreaming(turnId: string): boolean {
    const eventRow = this.gatewaySql
      .prepare(
        `
      SELECT run_id
      FROM chat_stream_events
      WHERE turn_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `,
      )
      .get(turnId) as { run_id: string | null } | undefined;
    let runId = eventRow?.run_id ?? null;
    if (!runId) {
      try {
        runId = this.storage.chatTurnTraces.get(turnId).durable?.runId ?? null;
      } catch {
        runId = null;
      }
    }
    if (!runId) {
      return false;
    }
    try {
      const run = this.storage.durableRuns.getRun(runId);
      return run.status === "queued" || run.status === "running" || run.status === "waiting" || run.status === "paused";
    } catch {
      return false;
    }
  }

  /** @internal */ public async *withEphemeralStreamEnvelope(
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

  private async *streamTurnStateFallback(sessionId: string, turnId: string): AsyncGenerator<ChatStreamChunk> {
    const trace = this.storage.chatTurnTraces.get(turnId);
    if (trace.sessionId !== sessionId) {
      return;
    }
    const hydratedTrace = this.createHydratedChatTurnTrace(turnId, trace);
    yield this.persistChatStreamChunk(
      {
        type: "trace_update",
        sessionId,
        turnId,
        trace: hydratedTrace,
      },
      hydratedTrace.durable?.runId,
    );
    if (trace.assistantMessageId) {
      const assistantMessage = this.storage.chatMessages.get(trace.assistantMessageId);
      if (assistantMessage) {
        yield this.persistChatStreamChunk(
          {
            type: "message_done",
            sessionId,
            turnId,
            messageId: assistantMessage.messageId,
            content: assistantMessage.content,
            repaired: Boolean(hydratedTrace.completion?.repaired),
          },
          hydratedTrace.durable?.runId,
        );
        yield this.persistChatStreamChunk(
          {
            type: "done",
            sessionId,
            turnId,
            messageId: assistantMessage.messageId,
          },
          hydratedTrace.durable?.runId,
        );
      }
    }
  }

  /** @internal */ public createHydratedChatTurnTrace(turnId: string, trace: ChatTurnTraceRecord): ChatTurnTraceRecord {
    return chatTurnTraceHydration.createHydratedChatTurnTrace(this, turnId, trace);
  }

  /** @internal */ public markChatTurnCancelled(
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
    this.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: "chat_thread_turn_cancelled",
        sessionId,
        turnId,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          sessionId,
          turnId,
        },
      },
    );
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

  /** @internal */ public collectSpecialistCandidateSuggestions(input: {
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
    const seen = new Set<string>(
      existingCandidates
        .filter((candidate) => candidate.status !== "retired")
        .map((candidate) => normalizeSpecialistCandidateFingerprint(candidate)),
    );
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
      addSuggestion(
        buildSpecialistSuggestionFromCapability({
          capability,
          mode: input.mode,
          objectiveKeywords,
        }),
      );
    }

    const sessionWorkspaceId = this.normalizeWorkspaceId(
      this.storage.chatSessionMeta.ensure(input.sessionId).workspaceId,
    );
    for (const suggestion of suggestImportedCatalogEntries({
      entries: this.storage.importedAgentCatalog.list({
        workspaceId: sessionWorkspaceId,
        limit: 500,
      }),
      content: input.content,
      mode: input.mode,
    })) {
      addSuggestion(suggestion);
    }

    if (suggested.size === 0 && input.trace.orchestration) {
      const detectedRoles = normalizeDelegationRoles(detectDelegationRoles(input.content));
      for (const role of detectedRoles) {
        if (role === "coder") {
          continue;
        }
        addSuggestion(
          buildRoleGapSpecialistSuggestion({
            role,
            mode: input.mode,
            objective: input.content,
            objectiveKeywords,
            confidence: this.computeDelegationSuggestionConfidence(input.content, detectedRoles),
            runId: input.trace.orchestration.runId,
            turnId: input.trace.turnId,
          }),
        );
      }
    }

    return [...suggested.values()].slice(0, 3);
  }

  /** @internal */ public extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: {
      role: "user" | "assistant";
      sourceRef: string;
      trace?: Pick<ChatTurnTraceRecord, "status" | "toolRuns">;
    },
  ): void {
    return this.memoryLifecycleService.extractLearnedMemory(sessionId, content, source);
  }

  private getPromptRunnerModelDefaults(): { providerId?: string; model?: string } {
    const runtime = this.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
    const active = runtime.providers.find((provider) => provider.providerId === runtime.activeProviderId);
    if (active?.hasApiKey) {
      return {
        providerId: active.providerId,
        model: runtime.activeModel || active.defaultModel,
      };
    }
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
    const fallbackActive = runtime.providers.find((provider) => provider.providerId === runtime.activeProviderId);
    return {
      providerId: fallbackActive?.providerId ?? runtime.activeProviderId,
      model: runtime.activeModel || fallbackActive?.defaultModel,
    };
  }

  private getPromptJudgeModelDefaults(): { providerId?: string; model?: string } {
    const runtime = this.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
    const openai = runtime.providers.find((provider) => provider.providerId === "openai" && provider.hasApiKey);
    if (openai) {
      return {
        providerId: openai.providerId,
        model: "gpt-5.4",
      };
    }
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
      model: runtime.activeModel || active?.defaultModel,
    };
  }

  /** @internal */ public ensureChatSessionRuntimeGrants(sessionId: string): void {
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
      const hasDeny = active.some(
        (grant) => grant.decision === "deny" && grantPatternMatches(grant.toolPattern, toolName),
      );
      if (hasDeny) {
        continue;
      }
      const hasAllow = active.some(
        (grant) => grant.decision === "allow" && grantPatternMatches(grant.toolPattern, toolName),
      );
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

  /** @internal */ public inheritDelegatedSessionToolGrants(parentSessionId: string, childSessionId: string): void {
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
      { command: "/new", usage: "/new [title]", description: "Start a fresh session." },
      { command: "/mode", usage: "/mode chat|cowork|code", description: "Switch session mode." },
      { command: "/plan", usage: "/plan [on|off]", description: "Show or set advisory planning mode." },
      {
        command: "/model",
        usage: "/model <model-id|provider-id/model-id>",
        description: "Override provider/model for this session.",
      },
      { command: "/web", usage: "/web auto|off|quick|deep", description: "Set web retrieval behavior." },
      { command: "/memory", usage: "/memory auto|on|off", description: "Set memory behavior." },
      { command: "/dream", usage: "/dream", description: "Run workspace memory maintenance now." },
      { command: "/dream", usage: "/dream status", description: "Show workspace memory maintenance status." },
      { command: "/think", usage: "/think minimal|standard|extended", description: "Set thinking depth." },
      { command: "/tool", usage: "/tool safe_auto|manual", description: "Set tool autonomy mode." },
      {
        command: "/proactive",
        usage: "/proactive off|suggest|auto_safe|auto_full",
        description: "Set proactive mode.",
      },
      { command: "/retrieval", usage: "/retrieval standard|layered", description: "Set retrieval routing mode." },
      { command: "/reflect", usage: "/reflect off|on", description: "Toggle reflection retry mode." },
      { command: "/research", usage: "/research <query>", description: "Run quick research for current session." },
      {
        command: "/delegate",
        usage: "/delegate <role1,role2,...> :: <objective>",
        description: "Run task-backed role delegation.",
      },
      {
        command: "/pipeline",
        usage: "/pipeline prd|build|triage|release :: <objective>",
        description: "Run a built-in delegation template.",
      },
      {
        command: "/score",
        usage: "/score <TEST-##> <routing> <honesty> <handoff> <robustness> <usability>",
        description: "Score the latest run for a prompt-pack test.",
      },
      { command: "/pack", usage: "/pack run <TEST-##|all>", description: "Run prompt-pack tests from Prompt Lab." },
      { command: "/skills", usage: "/skills", description: "List installed skills and their runtime state." },
      {
        command: "/skill",
        usage: "/skill enable|sleep|disable <skillId>",
        description: "Change an installed skill's runtime state.",
      },
      { command: "/skill", usage: "/skill search <query>", description: "Search skill import sources." },
      {
        command: "/skill",
        usage: "/skill lookup <query-or-url>",
        description: "Resolve the best-fit skill source or listing.",
      },
      {
        command: "/skill",
        usage: "/skill install <sourceRef> [--confirm-high-risk]",
        description: "Validate and install a skill, disabled by default.",
      },
      { command: "/mcp", usage: "/mcp", description: "List configured MCP servers and connection state." },
      {
        command: "/mcp",
        usage: "/mcp connect|disconnect <serverId>",
        description: "Connect or disconnect a configured MCP server.",
      },
      { command: "/mcp", usage: "/mcp templates [query]", description: "List known MCP server templates." },
      {
        command: "/mcp",
        usage: "/mcp add-template <templateId>",
        description: "Add an MCP template definition in a disconnected state.",
      },
      {
        command: "/project",
        usage: "/project <project-id|none>",
        description: "Assign or clear this session project.",
      },
      {
        command: "/attach",
        usage: "/attach <attachment-id>",
        description: "Reference an attachment id in your next send.",
      },
      { command: "/run", usage: "/run research <query>", description: "Run a named workflow from chat." },
      { command: "/approve", usage: "/approve <approval-id>", description: "Approve a pending inline tool request." },
      { command: "/deny", usage: "/deny <approval-id>", description: "Deny a pending inline tool request." },
      { command: "/help", usage: "/help", description: "Show command catalog." },
    ];
  }

  public async listChatModelSuggestions(
    query: string,
    limit = 25,
  ): Promise<
    Array<{
      model: string;
      providerId: string;
      providerLabel: string;
    }>
  > {
    const runtime = this.getSettings().llm;
    const normalizedQuery = query.trim().toLowerCase();
    let activeProviderRemoteModels: string[] = [];
    if (runtime.activeProviderId) {
      try {
        activeProviderRemoteModels = dedupeStrings(
          (await this.listLlmModels(runtime.activeProviderId)).map((item) => item.id),
        );
      } catch {
        activeProviderRemoteModels = [];
      }
    }

    const providers = [...runtime.providers].sort((left, right) => {
      if (left.providerId === runtime.activeProviderId && right.providerId !== runtime.activeProviderId) {
        return -1;
      }
      if (right.providerId === runtime.activeProviderId && left.providerId !== runtime.activeProviderId) {
        return 1;
      }
      return left.label.localeCompare(right.label);
    });
    const results: Array<{
      model: string;
      providerId: string;
      providerLabel: string;
    }> = [];
    const seen = new Set<string>();

    for (const provider of providers) {
      const template = findProviderTemplate(provider.providerId);
      const candidates = dedupeStrings(
        [
          provider.defaultModel,
          provider.providerId === runtime.activeProviderId ? runtime.activeModel : "",
          ...(template?.knownModels ?? []),
          ...(provider.providerId === runtime.activeProviderId ? activeProviderRemoteModels : []),
        ].filter((value) => value.trim().length > 0),
      );

      candidates.sort((left, right) => {
        const leftScore = scoreChatModelSuggestion(left, normalizedQuery);
        const rightScore = scoreChatModelSuggestion(right, normalizedQuery);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
        return left.localeCompare(right);
      });

      for (const model of candidates) {
        if (seen.has(model)) {
          continue;
        }
        if (normalizedQuery && !model.toLowerCase().includes(normalizedQuery)) {
          continue;
        }
        seen.add(model);
        results.push({
          model,
          providerId: provider.providerId,
          providerLabel: provider.label,
        });
        if (results.length >= limit) {
          return results;
        }
      }
    }

    return results;
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
    session?: ChatSessionRecord;
  }> {
    return chatCommandService.parseChatCommand(this, sessionId, commandText);
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
    callbacks?: ChatDelegationProgressCallbacks,
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
    const requestedMode = input.mode ?? "sequential";
    const mode = requestedMode;
    const delegationSteps = normalizeDelegationSteps({
      roles,
      mode,
      steps: input.steps,
    });
    const prefs = this.ensureChatSessionModelDefaults(sessionId, this.storage.chatSessionPrefs.ensure(sessionId));
    const providerId = input.providerId ?? prefs.providerId;
    const model = input.model ?? prefs.model;
    const sessionWorkspaceId = this.normalizeWorkspaceId(this.storage.chatSessionMeta.ensure(sessionId).workspaceId);
    const parentProjectId = this.storage.chatSessionProjects.get(sessionId)?.projectId;

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
      roles: dedupeStrings(delegationSteps.map((step) => step.role)),
      mode,
      providerId,
      model,
      status: "running",
      citations: [],
    });
    await callbacks?.onStatus?.({
      runId,
      taskId: task.taskId,
      message: "Delegation started.",
    });
    this.appendTaskActivity(task.taskId, {
      activityType: "comment",
      message: `Delegation started (${delegationSteps.map((step) => step.role).join(mode === "parallel" ? " | " : " -> ")})`,
      metadata: { runId, sessionId, mode, requestedMode },
    });

    const citations: ChatCitationRecord[] = [];
    let trace: ChatTurnTraceRecord["routing"] | undefined;
    const completedOutputs = new Map<string, { role: string; output: string }>();
    const stepResults = new Map<string, DelegationStepExecutionResult>();
    const stages = buildDelegationStages(delegationSteps);

    const executeDelegationStep = async (step: NormalizedDelegationStep): Promise<DelegationStepExecutionResult> => {
      const startedAt = new Date().toISOString();
      const runningStep = this.storage.chatDelegationSteps.create({
        stepId: step.stepId,
        runId,
        role: step.role,
        index: step.index,
        status: "running",
        startedAt,
      });
      await callbacks?.onStep?.(runningStep);

      const childSession = this.createChatSession({
        workspaceId: sessionWorkspaceId,
        title: `Delegate · ${toTitleCase(step.role)}`,
        projectId: parentProjectId,
        mode: prefs.mode,
      });
      this.inheritDelegatedSessionToolGrants(sessionId, childSession.sessionId);
      this.updateChatSessionPrefs(childSession.sessionId, {
        mode: prefs.mode,
        planningMode: "off",
        providerId,
        model,
        webMode: prefs.webMode,
        memoryMode: prefs.memoryMode,
        thinkingLevel: prefs.thinkingLevel,
        toolAutonomy: prefs.toolAutonomy,
        orchestrationEnabled: false,
        orchestrationIntensity: "minimal",
        orchestrationVisibility: "explicit",
        orchestrationProviderPreference: prefs.orchestrationProviderPreference,
        orchestrationReviewDepth: prefs.orchestrationReviewDepth,
        orchestrationParallelism: "sequential",
        codeAutoApply: prefs.codeAutoApply,
        proactiveMode: "off",
        retrievalMode: prefs.retrievalMode,
        reflectionMode: "off",
      });
      const agentSessionId = childSession.sessionId;
      this.registerTaskSubagent(task.taskId, {
        agentSessionId,
        agentName: step.role,
      });

      const dependencyContext = step.dependsOnStepIds
        .map((dependencyStepId) => completedOutputs.get(dependencyStepId))
        .filter((item): item is { role: string; output: string } => Boolean(item));

      try {
        const response = await this.agentSendChatMessage(
          childSession.sessionId,
          buildDelegatedChatSendRequest({
            content: [
              buildDelegationSystemPrompt(step.role),
              buildDelegationUserPrompt({
                objective,
                role: step.role,
                mode,
                sharedContext: dependencyContext,
              }),
            ].join("\n\n"),
            providerId,
            model,
            mode: prefs.mode,
            webMode: prefs.webMode,
            memoryMode: prefs.memoryMode,
            thinkingLevel: prefs.thinkingLevel,
            retrievalMode: prefs.retrievalMode ?? "standard",
          }),
        );
        const traceStatus = response.trace?.status;
        const waitingForApproval = traceStatus === "waiting_for_approval";
        const waitingForUserInput = traceStatus === "waiting_for_user_input";
        const stillActive = traceStatus === "waiting_for_tool";
        const failed =
          traceStatus === "failed" ||
          traceStatus === "cancelled" ||
          waitingForApproval ||
          waitingForUserInput ||
          stillActive;
        const output =
          response.assistantMessage?.content?.trim() ||
          response.trace?.failure?.message?.trim() ||
          (waitingForApproval
            ? response.trace?.pendingApprovalSummary?.reason?.trim() || "Delegate is waiting for approval."
            : waitingForUserInput
              ? response.trace?.pendingUserInput?.question?.trim() || "Delegate is waiting for user input."
              : stillActive
                ? "Delegate is still waiting on a tool result."
                : "(delegate returned no output)");
        const finishedAt = new Date().toISOString();
        const completedStep = this.storage.chatDelegationSteps.patch(step.stepId, {
          status: failed ? "failed" : "completed",
          providerId: response.trace?.routing?.effectiveProviderId ?? providerId,
          model: response.trace?.model ?? model,
          summary: truncateSummaryLine(output, 180),
          output,
          error: failed ? (response.trace?.failure?.message ?? output) : undefined,
          failureGuidance: failed ? buildDelegationFailureGuidance(output, step.role) : undefined,
          durableRunId: response.trace?.durable?.runId,
          childSessionId: childSession.sessionId,
          childTurnId: response.turnId,
          citations: response.citations ?? [],
          finishedAt,
          durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        });
        await callbacks?.onStep?.(completedStep);
        this.updateTaskSubagent(agentSessionId, {
          status: failed ? "failed" : "completed",
          endedAt: finishedAt,
        });
        this.appendTaskActivity(task.taskId, {
          activityType: "comment",
          agentId: step.role,
          message: failed
            ? `${step.role} failed delegation step ${step.index + 1}/${delegationSteps.length}.`
            : `${step.role} completed delegation step ${step.index + 1}/${delegationSteps.length}.`,
          metadata: {
            runId,
            stepId: step.stepId,
            childSessionId: childSession.sessionId,
            childTurnId: response.turnId,
            durableRunId: response.trace?.durable?.runId,
          },
        });
        if (!failed) {
          this.appendTaskDeliverable(task.taskId, {
            deliverableType: "artifact",
            title: `${toTitleCase(step.role)} step`,
            description: output.slice(0, 6000),
          });
          completedOutputs.set(step.stepId, {
            role: step.role,
            output: output.slice(0, 4000),
          });
        }

        const completionRouting = response.routing ?? response.trace?.routing;
        if (completionRouting) {
          trace = {
            ...(trace ?? {}),
            ...completionRouting,
          };
        }
        for (const citation of response.citations ?? []) {
          citations.push(citation);
        }

        return {
          step: completedStep,
          output,
          citations: response.citations ?? [],
          trace: completionRouting,
          completed: !failed,
        };
      } catch (error) {
        const finishedAt = new Date().toISOString();
        const message = (error as Error).message;
        const failedStep = this.storage.chatDelegationSteps.patch(step.stepId, {
          status: "failed",
          error: message,
          failureGuidance: buildDelegationFailureGuidance(message, step.role),
          childSessionId: childSession.sessionId,
          finishedAt,
          durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        });
        await callbacks?.onStep?.(failedStep);
        this.updateTaskSubagent(agentSessionId, {
          status: "failed",
          endedAt: finishedAt,
        });
        this.appendTaskActivity(task.taskId, {
          activityType: "comment",
          agentId: step.role,
          message: `${step.role} failed delegation step ${step.index + 1}/${delegationSteps.length}: ${message}`,
          metadata: { runId, stepId: step.stepId, error: message },
        });
        return {
          step: failedStep,
          output: message,
          citations: [],
          completed: false,
        };
      }
    };

    for (const stage of stages) {
      const runnableSteps: NormalizedDelegationStep[] = [];
      for (const step of stage) {
        const failedDependencies = step.dependsOnStepIds.reduce<ChatDelegationStepRecord[]>((out, dependencyStepId) => {
          const dependency = stepResults.get(dependencyStepId)?.step;
          if (dependency && dependency.status !== "completed") {
            out.push(dependency);
          }
          return out;
        }, []);
        if (failedDependencies.length === 0) {
          runnableSteps.push(step);
          continue;
        }
        const failedDependencyRoles = failedDependencies.map((dependency) => dependency?.role ?? "unknown");
        const startedAt = new Date().toISOString();
        const skippedStep = this.storage.chatDelegationSteps.create({
          stepId: step.stepId,
          runId,
          role: step.role,
          index: step.index,
          status: "skipped",
          error: `Skipped because dependency failed: ${failedDependencyRoles.join(", ")}`,
          failureGuidance: buildDelegationFailureGuidance(
            `Blocked by dependency failure from ${failedDependencyRoles.join(", ")}`,
            step.role,
          ),
          startedAt,
          finishedAt: startedAt,
          durationMs: 0,
        });
        await callbacks?.onStep?.(skippedStep);
        this.appendTaskActivity(task.taskId, {
          activityType: "comment",
          agentId: step.role,
          message: `${step.role} skipped delegation step ${step.index + 1}/${delegationSteps.length} due to failed dependency.`,
          metadata: {
            runId,
            stepId: step.stepId,
            failedDependencyStepIds: failedDependencies.map((dependency) => dependency.stepId),
          },
        });
        stepResults.set(step.stepId, {
          step: skippedStep,
          citations: [],
          completed: false,
        });
      }

      await mapWithConcurrency(runnableSteps, 4, async (step) => {
        const result = await executeDelegationStep(step);
        stepResults.set(step.stepId, result);
        return result;
      });
    }

    const finishedAt = new Date().toISOString();
    const persistedSteps = this.storage.chatDelegationSteps.listByRun(runId);
    const stitchedSections = persistedSteps.map((step) => {
      const body =
        step.status === "completed"
          ? (step.output ?? "(delegate returned no output)")
          : step.status === "skipped"
            ? `SKIPPED: ${step.error ?? "Dependency did not complete."}`
            : `FAILED: ${step.error ?? step.output ?? "Delegate failed without an error message."}`;
      return `### ${toTitleCase(step.role)}\n${body}`;
    });
    const stitchedOutput = stitchedSections.join("\n\n").trim();
    const completedSteps = persistedSteps.filter((step) => step.status === "completed").length;
    const nonCompletedSteps = persistedSteps.length - completedSteps;
    const status: ChatDelegationRunRecord["status"] =
      nonCompletedSteps === 0 ? "completed" : completedSteps > 0 ? "partial" : "failed";
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
      metadata: {
        runId,
        completedSteps,
        failedSteps: persistedSteps.filter((step) => step.status === "failed").length,
        skippedSteps: persistedSteps.filter((step) => step.status === "skipped").length,
        steps: delegationSteps.length,
      },
    });
    if (completedSteps > 0 && status === "completed") {
      this.updateTask(task.taskId, {
        status: "review",
      });
    } else if (completedSteps > 0) {
      this.updateTask(task.taskId, {
        status: "blocked",
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
      this.scheduleChatMemoryContextPrewarm({
        sessionId,
        prompt: stitchedOutput,
        relationScope: "peer",
      });
    }

    return {
      runId,
      taskId: task.taskId,
      steps: persistedSteps,
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
    error?: string;
  }> {
    const queue: Array<{
      type: "status" | "step" | "done";
      runId?: string;
      taskId?: string;
      message?: string;
      step?: ChatDelegationStepRecord;
      result?: ChatDelegateResponse;
    }> = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let runError: unknown = null;
    const push = (chunk: {
      type: "status" | "step" | "done";
      runId?: string;
      taskId?: string;
      message?: string;
      step?: ChatDelegationStepRecord;
      result?: ChatDelegateResponse;
    }) => {
      queue.push(chunk);
      const notify = wake;
      wake = null;
      notify?.();
    };

    void this.runChatDelegation(sessionId, input, {
      onStatus: async (event) => {
        push({
          type: "status",
          runId: event.runId,
          taskId: event.taskId,
          message: event.message,
        });
      },
      onStep: async (step) => {
        push({
          type: "step",
          runId: step.runId,
          step,
        });
      },
    })
      .then((result) => {
        push({
          type: "done",
          runId: result.runId,
          taskId: result.taskId,
          result,
        });
      })
      .catch((error) => {
        runError = error;
      })
      .finally(() => {
        finished = true;
        const notify = wake;
        wake = null;
        notify?.();
      });

    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const chunk = queue.shift();
      if (chunk) {
        yield chunk;
      }
    }

    if (runError) {
      throw runError;
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
    return this.memoryLifecycleService.listSessionLearnedMemory(sessionId, limit);
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
      .find(
        (candidate) =>
          candidate.status !== "retired" &&
          normalizeSpecialistCandidateFingerprint(candidate) === normalizedFingerprint,
      );
    const trace = input.turnId
      ? this.storage.chatTurnTraces.listBySession(sessionId, 2000).find((item) => item.turnId === input.turnId)
      : undefined;
    if (existing) {
      return this.storage.chatSpecialistCandidates.patch(existing.candidateId, {
        summary: input.suggestion.summary,
        reason: input.suggestion.reason,
        confidence: Math.max(existing.confidence, input.suggestion.confidence),
        suggestedTools: dedupeStrings([...(existing.suggestedTools ?? []), ...(input.suggestion.suggestedTools ?? [])]),
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
    return this.memoryLifecycleService.updateSessionLearnedMemory(sessionId, itemId, input);
  }

  public async rebuildChatSessionLearnedMemory(sessionId: string): Promise<{
    rebuiltAt: string;
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  }> {
    return this.memoryLifecycleService.rebuildSessionLearnedMemory(sessionId);
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
    const detectedRoles = normalizeDelegationRoles(
      input.roles?.length ? input.roles : detectDelegationRoles(objective),
    );
    const roles = detectedRoles.length > 0 ? detectedRoles : DEFAULT_DELEGATION_ROLES.slice(0, 3);
    const confidence = this.computeDelegationSuggestionConfidence(objective, roles);
    const suggestion: ChatDelegationSuggestionRecord = {
      suggestionId: randomUUID(),
      sessionId,
      objective,
      roles,
      mode: "sequential",
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
      const actionRow = this.gatewaySql
        .prepare(
          `
        SELECT args_json
        FROM proactive_actions
        WHERE action_id = ? AND session_id = ?
      `,
        )
        .get(input.suggestionId, sessionId) as { args_json?: string } | undefined;
      if (actionRow?.args_json) {
        const parsed = safeJsonParse<Record<string, unknown>>(actionRow.args_json, {});
        const objectiveFromSuggestion = typeof parsed.objective === "string" ? parsed.objective.trim() : "";
        const rolesFromSuggestion = Array.isArray(parsed.roles) ? parsed.roles.map((item) => String(item)) : [];
        return this.runChatDelegation(sessionId, {
          objective: objectiveFromSuggestion || input.objective,
          roles: rolesFromSuggestion.length > 0 ? rolesFromSuggestion : input.roles,
          mode: "sequential",
          providerId: input.providerId,
          model: input.model,
        });
      }
    }
    return this.runChatDelegation(sessionId, {
      objective: input.objective,
      roles: input.roles,
      mode: "sequential",
      providerId: input.providerId,
      model: input.model,
    });
  }

  public importPromptPack(input: { content: string; name?: string; sourceLabel?: string; packId?: string }): {
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
    taskSuccess?: 0 | 1 | 2 | 3 | 4 | null;
    honesty?: 0 | 1 | 2 | 3 | 4 | null;
    executionQuality?: 0 | 1 | 2 | 3 | 4 | null;
    robustness?: 0 | 1 | 2 | 3 | 4 | null;
    usability?: 0 | 1 | 2 | 3 | 4 | null;
    overrideVerdict?: "pass" | "fail" | "review";
    reviewerId?: string;
    routingScore?: 0 | 1 | 2;
    honestyScore?: 0 | 1 | 2;
    handoffScore?: 0 | 1 | 2;
    robustnessScore?: 0 | 1 | 2;
    usabilityScore?: 0 | 1 | 2;
    notes?: string;
  }): PromptPackHumanReviewRecordV2 {
    return this.promptPackService.scorePromptPackTest(input);
  }

  public reviewPromptPackTest(input: {
    packId: string;
    testId: string;
    runId: string;
    taskSuccess?: 0 | 1 | 2 | 3 | 4 | null;
    honesty?: 0 | 1 | 2 | 3 | 4 | null;
    executionQuality?: 0 | 1 | 2 | 3 | 4 | null;
    robustness?: 0 | 1 | 2 | 3 | 4 | null;
    usability?: 0 | 1 | 2 | 3 | 4 | null;
    overrideVerdict?: "pass" | "fail" | "review";
    reviewerId?: string;
    notes?: string;
  }): PromptPackHumanReviewRecordV2 {
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
  }): Promise<PromptPackHumanReviewRecordV2> {
    return this.promptPackService.scorePromptPackLatestRunByCode(input);
  }

  public getPromptPackReport(packId: string): PromptPackReportRecord {
    return this.promptPackService.getPromptPackReport(packId);
  }

  public listPromptPackTestReviews(packId: string, testId: string): PromptPackHumanReviewRecordV2[] {
    return this.promptPackService.listPromptPackTestReviews(packId, testId);
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

  public cancelPromptPackBenchmark(benchmarkRunId: string): PromptPackBenchmarkStatusRecord {
    return this.promptPackService.cancelPromptPackBenchmark(benchmarkRunId);
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

  public getHarnessAuditReport(): HarnessAuditReportRecord {
    return buildHarnessAuditReport({
      skills: this.listSkills(),
      policy: this.getSkillActivationPolicy(),
      inspectableCatalog: this.listCapabilityCatalog("inspectable"),
      proposals: this.listCapabilityProposals(100),
      importHistory: this.listSkillImportHistory(50),
      improvementReportCount: this.listImprovementReports(24).length,
    });
  }

  public listDecisionReplayRuns(limit = 24): DecisionReplayRunRecord[] {
    return this.improvementService.listDecisionReplayRuns(limit);
  }

  public listCapabilityGapEvents(limit = 100): CapabilityGapEventRecord[] {
    return this.improvementService.listCapabilityGapEvents(limit);
  }

  public listRepairCandidates(limit = 60): RepairCandidateRecord[] {
    return this.improvementService.listRepairCandidates(limit);
  }

  public updateRepairCandidateValidation(
    candidateId: string,
    input: { status: RepairValidationStatus; summary?: string },
  ): RepairCandidateRecord {
    return this.improvementService.updateRepairCandidateValidation(candidateId, input);
  }

  public listImprovementSignals(limit = 100, workspaceId?: string): ImprovementSignalRecord[] {
    return this.improvementService.listImprovementSignals(limit, workspaceId);
  }

  public getImprovementSignal(signalId: string): ImprovementSignalRecord {
    return this.improvementService.getImprovementSignal(signalId);
  }

  public listImprovementCandidates(limit = 100, workspaceId?: string): ImprovementCandidateRecord[] {
    return this.improvementService.listImprovementCandidates(limit, workspaceId);
  }

  public getImprovementCandidate(candidateId: string): ImprovementCandidateDetailResponse {
    return this.improvementService.getImprovementCandidateDetail(candidateId);
  }

  public async requestImprovementActivation(
    candidateId: string,
    actorId = "operator",
  ): Promise<ImprovementActivationRecord> {
    return this.improvementService.requestImprovementActivation(candidateId, actorId);
  }

  public getImprovementActivation(activationId: string): ImprovementActivationRecord {
    return this.improvementService.getImprovementActivation(activationId);
  }

  public pauseImprovementActivation(activationId: string, actorId = "operator"): ImprovementActivationRecord {
    return this.improvementService.pauseImprovementActivation(activationId, actorId);
  }

  public rollbackImprovementActivation(activationId: string, actorId = "operator"): ImprovementActivationRecord {
    return this.improvementService.rollbackImprovementActivation(activationId, actorId);
  }

  private captureRepairPolicySnapshot(targetKey: string): ImprovementRef {
    return this.captureImprovementPolicySnapshot(
      IMPROVEMENT_REPAIR_POLICY_CONFIG_SETTING_KEY,
      "repair_policy_snapshot",
      targetKey,
    );
  }

  private applyRepairPolicyCandidate(targetKey: string, revisionRef: ImprovementRef): ImprovementRef {
    return this.applyImprovementPolicyCandidate(
      IMPROVEMENT_REPAIR_POLICY_CONFIG_SETTING_KEY,
      "repair_policy_config",
      targetKey,
      revisionRef,
    );
  }

  private restoreRepairPolicySnapshot(snapshotRef: ImprovementRef): void {
    this.restoreImprovementPolicySnapshot(IMPROVEMENT_REPAIR_POLICY_CONFIG_SETTING_KEY, snapshotRef);
  }

  private captureRoutingPolicySnapshot(targetKey: string): ImprovementRef {
    return this.captureImprovementPolicySnapshot(
      IMPROVEMENT_ROUTING_POLICY_CONFIG_SETTING_KEY,
      "routing_policy_snapshot",
      targetKey,
    );
  }

  private applyRoutingPolicyCandidate(targetKey: string, revisionRef: ImprovementRef): ImprovementRef {
    return this.applyImprovementPolicyCandidate(
      IMPROVEMENT_ROUTING_POLICY_CONFIG_SETTING_KEY,
      "routing_policy_config",
      targetKey,
      revisionRef,
    );
  }

  private restoreRoutingPolicySnapshot(snapshotRef: ImprovementRef): void {
    this.restoreImprovementPolicySnapshot(IMPROVEMENT_ROUTING_POLICY_CONFIG_SETTING_KEY, snapshotRef);
  }

  private captureImprovementPolicySnapshot(
    settingKey: string,
    refType: ImprovementRef["refType"],
    targetKey: string,
  ): ImprovementRef {
    const policies = this.readImprovementPolicyMap(settingKey);
    const hadValue = Object.prototype.hasOwnProperty.call(policies, targetKey);
    const previousValue = hadValue ? policies[targetKey] : null;
    return {
      refType,
      refId: targetKey,
      hash: createHash("sha1").update(JSON.stringify({ hadValue, previousValue })).digest("hex"),
      metadata: {
        settingKey,
        targetKey,
        hadValue,
        previousValue,
      },
    };
  }

  private applyImprovementPolicyCandidate(
    settingKey: string,
    refType: ImprovementRef["refType"],
    targetKey: string,
    revisionRef: ImprovementRef,
  ): ImprovementRef {
    const policies = this.readImprovementPolicyMap(settingKey);
    const proposedChange = isRecord(revisionRef.metadata) ? revisionRef.metadata.proposedChange : undefined;
    const nextValue = proposedChange ?? revisionRef.metadata ?? {};
    this.writeImprovementPolicyMap(settingKey, {
      ...policies,
      [targetKey]: nextValue,
    });
    return {
      refType,
      refId: targetKey,
      hash: createHash("sha1").update(JSON.stringify(nextValue)).digest("hex"),
      metadata: {
        settingKey,
        targetKey,
        appliedValue: nextValue,
      },
    };
  }

  private restoreImprovementPolicySnapshot(expectedSettingKey: string, snapshotRef: ImprovementRef): void {
    const metadata = isRecord(snapshotRef.metadata) ? snapshotRef.metadata : {};
    const settingKey =
      typeof metadata.settingKey === "string" && metadata.settingKey.trim().length > 0
        ? metadata.settingKey
        : expectedSettingKey;
    const targetKey = typeof metadata.targetKey === "string" ? metadata.targetKey : snapshotRef.refId;
    const hadValue = metadata.hadValue === true;
    const policies = this.readImprovementPolicyMap(settingKey);
    const next = { ...policies };
    if (hadValue) {
      next[targetKey] = metadata.previousValue;
    } else {
      delete next[targetKey];
    }
    this.writeImprovementPolicyMap(settingKey, next);
  }

  private readImprovementPolicyMap(settingKey: string): Record<string, unknown> {
    const stored = this.storage.systemSettings.get<unknown>(settingKey)?.value;
    return isRecord(stored) ? { ...stored } : {};
  }

  private writeImprovementPolicyMap(settingKey: string, next: Record<string, unknown>): void {
    if (Object.keys(next).length === 0) {
      this.storage.systemSettings.set(settingKey, null);
      return;
    }
    this.storage.systemSettings.set(settingKey, next);
  }

  public getDurableDiagnostics(): DurableDiagnosticsResponse {
    return durableExecutionService.getDurableDiagnostics(this);
  }

  public listDurableRuns(limit = 50): DurableRunRecord[] {
    return durableExecutionService.listDurableRuns(this, limit);
  }

  public listDurableDeadLetters(limit = 50): DurableDeadLetterRecord[] {
    return durableExecutionService.listDurableDeadLetters(this, limit);
  }

  public listDurableRunCheckpoints(runId: string, limit = 200): DurableCheckpointRecord[] {
    return durableExecutionService.listDurableRunCheckpoints(this, runId, limit);
  }

  public createDurableRun(input: DurableRunCreateRequest): DurableRunRecord {
    return durableExecutionService.createDurableRun(this, input);
  }

  public getDurableRun(runId: string): DurableRunRecord {
    return durableExecutionService.getDurableRun(this, runId);
  }

  public listDurableRunTimeline(runId: string, limit = 300): DurableRunTimelineEvent[] {
    return durableExecutionService.listDurableRunTimeline(this, runId, limit);
  }

  public pauseDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    return durableExecutionService.pauseDurableRun(this, runId, actorId);
  }

  public resumeDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    return durableExecutionService.resumeDurableRun(this, runId, actorId);
  }

  public cancelDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    return durableExecutionService.cancelDurableRun(this, runId, actorId);
  }

  public retryDurableRun(runId: string, reason = "manual_retry", actorId = "operator"): DurableRunRecord {
    return durableExecutionService.retryDurableRun(this, runId, reason, actorId);
  }

  public getMemoryMaintenancePolicy(workspaceId?: string): MemoryMaintenancePolicyRecord {
    return this.memoryLifecycleService.getMaintenancePolicy(workspaceId);
  }

  public patchMemoryMaintenancePolicy(
    workspaceId: string | undefined,
    patch: MemoryMaintenancePolicyPatchInput,
  ): MemoryMaintenancePolicyRecord {
    return this.memoryLifecycleService.patchMaintenancePolicy(workspaceId, patch);
  }

  public getMemoryMaintenanceStatus(workspaceId?: string): MemoryMaintenanceStatusRecord {
    return this.memoryLifecycleService.getMaintenanceStatus(workspaceId);
  }

  public listMemoryMaintenanceRuns(workspaceId?: string, limit = 50): MemoryMaintenanceRunRecord[] {
    return this.memoryLifecycleService.listMaintenanceRuns(workspaceId, limit);
  }

  public runMemoryMaintenanceNow(input: MemoryMaintenanceRunNowInput): MemoryMaintenanceRunRecord {
    return this.memoryLifecycleService.runMaintenanceNow(input);
  }

  public getMemoryMaintenanceRunProvenance(runId: string): MemoryMaintenanceProvenanceRecord {
    return this.memoryLifecycleService.getMaintenanceRunProvenance(runId);
  }

  public listMemoryMaintenanceRecommendations(
    workspaceId?: string,
    limit = 50,
  ): MemoryMaintenanceRecommendationRecord[] {
    return this.memoryLifecycleService.listMaintenanceRecommendations(workspaceId, limit);
  }

  public acceptMemoryMaintenanceRecommendation(recommendationId: string): {
    recommendation: MemoryMaintenanceRecommendationRecord;
    policy: MemoryMaintenancePolicyRecord;
  } {
    return this.memoryLifecycleService.acceptMaintenanceRecommendation(recommendationId);
  }

  public rejectMemoryMaintenanceRecommendation(recommendationId: string): MemoryMaintenanceRecommendationRecord {
    return this.memoryLifecycleService.rejectMaintenanceRecommendation(recommendationId);
  }

  public wakeDurableRun(
    runId: string,
    event: {
      eventKey: string;
      payload?: Record<string, unknown>;
      correlationId?: string;
    },
  ): DurableWakeResult {
    return durableExecutionService.wakeDurableRun(this, runId, event);
  }

  public recoverDurableDeadLetter(
    entryId: string,
    actorId = "operator",
    options?: { maxAttempts?: number },
  ): DurableRunRecord {
    return durableExecutionService.recoverDurableDeadLetter(this, entryId, actorId, options);
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

  public async runImprovementReplayManually(input: ImprovementReplayTriggerInput = {}): Promise<{
    run: DecisionReplayRunRecord;
    report?: WeeklyImprovementReportRecord;
  }> {
    return this.improvementService.runImprovementReplayManually(input);
  }

  public createReplayOverrideDraft(
    sourceRunId: string,
    overrides: ReplayOverrideStep[] = [],
    links: { capabilityGapEventId?: string; repairCandidateId?: string } = {},
  ): ReplayOverrideDraft {
    return this.improvementService.createReplayOverrideDraft(sourceRunId, overrides, links);
  }

  public async executeReplayOverride(
    sourceRunId: string,
    overrides: ReplayOverrideStep[] = [],
    links: { capabilityGapEventId?: string; repairCandidateId?: string } = {},
  ): Promise<ReplayOverrideDraft> {
    return this.improvementService.executeReplayOverride(sourceRunId, overrides, links);
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

  /** @internal */ public async runPromptPackFromChat(
    sessionId: string,
    selector: string,
  ): Promise<PromptPackRunRecord[]> {
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
    options?: {
      allowScope?: "once" | "session" | "workspace";
    },
  ): Promise<{
    allowScope: "once" | "session" | "workspace";
    grant?: ToolGrantRecord;
    resumed: boolean;
    resumedTurnId?: string;
    resumedRunId?: string;
  }> {
    return this.approvalRuntime.resolveChatToolApproval(sessionId, approvalId, decision, options);
  }

  public async answerChatUserInputPrompt(
    sessionId: string,
    turnId: string,
    promptId: string,
    response: ChatUserInputPromptResponse,
  ): Promise<ChatUserInputPromptAnswerResponse> {
    this.getSession(sessionId);
    const trace = this.storage.chatTurnTraces.get(turnId);
    if (trace.sessionId !== sessionId) {
      throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
    }
    if (trace.status !== "waiting_for_user_input") {
      throw new ValidationError({ message: `Chat turn ${turnId} is not waiting for user input.` });
    }
    const prompt = trace.pendingUserInput;
    if (!prompt || prompt.promptId !== promptId) {
      throw new ValidationError({ message: `Prompt ${promptId} is not active for chat turn ${turnId}.` });
    }
    if (prompt.kind !== response.kind) {
      throw new ValidationError({ message: `Prompt ${promptId} expects a ${prompt.kind} response.` });
    }
    if (response.kind === "single_select") {
      const validOptionIds = new Set((prompt.options ?? []).map((option) => option.optionId));
      if (!validOptionIds.has(response.optionId)) {
        throw new ValidationError({ message: `Option ${response.optionId} is not valid for prompt ${promptId}.` });
      }
    } else if (response.text.trim().length === 0) {
      throw new ValidationError({ message: `Prompt ${promptId} requires non-empty text.` });
    }

    const durableRunId = trace.durable?.runId;
    if (!durableRunId) {
      throw new ConflictError({
        message: `Chat turn ${turnId} cannot be resumed because it is not linked to a durable run.`,
      });
    }
    const durableRun = this.getDurableRun(durableRunId);
    const durablePayload = this.parseDurableChatTurnPayload(durableRun);
    if (!durablePayload) {
      throw new ConflictError({
        message: `Durable run ${durableRunId} is missing a valid chat turn payload.`,
      });
    }

    const answeredAt = new Date().toISOString();
    const selectedOption =
      response.kind === "single_select"
        ? (prompt.options ?? []).find((option) => option.optionId === response.optionId)
        : undefined;
    const resumeRecord: DurableChatTurnUserInputResumeRecord = {
      promptId,
      kind: prompt.kind,
      title: prompt.title,
      question: prompt.question,
      answeredAt,
      response: response.kind === "text" ? { kind: "text", text: response.text.trim() } : response,
      ...(selectedOption
        ? {
            selectedOption: {
              optionId: selectedOption.optionId,
              label: selectedOption.label,
              description: selectedOption.description,
            },
          }
        : {}),
    };

    const updatedDurableRun = this.storage.durableRuns.updateRun({
      runId: durableRunId,
      status: durableRun.status,
      payload: durableChatTurnPayloadToRecord({
        ...durablePayload,
        userInputResponses: [
          ...(durablePayload.userInputResponses ?? []).filter((entry) => entry.promptId !== promptId),
          resumeRecord,
        ],
      }),
      expectedVersion: durableRun.version,
    });
    const wake = this.wakeDurableRun(durableRunId, {
      eventKey: "chat.user_input.resolved",
      correlationId: promptId,
      payload: {
        sessionId,
        turnId,
        promptId,
        answeredAt,
        response: userInputPromptResponseToRecord(resumeRecord.response),
      },
    });
    const resumed =
      wake.outcome === "woke" ||
      wake.run?.status === "queued" ||
      wake.run?.status === "running" ||
      updatedDurableRun.status === "queued" ||
      updatedDurableRun.status === "running";
    if (!resumed) {
      throw new ConflictError({
        message:
          wake.detail ??
          `Durable run ${durableRunId} could not be resumed from ${wake.run?.status ?? updatedDurableRun.status}.`,
      });
    }

    this.storage.chatTurnTraces.patch(turnId, {
      status: "running",
      pendingUserInput: null,
    });
    this.recordDevDiagnostic({
      level: "info",
      category: "chat",
      event: "chat.user_input_prompt.answered",
      message: "Resolved pending chat user-input prompt",
      sessionId,
      turnId,
      context: {
        promptId,
        promptKind: prompt.kind,
        responseKind: response.kind,
      },
    });
    this.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: "chat_thread_user_input_answered",
        sessionId,
        turnId,
        promptId,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          sessionId,
          turnId,
        },
      },
    );
    return {
      ok: true,
      sessionId,
      turnId,
      promptId,
      resumed,
      resumedTurnId: turnId,
      resumedRunId: durableRunId,
    };
  }

  /** @internal */ public async requireChatTurnContext(
    sessionId: string,
    turnId: string,
    state?: Awaited<ReturnType<GatewayService["loadChatTurnSessionState"]>>,
  ): Promise<{
    trace: ChatTurnTraceRecord;
    userMessage: ChatMessageRecord;
    assistantMessage?: ChatMessageRecord;
  }> {
    const sessionState = state ?? (await this.loadChatTurnSessionState(sessionId));
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

  /** @internal */ public async withChatTurnWriteLease<T>(
    sessionId: string,
    operation: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.chatTurnExecutionRegistry.withWriteLease(sessionId, operation, work);
  }

  /** @internal */ public async *withChatTurnWriteLeaseStream(
    sessionId: string,
    operation: string,
    work: () => AsyncGenerator<ChatStreamChunk>,
  ): AsyncGenerator<ChatStreamChunk> {
    yield* this.chatTurnExecutionRegistry.withWriteLeaseStream(sessionId, operation, work);
  }

  /** @internal */ public clearChatTurnWriteLease(sessionId: string): void {
    this.chatTurnExecutionRegistry.clearSessionWriteLease(sessionId);
  }

  /** @internal */ public updateActiveLeafOrThrow(
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
    log.warn("chat turn branch-state conflict", {
      sessionId,
      expectedActiveLeafTurnId,
      nextActiveLeafTurnId,
      currentActiveLeafTurnId: current,
    });
    throw new ChatTurnWriteConflictError(
      `Chat branch state changed while writing session ${sessionId}. Refresh the session and retry.`,
    );
  }

  /** @internal */ public prepareAgentChatTurn(
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
  ): Promise<chatTurnPrepService.PreparedAgentChatTurn> {
    return chatTurnPrepService.prepareAgentChatTurn(this, sessionId, input, options);
  }

  /** @internal */ public isChatTurnWriteConflict(error: unknown): error is ChatTurnWriteConflictError {
    return error instanceof ChatTurnWriteConflictError;
  }

  /** @internal */ public resolvePreparedTurnOrchestration(
    prepared: chatTurnPrepService.PreparedAgentChatTurn,
  ): Promise<PreparedChatExecutionPlanResolution | undefined> {
    return chatTurnPrepService.resolvePreparedTurnOrchestration(this, prepared);
  }

  private applyApprovedSpecialistsToPlan(
    prepared: chatTurnPrepService.PreparedAgentChatTurn,
    plan: ReturnType<typeof buildOrchestrationPlan>,
  ): ReturnType<typeof buildOrchestrationPlan> {
    return chatTurnPrepService.applyApprovedSpecialistsToPlan(this, prepared, plan);
  }

  private generatePreparedExecutionPlanDraft(
    prepared: chatTurnPrepService.PreparedAgentChatTurn,
    routerInput: OrchestrationRouterInput,
    templatePlan: ModeOrchestrationPlan,
    advisoryOnly: boolean,
  ): Promise<PreparedChatExecutionPlanResolution["executionPlanDraft"]> {
    return chatTurnPrepService.generatePreparedExecutionPlanDraft(
      this,
      prepared,
      routerInput,
      templatePlan,
      advisoryOnly,
    );
  }

  /** @internal */ public buildChatOrchestrationSummary(input: {
    runId: string;
    objective: string;
    modePolicy: ChatMode;
    routeDecision: ReturnType<typeof buildOrchestrationPlan>["routeDecision"];
    stepResults: OrchestrationStepExecutionResult[];
    finalSummary?: string;
    finalized?: boolean;
    advisoryOnly?: boolean;
  }): NonNullable<ChatTurnTraceRecord["orchestration"]> {
    return chatTurnPrepService.buildChatOrchestrationSummary(input);
  }

  private collectOrchestrationToolRuns(runId: string): ChatToolRunRecord[] {
    return chatTurnStreamService.collectOrchestrationToolRuns(this, runId);
  }

  private async executePreparedModeOrchestration(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    input: ChatSendMessageRequest,
    signal?: AbortSignal,
    onProgress?: (summary: NonNullable<ChatTurnTraceRecord["orchestration"]>) => Promise<void> | void,
    resolvedOrchestration?: PreparedChatExecutionPlanResolution,
  ): Promise<
    OrchestrationExecutionResult & {
      summary: NonNullable<ChatTurnTraceRecord["orchestration"]>;
      executionPlanId: string;
    }
  > {
    return chatTurnStreamService.executePreparedModeOrchestration(
      this,
      prepared,
      input,
      signal,
      onProgress,
      resolvedOrchestration,
    );
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
    return chatTurnStreamService.executeDelegatedPlanStep(this, prepared, input);
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
    yield* chatTurnStreamService.streamPreparedAgentChatTurn(
      this,
      sessionId,
      input,
      prepared,
      threadEventType,
      resolvedOrchestration,
      options,
    );
  }

  public async agentSendChatMessage(
    sessionId: string,
    input: ChatSendMessageRequest,
  ): Promise<ChatSendMessageResponse> {
    return this.chatTurnRuntime.agentSendChatMessage(sessionId, input);
  }

  public async *agentSendChatMessageStream(
    sessionId: string,
    input: ChatSendMessageRequest,
    _signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamChunk> {
    yield* this.chatTurnRuntime.agentSendChatMessageStream(sessionId, input);
  }

  public async routePreflight(sessionId: string, input: RoutingPreflightRequest): Promise<RoutingPreflightResult> {
    return this.chatTurnRuntime.routePreflight(sessionId, input);
  }

  public async retryChatTurn(
    sessionId: string,
    turnId: string,
    overrides: Partial<ChatSendMessageRequest> = {},
  ): Promise<ChatSendMessageResponse> {
    return this.chatTurnRuntime.retryChatTurn(sessionId, turnId, overrides);
  }

  private async retryChatTurnInScratchSession(
    sourceSessionId: string,
    sourceTurnId: string,
    overrides: Partial<ChatSendMessageRequest> = {},
  ): Promise<ChatSendMessageResponse> {
    const sourceBinding = this.storage.chatSessionBindings.get(sourceSessionId);
    if (sourceBinding?.transport && sourceBinding.transport !== "llm") {
      throw new ReplayExecutionSkippedError(
        "GoatCitadel skipped actual replay because the source session uses integration transport and retrying it would trigger external side effects.",
        {
          transport: sourceBinding.transport,
          sessionId: sourceSessionId,
          turnId: sourceTurnId,
        },
      );
    }
    const scratch = await this.createReplayScratchSession(sourceSessionId, sourceTurnId);
    try {
      return await this.retryChatTurn(scratch.sessionId, scratch.sourceTurnId, overrides);
    } finally {
      try {
        this.archiveChatSession(scratch.sessionId);
      } catch (error) {
        log.warn("failed to archive replay scratch session", {
          sourceSessionId,
          sourceTurnId,
          scratchSessionId: scratch.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async createReplayScratchSession(
    sourceSessionId: string,
    sourceTurnId: string,
  ): Promise<{ sessionId: string; sourceTurnId: string }> {
    const sourceSession = this.requireChatSession(sourceSessionId);
    const sourceMeta = this.storage.chatSessionMeta.ensure(
      sourceSessionId,
      undefined,
      sourceSession.workspaceId ?? DEFAULT_WORKSPACE_ID,
    );
    const sourcePrefs = this.storage.chatSessionPrefs.ensure(sourceSessionId);
    const sourceAutonomy = this.storage.sessionAutonomyPrefs.ensure(sourceSessionId);
    const sourceProjectId = this.storage.chatSessionProjects.get(sourceSessionId)?.projectId;
    const sourceState = await this.loadChatTurnSessionState(sourceSessionId);
    const scratchSession = this.createChatSession({
      workspaceId: this.normalizeWorkspaceId(sourceMeta.workspaceId),
      projectId: sourceProjectId,
      mode: sourcePrefs.mode,
      title: `${REPLAY_SCRATCH_SESSION_TITLE_PREFIX} ${sourceSession.title?.trim() || sourceTurnId.slice(0, 8)}`,
    });

    this.storage.chatSessionPrefs.patch(scratchSession.sessionId, {
      mode: sourcePrefs.mode,
      planningMode: sourcePrefs.planningMode,
      providerId: sourcePrefs.providerId,
      model: sourcePrefs.model,
      imageProviderId: sourcePrefs.imageProviderId,
      imageModel: sourcePrefs.imageModel,
      webMode: sourcePrefs.webMode,
      memoryMode: sourcePrefs.memoryMode,
      thinkingLevel: sourcePrefs.thinkingLevel,
      toolAutonomy: sourcePrefs.toolAutonomy,
      visionFallbackModel: sourcePrefs.visionFallbackModel,
      orchestrationEnabled: sourcePrefs.orchestrationEnabled,
      orchestrationIntensity: sourcePrefs.orchestrationIntensity,
      orchestrationVisibility: sourcePrefs.orchestrationVisibility,
      orchestrationProviderPreference: sourcePrefs.orchestrationProviderPreference,
      orchestrationReviewDepth: sourcePrefs.orchestrationReviewDepth,
      orchestrationParallelism: sourcePrefs.orchestrationParallelism,
      codeAutoApply: sourcePrefs.codeAutoApply,
    });
    this.storage.sessionAutonomyPrefs.patch(scratchSession.sessionId, {
      proactiveMode: sourceAutonomy.proactiveMode,
      maxActionsPerHour: sourceAutonomy.maxActionsPerHour,
      maxActionsPerTurn: sourceAutonomy.maxActionsPerTurn,
      cooldownSeconds: sourceAutonomy.cooldownSeconds,
      retrievalMode: sourceAutonomy.retrievalMode,
      reflectionMode: sourceAutonomy.reflectionMode,
    });
    this.inheritDelegatedSessionToolGrants(sourceSessionId, scratchSession.sessionId);

    const cloned = this.cloneChatTurnPathIntoSession({
      sourceSessionId,
      sourceTurnId,
      targetSessionId: scratchSession.sessionId,
      sourceState,
    });
    this.storage.chatSessionBranchState.setActiveLeaf(scratchSession.sessionId, cloned.sourceTurnId);
    return {
      sessionId: scratchSession.sessionId,
      sourceTurnId: cloned.sourceTurnId,
    };
  }

  private cloneChatTurnPathIntoSession(input: {
    sourceSessionId: string;
    sourceTurnId: string;
    targetSessionId: string;
    sourceState: Awaited<ReturnType<GatewayService["loadChatTurnSessionState"]>>;
  }): { sourceTurnId: string } {
    const pathTurnIds = buildSelectedPathTurnIds(input.sourceState.turnLineageById, input.sourceTurnId);
    if (pathTurnIds.length === 0) {
      throw new Error(`Chat turn ${input.sourceTurnId} not found in session ${input.sourceSessionId}`);
    }

    const turnIdMap = new Map<string, string>();
    const messageCopies: ChatMessageRecord[] = [];
    const traceCopies: Array<Parameters<Storage["chatTurnTraces"]["create"]>[0]> = [];

    for (const pathTurnId of pathTurnIds) {
      const trace = input.sourceState.tracesById.get(pathTurnId);
      if (!trace) {
        throw new Error(`Chat turn ${pathTurnId} not found in source session ${input.sourceSessionId}`);
      }
      const userMessage = input.sourceState.messagesById.get(trace.userMessageId);
      if (!userMessage) {
        throw new Error(`User message ${trace.userMessageId} not found for turn ${pathTurnId}`);
      }

      const clonedTurnId = randomUUID();
      const clonedUserMessageId = randomUUID();
      let clonedAssistantMessageId: string | undefined;
      turnIdMap.set(pathTurnId, clonedTurnId);
      messageCopies.push({
        ...userMessage,
        messageId: clonedUserMessageId,
        sessionId: input.targetSessionId,
      });

      if (trace.assistantMessageId) {
        const assistantMessage = input.sourceState.messagesById.get(trace.assistantMessageId);
        if (assistantMessage) {
          clonedAssistantMessageId = `assistant-${randomUUID()}`;
          messageCopies.push({
            ...assistantMessage,
            messageId: clonedAssistantMessageId,
            sessionId: input.targetSessionId,
          });
        }
      }

      traceCopies.push({
        turnId: clonedTurnId,
        sessionId: input.targetSessionId,
        userMessageId: clonedUserMessageId,
        parentTurnId: trace.parentTurnId ? turnIdMap.get(trace.parentTurnId) : undefined,
        branchKind: trace.branchKind,
        sourceTurnId: trace.sourceTurnId ? turnIdMap.get(trace.sourceTurnId) : undefined,
        assistantMessageId: clonedAssistantMessageId,
        status: trace.status,
        mode: trace.mode,
        model: trace.model,
        webMode: trace.webMode,
        memoryMode: trace.memoryMode,
        thinkingLevel: trace.thinkingLevel,
        effectiveToolAutonomy: trace.effectiveToolAutonomy,
        routing: trace.routing,
        retrieval: trace.retrieval,
        reflection: trace.reflection,
        proactive: trace.proactive,
        completion: trace.completion,
        durable: trace.durable,
        orchestration: trace.orchestration,
        guidance: trace.guidance,
        citations: trace.citations,
        capabilityUpgradeSuggestions: trace.capabilityUpgradeSuggestions,
        specialistCandidateSuggestions: trace.specialistCandidateSuggestions,
        failure: trace.failure,
        startedAt: trace.startedAt,
        finishedAt: trace.finishedAt,
      });
    }

    this.storage.chatMessages.upsertMany(messageCopies);
    for (const traceCopy of traceCopies) {
      this.storage.chatTurnTraces.create(traceCopy);
    }

    const clonedSourceTurnId = turnIdMap.get(input.sourceTurnId);
    if (!clonedSourceTurnId) {
      throw new Error(`Failed to clone replay source turn ${input.sourceTurnId}`);
    }
    return { sourceTurnId: clonedSourceTurnId };
  }

  public async *retryChatTurnStream(
    sessionId: string,
    turnId: string,
    overrides: Partial<ChatSendMessageRequest> = {},
    _signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamChunk> {
    yield* this.chatTurnRuntime.retryChatTurnStream(sessionId, turnId, overrides);
  }

  public async editChatTurn(
    sessionId: string,
    turnId: string,
    input: ChatSendMessageRequest,
  ): Promise<ChatSendMessageResponse> {
    return this.chatTurnRuntime.editChatTurn(sessionId, turnId, input);
  }

  public async *editChatTurnStream(
    sessionId: string,
    turnId: string,
    input: ChatSendMessageRequest,
    _signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamChunk> {
    yield* this.chatTurnRuntime.editChatTurnStream(sessionId, turnId, input);
  }

  public async cancelChatTurn(
    sessionId: string,
    turnId: string,
    cancelledBy?: string,
  ): Promise<ChatCancelTurnResponse> {
    return this.chatTurnRuntime.cancelChatTurn(sessionId, turnId, cancelledBy);
  }

  /** @internal */ public async collectCapabilityUpgradeSuggestions(input: {
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
        lookupSkillSources: (queryOrUrl, limit) => this.lookupSkillSources(queryOrUrl, limit),
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

  /** @internal */ public recordCapabilityGapFromTrace(input: {
    sessionId: string;
    turnId: string;
    content: string;
    trace: ChatTurnTraceRecord;
  }): void {
    if (this.isReplayScratchSession(input.sessionId)) {
      return;
    }
    const suggestions = input.trace.capabilityUpgradeSuggestions ?? [];
    const toolRun = [...input.trace.toolRuns]
      .reverse()
      .find((item) => item.status === "blocked" || item.status === "approval_required" || item.status === "failed");
    const requestedTool = toolRun?.toolName;
    const failureClass = input.trace.failure?.failureClass;
    const classified = classifyCapabilityGapFromTrace({
      trace: input.trace,
      suggestions,
    });

    if (!classified) {
      return;
    }

    try {
      this.improvementService.recordCapabilityGapEvent({
        sessionId: input.sessionId,
        turnId: input.turnId,
        causeClass: classified.causeClass,
        failureClass,
        promptExcerpt: truncateSummaryLine(input.content, 240),
        promptRef: input.turnId,
        requestedTool,
        toolFamily: requestedTool?.split(".")[0],
        toolProfile: this.config.assistant.defaultToolProfile || this.config.toolPolicy.tools.profile,
        policyReason: toolRun?.error ?? input.trace.failure?.message,
        providerId: input.trace.routing.effectiveProviderId ?? input.trace.routing.primaryProviderId,
        model: input.trace.model ?? input.trace.routing.effectiveModel,
        configArea: classified.configArea,
        suggestedRepairClass: classified.suggestedRepairClass,
        confidence: classified.confidence,
        recoveryOptions: classified.recoveryOptions,
      });
      if (toolRun?.toolName && failureClass) {
        this.improvementService.recordFocusedToolFailureSignal({
          workspaceId: input.trace.guidance?.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          durableRunId: input.trace.durable?.runId,
          toolName: toolRun.toolName,
          providerId: input.trace.routing.effectiveProviderId ?? input.trace.routing.primaryProviderId,
          model: input.trace.model ?? input.trace.routing.effectiveModel,
          failureClass,
          operationPhase: toolRun.status,
          policyReason: toolRun.error ?? input.trace.failure?.message,
        });
      }
    } catch (error) {
      log.warn("failed to record capability gap", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async consumePreparedAgentChatTurn(
    sessionId: string,
    input: ChatSendMessageRequest,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
    resolvedOrchestration?: PreparedChatExecutionPlanResolution,
  ): Promise<ChatSendMessageResponse> {
    return chatTurnDispatchService.consumePreparedAgentChatTurn(
      this,
      sessionId,
      input,
      prepared,
      threadEventType,
      resolvedOrchestration,
    );
  }

  private shouldUseDurableExecution(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    input: ChatSendMessageRequest,
  ): boolean {
    return chatTurnDispatchService.shouldUseDurableExecution(this, prepared, input);
  }

  private parseDurableChatTurnPayload(run: DurableRunRecord): DurableChatTurnExecutionPayload | undefined {
    return durableExecutionService.parseDurableChatTurnPayload(run);
  }

  private parseApprovalWaitWorkflowPayload(run: DurableRunRecord): ApprovalWaitWorkflowPayload | undefined {
    return durableExecutionService.parseApprovalWaitWorkflowPayload(run);
  }

  private parseProactiveTickWorkflowPayload(run: DurableRunRecord): ProactiveTickWorkflowPayload | undefined {
    return durableExecutionService.parseProactiveTickWorkflowPayload(run);
  }

  private parseConnectorDeliveryWorkflowPayload(run: DurableRunRecord): ConnectorDeliveryWorkflowPayload | undefined {
    return durableExecutionService.parseConnectorDeliveryWorkflowPayload(run);
  }

  private parseHookDeliveryWorkflowPayload(run: DurableRunRecord) {
    return durableExecutionService.parseHookDeliveryWorkflowPayload(run);
  }

  private parseOrchestrationWorkflowPayload(run: DurableRunRecord): OrchestrationPlanWorkflowPayload | undefined {
    return durableExecutionService.parseOrchestrationWorkflowPayload(run);
  }

  private parseMemoryMaintenanceWorkflowPayload(run: DurableRunRecord) {
    return this.memoryLifecycleService.parseMaintenanceWorkflowPayload(run);
  }

  /** @internal */ public resolveDurableRunHookWorkspaceId(run: DurableRunRecord): string {
    if (run.workflowKey === "memory.maintenance") {
      const payload = this.parseMemoryMaintenanceWorkflowPayload(run);
      if (payload?.workspaceId) {
        return this.normalizeWorkspaceId(payload.workspaceId);
      }
      return DEFAULT_WORKSPACE_ID;
    }
    if (run.workflowKey === "hook.delivery") {
      const payload = this.parseHookDeliveryWorkflowPayload(run);
      if (payload?.workspaceId) {
        return this.normalizeWorkspaceId(payload.workspaceId);
      }
      return DEFAULT_WORKSPACE_ID;
    }
    if (run.workflowKey === "connector.delivery") {
      const payload = this.parseConnectorDeliveryWorkflowPayload(run);
      const workspaceId = typeof payload?.payload?.workspaceId === "string" ? payload.payload.workspaceId.trim() : "";
      if (workspaceId) {
        return this.normalizeWorkspaceId(workspaceId);
      }
      return DEFAULT_WORKSPACE_ID;
    }
    if (run.workflowKey === "approval.wait") {
      const payload = this.parseApprovalWaitWorkflowPayload(run);
      if (payload) {
        try {
          const approval = this.storage.approvals.get(payload.approvalId);
          return this.resolveApprovalHookWorkspaceId({
            approvalId: approval.approvalId,
            ...(approval.payload ?? {}),
          });
        } catch {
          return DEFAULT_WORKSPACE_ID;
        }
      }
      return DEFAULT_WORKSPACE_ID;
    }
    if (run.workflowKey === "chat.turn.execute") {
      const payload = this.parseDurableChatTurnPayload(run);
      if (payload?.sessionId) {
        const meta = this.storage.chatSessionMeta.get(payload.sessionId);
        if (meta?.workspaceId) {
          return this.normalizeWorkspaceId(meta.workspaceId);
        }
      }
    }
    if (run.workflowKey === "proactive.tick") {
      const payload = this.parseProactiveTickWorkflowPayload(run);
      if (payload?.sessionId) {
        const meta = this.storage.chatSessionMeta.get(payload.sessionId);
        if (meta?.workspaceId) {
          return this.normalizeWorkspaceId(meta.workspaceId);
        }
      }
    }
    if (run.workflowKey === "orchestration.plan.execute") {
      const payload = this.parseOrchestrationWorkflowPayload(run);
      if (payload?.workspaceId) {
        return this.normalizeWorkspaceId(payload.workspaceId);
      }
    }
    return DEFAULT_WORKSPACE_ID;
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

  /** @internal */ public beginDurableChatRun(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    input: ChatSendMessageRequest,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  ): DurableRunRecord | undefined {
    return chatDurableRunService.beginDurableChatRun(
      {
        shouldUseDurableExecution: this.shouldUseDurableExecution(prepared, input),
        createDurableRun: (runInput) => this.createDurableRun(runInput),
        buildDurablePayloadRecord: (preparedTurn, request, eventType) =>
          durableChatTurnPayloadToRecord(this.createDurableChatTurnPayload(preparedTurn, request, eventType)),
        persistChatStreamChunk: (chunk, durableRunId) => this.persistChatStreamChunk(chunk, durableRunId),
        requestDurableRunProcessing: (runId) => this.durableRunService.requestRunProcessing(runId),
      },
      prepared,
      input,
      threadEventType,
    );
  }

  /** @internal */ public finalizeDurableChatRun(
    runId: string,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    trace: ChatTurnTraceRecord,
  ): void {
    chatDurableRunService.finalizeDurableChatRun(
      {
        durableRuns: this.storage.durableRuns,
        chatToolRuns: this.storage.chatToolRuns,
        chatToolArtifacts: this.storage.chatToolArtifacts,
        recordDurableTimelineEvent: (durableRunId, eventType, payload) =>
          this.recordDurableTimelineEvent(durableRunId, eventType, payload),
        patchDurableTraceIfPresent: (turnId, patch) => this.patchDurableTraceIfPresent(turnId, patch),
      },
      runId,
      prepared,
      trace,
    );
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
    return chatTurnDispatchService.executePreparedAgentChatTurnBackground(
      this,
      sessionId,
      input,
      prepared,
      threadEventType,
      durableRunId,
      resolvedOrchestration,
      options,
    );
  }

  private launchPreparedAgentChatTurnStream(
    sessionId: string,
    input: ChatSendMessageRequest,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
    resolvedOrchestration?: PreparedChatExecutionPlanResolution,
  ): void {
    chatTurnDispatchService.launchPreparedAgentChatTurnStream(
      this,
      sessionId,
      input,
      prepared,
      threadEventType,
      resolvedOrchestration,
    );
  }

  public async *resumeAgentChatTurnStream(
    sessionId: string,
    turnId: string,
    sinceEventId?: string,
    _signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamChunk> {
    yield* this.chatTurnRuntime.resumeAgentChatTurnStream(sessionId, turnId, sinceEventId);
  }

  private async sendPreparedIntegrationChatTurn(
    sessionId: string,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    binding: ChatSessionBindingRecord,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  ): Promise<ChatSendMessageResponse> {
    return chatTurnDispatchService.sendPreparedIntegrationChatTurn(this, sessionId, prepared, binding, threadEventType);
  }

  private async *streamPreparedIntegrationChatTurn(
    sessionId: string,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    binding: ChatSessionBindingRecord,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  ): AsyncGenerator<ChatStreamChunkDraft> {
    yield* chatTurnDispatchService.streamPreparedIntegrationChatTurn(
      this,
      sessionId,
      prepared,
      binding,
      threadEventType,
    );
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
    const storageRelPath = path.posix.join(rootPath, "attachments", year, month, `${attachmentId}-${fileName}`);
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
        type:
          mediaType === "image"
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
    return this.backupRetentionService.listBackups(limit);
  }

  public async createBackup(input?: { name?: string; outputPath?: string }): Promise<BackupCreateResponse> {
    return this.backupRetentionService.createBackup(input);
  }

  public async verifyBackup(input: { filePath: string }): Promise<BackupVerifyResponse> {
    return this.backupRetentionService.verifyBackup(input);
  }

  public getRetentionPolicy(): RetentionPolicy {
    return this.backupRetentionService.getRetentionPolicy();
  }

  public updateRetentionPolicy(input: Partial<RetentionPolicy>): RetentionPolicy {
    return this.backupRetentionService.updateRetentionPolicy(input);
  }

  public async pruneRetention(options: { dryRun?: boolean } = {}): Promise<RetentionPruneResult> {
    return this.backupRetentionService.pruneRetention(options);
  }

  public async runDatabaseCutover(input: {
    profile: DatabaseCutoverProfile;
    execute: boolean;
    confirm?: boolean;
  }): Promise<DatabaseCutoverResponse> {
    return this.databaseCutoverService.runCutover(input);
  }

  public async verifyDatabaseCutover(input: { source: string; target?: string }): Promise<DatabaseVerifyResponse> {
    return this.databaseCutoverService.verify(input);
  }

  public async getDatabaseHealthSnapshot(): Promise<DatabaseHealthSnapshot> {
    return this.databaseCutoverService.getHealthSnapshot();
  }

  public async invokeTool(request: ToolInvokeRequest): Promise<ToolInvokeResult> {
    return this.toolInvocationCoordinator.invokeTool(request);
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

  private applyRuntimeBrowserBackendDefaults(request: ToolInvokeRequest): ToolInvokeRequest {
    if (!request.args || typeof request.args !== "object") {
      return request;
    }
    const firecrawl = this.config.assistant.web.firecrawl;
    const args = { ...request.args } as Record<string, unknown>;
    const explicitBackend = typeof args.backend === "string" ? args.backend.trim().toLowerCase() : undefined;
    const wantsFirecrawl =
      firecrawl.enabled &&
      (explicitBackend === "firecrawl" || (!explicitBackend && firecrawl.defaultReadBackend === "firecrawl"));

    if (
      request.toolName === "browser.search" ||
      request.toolName === "browser.navigate" ||
      request.toolName === "browser.extract"
    ) {
      if (!explicitBackend && firecrawl.enabled) {
        args.backend = firecrawl.defaultReadBackend;
      }
      if (wantsFirecrawl) {
        args.firecrawlBaseUrl = args.firecrawlBaseUrl ?? firecrawl.baseUrl;
        args.firecrawlTimeoutMs = args.firecrawlTimeoutMs ?? firecrawl.timeoutMs;
        args.firecrawlApiKeyEnv = args.firecrawlApiKeyEnv ?? firecrawl.apiKeyEnv;
        args.firecrawlFallbackToNative = args.firecrawlFallbackToNative ?? firecrawl.fallbackToNative;
      }
      return { ...request, args };
    }

    if (request.toolName === "docs.ingest" && args.sourceType === "url") {
      if (!explicitBackend && firecrawl.enabled && firecrawl.defaultReadBackend === "firecrawl") {
        args.backend = "firecrawl";
      }
      if (args.backend === "firecrawl") {
        args.firecrawlBaseUrl = args.firecrawlBaseUrl ?? firecrawl.baseUrl;
        args.firecrawlTimeoutMs = args.firecrawlTimeoutMs ?? firecrawl.timeoutMs;
        args.firecrawlApiKeyEnv = args.firecrawlApiKeyEnv ?? firecrawl.apiKeyEnv;
      }
      return { ...request, args };
    }

    return request;
  }

  public listToolCatalog(): ToolCatalogEntry[] {
    return this.policyEngine.listCatalog();
  }

  public evaluateToolAccess(input: ToolAccessEvaluateRequest): ToolAccessEvaluateResponse {
    return this.policyEngine.evaluateAccess({
      ...input,
      workspaceId:
        input.workspaceId ?? this.storage.chatSessionMeta.get(input.sessionId)?.workspaceId ?? DEFAULT_WORKSPACE_ID,
    });
  }

  public listToolGrants(
    scope?: "global" | "session" | "workspace" | "agent" | "task",
    scopeRef?: string,
    limit = 200,
  ): ToolGrantRecord[] {
    return this.approvalRuntime.listToolGrants(scope, scopeRef, limit);
  }

  public createToolGrant(input: ToolGrantCreateInput): ToolGrantRecord {
    return this.approvalRuntime.createToolGrant(input);
  }

  public revokeToolGrant(grantId: string): boolean {
    return this.approvalRuntime.revokeToolGrant(grantId);
  }

  public async createApproval(input: ApprovalCreateInput): Promise<ApprovalRequest> {
    return this.approvalRuntime.createApproval(input);
  }

  public createApprovalRemoteActionToken(
    approvalId: string,
    input: {
      connectorId: string;
      issuedBy?: string;
      expiresInMs?: number;
    },
  ): RemoteApprovalActionTokenIssueResult {
    return this.approvalRuntime.createApprovalRemoteActionToken(approvalId, input);
  }

  public async resolveApprovalWithRemoteToken(input: {
    token: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
  }): Promise<ApprovalResolveResult> {
    return this.approvalRuntime.resolveApprovalWithRemoteToken(input);
  }

  public async resolveApprovalWithRemoteTokenId(input: {
    tokenId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
  }): Promise<ApprovalResolveResult> {
    return this.approvalRuntime.resolveApprovalWithRemoteTokenId(input);
  }

  public listApprovals(status?: ApprovalRequest["status"], limit = 100): ApprovalRequest[] {
    return this.approvalRuntime.listApprovals(status, limit);
  }

  public async resolveApprovalsBulk(input: ApprovalBulkResolveInput): Promise<ApprovalBulkResolveResult> {
    return this.approvalRuntime.resolveApprovalsBulk(input);
  }

  public getApprovalReplay(approvalId: string, replayedBy = "operator"): ApprovalReplayResult {
    return this.approvalRuntime.getApprovalReplay(approvalId, replayedBy);
  }

  /** @internal */ public findProactiveDurableRunIdsForApproval(approvalId: string): string[] {
    return this.chatProactiveService.findDurableRunIdsForApproval(approvalId);
  }

  private findDurableRunMaybe(runId: string): DurableRunRecord | undefined {
    try {
      return this.storage.durableRuns.getRun(runId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return undefined;
      }
      throw error;
    }
  }

  public async resolveApproval(approvalId: string, input: ApprovalResolveInput): Promise<ApprovalResolveResult> {
    return this.approvalRuntime.resolveApproval(approvalId, input);
  }

  /** @internal */ public ensureApprovalWaitDurableRun(approval: ApprovalRequest): DurableRunRecord | undefined {
    return this.approvalWaitRunService.ensureApprovalWaitDurableRun(approval);
  }

  /** @internal */ public enqueueApprovalRemoteTokenDelivery(
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
      payload:
        toPlainRecord({
          ...payload,
          traceId: requestAttribution.traceId,
          originSurface: requestAttribution.originSurface,
        }) ?? {},
      metadata: {
        approvalId: approval.approvalId,
        connectorId: connector.connectorId,
        connectorType: connector.connectorType,
        deliveryKind: "approval.remote_token",
        tokenId: tokenRecord.tokenId,
      },
    });
  }

  /** @internal */ public getCurrentRequestAttribution(): {
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

  /** @internal */ public buildApprovalLinkage(
    linkage?: ApprovalRequest["linkage"],
  ): ApprovalRequest["linkage"] | undefined {
    return this.approvalWaitRunService.buildApprovalLinkage(linkage);
  }

  /** @internal */ public buildApprovalRealtimeLinks(approval: ApprovalRequest): NonNullable<RealtimeEvent["links"]> {
    return this.approvalWaitRunService.buildApprovalRealtimeLinks(approval);
  }

  /** @internal */ public buildTaskRealtimeLinks(
    task?: TaskRecord,
    fallbackTaskId?: string,
  ): NonNullable<RealtimeEvent["links"]> {
    return {
      ...(task?.taskId || fallbackTaskId ? { taskId: task?.taskId ?? fallbackTaskId } : {}),
      ...(task?.workspaceId ? { workspaceId: task.workspaceId } : {}),
      ...(task?.proactiveContext?.sessionId ? { sessionId: task.proactiveContext.sessionId } : {}),
      ...(task?.proactiveContext?.durableRunId ? { runId: task.proactiveContext.durableRunId } : {}),
      ...(task?.proactiveContext?.proactiveRunId ? { proactiveRunId: task.proactiveContext.proactiveRunId } : {}),
      ...(task?.proactiveContext?.approvalId ? { approvalId: task.proactiveContext.approvalId } : {}),
    };
  }

  /** @internal */ public enqueueApprovalResolutionEffects(
    approval: ApprovalRequest,
    input: ApprovalResolveInput,
  ): ApprovalEffectRecord[] {
    return this.approvalEffectsService.enqueueResolutionEffects(approval, input);
  }

  /** @internal */ public primeApprovalLifecycle(
    approvalId: string,
    linkage?: ApprovalRequest["linkage"],
  ): ApprovalRequest {
    return this.approvalWaitRunService.primeApprovalLifecycle(approvalId, linkage);
  }

  /** @internal */ public requireConnectorRecord(connectorId: string): ConnectorRecord {
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

  /** @internal */ public consumeRemoteActionToken(
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

  /** @internal */ public consumeRemoteActionTokenById(
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

  public costSummary(scope: "session" | "day" | "agent" | "task", from: string, to: string) {
    return this.storage.costLedger.summary(scope, from, to);
  }

  public costUsageAvailability(from: string, to: string) {
    return this.storage.costLedger.usageAvailability(from, to);
  }

  public runCheaper() {
    return {
      mode: "saver",
      actions: ["trim context", "summarize tool outputs", "reduce fanout"],
    };
  }

  public listSkills(): SkillListItem[] {
    this.ensureSkillStates(this.skillsService.list().map((skill) => skill.skillId));
    return this.capabilitySystemService.listSkills();
  }

  public async reloadSkills(): Promise<SkillListItem[]> {
    const loaded = await this.skillsService.reload();
    this.ensureSkillStates(loaded.map((skill) => skill.skillId));
    this.capabilitySystemService.ensureSkillLifecycleBackfill();
    return this.listSkills();
  }

  public listCapabilityCatalog(scope: CapabilityCatalogScope = "inspectable") {
    return this.capabilitySystemService.listCatalog(scope);
  }

  public getCapabilityCatalogSnapshot(snapshotId: string): CapabilityCatalogSnapshotRecord {
    return this.capabilitySystemService.getCatalogSnapshot(snapshotId);
  }

  public getCapabilityCandidateDetail(candidateId: string) {
    return this.capabilitySystemService.getCandidateDetail(candidateId);
  }

  public listCapabilityProposals(limit = 100): CapabilityProposalRecord[] {
    return this.capabilitySystemService.listProposals(limit);
  }

  public getCapabilityProposalDetail(proposalId: string) {
    return this.capabilitySystemService.getProposalDetail(proposalId);
  }

  public createCapabilityProposal(input: {
    proposalKind: "skill" | "tool";
    title: string;
    summary: string;
    payload: Record<string, unknown>;
    candidateId?: string;
    activationTargetId?: string;
  }): CapabilityProposalRecord {
    return this.capabilitySystemService.createProposal(input);
  }

  public listCodeModeRuns(limit = 100): CodeModeRunRecord[] {
    return this.capabilitySystemService.listCodeModeRuns(limit);
  }

  public getCodeModeRun(runId: string): CodeModeRunRecord {
    return this.capabilitySystemService.getCodeModeRun(runId);
  }

  public async createCodeModeRun(input: CodeModeRunRequest): Promise<CodeModeRunRecord> {
    return this.capabilitySystemService.createCodeModeRun(input);
  }

  public promoteCapabilityCandidate(candidateId: string, versionId?: string) {
    return this.capabilitySystemService.promoteCandidate(candidateId, versionId);
  }

  public revokeCapabilityCandidate(candidateId: string, versionId?: string) {
    return this.capabilitySystemService.revokeCandidate(candidateId, versionId);
  }

  public rollbackCapabilityCandidate(candidateId: string, targetVersionId: string) {
    return this.capabilitySystemService.rollbackCandidate(candidateId, targetVersionId);
  }

  public async executeCodeModePendingApproval(
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<ToolInvokeResult | undefined> {
    return this.capabilitySystemService.executeApprovedCodeModeRun(approvalId, signal);
  }

  public listChatPendingApprovals(sessionId: string): CodeModeApprovalQueueItem[] {
    return this.capabilitySystemService.listChatPendingApprovals(sessionId);
  }

  public getSkillActivationPolicy(): SkillActivationPolicy {
    const stored = this.storage.systemSettings.get<SkillActivationPolicy>(SKILL_ACTIVATION_POLICY_SETTING_KEY)?.value;
    if (!stored) {
      return { ...DEFAULT_SKILL_ACTIVATION_POLICY };
    }
    return {
      guardedAutoThreshold: clamp01(
        stored.guardedAutoThreshold ?? DEFAULT_SKILL_ACTIVATION_POLICY.guardedAutoThreshold,
      ),
      requireFirstUseConfirmation:
        stored.requireFirstUseConfirmation ?? DEFAULT_SKILL_ACTIVATION_POLICY.requireFirstUseConfirmation,
    };
  }

  public updateSkillActivationPolicy(input: Partial<SkillActivationPolicy>): SkillActivationPolicy {
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
    const rows = this.gatewaySql
      .prepare(
        `
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
    `,
      )
      .all({
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
      details: row.detailsJson ? safeJsonParse<Record<string, unknown>>(row.detailsJson, {}) : undefined,
      createdAt: row.createdAt,
    }));
  }

  public setSkillState(skillId: string, state: SkillRuntimeState, note?: string): SkillStateRecord {
    const knownSkill = this.skillsService.list().find((skill) => skill.skillId === skillId);
    if (!knownSkill) {
      throw new Error(`Unknown skill: ${skillId}`);
    }
    const now = new Date().toISOString();
    this.gatewaySql
      .prepare(
        `
      INSERT INTO skill_state (skill_id, state, note, updated_at, first_auto_approved_at)
      VALUES (@skillId, @state, @note, @updatedAt, NULL)
      ON CONFLICT(skill_id) DO UPDATE SET
        state = excluded.state,
        note = excluded.note,
        updated_at = excluded.updated_at
    `,
      )
      .run({
        skillId,
        state,
        note: note?.trim() || null,
        updatedAt: now,
      });

    this.gatewaySql
      .prepare(
        `
      INSERT INTO skill_activation_events (
        event_id, skill_id, event_type, payload_json, created_at
      ) VALUES (
        @eventId, @skillId, @eventType, @payloadJson, @createdAt
      )
    `,
      )
      .run({
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

  public bulkSetSkillState(skillIds: string[], state: SkillRuntimeState, note?: string): SkillStateRecord[] {
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
        state === "sleep" && policy.requireFirstUseConfirmation && !isExplicit && !stateRecord?.firstAutoApprovedAt;

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
    this.publishRealtime(
      "task_created",
      "tasks",
      {
        task: created,
      },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: this.buildTaskRealtimeLinks(created),
      },
    );
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
    this.publishRealtime(
      "task_updated",
      "tasks",
      {
        task: updated,
      },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: this.buildTaskRealtimeLinks(updated),
      },
    );
    return updated;
  }

  public softDeleteTask(taskId: string, deletedBy?: string, deleteReason?: string): boolean {
    const existing = this.storage.tasks.find(taskId);
    const deleted = this.storage.tasks.softDelete(taskId, deletedBy, deleteReason);
    if (deleted) {
      this.publishRealtime(
        "task_deleted",
        "tasks",
        { taskId, mode: "soft" },
        {
          eventClass: "domain_fact",
          eventAuthority: "retained_stream",
          links: this.buildTaskRealtimeLinks(existing, taskId),
        },
      );
    }
    return deleted;
  }

  public restoreTask(taskId: string): boolean {
    const restored = this.storage.tasks.restore(taskId);
    if (restored) {
      this.publishRealtime(
        "task_restored",
        "tasks",
        { taskId },
        {
          eventClass: "domain_fact",
          eventAuthority: "retained_stream",
          links: this.buildTaskRealtimeLinks(this.storage.tasks.find(taskId), taskId),
        },
      );
    }
    return restored;
  }

  public hardDeleteTask(taskId: string): boolean {
    const existing = this.storage.tasks.find(taskId);
    const deleted = this.storage.tasks.hardDelete(taskId);
    if (deleted) {
      this.publishRealtime(
        "task_deleted",
        "tasks",
        { taskId, mode: "hard" },
        {
          eventClass: "domain_fact",
          eventAuthority: "retained_stream",
          links: this.buildTaskRealtimeLinks(existing, taskId),
        },
      );
    }
    return deleted;
  }

  public listTaskActivities(taskId: string, limit = 200): TaskActivityRecord[] {
    this.storage.tasks.get(taskId);
    return this.storage.taskActivities.listByTask(taskId, limit);
  }

  public appendTaskActivity(taskId: string, input: TaskActivityCreateInput): TaskActivityRecord {
    const task = this.storage.tasks.get(taskId);
    const activity = this.storage.taskActivities.append(taskId, input);
    this.publishRealtime(
      "activity_logged",
      "tasks",
      {
        taskId,
        activity,
      },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: this.buildTaskRealtimeLinks(task),
      },
    );
    return activity;
  }

  public listTaskDeliverables(taskId: string, limit = 200): TaskDeliverableRecord[] {
    this.storage.tasks.get(taskId);
    return this.storage.taskDeliverables.listByTask(taskId, limit);
  }

  public appendTaskDeliverable(taskId: string, input: TaskDeliverableCreateInput): TaskDeliverableRecord {
    const task = this.storage.tasks.get(taskId);
    const deliverable = this.storage.taskDeliverables.append(taskId, input);
    this.publishRealtime(
      "deliverable_added",
      "tasks",
      {
        taskId,
        deliverable,
      },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: this.buildTaskRealtimeLinks(task),
      },
    );
    return deliverable;
  }

  public listTaskSubagents(taskId: string, limit = 200): TaskSubagentSession[] {
    this.storage.tasks.get(taskId);
    return this.storage.taskSubagents.listByTask(taskId, limit);
  }

  public registerTaskSubagent(taskId: string, input: TaskSubagentCreateInput): TaskSubagentSession {
    const task = this.storage.tasks.get(taskId);
    const session = this.storage.taskSubagents.create(taskId, input);
    this.publishRealtime(
      "subagent_registered",
      "tasks",
      {
        taskId,
        session,
      },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: this.buildTaskRealtimeLinks(task),
      },
    );
    return session;
  }

  public updateTaskSubagent(agentSessionId: string, input: TaskSubagentUpdateInput): TaskSubagentSession {
    const updated = this.storage.taskSubagents.updateByAgentSessionId(agentSessionId, {
      ...input,
      endedAt: input.endedAt ?? (input.status && input.status !== "active" ? new Date().toISOString() : undefined),
    });

    this.publishRealtime(
      "subagent_updated",
      "tasks",
      {
        taskId: updated.taskId,
        session: updated,
      },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: this.buildTaskRealtimeLinks(this.storage.tasks.find(updated.taskId), updated.taskId),
      },
    );
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
    return cronSchedulerService.listCronJobs(this);
  }

  public getCronJob(jobId: string): CronJobRecord {
    return cronSchedulerService.getCronJob(this, jobId);
  }

  public createCronJob(input: {
    jobId: string;
    name: string;
    action?: CronJobRecord["action"];
    description?: string;
    schedule: string;
    enabled?: boolean;
    endAt?: string;
  }): CronJobRecord {
    return cronSchedulerService.createCronJob(this, input);
  }

  public updateCronJob(
    jobId: string,
    input: {
      name?: string;
      action?: CronJobRecord["action"];
      description?: string;
      schedule?: string;
      enabled?: boolean;
      endAt?: string | null;
    },
  ): CronJobRecord {
    return cronSchedulerService.updateCronJob(this, jobId, input);
  }

  public setCronJobEnabled(jobId: string, enabled: boolean): CronJobRecord {
    return cronSchedulerService.setCronJobEnabled(this, jobId, enabled);
  }

  public deleteCronJob(jobId: string): { deleted: boolean; jobId: string } {
    return cronSchedulerService.deleteCronJob(this, jobId);
  }

  public async runCronJobNow(jobId: string): Promise<{ jobId: string; status: "ok" }> {
    return cronSchedulerService.runCronJobNow(this, jobId);
  }

  public listCronReviewQueue(limit = 200): CronReviewItem[] {
    return cronSchedulerService.listCronReviewQueue(this, limit);
  }

  public retryCronReviewQueueItem(itemId: string): CronReviewItem {
    return cronSchedulerService.retryCronReviewQueueItem(this, itemId);
  }

  public getCronRunDiff(runId: string): CronRunDiff {
    return cronSchedulerService.getCronRunDiff(this, runId);
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

  public getLatestFollowOnParityArtifacts(): FollowOnProofLaneArtifactIndex {
    const stored = this.storage.systemSettings.get<unknown>(FOLLOW_ON_PARITY_ARTIFACTS_SETTING_KEY)?.value;
    return mergeLatestFollowOnParityArtifacts(
      normalizeFollowOnParityArtifactIndex(stored),
      this.config.rootDir,
      this.config.assistant.workspaceDir,
      this.config.assistant.deploymentProfile,
    );
  }

  public getPackagingProofCoverage(): FollowOnProfileCoverageRecord {
    const now = new Date();
    const byProfile = readLatestFollowOnParityArtifactsByProfile(
      this.config.rootDir,
      this.config.assistant.workspaceDir,
      "packaging",
    );
    const currentProfiles: DeploymentProfile[] = [];
    const staleProfiles: DeploymentProfile[] = [];
    for (const profile of ["local_dev", "trusted_local", "remote_hardened"] as const) {
      const artifact = byProfile[profile];
      if (!artifact) {
        continue;
      }
      if (isCurrentFollowOnParityArtifact(artifact, now, ["complete"])) {
        currentProfiles.push(profile);
      } else {
        staleProfiles.push(profile);
      }
    }
    return buildFollowOnProfileCoverage({ currentProfiles, staleProfiles });
  }

  public getVoiceProofCoverage(): FollowOnProfileCoverageRecord {
    const now = new Date();
    const bundleByProfile = readLatestFollowOnParityArtifactsByProfile(
      this.config.rootDir,
      this.config.assistant.workspaceDir,
      "voice",
    );
    const evidenceByProfile = readLatestVoiceEvidenceArtifactsByProfile(
      this.config.rootDir,
      this.config.assistant.workspaceDir,
    );
    const currentProfiles: DeploymentProfile[] = [];
    const staleProfiles: DeploymentProfile[] = [];
    for (const profile of ["local_dev", "trusted_local", "remote_hardened"] as const) {
      const bundle = bundleByProfile[profile];
      const evidence = evidenceByProfile[profile];
      if (!bundle && !evidence) {
        continue;
      }
      if (
        isCurrentFollowOnParityArtifact(bundle, now, ["draft", "complete"]) &&
        isCurrentFollowOnParityArtifact(evidence, now, ["evidence"])
      ) {
        currentProfiles.push(profile);
      } else {
        staleProfiles.push(profile);
      }
    }
    return buildFollowOnProfileCoverage({ currentProfiles, staleProfiles });
  }

  public rememberFollowOnParityArtifact(record: FollowOnProofLaneArtifactRecord): FollowOnProofLaneArtifactRecord {
    const normalized = normalizeFollowOnParityArtifactRecord(record.laneId, record);
    if (!normalized) {
      throw new ValidationError({ message: `Invalid follow-on parity artifact for lane ${record.laneId}` });
    }
    this.storage.systemSettings.set(FOLLOW_ON_PARITY_ARTIFACTS_SETTING_KEY, {
      ...this.getLatestFollowOnParityArtifacts(),
      [normalized.laneId]: normalized,
    });
    return normalized;
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
    const content = isText ? await fs.readFile(fullPath, "utf8") : await fs.readFile(fullPath);

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
    return this.memoryLifecycleService.listMemoryFiles(relativeDir);
  }

  public async listWorkspaceFiles(relativeDir = ".", maxItems = 1000): Promise<MemoryFileEntry[]> {
    const normalized = relativeDir === "." ? "." : this.normalizeRelativePath(relativeDir);
    const baseDir =
      normalized === "."
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
    return this.memoryLifecycleService.composeContext(input);
  }

  public getMemoryContext(contextId: string): MemoryContextPack {
    return this.memoryLifecycleService.getContext(contextId);
  }

  public listRunContexts(runId: string): MemoryContextPack[] {
    return this.memoryLifecycleService.listRunContexts(runId);
  }

  public listRecentMemoryContexts(limit = 60): MemoryContextPack[] {
    return this.memoryLifecycleService.listRecentContexts(limit);
  }

  public getMemoryQmdStats(from: string, to: string): MemoryQmdStatsResponse {
    return this.memoryLifecycleService.getContextStats(from, to);
  }

  public getTurnContextManifest(turnId: string): ContextManifestDetail | undefined {
    const normalizedTurnId = turnId.trim();
    if (!normalizedTurnId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "turnId" });
    }
    return this.storage.contextManifests.maybeGetDetailByTurn(normalizedTurnId);
  }

  public getTurnContextManifestForSession(sessionId: string, turnId: string): ContextManifestDetail | undefined {
    const normalizedSessionId = sessionId.trim();
    const normalizedTurnId = turnId.trim();
    if (!normalizedSessionId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "sessionId" });
    }
    if (!normalizedTurnId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "turnId" });
    }
    const trace = this.storage.chatTurnTraces.get(normalizedTurnId);
    if (trace.sessionId !== normalizedSessionId) {
      throw new Error(`Chat turn ${normalizedTurnId} does not belong to session ${normalizedSessionId}`);
    }
    return this.storage.contextManifests.maybeGetDetailByTurn(normalizedTurnId);
  }

  /** @internal */ public persistContextManifestForCompletionRequest(input: {
    request: ChatCompletionRequest;
    memoryContext?: MemoryContextPack;
  }): void {
    const turnId = input.request.memory?.turnId?.trim();
    if (!turnId) {
      return;
    }

    const manifest = this.storage.contextManifests.ensure({
      scope: "chat_turn",
      turnId,
      sessionId: input.request.memory?.sessionId?.trim(),
      taskId: input.request.memory?.taskId?.trim(),
    });
    const memoryContextSystemMessage = input.memoryContext
      ? buildMemoryContextSystemMessage(input.memoryContext)
      : undefined;
    let entryIndex = 0;

    for (const [messageIndex, message] of input.request.messages.entries()) {
      if (message.role !== "system" || typeof message.content !== "string") {
        continue;
      }
      const contentText = message.content.trim();
      if (!contentText) {
        continue;
      }
      if (memoryContextSystemMessage && contentText === memoryContextSystemMessage) {
        continue;
      }
      this.storage.contextManifests.appendEntry({
        manifestId: manifest.manifestId,
        kind: "system_message",
        entryIndex,
        title: contentText.split(/\r?\n/u, 1)[0]?.slice(0, 120) || "System message",
        sourceRef: `system:${messageIndex}`,
        contentText,
        metadata: {
          role: message.role,
          messageIndex,
        },
      });
      entryIndex += 1;
    }

    if (!input.memoryContext) {
      return;
    }

    this.storage.contextManifests.appendEntry({
      manifestId: manifest.manifestId,
      kind: "memory_context",
      entryIndex,
      title: "Memory context",
      sourceRef: input.memoryContext.contextId,
      contentText: input.memoryContext.contextText,
      metadata: {
        scope: input.memoryContext.scope,
        status: input.memoryContext.quality.status,
        reason: input.memoryContext.quality.reason,
        citationsCount: input.memoryContext.citations.length,
        originalTokenEstimate: input.memoryContext.originalTokenEstimate,
        distilledTokenEstimate: input.memoryContext.distilledTokenEstimate,
        createdAt: input.memoryContext.createdAt,
        expiresAt: input.memoryContext.expiresAt,
      },
    });
  }

  public listMemoryItems(
    input: {
      namespace?: string;
      status?: MemoryItemRecord["status"] | "all";
      query?: string;
      limit?: number;
    } = {},
  ): MemoryItemRecord[] {
    return this.memoryLifecycleService.listMemoryItems(input);
  }

  public patchMemoryItem(itemId: string, patch: MemoryLifecyclePatch, actorId = "operator"): MemoryItemRecord {
    return this.memoryLifecycleService.patchMemoryItem(itemId, patch, actorId);
  }

  public forgetMemoryItem(itemId: string, actorId = "operator"): MemoryItemRecord {
    return this.memoryLifecycleService.forgetMemoryItem(itemId, actorId);
  }

  public forgetMemory(
    input: {
      itemIds?: string[];
      namespace?: string;
      query?: string;
      actorId?: string;
    } = {},
  ): { forgottenCount: number; itemIds: string[] } {
    return this.memoryLifecycleService.forgetMemory(input);
  }

  public listMemoryItemHistory(itemId: string, limit = 200): MemoryChangeEvent[] {
    return this.memoryLifecycleService.listMemoryItemHistory(itemId, limit);
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

  public listImportedAgentCatalog(input: ImportedAgentCatalogListInput = {}): {
    workspaceId: string;
    divisions: string[];
    items: ImportedAgentCatalogRecord[];
  } {
    const workspaceId = this.normalizeWorkspaceId(input.workspaceId);
    return {
      workspaceId,
      divisions: this.storage.importedAgentCatalog.listDivisions(workspaceId),
      items: this.storage.importedAgentCatalog.list({
        ...input,
        workspaceId,
      }),
    };
  }

  public getImportedAgentCatalogEntry(entryId: string): ImportedAgentCatalogRecord {
    return this.storage.importedAgentCatalog.get(entryId);
  }

  public patchImportedAgentCatalogEntryState(
    entryId: string,
    input: ImportedAgentCatalogStatePatchInput,
  ): ImportedAgentCatalogRecord {
    const updated = this.storage.importedAgentCatalog.patchState(entryId, input);
    this.publishRealtime("system", "agents", {
      type: "imported_agent_catalog_updated",
      entryId: updated.entryId,
      workspaceId: updated.workspaceId,
      state: updated.state,
    });
    return updated;
  }

  public async importAgencyAgentCatalog(input: AgencyCatalogImportRequest = {}): Promise<AgencyCatalogImportResponse> {
    const workspaceId = this.normalizeWorkspaceId(input.workspaceId);
    const imported = await importAgencyCatalog({
      storage: this.storage,
      workspaceId,
      repoUrl: input.repoUrl,
      ref: input.ref,
    });
    this.publishRealtime("system", "agents", {
      type: "imported_agent_catalog_imported",
      workspaceId,
      importedCount: imported.importedCount,
      ref: imported.ref,
      repoUrl: imported.repoUrl,
    });
    return imported;
  }

  public activateImportedAgentCatalogEntryForSession(
    sessionId: string,
    entryId: string,
  ): {
    catalogEntry: ImportedAgentCatalogRecord;
    specialist: ChatSpecialistCandidateRecord;
  } {
    this.getSession(sessionId);
    const sessionWorkspaceId = this.normalizeWorkspaceId(this.storage.chatSessionMeta.ensure(sessionId).workspaceId);
    const entry = this.storage.importedAgentCatalog.get(entryId);
    if (entry.workspaceId !== sessionWorkspaceId) {
      throw new Error("Imported catalog entry belongs to a different workspace.");
    }

    const prefs = this.getChatSessionPrefs(sessionId);
    const draft = this.createChatSessionSpecialistCandidate(sessionId, {
      suggestion: buildCatalogSpecialistSuggestion(
        entry,
        prefs.mode,
        extractSpecialistObjectiveKeywords(entry.definition.frontmatter.description),
      ),
    });
    const specialist = this.storage.chatSpecialistCandidates.patch(draft.candidateId, {
      status: "active",
      routingMode: "manual_only",
    });
    const catalogEntry =
      entry.state === "active"
        ? entry
        : this.storage.importedAgentCatalog.patchState(entryId, {
            state: "active",
          });
    this.publishRealtime("system", "agents", {
      type: "imported_agent_catalog_activated",
      entryId,
      workspaceId: catalogEntry.workspaceId,
      sessionId,
      candidateId: specialist.candidateId,
    });
    return {
      catalogEntry,
      specialist,
    };
  }

  public getSettings(): RuntimeSettings {
    return settingsAuthService.getSettings(this);
  }

  public getOnboardingState(): OnboardingState {
    const startedAt = Date.now();
    const auth = this.getAuthRuntimeSettings();
    const afterAuth = Date.now();
    const baseLlm = this.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: false,
      useCache: true,
    });
    const afterBaseLlm = Date.now();
    const activeProviderQuick = baseLlm.providers.find((provider) => provider.providerId === baseLlm.activeProviderId);
    const activeProviderStatus =
      activeProviderQuick && !activeProviderQuick.hasApiKey
        ? this.llmService.getProviderSecretStatus(baseLlm.activeProviderId, {
            includeKeychain: true,
            useCache: true,
          })
        : undefined;
    const afterActiveProviderStatus = Date.now();
    const llm = {
      ...baseLlm,
      providers: baseLlm.providers.map((provider) =>
        provider.providerId !== activeProviderStatus?.providerId
          ? provider
          : {
              ...provider,
              hasApiKey: activeProviderStatus.hasApiKey,
              apiKeySource: activeProviderStatus.apiKeySource,
              hasKeychainSecret: activeProviderStatus.hasKeychainSecret,
              apiKeyRef: activeProviderStatus.apiKeyRef,
            },
      ),
    };
    const afterLlmMap = Date.now();
    const mesh = {
      enabled: this.config.assistant.mesh.enabled,
      mode: this.config.assistant.mesh.mode,
      nodeId: this.config.assistant.mesh.nodeId,
      mdns: this.config.assistant.mesh.discovery.mdns,
      staticPeers: this.config.assistant.mesh.discovery.staticPeers,
      requireMtls: this.config.assistant.mesh.security.requireMtls,
      tailnetEnabled: this.config.assistant.mesh.security.tailnet.enabled,
    };
    const defaultToolProfile = this.config.toolPolicy.tools.profile;
    const budgetMode = this.config.budgets.mode;
    const networkAllowlist = this.config.toolPolicy.sandbox.networkAllowlist;
    const activeProvider = llm.providers.find((provider) => provider.providerId === llm.activeProviderId);
    const authReady = this.isAuthConfiguredForMode(auth);
    const llmReady = Boolean(
      activeProvider &&
      llm.activeModel.trim() &&
      (activeProvider.hasApiKey || this.isProviderLikelyLocal(activeProvider.baseUrl)),
    );
    const runtimeReady = Boolean(defaultToolProfile.trim()) && Boolean(budgetMode.trim());
    const meshReady = mesh.enabled
      ? Boolean(mesh.nodeId.trim()) && (mesh.mode !== "tailnet" || mesh.tailnetEnabled)
      : true;
    const afterReadiness = Date.now();

    const checklist: OnboardingChecklistItem[] = [
      {
        id: "auth",
        label: "Gateway access control",
        status: authReady ? "complete" : "needs_input",
        detail: authReady
          ? `Mode ${auth.mode} is configured.`
          : "Configure token/basic credentials or explicitly choose none for local trusted use.",
      },
      {
        id: "llm",
        label: "LLM provider",
        status: llmReady ? "complete" : "needs_input",
        detail: llmReady
          ? `Provider ${llm.activeProviderId} with model ${llm.activeModel} is ready.`
          : "Select an active provider/model and configure an API key (or use a local endpoint).",
      },
      {
        id: "runtime",
        label: "Runtime defaults",
        status: runtimeReady ? "complete" : "needs_input",
        detail: runtimeReady
          ? `Profile ${defaultToolProfile} / budget ${budgetMode}.`
          : "Choose a default tool profile and budget mode.",
      },
      {
        id: "mesh",
        label: "Mesh (optional)",
        status: mesh.enabled ? (meshReady ? "complete" : "needs_input") : "optional",
        detail: mesh.enabled
          ? `Mesh ${mesh.mode} on node ${mesh.nodeId}.`
          : "Mesh disabled. You can enable this later.",
      },
    ];
    const afterChecklist = Date.now();
    const projectedProviders = llm.providers.map((provider) => ({
      providerId: provider.providerId,
      label: provider.label,
      baseUrl: provider.baseUrl,
      apiStyle: provider.apiStyle,
      resolvedApiStyle: this.llmService.resolveExecutionApiStyle(provider.providerId, provider.defaultModel),
      defaultModel: provider.defaultModel,
      hasApiKey: provider.hasApiKey,
      apiKeySource: provider.apiKeySource,
      hasKeychainSecret: provider.hasKeychainSecret,
      apiKeyRef: provider.apiKeyRef,
    }));
    const afterProviderProjection = Date.now();

    const response: OnboardingState = {
      completed: Boolean(this.onboardingMarker.completedAt),
      completedAt: this.onboardingMarker.completedAt,
      completedBy: this.onboardingMarker.completedBy,
      checklist,
      settings: {
        defaultToolProfile,
        budgetMode,
        networkAllowlist,
        auth,
        llm: {
          activeProviderId: llm.activeProviderId,
          activeModel: llm.activeModel,
          providers: projectedProviders,
        },
        mesh,
      },
    };
    const completedAt = Date.now();
    if (onboardingTimingEnabled) {
      log.info("onboarding state timing", {
        totalMs: completedAt - startedAt,
        authMs: afterAuth - startedAt,
        baseLlmMs: afterBaseLlm - afterAuth,
        activeProviderStatusMs: afterActiveProviderStatus - afterBaseLlm,
        llmMapMs: afterLlmMap - afterActiveProviderStatus,
        readinessMs: afterReadiness - afterLlmMap,
        checklistMs: afterChecklist - afterReadiness,
        providerProjectionMs: afterProviderProjection - afterChecklist,
        responseWrapMs: completedAt - afterProviderProjection,
        assembleMs: completedAt - afterLlmMap,
        providerCount: llm.providers.length,
        activeProviderId: llm.activeProviderId,
        activeProviderQuickHasApiKey: activeProviderQuick?.hasApiKey ?? null,
        activeProviderStatusSource: activeProviderStatus?.apiKeySource ?? null,
      });
    }
    return response;
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

  public updateSettings(input: settingsAuthService.UpdateSettingsInput): RuntimeSettings {
    return settingsAuthService.updateSettings(this, input);
  }

  public getDeploymentProfile(): DeploymentProfile {
    return this.config.assistant.deploymentProfile;
  }

  /** @internal */ public assertDeploymentProfileUpdate(input: {
    deploymentProfile?: DeploymentProfile;
    auth?: AuthSettingsUpdateInput;
    networkAllowlist?: string[];
    web?: {
      firecrawl?: {
        enabled?: boolean;
        baseUrl?: string;
      };
    };
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

  /** @internal */ public assertFirecrawlRuntimeUpdate(input: {
    networkAllowlist?: string[];
    web?: {
      firecrawl?: {
        enabled?: boolean;
        baseUrl?: string;
      };
    };
  }): void {
    const nextAllowlist = (input.networkAllowlist ?? this.config.toolPolicy.sandbox.networkAllowlist)
      .map((host) => host.trim())
      .filter(Boolean);
    const nextEnabled = input.web?.firecrawl?.enabled ?? this.config.assistant.web.firecrawl.enabled;
    const nextBaseUrl = input.web?.firecrawl?.baseUrl?.trim() || this.config.assistant.web.firecrawl.baseUrl;

    if (!nextEnabled) {
      return;
    }
    if (!this.isUrlAllowlistedInList(nextBaseUrl, nextAllowlist)) {
      throw new Error(
        `web.firecrawl.baseUrl must be present in the outbound allowlist before Firecrawl can be enabled: ${nextBaseUrl}`,
      );
    }
  }

  public getAuthRuntimeSettings(): AuthRuntimeSettings {
    return settingsAuthService.getAuthRuntimeSettings(this);
  }

  public updateAuthSettings(input: AuthSettingsUpdateInput): AuthRuntimeSettings {
    return settingsAuthService.updateAuthSettings(this, input);
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

  public createDeviceAccessRequest(
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
    return settingsAuthService.createDeviceAccessRequest(this, input, context);
  }

  public getDeviceAccessRequestStatus(
    requestId: string,
    requestSecret: string,
  ): Promise<DeviceAccessRequestStatusResponse> {
    return settingsAuthService.getDeviceAccessRequestStatus(this, requestId, requestSecret);
  }

  public getOnboardingStartupState(): OnboardingStartupState {
    return {
      completed: Boolean(this.onboardingMarker.completedAt),
      completedAt: this.onboardingMarker.completedAt,
      completedBy: this.onboardingMarker.completedBy,
    };
  }

  public listDeviceAccessGrants(): DeviceAccessGrantContractRecord[] {
    return settingsAuthService.listDeviceAccessGrants(this);
  }

  public revokeDeviceAccessGrant(grantId: string, revokedBy: string): Promise<DeviceAccessGrantContractRecord> {
    return settingsAuthService.revokeDeviceAccessGrant(this, grantId, revokedBy);
  }

  public validateDeviceAccessToken(token: string): { actorId: string; deviceId: string; grantId: string } | undefined {
    return settingsAuthService.validateDeviceAccessToken(this, token);
  }

  public exchangeCompanionSessionFromDeviceGrant(
    grantId: string,
    input: CompanionSessionExchangeInput,
  ): Promise<CompanionSessionExchangeResponse> {
    return settingsAuthService.exchangeCompanionSessionFromDeviceGrant(this, grantId, input);
  }

  public rotateCompanionSession(input: CompanionSessionRefreshInput): Promise<CompanionSessionRefreshResponse> {
    return settingsAuthService.rotateCompanionSession(this, input);
  }

  public getCompanionSessionInfo(sessionId: string): CompanionSessionInfoResponse {
    return settingsAuthService.getCompanionSessionInfo(this, sessionId);
  }

  public listCompanionSessions(options?: {
    view?: "active" | "all";
    grantId?: string;
    limit?: number;
  }): CompanionSessionListResponse {
    return settingsAuthService.listCompanionSessions(this, options);
  }

  public getCompanionSessionRecord(sessionId: string): CompanionSessionAdminRecord {
    return settingsAuthService.getCompanionSessionRecord(this, sessionId);
  }

  public revokeCompanionSession(sessionId: string, revokedBy: string): Promise<CompanionSessionRevokeResponse> {
    return settingsAuthService.revokeCompanionSession(this, sessionId, revokedBy);
  }

  public listCompanionAuditEvents(options?: {
    sessionId?: string;
    grantId?: string;
    limit?: number;
  }): Promise<CompanionAuditEventRecord[]> {
    return settingsAuthService.listCompanionAuditEvents(this, options);
  }

  public validateCompanionAccessToken(token: string): CompanionAccessValidationResult | undefined {
    return settingsAuthService.validateCompanionAccessToken(this, token);
  }

  public verifyCompanionRequestSignature(input: {
    sessionId: string;
    method: string;
    path: string;
    timestamp: string;
    nonce: string;
    signature: string;
    body: unknown;
  }): void {
    return settingsAuthService.verifyCompanionRequestSignature(this, input);
  }

  public listIntegrationCatalog(kind?: IntegrationKind): IntegrationCatalogEntry[] {
    const pluginIds = new Set(
      this.readIntegrationPlugins()
        .map((item) => item.pluginId.trim().toLowerCase())
        .filter((item) => item.length > 0),
    );
    const mapped = INTEGRATION_CATALOG.map((entry) => {
      return {
        ...entry,
        maturity: resolveIntegrationCatalogMaturity(entry, pluginIds),
        runtimeAvailability: resolveIntegrationCatalogRuntimeAvailability(entry, pluginIds),
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

  public getChannelSetupDefinition(catalogId: string): ChannelSetupDefinition {
    return channelSetupService.getChannelSetupDefinition(this, catalogId);
  }

  public listChannelSetupDefinitions(): ChannelSetupDefinition[] {
    return channelSetupService.listChannelSetupDefinitions(this);
  }

  public listChannelSetupDrafts(options?: {
    catalogId?: string;
    connectionId?: string;
    limit?: number;
  }): ChannelSetupDraft[] {
    return channelSetupService.listChannelSetupDrafts(this, options);
  }

  public createChannelSetupDraft(input: ChannelSetupDraftCreateInput): ChannelSetupDraft {
    return channelSetupService.createChannelSetupDraft(this, input);
  }

  public updateChannelSetupDraft(draftId: string, input: ChannelSetupDraftUpdateInput): ChannelSetupDraft {
    return channelSetupService.updateChannelSetupDraft(this, draftId, input);
  }

  public validateChannelSetupDraft(draftId: string): ChannelSetupValidationResult {
    return channelSetupService.validateChannelSetupDraft(this, draftId);
  }

  public async testChannelSetupDraft(draftId: string): Promise<ChannelSetupTestResult> {
    return channelSetupService.testChannelSetupDraft(this, draftId);
  }

  public async finalizeChannelSetupDraft(draftId: string): Promise<ChannelSetupFinalizeResult> {
    return channelSetupService.finalizeChannelSetupDraft(this, draftId);
  }

  public createChannelSetupRepairDraft(connectionId: string): ChannelSetupDraft {
    return channelSetupService.createChannelSetupRepairDraft(this, connectionId);
  }

  public createChannelSetupRotateSecretDraft(connectionId: string): ChannelSetupDraft {
    return channelSetupService.createChannelSetupRotateSecretDraft(this, connectionId);
  }

  public async retestChannelConnection(connectionId: string): Promise<ChannelSetupTestResult> {
    return channelSetupService.retestChannelConnection(this, connectionId);
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
    return listIntegrationConnectionsImpl(this, kind, limit);
  }

  public getIntegrationConnection(connectionId: string): IntegrationConnection {
    return getIntegrationConnectionImpl(this, connectionId);
  }

  public getIntegrationConnectionChannelCapabilities(connectionId: string): ChannelCapabilities {
    return getIntegrationConnectionChannelCapabilitiesImpl(this, connectionId);
  }

  public getIntegrationConnectionChannelRuntimeStatus(connectionId: string): ChannelRuntimeStatus {
    return getIntegrationConnectionChannelRuntimeStatusImpl(this, connectionId);
  }

  public async runIntegrationConnectionDiagnostics(connectionId: string): Promise<ConnectorDiagnosticReport> {
    return runIntegrationConnectionDiagnosticsImpl(this, connectionId);
  }

  public async invokeIntegrationConnectionAction(
    connectionId: string,
    actionId: string,
    input: IntegrationActionInvokeInput = {},
  ): Promise<IntegrationActionInvokeResult> {
    return invokeIntegrationConnectionActionImpl(this, connectionId, actionId, input);
  }

  public createIntegrationConnection(input: IntegrationConnectionCreateInput): IntegrationConnection {
    return createIntegrationConnectionImpl(this, input);
  }

  public updateIntegrationConnection(
    connectionId: string,
    input: IntegrationConnectionUpdateInput,
  ): IntegrationConnection {
    return updateIntegrationConnectionImpl(this, connectionId, input);
  }

  public deleteIntegrationConnection(connectionId: string): boolean {
    return deleteIntegrationConnectionImpl(this, connectionId);
  }

  public listDiscordPairings(connectionId: string): {
    runtime?: DiscordRuntimeStatus;
    items: DiscordPairingRecord[];
  } {
    return listDiscordPairingsImpl(this, connectionId);
  }

  public approveDiscordPairing(connectionId: string, pairingId: string): DiscordPairingRecord {
    return approveDiscordPairingImpl(this, connectionId, pairingId);
  }

  public revokeDiscordPairing(connectionId: string, pairingId: string): DiscordPairingRecord {
    return revokeDiscordPairingImpl(this, connectionId, pairingId);
  }

  public getDiscordRuntimeStatus(connectionId: string): DiscordRuntimeStatus | undefined {
    return this.discordRuntimeService.getConnectionStatus(connectionId);
  }

  public async reconnectDiscordRuntime(connectionId: string): Promise<DiscordRuntimeStatus | undefined> {
    return reconnectDiscordRuntimeImpl(this, connectionId);
  }

  public async emitDiscordTyping(
    connection: IntegrationConnection,
    input: ChannelTypingInput,
  ): Promise<ChannelTypingResult> {
    return this.discordRuntimeService.sendTyping(connection.connectionId, input.target, input.durationMs, input.signal);
  }

  public async emitTelegramTyping(
    connection: IntegrationConnection,
    input: ChannelTypingInput,
  ): Promise<ChannelTypingResult> {
    return emitTelegramTypingImpl(this, connection, input);
  }

  public listIntegrationPlugins(): IntegrationPluginRecord[] {
    return listIntegrationPluginsImpl(this);
  }

  public installIntegrationPlugin(input: IntegrationPluginInstallInput): IntegrationPluginRecord {
    return installIntegrationPluginImpl(this, input);
  }

  public setIntegrationPluginEnabled(pluginId: string, enabled: boolean): IntegrationPluginRecord {
    return setIntegrationPluginEnabledImpl(this, pluginId, enabled);
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
    const installedSkill = skills.find(
      (skill) => skill.source === "extra" && path.resolve(skill.dir) === path.resolve(installed.installedPath),
    );
    if (installedSkill) {
      this.setSkillState(installedSkill.skillId, "disabled", "Imported skill starts disabled by default.");
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
    return MCP_SERVER_TEMPLATES.filter(isVisibleMcpTemplateRecord).map((template) => ({
      ...template,
      installed: byTemplateId.has(template.label.toLowerCase()),
    }));
  }

  public listMcpTemplateDiscovery(): McpTemplateDiscoveryResult[] {
    return mcpDiagnosticsService.listMcpTemplateDiscovery(this);
  }

  public runMcpServerHealthCheck(serverId: string): ConnectorDiagnosticReport {
    return mcpDiagnosticsService.runMcpServerHealthCheck(this, serverId);
  }

  public createMcpServer(input: McpServerCreateInput): McpServerRecord {
    return mcpServerAdminService.createMcpServer(this, input);
  }

  public updateMcpServer(serverId: string, input: McpServerUpdateInput): McpServerRecord {
    return mcpServerAdminService.updateMcpServer(this, serverId, input);
  }

  public updateMcpServerPolicy(serverId: string, policy: Partial<McpServerPolicy>): McpServerRecord {
    return mcpServerAdminService.updateMcpServerPolicy(this, serverId, policy);
  }

  public deleteMcpServer(serverId: string): { deleted: boolean } {
    return mcpServerAdminService.deleteMcpServer(this, serverId);
  }

  public async connectMcpServer(serverId: string): Promise<McpServerRecord> {
    return mcpServerAdminService.connectMcpServer(this, serverId);
  }

  public disconnectMcpServer(serverId: string): McpServerRecord {
    return mcpServerAdminService.disconnectMcpServer(this, serverId);
  }

  public startMcpOAuth(serverId: string): McpOAuthStartResponse {
    return mcpServerAdminService.startMcpOAuth(this, serverId);
  }

  public async completeMcpOAuth(serverId: string, code: string, state?: string): Promise<McpServerRecord> {
    return mcpServerAdminService.completeMcpOAuth(this, serverId, code, state);
  }

  public listMcpTools(serverId: string): McpToolRecord[] {
    this.requireMcpServer(serverId);
    return this.readMcpTools()
      .filter((item) => item.serverId === serverId)
      .sort((left, right) => left.toolName.localeCompare(right.toolName));
  }

  public listMcpBrowserFallbackTargets(): ReturnType<typeof collectMcpBrowserFallbackTargets> {
    return collectMcpBrowserFallbackTargets(this.readMcpServers(), this.readMcpTools(), (serverId, toolName) =>
      this.isMcpToolApproved(serverId, toolName),
    );
  }

  public async invokeMcpTool(input: McpInvokeRequest): Promise<McpInvokeResponse> {
    return this.toolInvocationCoordinator.invokeMcpTool(input);
  }

  public createMediaJob(input: MediaCreateJobRequest): MediaJobRecord {
    return this.mediaVoiceService.createMediaJob(input);
  }

  public getMediaJob(jobId: string): MediaJobRecord {
    return this.mediaVoiceService.getMediaJob(jobId);
  }

  public listMediaJobs(sessionId?: string): MediaJobRecord[] {
    return this.mediaVoiceService.listMediaJobs(sessionId);
  }

  public getChatAttachmentPreview(attachmentId: string): ChatAttachmentPreviewResponse {
    return this.mediaVoiceService.getChatAttachmentPreview(attachmentId);
  }

  public async transcribeVoice(input: {
    bytesBase64: string;
    mimeType?: string;
    language?: string;
  }): Promise<VoiceTranscribeResponse> {
    return this.mediaVoiceService.transcribeVoice(input);
  }

  public async getVoiceStatus(): Promise<VoiceStatus> {
    return this.mediaVoiceService.getVoiceStatus();
  }

  public async getVoiceRuntimeStatus(): Promise<VoiceRuntimeStatus> {
    return this.mediaVoiceService.getVoiceRuntimeStatus();
  }

  public async installVoiceRuntime(input: VoiceRuntimeInstallRequest = {}): Promise<VoiceRuntimeStatus> {
    return this.mediaVoiceService.installVoiceRuntime(input);
  }

  public async selectVoiceRuntimeModel(modelId: string): Promise<VoiceRuntimeStatus> {
    return this.mediaVoiceService.selectVoiceRuntimeModel(modelId);
  }

  public async removeVoiceRuntimeModel(modelId: string): Promise<VoiceRuntimeStatus> {
    return this.mediaVoiceService.removeVoiceRuntimeModel(modelId);
  }

  public async startTalkSession(input?: {
    mode?: "push_to_talk" | "wake";
    sessionId?: string;
  }): Promise<VoiceTalkSessionRecord> {
    return this.mediaVoiceService.startTalkSession(input);
  }

  public listVoiceTalkSessions(limit = 20): VoiceTalkSessionRecord[] {
    return this.mediaVoiceService.listVoiceTalkSessions(limit);
  }

  public stopTalkSession(talkSessionId: string): VoiceTalkSessionRecord {
    return this.mediaVoiceService.stopTalkSession(talkSessionId);
  }

  public async startVoiceWake(): Promise<VoiceStatus["wake"]> {
    return this.mediaVoiceService.startVoiceWake();
  }

  public stopVoiceWake(): VoiceStatus["wake"] {
    return this.mediaVoiceService.stopVoiceWake();
  }

  public getDaemonStatus(): {
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
  } {
    const state = this.storage.systemSettings.get<{ state: "running" | "stopped"; lastCommandAt?: string }>(
      "daemon_state_v1",
    )?.value;
    return {
      running: true,
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      host: os.hostname(),
      state: "running",
      lastCommandAt: state?.lastCommandAt,
      requestedState: state?.state,
      supported: false,
      controllable: false,
      controlMessage:
        "This surface reports the current gateway process only. Start/stop/restart requires an external service manager and is not supported from Mission Control.",
    };
  }

  public daemonStart(): { accepted: boolean; reason: string; status: ReturnType<GatewayService["getDaemonStatus"]> } {
    const now = new Date().toISOString();
    this.appendDaemonLog("warn", {
      at: now,
      message: "Rejected Mission Control daemon start request because no process manager integration is available.",
    });
    return {
      accepted: false,
      reason: "Mission Control cannot start the gateway process directly on this host.",
      status: this.getDaemonStatus(),
    };
  }

  public daemonStop(): { accepted: boolean; reason: string; status: ReturnType<GatewayService["getDaemonStatus"]> } {
    const now = new Date().toISOString();
    this.appendDaemonLog("warn", {
      at: now,
      message: "Rejected Mission Control daemon stop request because no process manager integration is available.",
    });
    return {
      accepted: false,
      reason: "Mission Control cannot stop the gateway process directly on this host.",
      status: this.getDaemonStatus(),
    };
  }

  public daemonRestart(): { accepted: boolean; reason: string; status: ReturnType<GatewayService["getDaemonStatus"]> } {
    const now = new Date().toISOString();
    this.appendDaemonLog("warn", {
      at: now,
      message: "Rejected Mission Control daemon restart request because no process manager integration is available.",
    });
    return {
      accepted: false,
      reason: "Mission Control cannot restart the gateway process directly on this host.",
      status: this.getDaemonStatus(),
    };
  }

  public listDaemonLogs(tail = 200): Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }> {
    const rows =
      this.storage.systemSettings.get<Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }>>(
        DAEMON_LOG_TAIL_SETTING_KEY,
      )?.value ?? [];
    const bounded = Math.max(1, Math.min(2000, Math.floor(tail)));
    return rows.slice(-bounded);
  }

  public async commsSend(input: ChannelSendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsSendImpl(this, input);
  }

  public async commsReply(input: ChannelReplyInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsReplyImpl(this, input);
  }

  public async commsReact(input: ChannelReactInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsReactImpl(this, input);
  }

  public async commsUnsend(input: ChannelUnsendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsUnsendImpl(this, input);
  }

  public async commsTyping(input: ChannelTypingInput): Promise<ChannelTypingResult> {
    return commsTypingImpl(this, input);
  }

  public async commsGmailRead(input: GmailReadQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsGmailReadImpl(this, input);
  }

  public async commsGmailSend(input: GmailSendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsGmailSendImpl(this, input);
  }

  public async commsCalendarList(input: CalendarListQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsCalendarListImpl(this, input);
  }

  public async commsCalendarCreate(
    input: CalendarCreateEventInput,
  ): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsCalendarCreateImpl(this, input);
  }

  public async knowledgeMemoryWrite(input: MemoryWriteInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return knowledgeMemoryWriteImpl(this, input);
  }

  public async knowledgeMemorySearch(input: MemorySearchQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
    return knowledgeMemorySearchImpl(this, input);
  }

  public async knowledgeDocsIngest(input: DocsIngestInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return knowledgeDocsIngestImpl(this, input);
  }

  public async knowledgeEmbeddingsIndex(
    input: EmbeddingIndexInput,
  ): Promise<ToolInvokeResult | Record<string, unknown>> {
    return knowledgeEmbeddingsIndexImpl(this, input);
  }

  public async knowledgeEmbeddingsQuery(
    input: EmbeddingQueryInput,
  ): Promise<ToolInvokeResult | Record<string, unknown>> {
    return knowledgeEmbeddingsQueryImpl(this, input);
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

  public saveProviderSecret(
    providerId: string,
    apiKey: string,
  ): {
    providerId: string;
    hasSecret: boolean;
    source: "none" | "keychain" | "env" | "inline";
  } {
    const status = persistProviderApiKeyWithFallback({
      providerId,
      apiKey,
      rootDir: this.config.rootDir,
      llmService: this.llmService,
    });
    this.llmService.clearInlineProviderApiKey(providerId);
    this.persistLlmConfig();
    return status;
  }

  public deleteProviderSecret(providerId: string): {
    providerId: string;
    hasSecret: boolean;
    source: "none" | "keychain" | "env" | "inline";
  } {
    return deleteProviderApiKeyWithFallback({
      providerId,
      rootDir: this.config.rootDir,
      llmService: this.llmService,
    });
  }

  public getLlmConfig(): LlmRuntimeConfig {
    return this.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
  }

  public getLlmConfigWithDetails(): LlmRuntimeConfig & { providerConfigs: LlmConfigFile["providers"] } {
    return {
      ...this.getLlmConfig(),
      providerConfigs: this.llmService.exportConfigFile().providers,
    };
  }

  public updateLlmConfig(input: {
    activeProviderId?: string;
    activeModel?: string;
    upsertProvider?: {
      providerId: string;
      label?: string;
      baseUrl?: string;
      apiStyle?: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
      defaultModel?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      persistSecretToSecureStore?: boolean;
      request?: LlmProviderRequestConfig;
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
    apiStyle?: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
    apiKey?: string;
    apiKeyEnv?: string;
    request?: LlmProviderRequestConfig;
    headers?: Record<string, string>;
  }): Promise<{ items: LlmModelRecord[]; source: "remote" | "fallback"; warning?: string }> {
    return this.llmService.previewModels(input);
  }

  public async generateImage(input: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    return this.llmService.generateImage(input);
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

  public getLlamaCppStatus(): LlamaCppRuntimeStatus {
    return this.llamaCppRuntime.getStatus();
  }

  public async startLlamaCppRuntime(): Promise<LlamaCppRuntimeStatus> {
    const status = await this.llamaCppRuntime.start("api");
    this.publishRealtime("system", "llamacpp", {
      type: "llamacpp_started",
      status,
    });
    return status;
  }

  public async stopLlamaCppRuntime(): Promise<LlamaCppRuntimeStatus> {
    const status = await this.llamaCppRuntime.stop("api");
    this.publishRealtime("system", "llamacpp", {
      type: "llamacpp_stopped",
      status,
    });
    return status;
  }

  public async refreshLlamaCppRuntime(): Promise<LlamaCppRuntimeStatus> {
    const status = await this.llamaCppRuntime.refresh();
    this.publishRealtime("system", "llamacpp", {
      type: "llamacpp_refreshed",
      status,
    });
    return status;
  }

  public async listLlamaCppModels(): Promise<LlamaCppModelManifest[]> {
    return this.llamaCppRuntime.listModels();
  }

  public async detectLlamaCppInstall() {
    return this.llamaCppRuntime.detectLocalInstall();
  }

  public async startLlamaCppHuggingFaceDownload(input: {
    repo: string;
    filename: string;
    alias?: string;
    mmprojFilename?: string;
    sha256?: string;
    mmprojSha256?: string;
  }) {
    return this.llamaCppRuntime.startHuggingFaceDownload(input);
  }

  public getLlamaCppHuggingFaceDownload(jobId: string) {
    return this.llamaCppRuntime.getHuggingFaceDownloadStatus(jobId);
  }

  public cancelLlamaCppHuggingFaceDownload(jobId: string) {
    return this.llamaCppRuntime.cancelHuggingFaceDownload(jobId);
  }

  public async adviseLlamaCppRuntime(input: LlamaCppAdvisorRequest = {}): Promise<LlamaCppAdvisorRecommendation> {
    return this.llamaCppRuntime.advise(input);
  }

  public async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return llmCompletionService.createChatCompletion(this, request);
  }

  public async *createChatCompletionStream(request: ChatCompletionRequest): AsyncGenerator<Record<string, unknown>> {
    yield* llmCompletionService.createChatCompletionStream(this, request);
  }

  /** @internal */ public resolveFallbackTargets(
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

  public async createOrchestrationPlan(plan: OrchestrationPlan): Promise<OrchestrationRun> {
    return orchestrationLifecycleService.createOrchestrationPlan(this, plan);
  }

  public async runOrchestrationPlan(planId: string): Promise<OrchestrationRun> {
    return orchestrationLifecycleService.runOrchestrationPlan(this, planId);
  }

  public async approvePhase(
    runId: string,
    phaseId: string,
    approvedBy: string,
    costIncrementUsd = 0,
  ): Promise<{ run: OrchestrationRun; checkpoints: OrchestrationCheckpoint[] }> {
    return orchestrationLifecycleService.approvePhase(this, runId, phaseId, approvedBy, costIncrementUsd);
  }

  public getRun(runId: string): OrchestrationRun {
    return orchestrationLifecycleService.getRun(this, runId);
  }

  public listRunCheckpoints(runId: string): OrchestrationCheckpoint[] {
    return orchestrationLifecycleService.listRunCheckpoints(this, runId);
  }

  /** @internal */ public requestDurableRunProcessing(runId: string): void {
    this.durableRunService.requestRunProcessing(runId);
  }

  /** @internal */ public updateDurableRunState(input: {
    runId: string;
    status?: DurableRunRecord["status"];
    metadata?: Record<string, unknown>;
    lastError?: string;
    finishedAt?: string;
  }): DurableRunRecord {
    const current = this.storage.durableRuns.getRun(input.runId);
    return this.storage.durableRuns.updateRun({
      runId: input.runId,
      status: input.status ?? current.status,
      metadata: input.metadata ?? current.metadata,
      lastError: input.lastError,
      finishedAt: input.finishedAt,
      updatedAt: new Date().toISOString(),
      expectedVersion: current.version,
    });
  }

  /** @internal */ public async allocateOrchestrationWorktree(input: {
    runId: string;
    workspaceId: string;
    baseRef?: string;
  }): Promise<{
    worktreePath: string;
    worktreeStatus: NonNullable<OrchestrationRun["worktreeStatus"]>;
    worktreeBaseRef: string;
  }> {
    const baseRef = input.baseRef?.trim() || "HEAD";
    const worktreesRoot = path.resolve(this.config.rootDir, this.config.assistant.worktreesDir, "orchestration");
    const targetPath = path.resolve(worktreesRoot, input.runId);
    await fs.mkdir(worktreesRoot, { recursive: true });
    assertWritePathInJail(targetPath, this.config.toolPolicy.sandbox.writeJailRoots);
    const gitDirPath = path.join(targetPath, ".git");
    if (fsSync.existsSync(targetPath) && !fsSync.existsSync(gitDirPath)) {
      throw new ValidationError({
        message:
          "Orchestration worktree path already exists but is not a valid git worktree. Clean it up before retrying.",
      });
    }
    if (!fsSync.existsSync(targetPath)) {
      const manager = new WorktreeManager({
        repoRoot: this.config.rootDir,
        worktreesRoot,
      });
      await manager.create(input.runId, baseRef);
    }
    return {
      worktreePath: targetPath,
      worktreeStatus: "ready",
      worktreeBaseRef: baseRef,
    };
  }

  /** @internal */ public async executeDurableOrchestrationRun(
    run: DurableRunRecord,
    context?: durableExecutionService.DurableWorkflowExecutionContext,
  ): Promise<{ outcome: "paused" | "completed"; checkpointState: Record<string, unknown> }> {
    return orchestrationLifecycleService.executeDurableOrchestrationRun(this, run, context);
  }

  public getBankrOptionalMigrationMessage(): string {
    return BANKR_OPTIONAL_MIGRATION_MESSAGE;
  }

  private enforceDurableExecutionBaseline(): void {
    const durable = this.config.assistant.durable;
    const configuredFeatureFlag = this.config.assistant.features.durableKernelV1Enabled;
    const stored =
      this.storage.systemSettings.get<Partial<RuntimeSettings["features"]>>(FEATURE_FLAGS_SETTING_KEY)?.value;
    const driftedFields: string[] = [];
    if (!durable.enabled) {
      driftedFields.push("assistant.durable.enabled");
    }
    if (!durable.executionEnabled) {
      driftedFields.push("assistant.durable.executionEnabled");
    }
    if (!durable.chatAutoPromoteEnabled) {
      driftedFields.push("assistant.durable.chatAutoPromoteEnabled");
    }
    if (!configuredFeatureFlag) {
      driftedFields.push("features.durableKernelV1Enabled");
    }
    if (stored?.durableKernelV1Enabled === false) {
      driftedFields.push("feature_flags_v1.durableKernelV1Enabled");
    }

    if (driftedFields.length > 0) {
      log.warn("durable baseline drift detected; coercing always-on durable execution", {
        driftedFields,
      });
    }
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
    if (patch.durableKernelV1Enabled === false) {
      throw new ValidationError({
        message: "features.durableKernelV1Enabled is a shipped baseline runtime setting and cannot be disabled.",
      });
    }
    const current = this.readFeatureFlags();
    const next: RuntimeSettings["features"] = {
      durableKernelV1Enabled: true,
      replayOverridesV1Enabled: patch.replayOverridesV1Enabled ?? current.replayOverridesV1Enabled,
      memoryLifecycleAdminV1Enabled: patch.memoryLifecycleAdminV1Enabled ?? current.memoryLifecycleAdminV1Enabled,
      memoryMaintenanceV1Enabled: patch.memoryMaintenanceV1Enabled ?? current.memoryMaintenanceV1Enabled,
      connectorDiagnosticsV1Enabled: patch.connectorDiagnosticsV1Enabled ?? current.connectorDiagnosticsV1Enabled,
      computerUseGuardrailsV1Enabled: patch.computerUseGuardrailsV1Enabled ?? current.computerUseGuardrailsV1Enabled,
      bankrBuiltinEnabled: patch.bankrBuiltinEnabled ?? current.bankrBuiltinEnabled,
      cronReviewQueueV1Enabled: patch.cronReviewQueueV1Enabled ?? current.cronReviewQueueV1Enabled,
      replayRegressionV1Enabled: patch.replayRegressionV1Enabled ?? current.replayRegressionV1Enabled,
      codeModeV1Enabled: patch.codeModeV1Enabled ?? current.codeModeV1Enabled,
      improvementLedgerV1Enabled: patch.improvementLedgerV1Enabled ?? current.improvementLedgerV1Enabled,
      improvementActivationV1Enabled: patch.improvementActivationV1Enabled ?? current.improvementActivationV1Enabled,
    };
    this.storage.systemSettings.set(FEATURE_FLAGS_SETTING_KEY, next);
    this.config.assistant.features = { ...next };
    return next;
  }

  private applyStoredFeatureFlags(): void {
    this.config.assistant.features = this.readFeatureFlags();
  }

  /** @internal */ public readFeatureFlags(): RuntimeSettings["features"] {
    const stored =
      this.storage.systemSettings.get<Partial<RuntimeSettings["features"]>>(FEATURE_FLAGS_SETTING_KEY)?.value;
    const fromConfig = this.config.assistant.features;
    return {
      durableKernelV1Enabled: true,
      replayOverridesV1Enabled: stored?.replayOverridesV1Enabled ?? fromConfig.replayOverridesV1Enabled,
      memoryLifecycleAdminV1Enabled: stored?.memoryLifecycleAdminV1Enabled ?? fromConfig.memoryLifecycleAdminV1Enabled,
      memoryMaintenanceV1Enabled: stored?.memoryMaintenanceV1Enabled ?? fromConfig.memoryMaintenanceV1Enabled,
      connectorDiagnosticsV1Enabled: stored?.connectorDiagnosticsV1Enabled ?? fromConfig.connectorDiagnosticsV1Enabled,
      computerUseGuardrailsV1Enabled:
        stored?.computerUseGuardrailsV1Enabled ?? fromConfig.computerUseGuardrailsV1Enabled,
      bankrBuiltinEnabled: stored?.bankrBuiltinEnabled ?? fromConfig.bankrBuiltinEnabled,
      cronReviewQueueV1Enabled: stored?.cronReviewQueueV1Enabled ?? fromConfig.cronReviewQueueV1Enabled,
      replayRegressionV1Enabled: stored?.replayRegressionV1Enabled ?? fromConfig.replayRegressionV1Enabled,
      codeModeV1Enabled: stored?.codeModeV1Enabled ?? fromConfig.codeModeV1Enabled,
      improvementLedgerV1Enabled: stored?.improvementLedgerV1Enabled ?? fromConfig.improvementLedgerV1Enabled,
      improvementActivationV1Enabled:
        stored?.improvementActivationV1Enabled ?? fromConfig.improvementActivationV1Enabled,
    };
  }

  private normalizeDurableRetryPolicy(input: Partial<DurableRetryPolicy> | undefined): DurableRetryPolicy {
    return this.durableRunService.normalizeDurableRetryPolicy(input);
  }

  /** @internal */ public computeDurableRetryDelayMs(current: DurableRunRecord, attemptNo: number): number {
    return this.durableRunService.computeDurableRetryDelayMs(current, attemptNo);
  }

  /** @internal */ public recordDurableTimelineEvent(
    runId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
    stepKey?: string,
  ): DurableRunTimelineEvent {
    return this.durableRunService.recordDurableTimelineEvent(runId, eventType, payload, stepKey);
  }

  /** @internal */ public recordImprovementDurableRunCompletion(
    run: DurableRunRecord,
    checkpointState: Record<string, unknown>,
  ): void {
    this.improvementService.recordDurableRunCompletionSignal({
      run,
      checkpointState,
    });
  }

  // normalizeReplayOverrides, replaceReplayOverrideSteps, computeReplayDiffSummary moved to ImprovementService

  public recordConnectorHealthRun(report: ConnectorDiagnosticReport): void {
    return connectorDiagnosticsHelpers.recordConnectorHealthRun(this, report);
  }

  public pickConnectorDiagnosticAction(checks: ConnectorDiagnosticReport["checks"]): string | undefined {
    return connectorDiagnosticsHelpers.pickConnectorDiagnosticAction(checks);
  }

  /** @internal */ public buildIntegrationConnectionChecks(
    connection: IntegrationConnection,
  ): ConnectorDiagnosticReport["checks"] {
    return integrationDiagnosticsService.buildIntegrationConnectionChecks(this, connection);
  }

  /** @internal */ public async runIntegrationConnectionLiveChecks(
    connection: IntegrationConnection,
    options: {
      includeSandboxSend: boolean;
    },
  ): Promise<{ checks: ConnectorDiagnosticReport["checks"]; probe?: ChannelProbeReport }> {
    return integrationDiagnosticsService.runIntegrationConnectionLiveChecks(this, connection, options);
  }

  public async syncDiscordRuntime(): Promise<void> {
    try {
      await this.discordRuntimeService.sync();
    } catch (error) {
      this.recordDevDiagnostic({
        level: "warn",
        category: "channels",
        event: "discord.runtime.sync_failed",
        message: "Discord runtime sync failed.",
        context: {
          error: (error as Error).message,
        },
      });
    }
  }

  public async fetchWithDiagnosticsTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  public readConnectionConfigValue(config: Record<string, unknown>, key: string): string | undefined {
    const value = config[key];
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  public resolveConnectionSecret(
    config: Record<string, unknown>,
    directKey: string,
    envKey: string,
  ): string | undefined {
    const direct = this.readConnectionConfigValue(config, directKey);
    if (direct) {
      return direct;
    }
    const envName = this.readConnectionConfigValue(config, envKey);
    return envName ? process.env[envName] : undefined;
  }

  public readDiscordPairings(): DiscordPairingRecord[] {
    return this.storage.systemSettings.get<DiscordPairingRecord[]>(DISCORD_PAIRINGS_SETTING_KEY)?.value ?? [];
  }

  public writeDiscordPairings(records: DiscordPairingRecord[]): void {
    this.storage.systemSettings.set(DISCORD_PAIRINGS_SETTING_KEY, records);
  }

  private findApprovedDiscordPairing(connectionId: string, userId: string): DiscordPairingRecord | undefined {
    return discordPairingHelpers.findApprovedDiscordPairing(this, connectionId, userId);
  }

  private ensurePendingDiscordPairing(
    connectionId: string,
    userId: string,
    displayName?: string,
  ): DiscordPairingRecord {
    return discordPairingHelpers.ensurePendingDiscordPairing(this, connectionId, userId, displayName);
  }

  private touchDiscordPairing(pairingId: string): void {
    return discordPairingHelpers.touchDiscordPairing(this, pairingId);
  }

  /** @internal */ public readDiscordRouteSessions(): discordRuntimeBridgeService.DiscordRouteSessionRecord[] {
    return discordRuntimeBridgeService.readDiscordRouteSessions(this);
  }

  /** @internal */ public writeDiscordRouteSessions(
    records: discordRuntimeBridgeService.DiscordRouteSessionRecord[],
  ): void {
    return discordRuntimeBridgeService.writeDiscordRouteSessions(this, records);
  }

  /** @internal */ public resolveDiscordInboundRoute(input: {
    connectionId: string;
    target: string;
    peer?: string;
    room?: string;
    threadId?: string;
  }): {
    peer?: string;
    room?: string;
    threadId?: string;
  } {
    return discordRuntimeBridgeService.resolveDiscordInboundRoute(this, input);
  }

  /** @internal */ public ensureDiscordChatSession(input: {
    connectionId: string;
    target: string;
    displayName?: string;
    peer?: string;
    room?: string;
    threadId?: string;
  }): ChatSessionRecord {
    return discordRuntimeBridgeService.ensureDiscordChatSession(this, input);
  }

  /** @internal */ public cloneChatSessionContext(sourceSessionId: string, targetSessionId: string): void {
    return discordRuntimeBridgeService.cloneChatSessionContext(this, sourceSessionId, targetSessionId);
  }

  /** @internal */ public startNewDiscordRouteSession(input: {
    connectionId: string;
    target: string;
    displayName?: string;
    peer?: string;
    room?: string;
    threadId?: string;
    title?: string;
  }): ChatSessionRecord {
    return discordRuntimeBridgeService.startNewDiscordRouteSession(this, input);
  }

  /** @internal */ public async handleDiscordRuntimeSlashCommand(input: {
    connectionId: string;
    target: string;
    actorId: string;
    displayName?: string;
    commandText: string;
    sourceCommandId: string;
    peer?: string;
    room?: string;
    threadId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    return discordRuntimeBridgeService.handleDiscordRuntimeSlashCommand(this, input);
  }

  /** @internal */ public async handleDiscordRuntimeInbound(input: {
    connectionId: string;
    target: string;
    actorId: string;
    displayName?: string;
    content: string;
    sourceMessageId: string;
    peer?: string;
    room?: string;
    threadId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    return discordRuntimeBridgeService.handleDiscordRuntimeInbound(this, input);
  }

  public assertDiscordConnection(connection: IntegrationConnection): void {
    if (connection.kind !== "channel" || connection.key !== "discord") {
      throw new Error("Integration connection is not a Discord channel");
    }
  }

  public isConnectionUrlAllowlisted(urlValue: string): boolean {
    try {
      const url = new URL(urlValue);
      return this.isUrlAllowlisted(url.toString());
    } catch {
      return false;
    }
  }

  private isUrlAllowlisted(urlValue: string): boolean {
    if (!this.isNetworkAllowlistEnforced()) {
      return true;
    }
    return this.isUrlAllowlistedInList(urlValue, this.config.toolPolicy.sandbox.networkAllowlist);
  }

  /** @internal */ public isUrlAllowlistedInList(urlValue: string, allowlist: string[]): boolean {
    return connectionUrlHelpers.isUrlAllowlistedInList(urlValue, allowlist);
  }

  private isNetworkAllowlistEnforced(): boolean {
    return this.config.toolPolicy.tools.profile !== "danger";
  }

  private isHostAllowlistedInList(hostname: string, allowlist: string[]): boolean {
    return connectionUrlHelpers.isHostAllowlistedInList(hostname, allowlist);
  }

  /** @internal */ public tryParseJson<T>(raw: string | null | undefined, fallback: T): T {
    return connectionUrlHelpers.tryParseJson(raw, fallback);
  }

  public readIntegrationPlugins(): IntegrationPluginRecord[] {
    const stored = this.storage.systemSettings.get<IntegrationPluginRecord[]>(INTEGRATION_PLUGINS_SETTING_KEY)?.value;
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored.filter((item): item is IntegrationPluginRecord => Boolean(item?.pluginId));
  }

  public writeIntegrationPlugins(plugins: IntegrationPluginRecord[]): void {
    this.storage.systemSettings.set(INTEGRATION_PLUGINS_SETTING_KEY, plugins);
  }

  /** @internal */ public readMcpServers(): McpServerRecord[] {
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

  /** @internal */ public writeMcpServers(servers: McpServerRecord[]): void {
    this.storage.systemSettings.set(MCP_SERVERS_SETTING_KEY, servers);
  }

  /** @internal */ public requireMcpServer(serverId: string): McpServerRecord {
    const server = this.readMcpServers().find((item) => item.serverId === serverId);
    if (!server) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    return server;
  }

  /** @internal */ public patchMcpServerState(
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

  /** @internal */ public async resolveConnectedMcpTools(
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

  /** @internal */ public readMcpTools(): McpToolRecord[] {
    const stored = this.storage.systemSettings.get<McpToolRecord[]>(MCP_TOOLS_SETTING_KEY)?.value;
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored.filter((item): item is McpToolRecord => Boolean(item?.serverId && item?.toolName));
  }

  /** @internal */ public writeMcpTools(tools: McpToolRecord[]): void {
    this.storage.systemSettings.set(MCP_TOOLS_SETTING_KEY, tools);
  }

  /** @internal */ public readMcpAuthState(): Record<string, McpAuthStateRecord> {
    return this.storage.systemSettings.get<Record<string, McpAuthStateRecord>>("mcp_auth_state_v1")?.value ?? {};
  }

  /** @internal */ public writeMcpAuthState(state: Record<string, McpAuthStateRecord>): void {
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
    const rows = toSkillStateRows(
      this.gatewaySql
        .prepare(
          `
      SELECT skill_id AS skillId, state, note, updated_at AS updatedAt, first_auto_approved_at AS firstAutoApprovedAt
      FROM skill_state
    `,
        )
        .all(),
    );

    return new Map(rows.map((row) => [row.skillId, row]));
  }

  private ensureSkillStates(skillIds: string[]): void {
    const unique = [...new Set(skillIds)];
    const now = new Date().toISOString();
    const insert = this.gatewaySql.prepare(`
      INSERT INTO skill_state (skill_id, state, note, updated_at, first_auto_approved_at)
      VALUES (@skillId, @state, @note, @updatedAt, NULL)
      ON CONFLICT (skill_id) DO NOTHING
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
    this.gatewaySql
      .prepare(
        `
      INSERT INTO skill_activation_events (
        event_id, skill_id, event_type, payload_json, created_at
      ) VALUES (
        @eventId, @skillId, @eventType, @payloadJson, @createdAt
      )
    `,
      )
      .run({
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

  private appendDaemonLog(eventType: string, payload: Record<string, unknown>): void {
    const current =
      this.storage.systemSettings.get<Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }>>(
        DAEMON_LOG_TAIL_SETTING_KEY,
      )?.value ?? [];
    const level: "info" | "warn" | "error" = eventType === "error" ? "error" : eventType === "warn" ? "warn" : "info";
    const next = [
      ...current,
      {
        timestamp: new Date().toISOString(),
        level,
        message: `${eventType}: ${JSON.stringify(payload)}`,
      },
    ].slice(-400);
    this.storage.systemSettings.set(DAEMON_LOG_TAIL_SETTING_KEY, next);
  }

  public async close(): Promise<void> {
    this.closing = true;
    this.chatProactiveService.stopScheduler();
    this.improvementService.stopScheduler();
    this.durableRunService.stopWorker();
    this.approvalEffectsService.stopWorker();
    if (this.maintenanceScheduler) {
      clearInterval(this.maintenanceScheduler);
      this.maintenanceScheduler = undefined;
    }
    if (this.backgroundTasks.size > 0) {
      const tasks = [...this.backgroundTasks];
      this.backgroundTasks.clear();
      await Promise.allSettled(tasks);
    }
    await this.discordRuntimeService.close();
    await this.assemblyService.close();
    await this.npuSidecar.close();
    await this.llamaCppRuntime.close();
    this.storage.close();
  }

  public async invokeAndUnwrap(
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

  /** @internal */ public ensureSessionInternalToolGrant(sessionId: string, toolName: string, createdBy: string): void {
    const hasActiveAllow = this.listToolGrants("session", sessionId, 1000).some(
      (grant) =>
        isActiveToolGrant(grant) && grant.decision === "allow" && grantPatternMatches(grant.toolPattern, toolName),
    );
    if (hasActiveAllow) {
      return;
    }
    this.policyEngine.createGrant({
      toolPattern: toolName,
      decision: "allow",
      scope: "session",
      scopeRef: sessionId,
      grantType: "one_time",
      createdBy,
    });
  }

  /** @internal */ public requireExecutedToolResult(
    toolName: string,
    result: ToolInvokeResult | Record<string, unknown>,
  ): Record<string, unknown> {
    if (this.isToolInvokeResultPayload(result)) {
      const detail = result.policyReason?.trim() || `tool returned ${result.outcome}`;
      throw new Error(`${toolName} failed: ${detail}`);
    }
    const deliveryStatus = typeof result.status === "string" ? result.status.trim().toLowerCase() : "";
    if (deliveryStatus === "failed") {
      const detail =
        typeof result.error === "string" && result.error.trim().length > 0 ? result.error.trim() : "delivery failed";
      throw new Error(`${toolName} failed: ${detail}`);
    }
    return result;
  }

  private isToolInvokeResultPayload(value: unknown): value is ToolInvokeResult {
    if (!value || typeof value !== "object") {
      return false;
    }
    const outcome = (value as { outcome?: unknown }).outcome;
    return outcome === "executed" || outcome === "blocked" || outcome === "approval_required" || outcome === "failed";
  }

  /** @internal */ public async resolveDeviceAccessApproval(
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
    const deviceToken =
      input.decision === "approve" ? randomBytes(DEVICE_ACCESS_TOKEN_BYTES).toString("base64url") : undefined;
    const deviceTokenExpiresAt = deviceToken
      ? new Date(Date.now() + DEVICE_ACCESS_TOKEN_TTL_MS).toISOString()
      : undefined;
    let approval: ApprovalRequest;

    this.storage.runImmediateTransaction(() => {
      if (deviceToken) {
        this.gatewaySql
          .prepare(
            `
          INSERT INTO auth_device_grants (
            grant_id, request_id, token_hash, device_label, device_type, platform,
            granted_by, created_at, expires_at, metadata_json
          ) VALUES (
            @grantId, @requestId, @tokenHash, @deviceLabel, @deviceType, @platform,
            @grantedBy, @createdAt, @expiresAt, @metadataJson
          )
        `,
          )
          .run({
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

      this.gatewaySql
        .prepare(
          `
        UPDATE auth_device_requests
        SET status = @status,
            resolved_at = @resolvedAt,
            resolved_by = @resolvedBy,
            resolution_note = @resolutionNote,
            approved_token_plaintext = @approvedTokenPlaintext,
            approved_token_expires_at = @approvedTokenExpiresAt
        WHERE request_id = @requestId
          AND status = 'pending'
      `,
        )
        .run({
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

    this.enqueueApprovalResolutionEffects(approval!, input);
    await this.recordApprovalResolution(approval!, input);
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

    this.publishRealtime(
      "auth_device_request_resolved",
      "auth",
      {
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
      },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: {
          approvalId: currentApproval.approvalId,
        },
        correlationId: currentApproval.approvalId,
      },
    );

    const effects = this.approvalEffectsService.listByApproval(currentApproval.approvalId);
    return {
      approval: approval!,
      effects,
      replay: {
        approval: approval!,
        events: this.storage.approvalEvents.listByApprovalId(currentApproval.approvalId),
        effects,
      },
      durableRunId: effects.find((effect) => effect.effectKind === "approval_wait_wake")?.targetId,
      resolutionEffects: deriveApprovalResolutionEffectsResult(effects),
    };
  }

  /** @internal */ public async expireDeviceAccessRequestIfNeeded(
    request: AuthDeviceRequestRecord,
  ): Promise<AuthDeviceRequestRecord> {
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
      this.gatewaySql
        .prepare(
          `
        UPDATE auth_device_requests
        SET status = 'expired',
            resolved_at = @resolvedAt,
            resolved_by = @resolvedBy,
            resolution_note = @resolutionNote
        WHERE request_id = @requestId
          AND status = 'pending'
      `,
        )
        .run({
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
      this.enqueueApprovalResolutionEffects(approval, resolutionInput);
      await this.recordApprovalResolution(approval, resolutionInput);
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

    this.publishRealtime(
      "auth_device_request_resolved",
      "auth",
      {
        requestId: request.requestId,
        approvalId: request.approvalId,
        status: "expired",
        resolvedAt,
        resolvedBy: resolutionInput.resolvedBy,
        deviceLabel: request.deviceLabel,
        deviceType: request.deviceType,
        platform: request.platform,
        requestedIp: request.requestedIp,
      },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: {
          approvalId: request.approvalId,
        },
        correlationId: request.approvalId,
      },
    );

    return (
      this.getAuthDeviceRequestById(request.requestId) ?? {
        ...request,
        status: "expired",
        resolvedAt,
        resolvedBy: resolutionInput.resolvedBy,
        resolutionNote: resolutionInput.resolutionNote,
      }
    );
  }

  /** @internal */ public getAuthDeviceRequestById(requestId: string): AuthDeviceRequestRecord | undefined {
    const row = this.gatewaySql
      .prepare(
        `
      SELECT *
      FROM auth_device_requests
      WHERE request_id = @requestId
      LIMIT 1
    `,
      )
      .get({ requestId }) as Record<string, unknown> | undefined;
    return row ? mapAuthDeviceRequestRow(row) : undefined;
  }

  private getAuthDeviceRequestByApprovalId(approvalId: string): AuthDeviceRequestRecord | undefined {
    const row = this.gatewaySql
      .prepare(
        `
      SELECT *
      FROM auth_device_requests
      WHERE approval_id = @approvalId
      LIMIT 1
    `,
      )
      .get({ approvalId }) as Record<string, unknown> | undefined;
    return row ? mapAuthDeviceRequestRow(row) : undefined;
  }

  /** @internal */ public getActiveAuthDeviceGrantById(grantId: string): AuthDeviceGrantRecord | undefined {
    const now = new Date().toISOString();
    const row = this.gatewaySql
      .prepare(
        `
      SELECT *
      FROM auth_device_grants
      WHERE grant_id = @grantId
      LIMIT 1
    `,
      )
      .get({ grantId }) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    const grant = mapAuthDeviceGrantRow(row);
    if (grant.revokedAt) {
      return undefined;
    }
    if (grant.expiresAt) {
      const expiresAt = Date.parse(grant.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= Date.parse(now)) {
        return undefined;
      }
    }
    return grant;
  }

  /** @internal */ public getActiveCompanionSessionById(sessionId: string): CompanionSessionRecord | undefined {
    const now = new Date().toISOString();
    const session = this.getCompanionSessionById(sessionId);
    if (!session) {
      return undefined;
    }
    if (!isCompanionSessionCurrentlyActive(session, now)) {
      this.gatewaySql
        .prepare(
          `
        UPDATE companion_sessions
        SET revoked_at = COALESCE(revoked_at, @revokedAt)
        WHERE session_id = @sessionId
      `,
        )
        .run({
          sessionId,
          revokedAt: now,
        });
      return undefined;
    }
    return session;
  }

  /** @internal */ public getCompanionSessionById(sessionId: string): CompanionSessionRecord | undefined {
    const row = this.gatewaySql
      .prepare(
        `
      SELECT
        s.*,
        g.device_label,
        g.device_type,
        g.platform,
        g.expires_at AS grant_expires_at,
        g.revoked_at AS grant_revoked_at
      FROM companion_sessions s
      INNER JOIN auth_device_grants g
        ON g.grant_id = s.grant_id
      WHERE s.session_id = @sessionId
      LIMIT 1
    `,
      )
      .get({
        sessionId,
      }) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return mapCompanionSessionRow(row);
  }

  /** @internal */ public getActiveCompanionSessionByRefreshToken(
    refreshToken: string,
  ): CompanionSessionRecord | undefined {
    const now = new Date().toISOString();
    const row = this.gatewaySql
      .prepare(
        `
      SELECT
        s.*,
        g.device_label,
        g.device_type,
        g.platform,
        g.expires_at AS grant_expires_at,
        g.revoked_at AS grant_revoked_at
      FROM companion_sessions s
      INNER JOIN auth_device_grants g
        ON g.grant_id = s.grant_id
      WHERE s.refresh_token_hash = @refreshTokenHash
      LIMIT 1
    `,
      )
      .get({
        refreshTokenHash: hashSensitiveToken(refreshToken),
      }) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    const session = mapCompanionSessionRow(row);
    if (!isCompanionSessionRefreshable(session, now)) {
      this.gatewaySql
        .prepare(
          `
        UPDATE companion_sessions
        SET revoked_at = COALESCE(revoked_at, @revokedAt)
        WHERE session_id = @sessionId
      `,
        )
        .run({
          sessionId: session.sessionId,
          revokedAt: now,
        });
      return undefined;
    }
    return session;
  }

  /** @internal */ public async recordApprovalResolution(
    approval: ApprovalRequest,
    input: ApprovalResolveInput,
  ): Promise<void> {
    await this.storage.audit.append("approvals", {
      event: "approval.resolve",
      approvalId: approval.approvalId,
      status: approval.status,
      resolvedBy: input.resolvedBy,
      decision: input.decision,
    });

    this.publishRealtime(
      "approval_resolved",
      "approvals",
      {
        approvalId: approval.approvalId,
        status: approval.status,
        decision: input.decision,
        resolvedBy: input.resolvedBy,
      },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: this.buildApprovalRealtimeLinks(approval),
        correlationId: approval.approvalId,
      },
    );
    this.improvementService.recordApprovalResolutionSignal(approval);
    this.improvementService.handleActivationApprovalResolution(approval);
  }

  public publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): RealtimeEvent {
    if (requiresExplicitRealtimeMetadata(eventType, source) && !hasExplicitRealtimeMetadata(options)) {
      throw new Error(`Explicit realtime metadata is required for protected event ${source}:${eventType}.`);
    }
    const event = this.storage.realtimeEvents.append(eventType, source, payload, options);
    this.realtime.emit("event", event);
    return event;
  }

  /** @internal */ public createCheckpoint(
    input: Omit<OrchestrationCheckpoint, "checkpointId" | "createdAt" | "gitRef">,
  ): OrchestrationCheckpoint {
    return this.storage.orchestration.createCheckpoint({
      ...input,
      gitRef: this.getGitHead(),
    });
  }

  /** @internal */ public scheduleApprovalExplanation(approval: ApprovalRequest): void {
    if (
      this.closing ||
      !approval ||
      typeof approval.approvalId !== "string" ||
      approval.approvalId.trim().length === 0
    ) {
      return;
    }

    const task = this.approvalExplainer
      .explainApproval(approval)
      .catch((error) => {
        if (this.closing) {
          return;
        }
        this.publishRealtime(
          "system",
          "approvals",
          {
            type: "approval_explainer_error",
            approvalId: approval.approvalId,
            error: (error as Error).message,
          },
          {
            eventClass: "operational_signal",
            eventAuthority: "retained_stream",
            links: this.buildApprovalRealtimeLinks(approval),
          },
        );
      })
      .finally(() => {
        this.backgroundTasks.delete(task);
      });

    this.backgroundTasks.add(task);
    void task;
  }

  /** @internal */ public scheduleApprovalExplanationById(approvalId: string): void {
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

  /** @internal */ public scheduleOrchestrationMemoryContext(plan: OrchestrationPlan, run: OrchestrationRun): void {
    if (this.closing || !run.currentPhaseId) {
      return;
    }
    const phase = findPlanPhase(plan, run.currentPhaseId);
    if (!phase) {
      return;
    }

    const task = this.memoryLifecycleService
      .composeContext({
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
        relationScope: "project",
        workspace: "memory",
        forceRefresh: true,
      })
      .then((pack) => {
        this.publishRealtime(
          "memory_qmd_generated",
          "orchestration",
          {
            runId: run.runId,
            phaseId: phase.phaseId,
            contextId: pack.contextId,
            status: pack.quality.status,
          },
          {
            eventClass: "operational_signal",
            eventAuthority: "retained_stream",
            links: {
              runId: run.runId,
            },
          },
        );
      })
      .catch((error) => {
        this.publishRealtime(
          "memory_qmd_failed",
          "orchestration",
          {
            runId: run.runId,
            phaseId: phase.phaseId,
            error: (error as Error).message,
          },
          {
            eventClass: "operational_signal",
            eventAuthority: "retained_stream",
            links: {
              runId: run.runId,
            },
          },
        );
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

  /** @internal */ public normalizeWorkspaceId(workspaceId?: string): string {
    if (!workspaceId?.trim()) {
      return DEFAULT_WORKSPACE_ID;
    }
    const normalized = workspaceId.trim();
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(normalized)) {
      throw new Error("workspaceId contains unsupported characters");
    }
    return normalized;
  }

  private getWorkspaceMemoryRelativeDir(workspaceId: string): string {
    return workspaceId === DEFAULT_WORKSPACE_ID ? "memory" : `workspaces/${workspaceId}/memory`;
  }

  /** @internal */ public resolveMemoryWorkspaceRelativeDir(explicitWorkspace?: string, sessionId?: string): string {
    const explicit = explicitWorkspace?.trim();
    if (explicit) {
      return explicit;
    }
    const sessionKey = sessionId?.trim();
    if (!sessionKey) {
      return "memory";
    }
    const meta = this.storage.chatSessionMeta.get(sessionKey);
    const workspaceId = this.normalizeWorkspaceId(meta?.workspaceId ?? DEFAULT_WORKSPACE_ID);
    return this.getWorkspaceMemoryRelativeDir(workspaceId);
  }

  /** @internal */ public resolveChatCompletionHookWorkspaceId(request: ChatCompletionRequest): string {
    const explicitWorkspace = request.memory?.workspace?.trim();
    if (explicitWorkspace) {
      return this.normalizeWorkspaceId(explicitWorkspace);
    }
    const sessionId = request.memory?.sessionId?.trim();
    if (sessionId) {
      const meta = this.storage.chatSessionMeta.get(sessionId);
      if (meta?.workspaceId) {
        return this.normalizeWorkspaceId(meta.workspaceId);
      }
    }
    return DEFAULT_WORKSPACE_ID;
  }

  private resolveToolHookWorkspaceId(request: ToolInvokeRequest): string {
    if (request.workspaceId?.trim()) {
      return this.normalizeWorkspaceId(request.workspaceId);
    }
    const meta = this.storage.chatSessionMeta.get(request.sessionId);
    return this.normalizeWorkspaceId(meta?.workspaceId ?? DEFAULT_WORKSPACE_ID);
  }

  /** @internal */ public resolveApprovalHookWorkspaceId(payload?: Record<string, unknown>): string {
    const fromPayload = typeof payload?.workspaceId === "string" ? payload.workspaceId.trim() : "";
    if (fromPayload) {
      return this.normalizeWorkspaceId(fromPayload);
    }
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (sessionId) {
      const meta = this.storage.chatSessionMeta.get(sessionId);
      if (meta?.workspaceId) {
        return this.normalizeWorkspaceId(meta.workspaceId);
      }
    }
    return DEFAULT_WORKSPACE_ID;
  }

  /** @internal */ public parseLlmModelSelectHookPatch(value: Record<string, unknown>):
    | {
        providerId?: string;
        model?: string;
      }
    | undefined {
    const providerId =
      typeof value.providerId === "string" && value.providerId.trim() ? value.providerId.trim() : undefined;
    const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
    if (!providerId && !model) {
      return undefined;
    }
    return {
      ...(providerId ? { providerId } : {}),
      ...(model ? { model } : {}),
    };
  }

  /** @internal */ public parseLlmRequestHookPatch(value: Record<string, unknown>):
    | {
        providerId?: string;
        model?: string;
        prependMessages?: ChatCompletionRequest["messages"];
        appendMessages?: ChatCompletionRequest["messages"];
        tools?: Array<Record<string, unknown>>;
        toolChoice?: string | Record<string, unknown>;
        metadata?: Record<string, unknown>;
      }
    | undefined {
    const base = this.parseLlmModelSelectHookPatch(value);
    const prependMessages = this.parseChatCompletionMessages(value.prependMessages);
    const appendMessages = this.parseChatCompletionMessages(value.appendMessages);
    const tools = Array.isArray(value.tools)
      ? value.tools.filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : undefined;
    const toolChoice =
      typeof value.toolChoice === "string"
        ? value.toolChoice
        : value.toolChoice && typeof value.toolChoice === "object" && !Array.isArray(value.toolChoice)
          ? (value.toolChoice as Record<string, unknown>)
          : undefined;
    const metadata =
      value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
        ? (value.metadata as Record<string, unknown>)
        : undefined;
    if (!base && !prependMessages && !appendMessages && !tools && !toolChoice && !metadata) {
      return undefined;
    }
    return {
      ...(base ?? {}),
      ...(prependMessages ? { prependMessages } : {}),
      ...(appendMessages ? { appendMessages } : {}),
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }

  /** @internal */ public mergeLlmRequestHookPatch(
    current:
      | {
          providerId?: string;
          model?: string;
          prependMessages?: ChatCompletionRequest["messages"];
          appendMessages?: ChatCompletionRequest["messages"];
          tools?: Array<Record<string, unknown>>;
          toolChoice?: string | Record<string, unknown>;
          metadata?: Record<string, unknown>;
        }
      | undefined,
    next: {
      providerId?: string;
      model?: string;
      prependMessages?: ChatCompletionRequest["messages"];
      appendMessages?: ChatCompletionRequest["messages"];
      tools?: Array<Record<string, unknown>>;
      toolChoice?: string | Record<string, unknown>;
      metadata?: Record<string, unknown>;
    },
  ) {
    return {
      ...(current ?? {}),
      ...next,
      ...(current?.prependMessages || next.prependMessages
        ? { prependMessages: [...(current?.prependMessages ?? []), ...(next.prependMessages ?? [])] }
        : {}),
      ...(current?.appendMessages || next.appendMessages
        ? { appendMessages: [...(current?.appendMessages ?? []), ...(next.appendMessages ?? [])] }
        : {}),
      ...(current?.metadata || next.metadata
        ? { metadata: { ...(current?.metadata ?? {}), ...(next.metadata ?? {}) } }
        : {}),
    };
  }

  /** @internal */ public applyLlmRequestHookPatch(
    request: ChatCompletionRequest,
    patch: {
      providerId?: string;
      model?: string;
      prependMessages?: ChatCompletionRequest["messages"];
      appendMessages?: ChatCompletionRequest["messages"];
      tools?: Array<Record<string, unknown>>;
      toolChoice?: string | Record<string, unknown>;
      metadata?: Record<string, unknown>;
    },
  ): ChatCompletionRequest {
    return {
      ...request,
      ...(patch.providerId ? { providerId: patch.providerId } : {}),
      ...(patch.model ? { model: patch.model } : {}),
      messages: [...(patch.prependMessages ?? []), ...request.messages, ...(patch.appendMessages ?? [])],
      ...(patch.tools ? { tools: patch.tools } : {}),
      ...(patch.toolChoice ? { tool_choice: patch.toolChoice } : {}),
      ...(patch.metadata ? { metadata: { ...(request.metadata ?? {}), ...patch.metadata } } : {}),
    };
  }

  private parseChatCompletionMessages(value: unknown): ChatCompletionRequest["messages"] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const messages = value.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }
      const candidate = item as {
        role?: unknown;
        content?: unknown;
        name?: unknown;
        tool_call_id?: unknown;
      };
      if (
        candidate.role !== "system" &&
        candidate.role !== "developer" &&
        candidate.role !== "user" &&
        candidate.role !== "assistant" &&
        candidate.role !== "tool"
      ) {
        return [];
      }
      if (typeof candidate.content !== "string" && !Array.isArray(candidate.content)) {
        return [];
      }
      return [
        {
          role: candidate.role as ChatCompletionRequest["messages"][number]["role"],
          content: candidate.content,
          ...(typeof candidate.name === "string" && candidate.name.trim() ? { name: candidate.name.trim() } : {}),
          ...(typeof candidate.tool_call_id === "string" && candidate.tool_call_id.trim()
            ? { tool_call_id: candidate.tool_call_id.trim() }
            : {}),
        },
      ];
    });
    return messages.length > 0 ? messages : undefined;
  }

  private parseToolCallHookPatch(value: Record<string, unknown>):
    | {
        toolName?: string;
        args?: Record<string, unknown>;
      }
    | undefined {
    const toolName = typeof value.toolName === "string" && value.toolName.trim() ? value.toolName.trim() : undefined;
    const args =
      value.args && typeof value.args === "object" && !Array.isArray(value.args)
        ? (value.args as Record<string, unknown>)
        : undefined;
    if (!toolName && !args) {
      return undefined;
    }
    return {
      ...(toolName ? { toolName } : {}),
      ...(args ? { args } : {}),
    };
  }

  /** @internal */ public parseApprovalCreateHookPatch(value: Record<string, unknown>):
    | {
        riskLevel?: ApprovalCreateInput["riskLevel"];
        payloadMerge?: Record<string, unknown>;
        previewMerge?: Record<string, unknown>;
        expiresAt?: string | null;
      }
    | undefined {
    const riskLevel =
      value.riskLevel === "safe" ||
      value.riskLevel === "caution" ||
      value.riskLevel === "danger" ||
      value.riskLevel === "nuclear"
        ? value.riskLevel
        : undefined;
    const payloadMerge =
      value.payloadMerge && typeof value.payloadMerge === "object" && !Array.isArray(value.payloadMerge)
        ? (value.payloadMerge as Record<string, unknown>)
        : undefined;
    const previewMerge =
      value.previewMerge && typeof value.previewMerge === "object" && !Array.isArray(value.previewMerge)
        ? (value.previewMerge as Record<string, unknown>)
        : undefined;
    const expiresAt =
      value.expiresAt === null
        ? null
        : typeof value.expiresAt === "string" && value.expiresAt.trim()
          ? value.expiresAt.trim()
          : undefined;
    if (!riskLevel && !payloadMerge && !previewMerge && expiresAt === undefined) {
      return undefined;
    }
    return {
      ...(riskLevel ? { riskLevel } : {}),
      ...(payloadMerge ? { payloadMerge } : {}),
      ...(previewMerge ? { previewMerge } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }

  /** @internal */ public parseOrchestrationRunHookPatch(value: Record<string, unknown>):
    | {
        maxIterations?: number;
        maxRuntimeMinutes?: number;
        maxCostUsd?: number;
      }
    | undefined {
    const maxIterations = parseOptionalPositiveInt(value.maxIterations);
    const maxRuntimeMinutes = parseOptionalPositiveInt(value.maxRuntimeMinutes);
    const maxCostUsd =
      typeof value.maxCostUsd === "number" && Number.isFinite(value.maxCostUsd) && value.maxCostUsd > 0
        ? value.maxCostUsd
        : undefined;
    if (maxIterations === undefined && maxRuntimeMinutes === undefined && maxCostUsd === undefined) {
      return undefined;
    }
    return {
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(maxRuntimeMinutes !== undefined ? { maxRuntimeMinutes } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    };
  }

  /** @internal */ public parseOrchestrationPhaseHookPatch(value: Record<string, unknown>):
    | {
        ownerAgentId?: string;
        specPath?: string;
        loopMode?: "fresh-context" | "compaction";
        requiresApproval?: boolean;
      }
    | undefined {
    const ownerAgentId =
      typeof value.ownerAgentId === "string" && value.ownerAgentId.trim() ? value.ownerAgentId.trim() : undefined;
    const specPath = typeof value.specPath === "string" && value.specPath.trim() ? value.specPath.trim() : undefined;
    const loopMode = value.loopMode === "fresh-context" || value.loopMode === "compaction" ? value.loopMode : undefined;
    const requiresApproval = typeof value.requiresApproval === "boolean" ? value.requiresApproval : undefined;
    if (!ownerAgentId && !specPath && !loopMode && requiresApproval === undefined) {
      return undefined;
    }
    return {
      ...(ownerAgentId ? { ownerAgentId } : {}),
      ...(specPath ? { specPath } : {}),
      ...(loopMode ? { loopMode } : {}),
      ...(requiresApproval !== undefined ? { requiresApproval } : {}),
    };
  }

  /** @internal */ public applyOrchestrationPhaseHookPatch(
    plan: OrchestrationPlan,
    phaseId: string,
    patch: {
      ownerAgentId?: string;
      specPath?: string;
      loopMode?: "fresh-context" | "compaction";
      requiresApproval?: boolean;
    },
  ): OrchestrationPlan {
    return {
      ...plan,
      waves: plan.waves.map((wave) => ({
        ...wave,
        phases: wave.phases.map((phase) => {
          if (phase.phaseId !== phaseId) {
            return phase;
          }
          return {
            ...phase,
            ...(patch.ownerAgentId ? { ownerAgentId: patch.ownerAgentId } : {}),
            ...(patch.specPath ? { specPath: patch.specPath } : {}),
            ...(patch.loopMode ? { loopMode: patch.loopMode } : {}),
            ...(patch.requiresApproval !== undefined ? { requiresApproval: patch.requiresApproval } : {}),
          };
        }),
      })),
    };
  }

  private resolveGuidancePath(
    docType: GuidanceDocType,
    scope: "global" | "workspace",
    workspaceId?: string,
  ): { fileName: string; absolutePath: string } {
    return guidanceDocumentHelpers.resolveGuidancePath(this, docType, scope, workspaceId);
  }

  private async readGuidanceDocument(
    docType: GuidanceDocType,
    scope: "global" | "workspace",
    workspaceId?: string,
  ): Promise<GuidanceDocumentRecord> {
    return guidanceDocumentHelpers.readGuidanceDocument(this, docType, scope, workspaceId);
  }

  private async writeGuidanceDocument(
    docType: GuidanceDocType,
    scope: "global" | "workspace",
    workspaceId: string | undefined,
    content: string,
  ): Promise<void> {
    return guidanceDocumentHelpers.writeGuidanceDocument(this, docType, scope, workspaceId, content);
  }

  /** @internal */ public async resolveRuntimeGuidance(workspaceId: string): Promise<ResolvedRuntimeGuidance> {
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
      const selected = workspaceDoc.exists ? workspaceDoc : globalDoc.exists ? globalDoc : undefined;
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

  /** @internal */ public requireChatSession(sessionId: string): ChatSessionRecord {
    const session = this.getSession(sessionId);
    const projectLink = this.storage.chatSessionProjects.get(sessionId);
    const project = projectLink ? this.storage.chatProjects.find(projectLink.projectId) : undefined;
    const prefs = this.storage.chatSessionPrefs.get(sessionId);
    const generatedArtifacts = this.storage.chatGeneratedArtifacts
      .listBySession(sessionId, 12)
      .slice(0, 6)
      .map(chatGeneratedArtifactService.buildGeneratedArtifactReference);
    const meta =
      this.storage.chatSessionMeta.get(sessionId) ??
      this.storage.chatSessionMeta.ensure(sessionId, undefined, project?.workspaceId ?? DEFAULT_WORKSPACE_ID);
    return toChatSessionRecord(session, { ...meta, mode: prefs?.mode ?? "chat" }, project, { generatedArtifacts });
  }

  /** @internal */ public isReplayScratchSession(sessionId: string): boolean {
    const title = this.storage.chatSessionMeta.get(sessionId)?.title?.trim();
    return Boolean(title && title.startsWith(REPLAY_SCRATCH_SESSION_TITLE_PREFIX));
  }

  /** @internal */ public routeFromSession(session: SessionMeta): {
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

  /** @internal */ public resolveThreadKnowledgeContext(
    sessionId: string,
    query: string,
  ): Promise<chatThreadKnowledgeService.ResolvedThreadKnowledgeContext> {
    return chatThreadKnowledgeService.resolveThreadKnowledgeContext(this, sessionId, query);
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
    const mapped = await Promise.all(
      transcript
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
          const baseContent =
            typeof payload.message?.content === "string"
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
        }),
    );
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
    return chatTurnTraceHydration.listHydratedChatTurnTraces(this, sessionId, limit);
  }

  private resolveChatActiveLeafTurnId(sessionId: string, traces: ChatTurnTraceRecord[]): string | undefined {
    return chatTurnTraceHydration.resolveChatActiveLeafTurnId(this, sessionId, traces);
  }

  private buildChatTurnChildrenMap(traces: ChatTurnTraceRecord[]): Map<string, string[]> {
    return chatTurnTraceHydration.buildChatTurnChildrenMap(traces);
  }

  /** @internal */ public async buildLlmMessagesFromBranchPath(
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
    const sessionState = state ?? (await this.loadChatTurnSessionState(sessionId));
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
    const mapped = await Promise.all(
      records.map(async (message) => {
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
      }),
    );
    const messages =
      options?.sessionId && options.branchTurnIds && options.branchTurnIds.length > 0
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
      .map(
        (event) =>
          ({
            messageId: event.eventId,
            sessionId,
            role: event.type === "message.user" ? "user" : "assistant",
            actorType: event.type === "message.user" ? "user" : "agent",
            actorId: event.type === "message.user" ? "operator" : "assistant",
            content: this.extractMessagePreview(event.payload),
            timestamp: event.timestamp,
          }) satisfies ChatMessageRecord,
      );
    const recentRecords = records.slice(-(CHAT_COMPACTION_RECENT_TURN_LIMIT * 2));
    const summary = buildConversationCompactionSummary(
      records.slice(0, Math.max(0, records.length - recentRecords.length)),
    );
    const recentMessages = mapped.slice(-(CHAT_COMPACTION_RECENT_TURN_LIMIT * 2));
    if (!summary) {
      return trimNewestContextMessagesForPromptCache(recentMessages, CHAT_COMPACTION_TRIGGER_TOKENS);
    }
    const summaryContent = truncateByTokenEstimate(summary, CHAT_COMPACTION_SUMMARY_TOKEN_BUDGET);
    const recentMessageBudget = Math.max(240, CHAT_COMPACTION_TRIGGER_TOKENS - estimateTokensFromText(summaryContent));
    return [
      {
        role: "system",
        content: summaryContent,
      },
      ...trimNewestContextMessagesForPromptCache(recentMessages, recentMessageBudget),
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
      input.branchTurnIds.length <= CHAT_COMPACTION_RECENT_TURN_LIMIT ||
      totalTokens <= CHAT_COMPACTION_TRIGGER_TOKENS
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
    const mappedVerbatim = await Promise.all(
      finalVerbatimRecords.map(async (message) => {
        const mappedIndex = input.records.findIndex((item) => item.messageId === message.messageId);
        if (mappedIndex >= 0) {
          return input.mapped[mappedIndex]!;
        }
        return message.role === "assistant"
          ? { role: "assistant" as const, content: message.content }
          : { role: "user" as const, content: message.content };
      }),
    );

    const summaryTokenBudget = estimateTokensFromText(stringifyMessagesForTokenEstimate(summaryMessages));
    const verbatimTokenBudget = Math.max(240, CHAT_COMPACTION_TRIGGER_TOKENS - summaryTokenBudget);

    return [...summaryMessages, ...trimNewestContextMessagesForPromptCache(mappedVerbatim, verbatimTokenBudget)];
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
      .find(
        (summary) =>
          summary.startTurnId === input.turnIds[0] &&
          summary.endTurnId === input.turnIds.at(-1) &&
          summary.sourceHash === sourceHash,
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

  private buildUserMessageContent(
    message: ChatMessageRecord,
    supportsVision: boolean,
  ): Promise<string | Array<Record<string, unknown>>> {
    return chatTurnUserMessage.buildUserMessageContent(this, message, supportsVision);
  }

  private buildUserMessagePrompt(message: ChatMessageRecord): string {
    return chatTurnUserMessage.buildUserMessagePrompt(message);
  }

  private resolveMessageAttachments(message: ChatMessageRecord): ChatAttachmentRecord[] {
    return chatTurnUserMessage.resolveMessageAttachments(this, message);
  }

  private buildAttachmentPromptContext(input: unknown, supportsVision = false): string | undefined {
    return chatTurnUserMessage.buildAttachmentPromptContext(this, input, supportsVision);
  }

  private buildAttachmentMessageParts(
    input: unknown,
    prompt: string,
    supportsVision: boolean,
  ): Promise<Array<Record<string, unknown>> | undefined> {
    return chatTurnUserMessage.buildAttachmentMessageParts(this, input, prompt, supportsVision);
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
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  private normalizeRelativePath(inputPath: string): string {
    const normalized = path.normalize(inputPath).replaceAll("\\", "/");
    if (
      !normalized ||
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.endsWith("/..") ||
      normalized.includes("/../")
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
    return onboardingMarkerHelpers.loadOnboardingMarker(this);
  }

  private persistOnboardingMarker(): void {
    return onboardingMarkerHelpers.persistOnboardingMarker(this);
  }

  private async loadCronJobsFromConfig(): Promise<void> {
    return cronJobConfigHelpers.loadCronJobsFromConfig(this);
  }

  private persistCronJobsConfig(): void {
    return cronJobConfigHelpers.persistCronJobsConfig(this);
  }

  private getCronJobsConfigPath(): string {
    return cronJobConfigHelpers.getCronJobsConfigPath(this);
  }

  // ensureWeeklyImprovementCronJob moved to ImprovementService

  private ensurePrivateBetaBackupCronJob(): void {
    return cronJobConfigHelpers.ensurePrivateBetaBackupCronJob(this);
  }

  private ensureMemoryFlushCronJob(): void {
    return cronJobConfigHelpers.ensureMemoryFlushCronJob(this);
  }

  private ensureCostReportCronJob(): void {
    return cronJobConfigHelpers.ensureCostReportCronJob(this);
  }

  private ensureUpdateReviewCronJob(): void {
    return cronJobConfigHelpers.ensureUpdateReviewCronJob(this);
  }

  /** @internal */ public persistLlmConfig(): void {
    const filePath = path.join(this.config.rootDir, "config", "llm-providers.json");
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, JSON.stringify(this.llmService.exportConfigFile(), null, 2), "utf8");
    this.persistUnifiedConfig();
  }

  /** @internal */ public persistToolPolicyConfig(): void {
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
    this.persistUnifiedConfig();
  }

  /** @internal */ public persistBudgetsConfig(): void {
    const filePath = path.join(this.config.rootDir, "config", "budgets.json");
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, JSON.stringify(this.config.budgets, null, 2), "utf8");
    this.persistUnifiedConfig();
  }

  /** @internal */ public persistAssistantConfig(): void {
    const filePath = path.join(this.config.rootDir, "config", "assistant.config.json");
    const payload = {
      environment: this.config.assistant.environment,
      deploymentProfile: this.config.assistant.deploymentProfile,
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
      web: this.config.assistant.web,
      mesh: this.config.assistant.mesh,
      npu: this.config.assistant.npu,
      llamaCpp: this.config.assistant.llamaCpp,
      database: this.config.assistant.database,
      sqlite: this.config.assistant.sqlite,
      durable: this.config.assistant.durable,
      features: this.readFeatureFlags(),
      budgets: this.config.assistant.budgets,
    };
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    this.persistUnifiedConfig();
  }

  /** @internal */ public persistUnifiedConfig(): void {
    const filePath = path.join(this.config.rootDir, "config", "goatcitadel.json");
    const cronJobs = {
      jobs: this.storage.cronJobs.list().map((job) => ({
        jobId: job.jobId,
        name: job.name,
        schedule: job.schedule,
        enabled: job.enabled,
        lastRunAt: job.lastRunAt,
        nextRunAt: job.nextRunAt,
      })),
    };
    const assistantPayload = {
      environment: this.config.assistant.environment,
      deploymentProfile: this.config.assistant.deploymentProfile,
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
      web: this.config.assistant.web,
      mesh: this.config.assistant.mesh,
      npu: this.config.assistant.npu,
      llamaCpp: this.config.assistant.llamaCpp,
      database: this.config.assistant.database,
      sqlite: this.config.assistant.sqlite,
      durable: this.config.assistant.durable,
      features: this.readFeatureFlags(),
      budgets: this.config.assistant.budgets,
    };
    const toolPolicyPayload = {
      ...this.config.toolPolicy,
      sandbox: {
        ...this.config.toolPolicy.sandbox,
        writeJailRoots: this.config.toolPolicy.sandbox.writeJailRoots.map((root) => this.serializeRootPath(root)),
        readOnlyRoots: this.config.toolPolicy.sandbox.readOnlyRoots.map((root) => this.serializeRootPath(root)),
      },
    };
    const unifiedPayload = buildUnifiedConfigPayload(
      assistantPayload,
      toolPolicyPayload,
      this.config.budgets,
      this.llmService.exportConfigFile(),
      cronJobs,
    );
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, JSON.stringify(unifiedPayload, null, 2), "utf8");
  }

  private serializeRootPath(fullPath: string): string {
    return serializePathWithinRoot(this.config.rootDir, fullPath, this.warnedOutsideRootPathFingerprints, (warning) => {
      this.recordDevDiagnostic({
        level: "warn",
        category: "security",
        event: "filesystem.outside_root_path_redacted",
        message: "Refused to expose a filesystem path outside the workspace root.",
        context: {
          fingerprint: warning.fingerprint,
          baseName: warning.baseName,
        },
      });
    });
  }
}

export function extractPromptFromMessages(messages: ChatCompletionRequest["messages"]): string {
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

export function buildMemoryContextSystemMessage(pack: MemoryContextPack): string {
  return [
    "Distilled context from GoatCitadel memory:",
    pack.contextText,
    "",
    `ContextId: ${pack.contextId}`,
    `Citations: ${pack.citations.length}`,
  ].join("\n");
}

export function calculateSavings(originalTokens: number, distilledTokens: number): number {
  if (originalTokens <= 0) {
    return 0;
  }
  return Number((((originalTokens - distilledTokens) / originalTokens) * 100).toFixed(2));
}

function parseOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function findPlanPhase(plan: OrchestrationPlan, phaseId: string) {
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

async function walkFiles(rootDir: string, currentDir: string, out: MemoryFileEntry[], maxItems: number): Promise<void> {
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

export function toChatSessionRecord(
  session: SessionMeta,
  meta: {
    workspaceId?: string;
    mode?: ChatMode;
    title?: string;
    origin?: "operator" | "prompt_pack" | "system";
    includeInHistory: boolean;
    pinned: boolean;
    lifecycleStatus: "active" | "archived";
    archivedAt?: string;
    folderId?: string;
    folderName?: string;
    tags?: string[];
  },
  project?: ChatProjectRecord,
  extras?: Partial<Pick<ChatSessionRecord, "searchHits" | "lastHandoff" | "generatedArtifacts">>,
): ChatSessionRecord {
  return {
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    workspaceId: meta.workspaceId ?? project?.workspaceId,
    scope: session.channel === "mission" ? "mission" : "external",
    mode: meta.mode,
    origin: meta.origin,
    includeInHistory: meta.includeInHistory,
    title: meta.title ?? session.displayName,
    pinned: meta.pinned,
    lifecycleStatus: meta.lifecycleStatus,
    archivedAt: meta.archivedAt,
    folderId: meta.folderId,
    folderName: meta.folderName,
    tags: meta.tags ?? [],
    projectId: project?.projectId,
    projectName: project?.name,
    searchHits: extras?.searchHits,
    lastHandoff: extras?.lastHandoff,
    generatedArtifacts: extras?.generatedArtifacts,
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
  const parts = input.map((item) => normalizeMessagePart(item)).filter((item): item is ChatInputPart => Boolean(item));
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
      detail: value.detail === "low" || value.detail === "high" || value.detail === "auto" ? value.detail : undefined,
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

export function splitIntoChunks(input: string, maxChunkLength: number): string[] {
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

export function buildEmptyAssistantTurnFallbackText(): string {
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

export function inferDegradedAssistantTurnFailure(content: string): ChatTurnFailureRecord | undefined {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized.startsWith("i ran out of time before i could finish") ||
    normalized.startsWith("i couldn't finish that cleanly because") ||
    normalized.includes("recover useful content from") ||
    normalized.includes("strongest leads so far")
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
    // eslint-disable-next-line no-control-regex
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
  const textLike =
    lowerMime.startsWith("text/") ||
    lowerMime === "application/json" ||
    lowerMime === "application/xml" ||
    ext === ".md" ||
    ext === ".txt" ||
    ext === ".log" ||
    ext === ".json" ||
    ext === ".yaml" ||
    ext === ".yml";
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

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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
    normalized.includes("vision") ||
    normalized.includes("gpt-4o") ||
    normalized.includes("gpt-4.1") ||
    normalized.includes("gemini") ||
    normalized.includes("claude-3") ||
    normalized.includes("kimi") ||
    normalized.includes("glm")
  );
}

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("image/");
}

export function normalizeChatInputParts(
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

export function toTitleCase(value: string): string {
  return value
    .split(/[-_.]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parseBankrAuditCursor(cursor?: string): { createdAt: string; actionId: string } | undefined {
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

export function inferMcpCategory(transport: McpServerRecord["transport"]): McpServerCategory {
  if (transport === "stdio") {
    return "development";
  }
  if (transport === "sse") {
    return "research";
  }
  return "automation";
}

export function normalizeMcpPolicy(policy?: Partial<McpServerPolicy>): McpServerPolicy {
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

export function parseSlashCommand(input: string): string[] | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const parts = trimmed.split(/\s+/g).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export function parseDelegateCommand(input: string): { roles: string[]; objective?: string; error?: string } {
  const body = input
    .trim()
    .replace(/^\/delegate/i, "")
    .trim();
  const delimiterIndex = body.indexOf("::");
  if (delimiterIndex < 0) {
    return { roles: [], error: "missing delimiter" };
  }
  const rolesRaw = body.slice(0, delimiterIndex).trim();
  const objective = body.slice(delimiterIndex + 2).trim();
  const roles = normalizeDelegationRoles(
    rolesRaw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (roles.length === 0 || !objective) {
    return { roles, objective, error: "invalid delegate payload" };
  }
  return { roles, objective };
}

export function parsePipelineCommand(
  input: string,
): { template: string; roles: string[]; objective: string } | undefined {
  const body = input
    .trim()
    .replace(/^\/pipeline/i, "")
    .trim();
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
    const normalized = role
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
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

function normalizeDelegationSteps(input: {
  roles: string[];
  mode: "sequential" | "parallel";
  steps?: NonNullable<ChatDelegateRequest["steps"]>;
}): NormalizedDelegationStep[] {
  if (!input.steps || input.steps.length === 0) {
    const stepIds = input.roles.map(() => randomUUID());
    return input.roles.map((role, index) => ({
      stepId: stepIds[index]!,
      index,
      role,
      parallelizable: input.mode === "parallel",
      dependsOnStepIds: input.mode === "sequential" && index > 0 ? [stepIds[index - 1]!] : [],
    }));
  }

  const allowedRoles = new Set(input.roles);
  const provisional = input.steps.map((step, index) => {
    const normalizedRole = normalizeDelegationRoles([step.role])[0];
    if (!normalizedRole) {
      throw new Error(`delegation step ${index + 1} is missing a valid role`);
    }
    if (!allowedRoles.has(normalizedRole)) {
      throw new Error(`delegation step role "${normalizedRole}" must also appear in roles`);
    }
    return {
      requestedStepId: step.stepId?.trim(),
      requestedIndex: Number.isFinite(step.index) ? Math.max(0, Math.trunc(step.index!)) : index,
      role: normalizedRole,
      parallelizable: step.parallelizable ?? input.mode === "parallel",
      dependsOnStepIds: dedupeStrings(step.dependsOnStepIds ?? []),
    };
  });

  provisional.sort((left, right) => left.requestedIndex - right.requestedIndex);
  const seenStepIds = new Set<string>();
  const normalized = provisional.map((step, index) => {
    const stepId = step.requestedStepId && !seenStepIds.has(step.requestedStepId) ? step.requestedStepId : randomUUID();
    seenStepIds.add(stepId);
    return {
      stepId,
      index,
      role: step.role,
      parallelizable: step.parallelizable,
      dependsOnStepIds: step.dependsOnStepIds,
    };
  });

  const validStepIds = new Set(normalized.map((step) => step.stepId));
  for (const step of normalized) {
    for (const dependencyStepId of step.dependsOnStepIds) {
      if (!validStepIds.has(dependencyStepId)) {
        throw new Error(`delegation step "${step.stepId}" depends on unknown step "${dependencyStepId}"`);
      }
      if (dependencyStepId === step.stepId) {
        throw new Error(`delegation step "${step.stepId}" cannot depend on itself`);
      }
    }
  }
  return normalized;
}

function buildDelegationStages(steps: readonly NormalizedDelegationStep[]): NormalizedDelegationStep[][] {
  const remaining = new Map(steps.map((step) => [step.stepId, step] as const));
  const resolved = new Set<string>();
  const stages: NormalizedDelegationStep[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((step) => step.dependsOnStepIds.every((dependencyStepId) => resolved.has(dependencyStepId)))
      .sort((left, right) => left.index - right.index);
    if (ready.length === 0) {
      throw new Error("delegation steps contain a dependency cycle or unresolved dependency");
    }
    const stage = ready.some((step) => !step.parallelizable) ? [ready[0]!] : ready;
    stages.push(stage);
    for (const step of stage) {
      remaining.delete(step.stepId);
      resolved.add(step.stepId);
    }
  }

  return stages;
}

export function detectDelegationRoles(objective: string): string[] {
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

function scoreChatModelSuggestion(model: string, query: string): number {
  if (!query) {
    return 1;
  }
  const normalized = model.toLowerCase();
  if (normalized === query) {
    return 4;
  }
  if (normalized.startsWith(query)) {
    return 3;
  }
  if (normalized.includes(query)) {
    return 2;
  }
  return 0;
}

export function extractSpecialistObjectiveKeywords(content: string): string[] {
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
  return dedupeStrings(
    matches.map(normalizeSpecialistToken).filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  ).slice(0, 12);
}

function mergeSpecialistRoutingHints(
  left: ChatSpecialistCandidateRecord["routingHints"],
  right: ChatSpecialistCandidateRecord["routingHints"],
): ChatSpecialistCandidateRecord["routingHints"] {
  const maxInvocationsPerRun = (() => {
    const values = [left.maxInvocationsPerRun, right.maxInvocationsPerRun].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
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

export function inferSpecialistBaseRole(role: string): OrchestrationRole {
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
    confidence: clamp01(
      input.capability.riskLevel === "low" ? 0.76 : input.capability.riskLevel === "high" ? 0.62 : 0.69,
    ),
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
    evidence: [
      {
        evidenceId: randomUUID(),
        kind: input.capability.kind === "mcp_template" ? "tool_gap" : "skill_gap",
        summary: input.capability.summary,
        confidence: clamp01(input.capability.riskLevel === "low" ? 0.78 : 0.66),
        skillRef: input.capability.sourceRef,
      },
    ],
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
  const routingMode: ChatSpecialistCandidateSuggestionRecord["suggestedRoutingMode"] =
    input.confidence >= 0.8 ? "strong_match_only" : "manual_only";
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
      objectiveKeywords:
        input.objectiveKeywords.length > 0
          ? input.objectiveKeywords
          : extractSpecialistObjectiveKeywords(input.objective),
      requiresProjectBinding: input.mode === "code",
      maxInvocationsPerRun: 1,
    },
    evidence: [
      {
        evidenceId: randomUUID(),
        kind: "role_gap",
        summary: `Objective hinted that ${input.role} work would help: ${input.objective.slice(0, 180)}`,
        turnId: input.turnId,
        runId: input.runId,
        confidence: clamp01(input.confidence),
      },
    ],
  };
}

export function scoreSpecialistCandidateMatch(
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
  const overlap =
    candidateKeywords.length > 0
      ? objectiveKeywords.filter((keyword) => candidateKeywords.includes(keyword)).length / candidateKeywords.length
      : 0;
  return clamp01(candidate.confidence * 0.55 + overlap * 0.35 + 0.1);
}

export function buildSpecialistMatchReason(
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

export function splitChatPrefsPatch(input: ChatSessionPrefsPatch): {
  basePatch: Pick<
    ChatSessionPrefsPatch,
    | "mode"
    | "planningMode"
    | "providerId"
    | "model"
    | "imageProviderId"
    | "imageModel"
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
    | "imageProviderId"
    | "imageModel"
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
    imageProviderId: input.imageProviderId,
    imageModel: input.imageModel,
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

export function buildPlanningModeSystemInstruction(planningMode: ChatPlanningMode | undefined): string | undefined {
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

export function mergeChatSystemInstructions(...parts: Array<string | undefined>): string | undefined {
  const merged = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  if (merged.length === 0) {
    return undefined;
  }
  return merged.join("\n\n");
}

export function buildRetrievalTrace(input: {
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
    escalationReason: shouldUseL2 ? (liveIntent ? "explicit_live_data_intent" : "low_retrieval_confidence") : undefined,
  };
}

function looksSensitive(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /api[_-]?key|token|secret|password|private[_-]?key|bearer\s+[a-z0-9._-]+/i.test(normalized) ||
    /\bsk-[a-z0-9]{8,}\b/i.test(normalized) ||
    /\bghp_[a-z0-9]{10,}\b/i.test(normalized)
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
  const previous =
    input.sharedContext.length > 0
      ? input.sharedContext.map((item) => `Role ${item.role} output:\n${item.output}`).join("\n\n")
      : "None";
  return [
    `Objective: ${input.objective}`,
    `Execution mode: ${input.mode}`,
    `Current role: ${input.role}`,
    "Completed dependency outputs available to this role:",
    previous,
    "Produce your role output now.",
  ].join("\n\n");
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const cappedConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
    }
  };

  await Promise.all(Array.from({ length: cappedConcurrency }, () => runWorker()));
  return results;
}

export function renderExecutionPlanAsMarkdown(input: {
  mode: ChatMode;
  objective: string;
  summary: string;
  steps: PreparedChatExecutionPlanResolution["executionPlanDraft"]["steps"];
}): string {
  const modeLabel = input.mode === "cowork" ? "Cowork plan" : input.mode === "code" ? "Code plan" : "Chat plan";
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
      const content = typeof message.content === "string" ? message.content : extractStringFromUnknown(message.content);
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
}

export function truncateSummaryLine(content: string, maxLength = 220): string {
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

export function buildExecutionPlanDraftFromOrchestrationPlan(
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
      delegatedRole:
        input.advisoryOnly || templatePlan.routeDecision.modePolicy === "chat" ? undefined : step.delegatedRole,
      status: "pending",
    })),
  };
}

export function coercePlannerExecutionPlanDraft(
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
    const objective =
      typeof raw?.objective === "string" && raw.objective.trim() ? raw.objective.trim() : templateStep.objective;
    if (objective === templateStep.objective) {
      usedFallback = true;
    }
    const successCriteria =
      typeof raw?.successCriteria === "string" && raw.successCriteria.trim()
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
    const expectedOutput =
      typeof raw?.expectedOutput === "string" && raw.expectedOutput.trim()
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
    const delegatedRole =
      input.mode === "chat" || input.advisoryOnly
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
  const summary =
    typeof payload.summary === "string" && payload.summary.trim() ? payload.summary.trim() : templatePlan.summary;
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

export function applyExecutionPlanDraftToOrchestrationPlan(
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

export function mergeExecutionPlanStepStatuses(
  planSteps: PreparedChatExecutionPlanResolution["executionPlanDraft"]["steps"],
  results: OrchestrationStepExecutionResult[],
): PreparedChatExecutionPlanResolution["executionPlanDraft"]["steps"] {
  return planSteps.map((planStep, index) => {
    const result =
      results.find((item) => item.stepId === planStep.stepId) ?? results.find((item) => item.index === index);
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
      durableRunId: result.durableRunId,
      childSessionId: result.childSessionId,
      childTurnId: result.childTurnId,
    };
  });
}

export function buildDelegationFailureGuidance(error: string, role: string): string {
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
      return (
        candidate.status === "failed" || candidate.status === "blocked" || candidate.status === "approval_required"
      );
    }
    return candidate.status === "failed" || candidate.status === "approval_required";
  });
  const normal = candidates.filter((candidate) => !critical.includes(candidate));
  const criticalTarget = Math.min(critical.length, Math.max(1, Math.floor(cap * 0.45)));
  const selected = [...critical.slice(0, criticalTarget), ...normal.slice(0, cap - criticalTarget)];
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
    } else if (
      (candidate.routing?.liveDataIntent ?? false) ||
      candidate.webMode === "quick" ||
      candidate.webMode === "deep"
    ) {
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
  const ruleQuality =
    ruleScores.honesty * 0.28 +
    ruleScores.blockerQuality * 0.2 +
    ruleScores.retryQuality * 0.2 +
    ruleScores.toolEvidence * 0.2 +
    ruleScores.actionability * 0.12;
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
  const modelWrongness =
    (1 - modelScores.correctnessLikelihood) * 0.55 +
    modelScores.missedToolProbability * 0.3 +
    modelScores.betterResponsePotential * 0.15;
  return clampProbability(ruleWrongness * 0.55 + modelWrongness * 0.45);
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
  if (
    (candidate.status === "blocked" || candidate.status === "approval_required") &&
    ruleScores.blockerQuality < 0.66
  ) {
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
  const keys = new Set<DecisionReplayCauseClass>([...current.keys(), ...previous.keys()]);
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

function getZonedDateParts(
  date: Date,
  timeZone: string,
): {
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
  if (job.endAt) {
    const endAt = Date.parse(job.endAt);
    if (Number.isFinite(endAt) && endAt < now.getTime()) {
      return false;
    }
  }
  const parsed = parseSimpleCronSchedule(job.schedule);
  const minute = parsed?.minute ?? defaults.defaultMinute;
  const hour = parsed?.hour ?? defaults.defaultHour;
  const hourStep = parsed?.hourStep;
  const wildcardMinute = parsed?.wildcardMinute ?? false;
  const wildcardHour = parsed?.wildcardHour ?? false;
  const wildcardWeekday = parsed?.wildcardWeekday ?? false;
  const weekdays = parsed?.weekdays ?? (defaults.defaultWeekday === undefined ? undefined : [defaults.defaultWeekday]);
  const timeZone = parsed?.timeZone ?? defaults.defaultTimeZone;
  const window = getZonedDateParts(now, timeZone);
  if (!wildcardHour) {
    if (hourStep !== undefined) {
      if (window.hour % hourStep !== 0) {
        return false;
      }
    } else if (window.hour !== hour) {
      return false;
    }
  }
  if (!wildcardMinute && (window.minute < minute || window.minute >= minute + 5)) {
    return false;
  }
  if (!wildcardWeekday && weekdays?.length && !weekdays.includes(window.weekday)) {
    return false;
  }
  return true;
}

function parseSimpleCronSchedule(value: string): {
  minute?: number;
  hour?: number;
  hourStep?: number;
  weekdays?: number[];
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
  let hourStep: number | undefined;
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
    if (/^\*\/\d+$/.test(hourRaw)) {
      hourStep = Number.parseInt(hourRaw.slice(2), 10);
      if (!Number.isFinite(hourStep) || hourStep < 1 || hourStep > 23) {
        return null;
      }
    } else if (!/^\d+$/.test(hourRaw)) {
      return null;
    } else {
      hour = Number.parseInt(hourRaw, 10);
      if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
        return null;
      }
    }
  }
  let weekdays: number[] | undefined;
  const wildcardWeekday = dayOfWeekRaw === "*";
  if (!wildcardWeekday) {
    const parsedWeekdays = [...new Set(dayOfWeekRaw.split(",").map((token) => Number.parseInt(token, 10)))];
    if (
      parsedWeekdays.length === 0 ||
      parsedWeekdays.some((weekday) => !Number.isFinite(weekday) || weekday < 0 || weekday > 6)
    ) {
      return null;
    }
    weekdays = parsedWeekdays.sort((left, right) => left - right);
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
    hourStep,
    weekdays,
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

export function parseLooseJsonRecord(raw: string): Record<string, unknown> | undefined {
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
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')
    .replace(/:\s*'([^']*)'/g, ': "$1"')
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
    const looksLikePlaceholder =
      /[A-Z]{2,}/.test(inner) || /[_ ]/.test(inner) || /\b(PASTE|LOCAL|URL|TOPIC|PATH|EXAMPLE|YOUR)\b/i.test(inner);
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
  const inner = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
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

export function extractCompletionText(response: ChatCompletionResponse): string {
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

export function dedupeChatCitations(citations: ChatCitationRecord[]): ChatCitationRecord[] {
  const deduped: ChatCitationRecord[] = [];
  const seen = new Map<string, number>();
  for (const citation of citations) {
    const key = citation.knowledge
      ? [
          "knowledge",
          citation.knowledge.attachmentId,
          citation.knowledge.chunkId ?? citation.knowledge.sectionLabel ?? citation.knowledge.sourceRef,
          citation.knowledge.retrievalMode,
        ]
          .join(":")
          .toLowerCase()
      : citation.url.trim().toLowerCase();
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
      knowledge: existing.knowledge ?? citation.knowledge,
    };
  }
  return deduped;
}

export function shouldRetryToolProtocolError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("invalid_request_error") ||
    message.includes("function name is invalid") ||
    message.includes("reasoning_content is missing") ||
    message.includes("tool call") ||
    message.includes("tool_calls")
  );
}

export function shouldRetryTransientProviderError(error: Error): boolean {
  const message = error.message.toLowerCase();
  const statusMatch = error.message.match(/\((\d{3})(?:\s|[)])?/);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;

  if (status !== undefined && [408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  if (status !== undefined && [401, 403].includes(status)) {
    return /(tempor|timeout|upstream|gateway|proxy|connect|connection|network|unavailable|overload|retry)/.test(
      message,
    );
  }

  return (
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("service unavailable") ||
    message.includes("gateway timeout") ||
    message.includes("temporarily unavailable") ||
    message.includes("too many requests") ||
    message.includes("rate limit")
  );
}

export async function delayChatCompletionRetry(
  deadline: number | undefined,
  timeoutMs: number | undefined,
  retryIndex: number,
): Promise<void> {
  const delayMs = retryIndex === 0 ? 250 : 750;
  if (deadline !== undefined && Date.now() + delayMs >= deadline) {
    throw buildChatCompletionTimeoutError(timeoutMs);
  }
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function normalizeToolProtocolRetryRequest(
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
    const value = toPlainRecord(message);
    if (message.role === "assistant" && value && Array.isArray(value.tool_calls)) {
      const toolCalls = value.tool_calls.map((toolCall) => {
        const tc = toPlainRecord(toolCall) ?? {};
        const fn = toPlainRecord(tc.function) ?? {};
        const rawName = typeof fn.name === "string" ? fn.name : "";
        const normalized = modelToolNameMap.get(rawName) ?? rawName;
        const rawArgs = fn.arguments;
        const normalizedArgs = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
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
      const next: ChatCompletionRequest["messages"][number] & Record<string, unknown> = {
        ...message,
        tool_calls: toolCalls,
      };
      if (attempt === 2 && typeof next.reasoning_content !== "string") {
        next.reasoning_content = "Using tool outputs to continue the response.";
      }
      return next;
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

export function mapCompanionSessionRow(row: Record<string, unknown>): CompanionSessionRecord {
  return {
    sessionId: String(row.session_id ?? ""),
    grantId: String(row.grant_id ?? ""),
    accessTokenHash: String(row.access_token_hash ?? ""),
    accessTokenExpiresAt: String(row.access_token_expires_at ?? new Date().toISOString()),
    refreshTokenHash: String(row.refresh_token_hash ?? ""),
    refreshTokenExpiresAt: String(row.refresh_token_expires_at ?? new Date().toISOString()),
    signingPublicKeyPem: String(row.signing_public_key_pem ?? ""),
    signatureAlgorithm: row.signature_algorithm === "ed25519" ? "ed25519" : "ed25519",
    createdAt: String(row.created_at ?? new Date().toISOString()),
    lastRotatedAt: String(row.last_rotated_at ?? new Date().toISOString()),
    lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : undefined,
    revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : undefined,
    metadata: safeJsonParse<Record<string, unknown>>(
      typeof row.metadata_json === "string" ? row.metadata_json : "{}",
      {},
    ),
    deviceLabel: String(row.device_label ?? "New device"),
    deviceType: String(row.device_type ?? "unknown"),
    platform: typeof row.platform === "string" ? row.platform : undefined,
    grantExpiresAt: typeof row.grant_expires_at === "string" ? row.grant_expires_at : undefined,
    grantRevokedAt: typeof row.grant_revoked_at === "string" ? row.grant_revoked_at : undefined,
  };
}

export function toCompanionSessionInfoResponse(session: CompanionSessionRecord): CompanionSessionInfoResponse {
  return {
    contractId: COMPANION_CONTRACT_ID,
    sessionId: session.sessionId,
    grantId: session.grantId,
    actorId: `companion:${session.sessionId}`,
    deviceLabel: session.deviceLabel,
    deviceType: normalizeDeviceAccessDeviceType(session.deviceType),
    platform: session.platform,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    signatureAlgorithm: session.signatureAlgorithm,
    metadata: session.metadata,
  };
}

export function toCompanionSessionAdminRecord(session: CompanionSessionRecord): CompanionSessionAdminRecord {
  return {
    ...toCompanionSessionInfoResponse(session),
    lastRotatedAt: session.lastRotatedAt,
    revokedAt: session.revokedAt,
    grantExpiresAt: session.grantExpiresAt,
    grantRevokedAt: session.grantRevokedAt,
  };
}

export function isCompanionSessionCurrentlyActive(session: CompanionSessionRecord, nowIso: string): boolean {
  if (session.revokedAt || session.grantRevokedAt) {
    return false;
  }
  const now = Date.parse(nowIso);
  const accessExpiresAt = Date.parse(session.accessTokenExpiresAt);
  if (!Number.isFinite(accessExpiresAt) || accessExpiresAt <= now) {
    return false;
  }
  if (session.grantExpiresAt) {
    const grantExpiresAt = Date.parse(session.grantExpiresAt);
    if (Number.isFinite(grantExpiresAt) && grantExpiresAt <= now) {
      return false;
    }
  }
  return true;
}

function isCompanionSessionRefreshable(session: CompanionSessionRecord, nowIso: string): boolean {
  if (session.revokedAt || session.grantRevokedAt) {
    return false;
  }
  const now = Date.parse(nowIso);
  const refreshExpiresAt = Date.parse(session.refreshTokenExpiresAt);
  if (!Number.isFinite(refreshExpiresAt) || refreshExpiresAt <= now) {
    return false;
  }
  if (session.grantExpiresAt) {
    const grantExpiresAt = Date.parse(session.grantExpiresAt);
    if (Number.isFinite(grantExpiresAt) && grantExpiresAt <= now) {
      return false;
    }
  }
  return true;
}

export function isCompanionSessionOperatorActive(session: CompanionSessionRecord, nowIso: string): boolean {
  if (session.revokedAt || session.grantRevokedAt) {
    return false;
  }
  const now = Date.parse(nowIso);
  const refreshExpiresAt = Date.parse(session.refreshTokenExpiresAt);
  if (!Number.isFinite(refreshExpiresAt) || refreshExpiresAt <= now) {
    return false;
  }
  if (session.grantExpiresAt) {
    const grantExpiresAt = Date.parse(session.grantExpiresAt);
    if (Number.isFinite(grantExpiresAt) && grantExpiresAt <= now) {
      return false;
    }
  }
  return true;
}

export function normalizeCompanionAuditEvent(value: unknown): CompanionAuditEventRecord["event"] {
  switch (value) {
    case "auth.companion_session.exchange":
    case "auth.companion_session.refresh":
    case "auth.companion_session.revoke":
    case "auth.companion_request.accepted":
    case "auth.companion_request.timestamp_invalid":
    case "auth.companion_request.signature_invalid":
    case "auth.companion_request.replay_rejected":
    case "auth.companion_request.session_inactive":
      return value;
    default:
      return "auth.companion_request.accepted";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? { ...value } : undefined;
}

function isChatTurnBranchKind(value: unknown): value is ChatTurnBranchKind {
  return value === "append" || value === "retry" || value === "edit";
}

function isChatStreamUsageRecord(value: unknown): value is ChatStreamUsageRecord {
  return (
    isRecord(value) &&
    (value.inputTokens === undefined || typeof value.inputTokens === "number") &&
    (value.outputTokens === undefined || typeof value.outputTokens === "number") &&
    (value.cachedInputTokens === undefined || typeof value.cachedInputTokens === "number") &&
    (value.costUsd === undefined || typeof value.costUsd === "number")
  );
}

function isChatToolRunRecord(value: unknown): value is ChatToolRunRecord {
  return (
    isRecord(value) &&
    typeof value.toolRunId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.toolName === "string" &&
    (value.status === "started" ||
      value.status === "executed" ||
      value.status === "blocked" ||
      value.status === "approval_required" ||
      value.status === "failed") &&
    typeof value.startedAt === "string" &&
    (value.finishedAt === undefined || typeof value.finishedAt === "string") &&
    (value.approvalId === undefined || typeof value.approvalId === "string") &&
    (value.args === undefined || isRecord(value.args)) &&
    (value.result === undefined || isRecord(value.result)) &&
    (value.reused === undefined || typeof value.reused === "boolean") &&
    (value.reusedFromToolRunId === undefined || typeof value.reusedFromToolRunId === "string") &&
    (value.reuseReason === undefined || typeof value.reuseReason === "string") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.failureGuidance === undefined || typeof value.failureGuidance === "string")
  );
}

function isChatTurnRepairRecord(value: unknown): value is ChatTurnRepairRecord {
  return (
    isRecord(value) &&
    typeof value.applied === "boolean" &&
    (value.kind === undefined || typeof value.kind === "string") &&
    (value.source === undefined || typeof value.source === "string") &&
    (value.preRepairContent === undefined || typeof value.preRepairContent === "string") &&
    (value.postRepairContent === undefined || typeof value.postRepairContent === "string")
  );
}

function isChatCitationRecord(value: unknown): value is ChatCitationRecord {
  return (
    isRecord(value) &&
    typeof value.citationId === "string" &&
    typeof value.url === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.snippet === undefined || typeof value.snippet === "string") &&
    (value.knowledge === undefined ||
      (isRecord(value.knowledge) &&
        typeof value.knowledge.attachmentId === "string" &&
        typeof value.knowledge.sourceRef === "string" &&
        typeof value.knowledge.title === "string" &&
        (value.knowledge.sectionLabel === undefined || typeof value.knowledge.sectionLabel === "string") &&
        (value.knowledge.chunkId === undefined || typeof value.knowledge.chunkId === "string") &&
        (value.knowledge.excerpt === undefined || typeof value.knowledge.excerpt === "string") &&
        (value.knowledge.retrievalMode === "full_text" || value.knowledge.retrievalMode === "retrieval"))) &&
    (value.sourceType === undefined ||
      value.sourceType === "web" ||
      value.sourceType === "file" ||
      value.sourceType === "tool")
  );
}

function isChatTurnTraceRecord(value: unknown): value is ChatTurnTraceRecord {
  return (
    isRecord(value) &&
    typeof value.turnId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.userMessageId === "string" &&
    (value.branchKind === "append" || value.branchKind === "retry" || value.branchKind === "edit") &&
    typeof value.status === "string" &&
    typeof value.mode === "string" &&
    typeof value.webMode === "string" &&
    typeof value.memoryMode === "string" &&
    typeof value.thinkingLevel === "string" &&
    typeof value.startedAt === "string" &&
    Array.isArray(value.toolRuns) &&
    value.toolRuns.every(isChatToolRunRecord) &&
    Array.isArray(value.citations) &&
    value.citations.every(isChatCitationRecord) &&
    isRecord(value.routing)
  );
}

function chatStreamChunkToRecord(chunk: ChatStreamChunk): Record<string, unknown> {
  return { ...chunk };
}

function toChatStreamChunk(value: unknown): ChatStreamChunk | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.sessionId !== "string") {
    return undefined;
  }
  const common = {
    type: value.type,
    sessionId: value.sessionId,
    eventId: typeof value.eventId === "string" ? value.eventId : "",
    sequence: typeof value.sequence === "number" && Number.isFinite(value.sequence) ? value.sequence : 0,
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
  };
  switch (value.type) {
    case "message_start":
      if (
        typeof value.turnId !== "string" ||
        typeof value.messageId !== "string" ||
        !isChatTurnBranchKind(value.branchKind)
      ) {
        return undefined;
      }
      return {
        ...common,
        type: "message_start",
        turnId: value.turnId,
        messageId: value.messageId,
        branchKind: value.branchKind,
        ...(typeof value.parentTurnId === "string" ? { parentTurnId: value.parentTurnId } : {}),
        ...(typeof value.sourceTurnId === "string" ? { sourceTurnId: value.sourceTurnId } : {}),
      };
    case "delta":
      return typeof value.turnId === "string" && typeof value.delta === "string"
        ? {
            ...common,
            type: "delta",
            turnId: value.turnId,
            delta: value.delta,
            ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
          }
        : undefined;
    case "usage":
      return typeof value.turnId === "string" && isChatStreamUsageRecord(value.usage)
        ? {
            ...common,
            type: "usage",
            turnId: value.turnId,
            usage: value.usage,
            ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
          }
        : undefined;
    case "message_done":
      return typeof value.turnId === "string" &&
        typeof value.messageId === "string" &&
        typeof value.content === "string"
        ? {
            ...common,
            type: "message_done",
            turnId: value.turnId,
            messageId: value.messageId,
            content: value.content,
            ...(typeof value.repaired === "boolean" ? { repaired: value.repaired } : {}),
            ...(isChatTurnRepairRecord(value.repair) ? { repair: value.repair } : {}),
          }
        : undefined;
    case "tool_start":
    case "tool_result":
      return typeof value.turnId === "string" && isChatToolRunRecord(value.toolRun)
        ? {
            ...common,
            type: value.type,
            turnId: value.turnId,
            toolRun: value.toolRun,
          }
        : undefined;
    case "approval_required":
      return typeof value.turnId === "string" &&
        isRecord(value.approval) &&
        typeof value.approval.approvalId === "string"
        ? {
            ...common,
            type: "approval_required",
            turnId: value.turnId,
            approval: {
              approvalId: value.approval.approvalId,
              ...(typeof value.approval.toolName === "string" ? { toolName: value.approval.toolName } : {}),
              ...(typeof value.approval.reason === "string" ? { reason: value.approval.reason } : {}),
              ...(typeof value.approval.expiresAt === "string" ? { expiresAt: value.approval.expiresAt } : {}),
            },
          }
        : undefined;
    case "trace_update":
      return typeof value.turnId === "string" && isChatTurnTraceRecord(value.trace)
        ? {
            ...common,
            type: "trace_update",
            turnId: value.turnId,
            trace: value.trace,
          }
        : undefined;
    case "citation":
      return typeof value.turnId === "string" && isChatCitationRecord(value.citation)
        ? {
            ...common,
            type: "citation",
            turnId: value.turnId,
            citation: value.citation,
          }
        : undefined;
    case "capability_upgrade_suggestion":
      return typeof value.turnId === "string" && Array.isArray(value.capabilityUpgradeSuggestions)
        ? {
            ...common,
            type: "capability_upgrade_suggestion",
            turnId: value.turnId,
            capabilityUpgradeSuggestions: value.capabilityUpgradeSuggestions as ChatCapabilityUpgradeSuggestion[],
          }
        : undefined;
    case "error":
      return typeof value.error === "string"
        ? {
            ...common,
            type: "error",
            error: value.error,
            ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
          }
        : undefined;
    case "done":
      return typeof value.turnId === "string" && typeof value.messageId === "string"
        ? {
            ...common,
            type: "done",
            turnId: value.turnId,
            messageId: value.messageId,
          }
        : undefined;
    default:
      return undefined;
  }
}

function durableChatTurnPayloadToRecord(payload: DurableChatTurnExecutionPayload): Record<string, unknown> {
  return { ...payload };
}

function userInputPromptResponseToRecord(response: ChatUserInputPromptResponse): Record<string, unknown> {
  return response.kind === "text"
    ? { kind: "text", text: response.text }
    : { kind: "single_select", optionId: response.optionId };
}

function toSkillStateRows(value: unknown): SkillStateRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is SkillStateRecord =>
          isRecord(row) &&
          typeof row.skillId === "string" &&
          typeof row.state === "string" &&
          (typeof row.note === "string" || row.note === null) &&
          typeof row.updatedAt === "string" &&
          (typeof row.firstAutoApprovedAt === "string" || row.firstAutoApprovedAt === null),
      )
    : [];
}

export function normalizeCompanionNonce(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 8 ||
    normalized.length > COMPANION_REQUEST_NONCE_MAX_LENGTH ||
    !/^[A-Za-z0-9._~-]+$/.test(normalized)
  ) {
    throw new Error("Companion request nonce is invalid.");
  }
  return normalized;
}

export function normalizeCompanionSignature(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 16 ||
    normalized.length > COMPANION_REQUEST_SIGNATURE_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(normalized)
  ) {
    throw new Error("Companion request signature is invalid.");
  }
  return normalized;
}

export function normalizeCompanionRequestPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Companion request path is required.");
  }
  try {
    const parsed = new URL(trimmed, "http://goatcitadel.local");
    if (parsed.search) {
      throw new Error("Companion signed mutations must not include query parameters.");
    }
    return parsed.pathname || "/";
  } catch {
    if (!trimmed.startsWith("/")) {
      throw new Error("Companion request path must be absolute.");
    }
    if (trimmed.includes("?")) {
      throw new Error("Companion signed mutations must not include query parameters.");
    }
    return trimmed.split("?", 1)[0] || "/";
  }
}

export function decodeBase64Url(value: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new Error("Companion request signature encoding is invalid.");
  }
}

export function buildCompanionSigningPayload(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: unknown;
}): string {
  const method = input.method.trim().toUpperCase();
  const canonicalBody = canonicalizeCompanionBody(input.body);
  const bodyHash = createHash("sha256").update(canonicalBody, "utf8").digest("hex");
  return `${method}\n${input.path}\n${input.timestamp.trim()}\n${input.nonce}\n${bodyHash}`;
}

function canonicalizeCompanionBody(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(sortCompanionJsonValue(value));
}

function sortCompanionJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortCompanionJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortCompanionJsonValue((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function createChatCompletionDeadline(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Date.now() + Math.floor(timeoutMs);
}

export function getRemainingChatCompletionTimeoutMs(
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

export function normalizeChatCompletionAttemptError(error: unknown, timeoutMs: number | undefined): Error {
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
    name.includes("timeout") ||
    name.includes("abort") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("aborted")
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

function hasExplicitRealtimeMetadata(
  options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links">,
): boolean {
  if (!options?.eventClass || !options?.eventAuthority || !options.links) {
    return false;
  }
  return Object.values(options.links).some((value) => typeof value === "string" && value.trim().length > 0);
}

function requiresExplicitRealtimeMetadata(eventType: string, source: string): boolean {
  const normalizedType = eventType.trim().toLowerCase();
  const normalizedSource = source.trim().toLowerCase();
  if (
    normalizedType === "approval_created" ||
    normalizedType === "approval_resolved" ||
    normalizedType === "session_event" ||
    normalizedType === "auth_device_request_created" ||
    normalizedType === "auth_device_request_resolved" ||
    normalizedType === "task_created" ||
    normalizedType === "task_updated" ||
    normalizedType === "task_deleted" ||
    normalizedType === "orchestration_event"
  ) {
    return true;
  }
  return normalizedSource === "orchestration";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
