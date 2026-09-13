import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertRemoteWorkerCellDiskLayoutSuccessor, createRemoteWorkerCellDiskLayoutPlan,
  normalizeRemoteWorkerCellDiskLayoutPlan, readRemoteWorkerCellDiskLayoutCheckpoint,
  type RemoteWorkerCellDiskLayoutCheckpoint,
} from "./remote-worker-cell-disk-layout.js";

const mib = 1024 * 1024;
const seed = {
  provisioningPlanSha256: "11".repeat(32), assignmentBindingSha256: "31".repeat(32), profileSha256: "42".repeat(32),
  diskIdentifierHex: "11111111222233438405060708090a0b", virtualDiskBytes: 256 * mib, reservedDiskBytes: 384 * mib,
  controlIdentityHex: "6500000000000000" + "21".repeat(16), backingIdentityHex: "6500000000000000" + "42".repeat(16),
};
const plan = createRemoteWorkerCellDiskLayoutPlan(seed);
const rehash = (bytes: Buffer): string => {
  createHash("sha256").update(bytes.subarray(0, 480)).digest().copy(bytes, 480);
  return bytes.toString("hex");
};
function record(sequence: number, previous = "0".repeat(64)): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write("GCCGPT01", 0, "ascii"); bytes.writeUInt32LE(sequence, 8);
  for (const [offset, value] of [[16, previous], [48, seed.diskIdentifierHex], [80, seed.controlIdentityHex],
    [104, seed.backingIdentityHex], [128, "4eddab42e24b628fbd6d3dafaee72085"], [144, "e504537b26391f84ac32eb9e4b76e10d"]] as const) {
    Buffer.from(value, "hex").copy(bytes, offset);
  }
  bytes.writeBigUInt64LE(BigInt(seed.virtualDiskBytes), 64); bytes.writeBigUInt64LE(BigInt(seed.reservedDiskBytes), 72);
  bytes.writeUInt32LE(512, 388);
  if (sequence > 1) {
    bytes.writeBigUInt64LE(17408n, 160); bytes.writeBigUInt64LE(BigInt(seed.virtualDiskBytes - 34304), 168);
    bytes.writeUInt32LE(128, 176); Buffer.from("44444444555566468708090a0b0c0d0e", "hex").copy(bytes, 180);
    bytes.writeBigUInt64LE(BigInt(mib), 196); bytes.writeBigUInt64LE(BigInt(16 * mib), 204);
    bytes.write("Microsoft reserved partition", 220, "utf16le");
    bytes.writeBigUInt64LE(BigInt(17 * mib), 292); bytes.writeBigUInt64LE(BigInt(238 * mib), 300);
    bytes.writeBigUInt64LE(0x8000000000000000n, 308); bytes.write("GoatCitadel cell", 316, "utf16le");
  }
  return bytes;
}

