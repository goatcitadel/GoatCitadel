import {
  type ChatSessionBindingRecord,
  type ChatSessionPrefsRecord,
  type ChatSpecialistCandidateRecord,
  type ChatThreadResponse,
  type LearnedMemoryItemRecord,
  type McpServerRecord,
  type McpServerTemplateRecord,
  type ProactivePolicy,
  type ProactiveRunRecord,
  type SkillListItem,
} from "@goatcitadel/contracts";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  fetchChatCommandCatalog,
  fetchChatLearnedMemory,
  fetchChatProjects,
  fetchChatProactiveRuns,
  fetchChatProactiveStatus,
  fetchChatSessionBinding,
  fetchChatSessionPrefs,
  fetchChatSessions,
  fetchChatSpecialistCandidates,
  fetchChatThread,
  fetchMcpServers,
  fetchMcpTemplates,
  fetchSettings,
  fetchSkills,
  type ChatProjectsResponse,
  type ChatSessionsResponse,
  type RuntimeSettingsResponse,
} from "../../api/client";
import { useRefreshSubscription } from "../../hooks/useRefreshSubscription";
import { recordClientDiagnostic } from "../../state/dev-diagnostics-store";
import { recordChatRefreshPhase } from "./chat-causality";
import { resolveChatRefreshPlan } from "./chat-page-pure-helpers";

export interface CommandCatalogItem {
  command: string;
  usage: string;
  description: string;
}

export type ChatHistoryView = "active" | "archived";

