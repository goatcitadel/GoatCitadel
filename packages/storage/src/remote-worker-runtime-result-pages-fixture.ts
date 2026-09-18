import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readRemoteWorkerRuntimeResult } from "@goatcitadel/contracts";
import { objectInventoryFixture } from "../../contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { verifyRuntimeResultRetention } from "./remote-worker-runtime-result-fixture.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";

export const verifyRuntimeResultPages: typeof verifyRuntimeResultRetention = (db, key, token, fence, revoke) => {
  verifyRuntimeResultRetention(db, key, token, fence, revoke, (current, history) => {
    const repo = new RemoteWorkerRuntimeResultRepository(db), cells = new RemoteWorkerCellRepository(db), clock = new DurableRunRepository(db);
    const original = cells.getCell(key), evidence = cells.listEvidenceAfter(key, 0), digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const { summary, chunks } = objectInventoryFixture(history, 19996);
    const expectation = { nonce: summary.subarray(0, 32).toString("hex"), requestSha256: digest("authorized-request"),
      checkpointSha256: summary.subarray(152, 184).toString("hex"), runtimeBundleSha256: digest("planned-runtime"),
      maxInputBytes: 100, maxOutputBytes: 100000, maxInventoryEntries: 20000 };
    const header = Buffer.alloc(256); header.write("GCRRS001");
    for (const [offset, value] of [[8, expectation.nonce], [40, expectation.requestSha256], [72, expectation.checkpointSha256], [184, expectation.runtimeBundleSha256]] as const)
      Buffer.from(value, "hex").copy(header, offset);
    header.writeUInt32LE(0x1fef, 104); header.writeUInt32LE(23, 116); header.writeUInt32LE(777, 120); header.writeUInt32LE(20000, 216);
    const bytes = Buffer.concat([header, summary, ...chunks]), resultHex = bytes.toString("hex"), decoded = readRemoteWorkerRuntimeResult(resultHex, expectation, history);
    const page = (offset = 0) => ({ ...current, submission: { kind: "runtime.result.page" as const, nonce: expectation.nonce,
      requestSha256: expectation.requestSha256, resultSha256: decoded.resultSha256, byteLength: bytes.length, offset, bytesHex: bytes.subarray(offset, offset + 32768).toString("hex") } });
    const lookup = { ...current, submission: { kind: "runtime.result.lookup" as const, nonce: expectation.nonce, requestSha256: expectation.requestSha256 } };
    const count = () => db.prepare("SELECT COUNT(*) AS count FROM remote_worker_runtime_result_staging WHERE assignment_id = @assignmentId")
      .get<{ count: number }>({ assignmentId: key.assignmentId })!.count;
    assert.equal(repo.exchangePageForAssignment(lookup).record, null); assert.equal(count(), 0);
    assert.throws(() => repo.exchangePageForAssignment(page(32768))); assert.equal(count(), 0);
    const first = repo.exchangePageForAssignment(page()); assert.equal(first.record, null); assert.equal(first.accepted?.nextOffset, 32768);
    assert.equal(count(), 1); assert.deepEqual(new RemoteWorkerRuntimeResultRepository(db).exchangePageForAssignment(page()), first);
    for (const changes of [{ nonce: digest("foreign") }, { requestSha256: digest("foreign") }, { resultSha256: digest("foreign") },
      { byteLength: 999608 }, { bytesHex: "f" + page().submission.bytesHex.slice(1) }]) {
      assert.throws(() => repo.exchangePageForAssignment({ ...page(), submission: { ...page().submission, ...changes } }));
    }
    const parentId = new RemoteWorkerAssignmentRepository(db).resolveActiveAuthorityByLeaseTokenHash(current.leaseTokenSha256, fence)!.assignment.manifest.durableRunId;
    const prepare = db.prepare.bind(db); let intercepted = false;
    db.prepare = sql => {
      const statement = prepare(sql);
      if (/^INSERT INTO remote_worker_runtime_result_staging/u.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = params => {
          const result = run(params), parent = clock.getRun(parentId); intercepted = true;
          clock.updateRun({ runId: parentId, status: "cancelled", clearLease: true, expectedVersion: parent.version }); return result;
        };
      }
      return statement;
    };
    try { assert.throws(() => repo.exchangePageForAssignment(page(32768))); } finally { db.prepare = prepare; }
    assert.equal(intercepted, true); assert.deepEqual(repo.exchangePageForAssignment(page()), first);
    cells.transitionExecution({ ...key, expectedRevision: original!.executionRevision, toState: "running", detailSha256: digest("running"), now: clock.readDatabaseNow() });
    assert.throws(() => repo.exchangePageForAssignment(page(32768)), "execution revision changes require restarting page staging");
    repo.exchangePageForAssignment(page());
    for (let offset = 32768; offset < bytes.length; offset += 32768) {
      const result = repo.exchangePageForAssignment(page(offset));
      assert.equal(result.accepted?.nextOffset, Math.min(bytes.length, offset + 32768));
      assert.equal(result.record !== null, offset + 32768 >= bytes.length);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 256 * 1024);
    }
    assert.equal(count(), 0);
    const record = repo.exchangePageForAssignment(lookup).record; assert.equal(record?.resultSha256, decoded.resultSha256);
    const replay = repo.exchangePageForAssignment(page()); assert.deepEqual(replay.record, record); assert.equal(replay.accepted?.nextOffset, bytes.length);
    const changed = page(); changed.submission.bytesHex = "f" + changed.submission.bytesHex.slice(1);
    assert.throws(() => repo.exchangePageForAssignment(changed));
    assert.equal(repo.findForAssignment({ ...current, nonce: expectation.nonce })?.result.inventory?.entries.length, 20000);
    assert.equal(JSON.stringify(replay).includes(current.leaseTokenSha256), false); assert.equal(JSON.stringify(replay).includes("protectedAuthority"), false);
    const after = cells.getCell(key); assert.equal(after?.executionState, "running");
    assert.equal(cells.listEvidenceAfter(key, 0).length, evidence.length + 1);
    return () => {
      assert.throws(() => repo.exchangePageForAssignment(page())); assert.throws(() => repo.exchangePageForAssignment(lookup));
      assert.deepEqual(cells.getCell(key), after); assert.equal(count(), 0);
    };
  });
};
