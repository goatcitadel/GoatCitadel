import assert from "node:assert/strict";
import {
  REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION, remoteWorkerCellCanonicalSha256,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { RemoteWorkerAssignmentRepository, type RemoteWorkerAssignmentProtectedCommitFence } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerCellRepository, type RemoteWorkerCellKey } from "./remote-worker-cell-repo.js";
import { RemoteWorkerCellProvisioningRepository } from "./remote-worker-cell-provisioning-repo.js";
import { checkpointFixture } from "./remote-worker-cell-checkpoint-test-helpers.js";

export const NATIVE_CELL_PREPARATION_TEST_POLICY = { provisioningWallMs: 120_000,
  capacity: { schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
    logicalDiskBytes: 16 * 1024 * 1024, allocatedDiskBytes: 82 * 1024 * 1024,
    fileLimit: 100, inodeLimit: 200, processLimit: 2, cpuLimitMilli: 1000, wallLimitMs: 60_000,
    memoryLimitBytes: 64 * 1024 * 1024, rawOutputLimitBytes: 65_536, diagnosticLimitBytes: 65_536,
    artifactCeilingBytes: 65_536, backupStagingBytes: 65_536, backupPublicationBytes: 65_536 } };

export function verifyNativeCellPreparation(db: DatabaseClient, key: RemoteWorkerCellKey,
  leaseTokenSha256: string, fence: RemoteWorkerAssignmentProtectedCommitFence, revoke: () => void): void {
  const repo = new RemoteWorkerCellProvisioningRepository(db);
  const cells = new RemoteWorkerCellRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const clock = new DurableRunRepository(db);
  const authority = assignments.resolveActiveAuthorityByLeaseTokenHash(leaseTokenSha256, fence)!;
  const worker = new RemoteWorkerAdmissionRepository(db).findCurrentGeneration(key.registryWorkspaceId, authority.generation.workerId)!;
  const policy = NATIVE_CELL_PREPARATION_TEST_POLICY;
  const input = { ...key, leaseTokenSha256, leaseRevision: authority.lease.leaseRevision, protectedAuthority: fence, policy,
    submission: { kind: "cell.provisioning.prepare" as const, parentIdentityHex: "0100000000000000" + "1".repeat(32) } };
  for (const patch of [{ assignmentId: "other" }, { assignmentGeneration: 2 }, { leaseRevision: 99 },
    { leaseTokenSha256: remoteWorkerCellCanonicalSha256("wrong-token") }, { protectedAuthority: undefined }]) {
    assert.throws(() => repo.prepareForAssignment({ ...input, ...patch } as typeof input));
    assert.equal(cells.getCell(key), undefined);
  }
  for (const capacity of [{ ...policy.capacity, logicalDiskBytes: 1 }, { ...policy.capacity, allocatedDiskBytes: policy.capacity.logicalDiskBytes }]) {
    assert.throws(() => repo.prepareForAssignment({ ...input, policy: { ...policy, capacity } }));
    assert.equal(cells.getCell(key), undefined);
  }
  // Cancel the parent after all profile/claim/plan writes. The final protected
  // read must roll the entire operation back, including creation eligibility.
  const prepare = repo.prepare.bind(repo);
  repo.prepare = (command) => {
    const result = prepare(command);
    const parent = clock.getRun(authority.assignment.manifest.durableRunId);
    clock.updateRun({ runId: parent.runId, expectedVersion: parent.version, status: "cancelled", clearLease: true });
    return result;
  };
  assert.throws(() => repo.prepareForAssignment(input));
  repo.prepare = prepare;
  assert.equal(cells.getCell(key), undefined);
  assert.equal(repo.getSnapshot(key), undefined);
  assert.equal(clock.getRun(authority.assignment.manifest.durableRunId).status, "running");

  const first = repo.prepareForAssignment(input);
  assert.equal(first.decision, "create_once"); assert.deepEqual(first.exchange.records, []);
  assert.ok(Date.parse(first.provisioningExpiresAt) > Date.now());
  const cell = cells.getCell(key)!;
  assert.equal(cell.executionState, "provisioning"); assert.equal(cell.backend, "windows_native");
  assert.equal(cell.profileSha256, first.exchange.plan.profileSha256); assert.equal(cell.nativePlatform, undefined);
  const row = db.prepare(`SELECT runtime_attestation_sha256, launcher_attestation_sha256, assignment_manifest_sha256,
    capability_profile_sha256, context_snapshot_sha256, path_jail_sha256 FROM remote_worker_cells
    WHERE registry_workspace_id=@registryWorkspaceId AND assignment_id=@assignmentId AND assignment_generation=@assignmentGeneration`)
    .get<Record<string, string>>(key)!;
  assert.equal(row.runtime_attestation_sha256, worker.installedTreeAttestationSha256);
  assert.notEqual(row.runtime_attestation_sha256, worker.runtimeManifestSha256);
  assert.equal(row.assignment_manifest_sha256, authority.assignment.manifestSha256);
  assert.equal(row.capability_profile_sha256, authority.assignment.manifest.capabilityProfileSha256);
  assert.equal(row.context_snapshot_sha256, authority.assignment.manifest.contextSnapshotSha256);
  assert.equal(row.path_jail_sha256, authority.assignment.manifest.pathJailSha256);
  assert.notEqual(row.launcher_attestation_sha256, worker.runtimeManifestSha256);

  // Treat the first response as lost. A new repository owner still sees one
  // immutable plan and cannot reissue creation, even with an empty journal.
  const replay = new RemoteWorkerCellProvisioningRepository(db).prepareForAssignment(input);
  assert.deepEqual(replay, { ...first, decision: "reconcile" });
  for (const changed of [{ ...input, submission: { ...input.submission, parentIdentityHex: "0100000000000000" + "2".repeat(32) } },
    { ...input, policy: { ...policy, capacity: { ...policy.capacity, processLimit: 3 } } }]) {
    assert.throws(() => repo.prepareForAssignment(changed));
    assert.deepEqual(repo.prepareForAssignment(input), replay);
  }
  const firstRecord = checkpointFixture(first.exchange.plan, 1);
  const exchange = { ...input, submission: { kind: "cell.provisioning.checkpoint" as const, expectedSequence: 0, recordHex: firstRecord } };
  repo.exchangeWithAssignment(exchange);
  assert.deepEqual(repo.prepareForAssignment(input).exchange.records, [firstRecord]);
  assert.equal(repo.prepareForAssignment(input).decision, "reconcile");
  const nextToken = remoteWorkerCellCanonicalSha256(`${key.assignmentId}:native-renew`);
  assignments.renewLease({ registryWorkspaceId: key.registryWorkspaceId, assignmentId: key.assignmentId,
    expectedAssignmentGeneration: key.assignmentGeneration, expectedLeaseRevision: input.leaseRevision,
    expectedLeaseTokenSha256: leaseTokenSha256, leaseTokenSha256: nextToken, workerSentThrough: 0,
    idempotencyKey: "native-cell-renew" }, fence);
  assert.throws(() => repo.prepareForAssignment(input));
  const current = { ...input, leaseTokenSha256: nextToken, leaseRevision: input.leaseRevision + 1 };
  assert.equal(repo.prepareForAssignment(current).decision, "reconcile");
  revoke();
  assert.throws(() => repo.prepareForAssignment(current));
  assert.deepEqual(repo.getSnapshot(key)?.checkpoints.map((record) => record.recordHex), [firstRecord]);
}
