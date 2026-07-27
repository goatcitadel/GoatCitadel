import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";
import type { RealtimeTruthMode } from "@goatcitadel/mission-control-shared/state/realtime-derived";
import type { AppRoute } from "./route-model";
import type { ShellStatusState } from "./use-shell-status";

export function resolveShellThemeClass(theme: "dark" | "light"): "theme-signal-noir" | "theme-citadel-light" {
  return theme === "light" ? "theme-citadel-light" : "theme-signal-noir";
}

export function resolveEffectiveShellTheme(
  routeTheme: string | undefined,
  preferredTheme: "dark" | "light",
): "dark" | "light" {
  return routeTheme === "dark" || routeTheme === "light" ? routeTheme : preferredTheme;
}

export function describeRealtimeTruthUi(
  streamState: EventStreamConnectionState,
  truthMode: RealtimeTruthMode,
): {
  badge: string;
  inspector: string;
  rail: string;
  stage: string;
  strip: string;
  degraded: boolean;
} {
  if (streamState !== "open") {
    return {
      badge: "Polling",
      inspector: "Polling fallback",
      rail: "Polling fallback active",
      stage: "Realtime degraded",
      strip: "Polling fallback",
      degraded: true,
    };
  }

  if (truthMode === "replay-gap") {
    return {
      badge: "Live recovery",
      inspector: "Streaming via replay recovery",
      rail: "Streaming with replay recovery",
      stage: "Realtime replay recovery",
      strip: "Streaming (replay recovery)",
      degraded: true,
    };
  }

  if (truthMode === "compatibility") {
    // N1 (QA finding): "compatibility" is per-event topic-inference provenance
    // (keyword match vs explicit `links` ids), not a transport downgrade.
    // While the stream is open it is NOT a degradation — badge/strip/rail read
    // healthy exactly like "authoritative". The nuance stays visible only in
    // the inspector detail line, softened to avoid implying a fallback.
    return {
      badge: "Live",
      inspector: "Streaming (inferred refresh)",
      rail: "Gateway live with streaming",
      stage: "Realtime connected",
      strip: "Streaming",
      degraded: false,
    };
  }

  return {
    badge: "Live",
    inspector: "Connected",
    rail: "Gateway live with streaming",
    stage: "Realtime connected",
    strip: "Streaming",
    degraded: false,
  };
}

export function isImmersiveRoute(route: AppRoute): boolean {
  return route.area === "library" && route.section === "prompt-packs";
}

export function usesEmbeddedRouteHeader(route: AppRoute): boolean {
  return (
    route.area === "library" ||
    route.area === "projects" ||
    route.area === "ops" ||
    route.area === "settings" ||
    (route.area === "cowork" && (route.section === "tasks" || route.section === "board"))
  );
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number.isFinite(value) ? value : 0);
}

/**
 * F-H4: the always-visible status strip shows dashboard-derived truth (pending
 * approvals, sessions, spend). On a refresh failure `use-shell-status` keeps the
 * prior `dashboard` object, so without this the footer would keep presenting the
 * last-good numbers as if current. Mirror the honest `healthError`→"Unavailable"
 * daemon path: when `dashboardError` is set we mark the pill stale and show
 * "Unavailable" rather than a confidently stale value. The `shellStatusError`
 * chip is gated to the stage header (hidden on ops/library/settings/projects),
 * so this strip is the only always-visible signal.
 */
export function describeDashboardFooterPill(
  dashboard: ShellStatusState["dashboard"],
  dashboardError: string | null,
  formatted: string,
): { value: string; degraded: boolean } {
  if (dashboardError) {
    return { value: "Unavailable", degraded: true };
  }
  if (!dashboard) {
    return { value: "—", degraded: false };
  }
  return { value: formatted, degraded: false };
}

/**
 * `sessions` is required by DashboardStateResponse, but partial gateway
 * responses (e.g. a stub returning {}) can omit it at runtime — count a
 * missing list as 0 instead of crashing the footer pill and rail signal.
 */
export function countDashboardSessions(dashboard: ShellStatusState["dashboard"]): number {
  return dashboard?.sessions?.length ?? 0;
}
