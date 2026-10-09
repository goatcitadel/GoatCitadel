import type {
  ChatAttachmentRecord,
  ChatGeneratedArtifactRecord,
  ThreadKnowledgeRetrievalMode,
} from "@goatcitadel/contracts";
import { useEventStreamStatus } from "@goatcitadel/mission-control-shared/hooks/useEventStreamStatus";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";
import { type PendingAttachmentDocumentMode } from "../mission-threaded-controller-helpers";
import type { MissionControlActiveSessionSurfaceProps } from "../MissionControlActiveSessionSurface";
import { useSurfaceClassifyPreview } from "../useSurfaceClassifyPreview";
import { createChatComposerActionProps } from "./createChatComposerActionProps";
import { createChatComposerContextProps } from "./createChatComposerContextProps";
import { createChatMediaProps } from "./createChatMediaProps";
import { createChatRunControlProps } from "./createChatRunControlProps";
import { createChatSessionHeaderProps } from "./createChatSessionHeaderProps";
import { createChatTranscriptProps } from "./createChatTranscriptProps";
import { useChatComposerInteractionComposition } from "./useChatComposerInteractionComposition";
import { useChatControllerCoordination } from "./useChatControllerCoordination";
import { useChatErrorState } from "./useChatErrorState";
import { useChatGovernedActionComposition } from "./useChatGovernedActionComposition";
import { useChatNoticesAndPresetRefresh } from "./useChatNoticesAndPresetRefresh";
import { useChatOneShotContext } from "./useChatOneShotContext";
import { useChatOutboundComposition } from "./useChatOutboundComposition";
import { useChatPresetCatalogState } from "./useChatPresetCatalogState";
import { useChatSessionComposition } from "./useChatSessionComposition";
import { useChatSessionRailPresentation } from "./useChatSessionRailPresentation";
import { useChatSessionSelection } from "./useChatSessionSelection";
import { useChatStreamPreferences } from "./useChatStreamPreferences";
import { useChatSubmissionComposition } from "./useChatSubmissionComposition";
import { useChatSurfaceComposition } from "./useChatSurfaceComposition";
import { useChatSurfaceNavigation } from "./useChatSurfaceNavigation";

