import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readRemoteWorkerRuntimeResult, readRemoteWorkerNativeFileSelections } from "@goatcitadel/contracts";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { WindowsRuntimeFileBatchReceiver, type WindowsRuntimeFileBatchOwner } from "./worker-windows-runtime-files.js";

function fixture(length = 5, timeoutMs = 5000) {
  const f = runtimeResultPagesFixture(2), raw = Buffer.from(f.bytes), stop = new AbortController();
  raw.writeBigUInt64LE(BigInt(length), 256 + 328); raw.writeBigUInt64LE(BigInt(length), 608 + 40 + 4 * 48 + 32);
  const resultHex = raw.toString("hex"), result = readRemoteWorkerRuntimeResult(resultHex, f.expectation, f.history);
  const entries = result.inventory!.entries.filter(entry => !entry.directory);
  const plan = { paths: ["outputs/one.bin", "outputs/two.bin"], maximumFileBytes: 1048576, maximumTotalBytes: 1048576 };
  const manifest = Buffer.alloc(108 + 24 * 2); manifest.write("GCFSL001");
  Buffer.from(f.expectation.nonce, "hex").copy(manifest, 8); Buffer.from(f.expectation.requestSha256, "hex").copy(manifest, 40);
  Buffer.from(result.resultSha256, "hex").copy(manifest, 72); manifest.writeUInt32LE(2, 104);
  entries.forEach((entry, index) => Buffer.from(entry.identityHex, "hex").copy(manifest, 108 + index * 24));
  const selections = readRemoteWorkerNativeFileSelections(manifest.toString("hex"), plan, f.expectation, resultHex, f.history);
  const records: Buffer[] = [], parts = [manifest], starts: number[] = [];
  let wireLength = manifest.length;
  for (const selected of selections) {
    starts.push(wireLength);
    const record = Buffer.alloc(200 + selected.logicalFileBytes); record.write("GCRFA001");
    for (const [offset, value] of [[8, selected.nonce], [40, selected.requestSha256], [72, selected.resultSha256],
      [104, selected.workDirectoryIdentityHex], [128, selected.fileIdentityHex]] as const) Buffer.from(value, "hex").copy(record, offset);
    record.writeBigUInt64LE(BigInt(selected.logicalFileBytes), 152); record.writeBigUInt64LE(BigInt(selected.allocatedBytes), 160);
    record.fill(0xab, 200); createHash("sha256").update(record.subarray(200)).digest().copy(record, 168);
    const header = Buffer.alloc(112); header.write("GCFHS001");
    Buffer.from(selected.nonce, "hex").copy(header, 8); Buffer.from(selected.requestSha256, "hex").copy(header, 40);
    createHash("sha256").update(record).digest().copy(header, 72); header.writeUInt32LE(record.length, 104); header.writeUInt32LE(4096, 108);
    parts.push(header); wireLength += header.length;
    for (let offset = 0; offset < record.length; offset += 4096) {
      const count = Math.min(4096, record.length - offset), chunk = Buffer.alloc(16); chunk.write("GCFHC001");
      chunk.writeUInt32LE(offset, 8); chunk.writeUInt32LE(count, 12);
      parts.push(chunk, record.subarray(offset, offset + count)); wireLength += 16 + count;
    }
    records.push(record);
  }
  const wire = Buffer.concat(parts), writes: Buffer[] = []; let offset = 0;
  const owner = { signal: stop.signal, timeoutMs,
    read: vi.fn<WindowsRuntimeFileBatchOwner["read"]>(async count => { const bytes = wire.subarray(offset, offset + count); offset += count; return bytes; }),
    write: vi.fn<WindowsRuntimeFileBatchOwner["write"]>(async bytes => { writes.push(Buffer.from(bytes)); }),
    authorizePeer: vi.fn<WindowsRuntimeFileBatchOwner["authorizePeer"]>(async () => {}),
    authorizeFile: vi.fn<WindowsRuntimeFileBatchOwner["authorizeFile"]>(async () => {}),
  };
  const receiver = new WindowsRuntimeFileBatchReceiver(plan, f.expectation, resultHex, f.history, owner);
  return { ...f, raw, resultHex, result, plan, selections, records, wire, starts, writes, owner, receiver, stop };
}

