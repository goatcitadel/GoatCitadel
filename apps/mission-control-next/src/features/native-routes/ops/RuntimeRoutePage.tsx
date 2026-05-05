import { useMemo } from "react";
import { Activity, RefreshCw, Server, Wallet } from "lucide-react";
import { StatusChip } from "@goatcitadel/mission-control-shared/components/StatusChip";
import { useOpsRuntimeSnapshot } from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import type { AppRoute } from "@next/app/route-model";
import { NativeCard, NativeGrid, NativeList, NativePageFrame, QuickJumpCard } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import "../native-routes.css";

export function RuntimeRoutePage({ route, activeWorkspaceName, pendingApprovals, navigate }: NativeRoutePagesProps) {
  const section = (route.section ?? "activity") as NonNullable<AppRoute["section"]>;
  const runtime = useOpsRuntimeSnapshot();
  const data = runtime.data;

  const content = useMemo(() => {
    if (!data) {
      return null;
    }

    switch (section) {
      case "sessions":
        return (
          <NativeGrid>
            <NativeCard
              title="Session evidence"
              subtitle="Recent session posture, channel mix, and operator-ready evidence."
              stats={[
                { label: "Visible", value: String(data.sessions.length || data.dashboard?.sessions.length || 0) },
                { label: "Workspace", value: activeWorkspaceName },
              ]}
            >
              <NativeList
                items={(data.sessions.length ? data.sessions : (data.dashboard?.sessions ?? []))
                  .slice(0, 14)
                  .map((item) => ({
                    title: item.displayName || item.sessionId,
                    meta: item.channel,
                    body: `${formatDateTime(item.lastActivityAt)} · ${item.sessionId}`,
                  }))}
                emptyLabel="No recent sessions."
              />
            </NativeCard>
            <NativeCard
              title="Session posture"
              subtitle="Keep session truth next to approvals and activity instead of hiding it under a legacy shell."
            >
              <MetricGrid
                items={[
                  {
                    label: "Pending approvals",
                    value: String(data.dashboard?.pendingApprovals ?? pendingApprovals),
                    meta: "Decision queue pressure",
                  },
                  {
                    label: "Active subagents",
                    value: String(data.dashboard?.activeSubagents ?? 0),
                    meta: "Current orchestration load",
                  },
                  {
                    label: "Recent events",
                    value: String(data.dashboard?.recentEvents.length ?? 0),
                    meta: "Signals attached to current posture",
                  },
                ]}
              />
            </NativeCard>
          </NativeGrid>
        );
      case "schedules":
        return (
          <NativeGrid>
            <NativeCard
              title="Scheduler review"
              subtitle="Review items waiting on schedule, approvals, or follow-on operator attention."
              stats={[
                { label: "Review queue", value: String(data.timeline?.scheduler.reviewQueue.length ?? 0) },
                { label: "Jobs", value: String(data.timeline?.scheduler.jobs.length ?? 0) },
              ]}
            >
              <NativeList
                items={(data.timeline?.scheduler.reviewQueue ?? []).slice(0, 14).map((item) => ({
                  title: item.reason || item.itemId,
                  meta: item.status ?? "queued",
                  body: item.scheduledFor ? formatDateTime(item.scheduledFor) : "No schedule timestamp",
                }))}
                emptyLabel="No scheduler review items."
              />
            </NativeCard>
            <NativeCard
              title="Scheduled jobs"
              subtitle="Current cadence and next-run posture for scheduled operator work."
            >
              <NativeList
                items={(data.timeline?.scheduler.jobs ?? []).slice(0, 14).map((item) => ({
                  title: item.name,
                  meta: item.enabled ? "enabled" : "disabled",
                  body: `${item.action} · ${item.nextRunAt ? formatDateTime(item.nextRunAt) : "No next run"}`,
                }))}
                emptyLabel="No scheduled jobs."
              />
            </NativeCard>
          </NativeGrid>
        );
      case "improvement":
        return (
          <NativeGrid>
            <NativeCard
              title="Improvement reports"
              subtitle="Recent improvement outputs and replay-linked evidence."
              stats={[
                { label: "Reports", value: String(data.timeline?.improvement.reports.length ?? 0) },
                { label: "Replay runs", value: String(data.timeline?.improvement.replayRuns.length ?? 0) },
              ]}
            >
              <NativeList
                items={(data.timeline?.improvement.reports ?? []).slice(0, 12).map((item) => ({
                  title: item.title || item.reportId,
                  meta: item.runId ?? "report",
                  body: item.createdAt ? formatDateTime(item.createdAt) : "No timestamp",
                }))}
                emptyLabel="No improvement reports yet."
              />
            </NativeCard>
            <NativeCard
              title="Replay posture"
              subtitle="Replay-linked runs should stay explicit, not disappear into a generic activity feed."
            >
              <NativeList
                items={(data.timeline?.improvement.replayRuns ?? []).slice(0, 12).map((item) => ({
                  title: item.runId,
                  meta: item.status ?? "unknown",
                  body: item.updatedAt ? formatDateTime(item.updatedAt) : formatDateTime(item.createdAt),
                }))}
                emptyLabel="No replay runs yet."
              />
            </NativeCard>
          </NativeGrid>
        );
      case "costs":
        return (
          <NativeGrid>
            <NativeCard
              title="Spend summary"
              subtitle="Tracked usage, coverage, and current spend leaders."
              stats={[
                { label: "Scope", value: data.cost?.scope ?? "day" },
                { label: "Tracked", value: String(data.cost?.usageAvailability?.trackedEvents ?? 0) },
              ]}
            >
              <MetricGrid
                items={[
                  {
                    label: "Tracked events",
                    value: String(data.cost?.usageAvailability?.trackedEvents ?? 0),
                    meta: "Events with spend metadata",
                  },
                  {
                    label: "Unknown events",
                    value: String(data.cost?.usageAvailability?.unknownEvents ?? 0),
                    meta: "Signals missing usage data",
                  },
                  {
                    label: "Day spend",
                    value: formatUsd(data.dashboard?.dailyCostUsd ?? 0),
                    meta: "Dashboard daily total",
                  },
                ]}
              />
              <NativeList
                items={(data.cost?.items ?? []).slice(0, 10).map((item) => ({
                  title: item.key,
                  meta: formatUsd(item.costUsd),
                  body: `${item.tokenTotal.toLocaleString()} total tokens`,
                }))}
                emptyLabel="No spend breakdown available."
              />
            </NativeCard>
            <NativeCard
              title="Quality and QMD signal"
              subtitle="Spend only means something when paired with quality and context efficiency."
            >
              <MetricGrid
                items={[
                  {
                    label: "QMD posture",
                    value: describeQmdImpact(data.health?.costs.qmd.efficiencyLabel),
                    meta: formatTokenDelta(data.health?.costs.qmd.netTokenDelta ?? 0),
                  },
                  {
                    label: "Compression",
                    value: `${(data.health?.costs.qmd.compressionPercent ?? 0).toFixed(1)}%`,
                    meta: "Context reduction",
                  },
                  {
                    label: "Expansion",
                    value: `${(data.health?.costs.qmd.expansionPercent ?? 0).toFixed(1)}%`,
                    meta: "Context growth",
                  },
                ]}
              />
            </NativeCard>
          </NativeGrid>
        );
      case "runtime":
        return (
          <NativeGrid>
            <NativeCard
              title="Runtime posture"
              subtitle="Daemon state, service-manager controls, and backup truth in the canonical shell."
              stats={[
                { label: "Approvals", value: String(data.dashboard?.pendingApprovals ?? pendingApprovals) },
                { label: "MCP", value: String(data.mcpServers.length) },
              ]}
            >
              {runtime.notice ? (
                <div className={`mc-next-runtime-notice tone-${runtime.notice.tone}`}>
                  <span>{runtime.notice.message}</span>
                </div>
              ) : null}
              <div className="mc-next-runtime-chip-row">
                <StatusChip
                  tone={sourceFailed(data, "daemon") ? "critical" : data.daemon?.running ? "success" : "warning"}
                >
                  {sourceFailed(data, "daemon")
                    ? "Daemon unavailable"
                    : data.daemon?.running
                      ? "Daemon running"
                      : "Daemon stopped"}
                </StatusChip>
                <StatusChip
                  tone={sourceFailed(data, "health") ? "critical" : data.health?.backups.latest ? "success" : "warning"}
                >
                  {sourceFailed(data, "health")
                    ? "Backup status unavailable"
                    : data.health?.backups.latest
                      ? "Backup ready"
                      : "No backup"}
                </StatusChip>
                <StatusChip tone={data.daemon?.controllable ? "default" : "muted"}>
                  {sourceFailed(data, "daemon")
                    ? "Control status unavailable"
                    : data.daemon?.controllable
                      ? "Controllable"
                      : "Read only"}
                </StatusChip>
              </div>
              <MetricGrid
                items={[
                  {
                    label: "Host",
                    value: data.daemon?.host ?? data.health?.daemonStatus.host ?? "Unknown",
                    meta: data.daemon?.state ?? data.health?.daemonStatus.state ?? "unknown",
                  },
                  {
                    label: "PID",
                    value: String(data.daemon?.pid ?? data.health?.daemonStatus.pid ?? 0),
                    meta: `uptime ${formatDuration(data.daemon?.uptimeSeconds ?? data.health?.daemonStatus.uptimeSeconds ?? 0)}`,
                  },
                  {
                    label: "Memory used",
                    value: formatBytes(data.health?.systemVitals.memoryUsedBytes ?? 0),
                    meta: `process ${formatBytes(data.health?.systemVitals.processRssBytes ?? 0)}`,
                  },
                ]}
              />
              <div className="mc-next-runtime-actions">
                <button
                  type="button"
                  className="gc-button"
                  onClick={() => void runtime.runDaemonAction("start")}
                  disabled={runtime.daemonBusy !== null}
                >
                  {runtime.daemonBusy === "start" ? "Starting..." : "Start daemon"}
                </button>
                <button
                  type="button"
                  className="gc-button"
                  onClick={() => void runtime.runDaemonAction("restart")}
                  disabled={runtime.daemonBusy !== null}
                >
                  {runtime.daemonBusy === "restart" ? "Restarting..." : "Restart daemon"}
                </button>
                <button
                  type="button"
                  className="gc-button danger"
                  onClick={() => void runtime.runDaemonAction("stop")}
                  disabled={runtime.daemonBusy !== null}
                >
                  {runtime.daemonBusy === "stop" ? "Stopping..." : "Stop daemon"}
                </button>
                <button type="button" className="gc-button subtle" onClick={() => void runtime.reload()}>
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </button>
              </div>
            </NativeCard>
            <NativeCard
              title="Backups and integrations"
              subtitle="Recovery posture and connector runtime should stay visible together."
            >
              <NativeList
                items={[
                  ...(data.backups.slice(0, 5).map((backup) => ({
                    title: backup.backupId,
                    meta: "backup",
                    body: `${formatDateTime(backup.createdAt)} · ${backup.files.length} files`,
                  })) ?? []),
                  ...data.mcpServers.slice(0, 5).map((item) => ({
                    title: item.label,
                    meta: item.enabled ? "enabled" : "disabled",
                    body: `${item.transport} · ${item.category ?? "general"}`,
                  })),
                ]}
                emptyLabel="No backup or connector posture available."
              />
            </NativeCard>
          </NativeGrid>
        );
      case "diagnostics":
        return (
          <NativeGrid>
            <NativeCard
              title="Diagnostics directory"
              subtitle="System vitals, daemon logs, and MCP runtime posture without old admin sprawl."
              stats={[
                { label: "CPU", value: String(data.health?.systemVitals.cpuCount ?? 0) },
                { label: "Load", value: formatLoadAverage(data.health?.systemVitals.loadAverage ?? []) },
              ]}
            >
              <MetricGrid
                items={[
                  {
                    label: "Hostname",
                    value: data.health?.systemVitals.hostname ?? "Unknown",
                    meta: data.health?.systemVitals.platform ?? "Unknown platform",
                  },
                  {
                    label: "System uptime",
                    value: formatDuration(data.health?.systemVitals.uptimeSeconds ?? 0),
                    meta: data.health?.systemVitals.release ?? "Unknown release",
                  },
                  {
                    label: "Heap used",
                    value: formatBytes(data.health?.systemVitals.processHeapUsedBytes ?? 0),
                    meta: `Free ${formatBytes(data.health?.systemVitals.memoryFreeBytes ?? 0)}`,
                  },
                ]}
              />
              <NativeList
                items={(data.health?.daemonLogs.items ?? []).slice(0, 8).map((item) => ({
                  title: item.level.toUpperCase(),
                  meta: formatDateTime(item.timestamp),
                  body: item.message,
                }))}
                emptyLabel="No daemon logs available."
              />
            </NativeCard>
            <QuickJumpCard
              title="Diagnostics routes"
              subtitle="Keep operator movement inside canonical next routes."
              actions={[
                { label: "Runtime", route: { area: "ops", section: "runtime", theme: route.theme } },
                { label: "Prompt packs", route: { area: "library", section: "prompt-packs", theme: route.theme } },
                { label: "Approvals", route: { area: "ops", section: "approvals", theme: route.theme } },
              ]}
              navigate={navigate}
            />
          </NativeGrid>
        );
      case "notifications": {
        const items = [
          ...(data.dashboard?.pendingApprovals
            ? [
                {
                  title: "Approvals need review",
                  meta: `${data.dashboard.pendingApprovals} pending`,
                  body: "Risky or approval-gated work is waiting for an operator decision.",
                },
              ]
            : []),
          ...(data.sourceStatus.health.status === "ok" && !data.health?.daemonStatus.running
            ? [
                {
                  title: "Daemon needs intervention",
                  meta: data.health?.daemonStatus.state ?? "unknown",
                  body: "Self-repair can propose a recovery plan, but service changes remain approval-gated.",
                },
              ]
            : []),
          ...(data.timeline?.events.items ?? [])
            .filter((item) => /error|failed|repair|approval|runtime/i.test(item.eventType))
            .slice(0, 10)
            .map((item) => ({
              title: item.eventType,
              meta: item.eventClass ?? "event",
              body: item.timestamp ? formatDateTime(item.timestamp) : "No timestamp",
            })),
        ];
        return (
          <NativeGrid>
            <NativeCard
              title="Operator notifications"
              subtitle="Runtime issues and repair opportunities stay visible until the operator acts."
              stats={[
                { label: "Open", value: String(items.length) },
                { label: "Self-repair", value: "Approval-gated" },
              ]}
            >
              <NativeList items={items} emptyLabel="No operator notifications." />
            </NativeCard>
            <QuickJumpCard
              title="Act on notification"
              subtitle="Review the underlying surface before approving any repair or mutation."
              actions={[
                { label: "Approvals", route: { area: "ops", section: "approvals", theme: route.theme } },
                { label: "Runtime", route: { area: "ops", section: "runtime", theme: route.theme } },
                { label: "Improvement", route: { area: "ops", section: "improvement", theme: route.theme } },
              ]}
              navigate={navigate}
            />
          </NativeGrid>
        );
      }
      case "activity":
      default:
        return (
          <NativeGrid>
            <NativeCard
              title="Activity feed"
              subtitle="Recent events, scheduler pressure, and approval signal in one explicit operator view."
              stats={[
                { label: "Recent events", value: String(data.timeline?.events.items.length ?? 0) },
                { label: "Pending approvals", value: String(data.dashboard?.pendingApprovals ?? pendingApprovals) },
              ]}
            >
              <NativeList
                items={(data.timeline?.events.items ?? []).slice(0, 14).map((item) => ({
                  title: item.eventType,
                  meta: item.source,
                  body: formatDateTime(item.timestamp),
                }))}
                emptyLabel="No recent events."
              />
            </NativeCard>
            <NativeCard
              title="Operator posture"
              subtitle="Keep the highest-signal runtime facts close to the activity stream."
            >
              <MetricGrid
                items={[
                  {
                    label: "Active subagents",
                    value: String(data.dashboard?.activeSubagents ?? 0),
                    meta: "Concurrent work in motion",
                  },
                  {
                    label: "Scheduler queue",
                    value: String(data.timeline?.scheduler.reviewQueue.length ?? 0),
                    meta: "Items waiting on schedule/review",
                  },
                  {
                    label: "Daemon",
                    value: data.daemon?.running ? "running" : "stopped",
                    meta: data.daemon?.host ?? "Host unavailable",
                  },
                ]}
              />
            </NativeCard>
          </NativeGrid>
        );
    }
  }, [activeWorkspaceName, data, navigate, pendingApprovals, route.theme, runtime, section]);

  return (
    <NativePageFrame
      icon={section === "costs" ? Wallet : section === "runtime" ? Server : Activity}
      kicker="Ops"
      title={labelForOpsSection(section)}
      description={descriptionForOpsSection(section)}
      loading={runtime.loading}
      error={runtime.error}
    >
      {content}
    </NativePageFrame>
  );
}

