import { describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerNativeFileReceipt as normalize, remoteWorkerNativeFileReceiptSha256 as digest,
  REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA } from "./remote-worker-native-file-receipt.js";
import { REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA, remoteWorkerNativeFileStagingSha256 } from "./remote-worker-native-file-disclosure.js";

function fixture(count = 2) {
  const fileStaging = { paths: Array.from({ length: count }, (_, i) => `out/${i}.txt`), maximumFileBytes: 1024, maximumTotalBytes: 2048 };
  const disclosure = { schemaVersion: REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA, destination: "gateway_artifacts",
    registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1, nonce: "11".repeat(32), requestSha256: "22".repeat(32),
    executionWorkspaceId: "workspace", pathJailSha256: "33".repeat(32), fileStagingSha256: remoteWorkerNativeFileStagingSha256(fileStaging) };
  const files = fileStaging.paths.map((logicalPath, i) => ({ selection: { schemaVersion: "goatcitadel.remote-worker-native-file-export.v1",
    registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1, nonce: disclosure.nonce,
    requestSha256: disclosure.requestSha256, resultSha256: "44".repeat(32), workDirectoryIdentityHex: "0100000000000000" + "55".repeat(16),
    fileIdentityHex: "0100000000000000" + (i + 6).toString(16).padStart(2, "0").repeat(16), logicalFileBytes: 1024, allocatedBytes: 4096,
    maximumBytes: 1024, logicalPath }, recordSha256: "77".repeat(32), contentSha256: "88".repeat(32) }));
  return { schemaVersion: REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA, disclosure, fileStaging, resultSha256: "44".repeat(32), totalBytes: count * 1024, files };
}
describe("complete native file receipts", () => {
  it("retains immutable metadata and exact content hashes without raw file bytes", () => {
    const input = fixture(), receipt = normalize(input), hash = digest(receipt);
    input.files[0]!.contentSha256 = "99".repeat(32); input.fileStaging.paths[0] = "other.txt";
    expect(receipt.files[0]!.contentSha256).toBe("88".repeat(32)); expect(Object.isFrozen(receipt.files[0]!.selection)).toBe(true);
    expect(Object.isFrozen(receipt.files)).toBe(true); expect(digest(receipt)).toBe(hash);
    expect(JSON.stringify(receipt)).not.toContain("contentHex");
  });
  it.each(["partial", "order", "duplicate", "total", "scope", "plan", "result", "maximum", "hash", "extra", "sparse"])("rejects %s batches", mode => {
    const value = fixture();
    if (mode === "partial") value.files.pop();
    if (mode === "order") value.files.reverse();
    if (mode === "duplicate") value.files[1]!.selection.fileIdentityHex = value.files[0]!.selection.fileIdentityHex;
    if (mode === "total") value.totalBytes++;
    if (mode === "scope") value.files[0]!.selection.assignmentGeneration++;
    if (mode === "plan") value.fileStaging.paths[0] = "other.txt";
    if (mode === "result") value.resultSha256 = "99".repeat(32);
    if (mode === "maximum") value.files[0]!.selection.maximumBytes--;
    if (mode === "hash") value.files[0]!.recordSha256 = "0".repeat(64);
    if (mode === "extra") Object.assign(value.files[0]!, { contentHex: "private" });
    if (mode === "sparse") delete value.files[0];
    expect(() => normalize(value)).toThrow();
  });
  it("rejects an aggregate ceiling violation even when every file fits individually", () => { expect(() => normalize(fixture(3))).toThrow(); });
  it("refuses array accessors without invoking them", () => {
    const value = fixture(), get = vi.fn(); Object.defineProperty(value.files, 0, { get, enumerable: true });
    expect(() => normalize(value)).toThrow(); expect(get).not.toHaveBeenCalled();
  });
});
