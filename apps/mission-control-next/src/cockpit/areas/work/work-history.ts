import type { ChatSessionRecord, RealtimeEvent } from "@goatcitadel/contracts";
import { presentEventType } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

export interface WorkHistoryEntry {
  id: string;
  kind: "conversation" | "activity";
  title: string;
  at: string;
  href?: string;
}

/** The event list is a retained signal, not the durable history of every action. */
export function projectWorkHistory(
  sessions: readonly ChatSessionRecord[],
  events: readonly RealtimeEvent[],
  workspaceId: string,
): { entries: WorkHistoryEntry[]; omittedUnscopedEvents: number } {
  const conversationEntries = sessions
    .filter((session) => session.workspaceId === workspaceId)
    .map((session): WorkHistoryEntry => ({
      id: `conversation:${session.sessionId}`,
      kind: "conversation",
      title: session.title?.trim() || "Untitled conversation",
      at: session.lastActivityAt || session.updatedAt,
      href: `/chat?sessionId=${encodeURIComponent(session.sessionId)}&shell=cockpit`,
    }));
  const scopedEvents = events.filter((event) => event.links?.workspaceId === workspaceId);
  const activityEntries = scopedEvents.map((event): WorkHistoryEntry => ({
    id: `activity:${event.eventId}`,
    kind: "activity",
    title: presentEventType(event.eventType),
    at: event.timestamp,
    ...(event.links?.sessionId ? { href: `/chat?sessionId=${encodeURIComponent(event.links.sessionId)}&shell=cockpit` }
      : event.links?.runId ? { href: `/work/runs/${encodeURIComponent(event.links.runId)}` } : {}),
  }));
  const entries = [...conversationEntries, ...activityEntries]
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  return { entries, omittedUnscopedEvents: events.length - scopedEvents.length };
}
