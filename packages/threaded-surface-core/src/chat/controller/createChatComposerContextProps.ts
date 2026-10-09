import type { ChatAttachmentRecord } from "@goatcitadel/contracts";
import { type ComposerPaletteItem } from "../composer-palette";
import { type PendingAttachmentDocumentMode } from "../mission-threaded-controller-helpers";
import type { MissionControlActiveSessionSurfaceProps } from "../MissionControlActiveSessionSurface";
import { useChatCapabilityProfileInspection } from "../useChatCapabilityProfileInspection";
import { useChatComposerPaletteActions } from "../useChatComposerPaletteActions";
import type { useChatContextActions } from "../useChatContextActions";
import type { useChatProviderRoutingController } from "../useChatProviderRoutingController";
import { useChatRoutePreflight } from "../useChatRoutePreflight";
import { useChatRunPresentation } from "../useChatRunPresentation";
import type { useChatSessionData } from "../useChatSessionData";
import { useChatSurfaceOrchestration } from "../useChatSurfaceOrchestration";
import { useExternalSourceAttachments } from "../useExternalSourceAttachments";
import type { useMissionControlSurfaceState } from "../useMissionControlSurfaceState";
import type { useChatOneShotContext } from "./useChatOneShotContext";
import type { useChatPaletteAndQueuePreferences } from "./useChatPaletteAndQueuePreferences";
import type { useChatSessionRailPresentation } from "./useChatSessionRailPresentation";

type Input = {
  isDragActive: boolean;
  editingTurnId: ReturnType<typeof useChatSurfaceOrchestration>["editingTurnId"];
  planningMode: import("@goatcitadel/contracts").ChatPlanningMode;
  draft: string;
  composerPaletteGlobalOpen: boolean;
  composerPaletteQuery: string;
  blockHistoricalMutation: () => boolean;
  setComposerPaletteGlobalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setComposerPaletteQuery: React.Dispatch<React.SetStateAction<string>>;
  handleComposerPaletteSelect: ReturnType<typeof useChatComposerPaletteActions>["handleComposerPaletteSelect"];
  pendingAttachments: ChatAttachmentRecord[];
  pendingAttachmentModes: Record<string, PendingAttachmentDocumentMode>;
  externalSourceAttachments: ReturnType<typeof useExternalSourceAttachments>;
  historicalModeActive: boolean;
  delegatedScopeControls: ReturnType<typeof useChatRunPresentation>["delegatedScopeControls"];
  selectedPresetId: string;
  presetApplyWarning: string | null;
  capabilityProfileInspection: ReturnType<typeof useChatCapabilityProfileInspection>;
  selectedSessionId: string | null;
  currentRoutePreflight: import("@goatcitadel/contracts").RoutingPreflightResult | null;
  routePreflight: ReturnType<typeof useChatRoutePreflight>;
  routeBoundaryAckRequired: boolean;
  currentRouteBoundaryAcknowledged: boolean;
  sending: boolean;
  canSend: boolean;
  profileDependentAdmissionBlockReason:
    | "Model council is temporarily unavailable. Turn Council off to send."
    | "Workspace snapshots are temporarily unavailable. Remove the snapshot to send."
    | "Routed external sources are temporarily unavailable. Clear the source selection to send."
    | "Routed documents are temporarily unavailable. Remove the document selection to send."
    | undefined;
  chatSessionRailPresentation: Pick<ReturnType<typeof useChatSessionRailPresentation>, "queueItems" | "presetOptions">;
  surfaceState: Pick<
    ReturnType<typeof useMissionControlSurfaceState>,
    "effectiveToolAutonomy" | "selectedTurnRecovery" | "selectedTurn"
  >;
  providerRouting: Pick<ReturnType<typeof useChatProviderRoutingController>, "commandIndex" | "setCommandIndex">;
  sessionData: Pick<ReturnType<typeof useChatSessionData>, "threadKnowledgeAttachments" | "prefs">;
  contextActions: Pick<
    ReturnType<typeof useChatContextActions>,
    "continueActiveExplorerInBackground" | "rehydrateBackgroundExplorerReport"
  >;
  palette: Pick<
    ReturnType<typeof useChatPaletteAndQueuePreferences>,
    "effectiveCommandSuggestions" | "composerPaletteEnabled" | "composerPalette"
  >;
  oneShotContext: Pick<
    ReturnType<typeof useChatOneShotContext>,
    "modelCouncilEnabled" | "workspaceSnapshotRequest" | "fullWebAccess"
  >;
};