describe("canonical native disk layout", () => {
  it("derives native GUIDs from frozen assignment/profile/VHDX bytes with independent vectors", () => {
    expect(plan.gptDiskIdentifierHex).toBe("4eddab42e24b628fbd6d3dafaee72085");
    expect(plan.dataPartitionIdentifierHex).toBe("e504537b26391f84ac32eb9e4b76e10d");
    expect(normalizeRemoteWorkerCellDiskLayoutPlan(plan)).toEqual(plan);
    expect(Object.isFrozen(plan)).toBe(true);
    for (const key of ["assignmentBindingSha256", "profileSha256", "diskIdentifierHex"] as const) {
      const changed = createRemoteWorkerCellDiskLayoutPlan({ ...seed, [key]: "ff" + seed[key].slice(2) });
      expect(changed.gptDiskIdentifierHex).not.toBe(plan.gptDiskIdentifierHex);
      expect(changed.dataPartitionIdentifierHex).not.toBe(plan.dataPartitionIdentifierHex);
    }
    expect(createRemoteWorkerCellDiskLayoutPlan({ ...seed, provisioningPlanSha256: "12".repeat(32) }).gptDiskIdentifierHex)
      .toBe(plan.gptDiskIdentifierHex);
  });

  it("refuses caller-chosen identities, missing custody, invalid capacities and accessors", () => {
    for (const patch of [{ gptDiskIdentifierHex: seed.diskIdentifierHex }, { dataPartitionIdentifierHex: "aa".repeat(16) },
      { schemaVersion: "future" }, { ready: true }, { provisioningPlanSha256: "0".repeat(64) },
      { controlIdentityHex: seed.backingIdentityHex }, { backingIdentityHex: "0000000000000000" + "1".repeat(32) },
      { backingIdentityHex: "6600000000000000" + "42".repeat(16) }, { virtualDiskBytes: 16 * mib },
      { virtualDiskBytes: Number.MAX_SAFE_INTEGER + 1 }, { reservedDiskBytes: 319 * mib }, { reservedDiskBytes: 1024 ** 4 + 1 }]) {
      expect(() => normalizeRemoteWorkerCellDiskLayoutPlan({ ...plan, ...patch })).toThrow("metadata is invalid");
    }
    let getterCalled = false;
    const accessor = Object.defineProperty({ ...plan }, "gptDiskIdentifierHex", {
      enumerable: true, get() { getterCalled = true; return plan.gptDiskIdentifierHex; },
    });
    expect(() => normalizeRemoteWorkerCellDiskLayoutPlan(accessor)).toThrow("metadata is invalid");
    expect(getterCalled).toBe(false);
    expect(() => createRemoteWorkerCellDiskLayoutPlan({ ...seed, approved: true })).toThrow();
  });

  it("validates the complete independent native record chain and fixed layout", () => {
    let prior: RemoteWorkerCellDiskLayoutCheckpoint | undefined;
    for (let sequence = 1; sequence <= 4; sequence++) {
      const checkpoint = readRemoteWorkerCellDiskLayoutCheckpoint(plan, rehash(record(sequence, prior?.recordSha256)));
      assertRemoteWorkerCellDiskLayoutSuccessor(plan, prior, checkpoint);
      expect(checkpoint.sequence).toBe(sequence);
      if (sequence === 1) expect(checkpoint.snapshot).toBeUndefined();
      else expect(checkpoint.snapshot).toMatchObject({ usableStart: 17408, reservedLength: 16 * mib,
        reservedName: "Microsoft reserved partition", dataStart: 17 * mib, dataLength: 238 * mib });
      prior = checkpoint;
    }
    expect(prior?.phase).toBe("partitioned");
  });

  it("rejects corrupt and correctly rehashed foreign geometry, authority or reserved fields", () => {
    const initialized = record(2, "99".repeat(32));
    for (const offset of [0, 12, 48, 64, 72, 80, 104, 128, 144, 160, 168, 176, 196, 204, 292, 300, 308, 316, 388, 392, 479]) {
      const changed = Buffer.from(initialized); changed[offset] = changed[offset]! ^ 1;
      expect(() => readRemoteWorkerCellDiskLayoutCheckpoint(plan, rehash(changed)), `offset ${offset}`).toThrow();
    }
    for (const change of [(bytes: Buffer) => bytes.writeUInt32LE(5, 8),
      (bytes: Buffer) => bytes.writeBigUInt64LE(2n, 212), (bytes: Buffer) => bytes.fill(0, 180, 196),
      (bytes: Buffer) => Buffer.from(plan.dataPartitionIdentifierHex, "hex").copy(bytes, 180),
      (bytes: Buffer) => bytes.fill(0x61, 220, 292), (bytes: Buffer) => bytes.writeUInt16LE(0x61, 290),
      (bytes: Buffer) => bytes.writeBigUInt64LE(0xffffffffffffffffn, 204)]) {
      const changed = Buffer.from(initialized); change(changed);
      expect(() => readRemoteWorkerCellDiskLayoutCheckpoint(plan, rehash(changed))).toThrow();
    }
    const platformRequired = Buffer.from(initialized); platformRequired.writeBigUInt64LE(1n, 212);
    expect(readRemoteWorkerCellDiskLayoutCheckpoint(plan, rehash(platformRequired)).snapshot?.reservedAttributes).toBe(1);
    const intent = record(1); intent[160] = 1;
    expect(() => readRemoteWorkerCellDiskLayoutCheckpoint(plan, rehash(intent))).toThrow();
    const valid = rehash(initialized);
    for (const bad of [valid.slice(2), valid + "00", valid.toUpperCase(), "0".repeat(1024), valid.slice(0, -2) + "ff"]) {
      expect(() => readRemoteWorkerCellDiskLayoutCheckpoint(plan, bad)).toThrow();
    }
  });

  it("refuses skipped, reordered and changed observations despite valid individual hashes", () => {
    const intent = readRemoteWorkerCellDiskLayoutCheckpoint(plan, rehash(record(1)));
    const initialized = readRemoteWorkerCellDiskLayoutCheckpoint(plan, rehash(record(2, intent.recordSha256)));
    const next = readRemoteWorkerCellDiskLayoutCheckpoint(plan, rehash(record(3, initialized.recordSha256)));
    expect(() => assertRemoteWorkerCellDiskLayoutSuccessor(plan, undefined, initialized)).toThrow();
    expect(() => assertRemoteWorkerCellDiskLayoutSuccessor(plan, intent, next)).toThrow();
    expect(() => assertRemoteWorkerCellDiskLayoutSuccessor(plan, initialized, initialized)).toThrow();
    const changed = record(3, initialized.recordSha256); changed[180] = changed[180]! ^ 1;
    const validDrift = readRemoteWorkerCellDiskLayoutCheckpoint(plan, rehash(changed));
    expect(() => assertRemoteWorkerCellDiskLayoutSuccessor(plan, initialized, validDrift)).toThrow();
    const foreign = createRemoteWorkerCellDiskLayoutPlan({ ...seed, backingIdentityHex: "6500000000000000" + "43".repeat(16) });
    expect(() => assertRemoteWorkerCellDiskLayoutSuccessor(foreign, initialized, next)).toThrow();
  });
});
