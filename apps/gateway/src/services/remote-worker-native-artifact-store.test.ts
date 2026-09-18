import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerNativeFileExportSelection, normalizeRemoteWorkerNativeFileDisclosure, readRemoteWorkerNativeFileContent,
  normalizeRemoteWorkerNativeFileReceipt, remoteWorkerNativeFileReceiptSha256, remoteWorkerNativeFileStagingSha256,
  REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA, REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA } from "@goatcitadel/contracts";
import type { RemoteWorkerNativeFileReceiptRecord } from "@goatcitadel/storage";
import { createRemoteWorkerExecutionOwners, type RemoteWorkerExecutionOwnersDependencies } from "./remote-worker-execution-owners.js";
import { RemoteWorkerArtifactStore } from "./remote-worker-artifact-store.js";

const roots: string[] = [], hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("gc-native-cas-")) throw new Error("Unexpected owned test root");
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-native-cas-")); roots.push(root);
  const signal = new AbortController(), content = [Buffer.from("first"), Buffer.from("second")];
  const fileStaging = { paths: ["out/one.txt", "out/two.txt"], maximumFileBytes: 1024, maximumTotalBytes: 2048 };
  const authority = { registryWorkspaceId: "default", assignmentId: "native-cas", assignmentGeneration: 1, leaseRevision: 2,
    leaseTokenSha256: "66".repeat(32), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never };
  const files = content.map((bytes, index) => {
    const selection = normalizeRemoteWorkerNativeFileExportSelection({ schemaVersion: "goatcitadel.remote-worker-native-file-export.v1",
      registryWorkspaceId: authority.registryWorkspaceId, assignmentId: authority.assignmentId, assignmentGeneration: authority.assignmentGeneration,
      nonce: "11".repeat(32), requestSha256: "22".repeat(32), resultSha256: "33".repeat(32),
      workDirectoryIdentityHex: "0100000000000000" + "44".repeat(16), fileIdentityHex: "0100000000000000" + (55 + index).toString(16).repeat(16),
      logicalFileBytes: bytes.length, allocatedBytes: 4096, maximumBytes: 1024, logicalPath: fileStaging.paths[index] });
    const record = Buffer.alloc(200 + bytes.length); record.write("GCRFA001"); bytes.copy(record, 200);
    for (const [offset, value] of [[8, selection.nonce], [40, selection.requestSha256], [72, selection.resultSha256],
      [104, selection.workDirectoryIdentityHex], [128, selection.fileIdentityHex]] as const) Buffer.from(value, "hex").copy(record, offset);
    record.writeBigUInt64LE(BigInt(bytes.length), 152); record.writeBigUInt64LE(4096n, 160); Buffer.from(hash(bytes), "hex").copy(record, 168);
    return { selection, recordHex: record.toString("hex") };
  });
  const disclosure = normalizeRemoteWorkerNativeFileDisclosure({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA,
    destination: "gateway_artifacts", registryWorkspaceId: "default", assignmentId: "native-cas", assignmentGeneration: 1,
    nonce: "11".repeat(32), requestSha256: "22".repeat(32), executionWorkspaceId: "execution", pathJailSha256: "77".repeat(32),
    fileStagingSha256: remoteWorkerNativeFileStagingSha256(fileStaging) });
  const receipt = normalizeRemoteWorkerNativeFileReceipt({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA,
    disclosure, fileStaging, resultSha256: "33".repeat(32), totalBytes: content.reduce((sum, b) => sum + b.length, 0),
    files: files.map(file => { const parsed = readRemoteWorkerNativeFileContent(file.recordHex, file.selection);
      return { selection: file.selection, recordSha256: parsed.recordSha256, contentSha256: parsed.contentSha256 }; }) });
  const state: { revoked: boolean; capability: boolean; maximumBytes: number; retained: RemoteWorkerNativeFileReceiptRecord | null } =
    { revoked: false, capability: true, maximumBytes: 1024, retained: null };
  const live = () => { if (state.revoked) throw new Error("revoked"); };
  const cas = new RemoteWorkerArtifactStore(root);
  const retainForAssignment = vi.fn(async () => {
    live();
    // Ordering proof: a receipt is not submitted until every real CAS blob exists.
    for (const bytes of content) expect(await cas.readBlob({ executionWorkspaceId: "execution", blobSha256: hash(bytes), signal: signal.signal })).toEqual(new Uint8Array(bytes));
    return state.retained = Object.freeze({ receipt, receiptSha256: remoteWorkerNativeFileReceiptSha256(receipt), leaseRevision: 2, recordedAt: new Date().toISOString() });
  });
  const findForAssignment = vi.fn(async () => { live(); return state.retained; });
  const storage = { remoteWorkerNativeFileReceipts: { retainForAssignment, findForAssignment }, remoteWorkerRuntimeResults: {
    authorizeFileDisclosureForAssignment: vi.fn(async ({ selection }: typeof files[number]) => { live(); return { selection, disclosure }; }),
    verifyDisclosedFileContentForAssignment: vi.fn(async (file: typeof files[number]) => { live(); return { selection: file.selection, disclosure,
      content: readRemoteWorkerNativeFileContent(file.recordHex, file.selection) }; }) },
  remoteWorkerAssignments: { resolveActiveAuthorityByLeaseTokenHash: vi.fn(async () => state.revoked ? null : ({
    assignment: { ...authority, manifest: { executionWorkspaceId: "execution", pathJailSha256: disclosure.pathJailSha256, maxArtifactBytes: state.maximumBytes,
      requiredCapabilityClasses: state.capability ? ["artifact_stage"] : [] } }, generation: { assignmentGeneration: 1 }, lease: { leaseRevision: 2 } })) } };
  const llm = {}, makeOwner = () => createRemoteWorkerExecutionOwners({ storage, llm, completionHost: { llmService: llm },
    artifactRoot: root } as unknown as RemoteWorkerExecutionOwnersDependencies).nativeArtifacts;
  return { root, cas, signal, content, files, receipt, state, storage, retainForAssignment, findForAssignment, makeOwner, owner: makeOwner(),
    input: { ...authority, files, fileStaging, signal: signal.signal }, lookup: { ...authority, nonce: disclosure.nonce, requestSha256: disclosure.requestSha256, signal: signal.signal } };
}

