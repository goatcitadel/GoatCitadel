/* eslint-disable max-lines -- ChatPage remains the top-level orchestration entrypoint while behavior lives in focused hooks and dock sections. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatAttachmentRecord,
  ChatMode,
  ChatModePresetRecord,
  ChatSessionPrefsPatch,
  ChatThreadResponse,
} from "@goatcitadel/contracts";
import {
  fetchMcpServers,
  fetchMcpTemplates,
  fetchSkills,
  parseChatCommand,
  updateChatSessionPrefs,
} from "../api/client";
import { CardSkeleton } from "../components/CardSkeleton";
import { CodeWorkbenchPanel } from "../components/CodeWorkbenchPanel";
import { ConfirmModal } from "../components/ConfirmModal";
import { CoworkCanvasPanel } from "../components/CoworkCanvasPanel";
import { PageHeader } from "../components/PageHeader";
import { StatusChip } from "../components/StatusChip";
import type { ChatModelProviderOption } from "../components/ChatModelPicker";
import type { ChatStreamStatus } from "../components/chat/ChatStreamStatusBar";
import type { ChatThreadNotice } from "../components/chat/ChatThreadView";
import { useEventStreamStatus } from "../hooks/useEventStreamStatus";
import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { pageCopy } from "../content/copy";
import {
  setDevDiagnosticsActiveChatSession,
  setDevDiagnosticsLatestTraceSummary,
} from "../state/dev-diagnostics-store";
import { buildModelCommandSuggestions, type CommandSuggestionItem } from "./chat-command-suggestions";
import { ChatComposerShell } from "./chat/ChatComposerShell";
import { ChatContextDockPanels } from "./chat/ChatContextDockPanels";
import { ChatSessionSidebar } from "./chat/ChatSessionSidebar";
import { ChatSurfaceLayout } from "./chat/ChatSurfaceLayout";
import { ChatThreadShell } from "./chat/ChatThreadShell";
import { MissionControlEmptyState } from "./chat/MissionControlEmptyState";
import { MissionControlSurfaceHeader } from "./chat/MissionControlSurfaceHeader";
import { dedupeStrings, deriveCoworkItems, formatCommandResult } from "./chat/chat-page-derivations";
import { isLikelyLocalProviderUrl, resolveProviderModelSelection } from "./chat/chat-page-helpers";
import { flattenThreadMessages } from "./chat/chat-page-normalizers";
import {
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
  resolveSelectedTurnId,
  resolveChatRefreshPlan,
  resolveOptimisticChatPrefs,
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
} from "./chat/chat-page-pure-helpers";
import { defaultDockOpenForMode } from "./chat/surface-config";
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
import { type ChatHistoryView, useChatSessionData } from "./chat/useChatSessionData";
import { useChatSessionControls } from "./chat/useChatSessionControls";
import {
  resolveOutboundDraftContent,
  useChatSurfaceOrchestration,
  type OutboundQueueItem,
} from "./chat/useChatSurfaceOrchestration";
import {
  formatSessionLabel,
  looksMachineSessionLabel,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
  type MissionControlDockSectionId,
  useMissionControlSurfaceState,
} from "./chat/useMissionControlSurfaceState";
import "../styles/chat.css";
import "../styles/chat-motion.css";
import "../styles/chat-surface.css";

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
  onOpenCowork?: () => void;
  onOpenCode?: () => void;
  onOpenTasks?: () => void;
  onOpenApprovals?: () => void;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>("all");
  const [historyView, setHistoryView] = useState<ChatHistoryView>("active");
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
  const [commandIndex, setCommandIndex] = useState(0);
  const [isDragActive, setIsDragActive] = useState(false);
  const [followThreadOutput, setFollowThreadOutput] = useState(true);
  const [dockOpen, setDockOpen] = useState<boolean>(() => defaultDockOpenForMode(surface ?? "chat"));
  const [localNotices, setLocalNotices] = useState<ChatThreadNotice[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const lastLocalPrefMutationAtRef = useRef(0);
  const prefMutationSequenceRef = useRef(0);
  const lastShellSurfaceSyncKeyRef = useRef<string | null>(null);
  const lastLoadedShellSessionIdRef = useRef<string | null>(null);
  const appliedRouteSelectionKeyRef = useRef<string | null>(null);
  const pendingRouteTurnSelectionRef = useRef<string | null>(null);
  const executeOutboundItemRef = useRef<(item: OutboundQueueItem) => Promise<void>>(async () => undefined);
  const tryBeginOutboundExecutionRef = useRef<() => boolean>(() => false);
  const queuedOutboundSetterRef = useRef<React.Dispatch<React.SetStateAction<OutboundQueueItem[]>>>(() => []);
  const pushLocalNoticeRef = useRef<(message: string, tone?: ChatThreadNotice["tone"]) => void>(() => undefined);
  const loadSessionCoreStateRef = useRef<
    (sessionId: string, options?: { background?: boolean; includeThread?: boolean }) => Promise<void>
  >(async () => undefined);
  const applyFetchedThreadRef = useRef<(thread: ChatThreadResponse, requestVersion: number | null) => boolean>(
    () => false,
  );
  const messageMutationVersionRef = useRef(0);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);

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
  const routeSearch = typeof window === "undefined" ? "" : window.location.search;

  useEffect(() => {
    if (!routeSearch) {
      appliedRouteSelectionKeyRef.current = null;
      pendingRouteTurnSelectionRef.current = null;
      return;
    }
    const params = new URLSearchParams(routeSearch);
    const routeSessionId = params.get("sessionId")?.trim() || "";
    const routeTurnId = params.get("turnId")?.trim() || "";
    if (!routeSessionId) {
      appliedRouteSelectionKeyRef.current = null;
      pendingRouteTurnSelectionRef.current = null;
      return;
    }
    const routeSelectionKey = `${routeSessionId}:${routeTurnId}`;
    if (appliedRouteSelectionKeyRef.current === routeSelectionKey) {
      return;
    }
    if (!(sessions?.items ?? []).some((item) => item.sessionId === routeSessionId)) {
      return;
    }
    appliedRouteSelectionKeyRef.current = routeSelectionKey;
    pendingRouteTurnSelectionRef.current = routeTurnId || null;
    setSelectedSessionId(routeSessionId);
    setSelectedTurnId(routeTurnId || null);
  }, [routeSearch, sessions?.items]);

  useEffect(() => {
    loadSessionCoreStateRef.current = loadSessionCoreState;
  }, [loadSessionCoreState]);

  const selectedSession = useMemo(
    () => sessions?.items.find((item) => item.sessionId === selectedSessionId) ?? null,
    [selectedSessionId, sessions?.items],
  );
  const selectedProject = useMemo(
    () => (projects?.items ?? []).find((item) => item.projectId === selectedSession?.projectId) ?? null,
    [projects?.items, selectedSession?.projectId],
  );

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

  const messages = useMemo(() => flattenThreadMessages(thread), [thread]);

  const providerOptions = useMemo<ChatModelProviderOption[]>(() => {
    const activeProviderId = runtimeLlmConfig?.activeProviderId ?? settings?.llm.activeProviderId;
    const activeModel = runtimeLlmConfig?.activeModel ?? settings?.llm.activeModel;
    return runtimeProviderCatalog.map((provider) => ({
      providerId: provider.providerId,
      label: provider.label,
      defaultModel: provider.defaultModel,
      disabled: !provider.hasApiKey && !isLikelyLocalProviderUrl(provider.baseUrl),
      availabilityLabel:
        !provider.hasApiKey && !isLikelyLocalProviderUrl(provider.baseUrl)
          ? `${provider.label} · setup required`
          : undefined,
      availabilityHint:
        !provider.hasApiKey && !isLikelyLocalProviderUrl(provider.baseUrl)
          ? `${provider.label} is not configured yet. Add an API key before using it.`
          : undefined,
      models: dedupeStrings([
        ...provider.models,
        provider.providerId === activeProviderId ? activeModel : undefined,
        prefs?.providerId === provider.providerId ? prefs.model : undefined,
      ]),
    }));
  }, [
    prefs?.model,
    prefs?.providerId,
    runtimeLlmConfig?.activeModel,
    runtimeLlmConfig?.activeProviderId,
    runtimeProviderCatalog,
    settings?.llm.activeModel,
    settings?.llm.activeProviderId,
  ]);

  const selectedProviderId = useMemo(() => {
    const preferredProviderId =
      prefs?.providerId ?? runtimeLlmConfig?.activeProviderId ?? settings?.llm.activeProviderId;
    return providerOptions.find((provider) => provider.providerId === preferredProviderId)?.providerId;
  }, [prefs?.providerId, providerOptions, runtimeLlmConfig?.activeProviderId, settings?.llm.activeProviderId]);

  const selectedProviderSelection = useMemo(() => {
    const provider = providerOptions.find((item) => item.providerId === selectedProviderId);
    return resolveProviderModelSelection({
      provider,
      loadedModels: selectedProviderId ? getCachedModels(selectedProviderId) : [],
      selectedModel: prefs?.model ?? runtimeLlmConfig?.activeModel ?? settings?.llm.activeModel,
    });
  }, [
    getCachedModels,
    prefs?.model,
    providerOptions,
    runtimeLlmConfig?.activeModel,
    selectedProviderId,
    settings?.llm.activeModel,
  ]);
  const selectedModel = selectedProviderSelection.model;
  const selectedProviderLabel = useMemo(
    () => providerOptions.find((item) => item.providerId === selectedProviderId)?.label ?? "Provider auto",
    [providerOptions, selectedProviderId],
  );
  const selectedModelLabel = selectedModel ?? "Model auto";

  useEffect(() => {
    if (!selectedProviderId) {
      return;
    }
    void loadModelsForProvider(selectedProviderId);
  }, [loadModelsForProvider, selectedProviderId]);

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

  useEffect(() => {
    setDevDiagnosticsActiveChatSession(selectedSessionId ?? undefined);
    if (!selectedSessionId) {
      abortActiveChatStream(activeStreamRef.current);
      activeStreamRef.current = null;
      setSelectedTurnId(null);
      setLocalNotices([]);
      setPendingAttachments([]);
      setDelegationSuggestion(null);
      setCapabilitySuggestions([]);
      setSpecialistSuggestions([]);
      setPendingApproval(null);
      lastLoadedShellSessionIdRef.current = null;
      return;
    }
    if (lastLoadedShellSessionIdRef.current !== selectedSessionId) {
      const hadActiveStream = activeStreamRef.current !== null;
      abortActiveChatStream(activeStreamRef.current);
      activeStreamRef.current = null;
      if (hadActiveStream) {
        pushLocalNotice(
          "Stream interrupted - switched sessions. The previous turn may still be processing on the server.",
          "warning",
        );
      }
      setPendingAttachments([]);
      setSelectedTurnId(null);
      setEditingTurnId(null);
      setLocalNotices([]);
      setPendingApproval(null);
      setDelegationSuggestion(null);
      setCapabilitySuggestions([]);
      setSpecialistSuggestions([]);
      lastLoadedShellSessionIdRef.current = selectedSessionId;
    }
  }, [
    pushLocalNotice,
    selectedSessionId,
    setCapabilitySuggestions,
    setDelegationSuggestion,
    setEditingTurnId,
    setPendingApproval,
    setSpecialistSuggestions,
  ]);

  useEffect(() => {
    setFollowThreadOutput(true);
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
    setSelectedTurnId((current) => {
      const pendingRouteTurnId = pendingRouteTurnSelectionRef.current;
      const nextTurnId = resolveSelectedTurnId(thread, current, pendingRouteTurnId);
      if (thread?.turns.length && pendingRouteTurnId) {
        pendingRouteTurnSelectionRef.current = null;
      }
      return nextTurnId;
    });
  }, [thread]);

  useEffect(() => {
    setRenameTitle(selectedSession?.title ?? "");
  }, [selectedSession?.sessionId, selectedSession?.title]);

  const visibleSessions = useMemo(() => {
    const all = sessions?.items ?? [];
    const q = search.trim().toLowerCase();
    return all.filter((item) => {
      if (selectedProjectId !== "all") {
        if (selectedProjectId === "none") {
          if (item.projectId) return false;
        } else if (item.projectId !== selectedProjectId) {
          return false;
        }
      }
      if (!q) return true;
      const haystack = [item.title, item.sessionKey, item.projectName, item.channel, item.account]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [search, selectedProjectId, sessions?.items]);

  const missionSessions = useMemo(() => visibleSessions.filter((item) => item.scope === "mission"), [visibleSessions]);
  const externalSessions = useMemo(
    () => visibleSessions.filter((item) => item.scope === "external"),
    [visibleSessions],
  );
  const workspaceMissionSessionCount = useMemo(
    () => missionSessions.filter((item) => item.lifecycleStatus === "active").length,
    [missionSessions],
  );
  const boundMissionSessionCount = useMemo(
    () => (sessions?.items ?? []).filter((item) => item.scope === "mission" && Boolean(item.projectId)).length,
    [sessions?.items],
  );
  const visibleSessionLabelById = useMemo(
    () => new Map(visibleSessions.map((session) => [session.sessionId, formatSessionLabel(session)])),
    [visibleSessions],
  );

  const commandSuggestions = useMemo(() => {
    const trimmed = draft.trimStart();
    if (!trimmed.startsWith("/")) return [] as CommandSuggestionItem[];
    const normalized = trimmed.toLowerCase();
    if (/^\/plan(\s+\w*)?$/.test(normalized)) {
      return [
        {
          key: "plan-on",
          command: "/plan on",
          description: "Switch this session into advisory planning mode.",
          applyValue: "/plan on",
        },
        {
          key: "plan-off",
          command: "/plan off",
          description: "Return this session to normal execution mode.",
          applyValue: "/plan off",
        },
      ];
    }
    const modelSuggestions = buildModelCommandSuggestions({
      draft,
      providers: providerOptions,
      activeProviderId: selectedProviderId,
    });
    if (modelSuggestions.length > 0) {
      return modelSuggestions;
    }
    const skillStateMatch = normalized.match(/^\/skill\s+(enable|disable|sleep)\s+(.+)?$/);
    if (skillStateMatch) {
      const query = (skillStateMatch[2] ?? "").trim();
      return installedSkills
        .filter((skill) => !query || skill.skillId.toLowerCase().includes(query))
        .slice(0, 8)
        .map((skill) => ({
          key: `${skillStateMatch[1]}-${skill.skillId}`,
          command: `/skill ${skillStateMatch[1]} ${skill.skillId}`,
          description: `${skill.state} · ${skill.name}`,
          applyValue: `/skill ${skillStateMatch[1]} ${skill.skillId}`,
        }));
    }
    const mcpServerMatch = normalized.match(/^\/mcp\s+(connect|disconnect)\s+(.+)?$/);
    if (mcpServerMatch) {
      const query = (mcpServerMatch[2] ?? "").trim();
      return mcpServers
        .filter((server) => !query || `${server.serverId} ${server.label}`.toLowerCase().includes(query))
        .slice(0, 8)
        .map((server) => ({
          key: `${mcpServerMatch[1]}-${server.serverId}`,
          command: `/mcp ${mcpServerMatch[1]} ${server.serverId}`,
          description: `${server.label} · ${server.status}`,
          applyValue: `/mcp ${mcpServerMatch[1]} ${server.serverId}`,
        }));
    }
    const mcpTemplateMatch = normalized.match(/^\/mcp\s+add-template\s+(.+)?$/);
    if (mcpTemplateMatch) {
      const query = (mcpTemplateMatch[1] ?? "").trim();
      return mcpTemplates
        .filter((template) => !query || `${template.templateId} ${template.label}`.toLowerCase().includes(query))
        .slice(0, 8)
        .map((template) => ({
          key: `template-${template.templateId}`,
          command: `/mcp add-template ${template.templateId}`,
          description: `${template.label}${template.installed ? " · installed" : ""}`,
          applyValue: `/mcp add-template ${template.templateId}`,
        }));
    }
    const query = trimmed.slice(1).toLowerCase();
    if (!query) {
      return commandCatalog.slice(0, 8).map((item) => ({
        key: item.usage,
        command: item.command,
        description: item.description,
        applyValue: item.command,
      }));
    }
    return commandCatalog
      .filter((item) => `${item.command} ${item.usage} ${item.description}`.toLowerCase().includes(query))
      .map((item) => ({
        key: item.usage,
        command: item.command,
        description: item.description,
        applyValue: item.command,
      }))
      .slice(0, 8);
  }, [commandCatalog, draft, installedSkills, mcpServers, mcpTemplates, providerOptions, selectedProviderId]);

  useEffect(() => setCommandIndex(0), [draft]);

  const selectedSessionProjectValue = selectedSession?.projectId ?? "none";
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
    setDockOpen(defaultDockOpenForMode(messageMode));
  }, [messageMode]);

  useEffect(() => {
    setCapabilitySuggestions(selectedTurn?.trace.capabilityUpgradeSuggestions ?? []);
    setSpecialistSuggestions(selectedTurn?.trace.specialistCandidateSuggestions ?? []);
  }, [selectedTurn, setCapabilitySuggestions, setSpecialistSuggestions]);

  const latestOrchestration = useMemo(
    () => selectedTurn?.trace.orchestration ?? thread?.turns.at(-1)?.trace.orchestration,
    [selectedTurn, thread],
  );
  const coworkItems = useMemo(
    () => deriveCoworkItems(messages, localNotices, latestOrchestration),
    [latestOrchestration, localNotices, messages],
  );
  const canSend =
    Boolean(resolveOutboundDraftContent(draft, pendingAttachments.length, editingTurnId ? "edit" : "send")) &&
    !sending &&
    !pendingApproval;

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
    if (typeof document === "undefined") {
      return;
    }
    const details = document.querySelector(".chat-v11-turn-card.selected .chat-v11-turn-details");
    if (details instanceof HTMLDetailsElement) {
      details.open = true;
      details.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

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

  const dockSectionStyle = useCallback(
    (sectionId: MissionControlDockSectionId) => ({
      order: Math.max(0, dockSectionOrder.indexOf(sectionId)),
    }),
    [dockSectionOrder],
  );

  const rootClassName = `chat-v11 mode-${messageMode}${lockSurface ? " shell-owned-surface" : ""}`;
  const workflowColumn = selectedSession
    ? isCoworkSurface
      ? <CoworkCanvasPanel items={coworkItems} orchestration={latestOrchestration ?? undefined} />
      : isCodeSurface
        ? (
          <CodeWorkbenchPanel
            selectedTurn={selectedTurn}
            projectName={selectedProject?.name ?? undefined}
            needsProjectBinding={codeModeNeedsProjectBinding}
          />
        )
        : undefined
    : undefined;

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
                  {selectedSession.scope === "external" ? "External writeback" : "Mission session"}
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

      <ChatSurfaceLayout
        mode={messageMode}
        dockOpen={selectedSession ? dockOpen : false}
        sessionRail={(
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
        )}
        workflowColumn={workflowColumn}
        primaryColumn={selectedSession ? (
          <>
            <MissionControlSurfaceHeader
              mode={messageMode}
              sessionTitle={selectedSessionLabel}
              summary={workspaceSummaryText}
              status={selectedTurn?.trace.status ?? null}
              providerLabel={selectedProviderLabel}
              modelLabel={selectedModelLabel}
              dockOpen={dockOpen}
              onToggleDock={handleToggleDock}
            />
            <article className={`panel gc-surface-card chat-v11-thread mode-${messageMode}`}>
              <ChatThreadShell
                mode={messageMode}
                loading={messagesLoading}
                thread={thread}
                selectedTurnId={selectedTurnId}
                notices={localNotices}
                followOutput={followThreadOutput}
                streamStatus={streamStatus as ChatStreamStatus}
                queuedCount={queuedOutbound.length}
                streamError={error}
                pendingApproval={pendingApproval}
                workspaceId={selectedSession.workspaceId}
                approvalPending={approvalPending}
                eventStreamStatus={eventStreamStatus}
                onBottomStateChange={setFollowThreadOutput}
                onSelectTurn={setSelectedTurnId}
                onSwitchBranch={(turnId) => void handleSelectBranchTurnAndSync(turnId)}
                onRetryTurn={(turnId) => void handleRetryTurn(turnId)}
                onEditTurn={handleBeginEditTurn}
                onApprovePending={(allowScope) => void handleApprovePending(allowScope)}
                onDenyPending={() => void handleDenyPending()}
                onRefresh={() => void loadSessionCoreState(selectedSession.sessionId, { includeThread: true })}
              />

              <ChatComposerShell
                mode={messageMode}
                isDragActive={isDragActive}
                queueItems={queuedOutbound.map((item) => ({
                  id: item.id,
                  action: item.action,
                  label: item.content.trim()
                    ? item.content.trim().slice(0, 96)
                    : `Turn ${item.targetTurnId?.slice(-6) ?? "queued"}`,
                  createdAt: item.createdAt,
                  paused: item.paused,
                }))}
                editingTurnId={editingTurnId}
                planningMode={planningMode}
                effectiveToolAutonomy={effectiveToolAutonomy}
                error={null}
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
                onRetryTurn={(turnId) => void handleRetryTurn(turnId)}
                onSetDeepMode={handleSetDeepMode}
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
            </article>
          </>
        ) : (
          <MissionControlEmptyState
            mode={messageMode}
            sessionCount={missionSessions.length + externalSessions.length}
            projectCount={projects?.items.length ?? 0}
            workspaceName={workspaceName}
            approvalsCount={approvalsCount}
            providerLabel={selectedProviderLabel}
            modelLabel={selectedModelLabel}
            onCreateSession={handleCreateCurrentModeSession}
            onOpenCowork={onOpenCowork}
            onOpenCode={onOpenCode}
            onOpenTasks={onOpenTasks}
            onOpenApprovals={onOpenApprovals}
          />
        )}
        contextDock={selectedSession ? (
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
        ) : <></>}
      />
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
