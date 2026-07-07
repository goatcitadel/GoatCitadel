/**
 * Provable Dry-Run → Commit contracts (C2 "destroyer" moat).
 *
 * A gated external side-effect first persists a DRY-RUN preview of the *exact* planned
 * action (canonicalized + hashed as `dryRunHash`). An operator approves the preview; the
 * commit path re-derives the hash of the action it is actually about to execute and refuses
 * the commit — before the external boundary — unless it matches byte-for-byte.
 *
 * The hashing/enforcement logic lives in the gateway (`dry-run-commit-service`); these are
 * the persistence-facing shapes shared with `@goatcitadel/storage` so the ledger can be a
 * durable table instead of process memory.
 */

export type DryRunCommitState = "awaiting_commit" | "committed" | "rejected_hash_mismatch" | "rejected_commit_failed";

/**
 * The exact action that will cross (or has been refused at) the external boundary. This object —
 * and ONLY this object — is canonicalized and hashed. `route` + `target` + `payload` together fully
 * describe "what will happen", so any change to them changes `dryRunHash` and breaks the commit match.
 */
export interface DryRunPlannedAction {
  /** Logical route/operation, e.g. "integration.action.invoke" or "automation.webhook.trigger". */
  route: string;
  /** The concrete external target, e.g. "conn-1:trigger_webhook" or a sanitized destination. */
  target: string;
  /** The exact request payload that will be sent across the boundary. */
  payload: unknown;
}

/** A durable, surfacing-friendly record of *why* a commit was refused (the "can't lie" evidence). */
export interface DryRunCommitDiagnostic {
  code: "hash_mismatch" | "not_approved" | "not_awaiting_commit" | "commit_execution_failed";
  message: string;
  approvedDryRunHash?: string;
  attemptedCommitHash?: string;
  recordedAt: string;
}

/**
 * A persisted dry-run preview record in an awaiting-commit state. No external boundary has been
 * crossed when this exists. `dryRunHash` is the operator-approved fingerprint the commit must match.
 */
export interface DryRunCommitRecord {
  dryRunId: string;
  runId: string;
  boundary: string;
  workspaceId?: string;
  plannedAction: DryRunPlannedAction;
  payloadHash: string;
  /** sha256 (domain-separated) over the canonical bytes of `plannedAction`, hex-encoded. */
  dryRunHash: string;
  state: DryRunCommitState;
  /** Set once an operator approves the preview; the commit is refused until this is present. */
  approvedAt?: string;
  approvedBy?: string;
  /** Set when the commit crosses the boundary (state === "committed"). */
  committedAt?: string;
  /** Durable diagnostic when a commit is refused (hash mismatch or downstream failure). */
  diagnostic?: DryRunCommitDiagnostic;
  externalReferenceId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Narrow persistence port (in-memory or storage-backed). Structural so storage can satisfy it. */
export interface DryRunCommitStore {
  create(record: DryRunCommitRecord): DryRunCommitRecord;
  get(dryRunId: string): DryRunCommitRecord | undefined;
  update(dryRunId: string, patch: Partial<DryRunCommitRecord>): DryRunCommitRecord | undefined;
}
