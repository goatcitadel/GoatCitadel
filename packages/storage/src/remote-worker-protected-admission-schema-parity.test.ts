import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";
import { buildPostgresSchemaShapeManifest } from "./postgres/schema-shape.js";
import { __sqliteInternals, createDatabase, createSqliteSchemaBlueprint } from "./sqlite.js";

const TABLE_COLUMNS = {
  remote_worker_protected_admission_signer_pins: [
    "registry_workspace_id",
    "bootstrap_id",
    "worker_id",
    "keyset_generation",
    "keyset_receipt_sha256",
    "signer_spki_sha256",
    "signer_spki_base64url",
    "authenticated_operator_actor_id",
    "authenticated_operator_actor_sha256",
    "pinned_at",
  ],
  remote_worker_protected_admission_evidence: [
    "registry_workspace_id",
    "bootstrap_id",
    "worker_id",
    "worker_generation",
    "operation_id_base64url",
    "evidence_nonce_sha256",
    "envelope_sha256",
    "envelope_base64url",
    "keyset_receipt_sha256",
    "signer_spki_sha256",
    "signer_spki_base64url",
    "signature_base64url",
    "context_sha256",
    "runtime_manifest_sha256",
    "runtime_manifest_payload_sha256",
    "workspace_ceiling_sha256",
    "capability_ceiling_sha256",
    "worker_public_key_spki_sha256",
    "worker_public_key_spki_base64url",
    "client_certificate_sha256",
    "transport_trust_anchor_sha256",
    "tls_exporter_sha256",
    "authenticated_remote_caller_binding_sha256",
    "download_verification_receipt_sha256",
    "installed_tree_attestation_sha256",
    "installed_tree_verification_receipt_sha256",
    "authenticated_operator_actor_id",
    "authenticated_operator_actor_sha256",
    "admitted_at",
  ],
  remote_worker_protected_admission_revocations: [
    "registry_workspace_id",
    "worker_id",
    "worker_generation",
    "control_revision",
    "revoked_at",
  ],
} as const;

const db = createDatabase({ dbPath: ":memory:" });
const postgresMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 136);

after(() => db.close());

describe("remote worker protected admission schema parity", () => {
  it("reserves only SQLite 193 and PostgreSQL 136 after the remediation heads", () => {
    assert.equal(__sqliteInternals.getSchemaMigrationNameForTest(193), "remote_worker_protected_admission_evidence");
    assert.equal(postgresMigration?.name, "remote_worker_protected_admission_evidence");
    assert.equal(POSTGRES_MIGRATIONS.at(-1)?.version, 136);
  });

  it("keeps fresh SQLite and fresh/upgraded PostgreSQL table shapes exact", () => {
    const sqlite = createSqliteSchemaBlueprint();
    const upgradedPostgres = buildPostgresSchemaShapeManifest(POSTGRES_MIGRATIONS);
    const freshPostgres = buildPostgresSchemaShapeManifest([
      { version: 1, name: "fresh", sql: buildPostgresRuntimeSchemaSql() },
    ]);
    for (const [tableName, columns] of Object.entries(TABLE_COLUMNS)) {
      const sqliteColumns = sqlite.tables.find((table) => table.name === tableName)?.columns.map(({ name }) => name);
      const upgradedColumns = upgradedPostgres.tables
        .find((table) => table.name === tableName)
        ?.columns.map(({ name }) => name);
      const freshColumns = freshPostgres.tables
        .find((table) => table.name === tableName)
        ?.columns.map(({ name }) => name);
      assert.deepEqual(sqliteColumns, [...columns], `${tableName} SQLite shape drifted`);
      assert.deepEqual(upgradedColumns, [...columns], `${tableName} upgraded PostgreSQL shape drifted`);
      assert.deepEqual(freshColumns, [...columns], `${tableName} fresh PostgreSQL shape drifted`);
    }
  });

  it("uses the existing bootstrap primary key and retains trigger-level worker/generation equality", () => {
    const sqlitePinSql = tableSql("remote_worker_protected_admission_signer_pins");
    const postgresSql = postgresMigration?.sql ?? "";
    for (const sql of [sqlitePinSql, postgresSql]) {
      assert.match(
        sql,
        /FOREIGN KEY\(registry_workspace_id, bootstrap_id\)[\s\S]*REFERENCES remote_worker_bootstrap_requests\(registry_workspace_id, bootstrap_id\)/u,
      );
      assert.doesNotMatch(sql, /FOREIGN KEY\(registry_workspace_id, bootstrap_id, worker_id, keyset_generation\)/u);
    }
    const sqliteSchema = protectedSchemaSql();
    for (const sql of [sqliteSchema, postgresSql]) {
      assert.match(sql, /bootstrap\.worker_id = NEW\.worker_id/u);
      assert.match(sql, /bootstrap\.target_worker_generation = NEW\.keyset_generation/u);
      assert.match(sql, /pin\.keyset_generation = NEW\.worker_generation/u);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });

  it("keeps exact global operation, nonce, and envelope uniqueness plus immutable lineage", () => {
    const sqlite = createSqliteSchemaBlueprint();
    const evidence = sqlite.tables.find((table) => table.name === "remote_worker_protected_admission_evidence");
    assert.ok(evidence);
    const uniqueColumns = evidence.indexes.filter((index) => index.unique).map((index) => index.columns.join(","));
    for (const column of ["operation_id_base64url", "evidence_nonce_sha256", "envelope_sha256"]) {
      assert.equal(uniqueColumns.includes(column), true, `SQLite lost global ${column} uniqueness`);
      assert.match(postgresMigration?.sql ?? "", new RegExp(`${column} TEXT NOT NULL UNIQUE`, "u"));
    }
    const sqliteSchema = protectedSchemaSql();
    for (const table of Object.keys(TABLE_COLUMNS)) {
      assert.match(sqliteSchema, new RegExp(`trg_${table}_no_update`, "u"));
      assert.match(sqliteSchema, new RegExp(`trg_${table}_no_delete`, "u"));
      assert.match(postgresMigration?.sql ?? "", new RegExp(`trg_${table}_no_update`, "u"));
      assert.match(postgresMigration?.sql ?? "", new RegExp(`trg_${table}_no_delete`, "u"));
    }
  });

  it("stores canonical worker verification material without inventing signer-caller truth", () => {
    for (const sql of [protectedSchemaSql(), postgresMigration?.sql ?? ""]) {
      assert.match(sql, /worker_public_key_spki_base64url/u);
      assert.match(sql, /authenticated_remote_caller_binding_sha256/u);
      assert.doesNotMatch(
        sql,
        /authenticated_(?:local|signer)_caller|operator_sid|protected_state_sha256|signer_request_sha256/iu,
      );
      assert.doesNotMatch(sql, /credential_secret|credential_token|bootstrap_secret|private_key|raw_nonce/iu);
    }
  });
});

function tableSql(tableName: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = @tableName")
    .get({ tableName }) as { sql?: string } | undefined;
  return row?.sql ?? "";
}

function protectedSchemaSql(): string {
  return (
    db
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE (type = 'table' OR type = 'trigger')
           AND (
             name LIKE 'remote_worker_protected_admission_%'
             OR tbl_name LIKE 'remote_worker_protected_admission_%'
           )
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>
  )
    .map((row) => `${row.name}\n${row.sql}`)
    .join("\n");
}
