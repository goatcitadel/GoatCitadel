import type { ChatGeneratedArtifactRecord, ChatMode, ChatSessionRecord } from "@goatcitadel/contracts";
import { type AgenticRunTreeResponse } from "@goatcitadel/mission-control-shared/api/agentic";
import { fetchChatSessionGoal } from "@goatcitadel/mission-control-shared/api/client";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useEventStreamStatus } from "@goatcitadel/mission-control-shared/hooks/useEventStreamStatus";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";
import { useChatHistoricalRoute } from "../useChatHistoricalRoute";
import { useChatChangePlanHistory } from "../useChatChangePlanHistory";
import { useChatChangePlanState } from "../useChatChangePlanState";
import { useChatDocuments } from "../useChatDocuments";
import { useChatSessionControls, type SessionRemovedFromView } from "../useChatSessionControls";
import { useChatSessionData } from "../useChatSessionData";
import { useEnsureListedSession } from "../useEnsureListedSession";
import { useChatSessionStatus } from "../useChatSessionStatus";
import type { OutboundContextBlock } from "../useChatSurfaceOrchestration";
import { useChatThreadController } from "../useChatThreadController";
import { useChatTimerPanel } from "../useChatTimerPanel";
import { useExternalSourceAttachments } from "../useExternalSourceAttachments";
import { useRunVariablePanel } from "../useRunVariablePanel";
import { useChatActivationGrants } from "./useChatActivationGrants";
import { useChatAgenticTreeRefresh } from "./useChatAgenticTreeRefresh";
import { useChatAutomaticFanout } from "./useChatAutomaticFanout";
import { useChatControllerCoordination } from "./useChatControllerCoordination";
import { useChatConversationContext } from "./useChatConversationContext";
import { useChatExternalSessionControl } from "./useChatExternalSessionControl";
import { useChatMetadataDraftActions } from "./useChatMetadataDraftActions";
import { useChatMetadataDraftState } from "./useChatMetadataDraftState";
import { useChatModeSynchronization } from "./useChatModeSynchronization";
import { useChatNoticesAndPresetRefresh } from "./useChatNoticesAndPresetRefresh";
import { useChatScopedErrors } from "./useChatScopedErrors";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  sendingRevisionRef: { readonly current: number };
  catalogEvidenceEnabled?: boolean;
  secondaryEvidenceEnabled?: boolean;
  workspaceId: NonNullable<MissionThreadedControllerHostProps["workspaceId"]>;
  selection: ReturnType<typeof useChatSessionSelection>;
  deferredSearch: string;
  providerCatalog: Pick<ReturnType<typeof useProviderModelCatalog>, "config">;
  setUiError: ReturnType<typeof useChatScopedErrors>["setUiError"];
  coordination: ReturnType<typeof useChatControllerCoordination>;
  lockSurface: NonNullable<MissionThreadedControllerHostProps["lockSurface"]>;
  surface: MissionThreadedControllerHostProps["surface"];
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  eventStreamStatus: Pick<ReturnType<typeof useEventStreamStatus>, "state">;
  pushLocalNotice: ReturnType<typeof useChatNoticesAndPresetRefresh>["pushLocalNotice"];
  changePlanState: Pick<ReturnType<typeof useChatChangePlanState>, "setChatChangePlanSnapshot" | "setActiveChangePlan">;
  onResolvedModeChange: MissionThreadedControllerHostProps["onResolvedModeChange"];
  setAgenticRunTree: React.Dispatch<React.SetStateAction<AgenticRunTreeResponse | null>>;
  routeSearch: string;
  selectedTurnId: string | null;
  setSelectedTurnId: React.Dispatch<React.SetStateAction<string | null>>;
  search: string;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
  followThreadOutput: boolean;
  setFollowThreadOutput: React.Dispatch<React.SetStateAction<boolean>>;
  approvalsCount: NonNullable<MissionThreadedControllerHostProps["approvalsCount"]>;
  setPinnedGoal: React.Dispatch<React.SetStateAction<string | undefined>>;
  metadataDraft: ReturnType<typeof useChatMetadataDraftState>;
  setRenameTitle: React.Dispatch<React.SetStateAction<string>>;
  onNavigateSurface: MissionThreadedControllerHostProps["onNavigateSurface"];
  renameTitle: string;
  setSending: React.Dispatch<React.SetStateAction<boolean>>;
  selectedContextTurnIds: string[];
  pendingThreadContext: OutboundContextBlock | null;
  setSelectedContextTurnIds: React.Dispatch<React.SetStateAction<string[]>>;
  setPendingThreadContext: React.Dispatch<React.SetStateAction<OutboundContextBlock | null>>;
  setActiveGeneratedArtifact: React.Dispatch<React.SetStateAction<ChatGeneratedArtifactRecord | null>>;
};

