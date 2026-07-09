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
      executionContext?: {
        actorId?: string;
        assertBrowserSessionAccess?: unknown;
        sessionId?: string;
        signal?: AbortSignal;
        matchedGrantAllowedHosts?: string[];
        fullWebAccess?: boolean;
      },
    ) => Promise<Record<string, unknown>>
  >(),
}));

vi.mock("./browser-tools.js", () => ({
  isBrowserToolName: mocked.isBrowserToolName,
  executeBrowserTool: mocked.executeBrowserTool,
}));

import {
  executeTool,
  killAllBackgroundProcesses,
  killBackgroundProcess,
  resolveExecutableCommand,
  resolveFixedOutboundHostsForTool,
  resolveRestrictedCommand,
  setShellExecTimeoutMsForTesting,
} from "./tool-executor.js";
import { createUntrustedContentEnvelope } from "./browser-content-guard.js";

const LOCALHOST_HOST = new URL("http://localhost").hostname;
const EXAMPLE_HOST = new URL("https://example.com").hostname;
const LOOPBACK_HOST = new URL("http://127.0.0.1").hostname;

const storageStub = {
  approvals: {
    get: vi.fn((approvalId: string) => ({
      approvalId,
      kind: "tool",
      riskLevel: "caution",
      status: "approved",
      payload: {},
      preview: {},
      createdAt: new Date().toISOString(),
      explanationStatus: "not_requested",
    })),
  },
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
    networkAllowlist: [LOCALHOST_HOST, EXAMPLE_HOST, LOOPBACK_HOST],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};

const testWorkspaceRoot = path.resolve(policyConfig.sandbox.writeJailRoots[0] ?? "./workspace", "tool-executor-test");

