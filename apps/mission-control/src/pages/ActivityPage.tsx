import { useEffect, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { connectEventStream, fetchRealtimeEvents, type RealtimeEvent } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { PageGuideCard } from "../components/PageGuideCard";
import { StatusChip } from "../components/StatusChip";
import { pageCopy } from "../content/copy";

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
        actions={(
          <div className="workflow-summary-strip">
            <StatusChip tone="live">{events.length} buffered</StatusChip>
            {error ? <StatusChip tone="warning">Stream issues</StatusChip> : <StatusChip tone="success">Live feed connected</StatusChip>}
          </div>
        )}
      />
      <PageGuideCard
        pageId="activity"
        what={pageCopy.activity.guide?.what ?? ""}
        when={pageCopy.activity.guide?.when ?? ""}
        actions={pageCopy.activity.guide?.actions ?? []}
      />
      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
      </div>
      <Panel
        title="Realtime Activity Stream"
        subtitle="Newest events stay pinned at the top so you can watch the retained signal lane as runs, agents, approvals, and integrations move."
      >
        <div className="status-banner">
          This feed is the retained realtime stream for operators. Durable history remains in the session, approval, task, and run detail views.
        </div>
        <div className="virtual-list-shell tall">
          <Virtuoso
            data={events}
            itemContent={(_index, event) => {
              const links = event.links as Record<string, string | undefined> | undefined;
              return (
                <div className="virtual-list-item">
                  <div className="workflow-summary-strip">
                    <strong>{event.eventType}</strong>
                    <StatusChip tone="muted">{event.source}</StatusChip>
                    {event.eventClass ? <StatusChip tone="muted">{event.eventClass}</StatusChip> : null}
                    {event.eventAuthority ? <StatusChip tone="live">{event.eventAuthority}</StatusChip> : null}
                    {links?.proactiveRunId ? <StatusChip tone="warning">proactive</StatusChip> : null}
                    {links?.approvalId ? <StatusChip tone="warning">approval</StatusChip> : null}
                    {links?.taskId ? <StatusChip tone="muted">task</StatusChip> : null}
                    {links?.runId ? <StatusChip tone="muted">durable</StatusChip> : null}
                  </div>
                  <p className="office-subtitle">{new Date(event.timestamp).toLocaleString()}</p>
                  {links ? (
                    <p className="office-subtitle">
                      {Object.entries(links)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(" | ")}
                    </p>
                  ) : null}
                  {renderActivityPayloadSummary(event.payload) ? (
                    <p className="office-subtitle">{renderActivityPayloadSummary(event.payload)}</p>
                  ) : null}
                  <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                </div>
              );
            }}
          />
        </div>
      </Panel>
    </section>
  );
}

function renderActivityPayloadSummary(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const nextWakeAt = typeof record.nextWakeAt === "string" ? record.nextWakeAt : undefined;
  const stopReason = typeof record.stopReason === "string" ? record.stopReason : undefined;
  const originSurface = typeof record.originSurface === "string" ? record.originSurface : undefined;
  const externalReferenceRoots = Array.isArray(record.externalReferenceRoots)
    ? record.externalReferenceRoots.length
    : 0;
  const summary = [
    originSurface ? `surface ${originSurface}` : null,
    nextWakeAt ? `wake ${new Date(nextWakeAt).toLocaleString()}` : null,
    stopReason ? `stop ${stopReason}` : null,
    externalReferenceRoots > 0 ? `${externalReferenceRoots} reference root${externalReferenceRoots === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" | ");
  return summary || null;
}
