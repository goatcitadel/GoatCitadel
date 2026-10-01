import { OpsNeedsAttentionCard } from "./RuntimeOverviewPanels";
import { buildNeedsAttentionItems, runtimeEventKey, sourceFailed } from "./runtime-overview-model";
import { capitalize, humanizeEventLabel, formatDateTime } from "./runtime-formatters";
import { DetailInspector } from "../../../components/DetailInspector";
import { NativeButton, NoticeBanner } from "../primitives";
import { NativeCard, NativeGrid, NativeList, QuickJumpCard } from "../NativeRoutePageLayout";
import { NotificationRoutingPanel } from "../settings/sections/NotificationRoutingPanel";
import type { NativeRoutePagesProps } from "../types";
import type { OpsRuntimeData } from "./runtime-overview-model";
import type { RuntimePanelSetter, RuntimeOpenInspection } from "./runtime-panel-types";

export function RuntimeNotificationsPanel({
  data,
  notificationFilter,
  readNotifications,
  setReadNotifications,
  openInspection,
  navigate,
  setNotificationFilter,
  setSupportPanel,
  supportPanel,
  activeWorkspaceId,
  route,
  pendingApprovals,
}: {
  data: OpsRuntimeData;
  notificationFilter: "all" | "unread" | "read";
  readNotifications: string[];
  setReadNotifications: RuntimePanelSetter<string[]>;
  openInspection: RuntimeOpenInspection;
  navigate: NativeRoutePagesProps["navigate"];
  setNotificationFilter: RuntimePanelSetter<"all" | "unread" | "read">;
  setSupportPanel: RuntimePanelSetter<string | null>;
  supportPanel: string | null;
  activeWorkspaceId: string;
  route: NativeRoutePagesProps["route"];
  pendingApprovals: number;
}) {
  const needsAttentionItems = buildNeedsAttentionItems(data, pendingApprovals, route.theme);

  const signalEvents = (data.timeline?.events?.items ?? []).filter(
    (item) => /error|failed|repair|runtime/i.test(item.eventType) && !/approval/i.test(item.eventType),
  );
  const notificationSignals = signalEvents
    .filter(
      (item) =>
        notificationFilter === "all" ||
        readNotifications.includes(runtimeEventKey(item)) === (notificationFilter === "read"),
    )
    .map((item) => ({
      title: humanizeEventLabel(item.eventType),
      meta: [
        item.source,
        formatDateTime(item.timestamp),
        readNotifications.includes(runtimeEventKey(item)) ? "Read" : "Unread",
      ]
        .filter(Boolean)
        .join(" · "),
      actions: (
        <NativeButton
          variant="outline"
          onClick={() => {
            const id = runtimeEventKey(item);
            setReadNotifications((current) => (current.includes(id) ? current : [...current, id]));
            openInspection("event", id);
          }}
        >
          Review notification
        </NativeButton>
      ),
    }));
  return (
    <NativeGrid>
      <OpsNeedsAttentionCard items={needsAttentionItems} navigate={navigate} />
      {data.sourceStatus.health.status === "ok" && data.health?.daemonStatus?.running === false ? (
        <NoticeBanner
          tone="warning"
          message="Daemon needs intervention. Review Runtime for recovery actions; reading notifications does not repair the service."
        />
      ) : null}
      {data.health?.daemonStatus?.running === undefined ? (
        <NoticeBanner
          tone="warning"
          message="Daemon status unavailable. Review Runtime for current service evidence."
        />
      ) : null}
      <NativeCard
        title="Notification signals"
        subtitle="Retained runtime issues and repair signals. Read status applies to this app session."
        stats={[
          { label: "Signals", value: String(notificationSignals.length) },
          { label: "Self-repair", value: "Approval-gated" },
        ]}
      >
        <div className="mc-next-settings-filter-bar" role="group" aria-label="Notification read filter">
          {(["all", "unread", "read"] as const).map((filter) => (
            <NativeButton
              key={filter}
              variant="ghost"
              aria-pressed={notificationFilter === filter}
              onClick={() => setNotificationFilter(filter)}
            >
              {capitalize(filter)}
            </NativeButton>
          ))}
        </div>
        <NativeList
          virtualized
          items={notificationSignals}
          emptyLabel={
            sourceFailed(data, "timeline")
              ? "Notification signals unavailable."
              : notificationFilter === "all"
                ? "No operator notification signals."
                : `No ${notificationFilter} signals in the returned records.`
          }
        />
        <p className="mc-next-help-text">Reading a notice does not resolve its underlying failure or approval.</p>
      </NativeCard>
      <NativeButton variant="outline" onClick={() => setSupportPanel("routing")}>
        Notification routing
      </NativeButton>
      <DetailInspector
        open={supportPanel === "routing"}
        title="Notification routing"
        onClose={() => setSupportPanel(null)}
      >
        <NotificationRoutingPanel workspaceId={activeWorkspaceId} channels={[]} defaultTargetKind="https_webhook" />
      </DetailInspector>
      <QuickJumpCard
        title="Act on exception"
        subtitle="Review the canonical surface before approving repair, schedule, or runtime mutation."
        actions={[
          { label: "Approvals", route: { area: "ops", section: "approvals", theme: route.theme } },
          { label: "Activity", route: { area: "ops", section: "activity", theme: route.theme } },
          { label: "Runtime", route: { area: "ops", section: "runtime", theme: route.theme } },
        ]}
        navigate={navigate}
      />
    </NativeGrid>
  );
}
