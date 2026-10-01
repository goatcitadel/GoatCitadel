import type {
  ChatThreadResponse,
  ChatUserInputPromptRecord,
  OperatorInboxItem,
  OperatorInboxResponse,
} from "@goatcitadel/contracts";
import { inboxMatchesWorkspace } from "./inbox-presentation";

export function hasCurrentInboxUserInputItem(
  item: OperatorInboxItem,
  projection: OperatorInboxResponse,
  workspaceId: string,
): boolean {
  const { sessionId, turnId, promptId } = item.source;
  if (item.kind !== "user_input" || item.source.workspaceId !== workspaceId || !sessionId || !turnId || !promptId
    || item.id !== `user_input:${promptId}` || projection.authority !== "derived_projection"
    || !inboxMatchesWorkspace(projection, workspaceId)) return false;
  const currentItem = projection.items.find((entry) => entry.id === item.id);
  if (!currentItem || currentItem.kind !== "user_input" || currentItem.group !== "needs_decision"
    || currentItem.expiresAt !== item.expiresAt || currentItem.source.workspaceId !== workspaceId
    || currentItem.source.sessionId !== sessionId || currentItem.source.turnId !== turnId
    || currentItem.source.promptId !== promptId) return false;
  return true;
}

export function currentInboxUserInput(
  item: OperatorInboxItem,
  projection: OperatorInboxResponse,
  thread: ChatThreadResponse,
  workspaceId: string,
): ChatUserInputPromptRecord | undefined {
  if (!hasCurrentInboxUserInputItem(item, projection, workspaceId)
    || thread.sessionId !== item.source.sessionId) return undefined;
  const turnId = item.source.turnId!;
  const promptId = item.source.promptId!;
  const currentItem = projection.items.find((entry) => entry.id === item.id)!;
  const turn = thread.turns.find((entry) => entry.turnId === turnId);
  const prompt = turn?.trace.pendingUserInput;
  if (!turn || turn.trace.sessionId !== item.source.sessionId || turn.trace.status !== "waiting_for_user_input"
    || !prompt || prompt.turnId !== turnId || prompt.promptId !== promptId
    || (thread.activeLeafTurnId && thread.activeLeafTurnId !== turnId)
    || currentItem.expiresAt !== prompt.expiresAt) return undefined;
  if (prompt.expiresAt) {
    const expiresAt = Date.parse(prompt.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined;
  }
  return prompt;
}
