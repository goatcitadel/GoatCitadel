/* eslint-disable max-lines -- MCP stdio, HTTP, SSE, auth, and normalization stay together so transport policy remains auditable. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  McpInvokeRequest,
  McpNormalizedContentItem,
  McpServerRecord,
  McpToolRecord,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import { fetchAllowlisted, normalizeSafeEnvKeyNames } from "@goatcitadel/policy-engine";

const log = logger.child("mcp-runtime");

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_STREAMABLE_HTTP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_STDIO_TIMEOUT_MS = 25000;
/** Grace period before escalating a POSIX child from SIGTERM to SIGKILL. */
const MCP_TERMINATE_GRACE_MS = 3000;
const PLAYWRIGHT_SERVER_PATTERN = /\b(playwright)\b/i;
const BROWSER_SERVER_PATTERN = /\b(browser|chrome|chromium|cdp|devtools)\b/i;
const FETCH_SERVER_PATTERN = /\b(fetch|http|web)\b/i;

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface StdioClient {
  request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<JsonRpcEnvelope>;
  notify(method: string, params?: Record<string, unknown>): void;
  close(): void;
  readStderr(): string;
}

interface HttpMcpClient {
  request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<JsonRpcEnvelope>;
  notify(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  close(signal?: AbortSignal): Promise<void>;
}

export interface McpRuntimeTransportOptions {
  networkAllowlist?: string[];
  oauthAccessTokenResolver?: (server: McpServerRecord) => Promise<string | undefined> | string | undefined;
}

export interface McpBrowserFallbackTarget {
  serverId: string;
  label: string;
  tier: "playwright_mcp" | "browser_mcp";
  searchToolName?: string;
  navigateToolName?: string;
  extractToolName?: string;
  fetchToolName?: string;
}

export interface McpRuntimeInvocationResult {
  ok: boolean;
  output?: Record<string, unknown>;
  contentItems?: McpNormalizedContentItem[];
  error?: string;
  degraded?: boolean;
  retryCount?: number;
}

export function inferMcpToolsForServer(server: McpServerRecord, existingTools: McpToolRecord[]): McpToolRecord[] {
  if (existingTools.length > 0) {
    return existingTools;
  }
  const now = new Date().toISOString();
  const seeds = inferToolSeedNames(server);
  return seeds.map((toolName) => ({
    serverId: server.serverId,
    toolName,
    description: `Inferred ${toolName} capability for ${server.label}.`,
    enabled: true,
    updatedAt: now,
  }));
}

export async function discoverMcpTools(
  server: McpServerRecord,
  timeoutMs = DEFAULT_STDIO_TIMEOUT_MS,
  options: McpRuntimeTransportOptions = {},
): Promise<McpToolRecord[]> {
  if (server.transport === "http" || server.transport === "sse") {
    if (!server.url?.trim()) {
      return [];
    }
    return withHttpMcpClient(server, timeoutMs, options, async (client) => {
      const response = await client.request("tools/list", {});
      return normalizeDiscoveredTools(server, response);
    });
  }
  if (server.transport !== "stdio" || !server.command?.trim()) {
    return [];
  }
  return withStdioMcpClient(server, timeoutMs, async (client) => {
    const response = await client.request("tools/list", {});
    return normalizeDiscoveredTools(server, response);
  });
}

export async function invokeMcpRuntimeTool(
  server: McpServerRecord,
  input: Pick<McpInvokeRequest, "toolName" | "arguments" | "signal">,
  timeoutMs = DEFAULT_STDIO_TIMEOUT_MS,
  options: McpRuntimeTransportOptions = {},
): Promise<McpRuntimeInvocationResult> {
  if (server.transport === "http" || server.transport === "sse") {
    if (!server.url?.trim()) {
      return {
        ok: false,
        output: {
          transport: server.transport,
          liveness: "missing_url",
        },
        error: `MCP ${server.transport.toUpperCase()} URL is missing.`,
      };
    }
    try {
      const first = await performHttpMcpRuntimeToolCall(server, input, timeoutMs, options);
      if (!isExpiredMcpSessionError(first.error) || input.signal?.aborted) {
        return first;
      }
      const second = await performHttpMcpRuntimeToolCall(server, input, timeoutMs, options);
      return {
        ...second,
        degraded: true,
        retryCount: 1,
        output: second.output
          ? {
              ...second.output,
              degradedReason: "expired_session_reconnect",
            }
          : second.output,
        error: second.ok ? undefined : second.error,
      };
    } catch (error) {
      const sanitized = sanitizeMcpRuntimeError((error as Error).message);
      return {
        ok: false,
        error: sanitized,
        contentItems: [{ type: "error", text: sanitized }],
      };
    }
  }
  if (!server.command?.trim()) {
    return {
      ok: false,
      error: "MCP stdio command is missing.",
    };
  }
  try {
    const first = await performMcpRuntimeToolCall(server, input, timeoutMs);
    if (!isExpiredMcpSessionError(first.error) || input.signal?.aborted) {
      return first;
    }
    const second = await performMcpRuntimeToolCall(server, input, timeoutMs);
    return {
      ...second,
      degraded: true,
      retryCount: 1,
      output: second.output
        ? {
            ...second.output,
            degradedReason: "expired_session_reconnect",
          }
        : second.output,
      error: second.ok ? undefined : second.error,
    };
  } catch (error) {
    const sanitized = sanitizeMcpRuntimeError((error as Error).message);
    const message = `MCP stdio request failed: ${sanitized}`;
    return {
      ok: false,
      error: message,
      contentItems: [{ type: "error", text: message }],
    };
  }
}

function normalizeDiscoveredTools(server: McpServerRecord, response: JsonRpcEnvelope): McpToolRecord[] {
  const tools = Array.isArray(response.result?.tools) ? (response.result?.tools as Array<Record<string, unknown>>) : [];
  const updatedAt = new Date().toISOString();
  const discovered: McpToolRecord[] = [];
  for (const tool of tools) {
    const toolName = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!toolName) {
      continue;
    }
    discovered.push({
      serverId: server.serverId,
      toolName,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : undefined,
      enabled: true,
      updatedAt,
    });
  }
  return discovered;
}

