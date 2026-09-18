import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonString, normalizeRemoteWorkerNativePoolCleanupSnapshot, remoteWorkerCellCanonicalSha256,
  REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION, REMOTE_WORKER_NATIVE_POOL_CLEANUP_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION,
  readRemoteWorkerCellProvisioningCheckpoint } from "@goatcitadel/contracts";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { encodeWindowsWorkerPoolCleanup as encode, WINDOWS_POOL_CLEANUP_MAXIMUM_BYTES } from "./worker-windows-pool-cleanup.js";
const challenge = "cc".repeat(32);
function fixture(count = 2, install = true) {
  const f = runtimeResultPagesFixture(2);
  const { schemaVersion: _schema, registryWorkspaceId, assignmentId, assignmentGeneration, leaseRevision, ...history } = f.history;
  const members = [{ assignmentId, assignmentGeneration, workerGeneration: 1, cellId: "cell", profileSha256: history.plan.profileSha256, history }];
  const first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
  return normalizeRemoteWorkerNativePoolCleanupSnapshot({ schemaVersion: REMOTE_WORKER_NATIVE_POOL_CLEANUP_SCHEMA_VERSION,
    pool: { schemaVersion: REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION, registryWorkspaceId, assignmentId, assignmentGeneration,
      leaseRevision, workerId: "worker", workerGeneration: 1, members, membershipSha256: remoteWorkerCellCanonicalSha256(members) },
    members: [{ registryWorkspaceId, assignmentId, assignmentGeneration,
      expectations: Array.from({ length: count }, (_, index) => ({ ...f.expectation, nonce: (index + 1).toString(16).padStart(64, "0") })),
      installation: install ? { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, nonce: "44".repeat(32),
        journalIdentityHex: first.journalIdentityHex, preparedSha256: first.recordSha256,
        checkpointSha256: f.expectation.checkpointSha256, packageSha256: "55".repeat(32),
        runtimeBundle: { schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: [
          { relativePath: "node.exe", bytes: 123, sha256: "66".repeat(32) },
          { relativePath: "worker-host-receipt.json", bytes: 456, sha256: "77".repeat(32) },
        ] } } : null }] });
}
describe("native pool cleanup container", () => {
  it.each([[0, false], [2, true], [1000, false]] as const)("retains all %i attempts and installation=%s", (count, install) => {
    const value = fixture(count, install), bytes = encode(value, value.pool, challenge);
    const digest = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
    expect(bytes.subarray(0, 8).toString("ascii")).toBe("GCPCLN01");
    expect(bytes.readUInt32LE(8)).toBe(1); expect(bytes.readUInt32LE(12)).toBe(1);
    expect(bytes.subarray(16, 48).toString("hex")).toBe(digest(value.pool));
    expect(bytes.subarray(48, 80).toString("hex")).toBe(digest(value));
    expect(bytes.subarray(80, 112).toString("hex")).toBe(value.pool.members[0]!.history!.plan.assignmentBindingSha256);
    const admissionLength = bytes.readUInt32LE(112), dataLength = bytes.readUInt32LE(116);
    expect(admissionLength).toBe(install ? 416 : 80); expect(dataLength).toBe(252 + 108 * count);
    expect(bytes.length).toBe(120 + admissionLength + dataLength); expect(bytes.length).toBeLessThanOrEqual(WINDOWS_POOL_CLEANUP_MAXIMUM_BYTES);
    const admission = bytes.subarray(120, 120 + admissionLength), data = bytes.subarray(120 + admissionLength);
    expect(admission.subarray(0, 8).toString("ascii")).toBe("GCCADM01");
    expect(admission.subarray(8, 40).toString("hex")).toBe(challenge);
    expect(admission.readUInt32LE(72)).toBe(install ? 1 : 0);
    expect(data.subarray(0, 8).toString("ascii")).toBe("GCCLEAN1");
    expect(data.subarray(8, 40).toString("hex")).toBe(challenge); expect(data.readUInt32LE(248)).toBe(count);
    expect(admission.subarray(40, 72).toString("hex")).toBe(createHash("sha256").update("goatcitadel.worker-runtime-cleanup.v1\0").update(data).digest("hex"));
  });
  it("refuses stale pool, incomplete members, missing coverage and invalid challenge", () => {
    const value = fixture();
    expect(() => encode(value, { ...value.pool, leaseRevision: value.pool.leaseRevision + 1 }, challenge)).toThrow();
    expect(() => encode({ ...value, members: [] }, value.pool, challenge)).toThrow();
    expect(() => encode(value, value.pool, "00".repeat(32))).toThrow();
    const members = [{ ...value.pool.members[0]!, history: null }];
    const incomplete = normalizeRemoteWorkerNativePoolCleanupSnapshot({ ...value,
      pool: { ...value.pool, members, membershipSha256: remoteWorkerCellCanonicalSha256(members) },
      members: [{ ...value.members[0]!, expectations: [], installation: null }] });
    expect(() => encode(incomplete, incomplete.pool, challenge)).toThrow(/incomplete/u);
  });
});
