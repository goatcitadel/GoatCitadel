/* eslint-disable @typescript-eslint/no-unused-vars, max-lines */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isVerboseLoggingEnabled } from "../runtime-ux.js";
import { EventIngestService, logger } from "@goatcitadel/gateway-core";
import type { LogContext } from "@goatcitadel/gateway-core";

const log = logger.child("gateway-service");
const durableRunLogger: DurableRunServiceLogger = {
  info: (data: unknown, msg: string) => log.info(msg, toLogContext(data)),
  debug: (data: unknown, msg: string) => log.debug(msg, toLogContext(data)),
  warn: (data: unknown, msg: string) => log.warn(msg, toLogContext(data)),
  error: (data: unknown, msg: string) => log.error(msg, toLogContext(data)),
};

const INIT_STEP_SLOW_WARNING_MS = 10_000;

function toLogContext(data: unknown): LogContext {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as LogContext;
  }
  return { value: data };
}

/**
 * Wrap a step inside the gateway's critical-init path so a hung step is
 * visible in real time instead of presenting as 120s of silence followed by
 * a supervisor health-timeout restart.
 *
 * Behaviour:
 * - Silent in the happy path (steps complete within 10s).
 * - After 10s of a single step still running, logs a `warn` so the operator
 *   can see *which* step is stuck, even if the supervisor eventually kills
 *   the process before initCritical returns.
 * - On completion, always logs the elapsed ms when a slow warning fired, and
 *   always logs in verbose mode for full-step timing.
 *
 * This is intentionally lightweight (one setTimeout per step, cleared on
 * resolve) and has no behavioural side effects on the underlying work.
 */
async function traceInitStep<T>(stepName: string, fn: () => Promise<T> | T): Promise<T> {
  const startedAt = Date.now();
  let warned = false;
  const warningTimer = setTimeout(() => {
    warned = true;
    log.warn(`initCritical step "${stepName}" still running after ${Math.round(INIT_STEP_SLOW_WARNING_MS / 1000)}s`);
  }, INIT_STEP_SLOW_WARNING_MS);
  warningTimer.unref();
  try {
    return await fn();
  } finally {
    clearTimeout(warningTimer);
    const elapsedMs = Date.now() - startedAt;
    if (warned) {
      log.warn(`initCritical step "${stepName}" completed in ${elapsedMs}ms`);
    } else if (isVerboseLoggingEnabled()) {
      log.info(`initCritical step "${stepName}" completed in ${elapsedMs}ms`);
    }
  }
}
import { MeshService } from "@goatcitadel/mesh-core";
import { OrchestrationEngine, type TurnRuntime } from "@goatcitadel/orchestration";
import {
  ToolPolicyEngine,
  assertWritePathInJail,
  describeBrowserSessionState,
  fetchAllowlisted,
} from "@goatcitadel/policy-engine";
import { listSkillExportTargets, renderSkillExportPreview, SkillsService } from "@goatcitadel/skills";
import {
  type Storage,
  type SessionAutonomyPrefsPatchInput,
  type SessionAutonomyPrefsRecord,
} from "@goatcitadel/storage";
import {
  buildChatModePrefsPatch,
  chatModeAllowsDynamicTeamGrowth,
  ConflictError,
  DEFAULT_CITADEL_ID,
  inferProviderForModelId,
  isChatTurnActiveStatus,
  isChatTurnTerminalStatus,
  NotFoundError,
  PolicyViolationError,
  providerAllowsForeignModelIds,
  sanitizeChannelOutboundMessage,
  ValidationError,
} from "@goatcitadel/contracts";
import { buildUnifiedConfigPayload } from "../config-sync-lib.js";
import { isLoopbackDevOrigin } from "../cors-origin-guard.js";
import { createGatewayStorage } from "../storage-factory.js";
import { DatabaseCutoverService } from "./database-cutover-service.js";
import { startBackgroundInterval, type BackgroundIntervalHandle } from "./background-scheduler.js";
import { getZonedDateParts, toDayKeyForTimezone, toHourKeyForTimezone } from "./scheduler-timing.js";
import { suggestImportedCatalogEntries } from "./agency-agent-catalog-service.js";
import { PersonalityCatalogService } from "./channel-personalities.js";
import { ApprovalRuntimeService } from "./approval-runtime-service.js";
import { SurfaceRouterService } from "./surface-router-service.js";
import { buildSurfaceRouterJudge } from "./surface-router-judge.js";
import { CapabilityScopeResolver, isCapabilityAllowed } from "./capability-scope-resolver.js";
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
  AuthSettingsUpdateInput,
  ToolApprovalMode,
  DeviceAccessRequestCreateInput,
  DeviceAccessRequestCreateResponse,
  DeviceAccessGrantRecord as DeviceAccessGrantContractRecord,
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
  ChannelActivityInput,
  ChannelActivityResult,
  ChannelAttachmentInput,
  ChannelDeliveryDiagnostics,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelSendInput,
  ChannelTypingInput,
  ChannelTypingResult,
  ChannelUnsendInput,
  ChannelInboundMessageInput,
  DiscordPairingRecord,
  DiscordRuntimeStatus,
  ChatAttachmentRecord,
  ChatCapabilityUpgradeSuggestion,
  ChatCancelTurnResponse,
  ChatCitationRecord,
  ChatGeneratedArtifactRecord,
  ChatDelegateRequest,
  ChatDelegateResponse,
  ChatDelegationStepRecord,
  ChatMemoryMode,
  ChatMode,
  ChatMessageRecord,
  ChatProactiveMode,
  ChatProjectRecord,
  ChatReflectionMode,
  ChatRetrievalMode,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionCreateInput,
  ChatSessionPrefsRecord,
  ChatSessionBindingRecord,
  ChatSessionListQuery,
  ChatSessionRecord,
  ChatSessionSearchQuery,
  ChatSessionSearchResponse,
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
  ChatThinkingLevel,
  CapabilityCatalogScope,
  CapabilityCatalogSnapshotRecord,
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
  MemoryContextPack,
  MemoryContextPlacement,
  MemoryRelationScope,
  MemoryMaintenanceRunNowInput,
  MemoryMaintenanceRunRecord,
  MemoryMaintenanceStatusRecord,
  MemorySearchQuery,
  MemoryWriteInput,
  CronAgentTurnConfig,
  CronJobRecord,
  DashboardState,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  GatewayEventInput,
  GatewayEventResult,
  IntegrationPluginRecord,
  IntegrationConnection,
  IntegrationConnectionCreateInput,
  IntegrationConnectionUpdateInput,
  HookCreateInput,
  HookDecisionBlock,
  HookRecord,
  HookRunRecord,
  HookUpdateInput,
  McpInvokeRequest,
  McpInvokeResponse,
  McpOAuthStartResponse,
  McpServerPolicy,
  McpServerTemplateRecord,
  McpServerCreateInput,
  McpServerRecord,
  McpServerUpdateInput,
  McpToolRecord,
  LlmConfigFile,
  LlmModelRecord,
  LlmProviderRequestConfig,
  LlmRuntimeConfig,
  LlmRuntimeMeasurementRecord,
  LlamaCppAdvisorRecommendation,
  LlamaCppAdvisorRequest,
  LlamaCppModelManifest,
  LlamaCppRuntimeStatus,
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
  OrchestrationDecisionTrace,
  OrchestrationPlan,
  OrchestrationRun,
  OrchestrationRunPolicyContext,
  PendingApprovalAction,
  RealtimeEvent,
  RuntimeDecisionTraceAppendInput,
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
  SkillExportPackageResponse,
  SkillExportPreviewResponse,
  SkillExportRequest,
  SkillExportTargetProfile,
  SkillImportHistoryRecord,
  SkillImportValidationResult,
  SkillListItem,
  SkillSourceListResponse,
  SkillSourceLookupResponse,
  SkillSourceProvider,
  SkillRuntimeState,
  SkillStateRecord,
  SkillResolveInput,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryItemType,
  LearnedMemoryUpdateInput,
  DurableCheckpointRecord,
  ConnectorDeliveryWorkflowPayload,
  DurableDeadLetterRecord,
  DurableDiagnosticsResponse,
  DurableRunRecord,
  DurableRunStatus,
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
  ToolGrantScope,
  TaskUpdateInput,
  GmailReadQuery,
  GmailSendInput,
  ToolInvokeRequest,
  ToolInvokeResult,
  LocalOperatorOverrideCreateInput,
  LocalOperatorOverrideRecord,
  PermissionProfileActivationInput,
  PermissionProfileActivationRecord,
  PermissionProfileCreateInput,
  PermissionProfileRecord,
  PermissionProfileUpdateInput,
  PermissionSurface,
  ToolPolicyActorContext,
  ModelReputation,
  GuidanceDocType,
  GuidanceDocumentRecord,
  ImprovementRef,
  OperatorProfileRecord,
  MemoryItemRecord,
  ConnectorDiagnosticReport,
  OrchestrationPlanWorkflowPayload,
  CronReviewItem,
  CronRunDiff,
  CronWatchdogRunResult,
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
import { AgentSubagentDefaultsSchema, BUILTIN_AGENT_PROFILES } from "@goatcitadel/contracts";
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
import * as chatMessageHistoryService from "./chat-message-history-service.js";
import { buildSelectedPathTurnIds } from "./chat-thread-utils.js";
import * as chatAttachmentService from "./chat-attachment-service.js";
import * as chatGeneratedArtifactService from "./chat-generated-artifact-service.js";
import * as chatThreadKnowledgeService from "./chat-thread-knowledge-service.js";
import * as chatToolArtifactService from "./chat-tool-artifact-service.js";
import { buildOrchestrationPlan } from "../orchestration/router.js";
import type {
  OrchestrationExecutionResult,
  OrchestrationPlan as ModeOrchestrationPlan,
  OrchestrationRouterInput,
  OrchestrationStepExecutionResult,
} from "../orchestration/types.js";
import { type ChannelSetupRecentTestCacheEntry } from "./channel-setup-test-cache.js";
import { MemoryContextService } from "./memory-context-service.js";
import { LlamaCppRuntimeService } from "./llama-cpp-runtime-service.js";
import { NpuSidecarService } from "./npu-sidecar-service.js";
import { SecretStoreService } from "./secret-store-service.js";
import { GatewayTurnRuntime } from "./chat-turn-runtime.js";
import { ResearchService } from "./research-service.js";
import { ObsidianVaultService } from "./obsidian-vault-service.js";
import { SkillImportService } from "./skill-import-service.js";
import { SkillMutationService, type SkillMutationSnapshot } from "./skill-mutation-service.js";
import { AddonsService } from "./addons-service.js";
import { AddonSlotService } from "./addon-slot-service.js";
import {
  GatewayDevDiagnosticsService,
  resolveDevDiagnosticsBufferSize,
  resolveDevDiagnosticsEnabled,
  resolveDevDiagnosticsVerbose,
} from "../dev-diagnostics/service.js";
import { serializePathWithinRoot } from "./security-utils.js";
import { MediaVoiceService } from "./media-voice-service.js";
import {
  COST_REPORT_HOURLY_JOB_ID,
  CronAutomationService,
  MEMORY_FLUSH_DAILY_JOB_ID,
  PRIVATE_BETA_BACKUP_JOB_ID,
  UPDATE_REVIEW_DAILY_JOB_ID,
} from "./gateway/cron-automation-service.js";
import { runNoAgentCommand } from "./gateway/cron-no-agent-runner.js";
import type { AgentTurnCronRunOutcome } from "./gateway/cron-agent-turn-support.js";
import {
  type AutonomousTurnKind,
  buildAutonomousTurnContext,
  HEARTBEAT_PERMISSION_PROFILE_ID,
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
} from "./gateway/autonomous-turn-policy.js";
import { BackgroundReviewService } from "./background-review-service.js";
import { CommitmentClassifierService } from "./gateway/commitment-classifier-service.js";
import { buildCommitmentCheckInPrompt, runCommitmentSweep } from "./gateway/commitment-sweep-service.js";
import {
  buildScheduledCreatorIntersectionProfile,
  permissionProfileAppliesToCreator,
} from "./gateway/scheduled-profile-intersection.js";
import { runHeartbeatTick } from "./gateway/heartbeat-service.js";
import {
  buildScheduleCreateActionConfig,
  isScheduledTurnContext,
  parseScheduleManageArgs,
  resolveScheduleCreatorKey,
  summarizeScheduleJob,
  validateScheduleCreate,
} from "./gateway/schedule-tool-support.js";
import * as orchestrationLifecycleService from "./orchestration-lifecycle-service.js";
import { OrchestrationPhaseExecutionService } from "./orchestration-phase-execution-service.js";
import { OrchestrationWorktreeService } from "./orchestration-worktree-service.js";
import { OperatorSummaryCache } from "./gateway/operator-summary-cache.js";
import { DiscordRuntimeService } from "./discord-runtime-service.js";
import { createDailyUpdateReview, renderUpdateReviewMarkdown } from "./gateway/update-review.js";
import { resolveGatewayInstallToken as resolveGatewayInstallTokenFromPlanner } from "./gateway/auth-credential-planner.js";
import type { GatewayRouteServices } from "./gateway-route-services.js";
import {
  composeGatewayRouteServices,
  createChatThreadKnowledgeDependenciesForGateway,
  createCommsHostForGateway,
  createGatewayRouteCompositionPort,
  createIntegrationChannelServiceForGateway,
  createIntegrationDiagnosticsServiceForGateway,
  createSettingsAuthRuntimeDependenciesForGateway,
  createSettingsRuntimeDependenciesForGateway,
  type GatewayRouteCompositionPort,
} from "./gateway-route-service-composition.js";
import { RealtimeEventService } from "./realtime-event-service.js";
import { BackupRetentionService } from "./backup-retention-service.js";
import * as settingsAuthService from "./settings-auth-service.js";
import * as onboardingStateService from "./onboarding-state-service.js";
import * as mcpDiagnosticsService from "./mcp-diagnostics-service.js";
import * as mcpServerAdminService from "./mcp-server-admin-service.js";
import { buildPublicMcpAuthState, McpOAuthTokenService } from "./mcp-oauth-token-service.js";
import { McpElicitationService } from "./mcp-elicitation-service.js";
import { GatewayMcpOAuthService } from "./gateway-mcp-oauth-service.js";
import * as connectorDiagnosticsHelpers from "./connector-diagnostics-helpers.js";
import * as discordPairingHelpers from "./discord-pairing-helpers.js";
import * as discordRuntimeBridgeService from "./discord-runtime-bridge-service.js";
import * as connectionUrlHelpers from "./connection-url-helpers.js";
import * as onboardingMarkerHelpers from "./onboarding-marker-helpers.js";
import { GuidanceService } from "./guidance-service.js";
import * as cronJobConfigHelpers from "./cron-job-config-helpers.js";
import * as chatCommandService from "./chat-command-service.js";
import { createChatCommandDependencies } from "./chat-command-dependencies.js";
import type * as chatMessageRouteRuntime from "./chat-message-route-runtime.js";
import * as chatSessionService from "./chat-session-service.js";
import * as llmCompletionService from "./llm-completion-service.js";
import * as durableExecutionService from "./durable-execution-service.js";
import * as chatDurableRunService from "./chat-durable-run-service.js";
import * as chatTurnPrepService from "./chat-turn-prep-service.js";
import * as chatTurnTraceHydration from "./chat-turn-trace-hydration.js";
import * as chatTurnUserMessage from "./chat-turn-user-message.js";
import {
  ChatDelegationService,
  type ChatDelegationProgressCallbacks,
  type ChatDelegationRunOptions,
} from "./chat-delegation-service.js";
import { ChatSteerService } from "./chat-steer-service.js";
import * as chatTurnStreamService from "./chat-turn-stream-service.js";
import { SubagentFanoutRuntime } from "./chat-subagent-fanout-service.js";
import * as chatTurnDispatchService from "./chat-turn-dispatch-service.js";
import { createChatTurnRuntimeHost, type ChatTurnRuntimeHost } from "./chat-turn-runtime-host-composition.js";
import { ChatTurnRuntimeService } from "./chat-turn-runtime-service.js";
import { ToolInvocationCoordinatorService } from "./tool-invocation-coordinator-service.js";
import { CapabilityPackService } from "./capability-pack-service.js";
import { ContinuationGateService } from "./continuation-gate-service.js";
import { EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import { RuntimeDecisionRecorder } from "./runtime-decision-recorder.js";
import { MemoryWriteGateService } from "./memory-write-gate-service.js";
import { OperatorProfileService } from "./operator-profile-service.js";
import { AutonomyControlService } from "./autonomy-control-service.js";
import {
  ChatTurnExecutionRegistry,
  type ActiveChatTurnExecution,
  type ActiveChatTurnStreamExecution,
  ChatTurnWriteConflictError,
} from "./chat-turn-execution-registry.js";
import { buildDelegatedSessionToolGrantCopies } from "./delegated-session-tool-grants.js";
import {
  resolveProjectRootForToolContext,
  resolveToolRequestPaths as resolveToolRequestPathsForContext,
} from "./tool-path-resolution.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import type {
  ApprovalReplayResult,
  ApprovalResolveResult,
  RemoteApprovalActionTokenIssueResult,
} from "./approval-types.js";
import {
  isRecord,
  type CompanionAccessValidationResult,
  type CompanionSessionRecord,
} from "./companion-auth-helpers.js";
import type {
  DurableChatTurnExecutionPayload,
  InspectableChatStreamChunk,
  PersistableChatStreamChunk,
  PreparedChatExecutionPlanResolution,
} from "./chat-turn-types.js";
import { DEFAULT_DELEGATION_ROLES, detectDelegationRoles, truncateSummaryLine } from "./chat-turn-helpers.js";
import {
  buildRoleGapSpecialistSuggestion,
  buildSpecialistSuggestionFromCapability,
  extractSpecialistObjectiveKeywords,
  mergeSpecialistEvidence,
  mergeSpecialistRoutingHints,
  normalizeSpecialistCandidateFingerprint,
  type ResolvedRuntimeGuidance,
} from "./chat-turn-planning-helpers.js";
import { buildMemoryContextSystemMessage } from "./llm-completion-helpers.js";
import { ChatProjectService } from "./chat-project-service.js";
import { DurableRunService, type DurableRunServiceLogger } from "./durable-run-service.js";
import { DurableOperatorService } from "./durable-operator-service.js";
import { HooksService } from "./hooks-service.js";
import { ChatLearnedMemoryService } from "./chat-learned-memory-service.js";
import { PromptPackService } from "./prompt-pack-service.js";
import { ChatProactiveService } from "./chat-proactive-service.js";
import { ImprovementService } from "./improvement-service.js";
import {
  readBlockerTemplateStrictness,
  readLiveIntentThreshold,
  readRetryRepairThreshold,
} from "./improvement-tune-reads.js";
import { CuratorService } from "./curator-service.js";
import { writeCuratorReport } from "./curator-report.js";
import { MemoryMaintenanceService } from "./memory-maintenance-service.js";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { RuntimeLifecycleReadService } from "./runtime-lifecycle-read-service.js";
import { CapabilitySystemService } from "./capability-system-service.js";
import type { BaseAgentPromptSkill, BaseAgentPromptToolset } from "./base-agent-system-prompt.js";
import { TaskLifecycleService } from "./task-lifecycle-service.js";
import { BrowserSessionRuntimeService } from "./browser-session-runtime-service.js";
import { ReviewReadinessService } from "./review-readiness-service.js";
import { createDefaultArtifactProbers, createDurableTaskAutoBlockBridge } from "./gateway-kanban-wiring.js";
import {
  ChannelDeliveryRuntimeService,
  type ChannelDeliveryRuntimeRecord,
  type ChannelDeliveryRuntimeSendInput,
} from "./channel-delivery-runtime-service.js";
import { ReplayExecutionSkippedError } from "./replay-execution.js";
import { evaluateDeploymentProfileToolAccess } from "../browser-runtime-guardrails.js";
import { buildGatewayConnectorRecords, filterConnectorRecords } from "./connector-registry.js";
import { buildApprovalRemoteTokenConnectorDeliveryPayload } from "./approval-connector-delivery.js";
import {
  commsActivity as commsActivityImpl,
  commsSend as commsSendImpl,
  commsReact as commsReactImpl,
  commsUnsend as commsUnsendImpl,
  commsTyping as commsTypingImpl,
  commsGmailRead as commsGmailReadImpl,
  commsGmailSend as commsGmailSendImpl,
  commsCalendarList as commsCalendarListImpl,
  commsCalendarCreate as commsCalendarCreateImpl,
  type CommsHost,
} from "./comms-service.js";
import { buildChannelVoiceReplyAttachment } from "./channel-voice-reply-service.js";
import { listChatModelSuggestions } from "./chat-model-suggestions.js";
import {
  MCP_APPROVAL_INBOX_URL,
  createInternalMcpApprovalInboxTools,
  isInternalMcpApprovalInboxServer,
} from "./mcp-approval-inbox.js";
import {
  MCP_DURABLE_TASKS_URL,
  createInternalMcpDurableTasksTools,
  isInternalMcpDurableTasksServer,
} from "./mcp-durable-tasks.js";
import { isVisibleMcpTemplateRecord } from "./mcp-template-visibility.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { applyMcpRedaction, inferMcpCategory, normalizeMcpPolicy, wildcardMatch } from "./mcp-server-policy.js";
import { ApprovalEffectsService } from "./approval-resolution-effects-service.js";

export interface MemoryFileEntry {
  relativePath: string;
  size: number;
  modifiedAt: string;
}

const MCP_SERVERS_SETTING_KEY = "mcp_servers_v1";
const MCP_TOOLS_SETTING_KEY = "mcp_tools_v1";
const MCP_TOOL_FIRST_APPROVAL_SETTING_KEY = "mcp_tool_first_approval_v1";
const GATEWAY_OWNED_MCP_CREATED_AT = "2026-05-26T00:00:00.000Z";
const GATEWAY_OWNED_MCP_SERVER_IDS = new Set([
  "goatcitadel-internal-approval-inbox",
  "goatcitadel-internal-durable-tasks",
]);
const DISCORD_PAIRINGS_SETTING_KEY = "discord_pairings_v1";
const SKILL_ACTIVATION_POLICY_SETTING_KEY = "skill_activation_policy_v1";
const FEATURE_FLAGS_SETTING_KEY = "feature_flags_v1";
const CHAT_STREAM_EVENT_POLL_INTERVAL_MS = 200;
const CHAT_STREAM_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
import { hashSensitiveToken } from "./device-access-helpers.js";
import { DeviceTokenVault } from "./device-token-vault.js";

export const MEMORY_ITEM_STATUS_VALUES = new Set(["active", "forgotten"]);

const DEFAULT_SKILL_ACTIVATION_POLICY: SkillActivationPolicy = {
  guardedAutoThreshold: 0.72,
  requireFirstUseConfirmation: true,
};
const SKILL_STATE_METADATA_SETTING_KEY = "skill_state_metadata_v1";
const CHAT_SESSION_AUTO_ALLOW_TOOLS = [
  "browser.search",
  "browser.navigate",
  "browser.extract",
  "http.get",
  // P2-S4a: read-only tier-2 recall over this conversation's own message history.
  "session.search",
  "local_business.research",
] as const;
const INTERNAL_TOOL_GRANT_TTL_MS = 5 * 60 * 1000;

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
/**
 * P2-S1 background-review counter gate. A successful, eligible root turn bumps
 * this counter; the self-improvement review runs (and resets it) once it reaches
 * {@link BACKGROUND_REVIEW_TURN_INTERVAL}. Stored in `system_settings`.
 */
const BACKGROUND_REVIEW_TURNS_SINCE_SETTING_KEY = "background_review_turns_since_v1";
const BACKGROUND_REVIEW_TURN_INTERVAL = 5;
const UPDATE_REVIEW_DAILY_DEDUP_SETTING_KEY = "update_review_daily_last_day_key_v1";
const IMPROVEMENT_SCHEDULER_INTERVAL_MS = 60_000;
const maintenanceSchedulerDisabled =
  process.env.GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER?.trim().toLowerCase() === "true";
// Orphaned orchestration worktrees (no live/active run) accumulate unbounded
// without periodic reaping. Reap hourly, with a short post-boot pass so a fresh
// process reclaims stale worktrees promptly. reapOrphaned stays conservative
// via its own active-run + min-age (~1h) + path-jail guards.
const ORCHESTRATION_WORKTREE_REAP_INTERVAL_MS = 60 * 60 * 1000;
const ORCHESTRATION_WORKTREE_REAP_BOOT_DELAY_MS = 30_000;
const MEMORY_FLUSH_HISTORY_DAYS = 30;
const MEMORY_FLUSH_EXPIRED_BATCH_LIMIT = 500;
const MEMORY_FLUSH_EXPIRED_SAFETY_LIMIT = 10_000;
const COST_REPORT_LOOKBACK_HOURS = 1;
const COST_REPORT_OUTPUT_DIR = "artifacts/cost-reports";
const UPDATE_REVIEW_OUTPUT_DIR = "artifacts/update-review";
const IMPROVEMENT_REPAIR_POLICY_CONFIG_SETTING_KEY = "improvement_repair_policy_config_v1";
const IMPROVEMENT_ROUTING_POLICY_CONFIG_SETTING_KEY = "improvement_routing_policy_config_v1";
const PIPELINE_TEMPLATES: Record<string, string[]> = {
  prd: ["product", "architect"],
  build: ["architect", "coder", "qa"],
  triage: ["qa", "ops", "product"],
  release: ["qa", "ops", "product"],
};
export const DEFAULT_WORKSPACE_ID = "default";
const SYNTHETIC_PERMISSION_PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const SYNTHETIC_PERMISSION_PROFILE_MAX_ENTRIES = 500;
const REPLAY_SCRATCH_SESSION_TITLE_PREFIX = "[Replay scratch]";
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

const VALID_TOOL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

function isValidToolName(name: string): boolean {
  return VALID_TOOL_NAME_PATTERN.test(name);
}

