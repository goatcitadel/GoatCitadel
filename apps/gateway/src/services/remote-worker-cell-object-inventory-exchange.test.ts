import { describe, expect, it, vi } from "vitest";
import { REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION, REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT } from "@goatcitadel/contracts";
import type { RemoteWorkerCellObjectInventoryAssignmentInput } from "@goatcitadel/storage";
import { objectInventoryFixture, objectInventoryHistoryFixture } from "../../../../packages/contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { exchangeRemoteWorkerCellObjectInventory as exchange } from "./remote-worker-cell-object-inventory-exchange.js";

function fixture() {
  const history = objectInventoryHistoryFixture(), bytes = objectInventoryFixture(history);
  const submission = { kind: "cell.object_inventory.observation" as const, expectedRevision: 0, observationHex: bytes.summary.toString("hex"),
    chunkHex: bytes.chunks.map(chunk => chunk.toString("hex")), nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT };
  const input = { registryWorkspaceId: history.registryWorkspaceId, assignmentId: history.assignmentId, assignmentGeneration: history.assignmentGeneration,
    leaseRevision: history.leaseRevision, leaseTokenSha256: "1".repeat(64), submission,
    protectedAuthority: { credentialAuthority: { credentialGeneration: 1 }, meshAdmission: { admissionGeneration: 1 } } } as unknown as RemoteWorkerCellObjectInventoryAssignmentInput;
  const result = { schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION, history,
    record: { revision: 1, leaseRevision: history.leaseRevision, recordedAt: "2026-09-14T00:00:00.000Z",
      observationHex: submission.observationHex, chunkHex: [...submission.chunkHex], nativeReceiptHex: submission.nativeReceiptHex } };
  return { input, result, bytes, submission };
}
describe("internal object inventory persistence exchange", () => {
  it("awaits the repository and freezes caller chunks and authority before yielding", async () => {
    const f = fixture();
    const owner = { exchange: vi.fn(async (value: RemoteWorkerCellObjectInventoryAssignmentInput) => {
      await Promise.resolve(); f.submission.chunkHex.fill("00");
      expect(Object.isFrozen(value.submission) && "chunkHex" in value.submission && Object.isFrozen(value.submission.chunkHex)).toBe(true);
      expect(Object.isFrozen(value.protectedAuthority.credentialAuthority) && Object.isFrozen(value.protectedAuthority.meshAdmission)).toBe(true);
      return f.result;
    }) };
    await expect(exchange(owner, f.input)).resolves.toEqual(f.result); expect(owner.exchange).toHaveBeenCalledTimes(1);
  });
  it.each(["scope", "lease", "revision", "chunks", "missing", "malformed"])("refuses an owner result with changed %s", async mode => {
    const f = fixture();
    if (mode === "scope") f.result.history = { ...f.result.history, assignmentId: "another" };
    if (mode === "lease") f.result.history = { ...f.result.history, leaseRevision: f.result.history.leaseRevision + 1 };
    if (mode === "revision") f.result.record.revision = 2;
    if (mode === "chunks") {
      const chunk = Buffer.from(f.result.record.chunkHex[1]!, "hex"); chunk.writeBigUInt64LE(4095n, 80); chunk.writeBigUInt64LE(4097n, 128);
      f.result.record.chunkHex[1] = chunk.toString("hex");
    }
    if (mode === "malformed") f.result.record.chunkHex.reverse();
    await expect(exchange({ exchange: async () => mode === "missing" ? { ...f.result, record: null } : f.result }, f.input)).rejects.toThrow();
  });
  it.each(["before", "after"])("withholds cancelled %s persistence", async stage => {
    const f = fixture(), cancellation = new AbortController();
    const owner = { exchange: vi.fn(async () => { await Promise.resolve(); cancellation.abort(); return f.result; }) };
    if (stage === "before") cancellation.abort();
    await expect(exchange(owner, { ...f.input, signal: cancellation.signal })).rejects.toThrow();
    expect(owner.exchange).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
  });
  it("requires the owner and validates input before owner invocation", async () => {
    const f = fixture(), owner = { exchange: vi.fn(async () => f.result) };
    await expect(exchange(undefined, f.input)).rejects.toThrow(/unavailable/u);
    await expect(exchange(owner, { ...f.input, submission: { ...f.submission, chunkHex: [] } })).rejects.toThrow();
    expect(owner.exchange).not.toHaveBeenCalled();
  });
});
