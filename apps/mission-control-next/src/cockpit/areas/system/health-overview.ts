import type { HealthSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";
import type { StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

export interface HealthCheck {
  id: "gateway" | "database" | "service" | "backups" | "models" | "channels" | "integrations" | "updates" | "remote_workers";
  title: string;
  detail: string;
  status: { label: string; tone: StatusTone };
  inspectPath: string;
}

export function deriveHealthChecks(health: HealthSummaryResponse): HealthCheck[] {
  const database = health.database;
  const daemon = health.daemonStatus;
  const diagnosticIssues = daemon.diagnostics?.filter((item) => item.severity === "critical" || item.severity === "warn") ?? [];
  const hasCriticalDiagnostic = diagnosticIssues.some((item) => item.severity === "critical");
  const backupVerified = health.backups.latest?.verified === true && health.backups.latest?.contractVerified === true;

  return [
    {
      id: "gateway",
      title: "Gateway",
      detail: "The health summary is responding.",
      status: { label: "Responding", tone: "done" },
      inspectPath: "/ops/runtime",
    },
    {
      id: "database",
      title: "Database",
      detail: !database
        ? "This health summary did not include a database check."
        : !database.reachable
          ? "The database health check could not reach the configured store."
          : database.issues.length
            ? `${database.issues.length} database ${database.issues.length === 1 ? "issue needs" : "issues need"} review.`
            : "The configured store is reachable with no reported issues.",
      status: !database
        ? { label: "Unknown", tone: "neutral" }
        : !database.reachable
          ? { label: "Unreachable", tone: "failed" }
          : database.issues.length
            ? { label: "Needs review", tone: "waiting" }
            : { label: "Reachable", tone: "done" },
      inspectPath: "/ops/runtime",
    },
    {
      id: "service",
      title: "Runtime service",
      detail: !daemon.supported
        ? "Service control is unavailable on this host."
        : !daemon.running
          ? "The managed runtime service is stopped."
          : diagnosticIssues.length
            ? `${diagnosticIssues.length} runtime ${diagnosticIssues.length === 1 ? "diagnostic needs" : "diagnostics need"} review.`
            : "The managed runtime service is running with no reported warnings.",
      status: !daemon.supported
        ? { label: "Unavailable", tone: "neutral" }
        : !daemon.running || hasCriticalDiagnostic
          ? { label: "Problem", tone: "failed" }
          : diagnosticIssues.length
            ? { label: "Needs review", tone: "waiting" }
            : { label: "Running", tone: "done" },
      inspectPath: "/ops/runtime",
    },
    {
      id: "backups",
      title: "Backups",
      detail: backupVerified
        ? "Backup verification and restore-contract evidence are recorded. A full restore is not proven here."
        : health.backups.latest
        ? "A backup record exists, but verification and restore-contract evidence are incomplete."
        : "No backup record was returned by the health summary.",
      status: backupVerified ? { label: "Verified record", tone: "done" } : { label: "Needs verification", tone: "waiting" },
      inspectPath: "/ops/runtime",
    },
  ];
}

export function summarizeHealthChecks(checks: readonly HealthCheck[]): { label: string; tone: StatusTone } {
  const problems = checks.filter((check) => check.status.tone === "failed" || check.status.tone === "waiting");
  if (problems.length) return {
    label: `${problems.length} ${problems.length === 1 ? "system check needs" : "system checks need"} review`,
    tone: problems.some((check) => check.status.tone === "failed") ? "failed" : "waiting",
  };
  if (!checks.length || checks.some((check) => check.status.tone === "neutral")) {
    return { label: "Some system checks lack live proof", tone: "neutral" };
  }
  return { label: "Reported system checks clear", tone: "done" };
}
