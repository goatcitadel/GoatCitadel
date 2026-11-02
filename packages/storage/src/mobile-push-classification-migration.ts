import type { DatabaseSync } from "node:sqlite";

/**
 * A phone push skipped because its approval was already answered used to be recorded as `registration_revoked`,
 * the only cancelling classification the delivery table allowed. `approval_already_resolved` says what happened.
 * SQLite 276 rebuilds `mobile_push_deliveries` with the wider CHECK; PostgreSQL 225 replaces the column CHECK.
 * Existing rows keep their recorded classification.
 */
export const MOBILE_PUSH_APPROVAL_RESOLVED_MIGRATION_NAME = "mobile_push_approval_already_resolved_classification";

const PREVIOUS_LAST_CLASSIFICATION = "'registration_revoked'";
const WIDENED_LAST_CLASSIFICATION = "'registration_revoked', 'approval_already_resolved'";

const DELIVERY_CLASSIFICATIONS_SQL = [
  "'delivered'",
  "'invalid_token'",
  "'retryable'",
  "'unknown_after_send'",
  "'provider_unavailable'",
  "'custody_unavailable'",
  "'grant_validation_unavailable'",
  "'custody_mismatch'",
  "'registration_revoked'",
  "'approval_already_resolved'",
].join(", ");

/**
 * PostgreSQL 225. Every column CHECK naming `last_classification` is replaced by one named CHECK, so an install whose
 * constraint got a different generated name converges on the same shape as a fresh one.
 */
export const MOBILE_PUSH_APPROVAL_RESOLVED_POSTGRES_SQL = `
  DO $mobile_push_classification$
  DECLARE
    classification_constraint TEXT;
  BEGIN
    FOR classification_constraint IN
      SELECT constraint_row.conname
      FROM pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = 'mobile_push_deliveries'::regclass
        AND constraint_row.contype = 'c'
        AND pg_get_constraintdef(constraint_row.oid) LIKE '%last_classification%'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'mobile_push_deliveries', classification_constraint);
    END LOOP;
  END
  $mobile_push_classification$;
  ALTER TABLE mobile_push_deliveries ADD CONSTRAINT mobile_push_deliveries_last_classification_check CHECK(
    last_classification IS NULL OR last_classification IN (${DELIVERY_CLASSIFICATIONS_SQL})
  );
`;

/**
 * SQLite 276. SQLite cannot alter a CHECK, so the table is rebuilt from its own stored definition with the one list
 * widened. Nothing references the table, and the replacement is staged under a scratch name that is the only thing
 * renamed, so no other table's foreign keys are rewritten.
 */
export function upgradeMobilePushDeliveryClassificationsSqlite(db: DatabaseSync): void {
  const tableName = "mobile_push_deliveries";
  const stagingName = `${tableName}_classification_new`;
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { sql?: unknown }
    | undefined;
  if (typeof table?.sql !== "string") {
    return;
  }
  if (table.sql.includes("'approval_already_resolved'")) {
    return;
  }
  if (table.sql.split(PREVIOUS_LAST_CLASSIFICATION).length !== 2) {
    throw new Error(`SQLite migration 276 could not find the one classification list on ${tableName}`);
  }
  const stagingSql = table.sql
    .replace(new RegExp(`^CREATE\\s+TABLE\\s+("?)${tableName}\\1`, "u"), `CREATE TABLE ${stagingName}`)
    .replace(PREVIOUS_LAST_CLASSIFICATION, WIDENED_LAST_CLASSIFICATION);
  if (!stagingSql.startsWith(`CREATE TABLE ${stagingName}`)) {
    throw new Error(`SQLite migration 276 could not stage a replacement for ${tableName}`);
  }
  const dependents = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = ? AND sql IS NOT NULL ORDER BY type, name",
    )
    .all(tableName) as Array<{ sql: string }>;
  // Migrations run inside BEGIN IMMEDIATE, where `PRAGMA foreign_keys` is a no-op; `defer_foreign_keys` covers the
  // window where the original is dropped and the replacement has not yet taken its name.
  db.exec(`PRAGMA defer_foreign_keys = ON;`);
  db.exec(`DROP TABLE IF EXISTS ${stagingName};`);
  db.exec(stagingSql);
  db.exec(`INSERT INTO ${stagingName} SELECT * FROM ${tableName};`);
  db.exec(`DROP TABLE ${tableName};`);
  db.exec(`PRAGMA legacy_alter_table = ON;`);
  try {
    db.exec(`ALTER TABLE ${stagingName} RENAME TO ${tableName};`);
  } finally {
    db.exec(`PRAGMA legacy_alter_table = OFF;`);
  }
  for (const dependent of dependents) {
    db.exec(dependent.sql);
  }
}
