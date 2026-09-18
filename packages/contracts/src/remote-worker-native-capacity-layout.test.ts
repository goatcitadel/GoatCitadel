import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeRemoteWorkerNativeCapacityLayout, remoteWorkerNativeCapacityIdentitySha256 } from "./remote-worker-native-capacity-layout.js";
import { normalizeRemoteWorkerCellCapacityInventory, remoteWorkerCellCapacityInventorySha256 } from "./remote-worker-cell-capacity-inventory.js";
import { capacityInventoryFixture, withNativeCapacityLayout } from "./remote-worker-cell-capacity-inventory-test-fixture.js";
const fixture = () => withNativeCapacityLayout(capacityInventoryFixture("11".repeat(32), "layout"), "22".repeat(32));
describe("retained native capacity layout", () => {
  it("binds every native host root to its area without changing historical inventories", () => {
    const before = capacityInventoryFixture("11".repeat(32), "layout"), input = fixture();
    const normalized = normalizeRemoteWorkerCellCapacityInventory(input);
    expect(normalized.nativeLayout).toEqual(input.nativeLayout);
    expect(Object.isFrozen(normalized.nativeLayout?.rootIdentityHex)).toBe(true);
    expect(Object.hasOwn(normalizeRemoteWorkerCellCapacityInventory(before), "nativeLayout")).toBe(false);
    expect(remoteWorkerCellCapacityInventorySha256(normalized)).not.toBe(remoteWorkerCellCapacityInventorySha256(before));
    const id = input.nativeLayout.rootIdentityHex[0]!;
    expect(remoteWorkerNativeCapacityIdentitySha256(id)).toBe(createHash("sha256").update("goatcitadel.native-file-identity.v1\0").update(Buffer.from(id, "hex")).digest("hex"));
  });
  it.each(["missing", "duplicate", "relabel", "file", "guest", "profile", "undefined"])("rejects %s root coverage", mode => {
    const input = fixture();
    if (mode === "missing") input.areas[0]!.objects.pop();
    if (mode === "duplicate") input.nativeLayout.rootIdentityHex[1] = input.nativeLayout.rootIdentityHex[0]!;
    if (mode === "relabel") input.nativeLayout.rootIdentityHex.reverse();
    const objects = input.areas[0]!.objects, last = objects.length - 1;
    if (mode === "file") objects[last] = { ...objects[last]!, kind: "file" };
    if (mode === "guest") objects[last] = { ...objects[last]!, backingIdentitySha256: objects[0]!.identitySha256 };
    if (mode === "profile") input.nativeLayout.profileSha256 = "33".repeat(32);
    expect(() => normalizeRemoteWorkerCellCapacityInventory(mode === "undefined" ? { ...input, nativeLayout: undefined } : input)).toThrow();
  });
  it("rejects malformed identities, sparse roots, authority extras and getters without executing them", () => {
    const layout = fixture().nativeLayout; let reads = 0;
    const sparse = [...layout.rootIdentityHex]; delete sparse[4];
    const accessor = [...layout.rootIdentityHex]; Object.defineProperty(accessor, "4", { enumerable: true, get() { reads++; return layout.rootIdentityHex[4]; } });
    for (const value of [{ ...layout, approved: true }, { ...layout, rootIdentityHex: sparse }, { ...layout, rootIdentityHex: accessor },
      { ...layout, rootIdentityHex: layout.rootIdentityHex.slice(1) }, { ...layout, assignmentBindingSha256: "0".repeat(64) },
      { ...layout, get profileSha256() { reads++; return layout.profileSha256; } }])
      expect(() => normalizeRemoteWorkerNativeCapacityLayout(value)).toThrow();
    for (const value of ["0".repeat(48), "11".repeat(8) + "0".repeat(32), "AA".repeat(24), "11".repeat(23)])
      expect(() => remoteWorkerNativeCapacityIdentitySha256(value)).toThrow();
    expect(reads).toBe(0);
  });
});
