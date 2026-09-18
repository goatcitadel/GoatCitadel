import { spawn } from "node:child_process";
import { workerLocalStateActivity } from "./worker-local-state-activity.js";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeWindowsWorkerDirectoryResult, WORKER_DIRECTORY_RESPONSE_BYTES } from "./worker-windows-directory-protocol.js";

/** Trusted composition seam; neither model input nor registry JSON can provide it. */
export interface WindowsWorkerFileImageGuard {
  pinFileExecutor(): { readonly executorPath: string; readonly lease: object };
}
export interface WindowsWorkerFileWrite {
  readonly rootPath: string;
  readonly rootIdentity: string;
  readonly path: string;
  readonly content: string;
  readonly expectedContent: string | null;
}
export interface WindowsWorkerFileResult {
  readonly error: number;
  readonly effectStarted: boolean;
  readonly created: boolean;
  readonly bytes: number;
  readonly rootIdentity: string;
  readonly sha256: string;
}
const leases = new Set<object>();
const requireNative = createRequire(import.meta.url);
const reject = () => new Error("The native file operation was refused or its outcome requires reconciliation.");

function textBytes(value: string, limit: number): Buffer {
  if (typeof value !== "string") throw reject();
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > limit || bytes.toString("utf8") !== value) throw reject();
  return bytes;
}

/** Fixed binary protocol; caller cancellation kills and joins the exact helper.
 * A lost/invalid response after launch is never evidence that a write did not happen. */
export function createWindowsWorkerFileExecutor(imageGuard?: WindowsWorkerFileImageGuard) {
  const send = createWindowsWorkerFileChannel(imageGuard);
  const call = async (rootPath: string, suppliedWrite: WindowsWorkerFileWrite | undefined, signal: AbortSignal): Promise<WindowsWorkerFileResult> => {
    const write = suppliedWrite ? Object.freeze({ ...suppliedWrite }) : undefined;
    signal.throwIfAborted();
    if (process.platform !== "win32" || !path.isAbsolute(rootPath) || rootPath.includes("\0")) throw reject();
    const root = textBytes(rootPath, 8192);
    const relative = textBytes(write?.path ?? "", 4096);
    const content = textBytes(write?.content ?? "", 32768);
    const expected = write && write.expectedContent !== null ? textBytes(write.expectedContent, 32768) : undefined;
    if (write && (!/^[a-f0-9]{48}$/u.test(write.rootIdentity) || /^0+$/u.test(write.rootIdentity))) throw reject();
    const header = Buffer.alloc(52);
    header.write("GCFILES1", 0, "ascii");
    header.writeUInt32LE(write ? 2 : 1, 8);
    header.writeUInt32LE(root.length, 12); header.writeUInt32LE(relative.length, 16);
    header.writeUInt32LE(content.length, 20); header.writeUInt32LE(expected?.length ?? 0xffffffff, 24);
    if (write) Buffer.from(write.rootIdentity, "hex").copy(header, 28);
    const input = Buffer.concat([header, root, relative, content, expected ?? Buffer.alloc(0)]);
    // Encode before queuing so caller mutation cannot change a delayed write.
    // The channel settles only on child close, including cancellation/error.
    const response = write
      ? await workerLocalStateActivity.mutation(() => send(input, signal, 80), signal)
      : await send(input, signal, 80);
    if (response.length !== 80 || response.toString("ascii", 0, 8) !== "GCFILER1" || response.readUInt32LE(12) > 1 || response.readUInt32LE(16) > 1 ||
      response.readUInt32LE(20) > 32768) throw reject();
    const result = { error: response.readUInt32LE(8), effectStarted: response.readUInt32LE(12) === 1,
      created: response.readUInt32LE(16) === 1, bytes: response.readUInt32LE(20),
      rootIdentity: response.subarray(24, 48).toString("hex"), sha256: response.subarray(48).toString("hex") };
    if (!result.error && (/^0+$/u.test(result.rootIdentity) || (write &&
      (result.rootIdentity !== write.rootIdentity || !result.effectStarted || result.created !== (write.expectedContent === null))) ||
      (!write && (result.effectStarted || result.created || result.bytes || !/^0+$/u.test(result.sha256))))) throw reject();
    return result;
  };
  return Object.freeze({
    inspect: async (rootPath: string, signal: AbortSignal): Promise<string> => {
      const result = await call(rootPath, undefined, signal);
      if (result.error) throw reject();
      return result.rootIdentity;
    },
    write: (input: WindowsWorkerFileWrite, signal: AbortSignal) => call(input.rootPath, input, signal),
  });
}

