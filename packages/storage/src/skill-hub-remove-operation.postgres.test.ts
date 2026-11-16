import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { SkillLifecycleRepository } from "./skill-lifecycle-repo.js";
import { SystemSettingsRepository } from "./system-settings-repo.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const MIGRATION_VERSION = 233;
const NOW = "2026-11-15T00:00:00.000Z";

interface Scope {
  pool: Pool;
  migrations: PostgresDatabaseClient;
  connectionString: string;
  database: string;
  teardown(): Promise<void>;
}

async function createScope(label: string): Promise<Scope> {
  assert.ok(postgresConnectionString);
  const schemaName = `skill_hub_remove_${label}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const adminPool = new Pool({ connectionString: postgresConnectionString, max: 1 });
  await adminPool.query(`CREATE SCHEMA ${schemaName}`);
  const scopedUrl = new URL(postgresConnectionString);
  scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
  const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
  const pool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
  const migrations = new PostgresDatabaseClient({ connectionString: scopedUrl.toString(), database }, { pool });
  return {
    pool,
    migrations,
    connectionString: scopedUrl.toString(),
    database,
    teardown: async () => {
      await migrations.close().catch(() => undefined);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      await adminPool.end();
    },
  };
}

/**
 * Inserts one intent row with the foreign keys and the approval-binding trigger switched off for this one statement
 * (replica role), so the test exercises the CHECK constraints alone. The role is reset on the same connection.
 */
async function insertIntent(pool: Pool, operationId: string, kind: string, runtimeAbsent = false): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role = replica");
    await client.query(
      `INSERT INTO skill_hub_operation_intents (
         operation_id, idempotency_key, workspace_id, operation_kind, approval_id, snapshot_id, content_tree_sha256,
         skill_id, target_candidate_id, target_version_id, expected_candidate_revision, expected_runtime_revision,
         expected_candidate_absent, expected_runtime_absent, actor_id, request_sha256, created_at
       ) VALUES ($1, $2, 'workspace-1', $3, $4, 'snapshot-1', $5, 'extra:demo', 'candidate-1', 'version-1', 1, $6,
         0, $7, 'operator-1', $8, $9)`,
      [
        operationId,
        `key:${operationId}`,
        kind,
        `approval:${operationId}`,
        "a".repeat(64),
        runtimeAbsent ? null : 1,
        runtimeAbsent ? 1 : 0,
        "b".repeat(64),
        NOW,
      ],
    );
  } finally {
    await client.query("RESET session_replication_role").catch(() => undefined);
    client.release();
  }
}

async function kindChecks(pool: Pool): Promise<Array<{ name: string; definition: string }>> {
  const result = await pool.query<{ name: string; definition: string }>(
    `SELECT constraint_row.conname AS name, pg_get_constraintdef(constraint_row.oid) AS definition
     FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'skill_hub_operation_intents'::regclass
       AND constraint_row.contype = 'c'
       AND pg_get_constraintdef(constraint_row.oid) LIKE '%operation_kind%'
     ORDER BY constraint_row.conname`,
  );
  return result.rows;
}

async function assertConverged(pool: Pool): Promise<void> {
  const checks = await kindChecks(pool);
  assert.deepEqual(
    checks.map((check) => check.name),
    ["skill_hub_operation_intents_expectations_check", "skill_hub_operation_intents_operation_kind_check"],
  );
  assert.match(checks[1]?.definition ?? "", /'revoke'::text, 'remove'::text/u);
  await insertIntent(pool, "operation-remove", "remove");
  await assert.rejects(insertIntent(pool, "operation-bogus", "bogus"), /check constraint/iu);
  // A never-switched-on skill's removal expects no runtime record; a revoke still needs one.
  await insertIntent(pool, "operation-remove-absent", "remove", true);
  await assert.rejects(insertIntent(pool, "operation-revoke-absent", "revoke", true), /check constraint/iu);
}

/**
 * The two CHECKs migration 107 creates with the table (`CREATE TABLE IF NOT EXISTS`), as an install whose schema predates
 * the table carries them: the column CHECK and the combined one, under the names PostgreSQL generates for them.
 */
async function addMigration107Checks(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE skill_hub_operation_intents ADD CHECK(operation_kind IN (
      'install_inactive', 'stage_update_candidate', 'stage_rollback_candidate', 'activate', 'revoke'
    ));
    ALTER TABLE skill_hub_operation_intents ADD CHECK(
      (operation_kind = 'install_inactive'
        AND expected_candidate_absent = 1
        AND expected_runtime_absent = 1
        AND supersedes_version_id IS NULL)
      OR (operation_kind IN ('stage_update_candidate', 'stage_rollback_candidate')
        AND expected_candidate_absent = 0
        AND expected_runtime_absent = 0
        AND supersedes_version_id IS NOT NULL)
      OR (operation_kind = 'activate' AND expected_candidate_absent = 0)
      OR (operation_kind = 'revoke'
        AND expected_candidate_absent = 0
        AND expected_runtime_absent = 0)
    );
  `);
}

