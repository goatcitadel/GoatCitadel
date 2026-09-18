import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { GOVERNED_REMEDIATION_PARENT_RESOLUTION_SQLITE_SQL } from "./governed-remediation-parent-resolution-schema.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { assertPostgresMigrationIntegrity } from "./postgres/migrator.js";

test("remediation parent resolution retains one immutable evidence-bound outcome per reservation", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE governed_remediation_parent_reservations (reservation_id TEXT PRIMARY KEY);
      CREATE TABLE governed_remediation_receipts (receipt_id TEXT PRIMARY KEY);
      CREATE TABLE governed_remediation_failures (failure_id TEXT PRIMARY KEY);
      INSERT INTO governed_remediation_parent_reservations VALUES ('parent-1'), ('parent-2');
      INSERT INTO governed_remediation_receipts VALUES ('verification-1');
      INSERT INTO governed_remediation_failures VALUES ('no-effect-1');`);
    db.exec(GOVERNED_REMEDIATION_PARENT_RESOLUTION_SQLITE_SQL);
    const row = {
      resolution_id: "resolution-1", reservation_id: "parent-1", resolution_kind: "resumed",
      receipt_id: "verification-1", failure_id: null, previous_run_version: 3, resulting_run_version: 4,
      operation_id: "resume-1", idempotency_key: "retry-1", request_sha256: "a".repeat(64),
      resolved_at: "2026-09-15T17:00:00.000Z",
    };
    const columns = Object.keys(row);
    const insert = db.prepare(`INSERT INTO governed_remediation_parent_resolutions (${columns.join(",")})
      VALUES (${columns.map((column) => `@${column}`).join(",")})`);
    for (const change of [
      { resolution_id: null }, { receipt_id: null }, { failure_id: "no-effect-1" },
      { reservation_id: "missing" }, { receipt_id: "missing" }, { resolution_kind: "unknown" },
      { previous_run_version: 3.5, resulting_run_version: 4.5 }, { resulting_run_version: 5 },
      { request_sha256: "bad" },
    ]) assert.throws(() => insert.run({ ...row, ...change }));
    insert.run(row);
    assert.throws(() => insert.run({ ...row, resolution_id: "duplicate", idempotency_key: "duplicate" }), /UNIQUE/u);
    assert.throws(() => db.exec("UPDATE governed_remediation_parent_resolutions SET resulting_run_version = 9"), /immutable/u);
    assert.throws(() => db.exec("DELETE FROM governed_remediation_parent_resolutions"), /cannot be deleted/u);
    db.exec("BEGIN IMMEDIATE");
    insert.run({ ...row, resolution_id: "release-2", reservation_id: "parent-2", resolution_kind: "released",
      receipt_id: null, failure_id: "no-effect-1", idempotency_key: "release-2" });
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT count(*) AS count FROM governed_remediation_parent_resolutions").get()?.count, 1);
  } finally { db.close(); }
});

test("remediation parent resolution PostgreSQL migration has executable integrity", () => {
  const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 190);
  assert.ok(migration);
  assert.equal(migration.name, "governed_remediation_parent_resolutions");
  assertPostgresMigrationIntegrity(migration);
});
