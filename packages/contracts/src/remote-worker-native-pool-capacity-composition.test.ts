import { describe, expect, it } from "vitest";
import { nativePoolCapacityFixture } from "./remote-worker-native-pool-capacity-test-fixture.js";
import { remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { accountRemoteWorkerCellCapacityInventory, remoteWorkerCellCapacityInventorySha256 } from "./remote-worker-cell-capacity-inventory.js";
import { composeRemoteWorkerNativePoolCapacityInventory } from "./remote-worker-native-pool-capacity-composition.js";

describe("complete native pool capacity accounting", () => {
  it.each([1, 2, 64])("accounts %s members and charges each host backing once", count => {
    const f = nativePoolCapacityFixture(count), result = f.compose();
    const accounted = accountRemoteWorkerCellCapacityInventory(result, { profileSha256: result.profileSha256,
      captureSha256: result.captureSha256, inventorySha256: remoteWorkerCellCapacityInventorySha256(result) });
    expect(accounted.hostAllocatedBytes).toBe(f.hostAllocated);
    expect(accounted.guestAllocatedBytes).toBe(count * 22 * 4096);
    expect(accounted.hostFileCount).toBe(1 + count * 2); expect(accounted.hostDirectoryCount).toBe(13 + count * 4);
    expect(accounted.guestFileCount).toBe(count * 22); expect(accounted.guestDirectoryCount).toBe(count * 4);
    expect(accounted.logicalReferenceBytes).toBe(84); expect(accounted.logicalReferenceCount).toBe(2);
    expect(result.areas.flatMap(area => area.objects).filter(object => object.kind === "volume_backing")).toHaveLength(count);
    f.source.members.length = 0; f.source.references.length = 0;
    expect(result.references).toHaveLength(2); expect(Object.isFrozen(result.areas[0]!.objects)).toBe(true);
  }, 60000);
  it.each(["missing", "extra", "swapped", "foreign", "nonce"])("refuses %s member data even with a fresh members digest", mode => {
    const f = nativePoolCapacityFixture();
    if (mode === "missing") f.source.members.pop();
    if (mode === "extra") f.source.members.push(f.source.members[0]!);
    if (mode === "swapped") f.source.members.reverse();
    if (mode === "foreign") f.source.members[1] = f.source.members[0]!;
    if (mode === "nonce") f.window.connectionNonceHex = "aa".repeat(32);
    f.window.membersSha256 = remoteWorkerCellCanonicalSha256(f.source.members);
    expect(f.compose).toThrow();
  });
  it.each(["nonce", "poolSnapshotSha256", "hostCaptureSha256", "membersSha256", "referencesSha256"] as const)("refuses altered %s", field => {
    const f = nativePoolCapacityFixture(); f.window[field] = "aa".repeat(32); expect(f.compose).toThrow();
  });
  it("refuses absent history and stale pool authority rather than creating historical leases", () => {
    const f = nativePoolCapacityFixture();
    const incomplete = { ...f.pool, members: f.pool.members.map((member, index) => index ? { ...member, history: null } : member) };
    incomplete.membershipSha256 = remoteWorkerCellCanonicalSha256(incomplete.members);
    const window = { ...f.window, poolSnapshotSha256: remoteWorkerCellCanonicalSha256(incomplete) };
    expect(() => composeRemoteWorkerNativePoolCapacityInventory(f.source, incomplete, f.layout, window)).toThrow();
    expect(() => composeRemoteWorkerNativePoolCapacityInventory(f.source, { ...f.pool, leaseRevision: f.pool.leaseRevision + 1 }, f.layout, f.window)).toThrow();
  });
  it("rejects accessor members without evaluating them", () => {
    const f = nativePoolCapacityFixture(); let calls = 0;
    Object.defineProperty(f.source.members, "1", { enumerable: true, get() { calls++; return f.source.members[0]; } });
    expect(f.compose).toThrow(); expect(calls).toBe(0);
  });
  it("enforces the combined 20000-object ceiling across all members and host areas", () => {
    const exact = nativePoolCapacityFixture(2, 19922).compose();
    expect(exact.areas.reduce((sum, area) => sum + area.objects.length, 0)).toBe(20000);
    expect(nativePoolCapacityFixture(2, 19923).compose).toThrow();
  }, 30000);
});
