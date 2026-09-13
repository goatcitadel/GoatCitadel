import { describe, expect, it } from "vitest";
import { createRemoteWorkerCellDiskLayoutPlan } from "./remote-worker-cell-disk-layout.js";
import { normalizeRemoteWorkerCellVolumeAnchor, REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION } from "./remote-worker-cell-volume.js";
import { normalizeRemoteWorkerCellFormatAnchor, REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION } from "./remote-worker-cell-format.js";
import { normalizeRemoteWorkerCellProtectionAnchor, normalizeRemoteWorkerCellProtectionSubmission, readRemoteWorkerCellProtectionCheckpoint,
  assertRemoteWorkerCellProtectionSuccessor, remoteWorkerCellRootSecuritySha256,
  REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION } from "./remote-worker-cell-protection.js";
import { volumeCheckpointFixture, rehashVolumeFixture } from "./remote-worker-cell-volume-test-fixture.js";
import { formatCheckpointFixture } from "./remote-worker-cell-format-test-fixture.js";
import { protectionCheckpointFixture } from "./remote-worker-cell-protection-test-fixture.js";

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
const formatAnchor = normalizeRemoteWorkerCellFormatAnchor({ schemaVersion: REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION, volumeAnchor, volumeRecords });
const formatIntent = formatCheckpointFixture(formatAnchor, 1);
const anchor = normalizeRemoteWorkerCellProtectionAnchor({ schemaVersion: REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION,
  formatAnchor, formatRecords: [formatIntent, formatCheckpointFixture(formatAnchor, 2, formatIntent.slice(-64), formatIntent.slice(1520, 1584))],
  ownerSid: "S-1-5-18", controllerSid: "S-1-5-80-1-2-3-4-5" });
const intentHex = protectionCheckpointFixture(anchor, 1), intent = readRemoteWorkerCellProtectionCheckpoint(anchor, intentHex);
const completeHex = protectionCheckpointFixture(anchor, 2, intent.recordSha256, intent.rootCheckpoint.recordSha256);
const complete = readRemoteWorkerCellProtectionCheckpoint(anchor, completeHex);
const rehash = (bytes: Buffer) => { rehashVolumeFixture(bytes.subarray(280, 792)); return rehashVolumeFixture(bytes); };

