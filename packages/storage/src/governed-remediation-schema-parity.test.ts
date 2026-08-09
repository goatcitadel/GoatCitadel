import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";
import { buildPostgresSchemaShapeManifest } from "./postgres/schema-shape.js";
import { __sqliteInternals, createSqliteSchemaBlueprint } from "./sqlite.js";

const TABLES = [
  "governed_remediation_states",
  "governed_remediation_receipts",
  "governed_remediation_failures",
  "governed_remediation_reconciliations",
  "governed_remediation_cas_transitions",
  "governed_remediation_phase_claims",
  "governed_remediation_phase_claim_acquisitions",
] as const;

describe("governed remediation durable schema parity", () => {
  it("retains the governed-remediation migration pairs at their allocated versions", () => {
    assert.equal(__sqliteInternals.getSchemaMigrationNameForTest(191), "governed_remediation_durable_owner");
    assert.equal(
      __sqliteInternals.getSchemaMigrationNameForTest(192),
      "governed_remediation_recipe_and_phase_authority",
    );
    const postgresFoundation = POSTGRES_MIGRATIONS.find((migration) => migration.version === 134);
    const postgres = POSTGRES_MIGRATIONS.find((migration) => migration.version === 135);
    assert.equal(postgresFoundation?.name, "governed_remediation_durable_owner");
    assert.equal(postgres?.name, "governed_remediation_recipe_and_phase_authority");
    assert.match(postgres?.sql ?? "", /CREATE TABLE IF NOT EXISTS governed_remediation_states/u);
    assert.match(postgres?.sql ?? "", /governed_remediation_phase_claims/u);
    assert.match(postgres?.sql ?? "", /gc_governed_remediation_cas_insert_guard/u);
    assert.match(postgres?.sql ?? "", /gc_reject_governed_remediation_mutation/u);
    assert.match(postgres?.sql ?? "", /refuses non-empty governed-remediation v1 rows/u);
  });

  it("refuses to invent missing authority for non-empty unreleased SQLite v1 rows", () => {
    const db = new DatabaseSync(":memory:");
    try {
      __sqliteInternals.applySchemaMigrationForTest(191, db);
      db.prepare(
        `INSERT INTO governed_remediation_states(
          schema_version, remediation_id, owner_id, workspace_id, session_id, source_turn_id,
          durable_run_id, blocked_checkpoint_id, recipe_id, recipe_version, deployment_id,
          scope_kind, scope_id, target_id, state, revision, expected_waiting_run_version,
          expected_owner_revision, prompt_id, prompt_expires_at, approval_id, effect_id,
          latest_receipt_id, failure_id, reconciliation_id, create_idempotency_key,
          create_request_sha256, last_transition_idempotency_key, last_transition_request_sha256,
          created_at, updated_at
        ) VALUES (
          'goatcitadel.governed-remediation-state.v1', 'legacy-remediation', 'legacy-owner',
          'legacy-workspace', 'legacy-session', 'legacy-turn', 'legacy-run', 'legacy-checkpoint',
          'legacy-recipe', 1, 'legacy-deployment', 'workspace', 'legacy-workspace', 'legacy-target',
          'blocked', 1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'legacy-create',
          @digest, NULL, NULL, '2026-08-08T20:00:00.000Z', '2026-08-08T20:00:00.000Z'
        )`,
      ).run({ digest: "a".repeat(64) });

      assert.throws(
        () => __sqliteInternals.applySchemaMigrationForTest(192, db),
        /SQLite migration 192 refuses non-empty governed-remediation v1 rows/u,
      );
      const row = db.prepare("SELECT COUNT(*) AS count FROM governed_remediation_states").get() as {
        count: number;
      };
      assert.equal(row.count, 1);
    } finally {
      db.close();
    }
  });

  it("keeps SQLite and PostgreSQL table/column shapes aligned and secret-free", () => {
    const sqlite = createSqliteSchemaBlueprint();
    const postgres = buildPostgresSchemaShapeManifest(POSTGRES_MIGRATIONS);
    for (const tableName of TABLES) {
      const sqliteTable = sqlite.tables.find((table) => table.name === tableName);
      const postgresTable = postgres.tables.find((table) => table.name === tableName);
      assert.ok(sqliteTable, `missing SQLite ${tableName}`);
      assert.ok(postgresTable, `missing PostgreSQL ${tableName}`);
      assert.deepEqual(
        postgresTable.columns.map((column) => column.name).sort(),
        sqliteTable.columns.map((column) => column.name).sort(),
        `${tableName} columns diverged`,
      );
      const forbidden = sqliteTable.columns.filter((column) =>
        /(^|_)(secret|credential|oauth_code|command|args|payload|raw_error|provider_error|error_text|value)($|_)/iu.test(
          column.name,
        ),
      );
      assert.deepEqual(forbidden, [], `${tableName} acquired a forbidden storage field`);
    }

    const runtimeSql = buildPostgresRuntimeSchemaSql();
    for (const tableName of TABLES) {
      assert.match(runtimeSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\(`, "u"));
    }
    assert.match(runtimeSql, /revision BIGINT NOT NULL/u);
    assert.doesNotMatch(runtimeSql, /governed_remediation_[\s\S]{0,300}(secret|credential_value|raw_error)/iu);

    const bootstrap = buildPostgresSchemaShapeManifest([{ version: 1, name: "bootstrap", sql: runtimeSql }]);
    assert.deepEqual(
      postgres.tables.filter((table) => TABLES.includes(table.name as (typeof TABLES)[number])),
      bootstrap.tables.filter((table) => TABLES.includes(table.name as (typeof TABLES)[number])),
      "fresh and upgraded PostgreSQL table authority diverged",
    );
    assert.deepEqual(
      postgres.indexes.filter((index) => index.name.startsWith("idx_governed_remediation_")),
      bootstrap.indexes.filter((index) => index.name.startsWith("idx_governed_remediation_")),
      "fresh and upgraded PostgreSQL index authority diverged",
    );
  });

  it("retains exact owner/scope, recovery, and immutable-CAS indexes in both dialects", () => {
    const sqlite = createSqliteSchemaBlueprint();
    const postgres = buildPostgresSchemaShapeManifest(POSTGRES_MIGRATIONS);
    const requiredIndexes = [
      "idx_governed_remediation_states_owner_scope",
      "idx_governed_remediation_states_recovery",
      "idx_governed_remediation_receipts_remediation",
      "idx_governed_remediation_failures_remediation",
      "idx_governed_remediation_reconciliations_recovery",
      "idx_governed_remediation_cas_transitions_aggregate",
      "idx_governed_remediation_phase_claims_active",
    ];
    const sqliteIndexes = new Set(sqlite.tables.flatMap((table) => table.indexes.map((index) => index.name)));
    const postgresIndexes = new Set(postgres.indexes.map((index) => index.name));
    for (const indexName of requiredIndexes) {
      assert.equal(sqliteIndexes.has(indexName), true, `SQLite missing ${indexName}`);
      assert.equal(postgresIndexes.has(indexName), true, `PostgreSQL missing ${indexName}`);
    }

    const state = sqlite.tables.find((table) => table.name === "governed_remediation_states");
    assert.deepEqual(
      state?.indexes.find((index) => index.name === "idx_governed_remediation_states_owner_scope")?.columns,
      ["owner_id", "deployment_id", "scope_kind", "scope_id", "target_id", "updated_at", "remediation_id"],
    );
    const receipt = sqlite.tables.find((table) => table.name === "governed_remediation_receipts");
    assert.equal(
      receipt?.foreignKeys.some(
        (foreignKey) =>
          foreignKey.from === "remediation_id" && foreignKey.referencedTable === "governed_remediation_states",
      ),
      true,
    );
  });
});
