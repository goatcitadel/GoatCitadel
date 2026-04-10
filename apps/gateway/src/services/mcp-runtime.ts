import { spawn } from "node:child_process";
import type { McpInvokeRequest, McpServerRecord, McpToolRecord } from "@goatcitadel/contracts";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_STDIO_TIMEOUT_MS = 25000;
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
  error?: string;
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
): Promise<McpToolRecord[]> {
  if (server.transport !== "stdio" || !server.command?.trim()) {
    return [];
  }
  return withStdioMcpClient(server, timeoutMs, async (client) => {
    const response = await client.request("tools/list", {});
    const tools = Array.isArray(response.result?.tools)
      ? (response.result?.tools as Array<Record<string, unknown>>)
      : [];
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
  });
}

export async function invokeMcpRuntimeTool(
  server: McpServerRecord,
  input: Pick<McpInvokeRequest, "toolName" | "arguments" | "signal">,
  timeoutMs = DEFAULT_STDIO_TIMEOUT_MS,
): Promise<McpRuntimeInvocationResult> {
  if (server.transport !== "stdio") {
    return {
      ok: false,
      error: `MCP transport ${server.transport} is not yet supported for runtime invocation.`,
    };
  }
  if (!server.command?.trim()) {
    return {
      ok: false,
      error: "MCP stdio command is missing.",
    };
  }
  try {
    return await withStdioMcpClient(
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
          return {
            ok: false,
            error: [
              `MCP tool ${input.toolName} failed`,
              response.error.message,
              detail ? `details: ${detail}` : undefined,
            ]
              .filter(Boolean)
              .join(": "),
          };
        }
        const result = response.result ?? {};
        const content = Array.isArray(result.content) ? result.content : [];
        const contentText = extractMcpContentText(content);
        const output: Record<string, unknown> = {
          ...result,
          contentText: contentText || undefined,
        };
        if (result.isError === true) {
          return {
            ok: false,
            output,
            error: contentText || `MCP tool ${input.toolName} reported an error.`,
          };
        }
        return {
          ok: true,
          output,
        };
      },
      input.signal,
    );
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message,
    };
  }
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
  const allowedKeys = server.policy.allowedEnvKeys;
  if (Array.isArray(allowedKeys)) {
    for (const key of allowedKeys) {
      if (typeof key === "string" && key.trim() && process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
  }
  return env;
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
    child.stdin.write(`${JSON.stringify(envelope)}\n`);
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
              child.kill();
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
    child.stdin.write(`${JSON.stringify(envelope)}\n`);
  };

  const client: StdioClient = {
    request,
    notify,
    close: () => {
      if (!closed) {
        child.kill();
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
          version: "0.9.0-beta.1",
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

function createMcpAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function resolveSpawnCommand(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  if (!command || /[\\/]/.test(command) || /\.[a-z0-9]+$/i.test(command)) {
    return command;
  }
  const normalized = command.toLowerCase();
  if (normalized === "npm" || normalized === "npx" || normalized === "pnpm" || normalized === "yarn") {
    return `${command}.cmd`;
  }
  return command;
}

function extractMcpContentText(content: unknown[]): string {
  const text = content
    .map((item) => extractMcpContentPart(item))
    .filter((item) => item.length > 0)
    .join("\n")
    .trim();
  return text;
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
