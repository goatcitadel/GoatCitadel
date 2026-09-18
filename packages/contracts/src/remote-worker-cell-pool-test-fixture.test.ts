import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { objectInventoryHistoryFixture, objectInventoryFixture } from "./remote-worker-cell-object-inventory-test-fixture.js";
import { backingCapacityObservationFixture } from "./remote-worker-cell-backing-capacity-test-fixture.js";
import { readRemoteWorkerCellObjectInventory } from "./remote-worker-cell-object-inventory.js";
import { readRemoteWorkerCellBackingCapacityObservation } from "./remote-worker-cell-backing-capacity.js";

describe("independent multi-member fixture histories", () => {
  it("preserves the pre-change default fixture digest", () => {
    expect(createHash("sha256").update(JSON.stringify(objectInventoryHistoryFixture())).digest("hex"))
      .toBe("d53b802879b822c8bbbf90e1c7672546e6ae4eb505a70eba35b2f1b94c775315");
  });
  it("validates 64 distinct journals, backing files and guest volumes under one parent", () => {
    const journals = new Set<string>(), backings = new Set<string>(), volumes = new Set<string>(), bindings = new Set<string>();
    const parent = objectInventoryHistoryFixture().plan.parentIdentityHex;
    for (let seed = 0; seed < 64; seed++) {
      const history = objectInventoryHistoryFixture(seed), encoded = objectInventoryFixture(history);
      const guest = readRemoteWorkerCellObjectInventory(encoded.summary.toString("hex"), encoded.chunks.map(chunk => chunk.toString("hex")), history);
      const backing = readRemoteWorkerCellBackingCapacityObservation(backingCapacityObservationFixture(history).toString("hex"), history);
      expect(history.plan.parentIdentityHex).toBe(parent);
      journals.add(backing.journalIdentityHex); backings.add(backing.backingIdentityHex);
      volumes.add(guest.entries[0]!.identityHex.slice(0, 16)); bindings.add(history.plan.assignmentBindingSha256);
    }
    expect([journals.size, backings.size, volumes.size, bindings.size]).toEqual([64, 64, 64, 64]);
  }, 30000);
  it.each([-1, 64, 1.5, NaN])("rejects invalid seed %s", seed => {
    expect(() => objectInventoryHistoryFixture(seed)).toThrow(RangeError);
  });
});
