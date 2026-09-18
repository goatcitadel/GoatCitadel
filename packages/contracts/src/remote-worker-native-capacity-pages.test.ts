import { describe, expect, it } from "vitest";
import { normalizeRemoteWorkerNativeCapacityPageSubmission as page, normalizeRemoteWorkerNativeCapacityPageExchange as exchange,
  REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA, REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES } from "./remote-worker-native-capacity-pages.js";
const fixture = () => ({ kind: "cell.native_capacity.page" as const, nonce: "11".repeat(32), bundleSha256: "22".repeat(32),
  deliverySha256: "33".repeat(32), byteLength: 65536, offset: 0, bytesHex: "7b".repeat(32768) });
const response = () => ({ schemaVersion: REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA, registryWorkspaceId: "default", assignmentId: "assignment",
  assignmentGeneration: 1, leaseRevision: 2, nonce: fixture().nonce, bundleSha256: fixture().bundleSha256,
  record: null, accepted: { page: fixture(), nextOffset: 32768 } });
describe("bounded native capacity pages", () => {
  it("bounds even a maximum sized capture to 32 KiB data per request", () => {
    const f = fixture(), maximum = 16 * 1024 * 1024;
    expect(page({ ...f, byteLength: maximum, offset: maximum - REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES })).toMatchObject({ offset: maximum - 32768 });
    expect(JSON.stringify(page(f)).length).toBeLessThan(70_000);
    expect(Object.isFrozen(page(f))).toBe(true);
  });
  it.each([{ offset: 1 }, { offset: -1 }, { offset: 65536 }, { byteLength: 16777217 }, { bytesHex: "ab" },
    { bytesHex: "ff".repeat(32769) }, { bytesHex: "FF".repeat(32768) }, { bundleSha256: "00".repeat(32) }, { approved: true }])("rejects malformed or expanded pages", patch => {
    expect(() => page({ ...fixture(), ...patch })).toThrow(/protected capture/u);
  });
  it("requires a final canonical receipt instead of treating staged completion as success", () => {
    const result = response();
    expect(exchange(result).record).toBeNull();
    expect(() => exchange({ ...result, accepted: { page: { ...fixture(), offset: 32768 }, nextOffset: 65536 } })).toThrow();
    const record = { bundleSha256: fixture().bundleSha256, deliverySha256: fixture().deliverySha256, captureSha256: "44".repeat(32),
      inventorySha256: "55".repeat(32), byteLength: 65536, revision: 7, decision: "quarantine" };
    expect(exchange({ ...result, record, accepted: { page: { ...fixture(), offset: 32768 }, nextOffset: 65536 } }).record?.decision).toBe("quarantine");
    expect(() => exchange({ ...result, record })).toThrow();
  });
  it("refuses stale or cross-capture acknowledgements", () => {
    const result = response();
    for (const patch of [{ nonce: "66".repeat(32) }, { bundleSha256: "77".repeat(32) }]) expect(() => exchange({ ...result, ...patch })).toThrow();
    for (const nextOffset of [0, 32769, 65536, 65537]) expect(() => exchange({ ...result, accepted: { ...result.accepted, nextOffset } })).toThrow();
  });
  it("accepts exact small final pages and refuses lookup smuggling", () => {
    expect(page({ ...fixture(), byteLength: 3, bytesHex: "7b7d0a" })).toMatchObject({ byteLength: 3 });
    const lookup = { kind: "cell.native_capacity.lookup", nonce: fixture().nonce, bundleSha256: fixture().bundleSha256 };
    expect(page(lookup)).toEqual(lookup);
    expect(() => page({ ...lookup, bytesHex: "ff" })).toThrow();
  });
  it("does not invoke accessors during input validation", () => {
    let invoked = false;
    const input = { ...fixture(), get bytesHex() { invoked = true; return "7b".repeat(32768); } };
    expect(() => page(input)).toThrow(); expect(invoked).toBe(false);
  });
});
