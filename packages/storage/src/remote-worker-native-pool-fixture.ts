import assert from "node:assert/strict";
import { assembleRemoteWorkerNativePoolPages, assembleRemoteWorkerNativePoolCleanupPages, REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES } from "@goatcitadel/contracts";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";
import { RemoteWorkerNativePoolRepository } from "./remote-worker-native-pool-repo.js";

export const verifyNativePoolMembership: typeof verifyCellProvisioningExchange = (db, key, token, fence, revoke) => {
  verifyCellProvisioningExchange(db, key, token, fence, revoke, (current, history) => {
    const owner = new RemoteWorkerNativePoolRepository(db);
    const snapshot = owner.readForAssignment(current);
    assert.equal(snapshot.registryWorkspaceId, current.registryWorkspaceId);
    assert.equal(snapshot.members.length, 1);
    assert.equal(snapshot.members[0]!.cell.assignmentId, current.assignmentId);
    assert.equal(snapshot.members[0]!.cell.workerId, snapshot.workerId);
    assert.equal(snapshot.members[0]!.cell.executionState, "provisioning");
    assert.deepEqual(snapshot.members[0]!.provisioning!.mountedWorkspaceCheckpoints.map(item => item.recordHex), history.mountedWorkspaceRecords);
    assert.deepEqual(new RemoteWorkerNativePoolRepository(db).readForAssignment(current), snapshot);
    assert.equal(JSON.stringify(snapshot).includes(token), false);
    assert.equal(JSON.stringify(snapshot).includes("credentialAuthority"), false);
    const wire = owner.readSnapshotForAssignment(current);
    assert.equal(wire.leaseRevision, current.leaseRevision);
    assert.equal(wire.members.length, snapshot.members.length);
    assert.deepEqual(wire.members[0]!.history!.mountedWorkspaceRecords, history.mountedWorkspaceRecords);
    assert.doesNotMatch(JSON.stringify(wire), /provisioningOwner|credentialAuthority|leaseTokenSha256/u);
    const cleanup = owner.readCleanupForAssignment(current);
    assert.deepEqual(cleanup.pool, wire);
    assert.deepEqual(cleanup.members, [{ registryWorkspaceId: current.registryWorkspaceId, assignmentId: current.assignmentId,
      assignmentGeneration: current.assignmentGeneration, expectations: [], installation: null }]);
    assert.doesNotMatch(JSON.stringify(cleanup), /provisioningOwner|credentialAuthority|leaseTokenSha256/u);
    const cleanupSubmission = { kind: "cell.native_pool.cleanup.page" as const, offset: 0, snapshotSha256: null };
    const cleanupFirst = owner.readCleanupPageForAssignment({ ...current, submission: cleanupSubmission }), cleanupPages = [cleanupFirst];
    for (let offset = REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES; offset < cleanupFirst.byteLength; offset += REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES)
      cleanupPages.push(owner.readCleanupPageForAssignment({ ...current, submission: { ...cleanupSubmission, offset, snapshotSha256: cleanupFirst.snapshotSha256 } }));
    assert.deepEqual(assembleRemoteWorkerNativePoolCleanupPages(cleanupPages), cleanup);
    const submission = { kind: "cell.native_pool.page" as const, offset: 0, snapshotSha256: null };
    const first = owner.readPageForAssignment({ ...current, submission }), pages = [first];
    for (let offset = REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES; offset < first.byteLength; offset += REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES)
      pages.push(owner.readPageForAssignment({ ...current, submission: { ...submission, offset, snapshotSha256: first.snapshotSha256 } }));
    assert.deepEqual(assembleRemoteWorkerNativePoolPages(pages), wire);
    assert.throws(() => owner.readPageForAssignment({ ...current, submission: { ...submission, snapshotSha256: "0".repeat(64) } }));
    for (const patch of [{ registryWorkspaceId: "foreign" }, { assignmentId: "foreign" }, { assignmentGeneration: 999 },
      { leaseRevision: 999 }, { leaseTokenSha256: "f".repeat(64) }, { protectedAuthority: undefined },
      { protectedAuthority: { ...fence, credentialAuthority: { ...fence.credentialAuthority, credentialGeneration: 999 } } }]) {
      assert.throws(() => owner.readForAssignment({ ...current, ...patch } as typeof current));
      assert.throws(() => owner.readSnapshotForAssignment({ ...current, ...patch } as typeof current));
      assert.throws(() => owner.readCleanupForAssignment({ ...current, ...patch } as typeof current));
      assert.throws(() => owner.readCleanupPageForAssignment({ ...current, ...patch, submission: cleanupSubmission } as typeof current & { submission: typeof cleanupSubmission }));
    }
    return () => { assert.throws(() => owner.readForAssignment(current)); assert.throws(() => owner.readSnapshotForAssignment(current));
      assert.throws(() => owner.readCleanupForAssignment(current));
      assert.throws(() => owner.readCleanupPageForAssignment({ ...current, submission: cleanupSubmission }));
      assert.throws(() => owner.readPageForAssignment({ ...current, submission })); };
  });
};