export function useChatSessionData(input: {
  workspaceId: string;
  historyView: ChatHistoryView;
  selectedSessionId: string | null;
  setSelectedSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  runtimeLlmConfig: RuntimeSettingsResponse["llm"] | null;
  setError: (value: string | null) => void;
  applyFetchedThreadRef: MutableRefObject<(thread: ChatThreadResponse, requestVersion: number | null) => boolean>;
  messageMutationVersionRef: MutableRefObject<number>;
  lastLocalPrefMutationAtRef: MutableRefObject<number>;
}) {
  const {
    workspaceId,
    historyView,
    selectedSessionId,
    setSelectedSessionId,
    runtimeLlmConfig,
    setError,
    applyFetchedThreadRef,
    messageMutationVersionRef,
    lastLocalPrefMutationAtRef,
  } = input;

  const [projects, setProjects] = useState<ChatProjectsResponse | null>(null);
  const [sessions, setSessions] = useState<ChatSessionsResponse | null>(null);
  const [thread, setThread] = useState<ChatThreadResponse | null>(null);
  const [prefs, setPrefs] = useState<ChatSessionPrefsRecord | null>(null);
  const [binding, setBinding] = useState<ChatSessionBindingRecord | null>(null);
  const [settings, setSettings] = useState<RuntimeSettingsResponse | null>(null);
  const [commandCatalog, setCommandCatalog] = useState<CommandCatalogItem[]>([]);
  const [proactiveStatus, setProactiveStatus] = useState<ProactivePolicy | null>(null);
  const [proactiveRuns, setProactiveRuns] = useState<ProactiveRunRecord[]>([]);
  const [learnedMemory, setLearnedMemory] = useState<LearnedMemoryItemRecord[]>([]);
  const [specialistCandidates, setSpecialistCandidates] = useState<ChatSpecialistCandidateRecord[]>([]);
  const [installedSkills, setInstalledSkills] = useState<SkillListItem[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([]);
  const [mcpTemplates, setMcpTemplates] = useState<Array<McpServerTemplateRecord & { installed: boolean }>>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [secondaryLoading, setSecondaryLoading] = useState(false);

  const initializedRef = useRef(false);
  const loadCoreGenerationRef = useRef(0);
  const loadSecondaryGenerationRef = useRef(0);
  const lastLoadedSessionIdRef = useRef<string | null>(null);

  const loadSidebar = useCallback(
    async (nextHistoryView: ChatHistoryView = historyView) => {
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
    },
    [historyView, setSelectedSessionId, workspaceId],
  );

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
    setSettings((current) => (current ? { ...current, llm: runtimeLlmConfig } : current));
  }, [runtimeLlmConfig]);

  const loadSessionCoreState = useCallback(
    async (
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
        if (generation !== loadCoreGenerationRef.current) return;
        if (nextThread) {
          applyFetchedThreadRef.current(nextThread, messageVersionAtStart);
        }
        setBinding(nextBinding.item);
        setPrefs(nextPrefs);
      } finally {
        if (!background) {
          setMessagesLoading(false);
        }
      }
    },
    [applyFetchedThreadRef, messageMutationVersionRef],
  );

  const loadSessionSecondaryState = useCallback(
    async (
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
        if (generation !== loadSecondaryGenerationRef.current) return;
        setProactiveStatus(nextProactiveStatus.policy);
        setProactiveRuns(nextProactiveRuns.items);
        setLearnedMemory(nextMemory.items);
        setSpecialistCandidates(nextSpecialists.items);
      } finally {
        if (!background) {
          setSecondaryLoading(false);
        }
      }
    },
    [],
  );

  const loadSessionState = useCallback(
    async (
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
    },
    [loadSessionCoreState, loadSessionSecondaryState, setError],
  );

  const refreshViewState = useCallback(
    async (
      options: {
        refreshSidebar?: boolean;
        refreshSession?: "none" | "light" | "full";
        showIndicator?: boolean;
      } = {},
    ) => {
      if (!initializedRef.current) {
        return;
      }
      const shouldRefreshSidebar = options.refreshSidebar ?? true;
      const refreshSession = options.refreshSession ?? "light";
      const showIndicator = options.showIndicator ?? false;
      if (!shouldRefreshSidebar && refreshSession === "none") {
        return;
      }
      if (showIndicator) {
        setIsRefreshing(true);
      }
      try {
        recordChatRefreshPhase({
          phase: "plan_applied",
          sessionId: selectedSessionId,
          signal: {
            eventType: "refresh_plan",
            reason: "chat-refresh-view-state",
            source: "useChatSessionData.refreshViewState",
          },
          plan: {
            refreshSidebar: shouldRefreshSidebar,
            refreshSession,
          },
        });
        if (shouldRefreshSidebar) {
          await loadSidebar();
        }
        if (selectedSessionId && refreshSession !== "none") {
          if (refreshSession === "full") {
            await loadSessionState(selectedSessionId, { background: true, includeThread: true });
          } else {
            await loadSessionSecondaryState(selectedSessionId, { background: true });
          }
        }
        recordChatRefreshPhase({
          phase: "plan_completed",
          sessionId: selectedSessionId,
          signal: {
            eventType: "refresh_plan",
            reason: "chat-refresh-view-state",
            source: "useChatSessionData.refreshViewState",
          },
          plan: {
            refreshSidebar: shouldRefreshSidebar,
            refreshSession,
          },
        });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (showIndicator) {
          setIsRefreshing(false);
        }
      }
    },
    [loadSessionSecondaryState, loadSessionState, loadSidebar, selectedSessionId, setError],
  );

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
  }, [loadRuntimeCatalog, loadSidebar, setError]);

  useRefreshSubscription(
    "chat",
    async (signal) => {
      const now = Date.now();
      const plan = resolveChatRefreshPlan(signal, now - lastLocalPrefMutationAtRef.current < 2500);
      recordChatRefreshPhase({
        phase: "plan_resolved",
        sessionId: selectedSessionId,
        signal,
        plan,
        context: {
          recentLocalPrefMutation: now - lastLocalPrefMutationAtRef.current < 2500,
        },
      });
      await refreshViewState({
        ...plan,
        showIndicator: false,
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
    if (!selectedSessionId) {
      setThread(null);
      setPrefs(null);
      setBinding(null);
      setProactiveStatus(null);
      setProactiveRuns([]);
      setLearnedMemory([]);
      setSpecialistCandidates([]);
      setSecondaryLoading(false);
      lastLoadedSessionIdRef.current = null;
      return;
    }
    if (lastLoadedSessionIdRef.current !== selectedSessionId) {
      setThread(null);
      setPrefs(null);
      setBinding(null);
      setProactiveStatus(null);
      setProactiveRuns([]);
      setLearnedMemory([]);
      setSpecialistCandidates([]);
      setSecondaryLoading(false);
      lastLoadedSessionIdRef.current = selectedSessionId;
    }
    void loadSessionState(selectedSessionId, {
      background: false,
      includeThread: true,
      deferSecondary: true,
    }).catch((err: Error) => setError(err.message));
  }, [loadSessionState, selectedSessionId, setError]);

  return {
    projects,
    setProjects,
    sessions,
    setSessions,
    thread,
    setThread,
    prefs,
    setPrefs,
    binding,
    setBinding,
    settings,
    setSettings,
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
    loadRuntimeCatalog,
    loadSessionCoreState,
    loadSessionSecondaryState,
    loadSessionState,
    refreshViewState,
  };
}
