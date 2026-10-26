import type { ChatMessagingChannelStatus } from "@goatcitadel/contracts";
import type { ChannelConversationContext } from "./channel-conversation";

/**
 * How the composer behaves in a conversation held through a channel.
 * - `ask`: the operator's own conversation with the channel's bot; a message is a question to GoatCitadel and the
 *   answer also goes to the channel.
 * - `post`: someone else's direct conversation, or a group; a message is posted there as the bot, word for word.
 */
export interface ChannelReply {
  mode: "ask" | "post";
  channelLabel: string;
  targetTitle: string;
  status: ChatMessagingChannelStatus;
}

/** Why a channel conversation cannot be replied to. Only a removed or switched-off channel blocks. */
export type ChannelReplyBlock = { kind: "channel-removed"; message: string } | { kind: "channel-off"; message: string };

const DEFAULT_PLACEHOLDER = "Message GoatCitadel…";

/** The composer's channel behavior for an open conversation, or nothing for a mission chat. */
export function describeChannelReply(channel: ChannelConversationContext | undefined): ChannelReply | undefined {
  if (!channel) return undefined;
  return {
    mode: channel.own ? "ask" : "post",
    channelLabel: channel.channelLabel,
    targetTitle: channel.title,
    status: channel.status,
  };
}

export function channelReplyPlaceholder(reply: ChannelReply | undefined): string {
  if (!reply) return DEFAULT_PLACEHOLDER;
  return reply.mode === "ask"
    ? `Ask GoatCitadel. The answer also goes to ${reply.channelLabel}.`
    : `Posts to ${reply.targetTitle} on ${reply.channelLabel} as your bot`;
}

export function channelReplySubmitLabel(reply: ChannelReply | undefined): string {
  return reply?.mode === "post" ? `Post to ${reply.targetTitle}` : "Send";
}

/**
 * A removed channel keeps its conversations readable but cannot send; an off channel can be turned back on. A channel
 * that needs attention stays sendable: the Gateway answers with its own message if it cannot deliver.
 */
export function channelReplyBlock(reply: ChannelReply | undefined): ChannelReplyBlock | null {
  if (reply?.status === "removed")
    return { kind: "channel-removed", message: "This channel was removed. Its conversations stay readable." };
  if (reply?.status === "off") return { kind: "channel-off", message: `Turn ${reply.channelLabel} back on to reply.` };
  return null;
}
