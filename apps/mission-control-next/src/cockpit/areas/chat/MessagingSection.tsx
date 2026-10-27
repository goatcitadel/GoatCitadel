import { Plus } from "lucide-react";
import type { ChatMessagingChannel, ChatMessagingConversation } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { presentChannelStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { channelPickerHref } from "../../app/routes";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { StatusBadge } from "../../ui/StatusBadge";
import { TimeText } from "../../ui/TimeText";
import { useMessagingOverview } from "./use-messaging-overview";

const ADD_CHANNEL_HREF = channelPickerHref();
const MAX_VISIBLE_COUNT = 99;
/** Rows are 44px targets in the phone sheet and compact in the desktop rail, which shows from the md breakpoint. */
const ROW_TARGET = "min-h-11 md:min-h-0";

/** "+ Add" reads as "Add a channel": the name starts with the visible text, and the icon is decoration. */
function AddChannelLink({ workspaceId }: { workspaceId: string }) {
  return (
    <NativeOwnerLink
      href={ADD_CHANNEL_HREF}
      scope={workspaceId}
      aria-label="Add a channel"
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${ROW_TARGET}`}
    >
      <Plus aria-hidden="true" className="size-3" />
      Add
    </NativeOwnerLink>
  );
}

/**
 * The number of new messages, shown only when the Gateway knows it. A missing count is not zero, and a known zero
 * has nothing to flag. Above 99 the badge reads "99+" and assistive technology hears the full phrase.
 */
function NewMessageCount({ count }: { count: number | undefined }) {
  if (count === undefined || count <= 0) return null;
  const capped = count > MAX_VISIBLE_COUNT;
  return (
    <span className="shrink-0 rounded-full bg-accent px-1.5 text-xs font-medium text-accent-ink">
      <span aria-hidden="true">{capped ? `${MAX_VISIBLE_COUNT}+` : count.toLocaleString()}</span>
      <span className="sr-only">
        {capped ? `More than ${MAX_VISIBLE_COUNT} new messages` : plural(count, "new message")}
      </span>
    </span>
  );
}

function ConversationRow({
  conversation,
  selected,
  onSelect,
}: {
  conversation: ChatMessagingConversation;
  selected: boolean;
  onSelect: (sessionId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(conversation.sessionId)}
        aria-current={selected ? "page" : undefined}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sunken aria-[current=page]:bg-sunken ${ROW_TARGET}`}
      >
        <span className="min-w-0 flex-1">
          {/* The operator's own conversation with the bot reads "You", whatever their name on the channel. */}
          <span className="block min-w-0 truncate text-sm text-fg">
            {conversation.own ? "You" : conversation.title}
          </span>
          <TimeText value={conversation.lastActivityAt} className="text-xs text-fg-muted" />
        </span>
        <NewMessageCount count={conversation.newMessageCount} />
      </button>
    </li>
  );
}

function ChannelItem({
  channel,
  selectedSessionId,
  onSelectSession,
  onOpenChannel,
}: {
  channel: ChatMessagingChannel;
  selectedSessionId: string | undefined;
  onSelectSession: (sessionId: string) => void;
  onOpenChannel: (connectionId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenChannel(channel.connectionId)}
        className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sunken ${ROW_TARGET}`}
      >
        <span className="min-w-0 truncate text-sm font-medium text-fg">{channel.label}</span>
        <StatusBadge status={presentChannelStatus(channel.status)} className="shrink-0" />
      </button>
      {channel.conversations.length ? (
        <ul className="pl-3">
          {channel.conversations.map((conversation) => (
            <ConversationRow
              key={conversation.sessionId}
              conversation={conversation}
              selected={conversation.sessionId === selectedSessionId}
              onSelect={onSelectSession}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Chat's Messaging area: the channels connected to this workspace, with the conversations people hold through each
 * one indented under it. The Gateway builds the overview, so status, titles and new-message counts are shown as
 * given. Loading and failure are plain text rather than live regions: this area refreshes on its own.
 */
export function MessagingSection({
  workspaceId,
  selectedSessionId,
  onSelectSession,
  onOpenChannel,
}: {
  workspaceId: string;
  selectedSessionId?: string;
  onSelectSession: (sessionId: string) => void;
  onOpenChannel: (connectionId: string) => void;
}) {
  const overview = useMessagingOverview(workspaceId);
  const channels = overview.data?.channels;
  return (
    <section>
      <div className="flex items-center justify-between gap-2 px-2 py-1">
        <h2 className="text-sm font-semibold text-fg">Messaging</h2>
        <AddChannelLink workspaceId={workspaceId} />
      </div>
      {channels?.length ? (
        <ul>
          {channels.map((channel) => (
            <ChannelItem
              key={channel.connectionId}
              channel={channel}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              onOpenChannel={onOpenChannel}
            />
          ))}
        </ul>
      ) : channels ? (
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <p className="text-xs text-fg-muted">No channels yet</p>
          <AddChannelLink workspaceId={workspaceId} />
        </div>
      ) : overview.isError ? (
        <div className="px-2 py-1 text-xs text-fg-muted">
          <p>Couldn't load your channels.</p>
          <button
            type="button"
            onClick={() => void overview.refetch()}
            className={`font-medium text-accent hover:underline ${ROW_TARGET}`}
          >
            Try again
          </button>
        </div>
      ) : (
        <p className="px-2 py-1 text-xs text-fg-muted">Loading channels…</p>
      )}
    </section>
  );
}
