import type { HealthSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";
import type { StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { BackupTrustState } from "./backup-trust";

export interface HealthCheck {
  id: "gateway" | "database" | "service" | "backups" | "models" | "channels" | "integrations" | "updates" | "remote_workers";
  title: string;
  detail: string;
  status: { label: string; tone: StatusTone };
  inspectPath: string;
  /** Something the operator has not set up. It is shown, but never counted as missing proof. */
  notSetUp?: boolean;
}

export function backupHealthCheck(trust: BackupTrustState | undefined, hasRecord: boolean): HealthCheck {
  const base = { id: "backups", title: "Backups", inspectPath: "/ops/runtime" } as const;
  switch (trust) {
    case "verified":
      return { ...base, status: { label: "Verified", tone: "done" },
        detail: "The latest backup passed exact-byte and restore-contract verification. A full restore is not proven here." };
    case "stale":
      return { ...base, status: { label: "Stale", tone: "waiting" },
        detail: "The latest verified backup is more than a day old or has no valid creation time." };
    case "failed":
      return { ...base, status: { label: "Verification failed", tone: "failed" },
        detail: "The latest backup failed exact-byte or restore-contract verification." };
    case "none":
      return { ...base, notSetUp: true, status: { label: "No backup yet", tone: "neutral" },
        detail: "No backup has been published yet. Create one from the classic runtime view." };
    default:
      return hasRecord
        ? { ...base, status: { label: "Not verified yet", tone: "neutral" },
            detail: "A backup record exists, but its verification has not been read yet." }
        : { ...base, notSetUp: true, status: { label: "No backup yet", tone: "neutral" },
            detail: "No backup record was returned by the health summary." };
  }
}

export function deriveHealthChecks(health: HealthSummaryResponse, backupTrust?: BackupTrustState): HealthCheck[] {
  const database = health.database;
  const daemon = health.daemonStatus;
  const diagnosticIssues = daemon.diagnostics?.filter((item) => item.severity === "critical" || item.severity === "warn") ?? [];
  const hasCriticalDiagnostic = diagnosticIssues.some((item) => item.severity === "critical");

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
    backupHealthCheck(backupTrust, Boolean(health.backups.latest)),
  ];
}

export function summarizeHealthChecks(checks: readonly HealthCheck[]): { label: string; tone: StatusTone } {
  const problems = checks.filter((check) => check.status.tone === "failed" || check.status.tone === "waiting");
  if (problems.length) return {
    label: `${problems.length} ${problems.length === 1 ? "system check needs" : "system checks need"} review`,
    tone: problems.some((check) => check.status.tone === "failed") ? "failed" : "waiting",
  };
  if (!checks.length || checks.some((check) => check.status.tone === "neutral" && !check.notSetUp)) {
    return { label: "Some system checks lack live proof", tone: "neutral" };
  }
  return { label: "Reported system checks clear", tone: "done" };
}
