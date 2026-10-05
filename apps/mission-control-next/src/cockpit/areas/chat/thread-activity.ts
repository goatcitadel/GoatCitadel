import { CHAT_SESSION_STATUS_VERSION, type ChatSessionStatusResponse } from "@goatcitadel/contracts";
import { fetchChatSessionStatus } from "@goatcitadel/mission-control-shared/api/chat";

export const THREAD_ACTIVITY_WINDOW_LIMIT = 24;
export const THREAD_ACTIVITY_CONCURRENCY = 2;
export interface ThreadActivity {
  label: string;
  tone: "running" | "waiting" | "failed" | "done" | "neutral";
  observedAt?: string;
}
export const UNKNOWN_THREAD_ACTIVITY: ThreadActivity = { label: "Status unavailable", tone: "neutral" };
const COUNTS = ["queued", "running", "waiting_for_tool", "waiting_for_approval", "waiting_for_user_input"] as const;

/** Status display only. Historical failures, archive state and silence never establish current activity. */
export function projectThreadActivity(
  record: ChatSessionStatusResponse,
  workspaceId: string,
  sessionId: string,
): ThreadActivity {
  if (
    record.schemaVersion !== CHAT_SESSION_STATUS_VERSION ||
    record.workspaceId !== workspaceId ||
    record.sessionId !== sessionId ||
    !Number.isFinite(Date.parse(record.generatedAt)) ||
    record.work.availability !== "available"
  )
    return UNKNOWN_THREAD_ACTIVITY;
  const work = record.work.value;
  if (COUNTS.some((key) => !Number.isSafeInteger(work.turnCounts[key]) || work.turnCounts[key] < 0))
    return UNKNOWN_THREAD_ACTIVITY;
  const observedAt = record.generatedAt;
  if (work.turnCounts.waiting_for_approval || work.turnCounts.waiting_for_user_input)
    return { label: "Waiting on you", tone: "waiting", observedAt };
  if (work.turnCounts.running || work.turnCounts.waiting_for_tool)
    return { label: "Working", tone: "running", observedAt };
  if (work.turnCounts.queued) return { label: "Queued", tone: "running", observedAt };
  if (work.latestTurn === null && !work.latestTurnId)
    return { label: "No recorded turns", tone: "neutral", observedAt };
  const latest = work.latestTurn;
  if (!latest || latest.turnId !== work.latestTurnId || !Number.isFinite(Date.parse(latest.startedAt)))
    return UNKNOWN_THREAD_ACTIVITY;
  if (latest.status === "failed") return { label: "Last turn failed", tone: "failed", observedAt };
  if (latest.status === "partial") return { label: "Last turn incomplete", tone: "waiting", observedAt };
  if (latest.status === "completed") return { label: "Last turn completed", tone: "done", observedAt };
  if (latest.status === "cancelled") return { label: "Last turn cancelled", tone: "neutral", observedAt };
  return UNKNOWN_THREAD_ACTIVITY;
}

/** Runs at most `limit` tasks at once; a task whose signal aborted while queued never starts. */
export function createConcurrencyLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active -= 1;
    queue.shift()?.();
  };
  return async function run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      if (signal?.aborted) throw new DOMException("The status read was cancelled.", "AbortError");
      return await task();
    } finally {
      release();
    }
  };
}

/** Every visible row shares one gate, so a long thread list never floods the Gateway. */
const statusReadGate = createConcurrencyLimiter(THREAD_ACTIVITY_CONCURRENCY);

/** One canonical status read. Failures propagate so the query layer can retry and mark staleness. */
export async function readThreadActivity(input: {
  workspaceId: string;
  sessionId: string;
  signal: AbortSignal;
  read?: typeof fetchChatSessionStatus;
}): Promise<ThreadActivity> {
  return statusReadGate(async () => {
    const record = await (input.read ?? fetchChatSessionStatus)(input.sessionId, input.signal);
    return projectThreadActivity(record, input.workspaceId, input.sessionId);
  }, input.signal);
}

/** "Last turn completed · as of 10:42" once a status is no longer known to be current. */
export function threadActivityLabel(activity: ThreadActivity & { stale?: boolean }): string {
  if (!activity.stale || !activity.observedAt) return activity.label;
  const observed = new Date(activity.observedAt);
  if (Number.isNaN(observed.getTime())) return activity.label;
  return `${activity.label} · as of ${observed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}
