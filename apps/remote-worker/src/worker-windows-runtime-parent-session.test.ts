import { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { readRemoteWorkerRuntimeResult } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { WindowsRuntimeParentSession, createWindowsRuntimeGatewaySession, type WindowsRuntimeParentSessionOwner } from "./worker-windows-runtime-parent-session.js";
import { uploadWorkerRuntimeResult } from "./worker-runtime-result-client.js";
import type { RouteContext } from "./connected-worker-routes.js";
vi.mock("./worker-runtime-result-client.js", () => ({ uploadWorkerRuntimeResult: vi.fn() }));

function fixture(timeoutMs = 2000, maximum = false, gateway = false, files = false, batch = false) {
  const f = runtimeResultPagesFixture(maximum ? 19996 : 22), controller = new AbortController();
  const replies: Buffer[] = []; let waiter: ((bytes: Buffer) => void) | undefined;
  const channel = new Duplex({ read() {}, write(bytes, _encoding, done) {
    const copy = Buffer.from(bytes); if (waiter) { const receive = waiter; waiter = undefined; receive(copy); } else replies.push(copy); done();
  } });
  const receipt = f.response(null, true).record!;
  const owner = { signal: controller.signal, timeoutMs,
    authorizePeer: vi.fn<WindowsRuntimeParentSessionOwner["authorizePeer"]>(async () => {}),
    authorizeRuntime: vi.fn<WindowsRuntimeParentSessionOwner["authorizeRuntime"]>(async () => {}),
    authorizeDelivery: vi.fn<WindowsRuntimeParentSessionOwner["authorizeDelivery"]>(async () => {}),
    authorizeRetention: vi.fn<WindowsRuntimeParentSessionOwner["authorizeRetention"]>(async () => {}),
    readInput: vi.fn<WindowsRuntimeParentSessionOwner["readInput"]>(async () => "eof"),
    authorizeInput: vi.fn<WindowsRuntimeParentSessionOwner["authorizeInput"]>(async () => {}),
    consumeOutput: vi.fn<WindowsRuntimeParentSessionOwner["consumeOutput"]>(async () => {}),
    retain: vi.fn<WindowsRuntimeParentSessionOwner["retain"]>(async () => receipt),
    ...(files ? { authorizeFile: vi.fn<NonNullable<WindowsRuntimeParentSessionOwner["authorizeFile"]>>(async () => {}) } : {}),
    ...(batch ? { fileStaging: { paths: ["outputs/result.txt"], maximumFileBytes: 1024, maximumTotalBytes: 1024 } } : {}),
  };
  const wire = (kind: number, payload: Buffer) => {
    const header = Buffer.alloc(16); header.write("GCCELL01"); header.writeUInt32LE(kind, 8); header.writeUInt32LE(payload.length, 12); return Buffer.concat([header, payload]);
  };
  const challenge = (ordinal = 1) => {
    const bytes = Buffer.alloc(104); Buffer.from(f.expectation.nonce, "hex").copy(bytes); bytes.writeUInt32LE(ordinal, 32); bytes.writeUInt32LE(21, 36);
    Buffer.from(f.expectation.checkpointSha256, "hex").copy(bytes, 40); Buffer.from(f.expectation.requestSha256, "hex").copy(bytes, 72); return bytes;
  };
  const stream = (size = 1056) => {
    const bytes = Buffer.alloc(size); Buffer.from(f.expectation.nonce, "hex").copy(bytes); Buffer.from(f.expectation.requestSha256, "hex").copy(bytes, 32);
    bytes.writeUInt32LE(1, 64); if (size === 88) bytes.writeUInt32LE(1, 80); return bytes;
  };
  const terminal = (mismatch = false) => {
    const result = Buffer.from(f.bytes); if (mismatch) result.writeBigUInt64LE(1n, 160);
    const digest = createHash("sha256").update("goatcitadel.worker-runtime-result.v1\0").update(result).digest();
    const header = Buffer.alloc(112); header.write("GCRTS001"); Buffer.from(f.expectation.nonce, "hex").copy(header, 8);
    Buffer.from(f.expectation.requestSha256, "hex").copy(header, 40); digest.copy(header, 72); header.writeUInt32LE(result.length, 104); header.writeUInt32LE(4096, 108);
    const frames = [header];
    for (let offset = 0; offset < result.length; offset += 4096) {
      const bytes = result.subarray(offset, offset + 4096), chunk = Buffer.alloc(16); chunk.write("GCRTC001"); chunk.writeUInt32LE(offset, 8); chunk.writeUInt32LE(bytes.length, 12);
      frames.push(chunk, bytes);
    }
    return Buffer.concat(frames);
  };
  const finish = () => {
    const bytes = Buffer.alloc(100); Buffer.from(f.expectation.nonce, "hex").copy(bytes); Buffer.from(f.expectation.requestSha256, "hex").copy(bytes, 32);
    Buffer.from(receipt.resultSha256, "hex").copy(bytes, 64); bytes.writeUInt32LE(receipt.byteLength, 96); return bytes;
  };
  const lease = { registryWorkspaceId: f.history.registryWorkspaceId, assignmentId: f.history.assignmentId,
    assignmentGeneration: f.history.assignmentGeneration, leaseRevision: f.history.leaseRevision, leaseToken: "private-lease" };
  const parent = gateway ? createWindowsRuntimeGatewaySession(channel, {} as RouteContext, lease, f.expectation, f.history, owner) :
    new WindowsRuntimeParentSession(channel, f.expectation, f.history, owner);
  const done = parent.run().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  const readReply = async () => {
    if (replies.length) return replies.shift()!;
    return Promise.race([new Promise<Buffer>(resolve => { waiter = resolve; }), done.then(result => { throw result.error ?? new Error("Finished before reply"); })]);
  };
  const send = async (kind: number, bytes: Buffer) => { channel.push(wire(kind, bytes)); return readReply(); };
  const prepare = async () => {
    expect((await send(32, stream(88))).readUInt32LE(8)).toBe(33);
    expect((await send(19, challenge())).readUInt32LE(8)).toBe(20);
    expect((await send(25, stream())).readUInt32LE(8)).toBe(34);
    expect((await send(27, stream())).readUInt32LE(8)).toBe(34);
    expect((await send(30, challenge())).readUInt32LE(8)).toBe(31);
  };
  return { ...f, receipt, lease, channel, controller, owner, parent, done, wire, challenge, stream, terminal, finish, readReply, send, prepare, replies };
}
function controlFixture(f: ReturnType<typeof fixture>) {
  const replies: Buffer[] = []; let waiter: ((bytes: Buffer) => void) | undefined;
  const channel = new Duplex({ read() {}, write(bytes, _encoding, done) {
    const copy = Buffer.from(bytes); if (waiter) { const receive = waiter; waiter = undefined; receive(copy); } else replies.push(copy); done();
  } });
  const done = f.parent.runControl(channel).then(() => ({ error: undefined }), error => ({ error }));
  const request = (action: number, ordinal = 1, kind = 22, input = f.stream()) => {
    const bytes = Buffer.alloc(1168); f.challenge(ordinal).copy(bytes); bytes.writeUInt32LE(action, 104);
    if (action === 1) { bytes.writeUInt32LE(kind, 108); input.copy(bytes, 112); }
    return bytes;
  };
  const readReply = async () => {
    if (replies.length) return replies.shift()!;
    return Promise.race([new Promise<Buffer>(resolve => { waiter = resolve; }), done.then(result => { throw result.error ?? new Error("Control finished before reply"); })]);
  };
  const send = async (bytes: Buffer) => { channel.push(f.wire(37, bytes)); return readReply(); };
  return { channel, replies, done, request, send, readReply };
}

function fileControl(f: ReturnType<typeof fixture>, c: ReturnType<typeof controlFixture>, ordinal = 2) {
  const result = readRemoteWorkerRuntimeResult(f.bytes.toString("hex"), f.expectation, f.history);
  const file = result.inventory!.entries.find(entry => !entry.directory && entry.logicalFileBytes === 0)!;
  const body = Buffer.alloc(1060), path = Buffer.from("outputs/result.txt");
  Buffer.from(result.resultSha256, "hex").copy(body); Buffer.from(result.inventory!.directoryIdentityHex[3]!, "hex").copy(body, 32);
  Buffer.from(file.identityHex, "hex").copy(body, 56); body.writeBigUInt64LE(BigInt(file.allocatedBytes), 88);
  body.writeUInt32LE(1024, 96); body.writeUInt32LE(path.length, 100); path.copy(body, 104);
  const challenge = c.request(3, ordinal); body.copy(challenge, 108); return challenge;
}

function fileBatch(f: ReturnType<typeof fixture>) {
  const result = readRemoteWorkerRuntimeResult(f.bytes.toString("hex"), f.expectation, f.history);
  const file = result.inventory!.entries.find(entry => !entry.directory && entry.logicalFileBytes === 0)!;
  const manifest = Buffer.alloc(132); manifest.write("GCFSL001");
  Buffer.from(f.expectation.nonce, "hex").copy(manifest, 8); Buffer.from(f.expectation.requestSha256, "hex").copy(manifest, 40);
  Buffer.from(result.resultSha256, "hex").copy(manifest, 72); manifest.writeUInt32LE(1, 104); Buffer.from(file.identityHex, "hex").copy(manifest, 108);
  const record = Buffer.alloc(200); record.write("GCRFA001"); manifest.subarray(8, 104).copy(record, 8);
  Buffer.from(result.inventory!.directoryIdentityHex[3]!, "hex").copy(record, 104); Buffer.from(file.identityHex, "hex").copy(record, 128);
  record.writeBigUInt64LE(BigInt(file.allocatedBytes), 160); createHash("sha256").update(Buffer.alloc(0)).digest().copy(record, 168);
  const header = Buffer.alloc(112); header.write("GCFHS001"); manifest.subarray(8, 72).copy(header, 8);
  createHash("sha256").update(record).digest().copy(header, 72); header.writeUInt32LE(200, 104); header.writeUInt32LE(4096, 108);
  const chunk = Buffer.alloc(16); chunk.write("GCFHC001"); chunk.writeUInt32LE(200, 12);
  return { manifest, record, content: Buffer.concat([header, chunk, record]) };
}

describe("exclusive protected-parent runtime dispatcher", () => {
  it.each(["success", "missing_batch", "duplicate", "denied", "changed_content", "cancel_after_batch"])("gates outer finish on the complete file batch: %s", async mode => {
    const f = fixture(5000, false, false, true, true), c = controlFixture(f), batch = fileBatch(f);
    await f.prepare(); await c.send(c.request(2));
    f.channel.push(f.terminal()); await f.readReply(); await f.readReply();
    if (mode === "missing_batch") {
      f.channel.push(f.wire(35, f.finish())); expect((await f.done).error).toBeDefined();
    } else {
      if (mode === "denied") f.owner.authorizeFile!.mockRejectedValueOnce(new Error("No file grant"));
      f.channel.push(batch.manifest);
      if (mode !== "denied") {
        expect((await f.readReply()).subarray(0, 8).toString()).toBe("GCFSA001");
        // Secondary file checks remain live while the primary pipe awaits data.
        expect((await c.send(fileControl(f, c))).readUInt32LE(8)).toBe(38);
        if (mode === "changed_content") batch.content[128] = 0;
        f.channel.push(batch.content);
        if (mode !== "changed_content") {
          expect((await f.readReply()).subarray(0, 8).toString()).toBe("GCFHA001");
          expect((await f.readReply()).subarray(0, 8).toString()).toBe("GCFSD001");
          if (mode === "duplicate") f.channel.push(batch.manifest);
          else if (mode === "cancel_after_batch") f.controller.abort();
          else {
            await f.send(35, f.finish()); expect((await f.done).value).toEqual(f.receipt);
            const files = f.parent.takeFiles(); expect(files).toHaveLength(1); expect(files[0]!.record).toEqual(batch.record);
            expect(files[0]!.selection.logicalPath).toBe("outputs/result.txt"); files[0]!.record.fill(0);
          }
        }
      }
      if (mode !== "success") expect((await f.done).error).toBeDefined();
    }
    await c.done;
    expect(f.owner.retain).toHaveBeenCalledOnce(); expect(f.parent.state.retentionConfirmed).toBe(true);
    if (mode !== "success") { expect(f.parent.state.finished).toBe(false); expect(() => f.parent.takeFiles()).toThrow(); }
    c.channel.destroy(); f.channel.destroy();
  });
  it("refuses a file-bearing parent without a disclosure owner before reading runtime input", async () => {
    const f = fixture(5000, false, false, false, true);
    expect((await f.done).error).toBeDefined(); expect(f.owner.retain).not.toHaveBeenCalled(); f.channel.destroy();
  });
  it.each([false, true])("waits for actual retention before a concurrent file grant (retention fails=%s)", async fails => {
    const f = fixture(5000, false, false, true), c = controlFixture(f);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.owner.retain.mockImplementationOnce(async () => {
      entered(); await held;
      if (fails) throw new Error("Retention refused");
      return f.receipt;
    });
    await f.prepare(); await c.send(c.request(2));
    f.channel.push(f.terminal()); await f.readReply(); await started;
    c.channel.push(f.wire(37, fileControl(f, c)));
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(f.parent.state.phase).toBe("retaining");
    expect(f.owner.authorizeFile).not.toHaveBeenCalled(); expect(c.replies).toHaveLength(0);
    release();
    if (fails) {
      expect((await f.done).error).toBeDefined(); expect((await c.done).error).toBeDefined();
      expect(f.owner.authorizeFile).not.toHaveBeenCalled(); expect(c.replies).toHaveLength(0);
    } else {
      await f.readReply(); expect((await c.readReply()).readUInt32LE(8)).toBe(38);
      expect(f.owner.authorizeFile).toHaveBeenCalledOnce();
      await f.send(35, f.finish()); expect((await f.done).value).toEqual(f.receipt);
      expect((await c.done).error).toBeUndefined();
    }
    c.channel.destroy(); f.channel.destroy();
  });
  it.each([false, true])("requires a separate current file grant after terminal retention (revoke=%s)", async revoke => {
    const f = fixture(5000, false, false, true), c = controlFixture(f);
    await f.prepare(); await c.send(c.request(2));
    f.channel.push(f.terminal()); await f.readReply(); await f.readReply();
    const deliveryCalls = f.owner.authorizeDelivery.mock.calls.length, request = fileControl(f, c);
    const reply = await c.send(request);
    expect(reply.readUInt32LE(8)).toBe(38); expect(reply.subarray(16)).toEqual(request);
    expect(f.owner.authorizeFile).toHaveBeenCalledOnce();
    expect(f.owner.authorizeFile!.mock.calls[0]![2]).toMatchObject({ logicalPath: "outputs/result.txt", maximumBytes: 1024,
      logicalFileBytes: 0, assignmentId: f.history.assignmentId, resultSha256: f.receipt.resultSha256 });
    expect(f.owner.authorizeDelivery).toHaveBeenCalledTimes(deliveryCalls);
    if (revoke) {
      f.owner.authorizeFile!.mockRejectedValueOnce(new Error("File permission revoked"));
      c.channel.push(f.wire(37, fileControl(f, c, 3)));
      expect((await c.done).error).toBeDefined(); expect((await f.done).error).toBeDefined();
      expect(f.parent.state.retentionConfirmed).toBe(true); expect(f.parent.state.finished).toBe(false);
      expect(c.replies).toHaveLength(0);
    } else {
      expect((await f.send(35, f.finish())).readUInt32LE(8)).toBe(36);
      expect((await f.done).value).toEqual(f.receipt); expect((await c.done).error).toBeUndefined();
    }
    expect(f.owner.retain).toHaveBeenCalledOnce(); c.channel.destroy(); f.channel.destroy();
  });
  it.each(["missing_owner", "early", "result", "accounting", "padding", "cancelled"])("refuses %s file permission without falling back to delivery", async mode => {
    const f = fixture(5000, false, false, mode !== "missing_owner"), c = controlFixture(f);
    await f.prepare(); await c.send(c.request(2));
    if (mode !== "early") { f.channel.push(f.terminal()); await f.readReply(); await f.readReply(); }
    const calls = f.owner.authorizeDelivery.mock.calls.length, request = fileControl(f, c);
    if (mode === "result") request[108] = request[108]! ^ 1;
    if (mode === "accounting") request[188] = 1;
    if (mode === "padding") request[1167] = 1;
    if (mode === "cancelled") f.owner.authorizeFile!.mockImplementationOnce(async () => { f.controller.abort(); });
    c.channel.push(f.wire(37, request));
    expect((await c.done).error).toBeDefined(); expect((await f.done).error).toBeDefined();
    expect(f.owner.authorizeDelivery).toHaveBeenCalledTimes(calls); expect(c.replies).toHaveLength(0);
    if (mode !== "missing_owner") expect(f.owner.authorizeFile).toHaveBeenCalledTimes(mode === "cancelled" ? 1 : 0);
    expect(f.parent.state.finished).toBe(false); c.channel.destroy(); f.channel.destroy();
  });
  it("uses the protected Gateway uploader with frozen assignment custody", async () => {
    const f = fixture(2000, false, true); vi.mocked(uploadWorkerRuntimeResult).mockResolvedValueOnce(f.response(null, true));
    const assignment = f.lease.assignmentId; f.lease.assignmentId = "changed";
    await f.prepare(); f.channel.push(f.terminal()); await f.readReply(); await f.readReply(); await f.send(30, f.challenge(2)); await f.send(35, f.finish());
    expect((await f.done).value).toEqual(f.receipt); expect(f.owner.retain).not.toHaveBeenCalled();
    expect(uploadWorkerRuntimeResult).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadWorkerRuntimeResult).mock.calls[0]![1].assignmentId).toBe(assignment);
    expect(vi.mocked(uploadWorkerRuntimeResult).mock.calls[0]![2]).toBe(f.resultHex); f.channel.destroy();
  });
  it.each([false, true])("retains the exact result, serves post-retention checks and waits for finish (maximum=%s)", async maximum => {
    const f = fixture(5000, maximum); await f.prepare(); f.channel.push(f.terminal());
    expect((await f.readReply()).subarray(0, 8).toString()).toBe("GCRTA002");
    expect((await f.readReply()).subarray(0, 8).toString()).toBe("GCRTA003");
    expect(f.parent.state.cleanupVerified).toBe(false);
    expect((await f.send(30, f.challenge(2))).readUInt32LE(8)).toBe(31);
    const finish = await f.send(35, f.finish()); expect(finish.readUInt32LE(8)).toBe(36); expect(finish.subarray(16)).toEqual(f.finish());
    expect(await f.done).toEqual({ value: f.receipt, error: undefined });
    expect(f.owner.retain).toHaveBeenCalledTimes(1); expect(f.owner.retain.mock.calls[0]![0]).toBe(f.resultHex);
    expect(f.owner.authorizeDelivery.mock.calls.map(args => args[2])).toEqual([1, 2]);
    expect(f.parent.state).toEqual({ phase: "finished", retentionAttempted: true, retentionConfirmed: true, finished: true, cleanupVerified: true });
    expect(f.channel.listenerCount("readable")).toBe(0); expect(f.controller.signal.aborted).toBe(false); f.channel.destroy();
  });
  it("accepts fragmented frames without a second reader", async () => {
    const f = fixture(), bytes = f.wire(19, f.challenge());
    for (let offset = 0; offset < bytes.length; offset += 3) { f.channel.push(bytes.subarray(offset, offset + 3)); await new Promise(resolve => setImmediate(resolve)); }
    expect((await f.readReply()).readUInt32LE(8)).toBe(20);
    f.controller.abort(); expect((await f.done).error).toBeDefined(); expect(f.channel.listenerCount("readable")).toBe(0); f.channel.destroy();
  });
  it.each(["output", "delivery", "result", "finish", "wrong_kind", "wrong_size", "wrong_magic", "high_bit"])("refuses premature or malformed %s", async mode => {
    const f = fixture(); let bytes = f.wire(19, f.challenge());
    if (mode === "output") bytes = f.wire(25, f.stream());
    if (mode === "delivery") bytes = f.wire(30, f.challenge());
    if (mode === "result") bytes = f.terminal();
    if (mode === "finish") bytes = f.wire(35, f.finish());
    if (mode === "wrong_kind") bytes.writeUInt32LE(20, 8);
    if (mode === "wrong_size") bytes.writeUInt32LE(0xffffffff, 12);
    if (mode === "wrong_magic") bytes[0] = 0;
    if (mode === "high_bit") bytes[0] = bytes[0]! | 0x80;
    f.channel.push(bytes); expect((await f.done).error).toBeDefined(); expect(f.owner.retain).not.toHaveBeenCalled();
    expect(f.owner.consumeOutput).not.toHaveBeenCalled(); expect(f.owner.authorizeDelivery).not.toHaveBeenCalled(); f.channel.destroy();
  });
  it.each(["stream", "runtime", "replay_delivery", "counter_mismatch", "denied_retention", "cancelled_commit", "reentrant"])("fences %s after stream completion", async mode => {
    const f = fixture(); await f.prepare();
    if (mode === "denied_retention") f.owner.authorizeRetention.mockRejectedValueOnce(new Error("Denied"));
    if (mode === "cancelled_commit") f.owner.retain.mockImplementationOnce(async () => { f.controller.abort(); return f.receipt; });
    if (mode === "reentrant") f.owner.retain.mockImplementationOnce(async () => { await expect(f.parent.run()).rejects.toThrow(); return f.receipt; });
    f.channel.push(mode === "stream" ? f.wire(25, f.stream()) : mode === "runtime" ? f.wire(19, f.challenge(2)) :
      mode === "replay_delivery" ? f.wire(30, f.challenge()) : f.terminal(mode === "counter_mismatch"));
    expect((await f.done).error).toBeDefined();
    expect(f.owner.retain).toHaveBeenCalledTimes(["cancelled_commit", "reentrant"].includes(mode) ? 1 : 0);
    expect(f.parent.state.finished).toBe(false); await expect(f.parent.run()).rejects.toThrow(); f.channel.destroy();
  });
  it.each(["wrong_finish", "second_result", "runtime", "extra_finish", "denied_finish"])("preserves retained evidence but refuses %s", async mode => {
    const f = fixture(); await f.prepare(); f.channel.push(f.terminal()); await f.readReply(); await f.readReply();
    await f.send(30, f.challenge(2));
    let bytes = f.wire(35, f.finish());
    if (mode === "wrong_finish") bytes[16 + 64] = bytes[16 + 64]! ^ 1;
    if (mode === "second_result") bytes = f.terminal();
    if (mode === "runtime") bytes = f.wire(19, f.challenge(2));
    if (mode === "extra_finish") bytes = Buffer.concat([bytes, Buffer.from([1])]);
    if (mode === "denied_finish") f.owner.authorizeRetention.mockRejectedValueOnce(new Error("Revoked"));
    f.channel.push(bytes); expect((await f.done).error).toBeDefined();
    expect(f.owner.retain).toHaveBeenCalledTimes(1); expect(f.parent.state.retentionConfirmed).toBe(true); expect(f.parent.state.finished).toBe(false); f.channel.destroy();
  });
  it("refuses competing readers without taking their listeners", async () => {
    const f = runtimeResultPagesFixture(0), channel = new Duplex({ read() {}, write(_bytes, _encoding, done) { done(); } });
    const reader = () => {}; channel.on("readable", reader);
    const parent = new WindowsRuntimeParentSession(channel, f.expectation, f.history, { signal: new AbortController().signal, timeoutMs: 100 } as WindowsRuntimeParentSessionOwner);
    await expect(parent.run()).rejects.toThrow(); expect(channel.listeners("readable")).toContain(reader); channel.destroy();
  });
  it("bounds an idle/stalled connection and cleans up only its own listeners", async () => {
    const f = fixture(30); f.channel.push(Buffer.from("G")); expect((await f.done).error).toBeDefined();
    expect(f.channel.listenerCount("readable")).toBe(0); expect(f.controller.signal.aborted).toBe(false); f.channel.destroy();
  });
  it("runs exact input and delivery control alongside output and maximum result retention", async () => {
    const f = fixture(5000, true), c = controlFixture(f);
    await f.send(32, f.stream(88));
    for (const ordinal of [1, 2]) {
      const bytes = c.request(1, ordinal), reply = await c.send(bytes);
      expect(reply.readUInt32LE(8)).toBe(38); expect(reply.subarray(16)).toEqual(bytes);
    }
    expect(f.owner.authorizeInput).toHaveBeenCalledTimes(3); expect(f.owner.readInput).toHaveBeenCalledOnce();
    await f.send(19, f.challenge()); await f.send(25, f.stream());
    let consume: (() => void) | undefined;
    f.owner.consumeOutput.mockImplementationOnce(async () => new Promise<void>(resolve => { consume = resolve; }));
    const pendingDelivery = c.send(c.request(2, 3));
    const pendingOutput = f.send(27, f.stream());
    await vi.waitFor(() => expect(consume).toBeDefined());
    expect(f.owner.authorizeDelivery).not.toHaveBeenCalled(); expect(c.replies).toHaveLength(0);
    consume!(); expect((await pendingOutput).readUInt32LE(8)).toBe(34);
    expect((await pendingDelivery).readUInt32LE(8)).toBe(38);
    await f.send(30, f.challenge());
    let retain: (() => void) | undefined;
    f.owner.retain.mockImplementationOnce(async () => { await new Promise<void>(resolve => { retain = resolve; }); return f.receipt; });
    f.channel.push(f.terminal()); expect((await f.readReply()).subarray(0, 8).toString()).toBe("GCRTA002");
    await vi.waitFor(() => expect(retain).toBeDefined());
    expect((await c.send(c.request(2, 4))).readUInt32LE(8)).toBe(38);
    retain!(); expect((await f.readReply()).subarray(0, 8).toString()).toBe("GCRTA003");
    expect((await c.send(c.request(2, 5))).readUInt32LE(8)).toBe(38);
    await f.send(35, f.finish()); expect((await f.done).value).toEqual(f.receipt); expect((await c.done).error).toBeUndefined();
    expect(f.owner.authorizeDelivery.mock.calls.map(args => args[2])).toEqual([1, 2, 3, 4]);
    expect(f.parent.state.finished).toBe(true); expect(f.owner.retain).toHaveBeenCalledOnce();
    expect(c.channel.listenerCount("readable")).toBe(0); expect(f.channel.listenerCount("readable")).toBe(0);
    expect(f.controller.signal.aborted).toBe(false); c.channel.destroy(); f.channel.destroy();
  });
  it.each(["nonce", "digest", "head", "ordinal", "count", "action", "input_kind", "input_bytes", "padding", "header", "size", "pipelined"])("fences both pipes on malformed control %s", async mode => {
    const f = fixture(), c = controlFixture(f); await f.send(32, f.stream(88));
    const bytes = c.request(mode === "padding" ? 2 : 1);
    const offsets: Record<string, number> = { nonce: 0, digest: 72, head: 40, ordinal: 32, count: 36, action: 104, input_kind: 108, input_bytes: 112, padding: 1167 };
    if (mode in offsets) bytes[offsets[mode]!] = bytes[offsets[mode]!]! ^ 1;
    let wire = f.wire(37, bytes);
    if (mode === "header") wire.writeUInt32LE(38, 8);
    if (mode === "size") wire.writeUInt32LE(0xffffffff, 12);
    if (mode === "pipelined") wire = Buffer.concat([wire, Buffer.from([1])]);
    c.channel.push(wire);
    expect((await c.done).error).toBeDefined(); expect((await f.done).error).toBeDefined();
    expect(f.owner.authorizeInput).toHaveBeenCalledOnce(); expect(f.owner.authorizeDelivery).not.toHaveBeenCalled();
    expect(c.replies).toHaveLength(0); expect(f.owner.retain).not.toHaveBeenCalled();
    expect(c.channel.listenerCount("readable")).toBe(0); expect(f.channel.listenerCount("readable")).toBe(0);
    c.channel.destroy(); f.channel.destroy();
  });
  it.each(["unissued", "replay", "revoked", "after_delivery", "cancelled", "lost_pipe", "reentrant"])("refuses %s control permission without replaying input", async mode => {
    const f = fixture(), c = controlFixture(f);
    if (mode !== "unissued") await f.send(32, f.stream(88));
    if (mode === "replay") await c.send(c.request(1));
    if (mode === "revoked") f.owner.authorizeInput.mockRejectedValueOnce(new Error("Revoked"));
    if (mode === "after_delivery") { await f.send(19, f.challenge()); await f.send(25, f.stream()); await f.send(27, f.stream()); await f.send(30, f.challenge()); }
    if (mode === "cancelled") f.controller.abort();
    else if (mode === "lost_pipe") c.channel.destroy();
    else if (mode === "reentrant") await expect(f.parent.runControl(c.channel)).rejects.toThrow();
    else c.channel.push(f.wire(37, c.request(1)));
    expect((await c.done).error).toBeDefined(); expect((await f.done).error).toBeDefined();
    expect(f.owner.readInput).toHaveBeenCalledTimes(mode === "unissued" ? 0 : 1); expect(f.owner.retain).not.toHaveBeenCalled();
    expect(c.replies).toHaveLength(0); c.channel.destroy(); f.channel.destroy();
  });
  it("bounds a premature delivery wait and releases both readers", async () => {
    const f = fixture(50), c = controlFixture(f); c.channel.push(f.wire(37, c.request(2)));
    expect((await c.done).error).toBeDefined(); expect((await f.done).error).toBeDefined();
    expect(f.owner.authorizeDelivery).not.toHaveBeenCalled(); expect(c.replies).toHaveLength(0);
    expect(c.channel.listenerCount("readable")).toBe(0); expect(f.channel.listenerCount("readable")).toBe(0);
    c.channel.destroy(); f.channel.destroy();
  });
  it("rechecks custody after writing a control reply and fences both owners on revocation", async () => {
    const f = fixture(); await f.send(32, f.stream(88));
    let replySent = false;
    const control = new Duplex({ read() {}, write(_bytes, _encoding, done) { replySent = true; done(); } });
    f.owner.authorizePeer.mockImplementation(async () => { if (replySent) throw new Error("Peer revoked after write"); });
    const done = f.parent.runControl(control).then(() => false, () => true);
    const bytes = Buffer.alloc(1168); f.challenge().copy(bytes); bytes.writeUInt32LE(1, 104); bytes.writeUInt32LE(22, 108); f.stream().copy(bytes, 112);
    control.push(f.wire(37, bytes));
    expect(await done).toBe(true); expect(replySent).toBe(true); expect((await f.done).error).toBeDefined();
    expect(f.owner.retain).not.toHaveBeenCalled(); expect(f.parent.state.finished).toBe(false); control.destroy(); f.channel.destroy();
  });
  it.each(["alias", "reader"])("refuses a control %s without removing another owner's listeners", async mode => {
    const f = fixture(), other = new Duplex({ read() {}, write(_bytes, _encoding, done) { done(); } });
    const reader = () => {}; if (mode === "reader") other.on("readable", reader);
    await expect(f.parent.runControl(mode === "alias" ? f.channel : other)).rejects.toThrow(); expect((await f.done).error).toBeDefined();
    if (mode === "reader") expect(other.listeners("readable")).toContain(reader);
    other.destroy(); f.channel.destroy();
  });
});
