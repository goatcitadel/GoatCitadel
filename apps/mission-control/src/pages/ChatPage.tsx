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
  CHAT_MODE_PRESETS,
  getChatTurnRecoveryActionLabel,
  getChatTurnRecoveryActionSummary,
  type ChatAttachmentRecord,
  type ChatCapabilityUpgradeSuggestion,
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
  acceptChatDelegation,
  approveChatTool,
  archiveChatSession,
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
import { ChatQueueBar, type ChatQueueItemView } from "../components/chat/ChatQueueBar";
import { ChatSessionRail } from "../components/chat/ChatSessionRail";
import {
  isThreadMutatingStreamChunk,
  type PendingStreamTurnSeed,
  updateThreadFromStreamChunk,
} from "../components/chat/chat-thread-reducer";
import { ChatThreadView, type ChatThreadNotice } from "../components/chat/ChatThreadView";
import type { ChatStreamStatus } from "../components/chat/ChatStreamStatusBar";
import { ChatComposerPlusMenu } from "../components/ChatComposerPlusMenu";
import { ChatModeSwitch } from "../components/ChatModeSwitch";
import { ChatModelPicker, type ChatModelProviderOption } from "../components/ChatModelPicker";
import { ChatTraceCard } from "../components/ChatTraceCard";
import { CoworkCanvasPanel } from "../components/CoworkCanvasPanel";
import { DataToolbar } from "../components/DataToolbar";
import { FieldHelp } from "../components/FieldHelp";
import { HelpHint } from "../components/HelpHint";
import { InlineApprovalPrompt } from "../components/InlineApprovalPrompt";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatusChip } from "../components/StatusChip";
import { GCCombobox, GCSelect, GCSwitch } from "../components/ui";
import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import { pageCopy } from "../content/copy";
import {
  recordClientDiagnostic,
  setDevDiagnosticsActiveChatSession,
  setDevDiagnosticsLatestTraceSummary,
} from "../state/dev-diagnostics-store";
import "../styles/chat.css";

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
    mode: "parallel" as const,
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

interface CommandSuggestionItem {
  key: string;
  command: string;
  description: string;
  applyValue: string;
}

interface FinalizedStreamMessageState {
  sessionId: string;
  placeholderId: string;
  messageId?: string;
  content: string;
}

interface OutboundQueueItem {
  id: string;
  action: "send" | "edit" | "retry";
  sessionId?: string;
  targetTurnId?: string;
  content: string;
  attachments: ChatAttachmentRecord[];
  createdAt: string;
  paused?: boolean;
}

type SessionControlPending =
  | null
  | "rename"
  | "pin"
  | "archive"
  | "delete"
  | "project"
  | "binding";

