import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const MIGRATION_VERSION = 225;
const NOW = "2026-11-02T00:00:00.000Z";

interface Scope {
  pool: Pool;
  migrations: PostgresDatabaseClient;
  teardown(): Promise<void>;
}

async function createScope(label: string): Promise<Scope> {
  assert.ok(postgresConnectionString);
  const schemaName = `mobile_push_classification_${label}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
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

/** One active registration with one queued delivery, seeded through its foreign keys. */
async function seedDelivery(pool: Pool, deliveryId: string): Promise<void> {
  await pool.query(
    `INSERT INTO auth_device_requests (
       request_id, approval_id, request_secret_hash, device_label, device_type, status,
       created_at, expires_at, resolved_at, resolved_by, principal_purpose
     ) VALUES ('request-1', 'approval-request-1', $1, 'Phone', 'test', 'approved', $2, '2999-01-01T00:00:00.000Z', $2,
       'operator:test', 'general_companion')`,
    ["c".repeat(64), NOW],
  );
  await pool.query(
    `INSERT INTO auth_device_grants (
       grant_id, request_id, token_hash, device_label, device_type, granted_by,
       created_at, expires_at, revoked_at, metadata_json, principal_purpose
     ) VALUES ('grant-1', 'request-1', $1, 'Phone', 'test', 'operator:test', $2, NULL, NULL, '{}', 'general_companion')`,
    ["d".repeat(64), NOW],
  );
  await pool.query(
    `INSERT INTO mobile_push_registrations (
       registration_id, grant_id, provider, token_secret_ref, token_sha256, lifecycle_state, revision,
       registered_at, updated_at
     ) VALUES ('registration-1', 'grant-1', 'expo', 'keychain:goatcitadel:mobile-push:registration-1', $1, 'active', 1,
       $2, $2)`,
    ["a".repeat(64), NOW],
  );
  await pool.query(
    `INSERT INTO mobile_push_deliveries (
       delivery_id, registration_id, source_realtime_event_id, approval_id, event_kind, payload_json, payload_sha256,
       status, last_classification, created_at, updated_at, completed_at
     ) VALUES ($1, 'registration-1', 'event-1', 'approval-1', 'approval_refresh', '{}', $2, 'cancelled_revoked',
       'registration_revoked', $3, $3, $3)`,
    [deliveryId, "b".repeat(64), NOW],
  );
}

async function setClassification(pool: Pool, deliveryId: string, classification: string): Promise<void> {
  await pool.query("UPDATE mobile_push_deliveries SET last_classification = $2 WHERE delivery_id = $1", [
    deliveryId,
    classification,
  ]);
}

async function classificationChecks(pool: Pool): Promise<Array<{ name: string; definition: string }>> {
  const result = await pool.query<{ name: string; definition: string }>(
    `SELECT constraint_row.conname AS name, pg_get_constraintdef(constraint_row.oid) AS definition
     FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'mobile_push_deliveries'::regclass
       AND constraint_row.contype = 'c'
       AND pg_get_constraintdef(constraint_row.oid) LIKE '%last_classification%'`,
  );
  return result.rows;
}

async function assertConverged(pool: Pool): Promise<void> {
  const checks = await classificationChecks(pool);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.name, "mobile_push_deliveries_last_classification_check");
  assert.match(checks[0]?.definition ?? "", /approval_already_resolved/u);
  await setClassification(pool, "delivery-1", "approval_already_resolved");
  await assert.rejects(setClassification(pool, "delivery-1", "approval_bogus"), /check constraint/iu);
  const stored = await pool.query<{ last_classification: string }>(
    "SELECT last_classification FROM mobile_push_deliveries WHERE delivery_id = 'delivery-1'",
  );
  assert.equal(stored.rows[0]?.last_classification, "approval_already_resolved");
}

describe("mobile push approval-already-resolved classification on live PostgreSQL", () => {
  postgresIt(
    "a fresh install takes the new classification and passes the schema-shape gate",
    { timeout: 300_000 },
    async () => {
      const scope = await createScope("fresh");
      try {
        const migrated = await runPostgresMigrations(scope.migrations, POSTGRES_MIGRATIONS);
        assert.equal(migrated.latestVersion, 231);
        await seedDelivery(scope.pool, "delivery-1");
        await assertConverged(scope.pool);
      } finally {
        await scope.teardown();
      }
    },
  );

  postgresIt(
    "an install upgraded from v224 keeps its rows, converges on the fresh shape and passes the gate",
    { timeout: 300_000 },
    async () => {
      const scope = await createScope("upgraded");
      try {
        await runPostgresMigrations(
          scope.migrations,
          POSTGRES_MIGRATIONS.filter((migration) => migration.version < MIGRATION_VERSION),
        );
        await seedDelivery(scope.pool, "delivery-1");
        await assert.rejects(
          setClassification(scope.pool, "delivery-1", "approval_already_resolved"),
          /check constraint/iu,
        );

        // The full registry runs the canonical schema-shape gate after the upgrade.
        const migrated = await runPostgresMigrations(scope.migrations, POSTGRES_MIGRATIONS);
        assert.deepEqual(migrated.appliedVersions, [MIGRATION_VERSION, 226, 227, 228, 229, 230, 231]);
        assert.equal(migrated.latestVersion, 231);
        const kept = await scope.pool.query<{ last_classification: string }>(
          "SELECT last_classification FROM mobile_push_deliveries WHERE delivery_id = 'delivery-1'",
        );
        assert.equal(kept.rows[0]?.last_classification, "registration_revoked");
        await assertConverged(scope.pool);
      } finally {
        await scope.teardown();
      }
    },
  );
});
