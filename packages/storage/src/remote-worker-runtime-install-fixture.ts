import assert from "node:assert/strict";
import { RemoteWorkerNativePoolRepository } from "./remote-worker-native-pool-repo.js";
import { createHash } from "node:crypto";
import { canonicalJsonString, hashRemoteWorkerControllerPublicKey, REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION,
  readRemoteWorkerCellProvisioningCheckpoint, remoteWorkerRuntimeInstallRequestSha256 } from "@goatcitadel/contracts";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";
import { RemoteWorkerRuntimeInstallRepository } from "./remote-worker-runtime-install-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { ApprovalRepository } from "./approval-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";

/** Shared real SQLite/PostgreSQL fences; native journal/outcome bytes are
 * controlled fixtures. No installed platform or readiness is manufactured. */
export const verifyRuntimeInstallRetention: typeof verifyCellProvisioningExchange = (db, key, token, fence, revoke) => {
  verifyCellProvisioningExchange(db, key, token, fence, revoke, (current, history) => {
    const repo = new RemoteWorkerRuntimeInstallRepository(db), cells = new RemoteWorkerCellRepository(db), approvals = new ApprovalRepository(db);
    const first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
    const request = { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, nonce: "18".repeat(32), journalIdentityHex: first.journalIdentityHex,
      preparedSha256: first.recordSha256, checkpointSha256: history.mountedWorkspaceRecords![1]!.slice(-64), packageSha256: "55".repeat(32),
      runtimeBundle: { schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: [
        { relativePath: "node.exe", bytes: 100, sha256: "66".repeat(32) },
        { relativePath: "worker-host-receipt.json", bytes: 20, sha256: "77".repeat(32) },
      ] } };
    const manifest = new RemoteWorkerAssignmentRepository(db).resolveActiveAuthorityByLeaseTokenHash(current.leaseTokenSha256, fence)!.assignment.manifest;
    const before = cells.getCell(key)!, revisions = { expectedExecutionRevision: before.executionRevision, expectedCleanupRevision: before.cleanupRevision,
      expectedCapacityRevision: before.capacityRevision, expectedBackupRevision: before.backupRevision };
    const publicPointHex = `04${"12".repeat(64)}`;
    const controllerEnrollment = { publicPointHex, keySha256: hashRemoteWorkerControllerPublicKey(publicPointHex) };
    const review = { kind: "remote_worker.native_runtime_install", riskLevel: "danger" as const,
      payload: { controllerEnrollment, nativeRuntimeInstall: { schemaVersion: "goatcitadel.native-runtime-install-approval.v1", ...key, profileSha256: before.profileSha256, request, ...revisions } },
      preview: { title: "Install reviewed runtime package" }, linkage: { workspaceId: manifest.executionWorkspaceId, taskId: manifest.taskId,
        durableRunId: manifest.durableRunId, sessionId: manifest.sessionId, turnId: manifest.turnId, actionType: "remote_worker.native_runtime_install" } };
    const approval = approvals.createWithTtlDuration(review, 300000), input = { ...current, request, approvalId: approval.approvalId, ...revisions };
    assert.throws(() => repo.retainRequestForAssignment(input));
    assert.throws(() => repo.validatePendingReviewForAssignment(input), "Pending approval requires complete capacity evidence");
    assert.throws(() => approvals.resolve(approval.approvalId, { decision: "edit", editedPayload: {}, resolvedBy: "fixture" }));
    assert.throws(() => approvals.mergeLinkage(approval.approvalId, { taskId: "foreign" }));
    approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "fixture" });
    const counts = () => ["remote_worker_runtime_install_requests", "remote_worker_runtime_install_outcomes"]
      .map(table => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number | string }>()!.count));
    const initial = counts();
    assert.throws(() => repo.prepareRequestForAssignment({ ...current, packageSha256: request.packageSha256, runtimeBundle: request.runtimeBundle }),
      "Installation review cannot be prepared without a complete capacity capture");
    const selection = { ...current, submission: { kind: "runtime.install.select" as const, challenge: "ab".repeat(32) } };
    assert.equal(repo.selectForAssignment(selection).request, null, "Selection cannot create a reviewed request");
    assert.deepEqual(counts(), initial);
    const reviewSelection = { ...current, nonce: request.nonce, requestSha256: remoteWorkerRuntimeInstallRequestSha256(request) };
    assert.throws(() => repo.validateReviewForAssignment(reviewSelection), "Review lookup cannot create a request");
    for (const patch of [{ assignmentGeneration: 999 }, { leaseRevision: 999 }, { leaseTokenSha256: "f".repeat(64) },
      { protectedAuthority: undefined }, { request: { ...request, packageSha256: "88".repeat(32) } }, { expectedExecutionRevision: 999 }])
      assert.throws(() => repo.retainRequestForAssignment({ ...input, ...patch } as typeof input));
    assert.deepEqual(counts(), initial);
    assert.deepEqual(repo.retainRequestForAssignment(input), request); assert.deepEqual(repo.retainRequestForAssignment(input), request);
    const pool = new RemoteWorkerNativePoolRepository(db);
    assert.deepEqual(pool.readCleanupForAssignment(current).members[0]!.installation, request);
    assert.deepEqual(repo.readRetainedCleanupForPool(key, pool.readSnapshotForAssignment(current).members[0]!.history), request);
    assert.throws(() => repo.readRetainedCleanupForPool(key, null), "Retained installation cannot disappear behind missing history");
    assert.deepEqual(repo.validateReviewForAssignment(reviewSelection), request);
    assert.deepEqual(repo.readControllerEnrollmentForAssignment(reviewSelection), controllerEnrollment);
    for (const patch of [{ leaseRevision: 999 }, { protectedAuthority: undefined }, { requestSha256: "ff".repeat(32) }])
      assert.throws(() => repo.readControllerEnrollmentForAssignment({ ...reviewSelection, ...patch } as typeof reviewSelection));
    assert.deepEqual(repo.selectForAssignment(selection), { schemaVersion: "goatcitadel.remote-worker-runtime-install-selection.v1",
      challenge: selection.submission.challenge, history, request });
    for (const patch of [{ leaseRevision: 999 }, { protectedAuthority: undefined }])
      assert.throws(() => repo.selectForAssignment({ ...selection, ...patch } as typeof selection));
    assert.throws(() => repo.readAdmissionMaterialForAssignment(reviewSelection), "An approved request without complete capacity evidence cannot supply admission material");
    for (const patch of [{ nonce: "ff".repeat(32) }, { requestSha256: "ff".repeat(32) }, { leaseRevision: 999 }, { protectedAuthority: undefined }])
      assert.throws(() => repo.validateReviewForAssignment({ ...reviewSelection, ...patch } as typeof reviewSelection));
    // Only this isolated fixture's approval is changed, inside a transaction
    // that is always rolled back. Retained evidence cannot substitute for a
    // current unexpired decision, even after the request was already admitted.
    const rollbackReview = new Error("rollback controlled review change");
    for (const update of ["expires_at = '2000-01-01T00:00:00.000Z'", "status = 'rejected'"]) {
      assert.throws(() => db.transaction("immediate", () => {
        db.prepare(`UPDATE approvals SET ${update} WHERE approval_id = @approvalId`).run({ approvalId: approval.approvalId });
        assert.throws(() => repo.validateReviewForAssignment(reviewSelection));
        assert.deepEqual(repo.selectForAssignment(selection).request, request, "Expired or revoked copy approval does not erase recovery evidence");
        assert.deepEqual(pool.readCleanupForAssignment(current).members[0]!.installation, request,
          "Historical pool coverage retains attempts after copy approval expires or is rejected");
        throw rollbackReview;
      }), error => error === rollbackReview);
      assert.deepEqual(repo.validateReviewForAssignment(reviewSelection), request);
    }
    for (const update of ["execution_state = 'profiled', execution_revision = execution_revision + 1",
      "cleanup_state = 'pending', cleanup_revision = cleanup_revision + 1", "capacity_revision = capacity_revision + 1",
      "backup_state = 'pending', backup_revision = backup_revision + 1"]) {
      assert.throws(() => db.transaction("immediate", () => {
        db.prepare(`UPDATE remote_worker_cells SET ${update}
          WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration`).run(key);
        assert.throws(() => repo.validateReviewForAssignment(reviewSelection));
        throw rollbackReview;
      }), error => error === rollbackReview);
      assert.deepEqual(repo.validateReviewForAssignment(reviewSelection), request);
    }
    assert.deepEqual(counts(), [initial[0]! + 1, initial[1]], "Review validation does not create more requests or outcomes");
    assert.throws(() => repo.retainRequestForAssignment({ ...input, request: { ...request, nonce: "19".repeat(32) } }));
    const lookup = { ...current, nonce: request.nonce }; assert.equal(repo.findForAssignment(lookup), null);
    const exchange = { ...current, submission: { kind: "runtime.install.lookup" as const, nonce: request.nonce, requestSha256: remoteWorkerRuntimeInstallRequestSha256(request) } };
    assert.equal(repo.exchangeForAssignment(exchange).record, null);
    assert.throws(() => repo.exchangeForAssignment({ ...exchange, submission: { ...exchange.submission, requestSha256: "ff".repeat(32) } }));
    assert.throws(() => repo.exchangeForAssignment({ ...exchange, submission: { ...exchange.submission, nonce: "ff".repeat(32) } }));
    const bytes = Buffer.alloc(352); bytes.write("GCRLI001"); bytes.write("GCRLIT01", 256);
    for (const [offset, value] of [[8, request.nonce], [40, remoteWorkerRuntimeInstallRequestSha256(request)], [72, request.checkpointSha256],
      [104, request.journalIdentityHex], [128, request.preparedSha256], [160, history.plan.assignmentBindingSha256], [192, history.plan.profileSha256]] as const)
      Buffer.from(value, "hex").copy(bytes, offset);
    const seal = () => {
      createHash("sha256").update("goatcitadel.worker-runtime-install-local-intent.v1\0").update(bytes.subarray(0, 224)).digest().copy(bytes, 224);
      bytes.copy(bytes, 288, 224, 256);
      createHash("sha256").update("goatcitadel.worker-runtime-install-local-outcome.v1\0").update(bytes.subarray(0, 320)).digest().copy(bytes, 320);
      return bytes.toString("hex");
    };
    bytes.writeUInt32LE(1, 268); bytes.writeUInt32LE(2, 272); bytes.writeBigUInt64LE(120n, 280);
    const outcomeHex = seal(), submission = { ...lookup, outcomeHex };
    assert.throws(() => repo.retainForAssignment({ ...submission, outcomeHex: outcomeHex.slice(0, 512) }));
    assert.throws(() => repo.retainForAssignment({ ...submission, leaseRevision: 999 }));
    const prepare = db.prepare.bind(db), clock = new DurableRunRepository(db); let intercepted = false;
    db.prepare = sql => {
      const statement = prepare(sql);
      if (/^INSERT INTO remote_worker_runtime_install_outcomes/u.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = params => {
          const value = run(params); intercepted = true; const parent = clock.getRun(manifest.durableRunId);
          clock.updateRun({ runId: parent.runId, status: "cancelled", clearLease: true, expectedVersion: parent.version }); return value;
        };
      }
      return statement;
    };
    try { assert.throws(() => repo.retainForAssignment(submission)); assert.ok(intercepted); } finally { db.prepare = prepare; }
    assert.equal(repo.findForAssignment(lookup), null, "Final authority loss rolls back outcome insertion");
    const result = repo.retainForAssignment(submission);
    assert.throws(() => repo.validateReviewForAssignment(reviewSelection), "A terminal installation cannot be readmitted for copying");
    assert.throws(() => repo.readControllerEnrollmentForAssignment(reviewSelection), "A terminal installation cannot open a signing session");
    assert.equal(result.outcome.installation?.verified, true);
    assert.deepEqual(repo.retainForAssignment(submission), result); assert.deepEqual(repo.findForAssignment(lookup), result);
    const delivery = { ...exchange, submission: { ...exchange.submission, kind: "runtime.install.retain" as const, outcomeHex } };
    const receipt = repo.exchangeForAssignment(delivery);
    assert.equal(receipt.record?.outcomeHex, outcomeHex);
    assert.equal(receipt.record?.outcomeSha256, result.outcome.outcomeSha256);
    assert.deepEqual(repo.exchangeForAssignment(exchange), receipt);
    assert.deepEqual(repo.exchangeForAssignment(delivery), receipt);
    bytes.writeUInt32LE(995, 264); bytes.writeUInt32LE(0, 268);
    assert.throws(() => repo.retainForAssignment({ ...submission, outcomeHex: seal() }), "A second valid outcome cannot replace the retained one");
    assert.equal(canonicalJsonString(cells.getCell(key)), canonicalJsonString(before), "Retention does not publish readiness or change execution");
    for (const table of ["remote_worker_runtime_install_requests", "remote_worker_runtime_install_outcomes"]) {
      assert.throws(() => db.prepare(`UPDATE ${table} SET nonce = nonce WHERE assignment_id = @assignmentId`).run({ assignmentId: key.assignmentId }), /immutable/u);
      assert.throws(() => db.prepare(`DELETE FROM ${table} WHERE assignment_id = @assignmentId`).run({ assignmentId: key.assignmentId }), /retained/u);
    }
    return () => {
      assert.throws(() => repo.findForAssignment(lookup)); assert.throws(() => repo.retainForAssignment(submission)); assert.throws(() => repo.retainRequestForAssignment(input));
      assert.throws(() => repo.exchangeForAssignment(exchange)); assert.throws(() => repo.exchangeForAssignment(delivery));
      assert.throws(() => repo.validateReviewForAssignment(reviewSelection));
      assert.throws(() => repo.readControllerEnrollmentForAssignment(reviewSelection));
      assert.throws(() => repo.selectForAssignment(selection));
      assert.throws(() => pool.readCleanupForAssignment(current));
      assert.equal(counts()[1], initial[1]! + 1, "Revocation preserves immutable evidence");
    };
  });
};
