import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresSchemaShapeManifest } from "./postgres/schema-shape.js";
import { __sqliteInternals, createDatabase, createSqliteSchemaBlueprint } from "./sqlite.js";

const TABLE_COLUMNS = {
  remote_worker_mesh_join_authorities: [
    "registry_workspace_id",
    "bootstrap_id",
    "worker_id",
    "worker_generation",
    "credential_id",
    "credential_generation",
    "runtime_credential_token_sha256",
    "protected_evidence_envelope_sha256",
    "protected_evidence_context_sha256",
    "node_id",
    "workspace_id",
    "join_authority_generation",
    "target_admission_generation",
    "join_credential_sha256",
    "client_certificate_sha256",
    "issued_by_actor_id",
    "idempotency_key",
    "request_sha256",
    "issued_at",
    "expires_at",
  ],
  remote_worker_mesh_join_authority_revocations: [
    "registry_workspace_id",
    "worker_id",
    "worker_generation",
    "workspace_id",
    "join_authority_generation",
    "reason_code",
    "reason_sha256",
    "revoked_by_actor_id",
    "idempotency_key",
    "request_sha256",
    "revoked_at",
  ],
  remote_worker_mesh_node_bindings: [
    "workspace_id",
    "node_id",
    "admission_generation",
    "provenance_kind",
    "registry_workspace_id",
    "bootstrap_id",
    "worker_id",
    "worker_generation",
    "credential_id",
    "credential_generation",
    "runtime_credential_token_sha256",
    "protected_evidence_envelope_sha256",
    "protected_evidence_context_sha256",
    "join_authority_generation",
    "join_credential_sha256",
    "client_certificate_sha256",
    "stable_effect_sha256",
    "admitted_by_actor_id",
    "idempotency_key",
    "bound_at",
  ],
  remote_worker_mesh_node_admission_attempts: [
    "attempt_sha256",
    "stable_effect_sha256",
    "outcome",
    "workspace_id",
    "node_id",
    "admission_generation",
    "registry_workspace_id",
    "worker_id",
    "worker_generation",
    "credential_id",
    "credential_generation",
    "join_authority_generation",
    "idempotency_key",
    "nonce_sha256",
    "request_timestamp",
    "nonce_expires_at",
    "request_method",
    "request_path",
    "operation",
    "protocol_body_sha256",
    "transport_receipt_sha256",
    "proof_of_possession_receipt_sha256",
    "tls_exporter_sha256",
    "attempted_at",
  ],
} as const;

const sqliteDb = createDatabase({ dbPath: ":memory:" });
const postgresMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 137);
const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

after(() => sqliteDb.close());

