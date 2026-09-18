import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeArtifactFixture } from "../../../packages/contracts/src/remote-worker-native-artifact-test-fixture.js";
import { remoteWorkerNativeFileReceiptSha256, type RemoteWorkerNativeFileTransferBegin, type RemoteWorkerNativeFileTransferPage } from "@goatcitadel/contracts";
import { transferWorkerNativeFiles } from "./worker-native-file-transfer-client.js";
import { requestWorkerNativeFileGrant } from "./worker-native-file-grant-client.js";
import { reconcileWorkerNativeFiles } from "./worker-native-file-reconciliation-client.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import type { LeaseBinding, RouteContext } from "./connected-worker-routes.js";
vi.mock("./worker-native-file-grant-client.js", () => ({ requestWorkerNativeFileGrant: vi.fn() }));
vi.mock("./worker-native-file-reconciliation-client.js", () => ({ reconcileWorkerNativeFiles: vi.fn() }));
vi.mock("./worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(text = "x".repeat(65536)) {
  const f = nativeArtifactFixture(text), selection = { ...f.receipt.files[0]!.selection }, raw = Buffer.alloc(200 + f.bytes.length), stop = new AbortController();
  raw.write("GCRFA001"); f.bytes.copy(raw, 200);
  for (const [offset, value] of [[8, selection.nonce], [40, selection.requestSha256], [72, selection.resultSha256],
    [104, selection.workDirectoryIdentityHex], [128, selection.fileIdentityHex]] as const) Buffer.from(value, "hex").copy(raw, offset);
  raw.writeBigUInt64LE(BigInt(f.bytes.length), 152); raw.writeBigUInt64LE(BigInt(selection.allocatedBytes), 160);
  Buffer.from(hash(f.bytes), "hex").copy(raw, 168);
  const declaration = { ...f.receipt, files: [{ ...f.receipt.files[0]!, recordSha256: hash(raw) }] }, transferSha256 = remoteWorkerNativeFileReceiptSha256(declaration);
  let revision = 0;
  const leaseOwner = { withCurrentLease: async <T>(work: (binding: LeaseBinding) => Promise<T>) => work({ registryWorkspaceId: selection.registryWorkspaceId,
    assignmentId: selection.assignmentId, assignmentGeneration: 1, leaseRevision: ++revision, leaseToken: `private-${revision}` }) };
  vi.mocked(requestWorkerNativeFileGrant).mockImplementation(async (_context, lease, selected, fileStaging) => ({ schemaVersion: "goatcitadel.native-file-grant.v1",
    leaseRevision: lease.leaseRevision, submission: { kind: "runtime.file.authorize", selection: selected, fileStaging, challenge: "11".repeat(32) }, disclosure: f.receipt.disclosure }));
  const ack = (input: Parameters<typeof callProtectedRoute>[0]) => {
    const { registryWorkspaceId, assignmentId, assignmentGeneration, leaseRevision } = input.payload;
    const submission = input.payload.submission as RemoteWorkerNativeFileTransferBegin | RemoteWorkerNativeFileTransferPage;
    return { status: 200, body: { schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit",
      disposition: "native_file_transfer", registryWorkspaceId, nativeFileTransfer: { schemaVersion: "goatcitadel.native-file-transfer-exchange.v1",
        registryWorkspaceId, assignmentId, assignmentGeneration, leaseRevision, nonce: selection.nonce, requestSha256: selection.requestSha256, transferSha256,
        acceptedPage: submission.kind === "runtime.files.begin" ? null : { fileIndex: submission.fileIndex, pageIndex: submission.pageIndex,
          pageSha256: hash(Buffer.from(submission.bytesHex, "hex")) } } } };
  };
  vi.mocked(callProtectedRoute).mockImplementation(async input => ack(input));
  const result = { settlement: { receiptSha256: transferSha256 }, lookup: { record: { resultSha256: selection.resultSha256 } } };
  vi.mocked(reconcileWorkerNativeFiles).mockResolvedValue(result as never);
  const context = { credential: {} } as RouteContext, files = [{ selection, record: raw }];
  const run = (before?: () => Promise<void>) => transferWorkerNativeFiles(context, leaseOwner, selection, f.receipt.fileStaging, files, stop.signal, before);
  return { ...f, selection, raw, stop, declaration, files, result, ack, run };
}
beforeEach(() => vi.resetAllMocks());
describe("worker complete native file transfer", () => {
  it.each(["", "x".repeat(65536)])("uploads bounded exact records and requires canonical final settlement", async text => {
    const f = fixture(text); expect(await f.run()).toEqual(f.result);
    const calls = vi.mocked(callProtectedRoute).mock.calls.map(([input]) => input);
    expect(calls[0]!.payload.submission).toEqual({ kind: "runtime.files.begin", declaration: f.declaration });
    const pages = calls.slice(1).map(input => input.payload.submission as RemoteWorkerNativeFileTransferPage);
    expect(Buffer.concat(pages.map(page => Buffer.from(page.bytesHex, "hex")))).toEqual(f.raw);
    expect(pages).toHaveLength(Math.ceil(f.raw.length / 32768));
    calls.forEach((input, index) => { expect(input.payload.leaseRevision).toBe(index + 2); expect(JSON.stringify(input.payload).length).toBeLessThan(131072);
      expect(input.idempotencyKey).not.toContain("private-"); });
    expect(reconcileWorkerNativeFiles).toHaveBeenCalledOnce(); expect(f.raw.subarray(0, 8).toString()).toBe("GCRFA001");
  });
  it("captures immutable bytes before local validation can mutate caller buffers", async () => {
    const f = fixture(), original = Buffer.from(f.raw);
    await f.run(async () => { f.raw.fill(0); f.selection.logicalPath = "replaced.txt"; });
    const pages = vi.mocked(callProtectedRoute).mock.calls.slice(1).map(([input]) => input.payload.submission as RemoteWorkerNativeFileTransferPage);
    expect(Buffer.concat(pages.map(page => Buffer.from(page.bytesHex, "hex")))).toEqual(original);
  });
  it.each(["corrupt", "missing", "path", "nonce", "oversize", "local-deny", "cancel"])("refuses %s before sending bytes", async mode => {
    const f = fixture();
    if (mode === "corrupt") f.raw[200] = f.raw[200]! ^ 1;
    if (mode === "missing") f.files.pop();
    if (mode === "path") f.selection.logicalPath = "foreign.txt";
    if (mode === "nonce") f.selection.nonce = "ff".repeat(32);
    if (mode === "oversize") f.files[0]!.record = Buffer.alloc(f.raw.length + 1);
    if (mode === "cancel") f.stop.abort();
    await expect(f.run(mode === "local-deny" ? async () => { throw new Error("local denied"); } : undefined)).rejects.toThrow();
    expect(callProtectedRoute).not.toHaveBeenCalled(); expect(reconcileWorkerNativeFiles).not.toHaveBeenCalled();
  });
  it.each(["assignmentId", "leaseRevision", "nonce", "transferSha256", "pageHash", "lost", "cancel"])("stops on %s response without resending", async mode => {
    const f = fixture();
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      const response = f.ack(input), ack = response.body.nativeFileTransfer;
      if (mode === "lost") throw new Error("response lost");
      if (mode === "cancel") f.stop.abort();
      if (mode === "assignmentId") ack.assignmentId = "foreign";
      if (mode === "leaseRevision") ack.leaseRevision = 0;
      if (mode === "nonce") ack.nonce = "ff".repeat(32);
      if (mode === "transferSha256") ack.transferSha256 = "ff".repeat(32);
      if (mode === "pageHash" && ack.acceptedPage) ack.acceptedPage.pageSha256 = "ff".repeat(32);
      return response;
    });
    await expect(f.run()).rejects.toThrow(); expect(callProtectedRoute).toHaveBeenCalledTimes(mode === "pageHash" ? 2 : 1);
    expect(reconcileWorkerNativeFiles).not.toHaveBeenCalled();
  });
  it.each(["pending", "receipt", "result"])("does not treat all pages as success when final %s differs", async mode => {
    const f = fixture();
    if (mode === "pending") vi.mocked(reconcileWorkerNativeFiles).mockResolvedValue({ ...f.result, settlement: null } as never);
    if (mode === "receipt") f.result.settlement.receiptSha256 = "ff".repeat(32);
    if (mode === "result") f.result.lookup.record.resultSha256 = "ff".repeat(32);
    await expect(f.run()).rejects.toThrow(); expect(callProtectedRoute).toHaveBeenCalledTimes(4); expect(reconcileWorkerNativeFiles).toHaveBeenCalledOnce();
  });
});