/** Builds composer context and admission evidence without creating execution authority. */
export function createChatComposerContextProps({
  isDragActive,
  editingTurnId,
  planningMode,
  draft,
  composerPaletteGlobalOpen,
  composerPaletteQuery,
  blockHistoricalMutation,
  setComposerPaletteGlobalOpen,
  setComposerPaletteQuery,
  handleComposerPaletteSelect,
  pendingAttachments,
  pendingAttachmentModes,
  externalSourceAttachments,
  historicalModeActive,
  delegatedScopeControls,
  selectedPresetId,
  presetApplyWarning,
  capabilityProfileInspection,
  selectedSessionId,
  currentRoutePreflight,
  routePreflight,
  routeBoundaryAckRequired,
  currentRouteBoundaryAcknowledged,
  sending,
  canSend,
  profileDependentAdmissionBlockReason,
  chatSessionRailPresentation,
  surfaceState,
  providerRouting,
  sessionData,
  contextActions,
  palette,
  oneShotContext,
}: Input): Pick<
  MissionControlActiveSessionSurfaceProps,
  | "isDragActive"
  | "queueItems"
  | "editingTurnId"
  | "planningMode"
  | "effectiveToolAutonomy"
  | "draft"
  | "commandSuggestions"
  | "commandIndex"
  | "composerPalette"
  | "pendingAttachments"
  | "pendingAttachmentModes"
  | "threadKnowledgeAttachments"
  | "externalSourceControls"
  | "delegatedScopeControls"
  | "onContinueExplorerInBackground"
  | "onBackgroundExplorerSettled"
  | "presetOptions"
  | "selectedPresetId"
  | "presetApplyWarning"
  | "selectedTurnRecovery"
  | "selectedTurn"
  | "capabilityProfileInspection"
  | "selectedSessionId"
  | "currentWebMode"
  | "currentReviewDepth"
  | "modelCouncilEnabled"
  | "workspaceSnapshotRequest"
  | "fullWebAccess"
  | "currentThinkingLevel"
  | "currentSpeedMode"
  | "currentSubagentPolicy"
  | "routePreflight"
  | "routePreflightLoading"
  | "routePreflightError"
  | "onWorkPassportBaselineChanged"
  | "routeBoundaryAckRequired"
  | "routeBoundaryAcknowledged"
  | "sending"
  | "canSend"
  | "profileDependentAdmissionBlockReason"
