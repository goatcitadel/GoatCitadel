import type { DatabaseSync } from "node:sqlite";

/** Additive, nullable association. Legacy expectations are not backfilled or
 * promoted to execution authority. Rollback disables the new producer and
 * retains this column and the existing immutable evidence. */
export const REMOTE_WORKER_RUNTIME_APPROVAL_SQL = `ALTER TABLE remote_worker_runtime_expectations
  ADD COLUMN approval_id TEXT REFERENCES approvals(approval_id)
  CHECK (approval_id IS NULL OR (length(approval_id) BETWEEN 1 AND 200 AND trim(approval_id) = approval_id));`;

// Fresh PostgreSQL bootstrap renders the current SQLite blueprint, so the
// forward migration must also accept the column already created by bootstrap.
export const REMOTE_WORKER_RUNTIME_APPROVAL_POSTGRES_SQL = REMOTE_WORKER_RUNTIME_APPROVAL_SQL.replace("ADD COLUMN", "ADD COLUMN IF NOT EXISTS");

export function addRemoteWorkerRuntimeApprovalSchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(REMOTE_WORKER_RUNTIME_APPROVAL_SQL);
}