describe("native receipt-backed artifact storage", () => {
  it("retains the selected execution identity while receipt lookup is pending", async () => {
    const f = await fixture();
    await f.owner.stage(f.input);
    f.findForAssignment.mockImplementationOnce(async () => {
      await Promise.resolve();
      f.lookup.nonce = "aa".repeat(32);
      f.lookup.requestSha256 = "bb".repeat(32);
      return f.state.retained;
    });
    await expect(f.owner.authorizeReceipt(f.lookup)).resolves.toMatchObject({ retained: { receipt: f.receipt } });
  });
  it("checks disclosure and artifact capability without reading or installing file content", async () => {
    const f = await fixture(), result = await f.owner.authorizeFile({ ...f.lookup, selection: f.files[0]!.selection, fileStaging: f.input.fileStaging });
    expect(result).toEqual({ selection: f.files[0]!.selection, disclosure: f.receipt.disclosure });
    expect(f.retainForAssignment).not.toHaveBeenCalled(); expect(f.findForAssignment).not.toHaveBeenCalled();
    expect(await fs.readdir(f.root)).toEqual([]);
  });
  it("rechecks capability after disclosure resolution before returning permission", async () => {
    const f = await fixture();
    f.storage.remoteWorkerRuntimeResults.authorizeFileDisclosureForAssignment.mockImplementation(async ({ selection }) => {
      f.state.capability = false; return { selection, disclosure: f.receipt.disclosure };
    });
    await expect(f.owner.authorizeFile({ ...f.lookup, selection: f.files[0]!.selection, fileStaging: f.input.fileStaging })).rejects.toThrow("artifact capability");
    expect(f.retainForAssignment).not.toHaveBeenCalled(); expect(await fs.readdir(f.root)).toEqual([]);
  });
  it.each(["capability", "bytes", "revoked", "cancelled", "workspace"])("withholds per-file permission after %s changes", async mode => {
    const f = await fixture();
    if (mode === "capability") f.state.capability = false;
    if (mode === "bytes") f.state.maximumBytes = 1;
    if (mode === "revoked") f.state.revoked = true;
    if (mode === "cancelled") f.signal.abort();
    const input = { ...f.lookup, selection: f.files[0]!.selection, fileStaging: f.input.fileStaging };
    if (mode === "workspace") input.registryWorkspaceId = "foreign";
    await expect(f.owner.authorizeFile(input)).rejects.toThrow(); expect(f.retainForAssignment).not.toHaveBeenCalled();
    expect(await fs.readdir(f.root)).toEqual([]);
  });
  it("uses production composition and recovers complete real files through a fresh owner", async () => {
    const f = await fixture(), saved = await f.owner.stage(f.input);
    expect(saved.receiptSha256).toBe(remoteWorkerNativeFileReceiptSha256(f.receipt));
    const recovered = await f.makeOwner().recover(f.lookup);
    expect(recovered?.files.map(file => Buffer.from(file.bytes).toString())).toEqual(["first", "second"]);
    expect(f.retainForAssignment).toHaveBeenCalledOnce(); recovered?.files.forEach(file => file.bytes.fill(0));
  });
  it("returns no recovery when no durable receipt exists", async () => {
    const f = await fixture(); expect(await f.owner.recover(f.lookup)).toBeNull(); expect(f.retainForAssignment).not.toHaveBeenCalled();
  });
  it("freezes caller file plans and records before asynchronous validation", async () => {
    const f = await fixture(), pending = f.owner.stage(f.input);
    f.input.fileStaging.paths[0] = "changed.txt"; f.input.files.reverse();
    const saved = await pending; expect(saved.receipt.fileStaging.paths).toEqual(["out/one.txt", "out/two.txt"]);
  });
  it.each(["installation", "revocation"])("wipes staging buffers and withholds a receipt after %s failure", async mode => {
    const f = await fixture(), captured: Uint8Array[] = [], install = RemoteWorkerArtifactStore.prototype.installBlob;
    vi.spyOn(RemoteWorkerArtifactStore.prototype, "installBlob").mockImplementation(async function(input) {
      captured.push(input.bytes);
      if (mode === "installation") throw new Error("disk failure");
      const result = await install.call(this, input); f.state.revoked = true; return result;
    });
    await expect(f.owner.stage(f.input)).rejects.toThrow(); expect(f.retainForAssignment).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1); expect(captured[0]!.every(byte => byte === 0)).toBe(true);
  });
  it.each(["capability", "ceiling", "revoked", "cancelled", "partial", "malformed", "order"])("refuses staging before file I/O for %s", async mode => {
    const f = await fixture();
    if (mode === "capability") f.state.capability = false;
    if (mode === "ceiling") f.state.maximumBytes = 1;
    if (mode === "revoked") f.state.revoked = true;
    if (mode === "cancelled") f.signal.abort();
    if (mode === "partial") f.input.files.pop();
    if (mode === "malformed") f.input.files[1]!.recordHex += "00";
    if (mode === "order") f.input.files.reverse();
    await expect(f.owner.stage(f.input)).rejects.toThrow(); expect(f.retainForAssignment).not.toHaveBeenCalled(); expect(await fs.readdir(f.root)).toEqual([]);
  });
  it("leaves no false receipt after interruption and converges on retry using existing verified CAS bytes", async () => {
    const f = await fixture(); f.retainForAssignment.mockRejectedValueOnce(new Error("interrupted before receipt"));
    await expect(f.owner.stage(f.input)).rejects.toThrow("interrupted"); expect(await f.makeOwner().recover(f.lookup)).toBeNull();
    await f.owner.stage(f.input); const recovered = await f.makeOwner().recover(f.lookup); expect(recovered?.files).toHaveLength(2);
    recovered?.files.forEach(file => file.bytes.fill(0));
  });
  it.each(["missing", "tampered", "late-revocation", "receipt-change"])("withholds and wipes a partial recovered batch on %s", async mode => {
    const f = await fixture(); await f.owner.stage(f.input);
    const captured: Uint8Array[] = [], read = RemoteWorkerArtifactStore.prototype.readBlob;
    vi.spyOn(RemoteWorkerArtifactStore.prototype, "readBlob").mockImplementation(async function(input) {
      const bytes = await read.call(this, input); captured.push(bytes); return bytes;
    });
    const second = f.cas.resolvePath(f.cas.blobRelPath("execution", hash(f.content[1]!)));
    if (mode === "missing") await fs.unlink(second);
    if (mode === "tampered") await fs.writeFile(second, "damage");
    if (mode === "late-revocation" || mode === "receipt-change") {
      f.findForAssignment.mockImplementationOnce(async () => f.state.retained).mockImplementationOnce(async () => {
        if (mode === "late-revocation") throw new Error("revoked");
        return { ...f.state.retained!, receiptSha256: "99".repeat(32) };
      });
    }
    await expect(f.makeOwner().recover(f.lookup)).rejects.toThrow(); expect(captured.length).toBeGreaterThan(0);
    for (const bytes of captured) expect(bytes.every(byte => byte === 0)).toBe(true);
  });
});
