import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionResponse,
  ChatExecutionPlanRecord,
  ChatToolRunRecord,
  ToolCatalogEntry,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { ChatAgentOrchestrator, type ChatAgentTurnInput } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator loop 28 coverage", () => {
  it("scores essential, suggested, project, memory, and access-filtered tools for code turns", async () => {
    const storage = createMockStorage() as OrchestratorStorageFixture;
    storage.chatSessionProjects.get = () => ({ sessionId: "sess-loop28-tools", projectId: "proj-loop28" });
    storage.chatExecutionPlans.listBySession = () => [
      {
        planId: "plan-loop28",
        sessionId: "sess-loop28-tools",
        turnId: "turn-loop28-tools",
        mode: "code",
        planningMode: "auto",
        status: "running",
        source: "planner",
        advisoryOnly: false,
        objective: "Inspect and validate the orchestrator.",
        summary: "Use focused tools.",
        steps: [
          {
            stepId: "step-complete",
            index: 0,
            objective: "Done",
            parallelizable: false,
            status: "completed",
            suggestedTools: ["browser.navigate"],
          },
          {
            stepId: "step-running",
            index: 1,
            objective: "Inspect source",
            parallelizable: false,
            status: "running",
            suggestedTools: ["file.find"],
          },
        ],
        createdAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:00.000Z",
      },
    ];
    storage.chatToolRuns.listBySession = () => [
      toolRun({
        toolName: "browser.search",
        status: "failed",
        error: "remote blocked",
      }),
      toolRun({
        toolName: "browser.search",
        status: "blocked",
        error: "web off",
      }),
      toolRun({
        toolName: "memory.search",
        status: "executed",
      }),
    ];
    const evaluateToolAccess = vi.fn((input: { toolName: string }) => {
      if (input.toolName === "http.get") {
        return { allowed: false, reason: "http disabled" };
      }
      if (input.toolName === "browser.navigate") {
        throw new Error("navigation grant unavailable");
      }
      return { allowed: true };
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: storage as never,
      listToolCatalog: () => [
        tool("time.now", { category: "research", preferredForIntents: ["session_status"] }),
        tool("memory.search", {
          category: "knowledge",
          preferredForIntents: ["memory_lookup", "project_context"],
          recommendedContexts: ["chat", "cowork", "code"],
        }),
        tool("memory.read", {
          category: "knowledge",
          preferredForIntents: ["memory_lookup"],
          recommendedContexts: ["chat", "cowork", "code"],
        }),
        tool("memory.write", {
          category: "knowledge",
          preferredForIntents: ["memory_persist"],
          recommendedContexts: ["chat", "cowork", "code"],
        }),
        tool("memory.upsert", {
          category: "knowledge",
          preferredForIntents: ["memory_persist"],
          recommendedContexts: ["chat", "cowork", "code"],
        }),
        tool("browser.search", {
          category: "research",
          preferredForIntents: ["web_lookup", "research"],
          recommendedContexts: ["chat", "cowork"],
        }),
        tool("browser.navigate", {
          category: "research",
          preferredForIntents: ["fetch_url"],
          recommendedContexts: ["chat", "cowork"],
        }),
        tool("http.get", {
          category: "http",
          preferredForIntents: ["api_lookup", "fetch_url"],
          recommendedContexts: ["chat", "cowork", "code"],
        }),
        tool("fs.list", {
          category: "fs",
          preferredForIntents: ["local_file", "project_context"],
          recommendedContexts: ["project_bound", "code"],
        }),
        tool("file.read_range", {
          category: "fs",
          preferredForIntents: ["read_file", "targeted_read", "inspect_code"],
          recommendedContexts: ["project_bound", "code"],
        }),
        tool("file.find", {
          category: "fs",
          preferredForIntents: ["search_text", "inspect_code"],
          recommendedContexts: ["project_bound", "code"],
        }),
        tool("code.search", {
          category: "fs",
          preferredForIntents: ["search_code", "inspect_code"],
          recommendedContexts: ["project_bound", "code"],
        }),
        tool("shell.exec", {
          category: "shell",
          requiresApproval: true,
          preferredForIntents: ["run_command"],
          recommendedContexts: ["code"],
        }),
        tool("tests.run", {
          category: "ops",
          preferredForIntents: ["run_command"],
          recommendedContexts: ["code"],
        }),
      ],
      evaluateToolAccess,
      createChatCompletion: vi.fn<() => Promise<ChatCompletionResponse>>(),
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>(),
    });

    const schema = await buildToolSchema(orchestrator, {
      sessionId: "sess-loop28-tools",
      mode: "code",
      webMode: "auto",
      content:
        "Use shell.exec, remember with consent that I prefer concise QA updates, inspect `apps/gateway/src/services/chat-agent-orchestrator.ts`, and search the web for the release note URL.",
      historyMessages: [],
    });

    const names = toolNames(schema);
    expect(names).toEqual(
      expect.arrayContaining([
        "time_now",
        "memory_search",
        "memory_write",
        "memory_upsert",
        "browser_search",
        "fs_list",
        "file_read_range",
        "file_find",
        "code_search",
        "shell_exec",
        "tests_run",
      ]),
    );
    expect(names).not.toContain("http_get");
    expect(names).not.toContain("browser_navigate");
    expect(schema.canonicalToModel.get("shell.exec")).toBe("shell_exec");
    expect(schema.modelToCanonical.get("tests_run")).toBe("tests.run");
    expect(evaluateToolAccess).toHaveBeenCalledWith(expect.objectContaining({ toolName: "http.get" }));
    expect(evaluateToolAccess).toHaveBeenCalledWith(expect.objectContaining({ toolName: "browser.navigate" }));
  });

  it("suppresses local and web tools for non-code Prompt Lab memory-only explicit-tool turns", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => [
        tool("time.now"),
        tool("memory.search", { category: "knowledge", preferredForIntents: ["memory_lookup"] }),
        tool("memory.read", { category: "knowledge", preferredForIntents: ["memory_lookup"] }),
        tool("browser.search", { category: "research", preferredForIntents: ["web_lookup"] }),
        tool("file.read_range", { category: "fs", preferredForIntents: ["read_file"] }),
        tool("code.search", { category: "fs", preferredForIntents: ["search_code"] }),
      ],
      createChatCompletion: vi.fn<() => Promise<ChatCompletionResponse>>(),
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>(),
    });

    const schema = await buildToolSchema(orchestrator, {
      sessionId: "sess-loop28-memory-tools",
      mode: "cowork",
      webMode: "auto",
      normalizationProfile: "prompt_pack_harness",
      content: [
        "## Prompt Lab Run Contract",
        "- Mode: cowork",
        "- Tool tier: explicit-tools",
        "- Required tool families: memory tools",
        "- Suggested tools: file.read_range",
        "",
        "## User Task",
        "Use memory tools only to recall my onboarding preference. Do not inspect repository files.",
      ].join("\n"),
      historyMessages: [],
    });

    const names = toolNames(schema);
    expect(names).toEqual(expect.arrayContaining(["time_now", "memory_search", "memory_read"]));
    expect(names).not.toContain("browser_search");
    expect(names).not.toContain("file_read_range");
    expect(names).not.toContain("code_search");
    expect(schema.canonicalToModel.has("browser.search")).toBe(false);
  });

  it("persists no-result browser search fallback chains after alternate engines fail", async () => {
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-primary-empty",
        result: { query: "GoatCitadel release blockers", results: [] },
      })
      .mockResolvedValueOnce({
        outcome: "blocked",
        policyReason: "bing blocked",
        auditEventId: "audit-bing-blocked",
      })
      .mockRejectedValueOnce(new Error("duckduckgo timeout"))
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "google approval required",
        auditEventId: "audit-google-approval",
        approvalId: "approval-google-search",
      });
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        content: "Search the web for GoatCitadel release blockers.",
        webMode: "auto",
      }),
      turnId: "turn-loop28-no-results",
      toolName: "browser.search",
      rawArgs: { query: "GoatCitadel release blockers" },
    });

    expect(invokeTool).toHaveBeenCalledTimes(4);
    expect(invokeTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({ engine: "bing" }),
      }),
    );
    expect(invokeTool).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({ engine: "duckduckgo" }),
      }),
    );
    expect(invokeTool).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({ engine: "google" }),
      }),
    );
    expect(result.record).toMatchObject({
      toolName: "browser.search",
      status: "executed",
      result: expect.objectContaining({
        browserFailureClass: "no_results",
      }),
    });
    expect(result.record.failureGuidance).toContain("Broaden the query");
    expect(result.record.result?.fallbackChain).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ engineLabel: "Built-in browser", browserFailureClass: "no_results" }),
        expect.objectContaining({ engineLabel: "Built-in browser (bing)", status: "failed" }),
        expect.objectContaining({ engineLabel: "Built-in browser (duckduckgo)", error: "duckduckgo timeout" }),
        expect.objectContaining({ engineLabel: "Built-in browser (google)", status: "failed" }),
      ]),
    );
  });

  it("blocks delegated non-code Prompt Lab local file calls before runtime invocation", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        mode: "cowork",
        content: [
          "Delegated role: Planner",
          "Parent objective: Plan a neighborhood meetup.",
          "Current step objective: Draft phases and approval checkpoints.",
          "Suggested tools: file.read_range",
        ].join("\n"),
      }),
      turnId: "turn-loop28-delegated-non-code",
      toolName: "file.read_range",
      rawArgs: { path: "apps/gateway/src/services/chat-agent-orchestrator.ts", startLine: 1, endLine: 5 },
      localFileIntent: false,
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.record).toMatchObject({
      toolName: "file.read_range",
      status: "blocked",
      error:
        "execution skipped: local file/code tools were suppressed because this non-code Prompt Lab step does not ask for repository inspection",
    });
  });
});

