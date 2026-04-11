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

  const orderedSections = useMemo(() => {
    const current = ITEMS.find((item) => item.id === activeTab);
    const remainder = ITEMS.filter((item) => item.id !== activeTab);
    return current ? [current, ...remainder] : ITEMS;
  }, [activeTab]);

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

  const runDaemonAction = useCallback(async (action: () => Promise<{ status: unknown }>) => {
    setDaemonBusy(true);
    try {
      await action();
      await refresh();
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setDaemonBusy(false);
    }
  }, [refresh, setError]);

  return (
    <section className="space-page stack-lg">
      <SectionTitle
        title="Health"
        subtitle="Runtime posture, process health, spend, degraded-state warnings, and backup truth live together here."
      />
      <div className="office-kpi-grid">
        <StatCard label="Primary lane" value={activeTab === "system" ? "Runtime state" : "Spend and usage"} note="Current focus section" tone="accent" />
        <StatCard
          label="Recorded spend"
          value={formatUsd(totalCostUsd)}
          note={isRefreshing ? "Refreshing runtime, spend, and backup signals" : `${totalTokens.toLocaleString()} tokens in current window`}
        />
        <StatCard label="Latest backup" value={latestBackup ? new Date(latestBackup.createdAt).toLocaleString() : "Unavailable"} note={latestBackup ? `${latestBackup.files.length} files captured` : "No backup record loaded yet"} tone={latestBackup ? "success" : "warning"} />
        <StatCard label="QMD impact" value={describeQmdImpact(data?.costs.qmd)} note="Compression posture for the current observation window" />
      </div>
      <PageTabs items={ITEMS} activeId={activeTab} onSelect={(value) => onTabChange(value as HealthTab)} />
      {error ? <p className="error">{error}</p> : null}
      <EmbeddedPageChromeProvider>
        <div className="stack-lg">
          {orderedSections.map((section) => (
            <Panel
              key={section.id}
              title={section.label}
              subtitle={section.id === "system"
                ? "Process state, host vitals, and gateway posture stay operator-readable here."
                : "Usage coverage, QMD impact, and backup truth stay attached to runtime health."}
              tone={section.id === activeTab ? "accent" : "default"}
              padding="compact"
            >
              {section.id === "system" ? (
                <div className="stack-lg">
                  {vitals ? <SystemHostVitalsGrid vitals={vitals} /> : <p className="office-subtitle">System vitals unavailable.</p>}
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
                    <StatusChip tone="muted">Tracked {data?.costs.summary.usageAvailability?.trackedEvents ?? 0}</StatusChip>
                    <StatusChip tone={latestBackup ? "success" : "warning"}>
                      {latestBackup ? "Backup ready" : "Backup missing"}
                    </StatusChip>
                  </div>
                  <div className="card">
                    <p><strong>Usage coverage</strong></p>
                    <p className="office-subtitle">
                      Tracked {data?.costs.summary.usageAvailability?.trackedEvents ?? 0}
                      {" · "}
                      Unknown {data?.costs.summary.usageAvailability?.unknownEvents ?? 0}
                      {" · "}
                      Total agent events {data?.costs.summary.usageAvailability?.totalAgentEvents ?? 0}
                    </p>
                  </div>
                  <div className="stack-sm">
                    {(data?.costs.summary.items ?? []).map((item) => (
                      <div key={item.key} className="card">
                        <p><strong>{item.key}</strong></p>
                        <p className="office-subtitle">
                          {item.tokenTotal.toLocaleString()} total tokens
                          {" · "}
                          {formatUsd(item.costUsd)}
                        </p>
                      </div>
                    ))}
                  </div>
                  <Panel
                    title="Backup Summary"
                    subtitle="Health keeps the current backup signal in view while you inspect runtime or spend."
                    tone={latestBackup ? "soft" : "warning"}
                    padding="compact"
                  >
                    {latestBackup ? (
                      <p className="office-subtitle">
                        Latest backup {latestBackup.backupId} was created on {new Date(latestBackup.createdAt).toLocaleString()} and captured {latestBackup.files.length} files.
                      </p>
                    ) : (
                      <p className="office-subtitle">
                        No backup summary is available yet. Create a runtime backup from Runtime once the gateway is healthy.
                      </p>
                    )}
                  </Panel>
                </div>
              )}
            </Panel>
          ))}
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

function describeQmdImpact(
  qmd: Awaited<ReturnType<typeof fetchHealthSummary>>["costs"]["qmd"] | undefined,
): string {
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
