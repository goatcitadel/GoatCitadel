import { describe, expect, it } from "vitest";
import { createRemoteWorkerCellDiskLayoutPlan } from "./remote-worker-cell-disk-layout.js";
import { normalizeRemoteWorkerCellVolumeAnchor, REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION } from "./remote-worker-cell-volume.js";
import { normalizeRemoteWorkerCellFormatAnchor, normalizeRemoteWorkerCellFormatSubmission, readRemoteWorkerCellFormatCheckpoint,
  assertRemoteWorkerCellFormatSuccessor, REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION } from "./remote-worker-cell-format.js";
import { volumeCheckpointFixture, rehashVolumeFixture } from "./remote-worker-cell-volume-test-fixture.js";
import { formatCheckpointFixture } from "./remote-worker-cell-format-test-fixture.js";

const plan = createRemoteWorkerCellDiskLayoutPlan({ provisioningPlanSha256: "11".repeat(32), assignmentBindingSha256: "31".repeat(32),
  profileSha256: "42".repeat(32), diskIdentifierHex: "11111111222233438405060708090a0b",
  virtualDiskBytes: 256 * 1024 ** 2, reservedDiskBytes: 384 * 1024 ** 2,
  controlIdentityHex: "6500000000000000" + "21".repeat(16), backingIdentityHex: "6500000000000000" + "42".repeat(16) });
const volumeAnchor = normalizeRemoteWorkerCellVolumeAnchor({ schemaVersion: REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION,
  diskRecordedSha256: "55".repeat(32), journalIdentityHex: "6500000000000000" + "77".repeat(16), layoutPlan: plan });
const volumeRecords: string[] = [];
for (let sequence = 1; sequence <= 6; sequence++) {
  const prior = volumeRecords.at(-1);
  volumeRecords.push(volumeCheckpointFixture(volumeAnchor, sequence, prior?.slice(-64), sequence > 3 ? prior!.slice(1520, 1584) : undefined));
}
const anchor = normalizeRemoteWorkerCellFormatAnchor({ schemaVersion: REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION, volumeAnchor, volumeRecords });
const intentHex = formatCheckpointFixture(anchor, 1), intent = readRemoteWorkerCellFormatCheckpoint(anchor, intentHex);
const completeHex = formatCheckpointFixture(anchor, 2, intent.recordSha256, intent.ntfsCheckpoint.recordSha256);
const complete = readRemoteWorkerCellFormatCheckpoint(anchor, completeHex);
function rehash(bytes: Buffer): string { rehashVolumeFixture(bytes.subarray(280, 792)); return rehashVolumeFixture(bytes); }

