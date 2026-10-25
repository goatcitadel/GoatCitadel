import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ChatMessagingOverview } from "@goatcitadel/contracts";
import { fetchChatMessaging } from "@goatcitadel/mission-control-shared/api/chat";
import { queryKeys } from "../../data/query-keys";

/**
 * Chat's Messaging overview for a workspace: the channels it has and the conversations held through each. The
 * Gateway builds it per operator, so status, titles and new-message counts are never derived here. Realtime
 * `chat` and `channels` events invalidate `queryKeys.chatMessaging` (see `event-map.ts`).
 */
export function useMessagingOverview(workspaceId: string): UseQueryResult<ChatMessagingOverview> {
  return useQuery({
    queryKey: queryKeys.chatMessaging(workspaceId),
    queryFn: ({ signal }) => fetchChatMessaging(workspaceId, { signal }),
  });
}
