import { describe, expect, it } from "vitest";
import { runtimeResultPagesFixture } from "./remote-worker-runtime-result-pages-test-fixture.js";
import { readRemoteWorkerRuntimeResult } from "./remote-worker-runtime-result.js";
import { createRemoteWorkerNativeFileExportSelection, normalizeRemoteWorkerNativeFileExportSelection,
  remoteWorkerNativeFileExportSelectionSha256 } from "./remote-worker-native-file-export.js";

function fixture() {
  const f = runtimeResultPagesFixture(2), bytes = Buffer.from(f.bytes);
  bytes.writeBigUInt64LE(5n, 256 + 328);
  // Four recorded roots precede the first controlled file in this wire fixture.
  bytes.writeBigUInt64LE(5n, 608 + 40 + 4 * 48 + 32);
  const resultHex = bytes.toString("hex"), result = readRemoteWorkerRuntimeResult(resultHex, f.expectation, f.history);
  const file = result.inventory!.entries.find(entry => !entry.directory && entry.logicalFileBytes === 5)!;
  const request = { fileIdentityHex: file.identityHex, logicalPath: "outputs/result.txt" };
  const create = (selected: unknown = request, maximum = 1024, hex: unknown = resultHex) =>
    createRemoteWorkerNativeFileExportSelection(selected, f.expectation, hex, f.history, maximum);
  return { ...f, resultHex, result, file, request, create };
}
describe("native file export selection", () => {
  it("derives scope, work directory and accounting from independently decoded execution evidence", () => {
    const f = fixture(), selection = f.create();
    expect(selection).toMatchObject({ registryWorkspaceId: f.history.registryWorkspaceId, assignmentId: f.history.assignmentId,
      assignmentGeneration: f.history.assignmentGeneration, nonce: f.expectation.nonce, requestSha256: f.expectation.requestSha256,
      resultSha256: f.result.resultSha256, logicalFileBytes: 5, allocatedBytes: 4096, maximumBytes: 1024,
      workDirectoryIdentityHex: f.result.inventory!.directoryIdentityHex[3], ...f.request });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(remoteWorkerNativeFileExportSelectionSha256(selection)).not.toBe(remoteWorkerNativeFileExportSelectionSha256({ ...selection, logicalPath: "outputs/other.txt" }));
    expect(remoteWorkerNativeFileExportSelectionSha256(selection)).not.toBe(remoteWorkerNativeFileExportSelectionSha256({ ...selection, assignmentGeneration: 2 }));
  });
  it("rejects unknown files, directory exports, extra worker-selected roots and unsafe labels", () => {
    const f = fixture();
    for (const patch of [{ fileIdentityHex: "ab".repeat(24) }, { fileIdentityHex: f.result.inventory!.directoryIdentityHex[0] },
      { workDirectoryIdentityHex: f.result.inventory!.directoryIdentityHex[0] }, { logicalPath: "../private.txt" },
      { logicalPath: "C:\\private.txt" }, { logicalPath: "result.txt:secret" }]) expect(() => f.create({ ...f.request, ...patch })).toThrow();
  });
  it.each([0, 4, 1048577, Number.NaN])("rejects an invalid or insufficient independent ceiling %s", maximum => {
    expect(() => fixture().create(undefined, maximum)).toThrow();
  });
  it("refuses changed results and expectations without accepting a caller-supplied digest", () => {
    const f = fixture(), bytes = Buffer.from(f.resultHex, "hex");
    bytes[8] = bytes[8]! ^ 1;
    expect(() => f.create(undefined, 1024, bytes.toString("hex"))).toThrow();
    expect(() => createRemoteWorkerNativeFileExportSelection(f.request, { ...f.expectation, requestSha256: "ab".repeat(32) }, f.resultHex, f.history, 1024)).toThrow();
  });
  it("keeps empty retained files distinct from absent inventory", () => {
    const f = fixture(), empty = f.result.inventory!.entries.find(entry => !entry.directory && entry.logicalFileBytes === 0)!;
    expect(f.create({ ...f.request, fileIdentityHex: empty.identityHex }).logicalFileBytes).toBe(0);
    const bytes = Buffer.from(f.resultHex, "hex");
    bytes.writeUInt32LE(bytes.readUInt32LE(104) & ~(1 << 5), 104);
    expect(() => f.create(undefined, 1024, bytes.toString("hex"))).toThrow();
  });
  it("rejects accessor fields without invoking them and refuses foreign volumes", () => {
    const f = fixture(), request = { ...f.request }; let called = false;
    Object.defineProperty(request, "logicalPath", { enumerable: true, get() { called = true; throw new Error("getter"); } });
    expect(() => f.create(request)).toThrow(); expect(called).toBe(false);
    const selection = f.create();
    expect(() => normalizeRemoteWorkerNativeFileExportSelection({ ...selection, fileIdentityHex: "ab".repeat(8) + selection.fileIdentityHex.slice(16) })).toThrow();
    expect(() => normalizeRemoteWorkerNativeFileExportSelection({ ...selection, fileIdentityHex: selection.workDirectoryIdentityHex })).toThrow();
  });
});
