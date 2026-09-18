import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { McpRuntimeTransportOptions, JsonRpcEnvelope } from "./mcp-runtime.js";
import type { McpStdioSessionPool } from "./mcp-stdio-session-pool.js";
import { terminateProcessTree } from "./process-tree-killer.js";
import { isReviewedPlaywrightServer, resolveReviewedMcpLaunch } from "./reviewed-mcp-package.js";
import { assertMcpStaticEnvironmentCurrent, type McpStaticEnvironmentHandle } from "./mcp-static-environment-service.js";
import { buildMcpChildEnv, prepareStaticEnvironment } from "./mcp-transport-credentials.js";
const log = logger.child("mcp-runtime");
const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_TERMINATE_GRACE_MS = 3000;
const MCP_STDERR_MAX_BYTES = 4096;
const MCP_STDOUT_LINE_MAX_BYTES = 512 * 1024;
interface McpStdioTransportPort extends McpRuntimeTransportOptions {
  staticEnvironment?: McpStaticEnvironmentHandle;
}
interface McpStdioSessionPort { pool: McpStdioSessionPool<StdioClient>; scopeKey: string; }
export interface StdioClient {
  request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<JsonRpcEnvelope>;
  notify(method: string, params?: Record<string, unknown>): void;
  close(): void;
  isClosed(): boolean;
  readStderr(): string;
}


/**
 * Whether a child's stdin can still accept writes. A child that exited between
 * spawn and write leaves stdin destroyed/ended; writing then emits EPIPE
 * (or ERR_STREAM_DESTROYED) which — without an error listener — crashes the
 * gateway as an unhandled stream error.
 */
export function isChildStdinWritable(child: ChildProcess): boolean {
  const stdin = child.stdin;
  return Boolean(stdin) && !stdin!.destroyed && !stdin!.writableEnded && stdin!.writable !== false;
}


/**
 * Write a JSON-RPC line to a child's stdin, tolerating a broken pipe.
 *
 * A child that has already exited makes the write throw EPIPE/ERR_STREAM_DESTROYED
 * synchronously; combined with the stream-level error handler attached at spawn
 * (see {@link attachChildStdinErrorHandler}), this surfaces a vanished child as a
 * normal transport failure instead of an unhandled error that crashes the process.
 *
 * @returns `true` when the payload was handed to the stream, `false` when the
 *   pipe was unwritable/broken (caller should treat this as a child disconnect).
 */
export function writeToChildStdin(child: ChildProcess, server: McpServerRecord, payload: string): boolean {
  if (!isChildStdinWritable(child)) {
    log.warn("MCP child stdin unavailable; treating as disconnect", {
      serverId: server.serverId,
      label: server.label,
    });
    return false;
  }
  try {
    child.stdin!.write(payload);
    return true;
  } catch (error) {
    log.warn("MCP child stdin write failed; treating as disconnect", {
      serverId: server.serverId,
      label: server.label,
      err: (error as Error).message,
    });
    return false;
  }
}


/**
 * Attach a one-time error handler to a child's stdin so a broken pipe (EPIPE /
 * ERR_STREAM_DESTROYED) emitted asynchronously is caught and logged as a
 * child-disconnect rather than escalating to an unhandled error event.
 */
export function attachChildStdinErrorHandler(
  child: ChildProcess,
  server: McpServerRecord,
  onError?: (error: Error) => void,
): void {
  if (!child.stdin) {
    return;
  }
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    log.warn("MCP child stdin error", {
      serverId: server.serverId,
      label: server.label,
      code: error.code,
      err: error.message,
    });
    onError?.(createMcpChildStreamError(server, "stdin", error));
  });
}


export function createMcpChildStreamError(server: McpServerRecord, streamName: "stdin" | "stdout" | "stderr", error: Error) {
  return new Error(`MCP server ${server.label} ${streamName} stream failed: ${error.message}`, { cause: error });
}


export function attachChildOutputErrorHandlers(
  child: ChildProcess,
  server: McpServerRecord,
  onError: (error: Error) => void,
): void {
  child.stdout?.on("error", (error) => {
    onError(createMcpChildStreamError(server, "stdout", error));
  });
  child.stderr?.on("error", (error) => {
    onError(createMcpChildStreamError(server, "stderr", error));
  });
}


