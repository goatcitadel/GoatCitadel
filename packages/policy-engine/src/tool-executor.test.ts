import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

import { executeTool, resolveExecutableCommand, resolveRestrictedCommand } from "./tool-executor.js";

const storageStub = {
  pendingApprovalActions: {
    find: vi.fn(() => undefined),
  },
} as unknown as Storage;

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
    vi.mocked(storageStub.pendingApprovalActions.find).mockReset();
    vi.mocked(storageStub.pendingApprovalActions.find).mockReturnValue(undefined);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.IMESSAGE_PASSWORD;
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.MATTERMOST_BOT_TOKEN;
    delete process.env.NEXTCLOUD_TALK_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.ZALO_ACCESS_TOKEN;
    delete process.env.ZALOUSER_AUTH_TOKEN;
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

  it("allows outside-root file reads when a matching grant allows wildcard paths", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const filePath = path.join(os.tmpdir(), `tool-executor-outside-${randomUUID()}.ts`);
    await fs.writeFile(filePath, ["one", "two", "three"].join("\n"), "utf8");

    const storageWithGrant = {
      toolGrants: {
        list: vi.fn(() => [
          {
            grantId: "grant-1",
            toolPattern: "file.read_range",
            decision: "allow",
            scope: "session",
            scopeRef: "sess-grant",
            grantType: "persistent",
            constraints: { allowedPaths: ["*"] },
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ]),
      },
    } as unknown as Storage;

    try {
      const result = await executeTool({
        toolName: "file.read_range",
        args: { path: filePath, startLine: 1, endLine: 2 },
        agentId: "agent",
        sessionId: "sess-grant",
      }, policyConfig, storageWithGrant);

      expect(result).toMatchObject({
        path: filePath,
        startLine: 1,
        endLine: 2,
        content: "one\ntwo",
      });
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("allows outside-root file reads only when approval context matches a pending approval action", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const filePath = path.join(os.tmpdir(), `tool-executor-approved-${randomUUID()}.ts`);
    await fs.writeFile(filePath, ["alpha", "beta"].join("\n"), "utf8");
    vi.mocked(storageStub.pendingApprovalActions.find).mockReturnValue({
      approvalId: "apr_read_123",
      actionType: "tool.invoke",
      request: {
        toolName: "file.read_range",
        args: { path: filePath, startLine: 1, endLine: 2 },
        agentId: "agent",
        sessionId: "sess-approved-read",
      },
      createdAt: "2026-03-21T00:00:00.000Z",
      resolutionStatus: "pending",
    });

    try {
      const result = await executeTool({
        toolName: "file.read_range",
        args: { path: filePath, startLine: 1, endLine: 2 },
        agentId: "agent",
        sessionId: "sess-approved-read",
        consentContext: {
          source: "ui",
          reason: "approval:apr_read_123",
        },
      }, policyConfig, storageStub);

      expect(result).toMatchObject({
        path: filePath,
        content: "alpha\nbeta",
      });
    } finally {
      await fs.rm(filePath, { force: true });
    }
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

  it("runs shell commands from the provided cwd", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const packageDir = path.join(testWorkspaceRoot, "runner");
    await fs.mkdir(packageDir, { recursive: true });

    const request: ToolInvokeRequest = {
      toolName: "shell.exec",
      args: { command: 'node -e "process.stdout.write(process.cwd())"', cwd: packageDir },
      agentId: "agent",
      sessionId: "sess-runner",
    };

    const result = await executeTool(request, policyConfig, storageStub);
    expect(result).toMatchObject({
      cwd: packageDir,
      executable: "node",
      exitCode: 0,
    });
    expect(String(result.stdout ?? "")).toContain(packageDir);
  });

  it("runs restricted tools from the provided cwd", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const packageDir = path.join(testWorkspaceRoot, "restricted-runner");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({
      name: "restricted-runner",
      private: true,
      scripts: {
        test: 'node -e "process.stdout.write(process.cwd())"',
      },
    }, null, 2), "utf8");

    const request: ToolInvokeRequest = {
      toolName: "tests.run",
      args: { manager: "npm", cwd: packageDir },
      agentId: "agent",
      sessionId: "sess-restricted-cwd",
    };

    const result = await executeTool(request, policyConfig, storageStub);
    expect(result).toMatchObject({
      manager: "npm",
      kind: "test",
      cwd: packageDir,
    });
    expect(String(result.stdout ?? "")).toContain(packageDir);
  });

  it("uses cmd.exe to resolve restricted package-manager commands on Windows", () => {
    const resolved = resolveRestrictedCommand("pnpm", ["--filter", "workspace/pkg", "run", "test"], "win32");

    expect(resolved).toEqual({
      file: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm --filter workspace/pkg run test"],
    });
  });

  it("uses cmd.exe to resolve shell package-manager commands on Windows", () => {
    const resolved = resolveExecutableCommand("pnpm", ["exec", "vitest", "run"], "win32");

    expect(resolved).toEqual({
      file: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm exec vitest run"],
    });
  });

  it("quotes shell package-manager args with spaces on Windows", () => {
    const resolved = resolveExecutableCommand("npm", ["run", "test:unit", "--", "path with spaces"], "win32");

    expect(resolved).toEqual({
      file: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", 'npm run test:unit -- "path with spaces"'],
    });
  });

  it("runs restricted package-manager commands directly on non-Windows platforms", () => {
    const resolved = resolveRestrictedCommand("npm", ["run", "lint"], "linux");

    expect(resolved).toEqual({
      file: "npm",
      args: ["run", "lint"],
    });
  });

  it("runs pnpm-backed restricted tools as package scripts", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const packageDir = path.join(testWorkspaceRoot, "restricted-pnpm-runner");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({
      name: "restricted-pnpm-runner",
      private: true,
      scripts: {
        lint: 'node -e "process.stdout.write(\'lint-script\')"',
      },
    }, null, 2), "utf8");

    const request: ToolInvokeRequest = {
      toolName: "lint.run",
      args: { manager: "pnpm", cwd: packageDir },
      agentId: "agent",
      sessionId: "sess-restricted-pnpm",
    };

    const result = await executeTool(request, policyConfig, storageStub);
    expect(result).toMatchObject({
      manager: "pnpm",
      kind: "lint",
      cwd: packageDir,
    });
    expect(String(result.stdout ?? "")).toContain("lint-script");
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
    vi.mocked(storageStub.pendingApprovalActions.find).mockReturnValue({
      approvalId: "apr_123",
      actionType: "tool.invoke",
      request: {
        toolName: "shell.exec",
        args: { command: "node --version" },
        agentId: "agent",
        sessionId: "sess-6",
      },
      createdAt: "2026-03-21T00:00:00.000Z",
      resolutionStatus: "pending",
    });
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

  it("rejects risky shell command with an unverified approval id", async () => {
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
      sessionId: "sess-spoofed-approval",
      consentContext: {
        source: "ui",
        reason: "approval:apr_spoofed",
      },
    };

    await expect(executeTool(request, riskyPolicy, storageStub)).rejects.toThrow(
      "Risky shell command requires approval",
    );
  });

  it("rejects risky background shell command with an unverified approval id", async () => {
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
      toolName: "shell.exec_background",
      args: { command: "node --version" },
      agentId: "agent",
      sessionId: "sess-bg-spoofed-approval",
      consentContext: {
        source: "ui",
        reason: "approval:apr_spoofed",
      },
    };

    await expect(executeTool(request, riskyPolicy, storageStub)).rejects.toThrow(
      "Risky shell command requires approval",
    );
  });

  it("allows risky background shell command only with a verified approval context", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const riskyPolicy: ToolPolicyConfig = {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        riskyShellPatterns: ["node --version"],
        requireApprovalForRiskyShell: true,
      },
    };
    vi.mocked(storageStub.pendingApprovalActions.find).mockReturnValue({
      approvalId: "apr_bg_123",
      actionType: "tool.invoke",
      request: {
        toolName: "shell.exec_background",
        args: { command: "node --version" },
        agentId: "agent",
        sessionId: "sess-bg-approved",
      },
      createdAt: "2026-03-21T00:00:00.000Z",
      resolutionStatus: "pending",
    });

    const result = await executeTool({
      toolName: "shell.exec_background",
      args: { command: "node --version" },
      agentId: "agent",
      sessionId: "sess-bg-approved",
      consentContext: {
        source: "ui",
        reason: "approval:apr_bg_123",
      },
    }, riskyPolicy, storageStub);

    expect(result).toMatchObject({
      command: "node --version",
      detached: true,
      started: true,
    });
  });

  it("sends channel messages through Slack bot API with rendered attachments", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      ts: "1712345678.000100",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const queuedSpy = vi.fn((input: Record<string, unknown>) => ({
      deliveryId: "delivery-1",
      status: "queued",
      channelKey: input.channelKey,
      target: input.target,
      createdAt: "2026-03-18T00:00:00.000Z",
      updatedAt: "2026-03-18T00:00:00.000Z",
    }));

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-slack",
          key: "slack",
          config: {
            botTokenEnv: "SLACK_BOT_TOKEN",
            defaultChannel: "#build-alerts",
          },
        })),
      },
      commsDeliveries: {
        createQueued: queuedSpy,
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-slack",
        message: "Build green again.",
        attachments: [{ title: "Runbook", url: "https://example.com/runbook" }],
      },
      agentId: "operator",
      sessionId: "sess-slack",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["slack.com"],
      },
    }, commsStorage);

    expect(queuedSpy).toHaveBeenCalledWith(expect.objectContaining({
      target: "#build-alerts",
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-test",
        }),
      }),
    );
    const slackCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { body?: BodyInit | null }];
    expect(String(slackCall[1]?.body ?? "")).toContain("Runbook");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "1712345678.000100",
    });
  });

  it("sends Discord webhook messages with inline uploads and URL embeds", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "discord-msg-123",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-discord",
          key: "discord",
          config: {
            webhookUrl: "https://discord.com/api/webhooks/123/abc",
            defaultChannelId: "1234567890",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-discord-send",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-discord",
        message: "Deployment artifacts attached.",
        attachments: [
          { title: "Screenshot", url: "https://example.com/screenshot.png", mimeType: "image/png" },
          { title: "build.log", mimeType: "text/plain", dataBase64: Buffer.from("log-bytes").toString("base64") },
        ],
      },
      agentId: "operator",
      sessionId: "sess-discord-send",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["discord.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123/abc?wait=true",
      expect.objectContaining({ method: "POST" }),
    );
    const discordCall = fetchMock.mock.calls[0] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(discordCall?.[1]?.body).toBeInstanceOf(FormData);
    const formData = discordCall?.[1]?.body as FormData;
    expect(String(formData.get("payload_json") ?? "")).toContain("\"content\":\"Deployment artifacts attached.\"");
    expect(String(formData.get("payload_json") ?? "")).toContain("https://example.com/screenshot.png");
    const uploadedFile = formData.get("files[0]");
    expect(uploadedFile).toBeInstanceOf(File);
    expect((uploadedFile as File).name).toBe("build.log");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "discord-msg-123",
    });
  });

  it("sends Telegram URL image attachments through sendPhoto with a caption", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.TELEGRAM_BOT_TOKEN = "tg-token";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: { message_id: 321 },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-telegram",
          key: "telegram",
          config: {
            botTokenEnv: "TELEGRAM_BOT_TOKEN",
            defaultChatId: "-1001234567890",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-telegram-send",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-telegram",
        message: "Screenshot attached.",
        attachments: [
          { title: "graph.png", url: "https://example.com/graph.png", mimeType: "image/png" },
        ],
      },
      agentId: "operator",
      sessionId: "sess-telegram-send",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["api.telegram.org"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottg-token/sendPhoto",
      expect.objectContaining({ method: "POST" }),
    );
    const telegramCall = fetchMock.mock.calls[0] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(String(telegramCall?.[1]?.body ?? "")).toContain("\"chat_id\":\"-1001234567890\"");
    expect(String(telegramCall?.[1]?.body ?? "")).toContain("\"photo\":\"https://example.com/graph.png\"");
    expect(String(telegramCall?.[1]?.body ?? "")).toContain("\"caption\":\"Screenshot attached.\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "321",
    });
  });

  it("uploads inline Slack attachments through the external upload flow", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === "https://slack.com/api/chat.postMessage") {
        return new Response(JSON.stringify({
          ok: true,
          ts: "1712345678.000200",
          channel: "C123UPLOAD",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://slack.com/api/files.getUploadURLExternal") {
        return new Response(JSON.stringify({
          ok: true,
          upload_url: "https://files.slack.com/upload/v1/test-upload",
          file_id: "F123UPLOAD",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://files.slack.com/upload/v1/test-upload") {
        return new Response("", { status: 200 });
      }
      if (url === "https://slack.com/api/files.completeUploadExternal") {
        return new Response(JSON.stringify({
          ok: true,
          files: [{ id: "F123UPLOAD", title: "evidence.txt" }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-slack-inline",
          key: "slack",
          config: {
            botTokenEnv: "SLACK_BOT_TOKEN",
            defaultChannel: "#build-alerts",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-slack-inline",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-slack-inline",
        message: "Evidence attached.",
        attachments: [{
          title: "evidence.txt",
          mimeType: "text/plain",
          dataBase64: Buffer.from("slack-inline-evidence", "utf8").toString("base64"),
        }],
      },
      agentId: "operator",
      sessionId: "sess-slack-inline",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["slack.com", "*.slack.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const uploadMetaCall = fetchMock.mock.calls[1] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(String(uploadMetaCall?.[1]?.body ?? "")).toContain("\"filename\":\"evidence.txt\"");
    expect(String(uploadMetaCall?.[1]?.body ?? "")).toContain("\"length\":21");

    const completeCall = fetchMock.mock.calls[3] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(String(completeCall?.[1]?.body ?? "")).toContain("\"channel_id\":\"C123UPLOAD\"");
    expect(String(completeCall?.[1]?.body ?? "")).toContain("\"thread_ts\":\"1712345678.000200\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "1712345678.000200",
    });
  });

  it("sends channel messages through Teams webhook adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async () => new Response("1", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-teams",
          key: "teams",
          config: {
            webhookUrl: "https://outlook.office.com/webhook/example",
            cardTitle: "GoatCitadel Test",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-2",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-teams",
        target: "ops-room",
        message: "Nightly validation passed.",
      },
      agentId: "operator",
      sessionId: "sess-teams",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["outlook.office.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://outlook.office.com/webhook/example",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const teamsCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { body?: BodyInit | null }];
    expect(String(teamsCall[1]?.body ?? "")).toContain("AdaptiveCard");
    expect(result).toMatchObject({
      status: "sent",
    });
  });

  it("sends Teams webhook attachments as adaptive card content", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async () => new Response("1", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-teams-rich",
          key: "teams",
          config: {
            webhookUrl: "https://outlook.office.com/webhook/example-rich",
            cardTitle: "GoatCitadel Test",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-teams-rich",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-teams-rich",
        message: "Nightly validation passed.",
        attachments: [
          { title: "Graph", url: "https://example.com/graph.png", mimeType: "image/png" },
          { title: "Runbook", url: "https://example.com/runbook", mimeType: "text/html" },
        ],
      },
      agentId: "operator",
      sessionId: "sess-teams-rich",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["outlook.office.com"],
      },
    }, commsStorage);

    const teamsCall = fetchMock.mock.calls[0] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    const teamsBody = String(teamsCall?.[1]?.body ?? "");
    expect(teamsBody).toContain("\"type\":\"Image\"");
    expect(teamsBody).toContain("https://example.com/graph.png");
    expect(teamsBody).toContain("[Runbook](https://example.com/runbook)");
  });

  it("sends Google Chat webhook attachments as rich cards", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      name: "spaces/AAAA/messages/123",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-google-chat",
          key: "google-chat",
          config: {
            webhookUrl: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=test&token=test",
            defaultThreadKey: "ops-thread",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-google-chat",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-google-chat",
        message: "Artifact summary attached.",
        attachments: [
          { title: "Screenshot", url: "https://example.com/screenshot.png", mimeType: "image/png" },
          { title: "Runbook", url: "https://example.com/runbook", mimeType: "text/html" },
        ],
      },
      agentId: "operator",
      sessionId: "sess-google-chat",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["chat.googleapis.com"],
      },
    }, commsStorage);

    const googleChatCall = fetchMock.mock.calls[0] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(googleChatCall?.[0]).toContain("threadKey=ops-thread");
    const googleChatBody = String(googleChatCall?.[1]?.body ?? "");
    expect(googleChatBody).toContain("\"cardsV2\"");
    expect(googleChatBody).toContain("\"imageUrl\":\"https://example.com/screenshot.png\"");
    expect(googleChatBody).toContain("\"text\":\"Runbook\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "spaces/AAAA/messages/123",
    });
  });

  it("sends channel messages through Mattermost bot adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.MATTERMOST_BOT_TOKEN = "mm-token";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v4/users/me")) {
        return new Response(JSON.stringify({ id: "botuserid01234567890123456" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v4/teams/name/goatcitadel")) {
        return new Response(JSON.stringify({ id: "teamid12345678901234567890" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v4/teams/teamid12345678901234567890/channels/name/town-square")) {
        return new Response(JSON.stringify({ id: "channelid12345678901234567" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v4/posts")) {
        return new Response(JSON.stringify({ id: "post-123" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const queuedSpy = vi.fn((input: Record<string, unknown>) => ({
      deliveryId: "delivery-mm",
      status: "queued",
      channelKey: input.channelKey,
      target: input.target,
      createdAt: "2026-03-18T00:00:00.000Z",
      updatedAt: "2026-03-18T00:00:00.000Z",
    }));

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-mm",
          key: "mattermost",
          config: {
            serverUrl: "https://chat.example.com",
            botTokenEnv: "MATTERMOST_BOT_TOKEN",
            defaultChannel: "town-square",
            defaultTeam: "goatcitadel",
          },
        })),
      },
      commsDeliveries: {
        createQueued: queuedSpy,
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-mm",
        message: "Deploy finished.",
      },
      agentId: "operator",
      sessionId: "sess-mm",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["chat.example.com"],
      },
    }, commsStorage);

    expect(queuedSpy).toHaveBeenCalledWith(expect.objectContaining({
      target: "town-square",
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chat.example.com/api/v4/posts",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
    const postCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/v4/posts"));
    const postCallArgs = postCall as unknown[] | undefined;
    const postBody = (postCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(postBody ?? "")).toContain("\"channel_id\":\"channelid12345678901234567\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "post-123",
    });
  });

  it("uploads Mattermost attachments before creating the post", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.MATTERMOST_BOT_TOKEN = "mm-token";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v4/users/me")) {
        return new Response(JSON.stringify({ id: "botuserid01234567890123456" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v4/teams/name/goatcitadel")) {
        return new Response(JSON.stringify({ id: "teamid12345678901234567890" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v4/teams/teamid12345678901234567890/channels/name/town-square")) {
        return new Response(JSON.stringify({ id: "channelid12345678901234567" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v4/files")) {
        return new Response(JSON.stringify({ file_infos: [{ id: "file-123" }] }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v4/posts")) {
        return new Response(JSON.stringify({ id: "post-attachment-123" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-mm",
          key: "mattermost",
          config: {
            serverUrl: "https://chat.example.com",
            botTokenEnv: "MATTERMOST_BOT_TOKEN",
            defaultChannel: "town-square",
            defaultTeam: "goatcitadel",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-mm-attachment",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-mm",
        message: "Deployment evidence attached.",
        attachments: [
          {
            title: "evidence.txt",
            mimeType: "text/plain",
            dataBase64: Buffer.from("mattermost-bytes").toString("base64"),
          },
        ],
      },
      agentId: "operator",
      sessionId: "sess-mm-attachment",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["chat.example.com"],
      },
    }, commsStorage);

    const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/v4/files")) as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(uploadCall?.[1]?.body).toBeInstanceOf(FormData);
    const uploadBody = uploadCall?.[1]?.body as FormData;
    expect(uploadBody.get("channel_id")).toBe("channelid12345678901234567");
    const uploadedFile = uploadBody.get("files");
    expect(uploadedFile).toBeInstanceOf(File);
    expect((uploadedFile as File).name).toBe("evidence.txt");

    const postCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/v4/posts")) as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(String(postCall?.[1]?.body ?? "")).toContain("\"file_ids\":[\"file-123\"]");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "post-attachment-123",
    });
  });

  it("sends channel messages through LINE bot adapters using shared target keys", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-token";
    const fetchMock = vi.fn(async () => new Response("", {
      status: 200,
      headers: { "x-line-request-id": "line-request-123" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const queuedSpy = vi.fn((input: Record<string, unknown>) => ({
      deliveryId: "delivery-line",
      status: "queued",
      channelKey: input.channelKey,
      target: input.target,
      createdAt: "2026-03-18T00:00:00.000Z",
      updatedAt: "2026-03-18T00:00:00.000Z",
    }));

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-line",
          key: "line",
          config: {
            channelAccessTokenEnv: "LINE_CHANNEL_ACCESS_TOKEN",
            defaultGroupId: "line:group:C1234567890abcdef1234567890abcd",
          },
        })),
      },
      commsDeliveries: {
        createQueued: queuedSpy,
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-line",
        message: "Weekly digest is ready.",
      },
      agentId: "operator",
      sessionId: "sess-line",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["api.line.me"],
      },
    }, commsStorage);

    expect(queuedSpy).toHaveBeenCalledWith(expect.objectContaining({
      target: "line:group:C1234567890abcdef1234567890abcd",
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.line.me/v2/bot/message/push",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const lineCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const lineBody = (lineCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(lineBody ?? "")).toContain("\"to\":\"C1234567890abcdef1234567890abcd\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "line-request-123",
    });
  });

  it("sends channel messages through Nextcloud Talk bot adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.NEXTCLOUD_TALK_TOKEN = "nextcloud-secret";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ocs: { data: { id: 9988 } },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-nextcloud",
          key: "nextcloud-talk",
          config: {
            baseUrl: "https://cloud.example.com",
            tokenEnv: "NEXTCLOUD_TALK_TOKEN",
            defaultConversationId: "nc:room:room-token-123",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-nextcloud",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-nextcloud",
        message: "Room update complete.",
      },
      agentId: "operator",
      sessionId: "sess-nextcloud",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["cloud.example.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/room-token-123/message",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const nextcloudCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const nextcloudInit = nextcloudCallArgs?.[1] as (RequestInit & { body?: BodyInit | null; headers?: HeadersInit }) | undefined;
    expect(String(nextcloudInit?.body ?? "")).toContain("\"message\":\"Room update complete.\"");
    const nextcloudHeaders = new Headers(nextcloudInit?.headers);
    expect(nextcloudHeaders.get("OCS-APIRequest")).toBe("true");
    expect(nextcloudHeaders.get("X-Nextcloud-Talk-Bot-Random")).toBeTruthy();
    expect(nextcloudHeaders.get("X-Nextcloud-Talk-Bot-Signature")).toBeTruthy();
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "9988",
    });
  });

  it("forwards Nextcloud Talk reply targets for quoted replies", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.NEXTCLOUD_TALK_TOKEN = "nextcloud-secret";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ocs: { data: { id: 9988 } },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-nextcloud",
          key: "nextcloud-talk",
          config: {
            baseUrl: "https://cloud.example.com",
            tokenEnv: "NEXTCLOUD_TALK_TOKEN",
            defaultConversationId: "room-token-123",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-nextcloud",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-nextcloud",
        message: "Quoted follow-up",
        replyTo: "1567",
      },
      agentId: "operator",
      sessionId: "sess-nextcloud",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["cloud.example.com"],
      },
    }, commsStorage);

    const nextcloudCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const nextcloudInit = nextcloudCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined;
    expect(String(nextcloudInit?.body ?? "")).toContain("\"replyTo\":\"1567\"");
  });

  it("rejects Nextcloud Talk attachments because the adapter is send-only", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.NEXTCLOUD_TALK_TOKEN = "nextcloud-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-nextcloud",
          key: "nextcloud-talk",
          config: {
            baseUrl: "https://cloud.example.com",
            tokenEnv: "NEXTCLOUD_TALK_TOKEN",
            defaultConversationId: "room-token-123",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-nextcloud",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-nextcloud",
        message: "Attachment check",
        attachments: [{ url: "https://example.com/photo.png" }],
      },
      agentId: "operator",
      sessionId: "sess-nextcloud",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["cloud.example.com"],
      },
    }, commsStorage);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "failed",
      error: "Nextcloud Talk does not support attachments in this adapter",
    });
  });

  it("adds reactions through Nextcloud Talk bot adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.NEXTCLOUD_TALK_TOKEN = "nextcloud-secret";
    const fetchMock = vi.fn(async () => new Response("", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-nextcloud",
          key: "nextcloud-talk",
          config: {
            baseUrl: "https://cloud.example.com",
            tokenEnv: "NEXTCLOUD_TALK_TOKEN",
            defaultConversationId: "room-token-123",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-nextcloud-react",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.react",
      args: {
        connectionId: "conn-nextcloud",
        target: "room-token-123",
        messageId: "1567",
        reaction: "😆",
      },
      agentId: "operator",
      sessionId: "sess-nextcloud",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["cloud.example.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/room-token-123/reaction/1567",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const nextcloudCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const nextcloudInit = nextcloudCallArgs?.[1] as (RequestInit & { body?: BodyInit | null; headers?: HeadersInit }) | undefined;
    expect(String(nextcloudInit?.body ?? "")).toContain("\"reaction\":\"😆\"");
    const nextcloudHeaders = new Headers(nextcloudInit?.headers);
    expect(nextcloudHeaders.get("OCS-APIRequest")).toBe("true");
    expect(nextcloudHeaders.get("X-Nextcloud-Talk-Bot-Random")).toBeTruthy();
    expect(nextcloudHeaders.get("X-Nextcloud-Talk-Bot-Signature")).toBeTruthy();
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "1567",
    });
  });

  it("sends channel messages through Signal bridge adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      result: { timestamp: 1712345678901 },
      id: "rpc-1",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-signal",
          key: "signal",
          config: {
            baseUrl: "https://signal.example.com",
            accountId: "+15557654321",
            defaultRecipient: "signal:group:group-123",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-signal",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-signal",
        message: "Bridge delivery complete.",
      },
      agentId: "operator",
      sessionId: "sess-signal",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["signal.example.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://signal.example.com/api/v1/rpc",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const signalCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const signalBody = ((signalCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(signalBody ?? "")).toContain("\"method\":\"send\"");
    expect(String(signalBody ?? "")).toContain("\"message\":\"Bridge delivery complete.\"");
    expect(String(signalBody ?? "")).toContain("\"groupId\":\"group-123\"");
    expect(String(signalBody ?? "")).toContain("\"account\":\"+15557654321\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "1712345678901",
    });
  });

  it("sends channel messages through iMessage BlueBubbles adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.IMESSAGE_PASSWORD = "bb-password";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          {
            guid: "iMessage;-;+15551234567",
            participants: [{ address: "+15551234567" }],
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          guid: "bb-msg-123",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-imessage",
          key: "imessage",
          config: {
            bridgeUrl: "http://127.0.0.1:1234",
            passwordEnv: "IMESSAGE_PASSWORD",
            defaultHandle: "imessage:+15551234567",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-imessage",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-imessage",
        message: "Blue bubble delivered.",
      },
      agentId: "operator",
      sessionId: "sess-imessage",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["127.0.0.1"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:1234/api/v1/chat/query?password=bb-password",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:1234/api/v1/message/text?password=bb-password",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const sendCallArgs = fetchMock.mock.calls[1] as unknown[] | undefined;
    const sendBody = ((sendCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(sendBody ?? "")).toContain("\"chatGuid\":\"iMessage;-;+15551234567\"");
    expect(String(sendBody ?? "")).toContain("\"message\":\"Blue bubble delivered.\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "bb-msg-123",
    });
  });

  it("sends iMessage attachments through BlueBubbles multipart delivery", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.IMESSAGE_PASSWORD = "bb-password";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          {
            guid: "iMessage;-;+15551234567",
            participants: [{ address: "+15551234567" }],
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("image-bytes", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          hash: "uploaded-hash-1",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          guid: "bb-msg-attachment-123",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-imessage",
          key: "imessage",
          config: {
            bridgeUrl: "http://127.0.0.1:1234",
            passwordEnv: "IMESSAGE_PASSWORD",
            defaultHandle: "imessage:+15551234567",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-imessage-attachment",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-imessage",
        message: "See attached.",
        attachments: [
          {
            url: "https://files.example.com/reports/goat.png",
            mimeType: "image/png",
          },
        ],
      },
      agentId: "operator",
      sessionId: "sess-imessage-attachment",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["127.0.0.1", "files.example.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:1234/api/v1/chat/query?password=bb-password",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://files.example.com/reports/goat.png",
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:1234/api/v1/attachment/upload?password=bb-password",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const uploadCallArgs = fetchMock.mock.calls[2] as unknown[] | undefined;
    const uploadBody = ((uploadCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(uploadBody).toBeInstanceOf(FormData);
    const uploadedAttachment = (uploadBody as FormData).get("attachment");
    expect(uploadedAttachment).toBeTruthy();
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:1234/api/v1/message/multipart?password=bb-password",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const multipartCallArgs = fetchMock.mock.calls[3] as unknown[] | undefined;
    const multipartBody = ((multipartCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(multipartBody ?? "")).toContain("\"chatGuid\":\"iMessage;-;+15551234567\"");
    expect(String(multipartBody ?? "")).toContain("\"text\":\"See attached.\"");
    expect(String(multipartBody ?? "")).toContain("\"attachment\":\"uploaded-hash-1\"");
    expect(String(multipartBody ?? "")).toContain("\"name\":\"goat.png\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "bb-msg-attachment-123",
    });
  });

  it("uploads inline iMessage attachment payloads without fetching remote URLs", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.IMESSAGE_PASSWORD = "bb-password";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          {
            guid: "iMessage;-;+15551234567",
            participants: [{ address: "+15551234567" }],
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          hash: "uploaded-inline-hash",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          guid: "bb-msg-inline-attachment-123",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-imessage",
          key: "imessage",
          config: {
            bridgeUrl: "http://127.0.0.1:1234",
            passwordEnv: "IMESSAGE_PASSWORD",
            defaultHandle: "imessage:+15551234567",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-imessage-inline-attachment",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-imessage",
        message: "",
        attachments: [
          {
            title: "inline.png",
            mimeType: "image/png",
            dataBase64: Buffer.from("png-bytes").toString("base64"),
          },
        ],
      },
      agentId: "operator",
      sessionId: "sess-imessage-inline-attachment",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["127.0.0.1"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:1234/api/v1/chat/query?password=bb-password",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:1234/api/v1/attachment/upload?password=bb-password",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:1234/api/v1/message/multipart?password=bb-password",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "bb-msg-inline-attachment-123",
    });
  });

  it("reacts to iMessage messages through BlueBubbles adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.IMESSAGE_PASSWORD = "bb-password";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          {
            guid: "iMessage;-;+15551234567",
            participants: [{ address: "+15551234567" }],
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          guid: "bb-react-123",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-imessage",
          key: "imessage",
          config: {
            bridgeUrl: "http://127.0.0.1:1234",
            passwordEnv: "IMESSAGE_PASSWORD",
            defaultHandle: "imessage:+15551234567",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-imessage-react",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.react",
      args: {
        connectionId: "conn-imessage",
        messageId: "msg-123",
        reaction: "love",
        partIndex: 1,
      },
      agentId: "operator",
      sessionId: "sess-imessage-react",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["127.0.0.1"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:1234/api/v1/message/react?password=bb-password",
      expect.objectContaining({ method: "POST" }),
    );
    const reactCallArgs = fetchMock.mock.calls[1] as unknown[] | undefined;
    const reactBody = ((reactCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(reactBody ?? "")).toContain("\"selectedMessageGuid\":\"msg-123\"");
    expect(String(reactBody ?? "")).toContain("\"reaction\":\"love\"");
    expect(String(reactBody ?? "")).toContain("\"partIndex\":1");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "bb-react-123",
    });
  });

  it("unsends iMessage messages through BlueBubbles adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.IMESSAGE_PASSWORD = "bb-password";
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-imessage",
          key: "imessage",
          config: {
            bridgeUrl: "http://127.0.0.1:1234",
            passwordEnv: "IMESSAGE_PASSWORD",
            defaultHandle: "imessage:+15551234567",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-imessage-unsend",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.unsend",
      args: {
        connectionId: "conn-imessage",
        messageId: "msg-guid-456",
        partIndex: 0,
      },
      agentId: "operator",
      sessionId: "sess-imessage-unsend",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["127.0.0.1"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/api/v1/message/msg-guid-456/unsend?password=bb-password",
      expect.objectContaining({ method: "POST" }),
    );
    const unsendCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const unsendBody = ((unsendCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(unsendBody ?? "")).toContain("\"partIndex\":0");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "msg-guid-456",
    });
  });

  it("reacts to Slack messages through bot-token connectors", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-slack",
          key: "slack",
          config: {
            botTokenEnv: "SLACK_BOT_TOKEN",
            defaultChannel: "C123",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-slack-react",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.react",
      args: {
        connectionId: "conn-slack",
        messageId: "1711111111.000100",
        reaction: ":thumbsup:",
      },
      agentId: "operator",
      sessionId: "sess-slack-react",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["slack.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/reactions.add",
      expect.objectContaining({ method: "POST" }),
    );
    const slackCall = fetchMock.mock.calls[0] as [string, RequestInit?] | undefined;
    const slackBody = String((slackCall?.[1]?.body) ?? "");
    expect(slackBody).toContain("\"channel\":\"C123\"");
    expect(slackBody).toContain("\"timestamp\":\"1711111111.000100\"");
    expect(slackBody).toContain("\"name\":\"thumbsup\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "1711111111.000100",
    });
  });

  it("unsends Slack messages through bot-token connectors", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-slack",
          key: "slack",
          config: {
            botTokenEnv: "SLACK_BOT_TOKEN",
            defaultChannel: "C123",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-slack-unsend",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.unsend",
      args: {
        connectionId: "conn-slack",
        messageId: "1711111111.000100",
      },
      agentId: "operator",
      sessionId: "sess-slack-unsend",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["slack.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.delete",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "1711111111.000100",
    });
  });

  it("unsends Discord webhook-authored messages through webhook connectors", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-discord",
          key: "discord",
          config: {
            webhookUrl: "https://discord.com/api/webhooks/123/abc",
            defaultChannelId: "1234567890",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-discord-unsend",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.unsend",
      args: {
        connectionId: "conn-discord",
        messageId: "msg-999",
      },
      agentId: "operator",
      sessionId: "sess-discord-unsend",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["discord.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123/abc/messages/msg-999",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "msg-999",
    });
  });

  it("unsends Telegram bot messages", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.TELEGRAM_BOT_TOKEN = "tg-token";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-telegram",
          key: "telegram",
          config: {
            botTokenEnv: "TELEGRAM_BOT_TOKEN",
            defaultChatId: "123456",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-telegram-unsend",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.unsend",
      args: {
        connectionId: "conn-telegram",
        messageId: "77",
      },
      agentId: "operator",
      sessionId: "sess-telegram-unsend",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["api.telegram.org"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottg-token/deleteMessage",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "77",
    });
  });

  it("adds Telegram reactions through the bot API", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.TELEGRAM_BOT_TOKEN = "tg-token";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-telegram-react",
          key: "telegram",
          config: {
            botTokenEnv: "TELEGRAM_BOT_TOKEN",
            defaultChatId: "-1001234567890",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-telegram-react",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.react",
      args: {
        connectionId: "conn-telegram-react",
        messageId: "987654321",
        reaction: "👍",
      },
      agentId: "operator",
      sessionId: "sess-telegram-react",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["api.telegram.org"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottg-token/setMessageReaction",
      expect.objectContaining({ method: "POST" }),
    );
    const telegramCall = fetchMock.mock.calls[0] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(String(telegramCall?.[1]?.body ?? "")).toContain("\"message_id\":987654321");
    expect(String(telegramCall?.[1]?.body ?? "")).toContain("\"emoji\":\"👍\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "987654321",
    });
  });

  it("uploads Matrix attachments and emits attachment events", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.MATRIX_ACCESS_TOKEN = "matrix-token";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/_matrix/media/v3/upload")) {
        return new Response(JSON.stringify({ content_uri: "mxc://matrix.example.com/media-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/_matrix/client/v3/rooms/!room%3Aexample.com/send/m.room.message/")) {
        return new Response(JSON.stringify({ event_id: "$matrix-file-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-matrix",
          key: "matrix",
          config: {
            homeserverUrl: "https://matrix.example.com",
            accessTokenEnv: "MATRIX_ACCESS_TOKEN",
            defaultRoomId: "!room:example.com",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-matrix-file",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-matrix",
        message: "",
        attachments: [
          {
            title: "diagram.png",
            mimeType: "image/png",
            dataBase64: Buffer.from("matrix-image-bytes").toString("base64"),
          },
        ],
      },
      agentId: "operator",
      sessionId: "sess-matrix-file",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["matrix.example.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://matrix.example.com/_matrix/media/v3/upload?filename=diagram.png",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/_matrix/client/v3/rooms/!room%3Aexample.com/send/m.room.message/"),
      expect.objectContaining({ method: "PUT" }),
    );
    const eventCall = fetchMock.mock.calls[1] as [string, RequestInit?] | undefined;
    const eventBody = String((eventCall?.[1]?.body) ?? "");
    expect(eventBody).toContain("\"msgtype\":\"m.image\"");
    expect(eventBody).toContain("\"body\":\"diagram.png\"");
    expect(eventBody).toContain("\"url\":\"mxc://matrix.example.com/media-123\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "$matrix-file-1",
    });
  });

  it("reacts to Matrix events", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.MATRIX_ACCESS_TOKEN = "matrix-token";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ event_id: "$reaction-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-matrix",
          key: "matrix",
          config: {
            homeserverUrl: "https://matrix.example.com",
            accessTokenEnv: "MATRIX_ACCESS_TOKEN",
            defaultRoomId: "!room:example.com",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-matrix-react",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.react",
      args: {
        connectionId: "conn-matrix",
        messageId: "$event-123",
        reaction: "👍",
      },
      agentId: "operator",
      sessionId: "sess-matrix-react",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["matrix.example.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/_matrix/client/v3/rooms/!room%3Aexample.com/send/m.reaction/"),
      expect.objectContaining({ method: "PUT" }),
    );
    const matrixCall = fetchMock.mock.calls[0] as [string, RequestInit?] | undefined;
    const matrixBody = String((matrixCall?.[1]?.body) ?? "");
    expect(matrixBody).toContain("\"event_id\":\"$event-123\"");
    expect(matrixBody).toContain("\"key\":\"👍\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "$reaction-1",
    });
  });

  it("unsends Mattermost posts", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.MATTERMOST_BOT_TOKEN = "mm-token";
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-mattermost",
          key: "mattermost",
          config: {
            serverUrl: "http://127.0.0.1:8065",
            botTokenEnv: "MATTERMOST_BOT_TOKEN",
            defaultChannel: "town-square",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-mattermost-unsend",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.unsend",
      args: {
        connectionId: "conn-mattermost",
        messageId: "post-123",
      },
      agentId: "operator",
      sessionId: "sess-mattermost-unsend",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["127.0.0.1"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8065/api/v4/posts/post-123",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "post-123",
    });
  });

  it("creates a new iMessage chat before sending attachments to a handle target", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.IMESSAGE_PASSWORD = "bb-password";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          guid: "bb-created-chat-msg",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          {
            guid: "iMessage;-;+15551234567",
            participants: [{ address: "+15551234567" }],
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("image-bytes", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          hash: "uploaded-hash-new-chat",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          guid: "bb-msg-new-chat-attachment",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-imessage-new-chat",
          key: "imessage",
          config: {
            bridgeUrl: "http://127.0.0.1:1234",
            passwordEnv: "IMESSAGE_PASSWORD",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-imessage-new-chat",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-imessage-new-chat",
        target: "imessage:+15551234567",
        attachments: [
          {
            url: "https://files.example.com/reports/goat.png",
            mimeType: "image/png",
          },
        ],
      },
      agentId: "operator",
      sessionId: "sess-imessage-new-chat",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["127.0.0.1", "files.example.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:1234/api/v1/chat/query?password=bb-password",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:1234/api/v1/chat/new?password=bb-password",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const createChatCallArgs = fetchMock.mock.calls[1] as unknown[] | undefined;
    const createChatBody = ((createChatCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(createChatBody ?? "")).toContain("\"addresses\":[\"+15551234567\"]");
    expect(String(createChatBody ?? "")).not.toContain("\"message\":");
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:1234/api/v1/chat/query?password=bb-password",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://files.example.com/reports/goat.png",
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "http://127.0.0.1:1234/api/v1/attachment/upload?password=bb-password",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "http://127.0.0.1:1234/api/v1/message/multipart?password=bb-password",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const multipartCallArgs = fetchMock.mock.calls[5] as unknown[] | undefined;
    const multipartBody = ((multipartCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(multipartBody ?? "")).toContain("\"attachment\":\"uploaded-hash-new-chat\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "bb-msg-new-chat-attachment",
    });
  });

  it("sends channel messages through WhatsApp Cloud API adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.WHATSAPP_ACCESS_TOKEN = "wa-token";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.12345" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-whatsapp",
          key: "whatsapp",
          config: {
            accessTokenEnv: "WHATSAPP_ACCESS_TOKEN",
            phoneNumberId: "123456789012345",
            defaultTarget: "+15551234567",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-whatsapp",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-whatsapp",
        message: "Cloud delivery complete.",
      },
      agentId: "operator",
      sessionId: "sess-whatsapp",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["graph.facebook.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v23.0/123456789012345/messages",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const whatsappCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const whatsappBody = ((whatsappCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(whatsappBody ?? "")).toContain("\"messaging_product\":\"whatsapp\"");
    expect(String(whatsappBody ?? "")).toContain("\"to\":\"15551234567\"");
    expect(String(whatsappBody ?? "")).toContain("\"body\":\"Cloud delivery complete.\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "wamid.12345",
    });
  });

  it("sends WhatsApp URL attachments as rich media messages", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.WHATSAPP_ACCESS_TOKEN = "wa-token";
    let messageCounter = 0;
    const fetchMock = vi.fn(async () => {
      messageCounter += 1;
      return new Response(JSON.stringify({
        messaging_product: "whatsapp",
        messages: [{ id: `wamid.rich.${messageCounter}` }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-whatsapp-rich",
          key: "whatsapp",
          config: {
            accessTokenEnv: "WHATSAPP_ACCESS_TOKEN",
            phoneNumberId: "123456789012345",
            defaultTarget: "+15551234567",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-whatsapp-rich",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-whatsapp-rich",
        message: "Cloud delivery with image.",
        attachments: [{
          url: "https://cdn.example.com/test-image.png",
          title: "test-image.png",
          mimeType: "image/png",
        }],
      },
      agentId: "operator",
      sessionId: "sess-whatsapp-rich",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["graph.facebook.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const attachmentCall = fetchMock.mock.calls[1] as unknown[] | undefined;
    const attachmentBody = ((attachmentCall?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(attachmentBody ?? "")).toContain("\"type\":\"image\"");
    expect(String(attachmentBody ?? "")).toContain("\"link\":\"https://cdn.example.com/test-image.png\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "wamid.rich.2",
    });
  });

  it("uploads inline WhatsApp attachments before sending them", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.WHATSAPP_ACCESS_TOKEN = "wa-token";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/media")) {
        return new Response(JSON.stringify({
          id: "media-inline-123",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/messages")) {
        return new Response(JSON.stringify({
          messaging_product: "whatsapp",
          messages: [{ id: "wamid.inline.123" }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-whatsapp-inline",
          key: "whatsapp",
          config: {
            accessTokenEnv: "WHATSAPP_ACCESS_TOKEN",
            phoneNumberId: "123456789012345",
            defaultTarget: "+15551234567",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-whatsapp-inline",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-whatsapp-inline",
        attachments: [{
          title: "receipt.pdf",
          mimeType: "application/pdf",
          dataBase64: Buffer.from("inline-whatsapp-file").toString("base64"),
        }],
      },
      agentId: "operator",
      sessionId: "sess-whatsapp-inline",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["graph.facebook.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://graph.facebook.com/v23.0/123456789012345/media",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://graph.facebook.com/v23.0/123456789012345/messages",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const messageCall = fetchMock.mock.calls[1] as unknown[] | undefined;
    const messageBody = ((messageCall?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(messageBody ?? "")).toContain("\"type\":\"document\"");
    expect(String(messageBody ?? "")).toContain("\"id\":\"media-inline-123\"");
    expect(String(messageBody ?? "")).toContain("\"filename\":\"receipt.pdf\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "wamid.inline.123",
    });
  });

  it("adds WhatsApp reactions through the Cloud API", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.WHATSAPP_ACCESS_TOKEN = "wa-token";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.react.123" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-whatsapp-react",
          key: "whatsapp",
          config: {
            accessTokenEnv: "WHATSAPP_ACCESS_TOKEN",
            phoneNumberId: "123456789012345",
            defaultTarget: "+15551234567",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-whatsapp-react",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.react",
      args: {
        connectionId: "conn-whatsapp-react",
        messageId: "wamid.original.1",
        reaction: "👍",
      },
      agentId: "operator",
      sessionId: "sess-whatsapp-react",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["graph.facebook.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v23.0/123456789012345/messages",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const whatsappCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const whatsappBody = ((whatsappCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(whatsappBody ?? "")).toContain("\"type\":\"reaction\"");
    expect(String(whatsappBody ?? "")).toContain("\"message_id\":\"wamid.original.1\"");
    expect(String(whatsappBody ?? "")).toContain("\"emoji\":\"👍\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "wamid.react.123",
    });
  });

  it("sends channel messages through Zalo Personal zca bridge adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.ZALOUSER_AUTH_TOKEN = "zlu-token";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messageId: "zlu-msg-123",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-zalouser",
          key: "zalouser",
          config: {
            baseUrl: "http://127.0.0.1:56789",
            authTokenEnv: "ZALOUSER_AUTH_TOKEN",
            profile: "work",
            defaultTarget: "group:g-987654321",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-zalouser",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-zalouser",
        message: "Zalo personal delivery complete.",
      },
      agentId: "operator",
      sessionId: "sess-zalouser",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["127.0.0.1"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:56789/api/work/messages/text",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer zlu-token",
        }),
      }),
    );
    const zaloUserCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const zaloUserBody = ((zaloUserCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(zaloUserBody ?? "")).toContain("\"threadId\":\"g-987654321\"");
    expect(String(zaloUserBody ?? "")).toContain("\"isGroup\":true");
    expect(String(zaloUserBody ?? "")).toContain("\"message\":\"Zalo personal delivery complete.\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "zlu-msg-123",
    });
  });

  it("routes Zalo Personal image attachments to the zca media endpoint", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.ZALOUSER_AUTH_TOKEN = "zlu-token";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messageId: "zlu-media-123",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-zalouser-media",
          key: "zalouser",
          config: {
            baseUrl: "http://127.0.0.1:56789",
            authTokenEnv: "ZALOUSER_AUTH_TOKEN",
            profile: "work",
            defaultTarget: "user:u-123456789",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-zalouser-media",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-zalouser-media",
        message: "Photo attached.",
        attachments: [
          {
            url: "https://example.com/photo.png",
            title: "Screenshot",
            mimeType: "image/png",
          },
        ],
      },
      agentId: "operator",
      sessionId: "sess-zalouser-media",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["127.0.0.1", "example.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:56789/api/work/messages/image",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer zlu-token",
        }),
      }),
    );
    const mediaCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const mediaBody = ((mediaCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(mediaBody ?? "")).toContain("\"threadId\":\"u-123456789\"");
    expect(String(mediaBody ?? "")).toContain("\"isGroup\":false");
    expect(String(mediaBody ?? "")).toContain("\"url\":\"https://example.com/photo.png\"");
    expect(String(mediaBody ?? "")).toContain("\"message\":\"Photo attached.\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "zlu-media-123",
    });
  });

  it("sends channel messages through Zalo bot adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.ZALO_ACCESS_TOKEN = "zalo-token";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: { message_id: "zalo-msg-1" },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-zalo",
          key: "zalo",
          config: {
            accessTokenEnv: "ZALO_ACCESS_TOKEN",
            defaultRecipientId: "zalo:group:chat-123",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-zalo",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed: vi.fn(),
      },
    } as unknown as Storage;

    const result = await executeTool({
      toolName: "channel.send",
      args: {
        connectionId: "conn-zalo",
        message: "Broadcast ready.",
      },
      agentId: "operator",
      sessionId: "sess-zalo",
    }, {
      ...policyConfig,
      sandbox: {
        ...policyConfig.sandbox,
        networkAllowlist: ["bot-api.zaloplatforms.com"],
      },
    }, commsStorage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://bot-api.zaloplatforms.com/botzalo-token/sendMessage",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const zaloCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const zaloBody = ((zaloCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body);
    expect(String(zaloBody ?? "")).toContain("\"chat_id\":\"chat-123\"");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "zalo-msg-1",
    });
  });
});
