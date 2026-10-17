import type { HealthSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";
import type { StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { BackupTrustState } from "./backup-trust";

/** Full runtime controls and backup records use the existing native runtime owner inside Cockpit. */
export const RUNTIME_INSPECT_PATH = "/system/runtime";
export const BACKUP_INSPECT_PATH = "/system/runtime#ops-runtime-backups";

export interface HealthCheck {
  id:
    | "gateway"
    | "database"
    | "service"
    | "backups"
    | "models"
    | "channels"
    | "integrations"
    | "updates"
    | "remote_workers";
  title: string;
  detail: string;
  status: { label: string; tone: StatusTone };
  inspectPath: string;
  /** The earlier result, shown on its own line after the current state when a source could not refresh. */
  lastKnown?: string;
  /** Something the operator has not set up. It is shown, but never counted as missing proof. */
  notSetUp?: boolean;
}

export function backupHealthCheck(trust: BackupTrustState | undefined, hasRecord: boolean): HealthCheck {
  const base = { id: "backups", title: "Backups", inspectPath: BACKUP_INSPECT_PATH } as const;
  // Manifest existence and exact-record verification are independent observations.
  if (hasRecord && trust === "none") trust = "unknown";
  switch (trust) {
    case "verified":
      return {
        ...base,
        status: { label: "Verified", tone: "done" },
        detail:
          "The latest backup passed exact-byte and restore-contract verification. A full restore is not proven here.",
      };
    case "stale":
      return {
        ...base,
        status: { label: "Stale", tone: "waiting" },
        detail: "The latest verified backup is more than a day old or has no valid creation time.",
      };
    case "failed":
      return {
        ...base,
        status: { label: "Verification failed", tone: "failed" },
        detail: "The latest backup failed exact-byte or restore-contract verification.",
      };
    case "none":
      return {
        ...base,
        notSetUp: true,
        status: { label: "No backup yet", tone: "neutral" },
        detail:
          "No backup has been published yet. Back up now creates a host-wide snapshot through the Gateway. Scheduling and offline restore remain separate operator workflows.",
      };
    default:
      return hasRecord
        ? {
            ...base,
            status: { label: "Not verified yet", tone: "neutral" },
            detail: "A backup record exists, but its verification has not been read yet.",
          }
        : {
            ...base,
            notSetUp: true,
            status: { label: "No backup yet", tone: "neutral" },
            detail: "No backup record was returned by the health summary.",
          };
  }
}

/** One runtime-service derivation, shared by Health and the saved-board Runtime widget so they never disagree. */
export function describeRuntimeService(daemon: HealthSummaryResponse["daemonStatus"] | undefined): {
  label: string;
  tone: StatusTone;
  detail: string;
} {
  if (!daemon) return { label: "Unknown", tone: "neutral", detail: "The health summary did not report the service." };
  const issues = daemon.diagnostics?.filter((item) => item.severity === "critical" || item.severity === "warn") ?? [];
  if (!daemon.supported)
    return { label: "Unavailable", tone: "neutral", detail: "Service control is unavailable on this host." };
  if (!daemon.running) return { label: "Problem", tone: "failed", detail: "The managed runtime service is stopped." };
  if (issues.length) {
    const critical = issues.some((item) => item.severity === "critical");
    return {
      label: critical ? "Problem" : "Needs review",
      tone: critical ? "failed" : "waiting",
      detail: `${issues.length} runtime ${issues.length === 1 ? "diagnostic needs" : "diagnostics need"} review.`,
    };
  }
  return {
    label: "Running",
    tone: "done",
    detail: "The managed runtime service is running with no reported warnings.",
  };
}

export function deriveHealthChecks(health: HealthSummaryResponse, backupTrust?: BackupTrustState): HealthCheck[] {
  const database = health.database;
  const service = describeRuntimeService(health.daemonStatus);

  return [
    {
      id: "gateway",
      title: "Gateway",
      detail: "The health summary is responding.",
      status: { label: "Responding", tone: "done" },
      inspectPath: RUNTIME_INSPECT_PATH,
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
      inspectPath: RUNTIME_INSPECT_PATH,
    },
    {
      id: "service",
      title: "Runtime service",
      detail: service.detail,
      status: { label: service.label, tone: service.tone },
      inspectPath: RUNTIME_INSPECT_PATH,
    },
    backupHealthCheck(backupTrust, Boolean(health.backups.latest)),
  ];
}

export function summarizeHealthChecks(checks: readonly HealthCheck[]): { label: string; tone: StatusTone } {
  const problems = checks.filter((check) => check.status.tone === "failed" || check.status.tone === "waiting");
  if (problems.length)
    return {
      label: `${problems.length} ${problems.length === 1 ? "system check needs" : "system checks need"} review`,
      tone: problems.some((check) => check.status.tone === "failed") ? "failed" : "waiting",
    };
  if (!checks.length || checks.some((check) => check.status.tone === "neutral" && !check.notSetUp)) {
    return { label: "Some system checks could not be confirmed", tone: "neutral" };
  }
  return { label: "Reported system checks clear", tone: "done" };
}

/** Unknown evidence remains distinct from actionable owner-reported problems. */
export function healthOverviewState(checks: readonly HealthCheck[]) {
  const problems = checks.filter((check) => check.status.tone === "failed" || check.status.tone === "waiting");
  const unknown = checks.filter((check) => check.status.tone === "neutral" && !check.notSetUp);
  const kind = problems.length ? "problems" : unknown.length || !checks.length ? "incomplete" : "clear";
  const lead = problems.length
    ? `${problems.length} ${problems.length === 1 ? "check needs" : "checks need"} attention`
    : checks.length
      ? "All reachable checks report no problems"
      : "No checks have reported yet";
  return {
    kind,
    problems,
    unknown,
    /** One status line for the page: the problems or the all-clear, then how many checks could not be confirmed. */
    heading: unknown.length ? `${lead} · ${unknown.length} unverified` : lead,
  };
}
