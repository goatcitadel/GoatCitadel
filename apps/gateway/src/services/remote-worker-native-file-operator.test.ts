import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeArtifactFixture } from "../../../../packages/contracts/src/remote-worker-native-artifact-test-fixture.js";
import { createRemoteWorkerNativeArtifactManifest, remoteWorkerNativeFileReceiptSha256 } from "@goatcitadel/contracts";
import { RemoteWorkerArtifactStore } from "./remote-worker-artifact-store.js";
import { RemoteWorkerNativeFileOperator } from "./remote-worker-native-file-operator.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const f = nativeArtifactFixture("<script>untrusted bytes</script>"), stop = new AbortController();
  const root = await mkdtemp(join(tmpdir(), "gc-native-file-download-")); roots.push(root);
  const cas = new RemoteWorkerArtifactStore(root), manifest = createRemoteWorkerNativeArtifactManifest({ receipt: f.receipt, identity: f.identity });
  const record = { receipt: f.receipt, receiptSha256: remoteWorkerNativeFileReceiptSha256(f.receipt), manifest, leaseRevision: 1, recordedAt: "2026-09-16T00:00:00.000Z" };
  const readVerifiedForOperator = vi.fn(async () => record as typeof record | null);
  await cas.installBlob({ executionWorkspaceId: "execution", blobSha256: f.receipt.files[0]!.contentSha256, bytes: f.bytes, signal: stop.signal });
  const key = { registryWorkspaceId: "default", assignmentId: f.identity.assignmentId, assignmentGeneration: 1, nonce: f.receipt.disclosure.nonce };
  return { ...f, stop, record, readVerifiedForOperator, cas, key, owner: new RemoteWorkerNativeFileOperator({ readVerifiedForOperator }, cas) };
}
describe("operator native file access", () => {
  it("lists verified metadata and downloads actual CAS bytes with a fixed inert filename", async () => {
    const f = await fixture(), list = await f.owner.list(f.key, f.stop.signal), result = await f.owner.download({ ...f.key, fileIndex: 0 }, f.stop.signal);
    expect(list.files).toEqual([{ fileIndex: 0, logicalPath: "out/report.txt", byteCount: f.bytes.length, sha256: f.receipt.files[0]!.contentSha256 }]);
    expect(result.content).toEqual(f.bytes); expect(result.contentType).toBe("application/octet-stream");
    expect(result.fileName).toMatch(/^native-[0-9a-f]{16}-0\.bin$/u); expect(result.fileName).not.toContain("report");
    expect(JSON.stringify(list)).not.toContain("recordSha256"); expect(f.readVerifiedForOperator).toHaveBeenCalledTimes(3);
  });
  it.each(["missing", "scope", "nonce", "receipt", "manifest", "index", "cancel"])("refuses %s without returning content", async mode => {
    const f = await fixture(); const read = vi.spyOn(f.cas, "readBlob");
    if (mode === "missing") f.readVerifiedForOperator.mockResolvedValue(null);
    if (mode === "scope") f.key.assignmentId = "foreign";
    if (mode === "nonce") f.key.nonce = "ff".repeat(32);
    if (mode === "receipt") f.record.receiptSha256 = "ff".repeat(32);
    if (mode === "manifest") f.record.manifest = createRemoteWorkerNativeArtifactManifest({ receipt: nativeArtifactFixture("changed").receipt, identity: f.identity });
    if (mode === "cancel") f.stop.abort();
    await expect(f.owner.download({ ...f.key, fileIndex: mode === "index" ? 1 : 0 }, f.stop.signal)).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });
  it.each(["hash", "length", "changed-receipt", "cancel"])("wipes temporary bytes on %s during download", async mode => {
    const f = await fixture(), bytes = Buffer.from(mode === "length" ? "short" : f.bytes);
    if (mode === "hash") bytes[0] = bytes[0]! ^ 1;
    vi.spyOn(f.cas, "readBlob").mockImplementation(async () => {
      if (mode === "cancel") f.stop.abort();
      if (mode === "changed-receipt") f.readVerifiedForOperator.mockResolvedValue(null);
      return bytes;
    });
    await expect(f.owner.download({ ...f.key, fileIndex: 0 }, f.stop.signal)).rejects.toThrow(); expect(bytes.every(byte => byte === 0)).toBe(true);
  });
});
