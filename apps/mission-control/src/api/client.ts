/* eslint-disable @typescript-eslint/no-unused-vars */
import type {
  AddonActionResponse,
  AddonCatalogEntry,
  AddonInstalledRecord,
  AddonInstallRequest,
  AddonStatusRecord,
  AddonUninstallResponse,
  AgentProfileArchiveInput,
  AgentProfileCreateInput,
  AgentProfileRecord,
  AgentProfileUpdateInput,
  AuthSettingsUpdateInput,
  DeviceAccessGrantListResponse,
  DeviceAccessGrantRevokeResponse,
  DiscordPairingRecord,
  DiscordRuntimeStatus,
  ApprovalBulkResolveResult,
  ApprovalReplaySnapshot,
  ApprovalRequest,
  AssemblyRunDetailResponse,
  AssemblyRunRecord,
  ChangeRiskEvaluationResponse,
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupDraftCreateInput,
  ChannelSetupDraftUpdateInput,
  ChannelSetupFinalizeResult,
  ChannelSetupTestResult,
  ChannelSetupValidationResult,
  ChatAttachmentRecord,
  ChatMode,
  ChatAttachmentPreviewResponse,
  ChatCitationRecord,
  ChatCancelTurnResponse,
  ChatDelegateRequest,
  ChatDelegateAcceptRequest,
  ChatDelegateSuggestRequest,
  ChatDelegateSuggestResponse,
  ChatDelegateResponse,
  ChatDelegationSuggestionRecord,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatMessageRecord,
  ChatProjectRecord,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionBindingRecord,
  ChatSessionBulkArchiveResult,
  ChatSessionOrigin,
  ChatSessionPrefsRecord,
  ChatSessionPrefsPatch,
  ChatSessionRecord,
  ChatSpecialistCandidatePatchInput,
  ChatSpecialistCandidateRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ChatStreamChunk,
  ChatThreadResponse,
  ChatThinkingLevel,
  ChatTurnTraceRecord,
  ChatWebMode,
  GatewayInstallTokenResolution,
  MemoryContextPack,
  NpuModelManifest,
  NpuRuntimeStatus,
  OnboardingBootstrapInput,
  OnboardingBootstrapResult,
  OnboardingState,
  IntegrationFormSchema,
  IntegrationPluginRecord,
  McpInvokeResponse,
  McpOAuthStartResponse,
  McpTemplateDiscoveryResult,
  McpServerRecord,
  McpServerTemplateRecord,
  McpToolRecord,
  MediaCreateJobRequest,
  MediaJobRecord,
  SessionMeta,
  SseTokenIssueResponse,
  ToolAccessEvaluateRequest,
  ToolAccessEvaluateResponse,
  ToolCatalogEntry,
  ToolGrantCreateInput,
  ToolGrantRecord,
  ToolInvokeResult,
  UiActionState,
  VoiceStatus,
  VoiceRuntimeInstallRequest,
  VoiceRuntimeStatus,
  VoiceTalkSessionRecord,
  VoiceTranscribeResponse,
  BackupCreateResponse,
  BackupManifestRecord,
  RetentionPolicy,
  RetentionPruneResult,
  ResearchRunRecord,
  ResearchSourceRecord,
  ResearchSummaryRecord,
  PromptPackRecord,
  PromptPackTestRecord,
  PromptPackRunRecord,
  PromptPackScoreRecord,
  PromptPackAutoScoreResult,
  PromptPackAutoScoreBatchResult,
  PromptPackBenchmarkStatusRecord,
  PromptPackReportRecord,
  PromptPackExportRecord,
  ReplayDiffSummary,
  ReplayOverrideDraft,
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunTimelineEvent,
  ConnectorRecord,
  ConnectorDiagnosticReport,
  CronReviewItem,
  CronRunDiff,
  ReplayRegressionRun,
  ReplayRegressionResult,
  CapabilityTrendSeries,
  CapabilityGapEventRecord,
  ProactivePolicy,
  ProactiveRunRecord,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryUpdateInput,
  LlmProviderConfig,
  LlmProviderRequestConfig,
  DecisionAutoTuneRecord,
  DecisionReplayFindingRecord,
  DecisionReplayItemRecord,
  DecisionReplayRunRecord,
  SkillActivationPolicy,
  SkillListItem,
  SkillSourceListResponse,
  SkillSourceLookupResponse,
  SkillImportValidationResult,
  SkillImportHistoryRecord,
  SkillSourceProvider,
  SkillImportSourceType,
  SkillStateRecord,
  SkillRuntimeState,
  ObsidianIntegrationConfig,
  ObsidianIntegrationStatus,
  WeeklyImprovementReportRecord,
  RepairCandidateRecord,
  GuidanceBundleRecord,
  GuidanceDocType,
  GuidanceDocumentRecord,
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceUpdateInput,
  CreateAssemblyRunInput,
  ModelReputation,
} from "@goatcitadel/contracts";
import type {
  AgentsResponse,
  ApprovalReplayResponse,
  ApprovalResolveResponse,
  ApprovalsResponse,
  CostSummaryResponse,
  CronJobRecordResponse,
  CronJobsResponse,
  DashboardStateResponse,
  IntegrationCatalogEntry,
  IntegrationConnection,
  LlmChatCompletionResponse,
  MeshLeaseRecord,
  MeshNodeRecord,
  MeshReplicationOffsetRecord,
  MeshSessionOwnerRecord,
  MeshStatusResponse,
  OnboardingCompleteResponse,
  OperatorsResponse,
  RealtimeEvent,
  RuntimeSettingsResponse,
  SystemVitalsResponse,
  TaskActivityRecord,
  TaskDeliverableRecord,
  TaskRecord,
  TaskSubagentSession,
} from "./types.js";
import { recordClientDiagnostic } from "../state/dev-diagnostics-store";
import { iterateSsePayloads, parseSseJson } from "./streaming.js";
import { buildGatewayUrl, readStoredGatewayAuthState } from "./client-core.js";
import { computeReconnectDelay, issueSseBridgeToken } from "./sse-bridge.js";

