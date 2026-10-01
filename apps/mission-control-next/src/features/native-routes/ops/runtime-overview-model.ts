import type {
  useOpsRuntimeSnapshot,
  RuntimeSnapshotSourceStatus,
} from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import type { AppRoute } from "@next/app/route-model";
import type { NativePageMetric } from "../NativeRoutePageLayout";
import type { ChipTone } from "../primitives";
import { capitalize, formatDateTime, formatLoadAverage } from "./runtime-formatters";
import { formatAvailabilityCount, formatCostMetric, readCurrentDayCostCompleteness } from "./runtime-spend-model";

export type OpsRuntimeData = NonNullable<ReturnType<typeof useOpsRuntimeSnapshot>["data"]>;

export type OpsAttentionItem = {
  id: string;
  title: string;
  meta: string;
  body: string;
  primaryLabel: string;
  primaryRoute: AppRoute;
  inspectLabel: string;
  inspectRoute: AppRoute;
  tone: ChipTone;
};

export function formatRuntimeFreshnessTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function labelForOpsSection(section: NonNullable<AppRoute["section"]>) {
  switch (section) {
    case "sessions":
      return "Sessions";
    case "schedules":
      return "Schedules";
    case "improvement":
      return "Improvement";
    case "notifications":
      return "Notifications";
    case "costs":
      return "Costs";
    case "runtime":
      return "Runtime";
    case "diagnostics":
      return "Diagnostics";
    default:
      return "Activity";
  }
}

export function buildNeedsAttentionItems(
  data: OpsRuntimeData,
  pendingApprovals: number,
  theme: AppRoute["theme"],
): OpsAttentionItem[] {
  const items: OpsAttentionItem[] = [];
  const pendingApprovalCount = data.dashboard?.pendingApprovals ?? pendingApprovals;
  const daemonRuntimeUnavailable = sourceFailed(data, "daemon") && sourceFailed(data, "health");
  const daemonRunning = daemonRuntimeUnavailable ? null : (data.daemon?.running ?? data.health?.daemonStatus?.running);
  const latestBackup = data.health?.backups?.latest;
  const latestBackupVerified = latestBackup?.verified === true && latestBackup?.contractVerified === true;
  const schedulerReviewCount = data.timeline?.scheduler?.reviewQueue?.length ?? 0;
  const unknownSpendEvents = data.cost?.usageAvailability?.unknownEvents ?? 0;
  const unknownCostEvents = data.cost?.usageAvailability?.metricAvailability?.costUsd?.unknownAttemptCount ?? 0;
  const failedRuntimeEvents = (data.timeline?.events?.items ?? []).filter((item) =>
    /failed|failure|error|degraded/i.test(`${item.eventType} ${item.eventClass ?? ""}`),
  );
  const sourceFailures = Object.entries(data.sourceStatus).filter(([, status]) => status.status === "error");

  if (pendingApprovalCount > 0) {
    items.push({
      id: "pending-approvals",
      title: "Pending approvals",
      meta: `${pendingApprovalCount} waiting`,
      body: "Operator decisions are blocking work from moving forward.",
      primaryLabel: "Review queue",
      primaryRoute: { area: "ops", section: "approvals", theme },
      inspectLabel: "Open activity",
      inspectRoute: { area: "ops", section: "activity", theme },
      tone: "caution",
    });
  }

  if (daemonRuntimeUnavailable || daemonRunning === false) {
    items.push({
      id: "daemon-runtime",
      title: "Daemon/runtime issue",
      meta: daemonRuntimeUnavailable ? "unavailable" : "stopped",
      body: daemonRuntimeUnavailable
        ? "Daemon and health sources are unavailable, so runtime control truth needs inspection."
        : `Daemon is ${data.daemon?.state ?? data.health?.daemonStatus?.state ?? "stopped"}.`,
      primaryLabel: "Open runtime",
      primaryRoute: { area: "ops", section: "runtime", theme },
      inspectLabel: "Diagnostics",
      inspectRoute: { area: "ops", section: "diagnostics", theme },
      tone: "danger",
    });
  }

  if (!sourceFailed(data, "health") && !latestBackupVerified) {
    items.push({
      id: "backup-posture",
      title: latestBackup ? "Backup needs verification" : "No backup visible",
      meta: latestBackup ? "stale proof" : "missing",
      body: latestBackup
        ? "A backup exists, but verified restore-contract evidence is not present."
        : "No backup is visible in the current health snapshot.",
      primaryLabel: "Open runtime",
      primaryRoute: { area: "ops", section: "runtime", theme },
      inspectLabel: "Diagnostics",
      inspectRoute: { area: "ops", section: "diagnostics", theme },
      tone: latestBackup ? "caution" : "danger",
    });
  }

  if (schedulerReviewCount > 0) {
    items.push({
      id: "scheduler-review",
      title: "Scheduler review queue",
      meta: `${schedulerReviewCount} queued`,
      body: "Scheduled work has items waiting for operator review.",
      primaryLabel: "Open schedules",
      primaryRoute: { area: "ops", section: "schedules", theme },
      inspectLabel: "Activity",
      inspectRoute: { area: "ops", section: "activity", theme },
      tone: "caution",
    });
  }

  if (unknownSpendEvents > 0 || unknownCostEvents > 0 || sourceFailed(data, "cost")) {
    items.push({
      id: "spend-coverage",
      title: sourceFailed(data, "cost") ? "Spend source unavailable" : "Spend coverage gap",
      meta: sourceFailed(data, "cost")
        ? "unavailable"
        : unknownCostEvents > 0
          ? `${unknownCostEvents} cost unknown`
          : `${unknownSpendEvents} usage unknown`,
      body: sourceFailed(data, "cost")
        ? "Cost data could not be loaded, so provider spend truth is incomplete."
        : unknownCostEvents > 0
          ? "Some runtime attempts have token evidence but no trustworthy cost, so displayed spend is a lower bound."
          : "Some runtime events are missing usage metadata and need cost review.",
      primaryLabel: "Open costs",
      primaryRoute: { area: "ops", section: "costs", theme },
      inspectLabel: "Activity",
      inspectRoute: { area: "ops", section: "activity", theme },
      tone: "caution",
    });
  }

  if (failedRuntimeEvents.length > 0) {
    const first = failedRuntimeEvents[0]!;
    items.push({
      id: "failed-runtime-event",
      title: "Failed runtime event",
      meta: first.eventType,
      body: first.timestamp
        ? `Latest failure signal at ${formatDateTime(first.timestamp)}.`
        : "A failure signal is present.",
      primaryLabel: "Open activity",
      primaryRoute: { area: "ops", section: "activity", theme },
      inspectLabel: "Diagnostics",
      inspectRoute: { area: "ops", section: "diagnostics", theme },
      tone: "danger",
    });
  }

  for (const [source, status] of sourceFailures.slice(0, 2)) {
    items.push({
      id: `source-${source}`,
      title: `${capitalize(source)} source unavailable`,
      meta: "source error",
      body: readRuntimeSourceMessage(status) ?? "A runtime source could not be loaded.",
      primaryLabel: "Diagnostics",
      primaryRoute: { area: "ops", section: "diagnostics", theme },
      inspectLabel: "Activity",
      inspectRoute: { area: "ops", section: "activity", theme },
      tone: "danger",
    });
  }

  return items.slice(0, 8);
}

