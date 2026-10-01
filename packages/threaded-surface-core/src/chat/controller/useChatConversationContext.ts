import { useCallback, useEffect, useMemo } from "react";
import {
  buildContextSelectionState,
  buildSelectedConversationContext,
  getThreadSourceLabel,
} from "../mission-threaded-controller-helpers";
import { useChatSessionData } from "../useChatSessionData";
import type { OutboundContextBlock } from "../useChatSurfaceOrchestration";
import { useChatThreadController } from "../useChatThreadController";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  threadController: Pick<ReturnType<typeof useChatThreadController>, "selectedSession" | "visibleSessionLabelById">;
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "selectedSessionId">;
  sessionData: Pick<ReturnType<typeof useChatSessionData>, "thread">;
  selectedContextTurnIds: string[];
  pendingThreadContext: OutboundContextBlock | null;
  setSelectedContextTurnIds: React.Dispatch<React.SetStateAction<string[]>>;
  setPendingThreadContext: React.Dispatch<React.SetStateAction<OutboundContextBlock | null>>;
};

/** Builds selected conversation context and clears it only at existing consumption boundaries. */
export function useChatConversationContext({
  threadController,
  selection,
  sessionData,
  selectedContextTurnIds,
  pendingThreadContext,
  setSelectedContextTurnIds,
  setPendingThreadContext,
}: Input) {
  const threadContextSourceLabel = useMemo(
    () =>
      getThreadSourceLabel({
        selectedSession: threadController.selectedSession,
        selectedSessionId: selection.selectedSessionId,
        visibleSessionLabelById: threadController.visibleSessionLabelById,
      }),
    [threadController.selectedSession, selection.selectedSessionId, threadController.visibleSessionLabelById],
  );
  const selectedConversationContext = useMemo(
    () =>
      buildSelectedConversationContext({
        thread: sessionData.thread,
        turnIds: selectedContextTurnIds,
        sourceLabel: threadContextSourceLabel,
        sourceSessionId: selection.selectedSessionId ?? undefined,
      }),
    [selectedContextTurnIds, selection.selectedSessionId, sessionData.thread, threadContextSourceLabel],
  );
  const activeOutboundContext =
    pendingThreadContext && pendingThreadContext.sessionId === selection.selectedSessionId
      ? pendingThreadContext
      : selectedConversationContext;
  const contextSelection = buildContextSelectionState(activeOutboundContext);
  useEffect(() => {
    if (!sessionData.thread || selectedContextTurnIds.length === 0) {
      return;
    }
    const availableTurnIds = new Set(sessionData.thread.turns.map((turn) => turn.turnId));
    setSelectedContextTurnIds((current) => {
      const next = current.filter((turnId) => availableTurnIds.has(turnId));
      return next.length === current.length ? current : next;
    });
  }, [selectedContextTurnIds.length, sessionData.thread, setSelectedContextTurnIds]);
  const handleOutboundContextConsumed = useCallback(() => {
    setSelectedContextTurnIds([]);
    setPendingThreadContext((current) => (current?.sessionId === selection.selectedSessionId ? null : current));
  }, [selection.selectedSessionId, setPendingThreadContext, setSelectedContextTurnIds]);

  return { activeOutboundContext, handleOutboundContextConsumed, contextSelection };
}
