/**
 * The reply window some channels' providers enforce. WhatsApp allows a free-form reply only within 24 hours of the
 * person's last message (each new message of theirs starts it again); Meta refuses a later one. The Gateway refuses
 * the send before it reaches Meta, and Chat tells the operator why the composer is off, both from this one rule.
 */

/** WhatsApp's free-form reply window: 24 hours from the person's last message. */
export const WHATSAPP_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What the operator is told when the window has closed. Their next message reopens it. */
export const WHATSAPP_REPLY_WINDOW_CLOSED =
  "WhatsApp allows a reply only within 24 hours of their last message. Once they message again, you can reply.";

/**
 * Whether a reply in this channel's conversation is outside the provider's window. Only WhatsApp has one. A WhatsApp
 * conversation with no readable last message from the person has nothing to reply to, so its window is closed. The
 * window closes at exactly 24 hours.
 */
export function isChannelReplyWindowClosed(
  channelKey: string | undefined,
  lastInboundAt: string | undefined,
  now: Date,
): boolean {
  if (channelKey !== "whatsapp") {
    return false;
  }
  const lastInboundMoment = lastInboundAt ? Date.parse(lastInboundAt) : Number.NaN;
  if (Number.isNaN(lastInboundMoment)) {
    return true;
  }
  return now.getTime() - lastInboundMoment >= WHATSAPP_REPLY_WINDOW_MS;
}
