import {
  type ChatMode,
  type ChatHistoryWindowResponse,
  type ChatSessionSearchHitRecord,
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
  fetchChatGeneratedArtifacts,
  fetchChatHistoryWindow,
  fetchChatHistoryContinuation,
  fetchChatCommandCatalog,
  fetchChatLearnedMemory,
  fetchChatProjects,
  fetchChatProactiveRuns,
  fetchChatProactiveStatus,
  fetchChatSessionBinding,
  fetchChatSessionPrefs,
  fetchChatSessions,
  fetchChatSessionSearch,
  fetchChatSpecialistCandidates,
  fetchChatThread,
  fetchThreadKnowledgeAttachments,
  fetchMcpServers,
  fetchMcpTemplates,
  fetchSettings,
  fetchSkills,
  type ChatProjectsResponse,
  type ChatGeneratedArtifactsResponse,
  type ChatSessionsResponse,
  type ChatThreadKnowledgeAttachmentsResponse,
  type RuntimeSettingsResponse,
} from "@goatcitadel/mission-control-shared/api/client";
import { useRefreshSubscription } from "@goatcitadel/mission-control-shared/hooks/useRefreshSubscription";
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import { recordChatRefreshPhase } from "./chat-causality";
import { resolveChatRefreshPlan } from "./chat-page-pure-helpers";

export interface CommandCatalogItem {
  command: string;
  usage: string;
  description: string;
}

export type ChatHistoryView = "active" | "archived";

const INITIAL_ACTIVE_SESSION_LIMIT = 100;
const INITIAL_ARCHIVED_SESSION_LIMIT = 150;
const SEARCH_SESSION_LIMIT = 250;
const DEV_BOOTSTRAP_CACHE_TTL_MS = 5000;
const SHOULD_REUSE_DEV_BOOTSTRAP_FETCHES = process.env.NODE_ENV !== "production";

type BootstrapCacheEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
};

type SidebarBootstrapResult = {
  projects: ChatProjectsResponse;
  sessions: ChatSessionsResponse;
};

export type ChatSidebarLoadOptions = {
  bypassCache?: boolean;
  preferredSessionId?: string | null;
  append?: boolean;
};

type RuntimeCatalogBootstrapResult = {
  runtimeSettings: RuntimeSettingsResponse;
  commands: { items: CommandCatalogItem[] };
  skills: { items: SkillListItem[] };
  servers: { items: McpServerRecord[] };
  templates: { items: Array<McpServerTemplateRecord & { installed: boolean }> };
};

const sidebarBootstrapCache = new Map<string, BootstrapCacheEntry<SidebarBootstrapResult>>();
const runtimeCatalogBootstrapCache = new Map<string, BootstrapCacheEntry<RuntimeCatalogBootstrapResult>>();

function resolveSidebarSessionLimit(historyView: ChatHistoryView, searchQuery: string): number {
  if (searchQuery.trim()) {
    return SEARCH_SESSION_LIMIT;
  }
  return historyView === "archived" ? INITIAL_ARCHIVED_SESSION_LIMIT : INITIAL_ACTIVE_SESSION_LIMIT;
}

function getDevBootstrapPromise<T>(
  cache: Map<string, BootstrapCacheEntry<T>>,
  key: string,
  factory: () => Promise<T>,
  options: { bypassCache?: boolean } = {},
): Promise<T> {
  if (!SHOULD_REUSE_DEV_BOOTSTRAP_FETCHES || options.bypassCache) {
    if (options.bypassCache) {
      cache.delete(key);
    }
    return factory();
  }

  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = factory();
  // Only cache successful results: evict the entry immediately on rejection so a single
  // transient failure is not replayed from cache for the whole TTL window (which made the
  // sidebar/runtime catalog appear broken until the entry expired). `promise` itself still
  // rejects for the caller.
  promise.then(
    () => {
      globalThis.setTimeout(() => {
        const current = cache.get(key);
        if (current?.promise === promise && current.expiresAt <= Date.now()) {
          cache.delete(key);
        }
      }, DEV_BOOTSTRAP_CACHE_TTL_MS);
    },
    () => {
      const current = cache.get(key);
      if (current?.promise === promise) {
        cache.delete(key);
      }
    },
  );

  cache.set(key, {
    promise,
    expiresAt: now + DEV_BOOTSTRAP_CACHE_TTL_MS,
  });
  return promise;
}