/**
 * Terminate an MCP child process robustly across platforms.
 *
 * - Windows: a bare SIGTERM is not forwarded by `.cmd`/`.bat` shims or by
 *   servers that spawn their own children (browser/Playwright MCP), orphaning
 *   grandchildren. We kill the whole tree with `taskkill /pid <pid> /T /F`,
 *   falling back to `child.kill()` if taskkill cannot be spawned.
 * - POSIX: send SIGTERM, then escalate to SIGKILL after a short grace period if
 *   the child has not exited. The escalation timer is cleared on normal exit so
 *   no timer/listener leaks. These children are not spawned detached, so we
 *   signal the child directly rather than guessing at a process group.
 */
export function terminateChild(child: ChildProcess, server: McpServerRecord): void {
  terminateProcessTree({
    child,
    label: "MCP child",
    context: {
      serverId: server.serverId,
      label: server.label,
    },
    logger: log,
    graceMs: MCP_TERMINATE_GRACE_MS,
  });
}


export async function withStdioMcpClient<T>(
  server: McpServerRecord,
  timeoutMs: number,
  run: (client: StdioClient) => Promise<T>,
  signal?: AbortSignal,
  session?: McpStdioSessionPort,
  options: McpStdioTransportPort = {},
): Promise<T> {
  options = await prepareStaticEnvironment(server, options);
  if (session) {
    // Hash effective spawn environment without retaining credentials in the key.
    const binding = createHash("sha256").update(JSON.stringify({
      command: server.command, args: server.args, env: buildMcpChildEnv(server, options),
      policy: server.policy, trustTier: server.trustTier, cwd: process.cwd(), timeoutMs,
      packageRoot: options.packageRoot, networkAllowlist: options.networkAllowlist,
    })).digest("hex");
    return session.pool.use(server.serverId, session.scopeKey, binding,
      (creationSignal) => createStdioMcpClient(server, timeoutMs, creationSignal, true, options), run, signal);
  }
  const client = await createStdioMcpClient(server, timeoutMs, signal, false, options);
  try {
    return await run(client);
  } catch (error) {
    throw enrichStdioError(error, client);
  } finally {
    client.close();
  }
}


export async function createStdioMcpClient(
  server: McpServerRecord,
  timeoutMs: number,
  signal?: AbortSignal,
  retained = false,
  options: McpStdioTransportPort = {},
): Promise<StdioClient> {
  const command = resolveSpawnCommand(server.command ?? "");
  // Avoid adding an asynchronous boundary to ordinary stdio initialization.
  const reviewed = isReviewedPlaywrightServer(server)
    ? await resolveReviewedMcpLaunch(server, { ...options, signal }) : undefined;
  if (options.staticEnvironment) await assertMcpStaticEnvironmentCurrent(options.staticEnvironment, server);
  signal?.throwIfAborted();
  const spawnSpec = reviewed ?? resolveSpawnSpec(command, server.args ?? []);
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
    env: buildMcpChildEnv(server, options),
    windowsHide: true,
    ...(retained ? {} : { timeout: Math.ceil(timeoutMs * 1.5) }),
  });
  const pending = new Map<
    number,
    {
      resolve: (value: JsonRpcEnvelope) => void;
      reject: (reason?: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let nextId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let closed = false;

  const rejectAll = (reason: Error) => {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      pending.delete(id);
    }
  };
  const failStream = (reason: Error) => {
    if (!closed) {
      closed = true;
      rejectAll(reason);
      terminateChild(child, server);
    }
  };

  // Catch EPIPE/ERR_STREAM_DESTROYED on stdin so a child that exits between
  // spawn and write surfaces as a transport failure rather than crashing the
  // gateway via an unhandled stream 'error' event.
  attachChildStdinErrorHandler(child, server, failStream);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (rawLine && rawLine.length <= MCP_STDOUT_LINE_MAX_BYTES) {
        let message: JsonRpcEnvelope | undefined;
        try {
          message = JSON.parse(rawLine) as JsonRpcEnvelope;
        } catch {
          message = undefined;
        }
        if (message && typeof message.id === "number" && pending.has(message.id)) {
          const entry = pending.get(message.id);
          if (entry) {
            clearTimeout(entry.timer);
            pending.delete(message.id);
            entry.resolve(message);
          }
        }
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
    if (stdoutBuffer.length > MCP_STDOUT_LINE_MAX_BYTES) {
      stdoutBuffer = "";
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderrBuffer.length < MCP_STDERR_MAX_BYTES) {
      stderrBuffer += chunk.slice(0, MCP_STDERR_MAX_BYTES - stderrBuffer.length);
    }
  });
  attachChildOutputErrorHandlers(child, server, failStream);
  child.on("error", (error) => {
    rejectAll(error);
  });
  child.on("close", (code, signal) => {
    closed = true;
    if (pending.size > 0) {
      rejectAll(
        new Error(
          `MCP server ${server.label} exited before responding (code=${code ?? "null"}, signal=${signal ?? "null"}). ${stderrBuffer.trim()}`.trim(),
        ),
      );
    }
  });

  const request = (
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<JsonRpcEnvelope> => {
    if (closed) {
      return Promise.reject(new Error(`MCP server ${server.label} is already closed.`));
    }
    const id = nextId++;
    const envelope: JsonRpcEnvelope = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    if (!writeToChildStdin(child, server, `${JSON.stringify(envelope)}\n`)) {
      closed = true;
      return Promise.reject(
        new Error(`MCP server ${server.label} disconnected before the ${method} request could be sent.`),
      );
    }
    return new Promise<JsonRpcEnvelope>((resolve, reject) => {
      const cleanupAbort = () => {
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        cleanupAbort();
        reject(
          new Error(`Timed out waiting for MCP ${method} response from ${server.label}. ${stderrBuffer.trim()}`.trim()),
        );
      }, timeoutMs);
      const wrappedResolve = (value: JsonRpcEnvelope) => {
        cleanupAbort();
        resolve(value);
      };
      const wrappedReject = (reason?: unknown) => {
        cleanupAbort();
        reject(reason);
      };
      const onAbort = signal
        ? () => {
            pending.delete(id);
            clearTimeout(timer);
            wrappedReject(createMcpAbortError());
            if (!closed) {
              // Mark closed before the child's 'close' event fires so the
              // outer finally's close() does not terminate the same pid again.
              closed = true;
              terminateChild(child, server);
            }
          }
        : undefined;
      if (signal) {
        if (signal.aborted) {
          onAbort?.();
          return;
        }
        signal.addEventListener("abort", onAbort!, { once: true });
      }
      pending.set(id, { resolve: wrappedResolve, reject: wrappedReject, timer });
    });
  };

  const notify = (method: string, params: Record<string, unknown> = {}) => {
    if (closed) {
      return;
    }
    const envelope: JsonRpcEnvelope = {
      jsonrpc: "2.0",
      method,
      params,
    };
    // Notifications are fire-and-forget; a broken pipe is logged inside the
    // helper and simply means the child is gone.
    writeToChildStdin(child, server, `${JSON.stringify(envelope)}\n`);
  };

  const client: StdioClient = {
    request,
    notify,
    close: () => {
      if (!closed) {
        closed = true;
        rejectAll(new Error("MCP session closed."));
        terminateChild(child, server);
      }
    },
    isClosed: () => closed,
    readStderr: () => stderrBuffer.trim(),
  };

  try {
    await client.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "goatcitadel-gateway",
          version: "1.0.0",
        },
      },
      signal,
    );
    client.notify("notifications/initialized", {});
    return client;
  } catch (error) {
    client.close();
    throw enrichStdioError(error, client);
  }
}