export type { GuidanceDocumentRecord };
export type { ObsidianIntegrationConfig, ObsidianIntegrationStatus };
export type {
  LlamaCppHuggingFaceDownloadRequest,
  LlamaCppHuggingFaceDownloadStatus,
  LlamaCppInstallDetection,
  LlmRuntimeConfigResponse,
  ProviderSecretStatus,
} from "./platform.js";
export type { FileTemplate } from "./operators-agents-files.js";
export type { WorkspacesResponse } from "./workspaces.js";
export type { RuntimeLifecycleResponse, SessionSummary, SessionTimelineItem } from "./sessions.js";
export type {
  GatewayAccessPreflightResult,
  GatewayAccessPreflightStatus,
  GatewayAuthState,
  GatewayAuthStorageMode,
  GatewayBootstrapResult,
  GatewayStartupPhaseTiming,
  GatewayStartupTiming,
} from "./client-core.js";
export {
  buildGatewayUrl,
  clearGatewayAuthState,
  consumeGatewayAccessBootstrapFromLocation,
  getGatewayApiBaseUrl,
  getGatewayAuthStorageMode,
  normalizeGatewayBaseUrl,
  persistGatewayAuthState,
  preflightGatewayAccess,
  readStoredGatewayAuthState,
  setGatewayAuthStorageMode,
} from "./client-core.js";

import { ApiRequestError, isApiRequestError, isTrustedGatewayHost } from "./http-internal";

export { ApiRequestError, isApiRequestError, isTrustedGatewayHost };
export { connectDevDiagnosticsStream, fetchDevDiagnostics } from "./diagnostics.js";
const EVENT_CURSOR_STORAGE_KEY = "goatcitadel.events.cursor.v1";
const EVENT_CLIENT_ID_STORAGE_KEY = "goatcitadel.events.client.v1";

