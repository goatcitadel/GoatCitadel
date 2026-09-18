import { createHash } from "node:crypto";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { WindowsRuntimeHelperParent } from "./worker-windows-runtime-helper.js";
import type { WindowsRuntimeParentSessionOwner } from "./worker-windows-runtime-parent-session.js";
import { readRemoteWorkerRuntimeResult } from "@goatcitadel/contracts";

const parents: WindowsRuntimeHelperParent[] = [], sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const parent of parents.splice(0)) await parent.close();
});
async function read(socket: Socket, count: number): Promise<Buffer> {
  const parts: Buffer[] = []; let total = 0;
  while (total < count) {
    if (socket.destroyed || socket.readableEnded) throw new Error("Owned test pipe closed.");
    const wanted = Math.min(count - total, socket.readableLength);
    if (wanted) {
      const bytes: unknown = socket.read(wanted);
      if (!Buffer.isBuffer(bytes) || bytes.length !== wanted) throw new Error("Invalid test pipe read.");
      parts.push(bytes); total += bytes.length; continue;
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); socket.off("readable", ready); socket.off("error", ended); socket.off("end", ended); socket.off("close", ended); };
      const ready = () => { cleanup(); resolve(); }, ended = () => { cleanup(); reject(new Error("Owned test pipe closed.")); };
      const timer = setTimeout(ended, 2500);
      socket.once("readable", ready); socket.once("error", ended); socket.once("end", ended); socket.once("close", ended);
      if (socket.readableLength) ready();
    });
  }
  return Buffer.concat(parts, count);
}
async function frame(socket: Socket): Promise<{ kind: number; bytes: Buffer }> {
  const header = await read(socket, 16);
  expect(header.subarray(0, 8).toString()).toBe("GCCELL01"); expect(header.readUInt32LE(12)).toBeLessThanOrEqual(1168);
  return { kind: header.readUInt32LE(8), bytes: await read(socket, header.readUInt32LE(12)) };
}
function wire(kind: number, bytes: Buffer): Buffer {
  const header = Buffer.alloc(16); header.write("GCCELL01"); header.writeUInt32LE(kind, 8); header.writeUInt32LE(bytes.length, 12);
  return Buffer.concat([header, bytes]);
}
async function fixture() {
  const f = runtimeResultPagesFixture(22), stop = new AbortController();
  // Request/result wire fixtures only; these tests never launch a workload.
  const request = Buffer.alloc(157); request.write("GCRUN001"); Buffer.from(f.expectation.nonce, "hex").copy(request, 8);
  Buffer.from(f.expectation.checkpointSha256, "hex").copy(request, 96); request.writeUInt32LE(13, 140);
  request.write("GCSTDIO2", 144); request.writeUInt32LE(1, 152); request[156] = 0x61;
  const expected = { ...f.expectation, requestSha256: createHash("sha256").update("goatcitadel.worker-runtime-dispatch.v1\0").update(request).digest("hex") };
  const result = Buffer.from(f.bytes); Buffer.from(expected.requestSha256, "hex").copy(result, 40);
  const digest = createHash("sha256").update("goatcitadel.worker-runtime-result.v1\0").update(result).digest();
  const receipt = { ...f.response(null, true).record!, resultSha256: digest.toString("hex") };
  expect(readRemoteWorkerRuntimeResult(result.toString("hex"), expected, f.history).resultSha256).toBe(receipt.resultSha256);
  const owner: WindowsRuntimeParentSessionOwner = { signal: stop.signal, timeoutMs: 5000,
    authorizePeer: vi.fn(async () => undefined), authorizeRuntime: vi.fn(async () => undefined), authorizeDelivery: vi.fn(async () => undefined),
    authorizeRetention: vi.fn(async () => undefined), retain: vi.fn(async hex => { expect(hex).toBe(result.toString("hex")); return receipt; }),
    readInput: vi.fn(async () => "eof" as const), authorizeInput: vi.fn(async () => undefined), consumeOutput: vi.fn(async () => undefined) };
  const parent = await WindowsRuntimeHelperParent.open(request, expected, f.history, owner); parents.push(parent);
  const bootstrap = parent.takeBootstrap();
  const runtime = connect(parent.pipeName), control = connect(parent.controlPipeName); sockets.push(runtime, control);
  for (const socket of [runtime, control]) socket.on("error", () => undefined);
  await Promise.all([once(runtime, "connect"), once(control, "connect")]);
  for (const [socket, magic] of [[runtime, "GCRPA001"], [control, "GCRPC001"]] as const) {
    const hello = Buffer.alloc(136); hello.write(magic); bootstrap.copy(hello, 8, 40, 168);
    socket.write(hello); const expectedReply = Buffer.from(hello); expectedReply[7] = 0x32;
    expect(await read(socket, 136)).toEqual(expectedReply); hello.fill(0); expectedReply.fill(0);
  }
  bootstrap.fill(0);
  const challenge = (ordinal = 1) => {
    const bytes = Buffer.alloc(104); Buffer.from(expected.nonce, "hex").copy(bytes); bytes.writeUInt32LE(ordinal, 32); bytes.writeUInt32LE(21, 36);
    Buffer.from(expected.checkpointSha256, "hex").copy(bytes, 40); Buffer.from(expected.requestSha256, "hex").copy(bytes, 72); return bytes;
  };
  const stream = (count = 1056) => {
    const bytes = Buffer.alloc(count); Buffer.from(expected.nonce, "hex").copy(bytes); Buffer.from(expected.requestSha256, "hex").copy(bytes, 32);
    bytes.writeUInt32LE(1, 64); if (count === 88) bytes.writeUInt32LE(1, 80); return bytes;
  };
  const check = async (action: number, ordinal: number) => {
    const bytes = Buffer.alloc(1168); challenge(ordinal).copy(bytes); bytes.writeUInt32LE(action, 104);
    if (action === 1) { bytes.writeUInt32LE(22, 108); stream().copy(bytes, 112); }
    control.write(wire(37, bytes)); const reply = await frame(control); expect(reply).toEqual({ kind: 38, bytes });
  };
  const send = async (kind: number, bytes: Buffer) => { runtime.write(wire(kind, bytes)); return frame(runtime); };
  const prepare = async () => {
    expect((await send(32, stream(88))).kind).toBe(33); await check(1, 1);
    expect((await send(19, challenge())).kind).toBe(20);
    expect((await send(25, stream())).kind).toBe(34); expect((await send(27, stream())).kind).toBe(34);
    await check(2, 2); expect((await send(30, challenge())).kind).toBe(31);
  };
  const retain = async () => {
    const header = Buffer.alloc(112); header.write("GCRTS001"); Buffer.from(expected.nonce, "hex").copy(header, 8);
    Buffer.from(expected.requestSha256, "hex").copy(header, 40); digest.copy(header, 72); header.writeUInt32LE(result.length, 104); header.writeUInt32LE(4096, 108);
    const chunk = Buffer.alloc(16); chunk.write("GCRTC001"); chunk.writeUInt32LE(result.length, 12);
    runtime.write(Buffer.concat([header, chunk, result]));
    expect((await read(runtime, 112)).subarray(0, 8).toString()).toBe("GCRTA002");
    expect((await read(runtime, 112)).subarray(0, 8).toString()).toBe("GCRTA003");
  };
  const finish = async () => {
    const bytes = Buffer.alloc(100); Buffer.from(expected.nonce, "hex").copy(bytes); Buffer.from(expected.requestSha256, "hex").copy(bytes, 32);
    digest.copy(bytes, 64); bytes.writeUInt32LE(result.length, 96); expect((await send(35, bytes)).kind).toBe(36);
  };
  return { parent, runtime, control, owner, stop, receipt, prepare, retain, check, finish, stream, send, challenge };
}

