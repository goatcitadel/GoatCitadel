import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { resolveCoworkComposerStopControl, resolveMidTurnDisposition } from "../chat-page-pure-helpers";
import type { MissionControlActiveSessionSurfaceProps } from "../MissionControlActiveSessionSurface";
import { useChatGeneratedArtifactActions } from "../useChatGeneratedArtifactActions";
import type { useChatGoalActions } from "../useChatGoalActions";
import { type ActiveChatStreamState } from "../useChatOutboundExecution";
import type { useChatRunPresentation } from "../useChatRunPresentation";
import type { useChatSurfaceOrchestration } from "../useChatSurfaceOrchestration";
import { useMissionControlSurfaceState } from "../useMissionControlSurfaceState";
import { useSurfaceClassifyPreview } from "../useSurfaceClassifyPreview";

type Input = {
  activeGeneratedArtifact: ChatGeneratedArtifactRecord | null;
  handleCloseGeneratedArtifact: ReturnType<typeof useChatGeneratedArtifactActions>["handleCloseGeneratedArtifact"];
  handleComposerSend: () => Promise<void>;
  messageMode: ReturnType<typeof useMissionControlSurfaceState>["messageMode"];
  historicalModeActive: boolean;
  blockHistoricalMutation: () => boolean;
  handleAgenticControl: (
    control: import("@goatcitadel/mission-control-shared/components/cowork-view-model").CoworkAgenticControlItem,
  ) => Promise<void>;
  agenticControlPending: string | null;
  pinnedGoal: string | undefined;
  activeStreamRef: React.RefObject<ActiveChatStreamState | null>;
  draft: string;
  surfacePreview: ReturnType<typeof useSurfaceClassifyPreview>;
  autoRouteActive: false;
  orchestration: Pick<ReturnType<typeof useChatSurfaceOrchestration>, "handleStopActiveTurn" | "isStopPending">;
  runPresentation: Pick<ReturnType<typeof useChatRunPresentation>, "visibleDelegationRun" | "coworkViewModel">;
  goalActions: Pick<
    ReturnType<typeof useChatGoalActions>,
    "handleSteerMidTurn" | "handleSetGoal" | "handleClearGoal" | "handleGoalStatus"
  >;
};

/** Builds goal and stop controls, retaining historical cancel safety escapes. */
export function createChatRunControlProps({
  activeGeneratedArtifact,
  handleCloseGeneratedArtifact,
  handleComposerSend,
  messageMode,
  historicalModeActive,
  blockHistoricalMutation,
  handleAgenticControl,
  agenticControlPending,
  pinnedGoal,
  activeStreamRef,
  draft,
  surfacePreview,
  autoRouteActive,
  orchestration,
  runPresentation,
  goalActions,
}: Input): Pick<
  MissionControlActiveSessionSurfaceProps,
  | "activeGeneratedArtifact"
  | "onCloseGeneratedArtifact"
  | "onStopActiveTurn"
  | "isStopPending"
  | "onSend"
  | "coworkStopRunControl"
  | "onCoworkStopRun"
  | "coworkStopRunPending"
  | "pinnedGoal"
  | "midTurnDisposition"
  | "onSteerMidTurn"
  | "onSetGoal"
  | "onClearGoal"
  | "onGoalStatus"
  | "surfaceRoutePreview"
  | "autoRouteActive"
> {
  const { handleStopActiveTurn } = orchestration;
  const { handleSteerMidTurn } = goalActions;
  const { handleSetGoal } = goalActions;
  const { handleClearGoal } = goalActions;

  return {
    activeGeneratedArtifact,
    onCloseGeneratedArtifact: handleCloseGeneratedArtifact,
    onStopActiveTurn: () => void handleStopActiveTurn(),
    isStopPending: orchestration.isStopPending,
    onSend: () => void handleComposerSend(),
    coworkStopRunControl: resolveCoworkComposerStopControl({
      mode: messageMode,
      delegationRunStatus: runPresentation.visibleDelegationRun?.status,
      controls: runPresentation.coworkViewModel.agenticRuntime?.controls,
    }),
    onCoworkStopRun: (control) => {
      if (historicalModeActive && control.action !== "cancel") {
        blockHistoricalMutation();
        return;
      }
      void handleAgenticControl(control);
    },
    coworkStopRunPending: agenticControlPending === "cancel",
    pinnedGoal,
    midTurnDisposition: resolveMidTurnDisposition({
      hasActiveStream: Boolean(activeStreamRef.current),
      draft,
    }),
    onSteerMidTurn: async (instruction) => {
      if (!blockHistoricalMutation()) await handleSteerMidTurn(instruction);
    },
    onSetGoal: async (goal, turnBudget) => {
      if (!blockHistoricalMutation()) await handleSetGoal(goal, turnBudget);
    },
    onClearGoal: async () => {
      if (!blockHistoricalMutation()) await handleClearGoal();
    },
    onGoalStatus: goalActions.handleGoalStatus,
    surfaceRoutePreview: surfacePreview,
    autoRouteActive,
  };
}