export interface UiActionResult<T> {
  state: UiActionState;
  startedAt: string;
  finishedAt: string;
  data?: T;
  error?: string;
}

export async function runUiAction<T>(operation: () => Promise<T>): Promise<UiActionResult<T>> {
  const startedAt = new Date().toISOString();
  try {
    const data = await operation();
    return {
      state: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      data,
    };
  } catch (error) {
    return {
      state: "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      error: (error as Error).message,
    };
  }
}

export * from "./types.js";
export { fetchRuntimeLifecycle, fetchSessionSummary, fetchSessions, fetchSessionTimeline } from "./sessions.js";

export type {
  ChatDelegationStreamChunk,
  ChatMessagesResponse,
  ChatProjectsResponse,
  ChatProactiveStatusResponse,
  ChatSessionsResponse,
  ChatToolArtifactResponse,
} from "./chat.js";
export {
  acceptChatDelegation,
  answerChatUserInputPrompt,
  approveChatTool,
  archiveChatProject,
  archiveChatSession,
  archiveWorkspaceChatSessions,
  assignChatSessionProject,
  cancelChatTurn,
  createChatSpecialistCandidate,
  createChatProject,
  createChatSession,
  deleteChatSession,
  denyChatTool,
  downloadChatAttachment,
  editChatTurn,
  fetchChatAttachment,
  fetchChatAttachmentPreview,
  fetchChatCommandCatalog,
  fetchChatDelegationRun,
  fetchChatLearnedMemory,
  fetchChatMessages,
  fetchChatPendingApprovals,
  fetchChatProactiveRuns,
  fetchChatProactiveStatus,
  fetchChatProjects,
  fetchChatResearchRun,
  fetchChatSessionBinding,
  fetchChatSessionPrefs,
  fetchChatSessions,
  fetchChatSpecialistCandidates,
  fetchChatToolArtifact,
  fetchChatThread,
  hardDeleteChatProject,
  pinChatSession,
  rebuildChatLearnedMemory,
  restoreChatProject,
  restoreChatSession,
  resumeChatTurnStream,
  retryChatTurn,
  runChatDelegation,
  runChatResearch,
  selectChatBranchTurn,
  sendAgentChatMessage,
  setChatSessionBinding,
  suggestChatDelegation,
  streamAgentChatMessage,
  streamChatDelegation,
  streamEditChatTurn,
  streamRetryChatTurn,
  triggerChatProactive,
  unpinChatSession,
  updateChatLearnedMemoryItem,
  updateChatProactivePolicy,
  updateChatProject,
  updateChatSessionPrefs,
  updateChatSession,
  updateChatSpecialistCandidate,
  uploadChatAttachment,
  parseChatCommand,
} from "./chat.js";
export {
  appendObsidianNote,
  approveDiscordPairing,
  commsCalendarCreate,
  commsCalendarList,
  commsGmailRead,
  commsGmailSend,
  commsReact,
  commsReply,
  commsSend,
  commsTyping,
  commsUnsend,
  captureObsidianInboxEntry,
  createChannelRepairDraft,
  createChannelRotateSecretDraft,
  createChannelSetupDraft,
  createIntegrationConnection,
  deleteIntegrationConnection,
  disableIntegrationPlugin,
  enableIntegrationPlugin,
  fetchChannelCapabilities,
  fetchChannelDiagnostics,
  fetchChannelRuntimeStatus,
  fetchChannelSetupDefinition,
  fetchChannelSetupDefinitions,
  fetchChannelSetupDrafts,
  fetchConnectorRecords,
  fetchDiscordPairings,
  fetchIntegrationCatalog,
  fetchIntegrationConnectionDiagnostics,
  fetchIntegrationConnections,
  fetchIntegrationFormSchema,
  fetchIntegrationPlugins,
  fetchObsidianIntegrationStatus,
  invokeIntegrationConnectionAction,
  installIntegrationPlugin,
  patchObsidianIntegrationConfig,
  readObsidianNote,
  reconnectDiscordRuntime,
  retestChannelConnection,
  revokeDiscordPairing,
  searchObsidianNotes,
  testChannelSetupDraft,
  testObsidianIntegration,
  updateChannelSetupDraft,
  updateIntegrationConnection,
  validateChannelSetupDraft,
  finalizeChannelSetupDraft,
} from "./integrations.js";
export {
  archiveWorkspace,
  createWorkspace,
  fetchGlobalGuidance,
  fetchWorkspaceGuidance,
  fetchWorkspaces,
  restoreWorkspace,
  updateGlobalGuidance,
  updateWorkspace,
  updateWorkspaceGuidance,
} from "./workspaces.js";
export {
  createCapabilityProposal,
  createCodeModeRun,
  fetchCapabilityCandidate,
  fetchCapabilityCatalog,
  fetchCapabilityCatalogSnapshot,
  fetchCapabilityProposal,
  fetchCapabilityProposals,
  fetchCodeModeRun,
  fetchCodeModeRuns,
  promoteCapabilityCandidate,
  revokeCapabilityCandidate,
  rollbackCapabilityCandidate,
} from "./capabilities.js";
export {
  archiveAgentProfile,
  createAgentProfile,
  createFileFromTemplate,
  downloadFile,
  fetchAgent,
  fetchAgents,
  fetchFileTemplates,
  fetchFilesList,
  fetchOperators,
  fetchPathSuggestions,
  hardDeleteAgentProfile,
  restoreAgentProfile,
  updateAgentProfile,
  uploadFile,
} from "./operators-agents-files.js";
export {
  autoScorePromptPackBatch,
  autoScorePromptPackTest,
  cancelPromptPackBenchmark,
  exportPromptPackReport,
  fetchPromptPackBenchmark,
  fetchPromptPackExport,
  fetchPromptPackReplayRegressionStatus,
  fetchPromptPackReport,
  fetchPromptPacks,
  fetchPromptPackTests,
  fetchPromptPackTrends,
  importPromptPack,
  resetPromptPack,
  runPromptPackBenchmark,
  runPromptPackReplayRegression,
  runPromptPackTest,
  scorePromptPackTest,
} from "./prompt-packs.js";
export {
  approveImprovementAutoTune,
  draftReplayOverride,
  executeReplayOverride,
  fetchCapabilityGapEvents,
  fetchImprovementActivation,
  fetchHarnessAuditReport,
  fetchImprovementCandidate,
  fetchImprovementCandidates,
  fetchImprovementReport,
  fetchImprovementReplayRun,
  fetchImprovementReplayRuns,
  fetchImprovementReports,
  fetchImprovementSignal,
  fetchImprovementSignals,
  fetchReplayDiff,
  fetchRepairCandidates,
  pauseImprovementActivation,
  requestImprovementActivation,
  rollbackImprovementActivation,
  revertImprovementAutoTune,
  runImprovementReplay,
  updateRepairCandidateValidation,
} from "./improvement.js";
export {
  acceptMemoryMaintenanceRecommendation,
  composeMemoryContext,
  fetchMemoryContext,
  fetchMemoryFiles,
  fetchMemoryItemHistory,
  fetchMemoryItems,
  fetchMemoryMaintenancePolicy,
  fetchMemoryMaintenanceRecommendations,
  fetchMemoryMaintenanceRunProvenance,
  fetchMemoryMaintenanceRuns,
  fetchMemoryMaintenanceStatus,
  fetchMemoryQmdStats,
  forgetMemory,
  forgetMemoryItem,
  knowledgeDocsIngest,
  knowledgeEmbeddingsIndex,
  knowledgeEmbeddingsQuery,
  knowledgeMemorySearch,
  knowledgeMemoryWrite,
  patchMemoryItem,
  patchMemoryMaintenancePolicy,
  rejectMemoryMaintenanceRecommendation,
  runMemoryMaintenanceNow,
} from "./memory.js";
export {
  createToolGrant,
  evaluateToolAccess,
  fetchApprovalReplay,
  fetchApprovals,
  fetchToolCatalog,
  fetchToolGrants,
  invokeTool,
  resolveApproval,
  resolveApprovalsBulk,
  resolveApprovalWithRemoteToken,
  revokeToolGrant,
} from "./approvals.js";
export {
  fetchCronJob,
  fetchCronJobs,
  fetchCronReviewQueue,
  fetchCronRunDiff,
  createCronJob,
  deleteCronJob,
  pauseCronJob,
  retryCronReviewQueueItem,
  runCronJobNow,
  startCronJob,
  updateCronJob,
} from "./cron.js";
export {
  createDurableRun,
  fetchDurableRun,
  fetchDurableRunTimeline,
  pauseDurableRun,
  resumeDurableRun,
  cancelDurableRun,
  retryDurableRun,
  wakeDurableRun,
  recoverDurableDeadLetter,
} from "./durable.js";
export {
  completeOnboarding,
  bootstrapOnboarding,
  fetchDeviceAccessGrants,
  fetchOnboardingState,
  fetchSettings,
  patchSettings,
  resolveGatewayInstallToken,
  revokeDeviceAccessGrant,
} from "./settings.js";
export {
  bulkUpdateSkillState,
  fetchSkillActivationPolicies,
  fetchSkillImportHistory,
  fetchSkillLookup,
  fetchSkills,
  fetchSkillSources,
  installSkillImport,
  patchSkillActivationPolicies,
  reloadSkills,
  updateSkillState,
  validateSkillImport,
} from "./skills.js";
export {
  addTaskActivity,
  addTaskDeliverable,
  createTask,
  deleteTask,
  fetchTaskActivities,
  fetchTaskDeliverables,
  fetchTasks,
  fetchTasksByView,
  fetchTaskSubagents,
  registerTaskSubagent,
  restoreTask,
  updateTask,
  updateTaskSubagent,
} from "./tasks.js";
export {
  createMcpServer,
  completeMcpOAuth,
  connectMcpServer,
  deleteMcpServer,
  disconnectMcpServer,
  fetchMcpServers,
  fetchMcpTemplateDiscovery,
  fetchMcpTemplates,
  fetchMcpTools,
  invokeMcpTool,
  runMcpServerHealthCheck,
  startMcpOAuth,
  updateMcpServer,
  updateMcpServerPolicy,
} from "./mcp.js";
export {
  createLlmChatCompletion,
  createAssemblyRun,
  deleteProviderSecret,
  evaluateUiChangeRisk,
  cancelLlamaCppHuggingFaceDownload,
  fetchAddonStatus,
  fetchAddonsCatalog,
  fetchAssemblyReputations,
  fetchAssemblyRunDetail,
  fetchAssemblyRuns,
  fetchDaemonLogs,
  fetchDaemonStatus,
  fetchInstalledAddons,
  fetchLlmConfig,
  fetchLlmModels,
  fetchMeshLeases,
  fetchMeshNodes,
  fetchMeshReplicationOffsets,
  fetchMeshSessionOwners,
  fetchMeshStatus,
  fetchLlamaCppAdvisor,
  detectLlamaCppInstall,
  fetchLlamaCppHuggingFaceDownload,
  fetchLlamaCppModels,
  fetchLlamaCppStatus,
  fetchNpuModels,
  fetchNpuStatus,
  fetchOrchestrationRun,
  fetchOrchestrationRunCheckpoints,
  fetchOrchestrationRunContext,
  fetchProviderSecretStatus,
  installAddon,
  launchAddon,
  previewLlmModels,
  refreshLlamaCppRuntime,
  refreshNpuRuntime,
  restartDaemon,
  saveProviderSecret,
  startLlamaCppHuggingFaceDownload,
  startLlamaCppRuntime,
  startDaemon,
  startNpuRuntime,
  stopAddon,
  stopDaemon,
  stopLlamaCppRuntime,
  stopNpuRuntime,
  uninstallAddon,
  updateAddon,
} from "./platform.js";
export {
  fetchVoiceRuntimeStatus,
  fetchVoiceStatus,
  fetchVoiceTalkSessions,
  installVoiceRuntime,
  removeVoiceRuntimeModel,
  selectVoiceRuntimeModel,
  startVoiceTalkSession,
  startVoiceWake,
  stopVoiceTalkSession,
  stopVoiceWake,
  transcribeVoice,
} from "./voice.js";
export {
  createBackup,
  createMediaJob,
  fetchCostSummary,
  fetchDashboardState,
  fetchHealthSummary,
  fetchMediaJob,
  fetchMediaJobs,
  fetchRealtimeEvents,
  fetchRetentionPolicy,
  fetchSystemVitals,
  fetchTimelineSummary,
  listBackups,
  pruneRetention,
  runCheaper,
  updateRetentionPolicy,
  verifyBackup,
} from "./system.js";

