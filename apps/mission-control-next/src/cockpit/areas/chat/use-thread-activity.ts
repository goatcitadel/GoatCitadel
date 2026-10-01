import { useLayoutEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { readThreadActivityWindow, THREAD_ACTIVITY_WINDOW_LIMIT, type ThreadActivity } from "./thread-activity";

export function useThreadActivity(sessionIds: readonly string[]) {
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const installation = getGatewayApiBaseUrl();
  const key = JSON.stringify([installation, workspaceId, activeCitadelId]);
  const scope = useRef({ key, generation: 0 });
  if (scope.current.key !== key) scope.current = { key, generation: scope.current.generation + 1 };
  const view = scope.current;
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const ids = [...new Set(sessionIds)].slice(0, THREAD_ACTIVITY_WINDOW_LIMIT);
  const query = useQuery({
    // The existing cockpit realtime bridge invalidates the chat prefix after owner transitions/replay gaps.
    queryKey: ["chat", "thread-activity", key, view.generation, ids],
    enabled: ids.length > 0,
    staleTime: 30_000,
    refetchOnMount: "always",
    queryFn: ({ signal }) => readThreadActivityWindow({ workspaceId, sessionIds: ids, signal,
      isCurrent: () => mounted.current && scope.current === view && getGatewayApiBaseUrl() === installation }),
  });
  const records: Record<string, ThreadActivity> = query.isFetching || query.isError || query.isStale ? {} : query.data ?? {};
  return { records, loading: query.isFetching, stale: query.isStale, refresh: () => query.refetch() };
}
