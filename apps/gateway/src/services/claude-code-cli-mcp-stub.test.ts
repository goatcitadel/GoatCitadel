import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_RESULTS_DIR,
  CLAUDE_CLI_STUB_MAX_LINE_BYTES,
  CLAUDE_CLI_TOOL_USE_ID_PATTERN,
  buildClaudeCliStubCallResult,
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

function toolCall(id: number | string, toolUseId?: string): string {
  return request(id, "tools/call", {
    name: "read_file",
    arguments: { path: "a.txt" },
    _meta: toolUseId === undefined ? {} : { "claudecode/toolUseId": toolUseId },
  });
}

function parseReply(reply: string | undefined): Record<string, any> {
  expect(reply).toBeDefined();
  return JSON.parse(reply as string) as Record<string, any>;
}

describe("handleClaudeCliStubLine", () => {
  it("initialize echoes the client protocolVersion and advertises tools", () => {
    const reply = parseReply(
      handleClaudeCliStubLine(TOOLS, request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {} }))
        .reply,
    );
    expect(reply.jsonrpc).toBe("2.0");
    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBe("2025-11-25");
    expect(reply.result.capabilities).toEqual({ tools: {} });
    expect(reply.result.serverInfo.name).toBe("goatcitadel");
  });

  it("tools/list returns exactly the manifest tools", () => {
    const reply = parseReply(handleClaudeCliStubLine(TOOLS, request("abc", "tools/list")).reply);
    expect(reply.id).toBe("abc");
    expect(reply.result).toEqual({ tools: TOOLS });
  });

  it("tools/call is held by toolUseId", () => {
    const out = handleClaudeCliStubLine(TOOLS, toolCall(7, "toolu_01ABC"));
    expect(out).toEqual({ hold: { rpcId: 7, toolUseId: "toolu_01ABC" } });
  });

  // An error answer would make the CLI write its own tool_result and call the model itself,
  // so a call the stub cannot bind is neither answered nor held.
  it("tools/call without a toolUseId is neither answered nor held", () => {
    expect(handleClaudeCliStubLine(TOOLS, toolCall(8))).toEqual({});
    const noMeta = request(9, "tools/call", { name: "read_file", arguments: {} });
    expect(handleClaudeCliStubLine(TOOLS, noMeta)).toEqual({});
  });

  it("tools/call with a toolUseId that is not a plain toolu_ token is neither answered nor held", () => {
    const badIds: unknown[] = [
      123,
      null,
      "toolu_../../x",
      "toolu_",
      "",
      "x".repeat(200),
      `toolu_${"a".repeat(129)}`,
      "other_1",
      "toolu_a/b",
    ];
    for (const toolUseId of badIds) {
      const line = request(10, "tools/call", {
        name: "read_file",
        arguments: {},
        _meta: { "claudecode/toolUseId": toolUseId },
      });
      expect(handleClaudeCliStubLine(TOOLS, line)).toEqual({});
    }
    expect(CLAUDE_CLI_TOOL_USE_ID_PATTERN.test(`toolu_${"a".repeat(128)}`)).toBe(true);
  });

  it("buildClaudeCliStubCallResult builds a JSON-RPC success line", () => {
    expect(JSON.parse(buildClaudeCliStubCallResult("r-1", "hi"))).toEqual({
      jsonrpc: "2.0",
      id: "r-1",
      result: { content: [{ type: "text", text: "hi" }], isError: false },
    });
  });

  it("server/discover and unknown methods return -32601 with the same id", () => {
    for (const [id, method] of [
      [3, "server/discover"],
      ["x-9", "resources/list"],
    ] as const) {
      const reply = parseReply(handleClaudeCliStubLine(TOOLS, request(id, method)).reply);
      expect(reply).toEqual({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
  });

  it("notifications produce no reply", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(handleClaudeCliStubLine(TOOLS, line)).toEqual({});
    const unknownNotification = JSON.stringify({ jsonrpc: "2.0", method: "whatever/else" });
    expect(handleClaudeCliStubLine(TOOLS, unknownNotification)).toEqual({});
  });

  it("unparseable input produces no reply", () => {
    expect(handleClaudeCliStubLine(TOOLS, "not json")).toEqual({});
    expect(handleClaudeCliStubLine(TOOLS, "")).toEqual({});
    expect(handleClaudeCliStubLine(TOOLS, "[1,2]")).toEqual({});
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
  const NONCE = "nonce-for-the-stub-test";

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
    runDir: string;
  } {
    // The space in the temp dir name pins that the results path survives a run dir with spaces.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc mcp stub "));
    tempDirs.push(dir);
    const toolsPath = path.join(dir, "tools.json");
    fs.writeFileSync(toolsPath, JSON.stringify({ tools: TOOLS, nonce: NONCE }), "utf8");
    fs.mkdirSync(path.join(dir, CLAUDE_CLI_RESULTS_DIR));
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
    return { child, stdout: () => out, exited, runDir: dir };
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // The same write-then-rename the Gateway uses, so the stub never sees a half-written file.
  function stageResult(runDir: string, toolUseId: string, body: Record<string, unknown>): void {
    const target = path.join(runDir, CLAUDE_CLI_RESULTS_DIR, `${toolUseId}.json`);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(body), "utf8");
    fs.renameSync(`${target}.tmp`, target);
  }

  async function waitForLines(stdout: () => string, count: number, timeoutMs = 3000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    const lines = () =>
      stdout()
        .split("\n")
        .filter((line) => line.length > 0);
    while (lines().length < count && Date.now() < deadline) {
      await sleep(20);
    }
    return lines();
  }

  it("the stub process exits on stdin EOF and keeps a tools/call without a result held", async () => {
    const { child, stdout, exited } = startStub();
    child.stdin.write(request(1, "initialize", { protocolVersion: "2025-11-25" }) + "\n");
    child.stdin.write(request(2, "tools/list") + "\r\n");
    child.stdin.write(toolCall(3, "toolu_held") + "\n");
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

  it("a result file staged before the call is delivered when the call arrives", async () => {
    const { child, stdout, runDir } = startStub();
    stageResult(runDir, "toolu_early", { nonce: NONCE, toolUseId: "toolu_early", text: "already staged" });
    child.stdin.write(toolCall(11, "toolu_early") + "\n");
    const lines = await waitForLines(stdout, 1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      jsonrpc: "2.0",
      id: 11,
      result: { content: [{ type: "text", text: "already staged" }], isError: false },
    });
  }, 10_000);

  it("a result file staged after the call is delivered to the held call", async () => {
    const { child, stdout, runDir } = startStub();
    child.stdin.write(toolCall("late-1", "toolu_late") + "\n");
    await sleep(300);
    expect(stdout()).toBe("");
    stageResult(runDir, "toolu_late", { nonce: NONCE, toolUseId: "toolu_late", text: "later" });
    const lines = await waitForLines(stdout, 1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).id).toBe("late-1");
    expect(JSON.parse(lines[0] as string).result.content[0].text).toBe("later");
  }, 10_000);

  it("a result file with the wrong nonce or toolUseId is ignored", async () => {
    const { child, stdout, runDir } = startStub();
    stageResult(runDir, "toolu_bad", { nonce: "not-the-nonce", toolUseId: "toolu_bad", text: "forged" });
    stageResult(runDir, "toolu_swap", { nonce: NONCE, toolUseId: "toolu_other", text: "swapped" });
    child.stdin.write(toolCall(12, "toolu_bad") + "\n");
    child.stdin.write(toolCall(13, "toolu_swap") + "\n");
    await sleep(600);
    expect(stdout()).toBe("");
  }, 10_000);

  it("a tools/call without a valid toolUseId stays silent over the wire", async () => {
    const { child, stdout } = startStub();
    child.stdin.write(toolCall(15) + "\n");
    child.stdin.write(toolCall(16, "toolu_../../x") + "\n");
    await sleep(500);
    expect(stdout()).toBe("");
  }, 10_000);

  it("a partial result file is left for the next poll", async () => {
    const { child, stdout, runDir } = startStub();
    const target = path.join(runDir, CLAUDE_CLI_RESULTS_DIR, "toolu_partial.json");
    fs.writeFileSync(target, '{"nonce":"', "utf8");
    child.stdin.write(toolCall(14, "toolu_partial") + "\n");
    await sleep(300);
    expect(stdout()).toBe("");
    fs.writeFileSync(target, JSON.stringify({ nonce: NONCE, toolUseId: "toolu_partial", text: "whole" }), "utf8");
    const lines = await waitForLines(stdout, 1);
    expect(JSON.parse(lines[0] as string).result.content[0].text).toBe("whole");
  }, 10_000);

  it("a result file is delivered byte-identical", async () => {
    const { child, stdout, runDir } = startStub();
    const texts = ["名前 🐐\r\nline2", ""];
    for (const [index, text] of texts.entries()) {
      const toolUseId = `toolu_bytes${index}`;
      stageResult(runDir, toolUseId, { nonce: NONCE, toolUseId, text });
      child.stdin.write(toolCall(100 + index, toolUseId) + "\n");
    }
    const lines = await waitForLines(stdout, texts.length);
    expect(lines).toHaveLength(texts.length);
    const byId = new Map(lines.map((line) => [JSON.parse(line).id, JSON.parse(line)]));
    texts.forEach((text, index) => {
      expect(byId.get(100 + index).result.content[0].text).toBe(text);
    });
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
