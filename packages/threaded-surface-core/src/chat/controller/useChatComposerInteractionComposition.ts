import type { ChatAttachmentRecord } from "@goatcitadel/contracts";
import { useCallback, useMemo } from "react";
import { type ComposerPaletteItem } from "../composer-palette";
import { useChatComposerInteractions } from "../useChatComposerInteractions";
import { useChatGoalActions } from "../useChatGoalActions";
import { useChatMultimodalControls } from "../useChatMultimodalControls";
import { useChatComposerSendIntent } from "./useChatComposerSendIntent";
import { useChatControllerCoordination } from "./useChatControllerCoordination";
import { useChatErrorState } from "./useChatErrorState";
import { useChatGovernedActionComposition } from "./useChatGovernedActionComposition";
import { useChatNoticesAndPresetRefresh } from "./useChatNoticesAndPresetRefresh";
import { useChatOneShotContext } from "./useChatOneShotContext";
import { useChatOutboundComposition } from "./useChatOutboundComposition";
import { useChatScopedErrors } from "./useChatScopedErrors";
import { useChatSessionComposition } from "./useChatSessionComposition";
import { useChatSessionSelection } from "./useChatSessionSelection";
import { useChatSubmissionComposition } from "./useChatSubmissionComposition";
import { useChatSurfaceComposition } from "./useChatSurfaceComposition";
import { useChatSurfaceNavigation } from "./useChatSurfaceNavigation";
import { useChatTurnNavigation } from "./useChatTurnNavigation";

type Input = {
  workspaceId: string;
  surfaceRuntime: Pick<
    ReturnType<typeof useChatSurfaceComposition>,
    "surfaceState" | "workbenchController" | "setDockOpen" | "profileDependentAdmissionBlockReason" | "planningMode"
  >;
  selectedTurnId: string | null;
  navigation: ReturnType<typeof useChatSurfaceNavigation>;
  setSelectedTurnId: React.Dispatch<React.SetStateAction<string | null>>;
  execution: Pick<ReturnType<typeof useChatOutboundComposition>, "outbound" | "contextActions">;
  setFollowThreadOutput: React.Dispatch<React.SetStateAction<boolean>>;
  session: Pick<
    ReturnType<typeof useChatSessionComposition>,
    | "sessionData"
    | "threadController"
    | "sessionControls"
    | "loadSidebar"
    | "refreshChatSessionAggregate"
    | "conversationContext"
    | "externalSourceAttachments"
    | "documentContext"
    | "runVariables"
  >;
  draft: string;
  submission: Pick<
    ReturnType<typeof useChatSubmissionComposition>,
    "palette" | "providerRouting" | "handleComposerSend" | "orchestration" | "currentRoutePreflight" | "btwSideChat"
  >;
  errorState: ReturnType<typeof useChatErrorState>;
  sending: boolean;
  actions: Pick<
    ReturnType<typeof useChatGovernedActionComposition>,
    "preferenceActions" | "planningPreferences" | "handleComposerPaletteSelect" | "knowledgeActions"
  >;
  setSending: React.Dispatch<React.SetStateAction<boolean>>;
  setUiError: ReturnType<typeof useChatScopedErrors>["setUiError"];
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setPendingAttachments: React.Dispatch<React.SetStateAction<ChatAttachmentRecord[]>>;
  setIsDragActive: React.Dispatch<React.SetStateAction<boolean>>;
  setFailedAutoImageRecovery: ReturnType<typeof useChatErrorState>["setFailedAutoImageRecovery"];
  handleDockOpenChange: ReturnType<typeof useChatSurfaceNavigation>["handleDockOpenChange"];
  selection: ReturnType<typeof useChatSessionSelection>;
  pendingAttachments: ChatAttachmentRecord[];
  pushLocalNotice: ReturnType<typeof useChatNoticesAndPresetRefresh>["pushLocalNotice"];
  setPinnedGoal: React.Dispatch<React.SetStateAction<string | undefined>>;
  notices: ReturnType<typeof useChatNoticesAndPresetRefresh>;
  scopedErrors: ReturnType<typeof useChatScopedErrors>;
  coordination: ReturnType<typeof useChatControllerCoordination>;
  oneShotContext: ReturnType<typeof useChatOneShotContext>;
  knowledgeUrlDraft: string;
};