function normalizeComparableAssistantContent(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
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

export function looksMachineSessionLabel(label: string | undefined, sessionKey?: string): boolean {
  const trimmed = label?.trim();
  if (!trimmed) {
    return true;
  }
  if (sessionKey && trimmed === sessionKey.trim()) {
    return true;
  }
  return /^(mission|external):/i.test(trimmed) || /:operator:chat_/i.test(trimmed);
}

export function formatSessionLabel(session: ChatSessionsResponse["items"][number]): string {
  const title = session.title?.trim();
  if (title && !looksMachineSessionLabel(title, session.sessionKey)) {
    return title;
  }
  if (session.scope === "external") {
    const channel = [session.channel, session.account].filter(Boolean).join(" / ");
    return channel ? `External chat - ${channel}` : `External chat - ${session.sessionId.slice(-6)}`;
  }
  return `Mission chat - ${session.sessionId.slice(-6)}`;
}

export function shouldShowTracePanel(
  mode: ChatMode,
  turn: ChatThreadResponse["turns"][number] | null,
): boolean {
  if (!turn) {
    return false;
  }
  if (mode !== "chat") {
    return true;
  }
  return turn.trace.status !== "completed"
    || Boolean(turn.trace.failure)
    || turn.trace.toolRuns.length > 0
    || Boolean(turn.trace.routing.fallbackUsed)
    || Boolean(turn.trace.orchestration);
}

export function shouldShowSuggestionsPanel(
  mode: ChatMode,
  input: {
    capabilitySuggestionCount: number;
    specialistSuggestionCount: number;
    specialistCandidateCount: number;
    proactiveSuggestionCount: number;
    hasDelegationSuggestion: boolean;
  },
): boolean {
  if (mode === "cowork") {
    return true;
  }
  if (mode === "code") {
    return input.capabilitySuggestionCount > 0
      || input.specialistSuggestionCount > 0
      || input.specialistCandidateCount > 0;
  }
  return input.capabilitySuggestionCount > 0
    || input.specialistSuggestionCount > 0
    || input.specialistCandidateCount > 0
    || input.proactiveSuggestionCount > 0
    || input.hasDelegationSuggestion;
}

export function shouldShowLearnedMemoryPanel(mode: ChatMode, learnedMemoryCount: number): boolean {
  if (mode === "chat") {
    return learnedMemoryCount > 0;
  }
  return true;
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

export function ChatPage({ workspaceId = "default" }: { workspaceId?: string }) {
  const [projects, setProjects] = useState<ChatProjectsResponse | null>(null);
  const [sessions, setSessions] = useState<ChatSessionsResponse | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("all");
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
  const [queuedOutbound, setQueuedOutbound] = useState<OutboundQueueItem[]>([]);
  const [installedSkills, setInstalledSkills] = useState<SkillListItem[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([]);
  const [mcpTemplates, setMcpTemplates] = useState<Array<McpServerTemplateRecord & { installed: boolean }>>([]);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
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
  const [integrationConnectionId, setIntegrationConnectionId] = useState("");
  const [integrationTarget, setIntegrationTarget] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [approvalPending, setApprovalPending] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [followThreadOutput, setFollowThreadOutput] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const dragDepthRef = useRef(0);
  const initializedRef = useRef(false);
  const lastLoadedSessionIdRef = useRef<string | null>(null);
  const messageMutationVersionRef = useRef(0);
  const lastLocalPrefMutationAtRef = useRef(0);
  const latestMessagesRef = useRef<ChatMessagesResponse["items"]>([]);
  const selectedSessionIdRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);
  const finalizedStreamMessageRef = useRef<FinalizedStreamMessageState | null>(null);
  const streamReconcileTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingRef = useRef(false);
  const prefsRef = useRef<ChatSessionPrefsRecord | null>(null);
  const threadRef = useRef<ChatThreadResponse | null>(null);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);
  const executeOutboundItemRef = useRef<(item: OutboundQueueItem) => Promise<void>>(async () => undefined);
  const {
    config: runtimeLlmConfig,
    providers: runtimeProviderCatalog,
    loadModelsForProvider,
  } = useProviderModelCatalog("chat");

  const loadSidebar = useCallback(async () => {
    recordClientDiagnostic({
      level: "debug",
      category: "chat",
      event: "sidebar.load",
      message: "Refreshing chat sidebar data",
      context: { workspaceId },
    });
    const [nextProjects, nextSessions] = await Promise.all([
      fetchChatProjects("all", 500, workspaceId),
      fetchChatSessions({ scope: "all", view: "all", limit: 500, workspaceId }),
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
  }, [workspaceId]);

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
    const generation = ++loadGenerationRef.current;
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
      if (generation !== loadGenerationRef.current) return; // stale response
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
    const generation = ++loadGenerationRef.current;
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
      if (generation !== loadGenerationRef.current) return; // stale response
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

  const externalSessions = useMemo(
    () => visibleSessions.filter((item) => item.scope === "external"),
    [visibleSessions],
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

  const selectedProviderId = prefs?.providerId ?? runtimeLlmConfig?.activeProviderId ?? settings?.llm.activeProviderId;

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
  }, [commandCatalog, draft, installedSkills, mcpServers, mcpTemplates]);

  useEffect(() => setCommandIndex(0), [draft]);

  const selectedSessionProjectValue = selectedSession?.projectId ?? "none";
  const messageMode = prefs?.mode ?? "chat";
  const activeModePreset = CHAT_MODE_PRESETS[messageMode];
  const isChatSurface = messageMode === "chat";
  const isCoworkSurface = messageMode === "cowork";
  const isCodeSurface = messageMode === "code";
  const codeModeNeedsProjectBinding = isCodeSurface && !selectedSession?.projectId;
  const selectedProjectBindingCandidateId = selectedProjectId !== "all" && selectedProjectId !== "none"
    ? selectedProjectId
    : undefined;
  const selectedProjectBindingCandidateName = selectedProjectBindingCandidateId
    ? (projects?.items ?? []).find((item) => item.projectId === selectedProjectBindingCandidateId)?.name
    : undefined;
  const planningMode = prefs?.planningMode ?? "off";
  const selectedTurn = useMemo(
    () => thread?.turns.find((turn) => turn.turnId === selectedTurnId) ?? thread?.turns.at(-1) ?? null,
    [selectedTurnId, thread],
  );
  const latestOrchestration = useMemo(
    () => selectedTurn?.trace.orchestration ?? thread?.turns.at(-1)?.trace.orchestration,
    [selectedTurn, thread],
  );
  const selectedTurnRecovery = useMemo(() => {
    const action = selectedTurn?.trace.failure?.recommendedAction;
    if (!action) {
      return null;
    }
    return {
      action,
      label: getChatTurnRecoveryActionLabel(action),
      summary: getChatTurnRecoveryActionSummary(action),
    };
  }, [selectedTurn]);
  const effectiveToolAutonomy = selectedTurn?.trace.effectiveToolAutonomy
    ?? (planningMode === "advisory" ? "manual" : prefs?.toolAutonomy);
  useEffect(() => {
    setCapabilitySuggestions(selectedTurn?.trace.capabilityUpgradeSuggestions ?? []);
    setSpecialistSuggestions(selectedTurn?.trace.specialistCandidateSuggestions ?? []);
  }, [selectedTurn]);
  const coworkItems = useMemo(
    () => deriveCoworkItems(messages, localNotices, latestOrchestration),
    [latestOrchestration, localNotices, messages],
  );
  const proactiveSuggestionCount = proactiveRuns.filter((run) => run.status === "suggested").length;
  const showTracePanel = shouldShowTracePanel(messageMode, selectedTurn);
  const showSuggestionsPanel = shouldShowSuggestionsPanel(messageMode, {
    capabilitySuggestionCount: capabilitySuggestions.length,
    specialistSuggestionCount: specialistSuggestions.length,
    specialistCandidateCount: specialistCandidates.filter((item) => item.status !== "retired").length,
    proactiveSuggestionCount,
    hasDelegationSuggestion: Boolean(delegationSuggestion),
  });
  const showLearnedMemoryPanel = shouldShowLearnedMemoryPanel(messageMode, learnedMemory.length);
  const canSend = Boolean(draft.trim()) && !sending;

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

  const finishOutboundExecution = useCallback(() => {
    sendingRef.current = false;
    setSending(false);
  }, []);

  const handleCreateSession = useCallback(async (mode: ChatMode) => {
    setCreatingSessionMode(mode);
    setError(null);
    try {
      const created = await createChatSession(
        selectedProjectId !== "all" && selectedProjectId !== "none"
          ? { workspaceId, projectId: selectedProjectId, mode }
          : { workspaceId, mode },
      );
      await loadSidebar();
      setSelectedSessionId(created.sessionId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreatingSessionMode(null);
    }
  }, [loadSidebar, selectedProjectId, workspaceId]);

  const ensureSession = useCallback(async (): Promise<ChatSessionRecord> => {
    if (selectedSession) return selectedSession;
    const created = await createChatSession(
      selectedProjectId !== "all" && selectedProjectId !== "none"
        ? { workspaceId, projectId: selectedProjectId, mode: "chat" }
        : { workspaceId, mode: "chat" },
    );
    await loadSidebar();
    setSelectedSessionId(created.sessionId);
    return created;
  }, [loadSidebar, selectedProjectId, selectedSession, workspaceId]);

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
      proactiveMode?: "off" | "suggest" | "auto_safe";
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

  const handleAcceptDelegation = useCallback(async () => {
    if (!selectedSession || !delegationSuggestion || sending) return;
    setSending(true);
    try {
      const accepted = await acceptChatDelegation(selectedSession.sessionId, {
        suggestionId: delegationSuggestion.suggestionId,
        objective: delegationSuggestion.objective,
        roles: delegationSuggestion.roles,
        mode: delegationSuggestion.mode,
        providerId: prefs?.providerId,
        model: prefs?.model,
      });
      pushLocalNotice(`Delegation completed:\n${accepted.stitchedOutput}`, "success");
      setDelegationSuggestion(null);
      await loadSidebar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [delegationSuggestion, loadSidebar, prefs?.model, prefs?.providerId, pushLocalNotice, selectedSession, sending]);

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
      const result = await runChatDelegation(selectedSession.sessionId, {
        objective: `${preset.prefix}${baseObjective}`,
        roles: [...preset.roles],
        mode: preset.mode,
        providerId: prefs?.providerId,
        model: prefs?.model,
      });
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
    selectedSession,
    sending,
  ]);

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
        pushLocalNotice(`Enabled skill ${updated.skillId}. You can retry the request now.`, "success");
        setInstalledSkills(await fetchSkills().then((result) => result.items));
        dismissCapabilitySuggestion(suggestion);
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
  }, [dismissCapabilitySuggestion, pushLocalNotice]);

  const handleCommandExecution = useCallback(async (sessionId: string, commandText: string) => {
    const result = await parseChatCommand(sessionId, commandText);
    if (result.prefs) setPrefs(result.prefs);
    pushLocalNotice(formatCommandResult(result), result.ok ? "success" : "warning");
    if (result.command === "/project") await loadSidebar();
    if (result.command === "/plan" && result.prefs) {
      setPrefs(result.prefs);
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
                providerId: currentPrefs?.providerId,
                model: currentPrefs?.model,
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
                providerId: currentPrefs?.providerId,
                model: currentPrefs?.model,
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
                providerId: currentPrefs?.providerId,
                model: currentPrefs?.model,
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
            providerId: currentPrefs?.providerId,
            model: currentPrefs?.model,
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
              providerId: currentPrefs?.providerId,
              model: currentPrefs?.model,
              webMode: currentPrefs?.webMode ?? "auto",
              memoryMode: currentPrefs?.memoryMode ?? "auto",
              thinkingLevel: currentPrefs?.thinkingLevel ?? "standard",
            })
            : await sendAgentChatMessage(session.sessionId, {
              content: trimmedContent,
              attachments: attachmentIds,
              useMemory: (currentPrefs?.memoryMode ?? "auto") !== "off",
              mode: currentPrefs?.mode ?? "chat",
              providerId: currentPrefs?.providerId,
              model: currentPrefs?.model,
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
    handleCommandExecution,
    loadSessionCoreState,
    loadSidebar,
    scheduleStreamMessageReconciliation,
    streamEnabled,
  ]);

  useEffect(() => {
    executeOutboundItemRef.current = executeOutboundItem;
  }, [executeOutboundItem]);

  const handleSend = useCallback(async () => {
    const content = draft.trim();
    if (!content) return;
    const nextItem: OutboundQueueItem = {
      id: `queue-${Date.now()}`,
      action: editingTurnId ? "edit" : "send",
      sessionId: selectedSessionId ?? undefined,
      targetTurnId: editingTurnId ?? undefined,
      content,
      attachments: pendingAttachments,
      createdAt: new Date().toISOString(),
    };
    setDraft("");
    setPendingAttachments([]);
    setPendingApproval(null);
    if (!tryBeginOutboundExecution()) {
      setQueuedOutbound((current) => [...current, nextItem]);
      pushLocalNotice(`${editingTurnId ? "Edit" : "Message"} queued while the current turn finishes.`);
      return;
    }
    await executeOutboundItem(nextItem);
  }, [draft, editingTurnId, executeOutboundItem, pendingAttachments, pushLocalNotice, selectedSessionId, tryBeginOutboundExecution]);

  const handleRetryTurn = useCallback(async (turnId: string) => {
    const nextItem: OutboundQueueItem = {
      id: `queue-${Date.now()}`,
      action: "retry",
      sessionId: selectedSessionId ?? undefined,
      targetTurnId: turnId,
      content: "",
      attachments: [],
      createdAt: new Date().toISOString(),
    };
    if (!tryBeginOutboundExecution()) {
      setQueuedOutbound((current) => [...current, nextItem]);
      pushLocalNotice("Retry queued while the current turn finishes.");
      return;
    }
    await executeOutboundItem(nextItem);
  }, [executeOutboundItem, pushLocalNotice, selectedSessionId, tryBeginOutboundExecution]);

  const handleStopActiveTurn = useCallback(async () => {
    if (!selectedSession) {
      return;
    }
    const activeStream = activeStreamRef.current;
    if (!activeStream) {
      return;
    }
    try {
      if (activeStream.turnId) {
        await cancelChatTurn(selectedSession.sessionId, activeStream.turnId, "mission-control");
        pushLocalNotice(`Stopped turn ${activeStream.turnId.slice(-6)}.`, "warning");
        void loadSessionCoreState(selectedSession.sessionId, {
          background: true,
          includeThread: true,
        }).catch(() => undefined);
      } else {
        pushLocalNotice("Stopped the local connection before the turn id was assigned.", "warning");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      abortActiveChatStream(activeStream);
    }
  }, [loadSessionCoreState, pushLocalNotice, selectedSession]);

  const handleBeginEditTurn = useCallback((turnId: string) => {
    const turn = thread?.turns.find((item) => item.turnId === turnId);
    if (!turn) {
      return;
    }
    setEditingTurnId(turnId);
    setDraft(turn.userMessage.content);
    composerRef.current?.focus();
  }, [thread]);

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

  const handleResumeQueue = useCallback(() => {
    recordClientDiagnostic({
      level: "info",
      category: "chat",
      event: "queue.resume",
      message: "Resuming queued outbound chat items",
      sessionId: selectedSessionId ?? undefined,
      context: {
        queuedCount: queuedOutbound.length,
      },
    });
    setQueuedOutbound((current) => current.map((item) => ({ ...item, paused: false })));
  }, [queuedOutbound.length, selectedSessionId]);

  const handleRemoveQueuedItem = useCallback((id: string) => {
    recordClientDiagnostic({
      level: "info",
      category: "chat",
      event: "queue.remove",
      message: "Removed queued outbound chat item",
      sessionId: selectedSessionId ?? undefined,
      context: { id },
    });
    setQueuedOutbound((current) => current.filter((item) => item.id !== id));
  }, [selectedSessionId]);

  useEffect(() => {
    if (sendingRef.current || sending) {
      return;
    }
    const nextItem = queuedOutbound.find((item) => !item.paused);
    if (!nextItem) {
      return;
    }
    if (!tryBeginOutboundExecution()) {
      return;
    }
    setQueuedOutbound((current) => current.filter((item) => item.id !== nextItem.id));
    void executeOutboundItemRef.current(nextItem);
  }, [queuedOutbound, sending, tryBeginOutboundExecution]);

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
    try {
      const updated = await updateChatSessionPrefs(selectedSession.sessionId, patch);
      setPrefs(updated);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selectedSession]);

  if (loading) {
    return (
      <section className="chat-v11">
      <PageHeader
        eyebrow="Work Surface"
        title={pageCopy.chat.title}
        subtitle={pageCopy.chat.subtitle}
        hint="Mission sessions, external writeback sessions, trace visibility, and inline approvals live together here."
        className="page-header-command chat-v11-header"
      />
        <CardSkeleton lines={8} />
      </section>
    );
  }

  return (
    <section className="chat-v11">
      <PageHeader
        eyebrow="Work Surface"
        title={pageCopy.chat.title}
        subtitle={pageCopy.chat.subtitle}
        hint="Start a chat quickly, keep session context visible, and use the inspector when you want trace, suggestions, and learned memory."
        className="page-header-command chat-v11-header"
        actions={(
          <div className="chat-v11-page-actions">
            <StatusChip tone={selectedSessionId ? "live" : "muted"}>{selectedSessionId ? "Session selected" : "No session"}</StatusChip>
            {selectedSession ? (
              <StatusChip tone={selectedSession.scope === "external" ? "warning" : "success"}>
                {selectedSession.scope === "external" ? "External writeback" : "Mission session"}
              </StatusChip>
            ) : null}
            {selectedTurn ? <StatusChip tone="muted">{selectedTurn.trace.status}</StatusChip> : null}
            <HelpHint
              label="Chat workspace help"
              text="Use slash commands for quick control, switch mode and model from the toolbar, and keep the inspector open when you want trace, suggestions, or learned memory details."
            />
          </div>
        )}
      />
      <PageGuideCard
        pageId="chat"
        what={pageCopy.chat.guide?.what ?? ""}
        when={pageCopy.chat.guide?.when ?? ""}
        actions={pageCopy.chat.guide?.actions ?? []}
        terms={pageCopy.chat.guide?.terms}
        defaultExpanded={false}
        preferenceVersion="v3"
      />
      {error ? <p className="error">{error}</p> : null}
      {isRefreshing ? <p className="status-banner">Refreshing chat context...</p> : null}

      <div className="chat-v11-shell">
        <aside className="panel panel-soft panel-pad-default chat-v11-left">
          <div className="chat-v11-left-head">
            <div className="chat-v11-left-actions">
              <div className="chat-v11-row-actions">
                {(["chat", "cowork", "code"] as const).map((mode) => (
                  <ActionButton
                    key={mode}
                    label={`New ${CHAT_MODE_PRESETS[mode].label}`}
                    pending={creatingSessionMode === mode}
                    disabled={sending || Boolean(creatingSessionMode)}
                    onClick={() => handleCreateSession(mode)}
                  />
                ))}
              </div>
              <button
                type="button"
                className={`chat-v11-project-toggle${showProjectCreate ? " active" : ""}`}
                onClick={() => setShowProjectCreate((current) => !current)}
              >
                {showProjectCreate ? "Hide project form" : "New project"}
              </button>
            </div>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a chat..." />
          </div>
          <p className="chat-v11-muted">
            Chat is fastest. Cowork keeps multi-step work visible. Code is for project-bound implementation and review.
          </p>
          <FieldHelp>Mission chats are local GoatCitadel sessions. External chats are routed sessions that can write back only when a binding is configured.</FieldHelp>
          {showProjectCreate ? (
            <div className="chat-v11-project-create">
              <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="New project name" />
              <input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="Project path (optional)" />
              <p className="chat-v11-muted">
                Project creation is optional. Leave the workspace on <strong>Main</strong> and start with <strong>Chat</strong> for quick work, or pick <strong>Code</strong> when you are ready to bind implementation to a project.
              </p>
              <button type="button" onClick={async () => {
                const name = projectName.trim();
                if (!name) return;
                setSending(true);
                try {
                  const created = await createChatProject({
                    workspaceId,
                    name,
                    workspacePath: projectPath.trim() || "chat/default",
                  });
                  setProjectName("");
                  setShowProjectCreate(false);
                  setSelectedProjectId(created.projectId);
                  await loadSidebar();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setSending(false);
                }
              }}>Create project</button>
            </div>
          ) : null}
          <div className="chat-v11-filter-row">
            <button type="button" className={selectedProjectId === "all" ? "active" : ""} onClick={() => setSelectedProjectId("all")}>All projects</button>
            <button type="button" className={selectedProjectId === "none" ? "active" : ""} onClick={() => setSelectedProjectId("none")}>Unassigned</button>
          </div>
          <ChatSessionRail
            missionSessions={missionSessions}
            externalSessions={externalSessions}
            selectedSessionId={selectedSessionId}
            onSelectSession={setSelectedSessionId}
            renderSessionLabel={(sessionId) => visibleSessionLabelById.get(sessionId) ?? `Chat ${sessionId.slice(-6)}`}
          />
        </aside>

        <div className="chat-v11-main">
          {selectedSession ? (
            <div className="chat-v11-conversation-shell">
              <div className={`chat-v11-main-grid ${messageMode === "cowork" ? "with-cowork" : ""}`}>
                <article className={`card chat-v11-thread mode-${messageMode}`}>
                  <div className="chat-v11-thread-scroll">
                    <ChatThreadView
                      loading={messagesLoading}
                      thread={thread}
                      selectedTurnId={selectedTurnId}
                      notices={localNotices}
                      followOutput={followThreadOutput}
                      streamStatus={streamStatus}
                      queuedCount={queuedOutbound.length}
                      streamError={error}
                      onBottomStateChange={setFollowThreadOutput}
                      onSelectTurn={setSelectedTurnId}
                      onSwitchBranch={(turnId) => void handleSelectBranchTurn(turnId)}
                      onRetryTurn={(turnId) => void handleRetryTurn(turnId)}
                      onEditTurn={handleBeginEditTurn}
                    />
                  </div>

                  {pendingApproval ? <InlineApprovalPrompt approvalId={pendingApproval.approvalId} toolName={pendingApproval.toolName} reason={pendingApproval.reason} pending={approvalPending} onApprove={() => void handleApprovePending()} onDeny={() => void handleDenyPending()} /> : null}

                  <div className={`chat-v11-composer ${isDragActive ? "drop-active" : ""}`} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
                    {isDragActive ? <div className="chat-drop-overlay">Drop files to attach</div> : null}
                    <ChatQueueBar
                      items={queuedOutbound.map((item): ChatQueueItemView => ({
                        id: item.id,
                        action: item.action,
                        label: item.content.trim() ? item.content.trim().slice(0, 96) : `Turn ${item.targetTurnId?.slice(-6) ?? "queued"}`,
                        createdAt: item.createdAt,
                        paused: item.paused,
                      }))}
                      onResumeAll={handleResumeQueue}
                      onRemove={handleRemoveQueuedItem}
                    />
                    {editingTurnId ? (
                      <div className="chat-v11-composer-banner">
                        Editing branch from turn {editingTurnId.slice(-6)}.
                        <button type="button" onClick={() => setEditingTurnId(null)}>Cancel edit</button>
                      </div>
                    ) : null}
                    {planningMode === "advisory" ? (
                      <div className="chat-v11-composer-banner planning">
                        Planning mode is on. GoatCitadel will respond with a plan/spec instead of executing tool work automatically.
                        {effectiveToolAutonomy === "manual" ? " Manual tool execution is enforced for this turn." : ""}
                      </div>
                    ) : null}
                    {selectedTurnRecovery && selectedTurn && selectedTurn.trace.status !== "waiting_for_approval" ? (
                      <div className="chat-v11-composer-banner recovery">
                        Next step: <strong>{selectedTurnRecovery.label}.</strong> {selectedTurnRecovery.summary}
                        {selectedTurnRecovery.action === "retry" || selectedTurnRecovery.action === "retry_narrower" ? (
                          <button type="button" disabled={sending} onClick={() => void handleRetryTurn(selectedTurn.turnId)}>
                            Retry turn
                          </button>
                        ) : null}
                        {selectedTurnRecovery.action === "switch_to_deep_mode" && (prefs?.webMode ?? "auto") !== "deep" ? (
                          <button type="button" disabled={!selectedSessionId || sending} onClick={() => void handlePrefPatch({ webMode: "deep" })}>
                            Set Deep mode
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    <textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKeyDown} onPaste={handleComposerPaste} placeholder="Ask GoatCitadel anything... Try /help" rows={4} />
                    {commandSuggestions.length > 0 ? (
                      <div className="chat-v11-command-popover" role="listbox" aria-label="Slash command suggestions">
                        {commandSuggestions.map((item, index) => (
                          <button key={item.key} type="button" className={index === commandIndex ? "active" : ""} onClick={() => applyDraftCommand(item.applyValue)}>
                            <strong>{item.command}</strong>
                            <span>{item.description}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {pendingAttachments.length > 0 ? (
                      <div className="chat-v11-pending-attachments">
                        {pendingAttachments.map((item) => (
                          <button key={item.attachmentId} type="button" className="chat-attachment-chip" onClick={() => setPendingAttachments((current) => current.filter((entry) => entry.attachmentId !== item.attachmentId))}>{item.fileName} ×</button>
                        ))}
                      </div>
                    ) : null}
                    <div className="chat-v11-composer-actions">
                      <ChatComposerPlusMenu disabled={sending} onAttachFiles={() => fileInputRef.current?.click()} onRunQuickResearch={() => { void handleRunQuickResearch(); }} />
                      <input ref={fileInputRef} type="file" multiple className="chat-v11-hidden-file" onChange={(event) => {
                        const files = event.target.files;
                        if (!files || files.length === 0) return;
                        void uploadAttachments(Array.from(files));
                      }} />
                      <p>Tip: drag files here, paste screenshots, press Enter to send, or queue the next prompt while a turn is still streaming.</p>
                      {sending && activeStreamRef.current ? (
                        <button type="button" onClick={() => void handleStopActiveTurn()}>
                          {activeStreamRef.current.turnId ? "Stop turn" : "Stop stream"}
                        </button>
                      ) : (
                        <button type="button" disabled={!canSend} onClick={() => void handleSend()}>
                          {sending ? "Sending..." : editingTurnId ? "Edit and resend" : "Send message"}
                        </button>
                      )}
                    </div>
                  </div>
                </article>
                {isCoworkSurface ? <CoworkCanvasPanel items={coworkItems} orchestration={latestOrchestration} /> : null}
              </div>
              <aside className="chat-v11-inspector-lane">
                <Panel
                  className="chat-v11-topbar-panel"
                  padding="compact"
                  title="Conversation controls"
                  subtitle={activeModePreset.summary}
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
                      Code mode is unbound. Assign a project in Session controls before execution-heavy work. Until then GoatCitadel stays in manual execution posture.
                      {selectedSession && selectedProjectBindingCandidateId ? (
                        <>
                          {" "}
                          <button
                            type="button"
                            disabled={sending || Boolean(sessionControlPending)}
                            onClick={() => {
                              setSessionControlPending("project");
                              void assignChatSessionProject(selectedSession.sessionId, selectedProjectBindingCandidateId)
                                .then(loadSidebar)
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
                  <DataToolbar
                    primary={(
                      <>
                        <ChatModeSwitch value={messageMode} disabled={!selectedSessionId || sending} onChange={(mode) => void handlePrefPatch({ mode })} />
                        <ChatModelPicker
                          providers={providerOptions}
                          providerId={selectedProviderId}
                          model={prefs?.model ?? runtimeLlmConfig?.activeModel ?? settings?.llm.activeModel}
                          disabled={!selectedSessionId || sending}
                          onChangeProvider={(providerId) => {
                            const provider = providerOptions.find((item) => item.providerId === providerId);
                            void loadModelsForProvider(providerId);
                            void handlePrefPatch({ providerId, model: provider?.models[0] });
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
                        {isCoworkSurface ? (
                          <>
                            <label className="chat-v11-select">Proactive
                              <GCSelect
                                value={proactiveStatus?.mode ?? prefs?.proactiveMode ?? "off"}
                                disabled={!selectedSessionId || sending}
                                onChange={(value) => void handleProactivePolicyPatch({ proactiveMode: value as "off" | "suggest" | "auto_safe" })}
                                options={[
                                  { value: "off", label: "Off" },
                                  { value: "suggest", label: "Suggest" },
                                  { value: "auto_safe", label: "Auto-safe" },
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
                            <button type="button" disabled={!selectedSessionId || sending} onClick={() => void handleSuggestDelegation()}>
                              Suggest delegation
                            </button>
                            <button type="button" disabled={!selectedSessionId || sending} onClick={() => void handleTriggerProactive()}>
                              Run proactive
                            </button>
                          </>
                        ) : null}
                        <GCSwitch checked={streamEnabled} onCheckedChange={setStreamEnabled} label="Stream" />
                      </>
                    )}
                  />
                  <FieldHelp>{activeModePreset.growthPolicySummary}</FieldHelp>
                  {isCodeSurface ? (
                    <div className="chat-v11-suggestion-card">
                      <p><strong>Code delegation accelerators:</strong> Launch focused implement, review, test, or full ship-cycle runs without leaving the session.</p>
                      <div className="chat-v11-row-actions">
                        {(Object.entries(CODE_DELEGATION_PRESETS) as Array<[keyof typeof CODE_DELEGATION_PRESETS, (typeof CODE_DELEGATION_PRESETS)[keyof typeof CODE_DELEGATION_PRESETS]]>).map(([key, preset]) => (
                          <button
                            key={key}
                            type="button"
                            disabled={!selectedSessionId || sending || codeModeNeedsProjectBinding}
                            onClick={() => void handleRunCodeDelegation(key)}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                      {codeModeNeedsProjectBinding ? (
                        <p className="chat-v11-muted">Code delegation is blocked until this session is bound to a project.</p>
                      ) : null}
                    </div>
                  ) : null}
                  {isChatSurface ? null : (
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
                      {isCodeSurface ? (
                        <label className="chat-v11-select">Code apply
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
                        </label>
                      ) : null}
                    </div>
                  )}
                  <FieldHelp>{activeModePreset.teamBehaviorSummary}</FieldHelp>
                </Panel>
                {showTracePanel && selectedTurn ? (
                  <Panel
                    className="chat-v11-agentic-card chat-v11-trace-card"
                    title={isChatSurface ? "Run status" : "Run trace"}
                    actions={(
                      <StatusChip tone={selectedTurn.trace.status === "completed" ? "success" : selectedTurn.trace.status === "failed" ? "critical" : "warning"}>
                        {selectedTurn.trace.status}
                      </StatusChip>
                    )}
                  >
                    <ChatTraceCard trace={selectedTurn.trace} defaultCollapsed={isChatSurface} />
                  </Panel>
                ) : null}
                {showSuggestionsPanel ? (
                <Panel
                  className="chat-v11-agentic-card"
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
                        </li>
                      ))}
                      {isCoworkSurface && proactiveRuns.length === 0 ? <li className="chat-v11-muted">No proactive runs yet for this session.</li> : null}
                    </ul>
                  ) : null}
                </Panel>
                ) : null}

                {showLearnedMemoryPanel ? (
                <Panel
                  className="chat-v11-agentic-card"
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
                ) : null}

                <Panel
                  className="chat-v11-session-bar"
                  title="Session controls"
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
                        .then(loadSidebar)
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

                {selectedSession.scope === "external" && (!binding || !binding.writable) ? <div className="status-banner warning">This external chat is read-only right now. Set a connection and target before sending replies out.</div> : null}
                {selectedSession.scope === "external" ? (
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
                ) : null}
              </aside>
            </div>
          ) : (
            <article className="card chat-v11-empty-shell">
              <h3>No chat selected</h3>
              <p className="office-subtitle">Pick a session from the left, or start Chat, Cowork, or Code from the sidebar. You do not need to create a project first unless you want Code mode to execute against one.</p>
            </article>
          )}
        </div>
      </div>
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
