import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  REMOTE_WORKER_CELL_PROFILE_V2_SCHEMA_VERSION, REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
  remoteWorkerCellProvisioningBindingSha256,
  REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION, remoteWorkerCellProvisioningPlanSha256,
  type RemoteWorkerCellProfile, type RemoteWorkerCellProvisioningPlan,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerCellProvisioningRepository } from "./remote-worker-cell-provisioning-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { volumeExchangeFixture } from "../../contracts/src/remote-worker-cell-volume-test-fixture.js";
import { formatExchangeFixture } from "../../contracts/src/remote-worker-cell-format-test-fixture.js";
import { protectionExchangeFixture } from "../../contracts/src/remote-worker-cell-protection-test-fixture.js";
import { mountExchangeFixture } from "../../contracts/src/remote-worker-cell-mount-test-fixture.js";

/** Independent Node encoder for the fixed C++ journal test format. */
export function checkpointFixture(plan: RemoteWorkerCellProvisioningPlan, sequence: number, previous = "0".repeat(64)): string {
  const bytes = Buffer.alloc(1024);
  bytes.write("GCCELLP1", 0, "ascii"); bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(sequence, 12);
  for (const [offset, value] of [[16, previous], [48, plan.assignmentBindingSha256], [80, plan.profileSha256],
    [112, plan.diskIdentifierHex], [144, plan.parentIdentityHex], [168, fileIdentity(2)]] as const) {
    Buffer.from(value, "hex").copy(bytes, offset);
  }
  bytes.writeBigUInt64LE(BigInt(plan.virtualDiskBytes), 128); bytes.writeBigUInt64LE(BigInt(plan.reservedDiskBytes), 136);
  bytes.write(plan.cellName, 192, "ascii"); bytes.write(plan.ownerSid, 232, "ascii"); bytes.write(plan.controllerSid, 416, "ascii");
  if (sequence >= 3) for (let index = 0; index < 4; index++) Buffer.from(fileIdentity(index + 3), "hex").copy(bytes, 600 + index * 24);
  if (sequence === 5) Buffer.from(fileIdentity(7), "hex").copy(bytes, 696);
  createHash("sha256").update(bytes.subarray(0, 992)).digest().copy(bytes, 992);
  return bytes.toString("hex");
}
function fileIdentity(index: number): string { return "0100000000000000" + index.toString(16).padStart(32, "0"); }

