import assert from "node:assert/strict";
import { REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT, readRemoteWorkerCellObjectInventory } from "@goatcitadel/contracts";
import { objectInventoryFixture } from "../../contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";
import { RemoteWorkerCellCapacityRepository } from "./remote-worker-cell-capacity-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";

/** Both real dialects use current protected worker/mesh/assignment authority. */
export const verifyCellObjectInventoryExchange: typeof verifyCellProvisioningExchange = (db, key, token, fence, revoke) => {
  verifyCellProvisioningExchange(db, key, token, fence, revoke, (current, history) => {
    const repo = new RemoteWorkerCellCapacityRepository(db), cells = new RemoteWorkerCellRepository(db);
    const originalCell = cells.getCell(key), originalEvidence = cells.listEvidenceAfter(key, 0);
    const snapshot = { ...current, submission: { kind: "cell.object_inventory.snapshot" as const } };
    assert.equal(repo.exchangeInventoryWithAssignment(snapshot).record, null);
    const fixture = objectInventoryFixture(history);
    const write = { ...current, submission: { kind: "cell.object_inventory.observation" as const, expectedRevision: 0,
      observationHex: fixture.summary.toString("hex"), chunkHex: fixture.chunks.map(chunk => chunk.toString("hex")), nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT } };
    const count = () => db.prepare("SELECT COUNT(*) AS count FROM remote_worker_cell_object_inventory_observations WHERE assignment_id = @assignmentId")
      .get<{ count: number }>({ assignmentId: key.assignmentId })!.count;
    for (const patch of [{ assignmentId: "foreign" }, { registryWorkspaceId: "foreign" }, { assignmentGeneration: 999 }, { leaseRevision: 999 },
      { leaseTokenSha256: "f".repeat(64) }, { protectedAuthority: undefined },
      { protectedAuthority: { ...fence, credentialAuthority: { ...fence.credentialAuthority, credentialGeneration: 999 } } }]) {
      assert.throws(() => repo.exchangeInventoryWithAssignment({ ...write, ...patch } as typeof write)); assert.equal(count(), 0);
    }
    for (const patch of [{ expectedRevision: 1 }, { nativeReceiptHex: "00".repeat(16) }, { chunkHex: [] },
      { chunkHex: [...write.submission.chunkHex].reverse() }, { chunkHex: [write.submission.chunkHex[0]!, write.submission.chunkHex[0]!] }]) {
      assert.throws(() => repo.exchangeInventoryWithAssignment({ ...write, submission: { ...write.submission, ...patch } })); assert.equal(count(), 0);
    }
    const clock = new DurableRunRepository(db), before = clock.readDatabaseNow();
    const first = repo.exchangeInventoryWithAssignment(write);
    assert.equal(first.record?.revision, 1); assert.equal(count(), 1);
    assert.ok(first.record!.recordedAt >= before && first.record!.recordedAt <= clock.readDatabaseNow());
    assert.deepEqual(first.record!.chunkHex, write.submission.chunkHex);
    assert.equal(readRemoteWorkerCellObjectInventory(first.record!.observationHex, first.record!.chunkHex, first.history).entries.length, 26);
    assert.deepEqual(new RemoteWorkerCellCapacityRepository(db).exchangeInventoryWithAssignment(write), first);
    assert.throws(() => repo.exchangeInventoryWithAssignment({ ...write, submission: { ...write.submission, expectedRevision: 1 } }), /replay conflicts/u);
    // Change two allocations while preserving the valid aggregate and nonce.
    const alternate = fixture.chunks.map(chunk => Buffer.from(chunk));
    alternate[1]!.writeBigUInt64LE(4095n, 80); alternate[1]!.writeBigUInt64LE(4097n, 128);
    assert.throws(() => repo.exchangeInventoryWithAssignment({ ...write, submission: { ...write.submission,
      chunkHex: alternate.map(chunk => chunk.toString("hex")) } }), /replay conflicts/u);

    const full = objectInventoryFixture(history, 19996);
    full.summary.fill(0x72, 0, 32); for (const chunk of full.chunks) chunk.fill(0x72, 0, 32);
    const next = { ...write, submission: { ...write.submission, expectedRevision: 1,
      observationHex: full.summary.toString("hex"), chunkHex: full.chunks.map(chunk => chunk.toString("hex")) } };
    const parentId = new RemoteWorkerAssignmentRepository(db).resolveActiveAuthorityByLeaseTokenHash(current.leaseTokenSha256, fence)!.assignment.manifest.durableRunId;
    const prepare = db.prepare.bind(db); let intercepted = false;
    db.prepare = sql => {
      const statement = prepare(sql);
      if (/^INSERT INTO remote_worker_cell_object_inventory_observations/u.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = params => {
          const result = run(params); intercepted = true;
          const parent = clock.getRun(parentId); clock.updateRun({ runId: parentId, status: "cancelled", clearLease: true, expectedVersion: parent.version });
          return result;
        };
      }
      return statement;
    };
    try { assert.throws(() => repo.exchangeInventoryWithAssignment(next)); }
    finally { db.prepare = prepare; }
    assert.equal(intercepted, true); assert.equal(count(), 1); assert.notEqual(clock.getRun(parentId).status, "cancelled");
    const second = repo.exchangeInventoryWithAssignment(next);
    assert.equal(second.record?.revision, 2); assert.equal(second.record?.chunkHex.length, 1000);
    assert.equal(readRemoteWorkerCellObjectInventory(second.record!.observationHex, second.record!.chunkHex, second.history).entries.length, 20000);
    assert.deepEqual(repo.exchangeInventoryWithAssignment(snapshot), second);
    assert.deepEqual(repo.exchangeInventoryWithAssignment(write), first, "old nonce replays its exact immutable capture after a newer row");
    const row = db.prepare("SELECT * FROM remote_worker_cell_object_inventory_observations WHERE assignment_id = @assignmentId AND revision = 1")
      .get<Record<string, unknown>>({ assignmentId: key.assignmentId })!;
    assert.equal(row.chunk_hex_json, JSON.stringify(write.submission.chunkHex));
    assert.throws(() => db.prepare("UPDATE remote_worker_cell_object_inventory_observations SET chunk_hex_json = '[]' WHERE assignment_id = @assignmentId").run({ assignmentId: key.assignmentId }));
    assert.throws(() => db.prepare("DELETE FROM remote_worker_cell_object_inventory_observations WHERE assignment_id = @assignmentId").run({ assignmentId: key.assignmentId }));
    assert.deepEqual(cells.getCell(key), originalCell); assert.deepEqual(cells.listEvidenceAfter(key, 0), originalEvidence);
    assert.equal(JSON.stringify(second).includes(token), false); assert.equal(JSON.stringify(second).includes("protectedAuthority"), false);
    return () => {
      assert.throws(() => repo.exchangeInventoryWithAssignment(snapshot));
      assert.throws(() => repo.exchangeInventoryWithAssignment(write));
      assert.equal(count(), 2);
    };
  });
};
