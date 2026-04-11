import { useCallback, useEffect, useMemo, useState } from "react";
import { connectEventStream, fetchTimelineSummary, type RealtimeEvent, type TimelineSummaryResponse } from "../api/client";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";

function mergeLiveEvents(existing: RealtimeEvent[], incoming: RealtimeEvent): RealtimeEvent[] {
  const deduped = [incoming, ...existing.filter((event) => event.eventId !== incoming.eventId)];
  deduped.sort((left, right) => {
    const sequenceDelta = (right.sequence ?? -1) - (left.sequence ?? -1);
    if (sequenceDelta !== 0) {
      return sequenceDelta;
    }
    return Date.parse(right.timestamp) - Date.parse(left.timestamp);
  });
  return deduped.slice(0, 300);
}

export function useTimelineSummary() {
  const [data, setData] = useState<TimelineSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    const response = await fetchTimelineSummary();
    setData(response);
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().catch((nextError: Error) => {
      if (!cancelled) {
        setError(nextError.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    const close = connectEventStream((event) => {
      setData((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          generatedAt: new Date().toISOString(),
          events: {
            ...current.events,
            items: mergeLiveEvents(current.events.items, event),
          },
        };
      });
    });
    return () => {
      close();
    };
  }, []);

  useRefreshSubscription(
    "dashboard",
    async () => {
      setIsRefreshing(true);
      try {
        await load();
      } finally {
        setIsRefreshing(false);
      }
    },
    {
      enabled: true,
      coalesceMs: 1000,
      staleMs: 20000,
      pollIntervalMs: 15000,
    },
  );

  return useMemo(
    () => ({
      data,
      error,
      isRefreshing,
      refresh: load,
    }),
    [data, error, isRefreshing, load],
  );
}
