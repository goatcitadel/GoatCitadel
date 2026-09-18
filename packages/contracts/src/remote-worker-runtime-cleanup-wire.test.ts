import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runtimeResultPagesFixture } from "./remote-worker-runtime-result-pages-test-fixture.js";
import { remoteWorkerCellProvisioningHistoryMountedWorkspaceAnchor, remoteWorkerCellProvisioningMountedWorkspaceAnchor } from "./remote-worker-cell-provisioning.js";
import { encodeRemoteWorkerRuntimeCleanup, encodeRemoteWorkerRuntimeCleanupHistory } from "./remote-worker-runtime-cleanup-wire.js";
import { normalizeRemoteWorkerRuntimeCleanupHistory, REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA } from "./remote-worker-runtime-cleanup.js";

function fixture(count = 2) {
  const f = runtimeResultPagesFixture(2);
  const exchange = { schemaVersion: REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA, challenge: "cc".repeat(32), history: f.history,
    expectations: Array.from({ length: count }, (_, index) => ({ ...f.expectation, nonce: (index + 1).toString(16).padStart(64, "0") })) };
  const { schemaVersion: _schema, registryWorkspaceId: _registry, assignmentId: _assignment,
    assignmentGeneration: _generation, leaseRevision: _lease, ...history } = f.history;
  return { exchange, resource: { challenge: exchange.challenge, history, expectations: exchange.expectations } };
}
describe("native cleanup encoding from resource history", () => {
  it.each([
    [0, "5c2ac63651a40c5d02daa4752bf54ec13255acb1b8dcf71bb0914fcfe305c6d4"],
    [2, "192e4b1d6023e13dee2657c18876b125c505a8ab9826f030f3122513fabec537"],
  ] as const)("preserves the pre-change native wire for %i retained attempts", (count, digest) => {
    // Golden hashes were obtained from the previously built encoder before
    // changing the source, rather than calculated by this implementation.
    const { exchange, resource } = fixture(count), encoded = encodeRemoteWorkerRuntimeCleanupHistory(resource);
    expect(encoded).toEqual(encodeRemoteWorkerRuntimeCleanup(exchange));
    expect(encoded.setSha256).toBe(digest);
    const bytes = Buffer.from(encoded.bytesHex, "hex");
    expect(bytes.length).toBe(252 + 108 * count);
    expect(bytes.subarray(0, 8).toString("ascii")).toBe("GCCLEAN1");
    expect(bytes.readUInt32LE(248)).toBe(count);
    expect(createHash("sha256").update("goatcitadel.worker-runtime-cleanup.v1\0").update(bytes).digest("hex")).toBe(digest);
  });
  it("derives the same mounted anchor without assignment or lease fields", () => {
    const { exchange, resource } = fixture();
    expect(remoteWorkerCellProvisioningHistoryMountedWorkspaceAnchor(resource.history)).toEqual(remoteWorkerCellProvisioningMountedWorkspaceAnchor(exchange.history));
    const normalized = normalizeRemoteWorkerRuntimeCleanupHistory(resource);
    expect(normalized.history).not.toHaveProperty("leaseRevision");
    expect(normalized.history).not.toHaveProperty("assignmentId");
    expect(Object.isFrozen(normalized.expectations[0])).toBe(true);
    expect(() => encodeRemoteWorkerRuntimeCleanupHistory({ ...resource, history: exchange.history })).toThrow();
  });
  it("rejects incomplete, altered and foreign history before encoding", () => {
    const { resource } = fixture();
    for (const patch of [{ records: resource.history.records.slice(0, -1) }, { mountRecords: [] }, { mountedWorkspaceRecords: [] },
      { planSha256: "ee".repeat(32) }, { leaseRevision: 1 }, { provisioningOwner: "worker" }]) {
      expect(() => encodeRemoteWorkerRuntimeCleanupHistory({ ...resource, history: { ...resource.history, ...patch } })).toThrow();
    }
  });
  it("rejects unbound challenges, wrong heads, duplicate or oversized sets and getters", () => {
    const { resource } = fixture();
    for (const patch of [{ challenge: "00".repeat(32) }, { challenge: "wrong" }, { expectations: [...resource.expectations].reverse() },
      { expectations: [resource.expectations[0], resource.expectations[0]] }, { expectations: Array(1001).fill(resource.expectations[0]) },
      { expectations: [{ ...resource.expectations[0], checkpointSha256: "ee".repeat(32) }] }]) {
      expect(() => encodeRemoteWorkerRuntimeCleanupHistory({ ...resource, ...patch })).toThrow();
    }
    let invoked = false;
    expect(() => encodeRemoteWorkerRuntimeCleanupHistory({ ...resource, get expectations() { invoked = true; return []; } })).toThrow();
    expect(invoked).toBe(false);
  });
});
