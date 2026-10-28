import type { ChannelAttachmentInput, ChannelSendInput } from "@goatcitadel/contracts";

export interface ChannelReplyDeliveryDetails {
  /** The assistant's answer, already trimmed. */
  assistantContent: string;
  /** Delivered ahead of the answer, such as the quoted desk question. */
  deliveryPrefix?: string;
  /** The synthesized voice reply, sent with the text on the attachment lane. */
  voiceReplyAttachment?: ChannelAttachmentInput;
  /** The provider message to reply to, when the channel gave one. */
  replyToMessageId?: string;
  /** The inbound message to fall back to when the channel gave no provider message id. */
  fallbackMessageId: string;
  /** An operator-authored message never reached the channel, so there is no channel message to reply to. */
  operatorAuthored: boolean;
  idempotencyKey?: string;
}

/**
 * The channel send for the assistant's reply to an inbound channel message. Pure: plain values in, the send input
 * out. The caller sends it as GoatCitadel's own delivery, so a switched-off Messaging group does not stop it.
 */
export function buildChannelReplyDeliveryInput(
  connectionId: string,
  target: string,
  sessionId: string,
  reply: ChannelReplyDeliveryDetails,
): ChannelSendInput & { idempotencyKey?: string } {
  const { assistantContent, deliveryPrefix, voiceReplyAttachment } = reply;
  return {
    connectionId,
    target,
    message: deliveryPrefix ? `${deliveryPrefix}${assistantContent}` : assistantContent,
    attachments: voiceReplyAttachment ? [voiceReplyAttachment] : undefined,
    replyToMessageId: reply.replyToMessageId?.trim() || (reply.operatorAuthored ? undefined : reply.fallbackMessageId),
    sessionId,
    agentId: "assistant",
    ...(reply.idempotencyKey !== undefined ? { idempotencyKey: reply.idempotencyKey } : {}),
  };
}
