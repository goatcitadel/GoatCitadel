import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA, encodeRemoteWorkerRuntimeCleanup } from "@goatcitadel/contracts";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { WindowsRuntimeCleanupSender } from "./worker-windows-runtime-cleanup.js";
function fixture(count = 2, mode = "good") {
  const f = runtimeResultPagesFixture(2), exchange = { schemaVersion: REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA, challenge: "cc".repeat(32), history: f.history,
    expectations: Array.from({ length: count }, (_, index) => ({ ...f.expectation, nonce: (index + 1).toString(16).padStart(64, "0") })) };
  const encoded = encodeRemoteWorkerRuntimeCleanup(exchange), frames: Buffer[] = [], stop = new AbortController();
  let payloadBytes = 0, terminal = false;
  const channel = new Duplex({ read() {}, write(bytes: Buffer, _encoding, done) {
    frames.push(Buffer.from(bytes));
    if (frames.length > 1 && frames.length % 2 === 1) payloadBytes += bytes.length;
    if (payloadBytes === encoded.bytesHex.length / 2 && !terminal) {
      terminal = true; const ack = Buffer.alloc(80); ack.write("GCCLA001"); Buffer.from(encoded.challenge + encoded.setSha256, "hex").copy(ack, 8);
      ack.writeUInt32LE(payloadBytes, 72);
      if (mode === "wrong") ack[40] = ack[40]! ^ 1;
      if (mode === "truncated") this.push(ack.subarray(0, 40));
      else if (mode === "extra") this.push(Buffer.concat([ack, Buffer.from([1])]));
      else if (mode !== "silent") { this.push(ack.subarray(0, 13)); this.push(ack.subarray(13)); }
    }
    done();
  } });
  const owner = { signal: stop.signal, timeoutMs: 1000, authorize: vi.fn(async (_signal: AbortSignal) => {}) };
  return { exchange, encoded, frames, stop, channel, owner };
}
describe("native cleanup sender", () => {
  it("preserves the enclosing deadline across delayed start and refuses writes after it", async () => {
    const f = fixture(); let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const sender = new WindowsRuntimeCleanupSender(f.channel, f.exchange, { ...f.owner, deadline: 100 });
      now = 99;
      f.owner.authorize.mockImplementation(async () => { now = 100; });
      await expect(sender.send()).rejects.toThrow(); expect(f.frames).toHaveLength(0);
    } finally { clock.mockRestore(); f.channel.destroy(); }
  });
  it.each([0, 2, 1000])("sends all %i expectations with exact framing and a bound receipt", async count => {
    const f = fixture(count), sender = new WindowsRuntimeCleanupSender(f.channel, f.exchange, f.owner);
    try {
      expect(await sender.send()).toEqual({ ...sender.binding, byteLength: 252 + count * 108 });
      expect(f.frames[0]!.subarray(0, 8).toString()).toBe("GCCLX001");
      const chunks: Buffer[] = [];
      for (let index = 1, offset = 0; index < f.frames.length; index += 2) {
        const header = f.frames[index]!, bytes = f.frames[index + 1]!;
        expect(header.subarray(0, 8).toString()).toBe("GCCLD001"); expect(header.readUInt32LE(8)).toBe(offset);
        expect(header.readUInt32LE(12)).toBe(bytes.length); chunks.push(bytes); offset += bytes.length;
      }
      expect(Buffer.concat(chunks).toString("hex")).toBe(f.encoded.bytesHex);
      const writes = f.frames.length; await expect(sender.send()).rejects.toThrow(); expect(f.frames).toHaveLength(writes);
      for (const event of ["readable", "error", "close", "end"]) expect(f.channel.listenerCount(event)).toBe(0);
    } finally { f.channel.destroy(); }
  });
  it.each(["wrong", "extra", "truncated", "silent"])("refuses %s receipts without retransmission", async mode => {
    const f = fixture(2, mode), sender = new WindowsRuntimeCleanupSender(f.channel, f.exchange, { ...f.owner, timeoutMs: 30 });
    try { await expect(sender.send()).rejects.toThrow(); const writes = f.frames.length; await expect(sender.send()).rejects.toThrow(); expect(f.frames).toHaveLength(writes); }
    finally { f.channel.destroy(); }
  });
  it.each(["before", "during", "after", "hung"])("refuses %s authority failure", async mode => {
    const f = fixture(), sender = new WindowsRuntimeCleanupSender(f.channel, f.exchange, { ...f.owner, timeoutMs: 30 });
    if (mode === "before") f.stop.abort();
    if (mode === "during") f.owner.authorize.mockImplementation(async () => { if (f.frames.length) throw new Error("revoked"); });
    if (mode === "after") f.owner.authorize.mockImplementation(async () => { if (f.frames.length >= 3) throw new Error("revoked"); });
    if (mode === "hung") f.owner.authorize.mockImplementation(() => new Promise<void>(() => {}));
    try { await expect(sender.send()).rejects.toThrow(); if (mode === "before" || mode === "hung") expect(f.frames).toHaveLength(0); }
    finally { f.channel.destroy(); }
  });
  it("snapshots metadata before authority callbacks and rejects unsolicited bytes", async () => {
    const f = fixture(), sender = new WindowsRuntimeCleanupSender(f.channel, f.exchange, f.owner);
    f.owner.authorize.mockImplementation(async () => { f.exchange.expectations.length = 0; });
    try { await expect(sender.send()).resolves.toMatchObject({ byteLength: 468 }); } finally { f.channel.destroy(); }
    const g = fixture(), other = new WindowsRuntimeCleanupSender(g.channel, g.exchange, g.owner); g.channel.push(Buffer.from([1]));
    try { await expect(other.send()).rejects.toThrow(); expect(g.frames).toHaveLength(0); } finally { g.channel.destroy(); }
  });
  it("refuses competing consumers and callbacks that overrun the deadline before timers fire", async () => {
    const f = fixture(), consume = () => {}; f.channel.on("data", consume);
    try { await expect(new WindowsRuntimeCleanupSender(f.channel, f.exchange, f.owner).send()).rejects.toThrow(); expect(f.frames).toHaveLength(0); }
    finally { f.channel.off("data", consume); f.channel.destroy(); }
    const g = fixture();
    g.owner.authorize.mockImplementation(async () => { const until = performance.now() + 20; while (performance.now() < until) { /* controlled timer starvation */ } });
    try { await expect(new WindowsRuntimeCleanupSender(g.channel, g.exchange, { ...g.owner, timeoutMs: 5 }).send()).rejects.toThrow(); expect(g.frames).toHaveLength(0); }
    finally { g.channel.destroy(); }
  });
});
