import { useMemo } from "react";
import type { ChatSessionRecord, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { describeChannelCheck, describeChannelReply, type ChannelCheck, type ChannelReply } from "./channel-composer";
import { withoutFileInput, type FileInputProps } from "./channel-file-input";
import { latestChannelTurnAt, type ChannelConversationContext } from "./channel-conversation";
import { isChannelConversation } from "./channel-conversation-scope";
import { useMessagingOverview } from "./use-messaging-overview";

/** The part of the open conversation's loaded thread that tells when the person last wrote. */
interface ThreadTurns {
  sessionId: string;
  turns: readonly ChatThreadTurnRecord[];
}

/**
 * When the person last wrote, once the thread the surface holds is this conversation's own; before then nothing is
 * known, and the composer makes no claim about a provider's reply window (the Gateway still refuses a late send).
 */
function lastInboundOf(
  thread: ThreadTurns | null | undefined,
  channel: ChannelConversationContext,
): { lastInboundAt: string | undefined } | undefined {
  return thread?.sessionId === channel.sessionId ? { lastInboundAt: latestChannelTurnAt(thread.turns) } : undefined;
}

/**
 * The open conversation's composer props with its channel behavior added.
 *
 * - A mission chat gets its own props object back untouched, also when it is bound to a channel.
 * - A conversation whose channel context is known gets `channelReply` (ask or post) and no way to bring files in.
 *   Once its thread is loaded, `channelReply` also carries when the person last wrote, for WhatsApp's 24-hour window.
 * - A channel conversation (`isChannelConversation`), before that context is known, gets `channelCheck`: neutral,
 *   without model or file tools, and not sendable. The session record alone says it is one, so the composer never
 *   falls back to the mission composer while the Messaging overview loads, fails, or lacks it.
 *
 * The merged object stays the same until the props, the channel context or the check change (the context is kept
 * stable by its own hook).
 */
export function useChannelComposerProps<T extends FileInputProps & { thread?: ThreadTurns | null }>(
  active: T | null,
  channel: ChannelConversationContext | undefined,
  workspaceId: string,
  session: Pick<ChatSessionRecord, "scope" | "channelConnectionId"> | undefined,
): (T & { channelReply?: ChannelReply; channelCheck?: ChannelCheck }) | null {
  const heldByChannel = isChannelConversation(session);
  // The same query the channel context hook reads, so no second request.
  const overview = useMessagingOverview(workspaceId, { enabled: heldByChannel });
  const check = describeChannelCheck({
    heldByChannel,
    resolved: channel !== undefined,
    overviewReady: overview.data !== undefined || overview.isError,
  });
  return useMemo(() => {
    if (!active) return null;
    const channelReply = describeChannelReply(channel, channel ? lastInboundOf(active.thread, channel) : undefined);
    if (channelReply) return { ...withoutFileInput(active), channelReply };
    if (check) return { ...withoutFileInput(active), channelCheck: check };
    return active;
  }, [active, channel, check]);
}
