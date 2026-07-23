import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createDatabase } from "./sqlite.js";

const db = createDatabase({ dbPath: ":memory:" });
const postgresSql = POSTGRES_MIGRATIONS.find((migration) => migration.version === 121)?.sql ?? "";

after(() => db.close());

const IDENTITY = [
  "registry_workspace_id",
  "execution_workspace_id",
  "assignment_id",
  "assignment_generation",
  "worker_id",
  "worker_generation",
  "runtime_manifest_sha256",
  "workspace_ceiling_sha256",
  "capability_ceiling_sha256",
  "assignment_manifest_sha256",
] as const;

const TABLE_COLUMNS = {
  remote_worker_artifact_uploads: [
    ...IDENTITY,
    "upload_id",
    "upload_attempt",
    "upload_state",
    "upload_revision",
    "declared_file_count",
    "declared_total_bytes",
    "max_artifact_bytes",
    "staging_root_sha256",
    "committed_manifest_sha256",
    "verification_gate_state",
    "verification_gate_revision",
    "cleanup_state",
    "cleanup_revision",
    "cleanup_claim_owner",
    "cleanup_claim_expires_at",
    "expires_at",
    "idempotency_key",
    "request_sha256",
    "created_at",
    "updated_at",
  ],
  remote_worker_artifact_parts: [
    ...IDENTITY,
    "upload_id",
    "global_sequence",
    "logical_path_sha256",
    "file_part_index",
    "is_final_part",
    "part_bytes",
    "part_sha256",
    "idempotency_key",
    "request_sha256",
    "received_at",
  ],
  remote_worker_artifact_blobs: [
    ...IDENTITY,
    "upload_id",
    "blob_sha256",
    "byte_count",
    "physical_rel_path",
    "installed_at",
  ],
  remote_worker_artifact_manifests: [
    ...IDENTITY,
    "upload_id",
    "manifest_id",
    "manifest_sha256",
    "manifest_json",
    "file_count",
    "total_bytes",
    "path_jail_sha256",
    "worker_claim_sha256",
    "required_verifier_profile_sha256",
    "idempotency_key",
    "request_sha256",
    "committed_at",
  ],
  remote_worker_artifact_manifest_entries: [
    ...IDENTITY,
    "manifest_id",
    "entry_index",
    "logical_path",
    "logical_path_sha256",
    "blob_sha256",
    "byte_count",
    "mime_type",
  ],
  remote_worker_artifact_verifications: [
    ...IDENTITY,
    "manifest_id",
    "verification_id",
    "kind",
    "attempt_index",
    "attempt_state",
    "attempt_revision",
    "verifier_profile_sha256",
    "evidence_json",
    "evidence_sha256",
    "claim_owner",
    "claim_expires_at",
    "wall_deadline_at",
    "idempotency_key",
    "request_sha256",
    "created_at",
    "updated_at",
  ],
  remote_worker_effect_intents: [
    ...IDENTITY,
    "intent_id",
    "intent_index",
    "effect_selector",
    "canonical_args_json",
    "canonical_args_sha256",
    "intent_sha256",
    "worker_idempotency_key",
    "idempotency_key",
    "request_sha256",
    "recorded_at",
  ],
  remote_worker_effect_transitions: [
    ...IDENTITY,
    "intent_id",
    "transition_sequence",
    "transition_state",
    "correlation_json",
    "correlation_sha256",
    "external_side_effect_run_id",
    "hx305_outcome_sha256",
    "previous_transition_sha256",
    "transition_sha256",
    "idempotency_key",
    "request_sha256",
    "recorded_at",
  ],
  remote_worker_effect_receipts: [
    ...IDENTITY,
    "intent_id",
    "receipt_state",
    "receipt_revision",
    "final_transition_sequence",
    "final_transition_sha256",
    "hx305_outcome_sha256",
    "reconciliation_record_sha256",
    "idempotency_key",
    "request_sha256",
    "created_at",
    "updated_at",
  ],
} as const;

