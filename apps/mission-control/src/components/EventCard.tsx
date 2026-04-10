import { StatusChip } from "./StatusChip";

interface EventCardProps {
  event: {
    eventId: string;
    eventType: string;
    source: string;
    timestamp: string;
    sequence: number;
    correlationId?: string;
    traceId?: string;
    payload: Record<string, unknown>;
  };
  summary: string;
  tracePreview?: string[];
  onLoadTracePreview?: () => void;
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
          <span>{new Date(event.timestamp).toLocaleString()}</span>
        </div>
      </div>

      {(event.traceId || event.correlationId) ? (
        <div className="event-card-links">
          {event.traceId ? <span>trace {event.traceId}</span> : null}
          {event.correlationId ? <span>correlation {event.correlationId}</span> : null}
        </div>
      ) : null}

      {event.correlationId && onLoadTracePreview ? (
        <div className="event-card-actions">
          <button type="button" className="gc-nav-pill" onClick={onLoadTracePreview}>
            {tracePreview ? "Refresh trace detail" : "Load trace detail"}
          </button>
        </div>
      ) : null}

      {tracePreview?.length ? (
        <div className="event-card-trace">
          <strong>Trace detail</strong>
          <ul className="compact-list">
            {tracePreview.map((item) => <li key={`${event.eventId}-${item}`}>{item}</li>)}
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
