import type { ChatChannelConversation, ChatSessionBindingRecord, SessionMeta } from "@goatcitadel/contracts";
import { resolveChannelConnectionId } from "./chat-session-utils.js";

/** What a retry or an edit is refused with in a channel conversation. */
export const CHANNEL_CONVERSATION_RESEND_REFUSED =
  "Retry and edit aren't available in channel conversations. Ask again instead.";

/**
 * A Messaging conversation: a session that came from outside (its channel is not "mission") and is held through an
 * integration binding to a channel connection. A mission chat bound to a channel is not one; it stays an ordinary
 * chat that also posts through its binding.
 */
export function isChannelConversationSession(
  session: Pick<SessionMeta, "channel"> | undefined,
  binding: Pick<ChatSessionBindingRecord, "transport" | "connectionId"> | undefined,
): boolean {
  return session !== undefined && session.channel !== "mission" && resolveChannelConnectionId(binding) !== undefined;
}

/**
 * Builds the direct-or-group details a channel binding remembers. Blank values
 * are left out, and only a direct conversation carries the other person's id.
 */
export function buildChannelConversation(input: {
  kind: ChatChannelConversation["kind"];
  counterpartActorId?: string | null;
  title?: string | null;
}): ChatChannelConversation {
  const counterpartActorId = input.kind === "direct" ? input.counterpartActorId?.trim() : undefined;
  const title = input.title?.trim();
  return {
    kind: input.kind,
    ...(counterpartActorId ? { counterpartActorId } : {}),
    ...(title ? { title } : {}),
  };
}

/** Reads conversation details from untrusted JSON; anything off-contract yields undefined. */
export function readChannelConversation(value: unknown): ChatChannelConversation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "direct" && record.kind !== "group") {
    return undefined;
  }
  return buildChannelConversation({
    kind: record.kind,
    counterpartActorId: typeof record.counterpartActorId === "string" ? record.counterpartActorId : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
  });
}
