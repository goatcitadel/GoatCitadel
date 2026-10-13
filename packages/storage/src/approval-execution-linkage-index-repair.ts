/**
 * Forward-only repair of the two application-owned execution linkage indexes.
 * Migration owners execute this DDL and its ledger entry in one transaction.
 * Preserve the approval/index rows, linkage backfill, and historical migration.
 * A future rollback must use another forward migration; do not edit this one.
 */
export const APPROVAL_EXECUTION_LINKAGE_INDEX_REPAIR_SQLITE_SQL = `DROP INDEX IF EXISTS idx_approval_execution_run;
DROP INDEX IF EXISTS idx_approval_execution_durable_run;
CREATE INDEX idx_approval_execution_run ON approval_execution_linkages(workspace_id, run_id, created_at DESC, approval_id DESC);
CREATE INDEX idx_approval_execution_durable_run ON approval_execution_linkages(workspace_id, durable_run_id, created_at DESC, approval_id DESC);`;

export const APPROVAL_EXECUTION_LINKAGE_INDEX_REPAIR_POSTGRES_SQL = APPROVAL_EXECUTION_LINKAGE_INDEX_REPAIR_SQLITE_SQL;
