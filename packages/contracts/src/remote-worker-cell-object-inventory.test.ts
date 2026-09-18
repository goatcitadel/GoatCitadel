import { describe, expect, it } from "vitest";
import { objectInventoryFixture, objectInventoryHistoryFixture } from "./remote-worker-cell-object-inventory-test-fixture.js";
import { readRemoteWorkerCellObjectInventory, normalizeRemoteWorkerCellObjectInventorySubmission, normalizeRemoteWorkerCellObjectInventoryExchange,
  REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION } from "./remote-worker-cell-object-inventory.js";
import { REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT } from "./remote-worker-cell-capacity-observation.js";

describe("native mounted object inventory", () => {
  const history = objectInventoryHistoryFixture();
  const decode = (summary: Buffer, chunks: Buffer[]) => readRemoteWorkerCellObjectInventory(summary.toString("hex"), chunks.map(value => value.toString("hex")), history);
  const submitted = () => {
    const { summary, chunks } = objectInventoryFixture(history);
    return { kind: "cell.object_inventory.observation" as const, expectedRevision: 0, observationHex: summary.toString("hex"),
      chunkHex: chunks.map(chunk => chunk.toString("hex")), nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT };
  };
  it("freezes exact submission chunks and retains only complete, successful records", () => {
    const input = submitted(), frozen = normalizeRemoteWorkerCellObjectInventorySubmission(input);
    input.chunkHex.fill("mutated"); expect("chunkHex" in frozen && frozen.chunkHex[0]?.length).toBe(2000);
    const source = submitted();
    const retained = { revision: 1, leaseRevision: history.leaseRevision, recordedAt: "2026-09-14T00:00:00.000Z",
      observationHex: source.observationHex, chunkHex: source.chunkHex, nativeReceiptHex: source.nativeReceiptHex };
    expect(normalizeRemoteWorkerCellObjectInventoryExchange({ schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION,
      history, record: retained }).record).toEqual(retained);
    expect(normalizeRemoteWorkerCellObjectInventoryExchange({ schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION,
      history, record: null }).record).toBeNull();
    expect(() => normalizeRemoteWorkerCellObjectInventoryExchange({ schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION,
      history, record: { ...retained, chunkHex: [...retained.chunkHex].reverse() } })).toThrow();
  });
  it.each(["kind", "revision", "receipt", "empty", "oversized", "getter", "extra"])("refuses %s submission without executing caller properties", mode => {
    const input: Record<string, unknown> = submitted(); let reads = 0;
    if (mode === "kind") input.kind = "cell.capacity.observation";
    if (mode === "revision") input.expectedRevision = -1;
    if (mode === "receipt") input.nativeReceiptHex = "00".repeat(16);
    if (mode === "empty") input.chunkHex = [];
    if (mode === "oversized") input.chunkHex = new Array(1001).fill("00".repeat(1000));
    if (mode === "extra") input.unexpected = true;
    if (mode === "getter") Object.defineProperty(input, "chunkHex", { enumerable: true, get: () => { reads += 1; return []; } });
    expect(() => normalizeRemoteWorkerCellObjectInventorySubmission(input)).toThrow(); expect(reads).toBe(0);
  });
  it("retains exact large logical values, zero-byte files and all roots across batches", () => {
    const fixture = objectInventoryFixture(history), value = decode(fixture.summary, fixture.chunks);
    expect(value.entries).toHaveLength(26); expect(value.fileCount).toBe(22); expect(value.directoryCount).toBe(4);
    expect(value.logicalFileBytes).toBe(0x200000005); expect(value.allocatedBytes).toBe(22 * 4096);
    expect(value.entries.filter(entry => !entry.directory && !entry.logicalFileBytes)).toHaveLength(21);
    expect(value.entries.map(entry => entry.identityHex)).toEqual(fixture.records.map(record => record.subarray(0, 24).toString("hex")));
    expect(Object.isFrozen(value.entries) && value.entries.every(Object.isFrozen) && Object.isFrozen(value.chunkHex)).toBe(true);
    fixture.chunks[0]!.fill(0); expect(value.entries).toHaveLength(26);
  });
  it("accepts the full 20,000-object bound and refuses one more", () => {
    const limit = objectInventoryFixture(history, 19996);
    expect(decode(limit.summary, limit.chunks).entries).toHaveLength(20000);
    const excess = objectInventoryFixture(history, 19997);
    expect(() => decode(excess.summary, excess.chunks)).toThrow();
  });
  it.each(["missing", "duplicate", "order", "nonce", "start", "count", "zero", "padding", "kind", "reserved", "volume", "identity", "bytes", "unsafe", "root"])("refuses %s corruption", (mode) => {
    const { summary, chunks } = objectInventoryFixture(history);
    switch (mode) {
      case "missing": chunks.pop(); break;
      case "duplicate": chunks[1] = Buffer.from(chunks[0]!); break;
      case "order": chunks.reverse(); break;
      case "nonce": chunks[1]![0] = chunks[1]![0]! ^ 1; break;
      case "start": chunks[1]!.writeUInt32LE(21, 32); break;
      case "count": chunks[0]!.writeUInt32LE(21, 36); break;
      case "zero": chunks[0]!.writeUInt32LE(0, 36); break;
      case "padding": chunks[1]![999] = 1; break;
      case "kind": chunks[0]!.writeUInt32LE(2, 64); break;
      case "reserved": chunks[0]![68] = 1; break;
      case "volume": chunks[1]![40] = chunks[1]![40]! ^ 1; break;
      case "identity": chunks[0]!.copy(chunks[1]!, 40, 40, 64); break;
      case "bytes": chunks[1]!.writeBigUInt64LE(8192n, 80); break;
      case "unsafe": chunks[1]!.writeBigUInt64LE(2n ** 64n - 1n, 80); break;
      case "root": summary[120] = summary[120]! ^ 1; break;
    }
    expect(() => decode(summary, chunks)).toThrow();
  });
  it("refuses executable, sparse and additional array properties", () => {
    const { summary, chunks } = objectInventoryFixture(history), values = chunks.map(value => value.toString("hex"));
    let reads = 0;
    const getter = [...values]; Object.defineProperty(getter, "0", { enumerable: true, get: () => { reads += 1; return values[0]; } });
    for (const input of [getter, new Array(values.length), Object.assign([...values], { extra: true }), Object.assign([...values], { [Symbol("extra")]: true })])
      expect(() => readRemoteWorkerCellObjectInventory(summary.toString("hex"), input, history)).toThrow();
    expect(reads).toBe(0);
  });
});
