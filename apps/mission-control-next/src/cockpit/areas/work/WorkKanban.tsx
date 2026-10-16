import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { buildAppHref, getRouteReleaseScope, parseAppRoute } from "../../../app/route-model";
import { useProjectAccess } from "@goatcitadel/mission-control-shared/hooks/use-current-access";
import { RunDetailRoutePage } from "../../../features/native-routes/ops/RunDetailRoutePage";
import { ReleaseScopeBadge } from "../../../features/native-routes/NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../../../features/native-routes/types";
import { KanbanRoutePage } from "../../../features/native-routes/ops/KanbanRoutePage";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_COLUMN } from "../../ui/area-layout";
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
      {/* The classic owner below keeps its own page header; this one carries the Work tabs. */}
      <div className={`${AREA_COLUMN} flex flex-col gap-3 px-4 pt-4 sm:px-6 sm:pt-6`}>
        {/* On a run, the embedded run page drops its own h1, so the header names the run the way that page did. */}
        <AreaHeader
          title={
            route.runId || route.view === "run-detail"
              ? route.runId
                ? `Run ${route.runId}`
                : "Run detail"
              : "Classic Kanban"
          }
          description={
            route.runId || route.view === "run-detail"
              ? "A run opened from the classic Kanban, with its saved steps and outcome."
              : "The full task Kanban from the classic view, with advanced task actions."
          }
        />
        <p className="text-sm text-fg-secondary">
          {"Runs keep their saved state; editing a task does not start or prove a run. "}
          <NativeOwnerLink href="/work/archive" scope={workspaceId}>
            Archived tasks
          </NativeOwnerLink>
        </p>
      </div>
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
