import { describe, expect, it } from "vitest";
import { createRemoteWorkerCellDiskLayoutPlan } from "./remote-worker-cell-disk-layout.js";
import { REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION } from "./remote-worker-cell-volume.js";
import { REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION } from "./remote-worker-cell-format.js";
import { REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION } from "./remote-worker-cell-protection.js";
import { normalizeRemoteWorkerCellMountAnchor, normalizeRemoteWorkerCellMountSubmission, readRemoteWorkerCellMountCheckpoint,
  assertRemoteWorkerCellMountSuccessor, REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION } from "./remote-worker-cell-mount.js";
import { volumeCheckpointFixture, rehashVolumeFixture } from "./remote-worker-cell-volume-test-fixture.js";
import { formatCheckpointFixture } from "./remote-worker-cell-format-test-fixture.js";
import { protectionCheckpointFixture } from "./remote-worker-cell-protection-test-fixture.js";
import { mountCheckpointFixture } from "./remote-worker-cell-mount-test-fixture.js";

const file = (value: number) => "6500000000000000" + value.toString(16).padStart(32, "0");
const plan = createRemoteWorkerCellDiskLayoutPlan({ provisioningPlanSha256: "11".repeat(32), assignmentBindingSha256: "31".repeat(32),
  profileSha256: "42".repeat(32), diskIdentifierHex: "11111111222233438405060708090a0b",
  virtualDiskBytes: 256 * 1024 ** 2, reservedDiskBytes: 384 * 1024 ** 2, controlIdentityHex: file(4), backingIdentityHex: file(7) });
const volumeAnchor = { schemaVersion: REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION,
  diskRecordedSha256: "55".repeat(32), journalIdentityHex: file(2), layoutPlan: plan };
const volumeRecords: string[] = [];
for (let sequence = 1; sequence <= 6; sequence++) {
  const prior = volumeRecords.at(-1);
  volumeRecords.push(volumeCheckpointFixture(volumeAnchor, sequence, prior?.slice(-64), sequence > 3 ? prior!.slice(1520, 1584) : undefined));
}
const formatAnchor = { schemaVersion: REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION, volumeAnchor, volumeRecords };
const formatIntent = formatCheckpointFixture(formatAnchor, 1);
const protectionAnchor = { schemaVersion: REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION,
  formatAnchor, formatRecords: [formatIntent, formatCheckpointFixture(formatAnchor, 2, formatIntent.slice(-64), formatIntent.slice(1520, 1584))],
  ownerSid: "S-1-5-18", controllerSid: "S-1-5-80-1-2-3-4-5" };
const protectionIntent = protectionCheckpointFixture(protectionAnchor, 1);
const anchor = normalizeRemoteWorkerCellMountAnchor({ schemaVersion: REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION,
  protectionAnchor, protectionRecords: [protectionIntent, protectionCheckpointFixture(protectionAnchor, 2,
    protectionIntent.slice(-64), protectionIntent.slice(1520, 1584))], parentIdentityHex: file(1), workspaceIdentityHex: [3, 4, 5, 6].map(file) });
const records: string[] = [];
for (let sequence = 1; sequence <= 4; sequence++) {
  const prior = records.at(-1);
  records.push(mountCheckpointFixture(anchor, sequence, prior?.slice(-64), prior?.slice(1520, 1584)));
}
const checkpoints = records.map((record) => readRemoteWorkerCellMountCheckpoint(anchor, record));
const rehash = (bytes: Buffer) => { rehashVolumeFixture(bytes.subarray(280, 792)); return rehashVolumeFixture(bytes); };

