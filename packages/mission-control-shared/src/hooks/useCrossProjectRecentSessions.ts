import { useCallback, useEffect, useRef, useState } from "react";
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
  const [items, setItems] = useState<RecentCrossProjectSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);
  const enabled = options?.enabled ?? true;
  const limit = options?.limit ?? 8;

  const load = useCallback(async () => {
    if (!workspaceId) {
      return;
    }
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    try {
      const response = await fetchCrossProjectRecentSessions(workspaceId, limit);
      if (loadSequenceRef.current !== loadId) {
        return;
      }
      setItems(response.items);
      setError(null);
    } catch (fetchError) {
      if (loadSequenceRef.current !== loadId) {
        return;
      }
      setError((fetchError as Error).message);
    } finally {
      if (loadSequenceRef.current === loadId) {
        setLoading(false);
      }
    }
  }, [workspaceId, limit]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void load();
  }, [load, enabled]);

  useRefreshSubscription("projects", load, {
    enabled,
    staleMs: 15000,
    pollIntervalMs: 15000,
  });

  return { items, loading, error };
}
