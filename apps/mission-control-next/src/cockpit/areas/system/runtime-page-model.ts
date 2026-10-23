import type { DaemonRuntimeDiagnostic } from "@goatcitadel/mission-control-shared/api/types";
import {
  formatBytes,
  formatDuration,
  formatMoney,
  formatSeconds,
  plural,
} from "@goatcitadel/mission-control-shared/content/format";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { readDaemonRuntimeDiagnostics } from "../../../features/native-routes/ops/RuntimeDaemonPanels";
import {
  presentRuntimeDaemon,
  sourceFailed,
  type OpsRuntimeData,
} from "../../../features/native-routes/ops/runtime-overview-model";
import type { Metric } from "../../ui/MetricList";
import { DAEMON_SEVERITY_LABELS } from "../settings/settings-vocabulary";

type Presented = StatusPresentation & { detail: string };

/** Plain names for the runtime sources the page reads, for the unavailable-sources disclosure. */
export const RUNTIME_SOURCE_LABELS: Readonly<Record<string, string>> = {
  daemon: "Server process",
  health: "Health summary",
  llamaCpp: "Local model runtime",
  mcpServers: "MCP servers",
  backups: "Backup records",
  runtimeMeasurements: "Model call measurements",
  localEngines: "Local engines",
  evalProofRuns: "Model comparison runs",
};

/** The server's state in the same words as System › Health (shared describeRuntimeService). */
export function runtimeServerStatus(data: OpsRuntimeData): Presented {
  return presentRuntimeDaemon(data);
}

const known = (value: string, missing: boolean) => (missing ? "Unknown" : value);

export function runtimeServerMetrics(data: OpsRuntimeData): Metric[] {
  const serverUnavailable = sourceFailed(data, "daemon") && sourceFailed(data, "health");
  const healthUnavailable = sourceFailed(data, "health");
  const uptime = data.daemon?.uptimeSeconds ?? data.health?.daemonStatus?.uptimeSeconds;
  const vitals = data.health?.systemVitals;
  const storageWait = data.health?.database?.storageWait;
  return [
    {
      term: "Uptime",
      value: known(formatSeconds(uptime), serverUnavailable || !Number.isFinite(uptime)),
    },
    {
      term: "Memory used",
      value: known(formatBytes(vitals?.memoryUsedBytes), healthUnavailable || vitals?.memoryUsedBytes == null),
      hint:
        healthUnavailable || vitals?.processRssBytes == null
          ? undefined
          : `server process ${formatBytes(vitals.processRssBytes)}`,
    },
    ...(storageWait
      ? [
          {
            term: "Database wait p95",
            value: formatDuration(storageWait.p95Ms),
            hint: `${plural(storageWait.count, "wait")} in 5 minutes`,
          },
          {
            term: "Database wait max",
            value: formatDuration(storageWait.maxMs),
            hint: `${plural(storageWait.criticalCount, "long wait")} in 5 minutes`,
          },
        ]
      : []),
  ];
}

const SEVERITY_TONES: Readonly<Record<DaemonRuntimeDiagnostic["severity"], StatusPresentation["tone"]>> = {
  critical: "failed",
  warn: "waiting",
  pass: "done",
  info: "neutral",
};

/** A server check's severity as a status; shared with System › Diagnostics. */
export function daemonSeverityStatus(severity: DaemonRuntimeDiagnostic["severity"]): StatusPresentation {
  return { label: DAEMON_SEVERITY_LABELS[severity] ?? "Unknown", tone: SEVERITY_TONES[severity] ?? "neutral" };
}

export function runtimeDiagnosticRows(
  data: OpsRuntimeData,
): { key: string; title: string; detail: string; severity: StatusPresentation }[] {
  return readDaemonRuntimeDiagnostics(data).map((item, index) => ({
    key: `${index}:${item.id}`,
    title: item.title,
    detail: item.detail,
    severity: daemonSeverityStatus(item.severity),
  }));
}

