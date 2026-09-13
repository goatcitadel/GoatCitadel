import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workerMeshRejected } from "./worker-mesh-capability-data.js";
import { decodeWindowsWorkerStdioCompletion, encodeWindowsWorkerStdioFrame, encodeWindowsWorkerStdioLaunch,
  normalizeWindowsWorkerStdioLaunch, type WindowsWorkerStdioCompletion } from "./worker-windows-stdio-codec.js";

/** Supplied by trusted local composition; never accepted from registry JSON. */
export interface WindowsWorkerStdioImageGuard {
  pinStdioExecutor(): { readonly executorPath: string; readonly lease: object };
}
export interface WindowsWorkerStdioOutput { readonly stream: "stdout" | "stderr"; readonly bytes: Buffer }
export interface WindowsWorkerStdioSession {
  readonly completion: Promise<WindowsWorkerStdioCompletion>;
  write(bytes: Uint8Array): Promise<void>;
  endInput(): Promise<void>;
  read(): Promise<WindowsWorkerStdioOutput | null>;
  stop(): Promise<void>;
}
const requireNative = createRequire(import.meta.url);
const leases = new Set<object>();

/** Starts only the compiled, image-pinned helper. It launches the exact verified
 * bundle inside the existing native job owner. This does not create a profile,
 * provision a workspace, approve code or infer permission from registry data. */
