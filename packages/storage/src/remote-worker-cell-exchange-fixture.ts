import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION, REMOTE_WORKER_CELL_PROFILE_V2_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION, remoteWorkerCellProvisioningBindingSha256,
  type RemoteWorkerCellProfile, type RemoteWorkerCellProvisioningExchange,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerAssignmentRepository, type RemoteWorkerAssignmentProtectedCommitFence } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { REMOTE_WORKER_NATIVE_ENVIRONMENT_SHA256 } from "./remote-worker-cell-native-profile.js";
import { RemoteWorkerCellProvisioningRepository, type RemoteWorkerCellProvisioningAssignmentInput } from "./remote-worker-cell-provisioning-repo.js";
import { checkpointFixture } from "./remote-worker-cell-checkpoint-test-helpers.js";
import { volumeExchangeFixture, rehashVolumeFixture } from "../../contracts/src/remote-worker-cell-volume-test-fixture.js";
import { formatExchangeFixture } from "../../contracts/src/remote-worker-cell-format-test-fixture.js";
import { protectionExchangeFixture } from "../../contracts/src/remote-worker-cell-protection-test-fixture.js";
import { mountExchangeFixture } from "../../contracts/src/remote-worker-cell-mount-test-fixture.js";
import { mountedWorkspaceExchangeFixture } from "../../contracts/src/remote-worker-cell-mounted-workspace-test-fixture.js";

/** Actual protected worker/mesh admission and assignment rows come from the
 * shared SQLite/PostgreSQL authority fixture. No platform readiness is forged. */
