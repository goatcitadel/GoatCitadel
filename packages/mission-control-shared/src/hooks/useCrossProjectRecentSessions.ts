import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecentCrossProjectSession } from "@goatcitadel/contracts";
import { fetchCrossProjectRecentSessions } from "../api/chat.js";
import { useRefreshSubscription } from "./useRefreshSubscription.js";

export function useCrossProjectRecentSessions(
  workspaceId: string,
  options?: { limit?: number; enabled?: boolean },
): {
  items: RecentCrossProjectSession[];
  loading: boolean;
  error: string | null;
} {
  const loadSequenceRef = useRef(0);
  const enabled = (options?.enabled ?? true) && Boolean(workspaceId);
  const limit = options?.limit ?? 8;
  const scope = useMemo(() => ({ workspaceId, limit, enabled }), [workspaceId, limit, enabled]);
  const [result, setResult] = useState<{
    scope: typeof scope;
    items: RecentCrossProjectSession[];
    error: string | null;
  }>();

  const load = useCallback(async () => {
    if (!scope.enabled) return;
    const loadId = ++loadSequenceRef.current;
    try {
      const response = await fetchCrossProjectRecentSessions(scope.workspaceId, scope.limit);
      if (loadSequenceRef.current === loadId) {
        setResult({ scope, items: response.items, error: null });
      }
    } catch (fetchError) {
      if (loadSequenceRef.current === loadId) {
        const error = fetchError instanceof Error ? fetchError.message : String(fetchError);
        setResult((previous) => ({
          scope,
          items: previous?.scope === scope ? previous.items : [],
          error,
        }));
      }
    }
  }, [scope]);

  useEffect(() => {
    void load();
    return () => {
      loadSequenceRef.current += 1;
    };
  }, [load]);

  useRefreshSubscription("projects", load, {
    enabled,
    staleMs: 15000,
    pollIntervalMs: 15000,
  });

  // Hide previous results during render, before the new scope's effect runs.
  return result?.scope === scope
    ? { items: result.items, loading: false, error: result.error }
    : { items: [], loading: enabled, error: null };
}
