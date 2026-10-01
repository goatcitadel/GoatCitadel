import { sourceFailed } from "./runtime-overview-model";
import { ReleaseProofDashboardPanel, ReviewReadinessPanel } from "./RuntimeReleaseProofPanels";
import { formatAvailabilityCount } from "./runtime-spend-model";
import { formatDateTime, formatLoadAverage, formatOptionalBytes, formatOptionalDuration } from "./runtime-formatters";
import { DetailInspector } from "../../../components/DetailInspector";
import type { ReviewReadinessSummary } from "@goatcitadel/contracts";
import { NativeButton, NativeMetricGrid as MetricGrid, NoticeBanner } from "../primitives";
import { NativeCard, NativeDisclosureCard, NativeGrid, NativeList, QuickJumpCard } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import type { OpsRuntimeData } from "./runtime-overview-model";
import type { RuntimePanelSetter } from "./runtime-panel-types";

export function RuntimeDiagnosticsPanel({
  setSupportPanel,
  handleExportDiagnostics,
  data,
  diagnosticsNotice,
  diagnosticQuery,
  setDiagnosticQuery,
  supportPanel,
  reviewReadiness,
  reviewReadinessLoading,
  reviewReadinessError,
  refreshReleaseProof,
  loadReviewReadiness,
  navigate,
  route,
}: {
  setSupportPanel: RuntimePanelSetter<string | null>;
  handleExportDiagnostics: () => void;
  data: OpsRuntimeData;
  diagnosticsNotice: string | null;
  diagnosticQuery: string;
  setDiagnosticQuery: RuntimePanelSetter<string>;
  supportPanel: string | null;
  reviewReadiness: ReviewReadinessSummary | null;
  reviewReadinessLoading: boolean;
  reviewReadinessError: string | null;
  refreshReleaseProof: () => Promise<void>;
  loadReviewReadiness: (forceRuntimeReleaseRefresh?: boolean) => Promise<void>;
  navigate: NativeRoutePagesProps["navigate"];
  route: NativeRoutePagesProps["route"];
}) {
  const healthSourceUnavailable = sourceFailed(data, "health");
  const systemHostname = healthSourceUnavailable ? "unavailable" : (data.health?.systemVitals?.hostname ?? "Unknown");
  const systemPlatform = healthSourceUnavailable
    ? "platform unavailable"
    : (data.health?.systemVitals?.platform ?? "Unknown platform");
  const systemUptime = healthSourceUnavailable
    ? "unavailable"
    : formatOptionalDuration(data.health?.systemVitals?.uptimeSeconds);
  const systemRelease = healthSourceUnavailable
    ? "release unavailable"
    : (data.health?.systemVitals?.release ?? "Unknown release");
  const heapUsed = healthSourceUnavailable
    ? "unavailable"
    : formatOptionalBytes(data.health?.systemVitals?.processHeapUsedBytes);
  const memoryFree = healthSourceUnavailable
    ? "Free unavailable"
    : `Free ${formatOptionalBytes(data.health?.systemVitals?.memoryFreeBytes)}`;

  return (
    <NativeGrid className="mc-next-ops-diagnostics-grid">
      <div className="mc-next-runtime-actions">
        <NativeButton variant="outline" onClick={() => setSupportPanel("release")}>
          Release proof
        </NativeButton>
        <NativeButton variant="outline" onClick={() => setSupportPanel("readiness")}>
          Review readiness
        </NativeButton>
      </div>
      <NativeCard
        className="mc-next-ops-diagnostics-primary"
        title="Diagnostics directory"
        subtitle="System vitals, daemon logs, and MCP runtime posture in one diagnostics view."
        actions={
          <NativeButton variant="outline" onClick={handleExportDiagnostics}>
            Export diagnostics
          </NativeButton>
        }
        stats={[
          { label: "CPU", value: formatAvailabilityCount(data.health?.systemVitals?.cpuCount) },
          { label: "Load", value: formatLoadAverage(data.health?.systemVitals?.loadAverage ?? []) },
        ]}
      >
        {diagnosticsNotice ? <NoticeBanner tone="success" message={diagnosticsNotice} /> : null}
        <MetricGrid
          items={[
            {
              label: "Hostname",
              value: systemHostname,
              meta: systemPlatform,
            },
            {
              label: "System uptime",
              value: systemUptime,
              meta: systemRelease,
            },
            {
              label: "Heap used",
              value: heapUsed,
              meta: memoryFree,
            },
          ]}
        />
        <label className="mc-next-settings-field">
          Search diagnostics
          <input type="search" value={diagnosticQuery} onChange={(event) => setDiagnosticQuery(event.target.value)} />
        </label>
        <NativeList
          virtualized
          items={(data.health?.daemonLogs?.items ?? [])
            .filter((item) =>
              `${item.level} ${item.message} ${item.timestamp}`.toLowerCase().includes(diagnosticQuery.toLowerCase()),
            )
            .map((item) => ({
              title: item.level.toUpperCase(),
              meta: formatDateTime(item.timestamp),
              body: item.message,
            }))}
          emptyLabel="No daemon logs available."
        />
        <div className="mc-next-runtime-diagnostic-details" aria-label="Runtime source diagnostics">
          {Object.entries(data.sourceStatus)
            .filter(([source, status]) =>
              `${source} ${status.status} ${"message" in status ? status.message : ""}`
                .toLowerCase()
                .includes(diagnosticQuery.toLowerCase()),
            )
            .map(([source, status]) => (
              <details key={source}>
                <summary role="button" aria-label={`Inspect diagnostic ${source}`}>
                  {source}
                </summary>
                <p>
                  <strong>Diagnostic detail:</strong>{" "}
                  {status.status === "ok" ? "Source loaded successfully." : status.message}
                </p>
              </details>
            ))}
        </div>
      </NativeCard>
      <DetailInspector open={supportPanel === "release"} title="Release proof" onClose={() => setSupportPanel(null)}>
        <ReleaseProofDashboardPanel
          summary={reviewReadiness}
          loading={reviewReadinessLoading}
          error={reviewReadinessError}
          onRefresh={refreshReleaseProof}
        />
      </DetailInspector>
      <DetailInspector
        open={supportPanel === "readiness"}
        title="Review readiness"
        onClose={() => setSupportPanel(null)}
      >
        <ReviewReadinessPanel
          summary={reviewReadiness}
          loading={reviewReadinessLoading}
          error={reviewReadinessError}
          onRefresh={loadReviewReadiness}
        />
      </DetailInspector>
      <NativeDisclosureCard
        id="diagnostics-recovery"
        title="Backup and recovery"
        subtitle="Backup posture is visible in Ops; restore remains an offline, operator-run procedure."
      >
        <NoticeBanner
          tone="info"
          message="Offline restore is intentionally not launched from the browser. Verify a backup, stop the runtime, and follow the operator-run recovery procedure."
        />
        <NativeButton
          variant="outline"
          onClick={() => navigate({ area: "ops", section: "runtime", theme: route.theme })}
        >
          Open backup posture
        </NativeButton>
      </NativeDisclosureCard>
      <QuickJumpCard
        title="Diagnostics routes"
        subtitle="Jump between diagnostics and related operator routes."
        actions={[
          { label: "Runtime", route: { area: "ops", section: "runtime", theme: route.theme } },
          { label: "Prompt packs", route: { area: "library", section: "prompt-packs", theme: route.theme } },
          { label: "Approvals", route: { area: "ops", section: "approvals", theme: route.theme } },
        ]}
        navigate={navigate}
      />
    </NativeGrid>
  );
}
