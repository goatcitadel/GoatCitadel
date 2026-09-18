import assert from "node:assert/strict";
import { RemoteWorkerNativePoolRepository } from "./remote-worker-native-pool-repo.js";
import { createHash } from "node:crypto";
import { objectInventoryFixture } from "../../contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";

/** Real isolated database authority with controlled native history. No OS
 * readiness, provider, service, disk attach or formatting is exercised here. */
export const verifyRuntimeResultRetention: typeof verifyCellProvisioningExchange = (db, key, token, fence, revoke, afterExpectation) => {
  verifyCellProvisioningExchange(db, key, token, fence, revoke, (current, history) => {
    const repo = new RemoteWorkerRuntimeResultRepository(db), cells = new RemoteWorkerCellRepository(db), clock = new DurableRunRepository(db);
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const { summary, chunks } = objectInventoryFixture(history);
    const expectation = { nonce: summary.subarray(0, 32).toString("hex"), requestSha256: digest("authorized-request"),
      checkpointSha256: summary.subarray(152, 184).toString("hex"), runtimeBundleSha256: digest("planned-runtime"),
      maxInputBytes: 100, maxOutputBytes: 100000, maxInventoryEntries: 20000 };
    const header = Buffer.alloc(256); header.write("GCRRS001");
    for (const [offset, value] of [[8, expectation.nonce], [40, expectation.requestSha256], [72, expectation.checkpointSha256], [184, expectation.runtimeBundleSha256]] as const)
      Buffer.from(value, "hex").copy(header, offset);
    header.writeUInt32LE(0x1fef, 104); header.writeUInt32LE(23, 116); header.writeUInt32LE(777, 120); header.writeUInt32LE(26, 216);
    const resultHex = Buffer.concat([header, summary, ...chunks]).toString("hex");
    const submit = { ...current, nonce: expectation.nonce, resultHex }, lookup = { ...current, nonce: expectation.nonce };
    assert.throws(() => repo.retainForAssignment(submit)); assert.throws(() => repo.findForAssignment(lookup));
    const admit = () => ({ ...current, expectation, expectedExecutionRevision: cells.getCell(key)!.executionRevision });
    assert.throws(() => repo.retainExpectationForAssignment(admit()));
    const cell = cells.getCell(key)!, suffix = digest(key.assignmentId).slice(0, 32);
    cells.persistPlatformIdentity({ ...key, provisioningOwner: cell.provisioningOwner!, provisioningLeaseExpiresAt: cell.provisioningLeaseExpiresAt!,
      platformIdentity: { schemaVersion: "goatcitadel.remote-worker-cell-platform.v2", backend: "windows_native",
        jobName: `gc-cell-${suffix}`, appContainerName: `GoatCitadel.Worker.${suffix}`, volumeIdentitySha256: digest("planned-volume"),
        runtimeBundleSha256: expectation.runtimeBundleSha256, launcherSha256: digest("planned-launcher"), networkPolicy: "deny_all" },
      detailSha256: digest("controlled-platform"), now: clock.readDatabaseNow() });
    assert.throws(() => repo.retainExpectationForAssignment(admit()));
    cells.transitionExecution({ ...key, expectedRevision: cells.getCell(key)!.executionRevision, toState: "starting", detailSha256: digest("start"), now: clock.readDatabaseNow() });
    const original = cells.getCell(key), evidence = cells.listEvidenceAfter(key, 0), admission = admit();
    for (const patch of [{ assignmentId: "foreign" }, { assignmentGeneration: 999 }, { leaseRevision: 999 }, { leaseTokenSha256: "f".repeat(64) },
      { protectedAuthority: undefined }, { protectedAuthority: { ...fence, credentialAuthority: { ...fence.credentialAuthority, credentialGeneration: 999 } } }]) {
      assert.throws(() => repo.retainExpectationForAssignment({ ...admission, ...patch } as typeof admission));
      assert.throws(() => repo.retainForAssignment({ ...submit, ...patch } as typeof submit));
    }
    assert.throws(() => repo.retainExpectationForAssignment({ ...admission, expectation: { ...expectation, runtimeBundleSha256: digest("foreign") } }));
    assert.deepEqual(repo.retainExpectationForAssignment(admission), expectation);
    assert.deepEqual(repo.retainExpectationForAssignment(admission), expectation);
    const cleanup = repo.readCleanupExpectationsForAssignment(current);
    assert.deepEqual(cleanup, { history, expectations: [expectation] });
    assert.deepEqual(new RemoteWorkerRuntimeResultRepository(db).readCleanupExpectationsForAssignment(current), cleanup,
      "cleanup metadata survives repository reconstruction without executable review context");
    assert.equal(JSON.stringify(cleanup).includes("standardInput"), false);
    const pool = new RemoteWorkerNativePoolRepository(db);
    assert.deepEqual(pool.readCleanupForAssignment(current).members[0]!.expectations, [expectation]);
    assert.deepEqual(repo.readRetainedCleanupForPool(key, pool.readSnapshotForAssignment(current).members[0]!.history), [expectation]);
    assert.throws(() => repo.readRetainedCleanupForPool(key, null), "Retained attempts cannot disappear behind missing history");
    const rollbackPool = new Error("rollback controlled pool expectation corruption");
    assert.throws(() => db.transaction("immediate", () => {
      // Add a corrupt test row inside a rolled-back fixture transaction. Keep
      // the immutable-row triggers intact rather than editing retained evidence.
      db.prepare(`INSERT INTO remote_worker_runtime_expectations
        (registry_workspace_id, assignment_id, assignment_generation, nonce, expectation_json, plan_sha256,
         execution_revision, cleanup_revision, lease_revision, recorded_at)
        SELECT registry_workspace_id, assignment_id, assignment_generation, @nonce, expectation_json, @foreign,
         execution_revision + 1, cleanup_revision, lease_revision, recorded_at
        FROM remote_worker_runtime_expectations
        WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration`)
        .run({ ...key, nonce: digest("corrupt-pool-attempt"), foreign: digest("foreign-pool-plan") });
      assert.throws(() => pool.readCleanupForAssignment(current), "One corrupt retained attempt refuses the entire pool");
      throw rollbackPool;
    }), error => error === rollbackPool);
    assert.deepEqual(pool.readCleanupForAssignment(current).members[0]!.expectations, [expectation]);
    assert.throws(() => repo.readCleanupExpectationsForAssignment({ ...current, leaseRevision: current.leaseRevision + 1 }));
    assert.throws(() => repo.readCleanupExpectationsForAssignment({ ...current, protectedAuthority: undefined } as unknown as typeof current));
    for (const phase of ["execution", "delivery"] as const)
      assert.throws(() => repo.authorizeForAssignment({ ...current, nonce: expectation.nonce, requestSha256: expectation.requestSha256, phase }),
        "legacy expectations without an admitting approval never grant runtime authority");
    assert.equal(repo.findForAssignment(lookup), null);
    assert.throws(() => repo.retainExpectationForAssignment({ ...admission, expectation: { ...expectation, requestSha256: digest("substituted") } }));
    assert.throws(() => repo.retainExpectationForAssignment({ ...admission, expectation: { ...expectation, nonce: digest("second") } }));
    if (afterExpectation) return afterExpectation(current, history);
    const changed = Buffer.from(resultHex, "hex"); changed[40] = changed[40]! ^ 1;
    assert.throws(() => repo.retainForAssignment({ ...submit, resultHex: changed.toString("hex") }));
    const parentId = new RemoteWorkerAssignmentRepository(db).resolveActiveAuthorityByLeaseTokenHash(current.leaseTokenSha256, fence)!.assignment.manifest.durableRunId;
    const prepare = db.prepare.bind(db); let intercepted = false;
    db.prepare = sql => {
      const statement = prepare(sql);
      if (/^INSERT INTO remote_worker_runtime_results/u.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = params => {
          const result = run(params), parent = clock.getRun(parentId); intercepted = true;
          clock.updateRun({ runId: parentId, status: "cancelled", clearLease: true, expectedVersion: parent.version }); return result;
        };
      }
      return statement;
    };
    try { assert.throws(() => repo.retainForAssignment(submit)); } finally { db.prepare = prepare; }
    assert.equal(intercepted, true); assert.equal(repo.findForAssignment(lookup), null); assert.notEqual(clock.getRun(parentId).status, "cancelled");
    assert.deepEqual(cells.getCell(key), original); assert.deepEqual(cells.listEvidenceAfter(key, 0), evidence);
    cells.transitionExecution({ ...key, expectedRevision: original!.executionRevision, toState: "running", detailSha256: digest("running"), now: clock.readDatabaseNow() });
    const retained = repo.retainForAssignment(submit);
    assert.equal(retained.result.exitCode, 23); assert.equal(retained.result.inventory?.entries.length, 26);
    assert.deepEqual(repo.findForAssignment(lookup), retained); assert.deepEqual(repo.retainForAssignment(submit), retained);
    changed.set(Buffer.from(resultHex, "hex")); changed.writeUInt32LE(24, 116);
    assert.throws(() => repo.retainForAssignment({ ...submit, resultHex: changed.toString("hex") }));
    for (const table of ["remote_worker_runtime_results", "remote_worker_runtime_expectations"]) {
      assert.throws(() => db.prepare(`UPDATE ${table} SET nonce = nonce WHERE assignment_id = @assignmentId`).run({ assignmentId: key.assignmentId }), /immutable/u);
      assert.throws(() => db.prepare(`DELETE FROM ${table} WHERE assignment_id = @assignmentId`).run({ assignmentId: key.assignmentId }), /retained/u);
    }
    cells.transitionExecution({ ...key, expectedRevision: cells.getCell(key)!.executionRevision, toState: "exited", detailSha256: digest("exited"), now: clock.readDatabaseNow() });
    // Exact committed metadata remains recoverable after canonical completion.
    assert.deepEqual(repo.findForAssignment(lookup), retained); assert.deepEqual(repo.retainForAssignment(submit), retained);
    assert.deepEqual(repo.readCleanupExpectationsForAssignment(current), cleanup);
    const final = cells.getCell(key);
    return () => {
      assert.throws(() => repo.findForAssignment(lookup)); assert.throws(() => repo.retainForAssignment(submit));
      assert.throws(() => repo.readCleanupExpectationsForAssignment(current));
      assert.throws(() => pool.readCleanupForAssignment(current));
      assert.throws(() => repo.retainExpectationForAssignment(admission)); assert.deepEqual(cells.getCell(key), final);
    };
  });
};
