import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createDatabase } from "./sqlite.js";

const db = createDatabase({ dbPath: ":memory:" });
const postgresSql = POSTGRES_MIGRATIONS.find((migration) => migration.version === 113)?.sql ?? "";

after(() => db.close());

const TABLE_COLUMNS = {
  remote_worker_assignments: [
    "registry_workspace_id",
    "assignment_id",
    "execution_workspace_id",
    "durable_run_id",
    "task_id",
    "session_id",
    "turn_id",
    "manifest_json",
    "manifest_sha256",
    "created_by_actor_id",
    "idempotency_key",
    "request_sha256",
    "created_at",
  ],
  remote_worker_assignment_generations: [
    "registry_workspace_id",
    "assignment_id",
    "assignment_generation",
    "execution_workspace_id",
    "worker_id",
    "worker_generation",
    "node_id",
    "node_admission_generation",
    "runtime_manifest_sha256",
    "workspace_ceiling_sha256",
    "capability_ceiling_sha256",
    "dispatch_owner_id",
    "durable_run_attempt",
    "dispatch_authority_json",
    "dispatch_authority_sha256",
    "idempotency_key",
    "request_sha256",
    "started_at",
  ],
  remote_worker_assignment_leases: [
    "registry_workspace_id",
    "assignment_id",
    "assignment_generation",
    "lease_revision",
    "lease_token_sha256",
    "worker_sent_through",
    "server_acknowledged_through",
    "parent_dispatch_authority_json",
    "parent_dispatch_authority_sha256",
    "heartbeat_at",
    "expires_at",
    "idempotency_key",
    "request_sha256",
  ],
  remote_worker_assignment_controls: [
    "registry_workspace_id",
    "assignment_id",
    "assignment_generation",
    "control_revision",
    "action",
    "expected_lease_revision",
    "reason_code",
    "reason_sha256",
    "actor_id",
    "idempotency_key",
    "request_sha256",
    "created_at",
  ],
  remote_worker_assignment_events: [
    "registry_workspace_id",
    "assignment_id",
    "assignment_generation",
    "sequence",
    "event_id",
    "event_type",
    "payload_json",
    "payload_sha256",
    "previous_event_sha256",
    "event_sha256",
    "worker_sent_through",
    "received_at",
  ],
  remote_worker_assignment_settlements: [
    "registry_workspace_id",
    "assignment_id",
    "assignment_generation",
    "schema_version",
    "outcome",
    "origin",
    "gateway_actor_id",
    "recovery_evidence_sha256",
    "final_event_sequence",
    "final_event_sha256",
    "result_sha256",
    "output_manifest_sha256",
    "failure_sha256",
    "idempotency_key",
    "request_sha256",
    "settled_at",
  ],
  remote_worker_assignment_materializations: [
    "registry_workspace_id",
    "assignment_id",
    "materialization_id",
    "schema_version",
    "source_kind",
    "source_generation",
    "source_sequence",
    "source_sha256",
    "target_kind",
    "target_id",
    "target_sha256",
    "target_owner_session_id",
    "target_owner_turn_id",
    "target_owner_durable_run_id",
    "receipt_sha256",
    "gateway_actor_id",
    "idempotency_key",
    "request_sha256",
    "materialized_at",
  ],
} as const;

