import { describe, expect, it } from "vitest";
import { objectInventoryHistoryFixture } from "./remote-worker-cell-object-inventory-test-fixture.js";
import { normalizeRemoteWorkerRuntimeInstallSelectionSubmission as select, normalizeRemoteWorkerRuntimeInstallSelection as selection } from "./remote-worker-runtime-install-exchange.js";
import { normalizeRemoteWorkerRuntimeInstallSubmission as submission, normalizeRemoteWorkerRuntimeInstallExchange as exchange,
  REMOTE_WORKER_RUNTIME_INSTALL_EXCHANGE_SCHEMA_VERSION } from "./remote-worker-runtime-install-exchange.js";
function fixture() {
  const nonce = "11".repeat(32), requestSha256 = "22".repeat(32), bytes = Buffer.alloc(352);
  bytes.write("GCRLI001"); bytes.write("GCRLIT01", 256); Buffer.from(nonce, "hex").copy(bytes, 8);
  Buffer.from(requestSha256, "hex").copy(bytes, 40); bytes.fill(51, 320);
  const select = { kind: "runtime.install.retain", nonce, requestSha256, outcomeHex: bytes.toString("hex") };
  const result = { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_EXCHANGE_SCHEMA_VERSION, registryWorkspaceId: "registry", assignmentId: "assignment",
    assignmentGeneration: 1, leaseRevision: 2, nonce, requestSha256,
    record: { outcomeHex: select.outcomeHex, outcomeSha256: "33".repeat(32), leaseRevision: 1, recordedAt: "2026-09-16T00:00:00.000Z" } };
  return { select, result };
}
describe("installation evidence envelope", () => {
  it("allows only a bounded read challenge and complete retained history for selection", () => {
    const query = { kind: "runtime.install.select", challenge: "ab".repeat(32) };
    expect(select(query)).toEqual(query);
    let read = false;
    for (const value of [{ ...query, request: {} }, { ...query, approved: true }, { ...query, challenge: "00".repeat(32) },
      { kind: query.kind, get challenge() { read = true; return query.challenge; } }, Object.create(query)]) expect(() => select(value)).toThrow();
    expect(read).toBe(false);
    const result = { schemaVersion: "goatcitadel.remote-worker-runtime-install-selection.v1", challenge: query.challenge,
      history: objectInventoryHistoryFixture(), request: null };
    expect(selection(result)).toEqual(result);
    for (const patch of [{ request: {} }, { challenge: "bad" }, { approved: true }, { history: { ...result.history, mountedWorkspaceRecords: [] } }])
      expect(() => selection({ ...result, ...patch })).toThrow();
  });
  it("snapshots lookup and retained evidence without implying installation authority", () => {
    const f = fixture(), value = exchange(f.result), selected = submission(f.select);
    expect(value).toEqual(f.result); expect(Object.isFrozen(value.record)).toBe(true);
    f.result.record.outcomeHex = "changed"; f.select.nonce = "changed";
    expect(value.record?.outcomeHex).not.toBe("changed"); expect(selected.nonce).not.toBe("changed");
    expect(exchange({ ...value, record: null }).record).toBeNull();
    expect(submission({ kind: "runtime.install.lookup", nonce: value.nonce, requestSha256: value.requestSha256 }).kind).toBe("runtime.install.lookup");
  });
  it("rejects accessors without invoking them and rejects inherited or extra authority fields", () => {
    const f = fixture(); let called = false;
    const getter = { ...f.select, get nonce() { called = true; return f.select.nonce; } };
    for (const value of [getter, Object.create(f.select), { ...f.select, approved: true }, { ...f.select, [Symbol()]: true }])
      expect(() => submission(value)).toThrow();
    expect(called).toBe(false);
  });
  it("rejects malformed records, substituted bindings and future receipt leases", () => {
    const f = fixture();
    for (const patch of [{ nonce: "44".repeat(32) }, { requestSha256: "44".repeat(32) }, { outcomeHex: f.select.outcomeHex.slice(0, 512) },
      { outcomeHex: f.select.outcomeHex.toUpperCase() }, { nonce: "00".repeat(32) }]) expect(() => submission({ ...f.select, ...patch })).toThrow();
    for (const patch of [{ outcomeSha256: "44".repeat(32) }, { leaseRevision: 3 }, { recordedAt: "yesterday" }, { recordedAt: "2026-09-16" }])
      expect(() => exchange({ ...f.result, record: { ...f.result.record, ...patch } })).toThrow();
    for (const patch of [{ assignmentGeneration: 0 }, { registryWorkspaceId: "bad\n" }, { record: undefined }, { extra: true }])
      expect(() => exchange({ ...f.result, ...patch })).toThrow();
  });
});
