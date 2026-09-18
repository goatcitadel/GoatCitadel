import assert from "node:assert/strict";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { addRemoteWorkerRuntimeApprovalSchema } from "./remote-worker-runtime-approval-schema.js";

it("adds nullable approval custody without promoting existing expectation rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE approvals (approval_id TEXT PRIMARY KEY);
      CREATE TABLE remote_worker_runtime_expectations (nonce TEXT PRIMARY KEY, expectation_json TEXT NOT NULL);
      INSERT INTO remote_worker_runtime_expectations VALUES ('legacy', '{"retained":true}');
      INSERT INTO approvals VALUES ('approved-request');`);
    addRemoteWorkerRuntimeApprovalSchema(db);
    assert.deepEqual({ ...db.prepare("SELECT * FROM remote_worker_runtime_expectations WHERE nonce = 'legacy'").get() },
      { nonce: "legacy", expectation_json: '{"retained":true}', approval_id: null });
    const insert = db.prepare("INSERT INTO remote_worker_runtime_expectations VALUES (?, '{}', ?)");
    insert.run("bound", "approved-request");
    insert.run("unassociated", null);
    for (const invalid of ["", " approved-request", "approved-request ", "missing-approval", "a".repeat(201)])
      assert.throws(() => insert.run(`invalid:${invalid}`, invalid));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM remote_worker_runtime_expectations").get()!.count, 3);
  } finally { db.close(); }
});