export function buildOpsHeadMetrics(
  section: NonNullable<AppRoute["section"]>,
  data: NonNullable<ReturnType<typeof useOpsRuntimeSnapshot>["data"]>,
  pendingApprovals: number,
): NativePageMetric[] {
  const daemonRuntimeUnavailable = sourceFailed(data, "daemon") && sourceFailed(data, "health");
  const daemonRunning = daemonRuntimeUnavailable ? null : (data.daemon?.running ?? data.health?.daemonStatus?.running);
  const daemonValue = daemonRunning == null ? "unknown" : daemonRunning ? "running" : "stopped";
  const pendingValue = String(data.dashboard?.pendingApprovals ?? pendingApprovals);
  const subagentsValue = String(data.dashboard?.activeSubagents ?? 0);
  const daySpendValue = formatCostMetric(data.dashboard?.dailyCostUsd, readCurrentDayCostCompleteness(data));

  switch (section) {
    case "sessions":
      return [
        // `sessions` (like `recentEvents` in the section JSX) is required by
        // DashboardStateResponse, but a partial gateway response (e.g. a stub
        // returning {}) can omit it at runtime — count a missing list as 0.
        { label: "Visible", value: String(data.sessions.length || data.dashboard?.sessions?.length || 0) },
        { label: "Active subagents", value: subagentsValue },
        { label: "Pending approvals", value: pendingValue },
      ];
    case "schedules":
      return [
        { label: "Jobs", value: String(data.timeline?.scheduler?.jobs?.length ?? 0) },
        { label: "Review queue", value: String(data.timeline?.scheduler?.reviewQueue?.length ?? 0) },
        { label: "Pending approvals", value: pendingValue },
      ];
    case "improvement":
      return [
        { label: "Reports", value: String(data.timeline?.improvement?.reports?.length ?? 0) },
        { label: "Replay runs", value: String(data.timeline?.improvement?.replayRuns?.length ?? 0) },
        { label: "Pending approvals", value: pendingValue },
      ];
    case "notifications":
      return [
        { label: "Pending approvals", value: pendingValue },
        { label: "Daemon", value: daemonValue },
        { label: "Active subagents", value: subagentsValue },
      ];
    case "costs":
      return [
        { label: "Day spend", value: daySpendValue },
        { label: "Tracked events", value: formatAvailabilityCount(data.cost?.usageAvailability?.trackedEvents) },
        { label: "Scope", value: data.cost?.scope ?? "day" },
      ];
    case "runtime":
      return [
        { label: "Daemon", value: daemonValue },
        { label: "MCP servers", value: String(data.mcpServers.length) },
        { label: "Backups", value: String(data.backups.length) },
        { label: "Pending approvals", value: pendingValue },
      ];
    case "diagnostics":
      return [
        { label: "Hostname", value: data.health?.systemVitals?.hostname ?? "Unknown" },
        { label: "CPU", value: String(data.health?.systemVitals?.cpuCount ?? 0) },
        { label: "Load", value: formatLoadAverage(data.health?.systemVitals?.loadAverage ?? []) },
      ];
    case "activity":
    default:
      return [
        { label: "Pending approvals", value: pendingValue },
        { label: "Active subagents", value: subagentsValue },
        { label: "Day spend", value: daySpendValue },
        { label: "Daemon", value: daemonValue },
      ];
  }
}

