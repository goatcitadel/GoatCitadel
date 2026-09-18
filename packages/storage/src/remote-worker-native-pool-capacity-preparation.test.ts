import assert from "node:assert/strict";
import { it } from "node:test";
import { canonicalJsonString, normalizeRemoteWorkerNativeCapacityLayout, REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { nativePoolCapacityFixture } from "../../contracts/src/remote-worker-native-pool-capacity-test-fixture.js";
import { snapshotRemoteWorkerNativePoolCapacityPreparation, type RemoteWorkerNativePoolCapacityPreparationInput } from "./remote-worker-native-capacity-pages-repo.js";

// Pure snapshot proof. The synthetic fence is never presented to a database,
// Gateway or native owner and establishes no assignment authority.
function fixture(count: number) {
  const f = nativePoolCapacityFixture(count);
  return {
    registryWorkspaceId: f.pool.registryWorkspaceId, assignmentId: f.pool.assignmentId,
    assignmentGeneration: f.pool.assignmentGeneration, leaseRevision: f.pool.leaseRevision, leaseTokenSha256: "aa".repeat(32),
    protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as RemoteWorkerNativePoolCapacityPreparationInput["protectedAuthority"],
    retained: { pool: f.pool, layout: normalizeRemoteWorkerNativeCapacityLayout(f.layout), window: f.window },
    bundleSha256: "bb".repeat(32), deliverySha256: "cc".repeat(32), byteLength: 16_777_216,
    expectedCapacityRevision: 0, expectedExecutionRevision: 0, expectedCleanupRevision: 0, expectedBackupRevision: 0,
    observation: { incomingBytes: 0, peakDiskBytes: 0, peakMemoryBytes: 0, peakFileCount: 0, peakProcessCount: 0, rawOutputBytes: 0,
      reservation: { schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
        logicalDiskBytes: 1_000_000, allocatedDiskBytes: 4_000_000, fileLimit: 10_000, inodeLimit: 20_000,
        processLimit: 128, cpuLimitMilli: 2_000, wallLimitMs: 900_000, memoryLimitBytes: 2_000_000_000,
        rawOutputLimitBytes: 8_388_608, diagnosticLimitBytes: 65_536, artifactCeilingBytes: 67_108_864,
        backupStagingBytes: 33_554_432, backupPublicationBytes: 33_554_432 } },
  } satisfies RemoteWorkerNativePoolCapacityPreparationInput;
}

for (const count of [2, 64]) it(`freezes a bounded independent expectation for ${count} native pool members`, () => {
  const input = fixture(count), captured = snapshotRemoteWorkerNativePoolCapacityPreparation(input);
  const original = canonicalJsonString(captured);
  assert.ok(Buffer.byteLength(original) < 8192);
  assert.equal(original.includes("mountedWorkspaceRecords"), false);
  assert.equal(captured.retained.window.poolSnapshotSha256, input.retained.window.poolSnapshotSha256);
  assert.ok(Object.isFrozen(captured.retained.window)); assert.ok(Object.isFrozen(captured.retained.layout.rootIdentityHex));
  input.retained.window.poolSnapshotSha256 = "ee".repeat(32);
  input.observation.reservation.allocatedDiskBytes++;
  assert.equal(canonicalJsonString(captured), original);
  assert.throws(() => snapshotRemoteWorkerNativePoolCapacityPreparation(input), /retained pool/u);
});

it("refuses an invented pool digest and out-of-bound delivery or original lease", () => {
  const input = fixture(2);
  assert.throws(() => snapshotRemoteWorkerNativePoolCapacityPreparation({ ...input, byteLength: 16_777_217 }), /bound/u);
  assert.throws(() => snapshotRemoteWorkerNativePoolCapacityPreparation({ ...input,
    retained: { ...input.retained, pool: { ...input.retained.pool, leaseRevision: 2147483648 } } }), /lease revision/u);
  assert.throws(() => snapshotRemoteWorkerNativePoolCapacityPreparation({ ...input,
    retained: { ...input.retained, window: { ...input.retained.window, poolSnapshotSha256: "dd".repeat(32) } } }), /retained pool/u);
});
