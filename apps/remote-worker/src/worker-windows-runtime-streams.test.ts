import { describe, expect, it, vi } from "vitest";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { WindowsRuntimeParentStreams, type WindowsRuntimeStreamsOwner } from "./worker-windows-runtime-streams.js";

function fixture(timeoutMs = 1000) {
  const f = runtimeResultPagesFixture(0), controller = new AbortController();
  const expected = { ...f.expectation, maxInputBytes: 976, maxOutputBytes: 1952 }, replies: { kind: number; bytes: Buffer }[] = [];
  const data = Buffer.from(Array.from({ length: 976 }, (_, i) => i & 255));
  const owner = { signal: controller.signal, timeoutMs,
    authorizePeer: vi.fn<WindowsRuntimeStreamsOwner["authorizePeer"]>(async () => {}),
    readInput: vi.fn<WindowsRuntimeStreamsOwner["readInput"]>(async () => data),
    authorizeInput: vi.fn<WindowsRuntimeStreamsOwner["authorizeInput"]>(async () => {}),
    consumeOutput: vi.fn<WindowsRuntimeStreamsOwner["consumeOutput"]>(async () => {}),
    reply: vi.fn<WindowsRuntimeStreamsOwner["reply"]>(async (kind, bytes) => { replies.push({ kind, bytes: Buffer.from(bytes) }); }),
  };
  const header = (size: number, sequence: number, count: number, total: number) => {
    const bytes = Buffer.alloc(size); Buffer.from(expected.nonce, "hex").copy(bytes); Buffer.from(expected.requestSha256, "hex").copy(bytes, 32);
    bytes.writeUInt32LE(sequence, 64); bytes.writeUInt32LE(count, 68); bytes.writeBigUInt64LE(BigInt(total), 72); return bytes;
  };
  const poll = (ordinal = 1, sequence = 1, total = 0) => { const bytes = header(88, sequence, 0, total); bytes.writeUInt32LE(ordinal, 80); return bytes; };
  const frame = (sequence = 1, eof = false, total = 976) => {
    const bytes = header(1056, sequence, eof ? 0 : data.length, total); if (!eof) data.copy(bytes, 80); return bytes;
  };
  return { ...f, expected, data, controller, owner, replies, poll, frame, create: () => new WindowsRuntimeParentStreams(expected, f.history, owner) };
}
describe("native parent input and output forwarding", () => {
  it("distinguishes idle from EOF, approves exact binary input and acknowledges both output kinds", async () => {
    const f = fixture(), parent = f.create();
    f.owner.readInput.mockResolvedValueOnce(null).mockResolvedValueOnce(f.data).mockResolvedValueOnce("eof");
    await parent.respond(32, f.poll()); await parent.respond(32, f.poll(2));
    for (const kind of [24, 26]) await parent.respond(kind, f.frame());
    await parent.respond(32, f.poll(3, 2, 976));
    for (const kind of [27, 25]) await parent.respond(kind, f.frame(2, true));
    expect(f.replies.map(r => r.kind)).toEqual([33, 33, 34, 34, 33, 34, 34]);
    expect(f.replies[0]!.bytes.subarray(88).every(b => b === 0)).toBe(true);
    expect(f.replies[1]!.bytes.subarray(92)).toEqual(f.frame());
    expect(f.replies[4]!.bytes.readUInt32LE(88)).toBe(2);
    expect(f.replies[4]!.bytes.subarray(92)).toEqual(f.frame(2, true));
    expect(f.owner.readInput.mock.calls.map(call => call[0])).toEqual([976, 976, 0]);
    expect(f.owner.authorizeInput.mock.calls.map(call => call[2])).toEqual([
      { sequence: 1, total: 976, eof: false, bytes: f.data }, { sequence: 2, total: 976, eof: true, bytes: Buffer.alloc(0) },
    ]);
    expect(f.owner.consumeOutput.mock.calls.map(call => call[2])).toEqual(["stdout", "stderr", "stderr", "stdout"]);
    expect(f.owner.authorizePeer).toHaveBeenCalledTimes(21); expect(f.controller.signal.aborted).toBe(false);
    for (const [index, kind] of [[2, 24], [3, 26], [5, 27], [6, 25]]) expect(f.replies[index!]!.bytes.readUInt32LE(0)).toBe(kind);
  });
  it.each(["nonce", "digest", "sequence", "count", "total", "ordinal", "reserved", "size", "kind", "cancel"])("rejects invalid input poll %s before the source", async mode => {
    const f = fixture(), parent = f.create(); let bytes = f.poll();
    const offsets: Record<string, number> = { nonce: 0, digest: 32, sequence: 64, count: 68, total: 72, ordinal: 80, reserved: 84 };
    if (mode in offsets) bytes[offsets[mode]!] = bytes[offsets[mode]!]! ^ 1;
    if (mode === "size") bytes = bytes.subarray(1);
    if (mode === "cancel") f.controller.abort();
    await expect(parent.respond(mode === "kind" ? 33 : 32, bytes)).rejects.toThrow();
    await expect(parent.respond(24, f.frame())).rejects.toThrow();
    expect(f.owner.readInput).not.toHaveBeenCalled(); expect(f.owner.authorizePeer).not.toHaveBeenCalled(); expect(f.replies).toHaveLength(0);
  });
  it.each(["nonce", "digest", "sequence", "count", "total", "padding", "eof_data", "empty_data", "huge_total"])("rejects invalid output %s before consumption", async mode => {
    const f = fixture(), parent = f.create(); let bytes = f.frame(), kind = 24;
    if (mode === "nonce") bytes[0] = bytes[0]! ^ 1;
    if (mode === "digest") bytes[32] = bytes[32]! ^ 1;
    if (mode === "sequence") bytes.writeUInt32LE(2, 64);
    if (mode === "count") bytes.writeUInt32LE(977, 68);
    if (mode === "total") bytes.writeBigUInt64LE(977n, 72);
    if (mode === "padding") { bytes.writeUInt32LE(1, 68); bytes.writeBigUInt64LE(1n, 72); }
    if (mode === "eof_data") kind = 25;
    if (mode === "empty_data") bytes = f.frame(1, true, 0);
    if (mode === "huge_total") bytes.writeBigUInt64LE(0xffffffffffffffffn, 72);
    await expect(parent.respond(kind, bytes)).rejects.toThrow();
    expect(f.owner.consumeOutput).not.toHaveBeenCalled(); expect(f.replies).toHaveLength(0);
  });
  it.each(["empty", "oversize", "mutated", "denied", "cancelled", "reentrant"])("withholds input after %s source approval", async mode => {
    const f = fixture(), parent = f.create();
    if (mode === "empty") f.owner.readInput.mockResolvedValueOnce(Buffer.alloc(0));
    if (mode === "oversize") f.owner.readInput.mockResolvedValueOnce(Buffer.alloc(977));
    if (mode === "mutated") f.owner.authorizeInput.mockImplementationOnce(async (_expected, _history, frame) => { frame.bytes.fill(9); });
    if (mode === "denied") f.owner.authorizeInput.mockRejectedValueOnce(new Error("Denied"));
    if (mode === "cancelled") f.owner.authorizeInput.mockImplementationOnce(async () => { f.controller.abort(); });
    if (mode === "reentrant") f.owner.authorizeInput.mockImplementationOnce(async () => { await expect(parent.respond(26, f.frame())).rejects.toThrow(); });
    await expect(parent.respond(32, f.poll())).rejects.toThrow(); expect(f.replies).toHaveLength(0);
    await expect(parent.respond(32, f.poll())).rejects.toThrow(); expect(f.owner.readInput).toHaveBeenCalledTimes(1);
  });
  it("rejects input after EOF and cumulative output across both streams", async () => {
    const f = fixture(), parent = f.create(); f.owner.readInput.mockResolvedValueOnce("eof");
    await parent.respond(32, f.poll()); await expect(parent.respond(32, f.poll(2, 2))).rejects.toThrow();
    expect(f.owner.readInput).toHaveBeenCalledTimes(1);
    const out = fixture(), other = out.create(); await other.respond(24, out.frame()); await other.respond(26, out.frame());
    await expect(other.respond(24, out.frame(2, false, 1952))).rejects.toThrow(); expect(out.owner.consumeOutput).toHaveBeenCalledTimes(2);
  });
  it.each([24, 25, 26, 27])("rejects repeated sequence and EOF for output %i", async kind => {
    const f = fixture(), parent = f.create(), eof = kind === 25 || kind === 27, bytes = f.frame(1, eof, eof ? 0 : 976);
    await parent.respond(kind, bytes); await expect(parent.respond(kind, bytes)).rejects.toThrow(); expect(f.owner.consumeOutput).toHaveBeenCalledTimes(1);
  });
  it.each(["consume", "peer_after", "write", "cancel_after", "reentrant"])("does not repeat output after %s failure", async mode => {
    const f = fixture(), parent = f.create();
    if (mode === "consume") f.owner.consumeOutput.mockRejectedValueOnce(new Error("Denied"));
    if (mode === "peer_after") f.owner.authorizePeer.mockResolvedValueOnce().mockRejectedValueOnce(new Error("Revoked"));
    if (mode === "write") f.owner.reply.mockRejectedValueOnce(new Error("Unknown write outcome"));
    if (mode === "cancel_after") f.owner.reply.mockImplementationOnce(async () => { f.controller.abort(); });
    if (mode === "reentrant") f.owner.consumeOutput.mockImplementationOnce(async () => { await expect(parent.respond(32, f.poll())).rejects.toThrow(); });
    await expect(parent.respond(24, f.frame())).rejects.toThrow();
    await expect(parent.respond(24, f.frame())).rejects.toThrow(); expect(f.owner.consumeOutput).toHaveBeenCalledTimes(1);
  });
  it.each(["input", "output"])("cancels a stalled %s owner without a late reply", async kind => {
    const f = fixture(30), parent = f.create(); let finish: (() => void) | undefined;
    if (kind === "input") f.owner.readInput.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return f.data; });
    else f.owner.consumeOutput.mockImplementationOnce(async () => new Promise<void>(resolve => { finish = resolve; }));
    await expect(parent.respond(kind === "input" ? 32 : 24, kind === "input" ? f.poll() : f.frame())).rejects.toThrow();
    finish!(); await new Promise(resolve => setImmediate(resolve)); expect(f.replies).toHaveLength(0); expect(f.controller.signal.aborted).toBe(false);
  });
  it("freezes output bytes before callbacks and keeps receipts bound to the original frame", async () => {
    const f = fixture(), parent = f.create(), bytes = f.frame(), original = Buffer.from(bytes);
    f.owner.authorizePeer.mockImplementationOnce(async () => { bytes.fill(0); });
    f.owner.consumeOutput.mockImplementationOnce(async (_expected, _history, _stream, frame) => { frame.bytes.fill(7); });
    await parent.respond(24, bytes); expect(f.replies[0]!.bytes.subarray(4)).toEqual(original.subarray(0, 80));
  });
  it("reauthorizes each exact queue attempt without reading or resending input", async () => {
    const f = fixture(), parent = f.create(), control = new AbortController();
    await parent.respond(32, f.poll());
    await parent.reauthorizeInput(21, f.frame(), control.signal);
    await parent.reauthorizeInput(21, f.frame(), control.signal);
    expect(f.owner.authorizeInput).toHaveBeenCalledTimes(3);
    expect(f.owner.readInput).toHaveBeenCalledTimes(1); expect(f.replies).toHaveLength(1);
    f.owner.readInput.mockResolvedValueOnce("eof"); await parent.respond(32, f.poll(2, 2, 976));
    await parent.reauthorizeInput(22, f.frame(2, true), control.signal);
    expect(parent.state.inputBytes).toBe(976); expect(parent.state.inputEnded).toBe(true);
    expect(f.owner.authorizeInput).toHaveBeenCalledTimes(5);
    expect(f.owner.readInput).toHaveBeenCalledTimes(2); expect(f.replies).toHaveLength(2);
  });
  it.each(["unissued", "changed", "nonce", "digest", "sequence", "total", "kind", "stale", "cancelled"])("rejects %s control input before another canonical grant", async mode => {
    const f = fixture(), parent = f.create(), control = new AbortController(), bytes = f.frame();
    if (mode !== "unissued") await parent.respond(32, f.poll());
    if (mode === "stale") { f.owner.readInput.mockResolvedValueOnce("eof"); await parent.respond(32, f.poll(2, 2, 976)); }
    const offsets: Record<string, number> = { changed: 80, nonce: 0, digest: 32, sequence: 64, total: 72 };
    if (mode in offsets) bytes[offsets[mode]!] = bytes[offsets[mode]!]! ^ 1;
    if (mode === "cancelled") control.abort();
    const grants = f.owner.authorizeInput.mock.calls.length;
    await expect(parent.reauthorizeInput(mode === "kind" ? 22 : 21, bytes, control.signal)).rejects.toThrow();
    await expect(parent.respond(24, f.frame())).rejects.toThrow();
    expect(f.owner.authorizeInput).toHaveBeenCalledTimes(grants); expect(f.owner.consumeOutput).not.toHaveBeenCalled();
    expect(f.controller.signal.aborted).toBe(false);
  });
  it.each(["revoked", "mutated", "cancelled", "reentrant", "next_poll"])("fences both control and stream after %s input reauthorization", async mode => {
    const f = fixture(), parent = f.create(), control = new AbortController(); await parent.respond(32, f.poll());
    f.owner.authorizeInput.mockImplementationOnce(async (_expected, _history, frame) => {
      if (mode === "revoked") throw new Error("Revoked");
      if (mode === "mutated") frame.bytes.fill(7);
      if (mode === "cancelled") control.abort();
      if (mode === "reentrant") await expect(parent.reauthorizeInput(21, f.frame(), control.signal)).rejects.toThrow();
      if (mode === "next_poll") await expect(parent.respond(32, f.poll(2, 2, 976))).rejects.toThrow();
    });
    await expect(parent.reauthorizeInput(21, f.frame(), control.signal)).rejects.toThrow();
    await expect(parent.reauthorizeInput(21, f.frame(), control.signal)).rejects.toThrow();
    await expect(parent.respond(24, f.frame())).rejects.toThrow();
    expect(f.owner.authorizeInput).toHaveBeenCalledTimes(2); expect(f.owner.readInput).toHaveBeenCalledTimes(1); expect(f.replies).toHaveLength(1);
  });
  it("permits a fast control check during the issued frame write", async () => {
    const f = fixture(), parent = f.create(), control = new AbortController();
    f.owner.reply.mockImplementationOnce(async (_kind, bytes) => { await parent.reauthorizeInput(21, bytes.subarray(92), control.signal); });
    await parent.respond(32, f.poll());
    expect(f.owner.authorizeInput).toHaveBeenCalledTimes(2); expect(f.owner.readInput).toHaveBeenCalledTimes(1);
  });
  it("keeps control bytes frozen and permits output while input permission is pending", async () => {
    const f = fixture(), parent = f.create(), control = new AbortController(); await parent.respond(32, f.poll());
    const supplied = f.frame();
    f.owner.authorizePeer.mockImplementationOnce(async () => { supplied.fill(0); });
    f.owner.authorizeInput.mockImplementationOnce(async () => { await parent.respond(24, f.frame()); });
    await parent.reauthorizeInput(21, supplied, control.signal);
    expect(f.owner.consumeOutput).toHaveBeenCalledTimes(1); expect(f.owner.authorizeInput).toHaveBeenCalledTimes(2);
  });
  it("times out a stalled control owner without granting late permission", async () => {
    const f = fixture(60), parent = f.create(), control = new AbortController(); await parent.respond(32, f.poll());
    let finish: (() => void) | undefined;
    f.owner.authorizeInput.mockImplementationOnce(async () => new Promise<void>(resolve => { finish = resolve; }));
    await expect(parent.reauthorizeInput(21, f.frame(), control.signal)).rejects.toThrow();
    finish!(); await new Promise(resolve => setImmediate(resolve));
    await expect(parent.respond(24, f.frame())).rejects.toThrow(); expect(f.replies).toHaveLength(1);
    expect(f.controller.signal.aborted).toBe(false); expect(control.signal.aborted).toBe(false);
  });
});
