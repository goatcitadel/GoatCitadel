import { formatHumanSessionTitle, formatShortSessionId, formatDateTime } from "./runtime-formatters";
import { NativeButton, NativeMetricGrid as MetricGrid } from "../primitives";
import { NativeCard, NativeDisclosureCard, NativeGrid, NativeList } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import type { OpsRuntimeData } from "./runtime-overview-model";
import type { RuntimeOpenInspection } from "./runtime-panel-types";

export function RuntimeSessionsPanel({
  data,
  activeWorkspaceName,
  navigate,
  route,
  openInspection,
  pendingApprovals,
}: {
  data: OpsRuntimeData;
  activeWorkspaceName: string;
  navigate: NativeRoutePagesProps["navigate"];
  route: NativeRoutePagesProps["route"];
  openInspection: RuntimeOpenInspection;
  pendingApprovals: number;
}) {
  return (
    <NativeGrid>
      <NativeCard
        title="Session evidence"
        subtitle="Recent session posture, channel mix, and operator-ready evidence."
        density="compact"
        stats={[
          { label: "Visible", value: String(data.sessions.length || data.dashboard?.sessions?.length || 0) },
          { label: "Workspace", value: activeWorkspaceName },
        ]}
      >
        <NativeList
          items={(data.sessions.length ? data.sessions : (data.dashboard?.sessions ?? [])).map((item) => ({
            title: formatHumanSessionTitle(item),
            meta: item.channel,
            body: `${formatDateTime(item.lastActivityAt)} · ${formatShortSessionId(item.sessionId)}`,
            actions: (
              <>
                <NativeButton onClick={() => navigate({ area: "chat", sessionId: item.sessionId, theme: route.theme })}>
                  Open Chat
                </NativeButton>
                <NativeButton
                  variant="outline"
                  aria-label={`Inspect ${formatHumanSessionTitle(item)}`}
                  onClick={() => openInspection("session", item.sessionId)}
                >
                  Details
                </NativeButton>
              </>
            ),
          }))}
          emptyLabel="No recent sessions."
          density="compact"
          maxHeight="min(54vh, 31rem)"
          ariaLabel="Session evidence"
        />
      </NativeCard>
      {
        <button
          type="button"
          className="mc-next-settings-filter"
          onClick={() =>
            navigate({
              area: "ops",
              section: "sessions",
              view: "browser-sessions",
              theme: route.theme,
            })
          }
        >
          Browser Sessions
        </button>
      }
      <NativeDisclosureCard
        id={"session-posture"}
        title="Session posture"
        subtitle="Keep session truth next to approvals and activity in one operator view."
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
              value: String(data.dashboard?.recentEvents?.length ?? 0),
              meta: "Signals attached to current posture",
            },
          ]}
        />
      </NativeDisclosureCard>
    </NativeGrid>
  );
}
