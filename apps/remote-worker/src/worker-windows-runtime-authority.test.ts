import { describe, expect, it, vi } from "vitest";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { WindowsRuntimeParentAuthority, type WindowsRuntimeAuthorityOwner } from "./worker-windows-runtime-authority.js";

function fixture(timeoutMs = 1000) {
  const f = runtimeResultPagesFixture(0), controller = new AbortController();
  const replies: { kind: number; payload: Buffer }[] = [];
  const owner = { signal: controller.signal, timeoutMs,
    authorizePeer: vi.fn(async (_signal: AbortSignal) => {}),
    authorizeRuntime: vi.fn<WindowsRuntimeAuthorityOwner["authorizeRuntime"]>(async () => {}),
    authorizeDelivery: vi.fn<WindowsRuntimeAuthorityOwner["authorizeDelivery"]>(async () => {}),
    reply: vi.fn<WindowsRuntimeAuthorityOwner["reply"]>(async (kind, payload) => { replies.push({ kind, payload: Buffer.from(payload) }); }),
  };
  const challenge = (ordinal = 1) => {
    const bytes = Buffer.alloc(104); Buffer.from(f.expectation.nonce, "hex").copy(bytes);
    bytes.writeUInt32LE(ordinal, 32); bytes.writeUInt32LE(21, 36);
    Buffer.from(f.expectation.checkpointSha256, "hex").copy(bytes, 40); Buffer.from(f.expectation.requestSha256, "hex").copy(bytes, 72);
    return bytes;
  };
  return { ...f, controller, owner, replies, challenge, create: () => new WindowsRuntimeParentAuthority(f.expectation, f.history, owner) };
}

describe("protected-parent runtime permissions", () => {
  it("consults separate current execution and delivery owners for every exact challenge", async () => {
    const f = fixture(), parent = f.create();
    for (const [kind, ordinal] of [[19, 1], [30, 1], [19, 2], [30, 2]] as const) await parent.respond(kind, f.challenge(ordinal));
    expect(f.replies).toEqual([20, 31, 20, 31].map((kind, i) => ({ kind, payload: f.challenge(Math.floor(i / 2) + 1) })));
    expect(f.owner.authorizePeer).toHaveBeenCalledTimes(12);
    expect(f.owner.authorizeRuntime.mock.calls.map(call => call[2])).toEqual([1, 2]);
    expect(f.owner.authorizeDelivery.mock.calls.map(call => call[2])).toEqual([1, 2]);
    expect(f.owner.authorizeRuntime.mock.calls[0]!.slice(0, 2)).toEqual([f.expectation, f.history]);
    expect(f.controller.signal.aborted).toBe(false);
  });
  it.each(["nonce", "hash", "head", "ordinal", "count", "size", "kind", "cancel"])("refuses %s before canonical callbacks", async mode => {
    const f = fixture(), parent = f.create(); let bytes = f.challenge();
    if (mode === "nonce") bytes[0] = bytes[0]! ^ 1;
    if (mode === "hash") bytes[72] = bytes[72]! ^ 1;
    if (mode === "head") bytes[40] = bytes[40]! ^ 1;
    if (mode === "ordinal") bytes.writeUInt32LE(2, 32);
    if (mode === "count") bytes.writeUInt32LE(20, 36);
    if (mode === "size") bytes = bytes.subarray(1);
    if (mode === "cancel") f.controller.abort();
    await expect(parent.respond(mode === "kind" ? 20 : 19, bytes)).rejects.toThrow();
    await expect(parent.respond(30, f.challenge())).rejects.toThrow();
    expect(f.owner.authorizePeer).not.toHaveBeenCalled(); expect(f.owner.reply).not.toHaveBeenCalled();
  });
  it.each([19, 30])("refuses replay for action %i across both action types", async kind => {
    const f = fixture(), parent = f.create(); await parent.respond(kind, f.challenge());
    await expect(parent.respond(kind, f.challenge())).rejects.toThrow();
    await expect(parent.respond(kind === 19 ? 30 : 19, f.challenge())).rejects.toThrow();
    expect(f.replies).toHaveLength(1);
  });
  it.each(["peer", "execution", "delivery", "post_admission", "reply", "post_reply", "cancel", "reentrant"])("fences %s failure", async mode => {
    const f = fixture(), parent = f.create(); const denial = new Error("Denied");
    if (mode === "peer") f.owner.authorizePeer.mockRejectedValueOnce(denial);
    if (mode === "execution") f.owner.authorizeRuntime.mockRejectedValueOnce(denial);
    if (mode === "delivery") f.owner.authorizeDelivery.mockRejectedValueOnce(denial);
    if (mode === "post_admission") f.owner.authorizePeer.mockResolvedValueOnce().mockRejectedValueOnce(denial);
    if (mode === "reply") f.owner.reply.mockRejectedValueOnce(denial);
    if (mode === "post_reply") f.owner.authorizePeer.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(denial);
    if (mode === "cancel") f.owner.authorizeRuntime.mockImplementationOnce(async () => { f.controller.abort(); });
    if (mode === "reentrant") f.owner.authorizeRuntime.mockImplementationOnce(async () => { await expect(parent.respond(30, f.challenge())).rejects.toThrow(); });
    await expect(parent.respond(mode === "delivery" ? 30 : 19, f.challenge())).rejects.toThrow();
    await expect(parent.respond(19, f.challenge(2))).rejects.toThrow();
    expect(f.replies).toHaveLength(mode === "post_reply" ? 1 : 0);
    if (mode !== "cancel") expect(f.controller.signal.aborted).toBe(false);
  });
  it("freezes caller-owned challenge and callback selection before asynchronous approval", async () => {
    const f = fixture(), bytes = f.challenge(), original = Buffer.from(bytes), parent = f.create();
    f.owner.authorizePeer.mockImplementationOnce(async () => { bytes.fill(0); });
    f.owner.authorizeRuntime = vi.fn(async () => { throw new Error("Replaced owner"); });
    await parent.respond(19, bytes); expect(f.replies[0]!.payload).toEqual(original);
    expect(f.owner.authorizeRuntime).not.toHaveBeenCalled();
  });
  it("aborts a pending owner and never writes an ACK when its late approval resolves", async () => {
    const f = fixture(30), parent = f.create(); let finish: (() => void) | undefined;
    f.owner.authorizeRuntime.mockImplementationOnce(async () => new Promise<void>(resolve => { finish = resolve; }));
    await expect(parent.respond(19, f.challenge())).rejects.toThrow();
    expect(f.owner.authorizeRuntime.mock.calls[0]![3].aborted).toBe(true);
    finish!(); await new Promise(resolve => setImmediate(resolve));
    expect(f.replies).toHaveLength(0); expect(f.controller.signal.aborted).toBe(false);
  });
  it("rejects incomplete or mismatched independently retained history", () => {
    const f = fixture();
    expect(() => new WindowsRuntimeParentAuthority({ ...f.expectation, checkpointSha256: "ff".repeat(32) }, f.history, f.owner)).toThrow();
    expect(() => new WindowsRuntimeParentAuthority(f.expectation, { ...f.history, mountedWorkspaceRecords: [] }, f.owner)).toThrow();
    expect(() => new WindowsRuntimeParentAuthority(f.expectation, f.history, { ...f.owner, timeoutMs: 86400001 })).toThrow();
  });
});
