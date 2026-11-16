import type { DatabaseSync } from "node:sqlite";

/**
 * A skill a plugin left behind can be removed through a governed Skill Hub step. The step is recorded as the new
 * operation kind `remove`, so the intent table's two CHECKs on `operation_kind` are widened: the column CHECK that
 * lists the kinds, and the combined CHECK, which gains a `remove` arm (candidate expected present, runtime record present
 * or absent: a never-switched-on skill has none) beside the unchanged revoke arm.
 * SQLite 281 rebuilds `skill_hub_operation_intents`. PostgreSQL 233 drops any CHECK naming `operation_kind` by
 * definition text and adds the two named replacements. An install whose table came from the canonical runtime schema
 * has none to drop; one whose schema predates the table got both from migration 107, under generated names (the column
 * CHECK's generated name is the very name 233 adds). Either way every install converges on the same two named CHECKs.
 * Existing rows keep their kinds.
 */
export const SKILL_HUB_REMOVE_OPERATION_MIGRATION_NAME = "skill_hub_remove_operation_kind";

const OPERATION_KIND_LIST_BEFORE = "'activate', 'revoke'";
const OPERATION_KIND_LIST_AFTER = "'activate', 'revoke', 'remove'";
const TAKES_POWER_AWAY_ARM_BEFORE = "(operation_kind = 'revoke'";
/**
 * A remove expects its candidate lineage present; its runtime record may be present (a revoked skill) or absent (a
 * skill that was never switched on). The revoke arm stays exactly as it was.
 */
const TAKES_POWER_AWAY_ARM_AFTER =
  "(operation_kind = 'remove' AND expected_candidate_absent = 0)\n      OR (operation_kind = 'revoke'";

/**
 * PostgreSQL 233. Every CHECK that names `operation_kind` is dropped (there may be none), then the two named
 * replacements are added, so an install whose constraints got different generated names converges on the same shape.
 */
export const SKILL_HUB_REMOVE_OPERATION_POSTGRES_SQL = `
  DO $skill_hub_remove_operation$
  DECLARE
    kind_constraint TEXT;
  BEGIN
    FOR kind_constraint IN
      SELECT constraint_row.conname
      FROM pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = 'skill_hub_operation_intents'::regclass
        AND constraint_row.contype = 'c'
        AND pg_get_constraintdef(constraint_row.oid) LIKE '%operation_kind%'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'skill_hub_operation_intents', kind_constraint);
    END LOOP;
  END
  $skill_hub_remove_operation$;
  ALTER TABLE skill_hub_operation_intents ADD CONSTRAINT skill_hub_operation_intents_operation_kind_check CHECK(
    operation_kind IN ('install_inactive', 'stage_update_candidate', 'stage_rollback_candidate', 'activate', 'revoke', 'remove')
  );
  ALTER TABLE skill_hub_operation_intents ADD CONSTRAINT skill_hub_operation_intents_expectations_check CHECK(
    (operation_kind = 'install_inactive'
      AND expected_candidate_absent = 1
      AND expected_runtime_absent = 1
      AND supersedes_version_id IS NULL)
    OR (operation_kind IN ('stage_update_candidate', 'stage_rollback_candidate')
      AND expected_candidate_absent = 0
      AND expected_runtime_absent = 0
      AND supersedes_version_id IS NOT NULL)
    OR (operation_kind = 'activate' AND expected_candidate_absent = 0)
    OR (operation_kind = 'remove' AND expected_candidate_absent = 0)
    OR (operation_kind = 'revoke'
      AND expected_candidate_absent = 0
      AND expected_runtime_absent = 0)
  );
`;

