import type {
  ChatAttachmentRecord,
  ChatGeneratedArtifactRecord,
  ThreadKnowledgeRetrievalMode,
} from "@goatcitadel/contracts";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";
import { type PendingAttachmentDocumentMode } from "../mission-threaded-controller-helpers";
import { useChatChangePlanConfirmations } from "../useChatChangePlanConfirmations";
import { useChatChangePlanOAuth } from "../useChatChangePlanOAuth";
import { useChatChangePlanOwnerActions } from "../useChatChangePlanOwnerActions";
import { useChatChangePlanState } from "../useChatChangePlanState";
import { useChatComposerPaletteActions } from "../useChatComposerPaletteActions";
import { useChatExportActions } from "../useChatExportActions";
import { useChatGeneratedArtifactActions } from "../useChatGeneratedArtifactActions";
import { useChatKnowledgeAttachments } from "../useChatKnowledgeAttachments";
import { useChatModelChangePlans } from "../useChatModelChangePlans";
import { useChatPreferenceMutations } from "../useChatPreferenceMutations";
import { useChatPresetActions } from "../useChatPresetActions";
import type { OutboundContextBlock } from "../useChatSurfaceOrchestration";
import { useChatCodeCapabilityLaunch } from "./useChatCodeCapabilityLaunch";
import { useChatControllerCoordination } from "./useChatControllerCoordination";
import { useChatConversationFork } from "./useChatConversationFork";
import { useChatKnowledgeRemoval } from "./useChatKnowledgeRemoval";
import { useChatMetadataDraftState } from "./useChatMetadataDraftState";
import { useChatNoticesAndPresetRefresh } from "./useChatNoticesAndPresetRefresh";
import { useChatOutboundComposition } from "./useChatOutboundComposition";
import { useChatPlanningPreferences } from "./useChatPlanningPreferences";
import { useChatPresetCatalogState } from "./useChatPresetCatalogState";
import { useChatScopedErrors } from "./useChatScopedErrors";
import { useChatSessionComposition } from "./useChatSessionComposition";
import { useChatSessionSelection } from "./useChatSessionSelection";
import { useChatSubmissionComposition } from "./useChatSubmissionComposition";
import { useChatSurfaceComposition } from "./useChatSurfaceComposition";
import { useChatSurfaceNavigation } from "./useChatSurfaceNavigation";

type Input = {
  session: Pick<
    ReturnType<typeof useChatSessionComposition>,
    | "documentContext"
    | "routeArtifactId"
    | "sessionData"
    | "loadSessionCoreState"
    | "threadController"
    | "refreshChatSessionAggregate"
    | "sessionControls"
    | "runVariables"
  >;
  workspaceId: NonNullable<MissionThreadedControllerHostProps["workspaceId"]>;
  activeGeneratedArtifact: ChatGeneratedArtifactRecord | null;
  compactSurfaceLayout: ReturnType<typeof useMediaQuery>;
  surfaceRuntime: Pick<
    ReturnType<typeof useChatSurfaceComposition>,
    "surfaceState" | "setDockOpen" | "workbenchController" | "planningMode"
  >;
  selection: ReturnType<typeof useChatSessionSelection>;
  selectedTurnId: string | null;
  setSessionRailOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveGeneratedArtifact: React.Dispatch<React.SetStateAction<ChatGeneratedArtifactRecord | null>>;
  setSelectedTurnId: React.Dispatch<React.SetStateAction<string | null>>;
  changePlanState: Pick<
    ReturnType<typeof useChatChangePlanState>,
    | "setActivityOpenRequest"
    | "setChatChangePlanSnapshot"
    | "setActiveChangePlan"
    | "setLinkedDefaultChangePlan"
    | "setChangePlanActionError"
    | "setChangePlanActionPending"
    | "activeChangePlan"
    | "changePlanOAuthFlow"
    | "setChangePlanOAuthFlow"
  >;
  navigation: Pick<ReturnType<typeof useChatSurfaceNavigation>, "handleNavigateSurface">;
  setUiError: ReturnType<typeof useChatScopedErrors>["setUiError"];
  pushLocalNotice: ReturnType<typeof useChatNoticesAndPresetRefresh>["pushLocalNotice"];
  notices: ReturnType<typeof useChatNoticesAndPresetRefresh>;
  scopedErrors: ReturnType<typeof useChatScopedErrors>;
  coordination: ReturnType<typeof useChatControllerCoordination>;
  execution: Pick<ReturnType<typeof useChatOutboundComposition>, "outbound">;
  metadataDraft: Pick<
    ReturnType<typeof useChatMetadataDraftState>,
    "preferenceConflictDraft" | "setPreferenceConflictDraft"
  >;
  setSelectedContextTurnIds: React.Dispatch<React.SetStateAction<string[]>>;
  setPendingThreadContext: React.Dispatch<React.SetStateAction<OutboundContextBlock | null>>;
  setForkPending: React.Dispatch<React.SetStateAction<boolean>>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setForkConfirm: React.Dispatch<
    React.SetStateAction<{
      turnId: string;
      turnCount: number;
      attachmentCount: number;
      artifactCount: number;
    } | null>
  >;
  submission: Pick<ReturnType<typeof useChatSubmissionComposition>, "providerRouting">;
  onOpenApprovals: NonNullable<MissionThreadedControllerHostProps["onOpenApprovals"]>;
  pendingAttachments: ChatAttachmentRecord[];
  pendingAttachmentModes: Record<string, PendingAttachmentDocumentMode>;
  setPendingAttachmentModes: React.Dispatch<React.SetStateAction<Record<string, PendingAttachmentDocumentMode>>>;
  knowledgeUrlDraft: string;
  knowledgeUrlMode: ThreadKnowledgeRetrievalMode;
  setKnowledgeUrlDraft: React.Dispatch<React.SetStateAction<string>>;
  presetCatalog: Pick<
    ReturnType<typeof useChatPresetCatalogState>,
    "presetProfiles" | "selectedPresetId" | "setSelectedPresetId"
  >;
  setPresetApplyWarning: React.Dispatch<React.SetStateAction<string | null>>;
  setPendingAttachments: React.Dispatch<React.SetStateAction<ChatAttachmentRecord[]>>;
  setComposerPaletteGlobalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setComposerPaletteQuery: React.Dispatch<React.SetStateAction<string>>;
};