describe("native mount checkpoint contract", () => {
  it("binds all four phases to protected root, frozen policy and retained host identities", () => {
    for (const [index, next] of checkpoints.entries()) assertRemoteWorkerCellMountSuccessor(anchor, checkpoints[index - 1], next);
    expect(checkpoints.map((item) => item.phase)).toEqual(["prepared", "directory_recorded", "mount_intent", "mounted"]);
    expect(checkpoints[0]!.mountCheckpoint.directoryIdentityHex).toBeUndefined();
    expect(checkpoints[3]!.mountCheckpoint.directoryIdentityHex).toBe("6500000000000000" + "e7".repeat(16));
    expect(checkpoints[3]!.mountCheckpoint.rootIdentityHex).toBe("1032547698badcfe" + "d6".repeat(16));
    expect(Object.isFrozen(checkpoints[3]) && Object.isFrozen(checkpoints[3]!.anchor.workspaceIdentityHex) &&
      Object.isFrozen(checkpoints[3]!.mountCheckpoint)).toBe(true);
  });
  it("requires a complete protection chain and rejects sparse, extended or accessor arrays", () => {
    expect(normalizeRemoteWorkerCellMountAnchor(anchor)).toBe(anchor);
    expect(() => normalizeRemoteWorkerCellMountAnchor(Object.freeze({ ...anchor, parentIdentityHex: file(2) }))).toThrow();
    for (const protectionRecords of [[], [protectionIntent], [...anchor.protectionRecords].reverse(), new Array(2),
      Object.assign([...anchor.protectionRecords], { ready: true })])
      expect(() => normalizeRemoteWorkerCellMountAnchor({ ...anchor, protectionRecords })).toThrow();
    let called = false;
    for (const field of ["protectionRecords", "workspaceIdentityHex"] as const) {
      const values = [...anchor[field]];
      Object.defineProperty(values, "0", { enumerable: true, get() { called = true; return anchor[field][0]; } });
      expect(() => normalizeRemoteWorkerCellMountAnchor({ ...anchor, [field]: values })).toThrow();
    }
    expect(called).toBe(false);
  });
  it("rejects host aliases, wrong control identity, different host volumes and forged policy", () => {
    for (const workspaceIdentityHex of [[file(1), file(4), file(5), file(6)], [file(3), file(5), file(4), file(6)],
      [file(3), file(4), file(5), file(7)], [file(3), file(4), file(5), "6600000000000000" + "88".repeat(16)]])
      expect(() => normalizeRemoteWorkerCellMountAnchor({ ...anchor, workspaceIdentityHex })).toThrow();
    expect(() => normalizeRemoteWorkerCellMountAnchor({ ...anchor, parentIdentityHex: file(2) })).toThrow();
    expect(() => normalizeRemoteWorkerCellMountAnchor({ ...anchor,
      protectionAnchor: { ...protectionAnchor, controllerSid: "S-1-5-18" } })).toThrow();
  });
  it("rejects rehashed outer identity, layout, predecessor and padding changes", () => {
    for (const offset of [0, 8, 12, 16, 48, 80, 112, 128, 136, 144, 168, 192, 216, 248, 264, 792, 991]) {
      const bytes = Buffer.from(records[0]!, "hex"); bytes[offset] = bytes[offset]! ^ 1;
      expect(() => readRemoteWorkerCellMountCheckpoint(anchor, rehash(bytes)), `outer ${offset}`).toThrow();
    }
  });
  it("rejects rehashed inner root, parent, policy, directory and padding changes", () => {
    for (const offset of [0, 8, 12, 16, 48, 80, 112, 128, 152, 176, 200, 479]) {
      const bytes = Buffer.from(records[0]!, "hex"); bytes[280 + offset] = bytes[280 + offset]! ^ 1;
      expect(() => readRemoteWorkerCellMountCheckpoint(anchor, rehash(bytes)), `inner ${offset}`).toThrow();
    }
    for (const target of [anchor.parentIdentityHex, ...anchor.workspaceIdentityHex, volumeAnchor.journalIdentityHex, plan.backingIdentityHex,
      "0".repeat(48), "6600000000000000" + "e7".repeat(16)]) {
      const bytes = Buffer.from(records[1]!, "hex"); Buffer.from(target, "hex").copy(bytes, 456);
      expect(() => readRemoteWorkerCellMountCheckpoint(anchor, rehash(bytes))).toThrow();
    }
  });
  it("refuses skipped, repeated or changed-directory successors and both broken hash chains", () => {
    expect(() => assertRemoteWorkerCellMountSuccessor(anchor, undefined, checkpoints[3]!)).toThrow();
    expect(() => assertRemoteWorkerCellMountSuccessor(anchor, checkpoints[0], checkpoints[0]!)).toThrow();
    for (const offset of [16, 296, 464]) {
      const bytes = Buffer.from(records[2]!, "hex"); bytes[offset] = bytes[offset]! ^ 1;
      const changed = readRemoteWorkerCellMountCheckpoint(anchor, rehash(bytes));
      expect(() => assertRemoteWorkerCellMountSuccessor(anchor, checkpoints[1], changed)).toThrow();
    }
  });
  it("admits only bounded exact checkpoint submissions without path or readiness claims", () => {
    const submission = { kind: "cell.mount.checkpoint", expectedSequence: 0, recordHex: records[0] };
    expect(normalizeRemoteWorkerCellMountSubmission(submission)).toEqual(submission);
    for (const patch of [{ expectedSequence: 1 }, { recordHex: records[0]!.toUpperCase() }, { recordHex: records[0]!.slice(2) },
      { path: "C:\\" }, { ready: true }, { kind: "cell.protection.checkpoint" }])
      expect(() => normalizeRemoteWorkerCellMountSubmission({ ...submission, ...patch })).toThrow();
    let called = false;
    expect(() => normalizeRemoteWorkerCellMountSubmission(Object.defineProperty({ ...submission }, "recordHex", {
      enumerable: true, get() { called = true; return records[0]; } }))).toThrow();
    expect(called).toBe(false);
  });
});
