import type { OperatorInboxResponse } from "@goatcitadel/contracts";

/**
 * Backup verification as the Gateway actually proved it. The health summary only lists
 * manifests; exact-byte and restore-contract verification comes from the Inbox projection,
 * which runs `inspectLatestBackupTrust` behind a five-minute cache.
 */
export type BackupTrustState = "verified" | "stale" | "failed" | "none" | "unknown";

export function backupTrustFromInbox(projection: OperatorInboxResponse | undefined): BackupTrustState | undefined {
  if (!projection) return undefined;
  const coverage = projection.coverage.find((source) => source.source === "backup_trust");
  if (!coverage || coverage.state === "unavailable") return "unknown";
  if (coverage.state === "not_enabled") return "none";
  const item = projection.items.find((entry) => entry.kind === "backup_trust");
  if (!item) return "verified";
  return item.id === "backup_trust:stale" ? "stale" : "failed";
}
