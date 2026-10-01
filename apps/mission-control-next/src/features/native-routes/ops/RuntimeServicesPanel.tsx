import {
  DaemonControlHandoffPanel,
  DaemonRecoveryPanel,
  readDaemonControlHandoff,
  readDaemonRepairActions,
  readDaemonRuntimeDiagnostics,
} from "./RuntimeDaemonPanels";
import { LlamaCppRuntimeTruthCard } from "./LlamaCppRuntimeTruthCard";
import { sourceFailed } from "./runtime-overview-model";
import {
  capitalize,
  formatDateTime,
  formatMilliseconds,
  formatOptionalBytes,
  formatOptionalDuration,
} from "./runtime-formatters";
import { DetailInspector } from "../../../components/DetailInspector";
import { RefreshCw } from "lucide-react";
import { EmptyState, NativeButton, NativeMetricGrid as MetricGrid, NoticeBanner, StatusChip } from "../primitives";
import { useOpsRuntimeSnapshot } from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import { NativeCard, NativeDisclosureCard, NativeGrid, NativeList } from "../NativeRoutePageLayout";
import { RuntimeAuthorityPanel } from "./RuntimeAuthorityPanel";
import { MeshCapabilityPanel } from "./MeshCapabilityPanel";
import { SessionControlPanel } from "./SessionControlPanel";
import type { NativeRoutePagesProps } from "../types";
import type { OpsRuntimeData } from "./runtime-overview-model";
import type { RuntimePanelSetter, RuntimeTab } from "./runtime-panel-types";
import { RuntimeEfficiencyPanels } from "./RuntimeEfficiencyPanels";

