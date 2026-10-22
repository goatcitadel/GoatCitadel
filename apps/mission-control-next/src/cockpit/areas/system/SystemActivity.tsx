import { useState } from "react";
import { SystemOwnerLink } from "./SystemOwnerLink";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { fetchRealtimeEvents } from "@goatcitadel/mission-control-shared/api/system";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useEventStreamStatus } from "@goatcitadel/mission-control-shared/hooks/useEventStreamStatus";
import { presentEventClass } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { ACTIVITY_FALLBACK_MS } from "../../data/activity-feed";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { RecentSessions } from "./RecentSessions";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import {
  activityMetadata,
  activityOwnerPath,
  activityRunLabel,
  collapseActivity,
  describeActivity,
  type ActivityRow,
} from "./activity-sentences";

export const SHOW_BACKGROUND_KEY = "goatcitadel.cockpit.activity.background";

function readShowBackground(): boolean {
  try {
    return window.sessionStorage.getItem(SHOW_BACKGROUND_KEY) === "true";
  } catch {
    return false;
  }
}

function writeShowBackground(value: boolean): void {
  try {
    window.sessionStorage.setItem(SHOW_BACKGROUND_KEY, String(value));
  } catch {
    // Best-effort: storage is unavailable, so the choice applies to this view only.
  }
}

function ActivityItem({ row }: { row: ActivityRow }) {
  const { event } = row;
  const source = activityOwnerPath(event);
  const run = activityRunLabel(row);
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <p className="min-w-0 flex-1 text-fg">
          {row.sentence}
          {run ? <span className="ml-2 text-xs text-fg-muted">{run}</span> : null}
        </p>
        <span className="text-xs text-fg-muted">
          {presentEventClass(event.eventClass)} · <TimeText value={event.timestamp} />
        </span>
        {source ? (
          <SystemOwnerLink
            scope={[event.links?.workspaceId, event.eventId]}
            href={source}
            className="text-sm font-medium text-accent hover:underline"
          >
            Open source
          </SystemOwnerLink>
        ) : (
          <span className="text-xs text-fg-muted">This event has no link to its source record.</span>
        )}
      </div>
      <TechnicalDetails label="Event identifiers and raw payload">
        <dl className="grid gap-1 text-xs sm:grid-cols-2">
          {activityMetadata(event).map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="font-medium text-fg">{label}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
        </dl>
        <dl className="mt-2">
          <dt>Event type</dt>
          <dd>{event.eventType}</dd>
          <dt>Event ID</dt>
          <dd>{event.eventId}</dd>
          <dt>Authority</dt>
          <dd>{event.eventAuthority ?? "Unknown"}</dd>
          <dt>Timestamp (UTC)</dt>
          <dd>{event.timestamp}</dd>
        </dl>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </TechnicalDetails>
    </li>
  );
}

export function SystemActivity() {
  const streamOpen = useEventStreamStatus().state === "open";
  const [showBackground, setShowBackground] = useState(readShowBackground);
  const events = useQuery({
    queryKey: queryKeys.systemActivity(),
    queryFn: () => fetchRealtimeEvents(100),
    refetchInterval: streamOpen ? false : ACTIVITY_FALLBACK_MS,
  });
  const items = events.data?.items ?? [];
  // SY-01: background status refreshes are hidden by default so what happened stays readable.
  const shown = showBackground ? items : items.filter((event) => !describeActivity(event).operational);
  const rows = collapseActivity(shown);
  const hidden = items.length - shown.length;
  return (
    <section className={AREA_PAGE}>
      <AreaHeader
        title="Activity log"
        description="Recent signals across this installation."
        actions={
          <Button size="sm" disabled={events.isFetching} onClick={() => void events.refetch()}>
            <RefreshCw aria-hidden="true" className="size-4" /> Refresh
          </Button>
        }
      >
        <p className="mt-1 text-xs text-fg-muted">
          This list keeps recent signals only, not the full history. Open the source record for full details. Signals
          are saved records: a reported host or device does not show its current health.
        </p>
        {events.dataUpdatedAt ? (
          <p className="mt-1 text-xs text-fg-muted">
            <TimeText value={events.dataUpdatedAt} prefix="Updated" />
            {events.isError ? "; retained observations are stale" : ""}. Quiet live events do not prove current health.
          </p>
        ) : null}
      </AreaHeader>
      <label className="flex items-center gap-2 self-start text-sm text-fg-secondary">
        <input
          type="checkbox"
          checked={showBackground}
          onChange={(event) => {
            setShowBackground(event.target.checked);
            writeShowBackground(event.target.checked);
          }}
        />
        Show background signals
      </label>
      {events.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading activity…
        </p>
      ) : null}
      {events.isError ? (
        <EmptyState
          title="Activity unavailable"
          description={describeApiError(events.error).summary}
          action={<Button onClick={() => void events.refetch()}>Try again</Button>}
        />
      ) : null}
      {events.data ? (
        rows.length ? (
          <>
            <p className="text-xs text-fg-muted">
              Showing {plural(shown.length, "recent signal")}
              {events.data.nextCursor ? "; older signals are not shown" : ""}.
              {hidden ? ` ${plural(hidden, "background signal")} ${hidden === 1 ? "is" : "are"} hidden.` : ""}
            </p>
            <ol className="divide-y divide-line-subtle">
              {rows.map((row) => (
                <ActivityItem key={row.event.eventId} row={row} />
              ))}
            </ol>
          </>
        ) : (
          <EmptyState
            title="No recent activity returned"
            description={
              hidden
                ? `Only background signals arrived in this window (${hidden}). Show background signals to see them.`
                : "No signals were returned in this window."
            }
          />
        )
      ) : null}
      <RecentSessions />
    </section>
  );
}
