import {
  CHAT_SESSION_STATUS_VERSION,
  type ChatSessionRecord,
  type ChatSessionStatusResponse,
  type ChatSessionStatusWork,
} from "@goatcitadel/contracts";

export interface ThreadActivity {
  label: string;
  tone: "running" | "waiting" | "failed" | "done" | "neutral";
  observedAt?: string;
}
export const UNKNOWN_THREAD_ACTIVITY: ThreadActivity = { label: "Status unavailable", tone: "neutral" };
const COUNTS = ["queued", "running", "waiting_for_tool", "waiting_for_approval", "waiting_for_user_input"] as const;

type ActivityView = Pick<ChatSessionStatusWork, "turnCounts" | "latestTurn" | "latestTurnId">;

/** Status display only. Historical failures, archive state and silence never establish current activity. */
function projectActivityView(work: ActivityView, observedAt: string): ThreadActivity {
  if (!Number.isFinite(Date.parse(observedAt))) return UNKNOWN_THREAD_ACTIVITY;
  if (COUNTS.some((key) => !Number.isSafeInteger(work.turnCounts[key]) || work.turnCounts[key] < 0))
    return UNKNOWN_THREAD_ACTIVITY;
  if (work.turnCounts.waiting_for_approval || work.turnCounts.waiting_for_user_input)
    return { label: "Waiting on you", tone: "waiting", observedAt };
  if (work.turnCounts.running || work.turnCounts.waiting_for_tool)
    return { label: "Working", tone: "running", observedAt };
  if (work.turnCounts.queued) return { label: "Queued", tone: "running", observedAt };
  if (work.latestTurn === null && !work.latestTurnId) return { label: "No messages yet", tone: "neutral", observedAt };
  const latest = work.latestTurn;
  if (!latest || latest.turnId !== work.latestTurnId || !Number.isFinite(Date.parse(latest.startedAt)))
    return UNKNOWN_THREAD_ACTIVITY;
  if (latest.status === "failed") return { label: "Last response failed", tone: "failed", observedAt };
  if (latest.status === "partial") return { label: "Last response incomplete", tone: "waiting", observedAt };
  if (latest.status === "completed") return { label: "Last response completed", tone: "done", observedAt };
  if (latest.status === "cancelled") return { label: "Last response cancelled", tone: "neutral", observedAt };
  return UNKNOWN_THREAD_ACTIVITY;
}

/** Activity from one session status read, rejected when it belongs to another workspace or session. */
export function projectThreadActivity(
  record: ChatSessionStatusResponse,
  workspaceId: string,
  sessionId: string,
): ThreadActivity {
  if (
    record.schemaVersion !== CHAT_SESSION_STATUS_VERSION ||
    record.workspaceId !== workspaceId ||
    record.sessionId !== sessionId ||
    record.work.availability !== "available"
  )
    return UNKNOWN_THREAD_ACTIVITY;
  return projectActivityView(record.work.value, record.generatedAt);
}

/** Activity the sessions list returned with this session; a list without it says nothing current. */
export function projectSessionActivity(session: ChatSessionRecord): ThreadActivity {
  const activity = session.activity;
  if (!activity?.turnCounts) return UNKNOWN_THREAD_ACTIVITY;
  return projectActivityView(
    { turnCounts: activity.turnCounts, latestTurn: activity.latestTurn, latestTurnId: activity.latestTurn?.turnId },
    activity.observedAt,
  );
}

/** "Last response completed · as of 10:42" once a status is no longer known to be current. */
export function threadActivityLabel(activity: ThreadActivity & { stale?: boolean }): string {
  if (!activity.stale || !activity.observedAt) return activity.label;
  const observed = new Date(activity.observedAt);
  if (Number.isNaN(observed.getTime())) return activity.label;
  return `${activity.label} · as of ${observed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}
