import { describe, it, expect } from "vitest";
import { objectInventoryFixture, objectInventoryHistoryFixture } from "./remote-worker-cell-object-inventory-test-fixture.js";
import { readRemoteWorkerCellObjectInventory, readRemoteWorkerCellObjectInventoryPrefix } from "./remote-worker-cell-object-inventory.js";
import { normalizeRemoteWorkerCellObjectInventoryPageSubmission, normalizeRemoteWorkerCellObjectInventoryPageExchange,
  REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION } from "./remote-worker-cell-object-inventory-pages.js";
import { REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT } from "./remote-worker-cell-capacity-observation.js";

describe("bounded object inventory pages", () => {
  const history = objectInventoryHistoryFixture(), fixture = objectInventoryFixture(history, 19996);
  const all = fixture.chunks.map(chunk => chunk.toString("hex")), observationHex = fixture.summary.toString("hex");
  const page = (startChunk = 0) => ({ kind: "cell.object_inventory.page" as const, expectedRevision: 0, observationHex,
    nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT, startChunk, chunkHex: all.slice(startChunk, startChunk + 64) });
  it("keeps all sixteen requests and acknowledgements below existing RPC bounds", () => {
    for (let start = 0; start < 1000; start += 64) {
      const input = page(start), submitted = normalizeRemoteWorkerCellObjectInventoryPageSubmission(input);
      expect(Buffer.byteLength(JSON.stringify(submitted))).toBeLessThan(256 * 1024 - 4096);
      const complete = start + input.chunkHex.length === 1000;
      const record = complete ? { revision: 1, leaseRevision: history.leaseRevision, recordedAt: "2026-09-14T00:00:00.000Z",
        observationHex, nativeReceiptHex: input.nativeReceiptHex } : null;
      const result = normalizeRemoteWorkerCellObjectInventoryPageExchange({ schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION,
        history, record, accepted: { page: input, nextChunk: start + input.chunkHex.length, committedRevision: complete ? 1 : null } });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024 - 4096);
      input.chunkHex.fill("mutated"); expect(result.accepted?.page.chunkHex[0]).toHaveLength(2000);
    }
  });
  it("distinguishes validated prefixes from complete observations", () => {
    const prefix = readRemoteWorkerCellObjectInventoryPrefix(observationHex, all.slice(0, 64), history);
    expect(prefix.complete).toBe(false); expect(prefix.entries).toHaveLength(1280);
    expect(() => readRemoteWorkerCellObjectInventory(observationHex, prefix.chunkHex, history)).toThrow();
    expect(readRemoteWorkerCellObjectInventoryPrefix(observationHex, all, history).complete).toBe(true);
    const corrupted = [...all]; corrupted[64] = corrupted[63]!;
    expect(() => readRemoteWorkerCellObjectInventoryPrefix(observationHex, corrupted.slice(0, 128), history)).toThrow();
  });
  it.each(["oversize", "gap", "fraction", "negative", "extra", "getter", "sparse", "receipt"])("refuses %s pages", mode => {
    const input: Record<string, unknown> = page(); let calls = 0;
    if (mode === "oversize") input.chunkHex = all.slice(0, 65);
    if (mode === "gap") input.startChunk = 1000;
    if (mode === "fraction") input.startChunk = 0.5;
    if (mode === "negative") input.startChunk = -64;
    if (mode === "extra") input.secret = true;
    if (mode === "getter") Object.defineProperty(input, "startChunk", { enumerable: true, get: () => { calls += 1; return 0; } });
    if (mode === "sparse") input.chunkHex = new Array(64);
    if (mode === "receipt") input.nativeReceiptHex = "00".repeat(16);
    expect(() => normalizeRemoteWorkerCellObjectInventoryPageSubmission(input)).toThrow(); expect(calls).toBe(0);
  });
  it.each(["short", "before", "beyond", "fraction", "early-commit", "missing-record"])("refuses %s acknowledgements", mode => {
    const accepted = { page: page(), nextChunk: 64, committedRevision: null as number | null };
    if (mode === "short") accepted.page.chunkHex.pop();
    if (mode === "before") accepted.nextChunk = 0;
    if (mode === "beyond") accepted.nextChunk = 1024;
    if (mode === "fraction") accepted.nextChunk = 64.5;
    if (mode === "early-commit") accepted.committedRevision = 1;
    if (mode === "missing-record") { accepted.nextChunk = 1000; accepted.committedRevision = 1; }
    expect(() => normalizeRemoteWorkerCellObjectInventoryPageExchange({ schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION,
      history, record: null, accepted })).toThrow();
  });
});
