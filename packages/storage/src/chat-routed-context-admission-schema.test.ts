import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  CHAT_ROUTED_CONTEXT_ADMISSION_POSTGRES_SQL,
  upgradeChatRoutedContextAdmissionSchema,
} from "./chat-routed-context-admission-schema.js";

function legacyRow() {
  return {
    snapshot_id: "old-snapshot",
    schema_version: "chat.routed-context-snapshot.v2",
    turn_id: "old-turn",
    session_id: "session",
    workspace_id: "workspace",
    capability_profile_id: "old-profile",
    capability_profile_hash: "a".repeat(64),
    source_request_hash: "b".repeat(64),
    content_hash: "c".repeat(64),
    snapshot_hash: "d".repeat(64),
    effective_provider_id: "provider",
    effective_model: "model",
    context_window_tokens: 8192,
    prompt_reserved_tokens: 1000,
    output_reserved_tokens: 1000,
    hard_cap_tokens: 4096,
    effective_budget_tokens: 4096,
    used_tokens: 0,
    source_count: 0,
    included_count: 0,
    truncated_count: 0,
    omitted_count: 0,
    already_attached_count: 0,
    estimator_version: "gc-approx-tokens.v1",
    budget_policy_version: "chat.routed-context-budget.v1",
    snapshot_json: '{ "untouched" : "exact old bytes\\n" }',
    created_at: "2026-10-01T00:00:00Z",
  };
}
function insert(db: DatabaseSync, row: Record<string, string | number | null>) {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO chat_routed_context_snapshots (${keys.join(",")}) VALUES (${keys.map((key) => `@${key}`).join(",")})`,
  ).run(row);
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  const row = legacyRow();
  db.exec(`CREATE TABLE chat_routed_context_snapshots (${Object.entries(row)
    .map(([key, value]) => `${key} ${typeof value === "number" ? "INTEGER" : "TEXT"}`)
    .join(",")});
    CREATE TABLE chat_turn_capability_profiles (profile_id TEXT, profile_hash TEXT, turn_id TEXT, session_id TEXT, workspace_id TEXT);
    CREATE TABLE chat_turn_capability_profile_incarnation_bindings (profile_id TEXT, profile_hash TEXT, turn_id TEXT);
    CREATE TABLE chat_turn_session_incarnation_bindings (turn_id TEXT, admission_id TEXT, session_id TEXT, workspace_id TEXT, session_incarnation_id TEXT);
    CREATE TABLE chat_session_mutation_admissions (admission_id TEXT, status TEXT, admission_kind TEXT, turn_id TEXT, session_id TEXT,
      workspace_id TEXT, session_incarnation_id TEXT, material_sha256 TEXT, aggregate_revision INTEGER, controller_generation INTEGER);`);
  insert(db, row);
  upgradeChatRoutedContextAdmissionSchema(db);
  return { db, row };
}
function newRow() {
  return {
    ...legacyRow(),
    snapshot_id: "new-snapshot",
    schema_version: "chat.routed-context-snapshot.v3",
    turn_id: "new-turn",
    capability_profile_id: null,
    capability_profile_hash: null,
    snapshot_hash: "e".repeat(64),
    admission_id: "admission",
    session_incarnation_id: "incarnation",
    admission_material_sha256: "f".repeat(64),
    admission_aggregate_revision: 2,
    admission_controller_generation: 3,
  };
}
function admit(db: DatabaseSync) {
  db.prepare(
    "INSERT INTO chat_turn_session_incarnation_bindings VALUES ('new-turn','admission','session','workspace','incarnation')",
  ).run();
  db.prepare(
    "INSERT INTO chat_session_mutation_admissions VALUES ('admission','active','turn_write','new-turn','session','workspace','incarnation',?,2,3)",
  ).run("f".repeat(64));
}

describe("context snapshot admission migration", () => {
  it("preserves every historical column byte-for-byte and keeps immutable guards", () => {
    const { db, row } = fixture();
    try {
      const saved = {
        ...db.prepare("SELECT * FROM chat_routed_context_snapshots WHERE snapshot_id='old-snapshot'").get(),
      };
      for (const [key, value] of Object.entries(row)) assert.equal(saved[key], value, key);
      for (const key of [
        "admission_id",
        "session_incarnation_id",
        "admission_material_sha256",
        "admission_aggregate_revision",
        "admission_controller_generation",
      ])
        assert.equal(saved[key], null);
      assert.throws(() => db.exec("UPDATE chat_routed_context_snapshots SET snapshot_json='{}'"), /immutable/u);
      assert.throws(() => db.exec("DELETE FROM chat_routed_context_snapshots"), /immutable/u);
      assert.throws(
        () =>
          insert(db, {
            ...row,
            snapshot_id: "other",
            turn_id: "other-turn",
            snapshot_hash: "e".repeat(64),
            capability_profile_id: "other-profile",
          }),
        /incarnation-bound/u,
      );
    } finally {
      db.close();
    }
  });

  it("admits v3 only with an exact active incarnation-bound turn and a complete authority union", () => {
    const { db } = fixture();
    try {
      assert.throws(() => insert(db, newRow()), /incarnation-bound/u);
      admit(db);
      for (const patch of [
        { admission_id: null },
        { session_incarnation_id: "other" },
        { admission_material_sha256: "a".repeat(64) },
        { admission_aggregate_revision: 1 },
        { admission_controller_generation: 4 },
        { capability_profile_id: "mixed" },
        { schema_version: "chat.routed-context-snapshot.v2" },
        { admission_aggregate_revision: 2.5 },
      ])
        assert.throws(() => insert(db, { ...newRow(), ...patch }));
      db.exec("UPDATE chat_session_mutation_admissions SET status='cancelled'");
      assert.throws(() => insert(db, newRow()), /incarnation-bound/u);
      db.exec("UPDATE chat_session_mutation_admissions SET status='active'");
      insert(db, newRow());
      assert.equal(
        db
          .prepare("SELECT capability_profile_id FROM chat_routed_context_snapshots WHERE snapshot_id='new-snapshot'")
          .get()?.capability_profile_id,
        null,
      );
    } finally {
      db.close();
    }
  });

  it("pairs PostgreSQL nullable profile evidence with the same admission checks without rewriting old content", () => {
    const sql = CHAT_ROUTED_CONTEXT_ADMISSION_POSTGRES_SQL;
    assert.match(sql, /ALTER COLUMN capability_profile_id DROP NOT NULL/u);
    assert.match(sql, /admission_id TEXT UNIQUE/u);
    assert.match(sql, /schema_version = 'chat.routed-context-snapshot.v3'/u);
    assert.match(sql, /admission.material_sha256 = NEW.admission_material_sha256/u);
    assert.match(sql, /pg_advisory_xact_lock/u);
    assert.doesNotMatch(sql, /UPDATE chat_routed_context_snapshots|DELETE FROM chat_routed_context_snapshots/u);
  });
});