> {
  const { setCommandIndex } = providerRouting;
  const { toggleSelection } = externalSourceAttachments;
  const { attach } = externalSourceAttachments;
  const { reload } = externalSourceAttachments;
  const { detach } = externalSourceAttachments;
  const { requestKnowledgeSnapshot } = externalSourceAttachments;
  const { ensureFreshPreflight } = routePreflight;

  return {
    isDragActive,
    queueItems: chatSessionRailPresentation.queueItems,
    editingTurnId,
    planningMode: planningMode === "advisory" ? "advisory" : "off",
    effectiveToolAutonomy: surfaceState.effectiveToolAutonomy,
    draft,
    commandSuggestions: palette.effectiveCommandSuggestions,
    commandIndex: providerRouting.commandIndex,
    composerPalette: palette.composerPaletteEnabled
      ? {
          enabled: true,
          globalOpen: composerPaletteGlobalOpen,
          query: composerPaletteQuery,
          loading: palette.composerPalette.loading,
          failures: palette.composerPalette.failures,
          onOpen: () => {
            if (!blockHistoricalMutation()) setComposerPaletteGlobalOpen(true);
          },
          onClose: () => {
            setComposerPaletteGlobalOpen(false);
            setComposerPaletteQuery("");
            setCommandIndex(0);
          },
          onQueryChange: setComposerPaletteQuery,
          onIndexChange: setCommandIndex,
          onSelect: (item) => {
            if (!blockHistoricalMutation()) void handleComposerPaletteSelect(item as ComposerPaletteItem);
          },
        }
      : undefined,
    pendingAttachments,
    pendingAttachmentModes,
    threadKnowledgeAttachments: sessionData.threadKnowledgeAttachments?.items ?? [],
    externalSourceControls:
      externalSourceAttachments.supported === true
        ? {
            attachments: externalSourceAttachments.attachments,
            candidates: externalSourceAttachments.candidates,
            candidatesSupported: externalSourceAttachments.candidatesSupported,
            loading: externalSourceAttachments.loading,
            selectedAttachmentIds: externalSourceAttachments.selectedAttachmentIds,
            busyAttachmentId: externalSourceAttachments.busyAttachmentId,
            canMutate: externalSourceAttachments.canMutate && !historicalModeActive,
            error: externalSourceAttachments.error,
            onToggleSelect: (attachmentId) => {
              if (!blockHistoricalMutation() && externalSourceAttachments.selectedAttachmentIds.includes(attachmentId)) {
                // New turns use live capabilities; only clearing retained intent is available.
                toggleSelection(attachmentId);
              }
            },
            onClearSelection: externalSourceAttachments.clearSelection,
            onAttach: (seed) => {
              if (!blockHistoricalMutation()) void attach(seed);
            },
            onReload: () => {
              if (!blockHistoricalMutation()) void reload();
            },
            onDetach: (attachmentId) => {
              if (!blockHistoricalMutation()) void detach(attachmentId);
            },
            onRequestKnowledgeSnapshot: (attachmentId) => {
              if (!blockHistoricalMutation()) void requestKnowledgeSnapshot(attachmentId);
            },
          }
        : null,
    delegatedScopeControls: historicalModeActive ? null : delegatedScopeControls,
    onContinueExplorerInBackground: contextActions.continueActiveExplorerInBackground,
    onBackgroundExplorerSettled: contextActions.rehydrateBackgroundExplorerReport,
    presetOptions: chatSessionRailPresentation.presetOptions,
    selectedPresetId,
    presetApplyWarning,
    selectedTurnRecovery: surfaceState.selectedTurnRecovery,
    selectedTurn: surfaceState.selectedTurn,
    capabilityProfileInspection,
    selectedSessionId,
    currentWebMode: sessionData.prefs?.webMode ?? "auto",
    currentReviewDepth: sessionData.prefs?.orchestrationReviewDepth ?? "off",
    modelCouncilEnabled: oneShotContext.modelCouncilEnabled,
    workspaceSnapshotRequest: oneShotContext.workspaceSnapshotRequest,
    fullWebAccess: oneShotContext.fullWebAccess,
    currentThinkingLevel: sessionData.prefs?.thinkingLevel ?? "standard",
    currentSpeedMode: sessionData.prefs?.speedMode ?? "standard",
    currentSubagentPolicy: sessionData.prefs?.subagentPolicy ?? "ask_when_useful",
    routePreflight: currentRoutePreflight,
    routePreflightLoading: routePreflight.loading,
    routePreflightError: routePreflight.error,
    onWorkPassportBaselineChanged: async () => {
      await ensureFreshPreflight({
        action: editingTurnId ? "edit" : "send",
        turnId: editingTurnId,
        content: draft,
        force: true,
      });
    },
    routeBoundaryAckRequired,
    routeBoundaryAcknowledged: currentRouteBoundaryAcknowledged,
    sending,
    canSend,
    profileDependentAdmissionBlockReason,
  };
}