export function descriptionForOpsSection(section: NonNullable<AppRoute["section"]>) {
  switch (section) {
    case "sessions":
      return "Recent session evidence and operator posture in the canonical Ops route.";
    case "schedules":
      return "Scheduled work and review queue pressure with direct operator controls.";
    case "improvement":
      return "Replay and improvement signals that stay visible to the operator.";
    case "notifications":
      return "Operator-facing runtime issues and repair opportunities.";
    case "costs":
      return "Spend coverage, QMD efficiency, and current usage posture.";
    case "runtime":
      return "Daemon controls, backup posture, and runtime truth in one route.";
    case "diagnostics":
      return "System vitals, daemon logs, and integration posture in a calmer diagnostics route.";
    default:
      return "Operational signal grouped for quick scanning.";
  }
}

export function sourceFailed(
  data: { sourceStatus: Record<string, { status: "ok" | "error" | "not_requested" }> },
  source: string,
): boolean {
  return data.sourceStatus[source]?.status === "error";
}

/**
 * The runtime sources each Ops section actually relies on for its headline
 * numbers. `useOpsRuntimeSnapshot().load()` never rejects (it captures each
 * source independently), so a gateway-down state otherwise renders a calm
 * "$0.00 healthy" view (F-H3). We surface a degraded strip on every section
 * when any relied-upon source failed so failure is visible, not zeroed-healthy.
 */
const SECTION_RELIED_SOURCES: Record<string, readonly string[]> = {
  activity: ["dashboard", "timeline"],
  sessions: ["dashboard", "sessions"],
  schedules: ["timeline"],
  improvement: ["timeline"],
  notifications: ["timeline", "health"],
  costs: ["cost", "dashboard", "health"],
  runtime: ["daemon", "health", "llamaCpp", "mcpServers", "backups"],
  diagnostics: ["health", "llamaCpp"],
};

export type OpsDegradedSource = { source: string; message: string };

/**
 * Failed relied-upon sources for the given section, with their error messages.
 * Empty when every relied-upon source loaded.
 */
export function buildSectionDegradedSources(
  data: { sourceStatus: Record<string, RuntimeSnapshotSourceStatus> },
  section: string,
): OpsDegradedSource[] {
  const relied = SECTION_RELIED_SOURCES[section] ?? ["dashboard"];
  const degraded: OpsDegradedSource[] = [];
  for (const source of relied) {
    const status = data.sourceStatus[source];
    if (status && status.status === "error") {
      degraded.push({ source, message: status.message });
    }
  }
  return degraded;
}

export function describeOpsDegradedSources(degraded: OpsDegradedSource[]): string {
  if (degraded.length === 0) {
    return "";
  }
  const names = degraded.map((item) => capitalize(item.source));
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
  return `${list} ${degraded.length === 1 ? "source is" : "sources are"} unavailable. The figures below may be incomplete or stale — they are not a healthy zero.`;
}

export function readRuntimeSourceMessage(status: unknown): string | null {
  if (!status || typeof status !== "object") {
    return null;
  }
  const record = status as { message?: unknown; error?: unknown };
  return typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : null;
}

export function runtimeEventKey(item: { eventId?: string; eventType: string; timestamp?: string; source?: string }) {
  return item.eventId ?? JSON.stringify(item);
}
