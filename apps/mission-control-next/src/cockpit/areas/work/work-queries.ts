import { infiniteQueryOptions } from "@tanstack/react-query";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { fetchDurableRunHistory } from "@goatcitadel/mission-control-shared/api/durable";
import { fetchTasks } from "@goatcitadel/mission-control-shared/api/tasks";
import { queryKeys } from "../../data/query-keys";

export function workspaceDurableRunsOptions(workspaceId: string) {
  const installation = getGatewayApiBaseUrl();
  return infiniteQueryOptions({
    queryKey: queryKeys.durableRunHistory(workspaceId),
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
    refetchInterval: 30_000,
  });
}

export function workspaceTasksOptions(workspaceId: string) {
  const installation = getGatewayApiBaseUrl();
  return infiniteQueryOptions({
    queryKey: queryKeys.workTasks(workspaceId),
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchTasks(undefined, workspaceId, { limit: 200, cursor: pageParam || undefined });
      if (signal.aborted || getGatewayApiBaseUrl() !== installation)
        throw new Error("The task view is no longer current.");
      return page;
    },
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 30_000,
  });
}
