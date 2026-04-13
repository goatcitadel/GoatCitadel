import { useCallback, useMemo, useState } from "react";
import { fetchHealthSummary, restartDaemon, startDaemon, stopDaemon } from "../api/client";
import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { PageTabs } from "../components/PageTabs";
import { Panel } from "../components/Panel";
import { SectionTitle } from "../components/SectionTitle";
import { StatCard } from "../components/StatCard";
import { StatusChip } from "../components/StatusChip";
import { SystemHostVitalsGrid } from "./system/SystemHostVitalsGrid";
import { SystemServiceManagerPanel } from "./system/SystemServiceManagerPanel";
import { normalizeSystemVitals } from "./system-page-normalizers";
import { useHealthSummary } from "./useHealthSummary";

export type HealthTab = "costs" | "system";

interface HealthPageProps {
  activeTab: HealthTab;
  onTabChange: (tab: HealthTab) => void;
}

const ITEMS: Array<{ id: HealthTab; label: string }> = [
  { id: "system", label: "Runtime state" },
  { id: "costs", label: "Spend and usage" },
];

export function HealthPage({ activeTab, onTabChange }: HealthPageProps) {
  const { data, error, isRefreshing, refresh, setError } = useHealthSummary();
  const [daemonBusy, setDaemonBusy] = useState(false);

  const activeSection = useMemo<(typeof ITEMS)[number]>(
    () => ITEMS.find((item) => item.id === activeTab) ?? ITEMS[0]!,
    [activeTab],
  );
  const secondarySections = useMemo(() => ITEMS.filter((item) => item.id !== activeSection.id), [activeSection.id]);

  const vitals = data?.systemVitals ? normalizeSystemVitals(data.systemVitals) : null;
  const daemonStatus = data?.daemonStatus ?? null;
  const daemonLogs = data?.daemonLogs.items ?? [];
  const latestBackup = data?.backups.latest ?? null;
  const totalCostUsd = (data?.costs.summary.items ?? []).reduce((sum, item) => sum + item.costUsd, 0);
  const totalTokens = (data?.costs.summary.items ?? []).reduce((sum, item) => sum + item.tokenTotal, 0);
  const daemonStateTone = daemonStatus?.running ? "success" : "warning";

  const refreshAndClearError = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const runDaemonAction = useCallback(
    async (action: () => Promise<{ status: unknown }>) => {
      setDaemonBusy(true);
      try {
        await action();
        await refresh();
      } catch (nextError) {
        setError((nextError as Error).message);
      } finally {
        setDaemonBusy(false);
      }
    },
    [refresh, setError],
  );

  return (
    <section className="space-page stack-lg">
      <SectionTitle
        title="Health"
        subtitle="Keep one health narrative in focus while the other lane stays compressed until you need it."
        density="compact"
      />
      <div className="office-kpi-grid operator-summary-strip">
        <StatCard
          label="Primary lane"
          value={activeSection.label}
          note="Current focus section"
          tone="accent"
          compact
          className="operator-summary-card"
        />
        <StatCard
          label="Runtime state"
          value={daemonStatus?.running ? "Serving" : "Needs intervention"}
          note={isRefreshing ? "Refreshing runtime, spend, and backup signals" : "Gateway and daemon posture"}
          tone={daemonStatus?.running ? "success" : "warning"}
          compact
          className="operator-summary-card"
        />
        <StatCard
          label="Recorded spend"
          value={formatUsd(totalCostUsd)}
          note={`${totalTokens.toLocaleString()} tokens in current window`}
          compact
          className="operator-summary-card"
        />
        <StatCard
          label="Latest backup"
          value={latestBackup ? new Date(latestBackup.createdAt).toLocaleString() : "Unavailable"}
          note={latestBackup ? `${latestBackup.files.length} files captured` : "No backup record loaded yet"}
          tone={latestBackup ? "success" : "warning"}
          compact
          className="operator-summary-card"
        />
      </div>
      <PageTabs
        items={ITEMS}
        activeId={activeTab}
        tier="section"
        ariaLabel="Health focus"
        onSelect={(value) => onTabChange(value as HealthTab)}
      />
      {error ? (
        <Panel
          title="Health data needs attention"
          subtitle="Part of the runtime health lane could not be refreshed. Review the technical detail before acting."
          tone="warning"
          rank="elevated"
          padding="compact"
        >
          <details className="advanced-panel">
            <summary>Technical detail</summary>
            <pre>{error}</pre>
          </details>
        </Panel>
      ) : null}
      <EmbeddedPageChromeProvider>
        <div className="stack-lg">
          <Panel
            title={activeSection.label}
            subtitle={
              activeSection.id === "system"
                ? "Process state, host vitals, and daemon control stay in one operator-readable runtime lane."
                : "Spend coverage, compression posture, and backup truth stay attached to runtime health."
            }
            tone="accent"
            rank="primary"
            padding="compact"
          >
            {activeSection.id === "system" ? (
              <div className="stack-lg">
                <div className="workflow-summary-strip">
                  <StatusChip tone={daemonStatus?.running ? "success" : "warning"}>
                    {daemonStatus?.running ? "Runtime serving" : "Runtime needs intervention"}
                  </StatusChip>
                  <StatusChip tone="muted">
                    {daemonStatus?.host ? `Host ${daemonStatus.host}` : "Host unavailable"}
                  </StatusChip>
                  <StatusChip tone={latestBackup ? "success" : "warning"}>
                    {latestBackup ? "Backup ready" : "Backup missing"}
                  </StatusChip>
                </div>
                {vitals ? (
                  <SystemHostVitalsGrid vitals={vitals} />
                ) : (
                  <p className="office-subtitle">System vitals unavailable.</p>
                )}
                <SystemServiceManagerPanel
                  daemonStatus={daemonStatus}
                  daemonStateTone={daemonStateTone}
                  daemonControlSupported={daemonStatus?.controllable ?? false}
                  daemonBusy={daemonBusy}
                  daemonLogs={daemonLogs}
                  onStart={() => void runDaemonAction(startDaemon)}
                  onStop={() => void runDaemonAction(stopDaemon)}
                  onRestart={() => void runDaemonAction(restartDaemon)}
                  onRefresh={() => void refreshAndClearError()}
                />
              </div>
            ) : (
              <div className="stack-lg">
                <div className="workflow-summary-strip">
                  <StatusChip tone="muted">Scope {data?.costs.summary.scope ?? "day"}</StatusChip>
                  <StatusChip tone="muted">
                    Tracked {data?.costs.summary.usageAvailability?.trackedEvents ?? 0}
                  </StatusChip>
                  <StatusChip tone={latestBackup ? "success" : "warning"}>
                    {latestBackup ? "Backup ready" : "Backup missing"}
                  </StatusChip>
                </div>
                <div className="office-kpi-grid operator-summary-strip">
                  <StatCard
                    label="Usage coverage"
                    value={`${data?.costs.summary.usageAvailability?.trackedEvents ?? 0} tracked`}
                    note={`${data?.costs.summary.usageAvailability?.unknownEvents ?? 0} unknown of ${data?.costs.summary.usageAvailability?.totalAgentEvents ?? 0} total agent events`}
                    compact
                    className="operator-summary-card"
                  />
                  <StatCard
                    label="QMD impact"
                    value={describeQmdImpact(data?.costs.qmd)}
                    note="Compression posture for the current observation window"
                    compact
                    className="operator-summary-card"
                  />
                </div>
                <Panel
                  title="Spend breakdown"
                  subtitle="Inspect spend and token use without leaving the health surface."
                  tone="soft"
                  rank="muted"
                  padding="compact"
                >
                  <div className="stack-sm">
                    {(data?.costs.summary.items ?? []).map((item) => (
                      <div key={item.key} className="event-card">
                        <p>
                          <strong>{item.key}</strong>
                        </p>
                        <p className="office-subtitle">
                          {item.tokenTotal.toLocaleString()} total tokens
                          {" · "}
                          {formatUsd(item.costUsd)}
                        </p>
                      </div>
                    ))}
                  </div>
                </Panel>
                <Panel
                  title="Backup Summary"
                  subtitle="Health keeps the current backup signal in view while you inspect runtime or spend."
                  tone={latestBackup ? "soft" : "warning"}
                  rank={latestBackup ? "muted" : "elevated"}
                  padding="compact"
                >
                  {latestBackup ? (
                    <p className="office-subtitle">
                      Latest backup {latestBackup.backupId} was created on{" "}
                      {new Date(latestBackup.createdAt).toLocaleString()} and captured {latestBackup.files.length}{" "}
                      files.
                    </p>
                  ) : (
                    <p className="office-subtitle">
                      No backup summary is available yet. Create a runtime backup from Runtime once the gateway is
                      healthy.
                    </p>
                  )}
                </Panel>
              </div>
            )}
          </Panel>
          <Panel
            title="Other lane"
            subtitle="The adjacent health narrative stays compressed until you focus it."
            tone="soft"
            rank="muted"
            padding="compact"
          >
            <div className="office-kpi-grid">
              {secondarySections.map((section) => (
                <StatCard
                  key={section.id}
                  label={section.label}
                  value={
                    section.id === "system"
                      ? daemonStatus?.running
                        ? "Serving cleanly"
                        : "Needs intervention"
                      : latestBackup
                        ? "Spend + backup view"
                        : "Check backup posture"
                  }
                  note={
                    section.id === "system"
                      ? "Open this lane for daemon control, host vitals, and live service posture."
                      : "Open this lane for spend coverage, QMD impact, and backup truth."
                  }
                  tone={
                    section.id === "system" && daemonStatus?.running
                      ? "success"
                      : section.id === "system"
                        ? "warning"
                        : "default"
                  }
                  compact
                  interactive
                  onClick={() => onTabChange(section.id)}
                />
              ))}
            </div>
          </Panel>
        </div>
      </EmbeddedPageChromeProvider>
    </section>
  );
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number.isFinite(value) ? value : 0);
}

function describeQmdImpact(qmd: Awaited<ReturnType<typeof fetchHealthSummary>>["costs"]["qmd"] | undefined): string {
  if (!qmd || qmd.totalRuns === 0) {
    return "No QMD samples";
  }
  if (qmd.efficiencyLabel === "reduced") {
    return `${qmd.compressionPercent}% reduced`;
  }
  if (qmd.efficiencyLabel === "expanded") {
    return `${qmd.expansionPercent}% expanded`;
  }
  return "Neutral";
}
