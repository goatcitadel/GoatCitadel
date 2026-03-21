import { useEffect, useState } from "react";
import { connectEventStream, fetchDevDiagnostics, fetchRealtimeEvents, type RealtimeEvent } from "../api/client";
import { PageGuideCard } from "../components/PageGuideCard";
import { pageCopy } from "../content/copy";

export function LiveFeedPage() {
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tracePreviewByEventId, setTracePreviewByEventId] = useState<Record<string, string[]>>({});

  const loadTracePreview = async (event: RealtimeEvent) => {
    if (!event.correlationId) {
      return;
    }
    try {
      const response = await fetchDevDiagnostics({
        correlationId: event.correlationId,
        limit: 12,
      });
      setTracePreviewByEventId((prev) => ({
        ...prev,
        [event.eventId]: response.items.map((item) => `${new Date(item.timestamp).toLocaleTimeString()} ${item.event}: ${item.message}`),
      }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    const loadLatest = () => {
      void fetchRealtimeEvents(100)
        .then((res) => {
          setEvents(res.items);
          setError(null);
        })
        .catch((err: Error) => setError(err.message));
    };

    loadLatest();

    const close = connectEventStream((event) => {
      if (event.payload.kind === "replay_gap") {
        setError("Live feed cursor expired; reloading the latest retained event window.");
        loadLatest();
        return;
      }
      setEvents((prev) => [event, ...prev].slice(0, 200));
    });

    return () => {
      close();
    };
  }, []);

  return (
    <section>
      <h2>{pageCopy.liveFeed.title}</h2>
      <p className="office-subtitle">{pageCopy.liveFeed.subtitle}</p>
      <PageGuideCard
        what={pageCopy.liveFeed.guide?.what ?? ""}
        when={pageCopy.liveFeed.guide?.when ?? ""}
        actions={pageCopy.liveFeed.guide?.actions ?? []}
        terms={pageCopy.liveFeed.guide?.terms}
      />
      {error ? <p className="error">{error}</p> : null}
      <ul className="compact-list">
        {events.map((event) => {
          const tracePreview = tracePreviewByEventId[event.eventId];
          return (
          <li key={event.eventId}>
            <strong>{event.eventType}</strong> #{event.sequence} from {event.source} at {new Date(event.timestamp).toLocaleString()}
            {event.traceId ? <div>trace: {event.traceId}</div> : null}
            {event.correlationId ? <div>correlation: {event.correlationId}</div> : null}
            {event.correlationId ? (
              <div className="actions">
                <button type="button" onClick={() => void loadTracePreview(event)}>
                  {tracePreview ? "Refresh trace detail" : "Load trace detail"}
                </button>
              </div>
            ) : null}
            {tracePreview?.length ? (
              <div>
                <strong>Trace detail</strong>
                <ul className="compact-list">
                  {tracePreview.map((item) => <li key={`${event.eventId}-${item}`}>{item}</li>)}
                </ul>
              </div>
            ) : null}
            <pre>{JSON.stringify(event.payload, null, 2)}</pre>
          </li>
          );
        })}
      </ul>
    </section>
  );
}
