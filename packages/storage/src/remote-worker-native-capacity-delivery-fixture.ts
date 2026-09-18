import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJsonString, createRemoteWorkerNativeCapacityDelivery, remoteWorkerCellCanonicalSha256 } from "@goatcitadel/contracts";
import { nativeCapacityCompositionFixture } from "../../contracts/src/remote-worker-native-capacity-composition-test-fixture.js";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";
import { RemoteWorkerNativeCapacityDeliveryRepository, snapshotRemoteWorkerNativeCapacityDeliveryAdmission,
  snapshotRemoteWorkerNativeCapacityDeliveryRead } from "./remote-worker-native-capacity-delivery-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";

/** Controlled source frames against real protected canonical rows. No drive operation. */
export const verifyNativeCapacityDelivery: typeof verifyCellProvisioningExchange = (db, key, token, fence, revoke) => {
  verifyCellProvisioningExchange(db, key, token, fence, revoke, (authority, history) => {
    const owner = new RemoteWorkerNativeCapacityDeliveryRepository(db), cells = new RemoteWorkerCellRepository(db);
    let capture = 0;
    const command = (unallocatedRetentionRoots = false) => {
      const f = nativeCapacityCompositionFixture({ history, nonce: (++capture).toString(16).padStart(64, "0"), unallocatedRetentionRoots });
      const delivery = createRemoteWorkerNativeCapacityDelivery(canonicalJsonString({ layout: f.layout, window: f.window, source: f.source }), history, f.window.nonce);
      const cell = cells.getCell(key)!;
      return { ...authority, retained: { history, layout: delivery.layout, window: f.window }, deliveryJson: canonicalJsonString(delivery),
        expectedCapacityRevision: cell.capacityRevision, expectedExecutionRevision: cell.executionRevision,
        expectedCleanupRevision: cell.cleanupRevision, expectedBackupRevision: cell.backupRevision,
        observation: { reservation: cell.capacity, incomingBytes: 0, peakDiskBytes: 0, peakMemoryBytes: 0, peakFileCount: 0, peakProcessCount: 0, rawOutputBytes: 0 } };
    };
    const count = () => Number(db.prepare("SELECT COUNT(*) AS count FROM remote_worker_native_capacity_deliveries").get<{ count: number | string }>()!.count);
    const inventories = () => Number(db.prepare("SELECT COUNT(*) AS count FROM remote_worker_cell_capacity_inventories").get<{ count: number | string }>()!.count);
    const evidence = () => cells.listEvidenceAfter(key, 0);
    const first = command(true), firstHash = (JSON.parse(first.deliveryJson) as { bundleSha256: string }).bundleSha256;
    const read = { ...authority, retained: first.retained, bundleSha256: firstHash };
    assert.equal(owner.read(read), null);
    const frozen = snapshotRemoteWorkerNativeCapacityDeliveryAdmission(first), frozenRead = snapshotRemoteWorkerNativeCapacityDeliveryRead(read);
    assert.ok(Object.isFrozen(frozen.retained.window)); assert.ok(Object.isFrozen(frozenRead.retained.window));
    assert.notEqual(frozenRead.retained.window, read.retained.window);
    assert.throws(() => owner.retain({ ...first, observation: { ...first.observation, incomingBytes: first.observation.reservation.allocatedDiskBytes + 1 } }), /rejected/u);
    assert.equal(count(), 0); assert.equal(inventories(), 0);
    const accepted = owner.retain(first);
    assert.equal(accepted.decision, "accept"); assert.equal(count(), 1); assert.equal(inventories(), 1);
    assert.equal(canonicalJsonString(accepted.delivery), first.deliveryJson);
    const priorCell = cells.getCell(key), priorEvidence = evidence();
    assert.deepEqual(new RemoteWorkerNativeCapacityDeliveryRepository(db).read(read), accepted);
    assert.deepEqual(new RemoteWorkerNativeCapacityDeliveryRepository(db).retain(first), accepted);
    assert.deepEqual(cells.getCell(key), priorCell); assert.deepEqual(evidence(), priorEvidence);
    for (const sql of ["UPDATE remote_worker_native_capacity_deliveries SET recorded_at=recorded_at", "DELETE FROM remote_worker_native_capacity_deliveries"]) {
      assert.throws(() => db.prepare(sql).run(), /immutable|retained/u);
    }
    const next = command();
    assert.throws(() => owner.retain({ ...next, expectedCapacityRevision: next.expectedCapacityRevision + 1 }), /capacity revision/u);
    const parsed = JSON.parse(next.deliveryJson);
    parsed.inventory.references = [];
    assert.throws(() => owner.retain({ ...next, deliveryJson: JSON.stringify(parsed) }), /retained capture/u);
    assert.equal(count(), 1); assert.equal(inventories(), 1); assert.deepEqual(cells.getCell(key), priorCell);
    const changedSource = { ...(accepted.delivery.source as Record<string, unknown>), references: [] };
    const changedWindow = { ...accepted.delivery.window, referencesSha256: remoteWorkerCellCanonicalSha256([]) };
    const sameNonce = createRemoteWorkerNativeCapacityDelivery(canonicalJsonString({ layout: accepted.delivery.layout, window: changedWindow, source: changedSource }), history, changedWindow.nonce);
    assert.throws(() => owner.retain({ ...next, retained: { ...first.retained, window: changedWindow }, deliveryJson: canonicalJsonString(sameNonce) }), /unique|duplicate/iu);
    assert.equal(count(), 1); assert.equal(inventories(), 1); assert.deepEqual(evidence(), priorEvidence);
    for (const interruption of ["write", "authority"] as const) {
      const prepare = db.prepare.bind(db);
      let inserted = false;
      db.prepare = sql => {
        const statement = prepare(sql);
        if (/^INSERT INTO remote_worker_native_capacity_deliveries/u.test(sql)) {
          const run = statement.run.bind(statement);
          statement.run = params => {
            const result = run(params); inserted = true;
            if (interruption === "write") throw new Error("controlled response failure inside source transaction");
            revoke(); return result;
          };
        }
        return statement;
      };
      try { assert.throws(() => owner.retain(next)); } finally { db.prepare = prepare; }
      assert.equal(inserted, true); assert.equal(count(), 1); assert.equal(inventories(), 1);
      assert.deepEqual(cells.getCell(key), priorCell); assert.deepEqual(evidence(), priorEvidence);
      assert.deepEqual(owner.read(read), accepted);
    }
    const second = owner.retain(next);
    assert.ok(second.receipt.revision > accepted.receipt.revision);
    assert.equal(count(), 2); assert.equal(inventories(), 2);
    assert.deepEqual(owner.retain(first), accepted); // Old receipt remains stable after newer admission.
    const overMemory = command();
    const quarantined = owner.retain({ ...overMemory, observation: { ...overMemory.observation,
      peakMemoryBytes: overMemory.observation.reservation.memoryLimitBytes + 1 } });
    assert.equal(quarantined.decision, "quarantine");
    assert.equal(count(), 3); assert.equal(inventories(), 3);
    assert.deepEqual(owner.retain(first), accepted);
    const renewedToken = createHash("sha256").update(`${key.assignmentId}:native-delivery-renewed`).digest("hex");
    new RemoteWorkerAssignmentRepository(db).renewLease({ registryWorkspaceId: key.registryWorkspaceId, assignmentId: key.assignmentId,
      expectedAssignmentGeneration: key.assignmentGeneration, expectedLeaseRevision: authority.leaseRevision,
      expectedLeaseTokenSha256: authority.leaseTokenSha256, leaseTokenSha256: renewedToken, workerSentThrough: 0,
      idempotencyKey: "native-delivery-renewed" }, fence);
    const renewed = { ...authority, leaseRevision: authority.leaseRevision + 1, leaseTokenSha256: renewedToken };
    assert.throws(() => owner.read(read));
    assert.deepEqual(owner.retain({ ...first, ...renewed }), accepted);
    assert.deepEqual(owner.read({ ...read, ...renewed }), accepted);
    return () => {
      assert.throws(() => owner.read({ ...read, ...renewed })); assert.throws(() => owner.retain({ ...first, ...renewed }));
      assert.equal(count(), 3); assert.equal(inventories(), 3);
    };
  });
};