export function verifyCellProvisioningExchange(
  db: DatabaseClient,
  key: { registryWorkspaceId: string; assignmentId: string; assignmentGeneration: number },
  leaseTokenSha256: string,
  fence: RemoteWorkerAssignmentProtectedCommitFence,
  revoke: () => void,
  onComplete?: (input: RemoteWorkerCellProvisioningAssignmentInput, exchange: RemoteWorkerCellProvisioningExchange) => (() => void),
  provisioningLeaseMs = 120_000,
  retainFixture = false,
): void {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const cells = new RemoteWorkerCellRepository(db);
  const repo = new RemoteWorkerCellProvisioningRepository(db);
  const clock = new DurableRunRepository(db);
  const active = assignments.resolveActiveAuthorityByLeaseTokenHash(leaseTokenSha256, fence)!;
  assert.ok(active);
  const input = { ...key, leaseTokenSha256, leaseRevision: active.lease.leaseRevision, protectedAuthority: fence,
    submission: { kind: "cell.provisioning.snapshot" as const } };
  assert.throws(() => repo.exchangeWithAssignment(input), /prepared plan/u);
  const manifest = active.assignment.manifest;
  const profile: RemoteWorkerCellProfile = {
    ...key, schemaVersion: REMOTE_WORKER_CELL_PROFILE_V2_SCHEMA_VERSION, cellId: `cell-${key.assignmentId}`,
    workerId: active.generation.workerId, workerGeneration: active.generation.workerGeneration, backend: "windows_native",
    logicalRootSha256: digest("root"), assignmentManifestSha256: active.assignment.manifestSha256,
    pathJailSha256: manifest.pathJailSha256, capabilityProfileSha256: manifest.capabilityProfileSha256,
    contextSnapshotSha256: manifest.contextSnapshotSha256, toolEffectPostureSha256: manifest.toolEffectPostureSha256,
    runtimeAttestationSha256: digest("runtime-attestation"), launcherAttestationSha256: digest("launcher-attestation"),
    egressPosture: "deny_all", egressPolicySha256: digest("egress-policy"), egressDnsRevision: 1, envAllowlistSha256: REMOTE_WORKER_NATIVE_ENVIRONMENT_SHA256,
    capacity: { schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
      logicalDiskBytes: 64 * 1024 * 1024, allocatedDiskBytes: 130 * 1024 * 1024, fileLimit: 100, inodeLimit: 200,
      processLimit: 2, cpuLimitMilli: 1000, wallLimitMs: 60_000, memoryLimitBytes: 64 * 1024 * 1024,
      rawOutputLimitBytes: 65_536, diagnosticLimitBytes: 65_536, artifactCeilingBytes: 65_536,
      backupStagingBytes: 65_536, backupPublicationBytes: 65_536 },
  };
  cells.profileOrReplay({ profile, idempotencyKey: "cell-exchange-profile", createdAt: clock.readDatabaseNow() });
  const claim = { ...key, provisioningOwner: "gateway-cell-owner",
    provisioningLeaseExpiresAt: new Date(Date.parse(clock.readDatabaseNow()) + provisioningLeaseMs).toISOString() };
  const cell = cells.claimProvisioning({ ...claim, leaseExpiresAt: claim.provisioningLeaseExpiresAt,
    detailSha256: digest("claim"), now: clock.readDatabaseNow() })!;
  const plan = { schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
    assignmentBindingSha256: remoteWorkerCellProvisioningBindingSha256({ ...claim, cellId: cell.cellId,
      workerId: cell.workerId, workerGeneration: cell.workerGeneration, profileSha256: cell.profileSha256 }),
    profileSha256: cell.profileSha256, parentIdentityHex: "0100000000000000" + "1".repeat(32),
    cellName: `gc-cell-${"1".repeat(32)}`, ownerSid: "S-1-5-18", controllerSid: "S-1-5-80-1-2-3-4-5",
    diskIdentifierHex: "3".repeat(32), virtualDiskBytes: 64 * 1024 * 1024, reservedDiskBytes: 128 * 1024 * 1024 } as const;
  repo.prepare({ ...claim, plan, expectedCapacityRevision: cell.capacityRevision });
  const empty = repo.exchangeWithAssignment(input);
  assert.deepEqual(empty.records, []);
  assert.equal(empty.diskLayoutPlan, undefined);
  assert.equal(JSON.stringify(empty).includes("protectedAuthority"), false);
  assert.equal(JSON.stringify(empty).includes("provisioningOwner"), false);
  assert.equal(JSON.stringify(empty).includes(leaseTokenSha256), false);
  const recordHex = checkpointFixture(plan, 1);
  const write = { ...input, submission: { kind: "cell.provisioning.checkpoint" as const, expectedSequence: 0, recordHex } };
  for (const patch of [{ assignmentId: "foreign" }, { registryWorkspaceId: "foreign" }, { assignmentGeneration: 2 },
    { leaseRevision: 2 }, { leaseTokenSha256: digest("wrong-token") }, { protectedAuthority: undefined },
    { protectedAuthority: { ...fence, credentialAuthority: { ...fence.credentialAuthority, credentialGeneration: 999 } } }]) {
    assert.throws(() => repo.exchangeWithAssignment({ ...write, ...patch } as typeof write));
    assert.deepEqual(repo.getSnapshot(key)?.checkpoints, []);
  }
  const recorded = repo.exchangeWithAssignment(write);
  assert.deepEqual(recorded.records, [recordHex]);
  assert.deepEqual(new RemoteWorkerCellProvisioningRepository(db).exchangeWithAssignment(write), recorded);
  assert.equal(cells.getCell(key)?.executionState, "provisioning");
  const next = checkpointFixture(plan, 2, recordHex.slice(-64));

  // Exercise a change AFTER the write but before the outer transaction commits.
  // The canonical parent's transition occurs through its repository and must
  // invalidate the write; rolling back retains the original checkpoint count.
  const append = repo.appendCheckpoint.bind(repo);
  repo.appendCheckpoint = (command) => {
    const result = append(command);
    const parent = clock.getRun(manifest.durableRunId);
    clock.updateRun({ runId: parent.runId, status: "cancelled", clearLease: true, expectedVersion: parent.version });
    return result;
  };
  assert.throws(() => repo.exchangeWithAssignment({ ...input,
    submission: { kind: "cell.provisioning.checkpoint", expectedSequence: 1, recordHex: next } }));
  repo.appendCheckpoint = append;
  assert.equal(clock.getRun(manifest.durableRunId).status, "running");
  assert.deepEqual(repo.exchangeWithAssignment(input).records, [recordHex]);

  const nextToken = digest(`${key.assignmentId}:renewed`);
  assignments.renewLease({ registryWorkspaceId: key.registryWorkspaceId, assignmentId: key.assignmentId,
    expectedAssignmentGeneration: key.assignmentGeneration,
    expectedLeaseRevision: input.leaseRevision, expectedLeaseTokenSha256: leaseTokenSha256,
    leaseTokenSha256: nextToken, workerSentThrough: 0, idempotencyKey: "cell-exchange-renew" }, fence);
  assert.throws(() => repo.exchangeWithAssignment(write));
  const current = { ...input, leaseTokenSha256: nextToken, leaseRevision: input.leaseRevision + 1 };
  assert.deepEqual(repo.exchangeWithAssignment({ ...current,
    submission: { kind: "cell.provisioning.checkpoint", expectedSequence: 1, recordHex: next } }).records, [recordHex, next]);
  const completed = [recordHex, next];
  for (let sequence = 3; sequence <= 5; sequence++) {
    completed.push(checkpointFixture(plan, sequence, completed.at(-1)!.slice(-64)));
    const result = repo.exchangeWithAssignment({ ...current,
      submission: { kind: "cell.provisioning.checkpoint", expectedSequence: sequence - 1, recordHex: completed.at(-1)! } });
    assert.equal(result.diskLayoutPlan !== undefined, sequence === 5);
  }
  const withLayout = repo.exchangeWithAssignment(current);
  assert.equal(withLayout.diskLayoutPlan?.provisioningPlanSha256, withLayout.planSha256);
  assert.equal(withLayout.diskLayoutPlan?.diskIdentifierHex, plan.diskIdentifierHex);
  assert.notEqual(withLayout.diskLayoutPlan?.gptDiskIdentifierHex, withLayout.diskLayoutPlan?.dataPartitionIdentifierHex);
  assert.deepEqual(new RemoteWorkerCellProvisioningRepository(db).exchangeWithAssignment(current), withLayout);
  const withVolume = volumeExchangeFixture(withLayout), volumeRecords = withVolume.volumeRecords!;
  const withFormat = formatExchangeFixture(withVolume), formatRecords = withFormat.formatRecords!;
  const formatWrite = { ...current, submission: { kind: "cell.format.checkpoint" as const,
    expectedSequence: 0, recordHex: formatRecords[0]! } };
  assert.throws(() => repo.exchangeWithAssignment(formatWrite), /all six canonical volume checkpoints/u);
  assert.deepEqual(repo.getSnapshot(key)?.formatCheckpoints, []);
  const volumeWrite = { ...current, submission: { kind: "cell.volume.checkpoint" as const,
    expectedSequence: 0, recordHex: volumeRecords[0]! } };
  for (const patch of [{ assignmentId: "foreign" }, { registryWorkspaceId: "foreign" }, { assignmentGeneration: 2 },
    { leaseRevision: input.leaseRevision }, { leaseTokenSha256 },
    { protectedAuthority: { ...fence, credentialAuthority: { ...fence.credentialAuthority, credentialGeneration: 999 } } }]) {
    assert.throws(() => repo.exchangeWithAssignment({ ...volumeWrite, ...patch }));
    assert.deepEqual(repo.getSnapshot(key)?.volumeCheckpoints, []);
  }
  assert.throws(() => repo.exchangeWithAssignment({ ...current,
    submission: { kind: "cell.volume.checkpoint", expectedSequence: 1, recordHex: volumeRecords[1]! } }), /sequence changed/u);
  assert.throws(() => repo.appendVolumeCheckpoint({ ...claim, provisioningOwner: "foreign", ...volumeWrite.submission }), /unexpired claim/u);
  const foreign = Buffer.from(volumeRecords[0]!, "hex"); foreign[144] = foreign[144]! ^ 1;
  assert.throws(() => repo.exchangeWithAssignment({ ...volumeWrite,
    submission: { ...volumeWrite.submission, recordHex: rehashVolumeFixture(foreign) } }), /metadata is invalid/u);
  const appendVolume = repo.appendVolumeCheckpoint.bind(repo);
  repo.appendVolumeCheckpoint = (command) => {
    const result = appendVolume(command);
    const parent = clock.getRun(manifest.durableRunId);
    clock.updateRun({ runId: parent.runId, status: "cancelled", clearLease: true, expectedVersion: parent.version });
    return result;
  };
  assert.throws(() => repo.exchangeWithAssignment(volumeWrite));
  repo.appendVolumeCheckpoint = appendVolume;
  assert.equal(clock.getRun(manifest.durableRunId).status, "running");
  assert.deepEqual(repo.getSnapshot(key)?.volumeCheckpoints, []);
  for (let index = 0; index < volumeRecords.length; index++) {
    const response = repo.exchangeWithAssignment({ ...current, submission: { kind: "cell.volume.checkpoint",
      expectedSequence: index, recordHex: volumeRecords[index]! } });
    assert.deepEqual(response.volumeRecords, volumeRecords.slice(0, index + 1));
    assert.deepEqual(response.records, completed);
  }
  assert.deepEqual(new RemoteWorkerCellProvisioningRepository(db).exchangeWithAssignment(volumeWrite), withVolume);
  // The first observed GPT snapshot could be individually valid with a different
  // MSR ID, but an acknowledged record can never be replaced by that alternative.
  const replacement = Buffer.from(volumeRecords[3]!, "hex"); replacement[460] = replacement[460]! ^ 1;
  rehashVolumeFixture(replacement.subarray(280, 792));
  assert.throws(() => repo.exchangeWithAssignment({ ...current, submission: { kind: "cell.volume.checkpoint",
    expectedSequence: 3, recordHex: rehashVolumeFixture(replacement) } }), /cannot be replaced/u);
  assert.throws(() => db.prepare("UPDATE remote_worker_cell_volume_checkpoints SET phase = phase WHERE assignment_id = @assignmentId")
    .run({ assignmentId: key.assignmentId }), /immutable/u);
  assert.throws(() => db.prepare("DELETE FROM remote_worker_cell_volume_checkpoints WHERE assignment_id = @assignmentId")
    .run({ assignmentId: key.assignmentId }), /retained/u);
  for (const patch of [{ assignmentId: "foreign" }, { registryWorkspaceId: "foreign" }, { assignmentGeneration: 2 },
    { leaseRevision: input.leaseRevision }, { leaseTokenSha256 },
    { protectedAuthority: { ...fence, credentialAuthority: { ...fence.credentialAuthority, credentialGeneration: 999 } } }]) {
    assert.throws(() => repo.exchangeWithAssignment({ ...formatWrite, ...patch }));
    assert.deepEqual(repo.getSnapshot(key)?.formatCheckpoints, []);
  }
  assert.throws(() => repo.exchangeWithAssignment({ ...current,
    submission: { kind: "cell.format.checkpoint", expectedSequence: 1, recordHex: formatRecords[1]! } }), /sequence changed/u);
  assert.throws(() => repo.appendFormatCheckpoint({ ...claim, provisioningOwner: "foreign", ...formatWrite.submission }), /unexpired claim/u);
  const foreignFormat = Buffer.from(formatRecords[0]!, "hex"); foreignFormat[144] = foreignFormat[144]! ^ 1;
  assert.throws(() => repo.exchangeWithAssignment({ ...formatWrite,
    submission: { ...formatWrite.submission, recordHex: rehashVolumeFixture(foreignFormat) } }), /metadata is invalid/u);
  const appendFormat = repo.appendFormatCheckpoint.bind(repo);
  repo.appendFormatCheckpoint = (command) => {
    const result = appendFormat(command);
    const parent = clock.getRun(manifest.durableRunId);
    clock.updateRun({ runId: parent.runId, status: "cancelled", clearLease: true, expectedVersion: parent.version });
    return result;
  };
  assert.throws(() => repo.exchangeWithAssignment(formatWrite));
  repo.appendFormatCheckpoint = appendFormat;
  assert.equal(clock.getRun(manifest.durableRunId).status, "running");
  assert.deepEqual(repo.getSnapshot(key)?.formatCheckpoints, []);
  for (let index = 0; index < formatRecords.length; index++) {
    const response = repo.exchangeWithAssignment({ ...current, submission: { kind: "cell.format.checkpoint",
      expectedSequence: index, recordHex: formatRecords[index]! } });
    assert.deepEqual(response.formatRecords, formatRecords.slice(0, index + 1));
    assert.deepEqual(response.volumeRecords, volumeRecords);
    assert.deepEqual(response.records, completed);
  }
  assert.deepEqual(new RemoteWorkerCellProvisioningRepository(db).exchangeWithAssignment(formatWrite), withFormat);
  const formatReplacement = Buffer.from(formatRecords[1]!, "hex"); formatReplacement[464] = formatReplacement[464]! ^ 1;
  rehashVolumeFixture(formatReplacement.subarray(280, 792));
  assert.throws(() => repo.exchangeWithAssignment({ ...current, submission: { kind: "cell.format.checkpoint",
    expectedSequence: 1, recordHex: rehashVolumeFixture(formatReplacement) } }), /cannot be replaced/u);
  assert.throws(() => db.prepare("UPDATE remote_worker_cell_format_checkpoints SET phase = phase WHERE assignment_id = @assignmentId")
    .run({ assignmentId: key.assignmentId }), /immutable/u);
  assert.throws(() => db.prepare("DELETE FROM remote_worker_cell_format_checkpoints WHERE assignment_id = @assignmentId")
    .run({ assignmentId: key.assignmentId }), /retained/u);
  const withProtection = protectionExchangeFixture(withFormat), protectionRecords = withProtection.protectionRecords!;
  const protectionWrite = { ...current, submission: { kind: "cell.protection.checkpoint" as const,
    expectedSequence: 0, recordHex: protectionRecords[0]! } };
  for (const patch of [{ assignmentId: "foreign" }, { registryWorkspaceId: "foreign" }, { assignmentGeneration: 2 },
    { leaseRevision: input.leaseRevision }, { leaseTokenSha256 },
    { protectedAuthority: { ...fence, credentialAuthority: { ...fence.credentialAuthority, credentialGeneration: 999 } } }]) {
    assert.throws(() => repo.exchangeWithAssignment({ ...protectionWrite, ...patch }));
    assert.deepEqual(repo.getSnapshot(key)?.protectionCheckpoints, []);
  }
  assert.throws(() => repo.exchangeWithAssignment({ ...current,
    submission: { kind: "cell.protection.checkpoint", expectedSequence: 1, recordHex: protectionRecords[1]! } }), /sequence changed/u);
  assert.throws(() => repo.appendProtectionCheckpoint({ ...claim, provisioningOwner: "foreign", ...protectionWrite.submission }), /unexpired claim/u);
  for (const offset of [144, 360, 440]) {
    const foreign = Buffer.from(protectionRecords[0]!, "hex"); foreign[offset] = foreign[offset]! ^ 1;
    rehashVolumeFixture(foreign.subarray(280, 792));
    assert.throws(() => repo.exchangeWithAssignment({ ...protectionWrite,
      submission: { ...protectionWrite.submission, recordHex: rehashVolumeFixture(foreign) } }), /metadata is invalid/u);
  }
  const appendProtection = repo.appendProtectionCheckpoint.bind(repo);
  repo.appendProtectionCheckpoint = (command) => {
    const result = appendProtection(command), parent = clock.getRun(manifest.durableRunId);
    clock.updateRun({ runId: parent.runId, status: "cancelled", clearLease: true, expectedVersion: parent.version });
    return result;
  };
  assert.throws(() => repo.exchangeWithAssignment(protectionWrite));
  repo.appendProtectionCheckpoint = appendProtection;
  assert.equal(clock.getRun(manifest.durableRunId).status, "running");
  assert.deepEqual(repo.getSnapshot(key)?.protectionCheckpoints, []);
  for (let index = 0; index < protectionRecords.length; index++) {
    const response = repo.exchangeWithAssignment({ ...current, submission: { kind: "cell.protection.checkpoint",
      expectedSequence: index, recordHex: protectionRecords[index]! } });
    assert.deepEqual(response.protectionRecords, protectionRecords.slice(0, index + 1));
    assert.deepEqual(response.formatRecords, formatRecords); assert.deepEqual(response.volumeRecords, volumeRecords);
    assert.deepEqual(response.records, completed);
  }
  assert.deepEqual(new RemoteWorkerCellProvisioningRepository(db).exchangeWithAssignment(protectionWrite), withProtection);
  const rootReplacement = Buffer.from(protectionRecords[1]!, "hex"); rootReplacement[448] = rootReplacement[448]! ^ 1;
  rehashVolumeFixture(rootReplacement.subarray(280, 792));
  assert.throws(() => repo.exchangeWithAssignment({ ...current, submission: { kind: "cell.protection.checkpoint",
    expectedSequence: 1, recordHex: rehashVolumeFixture(rootReplacement) } }), /cannot be replaced/u);
  assert.throws(() => db.prepare("UPDATE remote_worker_cell_protection_checkpoints SET phase = phase WHERE assignment_id = @assignmentId")
    .run({ assignmentId: key.assignmentId }), /immutable/u);
  assert.throws(() => db.prepare("DELETE FROM remote_worker_cell_protection_checkpoints WHERE assignment_id = @assignmentId")
    .run({ assignmentId: key.assignmentId }), /retained/u);
  const withMount = mountExchangeFixture(withProtection), mountRecords = withMount.mountRecords!;
  const mountWrite = { ...current, submission: { kind: "cell.mount.checkpoint" as const,
    expectedSequence: 0, recordHex: mountRecords[0]! } };
  for (const patch of [{ assignmentId: "foreign" }, { registryWorkspaceId: "foreign" }, { assignmentGeneration: 2 },
    { leaseRevision: input.leaseRevision }, { leaseTokenSha256 },
    { protectedAuthority: { ...fence, credentialAuthority: { ...fence.credentialAuthority, credentialGeneration: 999 } } }]) {
    assert.throws(() => repo.exchangeWithAssignment({ ...mountWrite, ...patch }));
    assert.deepEqual(repo.getSnapshot(key)?.mountCheckpoints, []);
  }
  assert.throws(() => repo.exchangeWithAssignment({ ...current,
    submission: { kind: "cell.mount.checkpoint", expectedSequence: 1, recordHex: mountRecords[1]! } }), /sequence changed/u);
  assert.throws(() => repo.appendMountCheckpoint({ ...claim, provisioningOwner: "foreign", ...mountWrite.submission }), /unexpired claim/u);
  for (const offset of [144, 360, 408]) {
    const foreign = Buffer.from(mountRecords[0]!, "hex"); foreign[offset] = foreign[offset]! ^ 1;
    rehashVolumeFixture(foreign.subarray(280, 792));
    assert.throws(() => repo.exchangeWithAssignment({ ...mountWrite,
      submission: { ...mountWrite.submission, recordHex: rehashVolumeFixture(foreign) } }), /metadata is invalid/u);
  }
  const appendMount = repo.appendMountCheckpoint.bind(repo);
  repo.appendMountCheckpoint = (command) => {
    const result = appendMount(command), parent = clock.getRun(manifest.durableRunId);
    clock.updateRun({ runId: parent.runId, status: "cancelled", clearLease: true, expectedVersion: parent.version });
    return result;
  };
  assert.throws(() => repo.exchangeWithAssignment(mountWrite));
  repo.appendMountCheckpoint = appendMount;
  assert.equal(clock.getRun(manifest.durableRunId).status, "running");
  assert.deepEqual(repo.getSnapshot(key)?.mountCheckpoints, []);
  const pendingWorkspace = mountedWorkspaceExchangeFixture(withMount).mountedWorkspaceRecords![0]!;
  const rawWorkspaceInsert = () => db.prepare(`INSERT INTO remote_worker_cell_mounted_workspace_checkpoints
    (registry_workspace_id, assignment_id, assignment_generation, sequence, phase, record_hex, record_sha256,
      previous_record_sha256, mount_recorded_sha256, recorded_at) VALUES
    (@registryWorkspaceId, @assignmentId, @assignmentGeneration, 1, 'intent', @record, @hash, @previous, @previous, @now)`)
    .run({ ...key, record: pendingWorkspace, hash: pendingWorkspace.slice(-64), previous: mountRecords[3]!.slice(-64), now: clock.readDatabaseNow() });
  for (let index = 0; index < mountRecords.length; index++) {
    assert.throws(rawWorkspaceInsert, /authority or order/u);
    assert.throws(() => repo.appendMountedWorkspaceCheckpoint({ ...claim, expectedSequence: 0, recordHex: pendingWorkspace }), /all four canonical mount/u);
    const response = repo.exchangeWithAssignment({ ...current, submission: { kind: "cell.mount.checkpoint",
      expectedSequence: index, recordHex: mountRecords[index]! } });
    assert.deepEqual(response.mountRecords, mountRecords.slice(0, index + 1));
    assert.deepEqual(response.protectionRecords, protectionRecords);
    assert.deepEqual(response.formatRecords, formatRecords); assert.deepEqual(response.volumeRecords, volumeRecords);
    assert.deepEqual(response.records, completed);
  }
  assert.deepEqual(new RemoteWorkerCellProvisioningRepository(db).exchangeWithAssignment(mountWrite), withMount);
  const directoryReplacement = Buffer.from(mountRecords[1]!, "hex"); directoryReplacement[464] = directoryReplacement[464]! ^ 1;
  rehashVolumeFixture(directoryReplacement.subarray(280, 792));
  assert.throws(() => repo.exchangeWithAssignment({ ...current, submission: { kind: "cell.mount.checkpoint",
    expectedSequence: 1, recordHex: rehashVolumeFixture(directoryReplacement) } }), /cannot be replaced/u);
  assert.throws(() => db.prepare("UPDATE remote_worker_cell_mount_checkpoints SET phase = phase WHERE assignment_id = @assignmentId")
    .run({ assignmentId: key.assignmentId }), /immutable/u);
  assert.throws(() => db.prepare("DELETE FROM remote_worker_cell_mount_checkpoints WHERE assignment_id = @assignmentId")
    .run({ assignmentId: key.assignmentId }), /retained/u);
  const withWorkspace = mountedWorkspaceExchangeFixture(withMount), mountedWorkspaceRecords = withWorkspace.mountedWorkspaceRecords!;
  const workspaceWrite = { ...current, submission: { kind: "cell.mounted-workspace.checkpoint" as const,
    expectedSequence: 0, recordHex: mountedWorkspaceRecords[0]! } };
  for (const patch of [{ assignmentId: "foreign" }, { registryWorkspaceId: "foreign" }, { assignmentGeneration: 2 },
    { leaseRevision: input.leaseRevision }, { leaseTokenSha256 },
    { protectedAuthority: { ...fence, credentialAuthority: { ...fence.credentialAuthority, credentialGeneration: 999 } } }]) {
    assert.throws(() => repo.exchangeWithAssignment({ ...workspaceWrite, ...patch }));
    assert.deepEqual(repo.getSnapshot(key)?.mountedWorkspaceCheckpoints, []);
  }
  assert.throws(() => repo.exchangeWithAssignment({ ...current,
    submission: { kind: "cell.mounted-workspace.checkpoint", expectedSequence: 1, recordHex: mountedWorkspaceRecords[1]! } }), /sequence changed/u);
  assert.throws(() => repo.appendMountedWorkspaceCheckpoint({ ...claim, provisioningOwner: "foreign", ...workspaceWrite.submission }), /unexpired claim/u);
  for (const offset of [144, 360, 392, 432]) {
    const foreign = Buffer.from(mountedWorkspaceRecords[0]!, "hex"); foreign[offset] = foreign[offset]! ^ 1;
    rehashVolumeFixture(foreign.subarray(280, 792));
    assert.throws(() => repo.exchangeWithAssignment({ ...workspaceWrite,
      submission: { ...workspaceWrite.submission, recordHex: rehashVolumeFixture(foreign) } }), /metadata is invalid/u);
  }
  const appendMountedWorkspace = repo.appendMountedWorkspaceCheckpoint.bind(repo);
  repo.appendMountedWorkspaceCheckpoint = (command) => {
    const result = appendMountedWorkspace(command), parent = clock.getRun(manifest.durableRunId);
    clock.updateRun({ runId: parent.runId, status: "cancelled", clearLease: true, expectedVersion: parent.version });
    return result;
  };
  assert.throws(() => repo.exchangeWithAssignment(workspaceWrite));
  repo.appendMountedWorkspaceCheckpoint = appendMountedWorkspace;
  assert.equal(clock.getRun(manifest.durableRunId).status, "running");
  assert.deepEqual(repo.getSnapshot(key)?.mountedWorkspaceCheckpoints, []);
  for (let index = 0; index < mountedWorkspaceRecords.length; index++) {
    const response = repo.exchangeWithAssignment({ ...current, submission: { kind: "cell.mounted-workspace.checkpoint",
      expectedSequence: index, recordHex: mountedWorkspaceRecords[index]! } });
    assert.deepEqual(response.mountedWorkspaceRecords, mountedWorkspaceRecords.slice(0, index + 1));
    assert.deepEqual(response.protectionRecords, protectionRecords);
    assert.deepEqual(response.formatRecords, formatRecords); assert.deepEqual(response.volumeRecords, volumeRecords);
    assert.deepEqual(response.records, completed);
  }
  assert.deepEqual(new RemoteWorkerCellProvisioningRepository(db).exchangeWithAssignment(workspaceWrite), withWorkspace);
  const workspaceReplacement = Buffer.from(mountedWorkspaceRecords[1]!, "hex"); workspaceReplacement[464] = workspaceReplacement[464]! ^ 1;
  rehashVolumeFixture(workspaceReplacement.subarray(280, 792));
  assert.throws(() => repo.exchangeWithAssignment({ ...current, submission: { kind: "cell.mounted-workspace.checkpoint",
    expectedSequence: 1, recordHex: rehashVolumeFixture(workspaceReplacement) } }), /cannot be replaced/u);
  assert.throws(() => db.prepare("UPDATE remote_worker_cell_mounted_workspace_checkpoints SET phase = phase WHERE assignment_id = @assignmentId")
    .run({ assignmentId: key.assignmentId }), /immutable/u);
  assert.throws(() => db.prepare("DELETE FROM remote_worker_cell_mounted_workspace_checkpoints WHERE assignment_id = @assignmentId")
    .run({ assignmentId: key.assignmentId }), /retained/u);
  assert.equal(cells.getCell(key)?.executionState, "provisioning");
  const afterRevoke = onComplete?.(current, withWorkspace);
  if (retainFixture) return;
  revoke();
  afterRevoke?.();
  assert.throws(() => repo.exchangeWithAssignment(current));
  assert.throws(() => repo.exchangeWithAssignment({ ...write, ...current, submission: write.submission }));
  assert.throws(() => repo.exchangeWithAssignment(volumeWrite));
  assert.throws(() => repo.exchangeWithAssignment(formatWrite));
  assert.throws(() => repo.exchangeWithAssignment(protectionWrite));
  assert.throws(() => repo.exchangeWithAssignment(mountWrite));
  assert.throws(() => repo.exchangeWithAssignment(workspaceWrite));
  assert.deepEqual(repo.getSnapshot(key)?.mountedWorkspaceCheckpoints.map((checkpoint) => checkpoint.recordHex), mountedWorkspaceRecords);
  assert.deepEqual(repo.getSnapshot(key)?.mountCheckpoints.map((checkpoint) => checkpoint.recordHex), mountRecords);
  assert.deepEqual(repo.getSnapshot(key)?.checkpoints.map((checkpoint) => checkpoint.recordHex), completed);
  assert.deepEqual(repo.getSnapshot(key)?.volumeCheckpoints.map((checkpoint) => checkpoint.recordHex), volumeRecords);
  assert.deepEqual(repo.getSnapshot(key)?.formatCheckpoints.map((checkpoint) => checkpoint.recordHex), formatRecords);
  assert.deepEqual(repo.getSnapshot(key)?.protectionCheckpoints.map((checkpoint) => checkpoint.recordHex), protectionRecords);
}
