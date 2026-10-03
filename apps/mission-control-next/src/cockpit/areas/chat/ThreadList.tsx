import { useCallback, useMemo, useState } from "react";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import type { ListRange } from "react-virtuoso";
import { WindowedRecordList } from "../../ui/WindowedRecordList";
import { useThreadActivity } from "./use-thread-activity";
import { THREAD_ACTIVITY_WINDOW_LIMIT, UNKNOWN_THREAD_ACTIVITY } from "./thread-activity";
import type { MissionThreadedSessionRailData } from "@goatcitadel/threaded-surface-core";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { ChatConversationFilters, type ChatProjectFilterOption } from "./ChatConversationFilters";

export function ThreadList({ rail, projectOptions }: { rail: MissionThreadedSessionRailData; projectOptions?: readonly ChatProjectFilterOption[] }) {
  const sessions = rail.missionSessions;
  const railVisible = useMediaQuery("(width >= 1024px)");
  const [range, setRange] = useState<ListRange>({ startIndex: 0, endIndex: -1 });
  const visibleIds = useMemo(() => sessions.slice(range.startIndex, Math.min(range.endIndex + 1, range.startIndex + THREAD_ACTIVITY_WINDOW_LIMIT))
    .map((session) => session.sessionId), [sessions, range]);
  const activity = useThreadActivity(railVisible ? visibleIds : []);
  const updateRange = useCallback((next: ListRange) => setRange(next), []);
  return <aside aria-label="Conversations" className="hidden w-60 shrink-0 flex-col border-r border-line-subtle bg-raised md:flex">
    <div className="space-y-2 border-b border-line-subtle p-3">
      <div className="flex items-center justify-between gap-2"><h2 className="font-display text-sm font-semibold text-fg">Conversations</h2>
        <button type="button" onClick={() => void rail.onCreateSession()} disabled={rail.creatingSession || rail.loading}
          className="rounded-md border border-line px-2 py-1 text-xs font-medium text-accent hover:border-accent disabled:opacity-60">{rail.creatingSession ? "Creating…" : "New"}</button>
      </div>
      <button type="button" disabled={activity.loading || !visibleIds.length} onClick={() => void activity.refresh()}
        className="text-xs text-fg-muted hover:text-accent disabled:opacity-60">{activity.loading ? "Reading visible status…" : "Refresh visible status"}</button>
      <ChatConversationFilters rail={rail} projectOptions={projectOptions} />
      <div className="flex gap-1" aria-label="Conversation history">
        {(["active", "archived"] as const).map((view) => <button key={view} type="button" onClick={() => rail.onHistoryViewChange(view)}
          aria-pressed={rail.historyView === view}
          className="rounded-md px-2 py-1 text-xs text-fg-secondary hover:bg-sunken aria-[pressed=true]:bg-sunken aria-[pressed=true]:text-fg">{view === "active" ? "Recent" : "Archived"}</button>)}
      </div>
    </div>
    <nav aria-label="Threads" className="min-h-0 flex-1 overflow-hidden p-1">
      {sessions.length ? <WindowedRecordList items={sessions} itemKey={(session) => session.sessionId} label="Recent conversations"
        threshold={0} className="h-full min-h-0" onVisibleRangeChange={updateRange}>{(session) => <button type="button"
        onClick={() => rail.onSelectSession(session.sessionId)} aria-current={session.sessionId === rail.selectedSessionId ? "page" : undefined}
        className="flex w-full items-start rounded-md p-2 text-left hover:bg-sunken aria-[current=page]:bg-sunken">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg">{rail.renderSessionLabel(session.sessionId)}</span>
          <span className="block truncate text-xs text-fg-muted">{session.projectName ?? humanizeToken(session.lifecycleStatus)}</span>
          <span className="flex items-center gap-1 text-xs text-fg-muted" title={(activity.records[session.sessionId]?.observedAt ? "Gateway status observed " + activity.records[session.sessionId]!.observedAt : "A current canonical status read is unavailable.")}>
            <span aria-hidden="true" className={"size-1.5 shrink-0 rounded-full " + ({ running: "bg-status-running", waiting: "bg-status-waiting", failed: "bg-status-failed", done: "bg-status-done", neutral: "bg-fg-muted" }[(activity.records[session.sessionId] ?? UNKNOWN_THREAD_ACTIVITY).tone])} />
            {activity.loading ? "Checking status" : (activity.records[session.sessionId] ?? UNKNOWN_THREAD_ACTIVITY).label}
          </span>
        </span>
      </button>}</WindowedRecordList> : rail.loading ? <p role="status" className="p-2 text-xs text-fg-muted">Loading conversations…</p> : <p className="p-2 text-xs text-fg-muted">No conversations in this view.</p>}
    </nav>
    <div className="shrink-0 px-1">{rail.hasMoreSessions && rail.onLoadMoreSessions ? <button type="button" disabled={rail.loadingMoreSessions} onClick={rail.onLoadMoreSessions}
        className="w-full rounded-md p-2 text-xs text-fg-secondary hover:bg-sunken disabled:opacity-60">{rail.loadingMoreSessions ? "Loading…" : "Load more"}</button> : null}
    </div>
  </aside>;
}
