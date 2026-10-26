/**
 * The ordering lane of one channel conversation.
 *
 * The inbound worker claims an event only once every earlier unsettled event in its lane has settled, and it processes
 * claims from different lanes concurrently. Every event about one conversation, from the channel or from the desk,
 * must therefore carry the same lane, or a later message can be answered before an earlier one is recorded.
 */
export interface InboundConversationLaneInput {
  channel: string;
  connectionId: string;
  bindingTarget?: string;
  message: { account: string; peer?: string; room?: string; threadId?: string };
}

/** `channel:connection:conversation[:thread]`, with the room or else the peer naming the conversation. */
export function buildInboundConversationLaneKey(input: InboundConversationLaneInput): string {
  const conversation = input.message.room ?? input.message.peer ?? input.bindingTarget ?? input.message.account;
  return [input.channel, input.connectionId, conversation, input.message.threadId]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim())
    .join(":");
}
