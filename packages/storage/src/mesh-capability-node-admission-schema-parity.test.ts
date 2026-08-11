import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createDatabase } from "./sqlite.js";

const db = createDatabase({ dbPath: ":memory:" });
const postgresSql = POSTGRES_MIGRATIONS.find((migration) => migration.version === 111)?.sql ?? "";
const postgresPublicationSql = POSTGRES_MIGRATIONS.find((migration) => migration.version === 110)?.sql ?? "";
const postgresRemoteWorkerAdmissionSql = POSTGRES_MIGRATIONS.find((migration) => migration.version === 137)?.sql ?? "";

after(() => db.close());

/**
 * Columns added to a paired table after the 169/111 foundation, keyed to the
 * later paired migration that declares them in both dialects. SQLite 194 and
 * PostgreSQL 137 (remote_worker_mesh_node_admission_authority) appended
 * provenance_kind to the admissions table.
 */
const LATER_PAIRED_COLUMN_SOURCES: Record<string, string> = {
  provenance_kind: postgresRemoteWorkerAdmissionSql,
};

const TABLE_COLUMNS = {
  mesh_capability_node_admissions: [
    "workspace_id",
    "node_id",
    "admission_generation",
    "join_token_sha256",
    "mtls_required",
    "tls_fingerprint",
    "admitted_by_actor_id",
    "idempotency_key",
    "request_sha256",
    "admitted_at",
    "provenance_kind",
  ],
  mesh_capability_node_admission_revocations: [
    "workspace_id",
    "node_id",
    "admission_generation",
    "reason",
    "revoked_by_actor_id",
    "idempotency_key",
    "request_sha256",
    "revoked_at",
  ],
} as const;

