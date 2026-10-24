import { isBackgroundChatUserInputPrompt, type ChatSessionRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { projectSessionActivity, type ThreadActivity } from "./thread-activity";

type LiveChat = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  "thread" | "pendingApproval" | "pendingUserInput" | "hasActiveStream" | "sending"
>;

/**
 * What the open conversation is doing now, for the header. Live Chat state wins: a decision you owe, then work in
 * flight, then the latest response's recorded outcome. Without an open conversation it falls back to the sessions
 * list's activity. Display only; it never decides whether sending is allowed.
 */
export function projectChatStatus(live: LiveChat | null | undefined, session?: ChatSessionRecord): ThreadActivity {
  if (!live) return session ? projectSessionActivity(session) : { label: "Status unavailable", tone: "neutral" };
  if (live.pendingApproval) return { label: "Waiting on you: approval", tone: "waiting" };
  if (live.pendingUserInput && !isBackgroundChatUserInputPrompt(live.pendingUserInput))
    return { label: "Waiting on you: question", tone: "waiting" };
  if (live.hasActiveStream) return { label: "Working", tone: "running" };
  if (live.sending) return { label: "Sending", tone: "running" };
  const thread = live.thread;
  if (!thread) return session ? projectSessionActivity(session) : { label: "Status unavailable", tone: "neutral" };
  const latest = thread.turns.find((turn) => turn.turnId === thread.activeLeafTurnId) ?? thread.turns.at(-1);
  if (!latest) return { label: "No messages yet", tone: "neutral" };
  switch (latest.trace.status) {
    case "queued":
      return { label: "Queued", tone: "running" };
    case "running":
    case "waiting_for_tool":
      return { label: "Working", tone: "running" };
    // The thread still says waiting, but Chat holds no open request: the decision is in and the work is resuming.
    case "waiting_for_approval":
    case "waiting_for_user_input":
      return { label: "Continuing after your decision", tone: "running" };
    case "completed":
      return { label: "Last response completed", tone: "done" };
    case "partial":
      return { label: "Last response incomplete", tone: "waiting" };
    case "failed":
      return { label: "Last response failed", tone: "failed" };
    case "cancelled":
      return { label: "Last response cancelled", tone: "neutral" };
    default:
      return { label: "Status unavailable", tone: "neutral" };
  }
}