async function performMcpRuntimeToolCall(
  server: McpServerRecord,
  input: Pick<McpInvokeRequest, "toolName" | "arguments" | "signal">,
  timeoutMs: number,
): Promise<McpRuntimeInvocationResult> {
  return withStdioMcpClient(
    server,
    timeoutMs,
    async (client) => {
      const response = await client.request(
        "tools/call",
        {
          name: input.toolName,
          arguments: input.arguments ?? {},
        },
        input.signal,
      );
      if (response.error) {
        const detail = stringifyUnknown(response.error.data);
        const error = sanitizeMcpRuntimeError(
          [`MCP tool ${input.toolName} failed`, response.error.message, detail ? `details: ${detail}` : undefined]
            .filter(Boolean)
            .join(": "),
        );
        return {
          ok: false,
          error,
          contentItems: [{ type: "error", text: error }],
        };
      }
      const result = response.result ?? {};
      const content = Array.isArray(result.content) ? result.content : [];
      const contentItems = normalizeMcpContentItems(content, result);
      const contentText = extractMcpContentTextFromItems(contentItems);
      const output: Record<string, unknown> = {
        ...result,
        content: contentItems.length > 0 ? contentItems : undefined,
        contentText: contentText || undefined,
      };
      if (result.isError === true) {
        const error = sanitizeMcpRuntimeError(contentText || `MCP tool ${input.toolName} reported an error.`);
        return {
          ok: false,
          output,
          contentItems: contentItems.length > 0 ? contentItems : [{ type: "error", text: error }],
          error,
        };
      }
      return {
        ok: true,
        output,
        contentItems,
      };
    },
    input.signal,
  );
}

