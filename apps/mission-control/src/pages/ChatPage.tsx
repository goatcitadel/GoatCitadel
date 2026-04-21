/* eslint-disable max-lines -- ChatPage remains the top-level orchestration entrypoint while behavior lives in focused hooks and dock sections. */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatAttachmentRecord,
  ChatGeneratedArtifactRecord,
  ChatMode,
  ChatModePresetRecord,
  RoutingPreflightResult,
  ChatSessionPrefsPatch,
  ChatThreadResponse,
  ThreadKnowledgeAttachmentRecord,
  ThreadKnowledgeRetrievalMode,
} from "@goatcitadel/contracts";
import { isChatTurnActiveStatus } from "@goatcitadel/contracts";
import {
  attachThreadKnowledgeAttachment,
  createChatGeneratedArtifact,
  fetchAgents,
  fetchChatGeneratedArtifact,
  fetchMcpServers,
  fetchMcpTemplates,
  fetchSkills,
  parseChatCommand,
  removeThreadKnowledgeAttachment,
  updateChatSessionPrefs,
} from "../api/client";
import { CardSkeleton } from "../components/CardSkeleton";
import { ConfirmModal } from "../components/ConfirmModal";
import { PageHeader } from "../components/PageHeader";
import { StatusChip } from "../components/StatusChip";
import type { ChatStreamStatus } from "../components/chat/ChatStreamStatusBar";
import type { ChatThreadNotice } from "../components/chat/ChatThreadView";
import { deriveCoworkRunViewModel } from "../components/cowork-view-model";
import { useEventStreamStatus } from "../hooks/useEventStreamStatus";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { pageCopy } from "../content/copy";
import {
  setDevDiagnosticsActiveChatSession,
  setDevDiagnosticsLatestTraceSummary,
} from "../state/dev-diagnostics-store";
import { ChatContextDockPanels } from "./chat/ChatContextDockPanels";
import { ChatSurfaceLayout } from "./chat/ChatSurfaceLayout";
import { ChatSessionSidebar } from "./chat/ChatSessionSidebar";
import { MissionControlActiveSessionSurface } from "./chat/MissionControlActiveSessionSurface";
import { MissionControlEmptyState } from "./chat/MissionControlEmptyState";
import { ChatWorkSurface, CodeWorkSurface, CoworkWorkSurface } from "./chat/MissionControlWorkSurfaces";
import { formatCommandResult } from "./chat/chat-page-derivations";
import { resolveProviderModelSelection } from "./chat/chat-page-helpers";
import { formatWorkProviderModelSummary, type WorkTrustDescriptor } from "./chat/work-trust";
import {
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
  resolveSelectedTurnId,
  resolveChatRefreshPlan,
  resolveOptimisticChatPrefs,
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
} from "./chat/chat-page-pure-helpers";
import { useChatApprovalController } from "./chat/useChatApprovalController";
import { useChatContextActions } from "./chat/useChatContextActions";
import { useChatComposerInteractions } from "./chat/useChatComposerInteractions";
import {
  abortActiveChatStream,
  type ActiveChatStreamState,
  useChatOutboundExecution,
} from "./chat/useChatOutboundExecution";
import {
  createAttachmentStorageKey,
  createDraftStorageKey,
  createQueueStorageKey,
  useDebouncedLocalStoragePersistence,
} from "./chat/useChatLocalPersistence";
import { useChatSessionData } from "./chat/useChatSessionData";
import { useChatSessionControls } from "./chat/useChatSessionControls";
import { useChatDockWorkbenchController } from "./chat/useChatDockWorkbenchController";
import { useChatProviderRoutingController } from "./chat/useChatProviderRoutingController";
import { useChatRoutePreflight } from "./chat/useChatRoutePreflight";
import type { ActiveChatDelegationRun } from "./chat/useChatDelegationPolicyActions";
import {
  resolveOutboundDraftContent,
  useChatSurfaceOrchestration,
  type OutboundQueueItem,
} from "./chat/useChatSurfaceOrchestration";
import { useChatThreadController } from "./chat/useChatThreadController";
import { useChatMultimodalControls } from "./chat/useChatMultimodalControls";
import {
  formatSessionLabel,
  looksMachineSessionLabel,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
  useMissionControlSurfaceState,
} from "./chat/useMissionControlSurfaceState";
import "../styles/chat.css";
import "../styles/chat-motion.css";
import "../styles/chat-surface.css";
import { createCodeModeRun } from "../api/capabilities";

export {
  formatSessionLabel,
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
  looksMachineSessionLabel,
  resolveSelectedTurnId,
  resolveChatRefreshPlan,
  resolveOptimisticChatPrefs,
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
};

const STREAM_PREF_KEY = "goatcitadel.chat.agent.stream.enabled";

function formatSelectionSourceSummary(source?: RoutingPreflightResult["selectionSource"]): string {
  switch (source) {
    case "session":
      return "Selection: session";
    case "global":
      return "Selection: global";
    case "manual":
      return "Selection: manual";
    default:
      return "Selection: pending";
  }
}

function formatRoutingTargetSummary(labels: Map<string, string>, providerId?: string, model?: string): string {
  return formatWorkProviderModelSummary(providerId ? (labels.get(providerId) ?? providerId) : undefined, model);
}

function formatFallbackSummary(preflight: RoutingPreflightResult | null): {
  summary: string;
  tone: WorkTrustDescriptor["fallbackTone"];
} {
  if (!preflight || preflight.fallbackPolicy === "off") {
    return {
      summary: "Fallback off",
      tone: "muted",
    };
  }
  if (preflight.fallbackResult === "local_to_cloud") {
    return {
      summary: "Fallback armed · local to cloud",
      tone: "warning",
    };
  }
  if (preflight.fallbackResult === "cloud_to_local") {
    return {
      summary: "Fallback armed · cloud to local",
      tone: "warning",
    };
  }
  return {
    summary: "Fallback armed",
    tone: "warning",
  };
}

function formatRuntimeSummary(preflight: RoutingPreflightResult | null): {
  summary: string;
  tone: WorkTrustDescriptor["runtimeTone"];
} {
  switch (preflight?.runtimeReachability) {
    case "reachable":
      return {
        summary: preflight.runtimeClass === "local" ? "Runtime reachable" : "Provider reachable",
        tone: "success",
      };
    case "unreachable":
      return {
        summary: preflight.runtimeClass === "local" ? "Runtime unreachable" : "Provider unreachable",
        tone: "critical",
      };
    case "models_unavailable":
      return {
        summary: preflight.runtimeClass === "local" ? "Models unavailable" : "Provider degraded",
        tone: "warning",
      };
    case "not_checked":
    default:
      return {
        summary: "Runtime not checked",
        tone: "muted",
      };
  }
}

function requiresBoundaryAcknowledgment(preflight: RoutingPreflightResult | null): boolean {
  return preflight?.fallbackResult === "local_to_cloud" || preflight?.fallbackResult === "cloud_to_local";
}

function isDocumentAttachment(attachment: ChatAttachmentRecord): boolean {
  const mimeType = attachment.mimeType.toLowerCase();
  if (attachment.mediaType === "image" || attachment.mediaType === "audio" || attachment.mediaType === "video") {
    return false;
  }
  return (
    attachment.mediaType === "text" ||
    mimeType.startsWith("text/") ||
    mimeType.includes("pdf") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    mimeType.includes("yaml") ||
    mimeType.includes("csv") ||
    mimeType.includes("markdown") ||
    Boolean(attachment.extractPreview?.trim()) ||
    Boolean(attachment.ocrText?.trim()) ||
    Boolean(attachment.transcriptText?.trim())
  );
}

function canReadAttachmentInFull(attachment: ChatAttachmentRecord): boolean {
  return (
    attachment.extractStatus === "ready" ||
    Boolean(attachment.extractPreview?.trim()) ||
    Boolean(attachment.ocrText?.trim()) ||
    Boolean(attachment.transcriptText?.trim())
  );
}

