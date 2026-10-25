// ---------------------------------------------------------------------------
// Messaging read model
// ---------------------------------------------------------------------------
//
// The Messaging area of Chat lists conversations people hold with the operator
// through a connected channel (Telegram, Slack, ...), grouped by the channel
// connection that carries them. The gateway builds this view; clients never
// derive channel status, conversation titles or unread counts themselves.

/**
 * `on` the connection is enabled and connected. `off` it is disabled, paused or
 * disconnected. `needs_attention` it is enabled but reports an error. `removed`
 * the connection no longer exists; its conversations are kept for reference.
 */
export type ChatMessagingChannelStatus = "on" | "off" | "needs_attention" | "removed";

export interface ChatMessagingConversation {
  sessionId: string;
  /** Always a readable name: the conversation's own title, the session title, or a generic label. */
  title: string;
  kind: "direct" | "group";
  /** True for the direct conversation with the operator's own account on this channel. */
  own: boolean;
  lastActivityAt: string;
  /** When this operator last read the conversation. Left out until they have, or without an operator identity. */
  lastReadAt?: string;
  /** Messages people sent since `lastReadAt`. Left out (not zero) without an operator identity. */
  newMessageCount?: number;
}

export interface ChatMessagingChannel {
  connectionId: string;
  channelKey: string;
  label: string;
  status: ChatMessagingChannelStatus;
  /** Newest first. Empty for a connected channel nobody has written to yet. */
  conversations: ChatMessagingConversation[];
}

export interface ChatMessagingOverview {
  workspaceId: string;
  channels: ChatMessagingChannel[];
}

export interface ChatSessionReadRequest {
  /** ISO 8601 timestamp: everything up to it counts as read. */
  readThrough: string;
}

export interface ChatSessionReadResponse {
  sessionId: string;
  /** The read marker after the request. Never earlier than the marker before it. */
  lastReadAt: string;
}