async function performHttpMcpRuntimeToolCall(
  server: McpServerRecord,
  input: Pick<McpInvokeRequest, "toolName" | "arguments" | "signal">,
  timeoutMs: number,
  options: McpRuntimeTransportOptions,
): Promise<McpRuntimeInvocationResult> {
  return withHttpMcpClient(
    server,
    timeoutMs,
    options,
    async (client) => {
      const response = await client.request(
        "tools/call",
        {
          name: input.toolName,
          arguments: input.arguments ?? {},
        },
        input.signal,
      );
      if (response.error) {
        const detail = stringifyUnknown(response.error.data);
        const error = sanitizeMcpRuntimeError(
          [`MCP tool ${input.toolName} failed`, response.error.message, detail ? `details: ${detail}` : undefined]
            .filter(Boolean)
            .join(": "),
        );
        return {
          ok: false,
          error,
          contentItems: [{ type: "error", text: error }],
        };
      }
      const result = response.result ?? {};
      const content = Array.isArray(result.content) ? result.content : [];
      const contentItems = normalizeMcpContentItems(content, result);
      const contentText = extractMcpContentTextFromItems(contentItems);
      const output: Record<string, unknown> = {
        ...result,
        content: contentItems.length > 0 ? contentItems : undefined,
        contentText: contentText || undefined,
      };
      if (result.isError === true) {
        const error = sanitizeMcpRuntimeError(contentText || `MCP tool ${input.toolName} reported an error.`);
        return {
          ok: false,
          output,
          contentItems: contentItems.length > 0 ? contentItems : [{ type: "error", text: error }],
          error,
        };
      }
      return {
        ok: true,
        output,
        contentItems,
      };
    },
    input.signal,
  );
}

function isExpiredMcpSessionError(error?: string): boolean {
  return Boolean(
    error &&
    (/\b(expired|stale|invalid)\s+(session|connection|transport)\b/i.test(error) ||
      /\b(closed|reset|econnreset|socket hang up|terminated)\b/i.test(error)),
  );
}

export function collectMcpBrowserFallbackTargets(
  servers: McpServerRecord[],
  tools: McpToolRecord[],
  isToolApproved: (serverId: string, toolName: string) => boolean,
): McpBrowserFallbackTarget[] {
  const enabledTools = tools.filter((tool) => tool.enabled);
  const byServerId = new Map<string, McpToolRecord[]>();
  for (const tool of enabledTools) {
    const bucket = byServerId.get(tool.serverId) ?? [];
    bucket.push(tool);
    byServerId.set(tool.serverId, bucket);
  }

  const targets: McpBrowserFallbackTarget[] = [];
  for (const server of servers) {
    if (!server.enabled || server.status !== "connected" || server.trustTier === "quarantined" || server.lastError) {
      continue;
    }
    const serverTools = byServerId.get(server.serverId) ?? [];
    const approvedTools = serverTools.filter(
      (tool) => !server.policy.requireFirstToolApproval || isToolApproved(server.serverId, tool.toolName),
    );
    const target = buildBrowserFallbackTarget(server, approvedTools);
    if (!target) {
      continue;
    }
    targets.push(target);
  }

  return targets.sort((left, right) => compareFallbackTargets(left, right));
}

function buildBrowserFallbackTarget(
  server: McpServerRecord,
  tools: McpToolRecord[],
): McpBrowserFallbackTarget | undefined {
  const tier = inferBrowserTier(server, tools);
  if (!tier) {
    return undefined;
  }
  const searchToolName = selectToolName(tools, "search");
  const navigateToolName = selectToolName(tools, "navigate");
  const extractToolName = selectToolName(tools, "extract");
  const fetchToolName = selectToolName(tools, "fetch");
  if (!searchToolName && !navigateToolName && !extractToolName && !fetchToolName) {
    return undefined;
  }
  return {
    serverId: server.serverId,
    label: server.label,
    tier,
    searchToolName,
    navigateToolName,
    extractToolName,
    fetchToolName,
  };
}

function inferBrowserTier(
  server: McpServerRecord,
  tools: McpToolRecord[],
): McpBrowserFallbackTarget["tier"] | undefined {
  const haystack = [
    server.label,
    server.category,
    server.command,
    ...(server.args ?? []),
    ...tools.flatMap((tool) => [tool.toolName, tool.description ?? ""]),
  ]
    .filter(Boolean)
    .join(" ");
  if (PLAYWRIGHT_SERVER_PATTERN.test(haystack)) {
    return "playwright_mcp";
  }
  if (BROWSER_SERVER_PATTERN.test(haystack) || server.category === "browser" || server.category === "automation") {
    return "browser_mcp";
  }
  return undefined;
}

function compareFallbackTargets(left: McpBrowserFallbackTarget, right: McpBrowserFallbackTarget): number {
  if (left.tier !== right.tier) {
    return left.tier === "playwright_mcp" ? -1 : 1;
  }
  return left.label.localeCompare(right.label);
}