describe("remote worker mesh-node admission schema parity", () => {
  it("reserves exactly SQLite 194 and PostgreSQL 137 after the M2 heads", () => {
    assert.equal(__sqliteInternals.getSchemaMigrationNameForTest(193), "remote_worker_protected_admission_evidence");
    assert.equal(__sqliteInternals.getSchemaMigrationNameForTest(194), "remote_worker_mesh_node_admission_authority");
    assert.equal(
      POSTGRES_MIGRATIONS.find((migration) => migration.version === 136)?.name,
      "remote_worker_protected_admission_evidence",
    );
    assert.equal(postgresMigration?.name, "remote_worker_mesh_node_admission_authority");
    assert.equal(POSTGRES_MIGRATIONS.at(-1)?.version, 137);
  });

  it("keeps SQLite and upgraded PostgreSQL authority-ledger columns exact", () => {
    const sqlite = createSqliteSchemaBlueprint();
    const postgres = buildPostgresSchemaShapeManifest(POSTGRES_MIGRATIONS);
    for (const [tableName, columns] of Object.entries(TABLE_COLUMNS)) {
      assert.deepEqual(
        sqlite.tables.find((table) => table.name === tableName)?.columns.map(({ name }) => name),
        [...columns],
        `${tableName} SQLite shape drifted`,
      );
      assert.deepEqual(
        postgres.tables.find((table) => table.name === tableName)?.columns.map(({ name }) => name),
        [...columns],
        `${tableName} PostgreSQL shape drifted`,
      );
    }
    const sqliteAdmission = sqlite.tables.find((table) => table.name === "mesh_capability_node_admissions");
    const postgresAdmission = postgres.tables.find((table) => table.name === "mesh_capability_node_admissions");
    assert.equal(
      sqliteAdmission?.columns.some(({ name }) => name === "provenance_kind"),
      true,
    );
    assert.equal(
      postgresAdmission?.columns.some(({ name }) => name === "provenance_kind"),
      true,
    );
  });

  it("stores only credential digests and preserves deterministic 411/412 -> 501/502 -> 505 locking", () => {
    const sql = postgresMigration?.sql ?? "";
    assert.doesNotMatch(sql, /raw_mesh_node_credential|mesh_node_credential_plaintext|runtime_credential_plaintext/iu);
    assert.match(sql, /join_credential_sha256/u);
    assert.match(sql, /runtime_credential_token_sha256/u);
    const guard = functionBody(sql, "gc_remote_worker_mesh_join_authority_guard");
    const offsets = [
      guard.indexOf("NEW.workspace_id, 411"),
      guard.indexOf("NEW.workspace_id || ':' || NEW.node_id, 412"),
      guard.indexOf("NEW.registry_workspace_id, 501"),
      guard.indexOf("NEW.registry_workspace_id || ':' || NEW.worker_id, 502"),
      guard.indexOf(", 505"),
    ];
    assert.equal(
      offsets.every((offset) => offset >= 0),
      true,
    );
    assert.deepEqual(
      [...offsets].sort((left, right) => left - right),
      offsets,
    );
  });

  it("keeps provenance and all new ledgers immutable", () => {
    const sqliteSql = migrationSchemaSql();
    const postgresSql = postgresMigration?.sql ?? "";
    for (const table of Object.keys(TABLE_COLUMNS)) {
      assert.match(
        sqliteSql,
        new RegExp(
          `trg_${table.replace("remote_worker_mesh_node_admission_attempts", "remote_worker_mesh_node_attempts")}_no_update`,
          "u",
        ),
      );
      assert.match(
        postgresSql,
        new RegExp(
          `trg_${table.replace("remote_worker_mesh_node_admission_attempts", "remote_worker_mesh_node_attempts")}_no_update`,
          "u",
        ),
      );
    }
    assert.match(sqliteSql, /trg_remote_worker_mesh_node_admissions_provenance_guard/u);
    assert.match(postgresSql, /trg_remote_worker_mesh_node_admissions_provenance_guard/u);
    assert.match(sqliteSql, /trg_remote_worker_mesh_join_tokens_no_delete/u);
    assert.match(postgresSql, /trg_remote_worker_mesh_join_tokens_no_delete/u);
    assert.deepEqual(sqliteDb.prepare("PRAGMA foreign_key_check").all(), []);
  });

  it(
    "applies PostgreSQL 137 live and matches the SQLite authority-ledger columns",
    { skip: postgresConnectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run live PostgreSQL parity" },
    async () => {
      assert.ok(postgresConnectionString);
      const schemaName = `m3_mesh_admission_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 1 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const migrationPool = new Pool({ connectionString: scopedUrl.toString(), max: 2 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: migrationPool },
      );
      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        for (const [tableName, columns] of Object.entries(TABLE_COLUMNS)) {
          const result = await migrationPool.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
            [schemaName, tableName],
          );
          assert.deepEqual(
            result.rows.map(({ column_name }) => column_name),
            [...columns],
            `${tableName} live PostgreSQL shape drifted`,
          );
        }
      } finally {
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );
});

function migrationSchemaSql(): string {
  return (
    sqliteDb
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE name LIKE 'remote_worker_mesh_%' OR name LIKE 'trg_remote_worker_mesh_%'
           OR tbl_name LIKE 'remote_worker_mesh_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>
  )
    .map(({ name, sql }) => `${name}\n${sql}`)
    .join("\n");
}

function functionBody(sql: string, functionName: string): string {
  const start = sql.indexOf(`FUNCTION ${functionName}`);
  assert.ok(start >= 0, `${functionName} is missing`);
  const end = sql.indexOf("$$ LANGUAGE plpgsql", start);
  assert.ok(end > start, `${functionName} body is incomplete`);
  return sql.slice(start, end);
}
