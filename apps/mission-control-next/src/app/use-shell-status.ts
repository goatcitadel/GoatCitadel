import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardStateResponse, HealthSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";
import { fetchDashboardState, fetchHealthSummary } from "@goatcitadel/mission-control-shared/api/client";

/*
 * W4.4 (ship punchlist): shell status (dashboard + daemon health) extracted
 * from the orchestrator. Owns:
 *   - `status` state (dashboard + health + lastLoadedAt + errors).
 *   - The refresh-id ref used to drop stale responses from earlier refresh
 *     cycles (prevents stale `Serving` after a later refresh fails).
 *   - The interval refresh loop while the gateway is ready.
 *   - The reset-to-empty behavior when the gateway is not ready.
 *
 * The hook does NOT trigger the first load — callers run `refreshStatus()`
 * after both the gateway becomes ready and workspace options have loaded,
 * keeping the existing "load both in parallel" semantics in the shell.
 */

export type ShellStatusState = {
  dashboard: DashboardStateResponse | null;
  health: HealthSummaryResponse | null;
  lastLoadedAt: number | null;
  dashboardError: string | null;
  healthError: string | null;
};

const EMPTY_STATUS: ShellStatusState = {
  dashboard: null,
  health: null,
  lastLoadedAt: null,
  dashboardError: null,
  healthError: null,
};

export interface UseShellStatusOptions {
  gatewayReady: boolean;
  /** Refresh interval in milliseconds. Defaults to 15s. */
  refreshIntervalMs?: number;
}

export interface UseShellStatusResult {
  status: ShellStatusState;
  refreshStatus: () => Promise<void>;
}

export function useShellStatus(options: UseShellStatusOptions): UseShellStatusResult {
  const { gatewayReady, refreshIntervalMs = 15000 } = options;
  const [status, setStatus] = useState<ShellStatusState>(EMPTY_STATUS);
  const refreshIdRef = useRef(0);

  const refreshStatus = useCallback(async () => {
    const refreshId = refreshIdRef.current + 1;
    refreshIdRef.current = refreshId;
    const isCurrentRefresh = () => refreshIdRef.current === refreshId;
    void fetchDashboardState()
      .then((dashboard) => {
        if (!isCurrentRefresh()) {
          return;
        }
        setStatus((current) => ({
          ...current,
          dashboard,
          lastLoadedAt: Date.now(),
          dashboardError: null,
        }));
      })
      .catch((error) => {
        if (!isCurrentRefresh()) {
          return;
        }
        setStatus((current) => ({
          ...current,
          lastLoadedAt: Date.now(),
          dashboardError: error instanceof Error ? error.message : "Unable to refresh dashboard status.",
        }));
      });
    void fetchHealthSummary()
      .then((health) => {
        if (!isCurrentRefresh()) {
          return;
        }
        setStatus((current) => ({
          ...current,
          health,
          lastLoadedAt: Date.now(),
          healthError: null,
        }));
      })
      .catch((error) => {
        if (!isCurrentRefresh()) {
          return;
        }
        setStatus((current) => ({
          ...current,
          lastLoadedAt: Date.now(),
          healthError: error instanceof Error ? error.message : "Unable to refresh daemon health.",
        }));
      });
  }, []);

  // Reset state whenever the gateway becomes unavailable so stale dashboards
  // do not leak across reconnect attempts. The ref bump prevents an in-flight
  // response from racing in after the reset.
  useEffect(() => {
    if (gatewayReady) {
      return;
    }
    refreshIdRef.current += 1;
    setStatus(EMPTY_STATUS);
  }, [gatewayReady]);

  // Background refresh while the gateway is ready. First load is the caller's
  // responsibility (they typically pair it with workspace options).
  //
  // The poll is paused while the tab is hidden (mirrors useRefreshSubscription):
  // a backgrounded dashboard has no viewer, so the 15s dashboard+health fetch
  // is pure waste. When the tab becomes visible again we run one immediate
  // refresh so the operator never stares at stale numbers on return.
  useEffect(() => {
    if (!gatewayReady) {
      return;
    }
    const isHidden = () => typeof document !== "undefined" && document.hidden;
    const intervalId = window.setInterval(() => {
      if (isHidden()) {
        return;
      }
      void refreshStatus();
    }, refreshIntervalMs);

    const handleVisibilityChange = () => {
      if (!isHidden()) {
        void refreshStatus();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      window.clearInterval(intervalId);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, [gatewayReady, refreshIntervalMs, refreshStatus]);

  return { status, refreshStatus };
}
