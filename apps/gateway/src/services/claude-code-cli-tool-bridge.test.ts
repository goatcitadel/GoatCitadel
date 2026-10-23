import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCliError, buildClaudeCliArgs } from "./claude-code-cli-process.js";
import {
  CLAUDE_CLI_MCP_SERVER_NAME,
  CLAUDE_CLI_MCP_TOOL_PREFIX,
  buildClaudeCliToolManifest,
  resolveClaudeCliStubPath,
  writeClaudeCliBridgeFiles,
} from "./claude-code-cli-tool-bridge.js";

function fn(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "function", function: { name, ...extra } };
}

const tempDirs: string[] = [];
function tempDir(...segments: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-bridge-test-"));
  tempDirs.push(root);
  const dir = path.join(root, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildClaudeCliToolManifest", () => {
  it("uses runner model names", () => {
    const manifest = buildClaudeCliToolManifest([
      fn("documents_create", { description: "Create a doc", parameters: { type: "object", properties: { a: {} } } }),
    ]);
    expect(CLAUDE_CLI_MCP_SERVER_NAME).toBe("goatcitadel");
    expect(CLAUDE_CLI_MCP_TOOL_PREFIX).toBe("mcp__goatcitadel__");
    expect(manifest.cliNameToModelName.get("mcp__goatcitadel__documents_create")).toBe("documents_create");
    expect(manifest.tools).toEqual([
      {
        name: "documents_create",
        description: "Create a doc",
        inputSchema: { type: "object", properties: { a: {} } },
      },
    ]);
  });

  it("defaults a missing description and parameters", () => {
    const manifest = buildClaudeCliToolManifest([fn("ping")]);
    expect(manifest.tools[0]).toEqual({
      name: "ping",
      description: "",
      inputSchema: { type: "object", properties: {} },
    });
  });

  it("forces an object-typed inputSchema for loose parameter schemas", () => {
    const manifest = buildClaudeCliToolManifest([
      { type: "function", function: { name: "list_dir", parameters: {} } },
      { type: "function", function: { name: "read", parameters: { properties: { p: { type: "string" } } } } },
    ]);
    expect(manifest.tools.map((tool) => tool.inputSchema)).toEqual([
      { type: "object" },
      { type: "object", properties: { p: { type: "string" } } },
    ]);
  });

  it("aliases names over 64 characters with the prefix and maps them back", () => {
    const longName = "x".repeat(50);
    const manifest = buildClaudeCliToolManifest([fn("short"), fn(longName)]);
    const keys = [...manifest.cliNameToModelName.keys()];
    expect(keys[0]).toBe("mcp__goatcitadel__short");
    expect(keys[1]).toMatch(/^mcp__goatcitadel__t1_[0-9a-f]{8}$/);
    expect(keys[1]?.length).toBeLessThanOrEqual(64);
    expect(manifest.cliNameToModelName.get(keys[1] as string)).toBe(longName);
    expect(manifest.tools[1]?.name).toMatch(/^t1_[0-9a-f]{8}$/);
    const single = buildClaudeCliToolManifest([fn(longName)]);
    expect([...single.cliNameToModelName.keys()][0]).toMatch(/^mcp__goatcitadel__t0_[0-9a-f]{8}$/);
  });

  it("keeps a name exactly at the 64 character limit", () => {
    const name = "y".repeat(64 - CLAUDE_CLI_MCP_TOOL_PREFIX.length);
    const manifest = buildClaudeCliToolManifest([fn(name)]);
    expect(manifest.tools[0]?.name).toBe(name);
  });

  it("has a stable hash for equal input and a fresh nonce", () => {
    const a = buildClaudeCliToolManifest([fn("one"), fn("two")]);
    const b = buildClaudeCliToolManifest([fn("one"), fn("two")]);
    const c = buildClaudeCliToolManifest([fn("one"), fn("three")]);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).not.toBe(c.sha256);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("throws bridge_unavailable for a tool without a function name and for duplicates", () => {
    for (const bad of [[{ type: "function" }], [fn("")], [fn("a"), fn("a")]]) {
      try {
        buildClaudeCliToolManifest(bad);
        expect.unreachable("expected a throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ClaudeCliError);
        expect((error as ClaudeCliError).reasonCode).toBe("claude_cli_bridge_unavailable");
      }
    }
  });
});

describe("writeClaudeCliBridgeFiles", () => {
  it("writes mcp.json that launches node with the stub and tools.json as array args", async () => {
    const runDir = tempDir("Jane Doe", "ü run");
    const manifest = buildClaudeCliToolManifest([fn("documents_create")]);
    const nodePath = path.join(runDir, "node.exe");
    const stubPath = path.join(runDir, "stub dir", "claude-code-cli-mcp-stub.js");
    const { mcpConfigPath } = await writeClaudeCliBridgeFiles({ runDir, manifest, nodePath, stubPath });
    expect(mcpConfigPath).toBe(path.join(runDir, "mcp.json"));
    const toolsPath = path.join(runDir, "tools.json");
    const config = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8")) as Record<string, unknown>;
    expect(config).toEqual({
      mcpServers: {
        goatcitadel: { type: "stdio", command: nodePath, args: [stubPath, toolsPath], env: {} },
      },
    });
    const args = (config.mcpServers as { goatcitadel: { args: string[] } }).goatcitadel.args;
    expect(args[1]).toBe(toolsPath);
    const tools = JSON.parse(fs.readFileSync(toolsPath, "utf8")) as Record<string, unknown>;
    expect(tools.tools).toEqual(manifest.tools);
    expect(tools.sha256).toBe(manifest.sha256);
    expect(tools.nonce).toBe(manifest.nonce);
    expect(fs.statSync(path.join(runDir, "results")).isDirectory()).toBe(true);
  });
});

describe("resolveClaudeCliStubPath", () => {
  it("prefers the compiled js, falls back to ts, else undefined", () => {
    const dir = tempDir("services");
    const js = path.join(dir, "claude-code-cli-mcp-stub.js");
    const ts = path.join(dir, "claude-code-cli-mcp-stub.ts");
    expect(resolveClaudeCliStubPath((p) => p === js || p === ts, dir)).toBe(js);
    expect(resolveClaudeCliStubPath((p) => p === ts, dir)).toBe(ts);
    expect(resolveClaudeCliStubPath(() => false, dir)).toBeUndefined();
  });

  it("resolves against a real dist-shaped layout on disk", () => {
    const js = "claude-code-cli-mcp-stub.js";
    const ts = "claude-code-cli-mcp-stub.ts";
    const distOnly = tempDir("dist-only", "services");
    fs.writeFileSync(path.join(distOnly, js), "");
    expect(resolveClaudeCliStubPath(fs.existsSync, distOnly)).toBe(path.join(distOnly, js));

    const both = tempDir("both", "services");
    fs.writeFileSync(path.join(both, js), "");
    fs.writeFileSync(path.join(both, ts), "");
    expect(resolveClaudeCliStubPath(fs.existsSync, both)).toBe(path.join(both, js));

    const neither = tempDir("neither", "services");
    expect(resolveClaudeCliStubPath(fs.existsSync, neither)).toBeUndefined();
  });

  it("finds the stub source next to this module by default", () => {
    expect(resolveClaudeCliStubPath(fs.existsSync)).toMatch(/claude-code-cli-mcp-stub\.(ts|js)$/);
  });
});

describe("buildClaudeCliArgs bridge option", () => {
  it("adds the MCP config and allow rule, and drops safe mode", () => {
    const mcpConfigPath = path.join("runs", "Jane Doe", "mcp.json");
    const args = buildClaudeCliArgs({ model: "sonnet", systemPromptFile: "sys.txt", bridge: { mcpConfigPath } });
    expect(args).not.toContain("--safe-mode");
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("--mcp-config");
    expect(args[2]).toBe(mcpConfigPath);
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__goatcitadel");
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
  });

  it("is unchanged without a bridge", () => {
    expect(buildClaudeCliArgs({ model: "sonnet", systemPromptFile: "sys.txt" })).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--include-hook-events",
      "--model",
      "sonnet",
      "--system-prompt-file",
      "sys.txt",
      "--tools",
      "",
      "--strict-mcp-config",
      "--safe-mode",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
      "--settings",
      JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
    ]);
  });
});
