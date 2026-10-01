import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchDurableRunHistory } from "@goatcitadel/mission-control-shared/api/durable";
import { queryKeys } from "../../data/query-keys";

export function useWorkspaceDurableRuns(workspaceId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.durableRunHistory(workspaceId),
    initialPageParam: "",
    queryFn: ({ pageParam }) => fetchDurableRunHistory({ workspaceId, limit: 100, cursor: pageParam || undefined }),
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 30_000,
  });
}
