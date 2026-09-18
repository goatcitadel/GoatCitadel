import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
// Launch admission has its own protocol tests. Keep real completion decoding
// here while controlling the native child lifetime and receipt independently.
vi.mock("./worker-windows-stdio-codec.js", async importOriginal => ({
  ...await importOriginal<object>(),
  normalizeWindowsWorkerStdioLaunch: () => ({ limits: { wallMs: 5000, rawOutputBytes: 8192, inputBytes: 8192 }, runtimeBundleSha256: "ab".repeat(32) }),
  encodeWindowsWorkerStdioLaunch: () => Buffer.from("fixture"),
}));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const { workerLocalStateActivity: activity } = await import("./worker-local-state-activity.js");
  const { startWindowsWorkerStdio } = await import("./worker-windows-stdio-executor.js");
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  child.stdin.resume();
  vi.mocked(spawn).mockReturnValue(child as never);
  const stop = new AbortController();
  const start = () => startWindowsWorkerStdio({}, { signal: stop.signal, assertCurrent: async () => undefined,
    imageGuard: { pinStdioExecutor: () => ({ executorPath: "F:\\fixture\\GoatCitadelRemoteWorkerStdio.exe", lease: {} }) } });
  const receipt = (changes = {}) => {
    const value = { schemaVersion: "goatcitadel.worker-native-stdio.v1", bridgeError: 0, end: 0, error: 0, processExitCode: 0, processId: 123,
      runtimeBundleVerified: true, runtimeBundleSha256: "ab".repeat(32), zeroProcessesVerified: true, outputDrained: true,
      appContainerVerified: true, launchFilesVerified: true, processImageVerified: true, protectedWorkspaceVerified: false,
      standardInputBytesWritten: 0, standardInputComplete: true, standardOutputBytes: 0, standardErrorBytes: 0, ...changes };
    const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(5); header[0] = 3; header.writeUInt32LE(bytes.length, 1);
    child.stdout.emit("data", Buffer.concat([header, bytes]));
  };
  const measure = () => activity.quiescent(async () => "measured", new AbortController().signal);
  return { activity, child, start, stop, receipt, measure };
}

describe.skipIf(process.platform !== "win32")("native stdio writer custody", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  it("allows state saves but refuses measurement through receipt until joined cleanup", async () => {
    const f = await fixture(), session = await f.start();
    await expect(f.measure()).rejects.toThrow("cleanup");
    await expect(f.activity.mutation(async () => "saved")).resolves.toBe("saved");
    await session.endInput(); f.receipt();
    await expect(f.measure()).rejects.toThrow("cleanup");
    f.child.emit("close", 0, null); await session.completion;
    await expect(f.measure()).resolves.toBe("measured");
  });
  it("refuses launch during a held measurement without spawning or leaking a reservation", async () => {
    const f = await fixture(), entered = deferred(), finish = deferred();
    const held = f.activity.quiescent(async () => { entered.resolve(); await finish.promise; }, f.stop.signal);
    await entered.promise;
    try { await expect(f.start()).rejects.toThrow(); expect(spawn).not.toHaveBeenCalled(); }
    finally { finish.resolve(); await held; }
    await expect(f.measure()).resolves.toBe("measured");
  });
  it("releases a reservation when synchronous spawn never creates a child", async () => {
    const f = await fixture(); vi.mocked(spawn).mockImplementation(() => { throw new Error("spawn failed"); });
    await expect(f.start()).rejects.toThrow(); await expect(f.measure()).resolves.toBe("measured");
  });
  it.each(["missing", "undrained", "live-process", "cancelled", "malformed"])("keeps measurement refused after %s cleanup", async mode => {
    const f = await fixture(), session = await f.start(); await session.endInput();
    if (mode === "cancelled") f.stop.abort();
    else if (mode === "malformed") f.child.stdout.emit("data", Buffer.from([0, 0, 0, 0, 0]));
    else if (mode !== "missing") f.receipt({ end: 1, outputDrained: mode !== "undrained", zeroProcessesVerified: mode !== "live-process" });
    f.child.emit("close", 0, null); await session.completion.catch(() => undefined);
    await expect(f.measure()).rejects.toThrow("cleanup");
    await expect(f.activity.mutation(async () => "saved")).resolves.toBe("saved");
  });
});
