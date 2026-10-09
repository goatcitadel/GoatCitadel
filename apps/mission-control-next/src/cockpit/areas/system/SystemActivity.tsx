import { useState } from "react";
import { SystemOwnerLink } from "./SystemOwnerLink";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
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
import { activityMetadata, activityOwnerPath, activityRunLabel, collapseActivity, describeActivity, type ActivityRow } from "./activity-sentences";

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

function formattedTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(at)
    : "Time unavailable";
}

function ActivityItem({ row }: { row: ActivityRow }) {
  const { event } = row;
  const source = activityOwnerPath(event);
  const run = activityRunLabel(row);
  return (
    <li className="rounded-lg border border-line bg-raised p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-medium text-fg">
          {row.sentence}
          {run ? <span className="ml-2 text-xs font-normal text-fg-muted">{run}</span> : null}
        </p>
        <time dateTime={event.timestamp} className="text-xs text-fg-muted">
          {formattedTime(event.timestamp)}
        </time>
      </div>
      <p className="mt-1 text-xs text-fg-muted">{presentEventClass(event.eventClass)}</p>
      <dl className="mt-2 grid gap-1 text-xs text-fg-secondary sm:grid-cols-2">{activityMetadata(event).map(([label, value]) => <div key={label} className="min-w-0"><dt className="font-medium text-fg">{label}</dt><dd className="break-all">{value}</dd></div>)}</dl>
      <p className="mt-2 text-xs text-fg-muted">Retained Gateway signal; reported host/device metadata does not establish current target health. {event.eventAuthority ? "Authority is inspectable in technical details." : "Authority was not reported."}</p>
      {source ? (
        <SystemOwnerLink
          scope={[event.links?.workspaceId, event.eventId]}
          href={source}
        >
          Open source
        </SystemOwnerLink>
      ) : <p className="mt-2 text-xs text-fg-muted">No source record link was supplied by the Gateway.</p>}
      <TechnicalDetails label="Event identifiers and raw payload"><dl><dt>Event type</dt><dd>{event.eventType}</dd><dt>Event ID</dt><dd>{event.eventId}</dd><dt>Authority</dt><dd>{event.eventAuthority ?? "Unknown"}</dd><dt>Timestamp (UTC)</dt><dd>{event.timestamp}</dd></dl><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(event.payload, null, 2)}</pre></TechnicalDetails>
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
    <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-fg">Activity log</h1>
          <p className="text-sm text-fg-secondary">Recent Gateway signals across this installation.</p>
          <p className="mt-1 text-xs text-fg-muted">
            This list keeps recent signals only, not the full history. Open the source record for full details.
          </p>
          {events.dataUpdatedAt ? <p className="mt-1 text-xs text-fg-muted">Last owner read {new Date(events.dataUpdatedAt).toLocaleString()}{events.isError ? "; retained observations are stale" : ""}. Quiet live events do not prove current health.</p> : null}
        </div>
        <Button size="sm" disabled={events.isFetching} onClick={() => void events.refetch()}>
          <RefreshCw aria-hidden="true" className="size-4" /> Refresh
        </Button>
      </header>
      <label className="flex items-center gap-2 text-sm text-fg-secondary">
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
              Showing {items.length} recent {items.length === 1 ? "signal" : "signals"}
              {events.data.nextCursor ? "; older signals are not shown" : ""}.
              {hidden ? ` ${hidden} background ${hidden === 1 ? "signal is" : "signals are"} hidden.` : ""}
            </p>
            <ol className="grid gap-2">
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