export function useChatSessionData(input: {
  workspaceId: string;
  historyView: ChatHistoryView;
  searchQuery: string;
  selectedSessionId: string | null;
  setSelectedSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  runtimeLlmConfig: RuntimeSettingsResponse["llm"] | null;
  setError: (value: string | null) => void;
  applyFetchedThreadRef: MutableRefObject<(thread: ChatThreadResponse, requestVersion: number | null) => boolean>;
  messageMutationVersionRef: MutableRefObject<number>;
  lastLocalPrefMutationAtRef: MutableRefObject<number>;
  surfaceMode?: ChatMode;
}) {
  const {
    workspaceId,
    historyView,
    searchQuery,
    selectedSessionId,
    setSelectedSessionId,
    runtimeLlmConfig,
    setError,
    applyFetchedThreadRef,
    messageMutationVersionRef,
    lastLocalPrefMutationAtRef,
    surfaceMode,
  } = input;

  const [projects, setProjects] = useState<ChatProjectsResponse | null>(null);
  const [sessions, setSessions] = useState<ChatSessionsResponse | null>(null);
  const [thread, setThread] = useState<ChatThreadResponse | null>(null);
  const [prefs, setPrefs] = useState<ChatSessionPrefsRecord | null>(null);
  const [binding, setBinding] = useState<ChatSessionBindingRecord | null>(null);
  const [generatedArtifacts, setGeneratedArtifacts] = useState<ChatGeneratedArtifactsResponse | null>(null);
  const [threadKnowledgeAttachments, setThreadKnowledgeAttachments] =
    useState<ChatThreadKnowledgeAttachmentsResponse | null>(null);
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
  const [sidebarNextCursor, setSidebarNextCursor] = useState<string | null>(null);
  const [sidebarLoadingMore, setSidebarLoadingMore] = useState(false);
  const [historicalWindow, setHistoricalWindow] = useState<ChatHistoryWindowResponse | null>(null);
  const [historicalWindowLoading, setHistoricalWindowLoading] = useState(false);
  const [historicalWindowError, setHistoricalWindowError] = useState<string | null>(null);
  const [historicalWindowTarget, setHistoricalWindowTarget] = useState<{
    workspaceId: string;
    sessionId: string;
  } | null>(null);
  const [historicalContinuationLoading, setHistoricalContinuationLoading] = useState<"older" | "newer" | null>(null);
  const [historicalContinuationError, setHistoricalContinuationError] = useState<string | null>(null);

  const initializedRef = useRef(false);
  const sidebarNextCursorRef = useRef<string | null>(null);
  const loadCoreGenerationRef = useRef(0);
  const loadSecondaryGenerationRef = useRef(0);
  const loadSidebarGenerationRef = useRef(0);
  const historicalWindowGenerationRef = useRef(0);
  const historicalContinuationGenerationRef = useRef(0);
  const lastLoadedSessionIdRef = useRef<string | null>(null);
  const refreshSubscriptionStartedAtRef = useRef<number>(0);
  const updateSidebarNextCursor = useCallback((nextCursor: string | null) => {
    sidebarNextCursorRef.current = nextCursor;
    setSidebarNextCursor(nextCursor);
  }, []);
  const clearSessionScopedState = useCallback(() => {
    setThread(null);
    setPrefs(null);
    setBinding(null);
    setGeneratedArtifacts(null);
    setThreadKnowledgeAttachments(null);
    setProactiveStatus(null);
    setProactiveRuns([]);
    setLearnedMemory([]);
    setSpecialistCandidates([]);
    setMessagesLoading(false);
    setSecondaryLoading(false);
  }, []);

  const loadSidebar = useCallback(
    async (nextHistoryView: ChatHistoryView = historyView, options: ChatSidebarLoadOptions = {}) => {
      const generation = ++loadSidebarGenerationRef.current;
      const trimmedSearchQuery = searchQuery.trim();
      const sessionLimit = resolveSidebarSessionLimit(nextHistoryView, trimmedSearchQuery);
      const append = Boolean(options.append && !trimmedSearchQuery);
      const cursor = append ? (sidebarNextCursorRef.current ?? undefined) : undefined;
      if (append && !cursor) {
        return;
      }
      if (!append) {
        setSidebarLoadingMore(false);
      }
      recordClientDiagnostic({
        level: "debug",
        category: "chat",
        event: "sidebar.load",
        message: "Refreshing chat sidebar data",
        context: {
          workspaceId,
          historyView: nextHistoryView,
          sessionLimit,
          append,
          surfaceMode: surfaceMode ?? null,
        },
      });
      if (append) {
        setSidebarLoadingMore(true);
        try {
          const nextSessions = await fetchChatSessions({
            scope: "all",
            view: nextHistoryView,
            limit: sessionLimit,
            workspaceId,
            cursor,
            mode: surfaceMode,
          });
          if (generation !== loadSidebarGenerationRef.current) return;
          setSessions((current) => {
            if (!current) {
              return nextSessions;
            }
            const seenSessionIds = new Set(current.items.map((item) => item.sessionId));
            return {
              ...nextSessions,
              items: [
                ...current.items,
                ...nextSessions.items.filter((item) => {
                  if (seenSessionIds.has(item.sessionId)) {
                    return false;
                  }
                  seenSessionIds.add(item.sessionId);
                  return true;
                }),
              ],
            };
          });
          updateSidebarNextCursor(nextSessions.nextCursor ?? null);
        } catch (error) {
          if (generation === loadSidebarGenerationRef.current) throw error;
        } finally {
          if (generation === loadSidebarGenerationRef.current) {
            setSidebarLoadingMore(false);
          }
        }
        return;
      }
      const cacheKey = `${workspaceId}:${nextHistoryView}:${trimmedSearchQuery}:${sessionLimit}:${surfaceMode ?? "all"}`;
      let nextProjects: ChatProjectsResponse;
      let nextSessions: ChatSessionsResponse;
      try {
        ({ projects: nextProjects, sessions: nextSessions } = await getDevBootstrapPromise(
          sidebarBootstrapCache,
          cacheKey,
          async () => {
            const [projects, sessions] = await Promise.all([
              fetchChatProjects("all", sessionLimit, workspaceId),
              trimmedSearchQuery
                ? fetchChatSessionSearch({
                    query: trimmedSearchQuery,
                    mode: "discovery",
                    view: nextHistoryView,
                    limit: sessionLimit,
                    workspaceId,
                    surface: surfaceMode,
                  }).then<ChatSessionsResponse>((response) => ({
                    items: response.items.map((item) => ({
                      ...item.session,
                      searchHits: item.hits,
                    })),
                    nextCursor: response.nextCursor,
                  }))
                : fetchChatSessions({
                    scope: "all",
                    view: nextHistoryView,
                    limit: sessionLimit,
                    workspaceId,
                    mode: surfaceMode,
                  }),
            ]);
            return { projects, sessions };
          },
          { bypassCache: options.bypassCache },
        ));
      } catch (error) {
        if (generation === loadSidebarGenerationRef.current) throw error;
        return;
      }
      if (generation !== loadSidebarGenerationRef.current) return;
      setProjects(nextProjects);
      setSessions(nextSessions);
      updateSidebarNextCursor(nextSessions.nextCursor ?? null);
      setSelectedSessionId((current) => {
        const preferredSessionId = options.preferredSessionId?.trim();
        if (preferredSessionId && nextSessions.items.some((item) => item.sessionId === preferredSessionId)) {
          return preferredSessionId;
        }
        if (!current) {
          return nextSessions.items[0]?.sessionId ?? null;
        }
        return nextSessions.items.some((item) => item.sessionId === current)
          ? current
          : (nextSessions.items[0]?.sessionId ?? null);
      });
    },
    [historyView, searchQuery, setSelectedSessionId, surfaceMode, updateSidebarNextCursor, workspaceId],
  );

  const openHistoricalWindow = useCallback(
    async (sessionId: string, hit: ChatSessionSearchHitRecord) => {
      const generation = ++historicalWindowGenerationRef.current;
      historicalContinuationGenerationRef.current += 1;
      const target = { workspaceId, sessionId };
      setHistoricalWindowTarget(target);
      setHistoricalWindow(null);
      setHistoricalWindowError(null);
      setHistoricalContinuationError(null);
      setHistoricalContinuationLoading(null);
      if (hit.workspaceId !== workspaceId || hit.sessionId !== sessionId) {
        setHistoricalWindowError("Search result identity does not belong to the selected workspace and conversation");
        setHistoricalWindowLoading(false);
        return false;
      }
      setHistoricalWindowLoading(true);
      try {
        const nextWindow = await fetchChatHistoryWindow({
          workspaceId: hit.workspaceId,
          sessionId: hit.sessionId,
          messageId: hit.messageId,
          sequence: hit.sequence,
        });
        if (generation !== historicalWindowGenerationRef.current) return false;
        if (
          nextWindow.anchor.workspaceId !== workspaceId ||
          nextWindow.anchor.sessionId !== sessionId ||
          nextWindow.anchor.messageId !== hit.messageId ||
          nextWindow.anchor.sequence !== hit.sequence
        ) {
          setHistoricalWindowError("Historical response identity did not match the selected search result");
          return false;
        }
        setHistoricalWindow(nextWindow);
        return true;
      } catch (error) {
        if (generation !== historicalWindowGenerationRef.current) return false;
        setHistoricalWindowError(error instanceof Error ? error.message : "Historical message could not be loaded");
        return false;
      } finally {
        if (generation === historicalWindowGenerationRef.current) {
          setHistoricalWindowLoading(false);
        }
      }
    },
    [workspaceId],
  );

  const returnToLatest = useCallback(() => {
    historicalWindowGenerationRef.current += 1;
    historicalContinuationGenerationRef.current += 1;
    setHistoricalWindow(null);
    setHistoricalWindowTarget(null);
    setHistoricalWindowError(null);
    setHistoricalWindowLoading(false);
    setHistoricalContinuationLoading(null);
    setHistoricalContinuationError(null);
  }, []);

  const loadHistoricalContinuation = useCallback(
    async (direction: "older" | "newer") => {
      const target = historicalWindowTarget;
      const currentWindow = historicalWindow;
      const cursor = direction === "older" ? currentWindow?.olderCursor : currentWindow?.newerCursor;
      if (!target || currentWindow?.anchor.state !== "found" || !cursor) return false;
      const generation = ++historicalContinuationGenerationRef.current;
      setHistoricalContinuationLoading(direction);
      setHistoricalContinuationError(null);
      try {
        const page = await fetchChatHistoryContinuation({
          workspaceId: target.workspaceId,
          sessionId: target.sessionId,
          direction,
          cursor,
        });
        if (generation !== historicalContinuationGenerationRef.current) return false;
        if (page.cursorState === "stale") {
          setHistoricalContinuationError("Historical continuation is stale because its boundary message changed");
          return false;
        }
        const pageIsValid =
          page.direction === direction &&
          page.snapshotMaxSequence === cursor.snapshotMaxSequence &&
          page.items.every(
            (entry) =>
              entry.message.sessionId === target.sessionId &&
              entry.sequence <= cursor.snapshotMaxSequence &&
              (direction === "older" ? entry.sequence < cursor.sequence : entry.sequence > cursor.sequence),
          ) &&
          (!page.nextCursor || page.nextCursor.snapshotMaxSequence === cursor.snapshotMaxSequence);
        if (!pageIsValid) {
          setHistoricalContinuationError("Historical continuation identity did not match the requested cursor");
          return false;
        }
        setHistoricalWindow((active) => {
          if (
            !active ||
            active.anchor.workspaceId !== target.workspaceId ||
            active.anchor.sessionId !== target.sessionId ||
            active.anchor.messageId !== currentWindow.anchor.messageId ||
            active.anchor.sequence !== currentWindow.anchor.sequence
          ) {
            return active;
          }
          const combined = direction === "older" ? [...page.items, ...active.items] : [...active.items, ...page.items];
          const seen = new Set<string>();
          const items = combined.filter((entry) => {
            const key = `${entry.message.messageId}:${entry.sequence}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          return {
            ...active,
            items,
            ...(direction === "older"
              ? { hasOlder: page.hasMore, olderCursor: page.nextCursor }
              : { hasNewer: page.hasMore, newerCursor: page.nextCursor }),
            truncated: active.truncated || page.truncated,
            droppedItems: active.droppedItems + page.droppedItems,
          };
        });
        return true;
      } catch (error) {
        if (generation !== historicalContinuationGenerationRef.current) return false;
        setHistoricalContinuationError(error instanceof Error ? error.message : "Historical continuation failed");
        return false;
      } finally {
        if (generation === historicalContinuationGenerationRef.current) {
          setHistoricalContinuationLoading(null);
        }
      }
    },
    [historicalWindow, historicalWindowTarget],
  );

  useEffect(() => {
    if (
      historicalWindowTarget &&
      (historicalWindowTarget.workspaceId !== workspaceId || historicalWindowTarget.sessionId !== selectedSessionId)
    ) {
      returnToLatest();
    }
  }, [historicalWindowTarget, returnToLatest, selectedSessionId, workspaceId]);

  const loadRuntimeCatalog = useCallback(async () => {
    const { runtimeSettings, commands, skills, servers, templates } = await getDevBootstrapPromise(
      runtimeCatalogBootstrapCache,
      "runtime-catalog",
      async () => {
        const [nextRuntimeSettings, nextCommands, nextSkills, nextServers, nextTemplates] = await Promise.all([
          fetchSettings(),
          fetchChatCommandCatalog(),
          fetchSkills(),
          fetchMcpServers(),
          fetchMcpTemplates(),
        ]);
        return {
          runtimeSettings: nextRuntimeSettings,
          commands: nextCommands,
          skills: nextSkills,
          servers: nextServers,
          templates: nextTemplates,
        };
      },
    );
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

  const loadSessionCoreStateInternal = useCallback(
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
        if (generation !== loadCoreGenerationRef.current) return false;
        if (nextThread) {
          applyFetchedThreadRef.current(nextThread, messageVersionAtStart);
        }
        setBinding(nextBinding.item);
        setPrefs(nextPrefs);
        return true;
      } finally {
        // Only the newest load may clear the shared loading flag: a superseded
        // foreground load settling late must not hide the spinner while the
        // load that superseded it is still in flight. The newest generation
        // always clears when it settles -- even a background one, so a
        // foreground load superseded by a background refresh can never strand
        // the spinner on (clearing an already-false flag is harmless).
        if (generation === loadCoreGenerationRef.current) {
          setMessagesLoading(false);
        }
      }
    },
    [applyFetchedThreadRef, messageMutationVersionRef],
  );

  const loadSessionCoreState = useCallback(
    async (
      sessionId: string,
      options: {
        background?: boolean;
        includeThread?: boolean;
      } = {},
    ) => {
      await loadSessionCoreStateInternal(sessionId, options);
    },
    [loadSessionCoreStateInternal],
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
        const [
          nextProactiveStatus,
          nextProactiveRuns,
          nextMemory,
          nextSpecialists,
          nextArtifacts,
          nextKnowledgeAttachments,
        ] = await Promise.all([
          fetchChatProactiveStatus(sessionId),
          fetchChatProactiveRuns(sessionId, 30),
          fetchChatLearnedMemory(sessionId, 80),
          fetchChatSpecialistCandidates(sessionId, 80),
          fetchChatGeneratedArtifacts({ sessionId, limit: 200 }),
          fetchThreadKnowledgeAttachments(sessionId),
        ]);
        if (generation !== loadSecondaryGenerationRef.current) return;
        setProactiveStatus(nextProactiveStatus.policy);
        setProactiveRuns(nextProactiveRuns.items);
        setLearnedMemory(nextMemory.items);
        setSpecialistCandidates(nextSpecialists.items);
        setGeneratedArtifacts(nextArtifacts);
        setThreadKnowledgeAttachments(nextKnowledgeAttachments);
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
      const coreLoaded = await loadSessionCoreStateInternal(sessionId, { background, includeThread });
      if (!coreLoaded) {
        return;
      }
      if (deferSecondary) {
        void loadSessionSecondaryState(sessionId, { background: false }).catch((err: Error) => setError(err.message));
        return;
      }
      await loadSessionSecondaryState(sessionId, { background });
    },
    [loadSessionCoreStateInternal, loadSessionSecondaryState, setError],
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

  useEffect(() => {
    if (!loading) {
      refreshSubscriptionStartedAtRef.current = Date.now();
    }
  }, [loading]);

  useRefreshSubscription(
    "chat",
    async (signal) => {
      if (
        signal.eventId &&
        signal.eventType !== "fallback_poll" &&
        refreshSubscriptionStartedAtRef.current > 0 &&
        signal.timestamp < refreshSubscriptionStartedAtRef.current
      ) {
        recordClientDiagnostic({
          level: "debug",
          category: "refresh",
          event: "ignored_prebootstrap_signal",
          message: "Ignored replayed chat refresh signal during initial hydrate",
          context: {
            eventId: signal.eventId,
            eventType: signal.eventType,
            source: signal.source,
          },
        });
        return;
      }
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
      loadCoreGenerationRef.current += 1;
      loadSecondaryGenerationRef.current += 1;
      clearSessionScopedState();
      lastLoadedSessionIdRef.current = null;
      return;
    }
    if (lastLoadedSessionIdRef.current !== selectedSessionId) {
      loadCoreGenerationRef.current += 1;
      loadSecondaryGenerationRef.current += 1;
      clearSessionScopedState();
      lastLoadedSessionIdRef.current = selectedSessionId;
    }
    void loadSessionState(selectedSessionId, {
      background: false,
      includeThread: true,
      deferSecondary: true,
    }).catch((err: Error) => setError(err.message));
  }, [clearSessionScopedState, loadSessionState, selectedSessionId, setError]);

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
    generatedArtifacts,
    setGeneratedArtifacts,
    threadKnowledgeAttachments,
    setThreadKnowledgeAttachments,
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
    sidebarNextCursor,
    sidebarLoadingMore,
    historicalWindow,
    historicalWindowLoading,
    historicalWindowError,
    historicalWindowTarget,
    historicalContinuationLoading,
    historicalContinuationError,
    loadSidebar,
    openHistoricalWindow,
    returnToLatest,
    loadHistoricalContinuation,
    loadRuntimeCatalog,
    loadSessionCoreState,
    loadSessionSecondaryState,
    loadSessionState,
    refreshViewState,
  };
}