export function RuntimeServicesPanel({
  runtimeTab,
  setRuntimeTab,
  setSupportPanel,
  data,
  route,
  supportPanel,
  activeWorkspaceId,
  navigate,
  pendingApprovals,
  runtime,
}: {
  runtimeTab: RuntimeTab;
  setRuntimeTab: RuntimePanelSetter<RuntimeTab>;
  setSupportPanel: RuntimePanelSetter<string | null>;
  data: OpsRuntimeData;
  route: NativeRoutePagesProps["route"];
  supportPanel: string | null;
  activeWorkspaceId: string;
  navigate: NativeRoutePagesProps["navigate"];
  pendingApprovals: number;
  runtime: Pick<ReturnType<typeof useOpsRuntimeSnapshot>, "notice" | "daemonBusy" | "runDaemonAction" | "reload">;
}) {
  const daemonSourceUnavailable = sourceFailed(data, "daemon");
  const healthSourceUnavailable = sourceFailed(data, "health");
  const daemonRuntimeUnavailable = daemonSourceUnavailable && healthSourceUnavailable;
  // `daemonStatus`/`systemVitals`/`costs`/`daemonLogs` (health) and
  // `scheduler`/`improvement`/`events` (timeline) are required by their
  // response contracts, but a partial gateway response (e.g. a stub
  // returning {}) can omit them at runtime — and sourceFailed() only trips
  // on fetch errors, not a 200 with an empty body. Chain through every hop
  // and fall back to inert defaults, here and in the helpers below.
  const daemonControllable = data.daemon?.controllable ?? data.health?.daemonStatus?.controllable ?? false;
  const daemonHandoff = readDaemonControlHandoff(data);
  const daemonRunning = daemonRuntimeUnavailable
    ? null
    : (data.daemon?.running ?? data.health?.daemonStatus?.running ?? null);
  const daemonHost = daemonRuntimeUnavailable
    ? "unavailable"
    : (data.daemon?.host ?? data.health?.daemonStatus?.host ?? "Unknown");
  const daemonState = daemonRuntimeUnavailable
    ? "unavailable"
    : (data.daemon?.state ?? data.health?.daemonStatus?.state ?? "unknown");
  const daemonPid = daemonRuntimeUnavailable
    ? "unavailable"
    : String(data.daemon?.pid ?? data.health?.daemonStatus?.pid ?? "unavailable");
  const daemonUptime = daemonRuntimeUnavailable
    ? "unavailable"
    : formatOptionalDuration(data.daemon?.uptimeSeconds ?? data.health?.daemonStatus?.uptimeSeconds);
  const daemonDiagnostics = readDaemonRuntimeDiagnostics(data);
  const daemonRepairActions = readDaemonRepairActions(data);
  const latestBackup = data.health?.backups?.latest;
  const latestBackupVerified = latestBackup?.verified === true && latestBackup?.contractVerified === true;
  const storageWait = data.health?.database?.storageWait;
  const memoryUsed = healthSourceUnavailable
    ? "unavailable"
    : formatOptionalBytes(data.health?.systemVitals?.memoryUsedBytes);
  const processRss = healthSourceUnavailable
    ? "process unavailable"
    : `process ${formatOptionalBytes(data.health?.systemVitals?.processRssBytes)}`;

  return (
    <NativeGrid>
      <div className="mc-next-runtime-tabs" role="group" aria-label="Runtime views">
        {(["services", "efficiency", "backups"] as const).map((tab) => (
          <NativeButton
            key={tab}
            variant={runtimeTab === tab ? "default" : "outline"}
            aria-pressed={runtimeTab === tab}
            onClick={() => {
              setRuntimeTab(tab);
              setSupportPanel(null);
            }}
          >
            {capitalize(tab)}
          </NativeButton>
        ))}
      </div>
      {runtimeTab === "services" ? (
        <NativeCard title="Services" subtitle="Current service state and the controls that own it.">
          <NativeList
            items={[
              {
                title: "Gateway",
                meta: daemonState,
                body:
                  daemonDiagnostics[0]?.title ??
                  (daemonRunning === null ? "Status unavailable" : daemonRunning ? "Running" : "Stopped"),
                actions: (
                  <NativeButton variant="outline" onClick={() => setSupportPanel("daemon")}>
                    Gateway details
                  </NativeButton>
                ),
              },
              {
                title: "Local model runtime",
                meta: data.llamaCpp?.processState ?? "Unavailable",
                body: data.llamaCpp?.lastError ?? "llama.cpp readiness and recorded health",
                actions: (
                  <NativeButton variant="outline" onClick={() => setSupportPanel("llama")}>
                    Local runtime details
                  </NativeButton>
                ),
              },
              {
                title: "Backups",
                meta: !data.health?.backups
                  ? "Unavailable"
                  : latestBackupVerified
                    ? "Verified"
                    : latestBackup
                      ? "Present"
                      : "No backup",
                body: "Recovery evidence and stored backup records",
                actions: (
                  <NativeButton variant="outline" onClick={() => setRuntimeTab("backups")}>
                    Backup details
                  </NativeButton>
                ),
              },
              {
                title: "Runtime authority",
                body: "Canonical state, freshness, and uncertain evidence",
                actions: (
                  <NativeButton variant="outline" onClick={() => setSupportPanel("authority")}>
                    Authority details
                  </NativeButton>
                ),
              },
              {
                title: "Mesh capabilities",
                body: "Publication, activation approvals, and retained invocation results",
                actions: (
                  <NativeButton variant="outline" onClick={() => setSupportPanel("mesh")}>
                    Mesh details
                  </NativeButton>
                ),
              },
              {
                title: "Integration runtime",
                body: "Configured MCP servers",
                actions: (
                  <NativeButton variant="outline" onClick={() => setSupportPanel("integrations")}>
                    Integration details
                  </NativeButton>
                ),
              },
            ]}
            emptyLabel="No services returned."
          />
          {route.sessionId ? (
            <NativeButton variant="outline" onClick={() => setSupportPanel("session")}>
              Session control
            </NativeButton>
          ) : null}
        </NativeCard>
      ) : null}
      <DetailInspector
        open={supportPanel === "authority"}
        title="Runtime authority"
        onClose={() => setSupportPanel(null)}
      >
        <RuntimeAuthorityPanel workspaceId={activeWorkspaceId} theme={route.theme} navigate={navigate} />
      </DetailInspector>
      <DetailInspector open={supportPanel === "session"} title="Session control" onClose={() => setSupportPanel(null)}>
        <SessionControlPanel sessionId={route.sessionId} />
      </DetailInspector>
      <DetailInspector open={supportPanel === "mesh"} title="Mesh capabilities" onClose={() => setSupportPanel(null)}>
        <MeshCapabilityPanel workspaceId={activeWorkspaceId} />
      </DetailInspector>
      <DetailInspector open={supportPanel === "daemon"} title="Gateway details" onClose={() => setSupportPanel(null)}>
        <NativeCard
          id="ops-runtime-posture"
          title="Runtime posture"
          subtitle="Daemon state, service-manager controls, and backup truth in one runtime view."
          density="compact"
          className="mc-next-runtime-posture-card"
          stats={[
            { label: "Approvals", value: String(data.dashboard?.pendingApprovals ?? pendingApprovals) },
            {
              label: "MCP",
              value:
                data.sourceStatus.mcpServers.status === "not_requested" ? "Not loaded" : String(data.mcpServers.length),
            },
          ]}
        >
          {runtime.notice ? <NoticeBanner tone={runtime.notice.tone} message={runtime.notice.message} /> : null}
          <div className="mc-next-runtime-chip-row">
            <StatusChip tone={daemonRuntimeUnavailable ? "critical" : daemonRunning ? "success" : "warning"}>
              {daemonRuntimeUnavailable ? "Daemon unavailable" : daemonRunning ? "Daemon running" : "Daemon stopped"}
            </StatusChip>
            <StatusChip
              tone={
                sourceFailed(data, "health")
                  ? "critical"
                  : latestBackupVerified
                    ? "success"
                    : latestBackup
                      ? "muted"
                      : "warning"
              }
            >
              {sourceFailed(data, "health")
                ? "Backup status unavailable"
                : latestBackupVerified
                  ? "Backup verified"
                  : latestBackup
                    ? "Backup present"
                    : "No backup"}
            </StatusChip>
            <StatusChip tone={daemonControllable ? "default" : "muted"}>
              {sourceFailed(data, "daemon")
                ? "Control status unavailable"
                : daemonControllable
                  ? "Controllable"
                  : "Read only"}
            </StatusChip>
          </div>
          <MetricGrid
            items={[
              {
                label: "Host",
                value: daemonHost,
                meta: daemonState,
              },
              {
                label: "PID",
                value: daemonPid,
                meta: daemonRuntimeUnavailable ? "uptime unavailable" : `uptime ${daemonUptime}`,
              },
              {
                label: "Memory used",
                value: memoryUsed,
                meta: processRss,
              },
              ...(storageWait
                ? [
                    {
                      label: "DB wait p95",
                      value: formatMilliseconds(storageWait.p95Ms),
                      meta: `${storageWait.count} waits / 5m`,
                    },
                    {
                      label: "DB wait max",
                      value: formatMilliseconds(storageWait.maxMs),
                      meta: `${storageWait.criticalCount} critical / 5m`,
                    },
                  ]
                : []),
            ]}
          />
          {!daemonControllable && daemonHandoff ? (
            <NativeDisclosureCard
              id="ops-runtime-handoff"
              title="Service-manager handoff"
              subtitle="Operator steps for a runtime that cannot be controlled from this process."
            >
              <DaemonControlHandoffPanel handoff={daemonHandoff} />
            </NativeDisclosureCard>
          ) : !daemonControllable && data.daemon?.controlMessage ? (
            <EmptyState size="compact" title={data.daemon.controlMessage} />
          ) : null}
          {daemonDiagnostics.length > 0 || daemonRepairActions.length > 0 ? (
            <NativeDisclosureCard
              id="ops-runtime-recovery"
              title="Recovery and diagnostics"
              subtitle="Repair actions and retained diagnostic evidence."
            >
              <DaemonRecoveryPanel diagnostics={daemonDiagnostics} repairActions={daemonRepairActions} />
            </NativeDisclosureCard>
          ) : null}
          <div className="mc-next-runtime-actions">
            <NativeButton
              variant="outline"
              onClick={() => void runtime.runDaemonAction("start")}
              disabled={runtime.daemonBusy !== null || !data.daemon?.controllable}
            >
              {runtime.daemonBusy === "start" ? "Starting..." : "Start daemon"}
            </NativeButton>
            <NativeButton
              variant="outline"
              onClick={() => void runtime.runDaemonAction("restart")}
              disabled={runtime.daemonBusy !== null || !data.daemon?.controllable}
            >
              {runtime.daemonBusy === "restart" ? "Restarting..." : "Restart daemon"}
            </NativeButton>
            <NativeButton
              variant="outline"
              className="danger"
              onClick={() => void runtime.runDaemonAction("stop")}
              disabled={runtime.daemonBusy !== null || !data.daemon?.controllable}
            >
              {runtime.daemonBusy === "stop" ? "Stopping..." : "Stop daemon"}
            </NativeButton>
            <NativeButton variant="outline" className="subtle" onClick={() => void runtime.reload()}>
              <RefreshCw size={16} />
              Refresh
            </NativeButton>
          </div>
        </NativeCard>
      </DetailInspector>
      <DetailInspector open={supportPanel === "llama"} title="Local runtime" onClose={() => setSupportPanel(null)}>
        <LlamaCppRuntimeTruthCard status={data.llamaCpp} sourceStatus={data.sourceStatus.llamaCpp} />
      </DetailInspector>
      <RuntimeEfficiencyPanels data={data} runtimeTab={runtimeTab} />
      {runtimeTab === "backups" ? (
        <NativeDisclosureCard
          id="ops-runtime-backups"
          title="Backup posture"
          subtitle="Recovery state should be inspectable without sharing a connector card."
        >
          <NativeList
            items={data.backups.map((backup) => ({
              title: backup.backupId,
              meta: "backup",
              body: `${formatDateTime(backup.createdAt)} · ${backup.files.length} files`,
            }))}
            emptyLabel="No backup posture available."
            density="compact"
            maxHeight="min(34vh, 18rem)"
            ariaLabel="Backup posture"
          />
        </NativeDisclosureCard>
      ) : null}
      <DetailInspector
        open={supportPanel === "integrations"}
        title="Integration runtime"
        onClose={() => setSupportPanel(null)}
      >
        <NativeCard
          id="ops-runtime-integrations"
          title="Integration runtime"
          subtitle="MCP and connector runtime posture stays separate from backups."
        >
          <NativeList
            items={data.mcpServers.map((item) => ({
              title: item.label,
              meta: item.enabled ? "enabled" : "disabled",
              body: `${item.transport} · ${item.category ?? "general"}`,
            }))}
            emptyLabel="No connector posture available."
            density="compact"
            maxHeight="min(34vh, 18rem)"
            ariaLabel="Integration runtime"
          />
        </NativeCard>
      </DetailInspector>
    </NativeGrid>
  );
}
