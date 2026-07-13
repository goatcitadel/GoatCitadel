/* eslint-disable @typescript-eslint/no-unused-vars, max-lines */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isVerboseLoggingEnabled } from "../runtime-ux.js";
import { EventIngestService, logger } from "@goatcitadel/gateway-core";
import { traceInitStep, toLogContext } from "./gateway/bootstrap-tracing.js";

const log = logger.child("gateway-service");
const durableRunLogger: DurableRunServiceLogger = {
  info: (data: unknown, msg: string) => log.info(msg, toLogContext(data)),
  debug: (data: unknown, msg: string) => log.debug(msg, toLogContext(data)),
  warn: (data: unknown, msg: string) => log.warn(msg, toLogContext(data)),
  error: (data: unknown, msg: string) => log.error(msg, toLogContext(data)),
};

import { MeshService } from "@goatcitadel/mesh-core";
import { OrchestrationEngine, type TurnRuntime } from "@goatcitadel/orchestration";
import {
  type ApprovalCreateAuthority,
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
  ConflictError,
  DEFAULT_CITADEL_ID,
  inferProviderForModelId,
  isChatTurnActiveStatus,
  NotFoundError,
  PolicyViolationError,
  providerAllowsForeignModelIds,
  providerRecognizesModelId,
  ValidationError,
} from "@goatcitadel/contracts";
import { buildUnifiedConfigPayload } from "../config-sync-lib.js";
import { createGatewayStorage } from "../storage-factory.js";
import { DatabaseCutoverService } from "./database-cutover-service.js";
import { startBackgroundInterval, type BackgroundIntervalHandle } from "./background-scheduler.js";
import { PersonalityCatalogService } from "./channel-personalities.js";
import { ApprovalRuntimeService } from "./approval-runtime-service.js";
import type { ApprovalCreateCommitHook } from "./approval-lifecycle-service.js";
import * as approvalRemoteTokenService from "./approval-remote-token-service.js";
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
import { resolveUtilityModelOverride } from "./utility-model-routing.js";
import { AssemblyService } from "./assembly-service.js";
import { ApprovalExplainerService } from "./approval-explainer-service.js";
import { ApprovalWaitRunService } from "./approval-wait-run-service.js";
import { scoutCapabilityUpgradeSuggestions } from "./chat-capability-scout.js";
import { classifyCapabilityGapFromTrace } from "./capability-gap-classifier.js";
import { collectMcpBrowserFallbackTargets, invokeMcpRuntimeTool } from "./mcp-runtime.js";
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
import { ApprovalRemoteTokenSecretService } from "./approval-remote-token-secret.js";
import { GatewayTurnRuntime } from "./chat-turn-runtime.js";
import { ResearchService } from "./research-service.js";
import { ObsidianVaultService } from "./obsidian-vault-service.js";
import { SkillImportService } from "./skill-import-service.js";
import { SkillStateService } from "./skill-state-service.js";
import { GATEWAY_OWNED_MCP_SERVER_IDS, McpServerStore } from "./mcp-server-store.js";
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
import { CronAutomationService } from "./gateway/cron-automation-service.js";
import {
  runCostReportSchedulerIfDue,
  runMemoryConsolidationSchedulerIfDue,
  runMemoryFlushSchedulerIfDue,
  runPrivateBetaBackupSchedulerIfDue,
  runUpdateReviewSchedulerIfDue,
  type SystemCronSchedulerDeps,
  type SystemCronSchedulerOptions,
} from "./gateway/system-cron-schedulers.js";
import {
  EXISTING_LEARNINGS_DEDUP_LIMIT,
  MEMORY_CONSOLIDATION_WATERMARK_SETTING_KEY,
  MemoryConsolidationService,
  PENDING_CANDIDATES_DEDUP_LIMIT,
} from "./memory-consolidation-service.js";
import { runNoAgentCommand } from "./gateway/cron-no-agent-runner.js";
import type { AgentTurnCronRunOutcome } from "./gateway/cron-agent-turn-support.js";
import { type AutonomousTurnKind } from "./gateway/autonomous-turn-policy.js";
import {
  type ChatAutonomousTurnDeps,
  enqueueAutonomousChatTurn,
  isHeartbeatEligibleSession,
  runCommitmentSweep,
  runCronAgentTurn,
  runHeartbeatSweep,
  scheduleManage,
} from "./chat-autonomous-turn-service.js";
import {
  applyRepairPolicyCandidate,
  applyRoutingPolicyCandidate,
  applySkillRevisionCandidate,
  captureRepairPolicySnapshot,
  captureRoutingPolicySnapshot,
  captureSkillRevisionSnapshot,
  type ImprovementSnapshotDeps,
  restoreRepairPolicySnapshot,
  restoreRoutingPolicySnapshot,
  restoreSkillRevisionSnapshot,
} from "./improvement-snapshot-service.js";
import type { BackgroundReviewService } from "./background-review-service.js";
import type { CommitmentClassifierService } from "./gateway/commitment-classifier-service.js";
import { createChatPostCommitRuntime } from "./gateway/chat-post-commit-runtime.js";
import * as orchestrationLifecycleService from "./orchestration-lifecycle-service.js";
import { OrchestrationPhaseExecutionService } from "./orchestration-phase-execution-service.js";
import { OrchestrationWorktreeService } from "./orchestration-worktree-service.js";
import { OperatorSummaryCache } from "./gateway/operator-summary-cache.js";
import { DiscordRuntimeService } from "./discord-runtime-service.js";
import { SignalInboundRuntimeService } from "./signal-inbound-runtime-service.js";
import { resolveGatewayInstallToken as resolveGatewayInstallTokenFromPlanner } from "./gateway/auth-credential-planner.js";
import type { GatewayRouteServices } from "./gateway-route-services.js";
import {
  buildIntegrationActionHostForGateway,
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
import { approveDryRun } from "./dry-run-commit-service.js";
import { invokeIntegrationConnectionAction } from "./integration-action-service.js";
import { buildGatewayExternalSideEffectReplayJob } from "./external-side-effect-replay-job-service.js";
import { RealtimeEventService } from "./realtime-event-service.js";
import { BackupRetentionService } from "./backup-retention-service.js";
import * as settingsAuthService from "./settings-auth-service.js";
import * as onboardingStateService from "./onboarding-state-service.js";
import * as mcpDiagnosticsService from "./mcp-diagnostics-service.js";
import * as mcpServerAdminService from "./mcp-server-admin-service.js";
import { McpOAuthTokenService } from "./mcp-oauth-token-service.js";
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
import { markChatTurnCancelled } from "./chat-turn-cancellation.js";
import { reconcileInterruptedChatTurns } from "./chat-turn-interruption-recovery-service.js";
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
import {
  ToolInvocationCoordinatorService,
  type ToolInvocationRuntimeOptions,
} from "./tool-invocation-coordinator-service.js";
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
import {
  buildUpdatedFeatureFlags,
  didDisengageAutonomyKillSwitch,
  resolveGatewayFeatureFlags,
} from "./gateway/feature-flags.js";
import {
  buildChannelDeliveryIdempotencyKey,
  buildChannelDeliveryPayload,
  mapPersistedChannelDeliveryRuntimeStatus,
  sendQueuedChannelDelivery as sendQueuedChannelDeliveryImpl,
} from "./gateway/channel-delivery-helpers.js";
import {
  assertDeploymentProfileUpdate as assertGatewayDeploymentProfileUpdate,
  assertFirecrawlRuntimeUpdate as assertGatewayFirecrawlRuntimeUpdate,
} from "./gateway/runtime-settings-guards.js";
import { isPermittedIntegrationSecretEnvVarName } from "./gateway/integration-secret-envvar-guard.js";
import {
  executeApprovedExternalRuntimePendingAction as executeApprovedExternalRuntimePendingActionWithPort,
  isApprovedExternalRuntimePendingAction,
  readAuthActorSource,
  readPermissionSurfaceValue,
  toolInvokeResultRecord,
} from "./gateway/external-runtime-approval-adapter.js";
import {
  canMutatePermissionProfile,
  grantPatternMatches,
  isSystemOwnedRestrictedPermissionProfileRequest,
} from "./gateway/tool-grant-policy.js";
import { durableChatTurnPayloadToRecord } from "./gateway/chat-stream-codecs.js";
import { GatewayChatStreamRuntime } from "./gateway/chat-stream-runtime.js";
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
import { detectDelegationRoles, truncateSummaryLine } from "./chat-turn-helpers.js";
import {
  collectSpecialistCandidateSuggestions,
  mergeSpecialistEvidence,
  mergeSpecialistRoutingHints,
  normalizeSpecialistCandidateFingerprint,
  type ResolvedRuntimeGuidance,
} from "./chat-turn-planning-helpers.js";
import { persistContextManifestForCompletionRequest } from "./llm-completion-memory-context.js";
import { stampLegacyOpenChannelInboundAccess } from "./channel-inbound-access-migration.js";
import { ChatProjectService } from "./chat-project-service.js";
import { computeDurableBaselineDrift, DurableRunService, type DurableRunServiceLogger } from "./durable-run-service.js";
import { DurableOperatorService } from "./durable-operator-service.js";
import { HooksService } from "./hooks-service.js";
import { ChatLearnedMemoryService } from "./chat-learned-memory-service.js";
import { PromptPackService } from "./prompt-pack-service.js";
import { ChatProactiveService } from "./chat-proactive-service.js";
import { toChatSessionRecord } from "./chat-session-utils.js";
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
import { VOICE_TRANSCRIPT_CONTENT_PREFIX } from "./channel-inbound-dispatch.js";
import { ReplayExecutionSkippedError } from "./replay-execution.js";
import {
  evaluateDeploymentProfileToolAccess,
  policyContextHasOperatorApproval,
} from "../browser-runtime-guardrails.js";
import { buildGatewayConnectorRecords, filterConnectorRecords } from "./connector-registry.js";
import { isTelegramApprovalActionConnectorReady } from "./channel-secret-resolution.js";
import { enqueueApprovalRemoteTokenConnectorDelivery } from "./approval-connector-delivery.js";
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
import { isVisibleMcpTemplateRecord } from "./mcp-template-visibility.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { applyMcpRedaction, wildcardMatch } from "./mcp-server-policy.js";
import { ApprovalEffectsService } from "./approval-resolution-effects-service.js";

export interface MemoryFileEntry {
  relativePath: string;
  size: number;
  modifiedAt: string;
}

export { parseDelegateCommand, parsePipelineCommand, parseSlashCommand } from "./chat-command-helpers.js";
export { splitChatPrefsPatch, toChatSessionRecord } from "./chat-session-utils.js";
export { isPermittedIntegrationSecretEnvVarName as __isPermittedIntegrationSecretEnvVarNameForTests } from "./gateway/integration-secret-envvar-guard.js";

const DISCORD_PAIRINGS_SETTING_KEY = "discord_pairings_v1";
const FEATURE_FLAGS_SETTING_KEY = "feature_flags_v1";
// Perf (Finding 6): the resolved feature-flag set is read 5-15x per chat turn, each
// call previously issuing a synchronous systemSettings.get (a blocking worker
// round-trip on Postgres). Memoize it for a short window; the sole writer
// (updateFeatureFlags) primes the cache, so this TTL only bounds staleness for any
// hypothetical out-of-band settings write.
const FEATURE_FLAGS_CACHE_TTL_MS = 1_000;
import { DeviceTokenVault } from "./device-token-vault.js";

export const MEMORY_ITEM_STATUS_VALUES = new Set(["active", "forgotten"]);

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

export const PRIVATE_BETA_BACKUP_SCHEDULE_LABEL = "30 2 * * * America/Los_Angeles";
export const MEMORY_FLUSH_DAILY_SCHEDULE_LABEL = "0 3 * * * America/Los_Angeles";
export const COST_REPORT_HOURLY_SCHEDULE_LABEL = "0 * * * * America/Los_Angeles";
export const UPDATE_REVIEW_DAILY_SCHEDULE_LABEL = "15 4 * * * America/Los_Angeles";
/**
 * P2-S1 background-review counter gate. A successful, eligible root turn bumps
 * this counter; the self-improvement review runs (and resets it) once it reaches
 * {@link BACKGROUND_REVIEW_TURN_INTERVAL}. Stored in `system_settings`.
 */
const BACKGROUND_REVIEW_TURNS_SINCE_SETTING_KEY = "background_review_turns_since_v1";
const BACKGROUND_REVIEW_TURN_INTERVAL = 5;
const IMPROVEMENT_SCHEDULER_INTERVAL_MS = 60_000;
const maintenanceSchedulerDisabled =
  process.env.GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER?.trim().toLowerCase() === "true";
// Orphaned orchestration worktrees (no live/active run) accumulate unbounded
// without periodic reaping. Reap hourly, with a short post-boot pass so a fresh
// process reclaims stale worktrees promptly. reapOrphaned stays conservative
// via its own active-run + min-age (~1h) + path-jail guards.
const ORCHESTRATION_WORKTREE_REAP_INTERVAL_MS = 60 * 60 * 1000;
const ORCHESTRATION_WORKTREE_REAP_BOOT_DELAY_MS = 30_000;
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
  public readonly approvalRemoteTokenSecrets: ApprovalRemoteTokenSecretService;
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
  public readonly signalInboundRuntimeService: SignalInboundRuntimeService;
  private readonly chatProjectService: ChatProjectService;
  public readonly durableRunService: DurableRunService;
  private readonly durableOperatorService: DurableOperatorService;
  private readonly skillStateService: SkillStateService;
  private readonly mcpServerStore: McpServerStore;
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
  public readonly memoryConsolidationService: MemoryConsolidationService;
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
  private featureFlagsCache?: RuntimeSettings["features"];
  private featureFlagsCacheAtMs = 0;
  private readonly warnedOutsideRootPathFingerprints = new Set<string>();
  private readonly chatMessageProjectionBackfillAttempted = new Set<string>();
  private readonly syntheticPermissionProfiles = new Map<string, PermissionProfileRecord>();
  public readonly recentChannelSetupTests = new Map<string, ChannelSetupRecentTestCacheEntry>();
  public readonly deviceTokenVault = new DeviceTokenVault();
  private chatStreamRuntime?: GatewayChatStreamRuntime;
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
      // Tool-policy approval creation must enter the canonical lifecycle. A
      // direct policy-engine storage write would omit the durable wait run and
      // retryable approval observability envelope.
      createApproval: (input, onCreated, authority) => this.createApproval(input, onCreated, authority),
      assertBrowserSessionAccess: (check) => this.browserSessionRuntimeService.assertAccess(check),
      resolveApprovalActionTokenSecret: (secretRef) => this.approvalRemoteTokenSecrets.resolve(secretRef),
      deleteApprovalActionTokenSecret: (secretRef) => this.approvalRemoteTokenSecrets.delete(secretRef),
      isApprovalActionConnectorReady: (connectionId) =>
        isTelegramApprovalActionConnectorReady(this.storage.integrationConnections, connectionId),
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
    this.approvalRemoteTokenSecrets = new ApprovalRemoteTokenSecretService(
      secretStore,
      this.storage.remoteActionTokens,
    );
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
      readSkillStates: () => this.skillStateService.readSkillStates(),
      invokeTool: (request) => this.invokeTool(request),
      createApproval: (input) => this.createApproval(input),
      resolveApproval: (approvalId, input) => this.resolveApproval(approvalId, input),
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
    this.turnRuntime = new GatewayTurnRuntime({
      storage: this.storage,
      listToolCatalog: () => this.listToolCatalog(),
      createChatCompletion: (request) => this.createChatCompletion(request),
      createChatCompletionStream: (request) => this.createChatCompletionStream(request),
      generateImage: (request) => this.llmService.generateImage(request),
      invokeTool: (request, options) => this.invokeTool(request, options),
      persistToolArtifact: (input) => chatToolArtifactService.persistChatToolArtifact(this, input),
      evaluateToolAccess: (request) => this.evaluateToolAccess(request),
      invokeMcpTool: (request, options) => this.invokeMcpTool(request, options),
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
    // Signal inbound poller (phase B1b): polls the local signal-cli bridge and
    // dispatches through the SAME inbound seam webhook channels use, so the
    // default-deny sender allowlist, bot-loop guard, and ingest idempotency
    // apply identically. Gated on signalInboundV1Enabled — sync() is a no-op
    // (and stops any pollers) while the flag is off.
    this.signalInboundRuntimeService = new SignalInboundRuntimeService({
      isEnabled: () => this.isFeatureEnabled("signalInboundV1Enabled"),
      listConnections: () => this.storage.integrationConnections.list(undefined, 1000),
      // SSRF-guarded fetch: the bridge URL comes from connection config, so it
      // must ride the same egress allowlist as outbound integration actions.
      fetchBridge: (url) => this.fetchWithDiagnosticsTimeout(url),
      integrationWebhooks: {
        getIntegrationConnection: (connectionId) => this.storage.integrationConnections.get(connectionId),
        cancelLatestActiveChatTurnForSession: (sessionId, cancelledBy) =>
          this.cancelLatestActiveChatTurnForSession(sessionId, cancelledBy),
        hasRunningTurn: (sessionId) => this.hasRunningTurn(sessionId),
        ingestChannelMessage: (channel, idempotencyKey, input) =>
          this.ingestChannelMessage(channel, idempotencyKey, input),
        parseChatCommand: (sessionId, commandText, options) => this.parseChatCommand(sessionId, commandText, options),
        recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
        emitChannelActivity: (input) => this.commsActivity(input),
        respondToExistingChatMessage: (sessionId, messageId, options) =>
          this.respondToExistingChatMessage(sessionId, messageId, options),
        resolveApprovalWithRemoteToken: (input) => this.resolveApprovalWithRemoteToken(input),
        resolveApprovalWithRemoteTokenId: (input) => this.resolveApprovalWithRemoteTokenId(input),
        setChatSessionBinding: (input) => this.setChatSessionBinding(input),
        updateIntegrationConnection: (connectionId, patch) =>
          this.storage.integrationConnections.update(connectionId, patch),
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
      recordEvidenceEnvelope: (input) => {
        // Best-effort: envelope failure must never fail the cron run.
        try {
          return this.evidenceEnvelopeService.createEnvelope(input);
        } catch (error) {
          this.recordDevDiagnostic({
            level: "warn",
            category: "evidence",
            event: "evidence.envelope.failed",
            message: "Failed to record cron run evidence envelope",
            context: {
              eventKind: input.eventKind,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          return undefined;
        }
      },
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
          await this.runPrivateBetaBackupSchedulerIfDue({ force: true, recordCronState: false });
        },
        memoryFlush: async () => {
          await this.runMemoryFlushSchedulerIfDue({ force: true, recordCronState: false });
        },
        memoryConsolidation: async () => {
          await this.runMemoryConsolidationSchedulerIfDue({ force: true, recordCronState: false });
        },
        costReport: async () => {
          await this.runCostReportSchedulerIfDue({ force: true, recordCronState: false });
        },
        updateReview: async () => {
          await this.runUpdateReviewSchedulerIfDue({ force: true, recordCronState: false });
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
      workflowRegistry: durableExecutionService.createDeferredDurableWorkflowExecutorRegistry(
        () => this.durableWorkflowRegistry,
      ),
      onRunFailed: async (run, message) => {
        this.improvementService.recordDurableRunFailureSignal({
          run,
          message,
        });
      },
      onAutonomousChatPostCommit: (run, context) =>
        durableExecutionService.executeAutonomousChatPostCommit(this.buildDurableChatTurnWorkflowHost(), run, context),
      onGeneralChatPostCommit: (run, progress) =>
        durableExecutionService.executeGeneralChatPostCommit(this.buildDurableChatTurnWorkflowHost(), run, progress),
      evaluateContinuationGate: (run) => this.evaluateDurableContinuationGate(run),
      recordEvidenceEnvelope: (input) => this.evidenceEnvelopeService.createEnvelope(input),
      taskLifecycle: createDurableTaskAutoBlockBridge(this.taskLifecycleService),
    });
    this.hooksService = new HooksService(serviceCtx, {
      createDurableRun: (input, options) => this.durableRunService.createDurableRun(input, options),
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
      invokeTool: (request, options) => this.invokeTool(request, options),
      resolveToolPolicyContext: (input) => this.resolveToolPolicyContext(input),
      detectDelegationRoles: (text) => detectDelegationRoles(text),
      createDurableRun: (input) => this.createDurableRun(input),
      requestDurableRunProcessing: (runId) => this.durableRunService.requestRunProcessing(runId),
      // P1-F5 de-novo origination: cheap read-only planner + eligibility guard.
      createChatCompletion: (request) => this.createChatCompletion(request),
      resolveModelDefaults: () => this.getPromptJudgeModelDefaults(),
      resolveApiStyle: (providerId, model) => this.llmService.resolveExecutionApiStyle(providerId, model),
      isProactiveDeNovoEligibleSession: (sessionId) =>
        isHeartbeatEligibleSession(this.chatAutonomousTurnDeps(), sessionId),
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
      recordDurableTimelineEvent: (runId, eventType, payload) =>
        this.recordDurableTimelineEvent(runId, eventType, payload),
      recordApprovalResolutionSignals: (approval) => {
        this.improvementService.recordApprovalResolutionSignal(approval);
        this.improvementService.handleActivationApprovalResolution(approval);
      },
      materializeApprovalWaitRun: (approvalId) => {
        this.approvalWaitRunService.primeApprovalLifecycle(approvalId);
        const runId = this.storage.approvalWaitRuns.getRunId(approvalId);
        return runId ? this.getDurableRun(runId) : undefined;
      },
      reconcileExpiredApprovals: (limit) => this.approvalRuntime.expirePendingApprovals(limit),
      reconcileExpiredDeviceAccessRequests: (limit) =>
        settingsAuthService.expirePendingDeviceAccessRequests(
          createSettingsAuthRuntimeDependenciesForGateway(this.getRouteCompositionPort()),
          limit,
        ),
      approvalRemoteTokenSecrets: this.approvalRemoteTokenSecrets,
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
      consumeRemoteActionToken: (token, actionType, options) =>
        this.consumeRemoteActionToken(token, actionType, options),
      consumeRemoteActionTokenById: (tokenId, actionType, options) =>
        this.consumeRemoteActionTokenById(tokenId, actionType, options),
      resolveApproval: (approvalId, input, context) => this.approvalRuntime.resolveApproval(approvalId, input, context),
      resolveDeviceAccessApproval: (current, input, context) =>
        settingsAuthService.resolveDeviceAccessApproval(
          createSettingsAuthRuntimeDependenciesForGateway(this.getRouteCompositionPort()),
          current,
          input,
          context,
        ),
      executeCodeModePendingApproval: (approvalId, signal) => this.executeCodeModePendingApproval(approvalId, signal),
      resolveApprovalHookWorkspaceId: (payload) => this.resolveApprovalHookWorkspaceId(payload),
      scheduleApprovalExplanation: (approval) => this.scheduleApprovalExplanation(approval),
      findProactiveDurableRunIdsForApproval: (approvalId) => this.findProactiveDurableRunIdsForApproval(approvalId),
      wakeDurableRun: (runId, event) => this.wakeDurableRun(runId, event),
      enqueueApprovalObservabilityEffects: (approvalId, items) =>
        this.approvalEffectsService.enqueueObservabilityEffects(approvalId, items),
      enqueueApprovalWaitMaterialization: (approval) =>
        this.approvalEffectsService.enqueueApprovalWaitMaterialization(approval),
      enqueueApprovalResolutionEffects: (approval, input, options) =>
        this.enqueueApprovalResolutionEffects(approval, input, options),
      awaitApprovalResolutionEffects: (approvalId) => this.approvalEffectsService.awaitResolutionEffects(approvalId),
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
      createChatSession: (input) =>
        input.stableKey
          ? chatSessionService.ensureChatSessionWithStableKey(
              this.buildChatSessionDependencies(),
              input.stableKey,
              input,
            )
          : this.createChatSession(input),
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
        evaluateDeploymentProfileToolAccess(this.config.assistant.deploymentProfile, request.toolName, request.args, {
          operatorApproved: policyContextHasOperatorApproval(request.policyContext),
        }),
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
      captureRepairPolicySnapshot: (targetKey) =>
        captureRepairPolicySnapshot(this.improvementSnapshotDeps(), targetKey),
      applyRepairPolicyCandidate: (targetKey, revisionRef) =>
        applyRepairPolicyCandidate(this.improvementSnapshotDeps(), targetKey, revisionRef),
      restoreRepairPolicySnapshot: (snapshotRef) =>
        restoreRepairPolicySnapshot(this.improvementSnapshotDeps(), snapshotRef),
      captureRoutingPolicySnapshot: (targetKey) =>
        captureRoutingPolicySnapshot(this.improvementSnapshotDeps(), targetKey),
      applyRoutingPolicyCandidate: (targetKey, revisionRef) =>
        applyRoutingPolicyCandidate(this.improvementSnapshotDeps(), targetKey, revisionRef),
      restoreRoutingPolicySnapshot: (snapshotRef) =>
        restoreRoutingPolicySnapshot(this.improvementSnapshotDeps(), snapshotRef),
      captureSkillRevisionSnapshot: (targetKey, revisionRef) =>
        captureSkillRevisionSnapshot(this.improvementSnapshotDeps(), targetKey, revisionRef),
      applySkillRevisionCandidate: (targetKey, revisionRef) =>
        applySkillRevisionCandidate(this.improvementSnapshotDeps(), targetKey, revisionRef),
      restoreSkillRevisionSnapshot: (snapshotRef) =>
        restoreSkillRevisionSnapshot(this.improvementSnapshotDeps(), snapshotRef),
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
        snapshotSkill: (skillId) => this.skillStateService.captureCuratorIdleSnapshot(skillId),
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
        restoreSkillRevision: (snapshotRef) =>
          restoreSkillRevisionSnapshot(this.improvementSnapshotDeps(), snapshotRef as ImprovementRef),
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
      createDurableRun: (input, options) =>
        options?.deferRealtime
          ? this.durableRunService.createDurableRun(input, { publishRealtime: false })
          : this.createDurableRun(input),
      getDurableRun: (runId) => this.getDurableRun(runId),
    });
    const chatPostCommitRuntime = createChatPostCommitRuntime({
      storage: this.storage,
      createChatCompletion: (request) => this.createChatCompletion(request),
      resolveModelDefaults: () => this.getPromptJudgeModelDefaults(),
      resolveApiStyle: (providerId, model) => this.llmService.resolveExecutionApiStyle(providerId, model),
      operatorProfileService: this.operatorProfileService,
      autonomyControlService: this.autonomyControlService,
      skillMutationService: this.skillMutationService,
      memoryMaintenanceService: this.memoryMaintenanceService,
      isAutonomyDisabled: () => this.isFeatureEnabled("autonomyV1Disabled"),
      isReplayScratchSession: (sessionId) => this.isReplayScratchSession(sessionId),
      publishRealtime,
      requestDurableRunProcessing: (runId) => this.durableRunService.requestRunProcessing(runId),
      recordDurableTimelineEvent: (runId, eventType, payload) =>
        this.recordDurableTimelineEvent(runId, eventType, payload),
      recordImprovementDurableRunCompletion: (run, state) => this.recordImprovementDurableRunCompletion(run, state),
    });
    this.commitmentClassifier = chatPostCommitRuntime.commitmentClassifier;
    this.backgroundReviewService = chatPostCommitRuntime.backgroundReviewService;
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
    this.memoryConsolidationService = new MemoryConsolidationService({
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag),
      listCompletedTurnTracesSince: (sinceIso, limit) =>
        this.storage.chatTurnTraces.listCompletedSince(sinceIso, limit),
      readTranscriptOrEmpty: (sessionId) => this.readTranscriptOrEmpty(sessionId),
      createChatCompletion: (request) => this.createChatCompletion(request),
      // Rides the prompt-runner chokepoint, so drafting automatically moves to
      // the cheap utility tier once utilityModelRoutingV1Enabled ships.
      resolveModelDefaults: () => this.getPromptRunnerModelDefaults(),
      proposeTraceMemoryCandidate: (input, actorId) =>
        this.memoryLifecycleService.proposeTraceMemoryCandidate(input, actorId),
      listExistingInsightsForDedup: () => [
        ...this.memoryLifecycleService
          .listMemoryLearnings({ status: "all", limit: EXISTING_LEARNINGS_DEDUP_LIMIT })
          .map((item) => item.insight),
        ...this.memoryLifecycleService
          .listTraceMemoryCandidates({ status: "proposed", limit: PENDING_CANDIDATES_DEDUP_LIMIT })
          .map((item) => item.proposedInsight),
      ],
      getWatermark: () => this.storage.systemSettings.get<string>(MEMORY_CONSOLIDATION_WATERMARK_SETTING_KEY)?.value,
      setWatermark: (iso) => this.storage.systemSettings.set(MEMORY_CONSOLIDATION_WATERMARK_SETTING_KEY, iso),
      publishRealtime: (eventType, source, payload) => this.publishRealtime(eventType, source, payload ?? {}),
      recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
    });
    this.durableOperatorService = new DurableOperatorService({
      durableRunService: this.durableRunService,
      memoryLifecycleService: this.memoryLifecycleService,
      hooksService: this.hooksService,
      resolveDurableRunHookWorkspaceId: (run) => this.resolveDurableRunHookWorkspaceId(run),
    });
    // Host callbacks are lazy closures, so fields assigned later in this constructor
    // (skillsService, autonomyControlService) are safe to reference here.
    this.skillStateService = new SkillStateService(
      { gatewaySql: this.storage.gatewaySql, systemSettings: this.storage.systemSettings },
      {
        listSkills: () => this.skillsService.list(),
        recordAutonomousMutation: (input) => this.autonomyControlService.recordAutonomousMutation(input),
        recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
      },
    );
    this.mcpServerStore = new McpServerStore({ systemSettings: this.storage.systemSettings });
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
        chatPostCommitEffect: chatPostCommitRuntime.effectExecutor,
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
          approvalRemoteTokenSecrets: this.approvalRemoteTokenSecrets,
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
          // Kill switch: externalSideEffectReplayJobsV1Disabled (`*Disabled` ⇒
          // feature ON by default). Disabled ⇒ the hook returns undefined,
          // byte-identical to before this hook existed (job_unavailable).
          buildExternalSideEffectReplayJob: (run, payload) =>
            this.isFeatureEnabled("externalSideEffectReplayJobsV1Disabled")
              ? undefined
              : buildGatewayExternalSideEffectReplayJob(
                  buildIntegrationActionHostForGateway(this.getRouteCompositionPort()),
                  run,
                  payload,
                ),
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
          storage: this.storage,
          curatorService: this.curatorService,
          publishRealtime: (eventType, source, payload, options) => {
            this.publishRealtime(eventType, source, payload, options);
          },
          recordDurableTimelineEvent: (runId, eventType, payload) =>
            this.recordDurableTimelineEvent(runId, eventType, payload),
          recordImprovementDurableRunCompletion: (run, checkpointState) =>
            this.recordImprovementDurableRunCompletion(run, checkpointState),
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
      beginDurableChatRun: (prepared, input, threadEventType, options) =>
        this.beginDurableChatRun(prepared, input, threadEventType, options),
      cancelDurableChatRun: (runId, actorId) => {
        return this.cancelDurableRun(runId, actorId);
      },
      buildChatOrchestrationSummary: (input) => this.buildChatOrchestrationSummary(input),
      buildDefaultChatPersonalityOverlay: () => this.buildDefaultChatPersonalityOverlay(),
      buildLlmMessagesFromBranchPath: (sessionId, pathTurnIds, currentUserMessage, options, state) =>
        this.buildLlmMessagesFromBranchPath(sessionId, pathTurnIds, currentUserMessage, options, state),
      composeFrozenOperatorProfileDigest: (workspaceId) => this.composeFrozenOperatorProfileDigest(workspaceId),
      resolveBasePromptCapabilityCatalog: () => this.resolveBasePromptCapabilityCatalog(),
      closeActiveChatTurnStream: (turnId, registrationId) => this.closeActiveChatTurnStream(turnId, registrationId),
      collectCapabilityUpgradeSuggestions: (input) => this.collectCapabilityUpgradeSuggestions(input),
      collectSpecialistCandidateSuggestions: (input) => this.collectSpecialistCandidateSuggestions(input),
      commsSend: (input) => this.commsSend(input),
      completeActiveChatTurnStream: (turnId, registrationId) =>
        this.completeActiveChatTurnStream(turnId, registrationId),
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
      finalizeDurableChatRun: (runId, prepared, trace, expectedLeaseOwnerId) =>
        this.finalizeDurableChatRun(runId, prepared, trace, expectedLeaseOwnerId),
      getActiveChatTurnExecution: (turnId) => this.getActiveChatTurnExecution(turnId),
      getActiveChatTurnStream: (turnId) => this.getActiveChatTurnStream(turnId),
      getSession: (sessionId) => this.getSession(sessionId),
      getSessionAutonomyPrefs: (sessionId) => this.getSessionAutonomyPrefs(sessionId),
      inheritDelegatedSessionToolGrants: (sessionId, delegatedSessionId) =>
        this.inheritDelegatedSessionToolGrants(sessionId, delegatedSessionId),
      ingestEvent: (idempotencyKey, payload, options) => this.ingestEvent(idempotencyKey, payload, options),
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag as keyof RuntimeSettings["features"]),
      isReplayScratchSession: (sessionId) => this.isReplayScratchSession(sessionId),
      listLlmModels: (providerId) => this.listLlmModels(providerId),
      loadChatTurnSessionState: (sessionId) => this.loadChatTurnSessionState(sessionId),
      markChatTurnCancelled: (sessionId, turnId, cancelledBy) =>
        this.markChatTurnCancelled(sessionId, turnId, cancelledBy),
      maybeAutoTitleChatSession: (sessionId, content) => this.maybeAutoTitleChatSession(sessionId, content),
      normalizeWorkspaceId: (workspaceId) => this.normalizeWorkspaceId(workspaceId),
      patchSessionAutonomyPrefs: (sessionId, input) => this.patchSessionAutonomyPrefs(sessionId, input),
      persistChatStreamChunk: (chunk, durableRunId, streamRegistration) => {
        if (!chunk.turnId) {
          throw new Error("Persistable chat stream chunk is missing a turn id.");
        }
        this.persistChatStreamChunk(chunk as PersistableChatStreamChunk, durableRunId, streamRegistration);
      },
      prepareAgentChatTurn: (sessionId, input, options) => this.prepareAgentChatTurn(sessionId, input, options),
      recordRuntimeDecision: (input) => this.recordRuntimeDecision(input),
      publishRealtime: (channel, topic, payload, options) => this.publishRealtime(channel, topic, payload, options),
      recordCapabilityGapFromTrace: (input) => this.recordCapabilityGapFromTrace(input),
      recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
      recordTurnCommitments: (input) => this.recordTurnCommitments(input),
      registerActiveChatTurnStream: (sessionId, turnId, durableRunId, options) =>
        this.registerActiveChatTurnStream(sessionId, turnId, durableRunId, options),
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
      scheduleMemoryMaintenancePostTurnEvaluation: (input) => this.scheduleMemoryMaintenancePostTurnEvaluation(input),
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
      ingestEvent: (idempotencyKey, payload, options) => this.ingestEvent(idempotencyKey, payload, options),
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
      scheduleMemoryMaintenancePostTurnEvaluation: (input) => this.scheduleMemoryMaintenancePostTurnEvaluation(input),
      scheduleBackgroundReviewIfDue: (input) => this.scheduleBackgroundReviewIfDue(input),
      recordCapabilityGapFromTrace: (input) => this.recordCapabilityGapFromTrace(input),
      markChatTurnCancelled: (sessionId, turnId) => this.markChatTurnCancelled(sessionId, turnId),
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag as keyof RuntimeSettings["features"]),
      streamPersistedChatTurnEvents: (sessionId, turnId, options) =>
        this.streamPersistedChatTurnEvents(sessionId, turnId, options),
      withEphemeralStreamEnvelope: (stream, runId) => this.withEphemeralStreamEnvelope(stream, runId),
      persistChatStreamChunk: (chunk, durableRunId, streamRegistration) => {
        if (!chunk.turnId) {
          throw new Error("Persistable chat stream chunk is missing a turn id.");
        }
        this.persistChatStreamChunk(chunk as PersistableChatStreamChunk, durableRunId, streamRegistration);
      },
      createHydratedChatTurnTrace: (turnId, trace) => this.createHydratedChatTurnTrace(turnId, trace),
      finalizeDurableChatRun: (runId, prepared, trace, expectedLeaseOwnerId) =>
        this.finalizeDurableChatRun(runId, prepared, trace, expectedLeaseOwnerId),
      completeActiveChatTurnStream: (turnId, registrationId) =>
        this.completeActiveChatTurnStream(turnId, registrationId),
      closeActiveChatTurnStream: (turnId, registrationId) => this.closeActiveChatTurnStream(turnId, registrationId),
      getActiveChatTurnStream: (turnId) => this.getActiveChatTurnStream(turnId),
      beginDurableChatRun: (prepared, input, threadEventType, options) =>
        this.beginDurableChatRun(prepared, input, threadEventType, options),
      registerActiveChatTurnStream: (sessionId, turnId, durableRunId, options) =>
        this.registerActiveChatTurnStream(sessionId, turnId, durableRunId, options),
      ensureSessionInternalToolGrant: (sessionId, toolName, reason) =>
        this.ensureSessionInternalToolGrant(sessionId, toolName, reason),
      requireExecutedToolResult: (toolName, result) => this.requireExecutedToolResult(toolName, result),
      commsSend: (input) => this.commsSend(input),
      prepareAgentChatTurn: (sessionId, input, options) => this.prepareAgentChatTurn(sessionId, input, options),
      enqueueAutonomousChannelDelivery: (input) => this.enqueueAutonomousChannelDelivery(input),
      cleanupSilentHeartbeatTurn: (input) => this.cleanupSilentHeartbeatTurn(input),
      reconcileAutonomousChatPostCommit: (runId) => this.durableRunService.reconcileAutonomousChatPostCommit(runId),
      reconcileGeneralChatPostCommit: (runId) => this.durableRunService.reconcileGeneralChatPostCommit(runId),
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
      this.skillStateService.ensureSkillStates(skills.map((skill) => skill.skillId));
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
    // One-time (marker-guarded) stamp of ambiguous legacy-open channel access
    // to an explicit open_legacy posture; behavior-preserving by design.
    const legacyStamp = stampLegacyOpenChannelInboundAccess({
      storage: this.storage,
      publishRealtime: (eventType, source, payload, options) =>
        this.publishRealtime(eventType, source, payload, options),
      recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
      now: new Date().toISOString(),
    });
    if (legacyStamp.stampedConnectionIds.length > 0) {
      log.info("stamped legacy-open channel inbound access to explicit open_legacy", {
        count: legacyStamp.stampedConnectionIds.length,
      });
    }
    await Promise.all([this.discordRuntimeService.sync(), this.loadCronJobsFromConfig()]);
    // Starts pollers only when signalInboundV1Enabled is true (no-op otherwise).
    this.syncSignalInboundRuntime();
    this.improvementService.ensureWeeklyImprovementCronJob();
    this.curatorService.ensureCuratorWeeklyCronJob();
    this.ensurePrivateBetaBackupCronJob();
    this.ensureMemoryFlushCronJob();
    this.ensureMemoryConsolidationCronJob();
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
    // Convert chat turns stranded by the previous process death into honest
    // retryable interrupted_by_restart failure traces before the durable worker
    // starts resuming runs (durable-owned turns are skipped and left to it).
    if (!this.isFeatureEnabled("chatTurnInterruptionRecoveryV1Disabled")) {
      this.reconcileInterruptedChatTurnsOnBoot();
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

  /**
   * Boot-time runtime-truth repair: fail-closed conversion of chat turns
   * stranded by the previous process death into retryable
   * interrupted_by_restart failure traces. Failure here must never block
   * startup — the reconciler re-runs on the next boot.
   */
  private reconcileInterruptedChatTurnsOnBoot(): void {
    try {
      const reconciled = reconcileInterruptedChatTurns({
        storage: this.storage,
        publishRealtime: (eventType, source, payload, options) =>
          this.publishRealtime(eventType, source, payload, options),
        recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
      });
      if (reconciled.interruptedTurnIds.length > 0 || reconciled.synthesizedTurnIds.length > 0) {
        log.info("reconciled chat turns interrupted by a previous gateway shutdown", {
          interrupted: reconciled.interruptedTurnIds.length,
          synthesized: reconciled.synthesizedTurnIds.length,
          skippedDurableOwned: reconciled.skippedDurableOwnedTurnIds.length,
        });
      }
    } catch (error) {
      log.warn("Failed to reconcile interrupted chat turns on startup", {
        error: error instanceof Error ? error.message : String(error),
      });
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

  public async ingestEvent(
    idempotencyKey: string,
    payload: GatewayEventInput,
    options?: { onCommit?: () => void; afterCommit?: () => void },
  ): Promise<GatewayEventResult> {
    const result = await this.eventIngestService.ingest({
      endpoint: "/api/v1/gateway/events",
      idempotencyKey,
      payload,
      ...(options?.onCommit ? { onCommit: options.onCommit } : {}),
      ...(options?.afterCommit ? { afterCommit: options.afterCommit } : {}),
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

  public createChatSession(input: ChatSessionCreateInput & { stableKey?: string } = {}): ChatSessionRecord {
    return input.stableKey
      ? chatSessionService.ensureChatSessionWithStableKey(this.buildChatSessionDependencies(), input.stableKey, input)
      : chatSessionService.createChatSession(this.buildChatSessionDependencies(), input);
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
        // 3.6: an inbound voice message is framed with VOICE_TRANSCRIPT_CONTENT_PREFIX,
        // so the reply path can honor the connection's voice_on_voice mode instead of
        // treating it as "always".
        const wasVoiceInbound = userMessage.content.trimStart().startsWith(VOICE_TRANSCRIPT_CONTENT_PREFIX);
        const voiceReplyAttachment = await this.maybeBuildChannelVoiceReplyAttachment(
          binding.connectionId,
          assistantContent,
          wasVoiceInbound,
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
    wasVoiceInbound: boolean,
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
          // 3.6: honor voice_on_voice — synthesize a voice reply only when the
          // inbound message that triggered this turn was itself voice.
          wasVoiceInbound,
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
    return chatTurnTraceHydration.loadChatTurnSessionState(
      {
        storage: this.storage,
        ensureChatMessageProjection: (targetSessionId) => this.ensureChatMessageProjection(targetSessionId),
      },
      sessionId,
      options,
    );
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

    if (
      providerAllowsForeignModelIds(provider.providerId) ||
      providerRecognizesModelId(provider.providerId, prefs.model)
    ) {
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
      { label: "memory consolidation", run: () => this.runMemoryConsolidationSchedulerIfDue() },
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

  public scheduleMemoryMaintenancePostTurnEvaluation(input: {
    sessionId: string;
    turnId: string;
    delegatedChild: boolean;
  }): void {
    if (this.closing || input.delegatedChild) {
      return;
    }
    const task = this.memoryLifecycleService.noteSuccessfulRootTurn(input.sessionId).catch((error) => {
      log.error("memory maintenance post-turn evaluation failed", error);
    });
    this.registerBackgroundTask(task);
  }

  /**
   * P2-S1 — schedule the self-improvement background review for a successful eligible
   * turn, counter-gated to run every {@link BACKGROUND_REVIEW_TURN_INTERVAL}
   * eligible turns. Sibling of {@link scheduleMemoryMaintenancePostTurnEvaluation}
   * — skips delegated child turns and runs fire-and-forget after a successful turn.
   *
   * Guards (master-autonomy / eval-integrity / non-human / closing / delegated-child)
   * are resolved here and re-asserted inside the service; the counter only
   * advances for eligible turns. The review is a tracked background task that can
   * never throw out of the turn path.
   */
  public scheduleBackgroundReviewIfDue(input: {
    sessionId: string;
    workspaceId: string;
    turnId: string;
    userText: string;
    assistantText: string;
    delegatedChild: boolean;
    /** True when the completed turn is itself an autonomous self-wake (skip). */
    autonomous?: boolean;
  }): void {
    // Skip delegated children (mirror the memory-maintenance sibling) and a closing gateway.
    if (this.closing || input.delegatedChild) {
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
        sourceTurnId: input.turnId,
        workspaceId: input.workspaceId,
        userText: input.userText,
        assistantText: input.assistantText,
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
      // Finding 1: scope prewarm memory-item collection to the session's workspace.
      // Optional-chained: some facade/test compositions invoke this method without a
      // full storage (mirrors the guard in memory-context-service); prod always has it.
      workspaceId: this.storage?.chatSessionMeta?.get(input.sessionId)?.workspaceId ?? "default",
      prompt: input.prompt,
      relationScope: input.relationScope,
      workspace: this.resolveMemoryWorkspaceRelativeDir(undefined, input.sessionId),
      forceRefresh: true,
    }).catch((error) => {
      log.error("chat memory prewarm failed", error);
    });
    this.registerBackgroundTask(task);
  }

  private systemCronSchedulerDeps(): SystemCronSchedulerDeps {
    return {
      storage: this.storage,
      rootDir: this.config.rootDir,
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag),
      persistCronJobsConfig: () => this.persistCronJobsConfig(),
      publishRealtime: (eventType, source, payload) => this.publishRealtime(eventType, source, payload ?? {}),
      evidenceEnvelopeService: this.evidenceEnvelopeService,
      recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
      createBackup: (input) => this.createBackup(input),
      pruneRetention: (options) => this.pruneRetention(options),
      runMemoryConsolidation: () => this.memoryConsolidationService.runConsolidation(),
      memoryLifecycle: this.memoryLifecycleService,
      recordCronReviewItem: (input) => this.cronAutomationService.recordCronReviewItem(input),
    };
  }

  private async runPrivateBetaBackupSchedulerIfDue(options: SystemCronSchedulerOptions = {}): Promise<void> {
    await runPrivateBetaBackupSchedulerIfDue(this.systemCronSchedulerDeps(), options);
  }

  private async runMemoryConsolidationSchedulerIfDue(options: SystemCronSchedulerOptions = {}): Promise<void> {
    await runMemoryConsolidationSchedulerIfDue(this.systemCronSchedulerDeps(), options);
  }

  private async runMemoryFlushSchedulerIfDue(options: SystemCronSchedulerOptions = {}): Promise<void> {
    await runMemoryFlushSchedulerIfDue(this.systemCronSchedulerDeps(), options);
  }

  private async runCostReportSchedulerIfDue(options: SystemCronSchedulerOptions = {}): Promise<void> {
    await runCostReportSchedulerIfDue(this.systemCronSchedulerDeps(), options);
  }

  private async runUpdateReviewSchedulerIfDue(options: SystemCronSchedulerOptions = {}): Promise<void> {
    await runUpdateReviewSchedulerIfDue(this.systemCronSchedulerDeps(), options);
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
      const cancellationWon =
        result.cancelled === true ||
        (result.cancelled === undefined &&
          result.trace.status === "cancelled" &&
          finalDurableStatus !== "completed" &&
          finalDurableStatus !== "failed" &&
          finalDurableStatus !== "dead_lettered");
      return {
        status: cancellationWon ? "cancelled" : "no_active_run",
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

  // NOTE (Finding 7 divergence): this deliberately EXCLUDES `dead_lettered`,
  // unlike the shared `isDurableRunTerminal` (contracts) used elsewhere. Kept
  // local + unchanged here to preserve behavior; whether a dead-lettered run
  // should count as terminal for the `durableCancelled` reporting flag is a
  // correctness question deferred to the Phase 2 durable-run pass.
  private isDurableRunTerminalStatus(status: DurableRunStatus): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  private getChatStreamRuntime(): GatewayChatStreamRuntime {
    if (!this.chatStreamRuntime) {
      const legacyInitialPurgeAt = (this as { lastChatStreamPurgeAt?: unknown }).lastChatStreamPurgeAt;
      this.chatStreamRuntime = new GatewayChatStreamRuntime({
        storage: this.storage,
        chatTurnExecutionRegistry: this.chatTurnExecutionRegistry,
        createHydratedChatTurnTrace: (turnId, trace) => this.createHydratedChatTurnTrace(turnId, trace),
        persistChatStreamChunk: (chunk, runId, streamRegistration) =>
          this.persistChatStreamChunk(chunk, runId, streamRegistration),
        initialLastChatStreamPurgeAt: typeof legacyInitialPurgeAt === "number" ? legacyInitialPurgeAt : undefined,
      });
    }
    return this.chatStreamRuntime;
  }

  private syncLegacyChatStreamPurgeState(runtime: GatewayChatStreamRuntime): void {
    const legacyPurgeAt = (this as { lastChatStreamPurgeAt?: unknown }).lastChatStreamPurgeAt;
    if (typeof legacyPurgeAt === "number") {
      runtime.setLastChatStreamPurgeAt(legacyPurgeAt);
    }
  }

  private writeBackLegacyChatStreamPurgeState(runtime: GatewayChatStreamRuntime): void {
    const legacyHolder = this as { lastChatStreamPurgeAt?: unknown };
    if ("lastChatStreamPurgeAt" in legacyHolder) {
      legacyHolder.lastChatStreamPurgeAt = runtime.getLastChatStreamPurgeAt();
    }
  }

  public registerActiveChatTurnStream(
    sessionId: string,
    turnId: string,
    runId?: string,
    options?: import("./chat-turn-runtime-collaborators.js").ChatTurnStreamRegistrationOptions,
  ): ActiveChatTurnStreamExecution {
    return this.getChatStreamRuntime().registerActiveChatTurnStream(sessionId, turnId, runId, options);
  }

  public getActiveChatTurnStream(turnId: string): ActiveChatTurnStreamExecution | undefined {
    return this.getChatStreamRuntime().getActiveChatTurnStream(turnId);
  }

  public completeActiveChatTurnStream(turnId: string, registrationId: string): boolean {
    return this.getChatStreamRuntime().completeActiveChatTurnStream(turnId, registrationId);
  }

  public closeActiveChatTurnStream(turnId: string, registrationId: string): boolean {
    return this.getChatStreamRuntime().closeActiveChatTurnStream(turnId, registrationId);
  }

  public persistChatStreamChunk(
    chunk: PersistableChatStreamChunk,
    runId?: string,
    streamRegistration?: ActiveChatTurnStreamExecution,
  ): ChatStreamChunk {
    const runtime = this.getChatStreamRuntime();
    this.syncLegacyChatStreamPurgeState(runtime);
    const persisted = runtime.persistChatStreamChunk(chunk, runId, streamRegistration);
    this.writeBackLegacyChatStreamPurgeState(runtime);
    return persisted;
  }

  private purgeExpiredChatStreamEventsIfNeeded(): void {
    const runtime = this.getChatStreamRuntime();
    this.syncLegacyChatStreamPurgeState(runtime);
    runtime.purgeExpiredChatStreamEventsIfNeeded();
    this.writeBackLegacyChatStreamPurgeState(runtime);
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
    yield* this.getChatStreamRuntime().streamPersistedChatTurnEvents(sessionId, turnId, options);
  }

  private signalChatStreamEvent(turnId: string): void {
    this.getChatStreamRuntime().signalChatStreamEvent(turnId);
  }

  private waitForChatStreamEvent(turnId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return this.getChatStreamRuntime().waitForChatStreamEvent(turnId, timeoutMs, signal);
  }

  private isDurableTurnStillStreaming(turnId: string, options?: { includeInterrupts?: boolean }): boolean {
    return this.getChatStreamRuntime().isDurableTurnStillStreaming(turnId, options);
  }

  public async *withEphemeralStreamEnvelope(
    source: AsyncGenerator<ChatStreamChunkDraft>,
    runId?: string,
  ): AsyncGenerator<ChatStreamChunk> {
    yield* this.getChatStreamRuntime().withEphemeralStreamEnvelope(source, runId);
  }

  private async *streamTurnStateFallback(sessionId: string, turnId: string): AsyncGenerator<ChatStreamChunk> {
    yield* this.getChatStreamRuntime().streamTurnStateFallback(sessionId, turnId);
  }

  public createHydratedChatTurnTrace(
    turnId: string,
    trace: ChatTurnTraceRecord,
    options?: chatTurnTraceHydration.ChatTurnTraceHydrationOptions,
  ): ChatTurnTraceRecord {
    return chatTurnTraceHydration.createHydratedChatTurnTrace(this, turnId, trace, options);
  }

  public markChatTurnCancelled(sessionId: string, turnId: string, cancelledBy?: string): ChatTurnTraceRecord {
    return markChatTurnCancelled(
      {
        storage: this.storage,
        getActiveChatTurnStream: (targetTurnId) => this.getActiveChatTurnStream(targetTurnId),
        parseDurableChatTurnPayload: (run) => this.parseDurableChatTurnPayload(run),
        createHydratedChatTurnTrace: (targetTurnId, trace) => this.createHydratedChatTurnTrace(targetTurnId, trace),
        recordDevDiagnostic: (input) => this.recordDevDiagnostic(input),
        publishRealtime: (eventType, source, payload, options) =>
          this.publishRealtime(eventType, source, payload, options),
      },
      sessionId,
      turnId,
      cancelledBy,
    );
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

  public collectSpecialistCandidateSuggestions(input: {
    sessionId: string;
    mode: ChatMode;
    content: string;
    capabilitySuggestions: ChatCapabilityUpgradeSuggestion[];
    trace: ChatTurnTraceRecord;
  }): ChatSpecialistCandidateSuggestionRecord[] {
    return collectSpecialistCandidateSuggestions(
      {
        chatSpecialistCandidates: this.storage.chatSpecialistCandidates,
        chatSessionMeta: this.storage.chatSessionMeta,
        importedAgentCatalog: this.storage.importedAgentCatalog,
        normalizeWorkspaceId: (workspaceId) => this.normalizeWorkspaceId(workspaceId),
      },
      input,
    );
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

  /**
   * Cheap utility-model override for background LLM calls. Returns undefined
   * (= keep existing selection) unless utilityModelRoutingV1Enabled is on and
   * the configured utility provider has a usable key.
   */
  private getUtilityModelOverride(): { providerId: string; model: string } | undefined {
    if (this.readFeatureFlags().utilityModelRoutingV1Enabled !== true) {
      return undefined;
    }
    const runtime = this.llmService.getRuntimeConfig({ useCache: true });
    const utilityProviderId = runtime.utilityProviderId;
    if (!utilityProviderId) {
      return undefined;
    }
    // Keychain-backed keys are only surfaced when explicitly requested for a
    // provider, so ask for the utility provider directly instead of relying on
    // the active-provider summary.
    const provider = this.llmService
      .listProviders({ includeKeychainForProviderId: utilityProviderId, useCache: true })
      .find((candidate) => candidate.providerId === utilityProviderId);
    return resolveUtilityModelOverride({
      flagEnabled: true,
      utilityProviderId,
      utilityModel: runtime.utilityModel,
      provider,
    });
  }

  private getPromptRunnerModelDefaults(): { providerId?: string; model?: string } {
    const utilityOverride = this.getUtilityModelOverride();
    if (utilityOverride) {
      return utilityOverride;
    }
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
    const utilityOverride = this.getUtilityModelOverride();
    if (utilityOverride) {
      return utilityOverride;
    }
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

  private improvementSnapshotDeps(): ImprovementSnapshotDeps {
    return {
      storage: this.storage,
      skillMutation: this.skillMutationService,
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag),
      // Lazy: autonomy-control is constructed after improvement-service.
      recordAutonomousMutation: (input) => this.autonomyControlService.recordAutonomousMutation(input),
    };
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
    grantError?: string;
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
      throw new NotFoundError({ entity: "Chat turn", id: turnId });
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
      userMessageId?: string;
      turnId?: string;
      assistantMessageId?: string;
      mutationLifecycle?: import("./chat-turn-types.js").ChatStreamMutationLifecycle;
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
    options?: {
      abortSignal?: AbortSignal;
      mutationLifecycle?: import("./chat-turn-types.js").ChatStreamMutationLifecycle;
    },
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
  private chatAutonomousTurnDeps(): ChatAutonomousTurnDeps {
    return {
      storage: this.storage,
      cron: this.cronAutomationService,
      isFeatureEnabled: (flag) => this.isFeatureEnabled(flag),
      createCronInboxTask: (job) => this.createCronInboxTask(job),
      getSessionAutonomyPrefs: (sessionId) => this.getSessionAutonomyPrefs(sessionId),
      patchSessionAutonomyPrefs: (sessionId, patch) => {
        this.patchSessionAutonomyPrefs(sessionId, patch);
      },
      listChatSessions: (query) => this.listChatSessions(query),
      getSessionIdleSeconds: (sessionId) => this.getSessionIdleSeconds(sessionId),
      hasRunningTurn: (sessionId) => this.hasRunningTurn(sessionId),
      isReplayScratchSession: (sessionId) => this.isReplayScratchSession(sessionId),
      getSession: (sessionId) => this.getSession(sessionId),
      normalizeWorkspaceId: (workspaceId) => this.normalizeWorkspaceId(workspaceId),
      ensureChatSessionRuntimeGrants: (sessionId) => {
        this.ensureChatSessionRuntimeGrants(sessionId);
      },
      listConnectorRecords: (kind) => this.listConnectorRecords(kind),
      listToolCatalog: () => this.listToolCatalog(),
      registerSyntheticPermissionProfile: (profile) => this.registerSyntheticPermissionProfile(profile),
      prepareAgentChatTurn: (sessionId, request, options) => this.prepareAgentChatTurn(sessionId, request, options),
      buildDurableChatTurnPayloadRecord: (prepared, request) =>
        durableChatTurnPayloadToRecord(
          this.createDurableChatTurnPayload(prepared, request, "chat_thread_turn_appended"),
        ),
      createDurableRun: (input) => this.createDurableRun(input),
      persistChatStreamChunk: (chunk, runId) => this.persistChatStreamChunk(chunk, runId),
      requestDurableRunProcessing: (runId) => this.requestDurableRunProcessing(runId),
    };
  }

  private async runCronAgentTurn(input: {
    job: CronJobRecord;
    runId: string;
    config: CronAgentTurnConfig;
  }): Promise<AgentTurnCronRunOutcome> {
    return runCronAgentTurn(this.chatAutonomousTurnDeps(), input);
  }

  private async runCommitmentSweep(): Promise<void> {
    await runCommitmentSweep(this.chatAutonomousTurnDeps());
  }

  private async runHeartbeatSweep(): Promise<void> {
    await runHeartbeatSweep(this.chatAutonomousTurnDeps());
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

  private async enqueueAutonomousChatTurn(input: {
    sessionId: string;
    prompt: string;
    runId: string;
    systemActorId: string;
    reason: string;
    kind?: AutonomousTurnKind;
    deliveryChannel?: CronAgentTurnConfig["deliveryChannel"];
    deliverMode: NonNullable<CronAgentTurnConfig["deliverMode"]>;
    policyContext?: ToolPolicyActorContext;
    profilePosture?: AgentTurnCronRunOutcome["profilePosture"];
    commitmentId?: string;
  }): Promise<{ runId: string; turnId: string } | undefined> {
    return enqueueAutonomousChatTurn(this.chatAutonomousTurnDeps(), input);
  }

  private async scheduleManage(
    args: Record<string, unknown>,
    policyContext: ToolPolicyActorContext | undefined,
  ): Promise<Record<string, unknown>> {
    return scheduleManage(this.chatAutonomousTurnDeps(), args, policyContext);
  }

  public beginDurableChatRun(
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    input: ChatSendMessageRequest,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
    options?: { mutationLifecycle?: import("./chat-turn-types.js").ChatStreamMutationLifecycle; runId?: string },
  ): DurableRunRecord | undefined {
    return chatDurableRunService.beginDurableChatRun(
      {
        shouldUseDurableExecution: this.shouldUseDurableExecution(prepared, input),
        createDurableRun: (runInput) => this.createDurableRun(runInput),
        buildDurablePayloadRecord: (preparedTurn, request, eventType) =>
          durableChatTurnPayloadToRecord(this.createDurableChatTurnPayload(preparedTurn, request, eventType)),
        persistChatStreamChunk: (chunk, durableRunId) => this.persistChatStreamChunk(chunk, durableRunId),
        chatTurnTraces: this.storage.chatTurnTraces,
        requestDurableRunProcessing: (runId) => this.durableRunService.requestRunProcessing(runId),
      },
      prepared,
      input,
      threadEventType,
      options,
    );
  }

  public finalizeDurableChatRun(
    runId: string,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    trace: ChatTurnTraceRecord,
    expectedLeaseOwnerId?: string,
  ): void {
    chatDurableRunService.finalizeDurableChatRun(
      {
        runImmediateTransaction: (callback) => this.storage.runImmediateTransaction(callback),
        durableRuns: this.storage.durableRuns,
        chatToolRuns: this.storage.chatToolRuns,
        chatToolArtifacts: this.storage.chatToolArtifacts,
        chatMessages: this.storage.chatMessages,
        recordDurableTimelineEvent: (durableRunId, eventType, payload) =>
          this.recordDurableTimelineEvent(durableRunId, eventType, payload),
        chatTurnTraces: this.storage.chatTurnTraces,
      },
      runId,
      prepared,
      trace,
      expectedLeaseOwnerId,
    );
  }

  private async executePreparedAgentChatTurnBackground(
    sessionId: string,
    input: ChatSendMessageRequest,
    prepared: Awaited<ReturnType<GatewayService["prepareAgentChatTurn"]>>,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
    durableRunId: string | undefined,
    resolvedOrchestration: PreparedChatExecutionPlanResolution | undefined,
    options: {
      streamRegistration: ActiveChatTurnStreamExecution;
      skipMessageStart?: boolean;
      durableLeaseOwnerId?: string;
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

  public async invokeTool(
    request: ToolInvokeRequest,
    options?: ToolInvocationRuntimeOptions,
  ): Promise<ToolInvokeResult> {
    return this.toolInvocationCoordinator.invokeTool(request, options);
  }

  private async executeApprovedPendingAction(
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<ToolInvokeResult | undefined> {
    try {
      this.refreshApprovedPendingToolPolicyContext(approvalId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Approved action policy context could not be refreshed.";
      this.storage.runImmediateTransaction(() => {
        this.storage.pendingApprovalActions.markResolved(approvalId, "failed", { reason });
        this.storage.approvalEvents.append({
          approvalId,
          eventType: "approved_action_executed",
          actorId: "system",
          payload: { outcome: "blocked", reason },
        });
      });
      return undefined;
    }
    const pending = this.storage.pendingApprovalActions.find(approvalId);
    if (pending?.actionType === "integration.dry_run_commit") {
      return this.executeApprovedIntegrationDryRunCommit(approvalId, pending);
    }
    if (isApprovedExternalRuntimePendingAction(pending)) {
      return this.executeApprovedExternalRuntimePendingAction(approvalId, pending, signal);
    }
    return this.policyEngine.executeApprovedAction(approvalId, signal);
  }

  /**
   * Approved dry-run commit replay (integration operator actions, dry-run Stage 2).
   * Marks the operator approval on the persisted preview, then re-invokes the SAME
   * action in commit mode: the owning write path rebuilds the planned action from
   * live state and `commitDryRun` refuses pre-boundary unless its hash matches the
   * approved preview byte-for-byte. Ward effects are re-evaluated on replay, so a
   * deny that landed after the preview still wins over the approval.
   */
  private async executeApprovedIntegrationDryRunCommit(
    approvalId: string,
    pending: PendingApprovalAction,
  ): Promise<ToolInvokeResult | undefined> {
    const request = pending.request;
    const dryRunId = readRecordString(request, "dryRunId");
    const connectionId = readRecordString(request, "connectionId");
    const actionId = readRecordString(request, "actionId");
    const invokeRequest = isRecord(request.invokeRequest) ? request.invokeRequest : {};
    const finish = (result: ToolInvokeResult): ToolInvokeResult => {
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
          actionType: "integration.dry_run_commit",
          outcome: result.outcome,
          policyReason: result.policyReason,
          dryRunId,
          connectionId,
          actionId,
        },
      });
      return result;
    };
    if (!dryRunId || !connectionId || !actionId) {
      return finish({
        outcome: "blocked",
        policyReason:
          "Approved dry-run commit is missing its linkage (dryRunId/connectionId/actionId); nothing was executed.",
        auditEventId: randomUUID(),
      });
    }
    let approvedBy = "operator";
    try {
      approvedBy = this.storage.approvals.get(approvalId).resolvedBy ?? "operator";
    } catch {
      // Keep the fallback actor; the commit still verifies against the approved hash.
    }
    approveDryRun(this.storage.dryRunCommits, dryRunId, {
      approvedBy,
      approvedAt: new Date().toISOString(),
    });
    try {
      const idempotencyKey = readRecordString(invokeRequest, "idempotencyKey");
      const actionResult = await invokeIntegrationConnectionAction(
        buildIntegrationActionHostForGateway(this.getRouteCompositionPort()),
        connectionId,
        actionId,
        {
          input: isRecord(invokeRequest.input) ? invokeRequest.input : {},
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
        { dryRunCommit: { dryRunId, approvedBy } },
      );
      return finish({
        outcome: actionResult.status === "executed" ? "executed" : "blocked",
        policyReason: actionResult.message,
        auditEventId: randomUUID(),
        result: {
          connectionId,
          actionId,
          dryRunId,
          status: actionResult.status,
          ...(actionResult.blockedReason ? { blockedReason: actionResult.blockedReason } : {}),
          ...(actionResult.output ? { output: actionResult.output } : {}),
        },
      });
    } catch (error) {
      return finish({
        outcome: "blocked",
        policyReason:
          error instanceof Error ? error.message : "Approved dry-run commit failed before reaching the boundary.",
        auditEventId: randomUUID(),
      });
    }
  }

  private async executeApprovedExternalRuntimePendingAction(
    approvalId: string,
    pending: PendingApprovalAction,
    signal?: AbortSignal,
  ): Promise<ToolInvokeResult | undefined> {
    return executeApprovedExternalRuntimePendingActionWithPort(
      {
        storage: this.storage,
        executeApprovedAction: (id, abortSignal, options) =>
          this.policyEngine.executeApprovedAction(id, abortSignal, options),
        enrichMcpInvokePolicyContext: (input) => this.enrichMcpInvokePolicyContext(input),
        invokeApprovedMcpRuntime: (input, markStarted) =>
          this.toolInvocationCoordinator.invokeApprovedMcpRuntime(input, markStarted),
        invokeApprovedExternalRuntimeTool: (request, markStarted) =>
          this.toolInvocationCoordinator.invokeApprovedExternalRuntimeTool(request, markStarted),
      },
      approvalId,
      pending,
      signal,
    );
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
    let profile!: PermissionProfileRecord;
    this.storage.gatewaySql.runImmediateTransaction(() => {
      profile = this.storage.permissionProfiles.createProfile(input);
      if (profile.defaultForSurfaces?.length) {
        this.reconcilePermissionProfileDefaultActivations(profile);
      }
    });
    this.publishToolConfigurationRealtimeSafely("permission_profile_created", {
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
    let profile!: PermissionProfileRecord;
    this.storage.gatewaySql.runImmediateTransaction(() => {
      profile = this.storage.permissionProfiles.updateProfile(profileId, input);
      if (input.defaultForSurfaces !== undefined) {
        this.reconcilePermissionProfileDefaultActivations(profile);
      }
    });
    this.publishToolConfigurationRealtimeSafely("permission_profile_updated", {
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
      this.publishToolConfigurationRealtimeSafely("permission_profile_archived", { profileId });
    }
    return archived;
  }

  public activatePermissionProfile(input: PermissionProfileActivationInput): PermissionProfileActivationRecord {
    const profile = this.storage.permissionProfiles.getProfile(input.profileId);
    this.assertPermissionProfileApprovalModeAllowed(profile.approvalMode);
    const activation = this.storage.gatewaySql.runImmediateTransaction(() =>
      this.storage.permissionProfiles.activateProfile({
        ...input,
        operatorId: profile.scope === "workspace" ? undefined : input.operatorId,
      }),
    );
    this.publishToolConfigurationRealtimeSafely("permission_profile_activated", {
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
    const override = this.storage.gatewaySql.runImmediateTransaction(() =>
      this.storage.permissionProfiles.createLocalOperatorOverride(input),
    );
    this.publishToolConfigurationRealtimeSafely("local_operator_override_started", {
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
    let record: LocalOperatorOverrideRecord | undefined;
    this.storage.gatewaySql.runImmediateTransaction(() => {
      const revoked = this.storage.permissionProfiles.revokeLocalOperatorOverride(overrideId, undefined, revokedBy);
      if (revoked) {
        record = this.storage.permissionProfiles.getLocalOperatorOverride(overrideId);
      }
    });
    if (!record) {
      return undefined;
    }
    this.publishToolConfigurationRealtimeSafely("local_operator_override_revoked", {
      overrideId,
      revokedBy: record.revokedBy,
      revokedAt: record.revokedAt,
      status: record.status,
    });
    return record;
  }

  private publishToolConfigurationRealtimeSafely(eventType: string, payload: Record<string, unknown>): void {
    try {
      this.publishRealtime(eventType, "tools", payload);
    } catch (error) {
      try {
        this.recordDevDiagnostic({
          level: "warn",
          category: "tools",
          event: "tools.configuration.realtime_projection_failed",
          message: "Tool configuration committed before retained realtime publication failed",
          runtimeKind: "tools.configuration",
          runtimeStatus: "failed",
          runtimeError: {
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
          context: { eventType, mutationCommitted: true },
        });
      } catch {
        // Configuration truth is already durable; diagnostics are advisory.
      }
    }
  }

  public listToolGrants(scope?: ToolGrantScope, scopeRef?: string, limit = 200): ToolGrantRecord[] {
    return this.approvalRuntime.listToolGrants(scope, scopeRef, limit);
  }

  private listActiveToolGrants(scope?: ToolGrantScope, scopeRef?: string): ToolGrantRecord[] {
    return this.storage.toolGrants.listActive(scope, scopeRef);
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

  public async createApproval(
    input: ApprovalCreateInput,
    onCreated?: ApprovalCreateCommitHook,
    authority?: ApprovalCreateAuthority,
  ): Promise<ApprovalRequest> {
    const approval = authority
      ? await this.approvalRuntime.createApproval(input, onCreated, authority)
      : await this.approvalRuntime.createApproval(input, onCreated);
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
    connectorId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
    resolvedBy?: string;
  }): Promise<ApprovalResolveResult> {
    return this.approvalRuntime.resolveApprovalWithRemoteToken(input);
  }

  public async resolveApprovalWithRemoteTokenId(input: {
    tokenId: string;
    connectorId: string;
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
    return enqueueApprovalRemoteTokenConnectorDelivery(
      {
        tokenSecrets: this.approvalRemoteTokenSecrets,
        requestAttribution: this.getCurrentRequestAttribution(),
        createDurableRun: (input) => this.createDurableRun(input),
      },
      { approval, connector, tokenRecord },
    );
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
    const deliveryRunId = `autonomous-delivery:${input.runId}`;
    const existing = this.findAutonomousChannelDeliveryRun(deliveryRunId, input.runId);
    if (existing) {
      return existing.runId;
    }
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
    const createInput: DurableRunCreateRequest = {
      runId: deliveryRunId,
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
    };
    let run: DurableRunRecord;
    try {
      run = this.createDurableRun(createInput);
    } catch (error) {
      const raced = this.findAutonomousChannelDeliveryRun(deliveryRunId, input.runId);
      if (!raced) {
        throw error;
      }
      run = raced;
    }
    return run.runId;
  }

  private findAutonomousChannelDeliveryRun(deliveryRunId: string, sourceRunId: string): DurableRunRecord | undefined {
    let existing: DurableRunRecord;
    try {
      existing = this.storage.durableRuns.getRun(deliveryRunId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return undefined;
      }
      throw error;
    }
    if (
      existing.workflowKey !== "connector.delivery" ||
      existing.metadata?.deliveryKind !== "autonomous.assistant_message" ||
      existing.metadata?.sourceRunId !== sourceRunId ||
      existing.payload?.runId !== sourceRunId
    ) {
      throw new ConflictError({
        message: `Durable run id ${deliveryRunId} is already owned by a different workflow handoff.`,
      });
    }
    return existing;
  }

  /**
   * Prune a silent heartbeat turn from a human transcript (P1-F4 invisibility).
   * Removes the seed user message + `{notify:false}` assistant message and the
   * turn trace, reverting the active branch leaf to the pre-heartbeat leaf, in a
   * single transaction (mirroring the undo path). Returns explicit recovery
   * truth so retryable storage failures remain pending while an advanced branch
   * becomes operator-visible manual reconciliation instead of being rewound.
   */
  /** @internal */ public cleanupSilentHeartbeatTurn(
    input: durableExecutionService.SilentHeartbeatCleanupRequest,
  ): durableExecutionService.SilentHeartbeatCleanupResult {
    let removed = false;
    let resolution: durableExecutionService.SilentHeartbeatCleanupResult = { status: "already_completed" };
    try {
      const messageIds = [input.userMessageId, input.assistantMessageId].filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      );
      this.storage.runImmediateTransaction(() => {
        const activeLeafTurnId = this.storage.chatSessionBranchState.get(input.sessionId)?.activeLeafTurnId;
        const hasMessages = messageIds.some((messageId) => Boolean(this.storage.chatMessages.get(messageId)));
        let hasTrace = true;
        try {
          this.storage.chatTurnTraces.get(input.turnId);
        } catch (error) {
          if (error instanceof NotFoundError) {
            hasTrace = false;
          } else {
            throw error;
          }
        }
        if (!hasMessages && !hasTrace) {
          return;
        }
        if (activeLeafTurnId !== input.turnId) {
          resolution = {
            status: "manual_reconciliation",
            reason:
              `Silent heartbeat ${input.turnId} was retained because the active leaf advanced to ` +
              `${activeLeafTurnId ?? "none"}; automatic cleanup would corrupt newer branch truth.`,
          };
          return;
        }
        this.storage.chatMessages.deleteByMessageIds(input.sessionId, messageIds);
        this.storage.chatTurnTraces.deleteByTurnIds(input.sessionId, [input.turnId]);
        if (input.parentTurnId) {
          const reverted = this.storage.chatSessionBranchState.setActiveLeafIfCurrent(
            input.sessionId,
            input.turnId,
            input.parentTurnId,
            new Date().toISOString(),
          );
          if (!reverted) {
            throw new Error(`Silent heartbeat ${input.turnId} lost active-leaf ownership during cleanup.`);
          }
        } else {
          this.storage.chatSessionBranchState.clear(input.sessionId);
        }
        removed = true;
        resolution = { status: "completed" };
      });
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
      return {
        status: "retryable_failure",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!removed) {
      return resolution;
    }
    try {
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
        event: "chat.heartbeat.cleanup_projection_failed",
        message: "Silent heartbeat cleanup committed, but its realtime projection failed.",
        sessionId: input.sessionId,
        turnId: input.turnId,
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    }
    return { status: "completed" };
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
    options?: import("./approval-resolution-effects-service.js").ApprovalResolutionEffectEnqueueOptions,
  ): ApprovalEffectRecord[] {
    const effects = this.approvalEffectsService.enqueueResolutionEffects(approval, input, options);
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
    options?: approvalRemoteTokenService.RemoteActionTokenClaimOptions,
  ): RemoteActionTokenRecord {
    return options
      ? approvalRemoteTokenService.consumeRemoteActionToken(this, token, expectedActionType, options)
      : approvalRemoteTokenService.consumeRemoteActionToken(this, token, expectedActionType);
  }

  /** @internal */ public consumeRemoteActionTokenById(
    tokenId: string,
    expectedActionType: RemoteActionTokenRecord["actionType"],
    options?: approvalRemoteTokenService.RemoteActionTokenClaimOptions,
  ): RemoteActionTokenRecord {
    return options
      ? approvalRemoteTokenService.consumeRemoteActionTokenById(this, tokenId, expectedActionType, options)
      : approvalRemoteTokenService.consumeRemoteActionTokenById(this, tokenId, expectedActionType);
  }

  public listSkills(): SkillListItem[] {
    this.skillStateService.ensureSkillStates(this.skillsService.list().map((skill) => skill.skillId));
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
    this.skillStateService.ensureSkillStates(loaded.map((skill) => skill.skillId));
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
    return this.skillStateService.getActivationPolicy();
  }

  public updateSkillActivationPolicy(input: Partial<SkillActivationPolicy>): SkillActivationPolicy {
    return this.skillStateService.updateActivationPolicy(input);
  }

  public setSkillState(skillId: string, state: SkillRuntimeState, note?: string): SkillStateRecord {
    return this.skillStateService.setSkillState(skillId, state, note);
  }

  public bulkSetSkillState(skillIds: string[], state: SkillRuntimeState, note?: string): SkillStateRecord[] {
    return this.skillStateService.bulkSetSkillState(skillIds, state, note);
  }

  /**
   * Restore a skill archived by the S3 idle janitor to its captured prior state.
   * Returns false when no snapshot exists for the skill. Used by the global
   * autonomous-rollback path.
   */
  public restoreCuratorIdleSkillSnapshot(skillId: string): boolean {
    return this.skillStateService.restoreCuratorIdleSnapshot(skillId);
  }

  public resolveSkillActivation(input: SkillResolveInput) {
    const policy = this.getSkillActivationPolicy();
    const base = this.skillsService.resolveActivation(input);
    const stateMap = this.skillStateService.readSkillStates();
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

    this.skillStateService.recordSkillUsage(selected.map((skill) => skill.skillId));

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
    persistContextManifestForCompletionRequest({ contextManifests: this.storage.contextManifests }, input);
  }

  public listMemoryItems(
    input: {
      namespace?: string;
      workspaceId?: string;
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
    assertGatewayDeploymentProfileUpdate(input, {
      currentDeploymentProfile: this.config.assistant.deploymentProfile,
      currentAuthMode: this.config.assistant.auth.mode,
      currentAllowLoopbackBypass: this.config.assistant.auth.allowLoopbackBypass,
      currentDefaultToolProfile: this.config.assistant.defaultToolProfile,
      currentToolPolicyProfile: this.config.toolPolicy.tools?.profile,
      currentToolPolicyApprovalMode: this.config.toolPolicy.tools?.approvalMode,
      currentAssistantToolApprovalMode: this.config.assistant.toolApprovalMode,
      currentNetworkAllowlist: this.config.toolPolicy.sandbox.networkAllowlist,
      allowedOriginsEnv: process.env.GOATCITADEL_ALLOWED_ORIGINS,
    });
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
    assertGatewayFirecrawlRuntimeUpdate(input, {
      currentNetworkAllowlist: this.config.toolPolicy.sandbox.networkAllowlist,
      currentFirecrawlEnabled: this.config.assistant.web.firecrawl.enabled,
      currentFirecrawlBaseUrl: this.config.assistant.web.firecrawl.baseUrl,
    });
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
    this.skillStateService.recordSkillImportEvent(validation, "import_validated");
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
    this.skillStateService.recordSkillImportEvent(installed.validation, "import_installed");
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

  public async invokeMcpTool(
    input: McpInvokeRequest,
    options?: ToolInvocationRuntimeOptions,
  ): Promise<McpInvokeResponse> {
    // Capability-scope enforcement happens at the coordinator's executeMcpRuntime choke point
    // (via host.assertMcpServerInScope), which also covers the model approval-replay path and
    // internal servers. Enrich here so the gate sees the resolved workspaceId.
    return this.toolInvocationCoordinator.invokeMcpTool(this.enrichMcpInvokePolicyContext(input), options);
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
          : queued.status === "failed" ||
              queued.status === "stale" ||
              queued.status === "manual_reconciliation_required"
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
    return sendQueuedChannelDeliveryImpl((sendInput) => commsSendImpl(this.buildCommsHost(), sendInput), input);
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
    clearLease?: boolean;
    expectedLeaseOwnerId?: string;
  }): DurableRunRecord {
    return this.durableRunService.updateRunState(input);
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
    const stored =
      this.storage.systemSettings.get<Partial<RuntimeSettings["features"]>>(FEATURE_FLAGS_SETTING_KEY)?.value;
    const driftedFields = computeDurableBaselineDrift({
      durable: this.config.assistant.durable,
      configuredFeatureFlag: this.config.assistant.features.durableKernelV1Enabled,
      storedDurableKernelFlag: stored?.durableKernelV1Enabled,
    });
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
    const next = buildUpdatedFeatureFlags(current, patch);
    const autonomyKillSwitchDisengaged = didDisengageAutonomyKillSwitch(current, next);
    this.storage.systemSettings.set(FEATURE_FLAGS_SETTING_KEY, next);
    this.config.assistant.features = { ...next };
    // Prime the read cache so the new flags are visible immediately (Finding 6);
    // this is the sole writer, so no invalidation race with the TTL path.
    this.featureFlagsCache = next;
    this.featureFlagsCacheAtMs = Date.now();
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
    const nowMs = Date.now();
    if (this.featureFlagsCache && nowMs - this.featureFlagsCacheAtMs < FEATURE_FLAGS_CACHE_TTL_MS) {
      return this.featureFlagsCache;
    }
    const stored =
      this.storage.systemSettings.get<Partial<RuntimeSettings["features"]>>(FEATURE_FLAGS_SETTING_KEY)?.value;
    const fromConfig = this.config.assistant.features;
    const resolved = resolveGatewayFeatureFlags(stored, fromConfig);
    this.featureFlagsCache = resolved;
    this.featureFlagsCacheAtMs = nowMs;
    return resolved;
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

  public syncSignalInboundRuntime(): void {
    try {
      this.signalInboundRuntimeService.sync();
    } catch (error) {
      this.recordDevDiagnostic({
        level: "warn",
        category: "channels",
        event: "signal.inbound.sync_failed",
        message: "Signal inbound runtime sync failed.",
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
    return this.mcpServerStore.readServers();
  }

  /** @internal */ public writeMcpServers(servers: McpServerRecord[]): void {
    this.mcpServerStore.writeServers(servers);
  }

  /** @internal */ public requireMcpServer(serverId: string): McpServerRecord {
    return this.mcpServerStore.requireServer(serverId);
  }

  /** @internal */ public patchMcpServerState(
    serverId: string,
    patch: Partial<Pick<McpServerRecord, "status" | "lastConnectedAt" | "lastError">>,
  ): McpServerRecord {
    return this.mcpServerStore.patchServerState(serverId, patch);
  }

  /** @internal */ public async resolveConnectedMcpTools(
    server: McpServerRecord,
    existingTools: McpToolRecord[],
    actorContext?: ToolPolicyActorContext,
  ): Promise<McpToolRecord[]> {
    return mcpServerAdminService.resolveConnectedMcpTools(
      {
        networkAllowlist: this.config.toolPolicy.sandbox.networkAllowlist,
        resolveOAuthAccessToken: (mcpServer) => this.mcpOAuth.resolveAccessToken(mcpServer),
      },
      server,
      existingTools,
      actorContext,
    );
  }

  /** @internal */ public readMcpTools(): McpToolRecord[] {
    return this.mcpServerStore.readTools();
  }

  /** @internal */ public writeMcpTools(tools: McpToolRecord[]): void {
    this.mcpServerStore.writeTools(tools);
  }

  /** @internal */ public readMcpAuthState(): Record<string, McpAuthStateRecord> {
    return this.mcpServerStore.readAuthState();
  }

  /** @internal */ public writeMcpAuthState(state: Record<string, McpAuthStateRecord>): void {
    this.mcpServerStore.writeAuthState(state);
  }

  private isMcpToolApproved(serverId: string, toolName: string): boolean {
    return this.mcpServerStore.isToolApproved(serverId, toolName);
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
    this.signalInboundRuntimeService.stop();
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
    const grant = this.storage.toolGrants.createTtlForDuration(
      {
        toolPattern: toolName,
        decision: "allow",
        scope: "session",
        scopeRef: sessionId,
        createdBy,
      },
      INTERNAL_TOOL_GRANT_TTL_MS,
    );
    this.publishRealtime("system", "tools", {
      type: "internal_tool_grant_created",
      sessionId,
      toolName,
      createdBy,
      expiresAt: grant.expiresAt,
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
        // Finding 1: scope orchestration memory-item collection to the run's workspace.
        workspaceId: run.workspaceId ?? "default",
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

  private ensureMemoryConsolidationCronJob(): void {
    return cronJobConfigHelpers.ensureMemoryConsolidationCronJob(this);
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

function readRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