export function localModelStatus(data: OpsRuntimeData): Presented {
  const status = data.llamaCpp;
  if (sourceFailed(data, "llamaCpp") || !status)
    return { label: "Unknown", tone: "neutral", detail: "The local model runtime did not report its state." };
  if (status.processState !== "running")
    return { label: "Not running", tone: "neutral", detail: "The local model runtime is not running." };
  return status.healthy
    ? { label: "Running", tone: "done", detail: "The local model runtime is running and answering health checks." }
    : {
        label: "Needs review",
        tone: "waiting",
        detail: "The local model runtime is running but its health check is failing.",
      };
}

export function integrationRows(
  data: OpsRuntimeData,
): { key: string; name: string; status: StatusPresentation; kind: string }[] {
  return data.mcpServers.map((item, index) => ({
    key: `${index}:${item.label}`,
    name: item.label,
    status: item.enabled ? { label: "On", tone: "done" } : { label: "Off", tone: "neutral" },
    kind: item.category ? `${item.category} · ${item.transport}` : item.transport,
  }));
}

export type RuntimeSectionId =
  | "runtime-server"
  | "ops-runtime-backups"
  | "runtime-integrations"
  | "ops-runtime-efficiency";

const LEGACY_SECTIONS: Readonly<Record<string, RuntimeSectionId>> = {
  "ops-runtime-posture": "runtime-server",
  "ops-runtime-recovery": "runtime-server",
  "ops-runtime-handoff": "runtime-server",
  "runtime-server": "runtime-server",
  "ops-runtime-backups": "ops-runtime-backups",
  "ops-runtime-integrations": "runtime-integrations",
  "runtime-integrations": "runtime-integrations",
  "ops-runtime-efficiency": "ops-runtime-efficiency",
  "ops-runtime-engine-fit": "ops-runtime-efficiency",
  "ops-runtime-evidence": "ops-runtime-efficiency",
  "ops-runtime-browser-proof": "ops-runtime-efficiency",
};

/** Classic runtime anchors (Health and old bookmarks) mapped to the native section that now holds them. */
export function runtimeSectionForHash(hash: string): RuntimeSectionId | null {
  return LEGACY_SECTIONS[hash.replace(/^#/, "")] ?? null;
}

type Measurement = OpsRuntimeData["runtimeMeasurements"][number];
type LocalEngine = OpsRuntimeData["localEngines"][number];
type ComparisonRun = OpsRuntimeData["evalProofRuns"][number];

/** Response time, output speed and cost from measured model calls; Unknown, never 0, when they could not be read. */
export function modelPerformanceMetrics(data: OpsRuntimeData): Metric[] {
  const unavailable = sourceFailed(data, "runtimeMeasurements");
  const latencies = data.runtimeMeasurements
    .filter((item: Measurement) => item.status === "completed")
    .map((item: Measurement) => item.metrics.latencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const latest = data.runtimeMeasurements.find((item: Measurement) => item.status !== "failed");
  const speed = latest?.metrics.outputTokensPerSecond;
  return [
    {
      term: "Average response time",
      value: known(
        formatDuration(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
        unavailable || !latencies.length,
      ),
      hint: "completed calls",
    },
    {
      term: "Latest output speed",
      value: known(`${Math.round(speed ?? 0)} tokens/s`, unavailable || typeof speed !== "number"),
    },
    { term: "Latest estimated cost", value: unavailable ? "Unknown" : formatMoney(latest?.metrics.estimatedCostUsd) },
  ];
}

export function engineFitStatus(fit: LocalEngine["fit"]): StatusPresentation {
  if (fit === "strong" || fit === "ok") return { label: "Good fit", tone: "done" };
  if (fit === "weak") return { label: "Weak fit", tone: "waiting" };
  return { label: "Not measured", tone: "neutral" };
}

export function comparisonRunStatus(status: ComparisonRun["status"]): StatusPresentation {
  return status === "completed" ? { label: "Done", tone: "done" } : { label: "Done with warnings", tone: "waiting" };
}
