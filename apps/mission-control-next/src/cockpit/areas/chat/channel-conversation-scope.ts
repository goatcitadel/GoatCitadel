import { createContext, useContext } from "react";
import type { ChatSessionRecord } from "@goatcitadel/contracts";

/**
 * Whether a session is a Messaging conversation: one that came from outside (external scope) and is held through a
 * channel connection. A mission chat bound to a channel through the context dock is not one: it stays an ordinary
 * chat that also posts through its binding, so it keeps its composer, tools, Retry, Edit and Continue.
 *
 * This is the one rule the cockpit uses to decide that a conversation is a channel conversation. It needs only the
 * session record, so nothing waits for the Messaging overview to load.
 */
export function isChannelConversation(
  session: Pick<ChatSessionRecord, "scope" | "channelConnectionId"> | undefined,
): boolean {
  return session?.scope === "external" && Boolean(session.channelConnectionId);
}

/** Set around the open conversation's column when it is a channel conversation; false everywhere else. */
export const ChannelConversationScope = createContext(false);

/** True inside a channel conversation's column, whether or not the Messaging overview has loaded. */
export function useInChannelConversation(): boolean {
  return useContext(ChannelConversationScope);
}
