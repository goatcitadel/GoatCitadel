import { createCodeModeRun } from "@goatcitadel/mission-control-shared/api/capabilities";
import { useCallback } from "react";
import { runWithSelectedSessionId } from "../mission-threaded-controller-helpers";
import { useChatDockWorkbenchController } from "../useChatDockWorkbenchController";
import { useMissionControlSurfaceState } from "../useMissionControlSurfaceState";
import { useChatNoticesAndPresetRefresh } from "./useChatNoticesAndPresetRefresh";
import { useChatScopedErrors } from "./useChatScopedErrors";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "selectedSessionId">;
  notices: Pick<ReturnType<typeof useChatNoticesAndPresetRefresh>, "pushLocalNotice">;
  surfaceState: Pick<ReturnType<typeof useMissionControlSurfaceState>, "selectedTurn">;
  workbenchController: Pick<ReturnType<typeof useChatDockWorkbenchController>, "refreshWorkbench">;
  scopedErrors: Pick<ReturnType<typeof useChatScopedErrors>, "setUiError">;
};

/** Launches the existing governed Code capability from Chat with the current session scope. */
export function useChatCodeCapabilityLaunch({
  selection,
  notices,
  surfaceState,
  workbenchController,
  scopedErrors,
}: Input) {
  const { pushLocalNotice } = notices;
  const { refreshWorkbench } = workbenchController;
  const { setUiError } = scopedErrors;

  const handleRunCodeHelper = useCallback(
    async (language: string, source: string) => {
      await runWithSelectedSessionId(selection.selectedSessionId, async (sessionId) => {
        const normalizedLanguage = language.toLowerCase();
        if (
          normalizedLanguage !== "ts" &&
          normalizedLanguage !== "tsx" &&
          normalizedLanguage !== "typescript" &&
          normalizedLanguage !== "js" &&
          normalizedLanguage !== "jsx" &&
          normalizedLanguage !== "javascript"
        ) {
          pushLocalNotice("Code helper currently supports JavaScript and TypeScript snippets.", "warning");
          return;
        }
        try {
          await createCodeModeRun({
            language: normalizedLanguage.startsWith("ts") ? "typescript" : "javascript",
            source,
            originSurface: "chat",
            sessionId,
            turnId: surfaceState.selectedTurn?.turnId,
            requestedOutputIntent: "workbench_helper",
          });
          pushLocalNotice("Queued a code helper run for this snippet.", "success");
          await refreshWorkbench();
        } catch (cause) {
          setUiError(cause instanceof Error ? cause.message : "Unable to start code helper run.");
        }
      });
    },
    [pushLocalNotice, refreshWorkbench, selection.selectedSessionId, surfaceState.selectedTurn?.turnId, setUiError],
  );

  return { handleRunCodeHelper };
}
