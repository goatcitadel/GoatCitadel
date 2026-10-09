import { WorkspaceChannelPlanReview } from "./chat/WorkspaceChannelPlanReview";
import { createChatActiveSessionPresentation } from "./chat/controller/createChatActiveSessionPresentation";
import { createChatChangePlanReceipt } from "./chat/controller/createChatChangePlanReceipt";
import { createChatContextDockProps } from "./chat/controller/createChatContextDockProps";
import { createChatDropTargetProps } from "./chat/controller/createChatDropTargetProps";
import { renderChatControllerFrame } from "./chat/controller/renderChatControllerFrame";
import { useChatComposerInteractionComposition } from "./chat/controller/useChatComposerInteractionComposition";
import { useChatControllerCoordination } from "./chat/controller/useChatControllerCoordination";
import { useChatErrorState } from "./chat/controller/useChatErrorState";
import { useChatGovernedActionComposition } from "./chat/controller/useChatGovernedActionComposition";
import { useChatMetadataDraftState } from "./chat/controller/useChatMetadataDraftState";
import { useChatNoticesAndPresetRefresh } from "./chat/controller/useChatNoticesAndPresetRefresh";
import { useChatOneShotContext } from "./chat/controller/useChatOneShotContext";
import { useChatOutboundComposition } from "./chat/controller/useChatOutboundComposition";
import { useChatPresetCatalogState } from "./chat/controller/useChatPresetCatalogState";
import { useChatScopedErrors } from "./chat/controller/useChatScopedErrors";
import { useChatSessionComposition } from "./chat/controller/useChatSessionComposition";
import { useChatSessionRailPresentation } from "./chat/controller/useChatSessionRailPresentation";
import { useChatSessionRestoration } from "./chat/controller/useChatSessionRestoration";
import { useChatSessionSelection } from "./chat/controller/useChatSessionSelection";
import { useChatStreamPreferences } from "./chat/controller/useChatStreamPreferences";
import { useChatSubmissionComposition } from "./chat/controller/useChatSubmissionComposition";
import { useChatSurfaceComposition } from "./chat/controller/useChatSurfaceComposition";
import { useChatSurfaceNavigation } from "./chat/controller/useChatSurfaceNavigation";
import { createThreadedWorkflowPanel } from "./chat/create-threaded-workflow-panel";
import { useChatChangePlanState } from "./chat/useChatChangePlanState";
import type { MissionThreadedControllerHostProps } from "./MissionThreadedControllerHost.types";
export {
  mergeHydratedOutboundQueue,
  parseHydratedChatAttachments,
  parseHydratedOutboundQueue,
} from "./chat/hydrated-storage";
import type {
  ChatAttachmentRecord,
  ChatGeneratedArtifactRecord,
  ThreadKnowledgeRetrievalMode,
} from "@goatcitadel/contracts";
import { useDeferredValue, useLayoutEffect, useState } from "react";

import { type AgenticRunTreeResponse } from "@goatcitadel/mission-control-shared/api/agentic";

import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";

import { useEventStreamStatus } from "@goatcitadel/mission-control-shared/hooks/useEventStreamStatus";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";

import {
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
  resolveChatRefreshPlan,
  resolveOptimisticChatPrefs,
  resolveSelectedTurnId,
  revealGeneratedArtifactInSurface,
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
} from "./chat/chat-page-pure-helpers";
import {
  formatFallbackSummary,
  formatRoutingTargetSummary,
  formatRuntimeSummary,
  formatThreadedRunStateLabel,
  formatThreadedRunStateSummary,
  reconcilePendingAttachmentModes,
  requiresBoundaryAcknowledgment,
  resolveExecutionRoutePrefs,
  runWithSelectedSession,
  runWithSelectedSessionId,
  type PendingAttachmentDocumentMode,
} from "./chat/mission-threaded-controller-helpers";
import type { OutboundContextBlock } from "./chat/useChatSurfaceOrchestration";