describe("Skill Hub remove operation kind on live PostgreSQL", () => {
  postgresIt(
    "a fresh install takes the remove kind and passes the schema-shape gate",
    { timeout: 300_000 },
    async () => {
      const scope = await createScope("fresh");
      try {
        const migrated = await runPostgresMigrations(scope.migrations, POSTGRES_MIGRATIONS);
        assert.equal(migrated.latestVersion, MIGRATION_VERSION);
        await assertConverged(scope.pool);
      } finally {
        await scope.teardown();
      }
    },
  );

  postgresIt(
    "a removal's saved-state deletes remove exactly one skill's state row and one setting",
    { timeout: 300_000 },
    async () => {
      const scope = await createScope("state");
      let client: PostgresSyncDatabaseClient | undefined;
      try {
        await runPostgresMigrations(scope.migrations, POSTGRES_MIGRATIONS);
        await scope.pool.query(`
          INSERT INTO skill_state (skill_id, state, note, updated_at) VALUES
            ('extra:demo', 'sleep', 'mine', '${NOW}'), ('extra:other', 'enabled', NULL, '${NOW}');
        `);
        client = new PostgresSyncDatabaseClient({
          connectionString: scope.connectionString,
          database: scope.database,
          applicationName: "gc-skill-hub-remove-state",
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        });
        const lifecycle = new SkillLifecycleRepository(client);
        const settings = new SystemSettingsRepository(client);
        settings.set("curator_idle_skill_snapshot_v1:extra:demo", { skillId: "extra:demo" }, NOW);

        assert.equal(lifecycle.deleteSavedState("extra:demo"), true);
        assert.equal(lifecycle.deleteSavedState("extra:demo"), false);
        assert.equal(settings.delete("curator_idle_skill_snapshot_v1:extra:demo"), true);
        assert.equal(settings.delete("curator_idle_skill_snapshot_v1:extra:demo"), false);
        const left = await scope.pool.query<{ skill_id: string }>("SELECT skill_id FROM skill_state ORDER BY skill_id");
        assert.deepEqual(
          left.rows.map((row) => row.skill_id),
          ["extra:other"],
        );
      } finally {
        client?.close();
        await scope.teardown();
      }
    },
  );

  postgresIt(
    "an install upgraded from v232 keeps its intents, converges on the fresh shape and passes the gate",
    { timeout: 300_000 },
    async () => {
      const scope = await createScope("upgraded");
      try {
        await runPostgresMigrations(
          scope.migrations,
          POSTGRES_MIGRATIONS.filter((migration) => migration.version < MIGRATION_VERSION),
        );
        await insertIntent(scope.pool, "operation-revoke", "revoke");
        // An install whose table came from the canonical runtime schema has no CHECK on the kind; migration 233 adds the
        // same two named CHECKs as on every other install.
        assert.deepEqual(await kindChecks(scope.pool), []);

        // The full registry runs the canonical schema-shape gate after the upgrade.
        const migrated = await runPostgresMigrations(scope.migrations, POSTGRES_MIGRATIONS);
        assert.deepEqual(migrated.appliedVersions, [MIGRATION_VERSION]);
        assert.equal(migrated.latestVersion, MIGRATION_VERSION);
        const kept = await scope.pool.query<{ operation_kind: string }>(
          "SELECT operation_kind FROM skill_hub_operation_intents WHERE operation_id = 'operation-revoke'",
        );
        assert.equal(kept.rows[0]?.operation_kind, "revoke");
        await assertConverged(scope.pool);
      } finally {
        await scope.teardown();
      }
    },
  );

  postgresIt(
    "an install upgraded from v232 whose table carries migration 107's CHECKs drops them and converges",
    { timeout: 300_000 },
    async () => {
      const scope = await createScope("v107");
      try {
        await runPostgresMigrations(
          scope.migrations,
          POSTGRES_MIGRATIONS.filter((migration) => migration.version < MIGRATION_VERSION),
        );
        await addMigration107Checks(scope.pool);
        await insertIntent(scope.pool, "operation-revoke", "revoke");
        const before = await kindChecks(scope.pool);
        assert.equal(before.length, 2);
        // The column CHECK took the very name migration 233 adds, so only the drop-by-definition loop lets it through.
        assert.ok(before.some((check) => check.name === "skill_hub_operation_intents_operation_kind_check"));
        await assert.rejects(insertIntent(scope.pool, "operation-remove-early", "remove"), /check constraint/iu);

        // The full registry runs the canonical schema-shape gate after the upgrade.
        const migrated = await runPostgresMigrations(scope.migrations, POSTGRES_MIGRATIONS);
        assert.deepEqual(migrated.appliedVersions, [MIGRATION_VERSION]);
        assert.equal(migrated.latestVersion, MIGRATION_VERSION);
        const kept = await scope.pool.query<{ operation_kind: string }>(
          "SELECT operation_kind FROM skill_hub_operation_intents WHERE operation_id = 'operation-revoke'",
        );
        assert.equal(kept.rows[0]?.operation_kind, "revoke");
        await assertConverged(scope.pool);
      } finally {
        await scope.teardown();
      }
    },
  );
});