describe("native root protection checkpoint contract", () => {
  it("binds exact root identity and policy to the complete recorded format", () => {
    assertRemoteWorkerCellProtectionSuccessor(anchor, undefined, intent);
    assertRemoteWorkerCellProtectionSuccessor(anchor, intent, complete);
    expect(complete.rootCheckpoint.rootIdentityHex).toBe("1032547698badcfe" + "d6".repeat(16));
    expect(complete.rootCheckpoint.securitySha256).toBe(remoteWorkerCellRootSecuritySha256(anchor.ownerSid, anchor.controllerSid));
    expect(complete.formatRecordedSha256).toBe(anchor.formatRecords[1]!.slice(-64));
    expect(Object.isFrozen(complete) && Object.isFrozen(complete.anchor) && Object.isFrozen(complete.rootCheckpoint) &&
      Object.isFrozen(complete.anchor.formatRecords)).toBe(true);
  });
  it("requires the complete canonical history and rejects getters without invoking them", () => {
    expect(normalizeRemoteWorkerCellProtectionAnchor(anchor)).toBe(anchor);
    expect(() => normalizeRemoteWorkerCellProtectionAnchor(Object.freeze({ ...anchor, formatRecords: [] }))).toThrow();
    for (const formatRecords of [[], [anchor.formatRecords[0]], [...anchor.formatRecords].reverse(), new Array(2),
      Object.assign([...anchor.formatRecords], { ready: true })])
      expect(() => normalizeRemoteWorkerCellProtectionAnchor({ ...anchor, formatRecords })).toThrow();
    let called = false; const getters = [...anchor.formatRecords];
    Object.defineProperty(getters, "0", { enumerable: true, get() { called = true; return formatIntent; } });
    expect(() => normalizeRemoteWorkerCellProtectionAnchor({ ...anchor, formatRecords: getters })).toThrow();
    expect(called).toBe(false);
    expect(() => normalizeRemoteWorkerCellProtectionAnchor({ ...anchor, formatAnchor: { ...formatAnchor, volumeRecords: volumeRecords.slice(0, 5) } })).toThrow();
  });
  it("uses canonical bounded SIDs and separates owner from controller roles", () => {
    for (const sid of ["S-1-5-80-1-2-3-4-5", "S-1-5-20", "S-1-5-018", "s-1-5-18", "S-1-5-21-1-2-3-4294967296"])
      expect(() => remoteWorkerCellRootSecuritySha256(sid, anchor.controllerSid)).toThrow();
    for (const sid of ["S-1-5-80-01-2-3-4-5", "S-1-5-80-1-2-3-4-4294967296", "S-1-5-32-544"])
      expect(() => remoteWorkerCellRootSecuritySha256(anchor.ownerSid, sid)).toThrow();
    expect(remoteWorkerCellRootSecuritySha256("S-1-5-21-1-2-3-4", anchor.controllerSid)).not.toBe(intent.rootCheckpoint.securitySha256);
    expect(() => readRemoteWorkerCellProtectionCheckpoint({ ...anchor, ownerSid: "S-1-5-21-1-2-3-4" }, intentHex)).toThrow();
    expect(() => readRemoteWorkerCellProtectionCheckpoint({ ...anchor, controllerSid: "S-1-5-18" }, intentHex)).toThrow();
  });
  it("rejects rehashed outer identity, capacity, predecessor and reserved-byte changes", () => {
    for (const offset of [0, 8, 12, 16, 48, 80, 112, 128, 136, 144, 168, 192, 216, 248, 264, 792, 991]) {
      const bytes = Buffer.from(intentHex, "hex"); bytes[offset] = bytes[offset]! ^ 1;
      expect(() => readRemoteWorkerCellProtectionCheckpoint(anchor, rehash(bytes)), `outer ${offset}`).toThrow();
    }
  });
  it("rejects rehashed nested format, policy, volume, serial, geometry and padding changes", () => {
    for (const offset of [0, 8, 12, 16, 48, 80, 112, 128, 136, 144, 152, 160, 184, 479]) {
      const bytes = Buffer.from(intentHex, "hex"); bytes[280 + offset] = bytes[280 + offset]! ^ 1;
      expect(() => readRemoteWorkerCellProtectionCheckpoint(anchor, rehash(bytes)), `nested ${offset}`).toThrow();
    }
    const bytes = Buffer.from(intentHex, "hex"); bytes.fill(0, 448, 464);
    expect(() => readRemoteWorkerCellProtectionCheckpoint(anchor, rehash(bytes))).toThrow();
  });
  it("rejects completion-first, repeated intent and changed root or predecessor at completion", () => {
    expect(() => assertRemoteWorkerCellProtectionSuccessor(anchor, undefined, complete)).toThrow();
    expect(() => assertRemoteWorkerCellProtectionSuccessor(anchor, intent, intent)).toThrow();
    for (const offset of [16, 296, 448]) {
      const bytes = Buffer.from(completeHex, "hex"); bytes[offset] = bytes[offset]! ^ 1;
      const changed = readRemoteWorkerCellProtectionCheckpoint(anchor, rehash(bytes));
      expect(() => assertRemoteWorkerCellProtectionSuccessor(anchor, intent, changed)).toThrow();
    }
  });
  it("admits only the exact bounded submission without path or readiness claims", () => {
    const submission = { kind: "cell.protection.checkpoint", expectedSequence: 0, recordHex: intentHex };
    expect(normalizeRemoteWorkerCellProtectionSubmission(submission)).toEqual(submission);
    for (const patch of [{ expectedSequence: 1 }, { recordHex: intentHex.toUpperCase() }, { recordHex: intentHex.slice(2) },
      { path: "C:\\" }, { ready: true }, { kind: "cell.format.checkpoint" }])
      expect(() => normalizeRemoteWorkerCellProtectionSubmission({ ...submission, ...patch })).toThrow();
    let called = false;
    expect(() => normalizeRemoteWorkerCellProtectionSubmission(Object.defineProperty({ ...submission }, "recordHex", {
      enumerable: true, get() { called = true; return intentHex; } }))).toThrow();
    expect(called).toBe(false);
  });
});
