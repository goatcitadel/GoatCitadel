import type { HealthSummaryResponse } from "../api/types";
import type { StatusTone } from "./status-vocabulary";

/**
 * One runtime-service derivation, shared by System › Health, the saved-board Runtime widget and the Runtime tab's
 * head metrics, so they never disagree (follow-up review SY-01).
 */
export function describeRuntimeService(daemon: HealthSummaryResponse["daemonStatus"] | undefined): {
  label: string;
  tone: StatusTone;
  detail: string;
} {
  if (!daemon) return { label: "Unknown", tone: "neutral", detail: "The health summary did not report the service." };
  const issues = daemon.diagnostics?.filter((item) => item.severity === "critical" || item.severity === "warn") ?? [];
  if (!daemon.supported)
    return { label: "Unavailable", tone: "neutral", detail: "Service control is unavailable on this host." };
  if (!daemon.running) return { label: "Problem", tone: "failed", detail: "The managed runtime service is stopped." };
  if (issues.length) {
    const critical = issues.some((item) => item.severity === "critical");
    return {
      label: critical ? "Problem" : "Needs review",
      tone: critical ? "failed" : "waiting",
      detail: `${issues.length} runtime ${issues.length === 1 ? "diagnostic needs" : "diagnostics need"} review.`,
    };
  }
  return {
    label: "Running",
    tone: "done",
    detail: "The managed runtime service is running with no reported warnings.",
  };
}