export type EventStreamConnectionState = "connecting" | "open" | "retrying" | "error" | "closed";

export interface EventStreamStatus {
  state: EventStreamConnectionState;
  reconnectAttempts: number;
  lastEventAt?: string;
  lastErrorAt?: string;
  leaseId?: string;
  clientId?: string;
  gatewayNodeId?: string;
}

interface EventStreamSubscriber {
  onEvent: (event: RealtimeEvent) => void;
  onStateChange?: (state: EventStreamConnectionState) => void;
  onStatusChange?: (status: EventStreamStatus) => void;
}

const eventStreamSubscribers = new Set<EventStreamSubscriber>();
let sharedEventSource: EventSource | null = null;
let eventReconnectTimer: number | null = null;
let eventConnectionState: EventStreamConnectionState = "closed";
let eventConnectAttempt = 0;
let eventConnectInFlight = false;
let reconnectAttempts = 0;
let lastEventAt: string | undefined;
let lastErrorAt: string | undefined;
let activeEventStreamLeaseId: string | undefined;
let activeEventStreamClientId: string | undefined;
let activeEventStreamGatewayNodeId: string | undefined;

export function connectEventStream(
  onEvent: (event: RealtimeEvent) => void,
  onStateChange?: (state: EventStreamConnectionState) => void,
  onStatusChange?: (status: EventStreamStatus) => void,
): () => void {
  const subscriber: EventStreamSubscriber = { onEvent, onStateChange, onStatusChange };
  eventStreamSubscribers.add(subscriber);
  notifyEventStreamState(subscriber, eventConnectionState);
  notifyEventStreamStatus(subscriber, buildEventStreamStatus());
  void ensureEventStreamConnected();

  return () => {
    eventStreamSubscribers.delete(subscriber);
    if (eventStreamSubscribers.size === 0) {
      eventConnectAttempt += 1;
      closeSharedEventSource();
      clearReconnectTimer();
      setEventConnectionState("closed");
      reconnectAttempts = 0;
      lastEventAt = undefined;
      lastErrorAt = undefined;
      activeEventStreamLeaseId = undefined;
      activeEventStreamClientId = undefined;
      activeEventStreamGatewayNodeId = undefined;
    }
  };
}

