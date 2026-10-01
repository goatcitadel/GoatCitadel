import { removeThreadKnowledgeAttachment } from "@goatcitadel/mission-control-shared/api/client";
import { useCallback } from "react";
import { runWithSelectedSessionId } from "../mission-threaded-controller-helpers";
import { useChatSessionData } from "../useChatSessionData";
import { useChatNoticesAndPresetRefresh } from "./useChatNoticesAndPresetRefresh";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "selectedSessionId">;
  sessionData: Pick<ReturnType<typeof useChatSessionData>, "loadSessionCoreState" | "setThreadKnowledgeAttachments">;
  notices: Pick<ReturnType<typeof useChatNoticesAndPresetRefresh>, "pushLocalNotice">;
};

/** Removes knowledge through the existing Gateway owner and refreshes scoped evidence. */
export function useChatKnowledgeRemoval({ selection, sessionData, notices }: Input) {
  const { loadSessionCoreState } = sessionData;
  const { setThreadKnowledgeAttachments } = sessionData;
  const { pushLocalNotice } = notices;

  const handleRemoveThreadKnowledge = useCallback(
    async (attachmentId: string) => {
      await runWithSelectedSessionId(selection.selectedSessionId, async (sessionId) => {
        await removeThreadKnowledgeAttachment(sessionId, attachmentId);
        await loadSessionCoreState(sessionId, {
          background: true,
          includeThread: false,
        });
        setThreadKnowledgeAttachments((current) =>
          current
            ? {
                items: current.items.filter((item) => item.attachmentId !== attachmentId),
              }
            : current,
        );
        pushLocalNotice("Removed thread knowledge attachment.", "success");
      });
    },
    [loadSessionCoreState, pushLocalNotice, selection.selectedSessionId, setThreadKnowledgeAttachments],
  );

  return { handleRemoveThreadKnowledge };
}