export function ChatPage({
  workspaceId = "default",
  workspaceName = workspaceId,
  approvalsCount = 0,
  surface,
  lockSurface = false,
  workTrust,
  onWorkTrustSummaryChange,
  onOpenCowork = () => undefined,
  onOpenCode = () => undefined,
  onOpenTasks = () => undefined,
  onOpenApprovals = () => undefined,
  onNavigateSurface,
}: {
  workspaceId?: string;
  workspaceName?: string;
  approvalsCount?: number;
  surface?: ChatMode;
  lockSurface?: boolean;
  workTrust?: WorkTrustDescriptor;
  onWorkTrustSummaryChange?: (summary: string | null) => void;
  onOpenCowork?: () => void;
  onOpenCode?: () => void;
  onOpenTasks?: () => void;
  onOpenApprovals?: () => void;
  onNavigateSurface?: (
    surface: ChatMode,
    options?: { sessionId?: string | null; turnId?: string | null; artifactId?: string | null },
  ) => void;
}) {
  type PendingAttachmentDocumentMode = "message" | ThreadKnowledgeRetrievalMode;
  const [selectedProjectId, setSelectedProjectId] = useState<string>("all");
  const [selectedFolderId, setSelectedFolderId] = useState<string>("all");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [historyView, setHistoryView] = useState<"active" | "archived">("active");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [folderName, setFolderName] = useState("");
  const [tagsValue, setTagsValue] = useState("");
  const [streamEnabled, setStreamEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const raw = window.localStorage.getItem(STREAM_PREF_KEY);
    return raw === null ? true : raw === "true";
  });
  const [renameTitle, setRenameTitle] = useState("");
  const [isDragActive, setIsDragActive] = useState(false);
  const [followThreadOutput, setFollowThreadOutput] = useState(true);
  const [localNotices, setLocalNotices] = useState<ChatThreadNotice[]>([]);
  const [activeGeneratedArtifact, setActiveGeneratedArtifact] = useState<ChatGeneratedArtifactRecord | null>(null);
  const [sessionRailOpen, setSessionRailOpen] = useState(false);
  const [pendingAttachmentModes, setPendingAttachmentModes] = useState<Record<string, PendingAttachmentDocumentMode>>(
    {},
  );
  const [knowledgeUrlDraft, setKnowledgeUrlDraft] = useState("");
  const [knowledgeUrlMode, setKnowledgeUrlMode] = useState<ThreadKnowledgeRetrievalMode>("retrieval");
  const [presetApplyWarning, setPresetApplyWarning] = useState<string | null>(null);
  const [presetProfiles, setPresetProfiles] = useState<
    Array<{
      agentId: string;
      label: string;
      summary?: string;
      routeHint?: ChatMode;
      preferredProviderId?: string;
      preferredModel?: string;
      toolsPosture?: "safe_auto" | "manual";
      knowledgeAttachmentIds?: string[];
      promptFraming?: string;
    }>
  >([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [workbenchDiscardConfirm, setWorkbenchDiscardConfirm] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const lastLocalPrefMutationAtRef = useRef(0);
  const prefMutationSequenceRef = useRef(0);
  const lastShellSurfaceSyncKeyRef = useRef<string | null>(null);
  const lastPublishedWorkTrustSummaryRef = useRef<string | null>(null);
  const lastCapabilitySuggestionSyncKeyRef = useRef<string | null>(null);
  const lastSpecialistSuggestionSyncKeyRef = useRef<string | null>(null);
  const executeOutboundItemRef = useRef<(item: OutboundQueueItem) => Promise<void>>(async () => undefined);
  const tryBeginOutboundExecutionRef = useRef<() => boolean>(() => false);
  const queuedOutboundSetterRef = useRef<React.Dispatch<React.SetStateAction<OutboundQueueItem[]>>>(() => []);
  const pushLocalNoticeRef = useRef<(message: string, tone?: ChatThreadNotice["tone"]) => void>(() => undefined);
  const applyFetchedThreadRef = useRef<(thread: ChatThreadResponse, requestVersion: number | null) => boolean>(
    () => false,
  );
  const messageMutationVersionRef = useRef(0);
  const loadSessionCoreStateRef = useRef<
    (sessionId: string, options?: { background?: boolean; includeThread?: boolean }) => Promise<void>
  >(async () => undefined);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);
  const routeSearch = typeof window === "undefined" ? "" : window.location.search;
  const deferredSearch = useDeferredValue(search.trim());
  const compactSurfaceLayout = useMediaQuery("(max-width: 840px)");

  const {
    config: runtimeLlmConfig,
    providers: runtimeProviderCatalog,
    getCachedModels,
    loadModelsForProvider,
  } = useProviderModelCatalog("chat");
  const eventStreamStatus = useEventStreamStatus();
  const pushLocalNotice = useCallback((content: string, tone: ChatThreadNotice["tone"] = "neutral") => {
    setLocalNotices((current) =>
      [
        {
          id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          content,
          tone,
          timestamp: new Date().toISOString(),
        },
        ...current,
      ].slice(0, 12),
    );
  }, []);

  useEffect(() => {
    pushLocalNoticeRef.current = pushLocalNotice;
  }, [pushLocalNotice]);

  useEffect(() => {
    let cancelled = false;
    void fetchAgents("active", 500)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setPresetProfiles(
          response.items
            .filter((item) => item.presetDefaults?.presetLabel)
            .map((item) => ({
              agentId: item.agentId,
              label: item.presetDefaults?.presetLabel ?? item.name,
              summary: item.presetDefaults?.presetSummary,
              routeHint: item.presetDefaults?.routeHint,
              preferredProviderId: item.presetDefaults?.preferredProviderId,
              preferredModel: item.presetDefaults?.preferredModel,
              toolsPosture: item.presetDefaults?.toolsPosture,
              knowledgeAttachmentIds: item.presetDefaults?.knowledgeAttachmentIds,
              promptFraming: item.presetDefaults?.promptFraming,
            })),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setPresetProfiles([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sessionData = useChatSessionData({
    workspaceId,
    historyView,
    searchQuery: deferredSearch,
    selectedSessionId,
    setSelectedSessionId,
    runtimeLlmConfig,
    setError,
    applyFetchedThreadRef,
    messageMutationVersionRef,
    lastLocalPrefMutationAtRef,
  });
  const {
    projects,
    sessions,
    thread,
    setThread,
    prefs,
    setPrefs,
    binding,
    setBinding,
    generatedArtifacts,
    setGeneratedArtifacts,
    threadKnowledgeAttachments,
    setThreadKnowledgeAttachments,
    settings,
    commandCatalog,
    proactiveStatus,
    setProactiveStatus,
    proactiveRuns,
    setProactiveRuns,
    learnedMemory,
    setLearnedMemory,
    specialistCandidates,
    setSpecialistCandidates,
    installedSkills,
    setInstalledSkills,
    mcpServers,
    setMcpServers,
    mcpTemplates,
    setMcpTemplates,
    loading,
    isRefreshing,
    messagesLoading,
    secondaryLoading,
    loadSidebar,
    loadSessionCoreState,
  } = sessionData;
  const currentSessionMode: ChatMode = lockSurface && surface ? surface : (prefs?.mode ?? "chat");
  const threadController = useChatThreadController({
    routeSearch,
    sessions: sessions?.items,
    projects: projects?.items,
    thread,
    selectedProjectId,
    setSelectedProjectId,
    selectedFolderId,
    setSelectedFolderId,
    selectedTag,
    setSelectedTag,
    historyView,
    setHistoryView,
    selectedSessionId,
    setSelectedSessionId,
    selectedTurnId,
    setSelectedTurnId,
    search,
    setSearch,
    followThreadOutput,
    setFollowThreadOutput,
    applyFetchedThreadRef,
    messageMutationVersionRef,
  });
  const {
    selectedSession,
    selectedProject,
    messages,
    missionSessions,
    externalSessions,
    workspaceMissionSessionCount,
    boundMissionSessionCount,
    visibleSessionLabelById,
    availableFolders,
  } = threadController;
  const routeArtifactId = useMemo(
    () => new URLSearchParams(routeSearch).get("artifactId")?.trim() || null,
    [routeSearch],
  );

  useEffect(() => {
    loadSessionCoreStateRef.current = loadSessionCoreState;
  }, [loadSessionCoreState]);

  const sessionControls = useChatSessionControls({
    workspaceId,
    historyView,
    sessionMode: currentSessionMode,
    selectedProjectId,
    selectedSession,
    renameTitle,
    folderName,
    tagsValue,
    setSelectedProjectId,
    setSelectedSessionId,
    setHistoryView,
    setError,
    setSending,
    setQueuedOutbound: (value) => queuedOutboundSetterRef.current(value),
    setThread,
    loadSidebar,
    setBinding,
  });
  const {
    creatingSessionMode,
    projectName,
    setProjectName,
    projectPath,
    setProjectPath,
    showProjectCreate,
    setShowProjectCreate,
    sessionControlPending,
    sessionDeleteConfirm,
    setSessionDeleteConfirm,
    archiveWorkspacePending,
    archiveWorkspaceConfirmOpen,
    setArchiveWorkspaceConfirmOpen,
    integrationConnectionId,
    setIntegrationConnectionId,
    integrationTarget,
    setIntegrationTarget,
    handleCreateSession,
    ensureSession,
    handleCreateProject,
    handleArchiveWorkspaceMissionChats,
    handleRenameSession,
    handleSaveOrganization,
    handleTogglePinSession,
    handleToggleArchiveSession,
    handleDeleteSession,
    confirmDeleteSession,
    handleAssignProject,
    handleSaveExternalBinding,
  } = sessionControls;

  const {
    queuedOutbound,
    setQueuedOutbound,
    editingTurnId,
    setEditingTurnId,
    handleSend,
    handleRetryTurn,
    handleStopActiveTurn,
    handleBeginEditTurn,
    handleResumeQueue,
    handleRemoveQueuedItem,
  } = useChatSurfaceOrchestration({
    draft,
    pendingAttachments,
    selectedSessionId,
    thread,
    sending,
    composerRef,
    activeStreamRef,
    tryBeginOutboundExecutionRef,
    executeOutboundItemRef,
    pushLocalNoticeRef,
    setDraft,
    setPendingAttachments,
    setPendingApproval: () => undefined,
    setError,
    loadSessionCoreStateRef,
    abortActiveChatStream,
  });

  useEffect(() => {
    queuedOutboundSetterRef.current = setQueuedOutbound;
  }, [setQueuedOutbound]);
  const {
    commandIndex,
    setCommandIndex,
    commandSuggestions,
    selectedProviderId,
    selectedModel,
    selectedProviderLabel,
    selectedModelLabel,
    requestedProviderLabel,
    requestedModelLabel,
    selectionSourceLabel,
    runtimeSummary,
    runtimeTone,
    providerOptions,
  } = useChatProviderRoutingController({
    runtimeLlmConfig,
    runtimeProviderCatalog,
    getCachedModels,
    loadModelsForProvider,
    prefs,
    settings,
    draft,
    commandCatalog,
    installedSkills,
    mcpServers,
    mcpTemplates,
  });
  const routePreflight = useChatRoutePreflight({
    sessionId: selectedSessionId,
    prefs,
    displayAction: editingTurnId ? "edit" : "send",
    displayTurnId: editingTurnId,
    enabled: Boolean(selectedSessionId),
  });
  const [acknowledgedRoutePreflightHashes, setAcknowledgedRoutePreflightHashes] = useState<Record<string, true>>({});
  const currentRoutePreflight = routePreflight.result;
  const currentRoutePreflightHash = routePreflight.resultHash;
  const currentRouteBoundaryAcknowledged = Boolean(
    currentRoutePreflightHash && acknowledgedRoutePreflightHashes[currentRoutePreflightHash],
  );
  const acknowledgeCurrentRouteBoundary = useCallback(() => {
    if (!currentRoutePreflightHash) {
      return;
    }
    setAcknowledgedRoutePreflightHashes((current) => ({
      ...current,
      [currentRoutePreflightHash]: true,
    }));
  }, [currentRoutePreflightHash]);

  useEffect(() => {
    if (!lockSurface) {
      if (lastPublishedWorkTrustSummaryRef.current !== null) {
        lastPublishedWorkTrustSummaryRef.current = null;
        onWorkTrustSummaryChange?.(null);
      }
      return;
    }
    const nextSummary = formatWorkProviderModelSummary(selectedProviderLabel, selectedModelLabel);
    if (lastPublishedWorkTrustSummaryRef.current === nextSummary) {
      return;
    }
    lastPublishedWorkTrustSummaryRef.current = nextSummary;
    onWorkTrustSummaryChange?.(nextSummary);
  }, [lockSurface, onWorkTrustSummaryChange, selectedModelLabel, selectedProviderLabel]);

  useEffect(
    () => () => {
      if (lastPublishedWorkTrustSummaryRef.current !== null) {
        lastPublishedWorkTrustSummaryRef.current = null;
        onWorkTrustSummaryChange?.(null);
      }
    },
    [onWorkTrustSummaryChange],
  );

  const handleCommandExecution = useCallback(
    async (sessionId: string, commandText: string) => {
      const result = await parseChatCommand(sessionId, commandText);
      if (result.prefs) setPrefs(result.prefs);
      pushLocalNotice(formatCommandResult(result), result.ok ? "success" : "warning");
      if (result.command === "/project" || result.command === "/new") {
        await loadSidebar();
      }
      if (result.command === "/plan" && result.prefs) {
        setPrefs(result.prefs);
      }
      if (result.session) {
        setSelectedSessionId(result.session.sessionId);
      }
      if (result.command === "/skill" || result.command === "/skills") {
        setInstalledSkills(await fetchSkills().then((payload) => payload.items));
      }
      if (result.command === "/mcp") {
        const [servers, templates] = await Promise.all([fetchMcpServers(), fetchMcpTemplates()]);
        setMcpServers(servers.items);
        setMcpTemplates(templates.items);
      }
    },
    [loadSidebar, pushLocalNotice, setInstalledSkills, setMcpServers, setMcpTemplates, setPrefs],
  );

  const contextActions = useChatContextActions({
    selectedSessionId,
    selectedSession,
    selectedTurnId,
    thread,
    draft,
    messages,
    prefs,
    sending,
    streamEnabled,
    codeModeNeedsProjectBinding: Boolean(selectedSession && prefs?.mode === "code" && !selectedSession.projectId),
    loadSidebar,
    ensureSession,
    setError,
    setSending,
    setPrefs,
    setProactiveStatus,
    setProactiveRuns,
    learnedMemory,
    setLearnedMemory,
    specialistCandidates,
    setSpecialistCandidates,
    setInstalledSkills,
    setMcpServers,
    setMcpTemplates,
    pushLocalNotice,
    lastLocalPrefMutationAtRef,
    executeOutboundItemRef,
    tryBeginOutboundExecutionRef,
    setQueuedOutbound,
  });
  const {
    capabilitySuggestions,
    setCapabilitySuggestions,
    specialistSuggestions,
    setSpecialistSuggestions,
    activeDelegationRun,
    delegationSuggestion,
    setDelegationSuggestion,
    capabilitySuggestionConfirm,
    setCapabilitySuggestionConfirm,
    capabilitySuggestionPending,
    capabilityConfirmationCopy,
    handleRunQuickResearch,
    handleProactivePolicyPatch,
    handleTriggerProactive,
    handleSuggestDelegation,
    handleAcceptDelegation,
    handleRunCodeDelegation,
    handleMemoryStatusUpdate,
    handleRebuildLearnedMemory,
    handleCreateSpecialistDraft,
    handleActivateCatalogSpecialist,
    handleSpecialistCandidatePatch,
    handleCapabilitySuggestionAction,
    confirmCapabilitySuggestionAction,
  } = contextActions;

  const outbound = useChatOutboundExecution({
    selectedSessionId,
    selectedSession,
    streamEnabled,
    sending,
    error,
    queuedOutbound,
    activeStreamRef,
    prefs,
    thread,
    messages,
    setThread,
    setError,
    setSending,
    setDraft,
    setPendingAttachments,
    setEditingTurnId,
    setCapabilitySuggestions,
    setSpecialistSuggestions,
    loadSidebar,
    loadSessionCoreState,
    ensureSession,
    pushLocalNotice,
    handleCommandExecution,
    executeOutboundItemRef,
    tryBeginOutboundExecutionRef,
    applyFetchedThreadRef,
    messageMutationVersionRef,
    ensureFreshRoutePreflight: (next) => routePreflight.ensureFreshPreflight(next),
    isRoutePreflightAcknowledged: (hash) => Boolean(acknowledgedRoutePreflightHashes[hash]),
  });
  const {
    pendingApproval,
    setPendingApproval,
    pendingUserInput,
    setPendingUserInput,
    approvalPending,
    userInputPending,
    handleApprovePending,
    handleDenyPending,
    handleSubmitUserInput,
    handleSelectBranchTurn,
    streamStatus,
    prefsRef,
  } = outbound;

  useChatApprovalController({
    selectedSessionId,
    activeStreamRef,
    setPendingAttachments,
    setEditingTurnId,
    setPendingApproval,
    setPendingUserInput,
    setDelegationSuggestion,
    setCapabilitySuggestions,
    setSpecialistSuggestions,
    setSelectedTurnId,
    setLocalNotices,
    pushLocalNotice,
  });

  useEffect(() => {
    setDevDiagnosticsActiveChatSession(selectedSessionId ?? undefined);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!thread) {
      setDevDiagnosticsLatestTraceSummary(undefined);
      return;
    }
    const selectedTurn = thread.turns.find(
      (turn) => turn.turnId === (thread.selectedTurnId ?? thread.activeLeafTurnId),
    );
    setDevDiagnosticsLatestTraceSummary(
      selectedTurn?.trace
        ? {
            sessionId: thread.sessionId,
            turnId: selectedTurn.turnId,
            providerId: selectedTurn.trace.routing.effectiveProviderId ?? selectedTurn.trace.routing.primaryProviderId,
            modelId: selectedTurn.trace.routing.effectiveModel ?? selectedTurn.trace.model,
            state: selectedTurn.trace.status,
          }
        : {
            sessionId: thread.sessionId,
            turnCount: thread.turns.length,
          },
    );
  }, [thread]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const draftRaw = window.localStorage.getItem(createDraftStorageKey(workspaceId, selectedSessionId));
      setDraft(draftRaw ?? "");
      const attachmentsRaw = window.localStorage.getItem(createAttachmentStorageKey(workspaceId, selectedSessionId));
      setPendingAttachments(attachmentsRaw ? (JSON.parse(attachmentsRaw) as ChatAttachmentRecord[]) : []);
      const queueRaw = window.localStorage.getItem(createQueueStorageKey(workspaceId, selectedSessionId));
      setQueuedOutbound(
        queueRaw ? (JSON.parse(queueRaw) as OutboundQueueItem[]).map((item) => ({ ...item, paused: true })) : [],
      );
    } catch {
      setDraft("");
      setPendingAttachments([]);
      setQueuedOutbound([]);
    }
  }, [selectedSessionId, workspaceId, setQueuedOutbound]);

  useEffect(() => {
    setPendingAttachmentModes((current) => {
      const next: Record<string, PendingAttachmentDocumentMode> = {};
      for (const attachment of pendingAttachments) {
        const currentMode = current[attachment.attachmentId];
        if (!isDocumentAttachment(attachment)) {
          continue;
        }
        if (currentMode === "retrieval") {
          next[attachment.attachmentId] = "retrieval";
          continue;
        }
        if (currentMode === "full_text" && canReadAttachmentInFull(attachment)) {
          next[attachment.attachmentId] = "full_text";
          continue;
        }
        next[attachment.attachmentId] = "message";
      }
      return next;
    });
  }, [pendingAttachments]);

  useEffect(() => {
    if (!activeGeneratedArtifact) {
      return;
    }
    const refreshedArtifact = generatedArtifacts?.items.find(
      (item) => item.artifactId === activeGeneratedArtifact.artifactId,
    );
    if (refreshedArtifact) {
      setActiveGeneratedArtifact(refreshedArtifact);
    }
  }, [activeGeneratedArtifact, generatedArtifacts?.items]);

  useDebouncedLocalStoragePersistence(createDraftStorageKey(workspaceId, selectedSessionId), draft);
  useDebouncedLocalStoragePersistence(
    createAttachmentStorageKey(workspaceId, selectedSessionId),
    JSON.stringify(pendingAttachments),
  );
  useDebouncedLocalStoragePersistence(
    createQueueStorageKey(workspaceId, selectedSessionId),
    JSON.stringify(queuedOutbound),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STREAM_PREF_KEY, String(streamEnabled));
  }, [streamEnabled]);

  useEffect(() => {
    setRenameTitle(selectedSession?.title ?? "");
    setFolderName(selectedSession?.folderName ?? "");
    setTagsValue((selectedSession?.tags ?? []).join(", "));
  }, [selectedSession?.folderName, selectedSession?.sessionId, selectedSession?.tags, selectedSession?.title]);
  const planningMode = prefs?.planningMode ?? "off";
  const proactiveSuggestionCount = proactiveRuns.filter((run) => run.status === "suggested").length;

  const {
    messageMode,
    activeModePreset,
    isChatSurface,
    isCoworkSurface,
    isCodeSurface,
    surfaceHeaderTitle,
    surfaceHeaderSubtitle,
    workspaceSummaryCards,
    selectedTurn,
    selectedTurnRecovery,
    effectiveToolAutonomy,
    selectedSessionLabel,
    codeModeNeedsProjectBinding,
    selectedProjectBindingCandidateId,
    selectedProjectBindingCandidateName,
    showTracePanel,
    showSuggestionsPanel,
    showLearnedMemoryPanel,
    dockSectionOrder,
  } = useMissionControlSurfaceState({
    lockSurface,
    surface,
    prefs,
    selectedTurnId,
    thread,
    selectedSession,
    selectedProjectId,
    projects: (projects?.items ?? []).map((item) => ({ projectId: item.projectId, name: item.name })),
    projectsCount: projects?.items.length ?? 0,
    missionSessionCount: missionSessions.length,
    externalSessionCount: externalSessions.length,
    boundMissionSessionCount,
    planningMode,
    chatSubtitle: pageCopy.chat.subtitle ?? "Fast conversation, drafting, and lightweight help.",
    capabilitySuggestionCount: capabilitySuggestions.length,
    specialistSuggestionCount: specialistSuggestions.length,
    specialistCandidateCount: specialistCandidates.filter((item) => item.status !== "retired").length,
    proactiveSuggestionCount,
    hasDelegationSuggestion: Boolean(delegationSuggestion),
    learnedMemoryCount: learnedMemory.length,
    hasGeneratedArtifact: Boolean(activeGeneratedArtifact),
  });

  useEffect(() => {
    const capabilitySuggestions = selectedTurn?.trace.capabilityUpgradeSuggestions ?? [];
    const specialistSuggestions = selectedTurn?.trace.specialistCandidateSuggestions ?? [];
    const capabilitySyncKey = `${selectedTurn?.turnId ?? "none"}:${JSON.stringify(capabilitySuggestions)}`;
    const specialistSyncKey = `${selectedTurn?.turnId ?? "none"}:${JSON.stringify(specialistSuggestions)}`;

    if (lastCapabilitySuggestionSyncKeyRef.current !== capabilitySyncKey) {
      lastCapabilitySuggestionSyncKeyRef.current = capabilitySyncKey;
      setCapabilitySuggestions(capabilitySuggestions);
    }

    if (lastSpecialistSuggestionSyncKeyRef.current !== specialistSyncKey) {
      lastSpecialistSuggestionSyncKeyRef.current = specialistSyncKey;
      setSpecialistSuggestions(specialistSuggestions);
    }
  }, [selectedTurn, setCapabilitySuggestions, setSpecialistSuggestions]);
  const {
    dockOpen,
    setDockOpen,
    activeWorkflowTurn,
    workbenchState,
    workbenchTree,
    selectedWorkbenchFile,
    selectedWorkbenchFileDiff,
    workbenchDraftContent,
    workbenchExpandedPaths,
    workbenchDiff,
    workbenchOutput,
    workbenchLoading,
    workbenchBusy,
    workbenchSaving,
    workbenchError,
    hasDirtyWorkbenchDraft,
    setWorkbenchDraftContent,
    setWorkbenchExpandedPaths,
    refreshWorkbench,
    createWorkbenchWorktree,
    openWorkbenchFile,
    saveWorkbenchFile,
    discardWorkbenchDraft,
    latestOrchestration,
    orchestrationRun,
    orchestrationCheckpoints,
    orchestrationLoading,
    orchestrationError,
    refreshOrchestrationRun,
    coworkItems,
    selectedSessionProjectValue,
    dockSectionStyle,
  } = useChatDockWorkbenchController({
    messageMode,
    selectedSessionId,
    selectedSession,
    selectedTurn,
    thread,
    messages,
    localNotices,
    dockSectionOrder,
  });
  const guardWorkbenchNavigation = useCallback(
    (action: () => void, message: string) => {
      if (!(messageMode === "code" && hasDirtyWorkbenchDraft)) {
        action();
        return;
      }
      setWorkbenchDiscardConfirm({
        title: "Discard unsaved workbench changes?",
        message,
        onConfirm: () => {
          discardWorkbenchDraft();
          action();
        },
      });
    },
    [discardWorkbenchDraft, hasDirtyWorkbenchDraft, messageMode],
  );

  useEffect(() => {
    if (!hasDirtyWorkbenchDraft && workbenchDiscardConfirm) {
      setWorkbenchDiscardConfirm(null);
    }
  }, [hasDirtyWorkbenchDraft, workbenchDiscardConfirm]);

  useEffect(() => {
    if (!compactSurfaceLayout && sessionRailOpen) {
      setSessionRailOpen(false);
    }
  }, [compactSurfaceLayout, sessionRailOpen]);

  useEffect(() => {
    if (compactSurfaceLayout && sessionRailOpen && dockOpen) {
      setDockOpen(false);
    }
  }, [compactSurfaceLayout, dockOpen, sessionRailOpen, setDockOpen]);

  useEffect(() => {
    if (!routeArtifactId) {
      setActiveGeneratedArtifact(null);
      return;
    }
    let cancelled = false;
    void fetchChatGeneratedArtifact(routeArtifactId)
      .then((response) => {
        if (cancelled) {
          return;
        }
        if (selectedSessionId && response.item.sessionId !== selectedSessionId) {
          return;
        }
        if (compactSurfaceLayout) {
          setSessionRailOpen(false);
          setDockOpen(false);
        }
        setActiveGeneratedArtifact(response.item);
        if (response.item.turnId) {
          setSelectedTurnId(response.item.turnId);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setActiveGeneratedArtifact(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [compactSurfaceLayout, routeArtifactId, selectedSessionId, setDockOpen]);

  const providerLabelById = useMemo(
    () => new Map(providerOptions.map((provider) => [provider.providerId, provider.label])),
    [providerOptions],
  );
  const activeRouting = activeWorkflowTurn?.trace.routing;
  const requestedProviderModelSummary = activeRouting
    ? formatRoutingTargetSummary(providerLabelById, activeRouting.primaryProviderId, activeRouting.primaryModel)
    : currentRoutePreflight
      ? formatRoutingTargetSummary(
          providerLabelById,
          currentRoutePreflight.requestedProviderId,
          currentRoutePreflight.requestedModel,
        )
      : formatWorkProviderModelSummary(requestedProviderLabel, requestedModelLabel);
  const effectiveProviderModelSummary = activeRouting
    ? formatRoutingTargetSummary(
        providerLabelById,
        activeRouting.effectiveProviderId ?? activeRouting.primaryProviderId,
        activeRouting.effectiveModel ?? activeWorkflowTurn?.trace.model ?? activeRouting.primaryModel,
      )
    : currentRoutePreflight
      ? formatRoutingTargetSummary(
          providerLabelById,
          currentRoutePreflight.effectiveProviderId ?? currentRoutePreflight.requestedProviderId,
          currentRoutePreflight.effectiveModel ?? currentRoutePreflight.requestedModel,
        )
      : formatWorkProviderModelSummary(selectedProviderLabel, selectedModelLabel);
  const preflightFallback = formatFallbackSummary(currentRoutePreflight);
  const fallbackSummary = activeRouting?.fallbackUsed
    ? activeRouting.fallbackReason
      ? `Fallback used · ${activeRouting.fallbackReason}`
      : "Fallback used"
    : activeRouting?.fallbackProviderId || activeRouting?.fallbackModel || activeRouting?.fallbackReason
      ? activeRouting?.fallbackReason
        ? `Fallback armed · ${activeRouting.fallbackReason}`
        : "Fallback armed"
      : preflightFallback.summary;
  const fallbackTone = activeRouting?.fallbackUsed
    ? "warning"
    : activeRouting?.fallbackProviderId || activeRouting?.fallbackModel || activeRouting?.fallbackReason
      ? "warning"
      : preflightFallback.tone;
  const preflightRuntime = formatRuntimeSummary(currentRoutePreflight);
  const selectionSourceSummary = currentRoutePreflight
    ? formatSelectionSourceSummary(currentRoutePreflight.selectionSource)
    : selectionSourceLabel;
  const coworkViewModel = useMemo(
    () =>
      deriveCoworkRunViewModel({
        items: coworkItems,
        orchestration: latestOrchestration ?? undefined,
        orchestrationRun,
        orchestrationCheckpoints,
        orchestrationLoading,
        orchestrationError,
        executionPlan: activeWorkflowTurn?.trace.executionPlan,
        delegationRun: activeDelegationRun,
        activeTurn: activeWorkflowTurn,
        selectedTurn,
        workbenchState,
      }),
    [
      activeDelegationRun,
      activeWorkflowTurn,
      coworkItems,
      latestOrchestration,
      orchestrationCheckpoints,
      orchestrationError,
      orchestrationLoading,
      orchestrationRun,
      selectedTurn,
      workbenchState,
    ],
  );
  const sessionTrust = useMemo<WorkTrustDescriptor>(
    () =>
      workTrust ?? {
        workspaceLabel: workspaceName,
        gatewayTone: "muted",
        gatewayLabel: "Gateway state unavailable",
        approvalsSummary: approvalsCount > 0 ? `${approvalsCount} decisions` : "Decisions clear",
        runStateSummary: activeWorkflowTurn ? `Run: ${activeWorkflowTurn.trace.status}` : undefined,
        activeModeLabel: activeModePreset.label,
        providerModelSummary: effectiveProviderModelSummary,
        requestedProviderModelSummary,
        effectiveProviderModelSummary,
        selectionSourceSummary,
        fallbackSummary,
        fallbackTone,
        runtimeSummary: currentRoutePreflight ? preflightRuntime.summary : runtimeSummary,
        runtimeTone: currentRoutePreflight ? preflightRuntime.tone : runtimeTone,
      },
    [
      activeModePreset.label,
      activeWorkflowTurn,
      approvalsCount,
      currentRoutePreflight,
      effectiveProviderModelSummary,
      fallbackSummary,
      fallbackTone,
      preflightRuntime.summary,
      preflightRuntime.tone,
      requestedProviderModelSummary,
      runtimeSummary,
      runtimeTone,
      selectionSourceSummary,
      workTrust,
      workspaceName,
    ],
  );
  const coworkRouteBlocked = messageMode === "cowork" ? currentRoutePreflight?.blockedReason : undefined;
  const coworkRouteBoundaryAckRequired =
    messageMode === "cowork" && requiresBoundaryAcknowledgment(currentRoutePreflight);
  const canSend =
    Boolean(resolveOutboundDraftContent(draft, pendingAttachments.length, editingTurnId ? "edit" : "send")) &&
    !sending &&
    !pendingApproval &&
    !pendingUserInput &&
    !coworkRouteBlocked &&
    (!coworkRouteBoundaryAckRequired || currentRouteBoundaryAcknowledged);

  const handleSelectSessionFromRail = useCallback(
    (sessionId: string, options?: { turnId?: string | null }) => {
      if (sessionId === selectedSessionId) {
        setSelectedTurnId(options?.turnId ?? null);
        setActiveGeneratedArtifact(null);
        setSessionRailOpen(false);
        return;
      }
      guardWorkbenchNavigation(() => {
        setSelectedSessionId(sessionId);
        setSelectedTurnId(options?.turnId ?? null);
        setActiveGeneratedArtifact(null);
        setSessionRailOpen(false);
      }, "Switching sessions will discard the unsaved editor changes in the current Code workbench file.");
    },
    [guardWorkbenchNavigation, selectedSessionId, setSelectedSessionId, setSelectedTurnId],
  );
  const handleSessionRailOpenChange = useCallback(
    (next: boolean) => {
      setSessionRailOpen(next);
      if (next && compactSurfaceLayout) {
        setDockOpen(false);
        setActiveGeneratedArtifact(null);
      }
    },
    [compactSurfaceLayout, setDockOpen],
  );
  const handleDockOpenChange = useCallback(
    (next: boolean) => {
      setDockOpen(next);
      if (next && compactSurfaceLayout) {
        setSessionRailOpen(false);
        setActiveGeneratedArtifact(null);
      }
    },
    [compactSurfaceLayout, setDockOpen],
  );
  const handleNavigateSurface = useCallback(
    (
      nextSurface: ChatMode,
      options?: { sessionId?: string | null; turnId?: string | null; artifactId?: string | null },
    ) => {
      const nextArtifactId =
        options && Object.prototype.hasOwnProperty.call(options, "artifactId")
          ? (options.artifactId ?? undefined)
          : (activeGeneratedArtifact?.artifactId ?? undefined);
      const nextSessionId = options?.sessionId ?? selectedSessionId;
      const runNavigation = () =>
        onNavigateSurface?.(nextSurface, {
          sessionId: nextSessionId,
          turnId: options?.turnId ?? selectedTurnId,
          artifactId: nextArtifactId,
        });

      if (
        messageMode === "code" &&
        hasDirtyWorkbenchDraft &&
        (nextSurface !== messageMode || nextSessionId !== selectedSessionId)
      ) {
        setWorkbenchDiscardConfirm({
          title: "Discard unsaved workbench changes?",
          message: "Switching surfaces will discard the unsaved editor changes in the current Code workbench file.",
          onConfirm: () => {
            discardWorkbenchDraft();
            runNavigation();
          },
        });
        return;
      }

      runNavigation();
    },
    [
      activeGeneratedArtifact?.artifactId,
      discardWorkbenchDraft,
      hasDirtyWorkbenchDraft,
      messageMode,
      onNavigateSurface,
      selectedSessionId,
      selectedTurnId,
    ],
  );

  const handleCloseGeneratedArtifact = useCallback(() => {
    setActiveGeneratedArtifact(null);
    handleNavigateSurface(messageMode, {
      sessionId: selectedSessionId,
      turnId: selectedTurnId,
      artifactId: null,
    });
  }, [handleNavigateSurface, messageMode, selectedSessionId, selectedTurnId]);

  const revealGeneratedArtifact = useCallback(
    async (artifact: ChatGeneratedArtifactRecord) => {
      if (compactSurfaceLayout) {
        setSessionRailOpen(false);
        setDockOpen(false);
      }
      setActiveGeneratedArtifact(artifact);
      setSelectedTurnId(artifact.turnId);
      await loadSessionCoreState(artifact.sessionId, {
        background: true,
        includeThread: true,
      });
      setGeneratedArtifacts((current) =>
        current
          ? {
              ...current,
              items: [artifact, ...current.items.filter((item) => item.artifactId !== artifact.artifactId)],
            }
          : current,
      );
      handleNavigateSurface(messageMode, {
        sessionId: artifact.sessionId,
        turnId: artifact.turnId,
        artifactId: artifact.artifactId,
      });
    },
    [
      compactSurfaceLayout,
      handleNavigateSurface,
      loadSessionCoreState,
      messageMode,
      setDockOpen,
      setGeneratedArtifacts,
    ],
  );

  const handleOpenGeneratedArtifactFromTurn = useCallback(
    async (turnId: string) => {
      try {
        if (!selectedSessionId) {
          return;
        }
        const targetTurn = thread?.turns.find((turn) => turn.turnId === turnId) ?? null;
        const existingArtifactId = targetTurn?.generatedArtifacts?.[0]?.artifactId;
        if (!existingArtifactId) {
          pushLocalNotice("Create an artifact from this turn before opening it.", "warning");
          return;
        }
        const artifact = (await fetchChatGeneratedArtifact(existingArtifactId)).item;
        await revealGeneratedArtifact(artifact);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [pushLocalNotice, revealGeneratedArtifact, selectedSessionId, setError, thread?.turns],
  );

  const handleCreateGeneratedArtifactFromTurn = useCallback(
    async (turnId: string, options?: { supersedeLatest?: boolean }) => {
      try {
        if (!selectedSessionId) {
          return;
        }
        const artifact = (
          await createChatGeneratedArtifact(selectedSessionId, turnId, {
            supersedeLatest: options?.supersedeLatest ?? false,
          })
        ).item;
        await revealGeneratedArtifact(artifact);
        pushLocalNotice(
          options?.supersedeLatest ? "Saved a new generated artifact version." : "Created a generated artifact.",
          "success",
        );
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [pushLocalNotice, revealGeneratedArtifact, selectedSessionId, setError],
  );

  const handleRemoveThreadKnowledge = useCallback(
    async (attachmentId: string) => {
      if (!selectedSessionId) {
        return;
      }
      await removeThreadKnowledgeAttachment(selectedSessionId, attachmentId);
      await loadSessionCoreState(selectedSessionId, {
        background: true,
        includeThread: false,
      });
      setThreadKnowledgeAttachments((current) =>
        current
          ? {
              items: current.items.filter((item) => item.attachmentId !== attachmentId),
            }
          : current,
      );
      pushLocalNotice("Removed thread knowledge attachment.", "success");
    },
    [loadSessionCoreState, pushLocalNotice, selectedSessionId, setThreadKnowledgeAttachments],
  );

  const handleExportSessionSnapshot = useCallback(() => {
    if (typeof window === "undefined" || !selectedSession) {
      return;
    }
    const snapshot = {
      exportedAt: new Date().toISOString(),
      session: selectedSession,
      mode: messageMode,
      prefs,
      binding,
      thread,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(selectedSession.title?.trim() || selectedSession.sessionId).replace(/[^a-z0-9_-]+/gi, "-")}-snapshot.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    pushLocalNotice("Session snapshot exported locally.", "success");
  }, [binding, messageMode, prefs, pushLocalNotice, selectedSession, thread]);

  const handleRunCodeHelper = useCallback(
    async (language: string, source: string) => {
      if (!selectedSessionId) {
        return;
      }
      const normalizedLanguage = language.toLowerCase();
      if (
        normalizedLanguage !== "ts" &&
        normalizedLanguage !== "tsx" &&
        normalizedLanguage !== "typescript" &&
        normalizedLanguage !== "js" &&
        normalizedLanguage !== "jsx" &&
        normalizedLanguage !== "javascript"
      ) {
        pushLocalNotice("Code helper currently supports JavaScript and TypeScript snippets.", "warning");
        return;
      }
      try {
        await createCodeModeRun({
          language: normalizedLanguage.startsWith("ts") ? "typescript" : "javascript",
          source,
          sessionId: selectedSessionId,
          turnId: selectedTurn?.turnId,
          requestedOutputIntent: "workbench_helper",
        });
        pushLocalNotice("Queued a code helper run for this snippet.", "success");
        await refreshWorkbench();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to start code helper run.");
      }
    },
    [pushLocalNotice, refreshWorkbench, selectedSessionId, selectedTurn?.turnId],
  );

  useEffect(() => {
    if (!lockSurface || !surface || !selectedSessionId) {
      lastShellSurfaceSyncKeyRef.current = null;
      return;
    }
    if (prefs?.mode === surface) {
      lastShellSurfaceSyncKeyRef.current = `${selectedSessionId}:${surface}`;
      return;
    }
    const syncKey = `${selectedSessionId}:${surface}`;
    if (lastShellSurfaceSyncKeyRef.current === syncKey) {
      return;
    }
    lastShellSurfaceSyncKeyRef.current = syncKey;
    lastLocalPrefMutationAtRef.current = Date.now();
    void updateChatSessionPrefs(selectedSessionId, { mode: surface })
      .then((updated) => {
        setPrefs(updated);
        setError(null);
      })
      .catch((err) => {
        lastShellSurfaceSyncKeyRef.current = null;
        setError((err as Error).message);
      });
  }, [lockSurface, prefs?.mode, selectedSessionId, setPrefs, surface]);

  const applyPrefPatchToSession = useCallback(
    async (
      sessionId: string,
      patch: ChatSessionPrefsPatch,
      options?: {
        syncLocalState?: boolean;
      },
    ) => {
      lastLocalPrefMutationAtRef.current = Date.now();
      const previousPrefs = prefsRef.current;
      const shouldSyncLocalState =
        options?.syncLocalState ?? (!selectedSession || selectedSession.sessionId === sessionId);
      const optimisticPrefs =
        shouldSyncLocalState && previousPrefs ? resolveOptimisticChatPrefs(previousPrefs, patch) : null;
      const mutationId = prefMutationSequenceRef.current + 1;
      prefMutationSequenceRef.current = mutationId;
      if (optimisticPrefs) {
        prefsRef.current = optimisticPrefs;
        setPrefs(optimisticPrefs);
      }
      try {
        const updated = await updateChatSessionPrefs(sessionId, patch);
        if (prefMutationSequenceRef.current !== mutationId) {
          return updated;
        }
        if (shouldSyncLocalState) {
          prefsRef.current = updated;
          setPrefs(updated);
        }
        return updated;
      } catch (err) {
        if (prefMutationSequenceRef.current === mutationId && previousPrefs) {
          prefsRef.current = previousPrefs;
          setPrefs(previousPrefs);
        }
        setError((err as Error).message);
        throw err;
      }
    },
    [prefsRef, selectedSession, setPrefs],
  );
  const handlePrefPatch = useCallback(
    async (patch: ChatSessionPrefsPatch) => {
      if (!selectedSession) return;
      try {
        await applyPrefPatchToSession(selectedSession.sessionId, patch);
      } catch {
        // Errors are already surfaced in local state for dock/composer callers.
      }
    },
    [applyPrefPatchToSession, selectedSession],
  );
  const handleSetPendingAttachmentMode = useCallback((attachmentId: string, mode: PendingAttachmentDocumentMode) => {
    setPendingAttachmentModes((current) => ({
      ...current,
      [attachmentId]: mode,
    }));
  }, []);
  const attachPendingKnowledgeSources = useCallback(async () => {
    const normalizedKnowledgeUrl = knowledgeUrlDraft.trim();
    const requiresThreadKnowledge =
      pendingAttachments.some((attachment) => {
        const mode = pendingAttachmentModes[attachment.attachmentId] ?? "message";
        return isDocumentAttachment(attachment) && mode !== "message";
      }) || normalizedKnowledgeUrl.length > 0;
    if (!requiresThreadKnowledge) {
      return;
    }
    const session = await ensureSession();
    const existingKeys = new Set(
      (threadKnowledgeAttachments?.items ?? []).map((item) =>
        item.chatAttachmentId
          ? `${item.chatAttachmentId}:${item.retrievalMode}`
          : `url:${item.sourceRef.trim().toLowerCase()}:${item.retrievalMode}`,
      ),
    );
    const nextItems: ThreadKnowledgeAttachmentRecord[] = [...(threadKnowledgeAttachments?.items ?? [])];

    for (const attachment of pendingAttachments) {
      if (!isDocumentAttachment(attachment)) {
        continue;
      }
      const mode = pendingAttachmentModes[attachment.attachmentId] ?? "message";
      if (mode === "message") {
        continue;
      }
      if (mode === "full_text" && !canReadAttachmentInFull(attachment)) {
        throw new Error(`${attachment.fileName} is not ready for full-text context yet. Use retrieval instead.`);
      }
      const key = `${attachment.attachmentId}:${mode}`;
      if (existingKeys.has(key)) {
        continue;
      }
      const response = await attachThreadKnowledgeAttachment(session.sessionId, {
        chatAttachmentId: attachment.attachmentId,
        title: attachment.fileName,
        retrievalMode: mode,
      });
      existingKeys.add(key);
      nextItems.unshift(response.item);
    }

    if (normalizedKnowledgeUrl) {
      const urlKey = `url:${normalizedKnowledgeUrl.toLowerCase()}:${knowledgeUrlMode}`;
      if (!existingKeys.has(urlKey)) {
        const response = await attachThreadKnowledgeAttachment(session.sessionId, {
          url: normalizedKnowledgeUrl,
          title: normalizedKnowledgeUrl,
          retrievalMode: knowledgeUrlMode,
        });
        nextItems.unshift(response.item);
      }
      setKnowledgeUrlDraft("");
    }

    setThreadKnowledgeAttachments({ items: nextItems });
  }, [
    ensureSession,
    knowledgeUrlDraft,
    knowledgeUrlMode,
    pendingAttachmentModes,
    pendingAttachments,
    setThreadKnowledgeAttachments,
    threadKnowledgeAttachments?.items,
  ]);
  const handleSendWithKnowledge = useCallback(async () => {
    try {
      await attachPendingKnowledgeSources();
      await handleSend();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to prepare thread knowledge.");
    }
  }, [attachPendingKnowledgeSources, handleSend, setError]);
  const handleAttachKnowledgeUrl = useCallback(async () => {
    const normalizedKnowledgeUrl = knowledgeUrlDraft.trim();
    if (!normalizedKnowledgeUrl) {
      return;
    }
    try {
      const session = await ensureSession();
      const response = await attachThreadKnowledgeAttachment(session.sessionId, {
        url: normalizedKnowledgeUrl,
        title: normalizedKnowledgeUrl,
        retrievalMode: knowledgeUrlMode,
      });
      setThreadKnowledgeAttachments((current) => ({
        items: [response.item, ...(current?.items ?? [])],
      }));
      setKnowledgeUrlDraft("");
      pushLocalNotice("Attached a thread knowledge source.", "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to attach thread knowledge source.");
    }
  }, [ensureSession, knowledgeUrlDraft, knowledgeUrlMode, pushLocalNotice, setError, setThreadKnowledgeAttachments]);
  const handleApplyPreset = useCallback(async () => {
    try {
      const preset = presetProfiles.find((item) => item.agentId === selectedPresetId);
      if (!preset) {
        return;
      }
      const session = await ensureSession();
      const patch: ChatSessionPrefsPatch = {
        providerId: preset.preferredProviderId,
        model: preset.preferredModel,
        toolAutonomy: preset.toolsPosture,
      };
      const hasPatch = Object.values(patch).some((value) => value !== undefined);
      if (hasPatch) {
        await applyPrefPatchToSession(session.sessionId, patch, {
          syncLocalState: true,
        });
      }
      if (preset.promptFraming) {
        setDraft((current) =>
          current.trim() ? `${preset.promptFraming}\n\n${current.trim()}` : (preset.promptFraming ?? ""),
        );
      }
      const missingKnowledgeAttachmentIds = (preset.knowledgeAttachmentIds ?? []).filter(
        (attachmentId) => !(threadKnowledgeAttachments?.items ?? []).some((item) => item.attachmentId === attachmentId),
      );
      if (missingKnowledgeAttachmentIds.length > 0) {
        const warning =
          missingKnowledgeAttachmentIds.length === 1
            ? `Skipped 1 unavailable knowledge default.`
            : `Skipped ${missingKnowledgeAttachmentIds.length} unavailable knowledge defaults.`;
        setPresetApplyWarning(warning);
        pushLocalNotice(warning, "warning");
      } else {
        setPresetApplyWarning(null);
      }
      if (preset.routeHint && preset.routeHint !== messageMode) {
        handleNavigateSurface(preset.routeHint);
      }
      pushLocalNotice(`Applied ${preset.label}.`, "success");
    } catch (err) {
      setError((err as Error).message);
    }
  }, [
    applyPrefPatchToSession,
    ensureSession,
    handleNavigateSurface,
    messageMode,
    presetProfiles,
    pushLocalNotice,
    setError,
    setPresetApplyWarning,
    selectedPresetId,
    threadKnowledgeAttachments?.items,
  ]);

  const handleRevealSelectedTurnDetails = useCallback(() => {
    if (!selectedTurn) {
      return;
    }
    setSelectedTurnId(selectedTurn.turnId);
    handleDockOpenChange(true);
  }, [handleDockOpenChange, selectedTurn]);
  const handleRevealActiveTurnDetails = useCallback(() => {
    const nextTurn = activeWorkflowTurn ?? selectedTurn;
    if (!nextTurn) {
      return;
    }
    setSelectedTurnId(nextTurn.turnId);
    handleDockOpenChange(true);
  }, [activeWorkflowTurn, handleDockOpenChange, selectedTurn]);

  const handleSelectBranchTurnAndSync = useCallback(
    async (turnId: string) => {
      const nextThread = await handleSelectBranchTurn(turnId);
      if (nextThread) {
        setSelectedTurnId(nextThread.activeLeafTurnId ?? turnId);
      }
    },
    [handleSelectBranchTurn],
  );
  const {
    uploadAttachments,
    handleComposerKeyDown,
    handleComposerPaste,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDismissError,
    handleCancelEdit,
    handleCreateCurrentModeSession,
    handleArchiveWorkspace,
    handleConfirmCapabilitySuggestion,
    handleConfirmDeleteSession,
    handleConfirmArchiveWorkspace,
    handleSetDeepMode,
    handleApplyDraftCommand,
    handleRemoveAttachment,
    handleUploadFiles,
  } = useChatComposerInteractions({
    draft,
    commandSuggestions,
    commandIndex,
    sending,
    selectedSession,
    messageMode,
    ensureSession,
    handleSend,
    handleCreateSession,
    handleArchiveWorkspaceMissionChats,
    handleRunQuickResearch,
    handlePrefPatch,
    handleRevealSelectedTurnDetails,
    confirmCapabilitySuggestionAction,
    confirmDeleteSession,
    setSending,
    setError,
    setDraft,
    setCommandIndex,
    setPendingAttachments,
    setIsDragActive,
    setEditingTurnId,
    setDockOpen,
    setArchiveWorkspaceConfirmOpen,
  });
  const handleToggleDock = useCallback(() => {
    handleDockOpenChange(!dockOpen);
  }, [dockOpen, handleDockOpenChange]);
  const latestAssistantTurn = useMemo(
    () => [...(thread?.turns ?? [])].reverse().find((turn) => Boolean(turn.assistantMessage?.content?.trim())) ?? null,
    [thread?.turns],
  );
  const {
    audioInputRef,
    voiceBusy,
    voiceInputAvailable,
    voiceOutputAvailable,
    voiceTalkActive,
    voiceStatusLabel,
    voiceUnavailableReason,
    speakResponsesEnabled,
    setSpeakResponsesEnabled,
    imageBusy,
    imageGenerationAvailable,
    imageEditAvailable,
    imageRouteLabel,
    handleToggleVoiceTalk,
    handleOpenAudioTranscribe,
    handleAudioFileSelected,
    handleGenerateImage,
    handleEditImage,
  } = useChatMultimodalControls({
    providerOptions,
    selectedProviderId,
    routePreflight: currentRoutePreflight,
    selectedSessionId,
    activeThreadSessionId: thread?.sessionId,
    pendingAttachments,
    draft,
    latestAssistantMessageId: latestAssistantTurn?.assistantMessage?.messageId,
    latestAssistantContent: latestAssistantTurn?.assistantMessage?.content,
    latestAssistantStatus: latestAssistantTurn?.trace.status,
    setDraft,
    setError,
    pushLocalNotice,
    uploadAttachments,
  });

  const workspaceSummaryText = selectedSession
    ? `${lockSurface ? "Current session" : isCodeSurface ? "Current code session" : `Active ${activeModePreset.label.toLowerCase()} session`}: ${selectedSession.title || visibleSessionLabelById.get(selectedSession.sessionId) || `Chat ${selectedSession.sessionId.slice(-6)}`}.`
    : lockSurface
      ? `Start a new ${activeModePreset.label.toLowerCase()} run or reopen a recent session from the left rail.`
      : isCodeSurface
        ? "Pick a code session or start a new one. Bind a project only when you want execution-heavy work."
        : `Use the queue to reopen a session or start a new ${activeModePreset.label.toLowerCase()} run from the left rail.`;

  const rootClassName = `chat-v11 mode-${messageMode}${lockSurface ? " shell-owned-surface" : ""}`;
  const visibleDelegationRun =
    activeDelegationRun?.attachedTurnId &&
    activeWorkflowTurn &&
    activeDelegationRun.attachedTurnId !== activeWorkflowTurn.turnId
      ? null
      : activeDelegationRun;
  if (loading) {
    return (
      <section className={rootClassName}>
        {!lockSurface ? (
          <PageHeader
            title={surfaceHeaderTitle}
            subtitle={surfaceHeaderSubtitle}
            className="page-header-command chat-v11-header"
          />
        ) : null}
        <CardSkeleton lines={8} />
      </section>
    );
  }

  return (
    <section className={rootClassName}>
      {!lockSurface ? (
        <PageHeader
          title={surfaceHeaderTitle}
          subtitle={surfaceHeaderSubtitle}
          hint={
            isCodeSurface
              ? undefined
              : "Stay in the main thread by default. Open trace, memory, and approvals only when you need them."
          }
          className="page-header-command chat-v11-header"
          actions={
            <div className="chat-v11-page-actions">
              <StatusChip tone={selectedSessionId ? "live" : "muted"}>
                {selectedSessionId ? "Session selected" : "No session"}
              </StatusChip>
              {selectedSession ? (
                <StatusChip tone={selectedSession.scope === "external" ? "warning" : "success"}>
                  {selectedSession.scope === "external" ? "External writeback (non-resumable)" : "Mission session"}
                </StatusChip>
              ) : null}
              {!isCodeSurface && selectedTurn ? (
                <StatusChip tone="muted">{selectedTurn.trace.status}</StatusChip>
              ) : null}
            </div>
          }
        />
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {isRefreshing ? <p className="status-banner">Refreshing chat context...</p> : null}

      {renderWorkSurface({
        messageMode,
        selectedSession,
        selectedTurn,
        activeWorkflowTurn,
        selectedProject,
        isCoworkSurface,
        isCodeSurface,
        dockOpen,
        handleDockOpenChange,
        sessionRailOpen,
        handleSessionRailOpenChange,
        codeModeNeedsProjectBinding,
        workbenchState,
        workbenchTree,
        selectedWorkbenchFile,
        selectedWorkbenchFileDiff,
        workbenchDraftContent,
        workbenchExpandedPaths,
        workbenchDiff,
        workbenchOutput,
        workbenchLoading,
        workbenchBusy,
        workbenchSaving,
        workbenchError,
        hasDirtyWorkbenchDraft,
        createWorkbenchWorktree,
        openWorkbenchFile,
        saveWorkbenchFile,
        discardWorkbenchDraft,
        setWorkbenchDraftContent,
        setWorkbenchExpandedPaths,
        refreshWorkbench,
        handleRunCodeHelper,
        activeGeneratedArtifact,
        handleCloseGeneratedArtifact,
        latestOrchestration,
        orchestrationRun,
        orchestrationCheckpoints,
        orchestrationLoading,
        orchestrationError,
        coworkViewModel,
        activeDelegationRun: visibleDelegationRun,
        onOpenTasks,
        handleRetryTurn,
        handleStopActiveTurn,
        refreshOrchestrationRun,
        onFocusComposer: () => composerRef.current?.focus(),
        onOpenRunDetails: () => handleRevealActiveTurnDetails(),
        sessionRail: (
          <ChatSessionSidebar
            mode={messageMode}
            showProjectCreate={showProjectCreate}
            creatingSession={Boolean(creatingSessionMode)}
            search={search}
            projectName={projectName}
            projectPath={projectPath}
            historyView={historyView}
            selectedProjectId={selectedProjectId}
            availableFolders={availableFolders}
            selectedFolderId={selectedFolderId}
            selectedTag={selectedTag}
            missionSessions={missionSessions}
            externalSessions={externalSessions}
            selectedSessionId={selectedSessionId}
            summaryTitle={selectedProject?.name ?? "Mission Control workspace"}
            summaryCopy={workspaceSummaryText}
            workspaceSummaryCards={workspaceSummaryCards}
            archiveWorkspaceEnabled={isChatSurface && historyView === "active" && workspaceMissionSessionCount > 0}
            archiveWorkspacePending={archiveWorkspacePending}
            onToggleProjectCreate={() => setShowProjectCreate((current) => !current)}
            onCreateSession={handleCreateCurrentModeSession}
            onSearchChange={setSearch}
            onProjectNameChange={setProjectName}
            onProjectPathChange={setProjectPath}
            onCreateProject={() => void handleCreateProject()}
            onHistoryViewChange={setHistoryView}
            onArchiveWorkspace={handleArchiveWorkspace}
            onSelectProjectId={setSelectedProjectId}
            onSelectFolderId={setSelectedFolderId}
            onSelectTag={setSelectedTag}
            onSelectSession={handleSelectSessionFromRail}
            renderSessionLabel={(sessionId) => visibleSessionLabelById.get(sessionId) ?? `Chat ${sessionId.slice(-6)}`}
          />
        ),
        primaryColumn: selectedSession ? (
          <MissionControlActiveSessionSurface
            mode={messageMode}
            sessionTitle={selectedSessionLabel}
            summary={workspaceSummaryText}
            trust={sessionTrust}
            dockOpen={dockOpen}
            onToggleDock={handleToggleDock}
            onNavigateSurface={handleNavigateSurface}
            loading={messagesLoading}
            thread={thread}
            selectedTurnId={selectedTurnId}
            delegationRun={visibleDelegationRun}
            notices={localNotices}
            followOutput={followThreadOutput}
            streamStatus={streamStatus as ChatStreamStatus}
            queuedCount={queuedOutbound.length}
            streamError={error}
            pendingApproval={pendingApproval}
            pendingUserInput={pendingUserInput}
            workspaceId={selectedSession.workspaceId ?? workspaceId}
            approvalPending={approvalPending}
            userInputPending={userInputPending}
            eventStreamStatus={eventStreamStatus}
            onBottomStateChange={setFollowThreadOutput}
            onSelectTurn={(turnId) => {
              setSelectedTurnId(turnId);
            }}
            onSwitchBranch={(turnId) => void handleSelectBranchTurnAndSync(turnId)}
            onRetryTurn={(turnId) => void handleRetryTurn(turnId)}
            onEditTurn={handleBeginEditTurn}
            onOpenRunDetails={(turnId) => {
              setSelectedTurnId(turnId);
              handleDockOpenChange(true);
            }}
            onOpenGeneratedArtifact={(turnId) => void handleOpenGeneratedArtifactFromTurn(turnId)}
            onCreateGeneratedArtifact={(turnId) => void handleCreateGeneratedArtifactFromTurn(turnId)}
            onCreateGeneratedArtifactVersion={(turnId) =>
              void handleCreateGeneratedArtifactFromTurn(turnId, { supersedeLatest: true })
            }
            onApprovePending={(allowScope) => void handleApprovePending(allowScope)}
            onDenyPending={() => void handleDenyPending()}
            onSubmitUserInput={(response) => void handleSubmitUserInput(response)}
            onRefreshThread={() => void loadSessionCoreState(selectedSession.sessionId, { includeThread: true })}
            isDragActive={isDragActive}
            queueItems={queuedOutbound.map((item) => ({
              id: item.id,
              action: item.action,
              label: item.content.trim()
                ? item.content.trim().slice(0, 96)
                : `Turn ${item.targetTurnId?.slice(-6) ?? "queued"}`,
              createdAt: item.createdAt,
              paused: Boolean(item.paused),
            }))}
            editingTurnId={editingTurnId}
            planningMode={planningMode ? "advisory" : "off"}
            effectiveToolAutonomy={effectiveToolAutonomy}
            draft={draft}
            commandSuggestions={commandSuggestions}
            commandIndex={commandIndex}
            pendingAttachments={pendingAttachments}
            pendingAttachmentModes={pendingAttachmentModes}
            threadKnowledgeAttachments={threadKnowledgeAttachments?.items ?? []}
            presetOptions={presetProfiles.map((item) => ({
              value: item.agentId,
              label: item.label,
              summary: item.summary,
              routeHint: item.routeHint,
              toolsPosture: item.toolsPosture,
            }))}
            selectedPresetId={selectedPresetId}
            presetApplyWarning={presetApplyWarning}
            selectedTurnRecovery={selectedTurnRecovery}
            selectedTurn={selectedTurn}
            selectedSessionId={selectedSessionId}
            currentWebMode={prefs?.webMode ?? "auto"}
            routePreflight={currentRoutePreflight}
            routeBoundaryAckRequired={Boolean(coworkRouteBoundaryAckRequired)}
            routeBoundaryAcknowledged={currentRouteBoundaryAcknowledged}
            sending={sending}
            canSend={canSend}
            hasActiveStream={Boolean(activeStreamRef.current)}
            activeStreamTurnAssigned={Boolean(activeStreamRef.current?.turnId)}
            composerRef={composerRef}
            fileInputRef={fileInputRef}
            audioInputRef={audioInputRef}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onResumeAll={handleResumeQueue}
            onRemoveQueuedItem={handleRemoveQueuedItem}
            onCancelEdit={handleCancelEdit}
            onDismissError={handleDismissError}
            onAcknowledgeRouteBoundary={acknowledgeCurrentRouteBoundary}
            onSetDeepMode={() => handleSetDeepMode()}
            onReviewRunDetails={handleRevealSelectedTurnDetails}
            onDraftChange={setDraft}
            onComposerKeyDown={handleComposerKeyDown}
            onComposerPaste={handleComposerPaste}
            onApplyDraftCommand={handleApplyDraftCommand}
            onPresetChange={setSelectedPresetId}
            onApplyPreset={() => void handleApplyPreset()}
            onDismissPresetWarning={() => setPresetApplyWarning(null)}
            onSetAttachmentMode={handleSetPendingAttachmentMode}
            onRemoveThreadKnowledgeAttachment={(attachmentId) => void handleRemoveThreadKnowledge(attachmentId)}
            knowledgeUrlDraft={knowledgeUrlDraft}
            knowledgeUrlMode={knowledgeUrlMode}
            onKnowledgeUrlDraftChange={setKnowledgeUrlDraft}
            onKnowledgeUrlModeChange={setKnowledgeUrlMode}
            onAttachKnowledgeUrl={() => void handleAttachKnowledgeUrl()}
            onRemoveAttachment={handleRemoveAttachment}
            onAttachFiles={() => fileInputRef.current?.click()}
            onUploadFiles={handleUploadFiles}
            onRunQuickResearch={() => void handleRunQuickResearch()}
            voiceBusy={voiceBusy}
            voiceInputAvailable={voiceInputAvailable}
            voiceOutputAvailable={voiceOutputAvailable}
            voiceTalkActive={voiceTalkActive}
            voiceStatusLabel={voiceStatusLabel}
            voiceUnavailableReason={voiceUnavailableReason}
            speakResponsesEnabled={speakResponsesEnabled}
            imageBusy={imageBusy}
            imageGenerationAvailable={imageGenerationAvailable}
            imageEditAvailable={imageEditAvailable}
            imageRouteLabel={imageRouteLabel}
            onToggleVoiceTalk={() => void handleToggleVoiceTalk()}
            onOpenAudioTranscribe={handleOpenAudioTranscribe}
            onAudioFileSelected={handleAudioFileSelected}
            onToggleSpeakResponses={() => setSpeakResponsesEnabled((current) => !current)}
            onGenerateImage={() => void handleGenerateImage()}
            onEditImage={() => void handleEditImage()}
            activeGeneratedArtifact={activeGeneratedArtifact}
            onCloseGeneratedArtifact={handleCloseGeneratedArtifact}
            onStopActiveTurn={() => void handleStopActiveTurn()}
            onSend={() => void handleSendWithKnowledge()}
          />
        ) : (
          <MissionControlEmptyState
            mode={messageMode}
            sessionCount={missionSessions.length + externalSessions.length}
            projectCount={projects?.items.length ?? 0}
            workspaceName={workspaceName}
            approvalsCount={approvalsCount}
            onCreateSession={handleCreateCurrentModeSession}
            onOpenCowork={onOpenCowork}
            onOpenCode={onOpenCode}
            onOpenTasks={onOpenTasks}
            onOpenApprovals={onOpenApprovals}
          />
        ),
        contextDock: selectedSession ? (
          <ChatContextDockPanels
            mode={messageMode}
            dockOpen={dockOpen}
            dockSectionStyle={dockSectionStyle}
            isChatSurface={isChatSurface}
            isCoworkSurface={isCoworkSurface}
            isCodeSurface={isCodeSurface}
            activeModePreset={activeModePreset as ChatModePresetRecord}
            planningMode={planningMode}
            effectiveToolAutonomy={effectiveToolAutonomy}
            codeModeNeedsProjectBinding={codeModeNeedsProjectBinding}
            selectedSession={selectedSession}
            selectedProject={selectedProject}
            selectedProjectBindingCandidateId={selectedProjectBindingCandidateId}
            selectedProjectBindingCandidateName={selectedProjectBindingCandidateName}
            sending={sending}
            sessionControlPending={sessionControlPending}
            providerOptions={providerOptions}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            streamEnabled={streamEnabled}
            onStreamEnabledChange={setStreamEnabled}
            prefs={prefs}
            selectedSessionId={selectedSessionId}
            showTracePanel={showTracePanel}
            selectedTurn={selectedTurn}
            activeGeneratedArtifact={activeGeneratedArtifact}
            routePreflight={currentRoutePreflight}
            providerLabelById={providerLabelById}
            showSuggestionsPanel={showSuggestionsPanel}
            showLearnedMemoryPanel={showLearnedMemoryPanel}
            latestOrchestration={latestOrchestration}
            coworkItems={coworkItems}
            coworkViewModel={coworkViewModel}
            proactiveStatus={proactiveStatus}
            proactiveRuns={proactiveRuns}
            proactiveSuggestionCount={proactiveSuggestionCount}
            capabilitySuggestions={capabilitySuggestions}
            specialistSuggestions={specialistSuggestions}
            specialistCandidates={specialistCandidates}
            delegationSuggestion={delegationSuggestion}
            learnedMemory={learnedMemory}
            secondaryLoading={secondaryLoading}
            binding={binding}
            integrationConnectionId={integrationConnectionId}
            integrationTarget={integrationTarget}
            selectedSessionProjectValue={selectedSessionProjectValue}
            projectOptions={[
              { value: "none", label: "Unassigned" },
              ...(projects?.items ?? [])
                .filter((item) => item.lifecycleStatus === "active")
                .map((project) => ({ value: project.projectId, label: project.name })),
            ]}
            loadModelsForProvider={loadModelsForProvider}
            getCachedModels={getCachedModels}
            resolveProviderModelSelection={resolveProviderModelSelection}
            onPrefPatch={handlePrefPatch}
            onSuggestDelegation={handleSuggestDelegation}
            onTriggerProactive={handleTriggerProactive}
            onProactivePolicyPatch={handleProactivePolicyPatch}
            onRunCodeDelegation={handleRunCodeDelegation}
            onCapabilitySuggestionAction={handleCapabilitySuggestionAction}
            onCreateSpecialistDraft={handleCreateSpecialistDraft}
            onActivateCatalogSpecialist={handleActivateCatalogSpecialist}
            onSpecialistCandidatePatch={handleSpecialistCandidatePatch}
            onAcceptDelegation={handleAcceptDelegation}
            onRebuildLearnedMemory={handleRebuildLearnedMemory}
            onUpdateMemoryStatus={handleMemoryStatusUpdate}
            onCloseGeneratedArtifact={handleCloseGeneratedArtifact}
            onRenameTitleChange={setRenameTitle}
            renameTitle={renameTitle}
            folderName={folderName}
            onFolderNameChange={setFolderName}
            tagsValue={tagsValue}
            onTagsValueChange={setTagsValue}
            onRenameSession={handleRenameSession}
            onSaveOrganization={handleSaveOrganization}
            onTogglePinSession={handleTogglePinSession}
            onToggleArchiveSession={handleToggleArchiveSession}
            onDeleteSession={() => handleDeleteSession(formatSessionLabel(selectedSession))}
            onAssignProject={handleAssignProject}
            onExportSnapshot={handleExportSessionSnapshot}
            onIntegrationConnectionIdChange={setIntegrationConnectionId}
            onIntegrationTargetChange={setIntegrationTarget}
            onSaveExternalBinding={handleSaveExternalBinding}
          />
        ) : (
          <></>
        ),
      })}
      <ConfirmModal
        open={Boolean(capabilitySuggestionConfirm)}
        title={capabilityConfirmationCopy?.title ?? "Confirm capability action"}
        message={capabilityConfirmationCopy?.message ?? ""}
        confirmLabel={
          capabilitySuggestionPending ? "Applying..." : (capabilityConfirmationCopy?.confirmLabel ?? "Confirm")
        }
        danger={capabilityConfirmationCopy?.danger ?? false}
        pending={capabilitySuggestionPending}
        cancelDisabled={capabilitySuggestionPending}
        disableDismiss={capabilitySuggestionPending}
        onCancel={() => setCapabilitySuggestionConfirm(null)}
        onConfirm={handleConfirmCapabilitySuggestion}
      />
      <ConfirmModal
        open={Boolean(workbenchDiscardConfirm)}
        title={workbenchDiscardConfirm?.title ?? "Discard unsaved workbench changes?"}
        message={workbenchDiscardConfirm?.message ?? ""}
        confirmLabel="Discard changes"
        danger
        onCancel={() => setWorkbenchDiscardConfirm(null)}
        onConfirm={() => {
          if (!workbenchDiscardConfirm) {
            return;
          }
          const action = workbenchDiscardConfirm.onConfirm;
          setWorkbenchDiscardConfirm(null);
          action();
        }}
      />
      <ConfirmModal
        open={Boolean(sessionDeleteConfirm)}
        title="Delete session permanently"
        message={sessionDeleteConfirm ? getDeleteSessionConfirmationMessage(sessionDeleteConfirm.label) : ""}
        confirmLabel={sessionControlPending === "delete" ? "Deleting..." : "Delete permanently"}
        danger
        pending={sessionControlPending === "delete"}
        cancelDisabled={sessionControlPending === "delete"}
        disableDismiss={sessionControlPending === "delete"}
        onCancel={() => setSessionDeleteConfirm(null)}
        onConfirm={handleConfirmDeleteSession}
      />
      <ConfirmModal
        open={archiveWorkspaceConfirmOpen}
        title="Archive Workspace Mission Chats"
        message={`Archive ${workspaceMissionSessionCount} active mission chats in this workspace? Archived chats leave the default history rail but stay recoverable from the Archived view. External and integration-bound chats are not affected.`}
        confirmLabel={archiveWorkspacePending ? "Archiving..." : "Archive mission chats"}
        danger
        pending={archiveWorkspacePending}
        cancelDisabled={archiveWorkspacePending}
        disableDismiss={archiveWorkspacePending}
        onCancel={() => setArchiveWorkspaceConfirmOpen(false)}
        onConfirm={handleConfirmArchiveWorkspace}
      />
    </section>
  );
}

function renderWorkSurface(input: {
  messageMode: ChatMode;
  selectedSession: ReturnType<typeof useChatThreadController>["selectedSession"];
  selectedTurn: ReturnType<typeof useMissionControlSurfaceState>["selectedTurn"];
  activeWorkflowTurn: ReturnType<typeof useChatDockWorkbenchController>["activeWorkflowTurn"];
  selectedProject: ReturnType<typeof useChatThreadController>["selectedProject"];
  isCoworkSurface: boolean;
  isCodeSurface: boolean;
  dockOpen: boolean;
  handleDockOpenChange: (next: boolean) => void;
  sessionRailOpen: boolean;
  handleSessionRailOpenChange: (next: boolean) => void;
  codeModeNeedsProjectBinding: boolean;
  workbenchState: ReturnType<typeof useChatDockWorkbenchController>["workbenchState"];
  workbenchTree: ReturnType<typeof useChatDockWorkbenchController>["workbenchTree"];
  selectedWorkbenchFile: ReturnType<typeof useChatDockWorkbenchController>["selectedWorkbenchFile"];
  selectedWorkbenchFileDiff: ReturnType<typeof useChatDockWorkbenchController>["selectedWorkbenchFileDiff"];
  workbenchDraftContent: ReturnType<typeof useChatDockWorkbenchController>["workbenchDraftContent"];
  workbenchExpandedPaths: ReturnType<typeof useChatDockWorkbenchController>["workbenchExpandedPaths"];
  workbenchDiff: ReturnType<typeof useChatDockWorkbenchController>["workbenchDiff"];
  workbenchOutput: ReturnType<typeof useChatDockWorkbenchController>["workbenchOutput"];
  workbenchLoading: boolean;
  workbenchBusy: boolean;
  workbenchSaving: boolean;
  workbenchError: string | null;
  hasDirtyWorkbenchDraft: boolean;
  createWorkbenchWorktree: (baseRef?: string) => Promise<void>;
  openWorkbenchFile: (relativePath: string) => Promise<boolean>;
  saveWorkbenchFile: () => Promise<boolean>;
  discardWorkbenchDraft: () => void;
  setWorkbenchDraftContent: (next: string) => void;
  setWorkbenchExpandedPaths: (nextPaths: string[]) => void;
  refreshWorkbench: () => Promise<void>;
  handleRunCodeHelper: (language: string, source: string) => Promise<void>;
  activeGeneratedArtifact: ChatGeneratedArtifactRecord | null;
  handleCloseGeneratedArtifact: () => void;
  latestOrchestration: ReturnType<typeof useChatDockWorkbenchController>["latestOrchestration"];
  orchestrationRun: ReturnType<typeof useChatDockWorkbenchController>["orchestrationRun"];
  orchestrationCheckpoints: ReturnType<typeof useChatDockWorkbenchController>["orchestrationCheckpoints"];
  orchestrationLoading: ReturnType<typeof useChatDockWorkbenchController>["orchestrationLoading"];
  orchestrationError: ReturnType<typeof useChatDockWorkbenchController>["orchestrationError"];
  coworkViewModel: ReturnType<typeof deriveCoworkRunViewModel>;
  activeDelegationRun: ActiveChatDelegationRun | null;
  onOpenTasks: () => void;
  handleRetryTurn: (turnId: string) => Promise<void>;
  handleStopActiveTurn: () => Promise<void>;
  refreshOrchestrationRun: () => Promise<void>;
  onFocusComposer: () => void;
  onOpenRunDetails: () => void;
  sessionRail: React.ReactNode;
  primaryColumn: React.ReactNode;
  contextDock: React.ReactNode;
}) {
  const baseProps = {
    mode: input.messageMode,
    sessionRail: input.sessionRail,
    primaryColumn: input.primaryColumn,
    contextDock: input.contextDock,
    dockOpen: input.selectedSession ? input.dockOpen : false,
    onDockOpenChange: input.handleDockOpenChange,
    hasActiveSession: Boolean(input.selectedSession),
    sessionRailOpen: input.sessionRailOpen,
    onSessionRailOpenChange: input.handleSessionRailOpenChange,
  };

  if (input.selectedSession && input.isCoworkSurface) {
    const activeWorkflowTurn = input.activeWorkflowTurn;
    return (
      <CoworkWorkSurface
        {...baseProps}
        coworkPanel={{
          viewModel: input.coworkViewModel,
          onRetryTurn: activeWorkflowTurn ? () => void input.handleRetryTurn(activeWorkflowTurn.turnId) : undefined,
          onStopTurn:
            activeWorkflowTurn && isChatTurnActiveStatus(activeWorkflowTurn.trace.status)
              ? () => void input.handleStopActiveTurn()
              : undefined,
          onOpenTasks: input.onOpenTasks,
          onOpenDetails: input.onOpenRunDetails,
          onFocusComposer: input.onFocusComposer,
          onRefreshRunState: () => void input.refreshOrchestrationRun(),
        }}
      />
    );
  }

  if (input.selectedSession && input.isCodeSurface) {
    return (
      <CodeWorkSurface
        {...baseProps}
        codePanel={{
          selectedTurn: input.selectedTurn,
          projectName: input.selectedProject?.name ?? undefined,
          needsProjectBinding: input.codeModeNeedsProjectBinding,
          workbenchState: input.workbenchState,
          workbenchTree: input.workbenchTree,
          selectedFile: input.selectedWorkbenchFile,
          selectedFileDiff: input.selectedWorkbenchFileDiff,
          draftContent: input.workbenchDraftContent,
          expandedPaths: input.workbenchExpandedPaths,
          diff: input.workbenchDiff,
          output: input.workbenchOutput,
          loading: input.workbenchLoading,
          busy: input.workbenchBusy,
          saving: input.workbenchSaving,
          error: input.workbenchError,
          hasDirtyDraft: input.hasDirtyWorkbenchDraft,
          generatedArtifact: input.activeGeneratedArtifact,
          onCloseGeneratedArtifact: input.handleCloseGeneratedArtifact,
          onCreateWorktree: () => void input.createWorkbenchWorktree(input.workbenchState?.baseRef),
          onSelectFile: (relativePath) => void input.openWorkbenchFile(relativePath),
          onDraftChange: (nextValue) => input.setWorkbenchDraftContent(nextValue),
          onExpandedPathsChange: (nextPaths) => input.setWorkbenchExpandedPaths(nextPaths),
          onRefresh: () => void input.refreshWorkbench(),
          onSaveFile: () => void input.saveWorkbenchFile(),
          onDiscardDraft: () => input.discardWorkbenchDraft(),
          onRunHelperSnippet: (language, source) => void input.handleRunCodeHelper(language, source),
        }}
      />
    );
  }

  if (input.isCoworkSurface || input.isCodeSurface) {
    return (
      <ChatSurfaceLayout
        mode={input.messageMode}
        sessionRail={input.sessionRail}
        primaryColumn={null}
        workflowColumn={input.primaryColumn}
        contextDock={input.contextDock}
        dockOpen={false}
        onDockOpenChange={input.handleDockOpenChange}
        hasActiveSession={false}
        sessionRailOpen={input.sessionRailOpen}
        onSessionRailOpenChange={input.handleSessionRailOpenChange}
      />
    );
  }

  return <ChatWorkSurface {...baseProps} />;
}