describe("HX-408 mesh capability node-admission schema parity", () => {
  it("keeps SQLite 169 and Postgres 111 table and column contracts paired", () => {
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      assert.match(postgresSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
      assert.deepEqual(tableColumns(db, table), [...columns], `${table} SQLite columns drifted`);
      for (const column of columns) {
        const pairedSource = LATER_PAIRED_COLUMN_SOURCES[column];
        assert.match(
          pairedSource ?? postgresSql,
          new RegExp(`\\b${column}\\s+(?:TEXT|BIGINT)\\b`, "u"),
          pairedSource === undefined
            ? `${table}.${column} missing in Postgres 111`
            : `${table}.${column} missing in its later paired Postgres migration`,
        );
      }
    }
  });

  it("keeps generation, token, identity, cap, revocation, and immutability guards paired", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(sql, /mesh_join_tokens/u);
      assert.match(sql, /used_at IS NOT NULL/u);
      assert.match(sql, /used_by_node_id = (?:NEW\.node_id|p_node_id)/u);
      assert.match(sql, /node\.status = 'online'/u);
      assert.match(sql, /tls_fingerprint/u);
      assert.match(sql, /(?:>= 16|active_count >= 16)/u);
      assert.match(sql, /MAX\(current\.admission_generation\)/u);
      assert.match(sql, /health\.status NOT IN \('offline', 'revoked'\)/u);
      assert.match(sql, /publishers_admission_authority/u);
      assert.match(sql, /manifests_admission_authority/u);
      assert.match(sql, /activations_admission_authority/u);
      assert.match(sql, /intents_admission_authority/u);
      assert.match(sql, /node_admissions_no_update/u);
      assert.match(sql, /node_admissions_no_delete/u);
      assert.match(sql, /node_admission_revocations_no_update/u);
      assert.match(sql, /node_admission_revocations_no_delete/u);
    }
    assert.match(sqliteSql, /NEW\.admission_generation <> 1 \+ COALESCE/u);
    assert.match(postgresSql, /NEW\.admission_generation <> prior_generation \+ 1/u);
    assert.equal(
      postgresSql.match(/pg_advisory_xact_lock\(hashtextextended\(NEW\.workspace_id, 411\)\)/gu)?.length,
      3,
      "admit, revoke, and publisher registration must share the workspace admission lock",
    );
    assert.equal(
      postgresSql.match(
        /pg_advisory_xact_lock\(hashtextextended\(NEW\.workspace_id \|\| ':' \|\| NEW\.node_id, 412\)\)/gu,
      )?.length,
      6,
      "admit, revoke, publisher, manifest, activation, and intent must share the node admission lock",
    );
    assert.doesNotMatch(postgresSql, /mesh_capability_invocation_settlements/u);
  });

  it("replaces the historical publisher cap with current non-revoked admission authority", () => {
    const sqlitePublisherGuard = schemaObjectSql(db, "trigger", "trg_mesh_capability_publishers_insert_guard");
    assert.doesNotMatch(sqlitePublisherGuard, /COUNT\(DISTINCT node_id\)/u);
    assert.match(postgresSql, /CREATE OR REPLACE FUNCTION gc_mesh_capability_publishers_guard\(\)/u);
    assert.doesNotMatch(postgresSql, /publisher_count/u);
    assert.match(
      postgresSql,
      /gc_mesh_capability_node_admission_guard[\s\S]*active_count >= 16/u,
      "the current-admission guard remains the sole workspace cap owner",
    );
  });

  it("orders admission locks before every older publication guard lock", () => {
    const triggerOrder = [
      ["trg_mesh_capability_00_publishers_admission_authority", "trg_mesh_capability_publishers_insert_guard"],
      ["trg_mesh_capability_00_manifests_admission_authority", "trg_mesh_capability_manifest_insert_guard"],
      ["trg_mesh_capability_00_activations_admission_authority", "trg_mesh_capability_activation_guard"],
      ["trg_mesh_capability_00_intents_admission_authority", "trg_mesh_capability_intent_guard"],
    ] as const;
    for (const [admissionTrigger, olderGuardTrigger] of triggerOrder) {
      assert.match(postgresSql, new RegExp(`CREATE TRIGGER ${admissionTrigger}\\b`, "u"));
      assert.match(postgresPublicationSql, new RegExp(`CREATE TRIGGER ${olderGuardTrigger}\\b`, "u"));
      assert.ok(
        admissionTrigger < olderGuardTrigger,
        `${admissionTrigger} must sort before ${olderGuardTrigger} under PostgreSQL trigger ordering`,
      );
    }

    const publisherAdmissionGuard = postgresFunction(
      postgresSql,
      "gc_mesh_capability_publisher_admission_authority_guard",
    );
    assert.ok(
      publisherAdmissionGuard.indexOf("NEW.workspace_id, 411") <
        publisherAdmissionGuard.indexOf("NEW.workspace_id || ':' || NEW.node_id, 412"),
      "publisher admission must acquire workspace lock 411 before node lock 412",
    );
    const publisherGenerationGuard = postgresFunction(postgresSql, "gc_mesh_capability_publishers_guard");
    assert.ok(
      publisherGenerationGuard.indexOf("NEW.workspace_id, 408") <
        publisherGenerationGuard.indexOf("NEW.workspace_id || ':' || NEW.node_id, 409"),
      "the older publisher generation guard must retain its internal 408 then 409 order",
    );
  });

  it("keeps migration 111 additive and free of state-changing DML", () => {
    assert.doesNotMatch(postgresSql, /\b(?:INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu);
  });
});

function tableColumns(client: DatabaseClient, table: string): string[] {
  return (client.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name);
}

function schemaSql(client: DatabaseClient): string {
  return (
    client
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE (type = 'table' OR type = 'trigger') AND name LIKE '%mesh_capability%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>
  )
    .map((row) => `${row.name}\n${row.sql}`)
    .join("\n");
}

function schemaObjectSql(client: DatabaseClient, type: string, name: string): string {
  const row = client.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) as
    | { sql?: string }
    | undefined;
  return row?.sql ?? "";
}

function postgresFunction(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}()`);
  assert.ok(start >= 0, `missing PostgreSQL function ${name}`);
  const end = sql.indexOf("$$ LANGUAGE plpgsql;", start);
  assert.ok(end >= 0, `unterminated PostgreSQL function ${name}`);
  return sql.slice(start, end);
}
