import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { objectInventoryHistoryFixture } from "./remote-worker-cell-object-inventory-test-fixture.js";
import { readRemoteWorkerCellProvisioningCheckpoint } from "./remote-worker-cell-provisioning.js";
import { REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION } from "./remote-worker-runtime-bundle.js";
import { REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, remoteWorkerRuntimeInstallRequestSha256 } from "./remote-worker-runtime-install.js";
import { readRemoteWorkerRuntimeInstallOutcome } from "./remote-worker-runtime-install-outcome.js";

const hash = (domain: string, bytes: Uint8Array) => createHash("sha256").update(`${domain}\0`).update(bytes).digest();
function seal(bytes: Buffer) {
  hash("goatcitadel.worker-runtime-install-local-intent.v1", bytes.subarray(0, 224)).copy(bytes, 224);
  bytes.copy(bytes, 288, 224, 256);
  hash("goatcitadel.worker-runtime-install-local-outcome.v1", bytes.subarray(0, 320)).copy(bytes, 320);
  return bytes;
}
function fixture() {
  const history = objectInventoryHistoryFixture(), first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
  const request = { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, nonce: "11".repeat(32),
    journalIdentityHex: first.journalIdentityHex, preparedSha256: first.recordSha256,
    checkpointSha256: history.mountedWorkspaceRecords![1]!.slice(-64), packageSha256: "55".repeat(32),
    runtimeBundle: { schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: [
      { relativePath: "node.exe", bytes: 100, sha256: "66".repeat(32) },
      { relativePath: "worker-host-receipt.json", bytes: 20, sha256: "77".repeat(32) },
    ] } };
  const bytes = Buffer.alloc(352); bytes.write("GCRLI001"); bytes.write("GCRLIT01", 256);
  for (const [offset, value] of [[8, request.nonce], [40, remoteWorkerRuntimeInstallRequestSha256(request)],
    [72, request.checkpointSha256], [104, request.journalIdentityHex], [128, request.preparedSha256],
    [160, history.plan.assignmentBindingSha256], [192, history.plan.profileSha256]] as const) Buffer.from(value, "hex").copy(bytes, offset);
  bytes.writeUInt32LE(1, 268); bytes.writeUInt32LE(2, 272); bytes.writeBigUInt64LE(120n, 280); seal(bytes);
  return { history, request, bytes, read: (value: Buffer = bytes, supplied = request, retained = history) =>
    readRemoteWorkerRuntimeInstallOutcome(value.toString("hex"), supplied, retained) };
}

describe("durable installation outcome", () => {
  it("distinguishes an uncertain intent from a sealed successful copy", () => {
    const f = fixture(), intent = f.read(f.bytes.subarray(0, 256)), result = f.read();
    expect(intent.installation).toBeNull(); expect(intent.outcomeSha256).toBeNull();
    expect(intent.intentSha256).toBe(result.intentSha256);
    expect(result.installation).toEqual({ error: 0, verified: true, filesCreated: 2, directoriesCreated: 0, bytesWritten: 120 });
    expect(Object.isFrozen(result) && Object.isFrozen(result.installation)).toBe(true);
  });
  it("preserves partial failure accounting without reporting verified copying", () => {
    const f = fixture(); f.bytes.writeUInt32LE(995, 264); f.bytes.writeUInt32LE(0, 268);
    f.bytes.writeUInt32LE(1, 272); f.bytes.writeBigUInt64LE(17n, 280);
    expect(f.read(seal(f.bytes)).installation).toEqual({ error: 995, verified: false, filesCreated: 1, directoriesCreated: 0, bytesWritten: 17 });
  });
  it("rejects every altered byte and incomplete terminal write", () => {
    const f = fixture();
    for (let index = 0; index < f.bytes.length; index++) {
      const changed = Buffer.from(f.bytes); changed[index]! ^= 1; expect(() => f.read(changed)).toThrow();
      if (index !== 256) expect(() => f.read(f.bytes.subarray(0, index))).toThrow();
    }
    expect(() => f.read(Buffer.concat([f.bytes, Buffer.alloc(1)]))).toThrow();
  });
  it.each([8, 40, 72, 104, 128, 160, 192])("rejects resealed foreign binding at byte %i", offset => {
    const f = fixture(); f.bytes[offset]! ^= 1; expect(() => f.read(seal(f.bytes))).toThrow();
  });
  it.each(["flag", "files", "directories", "bytes", "false-success", "verified-failure", "short-success"])("rejects resealed %s accounting", mode => {
    const f = fixture();
    if (mode === "flag") f.bytes.writeUInt32LE(2, 268);
    if (mode === "files") f.bytes.writeUInt32LE(3, 272);
    if (mode === "directories") f.bytes.writeUInt32LE(1, 276);
    if (mode === "bytes") f.bytes.writeBigUInt64LE(121n, 280);
    if (mode === "false-success") f.bytes.writeUInt32LE(0, 268);
    if (mode === "verified-failure") f.bytes.writeUInt32LE(5, 264);
    if (mode === "short-success") f.bytes.writeBigUInt64LE(119n, 280);
    expect(() => f.read(seal(f.bytes))).toThrow();
  });
  it("rejects a different admitted package or incomplete retained history", () => {
    const f = fixture(); expect(() => f.read(f.bytes, { ...f.request, packageSha256: "88".repeat(32) })).toThrow();
    expect(() => f.read(f.bytes, f.request, { ...f.history, mountedWorkspaceRecords: [] })).toThrow();
  });
});
