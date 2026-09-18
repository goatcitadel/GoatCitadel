import { describe, expect, it, vi } from "vitest";
import { nativeArtifactFixture } from "./remote-worker-native-artifact-test-fixture.js";
import { normalizeRemoteWorkerNativeFileGrantSubmission as request, normalizeRemoteWorkerNativeFileGrantReceipt as receipt, REMOTE_WORKER_NATIVE_FILE_GRANT_SCHEMA } from "./remote-worker-native-file-grant.js";
function fixture() {
  const f = nativeArtifactFixture(), submission = { kind: "runtime.file.authorize", selection: f.receipt.files[0]!.selection, fileStaging: f.receipt.fileStaging, challenge: "11".repeat(32) };
  return { submission, response: { schemaVersion: REMOTE_WORKER_NATIVE_FILE_GRANT_SCHEMA, leaseRevision: 1, submission, disclosure: f.receipt.disclosure } };
}
describe("native file grant contracts", () => {
  it("freezes the exact file, plan, challenge and disclosure as bounded metadata", () => {
    const f = fixture(), result = receipt(f.response);
    expect(result.submission).toEqual(f.submission); expect(Object.isFrozen(result.submission.selection)).toBe(true);
    expect(Object.isFrozen(result.submission.fileStaging.paths)).toBe(true); expect(JSON.stringify(result).length).toBeLessThan(4096);
  });
  it.each(["kind", "challenge", "path", "file-bound", "total-bound", "extra", "getter"])("rejects %s before accepting a request", mode => {
    const f = fixture(), value = f.submission, getter = vi.fn(() => value.selection);
    if (mode === "kind") value.kind = "runtime.file.upload";
    if (mode === "challenge") value.challenge = "0".repeat(64);
    if (mode === "path") value.fileStaging = { ...value.fileStaging, paths: ["different.txt"] };
    if (mode === "file-bound") value.selection = { ...value.selection, maximumBytes: 1024 };
    if (mode === "total-bound") value.fileStaging = { ...value.fileStaging, maximumTotalBytes: 1 };
    if (mode === "extra") Object.assign(value, { approved: true });
    if (mode === "getter") Object.defineProperty(value, "selection", { enumerable: true, get: getter });
    expect(() => request(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it.each(["lease", "nonce", "scope", "plan", "destination", "extra"])("rejects %s receipt substitution", mode => {
    const value = fixture().response;
    if (mode === "lease") value.leaseRevision = 0;
    if (mode === "nonce") value.disclosure = { ...value.disclosure, nonce: "ff".repeat(32) };
    if (mode === "scope") value.disclosure = { ...value.disclosure, assignmentId: "foreign" };
    if (mode === "plan") value.disclosure = { ...value.disclosure, fileStagingSha256: "ff".repeat(32) };
    if (mode === "destination") value.disclosure = { ...value.disclosure, destination: "model" } as never;
    if (mode === "extra") Object.assign(value, { completed: true });
    expect(() => receipt(value)).toThrow();
  });
});
