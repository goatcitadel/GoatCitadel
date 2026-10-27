import { useQuery } from "@tanstack/react-query";
import { fetchIntegrationConnections } from "@goatcitadel/mission-control-shared/api/client";

/** The connection list Settings reads too (same key), so a change to a connection refreshes every page showing it. */
export const CONNECTIONS_QUERY_KEY = ["settings", "integration-connections"] as const;

/** The connection list, shared with Settings. */
function useChannelConnections() {
  return useQuery({ queryKey: CONNECTIONS_QUERY_KEY, queryFn: () => fetchIntegrationConnections() });
}

/** One channel connection from that list, with the list's own loading and failure state beside it. */
export function useChannelConnection(connectionId: string) {
  const connections = useChannelConnections();
  const connection = connections.data?.items.find(
    (item) => item.connectionId === connectionId && item.kind === "channel",
  );
  return { connection, connections };
}
