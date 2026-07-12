import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { executeBrowserTool } from "./browser-tools.js";
import { ToolPolicyEngine } from "./engine.js";
import { evaluateDangerousHostBypass } from "./sandbox/network-guard.js";
import { executeTool, resolveExecutableCommand } from "./tool-executor.js";

function createConfig(): ToolPolicyConfig {
  return {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", approvalMode: "bypass", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: ["."],
      readOnlyRoots: ["."],
      networkAllowlist: ["example.com", "sub.example.com", "127.0.0.1:3002"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function createStorage(): Storage {
  return {
    audit: {
      append: vi.fn(async () => undefined),
    },
    approvals: {
      create: vi.fn(),
    },
    approvalEvents: {
      append: vi.fn(),
    },
    pendingApprovalActions: {
      find: vi.fn(() => undefined),
      markResolved: vi.fn(),
      upsertPending: vi.fn(),
    },
    toolAccessDecisions: {
      countToolCallsInLastHourInScope: vi.fn(() => 0),
      countWritesInLastHourInScope: vi.fn(() => 0),
      record: vi.fn(),
    },
    toolGrants: {
      list: vi.fn(() => []),
      listActive: vi.fn(() => []),
    },
    knowledge: {
      listDocuments: vi.fn(() => []),
      listChunksByDocument: vi.fn(() => []),
      listChunksByNamespace: vi.fn(() => []),
      updateChunkEmbedding: vi.fn(),
    },
    db: {
      prepare: vi.fn(() => ({ run: vi.fn() })),
    },
  } as unknown as Storage;
}

function request(toolName: string, args: Record<string, unknown> = {}): ToolInvokeRequest {
  return {
    toolName,
    args,
    agentId: "agent-loop7",
    sessionId: "session-loop7",
  };
}

describe("policy-engine branch-tail coverage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("covers executable resolution and citation-building defaults", async () => {
    const direct = resolveExecutableCommand("node", ["--version"], "linux");
    expect(direct).toEqual({ file: "node", args: ["--version"] });

    const priorComSpec = process.env.ComSpec;
    const priorCOMSPEC = process.env.COMSPEC;
    delete process.env.ComSpec;
    delete process.env.COMSPEC;
    try {
      const wrapped = resolveExecutableCommand("pnpm", ["run", "test unit"], "win32");
      expect(wrapped.file).toBe("cmd.exe");
      expect(wrapped.args).toEqual(["/d", "/s", "/c", 'pnpm run "test unit"']);
    } finally {
      if (priorComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = priorComSpec;
      if (priorCOMSPEC === undefined) delete process.env.COMSPEC;
      else process.env.COMSPEC = priorCOMSPEC;
    }

    const citations = await executeTool(
      request("citations.build", {
        sources: [
          { title: "missing URL" },
          {
            url: "https://example.com/a",
            description: "fallback snippet",
          },
          {
            citationId: "cite-explicit",
            url: "https://example.com/b",
            title: "Explicit",
            snippet: "explicit snippet",
            sourceType: "repo",
          },
        ],
      }),
      createConfig(),
      createStorage(),
    );
    expect(citations).toMatchObject({
      count: 2,
      citations: [
        {
          citationId: "citation-2",
          url: "https://example.com/a",
          snippet: "fallback snippet",
          sourceType: "web",
        },
        {
          citationId: "cite-explicit",
          sourceType: "repo",
        },
      ],
    });
  });

  it("covers lightweight built-in executor defaults without mutating workspace state", async () => {
    const config = createConfig();
    const storage = createStorage();

    await expect(executeTool(request("session.status"), config, storage)).resolves.toMatchObject({
      status: "ok",
      sessionId: "session-loop7",
    });

    await expect(executeTool(request("fs.list"), config, storage)).resolves.toMatchObject({
      path: expect.any(String),
      items: expect.any(Array),
    });

    await expect(executeTool(request("git.diff", { staged: true }), config, storage)).resolves.toMatchObject({
      staged: true,
      truncated: expect.any(Boolean),
    });
  });

  it("covers browser cookie, storage, and context fallback matrices", async () => {
    const config = createConfig();
    const context = { sessionId: "browser-loop7" };

    await expect(executeBrowserTool("browser.cookies.get", {}, config)).rejects.toThrow(
      /requires active session context/,
    );
    await expect(executeBrowserTool("browser.cookies.set", { cookies: [] }, config, context)).rejects.toThrow(
      /requires a cookie object/,
    );

    const setCookies = await executeBrowserTool(
      "browser.cookies.set",
      {
        cookies: [
          { name: "sid", value: "1", domain: ".example.com", path: "/", httpOnly: true, sameSite: "Lax" },
          { name: "pref", value: "dark", url: "https://sub.example.com/app", secure: "true" },
        ],
      },
      config,
      context,
    );
    expect(setCookies).toMatchObject({ count: 2 });

    const filtered = await executeBrowserTool(
      "browser.cookies.get",
      { url: "https://sub.example.com/app", path: "/" },
      config,
      context,
    );
    expect(filtered.count).toBe(0);

    const domainFiltered = await executeBrowserTool(
      "browser.cookies.get",
      { domain: "example.com", name: "sid" },
      config,
      context,
    );
    expect(domainFiltered).toMatchObject({ count: 1 });

    const clearedOne = await executeBrowserTool("browser.cookies.clear", { name: "sid" }, config, context);
    expect(clearedOne).toMatchObject({ removed: 1, remaining: 1 });

    await executeBrowserTool(
      "browser.storage.set",
      {
        origin: "https://example.com",
        storage: "local",
        entries: { theme: "noir", count: 2, enabled: true },
      },
      config,
      context,
    );
    await executeBrowserTool(
      "browser.storage.set",
      { origin: "https://example.com", storage: "session", key: "token", value: "session-token" },
      config,
      context,
    );
    expect(
      await executeBrowserTool(
        "browser.storage.get",
        { origin: "https://example.com", storage: "both" },
        config,
        context,
      ),
    ).toMatchObject({
      localStorage: { theme: "noir", count: "2", enabled: "true" },
      sessionStorage: { token: "session-token" },
    });

    await expect(
      executeBrowserTool("browser.storage.clear", { storage: "local", key: "theme" }, config, context),
    ).rejects.toThrow(/requires origin/);
    expect(
      await executeBrowserTool(
        "browser.storage.clear",
        { origin: "https://example.com", storage: "both", key: "missing" },
        config,
        context,
      ),
    ).toMatchObject({ removed: 0 });
    expect(
      await executeBrowserTool(
        "browser.storage.clear",
        { origin: "https://example.com", storage: "both", key: "token" },
        config,
        context,
      ),
    ).toMatchObject({ removed: 1 });

    await expect(
      executeBrowserTool("browser.context.configure", { geolocation: { latitude: 99, longitude: 0 } }, config, context),
    ).rejects.toThrow(/latitude/);
    expect(
      await executeBrowserTool(
        "browser.context.configure",
        {
          reset: true,
          locale: "en-US",
          timezoneId: "America/Los_Angeles",
          geolocation: null,
          extraHTTPHeaders: {},
          httpCredentials: null,
        },
        config,
        context,
      ),
    ).toMatchObject({
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
      httpCredentialsConfigured: false,
    });
  });

  it("covers browser session-wide storage views and cookie filter defaults", async () => {
    const config = createConfig();
    const context = { sessionId: "browser-loop8" };

    await executeBrowserTool(
      "browser.cookies.set",
      {
        cookies: [
          { name: "wide", value: "1", domain: "example.com" },
          { name: "scoped", value: "2", url: "https://sub.example.com/path", path: "/path" },
        ],
      },
      config,
      context,
    );
    expect(await executeBrowserTool("browser.cookies.get", {}, config, context)).toMatchObject({ count: 2 });
    expect(await executeBrowserTool("browser.cookies.clear", {}, config, context)).toMatchObject({
      removed: 2,
      remaining: 0,
    });

    await executeBrowserTool(
      "browser.storage.set",
      { origin: "https://example.com", storage: "local", entries: { theme: "noir" } },
      config,
      context,
    );
    await executeBrowserTool(
      "browser.storage.set",
      { origin: "https://sub.example.com", storage: "session", key: "token", value: "abc" },
      config,
      context,
    );

    expect(await executeBrowserTool("browser.storage.get", { storage: "local" }, config, context)).toMatchObject({
      localStorage: { "https://example.com": { theme: "noir" } },
      sessionStorage: {},
    });
    expect(await executeBrowserTool("browser.storage.get", { storage: "session" }, config, context)).toMatchObject({
      localStorage: {},
      sessionStorage: { "https://sub.example.com": { token: "abc" } },
    });
    await expect(
      executeBrowserTool(
        "browser.storage.set",
        { origin: "https://example.com", storage: "both", key: "bad" },
        config,
        context,
      ),
    ).rejects.toThrow(/storage must be local or session/);
  });

  it("covers tool executor namespace, citation, and shell-risk approval tails", async () => {
    const storage = createStorage();
    storage.knowledge.listDocuments = vi.fn(() => [
      {
        docId: "doc-loop8",
        namespace: "team",
        sourceType: "note",
        sourceRef: "memory://loop8",
        title: "Loop 8 Tail",
        metadata: {},
      },
    ]) as never;
    storage.knowledge.listChunksByDocument = vi.fn(() => [
      {
        chunkId: "chunk-loop8",
        docId: "doc-loop8",
        seq: 0,
        content: "policy branch tail search text",
      },
    ]) as never;
    storage.knowledge.listChunksByNamespace = vi.fn(() => [
      {
        chunkId: "chunk-loop8",
        docId: "doc-loop8",
        seq: 0,
        content: "policy branch tail search text",
      },
    ]) as never;

    expect(
      await executeTool(request("memory.read", { namespace: "team", limit: 0 }), createConfig(), storage),
    ).toMatchObject({
      namespace: "team",
      items: [expect.objectContaining({ docId: "doc-loop8" })],
    });
    expect(
      await executeTool(
        request("memory.search", { namespace: "team", query: "branch", limit: 0 }),
        createConfig(),
        storage,
      ),
    ).toMatchObject({
      namespace: "team",
      items: [expect.objectContaining({ chunkId: "chunk-loop8" })],
    });
    expect(
      await executeTool(request("citations.build", { sources: "not-array" }), createConfig(), storage),
    ).toMatchObject({
      count: 0,
      citations: [],
    });

    const riskyEngine = new ToolPolicyEngine(
      {
        ...createConfig(),
        tools: { ...createConfig().tools, approvalMode: "bypass" },
        sandbox: {
          ...createConfig().sandbox,
          riskyShellPatterns: ["rm -rf"],
        },
      },
      storage,
    );
    const evaluation = riskyEngine.evaluateAccess({
      toolName: "shell.exec",
      args: { command: "rm -rf ./tmp" },
      agentId: "agent-loop8",
      sessionId: "session-loop8",
    });
    expect(evaluation.requiresApproval).toBe(true);
    expect(evaluation.reasonCodes).toContain("approval_bypass_mode");
  });

  it("keeps danger-profile network audit behavior separate from structural private-host blocks", async () => {
    const storage = createStorage();
    const config = {
      ...createConfig(),
      sandbox: {
        ...createConfig().sandbox,
        networkAllowlist: ["example.com", "127.0.0.1:3003"],
      },
    };
    const engine = new ToolPolicyEngine(config, storage);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })),
    );

    await engine.invoke({
      toolName: "http.get",
      args: { url: "https://example.com/status" },
      agentId: "agent-loop7",
      sessionId: "session-loop7",
    });
    expect(storage.audit.append).not.toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({ event: "approval_bypass_mode_network_target" }),
    );

    expect(
      evaluateDangerousHostBypass("https://unlisted.example.net/status", config.sandbox.networkAllowlist),
    ).toMatchObject({
      blocked: false,
      shouldAudit: true,
      hostname: "unlisted.example.net",
    });

    const privateFirecrawl = await engine.invoke({
      toolName: "docs.ingest",
      args: {
        sourceType: "url",
        source: "https://example.com/docs",
        backend: "firecrawl",
        firecrawlBaseUrl: "http://127.0.0.1:3003",
      },
      agentId: "agent-loop7",
      sessionId: "session-loop7",
    });
    expect(privateFirecrawl).toMatchObject({
      outcome: "blocked",
      audit: { errorKind: "policy_block" },
    });
    expect(storage.audit.append).toHaveBeenCalledWith(
      "policy_blocks",
      expect.objectContaining({
        details: expect.objectContaining({ reasonCodes: ["structural_safety_block"] }),
        reason: expect.stringContaining("Private, metadata, or reserved host is blocked"),
      }),
    );
    expect(storage.audit.append).not.toHaveBeenCalledWith(
      "tool_invocations",
      expect.objectContaining({ event: "approval_bypass_mode_network_target" }),
    );
  });
});
