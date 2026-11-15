import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const MIGRATION_VERSION = 233;
const NOW = "2026-11-15T00:00:00.000Z";

interface Scope {
  pool: Pool;
  migrations: PostgresDatabaseClient;
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
  await assert.rejects(insertIntent(pool, "operation-remove-absent", "remove", true), /check constraint/iu);
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
        // PostgreSQL never carried these CHECKs (the canonical runtime schema creates the table without them), so
        // the previous version has none to widen; migration 233 adds the same two named CHECKs to both lineages.
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
});
