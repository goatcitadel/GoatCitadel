import { CHAT_SESSION_STATUS_VERSION, type ChatSessionStatusResponse } from "@goatcitadel/contracts";
import { fetchChatSessionStatus } from "@goatcitadel/mission-control-shared/api/chat";

export const THREAD_ACTIVITY_WINDOW_LIMIT = 24;
export const THREAD_ACTIVITY_CONCURRENCY = 2;
export interface ThreadActivity { label: string; tone: "running" | "waiting" | "failed" | "done" | "neutral"; observedAt?: string }
export const UNKNOWN_THREAD_ACTIVITY: ThreadActivity = { label: "Status unavailable", tone: "neutral" };
const COUNTS = ["queued", "running", "waiting_for_tool", "waiting_for_approval", "waiting_for_user_input"] as const;

/** Status display only. Historical failures, archive state and silence never establish current activity. */
export function projectThreadActivity(record: ChatSessionStatusResponse, workspaceId: string, sessionId: string): ThreadActivity {
  if (record.schemaVersion !== CHAT_SESSION_STATUS_VERSION || record.workspaceId !== workspaceId || record.sessionId !== sessionId
    || !Number.isFinite(Date.parse(record.generatedAt)) || record.work.availability !== "available") return UNKNOWN_THREAD_ACTIVITY;
  const work = record.work.value;
  if (COUNTS.some((key) => !Number.isSafeInteger(work.turnCounts[key]) || work.turnCounts[key] < 0)) return UNKNOWN_THREAD_ACTIVITY;
  const observedAt = record.generatedAt;
  if (work.turnCounts.waiting_for_approval || work.turnCounts.waiting_for_user_input) return { label: "Waiting on you", tone: "waiting", observedAt };
  if (work.turnCounts.running || work.turnCounts.waiting_for_tool) return { label: "Working", tone: "running", observedAt };
  if (work.turnCounts.queued) return { label: "Queued", tone: "running", observedAt };
  if (work.latestTurn === null && !work.latestTurnId) return { label: "No recorded turns", tone: "neutral", observedAt };
  const latest = work.latestTurn;
  if (!latest || latest.turnId !== work.latestTurnId || !Number.isFinite(Date.parse(latest.startedAt))) return UNKNOWN_THREAD_ACTIVITY;
  if (latest.status === "failed") return { label: "Last turn failed", tone: "failed", observedAt };
  if (latest.status === "partial") return { label: "Last turn incomplete", tone: "waiting", observedAt };
  if (latest.status === "completed") return { label: "Last turn completed", tone: "done", observedAt };
  if (latest.status === "cancelled") return { label: "Last turn cancelled", tone: "neutral", observedAt };
  return UNKNOWN_THREAD_ACTIVITY;
}

/** One bounded visible-window request batch; never walks pages or starts row timers. */
export async function readThreadActivityWindow(input: {
  workspaceId: string; sessionIds: readonly string[]; signal: AbortSignal; isCurrent: () => boolean;
  read?: typeof fetchChatSessionStatus;
}): Promise<Record<string, ThreadActivity>> {
  const ids = [...new Set(input.sessionIds)].slice(0, THREAD_ACTIVITY_WINDOW_LIMIT);
  const result: Record<string, ThreadActivity> = {};
  let next = 0;
  const current = () => !input.signal.aborted && input.isCurrent();
  const worker = async () => {
    while (current() && next < ids.length) {
      const id = ids[next++]!;
      try {
        const record = await (input.read ?? fetchChatSessionStatus)(id, input.signal);
        if (current()) result[id] = projectThreadActivity(record, input.workspaceId, id);
      } catch {
        if (current()) result[id] = UNKNOWN_THREAD_ACTIVITY;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(THREAD_ACTIVITY_CONCURRENCY, ids.length) }, worker));
  return current() ? result : {};
}
