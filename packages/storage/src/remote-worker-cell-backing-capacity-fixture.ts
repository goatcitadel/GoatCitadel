import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT, readRemoteWorkerCellBackingCapacityObservation } from "@goatcitadel/contracts";
import { backingCapacityObservationFixture } from "../../contracts/src/remote-worker-cell-backing-capacity-test-fixture.js";
import { capacityObservationFixture } from "../../contracts/src/remote-worker-cell-capacity-test-fixture.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerCellBackingCapacityRepository } from "./remote-worker-cell-backing-capacity-repo.js";
import { RemoteWorkerCellCapacityRepository } from "./remote-worker-cell-capacity-repo.js";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";

/** Both dialects execute the real protected-admission/assignment/native-history
 * owners. Records are encoded fixtures; no native volume or user database exists. */
export const verifyCellBackingCapacityExchange: typeof verifyCellProvisioningExchange = (db, key, token, fence, revoke) => {
  verifyCellProvisioningExchange(db, key, token, fence, revoke, (current, history) => {
    const repo = new RemoteWorkerCellBackingCapacityRepository(db), cells = new RemoteWorkerCellRepository(db);
    const assignments = new RemoteWorkerAssignmentRepository(db), clock = new DurableRunRepository(db);
    const originalCell = cells.getCell(key), originalEvidence = cells.listEvidenceAfter(key, 0);
    const snapshot = { ...current, submission: { kind: "cell.backing_capacity.snapshot" as const } };
    assert.equal(repo.exchangeWithAssignment(snapshot).record, null);
    const bytes = backingCapacityObservationFixture(history);
    const write = { ...current, submission: { kind: "cell.backing_capacity.observation" as const, expectedRevision: 0,
      observationHex: bytes.toString("hex"), nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT } };
    const count = () => db.prepare("SELECT COUNT(*) AS count FROM remote_worker_cell_backing_capacity_observations WHERE assignment_id = @assignmentId")
      .get<{ count: number }>({ assignmentId: key.assignmentId })!.count;
    for (const patch of [{ assignmentId: "foreign" }, { registryWorkspaceId: "foreign" }, { assignmentGeneration: 999 },
      { leaseRevision: 999 }, { leaseTokenSha256: "f".repeat(64) }, { protectedAuthority: undefined },
      { protectedAuthority: { ...fence, credentialAuthority: { ...fence.credentialAuthority, credentialGeneration: 999 } } }]) {
      assert.throws(() => repo.exchangeWithAssignment({ ...write, ...patch } as typeof write));
      assert.equal(count(), 0);
    }
    for (const patch of [{ expectedRevision: 1 }, { nativeReceiptHex: "00".repeat(16) },
      { observationHex: write.submission.observationHex.slice(0, 80) + "f".repeat(32) + write.submission.observationHex.slice(112) }]) {
      assert.throws(() => repo.exchangeWithAssignment({ ...write, submission: { ...write.submission, ...patch } }));
      assert.equal(count(), 0);
    }
    const before = clock.readDatabaseNow();
    const first = repo.exchangeWithAssignment(write);
    assert.equal(first.record?.revision, 1);
    assert.ok(first.record!.recordedAt >= before && first.record!.recordedAt <= clock.readDatabaseNow());
    assert.equal(readRemoteWorkerCellBackingCapacityObservation(first.record!.observationHex, first.history).hostFileAllocatedBytes, history.plan.virtualDiskBytes + 2 * 1024 ** 2 + 24576);
    assert.deepEqual(new RemoteWorkerCellBackingCapacityRepository(db).exchangeWithAssignment(write), first);
    assert.equal(count(), 1);
    // Mounted and host observations can use the same nonce and revision without
    // sharing a row, acknowledgement, accounting total or raw-frame decoder.
    const mounted = new RemoteWorkerCellCapacityRepository(db);
    const mountedWrite = { ...current, submission: { ...write.submission, kind: "cell.capacity.observation" as const,
      observationHex: capacityObservationFixture(history).toString("hex") } };
    const mountedFirst = mounted.exchangeWithAssignment(mountedWrite);
    assert.equal(mountedFirst.record?.revision, 1);
    assert.equal(mountedFirst.record!.observationHex.slice(0, 64), first.record!.observationHex.slice(0, 64));
    assert.throws(() => repo.exchangeWithAssignment({ ...write, submission: { ...write.submission, observationHex: mountedWrite.submission.observationHex } }));
    assert.throws(() => mounted.exchangeWithAssignment({ ...mountedWrite, submission: { ...mountedWrite.submission, observationHex: write.submission.observationHex } }));
    assert.equal(count(), 1);
    bytes.writeBigUInt64LE(bytes.readBigUInt64LE(384) - 1n, 384);
    assert.throws(() => repo.exchangeWithAssignment({ ...write, submission: { ...write.submission, observationHex: bytes.toString("hex") } }), /replay conflicts/u);
    assert.throws(() => repo.exchangeWithAssignment({ ...write, submission: { ...write.submission, expectedRevision: 1 } }), /replay conflicts/u);
    const next = { ...write, submission: { ...write.submission, expectedRevision: 1,
      observationHex: backingCapacityObservationFixture(history, 0x72).toString("hex") } };

    // A real parent cancellation after INSERT must roll back the inserted row
    // and its cancellation together when the final current-authority fence fails.
    const parentId = assignments.resolveActiveAuthorityByLeaseTokenHash(current.leaseTokenSha256, fence)!.assignment.manifest.durableRunId;
    const prepare = db.prepare.bind(db);
    let intercepted = false;
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (/^INSERT INTO remote_worker_cell_backing_capacity_observations/u.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = (params) => {
          const result = run(params); intercepted = true;
          const parent = clock.getRun(parentId);
          clock.updateRun({ runId: parentId, status: "cancelled", clearLease: true, expectedVersion: parent.version });
          return result;
        };
      }
      return statement;
    };
    try { assert.throws(() => repo.exchangeWithAssignment(next)); }
    finally { db.prepare = prepare; }
    assert.ok(intercepted); assert.equal(count(), 1); assert.equal(clock.getRun(parentId).status, "running");
    const second = repo.exchangeWithAssignment(next);
    assert.equal(second.record?.revision, 2);
    assert.deepEqual(repo.exchangeWithAssignment(write), first, "replay acknowledges its original row even after later observations");
    assert.deepEqual(repo.exchangeWithAssignment(snapshot), second);
    assert.deepEqual(mounted.exchangeWithAssignment({ ...current, submission: { kind: "cell.capacity.snapshot" } }), mountedFirst);
    assert.equal(count(), 2);
    assert.deepEqual(cells.getCell(key), originalCell, "partial totals cannot advance readiness, quotas or full accounting");
    assert.deepEqual(cells.listEvidenceAfter(key, 0), originalEvidence);
    const bindings = { assignmentId: key.assignmentId };
    assert.throws(() => db.prepare("UPDATE remote_worker_cell_backing_capacity_observations SET revision = revision WHERE assignment_id = @assignmentId").run(bindings), /immutable/u);
    assert.throws(() => db.prepare("DELETE FROM remote_worker_cell_backing_capacity_observations WHERE assignment_id = @assignmentId").run(bindings), /retained/u);

    // The setup claim is history, not the authority for later read-only counts.
    // Wait only for this fixture's short real database deadline; assignment and
    // credential leases remain independently live throughout.
    const remaining = Date.parse(originalCell!.provisioningLeaseExpiresAt!) - Date.parse(clock.readDatabaseNow());
    if (remaining > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining + 5);
    assert.ok(originalCell!.provisioningLeaseExpiresAt! <= clock.readDatabaseNow());
    const afterSetup = { ...next, submission: { ...next.submission, expectedRevision: 2,
      observationHex: backingCapacityObservationFixture(history, 0x73).toString("hex") } };
    assert.equal(repo.exchangeWithAssignment(afterSetup).record?.revision, 3);
    assert.deepEqual(cells.getCell(key), originalCell);
    assert.equal(JSON.stringify(first).includes(current.leaseTokenSha256), false);
    assert.equal(JSON.stringify(first).includes("protectedAuthority"), false);
    assert.equal(JSON.stringify(first).includes(createHash("sha256").update(token).digest("hex")), false);
    return () => {
      assert.throws(() => repo.exchangeWithAssignment(snapshot));
      assert.throws(() => repo.exchangeWithAssignment(write), "revocation wins before successful replay");
      assert.equal(count(), 3);
    };
  }, 20_000);
};
