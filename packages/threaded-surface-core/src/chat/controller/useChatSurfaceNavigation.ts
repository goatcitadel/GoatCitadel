import type { ChatGeneratedArtifactRecord, ChatMode, ChatSessionSearchHitRecord } from "@goatcitadel/contracts";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { useCallback } from "react";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";
import { useChatDockWorkbenchController } from "../useChatDockWorkbenchController";
import { useChatSessionData } from "../useChatSessionData";
import type { OutboundContextBlock } from "../useChatSurfaceOrchestration";
import { useMissionControlSurfaceState } from "../useMissionControlSurfaceState";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  sessionData: Pick<ReturnType<typeof useChatSessionData>, "openHistoricalWindow" | "returnToLatest">;
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "selectedSessionId" | "setSelectedSessionId">;
  setSelectedTurnId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedContextTurnIds: React.Dispatch<React.SetStateAction<string[]>>;
  setPendingThreadContext: React.Dispatch<React.SetStateAction<OutboundContextBlock | null>>;
  setActiveGeneratedArtifact: React.Dispatch<React.SetStateAction<ChatGeneratedArtifactRecord | null>>;
  setSessionRailOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onNavigateSurface: MissionThreadedControllerHostProps["onNavigateSurface"];
  surfaceState: Pick<ReturnType<typeof useMissionControlSurfaceState>, "messageMode">;
  compactSurfaceLayout: ReturnType<typeof useMediaQuery>;
  workbenchController: Pick<ReturnType<typeof useChatDockWorkbenchController>, "setDockOpen">;
  activeGeneratedArtifact: ChatGeneratedArtifactRecord | null;
  selectedTurnId: string | null;
};

/** Coordinates explicit session/history selection and responsive rail/dock navigation. */
export function useChatSurfaceNavigation({
  sessionData,
  selection,
  setSelectedTurnId,
  setSelectedContextTurnIds,
  setPendingThreadContext,
  setActiveGeneratedArtifact,
  setSessionRailOpen,
  onNavigateSurface,
  surfaceState,
  compactSurfaceLayout,
  workbenchController,
  activeGeneratedArtifact,
  selectedTurnId,
}: Input) {
  const { openHistoricalWindow } = sessionData;
  const { returnToLatest } = sessionData;
  const { setSelectedSessionId } = selection;
  const { setDockOpen } = workbenchController;

  const handleSelectSessionFromRail = useCallback(
    (sessionId: string, options?: { turnId?: string | null; searchHit?: ChatSessionSearchHitRecord }) => {
      const openRequestedHistory = () => {
        if (options?.searchHit) {
          void openHistoricalWindow(sessionId, options.searchHit);
        } else {
          returnToLatest();
        }
      };
      if (sessionId === selection.selectedSessionId) {
        openRequestedHistory();
        setSelectedTurnId(options?.turnId ?? options?.searchHit?.turnId ?? null);
        setSelectedContextTurnIds([]);
        setPendingThreadContext(null);
        setActiveGeneratedArtifact(null);
        setSessionRailOpen(false);
        onNavigateSurface?.(surfaceState.messageMode, {
          sessionId,
          turnId: options?.turnId ?? options?.searchHit?.turnId ?? null,
          artifactId: null,
          ...(!options?.turnId && !options?.searchHit?.turnId && options?.searchHit ? { messageId: options.searchHit.messageId, sequence: options.searchHit.sequence } : {}),
        });
        return;
      }
      {
        setSelectedSessionId(sessionId);
        openRequestedHistory();
        setSelectedTurnId(options?.turnId ?? options?.searchHit?.turnId ?? null);
        setSelectedContextTurnIds([]);
        setPendingThreadContext(null);
        setActiveGeneratedArtifact(null);
        setSessionRailOpen(false);
        onNavigateSurface?.(surfaceState.messageMode, {
          sessionId,
          turnId: options?.turnId ?? options?.searchHit?.turnId ?? null,
          artifactId: null,
          ...(!options?.turnId && !options?.searchHit?.turnId && options?.searchHit ? { messageId: options.searchHit.messageId, sequence: options.searchHit.sequence } : {}),
        });
      }
    },
    [
      surfaceState.messageMode,
      onNavigateSurface,
      openHistoricalWindow,
      returnToLatest,
      selection.selectedSessionId,
      setSelectedSessionId,
      setSelectedTurnId,
      setActiveGeneratedArtifact,
      setPendingThreadContext,
      setSelectedContextTurnIds,
      setSessionRailOpen,
    ],
  );
  const handleSessionRailOpenChange = useCallback(
    (next: boolean) => {
      setSessionRailOpen(next);
      if (next && compactSurfaceLayout) {
        setDockOpen(false);
        setActiveGeneratedArtifact(null);
      }
    },
    [compactSurfaceLayout, setDockOpen, setActiveGeneratedArtifact, setSessionRailOpen],
  );
  const handleDockOpenChange = useCallback(
    (next: boolean) => {
      setDockOpen(next);
      if (next && compactSurfaceLayout) {
        setSessionRailOpen(false);
        setActiveGeneratedArtifact(null);
      }
    },
    [compactSurfaceLayout, setDockOpen, setActiveGeneratedArtifact, setSessionRailOpen],
  );
  const handleNavigateSurface = useCallback(
    (
      nextSurface: ChatMode,
      options?: { sessionId?: string | null; turnId?: string | null; artifactId?: string | null },
    ) => {
      const nextArtifactId =
        options && Object.prototype.hasOwnProperty.call(options, "artifactId")
          ? (options.artifactId ?? undefined)
          : (activeGeneratedArtifact?.artifactId ?? undefined);
      const nextSessionId = options?.sessionId ?? selection.selectedSessionId;
      const runNavigation = () =>
        onNavigateSurface?.(nextSurface, {
          sessionId: nextSessionId,
          turnId: options?.turnId ?? selectedTurnId,
          artifactId: nextArtifactId,
        });

      runNavigation();
    },
    [activeGeneratedArtifact?.artifactId, onNavigateSurface, selection.selectedSessionId, selectedTurnId],
  );

  return { handleNavigateSurface, handleDockOpenChange, handleSelectSessionFromRail, handleSessionRailOpenChange };
}
