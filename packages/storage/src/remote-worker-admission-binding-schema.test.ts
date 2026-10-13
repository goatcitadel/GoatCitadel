import assert from "node:assert/strict";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { upgradeRemoteWorkerAdmissionBindingSchema } from "./remote-worker-admission-binding-schema.js";

it("preserves historical bytes and dependent evidence while widening only the capability authority variant", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE remote_worker_chat_contexts(id TEXT PRIMARY KEY, capability_profile_id TEXT NOT NULL,
        capability_profile_sha256 TEXT NOT NULL, context_json TEXT NOT NULL);
      CREATE TABLE remote_worker_inference_requests(id TEXT PRIMARY KEY, capability_profile_sha256 TEXT NOT NULL,
        request_body_json TEXT NOT NULL);
      CREATE TABLE remote_worker_cells(id TEXT PRIMARY KEY, capability_profile_sha256 TEXT NOT NULL, frozen_json TEXT NOT NULL);
      CREATE TABLE child_evidence(id TEXT PRIMARY KEY, cell_id TEXT NOT NULL REFERENCES remote_worker_cells(id) ON DELETE RESTRICT,
        evidence_json TEXT NOT NULL);
      CREATE TABLE child_receipt(id TEXT PRIMARY KEY, evidence_id TEXT NOT NULL REFERENCES child_evidence(id) ON DELETE RESTRICT);
      CREATE INDEX child_evidence_owner ON child_evidence(cell_id);
      CREATE TRIGGER child_evidence_immutable BEFORE UPDATE ON child_evidence BEGIN SELECT RAISE(ABORT, 'immutable evidence'); END;
      INSERT INTO remote_worker_chat_contexts VALUES('context', 'profile', '${"a".repeat(64)}', '{ "retained" : true }');
      INSERT INTO remote_worker_inference_requests VALUES('inference', '${"a".repeat(64)}', '{ "retained" : true }');
      INSERT INTO remote_worker_cells VALUES('cell', '${"a".repeat(64)}', '{ "retained" : true }');
      INSERT INTO child_evidence VALUES('evidence', 'cell', '{ "retained" : true }');
      INSERT INTO child_receipt VALUES('receipt', 'evidence');`);
    const before = db.prepare("SELECT * FROM child_evidence").all();
    upgradeRemoteWorkerAdmissionBindingSchema(db);
    assert.deepEqual(db.prepare("SELECT * FROM child_evidence").all(), before);
    assert.equal(
      (db.prepare("SELECT context_json FROM remote_worker_chat_contexts").get() as { context_json: string })
        .context_json,
      '{ "retained" : true }',
    );
    assert.throws(() => db.prepare("UPDATE child_evidence SET evidence_json = '{}'").run(), /immutable/u);
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO remote_worker_cells(id, capability_profile_sha256, frozen_json) VALUES('missing', NULL, '{}')",
          )
          .run(),
      /CHECK/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO remote_worker_cells(id, capability_profile_sha256, frozen_json, admission_reference_json) VALUES('mixed', ?, '{}', ?)",
          )
          .run("a".repeat(64), JSON.stringify({ version: "goatcitadel.remote-worker-admission-reference.v1" })),
      /CHECK/u,
    );
    db.prepare(
      "INSERT INTO remote_worker_cells(id, capability_profile_sha256, frozen_json, admission_reference_json) VALUES('admitted', NULL, '{}', ?)",
    ).run(JSON.stringify({ version: "goatcitadel.remote-worker-admission-reference.v1" }));
    assert.throws(
      () => db.prepare("UPDATE remote_worker_cells SET admission_reference_json = '{}' WHERE id = 'admitted'").run(),
      /immutable/u,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
