import { useEffect, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { connectEventStream, fetchRealtimeEvents, type RealtimeEvent } from "../api/client";
import { buildRealtimeEventSummary, EventCard } from "../components/EventCard";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { PageGuideCard } from "../components/PageGuideCard";
import { StatusChip } from "../components/StatusChip";
import { pageCopy } from "../content/copy";
import { renderActivityPayloadSummary } from "./activity-page-helpers";

export function ActivityPage() {
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchRealtimeEvents(200)
      .then((res) => setEvents(res.items))
      .catch((err: Error) => setError(err.message));

    const close = connectEventStream((event) => {
      setEvents((prev) => [event, ...prev].slice(0, 300));
    });

    return () => {
      close();
    };
  }, []);

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Observability"
        title={pageCopy.activity.title}
        subtitle={pageCopy.activity.subtitle}
        hint="Live event flow, recent system activity, and operator-visible payloads land here first."
        actions={
          <div className="workflow-summary-strip">
            <StatusChip tone="live">{events.length} buffered</StatusChip>
            {error ? (
              <StatusChip tone="warning">Stream issues</StatusChip>
            ) : (
              <StatusChip tone="success">Live feed connected</StatusChip>
            )}
          </div>
        }
      />
      <PageGuideCard
        pageId="activity"
        what={pageCopy.activity.guide?.what ?? ""}
        when={pageCopy.activity.guide?.when ?? ""}
        actions={pageCopy.activity.guide?.actions ?? []}
      />
      <div className="workflow-status-stack">{error ? <p className="error">{error}</p> : null}</div>
      <Panel
        title="Realtime Activity Stream"
        subtitle="Newest events stay pinned at the top so you can watch the retained signal lane as runs, agents, approvals, and integrations move."
      >
        <div className="status-banner">
          This feed is the retained realtime stream for operators. Durable history remains in the session, approval,
          task, and run detail views.
        </div>
        <div className="virtual-list-shell tall">
          <Virtuoso
            data={events}
            itemContent={(_index, event) => {
              return (
                <div className="virtual-list-item">
                  <EventCard
                    event={event}
                    summary={[buildRealtimeEventSummary(event), renderActivityPayloadSummary(event.payload)]
                      .filter(Boolean)
                      .join(" ")}
                  />
                </div>
              );
            }}
          />
        </div>
      </Panel>
    </section>
  );
}
