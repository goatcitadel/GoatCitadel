import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  describeRetiredChannel,
  type ChannelRuntimeStatus,
  type DiscordPairingRecord,
  type TelegramChannelPairingList,
} from "@goatcitadel/contracts";
import { fetchChannelRuntimeStatus, fetchDiscordPairings } from "@goatcitadel/mission-control-shared/api/client";
import { fetchTelegramChannelPairings } from "@goatcitadel/mission-control-shared/api/channel-setup-operations";
import { queryKeys } from "../../data/query-keys";
import { approvedSenders, pendingRequests, type ApprovedSender, type PendingRequest } from "./channel-page-model";
import { useChannelConnection } from "./use-channel-connections";
import { useMessagingOverview } from "./use-messaging-overview";

/**
 * Everything one channel page reads. The connection list shares the Settings query (same key), so a connection
 * change refreshes both; the overview is the Gateway's own account of the channel's status; the runtime check and
 * the approved senders are read only for a connection that exists.
 */
export function useChannelPageData(connectionId: string, workspaceId: string) {
  const { connection, connections } = useChannelConnection(connectionId);
  const overview = useMessagingOverview(workspaceId);
  const channel = overview.data?.channels.find((item) => item.connectionId === connectionId);
  const present = Boolean(connection);
  // A retired channel's connection is out of service for good, so there is nothing to check.
  const retired = connection ? describeRetiredChannel(connection.key) : undefined;
  const runtime = useQuery({
    queryKey: queryKeys.chatChannelRuntime(connectionId),
    queryFn: (): Promise<ChannelRuntimeStatus> => fetchChannelRuntimeStatus(connectionId),
    enabled: present && !retired,
  });
  const key = connection?.key;
  const senderRecords = useQuery({
    queryKey: queryKeys.chatChannelSenders(connectionId, connection?.revision),
    queryFn: async (): Promise<{ telegram?: TelegramChannelPairingList; discord?: DiscordPairingRecord[] }> => {
      if (key === "telegram") return { telegram: await fetchTelegramChannelPairings(connectionId) };
      if (key === "discord") return { discord: (await fetchDiscordPairings(connectionId)).items };
      return {};
    },
    enabled: present && (key === "telegram" || key === "discord"),
  });
  const pairings = senderRecords.data ?? {};
  const approved: ApprovedSender[] = connection ? approvedSenders(connection, pairings) : [];
  const pending: PendingRequest[] = connection ? pendingRequests(connection, pairings) : [];
  // Telegram says itself when anyone may message the bot, so approving a person does not close it.
  const openAccess = pairings.telegram?.inboundAccessMode === "open_legacy";
  const queryClient = useQueryClient();
  /** Reads the connection list and every Messaging read again; a read that is switched off stays off. */
  const reload = async () => {
    await Promise.all([
      connections.refetch(),
      queryClient.invalidateQueries({ queryKey: queryKeys.chatMessagingAll() }),
    ]);
  };
  return { connections, overview, connection, channel, runtime, senderRecords, approved, pending, openAccess, reload };
}
