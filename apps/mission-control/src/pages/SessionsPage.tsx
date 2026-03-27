import { useEffect, useMemo, useRef, useState } from "react";
import { TableVirtuoso, Virtuoso } from "react-virtuoso";
import {
  fetchSessionSummary,
  fetchSessionTimeline,
  fetchSessions,
  type SessionSummary,
  type SessionTimelineItem,
  type SessionsResponse,
} from "../api/client";
import { DataToolbar } from "../components/DataToolbar";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { SelectOrCustom } from "../components/SelectOrCustom";
import { CardSkeleton } from "../components/CardSkeleton";
import { StatusChip } from "../components/StatusChip";
import { TableSkeleton } from "../components/TableSkeleton";
import { GCSelect } from "../components/ui";
import { pageCopy } from "../content/copy";

export function SessionsPage() {
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [search, setSearch] = useState("");
  const [healthFilter, setHealthFilter] = useState<"all" | "healthy" | "degraded" | "blocked">("all");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [timeline, setTimeline] = useState<SessionTimelineItem[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"split" | "table">("split");
  const [error, setError] = useState<string | null>(null);
  const detailsRequestSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void fetchSessions()
      .then((next) => {
        if (cancelled) {
          return;
        }
        setData(next);
        setSelectedSessionId((current) => current ?? next.items[0]?.sessionId ?? null);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const items = data?.items ?? [];

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((session) => {
      if (healthFilter !== "all" && session.health !== healthFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      return session.sessionKey.toLowerCase().includes(query) || session.sessionId.toLowerCase().includes(query);
    });
  }, [healthFilter, items, search]);

  useEffect(() => {
    if (!selectedSessionId) {
      setSummary(null);
      setTimeline([]);
      return;
    }
    const requestId = ++detailsRequestSeq.current;
    setDetailsLoading(true);
    void Promise.all([
      fetchSessionSummary(selectedSessionId),
      fetchSessionTimeline(selectedSessionId, 160),
    ])
      .then(([summaryRes, timelineRes]) => {
        if (requestId !== detailsRequestSeq.current) {
          return;
        }
        setSummary(summaryRes);
        setTimeline(timelineRes.items);
      })
      .catch((err: Error) => {
        if (requestId === detailsRequestSeq.current) {
          setError(err.message);
        }
      })
      .finally(() => {
        if (requestId === detailsRequestSeq.current) {
          setDetailsLoading(false);
        }
      });
  }, [selectedSessionId]);

  const totalTokens = filtered.reduce((sum, session) => sum + session.tokenTotal, 0);
  const totalCost = filtered.reduce((sum, session) => sum + session.costUsdTotal, 0);

  const searchOptions = useMemo(() => {
    const values = new Set<string>([
      ...items.slice(0, 40).map((session) => session.sessionKey),
      ...items.slice(0, 40).map((session) => session.sessionId),
      "dm:",
      "group:",
      "thread:",
    ]);
    return [...values].filter(Boolean).map((value) => ({ value, label: value }));
  }, [items]);

  const selected = filtered.find((session) => session.sessionId === selectedSessionId)
    ?? filtered[0]
    ?? null;

  if (error && !data) {
    return <p className="error">{error}</p>;
  }

  if (!data) {
    return (
      <section className="workflow-page">
        <PageHeader
          eyebrow="Runtime"
          title={pageCopy.sessions.title}
          subtitle={pageCopy.sessions.subtitle}
        />
        <CardSkeleton lines={5} />
      </section>
    );
  }

  return (
    <section className="workflow-page sessions-page">
      <PageHeader
        eyebrow="Runtime"
        title={pageCopy.sessions.title}
        subtitle={pageCopy.sessions.subtitle}
        hint="Inspect active and historical session health, cost, and transcript flow without leaving Mission Control."
        actions={(
          <div className="workflow-summary-strip">
            <StatusChip tone="live">{filtered.length} visible</StatusChip>
            <StatusChip tone={filtered.some((session) => session.health === "blocked") ? "warning" : "muted"}>
              {filtered.filter((session) => session.health === "blocked").length} blocked
            </StatusChip>
            <StatusChip>${totalCost.toFixed(4)} visible cost</StatusChip>
          </div>
        )}
      />
      <PageGuideCard
        pageId="sessions"
        what={pageCopy.sessions.guide?.what ?? ""}
        when={pageCopy.sessions.guide?.when ?? ""}
        actions={pageCopy.sessions.guide?.actions ?? []}
        terms={pageCopy.sessions.guide?.terms}
      />
      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
      </div>

      <div className="office-kpi-grid">
        <article className="office-kpi-card">
          <p className="office-kpi-label">Visible sessions</p>
          <p className="office-kpi-value">{filtered.length}</p>
          <p className="office-kpi-note">After current filters</p>
        </article>
        <article className="office-kpi-card">
          <p className="office-kpi-label">Total tokens</p>
          <p className="office-kpi-value">{totalTokens}</p>
          <p className="office-kpi-note">For visible sessions</p>
        </article>
        <article className="office-kpi-card">
          <p className="office-kpi-label">Total cost</p>
          <p className="office-kpi-value">${totalCost.toFixed(4)}</p>
          <p className="office-kpi-note">USD aggregate</p>
        </article>
        <article className="office-kpi-card">
          <p className="office-kpi-label">Blocked sessions</p>
          <p className="office-kpi-value">{filtered.filter((session) => session.health === "blocked").length}</p>
          <p className="office-kpi-note">Needs intervention</p>
        </article>
      </div>

      <DataToolbar
        primary={(
          <>
            <SelectOrCustom
              value={search}
              onChange={setSearch}
              options={searchOptions}
              customPlaceholder="Search session key or id"
              customLabel="Search query"
            />
            <GCSelect
              value={healthFilter}
              onChange={(value) => setHealthFilter(value as "all" | "healthy" | "degraded" | "blocked")}
              options={[
                { value: "all", label: "all health states" },
                { value: "healthy", label: "healthy" },
                { value: "degraded", label: "degraded" },
                { value: "blocked", label: "blocked" },
              ]}
            />
          </>
        )}
        secondary={(
          <button type="button" onClick={() => setViewMode((current) => (current === "split" ? "table" : "split"))}>
            {viewMode === "split" ? "Switch to table view" : "Switch to split view"}
          </button>
        )}
      />

      {viewMode === "table" ? (
        <Panel
          title="Sessions Table"
          subtitle="Use the table when you want a compact scan of session health, recency, and spend."
        >
          {detailsLoading ? <TableSkeleton rows={6} cols={5} /> : (
            <div className="virtual-table-shell">
              <TableVirtuoso
                data={filtered}
                fixedHeaderContent={() => (
                  <tr>
                    <th>Session Key</th>
                    <th>Health</th>
                    <th>Updated</th>
                    <th>Tokens</th>
                    <th>Cost (USD)</th>
                  </tr>
                )}
                itemContent={(_index, session) => (
                  <>
                    <td>{session.sessionKey}</td>
                    <td><span className="token-chip">{session.health}</span></td>
                    <td>{new Date(session.updatedAt).toLocaleString()}</td>
                    <td>{session.tokenTotal}</td>
                    <td>{session.costUsdTotal.toFixed(4)}</td>
                  </>
                )}
              />
            </div>
          )}
        </Panel>
      ) : (
        <div className="split-grid">
          <Panel
            title="Session List"
            subtitle="Pick a session from the rail to inspect transcript health and recent events."
          >
            <div className="virtual-list-shell">
              <Virtuoso
                data={filtered}
                itemContent={(_index, session) => (
                  <div className="virtual-list-item">
                    <button
                      type="button"
                      className={`session-list-button ${session.sessionId === selected?.sessionId ? "active" : ""}`}
                      onClick={() => setSelectedSessionId(session.sessionId)}
                    >
                      {session.sessionKey}
                    </button>
                    <p className="office-subtitle session-detail-copy">
                      {session.health} | {new Date(session.updatedAt).toLocaleString()} | ${session.costUsdTotal.toFixed(4)}
                    </p>
                  </div>
                )}
              />
            </div>
          </Panel>

          <Panel
            title="Session Detail"
            subtitle="The selected session shows its identity, last message, event count, and recent timeline."
          >
            {!selected ? <p className="office-subtitle">Select a session to inspect details.</p> : null}
            {detailsLoading ? <CardSkeleton lines={7} /> : null}
            {selected && !detailsLoading ? (
              <>
                <p><strong>{selected.sessionKey}</strong></p>
                <p className="office-subtitle session-detail-copy">
                  Session ID: {selected.sessionId}
                </p>
                <p className="office-subtitle session-detail-copy">
                  Last message: {summary?.lastMessagePreview ?? "(none yet)"}
                </p>
                <p className="office-subtitle session-detail-copy">
                  Timeline events: {summary?.transcriptEventCount ?? 0}
                </p>
                <h4>Recent Timeline</h4>
                {timeline.length === 0 ? <p className="office-subtitle">No transcript events yet.</p> : (
                  <div className="virtual-list-shell compact">
                    <Virtuoso
                      data={timeline.slice(0, 120)}
                      itemContent={(_index, item) => (
                        <div className="virtual-list-item">
                          <strong>{item.type}</strong> [{item.actorType}] {new Date(item.timestamp).toLocaleString()}
                          <p className="office-subtitle session-timeline-copy">{item.preview}</p>
                        </div>
                      )}
                    />
                  </div>
                )}
              </>
            ) : null}
          </Panel>
        </div>
      )}
    </section>
  );
}
