import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerNativeFileExportSelection, readRemoteWorkerNativeFileContent, normalizeRemoteWorkerNativeFileDisclosure,
  REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA, remoteWorkerNativeFileStagingSha256 } from "@goatcitadel/contracts";
import { createRemoteWorkerExecutionOwners, type RemoteWorkerExecutionOwnersDependencies } from "./remote-worker-execution-owners.js";

function fixture() {
  const selection = normalizeRemoteWorkerNativeFileExportSelection({ schemaVersion: "goatcitadel.remote-worker-native-file-export.v1",
    registryWorkspaceId: "default", assignmentId: "native-files", assignmentGeneration: 1, nonce: "11".repeat(32),
    requestSha256: "22".repeat(32), resultSha256: "33".repeat(32), workDirectoryIdentityHex: "0100000000000000" + "44".repeat(16),
    fileIdentityHex: "0100000000000000" + "55".repeat(16), logicalFileBytes: 1, allocatedBytes: 4096, maximumBytes: 1024, logicalPath: "outputs/native.bin" });
  const bytes = Buffer.alloc(201); bytes.write("GCRFA001"); bytes[200] = 42;
  for (const [offset, value] of [[8, selection.nonce], [40, selection.requestSha256], [72, selection.resultSha256],
    [104, selection.workDirectoryIdentityHex], [128, selection.fileIdentityHex]] as const) Buffer.from(value, "hex").copy(bytes, offset);
  bytes.writeBigUInt64LE(1n, 152); bytes.writeBigUInt64LE(4096n, 160); createHash("sha256").update(bytes.subarray(200)).digest().copy(bytes, 168);
  const recordHex = bytes.toString("hex"), verified = readRemoteWorkerNativeFileContent(recordHex, selection);
  const verifyFileContentForAssignment = vi.fn(async () => verified), llm = {};
  const fileStaging = { paths: [selection.logicalPath], maximumFileBytes: 1024, maximumTotalBytes: 2048 };
  const disclosure = normalizeRemoteWorkerNativeFileDisclosure({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA,
    destination: "gateway_artifacts", registryWorkspaceId: selection.registryWorkspaceId, assignmentId: selection.assignmentId,
    assignmentGeneration: 1, nonce: selection.nonce, requestSha256: selection.requestSha256, executionWorkspaceId: "execution",
    pathJailSha256: "77".repeat(32), fileStagingSha256: remoteWorkerNativeFileStagingSha256(fileStaging) });
  const authorizeFileDisclosureForAssignment = vi.fn(async () => ({ selection, disclosure }));
  const verifyDisclosedFileContentForAssignment = vi.fn(async () => ({ selection, disclosure, content: verified }));
  const owner = createRemoteWorkerExecutionOwners({ storage: { remoteWorkerRuntimeResults: { verifyFileContentForAssignment,
    authorizeFileDisclosureForAssignment, verifyDisclosedFileContentForAssignment } },
    llm, completionHost: { llmService: llm }, artifactRoot: "unused-native-file-validation" } as unknown as RemoteWorkerExecutionOwnersDependencies).nativeFiles;
  const input = { registryWorkspaceId: selection.registryWorkspaceId, assignmentId: selection.assignmentId, assignmentGeneration: 1,
    leaseRevision: 2, leaseTokenSha256: "66".repeat(32), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never, selection, recordHex };
  return { owner, input, verified, verifyFileContentForAssignment, fileStaging, disclosure,
    authorizeFileDisclosureForAssignment, verifyDisclosedFileContentForAssignment };
}
describe("native file validation owner", () => {
  it("requires protected disclosure authority before releasing the reviewed content", async () => {
    const f = fixture(), input = { ...f.input, fileStaging: f.fileStaging };
    expect(await f.owner.authorize(input)).toEqual({ selection: input.selection, disclosure: f.disclosure });
    expect(await f.owner.validateDisclosed(input)).toEqual({ selection: input.selection, disclosure: f.disclosure, content: f.verified });
    expect(f.verifyFileContentForAssignment).not.toHaveBeenCalled();
    expect(f.authorizeFileDisclosureForAssignment).toHaveBeenCalledOnce();
    expect(f.verifyDisclosedFileContentForAssignment).toHaveBeenCalledOnce();
  });
  it.each(["before", "during", "revoked", "plan", "request", "selection", "content", "malformed"])("withholds disclosed content for %s", async mode => {
    const f = fixture(), stop = new AbortController(), input = { ...f.input, fileStaging: f.fileStaging, signal: stop.signal };
    if (mode === "before") stop.abort();
    if (mode === "during") f.verifyDisclosedFileContentForAssignment.mockImplementation(async () => {
      stop.abort(); return { selection: input.selection, disclosure: f.disclosure, content: f.verified };
    });
    if (mode === "revoked") f.verifyDisclosedFileContentForAssignment.mockRejectedValue(new Error("revoked"));
    if (mode === "plan") input.fileStaging.maximumTotalBytes++;
    if (mode === "request") f.verifyDisclosedFileContentForAssignment.mockResolvedValue({ selection: input.selection,
      disclosure: { ...f.disclosure, requestSha256: "99".repeat(32) }, content: f.verified });
    if (mode === "selection") f.verifyDisclosedFileContentForAssignment.mockResolvedValue({ selection: { ...input.selection, logicalPath: "other.txt" },
      disclosure: f.disclosure, content: f.verified });
    if (mode === "content") f.verifyDisclosedFileContentForAssignment.mockResolvedValue({ selection: input.selection,
      disclosure: f.disclosure, content: { ...f.verified, contentHex: "00" } });
    if (mode === "malformed") input.recordHex += "00";
    await expect(f.owner.validateDisclosed(input)).rejects.toThrow();
    expect(f.verifyDisclosedFileContentForAssignment).toHaveBeenCalledTimes(["before", "malformed"].includes(mode) ? 0 : 1);
  });
  it.each(["revoked", "cancelled", "substituted"])("refuses file-transfer authorization when %s", async mode => {
    const f = fixture(), stop = new AbortController();
    if (mode === "revoked") f.authorizeFileDisclosureForAssignment.mockRejectedValue(new Error("revoked"));
    if (mode === "cancelled") f.authorizeFileDisclosureForAssignment.mockImplementation(async () => {
      stop.abort(); return { selection: f.input.selection, disclosure: f.disclosure };
    });
    if (mode === "substituted") f.authorizeFileDisclosureForAssignment.mockResolvedValue({ selection: f.input.selection,
      disclosure: { ...f.disclosure, nonce: "88".repeat(32) } });
    await expect(f.owner.authorize({ ...f.input, fileStaging: f.fileStaging, signal: stop.signal })).rejects.toThrow();
    expect(f.authorizeFileDisclosureForAssignment).toHaveBeenCalledOnce();
    expect(f.verifyFileContentForAssignment).not.toHaveBeenCalled();
  });
  it("uses the production factory and exact protected storage validation before releasing content", async () => {
    const f = fixture(); expect(await f.owner.validate(f.input, 1024)).toEqual(f.verified);
    expect(f.verifyFileContentForAssignment).toHaveBeenCalledExactlyOnceWith(f.input, 1024);
  });
  it.each(["before", "during", "revoked", "changed", "malformed"])("withholds output for %s without retry", async mode => {
    const f = fixture(), stop = new AbortController();
    if (mode === "before") stop.abort();
    if (mode === "during") f.verifyFileContentForAssignment.mockImplementation(async () => { stop.abort(); return f.verified; });
    if (mode === "revoked") f.verifyFileContentForAssignment.mockRejectedValue(new Error("revoked"));
    if (mode === "changed") f.verifyFileContentForAssignment.mockResolvedValue({ ...f.verified, contentHex: "00" });
    if (mode === "malformed") f.input.recordHex += "00";
    await expect(f.owner.validate({ ...f.input, signal: stop.signal }, 1024)).rejects.toThrow();
    expect(f.verifyFileContentForAssignment).toHaveBeenCalledTimes(["before", "malformed"].includes(mode) ? 0 : 1);
  });
});