type Input = {
  session: Pick<
    ReturnType<typeof useChatSessionComposition>,
    | "threadController"
    | "sessionControls"
    | "sessionStatusEnabled"
    | "timerPanel"
    | "typedRunVariablesEnabled"
    | "runVariables"
    | "sessionData"
    | "sessionStatus"
    | "conversationContext"
    | "externalSourceAttachments"
    | "externalControl"
  >;
  chatSessionRailPresentation: ReturnType<typeof useChatSessionRailPresentation>;
  surfaceRuntime: Pick<
    ReturnType<typeof useChatSurfaceComposition>,
    | "runPresentation"
    | "historicalModeActive"
    | "workbenchController"
    | "blockHistoricalMutation"
    | "surfaceState"
    | "historicalTargetIsSelected"
    | "planningMode"
    | "capabilityProfileInspection"
    | "routeBoundaryAckRequired"
    | "canSend"
    | "canSendWhileRunning"
    | "profileDependentAdmissionBlockReason"
    | "handleAgenticControl"
  >;
  sending: boolean;
  composer: Pick<
    ReturnType<typeof useChatComposerInteractionComposition>,
    | "handleToggleDock"
    | "turnNavigation"
    | "multimodal"
    | "handleDismissError"
    | "sendIntent"
    | "composerInteractions"
    | "goalActions"
  >;
  navigation: Pick<ReturnType<typeof useChatSurfaceNavigation>, "handleNavigateSurface">;
  onResolvedModeChange: MissionThreadedControllerHostProps["onResolvedModeChange"];
  actions: Pick<
    ReturnType<typeof useChatGovernedActionComposition>,
    | "modelPlans"
    | "exportActions"
    | "artifactActions"
    | "conversationFork"
    | "handleComposerPaletteSelect"
    | "preferenceActions"
    | "presetActions"
    | "knowledgeRemoval"
    | "knowledgeActions"
    | "planningPreferences"
  >;
  submission: Pick<
    ReturnType<typeof useChatSubmissionComposition>,
    | "providerRouting"
    | "orchestration"
    | "currentRoutePreflight"
    | "routePreflight"
    | "currentRouteBoundaryAcknowledged"
    | "palette"
    | "acknowledgeCurrentRouteBoundary"
    | "handleComposerSend"
  >;
  providerCatalog: ReturnType<typeof useProviderModelCatalog>;
  selection: ReturnType<typeof useChatSessionSelection>;
  selectedTurnId: string | null;
  selectedContextTurnIds: string[];
  followThreadOutput: boolean;
  streamPreferences: Pick<ReturnType<typeof useChatStreamPreferences>, "visualStreamMode">;
  workspaceId: NonNullable<MissionThreadedControllerHostProps["workspaceId"]>;
  approvalsCount: NonNullable<MissionThreadedControllerHostProps["approvalsCount"]>;
  eventStreamStatus: ReturnType<typeof useEventStreamStatus>;
  setFollowThreadOutput: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedTurnId: React.Dispatch<React.SetStateAction<string | null>>;
  setForkConfirm: React.Dispatch<
    React.SetStateAction<{
      turnId: string;
      turnCount: number;
      attachmentCount: number;
      artifactCount: number;
    } | null>
  >;
  handleDockOpenChange: ReturnType<typeof useChatSurfaceNavigation>["handleDockOpenChange"];
  onOpenPersonalitiesSettings: NonNullable<MissionThreadedControllerHostProps["onOpenPersonalitiesSettings"]>;
  onOpenProviderSettings: NonNullable<MissionThreadedControllerHostProps["onOpenProviderSettings"]>;
  onOpenLocalAiSettings: NonNullable<MissionThreadedControllerHostProps["onOpenLocalAiSettings"]>;
  onOpenLibraryArtifacts: NonNullable<MissionThreadedControllerHostProps["onOpenLibraryArtifacts"]>;
  onOpenLibraryImports: NonNullable<MissionThreadedControllerHostProps["onOpenLibraryImports"]>;
  onOpenOpsRuntime: NonNullable<MissionThreadedControllerHostProps["onOpenOpsRuntime"]>;
  pushLocalNotice: ReturnType<typeof useChatNoticesAndPresetRefresh>["pushLocalNotice"];
  onOpenApprovals: NonNullable<MissionThreadedControllerHostProps["onOpenApprovals"]>;
  execution: Pick<ReturnType<typeof useChatOutboundComposition>, "contextActions" | "outbound">;
  errorState: ReturnType<typeof useChatErrorState>;
  isDragActive: boolean;
  draft: string;
  composerPaletteGlobalOpen: boolean;
  composerPaletteQuery: string;
  setComposerPaletteGlobalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setComposerPaletteQuery: React.Dispatch<React.SetStateAction<string>>;
  pendingAttachments: ChatAttachmentRecord[];
  pendingAttachmentModes: Record<string, PendingAttachmentDocumentMode>;
  presetCatalog: Pick<ReturnType<typeof useChatPresetCatalogState>, "selectedPresetId" | "setSelectedPresetId">;
  presetApplyWarning: string | null;
  oneShotContext: ReturnType<typeof useChatOneShotContext>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setPresetApplyWarning: React.Dispatch<React.SetStateAction<string | null>>;
  knowledgeUrlDraft: string;
  knowledgeUrlMode: ThreadKnowledgeRetrievalMode;
  setKnowledgeUrlDraft: React.Dispatch<React.SetStateAction<string>>;
  setKnowledgeUrlMode: React.Dispatch<React.SetStateAction<ThreadKnowledgeRetrievalMode>>;
  coordination: ReturnType<typeof useChatControllerCoordination>;
  activeGeneratedArtifact: ChatGeneratedArtifactRecord | null;
  agenticControlPending: string | null;
  pinnedGoal: string | undefined;
  surfacePreview: ReturnType<typeof useSurfaceClassifyPreview>;
  autoRouteActive: false;
};

