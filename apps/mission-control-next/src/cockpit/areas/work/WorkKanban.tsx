import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { buildAppHref, getRouteReleaseScope, parseAppRoute } from "../../../app/route-model";
import { useProjectAccess } from "@goatcitadel/mission-control-shared/hooks/use-current-access";
import { RunDetailRoutePage } from "../../../features/native-routes/ops/RunDetailRoutePage";
import { ReleaseScopeBadge } from "../../../features/native-routes/NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../../../features/native-routes/types";
import { KanbanRoutePage } from "../../../features/native-routes/ops/KanbanRoutePage";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useActiveWorkspaceLabel } from "../../data/use-workspace-name";
import { WorkArchive } from "./WorkArchive";

/** Reuse the revision-aware action owner and its self-contained native styles. */
export function WorkKanban() {
  const { activeWorkspaceId, activeCitadelId, setActiveWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const workspaceLabel = useActiveWorkspaceLabel();
  const location = useCockpitRoute();
  const route = parseAppRoute(new URL("/ops/kanban" + location.search + location.hash, "http://cockpit.invalid"));
  const taskId = new URLSearchParams(location.search).get("taskId");
  const access = useProjectAccess(JSON.stringify(["work-kanban", activeCitadelId, workspaceId, taskId]));
  const props: NativeRoutePagesProps = {
    activeWorkspaceId: workspaceId,
    activeWorkspaceName: workspaceLabel,
    activeCitadelId: activeCitadelId ?? undefined,
    pendingApprovals: 0,
    setActiveWorkspaceId,
    route,
    navigate: (next, options) => location.navigate(buildAppHref(next), options),
  };
  return (
    <section className="min-w-0">
      <p className="p-4 text-sm text-fg-secondary">
        {
          "Advanced operator task actions. Runtime runs retain their recorded state; task edits do not prove execution. "
        }
        <NativeOwnerLink href="/work/archive" scope={workspaceId}>
          Archived tasks
        </NativeOwnerLink>
      </p>
      {route.runId || route.view === "run-detail" ? (
        <>
          <ReleaseScopeBadge status={getRouteReleaseScope(route).status} />
          <RunDetailRoutePage key={access.identity} {...props} />
        </>
      ) : (
        <KanbanRoutePage key={access.identity} {...props} />
      )}
    </section>
  );
}

export { WorkArchive };
