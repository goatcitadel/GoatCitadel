import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  GOVERNED_REMEDIATION_PARENT_RESERVATION_SQLITE_SQL,
  GOVERNED_REMEDIATION_PARENT_RESERVATION_POSTGRES_SQL,
} from "./governed-remediation-parent-reservation-schema.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { assertPostgresMigrationIntegrity } from "./postgres/migrator.js";

describe("governed remediation parent reservation ledger", () => {
  it("keeps bounded immutable evidence, unique retry/run-version bindings, and transaction rollback", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE governed_remediation_states (remediation_id TEXT PRIMARY KEY);
        CREATE TABLE durable_runs (run_id TEXT PRIMARY KEY);
        CREATE TABLE durable_checkpoints (checkpoint_id TEXT PRIMARY KEY);
        INSERT INTO governed_remediation_states VALUES ('repair-1'), ('repair-2');
        INSERT INTO durable_runs VALUES ('run-1');
        INSERT INTO durable_checkpoints VALUES ('checkpoint-1');`);
      db.exec(GOVERNED_REMEDIATION_PARENT_RESERVATION_SQLITE_SQL);
      const fields = {
        reservation_id: "reservation-1", remediation_id: "repair-1", durable_run_id: "run-1",
        blocked_checkpoint_id: "checkpoint-1", requester_actor_id: "actor-1", workspace_id: "workspace-1",
        state_revision: 2, waiting_run_version: 5, reserved_run_version: 6,
        recipe_sha256: "a".repeat(64), effect_id: "effect-1", expected_owner_revision: "owner-1",
        pre_effect_approval_id: "approval-1", prompt_id: null, operation_id: "operation-1",
        idempotency_key: "retry-1", request_sha256: "b".repeat(64), reserved_at: "2026-09-15T12:00:00.000Z",
      };
      const columns = Object.keys(fields);
      const insert = db.prepare(`INSERT INTO governed_remediation_parent_reservations
        (${columns.join(", ")}) VALUES (${columns.map((column) => `@${column}`).join(", ")})`);
      insert.run(fields);
      assert.throws(() => insert.run(fields), /UNIQUE/u);
      const next = { ...fields, reservation_id: "reservation-2", remediation_id: "repair-2", idempotency_key: "retry-2" };
      assert.throws(() => insert.run(next), /UNIQUE/u);
      const nextVersion = { ...next, waiting_run_version: 6, reserved_run_version: 7 };
      assert.throws(() => insert.run({ ...nextVersion, reservation_id: null }), /NOT NULL/u);
      assert.throws(() => insert.run({ ...nextVersion, idempotency_key: fields.idempotency_key }), /UNIQUE/u);
      assert.throws(() => insert.run({ ...nextVersion, reserved_run_version: 8 }), /CHECK/u);
      assert.throws(() => insert.run({ ...nextVersion, state_revision: 2.5 }), /integers/u);
      assert.throws(() => insert.run({ ...nextVersion, waiting_run_version: 6.5, reserved_run_version: 7.5 }), /integers/u);
      assert.throws(() => insert.run({ ...nextVersion, recipe_sha256: "bad" }), /CHECK/u);
      assert.throws(() => insert.run({ ...nextVersion, requester_actor_id: "" }), /CHECK/u);
      assert.throws(() => insert.run({ ...nextVersion, blocked_checkpoint_id: "missing" }), /FOREIGN KEY/u);
      assert.throws(() => db.exec("UPDATE governed_remediation_parent_reservations SET effect_id = 'changed'"), /immutable/u);
      assert.throws(() => db.exec("DELETE FROM governed_remediation_parent_reservations"), /cannot be deleted/u);
      db.exec("BEGIN IMMEDIATE");
      insert.run(nextVersion);
      db.exec("ROLLBACK");
      assert.equal(db.prepare("SELECT count(*) AS count FROM governed_remediation_parent_reservations").get()?.count, 1);
    } finally {
      db.close();
    }
  });

  it("registers the paired PostgreSQL migration with its executable integrity digest", () => {
    const migration = POSTGRES_MIGRATIONS.find((entry) => entry.version === 188);
    assert.ok(migration);
    assert.equal(migration.name, "governed_remediation_parent_reservations");
    assert.equal(migration.sql, GOVERNED_REMEDIATION_PARENT_RESERVATION_POSTGRES_SQL);
    assertPostgresMigrationIntegrity(migration);
  });
});
