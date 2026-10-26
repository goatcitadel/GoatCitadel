import { useMemo } from "react";
import { describeChannelReply, type ChannelReply } from "./channel-composer";
import type { ChannelConversationContext } from "./channel-conversation";

/**
 * The open conversation's composer props with its channel behavior added. A mission chat gets its own props object
 * back untouched; a channel conversation gets one merged object that stays the same until the props or the channel
 * context change (the context is kept stable by its own hook).
 */
export function useChannelComposerProps<T extends object>(
  active: T | null,
  channel: ChannelConversationContext | undefined,
): (T & { channelReply?: ChannelReply }) | null {
  return useMemo(() => {
    const channelReply = describeChannelReply(channel);
    return active && channelReply ? { ...active, channelReply } : active;
  }, [active, channel]);
}