const INSERT_ONLY_TABLES = [
  "remote_worker_artifact_parts",
  "remote_worker_artifact_blobs",
  "remote_worker_artifact_manifests",
  "remote_worker_artifact_manifest_entries",
  "remote_worker_effect_intents",
  "remote_worker_effect_transitions",
] as const;

describe("HX-506 remote worker settlement schema parity", () => {
  it("pairs SQLite 179 and PostgreSQL 121 across exactly nine tables with matching columns", () => {
    assert.equal(postgresSql.match(/CREATE TABLE IF NOT EXISTS remote_worker_/gu)?.length, 9);
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      assert.match(postgresSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
      assert.deepEqual(tableColumns(db, table), [...columns], `${table} SQLite columns drifted`);
      for (const column of columns) {
        assert.match(postgresSql, new RegExp(`\\b${column}\\s+(?:TEXT|BIGINT)\\b`, "u"), `${table}.${column} in PG`);
      }
    }
  });

  it("adds the additive full-identity unique key and binds every child to it", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(sql, /idx_remote_worker_assignment_generations_full_identity/u);
    }
    // Each of the nine tables carries the composite full-identity foreign key.
    assert.equal(
      postgresSql.match(
        /REFERENCES remote_worker_assignment_generations\(\s*registry_workspace_id, assignment_id, assignment_generation, execution_workspace_id, worker_id/gu,
      )?.length,
      9,
    );
  });

  it("keeps parts/blobs/manifests/entries/intents/transitions insert-only in both dialects", () => {
    const sqliteSql = schemaSql(db);
    for (const table of INSERT_ONLY_TABLES) {
      assert.match(sqliteSql, new RegExp(`trg_${table}_no_update`, "u"), `${table} SQLite no-update`);
      assert.match(sqliteSql, new RegExp(`trg_${table}_no_delete`, "u"), `${table} SQLite no-delete`);
      assert.match(postgresSql, new RegExp(`trg_${table}_no_update`, "u"), `${table} PG no-update`);
      assert.match(postgresSql, new RegExp(`trg_${table}_no_delete`, "u"), `${table} PG no-delete`);
    }
  });

  it("pairs revision-CAS mutation guards and the manifest-binding roots", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(sql, /remote worker artifact upload revision must advance monotonically/u);
      assert.match(sql, /remote worker verification attempt revision must advance monotonically/u);
      assert.match(sql, /remote worker effect receipt may only advance from manual reconciliation/u);
      assert.match(sql, /remote worker artifact part sequence must be globally contiguous/u);
      assert.match(sql, /remote worker effect transition chain is out of order or misbound/u);
      assert.match(sql, /assignment manifest hash must bind the parent assignment/u);
    }
  });

  it("keeps the migration production-dark: byte-bounded, payload-free, and non-authoritative", () => {
    assert.match(postgresSql, /octet_length\(manifest_json\) <= 65536/u);
    assert.match(postgresSql, /octet_length\(canonical_args_json\) <= 65536/u);
    assert.doesNotMatch(postgresSql, /length\(octet_length/u);
    assert.match(postgresSql, /ON DELETE RESTRICT/u);
    // Never extends the canonical effect/usage owners, never recomputes cost.
    assert.doesNotMatch(postgresSql, /external_side_effect_runs|model_usage_events|cost_ledger/iu);
    assert.doesNotMatch(
      postgresSql,
      /\b(?:INSERT\s+INTO|UPDATE\s+durable_runs|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu,
    );
    // completed_with_effect requires a canonical HX-305 outcome, never a result body.
    assert.match(postgresSql, /transition_state <> 'completed_with_effect' OR hx305_outcome_sha256 IS NOT NULL/u);
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
         WHERE (type = 'table' OR type = 'trigger' OR type = 'index')
           AND (name LIKE '%remote_worker_artifact%' OR name LIKE '%remote_worker_effect%'
                OR name LIKE '%remote_worker_assignment_generations_full_identity%')
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>
  )
    .map((row) => `${row.name}\n${row.sql ?? ""}`)
    .join("\n");
}
