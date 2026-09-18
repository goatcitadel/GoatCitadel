import { describe, expect, it } from "vitest";
import { nativeCapacityCompositionFixture as fixture } from "./remote-worker-native-capacity-composition-test-fixture.js";
import { remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { remoteWorkerNativeCapacityIdentitySha256 } from "./remote-worker-native-capacity-layout.js";
import { accountRemoteWorkerCellCapacityInventory, remoteWorkerCellCapacityInventorySha256 } from "./remote-worker-cell-capacity-inventory.js";
import { readRemoteWorkerCellObjectInventory } from "./remote-worker-cell-object-inventory.js";

describe("native host/guest capacity composition", () => {
  it("charges host backing once, separates guest allocation, and counts each shared logical reference", () => {
    const f = fixture(), result = f.compose();
    const accounting = accountRemoteWorkerCellCapacityInventory(result, { profileSha256: result.profileSha256,
      captureSha256: result.captureSha256, inventorySha256: remoteWorkerCellCapacityInventorySha256(result) });
    expect(accounting.hostAllocatedBytes).toBe(f.hostAllocated); expect(accounting.guestAllocatedBytes).toBe(22 * 4096);
    expect(accounting.logicalReferenceBytes).toBe(84); expect(accounting.logicalReferenceCount).toBe(2);
    expect(accounting.hostFileCount).toBe(3); expect(accounting.hostDirectoryCount).toBe(17);
    expect(accounting.guestFileCount).toBe(22); expect(accounting.guestDirectoryCount).toBe(4);
    expect(result.areas.flatMap(area => area.objects).filter(object => object.kind === "volume_backing")).toHaveLength(1);
    expect(result.nativeLayout).toEqual(f.layout); expect(new Set(result.areas.map(area => area.evidenceSha256)).size).toBe(13);
    expect(Object.isFrozen(result.areas[0]?.objects[0])).toBe(true);
    f.source.references.length = 0; expect(result.references).toHaveLength(2);
  });
  it.each([2, 3, 4, 5, 6, 7])("rejects missing retained host identity %s even with a correctly hashed host capture", omit => {
    expect(() => fixture({ omit }).compose()).toThrow(/Native capacity sources/u);
  });
  it("rejects conflicting allocation across independently valid source frames", () => {
    expect(() => fixture({ backingDelta: 4096 }).compose()).toThrow(/Native capacity sources/u);
  });
  it.each(["nonce", "hostCaptureSha256", "guestObservationSha256", "backingObservationSha256", "referencesSha256"] as const)("rejects a substituted %s", field => {
    const f = fixture(); f.window[field] = "ee".repeat(32); expect(f.compose).toThrow(/Native capacity (sources|capture)/u);
  });
  it("enforces the combined object ceiling rather than separate per-source ceilings", () => {
    expect(() => fixture({ extra: 19980 }).compose()).toThrow(/Cell capacity inventory/u);
  });
  it.each(["journal", "guest"])("does not treat a %s file as a shared immutable artifact", kind => {
    const f = fixture();
    const raw = kind === "journal" ? f.raw(2) : readRemoteWorkerCellObjectInventory(f.source.guestObservationHex,
      f.source.guestChunkHex, f.history).entries.find(entry => !entry.directory)!.identityHex;
    f.source.references[0]!.objectIdentitySha256 = remoteWorkerNativeCapacityIdentitySha256(raw);
    f.window.referencesSha256 = remoteWorkerCellCanonicalSha256(f.source.references); expect(f.compose).toThrow(/Native capacity sources/u);
  });
  it("binds explicit reference absence into a distinct capture without dropping physical artifacts", () => {
    const f = fixture(), original = f.compose(); f.source.references.length = 0;
    f.window.referencesSha256 = remoteWorkerCellCanonicalSha256([]);
    const next = f.compose(); expect(next.references).toEqual([]); expect(next.captureSha256).not.toBe(original.captureSha256);
    expect(next.areas.flatMap(area => area.objects)).toEqual(original.areas.flatMap(area => area.objects));
    expect(next.areas.every((area, index) => area.evidenceSha256 !== original.areas[index]!.evidenceSha256)).toBe(true);
  });
  it("rejects source accessors without invoking them", () => {
    const f = fixture(); let called = false;
    Object.defineProperty(f.source, "references", { enumerable: true, get() { called = true; return []; } });
    expect(f.compose).toThrow(/Native capacity sources/u); expect(called).toBe(false);
  });
});