/** Composes existing artifact, preference, fork, change-plan and knowledge action owners in order. */
export function useChatGovernedActionComposition({
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
}: Input) {
  const artifactActions = useChatGeneratedArtifactActions({
    documentOwner: session.documentContext.documentOwner,
    routeArtifactId: session.routeArtifactId,
    workspaceId,
    activeGeneratedArtifact,
    compactSurfaceLayout,
    messageMode: surfaceRuntime.surfaceState.messageMode,
    selectedSessionId: selection.selectedSessionId,
    selectedTurnId,
    thread: session.sessionData.thread,
    loadSessionCoreState: session.loadSessionCoreState,
    setSessionRailOpen,
    setDockOpen: surfaceRuntime.setDockOpen,
    setActiveGeneratedArtifact,
    setSelectedTurnId,
    setGeneratedArtifacts: session.sessionData.setGeneratedArtifacts,
    setActivityOpenRequest: changePlanState.setActivityOpenRequest,
    handleNavigateSurface: navigation.handleNavigateSurface,
    setUiError: setUiError,
    pushLocalNotice: pushLocalNotice,
  });
  const knowledgeRemoval = useChatKnowledgeRemoval({ selection, sessionData: session.sessionData, notices });
  const exportActions = useChatExportActions({
    selectedSession: session.threadController.selectedSession,
    messageMode: surfaceRuntime.surfaceState.messageMode,
    prefs: session.sessionData.prefs,
    binding: session.sessionData.binding,
    thread: session.sessionData.thread,
    selectedTurn: surfaceRuntime.surfaceState.selectedTurn,
    setUiError: setUiError,
    pushLocalNotice: pushLocalNotice,
  });
  const codeLaunch = useChatCodeCapabilityLaunch({
    selection,
    notices,
    surfaceState: surfaceRuntime.surfaceState,
    workbenchController: surfaceRuntime.workbenchController,
    scopedErrors,
  });
  const preferenceActions = useChatPreferenceMutations({
    lastLocalPrefMutationAtRef: coordination.lastLocalPrefMutationAtRef,
    prefMutationSequenceRef: coordination.prefMutationSequenceRef,
    prefsRef: execution.outbound.prefsRef,
    selectedSession: session.threadController.selectedSession,
    setPrefs: session.sessionData.setPrefs,
    preferenceConflictDraft: metadataDraft.preferenceConflictDraft,
    setPreferenceConflictDraft: metadataDraft.setPreferenceConflictDraft,
    refreshChatSessionAggregate: session.refreshChatSessionAggregate,
    setUiError: setUiError,
  });
  const conversationFork = useChatConversationFork({
    workspaceId,
    setSelectedContextTurnIds,
    setPendingThreadContext,
    selection,
    sessionData: session.sessionData,
    threadController: session.threadController,
    scopedErrors,
    setForkPending,
    setSelectedTurnId,
    setDraft,
    notices,
    coordination,
    setForkConfirm,
  });
  const planningPreferences = useChatPlanningPreferences({
    preferenceActions,
    planningMode: surfaceRuntime.planningMode,
    sessionData: session.sessionData,
  });
  const modelPlans = useChatModelChangePlans({
    workspaceId,
    selectedSession: session.threadController.selectedSession,
    prefs: session.sessionData.prefs,
    selectedProviderId: submission.providerRouting.selectedProviderId,
    selectedModel: submission.providerRouting.selectedModel,
    setUiError: setUiError,
    pushLocalNotice: pushLocalNotice,
    setChatChangePlanSnapshot: changePlanState.setChatChangePlanSnapshot,
    setActiveChangePlan: changePlanState.setActiveChangePlan,
    setLinkedDefaultChangePlan: changePlanState.setLinkedDefaultChangePlan,
    setChangePlanActionError: changePlanState.setChangePlanActionError,
  });
  const { recordChangePlanResult } = modelPlans;

  const planConfirmations = useChatChangePlanConfirmations({
    workspaceId,
    prefsRef: execution.outbound.prefsRef,
    setPrefs: session.sessionData.setPrefs,
    setUiError: setUiError,
    pushLocalNotice: pushLocalNotice,
    recordChangePlanResult: recordChangePlanResult,
    setActiveChangePlan: changePlanState.setActiveChangePlan,
    setLinkedDefaultChangePlan: changePlanState.setLinkedDefaultChangePlan,
    setChangePlanActionError: changePlanState.setChangePlanActionError,
    setChangePlanActionPending: changePlanState.setChangePlanActionPending,
  });
  const planActions = useChatChangePlanOwnerActions({
    workspaceId,
    recordChangePlanResult: recordChangePlanResult,
    onOpenApprovals,
    setActiveChangePlan: changePlanState.setActiveChangePlan,
    setChangePlanActionError: changePlanState.setChangePlanActionError,
    setChangePlanActionPending: changePlanState.setChangePlanActionPending,
  });
  const planOAuth = useChatChangePlanOAuth({
    workspaceId,
    activeChangePlan: changePlanState.activeChangePlan,
    changePlanOAuthFlow: changePlanState.changePlanOAuthFlow,
    recordChangePlanResult: recordChangePlanResult,
    setChangePlanOAuthFlow: changePlanState.setChangePlanOAuthFlow,
    setChangePlanActionError: changePlanState.setChangePlanActionError,
    setChangePlanActionPending: changePlanState.setChangePlanActionPending,
  });
  const knowledgeActions = useChatKnowledgeAttachments({
    pendingAttachments,
    pendingAttachmentModes,
    setPendingAttachmentModes,
    knowledgeUrlDraft,
    knowledgeUrlMode,
    setKnowledgeUrlDraft,
    ensureSession: session.sessionControls.ensureSession,
    threadKnowledgeAttachments: session.sessionData.threadKnowledgeAttachments,
    setThreadKnowledgeAttachments: session.sessionData.setThreadKnowledgeAttachments,
    pushLocalNotice: pushLocalNotice,
    setUiError: setUiError,
  });
  const presetActions = useChatPresetActions({
    presetProfiles: presetCatalog.presetProfiles,
    selectedPresetId: presetCatalog.selectedPresetId,
    ensureSession: session.sessionControls.ensureSession,
    requestThreadModelPatch: modelPlans.requestThreadModelPatch,
    applyPrefPatchToSession: preferenceActions.applyPrefPatchToSession,
    setDraft,
    threadKnowledgeAttachments: session.sessionData.threadKnowledgeAttachments,
    setPresetApplyWarning,
    messageMode: surfaceRuntime.surfaceState.messageMode,
    handleNavigateSurface: navigation.handleNavigateSurface,
    pushLocalNotice: pushLocalNotice,
    setUiError: setUiError,
  });
  const paletteActions = useChatComposerPaletteActions({
    workspaceId,
    ensureSession: session.sessionControls.ensureSession,
    setPendingAttachments,
    pushLocalNotice: pushLocalNotice,
    setComposerPaletteGlobalOpen,
    setComposerPaletteQuery,
    setDraft,
    requestThreadModelPatch: modelPlans.requestThreadModelPatch,
    setSelectedPresetId: presetCatalog.setSelectedPresetId,
    handleApplyPresetById: presetActions.handleApplyPresetById,
    handleAssignProject: session.sessionControls.handleAssignProject,
    handleAttachKnowledgeUrlValue: knowledgeActions.handleAttachKnowledgeUrlValue,
    openRunVariableForm: session.runVariables.openForm,
    setUiError: setUiError,
  });
  const { handleComposerPaletteSelect } = paletteActions;

  return {
    preferenceActions,
    planningPreferences,
    handleComposerPaletteSelect,
    knowledgeActions,
    modelPlans,
    exportActions,
    artifactActions,
    conversationFork,
    presetActions,
    knowledgeRemoval,
    codeLaunch,
    recordChangePlanResult,
    planConfirmations,
    planActions,
    planOAuth,
  };
}
