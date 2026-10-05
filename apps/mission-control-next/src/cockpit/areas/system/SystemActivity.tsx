import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { fetchRealtimeEvents } from "@goatcitadel/mission-control-shared/api/system";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { presentEventType } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";

export function SystemActivity() {
  const events = useQuery({
    queryKey: queryKeys.systemActivity(),
    queryFn: () => fetchRealtimeEvents(100),
    refetchInterval: 30_000,
  });
  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-fg">Activity log</h1>
          <p className="text-sm text-fg-secondary">Recent Gateway signals across this installation.</p>
          <p className="mt-1 text-xs text-fg-muted">
            The retained stream is a recent signal, not the complete durable history. Open the source record for full
            evidence.
          </p>
        </div>
        <Button size="sm" disabled={events.isFetching} onClick={() => void events.refetch()}>
          <RefreshCw aria-hidden="true" className="size-4" /> Refresh
        </Button>
      </header>
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
        events.data.items.length ? (
          <>
            <p className="text-xs text-fg-muted">
              Showing {events.data.items.length} recent {events.data.items.length === 1 ? "signal" : "signals"}
              {events.data.nextCursor ? "; older signals are not shown" : ""}.
            </p>
            <ol className="grid gap-2">
              {events.data.items.map((event) => {
                const at = Date.parse(event.timestamp);
                const source = event.links?.sessionId
                  ? `/chat?sessionId=${encodeURIComponent(event.links.sessionId)}&shell=cockpit`
                  : event.links?.runId
                    ? `/work/runs/${encodeURIComponent(event.links.runId)}`
                    : null;
                return (
                  <li key={event.eventId} className="rounded-lg border border-line bg-raised p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-sm font-medium text-fg">{presentEventType(event.eventType)}</p>
                      <time dateTime={event.timestamp} className="text-xs text-fg-muted">
                        {Number.isFinite(at)
                          ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(at)
                          : "Time unavailable"}
                      </time>
                    </div>
                    <p className="mt-1 text-xs text-fg-muted">
                      {event.eventClass === "domain_fact"
                        ? "Domain event"
                        : event.eventClass === "ui_notification"
                          ? "Notification"
                          : "Operational signal"}
                    </p>
                    {source ? (
                      <NativeOwnerLink
                        scope={[event.links?.workspaceId, event.eventId]}
                        href={source}
                        className="mt-2 inline-block text-sm font-medium text-accent hover:underline"
                      >
                        Open source
                      </NativeOwnerLink>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <EmptyState
            title="No recent activity returned"
            description="The retained event stream has no entries in this window."
          />
        )
      ) : null}
    </section>
  );
}
