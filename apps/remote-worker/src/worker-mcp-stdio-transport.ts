import { snapshotWorkerMeshValue, workerMeshRecord, workerMeshRejected } from "./worker-mesh-capability-data.js";
import type { WindowsWorkerStdioSession } from "./worker-windows-stdio-executor.js";
import { runWorkerMcpStep, type WorkerMcpCall } from "./worker-mcp-tool-protocol.js";

export interface WorkerMcpStdioTransport {
  readonly call: WorkerMcpCall;
  finish(): Promise<void>;
  stop(): Promise<void>;
}

/** Newline-delimited MCP over an already owned native process. There is no spawn,
 * implicit capability, provider sampling, filesystem callback or retry here. */
export function createWorkerMcpStdioTransport(
  session: WindowsWorkerStdioSession,
  options: {
    readonly signal: AbortSignal;
    readonly assertCurrent: () => Promise<void>;
  },
): WorkerMcpStdioTransport {
  const { signal, assertCurrent } = options;
  signal.throwIfAborted();
  let failure: Error | undefined,
    closing = false,
    finished = false;
  let sequence = 0,
    messages = 0,
    outputBytes = 0,
    inputBytes = 0;
  let buffered = Buffer.alloc(0);
  let pending: { id: number; resolve(value: Record<string, unknown>): void; reject(error: Error): void } | undefined;
  let writeTail = Promise.resolve();
  let stopPromise: Promise<void> | undefined;
  const check = () => {
    signal.throwIfAborted();
    if (failure) throw failure;
  };
  const fail = () => {
    failure ??= workerMeshRejected();
    pending?.reject(failure);
    pending = undefined;
    stopPromise ??= session.stop().catch(() => undefined);
  };
  signal.addEventListener("abort", fail, { once: true });
  const send = (message: Record<string, unknown>) => {
    const bytes = Buffer.from(`${JSON.stringify(snapshotWorkerMeshValue(message, 256 * 1024, true))}\n`, "utf8");
    inputBytes += bytes.length;
    if (inputBytes > 1024 * 1024) {
      fail();
      return Promise.reject(workerMeshRejected());
    }
    const operation = writeTail.then(async () => {
      check();
      await runWorkerMcpStep(signal, assertCurrent);
      check();
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        await session.write(bytes.subarray(offset, offset + 65536));
        check();
      }
    });
    writeTail = operation.catch(fail);
    return operation;
  };
  const receive = (bytes: Buffer) => {
    if (++messages > 512 || bytes.length > 512 * 1024 || !bytes.length) throw workerMeshRejected();
    const rpc = workerMeshRecord(
      snapshotWorkerMeshValue(
        JSON.parse(
          new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes),
        ),
        512 * 1024,
        true,
      ),
      ["jsonrpc", "id", "method", "params", "result", "error"],
      ["id", "method", "params", "result", "error"],
    );
    if (rpc.jsonrpc !== "2.0") throw workerMeshRejected();
    if (rpc.method !== undefined) {
      if (
        typeof rpc.method !== "string" ||
        !rpc.method.length ||
        rpc.method.length > 128 ||
        rpc.result !== undefined ||
        rpc.error !== undefined ||
        (rpc.params !== undefined && (!rpc.params || typeof rpc.params !== "object" || Array.isArray(rpc.params)))
      )
        throw workerMeshRejected();
      if (rpc.id === undefined) {
        // A changed catalog invalidates the discovery used by this one-call owner.
        if (rpc.method === "notifications/tools/list_changed" || rpc.method === "notifications/cancelled")
          throw workerMeshRejected();
        return; // Bounded server diagnostics/progress never become tool output.
      }
      if (
        !(typeof rpc.id === "string" && rpc.id.length > 0 && rpc.id.length <= 128) &&
        !(typeof rpc.id === "number" && Number.isSafeInteger(rpc.id))
      )
        throw workerMeshRejected();
      // No client capabilities are advertised. Only the mandatory ping is served.
      void send({
        jsonrpc: "2.0",
        id: rpc.id,
        ...(rpc.method === "ping" ? { result: {} } : { error: { code: -32601, message: "Client method unavailable" } }),
      }).catch(fail);
      return;
    }
    if (
      rpc.params !== undefined ||
      !pending ||
      rpc.id !== pending.id ||
      rpc.error !== undefined ||
      !rpc.result ||
      typeof rpc.result !== "object" ||
      Array.isArray(rpc.result)
    )
      throw workerMeshRejected();
    const request = pending;
    pending = undefined;
    request.resolve(rpc.result as Record<string, unknown>);
  };
  const reading = (async () => {
    try {
      for (;;) {
        const chunk = await session.read();
        if (!chunk) break;
        check();
        outputBytes += chunk.bytes.length;
        if (outputBytes > 8 * 1024 * 1024) throw workerMeshRejected();
        if (chunk.stream === "stderr") continue;
        if (chunk.stream !== "stdout" || buffered.length + chunk.bytes.length > 512 * 1024 + 65536)
          throw workerMeshRejected();
        buffered = Buffer.concat([buffered, chunk.bytes]);
        let end: number;
        while ((end = buffered.indexOf(10)) >= 0) {
          receive(buffered.subarray(0, end));
          buffered = buffered.subarray(end + 1);
        }
        if (buffered.length > 512 * 1024) throw workerMeshRejected();
      }
      if (!closing || pending || buffered.length) throw workerMeshRejected();
    } catch {
      fail();
    }
  })();
  return Object.freeze({
    call: async (method: string, params: Record<string, unknown>, notification = false) => {
      check();
      if (closing || pending || typeof method !== "string" || !method.length || method.length > 128)
        throw workerMeshRejected();
      const id = ++sequence;
      let response: Promise<Record<string, unknown>> | undefined;
      if (!notification) {
        response = new Promise((resolve, reject) => {
          pending = { id, resolve, reject };
        });
        void response.catch(() => undefined);
      }
      try {
        await send({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params });
        const result = await response;
        check();
        return result;
      } catch {
        fail();
        throw workerMeshRejected();
      }
    },
    finish: async () => {
      check();
      if (closing || pending || finished) throw workerMeshRejected();
      closing = true;
      try {
        await writeTail;
        check();
        await runWorkerMcpStep(signal, assertCurrent);
        check();
        await session.endInput();
        await reading;
        check();
        const result = await session.completion;
        if (
          result.end !== 0 ||
          result.error ||
          result.bridgeError ||
          result.processExitCode !== 0 ||
          !result.processId ||
          !result.runtimeBundleVerified ||
          !result.appContainerVerified ||
          !result.launchFilesVerified ||
          !result.processImageVerified ||
          !result.zeroProcessesVerified ||
          !result.outputDrained ||
          !result.standardInputComplete
        )
          throw workerMeshRejected();
        finished = true;
      } catch {
        fail();
        await stopPromise;
        throw workerMeshRejected();
      } finally {
        signal.removeEventListener("abort", fail);
      }
    },
    stop: async () => {
      if (!finished) fail();
      await stopPromise;
      await reading;
      signal.removeEventListener("abort", fail);
    },
  });
}
