import type {
  ChatMessageSourceAuthority,
  ChatMessagingChannelStatus,
  ChatMessagingOverview,
  ChatThreadTurnRecord,
} from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";

/**
 * What Chat knows about an open conversation that is held through a channel: which channel, who it is with, and
 * where the operator last read to. It comes from the Gateway's Messaging overview, never from the session itself.
 */
export interface ChannelConversationContext {
  sessionId: string;
  connectionId: string;
  channelLabel: string;
  title: string;
  kind: "direct" | "group";
  /** The operator's own conversation with the channel's bot. */
  own: boolean;
  status: ChatMessagingChannelStatus;
  lastReadAt?: string;
}

/** The channel context for a session, or nothing when no channel in the overview holds it (a mission chat). */
export function describeChannelConversation(
  sessionId: string,
  overview: ChatMessagingOverview | undefined,
): ChannelConversationContext | undefined {
  for (const channel of overview?.channels ?? []) {
    const conversation = channel.conversations.find((item) => item.sessionId === sessionId);
    if (!conversation) continue;
    return {
      sessionId,
      connectionId: channel.connectionId,
      channelLabel: channel.label,
      title: conversation.title,
      kind: conversation.kind,
      own: conversation.own,
      status: channel.status,
      ...(conversation.lastReadAt ? { lastReadAt: conversation.lastReadAt } : {}),
    };
  }
  return undefined;
}

/** How a message in a channel conversation names where it came from: the visible label and the reader's heading. */
export interface ChannelMessageSource {
  label: string;
  heading: string;
}

/**
 * Names the source of a message the operator or someone else wrote in a channel conversation. The assistant's
 * replies and system notices say nothing here, so they return null.
 */
export function describeChannelMessageSource(
  channel: ChannelConversationContext,
  authority: ChatMessageSourceAuthority | undefined,
): ChannelMessageSource | null {
  if (authority === "operator") return { label: "You · from your desk", heading: "You said from your desk" };
  if (authority !== "external_channel") return null;
  const via = `via ${channel.channelLabel}`;
  if (channel.own) return { label: `You · ${via}`, heading: `You said ${via}` };
  // Someone else's direct conversation is named by the person; a group message does not say who wrote it.
  if (channel.kind === "direct") return { label: `${channel.title} · ${via}`, heading: `${channel.title} said ${via}` };
  return { label: via, heading: `Message ${via}` };
}

function momentOf(timestamp: string): number {
  return Date.parse(timestamp);
}

/** Whether `candidate` is a later moment than `reference`; a missing reference is before everything. */
export function isNewerThan(candidate: string, reference: string | undefined): boolean {
  const moment = momentOf(candidate);
  if (Number.isNaN(moment)) return false;
  if (reference === undefined) return true;
  const referenceMoment = momentOf(reference);
  return Number.isNaN(referenceMoment) || moment > referenceMoment;
}

/** The latest time any message of these turns was written, on either side. */
export function newestMessageTimestamp(turns: readonly ChatThreadTurnRecord[]): string | undefined {
  let newest: string | undefined;
  for (const turn of turns) {
    for (const message of [turn.userMessage, turn.assistantMessage]) {
      const timestamp = message?.timestamp;
      if (timestamp && isNewerThan(timestamp, newest)) newest = timestamp;
    }
  }
  return newest;
}

export interface NewChannelMessages {
  /** The turn whose message is the first one newer than the read marker. */
  turnId: string;
  /** How many messages people sent through the channel since the read marker. */
  count: number;
}

/**
 * Where the unread part of a channel conversation starts. Only messages that arrived through the channel count, as
 * in the Messaging list. With no read marker there is no known place to stop, so nothing is marked.
 */
export function findNewChannelMessages(
  turns: readonly ChatThreadTurnRecord[],
  lastReadAt: string | undefined,
): NewChannelMessages | undefined {
  if (lastReadAt === undefined) return undefined;
  const fresh = turns.filter(
    (turn) =>
      turn.userMessage.sourceAuthority === "external_channel" && isNewerThan(turn.userMessage.timestamp, lastReadAt),
  );
  const first = fresh[0];
  return first ? { turnId: first.turnId, count: fresh.length } : undefined;
}

/** The divider's words; the count reads like every other count in the cockpit. */
export function newMessagesDividerText(count: number): string {
  return `${plural(count, "new", "new")} since you were last here`;
}
