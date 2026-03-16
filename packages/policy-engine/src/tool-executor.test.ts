import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

const mocked = vi.hoisted(() => ({
  isBrowserToolName: vi.fn<(name: string) => boolean>(),
  executeBrowserTool: vi.fn<
    (
      toolName: string,
      args: Record<string, unknown>,
      config: ToolPolicyConfig,
      executionContext?: { sessionId?: string; signal?: AbortSignal },
    ) => Promise<Record<string, unknown>>
  >(),
}));

vi.mock("./browser-tools.js", () => ({
  isBrowserToolName: mocked.isBrowserToolName,
  executeBrowserTool: mocked.executeBrowserTool,
}));

import { executeTool } from "./tool-executor.js";

const storageStub = {} as Storage;

const policyConfig: ToolPolicyConfig = {
  profiles: {
    minimal: ["session.status"],
  },
  tools: {
    profile: "minimal",
    allow: [],
    deny: [],
  },
  agents: {},
  sandbox: {
    writeJailRoots: ["./workspace"],
    readOnlyRoots: ["./skills"],
    networkAllowlist: ["localhost"],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};

const testWorkspaceRoot = path.resolve(policyConfig.sandbox.writeJailRoots[0] ?? "./workspace", "tool-executor-test");

describe("executeTool", () => {
  beforeEach(() => {
    mocked.isBrowserToolName.mockReset();
    mocked.executeBrowserTool.mockReset();
  });

  afterEach(async () => {
    await fs.rm(testWorkspaceRoot, { recursive: true, force: true });
  });

  it("dispatches browser tools to browser executor", async () => {
    mocked.isBrowserToolName.mockReturnValue(true);
    mocked.executeBrowserTool.mockResolvedValue({
      action: "navigate",
      title: "Example",
    });

    const request: ToolInvokeRequest = {
      toolName: "browser.navigate",
      args: { url: "https://example.com" },
      agentId: "researcher",
      sessionId: "sess-1",
      signal: new AbortController().signal,
    };

    const result = await executeTool(request, policyConfig, storageStub);

    expect(mocked.executeBrowserTool).toHaveBeenCalledWith(
      "browser.navigate",
      request.args,
      policyConfig,
      { sessionId: "sess-1", signal: request.signal },
    );
    expect(result).toMatchObject({ action: "navigate", title: "Example" });
  });

  it("rejects unknown non-browser tools instead of simulating success", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);

    const request: ToolInvokeRequest = {
      toolName: "custom.unknown",
      args: {},
      agentId: "agent",
      sessionId: "sess-2",
    };

    await expect(executeTool(request, policyConfig, storageStub)).rejects.toThrow(
      "Unsupported tool executor: custom.unknown",
    );
  });

  it("executes shell commands via execFile parsing", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const request: ToolInvokeRequest = {
      toolName: "shell.exec",
      args: { command: 'node -e "process.stdout.write(\'ok\')"' },
      agentId: "agent",
      sessionId: "sess-3",
    };

    const result = await executeTool(request, policyConfig, storageStub);
    expect(result).toMatchObject({
      command: request.args.command,
      executable: "node",
      exitCode: 0,
    });
    expect(String(result.stdout ?? "")).toContain("ok");
  });

  it("reads a targeted file range", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const filePath = path.join(testWorkspaceRoot, "sample.ts");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, ["alpha", "beta", "gamma", "delta"].join("\n"), "utf8");

    const request: ToolInvokeRequest = {
      toolName: "file.read_range",
      args: { path: filePath, startLine: 2, endLine: 3 },
      agentId: "agent",
      sessionId: "sess-range",
    };

    const result = await executeTool(request, policyConfig, storageStub);
    expect(result).toMatchObject({
      path: filePath,
      startLine: 2,
      endLine: 3,
      lineCount: 2,
      content: "beta\ngamma",
    });
  });

  it("searches code content with code.search", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const filePath = path.join(testWorkspaceRoot, "src", "service.ts");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "export const failureGuidance = 'retry';\n", "utf8");

    const request: ToolInvokeRequest = {
      toolName: "code.search",
      args: { path: testWorkspaceRoot, query: "failureGuidance" },
      agentId: "agent",
      sessionId: "sess-search",
    };

    const result = await executeTool(request, policyConfig, storageStub);
    expect(result).toMatchObject({
      path: testWorkspaceRoot,
      pattern: "failureGuidance",
      count: 1,
    });
    expect(Array.isArray(result.matches)).toBe(true);
    expect((result.matches as Array<Record<string, unknown>>)[0]?.path).toBe(filePath);
  });

  it("searches file names with code.search_files", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const filePath = path.join(testWorkspaceRoot, "src", "chat-agent-orchestrator.test.ts");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "test('ok')\n", "utf8");

    const request: ToolInvokeRequest = {
      toolName: "code.search_files",
      args: { path: testWorkspaceRoot, query: "orchestrator" },
      agentId: "agent",
      sessionId: "sess-files",
    };

    const result = await executeTool(request, policyConfig, storageStub);
    expect(result).toMatchObject({
      path: testWorkspaceRoot,
      query: "orchestrator",
      count: 1,
    });
    expect((result.matches as Array<Record<string, unknown>>)[0]?.path).toBe(filePath);
  });

  it("reads saved memory entries with memory.read", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const memoryStorage = {
      knowledge: {
        listDocuments: vi.fn(() => [
          {
            docId: "doc-1",
            title: "Preferences",
            sourceRef: "memory://preferences",
            metadata: { kind: "note" },
          },
        ]),
        listChunksByDocument: vi.fn(() => [
          {
            chunkId: "chunk-1",
            content: "User prefers dark mode and vim keybindings.",
          },
        ]),
      },
    } as unknown as Storage;

    const request: ToolInvokeRequest = {
      toolName: "memory.read",
      args: { namespace: "user", query: "dark mode" },
      agentId: "agent",
      sessionId: "sess-memory-read",
    };

    const result = await executeTool(request, policyConfig, memoryStorage);
    expect(result).toMatchObject({
      namespace: "user",
      query: "dark mode",
    });
    expect(Array.isArray(result.items)).toBe(true);
    expect((result.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      docId: "doc-1",
      title: "Preferences",
    });
    expect(String((result.items as Array<Record<string, unknown>>)[0]?.snippet ?? "")).toContain("dark mode");
  });

  it("builds citation bundles without failing when sources are provided", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const request: ToolInvokeRequest = {
      toolName: "citations.build",
      args: {
        sources: [
          {
            title: "Express release notes",
            url: "https://expressjs.com/",
            description: "Latest stable release notes",
            sourceType: "web",
          },
        ],
      },
      agentId: "agent",
      sessionId: "sess-citations",
    };

    const result = await executeTool(request, policyConfig, storageStub);
    expect(result).toMatchObject({
      count: 1,
    });
    expect(Array.isArray(result.results)).toBe(true);
    expect((result.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      title: "Express release notes",
      url: "https://expressjs.com/",
      sourceType: "web",
    });
  });

  it("starts background shell commands without blocking", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const request: ToolInvokeRequest = {
      toolName: "shell.exec_background",
      args: { command: 'node -e "setTimeout(() => process.exit(0), 50)"' },
      agentId: "agent",
      sessionId: "sess-bg",
    };

    const result = await executeTool(request, policyConfig, storageStub);
    expect(result).toMatchObject({
      command: request.args.command,
      executable: "node",
      detached: true,
      started: true,
    });
    expect(typeof result.pid).toBe("number");
  });

  it("rejects malformed shell command parsing", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const request: ToolInvokeRequest = {
      toolName: "shell.exec",
      args: { command: "echo \"unterminated" },
      agentId: "agent",
      sessionId: "sess-4",
    };

    await expect(executeTool(request, policyConfig, storageStub)).rejects.toThrow(
      "unmatched quotes or escape sequence",
    );
  });

  it("blocks risky shell command without approval context", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const riskyPolicy: ToolPolicyConfig = {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        riskyShellPatterns: ["rm -rf"],
        requireApprovalForRiskyShell: true,
      },
    };
    const request: ToolInvokeRequest = {
      toolName: "shell.exec",
      args: { command: "rm -rf ./tmp" },
      agentId: "agent",
      sessionId: "sess-5",
    };

    await expect(executeTool(request, riskyPolicy, storageStub)).rejects.toThrow(
      "Risky shell command requires approval",
    );
  });

  it("allows risky shell command when approval context is provided", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const riskyPolicy: ToolPolicyConfig = {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        riskyShellPatterns: ["node --version"],
        requireApprovalForRiskyShell: true,
      },
    };
    const request: ToolInvokeRequest = {
      toolName: "shell.exec",
      args: { command: "node --version" },
      agentId: "agent",
      sessionId: "sess-6",
      consentContext: {
        source: "ui",
        reason: "approval:apr_123",
      },
    };

    const result = await executeTool(request, riskyPolicy, storageStub);
    expect(result).toMatchObject({
      command: "node --version",
    });
  });

  it("blocks bankr tools when built-in support is disabled", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const request: ToolInvokeRequest = {
      toolName: "bankr.status",
      args: {},
      agentId: "agent",
      sessionId: "sess-7",
    };

    await expect(executeTool(request, policyConfig, storageStub, {
      bankrBuiltinEnabled: false,
    })).rejects.toThrow("Bankr built-in is disabled.");
  });
});
