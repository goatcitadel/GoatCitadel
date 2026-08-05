/**
 * Side-chat (/btw) system-instruction builders for chat turn preparation.
 *
 * Composes the lightweight parent-thread context that grounds a /btw side chat.
 * Extracted verbatim from chat-turn-prep-service.ts to keep that module under the
 * max-lines budget; behavior is unchanged.
 */

import type { ChatSendMessageRequest } from "@goatcitadel/contracts";
import { buildSelectedPathTurnIds } from "./chat-thread-utils.js";
import type { ChatTurnPrepHost, ChatTurnSessionState } from "./chat-turn-prep-service.js";

export async function buildSideChatSystemInstruction(
  host: ChatTurnPrepHost,
  childSessionId: string,
  context: NonNullable<ChatSendMessageRequest["sideChatContext"]>,
): Promise<string> {
  const parentSessionId = context.parentSessionId.trim();
  if (!parentSessionId || parentSessionId === childSessionId) {
    throw new Error("Invalid side chat parent session.");
  }
  const relation = await host.storage.chatSideChats.getByChildSession(childSessionId);
  if (!relation || relation.parentSessionId !== parentSessionId) {
    throw new Error("Side chat context does not match this child session.");
  }
  const childMeta = await host.storage.chatSessionMeta.ensure(childSessionId);
  const parentMeta = await host.storage.chatSessionMeta.ensure(parentSessionId);
  if (host.normalizeWorkspaceId(childMeta.workspaceId) !== host.normalizeWorkspaceId(parentMeta.workspaceId)) {
    throw new Error("Side chat parent workspace does not match child session workspace.");
  }
  const parentState = await host.loadChatTurnSessionState(parentSessionId);
  const selectedTurnId =
    context.selectedTurnId && parentState.tracesById.has(context.selectedTurnId)
      ? context.selectedTurnId
      : parentState.activeLeafTurnId;
  const pathTurnIds = selectedTurnId ? buildSelectedPathTurnIds(parentState.turnLineageById, selectedTurnId) : [];
  const recentTurnLimit = Math.max(1, Math.min(12, Math.floor(context.recentTurnLimit ?? 6)));
  const recentTurnIds = pathTurnIds.slice(-recentTurnLimit);
  const excerpts = recentTurnIds
    .map((turnId, index) => renderSideChatParentTurnExcerpt(parentState, turnId, index + 1))
    .filter(Boolean);
  return [
    "You are answering in a GoatCitadel /btw side chat.",
    "Treat this as a lightweight aside about the parent thread. Do not claim that your messages were added to the parent transcript.",
    `Parent session: ${parentSessionId}`,
    `Origin surface: ${context.originSurface}`,
    selectedTurnId ? `Selected parent turn: ${selectedTurnId}` : "Selected parent turn: none",
    excerpts.length > 0 ? "Recent parent-thread context:" : "Recent parent-thread context: none available yet.",
    ...excerpts,
  ].join("\n");
}

function renderSideChatParentTurnExcerpt(state: ChatTurnSessionState, turnId: string, index: number): string | null {
  const trace = state.tracesById.get(turnId);
  if (!trace) {
    return null;
  }
  const user = state.messagesById.get(trace.userMessageId);
  const assistant = trace.assistantMessageId ? state.messagesById.get(trace.assistantMessageId) : undefined;
  const lines = [`[Parent turn ${index}: ${turnId}]`];
  if (user?.content.trim()) {
    lines.push(`User: ${truncateSideChatContextText(user.content, 900)}`);
  }
  if (assistant?.content.trim()) {
    lines.push(`Assistant: ${truncateSideChatContextText(assistant.content, 1_200)}`);
  }
  return lines.join("\n");
}

function truncateSideChatContextText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
