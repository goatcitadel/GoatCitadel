import type { ChatGeneratedArtifactRecord, ChatModePresetRecord } from "@goatcitadel/contracts";
import type { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import type { MissionThreadedRenderSurfaceInput } from "../../MissionThreadedControllerHost.types";
import { resolveProviderModelSelection } from "../chat-page-helpers";
import { useChatCapabilityProfileInspection } from "../useChatCapabilityProfileInspection";
import type { useChatContextActions } from "../useChatContextActions";
import type { useChatDockWorkbenchController } from "../useChatDockWorkbenchController";
import { useChatDocuments } from "../useChatDocuments";
import type { useChatExportActions } from "../useChatExportActions";
import { useChatGeneratedArtifactActions } from "../useChatGeneratedArtifactActions";
import { useChatModelChangePlans } from "../useChatModelChangePlans";
import type { useChatPreferenceMutations } from "../useChatPreferenceMutations";
import type { useChatProviderRoutingController } from "../useChatProviderRoutingController";
import type { useChatRunPresentation } from "../useChatRunPresentation";
import type { useChatSessionControls } from "../useChatSessionControls";
import type { useChatSessionData } from "../useChatSessionData";
import type { useChatThreadController } from "../useChatThreadController";
import type { useMissionControlSurfaceState } from "../useMissionControlSurfaceState";
import { formatSessionLabel } from "../useMissionControlSurfaceState";
import type { useChatMetadataDraftActions } from "./useChatMetadataDraftActions";
import type { useChatMetadataDraftState } from "./useChatMetadataDraftState";
import { useChatSessionRailPresentation } from "./useChatSessionRailPresentation";
import type { useChatStreamPreferences } from "./useChatStreamPreferences";

type Input = {
  planningMode: import("@goatcitadel/contracts").ChatPlanningMode;
  sending: boolean;
  blockHistoricalMutation: () => boolean;
  selectedSessionId: string | null;
  capabilityProfileInspection: ReturnType<typeof useChatCapabilityProfileInspection>;
  activeGeneratedArtifact: ChatGeneratedArtifactRecord | null;
  documents: ReturnType<typeof useChatDocuments>["documents"];
  currentRoutePreflight: import("@goatcitadel/contracts").RoutingPreflightResult | null;
  proactiveSuggestionCount: number;
  chatSessionRailPresentation: ReturnType<typeof useChatSessionRailPresentation>;
  automaticFanout:
    | { enabled: boolean; unavailableReason: string; projectId?: undefined; grant?: undefined }
    | { enabled: boolean; projectId: string; unavailableReason: string; grant?: undefined }
    | {
        enabled: boolean;
        projectId: string;
        grant: import("@goatcitadel/contracts").AutonomousActivationGrantRecord;
        unavailableReason: string;
      }
    | {
        enabled: boolean;
        projectId: string;
        grant: import("@goatcitadel/contracts").AutonomousActivationGrantRecord;
        unavailableReason?: undefined;
      };
  requestThreadModelPatch: ReturnType<typeof useChatModelChangePlans>["requestThreadModelPatch"];
  pushLocalNotice: (content: string, tone?: "warning" | "critical" | "success" | "neutral") => void;
  handleCloseGeneratedArtifact: ReturnType<typeof useChatGeneratedArtifactActions>["handleCloseGeneratedArtifact"];
  renameTitle: string;
  threadController: Pick<ReturnType<typeof useChatThreadController>, "selectedSession" | "selectedProject">;
  surfaceState: Pick<
    ReturnType<typeof useMissionControlSurfaceState>,
    | "messageMode"
    | "isChatSurface"
    | "isCoworkSurface"
    | "isCodeSurface"
    | "activeModePreset"
    | "effectiveToolAutonomy"
    | "codeModeNeedsProjectBinding"
    | "selectedProjectBindingCandidateId"
    | "selectedProjectBindingCandidateName"
    | "showTracePanel"
    | "selectedTurn"
    | "showSuggestionsPanel"
    | "showLearnedMemoryPanel"
  >;
  workbenchController: Pick<
    ReturnType<typeof useChatDockWorkbenchController>,
    "dockOpen" | "dockSectionStyle" | "latestOrchestration" | "coworkItems" | "selectedSessionProjectValue"
  >;
  sessionControls: Pick<
    ReturnType<typeof useChatSessionControls>,
    | "sessionControlPending"
    | "integrationConnectionId"
    | "integrationTarget"
    | "handleRenameSession"
    | "handleSaveOrganization"
    | "handleTogglePinSession"
    | "handleToggleArchiveSession"
    | "handleDeleteSession"
    | "handleAssignProject"
    | "setIntegrationConnectionId"
    | "setIntegrationTarget"
    | "handleSaveExternalBinding"
  >;
  providerRouting: Pick<
    ReturnType<typeof useChatProviderRoutingController>,
    "providerOptions" | "selectedProviderId" | "selectedModel"
  >;
  providerCatalog: Pick<
    ReturnType<typeof useProviderModelCatalog>,
    "providers" | "loadModelsForProvider" | "getCachedModels"
  >;
  sessionData: Pick<
    ReturnType<typeof useChatSessionData>,
    | "prefs"
    | "proactiveStatus"
    | "proactiveRuns"
    | "specialistCandidates"
    | "learnedMemory"
    | "secondaryLoading"
    | "binding"
  >;
  preferenceActions: Pick<
    ReturnType<typeof useChatPreferenceMutations>,
    "handleRetryPreferenceDraft" | "handleDiscardPreferenceDraft" | "handlePrefPatch"
  >;
  runPresentation: Pick<
    ReturnType<typeof useChatRunPresentation>,
    "sessionTrust" | "providerLabelById" | "coworkViewModel"
  >;
  contextActions: Pick<
    ReturnType<typeof useChatContextActions>,
    | "proactivePolicyDraft"
    | "proactivePolicyConflict"
    | "capabilitySuggestions"
    | "specialistSuggestions"
    | "delegationSuggestion"
    | "handleTriggerProactive"
    | "handleProactivePolicyPatch"
    | "handleCapabilitySuggestionAction"
    | "handleCreateSpecialistDraft"
    | "handleActivateCatalogSpecialist"
    | "handleSpecialistCandidatePatch"
    | "handleRebuildLearnedMemory"
    | "handleMemoryStatusUpdate"
  >;
  exportActions: Pick<ReturnType<typeof useChatExportActions>, "handleExportSessionSnapshot" | "handleExportRunBundle">;
  streamPreferences: Pick<
    ReturnType<typeof useChatStreamPreferences>,
    "streamEnabled" | "visualStreamMode" | "setStreamEnabled" | "setVisualStreamMode"
  >;
  metadataDraft: Pick<
    ReturnType<typeof useChatMetadataDraftState>,
    "preferenceConflictDraft" | "folderName" | "tagsValue"
  >;
  metadataActions: Pick<
    ReturnType<typeof useChatMetadataDraftActions>,
    "handleRenameTitleChange" | "handleFolderNameChange" | "handleTagsValueChange"
  >;
};

/** Builds the progressive context dock from the existing runtime owners. */
export function createChatContextDockProps({
  planningMode,
  sending,
  blockHistoricalMutation,
  selectedSessionId,
  capabilityProfileInspection,
  activeGeneratedArtifact,
  documents,
  currentRoutePreflight,
  proactiveSuggestionCount,
  chatSessionRailPresentation,
  automaticFanout,
  requestThreadModelPatch,
  pushLocalNotice,
  handleCloseGeneratedArtifact,
  renameTitle,
  threadController,
  surfaceState,
  workbenchController,
  sessionControls,
  providerRouting,
  providerCatalog,
  sessionData,
  preferenceActions,
  runPresentation,
  contextActions,
  exportActions,
  streamPreferences,
  metadataDraft,
  metadataActions,
}: Input): Pick<MissionThreadedRenderSurfaceInput, "contextDockProps"> {
  const { selectedSession } = threadController;
  const { setStreamEnabled } = streamPreferences;
  const { setVisualStreamMode } = streamPreferences;
  const { handleRetryPreferenceDraft } = preferenceActions;
  const { handlePrefPatch } = preferenceActions;
  const { handleTriggerProactive } = contextActions;
  const { handleProactivePolicyPatch } = contextActions;
  const { handleCapabilitySuggestionAction } = contextActions;
  const { handleCreateSpecialistDraft } = contextActions;
  const { handleActivateCatalogSpecialist } = contextActions;
  const { handleSpecialistCandidatePatch } = contextActions;
  const { handleRebuildLearnedMemory } = contextActions;
  const { handleMemoryStatusUpdate } = contextActions;
  const { handleRenameTitleChange } = metadataActions;
  const { handleFolderNameChange } = metadataActions;
  const { handleTagsValueChange } = metadataActions;
  const { handleRenameSession } = sessionControls;
  const { handleSaveOrganization } = sessionControls;
  const { handleTogglePinSession } = sessionControls;
  const { handleToggleArchiveSession } = sessionControls;
  const { handleDeleteSession } = sessionControls;
  const { handleAssignProject } = sessionControls;
  const { setIntegrationConnectionId } = sessionControls;
  const { setIntegrationTarget } = sessionControls;
  const { handleSaveExternalBinding } = sessionControls;

  return {
    contextDockProps: selectedSession
      ? {
          mode: surfaceState.messageMode,
          dockOpen: workbenchController.dockOpen,
          dockSectionStyle: workbenchController.dockSectionStyle,
          isChatSurface: surfaceState.isChatSurface,
          isCoworkSurface: surfaceState.isCoworkSurface,
          isCodeSurface: surfaceState.isCodeSurface,
          activeModePreset: surfaceState.activeModePreset as ChatModePresetRecord,
          planningMode,
          effectiveToolAutonomy: surfaceState.effectiveToolAutonomy,
          codeModeNeedsProjectBinding: surfaceState.codeModeNeedsProjectBinding,
          selectedSession: selectedSession,
          selectedProject: threadController.selectedProject,
          selectedProjectBindingCandidateId: surfaceState.selectedProjectBindingCandidateId,
          selectedProjectBindingCandidateName: surfaceState.selectedProjectBindingCandidateName,
          sending,
          sessionControlPending: sessionControls.sessionControlPending,
          providerOptions: providerRouting.providerOptions,
          selectedProviderId: providerRouting.selectedProviderId,
          selectedModel: providerRouting.selectedModel,
          selectedModelReasoningEfforts: providerCatalog.providers.find(
            (provider) => provider.providerId === providerRouting.selectedProviderId,
          )?.reasoningEffortsByModel?.[
            providerRouting.selectedModel?.replace(`${providerRouting.selectedProviderId}/`, "") ?? ""
          ],
          selectedModelFastAvailable: providerCatalog.providers.find(
            (provider) => provider.providerId === providerRouting.selectedProviderId,
          )?.fastModeByModel?.[
            providerRouting.selectedModel?.replace(`${providerRouting.selectedProviderId}/`, "") ?? ""
          ],
          streamEnabled: streamPreferences.streamEnabled,
          visualStreamMode: streamPreferences.visualStreamMode,
          onStreamEnabledChange: (value) => {
            if (!blockHistoricalMutation()) setStreamEnabled(value);
          },
          onVisualStreamModeChange: (value) => {
            if (!blockHistoricalMutation()) setVisualStreamMode(value);
          },
          prefs: sessionData.prefs,
          preferenceConflictDraft:
            metadataDraft.preferenceConflictDraft?.sessionId === selectedSession.sessionId
              ? metadataDraft.preferenceConflictDraft.patch
              : null,
          onRetryPreferenceConflictDraft: async () => {
            if (!blockHistoricalMutation()) await handleRetryPreferenceDraft();
          },
          onDiscardPreferenceConflictDraft: preferenceActions.handleDiscardPreferenceDraft,
          selectedSessionId,
          showTracePanel: surfaceState.showTracePanel,
          selectedTurn: surfaceState.selectedTurn,
          capabilityProfileInspection,
          activeGeneratedArtifact,
          documents,
          routePreflight: currentRoutePreflight,
          trust: runPresentation.sessionTrust,
          providerLabelById: runPresentation.providerLabelById,
          showSuggestionsPanel: surfaceState.showSuggestionsPanel,
          showLearnedMemoryPanel: surfaceState.showLearnedMemoryPanel,
          latestOrchestration: workbenchController.latestOrchestration,
          coworkItems: workbenchController.coworkItems,
          coworkViewModel: runPresentation.coworkViewModel,
          proactiveStatus: sessionData.proactiveStatus,
          proactivePolicyDraft: contextActions.proactivePolicyDraft,
          proactivePolicyConflict: contextActions.proactivePolicyConflict,
          proactiveRuns: sessionData.proactiveRuns,
          proactiveSuggestionCount,
          capabilitySuggestions: contextActions.capabilitySuggestions,
          specialistSuggestions: contextActions.specialistSuggestions,
          specialistCandidates: sessionData.specialistCandidates,
          delegationSuggestion: contextActions.delegationSuggestion,
          learnedMemory: sessionData.learnedMemory,
          secondaryLoading: sessionData.secondaryLoading,
          binding: sessionData.binding,
          integrationConnectionId: sessionControls.integrationConnectionId,
          integrationTarget: sessionControls.integrationTarget,
          selectedSessionProjectValue: workbenchController.selectedSessionProjectValue,
          projectOptions: chatSessionRailPresentation.projectOptions,
          automaticFanout,
          loadModelsForProvider: providerCatalog.loadModelsForProvider,
          getCachedModels: providerCatalog.getCachedModels,
          resolveProviderModelSelection,
          onPrefPatch: async (patch) => {
            if (blockHistoricalMutation()) return;
            if (patch.providerId !== undefined || patch.model !== undefined || patch.thinkingLevel !== undefined) {
              requestThreadModelPatch(patch);
              return;
            }
            await handlePrefPatch(patch);
          },
          onSuggestDelegation: async () => {
            if (!blockHistoricalMutation())
              pushLocalNotice("Subagent delegation is temporarily unavailable.", "warning");
          },
          onTriggerProactive: async () => {
            if (!blockHistoricalMutation()) await handleTriggerProactive();
          },
          onProactivePolicyPatch: async (patch) => {
            if (!blockHistoricalMutation()) await handleProactivePolicyPatch(patch);
          },
          onRunCodeDelegation: async () => {
            if (!blockHistoricalMutation()) pushLocalNotice("Code delegation is temporarily unavailable.", "warning");
          },
          onCapabilitySuggestionAction: (suggestion) => {
            if (!blockHistoricalMutation()) handleCapabilitySuggestionAction(suggestion);
          },
          onCreateSpecialistDraft: async (suggestion) => {
            if (!blockHistoricalMutation()) await handleCreateSpecialistDraft(suggestion);
          },
          onActivateCatalogSpecialist: async (suggestion) => {
            if (!blockHistoricalMutation()) await handleActivateCatalogSpecialist(suggestion);
          },
          onSpecialistCandidatePatch: async (candidateId, patch, notice) => {
            if (!blockHistoricalMutation()) await handleSpecialistCandidatePatch(candidateId, patch, notice);
          },
          onAcceptDelegation: async () => {
            if (!blockHistoricalMutation())
              pushLocalNotice("Subagent delegation is temporarily unavailable.", "warning");
          },
          onRebuildLearnedMemory: async () => {
            if (!blockHistoricalMutation()) await handleRebuildLearnedMemory();
          },
          onUpdateMemoryStatus: async (itemId, status) => {
            if (!blockHistoricalMutation()) await handleMemoryStatusUpdate(itemId, status);
          },
          onCloseGeneratedArtifact: handleCloseGeneratedArtifact,
          onRenameTitleChange: (value) => {
            if (!blockHistoricalMutation()) handleRenameTitleChange(value);
          },
          renameTitle,
          folderName: metadataDraft.folderName,
          onFolderNameChange: (value) => {
            if (!blockHistoricalMutation()) handleFolderNameChange(value);
          },
          tagsValue: metadataDraft.tagsValue,
          onTagsValueChange: (value) => {
            if (!blockHistoricalMutation()) handleTagsValueChange(value);
          },
          onRenameSession: async () => {
            if (!blockHistoricalMutation()) await handleRenameSession();
          },
          onSaveOrganization: async () => {
            if (!blockHistoricalMutation()) await handleSaveOrganization();
          },
          onTogglePinSession: async () => {
            if (!blockHistoricalMutation()) await handleTogglePinSession();
          },
          onToggleArchiveSession: async () => {
            if (!blockHistoricalMutation()) await handleToggleArchiveSession();
          },
          onDeleteSession: () => {
            if (!blockHistoricalMutation()) handleDeleteSession(formatSessionLabel(selectedSession));
          },
          onAssignProject: async (value) => {
            if (!blockHistoricalMutation()) await handleAssignProject(value);
          },
          onExportSnapshot: exportActions.handleExportSessionSnapshot,
          onExportRunBundle: exportActions.handleExportRunBundle,
          onIntegrationConnectionIdChange: (value) => {
            if (!blockHistoricalMutation()) setIntegrationConnectionId(value);
          },
          onIntegrationTargetChange: (value) => {
            if (!blockHistoricalMutation()) setIntegrationTarget(value);
          },
          onSaveExternalBinding: async () => {
            if (!blockHistoricalMutation()) await handleSaveExternalBinding();
          },
        }
      : null,
  };
}