function selectToolName(
  tools: McpToolRecord[],
  capability: "search" | "navigate" | "extract" | "fetch",
): string | undefined {
  const scored = tools
    .map((tool) => ({
      toolName: tool.toolName,
      score: scoreToolCapability(tool, capability),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.toolName.localeCompare(right.toolName));
  return scored[0]?.toolName;
}

function scoreToolCapability(
  tool: Pick<McpToolRecord, "toolName" | "description">,
  capability: "search" | "navigate" | "extract" | "fetch",
): number {
  const haystack = `${tool.toolName} ${tool.description ?? ""}`.toLowerCase();
  if (capability === "search") {
    if (/\b(search|query|find)\b/.test(haystack)) {
      return 5;
    }
    if (/\b(fetch)\b/.test(haystack)) {
      return 2;
    }
    return 0;
  }
  if (capability === "navigate") {
    if (/\b(navigate|open|visit|goto|page)\b/.test(haystack)) {
      return 5;
    }
    if (/\b(fetch|extract|snapshot|content)\b/.test(haystack)) {
      return 2;
    }
    return 0;
  }
  if (capability === "extract") {
    if (/\b(extract|markdown|content|read|snapshot|scrape)\b/.test(haystack)) {
      return 5;
    }
    if (/\b(fetch|navigate|open|page)\b/.test(haystack)) {
      return 2;
    }
    return 0;
  }
  if (/\b(fetch|read|get|page|content|extract)\b/.test(haystack)) {
    return 4;
  }
  if (/\b(navigate|open|visit)\b/.test(haystack)) {
    return 2;
  }
  return 0;
}

function inferToolSeedNames(server: McpServerRecord): string[] {
  const haystack =
    `${server.label} ${server.command ?? ""} ${(server.args ?? []).join(" ")} ${server.category}`.toLowerCase();
  if (PLAYWRIGHT_SERVER_PATTERN.test(haystack) || BROWSER_SERVER_PATTERN.test(haystack)) {
    return ["browser.search", "browser.navigate", "browser.extract"];
  }
  if (FETCH_SERVER_PATTERN.test(haystack) || server.category === "research") {
    return ["browser.search", "browser.extract", "http.get"];
  }
  return ["search", "fetch"];
}

/** Max bytes of stderr to retain per MCP child process invocation. */
const MCP_STDERR_MAX_BYTES = 4096;
/** Max bytes per single stdout line before it's discarded. */
const MCP_STDOUT_LINE_MAX_BYTES = 512 * 1024;

/** Safe system env keys always passed to MCP child processes. */
const MCP_SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "COMSPEC",
  "WINDIR",
  "NODE_ENV",
  "NODE_PATH",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
];

/**
 * Build a restricted env for MCP child processes.
 * Passes through safe system variables plus any keys explicitly
 * declared in the server's policy.allowedEnvKeys.
 */
function buildMcpChildEnv(server: McpServerRecord): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of MCP_SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  for (const key of normalizeSafeEnvKeyNames(server.policy.allowedEnvKeys)) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

/**
 * Whether a child's stdin can still accept writes. A child that exited between
 * spawn and write leaves stdin destroyed/ended; writing then emits EPIPE
 * (or ERR_STREAM_DESTROYED) which — without an error listener — crashes the
 * gateway as an unhandled stream error.
 */
function isChildStdinWritable(child: ChildProcess): boolean {
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
function writeToChildStdin(child: ChildProcess, server: McpServerRecord, payload: string): boolean {
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
function attachChildStdinErrorHandler(child: ChildProcess, server: McpServerRecord): void {
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
function terminateChild(child: ChildProcess, server: McpServerRecord): void {
  const pid = child.pid;
  if (typeof pid !== "number" || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    terminateWindowsChildTree(child, server, pid);
    return;
  }

  sendPosixSignal(child, pid, "SIGTERM");

  let killTimer: NodeJS.Timeout | undefined = setTimeout(() => {
    killTimer = undefined;
    if (child.exitCode === null && child.signalCode === null) {
      sendPosixSignal(child, pid, "SIGKILL");
    }
  }, MCP_TERMINATE_GRACE_MS);
  killTimer.unref?.();

  child.once("exit", () => {
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
  });
}

function sendPosixSignal(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (error) {
    log.warn("MCP child signal failed", {
      pid,
      signal,
      err: (error as Error).message,
    });
  }
}

function terminateWindowsChildTree(child: ChildProcess, server: McpServerRecord, pid: number): void {
  try {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", (error) => {
      log.warn("MCP taskkill failed; falling back to child.kill", {
        serverId: server.serverId,
        label: server.label,
        pid,
        err: error.message,
      });
      try {
        child.kill();
      } catch {
        // Best effort; the child may already be gone.
      }
    });
  } catch (error) {
    log.warn("MCP taskkill could not be spawned; falling back to child.kill", {
      serverId: server.serverId,
      label: server.label,
      pid,
      err: (error as Error).message,
    });
    try {
      child.kill();
    } catch {
      // Best effort; the child may already be gone.
    }
  }
}

async function withStdioMcpClient<T>(
  server: McpServerRecord,
  timeoutMs: number,
  run: (client: StdioClient) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const command = resolveSpawnCommand(server.command ?? "");
  const child = spawn(command, server.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
    env: buildMcpChildEnv(server),
    windowsHide: true,
    timeout: Math.ceil(timeoutMs * 1.5),
  });
  // Catch EPIPE/ERR_STREAM_DESTROYED on stdin so a child that exits between
  // spawn and write surfaces as a transport failure rather than crashing the
  // gateway via an unhandled stream 'error' event.
  attachChildStdinErrorHandler(child, server);
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
        terminateChild(child, server);
      }
    },
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
    return await run(client);
  } catch (error) {
    const suffix = client.readStderr().slice(0, 500);
    const message = suffix ? `${(error as Error).message} [stderr: ${suffix}]`.trim() : (error as Error).message;
    throw new Error(message, { cause: error });
  } finally {
    client.close();
  }
}

