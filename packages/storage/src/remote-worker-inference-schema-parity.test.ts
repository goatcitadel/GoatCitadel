import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createDatabase } from "./sqlite.js";

const db = createDatabase({ dbPath: ":memory:" });
const postgres119Sql = POSTGRES_MIGRATIONS.find((migration) => migration.version === 119)?.sql ?? "";
const postgres139Sql = POSTGRES_MIGRATIONS.find((migration) => migration.version === 139)?.sql ?? "";
const postgresSql = `${postgres119Sql}\n${postgres139Sql}`;

after(() => db.close());

const TABLE_COLUMNS = {
  remote_worker_inference_requests: [
    "registry_workspace_id",
    "assignment_id",
    "assignment_generation",
    "inference_request_id",
    "attempt",
    "worker_id",
    "worker_generation",
    "session_id",
    "turn_id",
    "idempotency_key",
    "request_body_json",
    "request_sha256",
    "input_sha256",
    "context_sha256",
    "model_intent_sha256",
    "capability_profile_sha256",
    "routed_context_sha256",
    "output_token_ceiling",
    "reasoning_token_ceiling",
    "temperature_milli",
    "operation_id",
    "dispatch_generation",
    "state",
    "governance_decision",
    "effective_route_sha256",
    "policy_revision",
    "policy_sha256",
    "approval_receipt_sha256",
    "governance_output_token_ceiling",
    "governance_reasoning_token_ceiling",
    "governance_expires_at",
    "legacy_budget_reservation_marker",
    "effective_provider_id",
    "effective_model_id",
    "dispatch_claim_owner",
    "dispatch_claimed_at",
    "dispatch_lease_expires_at",
    "usage_intent_event_id",
    "usage_terminal_event_id",
    "output_frame_count",
    "output_char_count",
    "worker_acknowledged_through",
    "terminal_frame_sequence",
    "terminal_sha256",
    "accounting_disposition",
    "admitted_at",
    "updated_at",
    "execution_workspace_id",
    "durable_run_id",
    "task_id",
    "admitted_lease_revision",
    "effective_route_json",
    "approval_resolution_json",
    "approval_resolution_sha256",
    "approval_resolved_at",
    "continuation_governance_json",
    "continuation_governance_sha256",
    "continuation_governance_expires_at",
    "budget_authority_state",
    "budget_operation_id",
    "budget_operation_json",
    "budget_operation_sha256",
    "budget_reservation_id",
    "budget_reservation_json",
    "budget_reservation_sha256",
    "budget_reservation_expires_at",
    "usage_event_ids_json",
    "usage_event_ids_sha256",
    "budget_settled_at",
    "budget_released_at",
    "block_reason",
  ],
  remote_worker_inference_outbox: [
    "registry_workspace_id",
    "assignment_id",
    "assignment_generation",
    "inference_request_id",
    "attempt",
    "frame_sequence",
    "frame_kind",
    "payload_json",
    "payload_sha256",
    "previous_frame_sha256",
    "frame_sha256",
    "effective_route_sha256",
    "usage_event_id",
    "frame_char_count",
    "created_at",
  ],
} as const;

