import { canonicalJsonString, type RealtimeEvent } from "@goatcitadel/contracts";
import { presentEventType } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { realtimeEventKind } from "../../data/event-map";

export interface ActivitySentence {
  sentence: string;
  /** A background status refresh, hidden by default so real events stay readable. */
  operational: boolean;
}

export interface ActivityRow extends ActivitySentence {
  /** The newest event of the run. */
  event: RealtimeEvent;
  count: number;
  /** Oldest and newest timestamps in the run. */
  firstAt: string;
  lastAt: string;
}

const SENTENCES: Readonly<Record<string, string>> = {
  llamacpp_refreshed: "Local model status changed",
  llamacpp_started: "Local model started",
  llamacpp_stopped: "Local model stopped",
  llamacpp_exited: "Local model stopped unexpectedly",
  chat_message: "New message in a conversation",
  chat_thread_updated: "A conversation was updated",
  chat_session_title_updated: "A conversation was renamed",
  approval_created: "An approval is waiting for you",
  approval_resolved: "An approval was decided",
  task_created: "A task was added",
  task_updated: "A task was updated",
  task_deleted: "A task was deleted",
  cron_job_run: "A scheduled job ran",
  backup_created: "A backup was created",
  workspace_created: "A workspace was created",
  workspace_updated: "A workspace was changed",
  workspace_archived: "A workspace was archived",
  workspace_restored: "A workspace was restored",
  "inbox.changed": "Your Inbox changed",
  code_mode_run_completed: "A code run finished",
  code_mode_run_failed: "A code run failed",
  memory_qmd_generated: "Memory summary updated",
  memory_qmd_fallback: "Memory summary used fallback context",
};

/** With a conversation title from the payload, the sentence names it. */
const TITLED: Readonly<Record<string, (title: string) => string>> = {
  chat_message: (title) => `New message in “${title}”`,
  chat_thread_updated: (title) => `“${title}” was updated`,
  chat_session_title_updated: (title) => `A conversation was renamed “${title}”`,
};

/**
 * Only known status refreshes are background. The event class alone is not enough: workspace, backup and
 * task actions are also published as operational signals, and they are what this page is for.
 */
const STATUS_REFRESH = new Set([
  "llamacpp_refreshed",
  "inbox.changed",
  "channel_activity_updated",
  "mobile_capability_heartbeat",
  "remote_worker_changed",
  "remote_worker_assignment_changed",
]);

function isStatusRefresh(kind: string): boolean {
  return STATUS_REFRESH.has(kind) || kind.startsWith("proactive_") || kind.startsWith("npu_");
}

/** One plain sentence per event, from the operator's side; unknown events fall back to their type in words. */
export function describeActivity(event: RealtimeEvent): ActivitySentence {
  const kind = realtimeEventKind(event);
  const title = typeof event.payload?.title === "string" ? event.payload.title.trim() : "";
  const titled = title ? TITLED[kind] : undefined;
  return {
    sentence: titled ? titled(title) : (SENTENCES[kind] ?? presentEventType(kind)),
    operational: isStatusRefresh(kind),
  };
}

/** Collapses consecutive events that read the same into one row with a count. */
export function collapseActivity(events: readonly RealtimeEvent[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const event of events) {
    const described = describeActivity(event);
    const last = rows.at(-1);
    if (last && described.operational && last.sentence === described.sentence && last.operational === described.operational &&
      canonicalJsonString([last.event.source, last.event.links, activityMetadata(last.event)]) ===
      canonicalJsonString([event.source, event.links, activityMetadata(event)])) {
      rows[rows.length - 1] = { ...last, count: last.count + 1, firstAt: event.timestamp };
      continue;
    }
    rows.push({ ...described, event, count: 1, firstAt: event.timestamp, lastAt: event.timestamp });
  }
  return rows;
}

/** Only explicit retained Gateway metadata, never a browser join to an assumed target. */
export function activityMetadata(event: RealtimeEvent): Array<[string, string]> {
  const rows: Array<[string, string]> = [["Source", event.source || "Unknown source"]];
  for (const [label, value] of Object.entries({
    Workspace: event.links?.workspaceId, Run: event.links?.durableRunId ?? event.links?.runId,
    Task: event.links?.taskId, Worker: event.links?.workerId,
    "Reported host": event.payload?.hostname ?? event.payload?.hostName,
    "Reported device": event.payload?.deviceId, "Reported action": event.payload?.action,
  })) if (typeof value === "string" && value.length) rows.push([label, value]);
  return rows;
}

export function activityOwnerPath(event: RealtimeEvent): string | null {
  const links = event.links;
  const scoped = (path: string) => `${path}${path.includes("?") ? "&" : "?"}eventId=${encodeURIComponent(event.eventId)}${links?.workspaceId ? `&workspaceId=${encodeURIComponent(links.workspaceId)}` : ""}`;
  if (links?.approvalId) return scoped(`/inbox?approvalId=${encodeURIComponent(links.approvalId)}`);
  if (links?.sessionId) return scoped(`/chat?sessionId=${encodeURIComponent(links.sessionId)}${links.turnId ? `&turnId=${encodeURIComponent(links.turnId)}` : ""}`);
  if (links?.durableRunId || links?.runId) return scoped(`/work/runs/${encodeURIComponent(links.durableRunId ?? links.runId!)}`);
  if (links?.taskId) return scoped(`/work/tasks/${encodeURIComponent(links.taskId)}`);
  return null;
}

/** "×96 in 2 min" for a collapsed row; empty for a single event. */
export function activityRunLabel(row: Pick<ActivityRow, "count" | "firstAt" | "lastAt">): string {
  if (row.count < 2) return "";
  const span = Math.abs(Date.parse(row.lastAt) - Date.parse(row.firstAt));
  if (!Number.isFinite(span)) return `×${row.count}`;
  const seconds = Math.max(1, Math.round(span / 1000));
  const length =
    seconds < 60
      ? `${seconds} s`
      : seconds < 3600
        ? `${Math.round(seconds / 60)} min`
        : `${Math.round(seconds / 3600)} h`;
  return `×${row.count} in ${length}`;
}
