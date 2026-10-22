// Inert stdio MCP stub for the Claude Code CLI tool bridge.
//
// The Claude Code CLI spawns this file as a stdio MCP server so it can SEE the
// GoatCitadel tool manifest. The stub only declares tools: it answers
// `initialize` and `tools/list`, and it never answers `tools/call`. The Gateway
// kills the CLI when a tool call appears and runs the call through its own
// governed runner, so this process must be unable to execute anything.
//
// Constraints that keep it inert:
// - it imports only `node:fs` and `node:process` (a test pins this);
// - it uses erasable TypeScript only, so `node <this file>.ts` runs under Node
//   type stripping without a build step.

import fs from "node:fs";
import process from "node:process";

export interface ClaudeCliStubTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const CLAUDE_CLI_STUB_MAX_LINE_BYTES = 1024 * 1024;

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const METHOD_NOT_FOUND = -32601;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function success(id: string | number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function failure(id: string | number, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * Returns the JSON-RPC reply line (no trailing newline), or `undefined` for
 * notifications, `tools/call` and unparseable input.
 */
export function handleClaudeCliStubLine(tools: readonly ClaudeCliStubTool[], line: string): string | undefined {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(message) || typeof message.method !== "string") {
    return undefined;
  }
  const id = message.id;
  // A message without an id is a notification and never gets a reply.
  if (typeof id !== "string" && typeof id !== "number") {
    return undefined;
  }
  switch (message.method) {
    case "initialize": {
      const params = isRecord(message.params) ? message.params : {};
      const protocolVersion =
        typeof params.protocolVersion === "string" && params.protocolVersion.length > 0
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
      return success(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "goatcitadel", version: "1" },
      });
    }
    case "tools/list":
      return success(id, { tools });
    case "tools/call":
      // Never answered. The Gateway executes the call itself.
      return undefined;
    default:
      return failure(id, METHOD_NOT_FOUND, "Method not found");
  }
}

function isStubTool(value: unknown): value is ClaudeCliStubTool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.description === "string" &&
    isRecord(value.inputSchema)
  );
}

function loadTools(manifestPath: string | undefined): ClaudeCliStubTool[] | undefined {
  if (manifestPath === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.tools) || !parsed.tools.every(isStubTool)) {
      return undefined;
    }
    return parsed.tools;
  } catch {
    return undefined;
  }
}

function fail(reason: string): never {
  process.stderr.write(`goatcitadel mcp stub: ${reason}\n`);
  process.exit(1);
}

function serve(tools: readonly ClaudeCliStubTool[]): void {
  let pending: Buffer = Buffer.alloc(0);

  const reply = (line: string): void => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    const out = handleClaudeCliStubLine(tools, text);
    if (out !== undefined) {
      process.stdout.write(`${out}\n`);
    }
  };

  process.stdin.on("data", (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let newline = pending.indexOf(0x0a);
    while (newline !== -1) {
      if (newline > CLAUDE_CLI_STUB_MAX_LINE_BYTES) {
        fail("stdin line too long");
      }
      reply(pending.subarray(0, newline).toString("utf8"));
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(0x0a);
    }
    if (pending.length > CLAUDE_CLI_STUB_MAX_LINE_BYTES) {
      fail("stdin line too long");
    }
  });
  process.stdin.on("end", () => {
    process.exit(0);
  });
  process.stdin.on("error", () => {
    process.exit(1);
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return fs.realpathSync.native(import.meta.filename) === fs.realpathSync.native(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const tools = loadTools(process.argv[2]);
  if (tools === undefined) {
    fail("cannot read a valid tools manifest");
  }
  serve(tools);
}
