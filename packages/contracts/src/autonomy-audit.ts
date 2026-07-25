/**
 * Unified autonomy audit (cross-cutting kill-switch & rollback).
 *
 * GoatCitadel runs "full autonomy WITH rollback": every autonomous mutation
 * (skill self-authoring/promotion, operator-profile/memory writes, curator idle
 * archive, auto-applied tunes) already writes a per-subsystem snapshot with its
 * own restore path. This audit ties them into ONE operator-facing ledger so an
 * operator can ask "revert all autonomous changes since T" without each
 * subsystem needing to know about the others.
 *
 * Each entry records *how* to revert (`restoreRef`) — never a duplicate snapshot.
 * Two restoreRef strategies exist (mirrored from how each subsystem restores):
 *   - value-carrying (`skill_revision`, `operator_profile`/`memory`): the prior
 *     state is embedded in `restoreRef` because storage retains only the current
 *     revision, so the bytes must travel with the audit entry.
 *   - reference-by-id (`curator_archive`, `tune`): the prior state self-persists
 *     in `system_settings` / the tune row, so the entry stores only the key/id.
 *
 * Append is best-effort: an audit write failing must never break the mutation
 * it describes (the per-subsystem restore still works independently).
 */

/** The autonomous subsystem a single audit entry came from. */
export type AutonomyAuditKind = "skill_revision" | "operator_profile" | "curator_archive" | "tune" | "memory";

/** All audit kinds, for iteration / validation. */
export const AUTONOMY_AUDIT_KINDS: readonly AutonomyAuditKind[] = [
  "skill_revision",
  "operator_profile",
  "curator_archive",
  "tune",
  "memory",
] as const;

/**
 * How to revert one audit entry. The shape is a discriminated union keyed on
 * `kind` so {@link AutonomyControlService} can dispatch to the subsystem's
 * existing restore function. `payload` carries exactly what that restore call
 * needs and nothing more.
 */
export type AutonomyAuditRestoreRef =
  | { kind: "skill_revision"; snapshotRef: unknown }
  | { kind: "operator_profile"; priorSnapshot: unknown }
  | { kind: "memory"; priorSnapshot: unknown }
  | { kind: "curator_archive"; skillId: string }
  | { kind: "tune"; tuneId: string };

/** A single recorded autonomous mutation. */
export interface AutonomyAuditEntry {
  auditId: string;
  kind: AutonomyAuditKind;
  /** A human-meaningful pointer to the mutated target (skillId, profileId, settingKey, …). */
  targetKey: string;
  /** ISO-8601 timestamp the mutation occurred. */
  occurredAt: string;
  /** How to revert this mutation; opaque to the ledger, consumed by the control service. */
  restoreRef: AutonomyAuditRestoreRef;
  /** True once the entry has been reverted (idempotency for "revert since T"). */
  reverted: boolean;
  /** ISO-8601 timestamp of the revert, when `reverted` is true. */
  revertedAt?: string;
}

/** Fields needed to append an audit entry (id/occurredAt/reverted are managed). */
export interface AutonomyAuditAppendInput {
  kind: AutonomyAuditKind;
  targetKey: string;
  restoreRef: AutonomyAuditRestoreRef;
  /** Optional explicit timestamp; defaults to now. */
  occurredAt?: string;
}

/** Per-kind tally for the status summary. */
export interface AutonomyAuditKindSummary {
  kind: AutonomyAuditKind;
  total: number;
  reverted: number;
}

/** Compact recent-activity summary surfaced by {@link AutonomyControlService.getStatus}. */
export interface AutonomyAuditSummary {
  totalEntries: number;
  unrevertedEntries: number;
  byKind: AutonomyAuditKindSummary[];
  /** Most recent entries (newest first), capped by the caller. */
  recent: AutonomyAuditEntry[];
}

/** Outcome of reverting a single audit entry. */
export interface AutonomyRevertEntryResult {
  auditId: string;
  kind: AutonomyAuditKind;
  targetKey: string;
  status: "reverted" | "skipped" | "failed";
  /** Present when `status === "failed"`; the failure message (per-entry isolation). */
  error?: string;
}

/** Summary returned by {@link AutonomyControlService.revertAutonomousChangesSince}. */
export interface AutonomyRevertSummary {
  /** The `since` cutoff (ISO-8601) that was applied. */
  since: string;
  /** Number of un-reverted entries considered (occurredAt >= since). */
  considered: number;
  reverted: number;
  skipped: number;
  failed: number;
  results: AutonomyRevertEntryResult[];
}

/** Master kill-switch + recent-audit view returned by {@link AutonomyControlService.getStatus}. */
export interface AutonomyControlStatus {
  /** Current settings generation revision required by kill-switch mutations. */
  revision: number;
  /** True when the master kill switch (`autonomyV1Disabled`) is engaged. */
  killSwitchEngaged: boolean;
  /** Convenience inverse of {@link killSwitchEngaged}. */
  autonomyEnabled: boolean;
  audit: AutonomyAuditSummary;
}
