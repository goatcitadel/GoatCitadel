import { describe, expect, it } from "vitest";
import { normalizeRemoteWorkerNativePoolSnapshot, REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION, remoteWorkerCellCanonicalSha256,
  readRemoteWorkerCellProvisioningCheckpoint } from "@goatcitadel/contracts";
import { objectInventoryHistoryFixture } from "../../../packages/contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { encodeWindowsWorkerPoolHistory, WINDOWS_POOL_HISTORY_HEADER_BYTES, WINDOWS_POOL_HISTORY_MEMBER_BYTES } from "./worker-windows-pool-history.js";
function fixture() {
  const current = objectInventoryHistoryFixture();
  const { schemaVersion: _schema, registryWorkspaceId: _registry, assignmentId: _assignment,
    assignmentGeneration: _generation, leaseRevision: _revision, ...history } = current;
  const members = [{ assignmentId: current.assignmentId, assignmentGeneration: current.assignmentGeneration,
    workerGeneration: 1, cellId: "cell", profileSha256: current.plan.profileSha256, history }];
  const pool = normalizeRemoteWorkerNativePoolSnapshot({ schemaVersion: REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION,
    registryWorkspaceId: current.registryWorkspaceId, assignmentId: current.assignmentId, assignmentGeneration: current.assignmentGeneration,
    leaseRevision: current.leaseRevision, workerId: "worker", workerGeneration: 1, members, membershipSha256: remoteWorkerCellCanonicalSha256(members) });
  return { pool, current };
}
describe("native complete pool history container", () => {
  it.each([14, 15, 16] as const)("encodes exact retained checkpoints for operation %i with no sender nonce", operation => {
    const { pool, current } = fixture(), bytes = encodeWindowsWorkerPoolHistory(pool, current, operation, 60000);
    expect(bytes.length).toBe(WINDOWS_POOL_HISTORY_HEADER_BYTES + WINDOWS_POOL_HISTORY_MEMBER_BYTES);
    expect(bytes.subarray(0, 8).toString()).toBe("GCPPOOL1");
    expect(bytes.readUInt32LE(8)).toBe(1); expect(bytes.readUInt32LE(12)).toBe(1);
    expect(bytes.subarray(16, 48)).toEqual(Buffer.alloc(32));
    expect(bytes.subarray(48, 80).toString("hex")).toBe(remoteWorkerCellCanonicalSha256(pool));
    expect(bytes.readUInt32LE(136)).toBe(operation); expect(bytes.readUInt32LE(140)).toBe(60000);
    expect(bytes.subarray(144, 176)).toEqual(Buffer.alloc(32));
    expect(bytes.subarray(336, 360).toString("hex")).toBe(readRemoteWorkerCellProvisioningCheckpoint(current.records[0]).journalIdentityHex);
    expect(bytes.subarray(392).toString("hex")).toBe([...current.records, ...current.volumeRecords!, ...current.formatRecords!,
      ...current.protectionRecords!, ...current.mountRecords!, ...current.mountedWorkspaceRecords!].join(""));
  });
  it("refuses stale request, absent current member, incomplete history and unsafe lifetime", () => {
    const { pool, current } = fixture();
    expect(() => encodeWindowsWorkerPoolHistory(pool, { ...current, leaseRevision: current.leaseRevision + 1 }, 14, 1000)).toThrow();
    const members = [{ ...pool.members[0]!, history: null }];
    expect(() => encodeWindowsWorkerPoolHistory({ ...pool, members, membershipSha256: remoteWorkerCellCanonicalSha256(members) }, current, 14, 1000)).toThrow();
    expect(() => encodeWindowsWorkerPoolHistory({ ...pool, members: [], membershipSha256: remoteWorkerCellCanonicalSha256([]) }, current, 14, 1000)).toThrow();
    for (const wall of [0, 99, 60001, Number.NaN]) expect(() => encodeWindowsWorkerPoolHistory(pool, current, 14, wall)).toThrow();
  });
});