/** Composes session reads, scope-bound lifecycle, controls and context owners in their original hook order. */
export function useChatSessionComposition({
  sendingRevisionRef,
  catalogEvidenceEnabled,
  secondaryEvidenceEnabled,
  workspaceId,
  selection,
  deferredSearch,
  providerCatalog,
  setUiError,
  coordination,
  lockSurface,
  surface,
  setDraft,
  eventStreamStatus,
  pushLocalNotice,
  changePlanState,
  onResolvedModeChange,
  setAgenticRunTree,
  routeSearch,
  selectedTurnId,
  setSelectedTurnId,
  search,
  setSearch,
  followThreadOutput,
  setFollowThreadOutput,
  approvalsCount,
  setPinnedGoal,
  metadataDraft,
  setRenameTitle,
  onNavigateSurface,
  renameTitle,
  setSending,
  selectedContextTurnIds,
  pendingThreadContext,
  setSelectedContextTurnIds,
  setPendingThreadContext,
  setActiveGeneratedArtifact,
}: Input) {
  // Citadel is presentation currency; creation admission remains installation/workspace owned.
  const { activeCitadelId: viewIdentity } = useUiPreferences();
  const currentSessionMode: ChatMode = "chat";
  // A conversation this host just archived or deleted already announced itself; its stale address is expected.
  const removedSessionIdRef = useRef<string | null>(null);
  const handleRouteSessionUnavailable = useCallback(
    (requestedSessionId: string, fallbackSessionId: string | null) => {
      if (removedSessionIdRef.current === requestedSessionId) return;
      pushLocalNotice(
        fallbackSessionId
          ? "That conversation is no longer available here, so the most recent one is open instead."
          : "That conversation is no longer available here.",
        "neutral",
      );
      onNavigateSurface?.(currentSessionMode, { sessionId: fallbackSessionId, turnId: null, artifactId: null });
    },
    [currentSessionMode, onNavigateSurface, pushLocalNotice],
  );
  const sessionData = useChatSessionData({
    onRouteSessionUnavailable: handleRouteSessionUnavailable,
    secondaryEnabled: secondaryEvidenceEnabled,
    catalogEnabled: catalogEvidenceEnabled,
    workspaceId,
    viewIdentity,
    historyView: selection.historyView,
    searchQuery: deferredSearch,
    routeSessionId: new URLSearchParams(routeSearch).get("sessionId")?.trim(),
    selectedSessionId: selection.selectedSessionId,
    setSelectedSessionId: selection.setSelectedSessionId,
    runtimeLlmConfig: providerCatalog.config,
    setError: setUiError,
    applyFetchedThreadRef: coordination.applyFetchedThreadRef,
    messageMutationVersionRef: coordination.messageMutationVersionRef,
    lastLocalPrefMutationAtRef: coordination.lastLocalPrefMutationAtRef,
    surfaceMode: lockSurface && surface ? surface : undefined,
  });
  // A conversation chosen from Messaging can be older than the loaded page; it is read exactly into the list.
  const ensureSessionListed = useEnsureListedSession({
    workspaceId,
    viewIdentity,
    historyView: selection.historyView,
    surfaceMode: lockSurface && surface ? surface : undefined,
    sessions: sessionData.sessions,
    setSessions: sessionData.setSessions,
  });
  const { loadSidebar } = sessionData;
  const { loadSessionCoreState } = sessionData;
  const { loadSessionSecondaryState } = sessionData;

  const activationGrants = useChatActivationGrants({ workspaceId });
  const sessionStatusEnabled = sessionData.settings?.features?.chatSessionStatusV1Enabled === true;
  const chatTimersEnabled = sessionData.settings?.features?.chatTimersV1Enabled === true;
  const typedRunVariablesEnabled = sessionData.settings?.features?.typedRunVariablesV1Enabled === true;
  const documentEditingEnabled = sessionData.settings?.features?.documentEditingV1Enabled === true;
  const explicitContextEnabled = sessionData.settings?.chatFeatureAvailability?.explicitContext === true;
  const runVariables = useRunVariablePanel({
    selectedSessionId: selection.selectedSessionId,
    setDraft,
    composerRef: coordination.composerRef,
  });
  const timerPanel = useChatTimerPanel({
    selectedSessionId: selection.selectedSessionId,
    workspaceId,
    enabled: chatTimersEnabled,
    eventStreamState: eventStreamStatus.state,
    thread: sessionData.thread,
    pushLocalNotice: pushLocalNotice,
  });
  const { openChatTimerPanel } = timerPanel;

  useEffect(() => {
    // The controller owns one transient UI-error channel. It is rendered with
    // the selected chat, so discard any prior chat's recovery state before a
    // new selection can expose it as that chat's error.
    setUiError(null);
  }, [selection.selectedSessionId, setUiError]);

  useChatChangePlanHistory({
    workspaceId,
    selectedSessionId: selection.selectedSessionId,
    setChatChangePlanSnapshot: changePlanState.setChatChangePlanSnapshot,
    setActiveChangePlan: changePlanState.setActiveChangePlan,
  });
  useChatModeSynchronization({ currentSessionMode, onResolvedModeChange, selection });
  const latestTurnStatus = sessionData.thread?.turns.at(-1)?.trace?.status ?? null;
  const agenticTree = useChatAgenticTreeRefresh({
    selection,
    workspaceId,
    setAgenticRunTree,
    refreshKey: `${approvalsCount}:${latestTurnStatus}`,
  });
  const { resolveAgenticRunTree } = agenticTree;

  const threadController = useChatThreadController({
    surfaceMode: currentSessionMode,
    showAllModes: !lockSurface,
    routeSearch,
    sessions: sessionData.sessions?.items,
    projects: sessionData.projects?.items,
    thread: sessionData.thread,
    selectedProjectId: selection.selectedProjectId,
    setSelectedProjectId: selection.setSelectedProjectId,
    selectedFolderId: selection.selectedFolderId,
    setSelectedFolderId: selection.setSelectedFolderId,
    selectedTag: selection.selectedTag,
    setSelectedTag: selection.setSelectedTag,
    historyView: selection.historyView,
    setHistoryView: selection.setHistoryView,
    selectedSessionId: selection.selectedSessionId,
    setSelectedSessionId: selection.setSelectedSessionId,
    selectedTurnId,
    setSelectedTurnId,
    search,
    setSearch,
    followThreadOutput,
    setFollowThreadOutput,
    applyFetchedThreadRef: coordination.applyFetchedThreadRef,
    messageMutationVersionRef: coordination.messageMutationVersionRef,
  });
  useChatHistoricalRoute({
    routeSearch,
    workspaceId,
    viewIdentity,
    selectedSession: threadController.selectedSession,
    openHistoricalWindow: sessionData.openHistoricalWindow,
    returnToLatest: sessionData.returnToLatest,
  });
  const sessionStatus = useChatSessionStatus({
    sessionId: selection.selectedSessionId,
    workspaceId: threadController.selectedSession?.workspaceId ?? workspaceId,
    enabled: sessionStatusEnabled,
    pushLocalNotice: pushLocalNotice,
  });
  const { refresh } = sessionStatus;

  useEffect(() => {
    if (sessionStatus.panel.open && sessionStatusEnabled) void refresh(false);
    // Thread and attention changes are fed by the existing realtime refresh path.
  }, [
    approvalsCount,
    eventStreamStatus.state,
    refresh,
    sessionStatusEnabled,
    sessionStatus.panel.open,
    sessionData.thread,
  ]);
  const fanout = useChatAutomaticFanout({ sessionData, threadController, workspaceId, activationGrants });
  const routeArtifactId = useMemo(
    () => new URLSearchParams(routeSearch).get("artifactId")?.trim() || null,
    [routeSearch],
  );

  useEffect(() => {
    coordination.loadSessionCoreStateRef.current = loadSessionCoreState;
  }, [loadSessionCoreState, coordination.loadSessionCoreStateRef]);

  const refreshChatSessionAggregate = useCallback(
    async (sessionId: string, options?: { preserveSelection?: boolean }) => {
      const [, , , goal] = await Promise.all([
        loadSidebar(selection.historyView, { bypassCache: true, preferredSessionId: sessionId, ...options }),
        loadSessionCoreState(sessionId, { background: true, includeThread: false }),
        loadSessionSecondaryState(sessionId, { background: true }),
        fetchChatSessionGoal(sessionId),
      ]);
      setPinnedGoal(goal.goal ?? undefined);
    },
    [selection.historyView, loadSessionCoreState, loadSessionSecondaryState, loadSidebar, setPinnedGoal],
  );
  const externalControl = useChatExternalSessionControl({ selection, coordination, refreshChatSessionAggregate });
  const metadataActions = useChatMetadataDraftActions({ metadataDraft, setRenameTitle, threadController });

  const handleSessionCreated = useCallback(
    (created: ChatSessionRecord) => {
      onNavigateSurface?.(currentSessionMode, {
        sessionId: created.sessionId,
        turnId: null,
        artifactId: null,
      });
      // The new conversation renders on the next frame; typing should start right away.
      globalThis.setTimeout(() => coordination.composerRef.current?.focus(), 0);
    },
    [coordination.composerRef, currentSessionMode, onNavigateSurface],
  );

  const publishSessionLocation = useCallback(
    (sessionId: string) => onNavigateSurface?.(currentSessionMode, { sessionId, turnId: null, artifactId: null }),
    [currentSessionMode, onNavigateSurface],
  );
  const handleSessionRemoved = useCallback(
    (removed: SessionRemovedFromView) => {
      removedSessionIdRef.current = removed.sessionId;
      onNavigateSurface?.(currentSessionMode, { sessionId: removed.nextSessionId, turnId: null, artifactId: null });
      pushLocalNotice(
        removed.kind === "archived"
          ? `Archived "${removed.label}". Find it under Archived in the conversation list.`
          : `Deleted "${removed.label}".`,
        "success",
      );
    },
    [currentSessionMode, onNavigateSurface, pushLocalNotice],
  );
  const missionSessionsRef = useRef(threadController.missionSessions);
  missionSessionsRef.current = threadController.missionSessions;
  const nextSessionAfterRemoval = useCallback((removedSessionId: string) => {
    const list = missionSessionsRef.current.filter((item) => item.lifecycleStatus === "active");
    const index = list.findIndex((item) => item.sessionId === removedSessionId);
    const rest = list.filter((item) => item.sessionId !== removedSessionId);
    return (rest[Math.min(Math.max(index, 0), rest.length - 1)] ?? rest[0])?.sessionId ?? null;
  }, []);
  const sessionControls = useChatSessionControls({
    onSessionRemoved: handleSessionRemoved,
    nextSessionAfterRemoval,
    historicalRevisionRef: sessionData.historicalWindowGenerationRef,
    historicalReadOnly: sessionData.contextMutationReadOnly,
    selectionRevisionRef: selection.selectedSessionRevisionRef,
    sendingRevisionRef,
    initialOutboundSessionCreationRef: coordination.initialOutboundSessionCreationRef,
    workspaceId,
    viewIdentity,
    historyView: selection.historyView,
    sessionMode: currentSessionMode,
    selectedProjectId: selection.selectedProjectId,
    selectedSessionId: selection.selectedSessionId,
    selectedSession: threadController.selectedSession,
    renameTitle,
    folderName: metadataDraft.folderName,
    tagsValue: metadataDraft.tagsValue,
    setSelectedProjectId: selection.setSelectedProjectId,
    setSelectedSessionId: selection.setSelectedSessionId,
    setHistoryView: selection.setHistoryView,
    setError: setUiError,
    setSending,
    setQueuedOutbound: (value) => coordination.queuedOutboundSetterRef.current(value),
    setThread: sessionData.setThread,
    setSessions: sessionData.setSessions,
    loadSidebar: loadSidebar,
    onSessionCreated: handleSessionCreated,
    refreshSessionAggregate: refreshChatSessionAggregate,
    setSessionMetadataConflictDraft: metadataActions.handleSessionMetadataConflictDraftChange,
    setBinding: sessionData.setBinding,
  });
  const conversationContext = useChatConversationContext({
    threadController,
    selection,
    sessionData,
    selectedContextTurnIds,
    pendingThreadContext,
    setSelectedContextTurnIds,
    setPendingThreadContext,
  });

  // HX-407 C3/C4b: durable read-only external-source attachments + explicit
  // per-turn selection. When the runtime does not compose the Gateway routes
  // the list read 404s → supported=false → the composer renders nothing. The
  // hook learns `sessionIncarnationId` from its own durable reload (the C4
  // list response carries it), so attach/detach/knowledge-request activate
  // exactly when the server supplies the value and stay disabled fail-closed
  // when it is genuinely absent — the host passes no incarnation of its own.
  const externalSourceAttachments = useExternalSourceAttachments({
    deferCandidates: secondaryEvidenceEnabled !== undefined,
    workspaceId: threadController.selectedSession?.workspaceId ?? workspaceId,
    sessionId:
      threadController.selectedSession?.lifecycleStatus === "active"
        ? threadController.selectedSession.sessionId
        : null,
    pushLocalNotice: pushLocalNotice,
  });
  const { captureOutboundExternalContextRefs } = externalSourceAttachments;
  const { handleOutboundExternalContextSent } = externalSourceAttachments;

  const documentContext = useChatDocuments({
    readEnabled: secondaryEvidenceEnabled,
    workspaceId,
    selectedSession: threadController.selectedSession,
    selectedSessionId: selection.selectedSessionId,
    documentEditingEnabled,
    explicitContextEnabled,
    setUiError: setUiError,
    setActiveGeneratedArtifact,
    loadSessionSecondaryState: loadSessionSecondaryState,
    artifacts: sessionData.generatedArtifacts?.items ?? [],
  });
  const { setPendingDocumentContextRefs } = documentContext;

  return {
    conversationContext,
    sessionData,
    ensureSessionListed,
    captureOutboundExternalContextRefs,
    documentContext,
    explicitContextEnabled,
    runVariables,
    sessionStatusEnabled,
    refresh,
    chatTimersEnabled,
    openChatTimerPanel,
    threadController,
    externalSourceAttachments,
    typedRunVariablesEnabled,
    documentEditingEnabled,
    sessionControls,
    publishSessionLocation,
    loadSidebar,
    refreshChatSessionAggregate,
    loadSessionCoreState,
    handleOutboundExternalContextSent,
    setPendingDocumentContextRefs,
    resolveAgenticRunTree,
    externalControl,
    routeArtifactId,
    timerPanel,
    sessionStatus,
    fanout,
    metadataActions,
  };
}
