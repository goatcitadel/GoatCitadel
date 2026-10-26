import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ChatMessagingOverview } from "@goatcitadel/contracts";
import { fetchChatMessaging } from "@goatcitadel/mission-control-shared/api/chat";
import { queryKeys } from "../../data/query-keys";

/**
 * Chat's Messaging overview for a workspace: the channels it has and the conversations held through each. The
 * Gateway builds it per operator, so status, titles and new-message counts are never derived here. Realtime
 * `chat` and `channels` events invalidate `queryKeys.chatMessaging` (see `event-map.ts`). `enabled: false` reads
 * only what another view already loaded, for a caller that wants the overview when it is there but not a request
 * of its own.
 */
export function useMessagingOverview(
  workspaceId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<ChatMessagingOverview> {
  return useQuery({
    queryKey: queryKeys.chatMessaging(workspaceId),
    queryFn: ({ signal }) => fetchChatMessaging(workspaceId, { signal }),
    enabled: options.enabled ?? true,
  });
}
