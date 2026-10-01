import { useCallback, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { ChatMode, ChatGeneratedArtifactRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import {
  createChatGeneratedArtifact,
  fetchChatGeneratedArtifact,
} from "@goatcitadel/mission-control-shared/api/client";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { revealGeneratedArtifactInSurface } from "./chat-page-pure-helpers";
import { runWithSelectedSessionId } from "./mission-threaded-controller-helpers";
import { useRouteGeneratedArtifactReveal } from "./useRouteGeneratedArtifactReveal";
import type { useChatSessionData } from "./useChatSessionData";

type Input = {
  documentOwner: RefObject<{ scope: string; generation: number }>;
  routeArtifactId: string | null;
  workspaceId: string;
  activeGeneratedArtifact: ChatGeneratedArtifactRecord | null;
  compactSurfaceLayout: boolean;
  messageMode: ChatMode;
  selectedSessionId: string | null;
  selectedTurnId: string | null;
  thread: ChatThreadResponse | null;
  loadSessionCoreState: ReturnType<typeof useChatSessionData>["loadSessionCoreState"];
  setSessionRailOpen: Dispatch<SetStateAction<boolean>>;
  setDockOpen: Dispatch<SetStateAction<boolean>>;
  setActiveGeneratedArtifact: Dispatch<SetStateAction<ChatGeneratedArtifactRecord | null>>;
  setSelectedTurnId: Dispatch<SetStateAction<string | null>>;
  setGeneratedArtifacts: ReturnType<typeof useChatSessionData>["setGeneratedArtifacts"];
  setActivityOpenRequest: Dispatch<SetStateAction<number>>;
  handleNavigateSurface: (
    surface: ChatMode,
    options?: { sessionId?: string | null; turnId?: string | null; artifactId?: string | null },
  ) => void;
  setUiError: (value: string | null) => void;
  pushLocalNotice: (content: string, tone?: ChatThreadNotice["tone"]) => void;
};

export function useChatGeneratedArtifactActions({
  documentOwner,
  routeArtifactId,
  workspaceId,
  activeGeneratedArtifact,
  compactSurfaceLayout,
  messageMode,
  selectedSessionId,
  selectedTurnId,
  thread,
  loadSessionCoreState,
  setSessionRailOpen,
  setDockOpen,
  setActiveGeneratedArtifact,
  setSelectedTurnId,
  setGeneratedArtifacts,
  setActivityOpenRequest,
  handleNavigateSurface,
  setUiError,
  pushLocalNotice,
}: Input) {
  const handleCloseGeneratedArtifact = useCallback(() => {
    setActiveGeneratedArtifact(null);
    handleNavigateSurface(messageMode, {
      sessionId: selectedSessionId,
      turnId: selectedTurnId,
      artifactId: null,
    });
  }, [handleNavigateSurface, messageMode, selectedSessionId, selectedTurnId, setActiveGeneratedArtifact]);

  const revealGeneratedArtifact = useCallback(
    async (artifact: ChatGeneratedArtifactRecord) => {
      const generation = documentOwner.current.generation;
      await revealGeneratedArtifactInSurface({
        isCurrent: () => documentOwner.current.generation === generation,
        onOpenArtifact: () => setActivityOpenRequest((current) => current + 1),
        artifact,
        compactSurfaceLayout,
        messageMode,
        loadSessionCoreState,
        setSessionRailOpen,
        setDockOpen,
        setActiveGeneratedArtifact,
        setSelectedTurnId,
        setGeneratedArtifacts,
        handleNavigateSurface,
      });
    },
    [
      compactSurfaceLayout,
      documentOwner,
      handleNavigateSurface,
      loadSessionCoreState,
      messageMode,
      setActiveGeneratedArtifact,
      setActivityOpenRequest,
      setDockOpen,
      setGeneratedArtifacts,
      setSelectedTurnId,
      setSessionRailOpen,
    ],
  );
  useRouteGeneratedArtifactReveal({
    routeArtifactId,
    workspaceId,
    activeArtifactId: activeGeneratedArtifact?.artifactId,
    onError: (error) => setUiError(error),
    revealGeneratedArtifact,
    setActiveGeneratedArtifact,
  });

  const handleOpenGeneratedArtifactFromTurn = useCallback(
    async (turnId: string, artifactId?: string) => {
      const generation = documentOwner.current.generation;
      try {
        await runWithSelectedSessionId(selectedSessionId, async () => {
          const targetTurn = thread?.turns.find((turn) => turn.turnId === turnId) ?? null;
          const existingArtifactId = artifactId
            ? targetTurn?.generatedArtifacts?.find((item) => item.artifactId === artifactId)?.artifactId
            : targetTurn?.generatedArtifacts?.[0]?.artifactId;
          if (!existingArtifactId) {
            pushLocalNotice("Create an artifact from this turn before opening it.", "warning");
            return;
          }
          const artifact = (await fetchChatGeneratedArtifact(existingArtifactId, workspaceId)).item;
          if (documentOwner.current.generation !== generation) return;
          if (
            artifact.artifactId !== existingArtifactId ||
            artifact.sessionId !== selectedSessionId ||
            artifact.turnId !== turnId
          )
            throw new Error("The returned artifact does not match this turn.");
          await revealGeneratedArtifact(artifact);
        });
      } catch (err) {
        setUiError((err as Error).message);
      }
    },
    [
      documentOwner,
      pushLocalNotice,
      revealGeneratedArtifact,
      selectedSessionId,
      setUiError,
      thread?.turns,
      workspaceId,
    ],
  );

  const handleCreateGeneratedArtifactFromTurn = useCallback(
    async (turnId: string, options?: { supersedeLatest?: boolean }) => {
      try {
        await runWithSelectedSessionId(selectedSessionId, async (sessionId) => {
          const artifact = (
            await createChatGeneratedArtifact(sessionId, turnId, {
              supersedeLatest: options?.supersedeLatest ?? false,
            })
          ).item;
          await revealGeneratedArtifact(artifact);
          pushLocalNotice(
            options?.supersedeLatest ? "Saved a new generated artifact version." : "Created a generated artifact.",
            "success",
          );
        });
      } catch (err) {
        setUiError((err as Error).message);
      }
    },
    [pushLocalNotice, revealGeneratedArtifact, selectedSessionId, setUiError],
  );

  return {
    handleCloseGeneratedArtifact,
    revealGeneratedArtifact,
    handleOpenGeneratedArtifactFromTurn,
    handleCreateGeneratedArtifactFromTurn,
  };
}
