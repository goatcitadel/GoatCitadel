import type { RecentCrossProjectSession } from "@goatcitadel/contracts";
import { useCrossProjectRecentSessions } from "@goatcitadel/mission-control-shared/hooks/useCrossProjectRecentSessions";
import type { AppRoute } from "@next/app/route-model";
import { NativeCard } from "../NativeRoutePageLayout";
import { EmptyState } from "../primitives";
import type { NativeRoutePagesProps } from "../types";
import { formatDateTime, labelForMode } from "./ProjectsRoutePage.helpers";

export function RecentCrossProjectSessionsRow({
  workspaceId,
  route,
  navigate,
}: {
  workspaceId: string;
  route: AppRoute;
  navigate: NativeRoutePagesProps["navigate"];
}) {
  const { items, loading, error } = useCrossProjectRecentSessions(workspaceId, { limit: 4 });
  const subtitle = "Pick up where you left off — recent sessions across all projects, ordered by last activity.";

  if (loading) {
    return (
      <NativeCard title="Pick up where you left off" subtitle="Loading recent sessions across all projects…">
        <EmptyState title="Loading…" size="compact" />
      </NativeCard>
    );
  }
  if (error) {
    return (
      <NativeCard title="Pick up where you left off" subtitle="Could not load recent sessions.">
        <EmptyState title={error} size="compact" />
      </NativeCard>
    );
  }
  if (!items.length) {
    return (
      <NativeCard title="Pick up where you left off" subtitle={subtitle}>
        <EmptyState title="No recent project sessions yet." size="compact" />
      </NativeCard>
    );
  }
  return (
    <NativeCard title="Pick up where you left off" subtitle={subtitle}>
      <div className="mc-next-project-recents-grid" role="list">
        {items.map((item) => (
          <RecentCrossProjectCard
            key={item.sessionId}
            item={item}
            onOpen={() =>
              navigate({
                area: item.mode,
                sessionId: item.sessionId,
                projectId: item.projectId,
                theme: route.theme,
              })
            }
          />
        ))}
      </div>
    </NativeCard>
  );
}

function RecentCrossProjectCard({ item, onOpen }: { item: RecentCrossProjectSession; onOpen: () => void }) {
  const title = item.title?.trim() || item.sessionKey;
  return (
    <div className="mc-next-project-recent-card-item" role="listitem">
      <button type="button" className="mc-next-project-recent-card" onClick={onOpen}>
        <span className={`mc-next-mode-chip mode-${item.mode}`}>{labelForMode(item.mode)}</span>
        <strong>{title}</strong>
        <span className="mc-next-project-recent-meta">
          {item.projectLabel} · {formatDateTime(item.lastActivityAt)}
        </span>
      </button>
    </div>
  );
}
