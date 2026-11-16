import type { OperatorInboxReadStatus } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";

/**
 * Read status for the Notices group. "Mark all shown notices read" appears only while a shown notice is unread
 * (IN-10); "Show read notices" only once something has been read.
 */
export function InboxUpdatesControls({
  shownCount,
  viewedCount,
  readScope,
  localReadsAvailable,
  readNotice,
  reading,
  showViewed,
  onMarkAllRead,
  onToggleShowViewed,
}: {
  shownCount: number;
  viewedCount: number;
  readScope: OperatorInboxReadStatus["scope"];
  localReadsAvailable: boolean;
  readNotice: string;
  reading: boolean;
  showViewed: boolean;
  onMarkAllRead: () => void;
  onToggleShowViewed: () => void;
}) {
  const unread = shownCount - viewedCount;
  return (
    <div className="space-y-2 text-xs text-fg-muted">
      <p>
        {unread} unread · {viewedCount} read from shown notices.
      </p>
      <p>
        {readScope === "operator"
          ? "Read status is saved for this operator and workspace."
          : readScope === "browser_local" && localReadsAvailable
            ? "Read status is saved in this browser for this workspace."
            : "Read storage unavailable."}
      </p>
      {readNotice ? <p role="status">{readNotice}</p> : null}
      {unread > 0 || viewedCount > 0 ? (
        <div className="flex flex-wrap gap-2">
          {unread > 0 ? (
            <Button
              size="sm"
              // A background refetch (30 s poll, realtime invalidations) must not swallow the click:
              // receipts carry each shown notice's version, so a changed notice stays unread.
              disabled={
                reading || readScope === "unavailable" || (readScope === "browser_local" && !localReadsAvailable)
              }
              onClick={onMarkAllRead}
            >
              Mark all shown notices read
            </Button>
          ) : null}
          {viewedCount > 0 ? (
            <Button size="sm" onClick={onToggleShowViewed}>
              {showViewed ? "Hide read notices" : `Show read notices (${viewedCount})`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
