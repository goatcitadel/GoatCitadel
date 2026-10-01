import { CHAT_SESSION_STATUS_VERSION, type ChatMessageRecord, type ChatSessionStatusResponse } from "@goatcitadel/contracts";
import { fetchChatMessages, fetchChatSessionStatus } from "@goatcitadel/mission-control-shared/api/chat";

export interface InboxSourceMessage { messageId: string; role: string; timestamp: string; text: string; truncated: boolean }
function matches(status: ChatSessionStatusResponse, workspaceId: string, sessionId: string) {
  return status.schemaVersion === CHAT_SESSION_STATUS_VERSION && status.workspaceId === workspaceId && status.sessionId === sessionId;
}
export function sourceMessage(message: ChatMessageRecord, sessionId: string): InboxSourceMessage {
  if (!message || message.sessionId !== sessionId || typeof message.messageId !== "string" || !message.messageId.trim()
    || !["user", "assistant", "system"].includes(message.role) || typeof message.content !== "string"
    || !Number.isFinite(Date.parse(message.timestamp))) throw new Error("The source message could not be verified.");
  return { messageId: message.messageId, role: message.role, timestamp: message.timestamp,
    text: message.content.slice(0, 800), truncated: message.content.length > 800 };
}

/** Latest public stored message, not a historical approval payload or permission to act. */
export async function readInboxSourceContext(workspaceId: string, sessionId: string, signal: AbortSignal,
  isCurrent: () => boolean, owners = { status: fetchChatSessionStatus, messages: fetchChatMessages }): Promise<InboxSourceMessage | null> {
  const current = () => !signal.aborted && isCurrent();
  const assertCurrent = () => { if (!current()) throw new Error("The source selection changed."); };
  assertCurrent();
  const before = await owners.status(sessionId, signal);
  assertCurrent();
  if (!matches(before, workspaceId, sessionId)) throw new Error("The source conversation is outside this workspace.");
  const result = await owners.messages(sessionId, 1, undefined, signal);
  assertCurrent();
  if (!Array.isArray(result.items) || result.items.length > 1) throw new Error("The source message window could not be verified.");
  const message = result.items[0] ? sourceMessage(result.items[0], sessionId) : null;
  const after = await owners.status(sessionId, signal);
  assertCurrent();
  if (!matches(after, workspaceId, sessionId)) throw new Error("The source conversation scope changed during the read.");
  return message;
}
