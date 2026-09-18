import { describe, expect, it } from "vitest";
import { runtimeResultPagesFixture } from "./remote-worker-runtime-result-pages-test-fixture.js";
import { readRemoteWorkerRuntimeResult } from "./remote-worker-runtime-result.js";
import { readRemoteWorkerNativeFileAuthorization as read } from "./remote-worker-native-file-authorization.js";

function fixture() {
  const f = runtimeResultPagesFixture(2), raw = Buffer.from(f.bytes);
  raw.writeBigUInt64LE(5n, 256 + 328); raw.writeBigUInt64LE(5n, 608 + 40 + 4 * 48 + 32);
  const resultHex = raw.toString("hex"), result = readRemoteWorkerRuntimeResult(resultHex, f.expectation, f.history);
  const file = result.inventory!.entries.find(entry => !entry.directory && entry.logicalFileBytes === 5)!;
  const bytes = Buffer.alloc(1060), path = Buffer.from("outputs/result.txt");
  Buffer.from(result.resultSha256, "hex").copy(bytes);
  Buffer.from(result.inventory!.directoryIdentityHex[3]!, "hex").copy(bytes, 32);
  Buffer.from(file.identityHex, "hex").copy(bytes, 56);
  bytes.writeBigUInt64LE(5n, 80); bytes.writeBigUInt64LE(4096n, 88); bytes.writeUInt32LE(1024, 96);
  bytes.writeUInt32LE(path.length, 100); path.copy(bytes, 104);
  return { ...f, bytes, file, resultHex, read: (value: unknown = bytes.toString("hex")) => read(value, f.expectation, resultHex, f.history) };
}
describe("native file control challenge", () => {
  it("derives an immutable scoped selection from retained execution evidence", () => {
    const f = fixture(), result = f.read();
    expect(result.fileIdentityHex).toBe(f.file.identityHex);
    expect(result.logicalPath).toBe("outputs/result.txt");
    expect(result.logicalFileBytes).toBe(5); expect(result.maximumBytes).toBe(1024);
    expect(result.assignmentId).toBe(f.history.assignmentId); expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([0, 32, 56, 80, 88, 104, 1059])("rejects changed retained metadata or malformed path at byte %s", offset => {
    const f = fixture(), bytes = Buffer.from(f.bytes);
    if (offset === 104) bytes[offset] = 255; else bytes[offset] = bytes[offset]! ^ 1;
    expect(() => f.read(bytes.toString("hex"))).toThrow();
  });
  it("rejects unknown lengths, noncanonical padding and unsafe limits", () => {
    const f = fixture();
    for (const [offset, value] of [[96, 0], [96, 4], [96, 1048577], [100, 0], [100, 513]] as const) {
      const bytes = Buffer.from(f.bytes); bytes.writeUInt32LE(value, offset);
      expect(() => f.read(bytes.toString("hex"))).toThrow();
    }
    for (const value of [null, f.bytes.toString("hex").slice(2), f.bytes.toString("hex") + "00", f.bytes.toString("hex").toUpperCase()])
      expect(() => f.read(value)).toThrow();
  });
});
