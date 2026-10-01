import type {
  DatabaseHealthSnapshot,
  DurableRunRecord,
  OperatorInboxGroup,
  OperatorInboxItem,
  OperatorInboxResponse,
  OperatorInboxSourceCoverage,
} from "@goatcitadel/contracts";
import type { LatestBackupTrustInspection } from "./backup-retention-service.js";
import type { DaemonStatus } from "./daemon-route-service.js";

const BACKUP_STALE_MS = 24 * 60 * 60 * 1000;
const GROUPS: readonly OperatorInboxGroup[] = ["needs_decision", "proposals", "needs_attention", "updates"];

export function label(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

export function bounded(value: string, limit = 240): string {
  const clean = value.trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/** Durable metadata is not a workspace column. Missing or contradictory scope is omitted. */
export function runWorkspaceId(run: DurableRunRecord): string | null {
  const payload = typeof run.payload.workspaceId === "string" ? run.payload.workspaceId.trim() : null;
  const metadata = typeof run.metadata?.workspaceId === "string" ? run.metadata.workspaceId.trim() : null;
  if (payload && metadata && payload !== metadata) return null;
  return payload || metadata || null;
}

export function runString(run: DurableRunRecord, key: string): string | null {
  const value = run.payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function watcherString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function projectInboxRuntimeHealth(
  workspaceId: string,
  database: DatabaseHealthSnapshot,
  daemon: DaemonStatus,
  observedAt: string,
) {
  const items: OperatorInboxItem[] = [];
  if (!database.reachable || database.issues.length) items.push({
    id: "runtime_health:database", kind: "runtime_health", group: "needs_attention",
    title: "Database health needs review",
    summary: !database.reachable
      ? "The installation-wide database health check could not reach the configured store."
      : `${database.issues.length} installation-wide database ${database.issues.length === 1 ? "issue needs" : "issues need"} review.`,
    createdAt: observedAt, source: { workspaceId }, href: "/system/health",
  });
  const diagnostics = daemon.diagnostics.filter((item) => item.severity === "warn" || item.severity === "critical");
  if (!daemon.running || diagnostics.length) items.push({
    id: "runtime_health:daemon", kind: "runtime_health", group: "needs_attention",
    title: "Runtime diagnostics need review",
    summary: !daemon.running
      ? "The installation-wide runtime service reports stopped."
      : `${diagnostics.length} installation-wide runtime ${diagnostics.length === 1 ? "diagnostic needs" : "diagnostics need"} review.`,
    createdAt: observedAt, source: { workspaceId }, href: "/system/health",
  });
  return { items, partial: true,
    detail: "Database and Gateway runtime diagnostics were checked. Model, channel, integration, desktop, and remote-worker checks remain in System." };
}

export function projectInboxBackupTrust(
  workspaceId: string,
  inspection: LatestBackupTrustInspection | undefined,
  cached: boolean,
  now: number,
) {
  const observedAt = inspection?.observedAt ?? new Date(now).toISOString();
  const age = inspection?.createdAt ? Date.parse(inspection.createdAt) : NaN;
  const stale = !Number.isFinite(age) || now - age > BACKUP_STALE_MS;
  const verified = inspection?.verified === true && inspection.contractVerified === true;
  const summary = !inspection ? "No published backup is available for installation-wide verification."
    : !verified ? "The latest installation-wide backup failed exact-byte or restore-contract verification."
      : stale ? "The latest verified installation-wide backup is older than 24 hours or has no valid creation time."
        : null;
  return { items: summary ? [{
    id: "backup_trust:latest", kind: "backup_trust", group: "needs_attention",
    title: !inspection ? "No backup proof" : !verified ? "Backup verification needs review" : "Backup proof is stale",
    summary, createdAt: observedAt, source: { workspaceId }, href: "/system/health",
  } satisfies OperatorInboxItem] : [], partial: cached,
  detail: cached ? "Backup verification is cached for up to five minutes to avoid copying the backup on every Inbox poll." : undefined };
}

export function buildInboxProjection(
  workspaceId: string,
  items: OperatorInboxItem[],
  coverage: OperatorInboxSourceCoverage[],
  generatedAt: string,
): OperatorInboxResponse {
  const order = new Map(GROUPS.map((group, index) => [group, index]));
  const sortedItems = [...items].sort((a, b) => (order.get(a.group) ?? 9) - (order.get(b.group) ?? 9)
    || (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)
    || a.id.localeCompare(b.id));
  const affectedGroups: Record<string, readonly OperatorInboxGroup[]> = {
    approvals: ["needs_decision"], change_plans: ["needs_decision", "needs_attention"], memory_proposals: ["proposals"],
    document_proposals: ["proposals"], capability_proposals: ["proposals"], improvement_proposals: ["proposals"],
    durable_runs: ["needs_attention"], dead_letters: ["needs_attention"], user_input: ["needs_decision"],
    runtime_health: ["needs_attention"], backup_trust: ["needs_attention"], spend_coverage: ["needs_attention"],
    background_updates: ["updates"], completed_background_runs: ["updates"],
  };
  const counts = Object.fromEntries(GROUPS.map((group) => [group, {
    known: items.filter((item) => item.group === group).length,
    complete: coverage.every((source) => source.state === "current" || !affectedGroups[source.source]?.includes(group)),
  }])) as OperatorInboxResponse["counts"];
  return { authority: "derived_projection", workspaceId, generatedAt, items: sortedItems, coverage, counts };
}