async function withHttpMcpClient<T>(
  server: McpServerRecord,
  timeoutMs: number,
  options: McpRuntimeTransportOptions,
  run: (client: HttpMcpClient) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const endpoint = server.url?.trim();
  if (!endpoint) {
    throw new Error(`MCP ${server.transport.toUpperCase()} URL is missing.`);
  }
  const allowlist = options.networkAllowlist ?? [];
  const authHeaders = await buildMcpHttpAuthHeaders(server, options);
  let nextId = 1;
  let sessionId: string | undefined;
  let protocolVersion = MCP_STREAMABLE_HTTP_PROTOCOL_VERSION;

  const postJsonRpc = async (
    envelope: JsonRpcEnvelope,
    requestSignal?: AbortSignal,
  ): Promise<{ envelope?: JsonRpcEnvelope; response: Response }> => {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...authHeaders,
    };
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
      headers["MCP-Protocol-Version"] = protocolVersion;
    }
    const response = await fetchAllowlisted(endpoint, {
      allowlist,
      timeoutMs,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
        signal: requestSignal,
      },
    });
    const responseSessionId = response.headers.get("mcp-session-id")?.trim();
    if (responseSessionId) {
      sessionId = responseSessionId;
    }
    if (!response.ok) {
      throw new Error(`MCP ${server.transport.toUpperCase()} server ${server.label} returned HTTP ${response.status}.`);
    }
    if (response.status === 202) {
      return { response };
    }
    return {
      response,
      envelope: await readHttpJsonRpcEnvelope(response, envelope.id),
    };
  };

  const request = async (
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<JsonRpcEnvelope> => {
    const id = nextId++;
    const envelope: JsonRpcEnvelope = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    const result = await postJsonRpc(envelope, signal);
    if (!result.envelope) {
      throw new Error(`MCP ${method} request to ${server.label} returned no JSON-RPC response.`);
    }
    return result.envelope;
  };

  const notify = async (method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<void> => {
    await postJsonRpc(
      {
        jsonrpc: "2.0",
        method,
        params,
      },
      signal,
    );
  };

  const close = async (signal?: AbortSignal): Promise<void> => {
    if (!sessionId) {
      return;
    }
    try {
      await fetchAllowlisted(endpoint, {
        allowlist,
        timeoutMs: Math.min(timeoutMs, 5000),
        init: {
          method: "DELETE",
          headers: {
            Accept: "application/json",
            "Mcp-Session-Id": sessionId,
            "MCP-Protocol-Version": protocolVersion,
            ...authHeaders,
          },
          signal,
        },
      });
    } catch {
      // Best-effort session cleanup. Some MCP servers respond 405 or close
      // without delete support; the per-operation bridge can safely move on.
    }
  };

  const client: HttpMcpClient = { request, notify, close };
  try {
    const initialized = await client.request(
      "initialize",
      {
        protocolVersion,
        capabilities: {},
        clientInfo: {
          name: "goatcitadel-gateway",
          version: "1.0.0",
        },
      },
      signal,
    );
    const negotiated = readString(initialized.result?.protocolVersion);
    if (negotiated) {
      protocolVersion = negotiated;
    }
    await client.notify("notifications/initialized", {}, signal);
    return await run(client);
  } finally {
    await client.close(signal);
  }
}

async function readHttpJsonRpcEnvelope(response: Response, expectedId?: number): Promise<JsonRpcEnvelope> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const body = await response.text();
  if (contentType.includes("text/event-stream")) {
    const messages = parseSseJsonRpcMessages(body);
    const matched = messages.find((message) => expectedId === undefined || message.id === expectedId);
    if (!matched) {
      throw new Error("MCP HTTP event stream did not include the expected JSON-RPC response.");
    }
    return matched;
  }
  try {
    return JSON.parse(body) as JsonRpcEnvelope;
  } catch (error) {
    throw new Error(`MCP HTTP response was not valid JSON-RPC: ${(error as Error).message}`, { cause: error });
  }
}

