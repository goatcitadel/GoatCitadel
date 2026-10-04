import { useQueries } from "@tanstack/react-query";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import {
  readThreadActivity,
  THREAD_ACTIVITY_WINDOW_LIMIT,
  UNKNOWN_THREAD_ACTIVITY,
  type ThreadActivity,
} from "./thread-activity";

export type ThreadActivityRecord = ThreadActivity & { stale?: boolean };

const REFRESH_MS = 60_000;

/** Retry once for transient failures; a 4xx answer is a real result, not a blip. */
function retryStatusRead(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (isApiRequestError(error) && error.kind === "http" && (error.status ?? 500) < 500) return false;
  return true;
}

/**
 * One cached query per visible conversation. Adding a thread reads only that thread, a refetch
 * keeps the last answer on screen, and an answer that is no longer current is labelled with
 * when it was observed instead of disappearing. Stale data never claims current activity.
 */
export function useThreadActivity(sessionIds: readonly string[]) {
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const installation = getGatewayApiBaseUrl();
  const scope = JSON.stringify([installation, workspaceId, activeCitadelId]);
  const ids = [...new Set(sessionIds)].slice(0, THREAD_ACTIVITY_WINDOW_LIMIT);
  const queries = useQueries({
    queries: ids.map((sessionId) => ({
      // The cockpit realtime bridge invalidates the chat prefix after owner transitions/replay gaps.
      queryKey: ["chat", "thread-activity", scope, sessionId],
      queryFn: ({ signal }: { signal: AbortSignal }) => readThreadActivity({ workspaceId, sessionId, signal }),
      staleTime: REFRESH_MS,
      refetchInterval: REFRESH_MS,
      refetchOnWindowFocus: true,
      retry: retryStatusRead,
      retryDelay: 1_500,
    })),
  });
  const records: Record<string, ThreadActivityRecord> = {};
  const checking = new Set<string>();
  ids.forEach((sessionId, index) => {
    const query = queries[index]!;
    if (query.data) records[sessionId] = { ...query.data, stale: query.isStale || query.isError };
    else if (query.isError) records[sessionId] = UNKNOWN_THREAD_ACTIVITY;
    else checking.add(sessionId);
  });
  const loading = queries.some((query) => query.isFetching);
  const refresh = () => Promise.all(queries.map((query) => query.refetch()));
  return { records, checking, loading, refresh };
}
