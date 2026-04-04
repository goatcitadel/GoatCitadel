import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  applyChatModePresetToPatch,
  CHAT_MODE_PRESETS,
  getChatTurnRecoveryActionLabel,
  getChatTurnRecoveryActionSummary,
  type ChatAttachmentRecord,
  type ChatCapabilityUpgradeSuggestion,
  type ChatDelegateRequest,
  type ChatDelegationSuggestionRecord,
  type ChatMessageRecord,
  type ChatMode,
  type ChatSessionBindingRecord,
  type ChatSessionPrefsPatch,
  type ChatSessionPrefsRecord,
  type ChatSessionRecord,
  type ChatSpecialistCandidateRecord,
  type ChatSpecialistCandidateSuggestionRecord,
  type ChatStreamChunk,
  type ChatThreadResponse,
  type LearnedMemoryItemRecord,
  type McpServerRecord,
  type McpServerTemplateRecord,
  type ProactivePolicy,
  type ProactiveRunRecord,
  type SkillListItem,
} from "@goatcitadel/contracts";
import {
  approveChatTool,
  archiveChatSession,
  archiveWorkspaceChatSessions,
  assignChatSessionProject,
  cancelChatTurn,
  createMcpServer,
  createChatProject,
  createChatSpecialistCandidate,
  deleteChatSession,
  createChatSession,
  denyChatTool,
  fetchChatCommandCatalog,
  fetchChatSpecialistCandidates,
  fetchChatThread,
  fetchChatProactiveRuns,
  fetchChatProactiveStatus,
  fetchChatProjects,
  fetchChatSessionBinding,
  fetchChatLearnedMemory,
  fetchChatSessionPrefs,
  fetchChatSessions,
  fetchMcpServers,
  fetchMcpTemplates,
  fetchSkills,
  fetchSettings,
  editChatTurn,
  installSkillImport,
  parseChatCommand,
  rebuildChatLearnedMemory,
  resumeChatTurnStream,
  retryChatTurn,
  pinChatSession,
  restoreChatSession,
  runChatDelegation,
  runChatResearch,
  sendAgentChatMessage,
  selectChatBranchTurn,
  triggerChatProactive,
  updateChatProactivePolicy,
  setChatSessionBinding,
  suggestChatDelegation,
  streamChatDelegation,
  streamAgentChatMessage,
  streamEditChatTurn,
  streamRetryChatTurn,
  unpinChatSession,
  updateChatSession,
  updateChatSpecialistCandidate,
  updateChatLearnedMemoryItem,
  updateChatSessionPrefs,
  updateSkillState,
  uploadChatAttachment,
  type ChatMessagesResponse,
  type ChatProjectsResponse,
  type ChatSessionsResponse,
  type RuntimeSettingsResponse,
} from "../api/client";
import { ActionButton } from "../components/ActionButton";
import { CardSkeleton } from "../components/CardSkeleton";
import { ChatPlanningPill } from "../components/chat/ChatPlanningPill";
import {
  isThreadMutatingStreamChunk,
  type PendingStreamTurnSeed,
  updateThreadFromStreamChunk,
} from "../components/chat/chat-thread-reducer";
import type { ChatThreadNotice } from "../components/chat/ChatThreadView";
import type { ChatStreamStatus } from "../components/chat/ChatStreamStatusBar";
import { ConfirmModal } from "../components/ConfirmModal";
import { ChatModeSwitch } from "../components/ChatModeSwitch";
import { ChatModelPicker, type ChatModelProviderOption } from "../components/ChatModelPicker";
import { ChatTraceCard } from "../components/ChatTraceCard";
import { CodeWorkbenchPanel } from "../components/CodeWorkbenchPanel";
import { CoworkCanvasPanel } from "../components/CoworkCanvasPanel";
import { DataToolbar } from "../components/DataToolbar";
import { FieldHelp } from "../components/FieldHelp";
import { HelpHint } from "../components/HelpHint";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatusChip } from "../components/StatusChip";
import { GCCombobox, GCSelect, GCSwitch } from "../components/ui";
import { useEventStreamStatus } from "../hooks/useEventStreamStatus";
import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import { pageCopy } from "../content/copy";
import {
  recordClientDiagnostic,
  setDevDiagnosticsActiveChatSession,
  setDevDiagnosticsLatestTraceSummary,
} from "../state/dev-diagnostics-store";
import {
  buildModelCommandSuggestions,
  type CommandSuggestionItem,
} from "./chat-command-suggestions";
import {
  isLikelyLocalProviderUrl,
  resolveProviderModelSelection,
} from "./chat/chat-page-helpers";
import { ChatComposerShell } from "./chat/ChatComposerShell";
import { ChatSessionSidebar } from "./chat/ChatSessionSidebar";
import { ChatThreadShell } from "./chat/ChatThreadShell";
import { MissionControlContextDock } from "./chat/MissionControlContextDock";
import { MissionControlEmptyState } from "./chat/MissionControlEmptyState";
import { MissionControlSurfaceHeader } from "./chat/MissionControlSurfaceHeader";
import { defaultDockOpenForMode } from "./chat/surface-config";
import {
  formatSessionLabel,
  looksMachineSessionLabel,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
  type MissionControlDockSectionId,
  useMissionControlSurfaceState,
} from "./chat/useMissionControlSurfaceState";
import { useChatSurfaceOrchestration, type OutboundQueueItem } from "./chat/useChatSurfaceOrchestration";
import "../styles/chat.css";
import "../styles/chat-surface.css";
import "../styles/chat-motion.css";

export {
  formatSessionLabel,
  looksMachineSessionLabel,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
} from "./chat/useMissionControlSurfaceState";

const STREAM_PREF_KEY = "goatcitadel.chat.agent.stream.enabled";

const CODE_DELEGATION_PRESETS = {
  implement: {
    label: "Implement",
    mode: "sequential" as const,
    roles: ["Architect", "Coder"],
    prefix: "Implement the requested change with a minimal, reviewable diff. ",
  },
  review: {
    label: "Review",
    mode: "sequential" as const,
    roles: ["Coder", "QA"],
    prefix: "Review the current implementation for bugs, regressions, and missing tests. ",
  },
  test: {
    label: "Test",
    mode: "sequential" as const,
    roles: ["Coder", "QA"],
    prefix: "Add or improve validation for the current implementation and report residual risk. ",
  },
  ship: {
    label: "Ship cycle",
    mode: "sequential" as const,
    roles: ["Architect", "Coder", "QA"],
    prefix: "Run an implement-review-test cycle for this task, then stitch the result into one operator-ready handoff. ",
  },
} as const;

interface PendingApprovalState {
  approvalId: string;
  toolName?: string;
  reason?: string;
}

interface CommandCatalogItem {
  command: string;
  usage: string;
  description: string;
}

interface ActiveChatStreamState {
  sessionId: string;
  streamToken: string;
  controller: AbortController;
  turnId?: string;
  lastEventId?: string;
  runId?: string;
}

interface FinalizedStreamMessageState {
  sessionId: string;
  placeholderId: string;
  messageId?: string;
  content: string;
}

type SessionControlPending =
  | null
  | "rename"
  | "pin"
  | "archive"
  | "delete"
  | "project"
  | "binding";

type ChatHistoryView = "active" | "archived";

