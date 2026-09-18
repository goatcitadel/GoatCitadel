import { describe, expect, it } from "vitest";
import { objectInventoryHistoryFixture, objectInventoryFixture } from "./remote-worker-cell-object-inventory-test-fixture.js";
import { backingCapacityObservationFixture } from "./remote-worker-cell-backing-capacity-test-fixture.js";
import { readRemoteWorkerCellCapacityObservation, readRemoteWorkerCellCapacityHistoryObservation } from "./remote-worker-cell-capacity-observation.js";
import { readRemoteWorkerCellObjectInventory, readRemoteWorkerCellObjectInventoryHistory } from "./remote-worker-cell-object-inventory.js";
import { readRemoteWorkerCellBackingCapacityObservation, readRemoteWorkerCellBackingCapacityHistoryObservation } from "./remote-worker-cell-backing-capacity.js";

function fixture(seed = 0) {
  const exchange = objectInventoryHistoryFixture(seed), guest = objectInventoryFixture(exchange);
  const { schemaVersion: _schema, registryWorkspaceId: _registry, assignmentId: _assignment,
    assignmentGeneration: _generation, leaseRevision: _lease, ...history } = exchange;
  const summary = guest.summary.toString("hex"), chunks = guest.chunks.map(chunk => chunk.toString("hex"));
  const backing = backingCapacityObservationFixture(exchange).toString("hex");
  return { exchange, history, summary, chunks, backing };
}
describe("resource-history capacity readers", () => {
  it.each([0, 1])("retains the existing evidence for member %s without assignment authority", seed => {
    const f = fixture(seed);
    const current = [readRemoteWorkerCellCapacityObservation(f.summary, f.exchange),
      readRemoteWorkerCellObjectInventory(f.summary, f.chunks, f.exchange), readRemoteWorkerCellBackingCapacityObservation(f.backing, f.exchange)];
    const historical = [readRemoteWorkerCellCapacityHistoryObservation(f.summary, f.history),
      readRemoteWorkerCellObjectInventoryHistory(f.summary, f.chunks, f.history), readRemoteWorkerCellBackingCapacityHistoryObservation(f.backing, f.history)];
    current.forEach((value, index) => {
      const { registryWorkspaceId: _registry, assignmentId: _assignment, assignmentGeneration: _generation, leaseRevision: _lease, ...evidence } = value;
      expect(historical[index]).toEqual(evidence);
      expect(Object.isFrozen(historical[index])).toBe(true);
      for (const key of ["registryWorkspaceId", "assignmentId", "assignmentGeneration", "leaseRevision"])
        expect(Object.hasOwn(historical[index]!, key)).toBe(false);
    });
    expect(historical[0]!.assignmentBindingSha256).toBe(f.history.plan.assignmentBindingSha256);
    expect(historical[0]!.checkpointSha256).toBe(f.history.mountedWorkspaceRecords![1]!.slice(-64));
  });
  it.each(["summary", "inventory", "backing"] as const)("%s refuses partial, foreign and authority-bearing history", kind => {
    const f = fixture(), other = fixture(1);
    const read = (history: typeof f.history) => kind === "summary" ? readRemoteWorkerCellCapacityHistoryObservation(f.summary, history)
      : kind === "inventory" ? readRemoteWorkerCellObjectInventoryHistory(f.summary, f.chunks, history)
      : readRemoteWorkerCellBackingCapacityHistoryObservation(f.backing, history);
    expect(() => read(other.history)).toThrow();
    for (const key of ["records", "volumeRecords", "formatRecords", "protectionRecords", "mountRecords", "mountedWorkspaceRecords"] as const)
      expect(() => read({ ...f.history, [key]: f.history[key]!.slice(0, -1) })).toThrow();
    expect(() => read({ ...f.history, leaseRevision: 1 } as never)).toThrow();
    expect(() => read(f.exchange)).toThrow();
    let calls = 0;
    const accessor = Object.defineProperty({ ...f.history }, "plan", { enumerable: true, get() { calls++; return f.history.plan; } });
    expect(() => read(accessor)).toThrow(); expect(calls).toBe(0);
  });
  it("refuses truncated, reordered and nonce-substituted historical inventory chunks", () => {
    const f = fixture();
    expect(() => readRemoteWorkerCellObjectInventoryHistory(f.summary, f.chunks.slice(0, -1), f.history)).toThrow();
    expect(() => readRemoteWorkerCellObjectInventoryHistory(f.summary, [...f.chunks].reverse(), f.history)).toThrow();
    expect(() => readRemoteWorkerCellObjectInventoryHistory(f.summary, ["aa".repeat(32) + f.chunks[0]!.slice(64), ...f.chunks.slice(1)], f.history)).toThrow();
  });
});
