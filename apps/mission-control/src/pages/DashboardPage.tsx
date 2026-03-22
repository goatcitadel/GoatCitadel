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

export function DashboardPage({
  onNavigate,
}: {
  onNavigate?: (tab: DashboardTab) => void;
}) {
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

    const dashboardError = dashboardResult.status === "rejected" ? dashboardResult.reason as Error : null;
    const vitalsError = vitalsResult.status === "rejected" ? vitalsResult.reason as Error : null;
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
        <PageHeader
          eyebrow="Mission Control"
          title={pageCopy.dashboard.title}
          subtitle={pageCopy.dashboard.subtitle}
        />
        <p className="error">{error}</p>
      </section>
    );
  }

  if (!state || !vitals || !cron || !operators) {
    return (
      <section>
        <PageHeader
          eyebrow="Mission Control"
          title={pageCopy.dashboard.title}
          subtitle={pageCopy.dashboard.subtitle}
        />
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

  const heroPrimaryAction = state.pendingApprovals > 0
    ? { label: "Review approvals", action: () => onNavigate?.("approvals") }
    : operators.items.some((operator) => operator.activeSessions > 0)
      ? { label: "Inspect active runs", action: () => onNavigate?.("sessions") }
      : { label: "Open chat workspace", action: () => onNavigate?.("chat") };

  const heroSecondaryAction = state.activeSubagents > 0
    ? { label: "Enter Herd HQ", action: () => onNavigate?.("office") }
    : { label: "Tune the Forge", action: () => onNavigate?.("settings") };

  const schedulerDisabledCount = cron.items.filter((job) => !job.enabled).length;
  const activeOperatorSessions = operators.items.reduce((sum, operator) => sum + operator.activeSessions, 0);
  const memoryArtifactCount = memoryFiles.length;

  return (
    <section className="dashboard-page">
      <section className="dashboard-hero" aria-label="Summit overview hero">
        <div className="dashboard-hero-copy">
          <div className="dashboard-hero-heading">
            <p className="dashboard-hero-kicker">{pageCopy.dashboard.title}</p>
            <p className="dashboard-hero-brand">GoatCitadel</p>
            <h1>Command Deck for the herd, the work, and the calls that still need you.</h1>
          </div>
          <p className="dashboard-hero-summary">
            Summit keeps the first glance focused on workload, system posture, and the moments where human judgment
            still matters. No dashboard soup. Just the state of the herd and the next move.
          </p>
          <DataToolbar
            className="dashboard-hero-actions"
            primary={
              <div className="actions">
                <button type="button" className="dashboard-hero-primary" onClick={heroPrimaryAction.action}>
                  {heroPrimaryAction.label}
                </button>
                <button type="button" className="dashboard-hero-secondary" onClick={heroSecondaryAction.action}>
                  {heroSecondaryAction.label}
                </button>
              </div>
            }
          />
        </div>
      </section>

      {error ? <p className="error">{error}</p> : null}

      <div className="dashboard-kpi-grid dashboard-kpi-grid-summit">
        <StatCard
          label="Pending approvals"
          value={state.pendingApprovals}
          note="Risky actions waiting for your decision."
          tone={state.pendingApprovals > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Active sub-agents"
          value={state.activeSubagents}
          note="Sessions currently doing task work."
          tone={state.activeSubagents > 0 ? "accent" : "default"}
        />
        <StatCard
          label="Daily cost"
          value={`$${state.dailyCostUsd.toFixed(4)}`}
          note="Today across the current node."
        />
        <StatCard
          label="Tracked sessions"
          value={state.sessions.length}
          note="Total sessions visible to this node."
        />
      </div>

      <div className="dashboard-main-grid">
        <Panel
          title="Intervene early"
          subtitle="The few things worth acting on before you dive into the rest of the stack."
          className="dashboard-urgent-panel"
        >
          {urgentItems.length === 0 ? (
            <FieldHelp>No urgent blockers detected. Use quick actions to move into the next workflow deliberately.</FieldHelp>
          ) : (
            <ul className="dashboard-priority-list">
              {urgentItems.map((item) => (
                <li key={item.key}>
                  <div>
                    <StatusChip tone={item.tone}>{item.tone === "live" ? "Live" : item.tone === "warning" ? "Needs review" : "Heads-up"}</StatusChip>
                    <p>{item.label}</p>
                  </div>
                  <button type="button" onClick={item.action}>{item.actionLabel}</button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel
          title="Keep the herd moving"
          subtitle="High-signal entry points for the next operator loop."
          className="dashboard-quick-actions-panel"
        >
          <div className="dashboard-action-grid">
            <button type="button" onClick={() => onNavigate?.("approvals")}>Review approvals</button>
            <button type="button" onClick={() => onNavigate?.("tasks")}>Open Trailboard</button>
            <button type="button" onClick={() => onNavigate?.("sessions")}>Inspect runs</button>
            <button type="button" onClick={() => onNavigate?.("office")}>Open Herd HQ</button>
            <button type="button" onClick={() => onNavigate?.("settings")}>Tune Forge</button>
            <button type="button" onClick={() => onNavigate?.("integrations")}>Configure connections</button>
          </div>
        </Panel>
      </div>

      <div className="dashboard-secondary-grid">
        <Panel
          title="Citadel vitals"
          subtitle={`${vitals.hostname} · ${vitals.platform} ${vitals.release}`}
        >
          <div className="dashboard-vitals-grid">
            <div>
              <p className="dashboard-vitals-label">CPU cores</p>
              <p className="dashboard-vitals-value">{vitals.cpuCount}</p>
            </div>
            <div>
              <p className="dashboard-vitals-label">Memory used</p>
              <p className="dashboard-vitals-value">{formatBytes(vitals.memoryUsedBytes)}</p>
              <FieldHelp>{formatBytes(vitals.memoryTotalBytes)} total memory available.</FieldHelp>
            </div>
            <div>
              <p className="dashboard-vitals-label">Process RSS</p>
              <p className="dashboard-vitals-value">{formatBytes(vitals.processRssBytes)}</p>
            </div>
            <div>
              <p className="dashboard-vitals-label">Memory artifacts</p>
              <p className="dashboard-vitals-value">{memoryArtifactCount}</p>
              <FieldHelp>Recent workspace memory files visible to this node.</FieldHelp>
            </div>
          </div>
        </Panel>
        <Panel title="Trailboard pressure" subtitle="Current task pressure by status bucket.">
          <ul className="compact-list">
            {state.taskStatusCounts.map((row) => (
              <li key={row.status}>{row.status}: {row.count}</li>
            ))}
          </ul>
        </Panel>
        <Panel title="Bell Tower posture" subtitle="Scheduler posture and whether routine automation is healthy.">
          <ul className="compact-list">
            {cron.items.map((job) => (
              <li key={job.jobId}>
                <strong>{job.name}</strong> ({job.schedule}) - {job.enabled ? "enabled" : "disabled"}
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="dashboard-secondary-grid">
        <Panel title="Operators" subtitle={`${activeOperatorSessions} active sessions are in motion across the herd.`}>
          <ul className="compact-list">
            {operators.items.map((operator) => (
              <li key={operator.operatorId}>
                <strong>{operator.operatorId}</strong> - sessions {operator.sessionCount}, active {operator.activeSessions}
              </li>
            ))}
          </ul>
        </Panel>
        <Panel
          title="Command notes"
          subtitle="A fast human-readable summary of the machine state behind Summit."
          className="dashboard-command-notes"
        >
          <div className="dashboard-command-note-list">
            <p>
              <strong>{state.pendingApprovals}</strong> approvals need operator judgment before risky work can continue.
            </p>
            <p>
              <strong>{schedulerDisabledCount}</strong> Bell Tower jobs are currently disabled.
            </p>
            <p>
              <strong>{formatBytes(vitals.processRssBytes)}</strong> of resident memory is tied up in the active gateway process.
            </p>
            <p>
              <strong>{memoryArtifactCount}</strong> recent memory artifacts are visible for context recovery and replay.
            </p>
          </div>
        </Panel>
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
