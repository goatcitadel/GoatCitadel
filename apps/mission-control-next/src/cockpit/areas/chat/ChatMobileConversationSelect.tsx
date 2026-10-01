import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";

const MOBILE_SHOW_ARCHIVED = "history:archived";
const MOBILE_SHOW_RECENT = "history:active";
const MOBILE_FILTERS = "view:filters";
const MOBILE_LOAD_MORE = "history:load-more";

export function ChatMobileConversationSelect({
  rail,
  onOpenFilters,
}: {
  rail: MissionThreadedRenderSurfaceInput["sessionRail"];
  onOpenFilters: () => void;
}) {
  const selectedSessionId = rail.missionSessions.some((item) => item.sessionId === rail.selectedSessionId)
    ? (rail.selectedSessionId ?? "")
    : "";
  return (
    <label className="min-w-0 max-w-32 text-xs text-fg-muted md:hidden">
      {rail.historyView === "archived" ? "Archived" : "Thread"}
      <select
        aria-label="Choose conversation"
        value={selectedSessionId}
        onChange={(event) => {
          const value = event.target.value;
          if (value === MOBILE_SHOW_ARCHIVED) rail.onHistoryViewChange("archived");
          else if (value === MOBILE_SHOW_RECENT) rail.onHistoryViewChange("active");
          else if (value === MOBILE_FILTERS) onOpenFilters();
          else if (value === MOBILE_LOAD_MORE) {
            if (!rail.loadingMoreSessions) rail.onLoadMoreSessions?.();
          } else rail.onSelectSession(value);
        }}
        className="block h-8 w-full rounded-md border border-line bg-raised px-1 text-sm text-fg"
      >
        <option value="" disabled>
          Choose
        </option>
        {rail.missionSessions.map((session) => (
          <option key={session.sessionId} value={session.sessionId}>
            {rail.renderSessionLabel(session.sessionId)}
          </option>
        ))}
        {rail.historyView === "archived" ? (
          <option value={MOBILE_SHOW_RECENT}>Show recent conversations</option>
        ) : (
          <option value={MOBILE_SHOW_ARCHIVED}>Show archived conversations</option>
        )}
        {rail.hasMoreSessions && rail.onLoadMoreSessions ? (
          <option value={MOBILE_LOAD_MORE} disabled={rail.loadingMoreSessions}>
            {rail.loadingMoreSessions ? "Loading conversations…" : "Load more conversations"}
          </option>
        ) : null}
        <option value={MOBILE_FILTERS}>Filter conversations…</option>
      </select>
    </label>
  );
}
