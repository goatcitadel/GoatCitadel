import { ImprovementInboxPanel } from "./RuntimeImprovementInboxPanel";
import { formatDateTime } from "./runtime-formatters";
import { NativeButton } from "../primitives";
import { NativeCard, NativeDisclosureCard, NativeGrid, NativeList } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import type { OpsRuntimeData } from "./runtime-overview-model";
import type { RuntimeOpenInspection } from "./runtime-panel-types";

export function RuntimeImprovementPanel({
  activeWorkspaceId,
  route,
  navigate,
  data,
  openInspection,
}: {
  activeWorkspaceId: string;
  route: NativeRoutePagesProps["route"];
  navigate: NativeRoutePagesProps["navigate"];
  data: OpsRuntimeData;
  openInspection: RuntimeOpenInspection;
}) {
  return (
    <NativeGrid>
      <ImprovementInboxPanel
        key={activeWorkspaceId}
        workspaceId={activeWorkspaceId}
        routeTheme={route.theme}
        navigate={navigate}
      />
      <NativeCard
        title="Improvement reports"
        subtitle="Recent improvement outputs and replay-linked evidence."
        stats={[
          { label: "Reports", value: String(data.timeline?.improvement?.reports?.length ?? 0) },
          { label: "Replay runs", value: String(data.timeline?.improvement?.replayRuns?.length ?? 0) },
        ]}
      >
        <NativeList
          items={(data.timeline?.improvement?.reports ?? []).map((item) => ({
            title: item.title || item.reportId,
            meta: item.runId ?? "report",
            body: item.createdAt ? formatDateTime(item.createdAt) : "No timestamp",
            actions: (
              <NativeButton variant="outline" onClick={() => openInspection("report", item.reportId)}>
                Review report
              </NativeButton>
            ),
          }))}
          emptyLabel="No improvement reports yet."
        />
      </NativeCard>
      <NativeDisclosureCard
        id={"replay-posture"}
        title="Replay posture"
        subtitle="Replay-linked runs should stay explicit, not disappear into a generic activity feed."
      >
        <NativeList
          items={(data.timeline?.improvement?.replayRuns ?? []).map((item) => ({
            title: item.runId,
            meta: item.status ?? "unknown",
            body: item.updatedAt ? formatDateTime(item.updatedAt) : formatDateTime(item.createdAt),
            actions: (
              <NativeButton variant="outline" onClick={() => openInspection("replay", item.runId)}>
                Inspect replay
              </NativeButton>
            ),
          }))}
          emptyLabel="No replay runs yet."
        />
      </NativeDisclosureCard>
    </NativeGrid>
  );
}
