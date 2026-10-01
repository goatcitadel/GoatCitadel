import { useQuery } from "@tanstack/react-query";
import { fetchOperatorInbox } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import { queryKeys } from "./query-keys";

/** All cockpit Inbox consumers share one scoped, owner-authored snapshot. */
export function useOperatorInbox(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.inbox(workspaceId),
    queryFn: () => fetchOperatorInbox(workspaceId),
    refetchInterval: 30_000,
  });
}
