import { infiniteQueryOptions } from "@tanstack/react-query";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { fetchDurableRunHistory } from "@goatcitadel/mission-control-shared/api/durable";
import { fetchTasks } from "@goatcitadel/mission-control-shared/api/tasks";
import { getEventStreamStatus } from "@goatcitadel/mission-control-shared/state/event-stream-status-store";
import { queryKeys } from "../../data/query-keys";

/** A fallback only: realtime `tasks` and `durable` events refresh these histories. */
export const WORK_HISTORY_FALLBACK_MS = 120_000;

/**
 * With the live connection open and more than one page loaded, the full refetch is replaced by a check of the first
 * page (see work-history-head-poll.ts). Otherwise every loaded page is refetched on the timer, as before.
 */
export function workHistoryFallbackInterval(query: { state: { data?: { pages: unknown[] } } }): number | false {
  const pages = query.state.data?.pages.length ?? 0;
  return getEventStreamStatus().state === "open" && pages > 1 ? false : WORK_HISTORY_FALLBACK_MS;
}

export function workspaceDurableRunsOptions(workspaceId: string) {
  const installation = getGatewayApiBaseUrl();
  return infiniteQueryOptions({
    queryKey: queryKeys.durableRunHistory(workspaceId),
    meta: { deferRealtimeInvalidationWhileFetching: true },
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchDurableRunHistory(
        { workspaceId, limit: 100, cursor: pageParam || undefined },
        { signal },
      );
      if (signal.aborted || getGatewayApiBaseUrl() !== installation)
        throw new Error("The work view is no longer current.");
      return page;
    },
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: workHistoryFallbackInterval,
  });
}

export function workspaceTasksOptions(workspaceId: string) {
  const installation = getGatewayApiBaseUrl();
  return infiniteQueryOptions({
    queryKey: queryKeys.workTasks(workspaceId),
    refetchOnMount: "always",
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchTasks(undefined, workspaceId, { limit: 200, cursor: pageParam || undefined, signal });
      if (signal.aborted || getGatewayApiBaseUrl() !== installation)
        throw new Error("The task view is no longer current.");
      return page;
    },
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: workHistoryFallbackInterval,
  });
}
