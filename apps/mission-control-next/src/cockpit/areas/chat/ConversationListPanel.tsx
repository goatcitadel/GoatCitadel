import { WindowedRecordList } from "../../ui/WindowedRecordList";
import { useThreadActivity } from "./use-thread-activity";
import { ThreadRowStatus } from "./ThreadRowStatus";
import { isNotableThreadActivity } from "./thread-activity";
import type { MissionThreadedSessionRailData } from "@goatcitadel/threaded-surface-core";
import { TimeText } from "../../ui/TimeText";
import { ChatConversationFilters, type ChatProjectFilterOption } from "./ChatConversationFilters";

type RailSession = MissionThreadedSessionRailData["missionSessions"][number];

/** The project, or "Archived"; an active conversation outside a project is the default and says nothing. */
function rowContext(session: RailSession): string | null {
  return session.projectName ?? (session.lifecycleStatus === "archived" ? "Archived" : null);
}

/**
 * The conversation list: new, filters, Recent/Archived, the rows and Load more. The desktop rail and the phone
 * Conversations sheet share it; in the sheet the sheet title names it, targets are 44px and a choice closes the sheet.
 */
export function ConversationListPanel({
  rail,
  projectOptions,
  inSheet = false,
  onDone,
  onOpenProjects,
}: {
  rail: MissionThreadedSessionRailData;
  projectOptions?: readonly ChatProjectFilterOption[];
  inSheet?: boolean;
  onOpenProjects?: () => void;
  /** Called after a conversation is chosen or created, so the sheet can close. */
  onDone?: () => void;
}) {
  const sessions = [...rail.missionSessions, ...(rail.externalSessions ?? [])];
  // Status comes with the sessions list, so the rail makes no request of its own.
  const activity = useThreadActivity(sessions);
  const select: MissionThreadedSessionRailData["onSelectSession"] = (sessionId, options) => {
    if (options) rail.onSelectSession(sessionId, options);
    else rail.onSelectSession(sessionId);
    onDone?.();
  };
  const touch = inSheet ? "min-h-11" : "";
  return (
    <>
      <div className={`space-y-2 border-b border-line-subtle ${inSheet ? "pb-3" : "p-3"}`}>
        <div className={`flex items-center gap-2 ${inSheet ? "justify-end" : "justify-between"}`}>
          {inSheet ? null : <h2 className="text-sm font-semibold text-fg">Conversations</h2>}
          <button
            type="button"
            onClick={() => {
              void rail.onCreateSession();
              onDone?.();
            }}
            disabled={rail.creatingSession || rail.loading}
            className={`rounded-md border border-line-control px-2 py-1 text-xs font-medium text-accent hover:border-accent disabled:opacity-60 ${inSheet ? "min-h-11 px-3" : ""}`}
          >
            {rail.creatingSession ? "Creating…" : "New"}
          </button>
        </div>
        <ChatConversationFilters
          rail={rail}
          projectOptions={projectOptions}
          touch={touch}
          onOpenProjects={
            onOpenProjects
              ? () => {
                  onOpenProjects();
                  onDone?.();
                }
              : undefined
          }
        />
        <div role="group" className="flex gap-1" aria-label="Conversation history">
          {(["active", "archived"] as const).map((view) => (
            <button
              key={view}
              type="button"
              onClick={() => rail.onHistoryViewChange(view)}
              aria-pressed={rail.historyView === view}
              className={`rounded-md px-2 py-1 text-xs text-fg-secondary hover:bg-sunken aria-[pressed=true]:bg-sunken aria-[pressed=true]:text-fg ${touch}`}
            >
              {view === "active" ? "Recent" : "Archived"}
            </button>
          ))}
        </div>
      </div>
      <nav aria-label="Conversations" className={inSheet ? "py-1" : "flex min-h-0 flex-1 flex-col overflow-hidden p-1"}>
        {sessions.length ? (
          <WindowedRecordList
            items={sessions}
            itemKey={(session) => session.sessionId}
            label="Recent conversations"
            threshold={100}
            bounded={!inSheet}
            scopeKey={JSON.stringify([
              [...new Set(sessions.map((session) => session.workspaceId))].sort(),
              rail.historyView,
              rail.selectedProjectId,
              rail.selectedFolderId,
              rail.selectedTag,
              rail.search,
            ])}
            className={inSheet ? undefined : "h-full min-h-0"}
          >
            {(session) => (
              <div>
                <button
                  type="button"
                  onClick={() => select(session.sessionId)}
                  aria-current={session.sessionId === rail.selectedSessionId ? "page" : undefined}
                  className="flex w-full items-start rounded-md p-2 text-left hover:bg-sunken aria-[current=page]:bg-sunken"
                >
                  {/* Two lines: the title and when; then a running, waiting or failed status, the project, and the preview. */}
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                        {rail.renderSessionLabel(session.sessionId)}
                      </span>
                      <TimeText value={session.lastActivityAt} className="shrink-0 text-xs text-fg-muted" />
                    </span>
                    <span className="flex min-w-0 items-center gap-1 text-xs text-fg-muted">
                      {isNotableThreadActivity(activity[session.sessionId]) ? (
                        <ThreadRowStatus record={activity[session.sessionId]} />
                      ) : null}
                      {rowContext(session) ? <span className="shrink-0">{rowContext(session)}</span> : null}
                      {session.lastMessagePreview ? (
                        <span className="min-w-0 truncate text-fg-secondary">{session.lastMessagePreview}</span>
                      ) : null}
                    </span>
                  </span>
                </button>
                {session.searchHits?.map((hit) => (
                  <button
                    key={hit.messageId}
                    type="button"
                    onClick={() => select(session.sessionId, { searchHit: hit })}
                    className={`block w-full rounded-md px-2 py-1 text-left text-xs text-fg-secondary hover:bg-sunken ${touch}`}
                  >
                    <span className="line-clamp-2">{hit.excerpt}</span>
                    <span className="sr-only"> · </span>
                    <span className="mt-1 block border-t border-line-subtle pt-1 text-accent">
                      Open matching message
                    </span>
                  </button>
                ))}
              </div>
            )}
          </WindowedRecordList>
        ) : rail.loading ? (
          <p role="status" className="p-2 text-xs text-fg-muted">
            Loading conversations…
          </p>
        ) : (
          <p className="p-2 text-xs text-fg-muted">No conversations in this view.</p>
        )}
      </nav>
      <div className="shrink-0 px-1">
        {rail.hasMoreSessions && rail.onLoadMoreSessions ? (
          <button
            type="button"
            disabled={rail.loadingMoreSessions}
            onClick={rail.onLoadMoreSessions}
            className={`w-full rounded-md p-2 text-xs text-fg-secondary hover:bg-sunken disabled:opacity-60 ${touch}`}
          >
            {rail.loadingMoreSessions ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </>
  );
}
