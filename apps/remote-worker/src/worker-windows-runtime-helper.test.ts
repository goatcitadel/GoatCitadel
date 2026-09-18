import { createHash } from "node:crypto";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { WindowsRuntimeHelperParent, encodeWindowsRuntimeHelperBootstrap } from "./worker-windows-runtime-helper.js";
import type { WindowsRuntimeParentSessionOwner } from "./worker-windows-runtime-parent-session.js";

const session = vi.hoisted(() => ({ run: vi.fn(), control: vi.fn(async (..._args: unknown[]) => undefined), constructed: vi.fn(),
  discardFiles: vi.fn(), takeFiles: vi.fn(() => Object.freeze([])) }));
vi.mock("./worker-windows-runtime-parent-session.js", () => ({ WindowsRuntimeParentSession: class {
  state = { phase: "finished", retentionAttempted: true, retentionConfirmed: true, finished: true, cleanupVerified: true };
  constructor(...args: unknown[]) { session.constructed(...args); }
  run() { return session.run(); }
  runControl(...args: unknown[]) { return session.control(...args); }
  discardFiles() { session.discardFiles(); }
  takeFiles() { return session.takeFiles(); }
} }));
const parents: WindowsRuntimeHelperParent[] = [], sockets: Socket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.destroy(); for (const parent of parents.splice(0)) await parent.close(); vi.clearAllMocks(); });
function fixture(timeoutMs = 2000) {
  const f = runtimeResultPagesFixture(22), stop = new AbortController();
  // Transport-only envelope. Native launch syntax is covered by the dispatch
  // and compiled helper fixtures; no executable is launched by this test.
  const request = Buffer.alloc(157); request.write("GCRUN001"); Buffer.from(f.expectation.nonce, "hex").copy(request, 8);
  Buffer.from(f.expectation.checkpointSha256, "hex").copy(request, 96); request.writeUInt32LE(13, 140);
  request.write("GCSTDIO2", 144); request.writeUInt32LE(1, 152); request[156] = 0x61;
  const expected = { ...f.expectation, requestSha256: createHash("sha256").update("goatcitadel.worker-runtime-dispatch.v1\0").update(request).digest("hex") };
  const owner: WindowsRuntimeParentSessionOwner = { signal: stop.signal, timeoutMs,
    authorizePeer: vi.fn(async () => undefined), authorizeRuntime: vi.fn(async () => undefined), authorizeDelivery: vi.fn(async () => undefined),
    authorizeRetention: vi.fn(async () => undefined), retain: vi.fn(async () => { throw new Error("Unused in handshake fixture."); }),
    readInput: vi.fn(async () => "eof" as const), authorizeInput: vi.fn(async () => undefined), consumeOutput: vi.fn(async () => undefined) };
  return { ...f, expected, request, owner, stop };
}
async function opened(f = fixture()) {
  const parent = await WindowsRuntimeHelperParent.open(f.request, f.expected, f.history, f.owner); parents.push(parent);
  const bootstrap = parent.takeBootstrap();
  const client = connect(parent.pipeName); sockets.push(client); client.on("error", () => undefined); await once(client, "connect");
  const hello = Buffer.alloc(136); hello.write("GCRPA001"); bootstrap.copy(hello, 8, 40, 168);
  return { ...f, parent, client, bootstrap, hello };
}
async function controlConnection(f: Awaited<ReturnType<typeof opened>>, wrongRole = false) {
  const client = connect(f.parent.controlPipeName); sockets.push(client); client.on("error", () => undefined); await once(client, "connect");
  const hello = Buffer.from(f.hello); if (!wrongRole) hello.write("GCRPC001");
  return { client, hello };
}
describe("private native helper bootstrap and parent endpoint", () => {
  it("binds the private secret separately from public locator, request and retained head", () => {
    const f = fixture(), bytes = encodeWindowsRuntimeHelperBootstrap(f.request, f.expected, Buffer.alloc(32, 1), Buffer.alloc(32, 2));
    expect(bytes.subarray(0, 8).toString()).toBe("GCRHP001"); expect(bytes.length).toBe(176 + f.request.length);
    expect(bytes.subarray(8, 40)).toEqual(Buffer.alloc(32, 1)); expect(bytes.subarray(40, 72)).toEqual(Buffer.alloc(32, 2));
    expect(bytes.subarray(104, 136).toString("hex")).toBe(f.expected.requestSha256);
    expect(bytes.readUInt32LE(168)).toBe(f.request.length); expect(bytes.readUInt32LE(172)).toBe(0);
    expect(bytes.subarray(176)).toEqual(f.request);
    for (const [locator, secret] of [[Buffer.alloc(31), Buffer.alloc(32, 2)], [Buffer.alloc(32), Buffer.alloc(32, 2)],
      [Buffer.alloc(32, 1), Buffer.alloc(32)], [Buffer.alloc(32, 1), Buffer.alloc(32, 1)],
      [Buffer.alloc(32, 1), Buffer.from(f.expected.nonce, "hex")], [Buffer.alloc(32, 1), Buffer.from(f.expected.requestSha256, "hex")],
      [Buffer.alloc(32, 1), Buffer.from(f.expected.checkpointSha256, "hex")]])
      expect(() => encodeWindowsRuntimeHelperBootstrap(f.request, f.expected, locator!, secret!)).toThrow();
    const changed = Buffer.from(f.request); changed[156] = changed[156]! ^ 1;
    expect(() => encodeWindowsRuntimeHelperBootstrap(changed, f.expected, Buffer.alloc(32, 1), Buffer.alloc(32, 2))).toThrow();
  });
  it("accepts a fragmented one-use hello before constructing the runtime session", async () => {
    session.run.mockResolvedValue({ retained: true });
    const f = await opened(); expect(() => f.parent.takeBootstrap()).toThrow();
    const response = new Promise<Buffer>((resolve) => { const chunks: Buffer[] = []; let size = 0; f.client.on("data", bytes => {
      chunks.push(bytes); size += bytes.length; if (size >= 136) resolve(Buffer.concat(chunks));
    }); });
    for (const byte of f.hello) f.client.write(Buffer.from([byte]));
    const expected = Buffer.from(f.hello); expected[7] = 0x32;
    expect(await response).toEqual(expected); expect(session.constructed).not.toHaveBeenCalled();
    const control = await controlConnection(f), controlResponse = once(control.client, "data"); control.client.write(control.hello);
    const controlExpected = Buffer.from(control.hello); controlExpected[7] = 0x32;
    expect((await controlResponse)[0]).toEqual(controlExpected);
    expect(await f.parent.completion).toEqual({ retained: true });
    expect(f.owner.authorizePeer).toHaveBeenCalledTimes(2); expect(session.constructed).toHaveBeenCalledOnce();
    expect(session.control).toHaveBeenCalledOnce(); expect(session.control.mock.calls[0]![0]).not.toBe(session.constructed.mock.calls[0]![0]);
    expect(session.constructed.mock.calls[0]![1]).toEqual(f.expected);
    expect(f.parent.state.finished).toBe(true);
    expect(f.parent.state.cleanupVerified).toBe(true);
    expect(f.parent.takeFiles()).toEqual([]); expect(session.takeFiles).toHaveBeenCalledOnce();
    expect(f.owner.authorizeRuntime).not.toHaveBeenCalled();
    f.stop.abort();
    expect(session.discardFiles).toHaveBeenCalled();
    expect(f.parent.state.finished).toBe(false);
    expect(f.parent.state.cleanupVerified).toBe(false);
    expect(f.parent.state.retentionConfirmed).toBe(true);
  });
  it.each([0, 8, 40, 72, 104, 135])("refuses changed authentication byte %i before any admission callback", async offset => {
    const f = await opened(); f.hello[offset] = f.hello[offset]! ^ 1; f.client.write(f.hello);
    await expect(f.parent.completion).rejects.toThrow(); expect(f.owner.authorizePeer).not.toHaveBeenCalled();
    expect(session.constructed).not.toHaveBeenCalled();
  });
  it("rejects a pipelined request before sending the authentication acknowledgment", async () => {
    const f = await opened(); f.client.write(Buffer.concat([f.hello, Buffer.from([1])]));
    await expect(f.parent.completion).rejects.toThrow(); expect(session.constructed).not.toHaveBeenCalled();
  });
  it("rejects changed retained history before opening any endpoint", async () => {
    const f = fixture();
    await expect(WindowsRuntimeHelperParent.open(f.request, { ...f.expected, checkpointSha256: "a".repeat(64) }, f.history, f.owner)).rejects.toThrow();
  });
  it("withholds the handshake acknowledgment when current peer custody is denied", async () => {
    const f = fixture(); vi.mocked(f.owner.authorizePeer).mockRejectedValue(new Error("revoked"));
    const p = await opened(f); p.client.write(p.hello); await expect(p.parent.completion).rejects.toThrow();
    expect(session.constructed).not.toHaveBeenCalled();
  });
  it("cancels a partial hello and a pending custody callback", async () => {
    for (const pendingCustody of [false, true]) {
      const f = fixture(); if (pendingCustody) vi.mocked(f.owner.authorizePeer).mockImplementation(async () => new Promise(() => undefined));
      const p = await opened(f); p.client.write(pendingCustody ? p.hello : p.hello.subarray(0, 1));
      if (pendingCustody) await vi.waitFor(() => expect(f.owner.authorizePeer).toHaveBeenCalledOnce());
      f.stop.abort(); await expect(p.parent.completion).rejects.toThrow(); expect(session.constructed).not.toHaveBeenCalled();
    }
  });
  it("bounds a helper that never connects and closes without an external side effect", async () => {
    const f = fixture(100), parent = await WindowsRuntimeHelperParent.open(f.request, f.expected, f.history, f.owner); parents.push(parent);
    parent.takeBootstrap(); await expect(parent.completion).rejects.toThrow(); expect(session.constructed).not.toHaveBeenCalled();
  });
  it("requires distinct role-bound authentication on the control endpoint", async () => {
    const f = await opened(), control = await controlConnection(f, true); control.client.write(control.hello);
    await expect(f.parent.completion).rejects.toThrow(); expect(f.owner.authorizePeer).not.toHaveBeenCalled(); expect(session.constructed).not.toHaveBeenCalled();
  });
  it("does not start a session if the first authenticated pipe disconnects", async () => {
    const f = await opened(), response = once(f.client, "data"); f.client.write(f.hello); await response;
    f.client.end(); await expect(f.parent.completion).rejects.toThrow(); expect(session.constructed).not.toHaveBeenCalled();
  });
  it("allows control authentication first but still waits for runtime authentication", async () => {
    session.run.mockResolvedValue({ retained: true });
    const f = await opened(), control = await controlConnection(f), response = once(control.client, "data");
    control.client.write(control.hello); await response; expect(session.constructed).not.toHaveBeenCalled();
    f.client.write(f.hello); expect(await f.parent.completion).toEqual({ retained: true }); expect(session.constructed).toHaveBeenCalledOnce();
  });
});