function createExecuteToolCall(input: { invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult> }) {
  const orchestrator = new ChatAgentOrchestrator({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(["browser.search", "file.read_range", "time.now"]),
    createChatCompletion: vi.fn<() => Promise<ChatCompletionResponse>>(),
    invokeTool: input.invokeTool,
  });
  return (
    orchestrator as unknown as {
      executeToolCall(input: {
        input: ChatAgentTurnInput;
        turnId: string;
        toolName: string;
        rawArgs: Record<string, unknown>;
        localFileIntent?: boolean;
      }): Promise<{
        record: ChatToolRunRecord & {
          result?: Record<string, unknown>;
          failureGuidance?: string;
        };
      }>;
    }
  ).executeToolCall.bind(orchestrator);
}

async function buildToolSchema(
  orchestrator: ChatAgentOrchestrator,
  input: {
    sessionId: string;
    mode: ChatAgentTurnInput["mode"];
    webMode: ChatAgentTurnInput["webMode"];
    content: string;
    historyMessages: ChatAgentTurnInput["historyMessages"];
    normalizationProfile?: ChatAgentTurnInput["normalizationProfile"];
  },
) {
  return (
    orchestrator as unknown as {
      buildToolSchema(
        input: typeof input,
        intents: { liveData: boolean; webLookup: boolean; localFile: boolean },
      ): Promise<{
        tools: Array<{ function?: { name?: string } }>;
        modelToCanonical: Map<string, string>;
        canonicalToModel: Map<string, string>;
      }>;
    }
  ).buildToolSchema(input, {
    liveData: false,
    webLookup: /\bweb\b|\bsearch\b|https?:\/\//i.test(input.content),
    localFile: /`[^`]*\/[^`]*`|\brepository\b|\brepo\b|\bfile\b/i.test(input.content),
  });
}

