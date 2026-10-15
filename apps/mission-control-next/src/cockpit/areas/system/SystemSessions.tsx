import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useOpsRuntimeSnapshot } from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import { useProjectAccess } from "@goatcitadel/mission-control-shared/hooks/use-current-access";
import { buildAppHref, getRouteReleaseScope, parseAppRoute, routeKicker } from "../../../app/route-model";
import { NativePageFrame } from "../../../features/native-routes/NativeRoutePageLayout";
import { RuntimeSessionsPanel } from "../../../features/native-routes/ops/RuntimeSessionsPanel";
import { RuntimeRecordInspector } from "../../../features/native-routes/ops/RuntimeRecordInspector";
import { RunDetailRoutePage } from "../../../features/native-routes/ops/RunDetailRoutePage";
import { OpsDegradedSourcesStrip } from "../../../features/native-routes/ops/RuntimeOverviewPanels";
import { buildSectionDegradedSources } from "../../../features/native-routes/ops/runtime-overview-model";
import type { RuntimeInspection } from "../../../features/native-routes/ops/runtime-panel-types";
import type { NativeRoutePagesProps } from "../../../features/native-routes/types";
import { SessionControlManager } from "../chat/SessionControlManager";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import "../../../features/native-routes/native-routes.css";

/** Session lists are installation-wide metadata; only the canonical control owner admits mutations. */
export function SystemSessions() {
  const preferences = useUiPreferences(),
    location = useCockpitRoute();
  const workspaceId = preferences.activeWorkspaceId ?? "default";
  const access = useProjectAccess(JSON.stringify(["system-sessions", preferences.activeCitadelId, workspaceId]));
  const route = parseAppRoute(new URL("/ops/sessions" + location.search + location.hash, "http://cockpit.invalid"));
  const props: NativeRoutePagesProps = {
    route,
    activeWorkspaceId: workspaceId,
    activeWorkspaceName: workspaceId,
    activeCitadelId: preferences.activeCitadelId ?? undefined,
    pendingApprovals: 0,
    setActiveWorkspaceId: preferences.setActiveWorkspaceId,
    navigate: (next, options) => location.navigate(buildAppHref(next), options),
  };
  return route.runId || route.view === "run-detail" ? (
    <RunDetailRoutePage key={access.identity} {...props} />
  ) : (
    <SystemSessionEvidence key={access.identity} {...props} location={location} />
  );
}

const noChange = () => undefined;
const noScheduleAction = async () => undefined;
function SystemSessionEvidence({
  location,
  ...props
}: NativeRoutePagesProps & { location: ReturnType<typeof useCockpitRoute> }) {
  const runtime = useOpsRuntimeSnapshot("sessions", { requestedSources: ["sessions"] });
  const data = runtime.data,
    sessionId = props.route.sessionId;
  const inspection: RuntimeInspection | null = sessionId
    ? { scope: props.activeWorkspaceId, kind: "session", id: sessionId }
    : null;
  const selectSession = (id: string | null) => {
    const url = new URL("/system/sessions" + location.search + location.hash, "http://cockpit.invalid");
    if (id) url.searchParams.set("sessionId", id);
    else url.searchParams.delete("sessionId");
    location.navigate(url.pathname + url.search + url.hash);
  };
  return (
    <section className="min-w-0 p-4 sm:p-6">
      <NativePageFrame
        kicker={routeKicker(props.route)}
        title="Sessions"
        description="Recent conversation metadata and canonical control for a selected Chat session."
        area="ops"
        loading={runtime.loading}
        error={runtime.error}
        releaseStatus={getRouteReleaseScope(props.route).status}
        onRetry={() => void runtime.reload()}
        actions={
          <Button size="sm" disabled={runtime.loading} onClick={() => void runtime.reload()}>
            Refresh sessions
          </Button>
        }
      >
        <OpsDegradedSourcesStrip
          degraded={data ? buildSectionDegradedSources(data, "sessions") : []}
          onRetry={() => void runtime.reload()}
          retrying={runtime.loading}
        />
        {data ? (
          <RuntimeSessionsPanel
            {...props}
            data={data}
            openInspection={(kind, id) => {
              if (kind === "session") selectSession(id);
            }}
          />
        ) : null}
        {sessionId ? (
          <SessionControlManager key={sessionId} sessionId={sessionId} workspaceId={props.activeWorkspaceId} />
        ) : (
          <p className="text-sm text-fg-muted">
            Choose a session's Details to inspect its recorded fields and canonical control.
          </p>
        )}
        {/* This inspector is admitted only for session metadata; schedule and notification actions have separate owners. */}
        <RuntimeRecordInspector
          {...props}
          inspection={inspection}
          setInspection={(next) => {
            const selection = typeof next === "function" ? next(inspection) : next;
            selectSession(selection?.kind === "session" ? selection.id : null);
          }}
          data={data}
          runtime={runtime}
          section="sessions"
          setReadNotifications={noChange}
          handleRunSchedule={noScheduleAction}
          handleCancelSchedule={noScheduleAction}
          scheduleBusy={null}
          schedulePendingCancelId={null}
          setSchedulePendingCancelId={noChange}
          scheduleNotice={null}
        />
      </NativePageFrame>
    </section>
  );
}
