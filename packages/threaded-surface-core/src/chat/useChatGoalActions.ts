import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import {
  ApiRequestError,
  clearChatSessionGoal,
  fetchChatSessionGoal,
  setChatSessionGoal,
  steerChatSession,
} from "@goatcitadel/mission-control-shared/api/client";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import type { useChatSessionData } from "./useChatSessionData";

type Input = {
  selectedSessionId: string | null;
  selectedSession: ChatSessionRecord | null;
  historyView: "active" | "archived";
  loadSidebar: ReturnType<typeof useChatSessionData>["loadSidebar"];
  setPinnedGoal: Dispatch<SetStateAction<string | undefined>>;
  refreshChatSessionAggregate: (sessionId: string) => Promise<void>;
  setUiError: (value: string | null) => void;
  pushLocalNotice: (content: string, tone?: ChatThreadNotice["tone"]) => void;
};

export function useChatGoalActions({
  selectedSessionId,
  selectedSession,
  historyView,
  loadSidebar,
  setPinnedGoal,
  refreshChatSessionAggregate,
  setUiError,
  pushLocalNotice,
}: Input) {
  const handleSetGoal = useCallback(
    async (goal: string, turnBudget?: number) => {
      if (!selectedSessionId) {
        return;
      }
      try {
        if (!selectedSession) {
          return;
        }
        const response = await setChatSessionGoal(selectedSessionId, {
          goal,
          turnBudget,
          expectedRevision: selectedSession.revision,
        });
        setPinnedGoal(response.goal ?? undefined);
        await loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSessionId });
        pushLocalNotice(`Goal set: ${response.goal ?? goal}`, "success");
      } catch (cause) {
        if (cause instanceof ApiRequestError && cause.status === 409) {
          await refreshChatSessionAggregate(selectedSessionId);
          setUiError("This chat changed elsewhere. Your goal draft is preserved; review it and retry.");
        } else {
          setUiError(cause instanceof Error ? cause.message : "Failed to set goal.");
        }
      }
    },
    [
      historyView,
      loadSidebar,
      pushLocalNotice,
      refreshChatSessionAggregate,
      selectedSession,
      selectedSessionId,
      setPinnedGoal,
      setUiError,
    ],
  );

  const handleClearGoal = useCallback(async () => {
    if (!selectedSessionId || !selectedSession) {
      return;
    }
    try {
      await clearChatSessionGoal(selectedSessionId, selectedSession.revision);
      setPinnedGoal(undefined);
      await loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSessionId });
      pushLocalNotice("Goal cleared.", "success");
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 409) {
        await refreshChatSessionAggregate(selectedSessionId);
        setUiError("This chat changed elsewhere. Review the latest goal, then clear it again.");
      } else {
        setUiError(cause instanceof Error ? cause.message : "Failed to clear goal.");
      }
    }
  }, [
    historyView,
    loadSidebar,
    pushLocalNotice,
    refreshChatSessionAggregate,
    selectedSession,
    selectedSessionId,
    setPinnedGoal,
    setUiError,
  ]);

  const handleGoalStatus = useCallback(async () => {
    if (!selectedSessionId) {
      return;
    }
    try {
      const response = await fetchChatSessionGoal(selectedSessionId);
      setPinnedGoal(response.goal ?? undefined);
      if (response.goal) {
        const budgetSuffix =
          response.turnBudget !== null && response.turnBudget !== undefined
            ? ` (${response.turnsUsed}/${response.turnBudget} turns)`
            : "";
        pushLocalNotice(`Goal: ${response.goal}${budgetSuffix}`, "neutral");
      } else {
        pushLocalNotice("No pinned goal.", "neutral");
      }
    } catch (cause) {
      setUiError(cause instanceof Error ? cause.message : "Failed to fetch goal status.");
    }
  }, [pushLocalNotice, selectedSessionId, setPinnedGoal, setUiError]);

  const handleSteerMidTurn = useCallback(
    async (instruction: string) => {
      if (!selectedSessionId) {
        return;
      }
      try {
        const response = await steerChatSession(selectedSessionId, { instruction });
        if (!response.accepted) {
          pushLocalNotice(response.reason ?? "Steering instruction not accepted.", "warning");
        } else {
          pushLocalNotice("Steering instruction queued.", "success");
        }
      } catch (cause) {
        setUiError(cause instanceof Error ? cause.message : "Failed to send steering instruction.");
      }
    },
    [pushLocalNotice, selectedSessionId, setUiError],
  );

  return { handleSetGoal, handleClearGoal, handleGoalStatus, handleSteerMidTurn };
}