interface SchemaObject {
  type: string;
  name: string;
  sql: string;
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * SQLite 281. SQLite cannot alter a CHECK, so the table is rebuilt from its own stored definition with the two places
 * widened. The replacement is staged under a scratch name that is the only thing renamed (`legacy_alter_table` keeps
 * the settlements' foreign key pointing at the intents' real name), and the rebuild refuses to run when another table
 * references the intents with an action that could change its rows. Every index and trigger is re-created after the
 * copy, and a final foreign-key check proves no settlement lost its intent.
 */
export function upgradeSkillHubOperationKindsSqlite(db: DatabaseSync): void {
  const tableName = "skill_hub_operation_intents";
  const stagingName = `${tableName}_remove_new`;
  const objects = db
    .prepare("SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type, name")
    .all(tableName) as unknown as SchemaObject[];
  const table = objects.find((object) => object.type === "table" && object.name === tableName);
  if (!table) {
    return;
  }
  if (table.sql.includes("'remove'")) {
    return;
  }
  if (
    table.sql.split(OPERATION_KIND_LIST_BEFORE).length !== 2 ||
    table.sql.split(TAKES_POWER_AWAY_ARM_BEFORE).length !== 2
  ) {
    throw new Error(`SQLite migration 281 could not find the operation kind checks on ${tableName}`);
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>;
  for (const candidate of tables) {
    const references = db.prepare(`PRAGMA foreign_key_list(${quote(candidate.name)})`).all() as Array<{
      table: string;
      on_delete: string;
    }>;
    if (
      references.some(
        (reference) => reference.table === tableName && !["RESTRICT", "NO ACTION"].includes(reference.on_delete),
      )
    ) {
      throw new Error(`SQLite migration 281 refuses a mutating reference to ${tableName}`);
    }
  }
  const stagingSql = table.sql
    .replace(OPERATION_KIND_LIST_BEFORE, OPERATION_KIND_LIST_AFTER)
    .replace(TAKES_POWER_AWAY_ARM_BEFORE, TAKES_POWER_AWAY_ARM_AFTER)
    .replace(
      new RegExp(`^CREATE\\s+TABLE\\s+(?:IF NOT EXISTS\\s+)?["\`]?${tableName}["\`]?`, "u"),
      `CREATE TABLE ${stagingName}`,
    );
  if (!stagingSql.startsWith(`CREATE TABLE ${stagingName}`)) {
    throw new Error(`SQLite migration 281 could not stage a replacement for ${tableName}`);
  }
  const deferred = Number(db.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys ?? 0);
  const legacy = Number(db.prepare("PRAGMA legacy_alter_table").get()?.legacy_alter_table ?? 0);
  // Migrations run inside BEGIN IMMEDIATE, where `PRAGMA foreign_keys` is a no-op; `defer_foreign_keys` covers the
  // window where the original is dropped and the replacement has not yet taken its name.
  db.exec("PRAGMA defer_foreign_keys = ON;");
  db.exec(`DROP TABLE IF EXISTS ${quote(stagingName)};`);
  db.exec(stagingSql);
  db.exec(`INSERT INTO ${quote(stagingName)} SELECT * FROM ${quote(tableName)};`);
  db.exec(`DROP TABLE ${quote(tableName)};`);
  db.exec("PRAGMA legacy_alter_table = ON;");
  try {
    db.exec(`ALTER TABLE ${quote(stagingName)} RENAME TO ${quote(tableName)};`);
  } finally {
    db.exec(`PRAGMA legacy_alter_table = ${legacy ? "ON" : "OFF"};`);
  }
  // Triggers come back after the copy so the immutability and approval-binding triggers never see the copied rows.
  for (const object of objects.filter((item) => item.type !== "table")) {
    db.exec(object.sql);
  }
  // Only a violation whose parent is the rebuilt table counts, so an unrelated, older one cannot block the upgrade.
  const violations = db.prepare("PRAGMA foreign_key_check").all() as Array<{ parent: string }>;
  if (violations.some((row) => row.parent === tableName)) {
    throw new Error("SQLite migration 281 lost a foreign-key relationship on the Skill Hub operation intents");
  }
  // SQLite keeps deferred foreign-key debt for a dropped parent's root page even after the replacement passes the
  // check. Clear it only after validating every relationship, then restore the caller's setting.
  db.exec("PRAGMA defer_foreign_keys = OFF;");
  if (deferred) {
    db.exec("PRAGMA defer_foreign_keys = ON;");
  }
}
