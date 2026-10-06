import { useEffect, useMemo, useState } from "react";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { useEventStreamStatus } from "@goatcitadel/mission-control-shared/state/event-stream-status-store";
import { projectSessionActivity, type ThreadActivity } from "./thread-activity";

export type ThreadActivityRecord = ThreadActivity & { stale?: boolean };

/** Without live updates, a status older than this is no longer known to be current, so its row is dated. */
export const THREAD_ACTIVITY_STALE_MS = 120_000;
/** With live updates flowing, quiet means unchanged; only this long a silence dates a status. */
export const THREAD_ACTIVITY_LIVE_STALE_MS = 600_000;
const CLOCK_TICK_MS = 30_000;

function useStalenessClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function isThreadActivityStale(activity: ThreadActivity, now: number, live = false): boolean {
  const observed = activity.observedAt ? Date.parse(activity.observedAt) : Number.NaN;
  return (
    Number.isFinite(observed) && now - observed > (live ? THREAD_ACTIVITY_LIVE_STALE_MS : THREAD_ACTIVITY_STALE_MS)
  );
}

/**
 * Each conversation's status, read from the activity the sessions list already returned. No request
 * per row: the list refreshes on chat and approval events. Without live updates a status that has not
 * been refreshed for two minutes is dated ("· as of 10:42") instead of being shown as current; with
 * live updates flowing, only a ten-minute silence dates it.
 */
export function useThreadActivity(sessions: readonly ChatSessionRecord[]): Record<string, ThreadActivityRecord> {
  const now = useStalenessClock();
  const live = useEventStreamStatus().state === "open";
  return useMemo(
    () =>
      Object.fromEntries(
        sessions.map((session) => {
          const activity = projectSessionActivity(session);
          return [session.sessionId, { ...activity, stale: isThreadActivityStale(activity, now, live) }];
        }),
      ),
    [sessions, now, live],
  );
}
