import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readRemoteWorkerNativeFileContent } from "./remote-worker-native-file-content.js";
import { normalizeRemoteWorkerNativeFileExportSelection } from "./remote-worker-native-file-export.js";

function fixture(length = 5) {
  const selected = normalizeRemoteWorkerNativeFileExportSelection({ schemaVersion: "goatcitadel.remote-worker-native-file-export.v1",
    registryWorkspaceId: "default", assignmentId: "native-content", assignmentGeneration: 1,
    nonce: "11".repeat(32), requestSha256: "22".repeat(32), resultSha256: "33".repeat(32),
    workDirectoryIdentityHex: "0100000000000000" + "44".repeat(16), fileIdentityHex: "0100000000000000" + "55".repeat(16),
    logicalFileBytes: length, allocatedBytes: 4096, maximumBytes: 1048576, logicalPath: "outputs/result.bin" });
  const content = Buffer.alloc(length, 0xab), bytes = Buffer.alloc(200 + length); bytes.write("GCRFA001");
  for (const [offset, value] of [[8, selected.nonce], [40, selected.requestSha256], [72, selected.resultSha256],
    [104, selected.workDirectoryIdentityHex], [128, selected.fileIdentityHex]] as const) Buffer.from(value, "hex").copy(bytes, offset);
  bytes.writeBigUInt64LE(BigInt(length), 152); bytes.writeBigUInt64LE(4096n, 160);
  const digest = createHash("sha256").update(content).digest(); digest.copy(bytes, 168); content.copy(bytes, 200);
  return { selected, bytes, content, digest: digest.toString("hex") };
}
describe("native staged file content", () => {
  it.each([0, 5, 1048576])("checks exact bounded bytes and raw SHA256 for %i bytes", length => {
    const f = fixture(length), value = readRemoteWorkerNativeFileContent(f.bytes.toString("hex"), f.selected);
    expect(value).toMatchObject({ byteLength: length, contentSha256: f.digest, contentHex: f.content.toString("hex"),
      recordSha256: createHash("sha256").update(f.bytes).digest("hex") });
    expect(Object.isFrozen(value)).toBe(true);
  });
  it.each([0, 8, 40, 72, 104, 128, 152, 160, 168, 200])("rejects changed header/content at byte %i", offset => {
    const f = fixture(); f.bytes[offset] = f.bytes[offset]! ^ 1;
    expect(() => readRemoteWorkerNativeFileContent(f.bytes.toString("hex"), f.selected)).toThrow();
  });
  it("rejects malformed, oversized, short and noncanonical records", () => {
    const f = fixture(), hex = f.bytes.toString("hex");
    for (const input of [null, {}, hex.toUpperCase(), hex.slice(0, -2), hex + "00", "z".repeat(hex.length)])
      expect(() => readRemoteWorkerNativeFileContent(input, f.selected)).toThrow();
  });
  it("requires the independent result selection, including scope-derived selection digest", () => {
    const f = fixture(), hex = f.bytes.toString("hex");
    expect(() => readRemoteWorkerNativeFileContent(hex, { ...f.selected, resultSha256: "99".repeat(32) })).toThrow();
    const a = readRemoteWorkerNativeFileContent(hex, f.selected);
    const b = readRemoteWorkerNativeFileContent(hex, { ...f.selected, logicalPath: "outputs/other.bin" });
    expect(a.selectionSha256).not.toBe(b.selectionSha256);
    expect(a.contentSha256).toBe(b.contentSha256); // labels are independently governed, never native locators
  });
});
