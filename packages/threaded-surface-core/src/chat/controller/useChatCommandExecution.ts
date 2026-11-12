import type { ChatMode } from "@goatcitadel/contracts";
import { parseChatCommand } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayCallerScopeRevision } from "@goatcitadel/mission-control-shared/api/access-scope";
import { useProjectAccess } from "@goatcitadel/mission-control-shared/hooks/use-current-access";
import { useCallback } from "react";
import { parseBtwCommand, parseQueueCommand } from "../chat-page-pure-helpers";
import { useBtwSideChatController } from "../useBtwSideChatController";
import { useChatChangePlanState } from "../useChatChangePlanState";
import { useChatSessionData } from "../useChatSessionData";
import { useChatSurfaceOrchestration } from "../useChatSurfaceOrchestration";
import { useChatNoticesAndPresetRefresh } from "./useChatNoticesAndPresetRefresh";
import { useChatScopedErrors } from "./useChatScopedErrors";
import { useChatSessionSelection } from "./useChatSessionSelection";

export type ChatCommandExecutionInput = {
  workspaceId: string;
  openBtwSideChat: ReturnType<typeof useBtwSideChatController>["openSideChat"];
  notices: Pick<ReturnType<typeof useChatNoticesAndPresetRefresh>, "pushLocalNotice">;
  scopedErrors: Pick<ReturnType<typeof useChatScopedErrors>, "setUiError">;
  orchestration: Pick<ReturnType<typeof useChatSurfaceOrchestration>, "setQueuedOutbound">;
  sessionData: Pick<
    ReturnType<typeof useChatSessionData>,
    "thread" | "setPrefs" | "loadSidebar" | "setInstalledSkills" | "setMcpServers" | "setMcpTemplates"
  >;
  selectedTurnId: string | null;
  executionSurfaceMode: ChatMode;
  changePlanState: Pick<ReturnType<typeof useChatChangePlanState>, "setChatChangePlanSnapshot">;
  selection: Pick<
    ReturnType<typeof useChatSessionSelection>,
    "selectedSessionIntentRef" | "selectedSessionRevisionRef" | "setSelectedSessionId"
  >;
};

/** Routes local commands through their existing session, timer, variable and Gateway owners. */
export function useChatCommandExecution({
  workspaceId,
  openBtwSideChat,
  notices,
  scopedErrors,
  orchestration,
  sessionData,
  selectedTurnId,
  executionSurfaceMode,
  changePlanState,
  selection,
}: ChatCommandExecutionInput) {
  const { thread } = sessionData;
  const { pushLocalNotice } = notices;
  const { setUiError } = scopedErrors;
  const { setQueuedOutbound } = orchestration;
  const { setPrefs } = sessionData;
  const { setChatChangePlanSnapshot } = changePlanState;
  const { loadSidebar } = sessionData;
  const { selectedSessionIntentRef, selectedSessionRevisionRef, setSelectedSessionId } = selection;
  const { current: isCurrentAccess } = useProjectAccess(workspaceId);
  const { setInstalledSkills } = sessionData;
  const { setMcpServers } = sessionData;
  const { setMcpTemplates } = sessionData;

  const handleCommandExecution = useCallback(
    async (sessionId: string, commandText: string) => {
      const btwCommand = parseBtwCommand(commandText);
      if (btwCommand) {
        await openBtwSideChat(btwCommand.text);
        return;
      }
      const selectionRevision = selectedSessionRevisionRef.current;
      const callerRevision = getGatewayCallerScopeRevision();
      const current = () =>
        isCurrentAccess() &&
        callerRevision === getGatewayCallerScopeRevision() &&
        selectionRevision === selectedSessionRevisionRef.current &&
        sessionId === selectedSessionIntentRef.current;
      if (!current()) return;

      const queueCommand = parseQueueCommand(commandText);
      if (queueCommand) {
        const { runChatQueueCommand } = await import("./chat-command-result.js");
        return await runChatQueueCommand(queueCommand, {
          current,
          sessionId,
          pushLocalNotice,
          setUiError,
          setQueuedOutbound,
        });
      }
      const commandPolicyTurn =
        thread?.turns.find(
          (turn) => turn.turnId === (selectedTurnId ?? thread.selectedTurnId ?? thread.activeLeafTurnId),
        ) ?? null;
      const commandPolicyRunId = commandPolicyTurn?.trace.orchestration?.runId;
      const result = await parseChatCommand(sessionId, commandText, {
        surface: executionSurfaceMode,
        ...(commandPolicyRunId ? { policyRunId: commandPolicyRunId } : {}),
      });
      if (!current()) return;
      const { publishChatCommandResult } = await import("./chat-command-result.js");
      await publishChatCommandResult(result, {
        current,
        sessionId,
        setPrefs,
        setChatChangePlanSnapshot,
        pushLocalNotice,
        loadSidebar,
        setSelectedSessionId,
        setInstalledSkills,
        setMcpServers,
        setMcpTemplates,
      });
    },
    [
      thread?.turns,
      thread?.selectedTurnId,
      thread?.activeLeafTurnId,
      setPrefs,
      pushLocalNotice,
      openBtwSideChat,
      setQueuedOutbound,
      setUiError,
      selectedTurnId,
      setChatChangePlanSnapshot,
      loadSidebar,
      setInstalledSkills,
      setMcpServers,
      setMcpTemplates,
      executionSurfaceMode,
      isCurrentAccess,
      selectedSessionIntentRef,
      selectedSessionRevisionRef,
      setSelectedSessionId,
    ],
  );

  return { handleCommandExecution };
}