import {
  formatSessionLabel,
  looksMachineSessionLabel,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
} from "./chat/useMissionControlSurfaceState";
import { useSurfaceClassifyPreview } from "./chat/useSurfaceClassifyPreview";
import type {
  MissionThreadedEmptyStateProps,
  MissionThreadedRenderSurfaceInput,
} from "./MissionThreadedControllerHost.types";

export {
  formatSessionLabel,
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
  looksMachineSessionLabel,
  resolveChatRefreshPlan,
  resolveOptimisticChatPrefs,
  resolveSelectedTurnId,
  revealGeneratedArtifactInSurface,
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
};

export type { PendingAttachmentDocumentMode } from "./chat/mission-threaded-controller-helpers";
export {
  formatFallbackSummary,
  formatRoutingTargetSummary,
  formatRuntimeSummary,
  formatThreadedRunStateLabel,
  formatThreadedRunStateSummary,
  reconcilePendingAttachmentModes,
  requiresBoundaryAcknowledgment,
  resolveExecutionRoutePrefs,
  runWithSelectedSession,
  runWithSelectedSessionId,
};

export type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedChangePlanReceipt,
  MissionThreadedCodeWorkflowPanelProps,
  MissionThreadedContextDockProps,
  MissionThreadedDropTargetProps,
  MissionThreadedEmptyStateProps,
  MissionThreadedRenderSurfaceInput,
  MissionThreadedSessionRailData,
  MissionThreadedWorkflowPanel,
} from "./MissionThreadedControllerHost.types";

