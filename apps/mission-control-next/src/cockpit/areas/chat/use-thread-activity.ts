import { useMemo } from "react";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { projectSessionActivity, type ThreadActivity } from "./thread-activity";

export type ThreadActivityRecord = ThreadActivity & { stale?: boolean };

/**
 * Each conversation's status, read from the activity the sessions list already returned. No request
 * per row: the list refreshes on chat events, so its activity is as current as the list itself.
 */
export function useThreadActivity(sessions: readonly ChatSessionRecord[]): Record<string, ThreadActivityRecord> {
  return useMemo(
    () => Object.fromEntries(sessions.map((session) => [session.sessionId, projectSessionActivity(session)])),
    [sessions],
  );
}
