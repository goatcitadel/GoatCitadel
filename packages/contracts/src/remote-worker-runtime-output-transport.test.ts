import { describe, expect, it } from "vitest";
import { REMOTE_WORKER_RUNTIME_OUTPUT_RECEIPT_SCHEMA, normalizeRemoteWorkerRuntimeOutputReceipt,
  normalizeRemoteWorkerRuntimeOutputSubmission } from "./remote-worker-runtime-output-transport.js";
import { REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA } from "./remote-worker-runtime-output.js";
import { sha256Hex } from "./sha256.js";
function receipt() {
  return { schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_RECEIPT_SCHEMA, registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1,
    leaseRevision: 2, nonce: "11".repeat(32), requestSha256: "22".repeat(32), resultSha256: "33".repeat(32), evidenceSha256: "44".repeat(32),
    recordedLeaseRevision: 1, recordedAt: "2026-09-15T00:00:00.000Z" };
}
describe("native output receipt", () => {
  it("preserves an earlier immutable retention revision while binding the current lease", () => {
    const value = normalizeRemoteWorkerRuntimeOutputReceipt(receipt());
    expect(value).toEqual(receipt()); expect(Object.isFrozen(value)).toBe(true);
  });
  it.each(["extra", "getter", "scope", "revision", "future", "date", "hash", "schema"])("rejects malformed %s receipts", mode => {
    const value = receipt();
    if (mode === "extra") Object.assign(value, { completed: true });
    if (mode === "getter") Object.defineProperty(value, "recordedAt", { enumerable: true, get: () => { throw new Error("must not invoke"); } });
    if (mode === "scope") value.assignmentId = "unsafe\n";
    if (mode === "revision") value.leaseRevision = 0;
    if (mode === "future") value.recordedLeaseRevision = 3;
    if (mode === "date") value.recordedAt = "2026-02-30T00:00:00.000Z";
    if (mode === "hash") value.evidenceSha256 = "0".repeat(64);
    if (mode === "schema") Object.assign(value, { schemaVersion: "foreign" });
    expect(() => normalizeRemoteWorkerRuntimeOutputReceipt(value)).toThrow();
  });
  it("bounds worst-case JSON escaping below the existing 512 KiB protocol limit", () => {
    const stream = { bytes: 32768, sha256: sha256Hex("raw"), text: "\u0001".repeat(32768), truncated: false, provenance: "native_stream_local_diagnostic" };
    const value = normalizeRemoteWorkerRuntimeOutputSubmission({ kind: "runtime.output.retain", evidence: { schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA,
      nonce: "11".repeat(32), requestSha256: "22".repeat(32), resultSha256: "33".repeat(32), streams: { stdout: stream, stderr: stream } } });
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThan(400000);
    expect(Object.isFrozen(value.evidence.streams.stdout)).toBe(true);
    expect(() => normalizeRemoteWorkerRuntimeOutputSubmission({ ...value, approved: true })).toThrow();
  });
});
