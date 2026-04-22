import type { RealtimeEvent } from "../api/client";
import { StatusChip } from "./StatusChip";

interface EventCardProps {
  event: RealtimeEvent;
  summary: string;
  tracePreview?: string[];
  onLoadTracePreview?: () => void;
}

function readPayloadString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function formatEventType(eventType: string): string {
  return eventType.replace(/_/g, " ");
}

export function buildRealtimeEventSummary(event: RealtimeEvent): string {
  const detail =
    readPayloadString(event.payload, ["summary", "message", "title", "name", "status", "action", "kind"]) ??
    (event.links?.sessionId ? `session ${event.links.sessionId.slice(-6)}` : null) ??
    (event.links?.taskId ? `task ${event.links.taskId.slice(-6)}` : null) ??
    null;

  const prefix = event.source === "system" ? "System" : event.source.charAt(0).toUpperCase() + event.source.slice(1);

  return detail
    ? `${prefix} reported ${formatEventType(event.eventType)}: ${detail}.`
    : `${prefix} reported ${formatEventType(event.eventType)}.`;
}

function formatEventLabel(eventType: string): string {
  return eventType
    .split("_")
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function getEventTone(eventType: string): "live" | "warning" | "critical" | "success" | "muted" {
  if (eventType.includes("approval") || eventType.includes("auth_device")) {
    return "warning";
  }
  if (eventType.includes("error") || eventType.includes("failed")) {
    return "critical";
  }
  if (eventType.includes("task") || eventType.includes("deliverable")) {
    return "success";
  }
  if (eventType.includes("tool") || eventType.includes("orchestration")) {
    return "live";
  }
  return "muted";
}

export function EventCard({ event, summary, tracePreview, onLoadTracePreview }: EventCardProps) {
  const eventTone = getEventTone(event.eventType);
  const links = event.links as Record<string, string | undefined> | undefined;

  return (
    <article className="event-card">
      <div className="event-card-head">
        <div className="event-card-title-group">
          <StatusChip tone={eventTone}>{formatEventLabel(event.eventType)}</StatusChip>
          <p className="event-card-summary">{summary}</p>
        </div>
        <div className="event-card-meta">
          <span>#{event.sequence}</span>
          <span>{event.source}</span>
          {event.eventClass ? <span>{event.eventClass}</span> : null}
          {event.eventAuthority ? <span>{event.eventAuthority}</span> : null}
          <span>{new Date(event.timestamp).toLocaleString()}</span>
        </div>
      </div>

      {event.traceId ||
      event.correlationId ||
      links?.approvalId ||
      links?.proactiveRunId ||
      links?.taskId ||
      links?.runId ? (
        <div className="event-card-links">
          {event.traceId ? <span>trace {event.traceId}</span> : null}
          {event.correlationId ? <span>correlation {event.correlationId}</span> : null}
          {links?.approvalId ? <span>approval {links.approvalId}</span> : null}
          {links?.proactiveRunId ? <span>proactive {links.proactiveRunId}</span> : null}
          {links?.taskId ? <span>task {links.taskId}</span> : null}
          {links?.runId ? <span>durable {links.runId}</span> : null}
        </div>
      ) : null}

      {event.correlationId && onLoadTracePreview ? (
        <div className="event-card-actions">
          <button type="button" className="gc-button" onClick={onLoadTracePreview}>
            {tracePreview ? "Refresh trace detail" : "Load trace detail"}
          </button>
        </div>
      ) : null}

      {tracePreview?.length ? (
        <div className="event-card-trace">
          <strong>Trace detail</strong>
          <ul className="compact-list">
            {tracePreview.map((item) => (
              <li key={`${event.eventId}-${item}`}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <details className="event-card-payload">
        <summary>Show raw payload</summary>
        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
      </details>
    </article>
  );
}