function normalizeComparableAssistantContent(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function resolveOptimisticChatPrefs(
  current: ChatSessionPrefsRecord,
  patch: ChatSessionPrefsPatch,
): ChatSessionPrefsRecord {
  const normalizedPatch = applyChatModePresetToPatch(patch);
  const presetAutonomyBudget = CHAT_MODE_PRESETS[current.mode].defaultPrefs.autonomyBudget;
  const baseAutonomyBudget = current.autonomyBudget ?? presetAutonomyBudget;
  const providerChanged = normalizedPatch.providerId !== undefined
    && normalizedPatch.providerId !== current.providerId;
  return {
    ...current,
    mode: normalizedPatch.mode ?? current.mode,
    planningMode: normalizedPatch.planningMode ?? current.planningMode,
    providerId: normalizedPatch.providerId ?? current.providerId,
    model: normalizedPatch.model ?? (providerChanged ? undefined : current.model),
    webMode: normalizedPatch.webMode ?? current.webMode,
    memoryMode: normalizedPatch.memoryMode ?? current.memoryMode,
    thinkingLevel: normalizedPatch.thinkingLevel ?? current.thinkingLevel,
    toolAutonomy: normalizedPatch.toolAutonomy ?? current.toolAutonomy,
    visionFallbackModel: normalizedPatch.visionFallbackModel ?? current.visionFallbackModel,
    orchestrationEnabled: normalizedPatch.orchestrationEnabled ?? current.orchestrationEnabled,
    orchestrationIntensity: normalizedPatch.orchestrationIntensity ?? current.orchestrationIntensity,
    orchestrationVisibility: normalizedPatch.orchestrationVisibility ?? current.orchestrationVisibility,
    orchestrationProviderPreference: normalizedPatch.orchestrationProviderPreference ?? current.orchestrationProviderPreference,
    orchestrationReviewDepth: normalizedPatch.orchestrationReviewDepth ?? current.orchestrationReviewDepth,
    orchestrationParallelism: normalizedPatch.orchestrationParallelism ?? current.orchestrationParallelism,
    codeAutoApply: normalizedPatch.codeAutoApply ?? current.codeAutoApply,
    proactiveMode: normalizedPatch.proactiveMode ?? current.proactiveMode,
    autonomyBudget: normalizedPatch.autonomyBudget
      ? {
        ...baseAutonomyBudget,
        ...normalizedPatch.autonomyBudget,
      }
      : current.autonomyBudget ?? presetAutonomyBudget,
    retrievalMode: normalizedPatch.retrievalMode ?? current.retrievalMode,
    reflectionMode: normalizedPatch.reflectionMode ?? current.reflectionMode,
  };
}

export function shouldApplyFetchedMessagesAfterStream(
  currentMessages: ChatMessagesResponse["items"],
  fetchedMessages: ChatMessagesResponse["items"],
  finalizedStreamMessage: FinalizedStreamMessageState | null,
): boolean {
  if (!finalizedStreamMessage) {
    return true;
  }
  const currentPlaceholder = currentMessages.find((item) => (
    item.messageId === finalizedStreamMessage.messageId || item.messageId === finalizedStreamMessage.placeholderId
  ));
  if (!currentPlaceholder) {
    return true;
  }
  if (finalizedStreamMessage.messageId) {
    return fetchedMessages.some((item) => (
      item.role === "assistant" && item.messageId === finalizedStreamMessage.messageId
    ));
  }
  const finalizedContent = normalizeComparableAssistantContent(finalizedStreamMessage.content);
  if (!finalizedContent) {
    return true;
  }
  const fetchedHasEquivalentAssistant = fetchedMessages.some((item) => (
    item.role === "assistant" && normalizeComparableAssistantContent(item.content) === finalizedContent
  ));
  return fetchedHasEquivalentAssistant;
}

function toTitleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeSpecialistFingerprint(input: { title?: string; role?: string }): string {
  const normalize = (value?: string) => (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${normalize(input.role)}:${normalize(input.title)}`;
}

function flattenThreadMessages(thread: ChatThreadResponse | null): ChatMessagesResponse["items"] {
  if (!thread) {
    return [];
  }
  return thread.turns.flatMap((turn) => {
    const items: ChatMessageRecord[] = [turn.userMessage];
    if (turn.assistantMessage) {
      items.push(turn.assistantMessage);
    }
    return items;
  });
}

function createDraftStorageKey(workspaceId: string, sessionId: string | null): string {
  return `goatcitadel.chat.draft.${workspaceId}.${sessionId ?? "new"}`;
}

function createAttachmentStorageKey(workspaceId: string, sessionId: string | null): string {
  return `goatcitadel.chat.attachments.${workspaceId}.${sessionId ?? "new"}`;
}

function createQueueStorageKey(workspaceId: string, sessionId: string | null): string {
  return `goatcitadel.chat.queue.${workspaceId}.${sessionId ?? "new"}`;
}

function clearChatSessionLocalState(workspaceId: string, sessionId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(createDraftStorageKey(workspaceId, sessionId));
  window.localStorage.removeItem(createAttachmentStorageKey(workspaceId, sessionId));
  window.localStorage.removeItem(createQueueStorageKey(workspaceId, sessionId));
}

function useDebouncedLocalStoragePersistence(key: string, value: string, delayMs = 400): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWriteRef = useRef<{ key: string; value: string } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (pendingWriteRef.current && pendingWriteRef.current.key !== key) {
      window.localStorage.setItem(pendingWriteRef.current.key, pendingWriteRef.current.value);
      pendingWriteRef.current = null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
    pendingWriteRef.current = { key, value };
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      const pending = pendingWriteRef.current;
      if (pending) {
        window.localStorage.setItem(pending.key, pending.value);
        pendingWriteRef.current = null;
      }
      timerRef.current = null;
    }, delayMs);
  }, [delayMs, key, value]);

  useEffect(() => () => {
    if (typeof window === "undefined") {
      return;
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingWriteRef.current) {
      window.localStorage.setItem(pendingWriteRef.current.key, pendingWriteRef.current.value);
      pendingWriteRef.current = null;
    }
  }, []);
}

export function ChatPage({
  workspaceId = "default",
  surface,
  lockSurface = false,
}: {
  workspaceId?: string;
  surface?: ChatMode;
  lockSurface?: boolean;
}) {
  const [projects, setProjects] = useState<ChatProjectsResponse | null>(null);
  const [sessions, setSessions] = useState<ChatSessionsResponse | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("all");
  const [historyView, setHistoryView] = useState<ChatHistoryView>("active");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [thread, setThread] = useState<ChatThreadResponse | null>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<ChatSessionPrefsRecord | null>(null);
  const [binding, setBinding] = useState<ChatSessionBindingRecord | null>(null);
  const [settings, setSettings] = useState<RuntimeSettingsResponse | null>(null);
  const [commandCatalog, setCommandCatalog] = useState<CommandCatalogItem[]>([]);
  const [capabilitySuggestions, setCapabilitySuggestions] = useState<ChatCapabilityUpgradeSuggestion[]>([]);
  const [specialistSuggestions, setSpecialistSuggestions] = useState<ChatSpecialistCandidateSuggestionRecord[]>([]);
  const [specialistCandidates, setSpecialistCandidates] = useState<ChatSpecialistCandidateRecord[]>([]);
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalState | null>(null);
  const [proactiveStatus, setProactiveStatus] = useState<ProactivePolicy | null>(null);
  const [proactiveRuns, setProactiveRuns] = useState<ProactiveRunRecord[]>([]);
  const [learnedMemory, setLearnedMemory] = useState<LearnedMemoryItemRecord[]>([]);
  const [delegationSuggestion, setDelegationSuggestion] = useState<ChatDelegationSuggestionRecord | null>(null);
  const [localNotices, setLocalNotices] = useState<ChatThreadNotice[]>([]);
  const [installedSkills, setInstalledSkills] = useState<SkillListItem[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([]);
  const [mcpTemplates, setMcpTemplates] = useState<Array<McpServerTemplateRecord & { installed: boolean }>>([]);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [secondaryLoading, setSecondaryLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [creatingSessionMode, setCreatingSessionMode] = useState<ChatMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [streamEnabled, setStreamEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const raw = window.localStorage.getItem(STREAM_PREF_KEY);
    return raw === null ? true : raw === "true";
  });
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("chat/default");
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [sessionControlPending, setSessionControlPending] = useState<SessionControlPending>(null);
  const [archiveWorkspacePending, setArchiveWorkspacePending] = useState(false);
  const [archiveWorkspaceConfirmOpen, setArchiveWorkspaceConfirmOpen] = useState(false);
  const [integrationConnectionId, setIntegrationConnectionId] = useState("");
  const [integrationTarget, setIntegrationTarget] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [approvalPending, setApprovalPending] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [followThreadOutput, setFollowThreadOutput] = useState(true);
  const [dockOpen, setDockOpen] = useState<boolean>(() => defaultDockOpenForMode(surface ?? "chat"));
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const dragDepthRef = useRef(0);
  const initializedRef = useRef(false);
  const lastLoadedSessionIdRef = useRef<string | null>(null);
  const messageMutationVersionRef = useRef(0);
  const lastLocalPrefMutationAtRef = useRef(0);
  const prefMutationSequenceRef = useRef(0);
  const latestMessagesRef = useRef<ChatMessagesResponse["items"]>([]);
  const selectedSessionIdRef = useRef<string | null>(null);
  const loadCoreGenerationRef = useRef(0);
  const loadSecondaryGenerationRef = useRef(0);
  const finalizedStreamMessageRef = useRef<FinalizedStreamMessageState | null>(null);
  const streamReconcileTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingRef = useRef(false);
  const prefsRef = useRef<ChatSessionPrefsRecord | null>(null);
  const threadRef = useRef<ChatThreadResponse | null>(null);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);
  const lastShellSurfaceSyncKeyRef = useRef<string | null>(null);
  const executeOutboundItemRef = useRef<(item: OutboundQueueItem) => Promise<void>>(async () => undefined);
  const tryBeginOutboundExecutionRef = useRef<() => boolean>(() => false);
  const pushLocalNoticeRef = useRef<(message: string, tone?: ChatThreadNotice["tone"]) => void>(() => undefined);
  const loadSessionCoreStateRef = useRef<(
    sessionId: string,
    options?: { background?: boolean; includeThread?: boolean },
  ) => Promise<void>>(async () => undefined);
  const {
    config: runtimeLlmConfig,
    providers: runtimeProviderCatalog,
    getCachedModels,
    loadModelsForProvider,
  } = useProviderModelCatalog("chat");
  const eventStreamStatus = useEventStreamStatus();
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
    setPendingApproval,
    setError,
    loadSessionCoreStateRef,
    abortActiveChatStream,
  });

  const loadSidebar = useCallback(async (nextHistoryView: ChatHistoryView = historyView) => {
    recordClientDiagnostic({
      level: "debug",
      category: "chat",
      event: "sidebar.load",
      message: "Refreshing chat sidebar data",
      context: { workspaceId, historyView: nextHistoryView },
    });
    const [nextProjects, nextSessions] = await Promise.all([
      fetchChatProjects("all", 250, workspaceId),
      fetchChatSessions({ scope: "all", view: nextHistoryView, limit: 250, workspaceId }),
    ]);
    setProjects(nextProjects);
    setSessions(nextSessions);
    setSelectedSessionId((current) => {
      if (!current) {
        return nextSessions.items[0]?.sessionId ?? null;
      }
      return nextSessions.items.some((item) => item.sessionId === current)
        ? current
        : (nextSessions.items[0]?.sessionId ?? null);
    });
  }, [historyView, workspaceId]);

  const loadRuntimeCatalog = useCallback(async () => {
    const [runtimeSettings, commands, skills, servers, templates] = await Promise.all([
      fetchSettings(),
      fetchChatCommandCatalog(),
      fetchSkills(),
      fetchMcpServers(),
      fetchMcpTemplates(),
    ]);
    setSettings(runtimeSettings);
    setCommandCatalog(commands.items);
    setInstalledSkills(skills.items);
    setMcpServers(servers.items);
    setMcpTemplates(templates.items);
  }, []);

  useEffect(() => {
    if (!runtimeLlmConfig) {
      return;
    }
    setSettings((current) => current ? { ...current, llm: runtimeLlmConfig } : current);
  }, [runtimeLlmConfig]);

  const pushLocalNotice = useCallback((
    content: string,
    tone: ChatThreadNotice["tone"] = "neutral",
  ) => {
    setLocalNotices((current) => [{
      id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      tone,
      timestamp: new Date().toISOString(),
    }, ...current].slice(0, 12));
  }, []);

  useEffect(() => {
    pushLocalNoticeRef.current = pushLocalNotice;
  }, [pushLocalNotice]);

  const commitThreadUpdate = useCallback((
    updater: ChatThreadResponse | null | ((current: ChatThreadResponse | null) => ChatThreadResponse | null),
  ) => {
    setThread((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      if (next !== current) {
        messageMutationVersionRef.current += 1;
      }
      return next;
    });
  }, []);

  const applyFetchedThread = useCallback((
    nextThread: ChatThreadResponse,
    requestVersion: number | null,
  ) => {
    recordClientDiagnostic({
      level: "debug",
      category: "chat",
      event: "thread.reconcile",
      message: "Applying fetched thread state",
      sessionId: nextThread.sessionId,
      context: {
        requestVersion,
        turnCount: nextThread.turns.length,
      },
    });
    if (requestVersion !== null && requestVersion !== messageMutationVersionRef.current) {
      return false;
    }
    const items = flattenThreadMessages(nextThread);
    if (!shouldApplyFetchedMessagesAfterStream(latestMessagesRef.current, items, finalizedStreamMessageRef.current)) {
      return false;
    }
    const activeStream = activeStreamRef.current;
    if (activeStream?.sessionId === nextThread.sessionId && activeStream.turnId) {
      const includesActiveTurn = nextThread.turns.some((turn) => turn.turnId === activeStream.turnId);
      if (!includesActiveTurn) {
        return false;
      }
    }
    if (finalizedStreamMessageRef.current) {
      finalizedStreamMessageRef.current = null;
    }
    commitThreadUpdate(nextThread);
    return true;
  }, [commitThreadUpdate]);

  const loadSessionCoreState = useCallback(async (
    sessionId: string,
    options: {
      background?: boolean;
      includeThread?: boolean;
    } = {},
  ) => {
    const generation = ++loadCoreGenerationRef.current;
    const background = options.background ?? false;
    const includeThread = options.includeThread ?? true;
    const messageVersionAtStart = includeThread ? messageMutationVersionRef.current : null;
    if (!background) {
      setMessagesLoading(true);
    }
    try {
      const [nextThread, nextBinding, nextPrefs] = await Promise.all([
        includeThread ? fetchChatThread(sessionId) : Promise.resolve(undefined),
        fetchChatSessionBinding(sessionId),
        fetchChatSessionPrefs(sessionId),
      ]);
      if (generation !== loadCoreGenerationRef.current) return; // stale response
      if (nextThread) {
        applyFetchedThread(nextThread, messageVersionAtStart);
      }
      setBinding(nextBinding.item);
      setPrefs(nextPrefs);
    } finally {
      if (!background) {
        setMessagesLoading(false);
      }
    }
  }, [applyFetchedThread]);

  useEffect(() => {
    loadSessionCoreStateRef.current = loadSessionCoreState;
  }, [loadSessionCoreState]);

  const scheduleStreamMessageReconciliation = useCallback((sessionId: string) => {
    if (streamReconcileTimeoutRef.current) {
      clearTimeout(streamReconcileTimeoutRef.current);
    }
    const versionAtSchedule = messageMutationVersionRef.current;
    streamReconcileTimeoutRef.current = setTimeout(() => {
      streamReconcileTimeoutRef.current = null;
      if (selectedSessionIdRef.current !== sessionId) {
        return;
      }
      if (messageMutationVersionRef.current !== versionAtSchedule) {
        // A new stream event arrived during the reconciliation window.
        // Re-schedule instead of applying potentially stale data.
        scheduleStreamMessageReconciliation(sessionId);
        return;
      }
      void loadSessionCoreState(sessionId, {
        background: true,
        includeThread: true,
      }).catch((err: Error) => setError(err.message));
    }, 400);
  }, [loadSessionCoreState]);

  const loadSessionSecondaryState = useCallback(async (
    sessionId: string,
    options: {
      background?: boolean;
    } = {},
  ) => {
    const generation = ++loadSecondaryGenerationRef.current;
    const background = options.background ?? false;
    if (!background) {
      setSecondaryLoading(true);
    }
    try {
      const [nextProactiveStatus, nextProactiveRuns, nextMemory, nextSpecialists] = await Promise.all([
        fetchChatProactiveStatus(sessionId),
        fetchChatProactiveRuns(sessionId, 30),
        fetchChatLearnedMemory(sessionId, 80),
        fetchChatSpecialistCandidates(sessionId, 80),
      ]);
      if (generation !== loadSecondaryGenerationRef.current) return; // stale response
      setProactiveStatus(nextProactiveStatus.policy);
      setProactiveRuns(nextProactiveRuns.items);
      setLearnedMemory(nextMemory.items);
      setSpecialistCandidates(nextSpecialists.items);
    } finally {
      if (!background) {
        setSecondaryLoading(false);
      }
    }
  }, []);

  const loadSessionState = useCallback(async (
    sessionId: string,
    options: {
      background?: boolean;
      includeThread?: boolean;
      deferSecondary?: boolean;
    } = {},
  ) => {
    const background = options.background ?? false;
    const includeThread = options.includeThread ?? true;
    const deferSecondary = options.deferSecondary ?? false;
    await loadSessionCoreState(sessionId, { background, includeThread });
    if (deferSecondary) {
      void loadSessionSecondaryState(sessionId, { background: false }).catch((err: Error) => setError(err.message));
      return;
    }
    await loadSessionSecondaryState(sessionId, { background });
  }, [loadSessionCoreState, loadSessionSecondaryState]);

  const refreshViewState = useCallback(async (
    options: {
      refreshSidebar?: boolean;
      refreshSession?: "none" | "light" | "full";
    } = {},
  ) => {
    if (!initializedRef.current) {
      return;
    }
    const shouldRefreshSidebar = options.refreshSidebar ?? true;
    const refreshSession = options.refreshSession ?? "light";
    if (!shouldRefreshSidebar && refreshSession === "none") {
      return;
    }
    setIsRefreshing(true);
    try {
      if (shouldRefreshSidebar) {
        await loadSidebar();
      }
      if (selectedSessionId && refreshSession !== "none") {
        if (refreshSession === "full") {
          await loadSessionState(selectedSessionId, {
            background: true,
            includeThread: true,
          });
        } else {
          await loadSessionSecondaryState(selectedSessionId, {
            background: true,
          });
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsRefreshing(false);
    }
  }, [loadSessionSecondaryState, loadSessionState, loadSidebar, selectedSessionId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([loadSidebar(), loadRuntimeCatalog()])
      .then(() => !cancelled && setError(null))
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          initializedRef.current = true;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadRuntimeCatalog, loadSidebar]);

  useRefreshSubscription(
    "chat",
    async (signal) => {
      const now = Date.now();
      const haystack = `${signal.reason} ${signal.eventType ?? ""} ${signal.source ?? ""}`.toLowerCase();
      if (signal.eventType === "fallback_poll") {
        await refreshViewState({
          refreshSidebar: true,
          refreshSession: "light",
        });
        return;
      }
      const localPrefEcho = now - lastLocalPrefMutationAtRef.current < 2500
        && /\b(pref|policy|session|proactive|retrieval|reflection|mode)\b/.test(haystack);
      const mentionsMessages = /\b(message|thread|turn|assistant|user|tool|trace|approval|chat_thread_updated)\b/.test(haystack);
      const affectsSidebar = /\b(project|archive|restore|pin|unpin|binding|workspace|external|session_created|session_deleted|title|rename|chat_session_title_updated|chat_session_updated)\b/.test(haystack);
      const mentionsSessionState = /\b(pref|policy|proactive|retrieval|reflection|mode|learned_memory)\b/.test(haystack);
      const refreshSession = localPrefEcho
        ? "none"
        : (mentionsMessages ? "full" : (mentionsSessionState ? "light" : "none"));
      await refreshViewState({
        refreshSidebar: affectsSidebar,
        refreshSession,
      });
    },
    {
      enabled: !loading,
      coalesceMs: 800,
      staleMs: 20000,
      pollIntervalMs: 15000,
    },
  );

  useEffect(() => {
    setDevDiagnosticsActiveChatSession(selectedSessionId ?? undefined);
    if (!selectedSessionId) {
      abortActiveChatStream(activeStreamRef.current);
      activeStreamRef.current = null;
      setThread(null);
      setSelectedTurnId(null);
      setPrefs(null);
      setBinding(null);
      setProactiveStatus(null);
      setProactiveRuns([]);
      setLearnedMemory([]);
      setSecondaryLoading(false);
      setDelegationSuggestion(null);
      setLocalNotices([]);
      setPendingAttachments([]);
      finalizedStreamMessageRef.current = null;
      if (streamReconcileTimeoutRef.current) {
        clearTimeout(streamReconcileTimeoutRef.current);
        streamReconcileTimeoutRef.current = null;
      }
      lastLoadedSessionIdRef.current = null;
      return;
    }
    if (lastLoadedSessionIdRef.current !== selectedSessionId) {
      const hadActiveStream = activeStreamRef.current !== null;
      abortActiveChatStream(activeStreamRef.current);
      activeStreamRef.current = null;
      if (hadActiveStream) {
        pushLocalNotice("Stream interrupted - switched sessions. The previous turn may still be processing on the server.", "warning");
      }
      setPendingAttachments([]);
      setThread(null);
      setSelectedTurnId(null);
      setEditingTurnId(null);
      setLocalNotices([]);
      setPendingApproval(null);
      finalizedStreamMessageRef.current = null;
      if (streamReconcileTimeoutRef.current) {
        clearTimeout(streamReconcileTimeoutRef.current);
        streamReconcileTimeoutRef.current = null;
      }
      lastLoadedSessionIdRef.current = selectedSessionId;
    }
    setDelegationSuggestion(null);
    setCapabilitySuggestions([]);
    setPendingApproval(null);
    void loadSessionState(selectedSessionId, {
      background: false,
      includeThread: true,
      deferSecondary: true,
    }).catch((err: Error) => setError(err.message));
  }, [loadSessionState, selectedSessionId]);

  useEffect(() => {
    setFollowThreadOutput(true);
  }, [selectedSessionId]);

  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  useEffect(() => {
    threadRef.current = thread;
    if (!thread) {
      setDevDiagnosticsLatestTraceSummary(undefined);
      return;
    }
    const selectedTurn = thread.turns.find((turn) => turn.turnId === (thread.selectedTurnId ?? thread.activeLeafTurnId));
    setDevDiagnosticsLatestTraceSummary(selectedTurn?.trace
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
      });
  }, [thread]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  const messages = useMemo(() => flattenThreadMessages(thread), [thread]);

  useEffect(() => {
    latestMessagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const draftRaw = window.localStorage.getItem(createDraftStorageKey(workspaceId, selectedSessionId));
      setDraft(draftRaw ?? "");
      const attachmentsRaw = window.localStorage.getItem(createAttachmentStorageKey(workspaceId, selectedSessionId));
      setPendingAttachments(attachmentsRaw ? JSON.parse(attachmentsRaw) as ChatAttachmentRecord[] : []);
      const queueRaw = window.localStorage.getItem(createQueueStorageKey(workspaceId, selectedSessionId));
      setQueuedOutbound(queueRaw
        ? (JSON.parse(queueRaw) as OutboundQueueItem[]).map((item) => ({ ...item, paused: true }))
        : []);
    } catch {
      setDraft("");
      setPendingAttachments([]);
      setQueuedOutbound([]);
    }
  }, [selectedSessionId, workspaceId]);

  useDebouncedLocalStoragePersistence(createDraftStorageKey(workspaceId, selectedSessionId), draft);
  useDebouncedLocalStoragePersistence(
    createAttachmentStorageKey(workspaceId, selectedSessionId),
    JSON.stringify(pendingAttachments),
  );
  useDebouncedLocalStoragePersistence(
    createQueueStorageKey(workspaceId, selectedSessionId),
    JSON.stringify(queuedOutbound),
  );

  useEffect(() => () => {
    abortActiveChatStream(activeStreamRef.current);
    activeStreamRef.current = null;
    if (streamReconcileTimeoutRef.current) {
      clearTimeout(streamReconcileTimeoutRef.current);
      streamReconcileTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STREAM_PREF_KEY, String(streamEnabled));
  }, [streamEnabled]);

  const selectedSession = useMemo(
    () => sessions?.items.find((item) => item.sessionId === selectedSessionId) ?? null,
    [selectedSessionId, sessions?.items],
  );
  const selectedProject = useMemo(
    () => (projects?.items ?? []).find((item) => item.projectId === selectedSession?.projectId) ?? null,
    [projects?.items, selectedSession?.projectId],
  );

  useEffect(() => {
    setSelectedTurnId((current) => {
      if (!thread?.turns.length) {
        return null;
      }
      if (current && thread.turns.some((turn) => turn.turnId === current)) {
        return current;
      }
      return thread.selectedTurnId ?? thread.activeLeafTurnId ?? thread.turns.at(-1)?.turnId ?? null;
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
      const haystack = [item.title, item.sessionKey, item.projectName, item.channel, item.account].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [search, selectedProjectId, sessions?.items]);

  const missionSessions = useMemo(
    () => visibleSessions.filter((item) => item.scope === "mission"),
    [visibleSessions],
  );

  const workspaceMissionSessionCount = useMemo(
    () => historyView === "active"
      ? (sessions?.items ?? []).filter((item) => item.scope === "mission").length
      : 0,
    [historyView, sessions?.items],
  );

  const externalSessions = useMemo(
    () => visibleSessions.filter((item) => item.scope === "external"),
    [visibleSessions],
  );
  const boundMissionSessionCount = useMemo(
    () => (sessions?.items ?? []).filter((item) => item.scope === "mission" && Boolean(item.projectId)).length,
    [sessions?.items],
  );
  const visibleSessionLabelById = useMemo(() => new Map(
    visibleSessions.map((session) => [session.sessionId, formatSessionLabel(session)]),
  ), [visibleSessions]);

  const providerOptions = useMemo<ChatModelProviderOption[]>(() => {
    const activeProviderId = runtimeLlmConfig?.activeProviderId ?? settings?.llm.activeProviderId;
    const activeModel = runtimeLlmConfig?.activeModel ?? settings?.llm.activeModel;
    return runtimeProviderCatalog.map((provider) => ({
      providerId: provider.providerId,
      label: provider.label,
      defaultModel: provider.defaultModel,
      disabled: !provider.hasApiKey && !isLikelyLocalProviderUrl(provider.baseUrl),
      availabilityLabel: !provider.hasApiKey && !isLikelyLocalProviderUrl(provider.baseUrl)
        ? `${provider.label} · setup required`
        : undefined,
      availabilityHint: !provider.hasApiKey && !isLikelyLocalProviderUrl(provider.baseUrl)
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
    const preferredProviderId = prefs?.providerId ?? runtimeLlmConfig?.activeProviderId ?? settings?.llm.activeProviderId;
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

  useEffect(() => {
    if (!selectedProviderId) {
      return;
    }
    void loadModelsForProvider(selectedProviderId);
  }, [loadModelsForProvider, selectedProviderId]);

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
  const latestOrchestration = useMemo(
    () => selectedTurn?.trace.orchestration ?? thread?.turns.at(-1)?.trace.orchestration,
    [selectedTurn, thread],
  );
  useEffect(() => {
    setCapabilitySuggestions(selectedTurn?.trace.capabilityUpgradeSuggestions ?? []);
    setSpecialistSuggestions(selectedTurn?.trace.specialistCandidateSuggestions ?? []);
  }, [selectedTurn]);
  const coworkItems = useMemo(
    () => deriveCoworkItems(messages, localNotices, latestOrchestration),
    [latestOrchestration, localNotices, messages],
  );
  const canSend = Boolean(draft.trim()) && !sending;

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
  }, [lockSurface, prefs?.mode, selectedSessionId, surface]);

  const streamStatus: ChatStreamStatus = useMemo(() => {
    if (error) return "error";
    if (sending && activeStreamRef.current) return "streaming";
    if (sending) return "connecting";
    if (queuedOutbound.some((item) => !item.paused)) return "queued";
    return "idle";
  }, [error, sending, queuedOutbound]);

  const tryBeginOutboundExecution = useCallback(() => {
    if (sendingRef.current) {
      return false;
    }
    sendingRef.current = true;
    setSending(true);
    return true;
  }, []);

  useEffect(() => {
    tryBeginOutboundExecutionRef.current = tryBeginOutboundExecution;
  }, [tryBeginOutboundExecution]);

  const finishOutboundExecution = useCallback(() => {
    sendingRef.current = false;
    setSending(false);
  }, []);

  const handleCreateSession = useCallback(async (mode: ChatMode) => {
    const nextHistoryView: ChatHistoryView = historyView === "archived" ? "active" : historyView;
    setCreatingSessionMode(mode);
    setError(null);
    try {
      const created = await createChatSession(
        selectedProjectId !== "all" && selectedProjectId !== "none"
          ? { workspaceId, projectId: selectedProjectId, mode }
          : { workspaceId, mode },
      );
      if (nextHistoryView !== historyView) {
        setHistoryView(nextHistoryView);
      }
      await loadSidebar(nextHistoryView);
      setSelectedSessionId(created.sessionId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreatingSessionMode(null);
    }
  }, [historyView, loadSidebar, selectedProjectId, workspaceId]);

  const ensureSession = useCallback(async (): Promise<ChatSessionRecord> => {
    if (selectedSession) return selectedSession;
    const nextHistoryView: ChatHistoryView = historyView === "archived" ? "active" : historyView;
    const created = await createChatSession(
      selectedProjectId !== "all" && selectedProjectId !== "none"
        ? { workspaceId, projectId: selectedProjectId, mode: "chat" }
        : { workspaceId, mode: "chat" },
    );
    if (nextHistoryView !== historyView) {
      setHistoryView(nextHistoryView);
    }
    await loadSidebar(nextHistoryView);
    setSelectedSessionId(created.sessionId);
    return created;
  }, [historyView, loadSidebar, selectedProjectId, selectedSession, workspaceId]);

  const handleArchiveWorkspaceMissionChats = useCallback(async () => {
    setArchiveWorkspacePending(true);
    setError(null);
    try {
      const result = await archiveWorkspaceChatSessions({
        workspaceId,
        scope: "mission",
      });
      const summary = `Archived ${result.archivedCount} mission chats in this workspace. Skipped ${result.skippedCount}. Failed ${result.failedCount}.`;
      pushLocalNotice(summary, result.failedCount > 0 ? "warning" : result.archivedCount > 0 ? "success" : "neutral");
      setHistoryView("active");
      await loadSidebar("active");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setArchiveWorkspacePending(false);
    }
  }, [loadSidebar, pushLocalNotice, workspaceId]);

  const uploadAttachments = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setSending(true);
    try {
      const session = await ensureSession();
      const uploaded: ChatAttachmentRecord[] = [];
      for (const file of files) {
        uploaded.push(await uploadChatAttachment({
          sessionId: session.sessionId,
          projectId: session.projectId,
          file,
        }));
      }
      setPendingAttachments((current) => [...current, ...uploaded]);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [ensureSession]);

  const handleRunQuickResearch = useCallback(async () => {
    if (sending) return;
    const session = await ensureSession();
    const query = draft.trim() || messages.filter((item) => item.role === "user").at(-1)?.content || "";
    if (!query) {
      setError("Enter a query first or send a user message before research.");
      return;
    }
    setSending(true);
    try {
      const summary = await runChatResearch(session.sessionId, {
        query,
        mode: prefs?.webMode === "deep" ? "deep" : "quick",
        providerId: prefs?.providerId,
        model: prefs?.model,
      });
      pushLocalNotice(`Research summary:\n${summary.summary}\n\nSources: ${summary.sources.length}`, "success");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [draft, ensureSession, messages, prefs?.model, prefs?.providerId, prefs?.webMode, pushLocalNotice, sending]);

  const handleProactivePolicyPatch = useCallback(async (
    patch: {
      proactiveMode?: "off" | "suggest" | "auto_safe" | "auto_full";
      autonomyBudget?: {
        maxActionsPerHour?: number;
        maxActionsPerTurn?: number;
        cooldownSeconds?: number;
      };
      retrievalMode?: "standard" | "layered";
      reflectionMode?: "off" | "on";
    },
  ) => {
    if (!selectedSession) return;
    lastLocalPrefMutationAtRef.current = Date.now();
    try {
      const updated = await updateChatProactivePolicy(selectedSession.sessionId, patch);
      setProactiveStatus(updated);
      setPrefs((current) => current ? {
        ...current,
        proactiveMode: updated.mode,
        autonomyBudget: updated.autonomyBudget,
        retrievalMode: updated.retrievalMode,
        reflectionMode: updated.reflectionMode,
      } : current);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selectedSession]);

  const handleTriggerProactive = useCallback(async () => {
    if (!selectedSession || sending) return;
    setSending(true);
    try {
      const run = await triggerChatProactive(selectedSession.sessionId, {
        source: "manual",
        reason: "Operator triggered from chat workspace.",
      });
      setProactiveRuns((current) => [run, ...current].slice(0, 30));
      pushLocalNotice(`Proactive run ${run.status}: ${run.reasoningSummary}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [pushLocalNotice, selectedSession, sending]);

  const handleSuggestDelegation = useCallback(async () => {
    if (!selectedSession || sending) return;
    const objective = draft.trim() || messages.filter((item) => item.role === "user").at(-1)?.content?.trim() || "";
    if (!objective) {
      setError("Write a request first so I can suggest a delegation plan.");
      return;
    }
    setSending(true);
    try {
      const suggested = await suggestChatDelegation(selectedSession.sessionId, { objective });
      setDelegationSuggestion(suggested.suggestion);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [draft, messages, selectedSession, sending]);

  const runDelegationAction = useCallback(async (
    sessionId: string,
    request: ChatDelegateRequest,
    label: string,
  ) => {
    if (!streamEnabled) {
      return runChatDelegation(sessionId, request);
    }

    let finalResult: Awaited<ReturnType<typeof runChatDelegation>> | null = null;
    await streamChatDelegation(sessionId, request, (chunk) => {
      if (chunk.type === "status" && chunk.message) {
        pushLocalNotice(chunk.message);
        return;
      }
      if (chunk.type === "step" && chunk.step) {
        if (chunk.step.status === "completed") {
          pushLocalNotice(`${toTitleCase(chunk.step.role)} completed ${label.toLowerCase()} step ${chunk.step.index + 1}/${request.roles.length}.`);
        } else if (chunk.step.status === "failed") {
          pushLocalNotice(
            `${toTitleCase(chunk.step.role)} failed ${label.toLowerCase()} step ${chunk.step.index + 1}/${request.roles.length}: ${chunk.step.error ?? "Unknown failure."}`,
            "warning",
          );
        }
        return;
      }
      if (chunk.type === "done" && chunk.result) {
        finalResult = chunk.result;
      }
    });

    if (!finalResult) {
      throw new Error(`${label} finished without a final result payload.`);
    }
    return finalResult;
  }, [pushLocalNotice, streamEnabled]);

  const handleAcceptDelegation = useCallback(async () => {
    if (!selectedSession || !delegationSuggestion || sending) return;
    setSending(true);
    try {
      const accepted = await runDelegationAction(selectedSession.sessionId, {
        objective: delegationSuggestion.objective,
        roles: delegationSuggestion.roles,
        mode: delegationSuggestion.mode,
        providerId: prefs?.providerId,
        model: prefs?.model,
      }, "Delegation");
      pushLocalNotice(`Delegation completed:\n${accepted.stitchedOutput}`, "success");
      setDelegationSuggestion(null);
      await loadSidebar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [delegationSuggestion, loadSidebar, prefs?.model, prefs?.providerId, pushLocalNotice, runDelegationAction, selectedSession, sending]);

  const handleRunCodeDelegation = useCallback(async (
    presetKey: keyof typeof CODE_DELEGATION_PRESETS,
  ) => {
    if (!selectedSession || sending) {
      return;
    }
    if (codeModeNeedsProjectBinding) {
      setError("Bind this Code session to a project before running delegated implementation work.");
      return;
    }
    const baseObjective = draft.trim()
      || messages.filter((item) => item.role === "user").at(-1)?.content?.trim()
      || selectedSession.title?.trim()
      || "";
    if (!baseObjective) {
      setError("Write a coding objective first so GoatCitadel has something concrete to implement or review.");
      return;
    }
    const preset = CODE_DELEGATION_PRESETS[presetKey];
    setSending(true);
    try {
      const result = await runDelegationAction(selectedSession.sessionId, {
        objective: `${preset.prefix}${baseObjective}`,
        roles: [...preset.roles],
        mode: preset.mode,
        providerId: prefs?.providerId,
        model: prefs?.model,
      }, preset.label);
      pushLocalNotice(`${preset.label} completed:\n${result.stitchedOutput}`, "success");
      setDelegationSuggestion(null);
      await loadSidebar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [
    codeModeNeedsProjectBinding,
    draft,
    loadSidebar,
    messages,
    prefs?.model,
    prefs?.providerId,
    pushLocalNotice,
    runDelegationAction,
    selectedSession,
    sending,
  ]);

  const primeComposer = useCallback((prompt: string) => {
    setDraft((current) => current.trim() ? current : prompt);
    window.setTimeout(() => {
      composerRef.current?.focus();
    }, 0);
  }, []);

  const handleMemoryStatusUpdate = useCallback(async (
    itemId: string,
    status: "active" | "superseded" | "conflict" | "disabled",
  ) => {
    if (!selectedSession) return;
    try {
      const updated = await updateChatLearnedMemoryItem(selectedSession.sessionId, itemId, { status });
      setLearnedMemory((current) => current.map((item) => item.itemId === itemId ? updated : item));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selectedSession]);

  const handleRebuildLearnedMemory = useCallback(async () => {
    if (!selectedSession || sending) return;
    setSending(true);
    try {
      const rebuilt = await rebuildChatLearnedMemory(selectedSession.sessionId);
      setLearnedMemory(rebuilt.items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [selectedSession, sending]);

  const handleCreateSpecialistDraft = useCallback(async (
    suggestion: ChatSpecialistCandidateSuggestionRecord,
  ) => {
    if (!selectedSession || sending) {
      return;
    }
    setSending(true);
    try {
      const created = await createChatSpecialistCandidate(selectedSession.sessionId, {
        turnId: selectedTurn?.turnId,
        suggestion,
      });
      setSpecialistCandidates((current) => {
        const withoutCurrent = current.filter((item) => item.candidateId !== created.candidateId);
        return [created, ...withoutCurrent];
      });
      setSpecialistSuggestions((current) => current.filter((item) => (
        normalizeSpecialistFingerprint(item) !== normalizeSpecialistFingerprint(suggestion)
      )));
      pushLocalNotice(`Drafted specialist candidate: ${created.title}.`, "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [pushLocalNotice, selectedSession, selectedTurn?.turnId, sending]);

  const handleSpecialistCandidatePatch = useCallback(async (
    candidateId: string,
    patch: Parameters<typeof updateChatSpecialistCandidate>[2],
    notice: string,
  ) => {
    if (!selectedSession || sending) {
      return;
    }
    setSending(true);
    try {
      const updated = await updateChatSpecialistCandidate(selectedSession.sessionId, candidateId, patch);
      setSpecialistCandidates((current) => current.map((item) => item.candidateId === updated.candidateId ? updated : item));
      pushLocalNotice(notice, "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [pushLocalNotice, selectedSession, sending]);

  const handleComposerPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      void uploadAttachments(files);
      return;
    }
    const itemFiles = Array.from(event.clipboardData.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (itemFiles.length > 0) {
      event.preventDefault();
      void uploadAttachments(itemFiles);
    }
  }, [uploadAttachments]);

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragActive(true);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragActive(false);
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragActive(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length > 0) void uploadAttachments(files);
  }, [uploadAttachments]);

  const applyDraftCommand = useCallback((command: string) => {
    setDraft(`${command} `);
    composerRef.current?.focus();
  }, []);

  const dismissCapabilitySuggestion = useCallback((suggestion: ChatCapabilityUpgradeSuggestion) => {
    setCapabilitySuggestions((current) => current.filter((item) => (
      item.kind !== suggestion.kind
      || (item.candidateId ?? item.title) !== (suggestion.candidateId ?? suggestion.title)
    )));
  }, []);

  const resumeCapabilitySuggestionTurn = useCallback(async () => {
    if (!selectedTurn?.turnId) {
      pushLocalNotice("Capability upgraded, but there is no failed turn selected to resume yet.", "warning");
      return;
    }
    const nextItem: OutboundQueueItem = {
      id: `queue-${Date.now()}`,
      action: "retry",
      sessionId: selectedSessionId ?? undefined,
      targetTurnId: selectedTurn.turnId,
      content: "",
      attachments: [],
      createdAt: new Date().toISOString(),
    };
    if (!tryBeginOutboundExecution()) {
      setQueuedOutbound((current) => [...current, nextItem]);
      pushLocalNotice("Capability upgraded. The original request has been queued to resume automatically.");
      return;
    }
    await executeOutboundItemRef.current(nextItem);
  }, [pushLocalNotice, selectedSessionId, selectedTurn?.turnId, tryBeginOutboundExecution]);

  const handleCapabilitySuggestionAction = useCallback(async (suggestion: ChatCapabilityUpgradeSuggestion) => {
    try {
      setError(null);
      if (suggestion.recommendedAction === "enable_skill") {
        if (!suggestion.candidateId) {
          throw new Error("This suggestion is missing the installed skill identifier.");
        }
        const confirmed = window.confirm(`Enable ${suggestion.title}?`);
        if (!confirmed) {
          return;
        }
        const updated = await updateSkillState(suggestion.candidateId, {
          state: "enabled",
          note: "Enabled from chat capability suggestion.",
        });
        pushLocalNotice(`Enabled skill ${updated.skillId}. Resuming the original request now.`, "success");
        setInstalledSkills(await fetchSkills().then((result) => result.items));
        dismissCapabilitySuggestion(suggestion);
        await resumeCapabilitySuggestionTurn();
        return;
      }

      if (suggestion.recommendedAction === "install_skill_disabled") {
        if (!suggestion.sourceRef) {
          throw new Error("This suggestion is missing the import source.");
        }
        const confirmed = window.confirm(
          `${suggestion.title}\n\nInstall this skill in disabled state for review first?`,
        );
        if (!confirmed) {
          return;
        }
        const installed = await installSkillImport({
          sourceRef: suggestion.sourceRef,
          sourceProvider: suggestion.sourceProvider && suggestion.sourceProvider !== "mcp_template"
            ? suggestion.sourceProvider
            : undefined,
          confirmHighRisk: suggestion.riskLevel === "high",
        });
        pushLocalNotice(
          installed.installedSkillId
            ? `Installed ${installed.installedSkillId}. It remains disabled by default until you enable it.`
            : "Installed the suggested skill. It remains disabled by default until you enable it.",
          "success",
        );
        setInstalledSkills(await fetchSkills().then((result) => result.items));
        dismissCapabilitySuggestion(suggestion);
        window.location.hash = "skills";
        return;
      }

      if (suggestion.recommendedAction === "install_skill_enable") {
        if (!suggestion.sourceRef) {
          throw new Error("This suggestion is missing the import source.");
        }
        const confirmed = window.confirm(
          `${suggestion.title}\n\nApprove GoatCitadel to install and enable this hosted skill now?`,
        );
        if (!confirmed) {
          return;
        }
        const installed = await installSkillImport({
          sourceRef: suggestion.sourceRef,
          sourceProvider: suggestion.sourceProvider && suggestion.sourceProvider !== "mcp_template"
            ? suggestion.sourceProvider
            : undefined,
          confirmHighRisk: suggestion.riskLevel === "high",
        });
        if (!installed.installedSkillId) {
          throw new Error("The skill installed, but GoatCitadel could not resolve its installed skill identifier.");
        }
        await updateSkillState(installed.installedSkillId, {
          state: "enabled",
          note: "Enabled immediately from chat capability suggestion.",
        });
        pushLocalNotice(`Installed and enabled ${installed.installedSkillId}. Resuming the original request now.`, "success");
        setInstalledSkills(await fetchSkills().then((result) => result.items));
        dismissCapabilitySuggestion(suggestion);
        await resumeCapabilitySuggestionTurn();
        return;
      }

      if (suggestion.recommendedAction === "add_mcp_template") {
        const templateId = suggestion.candidateId ?? suggestion.sourceRef;
        if (!templateId) {
          throw new Error("This suggestion is missing the MCP template identifier.");
        }
        const confirmed = window.confirm(`Add MCP template "${suggestion.title}" now?`);
        if (!confirmed) {
          return;
        }
        const templates = await fetchMcpTemplates();
        const template = templates.items.find((item) => item.templateId === templateId);
        if (!template) {
          throw new Error("The suggested MCP template is no longer available.");
        }
        if (template.installed) {
          pushLocalNotice(`${template.label} is already installed. Review it in MCP Servers.`);
          dismissCapabilitySuggestion(suggestion);
          window.location.hash = "mcp";
          return;
        }
        await createMcpServer({
          label: template.label,
          transport: template.transport,
          command: template.command,
          args: template.args,
          url: template.url,
          authType: template.authType,
          enabled: template.enabledByDefault,
          category: template.category,
          trustTier: template.trustTier,
          costTier: template.costTier,
          policy: template.policy,
        });
        pushLocalNotice(`${template.label} was added. Review trust/auth details in MCP before first live use.`, "success");
        setMcpServers(await fetchMcpServers().then((result) => result.items));
        setMcpTemplates(await fetchMcpTemplates().then((result) => result.items));
        dismissCapabilitySuggestion(suggestion);
        window.location.hash = "mcp";
        return;
      }

      if (suggestion.recommendedAction === "switch_tool_profile") {
        pushLocalNotice("This request is blocked by the current tool/profile policy. Review Tool Access and retry.", "warning");
        window.location.hash = "tools";
        return;
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [dismissCapabilitySuggestion, pushLocalNotice, resumeCapabilitySuggestionTurn]);

  const handleCommandExecution = useCallback(async (sessionId: string, commandText: string) => {
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
      const [servers, templates] = await Promise.all([
        fetchMcpServers(),
        fetchMcpTemplates(),
      ]);
      setMcpServers(servers.items);
      setMcpTemplates(templates.items);
    }
  }, [loadSidebar, pushLocalNotice]);

  const executeOutboundItem = useCallback(async (item: OutboundQueueItem) => {
    const trimmedContent = item.content.trim();
    const attachmentsSnapshot = item.attachments;
    const attachmentIds = attachmentsSnapshot.map((entry) => entry.attachmentId);
    const currentPrefs = prefsRef.current;
    const currentProviderId = currentPrefs?.providerId ?? selectedProviderId;
    const currentProvider = providerOptions.find((provider) => provider.providerId === currentProviderId);
    const currentProviderSelection = resolveProviderModelSelection({
      provider: currentProvider,
      loadedModels: currentProviderId ? getCachedModels(currentProviderId) : [],
      selectedModel: currentPrefs?.model ?? selectedModel,
    });
    const effectiveProviderId = currentProvider?.providerId;
    const effectiveModel = currentProviderSelection.model;
    const localAttachments = attachmentsSnapshot.map((entry) => ({
      attachmentId: entry.attachmentId,
      fileName: entry.fileName,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
    }));
    let session: ChatSessionRecord | null = null;
    try {
      recordClientDiagnostic({
        level: "info",
        category: "chat",
        event: "send.start",
        message: `Starting ${item.action} action`,
        sessionId: item.sessionId,
        turnId: item.targetTurnId,
        context: {
          action: item.action,
          attachmentCount: attachmentsSnapshot.length,
          contentLength: trimmedContent.length,
          streamEnabled,
        },
      });
      setError(null);
      setPendingApproval(null);
      session = await ensureSession();
      if (!effectiveProviderId) {
        throw new Error("No model provider is configured yet. Open Configure and connect a provider first.");
      }
      if (currentProviderSelection.blockedMessage) {
        throw new Error(currentProviderSelection.blockedMessage);
      }
      if (!effectiveModel) {
        throw new Error(
          currentProviderSelection.missingModelMessage
          ?? `No model is selected for ${currentProvider?.label ?? effectiveProviderId}. Choose a model and try again.`,
        );
      }
      if (item.action === "send" && trimmedContent.startsWith("/")) {
        await handleCommandExecution(session.sessionId, trimmedContent);
        await loadSidebar();
        return;
      }

      const targetTurn = item.targetTurnId
        ? (threadRef.current?.turns.find((turn) => turn.turnId === item.targetTurnId) ?? null)
        : null;
      if ((item.action === "edit" || item.action === "retry") && !targetTurn) {
        throw new Error("The selected branch turn is no longer available.");
      }
      const effectiveUserMessage: ChatMessageRecord = item.action === "retry" && targetTurn
        ? targetTurn.userMessage
        : {
          messageId: `local-user-${Date.now()}`,
          sessionId: session.sessionId,
          role: "user",
          actorType: "user",
          actorId: "operator",
          content: trimmedContent,
          timestamp: new Date().toISOString(),
          attachments: localAttachments.length > 0 ? localAttachments : undefined,
        };
      if (streamEnabled) {
        const streamToken = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const controller = new AbortController();
        const activeStream: ActiveChatStreamState = {
          sessionId: session.sessionId,
          streamToken,
          controller,
        };
        activeStreamRef.current = activeStream;
        const streamSeed: PendingStreamTurnSeed = {
          userMessage: effectiveUserMessage,
          parentTurnId: item.action === "send" ? threadRef.current?.activeLeafTurnId : targetTurn?.parentTurnId,
          branchKind: item.action === "send" ? "append" : item.action === "edit" ? "edit" : "retry",
          sourceTurnId: item.action === "send" ? undefined : item.targetTurnId,
          mode: item.action,
        };
        const onChunk = (chunk: ChatStreamChunk) => {
          const liveStream = activeStreamRef.current;
          if (
            liveStream?.streamToken !== streamToken
            || liveStream.sessionId !== session!.sessionId
            || selectedSessionIdRef.current !== session!.sessionId
          ) {
            return;
          }
          liveStream.lastEventId = chunk.eventId;
          if (chunk.runId) {
            liveStream.runId = chunk.runId;
          }
          if (chunk.type === "message_start") {
            liveStream.turnId = chunk.turnId;
          }
          if (chunk.type === "trace_update" && chunk.trace.durable?.runId) {
            liveStream.runId = chunk.trace.durable.runId;
          }
          if (chunk.type === "message_done") {
            finalizedStreamMessageRef.current = {
              sessionId: session!.sessionId,
              placeholderId: chunk.messageId,
              messageId: chunk.messageId,
              content: chunk.content,
            };
          }
          if (chunk.type === "trace_update" && chunk.trace.capabilityUpgradeSuggestions !== undefined) {
            setCapabilitySuggestions(chunk.trace.capabilityUpgradeSuggestions);
          }
          if (chunk.type === "trace_update" && chunk.trace.specialistCandidateSuggestions !== undefined) {
            setSpecialistSuggestions(chunk.trace.specialistCandidateSuggestions);
          }
          if (chunk.type === "capability_upgrade_suggestion") {
            setCapabilitySuggestions(chunk.capabilityUpgradeSuggestions ?? []);
          }
          if (chunk.type === "approval_required") {
            setPendingApproval({
              approvalId: chunk.approval.approvalId,
              toolName: chunk.approval.toolName,
              reason: chunk.approval.reason,
            });
          }
          if (chunk.type === "error") {
            setError(chunk.error || "Streaming request failed.");
            recordClientDiagnostic({
              level: "error",
              category: "chat",
              event: "stream.chunk_error",
              message: chunk.error || "Streaming request failed.",
              sessionId: session!.sessionId,
              turnId: chunk.turnId,
            });
          }
          if (!isThreadMutatingStreamChunk(chunk)) {
            return;
          }
          recordClientDiagnostic({
            level: "debug",
            category: "chat",
            event: "thread.render_path",
            message: `Applying ${chunk.type} chunk to thread`,
            sessionId: session!.sessionId,
            turnId: chunk.turnId,
            context: {
              chunkType: chunk.type,
            },
          });
          commitThreadUpdate((current) => updateThreadFromStreamChunk(
            current,
            chunk,
            streamSeed,
            session!.sessionId,
            prefsRef.current,
          ));
        };
        let resumeAttempts = 0;
        for (;;) {
          try {
            if (resumeAttempts > 0) {
              const liveStream = activeStreamRef.current;
              if (!liveStream?.turnId) {
                throw new Error("Streaming request failed before the turn could be resumed.");
              }
              setError(null);
              pushLocalNotice(`Stream interrupted. Reconnecting to turn ${liveStream.turnId.slice(-6)}.`, "warning");
              await resumeChatTurnStream(session.sessionId, liveStream.turnId, onChunk, {
                signal: controller.signal,
                sinceEventId: liveStream.lastEventId,
              });
            } else if (item.action === "retry" && item.targetTurnId) {
              await streamRetryChatTurn(session.sessionId, item.targetTurnId, {
                providerId: effectiveProviderId,
                model: effectiveModel,
                mode: currentPrefs?.mode,
                webMode: currentPrefs?.webMode,
                memoryMode: currentPrefs?.memoryMode,
                thinkingLevel: currentPrefs?.thinkingLevel,
              }, onChunk, { signal: controller.signal });
            } else if (item.action === "edit" && item.targetTurnId) {
              await streamEditChatTurn(session.sessionId, item.targetTurnId, {
                content: trimmedContent,
                attachments: attachmentIds,
                useMemory: (currentPrefs?.memoryMode ?? "auto") !== "off",
                mode: currentPrefs?.mode ?? "chat",
                providerId: effectiveProviderId,
                model: effectiveModel,
                webMode: currentPrefs?.webMode ?? "auto",
                memoryMode: currentPrefs?.memoryMode ?? "auto",
                thinkingLevel: currentPrefs?.thinkingLevel ?? "standard",
              }, onChunk, { signal: controller.signal });
            } else {
              await streamAgentChatMessage(session.sessionId, {
                content: trimmedContent,
                attachments: attachmentIds,
                useMemory: (currentPrefs?.memoryMode ?? "auto") !== "off",
                mode: currentPrefs?.mode ?? "chat",
                providerId: effectiveProviderId,
                model: effectiveModel,
                webMode: currentPrefs?.webMode ?? "auto",
                memoryMode: currentPrefs?.memoryMode ?? "auto",
                thinkingLevel: currentPrefs?.thinkingLevel ?? "standard",
              }, onChunk, { signal: controller.signal });
            }
            break;
          } catch (streamError) {
            if (isAbortError(streamError)) {
              throw streamError;
            }
            const liveStream = activeStreamRef.current;
            const canResume = Boolean(
              liveStream
              && liveStream.streamToken === streamToken
              && liveStream.sessionId === session.sessionId
              && liveStream.turnId,
            );
            if (!canResume || resumeAttempts >= 2) {
              throw streamError;
            }
            resumeAttempts += 1;
          }
        }
        scheduleStreamMessageReconciliation(session.sessionId);
      } else {
        const sent = item.action === "retry" && item.targetTurnId
          ? await retryChatTurn(session.sessionId, item.targetTurnId, {
            providerId: effectiveProviderId,
            model: effectiveModel,
            mode: currentPrefs?.mode,
            webMode: currentPrefs?.webMode,
            memoryMode: currentPrefs?.memoryMode,
            thinkingLevel: currentPrefs?.thinkingLevel,
          })
          : item.action === "edit" && item.targetTurnId
            ? await editChatTurn(session.sessionId, item.targetTurnId, {
              content: trimmedContent,
              attachments: attachmentIds,
              useMemory: (currentPrefs?.memoryMode ?? "auto") !== "off",
              mode: currentPrefs?.mode ?? "chat",
              providerId: effectiveProviderId,
              model: effectiveModel,
              webMode: currentPrefs?.webMode ?? "auto",
              memoryMode: currentPrefs?.memoryMode ?? "auto",
              thinkingLevel: currentPrefs?.thinkingLevel ?? "standard",
            })
            : await sendAgentChatMessage(session.sessionId, {
              content: trimmedContent,
              attachments: attachmentIds,
              useMemory: (currentPrefs?.memoryMode ?? "auto") !== "off",
              mode: currentPrefs?.mode ?? "chat",
              providerId: effectiveProviderId,
              model: effectiveModel,
              webMode: currentPrefs?.webMode ?? "auto",
              memoryMode: currentPrefs?.memoryMode ?? "auto",
              thinkingLevel: currentPrefs?.thinkingLevel ?? "standard",
            });
        if (sent.trace) {
          setCapabilitySuggestions(sent.trace.capabilityUpgradeSuggestions ?? []);
          setSpecialistSuggestions(sent.trace.specialistCandidateSuggestions ?? []);
        }
        await loadSessionCoreState(session.sessionId, {
          background: true,
          includeThread: true,
        });
      }
      setEditingTurnId(null);
      await loadSidebar();
      recordClientDiagnostic({
        level: "info",
        category: "chat",
        event: "send.complete",
        message: `${item.action} action completed`,
        sessionId: session.sessionId,
        turnId: item.targetTurnId,
      });
    } catch (err) {
      if (isAbortError(err)) {
        recordClientDiagnostic({
          level: "warn",
          category: "chat",
          event: "send.aborted",
          message: `${item.action} action aborted`,
          sessionId: session?.sessionId ?? item.sessionId,
          turnId: item.targetTurnId,
        });
        return;
      }
      if (session) {
        void loadSessionCoreState(session.sessionId, {
          background: true,
          includeThread: true,
        }).catch(() => undefined);
      }
      if (item.action !== "retry") {
        setDraft((current) => current.trim().length > 0 ? current : item.content);
        setPendingAttachments((current) => current.length > 0 ? current : attachmentsSnapshot);
        if (item.action === "edit" && item.targetTurnId) {
          setEditingTurnId(item.targetTurnId);
        }
      }
      setError((err as Error).message);
      recordClientDiagnostic({
        level: "error",
        category: "chat",
        event: "send.failed",
        message: `${item.action} action failed`,
        sessionId: session?.sessionId ?? item.sessionId,
        turnId: item.targetTurnId,
        context: {
          error: (err as Error).message,
        },
      });
    } finally {
      const activeStream = activeStreamRef.current;
      if (session && activeStream?.sessionId === session.sessionId) {
        activeStreamRef.current = null;
      }
      finishOutboundExecution();
    }
  }, [
    commitThreadUpdate,
    ensureSession,
    finishOutboundExecution,
    getCachedModels,
    handleCommandExecution,
    loadSessionCoreState,
    providerOptions,
    loadSidebar,
    scheduleStreamMessageReconciliation,
    selectedModel,
    selectedProviderId,
    streamEnabled,
  ]);

  useEffect(() => {
    executeOutboundItemRef.current = executeOutboundItem;
  }, [executeOutboundItem]);

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

  const handleSelectBranchTurn = useCallback(async (turnId: string) => {
    if (!selectedSessionId) {
      return;
    }
    try {
      recordClientDiagnostic({
        level: "info",
        category: "chat",
        event: "branch.select",
        message: "Selecting chat branch turn",
        sessionId: selectedSessionId,
        turnId,
      });
      const nextThread = await selectChatBranchTurn(selectedSessionId, turnId);
      commitThreadUpdate(nextThread);
      setSelectedTurnId(nextThread.activeLeafTurnId ?? turnId);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [commitThreadUpdate, selectedSessionId]);

  const handleComposerKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (commandSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCommandIndex((current) => Math.min(current + 1, commandSuggestions.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCommandIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const suggestion = commandSuggestions[commandIndex];
        if (suggestion) applyDraftCommand(suggestion.applyValue);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }, [applyDraftCommand, commandIndex, commandSuggestions, handleSend]);

  const handleApprovePending = useCallback(async () => {
    if (!selectedSession || !pendingApproval) return;
    setApprovalPending(true);
    try {
      await approveChatTool(selectedSession.sessionId, pendingApproval.approvalId);
      pushLocalNotice(`Approved request ${pendingApproval.approvalId}. Send your message again and I will continue.`, "success");
      setPendingApproval(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApprovalPending(false);
    }
  }, [pendingApproval, pushLocalNotice, selectedSession]);

  const handleDenyPending = useCallback(async () => {
    if (!selectedSession || !pendingApproval) return;
    setApprovalPending(true);
    try {
      await denyChatTool(selectedSession.sessionId, pendingApproval.approvalId);
      pushLocalNotice(`Denied request ${pendingApproval.approvalId}. No action was taken.`, "warning");
      setPendingApproval(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApprovalPending(false);
    }
  }, [pendingApproval, pushLocalNotice, selectedSession]);

  const handlePrefPatch = useCallback(async (patch: ChatSessionPrefsPatch) => {
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
  }, [selectedSession]);

  const rootClassName = `chat-v11 mode-${messageMode}${lockSurface ? " shell-owned-surface" : ""}`;
  const workspaceSummaryText = selectedSession
    ? `${lockSurface ? "Current session" : isCodeSurface ? "Current code session" : `Active ${activeModePreset.label.toLowerCase()} session`}: ${selectedSession.title || visibleSessionLabelById.get(selectedSession.sessionId) || `Chat ${selectedSession.sessionId.slice(-6)}`}.`
    : lockSurface
      ? `Start a new ${activeModePreset.label.toLowerCase()} run or reopen a recent session from the left rail.`
      : isCodeSurface
        ? "Pick a code session or start a new one. Bind a project only when you want execution-heavy work."
        : `Use the queue to reopen a session or start a new ${activeModePreset.label.toLowerCase()} run from the left rail.`;
  const dockSectionStyle = useCallback((sectionId: MissionControlDockSectionId) => ({
    order: Math.max(0, dockSectionOrder.indexOf(sectionId)),
  }), [dockSectionOrder]);

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
          hint={isCodeSurface
            ? undefined
            : "Stay in the main thread by default. Open trace, memory, and approvals only when you need them."}
          className="page-header-command chat-v11-header"
          actions={(
            <div className="chat-v11-page-actions">
              <StatusChip tone={selectedSessionId ? "live" : "muted"}>{selectedSessionId ? "Session selected" : "No session"}</StatusChip>
              {selectedSession ? (
                <StatusChip tone={selectedSession.scope === "external" ? "warning" : "success"}>
                  {selectedSession.scope === "external" ? "External writeback" : "Mission session"}
                </StatusChip>
              ) : null}
              {!isCodeSurface && selectedTurn ? <StatusChip tone="muted">{selectedTurn.trace.status}</StatusChip> : null}
            </div>
          )}
        />
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {isRefreshing ? <p className="status-banner">Refreshing chat context...</p> : null}

      <div className="chat-v11-shell">
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
          onCreateSession={() => void handleCreateSession(messageMode)}
          onSearchChange={setSearch}
          onProjectNameChange={setProjectName}
          onProjectPathChange={setProjectPath}
          onCreateProject={() => {
            const name = projectName.trim();
            if (!name) return;
            setSending(true);
            void createChatProject({
              workspaceId,
              name,
              workspacePath: projectPath.trim() || "chat/default",
            })
              .then(async (created) => {
                setProjectName("");
                setShowProjectCreate(false);
                setSelectedProjectId(created.projectId);
                await loadSidebar();
              })
              .catch((err) => setError((err as Error).message))
              .finally(() => setSending(false));
          }}
          onHistoryViewChange={setHistoryView}
          onArchiveWorkspace={() => setArchiveWorkspaceConfirmOpen(true)}
          onSelectProjectId={setSelectedProjectId}
          onSelectSession={setSelectedSessionId}
          renderSessionLabel={(sessionId) => visibleSessionLabelById.get(sessionId) ?? `Chat ${sessionId.slice(-6)}`}
        />

        <div className="chat-v11-main">
          {selectedSession ? (
            <div className={`chat-v11-conversation-shell surface-${messageMode}`}>
              <MissionControlSurfaceHeader
                mode={messageMode}
                sessionTitle={selectedSessionLabel}
                summary={workspaceSummaryText}
                status={selectedTurn?.trace.status ?? null}
                dockOpen={dockOpen}
                onToggleDock={() => setDockOpen((current) => !current)}
              />
              <div className={`chat-v11-main-grid${isCoworkSurface ? " with-cowork" : ""}${isCodeSurface ? " with-code" : ""}${dockOpen ? " with-dock-open" : " with-dock-collapsed"}`}>
                <article className={`card chat-v11-thread mode-${messageMode}`}>
                  <ChatThreadShell
                    mode={messageMode}
                    loading={messagesLoading}
                    thread={thread}
                    selectedTurnId={selectedTurnId}
                    notices={localNotices}
                    followOutput={followThreadOutput}
                    streamStatus={streamStatus}
                    queuedCount={queuedOutbound.length}
                    streamError={error}
                    pendingApproval={pendingApproval}
                    approvalPending={approvalPending}
                    eventStreamStatus={eventStreamStatus}
                    onBottomStateChange={setFollowThreadOutput}
                    onSelectTurn={setSelectedTurnId}
                    onSwitchBranch={(turnId) => void handleSelectBranchTurn(turnId)}
                    onRetryTurn={(turnId) => void handleRetryTurn(turnId)}
                    onEditTurn={handleBeginEditTurn}
                    onApprovePending={() => void handleApprovePending()}
                    onDenyPending={() => void handleDenyPending()}
                    onRefresh={() => void loadSessionCoreState(selectedSession.sessionId, { includeThread: true })}
                  />

                  <ChatComposerShell
                    mode={messageMode}
                    isDragActive={isDragActive}
                    queueItems={queuedOutbound.map((item) => ({
                      id: item.id,
                      action: item.action,
                      label: item.content.trim() ? item.content.trim().slice(0, 96) : `Turn ${item.targetTurnId?.slice(-6) ?? "queued"}`,
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
                    onCancelEdit={() => setEditingTurnId(null)}
                    onDismissError={() => setError(null)}
                    onRetryTurn={(turnId) => void handleRetryTurn(turnId)}
                    onSetDeepMode={() => void handlePrefPatch({ webMode: "deep" })}
                    onReviewRunDetails={handleRevealSelectedTurnDetails}
                    onDraftChange={setDraft}
                    onComposerKeyDown={handleComposerKeyDown}
                    onComposerPaste={handleComposerPaste}
                    onApplyDraftCommand={applyDraftCommand}
                    onRemoveAttachment={(attachmentId) => setPendingAttachments((current) => current.filter((entry) => entry.attachmentId !== attachmentId))}
                    onAttachFiles={() => fileInputRef.current?.click()}
                    onUploadFiles={(files) => {
                      if (!files || files.length === 0) return;
                      void uploadAttachments(Array.from(files));
                    }}
                    onRunQuickResearch={() => { void handleRunQuickResearch(); }}
                    onStopActiveTurn={() => void handleStopActiveTurn()}
                    onSend={() => void handleSend()}
                  />
                </article>
                <MissionControlContextDock mode={messageMode} open={dockOpen}>
                {isCoworkSurface ? (
                  <div className="mission-dock-section" style={dockSectionStyle("workflow")}>
                    <CoworkCanvasPanel items={coworkItems} orchestration={latestOrchestration} />
                  </div>
                ) : null}
                {isCodeSurface ? (
                  <div className="mission-dock-section" style={dockSectionStyle("workflow")}>
                    <CodeWorkbenchPanel
                      selectedTurn={selectedTurn}
                      projectName={selectedProject?.name}
                      needsProjectBinding={codeModeNeedsProjectBinding}
                    />
                  </div>
                ) : null}
                <div className="mission-dock-section" style={dockSectionStyle("surface")}>
                <Panel
                  className="chat-v11-topbar-panel chat-v11-panel-surface"
                  padding="compact"
                  title={isCodeSurface ? "Execution posture" : isCoworkSurface ? "Now / next / controls" : "Surface controls"}
                  subtitle={isCodeSurface ? "Project binding, model, and review posture for this session." : isCoworkSurface ? "Guide the workflow lane without crowding the central thread." : activeModePreset.summary}
                >
                  <ChatPlanningPill planningMode={planningMode} effectiveToolAutonomy={effectiveToolAutonomy} />
                  <div className="chat-v11-surface-identity">
                    <div className="chat-v11-surface-chip-row">
                      <StatusChip tone={isChatSurface ? "live" : isCoworkSurface ? "warning" : "critical"}>
                        {activeModePreset.teamBehaviorLabel}
                      </StatusChip>
                      <StatusChip tone={activeModePreset.allowsDynamicTeamGrowth ? "warning" : "muted"}>
                        {activeModePreset.growthPolicyLabel}
                      </StatusChip>
                    </div>
                    <p className="chat-v11-surface-copy">{activeModePreset.teamBehaviorSummary}</p>
                    <p className="chat-v11-surface-copy secondary">{activeModePreset.growthPolicySummary}</p>
                  </div>
                  {codeModeNeedsProjectBinding ? (
                    <div className="status-banner warning">
                      Code mode is unbound. Assign a project in Session management before execution-heavy work. Until then GoatCitadel stays in manual execution posture.
                      {selectedSession && selectedProjectBindingCandidateId ? (
                        <>
                          {" "}
                          <button
                            type="button"
                            disabled={sending || Boolean(sessionControlPending)}
                            onClick={() => {
                              setSessionControlPending("project");
                              void assignChatSessionProject(selectedSession.sessionId, selectedProjectBindingCandidateId)
                                .then(() => loadSidebar())
                                .catch((err) => setError((err as Error).message))
                                .finally(() => setSessionControlPending(null));
                            }}
                          >
                            Bind {selectedProjectBindingCandidateName ?? "selected project"}
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {isCodeSurface ? (
                    <div className="chat-v11-settings-grid">
                      {!lockSurface ? (
                        <div className="chat-v11-setting-row chat-v11-setting-row-stack chat-v11-setting-row-wide">
                          <div className="chat-v11-setting-copy">
                            <span className="chat-v11-setting-label">Surface</span>
                            <span className="chat-v11-setting-hint">Switch between Chat, Cowork, and Code.</span>
                          </div>
                          <div className="chat-v11-setting-control">
                            <ChatModeSwitch value={messageMode} disabled={!selectedSessionId || sending} onChange={(mode) => void handlePrefPatch({ mode })} />
                          </div>
                        </div>
                      ) : null}
                      <div className="chat-v11-setting-row chat-v11-setting-row-stack chat-v11-setting-row-wide">
                        <div className="chat-v11-setting-copy">
                          <span className="chat-v11-setting-label">Model</span>
                          <span className="chat-v11-setting-hint">Provider and model used for this code session.</span>
                        </div>
                        <div className="chat-v11-setting-control">
                          <ChatModelPicker
                            providers={providerOptions}
                            providerId={selectedProviderId}
                            model={selectedModel}
                            disabled={!selectedSessionId || sending}
                            onChangeProvider={(providerId) => {
                              const provider = providerOptions.find((item) => item.providerId === providerId);
                              const selection = resolveProviderModelSelection({
                                provider,
                                loadedModels: providerId ? getCachedModels(providerId) : [],
                                selectedModel: undefined,
                              });
                              void loadModelsForProvider(providerId);
                              void handlePrefPatch({ providerId, model: selection.model ?? "" });
                            }}
                            onChangeModel={(model) => void handlePrefPatch({ model })}
                          />
                        </div>
                      </div>
                      <div className="chat-v11-setting-row">
                        <span className="chat-v11-setting-label">Thinking</span>
                        <div className="chat-v11-setting-control">
                          <GCSelect
                            value={prefs?.thinkingLevel ?? "standard"}
                            disabled={!selectedSessionId || sending}
                            onChange={(value) => void handlePrefPatch({ thinkingLevel: value as "minimal" | "standard" | "extended" })}
                            options={[
                              { value: "minimal", label: "Minimal" },
                              { value: "standard", label: "Standard" },
                              { value: "extended", label: "Extended" },
                            ]}
                          />
                        </div>
                      </div>
                      <div className="chat-v11-setting-row">
                        <span className="chat-v11-setting-label">Web</span>
                        <div className="chat-v11-setting-control">
                          <GCSelect
                            value={prefs?.webMode ?? "auto"}
                            disabled={!selectedSessionId || sending}
                            onChange={(value) => void handlePrefPatch({ webMode: value as "auto" | "off" | "quick" | "deep" })}
                            options={[
                              { value: "auto", label: "Auto" },
                              { value: "off", label: "Off" },
                              { value: "quick", label: "Quick" },
                              { value: "deep", label: "Deep" },
                            ]}
                          />
                        </div>
                      </div>
                      <div className="chat-v11-setting-row">
                        <span className="chat-v11-setting-label">Stream</span>
                        <div className="chat-v11-setting-control">
                          <GCSwitch checked={streamEnabled} onCheckedChange={setStreamEnabled} />
                        </div>
                      </div>
                      <div className="chat-v11-setting-row">
                        <span className="chat-v11-setting-label">Orchestration</span>
                        <div className="chat-v11-setting-control">
                          <GCSwitch
                            checked={prefs?.orchestrationEnabled ?? true}
                            disabled={!selectedSessionId || sending}
                            onCheckedChange={(checked) => void handlePrefPatch({ orchestrationEnabled: checked })}
                          />
                        </div>
                      </div>
                      <div className="chat-v11-setting-row">
                        <span className="chat-v11-setting-label">Intensity</span>
                        <div className="chat-v11-setting-control">
                          <GCSelect
                            value={prefs?.orchestrationIntensity ?? "balanced"}
                            disabled={!selectedSessionId || sending || !(prefs?.orchestrationEnabled ?? true)}
                            onChange={(value) => void handlePrefPatch({ orchestrationIntensity: value as "minimal" | "balanced" | "deep" })}
                            options={[
                              { value: "minimal", label: "Minimal" },
                              { value: "balanced", label: "Balanced" },
                              { value: "deep", label: "Deep" },
                            ]}
                          />
                        </div>
                      </div>
                      <div className="chat-v11-setting-row">
                        <span className="chat-v11-setting-label">Visibility</span>
                        <div className="chat-v11-setting-control">
                          <GCSelect
                            value={prefs?.orchestrationVisibility ?? "expandable"}
                            disabled={!selectedSessionId || sending || !(prefs?.orchestrationEnabled ?? true)}
                            onChange={(value) => void handlePrefPatch({ orchestrationVisibility: value as "hidden" | "summarized" | "expandable" | "explicit" })}
                            options={[
                              { value: "hidden", label: "Hidden" },
                              { value: "summarized", label: "Summarized" },
                              { value: "expandable", label: "Expandable" },
                              { value: "explicit", label: "Explicit" },
                            ]}
                          />
                        </div>
                      </div>
                      <div className="chat-v11-setting-row">
                        <span className="chat-v11-setting-label">Provider posture</span>
                        <div className="chat-v11-setting-control">
                          <GCSelect
                            value={prefs?.orchestrationProviderPreference ?? "balanced"}
                            disabled={!selectedSessionId || sending || !(prefs?.orchestrationEnabled ?? true)}
                            onChange={(value) => void handlePrefPatch({ orchestrationProviderPreference: value as "speed" | "quality" | "balanced" | "low_cost" })}
                            options={[
                              { value: "speed", label: "Speed" },
                              { value: "quality", label: "Quality" },
                              { value: "balanced", label: "Balanced" },
                              { value: "low_cost", label: "Low cost" },
                            ]}
                          />
                        </div>
                      </div>
                      <div className="chat-v11-setting-row">
                        <span className="chat-v11-setting-label">Review depth</span>
                        <div className="chat-v11-setting-control">
                          <GCSelect
                            value={prefs?.orchestrationReviewDepth ?? "standard"}
                            disabled={!selectedSessionId || sending || !(prefs?.orchestrationEnabled ?? true)}
                            onChange={(value) => void handlePrefPatch({ orchestrationReviewDepth: value as "off" | "standard" | "strict" })}
                            options={[
                              { value: "off", label: "Off" },
                              { value: "standard", label: "Standard" },
                              { value: "strict", label: "Strict" },
                            ]}
                          />
                        </div>
                      </div>
                      <div className="chat-v11-setting-row">
                        <span className="chat-v11-setting-label">Parallelism</span>
                        <div className="chat-v11-setting-control">
                          <GCSelect
                            value={prefs?.orchestrationParallelism ?? "auto"}
                            disabled={!selectedSessionId || sending || !(prefs?.orchestrationEnabled ?? true)}
                            onChange={(value) => void handlePrefPatch({ orchestrationParallelism: value as "auto" | "sequential" | "parallel" })}
                            options={[
                              { value: "auto", label: "Auto" },
                              { value: "sequential", label: "Sequential" },
                              { value: "parallel", label: "Parallel" },
                            ]}
                          />
                        </div>
                      </div>
                      <div className="chat-v11-setting-row">
                        <span className="chat-v11-setting-label">Code apply</span>
                        <div className="chat-v11-setting-control">
                          <GCSelect
                            value={prefs?.codeAutoApply ?? "manual"}
                            disabled={!selectedSessionId || sending || !(prefs?.orchestrationEnabled ?? true)}
                            onChange={(value) => void handlePrefPatch({ codeAutoApply: value as "manual" | "low_risk_auto" | "aggressive_auto" })}
                            options={[
                              { value: "manual", label: "Manual" },
                              { value: "low_risk_auto", label: "Low risk auto" },
                              { value: "aggressive_auto", label: "Aggressive auto" },
                            ]}
                          />
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {isCodeSurface ? null : (
                  <DataToolbar
                    primary={(
                      <>
                        {!lockSurface ? (
                          <ChatModeSwitch value={messageMode} disabled={!selectedSessionId || sending} onChange={(mode) => void handlePrefPatch({ mode })} />
                        ) : null}
                        <ChatModelPicker
                          providers={providerOptions}
                          providerId={selectedProviderId}
                          model={selectedModel}
                          disabled={!selectedSessionId || sending}
                          onChangeProvider={(providerId) => {
                            const provider = providerOptions.find((item) => item.providerId === providerId);
                            const selection = resolveProviderModelSelection({
                              provider,
                              loadedModels: providerId ? getCachedModels(providerId) : [],
                              selectedModel: undefined,
                            });
                            void loadModelsForProvider(providerId);
                            void handlePrefPatch({ providerId, model: selection.model ?? "" });
                          }}
                          onChangeModel={(model) => void handlePrefPatch({ model })}
                        />
                        <label className="chat-v11-select">Thinking
                          <GCSelect
                            value={prefs?.thinkingLevel ?? "standard"}
                            disabled={!selectedSessionId || sending}
                            onChange={(value) => void handlePrefPatch({ thinkingLevel: value as "minimal" | "standard" | "extended" })}
                            options={[
                              { value: "minimal", label: "Minimal" },
                              { value: "standard", label: "Standard" },
                              { value: "extended", label: "Extended" },
                            ]}
                          />
                        </label>
                        <label className="chat-v11-select">Web
                          <GCSelect
                            value={prefs?.webMode ?? "auto"}
                            disabled={!selectedSessionId || sending}
                            onChange={(value) => void handlePrefPatch({ webMode: value as "auto" | "off" | "quick" | "deep" })}
                            options={[
                              { value: "auto", label: "Auto" },
                              { value: "off", label: "Off" },
                              { value: "quick", label: "Quick" },
                              { value: "deep", label: "Deep" },
                            ]}
                          />
                        </label>
                      </>
                    )}
                    secondary={(
                      <>
                        {!isChatSurface ? (
                          <>
                            <label className="chat-v11-select">Proactive
                              <GCSelect
                                value={proactiveStatus?.mode ?? prefs?.proactiveMode ?? "off"}
                                disabled={!selectedSessionId || sending}
                                onChange={(value) => void handleProactivePolicyPatch({ proactiveMode: value as "off" | "suggest" | "auto_safe" | "auto_full" })}
                                options={[
                                  { value: "off", label: "Off" },
                                  { value: "suggest", label: "Suggest" },
                                  { value: "auto_safe", label: "Auto-safe" },
                                  { value: "auto_full", label: "Auto-full" },
                                ]}
                              />
                            </label>
                            <label className="chat-v11-select">Retrieval
                              <GCSelect
                                value={proactiveStatus?.retrievalMode ?? prefs?.retrievalMode ?? "standard"}
                                disabled={!selectedSessionId || sending}
                                onChange={(value) => void handleProactivePolicyPatch({ retrievalMode: value as "standard" | "layered" })}
                                options={[
                                  { value: "standard", label: "Standard" },
                                  { value: "layered", label: "Layered" },
                                ]}
                              />
                            </label>
                            <label className="chat-v11-select">Reflection
                              <GCSelect
                                value={proactiveStatus?.reflectionMode ?? prefs?.reflectionMode ?? "off"}
                                disabled={!selectedSessionId || sending}
                                onChange={(value) => void handleProactivePolicyPatch({ reflectionMode: value as "off" | "on" })}
                                options={[
                                  { value: "off", label: "Off" },
                                  { value: "on", label: "On" },
                                ]}
                              />
                            </label>
                            {isCoworkSurface ? (
                              <button type="button" disabled={!selectedSessionId || sending} onClick={() => void handleSuggestDelegation()}>
                                Suggest delegation
                              </button>
                            ) : null}
                            <button type="button" disabled={!selectedSessionId || sending} onClick={() => void handleTriggerProactive()}>
                              Run proactive
                            </button>
                          </>
                        ) : null}
                        <GCSwitch checked={streamEnabled} onCheckedChange={setStreamEnabled} label="Stream" />
                      </>
                    )}
                  />
                  )}
                  {!isCodeSurface && !isChatSurface ? (
                    <div className="chat-v11-orchestration-controls">
                      <GCSwitch
                        checked={prefs?.orchestrationEnabled ?? true}
                        disabled={!selectedSessionId || sending}
                        label="Orchestration"
                        onCheckedChange={(checked) => void handlePrefPatch({ orchestrationEnabled: checked })}
                      />
                      <label className="chat-v11-select">Intensity
                        <GCSelect
                          value={prefs?.orchestrationIntensity ?? "balanced"}
                          disabled={!selectedSessionId || sending || !(prefs?.orchestrationEnabled ?? true)}
                          onChange={(value) => void handlePrefPatch({ orchestrationIntensity: value as "minimal" | "balanced" | "deep" })}
                          options={[
                            { value: "minimal", label: "Minimal" },
                            { value: "balanced", label: "Balanced" },
                            { value: "deep", label: "Deep" },
                          ]}
                        />
                      </label>
                      <label className="chat-v11-select">Visibility
                        <GCSelect
                          value={prefs?.orchestrationVisibility ?? (isCodeSurface ? "expandable" : "summarized")}
                          disabled={!selectedSessionId || sending || !(prefs?.orchestrationEnabled ?? true)}
                          onChange={(value) => void handlePrefPatch({ orchestrationVisibility: value as "hidden" | "summarized" | "expandable" | "explicit" })}
                          options={[
                            { value: "hidden", label: "Hidden" },
                            { value: "summarized", label: "Summarized" },
                            { value: "expandable", label: "Expandable" },
                            { value: "explicit", label: "Explicit" },
                          ]}
                        />
                      </label>
                      <label className="chat-v11-select">Provider posture
                        <GCSelect
                          value={prefs?.orchestrationProviderPreference ?? "balanced"}
                          disabled={!selectedSessionId || sending || !(prefs?.orchestrationEnabled ?? true)}
                          onChange={(value) => void handlePrefPatch({ orchestrationProviderPreference: value as "speed" | "quality" | "balanced" | "low_cost" })}
                          options={[
                            { value: "speed", label: "Speed" },
                            { value: "quality", label: "Quality" },
                            { value: "balanced", label: "Balanced" },
                            { value: "low_cost", label: "Low cost" },
                          ]}
                        />
                      </label>
                      <label className="chat-v11-select">Review depth
                        <GCSelect
                          value={prefs?.orchestrationReviewDepth ?? "standard"}
                          disabled={!selectedSessionId || sending || !(prefs?.orchestrationEnabled ?? true)}
                          onChange={(value) => void handlePrefPatch({ orchestrationReviewDepth: value as "off" | "standard" | "strict" })}
                          options={[
                            { value: "off", label: "Off" },
                            { value: "standard", label: "Standard" },
                            { value: "strict", label: "Strict" },
                          ]}
                        />
                      </label>
                      <label className="chat-v11-select">Parallelism
                        <GCSelect
                          value={prefs?.orchestrationParallelism ?? "auto"}
                          disabled={!selectedSessionId || sending || !(prefs?.orchestrationEnabled ?? true)}
                          onChange={(value) => void handlePrefPatch({ orchestrationParallelism: value as "auto" | "sequential" | "parallel" })}
                          options={[
                            { value: "auto", label: "Auto" },
                            { value: "sequential", label: "Sequential" },
                            { value: "parallel", label: "Parallel" },
                          ]}
                        />
                      </label>
                        </div>
                      ) : null}
                </Panel>
                </div>
                {!isCodeSurface && showTracePanel && selectedTurn ? (
                  <div className="mission-dock-section" style={dockSectionStyle("trace")}>
                  <Panel
                    className="chat-v11-agentic-card chat-v11-trace-card chat-v11-panel-trace"
                    title={isChatSurface ? "Run status" : "Run trace"}
                    actions={(
                      <StatusChip tone={selectedTurn.trace.status === "completed" ? "success" : selectedTurn.trace.status === "failed" ? "critical" : "warning"}>
                        {selectedTurn.trace.status}
                      </StatusChip>
                    )}
                  >
                    <ChatTraceCard trace={selectedTurn.trace} defaultCollapsed={isChatSurface} />
                  </Panel>
                  </div>
                ) : null}
                {!isCodeSurface && showSuggestionsPanel ? (
                <div className="mission-dock-section" style={dockSectionStyle("suggestions")}>
                <Panel
                  className="chat-v11-agentic-card chat-v11-panel-inbox"
                  title={isCoworkSurface ? "Cowork inbox" : isCodeSurface ? "Capability inbox" : "Suggestions"}
                  subtitle={
                    isCoworkSurface
                      ? "Review proactive suggestions, capability upgrades, and delegation prompts without losing the active chat context."
                      : isCodeSurface
                        ? "Review capability upgrades relevant to this code session."
                        : "Only relevant suggestions appear here so Chat stays lightweight."
                  }
                  actions={<span className="token-chip">{proactiveSuggestionCount} suggested</span>}
                >
                  {secondaryLoading && proactiveRuns.length === 0 && capabilitySuggestions.length === 0 && !delegationSuggestion ? (
                    <CardSkeleton lines={4} />
                  ) : null}
                  {capabilitySuggestions.length > 0 ? (
                    <div className="chat-v11-suggestion-card">
                      <p><strong>Capability upgrade available:</strong> GoatCitadel found a possible way to add what this request needs, but it still requires your approval.</p>
                      <ul className="chat-v11-proactive-list">
                        {capabilitySuggestions.slice(0, 3).map((suggestion) => (
                          <li key={`${suggestion.kind}-${suggestion.candidateId ?? suggestion.title}`}>
                            <p><strong>{suggestion.title}</strong>{suggestion.riskLevel ? ` · ${suggestion.riskLevel} risk` : ""}</p>
                            <p>{suggestion.summary}</p>
                            <p className="chat-v11-muted">{suggestion.reason}</p>
                            <div className="chat-v11-row-actions">
                              {suggestion.recommendedAction === "enable_skill" ? (
                                <button type="button" onClick={() => void handleCapabilitySuggestionAction(suggestion)}>Enable skill</button>
                              ) : null}
                              {suggestion.recommendedAction === "install_skill_disabled" ? (
                                <button type="button" onClick={() => void handleCapabilitySuggestionAction(suggestion)}>Install disabled</button>
                              ) : null}
                              {suggestion.recommendedAction === "install_skill_enable" ? (
                                <button type="button" onClick={() => void handleCapabilitySuggestionAction(suggestion)}>Approve and install</button>
                              ) : null}
                              {suggestion.recommendedAction === "add_mcp_template" ? (
                                <button type="button" onClick={() => void handleCapabilitySuggestionAction(suggestion)}>Add MCP template</button>
                              ) : null}
                              {suggestion.recommendedAction === "switch_tool_profile" ? (
                                <button type="button" onClick={() => void handleCapabilitySuggestionAction(suggestion)}>Review tool profile</button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => {
                                  window.location.hash = suggestion.kind === "mcp_template" ? "mcp" : "skills";
                                }}
                              >
                                {suggestion.kind === "mcp_template" ? "Open MCP" : "Open Skills"}
                              </button>
                              <button type="button" onClick={() => dismissCapabilitySuggestion(suggestion)}>Dismiss</button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {specialistSuggestions.length > 0 ? (
                    <div className="chat-v11-suggestion-card">
                      <p><strong>Specialist candidate suggested:</strong> GoatCitadel detected a recurring role or capability gap and can save it as a dormant specialist for future Cowork or Code runs.</p>
                      <ul className="chat-v11-proactive-list">
                        {specialistSuggestions.slice(0, 3).map((suggestion) => {
                          const existing = specialistCandidates.find((item) => (
                            normalizeSpecialistFingerprint(item) === normalizeSpecialistFingerprint(suggestion)
                            && item.status !== "retired"
                          ));
                          return (
                            <li key={suggestion.candidateId}>
                              <p><strong>{suggestion.title}</strong> · {suggestion.role}</p>
                              <p>{suggestion.summary}</p>
                              <p className="chat-v11-muted">{suggestion.reason}</p>
                              {suggestion.suggestedSkills?.length ? <p className="chat-v11-muted">Skills: {suggestion.suggestedSkills.join(", ")}</p> : null}
                              {suggestion.suggestedTools?.length ? <p className="chat-v11-muted">Tools: {suggestion.suggestedTools.join(", ")}</p> : null}
                              <div className="chat-v11-row-actions">
                                {existing ? (
                                  <span className="chat-v11-muted">Saved as {existing.status}.</span>
                                ) : (
                                  <button type="button" disabled={sending} onClick={() => void handleCreateSpecialistDraft(suggestion)}>
                                    Draft dormant specialist
                                  </button>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                  {specialistCandidates.filter((item) => item.status !== "retired").length > 0 ? (
                    <div className="chat-v11-suggestion-card">
                      <p><strong>Saved specialists:</strong> Review dormant specialists for this session. Only active strong-match specialists are eligible for automatic reuse in Cowork or Code.</p>
                      <ul className="chat-v11-proactive-list">
                        {specialistCandidates.filter((item) => item.status !== "retired").slice(0, 6).map((candidate) => (
                          <li key={candidate.candidateId}>
                            <p><strong>{candidate.title}</strong> · {candidate.role}</p>
                            <p>{candidate.summary}</p>
                            <p className="chat-v11-muted">
                              Status: {candidate.status}
                              {" · "}
                              Routing: {candidate.routingMode}
                              {" · "}
                              Confidence: {Math.round(candidate.confidence * 100)}%
                            </p>
                            {candidate.routingHints.objectiveKeywords?.length ? (
                              <p className="chat-v11-muted">Match terms: {candidate.routingHints.objectiveKeywords.join(", ")}</p>
                            ) : null}
                            <div className="chat-v11-row-actions">
                              {candidate.status !== "approved" && candidate.status !== "active" ? (
                                <button
                                  type="button"
                                  disabled={sending}
                                  onClick={() => void handleSpecialistCandidatePatch(
                                    candidate.candidateId,
                                    { status: "approved" },
                                    `Approved ${candidate.title}.`,
                                  )}
                                >
                                  Approve
                                </button>
                              ) : null}
                              {candidate.status !== "active" || candidate.routingMode !== "strong_match_only" ? (
                                <button
                                  type="button"
                                  disabled={sending}
                                  onClick={() => void handleSpecialistCandidatePatch(
                                    candidate.candidateId,
                                    { status: "active", routingMode: "strong_match_only" },
                                    `Activated ${candidate.title} for strong-match routing.`,
                                  )}
                                >
                                  Activate auto-match
                                </button>
                              ) : null}
                              {candidate.status === "active" || candidate.status === "approved" || candidate.status === "drafted" ? (
                                <button
                                  type="button"
                                  disabled={sending}
                                  onClick={() => void handleSpecialistCandidatePatch(
                                    candidate.candidateId,
                                    { status: "disabled", routingMode: "manual_only" },
                                    `Disabled ${candidate.title}.`,
                                  )}
                                >
                                  Disable
                                </button>
                              ) : null}
                              <button
                                type="button"
                                disabled={sending}
                                onClick={() => void handleSpecialistCandidatePatch(
                                  candidate.candidateId,
                                  { status: "retired", routingMode: "disabled" },
                                  `Retired ${candidate.title}.`,
                                )}
                              >
                                Retire
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {isCoworkSurface && delegationSuggestion ? (
                    <div className="chat-v11-suggestion-card">
                      <p><strong>Delegation suggestion:</strong> {delegationSuggestion.reason}</p>
                      <p>Roles: {delegationSuggestion.roles.join(" -> ")}</p>
                      <div className="chat-v11-row-actions">
                        <button type="button" disabled={sending} onClick={() => void handleAcceptDelegation()}>Accept plan</button>
                        <button type="button" disabled={sending} onClick={() => setDelegationSuggestion(null)}>Dismiss</button>
                      </div>
                    </div>
                  ) : isCoworkSurface ? (
                    <p className="chat-v11-muted">No pending delegation suggestion. Click “Suggest delegation” to generate one from your current request.</p>
                  ) : null}
                  {isCoworkSurface || (isChatSurface && proactiveSuggestionCount > 0) ? (
                    <ul className="chat-v11-proactive-list">
                      {proactiveRuns.slice(0, 4).map((run) => (
                        <li key={run.runId}>
                          <p><strong>{run.status}</strong> · {new Date(run.startedAt).toLocaleTimeString()}</p>
                          <p>{run.reasoningSummary}</p>
                          <p className="chat-v11-muted">
                            {[
                              run.originSurface ? `Surface ${run.originSurface}` : null,
                              run.linkedTaskId ? `Task ${run.linkedTaskId}` : null,
                              run.linkedDurableRunId ? `Run ${run.linkedDurableRunId}` : null,
                              run.approvalId ? `Approval ${run.approvalId}` : null,
                              run.nextWakeAt ? `Wake ${new Date(run.nextWakeAt).toLocaleString()}` : null,
                              run.stopReason ? `Stop ${run.stopReason}` : null,
                            ].filter(Boolean).join(" | ")}
                          </p>
                          {run.externalReferenceRoots?.length ? (
                            <p className="chat-v11-muted">
                              References: {run.externalReferenceRoots.map((root) => `${root.label} (${root.access})`).join(", ")}
                            </p>
                          ) : null}
                        </li>
                      ))}
                      {isCoworkSurface && proactiveRuns.length === 0 ? <li className="chat-v11-muted">No proactive runs yet for this session.</li> : null}
                    </ul>
                  ) : null}
                </Panel>
                </div>
                ) : null}

                {!isCodeSurface && showLearnedMemoryPanel ? (
                <div className="mission-dock-section" style={dockSectionStyle("memory")}>
                <Panel
                  className="chat-v11-agentic-card chat-v11-panel-memory"
                  title={(
                    <>
                      Learned memory <HelpHint label="Learned memory help" text="Learned memory stores facts, goals, preferences, and constraints GoatCitadel may reuse in future turns for this session." />
                    </>
                  )}
                  subtitle="Review what GoatCitadel is carrying forward for future turns in this session."
                  actions={(
                    <ActionButton
                      label="Rebuild"
                      disabled={sending || !selectedSessionId}
                      onClick={() => void handleRebuildLearnedMemory()}
                    />
                  )}
                >
                  {secondaryLoading && learnedMemory.length === 0 ? <CardSkeleton lines={5} /> : null}
                  <ul className="chat-v11-memory-list">
                    {learnedMemory.slice(0, 6).map((item) => (
                      <li key={item.itemId}>
                        <p>
                          <strong>{item.itemType}</strong>
                          {" · "}
                          Confidence {Math.round(item.confidence * 100)}%
                          <HelpHint label="Memory confidence help" text="Confidence is GoatCitadel's estimate of how reliable this memory is for future replies. It is not a completion score; higher means the system is more willing to reuse it." />
                          {" · "}
                          {item.status}
                          <HelpHint label="Memory status help" text={
                            item.status === "active"
                              ? "Active memory is currently eligible to influence future turns."
                              : item.status === "superseded"
                                ? "Superseded memory was replaced by a newer or more accurate item."
                                : item.status === "disabled"
                                  ? "Disabled memory stays in history but no longer influences future turns."
                                  : "Conflict means the memory needs review before it should influence future turns."
                          } />
                        </p>
                        <p>{item.content}</p>
                        <div className="chat-v11-row-actions">
                          <button type="button" title="Keep this memory active so it continues influencing future turns." disabled={sending} onClick={() => void handleMemoryStatusUpdate(item.itemId, "active")}>Keep</button>
                          <button type="button" title="Mark this memory as replaced by a newer or better one." disabled={sending} onClick={() => void handleMemoryStatusUpdate(item.itemId, "superseded")}>Supersede</button>
                          <button type="button" title="Stop using this memory without deleting its history." disabled={sending} onClick={() => void handleMemoryStatusUpdate(item.itemId, "disabled")}>Disable</button>
                        </div>
                      </li>
                    ))}
                    {learnedMemory.length === 0 ? <li className="chat-v11-muted">No learned memory items yet. They appear after completed assistant turns.</li> : null}
                  </ul>
                </Panel>
                </div>
                ) : null}

                <div className="mission-dock-section" style={dockSectionStyle("session")}>
                <Panel
                  className="chat-v11-session-bar chat-v11-panel-session"
                  title="Session management"
                  subtitle="Give this chat a human title, pin it, archive it, delete it, or move it into a project without leaving the thread."
                >
                  <FieldHelp>Titles replace autogenerated session keys in the chat rail.</FieldHelp>
                  <input value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} placeholder="Give this chat a title" />
                  <ActionButton label="Save" disabled={sending || Boolean(sessionControlPending)} pending={sessionControlPending === "rename"} onClick={async () => {
                    if (!selectedSession) return;
                    setSessionControlPending("rename");
                    try {
                      await updateChatSession(selectedSession.sessionId, { title: renameTitle.trim() || undefined });
                      await loadSidebar();
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setSessionControlPending(null);
                    }
                  }} />
                  <ActionButton label={selectedSession.pinned ? "Unpin" : "Pin"} disabled={sending || Boolean(sessionControlPending)} pending={sessionControlPending === "pin"} onClick={async () => {
                    if (!selectedSession) return;
                    setSessionControlPending("pin");
                    try {
                      if (selectedSession.pinned) await unpinChatSession(selectedSession.sessionId); else await pinChatSession(selectedSession.sessionId);
                      await loadSidebar();
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setSessionControlPending(null);
                    }
                  }} />
                  <ActionButton label={selectedSession.lifecycleStatus === "archived" ? "Restore" : "Archive"} disabled={sending || Boolean(sessionControlPending)} pending={sessionControlPending === "archive"} onClick={async () => {
                    if (!selectedSession) return;
                    setSessionControlPending("archive");
                    try {
                      if (selectedSession.lifecycleStatus === "archived") await restoreChatSession(selectedSession.sessionId); else await archiveChatSession(selectedSession.sessionId);
                      await loadSidebar();
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setSessionControlPending(null);
                    }
                  }} />
                  <ActionButton label="Delete permanently" disabled={sending || Boolean(sessionControlPending)} pending={sessionControlPending === "delete"} onClick={async () => {
                    if (!selectedSession) return;
                    const label = formatSessionLabel(selectedSession);
                    const confirmed = window.confirm(
                      `Delete "${label}" permanently?\n\nThis removes its messages, traces, session history, and attached files.`,
                    );
                    if (!confirmed) {
                      return;
                    }
                    setSessionControlPending("delete");
                    try {
                      await deleteChatSession(selectedSession.sessionId);
                      clearChatSessionLocalState(workspaceId, selectedSession.sessionId);
                      setQueuedOutbound((current) => current.filter((item) => item.sessionId !== selectedSession.sessionId));
                      setThread(null);
                      setSelectedSessionId((current) => current === selectedSession.sessionId ? null : current);
                      await loadSidebar();
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setSessionControlPending(null);
                    }
                  }} />
                  <GCCombobox
                    value={selectedSessionProjectValue}
                    onChange={(value) => {
                      setSessionControlPending("project");
                      void assignChatSessionProject(
                        selectedSession.sessionId,
                        value === "none" ? undefined : value,
                      )
                        .then(() => loadSidebar())
                        .catch((err) => setError((err as Error).message))
                        .finally(() => setSessionControlPending(null));
                    }}
                    placeholder="Pick project"
                    disabled={sending || Boolean(sessionControlPending)}
                    options={[
                      { value: "none", label: "Unassigned" },
                      ...(projects?.items ?? [])
                        .filter((item) => item.lifecycleStatus === "active")
                        .map((project) => ({ value: project.projectId, label: project.name })),
                    ]}
                  />
                </Panel>
                </div>

                {selectedSession.scope === "external" ? (
                  <div className="mission-dock-section" style={dockSectionStyle("external")}>
                  {(!binding || !binding.writable) ? <div className="status-banner warning">This external chat is read-only right now. Set a connection and target before sending replies out.</div> : null}
                  <Panel
                    className="chat-v11-external-bind"
                    title="External connection binding"
                    subtitle="Bind this session to a writable external channel before trying to send messages out."
                  >
                    <input value={integrationConnectionId} onChange={(event) => setIntegrationConnectionId(event.target.value)} placeholder="Connection ID (example: slack:workspace-a)" />
                    <input value={integrationTarget} onChange={(event) => setIntegrationTarget(event.target.value)} placeholder="Target (example: #ops-room or thread id)" />
                    <ActionButton label="Save binding" disabled={sending || Boolean(sessionControlPending)} pending={sessionControlPending === "binding"} onClick={async () => {
                      if (!selectedSession) return;
                      setSessionControlPending("binding");
                      try {
                        const next = await setChatSessionBinding(selectedSession.sessionId, { transport: "integration", connectionId: integrationConnectionId.trim(), target: integrationTarget.trim(), writable: true });
                        setBinding(next);
                      } catch (err) {
                        setError((err as Error).message);
                      } finally {
                        setSessionControlPending(null);
                      }
                    }} />
                  </Panel>
                  </div>
                ) : null}
                </MissionControlContextDock>
              </div>
            </div>
          ) : (
            <MissionControlEmptyState
              mode={messageMode}
              sessionCount={missionSessions.length + externalSessions.length}
              projectCount={projects?.items.length ?? 0}
              onCreateSession={() => void handleCreateSession(messageMode)}
            />
          )}
        </div>
      </div>
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
        onConfirm={() => {
          void handleArchiveWorkspaceMissionChats().finally(() => {
            setArchiveWorkspaceConfirmOpen(false);
          });
        }}
      />
    </section>
  );
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function formatCommandResult(result: { ok: boolean; message: string; research?: { sources: Array<{ url: string }> } }): string {
  const status = result.ok ? "Command completed" : "Command failed";
  if (!result.research) return `${status}: ${result.message}`;
  return `${status}: ${result.message}\nSources: ${result.research.sources.length}`;
}

function deriveCoworkItems(
  messages: ChatMessageRecord[],
  notices: ChatThreadNotice[],
  orchestration?: ChatThreadResponse["turns"][number]["trace"]["orchestration"],
): Array<{ id: string; title: string; note?: string }> {
  if (orchestration) {
    return orchestration.steps
      .slice(0, 5)
      .map((step) => ({
        id: step.stepId,
        title: `${step.role} · ${step.status}`,
        note: step.summary ?? step.error ?? [step.providerId, step.model].filter(Boolean).join(" · "),
      }));
  }
  const latestAssistant = [...messages].reverse().find((item) => item.role === "assistant");
  const latestUser = [...messages].reverse().find((item) => item.role === "user");
  const items: Array<{ id: string; title: string; note?: string }> = [];
  if (latestAssistant) {
    const lines = latestAssistant.content.split(/\r?\n/g).map((line) => line.trim()).filter((line) => line.length > 0).slice(0, 4);
    lines.forEach((line, index) => items.push({ id: `assistant-${index}`, title: line.slice(0, 88) }));
  }
  if (items.length < 3 && latestUser) {
    items.push({ id: "user-goal", title: "Current operator request", note: latestUser.content.slice(0, 180) });
  }
  if (items.length < 5) {
    notices
      .slice(0, 2)
      .forEach((notice, index) => {
        items.push({
          id: `notice-${notice.id}`,
          title: index === 0 ? "Latest system notice" : "Recent system notice",
          note: notice.content.slice(0, 180),
        });
      });
  }
  return items.slice(0, 5);
}

function abortActiveChatStream(stream: ActiveChatStreamState | null): void {
  if (!stream || stream.controller.signal.aborted) {
    return;
  }
  stream.controller.abort();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object"
      && error !== null
      && "name" in error
      && (error as { name?: string }).name === "AbortError";
}