describe.skipIf(process.platform !== "win32")("two authenticated helper pipes with the production parent session", () => {
  it("finishes only after input, delivery and retained-result evidence on both pipes", async () => {
    const f = await fixture(); await f.prepare(); await f.retain(); await f.check(2, 3); await f.finish();
    expect(await f.parent.completion).toEqual(f.receipt); expect(f.parent.state.finished).toBe(true);
    expect(f.owner.authorizeInput).toHaveBeenCalledTimes(2); expect(f.owner.readInput).toHaveBeenCalledOnce();
    expect(vi.mocked(f.owner.authorizeDelivery).mock.calls.map(args => args[2])).toEqual([1, 2, 3]);
    expect(f.owner.retain).toHaveBeenCalledOnce(); expect(f.stop.signal.aborted).toBe(false);
  });
  it("preserves retained evidence but refuses completion after control authority is revoked", async () => {
    const f = await fixture(); await f.prepare(); await f.retain();
    vi.mocked(f.owner.authorizeDelivery).mockRejectedValueOnce(new Error("Revoked"));
    await expect(f.check(2, 3)).rejects.toThrow(); await expect(f.parent.completion).rejects.toThrow();
    expect(f.parent.state.retentionConfirmed).toBe(true); expect(f.parent.state.finished).toBe(false);
    expect(f.owner.retain).toHaveBeenCalledOnce(); expect(f.owner.readInput).toHaveBeenCalledOnce();
  });
  it("cancels the runtime reader when its independently authenticated control pipe is lost", async () => {
    const f = await fixture(); f.control.end(); await expect(f.parent.completion).rejects.toThrow();
    expect(f.owner.authorizeRuntime).not.toHaveBeenCalled(); expect(f.owner.retain).not.toHaveBeenCalled();
    expect(f.stop.signal.aborted).toBe(false);
  });
});
