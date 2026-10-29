import { chatSidebarScopeKey } from "./chat-sidebar-scope-key";
import {
  CHAT_TURN_ACTIVE_STATUSES,
  type ChatHistoryWindowResponse,
  type ChatSessionSearchHitRecord,
  type ChatSessionBindingRecord,
  type ChatSessionPrefsRecord,
  type ChatSpecialistCandidateRecord,
  type LearnedMemoryItemRecord,
  type McpServerRecord,
  type McpServerTemplateRecord,
  type ProactivePolicy,
  type ProactiveRunRecord,
  type SkillListItem,
} from "@goatcitadel/contracts";
import {
  getGatewayAccessRevision,
  getGatewayCallerScope,
  getGatewayCallerScopeRevision,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChatThreadState } from "./use-chat-thread-state";
import {
  fetchChatGeneratedArtifacts,
  fetchChatHistoryWindow,
  fetchChatHistoryContinuation,
  fetchChatCommandCatalog,
  fetchChatLearnedMemory,
  fetchChatProjects,
  fetchChatProactiveRuns,
  fetchChatProactiveStatus,
  fetchChatSessionCoreState,
  fetchChatSessions,
  fetchChatSessionSearch,
  fetchChatSpecialistCandidates,
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
import { retainedReloadMode, useCommitRefValue, type RetainedLoad } from "./retained-reload";
import {
  historicalWindowIdentityMismatch,
  historicalTargetChanged,
  isHistoricalContinuationValid,
  mergeHistoricalContinuation,
} from "./chat-session-history-projection";

import { readRouteSidebarSession } from "./chat-route-session-read";
import {
  getDevBootstrapPromise,
  appendMissingSidebarSession,
  sidebarMembershipIncomplete,
  sidebarRefreshPriority,
  chatViewRefreshPhase,
  sidebarLoadDiagnostic,
  appendSidebarSessions,
  projectChatSessionSearch,
  reconcileSidebarSessions,
  routeFallbackSessionId,
  selectSidebarSession,
  sidebarActivityReconcileKey,
  type ChatSessionDataInput,
  type ChatCoreLoadOptions,
  type ChatSecondaryLoadOptions,
  type ChatSessionLoadOptions,
  type ChatViewRefreshOptions,
  resolveSidebarSessionLimit,
  runtimeCatalogBootstrapCache,
  sidebarBootstrapCache,
  type ChatHistoryView,
  type ChatSidebarLoadOptions,
  type CommandCatalogItem,
} from "./chat-session-data-bootstrap";

export type { ChatHistoryView, ChatSidebarLoadOptions, CommandCatalogItem } from "./chat-session-data-bootstrap";

export function useChatSessionData(input: ChatSessionDataInput) {
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
  const [thread, setThread] = useChatThreadState();
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
  const secondaryOwner = useRef(input.secondaryEnabled);
  secondaryOwner.current = input.secondaryEnabled;
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
  const initializedScopeRef = useRef<string | null>(null);
  const sidebarNextCursorRef = useRef<string | null>(null);
  const loadCoreGenerationRef = useRef(0);
  const loadSecondaryGenerationRef = useRef(0);
  // Synced at commit, so a load settling after a switch compares against the session shown now.
  const selectedSessionIdRef = useRef(selectedSessionId);
  useCommitRefValue(selectedSessionIdRef, selectedSessionId);
  const loadSidebarGenerationRef = useRef(0);
  const sidebarScopeKey = chatSidebarScopeKey(input);
  const sidebarScope = useRef({ key: sidebarScopeKey });
  if (sidebarScope.current.key !== sidebarScopeKey) sidebarScope.current = { key: sidebarScopeKey };
  const renderedSidebarScope = sidebarScope.current;
  const loadedSidebarPages = useRef<{ scope: typeof renderedSidebarScope; cursors: Array<string | undefined> }>({
    scope: renderedSidebarScope,
    cursors: [],
  });
  if (loadedSidebarPages.current.scope !== renderedSidebarScope)
    loadedSidebarPages.current = { scope: renderedSidebarScope, cursors: [] };
  const routeSelectionKey = JSON.stringify([sidebarScopeKey, input.routeSessionId]);
  const routeSelection = useRef({ key: routeSelectionKey, applied: false });
  if (routeSelection.current.key !== routeSelectionKey)
    routeSelection.current = { key: routeSelectionKey, applied: false };
  const renderedRouteSelection = routeSelection.current;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const routeSessionUnavailableRef = useRef(input.onRouteSessionUnavailable);
  routeSessionUnavailableRef.current = input.onRouteSessionUnavailable;
  const sidebarMounted = useRef(true);
  const sidebarExactRead = useRef<{ scope: typeof renderedSidebarScope; controller: AbortController } | null>(null);
  useEffect(
    () => () => {
      if (sidebarExactRead.current?.scope === renderedSidebarScope) sidebarExactRead.current.controller.abort();
    },
    [renderedSidebarScope],
  );
  useEffect(() => {
    sidebarMounted.current = true;
    return () => {
      sidebarMounted.current = false;
    };
  }, []);
  const historicalWindowGenerationRef = useRef(0);
  const historicalContinuationGenerationRef = useRef(0);
  const lastLoadedSessionIdRef = useRef<string | null>(null);
  // CH-47: what each mount effect last loaded, so a retained Chat shown again keeps its data.
  const sidebarLoadRef = useRef<RetainedLoad | null>(null);
  const catalogLoadRef = useRef<RetainedLoad | null>(null);
  const sessionLoadRef = useRef<RetainedLoad | null>(null);
  // Counts conversation switches; a load begun before the latest switch never marks itself loaded.
  const sessionSwitchRef = useRef(0);
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
  }, [setThread]);

  const loadSidebar = useCallback(
    async (nextHistoryView: ChatHistoryView = historyView, options: ChatSidebarLoadOptions = {}) => {
      if (
        !sidebarMounted.current ||
        sidebarScope.current !== renderedSidebarScope ||
        routeSelection.current !== renderedRouteSelection
      )
        return;
      const generation = ++loadSidebarGenerationRef.current;
      const access = getGatewayAccessRevision();
      const caller = getGatewayCallerScope();
      const callerRevision = getGatewayCallerScopeRevision();
      const gateway = getGatewayApiBaseUrl();
      sidebarExactRead.current?.controller.abort();
      const controller = new AbortController();
      sidebarExactRead.current = { scope: renderedSidebarScope, controller };
      const isCurrent = () =>
        sidebarMounted.current &&
        sidebarScope.current === renderedSidebarScope &&
        routeSelection.current === renderedRouteSelection &&
        generation === loadSidebarGenerationRef.current &&
        access === getGatewayAccessRevision() &&
        caller === getGatewayCallerScope() &&
        callerRevision === getGatewayCallerScopeRevision() &&
        gateway === getGatewayApiBaseUrl();
      const readRoute = (sessionId: string) =>
        readRouteSidebarSession(sessionId, {
          workspaceId,
          view: nextHistoryView,
          mode: surfaceMode,
          signal: controller.signal,
        });
      const trimmedSearchQuery = searchQuery.trim();
      const sessionLimit = resolveSidebarSessionLimit(nextHistoryView, trimmedSearchQuery);
      if (options.routeOnly) {
        // This generation displaced any pending append; its stale finalizer may
        // not clear state owned by this selection, so release loading here.
        setSidebarLoadingMore(false);
        const requested = !trimmedSearchQuery ? input.routeSessionId?.trim() : undefined;
        if (!requested || renderedRouteSelection.applied) return;
        if (!sessionsRef.current?.items.some((item) => item.sessionId === requested)) {
          const record = await readRoute(requested);
          if (!isCurrent()) return;
          if (!record) {
            // A stale or foreign link keeps the conversation already shown; the host clears the bad address.
            renderedRouteSelection.applied = true;
            routeSessionUnavailableRef.current?.(
              requested,
              routeFallbackSessionId(selectedSessionIdRef.current, sessionsRef.current),
            );
            return;
          }
          setSessions((current) =>
            !current || !isCurrent() ? current : appendMissingSidebarSession(current, requested, record),
          );
        }
        if (isCurrent()) {
          renderedRouteSelection.applied = true;
          setSelectedSessionId(requested);
        }
        return;
      }
      if (options.reconcileLoadedRange) {
        setSidebarLoadingMore(false);
        // Repeat the retained page reads in batches. Preserve their ordering and
        // continuation anchor; a completed turn may reorder the server's first page.
        const cursors = loadedSidebarPages.current.cursors.length
          ? [...loadedSidebarPages.current.cursors]
          : [undefined];
        try {
          const pages = await Promise.all(
            cursors.map((cursor) =>
              trimmedSearchQuery
                ? fetchChatSessionSearch({
                    query: trimmedSearchQuery,
                    mode: "discovery",
                    view: nextHistoryView,
                    limit: sessionLimit,
                    workspaceId,
                    cursor,
                    surface: surfaceMode,
                    includeActivity: true,
                  }).then((response) => response.items.map((item) => ({ ...item.session, searchHits: item.hits })))
                : fetchChatSessions(
                    {
                      scope: "all",
                      view: nextHistoryView,
                      limit: sessionLimit,
                      workspaceId,
                      cursor,
                      mode: surfaceMode,
                      includeActivity: true,
                    },
                    { signal: controller.signal },
                  ).then((response) => response.items),
            ),
          );
          if (!isCurrent()) return;
          // Cursor absence is not membership evidence: ranking may move a retained
          // record beyond these pages. Verify only the retained IDs in bounded batches.
          const retainedIds = sessionsRef.current?.items.map((item) => item.sessionId) ?? [];
          const members = new Map<string, ChatSessionsResponse["items"][number]>();
          for (let offset = 0; offset < retainedIds.length; offset += 100) {
            const sessionIds = retainedIds.slice(offset, offset + 100);
            const response = await fetchChatSessions(
              {
                sessionIds,
                workspaceId,
                scope: "all",
                view: nextHistoryView,
                mode: surfaceMode,
                q: trimmedSearchQuery || undefined,
                includeActivity: true,
              },
              { signal: controller.signal },
            );
            if (!isCurrent()) return;
            if (sidebarMembershipIncomplete(response, sessionIds)) {
              throw new Error("Conversation membership could not be verified. The previous list is retained.");
            }
            for (const record of response.items) members.set(record.sessionId, record);
          }
          const records = new Map(pages.flat().map((record) => [record.sessionId, record]));
          setSessions((current) => {
            if (!current || !isCurrent()) return current;
            return reconcileSidebarSessions(current, members, records);
          });
        } catch (error) {
          if (isCurrent()) throw error;
        }
        return;
      }
      const append = Boolean(options.append);
      const cursor = append ? (sidebarNextCursorRef.current ?? undefined) : undefined;
      if (append && !cursor) {
        return;
      }
      if (!append) {
        setSidebarLoadingMore(false);
      }
      recordClientDiagnostic(sidebarLoadDiagnostic(workspaceId, nextHistoryView, sessionLimit, append, surfaceMode));
      if (append) {
        setSidebarLoadingMore(true);
        try {
          const nextSessions = trimmedSearchQuery
            ? await fetchChatSessionSearch(
                {
                  query: trimmedSearchQuery,
                  mode: "discovery",
                  view: nextHistoryView,
                  limit: sessionLimit,
                  workspaceId,
                  cursor,
                  surface: surfaceMode,
                  includeActivity: true,
                },
                { signal: controller.signal },
              ).then<ChatSessionsResponse>(projectChatSessionSearch)
            : await fetchChatSessions(
                {
                  scope: "all",
                  view: nextHistoryView,
                  limit: sessionLimit,
                  workspaceId,
                  cursor,
                  mode: surfaceMode,
                  includeActivity: true,
                },
                { signal: controller.signal },
              );
          if (!isCurrent()) return;
          setSessions((current) => {
            if (!isCurrent()) return current;
            return appendSidebarSessions(current, nextSessions);
          });
          if (!loadedSidebarPages.current.cursors.includes(cursor)) loadedSidebarPages.current.cursors.push(cursor);
          updateSidebarNextCursor(nextSessions.nextCursor ?? null);
        } catch (error) {
          if (isCurrent()) throw error;
        } finally {
          if (isCurrent()) {
            setSidebarLoadingMore(false);
          }
        }
        return;
      }
      const cacheKey = JSON.stringify([
        gateway,
        caller,
        callerRevision,
        access,
        workspaceId,
        input.viewIdentity,
        nextHistoryView,
        trimmedSearchQuery,
        sessionLimit,
        surfaceMode ?? "all",
      ]);
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
                    includeActivity: true,
                  }).then<ChatSessionsResponse>(projectChatSessionSearch)
                : fetchChatSessions({
                    scope: "all",
                    view: nextHistoryView,
                    limit: sessionLimit,
                    workspaceId,
                    mode: surfaceMode,
                    includeActivity: true,
                  }),
            ]);
            return { projects, sessions };
          },
          { bypassCache: options.bypassCache },
        ));
      } catch (error) {
        if (isCurrent()) throw error;
        return;
      }
      if (!isCurrent()) return;
      const requestedSessionId = !trimmedSearchQuery ? input.routeSessionId?.trim() : undefined;
      if (requestedSessionId && !nextSessions.items.some((item) => item.sessionId === requestedSessionId)) {
        // A deep link may be older than the first page. Read only that exact,
        // visible, scoped owner; a missing/foreign response must never select a recent Chat.
        const record = await readRoute(requestedSessionId);
        if (!isCurrent()) return;
        // A stale link still shows the list and opens the first conversation; the host clears the address.
        if (record) nextSessions = { ...nextSessions, items: [...nextSessions.items, record] };
        else if (!renderedRouteSelection.applied) {
          routeSessionUnavailableRef.current?.(
            requestedSessionId,
            routeFallbackSessionId(selectedSessionIdRef.current, nextSessions, options),
          );
        }
      }
      loadedSidebarPages.current.cursors = [undefined];
      setProjects(nextProjects);
      setSessions(nextSessions);
      updateSidebarNextCursor(nextSessions.nextCursor ?? null);
      if (options.preserveSelection) return;
      // The URL admits the initial selection; it must not undo a later user
      // choice or fork when realtime/sidebar refreshes observe the same URL.
      const initialRouteSelection = renderedRouteSelection.applied ? undefined : requestedSessionId;
      if (requestedSessionId) renderedRouteSelection.applied = true;
      setSelectedSessionId((current) => {
        if (!isCurrent()) return current;
        return selectSidebarSession(current, nextSessions, options, initialRouteSelection);
      });
    },
    [
      historyView,
      input.routeSessionId,
      input.viewIdentity,
      renderedRouteSelection,
      renderedSidebarScope,
      searchQuery,
      setSelectedSessionId,
      surfaceMode,
      updateSidebarNextCursor,
      workspaceId,
    ],
  );

  const openHistoricalWindow = useCallback(
    async (sessionId: string, hit: ChatSessionSearchHitRecord) => {
      const access = getGatewayAccessRevision();
      const caller = getGatewayCallerScope();
      const gateway = getGatewayApiBaseUrl();
      const generation = ++historicalWindowGenerationRef.current;
      const current = () =>
        sidebarMounted.current &&
        generation === historicalWindowGenerationRef.current &&
        access === getGatewayAccessRevision() &&
        caller === getGatewayCallerScope() &&
        gateway === getGatewayApiBaseUrl();
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
        if (!current()) return false;
        if (historicalWindowIdentityMismatch(nextWindow, workspaceId, sessionId, hit)) {
          setHistoricalWindowError("Historical response identity did not match the selected search result");
          return false;
        }
        setHistoricalWindow(nextWindow);
        return true;
      } catch (error) {
        if (!current()) return false;
        setHistoricalWindowError(error instanceof Error ? error.message : "Historical message could not be loaded");
        return false;
      } finally {
        if (current()) {
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
        const pageIsValid = isHistoricalContinuationValid(page, direction, cursor, target);
        if (!pageIsValid) {
          setHistoricalContinuationError("Historical continuation identity did not match the requested cursor");
          return false;
        }
        setHistoricalWindow((active) => mergeHistoricalContinuation(active, currentWindow, page, direction, target));
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
    if (historicalTargetChanged(historicalWindowTarget, workspaceId, selectedSessionId)) {
      returnToLatest();
    }
  }, [historicalWindowTarget, returnToLatest, selectedSessionId, workspaceId]);

  const reconciledActivity = useRef("");
  // Primitive reconcile key derived in render, so the effect depends on values rather than per-render turn objects.
  const activityReconcileKey = sidebarActivityReconcileKey(thread, sessions, selectedSessionId, sidebarScopeKey);
  useEffect(() => {
    if (activityReconcileKey === null) return;
    const key = activityReconcileKey;
    if (reconciledActivity.current === key) return;
    reconciledActivity.current = key;
    // Stream/thread settlement invalidates the batched projection; only its canonical reread can change the rail/header.
    void loadSidebar(undefined, { bypassCache: true, reconcileLoadedRange: true }).catch((cause: Error) => {
      if (sidebarMounted.current && sidebarScope.current === renderedSidebarScope) setError(cause.message);
    });
  }, [activityReconcileKey, loadSidebar, setError, renderedSidebarScope]);

  const catalogScopeKey = JSON.stringify([
    getGatewayApiBaseUrl(),
    getGatewayCallerScope(),
    getGatewayCallerScopeRevision(),
    getGatewayAccessRevision(),
    workspaceId,
    input.viewIdentity,
  ]);
  const catalogScope = useRef({ key: catalogScopeKey, evidenceRequested: false });
  if (catalogScope.current.key !== catalogScopeKey)
    catalogScope.current = { key: catalogScopeKey, evidenceRequested: false };
  const renderedCatalogScope = catalogScope.current;
  if (input.catalogEnabled !== false) renderedCatalogScope.evidenceRequested = true;
  const includeCatalogEvidence = renderedCatalogScope.evidenceRequested;
  const catalogGeneration = useRef(0);
  useEffect(() => {
    setCommandCatalog([]);
    setInstalledSkills([]);
    setMcpServers([]);
    setMcpTemplates([]);
  }, [renderedCatalogScope]);
  const loadRuntimeCatalog = useCallback(async () => {
    const generation = ++catalogGeneration.current;
    const access = getGatewayAccessRevision(),
      caller = getGatewayCallerScope(),
      callerRevision = getGatewayCallerScopeRevision(),
      gateway = getGatewayApiBaseUrl();
    const { runtimeSettings, commands, skills, servers, templates } = await getDevBootstrapPromise(
      runtimeCatalogBootstrapCache,
      JSON.stringify([renderedCatalogScope.key, includeCatalogEvidence]),
      async () => {
        const [nextRuntimeSettings, nextCommands, nextSkills, nextServers, nextTemplates] = await Promise.all([
          fetchSettings(),
          includeCatalogEvidence ? fetchChatCommandCatalog() : Promise.resolve({ items: [] }),
          includeCatalogEvidence ? fetchSkills() : Promise.resolve({ items: [] }),
          includeCatalogEvidence ? fetchMcpServers() : Promise.resolve({ items: [] }),
          includeCatalogEvidence ? fetchMcpTemplates() : Promise.resolve({ items: [] }),
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
    if (
      generation !== catalogGeneration.current ||
      !sidebarMounted.current ||
      catalogScope.current !== renderedCatalogScope ||
      access !== getGatewayAccessRevision() ||
      caller !== getGatewayCallerScope() ||
      callerRevision !== getGatewayCallerScopeRevision() ||
      gateway !== getGatewayApiBaseUrl()
    )
      return;
    setSettings(runtimeSettings);
    setCommandCatalog(commands.items);
    setInstalledSkills(skills.items);
    setMcpServers(servers.items);
    setMcpTemplates(templates.items);
  }, [renderedCatalogScope, includeCatalogEvidence]);

  useEffect(() => {
    if (!runtimeLlmConfig) {
      return;
    }
    setSettings((current) => (current ? { ...current, llm: runtimeLlmConfig } : current));
  }, [runtimeLlmConfig]);

  const loadSessionCoreStateInternal = useCallback(
    async (sessionId: string, options: ChatCoreLoadOptions = {}) => {
      const background = options.background ?? false;
      // A background refresh for a conversation that is no longer shown must not supersede the
      // shown one's load. Foreground loads are never pre-filtered: a caller may select a session
      // and load it in the same tick, before the selection has rendered.
      if (background && sessionId !== selectedSessionIdRef.current) return false;
      const generation = ++loadCoreGenerationRef.current;
      const includeThread = options.includeThread ?? true;
      const messageVersionAtStart = includeThread ? messageMutationVersionRef.current : null;
      if (!background) {
        setMessagesLoading(true);
      }
      try {
        const core = await fetchChatSessionCoreState(sessionId, { includeThread });
        if (core.sessionId !== sessionId || (includeThread && (!core.thread || core.thread.sessionId !== sessionId))) {
          throw new Error("Conversation core state did not match the requested session.");
        }
        const nextThread = core.thread;
        const nextBinding = { item: core.binding };
        const nextPrefs = core.prefs;
        if (generation !== loadCoreGenerationRef.current || sessionId !== selectedSessionIdRef.current) return false;
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
    async (sessionId: string, options: ChatCoreLoadOptions = {}) => {
      await loadSessionCoreStateInternal(sessionId, options);
    },
    [loadSessionCoreStateInternal],
  );

  const loadSessionSecondaryState = useCallback(async (sessionId: string, options: ChatSecondaryLoadOptions = {}) => {
    const background = options.background ?? false;
    // Same fence as the core loader: only foreground loads may target a session not yet shown.
    if (background && sessionId !== selectedSessionIdRef.current) return;
    const generation = ++loadSecondaryGenerationRef.current;
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
      if (generation !== loadSecondaryGenerationRef.current || sessionId !== selectedSessionIdRef.current) return;
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
  }, []);

  const loadSessionState = useCallback(
    async (sessionId: string, options: ChatSessionLoadOptions = {}) => {
      const background = options.background ?? false;
      const includeThread = options.includeThread ?? true;
      const deferSecondary = options.deferSecondary ?? false;
      const coreLoaded = await loadSessionCoreStateInternal(sessionId, { background, includeThread });
      if (!coreLoaded) {
        return;
      }
      if (secondaryOwner.current !== undefined) return;
      if (deferSecondary) {
        void loadSessionSecondaryState(sessionId, { background: false }).catch((err: Error) => setError(err.message));
        return;
      }
      await loadSessionSecondaryState(sessionId, { background });
    },
    [loadSessionCoreStateInternal, loadSessionSecondaryState, setError],
  );

  const refreshViewState = useCallback(
    async (options: ChatViewRefreshOptions = {}) => {
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
        recordChatRefreshPhase(
          chatViewRefreshPhase("plan_applied", selectedSessionId, shouldRefreshSidebar, refreshSession),
        );
        if (shouldRefreshSidebar) {
          await loadSidebar(undefined, {
            bypassCache: true,
            reconcileLoadedRange: loadedSidebarPages.current.cursors.length > 1,
          });
        }
        if (selectedSessionId && refreshSession !== "none") {
          if (refreshSession === "full") {
            await loadSessionState(selectedSessionId, { background: true, includeThread: true });
            if (secondaryOwner.current === true)
              await loadSessionSecondaryState(selectedSessionId, { background: true });
          } else {
            if (secondaryOwner.current !== false)
              await loadSessionSecondaryState(selectedSessionId, { background: true });
          }
        }
        recordChatRefreshPhase(
          chatViewRefreshPhase("plan_completed", selectedSessionId, shouldRefreshSidebar, refreshSession),
        );
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
    const key = [renderedSidebarScope, surfaceMode, workspaceId];
    if (
      sidebarLoadRef.current?.key[0] === renderedSidebarScope &&
      input.routeSessionId?.trim() &&
      !renderedRouteSelection.applied
    ) {
      let cancelled = false;
      void loadSidebar(undefined, { routeOnly: true }).catch((err: Error) => !cancelled && setError(err.message));
      return () => {
        cancelled = true;
      };
    }
    if (retainedReloadMode(sidebarLoadRef.current, key) === "skip") return;
    let cancelled = false;
    const scope = JSON.stringify([workspaceId, surfaceMode]);
    // A sidebar search/history change must retain the mounted conversation,
    // composer and filter dialog. A new workspace still requires bootstrap.
    const needsBootstrap = initializedScopeRef.current !== scope;
    setLoading(needsBootstrap);
    if (needsBootstrap) initializedRef.current = false;
    void loadSidebar()
      .then(() => {
        if (cancelled) return;
        setError(null);
        sidebarLoadRef.current = { key, at: Date.now() };
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          initializedRef.current = true;
          initializedScopeRef.current = scope;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    loadSidebar,
    input.routeSessionId,
    renderedSidebarScope,
    renderedRouteSelection,
    setError,
    surfaceMode,
    workspaceId,
  ]);

  // Runtime command, skill and MCP catalogs must not gate conversation discovery.
  // Refresh them independently so a slow catalog also cannot delay sidebar searches.
  useEffect(() => {
    const key = [loadRuntimeCatalog, surfaceMode, workspaceId];
    if (retainedReloadMode(catalogLoadRef.current, key) === "skip") return;
    let cancelled = false;
    void loadRuntimeCatalog()
      .then(() => {
        if (!cancelled) catalogLoadRef.current = { key, at: Date.now() };
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [loadRuntimeCatalog, setError, surfaceMode, workspaceId]);

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
      const plan = resolveChatRefreshPlan(
        signal,
        now - lastLocalPrefMutationAtRef.current < 2500,
        thread?.sessionId === selectedSessionId &&
          thread.turns.some((turn) => CHAT_TURN_ACTIVE_STATUSES.some((status) => status === turn.trace.status)),
        selectedSessionId,
      );
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
      signalPriority: (signal) => {
        // Another conversation's event ranks below one about the open conversation in a shared batch.
        const plan = resolveChatRefreshPlan(signal, false, false, selectedSessionId);
        return sidebarRefreshPriority(plan);
      },
      staleMs: 120_000,
      pollIntervalMs: 60_000,
    },
  );

  useEffect(() => {
    if (!selectedSessionId) {
      loadCoreGenerationRef.current += 1;
      loadSecondaryGenerationRef.current += 1;
      clearSessionScopedState();
      lastLoadedSessionIdRef.current = null;
      sessionLoadRef.current = null;
      return;
    }
    const key = [selectedSessionId, loadSessionState];
    if (lastLoadedSessionIdRef.current !== selectedSessionId) {
      // A different conversation: retire every load begun for the previous one and forget what was
      // loaded, so a quick switch back (X → Y → X) loads again instead of skipping onto a cleared view.
      loadCoreGenerationRef.current += 1;
      loadSecondaryGenerationRef.current += 1;
      sessionSwitchRef.current += 1;
      clearSessionScopedState();
      lastLoadedSessionIdRef.current = selectedSessionId;
      sessionLoadRef.current = null;
    }
    // The skip applies only when the last completed load is of the conversation shown now.
    const mode = retainedReloadMode(sessionLoadRef.current, key);
    if (mode === "skip") return;
    // An older load of the same session refreshes in the background and keeps what is shown.
    const background = mode === "background";
    const switchGeneration = sessionSwitchRef.current;
    void loadSessionState(selectedSessionId, { background, includeThread: true, deferSecondary: !background })
      .then(() => {
        if (sessionSwitchRef.current === switchGeneration) sessionLoadRef.current = { key, at: Date.now() };
      })
      .catch((err: Error) => setError(err.message));
  }, [clearSessionScopedState, loadSessionState, selectedSessionId, setError]);

  useEffect(() => {
    if (input.secondaryEnabled !== true || !selectedSessionId || thread?.sessionId !== selectedSessionId) return;
    void loadSessionSecondaryState(selectedSessionId).catch((error: Error) => setError(error.message));
  }, [input.secondaryEnabled, selectedSessionId, thread?.sessionId, loadSessionSecondaryState, setError]);

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
    historicalWindowGenerationRef,
    contextMutationReadOnly:
      historicalWindowTarget?.workspaceId === workspaceId &&
      historicalWindowTarget.sessionId === selectedSessionId &&
      Boolean(historicalWindow || historicalWindowLoading || historicalWindowError),
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
