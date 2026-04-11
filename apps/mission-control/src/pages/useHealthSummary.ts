import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchHealthSummary, type HealthSummaryResponse } from "../api/client";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";

export function useHealthSummary() {
  const [data, setData] = useState<HealthSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    const response = await fetchHealthSummary();
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

  useRefreshSubscription(
    "system",
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
      setError,
    }),
    [data, error, isRefreshing, load],
  );
}