export function enrichStdioError(error: unknown, client: StdioClient): Error {
  const baseMessage = error instanceof Error ? error.message : String(error);
  const suffix = client.readStderr().slice(0, 500);
  const message = suffix && !baseMessage.includes(suffix) ? `${baseMessage} [stderr: ${suffix}]`.trim() : baseMessage;
  return new Error(message, { cause: error });
}


export function resolveSpawnCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (!command || /[\\/]/.test(command) || /\.[a-z0-9]+$/i.test(command)) {
    return command;
  }
  const normalized = command.toLowerCase();
  if (platform !== "win32") {
    if (
      normalized === "node" ||
      normalized === "npm" ||
      normalized === "npx" ||
      normalized === "pnpm" ||
      normalized === "yarn"
    ) {
      const localBin = `/usr/local/bin/${command}`;
      return exists(localBin) ? localBin : command;
    }
    return command;
  }
  if (normalized === "npm" || normalized === "npx" || normalized === "pnpm" || normalized === "yarn") {
    return `${command}.cmd`;
  }
  return command;
}


export function resolveSpawnSpec(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", buildWindowsCommand([command, ...args])],
    };
  }
  return { command, args };
}


export function buildWindowsCommand(parts: string[]): string {
  return parts.map((value) => quoteWindowsCommandArg(value)).join(" ");
}


export function quoteWindowsCommandArg(value: string): string {
  assertSafeWindowsCommandArg(value);
  if (value.length === 0) {
    return '""';
  }
  if (!/[\s&()^<>|]/.test(value)) {
    return value;
  }
  return `"${value}"`;
}


export function assertSafeWindowsCommandArg(value: string): void {
  if (/["%\r\n\0]/.test(value)) {
    throw new Error(
      "Windows shell command arguments must not contain embedded quotes, percent expansions, or control characters.",
    );
  }
}
function createMcpAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
