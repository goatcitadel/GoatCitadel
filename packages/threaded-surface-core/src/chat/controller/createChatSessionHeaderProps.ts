import type { ChatMode } from "@goatcitadel/contracts";
import type { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";
import type { MissionControlActiveSessionSurfaceProps } from "../MissionControlActiveSessionSurface";
import { resolveProviderModelSelection } from "../chat-page-helpers";
import { useChatDockWorkbenchController } from "../useChatDockWorkbenchController";
import { useChatModelChangePlans } from "../useChatModelChangePlans";
import type { useChatProviderRoutingController } from "../useChatProviderRoutingController";
import { useChatRunPresentation } from "../useChatRunPresentation";
import type { useChatSessionControls } from "../useChatSessionControls";
import { useChatThreadController } from "../useChatThreadController";
import type { useMissionControlSurfaceState } from "../useMissionControlSurfaceState";
import type { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  workspaceSummaryText: string;
  sessionTrust: ReturnType<typeof useChatRunPresentation>["sessionTrust"];
  sending: boolean;
  historicalModeActive: boolean;
  selectedSession: NonNullable<ReturnType<typeof useChatThreadController>["selectedSession"]>;
  dockOpen: ReturnType<typeof useChatDockWorkbenchController>["dockOpen"];
  handleToggleDock: () => void;
  blockHistoricalMutation: () => boolean;
  handleNavigateSurface: (
    nextSurface: import("@goatcitadel/contracts").ChatMode,
    options?:
      | {
          sessionId?: string | null | undefined;
          turnId?: string | null | undefined;
          artifactId?: string | null | undefined;
        }
      | undefined,
  ) => void;
  onResolvedModeChange: MissionThreadedControllerHostProps["onResolvedModeChange"];
  requestThreadModelPatch: ReturnType<typeof useChatModelChangePlans>["requestThreadModelPatch"];
  surfaceState: Pick<ReturnType<typeof useMissionControlSurfaceState>, "messageMode" | "selectedSessionLabel">;
  providerRouting: Pick<
    ReturnType<typeof useChatProviderRoutingController>,
    "providerOptions" | "selectedProviderId" | "selectedModel"
  >;
  sessionControls: Pick<
    ReturnType<typeof useChatSessionControls>,
    "sessionControlPending" | "handleToggleArchiveSession"
  >;
  providerCatalog: Pick<ReturnType<typeof useProviderModelCatalog>, "getCachedModels" | "loadModelsForProvider">;
  selection: Pick<
    ReturnType<typeof useChatSessionSelection>,
    "selectedSessionId" | "userAdjustedModeOverrideRef" | "setModeOverride" | "modeOverride"
  >;
};

/** Builds the session header and guarded model selection actions. */
export function createChatSessionHeaderProps({
  workspaceSummaryText,
  sessionTrust,
  sending,
  historicalModeActive,
  selectedSession,
  dockOpen,
  handleToggleDock,
  blockHistoricalMutation,
  handleNavigateSurface,
  onResolvedModeChange,
  requestThreadModelPatch,
  surfaceState,
  providerRouting,
  sessionControls,
  providerCatalog,
  selection,
}: Input): Pick<
  MissionControlActiveSessionSurfaceProps,
  | "mode"
  | "sessionTitle"
  | "summary"
  | "trust"
  | "providerOptions"
  | "selectedProviderId"
  | "selectedModel"
  | "modelSwitchDisabled"
  | "sessionLifecycleStatus"
  | "sessionArchivePending"
  | "dockOpen"
  | "onToggleDock"
  | "onToggleArchiveSession"
  | "onNavigateSurface"
  | "onModeOverride"
  | "modeOverridePending"
  | "onRequestProviderChange"
  | "onRequestModelChange"
> {
  const { handleToggleArchiveSession } = sessionControls;
  const { setModeOverride } = selection;
  const { getCachedModels } = providerCatalog;
  const { loadModelsForProvider } = providerCatalog;

  return {
    mode: surfaceState.messageMode,
    sessionTitle: surfaceState.selectedSessionLabel,
    summary: workspaceSummaryText,
    trust: sessionTrust,
    providerOptions: providerRouting.providerOptions,
    selectedProviderId: providerRouting.selectedProviderId,
    selectedModel: providerRouting.selectedModel,
    modelSwitchDisabled: !selection.selectedSessionId || sending || historicalModeActive,
    sessionLifecycleStatus: selectedSession.lifecycleStatus,
    sessionArchivePending: sessionControls.sessionControlPending === "archive",
    dockOpen,
    onToggleDock: handleToggleDock,
    onToggleArchiveSession: () => {
      if (!blockHistoricalMutation()) void handleToggleArchiveSession();
    },
    onNavigateSurface: handleNavigateSurface,
    onModeOverride: (_mode: ChatMode) => {
      if (blockHistoricalMutation()) return;
      // A user-initiated override change: mark it so a later session switch
      // honors this explicit choice instead of snapping back to a URL seed.
      selection.userAdjustedModeOverrideRef.current = true;
      setModeOverride("chat");
      onResolvedModeChange?.("chat", "manual-override");
    },
    modeOverridePending: selection.modeOverride,
    onRequestProviderChange: (providerId) => {
      if (blockHistoricalMutation()) return;
      const provider = providerRouting.providerOptions.find((item) => item.providerId === providerId);
      const selection = resolveProviderModelSelection({
        provider,
        loadedModels: providerId ? getCachedModels(providerId) : [],
        selectedModel: undefined,
      });
      void loadModelsForProvider(providerId);
      requestThreadModelPatch({ providerId, model: selection.model ?? "" });
    },
    onRequestModelChange: (model) => {
      if (!blockHistoricalMutation()) requestThreadModelPatch({ model });
    },
  };
}
