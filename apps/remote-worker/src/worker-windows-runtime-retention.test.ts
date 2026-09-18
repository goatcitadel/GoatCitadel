import { Duplex } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { WindowsRuntimeResultRetentionParent, createWindowsRuntimeResultGatewayParent } from "./worker-windows-runtime-retention.js";
import { uploadWorkerRuntimeResult } from "./worker-runtime-result-client.js";
import type { RouteContext } from "./connected-worker-routes.js";
vi.mock("./worker-runtime-result-client.js", () => ({ uploadWorkerRuntimeResult: vi.fn() }));

function fixture(maximum = false) {
  const f = runtimeResultPagesFixture(maximum ? 19996 : 22), header = Buffer.alloc(112), replies: Buffer[] = [], controller = new AbortController();
  header.write("GCRTS001"); Buffer.from(f.expectation.nonce, "hex").copy(header, 8); Buffer.from(f.expectation.requestSha256, "hex").copy(header, 40);
  Buffer.from(f.resultSha256, "hex").copy(header, 72); header.writeUInt32LE(f.bytes.length, 104); header.writeUInt32LE(4096, 108);
  const frames = [header];
  for (let offset = 0; offset < f.bytes.length; offset += 4096) {
    const chunk = Buffer.alloc(16), payload = f.bytes.subarray(offset, offset + 4096); chunk.write("GCRTC001");
    chunk.writeUInt32LE(offset, 8); chunk.writeUInt32LE(payload.length, 12); frames.push(chunk, payload);
  }
  const channel = new Duplex({ read() {}, write(bytes, _encoding, done) { replies.push(Buffer.from(bytes)); done(); } });
  const receipt = f.response(null, true).record!;
  const owner = { signal: controller.signal, timeoutMs: 5000, authorize: vi.fn(async () => {}), retain: vi.fn(async (_hex: string, _signal: AbortSignal) => receipt) };
  const create = () => new WindowsRuntimeResultRetentionParent(channel, f.expectation, f.history, owner);
  return { ...f, header, frames, replies, controller, channel, receipt, owner, create };
}
describe("native retention parent", () => {
  it.each([132, 1644])("allows only the dispatcher-declared %i-byte selection continuation", async maximum => {
    const f = fixture();
    f.owner.retain.mockImplementationOnce(async () => { f.channel.push(Buffer.alloc(maximum)); return f.receipt; });
    const parent = new WindowsRuntimeResultRetentionParent(f.channel, f.expectation, f.history,
      { ...f.owner, allowDispatcherContinuation: true, dispatcherContinuationMaxBytes: maximum });
    f.channel.push(Buffer.concat(f.frames)); await expect(parent.run()).resolves.toEqual(f.receipt);
    expect(f.channel.readableLength).toBe(maximum); f.channel.destroy();
  });
  it.each(["excess", "over_cap", "standalone"])("rejects %s file continuation allowance", async mode => {
    const f = fixture();
    f.owner.retain.mockImplementationOnce(async () => { f.channel.push(Buffer.alloc(133)); return f.receipt; });
    const parent = new WindowsRuntimeResultRetentionParent(f.channel, f.expectation, f.history,
      { ...f.owner, allowDispatcherContinuation: mode !== "standalone", dispatcherContinuationMaxBytes: mode === "over_cap" ? 1645 : 132 });
    f.channel.push(Buffer.concat(f.frames)); await expect(parent.run()).rejects.toThrow(); f.channel.destroy();
  });
  beforeEach(() => vi.clearAllMocks());
  it("validates maximum metadata before upload and writes distinct receipts in order", async () => {
    const f = fixture(true); f.channel.push(Buffer.concat(f.frames));
    f.owner.retain.mockImplementationOnce(async () => {
      expect(f.replies.map(bytes => bytes.subarray(0, 8).toString())).toEqual(["GCRTA002"]); return f.receipt;
    });
    const parent = f.create(); await expect(parent.run()).resolves.toEqual(f.receipt);
    expect(f.owner.retain).toHaveBeenCalledTimes(1); expect(f.owner.retain.mock.calls[0]![0]).toBe(f.resultHex);
    expect(f.replies.map(bytes => bytes.subarray(0, 8).toString())).toEqual(["GCRTA002", "GCRTA003"]);
    expect(f.replies[1]!.subarray(72, 104).toString("hex")).toBe(f.resultSha256);
    expect(parent.state.retentionReceiptSent).toBe(true);
    await expect(parent.run()).rejects.toThrow(); expect(f.owner.retain).toHaveBeenCalledTimes(1);
    expect(f.controller.signal.aborted).toBe(false); f.channel.destroy();
  });
  it.each([1, 137])("handles %i-byte fragments without borrowing a second stream reader", async fragmentSize => {
    const f = fixture(), all = Buffer.concat(f.frames), parent = f.create(), pending = parent.run();
    for (let offset = 0; offset < all.length; offset += fragmentSize) { f.channel.push(all.subarray(offset, offset + fragmentSize)); await new Promise<void>(resolve => setImmediate(resolve)); }
    await expect(pending).resolves.toEqual(f.receipt); expect(f.channel.listenerCount("readable")).toBe(0); f.channel.destroy();
  });
  it.each([120, 121])("bounds the explicit dispatcher continuation to 120 bytes (%i)", async tailSize => {
    const f = fixture(), tail = Buffer.alloc(tailSize, 7);
    f.channel.push(Buffer.concat([...f.frames, tail]));
    const parent = new WindowsRuntimeResultRetentionParent(f.channel, f.expectation, f.history, { ...f.owner, allowDispatcherContinuation: true });
    if (tailSize === 120) {
      await expect(parent.run()).resolves.toEqual(f.receipt); expect(f.channel.read(tailSize)).toEqual(tail); expect(f.owner.retain).toHaveBeenCalledTimes(1);
    } else { await expect(parent.run()).rejects.toThrow(); expect(f.owner.retain).not.toHaveBeenCalled(); }
    f.channel.destroy();
  });
  it.each(["header", "header_high_bit", "nonce", "digest", "length", "chunk", "chunk_high_bit", "body", "extra", "deny", "abort"])("refuses %s before retention", async mode => {
    const f = fixture();
    if (mode === "header") f.header[0] = 0;
    if (mode === "header_high_bit") f.header[0] = f.header[0]! | 0x80;
    if (mode === "nonce") f.header[8] = f.header[8]! ^ 1;
    if (mode === "digest") f.header[72] = f.header[72]! ^ 1;
    if (mode === "length") f.header.writeUInt32LE(1000609, 104);
    if (mode === "chunk") f.frames[1]!.writeUInt32LE(1, 8);
    if (mode === "chunk_high_bit") f.frames[1]![0] = f.frames[1]![0]! | 0x80;
    if (mode === "body") f.frames[2]![0] = 0;
    if (mode === "extra") f.frames.push(Buffer.from([1]));
    if (mode === "deny") f.owner.authorize.mockRejectedValueOnce(new Error("Denied"));
    if (mode === "abort") f.controller.abort();
    f.channel.push(Buffer.concat(f.frames)); const parent = f.create();
    await expect(parent.run()).rejects.toThrow(); expect(f.owner.retain).not.toHaveBeenCalled(); expect(f.replies).toHaveLength(0); f.channel.destroy();
  });
  it.each(["failed", "digest", "cancelled", "extra", "getter", "late", "reentrant"])("withholds final receipt after %s commit", async mode => {
    const f = fixture(); f.channel.push(Buffer.concat(f.frames)); const parent = f.create(); let reads = 0;
    if (mode === "late") f.owner.timeoutMs = 500;
    const selected = mode === "late" ? f.create() : parent;
    f.owner.retain.mockImplementationOnce(async () => {
      if (mode === "failed") throw new Error("Unknown commit outcome");
      if (mode === "digest") return { ...f.receipt, resultSha256: "ff".repeat(32) };
      if (mode === "cancelled") f.controller.abort();
      if (mode === "extra") f.channel.push(Buffer.from([1]));
      if (mode === "getter") return { ...f.receipt, get resultSha256() { reads += 1; return f.resultSha256; } };
      if (mode === "late") await new Promise(resolve => setTimeout(resolve, 600));
      if (mode === "reentrant") await expect(selected.run()).rejects.toThrow();
      return f.receipt;
    });
    await expect(selected.run()).rejects.toThrow(); expect(reads).toBe(0);
    expect(f.owner.retain).toHaveBeenCalledTimes(1); expect(selected.state.retentionReceiptSent).toBe(false);
    expect(f.replies.map(bytes => bytes.subarray(0, 8).toString())).toEqual(["GCRTA002"]); f.channel.destroy();
  });
  it("uses only the protected Gateway uploader in production composition", async () => {
    const f = fixture(), lease = { registryWorkspaceId: f.history.registryWorkspaceId, assignmentId: f.history.assignmentId,
      assignmentGeneration: f.history.assignmentGeneration, leaseRevision: f.history.leaseRevision, leaseToken: "private-lease" };
    vi.mocked(uploadWorkerRuntimeResult).mockResolvedValueOnce(f.response(null, true)); f.channel.push(Buffer.concat(f.frames));
    const parent = createWindowsRuntimeResultGatewayParent(f.channel, {} as RouteContext, lease, f.expectation, f.history, f.owner);
    lease.assignmentId = "changed"; await expect(parent.run()).resolves.toEqual(f.receipt);
    expect(uploadWorkerRuntimeResult).toHaveBeenCalledTimes(1); expect(vi.mocked(uploadWorkerRuntimeResult).mock.calls[0]![1].assignmentId).toBe(f.history.assignmentId);
    expect(f.owner.retain).not.toHaveBeenCalled(); f.channel.destroy();
  });
});
