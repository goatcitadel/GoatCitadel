import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import {
  getGatewayAccessRevision,
  subscribeGatewayAccessChange,
} from "@goatcitadel/mission-control-shared/api/client-core";
import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import { fetchOperatorInbox } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import { queryKeys } from "./query-keys";

/** All cockpit Inbox consumers share one scoped, owner-authored snapshot. */
export function useOperatorInbox(workspaceId: string) {
  useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, () => 0);
  return useQuery({
    queryKey: queryKeys.inbox(workspaceId),
    queryFn: () => fetchOperatorInbox(workspaceId),
    refetchInterval: 30_000,
  });
}

/**
 * The Inbox snapshot the Inbox area already keeps current, for a detail's "still in this Inbox" check.
 * Reading it never starts a request. `fingerprint` changes only when this item changes or leaves the
 * snapshot, so a detail keyed on it re-checks then and not on every Inbox refresh (IN-08).
 */
export function useCachedInboxItem(
  workspaceId: string,
  itemId: string,
): { projection: OperatorInboxResponse | undefined; fingerprint: string } {
  useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, () => 0);
  const projection = useQuery({
    queryKey: queryKeys.inbox(workspaceId),
    queryFn: () => fetchOperatorInbox(workspaceId),
    enabled: false,
  }).data;
  const current = projection?.items.find((entry) => entry.id === itemId) ?? null;
  return { projection, fingerprint: JSON.stringify([projection?.workspaceId ?? null, current]) };
}
