import { describe, expect, it } from "vitest";
import { runtimeResultPagesFixture } from "./remote-worker-runtime-result-pages-test-fixture.js";
import { readRemoteWorkerRuntimeResult } from "./remote-worker-runtime-result.js";
import { readRemoteWorkerNativeFileSelections as read } from "./remote-worker-native-file-selections.js";

function fixture() {
  const f = runtimeResultPagesFixture(2), raw = Buffer.from(f.bytes);
  raw.writeBigUInt64LE(5n, 256 + 328);
  raw.writeBigUInt64LE(5n, 608 + 40 + 4 * 48 + 32);
  const resultHex = raw.toString("hex");
  const result = readRemoteWorkerRuntimeResult(resultHex, f.expectation, f.history);
  const files = result.inventory!.entries.filter(entry => !entry.directory).slice(0, 2);
  const plan = { paths: ["report.txt", "nested/result.json"], maximumFileBytes: 1024, maximumTotalBytes: 2048 };
  const header = Buffer.alloc(108); header.write("GCFSL001");
  Buffer.from(f.expectation.nonce, "hex").copy(header, 8);
  Buffer.from(f.expectation.requestSha256, "hex").copy(header, 40);
  Buffer.from(result.resultSha256, "hex").copy(header, 72); header.writeUInt32LE(2, 104);
  const bytes = Buffer.concat([header, ...files.map(file => Buffer.from(file.identityHex, "hex"))]);
  return { ...f, bytes, resultHex, plan, files, read: (hex: unknown = bytes.toString("hex")) => read(hex, plan, f.expectation, resultHex, f.history) };
}
describe("native collection identity handoff", () => {
  it("derives frozen identities, labels and limits from independent execution evidence", () => {
    const f = fixture(), selected = f.read();
    expect(selected.map(file => file.logicalPath)).toEqual(f.plan.paths);
    expect(selected.map(file => file.fileIdentityHex)).toEqual(f.files.map(file => file.identityHex));
    expect(selected.every(file => file.maximumBytes === 1024 && Object.isFrozen(file))).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    f.plan.paths[0] = "changed.txt";
    expect(selected[0]!.logicalPath).toBe("report.txt");
  });
  it("refuses every changed header byte before exposing selections", () => {
    const f = fixture();
    for (let index = 0; index < 108; ++index) {
      const bytes = Buffer.from(f.bytes); bytes[index] = bytes[index]! ^ 1;
      expect(() => f.read(bytes.toString("hex"))).toThrow();
    }
  });
  it("refuses duplicate, missing, directory, truncated and extra identities", () => {
    const f = fixture(), duplicate = Buffer.from(f.bytes), missing = Buffer.from(f.bytes), directory = Buffer.from(f.bytes);
    duplicate.copy(duplicate, 132, 108, 132); missing.fill(0, 108, 132);
    const result = readRemoteWorkerRuntimeResult(f.resultHex, f.expectation, f.history);
    Buffer.from(result.inventory!.directoryIdentityHex[0]!, "hex").copy(directory, 108);
    for (const bytes of [duplicate, missing, directory, f.bytes.subarray(0, -1), Buffer.concat([f.bytes, Buffer.from([0])])])
      expect(() => f.read(bytes.toString("hex"))).toThrow();
    expect(() => f.read(f.bytes.toString("hex").toUpperCase())).toThrow();
  });
  it("enforces both independent per-file and aggregate ceilings", () => {
    const f = fixture();
    for (const changes of [{ maximumFileBytes: 4 }, { maximumTotalBytes: 4 }])
      expect(() => read(f.bytes.toString("hex"), { ...f.plan, ...changes }, f.expectation, f.resultHex, f.history)).toThrow();
  });
});
