import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRemoteWorkerCellDiskLayoutPlan } from "./remote-worker-cell-disk-layout.js";
import { assertRemoteWorkerCellVolumeSuccessor, normalizeRemoteWorkerCellVolumeAnchor, normalizeRemoteWorkerCellVolumeSubmission,
  readRemoteWorkerCellVolumeCheckpoint, REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION,
  type RemoteWorkerCellVolumeCheckpoint } from "./remote-worker-cell-volume.js";

const mib = 1024 * 1024;
const plan = createRemoteWorkerCellDiskLayoutPlan({
  provisioningPlanSha256: "11".repeat(32), assignmentBindingSha256: "31".repeat(32), profileSha256: "42".repeat(32),
  diskIdentifierHex: "11111111222233438405060708090a0b", virtualDiskBytes: 256 * mib, reservedDiskBytes: 384 * mib,
  controlIdentityHex: "6500000000000000" + "21".repeat(16), backingIdentityHex: "6500000000000000" + "42".repeat(16),
});
const anchor = normalizeRemoteWorkerCellVolumeAnchor({ schemaVersion: REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION,
  diskRecordedSha256: "55".repeat(32), journalIdentityHex: "6500000000000000" + "77".repeat(16), layoutPlan: plan });
function rehash(bytes: Buffer): string {
  createHash("sha256").update(bytes.subarray(0, bytes.length - 32)).digest().copy(bytes, bytes.length - 32);
  return bytes.toString("hex");
}
// Independent byte fixtures do not call either production native encoder.
function layout(sequence: number, previous: string): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write("GCCGPT01", 0, "ascii"); bytes.writeUInt32LE(sequence, 8);
  for (const [offset, value] of [[16, previous], [48, plan.diskIdentifierHex], [80, plan.controlIdentityHex],
    [104, plan.backingIdentityHex], [128, "4eddab42e24b628fbd6d3dafaee72085"], [144, "e504537b26391f84ac32eb9e4b76e10d"]] as const)
    Buffer.from(value, "hex").copy(bytes, offset);
  bytes.writeBigUInt64LE(BigInt(plan.virtualDiskBytes), 64); bytes.writeBigUInt64LE(BigInt(plan.reservedDiskBytes), 72);
  bytes.writeUInt32LE(512, 388);
  if (sequence >= 2) {
    bytes.writeBigUInt64LE(17408n, 160); bytes.writeBigUInt64LE(BigInt(plan.virtualDiskBytes - 34304), 168);
    bytes.writeUInt32LE(128, 176); Buffer.from("44444444555566468708090a0b0c0d0e", "hex").copy(bytes, 180);
    bytes.writeBigUInt64LE(BigInt(mib), 196); bytes.writeBigUInt64LE(BigInt(16 * mib), 204);
    bytes.write("Microsoft reserved partition", 220, "utf16le");
    bytes.writeBigUInt64LE(BigInt(17 * mib), 292); bytes.writeBigUInt64LE(BigInt(238 * mib), 300);
    bytes.writeBigUInt64LE(0x8000000000000000n, 308); bytes.write("GoatCitadel cell", 316, "utf16le");
  }
  rehash(bytes);
  return bytes;
}
function volume(sequence: number, previous = anchor.diskRecordedSha256, layoutPrevious = "0".repeat(64)): Buffer {
  const bytes = Buffer.alloc(1024);
  bytes.write("GCCVOL01", 0, "ascii"); bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(sequence, 12);
  for (const [offset, value] of [[16, previous], [48, plan.assignmentBindingSha256], [80, plan.profileSha256],
    [112, plan.diskIdentifierHex], [144, anchor.journalIdentityHex], [168, plan.controlIdentityHex],
    [192, plan.backingIdentityHex], [216, anchor.diskRecordedSha256], [248, "4eddab42e24b628fbd6d3dafaee72085"],
    [264, "e504537b26391f84ac32eb9e4b76e10d"]] as const) Buffer.from(value, "hex").copy(bytes, offset);
  bytes.writeBigUInt64LE(BigInt(plan.virtualDiskBytes), 128); bytes.writeBigUInt64LE(BigInt(plan.reservedDiskBytes), 136);
  if (sequence >= 3) layout(sequence - 2, layoutPrevious).copy(bytes, 280);
  return bytes;
}
function chain(): RemoteWorkerCellVolumeCheckpoint[] {
  const records: RemoteWorkerCellVolumeCheckpoint[] = [];
  for (let sequence = 1; sequence <= 6; sequence++) {
    const previous = records.at(-1);
    records.push(readRemoteWorkerCellVolumeCheckpoint(anchor,
      rehash(volume(sequence, previous?.recordSha256, previous?.layoutCheckpoint?.recordSha256))));
  }
  return records;
}