describe("HX-503 remote worker inference schema parity", () => {
  it("keeps final SQLite 177+196 and PostgreSQL 119+139 columns paired", () => {
    assert.equal(
      postgres119Sql.match(/CREATE TABLE IF NOT EXISTS remote_worker_inference_/gu)?.length,
      2,
      "PostgreSQL 119 must add exactly the two inference tables",
    );
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      assert.match(postgres119Sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
      assert.deepEqual(tableColumns(db, table), [...columns], `${table} SQLite columns drifted`);
      for (const column of columns) {
        if (column === "legacy_budget_reservation_marker") {
          assert.match(postgres139Sql, /RENAME COLUMN budget_reservation_id TO legacy_budget_reservation_marker/u);
          continue;
        }
        assert.match(
          postgresSql,
          new RegExp(`\\b${column}\\s+(?:TEXT|BIGINT)\\b`, "u"),
          `${table}.${column} missing in PostgreSQL`,
        );
      }
      assert.equal(columns[0], "registry_workspace_id", `${table} must prefix identity with registry workspace`);
    }
  });

  it("never stores a raw assignment lease or a provider credential in either dialect", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.doesNotMatch(
        sql,
        /lease_token|lease_secret|raw_lease|provider_credential|credential_ref|api_key|authorization|secret_material|bearer/iu,
      );
    }
  });

  it("binds the assignment-generation and request authorities through complete composite foreign keys", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(
        sql,
        /FOREIGN KEY\(registry_workspace_id, assignment_id, assignment_generation\)[\s\S]*REFERENCES remote_worker_assignment_generations/u,
      );
      assert.match(
        sql,
        /FOREIGN KEY\(registry_workspace_id, assignment_id, assignment_generation, inference_request_id, attempt\)[\s\S]*REFERENCES remote_worker_inference_requests/u,
      );
    }
  });

  it("keeps the deployed owners immutable and confines the forward correction to migration 139", () => {
    assert.equal(postgres119Sql.match(/ALTER TABLE/gu) ?? null, null);
    assert.match(postgres139Sql, /RENAME COLUMN budget_reservation_id TO legacy_budget_reservation_marker/u);
    assert.doesNotMatch(postgres139Sql, /DROP\s+(?:TABLE|COLUMN)|TRUNCATE/u);
  });

  it("keeps the terminal receipt, claim, and governance invariants paired", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(
        sql,
        /\(state IN \('completed', 'failed', 'cancelled'\)\) = \(terminal_frame_sequence IS NOT NULL AND terminal_sha256 IS NOT NULL\)/u,
      );
      assert.match(
        sql,
        /\(dispatch_claim_owner IS NULL\) = \(state IN \('admitted', 'waiting_approval', 'blocked'\)\)/u,
      );
      assert.match(sql, /governance_decision <> 'denied' OR state = 'blocked'/u);
      assert.match(sql, /worker_acknowledged_through <= output_frame_count/u);
    }
  });

  it("keeps immutability, terminal, acknowledgement, and append-only guards paired across dialects", () => {
    const sqliteSql = schemaSql(db);
    for (const trigger of [
      "trg_remote_worker_inference_requests_immutable",
      "trg_remote_worker_inference_requests_terminal_guard",
      "trg_remote_worker_inference_requests_ack_monotonic",
      "trg_remote_worker_inference_outbox_chain_guard",
      "trg_remote_worker_inference_outbox_no_update",
      "trg_remote_worker_inference_outbox_no_delete",
    ]) {
      assert.match(sqliteSql, new RegExp(trigger, "u"), `SQLite trigger ${trigger} missing`);
      assert.match(postgresSql, new RegExp(trigger, "u"), `PostgreSQL trigger ${trigger} missing`);
    }
    for (const sqliteTrigger of [
      "trg_remote_worker_inference_budget_authority_insert_guard",
      "trg_remote_worker_inference_budget_authority_update_guard",
      "trg_remote_worker_inference_v2_authority_immutable",
    ]) {
      assert.match(sqliteSql, new RegExp(sqliteTrigger, "u"));
    }
    for (const postgresTrigger of [
      "trg_remote_worker_inference_budget_authority_guard",
      "trg_remote_worker_inference_v2_authority_immutable",
    ]) {
      assert.match(postgres139Sql, new RegExp(postgresTrigger, "u"));
    }
  });

  it("keeps PostgreSQL 119 additive and free of state-changing DML or runtime claims", () => {
    assert.doesNotMatch(
      postgres119Sql,
      /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+remote_worker|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu,
    );
    assert.doesNotMatch(postgres119Sql, /gateway_route|readiness|listener|scheduler|\bcell\b/iu);
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
         WHERE (type = 'table' OR type = 'trigger') AND name LIKE '%remote_worker_inference%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>
  )
    .map((row) => `${row.name}\n${row.sql}`)
    .join("\n");
}
