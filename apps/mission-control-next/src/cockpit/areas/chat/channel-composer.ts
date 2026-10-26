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

/**
 * A conversation the session says a channel holds, before its channel is known: the Messaging overview is still
 * loading (`checking`), failed, or does not list the conversation (`unavailable`). The composer is neutral and cannot
 * send until the context resolves, rather than falling back to the mission composer and its model and file tools.
 */
export type ChannelCheck = "checking" | "unavailable";

/** Why a channel conversation cannot be replied to. Only a removed or switched-off channel blocks. */
export type ChannelReplyBlock = { kind: "channel-removed"; message: string } | { kind: "channel-off"; message: string };

export type ChannelCheckBlock =
  | { kind: "channel-checking"; message: string }
  | { kind: "channel-unavailable"; message: string };

const DEFAULT_PLACEHOLDER = "Message GoatCitadel…";
const CHECKING_MESSAGE = "Checking this channel…";
const UNAVAILABLE_MESSAGE = "Couldn't check this channel. Try again from Messaging.";
const FILES_MESSAGE = "Files aren't sent in channel conversations. Remove them to send.";

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

/**
 * Whether the channel is still unresolved for a conversation a channel holds. Once the context is known there is
 * nothing to check; before it is, the overview either has not answered yet or cannot say where the conversation is.
 */
export function describeChannelCheck(input: {
  heldByChannel: boolean;
  resolved: boolean;
  overviewReady: boolean;
}): ChannelCheck | undefined {
  if (!input.heldByChannel || input.resolved) return undefined;
  return input.overviewReady ? "unavailable" : "checking";
}

/**
 * What the draft says before anything is typed. An unresolved channel says why it cannot be used yet, and a removed or
 * switched-off one says why it cannot take a reply, instead of promising where the message would go.
 */
export function channelReplyPlaceholder(reply: ChannelReply | undefined, check?: ChannelCheck): string {
  if (check) return check === "checking" ? CHECKING_MESSAGE : UNAVAILABLE_MESSAGE;
  if (!reply) return DEFAULT_PLACEHOLDER;
  const block = channelReplyBlock(reply);
  if (block) return block.message;
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

/** An unresolved channel cannot send: it is not known where the message would go. */
export function channelCheckBlock(check: ChannelCheck | undefined): ChannelCheckBlock | null {
  if (check === "checking") return { kind: "channel-checking", message: CHECKING_MESSAGE };
  if (check === "unavailable") return { kind: "channel-unavailable", message: UNAVAILABLE_MESSAGE };
  return null;
}

/**
 * A channel conversation takes no files: the composer ignores drops and pastes, but a file can still arrive from the
 * command palette. It stays visible as a chip so it can be removed, and nothing sends while one is attached.
 */
export function channelFilesBlock(
  reply: ChannelReply | undefined,
  attachedFiles: number,
): { kind: "blocked"; message: string } | null {
  return reply && attachedFiles > 0 ? { kind: "blocked", message: FILES_MESSAGE } : null;
}
