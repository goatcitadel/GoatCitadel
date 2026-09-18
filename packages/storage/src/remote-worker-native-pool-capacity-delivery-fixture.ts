import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJsonString, createRemoteWorkerNativePoolCapacityDelivery, remoteWorkerCellCanonicalSha256 } from "@goatcitadel/contracts";
import { nativeCapacityCompositionFixture } from "../../contracts/src/remote-worker-native-capacity-composition-test-fixture.js";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";
import { RemoteWorkerNativePoolCapacityDeliveryRepository, snapshotRemoteWorkerNativePoolCapacityDeliveryAdmission,
  snapshotRemoteWorkerNativePoolCapacityDeliveryRead } from "./remote-worker-native-pool-capacity-delivery-repo.js";
import { RemoteWorkerNativePoolRepository } from "./remote-worker-native-pool-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";

/** Controlled source frames against real protected canonical rows. No drive operation. */
export const verifyNativePoolCapacityDelivery: typeof verifyCellProvisioningExchange = (db, key, token, fence, revoke) => {
  verifyCellProvisioningExchange(db, key, token, fence, revoke, (authority, history) => {
    const owner = new RemoteWorkerNativePoolCapacityDeliveryRepository(db), cells = new RemoteWorkerCellRepository(db);
    const pool = new RemoteWorkerNativePoolRepository(db).readSnapshotForAssignment(authority);
    let capture = 0;
    const command = (unallocatedRetentionRoots = false) => {
      const f = nativeCapacityCompositionFixture({ history, nonce: (++capture).toString(16).padStart(64, "0"), unallocatedRetentionRoots });
      const { guestObservationHex, guestChunkHex, backingObservationHex, hostCaptureHex, references } = f.source;
      const source = { hostCaptureHex, references, members: [{ guestObservationHex, guestChunkHex, backingObservationHex }] };
      const window = { nonce: f.window.nonce, connectionNonceHex: "71".repeat(32), poolSnapshotSha256: remoteWorkerCellCanonicalSha256(pool),
        hostCaptureSha256: f.window.hostCaptureSha256, membersSha256: remoteWorkerCellCanonicalSha256(source.members), referencesSha256: f.window.referencesSha256 };
      const delivery = createRemoteWorkerNativePoolCapacityDelivery(canonicalJsonString({ layout: f.layout, window, source }), pool, window.nonce);
      const cell = cells.getCell(key)!;
      return { ...authority, retained: { pool, layout: delivery.layout, window }, deliveryJson: canonicalJsonString(delivery),
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
    const frozen = snapshotRemoteWorkerNativePoolCapacityDeliveryAdmission(first), frozenRead = snapshotRemoteWorkerNativePoolCapacityDeliveryRead(read);
    assert.ok(Object.isFrozen(frozen.retained.window)); assert.ok(Object.isFrozen(frozenRead.retained.window));
    assert.notEqual(frozenRead.retained.window, read.retained.window);
    // These captures are internally valid and fully rehashed. Only comparison
    // with protected canonical membership can reject their invented bindings.
    const changedMembers = pool.members.map(member => ({ ...member, cellId: `${member.cellId}-foreign` }));
    for (const alteredPool of [{ ...pool, workerId: "foreign-worker" }, { ...pool, leaseRevision: pool.leaseRevision + 1 },
      { ...pool, members: changedMembers, membershipSha256: remoteWorkerCellCanonicalSha256(changedMembers) }]) {
      const original = JSON.parse(first.deliveryJson);
      const window = { ...first.retained.window, poolSnapshotSha256: remoteWorkerCellCanonicalSha256(alteredPool) };
      const delivery = createRemoteWorkerNativePoolCapacityDelivery(canonicalJsonString({ layout: first.retained.layout,
        window, source: original.source }), alteredPool, window.nonce);
      const retained = { ...first.retained, pool: alteredPool, window };
      assert.throws(() => owner.retain({ ...first, retained, deliveryJson: canonicalJsonString(delivery) }), /canonical protected pool/u);
      assert.throws(() => owner.read({ ...read, retained, bundleSha256: delivery.bundleSha256 }), /canonical protected pool/u);
      assert.equal(count(), 0); assert.equal(inventories(), 0);
    }
    assert.throws(() => owner.retain({ ...first, observation: { ...first.observation, incomingBytes: first.observation.reservation.allocatedDiskBytes + 1 } }), /rejected/u);
    assert.equal(count(), 0); assert.equal(inventories(), 0);
    const accepted = owner.retain(first);
    assert.equal(accepted.decision, "accept"); assert.equal(count(), 1); assert.equal(inventories(), 1);
    assert.equal(canonicalJsonString(accepted.delivery), first.deliveryJson);
    const priorCell = cells.getCell(key), priorEvidence = evidence();
    assert.deepEqual(new RemoteWorkerNativePoolCapacityDeliveryRepository(db).read(read), accepted);
    assert.deepEqual(new RemoteWorkerNativePoolCapacityDeliveryRepository(db).retain(first), accepted);
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
    const sameNonce = createRemoteWorkerNativePoolCapacityDelivery(canonicalJsonString({ layout: accepted.delivery.layout, window: changedWindow, source: changedSource }), pool, changedWindow.nonce);
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