describe("native volume provisioning journal", () => {
  it("accepts only bounded, intact submissions without caller-authored authority", () => {
    const submission = { kind: "cell.volume.checkpoint", expectedSequence: 0, recordHex: rehash(volume(1)) };
    expect(normalizeRemoteWorkerCellVolumeSubmission(submission)).toEqual(submission);
    for (const patch of [{ kind: "cell.provisioning.checkpoint" }, { expectedSequence: 1 }, { expectedSequence: -1 },
      { recordHex: submission.recordHex + "00" }, { recordHex: submission.recordHex.toUpperCase() },
      { recordHex: "0".repeat(2048) }, { approvalGranted: true }, { provisioningOwner: "worker" }])
      expect(() => normalizeRemoteWorkerCellVolumeSubmission({ ...submission, ...patch })).toThrow();
    let accessed = false;
    const hostile = Object.defineProperty({ ...submission }, "recordHex", { enumerable: true,
      get() { accessed = true; return submission.recordHex; } });
    expect(() => normalizeRemoteWorkerCellVolumeSubmission(hostile)).toThrow();
    expect(accessed).toBe(false);
    const bad = volume(1); bad[792] = 1;
    expect(() => normalizeRemoteWorkerCellVolumeSubmission({ ...submission, recordHex: rehash(bad) })).toThrow();
  });
  it("binds all six outer and four inner records to the independently retained disk checkpoint", () => {
    let previous: RemoteWorkerCellVolumeCheckpoint | undefined;
    for (const checkpoint of chain()) {
      assertRemoteWorkerCellVolumeSuccessor(anchor, previous, checkpoint);
      expect(Object.isFrozen(checkpoint)).toBe(true);
      expect(checkpoint.layoutCheckpoint?.sequence).toBe(checkpoint.sequence > 2 ? checkpoint.sequence - 2 : undefined);
      previous = checkpoint;
    }
    expect(previous?.phase).toBe("partitioned");
    expect(previous?.layoutCheckpoint?.snapshot?.dataLength).toBe(238 * mib);
  });

  it("rejects foreign journal identity, absent retained digest and accessor-provided authority", () => {
    for (const patch of [{ schemaVersion: "future" }, { diskRecordedSha256: "0".repeat(64) },
      { journalIdentityHex: plan.controlIdentityHex }, { journalIdentityHex: plan.backingIdentityHex },
      { journalIdentityHex: "6600000000000000" + "77".repeat(16) },
      { journalIdentityHex: "6500000000000000" + "0".repeat(32) }, { ready: true }])
      expect(() => normalizeRemoteWorkerCellVolumeAnchor({ ...anchor, ...patch })).toThrow();
    let called = false;
    const input = Object.defineProperty({ ...anchor }, "diskRecordedSha256", { enumerable: true,
      get() { called = true; return anchor.diskRecordedSha256; } });
    expect(() => normalizeRemoteWorkerCellVolumeAnchor(input)).toThrow();
    expect(called).toBe(false);
  });

  it("rejects correctly rehashed phase, binding, capacity, premature layout and reserved-byte drift", () => {
    for (const offset of [0, 8, 12, 16, 48, 80, 112, 128, 136, 144, 168, 192, 216, 248, 264, 280, 792, 991]) {
      const changed = volume(1); changed[offset] = changed[offset]! ^ 1;
      expect(() => readRemoteWorkerCellVolumeCheckpoint(anchor, rehash(changed)), `offset ${offset}`).toThrow();
    }
    const valid = rehash(volume(1));
    for (const bad of [valid.slice(2), valid + "00", valid.toUpperCase(), valid.slice(0, -2) + "ff", "0".repeat(2048)])
      expect(() => readRemoteWorkerCellVolumeCheckpoint(anchor, bad)).toThrow();
    expect(() => readRemoteWorkerCellVolumeCheckpoint({ ...anchor, diskRecordedSha256: "66".repeat(32) }, valid)).toThrow();
  });

  it("validates inner phase and digest independently of a valid outer hash", () => {
    const records = chain();
    const changed = Buffer.from(records[2]!.recordHex, "hex");
    layout(2, "99".repeat(32)).copy(changed, 280);
    expect(() => readRemoteWorkerCellVolumeCheckpoint(anchor, rehash(changed))).toThrow();
    const corrupt = Buffer.from(records[3]!.recordHex, "hex"); corrupt[280 + 200] = corrupt[280 + 200]! ^ 1;
    expect(() => readRemoteWorkerCellVolumeCheckpoint(anchor, rehash(corrupt))).toThrow();
  });

  it("refuses skipped/replayed outer phases and individually valid changed inner observations", () => {
    const records = chain();
    expect(() => assertRemoteWorkerCellVolumeSuccessor(anchor, undefined, records[1]!)).toThrow();
    expect(() => assertRemoteWorkerCellVolumeSuccessor(anchor, records[1], records[3]!)).toThrow();
    expect(() => assertRemoteWorkerCellVolumeSuccessor(anchor, records[2], records[2]!)).toThrow();
    const changed = Buffer.from(records[4]!.recordHex, "hex");
    const inner = changed.subarray(280, 792); inner[180] = inner[180]! ^ 1; rehash(inner);
    const drift = readRemoteWorkerCellVolumeCheckpoint(anchor, rehash(changed));
    expect(() => assertRemoteWorkerCellVolumeSuccessor(anchor, records[3], drift)).toThrow();
    const wrongPrevious = volume(3, records[1]!.recordSha256); Buffer.from("99".repeat(32), "hex").copy(wrongPrevious, 16);
    expect(() => assertRemoteWorkerCellVolumeSuccessor(anchor, records[1],
      readRemoteWorkerCellVolumeCheckpoint(anchor, rehash(wrongPrevious)))).toThrow();
  });
});
