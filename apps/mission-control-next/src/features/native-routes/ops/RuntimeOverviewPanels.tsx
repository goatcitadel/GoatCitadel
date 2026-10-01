import { RefreshCw } from "lucide-react";
import type { AppRoute } from "@next/app/route-model";
import { NativeCard } from "../NativeRoutePageLayout";
import {
  EmptyState,
  ErrorState,
  NativeButton,
  NativeMetricGrid as MetricGrid,
  StatusChip,
  ThreePartChip,
  type StatusChipTone,
} from "../primitives";
import {
  describeOpsDegradedSources,
  sourceFailed,
  type OpsAttentionItem,
  type OpsDegradedSource,
  type OpsRuntimeData,
} from "./runtime-overview-model";
import { formatCostMetric, readCurrentDayCostCompleteness } from "./runtime-spend-model";

/**
 * WS-D2 hero posture lead. Surfaces the single most important runtime truth the
 * route already computes — gateway/runtime readiness — with serving posture and
 * day spend as supporting facts. Reuses the same daemon/health/cost fields the
 * Runtime posture card and head metrics render; it adds no new data source.
 */
export function RuntimeHeroLead({
  data,
  pendingApprovals,
  compact,
}: {
  data: OpsRuntimeData;
  pendingApprovals: number;
  compact: boolean;
}) {
  const daemonRuntimeUnavailable = sourceFailed(data, "daemon") && sourceFailed(data, "health");
  const daemonRunning = daemonRuntimeUnavailable
    ? null
    : (data.daemon?.running ?? data.health?.daemonStatus?.running ?? null);
  const daemonHost = daemonRuntimeUnavailable
    ? "unavailable"
    : (data.daemon?.host ?? data.health?.daemonStatus?.host ?? "Unknown");
  const daemonState = daemonRuntimeUnavailable
    ? "unavailable"
    : (data.daemon?.state ?? data.health?.daemonStatus?.state ?? "unknown");
  const mcpCount = data.sourceStatus.mcpServers.status === "ok" ? data.mcpServers.length : null;
  const pendingApprovalCount = data.dashboard?.pendingApprovals ?? pendingApprovals;
  const daySpend = formatCostMetric(data.dashboard?.dailyCostUsd, readCurrentDayCostCompleteness(data));

  const readinessLine = daemonRuntimeUnavailable
    ? "Runtime control truth is unavailable — inspect the daemon and health sources."
    : daemonRunning
      ? "The runtime reports a running daemon."
      : "Gateway runtime is reachable, but the daemon is stopped.";
  const readinessTone: StatusChipTone = daemonRuntimeUnavailable ? "critical" : daemonRunning ? "success" : "warning";

  const metrics = [
    {
      label: "Serving posture",
      value: daemonRunning === null ? "unavailable" : daemonRunning ? "running" : "stopped",
      meta: `${daemonHost} · ${daemonState}`,
    },
    {
      label: "Day spend",
      value: daySpend,
      meta: "Dashboard daily total",
    },
    {
      label: "Connectors",
      value: mcpCount === null ? "unavailable" : String(mcpCount),
      meta: "MCP runtime servers",
    },
  ];

  return (
    <div className={`mc-next-runtime-hero-lead${compact ? " is-compact" : ""}`}>
      <div className="mc-next-runtime-chip-row">
        <StatusChip tone={readinessTone}>
          {daemonRuntimeUnavailable ? "Runtime unavailable" : daemonRunning ? "Runtime ready" : "Daemon stopped"}
        </StatusChip>
        <StatusChip tone={mcpCount !== null && mcpCount > 0 ? "default" : "muted"}>
          {mcpCount === null ? "MCP evidence not loaded" : `${mcpCount} MCP configured`}
        </StatusChip>
        <StatusChip tone={pendingApprovalCount > 0 ? "warning" : "muted"}>
          {pendingApprovalCount} pending {pendingApprovalCount === 1 ? "approval" : "approvals"}
        </StatusChip>
      </div>
      <p className="mc-next-settings-field-note">{readinessLine}</p>
      {compact ? (
        <details className="mc-next-runtime-hero-details">
          <summary>Runtime details</summary>
          <MetricGrid items={metrics} />
        </details>
      ) : (
        <MetricGrid items={metrics} />
      )}
    </div>
  );
}

export function OpsNeedsAttentionCard({
  items,
  navigate,
}: {
  items: OpsAttentionItem[];
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
}) {
  return (
    <NativeCard
      title="Needs attention"
      subtitle="The exception inbox for decisions, runtime issues, stale recovery signals, and spend coverage."
      density="compact"
      stats={[{ label: "Open", value: String(items.length) }]}
    >
      {items.length === 0 ? (
        <EmptyState size="compact" title="No operator attention items right now." />
      ) : (
        <ul className="mc-next-ops-attention-list" aria-label="Needs attention">
          {items.map((item) => (
            <li key={item.id} className={`mc-next-ops-attention-item tone-${item.tone}`}>
              <div className="mc-next-ops-attention-copy">
                <ThreePartChip tone={item.tone} state={item.meta} mid={item.title} age="" />
                <p>{item.body}</p>
              </div>
              <div className="mc-next-ops-attention-actions">
                <NativeButton variant="outline" onClick={() => navigate(item.primaryRoute)}>
                  {item.primaryLabel}
                </NativeButton>
                <NativeButton variant="outline" className="subtle" onClick={() => navigate(item.inspectRoute)}>
                  {item.inspectLabel}
                </NativeButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </NativeCard>
  );
}

export function OpsDegradedSourcesStrip({
  degraded,
  onRetry,
  retrying,
}: {
  degraded: OpsDegradedSource[];
  onRetry: () => void;
  retrying: boolean;
}) {
  if (degraded.length === 0) {
    return null;
  }
  return (
    <ErrorState
      size="inline"
      tone="danger"
      title="Live runtime data is degraded"
      description={describeOpsDegradedSources(degraded)}
      primaryAction={
        <NativeButton variant="outline" onClick={onRetry} disabled={retrying}>
          <RefreshCw size={16} />
          {retrying ? "Retrying..." : "Retry"}
        </NativeButton>
      }
    />
  );
}