describe("protected parent native file batch", () => {
  it.each([0, 5, 1048576])("receives complete bounded content including %i-byte files", async length => {
    const f = fixture(length), files = await f.receiver.run();
    expect(files.map(file => file.record)).toEqual(f.records);
    expect(files.map(file => file.selection)).toEqual(f.selections);
    expect(f.writes.map(bytes => bytes.subarray(0, 8).toString())).toEqual(["GCFSA001", "GCFHA001", "GCFHA001", "GCFSD001"]);
    expect(f.writes[0]!.subarray(8)).toEqual(f.writes[3]!.subarray(8));
    expect(f.receiver.state.completed).toBe(true); expect(Object.isFrozen(files)).toBe(true);
    files.forEach(file => file.record.fill(0));
    await expect(f.receiver.run()).rejects.toThrow();
  });
  it.each(["manifest", "identity", "header", "nonce", "size", "chunk", "content", "second_file"] as const)("withholds a malformed %s batch", async mode => {
    const f = fixture();
    const offset = ({ manifest: 72, identity: 108, header: f.starts[0]!, nonce: f.starts[0]! + 8,
      size: f.starts[0]! + 104, chunk: f.starts[0]! + 120, content: f.starts[0]! + 128 + 200,
      second_file: f.starts[1]! } as const)[mode];
    f.wire[offset] = f.wire[offset]! ^ 1;
    await expect(f.receiver.run()).rejects.toThrow(); expect(f.receiver.state.completed).toBe(false);
    expect(f.writes.some(bytes => bytes.subarray(0, 8).toString() === "GCFSD001")).toBe(false);
    if (mode === "second_file") expect(f.writes.map(bytes => bytes.subarray(0, 8).toString())).toEqual(["GCFSA001", "GCFHA001"]);
  });
  it.each(["permission", "cancelled", "final_write", "late_peer", "short_read", "reentry"])("withholds content on %s failure", async mode => {
    const f = fixture();
    if (mode === "permission") f.owner.authorizeFile.mockRejectedValueOnce(new Error("File disclosure denied"));
    if (mode === "cancelled") f.owner.authorizeFile.mockImplementationOnce(async () => { f.stop.abort(); });
    if (mode === "short_read") f.owner.read.mockResolvedValueOnce(Buffer.alloc(1));
    if (mode === "final_write") f.owner.write.mockImplementation(async bytes => {
      if (bytes.subarray(0, 8).toString() === "GCFSD001") throw new Error("Lost final receipt");
      f.writes.push(Buffer.from(bytes));
    });
    if (mode === "late_peer") f.owner.authorizePeer.mockImplementation(async () => {
      if (f.writes.at(-1)?.subarray(0, 8).toString() === "GCFSD001") throw new Error("Peer custody changed");
    });
    if (mode === "reentry") f.owner.authorizeFile.mockImplementationOnce(async () => { await expect(f.receiver.run()).rejects.toThrow(); });
    await expect(f.receiver.run()).rejects.toThrow(); expect(f.receiver.state.completed).toBe(false);
    if (mode === "permission" || mode === "cancelled" || mode === "reentry") expect(f.writes).toHaveLength(0);
  });
  it("expires a stuck read and propagates cancellation to the borrowed owner", async () => {
    const f = fixture(5, 25); f.owner.read.mockImplementationOnce(async () => new Promise<Buffer>(() => {}));
    await expect(f.receiver.run()).rejects.toThrow();
    expect(f.owner.read.mock.calls[0]![1].aborted).toBe(true); expect(f.writes).toHaveLength(0);
  });
  it("snapshots the approved file plan before asynchronous callbacks", async () => {
    const f = fixture(); f.plan.paths[0] = "unapproved.txt";
    const files = await f.receiver.run(); expect(files[0]!.selection.logicalPath).toBe("outputs/one.bin");
    files.forEach(file => file.record.fill(0));
  });
  it("wipes privately accumulated content when the final custody check fails", async () => {
    const f = fixture();
    f.owner.authorizePeer.mockImplementation(async () => {
      if (f.writes.at(-1)?.subarray(0, 8).toString() === "GCFSD001") throw new Error("Custody lost");
    });
    const wiped = vi.spyOn(Buffer.prototype, "fill");
    try {
      await expect(f.receiver.run()).rejects.toThrow();
      const records = wiped.mock.contexts.filter((buffer): buffer is Buffer => Buffer.isBuffer(buffer) && (buffer.length === 205 || buffer.length === 200));
      expect(records.length).toBeGreaterThanOrEqual(2);
      expect(records.every(buffer => buffer.every(byte => byte === 0))).toBe(true);
    } finally { wiped.mockRestore(); }
  });
});
