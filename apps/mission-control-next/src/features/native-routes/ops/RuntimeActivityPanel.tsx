import { OpsNeedsAttentionCard } from "./RuntimeOverviewPanels";
import { buildNeedsAttentionItems, runtimeEventKey, sourceFailed } from "./runtime-overview-model";
import { toneForActivityEvent, formatActivityAge } from "./runtime-formatters";
import { presentEventClass, presentEventType } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { EmptyState, NativeMetricGrid as MetricGrid, ThreePartChip } from "../primitives";
import { NativeCard, NativeDisclosureCard, NativeGrid } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import type { OpsRuntimeData } from "./runtime-overview-model";
import type { RuntimePanelSetter, RuntimeOpenInspection } from "./runtime-panel-types";

export function RuntimeActivityPanel({
  data,
  pendingApprovals,
  activityFilter,
  setActivityFilter,
  openInspection,
  navigate,
  route,
}: {
  data: OpsRuntimeData;
  pendingApprovals: number;
  activityFilter: "all" | "errors" | "approvals" | "runtime";
  setActivityFilter: RuntimePanelSetter<"all" | "errors" | "approvals" | "runtime">;
  openInspection: RuntimeOpenInspection;
  navigate: NativeRoutePagesProps["navigate"];
  route: NativeRoutePagesProps["route"];
}) {
  const daemonSourceUnavailable = sourceFailed(data, "daemon");
  const healthSourceUnavailable = sourceFailed(data, "health");
  const daemonRuntimeUnavailable = daemonSourceUnavailable && healthSourceUnavailable;
  // `daemonStatus`/`systemVitals`/`costs`/`daemonLogs` (health) and
  // `scheduler`/`improvement`/`events` (timeline) are required by their
  // response contracts, but a partial gateway response (e.g. a stub
  // returning {}) can omit them at runtime — and sourceFailed() only trips
  // on fetch errors, not a 200 with an empty body. Chain through every hop
  // and fall back to inert defaults, here and in the helpers below.
  const daemonRunning = daemonRuntimeUnavailable
    ? null
    : (data.daemon?.running ?? data.health?.daemonStatus?.running ?? null);
  const daemonHost = daemonRuntimeUnavailable
    ? "unavailable"
    : (data.daemon?.host ?? data.health?.daemonStatus?.host ?? "Unknown");
  const filteredActivityEvents = (data.timeline?.events?.items ?? []).filter((item) => {
    if (activityFilter === "errors") {
      return /error|failed|failure|degraded/i.test(`${item.eventType} ${item.eventClass ?? ""}`);
    }
    if (activityFilter === "approvals") {
      return /approval|review|decision/i.test(`${item.eventType} ${item.eventClass ?? ""}`);
    }
    if (activityFilter === "runtime") {
      const runtimePattern = /runtime|daemon|mcp|schedule|durable|worker|health|lifecycle/i;
      const runtimeSourcePattern = /runtime|daemon|mcp|schedule|durable|health|lifecycle/i;
      const runtimeEvent = runtimePattern.test(item.eventType);
      const runtimeSourceEvent = runtimeSourcePattern.test(item.source);
      const gatewayRuntimeEvent = item.source === "gateway" && runtimePattern.test(item.eventType);
      return runtimeEvent || runtimeSourceEvent || gatewayRuntimeEvent;
    }
    return true;
  });
  const needsAttentionItems = buildNeedsAttentionItems(data, pendingApprovals, route.theme);

  return (
    <NativeGrid>
      <OpsNeedsAttentionCard items={needsAttentionItems} navigate={navigate} />
      <NativeCard
        title="Activity feed"
        subtitle="Recent events, scheduler pressure, and approval signal in one explicit operator view."
        density="compact"
        stats={[
          { label: "Recent events", value: String(filteredActivityEvents.length) },
          { label: "Pending approvals", value: String(data.dashboard?.pendingApprovals ?? pendingApprovals) },
        ]}
      >
        <div className="mc-next-settings-filter-bar" role="radiogroup" aria-label="Activity feed filter">
          {[
            { id: "all", label: "All" },
            { id: "errors", label: "Errors" },
            { id: "approvals", label: "Approvals" },
            { id: "runtime", label: "Runtime" },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={activityFilter === item.id}
              className={`mc-next-settings-filter${activityFilter === item.id ? " active" : ""}`}
              onClick={() => setActivityFilter(item.id as typeof activityFilter)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {filteredActivityEvents.length === 0 ? (
          <EmptyState size="compact" title="No recent events." />
        ) : (
          <div role="log" aria-label="Activity feed" aria-live="polite" aria-relevant="additions" aria-atomic="false">
            <ul className="mc-next-activity-feed" data-native-scroll="true">
              {filteredActivityEvents.map((item) => (
                <li key={runtimeEventKey(item)} className="mc-next-activity-feed-row">
                  <button
                    type="button"
                    className="mc-next-activity-record"
                    aria-label={`Inspect activity event ${item.eventType}`}
                    onClick={() => openInspection("event", runtimeEventKey(item))}
                  >
                    <ThreePartChip
                      tone={toneForActivityEvent(item.eventType, item.eventClass)}
                      state={presentEventType(item.eventType)}
                      mid={presentEventClass(item.eventClass)}
                      age={formatActivityAge(item.timestamp)}
                    />
                    <span className="mc-next-activity-feed-source mc-next-technical-detail">
                      {item.eventType}
                      {item.source ? ` / ${item.source}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </NativeCard>
      <NativeDisclosureCard
        id={"operator-posture"}
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
              value: String(data.timeline?.scheduler?.reviewQueue?.length ?? 0),
              meta: "Items waiting on schedule/review",
            },
            {
              label: "Daemon",
              value: daemonRunning === null ? "unavailable" : daemonRunning ? "running" : "stopped",
              meta: daemonHost,
            },
          ]}
        />
      </NativeDisclosureCard>
    </NativeGrid>
  );
}