export function createWindowsWorkerDirectoryExecutor(imageGuard?: WindowsWorkerFileImageGuard) {
  const send = createWindowsWorkerFileChannel(imageGuard);
  return Object.freeze({
    inspect: createWindowsWorkerFileExecutor(imageGuard).inspect,
    list: async (input: { rootPath: string; rootIdentity: string; path: string }, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (process.platform !== "win32" || !path.isAbsolute(input.rootPath) || input.rootPath.includes("\0") ||
        !/^[a-f0-9]{48}$/u.test(input.rootIdentity) || /^0+$/u.test(input.rootIdentity)) throw reject();
      const root = textBytes(input.rootPath, 8192), relative = textBytes(input.path === "." ? "" : input.path, 4096);
      const header = Buffer.alloc(52);
      header.write("GCFILES1", 0, "ascii"); header.writeUInt32LE(3, 8);
      header.writeUInt32LE(root.length, 12); header.writeUInt32LE(relative.length, 16); header.writeUInt32LE(0xffffffff, 24);
      Buffer.from(input.rootIdentity, "hex").copy(header, 28);
      return decodeWindowsWorkerDirectoryResult(await send(Buffer.concat([header, root, relative]), signal,
        WORKER_DIRECTORY_RESPONSE_BYTES), input.rootIdentity);
    },
  });
}

function createWindowsWorkerFileChannel(imageGuard?: WindowsWorkerFileImageGuard) {
  return async (input: Buffer, signal: AbortSignal, maximum: number): Promise<Buffer> => {
    const guard: WindowsWorkerFileImageGuard = imageGuard ?? requireNative(
      fileURLToPath(new URL("../native/GoatCitadelRemoteWorkerImageGuard.node", import.meta.url)),
    ) as WindowsWorkerFileImageGuard;
    const pinned = guard.pinFileExecutor();
    if (!pinned || typeof pinned.executorPath !== "string" || !path.isAbsolute(pinned.executorPath) ||
      path.basename(pinned.executorPath) !== "GoatCitadelRemoteWorkerFiles.exe" || !pinned.lease || typeof pinned.lease !== "object") throw reject();
    leases.add(pinned.lease);
    try {
      signal.throwIfAborted();
      return await new Promise<Buffer>((resolve, fail) => {
        const child = spawn(pinned.executorPath, [], { cwd: path.dirname(pinned.executorPath), windowsHide: true,
          env: { SystemRoot: process.env.SystemRoot }, stdio: ["pipe", "pipe", "pipe"], shell: false });
        const chunks: Buffer[] = [];
        let size = 0, refused = false;
        const stop = () => { refused = true; child.kill(); };
        const timer = setTimeout(stop, 10_000);
        signal.addEventListener("abort", stop, { once: true });
        child.on("error", () => { refused = true; });
        child.stdin.on("error", stop);
        child.stdout.on("error", stop);
        child.stderr.on("error", stop);
        child.stderr.on("data", stop);
        child.stdout.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maximum) stop(); else chunks.push(chunk);
        });
        child.once("close", (code, exitSignal) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", stop);
          if (refused || signal.aborted || code !== 0 || exitSignal) fail(reject());
          else resolve(Buffer.concat(chunks));
        });
        if (signal.aborted) stop();
        if (!refused) child.stdin.end(input); else child.stdin.destroy();
      });
    } finally { leases.delete(pinned.lease); }
  };
}

export type WindowsWorkerFileExecutor = ReturnType<typeof createWindowsWorkerFileExecutor>;
export type WindowsWorkerDirectoryExecutor = ReturnType<typeof createWindowsWorkerDirectoryExecutor>;
