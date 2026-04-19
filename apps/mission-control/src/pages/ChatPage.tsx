/* eslint-disable max-lines -- ChatPage remains the top-level orchestration entrypoint while behavior lives in focused hooks and dock sections. */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatAttachmentRecord,
  ChatMode,
  ChatModePresetRecord,
  ChatSessionPrefsPatch,
  ChatThreadResponse,
} from "@goatcitadel/contracts";
import { isChatTurnActiveStatus } from "@goatcitadel/contracts";
import {
  fetchMcpServers,
  fetchMcpTemplates,
  fetchSkills,
  parseChatCommand,
  updateChatSessionPrefs,
} from "../api/client";
import { CardSkeleton } from "../components/CardSkeleton";
import { ConfirmModal } from "../components/ConfirmModal";
import { PageHeader } from "../components/PageHeader";
import { StatusChip } from "../components/StatusChip";
import type { ChatStreamStatus } from "../components/chat/ChatStreamStatusBar";
import type { ChatThreadNotice } from "../components/chat/ChatThreadView";
import { useEventStreamStatus } from "../hooks/useEventStreamStatus";
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
import type { ActiveChatDelegationRun } from "./chat/useChatDelegationPolicyActions";
import {
  resolveOutboundDraftContent,
  useChatSurfaceOrchestration,
  type OutboundQueueItem,
} from "./chat/useChatSurfaceOrchestration";
import { useChatThreadController } from "./chat/useChatThreadController";
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
}) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>("all");
  const [historyView, setHistoryView] = useState<"active" | "archived">("active");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [streamEnabled, setStreamEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const raw = window.localStorage.getItem(STREAM_PREF_KEY);
    return raw === null ? true : raw === "true";
  });
  const [renameTitle, setRenameTitle] = useState("");
  const [isDragActive, setIsDragActive] = useState(false);
  const [followThreadOutput, setFollowThreadOutput] = useState(true);
  const [localNotices, setLocalNotices] = useState<ChatThreadNotice[]>([]);

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

  const sessionData = useChatSessionData({
    workspaceId,
    historyView,
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
  const threadController = useChatThreadController({
    routeSearch,
    sessions: sessions?.items,
    projects: projects?.items,
    thread,
    selectedProjectId,
    setSelectedProjectId,
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
  } = threadController;

  useEffect(() => {
    loadSessionCoreStateRef.current = loadSessionCoreState;
  }, [loadSessionCoreState]);

  const sessionControls = useChatSessionControls({
    workspaceId,
    historyView,
    selectedProjectId,
    selectedSession,
    renameTitle,
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
    handleSpecialistCandidatePatch,
    handleCapabilitySuggestionAction,
    confirmCapabilitySuggestionAction,
  } = contextActions;

  const outbound = useChatOutboundExecution({
    selectedSessionId,
    selectedSession,
    providerOptions,
    selectedProviderId,
    selectedModel,
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
    getCachedModels,
    pushLocalNotice,
    handleCommandExecution,
    executeOutboundItemRef,
    tryBeginOutboundExecutionRef,
    applyFetchedThreadRef,
    messageMutationVersionRef,
  });
  const {
    pendingApproval,
    setPendingApproval,
    approvalPending,
    handleApprovePending,
    handleDenyPending,
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
  }, [selectedSession?.sessionId, selectedSession?.title]);
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
    workbenchState,
    workbenchTree,
    selectedWorkbenchFile,
    workbenchDiff,
    workbenchOutput,
    workbenchLoading,
    workbenchBusy,
    workbenchError,
    refreshWorkbench,
    createWorkbenchWorktree,
    openWorkbenchFile,
    latestOrchestration,
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
  const canSend =
    Boolean(resolveOutboundDraftContent(draft, pendingAttachments.length, editingTurnId ? "edit" : "send")) &&
    !sending &&
    !pendingApproval;

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

  const handlePrefPatch = useCallback(
    async (patch: ChatSessionPrefsPatch) => {
      if (!selectedSession) return;
      lastLocalPrefMutationAtRef.current = Date.now();
      const previousPrefs = prefsRef.current;
      const optimisticPrefs = previousPrefs ? resolveOptimisticChatPrefs(previousPrefs, patch) : null;
      const mutationId = prefMutationSequenceRef.current + 1;
      prefMutationSequenceRef.current = mutationId;
      if (optimisticPrefs) {
        prefsRef.current = optimisticPrefs;
        setPrefs(optimisticPrefs);
      }
      try {
        const updated = await updateChatSessionPrefs(selectedSession.sessionId, patch);
        if (prefMutationSequenceRef.current !== mutationId) {
          return;
        }
        prefsRef.current = updated;
        setPrefs(updated);
      } catch (err) {
        if (prefMutationSequenceRef.current === mutationId && previousPrefs) {
          prefsRef.current = previousPrefs;
          setPrefs(previousPrefs);
        }
        setError((err as Error).message);
      }
    },
    [prefsRef, selectedSession, setPrefs],
  );

  const handleRevealSelectedTurnDetails = useCallback(() => {
    if (!selectedTurn) {
      return;
    }
    setSelectedTurnId(selectedTurn.turnId);
    setDockOpen(true);
  }, [selectedTurn, setDockOpen]);

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
    handleComposerKeyDown,
    handleComposerPaste,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDismissError,
    handleCancelEdit,
    handleToggleDock,
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

  const workspaceSummaryText = selectedSession
    ? `${lockSurface ? "Current session" : isCodeSurface ? "Current code session" : `Active ${activeModePreset.label.toLowerCase()} session`}: ${selectedSession.title || visibleSessionLabelById.get(selectedSession.sessionId) || `Chat ${selectedSession.sessionId.slice(-6)}`}.`
    : lockSurface
      ? `Start a new ${activeModePreset.label.toLowerCase()} run or reopen a recent session from the left rail.`
      : isCodeSurface
        ? "Pick a code session or start a new one. Bind a project only when you want execution-heavy work."
        : `Use the queue to reopen a session or start a new ${activeModePreset.label.toLowerCase()} run from the left rail.`;

  const rootClassName = `chat-v11 mode-${messageMode}${lockSurface ? " shell-owned-surface" : ""}`;
  const visibleDelegationRun =
    activeDelegationRun?.attachedTurnId && selectedTurn && activeDelegationRun.attachedTurnId !== selectedTurn.turnId
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
        selectedProject,
        isCoworkSurface,
        isCodeSurface,
        dockOpen,
        codeModeNeedsProjectBinding,
        workbenchState,
        workbenchTree,
        selectedWorkbenchFile,
        workbenchDiff,
        workbenchOutput,
        workbenchLoading,
        workbenchBusy,
        workbenchError,
        createWorkbenchWorktree,
        openWorkbenchFile,
        refreshWorkbench,
        handleRunCodeHelper,
        latestOrchestration,
        coworkItems,
        activeDelegationRun: visibleDelegationRun,
        onOpenTasks,
        handleRetryTurn,
        handleStopActiveTurn,
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
            onSelectSession={setSelectedSessionId}
            renderSessionLabel={(sessionId) => visibleSessionLabelById.get(sessionId) ?? `Chat ${sessionId.slice(-6)}`}
          />
        ),
        primaryColumn: selectedSession ? (
          <MissionControlActiveSessionSurface
            mode={messageMode}
            sessionTitle={selectedSessionLabel}
            summary={workspaceSummaryText}
            trust={
              workTrust ?? {
                workspaceLabel: workspaceName,
                gatewayTone: "muted",
                gatewayLabel: "Gateway state unavailable",
                approvalsSummary: approvalsCount > 0 ? `${approvalsCount} decisions` : "Decisions clear",
                activeModeLabel: activeModePreset.label,
                providerModelSummary: formatWorkProviderModelSummary(selectedProviderLabel, selectedModelLabel),
                runtimeSummary: "Runtime summary unavailable",
              }
            }
            dockOpen={dockOpen}
            onToggleDock={handleToggleDock}
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
            workspaceId={selectedSession.workspaceId ?? workspaceId}
            approvalPending={approvalPending}
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
              setDockOpen(true);
            }}
            onApprovePending={(allowScope) => void handleApprovePending(allowScope)}
            onDenyPending={() => void handleDenyPending()}
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
            selectedTurnRecovery={selectedTurnRecovery}
            selectedTurn={selectedTurn}
            selectedSessionId={selectedSessionId}
            currentWebMode={prefs?.webMode ?? "auto"}
            sending={sending}
            canSend={canSend}
            hasActiveStream={Boolean(activeStreamRef.current)}
            activeStreamTurnAssigned={Boolean(activeStreamRef.current?.turnId)}
            composerRef={composerRef}
            fileInputRef={fileInputRef}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onResumeAll={handleResumeQueue}
            onRemoveQueuedItem={handleRemoveQueuedItem}
            onCancelEdit={handleCancelEdit}
            onDismissError={handleDismissError}
            onSetDeepMode={() => handleSetDeepMode()}
            onReviewRunDetails={handleRevealSelectedTurnDetails}
            onDraftChange={setDraft}
            onComposerKeyDown={handleComposerKeyDown}
            onComposerPaste={handleComposerPaste}
            onApplyDraftCommand={handleApplyDraftCommand}
            onRemoveAttachment={handleRemoveAttachment}
            onAttachFiles={() => fileInputRef.current?.click()}
            onUploadFiles={handleUploadFiles}
            onRunQuickResearch={() => void handleRunQuickResearch()}
            onStopActiveTurn={() => void handleStopActiveTurn()}
            onSend={() => void handleSend()}
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
            showSuggestionsPanel={showSuggestionsPanel}
            showLearnedMemoryPanel={showLearnedMemoryPanel}
            latestOrchestration={latestOrchestration}
            coworkItems={coworkItems}
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
            onSpecialistCandidatePatch={handleSpecialistCandidatePatch}
            onAcceptDelegation={handleAcceptDelegation}
            onRebuildLearnedMemory={handleRebuildLearnedMemory}
            onUpdateMemoryStatus={handleMemoryStatusUpdate}
            onRenameTitleChange={setRenameTitle}
            renameTitle={renameTitle}
            onRenameSession={handleRenameSession}
            onTogglePinSession={handleTogglePinSession}
            onToggleArchiveSession={handleToggleArchiveSession}
            onDeleteSession={() => handleDeleteSession(formatSessionLabel(selectedSession))}
            onAssignProject={handleAssignProject}
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
  selectedProject: ReturnType<typeof useChatThreadController>["selectedProject"];
  isCoworkSurface: boolean;
  isCodeSurface: boolean;
  dockOpen: boolean;
  codeModeNeedsProjectBinding: boolean;
  workbenchState: ReturnType<typeof useChatDockWorkbenchController>["workbenchState"];
  workbenchTree: ReturnType<typeof useChatDockWorkbenchController>["workbenchTree"];
  selectedWorkbenchFile: ReturnType<typeof useChatDockWorkbenchController>["selectedWorkbenchFile"];
  workbenchDiff: ReturnType<typeof useChatDockWorkbenchController>["workbenchDiff"];
  workbenchOutput: ReturnType<typeof useChatDockWorkbenchController>["workbenchOutput"];
  workbenchLoading: boolean;
  workbenchBusy: boolean;
  workbenchError: string | null;
  createWorkbenchWorktree: (baseRef?: string) => Promise<void>;
  openWorkbenchFile: (relativePath: string) => Promise<void>;
  refreshWorkbench: () => Promise<void>;
  handleRunCodeHelper: (language: string, source: string) => Promise<void>;
  latestOrchestration: ReturnType<typeof useChatDockWorkbenchController>["latestOrchestration"];
  coworkItems: ReturnType<typeof useChatDockWorkbenchController>["coworkItems"];
  activeDelegationRun: ActiveChatDelegationRun | null;
  onOpenTasks: () => void;
  handleRetryTurn: (turnId: string) => Promise<void>;
  handleStopActiveTurn: () => Promise<void>;
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
    hasActiveSession: Boolean(input.selectedSession),
  };

  if (input.selectedSession && input.isCoworkSurface) {
    const selectedTurn = input.selectedTurn;
    return (
      <CoworkWorkSurface
        {...baseProps}
        coworkPanel={{
          items: input.coworkItems,
          orchestration: input.latestOrchestration ?? undefined,
          executionPlan: selectedTurn?.trace.executionPlan,
          delegationRun: input.activeDelegationRun,
          selectedTurn,
          workbenchState: input.workbenchState,
          onRetryTurn: selectedTurn ? () => void input.handleRetryTurn(selectedTurn.turnId) : undefined,
          onStopTurn:
            selectedTurn && isChatTurnActiveStatus(selectedTurn.trace.status)
              ? () => void input.handleStopActiveTurn()
              : undefined,
          onOpenTasks: input.onOpenTasks,
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
          diff: input.workbenchDiff,
          output: input.workbenchOutput,
          loading: input.workbenchLoading,
          busy: input.workbenchBusy,
          error: input.workbenchError,
          onCreateWorktree: () => void input.createWorkbenchWorktree(input.workbenchState?.baseRef),
          onSelectFile: (relativePath) => void input.openWorkbenchFile(relativePath),
          onRefresh: () => void input.refreshWorkbench(),
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
        hasActiveSession={false}
      />
    );
  }

  return <ChatWorkSurface {...baseProps} />;
}