describe("native formatting checkpoint contract", () => {
  it("reuses only its own immutable history and revalidates caller-frozen copies", () => {
    const input = { ...anchor, volumeRecords: [...volumeRecords] };
    const normalized = normalizeRemoteWorkerCellFormatAnchor(input);
    expect(normalizeRemoteWorkerCellFormatAnchor(normalized)).toBe(normalized);
    expect(normalizeRemoteWorkerCellFormatAnchor(Object.freeze({ ...normalized }))).not.toBe(normalized);
    input.volumeRecords[5] = volumeRecords[4]!;
    expect(() => normalizeRemoteWorkerCellFormatAnchor(Object.freeze(input))).toThrow();
    expect(readRemoteWorkerCellFormatCheckpoint(normalized, completeHex)).toEqual(complete);
    expect(Object.isFrozen(normalized.volumeAnchor) && Object.isFrozen(normalized.volumeAnchor.layoutPlan)).toBe(true);
  });
  it("binds an exact format pair to the complete independently retained GPT history", () => {
    assertRemoteWorkerCellFormatSuccessor(anchor, undefined, intent);
    assertRemoteWorkerCellFormatSuccessor(anchor, intent, complete);
    expect(intent.ntfsCheckpoint.identity).toBeUndefined();
    expect(complete.ntfsCheckpoint.identity).toEqual({ serialHex: "1032547698badcfe", sectors: 487423, clusters: 60927 });
    expect(complete.ntfsCheckpoint.partitionBytes).toBe(238 * 1024 ** 2);
    expect(complete.volumeRecordedSha256).toBe(volumeRecords[5]!.slice(-64));
    expect(Object.isFrozen(complete) && Object.isFrozen(complete.anchor) && Object.isFrozen(complete.ntfsCheckpoint) &&
      Object.isFrozen(complete.ntfsCheckpoint.identity) && Object.isFrozen(complete.anchor.volumeRecords)).toBe(true);
  });
  it("rejects incomplete, reordered and accessor-provided canonical history", () => {
    for (const records of [[], volumeRecords.slice(1), volumeRecords.slice().reverse(), new Array(6),
      [...volumeRecords, volumeRecords[5]], Object.assign([...volumeRecords], { ready: true })])
      expect(() => normalizeRemoteWorkerCellFormatAnchor({ ...anchor, volumeRecords: records })).toThrow();
    let called = false;
    const records = [...volumeRecords];
    Object.defineProperty(records, "0", { enumerable: true, get() { called = true; return volumeRecords[0]; } });
    expect(() => normalizeRemoteWorkerCellFormatAnchor({ ...anchor, volumeRecords: records })).toThrow();
    expect(() => normalizeRemoteWorkerCellFormatAnchor(Object.defineProperty({ ...anchor }, "volumeAnchor", {
      enumerable: true, get() { called = true; return volumeAnchor; } }))).toThrow();
    expect(called).toBe(false);
    for (const change of [{ ready: true }, { schemaVersion: "future" }, { volumeAnchor: { ...volumeAnchor, diskRecordedSha256: "ab".repeat(32) } }])
      expect(() => normalizeRemoteWorkerCellFormatAnchor({ ...anchor, ...change })).toThrow();
  });
  it("admits only bounded checksum-valid submissions without caller-authored authority", () => {
    const submission = { kind: "cell.format.checkpoint", expectedSequence: 0, recordHex: intentHex };
    expect(normalizeRemoteWorkerCellFormatSubmission(submission)).toEqual(submission);
    for (const change of [{ kind: "cell.volume.checkpoint" }, { expectedSequence: 1 }, { expectedSequence: -1 },
      { recordHex: intentHex + "00" }, { recordHex: intentHex.toUpperCase() }, { ready: true }, { approvalGranted: true }])
      expect(() => normalizeRemoteWorkerCellFormatSubmission({ ...submission, ...change })).toThrow();
    let called = false;
    expect(() => normalizeRemoteWorkerCellFormatSubmission(Object.defineProperty({ ...submission }, "recordHex", {
      enumerable: true, get() { called = true; return intentHex; } }))).toThrow();
    expect(called).toBe(false);
  });
  it("rejects correctly rehashed outer identity, authority, capacity and reserved-byte drift", () => {
    for (const offset of [0, 8, 12, 16, 48, 80, 112, 128, 136, 144, 168, 192, 216, 248, 264, 792, 991]) {
      const bytes = Buffer.from(intentHex, "hex"); bytes[offset] = bytes[offset]! ^ 1;
      expect(() => readRemoteWorkerCellFormatCheckpoint(anchor, rehash(bytes)), `offset ${offset}`).toThrow();
    }
  });
  it("rejects correctly rehashed nested layout, geometry, format-option and intent-result drift", () => {
    for (const offset of [0, 8, 12, 16, 48, 96, 104, 108, 112, 150, 184, 192, 200, 208, 479]) {
      const bytes = Buffer.from(intentHex, "hex"); bytes[280 + offset] = bytes[280 + offset]! ^ 1;
      expect(() => readRemoteWorkerCellFormatCheckpoint(anchor, rehash(bytes)), `nested offset ${offset}`).toThrow();
    }
    const bytes = Buffer.from(intentHex, "hex"); bytes.fill(0, 360, 376);
    expect(() => readRemoteWorkerCellFormatCheckpoint(anchor, rehash(bytes))).toThrow();
  });
  it("rejects missing or excessive NTFS geometry and a zero filesystem serial", () => {
    for (const change of [
      (bytes: Buffer) => { bytes.fill(0, 464, 472); },
      (bytes: Buffer) => { bytes.writeBigUInt64LE(0xffffffffffffffffn, 472); },
      (bytes: Buffer) => { bytes.writeBigUInt64LE(487425n, 472); },
      (bytes: Buffer) => { bytes.writeBigUInt64LE(487415n, 472); },
      (bytes: Buffer) => { bytes.writeBigUInt64LE(60928n, 480); },
    ]) {
      const bytes = Buffer.from(completeHex, "hex"); change(bytes);
      expect(() => readRemoteWorkerCellFormatCheckpoint(anchor, rehash(bytes))).toThrow();
    }
  });
  it("rejects completion without intent, replay order and a different observed volume", () => {
    expect(() => assertRemoteWorkerCellFormatSuccessor(anchor, undefined, complete)).toThrow();
    expect(() => assertRemoteWorkerCellFormatSuccessor(anchor, complete, complete)).toThrow();
    const changed = Buffer.from(completeHex, "hex"); changed[360] = changed[360]! ^ 1;
    const foreign = readRemoteWorkerCellFormatCheckpoint(anchor, rehash(changed));
    expect(() => assertRemoteWorkerCellFormatSuccessor(anchor, intent, foreign)).toThrow();
    const wrongPrior = Buffer.from(completeHex, "hex"); wrongPrior[296] = wrongPrior[296]! ^ 1;
    expect(() => assertRemoteWorkerCellFormatSuccessor(anchor, intent, readRemoteWorkerCellFormatCheckpoint(anchor, rehash(wrongPrior)))).toThrow();
  });
  it("rejects truncation, trailing bytes, uppercase, broken checksums and substituted anchors", () => {
    for (const record of [intentHex.slice(2), intentHex + "00", intentHex.toUpperCase(), "00".repeat(1024), "ff" + intentHex.slice(2)])
      expect(() => readRemoteWorkerCellFormatCheckpoint(anchor, record)).toThrow();
    const other = { ...anchor, volumeAnchor: { ...volumeAnchor, journalIdentityHex: "6500000000000000" + "88".repeat(16) } };
    expect(() => readRemoteWorkerCellFormatCheckpoint(other, intentHex)).toThrow();
  });
});
