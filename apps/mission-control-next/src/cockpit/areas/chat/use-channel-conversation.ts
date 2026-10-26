import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatSessionRecord, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { markChatSessionRead } from "@goatcitadel/mission-control-shared/api/chat";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { queryKeys } from "../../data/query-keys";
import {
  describeChannelConversation,
  findNewChannelMessages,
  isNewerThan,
  newestMessageTimestamp,
  type ChannelConversationContext,
  type NewChannelMessages,
} from "./channel-conversation";
import { useMessagingOverview } from "./use-messaging-overview";

function sameContext(left: ChannelConversationContext | undefined, right: ChannelConversationContext | undefined) {
  if (!left || !right) return left === right;
  return (
    left.sessionId === right.sessionId &&
    left.connectionId === right.connectionId &&
    left.channelLabel === right.channelLabel &&
    left.title === right.title &&
    left.kind === right.kind &&
    left.own === right.own &&
    left.status === right.status &&
    left.lastReadAt === right.lastReadAt
  );
}

/**
 * The open conversation's channel context, or nothing for a mission chat. The Messaging overview is read only for a
 * conversation a channel carries (the sidebar usually loaded it already, and both share one query); an overview that
 * is already cached is used either way. The same object comes back until something it describes changes, so a
 * refetch about another conversation does not re-render the transcript.
 */
export function useSelectedChannelConversation(
  workspaceId: string,
  session: Pick<ChatSessionRecord, "channelConnectionId"> | undefined,
  selectedSessionId: string | undefined,
): ChannelConversationContext | undefined {
  const overview = useMessagingOverview(workspaceId, { enabled: Boolean(session?.channelConnectionId) });
  const described = useMemo(
    () => (selectedSessionId ? describeChannelConversation(selectedSessionId, overview.data) : undefined),
    [selectedSessionId, overview.data],
  );
  const stable = useRef(described);
  if (!sameContext(stable.current, described)) stable.current = described;
  return stable.current;
}

/**
 * Reading a channel conversation: where this visit's new messages start, and telling the Gateway the conversation
 * was read.
 *
 * - The "new since you were last here" marker uses the read time the conversation had when it was opened. Marking it
 *   read moves the overview's read time, but the divider has to keep saying where this visit began.
 * - A conversation that is shown with a message newer than its read time is marked read through that message, once
 *   per newest message. A failed request is not the reader's concern: the API client records it, nothing is shown
 *   and nothing is retried until a newer message arrives.
 */
export function useChannelReading(
  channel: ChannelConversationContext | undefined,
  /** The selected path's turns of the open conversation. */
  turns: readonly ChatThreadTurnRecord[],
  active: Pick<
    MissionThreadedActiveSessionSurfaceProps,
    "thread" | "workspaceId" | "historicalWindow" | "historicalWindowLoading" | "historicalWindowError"
  >,
): NewChannelMessages | undefined {
  const queryClient = useQueryClient();
  const visit = useRef<{ sessionId: string; lastReadAt: string | undefined } | null>(null);
  if (!channel) visit.current = null;
  else if (visit.current?.sessionId !== channel.sessionId)
    visit.current = { sessionId: channel.sessionId, lastReadAt: channel.lastReadAt };
  const workspaceId = active.workspaceId;
  // The turns are this conversation's only once its thread has loaded, and the latest ones are in view only while
  // no search result's surrounding history is open in their place.
  const viewingHistory = Boolean(
    active.historicalWindow || active.historicalWindowLoading || active.historicalWindowError,
  );
  const ready = Boolean(channel) && active.thread?.sessionId === channel?.sessionId && !viewingHistory;
  const visitStart = visit.current?.lastReadAt;
  const fresh = useMemo(
    () => (ready ? findNewChannelMessages(turns, visitStart) : undefined),
    [ready, turns, visitStart],
  );
  const newest = useMemo(() => (ready ? newestMessageTimestamp(turns) : undefined), [ready, turns]);
  const asked = useRef(new Set<string>());
  const sessionId = channel?.sessionId;
  const lastReadAt = channel?.lastReadAt;
  useEffect(() => {
    if (!sessionId || !newest || !isNewerThan(newest, lastReadAt)) return;
    const key = `${sessionId}\n${newest}`;
    if (asked.current.has(key)) return;
    asked.current.add(key);
    markChatSessionRead(sessionId, newest).then(
      () => void queryClient.invalidateQueries({ queryKey: queryKeys.chatMessaging(workspaceId) }),
      () => {
        /* Non-fatal, and already recorded: the API client logs every failed request as a diagnostic, with its
           status (409 without an operator identity). The reader sees nothing; the count may stay until next time. */
      },
    );
  }, [sessionId, lastReadAt, newest, workspaceId, queryClient]);
  return fresh;
}