function parseSseJsonRpcMessages(body: string): JsonRpcEnvelope[] {
  const messages: JsonRpcEnvelope[] = [];
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length === 0) {
      return;
    }
    const raw = dataLines.join("\n").trim();
    dataLines = [];
    if (!raw) {
      return;
    }
    try {
      messages.push(JSON.parse(raw) as JsonRpcEnvelope);
    } catch {
      // Ignore non-JSON events; MCP servers may stream notifications that
      // GoatCitadel does not consume in the single-request bridge.
    }
  };
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  flush();
  return messages;
}

async function buildMcpHttpAuthHeaders(
  server: McpServerRecord,
  options: McpRuntimeTransportOptions,
): Promise<Record<string, string>> {
  if (server.authType === "none") {
    return {};
  }
  if (server.authType === "token") {
    const tokenEnvKey = normalizeSafeEnvKeyNames(server.policy.allowedEnvKeys)[0];
    const token = tokenEnvKey ? process.env[tokenEnvKey] : undefined;
    if (!token?.trim()) {
      throw new Error("MCP token auth requires a configured policy.allowedEnvKeys entry with a non-empty token.");
    }
    return {
      Authorization: `Bearer ${token.trim()}`,
    };
  }
  const token = await options.oauthAccessTokenResolver?.(server);
  if (!token?.trim()) {
    throw new Error("MCP OAuth token is unavailable; reconnect this server from Settings.");
  }
  return {
    Authorization: `Bearer ${token.trim()}`,
  };
}

function createMcpAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function resolveSpawnCommand(
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

function normalizeMcpContentItems(content: unknown[], result: Record<string, unknown>): McpNormalizedContentItem[] {
  const items: McpNormalizedContentItem[] = [];
  for (const item of content) {
    const normalized = normalizeMcpContentItem(item);
    if (normalized) {
      items.push(normalized);
    }
  }
  if (items.length === 0 && hasNonStructuredFallbackResult(result)) {
    items.push({ type: "text", text: `MCP tool result JSON: ${safeMcpJsonText(result)}` });
  }
  return items;
}

function normalizeMcpContentItem(item: unknown): McpNormalizedContentItem | undefined {
  if (typeof item === "string") {
    const text = item.trim();
    return text ? { type: "text", text } : undefined;
  }
  if (!isRecord(item)) {
    return undefined;
  }
  const type = typeof item.type === "string" ? item.type : undefined;
  if (type === "resource_link") {
    return {
      type: "text",
      text: formatMcpFallbackText("MCP resource link", {
        uri: readString(item.uri),
        name: readString(item.name),
        mimeType: readString(item.mimeType) ?? readString(item.mime_type),
      }),
    };
  }
  if (type === "audio") {
    return {
      type: "text",
      text: formatMcpFallbackText("MCP audio content", {
        mimeType: readString(item.mimeType) ?? readString(item.mime_type),
        name: readString(item.name),
        transcript: readString(item.transcript) ?? readString(item.text),
      }),
    };
  }
  if (type === "image" || type === "image_url") {
    const data = readString(item.data) ?? readString(item.dataBase64);
    const url = readString(item.url);
    const resourceUri = readString(item.resourceUri) ?? readString(item.uri);
    if ((!data && !url && !resourceUri) || isPlaceholderReference(url) || isPlaceholderReference(resourceUri)) {
      return {
        type: "error",
        text: "MCP image content item was quarantined because it did not include persisted media data or an accessible artifact reference.",
      };
    }
    return {
      type: "image",
      mimeType: readString(item.mimeType) ?? readString(item.mime_type),
      data,
      url,
      resourceUri,
      name: readString(item.name),
    };
  }
  if (type === "resource" || item.resource !== undefined) {
    const resource = isRecord(item.resource) ? item.resource : item;
    const uri = readString(resource.uri);
    const text = readString(resource.text);
    const blob = readString(resource.blob);
    if ((!uri && !text && !blob) || isPlaceholderReference(uri)) {
      return {
        type: "error",
        text: "MCP resource content item was quarantined because it did not include persisted content or an accessible artifact reference.",
      };
    }
    return {
      type: "text",
      text: formatMcpFallbackText("MCP resource content", {
        uri,
        mimeType: readString(resource.mimeType) ?? readString(resource.mime_type),
        name: readString(resource.name),
        text: text ? sanitizeMcpRuntimeError(text) : undefined,
        blob: blob ? `[base64 blob ${blob.length} chars]` : undefined,
      }),
    };
  }
  if (type === "json") {
    return { type: "text", text: `MCP JSON content: ${safeMcpJsonText(item.data ?? item)}` };
  }
  if (type === "text" || typeof item.text === "string" || isRecord(item.text)) {
    const text = extractMcpContentPart(item);
    return text ? { type: "text", text: sanitizeMcpRuntimeError(text) } : undefined;
  }
  return { type: "text", text: `MCP ${type ?? "unknown"} content: ${safeMcpJsonText(item)}` };
}

function extractMcpContentTextFromItems(contentItems: McpNormalizedContentItem[]): string {
  return contentItems
    .map((item) => {
      if (item.type === "text" || item.type === "error") {
        return item.text;
      }
      if (item.type === "image") {
        return item.name ?? item.resourceUri ?? item.url ?? "";
      }
      return "";
    })
    .filter((item) => item.length > 0)
    .join("\n")
    .trim();
}

function extractMcpContentPart(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text.trim();
  }
  if (isRecord(value.text) && typeof value.text.value === "string") {
    return value.text.value.trim();
  }
  if (typeof value.content === "string") {
    return value.content.trim();
  }
  return "";
}

function sanitizeMcpRuntimeError(value: string): string {
  return value
    .replace(/\b(Bearer|token|api[-_]?key|authorization)\s*[:=]\s*[A-Za-z0-9._~+/=-]{12,}/gi, "$1=[REDACTED]")
    .replace(/\bauthorization\s*:\s*Bearer\s+\S+/gi, "authorization=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?=[A-Za-z0-9_.-]*(?:secret|token|api[-_]?key))(?=[A-Za-z0-9_.-]*[-_])(?=[A-Za-z0-9_.-]{16,}\b)[A-Za-z0-9_.-]+\b/gi,
      "[REDACTED]",
    )
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._~+/=-]{12,}@/g, "[REDACTED]@")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]")
    .slice(0, 4096);
}

function formatMcpFallbackText(label: string, fields: Record<string, string | undefined>): string {
  const lines = [label];
  for (const [key, value] of Object.entries(fields)) {
    if (value) {
      lines.push(`${key}: ${value}`);
    }
  }
  return sanitizeMcpRuntimeError(lines.join("\n")).slice(0, 4096);
}

function safeMcpJsonText(value: unknown): string {
  return sanitizeMcpRuntimeError(stringifyUnknown(value) ?? "undefined").slice(0, 4096);
}

function hasNonStructuredFallbackResult(result: Record<string, unknown>): boolean {
  return Object.keys(result).some((key) => key !== "content" && key !== "structuredContent" && key !== "isError");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isPlaceholderReference(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "about:blank" || normalized.startsWith("placeholder:")) {
    return true;
  }
  return /^[<[{(]?\s*(?:image|media|attachment|artifact|resource|file)(?:[\s_-]+placeholder)?\s*[>\]})]?$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringifyUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Internal helpers exposed for focused lifecycle tests. Not part of the public API. */
export const __internal = {
  MCP_TERMINATE_GRACE_MS,
  attachChildStdinErrorHandler,
  isChildStdinWritable,
  resolveSpawnCommand,
  terminateChild,
  writeToChildStdin,
};
