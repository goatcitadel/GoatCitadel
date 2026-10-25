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
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { Button } from "../../ui/Button";
import { Section } from "../../ui/Section";
import { EmptyState } from "../../ui/EmptyState";
import { projectWorkHistory } from "./work-history";
import { WorkRunHistory } from "./WorkRunHistory";
import { TimeText } from "../../ui/TimeText";
import { plural } from "@goatcitadel/mission-control-shared/content/format";

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
    <section className={AREA_PAGE}>
      <AreaHeader
        title="History"
        description="Saved runs, conversations, and recent activity in this workspace."
        actions={
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
        }
      />
      <WorkRunHistory key={workspaceId} workspaceId={workspaceId} />
      <Section
        title="Conversations and recent activity"
        description="Recent activity is kept for a limited time. Open a conversation or run for its full saved record."
      >
        <div className="flex flex-col gap-3">
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
                  ? `${plural(history.omittedUnscopedEvents, "event")} without this workspace binding ${history.omittedUnscopedEvents === 1 ? "was" : "were"} omitted.`
                  : ""}
                {sessions.data?.nextCursor || activity.data?.nextCursor ? " Older entries are not shown." : ""}
              </p>
              {history.entries.length === 0 ? (
                <EmptyState
                  title="No recent work returned"
                  description="No conversations or activity for this workspace in this window."
                />
              ) : (
                <WindowedRecordList
                  items={history.entries}
                  itemKey={(entry) => entry.id}
                  label="Conversations and activity"
                  ordered
                >
                  {(entry) => (
                    <article className="border-b border-line-subtle pb-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-medium text-fg-muted">
                            {entry.kind === "conversation" ? "Conversation" : "Activity"}
                          </p>
                          <p className="mt-1 text-sm font-medium text-fg">{entry.title}</p>
                        </div>
                        <TimeText value={entry.at} className="text-xs text-fg-muted" />
                      </div>
                      {entry.href ? (
                        <NativeOwnerLink
                          scope={[workspaceId, entry.id]}
                          href={entry.href}
                          className="mt-2 inline-block text-sm font-medium text-accent hover:underline"
                        >
                          {entry.href.startsWith("/work/runs/") ? "Open run" : "Open conversation"}
                          <span className="sr-only">: {entry.title}</span>
                        </NativeOwnerLink>
                      ) : null}
                    </article>
                  )}
                </WindowedRecordList>
              )}
            </>
          ) : null}
        </div>
      </Section>
    </section>
  );
}