function toolNames(schema: { tools: Array<{ function?: { name?: string } }> }): string[] {
  return schema.tools.map((item) => item.function?.name).filter((value): value is string => Boolean(value));
}

type ToolCategory = ToolCatalogEntry["category"];

function tool(
  toolName: string,
  overrides: Partial<ToolCatalogEntry> & { category?: ToolCategory } = {},
): ToolCatalogEntry {
  return {
    toolName,
    category: overrides.category ?? "research",
    riskLevel: overrides.riskLevel ?? "safe",
    requiresApproval: overrides.requiresApproval ?? false,
    description: overrides.description ?? `${toolName} test tool`,
    argSchema: overrides.argSchema ?? { type: "object", properties: {}, required: [] },
    examples: overrides.examples ?? [{ title: `${toolName} example` }],
    pack: overrides.pack ?? "loop28",
    recommendedContexts: overrides.recommendedContexts,
    preferredForIntents: overrides.preferredForIntents,
    usageHints: overrides.usageHints,
  };
}

function toolRun(overrides: Partial<ChatToolRunRecord>): ChatToolRunRecord {
  return {
    toolRunId: `tool-${overrides.toolName ?? "unknown"}-${overrides.status ?? "started"}`,
    turnId: "turn-loop28-tools",
    sessionId: "sess-loop28-tools",
    toolName: "browser.search",
    status: "started",
    args: {},
    startedAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function turnInput(overrides: Partial<ChatAgentTurnInput> = {}): ChatAgentTurnInput {
  const content = overrides.content ?? "Use the available tool.";
  return {
    sessionId: "sess-loop28",
    turnId: "turn-loop28",
    userMessageId: "msg-loop28",
    content,
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
    ...overrides,
  };
}

type OrchestratorStorageFixture = ReturnType<typeof createMockStorage> & {
  chatSessionProjects: {
    get: (sessionId: string) => { sessionId: string; projectId: string } | undefined;
  };
  chatExecutionPlans: {
    listBySession: (sessionId: string, limit?: number) => ChatExecutionPlanRecord[];
  };
  chatToolRuns: {
    listBySession: (sessionId: string, limit?: number) => ChatToolRunRecord[];
  };
};
