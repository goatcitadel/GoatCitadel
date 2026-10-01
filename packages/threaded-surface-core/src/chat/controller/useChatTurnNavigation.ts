import { useCallback } from "react";
import { useChatDockWorkbenchController } from "../useChatDockWorkbenchController";
import { useChatOutboundExecution } from "../useChatOutboundExecution";
import { useMissionControlSurfaceState } from "../useMissionControlSurfaceState";
import { useChatSurfaceNavigation } from "./useChatSurfaceNavigation";

type Input = {
  surfaceState: Pick<ReturnType<typeof useMissionControlSurfaceState>, "selectedTurn">;
  workbenchController: Pick<ReturnType<typeof useChatDockWorkbenchController>, "dockOpen" | "activeWorkflowTurn">;
  selectedTurnId: string | null;
  navigation: Pick<ReturnType<typeof useChatSurfaceNavigation>, "handleDockOpenChange">;
  setSelectedTurnId: React.Dispatch<React.SetStateAction<string | null>>;
  outbound: Pick<ReturnType<typeof useChatOutboundExecution>, "handleSelectBranchTurn">;
  setFollowThreadOutput: React.Dispatch<React.SetStateAction<boolean>>;
};

/** Reveals selected or active run details and refreshes the canonical branch selection. */
export function useChatTurnNavigation({
  surfaceState,
  workbenchController,
  selectedTurnId,
  navigation,
  setSelectedTurnId,
  outbound,
  setFollowThreadOutput,
}: Input) {
  const { handleDockOpenChange } = navigation;
  const { handleSelectBranchTurn } = outbound;

  const handleRevealSelectedTurnDetails = useCallback(() => {
    if (!surfaceState.selectedTurn) {
      return;
    }
    if (workbenchController.dockOpen && selectedTurnId === surfaceState.selectedTurn.turnId) {
      handleDockOpenChange(false);
      return;
    }
    setSelectedTurnId(surfaceState.selectedTurn.turnId);
    handleDockOpenChange(true);
  }, [
    workbenchController.dockOpen,
    handleDockOpenChange,
    surfaceState.selectedTurn,
    selectedTurnId,
    setSelectedTurnId,
  ]);
  const handleRevealActiveTurnDetails = useCallback(() => {
    const nextTurn = workbenchController.activeWorkflowTurn ?? surfaceState.selectedTurn;
    if (!nextTurn) {
      return;
    }
    if (workbenchController.dockOpen && selectedTurnId === nextTurn.turnId) {
      handleDockOpenChange(false);
      return;
    }
    setSelectedTurnId(nextTurn.turnId);
    handleDockOpenChange(true);
  }, [
    workbenchController.activeWorkflowTurn,
    workbenchController.dockOpen,
    handleDockOpenChange,
    surfaceState.selectedTurn,
    selectedTurnId,
    setSelectedTurnId,
  ]);

  const handleSelectBranchTurnAndSync = useCallback(
    async (turnId: string) => {
      const nextThread = await handleSelectBranchTurn(turnId);
      if (nextThread) {
        setFollowThreadOutput(true);
        setSelectedTurnId(nextThread.activeLeafTurnId ?? turnId);
      }
    },
    [handleSelectBranchTurn, setFollowThreadOutput, setSelectedTurnId],
  );

  return { handleRevealSelectedTurnDetails, handleSelectBranchTurnAndSync, handleRevealActiveTurnDetails };
}