/** Assembles the six focused session presentation sections when a session is selected. */
export function createChatActiveSessionPresentation({
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
}: Input) {
  const activeSessionSurfaceProps: MissionControlActiveSessionSurfaceProps | null = session.threadController
    .selectedSession
    ? {
        canSendWhileRunning: surfaceRuntime.canSendWhileRunning,
        attachmentUpload: composer.composerInteractions.attachmentUpload,
        projectSwitchContext: {
          workspaceId,
          session: session.threadController.selectedSession,
          projects: session.sessionData.projects?.items ?? [],
          mutationPending: session.sessionControls.sessionControlPending !== null,
        },
        ...createChatSessionHeaderProps({
          workspaceSummaryText: chatSessionRailPresentation.workspaceSummaryText,
          sessionTrust: surfaceRuntime.runPresentation.sessionTrust,
          sending,
          historicalModeActive: surfaceRuntime.historicalModeActive,
          selectedSession: session.threadController.selectedSession,
          dockOpen: surfaceRuntime.workbenchController.dockOpen,
          handleToggleDock: composer.handleToggleDock,
          blockHistoricalMutation: surfaceRuntime.blockHistoricalMutation,
          handleNavigateSurface: navigation.handleNavigateSurface,
          onResolvedModeChange,
          requestThreadModelPatch: actions.modelPlans.requestThreadModelPatch,
          surfaceState: surfaceRuntime.surfaceState,
          providerRouting: submission.providerRouting,
          sessionControls: session.sessionControls,
          providerCatalog,
          selection,
        }),
        ...createChatTranscriptProps({
          historicalTargetIsSelected: surfaceRuntime.historicalTargetIsSelected,
          historicalModeActive: surfaceRuntime.historicalModeActive,
          selectedTurnId,
          selectedContextTurnIds,
          visibleDelegationRun: surfaceRuntime.runPresentation.visibleDelegationRun,
          threadNotices: chatSessionRailPresentation.threadNotices,
          sessionStatusEnabled: session.sessionStatusEnabled,
          chatTimerPanel: session.timerPanel.chatTimerPanel,
          typedRunVariablesEnabled: session.typedRunVariablesEnabled,
          runVariablePanel: session.runVariables.runVariablePanel,
          followThreadOutput,
          visualStreamMode: streamPreferences.visualStreamMode,
          selectedSession: session.threadController.selectedSession,
          workspaceId,
          approvalsCount,
          eventStreamStatus,
          setFollowThreadOutput,
          setSelectedTurnId,
          blockHistoricalMutation: surfaceRuntime.blockHistoricalMutation,
          setForkConfirm,
          handleSelectBranchTurnAndSync: composer.turnNavigation.handleSelectBranchTurnAndSync,
          dockOpen: surfaceRuntime.workbenchController.dockOpen,
          handleDockOpenChange: handleDockOpenChange,
          handleExportRunBundle: actions.exportActions.handleExportRunBundle,
          onOpenPersonalitiesSettings,
          onOpenProviderSettings,
          onOpenLocalAiSettings,
          onOpenLibraryArtifacts,
          onOpenLibraryImports,
          onOpenOpsRuntime,
          pushLocalNotice: pushLocalNotice,
          onOpenApprovals,
          sessionData: session.sessionData,
          contextActions: execution.contextActions,
          sessionStatus: session.sessionStatus,
          outbound: execution.outbound,
          orchestration: submission.orchestration,
          artifactActions: actions.artifactActions,
          conversationContext: session.conversationContext,
          errorState,
          conversationFork: actions.conversationFork,
        }),
        ...createChatComposerContextProps({
          isDragActive,
          editingTurnId: submission.orchestration.editingTurnId,
          planningMode: surfaceRuntime.planningMode,
          draft,
          composerPaletteGlobalOpen,
          composerPaletteQuery,
          blockHistoricalMutation: surfaceRuntime.blockHistoricalMutation,
          setComposerPaletteGlobalOpen,
          setComposerPaletteQuery,
          handleComposerPaletteSelect: actions.handleComposerPaletteSelect,
          pendingAttachments,
          pendingAttachmentModes,
          externalSourceAttachments: session.externalSourceAttachments,
          historicalModeActive: surfaceRuntime.historicalModeActive,
          delegatedScopeControls: surfaceRuntime.runPresentation.delegatedScopeControls,
          selectedPresetId: presetCatalog.selectedPresetId,
          presetApplyWarning,
          capabilityProfileInspection: surfaceRuntime.capabilityProfileInspection,
          selectedSessionId: selection.selectedSessionId,
          currentRoutePreflight: submission.currentRoutePreflight,
          routePreflight: submission.routePreflight,
          routeBoundaryAckRequired: surfaceRuntime.routeBoundaryAckRequired,
          currentRouteBoundaryAcknowledged: submission.currentRouteBoundaryAcknowledged,
          sending,
          canSend: surfaceRuntime.canSend,
          profileDependentAdmissionBlockReason: surfaceRuntime.profileDependentAdmissionBlockReason,
          chatSessionRailPresentation,
          surfaceState: surfaceRuntime.surfaceState,
          providerRouting: submission.providerRouting,
          sessionData: session.sessionData,
          contextActions: execution.contextActions,
          palette: submission.palette,
          oneShotContext,
        }),
        ...createChatComposerActionProps({
          audioInputRef: composer.multimodal.audioInputRef,
          blockHistoricalMutation: surfaceRuntime.blockHistoricalMutation,
          handleDismissError: composer.handleDismissError,
          failedAutoImageRecovery: errorState.failedAutoImageRecovery,
          selectedSessionId: selection.selectedSessionId,
          draft,
          handleSendRetainedPromptAsChat: composer.sendIntent.handleSendRetainedPromptAsChat,
          acknowledgeCurrentRouteBoundary: submission.acknowledgeCurrentRouteBoundary,
          requestThreadModelPatch: actions.modelPlans.requestThreadModelPatch,
          handlePrefPatch: actions.preferenceActions.handlePrefPatch,
          handleRevealSelectedTurnDetails: composer.turnNavigation.handleRevealSelectedTurnDetails,
          setDraft,
          setSelectedPresetId: presetCatalog.setSelectedPresetId,
          handleApplyPreset: actions.presetActions.handleApplyPreset,
          setPresetApplyWarning,
          handleRemoveThreadKnowledge: actions.knowledgeRemoval.handleRemoveThreadKnowledge,
          knowledgeUrlDraft,
          knowledgeUrlMode,
          setKnowledgeUrlDraft,
          setKnowledgeUrlMode,
          handleRunQuickResearch: execution.contextActions.handleRunQuickResearch,
          composerInteractions: composer.composerInteractions,
          orchestration: submission.orchestration,
          knowledgeActions: actions.knowledgeActions,
          externalControl: session.externalControl,
          coordination,
          planningPreferences: actions.planningPreferences,
          oneShotContext,
        }),
        ...createChatMediaProps({
          selectedSessionId: selection.selectedSessionId,
          sending,
          historicalModeActive: surfaceRuntime.historicalModeActive,
          blockHistoricalMutation: surfaceRuntime.blockHistoricalMutation,
          loadModelsForProvider: providerCatalog.loadModelsForProvider,
          handlePrefPatch: actions.preferenceActions.handlePrefPatch,
          multimodal: composer.multimodal,
        }),
        ...createChatRunControlProps({
          activeGeneratedArtifact,
          handleCloseGeneratedArtifact: actions.artifactActions.handleCloseGeneratedArtifact,
          handleComposerSend: submission.handleComposerSend,
          messageMode: surfaceRuntime.surfaceState.messageMode,
          historicalModeActive: surfaceRuntime.historicalModeActive,
          blockHistoricalMutation: surfaceRuntime.blockHistoricalMutation,
          handleAgenticControl: surfaceRuntime.handleAgenticControl,
          agenticControlPending,
          pinnedGoal,
          activeStreamRef: coordination.activeStreamRef,
          draft,
          surfacePreview,
          autoRouteActive,
          orchestration: submission.orchestration,
          runPresentation: surfaceRuntime.runPresentation,
          goalActions: composer.goalActions,
        }),
      }
    : null;

  return { activeSessionSurfaceProps };
}
