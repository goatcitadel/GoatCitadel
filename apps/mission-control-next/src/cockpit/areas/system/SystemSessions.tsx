import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useOpsRuntimeSnapshot } from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import { useProjectAccess } from "@goatcitadel/mission-control-shared/hooks/use-current-access";
import { buildAppHref, getRouteReleaseScope, parseAppRoute } from "../../../app/route-model";
import { ReleaseScopeBadge } from "../../../features/native-routes/NativeRoutePageLayout";
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
import { EmptyState } from "../../ui/EmptyState";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
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
    <section className="min-w-0">
      <div className={AREA_PAGE}>
        {/* The embedded run page drops its own h1, so the header names the selected run the way that page did. */}
        <AreaHeader
          title={route.runId ? `Run ${route.runId}` : "Run detail"}
          description="A run opened from Sessions, with its saved steps and outcome."
        />
      </div>
      <RunDetailRoutePage key={access.identity} {...props} />
    </section>
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
    <section className={AREA_PAGE}>
      <AreaHeader
        title="Sessions"
        description="Recent conversation details, with controls for the selected Chat session."
        actions={
          <Button size="sm" disabled={runtime.loading} onClick={() => void runtime.reload()}>
            Refresh sessions
          </Button>
        }
      >
        <ReleaseScopeBadge status={getRouteReleaseScope(props.route).status} />
      </AreaHeader>
      {runtime.error ? (
        <EmptyState
          title="Sessions unavailable"
          description={runtime.error}
          action={<Button onClick={() => void runtime.reload()}>Try again</Button>}
        />
      ) : runtime.loading && !data ? (
        <p className="text-sm text-fg-muted">Loading sessions…</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
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
            <p className="text-sm text-fg-muted">Choose a session's Details to see its recorded fields and controls.</p>
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
        </div>
      )}
    </section>
  );
}