// SECURITY (codex finding #13, #23): Env-var names that an integration
// connection is allowed to reference via `authTokenEnv`/`accessTokenEnv`/
// `tokenEnv`. We restrict to names that match the conventional integration
// secret naming pattern and that are NOT on the LLM-provider blocklist.
// This is a defence-in-depth check; the long-term fix is per-catalog zod
// schemas listing allowed env-var names explicitly.
const PERMITTED_INTEGRATION_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/;
const FORBIDDEN_INTEGRATION_ENV_NAMES = new Set<string>([
  // LLM provider keys — never resolvable as an integration secret because
  // an attacker-controlled connection config could otherwise exfiltrate
  // them in the Authorization header to the attacker's bridge URL.
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "COHERE_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "GROK_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
  "REPLICATE_API_TOKEN",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "PERPLEXITY_API_KEY",
  "VOYAGE_API_KEY",
  "FIRECRAWL_API_KEY",
  // Gateway/infra secrets — broadly scoped, never an integration credential.
  "GOATCITADEL_AUTH_TOKEN",
  "GOATCITADEL_POSTGRES_PASSWORD",
  "POSTGRES_PASSWORD",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);

function isPermittedIntegrationSecretEnvVarName(envName: string): boolean {
  const normalized = envName.trim();
  if (!normalized || normalized.length > 128) {
    return false;
  }
  if (!PERMITTED_INTEGRATION_ENV_NAME_PATTERN.test(normalized)) {
    return false;
  }
  if (FORBIDDEN_INTEGRATION_ENV_NAMES.has(normalized.toUpperCase())) {
    return false;
  }
  return true;
}

// Test-only export for integration-secret-envvar-allowlist.security.test.ts.
export const __isPermittedIntegrationSecretEnvVarNameForTests = isPermittedIntegrationSecretEnvVarName;

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
  public config: GatewayRuntimeConfig;
  public readonly storage: Storage;
  private readonly eventIngestService: EventIngestService;
  public readonly policyEngine: ToolPolicyEngine;
  public readonly secretStore: SecretStoreService;
  private readonly skillsService: SkillsService;
  private readonly capabilityScopeResolver: CapabilityScopeResolver;
  public readonly orchestrationEngine: OrchestrationEngine;
  private readonly orchestrationWorktreeService: OrchestrationWorktreeService;
  private readonly orchestrationPhaseExecutionService: OrchestrationPhaseExecutionService;
  public readonly llmService: LlmService;
  private readonly assemblyService: AssemblyService;
  private readonly memoryContextService: MemoryContextService;
  public readonly meshService: MeshService;
  public readonly npuSidecar: NpuSidecarService;
  public readonly llamaCppRuntime: LlamaCppRuntimeService;
  private readonly approvalExplainer: ApprovalExplainerService;
  private readonly commitmentClassifier: CommitmentClassifierService;
  private readonly backgroundReviewService: BackgroundReviewService;
  public readonly turnRuntime: TurnRuntime;
  /**
   * R3-8 `agent.fanout` session registry. The entry/stream turn services
   * register a turn-scoped executor here; the policy engine's `subagentFanout`
   * runtime hook resolves invokes through it after authorization. The kill
   * switch is read live so a dashboard flag flip needs no gateway restart.
   */
  public readonly subagentFanout = new SubagentFanoutRuntime({
    isDisabled: () => this.isFeatureEnabled("subagentFanoutV1Disabled"),
  });
  private readonly researchService: ResearchService;
  private readonly obsidianVaultService: ObsidianVaultService;
  private readonly skillImportService: SkillImportService;
  private readonly skillMutationService: SkillMutationService;
  public readonly personalityCatalogService: PersonalityCatalogService;
  public readonly cronAutomationService: CronAutomationService;
  private readonly addonsService: AddonsService;
  private readonly addonSlotService: AddonSlotService;
  private readonly devDiagnostics: GatewayDevDiagnosticsService;
  public readonly discordRuntimeService: DiscordRuntimeService;
  private readonly chatProjectService: ChatProjectService;
  public readonly durableRunService: DurableRunService;
  private readonly durableOperatorService: DurableOperatorService;
  private readonly durableWorkflowRegistry: durableExecutionService.DurableWorkflowExecutorRegistry;
  public readonly hooksService: HooksService;
  public readonly approvalWaitRunService: ApprovalWaitRunService;
  public readonly approvalEffectsService: ApprovalEffectsService;
  private readonly approvalRuntime: ApprovalRuntimeService;
  private readonly chatTurnRuntime: ChatTurnRuntimeService;
  private readonly chatDelegationService: ChatDelegationService;
  public readonly steerService: ChatSteerService;
  private readonly toolInvocationCoordinator: ToolInvocationCoordinatorService;
  private readonly runtimeLifecycleReadService: RuntimeLifecycleReadService;
  private readonly chatLearnedMemoryService: ChatLearnedMemoryService;
  private readonly promptPackService: PromptPackService;
  public readonly chatProactiveService: ChatProactiveService;
  private readonly improvementService: ImprovementService;
  private readonly curatorService: CuratorService;
  private readonly memoryMaintenanceService: MemoryMaintenanceService;
  public readonly memoryLifecycleService: MemoryLifecycleService;
  private readonly evidenceEnvelopeService: EvidenceEnvelopeService;
  private readonly runtimeDecisionRecorder: RuntimeDecisionRecorder;
  private readonly continuationGateService: ContinuationGateService;
  private readonly capabilityPackService: CapabilityPackService;
  private readonly memoryWriteGateService: MemoryWriteGateService;
  private readonly operatorProfileService: OperatorProfileService;
  private readonly autonomyControlService: AutonomyControlService;
  private readonly capabilitySystemService: CapabilitySystemService;
  private readonly taskLifecycleService: TaskLifecycleService;
  private readonly mcpOAuthTokenService: McpOAuthTokenService;
  public readonly mcpOAuth: GatewayMcpOAuthService;
  /**
   * Single shared store for MCP server-initiated elicitations. Used by both the
   * HTTP elicitation route and the approval-inbox respond/list tools so an operator
   * can answer an elicitation through either surface against the same state.
   */
  public readonly mcpElicitationService = new McpElicitationService();
  public readonly browserSessionRuntimeService: BrowserSessionRuntimeService;
  public readonly reviewReadinessService: ReviewReadinessService;
  private readonly guidanceService: GuidanceService;
  private readonly channelDeliveryRuntimeService: ChannelDeliveryRuntimeService;
  private readonly backupRetentionService: BackupRetentionService;
  private readonly databaseCutoverService: DatabaseCutoverService;
  private readonly mediaVoiceService: MediaVoiceService;
  private readonly realtimeEventService: RealtimeEventService;
  private readonly routeCompositionPort?: GatewayRouteCompositionPort;
  public readonly routeServices: GatewayRouteServices;
  public readonly mutationIdempotencyStore: Storage["mutationIdempotency"];
  public readonly chatTurnExecutionRegistry = new ChatTurnExecutionRegistry();
  public readonly backgroundTasks = new Set<Promise<void>>();
  private readonly warnedOutsideRootPathFingerprints = new Set<string>();
  private readonly chatMessageProjectionBackfillAttempted = new Set<string>();
  private readonly syntheticPermissionProfiles = new Map<string, PermissionProfileRecord>();
  public readonly recentChannelSetupTests = new Map<string, ChannelSetupRecentTestCacheEntry>();
  public readonly deviceTokenVault = new DeviceTokenVault();
  private lastChatStreamPurgeAt = 0;
  public readonly operatorSummaryCache = new OperatorSummaryCache(15_000);
  public readonly onboardingMarkerPath: string;
  private maintenanceScheduler?: BackgroundIntervalHandle;
  private orchestrationWorktreeReapScheduler?: BackgroundIntervalHandle;
  private closing = false;
  public onboardingMarker: { completedAt?: string; completedBy?: string } = {};
  private criticalInitComplete = false;
  private deferredInitPromise?: Promise<void>;

  public get gatewaySql() {
    return this.storage.gatewaySql;
  }

  constructor(inputConfig: GatewayRuntimeConfig) {
    this.config = applyDurableExecutionBaselineToConfig(inputConfig);
    const config = this.config;
    this.storage = createGatewayStorage(config);
    this.mutationIdempotencyStore = this.storage.mutationIdempotency;
    this.channelDeliveryRuntimeService = new ChannelDeliveryRuntimeService({
      repository: this.storage.commsDeliveries,
      send: (input) => this.sendQueuedChannelDelivery(input),
      onDeliverySent: (record) => this.markLinkedCommitmentDeliverySent(record),
      onDeliveryFailed: (record) => this.markLinkedCommitmentDeliveryFailed(record),
    });
    this.personalityCatalogService = new PersonalityCatalogService(this.storage.systemSettings);
    this.realtimeEventService = new RealtimeEventService({
      storage: this.storage,
      getGatewayNodeId: () => this.config.assistant.mesh.nodeId,
    });
    this.evidenceEnvelopeService = new EvidenceEnvelopeService({
      storage: this.storage,
      publishRealtime: (eventType, source, payload) => {
        this.publishRealtime(eventType, source, payload);
      },
    });
    this.continuationGateService = new ContinuationGateService({
      storage: this.storage,
      publishRealtime: (eventType, source, payload) => {
        this.publishRealtime(eventType, source, payload);
      },
    });
    this.capabilityPackService = new CapabilityPackService({
      evidenceEnvelopeService: this.evidenceEnvelopeService,
      publishRealtime: (eventType, source, payload) => {
        this.publishRealtime(eventType, source, payload);
      },
    });
    this.memoryWriteGateService = new MemoryWriteGateService();
    // P2-S4b cross-session operator profile. Reuses the shared write gate (secrets
    // always blocked) and the master autonomy switch for auto-apply.
    this.operatorProfileService = new OperatorProfileService({
      storage: this.storage,
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag as keyof RuntimeSettings["features"]),
      memoryWriteGate: this.memoryWriteGateService,
    });
    this.enforceDurableExecutionBaseline();
    this.onboardingMarkerPath = path.resolve(config.rootDir, config.assistant.dataDir, "onboarding-state.json");
    this.devDiagnostics = new GatewayDevDiagnosticsService(
      resolveDevDiagnosticsEnabled(),
      undefined,
      resolveDevDiagnosticsVerbose(),
      resolveDevDiagnosticsBufferSize(process.env.GOATCITADEL_DEV_DIAGNOSTICS_GATEWAY_BUFFER),
    );
    this.runtimeDecisionRecorder = new RuntimeDecisionRecorder({
      runtimeDecisionTraces: this.storage.runtimeDecisionTraces,
      recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
    });

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
    this.browserSessionRuntimeService = new BrowserSessionRuntimeService({
      gatewaySql: this.gatewaySql,
      publishRealtime: (eventType, source, payload) => {
        this.publishRealtime(eventType, source, payload);
      },
      describeState: describeBrowserSessionState,
    });
    this.policyEngine = new ToolPolicyEngine(config.toolPolicy, this.storage, undefined, {
      assertBrowserSessionAccess: (check) => this.browserSessionRuntimeService.assertAccess(check),
      // Model-callable `schedule.manage` (P1-F2). The cron mutation is impure, so
      // the pure policy-engine executor delegates it back here. The approval gate
      // and deny-wins still fire first in `engine.invoke`; this hook only runs
      // after the engine has authorized execution.
      scheduleManage: (args, policyContext) => this.scheduleManage(args, policyContext),
      // Model-callable `agent.fanout` (R3-8). Child-turn spawning is impure and
      // needs the active turn's prepared context, so the executor delegates the
      // authorized invoke back to the session registry the entry/stream turn
      // services populate. Same contract as scheduleManage: policy/approval/
      // audit fire first in `engine.invoke`.
      subagentFanout: (request) => this.subagentFanout.execute(request),
    });
    const secretStore = new SecretStoreService();
    this.secretStore = secretStore;
    this.mcpOAuthTokenService = new McpOAuthTokenService({
      secretStore,
      networkAllowlist: config.toolPolicy.sandbox.networkAllowlist,
    });
    this.mcpOAuth = new GatewayMcpOAuthService({
      tokenService: this.mcpOAuthTokenService,
      readAuthState: () => this.readMcpAuthState(),
      writeAuthState: (state) => this.writeMcpAuthState(state),
    });
    this.skillsService = new SkillsService([
      { source: "extra", dir: path.join(config.rootDir, "skills", "extra") },
      { source: "extra", dir: path.join(config.rootDir, "skills", "genie-npu-ir20") },
      { source: "bundled", dir: path.join(config.rootDir, "skills", "bundled") },
      { source: "managed", dir: path.join(config.rootDir, ".assistant", "skills") },
      { source: "workspace", dir: path.join(config.rootDir, "skills", "workspace") },
    ]);
    this.capabilityScopeResolver = new CapabilityScopeResolver({
      listAssignmentsForScope: (scopeKind, scopeId) => this.storage.capabilityScope.listForScope(scopeKind, scopeId),
      listAllSkillIds: () => this.skillsService.list().map((skill) => skill.skillId),
      listAllIntegrationIds: () => this.storage.integrationConnections.list(undefined, 1000).map((c) => c.connectionId),
      listAllMcpServerIds: () => this.listMcpServers().map((server) => server.serverId),
    });
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
        runtimeExposure: this.buildRuntimeExposureSnapshot(),
      }),
      resolvePolicyContext: (input) => this.resolveToolPolicyContext(input),
    });
    this.taskLifecycleService = new TaskLifecycleService({
      storage: this.storage,
      publishRealtime: (event, source, payload, options) => this.publishRealtime(event, source, payload, options),
      pauseDurableRun: (runId, actorId) => this.pauseDurableRun(runId, actorId),
      cancelDurableRun: (runId, actorId) => this.cancelDurableRun(runId, actorId),
      recordAgenticDiagnosticSignal: (input) => this.improvementService.recordAgenticDiagnosticSignal(input),
      probers: createDefaultArtifactProbers({
        networkAllowlist: config.toolPolicy.sandbox.networkAllowlist,
      }),
    });
    this.reviewReadinessService = new ReviewReadinessService({
      rootDir: config.rootDir,
      taskLifecycleService: this.taskLifecycleService,
    });
    this.orchestrationEngine = new OrchestrationEngine();
    this.orchestrationWorktreeService = new OrchestrationWorktreeService({
      config,
      orchestrationRuns: this.storage.orchestration,
    });
    this.llmService = new LlmService(config.llm, process.env, {
      networkAllowlist: config.toolPolicy.sandbox.networkAllowlist,
      enforceNetworkAllowlist: true,
      tlsPathPolicy: {
        writeJailRoots: config.toolPolicy.sandbox.writeJailRoots,
        readOnlyRoots: config.toolPolicy.sandbox.readOnlyRoots,
      },
      modelMetadataPath: path.join(config.rootDir, "config", "llm-model-metadata.json"),
      modelCatalogCachePath: path.resolve(config.rootDir, config.assistant.dataDir, "cache", "llm-model-catalog.json"),
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
    this.commitmentClassifier = new CommitmentClassifierService({
      storage: this.storage,
      createChatCompletion: (request) => this.createChatCompletion(request),
      resolveModelDefaults: () => this.getPromptJudgeModelDefaults(),
      resolveApiStyle: (providerId, model) => this.llmService.resolveExecutionApiStyle(providerId, model),
    });
    this.turnRuntime = new GatewayTurnRuntime({
      storage: this.storage,
      listToolCatalog: () => this.listToolCatalog(),
      createChatCompletion: (request) => this.createChatCompletion(request),
      createChatCompletionStream: (request) => this.createChatCompletionStream(request),
      generateImage: (request) => this.llmService.generateImage(request),
      invokeTool: (request) => this.invokeTool(request),
      persistToolArtifact: (input) => chatToolArtifactService.persistChatToolArtifact(this, input),
      evaluateToolAccess: (request) => this.evaluateToolAccess(request),
      invokeMcpTool: (request) => this.invokeMcpTool(request),
      listMcpBrowserFallbackTargets: () => this.listMcpBrowserFallbackTargets(),
      toolLoopDetection: this.config.toolPolicy.tools.loopDetection,
      safeWriteFallbackDir: path.resolve(config.rootDir, config.assistant.workspaceDir, "goatcitadel_out"),
      chatThinkingStreamV1Enabled: () => this.isFeatureEnabled("chatThinkingStreamV1Enabled"),
      parallelToolExecutionV1Disabled: () => this.isFeatureEnabled("parallelToolExecutionV1Disabled"),
      subagentFanoutV1Disabled: () => this.isFeatureEnabled("subagentFanoutV1Disabled"),
    });
    this.researchService = new ResearchService({
      storage: this.storage,
      invokeTool: (request) => this.invokeTool(request),
      createChatCompletion: (request) => this.createChatCompletion(request),
      resolveToolPolicyContext: (input) => this.resolveToolPolicyContext(input),
    });
    this.obsidianVaultService = new ObsidianVaultService(this.storage.systemSettings);
    this.skillImportService = new SkillImportService(config.rootDir, this.storage.systemSettings);
    this.skillMutationService = new SkillMutationService({
      rootDir: config.rootDir,
      skillLifecycle: this.storage.skillLifecycle,
    });
    // P2-S1 self-improvement learning loop. Structured-extraction post-turn
    // service: two cheap read-only model calls (memory + skill) → persist via the
    // governed operator-profile + skill-mutation services. Auto-apply/secret/
    // candidate governance lives entirely in those services. Never promotes a
    // skill to callable (governed activation owns promotion).
    this.backgroundReviewService = new BackgroundReviewService({
      createChatCompletion: (request) => this.createChatCompletion(request),
      resolveModelDefaults: () => this.getPromptJudgeModelDefaults(),
      resolveApiStyle: (providerId, model) => this.llmService.resolveExecutionApiStyle(providerId, model),
      recordOperatorProfileFacts: (workspaceId, facts) => {
        const result = this.operatorProfileService.recordOperatorProfileFacts(workspaceId, { facts });
        // Unified audit: only an applied write (full autonomy) yields a
        // priorSnapshot — that snapshot is value-carrying (storage keeps only the
        // current revision) so it doubles as the restoreRef. Proposed/blocked
        // writes persist nothing, so there is nothing to audit. Best-effort.
        if (result.outcome === "applied" && result.priorSnapshot) {
          this.autonomyControlService.recordAutonomousMutation({
            kind: "memory",
            targetKey: result.record.operatorProfileId,
            restoreRef: { kind: "memory", priorSnapshot: result.priorSnapshot },
          });
        }
        return result;
      },
      draftSkillMutation: (input) => this.skillMutationService.draftSkillMutation(input),
    });
    this.addonSlotService = new AddonSlotService();
    this.addonsService = new AddonsService(config.rootDir, { slotService: this.addonSlotService });
    this.discordRuntimeService = new DiscordRuntimeService({
      listConnections: () => this.storage.integrationConnections.list(undefined, 1000),
      findApprovedPairing: (connectionId, userId) => this.findApprovedDiscordPairing(connectionId, userId),
      ensurePendingPairing: (connectionId, userId, displayName) =>
        this.ensurePendingDiscordPairing(connectionId, userId, displayName),
      touchPairing: (pairingId) => this.touchDiscordPairing(pairingId),
      onInboundMessage: (input) => discordRuntimeBridgeService.handleDiscordRuntimeInbound(this, input),
      onSlashCommand: (input) => discordRuntimeBridgeService.handleDiscordRuntimeSlashCommand(this, input),
      listModelSuggestions: (query, limit) =>
        listChatModelSuggestions(
          {
            getRuntime: () => this.getSettings().llm,
            listLlmModels: (providerId) => this.listLlmModels(providerId),
          },
          query,
          limit,
        ),
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
        task: async (job, _context?) => {
          const task = this.createCronInboxTask(job);
          return { taskId: task.taskId };
        },
        agentTurn: (input) => this.runCronAgentTurn(input),
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
        curator: async () => {
          await this.curatorService.runCurator({ sync: false, dryRun: true, triggerMode: "scheduled" });
        },
        watchdog: async (job) => this.runCronWatchdog(job),
        noAgent: (input) => runNoAgentCommand(input),
      },
    });

    // ── extracted sub-services and narrowed runtime contexts ─────
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const publishRealtime = this.publishRealtime.bind(this);
    const serviceCtx = {
      storage: this.storage,
      config: this.config,
      logger: durableRunLogger,
      llmService: this.llmService,
      policyEngine: this.policyEngine,
      gatewaySql: this.storage.gatewaySql,
      publishRealtime,
      requireFeatureEnabled: (flag: keyof RuntimeSettings["features"]) => this.requireFeatureEnabled(flag),
      isFeatureEnabled: (flag: keyof RuntimeSettings["features"]) => this.isFeatureEnabled(flag),
      normalizeWorkspaceId: (workspaceId?: string) => this.normalizeWorkspaceId(workspaceId),
    };
    this.guidanceService = new GuidanceService(serviceCtx);
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
      evaluateContinuationGate: (run) => this.evaluateDurableContinuationGate(run),
      recordEvidenceEnvelope: (input) => this.evidenceEnvelopeService.createEnvelope(input),
      taskLifecycle: createDurableTaskAutoBlockBridge(this.taskLifecycleService),
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
      agentSendChatMessage: (sessionId, input) => this.chatTurnRuntime.agentSendChatMessage(sessionId, input),
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
      resolveToolPolicyContext: (input) => this.resolveToolPolicyContext(input),
      detectDelegationRoles: (text) => detectDelegationRoles(text),
      createDurableRun: (input) => this.createDurableRun(input),
      requestDurableRunProcessing: (runId) => this.durableRunService.requestRunProcessing(runId),
      // P1-F5 de-novo origination: cheap read-only planner + eligibility guard.
      createChatCompletion: (request) => this.createChatCompletion(request),
      resolveModelDefaults: () => this.getPromptJudgeModelDefaults(),
      resolveApiStyle: (providerId, model) => this.llmService.resolveExecutionApiStyle(providerId, model),
      isProactiveDeNovoEligibleSession: (sessionId) => this.isHeartbeatEligibleSession(sessionId),
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
      executeApprovedPendingAction: (approvalId, signal) => this.executeApprovedPendingAction(approvalId, signal),
      enqueueAfterHooks: (input) => this.hooksService.enqueueAfterHooks(input),
      resolveApprovalHookWorkspaceId: (payload) => this.resolveApprovalHookWorkspaceId(payload),
    });
    this.approvalRuntime = new ApprovalRuntimeService({
      storage: this.storage,
      policyEngine: this.policyEngine,
      hooksService: this.hooksService,
      approvalWaitRunService: this.approvalWaitRunService,
      shellExplainerPolicy: {
        ...this.config.assistant.shellExplainerPolicy,
        autoRejectOnDanger:
          this.config.assistant.approvalExplainer.autoRejectOnDanger ??
          this.config.assistant.shellExplainerPolicy.autoRejectOnDanger,
        autoRejectDangerThreshold:
          this.config.assistant.approvalExplainer.autoRejectDangerThreshold ??
          this.config.assistant.shellExplainerPolicy.autoRejectDangerThreshold,
      },
      publishRealtime: (eventType, source, payload, options) =>
        this.publishRealtime(eventType, source, payload, options),
      requireConnectorRecord: (connectorId) => this.requireConnectorRecord(connectorId),
      consumeRemoteActionToken: (token, actionType) => this.consumeRemoteActionToken(token, actionType),
      consumeRemoteActionTokenById: (tokenId, actionType) => this.consumeRemoteActionTokenById(tokenId, actionType),
      resolveApproval: (approvalId, input) => this.approvalRuntime.resolveApproval(approvalId, input),
      resolveDeviceAccessApproval: (current, input) =>
        settingsAuthService.resolveDeviceAccessApproval(
          createSettingsAuthRuntimeDependenciesForGateway(this.getRouteCompositionPort()),
          current,
          input,
        ),
      executeCodeModePendingApproval: (approvalId, signal) => this.executeCodeModePendingApproval(approvalId, signal),
      resolveApprovalHookWorkspaceId: (payload) => this.resolveApprovalHookWorkspaceId(payload),
      scheduleApprovalExplanation: (approval) => this.scheduleApprovalExplanation(approval),
      findProactiveDurableRunIdsForApproval: (approvalId) => this.findProactiveDurableRunIdsForApproval(approvalId),
      wakeDurableRun: (runId, event) => this.wakeDurableRun(runId, event),
      recordApprovalResolution: (approval, input) =>
        settingsAuthService.recordApprovalResolution(
          createSettingsAuthRuntimeDependenciesForGateway(this.getRouteCompositionPort()),
          approval,
          input,
        ),
      enqueueApprovalResolutionEffects: (approval, input) => this.enqueueApprovalResolutionEffects(approval, input),
      enqueueApprovalRemoteTokenDelivery: (approval, connector, tokenRecord) =>
        this.enqueueApprovalRemoteTokenDelivery(approval, connector, tokenRecord),
    });
    this.steerService = new ChatSteerService();
    this.chatTurnRuntime = new ChatTurnRuntimeService(this.buildChatTurnRuntimeHost());
    this.orchestrationPhaseExecutionService = new OrchestrationPhaseExecutionService({
      rootDir: this.config.rootDir,
      createChatSession: (input) => this.createChatSession(input),
      updateChatSessionPrefs: (sessionId, input) => this.updateChatSessionPrefs(sessionId, input),
      agentSendChatMessage: (sessionId, input, options) =>
        this.chatTurnRuntime.agentSendChatMessage(sessionId, input, options),
      normalizeWorkspaceId: (workspaceId) => this.normalizeWorkspaceId(workspaceId),
    });
    const subagentDefaults = AgentSubagentDefaultsSchema.parse(
      (config as { agents?: { defaults?: { subagents?: unknown } } }).agents?.defaults?.subagents ?? {},
    );
    this.chatDelegationService = new ChatDelegationService({
      storage: this.storage,
      gatewaySql: this.gatewaySql,
      taskLifecycleService: this.taskLifecycleService,
      getSession: (sessionId) => this.getSession(sessionId),
      listChatMessages: (sessionId, limit) => this.listChatMessages(sessionId, limit),
      normalizeWorkspaceId: (workspaceId) => this.normalizeWorkspaceId(workspaceId),
      ensureChatSessionModelDefaults: (sessionId, prefs) => this.ensureChatSessionModelDefaults(sessionId, prefs),
      createChatSession: (input) => this.createChatSession(input),
      inheritDelegatedSessionToolGrants: (parentSessionId, childSessionId) =>
        this.inheritDelegatedSessionToolGrants(parentSessionId, childSessionId),
      updateChatSessionPrefs: (sessionId, input) => this.updateChatSessionPrefs(sessionId, input),
      resolveToolPolicyContext: (input) => this.resolveToolPolicyContext(input),
      agentSendChatMessage: (sessionId, input, options) =>
        this.chatTurnRuntime.agentSendChatMessage(sessionId, input, options),
      extractAndPersistLearnedMemory: (sessionId, content, source) =>
        this.extractAndPersistLearnedMemory(sessionId, content, source),
      scheduleChatMemoryContextPrewarm: (input) => this.scheduleChatMemoryContextPrewarm(input),
      subagentDefaults: {
        childTimeoutSeconds: subagentDefaults.childTimeoutSeconds,
        coworkChildTimeoutSeconds: subagentDefaults.coworkChildTimeoutSeconds,
        maxDepth: subagentDefaults.maxDepth,
      },
    });
    this.toolInvocationCoordinator = new ToolInvocationCoordinatorService({
      approvalInbox: this.storage.approvalInbox,
      assertMcpServerInScope: (request) => this.assertMcpServerInCapabilityScope(request),
      durableTasks: {
        listRuns: (limit) => this.storage.durableRuns.listRuns(limit),
        getRun: (runId) => {
          try {
            return this.storage.durableRuns.getRun(runId);
          } catch {
            return undefined;
          }
        },
        cancelRun: (runId) => this.durableOperatorService.cancelRun(runId),
      },
      respondToMcpElicitation: (input) =>
        this.mcpElicitationService.respondToRequest(input.elicitationId, {
          action: input.action,
          content: input.content,
          owner: input.owner,
        }),
      listMcpElicitations: (filter) => this.mcpElicitationService.listRequests(filter),
      policyEngine: this.policyEngine,
      hooksService: this.hooksService,
      normalizeToolInvokeRequest: (request) => {
        const resolvedWorkspaceId =
          request.workspaceId ??
          this.storage.chatSessionMeta.get(request.sessionId)?.workspaceId ??
          DEFAULT_WORKSPACE_ID;
        return this.enrichToolPolicyContext(
          this.applyRuntimeBrowserBackendDefaults(
            this.resolveToolInvokeRequestPaths({
              ...request,
              workspaceId: resolvedWorkspaceId,
              // Resolve the parent Citadel from the workspace so Citadel Wards always
              // enforce on the correct scope (Wards key on the real citadelId, never
              // the workspaceId). Default to the personal Citadel — which has no Wards —
              // when the workspace cannot be resolved, so the common case is unaffected.
              citadelId:
                request.citadelId ??
                this.storage.workspaces?.find(resolvedWorkspaceId)?.citadelId ??
                DEFAULT_CITADEL_ID,
            }),
          ),
        );
      },
      isValidToolName: (name) => isValidToolName(name),
      evaluateToolDeploymentGuard: (request) =>
        evaluateDeploymentProfileToolAccess(this.config.assistant.deploymentProfile, request.toolName, request.args),
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag),
      resolveToolHookWorkspaceId: (request) => this.resolveToolHookWorkspaceId(request),
      primeToolApprovalLifecycle: (approvalId, request) =>
        this.primeApprovalLifecycle(
          approvalId,
          this.buildApprovalLinkage({
            sessionId: request.sessionId,
            taskId: request.taskId,
            workspaceId: request.workspaceId,
            runId: request.runId,
            toolName: request.toolName,
            actionType: "tool.invoke",
            permissionProfileId: request.policyContext?.permissionProfileId ?? request.permissionProfileId,
            localOperatorOverrideId: request.policyContext?.localOperatorOverrideId ?? request.localOperatorOverrideId,
          }),
        ),
      scheduleApprovalExplanationById: (approvalId) => this.scheduleApprovalExplanationById(approvalId),
      recordApprovedExternalRuntimeToolResult: (input) =>
        this.recordApprovedExternalRuntimeToolResult(input.approvalId, input.request, input.result),
      publishRealtime: (eventType, source, payload, options) =>
        this.publishRealtime(eventType, source, payload, options),
      requireMcpServer: (serverId) => this.requireMcpServer(serverId),
      listMcpTools: (serverId) => this.listMcpTools(serverId),
      matchesWildcard: (value, pattern) => wildcardMatch(value, pattern),
      isMcpToolApproved: (serverId, toolName) => this.isMcpToolApproved(serverId, toolName),
      invokeMcpRuntimeTool: (server, input) =>
        invokeMcpRuntimeTool(server, input, undefined, {
          networkAllowlist: this.config.toolPolicy.sandbox.networkAllowlist,
          oauthAccessTokenResolver: (mcpServer) => this.mcpOAuth.resolveAccessToken(mcpServer),
        }),
      evaluateAutonomousActivationGrant: (input) =>
        this.capabilitySystemService.evaluateAutonomousActivationGrant(input),
      recordAutonomousActivationGrantUse: (grantId, estimatedCostUsd) =>
        this.capabilitySystemService.recordAutonomousActivationGrantUse(grantId, estimatedCostUsd),
      resolveApprovalWithRemoteTokenId: (input) => this.resolveApprovalWithRemoteTokenId(input),
      applyMcpRedaction: (output, mode) => applyMcpRedaction(output, mode),
      recordEvidenceEnvelope: (input) => {
        try {
          this.evidenceEnvelopeService.createEnvelope(input);
        } catch (error) {
          this.recordDevDiagnostic({
            level: "warn",
            category: "evidence",
            event: "evidence.envelope.failed",
            message: "Failed to record runtime evidence envelope",
            context: {
              eventKind: input.eventKind,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      },
      recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
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
      listChatDelegationRuns: (sessionId, limit) => {
        this.storage.chatDelegationRuns.reconcileSupersededRunningRunsForSession(sessionId);
        return this.storage.chatDelegationRuns.listBySession(sessionId, limit);
      },
      listChatDelegationSteps: (runId) => this.storage.chatDelegationSteps.listByRun(runId),
      getSession: (sessionId) => this.getSession(sessionId),
      getSessionSummary: (sessionId) => this.getSessionSummary(sessionId),
      listChatSessionProactiveRuns: (sessionId, limit) =>
        this.chatProactiveService.listChatSessionProactiveRuns(sessionId, limit),
      listApprovalEffects: (approvalId) => this.approvalEffectsService.listByApproval(approvalId),
      listRuntimeDecisionTraces: (query) => this.storage.runtimeDecisionTraces.list(query),
    });
    this.improvementService = new ImprovementService(serviceCtx, {
      createApproval: (input) => this.createApproval(input),
      captureRepairPolicySnapshot: (targetKey) => this.captureRepairPolicySnapshot(targetKey),
      applyRepairPolicyCandidate: (targetKey, revisionRef) => this.applyRepairPolicyCandidate(targetKey, revisionRef),
      restoreRepairPolicySnapshot: (snapshotRef) => this.restoreRepairPolicySnapshot(snapshotRef),
      captureRoutingPolicySnapshot: (targetKey) => this.captureRoutingPolicySnapshot(targetKey),
      applyRoutingPolicyCandidate: (targetKey, revisionRef) => this.applyRoutingPolicyCandidate(targetKey, revisionRef),
      restoreRoutingPolicySnapshot: (snapshotRef) => this.restoreRoutingPolicySnapshot(snapshotRef),
      captureSkillRevisionSnapshot: (targetKey, revisionRef) =>
        this.captureSkillRevisionSnapshot(targetKey, revisionRef),
      applySkillRevisionCandidate: (targetKey, revisionRef) => this.applySkillRevisionCandidate(targetKey, revisionRef),
      restoreSkillRevisionSnapshot: (snapshotRef) => this.restoreSkillRevisionSnapshot(snapshotRef),
      createChatCompletion: (request) => this.createChatCompletion(request),
      getPromptRunnerModelDefaults: () => this.getPromptRunnerModelDefaults(),
      // P2-W3: report the runtime-effective tune values via the shared reader so
      // applied auto-tunes are audited against what the decision points will read.
      readEffectiveBlockerTemplateStrictness: () => readBlockerTemplateStrictness(this.storage.systemSettings),
      readEffectiveRetryRepairThreshold: () => readRetryRepairThreshold(this.storage.systemSettings),
      readEffectiveLiveIntentThreshold: () => readLiveIntentThreshold(this.storage.systemSettings),
      // Cross-cutting audit: record applied auto-tunes in the unified ledger. The
      // tune row holds its own rollback snapshot, so the restoreRef is just the
      // tuneId. The closure resolves `autonomyControlService` lazily (it is
      // constructed just after this service), so the deferred call is safe.
      onAutoTuneApplied: (tuneId, settingKey) =>
        this.autonomyControlService.recordAutonomousMutation({
          kind: "tune",
          targetKey: settingKey,
          restoreRef: { kind: "tune", tuneId },
        }),
      readTranscriptOrEmpty: (sessionId) => this.readTranscriptOrEmpty(sessionId),
      retryChatTurn: (sessionId, turnId, overrides) => this.retryChatTurnInScratchSession(sessionId, turnId, overrides),
      backgroundTasks: this.backgroundTasks,
      get closing() {
        return self.closing;
      },
    });
    this.curatorService = new CuratorService({
      listSkills: () => this.listSkills(),
      archiveSkill: (skillId, reason) => {
        this.setSkillState(skillId, "disabled", reason);
        const updated = this.listSkills().find((s) => s.skillId === skillId);
        if (!updated) throw new Error(`Skill ${skillId} not found after archiving`);
        return updated;
      },
      pruneSkill: (skillId) => {
        // v1: mark with prune note. Actual file removal is a follow-up task.
        this.setSkillState(skillId, "disabled", "curator:pruned");
        return { filesRemoved: [] };
      },
      now: () => new Date(),
      writeReport: (report) => writeCuratorReport(report, { logsRoot: this.config.rootDir }),
      publishRealtime: (topic, payload) => this.publishRealtime("system", topic, payload),
      cycleDays: 7,
      storage: this.storage,
      // S3 — idle janitor: gated on workspace idle + master autonomy. Archive is
      // reversible — we snapshot the prior skill-state row before the disable so
      // the global "revert autonomous changes" can re-apply it. Archive only ever
      // disables (never hard-deletes); prune/file-removal stays operator-gated.
      idleSweep: {
        isWorkspaceIdle: () => !this.chatTurnExecutionRegistry.hasAnyActiveChatTurnExecution(),
        isAutonomyEnabled: () => !this.isFeatureEnabled("autonomyV1Disabled"),
        snapshotSkill: (skillId) => this.captureCuratorIdleSkillSnapshot(skillId),
      },
    });
    // Cross-cutting kill-switch & rollback. Ties every subsystem's existing
    // snapshot/restore into one operator-facing "revert autonomous changes since
    // T". Restore callbacks delegate to each subsystem's own (already-landed)
    // restore path; the kill switch toggles `autonomyV1Disabled` via the
    // feature-flag update path. Constructed after improvement/curator/operator-
    // profile so all collaborators already exist.
    this.autonomyControlService = new AutonomyControlService({
      storage: this.storage,
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag as keyof RuntimeSettings["features"]),
      setKillSwitch: (disabled) => {
        this.updateFeatureFlags({ autonomyV1Disabled: disabled });
      },
      restoreHandlers: {
        restoreSkillRevision: (snapshotRef) => this.restoreSkillRevisionSnapshot(snapshotRef as ImprovementRef),
        restoreOperatorProfile: (priorSnapshot) =>
          this.operatorProfileService.restoreOperatorProfileSnapshot(priorSnapshot as OperatorProfileRecord),
        restoreCuratorArchive: (skillId) => this.restoreCuratorIdleSkillSnapshot(skillId),
        revertTune: (tuneId) => {
          this.improvementService.revertDecisionAutoTune(tuneId);
        },
      },
      recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
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
        memoryQualityIssues: this.storage.memoryQualityIssues,
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
      writeGate: this.memoryWriteGateService,
      evidence: this.evidenceEnvelopeService,
      resolveSessionWorkspaceId: (sessionId) => this.storage.chatSessionMeta.get(sessionId)?.workspaceId,
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
    this.durableOperatorService = new DurableOperatorService({
      durableRunService: this.durableRunService,
      memoryLifecycleService: this.memoryLifecycleService,
      hooksService: this.hooksService,
      resolveDurableRunHookWorkspaceId: (run) => this.resolveDurableRunHookWorkspaceId(run),
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
          isFeatureEnabled: (feature) => this.isFeatureEnabled(feature as keyof RuntimeSettings["features"]),
          listChatSessionProactiveRuns: (sessionId, limit) =>
            this.chatProactiveService.listChatSessionProactiveRuns(sessionId, limit),
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
          commsActivity: (input) => this.commsActivity(input),
          isFeatureEnabled: (feature) => this.isFeatureEnabled(feature as keyof RuntimeSettings["features"]),
          invokeMcpTool: (input) => this.invokeMcpTool(input),
          resolveDurableRunHookWorkspaceId: (run) => this.resolveDurableRunHookWorkspaceId(run),
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
        externalSideEffectReplay: {
          storage: this.storage,
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
        curatorTick: {
          curatorService: this.curatorService,
          publishRealtime: (eventType, source, payload) => this.publishRealtime(eventType, source, payload),
        },
      }),
    );
    this.routeCompositionPort = this.buildRouteCompositionPort();
    this.routeServices = this.buildRouteServices();
  }

  private buildRouteCompositionPort() {
    return createGatewayRouteCompositionPort(this, {
      addonsService: this.addonsService,
      addonSlotService: this.addonSlotService,
      approvalRuntime: this.approvalRuntime,
      assemblyService: this.assemblyService,
      backupRetentionService: this.backupRetentionService,
      capabilityPackService: this.capabilityPackService,
      capabilityScopeResolver: this.capabilityScopeResolver,
      capabilitySystemService: this.capabilitySystemService,
      chatMessageRouteRuntimeHost: this.buildChatMessageRouteRuntimeHost(),
      chatProjectService: this.chatProjectService,
      chatTurnRuntime: this.chatTurnRuntime,
      databaseCutoverService: this.databaseCutoverService,
      devDiagnostics: this.devDiagnostics,
      durableOperatorService: this.durableOperatorService,
      evidenceEnvelopeService: this.evidenceEnvelopeService,
      guidanceService: this.guidanceService,
      improvementService: this.improvementService,
      autonomyControlService: this.autonomyControlService,
      mediaVoiceService: this.mediaVoiceService,
      obsidianVaultService: this.obsidianVaultService,
      onboardingStateHost: this.buildOnboardingStateHost(),
      promptPackService: this.promptPackService,
      realtimeEventService: this.realtimeEventService,
      researchService: this.researchService,
      runtimeLifecycleReadService: this.runtimeLifecycleReadService,
      taskLifecycleService: this.taskLifecycleService,
      toolInvocationCoordinator: this.toolInvocationCoordinator,
    });
  }

  private buildChatMessageRouteRuntimeHost(): chatMessageRouteRuntime.ChatMessageRouteRuntimeHost {
    return {
      storage: this.storage,
      durableRunService: this.durableRunService,
      getSession: (sessionId) => this.getSession(sessionId),
      loadChatTurnSessionState: (sessionId, options) => this.loadChatTurnSessionState(sessionId, options),
      publishRealtime: (eventType, source, payload, options) =>
        this.publishRealtime(eventType, source, payload, options),
      recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
    };
  }

  private buildOnboardingStateHost(): onboardingStateService.OnboardingStateHost {
    const host = {
      config: this.config,
      llmService: this.llmService,
      onboardingMarkerPath: this.onboardingMarkerPath,
      getAuthRuntimeSettings: () => this.getAuthRuntimeSettings(),
      publishRealtime: (eventType, source, payload, options) =>
        this.publishRealtime(eventType, source, payload, options),
      updateSettings: (input) => this.updateSettings(input),
    } as Omit<onboardingStateService.OnboardingStateHost, "onboardingMarker">;
    Object.defineProperty(host, "onboardingMarker", {
      configurable: false,
      enumerable: true,
      get: () => this.onboardingMarker,
      set: (value: onboardingStateService.OnboardingStateHost["onboardingMarker"]) => {
        this.onboardingMarker = value;
      },
    });
    return host as onboardingStateService.OnboardingStateHost;
  }

  private buildChatTurnRuntimeHost(): ChatTurnRuntimeHost {
    const host = {
      storage: this.storage,
      turnRuntime: this.turnRuntime,
      backgroundTasks: this.backgroundTasks,
      hooksService: this.hooksService,
      llmService: this.llmService,
      agentSendChatMessage: (sessionId, input) => this.chatTurnRuntime.agentSendChatMessage(sessionId, input),
      agentSendChatMessageStream: (sessionId, input, options) =>
        this.chatTurnRuntime.agentSendChatMessageStream(sessionId, input, options),
      beginActiveChatTurnExecution: (sessionId, turnId, operation) =>
        this.beginActiveChatTurnExecution(sessionId, turnId, operation),
      beginDurableChatRun: (prepared, input, threadEventType) =>
        this.beginDurableChatRun(prepared, input, threadEventType),
      cancelDurableChatRun: (runId, actorId) => {
        this.cancelDurableRun(runId, actorId);
      },
      buildChatOrchestrationSummary: (input) => this.buildChatOrchestrationSummary(input),
      buildDefaultChatPersonalityOverlay: () => this.buildDefaultChatPersonalityOverlay(),
      buildLlmMessagesFromBranchPath: (sessionId, pathTurnIds, currentUserMessage, options, state) =>
        this.buildLlmMessagesFromBranchPath(sessionId, pathTurnIds, currentUserMessage, options, state),
      composeFrozenOperatorProfileDigest: (workspaceId) => this.composeFrozenOperatorProfileDigest(workspaceId),
      resolveBasePromptCapabilityCatalog: () => this.resolveBasePromptCapabilityCatalog(),
      closeActiveChatTurnStream: (turnId) => this.closeActiveChatTurnStream(turnId),
      collectCapabilityUpgradeSuggestions: (input) => this.collectCapabilityUpgradeSuggestions(input),
      collectSpecialistCandidateSuggestions: (input) => this.collectSpecialistCandidateSuggestions(input),
      commsSend: (input) => this.commsSend(input),
      completeActiveChatTurnStream: (turnId) => this.completeActiveChatTurnStream(turnId),
      createChatCompletion: (request) => this.createChatCompletion(request),
      createChatSession: (input) => this.createChatSession(input),
      createHydratedChatTurnTrace: (turnId, trace) => this.createHydratedChatTurnTrace(turnId, trace),
      endActiveChatTurnExecution: (turnId, controller) => this.endActiveChatTurnExecution(turnId, controller),
      ensureChatSessionModelDefaults: (sessionId, prefs) => this.ensureChatSessionModelDefaults(sessionId, prefs),
      ensureChatSessionRuntimeGrants: (sessionId) => this.ensureChatSessionRuntimeGrants(sessionId),
      ensureSessionInternalToolGrant: (sessionId, toolName, reason) =>
        this.ensureSessionInternalToolGrant(sessionId, toolName, reason),
      extractAndPersistLearnedMemory: (sessionId, content, source) =>
        this.extractAndPersistLearnedMemory(sessionId, content, source),
      finalizeDurableChatRun: (runId, prepared, trace) => this.finalizeDurableChatRun(runId, prepared, trace),
      getActiveChatTurnExecution: (turnId) => this.getActiveChatTurnExecution(turnId),
      getActiveChatTurnStream: (turnId) => this.getActiveChatTurnStream(turnId),
      getSession: (sessionId) => this.getSession(sessionId),
      getSessionAutonomyPrefs: (sessionId) => this.getSessionAutonomyPrefs(sessionId),
      inheritDelegatedSessionToolGrants: (sessionId, delegatedSessionId) =>
        this.inheritDelegatedSessionToolGrants(sessionId, delegatedSessionId),
      ingestEvent: (idempotencyKey, payload) => this.ingestEvent(idempotencyKey, payload),
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag as keyof RuntimeSettings["features"]),
      isReplayScratchSession: (sessionId) => this.isReplayScratchSession(sessionId),
      listLlmModels: (providerId) => this.listLlmModels(providerId),
      loadChatTurnSessionState: (sessionId) => this.loadChatTurnSessionState(sessionId),
      markChatTurnCancelled: (sessionId, turnId, cancelledBy) =>
        this.markChatTurnCancelled(sessionId, turnId, cancelledBy),
      maybeAutoTitleChatSession: (sessionId, content) => this.maybeAutoTitleChatSession(sessionId, content),
      normalizeWorkspaceId: (workspaceId) => this.normalizeWorkspaceId(workspaceId),
      patchSessionAutonomyPrefs: (sessionId, input) => this.patchSessionAutonomyPrefs(sessionId, input),
      persistChatStreamChunk: (chunk, durableRunId) => {
        if (!chunk.turnId) {
          throw new Error("Persistable chat stream chunk is missing a turn id.");
        }
        this.persistChatStreamChunk(chunk as PersistableChatStreamChunk, durableRunId);
      },
      prepareAgentChatTurn: (sessionId, input, options) => this.prepareAgentChatTurn(sessionId, input, options),
      recordRuntimeDecision: (input) => this.recordRuntimeDecision(input),
      publishRealtime: (channel, topic, payload, options) => this.publishRealtime(channel, topic, payload, options),
      recordCapabilityGapFromTrace: (input) => this.recordCapabilityGapFromTrace(input),
      recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
      recordTurnCommitments: (input) => this.recordTurnCommitments(input),
      registerActiveChatTurnStream: (sessionId, turnId, durableRunId) =>
        this.registerActiveChatTurnStream(sessionId, turnId, durableRunId),
      requireChatTurnContext: (sessionId, turnId) => this.requireChatTurnContext(sessionId, turnId),
      requireExecutedToolResult: (toolName, result) => this.requireExecutedToolResult(toolName, result),
      resolveFallbackTargets: (runtime, primaryProviderId, primaryModel) =>
        this.resolveFallbackTargets(runtime, primaryProviderId, primaryModel),
      resolvePreparedTurnOrchestration: (prepared) => this.resolvePreparedTurnOrchestration(prepared),
      resolveToolPolicyContext: (input) => this.resolveToolPolicyContext(input),
      resolveRuntimeGuidance: (workspaceId) => this.resolveRuntimeGuidance(workspaceId),
      resolveThreadKnowledgeContext: (sessionId, query) => this.resolveThreadKnowledgeContext(sessionId, query),
      routeFromSession: (session) => this.routeFromSession(session),
      scheduleChatMemoryContextPrewarm: (input) => this.scheduleChatMemoryContextPrewarm(input),
      scheduleMemoryMaintenancePostTurnEvaluation: (sessionId, parentTurnId) =>
        this.scheduleMemoryMaintenancePostTurnEvaluation(sessionId, parentTurnId),
      scheduleBackgroundReviewIfDue: (input) => this.scheduleBackgroundReviewIfDue(input),
      steerService: this.steerService,
      subagentFanout: this.subagentFanout,
      streamPersistedChatTurnEvents: (sessionId, turnId, options) =>
        this.streamPersistedChatTurnEvents(sessionId, turnId, options),
      triggerChatSessionProactive: (sessionId, input) => this.triggerChatSessionProactive(sessionId, input),
      updateActiveLeafOrThrow: (sessionId, previousActiveTurnId, nextActiveTurnId) =>
        this.updateActiveLeafOrThrow(sessionId, previousActiveTurnId, nextActiveTurnId),
      updateChatSessionPrefs: (sessionId, input) => this.updateChatSessionPrefs(sessionId, input),
      withChatTurnWriteLease: (sessionId, operation, task) => this.withChatTurnWriteLease(sessionId, operation, task),
      withChatTurnWriteLeaseStream: (sessionId, operation, factory) =>
        this.withChatTurnWriteLeaseStream(sessionId, operation, factory),
      withEphemeralStreamEnvelope: (stream, runId) => this.withEphemeralStreamEnvelope(stream, runId),
      surfaceRouter: new SurfaceRouterService({
        traceRepo: this.storage.runtimeDecisionTraces,
        fetchExemplars: (citadelId: string) => this.improvementService.listSurfaceRouteOverrideExemplars(citadelId),
        judge:
          process.env.GOATCITADEL_SURFACE_ROUTER_JUDGE_ENABLED === "1"
            ? buildSurfaceRouterJudge({
                createChatCompletion: (request) => this.createChatCompletion(request),
                resolveModelDefaults: () => this.getPromptJudgeModelDefaults(),
              })
            : undefined,
      }),
      readChatSessionMode: (sessionId: string) => this.storage.chatSessionPrefs.get(sessionId)?.mode,
      persistChatSessionMode: (sessionId: string, mode: ChatMode) => {
        this.updateChatSessionPrefs(sessionId, buildChatModePrefsPatch(mode));
      },
      recordSurfaceRouteOverrideSignal: (input) => this.improvementService.recordSurfaceRouteOverrideSignal(input),
    } as Omit<ChatTurnRuntimeHost, "config">;
    Object.defineProperty(host, "config", {
      configurable: false,
      enumerable: true,
      get: () => this.config,
    });
    return createChatTurnRuntimeHost(host as ChatTurnRuntimeHost);
  }

  private getRouteCompositionPort(): GatewayRouteCompositionPort {
    return this.routeCompositionPort ?? this.buildRouteCompositionPort();
  }

  private buildRouteServices(): GatewayRouteServices {
    return composeGatewayRouteServices(this.getRouteCompositionPort());
  }

  private buildIntegrationDiagnosticsService() {
    return createIntegrationDiagnosticsServiceForGateway(this.getRouteCompositionPort());
  }

  private buildIntegrationChannelService(integrationDiagnostics = this.buildIntegrationDiagnosticsService()) {
    return createIntegrationChannelServiceForGateway(this.getRouteCompositionPort(), integrationDiagnostics);
  }

  private buildCommsHost(integrationChannel = this.buildIntegrationChannelService()): CommsHost {
    return createCommsHostForGateway(this.getRouteCompositionPort(), integrationChannel);
  }

  private buildDurableChatTurnWorkflowHost(): durableExecutionService.DurableChatTurnWorkflowHost {
    return {
      config: this.config,
      storage: this.storage,
      backgroundTasks: this.backgroundTasks,
      turnRuntime: this.turnRuntime,
      steerService: this.steerService,
      resolvePreparedTurnOrchestration: (prepared) => this.resolvePreparedTurnOrchestration(prepared),
      createChatCompletion: (request) => this.createChatCompletion(request),
      recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
      buildChatOrchestrationSummary: (input) => this.buildChatOrchestrationSummary(input),
      createChatSession: (input) => this.createChatSession(input),
      inheritDelegatedSessionToolGrants: (sessionId, delegatedSessionId) =>
        this.inheritDelegatedSessionToolGrants(sessionId, delegatedSessionId),
      updateChatSessionPrefs: (sessionId, input) => this.updateChatSessionPrefs(sessionId, input),
      agentSendChatMessage: (sessionId, input) => this.chatTurnRuntime.agentSendChatMessage(sessionId, input),
      agentSendChatMessageStream: (sessionId, input, options) =>
        this.chatTurnRuntime.agentSendChatMessageStream(sessionId, input, options),
      beginActiveChatTurnExecution: (sessionId, turnId, operation) =>
        this.beginActiveChatTurnExecution(sessionId, turnId, operation),
      endActiveChatTurnExecution: (turnId, controller) => this.endActiveChatTurnExecution(turnId, controller),
      getActiveChatTurnExecution: (turnId) => this.getActiveChatTurnExecution(turnId),
      ingestEvent: (idempotencyKey, payload) => this.ingestEvent(idempotencyKey, payload),
      updateActiveLeafOrThrow: (sessionId, previousActiveTurnId, nextActiveTurnId) =>
        this.updateActiveLeafOrThrow(sessionId, previousActiveTurnId, nextActiveTurnId),
      collectCapabilityUpgradeSuggestions: (input) => this.collectCapabilityUpgradeSuggestions(input),
      collectSpecialistCandidateSuggestions: (input) => this.collectSpecialistCandidateSuggestions(input),
      publishRealtime: (channel, topic, payload, options) => this.publishRealtime(channel, topic, payload, options),
      hooksService: this.hooksService,
      extractAndPersistLearnedMemory: (sessionId, content, source) =>
        this.extractAndPersistLearnedMemory(sessionId, content, source),
      recordTurnCommitments: (input) => this.recordTurnCommitments(input),
      scheduleChatMemoryContextPrewarm: (input) => this.scheduleChatMemoryContextPrewarm(input),
      scheduleMemoryMaintenancePostTurnEvaluation: (sessionId, parentTurnId) =>
        this.scheduleMemoryMaintenancePostTurnEvaluation(sessionId, parentTurnId),
      scheduleBackgroundReviewIfDue: (input) => this.scheduleBackgroundReviewIfDue(input),
      recordCapabilityGapFromTrace: (input) => this.recordCapabilityGapFromTrace(input),
      markChatTurnCancelled: (sessionId, turnId) => this.markChatTurnCancelled(sessionId, turnId),
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag as keyof RuntimeSettings["features"]),
      streamPersistedChatTurnEvents: (sessionId, turnId, options) =>
        this.streamPersistedChatTurnEvents(sessionId, turnId, options),
      withEphemeralStreamEnvelope: (stream, runId) => this.withEphemeralStreamEnvelope(stream, runId),
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
      getActiveChatTurnStream: (turnId) => this.getActiveChatTurnStream(turnId),
      beginDurableChatRun: (prepared, input, threadEventType) =>
        this.beginDurableChatRun(prepared, input, threadEventType),
      registerActiveChatTurnStream: (sessionId, turnId, durableRunId) =>
        this.registerActiveChatTurnStream(sessionId, turnId, durableRunId),
      ensureSessionInternalToolGrant: (sessionId, toolName, reason) =>
        this.ensureSessionInternalToolGrant(sessionId, toolName, reason),
      requireExecutedToolResult: (toolName, result) => this.requireExecutedToolResult(toolName, result),
      commsSend: (input) => this.commsSend(input),
      prepareAgentChatTurn: (sessionId, input, options) => this.prepareAgentChatTurn(sessionId, input, options),
      enqueueAutonomousChannelDelivery: (input) => this.enqueueAutonomousChannelDelivery(input),
      cleanupSilentHeartbeatTurn: (input) => this.cleanupSilentHeartbeatTurn(input),
    };
  }

  public recordDevDiagnostic(input: Parameters<GatewayDevDiagnosticsService["record"]>[0]): void {
    this.devDiagnostics.record(input);
  }

  public recordRuntimeDecision(input: RuntimeDecisionTraceAppendInput): void {
    (this.runtimeDecisionRecorder as RuntimeDecisionRecorder | undefined)?.record(input);
  }

  private buildApprovalDecisionScope(approval: ApprovalRequest): RuntimeDecisionTraceAppendInput["scope"] {
    const linkage = approval.linkage;
    return {
      ...(linkage?.workspaceId ? { workspaceId: linkage.workspaceId } : {}),
      ...(linkage?.sessionId ? { sessionId: linkage.sessionId } : {}),
      ...(linkage?.turnId ? { turnId: linkage.turnId } : {}),
      ...(linkage?.runId ? { runId: linkage.runId } : {}),
      ...(linkage?.durableRunId ? { durableRunId: linkage.durableRunId } : {}),
      ...(linkage?.taskId ? { taskId: linkage.taskId } : {}),
      approvalId: approval.approvalId,
    };
  }

  private buildApprovalDecisionEvidenceRefs(
    approval: ApprovalRequest,
  ): NonNullable<RuntimeDecisionTraceAppendInput["evidenceRefs"]> {
    const linkage = approval.linkage;
    return [
      { refType: "approval", refId: approval.approvalId, label: approval.kind },
      ...(linkage?.sessionId ? [{ refType: "session" as const, refId: linkage.sessionId }] : []),
      ...(linkage?.turnId ? [{ refType: "turn" as const, refId: linkage.turnId }] : []),
      ...(linkage?.runId ? [{ refType: "run" as const, refId: linkage.runId }] : []),
      ...(linkage?.durableRunId ? [{ refType: "durable_run" as const, refId: linkage.durableRunId }] : []),
      ...(linkage?.taskId ? [{ refType: "task" as const, refId: linkage.taskId }] : []),
    ];
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
    await traceInitStep("loadOnboardingMarker", () => this.loadOnboardingMarker());
    await traceInitStep("applyStoredFeatureFlags", () => {
      this.applyStoredFeatureFlags();
    });
    await traceInitStep("seedBuiltinAgentProfiles", () => {
      this.storage.agentProfiles.seedBuiltins(BUILTIN_AGENT_PROFILES);
    });
    const skills = await traceInitStep("skillsService.reload", () => this.skillsService.reload());
    await traceInitStep("ensureSkillStates", () => {
      this.ensureSkillStates(skills.map((skill) => skill.skillId));
    });
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
    this.backgroundTasks.add(task);
    void task
      .catch((error) => {
        log.debug("deferred startup failure observed by background task tracker", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.backgroundTasks.delete(task));
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
    const [flushedTranscriptCount, restartedChannelDeliveries] = await Promise.all([
      this.eventIngestService.flushPendingTranscriptOutbox(),
      this.drainDueChannelDeliveries(),
    ]);
    if (flushedTranscriptCount > 0) {
      log.info("flushed pending transcript outbox entries", {
        flushedTranscriptCount,
      });
    }
    if (restartedChannelDeliveries.length > 0) {
      log.info("drained due channel deliveries after restart", {
        deliveryCount: restartedChannelDeliveries.length,
      });
    }
    this.improvementService.markInterruptedDecisionReplayRuns();
    await Promise.all([this.discordRuntimeService.sync(), this.loadCronJobsFromConfig()]);
    this.improvementService.ensureWeeklyImprovementCronJob();
    this.curatorService.ensureCuratorWeeklyCronJob();
    this.ensurePrivateBetaBackupCronJob();
    this.ensureMemoryFlushCronJob();
    this.ensureCostReportCronJob();
    this.ensureUpdateReviewCronJob();
    this.meshService.init();
    await Promise.all([this.npuSidecar.init(), this.llamaCppRuntime.init()]);
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
      this.startOrchestrationWorktreeReapScheduler();
    }
    this.durableRunService.startWorker();
    if (!this.isFeatureEnabled("autonomyV1Disabled")) {
      // Recover autonomous runs that were parked while the kill switch was engaged
      // in a previous process lifetime and never woken before the restart.
      try {
        this.durableRunService?.resumeRunsWaitingForAutonomyKillSwitch();
      } catch (error) {
        log.warn("Failed to resume autonomy-kill-switch-parked durable runs on startup", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.approvalEffectsService.startWorker();
    this.promptPackService.resumeInterruptedBenchmarkRuns();
    // Pre-warm LLM model catalogs for configured providers in the background.
    void this.prewarmLlmModelCatalogs().catch((error) => {
      log.warn("Failed to pre-warm LLM model catalogs on startup", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    if (isVerboseLoggingEnabled()) {
      log.info("feature flags", { flags: this.readFeatureFlags() });
    } else {
      log.info("runtime ready");
    }
  }

  private async prewarmLlmModelCatalogs(): Promise<void> {
    const config = this.llmService.getRuntimeConfig({ useCache: true });
    const providersToWarm = config.providers.filter((p) => p.hasApiKey);
    if (providersToWarm.length === 0) {
      return;
    }
    log.info("pre-warming LLM model catalogs in background", {
      providerIds: providersToWarm.map((p) => p.providerId),
    });
    await Promise.allSettled(
      providersToWarm.map(async (p) => {
        try {
          await this.llmService.listModels(p.providerId);
          log.debug("pre-warmed LLM model catalog", { providerId: p.providerId });
        } catch (error) {
          log.debug("failed to pre-warm LLM model catalog", {
            providerId: p.providerId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
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

  public getSession(sessionId: string) {
    return this.storage.sessions.getBySessionId(sessionId);
  }

  public async listGlobalGuidance(): Promise<GuidanceDocumentRecord[]> {
    return this.guidanceService.listGlobalGuidance();
  }

  public async listWorkspaceGuidance(workspaceId: string) {
    return this.guidanceService.listWorkspaceGuidance(workspaceId);
  }

  public async updateGlobalGuidance(docType: GuidanceDocType, content: string): Promise<GuidanceDocumentRecord> {
    return this.guidanceService.updateGlobalGuidance(docType, content);
  }

  public async updateWorkspaceGuidance(
    workspaceId: string,
    docType: GuidanceDocType,
    content: string,
  ): Promise<GuidanceDocumentRecord> {
    return this.guidanceService.updateWorkspaceGuidance(workspaceId, docType, content);
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
        const content = chatMessageHistoryService.extractMessagePreview(event.payload);
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
      preview: chatMessageHistoryService.extractMessagePreview(event.payload),
      payload: event.payload,
      tokenInput: event.tokenInput,
      tokenOutput: event.tokenOutput,
      costUsd: event.costUsd,
    }));
  }

  public listChatSessions(query: ChatSessionListQuery = {}): ChatSessionRecord[] {
    return chatSessionService.listChatSessions(this.buildChatSessionDependencies(), query);
  }

  public searchChatSessions(query: ChatSessionSearchQuery): ChatSessionSearchResponse {
    return chatSessionService.searchChatSessions(this.buildChatSessionDependencies(), query);
  }

  public createChatSession(input: ChatSessionCreateInput = {}): ChatSessionRecord {
    return chatSessionService.createChatSession(this.buildChatSessionDependencies(), input);
  }

  public updateChatSession(
    sessionId: string,
    input: { title?: string; folderId?: string; folderName?: string; tags?: string[] },
  ): ChatSessionRecord {
    return chatSessionService.updateChatSession(this.buildChatSessionDependencies(), sessionId, input);
  }

  public maybeAutoTitleChatSession(sessionId: string, content: string): void {
    chatSessionService.maybeAutoTitleChatSession(this.buildChatSessionDependencies(), sessionId, content);
  }

  private archiveChatSession(sessionId: string): ChatSessionRecord {
    return chatSessionService.archiveChatSession(this.buildChatSessionDependencies(), sessionId);
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

  private buildChatSessionDependencies(): chatSessionService.ChatSessionDependencies {
    return {
      storage: this.storage,
      operatorSummaryCache: this.operatorSummaryCache,
      normalizeWorkspaceId: (workspaceId) => this.normalizeWorkspaceId(workspaceId),
      ensureChatSessionRuntimeGrants: (sessionId) => this.ensureChatSessionRuntimeGrants(sessionId),
      requireChatSession: (sessionId) => this.requireChatSession(sessionId),
      getSession: (sessionId) => this.getSession(sessionId),
      publishRealtime: (eventType, source, payload) => this.publishRealtime(eventType, source, payload),
      clearChatTurnWriteLease: (sessionId) => this.clearChatTurnWriteLease(sessionId),
      removeChatSessionStoredFile: (storageRelPath) => this.removeChatSessionStoredFile(storageRelPath),
      ensureChatSessionModelDefaults: (sessionId, prefs) => this.ensureChatSessionModelDefaults(sessionId, prefs),
      hydrateChatPrefsWithAutonomy: (sessionId, prefs) => this.hydrateChatPrefsWithAutonomy(sessionId, prefs),
      patchSessionAutonomyPrefs: (sessionId, patch) => this.patchSessionAutonomyPrefs(sessionId, patch),
    };
  }

  public assignChatSessionProject(sessionId: string, projectId?: string): ChatSessionRecord {
    return chatSessionService.assignChatSessionProject(this.buildChatSessionDependencies(), sessionId, projectId);
  }

  public setChatSessionBinding(input: {
    sessionId: string;
    transport: "llm" | "integration";
    connectionId?: string;
    target?: string;
    writable?: boolean;
  }): ChatSessionBindingRecord {
    return chatSessionService.setChatSessionBinding(this.buildChatSessionDependencies(), input);
  }

  public async respondToExistingChatMessage(
    sessionId: string,
    userMessageId: string,
    input: Partial<ChatSendMessageRequest> & {
      deliveryReplyToMessageId?: string;
      channelSystemInstruction?: string;
    } = {},
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

      const { deliveryReplyToMessageId, channelSystemInstruction, ...chatInput } = input;
      const request: ChatSendMessageRequest = {
        content: userMessage.content,
        ...chatInput,
      };
      const prepared = await this.prepareAgentChatTurn(sessionId, request, {
        branchKind: "append",
        existingUserMessage: userMessage,
        ingestUserMessage: false,
        extraSystemInstruction: channelSystemInstruction,
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
        // B2b voice replies: synthesize first (hard-bounded inside the
        // service), then send text+audio together on the existing attachment
        // lane. The helper never throws, so a synthesis failure or timeout
        // degrades to the unchanged text-only send.
        const voiceReplyAttachment = await this.maybeBuildChannelVoiceReplyAttachment(
          binding.connectionId,
          assistantContent,
        );
        this.requireExecutedToolResult(
          "channel.send",
          await this.commsSend({
            connectionId: binding.connectionId,
            target: binding.target,
            message: assistantContent,
            attachments: voiceReplyAttachment ? [voiceReplyAttachment] : undefined,
            replyToMessageId: deliveryReplyToMessageId?.trim() || prepared.userEventId,
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

  /**
   * B2b: optionally synthesize a TTS voice-note attachment for a channel
   * reply. Cheap flag pre-gate first (flag off ⇒ zero extra work, including
   * no connection lookup), then delegates to the never-throwing
   * channel-voice-reply service. Any unexpected error here also degrades to
   * text-only delivery — this path must never fail or delay the text reply.
   */
  private async maybeBuildChannelVoiceReplyAttachment(
    connectionId: string,
    text: string,
  ): Promise<ChannelAttachmentInput | undefined> {
    try {
      if (!this.isFeatureEnabled("channelVoiceReplyV1Enabled")) {
        return undefined;
      }
      const connection = this.storage.integrationConnections.get(connectionId);
      return await buildChannelVoiceReplyAttachment(
        {
          text,
          channelKey: connection.key,
          connectionConfig: (connection.config ?? {}) as Record<string, unknown>,
          connectionId,
        },
        {
          isChannelVoiceReplyEnabled: () => this.isFeatureEnabled("channelVoiceReplyV1Enabled"),
          synthesizeSpeech: (input) => this.mediaVoiceService.synthesizeSpeech(input),
          recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
        },
      );
    } catch (error) {
      try {
        this.recordDevDiagnostic({
          level: "warn",
          category: "voice",
          event: "voice.reply.attachment_failed",
          message: "Voice reply attachment build failed; delivering text-only reply.",
          context: {
            connectionId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      } catch {
        // Intentionally ignored (best-effort): diagnostics must never block
        // the text reply either.
      }
      return undefined;
    }
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

  public async loadChatTurnSessionState(
    sessionId: string,
    options: { includeDecisionTrace?: boolean } = {},
  ): Promise<{
    traces: ChatTurnTraceRecord[];
    tracesById: Map<string, ChatTurnTraceRecord>;
    turnLineageById: Map<string, { turnId: string; parentTurnId?: string }>;
    messages: ChatMessageRecord[];
    messagesById: Map<string, ChatMessageRecord>;
    childrenByTurnId: Map<string, string[]>;
    activeLeafTurnId?: string;
  }> {
    await this.ensureChatMessageProjection(sessionId);
    const rawTraces = this.storage.chatTurnTraces.listBySession(sessionId, 2_000);
    const turnLineageById = new Map(
      rawTraces.map((trace) => [
        trace.turnId,
        {
          turnId: trace.turnId,
          parentTurnId: trace.parentTurnId,
        },
      ]),
    );
    const activeLeafTurnId = this.resolveChatActiveLeafTurnId(sessionId, rawTraces);
    const selectedPathTurnIds = activeLeafTurnId ? buildSelectedPathTurnIds(turnLineageById, activeLeafTurnId) : [];
    const rawTraceById = new Map(rawTraces.map((trace) => [trace.turnId, trace]));
    const pathParentTurnIds = selectedPathTurnIds.map((turnId) => rawTraceById.get(turnId)?.parentTurnId);
    const siblingTracesByParent = this.storage.chatTurnTraces.listSiblingsByParentTurnIds(sessionId, pathParentTurnIds);
    const visibleTurnIds = new Set(selectedPathTurnIds);
    for (const siblings of siblingTracesByParent.values()) {
      for (const sibling of siblings) {
        visibleTurnIds.add(sibling.turnId);
        if (!rawTraceById.has(sibling.turnId)) {
          rawTraceById.set(sibling.turnId, sibling);
        }
      }
    }
    const visibleRawTraces = [...visibleTurnIds]
      .map((turnId) => rawTraceById.get(turnId))
      .filter((trace): trace is ChatTurnTraceRecord => Boolean(trace));
    const hydratedVisibleTracesById = new Map(
      chatTurnTraceHydration
        .hydrateChatTurnTraces(this, visibleRawTraces, {
          includeDecisionTrace: options.includeDecisionTrace === true,
        })
        .map((trace) => [trace.turnId, trace]),
    );
    const traces = rawTraces.map((trace) => hydratedVisibleTracesById.get(trace.turnId) ?? trace);
    const messageIds = visibleRawTraces.flatMap((trace) => [
      trace.userMessageId,
      ...(trace.assistantMessageId ? [trace.assistantMessageId] : []),
    ]);
    const messagesById = this.storage.chatMessages.listByMessageIds(messageIds);
    const messages = [...messagesById.values()].sort((left, right) => {
      const leftTimestamp = Date.parse(left.timestamp) || 0;
      const rightTimestamp = Date.parse(right.timestamp) || 0;
      if (leftTimestamp !== rightTimestamp) {
        return leftTimestamp - rightTimestamp;
      }
      return left.messageId.localeCompare(right.messageId);
    });
    return {
      traces,
      tracesById: new Map(traces.map((trace) => [trace.turnId, trace])),
      turnLineageById,
      messages,
      messagesById,
      childrenByTurnId: this.buildChatTurnChildrenMap(traces),
      activeLeafTurnId,
    };
  }

  private buildChatThreadKnowledgeDependencies(): chatThreadKnowledgeService.ChatThreadKnowledgeDependencies {
    return createChatThreadKnowledgeDependenciesForGateway(this.getRouteCompositionPort());
  }

  public getChatSessionPrefs(sessionId: string): ChatSessionPrefsRecord {
    return chatSessionService.getChatSessionPrefs(this.buildChatSessionDependencies(), sessionId);
  }

  public updateChatSessionPrefs(sessionId: string, input: ChatSessionPrefsPatch): ChatSessionPrefsRecord {
    return chatSessionService.updateChatSessionPrefs(this.buildChatSessionDependencies(), sessionId, input);
  }

  public ensureChatSessionModelDefaults(sessionId: string, prefs: ChatSessionPrefsRecord): ChatSessionPrefsRecord {
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

  public hydrateChatPrefsWithAutonomy(sessionId: string, prefs: ChatSessionPrefsRecord): ChatSessionPrefsRecord {
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

  public getSessionAutonomyPrefs(sessionId: string): SessionAutonomyPrefs {
    return this.storage.sessionAutonomyPrefs.ensure(sessionId);
  }

  public patchSessionAutonomyPrefs(sessionId: string, input: SessionAutonomyPrefsPatchInput): SessionAutonomyPrefs {
    return this.storage.sessionAutonomyPrefs.patch(sessionId, input);
  }

  private toProactivePolicy(sessionId: string, prefs: SessionAutonomyPrefs): ProactivePolicy {
    return this.chatProactiveService.toProactivePolicy(sessionId, prefs);
  }

  private startProactiveScheduler(): void {
    this.chatProactiveService.startScheduler();
  }

  // runWeeklyImprovementSchedulerIfDue moved to ImprovementService

  /** Tracks an in-flight background task so {@link close} can await its drain. */
  private registerBackgroundTask(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    task.finally(() => this.backgroundTasks.delete(task));
  }

  private startMaintenanceScheduler(): void {
    if (this.maintenanceScheduler) {
      return;
    }
    this.maintenanceScheduler = startBackgroundInterval({
      label: "maintenance scheduler",
      intervalMs: IMPROVEMENT_SCHEDULER_INTERVAL_MS,
      task: () => this.runMaintenanceSchedulerTick(),
      isClosing: () => this.closing,
      registerInflight: (task) => this.registerBackgroundTask(task),
      onError: (error) => log.error("maintenance scheduler tick failed", error),
    });
  }

  private async runMaintenanceSchedulerTick(): Promise<void> {
    if (this.closing) {
      return;
    }
    const tasks = [
      { label: "private beta backups", run: () => this.runPrivateBetaBackupSchedulerIfDue() },
      { label: "memory flush", run: () => this.runMemoryFlushSchedulerIfDue() },
      { label: "cost report", run: () => this.runCostReportSchedulerIfDue() },
      { label: "update review", run: () => this.runUpdateReviewSchedulerIfDue() },
      { label: "skill curator", run: () => this.curatorService.runCuratorWeeklyIfDue() },
      {
        label: "skill curator idle janitor",
        run: () =>
          this.runBestEffortMaintenance("curator_idle_sweep_failed", () => this.curatorService.maybeRunIdleCurator()),
      },
      { label: "cron automation", run: () => this.cronAutomationService.runDueTaskCronJobs() },
      {
        label: "commitment sweep",
        run: () => this.runBestEffortMaintenance("commitment_sweep_failed", () => this.runCommitmentSweep()),
      },
      {
        label: "heartbeat",
        run: () => this.runBestEffortMaintenance("heartbeat_failed", () => this.runHeartbeatSweep()),
      },
      { label: "memory evaluation", run: () => this.memoryLifecycleService.runDueEvaluation() },
      { label: "channel deliveries", run: () => this.drainDueChannelDeliveries() },
    ];
    // Wrap each task in an async IIFE so a synchronous throw (e.g. a missing
    // collaborator method) becomes a rejected promise captured by allSettled,
    // rather than escaping the map and crashing the whole tick.
    const results = await Promise.allSettled(tasks.map((task) => (async () => task.run())()));
    const failedLabels: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        return;
      }
      const label = tasks[index]?.label ?? "unknown";
      failedLabels.push(label);
      log.error("maintenance scheduler task failed", {
        task: label,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });
    if (failedLabels.length > 0) {
      throw new Error(`Maintenance scheduler tick failed for: ${failedLabels.join(", ")}`);
    }
  }

  /**
   * Periodically reclaim orphaned orchestration worktrees (no live/active run):
   * a short post-boot pass, then hourly. Timer/unref/failure-isolation plumbing
   * lives in {@link startBackgroundInterval}.
   */
  private startOrchestrationWorktreeReapScheduler(): void {
    if (this.orchestrationWorktreeReapScheduler) {
      return;
    }
    this.orchestrationWorktreeReapScheduler = startBackgroundInterval({
      label: "orchestration worktree reaper",
      intervalMs: ORCHESTRATION_WORKTREE_REAP_INTERVAL_MS,
      bootDelayMs: ORCHESTRATION_WORKTREE_REAP_BOOT_DELAY_MS,
      task: () => this.runOrchestrationWorktreeReapTick(),
      isClosing: () => this.closing,
      registerInflight: (task) => this.registerBackgroundTask(task),
      onError: (error) =>
        log.warn("orchestration worktree reaper tick failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
    });
  }

  private async runOrchestrationWorktreeReapTick(): Promise<void> {
    if (this.closing) {
      return;
    }
    const result = await this.orchestrationWorktreeService.reapOrphaned({ dryRun: false });
    if (result.removed.length > 0) {
      log.info("reaped orphaned orchestration worktrees", {
        scanned: result.scanned,
        removed: result.removed.length,
        skippedActive: result.skippedActive.length,
      });
    }
  }

  private async runCronWatchdog(job: CronJobRecord): Promise<CronWatchdogRunResult> {
    const checkId = job.actionConfig?.watchdog?.checkId ?? "runtime_health";
    const notifyHomeChannel = job.actionConfig?.watchdog?.notifyHomeChannel === true;
    let result: CronWatchdogRunResult;
    switch (checkId) {
      case "durable_dead_letters":
        result = this.runDurableDeadLetterWatchdog();
        break;
      case "channel_delivery_queue":
        result = this.runChannelDeliveryQueueWatchdog();
        break;
      case "mcp_posture":
        result = this.runMcpPostureWatchdog();
        break;
      case "runtime_health":
      default:
        result = this.runRuntimeHealthWatchdog();
        break;
    }
    const finalResult = { ...result, notifyHomeChannel };
    if (notifyHomeChannel && finalResult.status !== "ok") {
      await this.notifyWatchdogHomeChannel(job, finalResult).catch((error) => {
        this.recordDevDiagnostic({
          level: "warn",
          category: "cron",
          event: "watchdog.home_channel_notify_failed",
          message: "Watchdog found an issue but could not notify the configured home channel.",
          context: {
            jobId: job.jobId,
            checkId: finalResult.checkId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
    }
    return finalResult;
  }

  private runRuntimeHealthWatchdog(): CronWatchdogRunResult {
    return {
      status: this.closing ? "error" : "ok",
      checkId: "runtime_health",
      summary: this.closing ? "Gateway runtime is closing." : "Gateway runtime heartbeat is healthy.",
      details: {
        uptimeSeconds: Math.floor(process.uptime()),
        backgroundTaskCount: this.backgroundTasks.size,
        durableEnabled: this.config.assistant.durable.enabled,
      },
    };
  }

  private runDurableDeadLetterWatchdog(): CronWatchdogRunResult {
    const unresolved = this.storage.durableRuns.listDeadLetters(1000).filter((item) => !item.resolvedAt);
    return {
      status: unresolved.length > 0 ? "warning" : "ok",
      checkId: "durable_dead_letters",
      summary:
        unresolved.length > 0
          ? `${unresolved.length} unresolved durable dead letter(s) need review.`
          : "No unresolved durable dead letters.",
      details: {
        unresolvedCount: unresolved.length,
        sampleRunIds: unresolved.slice(0, 10).map((item) => item.runId),
      },
    };
  }

  private runChannelDeliveryQueueWatchdog(): CronWatchdogRunResult {
    const deliveries = this.listChannelDeliveryRuntime();
    const blocked = deliveries.filter(
      (item) =>
        item.deliveryStatus === "blocked" ||
        item.deliveryStatus === "not_available" ||
        item.deliveryStatus === "degraded" ||
        item.deliveryStatus === "manual_reconciliation_required",
    );
    const retrying = deliveries.filter((item) => item.deliveryStatus === "retrying");
    const manual = deliveries.filter((item) => item.deliveryStatus === "manual_reconciliation_required");
    const status = blocked.length > 0 ? "error" : retrying.length > 0 ? "warning" : "ok";
    return {
      status,
      checkId: "channel_delivery_queue",
      summary:
        status === "ok"
          ? "Channel delivery queue is clear."
          : `${blocked.length} blocked/degraded/manual-reconciliation and ${retrying.length} retrying channel delivery item(s).`,
      details: {
        blockedCount: blocked.length,
        manualReconciliationCount: manual.length,
        retryingCount: retrying.length,
        sampleDeliveryIds: [...blocked, ...retrying].slice(0, 10).map((item) => item.deliveryId),
      },
    };
  }

  private runMcpPostureWatchdog(): CronWatchdogRunResult {
    const enabledServers = this.readMcpServers().filter((server) => server.enabled);
    const hardIssues = enabledServers.filter(
      (server) => server.status === "error" || server.trustTier === "quarantined",
    );
    const softIssues = enabledServers.filter(
      (server) =>
        server.status !== "connected" ||
        Boolean(server.lastError) ||
        ((server.transport === "http" || server.transport === "sse") && !server.url?.trim()) ||
        (server.authType === "oauth2" && !server.url?.trim()),
    );
    const status = hardIssues.length > 0 ? "error" : softIssues.length > 0 ? "warning" : "ok";
    return {
      status,
      checkId: "mcp_posture",
      summary:
        status === "ok"
          ? "MCP posture is healthy for enabled servers."
          : `${hardIssues.length} hard and ${softIssues.length} soft MCP posture issue(s) found.`,
      details: {
        enabledCount: enabledServers.length,
        hardIssueServerIds: hardIssues.slice(0, 10).map((server) => server.serverId),
        softIssueServerIds: softIssues.slice(0, 10).map((server) => server.serverId),
      },
    };
  }

  private async notifyWatchdogHomeChannel(job: CronJobRecord, result: CronWatchdogRunResult): Promise<void> {
    const connection = this.storage.integrationConnections
      .list(undefined, 1000)
      .find(
        (item) =>
          item.enabled &&
          item.kind === "channel" &&
          typeof item.config.defaultChannelId === "string" &&
          item.config.defaultChannelId.trim().length > 0,
      );
    const target = typeof connection?.config.defaultChannelId === "string" ? connection.config.defaultChannelId : "";
    if (!connection || !target) {
      return;
    }
    await this.commsSend({
      connectionId: connection.connectionId,
      target,
      message: [`Watchdog attention needed: ${job.name}`, "", result.summary].join("\n"),
    });
  }

  public scheduleMemoryMaintenancePostTurnEvaluation(sessionId: string, parentTurnId?: string): void {
    if (this.closing || parentTurnId) {
      return;
    }
    const task = this.memoryLifecycleService.noteSuccessfulRootTurn(sessionId).catch((error) => {
      log.error("memory maintenance post-turn evaluation failed", error);
    });
    this.registerBackgroundTask(task);
  }

  /**
   * P2-S1 — schedule the self-improvement background review for a successful root
   * turn, counter-gated to run every {@link BACKGROUND_REVIEW_TURN_INTERVAL}
   * eligible turns. Sibling of {@link scheduleMemoryMaintenancePostTurnEvaluation}
   * — skips child turns and runs fire-and-forget after a successful root turn.
   *
   * Guards (master-autonomy / eval-integrity / non-human / closing / child-turn)
   * are resolved here and re-asserted inside the service; the counter only
   * advances for eligible turns. The review is a tracked background task that can
   * never throw out of the turn path.
   */
  public scheduleBackgroundReviewIfDue(input: {
    sessionId: string;
    workspaceId: string;
    userText: string;
    assistantText: string;
    parentTurnId?: string;
    /** True when the completed turn is itself an autonomous self-wake (skip). */
    autonomous?: boolean;
  }): void {
    // Skip child turns (mirror the memory-maintenance sibling) and a closing gateway.
    if (this.closing || input.parentTurnId) {
      return;
    }
    // Skip autonomous turns: a cron/heartbeat/commitment self-wake runs inside a
    // human session, but re-reviewing its output is a cost-amplifying loop (and
    // a heartbeat `{notify:false}` carries no review value).
    if (input.autonomous) {
      return;
    }
    // Master autonomy kill switch: halts the entire self-improvement loop.
    const autonomyEnabled = !this.isFeatureEnabled("autonomyV1Disabled");
    if (!autonomyEnabled) {
      return;
    }
    // Eval-integrity / non-human / replay-scratch guard (mirror recordTurnCommitments).
    const origin = this.storage.chatSessionMeta.get(input.sessionId)?.origin;
    const evalIntegrityTurn = origin === "prompt_pack";
    const humanSession =
      origin !== "system" && origin !== "prompt_pack" && !this.isReplayScratchSession(input.sessionId);
    if (evalIntegrityTurn || !humanSession) {
      return;
    }

    // Counter gate: only run once every N eligible successful turns; reset on fire.
    if (!this.advanceBackgroundReviewCounter()) {
      return;
    }

    const task = this.backgroundReviewService
      .runBackgroundReview({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        userText: input.userText,
        assistantText: input.assistantText,
        parentTurnId: input.parentTurnId,
        autonomyEnabled,
        evalIntegrityTurn,
        humanSession,
        turnSucceeded: true,
      })
      .then((result) => {
        if (result.ran && result.summaryMarker) {
          this.publishRealtime("self_improvement_review", "system", {
            type: "background_review",
            sessionId: input.sessionId,
            workspaceId: input.workspaceId,
            summaryMarker: result.summaryMarker,
            memoryFactCount: result.memoryFacts.length,
            skillProposed: result.skillProposed,
            skillId: result.skillMutation?.skillId,
          });
        }
      })
      .catch((error) => {
        log.warn("background review failed", {
          sessionId: input.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.registerBackgroundTask(task);
  }

  /**
   * Increment the background-review turn counter; when it reaches the interval,
   * reset it to 0 and return `true` (the review should run this turn). Otherwise
   * persist the bumped counter and return `false`. Best-effort: a storage error
   * never blocks or crashes the turn path (returns `false`).
   */
  private advanceBackgroundReviewCounter(): boolean {
    try {
      const current = this.storage.systemSettings.get<number>(BACKGROUND_REVIEW_TURNS_SINCE_SETTING_KEY)?.value ?? 0;
      const next = (typeof current === "number" && Number.isFinite(current) ? current : 0) + 1;
      if (next >= BACKGROUND_REVIEW_TURN_INTERVAL) {
        this.storage.systemSettings.set(BACKGROUND_REVIEW_TURNS_SINCE_SETTING_KEY, 0);
        return true;
      }
      this.storage.systemSettings.set(BACKGROUND_REVIEW_TURNS_SINCE_SETTING_KEY, next);
      return false;
    } catch (error) {
      log.warn("background review counter advance failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  public scheduleChatMemoryContextPrewarm(input: {
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
    this.registerBackgroundTask(task);
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
    const expiredMemoryLedger = this.isFeatureEnabled("memoryLifecycleAutoForgetEnabled")
      ? this.forgetExpiredMemoryItemsForFlush(nowIso)
      : this.inspectExpiredMemoryItemsForFlush(nowIso);

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
      expiredActiveMemoryItemCount: expiredMemoryLedger.expiredActiveCount,
      expiredMemoryItemCount: expiredMemoryLedger.expiredActiveCount,
      forgottenExpiredMemoryItemCount: expiredMemoryLedger.forgottenCount,
      retainedPinnedExpiredMemoryItemCount: expiredMemoryLedger.retainedPinnedCount,
      remainingExpiredUnpinnedMemoryItemCount: expiredMemoryLedger.remainingExpiredUnpinnedCount,
      expiredMemoryFlushTruncated: expiredMemoryLedger.truncated,
      memoryLifecycleAutoForgetEnabled: this.isFeatureEnabled("memoryLifecycleAutoForgetEnabled"),
      expiredMemoryItemIds: expiredMemoryLedger.forgottenItems.map((item) => item.itemId),
      expiredMemoryNamespacesSample: [...new Set(expiredMemoryLedger.forgottenItems.map((item) => item.namespace))],
      retainedPinnedExpiredMemoryItemIds: expiredMemoryLedger.retainedPinnedItems.map((item) => item.itemId),
      retainedPinnedExpiredMemoryNamespacesSample: [
        ...new Set(expiredMemoryLedger.retainedPinnedItems.map((item) => item.namespace)),
      ],
    });
  }

  private forgetExpiredMemoryItemsForFlush(nowIso: string): {
    expiredActiveCount: number;
    forgottenCount: number;
    retainedPinnedCount: number;
    remainingExpiredUnpinnedCount: number;
    truncated: boolean;
    forgottenItems: ReturnType<MemoryLifecycleService["forgetExpiredActiveMemoryItems"]>["forgottenItems"];
    retainedPinnedItems: ReturnType<MemoryLifecycleService["forgetExpiredActiveMemoryItems"]>["retainedPinnedItems"];
  } {
    const forgottenItems: ReturnType<MemoryLifecycleService["forgetExpiredActiveMemoryItems"]>["forgottenItems"] = [];
    while (forgottenItems.length < MEMORY_FLUSH_EXPIRED_SAFETY_LIMIT) {
      const remainingCapacity = MEMORY_FLUSH_EXPIRED_SAFETY_LIMIT - forgottenItems.length;
      const batch = this.memoryLifecycleService.forgetExpiredActiveMemoryItems({
        nowIso,
        limit: Math.min(MEMORY_FLUSH_EXPIRED_BATCH_LIMIT, remainingCapacity),
      });
      forgottenItems.push(...batch.forgottenItems);
      if (batch.forgottenItems.length === 0 || batch.remainingUnpinnedCount === 0) {
        break;
      }
    }
    const ledger = this.memoryLifecycleService.inspectExpiredActiveMemoryLedger({ nowIso });
    return {
      expiredActiveCount: ledger.totalCount + forgottenItems.length,
      forgottenCount: forgottenItems.length,
      retainedPinnedCount: ledger.retainedPinnedCount,
      remainingExpiredUnpinnedCount: ledger.unpinnedCount,
      truncated: ledger.unpinnedCount > 0,
      forgottenItems,
      retainedPinnedItems: ledger.retainedPinnedItems,
    };
  }

  private inspectExpiredMemoryItemsForFlush(nowIso: string): {
    expiredActiveCount: number;
    forgottenCount: number;
    retainedPinnedCount: number;
    remainingExpiredUnpinnedCount: number;
    truncated: boolean;
    forgottenItems: [];
    retainedPinnedItems: ReturnType<MemoryLifecycleService["inspectExpiredActiveMemoryLedger"]>["retainedPinnedItems"];
  } {
    const ledger = this.memoryLifecycleService.inspectExpiredActiveMemoryLedger({ nowIso });
    return {
      expiredActiveCount: ledger.totalCount,
      forgottenCount: 0,
      retainedPinnedCount: ledger.retainedPinnedCount,
      remainingExpiredUnpinnedCount: ledger.unpinnedCount,
      truncated: ledger.unpinnedCount > 0,
      forgottenItems: [],
      retainedPinnedItems: ledger.retainedPinnedItems,
    };
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

  public hasRunningTurn(sessionId: string): boolean {
    const latest = this.storage.chatTurnTraces.listBySession(sessionId, 1)[0];
    if (latest && isChatTurnActiveStatus(latest.status)) {
      return true;
    }
    return Boolean(this.findLatestActiveChatTurnStreamForSession(sessionId));
  }

  public beginActiveChatTurnExecution(sessionId: string, turnId: string, operation: string): AbortController {
    return this.chatTurnExecutionRegistry.beginActiveExecution(sessionId, turnId, operation);
  }

  public endActiveChatTurnExecution(turnId: string, controller: AbortController): void {
    this.chatTurnExecutionRegistry.endActiveExecution(turnId, controller);
  }

  private isChatTurnCancellationRequested(turnId: string): boolean {
    return this.chatTurnExecutionRegistry.isCancellationRequested(turnId);
  }

  public getActiveChatTurnExecution(turnId: string): ActiveChatTurnExecution | undefined {
    return this.chatTurnExecutionRegistry.getActiveExecution(turnId);
  }

  public async cancelLatestActiveChatTurnForSession(
    sessionId: string,
    cancelledBy = "operator",
  ): Promise<{
    status: "cancelled" | "no_active_run" | "failed";
    sessionId: string;
    turnId?: string;
    durableRunId?: string;
    durableCancelled?: boolean;
    error?: string;
    trace?: ChatTurnTraceRecord;
  }> {
    const trace = this.storage.chatTurnTraces
      .listBySession(sessionId, 25)
      .find((candidate) => isChatTurnActiveStatus(candidate.status));
    const activeStream = trace ? undefined : this.findLatestActiveChatTurnStreamForSession(sessionId);
    if (!trace && !activeStream) {
      return {
        status: "no_active_run",
        sessionId,
      };
    }
    const turnId = trace?.turnId ?? activeStream!.turnId;
    const initialDurableRunId = trace?.durable?.runId ?? activeStream?.runId;
    const initialDurableStatus = this.readDurableRunStatus(initialDurableRunId);

    try {
      const result = await this.chatTurnRuntime.cancelChatTurn(sessionId, turnId, cancelledBy);
      const durableRunId = result.trace.durable?.runId ?? initialDurableRunId;
      const finalDurableStatus = this.readDurableRunStatus(durableRunId);
      const durableCancelled =
        durableRunId === undefined
          ? undefined
          : Boolean(
              initialDurableStatus &&
              !this.isDurableRunTerminalStatus(initialDurableStatus) &&
              finalDurableStatus === "cancelled",
            );
      return {
        status: "cancelled",
        sessionId,
        turnId,
        durableRunId,
        durableCancelled,
        trace: result.trace,
      };
    } catch (error) {
      return {
        status: "failed",
        sessionId,
        turnId,
        durableRunId: initialDurableRunId,
        error: (error as Error).message,
      };
    }
  }

  private findLatestActiveChatTurnStreamForSession(sessionId: string): ActiveChatTurnStreamExecution | undefined {
    return this.chatTurnExecutionRegistry
      .listActiveStreamsForSession(sessionId)
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .at(0);
  }

  private readDurableRunStatus(runId: string | undefined): DurableRunStatus | undefined {
    if (!runId) {
      return undefined;
    }
    try {
      return this.storage.durableRuns.getRun(runId).status;
    } catch {
      return undefined;
    }
  }

  private isDurableRunTerminalStatus(status: DurableRunStatus): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  public registerActiveChatTurnStream(
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

  public getActiveChatTurnStream(turnId: string): ActiveChatTurnStreamExecution | undefined {
    return this.chatTurnExecutionRegistry.getActiveStream(turnId);
  }

  public completeActiveChatTurnStream(turnId: string): void {
    this.chatTurnExecutionRegistry.completeActiveStream(turnId);
  }

  public closeActiveChatTurnStream(turnId: string): void {
    this.chatTurnExecutionRegistry.closeActiveStream(turnId);
  }

  public persistChatStreamChunk(chunk: PersistableChatStreamChunk, runId?: string): ChatStreamChunk {
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
    // Wake any live-tail reader immediately so it doesn't wait out the poll
    // interval before forwarding this chunk to the client (P0-#1).
    this.signalChatStreamEvent(chunk.turnId);
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

  public async *streamPersistedChatTurnEvents(
    sessionId: string,
    turnId: string,
    options?: {
      sinceEventId?: string;
      liveTail?: boolean;
      returnOnDurableInterrupt?: boolean;
      signal?: AbortSignal;
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
      if (options?.signal?.aborted) {
        return;
      }
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
      const durablePending = options?.liveTail
        ? this.isDurableTurnStillStreaming(turnId, {
            includeInterrupts: options.returnOnDurableInterrupt !== true,
          })
        : false;
      if (!options?.liveTail || ((!active || active.completed) && !durablePending)) {
        return;
      }
      await this.waitForChatStreamEvent(turnId, CHAT_STREAM_EVENT_POLL_INTERVAL_MS, options?.signal);
    }
  }

  /**
   * Live-tail token delivery (P0-#1). Historically the reader above polled SQLite
   * every CHAT_STREAM_EVENT_POLL_INTERVAL_MS, adding up to that interval of latency
   * to every token (including the first) before it reached the client. These two
   * helpers let the producer (persistChatStreamChunk) wake a waiting reader the
   * instant a chunk is appended. The timeout inside waitForChatStreamEvent preserves
   * the old polling cadence as a liveness floor — covering cross-process producers
   * and the rare register-after-append race — so worst-case behaviour is unchanged.
   *
   * The waiter map is created lazily (not a field initialiser) so it also works on
   * instances built via Object.create(prototype) in tests.
   */
  private chatStreamEventWaiters?: Map<string, Set<() => void>>;

  private signalChatStreamEvent(turnId: string): void {
    const waiters = this.chatStreamEventWaiters?.get(turnId);
    if (!waiters || waiters.size === 0) {
      return;
    }
    // Each notify() removes itself from the set, so iterate a snapshot.
    for (const notify of [...waiters]) {
      notify();
    }
  }

  private waitForChatStreamEvent(turnId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.resolve();
    }
    if (!this.chatStreamEventWaiters) {
      this.chatStreamEventWaiters = new Map();
    }
    const waiters = this.chatStreamEventWaiters;
    return new Promise<void>((resolve) => {
      let settled = false;
      let registeredSet = waiters.get(turnId);
      if (!registeredSet) {
        registeredSet = new Set<() => void>();
        waiters.set(turnId, registeredSet);
      }
      const ownSet = registeredSet;
      const settle = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        ownSet.delete(notify);
        if (ownSet.size === 0 && waiters.get(turnId) === ownSet) {
          waiters.delete(turnId);
        }
        clearTimeout(timer);
        if (signal) {
          signal.removeEventListener("abort", settle);
        }
        resolve();
      };
      const notify = settle;
      const timer = setTimeout(settle, timeoutMs);
      ownSet.add(notify);
      if (signal) {
        signal.addEventListener("abort", settle, { once: true });
      }
    });
  }

  private isDurableTurnStillStreaming(turnId: string, options?: { includeInterrupts?: boolean }): boolean {
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
      if (run.status === "queued" || run.status === "running") {
        return true;
      }
      return options?.includeInterrupts !== false && (run.status === "waiting" || run.status === "paused");
    } catch {
      return false;
    }
  }

  public async *withEphemeralStreamEnvelope(
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

  public createHydratedChatTurnTrace(
    turnId: string,
    trace: ChatTurnTraceRecord,
    options?: chatTurnTraceHydration.ChatTurnTraceHydrationOptions,
  ): ChatTurnTraceRecord {
    return chatTurnTraceHydration.createHydratedChatTurnTrace(this, turnId, trace, options);
  }

  public markChatTurnCancelled(sessionId: string, turnId: string, cancelledBy?: string): ChatTurnTraceRecord {
    let current: ChatTurnTraceRecord;
    try {
      current = this.storage.chatTurnTraces.get(turnId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
      const recovered = this.createRunningTraceForActiveStreamCancellation(sessionId, turnId);
      if (!recovered) {
        throw error;
      }
      current = recovered;
    }
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

  private createRunningTraceForActiveStreamCancellation(
    sessionId: string,
    turnId: string,
  ): ChatTurnTraceRecord | undefined {
    const activeStream = this.getActiveChatTurnStream(turnId);
    if (!activeStream || activeStream.sessionId !== sessionId || !activeStream.runId) {
      return undefined;
    }
    let run: DurableRunRecord;
    try {
      run = this.storage.durableRuns.getRun(activeStream.runId);
    } catch {
      return undefined;
    }
    const payload = this.parseDurableChatTurnPayload(run);
    if (!payload || payload.sessionId !== sessionId || payload.turnId !== turnId) {
      return undefined;
    }
    const prefs = this.storage.chatSessionPrefs.get(sessionId);
    const request = payload.request;
    const mode: ChatMode = request.mode ?? request.prefsOverride?.mode ?? prefs?.mode ?? "chat";
    return this.storage.chatTurnTraces.create({
      turnId,
      sessionId,
      userMessageId: payload.userMessageId,
      parentTurnId: payload.parentTurnId,
      branchKind: payload.branchKind,
      sourceTurnId: payload.sourceTurnId,
      status: "running",
      mode,
      model: request.model ?? prefs?.model,
      webMode: request.webMode ?? request.prefsOverride?.webMode ?? prefs?.webMode ?? "auto",
      memoryMode: request.memoryMode ?? request.prefsOverride?.memoryMode ?? prefs?.memoryMode ?? "auto",
      thinkingLevel:
        request.thinkingLevel ?? request.prefsOverride?.thinkingLevel ?? prefs?.thinkingLevel ?? "standard",
      speedMode: request.speedMode ?? request.prefsOverride?.speedMode ?? prefs?.speedMode,
      subagentPolicy: request.subagentPolicy ?? request.prefsOverride?.subagentPolicy ?? prefs?.subagentPolicy,
      effectiveToolAutonomy: request.prefsOverride?.toolAutonomy ?? prefs?.toolAutonomy,
      startedAt: activeStream.startedAt,
      routing: {
        primaryProviderId: request.providerId ?? prefs?.providerId,
        primaryModel: request.model ?? prefs?.model,
        effectiveProviderId: request.providerId ?? prefs?.providerId,
        effectiveModel: request.model ?? prefs?.model,
      },
      durable: {
        runId: activeStream.runId,
        status: run.status,
      },
    });
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

  public collectSpecialistCandidateSuggestions(input: {
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

  public extractAndPersistLearnedMemory(
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

  /**
   * Fire-and-forget post-turn commitment inference (P1-F3). Resolves the master
   * autonomy / eval-integrity / non-human guards from session metadata, then
   * runs the cheap hidden classifier as a tracked background task. Never throws
   * into the calling turn; classifier failures are swallowed inside the service.
   */
  public recordTurnCommitments(input: {
    sessionId: string;
    workspaceId: string;
    userText: string;
    assistantText: string;
    /** True when the completed turn is itself an autonomous self-wake (skip). */
    autonomous?: boolean;
  }): void {
    const autonomyEnabled = !this.isFeatureEnabled("autonomyV1Disabled");
    if (!autonomyEnabled) {
      return;
    }
    // Skip autonomous turns: classifying a cron/heartbeat/commitment self-wake's
    // own output (e.g. a heartbeat `{notify:false}`) is a redundant cheap-model
    // call and a self-feeding loop — these turns are not user commitments.
    if (input.autonomous) {
      return;
    }
    const origin = this.storage.chatSessionMeta.get(input.sessionId)?.origin;
    const evalIntegrityTurn = origin === "prompt_pack";
    const humanSession =
      origin !== "system" && origin !== "prompt_pack" && !this.isReplayScratchSession(input.sessionId);
    if (evalIntegrityTurn || !humanSession) {
      return;
    }
    const task = this.commitmentClassifier
      .recordTurnCommitments({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        userText: input.userText,
        assistantText: input.assistantText,
        autonomyEnabled,
        evalIntegrityTurn,
        humanSession,
      })
      .then(() => undefined)
      .catch((error) => {
        log.warn("commitment classifier failed", {
          sessionId: input.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.registerBackgroundTask(task);
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

  public updateChatSessionLearnedMemory(
    sessionId: string,
    itemId: string,
    input: LearnedMemoryUpdateInput,
  ): LearnedMemoryItemRecord {
    return this.memoryLifecycleService.updateSessionLearnedMemory(sessionId, itemId, input);
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
    const openaiCodex = runtime.providers.find(
      (provider) => provider.providerId === "openai-codex" && provider.hasApiKey,
    );
    if (openaiCodex) {
      return {
        providerId: openaiCodex.providerId,
        model: "gpt-5.5",
      };
    }
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

  public ensureChatSessionRuntimeGrants(sessionId: string): void {
    const active = this.listActiveToolGrants("session", sessionId);
    const workspaceId = this.storage.chatSessionMeta.get(sessionId)?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const inheritedDeny = [
      ...this.listActiveToolGrants("global", "global"),
      ...this.listActiveToolGrants("agent", "assistant"),
      ...this.listActiveToolGrants("workspace", workspaceId),
    ].filter((grant) => grant.decision === "deny");
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

  public inheritDelegatedSessionToolGrants(parentSessionId: string, childSessionId: string): void {
    const inheritedGrants = buildDelegatedSessionToolGrantCopies({
      parentSessionId,
      childSessionId,
      parentGrants: this.listActiveToolGrants("session", parentSessionId),
      childGrants: this.listActiveToolGrants("session", childSessionId),
    });

    for (const grantInput of inheritedGrants) {
      this.createToolGrant(grantInput);
    }
  }

  public async parseChatCommand(
    sessionId: string,
    commandText: string,
    options?: chatCommandService.ChatCommandOptions,
  ): Promise<chatCommandService.ChatCommandResult> {
    return chatCommandService.parseChatCommand(createChatCommandDependencies(this), sessionId, commandText, options);
  }

  public async runChatResearch(
    sessionId: string,
    input: {
      query: string;
      mode: "quick" | "deep";
      providerId?: string;
      model?: string;
      policyRunId?: string;
      policyTaskId?: string;
      operatorId?: string;
      authActorId?: string;
      authActorSource?: ToolPolicyActorContext["authActorSource"];
      permissionProfileId?: string;
      localOperatorOverrideId?: string;
      surface?: PermissionSurface;
    },
  ): Promise<ResearchSummaryRecord> {
    this.getSession(sessionId);
    this.ensureChatSessionRuntimeGrants(sessionId);
    const workspaceId = this.storage.chatSessionMeta.get(sessionId)?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    return this.researchService.run({
      sessionId,
      query: input.query,
      mode: input.mode,
      providerId: input.providerId,
      model: input.model,
      workspaceId,
      policyRunId: input.policyRunId,
      policyTaskId: input.policyTaskId,
      operatorId: input.operatorId,
      authActorId: input.authActorId,
      authActorSource: input.authActorSource,
      permissionProfileId: input.permissionProfileId,
      localOperatorOverrideId: input.localOperatorOverrideId,
      surface: input.surface,
    });
  }

  public async runChatDelegation(
    sessionId: string,
    input: ChatDelegateRequest,
    callbacks?: ChatDelegationProgressCallbacks,
  ): Promise<ChatDelegateResponse> {
    return this.chatDelegationService.runChatDelegation(sessionId, input, callbacks);
  }

  public async *runChatDelegationStream(
    sessionId: string,
    input: ChatDelegateRequest,
    options: ChatDelegationRunOptions = {},
  ): AsyncGenerator<{
    type: "status" | "step" | "done" | "error";
    runId?: string;
    taskId?: string;
    message?: string;
    step?: ChatDelegationStepRecord;
    result?: ChatDelegateResponse;
    error?: string;
  }> {
    yield* this.chatDelegationService.runChatDelegationStream(sessionId, input, options);
  }

  public async triggerChatSessionProactive(
    sessionId: string,
    input: ProactiveTriggerInput = {},
  ): Promise<ProactiveRunRecord> {
    return this.chatProactiveService.triggerChatSessionProactive(sessionId, input);
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

  // triggerChatSessionProactive body removed (moved to ChatProactiveService)

  // (triggerChatSessionProactive body removed - moved to ChatProactiveService)

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

  public async suggestChatDelegation(
    sessionId: string,
    input: import("@goatcitadel/contracts").ChatDelegateSuggestRequest = {},
  ): Promise<import("@goatcitadel/contracts").ChatDelegateSuggestResponse> {
    return this.chatDelegationService.suggestChatDelegation(sessionId, input);
  }

  public async acceptChatDelegation(
    sessionId: string,
    input: import("@goatcitadel/contracts").ChatDelegateAcceptRequest,
  ): Promise<ChatDelegateResponse> {
    return this.chatDelegationService.acceptChatDelegation(sessionId, input);
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

  // ── S2: skill self-authoring activation callbacks ─────────────────────────
  // These delegate to SkillMutationService. They are the governed write path for
  // skill_revision candidates flowing through improvement-service
  // applyActivationChange. isSkillCallable is never bypassed: the candidate is
  // written non-callable, and promotion to `approved` happens only under master
  // autonomy and only through this recorded, reversible activation.

  private captureSkillRevisionSnapshot(targetKey: string, revisionRef: ImprovementRef): ImprovementRef {
    const { skillId, skillMarkdown } = this.readSkillRevisionRef(targetKey, revisionRef);
    const snapshot = this.skillMutationService.captureSnapshotFor({ skillId, skillMarkdown });
    // NOTE: the unified autonomy-audit entry is intentionally NOT appended here.
    // This snapshot is captured at PROPOSAL time (an approval is then created and
    // the apply happens only later, after approval — or never). Recording the
    // audit now would leave a phantom entry for a mutation that never landed
    // (rejected/expired approval, or a throwing apply), which revertAutonomous-
    // ChangesSince would then "restore". The audit is appended in
    // applySkillRevisionCandidate AFTER the write actually succeeds.
    return this.buildSkillRevisionSnapshotRef(snapshot, targetKey);
  }

  /** Build the value-carrying snapshot ref consumed by restoreSkillRevisionSnapshot. */
  private buildSkillRevisionSnapshotRef(snapshot: SkillMutationSnapshot, targetKey: string): ImprovementRef {
    return {
      refType: "skill_revision_snapshot",
      refId: snapshot.skillId,
      hash: createHash("sha1").update(JSON.stringify(snapshot)).digest("hex"),
      metadata: {
        targetKey,
        skillId: snapshot.skillId,
        snapshot: snapshot as unknown as Record<string, unknown>,
      },
    };
  }

  private applySkillRevisionCandidate(targetKey: string, revisionRef: ImprovementRef): ImprovementRef {
    const { skillId, skillMarkdown, evaluationRunId, sourceTurnId, summary } = this.readSkillRevisionRef(
      targetKey,
      revisionRef,
    );
    if (!skillMarkdown) {
      throw new Error(`Skill revision ${targetKey} is missing skill content; refusing to apply an empty mutation.`);
    }
    // Capture the prior state immediately BEFORE the write so the audit restoreRef
    // carries the correct pre-mutation bytes (the proposal-time snapshot is on the
    // activation rail; this one backs the unified autonomy-audit ledger).
    const priorSnapshot = this.skillMutationService.captureSnapshotFor({ skillId, skillMarkdown });
    // Validate + security-scan + secret-block + jail-write as non-callable candidate.
    const result = this.skillMutationService.applySkillMutationSync({
      skillMarkdown,
      skillId,
      evaluationRunId,
      sourceTurnId,
      summary,
    });
    // Full autonomy: promote to a callable `approved` state ONLY when the master
    // autonomy switch is engaged. When off, the skill stays a non-callable
    // `candidate` (pure proposal mode). Promotion is reversible by the snapshot.
    const autonomyEnabled = !this.isFeatureEnabled("autonomyV1Disabled");
    const lifecycle = autonomyEnabled
      ? this.skillMutationService.promoteSelfAuthoredSkill(result.skillId)
      : result.lifecycle;
    // Unified audit: append ONLY now that the write (and any promote) has
    // succeeded, so a failed/blocked apply never leaves a phantom ledger entry.
    // The snapshot ref is value-carrying (prior bytes inline) and is exactly what
    // restoreSkillRevisionSnapshot consumes. Best-effort; never blocks the apply.
    this.autonomyControlService.recordAutonomousMutation({
      kind: "skill_revision",
      targetKey: result.skillId,
      restoreRef: { kind: "skill_revision", snapshotRef: this.buildSkillRevisionSnapshotRef(priorSnapshot, targetKey) },
    });
    return {
      refType: "skill_revision_config",
      refId: result.skillId,
      hash: result.changeHash,
      metadata: {
        targetKey,
        skillId: result.skillId,
        lifecycleState: lifecycle.lifecycleState,
        autoPromoted: autonomyEnabled,
        callable: lifecycle.lifecycleState === "approved" || lifecycle.lifecycleState === "trusted",
      },
    };
  }

  private restoreSkillRevisionSnapshot(snapshotRef: ImprovementRef): void {
    const metadata = isRecord(snapshotRef.metadata) ? snapshotRef.metadata : {};
    const snapshot = metadata.snapshot;
    if (!isRecord(snapshot) || typeof snapshot.skillId !== "string") {
      throw new Error("Skill revision snapshot is missing its captured state; cannot restore.");
    }
    this.skillMutationService.restoreSnapshotSync(snapshot as unknown as SkillMutationSnapshot);
  }

  private readSkillRevisionRef(
    targetKey: string,
    revisionRef: ImprovementRef,
  ): {
    skillId?: string;
    skillMarkdown?: string;
    evaluationRunId?: string;
    sourceTurnId?: string;
    summary?: string;
  } {
    const metadata = isRecord(revisionRef.metadata) ? revisionRef.metadata : {};
    const proposed = isRecord(metadata.proposedChange) ? metadata.proposedChange : {};
    const readString = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim().length > 0 ? value : undefined;
    const skillMarkdown =
      readString(metadata.skillMarkdown) ??
      readString(metadata.skillContent) ??
      readString(proposed.skillMarkdown) ??
      readString(proposed.skillContent);
    const skillId =
      readString(metadata.skillId) ??
      readString(proposed.skillId) ??
      readString(targetKey.startsWith("skill:") ? targetKey.slice("skill:".length) : undefined);
    return {
      skillId,
      skillMarkdown,
      evaluationRunId: readString(metadata.evaluationRunId) ?? readString(proposed.evaluationRunId),
      sourceTurnId: readString(metadata.sourceTurnId) ?? readString(proposed.sourceTurnId),
      summary: readString(metadata.summary) ?? readString(proposed.skillName) ?? readString(proposed.title),
    };
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

  private evaluateDurableContinuationGate(run: DurableRunRecord) {
    const checkpoints = this.storage.durableRuns.listCheckpoints(run.runId, 2_000);
    let stepsSinceCheckpoint = 0;
    for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
      if (checkpoints[index]?.checkpointKind === "continuation_gate") {
        break;
      }
      stepsSinceCheckpoint += 1;
    }
    return this.continuationGateService.evaluate({
      metrics: {
        stepsSinceCheckpoint,
        approvalWait: run.status === "waiting",
      },
      checkpointIntervalSteps: 25,
    });
  }

  public getDurableDiagnostics(): DurableDiagnosticsResponse {
    return this.durableOperatorService.getDiagnostics();
  }

  public listDurableRuns(limit = 50): DurableRunRecord[] {
    return this.durableOperatorService.listRuns(limit);
  }

  public listDurableDeadLetters(limit = 50): DurableDeadLetterRecord[] {
    return this.durableOperatorService.listDeadLetters(limit);
  }

  public listDurableRunCheckpoints(runId: string, limit = 200): DurableCheckpointRecord[] {
    return this.durableOperatorService.listRunCheckpoints(runId, limit);
  }

  public createDurableRun(input: DurableRunCreateRequest): DurableRunRecord {
    return this.durableOperatorService.createRun(input);
  }

  public getDurableRun(runId: string): DurableRunRecord {
    return this.durableOperatorService.getRun(runId);
  }

  public listDurableRunTimeline(runId: string, limit = 300): DurableRunTimelineEvent[] {
    return this.durableOperatorService.listRunTimeline(runId, limit);
  }

  public pauseDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    return this.durableOperatorService.pauseRun(runId, actorId);
  }

  public resumeDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    return this.durableOperatorService.resumeRun(runId, actorId);
  }

  public cancelDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    return this.durableOperatorService.cancelRun(runId, actorId);
  }

  public retryDurableRun(runId: string, reason = "manual_retry", actorId = "operator"): DurableRunRecord {
    return this.durableOperatorService.retryRun(runId, reason, actorId);
  }

  public getMemoryMaintenanceStatus(workspaceId?: string): MemoryMaintenanceStatusRecord {
    return this.memoryLifecycleService.getMaintenanceStatus(workspaceId);
  }

  public runMemoryMaintenanceNow(input: MemoryMaintenanceRunNowInput): MemoryMaintenanceRunRecord {
    return this.memoryLifecycleService.runMaintenanceNow(input);
  }

  public wakeDurableRun(
    runId: string,
    event: {
      eventKey: string;
      payload?: Record<string, unknown>;
      correlationId?: string;
    },
  ): DurableWakeResult {
    return this.durableOperatorService.wakeRun(runId, event);
  }

  public recoverDurableDeadLetter(
    entryId: string,
    actorId = "operator",
    options?: { maxAttempts?: number },
  ): DurableRunRecord {
    return this.durableOperatorService.recoverDeadLetter(entryId, actorId, options);
  }

  private isDurableFoundationEnabled(): boolean {
    return this.durableRunService.isDurableFoundationEnabled();
  }

  // markInterruptedDecisionReplayRuns moved to ImprovementService

  // Improvement private helpers moved to ImprovementService

  public async runPromptPackFromChat(sessionId: string, selector: string): Promise<PromptPackRunRecord[]> {
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
      resolvedBy?: string;
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

  public async requireChatTurnContext(
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

  public async withChatTurnWriteLease<T>(sessionId: string, operation: string, work: () => Promise<T>): Promise<T> {
    return this.chatTurnExecutionRegistry.withWriteLease(sessionId, operation, work);
  }

  public async *withChatTurnWriteLeaseStream(
    sessionId: string,
    operation: string,
    work: () => AsyncGenerator<ChatStreamChunk>,
  ): AsyncGenerator<ChatStreamChunk> {
    yield* this.chatTurnExecutionRegistry.withWriteLeaseStream(sessionId, operation, work);
  }

  public clearChatTurnWriteLease(sessionId: string): void {
    this.chatTurnExecutionRegistry.clearSessionWriteLease(sessionId);
  }

  public updateActiveLeafOrThrow(
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

  public prepareAgentChatTurn(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: {
      branchKind?: ChatTurnBranchKind;
      sourceTurnId?: string;
      parentTurnId?: string;
      existingUserMessage?: ChatMessageRecord;
      ingestUserMessage?: boolean;
      extraSystemInstruction?: string;
      turnId?: string;
      assistantMessageId?: string;
    },
  ): Promise<chatTurnPrepService.PreparedAgentChatTurn> {
    return chatTurnPrepService.prepareAgentChatTurn(this, sessionId, input, options);
  }

  public isChatTurnWriteConflict(error: unknown): error is ChatTurnWriteConflictError {
    return error instanceof ChatTurnWriteConflictError;
  }

  public resolvePreparedTurnOrchestration(
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

  public buildChatOrchestrationSummary(input: {
    runId: string;
    objective: string;
    modePolicy: ChatMode;
    routeDecision: ReturnType<typeof buildOrchestrationPlan>["routeDecision"];
    stepResults: OrchestrationStepExecutionResult[];
    finalSummary?: string;
    integritySignals?: string[];
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
    options?: { abortSignal?: AbortSignal },
  ): Promise<ChatSendMessageResponse> {
    return this.chatTurnRuntime.agentSendChatMessage(sessionId, input, options);
  }

  public agentSendChatMessageStream(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: { abortSignal?: AbortSignal },
  ): AsyncGenerator<ChatStreamChunk> {
    return this.chatTurnRuntime.agentSendChatMessageStream(sessionId, input, options);
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
      return await this.chatTurnRuntime.retryChatTurn(scratch.sessionId, scratch.sourceTurnId, overrides);
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

  public async collectCapabilityUpgradeSuggestions(input: {
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
            return mcpDiagnosticsService.listMcpTemplateDiscovery({
              requireFeatureEnabled: (flag) => this.requireFeatureEnabled(flag as keyof RuntimeSettings["features"]),
              listMcpTemplates: () => this.listMcpTemplates(),
              requireMcpServer: (serverId) => this.requireMcpServer(serverId),
              pickConnectorDiagnosticAction: (checks) =>
                connectorDiagnosticsHelpers.pickConnectorDiagnosticAction(checks),
              recordConnectorHealthRun: (report) => connectorDiagnosticsHelpers.recordConnectorHealthRun(this, report),
            });
          } catch {
            return [];
          }
        },
      },
    });
  }

  public recordCapabilityGapFromTrace(input: {
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

  public resolveDurableRunHookWorkspaceId(run: DurableRunRecord): string {
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
      const workspaceId =
        typeof payload?.workspaceId === "string"
          ? payload.workspaceId.trim()
          : typeof payload?.payload?.workspaceId === "string"
            ? payload.payload.workspaceId.trim()
            : "";
      if (workspaceId) {
        return this.normalizeWorkspaceId(workspaceId);
      }
      const approvalId = typeof payload?.payload?.approvalId === "string" ? payload.payload.approvalId.trim() : "";
      if (approvalId) {
        try {
          const approval = this.storage.approvals.get(approvalId);
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

  /**
   * File the legacy inert inbox record for a scheduled cron job. Shared by the
   * `task` handler and the `agent_turn` autonomy-disabled / inertInboxFallback
   * path so the fallback behavior stays byte-identical to today's `task` cron.
   */
  private createCronInboxTask(job: CronJobRecord): TaskRecord {
    return this.taskLifecycleService.createTask({
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
  }

  /**
   * Cron `agent_turn` handler. Wakes the model under the restricted
   * `scheduled-restricted` profile via a durable `chat.turn.execute` run, unless
   * the master autonomy kill switch is engaged (`autonomyV1Disabled`) or the job
   * opted into `inertInboxFallback` — in which case it files the legacy inert
   * inbox task. Safety: the scheduled turn carries `operatorId:"system-cron"`,
   * `authActorSource:"none"`, and `permissionProfileId:"scheduled-restricted"`
   * so dangerous tools become approvals rather than silent actions.
   */
  private async runCronAgentTurn(input: {
    job: CronJobRecord;
    runId: string;
    config: CronAgentTurnConfig;
  }): Promise<AgentTurnCronRunOutcome> {
    const autonomyDisabled = this.isFeatureEnabled("autonomyV1Disabled");
    if (autonomyDisabled || input.config.inertInboxFallback) {
      const task = this.createCronInboxTask(input.job);
      return { mode: "inbox", taskId: task.taskId };
    }
    const sessionId = this.ensureCronAgentSession(input.job.jobId, input.config.sessionId);
    const createdBy = input.config.createdBy;
    const systemActorId = createdBy?.operatorId?.trim() || createdBy?.authActorId?.trim() || "system-cron";
    const scheduledPolicy = this.resolveScheduledAgentTurnPolicy({
      config: input.config,
      jobId: input.job.jobId,
      runId: input.runId,
      sessionId,
      systemActorId,
    });
    if ("failClosedReason" in scheduledPolicy) {
      const task = this.createCronInboxTask(input.job);
      return {
        mode: "inbox",
        taskId: task.taskId,
        profilePosture: scheduledPolicy.profilePosture,
        profileWarning: scheduledPolicy.failClosedReason,
      };
    }
    const run = await this.enqueueAutonomousChatTurn({
      sessionId,
      prompt: input.config.prompt,
      runId: input.runId,
      systemActorId,
      reason: `cron agent_turn:${input.job.jobId}`,
      deliveryChannel: input.config.deliveryChannel,
      deliverMode: input.config.deliverMode ?? "always",
      policyContext: scheduledPolicy.policyContext,
      profilePosture: scheduledPolicy.profilePosture,
    });
    return {
      mode: "agent_turn",
      durableRunId: run?.runId,
      sessionId,
      turnId: run?.turnId,
      profilePosture: scheduledPolicy.profilePosture,
    };
  }

  /**
   * Maintenance-tick commitment sweep (P1-F3). Delivers due + pending inferred
   * check-ins (oldest-due first) as autonomous (restricted-profile) turns seeded
   * with the suggested text, respecting per-session cooldown + active-hours, then
   * marks them delivery-pending. No-op while the master autonomy switch is off
   * or durable execution is disabled (the delivery path requires a durable run).
   * Superseded / dismissed / already-queued rows are excluded by `listDue`
   * (pending-only).
   */
  private async runCommitmentSweep(): Promise<void> {
    if (this.isFeatureEnabled("autonomyV1Disabled") || !this.isFeatureEnabled("durableKernelV1Enabled")) {
      return;
    }
    await runCommitmentSweep({
      isAutonomyEnabled: () => !this.isFeatureEnabled("autonomyV1Disabled"),
      listDueCommitments: (nowIso, limit) => this.storage.agentCommitments.listDue(nowIso, limit),
      getSessionAutonomyPrefs: (sessionId) => this.getSessionAutonomyPrefs(sessionId),
      deliverCommitment: async (commitment) => {
        const deliveryChannel = this.resolveCommitmentDeliveryChannel(commitment.sessionId);
        if (!deliveryChannel) {
          return false;
        }
        const run = await this.enqueueAutonomousChatTurn({
          sessionId: commitment.sessionId,
          prompt: buildCommitmentCheckInPrompt(commitment.suggestedText),
          runId: `commitment_${commitment.commitmentId}`,
          systemActorId: "system-commitment",
          reason: `commitment check-in:${commitment.commitmentId}`,
          deliveryChannel,
          deliverMode: "always",
          commitmentId: commitment.commitmentId,
        });
        return Boolean(run?.runId);
      },
      markDeliveryPending: (commitmentId) => this.storage.agentCommitments.markDeliveryPending(commitmentId),
      markDeliveryFailed: (commitmentId) => this.storage.agentCommitments.markDeliveryFailed(commitmentId),
    });
  }

  private resolveCommitmentDeliveryChannel(sessionId: string): CronAgentTurnConfig["deliveryChannel"] | undefined {
    const binding = this.storage.chatSessionBindings.get(sessionId);
    if (
      !binding ||
      binding.transport !== "integration" ||
      !binding.writable ||
      !binding.connectionId ||
      !binding.target
    ) {
      return undefined;
    }
    const connector = this.listConnectorRecords("integration_connection").find(
      (item) => item.status === "active" && item.sourceId === binding.connectionId,
    );
    const channelKey = typeof connector?.metadata?.key === "string" ? connector.metadata.key.trim() : "";
    const target = binding.target.trim();
    if (!channelKey || !target) {
      return undefined;
    }
    return { channelKey, target };
  }

  /**
   * Maintenance-tick heartbeat sweep (P1-F4). For each eligible idle session,
   * fires a single silent self-wake turn under the read-only `heartbeat-restricted`
   * profile with `deliverMode:"on_notify"` — the turn stays silent unless it emits
   * `{notify:true}`. Multi-gate rate limiting (heartbeat-enabled × eligibility ×
   * active-hours × idle floor × no-running-turn × cooldown × interval) lives in the
   * pure `runHeartbeatTick`. No-op while the master autonomy switch is off or
   * durable execution is disabled (the turn path requires a durable run).
   * Eval-integrity / non-human / replay-scratch sessions are excluded.
   */
  private async runHeartbeatSweep(): Promise<void> {
    if (this.isFeatureEnabled("autonomyV1Disabled") || !this.isFeatureEnabled("durableKernelV1Enabled")) {
      return;
    }
    await runHeartbeatTick({
      isAutonomyEnabled: () => !this.isFeatureEnabled("autonomyV1Disabled"),
      listSessions: (limit) =>
        this.listChatSessions({ scope: "mission", view: "active", limit }).map((session) => ({
          sessionId: session.sessionId,
          lastActivityAt: session.lastActivityAt,
        })),
      getSessionAutonomyPrefs: (sessionId) => this.getSessionAutonomyPrefs(sessionId),
      isHeartbeatEligibleSession: (sessionId) => this.isHeartbeatEligibleSession(sessionId),
      getSessionIdleSeconds: (sessionId) => this.getSessionIdleSeconds(sessionId),
      hasRunningTurn: (sessionId) => this.hasRunningTurn(sessionId),
      enqueueHeartbeatTurn: async ({ sessionId, prompt }) => {
        const run = await this.enqueueAutonomousChatTurn({
          sessionId,
          prompt,
          // Collision-resistant: `Date.now()` could repeat within a tick across
          // sessions/retries; a UUID guarantees a unique durable run id.
          runId: `heartbeat_${randomUUID()}`,
          systemActorId: "system-heartbeat",
          reason: `heartbeat self-wake:${sessionId}`,
          kind: "heartbeat",
          deliverMode: "on_notify",
        });
        return Boolean(run?.runId);
      },
    });
  }

  /**
   * Best-effort logging for autonomous maintenance sweeps (commitment / heartbeat).
   * These are optional proactive tasks; a failure must never crash the maintenance
   * tick, which aggregates and rethrows core task failures.
   */
  private logMaintenanceTaskFailure(event: string, error: unknown): void {
    this.recordDevDiagnostic({
      level: "warn",
      category: "cron",
      event,
      message: event.replace(/_/g, " "),
      context: { error: error instanceof Error ? error.message : String(error) },
    });
  }

  /**
   * Runs an optional/best-effort autonomous maintenance task so it can never
   * crash the maintenance tick (which aggregates and rethrows core task
   * failures). Catches BOTH synchronous throws (e.g. a missing collaborator
   * method) and async rejections, logging a dev diagnostic instead.
   */
  private async runBestEffortMaintenance(event: string, run: () => Promise<unknown> | unknown): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logMaintenanceTaskFailure(event, error);
    }
  }

  /**
   * Whether a session may receive silent heartbeats. Mirrors the human-session /
   * eval-integrity guard used for the commitment classifier: skip `system` and
   * `prompt_pack` origins and replay-scratch sessions (safety invariant:
   * eval-integrity turns are never affected).
   */
  private isHeartbeatEligibleSession(sessionId: string): boolean {
    const origin = this.storage.chatSessionMeta.get(sessionId)?.origin;
    if (origin === "system" || origin === "prompt_pack") {
      return false;
    }
    return !this.isReplayScratchSession(sessionId);
  }

  /**
   * Resolve a stable cron session for an `agent_turn` job. Reuses an explicitly
   * configured session id when present, otherwise derives a deterministic
   * per-job session and creates it (proactiveMode off, system origin) if it does
   * not yet exist. Immutable: reuses existing rows; only creates when missing.
   */
  private ensureCronAgentSession(jobId: string, configuredSessionId?: string): string {
    const explicit = configuredSessionId?.trim();
    if (explicit && this.getSession(explicit)) {
      return explicit;
    }
    const peer = `cron_${createHash("sha256").update(jobId).digest("hex").slice(0, 12)}`;
    const sessionKey = `mission:scheduler:${peer}`;
    const sessionId = `sess_${createHash("sha256").update(sessionKey).digest("hex").slice(0, 24)}`;
    if (this.getSession(sessionId)) {
      return sessionId;
    }
    const now = new Date().toISOString();
    const workspaceId = this.normalizeWorkspaceId(undefined);
    this.storage.runImmediateTransaction(() => {
      this.storage.sessions.upsert({
        sessionId,
        sessionKey,
        kind: "dm",
        channel: "mission",
        account: "scheduler",
        displayName: `Cron ${jobId}`,
        timestamp: now,
      });
      this.storage.chatSessionMeta.ensure(sessionId, now, workspaceId);
      this.storage.chatSessionPrefs.ensure(sessionId, now);
      this.storage.chatSessionMeta.patch(
        sessionId,
        { workspaceId, title: `Cron ${jobId}`, origin: "system", includeInHistory: false },
        now,
      );
      this.storage.chatSessionBindings.upsert({ sessionId, workspaceId, transport: "llm", writable: true }, now);
    });
    this.ensureChatSessionRuntimeGrants(sessionId);
    this.patchSessionAutonomyPrefs(sessionId, { proactiveMode: "off" });
    return sessionId;
  }

  private resolveScheduledAgentTurnPolicy(input: {
    config: CronAgentTurnConfig;
    jobId: string;
    runId: string;
    sessionId: string;
    systemActorId: string;
  }):
    | { policyContext: ToolPolicyActorContext; profilePosture: "scheduled_restricted" | "creator_intersection" }
    | {
        profilePosture:
          | "creator_profile_missing"
          | "creator_profile_archived"
          | "creator_profile_scope_mismatch"
          | "creator_profile_invalid";
        failClosedReason: string;
      } {
    const base = buildAutonomousTurnContext({
      kind: "scheduled",
      systemActorId: input.systemActorId,
      runId: input.runId,
      sessionId: input.sessionId,
    });
    const createdBy = input.config.createdBy;
    if (!createdBy) {
      return { policyContext: base.policyContext, profilePosture: "scheduled_restricted" };
    }
    const creatorProfileId = createdBy.permissionProfileId?.trim();
    if (!creatorProfileId) {
      return {
        profilePosture: "creator_profile_missing",
        failClosedReason: `Scheduled agent_turn ${input.jobId} was created by a model/tool call without permission profile provenance.`,
      };
    }

    const workspaceId = this.storage.chatSessionMeta.get(input.sessionId)?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    let creatorProfile: PermissionProfileRecord;
    try {
      creatorProfile = this.storage.permissionProfiles.getProfile(creatorProfileId);
    } catch (error) {
      return {
        profilePosture: "creator_profile_missing",
        failClosedReason: `Scheduled agent_turn ${input.jobId} creator profile ${creatorProfileId} is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (creatorProfile.status !== "active") {
      return {
        profilePosture: "creator_profile_archived",
        failClosedReason: `Scheduled agent_turn ${input.jobId} creator profile ${creatorProfileId} is not active.`,
      };
    }
    const creatorActorId = createdBy.operatorId?.trim() || createdBy.authActorId?.trim();
    if (!permissionProfileAppliesToCreator({ profile: creatorProfile, creatorActorId, workspaceId })) {
      return {
        profilePosture: "creator_profile_scope_mismatch",
        failClosedReason: `Scheduled agent_turn ${input.jobId} creator profile ${creatorProfileId} is no longer active for the creator/workspace scope.`,
      };
    }

    const profile = buildScheduledCreatorIntersectionProfile({
      creatorProfile,
      runId: input.runId,
      knownToolNames: this.listToolCatalog().map((tool) => tool.toolName),
    });
    return {
      profilePosture: "creator_intersection",
      policyContext: {
        ...base.policyContext,
        permissionProfileId: profile.profileId,
        permissionProfile: profile,
        workspaceId,
      },
    };
  }

  private registerSyntheticPermissionProfile(profile: PermissionProfileRecord): void {
    if (!profile.profileId.startsWith("scheduled-intersection:")) {
      return;
    }
    const syntheticProfiles = this.getSyntheticPermissionProfileMap();
    if (!syntheticProfiles) {
      return;
    }
    this.pruneSyntheticPermissionProfiles();
    syntheticProfiles.set(profile.profileId, profile);
  }

  private pruneSyntheticPermissionProfiles(nowMs = Date.now()): void {
    const syntheticProfiles = this.getSyntheticPermissionProfileMap();
    if (!syntheticProfiles) {
      return;
    }
    for (const [profileId, profile] of syntheticProfiles.entries()) {
      const updatedAtMs = Date.parse(profile.updatedAt || profile.createdAt);
      if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs > SYNTHETIC_PERMISSION_PROFILE_TTL_MS) {
        syntheticProfiles.delete(profileId);
      }
    }
    if (syntheticProfiles.size <= SYNTHETIC_PERMISSION_PROFILE_MAX_ENTRIES) {
      return;
    }
    const entries = [...syntheticProfiles.entries()].sort(
      ([, left], [, right]) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
    );
    for (const [profileId] of entries.slice(
      0,
      Math.max(0, entries.length - SYNTHETIC_PERMISSION_PROFILE_MAX_ENTRIES),
    )) {
      syntheticProfiles.delete(profileId);
    }
  }

  private getSyntheticPermissionProfileMap(): Map<string, PermissionProfileRecord> | undefined {
    return this.syntheticPermissionProfiles instanceof Map ? this.syntheticPermissionProfiles : undefined;
  }

  /**
   * Prepare + enqueue a `chat.turn.execute` durable run for an autonomous
   * (cron/heartbeat/proactive) turn. Persists the user message + trace via
   * `prepareAgentChatTurn` (the durable payload's precondition), then creates
   * the durable run tagged with `metadata.autonomous` so the post-turn delivery
   * hook in `durable-execution-service.ts` can route the reply to a channel.
   */
  private async enqueueAutonomousChatTurn(input: {
    sessionId: string;
    prompt: string;
    runId: string;
    systemActorId: string;
    reason: string;
    /** Restricted profile selector; defaults to `scheduled` (cron/commitment). */
    kind?: AutonomousTurnKind;
    deliveryChannel?: CronAgentTurnConfig["deliveryChannel"];
    deliverMode: NonNullable<CronAgentTurnConfig["deliverMode"]>;
    policyContext?: ToolPolicyActorContext;
    profilePosture?: AgentTurnCronRunOutcome["profilePosture"];
    commitmentId?: string;
  }): Promise<{ runId: string; turnId: string } | undefined> {
    if (!this.isFeatureEnabled("durableKernelV1Enabled")) {
      throw new Error("agent_turn cron execution requires durable execution (durableKernelV1Enabled).");
    }
    if (this.isFeatureEnabled("autonomyV1Disabled")) {
      throw new Error("Autonomous chat turn execution is disabled while the autonomy kill switch is engaged.");
    }
    const kind: AutonomousTurnKind = input.kind ?? "scheduled";
    const permissionProfileId =
      kind === "heartbeat" ? HEARTBEAT_PERMISSION_PROFILE_ID : SCHEDULED_TURN_PERMISSION_PROFILE_ID;
    const autonomousContext = buildAutonomousTurnContext({
      kind,
      systemActorId: input.systemActorId,
      runId: input.runId,
      sessionId: input.sessionId,
    });
    const policyContext = input.policyContext ?? autonomousContext.policyContext;
    const request: ChatSendMessageRequest & { policyContext?: ToolPolicyActorContext } = {
      content: input.prompt,
      operatorId: autonomousContext.policyContext.operatorId,
      authActorId: autonomousContext.policyContext.authActorId,
      authActorSource: autonomousContext.policyContext.authActorSource,
      permissionProfileId,
      policyContext,
    };
    const prepared = await this.prepareAgentChatTurn(input.sessionId, request, { ingestUserMessage: true });
    const run = this.createDurableRun({
      workflowKey: "chat.turn.execute",
      payload: durableChatTurnPayloadToRecord(
        this.createDurableChatTurnPayload(prepared, request, "chat_thread_turn_appended"),
      ),
      metadata: {
        surface: chatTurnPrepService.resolvePreparedTurnMode(prepared),
        objective: prepared.content,
        autonomous: {
          kind,
          systemActorId: input.systemActorId,
          reason: input.reason,
          deliverMode: input.deliverMode,
          ...(input.deliveryChannel ? { deliveryChannel: input.deliveryChannel } : {}),
          ...(input.profilePosture ? { profilePosture: input.profilePosture } : {}),
          ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
        },
      },
    });
    if (policyContext.permissionProfile && policyContext.permissionProfileId) {
      this.registerSyntheticPermissionProfile(policyContext.permissionProfile);
    }
    this.persistInitialDurableChatTurnTrace(prepared, request, run);
    this.persistChatStreamChunk(
      {
        type: "message_start",
        sessionId: prepared.session.sessionId,
        turnId: prepared.turnId,
        messageId: prepared.assistantMessageId,
        parentTurnId: prepared.parentTurnId,
        branchKind: prepared.branchKind,
        sourceTurnId: prepared.sourceTurnId,
      },
      run.runId,
    );
    this.requestDurableRunProcessing(run.runId);
    return { runId: run.runId, turnId: prepared.turnId };
  }

  /**
   * Runtime-hook impl for the model-callable `schedule.manage` tool (P1-F2).
   *
   * Routed here by the policy-engine executor (`scheduleManage` hook) *after* the
   * engine has authorized the call — `schedule.manage` is `danger` +
   * `requiresApproval`, so the normal approval gate fires first for interactive
   * operators, and the restricted `scheduled-restricted` profile makes a
   * scheduled turn's call require approval too (anti-recursion). This method:
   *  - maps `op` to the existing `cronAutomationService` create/list/delete,
   *  - forces `action:"agent_turn"` for created jobs,
   *  - stamps the creator actor + permission profile from `policyContext` onto the
   *    job for ownership, anti-recursion, and audit while fired turns stay on the
   *    restricted scheduled profile, and
   *  - enforces the per-creator cap, the >=15min interval floor, and the depth-1
   *    chain cap (all in the pure `schedule-tool-support` validator).
   *
   * The master autonomy kill switch (`autonomyV1Disabled`) hard-disables the
   * whole tool so no schedule can be created/listed/cancelled while autonomy is
   * halted.
   */
  private async scheduleManage(
    args: Record<string, unknown>,
    policyContext: ToolPolicyActorContext | undefined,
  ): Promise<Record<string, unknown>> {
    if (this.isFeatureEnabled("autonomyV1Disabled")) {
      throw new Error("schedule.manage is disabled while the autonomy kill switch is engaged (autonomyV1Disabled).");
    }
    const parsed = parseScheduleManageArgs(args);
    if (parsed.op === "list") {
      const creatorKey = resolveScheduleCreatorKey(policyContext);
      const jobs = this.cronAutomationService
        .listCronJobs()
        .filter((job) => job.action === "agent_turn")
        .filter((job) => {
          if (!creatorKey) {
            return false;
          }
          const createdBy = job.actionConfig?.agentTurn?.createdBy;
          return createdBy?.operatorId === creatorKey || createdBy?.authActorId === creatorKey;
        })
        .map((job) => summarizeScheduleJob(job));
      return { op: "list", count: jobs.length, jobs };
    }
    if (parsed.op === "cancel") {
      const jobId = parsed.jobId?.trim();
      if (!jobId) {
        throw new Error('schedule.manage cancel requires a "jobId".');
      }
      const creatorKey = resolveScheduleCreatorKey(policyContext);
      const existing = this.cronAutomationService.getCronJob(jobId);
      if (existing.action !== "agent_turn") {
        throw new Error(`schedule.manage cancel refused: ${jobId} is not an agent_turn schedule.`);
      }
      const createdBy = existing.actionConfig?.agentTurn?.createdBy;
      const owned = !!creatorKey && (createdBy?.operatorId === creatorKey || createdBy?.authActorId === creatorKey);
      if (!owned) {
        throw new Error(`schedule.manage cancel refused: ${jobId} is not owned by the caller.`);
      }
      const result = this.cronAutomationService.deleteCronJob(jobId);
      return { op: "cancel", jobId: result.jobId, deleted: result.deleted };
    }
    // op === "create"
    const createdByJobId = this.resolveSchedulingTurnJobId(policyContext);
    const validated = validateScheduleCreate({
      args: parsed,
      policyContext,
      existingJobs: this.cronAutomationService.listCronJobs(),
      ...(createdByJobId ? { createdByJobId } : {}),
    });
    const jobId = this.generateScheduleJobId(validated.name);
    const created = this.cronAutomationService.createCronJob({
      jobId,
      name: validated.name,
      action: "agent_turn",
      schedule: validated.schedule,
      ...(validated.endAt ? { endAt: validated.endAt } : {}),
      actionConfig: buildScheduleCreateActionConfig(validated),
    });
    return {
      op: "create",
      jobId: created.jobId,
      name: created.name,
      schedule: created.schedule,
      enabled: created.enabled,
      ...(created.nextRunAt ? { nextRunAt: created.nextRunAt } : {}),
      requiresApprovalToRun: false,
      createdBy: validated.createdBy,
    };
  }

  /**
   * Best-effort: when the calling turn is itself a scheduled (restricted) turn,
   * find the cron `agent_turn` job that owns the caller's session so the new job
   * records its parent for the anti-recursion chain. Returns undefined for
   * interactive callers (depth 0).
   */
  private resolveSchedulingTurnJobId(policyContext: ToolPolicyActorContext | undefined): string | undefined {
    if (!isScheduledTurnContext(policyContext) || !policyContext?.sessionId) {
      return undefined;
    }
    const sessionId = policyContext.sessionId;
    const match = this.cronAutomationService
      .listCronJobs()
      .find((job) => job.action === "agent_turn" && job.actionConfig?.agentTurn?.sessionId === sessionId);
    return match?.jobId;
  }

  /**
   * Generate a unique cron job id from a human name plus a short random suffix.
   * Conforms to the cron id rules (`^[a-z0-9][a-z0-9_-]{2,63}$`) and retries on
   * the (vanishingly rare) collision so a model-created schedule never clobbers
   * an existing job.
   */
  private generateScheduleJobId(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const slug = base.length >= 3 ? base : "scheduled-turn";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
      const candidate = `${slug}-${suffix}`.slice(0, 64);
      try {
        this.cronAutomationService.getCronJob(candidate);
      } catch {
        return candidate;
      }
    }
    throw new Error("schedule.manage create: could not allocate a unique job id; please retry.");
  }

  public beginDurableChatRun(
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
        persistInitialTrace: (preparedTurn, request, run) =>
          this.persistInitialDurableChatTurnTrace(preparedTurn, request, run),
        requestDurableRunProcessing: (runId) => this.durableRunService.requestRunProcessing(runId),
      },
      prepared,
      input,
      threadEventType,
    );
  }

  private persistInitialDurableChatTurnTrace(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    input: ChatSendMessageRequest,
    run: DurableRunRecord,
  ): void {
    try {
      this.storage.chatTurnTraces.get(prepared.turnId);
      return;
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }
    this.storage.chatTurnTraces.create({
      turnId: prepared.turnId,
      sessionId: prepared.session.sessionId,
      userMessageId: prepared.userEventId,
      parentTurnId: prepared.parentTurnId,
      branchKind: prepared.branchKind,
      sourceTurnId: prepared.sourceTurnId,
      status: "running",
      mode: chatTurnPrepService.resolvePreparedTurnMode(prepared),
      model: input.model ?? prepared.prefs.model,
      webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
      memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
      thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
      speedMode: prepared.normalized.speedMode ?? prepared.prefs.speedMode,
      subagentPolicy: prepared.normalized.subagentPolicy ?? prepared.prefs.subagentPolicy,
      effectiveToolAutonomy: prepared.effectiveToolAutonomy,
      routing: {
        primaryProviderId: input.providerId ?? prepared.prefs.providerId,
        primaryModel: input.model ?? prepared.prefs.model,
        effectiveProviderId: input.providerId ?? prepared.prefs.providerId,
        effectiveModel: input.model ?? prepared.prefs.model,
        modelRouter: prepared.modelRouterDecision,
      },
      durable: {
        runId: run.runId,
        status: run.status,
      },
    });
  }

  public finalizeDurableChatRun(
    runId: string,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    trace: ChatTurnTraceRecord,
  ): void {
    chatDurableRunService.finalizeDurableChatRun(
      {
        durableRuns: this.storage.durableRuns,
        chatToolRuns: this.storage.chatToolRuns,
        chatToolArtifacts: this.storage.chatToolArtifacts,
        chatMessages: this.storage.chatMessages,
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

  private async sendPreparedIntegrationChatTurn(
    sessionId: string,
    input: Partial<ChatSendMessageRequest>,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    binding: ChatSessionBindingRecord,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  ): Promise<ChatSendMessageResponse> {
    return chatTurnDispatchService.sendPreparedIntegrationChatTurn(
      this,
      sessionId,
      input,
      prepared,
      binding,
      threadEventType,
    );
  }

  private async *streamPreparedIntegrationChatTurn(
    sessionId: string,
    input: Partial<ChatSendMessageRequest>,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    binding: ChatSessionBindingRecord,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  ): AsyncGenerator<ChatStreamChunkDraft> {
    yield* chatTurnDispatchService.streamPreparedIntegrationChatTurn(
      this,
      sessionId,
      input,
      prepared,
      binding,
      threadEventType,
    );
  }

  private getChatAttachment(attachmentId: string): ChatAttachmentRecord {
    return chatAttachmentService.getChatAttachment(this.buildChatAttachmentHost(), attachmentId);
  }

  private async readChatAttachmentContent(attachmentId: string): Promise<{
    record: ChatAttachmentRecord;
    fullPath: string;
    bytes: Buffer;
  }> {
    return chatAttachmentService.readChatAttachmentContent(this.buildChatAttachmentHost(), attachmentId);
  }

  private buildChatAttachmentHost(): chatAttachmentService.ChatAttachmentHost {
    return {
      config: this.config,
      storage: this.storage,
      getSession: (sessionId) => this.getSession(sessionId),
      normalizeWorkspaceId: (workspaceId) => this.normalizeWorkspaceId(workspaceId),
      publishRealtime: (eventType, source, payload) => this.publishRealtime(eventType, source, payload),
      createMediaJob: (input) => this.mediaVoiceService.createMediaJob(input),
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

  public async invokeTool(request: ToolInvokeRequest): Promise<ToolInvokeResult> {
    return this.toolInvocationCoordinator.invokeTool(request);
  }

  private recordApprovedExternalRuntimeToolResult(
    approvalId: string,
    request: ToolInvokeRequest,
    result: ToolInvokeResult,
  ): void {
    const pending = this.storage.pendingApprovalActions.find(approvalId);
    if (
      !isApprovedExternalRuntimePendingAction(pending) ||
      !approvedExternalRuntimeRequestMatches(pending.request, request)
    ) {
      return;
    }
    this.storage.pendingApprovalActions.markResolved(
      approvalId,
      result.outcome === "executed" ? "executed" : "failed",
      toolInvokeResultRecord(result),
    );
    this.storage.approvalEvents.append({
      approvalId,
      eventType: "approved_action_executed",
      actorId: "system",
      payload: {
        toolName: request.toolName,
        outcome: result.outcome,
        policyReason: result.policyReason,
        auditEventId: result.auditEventId,
        externalRuntime: true,
      },
    });
  }

  private async executeApprovedPendingAction(
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<ToolInvokeResult | undefined> {
    try {
      this.refreshApprovedPendingToolPolicyContext(approvalId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Approved action policy context could not be refreshed.";
      this.storage.pendingApprovalActions.markResolved(approvalId, "failed", { reason });
      this.storage.approvalEvents.append({
        approvalId,
        eventType: "approved_action_executed",
        actorId: "system",
        payload: { outcome: "blocked", reason },
      });
      return undefined;
    }
    const pending = this.storage.pendingApprovalActions.find(approvalId);
    if (isApprovedExternalRuntimePendingAction(pending)) {
      return this.executeApprovedExternalRuntimePendingAction(approvalId, pending, signal);
    }
    return this.policyEngine.executeApprovedAction(approvalId, signal);
  }

  private async executeApprovedExternalRuntimePendingAction(
    approvalId: string,
    pending: PendingApprovalAction,
    signal?: AbortSignal,
  ): Promise<ToolInvokeResult | undefined> {
    const policyResult = await this.policyEngine.executeApprovedAction(approvalId, signal, {
      deferResolution: true,
      externalRuntimeReplay: true,
    });
    if (!policyResult || policyResult.outcome !== "executed") {
      return policyResult;
    }

    const request = withExternalRuntimePolicyContext(toToolInvokeRequest(pending.request, signal), policyResult);
    let runtimeResult: ToolInvokeResult;
    if (request.toolName === "mcp.invoke") {
      const mcpResult = await this.toolInvocationCoordinator.invokeApprovedMcpRuntime(
        this.enrichMcpInvokePolicyContext(toApprovedMcpInvokeRequest(request, signal)),
      );
      runtimeResult = toolInvokeResultFromMcpApproval(policyResult, mcpResult);
    } else {
      runtimeResult = await this.toolInvocationCoordinator.invokeApprovedExternalRuntimeTool(request);
    }

    this.storage.pendingApprovalActions.markResolved(
      approvalId,
      runtimeResult.outcome === "executed" ? "executed" : "failed",
      toolInvokeResultRecord(runtimeResult),
    );
    this.storage.approvalEvents.append({
      approvalId,
      eventType: "approved_action_executed",
      actorId: "system",
      payload: {
        toolName: request.toolName,
        outcome: runtimeResult.outcome,
        policyReason: runtimeResult.policyReason,
        auditEventId: runtimeResult.auditEventId,
        externalRuntime: true,
      },
    });
    return runtimeResult;
  }

  private refreshApprovedPendingToolPolicyContext(approvalId: string): void {
    const pending = this.storage.pendingApprovalActions.find(approvalId);
    if (!pending || pending.actionType !== "tool.invoke" || pending.resolutionStatus !== "pending") {
      return;
    }
    const request = pending.request;
    const existing = isRecord(request.policyContext) ? request.policyContext : {};
    const sessionId = readRecordString(request, "sessionId");
    const workspaceId =
      readRecordString(request, "workspaceId") ??
      readRecordString(existing, "workspaceId") ??
      (sessionId ? this.storage.chatSessionMeta.get(sessionId)?.workspaceId : undefined) ??
      DEFAULT_WORKSPACE_ID;
    const consentContext = isRecord(request.consentContext) ? request.consentContext : {};
    const operatorId =
      readRecordString(existing, "operatorId") ??
      readRecordString(consentContext, "operatorId") ??
      readRecordString(existing, "authActorId") ??
      "system";
    const resolved = this.resolveToolPolicyContext({
      operatorId,
      authActorId: readRecordString(existing, "authActorId"),
      authActorSource: readAuthActorSource(existing.authActorSource),
      workspaceId,
      sessionId,
      taskId: readRecordString(request, "taskId") ?? readRecordString(existing, "taskId"),
      runId: readRecordString(request, "runId") ?? readRecordString(existing, "runId"),
      surface: readPermissionSurfaceValue(request.surface ?? existing.surface),
      permissionProfileId:
        readRecordString(request, "permissionProfileId") ?? readRecordString(existing, "permissionProfileId"),
      localOperatorOverrideId:
        readRecordString(request, "localOperatorOverrideId") ?? readRecordString(existing, "localOperatorOverrideId"),
    });
    this.storage.pendingApprovalActions.upsertPending({
      approvalId,
      actionType: pending.actionType,
      request: {
        ...request,
        workspaceId,
        policyContext: resolved,
      },
      createdAt: pending.createdAt,
      expiresAt: pending.expiresAt,
    });
  }

  private resolveToolInvokeRequestPaths(request: ToolInvokeRequest): ToolInvokeRequest {
    return this.resolveToolRequestPathsForSession(request);
  }

  private resolveToolRequestPathsForSession<TRequest extends ToolInvokeRequest | ToolAccessEvaluateRequest>(
    request: TRequest,
  ): TRequest {
    const rootDir =
      typeof this.config.rootDir === "string" && this.config.rootDir.trim() ? this.config.rootDir : process.cwd();
    const workspaceDir =
      typeof this.config.assistant.workspaceDir === "string" && this.config.assistant.workspaceDir.trim()
        ? this.config.assistant.workspaceDir
        : "workspace";
    const workspaceRoot = path.resolve(rootDir, workspaceDir);
    const chatSessionProjects = this.storage.chatSessionProjects as
      | { get?: (sessionId: string) => { projectId?: string } | undefined }
      | undefined;
    const chatProjects = this.storage.chatProjects as
      | { get?: (projectId: string) => { workspacePath?: string } | undefined }
      | undefined;
    const projectId = chatSessionProjects?.get?.(request.sessionId)?.projectId;
    const project = projectId ? chatProjects?.get?.(projectId) : undefined;
    const projectRoot = resolveProjectRootForToolContext({
      workspaceRoot,
      repoRoot: rootDir,
      projectWorkspacePath: project?.workspacePath,
    });
    return resolveToolRequestPathsForContext(request, {
      workspaceRoot,
      projectRoot,
      projectWorkspacePath: project?.workspacePath,
    });
  }

  private applyRuntimeBrowserBackendDefaults<TRequest extends ToolInvokeRequest | ToolAccessEvaluateRequest>(
    request: TRequest,
  ): TRequest {
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
      const hasExplicitDocsBackend = args.backend !== undefined && args.backend !== null;
      if (!hasExplicitDocsBackend && firecrawl.enabled && firecrawl.defaultReadBackend === "firecrawl") {
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
    const workspaceId = this.normalizeWorkspaceId(
      input.workspaceId ?? this.storage.chatSessionMeta.get(input.sessionId)?.workspaceId ?? DEFAULT_WORKSPACE_ID,
    );
    const citadelId = input.citadelId ?? this.storage.workspaces?.find(workspaceId)?.citadelId;
    return this.policyEngine.evaluateAccess(
      this.enrichToolPolicyContext(
        this.applyRuntimeBrowserBackendDefaults(
          this.resolveToolRequestPathsForSession({
            ...input,
            workspaceId,
            citadelId,
          }),
        ),
      ),
    );
  }

  private enrichToolPolicyContext<TRequest extends ToolInvokeRequest | ToolAccessEvaluateRequest>(
    input: TRequest,
  ): TRequest {
    const workspaceId =
      input.workspaceId ?? this.storage.chatSessionMeta.get(input.sessionId)?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const existing = input.policyContext;
    if (existing?.permissionProfile) {
      this.assertResolvedToolPolicyContextAllowed(existing);
      return {
        ...input,
        workspaceId,
        policyContext: {
          ...existing,
          workspaceId,
          sessionId: input.sessionId,
          taskId: input.taskId ?? existing.taskId,
          runId: input.runId ?? existing.runId,
        },
      };
    }
    const operatorId =
      existing?.operatorId ??
      ("consentContext" in input ? input.consentContext?.operatorId : undefined) ??
      existing?.authActorId ??
      "system";
    const resolved = this.resolveToolPolicyContext({
      operatorId,
      authActorId: existing?.authActorId,
      authActorSource: existing?.authActorSource,
      workspaceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      surface: existing?.surface ?? input.surface,
      permissionProfileId: existing?.permissionProfileId ?? input.permissionProfileId,
      localOperatorOverrideId: existing?.localOperatorOverrideId ?? input.localOperatorOverrideId,
    });
    return {
      ...input,
      workspaceId,
      policyContext: resolved,
    };
  }

  public resolveToolPolicyContext(input: {
    operatorId?: string;
    authActorId?: string;
    authActorSource?: ToolPolicyActorContext["authActorSource"];
    workspaceId?: string;
    sessionId?: string;
    taskId?: string;
    runId?: string;
    surface?: PermissionSurface;
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
  }): ToolPolicyActorContext {
    if (this.config.assistant.deploymentProfile === "remote_hardened" && input.localOperatorOverrideId) {
      throw new ConflictError({
        message: "Local Operator Override is unavailable in remote_hardened deployment profile.",
      });
    }
    this.pruneSyntheticPermissionProfiles();
    const requestedPermissionProfileId = this.resolveCallerSelectablePermissionProfileId(input);
    const syntheticProfiles = this.getSyntheticPermissionProfileMap();
    const syntheticPermissionProfile = requestedPermissionProfileId
      ? syntheticProfiles?.get(requestedPermissionProfileId)
      : undefined;
    if (requestedPermissionProfileId?.startsWith("scheduled-intersection:") && !syntheticPermissionProfile) {
      throw new ConflictError({
        message: `Non-persisted permission profile ${requestedPermissionProfileId} is unavailable for this runtime.`,
      });
    }
    // Default permission profile for sessions with no explicit profile/activation.
    // A local-first operator who configured `approvalMode: "bypass"` should not be
    // silently forced onto the restrictive builtin "safe" (approve_all) default,
    // which gates every otherwise-allowed tool and degrades cowork/code turns (the
    // model packs its answer into a gated call → hard degrade). On any non-hardened
    // deployment with a bypass config, honor that intent by defaulting to
    // "trusted_local_power" (bypass). remote_hardened always stays on "safe" (the
    // bypass guard below additionally enforces this). Explicit profileId/activation
    // still win — this only changes the otherwise-"safe" fallback.
    const defaultPermissionProfileId =
      this.config.assistant.deploymentProfile !== "remote_hardened" &&
      this.config.toolPolicy?.tools?.approvalMode === "bypass"
        ? "trusted_local_power"
        : "safe";
    const resolved = syntheticPermissionProfile
      ? { permissionProfile: syntheticPermissionProfile, localOperatorOverride: undefined }
      : this.storage.permissionProfiles.resolveContext({
          operatorId: input.operatorId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          surface: input.surface,
          profileId: requestedPermissionProfileId,
          overrideId: input.localOperatorOverrideId,
          disableLocalOperatorOverrides: this.config.assistant.deploymentProfile === "remote_hardened",
          defaultProfileId: defaultPermissionProfileId,
        });
    if (
      this.config.assistant.deploymentProfile === "remote_hardened" &&
      resolved.permissionProfile.approvalMode === "bypass"
    ) {
      throw new ConflictError({
        message: "Bypass permission profiles are unavailable in remote_hardened deployment profile.",
      });
    }
    return {
      operatorId: input.operatorId,
      authActorId: input.authActorId,
      authActorSource: input.authActorSource,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      surface: input.surface,
      permissionProfileId: resolved.permissionProfile.profileId,
      permissionProfile: resolved.permissionProfile,
      localOperatorOverrideId: resolved.localOperatorOverride?.overrideId,
      localOperatorOverride: resolved.localOperatorOverride,
    };
  }

  private resolveCallerSelectablePermissionProfileId(input: {
    operatorId?: string;
    authActorId?: string;
    authActorSource?: ToolPolicyActorContext["authActorSource"];
    workspaceId?: string;
    permissionProfileId?: string;
  }): string | undefined {
    const profileId = input.permissionProfileId?.trim();
    if (!profileId) {
      return undefined;
    }
    if (profileId === "safe") {
      return profileId;
    }
    if (profileId === "trusted_local_power" && this.config.assistant.deploymentProfile === "remote_hardened") {
      return profileId;
    }
    const synthetic = this.getSyntheticPermissionProfileMap()?.get(profileId);
    const readProfile = this.storage.permissionProfiles.getProfile;
    const profile =
      synthetic ??
      (typeof readProfile === "function" ? readProfile.call(this.storage.permissionProfiles, profileId) : undefined);
    if (!profile) {
      throw new ConflictError({
        message: `Permission profile ${profileId} is not selectable for the requested operator/workspace scope.`,
      });
    }
    if (isSystemOwnedRestrictedPermissionProfileRequest(profile.profileId, input)) {
      return profileId;
    }
    if (profile.scope === "global") {
      throw new ConflictError({
        message: `Permission profile ${profile.profileId} cannot be selected directly by request.`,
      });
    }
    if (
      profile.scope === "operator" &&
      profile.scopeRef === input.operatorId &&
      profile.createdBy === input.operatorId
    ) {
      return profileId;
    }
    if (
      profile.scope === "workspace" &&
      profile.scopeRef === input.workspaceId &&
      profile.createdBy === input.operatorId
    ) {
      return profileId;
    }
    throw new ConflictError({
      message: `Permission profile ${profile.profileId} is not selectable for the requested operator/workspace scope.`,
    });
  }

  private buildRuntimeExposureSnapshot(): Record<string, unknown> {
    const bindHost = process.env.GATEWAY_HOST ?? "127.0.0.1";
    return {
      deploymentProfile: this.config.assistant.deploymentProfile,
      authMode: this.config.assistant.auth.mode,
      bindHostClass: ["127.0.0.1", "::1", "localhost"].includes(bindHost) ? "loopback" : "non_loopback",
      localInsecureStartupOverrideActive: process.env.GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY === "true",
      allowedOriginCount: this.config.assistant.auth.mode === "none" ? "local_auth_none" : "auth_required",
    };
  }

  public listPermissionProfiles(includeArchived = false): PermissionProfileRecord[] {
    return this.storage.permissionProfiles.listProfiles(includeArchived);
  }

  public createPermissionProfile(input: PermissionProfileCreateInput): PermissionProfileRecord {
    this.assertPermissionProfileApprovalModeAllowed(input.approvalMode);
    const profile = this.storage.permissionProfiles.createProfile(input);
    if (profile.defaultForSurfaces?.length) {
      this.reconcilePermissionProfileDefaultActivations(profile);
    }
    this.publishRealtime("permission_profile_created", "tools", {
      profileId: profile.profileId,
      label: profile.label,
      approvalMode: profile.approvalMode,
      scope: profile.scope,
      scopeRef: profile.scopeRef,
    });
    return profile;
  }

  public updatePermissionProfile(profileId: string, input: PermissionProfileUpdateInput): PermissionProfileRecord {
    const existing = this.storage.permissionProfiles.getProfile(profileId);
    if (!canMutatePermissionProfile(existing, input.updatedBy)) {
      throw new ConflictError({ message: `Permission profile ${profileId} is not editable by this operator.` });
    }
    this.assertPermissionProfileApprovalModeAllowed(input.approvalMode ?? existing.approvalMode);
    const profile = this.storage.permissionProfiles.updateProfile(profileId, input);
    if (input.defaultForSurfaces !== undefined) {
      this.reconcilePermissionProfileDefaultActivations(profile);
    }
    this.publishRealtime("permission_profile_updated", "tools", {
      profileId: profile.profileId,
      label: profile.label,
      approvalMode: profile.approvalMode,
    });
    return profile;
  }

  private reconcilePermissionProfileDefaultActivations(profile: PermissionProfileRecord): void {
    if (profile.scope === "global") {
      return;
    }
    const operatorId = profile.scope === "operator" ? profile.createdBy : undefined;
    const workspaceId = profile.scope === "workspace" ? profile.scopeRef : undefined;
    this.storage.permissionProfiles.deactivateProfileActivations({
      profileId: profile.profileId,
      operatorId,
      workspaceId,
    });
    for (const surface of profile.defaultForSurfaces ?? []) {
      this.storage.permissionProfiles.activateProfile({
        profileId: profile.profileId,
        operatorId,
        workspaceId,
        surface,
        createdBy: profile.createdBy,
      });
    }
  }

  public archivePermissionProfile(profileId: string, archivedBy: string): boolean {
    if (!archivedBy.trim()) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "archivedBy" });
    }
    const existing = this.storage.permissionProfiles.getProfile(profileId);
    if (!canMutatePermissionProfile(existing, archivedBy)) {
      return false;
    }
    const archived = this.storage.permissionProfiles.archiveProfile(profileId);
    if (archived) {
      this.publishRealtime("permission_profile_archived", "tools", { profileId });
    }
    return archived;
  }

  public activatePermissionProfile(input: PermissionProfileActivationInput): PermissionProfileActivationRecord {
    const profile = this.storage.permissionProfiles.getProfile(input.profileId);
    this.assertPermissionProfileApprovalModeAllowed(profile.approvalMode);
    const activation = this.storage.permissionProfiles.activateProfile({
      ...input,
      operatorId: profile.scope === "workspace" ? undefined : input.operatorId,
    });
    this.publishRealtime("permission_profile_activated", "tools", {
      profileId: activation.profileId,
      operatorId: activation.operatorId,
      workspaceId: activation.workspaceId,
      sessionId: activation.sessionId,
      surface: activation.surface,
    });
    return activation;
  }

  public listActiveLocalOperatorOverrides(operatorId?: string): LocalOperatorOverrideRecord[] {
    return this.storage.permissionProfiles
      .listActiveLocalOperatorOverrides()
      .filter((override) => !operatorId || override.operatorId === operatorId);
  }

  public createLocalOperatorOverride(input: LocalOperatorOverrideCreateInput): LocalOperatorOverrideRecord {
    if (this.config.assistant.deploymentProfile === "remote_hardened") {
      throw new ConflictError({
        message: "Local Operator Override is unavailable in remote_hardened deployment profile.",
      });
    }
    const override = this.storage.permissionProfiles.createLocalOperatorOverride(input);
    this.publishRealtime("local_operator_override_started", "tools", {
      overrideId: override.overrideId,
      operatorId: override.operatorId,
      scope: override.scope,
      scopeRef: override.scopeRef,
      expiresAt: override.expiresAt,
    });
    return override;
  }

  public revokeLocalOperatorOverride(overrideId: string, revokedBy: string): LocalOperatorOverrideRecord | undefined {
    if (!revokedBy.trim()) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "revokedBy" });
    }
    let existing: LocalOperatorOverrideRecord;
    try {
      existing = this.storage.permissionProfiles.getLocalOperatorOverride(overrideId);
    } catch {
      return undefined;
    }
    if (existing.operatorId !== revokedBy) {
      return undefined;
    }
    const revoked = this.storage.permissionProfiles.revokeLocalOperatorOverride(overrideId, undefined, revokedBy);
    if (!revoked) {
      return undefined;
    }
    const record = this.storage.permissionProfiles.getLocalOperatorOverride(overrideId);
    this.publishRealtime("local_operator_override_revoked", "tools", {
      overrideId,
      revokedBy: record.revokedBy,
      revokedAt: record.revokedAt,
      status: record.status,
    });
    return record;
  }

  public listToolGrants(scope?: ToolGrantScope, scopeRef?: string, limit = 200): ToolGrantRecord[] {
    return this.approvalRuntime.listToolGrants(scope, scopeRef, limit);
  }

  private listActiveToolGrants(scope?: ToolGrantScope, scopeRef?: string): ToolGrantRecord[] {
    const grantRepo = this.storage.toolGrants as
      | {
          listActive?: (scope?: ToolGrantScope, scopeRef?: string) => ToolGrantRecord[];
        }
      | undefined;
    if (grantRepo?.listActive) {
      return grantRepo.listActive(scope, scopeRef);
    }
    const grants = this.listToolGrants(scope, scopeRef, Number.MAX_SAFE_INTEGER);
    return Array.isArray(grants) ? grants.filter(isActiveToolGrant) : [];
  }

  public createToolGrant(input: ToolGrantCreateInput): ToolGrantRecord {
    return this.approvalRuntime.createToolGrant(input);
  }

  public revokeToolGrant(grantId: string, revokedBy: string): boolean {
    if (!revokedBy.trim()) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "revokedBy" });
    }
    return this.approvalRuntime.revokeToolGrant(grantId, revokedBy);
  }

  public async createApproval(input: ApprovalCreateInput): Promise<ApprovalRequest> {
    const approval = await this.approvalRuntime.createApproval(input);
    this.recordRuntimeDecision({
      kind: "approval_requested",
      scope: this.buildApprovalDecisionScope(approval),
      selected: `Requested ${approval.kind} approval`,
      rationale: "Runtime policy required an operator-visible approval before continuing the linked action.",
      alternatives: [
        {
          label: "Continue without approval",
          outcome: "blocked",
          reasonNotChosen: "Approval policy requires explicit operator resolution for this risk posture.",
          blockedBy: "approval policy",
        },
      ],
      signals: [
        {
          source: "approval",
          key: "kind",
          value: approval.kind,
          weight: "strong",
        },
        {
          source: "policy",
          key: "riskLevel",
          value: approval.riskLevel,
          weight: approval.riskLevel === "danger" || approval.riskLevel === "nuclear" ? "blocking" : "strong",
        },
        {
          source: "approval",
          key: "status",
          value: approval.status,
          weight: "informational",
        },
      ],
      evidenceRefs: this.buildApprovalDecisionEvidenceRefs(approval),
    });
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
    return this.approvalRuntime.createApprovalRemoteActionToken(approvalId, input);
  }

  public async resolveApprovalWithRemoteToken(input: {
    token: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
    resolvedBy?: string;
  }): Promise<ApprovalResolveResult> {
    return this.approvalRuntime.resolveApprovalWithRemoteToken(input);
  }

  public async resolveApprovalWithRemoteTokenId(input: {
    tokenId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
    resolvedBy?: string;
  }): Promise<ApprovalResolveResult> {
    return this.approvalRuntime.resolveApprovalWithRemoteTokenId(input);
  }

  public listApprovals(status?: ApprovalRequest["status"], limit = 100, workspaceId?: string): ApprovalRequest[] {
    return this.approvalRuntime.listApprovals(status, limit, workspaceId);
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
          originSurface: payload.originSurface ?? requestAttribution.originSurface,
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

  /**
   * Route an autonomous turn's assistant reply to a channel by enqueuing a
   * durable `connector.delivery` run. Resolves the channel connector by key,
   * falling back to the connector's default target when no explicit target is
   * configured. Returns the delivery run id, or undefined when no active channel
   * connector / target could be resolved (delivery is best-effort, never fatal
   * to the turn). Carries `system-cron`-class governance so the channel send is
   * attributed to the autonomous actor.
   */
  /** @internal */ public enqueueAutonomousChannelDelivery(
    input: durableExecutionService.AutonomousChannelDeliveryRequest,
  ): string | undefined {
    if (!this.isFeatureEnabled("durableKernelV1Enabled")) {
      return undefined;
    }
    if (this.isFeatureEnabled("autonomyV1Disabled")) {
      return undefined;
    }
    const message = input.assistantText.trim();
    if (!message) {
      return undefined;
    }
    const channelKey = input.deliveryChannel.channelKey.trim();
    const connector = this.listConnectorRecords("integration_connection").find(
      (item) => item.status === "active" && item.metadata?.key === channelKey,
    );
    if (!connector) {
      return undefined;
    }
    const target =
      input.deliveryChannel.target?.trim() ||
      (typeof connector.metadata?.approvalDeliveryTarget === "string"
        ? connector.metadata.approvalDeliveryTarget.trim()
        : undefined);
    if (!target) {
      return undefined;
    }
    const operatorId = input.systemActorId ?? "system-cron";
    const workspaceId = this.storage.chatSessionMeta.get(input.sessionId)?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const run = this.createDurableRun({
      workflowKey: "connector.delivery",
      payload: {
        version: "connector.delivery.v1",
        connectorId: connector.connectorId,
        connectorType: connector.connectorType,
        action: "channel.send",
        workspaceId,
        sessionId: input.sessionId,
        runId: input.runId,
        operatorId,
        authActorId: operatorId,
        authActorSource: "none",
        originSurface: "scheduler",
        payload: { target, message, ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}) },
      },
      metadata: {
        deliveryKind: "autonomous.assistant_message",
        connectorId: connector.connectorId,
        connectorType: connector.connectorType,
        autonomous: true,
        sourceRunId: input.runId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
      },
    });
    return run.runId;
  }

  /**
   * Prune a silent heartbeat turn from a human transcript (P1-F4 invisibility).
   * Removes the seed user message + `{notify:false}` assistant message and the
   * turn trace, reverting the active branch leaf to the pre-heartbeat leaf, in a
   * single transaction (mirroring the undo path). Best-effort: a heartbeat is a
   * silent background tick, so cleanup failures must never surface — they are
   * logged and swallowed. Only invoked for non-notifying heartbeat turns.
   */
  /** @internal */ public cleanupSilentHeartbeatTurn(
    input: durableExecutionService.SilentHeartbeatCleanupRequest,
  ): void {
    try {
      const messageIds = [input.userMessageId, input.assistantMessageId].filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      );
      this.storage.runImmediateTransaction(() => {
        this.storage.chatMessages.deleteByMessageIds(input.sessionId, messageIds);
        this.storage.chatTurnTraces.deleteByTurnIds(input.sessionId, [input.turnId]);
        if (input.parentTurnId) {
          this.storage.chatSessionBranchState.setActiveLeaf(
            input.sessionId,
            input.parentTurnId,
            new Date().toISOString(),
          );
        } else {
          this.storage.chatSessionBranchState.clear(input.sessionId);
        }
      });
      this.publishRealtime(
        "chat_thread_updated",
        "chat",
        {
          type: "chat_thread_undone",
          sessionId: input.sessionId,
          removedTurnIds: [input.turnId],
          ...(input.parentTurnId ? { activeLeafTurnId: input.parentTurnId } : {}),
          reason: "silent_heartbeat",
        },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: {
            sessionId: input.sessionId,
            ...(input.parentTurnId ? { turnId: input.parentTurnId } : {}),
          },
        },
      );
    } catch (error) {
      this.recordDevDiagnostic({
        level: "warn",
        category: "chat",
        event: "chat.heartbeat.cleanup_failed",
        message: "Failed to prune a silent heartbeat turn from the transcript.",
        sessionId: input.sessionId,
        turnId: input.turnId,
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    }
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

  /** @internal */ public enqueueApprovalResolutionEffects(
    approval: ApprovalRequest,
    input: ApprovalResolveInput,
  ): ApprovalEffectRecord[] {
    const effects = this.approvalEffectsService.enqueueResolutionEffects(approval, input);
    this.recordRuntimeDecision({
      kind: "approval_resolved",
      scope: this.buildApprovalDecisionScope(approval),
      selected: `Approval ${input.decision}`,
      rationale:
        input.resolutionNote ?? `Operator ${input.resolvedBy} resolved ${approval.kind} with ${input.decision}.`,
      signals: [
        {
          source: "approval",
          key: "decision",
          value: input.decision,
          weight: "strong",
        },
        {
          source: "approval",
          key: "effectCount",
          value: effects.length,
          weight: "informational",
        },
      ],
      evidenceRefs: this.buildApprovalDecisionEvidenceRefs(approval),
    });
    const resumeEffects = effects.filter(
      (effect) =>
        effect.effectKind === "approval_wait_wake" ||
        effect.effectKind === "proactive_run_wake" ||
        effect.effectKind === "orchestration_parent_wake" ||
        effect.effectKind === "linked_chat_turn_wake",
    );
    if (resumeEffects.length > 0) {
      this.recordRuntimeDecision({
        kind: "runtime_resumed",
        scope: this.buildApprovalDecisionScope(approval),
        selected: "Queued approval resume effects",
        rationale: "Approval resolution cleared a runtime wait condition and queued linked work to resume.",
        signals: [
          {
            source: "approval",
            key: "resumeEffectCount",
            value: resumeEffects.length,
            weight: "strong",
          },
          {
            source: "durable",
            key: "targetIds",
            value: resumeEffects.map((effect) => effect.targetId).join(", "),
            weight: "informational",
          },
        ],
        evidenceRefs: [
          ...this.buildApprovalDecisionEvidenceRefs(approval),
          ...resumeEffects.map((effect) => ({
            refType: effect.targetKind === "durable_run" ? ("durable_run" as const) : ("event" as const),
            refId: effect.targetId,
            label: effect.effectKind,
          })),
        ],
      });
    }
    return effects;
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
    const consumed = this.storage.remoteActionTokens.consumePending(current.tokenId, {
      consumedAt: new Date().toISOString(),
      consumedBy: `connector:${current.connectorId}`,
    });
    if (!consumed) {
      throw new ConflictError({
        message: "Remote action token has already been consumed.",
      });
    }
    return consumed;
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
    const consumed = this.storage.remoteActionTokens.consumePending(current.tokenId, {
      consumedAt: new Date().toISOString(),
      consumedBy: `connector:${current.connectorId}`,
    });
    if (!consumed) {
      throw new ConflictError({
        message: "Remote action token has already been consumed.",
      });
    }
    return consumed;
  }

  public listSkills(): SkillListItem[] {
    this.ensureSkillStates(this.skillsService.list().map((skill) => skill.skillId));
    return this.capabilitySystemService.listSkills();
  }

  public createCapabilityProposal(
    input: Parameters<CapabilitySystemService["createProposal"]>[0],
  ): CapabilityProposalRecord {
    return this.capabilitySystemService.createProposal(input);
  }

  /**
   * Callable tool/skill catalog for the base agent system prompt's
   * "what you can do" index (P0-#2). Cheap, in-memory read of the callable
   * capability catalog — NO per-tool policy evaluation (the prompt is advisory
   * grounding; deny-wins enforcement stays inline at tool-call time). Best-effort:
   * returns an empty toolset rather than throwing on the turn-prep critical path.
   */
  public resolveBasePromptCapabilityCatalog(): BaseAgentPromptToolset {
    try {
      const catalog = this.capabilitySystemService.listCatalog("callable");
      const toolNames: string[] = [];
      const skills: BaseAgentPromptSkill[] = [];
      for (const entry of catalog) {
        if (entry.kind === "tool") {
          if (entry.toolName) {
            toolNames.push(entry.toolName);
          }
          continue;
        }
        if (entry.kind === "skill") {
          const summary = entry.summary?.trim();
          skills.push(summary ? { name: entry.title, summary } : { name: entry.title });
        }
      }
      return { toolNames, skills };
    } catch (error) {
      log.warn("resolveBasePromptCapabilityCatalog failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { toolNames: [] };
    }
  }

  public listCuratorStatus() {
    return this.curatorService.listCuratorStatus();
  }

  public archiveCuratorSkill(input: Parameters<CuratorService["archive"]>[0]) {
    return this.curatorService.archive(input);
  }

  public pruneCuratorSkill(input: Parameters<CuratorService["prune"]>[0]) {
    return this.curatorService.prune(input);
  }

  public listCuratorArchived() {
    return this.curatorService.listArchived();
  }

  public runCurator(input: Parameters<CuratorService["runCurator"]>[0]) {
    return this.curatorService.runCurator(input);
  }

  public async reloadSkills(): Promise<SkillListItem[]> {
    const loaded = await this.skillsService.reload();
    this.ensureSkillStates(loaded.map((skill) => skill.skillId));
    this.capabilitySystemService.ensureSkillLifecycleBackfill();
    return this.listSkills();
  }

  public listSkillExportTargets(): SkillExportTargetProfile[] {
    return listSkillExportTargets();
  }

  public previewSkillExport(input: SkillExportRequest): SkillExportPreviewResponse {
    return renderSkillExportPreview(input, this.skillsService.list());
  }

  public packageSkillExport(input: SkillExportRequest): SkillExportPackageResponse {
    const preview = this.previewSkillExport(input);
    const envelope = this.evidenceEnvelopeService.createEnvelope({
      eventKind: "skill_export",
      metadata: {
        target: preview.target,
        fileCount: preview.files.length,
        fileHashes: preview.files.map((file) => file.sha256),
        actorId: input.actorId ?? "operator",
      },
    });
    return {
      ...preview,
      packageId: envelope.envelopeId,
      evidenceRef: `evidence:${envelope.envelopeId}`,
    };
  }

  public async executeCodeModePendingApproval(
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<ToolInvokeResult | undefined> {
    return this.capabilitySystemService.executeApprovedCodeModeRun(approvalId, signal);
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

  public setSkillState(skillId: string, state: SkillRuntimeState, note?: string): SkillStateRecord {
    const knownSkill = this.skillsService.list().find((skill) => skill.skillId === skillId);
    if (!knownSkill) {
      throw new Error(`Unknown skill: ${skillId}`);
    }
    const currentState = this.readSkillStates().get(skillId);
    if (currentState?.pinned && currentState.state !== state) {
      throw new Error(`Pinned skill ${skillId} cannot be changed directly; create a skill mutation proposal first.`);
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

  /**
   * Capture a reversible snapshot of a skill's prior runtime-state row before the
   * S3 idle janitor archives (disables) it. Persisted into `system_settings` so
   * the global "revert autonomous changes" path can restore the exact prior
   * state/note via {@link restoreCuratorIdleSkillSnapshot}. Best-effort: a
   * snapshot failure must not abort the sweep (which is itself failure-isolated),
   * so this swallows errors. The archive is reversible regardless — a
   * curator-archived skill is a `disabled` row re-enableable from the snapshot.
   */
  private captureCuratorIdleSkillSnapshot(skillId: string): void {
    try {
      const prior = this.readSkillStates().get(skillId);
      this.storage.systemSettings.set(this.curatorIdleSnapshotKey(skillId), {
        skillId,
        priorState: prior?.state ?? "enabled",
        priorNote: prior?.note,
        priorPinned: prior?.pinned ?? false,
        capturedAt: new Date().toISOString(),
      });
      // Unified audit: the snapshot self-persists in system_settings under the
      // deterministic key, so the restoreRef only needs the skillId (best-effort).
      this.autonomyControlService.recordAutonomousMutation({
        kind: "curator_archive",
        targetKey: skillId,
        restoreRef: { kind: "curator_archive", skillId },
      });
    } catch (error) {
      this.recordDevDiagnostic({
        level: "warn",
        category: "cron",
        event: "curator_idle_snapshot_failed",
        message: "failed to snapshot skill state before idle archive",
        context: { skillId, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /**
   * Restore a skill archived by the S3 idle janitor to its captured prior state.
   * Returns false when no snapshot exists for the skill. Used by the global
   * autonomous-rollback path.
   */
  public restoreCuratorIdleSkillSnapshot(skillId: string): boolean {
    const snapshot = this.storage.systemSettings.get<{
      skillId: string;
      priorState: SkillRuntimeState;
      priorNote?: string;
      priorPinned?: boolean;
    }>(this.curatorIdleSnapshotKey(skillId))?.value;
    if (!snapshot || snapshot.skillId !== skillId) {
      return false;
    }
    this.setSkillState(skillId, snapshot.priorState, snapshot.priorNote);
    return true;
  }

  private curatorIdleSnapshotKey(skillId: string): string {
    return `curator_idle_skill_snapshot_v1:${skillId}`;
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

    this.recordSkillUsage(selected.map((skill) => skill.skillId));

    return {
      ...base,
      selected,
      suppressed,
    };
  }

  public async listMemoryFiles(relativeDir = "memory"): Promise<MemoryFileEntry[]> {
    return this.memoryLifecycleService.listMemoryFiles(relativeDir);
  }

  /** @internal */ public persistContextManifestForCompletionRequest(input: {
    request: ChatCompletionRequest;
    memoryContext?: MemoryContextPack;
    memoryContextPlacement?: MemoryContextPlacement;
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
        assembly: input.memoryContext.quality.assembly,
        placement: input.memoryContextPlacement,
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

  public getSettings(): RuntimeSettings {
    return settingsAuthService.getSettings(createSettingsRuntimeDependenciesForGateway(this.getRouteCompositionPort()));
  }

  public getPersonalityCatalog() {
    return this.personalityCatalogService.getCatalog();
  }

  public setDefaultPersonality(id: string) {
    return this.personalityCatalogService.setDefaultPersonality(id);
  }

  public buildDefaultChatPersonalityOverlay() {
    return this.personalityCatalogService.buildDefaultChatPersonalityOverlay();
  }

  /**
   * Frozen cross-session operator-profile digest for the base prompt (P2-S4b).
   * Ensures the profile exists (stamping `WorkspacePrefs.operatorProfileId` on
   * first use), then returns the cached, byte-stable-per-revision digest. Cheap:
   * no model call on the hot path. Best-effort — a failure must not break a turn.
   */
  public composeFrozenOperatorProfileDigest(workspaceId: string): string | undefined {
    try {
      const normalizedWorkspaceId = this.normalizeWorkspaceId(workspaceId);
      this.operatorProfileService.ensureOperatorProfile(normalizedWorkspaceId);
      return this.operatorProfileService.composeFrozenProfileDigest(normalizedWorkspaceId);
    } catch {
      return undefined;
    }
  }

  public updateSettings(input: settingsAuthService.UpdateSettingsInput): RuntimeSettings {
    return settingsAuthService.updateSettings(
      createSettingsRuntimeDependenciesForGateway(this.getRouteCompositionPort()),
      input,
    );
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
    toolApprovalMode?: ToolApprovalMode;
    defaultToolProfile?: string;
  }): void {
    const nextProfile = input.deploymentProfile ?? this.config.assistant.deploymentProfile;
    if (nextProfile !== "remote_hardened") {
      return;
    }

    const nextAuthMode = input.auth?.mode ?? this.config.assistant.auth.mode;
    const nextAllowLoopbackBypass = input.auth?.allowLoopbackBypass ?? this.config.assistant.auth.allowLoopbackBypass;
    const nextDefaultToolProfile = input.defaultToolProfile ?? this.config.assistant.defaultToolProfile;
    const nextToolPolicyProfile = this.config.toolPolicy.tools?.profile;
    const nextToolApprovalMode =
      input.toolApprovalMode ??
      (input.defaultToolProfile ? legacyToolProfileToApprovalMode(input.defaultToolProfile) : undefined) ??
      this.config.toolPolicy.tools?.approvalMode ??
      this.config.assistant.toolApprovalMode ??
      legacyToolProfileToApprovalMode(
        this.config.toolPolicy.tools?.profile ?? this.config.assistant.defaultToolProfile,
      ) ??
      "approve_risky";
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
    if (nextToolApprovalMode === "bypass") {
      errors.push("remote_hardened disables approval bypass.");
    }
    if (nextDefaultToolProfile === "danger" || nextToolPolicyProfile === "danger") {
      errors.push("remote_hardened disables danger tool profiles.");
    }
    if (!hasExplicitNonLoopbackAllowedOrigin(process.env.GOATCITADEL_ALLOWED_ORIGINS)) {
      errors.push("remote_hardened requires explicit non-loopback GOATCITADEL_ALLOWED_ORIGINS.");
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

  private assertPermissionProfileApprovalModeAllowed(approvalMode?: ToolApprovalMode): void {
    if (this.config.assistant.deploymentProfile === "remote_hardened" && approvalMode === "bypass") {
      throw new ConflictError({
        message: "Bypass permission profiles are unavailable in remote_hardened deployment profile.",
      });
    }
  }

  private assertResolvedToolPolicyContextAllowed(context: ToolPolicyActorContext): void {
    if (this.config.assistant.deploymentProfile !== "remote_hardened") {
      return;
    }
    if (context.localOperatorOverrideId || context.localOperatorOverride) {
      throw new ConflictError({
        message: "Local Operator Override is unavailable in remote_hardened deployment profile.",
      });
    }
    if (context.permissionProfile?.approvalMode === "bypass") {
      throw new ConflictError({
        message: "Bypass permission profiles are unavailable in remote_hardened deployment profile.",
      });
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
    return settingsAuthService.getAuthRuntimeSettings(
      createSettingsRuntimeDependenciesForGateway(this.getRouteCompositionPort()),
    );
  }

  public updateAuthSettings(input: AuthSettingsUpdateInput): AuthRuntimeSettings {
    return settingsAuthService.updateAuthSettings(
      createSettingsRuntimeDependenciesForGateway(this.getRouteCompositionPort()),
      input,
    );
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

  public getOnboardingStartupState(): OnboardingStartupState {
    return onboardingStateService.getOnboardingStartupState(this);
  }

  public validateDeviceAccessToken(token: string): { actorId: string; deviceId: string; grantId: string } | undefined {
    return settingsAuthService.validateDeviceAccessToken(
      createSettingsAuthRuntimeDependenciesForGateway(this.getRouteCompositionPort()),
      token,
    );
  }

  public validateCompanionAccessToken(token: string): CompanionAccessValidationResult | undefined {
    return settingsAuthService.validateCompanionAccessToken(
      createSettingsAuthRuntimeDependenciesForGateway(this.getRouteCompositionPort()),
      token,
    );
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
    return settingsAuthService.verifyCompanionRequestSignature(
      createSettingsAuthRuntimeDependenciesForGateway(this.getRouteCompositionPort()),
      input,
    );
  }

  public async listSkillSources(query?: string, limit = 25): Promise<SkillSourceListResponse> {
    return this.skillImportService.listSources(query, limit);
  }

  private listConnectorRecords(connectorType?: ConnectorType): ConnectorRecord[] {
    return filterConnectorRecords(
      buildGatewayConnectorRecords({
        integrationConnections: this.storage.integrationConnections.list(undefined, 1000),
        mcpServers: this.readMcpServers(),
        mcpTools: this.readMcpTools(),
      }),
      connectorType,
    );
  }

  public async lookupSkillSources(queryOrUrl: string, limit = 10): Promise<SkillSourceLookupResponse> {
    return this.skillImportService.lookupSources(queryOrUrl, limit);
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

  public createMcpServer(input: McpServerCreateInput): McpServerRecord {
    return mcpServerAdminService.createMcpServer(this, input);
  }

  public async connectMcpServer(serverId: string): Promise<McpServerRecord> {
    return mcpServerAdminService.connectMcpServer(this, serverId);
  }

  public disconnectMcpServer(serverId: string): McpServerRecord {
    return mcpServerAdminService.disconnectMcpServer(this, serverId);
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
    // Capability-scope enforcement happens at the coordinator's executeMcpRuntime choke point
    // (via host.assertMcpServerInScope), which also covers the model approval-replay path and
    // internal servers. Enrich here so the gate sees the resolved workspaceId.
    return this.toolInvocationCoordinator.invokeMcpTool(this.enrichMcpInvokePolicyContext(input));
  }

  private assertMcpServerInCapabilityScope(request: McpInvokeRequest): void {
    if (GATEWAY_OWNED_MCP_SERVER_IDS.has(request.serverId)) {
      return;
    }
    if (!this.capabilityScopeResolver) {
      throw new PolicyViolationError({
        code: "POLICY_BLOCKED",
        message: "MCP capability scope resolver is unavailable.",
        details: { serverId: request.serverId, workspaceId: request.workspaceId ?? DEFAULT_WORKSPACE_ID },
      });
    }
    const workspaceId = request.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const citadelId = this.storage.workspaces?.find(workspaceId)?.citadelId ?? DEFAULT_CITADEL_ID;
    const effective = this.capabilityScopeResolver.resolve(citadelId, workspaceId).mcpServers;
    if (!isCapabilityAllowed(effective, request.serverId)) {
      throw new PolicyViolationError({
        code: "POLICY_BLOCKED",
        message: `MCP server ${request.serverId} is not available in this workspace's capability scope.`,
        details: { serverId: request.serverId, workspaceId, citadelId },
      });
    }
  }

  private enrichMcpInvokePolicyContext(input: McpInvokeRequest): McpInvokeRequest {
    const sessionId = input.sessionId?.trim() || `mcp:${input.serverId}`;
    const workspaceId =
      input.workspaceId ?? this.storage.chatSessionMeta.get(sessionId)?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const existing = input.policyContext;
    if (existing?.permissionProfile) {
      this.assertResolvedToolPolicyContextAllowed(existing);
      return {
        ...input,
        sessionId,
        workspaceId,
        policyContext: {
          ...existing,
          workspaceId,
          sessionId,
          taskId: input.taskId ?? existing.taskId,
          runId: input.runId ?? existing.runId,
          surface: existing.surface ?? input.surface ?? "mcp",
        },
      };
    }
    const operatorId = existing?.operatorId ?? input.consentContext?.operatorId ?? existing?.authActorId ?? "system";
    const policyContext = this.resolveToolPolicyContext({
      operatorId,
      authActorId: existing?.authActorId,
      authActorSource: existing?.authActorSource,
      workspaceId,
      sessionId,
      taskId: input.taskId,
      runId: input.runId,
      surface: existing?.surface ?? input.surface ?? "mcp",
      permissionProfileId: existing?.permissionProfileId ?? input.permissionProfileId,
      localOperatorOverrideId: existing?.localOperatorOverrideId ?? input.localOperatorOverrideId,
    });
    return {
      ...input,
      sessionId,
      workspaceId,
      permissionProfileId: policyContext.permissionProfileId,
      localOperatorOverrideId: policyContext.localOperatorOverrideId,
      surface: policyContext.surface,
      policyContext,
    };
  }

  public async commsSend(input: ChannelSendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    const connection = this.storage.integrationConnections.get(input.connectionId);
    const idempotencyKey = buildChannelDeliveryIdempotencyKey(input, connection.key);
    const queued = this.channelDeliveryRuntimeService.enqueue({
      connectionId: input.connectionId,
      channelKey: connection.key,
      target: input.target,
      payload: buildChannelDeliveryPayload(input, connection.key),
      idempotencyKey,
    });
    this.scheduleChannelDeliveryDrain();
    return {
      deliveryId: queued.deliveryId,
      status:
        queued.status === "sent"
          ? "sent"
          : queued.status === "failed" || queued.status === "stale"
            ? "failed"
            : "queued",
      deliveryStatus: queued.deliveryStatus ?? (queued.status === "sent" ? "sent" : "retrying"),
      channelKey: queued.channelKey,
      target: queued.target,
      ...(queued.providerMessageId ? { providerMessageId: queued.providerMessageId } : {}),
      ...(queued.error ? { error: queued.error, fallbackReason: queued.fallbackReason ?? queued.error } : {}),
      ...(queued.deliveryDiagnostics ? { deliveryDiagnostics: queued.deliveryDiagnostics } : {}),
      createdAt: queued.createdAt,
      updatedAt: queued.updatedAt,
      ...(queued.nextAttemptAt ? { nextAttemptAt: queued.nextAttemptAt } : {}),
    };
  }

  public async commsReply(input: ChannelReplyInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    if (!input.replyToMessageId?.trim()) {
      throw new Error("replyToMessageId is required for channel replies.");
    }
    return this.commsSend(input);
  }

  async commsActivity(input: ChannelActivityInput): Promise<ChannelActivityResult> {
    return commsActivityImpl(this.buildCommsHost(), input);
  }

  public async emitChannelActivity(input: ChannelActivityInput): Promise<ChannelActivityResult> {
    return this.commsActivity(input);
  }

  public async commsReact(input: ChannelReactInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsReactImpl(this.buildCommsHost(), input);
  }

  public async commsUnsend(input: ChannelUnsendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsUnsendImpl(this.buildCommsHost(), input);
  }

  public async commsTyping(input: ChannelTypingInput): Promise<ChannelTypingResult> {
    return commsTypingImpl(this.buildCommsHost(), input);
  }

  public async drainDueChannelDeliveries(limit = 25): Promise<ChannelDeliveryRuntimeRecord[]> {
    return this.channelDeliveryRuntimeService.drainDue(limit);
  }

  private markLinkedCommitmentDeliverySent(record: ChannelDeliveryRuntimeRecord): void {
    if (!record.commitmentId) {
      return;
    }
    this.storage.agentCommitments.markSent(record.commitmentId, record.updatedAt);
  }

  private markLinkedCommitmentDeliveryFailed(record: ChannelDeliveryRuntimeRecord): void {
    if (!record.commitmentId) {
      return;
    }
    this.storage.agentCommitments.markDeliveryFailed(record.commitmentId);
  }

  public listChannelDeliveryRuntime(): ChannelDeliveryRuntimeRecord[] {
    const recordsById = new Map<string, ChannelDeliveryRuntimeRecord>();
    for (const record of this.storage.commsDeliveries.list(undefined, 200)) {
      recordsById.set(record.deliveryId, {
        deliveryId: record.deliveryId,
        connectionId: record.connectionId,
        channelKey: record.channelKey,
        target: record.target,
        status: mapPersistedChannelDeliveryRuntimeStatus(record.status, record.deliveryStatus, record.staleReason),
        deliveryStatus: record.deliveryStatus,
        idempotencyKey: record.idempotencyKey,
        payloadHash: record.payloadHash,
        attempts: record.attempts,
        maxAttempts: record.maxAttempts,
        nextAttemptAt: record.nextAttemptAt,
        staleReason: record.staleReason,
        commitmentId:
          record.payload && typeof record.payload.commitmentId === "string" ? record.payload.commitmentId : undefined,
        providerMessageId: record.providerMessageId,
        error: record.error,
        fallbackReason: record.fallbackReason,
        deliveryDiagnostics: record.deliveryDiagnostics,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    }
    for (const record of this.channelDeliveryRuntimeService.list()) {
      recordsById.set(record.deliveryId, record);
    }
    return [...recordsById.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private scheduleChannelDeliveryDrain(): void {
    if (this.closing) {
      return;
    }
    const task = this.drainDueChannelDeliveries()
      .then(() => undefined)
      .catch((error) => {
        log.warn("channel delivery drain failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.registerBackgroundTask(task);
  }

  private async sendQueuedChannelDelivery(
    input: ChannelDeliveryRuntimeSendInput,
  ): Promise<{ providerMessageId?: string; deliveryDiagnostics?: ChannelDeliveryDiagnostics }> {
    const baseInput = channelDeliveryPayloadToSendInput(input);
    const messageParts = readChannelDeliveryMessageParts(input.payload);
    if (messageParts.length <= 1) {
      const result = await commsSendImpl(this.buildCommsHost(), baseInput);
      const unwrapped = extractCommsSendResult(result);
      if (unwrapped.status === "failed") {
        throw new Error(
          readOptionalString(unwrapped.error) ??
            readOptionalString(unwrapped.fallbackReason) ??
            "Channel delivery failed.",
        );
      }
      return { providerMessageId: readOptionalString(unwrapped.providerMessageId) };
    }

    let providerMessageId: string | undefined;
    for (let index = 0; index < messageParts.length; index += 1) {
      const result = await commsSendImpl(this.buildCommsHost(), {
        ...baseInput,
        message: messageParts[index] ?? "",
        attachments: index === 0 ? baseInput.attachments : undefined,
        attachmentIds: index === 0 ? baseInput.attachmentIds : undefined,
        interactiveActions: index === messageParts.length - 1 ? baseInput.interactiveActions : undefined,
        replyToMessageId: index === 0 ? baseInput.replyToMessageId : (providerMessageId ?? baseInput.replyToMessageId),
        replyToPartIndex: index,
      });
      const unwrapped = extractCommsSendResult(result);
      if (unwrapped.status === "failed") {
        const reason =
          readOptionalString(unwrapped.error) ??
          readOptionalString(unwrapped.fallbackReason) ??
          "Channel delivery chunk failed.";
        throw new Error(
          index > 0
            ? `partial_channel_delivery_sent: ${index} of ${messageParts.length} chunks were sent before failure; manual retry required. ${reason}`
            : reason,
        );
      }
      providerMessageId = readOptionalString(unwrapped.providerMessageId) ?? providerMessageId;
    }

    return {
      providerMessageId,
      deliveryDiagnostics: readDeliveryDiagnostics(input.payload.deliveryDiagnostics),
    };
  }

  public async commsGmailRead(input: GmailReadQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsGmailReadImpl(this.buildCommsHost(), input);
  }

  public async commsGmailSend(input: GmailSendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsGmailSendImpl(this.buildCommsHost(), input);
  }

  public async commsCalendarList(input: CalendarListQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsCalendarListImpl(this.buildCommsHost(), input);
  }

  public async commsCalendarCreate(
    input: CalendarCreateEventInput,
  ): Promise<ToolInvokeResult | Record<string, unknown>> {
    return commsCalendarCreateImpl(this.buildCommsHost(), input);
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

  public getLlmConfig(): LlmRuntimeConfig {
    return this.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
  }

  public async listLlmModels(providerId?: string): Promise<LlmModelRecord[]> {
    return this.llmService.listModels(providerId);
  }

  public async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return llmCompletionService.createChatCompletion(this, request);
  }

  public async *createChatCompletionStream(request: ChatCompletionRequest): AsyncGenerator<Record<string, unknown>> {
    yield* llmCompletionService.createChatCompletionStream(this, request);
  }

  /** @internal */ public recordLlmRuntimeMeasurement(record: LlmRuntimeMeasurementRecord): void {
    try {
      this.storage.llmRuntimeMeasurements.insert(record);
    } catch (error) {
      const runtimeError = error instanceof Error ? error : new Error(String(error));
      this.recordDevDiagnostic({
        level: "warn",
        category: "runtime_truth",
        event: "llm.runtime_measurement.persist_failed",
        message: "Failed to persist LLM runtime measurement",
        sessionId: record.sessionId,
        taskId: record.taskId,
        runId: record.runId,
        providerId: record.providerId,
        modelId: record.model,
        runtimeKind: "runtime.telemetry",
        runtimeStatus: "degraded",
        runtimeError: {
          name: runtimeError.name,
          message: runtimeError.message,
          retryable: false,
        },
      });
    }
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

  public async createOrchestrationPlan(
    plan: OrchestrationPlan,
    policyContext?: OrchestrationRunPolicyContext,
  ): Promise<OrchestrationRun> {
    return orchestrationLifecycleService.createOrchestrationPlan(
      this,
      this.getOrchestrationLifecycleRuntimeDeps(),
      plan,
      policyContext,
    );
  }

  public async runOrchestrationPlan(
    planId: string,
    policyContext?: OrchestrationRunPolicyContext,
  ): Promise<OrchestrationRun> {
    return orchestrationLifecycleService.runOrchestrationPlan(
      this,
      this.getOrchestrationLifecycleRuntimeDeps(),
      planId,
      policyContext,
    );
  }

  public async approvePhase(
    runId: string,
    phaseId: string,
    approvedBy: string,
    costIncrementUsd = 0,
    workspaceId?: string,
  ): Promise<{ run: OrchestrationRun; checkpoints: OrchestrationCheckpoint[] }> {
    return orchestrationLifecycleService.approvePhase(this, runId, phaseId, approvedBy, costIncrementUsd, workspaceId);
  }

  public async cancelOrchestrationRun(
    runId: string,
    actorId = "operator",
    workspaceId?: string,
  ): Promise<{ run: OrchestrationRun; checkpoints: OrchestrationCheckpoint[] }> {
    return orchestrationLifecycleService.cancelOrchestrationRun(
      this,
      this.getOrchestrationLifecycleRuntimeDeps(),
      runId,
      actorId,
      workspaceId,
    );
  }

  public getRun(runId: string, workspaceId?: string): OrchestrationRun {
    return orchestrationLifecycleService.getRun(this, runId, workspaceId);
  }

  public listRunCheckpoints(runId: string, workspaceId?: string): OrchestrationCheckpoint[] {
    return orchestrationLifecycleService.listRunCheckpoints(this, runId, workspaceId);
  }

  public getRunTrace(runId: string, workspaceId?: string): OrchestrationDecisionTrace {
    return orchestrationLifecycleService.getRunTrace(this, runId, workspaceId);
  }

  private getOrchestrationLifecycleRuntimeDeps(): orchestrationLifecycleService.OrchestrationLifecycleRuntimeDeps {
    return {
      worktrees: this.orchestrationWorktreeService,
      phaseExecutor: this.orchestrationPhaseExecutionService,
    };
  }

  /** @internal */ public requestDurableRunProcessing(runId: string): void {
    this.durableRunService.requestRunProcessing(runId);
  }

  /** @internal */ public updateDurableRunState(input: {
    runId: string;
    status?: DurableRunRecord["status"];
    metadata?: Record<string, unknown>;
    lastError?: string;
    clearLastError?: boolean;
    finishedAt?: string;
    clearFinishedAt?: boolean;
  }): DurableRunRecord {
    const current = this.storage.durableRuns.getRun(input.runId);
    return this.storage.durableRuns.updateRun({
      runId: input.runId,
      status: input.status ?? current.status,
      metadata: input.metadata ?? current.metadata,
      lastError: input.lastError,
      clearLastError: input.clearLastError,
      finishedAt: input.finishedAt,
      clearFinishedAt: input.clearFinishedAt,
      updatedAt: new Date().toISOString(),
      expectedVersion: current.version,
    });
  }

  /** @internal */ public async executeDurableOrchestrationRun(
    run: DurableRunRecord,
    context?: durableExecutionService.DurableWorkflowExecutionContext,
  ): Promise<{ outcome: "paused" | "completed" | "failed" | "cancelled"; checkpointState: Record<string, unknown> }> {
    return orchestrationLifecycleService.executeDurableOrchestrationRun(
      this,
      this.getOrchestrationLifecycleRuntimeDeps(),
      run,
      context,
    );
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
    return this.readFeatureFlags()[flag] === true;
  }

  public requireFeatureEnabled(flag: keyof RuntimeSettings["features"]): void {
    if (!this.isFeatureEnabled(flag)) {
      throw new ConflictError({ message: `Feature flag ${flag} is disabled.`, details: { flag } });
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
      memoryLifecycleAutoForgetEnabled:
        patch.memoryLifecycleAutoForgetEnabled ?? current.memoryLifecycleAutoForgetEnabled,
      memoryMaintenanceV1Enabled: patch.memoryMaintenanceV1Enabled ?? current.memoryMaintenanceV1Enabled,
      connectorDiagnosticsV1Enabled: patch.connectorDiagnosticsV1Enabled ?? current.connectorDiagnosticsV1Enabled,
      computerUseGuardrailsV1Enabled: patch.computerUseGuardrailsV1Enabled ?? current.computerUseGuardrailsV1Enabled,
      cronReviewQueueV1Enabled: patch.cronReviewQueueV1Enabled ?? current.cronReviewQueueV1Enabled,
      replayRegressionV1Enabled: patch.replayRegressionV1Enabled ?? current.replayRegressionV1Enabled,
      codeModeV1Enabled: patch.codeModeV1Enabled ?? current.codeModeV1Enabled,
      improvementLedgerV1Enabled: patch.improvementLedgerV1Enabled ?? current.improvementLedgerV1Enabled,
      improvementActivationV1Enabled: patch.improvementActivationV1Enabled ?? current.improvementActivationV1Enabled,
      // These two optional flags must be carried through: `updateFeatureFlags`
      // does a FULL `set(... next)` (not a merge), so omitting them would silently
      // wipe a previously-stored value. The autonomy kill switch is toggled this
      // way, so its persistence depends on this line.
      coworkRuntimeQualityV1Disabled: patch.coworkRuntimeQualityV1Disabled ?? current.coworkRuntimeQualityV1Disabled,
      orchestrationFinalStreamingV1Disabled:
        patch.orchestrationFinalStreamingV1Disabled ?? current.orchestrationFinalStreamingV1Disabled,
      autonomyV1Disabled: patch.autonomyV1Disabled ?? current.autonomyV1Disabled,
      chatThinkingStreamV1Enabled: patch.chatThinkingStreamV1Enabled ?? current.chatThinkingStreamV1Enabled,
      plannerFastPathV1Disabled: patch.plannerFastPathV1Disabled ?? current.plannerFastPathV1Disabled,
      parallelToolExecutionV1Disabled: patch.parallelToolExecutionV1Disabled ?? current.parallelToolExecutionV1Disabled,
      streamIdleWatchdogV1Disabled: patch.streamIdleWatchdogV1Disabled ?? current.streamIdleWatchdogV1Disabled,
      plannerFanoutV1Disabled: patch.plannerFanoutV1Disabled ?? current.plannerFanoutV1Disabled,
      subagentFanoutV1Disabled: patch.subagentFanoutV1Disabled ?? current.subagentFanoutV1Disabled,
      channelVoiceReplyV1Enabled: patch.channelVoiceReplyV1Enabled ?? current.channelVoiceReplyV1Enabled,
    };
    const autonomyKillSwitchDisengaged = current.autonomyV1Disabled === true && next.autonomyV1Disabled !== true;
    this.storage.systemSettings.set(FEATURE_FLAGS_SETTING_KEY, next);
    this.config.assistant.features = { ...next };
    if (autonomyKillSwitchDisengaged) {
      // Runs parked while the kill switch was engaged wait on a per-run event that
      // nothing else emits; without an explicit resume they stay "waiting" forever.
      // Best-effort — the flag write above already succeeded and must not be undone
      // by a resume failure.
      try {
        this.durableRunService?.resumeRunsWaitingForAutonomyKillSwitch();
      } catch (error) {
        log.warn("Failed to resume autonomy-kill-switch-parked durable runs", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
      memoryLifecycleAutoForgetEnabled:
        stored?.memoryLifecycleAutoForgetEnabled ?? fromConfig.memoryLifecycleAutoForgetEnabled ?? true,
      memoryMaintenanceV1Enabled: stored?.memoryMaintenanceV1Enabled ?? fromConfig.memoryMaintenanceV1Enabled,
      connectorDiagnosticsV1Enabled: stored?.connectorDiagnosticsV1Enabled ?? fromConfig.connectorDiagnosticsV1Enabled,
      computerUseGuardrailsV1Enabled:
        stored?.computerUseGuardrailsV1Enabled ?? fromConfig.computerUseGuardrailsV1Enabled,
      cronReviewQueueV1Enabled: stored?.cronReviewQueueV1Enabled ?? fromConfig.cronReviewQueueV1Enabled,
      replayRegressionV1Enabled: stored?.replayRegressionV1Enabled ?? fromConfig.replayRegressionV1Enabled,
      codeModeV1Enabled: stored?.codeModeV1Enabled ?? fromConfig.codeModeV1Enabled,
      improvementLedgerV1Enabled: stored?.improvementLedgerV1Enabled ?? fromConfig.improvementLedgerV1Enabled,
      improvementActivationV1Enabled:
        stored?.improvementActivationV1Enabled ?? fromConfig.improvementActivationV1Enabled,
      coworkRuntimeQualityV1Disabled:
        stored?.coworkRuntimeQualityV1Disabled ?? fromConfig.coworkRuntimeQualityV1Disabled,
      orchestrationFinalStreamingV1Disabled:
        stored?.orchestrationFinalStreamingV1Disabled ?? fromConfig.orchestrationFinalStreamingV1Disabled,
      autonomyV1Disabled: stored?.autonomyV1Disabled ?? fromConfig.autonomyV1Disabled,
      chatThinkingStreamV1Enabled: stored?.chatThinkingStreamV1Enabled ?? fromConfig.chatThinkingStreamV1Enabled,
      plannerFastPathV1Disabled: stored?.plannerFastPathV1Disabled ?? fromConfig.plannerFastPathV1Disabled,
      parallelToolExecutionV1Disabled:
        stored?.parallelToolExecutionV1Disabled ?? fromConfig.parallelToolExecutionV1Disabled,
      streamIdleWatchdogV1Disabled: stored?.streamIdleWatchdogV1Disabled ?? fromConfig.streamIdleWatchdogV1Disabled,
      plannerFanoutV1Disabled: stored?.plannerFanoutV1Disabled ?? fromConfig.plannerFanoutV1Disabled,
      subagentFanoutV1Disabled: stored?.subagentFanoutV1Disabled ?? fromConfig.subagentFanoutV1Disabled,
      channelVoiceReplyV1Enabled: stored?.channelVoiceReplyV1Enabled ?? fromConfig.channelVoiceReplyV1Enabled,
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
    // SECURITY (codex finding #13, #23): Integration actions and the live
    // diagnostics route both go through this helper with a URL drawn from
    // the connection config — which is currently an arbitrary record
    // accepted from the API. Bare `fetch()` here was a SSRF + secret-exfil
    // primitive: an authenticated caller could create a connection with
    // `bridgeUrl=https://attacker.example` and `authTokenEnv=OPENAI_API_KEY`,
    // then trigger an action/diagnostic to send `Authorization: Bearer
    // <OPENAI_API_KEY>` to the attacker host.
    //
    // We refuse private/loopback/metadata destinations unless the operator
    // has explicitly added the loopback host to the outbound allowlist that
    // the policy engine already maintains (e.g., the iMessage bridge on
    // 127.0.0.1). Listing the operator allowlist FIRST and the public-host
    // wildcard LAST means `evaluateHostEgress` (in network-guard) matches
    // explicit loopback patterns first and only falls through to "*" for
    // genuine public hosts. Bare-IP RFC1918, AWS metadata, GCP metadata,
    // link-local, and ULA addresses are still blocked because "*" is not
    // an explicit loopback pattern.
    const operatorAllowlist = this.config.toolPolicy.sandbox.networkAllowlist;
    return fetchAllowlisted(url, {
      allowlist: [...operatorAllowlist, "*"],
      timeoutMs: 5000,
      init,
    });
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
    if (!envName) {
      return undefined;
    }
    // SECURITY (codex finding #13, #23): The `envKey` field on integration
    // connections used to accept arbitrary env-var names. Lower-privileged
    // authenticated principals could create a productivity.apple-notes or
    // Matrix connection with `authTokenEnv: "OPENAI_API_KEY"` and then
    // trigger an action/diagnostic that sent `Authorization: Bearer
    // <OPENAI_API_KEY>` to an attacker-controlled URL. Until per-catalog
    // schemas land (PR-3 follow-up), refuse env-var names known to hold
    // LLM provider credentials or other broadly-scoped gateway secrets.
    if (!isPermittedIntegrationSecretEnvVarName(envName)) {
      log.warn("Refusing to resolve integration secret from forbidden env var name (codex finding #13/#23).", {
        envName,
        directKey,
        envKey,
      });
      return undefined;
    }
    return process.env[envName];
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

  private isUrlAllowlistedInList(urlValue: string, allowlist: string[]): boolean {
    return connectionUrlHelpers.isUrlAllowlistedInList(urlValue, allowlist);
  }

  private isNetworkAllowlistEnforced(): boolean {
    return true;
  }

  private isHostAllowlistedInList(hostname: string, allowlist: string[]): boolean {
    return connectionUrlHelpers.isHostAllowlistedInList(hostname, allowlist);
  }

  /** @internal */ public tryParseJson<T>(raw: string | null | undefined, fallback: T): T {
    return connectionUrlHelpers.tryParseJson(raw, fallback);
  }

  /** @internal */ public readMcpServers(): McpServerRecord[] {
    const stored = this.storage.systemSettings.get<McpServerRecord[]>(MCP_SERVERS_SETTING_KEY)?.value;
    const authRows = this.readMcpAuthState();
    const persisted = Array.isArray(stored) ? stored : [];
    const callerOwned = persisted
      .filter((item): item is McpServerRecord => Boolean(item?.serverId))
      .filter((item) => !isGatewayOwnedMcpServerUrl(item.url) && !GATEWAY_OWNED_MCP_SERVER_IDS.has(item.serverId))
      .map((item) => ({
        ...item,
        category: item.category ?? inferMcpCategory(item.transport),
        trustTier: item.trustTier ?? "restricted",
        costTier: item.costTier ?? "unknown",
        policy: normalizeMcpPolicy(item.policy),
        authState: buildPublicMcpAuthState(item, authRows[item.serverId]),
      }));
    return [...buildGatewayOwnedInternalMcpServers(authRows), ...callerOwned];
  }

  /** @internal */ public writeMcpServers(servers: McpServerRecord[]): void {
    this.storage.systemSettings.set(
      MCP_SERVERS_SETTING_KEY,
      servers
        .filter(
          (server) => !isGatewayOwnedMcpServerUrl(server.url) && !GATEWAY_OWNED_MCP_SERVER_IDS.has(server.serverId),
        )
        .map((server) => {
          const persisted = { ...server };
          delete persisted.authState;
          return persisted;
        }),
    );
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
    actorContext?: ToolPolicyActorContext,
  ): Promise<McpToolRecord[]> {
    if (isInternalMcpApprovalInboxServer(server)) {
      return createInternalMcpApprovalInboxTools(server.serverId);
    }
    if (isInternalMcpDurableTasksServer(server)) {
      return createInternalMcpDurableTasksTools(server.serverId);
    }
    if (server.transport === "stdio") {
      const discovered = await discoverMcpTools(server, undefined, { actorContext });
      if (discovered.length > 0) {
        return discovered;
      }
    }
    if (server.transport === "http" || server.transport === "sse") {
      const discovered = await discoverMcpTools(server, undefined, {
        networkAllowlist: this.config.toolPolicy.sandbox.networkAllowlist,
        oauthAccessTokenResolver: (mcpServer) => this.mcpOAuth.resolveAccessToken(mcpServer),
        actorContext,
      });
      if (discovered.length > 0) {
        return discovered;
      }
    }
    return inferMcpToolsForServer(server, existingTools);
  }

  /** @internal */ public readMcpTools(): McpToolRecord[] {
    const stored = this.storage.systemSettings.get<McpToolRecord[]>(MCP_TOOLS_SETTING_KEY)?.value;
    const persisted = Array.isArray(stored) ? stored : [];
    const callerOwned = persisted.filter(
      (item): item is McpToolRecord =>
        Boolean(item?.serverId && item?.toolName) && !GATEWAY_OWNED_MCP_SERVER_IDS.has(item.serverId),
    );
    return [...buildGatewayOwnedInternalMcpTools(), ...callerOwned];
  }

  /** @internal */ public writeMcpTools(tools: McpToolRecord[]): void {
    this.storage.systemSettings.set(
      MCP_TOOLS_SETTING_KEY,
      tools.filter((tool) => !GATEWAY_OWNED_MCP_SERVER_IDS.has(tool.serverId)),
    );
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
    const metadata = this.readSkillStateMetadata();

    return new Map(
      rows.map((row) => [
        row.skillId,
        {
          ...row,
          pinned: metadata[row.skillId]?.pinned,
          usageCount: metadata[row.skillId]?.usageCount,
          lastUsedAt: metadata[row.skillId]?.lastUsedAt,
        },
      ]),
    );
  }

  private readSkillStateMetadata(): Record<string, { pinned?: boolean; usageCount?: number; lastUsedAt?: string }> {
    const value = this.storage.systemSettings.get<
      Record<string, { pinned?: boolean; usageCount?: number; lastUsedAt?: string }>
    >(SKILL_STATE_METADATA_SETTING_KEY)?.value;
    if (!value || typeof value !== "object") {
      return {};
    }
    const output: Record<string, { pinned?: boolean; usageCount?: number; lastUsedAt?: string }> = {};
    for (const [skillId, metadata] of Object.entries(value)) {
      if (!isRecord(metadata)) {
        continue;
      }
      output[skillId] = {
        pinned: metadata.pinned === true ? true : undefined,
        usageCount:
          typeof metadata.usageCount === "number" && metadata.usageCount >= 0 ? metadata.usageCount : undefined,
        lastUsedAt: typeof metadata.lastUsedAt === "string" ? metadata.lastUsedAt : undefined,
      };
    }
    return output;
  }

  private recordSkillUsage(skillIds: string[]): void {
    const uniqueSkillIds = [...new Set(skillIds.filter((skillId) => skillId.trim().length > 0))];
    if (uniqueSkillIds.length === 0) {
      return;
    }
    const metadata = this.readSkillStateMetadata();
    const now = new Date().toISOString();
    for (const skillId of uniqueSkillIds) {
      const current = metadata[skillId] ?? {};
      metadata[skillId] = {
        ...current,
        usageCount: (current.usageCount ?? 0) + 1,
        lastUsedAt: now,
      };
    }
    this.storage.systemSettings.set(SKILL_STATE_METADATA_SETTING_KEY, metadata);
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

  public async close(): Promise<void> {
    this.closing = true;
    this.chatProactiveService.stopScheduler();
    this.improvementService.stopScheduler();
    this.durableRunService.stopWorker();
    this.approvalEffectsService.stopWorker();
    this.chatTurnExecutionRegistry?.close("Gateway service is closing.");
    this.promptPackService?.close();
    if (this.maintenanceScheduler) {
      this.maintenanceScheduler.stop();
      this.maintenanceScheduler = undefined;
    }
    if (this.orchestrationWorktreeReapScheduler) {
      this.orchestrationWorktreeReapScheduler.stop();
      this.orchestrationWorktreeReapScheduler = undefined;
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
    const sessionGrants = this.listActiveToolGrants("session", sessionId);
    const workspaceId = this.storage.chatSessionMeta.get(sessionId)?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const inheritedGrants = [
      ...this.listActiveToolGrants("global", "global"),
      ...this.listActiveToolGrants("agent", "assistant"),
      ...this.listActiveToolGrants("workspace", workspaceId),
    ];
    const activeGrants = [...sessionGrants, ...inheritedGrants];
    const hasActiveDeny = activeGrants.some(
      (grant) => grant.decision === "deny" && grantPatternMatches(grant.toolPattern, toolName),
    );
    if (hasActiveDeny) {
      this.publishRealtime("system", "tools", {
        type: "internal_tool_grant_blocked",
        sessionId,
        toolName,
        createdBy,
        reason: "deny-wins",
      });
      throw new Error(`Internal tool grant for ${toolName} is blocked by an active deny policy.`);
    }
    const hasActiveAllow = sessionGrants.some(
      (grant) => grant.decision === "allow" && grantPatternMatches(grant.toolPattern, toolName),
    );
    if (hasActiveAllow) {
      return;
    }
    const expiresAt = new Date(Date.now() + INTERNAL_TOOL_GRANT_TTL_MS).toISOString();
    this.policyEngine.createGrant({
      toolPattern: toolName,
      decision: "allow",
      scope: "session",
      scopeRef: sessionId,
      grantType: "ttl",
      createdBy,
      expiresAt,
    });
    this.publishRealtime("system", "tools", {
      type: "internal_tool_grant_created",
      sessionId,
      toolName,
      createdBy,
      expiresAt,
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
      const channelStatus = typeof result.deliveryStatus === "string" ? result.deliveryStatus : "degraded";
      throw new Error(`${toolName} ${channelStatus}: ${detail}`);
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

  public publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): RealtimeEvent {
    return this.realtimeEventService.publishRealtime(eventType, source, payload, options);
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

  /** @internal */ public async resolveRuntimeGuidance(workspaceId: string): Promise<ResolvedRuntimeGuidance> {
    return this.guidanceService.resolveRuntimeGuidance(workspaceId);
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
    return chatThreadKnowledgeService.resolveThreadKnowledgeContext(
      this.buildChatThreadKnowledgeDependencies(),
      sessionId,
      query,
    );
  }

  private async buildLlmMessagesFromTranscript(
    sessionId: string,
    options?: {
      providerId?: string;
      model?: string;
      guidanceSystemInstruction?: ChatCompletionRequest["messages"][number]["content"];
    },
  ): Promise<ChatCompletionRequest["messages"]> {
    return chatMessageHistoryService.buildLlmMessagesFromTranscript(
      this.buildChatMessageHistoryDependencies(),
      sessionId,
      options,
    );
  }

  private listHydratedChatTurnTraces(
    sessionId: string,
    limit = 200,
    options?: chatTurnTraceHydration.ChatTurnTraceHydrationOptions,
  ): ChatTurnTraceRecord[] {
    return chatTurnTraceHydration.listHydratedChatTurnTraces(this, sessionId, limit, options);
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
      guidanceSystemInstruction?: ChatCompletionRequest["messages"][number]["content"];
    },
    state?: Awaited<ReturnType<GatewayService["loadChatTurnSessionState"]>>,
  ): Promise<ChatCompletionRequest["messages"]> {
    return chatMessageHistoryService.buildLlmMessagesFromBranchPath(
      this.buildChatMessageHistoryDependencies(),
      sessionId,
      pathTurnIds,
      currentUserMessage,
      options,
      state,
    );
  }

  private buildUserMessageContent(
    message: ChatMessageRecord,
    supportsVision: boolean,
  ): Promise<string | Array<Record<string, unknown>>> {
    return chatTurnUserMessage.buildUserMessageContent(
      this.buildChatTurnUserMessageDependencies(),
      message,
      supportsVision,
    );
  }

  private buildUserMessagePrompt(message: ChatMessageRecord): string {
    return chatTurnUserMessage.buildUserMessagePrompt(message);
  }

  private resolveMessageAttachments(message: ChatMessageRecord): ChatAttachmentRecord[] {
    return chatTurnUserMessage.resolveMessageAttachments(this.buildChatTurnUserMessageDependencies(), message);
  }

  private buildAttachmentPromptContext(input: unknown, supportsVision = false): string | undefined {
    return chatTurnUserMessage.buildAttachmentPromptContext(
      this.buildChatTurnUserMessageDependencies(),
      input,
      supportsVision,
    );
  }

  private buildAttachmentMessageParts(
    input: unknown,
    prompt: string,
    supportsVision: boolean,
  ): Promise<Array<Record<string, unknown>> | undefined> {
    return chatTurnUserMessage.buildAttachmentMessageParts(
      this.buildChatTurnUserMessageDependencies(),
      input,
      prompt,
      supportsVision,
    );
  }

  private buildChatTurnUserMessageDependencies(): chatTurnUserMessage.ChatTurnUserMessageDependencies {
    return {
      storage: this.storage,
      readChatAttachmentContent: (attachmentId) => this.readChatAttachmentContent(attachmentId),
    };
  }

  private buildChatMessageHistoryDependencies(): chatMessageHistoryService.ChatMessageHistoryDependencies {
    return {
      storage: this.storage,
      llmService: this.llmService,
      readTranscriptOrEmpty: (sessionId) => this.readTranscriptOrEmpty(sessionId),
      loadChatTurnSessionState: (sessionId) => this.loadChatTurnSessionState(sessionId),
      buildUserMessageContent: (message, supportsVision) => this.buildUserMessageContent(message, supportsVision),
      getModelTokenMultiplier: (providerId, model) => this.llmService.getModelTokenMultiplier(providerId, model),
    };
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
        action: job.action,
        actionConfig: job.actionConfig,
        description: job.description,
        schedule: job.schedule,
        enabled: job.enabled,
        endAt: job.endAt,
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

export function findPlanPhase(plan: OrchestrationPlan, phaseId: string) {
  for (const wave of plan.waves) {
    const phase = wave.phases.find((item) => item.phaseId === phaseId);
    if (phase) {
      return phase;
    }
  }
  return undefined;
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
    pinnedGoal?: string;
    goalTurnBudget?: number;
    goalTurnsUsed?: number;
    goalSetAt?: string;
  },
  project?: ChatProjectRecord,
  extras?: Partial<Pick<ChatSessionRecord, "searchHits" | "lastHandoff" | "delegationParent" | "generatedArtifacts">>,
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
    delegationParent: extras?.delegationParent,
    generatedArtifacts: extras?.generatedArtifacts,
    channel: session.channel,
    account: session.account,
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastActivityAt,
    tokenTotal: session.tokenTotal,
    costUsdTotal: session.costUsdTotal,
    pinnedGoal: meta.pinnedGoal,
    goalTurnBudget: meta.goalTurnBudget,
    goalTurnsUsed: meta.goalTurnsUsed,
    goalSetAt: meta.goalSetAt,
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
    parts: chatMessageHistoryService.parseMessageParts(message.parts),
    attachments: chatMessageHistoryService.parseMessageAttachments(message.attachments),
  };
}

interface McpAuthStateRecord {
  accessTokenRef?: string;
  refreshTokenRef?: string;
  tokenExpiresAt?: string;
  oauthState?: string;
  scopes?: string[];
  updatedAt: string;
  lastRefreshedAt?: string;
  error?: string;
  lastCodePreview?: string;
}

function buildGatewayOwnedInternalMcpServers(authRows: Record<string, McpAuthStateRecord>): McpServerRecord[] {
  return [
    buildGatewayOwnedInternalMcpServer("goatcitadel-internal-approval-inbox", MCP_APPROVAL_INBOX_URL, authRows),
    buildGatewayOwnedInternalMcpServer("goatcitadel-internal-durable-tasks", MCP_DURABLE_TASKS_URL, authRows),
  ].filter((server): server is McpServerRecord => Boolean(server));
}

function buildGatewayOwnedInternalMcpServer(
  serverId: string,
  url: string,
  authRows: Record<string, McpAuthStateRecord>,
): McpServerRecord | undefined {
  const template = MCP_SERVER_TEMPLATES.find((item) => item.url === url);
  if (!template) {
    return undefined;
  }
  const server: McpServerRecord = {
    serverId,
    label: template.label,
    transport: template.transport,
    command: template.command,
    args: template.args,
    url: template.url,
    authType: template.authType,
    oauth: template.oauth,
    enabled: true,
    status: "connected",
    category: template.category,
    trustTier: template.trustTier,
    costTier: template.costTier,
    policy: normalizeMcpPolicy(template.policy),
    verifiedAt: GATEWAY_OWNED_MCP_CREATED_AT,
    lastConnectedAt: GATEWAY_OWNED_MCP_CREATED_AT,
    createdAt: GATEWAY_OWNED_MCP_CREATED_AT,
    updatedAt: GATEWAY_OWNED_MCP_CREATED_AT,
  };
  return {
    ...server,
    authState: buildPublicMcpAuthState(server, authRows[serverId]),
  };
}

function buildGatewayOwnedInternalMcpTools(): McpToolRecord[] {
  return [
    ...createInternalMcpApprovalInboxTools("goatcitadel-internal-approval-inbox"),
    ...createInternalMcpDurableTasksTools("goatcitadel-internal-durable-tasks"),
  ];
}

function isGatewayOwnedMcpServerUrl(url: string | undefined): boolean {
  const normalized = url?.trim().toLowerCase();
  return normalized === MCP_APPROVAL_INBOX_URL || normalized === MCP_DURABLE_TASKS_URL;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
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
    | "speedMode"
    | "subagentPolicy"
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
    | "speedMode"
    | "subagentPolicy"
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
    speedMode: input.speedMode,
    subagentPolicy: input.subagentPolicy,
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

function canMutatePermissionProfile(profile: PermissionProfileRecord, actorId: string): boolean {
  if (profile.builtin) {
    return false;
  }
  if (profile.scope === "operator") {
    return profile.scopeRef === actorId && profile.createdBy === actorId;
  }
  if (profile.scope === "workspace") {
    return profile.createdBy === actorId;
  }
  return false;
}

function readRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalRecordString(record: Record<string, unknown>, key: string): string | undefined {
  return readRecordString(record, key);
}

function stableRecordStringify(value: unknown): string {
  return JSON.stringify(sortRecordValue(value));
}

function sortRecordValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortRecordValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortRecordValue((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

function readPermissionSurfaceValue(value: unknown): PermissionSurface | undefined {
  return value === "chat" ||
    value === "cowork" ||
    value === "code" ||
    value === "tools" ||
    value === "mcp" ||
    value === "all"
    ? value
    : undefined;
}

function readAuthActorSource(value: unknown): ToolPolicyActorContext["authActorSource"] | undefined {
  return value === "none" ||
    value === "token" ||
    value === "basic" ||
    value === "loopback" ||
    value === "sse" ||
    value === "device" ||
    value === "companion"
    ? value
    : undefined;
}

function isApprovedExternalRuntimePendingAction(
  pending: PendingApprovalAction | undefined,
): pending is PendingApprovalAction {
  if (!pending || pending.actionType !== "tool.invoke" || pending.resolutionStatus !== "pending") {
    return false;
  }
  if (pending.request.externalRuntime === true) {
    return true;
  }
  return readRecordString(pending.request, "toolName") === "mcp.invoke";
}

function approvedExternalRuntimeRequestMatches(
  storedRequest: Record<string, unknown>,
  request: ToolInvokeRequest,
): boolean {
  return (
    readRecordString(storedRequest, "toolName") === request.toolName &&
    stableRecordStringify(isRecord(storedRequest.args) ? storedRequest.args : {}) ===
      stableRecordStringify(request.args ?? {}) &&
    readRecordString(storedRequest, "agentId") === request.agentId &&
    readRecordString(storedRequest, "sessionId") === request.sessionId &&
    readOptionalRecordString(storedRequest, "workspaceId") === (request.workspaceId ?? undefined) &&
    readOptionalRecordString(storedRequest, "taskId") === (request.taskId ?? undefined) &&
    readOptionalRecordString(storedRequest, "runId") === (request.runId ?? undefined) &&
    readOptionalRecordString(storedRequest, "permissionProfileId") === (request.permissionProfileId ?? undefined) &&
    readOptionalRecordString(storedRequest, "localOperatorOverrideId") ===
      (request.localOperatorOverrideId ?? undefined) &&
    readPermissionSurfaceValue(storedRequest.surface) === request.surface &&
    stableRecordStringify(isRecord(storedRequest.policyContext) ? storedRequest.policyContext : {}) ===
      stableRecordStringify(request.policyContext ?? {})
  );
}

function toToolInvokeRequest(record: Record<string, unknown>, signal?: AbortSignal): ToolInvokeRequest {
  const toolName = readRecordString(record, "toolName");
  const agentId = readRecordString(record, "agentId");
  const sessionId = readRecordString(record, "sessionId");
  if (!toolName || !agentId || !sessionId) {
    throw new Error("Invalid pending tool approval request payload.");
  }
  const consentContext = isRecord(record.consentContext) ? record.consentContext : undefined;
  return {
    toolName,
    args: isRecord(record.args) ? record.args : {},
    agentId,
    sessionId,
    workspaceId: readRecordString(record, "workspaceId"),
    taskId: readRecordString(record, "taskId"),
    runId: readRecordString(record, "runId"),
    signal,
    permissionProfileId: readRecordString(record, "permissionProfileId"),
    localOperatorOverrideId: readRecordString(record, "localOperatorOverrideId"),
    surface: readPermissionSurfaceValue(record.surface),
    policyContext: isRecord(record.policyContext) ? (record.policyContext as ToolPolicyActorContext) : undefined,
    consentContext: consentContext
      ? {
          operatorId: readRecordString(consentContext, "operatorId"),
          source:
            consentContext.source === "ui" || consentContext.source === "tui" || consentContext.source === "agent"
              ? consentContext.source
              : undefined,
          reason: readRecordString(consentContext, "reason"),
        }
      : undefined,
    externalRuntime: record.externalRuntime === true ? true : undefined,
  };
}

function withExternalRuntimePolicyContext(
  request: ToolInvokeRequest,
  policyResult: ToolInvokeResult,
): ToolInvokeRequest {
  const rawPolicyContext = policyResult.result?.policyContext;
  if (!isRecord(rawPolicyContext)) {
    return request;
  }
  const evaluated = rawPolicyContext as ToolPolicyActorContext;
  return {
    ...request,
    policyContext: {
      ...(request.policyContext ?? {}),
      ...evaluated,
      matchedGrantAllowedHosts:
        evaluated.matchedGrantAllowedHosts && evaluated.matchedGrantAllowedHosts.length > 0
          ? evaluated.matchedGrantAllowedHosts
          : request.policyContext?.matchedGrantAllowedHosts,
    },
  };
}

function toApprovedMcpInvokeRequest(request: ToolInvokeRequest, signal?: AbortSignal): McpInvokeRequest {
  const serverId = typeof request.args.serverId === "string" ? request.args.serverId.trim() : "";
  const toolName = typeof request.args.toolName === "string" ? request.args.toolName.trim() : "";
  if (!serverId || !toolName) {
    throw new Error("Invalid approved MCP invocation payload.");
  }
  return {
    serverId,
    toolName,
    arguments: isRecord(request.args.arguments) ? request.args.arguments : {},
    agentId: request.agentId,
    sessionId: request.sessionId,
    workspaceId: request.workspaceId,
    taskId: request.taskId,
    runId: request.runId,
    permissionProfileId: request.permissionProfileId,
    localOperatorOverrideId: request.localOperatorOverrideId,
    surface: request.surface,
    policyContext: request.policyContext,
    consentContext: request.consentContext,
    signal,
  };
}

function toolInvokeResultFromMcpApproval(
  policyResult: ToolInvokeResult,
  mcpResult: McpInvokeResponse,
): ToolInvokeResult {
  const result = {
    externalRuntime: true,
    toolName: "mcp.invoke",
    ok: mcpResult.ok,
    output: mcpResult.output,
    contentItems: mcpResult.contentItems,
    diagnostics: mcpResult.diagnostics,
    error: mcpResult.ok ? undefined : mcpResult.error,
  };
  if (!mcpResult.ok) {
    return {
      ...policyResult,
      outcome: "blocked",
      policyReason: `MCP runtime failed after approval: ${mcpResult.error ?? "unknown error"}`,
      result,
    };
  }
  return {
    ...policyResult,
    outcome: "executed",
    policyReason: `${policyResult.policyReason}; MCP runtime executed after approval`,
    result,
  };
}

function toolInvokeResultRecord(result: ToolInvokeResult): Record<string, unknown> {
  return {
    outcome: result.outcome,
    policyReason: result.policyReason,
    auditEventId: result.auditEventId,
    result: result.result,
  };
}

function grantPatternMatches(pattern: string, toolName: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(toolName);
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

function isChatTurnDegradedRecord(value: unknown): boolean {
  return isRecord(value) && typeof value.reason === "string" && typeof value.recoveredByModel === "boolean";
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
    (value.provenance === undefined || isMemoryCitationProvenanceRecord(value.provenance)) &&
    (value.sourceType === undefined ||
      value.sourceType === "web" ||
      value.sourceType === "file" ||
      value.sourceType === "tool" ||
      value.sourceType === "memory")
  );
}

function isMemoryCitationProvenanceRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.relationScope === "self" || value.relationScope === "peer" || value.relationScope === "project") &&
    (value.freshness === "fresh" ||
      value.freshness === "recent" ||
      value.freshness === "stale" ||
      value.freshness === "unknown") &&
    typeof value.selectionReason === "string" &&
    (value.retrievalStrategy === undefined ||
      value.retrievalStrategy === "lexical_recency" ||
      value.retrievalStrategy === "semantic_hints" ||
      value.retrievalStrategy === "semantic_vector") &&
    (value.matchSignals === undefined || isMemoryRetrievalMatchSignalsRecord(value.matchSignals)) &&
    (value.sourceTimestamp === undefined || typeof value.sourceTimestamp === "string")
  );
}

function isMemoryRetrievalMatchSignalsRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.lexicalScore === "number" &&
    Number.isFinite(value.lexicalScore) &&
    typeof value.semanticHintScore === "number" &&
    Number.isFinite(value.semanticHintScore) &&
    (value.semanticVectorScore === undefined ||
      (typeof value.semanticVectorScore === "number" && Number.isFinite(value.semanticVectorScore))) &&
    typeof value.recencyScore === "number" &&
    Number.isFinite(value.recencyScore) &&
    typeof value.diversityScore === "number" &&
    Number.isFinite(value.diversityScore) &&
    typeof value.totalScore === "number" &&
    Number.isFinite(value.totalScore)
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
            ...(isChatTurnDegradedRecord(value.degraded)
              ? { degraded: value.degraded as { reason: string; recoveredByModel: boolean } }
              : {}),
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

const CHANNEL_DELIVERY_DEFAULT_CHUNK_LIMIT = 3_900;
const CHANNEL_DELIVERY_CHUNK_LIMITS: Record<string, number> = {
  discord: 1_900,
  telegram: 3_900,
  whatsapp: 3_500,
  line: 4_500,
  "nextcloud-talk": 3_900,
  slack: 32_000,
};

function buildChannelDeliveryPayload(input: ChannelSendInput, channelKey: string): Record<string, unknown> {
  const sanitized = sanitizeChannelOutboundMessage(input.message ?? "");
  const chunkLimit = getChannelDeliveryChunkLimit(channelKey);
  const messageParts = splitChannelOutboundMessage(sanitized.message, chunkLimit);
  const deliveryDiagnostics = buildChannelDeliveryDiagnostics(sanitized.message, messageParts, chunkLimit);
  return {
    connectionId: input.connectionId,
    target: input.target,
    message: messageParts[0] ?? "",
    messageParts: messageParts.length > 1 ? messageParts : undefined,
    deliveryDiagnostics,
    attachments: input.attachments,
    attachmentIds: input.attachmentIds,
    interactiveActions: input.interactiveActions,
    replyToMessageId: input.replyToMessageId,
    replyToPartIndex: input.replyToPartIndex,
    effectId: input.effectId,
    subject: input.subject,
    commitmentId: input.commitmentId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    taskId: input.taskId,
    runId: input.runId,
    operatorId: input.operatorId,
    authActorId: input.authActorId,
    authActorSource: input.authActorSource,
    permissionProfileId: input.permissionProfileId,
    localOperatorOverrideId: input.localOperatorOverrideId,
    surface: input.surface,
  };
}

function isSystemOwnedRestrictedPermissionProfileRequest(
  profileId: string,
  input: {
    operatorId?: string;
    authActorId?: string;
    authActorSource?: ToolPolicyActorContext["authActorSource"];
  },
): boolean {
  if (profileId !== SCHEDULED_TURN_PERMISSION_PROFILE_ID && profileId !== HEARTBEAT_PERMISSION_PROFILE_ID) {
    return false;
  }
  if (input.authActorSource !== "none") {
    return false;
  }
  const operatorId = input.operatorId?.trim();
  const authActorId = input.authActorId?.trim();
  return Boolean(
    operatorId &&
    authActorId &&
    operatorId === authActorId &&
    (operatorId === "system-cron" || operatorId === "system"),
  );
}

function getChannelDeliveryChunkLimit(channelKey: string): number {
  return CHANNEL_DELIVERY_CHUNK_LIMITS[channelKey.toLowerCase()] ?? CHANNEL_DELIVERY_DEFAULT_CHUNK_LIMIT;
}

function splitChannelOutboundMessage(message: string, maxPartUtf16Length: number): string[] {
  if (!message) {
    return [""];
  }
  if (message.length <= maxPartUtf16Length) {
    return [message];
  }
  const parts = splitUnicodeGraphemes(message);
  const chunks: string[] = [];
  let current = "";
  for (const part of parts) {
    if (current && current.length + part.length > maxPartUtf16Length) {
      chunks.push(current);
      current = "";
    }
    current += part;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function splitUnicodeGraphemes(message: string): string[] {
  const SegmenterCtor = Intl.Segmenter;
  if (typeof SegmenterCtor === "function") {
    const segmenter = new SegmenterCtor(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(message)].map((item) => item.segment);
  }
  return Array.from(message);
}

function buildChannelDeliveryDiagnostics(
  message: string,
  messageParts: string[],
  maxPartUtf16Length: number,
): ChannelDeliveryDiagnostics | undefined {
  if (messageParts.length <= 1) {
    return undefined;
  }
  return {
    chunking: {
      mode: "unicode_safe",
      originalCodePointLength: splitUnicodeGraphemes(message).length,
      partCount: messageParts.length,
      maxPartUtf16Length,
      parts: messageParts.map((part, index) => ({
        partIndex: index,
        codePointLength: splitUnicodeGraphemes(part).length,
        utf16Length: part.length,
      })),
    },
  };
}

function channelDeliveryPayloadToSendInput(input: ChannelDeliveryRuntimeSendInput): ChannelSendInput {
  const payload = input.payload;
  return {
    connectionId: readRequiredString(payload.connectionId, "connectionId"),
    target: readRequiredString(payload.target, "target"),
    message: typeof payload.message === "string" ? payload.message : "",
    attachments: Array.isArray(payload.attachments)
      ? (payload.attachments as ChannelSendInput["attachments"])
      : undefined,
    attachmentIds: Array.isArray(payload.attachmentIds) ? (payload.attachmentIds as string[]) : undefined,
    interactiveActions:
      typeof payload.interactiveActions === "object" && payload.interactiveActions !== null
        ? (payload.interactiveActions as ChannelSendInput["interactiveActions"])
        : undefined,
    replyToMessageId: typeof payload.replyToMessageId === "string" ? payload.replyToMessageId : undefined,
    replyToPartIndex: typeof payload.replyToPartIndex === "number" ? payload.replyToPartIndex : undefined,
    effectId: typeof payload.effectId === "string" ? payload.effectId : undefined,
    subject: typeof payload.subject === "string" ? payload.subject : undefined,
    commitmentId: typeof payload.commitmentId === "string" ? payload.commitmentId : undefined,
    workspaceId: typeof payload.workspaceId === "string" ? payload.workspaceId : undefined,
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
    agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
    taskId: typeof payload.taskId === "string" ? payload.taskId : undefined,
    runId: typeof payload.runId === "string" ? payload.runId : undefined,
    operatorId: typeof payload.operatorId === "string" ? payload.operatorId : undefined,
    authActorId: typeof payload.authActorId === "string" ? payload.authActorId : undefined,
    authActorSource: readAuthActorSource(payload.authActorSource),
    permissionProfileId: typeof payload.permissionProfileId === "string" ? payload.permissionProfileId : undefined,
    localOperatorOverrideId:
      typeof payload.localOperatorOverrideId === "string" ? payload.localOperatorOverrideId : undefined,
    surface: readPermissionSurface(payload.surface),
  };
}

function readChannelDeliveryMessageParts(payload: Record<string, unknown>): string[] {
  const parts = Array.isArray(payload.messageParts)
    ? payload.messageParts
    : Array.isArray(payload.deliveryChunks)
      ? payload.deliveryChunks
      : undefined;
  if (!parts) {
    return [];
  }
  return parts.filter((item): item is string => typeof item === "string");
}

function readDeliveryDiagnostics(value: unknown): ChannelDeliveryDiagnostics | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as ChannelDeliveryDiagnostics;
}

function readPermissionSurface(value: unknown): ChannelSendInput["surface"] | undefined {
  return value === "chat" ||
    value === "cowork" ||
    value === "code" ||
    value === "tools" ||
    value === "mcp" ||
    value === "all"
    ? value
    : undefined;
}

function legacyToolProfileToApprovalMode(profile: string | undefined): ToolApprovalMode | undefined {
  if (!profile) {
    return undefined;
  }
  return profile === "danger" ? "bypass" : "approve_risky";
}

function hasExplicitNonLoopbackAllowedOrigin(rawOrigins: string | undefined): boolean {
  if (!rawOrigins?.trim()) {
    return false;
  }
  return rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .some((origin) => {
      try {
        const parsed = new URL(origin);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return false;
        }
        return !isLoopbackDevOrigin(parsed.origin);
      } catch {
        return false;
      }
    });
}

function buildChannelDeliveryIdempotencyKey(input: ChannelSendInput, channelKey: string): string | undefined {
  const explicit = (input as ChannelSendInput & { idempotencyKey?: string }).idempotencyKey?.trim();
  if (explicit) {
    return explicit;
  }
  if (input.effectId?.trim()) {
    return `channel-delivery:effect:${input.effectId.trim()}`;
  }
  if (input.sessionId?.trim() && input.replyToMessageId?.trim()) {
    const hash = createHash("sha256")
      .update(JSON.stringify(buildChannelDeliveryPayload(input, channelKey)))
      .digest("hex");
    return `channel-delivery:session:${input.sessionId.trim()}:${input.replyToMessageId.trim()}:${hash}`;
  }
  if (input.taskId?.trim()) {
    const hash = createHash("sha256")
      .update(JSON.stringify(buildChannelDeliveryPayload(input, channelKey)))
      .digest("hex");
    return `channel-delivery:task:${input.taskId.trim()}:${hash}`;
  }
  return undefined;
}

function mapPersistedChannelDeliveryRuntimeStatus(
  status: "queued" | "sent" | "failed",
  deliveryStatus: string | undefined,
  staleReason: string | undefined,
): ChannelDeliveryRuntimeRecord["status"] {
  if (staleReason) {
    return "stale";
  }
  if (status === "sent") {
    return "sent";
  }
  if (status === "failed") {
    if (deliveryStatus === "manual_reconciliation_required") {
      return "manual_reconciliation_required";
    }
    return "failed";
  }
  return deliveryStatus === "retrying" ? "retrying" : "queued";
}

function extractCommsSendResult(result: ToolInvokeResult | Record<string, unknown>): Record<string, unknown> {
  if (isToolInvokeResultLike(result)) {
    if (result.outcome !== "executed") {
      throw new Error(result.policyReason || `channel.send returned ${result.outcome}`);
    }
    return result.result ?? {};
  }
  return result;
}

function isToolInvokeResultLike(value: unknown): value is ToolInvokeResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const outcome = (value as { outcome?: unknown }).outcome;
  return outcome === "executed" || outcome === "blocked" || outcome === "approval_required";
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(`Channel delivery payload is missing ${label}.`);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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
