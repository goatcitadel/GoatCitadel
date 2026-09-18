import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createWindowsWorkerFileExecutor } from "./worker-windows-file-executor.js";
import { workerLocalStateActivity } from "./worker-local-state-activity.js";
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; };
function fixture() {
  const started = deferred(), stop = new AbortController(), sent: Buffer[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  child.stdin.on("data", bytes => sent.push(Buffer.from(bytes)));
  vi.mocked(spawn).mockImplementation(() => { started.resolve(); return child as never; });
  const executor = createWindowsWorkerFileExecutor({ pinFileExecutor: () => ({ executorPath: "F:\\fixture\\GoatCitadelRemoteWorkerFiles.exe", lease: {} }) });
  const input = { rootPath: "F:\\fixture", rootIdentity: "ab".repeat(24), path: "note.txt", content: "hi", expectedContent: null as string | null };
  const receipt = Buffer.alloc(80); receipt.write("GCFILER1"); receipt.writeUInt32LE(1, 12); receipt.writeUInt32LE(1, 16); receipt.writeUInt32LE(2, 20);
  Buffer.from(input.rootIdentity, "hex").copy(receipt, 24); createHash("sha256").update("hi").digest().copy(receipt, 48);
  return { started, stop, sent, child, executor, input, receipt };
}
describe.skipIf(process.platform !== "win32")("native file writer measurement exclusion", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["success", "cancel", "malformed"])("holds until the %s child is joined, not merely until receipt or kill", async mode => {
    const f = fixture(), pending = f.executor.write(f.input, f.stop.signal);
    const result = mode === "success" ? expect(pending).resolves.toMatchObject({ bytes: 2 }) : expect(pending).rejects.toThrow();
    await f.started.promise;
    let measured = false;
    const observation = workerLocalStateActivity.quiescent(async () => { measured = true; }, new AbortController().signal);
    f.child.stdout.emit("data", mode === "malformed" ? Buffer.alloc(81) : f.receipt);
    if (mode === "cancel") f.stop.abort();
    await Promise.resolve(); expect(measured).toBe(false);
    expect(f.child.kill).toHaveBeenCalledTimes(mode === "success" ? 0 : 1);
    f.child.emit("close", 0, null);
    await Promise.all([result, observation]); expect(measured).toBe(true);
  });
  it("does not launch a queued write cancelled during measurement or let later writers overtake it", async () => {
    const f = fixture(), started = deferred(), finish = deferred();
    const held = workerLocalStateActivity.quiescent(async () => { started.resolve(); await finish.promise; }, new AbortController().signal);
    await started.promise;
    const pending = f.executor.write(f.input, f.stop.signal), rejected = expect(pending).rejects.toThrow();
    f.stop.abort(); await rejected; expect(spawn).not.toHaveBeenCalled();
    let later = false; const following = workerLocalStateActivity.mutation(async () => { later = true; });
    await Promise.resolve(); expect(later).toBe(false);
    finish.resolve(); await Promise.all([held, following]); expect(later).toBe(true); expect(spawn).not.toHaveBeenCalled();
  });
  it("freezes queued native write bytes before a caller changes the request", async () => {
    const f = fixture(), started = deferred(), finish = deferred();
    const held = workerLocalStateActivity.quiescent(async () => { started.resolve(); await finish.promise; }, new AbortController().signal);
    await started.promise; const pending = f.executor.write(f.input, f.stop.signal); f.input.content = "changed";
    f.input.rootIdentity = "cd".repeat(24); f.input.expectedContent = "changed";
    expect(spawn).not.toHaveBeenCalled(); finish.resolve(); await held; await f.started.promise;
    expect(Buffer.concat(f.sent).subarray(-2).toString()).toBe("hi");
    f.child.stdout.emit("data", f.receipt); f.child.emit("close", 0, null); await expect(pending).resolves.toMatchObject({ bytes: 2 });
  });
});