async function buildEventStreamUrl(): Promise<string> {
  const url = new URL(buildGatewayUrl("/api/v1/events/stream"));
  const clientId = getOrCreateRealtimeClientId();
  activeEventStreamClientId = clientId;
  url.searchParams.set("clientId", clientId);
  const lastCursor = readStoredRealtimeCursor();
  if (lastCursor !== undefined) {
    url.searchParams.set("afterCursor", String(lastCursor));
  } else {
    url.searchParams.set("replay", "20");
  }

  const auth = readStoredGatewayAuthState();
  if (!auth) {
    return url.toString();
  }

  if (
    auth.mode === "token" ||
    auth.mode === "basic" ||
    Boolean(auth.token?.trim()) ||
    Boolean(auth.username && auth.password)
  ) {
    const issued = await issueSseBridgeToken("events:stream");
    url.searchParams.set("sse_token", issued.token);
  }

  return url.toString();
}

async function ensureEventStreamConnected(): Promise<void> {
  if (sharedEventSource || eventConnectInFlight || eventStreamSubscribers.size === 0 || typeof window === "undefined") {
    return;
  }

  eventConnectInFlight = true;
  const connectAttempt = ++eventConnectAttempt;
  setEventConnectionState("connecting");
  recordClientDiagnostic({
    level: "info",
    category: "sse",
    event: "connect",
    message: "Connecting to realtime events",
  });

  let streamUrl: string;
  try {
    streamUrl = await buildEventStreamUrl();
  } catch {
    eventConnectInFlight = false;
    if (connectAttempt !== eventConnectAttempt || eventStreamSubscribers.size === 0) {
      return;
    }
    lastErrorAt = new Date().toISOString();
    setEventConnectionState("error");
    scheduleReconnect();
    return;
  }

  eventConnectInFlight = false;
  if (connectAttempt !== eventConnectAttempt || eventStreamSubscribers.size === 0) {
    return;
  }

  const source = new EventSource(streamUrl);
  sharedEventSource = source;

  source.onopen = () => {
    if (sharedEventSource !== source) {
      return;
    }
    clearReconnectTimer();
    reconnectAttempts = 0;
    setEventConnectionState("open");
    recordClientDiagnostic({
      level: "info",
      category: "sse",
      event: "open",
      message: "Realtime event stream connected",
    });
  };

  source.onmessage = (evt) => {
    if (sharedEventSource !== source) {
      return;
    }
    try {
      const event = JSON.parse(evt.data) as RealtimeEvent;
      if (typeof event.sequence === "number" && Number.isFinite(event.sequence)) {
        persistRealtimeCursor(event.sequence);
      }
      lastEventAt = event.timestamp || new Date().toISOString();
      recordClientDiagnostic({
        level: "debug",
        category: "sse",
        event: "freshness",
        message: event.eventType,
        context: {
          source: event.source,
          eventId: event.eventId,
        },
      });
      notifyEventStreamStatusToAll();
      for (const subscriber of eventStreamSubscribers) {
        subscriber.onEvent(event);
      }
    } catch {
      // ignore malformed messages
    }
  };

  source.addEventListener("replay-gap", (evt) => {
    if (sharedEventSource !== source) {
      return;
    }
    clearActiveEventStreamServerIdentity();
    clearStoredRealtimeCursor();
    lastErrorAt = new Date().toISOString();
    const replayGapEvent = buildReplayGapRealtimeEvent(evt.data);
    notifyEventStreamStatusToAll();
    for (const subscriber of eventStreamSubscribers) {
      subscriber.onEvent(replayGapEvent);
    }
  });

  source.addEventListener("stream-ready", (evt) => {
    if (sharedEventSource !== source) {
      return;
    }
    try {
      const payload = JSON.parse(evt.data) as {
        leaseId?: string;
        clientId?: string;
        gatewayNodeId?: string;
      };
      activeEventStreamLeaseId = typeof payload.leaseId === "string" ? payload.leaseId : undefined;
      activeEventStreamClientId = typeof payload.clientId === "string" ? payload.clientId : activeEventStreamClientId;
      activeEventStreamGatewayNodeId = typeof payload.gatewayNodeId === "string" ? payload.gatewayNodeId : undefined;
      notifyEventStreamStatusToAll();
    } catch {
      // ignore malformed readiness payloads
    }
  });

  source.onerror = () => {
    if (sharedEventSource !== source) {
      return;
    }
    closeSharedEventSource();
    if (eventStreamSubscribers.size === 0) {
      setEventConnectionState("closed");
      return;
    }
    clearActiveEventStreamServerIdentity();
    lastErrorAt = new Date().toISOString();
    setEventConnectionState("error");
    recordClientDiagnostic({
      level: "warn",
      category: "sse",
      event: "error",
      message: "Realtime event stream encountered an error",
    });
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (eventReconnectTimer !== null || typeof window === "undefined") {
    return;
  }

  reconnectAttempts += 1;
  setEventConnectionState("retrying");
  recordClientDiagnostic({
    level: "warn",
    category: "sse",
    event: "retry",
    message: "Scheduling realtime event reconnect",
    context: {
      reconnectAttempts,
    },
  });
  const delay = computeReconnectDelay(reconnectAttempts);

  eventReconnectTimer = window.setTimeout(() => {
    eventReconnectTimer = null;
    void ensureEventStreamConnected();
  }, delay);
}

function closeSharedEventSource(): void {
  eventConnectInFlight = false;
  if (!sharedEventSource) {
    return;
  }
  recordClientDiagnostic({
    level: "info",
    category: "sse",
    event: "close",
    message: "Realtime event stream closed",
  });
  sharedEventSource.close();
  sharedEventSource = null;
}

function clearReconnectTimer(): void {
  if (eventReconnectTimer === null || typeof window === "undefined") {
    return;
  }
  window.clearTimeout(eventReconnectTimer);
  eventReconnectTimer = null;
}

function clearActiveEventStreamServerIdentity(): void {
  activeEventStreamLeaseId = undefined;
  activeEventStreamGatewayNodeId = undefined;
}

function setEventConnectionState(state: EventStreamConnectionState): void {
  eventConnectionState = state;
  for (const subscriber of eventStreamSubscribers) {
    notifyEventStreamState(subscriber, state);
    notifyEventStreamStatus(subscriber, buildEventStreamStatus());
  }
}

function notifyEventStreamState(subscriber: EventStreamSubscriber, state: EventStreamConnectionState): void {
  subscriber.onStateChange?.(state);
}

function notifyEventStreamStatusToAll(): void {
  const status = buildEventStreamStatus();
  for (const subscriber of eventStreamSubscribers) {
    notifyEventStreamStatus(subscriber, status);
  }
}

function notifyEventStreamStatus(subscriber: EventStreamSubscriber, status: EventStreamStatus): void {
  subscriber.onStatusChange?.(status);
}

function buildEventStreamStatus(): EventStreamStatus {
  return {
    state: eventConnectionState,
    reconnectAttempts,
    lastEventAt,
    lastErrorAt,
    leaseId: activeEventStreamLeaseId,
    clientId: activeEventStreamClientId,
    gatewayNodeId: activeEventStreamGatewayNodeId,
  };
}

function readStoredRealtimeCursor(): number | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const raw = window.localStorage.getItem(EVENT_CURSOR_STORAGE_KEY)?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function persistRealtimeCursor(sequence: number): void {
  if (typeof window === "undefined" || !Number.isFinite(sequence) || sequence <= 0) {
    return;
  }
  window.localStorage.setItem(EVENT_CURSOR_STORAGE_KEY, String(sequence));
}

function clearStoredRealtimeCursor(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(EVENT_CURSOR_STORAGE_KEY);
}

function getOrCreateRealtimeClientId(): string {
  if (typeof window === "undefined") {
    return crypto.randomUUID();
  }
  const existing = window.localStorage.getItem(EVENT_CLIENT_ID_STORAGE_KEY)?.trim();
  if (existing) {
    return existing;
  }
  const next = crypto.randomUUID();
  window.localStorage.setItem(EVENT_CLIENT_ID_STORAGE_KEY, next);
  return next;
}

function buildReplayGapRealtimeEvent(rawPayload: string): RealtimeEvent {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawPayload) as Record<string, unknown>;
  } catch {
    payload = { error: "replay_gap" };
  }
  return {
    eventId: `replay-gap-${Date.now()}`,
    sequence: Number(payload.oldestCursor ?? 0),
    eventType: "system",
    source: "events",
    timestamp: new Date().toISOString(),
    eventClass: "ui_notification",
    eventAuthority: "retained_stream",
    correlationId: undefined,
    traceId: undefined,
    originSurface: "mission-control-web",
    payload: {
      kind: "replay_gap",
      ...payload,
    },
  };
}
