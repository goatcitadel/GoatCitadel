import { infiniteQueryOptions } from "@tanstack/react-query";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { fetchDurableRunHistory } from "@goatcitadel/mission-control-shared/api/durable";
import { fetchTasks } from "@goatcitadel/mission-control-shared/api/tasks";
import { queryKeys } from "../../data/query-keys";

/** A fallback only: realtime `tasks` and `durable` events refresh these histories. */
export const WORK_HISTORY_FALLBACK_MS = 120_000;

/**
 * A list with more than one page loaded is polled by useWorkHistoryHeadPoll (a first-page check while the live
 * connection is open, a full refetch of the loaded pages otherwise), so the query's own timer stays off for it.
 * TanStack only recomputes this interval on a query update, which is why the connection state is not read here:
 * a timer chosen while the connection was open would stay off through a later outage. With one page loaded the
 * query's own timer refetches it, as before.
 */
export function workHistoryFallbackInterval(query: { state: { data?: { pages: unknown[] } } }): number | false {
  const pages = query.state.data?.pages.length ?? 0;
  return pages > 1 ? false : WORK_HISTORY_FALLBACK_MS;
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