function MetricGrid({ items }: { items: Array<{ label: string; value: string; meta?: string }> }) {
  return (
    <div className="mc-next-runtime-metric-grid">
      {items.map((item) => (
        <div key={`${item.label}-${item.value}`} className="mc-next-runtime-metric">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          {item.meta ? <p>{item.meta}</p> : null}
        </div>
      ))}
    </div>
  );
}

function labelForOpsSection(section: NonNullable<AppRoute["section"]>) {
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

function descriptionForOpsSection(section: NonNullable<AppRoute["section"]>) {
  switch (section) {
    case "sessions":
      return "Recent session evidence and operator posture in the canonical next shell.";
    case "schedules":
      return "Scheduled work and review queue pressure without the legacy wrapper stack.";
    case "improvement":
      return "Replay and improvement signals that stay visible to the operator.";
    case "notifications":
      return "Operator-facing runtime issues, approvals, and repair opportunities.";
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

function describeQmdImpact(efficiencyLabel?: "reduced" | "expanded" | "neutral") {
  switch (efficiencyLabel) {
    case "reduced":
      return "Reduced";
    case "expanded":
      return "Expanded";
    default:
      return "Stable";
  }
}

function formatTokenDelta(value: number) {
  if (!Number.isFinite(value) || value === 0) {
    return "no token delta";
  }
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded} tokens` : `${rounded} tokens`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0m";
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "Unknown";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "Unknown";
  }
  return new Date(parsed).toLocaleString();
}

function sourceFailed(data: { sourceStatus: Record<string, { status: "ok" | "error" }> }, source: string): boolean {
  return data.sourceStatus[source]?.status === "error";
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let current = value;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(current >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatLoadAverage(values: number[]) {
  if (!values.length) {
    return "n/a";
  }
  return values
    .slice(0, 3)
    .map((value) => value.toFixed(2))
    .join(" / ");
}
