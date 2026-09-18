import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerNativeFileReceipt, remoteWorkerNativeFileReceiptSha256, readRemoteWorkerNativeFileContent,
  type RemoteWorkerNativeFileTransferPage } from "@goatcitadel/contracts";
import type { RemoteWorkerNativeFileReceiptRecord, RemoteWorkerNativeFileTransferPageRecord } from "@goatcitadel/storage";
import { nativeArtifactFixture } from "../../../../packages/contracts/src/remote-worker-native-artifact-test-fixture.js";
import { RemoteWorkerNativeFileTransferService } from "./remote-worker-native-file-transfer.js";
import type { RemoteWorkerNativeArtifactStore } from "./remote-worker-native-artifact-store.js";
import type { RemoteWorkerNativeArtifactSettlement } from "./remote-worker-native-artifact-settlement.js";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(text = "native file") {
  const f = nativeArtifactFixture(text), selection = f.receipt.files[0]!.selection, raw = Buffer.alloc(200 + f.bytes.length), stop = new AbortController();
  raw.write("GCRFA001"); f.bytes.copy(raw, 200);
  for (const [offset, value] of [[8, selection.nonce], [40, selection.requestSha256], [72, selection.resultSha256],
    [104, selection.workDirectoryIdentityHex], [128, selection.fileIdentityHex]] as const) Buffer.from(value, "hex").copy(raw, offset);
  raw.writeBigUInt64LE(BigInt(f.bytes.length), 152); raw.writeBigUInt64LE(BigInt(selection.allocatedBytes), 160);
  Buffer.from(hash(f.bytes), "hex").copy(raw, 168);
  const declaration = normalizeRemoteWorkerNativeFileReceipt({ ...f.receipt, files: [{ ...f.receipt.files[0]!, recordSha256: hash(raw) }] });
  const transfer = { declaration, transferSha256: remoteWorkerNativeFileReceiptSha256(declaration), leaseRevision: 1, recordedAt: "2026-09-16T00:00:00.000Z" };
  let retained: RemoteWorkerNativeFileReceiptRecord | null = null;
  const state = { transfer, pages: [] as RemoteWorkerNativeFileTransferPageRecord[] };
  const beginForAssignment = vi.fn(async () => transfer), readForAssignment = vi.fn(async () => state);
  const appendPageForAssignment = vi.fn(async ({ page }: { page: RemoteWorkerNativeFileTransferPage }) => {
    const row = { fileIndex: page.fileIndex, pageIndex: page.pageIndex, bytesHex: page.bytesHex, pageSha256: hash(Buffer.from(page.bytesHex, "hex")),
      leaseRevision: 1, recordedAt: transfer.recordedAt };
    state.pages.push(row); return { fileIndex: row.fileIndex, pageIndex: row.pageIndex, pageSha256: row.pageSha256, leaseRevision: 1, recordedAt: transfer.recordedAt };
  });
  const releasePagesForAssignment = vi.fn(async () => { expect(retained).not.toBeNull(); const count = state.pages.length; state.pages = []; return count; });
  const findForAssignment = vi.fn(async () => retained);
  const stage = vi.fn(async (input: Parameters<RemoteWorkerNativeArtifactStore["stage"]>[0]) => {
    const file = input.files[0]!; expect(input.files).toHaveLength(1); expect(file.recordHex).toBe(raw.toString("hex"));
    expect(readRemoteWorkerNativeFileContent(file.recordHex, file.selection).contentHex).toBe(f.bytes.toString("hex"));
    return retained = { receipt: declaration, receiptSha256: transfer.transferSha256, leaseRevision: 1, recordedAt: transfer.recordedAt };
  });
  const settled = { receiptSha256: transfer.transferSha256, manifestSha256: "cc".repeat(32), uploadId: "native-upload" };
  const settle = vi.fn(async () => settled);
  const storage = { remoteWorkerNativeFileTransfers: { beginForAssignment, appendPageForAssignment, readForAssignment, releasePagesForAssignment }, remoteWorkerNativeFileReceipts: { findForAssignment } };
  const makeOwner = () => new RemoteWorkerNativeFileTransferService(storage, { stage }, { settle } as unknown as RemoteWorkerNativeArtifactSettlement);
  const input = { registryWorkspaceId: selection.registryWorkspaceId, assignmentId: selection.assignmentId, assignmentGeneration: 1, leaseRevision: 1,
    leaseTokenSha256: "99".repeat(32), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never,
    nonce: selection.nonce, requestSha256: selection.requestSha256, signal: stop.signal };
  const fill = async () => {
    const owner = makeOwner(); await owner.begin({ ...input, declaration });
    for (let offset = 0, pageIndex = 0; offset < raw.length; offset += 32768, pageIndex++) await owner.append({ ...input,
      page: { kind: "runtime.files.page", nonce: input.nonce, requestSha256: input.requestSha256, transferSha256: transfer.transferSha256,
        fileIndex: 0, pageIndex, bytesHex: raw.subarray(offset, offset + 32768).toString("hex") } });
  };
  return { input, declaration, stop, state, settled, stage, settle, findForAssignment, readForAssignment, releasePagesForAssignment, appendPageForAssignment, makeOwner, fill };
}
describe("native page transfer completion", () => {
  it.each(["", "x".repeat(65536)])("assembles an exact empty or multi-page native record before settlement and cleanup", async text => {
    const f = fixture(text); await f.fill(); const count = f.state.pages.length;
    expect(await f.makeOwner().complete(f.input)).toEqual(f.settled);
    expect(f.stage).toHaveBeenCalledOnce(); expect(f.settle).toHaveBeenCalledOnce(); expect(f.releasePagesForAssignment).toHaveBeenCalledOnce();
    expect(count).toBe(Math.ceil((Buffer.byteLength(text) + 200) / 32768));
    expect(await f.makeOwner().complete(f.input)).toEqual(f.settled); expect(f.stage).toHaveBeenCalledOnce();
  });
  it("leaves partial data pending without publication or cleanup", async () => {
    const f = fixture("x".repeat(65536)); await f.fill(); f.state.pages.pop();
    expect(await f.makeOwner().complete(f.input)).toBeNull(); expect(f.stage).not.toHaveBeenCalled(); expect(f.settle).not.toHaveBeenCalled();
    expect(f.releasePagesForAssignment).not.toHaveBeenCalled();
  });
  it.each(["order", "extra", "page-hash", "record-hash", "receipt", "settlement", "cancelled", "revoked"])("refuses %s without premature raw-page cleanup", async mode => {
    const f = fixture("x".repeat(65536)); await f.fill();
    if (mode === "order") f.state.pages.reverse();
    if (mode === "extra") f.state.pages.push(f.state.pages[0]!);
    if (mode === "page-hash") f.state.pages[0] = { ...f.state.pages[0]!, pageSha256: "ff".repeat(32) };
    if (mode === "record-hash") { const row = f.state.pages[0]!, bytesHex = "ff" + row.bytesHex.slice(2); f.state.pages[0] = { ...row, bytesHex, pageSha256: hash(Buffer.from(bytesHex, "hex")) }; }
    if (mode === "receipt") f.findForAssignment.mockResolvedValue({ receipt: f.declaration, receiptSha256: "ff".repeat(32), leaseRevision: 1, recordedAt: f.state.transfer.recordedAt });
    if (mode === "settlement") f.settle.mockResolvedValue({ ...f.settled, receiptSha256: "ff".repeat(32) });
    if (mode === "cancelled") f.stop.abort();
    if (mode === "revoked") f.readForAssignment.mockRejectedValue(new Error("revoked"));
    await expect(f.makeOwner().complete(f.input)).rejects.toThrow(); expect(f.releasePagesForAssignment).not.toHaveBeenCalled();
    if (mode !== "settlement") expect(f.stage).not.toHaveBeenCalled();
  });
  it.each(["stage", "settlement", "cleanup"])("recovers after an interrupted %s through a fresh owner without resubmitting bytes", async mode => {
    const f = fixture(); await f.fill();
    if (mode === "stage") f.stage.mockRejectedValueOnce(new Error("stage interrupted"));
    if (mode === "settlement") f.settle.mockRejectedValueOnce(new Error("settlement interrupted"));
    if (mode === "cleanup") f.releasePagesForAssignment.mockRejectedValueOnce(new Error("cleanup interrupted"));
    await expect(f.makeOwner().complete(f.input)).rejects.toThrow("interrupted"); expect(f.state.pages).toHaveLength(1);
    expect(await f.makeOwner().complete(f.input)).toEqual(f.settled); expect(f.state.pages).toHaveLength(0);
    expect(f.appendPageForAssignment).toHaveBeenCalledOnce(); expect(f.stage).toHaveBeenCalledTimes(mode === "stage" ? 2 : 1);
  });
});