/** Composes turn navigation, composer, media and send-intent owners while leaving final send binding to the Host. */
export function useChatComposerInteractionComposition({
  workspaceId,
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
}: Input) {
  const { handleComposerPaletteSelect } = actions;

  const turnNavigation = useChatTurnNavigation({
    surfaceState: surfaceRuntime.surfaceState,
    workbenchController: surfaceRuntime.workbenchController,
    selectedTurnId,
    navigation,
    setSelectedTurnId,
    outbound: execution.outbound,
    setFollowThreadOutput,
  });
  const lastEditableDraft = useMemo(
    () =>
      [...(session.sessionData.thread?.turns ?? [])]
        .reverse()
        .find((turn) => Boolean(turn.userMessage?.content?.trim()))?.userMessage?.content ?? null,
    [session.sessionData.thread?.turns],
  );
  const composerInteractions = useChatComposerInteractions({
    draft,
    lastEditableDraft,
    commandSuggestions: submission.palette.effectiveCommandSuggestions,
    commandIndex: submission.providerRouting.commandIndex,
    error: errorState.error,
    dockOpen: surfaceRuntime.workbenchController.dockOpen,
    sending,
    selectedSession: session.threadController.selectedSession,
    messageMode: surfaceRuntime.surfaceState.messageMode,
    ensureSession: session.sessionControls.ensureSession,
    handleSend: submission.handleComposerSend,
    handleCreateSession: session.sessionControls.handleCreateSession,
    handleArchiveWorkspaceMissionChats: session.sessionControls.handleArchiveWorkspaceMissionChats,
    handleRunQuickResearch: execution.contextActions.handleRunQuickResearch,
    handlePrefPatch: actions.preferenceActions.handlePrefPatch,
    handleTogglePlanningMode: actions.planningPreferences.handleTogglePlanningMode,
    handleRevealSelectedTurnDetails: turnNavigation.handleRevealSelectedTurnDetails,
    confirmCapabilitySuggestionAction: execution.contextActions.confirmCapabilitySuggestionAction,
    confirmDeleteSession: session.sessionControls.confirmDeleteSession,
    setSending,
    setError: setUiError,
    setDraft,
    setCommandIndex: submission.providerRouting.setCommandIndex,
    setPendingAttachments,
    setIsDragActive,
    setEditingTurnId: submission.orchestration.setEditingTurnId,
    setDockOpen: surfaceRuntime.setDockOpen,
    setArchiveWorkspaceConfirmOpen: session.sessionControls.setArchiveWorkspaceConfirmOpen,
    onApplySuggestion: submission.palette.composerPaletteEnabled
      ? (item) => void handleComposerPaletteSelect(item as ComposerPaletteItem)
      : undefined,
  });
  const { handleDismissError: composerInteractionsHandleDismissError } = composerInteractions;
  const { handleCreateCurrentModeSession } = composerInteractions;

  const handleDismissError = useCallback(() => {
    setFailedAutoImageRecovery(null);
    composerInteractionsHandleDismissError();
  }, [composerInteractionsHandleDismissError, setFailedAutoImageRecovery]);
  const handleToggleDock = useCallback(() => {
    handleDockOpenChange(!surfaceRuntime.workbenchController.dockOpen);
  }, [surfaceRuntime.workbenchController.dockOpen, handleDockOpenChange]);
  const latestAssistantTurn = useMemo(
    () =>
      [...(session.sessionData.thread?.turns ?? [])]
        .reverse()
        .find((turn) => Boolean(turn.assistantMessage?.content?.trim())) ?? null,
    [session.sessionData.thread?.turns],
  );
  const multimodal = useChatMultimodalControls({
    providerOptions: submission.providerRouting.providerOptions,
    selectedProviderId: submission.providerRouting.selectedProviderId,
    preferredImageProviderId: session.sessionData.prefs?.imageProviderId,
    preferredImageModel: session.sessionData.prefs?.imageModel,
    routePreflight: submission.currentRoutePreflight,
    selectedSessionId: selection.selectedSessionId,
    activeThreadSessionId: session.sessionData.thread?.sessionId,
    pendingAttachments,
    draft,
    latestAssistantMessageId: latestAssistantTurn?.assistantMessage?.messageId,
    latestAssistantContent: latestAssistantTurn?.assistantMessage?.content,
    latestAssistantStatus: latestAssistantTurn?.trace.status,
    setDraft,
    setError: setUiError,
    pushLocalNotice: pushLocalNotice,
    uploadAttachments: composerInteractions.uploadAttachments,
  });
  const goalActions = useChatGoalActions({
    selectedSessionId: selection.selectedSessionId,
    selectedSession: session.threadController.selectedSession,
    historyView: selection.historyView,
    loadSidebar: session.loadSidebar,
    setPinnedGoal,
    refreshChatSessionAggregate: session.refreshChatSessionAggregate,
    setUiError: setUiError,
    pushLocalNotice: pushLocalNotice,
  });
  const sendIntent = useChatComposerSendIntent({
    workspaceId,
    profileDependentAdmissionBlockReason: surfaceRuntime.profileDependentAdmissionBlockReason,
    notices,
    setFollowThreadOutput,
    knowledgeActions: actions.knowledgeActions,
    orchestration: submission.orchestration,
    scopedErrors,
    draft,
    openBtwSideChat: submission.btwSideChat.openSideChat,
    setDraft,
    coordination,
    goalActions,
    oneShotContext,
    selection,
    pendingAttachments,
    setPendingAttachments,
    sessionData: session.sessionData,
    conversationContext: session.conversationContext,
    externalSourceAttachments: session.externalSourceAttachments,
    pendingDocumentContextRefs: session.documentContext.pendingDocumentContextRefs,
    knowledgeUrlDraft,
    runVariables: session.runVariables,
    surfaceState: surfaceRuntime.surfaceState,
    planningMode: surfaceRuntime.planningMode,
    multimodal,
    errorState,
  });
  const { handleSendWithKnowledge } = sendIntent;

  return {
    handleSendWithKnowledge,
    composerInteractions,
    handleToggleDock,
    turnNavigation,
    multimodal,
    handleDismissError,
    sendIntent,
    goalActions,
    handleCreateCurrentModeSession,
  };
}
