/**
 * Agent commitments — inferred follow-up check-ins (P1-F3).
 *
 * After a successful turn, a cheap hidden classifier infers future check-ins the
 * user never explicitly scheduled ("you have an interview tomorrow" ⇒ a
 * "how did it go?" check-in). Inferred entries are confidence-gated and deduped
 * on `(sessionId, dedupeKey)`, then delivered when due by the maintenance sweep
 * via the shared autonomous channel-delivery convention.
 *
 * These are plain record/value contracts (no zod): they mirror the persisted
 * SQLite/Postgres row shape and the cheap-model output, and are consumed by the
 * storage repo, the classifier service, and the sweep.
 */

/**
 * Coarse category of an inferred follow-up. Kept intentionally small and
 * model-agnostic so the classifier can map a transcript onto a stable surface.
 */
export type AgentCommitmentKind =
  | "follow_up" // generic "how did X go?" check-in
  | "deadline" // a dated obligation the user mentioned
  | "reminder" // a thing the user asked-implicitly to be reminded of
  | "check_in"; // open-ended status check on an ongoing effort

/**
 * Lifecycle status of a commitment record.
 * - `pending`  — inferred + persisted, not yet queued for delivery.
 * - `delivery_pending` — accepted into the autonomous delivery path; final channel send is still async.
 * - `delivery_failed` — autonomous delivery failed or went stale before a channel send was confirmed.
 * - `sent`     — the due check-in was delivered.
 * - `dismissed`— operator/curator suppressed it (never deliver).
 * - `superseded` — a newer commitment (or user action) replaced it.
 */
export type AgentCommitmentStatus =
  | "pending"
  | "delivery_pending"
  | "delivery_failed"
  | "sent"
  | "dismissed"
  | "superseded";

/** Provenance of a commitment row — who/what created it. */
export type AgentCommitmentCreatedBy = "classifier" | "operator" | "system";

/**
 * The structured output of the post-turn commitment classifier (one inferred
 * follow-up). This is the cheap-model contract: it carries only the fields the
 * model is asked to produce. Persistence-only fields (ids, status, timestamps)
 * are added by the repo when an entry is upserted.
 */
export interface CommitmentClassification {
  kind: AgentCommitmentKind;
  /** ISO-8601 timestamp the check-in becomes due. */
  dueAt: string;
  /** Model confidence in [0, 1]; only entries ≥ threshold are persisted. */
  confidence: number;
  /**
   * Stable dedupe key for `(sessionId, dedupeKey)` uniqueness. A second
   * classification with the same key updates the existing row instead of
   * creating a duplicate check-in.
   */
  dedupeKey: string;
  /** Human-facing check-in text delivered when the commitment is due. */
  suggestedText: string;
}

/**
 * A persisted commitment row. Extends the classifier output with identity,
 * scope, lifecycle, and audit fields.
 */
export interface AgentCommitmentRecord {
  commitmentId: string;
  sessionId: string;
  workspaceId: string;
  kind: AgentCommitmentKind;
  /** ISO-8601 timestamp the check-in becomes due. */
  dueAt: string;
  /** Model confidence in [0, 1] at persist time. */
  confidence: number;
  /** Stable key enforcing `UNIQUE(session_id, dedupe_key)`. */
  dedupeKey: string;
  /** Human-facing check-in text. */
  suggestedText: string;
  status: AgentCommitmentStatus;
  createdBy: AgentCommitmentCreatedBy;
  createdAt: string;
  /** Set when the due check-in is confirmed delivered (`status === "sent"`). */
  sentAt?: string;
}

/**
 * Minimum classifier confidence required to persist an inferred commitment.
 * Mirrors the F3 spec ("persisted ≥ threshold").
 */
export const COMMITMENT_CONFIDENCE_THRESHOLD = 0.7;
