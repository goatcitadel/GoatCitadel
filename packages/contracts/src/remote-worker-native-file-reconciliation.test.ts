import { describe, expect, it, vi } from "vitest";
import { runtimeResultPagesFixture } from "./remote-worker-runtime-result-pages-test-fixture.js";
import { normalizeRemoteWorkerNativeFileReconciliationSubmission as submission, normalizeRemoteWorkerNativeFileReconciliationExchange as exchange,
  REMOTE_WORKER_NATIVE_FILE_RECONCILIATION_SCHEMA } from "./remote-worker-native-file-reconciliation.js";
const f = runtimeResultPagesFixture(2);
const request = { kind: "runtime.files.reconcile", nonce: f.expectation.nonce, requestSha256: f.expectation.requestSha256, challenge: "11".repeat(32) };
const settled = { receiptSha256: "22".repeat(32), manifestSha256: "33".repeat(32), uploadId: "native:upload-1" };
const response = () => ({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_RECONCILIATION_SCHEMA, challenge: request.challenge, lookup: f.response(null, true), settlement: settled });
describe("native file reconciliation contracts", () => {
  it("preserves pending and complete evidence as frozen metadata", () => {
    expect(Object.isFrozen(submission(request))).toBe(true);
    const value = exchange(response()); expect(value.settlement).toEqual(settled); expect(Object.isFrozen(value.settlement)).toBe(true);
    expect(exchange({ ...response(), settlement: null }).settlement).toBeNull();
    expect(exchange({ ...response(), lookup: f.response(null, false), settlement: null }).lookup.record).toBeNull();
  });
  it.each([{ challenge: "0".repeat(64) }, { nonce: "invalid" }, { approved: true }, { kind: "runtime.files.upload" }])("rejects invalid request %j", patch => {
    expect(() => submission({ ...request, ...patch })).toThrow();
  });
  it.each(["absent", "accepted", "digest", "path", "extra", "getter"])("rejects %s completion evidence", mode => {
    const value = response(); const getter = vi.fn(() => settled);
    if (mode === "absent") value.lookup = f.response(null, false);
    if (mode === "accepted") value.lookup = f.response(f.page(), true);
    if (mode === "digest") value.settlement = { ...settled, receiptSha256: "0".repeat(64) };
    if (mode === "path") value.settlement = { ...settled, uploadId: "../private" };
    if (mode === "extra") Object.assign(value, { completed: true });
    if (mode === "getter") Object.defineProperty(value, "settlement", { enumerable: true, get: getter });
    expect(() => exchange(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});
