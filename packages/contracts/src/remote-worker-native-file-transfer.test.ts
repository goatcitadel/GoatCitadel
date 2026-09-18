import { describe, expect, it, vi } from "vitest";
import { nativeArtifactFixture } from "./remote-worker-native-artifact-test-fixture.js";
import { remoteWorkerNativeFileReceiptSha256 } from "./remote-worker-native-file-receipt.js";
import { normalizeRemoteWorkerNativeFileTransferPage, nativeFileTransferPageForDeclaration, nativeFileTransferExpectedPages,
  REMOTE_WORKER_NATIVE_FILE_PAGE_BYTES, type RemoteWorkerNativeFileTransferPage } from "./remote-worker-native-file-transfer.js";
function fixture(bytes = 0) {
  const declaration = nativeArtifactFixture("x".repeat(bytes)).receipt;
  const page = (pageIndex = 0): RemoteWorkerNativeFileTransferPage => ({ kind: "runtime.files.page", nonce: declaration.disclosure.nonce,
    requestSha256: declaration.disclosure.requestSha256, transferSha256: remoteWorkerNativeFileReceiptSha256(declaration), fileIndex: 0, pageIndex,
    bytesHex: "00".repeat(Math.min(32768, bytes + 200 - pageIndex * 32768)) });
  return { declaration, page };
}
describe("bounded native file transfer pages", () => {
  it.each([0, 32768 - 200, 32768, 1048576])("accepts every exact page for a %i-byte file, including its native header", bytes => {
    const f = fixture(bytes), expected = Math.ceil((bytes + 200) / REMOTE_WORKER_NATIVE_FILE_PAGE_BYTES);
    expect(nativeFileTransferExpectedPages(f.declaration)).toBe(expected);
    let total = 0;
    for (let index = 0; index < expected; index++) {
      const page = nativeFileTransferPageForDeclaration(f.page(index), f.declaration); expect(Object.isFrozen(page)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024); total += page.bytesHex.length / 2;
    }
    expect(total).toBe(bytes + 200);
  });
  it.each([{ fileIndex: 64 }, { pageIndex: 33 }, { pageIndex: -1 }, { fileIndex: "0" }, { nonce: "0".repeat(64) },
    { bytesHex: "AA" }, { bytesHex: "a" }, { bytesHex: "" }, { bytesHex: "00".repeat(32769) }, { approved: true }])("rejects malformed page %j", patch => {
    expect(() => normalizeRemoteWorkerNativeFileTransferPage({ ...fixture().page(), ...patch })).toThrow();
  });
  it.each(["nonce", "request", "declaration", "file", "offset", "short", "long"])("rejects %s disagreement with the declaration", mode => {
    const f = fixture(), page = f.page();
    if (mode === "nonce") Object.assign(page, { nonce: "ff".repeat(32) });
    if (mode === "request") Object.assign(page, { requestSha256: "ff".repeat(32) });
    if (mode === "declaration") Object.assign(page, { transferSha256: "ff".repeat(32) });
    if (mode === "file") Object.assign(page, { fileIndex: 1 });
    if (mode === "offset") Object.assign(page, { pageIndex: 1 });
    if (mode === "short") Object.assign(page, { bytesHex: page.bytesHex.slice(0, -2) });
    if (mode === "long") Object.assign(page, { bytesHex: page.bytesHex + "00" });
    expect(() => nativeFileTransferPageForDeclaration(page, f.declaration)).toThrow();
  });
  it("does not invoke a content getter", () => {
    const page = fixture().page(), getter = vi.fn(() => "aa"); Object.defineProperty(page, "bytesHex", { enumerable: true, get: getter });
    expect(() => normalizeRemoteWorkerNativeFileTransferPage(page)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});
