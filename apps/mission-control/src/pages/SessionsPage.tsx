import { useEffect, useMemo, useRef, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { Virtuoso } from "react-virtuoso";
import {
  fetchRuntimeLifecycle,
  fetchSessionSummary,
  fetchSessionTimeline,
  fetchSessions,
  type RuntimeLifecycleResponse,
  type SessionSummary,
  type SessionTimelineItem,
  type SessionsResponse,
} from "../api/client";
import { DataToolbar } from "../components/DataToolbar";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { SelectOrCustom } from "../components/SelectOrCustom";
import { CardSkeleton } from "../components/CardSkeleton";
import { StatusChip } from "../components/StatusChip";
import { GCSelect } from "../components/ui";
import { pageCopy } from "../content/copy";

export function SessionsPage() {
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [search, setSearch] = useState("");
  const [healthFilter, setHealthFilter] = useState<"all" | "healthy" | "degraded" | "blocked">("all");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [timeline, setTimeline] = useState<SessionTimelineItem[]>([]);
  const [lifecycle, setLifecycle] = useState<RuntimeLifecycleResponse | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"split" | "table">("split");
  const [sorting, setSorting] = useState<SortingState>([{ id: "updatedAt", desc: true }]);
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

  const items = useMemo(() => data?.items ?? [], [data]);

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
    if (filtered.length === 0) {
      setSelectedSessionId(null);
      return;
    }
    if (!selectedSessionId || !filtered.some((session) => session.sessionId === selectedSessionId)) {
      setSelectedSessionId(filtered[0]?.sessionId ?? null);
    }
  }, [filtered, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      setSummary(null);
      setTimeline([]);
      setLifecycle(null);
      return;
    }
    const requestId = ++detailsRequestSeq.current;
    setDetailsLoading(true);
    void Promise.all([
      fetchSessionSummary(selectedSessionId),
      fetchSessionTimeline(selectedSessionId, 160),
      fetchRuntimeLifecycle({ sessionId: selectedSessionId }),
    ])
      .then(([summaryRes, timelineRes, lifecycleRes]) => {
        if (requestId !== detailsRequestSeq.current) {
          return;
        }
        setSummary(summaryRes);
        setTimeline(timelineRes.items);
        setLifecycle(lifecycleRes);
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
  const healthyCount = filtered.filter((session) => session.health === "healthy").length;
  const degradedCount = filtered.filter((session) => session.health === "degraded").length;
  const blockedCount = filtered.filter((session) => session.health === "blocked").length;

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

  const selected = filtered.find((session) => session.sessionId === selectedSessionId) ?? filtered[0] ?? null;
  const sessionColumns = useMemo<ColumnDef<SessionsResponse["items"][number]>[]>(
    () => [
      {
        accessorKey: "sessionKey",
        header: "Session Key",
        cell: ({ row }) => row.original.sessionKey,
      },
      {
        accessorKey: "health",
        header: "Health",
        cell: ({ row }) => <StatusChip tone={sessionHealthTone(row.original.health)}>{row.original.health}</StatusChip>,
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ row }) => new Date(row.original.updatedAt).toLocaleString(),
      },
      {
        accessorKey: "tokenTotal",
        header: "Tokens",
        cell: ({ row }) => row.original.tokenTotal.toLocaleString(),
      },
      {
        accessorKey: "costUsdTotal",
        header: "Cost (USD)",
        cell: ({ row }) => `$${row.original.costUsdTotal.toFixed(4)}`,
      },
    ],
    [],
  );
  const sessionTable = useReactTable({
    data: filtered,
    columns: sessionColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (error && !data) {
    return <p className="error">{error}</p>;
  }

  if (!data) {
    return (
      <section className="workflow-page">
        <PageHeader eyebrow="Runtime" title={pageCopy.sessions.title} subtitle={pageCopy.sessions.subtitle} />
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
        actions={
          <div className="workflow-summary-strip">
            <StatusChip tone="live">{filtered.length} visible</StatusChip>
            <StatusChip tone={blockedCount > 0 ? "warning" : "muted"}>{blockedCount} blocked</StatusChip>
            <StatusChip>${totalCost.toFixed(4)} visible cost</StatusChip>
          </div>
        }
      />
      <div className="workflow-status-stack">{error ? <p className="error">{error}</p> : null}</div>
      <div className="workflow-summary-strip sessions-summary-strip">
        <StatusChip tone="success">{healthyCount} healthy</StatusChip>
        <StatusChip tone={degradedCount > 0 ? "warning" : "muted"}>{degradedCount} degraded</StatusChip>
        <StatusChip tone={blockedCount > 0 ? "critical" : "muted"}>{blockedCount} blocked</StatusChip>
        <StatusChip tone="muted">{totalTokens.toLocaleString()} tokens</StatusChip>
      </div>

      <DataToolbar
        primary={
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
        }
        secondary={
          <button
            type="button"
            onClick={() => setViewMode((current) => (current === "split" ? "table" : "split"))}
            className="gc-button"
          >
            {viewMode === "split" ? "Switch to table view" : "Switch to split view"}
          </button>
        }
      />

      {viewMode === "table" ? (
        <Panel
          title="Sessions Table"
          subtitle="Use the table when you want a compact scan of session health, recency, and spend."
        >
          {filtered.length === 0 ? (
            <p className="office-subtitle">No sessions match the current filter.</p>
          ) : (
            <div className="virtual-table-shell">
              <table className="gc-data-table sessions-table">
                <thead>
                  {sessionTable.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id}>
                      {headerGroup.headers.map((header) => {
                        const sortState = header.column.getIsSorted();
                        return (
                          <th key={header.id}>
                            <button
                              type="button"
                              className="sessions-table-sort"
                              onClick={header.column.getToggleSortingHandler()}
                            >
                              <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                              <span className="sessions-table-sort-indicator" aria-hidden="true">
                                {sortState === "asc" ? "↑" : sortState === "desc" ? "↓" : "↕"}
                              </span>
                            </button>
                          </th>
                        );
                      })}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {sessionTable.getRowModel().rows.map((row) => (
                    <tr
                      key={row.id}
                      className={row.original.sessionId === selectedSessionId ? "row-selected" : undefined}
                      onClick={() => setSelectedSessionId(row.original.sessionId)}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : (
        <div className="sessions-shell">
          <Panel
            title="Sessions"
            subtitle="Filter the rail, then step through recent work without losing runtime posture."
            actions={
              <div className="workflow-summary-strip">
                <StatusChip tone="muted">{filtered.length} shown</StatusChip>
                <StatusChip tone="muted">{selected ? selected.kind : "none selected"}</StatusChip>
              </div>
            }
          >
            {filtered.length === 0 ? <p className="office-subtitle">No sessions match the current filter.</p> : null}
            <div className="virtual-list-shell">
              <Virtuoso
                data={filtered}
                itemContent={(_index, session) => (
                  <div className="virtual-list-item">
                    <button
                      type="button"
                      className={["session-rail-item", session.sessionId === selected?.sessionId ? "active" : ""]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => setSelectedSessionId(session.sessionId)}
                    >
                      <span className="session-rail-head">
                        <strong>{session.sessionKey}</strong>
                        <span className="session-rail-time">{new Date(session.updatedAt).toLocaleString()}</span>
                      </span>
                      <span className="session-rail-meta">
                        <StatusChip tone={sessionHealthTone(session.health)}>{session.health}</StatusChip>
                        <span>{session.kind}</span>
                        <span>{session.tokenTotal.toLocaleString()} tokens</span>
                        <span>${session.costUsdTotal.toFixed(4)}</span>
                      </span>
                    </button>
                  </div>
                )}
              />
            </div>
          </Panel>

          <Panel
            title={selected ? selected.sessionKey : "Session detail"}
            subtitle={
              selected
                ? `${selected.sessionId} · ${selected.channel}/${selected.account}`
                : "Select a session to inspect details."
            }
            actions={
              selected ? (
                <div className="workflow-summary-strip">
                  <StatusChip tone={sessionHealthTone(selected.health)}>{selected.health}</StatusChip>
                  <StatusChip tone={sessionBudgetTone(selected.budgetState)}>{selected.budgetState}</StatusChip>
                  <StatusChip tone="muted">{selected.kind}</StatusChip>
                </div>
              ) : null
            }
          >
            {!selected ? <p className="office-subtitle">Select a session to inspect details.</p> : null}
            {detailsLoading ? <CardSkeleton lines={7} /> : null}
            {selected && !detailsLoading ? (
              <>
                <div className="sessions-detail-summary">
                  <p className="office-subtitle session-detail-copy">
                    {summary?.lastMessagePreview ?? "No assistant or user message recorded yet."}
                  </p>
                  <div className="sessions-detail-grid">
                    <div className="sessions-detail-metric">
                      <span>Updated</span>
                      <strong>{new Date(selected.updatedAt).toLocaleString()}</strong>
                    </div>
                    <div className="sessions-detail-metric">
                      <span>Last activity</span>
                      <strong>{new Date(selected.lastActivityAt).toLocaleString()}</strong>
                    </div>
                    <div className="sessions-detail-metric">
                      <span>Timeline events</span>
                      <strong>{summary?.transcriptEventCount ?? 0}</strong>
                    </div>
                    <div className="sessions-detail-metric">
                      <span>Latest event</span>
                      <strong>{summary?.latestEventType ?? "unknown"}</strong>
                    </div>
                    <div className="sessions-detail-metric">
                      <span>Tokens</span>
                      <strong>{selected.tokenTotal.toLocaleString()}</strong>
                    </div>
                    <div className="sessions-detail-metric">
                      <span>Spend</span>
                      <strong>${selected.costUsdTotal.toFixed(4)}</strong>
                    </div>
                  </div>
                </div>
                {lifecycle ? (
                  <details className="advanced-panel sessions-runtime-details">
                    <summary>Linked runtime context</summary>
                    <div className="sessions-detail-grid sessions-detail-grid-compact">
                      <div className="sessions-detail-metric">
                        <span>Turns</span>
                        <strong>{lifecycle.linked.turnIds.length}</strong>
                      </div>
                      <div className="sessions-detail-metric">
                        <span>Approvals</span>
                        <strong>{lifecycle.linked.approvalIds.length}</strong>
                      </div>
                      <div className="sessions-detail-metric">
                        <span>Runs</span>
                        <strong>{lifecycle.linked.runIds.length}</strong>
                      </div>
                      <div className="sessions-detail-metric">
                        <span>Tasks</span>
                        <strong>{lifecycle.linked.taskIds.length}</strong>
                      </div>
                      <div className="sessions-detail-metric">
                        <span>Execution plans</span>
                        <strong>{lifecycle.executionPlans?.length ?? 0}</strong>
                      </div>
                      <div className="sessions-detail-metric">
                        <span>Delegation runs</span>
                        <strong>{lifecycle.delegationRuns?.length ?? 0}</strong>
                      </div>
                    </div>
                    <p className="office-subtitle session-detail-copy">
                      Proactive durable run: {lifecycle.proactiveDurableRun?.runId ?? "none"}
                      {" | "}
                      Approval wait run: {lifecycle.approvalWaitDurableRun?.runId ?? "none"}
                      {" | "}
                      Queried run: {lifecycle.durableRun?.runId ?? "none"}
                    </p>
                    {lifecycle.executionPlans?.length ? (
                      <ul className="compact-list">
                        {lifecycle.executionPlans.slice(0, 3).map((plan) => (
                          <li key={plan.planId}>
                            <strong>{plan.status}</strong>
                            {" | "}
                            {plan.objective}
                            {" | "}
                            {plan.planId}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {lifecycle.delegationSteps?.length ? (
                      <ul className="compact-list">
                        {lifecycle.delegationSteps.slice(0, 4).map((step) => (
                          <li key={step.stepId}>
                            <strong>{step.role}</strong>
                            {" | "}
                            {step.status}
                            {step.durableRunId ? ` | durable ${step.durableRunId}` : ""}
                            {step.childSessionId ? ` | session ${step.childSessionId}` : ""}
                            {step.childTurnId ? ` | turn ${step.childTurnId}` : ""}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </details>
                ) : null}
                <div className="sessions-section-heading">
                  <h4>Recent timeline</h4>
                  <span>{timeline.length} events</span>
                </div>
                {timeline.length === 0 ? (
                  <p className="office-subtitle">No transcript events yet.</p>
                ) : (
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

function sessionHealthTone(health: SessionsResponse["items"][number]["health"]): "success" | "warning" | "critical" {
  switch (health) {
    case "healthy":
      return "success";
    case "degraded":
      return "warning";
    case "blocked":
      return "critical";
    default:
      return "warning";
  }
}

function sessionBudgetTone(
  budgetState: SessionsResponse["items"][number]["budgetState"],
): "muted" | "warning" | "critical" {
  switch (budgetState) {
    case "ok":
      return "muted";
    case "warning":
      return "warning";
    case "hard_cap":
      return "critical";
    default:
      return "warning";
  }
}
