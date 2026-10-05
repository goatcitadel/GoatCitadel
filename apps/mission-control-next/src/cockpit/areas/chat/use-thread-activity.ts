import { useEffect, useMemo, useState } from "react";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { projectSessionActivity, type ThreadActivity } from "./thread-activity";

export type ThreadActivityRecord = ThreadActivity & { stale?: boolean };

/** A status older than this is no longer known to be current, so its row shows when it was seen. */
export const THREAD_ACTIVITY_STALE_MS = 120_000;
const CLOCK_TICK_MS = 30_000;

function useStalenessClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function isThreadActivityStale(activity: ThreadActivity, now: number): boolean {
  const observed = activity.observedAt ? Date.parse(activity.observedAt) : Number.NaN;
  return Number.isFinite(observed) && now - observed > THREAD_ACTIVITY_STALE_MS;
}

/**
 * Each conversation's status, read from the activity the sessions list already returned. No request
 * per row: the list refreshes on chat and approval events; a status that has not been refreshed for
 * two minutes is dated ("· as of 10:42") instead of being shown as current.
 */
export function useThreadActivity(sessions: readonly ChatSessionRecord[]): Record<string, ThreadActivityRecord> {
  const now = useStalenessClock();
  return useMemo(
    () =>
      Object.fromEntries(
        sessions.map((session) => {
          const activity = projectSessionActivity(session);
          return [session.sessionId, { ...activity, stale: isThreadActivityStale(activity, now) }];
        }),
      ),
    [sessions, now],
  );
}
