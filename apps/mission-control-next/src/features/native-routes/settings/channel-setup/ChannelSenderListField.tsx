import type { ComponentProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchChannelDroppedSenders } from "@goatcitadel/mission-control-shared/api/client";
import { WithQueryClient } from "./ChannelWebhookAddress";
import { ChannelStructuredField } from "./ChannelStructuredField";

/** How often an open sender step looks again for a sender the bot turned away. */
const DROPPED_SENDERS_REFETCH_MS = 15_000;

type SenderListFieldProps = Omit<
  ComponentProps<typeof ChannelStructuredField>,
  "droppedSenders" | "droppedSendersUnread"
> & {
  connectionId: string;
};

/**
 * The sender list of a saved connection's setup, with the senders that connection turned away lately offered beside
 * it. A draft that is not tied to a connection has no such list, so it uses the plain field. Reading the list is
 * optional help: while it loads nothing extra is shown, and when it cannot be read the field says so.
 * The Classic shell has no query client, so the read gets its own there.
 */
export function ChannelSenderListField(props: SenderListFieldProps) {
  return (
    <WithQueryClient>
      <SenderListWithTurnedAway {...props} />
    </WithQueryClient>
  );
}

function SenderListWithTurnedAway({ connectionId, ...field }: SenderListFieldProps) {
  const query = useQuery({
    queryKey: ["settings", "channel-dropped-senders", connectionId],
    queryFn: () => fetchChannelDroppedSenders(connectionId),
    refetchInterval: DROPPED_SENDERS_REFETCH_MS,
  });
  return <ChannelStructuredField {...field} droppedSenders={query.data?.items} droppedSendersUnread={query.isError} />;
}