describe("HX-502/HX-504 remote worker assignment schema parity", () => {
  it("pairs SQLite 171 and PostgreSQL 113 across exactly seven append-only tables", () => {
    assert.equal(postgresSql.match(/CREATE TABLE IF NOT EXISTS remote_worker_assignment/gu)?.length, 7);
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      assert.match(postgresSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
      assert.deepEqual(tableColumns(db, table), [...columns], `${table} SQLite columns drifted`);
      for (const column of columns) {
        assert.match(postgresSql, new RegExp(`\\b${column}\\s+(?:TEXT|BIGINT)\\b`, "u"));
      }
      assert.match(postgresSql, new RegExp(`${table}_no_update`, "u"));
      assert.match(postgresSql, new RegExp(`${table}_no_delete`, "u"));
    }
  });

  it("keeps event vocabulary, cumulative ceilings, and flow watermarks paired", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(
        sql,
        /event_type[\s\S]*'status', 'tool_progress', 'model_progress', 'approval_wait',[\s\S]*'diagnostic', 'transcript_delta', 'terminal_output'/u,
      );
      assert.match(sql, /maxEventCount/u);
      assert.match(sql, /maxEventBytes/u);
      assert.match(sql, /eventLowWatermark/u);
      assert.match(sql, /eventHighWatermark/u);
      assert.match(sql, /maxOutputBytes/u);
      assert.match(sql, /SUM\([\s\S]*(?:payload_json|octet_length)/u);
      assert.match(sql, /worker_sent_through[\s\S]*MAX\(committed\.worker_sent_through\)/u);
      assert.match(sql, /server_acknowledged_through/u);
    }
  });

  it("pairs fail-closed manifest fields, exact event payloads, and per-manifest watermarks", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(sql, /field\.key NOT IN \([\s\S]*'maxEventBytes'[\s\S]*'maxArtifactBytes'/u);
      for (const eventType of [
        "status",
        "tool_progress",
        "model_progress",
        "approval_wait",
        "diagnostic",
        "transcript_delta",
        "terminal_output",
      ]) {
        assert.match(sql, new RegExp(`(?:WHEN '${eventType}' THEN|NEW\\.event_type = '${eventType}' THEN)`, "u"));
      }
      assert.match(sql, /NEW\.worker_sent_through <= [\s\S]*maxEventCount/u);
      assert.match(sql, /transcript_delta[\s\S]*text[\s\S]*16384[\s\S]*65536/u);
      assert.match(sql, /terminal_output[\s\S]*byteLength[\s\S]*BETWEEN 1 AND 65536/u);
    }
    assert.match(sqliteSql, /COALESCE\(json_type\(NEW\.payload_json, '\$\.byteLength'\), ''\) = 'integer'/u);
    assert.match(sqliteSql, /CASE WHEN NEW\.session_id IS NULL THEN 20 ELSE 22 END/u);
    assert.match(sqliteSql, /COALESCE\(json_type\(NEW\.payload_json, '\$\.text'\), ''\) = 'text'/u);
    assert.match(postgresSql, /jsonb_typeof\(event_payload -> 'byteLength'\) = 'number'/u);
    assert.match(postgresSql, /COALESCE\(jsonb_typeof\(event_payload -> 'text'\), ''\) = 'string'/u);
    assert.match(
      postgresSql,
      /NEW\.session_id IS NULL[\s\S]*jsonb_object_keys\(manifest_payload\)\) <> 20[\s\S]*NEW\.session_id IS NOT NULL[\s\S]*jsonb_object_keys\(manifest_payload\)\) <> 22/u,
    );
    assert.match(
      postgresSql,
      /COUNT\(\*\) FROM json_each\(NEW\.manifest_json::json\)[\s\S]*COUNT\(DISTINCT field\.key\) FROM json_each\(NEW\.manifest_json::json\)/u,
    );
    assert.match(
      postgresSql,
      /COUNT\(\*\) FROM json_each\(NEW\.payload_json::json\)[\s\S]*COUNT\(DISTINCT field\.key\) FROM json_each\(NEW\.payload_json::json\)/u,
    );
  });

  it("pairs live parent heartbeat snapshots and serializes canonical-parent validation", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(sql, /parent_dispatch_authority_json/u);
      assert.match(sql, /durableRunVersion/u);
      assert.match(sql, /durableRunLeaseExpiresAt/u);
      assert.match(sql, /remoteWorkerAssignmentParentContextSha256/u);
      assert.match(sql, /task\.deleted_at IS NULL/u);
      assert.match(sql, /chat_session_meta/u);
      assert.match(sql, /chat_turn_traces/u);
    }
    assert.match(postgresSql, /gc_remote_worker_assignment_lock_parent_context/u);
    assert.match(postgresSql, /FROM durable_runs run WHERE run\.run_id = durable_run_key FOR UPDATE/u);
    assert.match(postgresSql, /FROM tasks task WHERE task\.task_id = task_key FOR SHARE/u);
    assert.match(postgresSql, /FROM chat_session_meta session WHERE session\.session_id = session_key FOR SHARE/u);
    assert.match(postgresSql, /FROM chat_turn_traces turn_trace WHERE turn_trace\.turn_id = turn_key FOR SHARE/u);
    assert.match(postgresSql, /gc_remote_worker_assignment_lock_parent_by_assignment/u);
    assert.match(postgresSql, /LANGUAGE plpgsql/u);
  });

  it("keeps cancellation/recovery and materialization ownership mutually explicit", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(sql, /action IN \('cancel_requested', 'generation_abandoned', 'recovery_exhausted'\)/u);
      assert.match(sql, /NEW\.outcome = 'cancelled'[\s\S]*control\.action = 'cancel_requested'/u);
      assert.match(sql, /NEW\.outcome IN \('completed', 'failed'\)[\s\S]*generation_abandoned/u);
      assert.match(sql, /source_kind = 'event'[\s\S]*target_kind = 'chat_transcript'/u);
      assert.match(sql, /source_kind = 'settlement'[\s\S]*target_kind = 'durable_run_result'/u);
      assert.match(sql, /target_owner_session_id/u);
      assert.match(sql, /target_owner_durable_run_id/u);
      assert.match(sql, /event_type = 'transcript_delta'/u);
    }
    assert.match(postgresSql, /WHERE source_kind = 'event'/u);
    assert.match(postgresSql, /WHERE source_kind = 'settlement'/u);
  });

  it("keeps the migration additive, production-dark, and validly byte-bounded", () => {
    assert.doesNotMatch(postgresSql, /length\(octet_length/u);
    assert.match(postgresSql, /octet_length\(manifest_json\) <= 32768/u);
    assert.match(postgresSql, /octet_length\(payload_json\) <= 65536/u);
    assert.match(postgresSql, /ON DELETE RESTRICT/u);
    assert.doesNotMatch(
      postgresSql,
      /\b(?:INSERT\s+INTO|UPDATE\s+durable_runs|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu,
    );
    assert.doesNotMatch(
      postgresSql,
      /model_usage_events|CostLedgerRepository|chat_messages\s+SET|durable_runs\s+SET/iu,
    );
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
           AND name LIKE '%remote_worker_assignment%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>
  )
    .map((row) => `${row.name}\n${row.sql ?? ""}`)
    .join("\n");
}