describe("executeTool", () => {
  beforeEach(() => {
    mocked.isBrowserToolName.mockReset();
    mocked.executeBrowserTool.mockReset();
    vi.mocked(storageStub.approvals.get).mockReset();
    vi.mocked(storageStub.approvals.get).mockImplementation((approvalId: string) => ({
      approvalId,
      kind: "tool",
      riskLevel: "caution",
      status: "approved",
      payload: {},
      preview: {},
      createdAt: new Date().toISOString(),
      explanationStatus: "not_requested",
    }));
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
    await removeTestWorkspace(testWorkspaceRoot);
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

    expect(mocked.executeBrowserTool).toHaveBeenCalledWith("browser.navigate", request.args, policyConfig, {
      sessionId: "sess-1",
      signal: request.signal,
      fullWebAccess: true,
      matchedGrantAllowedHosts: undefined,
      actorId: "researcher",
      assertBrowserSessionAccess: undefined,
    });
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

  it("adds the fixed WhatsApp Graph host for reaction tools", () => {
    expect(resolveFixedOutboundHostsForTool("whatsapp.react")).toContain("graph.facebook.com");
  });

  it("dispatches session.search to the chat-message repo scoped to the calling session", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const searchMessages = vi.fn(() => [
      {
        messageId: "m1",
        sessionId: "sess-search",
        role: "user",
        content: "deploy the gateway",
        timestamp: "2026-06-01T00:00:00.000Z",
        score: -1.2,
        context: [
          {
            messageId: "m1",
            role: "user",
            content: "deploy the gateway",
            timestamp: "2026-06-01T00:00:00.000Z",
            isHit: true,
          },
        ],
      },
    ]);
    const searchStorage = { chatMessages: { searchMessages } } as unknown as Storage;

    const request: ToolInvokeRequest = {
      toolName: "session.search",
      args: { query: "gateway deploy", limit: 5 },
      agentId: "agent",
      sessionId: "sess-search",
    };

    const result = await executeTool(request, policyConfig, searchStorage);

    // Default scope is the calling session.
    expect(searchMessages).toHaveBeenCalledWith("gateway deploy", {
      sessionId: "sess-search",
      limit: 5,
      contextRadius: 2,
    });
    expect(result).toMatchObject({ scope: "session", query: "gateway deploy" });
    expect(Array.isArray(result.hits)).toBe(true);
    expect((result.hits as unknown[]).length).toBe(1);
  });

  it("session.search with scope:all does not pass a sessionId filter", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const searchMessages = vi.fn(() => []);
    const searchStorage = { chatMessages: { searchMessages } } as unknown as Storage;

    const request: ToolInvokeRequest = {
      toolName: "session.search",
      args: { query: "anything", scope: "all" },
      agentId: "agent",
      sessionId: "sess-search",
    };

    const result = await executeTool(request, policyConfig, searchStorage);

    expect(searchMessages).toHaveBeenCalledWith("anything", { limit: 10, contextRadius: 2 });
    expect(result).toMatchObject({ scope: "all", query: "anything", hits: [] });
  });

  it("session.search returns empty without hitting the repo for a blank query", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const searchMessages = vi.fn(() => []);
    const searchStorage = { chatMessages: { searchMessages } } as unknown as Storage;

    const request: ToolInvokeRequest = {
      toolName: "session.search",
      args: { query: "   " },
      agentId: "agent",
      sessionId: "sess-search",
    };

    const result = await executeTool(request, policyConfig, searchStorage);

    expect(searchMessages).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scope: "session", query: "", hits: [] });
  });

  it("blocks tool side effects that contain an active browser canary", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const envelope = createUntrustedContentEnvelope("browser.extract", "hostile page text");
    const request: ToolInvokeRequest = {
      toolName: "fs.write",
      args: { path: path.join(testWorkspaceRoot, "leak.txt"), content: envelope.canary },
      agentId: "agent",
      sessionId: "sess-browser-guard",
    };

    await expect(executeTool(request, policyConfig, storageStub)).rejects.toThrow(
      /Browser content guard blocked tool args/i,
    );
  });

  it("executes shell commands via execFile parsing", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const request: ToolInvokeRequest = {
      toolName: "shell.exec",
      args: { command: "node -e \"process.stdout.write('ok')\"" },
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
      const result = await executeTool(
        {
          toolName: "file.read_range",
          args: { path: filePath, startLine: 1, endLine: 2 },
          agentId: "agent",
          sessionId: "sess-grant",
        },
        policyConfig,
        storageWithGrant,
      );

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

  it("uses uncapped fallback grant listing during physical file execution", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const filePath = path.join(os.tmpdir(), `tool-executor-uncapped-grant-${randomUUID()}.ts`);
    await fs.writeFile(filePath, ["one", "two", "three"].join("\n"), "utf8");
    const nonMatchingGrants = Array.from({ length: 500 }, (_, index) => ({
      grantId: `grant-other-${index}`,
      toolPattern: "file.write",
      decision: "allow",
      scope: "session",
      scopeRef: "sess-grant",
      grantType: "persistent",
      constraints: { allowedPaths: ["*"] },
      createdBy: "test",
      createdAt: new Date(Date.UTC(2026, 2, 22, 12, 0, index + 1)).toISOString(),
    }));
    const grants = [
      ...nonMatchingGrants,
      {
        grantId: "grant-old-read",
        toolPattern: "file.read_range",
        decision: "allow",
        scope: "session",
        scopeRef: "sess-grant",
        grantType: "persistent",
        constraints: { allowedPaths: ["*"] },
        createdBy: "test",
        createdAt: "2026-03-22T12:00:00.000Z",
      },
    ];
    const list = vi.fn((scope: string, scopeRef: string, limit: number) =>
      scope === "session" && scopeRef === "sess-grant" ? grants.slice(0, limit) : [],
    );
    const storageWithGrant = {
      toolGrants: { list },
    } as unknown as Storage;

    try {
      const result = await executeTool(
        {
          toolName: "file.read_range",
          args: { path: filePath, startLine: 1, endLine: 1 },
          agentId: "agent",
          sessionId: "sess-grant",
        },
        policyConfig,
        storageWithGrant,
      );

      expect(result).toMatchObject({ path: filePath, content: "one" });
      expect(list).toHaveBeenCalledWith("session", "sess-grant", Number.MAX_SAFE_INTEGER);
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("uses the matched consumed grant path constraints during execution", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `tool-executor-consumed-grant-${randomUUID()}-`));
    const grantedRoot = path.join(root, "granted");
    const sourcePath = path.join(grantedRoot, "notes.md");
    await fs.mkdir(grantedRoot, { recursive: true });
    await fs.writeFile(sourcePath, "# Granted\n\nOne-time grant content.", "utf8");
    const grant = {
      grantId: "grant-consumed-path",
      toolPattern: "docs.ingest",
      decision: "allow" as const,
      scope: "session" as const,
      scopeRef: "sess-grant",
      grantType: "one_time" as const,
      constraints: { allowedPaths: [grantedRoot] },
      createdBy: "test",
      createdAt: new Date().toISOString(),
      usesRemaining: 0,
    };
    const documents: Array<Record<string, unknown>> = [];
    const chunksByDocId = new Map<string, Array<Record<string, unknown>>>();
    const storageWithConsumedGrant = {
      toolGrants: {
        get: vi.fn(() => grant),
        list: vi.fn(() => []),
      },
      knowledge: {
        listDocuments: vi.fn(() => []),
        createDocument: vi.fn((input: Record<string, unknown>) => {
          const doc = {
            docId: `doc-${documents.length + 1}`,
            namespace: input.namespace,
            sourceType: input.sourceType,
            sourceRef: input.sourceRef,
            title: input.title,
            metadata: input.metadata ?? {},
            createdAt: new Date().toISOString(),
          };
          documents.unshift(doc);
          return doc;
        }),
        appendChunks: vi.fn((docId: string, entries: Array<Record<string, unknown>>) => {
          const saved = entries.map((entry, index) => ({
            chunkId: `chunk-${index + 1}`,
            docId,
            seq: index,
            content: entry.content,
            tokenEstimate: 1,
            createdAt: new Date().toISOString(),
          }));
          chunksByDocId.set(docId, saved);
          return saved;
        }),
        listChunksByDocument: vi.fn((docId: string) => chunksByDocId.get(docId) ?? []),
        listChunksByNamespace: vi.fn(() => []),
      },
    } as unknown as Storage;

    try {
      const result = await executeTool(
        {
          toolName: "docs.ingest",
          args: { sourceType: "file", source: sourcePath, namespace: "research" },
          agentId: "agent",
          sessionId: "sess-grant",
          policyContext: { matchedGrantId: "grant-consumed-path" },
        },
        policyConfig,
        storageWithConsumedGrant,
      );

      expect(result.document).toMatchObject({ sourceRef: sourcePath });
      expect(storageWithConsumedGrant.toolGrants.list).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not let scoped read grants bypass realpath checks through a symlinked child path", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `tool-executor-grant-realpath-${randomUUID()}-`));
    const grantedRoot = path.join(root, "granted");
    const outsideRoot = path.join(root, "outside");
    const linkPath = path.join(grantedRoot, "linked");
    await fs.mkdir(grantedRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "outside secret", "utf8");
    await fs.symlink(outsideRoot, linkPath, "junction");

    const storageWithGrant = {
      toolGrants: {
        list: vi.fn(() => [
          {
            grantId: "grant-realpath",
            toolPattern: "file.read_range",
            decision: "allow",
            scope: "session",
            scopeRef: "sess-grant",
            grantType: "persistent",
            constraints: { allowedPaths: [grantedRoot] },
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ]),
      },
    } as unknown as Storage;

    try {
      await expect(
        executeTool(
          {
            toolName: "file.read_range",
            args: { path: path.join(linkPath, "secret.txt"), startLine: 1, endLine: 1 },
            agentId: "agent",
            sessionId: "sess-grant",
          },
          policyConfig,
          storageWithGrant,
        ),
      ).rejects.toThrow(/outside read allowlist/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not let scoped read grants widen full-disk read execution through a symlinked child path", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `tool-executor-grant-full-disk-${randomUUID()}-`));
    const grantedRoot = path.join(root, "granted");
    const outsideRoot = path.join(root, "outside");
    const linkPath = path.join(grantedRoot, "linked");
    await fs.mkdir(grantedRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "outside secret", "utf8");
    await fs.symlink(outsideRoot, linkPath, "junction");

    const storageWithGrant = {
      toolGrants: {
        list: vi.fn(() => [
          {
            grantId: "grant-full-disk-realpath",
            toolPattern: "file.read_range",
            decision: "allow",
            scope: "session",
            scopeRef: "sess-grant",
            grantType: "persistent",
            constraints: { allowedPaths: [grantedRoot] },
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ]),
      },
    } as unknown as Storage;

    try {
      await expect(
        executeTool(
          {
            toolName: "file.read_range",
            args: { path: path.join(linkPath, "secret.txt"), startLine: 1, endLine: 1 },
            agentId: "agent",
            sessionId: "sess-grant",
          },
          {
            ...policyConfig,
            sandbox: {
              ...policyConfig.sandbox,
              writeJailRoots: [grantedRoot],
              readOnlyRoots: [],
              readAccessMode: "full_disk",
            },
          },
          storageWithGrant,
        ),
      ).rejects.toThrow(/outside read allowlist/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("applies workspace-scoped read grants during physical file execution", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const filePath = path.join(os.tmpdir(), `tool-executor-workspace-${randomUUID()}.ts`);
    await fs.writeFile(filePath, ["red", "green", "blue"].join("\n"), "utf8");

    const storageWithGrant = {
      toolGrants: {
        list: vi.fn((scope: string, scopeRef: string) => {
          if (scope !== "workspace" || scopeRef !== "workspace-1") {
            return [];
          }
          return [
            {
              grantId: "grant-workspace-1",
              toolPattern: "file.read_range",
              decision: "allow",
              scope: "workspace",
              scopeRef: "workspace-1",
              grantType: "persistent",
              constraints: { allowedPaths: ["*"] },
              createdBy: "test",
              createdAt: new Date().toISOString(),
            },
          ];
        }),
      },
    } as unknown as Storage;

    try {
      const result = await executeTool(
        {
          toolName: "file.read_range",
          args: { path: filePath, startLine: 1, endLine: 2 },
          agentId: "agent",
          sessionId: "sess-workspace",
          workspaceId: "workspace-1",
        },
        policyConfig,
        storageWithGrant,
      );

      expect(result).toMatchObject({
        path: filePath,
        startLine: 1,
        endLine: 2,
        content: "red\ngreen",
      });
      expect(storageWithGrant.toolGrants.list).toHaveBeenCalledWith(
        "workspace",
        "workspace-1",
        Number.MAX_SAFE_INTEGER,
      );
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
      expiresAt: "2099-03-21T00:15:00.000Z",
      resolutionStatus: "pending",
    });

    try {
      const result = await executeTool(
        {
          toolName: "file.read_range",
          args: { path: filePath, startLine: 1, endLine: 2 },
          agentId: "agent",
          sessionId: "sess-approved-read",
          consentContext: {
            source: "ui",
            reason: "approval:apr_read_123",
          },
        },
        {
          ...policyConfig,
          sandbox: {
            ...policyConfig.sandbox,
            readAccessMode: "approval_required",
          },
        },
        storageStub,
      );

      expect(result).toMatchObject({
        path: filePath,
        content: "alpha\nbeta",
      });
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("does not let approval context bypass roots-only read posture", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const filePath = path.join(os.tmpdir(), `tool-executor-roots-only-${randomUUID()}.ts`);
    await fs.writeFile(filePath, ["alpha", "beta"].join("\n"), "utf8");
    vi.mocked(storageStub.pendingApprovalActions.find).mockReturnValue({
      approvalId: "apr_roots_only",
      actionType: "tool.invoke",
      request: {
        toolName: "file.read_range",
        args: { path: filePath, startLine: 1, endLine: 2 },
        agentId: "agent",
        sessionId: "sess-roots-only",
      },
      createdAt: "2026-03-21T00:00:00.000Z",
      expiresAt: "2099-03-21T00:15:00.000Z",
      resolutionStatus: "pending",
    });

    try {
      await expect(
        executeTool(
          {
            toolName: "file.read_range",
            args: { path: filePath, startLine: 1, endLine: 2 },
            agentId: "agent",
            sessionId: "sess-roots-only",
            consentContext: {
              source: "ui",
              reason: "approval:apr_roots_only",
            },
            policyContext: {
              permissionProfile: {
                profileId: "profile-approval-reads",
                label: "Approval reads",
                approvalMode: "approve_risky",
                readAccessMode: "approval_required",
              } as never,
            },
          },
          {
            ...policyConfig,
            sandbox: {
              ...policyConfig.sandbox,
              readAccessMode: "roots_only",
            },
          },
          storageStub,
        ),
      ).rejects.toThrow(/outside read allowlist/i);
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

  it("skips eval-assets from root code searches but allows explicit eval-assets searches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const packPath = path.join(testWorkspaceRoot, "eval-assets", "goatcitadel_prompt_pack_v4_agentic_focused.md");
    await fs.mkdir(path.dirname(packPath), { recursive: true });
    await fs.writeFile(packPath, "unique-eval-self-reference\n", "utf8");

    const rootResult = await executeTool(
      {
        toolName: "code.search",
        args: { path: testWorkspaceRoot, query: "unique-eval-self-reference" },
        agentId: "agent",
        sessionId: "sess-eval-assets-root-search",
      },
      policyConfig,
      storageStub,
    );
    expect(rootResult).toMatchObject({
      path: testWorkspaceRoot,
      pattern: "unique-eval-self-reference",
      count: 0,
    });

    const explicitResult = await executeTool(
      {
        toolName: "code.search",
        args: { path: path.dirname(packPath), query: "unique-eval-self-reference" },
        agentId: "agent",
        sessionId: "sess-eval-assets-explicit-search",
      },
      policyConfig,
      storageStub,
    );
    expect(explicitResult).toMatchObject({
      path: path.dirname(packPath),
      pattern: "unique-eval-self-reference",
      count: 1,
    });
    expect((explicitResult.matches as Array<Record<string, unknown>>)[0]?.path).toBe(packPath);
  });

  it("searches file names with code.search_files", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    // Fixture name is deliberately synthetic (not a real module name) so
    // repo-wide renames can never desync it from the query below.
    const filePath = path.join(testWorkspaceRoot, "src", "sample-orchestrator.test.ts");
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
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify(
        {
          name: "restricted-runner",
          private: true,
          scripts: {
            test: 'node -e "process.stdout.write(process.cwd())"',
          },
        },
        null,
        2,
      ),
      "utf8",
    );

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
  }, 15_000);

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
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify(
        {
          name: "restricted-pnpm-runner",
          private: true,
          scripts: {
            lint: "node -e \"process.stdout.write('lint-script')\"",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

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
  }, 15_000);

  it("rejects malformed shell command parsing", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const request: ToolInvokeRequest = {
      toolName: "shell.exec",
      args: { command: 'echo "unterminated' },
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
      expiresAt: "2099-03-21T00:15:00.000Z",
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
      expiresAt: "2099-03-21T00:15:00.000Z",
      resolutionStatus: "pending",
    });

    const result = await executeTool(
      {
        toolName: "shell.exec_background",
        args: { command: "node --version" },
        agentId: "agent",
        sessionId: "sess-bg-approved",
        consentContext: {
          source: "ui",
          reason: "approval:apr_bg_123",
        },
      },
      riskyPolicy,
      storageStub,
    );

    expect(result).toMatchObject({
      command: "node --version",
      detached: true,
      started: true,
    });
  });

  it("sends channel messages through Slack bot API with rendered attachments", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            ts: "1712345678.000100",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-slack",
          message: "Build green again.",
          attachments: [{ title: "Runbook", url: "https://example.com/runbook" }],
        },
        agentId: "operator",
        sessionId: "sess-slack",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["slack.com"],
        },
      },
      commsStorage,
    );

    expect(queuedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "#build-alerts",
      }),
    );
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

  it("ignores inherited channel connection config keys when resolving secrets and targets", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const inheritedConfig = Object.create({
      botToken: "xoxb-inherited",
      defaultChannel: "#inherited",
    }) as Record<string, unknown>;
    const queuedSpy = vi.fn((input: Record<string, unknown>) => ({
      deliveryId: "delivery-inherited-config",
      status: "queued",
      channelKey: input.channelKey,
      target: input.target,
      createdAt: "2026-03-18T00:00:00.000Z",
      updatedAt: "2026-03-18T00:00:00.000Z",
    }));
    const markFailed = vi.fn();
    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-slack-inherited",
          key: "slack",
          config: inheritedConfig,
        })),
      },
      commsDeliveries: {
        createQueued: queuedSpy,
        markSent: vi.fn(),
        markFailed,
      },
    } as unknown as Storage;

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-slack-inherited",
          message: "Inherited config must not authorize delivery.",
        },
        agentId: "operator",
        sessionId: "sess-slack-inherited",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["slack.com"],
        },
      },
      commsStorage,
    );

    expect(queuedSpy).toHaveBeenCalledWith(expect.objectContaining({ target: "slack" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-inherited-config",
      expect.stringContaining("Missing Slack"),
      expect.any(String),
      "not_available",
    );
    expect(result).toMatchObject({
      status: "failed",
      deliveryStatus: "not_available",
    });
  });

  it("keeps matched grant host constraints enforced across webhook redirects", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example/hook" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const markFailed = vi.fn();
    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-webhook",
          key: "webhook",
          config: {
            url: "https://allowed.example/hook",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-webhook",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed,
      },
    } as unknown as Storage;

    const result = await executeTool(
      {
        toolName: "webhook.send",
        args: {
          connectionId: "conn-webhook",
          message: "Only the approved webhook host may receive this.",
        },
        agentId: "operator",
        sessionId: "sess-webhook-grant",
        policyContext: {
          matchedGrantAllowedHosts: ["allowed.example"],
        } as ToolInvokeRequest["policyContext"],
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["allowed.example", "other.example"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://allowed.example/hook", expect.any(Object));
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-webhook",
      expect.stringMatching(/unknown_after_send|manual reconciliation/i),
      expect.any(String),
      "manual_reconciliation_required",
    );
    expect(result).toMatchObject({
      status: "failed",
      deliveryStatus: "manual_reconciliation_required",
    });
  });

  it("keeps matched grant host constraints enforced across channel attachment redirects", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.MATTERMOST_BOT_TOKEN = "mattermost-token";
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === "https://mattermost.example/api/v4/users/me") {
        return new Response(JSON.stringify({ id: "bot-user-id" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href === "https://allowed.example/file.txt") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example/file.txt" },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const markFailed = vi.fn();
    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-mattermost",
          key: "mattermost",
          config: {
            serverUrl: "https://mattermost.example",
            botTokenEnv: "MATTERMOST_BOT_TOKEN",
            defaultChannel: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-attachment",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed,
      },
    } as unknown as Storage;

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-mattermost",
          message: "Attachment is constrained by the approved grant.",
          attachments: [{ title: "file.txt", url: "https://allowed.example/file.txt" }],
        },
        agentId: "operator",
        sessionId: "sess-attachment-grant",
        policyContext: {
          matchedGrantAllowedHosts: ["mattermost.example", "allowed.example"],
        } as ToolInvokeRequest["policyContext"],
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["mattermost.example", "allowed.example", "other.example"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalledWith("https://other.example/file.txt", expect.any(Object));
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-attachment",
      expect.stringMatching(/unknown_after_send|manual reconciliation/i),
      expect.any(String),
      "manual_reconciliation_required",
    );
    expect(result).toMatchObject({
      status: "failed",
      deliveryStatus: "manual_reconciliation_required",
    });
  });

  it("blocks channel provider API calls outside the matched grant host boundary", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const markFailed = vi.fn();
    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-line",
          key: "line",
          config: {
            channelAccessToken: "line-token",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-line",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed,
      },
    } as unknown as Storage;

    const result = await executeTool(
      {
        toolName: "line.send",
        args: {
          connectionId: "conn-line",
          target: "user-line-1",
          message: "Grant does not allow the LINE provider host.",
        },
        agentId: "operator",
        sessionId: "sess-line-grant",
        policyContext: {
          matchedGrantAllowedHosts: ["approved.example"],
        } as ToolInvokeRequest["policyContext"],
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["api.line.me", "approved.example"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-line",
      expect.stringMatching(/allowlisted/i),
      expect.any(String),
      "blocked",
    );
    expect(result).toMatchObject({
      status: "failed",
      deliveryStatus: "blocked",
    });
  });

  it("blocks reaction provider API calls outside the matched grant host boundary", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const markFailed = vi.fn();
    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-slack",
          key: "slack",
          config: {
            botToken: "xoxb-test",
            defaultChannel: "C0123456789",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-slack-react",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed,
      },
    } as unknown as Storage;

    const result = await executeTool(
      {
        toolName: "slack.react",
        args: {
          connectionId: "conn-slack",
          messageId: "1712345678.000100",
          reaction: "white_check_mark",
        },
        agentId: "operator",
        sessionId: "sess-slack-react-grant",
        policyContext: {
          matchedGrantAllowedHosts: ["approved.example"],
        } as ToolInvokeRequest["policyContext"],
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["slack.com", "approved.example"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-slack-react",
      expect.stringMatching(/allowlisted/i),
      expect.any(String),
      "blocked",
    );
    expect(result).toMatchObject({
      status: "failed",
      deliveryStatus: "blocked",
    });
  });

  it("marks a direct mutation adapter redirect as unknown after send without contacting hop two", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example/reactions.add" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const markFailed = vi.fn();
    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-slack",
          key: "slack",
          config: { botToken: "xoxb-test", defaultChannel: "C0123456789" },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-slack-react-redirect",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed,
      },
    } as unknown as Storage;

    const result = await executeTool(
      {
        toolName: "slack.react",
        args: {
          connectionId: "conn-slack",
          messageId: "1712345678.000100",
          reaction: "white_check_mark",
        },
        agentId: "operator",
        sessionId: "sess-slack-react-redirect",
        policyContext: {
          matchedGrantAllowedHosts: ["slack.com", "other.example"],
        } as ToolInvokeRequest["policyContext"],
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["slack.com", "other.example"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-slack-react-redirect",
      expect.stringMatching(/unknown_after_send|manual reconciliation/i),
      expect.any(String),
      "manual_reconciliation_required",
    );
    expect(result).toMatchObject({
      status: "failed",
      deliveryStatus: "manual_reconciliation_required",
      error: expect.stringContaining("unknown_after_send"),
    });
  });

  it("marks a mutation response-body limit failure as unknown after send", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 })),
    );
    const markFailed = vi.fn();
    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-slack",
          key: "slack",
          config: { botToken: "xoxb-test", defaultChannel: "C0123456789" },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-slack-react-large-response",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed,
      },
    } as unknown as Storage;

    const result = await executeTool(
      {
        toolName: "slack.react",
        args: {
          connectionId: "conn-slack",
          messageId: "1712345678.000100",
          reaction: "white_check_mark",
        },
        agentId: "operator",
        sessionId: "sess-slack-react-large-response",
      },
      { ...policyConfig, sandbox: { ...policyConfig.sandbox, networkAllowlist: ["slack.com"] } },
      commsStorage,
    );

    expect(markFailed).toHaveBeenCalledWith(
      "delivery-slack-react-large-response",
      expect.stringMatching(/unknown_after_send|manual reconciliation/i),
      expect.any(String),
      "manual_reconciliation_required",
    );
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "manual_reconciliation_required" });
  });

  it("blocks Gmail side-effect calls outside the matched grant host boundary", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "gmail-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const markFailed = vi.fn();
    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-gmail",
          key: "gmail",
          config: {
            accessToken: "gmail-token",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-gmail",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed,
      },
    } as unknown as Storage;

    const result = await executeTool(
      {
        toolName: "gmail.send",
        args: {
          connectionId: "conn-gmail",
          to: ["operator@example.com"],
          subject: "Grant check",
          bodyText: "This should not leave through Gmail.",
        },
        agentId: "operator",
        sessionId: "sess-gmail-grant",
        policyContext: {
          matchedGrantAllowedHosts: ["approved.example"],
        } as ToolInvokeRequest["policyContext"],
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["gmail.googleapis.com", "approved.example"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-gmail",
      expect.stringMatching(/allowlisted/i),
      expect.any(String),
      "blocked",
    );
    expect(result).toMatchObject({
      status: "failed",
      deliveryStatus: "blocked",
    });
  });

  it("does not retry ambiguous Slack mutations and requires manual reconciliation", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false }), { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, ts: "1712345678.000200" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

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
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-retry",
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-slack",
          message: "Retry this.",
        },
        agentId: "operator",
        sessionId: "sess-slack",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["slack.com"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      deliveryStatus: "manual_reconciliation_required",
    });
  });

  it("quarantines a sent mutation when delivery-ledger finalization fails", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, ts: "1712345678.000300", channel: "C123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const markFailed = vi.fn();
    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-slack-ledger-failure",
          key: "slack",
          config: { botTokenEnv: "SLACK_BOT_TOKEN", defaultChannel: "#build-alerts" },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn(() => ({
          deliveryId: "delivery-ledger-failure",
          status: "queued",
          channelKey: "slack",
          target: "#build-alerts",
          createdAt: "2026-03-18T00:00:00.000Z",
          updatedAt: "2026-03-18T00:00:00.000Z",
        })),
        markSent: vi.fn(() => {
          throw new Error("delivery ledger unavailable");
        }),
        markFailed,
      },
    } as unknown as Storage;

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: { connectionId: "conn-slack-ledger-failure", message: "Send exactly once." },
        agentId: "operator",
        sessionId: "sess-slack-ledger-failure",
      },
      { ...policyConfig, sandbox: { ...policyConfig.sandbox, networkAllowlist: ["slack.com"] } },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      deliveryStatus: "manual_reconciliation_required",
      providerMessageId: "1712345678.000300",
    });
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-ledger-failure",
      expect.stringMatching(/post_send_bookkeeping_failed/i),
      expect.any(String),
      "manual_reconciliation_required",
      undefined,
      "1712345678.000300",
    );
  });

  it("sends Discord webhook messages with inline uploads and URL embeds", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "discord-msg-123",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
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

    const result = await executeTool(
      {
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
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["discord.com"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123/abc?wait=true",
      expect.objectContaining({ method: "POST" }),
    );
    const discordCall = fetchMock.mock.calls[0] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(discordCall?.[1]?.body).toBeInstanceOf(FormData);
    const formData = discordCall?.[1]?.body as FormData;
    expect(String(formData.get("payload_json") ?? "")).toContain('"content":"Deployment artifacts attached."');
    expect(String(formData.get("payload_json") ?? "")).toContain('"allowed_mentions":{"parse":[]}');
    expect(String(formData.get("payload_json") ?? "")).toContain("https://example.com/screenshot.png");
    const uploadedFile = formData.get("files[0]");
    expect(uploadedFile).toBeInstanceOf(File);
    expect((uploadedFile as File).name).toBe("build.log");
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "discord-msg-123",
    });
  });

  it("sanitizes Discord outbound messages before delivery and disables mentions", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "discord-msg-sanitized" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-discord",
          key: "discord",
          config: {
            webhookUrl: "https://discord.com/api/webhooks/123/abc",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-discord-sanitized",
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

    await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-discord",
          message: ["Deploy ready @everyone", "<thinking>internal provider trace</thinking>"].join("\n"),
        },
        agentId: "operator",
        sessionId: "sess-discord-sanitized",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["discord.com"],
        },
      },
      commsStorage,
    );

    const call = fetchMock.mock.calls[0] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    const body = JSON.parse(String(call?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({
      content: "Deploy ready @ everyone",
      allowed_mentions: { parse: [] },
    });
  });

  it("sends Telegram URL image attachments through sendPhoto with a caption", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.TELEGRAM_BOT_TOKEN = "tg-token";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 321 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-telegram",
          message: "Screenshot attached.",
          attachments: [{ title: "graph.png", url: "https://example.com/graph.png", mimeType: "image/png" }],
        },
        agentId: "operator",
        sessionId: "sess-telegram-send",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["api.telegram.org"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottg-token/sendPhoto",
      expect.objectContaining({ method: "POST" }),
    );
    const telegramCall = fetchMock.mock.calls[0] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(String(telegramCall?.[1]?.body ?? "")).toContain('"chat_id":"-1001234567890"');
    expect(String(telegramCall?.[1]?.body ?? "")).toContain('"photo":"https://example.com/graph.png"');
    expect(String(telegramCall?.[1]?.body ?? "")).toContain('"caption":"Screenshot attached."');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "321",
    });
  });

  it("reports a Telegram mutation redirect as unknown after send without contacting hop two", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.TELEGRAM_BOT_TOKEN = "tg-token";
    const contactedUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      contactedUrls.push(String(url));
      return new Response(null, {
        status: 302,
        headers: { location: "https://other.example/telegram-result" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const markFailed = vi.fn();
    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-telegram-redirect",
          key: "telegram",
          config: { botTokenEnv: "TELEGRAM_BOT_TOKEN", defaultChatId: "-1001234567890" },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-telegram-redirect",
          status: "queued",
          channelKey: input.channelKey,
          target: input.target,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        })),
        markSent: vi.fn(),
        markFailed,
      },
    } as unknown as Storage;

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: { connectionId: "conn-telegram-redirect", message: "send once" },
        agentId: "operator",
        sessionId: "sess-telegram-redirect",
      },
      {
        ...policyConfig,
        sandbox: { ...policyConfig.sandbox, networkAllowlist: ["api.telegram.org", "other.example"] },
      },
      commsStorage,
    );

    expect(contactedUrls).toEqual(["https://api.telegram.org/bottg-token/sendMessage"]);
    expect(markFailed).toHaveBeenCalledWith(
      "delivery-telegram-redirect",
      expect.stringMatching(/unknown_after_send|manual reconciliation/i),
      expect.any(String),
      "manual_reconciliation_required",
    );
    expect(result).toMatchObject({ status: "failed", deliveryStatus: "manual_reconciliation_required" });
  });

  it("sends Telegram replies with reply parameters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.TELEGRAM_BOT_TOKEN = "tg-token";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 654 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-telegram-reply",
          key: "telegram",
          config: {
            botTokenEnv: "TELEGRAM_BOT_TOKEN",
            defaultChatId: "-1001234567890",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-telegram-reply",
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-telegram-reply",
          message: "Following up in thread.",
          replyToMessageId: "987654321",
        },
        agentId: "operator",
        sessionId: "sess-telegram-reply",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["api.telegram.org"],
        },
      },
      commsStorage,
    );

    const telegramCall = fetchMock.mock.calls[0] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(String(telegramCall?.[1]?.body ?? "")).toContain('"message_id":987654321');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "654",
    });
  });

  it("uploads inline Slack attachments through the external upload flow", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === "https://slack.com/api/chat.postMessage") {
        return new Response(
          JSON.stringify({
            ok: true,
            ts: "1712345678.000200",
            channel: "C123UPLOAD",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url === "https://slack.com/api/files.getUploadURLExternal") {
        return new Response(
          JSON.stringify({
            ok: true,
            upload_url: "https://files.slack.com/upload/v1/test-upload",
            file_id: "F123UPLOAD",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url === "https://files.slack.com/upload/v1/test-upload") {
        return new Response("", { status: 200 });
      }
      if (url === "https://slack.com/api/files.completeUploadExternal") {
        return new Response(
          JSON.stringify({
            ok: true,
            files: [{ id: "F123UPLOAD", title: "evidence.txt" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-slack-inline",
          message: "Evidence attached.",
          attachments: [
            {
              title: "evidence.txt",
              mimeType: "text/plain",
              dataBase64: Buffer.from("slack-inline-evidence", "utf8").toString("base64"),
            },
          ],
        },
        agentId: "operator",
        sessionId: "sess-slack-inline",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["slack.com", "*.slack.com"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const uploadMetaCall = fetchMock.mock.calls[1] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(String(uploadMetaCall?.[1]?.body ?? "")).toContain('"filename":"evidence.txt"');
    expect(String(uploadMetaCall?.[1]?.body ?? "")).toContain('"length":21');

    const completeCall = fetchMock.mock.calls[3] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(String(completeCall?.[1]?.body ?? "")).toContain('"channel_id":"C123UPLOAD"');
    expect(String(completeCall?.[1]?.body ?? "")).toContain('"thread_ts":"1712345678.000200"');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "1712345678.000200",
    });
  });

  it("threads Slack bot-token replies from generic replyToMessageId inputs", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === "https://slack.com/api/chat.postMessage") {
        return new Response(
          JSON.stringify({
            ok: true,
            ts: "1712345678.000300",
            channel: "C123THREAD",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-slack-thread",
          key: "slack",
          config: {
            botTokenEnv: "SLACK_BOT_TOKEN",
            defaultChannel: "C123THREAD",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-slack-thread",
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-slack-thread",
          target: "C123THREAD",
          message: "Thread reply",
          replyToMessageId: "1712109984.100000",
        },
        agentId: "operator",
        sessionId: "sess-slack-thread",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["slack.com", "*.slack.com"],
        },
      },
      commsStorage,
    );

    const chatPostCall = fetchMock.mock.calls[0] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(String(chatPostCall?.[1]?.body ?? "")).toContain('"thread_ts":"1712109984.100000"');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "1712345678.000300",
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-teams",
          target: "ops-room",
          message: "Nightly validation passed.",
        },
        agentId: "operator",
        sessionId: "sess-teams",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["outlook.office.com"],
        },
      },
      commsStorage,
    );

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

    await executeTool(
      {
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
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["outlook.office.com"],
        },
      },
      commsStorage,
    );

    const teamsCall = fetchMock.mock.calls[0] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    const teamsBody = String(teamsCall?.[1]?.body ?? "");
    expect(teamsBody).toContain('"type":"Image"');
    expect(teamsBody).toContain("https://example.com/graph.png");
    expect(teamsBody).toContain("[Runbook](https://example.com/runbook)");
  });

  it("sends Google Chat webhook attachments as rich cards", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            name: "spaces/AAAA/messages/123",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
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

    const result = await executeTool(
      {
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
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["chat.googleapis.com"],
        },
      },
      commsStorage,
    );

    const googleChatCall = fetchMock.mock.calls[0] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(googleChatCall?.[0]).toContain("threadKey=ops-thread");
    const googleChatBody = String(googleChatCall?.[1]?.body ?? "");
    expect(googleChatBody).toContain('"cardsV2"');
    expect(googleChatBody).toContain('"imageUrl":"https://example.com/screenshot.png"');
    expect(googleChatBody).toContain('"text":"Runbook"');
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-mm",
          message: "Deploy finished.",
        },
        agentId: "operator",
        sessionId: "sess-mm",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["chat.example.com"],
        },
      },
      commsStorage,
    );

    expect(queuedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "town-square",
      }),
    );
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
    expect(String(postBody ?? "")).toContain('"channel_id":"channelid12345678901234567"');
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

    const result = await executeTool(
      {
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
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["chat.example.com"],
        },
      },
      commsStorage,
    );

    const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/v4/files")) as
      | [string, RequestInit & { body?: BodyInit | null }]
      | undefined;
    expect(uploadCall?.[1]?.body).toBeInstanceOf(FormData);
    const uploadBody = uploadCall?.[1]?.body as FormData;
    expect(uploadBody.get("channel_id")).toBe("channelid12345678901234567");
    const uploadedFile = uploadBody.get("files");
    expect(uploadedFile).toBeInstanceOf(File);
    expect((uploadedFile as File).name).toBe("evidence.txt");

    const postCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/v4/posts")) as
      | [string, RequestInit & { body?: BodyInit | null }]
      | undefined;
    expect(String(postCall?.[1]?.body ?? "")).toContain('"file_ids":["file-123"]');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "post-attachment-123",
    });
  });

  it("sends channel messages through LINE bot adapters using shared target keys", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-token";
    const fetchMock = vi.fn(
      async () =>
        new Response("", {
          status: 200,
          headers: { "x-line-request-id": "line-request-123" },
        }),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-line",
          message: "Weekly digest is ready.",
        },
        agentId: "operator",
        sessionId: "sess-line",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["api.line.me"],
        },
      },
      commsStorage,
    );

    expect(queuedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "line:group:C1234567890abcdef1234567890abcd",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.line.me/v2/bot/message/push",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const lineCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const lineBody = (lineCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(lineBody ?? "")).toContain('"to":"C1234567890abcdef1234567890abcd"');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "line-request-123",
    });
  });

  it("sends channel messages through Nextcloud Talk bot adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.NEXTCLOUD_TALK_TOKEN = "nextcloud-secret";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ocs: { data: { id: 9988 } },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-nextcloud",
          message: "Room update complete.",
        },
        agentId: "operator",
        sessionId: "sess-nextcloud",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["cloud.example.com"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/room-token-123/message",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const nextcloudCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const nextcloudInit = nextcloudCallArgs?.[1] as
      | (RequestInit & { body?: BodyInit | null; headers?: HeadersInit })
      | undefined;
    expect(String(nextcloudInit?.body ?? "")).toContain('"message":"Room update complete."');
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
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ocs: { data: { id: 9988 } },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
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

    await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-nextcloud",
          message: "Quoted follow-up",
          replyTo: "1567",
        },
        agentId: "operator",
        sessionId: "sess-nextcloud",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["cloud.example.com"],
        },
      },
      commsStorage,
    );

    const nextcloudCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const nextcloudInit = nextcloudCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined;
    expect(String(nextcloudInit?.body ?? "")).toContain('"replyTo":"1567"');
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-nextcloud",
          message: "Attachment check",
          attachments: [{ url: "https://example.com/photo.png" }],
        },
        agentId: "operator",
        sessionId: "sess-nextcloud",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["cloud.example.com"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "failed",
      error: "Nextcloud Talk does not support attachments in this adapter",
    });
  });

  it("adds reactions through Nextcloud Talk bot adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.NEXTCLOUD_TALK_TOKEN = "nextcloud-secret";
    const fetchMock = vi.fn(
      async () =>
        new Response("", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.react",
        args: {
          connectionId: "conn-nextcloud",
          target: "room-token-123",
          messageId: "1567",
          reaction: "😆",
        },
        agentId: "operator",
        sessionId: "sess-nextcloud",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["cloud.example.com"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/room-token-123/reaction/1567",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const nextcloudCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const nextcloudInit = nextcloudCallArgs?.[1] as
      | (RequestInit & { body?: BodyInit | null; headers?: HeadersInit })
      | undefined;
    expect(String(nextcloudInit?.body ?? "")).toContain('"reaction":"😆"');
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
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            result: { timestamp: 1712345678901 },
            id: "rpc-1",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-signal",
          message: "Bridge delivery complete.",
        },
        agentId: "operator",
        sessionId: "sess-signal",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["signal.example.com"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://signal.example.com/api/v1/rpc",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const signalCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const signalBody = (signalCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(signalBody ?? "")).toContain('"method":"send"');
    expect(String(signalBody ?? "")).toContain('"message":"Bridge delivery complete."');
    expect(String(signalBody ?? "")).toContain('"groupId":"group-123"');
    expect(String(signalBody ?? "")).toContain('"account":"+15557654321"');
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
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                guid: "iMessage;-;+15551234567",
                participants: [{ address: "+15551234567" }],
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              guid: "bb-msg-123",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-imessage",
          message: "Blue bubble delivered.",
        },
        agentId: "operator",
        sessionId: "sess-imessage",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["127.0.0.1"],
        },
      },
      commsStorage,
    );

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
    const sendBody = (sendCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(sendBody ?? "")).toContain('"chatGuid":"iMessage;-;+15551234567"');
    expect(String(sendBody ?? "")).toContain('"message":"Blue bubble delivered."');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "bb-msg-123",
    });
  });

  it("resolves BlueBubbles chat identifier targets from direct chat identifiers", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.IMESSAGE_PASSWORD = "bb-password";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                guid: "iMessage;-;+15559876543",
                identifier: "team-thread",
                participants: [{ address: "+15559876543" }],
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { guid: "bb-msg-chat-ident" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-imessage-ident",
          key: "imessage",
          config: {
            bridgeUrl: "http://127.0.0.1:1234",
            passwordEnv: "IMESSAGE_PASSWORD",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-imessage-ident",
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-imessage-ident",
          target: "chat_identifier:team-thread",
          message: "Identifier resolved.",
        },
        agentId: "operator",
        sessionId: "sess-imessage-ident",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["127.0.0.1"],
        },
      },
      commsStorage,
    );

    const sendCallArgs = fetchMock.mock.calls[1] as unknown[] | undefined;
    const sendBody = (sendCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(sendBody ?? "")).toContain('"chatGuid":"iMessage;-;+15559876543"');
    expect(String(sendBody ?? "")).toContain('"message":"Identifier resolved."');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "bb-msg-chat-ident",
    });
  });

  it("sends iMessage attachments through BlueBubbles multipart delivery", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.IMESSAGE_PASSWORD = "bb-password";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                guid: "iMessage;-;+15551234567",
                participants: [{ address: "+15551234567" }],
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response("image-bytes", {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              hash: "uploaded-hash-1",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              guid: "bb-msg-attachment-123",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
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

    const result = await executeTool(
      {
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
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["127.0.0.1", "files.example.com"],
        },
      },
      commsStorage,
    );

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
    const uploadBody = (uploadCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
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
    const multipartBody = (multipartCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(multipartBody ?? "")).toContain('"chatGuid":"iMessage;-;+15551234567"');
    expect(String(multipartBody ?? "")).toContain('"text":"See attached."');
    expect(String(multipartBody ?? "")).toContain('"attachment":"uploaded-hash-1"');
    expect(String(multipartBody ?? "")).toContain('"name":"goat.png"');
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
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                guid: "iMessage;-;+15551234567",
                participants: [{ address: "+15551234567" }],
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              hash: "uploaded-inline-hash",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              guid: "bb-msg-inline-attachment-123",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
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

    const result = await executeTool(
      {
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
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["127.0.0.1"],
        },
      },
      commsStorage,
    );

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
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                guid: "iMessage;-;+15551234567",
                participants: [{ address: "+15551234567" }],
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              guid: "bb-react-123",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
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

    const result = await executeTool(
      {
        toolName: "channel.react",
        args: {
          connectionId: "conn-imessage",
          messageId: "msg-123",
          reaction: "love",
          partIndex: 1,
        },
        agentId: "operator",
        sessionId: "sess-imessage-react",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["127.0.0.1"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:1234/api/v1/message/react?password=bb-password",
      expect.objectContaining({ method: "POST" }),
    );
    const reactCallArgs = fetchMock.mock.calls[1] as unknown[] | undefined;
    const reactBody = (reactCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(reactBody ?? "")).toContain('"selectedMessageGuid":"msg-123"');
    expect(String(reactBody ?? "")).toContain('"reaction":"love"');
    expect(String(reactBody ?? "")).toContain('"partIndex":1');
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

    const result = await executeTool(
      {
        toolName: "channel.unsend",
        args: {
          connectionId: "conn-imessage",
          messageId: "msg-guid-456",
          partIndex: 0,
        },
        agentId: "operator",
        sessionId: "sess-imessage-unsend",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["127.0.0.1"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/api/v1/message/msg-guid-456/unsend?password=bb-password",
      expect.objectContaining({ method: "POST" }),
    );
    const unsendCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const unsendBody = (unsendCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(unsendBody ?? "")).toContain('"partIndex":0');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "msg-guid-456",
    });
  });

  it("reacts to Slack messages through bot-token connectors", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.react",
        args: {
          connectionId: "conn-slack",
          messageId: "1711111111.000100",
          reaction: ":thumbsup:",
        },
        agentId: "operator",
        sessionId: "sess-slack-react",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["slack.com"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/reactions.add",
      expect.objectContaining({ method: "POST" }),
    );
    const slackCall = fetchMock.mock.calls[0] as [string, RequestInit?] | undefined;
    const slackBody = String(slackCall?.[1]?.body ?? "");
    expect(slackBody).toContain('"channel":"C123"');
    expect(slackBody).toContain('"timestamp":"1711111111.000100"');
    expect(slackBody).toContain('"name":"thumbsup"');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "1711111111.000100",
    });
  });

  it("unsends Slack messages through bot-token connectors", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.unsend",
        args: {
          connectionId: "conn-slack",
          messageId: "1711111111.000100",
        },
        agentId: "operator",
        sessionId: "sess-slack-unsend",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["slack.com"],
        },
      },
      commsStorage,
    );

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

    const result = await executeTool(
      {
        toolName: "channel.unsend",
        args: {
          connectionId: "conn-discord",
          messageId: "msg-999",
        },
        agentId: "operator",
        sessionId: "sess-discord-unsend",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["discord.com"],
        },
      },
      commsStorage,
    );

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
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.unsend",
        args: {
          connectionId: "conn-telegram",
          messageId: "77",
        },
        agentId: "operator",
        sessionId: "sess-telegram-unsend",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["api.telegram.org"],
        },
      },
      commsStorage,
    );

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
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.react",
        args: {
          connectionId: "conn-telegram-react",
          messageId: "987654321",
          reaction: "👍",
        },
        agentId: "operator",
        sessionId: "sess-telegram-react",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["api.telegram.org"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottg-token/setMessageReaction",
      expect.objectContaining({ method: "POST" }),
    );
    const telegramCall = fetchMock.mock.calls[0] as [string, RequestInit & { body?: BodyInit | null }] | undefined;
    expect(String(telegramCall?.[1]?.body ?? "")).toContain('"message_id":987654321');
    expect(String(telegramCall?.[1]?.body ?? "")).toContain('"emoji":"👍"');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "987654321",
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

    const result = await executeTool(
      {
        toolName: "channel.unsend",
        args: {
          connectionId: "conn-mattermost",
          messageId: "post-123",
        },
        agentId: "operator",
        sessionId: "sess-mattermost-unsend",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["127.0.0.1"],
        },
      },
      commsStorage,
    );

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
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              guid: "bb-created-chat-msg",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                guid: "iMessage;-;+15551234567",
                participants: [{ address: "+15551234567" }],
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response("image-bytes", {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              hash: "uploaded-hash-new-chat",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              guid: "bb-msg-new-chat-attachment",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
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

    const result = await executeTool(
      {
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
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["127.0.0.1", "files.example.com"],
        },
      },
      commsStorage,
    );

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
    const createChatBody = (createChatCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(createChatBody ?? "")).toContain('"addresses":["+15551234567"]');
    expect(String(createChatBody ?? "")).not.toContain('"message":');
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
    const multipartBody = (multipartCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(multipartBody ?? "")).toContain('"attachment":"uploaded-hash-new-chat"');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "bb-msg-new-chat-attachment",
    });
  });

  it("sends channel messages through WhatsApp Cloud API adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.WHATSAPP_ACCESS_TOKEN = "wa-token";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messaging_product: "whatsapp",
            messages: [{ id: "wamid.12345" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-whatsapp",
          message: "Cloud delivery complete.",
        },
        agentId: "operator",
        sessionId: "sess-whatsapp",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["graph.facebook.com"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v23.0/123456789012345/messages",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const whatsappCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const whatsappBody = (whatsappCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(whatsappBody ?? "")).toContain('"messaging_product":"whatsapp"');
    expect(String(whatsappBody ?? "")).toContain('"to":"15551234567"');
    expect(String(whatsappBody ?? "")).toContain('"body":"Cloud delivery complete."');
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
      return new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          messages: [{ id: `wamid.rich.${messageCounter}` }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-whatsapp-rich",
          message: "Cloud delivery with image.",
          attachments: [
            {
              url: "https://cdn.example.com/test-image.png",
              title: "test-image.png",
              mimeType: "image/png",
            },
          ],
        },
        agentId: "operator",
        sessionId: "sess-whatsapp-rich",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["graph.facebook.com"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const attachmentCall = fetchMock.mock.calls[1] as unknown[] | undefined;
    const attachmentBody = (attachmentCall?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(attachmentBody ?? "")).toContain('"type":"image"');
    expect(String(attachmentBody ?? "")).toContain('"link":"https://cdn.example.com/test-image.png"');
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
        return new Response(
          JSON.stringify({
            id: "media-inline-123",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.endsWith("/messages")) {
        return new Response(
          JSON.stringify({
            messaging_product: "whatsapp",
            messages: [{ id: "wamid.inline.123" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-whatsapp-inline",
          attachments: [
            {
              title: "receipt.pdf",
              mimeType: "application/pdf",
              dataBase64: Buffer.from("inline-whatsapp-file").toString("base64"),
            },
          ],
        },
        agentId: "operator",
        sessionId: "sess-whatsapp-inline",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["graph.facebook.com"],
        },
      },
      commsStorage,
    );

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
    const messageBody = (messageCall?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(messageBody ?? "")).toContain('"type":"document"');
    expect(String(messageBody ?? "")).toContain('"id":"media-inline-123"');
    expect(String(messageBody ?? "")).toContain('"filename":"receipt.pdf"');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "wamid.inline.123",
    });
  });

  it("adds WhatsApp reactions through the Cloud API", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.WHATSAPP_ACCESS_TOKEN = "wa-token";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messaging_product: "whatsapp",
            messages: [{ id: "wamid.react.123" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.react",
        args: {
          connectionId: "conn-whatsapp-react",
          messageId: "wamid.original.1",
          reaction: "👍",
        },
        agentId: "operator",
        sessionId: "sess-whatsapp-react",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["graph.facebook.com"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v23.0/123456789012345/messages",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const whatsappCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const whatsappBody = (whatsappCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(whatsappBody ?? "")).toContain('"type":"reaction"');
    expect(String(whatsappBody ?? "")).toContain('"message_id":"wamid.original.1"');
    expect(String(whatsappBody ?? "")).toContain('"emoji":"👍"');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "wamid.react.123",
    });
  });

  it("rejects malicious WhatsApp baseUrl configurations", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const commsStorage = {
      integrationConnections: {
        get: vi.fn(() => ({
          connectionId: "conn-whatsapp-malicious",
          key: "whatsapp",
          config: {
            accessTokenEnv: "WHATSAPP_ACCESS_TOKEN",
            phoneNumberId: "123456789012345",
            baseUrl: "https://malicious-host.com",
            defaultTarget: "+15551234567",
          },
        })),
      },
      commsDeliveries: {
        createQueued: vi.fn((input: Record<string, unknown>) => ({
          deliveryId: "delivery-whatsapp-malicious",
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-whatsapp-malicious",
          message: "This should fail.",
        },
        agentId: "operator",
        sessionId: "sess-whatsapp-malicious",
      },
      policyConfig,
      commsStorage,
    );

    expect(result).toMatchObject({
      status: "failed",
      error: 'WhatsApp outbound URL host "malicious-host.com" is not an allowed Meta or localhost domain.',
    });
  });

  it("sends channel messages through Zalo Personal zca bridge adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.ZALOUSER_AUTH_TOKEN = "zlu-token";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messageId: "zlu-msg-123",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-zalouser",
          message: "Zalo personal delivery complete.",
        },
        agentId: "operator",
        sessionId: "sess-zalouser",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["127.0.0.1"],
        },
      },
      commsStorage,
    );

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
    const zaloUserBody = (zaloUserCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(zaloUserBody ?? "")).toContain('"threadId":"g-987654321"');
    expect(String(zaloUserBody ?? "")).toContain('"isGroup":true');
    expect(String(zaloUserBody ?? "")).toContain('"message":"Zalo personal delivery complete."');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "zlu-msg-123",
    });
  });

  it("routes Zalo Personal image attachments to the zca media endpoint", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.ZALOUSER_AUTH_TOKEN = "zlu-token";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messageId: "zlu-media-123",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
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

    const result = await executeTool(
      {
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
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["127.0.0.1", "example.com"],
        },
      },
      commsStorage,
    );

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
    const mediaBody = (mediaCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(String(mediaBody ?? "")).toContain('"threadId":"u-123456789"');
    expect(String(mediaBody ?? "")).toContain('"isGroup":false');
    expect(String(mediaBody ?? "")).toContain('"url":"https://example.com/photo.png"');
    expect(String(mediaBody ?? "")).toContain('"message":"Photo attached."');
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "zlu-media-123",
    });
  });

  it("sends channel messages through Zalo bot adapters", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    process.env.ZALO_ACCESS_TOKEN = "zalo-token";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 0,
            message: "Success",
            data: { message_id: "zalo-msg-1" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
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

    const result = await executeTool(
      {
        toolName: "channel.send",
        args: {
          connectionId: "conn-zalo",
          message: "Broadcast ready.",
        },
        agentId: "operator",
        sessionId: "sess-zalo",
      },
      {
        ...policyConfig,
        sandbox: {
          ...policyConfig.sandbox,
          networkAllowlist: ["openapi.zalo.me"],
        },
      },
      commsStorage,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openapi.zalo.me/v2.0/oa/message",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          access_token: "zalo-token",
        }),
      }),
    );
    const zaloCallArgs = fetchMock.mock.calls[0] as unknown[] | undefined;
    const zaloBody = (zaloCallArgs?.[1] as (RequestInit & { body?: BodyInit | null }) | undefined)?.body;
    expect(JSON.parse(String(zaloBody ?? ""))).toEqual({
      recipient: { user_id: "chat-123" },
      message: { text: "Broadcast ready." },
    });
    expect(result).toMatchObject({
      status: "sent",
      providerMessageId: "zalo-msg-1",
    });
  });

  it("redacts secret-looking material from model-visible tool results", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("Authorization: Bearer token-12345678901234567890", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    ) as unknown as typeof fetch;

    try {
      const result = await executeTool(
        {
          toolName: "http.get",
          args: { url: "https://example.com/secret" },
          agentId: "agent",
          sessionId: "sess-http-redact",
        },
        policyConfig,
        storageStub,
      );

      expect(String(result.body ?? "")).toContain("[REDACTED]");
      expect(String(result.body ?? "")).not.toContain("token-12345678901234567890");
      expect(result.security).toMatchObject({
        sanitizedForModel: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("redacts URLs in redirect errors before they can reach tool transcripts", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("", { status: 302 })) as unknown as typeof fetch;

    try {
      let captured = "";
      try {
        await executeTool(
          {
            toolName: "http.get",
            args: { url: "https://example.com/api/bot-secret-token?password=hunter2" },
            agentId: "agent",
            sessionId: "sess-http-redirect-redact",
          },
          policyConfig,
          storageStub,
        );
      } catch (error) {
        captured = error instanceof Error ? error.message : String(error);
      }
      expect(captured).toBe("Redirect missing location for https://example.com");
      expect(captured).not.toContain("bot-secret-token");
      expect(captured).not.toContain("hunter2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not enforce an unrelated grant host boundary when the matched grant has none", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const storageWithMixedGrants = {
      toolGrants: {
        get: vi.fn(() => ({
          grantId: "grant-unconstrained",
          toolPattern: "http.get",
          decision: "allow",
          scope: "session",
          scopeRef: "sess-http",
          grantType: "persistent",
          createdBy: "test",
          createdAt: new Date().toISOString(),
        })),
        list: vi.fn(() => [
          {
            grantId: "grant-other-host",
            toolPattern: "http.get",
            decision: "allow",
            scope: "session",
            scopeRef: "sess-http",
            grantType: "persistent",
            constraints: { allowedHosts: ["other.example"] },
            createdBy: "test",
            createdAt: new Date().toISOString(),
          },
        ]),
      },
    } as unknown as Storage;

    try {
      const result = await executeTool(
        {
          toolName: "http.get",
          args: { url: "https://example.com/data" },
          agentId: "agent",
          sessionId: "sess-http",
          policyContext: { matchedGrantId: "grant-unconstrained" },
        },
        policyConfig,
        storageWithMixedGrants,
      );

      expect(result).toMatchObject({ body: "ok" });
      expect(storageWithMixedGrants.toolGrants.list).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("caches native ingested documents and searches attributed chunks", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const documents: Array<Record<string, unknown>> = [];
    const chunksByDocId = new Map<string, Array<Record<string, unknown>>>();
    let documentSeq = 0;
    let chunkSeq = 0;
    const storage = {
      knowledge: {
        listDocuments: vi.fn((namespace?: string) =>
          documents.filter((doc) => !namespace || doc.namespace === namespace),
        ),
        createDocument: vi.fn((input: Record<string, unknown>) => {
          const doc = {
            docId: `doc-${++documentSeq}`,
            namespace: input.namespace,
            sourceType: input.sourceType,
            sourceRef: input.sourceRef,
            title: input.title,
            metadata: input.metadata ?? {},
            createdAt: new Date().toISOString(),
          };
          documents.unshift(doc);
          return doc;
        }),
        appendChunks: vi.fn((docId: string, entries: Array<Record<string, unknown>>) => {
          const saved = entries.map((entry, index) => ({
            chunkId: `chunk-${++chunkSeq}`,
            docId,
            seq: index,
            content: entry.content,
            embedding: entry.embedding,
            tokenEstimate: 1,
            createdAt: new Date().toISOString(),
          }));
          chunksByDocId.set(docId, saved);
          return saved;
        }),
        listChunksByDocument: vi.fn((docId: string) => chunksByDocId.get(docId) ?? []),
        listChunksByNamespace: vi.fn((namespace?: string) => {
          const matchingDocIds = documents
            .filter((doc) => !namespace || doc.namespace === namespace)
            .map((doc) => String(doc.docId));
          return matchingDocIds.flatMap((docId) => chunksByDocId.get(docId) ?? []);
        }),
      },
    } as unknown as Storage;

    const ingestRequest: ToolInvokeRequest = {
      toolName: "docs.ingest",
      args: {
        sourceType: "text",
        source: "Firecrawl is optional. GoatCitadel prefers native ingestion first.",
        namespace: "research",
        cacheTtlSeconds: 3600,
      },
      agentId: "agent",
      sessionId: "sess-docs",
      trustLevel: "trusted_workspace",
    };

    const first = await executeTool(ingestRequest, policyConfig, storage);
    const second = await executeTool(ingestRequest, policyConfig, storage);
    const search = await executeTool(
      {
        toolName: "docs.search",
        args: {
          namespace: "research",
          query: "native ingestion",
        },
        agentId: "agent",
        sessionId: "sess-docs",
      },
      policyConfig,
      storage,
    );

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect((search.items as Array<Record<string, unknown>>)[0]?.attribution).toMatchObject({
      sourceType: "text",
      backend: "native",
    });
  });

  it("ingests URL documents through Firecrawl v2 scrape", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const documents: Array<Record<string, unknown>> = [];
    const chunksByDocId = new Map<string, Array<Record<string, unknown>>>();
    let documentSeq = 0;
    let chunkSeq = 0;
    const storage = {
      knowledge: {
        listDocuments: vi.fn(() => documents),
        createDocument: vi.fn((input: Record<string, unknown>) => {
          const doc = {
            docId: `doc-${++documentSeq}`,
            namespace: input.namespace,
            sourceType: input.sourceType,
            sourceRef: input.sourceRef,
            title: input.title,
            metadata: input.metadata ?? {},
            createdAt: new Date().toISOString(),
          };
          documents.unshift(doc);
          return doc;
        }),
        appendChunks: vi.fn((docId: string, entries: Array<Record<string, unknown>>) => {
          const saved = entries.map((entry, index) => ({
            chunkId: `chunk-${++chunkSeq}`,
            docId,
            seq: index,
            content: entry.content,
            embedding: entry.embedding,
            tokenEstimate: 1,
            createdAt: new Date().toISOString(),
          }));
          chunksByDocId.set(docId, saved);
          return saved;
        }),
        listChunksByDocument: vi.fn((docId: string) => chunksByDocId.get(docId) ?? []),
        listChunksByNamespace: vi.fn(() => []),
      },
    } as unknown as Storage;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        expect(url).toContain("/v2/scrape");
        return new Response(
          JSON.stringify({
            data: {
              markdown: "# Firecrawl\n\nNormalized markdown content.",
              metadata: {
                title: "Firecrawl",
                sourceURL: "https://example.com/firecrawl",
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }) as typeof fetch,
    );

    const result = await executeTool(
      {
        toolName: "docs.ingest",
        args: {
          sourceType: "url",
          source: "https://example.com/firecrawl",
          namespace: "research",
          backend: "firecrawl",
          firecrawlBaseUrl: "http://127.0.0.1:3002",
        },
        agentId: "agent",
        sessionId: "sess-firecrawl",
        trustLevel: "trusted_workspace",
      },
      policyConfig,
      storage,
    );

    expect(result.backend).toMatchObject({ backend: "firecrawl" });
    expect(result.fetchResult).toMatchObject({
      backend: "firecrawl",
      sourceType: "url",
      title: "Firecrawl",
    });
    expect(String((result.document as Record<string, unknown>).text)).toContain("Normalized markdown content");
  });

  it("covers filesystem metadata, artifact, find, copy, move, and delete tools", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    await fs.mkdir(testWorkspaceRoot, { recursive: true });
    const sourcePath = path.join(testWorkspaceRoot, "source.txt");
    const copiedPath = path.join(testWorkspaceRoot, "nested", "copied.txt");
    const movedPath = path.join(testWorkspaceRoot, "nested", "moved.txt");
    const artifactPath = path.join(testWorkspaceRoot, "artifact.md");
    await fs.writeFile(sourcePath, "needle\nsecond line\n", "utf8");

    const list = await executeTool(toolRequest("fs.list", { path: testWorkspaceRoot }), policyConfig, storageStub);
    expect((list.items as Array<Record<string, unknown>>).some((item) => item.name === "source.txt")).toBe(true);

    const stat = await executeTool(toolRequest("fs.stat", { path: sourcePath }), policyConfig, storageStub);
    expect(stat).toMatchObject({ path: sourcePath, isFile: true });

    const found = await executeTool(
      toolRequest("file.find", { path: testWorkspaceRoot, pattern: "needle" }),
      policyConfig,
      storageStub,
    );
    expect(found).toMatchObject({ count: 1, pattern: "needle" });

    const copied = await executeTool(
      toolRequest("fs.copy", { from: sourcePath, to: copiedPath }),
      policyConfig,
      storageStub,
    );
    expect(copied).toMatchObject({ from: sourcePath, to: copiedPath });

    const moved = await executeTool(
      toolRequest("fs.move", { from: copiedPath, to: movedPath }),
      policyConfig,
      storageStub,
    );
    expect(moved).toMatchObject({ from: copiedPath, to: movedPath });

    const artifact = await executeTool(
      toolRequest("artifacts.create", { path: artifactPath, title: "Coverage Artifact", body: "Proof" }),
      policyConfig,
      storageStub,
    );
    expect(artifact).toMatchObject({ path: artifactPath, template: "report" });

    const deleted = await executeTool(toolRequest("fs.delete", { path: movedPath }), policyConfig, storageStub);
    expect(deleted).toMatchObject({ path: movedPath, deleted: true });
  });

  it("covers plain filesystem read/write and safe git read-only tools", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    await fs.mkdir(testWorkspaceRoot, { recursive: true });
    const writePath = path.join(testWorkspaceRoot, "plain", "read-write.txt");

    const written = await executeTool(
      toolRequest("fs.write", { path: writePath, content: "plain filesystem coverage" }),
      policyConfig,
      storageStub,
    );
    expect(written).toMatchObject({ path: writePath, bytesWritten: 25 });

    const read = await executeTool(toolRequest("fs.read", { path: writePath }), policyConfig, storageStub);
    expect(read).toMatchObject({ path: writePath, content: "plain filesystem coverage" });

    const gitStatusResult = await executeTool(toolRequest("git.status", {}), policyConfig, storageStub);
    expect(gitStatusResult.summary).toEqual(expect.any(String));

    const gitDiffResult = await executeTool(toolRequest("git.diff", { staged: false }), policyConfig, storageStub);
    expect(gitDiffResult).toMatchObject({ staged: false, truncated: expect.any(Boolean) });
  });

  it("treats no-op filesystem writes as terminal tool failures with guidance", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    await fs.mkdir(testWorkspaceRoot, { recursive: true });
    const writePath = path.join(testWorkspaceRoot, "plain", "no-op-write.txt");
    await fs.mkdir(path.dirname(writePath), { recursive: true });
    await fs.writeFile(writePath, "already here", "utf8");

    await expect(
      executeTool(toolRequest("fs.write", { path: writePath, content: "already here" }), policyConfig, storageStub),
    ).rejects.toThrow(/fs\.write made no changes/);
  });

  it("covers HTTP POST execution and sanitizes leaked tool output", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Bearer abcdefghijklmnopqrstuvwxyz", { status: 201 })) as typeof fetch,
    );

    const result = await executeTool(
      toolRequest("http.post", { url: "https://example.com/api", body: { ok: true } }),
      policyConfig,
      storageStub,
    );

    expect(result).toMatchObject({
      url: "https://example.com/api",
      status: 201,
      body: "[REDACTED]",
      security: {
        sanitizedForModel: true,
        leakDetections: ["bearer_token"],
      },
    });
  });

  it("covers memory write, read, search, and embeddings tools", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const harness = createExecutorKnowledgeHarness();

    const written = await executeTool(
      toolRequest("memory.write", {
        namespace: "project",
        title: "Operator Notes",
        content: "GoatCitadel prefers native ingestion and visible operator truth.",
        tags: ["coverage", "memory"],
        metadata: { source: "test" },
      }),
      policyConfig,
      harness.storage,
    );
    expect(written).toMatchObject({ mode: "write", chunksSaved: 1 });

    const upserted = await executeTool(
      toolRequest("memory.upsert", {
        namespace: "project",
        title: "Operator Notes",
        content: "Updated memory keeps operator truth visible.",
      }),
      policyConfig,
      harness.storage,
    );
    expect(upserted).toMatchObject({ mode: "upsert" });

    const listed = await executeTool(
      toolRequest("memory.read", { namespace: "project" }),
      policyConfig,
      harness.storage,
    );
    expect((listed.items as Array<Record<string, unknown>>).length).toBeGreaterThan(0);

    const queried = await executeTool(
      toolRequest("memory.read", { namespace: "project", query: "operator truth" }),
      policyConfig,
      harness.storage,
    );
    expect((queried.items as Array<Record<string, unknown>>)[0]?.score).toBeGreaterThan(0);

    const searched = await executeTool(
      toolRequest("memory.search", { namespace: "project", query: "native" }),
      policyConfig,
      harness.storage,
    );
    expect((searched.items as Array<Record<string, unknown>>)[0]?.snippet).toContain("native ingestion");
    expect((searched.items as Array<Record<string, unknown>>)[0]?.attribution).toMatchObject({
      sourceType: "memory",
      trustLevel: "trusted_workspace",
    });

    const indexed = await executeTool(
      toolRequest("embeddings.index", { namespace: "project", force: true }),
      policyConfig,
      harness.storage,
    );
    expect(indexed).toMatchObject({ namespace: "project", indexed: 2 });

    const embeddingResults = await executeTool(
      toolRequest("embeddings.query", { namespace: "project", query: "operator truth" }),
      policyConfig,
      harness.storage,
    );
    expect(embeddingResults).toMatchObject({ method: "pseudo-embedding" });
    expect((embeddingResults.items as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
    expect((embeddingResults.items as Array<Record<string, unknown>>)[0]?.attribution).toMatchObject({
      trustLevel: "trusted_workspace",
    });

    const docId = String((written.document as Record<string, unknown>).docId);
    const indexedByDocument = await executeTool(
      toolRequest("embeddings.index", { documentId: docId }),
      policyConfig,
      harness.storage,
    );
    expect(indexedByDocument).toMatchObject({ documentId: docId, indexed: 0 });
  });

  it("returns source attribution for memory reads and searches over ingested URL and text documents", async () => {
    const harness = createExecutorKnowledgeHarness();
    const urlDocument = harness.storage.knowledge.createDocument({
      namespace: "project",
      sourceType: "url",
      sourceRef: "https://example.com/untrusted",
      title: "External instructions",
      metadata: {
        ingestion: {
          backend: "native",
          fetchedAt: "2026-03-22T12:00:00.000Z",
        },
      },
    });
    const textDocument = harness.storage.knowledge.createDocument({
      namespace: "project",
      sourceType: "text",
      sourceRef: "pasted operator draft",
      title: "Pasted draft",
      metadata: {
        ingestion: {
          backend: "native",
          fetchedAt: "2026-03-22T12:01:00.000Z",
        },
      },
    });
    harness.storage.knowledge.appendChunks(urlDocument.docId, [{ content: "unsafe install command" }]);
    harness.storage.knowledge.appendChunks(textDocument.docId, [{ content: "unsafe pasted command" }]);

    const read = await executeTool(
      toolRequest("memory.read", { namespace: "project", query: "unsafe install" }),
      policyConfig,
      harness.storage,
    );
    const search = await executeTool(
      toolRequest("memory.search", { namespace: "project", query: "unsafe" }),
      policyConfig,
      harness.storage,
    );

    expect((read.items as Array<Record<string, unknown>>)[0]?.attribution).toMatchObject({
      sourceType: "url",
      sourceRef: "https://example.com/untrusted",
      trustLevel: "untrusted_external",
    });
    expect((search.items as Array<Record<string, unknown>>).map((item) => item.attribution)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: "url",
          trustLevel: "untrusted_external",
        }),
        expect.objectContaining({
          sourceType: "text",
          trustLevel: "untrusted_external",
        }),
      ]),
    );

    const embeddingResults = await executeTool(
      toolRequest("embeddings.query", { namespace: "project", query: "unsafe install" }),
      policyConfig,
      harness.storage,
    );
    expect((embeddingResults.items as Array<Record<string, unknown>>).map((item) => item.attribution)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: "url",
          trustLevel: "untrusted_external",
        }),
      ]),
    );
  });

  it("preserves untrusted source attribution when retrieved content is written into memory", async () => {
    const harness = createExecutorKnowledgeHarness();

    const writeResult = await executeTool(
      {
        ...toolRequest("memory.write", {
          namespace: "project",
          title: "Retrieved external instruction",
          content: "unsafe install command from retrieved context",
        }),
        sourceAttribution: [
          {
            sourceType: "url",
            sourceRef: "https://example.com/untrusted",
            title: "External instructions",
            trustLevel: "untrusted_external",
          },
        ],
      },
      policyConfig,
      harness.storage,
    );

    expect(writeResult).toMatchObject({
      attribution: {
        sourceType: "memory",
        trustLevel: "untrusted_external",
      },
      document: {
        attribution: {
          sourceType: "memory",
          trustLevel: "untrusted_external",
        },
      },
      sourceAttribution: [
        expect.objectContaining({
          sourceType: "url",
          sourceRef: "https://example.com/untrusted",
          trustLevel: "untrusted_external",
        }),
      ],
    });

    const search = await executeTool(
      toolRequest("memory.search", { namespace: "project", query: "unsafe install" }),
      policyConfig,
      harness.storage,
    );
    const embeddingResults = await executeTool(
      toolRequest("embeddings.query", { namespace: "project", query: "unsafe install" }),
      policyConfig,
      harness.storage,
    );

    expect((search.items as Array<Record<string, unknown>>)[0]?.attribution).toMatchObject({
      sourceType: "memory",
      trustLevel: "untrusted_external",
    });
    expect((embeddingResults.items as Array<Record<string, unknown>>)[0]?.attribution).toMatchObject({
      sourceType: "memory",
      trustLevel: "untrusted_external",
    });
  });

  it("covers docs file ingestion, docs search, restricted validation, and shell failures", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    await fs.mkdir(testWorkspaceRoot, { recursive: true });
    const sourcePath = path.join(testWorkspaceRoot, "docs-source.md");
    await fs.writeFile(sourcePath, "# Operator Truth\n\nVisible routing and provenance matter.", "utf8");
    const harness = createExecutorKnowledgeHarness();

    const ingested = await executeTool(
      toolRequest("docs.ingest", {
        sourceType: "file",
        source: sourcePath,
        namespace: "docs",
        title: "Operator Truth",
      }),
      policyConfig,
      harness.storage,
    );
    expect(ingested).toMatchObject({ backend: { backend: "native" }, chunksSaved: expect.any(Number) });

    const searched = await executeTool(
      toolRequest("docs.search", { namespace: "docs", query: "provenance" }),
      policyConfig,
      harness.storage,
    );
    expect((searched.items as Array<Record<string, unknown>>).length).toBeGreaterThan(0);

    await expect(
      executeTool(toolRequest("tests.run", { manager: "pnpm", filter: "bad filter" }), policyConfig, storageStub),
    ).rejects.toThrow(/Invalid filter/i);
    await expect(executeTool(toolRequest("lint.run", { manager: "yarn" }), policyConfig, storageStub)).rejects.toThrow(
      /Only pnpm\/npm are allowed/i,
    );

    const shellFailure = await executeTool(
      toolRequest("shell.exec", {
        command: `"${process.execPath}" -e "process.stdout.write('/etc/secret-token'); process.stderr.write('boom'); process.exit(7)"`,
      }),
      policyConfig,
      storageStub,
    );
    expect(shellFailure).toMatchObject({
      exitCode: 7,
      stdout: "[REDACTED]",
      stderr: "boom",
    });
  });

  it("rejects non-canonical docs.ingest sourceType values before ingestion execution", async () => {
    await expect(
      executeTool(
        toolRequest("docs.ingest", {
          sourceType: " file ",
          source: "F:/outside/docs.md",
          namespace: "docs",
        }),
        policyConfig,
        storageStub,
      ),
    ).rejects.toThrow(/sourceType must be one of file\|url\|text/);
  });

  it("rejects non-canonical docs.ingest backend values before ingestion execution", async () => {
    await expect(
      executeTool(
        toolRequest("docs.ingest", {
          sourceType: "url",
          source: "https://example.com/firecrawl",
          namespace: "docs",
          backend: " firecrawl ",
          firecrawlBaseUrl: "https://firecrawl.example",
        }),
        policyConfig,
        storageStub,
      ),
    ).rejects.toThrow(/backend must be one of native\|firecrawl/);
  });

  it("covers top-level time and secret rejection paths", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);

    const now = await executeTool(toolRequest("time.now", {}), policyConfig, storageStub);
    expect(now).toMatchObject({ timezone: expect.any(String), epochMs: expect.any(Number) });

    await expect(
      executeTool(toolRequest("session.status", { token: "sk-123456789012345678901234" }), policyConfig, storageStub),
    ).rejects.toThrow(/secret-like material/i);
  });

  it("hard-kills a shell.exec command tree that exceeds the timeout", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    // A child that holds an interval open forever; only a tree kill (taskkill /T
    // on Windows or a process-group SIGKILL on POSIX) stops it.
    const longLived = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
    setShellExecTimeoutMsForTesting(300);
    let result: Record<string, unknown>;
    try {
      result = await executeTool(toolRequest("shell.exec", { command: longLived }), policyConfig, storageStub);
    } finally {
      setShellExecTimeoutMsForTesting();
    }

    expect(result).toMatchObject({ exitCode: -1 });
    expect(String(result.stderr ?? "")).toMatch(/timed out/i);
    // The spawned process must be gone after the executor returns.
    await expectPidDead(extractPid(result));
  }, 15_000);

  it("registers a shell.exec_background pid and kills it via killBackgroundProcess", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const result = await executeTool(
      toolRequest("shell.exec_background", {
        command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
      }),
      policyConfig,
      storageStub,
    );

    const pid = result.pid as number;
    expect(typeof pid).toBe("number");
    expect(isPidAlive(pid)).toBe(true);

    expect(killBackgroundProcess(pid)).toBe(true);
    await expectPidDead(pid);
    // Idempotent: a second kill of the same (now unregistered) pid is a no-op.
    expect(killBackgroundProcess(pid)).toBe(false);
  }, 15_000);

  it("kills all registered background processes via killAllBackgroundProcesses", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const first = (await executeTool(
      toolRequest("shell.exec_background", {
        command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
      }),
      policyConfig,
      storageStub,
    )) as { pid: number };
    const second = (await executeTool(
      toolRequest("shell.exec_background", {
        command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
      }),
      policyConfig,
      storageStub,
    )) as { pid: number };

    expect(isPidAlive(first.pid)).toBe(true);
    expect(isPidAlive(second.pid)).toBe(true);

    const killed = killAllBackgroundProcesses();
    expect(killed).toBeGreaterThanOrEqual(2);
    await expectPidDead(first.pid);
    await expectPidDead(second.pid);
  }, 15_000);

  it("kills a background shell process tree when its abort signal fires", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const controller = new AbortController();
    const result = (await executeTool(
      {
        toolName: "shell.exec_background",
        args: { command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"` },
        agentId: "agent",
        sessionId: "sess-bg-abort",
        signal: controller.signal,
      },
      policyConfig,
      storageStub,
    )) as { pid: number };

    expect(isPidAlive(result.pid)).toBe(true);
    controller.abort();
    await expectPidDead(result.pid);
  }, 15_000);

  it("kills a shell.exec command tree when its abort signal fires", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const controller = new AbortController();
    const pending = executeTool(
      {
        toolName: "shell.exec",
        args: { command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"` },
        agentId: "agent",
        sessionId: "sess-exec-abort",
        signal: controller.signal,
      },
      policyConfig,
      storageStub,
    );
    // Give the child a moment to spawn, then abort.
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({ exitCode: -1 });
    expect(String(result.stderr ?? "")).toMatch(/abort/i);
    await expectPidDead(extractPid(result));
  }, 15_000);
});