export async function assertCanonicalProvisioningCheckpoints(db: DatabaseClient, sourceProfile: RemoteWorkerCellProfile): Promise<void> {
  const cells = new RemoteWorkerCellRepository(db);
  const repo = new RemoteWorkerCellProvisioningRepository(db);
  const clock = new DurableRunRepository(db);
  const profile: RemoteWorkerCellProfile = { ...sourceProfile, schemaVersion: REMOTE_WORKER_CELL_PROFILE_V2_SCHEMA_VERSION,
    backend: "windows_native", egressPosture: "deny_all", capacity: { ...sourceProfile.capacity,
      logicalDiskBytes: 64 * 1024 * 1024, allocatedDiskBytes: 130 * 1024 * 1024 } };
  const key = { registryWorkspaceId: profile.registryWorkspaceId, assignmentId: profile.assignmentId,
    assignmentGeneration: profile.assignmentGeneration };
  cells.profileOrReplay({ profile, idempotencyKey: `checkpoint:${profile.cellId}`, createdAt: clock.readDatabaseNow() });
  const authority = { ...key, provisioningOwner: "checkpoint-owner",
    provisioningLeaseExpiresAt: new Date(Date.parse(clock.readDatabaseNow()) + 10_000).toISOString() };
  const claimed = cells.claimProvisioning({ ...authority, leaseExpiresAt: authority.provisioningLeaseExpiresAt,
    detailSha256: "a".repeat(64), now: clock.readDatabaseNow() })!;
  const plan: RemoteWorkerCellProvisioningPlan = {
    schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
    assignmentBindingSha256: remoteWorkerCellProvisioningBindingSha256({ ...authority, cellId: claimed.cellId,
      workerId: claimed.workerId, workerGeneration: claimed.workerGeneration, profileSha256: claimed.profileSha256 }),
    profileSha256: claimed.profileSha256, parentIdentityHex: fileIdentity(1), cellName: `gc-cell-${"1".repeat(32)}`,
    ownerSid: "S-1-5-18", controllerSid: "S-1-5-80-1-2-3-4-5", diskIdentifierHex: "3".repeat(32),
    virtualDiskBytes: 64 * 1024 * 1024, reservedDiskBytes: 128 * 1024 * 1024,
  };
  const input = { ...authority, plan, expectedCapacityRevision: claimed.capacityRevision };
  assert.throws(() => repo.prepare({ ...input, plan: { ...plan, assignmentBindingSha256: "b".repeat(64) } }), /canonical profile/u);
  assert.throws(() => repo.prepare({ ...input, plan: { ...plan, reservedDiskBytes: 131 * 1024 * 1024 } }), /reservation/u);
  assert.throws(() => repo.prepare({ ...input, expectedCapacityRevision: 9 }), /capacity revision/u);
  assert.equal(repo.getSnapshot(key), undefined);
  assert.equal(repo.prepare(input).disposition, "created");
  assert.equal(repo.prepare(input).disposition, "replayed");
  assert.throws(() => repo.prepare({ ...input, plan: { ...plan, diskIdentifierHex: "4".repeat(32) } }), /immutable/u);
  const prepared = checkpointFixture(plan, 1);
  repo.appendCheckpoint({ ...authority, expectedSequence: 0, recordHex: prepared });
  const anchor = repo.getSnapshot(key)!;
  assert.equal(anchor.checkpoints.length, 1);
  assert.equal(repo.appendCheckpoint({ ...authority, expectedSequence: 0, recordHex: prepared }).recordHex, prepared);
  assert.throws(() => repo.appendCheckpoint({ ...authority, expectedSequence: 2,
    recordHex: checkpointFixture(plan, 3, prepared.slice(-64)) }), /sequence changed/u);
  assert.throws(() => repo.appendCheckpoint({ ...authority, expectedSequence: 0,
    recordHex: checkpointFixture({ ...plan, diskIdentifierHex: "4".repeat(32) }, 1) }), /cannot be replaced/u);
  assert.throws(() => repo.appendCheckpoint({ ...authority, expectedSequence: 1,
    recordHex: checkpointFixture(plan, 2, "e".repeat(64)) }), /metadata is invalid/u);
  assert.deepEqual(repo.getSnapshot(key), anchor);
  let previous = prepared.slice(-64);
  for (let sequence = 2; sequence <= 5; sequence++) {
    const recordHex = checkpointFixture(plan, sequence, previous);
    repo.appendCheckpoint({ ...authority, expectedSequence: sequence - 1, recordHex });
    previous = recordHex.slice(-64);
  }
  const complete = repo.getSnapshot(key)!;
  assert.equal(complete.checkpoints.length, 5);
  assert.equal(complete.checkpoints.at(-1)?.phase, "disk_recorded");
  assert.deepEqual(new RemoteWorkerCellProvisioningRepository(db).getSnapshot(key), complete);
  assert.equal(cells.getCell(key)?.executionState, "provisioning", "resource records do not mark the platform ready");
  for (const table of ["remote_worker_cell_provisioning", "remote_worker_cell_provisioning_checkpoints"]) {
    assert.throws(() => db.prepare(`DELETE FROM ${table} WHERE assignment_id = @assignmentId`).run({ assignmentId: key.assignmentId }), /immutable|retained/u);
    assert.throws(() => db.prepare(`UPDATE ${table} SET assignment_id = assignment_id WHERE assignment_id = @assignmentId`).run({ assignmentId: key.assignmentId }), /immutable/u);
  }
  const last = complete.checkpoints.at(-1)!;
  assert.throws(() => db.prepare(`INSERT INTO remote_worker_cell_provisioning_checkpoints
    (registry_workspace_id, assignment_id, assignment_generation, sequence, phase, record_hex, record_sha256,
      previous_record_sha256, recorded_at) VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration,
      6, 'disk_recorded', @recordHex, @recordSha256, @previousRecordSha256, @now)`)
    .run({ ...key, recordHex: last.recordHex, recordSha256: last.recordSha256, previousRecordSha256: last.recordSha256,
      now: clock.readDatabaseNow() }), /constraint|CHECK|checkpoint/iu);
  const volume = volumeExchangeFixture({ schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
    ...key, leaseRevision: 1, plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan),
    records: complete.checkpoints.map((record) => record.recordHex) });
  const firstVolume = volume.volumeRecords![0]!, secondVolume = volume.volumeRecords![1]!;
  const rawInsert = (sequence: number, recordHex: string, previousRecordSha256: string) => db.prepare(`INSERT INTO remote_worker_cell_volume_checkpoints
    (registry_workspace_id, assignment_id, assignment_generation, sequence, phase, record_hex, record_sha256,
      previous_record_sha256, disk_recorded_sha256, recorded_at) VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration,
      @sequence, 'attached', @recordHex, @recordSha256, @previousRecordSha256, @diskRecordedSha256, @now)`)
    .run({ ...key, sequence, recordHex, recordSha256: recordHex.slice(-64), previousRecordSha256,
      diskRecordedSha256: last.recordSha256, now: "2000-01-01T00:00:00.000Z" });
  assert.throws(() => rawInsert(2, secondVolume, firstVolume.slice(-64)), /authority|order|constraint/iu);
  repo.appendVolumeCheckpoint({ ...authority, expectedSequence: 0, recordHex: firstVolume });
  for (let index = 1; index < volume.volumeRecords!.length; index++) {
    repo.appendVolumeCheckpoint({ ...authority, expectedSequence: index, recordHex: volume.volumeRecords![index]! });
  }
  const formats = formatExchangeFixture(volume).formatRecords!;
  const rawFormatInsert = () => db.prepare(`INSERT INTO remote_worker_cell_format_checkpoints
    (registry_workspace_id, assignment_id, assignment_generation, sequence, phase, record_hex, record_sha256,
      previous_record_sha256, volume_recorded_sha256, recorded_at) VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration,
      2, 'formatted', @recordHex, @recordSha256, @previousRecordSha256, @volumeRecordedSha256, @now)`)
    .run({ ...key, recordHex: formats[1]!, recordSha256: formats[1]!.slice(-64), previousRecordSha256: formats[0]!.slice(-64),
      volumeRecordedSha256: volume.volumeRecords!.at(-1)!.slice(-64), now: "2000-01-01T00:00:00.000Z" });
  assert.throws(rawFormatInsert, /authority|order/iu);
  repo.appendFormatCheckpoint({ ...authority, expectedSequence: 0, recordHex: formats[0]! });
  const protections = protectionExchangeFixture(volume).protectionRecords!;
  const rawProtectionInsert = () => db.prepare(`INSERT INTO remote_worker_cell_protection_checkpoints
    (registry_workspace_id, assignment_id, assignment_generation, sequence, phase, record_hex, record_sha256,
      previous_record_sha256, format_recorded_sha256, recorded_at) VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration,
      2, 'protected_root', @recordHex, @recordSha256, @previousRecordSha256, @formatRecordedSha256, @now)`)
    .run({ ...key, recordHex: protections[1]!, recordSha256: protections[1]!.slice(-64), previousRecordSha256: protections[0]!.slice(-64),
      formatRecordedSha256: formats[1]!.slice(-64), now: "2000-01-01T00:00:00.000Z" });
  assert.throws(() => repo.appendProtectionCheckpoint({ ...authority, expectedSequence: 0, recordHex: protections[0]! }), /both canonical format/u);
  assert.throws(rawProtectionInsert, /authority|order/iu);
  repo.appendFormatCheckpoint({ ...authority, expectedSequence: 1, recordHex: formats[1]! });
  assert.throws(rawProtectionInsert, /authority|order/iu);
  repo.appendProtectionCheckpoint({ ...authority, expectedSequence: 0, recordHex: protections[0]! });
  const mounts = mountExchangeFixture(volume).mountRecords!;
  const rawMountInsert = () => db.prepare(`INSERT INTO remote_worker_cell_mount_checkpoints
    (registry_workspace_id, assignment_id, assignment_generation, sequence, phase, record_hex, record_sha256,
      previous_record_sha256, protection_recorded_sha256, recorded_at) VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration,
      2, 'directory_recorded', @recordHex, @recordSha256, @previousRecordSha256, @protectionRecordedSha256, @now)`)
    .run({ ...key, recordHex: mounts[1]!, recordSha256: mounts[1]!.slice(-64), previousRecordSha256: mounts[0]!.slice(-64),
      protectionRecordedSha256: protections[1]!.slice(-64), now: "2000-01-01T00:00:00.000Z" });
  assert.throws(() => repo.appendMountCheckpoint({ ...authority, expectedSequence: 0, recordHex: mounts[0]! }), /both canonical protection/u);
  assert.throws(rawMountInsert, /authority|order/iu);
  repo.appendProtectionCheckpoint({ ...authority, expectedSequence: 1, recordHex: protections[1]! });
  assert.throws(rawMountInsert, /authority|order/iu);
  assert.throws(() => repo.appendMountCheckpoint({ ...authority, provisioningOwner: "competitor", expectedSequence: 0, recordHex: mounts[0]! }), /unexpired claim/u);
  assert.throws(() => repo.appendMountCheckpoint({ ...authority, expectedSequence: 1, recordHex: mounts[1]! }), /sequence/u);
  for (let index = 0; index < mounts.length; index++) {
    const input = { ...authority, expectedSequence: index, recordHex: mounts[index]! };
    const before = repo.getSnapshot(key);
    assert.throws(() => db.transaction("immediate", () => {
      repo.appendMountCheckpoint(input);
      throw new Error("controlled post-insert failure");
    }), /controlled post-insert failure/u);
    assert.deepEqual(repo.getSnapshot(key), before, "an aborted append cannot leave mount evidence");
    const checkpoint = repo.appendMountCheckpoint(input);
    assert.equal(checkpoint.recordHex, mounts[index]);
    assert.deepEqual(repo.appendMountCheckpoint(input), checkpoint, "only exact replay is acknowledged");
  }
  assert.deepEqual(repo.getSnapshot(key)?.mountCheckpoints.map((record) => record.recordHex), mounts);
  assert.equal(cells.getCell(key)?.executionState, "provisioning", "mount records do not establish current platform readiness");
  assert.throws(() => db.prepare("UPDATE remote_worker_cell_mount_checkpoints SET phase = phase WHERE assignment_id = @assignmentId")
    .run({ assignmentId: key.assignmentId }), /immutable/u);
  assert.throws(() => db.prepare("DELETE FROM remote_worker_cell_mount_checkpoints WHERE assignment_id = @assignmentId")
    .run({ assignmentId: key.assignmentId }), /immutable|retained/u);
  const retained = repo.getSnapshot(key);
  const deadline = Date.now() + 15_000;
  while (clock.readDatabaseNow() < authority.provisioningLeaseExpiresAt) {
    assert.ok(Date.now() < deadline); await delay(25);
  }
  assert.throws(() => repo.appendCheckpoint({ ...authority, expectedSequence: 0, recordHex: prepared }), /unexpired claim/u);
  assert.throws(() => repo.appendVolumeCheckpoint({ ...authority, expectedSequence: 0, recordHex: firstVolume }), /unexpired claim/u);
  assert.throws(() => repo.appendVolumeCheckpoint({ ...authority, expectedSequence: 1, recordHex: secondVolume }), /unexpired claim/u);
  assert.throws(() => rawInsert(2, secondVolume, firstVolume.slice(-64)), /authority|order/iu);
  assert.throws(() => repo.appendFormatCheckpoint({ ...authority, expectedSequence: 0, recordHex: formats[0]! }), /unexpired claim/u);
  assert.throws(() => repo.appendFormatCheckpoint({ ...authority, expectedSequence: 1, recordHex: formats[1]! }), /unexpired claim/u);
  assert.throws(rawFormatInsert, /authority|order/iu);
  assert.throws(() => repo.appendProtectionCheckpoint({ ...authority, expectedSequence: 0, recordHex: protections[0]! }), /unexpired claim/u);
  assert.throws(() => repo.appendProtectionCheckpoint({ ...authority, expectedSequence: 1, recordHex: protections[1]! }), /unexpired claim/u);
  assert.throws(rawProtectionInsert, /authority|order/iu);
  assert.throws(() => repo.appendMountCheckpoint({ ...authority, expectedSequence: 0, recordHex: mounts[0]! }), /unexpired claim/u);
  assert.throws(() => repo.appendMountCheckpoint({ ...authority, expectedSequence: 3, recordHex: mounts[3]! }), /unexpired claim/u);
  assert.throws(rawMountInsert, /authority|order/iu);
  assert.deepEqual(repo.getSnapshot(key), retained, "expired claims cannot change retained provisioning, volume, format, protection or mount facts");
}
