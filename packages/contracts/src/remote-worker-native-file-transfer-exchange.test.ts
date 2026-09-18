import { describe, expect, it, vi } from "vitest";
import { nativeArtifactFixture } from "./remote-worker-native-artifact-test-fixture.js";
import { normalizeRemoteWorkerNativeFileTransferBegin, normalizeRemoteWorkerNativeFileTransferExchange } from "./remote-worker-native-file-transfer-exchange.js";
const exchange = () => ({ schemaVersion: "goatcitadel.native-file-transfer-exchange.v1", registryWorkspaceId: "default", assignmentId: "native",
  assignmentGeneration: 1, leaseRevision: 1, nonce: "11".repeat(32), requestSha256: "22".repeat(32), transferSha256: "33".repeat(32), acceptedPage: null });
describe("native file transfer wire boundaries", () => {
  it("normalizes and freezes declarations and metadata-only acknowledgements", () => {
    expect(Object.isFrozen(normalizeRemoteWorkerNativeFileTransferBegin({ kind: "runtime.files.begin", declaration: nativeArtifactFixture().receipt }))).toBe(true);
    expect(Object.isFrozen(normalizeRemoteWorkerNativeFileTransferExchange(exchange()))).toBe(true);
    const page = normalizeRemoteWorkerNativeFileTransferExchange({ ...exchange(), acceptedPage: { fileIndex: 63, pageIndex: 32, pageSha256: "44".repeat(32) } });
    expect(Object.isFrozen(page.acceptedPage)).toBe(true);
  });
  it.each([{ completed: true }, { bytesHex: "ff" }, { leaseRevision: 0 }, { assignmentGeneration: -1 }, { nonce: "00".repeat(32) },
    { acceptedPage: { fileIndex: 64, pageIndex: 0, pageSha256: "44".repeat(32) } },
    { acceptedPage: { fileIndex: 0, pageIndex: 33, pageSha256: "44".repeat(32) } }])("rejects malformed acknowledgement %j", patch => {
    expect(() => normalizeRemoteWorkerNativeFileTransferExchange({ ...exchange(), ...patch })).toThrow();
  });
  it("rejects getters without evaluating them and rejects extra approval claims", () => {
    const getter = vi.fn(() => "11".repeat(32)), value = exchange(); Object.defineProperty(value, "nonce", { get: getter });
    expect(() => normalizeRemoteWorkerNativeFileTransferExchange(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => normalizeRemoteWorkerNativeFileTransferBegin({ kind: "runtime.files.begin", declaration: nativeArtifactFixture().receipt, approved: true })).toThrow();
  });
});
