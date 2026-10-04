import { useCallback } from "react";
import type { ChatWebMode } from "@goatcitadel/contracts";
import { useChatPreferenceMutations } from "../useChatPreferenceMutations";
import { useChatSessionData } from "../useChatSessionData";

type Input = {
  preferenceActions: Pick<ReturnType<typeof useChatPreferenceMutations>, "handlePrefPatch">;
  planningMode: import("@goatcitadel/contracts").ChatPlanningMode;
  sessionData: Pick<ReturnType<typeof useChatSessionData>, "prefs">;
};

/** Updates planning, research and review preferences through the existing preference owner. */
export function useChatPlanningPreferences({ preferenceActions, planningMode, sessionData }: Input) {
  const { handlePrefPatch } = preferenceActions;

  const handleTogglePlanningMode = useCallback(() => {
    void handlePrefPatch({ planningMode: planningMode === "advisory" ? "off" : "advisory" });
  }, [handlePrefPatch, planningMode]);
  const handleToggleResearchMode = useCallback(() => {
    const currentWebMode = sessionData.prefs?.webMode ?? "auto";

    void handlePrefPatch({
      webMode: currentWebMode === "quick" || currentWebMode === "deep" ? "auto" : "quick",
    });
  }, [handlePrefPatch, sessionData.prefs?.webMode]);
  const handleToggleReviewMode = useCallback(() => {
    const currentReviewDepth = sessionData.prefs?.orchestrationReviewDepth ?? "off";

    void handlePrefPatch({
      orchestrationReviewDepth: currentReviewDepth === "off" ? "standard" : "off",
    });
  }, [handlePrefPatch, sessionData.prefs?.orchestrationReviewDepth]);
  const handleSetWebMode = useCallback(
    (webMode: ChatWebMode) => {
      void handlePrefPatch({ webMode });
    },
    [handlePrefPatch],
  );

  return { handleTogglePlanningMode, handleToggleResearchMode, handleToggleReviewMode, handleSetWebMode };
}
