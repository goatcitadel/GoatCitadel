// Parking stdio MCP stub for the Claude Code CLI tool bridge.
//
// The Claude Code CLI spawns this file as a stdio MCP server so it can SEE the
// GoatCitadel tool manifest. The stub answers `initialize` and `tools/list`.
// It holds each `tools/call` (keyed by the CLI's `claudecode/toolUseId`) until
// the Gateway, which runs the call through its own governed runner, stages the
// runner's result as `<runDir>/results/<toolUseId>.json`; the stub then
// delivers that text as the JSON-RPC answer. A call without a valid id is
// never answered (an error answer makes the CLI continue on its own). The
// stub executes nothing itself.
//
// Constraints that keep it inert:
// - it imports only `node:fs` and `node:process` (a test pins this);
// - it only reads result files and never writes to disk;
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
/** A tool-use id is used as a file name, so it must be a plain `toolu_` token on both sides. */
export const CLAUDE_CLI_TOOL_USE_ID_PATTERN = /^toolu_[A-Za-z0-9_-]{1,128}$/;
export const CLAUDE_CLI_RESULTS_DIR = "results";

export interface ClaudeCliStubOutcome {
  reply?: string;
  /** A `tools/call` the stub keeps open until its result file arrives. */
  hold?: { rpcId: string | number; toolUseId: string };
}

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const METHOD_NOT_FOUND = -32601;
const TOOL_USE_ID_META_KEY = "claudecode/toolUseId";
const RESULT_POLL_INTERVAL_MS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function success(id: string | number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function failure(id: string | number, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** The JSON-RPC success line (no trailing newline) that answers a held `tools/call`. */
export function buildClaudeCliStubCallResult(rpcId: string | number, text: string): string {
  return success(rpcId, { content: [{ type: "text", text }], isError: false });
}

function readToolUseId(params: unknown): string | undefined {
  const meta = isRecord(params) && isRecord(params._meta) ? params._meta : undefined;
  const toolUseId = meta?.[TOOL_USE_ID_META_KEY];
  return typeof toolUseId === "string" && CLAUDE_CLI_TOOL_USE_ID_PATTERN.test(toolUseId) ? toolUseId : undefined;
}

/**
 * Returns the JSON-RPC reply line (no trailing newline) and/or a `tools/call`
 * to hold. Notifications, unparseable input and a `tools/call` without a valid
 * tool-use id produce neither: that call simply stays unanswered.
 */
export function handleClaudeCliStubLine(tools: readonly ClaudeCliStubTool[], line: string): ClaudeCliStubOutcome {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return {};
  }
  if (!isRecord(message) || typeof message.method !== "string") {
    return {};
  }
  const id = message.id;
  // A message without an id is a notification and never gets a reply.
  if (typeof id !== "string" && typeof id !== "number") {
    return {};
  }
  switch (message.method) {
    case "initialize": {
      const params = isRecord(message.params) ? message.params : {};
      const protocolVersion =
        typeof params.protocolVersion === "string" && params.protocolVersion.length > 0
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
      return {
        reply: success(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "goatcitadel", version: "1" },
        }),
      };
    }
    case "tools/list":
      return { reply: success(id, { tools }) };
    case "tools/call": {
      const toolUseId = readToolUseId(message.params);
      if (toolUseId === undefined) {
        // Held unanswered, never delivered. An error answer would make the CLI write its own
        // tool_result and call the model by itself; silence lets the Gateway's tripwires end the step.
        return {};
      }
      // Answered later, once the Gateway stages the runner's result for this id.
      return { hold: { rpcId: id, toolUseId } };
    }
    default:
      return { reply: failure(id, METHOD_NOT_FOUND, "Method not found") };
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

interface StubManifest {
  tools: ClaudeCliStubTool[];
  /** Absent in a manifest that predates result delivery; then no result is ever accepted. */
  nonce: string | undefined;
}

function loadManifest(manifestPath: string | undefined): StubManifest | undefined {
  if (manifestPath === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.tools) || !parsed.tools.every(isStubTool)) {
      return undefined;
    }
    return { tools: parsed.tools, nonce: typeof parsed.nonce === "string" ? parsed.nonce : undefined };
  } catch {
    return undefined;
  }
}

// String-based on purpose: the stub may not import `node:path`.
function resultsDirFor(manifestPath: string): string {
  const separator = Math.max(manifestPath.lastIndexOf("/"), manifestPath.lastIndexOf("\\"));
  const runDir = separator === -1 ? "." : manifestPath.slice(0, separator);
  return `${runDir}/${CLAUDE_CLI_RESULTS_DIR}`;
}

/** The text of a staged result for this call, or `undefined` while it is absent, partial or not ours. */
function readStagedResult(resultsDir: string, nonce: string | undefined, toolUseId: string): string | undefined {
  if (nonce === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(`${resultsDir}/${toolUseId}.json`, "utf8"));
    if (!isRecord(parsed) || parsed.nonce !== nonce || parsed.toolUseId !== toolUseId) {
      return undefined;
    }
    return typeof parsed.text === "string" ? parsed.text : undefined;
  } catch {
    // Missing or partial: the next watch event or poll tries again.
    return undefined;
  }
}

function fail(reason: string): never {
  process.stderr.write(`goatcitadel mcp stub: ${reason}\n`);
  process.exit(1);
}

function serve(manifest: StubManifest, manifestPath: string): void {
  const resultsDir = resultsDirFor(manifestPath);
  const held = new Map<string, string | number>();
  let pending: Buffer = Buffer.alloc(0);

  const deliver = (toolUseId: string): void => {
    const rpcId = held.get(toolUseId);
    if (rpcId === undefined) {
      return;
    }
    const text = readStagedResult(resultsDir, manifest.nonce, toolUseId);
    if (text !== undefined) {
      held.delete(toolUseId);
      process.stdout.write(`${buildClaudeCliStubCallResult(rpcId, text)}\n`);
    }
  };
  const deliverAll = (): void => {
    for (const toolUseId of [...held.keys()]) {
      deliver(toolUseId);
    }
  };

  // Watch for prompt delivery, poll as the backstop (watch events can be dropped), and
  // check on arrival because the Gateway usually stages a result before its call appears.
  try {
    const watcher = fs.watch(resultsDir, deliverAll);
    watcher.on("error", () => undefined);
    watcher.unref();
  } catch {
    // No results dir to watch; the poll still covers delivery.
  }
  setInterval(deliverAll, RESULT_POLL_INTERVAL_MS).unref();

  const reply = (line: string): void => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    const out = handleClaudeCliStubLine(manifest.tools, text);
    if (out.reply !== undefined) {
      process.stdout.write(`${out.reply}\n`);
    }
    if (out.hold !== undefined) {
      held.set(out.hold.toolUseId, out.hold.rpcId);
      deliver(out.hold.toolUseId);
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
  const manifestPath = process.argv[2];
  const manifest = loadManifest(manifestPath);
  if (manifestPath === undefined || manifest === undefined) {
    fail("cannot read a valid tools manifest");
  }
  serve(manifest, manifestPath);
}
