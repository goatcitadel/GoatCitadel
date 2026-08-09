import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { DatabaseClient } from "./db.js";
import { __sqliteInternals, createDatabase } from "./sqlite.js";

const clients: DatabaseClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

describe("SQLite 196 remote-worker inference budget authority correction", () => {
  it("keeps fresh and 177->196 upgrade shapes identical while quarantining legacy rows", () => {
    const upgraded = new DatabaseSync(":memory:");
    upgraded.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE remote_worker_assignment_generations (
        registry_workspace_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        assignment_generation INTEGER NOT NULL,
        PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation)
      );
      INSERT INTO remote_worker_assignment_generations VALUES ('default', 'assignment-1', 1);
    `);
    __sqliteInternals.applySchemaMigrationForTest(177, upgraded);
    upgraded.exec(`
      INSERT INTO remote_worker_inference_requests (
        registry_workspace_id, assignment_id, assignment_generation, inference_request_id, attempt,
        worker_id, worker_generation, session_id, turn_id, idempotency_key,
        request_body_json, request_sha256, input_sha256, context_sha256, model_intent_sha256,
        capability_profile_sha256, routed_context_sha256, output_token_ceiling, reasoning_token_ceiling,
        temperature_milli, operation_id, dispatch_generation, state, governance_decision,
        effective_route_sha256, policy_revision, policy_sha256, approval_receipt_sha256,
        governance_output_token_ceiling, governance_reasoning_token_ceiling, governance_expires_at,
        budget_reservation_id, admitted_at, updated_at
      ) VALUES (
        'default', 'assignment-1', 1, 'request-1', 1,
        'worker-1', 1, 'session-1', 'turn-1', 'idem-1',
        '{"schemaVersion":"goatcitadel.remote-worker-inference-request.v1"}',
        '${"a".repeat(64)}', '${"b".repeat(64)}', '${"c".repeat(64)}', '${"d".repeat(64)}',
        '${"e".repeat(64)}', '${"f".repeat(64)}', 64, 0,
        0, 'legacy-operation', 'legacy-dispatch', 'admitted', 'allowed',
        '${"1".repeat(64)}', 1, '${"2".repeat(64)}', NULL,
        64, 0, '2099-01-01T00:00:00.000Z',
        'legacy-reservation-1', '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
      );
    `);

    __sqliteInternals.applySchemaMigrationForTest(196, upgraded);
    const legacy = upgraded
      .prepare(
        `SELECT legacy_budget_reservation_marker, budget_reservation_id, budget_authority_state
         FROM remote_worker_inference_requests WHERE inference_request_id = 'request-1'`,
      )
      .get() as {
      legacy_budget_reservation_marker: string;
      budget_reservation_id: string | null;
      budget_authority_state: string;
    };
    assert.deepEqual(
      { ...legacy },
      {
        legacy_budget_reservation_marker: "legacy-reservation-1",
        budget_reservation_id: null,
        budget_authority_state: "legacy_unverifiable",
      },
    );
    assert.throws(
      () =>
        upgraded
          .prepare(
            "UPDATE remote_worker_inference_requests SET budget_authority_state = 'not_required' WHERE inference_request_id = 'request-1'",
          )
          .run(),
      /legacy|authority transition/u,
    );
    assert.throws(
      () =>
        upgraded
          .prepare(
            "UPDATE remote_worker_inference_requests SET legacy_budget_reservation_marker = 'invented-marker' WHERE inference_request_id = 'request-1'",
          )
          .run(),
      /v2 authority evidence is immutable/u,
    );
    assert.throws(
      () =>
        upgraded
          .prepare(
            "UPDATE remote_worker_inference_requests SET effective_route_json = '{}' WHERE inference_request_id = 'request-1'",
          )
          .run(),
      /v2 authority evidence is immutable/u,
    );

    const fresh = createDatabase({ dbPath: ":memory:" });
    clients.push(fresh);
    assert.deepEqual(tableInfo(upgraded), tableInfo(fresh));
    assert.deepEqual(ownedSchema(upgraded), ownedSchema(fresh));
    upgraded.close();
  });
});

function tableInfo(db: DatabaseSync | DatabaseClient): unknown[] {
  return db.prepare("PRAGMA table_info(remote_worker_inference_requests)").all() as unknown[];
}

function ownedSchema(db: DatabaseSync | DatabaseClient): unknown[] {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE sql IS NOT NULL
         AND tbl_name IN ('remote_worker_inference_requests', 'remote_worker_inference_outbox')
       ORDER BY type, name`,
    )
    .all() as unknown[];
}
