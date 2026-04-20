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
  { id: "system", label: "Runtime" },
  { id: "costs", label: "Spend" },
];

export function HealthPage({ activeTab, onTabChange }: HealthPageProps) {
  const { data, error, refresh, setError } = useHealthSummary();
  const [daemonBusy, setDaemonBusy] = useState(false);

  const activeSection = useMemo<(typeof ITEMS)[number]>(
    () => ITEMS.find((item) => item.id === activeTab) ?? ITEMS[0]!,
    [activeTab],
  );

  const vitals = data?.systemVitals ? normalizeSystemVitals(data.systemVitals) : null;
  const daemonStatus = data?.daemonStatus ?? null;
  const daemonLogs = data?.daemonLogs.items ?? [];
  const latestBackup = data?.backups.latest ?? null;
  const totalCostUsd = (data?.costs.summary.items ?? []).reduce((sum, item) => sum + item.costUsd, 0);
  const daemonStateTone = daemonStatus?.running ? "success" : "warning";
  const healthSummaryLine = daemonStatus?.running
    ? `Runtime serving · ${formatUsd(totalCostUsd)} recorded · ${latestBackup ? `Latest backup ${new Date(latestBackup.createdAt).toLocaleString()}` : "No backup loaded"}`
    : `Runtime needs attention · ${formatUsd(totalCostUsd)} recorded · ${latestBackup ? `Latest backup ${new Date(latestBackup.createdAt).toLocaleString()}` : "No backup loaded"}`;

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
        subtitle="Keep runtime and spend health readable without repeating the same state in multiple wrappers."
        density="compact"
      />
      <p className="office-subtitle">{healthSummaryLine}</p>
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
          subtitle="Part of the health snapshot could not be refreshed. Review the technical detail before acting."
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
                ? "Current runtime state, host vitals, and daemon control."
                : "Spend coverage, token usage, and backup state."
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
                    note="Compression impact for the current observation window"
                    compact
                    className="operator-summary-card"
                  />
                </div>
                <Panel
                  title="Spend breakdown"
                  subtitle="Inspect spend and token use without leaving Health."
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
                  title="Backup"
                  subtitle="Keep the latest backup signal in view while you inspect runtime or spend."
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
