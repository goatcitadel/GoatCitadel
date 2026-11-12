import {
  fetchMcpServers,
  fetchMcpTemplates,
  fetchSkills,
  steerChatSession,
  type parseChatCommand,
} from "@goatcitadel/mission-control-shared/api/client";
import { formatCommandResult } from "../chat-page-derivations";
import type { parseQueueCommand } from "../chat-page-pure-helpers";
import type { ChatCommandExecutionInput } from "./useChatCommandExecution";

type ResultOwner = Omit<ChatCommandExecutionInput["sessionData"], "thread"> &
  ChatCommandExecutionInput["changePlanState"] &
  ChatCommandExecutionInput["notices"] &
  Pick<ChatCommandExecutionInput["selection"], "setSelectedSessionId"> & {
    current: () => boolean;
    sessionId: string;
  };

export async function runChatQueueCommand(
  command: NonNullable<ReturnType<typeof parseQueueCommand>>,
  {
    current,
    sessionId,
    pushLocalNotice,
    setUiError,
    setQueuedOutbound,
  }: Pick<ResultOwner, "current" | "sessionId" | "pushLocalNotice"> &
    ChatCommandExecutionInput["scopedErrors"] &
    ChatCommandExecutionInput["orchestration"],
): Promise<void> {
  if (!current()) return;
  if (!command.text) {
    const input = command.kind === "steer" ? "instruction" : "message";
    pushLocalNotice(`Usage: /queue ${command.kind} <${input}>`, "warning");
    return;
  }
  if (command.kind === "steer") {
    try {
      const response = await steerChatSession(sessionId, { instruction: command.text });
      if (current())
        pushLocalNotice(
          response.accepted
            ? "Steering instruction queued."
            : (response.reason ?? "Steering instruction not accepted."),
          response.accepted ? "success" : "warning",
        );
    } catch (cause) {
      if (current()) setUiError(cause instanceof Error ? cause.message : "Failed to send steering instruction.");
    }
    return;
  }
  setQueuedOutbound((items) => [
    ...items,
    {
      id: `queue-${Date.now()}`,
      action: "send",
      sessionId,
      content: command.text,
      attachments: [],
      createdAt: new Date().toISOString(),
      paused: command.kind === "collect",
    },
  ]);
  pushLocalNotice(
    command.kind === "collect" ? "Message collected in the queue." : "Follow-up queued for the next turn.",
    "success",
  );
}

export async function publishChatCommandResult(
  result: Awaited<ReturnType<typeof parseChatCommand>>,
  owner: ResultOwner,
) {
  const { current, sessionId } = owner;
  if (!current()) return;
  if (!result.session && result.prefs?.sessionId === sessionId) owner.setPrefs(result.prefs);
  const changePlan = result.changePlan;
  if (changePlan) {
    owner.setChatChangePlanSnapshot((snapshot) => {
      if (snapshot.ownerSessionId !== sessionId) return snapshot;
      return {
        ownerSessionId: sessionId,
        items: [changePlan, ...snapshot.items.filter((item) => item.planId !== changePlan.planId)].slice(0, 12),
      };
    });
  }
  owner.pushLocalNotice(formatCommandResult(result), result.ok ? "success" : "warning");
  if (result.command === "/project" || result.command === "/new") {
    await owner.loadSidebar(undefined, result.session ? { preserveSelection: true } : undefined);
    if (!current()) return;
  }
  if (result.session) {
    owner.setSelectedSessionId(result.session.sessionId);
    if (result.prefs?.sessionId === result.session.sessionId) owner.setPrefs(result.prefs);
  }
  if (result.command === "/skill" || result.command === "/skills") {
    const { items } = await fetchSkills();
    if (current()) owner.setInstalledSkills(items);
  }
  if (result.command === "/mcp") {
    const [servers, templates] = await Promise.all([fetchMcpServers(), fetchMcpTemplates()]);
    if (!current()) return;
    owner.setMcpServers(servers.items);
    owner.setMcpTemplates(templates.items);
  }
}