function extractPid(result: Record<string, unknown>): number | undefined {
  return typeof result.pid === "number" ? result.pid : undefined;
}

function isPidAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number") {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH => no such process. EPERM => exists but not ours (still alive).
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function expectPidDead(pid: number | undefined): Promise<void> {
  if (typeof pid !== "number") {
    return;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isPidAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`process ${pid} still alive after kill`);
}

function toolRequest(toolName: string, args: Record<string, unknown>): ToolInvokeRequest {
  return {
    toolName,
    args,
    agentId: "agent",
    sessionId: "sess-coverage",
  };
}

function createExecutorKnowledgeHarness(): { storage: Storage } {
  const documents: Array<Record<string, unknown>> = [];
  const chunksByDocId = new Map<string, Array<Record<string, unknown>>>();
  let documentSeq = 0;
  let chunkSeq = 0;

  const storage = {
    knowledge: {
      listDocuments: vi.fn((namespace?: string) =>
        documents.filter((doc) => !namespace || doc.namespace === namespace),
      ),
      createDocument: vi.fn((input: Record<string, unknown>) => {
        const doc = {
          docId: `doc-${++documentSeq}`,
          namespace: input.namespace,
          sourceType: input.sourceType,
          sourceRef: input.sourceRef,
          title: input.title,
          metadata: input.metadata ?? {},
          createdAt: new Date().toISOString(),
        };
        documents.unshift(doc);
        return doc;
      }),
      appendChunks: vi.fn((docId: string, entries: Array<Record<string, unknown>>) => {
        const saved = entries.map((entry, index) => ({
          chunkId: `chunk-${++chunkSeq}`,
          docId,
          seq: index,
          content: String(entry.content ?? ""),
          embedding: entry.embedding as number[] | undefined,
          embeddingMetadata: entry.embeddingMetadata as Record<string, unknown> | undefined,
          tokenEstimate: 1,
          createdAt: new Date().toISOString(),
        }));
        chunksByDocId.set(docId, [...(chunksByDocId.get(docId) ?? []), ...saved]);
        return saved;
      }),
      listChunksByDocument: vi.fn((docId: string) => chunksByDocId.get(docId) ?? []),
      listChunksByNamespace: vi.fn((namespace?: string) => {
        const matchingDocIds = documents
          .filter((doc) => !namespace || doc.namespace === namespace)
          .map((doc) => String(doc.docId));
        return matchingDocIds.flatMap((docId) => chunksByDocId.get(docId) ?? []);
      }),
      updateChunkEmbedding: vi.fn(
        (chunkId: string, embedding: number[], embeddingMetadata?: Record<string, unknown>) => {
          for (const chunks of chunksByDocId.values()) {
            const chunk = chunks.find((entry) => entry.chunkId === chunkId);
            if (chunk) {
              chunk.embedding = embedding;
              chunk.embeddingMetadata = embeddingMetadata;
              return chunk;
            }
          }
          return undefined;
        },
      ),
    },
  } as unknown as Storage;

  return { storage };
}

async function removeTestWorkspace(target: string): Promise<void> {
  const transientCodes = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!transientCodes.has(String(code)) || attempt === 19) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
