import type { OperatorInboxResponse } from "@goatcitadel/contracts";

/**
 * Backup verification as the Gateway actually proved it. The health summary only lists
 * manifests; exact-byte and restore-contract verification comes from the Inbox projection,
 * which runs `inspectLatestBackupTrust` behind a five-minute cache.
 */
export type BackupTrustState = "verified" | "stale" | "failed" | "none" | "unknown";

export function backupTrustFromInbox(
  projection: OperatorInboxResponse | undefined,
  latest?: { backupId: string; createdAt: string } | null,
): BackupTrustState | undefined {
  if (!projection) return undefined;
  const coverage = projection.coverage.find((source) => source.source === "backup_trust");
  if (!coverage || coverage.state === "unavailable" || coverage.state === "partial") return "unknown";
  if (coverage.state === "not_enabled") return latest === null ? "none" : "unknown";
  const observation = coverage.backupTrust;
  if (!latest || !observation?.backupId || !observation.createdAt ||
    observation.backupId !== latest.backupId || observation.createdAt !== latest.createdAt) return "unknown";
  return observation.state === "none" ? "unknown" : observation.state;
}
