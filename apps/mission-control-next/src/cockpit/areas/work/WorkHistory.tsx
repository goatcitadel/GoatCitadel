import { WindowedRecordList } from "../../ui/WindowedRecordList";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { fetchChatSessions } from "@goatcitadel/mission-control-shared/api/chat";
import { fetchRealtimeEvents } from "@goatcitadel/mission-control-shared/api/system";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useEventStreamStatus } from "@goatcitadel/mission-control-shared/hooks/useEventStreamStatus";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { ACTIVITY_FALLBACK_MS } from "../../data/activity-feed";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { projectWorkHistory } from "./work-history";
import { WorkRunHistory } from "./WorkRunHistory";

function formattedTime(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed)
    : "Time unavailable";
}

export function WorkHistory() {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const sessions = useQuery({
    queryKey: queryKeys.workSessions(workspaceId),
    queryFn: () => fetchChatSessions({ scope: "mission", workspaceId, view: "all", limit: 100 }),
    refetchInterval: 60_000,
  });
  // Live events are appended to this list while the stream is open; polling is only a fallback.
  const streamOpen = useEventStreamStatus().state === "open";
  const activity = useQuery({
    queryKey: queryKeys.workActivity(workspaceId),
    queryFn: () => fetchRealtimeEvents(100),
    refetchInterval: streamOpen ? false : ACTIVITY_FALLBACK_MS,
  });
  const history =
    !sessions.isError && !activity.isError && sessions.data && activity.data
      ? projectWorkHistory(sessions.data.items, activity.data.items, workspaceId)
      : null;
  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-fg">Work history</h1>
          <p className="text-sm text-fg-secondary">Saved workspace runs, conversations, and recent activity signals.</p>
          <p className="mt-1 text-xs text-fg-muted">
            Activity signals are retained for a limited window. Open a conversation or run for its durable record.
          </p>
        </div>
        <Button
          size="sm"
          disabled={sessions.isFetching || activity.isFetching}
          onClick={() => {
            void sessions.refetch();
            void activity.refetch();
          }}
        >
          <RefreshCw aria-hidden="true" className="size-4" /> Refresh conversations and activity
        </Button>
      </header>
      <WorkRunHistory key={workspaceId} workspaceId={workspaceId} />
      <h2 className="font-display text-md font-semibold text-fg">Conversations and recent activity</h2>
      {sessions.isLoading || activity.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading work history…
        </p>
      ) : null}
      {sessions.isError || activity.isError ? (
        <EmptyState
          title="Work history incomplete"
          description={describeApiError(sessions.error ?? activity.error).summary}
          action={
            <Button
              onClick={() => {
                void sessions.refetch();
                void activity.refetch();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : null}
      {history ? (
        <>
          <p className="text-xs text-fg-muted">
            Showing up to 100 conversations and 100 retained events.{" "}
            {history.omittedUnscopedEvents > 0
              ? `${history.omittedUnscopedEvents} events without this workspace binding were omitted.`
              : ""}
            {sessions.data?.nextCursor || activity.data?.nextCursor ? " Older entries are not shown." : ""}
          </p>
          {history.entries.length === 0 ? (
            <EmptyState
              title="No recent work returned"
              description="No scoped conversations or activity signals were returned in this window."
            />
          ) : (
            <WindowedRecordList
              items={history.entries}
              itemKey={(entry) => entry.id}
              label="Conversations and activity"
              ordered
            >
              {(entry) => (
                <article className="rounded-lg border border-line bg-raised p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-fg-muted">
                        {entry.kind === "conversation" ? "Conversation" : "Activity signal"}
                      </p>
                      <p className="mt-1 text-sm font-medium text-fg">{entry.title}</p>
                    </div>
                    <time className="text-xs text-fg-muted" dateTime={entry.at}>
                      {formattedTime(entry.at)}
                    </time>
                  </div>
                  {entry.href ? (
                    <NativeOwnerLink
                      scope={[workspaceId, entry.id]}
                      href={entry.href}
                      className="mt-2 inline-block text-sm font-medium text-accent hover:underline"
                    >
                      Open record
                    </NativeOwnerLink>
                  ) : null}
                </article>
              )}
            </WindowedRecordList>
          )}
        </>
      ) : null}
    </section>
  );
}
