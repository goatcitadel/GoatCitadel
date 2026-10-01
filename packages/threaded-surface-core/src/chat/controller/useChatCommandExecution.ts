import type { ChatMode } from "@goatcitadel/contracts";
import {
  fetchMcpServers,
  fetchMcpTemplates,
  fetchSkills,
  parseChatCommand,
  steerChatSession,
} from "@goatcitadel/mission-control-shared/api/client";
import { useCallback } from "react";
import { formatCommandResult } from "../chat-page-derivations";
import { parseBtwCommand, parseQueueCommand } from "../chat-page-pure-helpers";
import { useBtwSideChatController } from "../useBtwSideChatController";
import { useChatChangePlanState } from "../useChatChangePlanState";
import { useChatSessionData } from "../useChatSessionData";
import { useChatSurfaceOrchestration } from "../useChatSurfaceOrchestration";
import { useChatNoticesAndPresetRefresh } from "./useChatNoticesAndPresetRefresh";
import { useChatScopedErrors } from "./useChatScopedErrors";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
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
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "setSelectedSessionId">;
};

/** Routes local commands through their existing session, timer, variable and Gateway owners. */
export function useChatCommandExecution({
  openBtwSideChat,
  notices,
  scopedErrors,
  orchestration,
  sessionData,
  selectedTurnId,
  executionSurfaceMode,
  changePlanState,
  selection,
}: Input) {
  const { thread } = sessionData;
  const { pushLocalNotice } = notices;
  const { setUiError } = scopedErrors;
  const { setQueuedOutbound } = orchestration;
  const { setPrefs } = sessionData;
  const { setChatChangePlanSnapshot } = changePlanState;
  const { loadSidebar } = sessionData;
  const { setSelectedSessionId } = selection;
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
      const queueCommand = parseQueueCommand(commandText);
      if (queueCommand) {
        if (queueCommand.kind === "steer") {
          if (!queueCommand.text) {
            pushLocalNotice("Usage: /queue steer <instruction>", "warning");
            return;
          }
          try {
            const response = await steerChatSession(sessionId, { instruction: queueCommand.text });
            pushLocalNotice(
              response.accepted
                ? "Steering instruction queued."
                : (response.reason ?? "Steering instruction not accepted."),
              response.accepted ? "success" : "warning",
            );
          } catch (cause) {
            setUiError(cause instanceof Error ? cause.message : "Failed to send steering instruction.");
          }
          return;
        }
        if (!queueCommand.text) {
          pushLocalNotice(`Usage: /queue ${queueCommand.kind} <message>`, "warning");
          return;
        }
        setQueuedOutbound((current) => [
          ...current,
          {
            id: `queue-${Date.now()}`,
            action: "send",
            sessionId,
            content: queueCommand.text,
            attachments: [],
            createdAt: new Date().toISOString(),
            paused: queueCommand.kind === "collect",
          },
        ]);
        pushLocalNotice(
          queueCommand.kind === "collect" ? "Message collected in the queue." : "Follow-up queued for the next turn.",
          "success",
        );
        return;
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
      if (result.prefs) setPrefs(result.prefs);
      const changePlan = result.changePlan;
      if (changePlan) {
        setChatChangePlanSnapshot((current) => {
          if (current.ownerSessionId !== sessionId) return current;
          return {
            ownerSessionId: sessionId,
            items: [changePlan, ...current.items.filter((item) => item.planId !== changePlan.planId)].slice(0, 12),
          };
        });
      }
      pushLocalNotice(formatCommandResult(result), result.ok ? "success" : "warning");
      if (result.command === "/project" || result.command === "/new") {
        await loadSidebar();
      }
      if (result.command === "/plan" && result.prefs) {
        setPrefs(result.prefs);
      }
      if (result.session) {
        setSelectedSessionId(result.session.sessionId);
      }
      if (result.command === "/skill" || result.command === "/skills") {
        setInstalledSkills(await fetchSkills().then((payload) => payload.items));
      }
      if (result.command === "/mcp") {
        const [servers, templates] = await Promise.all([fetchMcpServers(), fetchMcpTemplates()]);
        setMcpServers(servers.items);
        setMcpTemplates(templates.items);
      }
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
      setSelectedSessionId,
    ],
  );

  return { handleCommandExecution };
}
