import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_STUB_MAX_LINE_BYTES,
  handleClaudeCliStubLine,
  type ClaudeCliStubTool,
} from "./claude-code-cli-mcp-stub.js";

const STUB_SOURCE = path.join(import.meta.dirname, "claude-code-cli-mcp-stub.ts");

const TOOLS: readonly ClaudeCliStubTool[] = [
  {
    name: "read_file",
    description: "Read a file from the workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "list_dir",
    description: "List a directory.",
    inputSchema: { type: "object", properties: {} },
  },
];

function request(id: number | string, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
}

function parseReply(reply: string | undefined): Record<string, any> {
  expect(reply).toBeDefined();
  return JSON.parse(reply as string) as Record<string, any>;
}

describe("handleClaudeCliStubLine", () => {
  it("initialize echoes the client protocolVersion and advertises tools", () => {
    const reply = parseReply(
      handleClaudeCliStubLine(TOOLS, request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {} })),
    );
    expect(reply.jsonrpc).toBe("2.0");
    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBe("2025-11-25");
    expect(reply.result.capabilities).toEqual({ tools: {} });
    expect(reply.result.serverInfo.name).toBe("goatcitadel");
  });

  it("tools/list returns exactly the manifest tools", () => {
    const reply = parseReply(handleClaudeCliStubLine(TOOLS, request("abc", "tools/list")));
    expect(reply.id).toBe("abc");
    expect(reply.result).toEqual({ tools: TOOLS });
  });

  it("tools/call is never answered", () => {
    const line = request(7, "tools/call", { name: "read_file", arguments: { path: "a.txt" }, _meta: {} });
    expect(handleClaudeCliStubLine(TOOLS, line)).toBeUndefined();
  });

  it("server/discover and unknown methods return -32601 with the same id", () => {
    for (const [id, method] of [
      [3, "server/discover"],
      ["x-9", "resources/list"],
    ] as const) {
      const reply = parseReply(handleClaudeCliStubLine(TOOLS, request(id, method)));
      expect(reply).toEqual({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
  });

  it("notifications produce no reply", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(handleClaudeCliStubLine(TOOLS, line)).toBeUndefined();
    const unknownNotification = JSON.stringify({ jsonrpc: "2.0", method: "whatever/else" });
    expect(handleClaudeCliStubLine(TOOLS, unknownNotification)).toBeUndefined();
  });

  it("unparseable input produces no reply", () => {
    expect(handleClaudeCliStubLine(TOOLS, "not json")).toBeUndefined();
    expect(handleClaudeCliStubLine(TOOLS, "")).toBeUndefined();
    expect(handleClaudeCliStubLine(TOOLS, "[1,2]")).toBeUndefined();
  });

  it("the stub imports only node:fs and node:process", () => {
    const source = fs.readFileSync(STUB_SOURCE, "utf8");
    const specifiers = [
      ...[...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]),
      ...[...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]),
      ...[...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]),
    ];
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(["node:fs", "node:process"]).toContain(specifier);
    }
  });
});

describe("claude-code-cli-mcp-stub process", () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function startStub(): {
    child: ChildProcessWithoutNullStreams;
    stdout: () => string;
    exited: Promise<number | null>;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-mcp-stub-"));
    tempDirs.push(dir);
    const toolsPath = path.join(dir, "tools.json");
    fs.writeFileSync(toolsPath, JSON.stringify({ tools: TOOLS }), "utf8");
    const child = spawn(process.execPath, [STUB_SOURCE, toolsPath], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });
    return { child, stdout: () => out, exited };
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("the stub process exits on stdin EOF and never answers tools/call", async () => {
    const { child, stdout, exited } = startStub();
    child.stdin.write(request(1, "initialize", { protocolVersion: "2025-11-25" }) + "\n");
    child.stdin.write(request(2, "tools/list") + "\r\n");
    child.stdin.write(request(3, "tools/call", { name: "read_file", arguments: { path: "a" } }) + "\n");
    await sleep(1000);
    const lines = stdout()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).id).toBe(1);
    expect(JSON.parse(lines[1] as string).result.tools).toHaveLength(TOOLS.length);

    child.stdin.end();
    const code = await Promise.race([exited, sleep(2000).then(() => "timeout" as const)]);
    expect(code).toBe(0);
  }, 10_000);

  it("an oversized stdin line ends the stub", async () => {
    const { child, exited } = startStub();
    child.stdin.write("x".repeat(CLAUDE_CLI_STUB_MAX_LINE_BYTES + 1024));
    const code = await Promise.race([exited, sleep(3000).then(() => "timeout" as const)]);
    expect(code).not.toBe("timeout");
    expect(code).not.toBe(0);
  }, 10_000);

  it("exits non-zero when tools.json is missing", async () => {
    const child = spawn(process.execPath, [STUB_SOURCE, path.join(os.tmpdir(), "gc-mcp-stub-absent.json")], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout.resume();
    child.stderr.resume();
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).not.toBe(0);
  }, 10_000);
});
