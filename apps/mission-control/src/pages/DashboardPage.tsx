import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchCronJobs,
  fetchDashboardState,
  fetchMemoryFiles,
  fetchOperators,
  fetchSystemVitals,
  type CronJobsResponse,
  type DashboardStateResponse,
  type OperatorsResponse,
  type SystemVitalsResponse,
} from "../api/client";
import { DataToolbar } from "../components/DataToolbar";
import { FieldHelp } from "../components/FieldHelp";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatCard } from "../components/StatCard";
import { StatusChip } from "../components/StatusChip";
import { CardSkeleton } from "../components/CardSkeleton";
import { pageCopy } from "../content/copy";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";

type DashboardTab = "approvals" | "tasks" | "sessions" | "settings" | "integrations" | "office" | "chat";

export function DashboardPage({ onNavigate }: { onNavigate?: (tab: DashboardTab) => void }) {
  const [state, setState] = useState<DashboardStateResponse | null>(null);
  const [vitals, setVitals] = useState<SystemVitalsResponse | null>(null);
  const [cron, setCron] = useState<CronJobsResponse | null>(null);
  const [operators, setOperators] = useState<OperatorsResponse | null>(null);
  const [memoryFiles, setMemoryFiles] = useState<Array<{ relativePath: string; size: number; modifiedAt: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const initialLoadedRef = useRef(false);

  const loadDashboard = useCallback(async () => {
    const [dashboardResult, vitalsResult, cronResult, operatorsResult, memoryResult] = await Promise.allSettled([
      fetchDashboardState(),
      fetchSystemVitals(),
      fetchCronJobs(),
      fetchOperators(),
      fetchMemoryFiles(),
    ]);

    const dashboardError = dashboardResult.status === "rejected" ? (dashboardResult.reason as Error) : null;
    const vitalsError = vitalsResult.status === "rejected" ? (vitalsResult.reason as Error) : null;
    const coreMessage = [dashboardError?.message, vitalsError?.message].filter(Boolean).join(" | ");

    if (dashboardResult.status === "fulfilled") {
      setState(dashboardResult.value);
    }
    if (vitalsResult.status === "fulfilled") {
      setVitals(vitalsResult.value);
    }
    if (cronResult.status === "fulfilled") {
      setCron(cronResult.value);
    } else if (!initialLoadedRef.current) {
      setCron({ items: [] });
    }
    if (operatorsResult.status === "fulfilled") {
      setOperators(operatorsResult.value);
    } else if (!initialLoadedRef.current) {
      setOperators({ items: [] });
    }
    if (memoryResult.status === "fulfilled") {
      setMemoryFiles(memoryResult.value.items);
    } else if (!initialLoadedRef.current) {
      setMemoryFiles([]);
    }

    if (dashboardError || vitalsError) {
      if (!initialLoadedRef.current) {
        setError(coreMessage || "Unable to load dashboard.");
      } else {
        setError(`Background refresh failed: ${coreMessage || "Unable to refresh dashboard."}`);
      }
      return;
    }

    const supplementaryMessages = [
      cronResult.status === "rejected" ? "scheduler" : null,
      operatorsResult.status === "rejected" ? "operators" : null,
      memoryResult.status === "rejected" ? "memory files" : null,
    ].filter(Boolean) as string[];

    if (supplementaryMessages.length > 0) {
      setError(`Background refresh degraded: unable to refresh ${supplementaryMessages.join(", ")}.`);
    } else {
      setError(null);
    }

    initialLoadedRef.current = true;
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useRefreshSubscription("dashboard", () => loadDashboard(), {
    enabled: true,
    coalesceMs: 900,
    staleMs: 20000,
    pollIntervalMs: 15000,
  });

  if (error && (!state || !vitals || !cron || !operators)) {
    return (
      <section>
        <PageHeader eyebrow="Mission Control" title={pageCopy.dashboard.title} subtitle={pageCopy.dashboard.subtitle} />
        <p className="error">{error}</p>
      </section>
    );
  }

  if (!state || !vitals || !cron || !operators) {
    return (
      <section>
        <PageHeader eyebrow="Mission Control" title={pageCopy.dashboard.title} subtitle={pageCopy.dashboard.subtitle} />
        <div className="metric-grid">
          <CardSkeleton lines={5} />
          <CardSkeleton lines={5} />
        </div>
      </section>
    );
  }

  const urgentItems = [
    state.pendingApprovals > 0
      ? {
          key: "approvals",
          label: `${state.pendingApprovals} approvals are waiting on you`,
          tone: "warning" as const,
          action: () => onNavigate?.("approvals"),
          actionLabel: "Open approvals",
        }
      : null,
    cron.items.some((job) => !job.enabled)
      ? {
          key: "cron",
          label: `${cron.items.filter((job) => !job.enabled).length} scheduler jobs are disabled`,
          tone: "muted" as const,
          action: () => onNavigate?.("tasks"),
          actionLabel: "Review jobs",
        }
      : null,
    operators.items.some((operator) => operator.activeSessions > 0)
      ? {
          key: "operators",
          label: `${operators.items.reduce((sum, operator) => sum + operator.activeSessions, 0)} active operator sessions in flight`,
          tone: "live" as const,
          action: () => onNavigate?.("sessions"),
          actionLabel: "Inspect runs",
        }
      : null,
  ].filter(Boolean) as Array<{
    key: string;
    label: string;
    tone: "warning" | "muted" | "live";
    action: () => void;
    actionLabel: string;
  }>;

  const heroPrimaryAction =
    state.pendingApprovals > 0
      ? { label: "Review approvals", action: () => onNavigate?.("approvals") }
      : operators.items.some((operator) => operator.activeSessions > 0)
        ? { label: "Inspect active runs", action: () => onNavigate?.("sessions") }
        : { label: "Open chat", action: () => onNavigate?.("chat") };

  const heroSecondaryAction =
    state.activeSubagents > 0
      ? { label: "Open Herd HQ", action: () => onNavigate?.("office") }
      : { label: "Open settings", action: () => onNavigate?.("settings") };

  const activeOperatorSessions = operators.items.reduce((sum, operator) => sum + operator.activeSessions, 0);
  const memoryArtifactCount = memoryFiles.length;

  return (
    <section className="dashboard-page">
      {/* ── Tier 0: Compact hero — orient, not dominate ── */}
      <section className="dashboard-hero dashboard-hero-compact" aria-label="Mission Control overview">
        <div className="dashboard-hero-copy">
          <div className="dashboard-hero-heading">
            <p className="dashboard-hero-kicker">{pageCopy.dashboard.title}</p>
            <h1>What needs attention now</h1>
          </div>
          <DataToolbar
            className="dashboard-hero-actions"
            primary={
              <div className="actions">
                <button type="button" className="gc-button dashboard-hero-primary" onClick={heroPrimaryAction.action}>
                  {heroPrimaryAction.label}
                </button>
                <button type="button" className="gc-button dashboard-hero-secondary" onClick={heroSecondaryAction.action}>
                  {heroSecondaryAction.label}
                </button>
              </div>
            }
          />
        </div>
      </section>

      {error ? <p className="error">{error}</p> : null}

      {/* ── Tier 1: Critical / active — highest contrast, tightest spacing ── */}
      <div className="dashboard-tier dashboard-tier-1">
        <Panel
          title="Needs attention"
          subtitle={urgentItems.length > 0 ? `${urgentItems.length} items require operator action` : undefined}
          className="dashboard-urgent-panel"
          tone={urgentItems.length > 0 ? "warning" : "default"}
        >
          {urgentItems.length === 0 ? (
            <FieldHelp>No urgent blockers detected. All clear.</FieldHelp>
          ) : (
            <ul className="dashboard-priority-list">
              {urgentItems.map((item) => (
                <li key={item.key}>
                  <div>
                    <StatusChip tone={item.tone}>
                      {item.tone === "live" ? "Live" : item.tone === "warning" ? "Needs review" : "Heads-up"}
                    </StatusChip>
                    <p>{item.label}</p>
                  </div>
                  <button type="button" onClick={item.action} className="gc-button">
                    {item.actionLabel}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="dashboard-kpi-grid dashboard-kpi-grid-summit">
          <StatCard
            label="Pending approvals"
            value={state.pendingApprovals}
            note="Awaiting your decision"
            tone={state.pendingApprovals > 0 ? "warning" : "default"}
            interactive
            onClick={() => onNavigate?.("approvals")}
          />
          <StatCard
            label="Active sub-agents"
            value={state.activeSubagents}
            note="In-flight task work"
            tone={state.activeSubagents > 0 ? "accent" : "default"}
            interactive
            onClick={() => onNavigate?.("sessions")}
          />
          <StatCard label="Daily cost" value={`$${state.dailyCostUsd.toFixed(4)}`} note="Current node today" />
          <StatCard label="Tracked sessions" value={state.sessions.length} note="Visible to this node" />
        </div>
      </div>

      {/* ── Tier 2: Monitoring — moderate contrast ── */}
      <div className="dashboard-tier dashboard-tier-2">
        <div className="dashboard-main-grid">
          <Panel title="System vitals" subtitle={`${vitals.hostname} · ${vitals.platform} ${vitals.release}`}>
            <div className="dashboard-vitals-grid">
              <div>
                <p className="dashboard-vitals-label">CPU cores</p>
                <p className="dashboard-vitals-value">{vitals.cpuCount}</p>
              </div>
              <div>
                <p className="dashboard-vitals-label">Memory used</p>
                <p className="dashboard-vitals-value">{formatBytes(vitals.memoryUsedBytes)}</p>
                <FieldHelp>{formatBytes(vitals.memoryTotalBytes)} total</FieldHelp>
              </div>
              <div>
                <p className="dashboard-vitals-label">Process RSS</p>
                <p className="dashboard-vitals-value">{formatBytes(vitals.processRssBytes)}</p>
              </div>
              <div>
                <p className="dashboard-vitals-label">Memory artifacts</p>
                <p className="dashboard-vitals-value">{memoryArtifactCount}</p>
              </div>
            </div>
          </Panel>
          <Panel title="Task load" subtitle="Pressure by status bucket">
            <table className="dashboard-data-table gc-data-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {state.taskStatusCounts.map((row) => (
                  <tr key={row.status}>
                    <td>{row.status}</td>
                    <td className="dashboard-data-table-number">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>

        <Panel
          title="Quick actions"
          subtitle="Entry points for the next operator loop"
          className="dashboard-quick-actions-panel"
        >
          <div className="dashboard-action-grid">
            <button type="button" onClick={() => onNavigate?.("approvals")} className="gc-button">
              Review approvals
            </button>
            <button type="button" onClick={() => onNavigate?.("tasks")} className="gc-button">
              Open Trailboard
            </button>
            <button type="button" onClick={() => onNavigate?.("sessions")} className="gc-button">
              Inspect runs
            </button>
            <button type="button" onClick={() => onNavigate?.("office")} className="gc-button">
              Open Herd HQ
            </button>
            <button type="button" onClick={() => onNavigate?.("settings")} className="gc-button">
              Tune Forge
            </button>
            <button type="button" onClick={() => onNavigate?.("integrations")} className="gc-button">
              Configure connections
            </button>
          </div>
        </Panel>
      </div>

      {/* ── Tier 3: Background — quieter, compressed ── */}
      <div className="dashboard-tier dashboard-tier-3">
        <div className="dashboard-secondary-grid">
          <Panel title="Scheduler" subtitle="Automation jobs">
            {cron.items.length === 0 ? (
              <FieldHelp>No scheduler jobs configured.</FieldHelp>
            ) : (
              <table className="dashboard-data-table gc-data-table">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Schedule</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {cron.items.map((job) => (
                    <tr key={job.jobId}>
                      <td>{job.name}</td>
                      <td className="dashboard-data-table-mono">{job.schedule}</td>
                      <td>
                        <StatusChip tone={job.enabled ? "success" : "muted"}>
                          {job.enabled ? "Enabled" : "Disabled"}
                        </StatusChip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          <Panel title="Operators" subtitle={`${activeOperatorSessions} active`}>
            {operators.items.length === 0 ? (
              <FieldHelp>No operators registered.</FieldHelp>
            ) : (
              <table className="dashboard-data-table gc-data-table">
                <thead>
                  <tr>
                    <th>Operator</th>
                    <th>Sessions</th>
                    <th>Active</th>
                  </tr>
                </thead>
                <tbody>
                  {operators.items.map((operator) => (
                    <tr key={operator.operatorId}>
                      <td className="dashboard-data-table-mono">{operator.operatorId}</td>
                      <td className="dashboard-data-table-number">{operator.sessionCount}</td>
                      <td className="dashboard-data-table-number">{operator.activeSessions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </div>

      <PageGuideCard
        pageId="dashboard"
        what={pageCopy.dashboard.guide?.what ?? ""}
        when={pageCopy.dashboard.guide?.when ?? ""}
        actions={pageCopy.dashboard.guide?.actions ?? []}
        terms={pageCopy.dashboard.guide?.terms}
      />
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} B`;
}


