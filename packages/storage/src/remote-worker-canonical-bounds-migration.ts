import type { DatabaseSync } from "node:sqlite";

type MigrationDatabase = Pick<DatabaseSync, "exec" | "prepare">;
interface SchemaObject { type: string; name: string; sql: string }
const ATTEMPT_CHECK = "CHECK(typeof(durable_run_attempt) = 'integer' AND durable_run_attempt > 0)";
const JOIN_TTL_CHECK = "(julianday(expires_at) - julianday(issued_at)) * 86400 BETWEEN 1 AND 600";
const EXACT_JOIN_TTL_CHECK = `((unixepoch(expires_at) - unixepoch(issued_at)) * 1000
  + CAST(substr(expires_at, 21, 3) AS INTEGER) - CAST(substr(issued_at, 21, 3) AS INTEGER)) BETWEEN 1000 AND 600000`;

/** Forward-only: preserve authority bytes and all dependent records. An older
 * runtime must keep native assignment execution disabled after this upgrade;
 * returning to a positive-only attempt constraint is not a supported rollback. */
export function upgradeRemoteWorkerCanonicalBounds(db: MigrationDatabase): void {
  rebuildConstraint(db, "remote_worker_assignment_generations", ATTEMPT_CHECK,
    "CHECK(typeof(durable_run_attempt) = 'integer' AND durable_run_attempt >= 0)");
  rebuildConstraint(db, "remote_worker_mesh_join_authorities", JOIN_TTL_CHECK, EXACT_JOIN_TTL_CHECK);
}

function rebuildConstraint(db: MigrationDatabase, tableName: string, before: string, after: string): void {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type, name")
    .all(tableName) as unknown as SchemaObject[];
  const table = objects.find((item) => item.type === "table" && item.name === tableName);
  if (!table || table.sql.split(before).length !== 2)
    throw new Error(`Worker bounds migration requires the canonical ${tableName} constraint.`);
  // Dropping a parent with CASCADE/SET NULL would mutate retained evidence even
  // when FK checking is deferred. Only non-mutating incoming references qualify.
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>;
  for (const candidate of tables) {
    const references = db.prepare(`PRAGMA foreign_key_list(${quote(candidate.name)})`).all() as Array<{ table: string; on_delete: string }>;
    if (references.some((ref) => ref.table === tableName && !["RESTRICT", "NO ACTION"].includes(ref.on_delete)))
      throw new Error(`Worker bounds migration refuses a mutating reference to ${tableName}.`);
  }
  const stagingName = `${tableName}_canonical_bounds_new`;
  const stagingSql = table.sql.replace(before, after).replace(
    new RegExp(`^CREATE\\s+TABLE\\s+(?:IF NOT EXISTS\\s+)?["\x60]?${tableName}["\x60]?`, "u"), `CREATE TABLE ${stagingName}`);
  if (!stagingSql.startsWith(`CREATE TABLE ${stagingName}`)) throw new Error("Worker bounds table staging failed.");
  const deferred = Number(db.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys ?? 0);
  const legacy = Number(db.prepare("PRAGMA legacy_alter_table").get()?.legacy_alter_table ?? 0);
  db.exec("PRAGMA defer_foreign_keys = ON;");
  db.exec(stagingSql);
  db.exec(`INSERT INTO ${quote(stagingName)} SELECT * FROM ${quote(tableName)}; DROP TABLE ${quote(tableName)};`);
  db.exec("PRAGMA legacy_alter_table = ON;");
  try {
    db.exec(`ALTER TABLE ${quote(stagingName)} RENAME TO ${quote(tableName)};`);
  } finally {
    db.exec(`PRAGMA legacy_alter_table = ${legacy ? "ON" : "OFF"};`);
  }
  // Install triggers after the copy: historical evidence can have expired
  // authority and must not be re-admitted as a fresh mutation during migration.
  for (const object of objects.filter((item) => item.type !== "table")) db.exec(object.sql);
  if (db.prepare("PRAGMA foreign_key_check").get()) throw new Error("Worker bounds migration lost a foreign-key relationship.");
  // SQLite retains deferred FK debt for a dropped parent root page even after
  // the exact replacement passes foreign_key_check. Clear that stale debt only
  // after validating every relationship, then restore the caller's setting.
  db.exec("PRAGMA defer_foreign_keys = OFF;");
  if (deferred) db.exec("PRAGMA defer_foreign_keys = ON;");
}

function quote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

export const REMOTE_WORKER_CANONICAL_BOUNDS_POSTGRES_SQL = `
-- PostgreSQL join-authority expiry uses exact numeric epoch arithmetic already.
-- Its attempt CHECK needs the same zero-based durable-run correction as SQLite.
ALTER TABLE remote_worker_assignment_generations
  ADD CONSTRAINT gc_worker_attempt_before CHECK(durable_run_attempt > 0) NOT VALID;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint old_check
    JOIN pg_constraint probe ON probe.conrelid = old_check.conrelid AND probe.conname = 'gc_worker_attempt_before'
    WHERE old_check.conrelid = 'remote_worker_assignment_generations'::regclass
      AND old_check.conname = 'remote_worker_assignment_generations_durable_run_attempt_check'
      AND (old_check.contype <> 'c' OR pg_get_expr(old_check.conbin, old_check.conrelid)
        IS DISTINCT FROM pg_get_expr(probe.conbin, probe.conrelid))
  ) THEN RAISE EXCEPTION 'Worker bounds migration found a drifted durable attempt constraint'; END IF;
END $$;
ALTER TABLE remote_worker_assignment_generations DROP CONSTRAINT gc_worker_attempt_before;
ALTER TABLE remote_worker_assignment_generations DROP CONSTRAINT IF EXISTS remote_worker_assignment_generations_durable_run_attempt_check;
ALTER TABLE remote_worker_assignment_generations ADD CONSTRAINT remote_worker_assignment_generations_durable_run_attempt_check
  CHECK(durable_run_attempt >= 0);
`;