const STREAM_PREF_KEY = "goatcitadel.chat.agent.stream.enabled";
export function MissionThreadedControllerHost({
  workspaceId = "default",
  workspaceName = workspaceId,
  approvalsCount = 0,
  surface,
  lockSurface = false,
  hidePageHeader = false,
  renderWhileLoading = false,
  initialModeOverride,
  routeSearch: shownRouteSearch,
  gatewayStatus,
  workTrust,
  onWorkTrustSummaryChange,
  onOpenCowork = () => undefined,
  onOpenCode = () => undefined,
  onOpenTasks = () => undefined,
  onOpenApprovals = () => undefined,
  onOpenStartHere = () => undefined,
  onOpenPersonalitiesSettings = () => undefined,
  onOpenProviderSettings = () => undefined,
  onReturnToChannels,
  onOpenLocalAiSettings = () => undefined,
  onOpenLibraryArtifacts = () => undefined,
  onOpenLibraryImports = () => undefined,
  onOpenOpsRuntime = () => undefined,
  onNavigateSurface,
  onResolvedModeChange,
  renderSurface,
}: MissionThreadedControllerHostProps) {
  const selection = useChatSessionSelection({ initialModeOverride });
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [selectedContextTurnIds, setSelectedContextTurnIds] = useState<string[]>([]);
  const [workbenchRequested, setWorkbenchRequested] = useState(false);
  const [pendingThreadContext, setPendingThreadContext] = useState<OutboundContextBlock | null>(null);
  const [draft, setDraft] = useState("");
  const [pinnedGoal, setPinnedGoal] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const oneShotContext = useChatOneShotContext();
  const { restoreWorkspaceSnapshotRequest } = oneShotContext;

  const errorState = useChatErrorState();
  const { setFailedAutoImageRecovery } = errorState;

  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachmentRecord[]>([]);
  const metadataDraft = useChatMetadataDraftState();
  const streamPreferences = useChatStreamPreferences({ STREAM_PREF_KEY });
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
  const scopedErrors = useChatScopedErrors({ selection, errorState, draft });
  const { setUiError } = scopedErrors;

  const presetCatalog = useChatPresetCatalogState();
  const [composerPaletteGlobalOpen, setComposerPaletteGlobalOpen] = useState(false);
  const [composerPaletteQuery, setComposerPaletteQuery] = useState("");
  const changePlanState = useChatChangePlanState(selection.selectedSessionId);
  const [forkConfirm, setForkConfirm] = useState<{
    turnId: string;
    turnCount: number;
    attachmentCount: number;
    artifactCount: number;
  } | null>(null);
  const [forkPending, setForkPending] = useState(false);
  const [agenticRunTree, setAgenticRunTree] = useState<AgenticRunTreeResponse | null>(null);
  const [agenticControlPending, setAgenticControlPending] = useState<string | null>(null);
  const [agenticControlStatus, setAgenticControlStatus] = useState<string | null>(null);
  const coordination = useChatControllerCoordination();
  const routeSearch = shownRouteSearch ?? (typeof window === "undefined" ? "" : window.location.search);
  const deferredSearch = useDeferredValue(search.trim());
  // Keep controller ownership aligned with ThreadedSurfacePage and its CSS:
  // below 1180px the inline rail becomes a drawer. Using the shell's narrower
  // 1023px breakpoint here immediately closed that drawer at laptop widths.
  const compactSurfaceLayout = useMediaQuery("(width < 1180px)");
  const providerCatalog = useProviderModelCatalog("chat");
  const eventStreamStatus = useEventStreamStatus();
  const notices = useChatNoticesAndPresetRefresh({ setLocalNotices, coordination, presetCatalog });
  const { pushLocalNotice } = notices;
  const session = useChatSessionComposition({
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
  });
  const submission = useChatSubmissionComposition({
    draft,
    pendingAttachments,
    session,
    selection,
    sending,
    coordination,
    setDraft,
    setPendingAttachments,
    setUiError,
    oneShotContext,
    providerCatalog,
    composerPaletteGlobalOpen,
    composerPaletteQuery,
    workspaceId,
    presetCatalog,
    selectedTurnId,
    setComposerPaletteGlobalOpen,
    setComposerPaletteQuery,
    lockSurface,
    surface,
    pushLocalNotice,
    onWorkTrustSummaryChange,
    notices,
    scopedErrors,
    changePlanState,
  });
  const execution = useChatOutboundComposition({
    selection,
    session,
    selectedTurnId,
    draft,
    submission,
    oneShotContext,
    sending,
    streamPreferences,
    setUiError,
    setSending,
    pushLocalNotice,
    coordination,
    errorState,
    setDraft,
    setPendingAttachments,
    restoreWorkspaceSnapshotRequest,
    setSelectedTurnId,
    setLocalNotices,
  });
  useChatSessionRestoration({
    initialOutboundSessionCreationRef: coordination.initialOutboundSessionCreationRef,
    workspaceId,
    selection,
    orchestration: submission.orchestration,
    setPinnedGoal,
    sessionData: session.sessionData,
    setDraft,
    setPendingAttachments,
    setPendingAttachmentModes,
    pendingAttachments,
    activeGeneratedArtifact,
    setActiveGeneratedArtifact,
    draft,
    STREAM_PREF_KEY,
    streamPreferences,
    metadataDraft,
    threadController: session.threadController,
    setRenameTitle,
  });
  const surfaceRuntime = useChatSurfaceComposition({
    session,
    lockSurface,
    surface,
    selectedTurnId,
    selection,
    execution,
    activeGeneratedArtifact,
    workspaceId,
    coordination,
    workbenchRequested,
    localNotices,
    agenticRunTree,
    setAgenticControlStatus,
    setAgenticControlPending,
    setAgenticRunTree,
    pushLocalNotice,
    compactSurfaceLayout,
    sessionRailOpen,
    setSessionRailOpen,
    submission,
    workTrust,
    workspaceName,
    gatewayStatus,
    approvalsCount,
    draft,
    pendingAttachments,
    sending,
    oneShotContext,
  });
  const { blockHistoricalMutation } = surfaceRuntime;

  const navigation = useChatSurfaceNavigation({
    sessionData: session.sessionData,
    selection,
    setSelectedTurnId,
    setSelectedContextTurnIds,
    setPendingThreadContext,
    setActiveGeneratedArtifact,
    setSessionRailOpen,
    onNavigateSurface,
    surfaceState: surfaceRuntime.surfaceState,
    compactSurfaceLayout,
    workbenchController: surfaceRuntime.workbenchController,
    activeGeneratedArtifact,
    selectedTurnId,
  });
  const { handleDockOpenChange } = navigation;
  const actions = useChatGovernedActionComposition({
    session,
    workspaceId,
    activeGeneratedArtifact,
    compactSurfaceLayout,
    surfaceRuntime,
    selection,
    selectedTurnId,
    setSessionRailOpen,
    setActiveGeneratedArtifact,
    setSelectedTurnId,
    changePlanState,
    navigation,
    setUiError,
    pushLocalNotice,
    notices,
    scopedErrors,
    coordination,
    execution,
    metadataDraft,
    setSelectedContextTurnIds,
    setPendingThreadContext,
    setForkPending,
    setDraft,
    setForkConfirm,
    submission,
    onOpenApprovals,
    pendingAttachments,
    pendingAttachmentModes,
    setPendingAttachmentModes,
    knowledgeUrlDraft,
    knowledgeUrlMode,
    setKnowledgeUrlDraft,
    presetCatalog,
    setPresetApplyWarning,
    setPendingAttachments,
    setComposerPaletteGlobalOpen,
    setComposerPaletteQuery,
  });
  const { recordChangePlanResult } = actions;

  const composer = useChatComposerInteractionComposition({
    surfaceRuntime,
    selectedTurnId,
    navigation,
    setSelectedTurnId,
    execution,
    setFollowThreadOutput,
    session,
    draft,
    submission,
    errorState,
    sending,
    actions,
    setSending,
    setUiError,
    setDraft,
    setPendingAttachments,
    setIsDragActive,
    setFailedAutoImageRecovery,
    handleDockOpenChange,
    selection,
    pendingAttachments,
    pushLocalNotice,
    setPinnedGoal,
    notices,
    scopedErrors,
    coordination,
    oneShotContext,
    knowledgeUrlDraft,
  });
  const { handleSendWithKnowledge } = composer;
  const { handleCreateCurrentModeSession } = composer;

  useLayoutEffect(() => {
    submission.composerSendHandlerRef.current = async () => {
      if (surfaceRuntime.historicalModeActive) {
        pushLocalNotice("Return to the latest conversation before sending a message.", "warning");
        return;
      }
      await handleSendWithKnowledge();
    };
  }, [
    handleSendWithKnowledge,
    surfaceRuntime.historicalModeActive,
    pushLocalNotice,
    submission.composerSendHandlerRef,
  ]);
  const chatSessionRailPresentation = useChatSessionRailPresentation({
    lifecycleNotices: surfaceRuntime.runPresentation.lifecycleNotices,
    localNotices,
    queuedOutbound: submission.orchestration.queuedOutbound,
    presetProfiles: presetCatalog.presetProfiles,
    lockSurface,
    search,
    workspaceName,
    deferredSearch,
    blockHistoricalMutation: blockHistoricalMutation,
    setSearch,
    handleSelectSessionFromRail: navigation.handleSelectSessionFromRail,
    sessionData: session.sessionData,
    threadController: session.threadController,
    surfaceState: surfaceRuntime.surfaceState,
    sessionControls: session.sessionControls,
    composerInteractions: composer.composerInteractions,
    selection,
  });

  const autoRouteActive = false;
  const surfacePreview = useSurfaceClassifyPreview({
    draft,
    enabled: autoRouteActive,
    workspaceId,
    hasBoundProject: !surfaceRuntime.surfaceState.codeModeNeedsProjectBinding,
  });
  const activePresentation = createChatActiveSessionPresentation({
    session,
    chatSessionRailPresentation,
    surfaceRuntime,
    sending,
    composer,
    navigation,
    onResolvedModeChange,
    actions,
    submission,
    providerCatalog,
    selection,
    selectedTurnId,
    selectedContextTurnIds,
    followThreadOutput,
    streamPreferences,
    workspaceId,
    approvalsCount,
    eventStreamStatus,
    setFollowThreadOutput,
    setSelectedTurnId,
    setForkConfirm,
    handleDockOpenChange,
    onOpenPersonalitiesSettings,
    onOpenProviderSettings,
    onOpenLocalAiSettings,
    onOpenLibraryArtifacts,
    onOpenLibraryImports,
    onOpenOpsRuntime,
    pushLocalNotice,
    onOpenApprovals,
    execution,
    errorState,
    isDragActive,
    draft,
    composerPaletteGlobalOpen,
    composerPaletteQuery,
    setComposerPaletteGlobalOpen,
    setComposerPaletteQuery,
    pendingAttachments,
    pendingAttachmentModes,
    presetCatalog,
    presetApplyWarning,
    oneShotContext,
    setDraft,
    setPresetApplyWarning,
    knowledgeUrlDraft,
    knowledgeUrlMode,
    setKnowledgeUrlDraft,
    setKnowledgeUrlMode,
    coordination,
    activeGeneratedArtifact,
    agenticControlPending,
    pinnedGoal,
    surfacePreview,
    autoRouteActive,
  });

  const emptyStateProps: MissionThreadedEmptyStateProps = {
    mode: surfaceRuntime.surfaceState.messageMode,
    sessionCount: session.threadController.missionSessions.length + session.threadController.externalSessions.length,
    projectCount: session.sessionData.projects?.items.length ?? 0,
    workspaceName,
    approvalsCount,
    onCreateSession: () => {
      if (!blockHistoricalMutation()) void handleCreateCurrentModeSession();
    },
    onOpenCowork,
    onOpenCode,
    onOpenTasks,
    onOpenApprovals,
    onOpenStartHere,
  };

  const workflowPanel = createThreadedWorkflowPanel({
    workspaceId,
    selectedSession: session.threadController.selectedSession,
    isCoworkSurface: surfaceRuntime.surfaceState.isCoworkSurface,
    isCodeSurface: surfaceRuntime.surfaceState.isCodeSurface,
    isChatSurface: surfaceRuntime.surfaceState.isChatSurface,
    coworkViewModel: surfaceRuntime.runPresentation.coworkViewModel,
    blockHistoricalMutation: blockHistoricalMutation,
    handleRetryTurn: submission.orchestration.handleRetryTurn,
    handleStopActiveTurn: submission.orchestration.handleStopActiveTurn,
    onOpenTasks,
    handleRevealActiveTurnDetails: composer.turnNavigation.handleRevealActiveTurnDetails,
    composerRef: coordination.composerRef,
    historicalModeActive: surfaceRuntime.historicalModeActive,
    handleAgenticControl: surfaceRuntime.handleAgenticControl,
    agenticControlPending,
    agenticControlStatus,
    selectedTurn: surfaceRuntime.surfaceState.selectedTurn,
    selectedProject: session.threadController.selectedProject,
    codeModeNeedsProjectBinding: surfaceRuntime.surfaceState.codeModeNeedsProjectBinding,
    activeGeneratedArtifact,
    handleCloseGeneratedArtifact: actions.artifactActions.handleCloseGeneratedArtifact,
    activeCodeProjects: chatSessionRailPresentation.activeCodeProjects,
    selectedProjectBindingCandidateId: surfaceRuntime.surfaceState.selectedProjectBindingCandidateId,
    sessionControlPending: session.sessionControls.sessionControlPending,
    handleAssignProject: session.sessionControls.handleAssignProject,
    handleImportCodeProject: session.sessionControls.handleImportCodeProject,
    pushLocalNotice: pushLocalNotice,
    handleRunCodeHelper: actions.codeLaunch.handleRunCodeHelper,
    onOpenApprovals,
    workbenchController: surfaceRuntime.workbenchController,
  });
  const chatChangePlanReceipt = createChatChangePlanReceipt({
    thread: session.sessionData.thread,
    changePlanState,
    modelPlans: actions.modelPlans,
  });

  const threadedSurfaceInput: MissionThreadedRenderSurfaceInput = {
    messageMode: surfaceRuntime.surfaceState.messageMode,
    sessionRailOpen,
    onSessionRailOpenChange: navigation.handleSessionRailOpenChange,
    dockOpen: surfaceRuntime.workbenchController.dockOpen,
    onDockOpenChange: handleDockOpenChange,
    onWorkbenchOpenChange: setWorkbenchRequested,
    sessionRail: chatSessionRailPresentation.sessionRailData,
    activeSessionSurfaceProps: activePresentation.activeSessionSurfaceProps,
    emptyStateProps,
    ...createChatDropTargetProps({
      isDragActive,
      fileInputRef: coordination.fileInputRef,
      blockHistoricalMutation: blockHistoricalMutation,
      composerInteractions: composer.composerInteractions,
    }),
    workflowPanel,
    changePlans: changePlanState.chatChangePlans,
    changePlanReceipt: chatChangePlanReceipt.changePlanReceipt,
    onReviewChangePlan: (plan) => {
      if (plan.origin.sessionId !== selection.selectedSessionIdRef.current || plan.origin.workspaceId !== workspaceId)
        return;
      recordChangePlanResult(plan);
    },
    activityOpenRequest: changePlanState.activityOpenRequest,
    btwSideChatProps: submission.btwSideChat.panelProps,
    ...createChatContextDockProps({
      planningMode: surfaceRuntime.planningMode,
      sending,
      blockHistoricalMutation: blockHistoricalMutation,
      selectedSessionId: selection.selectedSessionId,
      capabilityProfileInspection: surfaceRuntime.capabilityProfileInspection,
      activeGeneratedArtifact,
      documents: session.documentContext.documents,
      currentRoutePreflight: submission.currentRoutePreflight,
      proactiveSuggestionCount: surfaceRuntime.proactiveSuggestionCount,
      chatSessionRailPresentation,
      automaticFanout: session.fanout.automaticFanout,
      requestThreadModelPatch: actions.modelPlans.requestThreadModelPatch,
      pushLocalNotice: pushLocalNotice,
      handleCloseGeneratedArtifact: actions.artifactActions.handleCloseGeneratedArtifact,
      renameTitle,
      threadController: session.threadController,
      surfaceState: surfaceRuntime.surfaceState,
      workbenchController: surfaceRuntime.workbenchController,
      sessionControls: session.sessionControls,
      providerRouting: submission.providerRouting,
      providerCatalog,
      sessionData: session.sessionData,
      preferenceActions: actions.preferenceActions,
      runPresentation: surfaceRuntime.runPresentation,
      contextActions: execution.contextActions,
      exportActions: actions.exportActions,
      streamPreferences,
      metadataDraft,
      metadataActions: session.metadataActions,
    }),
  };
  const frame = renderChatControllerFrame({
    lockSurface,
    renderWhileLoading,
    error: errorState.error,
    hidePageHeader,
    approvalsCount,
    workspaceName,
    selectedSessionId: selection.selectedSessionId,
    visibleRunStateLabel: surfaceRuntime.runPresentation.visibleRunStateLabel,
    renderSurface,
    threadedSurfaceInput,
    forkConfirm,
    forkPending,
    setForkConfirm,
    blockHistoricalMutation: blockHistoricalMutation,
    handleStartNewThreadFromTurn: actions.conversationFork.handleStartNewThreadFromTurn,
    surfaceState: surfaceRuntime.surfaceState,
    sessionData: session.sessionData,
    threadController: session.threadController,
    contextActions: execution.contextActions,
    composerInteractions: composer.composerInteractions,
    changePlanState,
    planConfirmations: actions.planConfirmations,
    planActions: actions.planActions,
    planOAuth: actions.planOAuth,
    sessionControls: session.sessionControls,
  });
  return <><WorkspaceChannelPlanReview workspaceId={workspaceId} routeSearch={routeSearch} onReturnToChannels={onReturnToChannels} onOpenApprovals={onOpenApprovals} />{frame}</>;
}
