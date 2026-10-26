import { useMemo } from "react";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { describeChannelCheck, describeChannelReply, type ChannelCheck, type ChannelReply } from "./channel-composer";
import { withoutFileInput, type FileInputProps } from "./channel-file-input";
import type { ChannelConversationContext } from "./channel-conversation";
import { useMessagingOverview } from "./use-messaging-overview";

/**
 * The open conversation's composer props with its channel behavior added.
 *
 * - A mission chat gets its own props object back untouched.
 * - A conversation whose channel context is known gets `channelReply` (ask or post) and no way to bring files in.
 * - A conversation the session says a channel holds, before that context is known, gets `channelCheck`: neutral,
 *   without model or file tools, and not sendable. The session's own `channelConnectionId` says it is one, so the
 *   composer never falls back to the mission composer while the Messaging overview loads, fails, or lacks it.
 *
 * The merged object stays the same until the props, the channel context or the check change (the context is kept
 * stable by its own hook).
 */
export function useChannelComposerProps<T extends FileInputProps>(
  active: T | null,
  channel: ChannelConversationContext | undefined,
  workspaceId: string,
  session: Pick<ChatSessionRecord, "channelConnectionId"> | undefined,
): (T & { channelReply?: ChannelReply; channelCheck?: ChannelCheck }) | null {
  const heldByChannel = Boolean(session?.channelConnectionId);
  // The same query the channel context hook reads, so no second request.
  const overview = useMessagingOverview(workspaceId, { enabled: heldByChannel });
  const check = describeChannelCheck({
    heldByChannel,
    resolved: channel !== undefined,
    overviewReady: overview.data !== undefined || overview.isError,
  });
  return useMemo(() => {
    if (!active) return null;
    const channelReply = describeChannelReply(channel);
    if (channelReply) return { ...withoutFileInput(active), channelReply };
    if (check) return { ...withoutFileInput(active), channelCheck: check };
    return active;
  }, [active, channel, check]);
}