export async function startWindowsWorkerStdio(input: unknown, options: {
  readonly signal: AbortSignal;
  readonly assertCurrent: () => Promise<void>;
  readonly imageGuard?: WindowsWorkerStdioImageGuard;
}): Promise<WindowsWorkerStdioSession> {
  options.signal.throwIfAborted();
  if (process.platform !== "win32" || typeof options.assertCurrent !== "function") throw workerMeshRejected();
  const launch = normalizeWindowsWorkerStdioLaunch(input);
  const configuration = encodeWindowsWorkerStdioLaunch(launch);
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(launch.limits.wallMs + 5000)]);
  const assertCurrent = async () => {
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    try {
      await Promise.race([Promise.resolve().then(options.assertCurrent), new Promise<never>((_, reject) => {
        abort = () => reject(workerMeshRejected());
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
      signal.throwIfAborted();
    } finally { if (abort) signal.removeEventListener("abort", abort); }
  };
  const guard = options.imageGuard ?? requireNative(fileURLToPath(new URL("../native/GoatCitadelRemoteWorkerImageGuard.node", import.meta.url))) as WindowsWorkerStdioImageGuard;
  const pinned = guard.pinStdioExecutor();
  if (!pinned || typeof pinned.executorPath !== "string" || !path.isAbsolute(pinned.executorPath) ||
    path.basename(pinned.executorPath) !== "GoatCitadelRemoteWorkerStdio.exe" || !pinned.lease || typeof pinned.lease !== "object") throw workerMeshRejected();
  leases.add(pinned.lease);
  try { await assertCurrent(); }
  catch { leases.delete(pinned.lease); throw workerMeshRejected(); }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(pinned.executorPath, [], { cwd: path.dirname(pinned.executorPath), windowsHide: true, shell: false,
      env: { SystemRoot: process.env.SystemRoot }, stdio: ["pipe", "pipe", "pipe"] });
  } catch { leases.delete(pinned.lease); throw workerMeshRejected(); }
  const stdin = child.stdin!, stdout = child.stdout!, stderr = child.stderr!;
  let buffer = Buffer.alloc(0), queued = 0, submitted = 0, outputBytes = 0, errorBytes = 0;
  let failure: Error | undefined, receipt: WindowsWorkerStdioCompletion | undefined;
  let closed = false, ending = false, writing = false, terminating = false;
  const queue: WindowsWorkerStdioOutput[] = [];
  let reader: { resolve: (value: WindowsWorkerStdioOutput | null) => void; reject: (error: Error) => void } | undefined;
  let resolveCompletion!: (value: WindowsWorkerStdioCompletion) => void, rejectCompletion!: (error: Error) => void;
  const completion = new Promise<WindowsWorkerStdioCompletion>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  // A consumer can be awaiting output when completion fails. Keep the original
  // rejection available without an unhandled rejection during that interval.
  void completion.catch(() => undefined);
  let resolveClosed!: () => void;
  const joined = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let killTimer: NodeJS.Timeout | undefined;
  const notify = () => {
    if (!reader) return;
    const current = reader;
    if (failure) { reader = undefined; current.reject(failure); }
    else if (queue.length) { reader = undefined; const value = queue.shift()!; queued -= value.bytes.length; current.resolve(value); }
    else if (closed) { reader = undefined; current.resolve(null); }
  };
  const fail = () => {
    failure ??= workerMeshRejected();
    queue.length = 0; queued = 0; notify();
    if (closed || terminating) return;
    terminating = true;
    // Graceful native cancellation is attempted only with an idle control pipe.
    // The exact helper is killed if its pipe or controller does not respond.
    if (stdin.writable && !writing) stdin.write(encodeWindowsWorkerStdioFrame(3), () => undefined);
    killTimer = setTimeout(() => { if (!closed) child.kill(); }, 200);
  };
  const timer = setTimeout(fail, launch.limits.wallMs + 5000);
  signal.addEventListener("abort", fail, { once: true });
  for (const stream of [stdin, stdout, stderr]) stream.on("error", fail);
  child.on("error", fail);
  // The helper has a framed stdout protocol. Unframed native diagnostics are
  // never exposed as model output, including operating-system path strings.
  stderr.on("data", fail);
  stdout.on("data", (chunk: Buffer) => {
    if (failure) return;
    try {
      if (receipt || buffer.length + chunk.length > 128 * 1024) throw workerMeshRejected();
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const kind = buffer[0], size = buffer.readUInt32LE(1);
        if (!kind || kind > 3 || !size || size > (kind === 3 ? 4096 : 65536)) throw workerMeshRejected();
        if (buffer.length < size + 5) break;
        const bytes = Buffer.from(buffer.subarray(5, 5 + size));
        buffer = buffer.subarray(5 + size);
        if (kind === 3) {
          receipt = decodeWindowsWorkerStdioCompletion(bytes);
          if (buffer.length) throw workerMeshRejected();
          break;
        }
        if (kind === 1) outputBytes += size; else errorBytes += size;
        if (outputBytes + errorBytes > launch.limits.rawOutputBytes + 8192 || queued + size > 128 * 1024) throw workerMeshRejected();
        queue.push({ stream: kind === 1 ? "stdout" : "stderr", bytes }); queued += size;
        notify();
      }
    } catch { fail(); }
  });
  child.once("close", (code, exitSignal) => {
    closed = true;
    clearTimeout(timer); clearTimeout(killTimer);
    signal.removeEventListener("abort", fail);
    leases.delete(pinned.lease);
    try {
      if (failure || signal.aborted || code !== 0 || exitSignal || buffer.length || !receipt) throw workerMeshRejected();
      if (receipt.runtimeBundleVerified && receipt.runtimeBundleSha256 !== launch.runtimeBundleSha256) throw workerMeshRejected();
      if (receipt.end === 0 && !receipt.error && !receipt.bridgeError && (!receipt.processId || !receipt.runtimeBundleVerified ||
        (launch.protectedWorkspace && !receipt.protectedWorkspaceVerified) ||
        !receipt.appContainerVerified || !receipt.launchFilesVerified || !receipt.processImageVerified || !receipt.zeroProcessesVerified || !receipt.outputDrained ||
        !receipt.standardInputComplete || !ending || receipt.standardInputBytesWritten !== submitted ||
        receipt.standardOutputBytes !== outputBytes || receipt.standardErrorBytes !== errorBytes)) throw workerMeshRejected();
      resolveCompletion(receipt);
    } catch { failure ??= workerMeshRejected(); rejectCompletion(failure); }
    notify(); resolveClosed();
  });
  const writeBytes = (bytes: Buffer) => new Promise<void>((resolve, reject) => {
    if (closed || failure || signal.aborted || !stdin.writable) { reject(workerMeshRejected()); return; }
    stdin.write(bytes, (error) => { if (error || failure || signal.aborted) { fail(); reject(workerMeshRejected()); } else resolve(); });
  });
  try {
    writing = true;
    if (signal.aborted) fail();
    await writeBytes(configuration);
  } catch { fail(); await joined; throw workerMeshRejected(); }
  finally { writing = false; }
  const send = async (bytes: Uint8Array | undefined) => {
    if (writing || ending || failure || closed) throw workerMeshRejected();
    const frame = bytes === undefined ? encodeWindowsWorkerStdioFrame(2) : encodeWindowsWorkerStdioFrame(1, bytes);
    if (bytes && submitted + bytes.byteLength > launch.limits.inputBytes) throw workerMeshRejected();
    writing = true;
    if (bytes === undefined) ending = true;
    try {
      await assertCurrent();
      if (bytes) submitted += frame.length - 5;
      await writeBytes(frame);
    } catch { fail(); throw workerMeshRejected(); }
    finally { writing = false; }
  };
  return Object.freeze({ completion,
    write: (bytes: Uint8Array) => send(bytes), endInput: () => send(undefined),
    read: async () => {
      if (reader) throw workerMeshRejected();
      if (failure) throw failure;
      if (queue.length) { const value = queue.shift()!; queued -= value.bytes.length; return value; }
      if (closed) return null;
      return new Promise<WindowsWorkerStdioOutput | null>((resolve, reject) => { reader = { resolve, reject }; notify(); });
    },
    stop: async () => { fail(); await joined; },
  });
}
