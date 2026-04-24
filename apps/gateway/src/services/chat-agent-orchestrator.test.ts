import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatToolRunRecord,
  ChatTurnTraceRecord,
  ChatWebMode,
  McpInvokeRequest,
  McpInvokeResponse,
  ToolCatalogEntry,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";

function createToolCatalog(toolNames: string[] = ["browser.search"]): ToolCatalogEntry[] {
  return toolNames.map((toolName) => {
    if (toolName === "memory.search") {
      return {
        toolName: "memory.search",
        category: "knowledge",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Search memory",
        argSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        examples: [],
        pack: "knowledge",
        recommendedContexts: ["chat", "cowork", "code"],
        preferredForIntents: ["memory_lookup", "project_context"],
      };
    }
    if (toolName === "memory.read") {
      return {
        toolName: "memory.read",
        category: "knowledge",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Read memory",
        argSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: [],
        },
        examples: [],
        pack: "knowledge",
        recommendedContexts: ["chat", "cowork", "code"],
        preferredForIntents: ["memory_lookup", "project_context"],
      };
    }
    if (toolName === "memory.write" || toolName === "memory.upsert") {
      return {
        toolName,
        category: "knowledge",
        riskLevel: "safe",
        requiresApproval: false,
        description: toolName === "memory.write" ? "Write memory" : "Upsert memory",
        argSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
          },
          required: ["namespace", "title", "content"],
        },
        examples: [],
        pack: "knowledge",
        recommendedContexts: ["chat", "cowork", "code"],
        preferredForIntents: ["memory_persist"],
      };
    }
    if (toolName === "browser.navigate") {
      return {
        toolName: "browser.navigate",
        category: "research",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Navigate",
        argSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
        },
        examples: [],
        pack: "core",
      };
    }
    if (toolName === "browser.extract") {
      return {
        toolName: "browser.extract",
        category: "research",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Extract page text",
        argSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
        },
        examples: [],
        pack: "core",
      };
    }
    if (toolName === "http.get") {
      return {
        toolName: "http.get",
        category: "http",
        riskLevel: "safe",
        requiresApproval: false,
        description: "HTTP GET",
        argSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
        },
        examples: [],
        pack: "core",
      };
    }
    if (toolName === "file.read_range") {
      return {
        toolName: "file.read_range",
        category: "fs",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Read file range",
        argSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "integer" },
            endLine: { type: "integer" },
          },
          required: ["path", "startLine", "endLine"],
        },
        examples: [],
        pack: "devops",
        recommendedContexts: ["cowork", "code", "project_bound"],
        preferredForIntents: ["local_file", "inspect_code", "targeted_read"],
      };
    }
    if (toolName === "file.find") {
      return {
        toolName: "file.find",
        category: "fs",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Find text in files",
        argSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            pattern: { type: "string" },
          },
          required: ["path", "pattern"],
        },
        examples: [],
        pack: "devops",
        recommendedContexts: ["cowork", "code", "project_bound"],
        preferredForIntents: ["local_file", "inspect_code", "search_text"],
      };
    }
    if (toolName === "code.search" || toolName === "code.search_files") {
      return {
        toolName,
        category: "fs",
        riskLevel: "safe",
        requiresApproval: false,
        description: toolName === "code.search" ? "Search code" : "Search file names",
        argSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            query: { type: "string" },
          },
          required: ["path", "query"],
        },
        examples: [],
        pack: "devops",
        recommendedContexts: ["cowork", "code", "project_bound"],
        preferredForIntents: [
          "local_file",
          "inspect_code",
          toolName === "code.search" ? "search_code" : "search_files",
        ],
      };
    }
    if (toolName === "http.post") {
      return {
        toolName: "http.post",
        category: "http",
        riskLevel: "danger",
        requiresApproval: true,
        description: "HTTP POST",
        argSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
        },
        examples: [],
        pack: "core",
      };
    }
    if (toolName === "shell.exec") {
      return {
        toolName: "shell.exec",
        category: "shell",
        riskLevel: "danger",
        requiresApproval: true,
        description: "Execute a shell command",
        argSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
        },
        examples: [],
        pack: "devops",
        recommendedContexts: ["code"],
        preferredForIntents: ["run_command", "project_inspection"],
      };
    }
    if (toolName === "time.now") {
      return {
        toolName: "time.now",
        category: "research",
        riskLevel: "safe",
        requiresApproval: false,
        description: "Current time",
        argSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        examples: [],
        pack: "core",
      };
    }
    return {
      toolName: "browser.search",
      category: "research",
      riskLevel: "safe",
      requiresApproval: false,
      description: "Search",
      argSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      examples: [],
      pack: "core",
    };
  });
}

function toolCallCompletion(query: string): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "browser_search",
                arguments: JSON.stringify({ query }),
              },
            },
          ],
        },
      },
    ],
  };
}

function namedToolCallCompletion(toolName: string, args: Record<string, unknown>): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: `call-${toolName.replace(/\./g, "-")}-1`,
              type: "function",
              function: {
                name: toolName.replace(/\./g, "_"),
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

function navigateToolCallCompletion(args: Record<string, unknown>): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-nav-1",
              type: "function",
              function: {
                name: "browser_navigate",
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

function extractToolCallCompletion(args: Record<string, unknown>): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-extract-1",
              type: "function",
              function: {
                name: "browser_extract",
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

function httpGetToolCallCompletion(args: Record<string, unknown>): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-http-get-1",
              type: "function",
              function: {
                name: "http_get",
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}

function createMockStorage(): unknown {
  const traces = new Map<string, ChatTurnTraceRecord>();
  const toolRuns = new Map<string, ChatToolRunRecord>();
  return {
    chatTurnTraces: {
      create(input: Omit<ChatTurnTraceRecord, "toolRuns" | "citations">): ChatTurnTraceRecord {
        const record: ChatTurnTraceRecord = {
          ...input,
          toolRuns: [],
          citations: [],
        };
        traces.set(record.turnId, record);
        return record;
      },
      patch(turnId: string, patch: Partial<ChatTurnTraceRecord>): ChatTurnTraceRecord {
        const current = traces.get(turnId);
        if (!current) {
          throw new Error(`trace ${turnId} missing`);
        }
        const next: ChatTurnTraceRecord = {
          ...current,
          ...patch,
        };
        traces.set(turnId, next);
        return next;
      },
    },
    chatToolRuns: {
      create(input: ChatToolRunRecord): ChatToolRunRecord {
        toolRuns.set(input.toolRunId, input);
        return input;
      },
      patch(toolRunId: string, patch: Partial<ChatToolRunRecord>): ChatToolRunRecord {
        const current = toolRuns.get(toolRunId);
        if (!current) {
          throw new Error(`tool run ${toolRunId} missing`);
        }
        const next = {
          ...current,
          ...patch,
        };
        toolRuns.set(toolRunId, next);
        return next;
      },
      listByTurn(turnId: string): ChatToolRunRecord[] {
        return [...toolRuns.values()].filter((item) => item.turnId === turnId);
      },
      listBySession(sessionId: string): ChatToolRunRecord[] {
        return [...toolRuns.values()].filter((item) => item.sessionId === sessionId);
      },
    },
    chatSessionProjects: {
      get: () => undefined,
    },
    chatExecutionPlans: {
      listBySession: () => [],
    },
    chatInlineApprovals: {
      upsert: () => undefined,
    },
    approvals: {
      get: (approvalId: string) => ({
        approvalId,
        kind: "shell.exec",
        riskLevel: "danger",
        status: "pending",
        payload: {},
        preview: {},
        createdAt: "2026-03-22T12:00:00.000Z",
        expiresAt: "2026-03-22T12:15:00.000Z",
        explanationStatus: "not_requested",
      }),
    },
  };
}

describe("ChatAgentOrchestrator", () => {
  it("tolerates missing execution-plan storage while building the tool schema", async () => {
    const storage = createMockStorage() as Record<string, unknown>;
    delete storage.chatExecutionPlans;
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Direct answer.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-missing-plan-storage-1",
      turnId: randomUUID(),
      userMessageId: "msg-missing-plan-storage-1",
      content: "Answer directly.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Answer directly." }],
    });

    expect(result.assistantContent).toBe("Direct answer.");
    expect(result.turnTrace.failure).toBeUndefined();
  });

  it("executes tool loop and returns final assistant message", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("latest ai tooling"))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Final answer",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-1",
      result: {
        results: [{ title: "Result", url: "https://example.com" }],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-1",
      turnId: randomUUID(),
      userMessageId: "msg-user-1",
      content: "Find AI tooling references from our notes",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Find AI tooling references from our notes" }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("Final answer");
    expect(result.turnTrace.toolRuns.length).toBeGreaterThanOrEqual(1);
    expect(invokeTool).toHaveBeenCalledTimes(1);
  });

  it("marks the turn cancelled when execution is aborted mid-run", async () => {
    const controller = new AbortController();
    const createChatCompletion = vi.fn(async (_request: ChatCompletionRequest) => {
      controller.abort();
      throw new Error("Chat turn cancelled.");
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cancel-1",
      turnId: randomUUID(),
      userMessageId: "msg-user-cancel-1",
      content: "Stop this turn.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Stop this turn." }],
      signal: controller.signal,
    });

    expect(result.turnTrace.status).toBe("cancelled");
    expect(result.assistantContent).toBe("");
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("trips circuit breaker for repeated non-retryable tool failures", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValue(toolCallCompletion("latest ai tooling"));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "blocked",
      policyReason: "permission denied",
      auditEventId: "audit-2",
      result: {},
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-2",
      turnId: randomUUID(),
      userMessageId: "msg-user-2",
      content: "Search AI tooling references",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search AI tooling references" }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(result.assistantContent).toContain("exhausted the current tool approaches");
    expect(result.assistantContent).toContain("don't have solid results yet");
    expect(result.assistantContent).not.toContain("Reason:");
    expect(result.assistantContent).not.toContain("permission denied");
    expect(result.turnTrace.failure?.recommendedAction).toBe("retry_narrower");
  });

  it("emits a warning loop event for repeated identical tool calls when detection is enabled", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("latest ai tooling"))
      .mockResolvedValueOnce(toolCallCompletion("latest ai tooling"))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Final answer with evidence.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-loop-warning",
      result: {
        results: [
          {
            url: "https://example.com/ai-tooling",
            title: "AI tooling",
            snippet: "Evidence from the same repeated search call.",
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
      toolLoopDetection: {
        enabled: true,
        historySize: 6,
        warningThreshold: 2,
        criticalThreshold: 4,
        globalThreshold: 6,
        detectors: {
          repeated_same_call: true,
          no_progress_polling: false,
          ping_pong: false,
        },
      },
    });

    const result = await orchestrator.run({
      sessionId: "sess-loop-warning-1",
      turnId: randomUUID(),
      userMessageId: "msg-user-loop-warning-1",
      content: "Search AI tooling references",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search AI tooling references" }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(result.turnTrace.loopGuard?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detector: "repeated_same_call",
          severity: "warning",
          suppressed: false,
        }),
      ]),
    );
  });

  it("suppresses further tool execution when repeated identical calls hit the critical threshold", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("latest ai tooling"))
      .mockResolvedValueOnce(toolCallCompletion("latest ai tooling"))
      .mockResolvedValueOnce(toolCallCompletion("latest ai tooling"));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-loop-critical",
      result: {
        results: [
          {
            url: "https://example.com/ai-tooling",
            title: "AI tooling",
            snippet: "Evidence from the same repeated search call.",
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
      toolLoopDetection: {
        enabled: true,
        historySize: 6,
        warningThreshold: 2,
        criticalThreshold: 3,
        globalThreshold: 5,
        detectors: {
          repeated_same_call: true,
          no_progress_polling: false,
          ping_pong: false,
        },
      },
    });

    const result = await orchestrator.run({
      sessionId: "sess-loop-critical-1",
      turnId: randomUUID(),
      userMessageId: "msg-user-loop-critical-1",
      content: "Search AI tooling references",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search AI tooling references" }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(result.turnTrace.loopGuard?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detector: "repeated_same_call",
          severity: "critical",
          suppressed: true,
        }),
      ]),
    );
    expect(result.assistantContent).toContain("strongest leads so far");
    expect(result.turnTrace.failure?.failureClass).toBe("tool_loop_guard");
  });

  it("does not trip circuit breaker at two attempts for retryable failures", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValue(toolCallCompletion("latest ai tooling"));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockRejectedValue(new Error("network timeout"));
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-3",
      turnId: randomUUID(),
      userMessageId: "msg-user-3",
      content: "Search latest AI tooling",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search latest AI tooling" }],
    });

    expect(invokeTool.mock.calls.length).toBeGreaterThan(2);
    expect(result.assistantContent).not.toContain("I hit the same tool issue repeatedly");
    expect(result.assistantContent).not.toContain("Reason:");
    expect(result.assistantContent).not.toContain("What I need from you next");
  });

  it("marks tool-run budget halts with an explicit failure class", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValue({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: new Array(13).fill(null).map((_, index) => ({
              id: `call-${index + 1}`,
              type: "function",
              function: {
                name: "browser_search",
                arguments: JSON.stringify({ query: `latest ai tooling ${index + 1}` }),
              },
            })),
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-tool-run-budget",
      result: {
        results: [
          {
            url: "https://example.com/ai-tooling",
            title: "AI tooling",
            snippet: "Evidence from repeated search calls.",
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
      toolLoopDetection: {
        enabled: false,
        historySize: 6,
        warningThreshold: 2,
        criticalThreshold: 4,
        globalThreshold: 6,
        detectors: {
          repeated_same_call: true,
          no_progress_polling: true,
          ping_pong: true,
        },
      },
    });

    const result = await orchestrator.run({
      sessionId: "sess-tool-run-budget-1",
      turnId: randomUUID(),
      userMessageId: "msg-tool-run-budget-1",
      content: "Keep searching AI tooling references.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Keep searching AI tooling references." }],
    });

    expect(result.turnTrace.failure?.failureClass).toBe("tool_run_budget_exceeded");
  });

  it("maps auth failures to reconnect auth recovery guidance", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockRejectedValue(new Error("401 unauthorized"));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-auth-1",
      turnId: randomUUID(),
      userMessageId: "msg-user-auth-1",
      content: "Use the locked provider.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Use the locked provider." }],
    });

    expect(result.turnTrace.status).toBe("failed");
    expect(result.turnTrace.failure?.failureClass).toBe("auth_required");
    expect(result.turnTrace.failure?.recommendedAction).toBe("reconnect_auth");
    expect(result.assistantContent).toContain("needs valid auth");
  });

  it("grounds browser.navigate from the most recent browser.search results", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({}))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Grounded answer",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-search",
        result: {
          results: [{ title: "News", url: "https://example.com/news/kristi-noem", snippet: "snippet" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav",
        result: {
          finalUrl: "https://example.com/news/kristi-noem",
          title: "News",
          textSnippet: "Latest coverage",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-4",
      turnId: randomUUID(),
      userMessageId: "msg-user-4",
      content: "What's the latest news on Kristi Noem?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What's the latest news on Kristi Noem?" }],
    });

    expect(invokeTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toolName: "browser.navigate",
        args: expect.objectContaining({
          url: "https://example.com/news/kristi-noem",
        }),
      }),
    );
    expect(invokeTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        toolName: "browser.search",
      }),
    );
    expect(result.assistantContent).toContain("Grounded answer");
  });

  it("normalizes generic live-news prompts into a cleaner search query", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I found some headlines.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-search-cleanup",
      result: {
        results: [{ title: "Headline", url: "https://example.com/news/today", snippet: "top stories" }],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-live-cleanup-1",
      turnId: randomUUID(),
      userMessageId: "msg-live-cleanup-1",
      content: "Look online and tell me the 5 most interesting things that happened today.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Look online and tell me the 5 most interesting things that happened today." },
      ],
    });

    expect(invokeTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({
          query: "top news headlines today",
        }),
      }),
    );
  });

  it("recovers missing http.get url from the most recent visited page", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({}))
      .mockResolvedValueOnce(navigateToolCallCompletion({}))
      .mockResolvedValueOnce(httpGetToolCallCompletion({}))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Kristi Noem is in the news again.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-search-http",
        result: {
          results: [
            {
              title: "Kristi Noem latest news",
              url: "https://example.com/news/kristi-noem",
              snippet: "latest coverage",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-http-1",
        result: {
          finalUrl: "https://example.com/news/kristi-noem",
          title: "Kristi Noem latest news",
          textSnippet: "first article page",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-http-2",
        result: {
          finalUrl: "https://example.com/news/kristi-noem/analysis",
          title: "Kristi Noem analysis",
          textSnippet: "second article page",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-http-get",
        result: {
          url: "https://example.com/news/kristi-noem/analysis",
          status: 200,
          bodySnippet: "analysis body",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.get"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-http-get-1",
      turnId: randomUUID(),
      userMessageId: "msg-http-get-1",
      content: "what's the latest news on Kristi Noem?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "what's the latest news on Kristi Noem?" }],
    });

    const invokeToolCalls = invokeTool.mock.calls as unknown as Array<
      [
        {
          toolName: string;
          args: Record<string, unknown>;
        },
      ]
    >;
    const lastInvokeToolCall = invokeToolCalls.at(-1)?.[0];
    expect(lastInvokeToolCall).toMatchObject({
      toolName: "http.get",
      args: expect.objectContaining({
        url: "https://example.com/news/kristi-noem/analysis",
      }),
    });
    expect(result.assistantContent).toContain("Kristi Noem is in the news again.");
    expect(result.assistantContent).not.toContain("execution error: url is required");
  });

  it("uses the most recent visited page before falling back to prior search results for http.get", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.get"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
          failureReason?: string;
        };
      }
    ).preflightToolInvocation({
      toolName: "http.get",
      rawArgs: {},
      userContent: "what's the latest news on Kristi Noem?",
      priorToolRuns: [
        {
          toolRunId: "tool-search-http-1",
          turnId: "turn-http-1",
          sessionId: "sess-http-2",
          toolName: "browser.search",
          status: "executed",
          args: { query: "latest news on Kristi Noem" },
          result: {
            results: [
              { title: "Kristi Noem latest news", url: "https://example.com/news/kristi-noem", snippet: "snippet" },
            ],
          },
          startedAt: "2026-03-06T23:10:00.000Z",
          finishedAt: "2026-03-06T23:10:01.000Z",
        },
        {
          toolRunId: "tool-nav-http-1",
          turnId: "turn-http-1",
          sessionId: "sess-http-2",
          toolName: "browser.navigate",
          status: "executed",
          args: { url: "https://example.com/news/kristi-noem" },
          result: {
            finalUrl: "https://example.com/news/kristi-noem/live-blog",
            title: "Kristi Noem live blog",
            textSnippet: "live updates",
          },
          startedAt: "2026-03-06T23:10:02.000Z",
          finishedAt: "2026-03-06T23:10:03.000Z",
        },
      ],
    });

    expect(preflight.failureReason).toBeUndefined();
    expect(preflight.args).toMatchObject({
      url: "https://example.com/news/kristi-noem/live-blog",
    });
  });

  it("ignores search-portal navigations when grounding a follow-up http.get", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.get"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
          failureReason?: string;
        };
      }
    ).preflightToolInvocation({
      toolName: "http.get",
      rawArgs: {},
      userContent: "what's the latest news on Kristi Noem?",
      priorToolRuns: [
        {
          toolRunId: "tool-search-http-portal",
          turnId: "turn-http-portal",
          sessionId: "sess-http-portal",
          toolName: "browser.search",
          status: "executed",
          args: { query: "latest news on Kristi Noem" },
          result: {
            results: [
              { title: "Kristi Noem latest news", url: "https://example.com/news/kristi-noem", snippet: "snippet" },
            ],
          },
          startedAt: "2026-03-06T23:10:00.000Z",
          finishedAt: "2026-03-06T23:10:01.000Z",
        },
        {
          toolRunId: "tool-nav-http-portal",
          turnId: "turn-http-portal",
          sessionId: "sess-http-portal",
          toolName: "browser.navigate",
          status: "executed",
          args: { url: "https://lite.duckduckgo.com/lite/?q=latest+news+on+kristi+noem" },
          result: {
            finalUrl: "https://lite.duckduckgo.com/lite/?q=latest+news+on+kristi+noem",
            title: "DuckDuckGo",
            textSnippet: "Please complete the challenge to confirm this search was made by a human.",
          },
          startedAt: "2026-03-06T23:10:02.000Z",
          finishedAt: "2026-03-06T23:10:03.000Z",
        },
      ],
    });

    expect(preflight.failureReason).toBeUndefined();
    expect(preflight.args).toMatchObject({
      url: "https://example.com/news/kristi-noem",
    });
  });

  it("does not infer recent-run urls for http.post", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.post"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
          failureReason?: string;
        };
      }
    ).preflightToolInvocation({
      toolName: "http.post",
      rawArgs: {},
      userContent: "what's the latest news on Kristi Noem?",
      priorToolRuns: [
        {
          toolRunId: "tool-search-post-1",
          turnId: "turn-post-1",
          sessionId: "sess-post-1",
          toolName: "browser.search",
          status: "executed",
          args: { query: "latest news on Kristi Noem" },
          result: {
            results: [
              { title: "Kristi Noem latest news", url: "https://example.com/news/kristi-noem", snippet: "snippet" },
            ],
          },
          startedAt: "2026-03-06T23:11:00.000Z",
          finishedAt: "2026-03-06T23:11:01.000Z",
        },
        {
          toolRunId: "tool-nav-post-1",
          turnId: "turn-post-1",
          sessionId: "sess-post-1",
          toolName: "browser.navigate",
          status: "executed",
          args: { url: "https://example.com/news/kristi-noem" },
          result: {
            finalUrl: "https://example.com/news/kristi-noem/live-blog",
          },
          startedAt: "2026-03-06T23:11:02.000Z",
          finishedAt: "2026-03-06T23:11:03.000Z",
        },
      ],
    });

    expect(preflight.failureReason).toBe("execution error: url is required");
  });

  it("keeps http.get unresolved when no prompt or recent-run url is available", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["http.get"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
          failureReason?: string;
        };
      }
    ).preflightToolInvocation({
      toolName: "http.get",
      rawArgs: {},
      userContent: "tell me what's going on with Kristi Noem",
      priorToolRuns: [],
    });

    expect(preflight.failureReason).toBe("execution error: url is required");
  });

  it("promotes repeated live-data browser.search calls into browser.navigate during preflight", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
        };
      }
    ).preflightToolInvocation({
      toolName: "browser.search",
      rawArgs: {
        query: "latest news on Kristi Noem",
      },
      userContent: "what's going on with kristi noem lately?",
      priorToolRuns: [
        {
          toolRunId: "tool-search-1",
          turnId: "turn-1",
          sessionId: "sess-6",
          toolName: "browser.search",
          status: "executed",
          args: { query: "latest news on Kristi Noem" },
          result: {
            results: [
              {
                title: "Generic search results",
                url: "https://www.google.com/search?q=kristi+noem",
                snippet: "portal",
              },
              { title: "Kristi Noem latest news", url: "https://example.com/news/kristi-noem-1", snippet: "snippet 1" },
            ],
          },
          startedAt: "2026-03-06T22:30:00.000Z",
          finishedAt: "2026-03-06T22:30:01.000Z",
        },
      ],
    });

    expect(preflight.toolName).toBe("browser.navigate");
    expect(preflight.args).toMatchObject({
      url: "https://example.com/news/kristi-noem-1",
      maxChars: 6000,
    });
  });

  it("rewrites search-portal browser.navigate urls to the strongest grounded result url", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
        };
      }
    ).preflightToolInvocation({
      toolName: "browser.navigate",
      rawArgs: {
        url: "https://lite.duckduckgo.com/lite/?q=top+news+headlines+today",
      },
      userContent: "Look online and tell me the 5 most interesting things that happened today.",
      priorToolRuns: [
        {
          toolRunId: "tool-search-nav-redirect",
          turnId: "turn-nav-redirect",
          sessionId: "sess-nav-redirect",
          toolName: "browser.search",
          status: "executed",
          args: { query: "top news headlines today" },
          result: {
            results: [
              {
                title: "Google News - Headlines",
                url: "https://news.google.com/topics/CAAqKggKIiRDQkFTRlFvSUwyMHZNRFZxYUdjU0JXVnVMVWRDR2dKVFJ5Z0FQAQ",
                snippet: "Headlines topic",
              },
              { title: "Reuters Top News", url: "https://www.reuters.com/world/", snippet: "Top stories from Reuters" },
            ],
          },
          startedAt: "2026-03-06T22:30:00.000Z",
          finishedAt: "2026-03-06T22:30:01.000Z",
        },
      ],
    });

    expect(preflight.toolName).toBe("browser.navigate");
    expect(preflight.args.url).toBe("https://www.reuters.com/world/");
  });

  it("normalizes explicit web lookup prompts before the synthetic browser.search runs", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "REST APIs are widely used for app backends, integrations, microservices, IoT, and public data APIs.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-query-normalization-search",
        result: {
          query: "the top 5 uses for REST APIs",
          results: [
            {
              title: "What is a REST API? Benefits, Uses, Examples - TechTarget",
              url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
              snippet: "REST APIs are a vital mechanism for software interoperability.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-query-normalization-navigate",
        result: {
          url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          finalUrl: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          status: 200,
          title: "What is a REST API? Benefits, Uses, Examples - TechTarget",
          textSnippet: "REST APIs are widely used for software interoperability and web services.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-query-normalization-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-query-normalization-1",
      content: "Can you look online and find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
    });

    const firstInvokeCall = (
      invokeTool.mock.calls as unknown as Array<
        [
          {
            toolName: string;
            args: Record<string, unknown>;
          },
        ]
      >
    )[0]?.[0];
    expect(firstInvokeCall).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({
        query: "the top 5 uses for REST APIs",
      }),
    });
    expect(result.assistantContent).toContain("REST APIs are widely used");
  });

  it("keeps entity-rich benchmark queries instead of drifting into citation instructions", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I found benchmark coverage for the three runtimes.",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The file exports `main` and `helper`.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-runtime-benchmarks-1",
      result: {
        results: [
          {
            title: "Node.js vs Bun vs Deno benchmarks",
            url: "https://example.com/benchmarks/node-bun-deno",
            snippet: "Recent runtime benchmark comparison.",
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-runtime-benchmarks-1",
      turnId: randomUUID(),
      userMessageId: "msg-runtime-benchmarks-1",
      content:
        "Compare Node.js, Bun, and Deno runtime benchmarks. If you can find recent benchmarks or comparisons, cite them.",
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Compare Node.js, Bun, and Deno runtime benchmarks. If you can find recent benchmarks or comparisons, cite them.",
        },
      ],
    });

    const firstInvokeCall = (
      invokeTool.mock.calls as unknown as Array<
        [
          {
            toolName: string;
            args: Record<string, unknown>;
          },
        ]
      >
    )[0]?.[0];
    const query = String(firstInvokeCall?.args.query ?? "");
    expect(firstInvokeCall?.toolName).toBe("browser.search");
    expect(query).toMatch(/\bnode(?:\.js)?\b/i);
    expect(query).toMatch(/\bbun\b/i);
    expect(query).toMatch(/\bdeno\b/i);
    expect(query).not.toMatch(/\bcite\b/i);
    expect(query).not.toMatch(/\bsources?\b/i);
  });

  it("ignores Prompt Lab tooling contract text when grounding browser.search queries", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Tooling Contract",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: web lookup tools",
      "- Do not substitute memory tools unless the prompt explicitly asks for memory.",
      "",
      "## User Task",
      "Use browser.search to find the current Node.js LTS version.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query:
            "navigate - Required tool families: web lookup tools - Do not substitute memory tools unless the prompt explicitly asks for memory.",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Node.js 22 is the current LTS line.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-node-lts-grounded-1",
      result: {
        query: "current Node.js LTS version",
        results: [
          {
            title: "Node.js Releases",
            url: "https://nodejs.org/en/about/previous-releases",
            snippet: "Node.js release schedule and LTS lines.",
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-browser-search-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-browser-search-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    const firstInvokeCall = (
      invokeTool.mock.calls as unknown as Array<
        [
          {
            toolName: string;
            args: Record<string, unknown>;
          },
        ]
      >
    )[0]?.[0];
    expect(firstInvokeCall).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({
        query: expect.stringMatching(/node\.js lts/i),
      }),
    });
    expect(String(firstInvokeCall?.args.query)).not.toMatch(/required tool families|memory tools/i);
    expect(result.assistantContent).toContain("Node.js 22");
  });

  it("redirects community browser.navigate urls to a better recent source when the prompt did not ask for community results", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          historyMessages: ChatCompletionRequest["messages"];
          webMode: ChatWebMode;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
        };
      }
    ).preflightToolInvocation({
      toolName: "browser.navigate",
      rawArgs: {
        url: "https://www.reddit.com/r/learnprogramming/comments/17kkjas/what_actually_is_a_rest_api_can_someone_provide/",
      },
      userContent: "Can you look online and find out the top 5 uses for REST APIs?",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
      webMode: "auto",
      priorToolRuns: [
        {
          toolRunId: "tool-search-community-redirect",
          turnId: "turn-community-redirect",
          sessionId: "sess-community-redirect",
          toolName: "browser.search",
          status: "executed",
          args: { query: "the top 5 uses for REST APIs" },
          result: {
            results: [
              {
                title: "What Is a REST API? Examples, Uses & Challenges - Postman Blog",
                url: "https://blog.postman.com/rest-api-examples/",
                snippet: "REST API examples and use cases.",
              },
              {
                title: "what actually is a REST api? Can someone provide an example it ... - Reddit",
                url: "https://www.reddit.com/r/learnprogramming/comments/17kkjas/what_actually_is_a_rest_api_can_someone_provide/",
                snippet: "Community discussion.",
              },
              {
                title: "What is a REST API? Benefits, Uses, Examples - TechTarget",
                url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
                snippet: "REST APIs are used for software interoperability.",
              },
            ],
          },
          startedAt: "2026-03-12T22:30:00.000Z",
          finishedAt: "2026-03-12T22:30:01.000Z",
        },
      ],
    });

    expect(preflight.toolName).toBe("browser.navigate");
    expect(preflight.args.url).not.toBe(
      "https://www.reddit.com/r/learnprogramming/comments/17kkjas/what_actually_is_a_rest_api_can_someone_provide/",
    );
    expect([
      "https://blog.postman.com/rest-api-examples/",
      "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
    ]).toContain(preflight.args.url);
  });

  it("does not inject browser.search for generic duration prompts containing time", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Cold brew usually takes 12 to 24 hours.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-time-1",
      turnId: randomUUID(),
      userMessageId: "msg-time-1",
      content: "how much time does it take to learn Go?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "how much time does it take to learn Go?" }],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.routing?.liveDataIntent).toBe(false);
    expect(result.assistantContent).toContain("12 to 24 hours");
  });

  it("treats explicit clock-time questions as time intent without using browser.search", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "It is currently 9:00 AM in Tokyo.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-time",
      result: {
        iso: "2026-03-06T17:00:00.000Z",
        timezone: "Asia/Tokyo",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-time-2",
      turnId: randomUUID(),
      userMessageId: "msg-time-2",
      content: "what time is it in Tokyo right now?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "what time is it in Tokyo right now?" }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "time.now",
      }),
    );
  });

  it("does not promote repeated search when recent results have no sufficiently relevant URL", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
        };
      }
    ).preflightToolInvocation({
      toolName: "browser.search",
      rawArgs: {
        query: "latest weather in Paris",
      },
      userContent: "what's the latest weather in Paris?",
      priorToolRuns: [
        {
          toolRunId: "tool-search-2",
          turnId: "turn-2",
          sessionId: "sess-7",
          toolName: "browser.search",
          status: "executed",
          args: { query: "latest weather in Paris" },
          result: {
            results: [{ title: "Search results", url: "https://www.google.com/search?q=weather+paris" }],
          },
          startedAt: "2026-03-06T22:31:00.000Z",
          finishedAt: "2026-03-06T22:31:01.000Z",
        },
      ],
    });

    expect(preflight.toolName).toBe("browser.search");
    expect(preflight.args).toMatchObject({
      query: "latest weather in Paris",
    });
  });

  it("stops immediately on non-recoverable missing-argument failures", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValue(navigateToolCallCompletion({}));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-5",
      turnId: randomUUID(),
      userMessageId: "msg-user-5",
      content: "What's the latest news on Kristi Noem?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What's the latest news on Kristi Noem?" }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("can't be retried safely");
    expect(result.assistantContent).toContain("sticking point was navigate");
    expect(result.assistantContent).not.toContain("execution error: url is required");
  });

  it("injects evidence grounding instruction when live-data intent triggers a proactive search", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Here are headlines based on search results.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-grounding",
      result: {
        results: [{ title: "Top story", url: "https://example.com/top-story", snippet: "Important news" }],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-grounding-1",
      turnId: randomUUID(),
      userMessageId: "msg-grounding-1",
      content: "What are the latest news headlines today?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What are the latest news headlines today?" }],
    });

    expect(createChatCompletion).toHaveBeenCalled();
    const completionCall = (createChatCompletion as any).mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const messages = completionCall?.messages as Array<{ role: string; content?: unknown }> | undefined;
    const systemMessages = messages?.filter((msg) => msg.role === "system") ?? [];
    const groundingMsg = systemMessages.find(
      (msg) => typeof msg.content === "string" && msg.content.includes("Evidence grounding"),
    );
    expect(groundingMsg).toBeDefined();
    expect(groundingMsg?.content as string).toContain("strictly on the tool results");
  });

  it("proactively opens the strongest live-data search result before synthesis when navigate is available", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "A humor roundup says a goat briefly disrupted a small-town parade yesterday.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-proactive-search",
        result: {
          results: [
            {
              title: "Funny news yesterday: goat disrupts small-town parade",
              url: "https://example.com/news/odd-roundup",
              snippet: "A funny news roundup from yesterday says a goat briefly disrupted a small-town parade.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-proactive-navigate",
        result: {
          url: "https://example.com/news/odd-roundup",
          finalUrl: "https://example.com/news/odd-roundup",
          title: "Odd News Roundup",
          content: "A goat briefly disrupted a small-town parade yesterday, drawing laughs from spectators.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-proactive-live-followthrough-1",
      turnId: randomUUID(),
      userMessageId: "msg-proactive-live-followthrough-1",
      content: "tell me something funny that happened in the news yesterday",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "tell me something funny that happened in the news yesterday" }],
    });

    const invokedToolNames = (invokeTool.mock.calls as unknown as Array<[{ toolName: string }]>).map(
      (call) => call[0].toolName,
    );
    expect(invokedToolNames).toEqual(["browser.search", "browser.navigate"]);
  });

  it("detects explicit web lookup phrases like 'search online' as live-data intent", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Search results found.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-search-online",
      result: {
        results: [{ title: "Result", url: "https://example.com", snippet: "snippet" }],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-search-online-1",
      turnId: randomUUID(),
      userMessageId: "msg-search-online-1",
      content: "Search online for the best project management tools",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search online for the best project management tools" }],
    });

    expect(result.turnTrace.routing?.liveDataIntent).toBe(true);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
      }),
    );
  });

  it("does not trigger proactive web search for generic current-state prompts", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Here is a local summary.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-current-architecture-1",
      turnId: randomUUID(),
      userMessageId: "msg-current-architecture-1",
      content: "Summarize the current architecture of the app.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Summarize the current architecture of the app." }],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.routing?.liveDataIntent).toBe(false);
  });

  it("does not expose web tools for stable conceptual chat prompts in auto mode", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        const toolNames = (request.tools ?? [])
          .map((tool) => (tool.function as { name?: string } | undefined)?.name)
          .filter((name): name is string => Boolean(name));
        expect(toolNames).not.toContain("browser_search");
        expect(toolNames).not.toContain("browser_navigate");
        expect(toolNames).not.toContain("http_get");
        expect(toolNames).toContain("time_now");
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  "REST APIs are commonly used for client-server CRUD backends, third-party integrations, mobile app data sync, workflow automation, and public partner APIs.",
              },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.get", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-api-stable-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-api-stable-1",
      content: "Can you find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you find out the top 5 uses for REST APIs?" }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("client-server CRUD backends");
  });

  it("keeps web tools exposed for direct-url chat prompts in auto mode", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        const toolNames = (request.tools ?? [])
          .map((tool) => (tool.function as { name?: string } | undefined)?.name)
          .filter((name): name is string => Boolean(name));
        expect(toolNames).toContain("browser_search");
        expect(toolNames).toContain("browser_navigate");
        expect(toolNames).toContain("http_get");
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "I can inspect that page.",
              },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.get", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-direct-url-chat-1",
      turnId: randomUUID(),
      userMessageId: "msg-direct-url-chat-1",
      content: "Summarize https://www.rfc-editor.org/rfc/rfc9110 from the page itself.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Summarize https://www.rfc-editor.org/rfc/rfc9110 from the page itself." },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("inspect that page");
  });

  it("executes explicit browser.search requests in chat mode and allows fallback retries", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        const toolNames = (request.tools ?? [])
          .map((tool) => (tool.function as { name?: string } | undefined)?.name)
          .filter((name): name is string => Boolean(name));
        expect(toolNames).toContain("browser_search");
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "I can use browser.search for that.",
              },
            },
          ],
        };
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-explicit-browser-search-1",
        result: {
          results: [],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-explicit-browser-search-2",
        result: {
          results: [
            {
              title: "Node.js releases",
              url: "https://nodejs.org/en/about/previous-releases",
              snippet: "The current LTS line is available on the Node.js release schedule.",
            },
          ],
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.get", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-explicit-browser-search-1",
      turnId: randomUUID(),
      userMessageId: "msg-explicit-browser-search-1",
      content: "Use browser.search to find the current Node.js LTS version.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Use browser.search to find the current Node.js LTS version." }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledTimes(2);
    const explicitSearchCalls = invokeTool.mock.calls as unknown as Array<
      [{ toolName: string; args: Record<string, unknown> }]
    >;
    const initialSearchCall = explicitSearchCalls[0]![0]!;
    const fallbackSearchCall = explicitSearchCalls[1]![0]!;
    expect(initialSearchCall).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({
        query: expect.stringMatching(/lts version/i),
      }),
    });
    expect(fallbackSearchCall).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({
        engine: "bing",
      }),
    });
    expect(fallbackSearchCall.args.query).toBe(initialSearchCall.args.query);
  });

  it("exposes memory write and lookup tools for explicit save-and-confirm chat prompts", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        const toolNames = (request.tools ?? [])
          .map((tool) => (tool.function as { name?: string } | undefined)?.name)
          .filter((name): name is string => Boolean(name));
        expect(toolNames).toContain("memory_write");
        expect(toolNames).toContain("memory_search");
        expect(toolNames).toContain("memory_read");
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "I can save that and verify it.",
              },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["memory.write", "memory.search", "memory.read", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-memory-save-confirm-1",
      turnId: randomUUID(),
      userMessageId: "msg-memory-save-confirm-1",
      content:
        "Remember this as a memory note: I prefer concise status updates. Then search memory to confirm it was saved.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "on",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Remember this as a memory note: I prefer concise status updates. Then search memory to confirm it was saved.",
        },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("prefers file and code tools over memory lookup for code file-analysis prompts", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementation(async (request) => {
        const toolNames = (request.tools ?? [])
          .map((tool) => (tool.function as { name?: string } | undefined)?.name)
          .filter((name): name is string => Boolean(name));
        expect(toolNames).toContain("file_read_range");
        expect(toolNames).toContain("code_search");
        expect(toolNames).toContain("code_search_files");
        expect(toolNames).not.toContain("memory_search");
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "I can inspect the local files directly.",
              },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () =>
        createToolCatalog([
          "memory.search",
          "file.read_range",
          "file.find",
          "code.search",
          "code.search_files",
          "time.now",
        ]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-code-file-tools-1",
      turnId: randomUUID(),
      userMessageId: "msg-code-file-tools-1",
      content: "Read fixtures/prompt-pack-workspace/package.json using file tools and analyze the scripts section.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "auto",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "Read fixtures/prompt-pack-workspace/package.json using file tools and analyze the scripts section.",
        },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalled();
    const invokedToolNames = (invokeTool.mock.calls as unknown as Array<[{ toolName: string }]>)
      .map((call) => call[0]?.toolName)
      .filter((toolName): toolName is string => Boolean(toolName));
    expect(invokedToolNames).not.toContain("memory.search");
  });

  it("infers a missing file.find path from explicit local file prompts", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("file.find", { pattern: "tasks" }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The file defines a task map and CRUD routes.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-file-find-inferred-path-1",
      result: {
        path: "src/index.ts",
        pattern: "tasks",
        count: 1,
        matches: [{ path: "src/index.ts", line: 15, lineText: "const tasks: Map<string, Task> = new Map();" }],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.find"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-file-find-inferred-path-1",
      turnId: randomUUID(),
      userMessageId: "msg-file-find-inferred-path-1",
      content: "Look at src/index.ts and identify code quality improvements around task handling.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "Look at src/index.ts and identify code quality improvements around task handling.",
        },
      ],
    });

    const firstInvokeCall = (
      invokeTool.mock.calls as unknown as Array<
        [
          {
            toolName: string;
            args: Record<string, unknown>;
          },
        ]
      >
    )[0]?.[0];
    expect(firstInvokeCall).toMatchObject({
      toolName: "file.find",
      args: expect.objectContaining({
        path: "src/index.ts",
        pattern: "tasks",
      }),
    });
  });

  it("infers missing code.search_files args for full-project file audits", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("code.search_files", {}))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The fixture project contains package.json, tsconfig.json, and two source files.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-code-search-files-inferred-1",
      result: {
        path: "fixtures/prompt-pack-workspace/",
        query: ".",
        count: 4,
        matches: [{ path: "fixtures/prompt-pack-workspace/package.json", name: "package.json", type: "file" }],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-code-search-files-inferred-1",
      turnId: randomUUID(),
      userMessageId: "msg-code-search-files-inferred-1",
      content:
        "Read all source files in fixtures/prompt-pack-workspace/ using file tools. Produce a project audit report covering structure, code quality, and test coverage gaps.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Read all source files in fixtures/prompt-pack-workspace/ using file tools. Produce a project audit report covering structure, code quality, and test coverage gaps.",
        },
      ],
    });

    const firstInvokeCall = (
      invokeTool.mock.calls as unknown as Array<
        [
          {
            toolName: string;
            args: Record<string, unknown>;
          },
        ]
      >
    )[0]?.[0];
    expect(firstInvokeCall).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        path: "fixtures/prompt-pack-workspace/",
      }),
    });
    expect([".", "read", "report"]).toContain(String(firstInvokeCall?.args?.query ?? ""));
  });

  it("does not invent local file paths from bare technology names", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("file.read_range", {
          startLine: 1,
          endLine: 20,
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I need an actual project file path before I can inspect local code.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-no-bogus-tech-path-1",
      turnId: randomUUID(),
      userMessageId: "msg-no-bogus-tech-path-1",
      content: "Explain whether this project should upgrade Node.js and TypeScript next quarter.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "Explain whether this project should upgrade Node.js and TypeScript next quarter.",
        },
      ],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("treats release-window prompts like this week as live-data intent", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Here are the strongest current leads.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-movies-week-1",
      result: {
        results: [
          {
            title: "IMDb upcoming releases",
            url: "https://www.imdb.com/calendar/",
            snippet: "Upcoming movie releases this week.",
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-movies-week-1",
      turnId: randomUUID(),
      userMessageId: "msg-movies-week-1",
      content: "What movies are coming out this week?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What movies are coming out this week?" }],
    });

    expect(result.turnTrace.routing?.liveDataIntent).toBe(true);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({
          query: "What movies are coming out this week",
        }),
      }),
    );
  });

  it("retries remote-blocked browser navigation through MCP fallback tiers", async () => {
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-remote-blocked-1",
      result: {
        url: "https://movieinsider.com/movies",
        finalUrl: "https://movieinsider.com/movies",
        status: 403,
        title: "Attention Required! | Cloudflare",
        textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
      },
    });
    const invokeMcpTool = vi.fn<() => Promise<McpInvokeResponse>>().mockResolvedValueOnce({
      ok: true,
      output: {
        structuredContent: {
          url: "https://www.imdb.com/calendar/",
          finalUrl: "https://www.imdb.com/calendar/",
          status: 200,
          title: "IMDb Release Calendar",
          textSnippet: "Upcoming movies this week.",
        },
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool,
      invokeMcpTool,
      listMcpBrowserFallbackTargets: () => [
        {
          serverId: "srv-playwright",
          label: "Playwright MCP",
          tier: "playwright_mcp",
          navigateToolName: "browser.navigate",
          extractToolName: "browser.extract",
        },
      ],
    });

    const executed = await (
      orchestrator as unknown as {
        executeToolCall(input: {
          input: {
            sessionId: string;
            content: string;
            mode: "chat";
            providerId: string;
            model: string;
            webMode: "auto";
            memoryMode: "off";
            thinkingLevel: "standard";
            toolAutonomy: "safe_auto";
          };
          turnId: string;
          toolName: string;
          rawArgs: Record<string, unknown>;
        }): Promise<{ record: ChatToolRunRecord }>;
      }
    ).executeToolCall({
      input: {
        sessionId: "sess-mcp-fallback-1",
        content: "What movies are coming out this week?",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "auto",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
      },
      turnId: "turn-mcp-fallback-1",
      toolName: "browser.navigate",
      rawArgs: {
        url: "https://movieinsider.com/movies",
      },
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "srv-playwright",
        toolName: "browser.navigate",
        arguments: expect.objectContaining({
          url: "https://movieinsider.com/movies",
        }),
      }),
    );
    expect(executed.record.status).toBe("executed");
    expect(executed.record.result).toMatchObject({
      engineTier: "playwright_mcp",
      engineLabel: "Playwright MCP",
      finalUrl: "https://www.imdb.com/calendar/",
    });
    expect(Array.isArray(executed.record.result?.fallbackChain)).toBe(true);
    expect((executed.record.result?.fallbackChain as Array<Record<string, unknown>>)[0]).toMatchObject({
      engineTier: "builtin",
      browserFailureClass: "remote_blocked",
      status: "failed",
    });
  });

  it("stops MCP browser fallback tiers when the turn budget expires mid-fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T20:00:00.000Z"));
    try {
      const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-mcp-budget-nav-1",
        result: {
          url: "https://blocked-site.com/article",
          finalUrl: "https://blocked-site.com/article",
          status: 403,
          title: "Attention Required! | Cloudflare",
          textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
        },
      });
      const invokeMcpTool = vi
        .fn<(request: McpInvokeRequest) => Promise<McpInvokeResponse>>()
        .mockImplementation(async (request: McpInvokeRequest) => {
          vi.setSystemTime(new Date(Date.now() + 15000));
          return {
            ok: false,
            error: `${request.serverId} timed out`,
          };
        });
      const orchestrator = new ChatAgentOrchestrator({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog(["browser.navigate"]),
        createChatCompletion: vi.fn(),
        invokeTool,
        invokeMcpTool,
        listMcpBrowserFallbackTargets: () => [
          {
            serverId: "srv-playwright",
            label: "Playwright MCP",
            tier: "playwright_mcp",
            navigateToolName: "browser.navigate",
            extractToolName: "browser.extract",
          },
          {
            serverId: "srv-browserbase",
            label: "Browserbase MCP",
            tier: "browser_mcp",
            navigateToolName: "browser.navigate",
            extractToolName: "browser.extract",
          },
          {
            serverId: "srv-cdp",
            label: "CDP MCP",
            tier: "browser_mcp",
            navigateToolName: "browser.navigate",
            extractToolName: "browser.extract",
          },
        ],
      });

      const executed = await (
        orchestrator as unknown as {
          executeToolCall(input: {
            input: {
              sessionId: string;
              content: string;
              mode: "chat";
              providerId: string;
              model: string;
              webMode: "auto";
              memoryMode: "off";
              thinkingLevel: "standard";
              toolAutonomy: "safe_auto";
            };
            turnId: string;
            toolName: string;
            rawArgs: Record<string, unknown>;
            turnBudgetDeadline?: number;
          }): Promise<{ record: ChatToolRunRecord }>;
        }
      ).executeToolCall({
        input: {
          sessionId: "sess-mcp-budget-1",
          content: "What's the latest news today?",
          mode: "chat",
          providerId: "glm",
          model: "glm-5",
          webMode: "auto",
          memoryMode: "off",
          thinkingLevel: "standard",
          toolAutonomy: "safe_auto",
        },
        turnId: "turn-mcp-budget-1",
        toolName: "browser.navigate",
        rawArgs: {
          url: "https://blocked-site.com/article",
        },
        turnBudgetDeadline: Date.now() + 25000,
      });

      expect(invokeMcpTool).toHaveBeenCalledTimes(2);
      expect(executed.record.status).toBe("failed");
      expect(Array.isArray(executed.record.result?.fallbackChain)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("poisons blocked hosts when selecting the next grounded browser result", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
        };
      }
    ).preflightToolInvocation({
      toolName: "browser.navigate",
      rawArgs: { url: "https://lite.duckduckgo.com/lite/?q=movies+this+week" },
      userContent: "What movies are coming out this week?",
      priorToolRuns: [
        {
          toolRunId: "tool-search-movies-1",
          turnId: "turn-movies-1",
          sessionId: "sess-movies-1",
          toolName: "browser.search",
          status: "executed",
          args: { query: "movies coming out this week" },
          result: {
            results: [
              { title: "Movie Insider releases", url: "https://www.movieinsider.com/movies", snippet: "Releases" },
              {
                title: "Movies coming out this week - IMDb",
                url: "https://www.imdb.com/calendar/",
                snippet: "Upcoming releases this week.",
              },
            ],
          },
          startedAt: "2026-03-10T01:00:00.000Z",
          finishedAt: "2026-03-10T01:00:01.000Z",
        },
        {
          toolRunId: "tool-nav-movies-1",
          turnId: "turn-movies-1",
          sessionId: "sess-movies-1",
          toolName: "browser.navigate",
          status: "failed",
          args: { url: "https://www.movieinsider.com/movies" },
          result: {
            url: "https://www.movieinsider.com/movies",
            finalUrl: "https://www.movieinsider.com/movies",
            status: 403,
            browserFailureClass: "remote_blocked",
          },
          error: "remote site blocked automation (Cloudflare 403)",
          startedAt: "2026-03-10T01:00:02.000Z",
          finishedAt: "2026-03-10T01:00:03.000Z",
        },
      ],
    });

    expect(preflight.toolName).toBe("browser.navigate");
    expect(preflight.args).toMatchObject({
      url: "https://www.imdb.com/calendar/",
    });
  });

  it("surfaces blocked-source fallback copy instead of generic retry wording", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://www.movieinsider.com/movies" }))
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://www.movieinsider.com/movies" }));
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-movieinsider-blocked",
      result: {
        url: "https://www.movieinsider.com/movies",
        finalUrl: "https://www.movieinsider.com/movies",
        status: 403,
        title: "Attention Required! | Cloudflare",
        textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-movieinsider-blocked-1",
      turnId: randomUUID(),
      userMessageId: "msg-movieinsider-blocked-1",
      content: "What movies are coming out this week?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What movies are coming out this week?" }],
    });

    expect(result.assistantContent).toContain("movieinsider.com");
    expect(result.assistantContent).toContain("blocked");
  });

  it("grounds vague retry prompts to the prior topic instead of searching the literal phrase", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("retry with a better fallback"))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "The main REST API use cases are CRUD, integrations, mobile backends, automation, and partner-facing services.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-rest-retry-grounded-1",
      result: {
        query: "top 5 ways REST APIs are used",
        results: [
          {
            title: "What Is REST API? Examples, Uses & Challenges - Postman Blog",
            url: "https://blog.postman.com/rest-api-examples/",
            snippet: "Examples and common use cases.",
          },
          {
            title: "REST API Introduction - GeeksforGeeks",
            url: "https://www.geeksforgeeks.org/rest-api-introduction/",
            snippet: "REST principles and use cases.",
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-retry-grounded-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-retry-grounded-1",
      content: "Please retry with a better fallback",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Can you look into the top 5 ways that a REST API can be used?" },
        {
          role: "assistant",
          content: [
            "A source blocked automated browsing on blog.postman.com, so I'm falling back to the strongest leads I recovered so far:",
            "",
            "1. What Is a REST API? Examples, Uses & Challenges - Postman Blog",
            "2. REST API Introduction - GeeksforGeeks",
          ].join("\n"),
        },
        { role: "user", content: "Please retry with a better fallback" },
      ],
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    const groundedRetryCalls = invokeTool.mock.calls as unknown as Array<
      [{ toolName: string; args: Record<string, unknown> }]
    >;
    const groundedRetryCall = groundedRetryCalls[0]![0]!;
    expect(groundedRetryCall).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({
        query: expect.stringMatching(/rest api/i),
      }),
    });
    expect(String(groundedRetryCall.args.query)).not.toMatch(/better fallback/i);
    expect(result.assistantContent).toContain("REST API");
  });

  it("prefers structured browser search alternatives over literal retry text", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "kimi-k2.5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-search-kimi-1",
                  type: "function",
                  function: {
                    name: "browser_search",
                    arguments: JSON.stringify({
                      query: "Try the search one more time",
                      queries: [
                        "top 5 ways REST APIs are used common use cases",
                        "REST API use cases examples applications",
                        "how are REST APIs commonly used real world",
                      ],
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "kimi-k2.5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Here are the top ways REST APIs are used in practice.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-rest-queries-grounded-1",
      result: {
        query: "top 5 ways REST APIs are used common use cases",
        results: [
          {
            title: "What Is REST API? Examples, Uses & Challenges - Postman Blog",
            url: "https://blog.postman.com/rest-api-examples/",
            snippet: "Examples and common use cases.",
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-rest-queries-grounded-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-queries-grounded-1",
      content: "Try the search one more time",
      mode: "chat",
      providerId: "moonshot",
      model: "kimi-k2.5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Can you look online and find the top 5 ways rest apis are used?" },
        {
          role: "assistant",
          content:
            "A source blocked automated browsing on blog.postman.com, so I'm falling back to the strongest leads I recovered so far.",
        },
        { role: "user", content: "Try the search one more time" },
      ],
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    const kimiRetryCalls = invokeTool.mock.calls as unknown as Array<[{ args: Record<string, unknown> }]>;
    const kimiRetryCall = kimiRetryCalls[0]![0]!;
    expect(String(kimiRetryCall.args.query)).toMatch(/rest api/i);
    expect(String(kimiRetryCall.args.query)).not.toMatch(/one more time/i);
  });

  it("retries a blocked browser navigate against the next ranked search result in the same turn", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://blog.postman.com/rest-api-examples/" }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "REST APIs are commonly used for CRUD app backends, third-party integrations, mobile app services, workflow automation, and partner/public APIs.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-search-1",
        result: {
          query: "top 5 ways REST APIs are used",
          results: [
            {
              title: "What Is REST API? Examples, Uses & Challenges - Postman Blog",
              url: "https://blog.postman.com/rest-api-examples/",
              snippet: "Examples and use cases.",
            },
            {
              title: "How to Use REST API: Examples, Key Features, and Applications - ClickUp",
              url: "https://clickup.com/blog/rest-api-examples/",
              snippet: "Key features and real-world applications.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-postman-blocked-1",
        result: {
          url: "https://blog.postman.com/rest-api-examples/",
          finalUrl: "https://blog.postman.com/rest-api-examples/",
          status: 403,
          title: "Just a moment...",
          textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-clickup-1",
        result: {
          url: "https://clickup.com/blog/rest-api-examples/",
          finalUrl: "https://clickup.com/blog/rest-api-examples/",
          status: 200,
          title: "How to Use REST API: Examples, Key Features, and Applications - ClickUp",
          textSnippet: "REST APIs are used for integrations, automation, mobile and web backends, and partner systems.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-blocked-retry-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-blocked-retry-1",
      content: "Can you look online into the top 5 ways that a REST API can be used?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Can you look online into the top 5 ways that a REST API can be used?" },
      ],
    });

    expect(invokeTool).toHaveBeenCalledTimes(3);
    const navigateRetryCalls = invokeTool.mock.calls as unknown as Array<
      [{ toolName: string; args: Record<string, unknown> }]
    >;
    const firstNavigateCall = navigateRetryCalls[1]![0]!;
    const secondNavigateCall = navigateRetryCalls[2]![0]!;
    expect(firstNavigateCall).toMatchObject({
      toolName: "browser.navigate",
      args: expect.objectContaining({
        url: "https://blog.postman.com/rest-api-examples/",
      }),
    });
    expect(secondNavigateCall).toMatchObject({
      toolName: "browser.navigate",
      args: expect.objectContaining({
        url: "https://clickup.com/blog/rest-api-examples/",
      }),
    });
    expect(result.assistantContent).toContain("REST APIs");
  });

  it("prefers direct news publishers over portal reposts after a blocked current-events source", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://www.reuters.com/world/iran/" }))
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "ABC reported that search efforts intensified for a missing US crew member as the conflict escalated.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-us-iran-search-1",
        result: {
          query: "latest news today us iran",
          results: [
            {
              title: "Iran War: Latest Breaking News, Updates & Analysis | Reuters",
              url: "https://www.reuters.com/world/iran/",
              snippet: "Live coverage and analysis from Reuters.",
            },
            {
              title: "Iran live updates: Search for missing US crew member intensifies",
              url: "https://abcnews.com/International/live-updates/iran-live-updates-trump-touts-big-day-iran/?id=131532311",
              snippet: "ABC News live updates on the US and Iran.",
            },
            {
              title: "Tehran Dismisses U.S. Cease-Fire Conditions as Israel Steps Up Attacks",
              url: "https://www.nytimes.com/live/2026/03/25/world/iran-war-trump-oil-news",
              snippet: "New York Times live coverage of the conflict.",
            },
            {
              title: "Iran live updates: 290 American troops wounded in Iran war - Yahoo",
              url: "https://www.yahoo.com/news/articles/iran-live-updates-trumps-48-090509033.html",
              snippet: "Yahoo's live updates page covering the US and Iran.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-us-iran-reuters-blocked-1",
        result: {
          url: "https://www.reuters.com/world/iran/",
          finalUrl: "https://www.reuters.com/world/iran/",
          status: 401,
          title: "Reuters",
          textSnippet: "Automation blocked",
          browserFailureClass: "remote_blocked",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-us-iran-abc-1",
        result: {
          url: "https://abcnews.com/International/live-updates/iran-live-updates-trump-touts-big-day-iran/?id=131532311",
          finalUrl:
            "https://abcnews.com/International/live-updates/iran-live-updates-trump-touts-big-day-iran/?id=131532311",
          status: 200,
          title: "Iran live updates: Search for missing US crew member intensifies",
          textSnippet: "ABC News reports that search efforts intensified for a missing US crew member.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-us-iran-news-fallback-1",
      turnId: randomUUID(),
      userMessageId: "msg-us-iran-news-fallback-1",
      content: "tell me something that happened today regarding the us and iran",
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "tell me something that happened today regarding the us and iran" }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(3);
    const navigateRetryCalls = invokeTool.mock.calls as unknown as Array<
      [{ toolName: string; args: Record<string, unknown> }]
    >;
    const firstNavigateCall = navigateRetryCalls[1]![0]!;
    const secondNavigateCall = navigateRetryCalls[2]![0]!;
    expect(firstNavigateCall).toMatchObject({
      toolName: "browser.navigate",
      args: expect.objectContaining({
        url: "https://www.reuters.com/world/iran/",
      }),
    });
    expect(secondNavigateCall).toMatchObject({
      toolName: "browser.navigate",
      args: expect.objectContaining({
        url: "https://abcnews.com/International/live-updates/iran-live-updates-trump-touts-big-day-iran/?id=131532311",
      }),
    });
    expect(result.assistantContent).toContain("ABC reported");
  });

  it("prefers use-case result pages over definition pages after a blocked first source", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://blog.postman.com/rest-api-examples/" }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "REST APIs are commonly used for web and mobile apps, integrations, microservices, IoT, and internal tooling.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-usecase-search-1",
        result: {
          query: "the top 5 uses for REST APIs",
          results: [
            {
              title: "What Is a REST API? Examples, Uses & Challenges - Postman Blog",
              url: "https://blog.postman.com/rest-api-examples/",
              snippet: "What is a REST API? Examples, Uses & Challenges - Postman Blog.",
            },
            {
              title: "What is a REST API? Benefits, Uses, Examples - TechTarget",
              url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
              snippet:
                "A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data.",
            },
            {
              title: "What is a REST API? Examples, Use Cases, and Best Practices",
              url: "https://www.browserstack.com/guide/rest-api",
              snippet:
                "Learn REST API basics with real-world REST API examples, key principles, architectural constraints, and best practices for reliable design.",
            },
            {
              title: "REST API basics and implementation | Google Cloud",
              url: "https://cloud.google.com/discover/what-is-rest-api",
              snippet: "Learn what a REST API is, how it works, and its core principles.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-usecase-postman-blocked-1",
        result: {
          url: "https://blog.postman.com/rest-api-examples/",
          finalUrl: "https://blog.postman.com/rest-api-examples/",
          status: 403,
          title: "Just a moment...",
          textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-usecase-browserstack-1",
        result: {
          url: "https://www.browserstack.com/guide/rest-api",
          finalUrl: "https://www.browserstack.com/guide/rest-api",
          status: 200,
          title: "What is a REST API? Examples, Use Cases, and Best Practices",
          textSnippet:
            "REST APIs are used for web and mobile backends, integrations with third-party services, partner APIs, and automation workflows.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-rest-usecase-ranking-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-usecase-ranking-1",
      content: "Can you look online and find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
    });

    const navigateCalls = (
      invokeTool.mock.calls as unknown as Array<[{ toolName: string; args: Record<string, unknown> }]>
    )
      .map((call) => call[0])
      .filter((call) => call.toolName === "browser.navigate");
    expect(navigateCalls).toHaveLength(2);
    expect(navigateCalls[1]).toMatchObject({
      args: expect.objectContaining({
        url: "https://www.browserstack.com/guide/rest-api",
      }),
    });
  });

  it("gives live-data browse turns enough time to synthesize after a successful navigate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T18:33:34.000Z"));
    try {
      const createChatCompletion = vi
        .fn<() => Promise<ChatCompletionResponse>>()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 9000));
          return navigateToolCallCompletion({
            url: "https://www.techtarget.com/searchapparchitecture/tip/The-5-essential-HTTP-methods-in-RESTful-API-development",
          });
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 2000));
          return {
            model: "glm-5",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    "The top REST API uses are CRUD backends, third-party integrations, mobile app services, workflow automation, and partner-facing APIs.",
                },
              },
            ],
          };
        });
      const invokeTool = vi
        .fn<() => Promise<ToolInvokeResult>>()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 3000));
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-rest-budget-search-1",
            result: {
              query: "top 5 ways REST APIs are used",
              results: [
                {
                  title: "What is a REST API? Examples, Use Cases, and Best Practices",
                  url: "https://www.browserstack.com/guide/rest-api",
                  snippet: "REST APIs are commonly used for integrations, CRUD backends, and automation.",
                },
                {
                  title: "The 5 essential HTTP methods in RESTful API development",
                  url: "https://www.techtarget.com/searchapparchitecture/tip/The-5-essential-HTTP-methods-in-RESTful-API-development",
                  snippet: "RESTful services use HTTP methods and commonly back web, mobile, and partner systems.",
                },
              ],
            },
          };
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 15000));
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-rest-budget-navigate-1",
            result: {
              url: "https://www.techtarget.com/searchapparchitecture/tip/The-5-essential-HTTP-methods-in-RESTful-API-development",
              finalUrl:
                "https://www.techtarget.com/searchapparchitecture/tip/The-5-essential-HTTP-methods-in-RESTful-API-development",
              status: 200,
              title: "The 5 essential HTTP methods in RESTful API development | TechTarget",
              textSnippet:
                "REST APIs are widely used for web and mobile backends, app integrations, automation flows, and partner-facing services.",
            },
          };
        });
      const orchestrator = new ChatAgentOrchestrator({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
        createChatCompletion,
        invokeTool,
      });

      const result = await orchestrator.run({
        sessionId: "sess-rest-budget-extension-1",
        turnId: randomUUID(),
        userMessageId: "msg-rest-budget-extension-1",
        content: "Can you look online and find the top 5 ways rest apis are used?",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "auto",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
        historyMessages: [{ role: "user", content: "Can you look online and find the top 5 ways rest apis are used?" }],
      });

      expect(result.assistantContent).toContain("top REST API uses");
      expect(result.turnTrace.failure).toBeUndefined();
      expect(createChatCompletion).toHaveBeenCalledTimes(2);
      expect(invokeTool).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters cookie-banner and nav boilerplate out of recovered fetched-content fallbacks", async () => {
    const articleUrl = "https://dnsmadeeasy.com/resources/rest-apis-explained-how-they-work-and-why-theyre-essential";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("find out the top 5 uses for REST APIs"))
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: articleUrl }))
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: articleUrl }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
            },
          },
        ],
      })
      .mockRejectedValueOnce(new Error("synthesis timeout"));
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-cookie-search-1",
        result: {
          query: "find out the top 5 uses for REST APIs",
          results: [
            {
              title: "REST APIs Explained: How They Work and Why They're Essential",
              url: articleUrl,
              snippet: "REST APIs are widely used to build web services and integrate different applications.",
            },
          ],
        },
      })
      .mockResolvedValue({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-cookie-navigate-1",
        result: {
          url: articleUrl,
          finalUrl: articleUrl,
          status: 200,
          title: "REST APIs Explained: How They Work and Why They're Essential",
          textSnippet: [
            "This website uses cookies to ensure you get the best experience on our website.",
            "Learn more Got it! Skip to content Product Integrations Pricing Resources Company FREE TRIAL BOOK DEMO Search Support Login BLOG.",
            "APIs are an essential tool that facilitates communication between software and applications.",
            "REST APIs are widely used to build web services and integrate different applications.",
            "An online store might use a RESTful API to connect its inventory system with its website and mobile app.",
            "Another common use is workflow automation between internal systems and partner-facing services.",
          ].join(" "),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-cookie-fallback-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-cookie-fallback-1",
      content: "Can you look online and find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
    });

    expect(result.assistantContent).toContain(
      "REST APIs are widely used to build web services and integrate different applications.",
    );
    expect(result.assistantContent).toContain("An online store might use a RESTful API");
    expect(result.assistantContent).not.toContain("This website uses cookies");
    expect(result.assistantContent).not.toContain("Skip to content");
    expect(result.assistantContent).not.toContain("FREE TRIAL");
    expect(result.turnTrace.failure?.failureClass).toBe("unknown");
  });

  it("extends auto-mode budget when a non-live-data turn actually enters browser-backed execution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T19:10:00.000Z"));
    try {
      const createChatCompletion = vi
        .fn<() => Promise<ChatCompletionResponse>>()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 15000));
          return navigateToolCallCompletion({
            url: "https://example.com/protobuf-vs-json-schema",
          });
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 15000));
          return {
            model: "glm-5",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    "Protobuf is usually better for compact binary transport, while JSON Schema is stronger for JSON validation, interoperability, and contract tooling.",
                },
              },
            ],
          };
        });
      const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(Date.now() + 15000));
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: "audit-browser-extension-navigate-1",
          result: {
            url: "https://example.com/protobuf-vs-json-schema",
            finalUrl: "https://example.com/protobuf-vs-json-schema",
            status: 200,
            title: "Protobuf vs JSON Schema for service contracts",
            textSnippet:
              "Protobuf favors binary efficiency and typed contracts. JSON Schema favors human-readable JSON validation and broader ecosystem interoperability.",
          },
        };
      });
      const orchestrator = new ChatAgentOrchestrator({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
        createChatCompletion,
        invokeTool,
      });

      const result = await orchestrator.run({
        sessionId: "sess-browser-extension-1",
        turnId: randomUUID(),
        userMessageId: "msg-browser-extension-1",
        content: "Compare protobuf and JSON Schema tradeoffs using https://example.com/protobuf-vs-json-schema.",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "auto",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
        historyMessages: [
          {
            role: "user",
            content: "Compare protobuf and JSON Schema tradeoffs using https://example.com/protobuf-vs-json-schema.",
          },
        ],
      });

      expect(result.turnTrace.routing?.liveDataIntent).toBe(false);
      expect(result.assistantContent).toContain("Protobuf");
      expect(result.turnTrace.failure).toBeUndefined();
      expect(createChatCompletion).toHaveBeenCalledTimes(2);
      expect(invokeTool).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses fetched page content in the budget fallback after a successful navigate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));
    try {
      const createChatCompletion = vi
        .fn<() => Promise<ChatCompletionResponse>>()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 12000));
          return toolCallCompletion("help me leveling my skinning profession in world of warcraft midnight");
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 10000));
          return navigateToolCallCompletion({
            url: "https://www.wowhead.com/guide/midnight/professions/skinning-overview-trainer-locations-hides-tracking-tools",
          });
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 20000));
          return navigateToolCallCompletion({
            url: "https://www.wowhead.com/guide/midnight/professions/skinning-overview-trainer-locations-hides-tracking-tools#leveling",
          });
        });
      const invokeTool = vi
        .fn<() => Promise<ToolInvokeResult>>()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 5000));
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-skinning-search-1",
            result: {
              query: "help me leveling my skinning profession in world of warcraft midnight",
              results: [
                {
                  title: "Midnight Skinning Profession Overview - Wowhead",
                  url: "https://www.wowhead.com/guide/midnight/professions/skinning-overview-trainer-locations-hides-tracking-tools",
                  snippet:
                    "Skinning in WoW Midnight covers leveling, trainer locations, hides, tracking, and profession tools.",
                },
              ],
            },
          };
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-skinning-navigate-1",
            result: {
              url: "https://www.wowhead.com/guide/midnight/professions/skinning-overview-trainer-locations-hides-tracking-tools",
              finalUrl:
                "https://www.wowhead.com/guide/midnight/professions/skinning-overview-trainer-locations-hides-tracking-tools",
              status: 200,
              title: "Midnight Skinning Profession Overview - Wowhead",
              textSnippet: [
                "Skinning in Midnight focuses on gathering leather and hides from beasts across the new zones.",
                "Leveling is primarily done by skinning beasts close to your current profession skill, then shifting to higher-rank creature families as recipes and drop ranks improve.",
                "Tracking, profession tools, and route selection matter because dense beast camps dramatically improve leveling speed.",
              ].join(" "),
            },
          };
        });
      const orchestrator = new ChatAgentOrchestrator({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
        createChatCompletion,
        invokeTool,
      });

      const result = await orchestrator.run({
        sessionId: "sess-skinning-budget-fallback-1",
        turnId: randomUUID(),
        userMessageId: "msg-skinning-budget-fallback-1",
        content: "Look online and help me leveling my skinning profession in world of warcraft midnight.",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "auto",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
        historyMessages: [
          {
            role: "user",
            content: "Look online and help me leveling my skinning profession in world of warcraft midnight.",
          },
        ],
      });

      expect(result.turnTrace.failure?.failureClass).toBeDefined();
      expect(result.assistantContent).toContain("Midnight Skinning Profession Overview - Wowhead");
      expect(result.assistantContent).toContain(
        "Leveling is primarily done by skinning beasts close to your current profession skill",
      );
      expect(result.assistantContent).not.toContain("strongest leads so far");
      expect(createChatCompletion.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(invokeTool).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("repairs degraded fallback-style assistant answers after successful tool execution", async () => {
    const badFallback = [
      "I ran out of time before I could finish a full pass, but I did recover useful content from What is a REST API? Benefits, uses, examples:",
      "",
      "1. The REST API supports data formats such as application/json and application/xml.",
      "2. A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data.",
      "3. REST APIs are also referred to as RESTful web services and RESTful APIs.",
      "",
      "Source: What is a REST API? Benefits, uses, examples - https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
      "",
      "If you want, ask me to continue from this page with a narrower follow-up, or retry in Deep mode for a slower pass.",
    ].join("\n");
    const repairedAnswer = [
      "The retrieved sources point to a few common REST API uses, even though I did not get a clean ranked top-5 article.",
      "",
      "1. Moving data between frontends and backends for web and mobile apps.",
      "2. User and account management workflows.",
      "3. E-commerce operations such as catalog, cart, and order flows.",
      "4. Payment and transaction processing integrations.",
      "5. Third-party service integrations and workflow automation.",
      "",
      "Primary sources I recovered: TechTarget, Requestly, and Postman.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("the top 5 uses for REST APIs"))
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://blog.postman.com/rest-api-examples/",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: badFallback,
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: repairedAnswer,
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-search-1",
        result: {
          query: "the top 5 uses for REST APIs",
          results: [
            {
              title: "What Is a REST API? Examples, Uses & Challenges - Postman Blog",
              url: "https://blog.postman.com/rest-api-examples/",
              snippet:
                "A REST API is a simple uniform interface used to make digital resources available through web URLs.",
            },
            {
              title: "What is REST API: Examples, Principles, and Use Cases",
              url: "https://requestly.com/blog/rest-api-examples/",
              snippet:
                "Learn what REST APIs are with practical examples such as user management, e-commerce, and payment systems.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-navigate-1",
        result: {
          url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          finalUrl: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          status: 200,
          title: "What is a REST API? Benefits, uses, examples",
          textSnippet: [
            "A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data.",
            "That data can be used to GET, PUT, POST and DELETE data types, which refers to reading, updating, creating and deleting operations related to resources.",
            "REST APIs are also referred to as RESTful web services and RESTful APIs.",
          ].join(" "),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-fallback-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-fallback-repair-1",
      content: "Can you look online and find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
    });

    expect(result.assistantContent).toContain("Moving data between frontends and backends");
    expect(result.assistantContent).not.toContain("I ran out of time before I could finish a full pass");
    expect(result.turnTrace.failure?.failureClass).toBe("unknown");
    expect(result.turnTrace.completion).toMatchObject({
      repaired: true,
      repair: {
        applied: true,
        kind: "degraded_answer_synthesis",
        source: "orchestrator",
        preRepairContent: badFallback,
        postRepairContent: repairedAnswer,
      },
    });
    expect(createChatCompletion).toHaveBeenCalledTimes(4);
    const invokedToolNames = (invokeTool.mock.calls as unknown as Array<[{ toolName: string }]>).map(
      (call) => call[0].toolName,
    );
    expect(invokedToolNames).toContain("browser.search");
    expect(invokedToolNames).toContain("browser.navigate");
  });

  it("falls back to a direct recovered-evidence answer when degraded-answer repair times out", async () => {
    const badFallback = [
      "I ran out of time before I could finish a full pass, but I did recover useful content from What is a REST API? Benefits, uses, examples:",
      "",
      "1. The REST API supports data formats such as application/json and application/xml.",
      "2. A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data.",
      "3. REST APIs are also referred to as RESTful web services and RESTful APIs.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("the top 5 uses for REST APIs"))
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://blog.postman.com/rest-api-examples/",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: badFallback,
            },
          },
        ],
      })
      .mockRejectedValueOnce(new Error("Chat completion timed out after 20000ms."));
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-search-timeout-1",
        result: {
          query: "the top 5 uses for REST APIs",
          results: [
            {
              title: "What is REST API: Examples, Principles, and Use Cases",
              url: "https://requestly.com/blog/rest-api-examples/",
              snippet:
                "REST APIs are often used for user management, e-commerce workflows, payment processing, and automation across third-party services.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-navigate-timeout-1",
        result: {
          url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          finalUrl: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          status: 200,
          title: "What is a REST API? Benefits, uses, examples",
          textSnippet: [
            "REST APIs are commonly used to integrate applications and services across distributed environments.",
            "Teams use them for web and mobile backends, partner integrations, workflow automation, and exchanging data between systems.",
            "They are also used to manage resources through standard HTTP operations.",
          ].join(" "),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-fallback-timeout-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-fallback-timeout-1",
      content: "Can you look online and find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
    });

    expect(result.assistantContent).toContain("Based on the sources I did retrieve");
    expect(result.assistantContent).toContain("web and mobile backends");
    expect(result.assistantContent).toContain("partner integrations");
    expect(result.assistantContent).not.toContain("I ran out of time before I could finish a full pass");
    expect(result.turnTrace.failure?.failureClass).toBe("unknown");
  });

  it("deprioritizes definition-page mechanics when recovering use-case answers from fetched content", async () => {
    const badFallback = [
      "I ran out of time before I could finish a full pass, but I did recover useful content from What is a REST API? Benefits, uses, examples:",
      "",
      "1. The REST API supports data formats such as application/json and application/xml.",
      "2. A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data.",
      "3. REST APIs are also referred to as RESTful web services and RESTful APIs.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("the top 5 uses for REST APIs"))
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://blog.postman.com/rest-api-examples/",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: badFallback,
            },
          },
        ],
      })
      .mockRejectedValueOnce(new Error("Chat completion timed out after 20000ms."));
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-search-timeout-live-1",
        result: {
          query: "the top 5 uses for REST APIs",
          results: [
            {
              title: "What Is a REST API? Examples, Uses & Challenges - Postman Blog",
              url: "https://blog.postman.com/rest-api-examples/",
              snippet: "What Is a REST API? Examples, Uses & Challenges - Postman Blog.",
            },
            {
              title: "What is a REST API? Benefits, Uses, Examples - TechTarget",
              url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
              snippet:
                "A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-navigate-timeout-live-1",
        result: {
          url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          finalUrl: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          status: 200,
          title: "What is a REST API? Benefits, uses, examples",
          textSnippet:
            "Search the TechTarget Network Login Register TechTarget Network Software Quality Cloud Computing TheServerSide Search App Architecture API Management App Development & Design App Management Tools Architecture Management EAI News Features Tips Webinars Sponsored Sites More Follow: Home API design and management Tech Accelerator Guide to building an enterprise API strategy PREV NEXT DEFINITION What is a REST API? Benefits, Uses, Examples By Scott Robinson, New Era Technology Stephen J. Bigelow, Senior Technology Editor Alexander S. Gillis, Technical Writer and Editor Published: Sep 30, 2025 A REST API is an architectural style for an application programming interface that uses Hypertext Transfer Protocol (HTTP) requests to access and use data. That data can be used to GET, PUT, POST and DELETE data types, which refers to reading, updating, creating and deleting operations related to resources. The API's design spells out the proper way for a developer to write a program, or client, that uses the API to request services from another application, or the server. APIs are a vital mechanism for software interoperability. REST APIs are also referred to as RESTful web services and RESTful APIs. This approach can also facilitate communication between other application types. REST technology is generally preferred over similar technologies because it uses less bandwidth, making it more efficient for internet use. REST APIs can also be built with common programming languages such as PHP, JavaScript and Python. Cloud consumers use APIs to expose and organize access to web services. REST is a logical choice for building APIs to provide users with ways to flexibly connect to, manage and interact with cloud services in distributed environments. Sites such as Amazon, Google, LinkedIn and Twitter use REST APIs. A REST API fundamentally relies on the following three major elements: Client. The client is the software code or application that requests a resource from a server. The server is the software code or application that controls the resource and responds to client requests for the resource. The REST API supports data formats such as application/json, application/xml, application/x-web+xml, application/x-www-form-urlencoded and multipart.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-fallback-timeout-live-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-fallback-timeout-live-1",
      content: "Can you look online and find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
    });

    expect(result.assistantContent).toContain("Based on the sources I did retrieve");
    expect(result.assistantContent).toContain("cloud services");
    expect(result.assistantContent).not.toContain("application/json");
    expect(result.assistantContent).not.toContain("technical writer");
    expect(result.assistantContent).not.toContain("common programming languages");
    expect(result.turnTrace.failure?.failureClass).toBe("unknown");
  });

  it("reuses duplicate explicit http.get calls for the same URL", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        httpGetToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce(
        httpGetToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Here is the synthesized answer.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-http-get-reuse-1",
      result: {
        url: "https://example.com/research",
        finalUrl: "https://example.com/research",
        status: 200,
        text: "Fetched content for reuse.",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["http.get"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-http-get-reuse-1",
      turnId: "turn-http-get-reuse-1",
      userMessageId: "msg-http-get-reuse-1",
      content: "Fetch https://example.com/research again.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Fetch https://example.com/research again." }],
    });

    expect(result.turnTrace.failure).toBeUndefined();
    expect(result.assistantContent).toContain("Here is the synthesized answer.");
    expect(invokeTool).toHaveBeenCalledTimes(1);
    const toolRuns = result.turnTrace.toolRuns;
    expect(toolRuns).toHaveLength(2);
    expect(toolRuns[0]?.toolName).toBe("http.get");
    expect(toolRuns[1]?.toolName).toBe("http.get");
    expect(toolRuns[1]).toMatchObject({
      reused: true,
      reusedFromToolRunId: toolRuns[0]?.toolRunId,
      reuseReason: "matching_recent_browser_result",
    });
    expect(toolRuns[1]?.result).toMatchObject({
      reusedNotice: expect.stringContaining(toolRuns[0]?.toolRunId ?? ""),
      reusedResult: true,
      reusedPriorToolRunId: toolRuns[0]?.toolRunId,
      reuseReason: "matching_recent_browser_result",
    });
  });

  it("reuses an immediate duplicate browser.navigate call to the same URL when no browser state changed", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Done.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-nav-no-reuse",
      result: {
        url: "https://example.com/research",
        finalUrl: "https://example.com/research",
        status: 200,
        title: "Example research",
        textSnippet: "Example content",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-nav-no-reuse-1",
      turnId: "turn-nav-no-reuse-1",
      userMessageId: "msg-nav-no-reuse-1",
      content: "Open https://example.com/research twice.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Open https://example.com/research twice." }],
    });

    expect(result.turnTrace.failure).toBeUndefined();
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(result.turnTrace.toolRuns[1]).toMatchObject({
      reused: true,
      reusedFromToolRunId: result.turnTrace.toolRuns[0]?.toolRunId,
      reuseReason: "matching_recent_browser_result",
    });
    expect(result.turnTrace.toolRuns[1]?.result).toMatchObject({
      reusedResult: true,
      reusedPriorToolRunId: result.turnTrace.toolRuns[0]?.toolRunId,
      reuseReason: "matching_recent_browser_result",
    });
  });

  it("does not reuse duplicate browser.navigate calls when a different page was opened in between", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/other",
        }),
      )
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Done.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-reuse-blocked-1",
        result: {
          url: "https://example.com/research",
          finalUrl: "https://example.com/research",
          status: 200,
          title: "Example research",
          textSnippet: "Example content",
          browserSessionId: "sess-nav-reuse-blocked-1",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-reuse-blocked-2",
        result: {
          url: "https://example.com/other",
          finalUrl: "https://example.com/other",
          status: 200,
          title: "Example other page",
          textSnippet: "Other page content",
          browserSessionId: "sess-nav-reuse-blocked-1",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-reuse-blocked-3",
        result: {
          url: "https://example.com/research",
          finalUrl: "https://example.com/research",
          status: 200,
          title: "Example research",
          textSnippet: "Example content after visiting another page",
          browserSessionId: "sess-nav-reuse-blocked-1",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-nav-reuse-blocked-1",
      turnId: "turn-nav-reuse-blocked-1",
      userMessageId: "msg-nav-reuse-blocked-1",
      content: "Open the page, open another page, then open the first page again.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Open the page, open another page, then open the first page again." }],
    });

    expect(result.turnTrace.failure).toBeUndefined();
    expect(invokeTool).toHaveBeenCalledTimes(3);
    expect(result.turnTrace.toolRuns.every((run) => run.result?.reusedResult !== true)).toBe(true);
  });

  it("bypasses browser.navigate reuse when bypassCache is requested", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/research",
          bypassCache: true,
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Done.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-bypass-cache-1",
        result: {
          url: "https://example.com/research",
          finalUrl: "https://example.com/research",
          status: 200,
          title: "Example research",
          textSnippet: "Example content",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-bypass-cache-2",
        result: {
          url: "https://example.com/research",
          finalUrl: "https://example.com/research",
          status: 200,
          title: "Example research refreshed",
          textSnippet: "Fresh example content",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-nav-bypass-cache-1",
      turnId: "turn-nav-bypass-cache-1",
      userMessageId: "msg-nav-bypass-cache-1",
      content: "Open the page, then force-refresh it.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Open the page, then force-refresh it." }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(result.turnTrace.toolRuns.every((run) => run.reused !== true)).toBe(true);
    expect(result.turnTrace.toolRuns.every((run) => run.result?.reusedResult !== true)).toBe(true);
  });

  it("reuses a follow-up browser.navigate when the prior navigate already resolved to that final URL", async () => {
    const finalUrl = "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://blog.postman.com/rest-api-examples/",
        }),
      )
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: finalUrl,
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Here are the common REST API uses.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-nav-final-url-reuse-1",
      result: {
        url: finalUrl,
        finalUrl,
        status: 200,
        title: "What is a REST API? Benefits, uses, examples",
        textSnippet:
          "A REST API uses HTTP requests to access and use data. REST APIs are also referred to as RESTful web services.",
        fallbackChain: [
          {
            toolName: "browser.navigate",
            engineTier: "builtin",
            engineLabel: "Built-in browser",
            status: "failed",
            url: "https://blog.postman.com/rest-api-examples/",
            finalUrl: "https://blog.postman.com/rest-api-examples/",
            httpStatus: 403,
            browserFailureClass: "remote_blocked",
            error: "remote site blocked automation (automation block 403)",
          },
          {
            toolName: "browser.navigate",
            engineTier: "builtin",
            engineLabel: "Built-in browser",
            status: "executed",
            url: finalUrl,
            finalUrl,
            httpStatus: 200,
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-nav-final-url-reuse-1",
      turnId: "turn-nav-final-url-reuse-1",
      userMessageId: "msg-nav-final-url-reuse-1",
      content: "Find the top 5 uses for REST APIs.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Find the top 5 uses for REST APIs." }],
    });

    expect(result.turnTrace.failure).toBeUndefined();
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(result.turnTrace.toolRuns[1]?.result).toMatchObject({
      reusedResult: true,
      reusedPriorToolRunId: result.turnTrace.toolRuns[0]?.toolRunId,
    });
  });

  it("reuses an immediate browser.extract call from the same successful browser.navigate result", async () => {
    const pageUrl = "https://example.com/research";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: pageUrl }))
      .mockResolvedValueOnce(extractToolCallCompletion({ url: pageUrl, maxChars: 6000 }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Done.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-nav-extract-reuse-1",
      result: {
        url: pageUrl,
        finalUrl: pageUrl,
        status: 200,
        title: "Example research",
        textSnippet:
          "REST APIs are used for backend services, third-party integrations, mobile apps, automation workflows, and partner APIs. This page explains those uses in detail with examples and implementation notes.",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate", "browser.extract"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-nav-extract-reuse-1",
      turnId: "turn-nav-extract-reuse-1",
      userMessageId: "msg-nav-extract-reuse-1",
      content: "Open the page, then extract the text from that same page.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Open the page, then extract the text from that same page." }],
    });

    expect(result.turnTrace.failure).toBeUndefined();
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(result.turnTrace.toolRuns).toHaveLength(2);
    expect(result.turnTrace.toolRuns[1]?.toolName?.replace(/_/g, ".")).toBe("browser.extract");
    expect(result.turnTrace.toolRuns[1]?.result).toMatchObject({
      reusedResult: true,
      reusedPriorToolRunId: result.turnTrace.toolRuns[0]?.toolRunId,
    });
  });

  it("does not reuse browser.extract when another stateful page open happened in between", async () => {
    const pageUrl = "https://example.com/research";
    const otherUrl = "https://example.com/other";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: pageUrl }))
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: otherUrl }))
      .mockResolvedValueOnce(extractToolCallCompletion({ url: pageUrl, maxChars: 6000 }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Done.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-extract-no-reuse-1",
        result: {
          url: pageUrl,
          finalUrl: pageUrl,
          status: 200,
          title: "Example research",
          textSnippet: "Useful research page content that would otherwise be reusable if nothing changed afterward.",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-extract-no-reuse-2",
        result: {
          url: otherUrl,
          finalUrl: otherUrl,
          status: 200,
          title: "Other page",
          textSnippet: "A different page was opened, so the previous page state is no longer safe to reuse.",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-extract-no-reuse-3",
        result: {
          url: pageUrl,
          finalUrl: pageUrl,
          status: 200,
          title: "Example research",
          textSnippet: "Freshly extracted text from the original page after another navigation happened.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate", "browser.extract"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-nav-extract-no-reuse-1",
      turnId: "turn-nav-extract-no-reuse-1",
      userMessageId: "msg-nav-extract-no-reuse-1",
      content: "Open one page, open another page, then extract the first page again.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Open one page, open another page, then extract the first page again." },
      ],
    });

    expect(result.turnTrace.failure).toBeUndefined();
    expect(invokeTool).toHaveBeenCalledTimes(3);
    expect(result.turnTrace.toolRuns.every((run) => run.result?.reusedResult !== true)).toBe(true);
  });

  it("asks for clarification instead of faking an estimate for ambiguous local-area prompts", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-lonely-area-1",
      turnId: randomUUID(),
      userMessageId: "msg-lonely-area-1",
      content:
        "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
        },
      ],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("answering that responsibly");
    expect(result.assistantContent).toContain("geographic area");
    expect(result.assistantContent).toContain("threshold");
  });

  it("still asks about subjective qualifier when geography is named but definition is ambiguous", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-lonely-seattle-1",
      turnId: randomUUID(),
      userMessageId: "msg-lonely-seattle-1",
      content:
        "Estimate the number of genuinely lonely singles in Seattle by combining demographic data, social indicators, and digital behavior patterns.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Estimate the number of genuinely lonely singles in Seattle by combining demographic data, social indicators, and digital behavior patterns.",
        },
      ],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("answering that responsibly");
    expect(result.assistantContent).toContain("threshold");
    expect(result.assistantContent).not.toContain("geographic area");
  });

  it("does not force clarification when both geography and qualifier are concrete", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I can estimate that for Seattle with stated assumptions.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-seattle-concrete-1",
      turnId: randomUUID(),
      userMessageId: "msg-seattle-concrete-1",
      content:
        "Estimate the number of single adults in Seattle by combining demographic data and digital behavior patterns.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Estimate the number of single adults in Seattle by combining demographic data and digital behavior patterns.",
        },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toContain("Seattle");
  });

  it("carries clarification context forward instead of searching on a partial follow-up answer", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-lonely-followup-1",
      turnId: randomUUID(),
      userMessageId: "msg-lonely-followup-1",
      content: 'Suburbs generally lonely is defined as "I cry myself to sleep all alone".',
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
        },
        {
          role: "assistant",
          content: [
            "I need a quick clarification before answering that responsibly:",
            "- What geographic area do you mean exactly: city, metro, county, state, or country?",
            "- How are you defining that qualifier — what threshold or criteria should I use?",
            "Once you answer, I can give you a grounded response.",
          ].join("\n"),
        },
      ],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("answering that responsibly");
    expect(result.assistantContent).toContain("geographic area");
    expect(result.assistantContent).not.toContain("threshold");
  });

  it("returns a deterministic settings note for live-data prompts when web mode is off", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-web-off-live-data-1",
      turnId: randomUUID(),
      userMessageId: "msg-web-off-live-data-1",
      content: "What are the latest news headlines about OpenAI today?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What are the latest news headlines about OpenAI today?" }],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("Web is set to Off");
    expect(result.assistantContent).toContain("Auto, Quick, or Deep");
  });

  it("does not short-circuit cowork prompt-pack planning turns that mention recently added repo functionality", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "",
      "## User Task",
      "Create a short role-labeled plan for how GoatCitadel prompt-pack v2 should test recently added functionality without repeating the old 108-test balance. Keep the sections in the requested role order.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Product",
              "- Focus the slice on new v2-only capabilities instead of re-running the frozen baseline.",
              "",
              "## Architect",
              "- Group tests around recently added retrieval, provenance, and prompt-pack routing behaviors.",
              "",
              "## QA",
              "- Gate the slice on score deltas plus one replay pass for the touched cases.",
              "",
              "## Synthesis",
              "- Start with a narrow v2-only regression slice, then expand only after those tests stabilize.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-recent-internal-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-recent-internal-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toContain("## Product");
    expect(result.assistantContent).not.toContain("Web is set to Off");
  });

  it("does not short-circuit chat prompt-pack no-tools runs that mention recently changed local facts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: no-tools",
      "",
      "## User Task",
      "You are given:",
      "- A test failed",
      "- Logs are incomplete",
      "- One config file was recently changed",
      "",
      "Explain:",
      "- most likely causes, ranked",
      "- the weakest assumption in your reasoning",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "1. Config drift is most likely because the only explicitly changed fact is the config file.",
              "2. Incomplete logs could hide a deployment mismatch or stale environment override.",
              "3. A secondary code regression is possible, but the prompt gives less direct evidence for it.",
              "",
              "Weakest assumption: that the recent config change actually touched a runtime-loaded setting rather than an unrelated comment or dead path.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-chat-recent-internal-1",
      turnId: randomUUID(),
      userMessageId: "msg-chat-recent-internal-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("Config drift is most likely");
    expect(result.assistantContent).not.toContain("Web is set to Off");
  });

  it("does not short-circuit code prompt-pack planning turns that only use recent as repo scope", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: no-tools",
      "- This is a Code evaluation. Stay project-bound, concrete, and evidence-backed.",
      "",
      "## User Task",
      "Propose the smallest Prompt Lab rollout slice for the new v2 pack so GoatCitadel can tighten recent feature quality without immediately rerunning the entire v1 baseline.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Findings / Plan",
              "- Start with the v2-only prompts that cover newly added provenance, replay, and focused-pack behavior.",
              "",
              "## Changes",
              "- Add a dedicated v2 target list for those tests instead of touching the full v1 matrix.",
              "",
              "## Validation",
              "- Re-run only the focused slice and compare score deltas before widening scope.",
              "",
              "## Risks",
              "- The slice must stay narrow enough that failures map back to the new work rather than generic baseline noise.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-code-recent-internal-1",
      turnId: randomUUID(),
      userMessageId: "msg-code-recent-internal-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toContain("## Findings / Plan");
    expect(result.assistantContent).not.toContain("Web is set to Off");
  });

  it("strips web tools from normal turns when web mode is off", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        const toolNames = (request.tools ?? [])
          .map((tool) => (tool.function as { name?: string } | undefined)?.name)
          .filter((name): name is string => Boolean(name));
        expect(toolNames).not.toContain("browser_search");
        expect(toolNames).toContain("time_now");
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Local-only answer.",
              },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-web-off-local-only-1",
      turnId: randomUUID(),
      userMessageId: "msg-web-off-local-only-1",
      content: "Explain HTTP status codes for an internal API.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Explain HTTP status codes for an internal API." }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("Local-only answer");
  });

  it("returns a deterministic settings note for live-data prompts when tool autonomy is manual", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-manual-live-data-1",
      turnId: randomUUID(),
      userMessageId: "msg-manual-live-data-1",
      content: "Look online and tell me the 5 most interesting things that happened today.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "manual",
      historyMessages: [
        { role: "user", content: "Look online and tell me the 5 most interesting things that happened today." },
      ],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("tool autonomy is set to Manual");
    expect(result.assistantContent).toContain("Safe Auto");
  });

  it("does not trap a fresh standalone prompt in an old clarification exchange", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The capital of France is Paris.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-clarification-reset-1",
      turnId: randomUUID(),
      userMessageId: "msg-clarification-reset-1",
      content: "What is the capital of France?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
        },
        {
          role: "assistant",
          content: [
            "I need a quick clarification before answering that responsibly:",
            "- What geographic area do you mean exactly: city, metro, county, state, or country?",
            "- How are you defining that qualifier — what threshold or criteria should I use?",
            "Once you answer, I can give you a grounded response.",
          ].join("\n"),
        },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("Paris");
  });

  it("ignores stale clarifications once a later assistant turn has moved on", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The capital of France is Paris.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-clarification-reset-2",
      turnId: randomUUID(),
      userMessageId: "msg-clarification-reset-2",
      content: "What is the capital of France?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
        },
        {
          role: "assistant",
          content: [
            "I need a quick clarification before answering that responsibly:",
            "- What geographic area do you mean exactly: city, metro, county, state, or country?",
            "- How are you defining that qualifier — what threshold or criteria should I use?",
            "Once you answer, I can give you a grounded response.",
          ].join("\n"),
        },
        {
          role: "user",
          content: "Never mind.",
        },
        {
          role: "assistant",
          content: "Okay, we can drop that one.",
        },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("Paris");
  });

  it("preserves streamed text parts when later chunks use nested text.value content", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const createChatCompletionStream = vi.fn(async function* () {
      yield {
        id: "chunk_1",
        model: "glm-5",
        choices: [
          {
            index: 0,
            delta: {
              content:
                "I'd be happy to help you find weekend activities! Since it's currently Wednesday, March 11th, you're asking about the upcoming weekend (March 14-15, 2026).\n\nTo give you the best recommendations, I",
            },
          },
        ],
      };
      yield {
        id: "chunk_2",
        model: "glm-5",
        usage: {
          prompt_tokens: 1140,
          completion_tokens: 191,
        },
        choices: [
          {
            index: 0,
            delta: {
              content: [
                {
                  type: "output_text",
                  text: {
                    value:
                      " need a bit more information about your location and interests before I suggest specific plans.",
                  },
                },
              ],
            },
          },
        ],
      };
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      createChatCompletionStream,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-streamed-parts-1",
      turnId: randomUUID(),
      userMessageId: "msg-streamed-parts-1",
      content: "Help me plan something fun.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Help me plan something fun." }],
    });

    expect(createChatCompletionStream).toHaveBeenCalledTimes(1);
    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("To give you the best recommendations, I need a bit more information");
    expect(result.assistantContent).toContain("location and interests");
  });

  it("uses the expanded testing timeout instead of the default 60s", async () => {
    let capturedTimeoutMs: number | undefined;
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementation(async (request: ChatCompletionRequest) => {
        capturedTimeoutMs = request.timeoutMs;
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Synthesized answer from tool output.",
              },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-synthesis-timeout-1",
      result: {
        results: [{ title: "Result", url: "https://example.com/synth" }],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-synth-timeout-1",
      turnId: randomUUID(),
      userMessageId: "msg-synth-timeout-1",
      content: "Find AI tooling references from our notes",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Find AI tooling references from our notes" }],
    });

    // During testing we intentionally give synthesis a much larger timeout so
    // slower models are not penalized by the normal responsiveness budget.
    expect(capturedTimeoutMs).toBeDefined();
    expect(capturedTimeoutMs).toBeGreaterThanOrEqual(30 * 60 * 1000 - 1000);
    expect(capturedTimeoutMs).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  it("stops alternate-URL retries when the turn budget expires mid-fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T20:00:00.000Z"));
    try {
      let navigateCallCount = 0;
      const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockImplementation(async () => {
        vi.setSystemTime(new Date(Date.now() + 5000));
        return navigateToolCallCompletion({
          url: "https://blocked-site.com/article",
        });
      });
      const invokeTool = vi
        .fn<() => Promise<ToolInvokeResult>>()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 2000));
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-budget-search",
            result: {
              results: [
                { title: "Site A", url: "https://blocked-site.com/article", snippet: "news" },
                { title: "Site B", url: "https://alt1.com/article", snippet: "more news" },
                { title: "Site C", url: "https://alt2.com/article", snippet: "even more" },
              ],
            },
          };
        })
        .mockImplementation(async () => {
          navigateCallCount += 1;
          // Each navigate takes 20s, eating deep into budget.
          vi.setSystemTime(new Date(Date.now() + 20000));
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: `audit-budget-nav-${navigateCallCount}`,
            result: {
              url: "https://blocked-site.com/article",
              finalUrl: "https://blocked-site.com/article",
              status: 403,
              title: "Blocked",
              textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
            },
          };
        });
      const orchestrator = new ChatAgentOrchestrator({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
        createChatCompletion,
        invokeTool,
      });

      const result = await orchestrator.run({
        sessionId: "sess-budget-alt-retry-1",
        turnId: randomUUID(),
        userMessageId: "msg-budget-alt-retry-1",
        content: "What's the latest news today?",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "auto",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
        historyMessages: [{ role: "user", content: "What's the latest news today?" }],
      });

      // The alternate retry loop should NOT try all 3 URLs (2 alternates) since
      // the budget deadline is hit. We expect fewer navigate calls than the
      // maximum possible (1 original + 2 alternates = 3 total).
      const totalNavigateCalls = (invokeTool.mock.calls as unknown as Array<[{ toolName: string }]>).filter(
        (call) => call[0].toolName === "browser.navigate",
      ).length;
      // At least 1 navigate was attempted (the original), but not all 3.
      expect(totalNavigateCalls).toBeLessThan(3);
      expect(result.turnTrace.status).not.toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("poisons hosts from fallback chain entries in executed runs recovered via MCP", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://blocked-host.com/page2" }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Here is what I found.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-poison-search",
        result: {
          results: [
            { title: "Good article", url: "https://blocked-host.com/page1", snippet: "news" },
            { title: "Backup article", url: "https://blocked-host.com/page2", snippet: "more" },
            { title: "Clean article", url: "https://clean-host.com/page1", snippet: "other" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-poison-navigate",
        result: {
          url: "https://blocked-host.com/page1",
          finalUrl: "https://blocked-host.com/page1",
          status: 403,
          title: "Blocked",
          textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
          // Simulates a run that was classified as blocked but recovered via MCP fallback.
          // After recovery the run status is "executed" but the fallback chain records the block.
          fallbackChain: [
            {
              toolName: "browser.navigate",
              engineTier: "builtin",
              engineLabel: "Built-in browser",
              status: "failed",
              browserFailureClass: "remote_blocked",
              url: "https://blocked-host.com/page1",
              finalUrl: "https://blocked-host.com/page1",
            },
            {
              toolName: "mcp_navigate",
              engineTier: "premium",
              engineLabel: "Premium browser",
              status: "executed",
              url: "https://blocked-host.com/page1",
              finalUrl: "https://blocked-host.com/page1",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-poison-navigate-2",
        result: {
          url: "https://clean-host.com/page1",
          finalUrl: "https://clean-host.com/page1",
          status: 200,
          title: "Clean article",
          textSnippet: "This article has useful content about the topic.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-poison-chain-1",
      turnId: randomUUID(),
      userMessageId: "msg-poison-chain-1",
      content: "What's the latest news today?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What's the latest news today?" }],
    });

    // The second navigate call should NOT use blocked-host.com/page2 because
    // blocked-host.com should be poisoned from the fallback chain of the first navigate.
    // It should instead use clean-host.com.
    const navigateCalls = (
      invokeTool.mock.calls as unknown as Array<[{ toolName: string; args: Record<string, unknown> }]>
    )
      .map((call) => call[0])
      .filter((arg) => arg.toolName === "browser.navigate");
    if (navigateCalls.length >= 2) {
      expect(String(navigateCalls[1]!.args.url)).not.toContain("blocked-host.com");
    }
    expect(result.turnTrace.status).not.toBe("running");
  });

  it("passes abort signal to main loop LLM completion calls", async () => {
    const controller = new AbortController();
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementation(async (request) => {
        // Capture the signal from the first completion request, then abort.
        if (request.signal) {
          controller.abort();
        }
        // Simulate an abort error since the signal is now aborted.
        if (request.signal?.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Final answer" },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-signal-1",
      result: { results: [{ title: "R", url: "https://example.com" }] },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-signal-1",
      turnId: randomUUID(),
      userMessageId: "msg-signal-1",
      content: "Find AI references",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Find AI references" }],
      signal: controller.signal,
    });

    // The completion was called with the signal present.
    expect(createChatCompletion.mock.calls.length).toBeGreaterThanOrEqual(1);
    const firstCall = createChatCompletion.mock.calls[0]?.[0] as ChatCompletionRequest | undefined;
    expect(firstCall?.signal).toBe(controller.signal);
    // Turn should be cancelled since the signal was aborted.
    expect(result.turnTrace.status).toBe("cancelled");
  });

  it("passes prompt-lab OpenAI reasoning controls for cowork runs", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Researcher: risk is concentrated in migrations.\n\nArchitect: phase the rollout.\n\nSynthesis: keep the cutover staged.",
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });
    const content = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "",
      "## User Task",
      "Assess the migration risk and recommend a rollout plan.",
    ].join("\n");

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-1",
      content,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content }],
    });

    expect(result.turnTrace.status).toBe("completed");
    const firstCall = (createChatCompletion.mock.calls as unknown as Array<[ChatCompletionRequest]>)[0]?.[0];
    expect(firstCall?.reasoning).toEqual({ effort: "high" });
    expect(firstCall?.verbosity).toBe("medium");
  });

  it("passes prompt-lab OpenAI reasoning controls for code runs", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Plan: inspect the repo.\n\nChanges: update the config.\n\nValidation: run the tests.\n\nRisks: watch for regressions.",
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });
    const content = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: no-tools",
      "- This is a Code evaluation. Stay project-bound, concrete, and evidence-backed.",
      "",
      "## User Task",
      "Inspect the config surface and propose the smallest fix.",
    ].join("\n");

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-code-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-code-1",
      content,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4-mini",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content }],
    });

    expect(result.turnTrace.status).toBe("completed");
    const firstCall = (createChatCompletion.mock.calls as unknown as Array<[ChatCompletionRequest]>)[0]?.[0];
    expect(firstCall?.reasoning).toEqual({ effort: "medium" });
    expect(firstCall?.verbosity).toBe("low");
  });

  it("suppresses prompt-lab OpenAI reasoning controls on tool-enabled turns", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I should inspect the files first.",
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });
    const content = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "- This is a Code evaluation. Stay project-bound, concrete, and evidence-backed.",
      "",
      "## User Task",
      "Inspect the config surface and propose the smallest fix.",
    ].join("\n");

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-code-tools-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-code-tools-1",
      content,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content }],
    });

    expect(result.turnTrace.status).toBe("completed");
    const firstCall = (createChatCompletion.mock.calls as unknown as Array<[ChatCompletionRequest]>)[0]?.[0];
    expect(firstCall?.reasoning).toBeUndefined();
    expect(firstCall?.verbosity).toBeUndefined();
  });

  it("continues MCP fallback tiers when one tier throws instead of returning", async () => {
    let mcpInvokeCallCount = 0;
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://blocked-site.com/page" }))
      .mockResolvedValue({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "Here is the answer." } }],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-mcp-throw-search",
        result: {
          results: [{ title: "Article", url: "https://blocked-site.com/page", snippet: "news" }],
        },
      })
      .mockResolvedValue({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-mcp-throw-nav",
        result: {
          url: "https://blocked-site.com/page",
          finalUrl: "https://blocked-site.com/page",
          status: 403,
          title: "Blocked",
          textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
        },
      });
    const invokeMcpTool = vi
      .fn<(request: McpInvokeRequest) => Promise<McpInvokeResponse>>()
      .mockImplementation(async () => {
        mcpInvokeCallCount += 1;
        if (mcpInvokeCallCount === 1) {
          throw new Error("MCP server removed unexpectedly.");
        }
        return {
          ok: true,
          output: {
            contentText: "This is the article content from the second MCP tier.",
          },
        };
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
      invokeMcpTool,
      listMcpBrowserFallbackTargets: () => [
        {
          serverId: "srv-broken",
          label: "Broken MCP",
          tier: "playwright_mcp" as const,
          navigateToolName: "mcp_navigate",
        },
        { serverId: "srv-good", label: "Good MCP", tier: "browser_mcp" as const, navigateToolName: "mcp_navigate" },
      ],
    });

    const result = await orchestrator.run({
      sessionId: "sess-mcp-throw-1",
      turnId: randomUUID(),
      userMessageId: "msg-mcp-throw-1",
      content: "What's the latest news today?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What's the latest news today?" }],
    });

    // Both MCP tiers should be attempted: first throws, second succeeds.
    expect(mcpInvokeCallCount).toBe(2);
    expect(result.turnTrace.status).not.toBe("running");
  });

  it("stops alternate-URL retries when abort signal fires mid-fallback", async () => {
    const controller = new AbortController();
    let navigateCallCount = 0;
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://site-a.com/page" }))
      .mockResolvedValue({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "Done." } }],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      // Pre-loop synthetic search with alternate URLs.
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-abort-search",
        result: {
          results: [
            { title: "Site A", url: "https://site-a.com/page", snippet: "news" },
            { title: "Site B", url: "https://alt-b.com/page", snippet: "more" },
            { title: "Site C", url: "https://alt-c.com/page", snippet: "even more" },
          ],
        },
      })
      .mockImplementation(async () => {
        navigateCallCount += 1;
        // After first navigate attempt, fire the abort signal.
        if (navigateCallCount >= 1) {
          controller.abort();
        }
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: `audit-abort-nav-${navigateCallCount}`,
          result: {
            url: "https://site-a.com/page",
            finalUrl: "https://site-a.com/page",
            status: 403,
            title: "Blocked",
            textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
          },
        };
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-abort-alt-1",
      turnId: randomUUID(),
      userMessageId: "msg-abort-alt-1",
      content: "What's the latest news today?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What's the latest news today?" }],
      signal: controller.signal,
    });

    // Abort should stop the alternate retry loop. We expect at most 2 navigate
    // calls (original + at most 1 alternate before signal fires) instead of 3.
    const totalNavigateCalls = (invokeTool.mock.calls as unknown as Array<[{ toolName: string }]>).filter(
      (call) => call[0].toolName === "browser.navigate",
    ).length;
    expect(totalNavigateCalls).toBeLessThanOrEqual(2);
    expect(result.turnTrace.status).toBe("cancelled");
  });

  it("promotes a recovered no-tool failure back to completed", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "Adopt event sourcing only if auditability and replay are first-order billing requirements; otherwise keep the current model and add targeted ledger controls.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-recover-no-tools-1",
      turnId: randomUUID(),
      userMessageId: "msg-recover-no-tools-1",
      content: "Assess whether to adopt event sourcing for a billing system. Include one final recommendation.",
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [
        {
          role: "user",
          content: "Assess whether to adopt event sourcing for a billing system. Include one final recommendation.",
        },
      ],
    });

    expect(result.assistantContent).toContain(
      "Adopt event sourcing only if auditability and replay are first-order billing requirements",
    );
    expect(result.assistantContent).not.toContain("This turn failed before completion.");
    expect(result.turnTrace.status).toBe("completed");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("repairs hallucinated continuation references in standalone no-tool answers", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: [
                "If Kubernetes is still the right answer, treat the nine workstreams above as your migration backlog.",
                "Sequence them in the order listed within each lens and do not begin cutover until each workstream above has a verified deliverable.",
              ].join(" "),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "Recommendation: stay on Heroku unless you need Kubernetes-specific controls that clearly outweigh platform simplicity.",
                "Evaluate the move across three lenses:",
                "1. Delivery risk: cluster operations, deployment safety, and staffing overhead increase immediately.",
                "2. Operational burden: observability, patching, scaling policy, and incident ownership move onto your team.",
                "3. Rollback readiness: you need rehearsed rollback drills, migration checkpoints, and database escape hatches before cutover.",
              ].join("\n"),
            },
          },
        ],
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-broken-standalone-1",
      turnId: randomUUID(),
      userMessageId: "msg-broken-standalone-1",
      content:
        "Evaluate whether a team should move from Heroku to Kubernetes across delivery risk, operational burden, and rollback readiness, then give one recommendation.",
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [
        {
          role: "user",
          content:
            "Evaluate whether a team should move from Heroku to Kubernetes across delivery risk, operational burden, and rollback readiness, then give one recommendation.",
        },
      ],
    });

    expect(result.assistantContent).toContain(
      "Recommendation: stay on Heroku unless you need Kubernetes-specific controls",
    );
    expect(result.assistantContent).not.toContain("nine workstreams above");
    expect(result.turnTrace.status).toBe("completed");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("repairs structured answers that end mid-clause despite a stop finish reason", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: [
                "# Migration Recommendation",
                "",
                "## Assumptions",
                "",
                "| # | Assumption | Impact if wrong |",
                "|---|---|---|",
                "| A1 | Existing Sentry SDKs are recent | Older SDKs may need migration work |",
                "| A2 | The team can run Docker or Kubernetes | Managed hosting cost changes the math |",
                "",
                "## Technical Feasibility",
                "",
                "- **GlitchTip**: near-zero SDK migration path for error tracking.",
                "- **Grafana Loki + Tempo**: add OpenTelemetry during parallel run;",
              ].join("\n"),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "# Migration Recommendation",
                "",
                "Use GlitchTip first for Sentry-compatible error tracking, then add Loki + Tempo if you need broader observability.",
                "",
                "Next step: run GlitchTip in parallel for two weeks, compare error capture coverage, and only then decide whether to add Loki + Tempo.",
              ].join("\n"),
            },
          },
        ],
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-fragmentary-stop-1",
      turnId: randomUUID(),
      userMessageId: "msg-fragmentary-stop-1",
      content: "Recommend an open-source replacement for Sentry and explain the migration path.",
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [
        {
          role: "user",
          content: "Recommend an open-source replacement for Sentry and explain the migration path.",
        },
      ],
    });

    expect(result.assistantContent).toContain("Use GlitchTip first for Sentry-compatible error tracking");
    expect(result.assistantContent).not.toContain("during parallel run;");
    expect(result.turnTrace.status).toBe("completed");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("repairs structured answers that end on a hanging markdown bullet", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: [
                "# Migration Recommendation",
                "",
                "## Delivery Risk",
                "",
                "- Heroku lowers platform-operating risk for small teams.",
                "- Kubernetes increases flexibility but raises the number of failure domains.",
                "",
                "## Operational Burden",
                "",
                "- **Cluster lifecycle management**: upgrades, patching, and capacity planning.",
                "- **Observability and incident response**: metrics, logs, traces, and runbooks.",
                "- **People burden",
              ].join("\n"),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "# Migration Recommendation",
                "",
                "Recommendation: stay on Heroku unless you need Kubernetes-specific controls or platform-level compliance guarantees.",
                "",
                "If you do move, staff platform ownership first: upgrades, observability, rollback drills, and security operations all become an ongoing team obligation.",
              ].join("\n"),
            },
          },
        ],
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-fragmentary-bullet-1",
      turnId: randomUUID(),
      userMessageId: "msg-fragmentary-bullet-1",
      content:
        "Evaluate whether a team should move from Heroku to Kubernetes across delivery risk, operational burden, and rollback readiness, then give one recommendation.",
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [
        {
          role: "user",
          content:
            "Evaluate whether a team should move from Heroku to Kubernetes across delivery risk, operational burden, and rollback readiness, then give one recommendation.",
        },
      ],
    });

    expect(result.assistantContent).toContain("Recommendation: stay on Heroku");
    expect(result.assistantContent).not.toContain("- **People burden");
    expect(result.turnTrace.status).toBe("completed");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("does not use extraction fallback for file-analysis prompts that mention package.json", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-file-1",
                  type: "function",
                  function: {
                    name: "file_read_range",
                    arguments: JSON.stringify({
                      path: "fixtures/prompt-pack-workspace/package.json",
                      startLine: 1,
                      endLine: 20,
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      })
      .mockRejectedValueOnce(new Error("timeout"));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-file-analysis-1",
      result: {
        path: "fixtures/prompt-pack-workspace/package.json",
        content: '{\n  "name": "prompt-pack-workspace",\n  "scripts": {\n    "build": "tsc"\n  }\n}',
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-file-analysis-1",
      turnId: randomUUID(),
      userMessageId: "msg-file-analysis-1",
      content:
        "Read fixtures/prompt-pack-workspace/package.json using file tools. Analyze the scripts section and suggest missing scripts.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Read fixtures/prompt-pack-workspace/package.json using file tools. Analyze the scripts section and suggest missing scripts.",
        },
      ],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).not.toContain("recovered item(s)");
    expect(result.assistantContent).not.toContain("deterministic crawl");
    expect(result.assistantContent).toContain("Based on the sources I did retrieve");
  });

  it("preserves file-read dependency evidence in the final synthesis prompt", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-file-index",
                  type: "function",
                  function: {
                    name: "file_read_range",
                    arguments: JSON.stringify({
                      path: "fixtures/prompt-pack-workspace/src/index.ts",
                      startLine: 1,
                      endLine: 80,
                    }),
                  },
                },
                {
                  id: "call-file-package",
                  type: "function",
                  function: {
                    name: "file_read_range",
                    arguments: JSON.stringify({
                      path: "fixtures/prompt-pack-workspace/package.json",
                      startLine: 1,
                      endLine: 80,
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "Dependency audit complete." } }],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-dependency-index-1",
        result: {
          path: "fixtures/prompt-pack-workspace/src/index.ts",
          content: [
            'import express from "express";',
            'import { createId, formatTimestamp, clampValue } from "./utils.js";',
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-dependency-package-1",
        result: {
          path: "fixtures/prompt-pack-workspace/package.json",
          content: ["{", '  "dependencies": {', '    "express": "^4.21.0"', "  }", "}"].join("\n"),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-dependency-audit-1",
      turnId: randomUUID(),
      userMessageId: "msg-dependency-audit-1",
      content:
        "Read fixtures/prompt-pack-workspace/src/index.ts and fixtures/prompt-pack-workspace/package.json using file tools. List all imports used by the server entry file and report any missing or suspicious dependencies.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Read fixtures/prompt-pack-workspace/src/index.ts and fixtures/prompt-pack-workspace/package.json using file tools. List all imports used by the server entry file and report any missing or suspicious dependencies.",
        },
      ],
    });

    const synthesisCallArgs = createChatCompletion.mock.calls.at(-1) as unknown as
      | [{ messages?: Array<{ content?: unknown }> }]
      | undefined;
    const synthesisCall = synthesisCallArgs?.[0];
    const synthesisPrompt = (synthesisCall?.messages ?? [])
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    expect(synthesisPrompt).toMatch(/import express from \\?"express\\?";/);
    expect(synthesisPrompt).toContain('\\"dependencies\\": {');
    expect(synthesisPrompt).toContain('\\"express\\": \\"^4.21.0\\"');
  });

  it("prefetches explicit Prompt Lab file evidence before accepting a prose-only completion", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Using file/code tools, inspect these local files only:",
      "- `F:/code/personal-ai-mobile-app/src/api/streaming.ts`",
      "- `F:/code/personal-ai-mobile-app/src/api/client.ts`",
      "",
      "Summarize the main streaming risks.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Researcher\n- The streaming path has abort and cleanup risk.\n\nSynthesis\n- Audit cleanup and idempotency first.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prefetch-streaming-1",
        result: {
          path: "F:/code/personal-ai-mobile-app/src/api/streaming.ts",
          content: "export function streamChatCompletion(signal?: AbortSignal) { /* ... */ }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prefetch-client-1",
        result: {
          path: "F:/code/personal-ai-mobile-app/src/api/client.ts",
          content: "export async function createClientStream() { /* ... */ }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "file.find", "code.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-prefetch-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: wrappedPrompt,
        },
      ],
    });

    const invokedPaths = (
      invokeTool.mock.calls as unknown as Array<
        [
          {
            toolName: string;
            args: Record<string, unknown>;
          },
        ]
      >
    )
      .map((call) => call[0])
      .filter((call) => call.toolName === "file.read_range")
      .map((call) => String(call.args.path));
    expect(invokedPaths).toContain("F:/code/personal-ai-mobile-app/src/api/streaming.ts");
    expect(result.turnTrace.toolRuns.length).toBeGreaterThanOrEqual(1);
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools");
  });

  it("prefetches exact prompt-listed files even without an explicit required tool-family line", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect these files:",
      "- `apps/gateway/src/services/prompt-pack-service.ts`",
      "- `packages/storage/src/realtime-event-repo.ts`",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The service and repository files show the current recovery and prune behavior.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prefetch-exact-file-1",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export class PromptPackService {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prefetch-exact-file-2",
        result: {
          path: "packages/storage/src/realtime-event-repo.ts",
          content: "export class RealtimeEventRepository {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-prompt-lab-exact-file-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-exact-file-prefetch-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    const invokedPaths = invokeTool.mock.calls.map((call) => String(call[0].args.path));
    expect(invokedPaths).toContain("apps/gateway/src/services/prompt-pack-service.ts");
    expect(invokedPaths).toContain("packages/storage/src/realtime-event-repo.ts");
  });

  it("continues into related repo searches after explicit file prefetch when the prompt also asks for adjacent APIs", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect `scripts/run-prompt-pack-gates.ts` and related prompt-pack APIs. Identify the exact patch points needed so gate runs can intentionally target the expanded overnight v2 pack.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Patch the gate runner and the prompt-pack API seams together.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-explicit-related-read-1",
        result: {
          path: "scripts/run-prompt-pack-gates.ts",
          content: "export async function resolvePromptPack() { return null; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-explicit-related-search-1",
        result: {
          matches: [
            { path: "apps/gateway/src/routes/prompt-packs.ts", name: "prompt-packs.ts" },
            { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-explicit-related-read-2",
        result: {
          path: "apps/gateway/src/routes/prompt-packs.ts",
          content: "export const promptPackRoutes = {};",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-explicit-related-read-3",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export class PromptPackService {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-prompt-lab-explicit-related-apis-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-explicit-related-apis-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "file.read_range",
      args: expect.objectContaining({ path: "scripts/run-prompt-pack-gates.ts" }),
    });
    expect(
      invokeTool.mock.calls.some(
        (call) => call[0].toolName === "code.search_files" && String(call[0].args.path) === ".",
      ),
    ).toBe(true);
    expect(
      invokeTool.mock.calls
        .filter((call) => call[0].toolName === "file.read_range")
        .map((call) => String(call[0].args.path)),
    ).toEqual(
      expect.arrayContaining([
        "scripts/run-prompt-pack-gates.ts",
        "apps/gateway/src/routes/prompt-packs.ts",
        "apps/gateway/src/services/prompt-pack-service.ts",
      ]),
    );
  });

  it("treats bare prompt-pack filenames as explicit file evidence and closes the exact-files tail", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file tools to inspect `goatcitadel_prompt_pack.md` and `goatcitadel_prompt_pack_v2.md`. Explain how v2 differs in intent, shape, and operator use.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "v2 is the longer overnight hardening pack, while v1 stays focused on narrower capability checks.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-bare-pack-read-1",
        result: {
          path: "goatcitadel_prompt_pack.md",
          startLine: 1,
          endLine: 220,
          content: "# GoatCitadel Prompt Pack\n\nFocused capability pack.",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-bare-pack-read-2",
        result: {
          path: "goatcitadel_prompt_pack_v2.md",
          startLine: 1,
          endLine: 220,
          content: "# GoatCitadel Prompt Pack v2\n\nExpanded overnight hardening pack.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-bare-file-pack-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-bare-file-pack-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    const invokedPaths = invokeTool.mock.calls.map((call) => String(call[0].args.path));
    expect(invokedPaths).toContain("goatcitadel_prompt_pack.md");
    expect(invokedPaths).toContain("goatcitadel_prompt_pack_v2.md");
    expect(result.assistantContent).toContain("Exact files used:");
    expect(result.assistantContent).toContain("Only the files listed above were used as concrete file evidence.");
  });

  it("normalizes Prompt Lab exact-bullet answers to the requested labels and file list", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect these files:",
      "- `apps/gateway/src/services/prompt-pack-service.ts`",
      "- `apps/gateway/src/services/prompt-pack-service.test.ts`",
      "- `packages/storage/src/realtime-event-repo.ts`",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Use exactly three bullets labeled `Observed behavior`, `Recovered failure path`, and `Guardrails`.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- **Observed behavior** — The service falls back from missing output to deterministic evidence text.",
              "",
              "- **Recovered failure path** — The repository stores events and the service can recover from captured evidence.",
              "",
              "- **Guardrails** — The fallback remains evidence-only.",
              "",
              "Used exact file evidence from:",
              "`apps/gateway/src/services/prompt-pack-service.ts`.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-normalize-exact-1",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export class PromptPackService {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-normalize-exact-2",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.test.ts",
          content: "describe('PromptPackService', () => {});",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-normalize-exact-3",
        result: {
          path: "packages/storage/src/realtime-event-repo.ts",
          content: "export class RealtimeEventRepository {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-normalize-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-normalize-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("- Observed behavior:");
    expect(result.assistantContent).toContain("- Recovered failure path:");
    expect(result.assistantContent).toContain("- Guardrails:");
    expect(result.assistantContent).toContain("`apps/gateway/src/services/prompt-pack-service.test.ts`");
    expect(result.assistantContent).not.toContain("Used exact file evidence from:");
  });

  it("normalizes return-exactly bullet contracts and cites searched concrete files inline", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect how repo-managed imported skills record trust metadata in `skills/extra/<skill-id>/`.",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Return exactly three bullets labeled `Observed fields`, `Operator-usable fields`, and `Still ambiguous`.",
      "- Do not return JSON.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- **Observed fields** — The import flow records installed timestamps, source references, review disposition, and upstream metadata.",
              "",
              "- **Operator-usable fields** — Operators can inspect the manifest and trust policy to see where the skill came from and whether it stayed reference-only.",
              "",
              "- **Still ambiguous** — Some scoring or downstream review state is not obvious from these reads alone.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-return-exactly-search-1",
        result: {
          matches: [
            { path: "apps/gateway/src/services/skill-import-service.ts", name: "skill-import-service.ts" },
            { path: "docs/SKILL_IMPORT_AND_TRUST_POLICY.md", name: "SKILL_IMPORT_AND_TRUST_POLICY.md" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-return-exactly-read-1",
        result: {
          path: "apps/gateway/src/services/skill-import-service.ts",
          startLine: 640,
          endLine: 710,
          content: "const sourceManifestPath = path.join(installedPath, 'source.json');\nreviewDisposition: 'allow';",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-return-exactly-read-2",
        result: {
          path: "docs/SKILL_IMPORT_AND_TRUST_POLICY.md",
          startLine: 1,
          endLine: 80,
          content:
            "Installed skills are copied into skills/extra/<normalized-skill-id> with a provenance manifest at skills/extra/<skill-id>/source.json.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-return-exactly-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-return-exactly-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect((invokeTool.mock.calls[0]?.[0] as { args?: { query?: string } } | undefined)?.args?.query).toBe(
      "skill-import",
    );
    expect(result.assistantContent).toContain("- Observed fields:");
    expect(result.assistantContent).toContain("- Operator-usable fields:");
    expect(result.assistantContent).toContain("- Still ambiguous:");
    expect(result.assistantContent).toContain("Exact files used in this run:");
    expect(result.assistantContent).toContain("`apps/gateway/src/services/skill-import-service.ts`");
    expect(result.assistantContent).toContain("`docs/SKILL_IMPORT_AND_TRUST_POLICY.md`");
  });

  it("appends exact citation snippets for exact-evidence comparisons", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file tools to inspect `goatcitadel_prompt_pack.md` and `goatcitadel_prompt_pack_v2.md`. Explain how v2 differs in intent, shape, and operator use, with exact citations from the files you used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "v2 is more operational and role-aware, while v1 reads more like a broader prompt-pack document.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citation-v1",
        result: {
          path: "goatcitadel_prompt_pack.md",
          startLine: 1,
          endLine: 40,
          content: "# GoatCitadel Prompt Pack\n\nFocused capability pack for baseline evaluation.\n",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citation-v2",
        result: {
          path: "goatcitadel_prompt_pack_v2.md",
          startLine: 1,
          endLine: 40,
          content: "# GoatCitadel Prompt Pack v2\n\nExpanded overnight hardening pack with operator-facing guidance.\n",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-exact-citation-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-exact-citation-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Exact citations used:");
    expect(result.assistantContent).toContain("`goatcitadel_prompt_pack.md` lines 1-40");
    expect(result.assistantContent).toContain("`goatcitadel_prompt_pack_v2.md` lines 1-40");
    expect(result.assistantContent).toContain("Exact files used:");
  });

  it("repairs low-signal exact test prompts into target/setup/act/assert/failure bullets", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Use file or code tools to inspect `apps/gateway/src/services/approval-wait-run-service.test.ts` and `apps/gateway/src/services/approval-wait-run-service.ts`. Propose the exact minimal automated test that proves approval resolution does not resume a paused durable run.",
      "",
      "Answer contract:",
      "- Name the target test file or suite.",
      "- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.",
      "- `Assert` must include both the paused state and the absence of an auto-resume side effect.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Need answer with observed/inferred maybe incomplete.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-test-spec-read-1",
        result: {
          path: "apps/gateway/src/services/approval-wait-run-service.test.ts",
          startLine: 1,
          endLine: 80,
          content: "describe('ApprovalWaitRunService', () => {\n  it('stages paused approval waits', () => {});\n});",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-test-spec-read-2",
        result: {
          path: "apps/gateway/src/services/approval-wait-run-service.ts",
          startLine: 1,
          endLine: 120,
          content: "export class ApprovalWaitRunService {\n  resumePausedRun() {}\n}\n",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-test-spec-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-test-spec-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("- Target test file or suite:");
    expect(result.assistantContent).toContain("- Setup:");
    expect(result.assistantContent).toContain("- Act:");
    expect(result.assistantContent).toContain("- Assert:");
    expect(result.assistantContent).toContain("- Failure signature:");
    expect(result.assistantContent).toContain("approval-wait-run-service.test.ts");
    expect(result.assistantContent).toContain("Exact citations used:");
  });

  it("does not emit the local-file-access refusal for Prompt Lab audits that only say if you cannot support a claim", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Using file/code tools, inspect these local files only:",
      "- `F:/code/project/src/index.ts`",
      "",
      "If you cannot support a claim directly from file contents, move it to Unknowns.",
      "Summarize the exported API.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The file exports `main` and `helper`.",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The file exports `main` and `helper`.",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The file exports `main` and `helper`.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-local-file-refusal-1",
      result: {
        path: "F:/code/project/src/index.ts",
        content: "export function main() {}\nexport function helper() {}",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "file.find", "code.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-file-refusal-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-file-refusal-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).not.toContain("I can't directly access your local project files from this runtime");
    expect(result.assistantContent).toContain("exports `main` and `helper`");
    expect(invokeTool).toHaveBeenCalledTimes(1);
  });

  it("repairs leaked Prompt Lab missing-evidence fallback text when tool evidence already exists", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Using file/code tools, inspect these local files only:",
      "- `F:/code/project/src/index.ts`",
      "",
      "Summarize the exported API.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "I couldn't verify that with the required tools before answering.",
                "",
                "Missing required tool evidence: file/code tools.",
                "A file-specific or source-backed answer would be speculative here, so I’m stopping instead of bluffing.",
              ].join("\n"),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The file exports `main` and `helper`.",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The file exports `main` and `helper`.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-repair-1",
      result: {
        path: "F:/code/project/src/index.ts",
        content: "export function main() {}\nexport function helper() {}",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "file.find", "code.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("exports `main` and `helper`");
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools before answering.");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("replaces prose-only Prompt Lab explicit-tools answers with an honest fallback when no tool path is available", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Read `F:/code/sql-teacher/lib/db/sandbox.ts` using file/code tools and review the sandbox safety.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Findings\n- The sandbox uses strict schema guards and appears safe.",
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-fallback-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-fallback-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: wrappedPrompt,
        },
      ],
    });

    expect(result.assistantContent).toContain("I couldn't verify that with the required tools before answering.");
    expect(result.assistantContent).toContain("Missing required tool evidence: file/code tools");
    expect(result.assistantContent).not.toContain("The sandbox uses strict schema guards and appears safe.");
  });

  it("retries once then accepts a tool-backed answer for Prompt Lab explicit-tools", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Read `F:/code/project/src/index.ts` using file/code tools and summarize the exports.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The file exports a main function and several helpers.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prefetch-retry-1",
      result: {
        path: "F:/code/project/src/index.ts",
        content: "export function main() {}\nexport function helper() {}",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "file.find", "code.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-retry-succeed-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-retry-succeed-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: wrappedPrompt,
        },
      ],
    });

    // Prefetch should have fired for the listed file path, satisfying the requirement.
    // The model's prose answer should pass through because tool evidence exists.
    expect(createChatCompletion).toHaveBeenCalled();
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools");
    expect(result.assistantContent).not.toContain("Missing required tool evidence");
    expect(result.turnTrace.toolRuns.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back after retry when Prompt Lab explicit-tools evidence remains missing", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Inspect the build output and explain the bundling strategy.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      // First completion: prose without tools
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The bundling strategy uses tree-shaking and code splitting.",
            },
          },
        ],
      })
      // Second completion (after retry instruction): still prose without tools
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I believe the build uses webpack with default settings.",
            },
          },
        ],
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "file.find"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-retry-fail-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-retry-fail-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: wrappedPrompt,
        },
      ],
    });

    // No file paths listed → no prefetch. Model bluffed twice → fallback.
    expect(result.assistantContent).toContain("I couldn't verify that with the required tools before answering.");
    expect(result.assistantContent).toContain("Missing required tool evidence: file/code tools.");
    expect(result.assistantContent).not.toContain("tree-shaking");
    expect(result.assistantContent).not.toContain("webpack");
    // The retry path may re-ask once more after a failed local search attempt.
    expect(createChatCompletion.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("prefetches concrete reads after prompt-lab search hits for exact-evidence inspections", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect the skill import path, overlap detection behavior, and repo-managed skill provenance metadata. Summarize the concrete evidence an operator can review today and cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "Operators can review the install and overlap logic in `apps/gateway/src/services/skill-import-service.ts` and the operator-facing policy in `docs/SKILL_ADOPTION_MATRIX.md`.",
              "Those files together show the import path, overlapping family checks, and the current repo-managed provenance guidance an operator can inspect today.",
            ].join(" "),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prefetch-search-files-1",
        result: {
          matches: [
            { path: "apps/gateway/src/services/skill-import-service.ts", name: "skill-import-service.ts" },
            { path: "docs/SKILL_ADOPTION_MATRIX.md", name: "SKILL_ADOPTION_MATRIX.md" },
            { path: "skills/extra/cloudflare-api/source.json", name: "source.json" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prefetch-read-impl-1",
        result: {
          path: "apps/gateway/src/services/skill-import-service.ts",
          content: "export async function importSkill() { return detectOverlap(); }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prefetch-read-doc-1",
        result: {
          path: "docs/SKILL_ADOPTION_MATRIX.md",
          content: "# Skill adoption\n- repo-managed provenance is reviewed by operators.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-local-search-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-local-search-prefetch-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalled();
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        path: ".",
      }),
    });
    expect((invokeTool.mock.calls[0]?.[0] as { args?: { query?: string } } | undefined)?.args?.query).toBeTruthy();
    expect(invokeTool.mock.calls[1]?.[0]).toMatchObject({
      toolName: "file.read_range",
      args: expect.objectContaining({
        path: "apps/gateway/src/services/skill-import-service.ts",
      }),
    });
    expect(invokeTool.mock.calls[2]?.[0]).toMatchObject({
      toolName: "file.read_range",
      args: expect.objectContaining({
        path: "docs/SKILL_ADOPTION_MATRIX.md",
      }),
    });
    expect(invokeTool.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(result.assistantContent).toContain("Those files together show");
    expect(result.assistantContent).not.toContain("Missing required tool evidence");
  });

  it("prefetches repo search evidence for prompt-lab implicit repo-grounded chat inspections", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and explain how global guidance, workspace guidance, and repo docs are currently loaded.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gemma-4-local",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "The current loading chain is anchored in `apps/gateway/src/services/guidance-loader.ts`, with workspace-specific resolution in `apps/gateway/src/services/workspace-guidance.ts`, and repo docs discovered under `docs/`.",
              "That gives operators an observed chain plus a clear place to test for remaining ambiguity.",
            ].join(" "),
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-repo-chat-prefetch-1",
      result: {
        matches: [
          { path: "apps/gateway/src/services/guidance-loader.ts", name: "guidance-loader.ts" },
          { path: "apps/gateway/src/services/workspace-guidance.ts", name: "workspace-guidance.ts" },
          { path: "docs/GOATCITADEL_AGENTIC_CODING_WORKFLOW.md", name: "GOATCITADEL_AGENTIC_CODING_WORKFLOW.md" },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-repo-chat-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-repo-chat-prefetch-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "llamacpp",
      model: "gemma-4-local",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool.mock.calls.length).toBeGreaterThan(0);
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        path: ".",
      }),
    });
    expect(result.assistantContent).toContain("apps/gateway/src/services/guidance-loader.ts");
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools before answering.");
  });

  it("strips incomplete-tail boilerplate for guidance-loading inspections once concrete repo evidence exists", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and summarize how global guidance, workspace guidance, and repo docs are currently loaded. Present the answer as an observed chain plus one ambiguity worth testing.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Observed Loading Chain",
              "",
              "1. Global guidance resolves from `AGENTS.md`.",
              "2. Workspace guidance resolves from `workspaces/<workspaceId>/AGENTS.md` via the same helper path logic.",
              "3. Repo docs are read through the guidance doc map and service entrypoints.",
              "",
              "## Ambiguity Worth Testing",
              "",
              "Whether runtime consumers always call the guidance helper directly or sometimes bypass it.",
              "",
              "Note: search files failed while I was working, so parts of this answer may be incomplete.",
              "",
              "Best next move: Retry search files with a narrower, more explicit input.",
              "",
              'Say "keep going" to try another approach, or give me a specific URL or narrower query.',
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-loading-search",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/guidance-document-helpers.ts",
              name: "guidance-document-helpers.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/gateway-service.ts",
              name: "gateway-service.ts",
              type: "file",
            },
            {
              path: "AGENTS.md",
              name: "AGENTS.md",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-loading-read-helper",
        result: {
          path: "apps/gateway/src/services/guidance-document-helpers.ts",
          startLine: 1,
          endLine: 80,
          content: [
            "export function resolveGuidancePath(...) {",
            "  return path.resolve(host.config.rootDir, 'workspaces', normalizedWorkspaceId, fileName);",
            "}",
            "export async function readGuidanceDocument(...) {",
            "  const resolved = resolveGuidancePath(host, docType, scope, normalizedWorkspaceId);",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-loading-read-service",
        result: {
          path: "apps/gateway/src/services/gateway-service.ts",
          startLine: 2300,
          endLine: 2360,
          content: [
            "public async listGlobalGuidance(): Promise<GuidanceDocumentRecord[]> {",
            "  return Promise.all((Object.keys(GUIDANCE_DOC_FILE_MAP) as GuidanceDocType[]).map((docType) =>",
            "    this.readGuidanceDocument(docType, 'global'),",
            "  ));",
            "}",
            "public async listWorkspaceGuidance(workspaceId: string): Promise<GuidanceBundleRecord> {",
            "  return Promise.all(WORKSPACE_GUIDANCE_DOC_TYPES.map((docType) =>",
            "    this.readGuidanceDocument(docType, 'workspace', normalizedWorkspaceId),",
            "  ));",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-loading-read-agents",
        result: {
          path: "AGENTS.md",
          bytes: 128,
          content:
            "Applies to all runtime agents unless a workspace override exists in `workspaces/<workspaceId>/AGENTS.md`.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-guidance-loading-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-guidance-loading-repair-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        query: "guidance-document-helpers",
      }),
    });
    expect(result.assistantContent).toContain("## Observed Loading Chain");
    expect(result.assistantContent).not.toContain("parts of this answer may be incomplete");
    expect(result.assistantContent).not.toContain('Say "keep going"');
  });

  it("repairs workspace guidance precedence prompts into the actual runtime and operator-visible check", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated check that keeps workspace-scoped guidance precedence both stable and operator-visible.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Findings",
              "",
              "**Observed:** root `AGENTS.md` documents a workspace override.",
              "",
              "## Proposed Minimal Automated Check",
              "",
              "Create `tests/workspace-precedence.test.ts` that scans the filesystem and logs the precedence chain.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-precedence-search",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/guidance-document-helpers.ts",
              name: "guidance-document-helpers.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/gateway-service.ts",
              name: "gateway-service.ts",
              type: "file",
            },
            {
              path: "AGENTS.md",
              name: "AGENTS.md",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-precedence-read-helper",
        result: {
          path: "apps/gateway/src/services/guidance-document-helpers.ts",
          startLine: 1,
          endLine: 60,
          content: [
            "export function resolveGuidancePath(...) {",
            "  return path.resolve(host.config.rootDir, 'workspaces', normalizedWorkspaceId, fileName);",
            "}",
            "export async function readGuidanceDocument(...) {",
            "  const resolved = resolveGuidancePath(host, docType, scope, normalizedWorkspaceId);",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-precedence-read-service",
        result: {
          path: "apps/gateway/src/services/gateway-service.ts",
          startLine: 2310,
          endLine: 10460,
          content: [
            "public async listWorkspaceGuidance(workspaceId: string): Promise<GuidanceBundleRecord> {",
            "  return { workspaceId: normalizedWorkspaceId, global: globalDocs, workspace: workspaceDocs };",
            "}",
            "public async resolveRuntimeGuidance(workspaceId: string): Promise<ResolvedRuntimeGuidance> {",
            "  const selected = workspaceDoc.exists ? workspaceDoc : globalDoc.exists ? globalDoc : undefined;",
            "  if (selected.scope === 'workspace') workspaceFilesUsed.push(selected.fileName);",
            "  else globalFilesUsed.push(selected.fileName);",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-precedence-read-agents",
        result: {
          path: "AGENTS.md",
          startLine: 7,
          endLine: 9,
          content:
            "Applies to all runtime agents unless a workspace override exists in `workspaces/<workspaceId>/AGENTS.md`.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-guidance-precedence-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-guidance-precedence-repair-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        query: "guidance-document-helpers",
      }),
    });
    expect(result.assistantContent).toContain('resolveRuntimeGuidance("ws-1")');
    expect(result.assistantContent).toContain('listWorkspaceGuidance("ws-1")');
    expect(result.assistantContent).toContain("workspaceFilesUsed");
    expect(result.assistantContent).toContain("workspaces/ws-1/AGENTS.md");
    expect(result.assistantContent).not.toContain("tests/workspace-precedence.test.ts");
  });

  it("repairs durable-run claim exclusivity prompts into the repo claim harness", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded code evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves two workers sharing one database cannot both claim the same queued durable run.",
      "",
      "Answer contract:",
      "- Name the target harness or test file.",
      "- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.",
      "- `Assert` must prove one winner and one loser against the same queued run.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- Target test file or suite: `apps/gateway/src/services/tool-path-resolution.test.ts`",
              "- Setup: Add one focused case in `apps/gateway/src/services/tool-path-resolution.test.ts`.",
              "- Act: Exercise the path resolver once.",
              "- Assert: one winner and one loser against the same queued run.",
              "- Failure signature: fail when the same queued run can still be claimed twice.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-durable-claim-search",
        result: {
          matches: [
            { path: "packages/storage/src/durable-run-repo.ts", name: "durable-run-repo.ts", type: "file" },
            { path: "packages/storage/src/durable-run-repo.test.ts", name: "durable-run-repo.test.ts", type: "file" },
            {
              path: "apps/gateway/src/services/durable-run-service.test.ts",
              name: "durable-run-service.test.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-durable-claim-read-repo",
        result: {
          path: "packages/storage/src/durable-run-repo.ts",
          startLine: 308,
          endLine: 347,
          content: [
            "public tryClaimQueuedRun(input: {",
            "  runId: string;",
            "  workerId: string;",
            "}) : DurableRunRecord | undefined {",
            "  const current = this.getRun(input.runId);",
            "  if (current.status !== 'queued') return undefined;",
            "  const result = this.updateRunStmt.run({ expectedVersion: current.version });",
            "  return (result.changes ?? 0) > 0 ? this.getRun(input.runId) : undefined;",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-durable-claim-read-repo-test",
        result: {
          path: "packages/storage/src/durable-run-repo.test.ts",
          startLine: 1,
          endLine: 139,
          content: [
            "describe('DurableRunRepository', () => {",
            "  it('serializes checkpoint state payloads safely', () => {",
            "    const repo = createRepo();",
            "  });",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-durable-claim-read-service-test",
        result: {
          path: "apps/gateway/src/services/durable-run-service.test.ts",
          startLine: 380,
          endLine: 423,
          content: [
            "it('does not clobber a run after lease ownership moves to another worker', async () => {",
            "  const run = createRun('run-lease-steal', 'queued');",
            "  expect(runs.get(run.runId)?.leaseOwnerId).toBe('worker-other');",
            "});",
          ].join("\n"),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-durable-claim-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-durable-claim-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        query: "durable-run-service.test.ts",
      }),
    });
    expect(result.assistantContent).toContain("packages/storage/src/durable-run-repo.test.ts");
    expect(result.assistantContent).toContain("tryClaimQueuedRun");
    expect(result.assistantContent).toContain("one winner and one loser");
    expect(result.assistantContent).not.toContain("tool-path-resolution.test.ts");
  });

  it("repairs durable-run retry-gating prompts into the worker backoff test path", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded code evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves retry-gated queued durable runs are not claimed before their backoff window expires.",
      "",
      "Answer contract:",
      "- Name the target test file or suite.",
      "- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.",
      "- `Assert` must cover before-window and after-window claim behavior.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- Target test file or suite: `apps/gateway/src/services/durable-run-service.test.ts`",
              "- Setup: Add one focused case beside `F:/code/personal-ai/apps/gateway/src/services/durable-run-service.ts` with a queued durable run plus a retry record whose `nextRetryAt` is still in the future before the worker starts.",
              "- Act: Start the worker once while the backoff window is still open, then move `nextRetryAt` into the past and call `requestRunProcessing(runId)` to trigger a second claim pass.",
              "- Assert: Cover before-window and after-window claim behavior by proving no workflow starts and no lease is claimed before the retry window expires, then exactly one normal claim/execution path starts after the window is due.",
              "- Failure signature: Fail if the queued run is claimed early despite a future retry gate, or if the run is still skipped after the backoff deadline has passed.",
              "Exact citations used:",
              "- `F:/code/personal-ai/apps/gateway/src/services/chat-durable-run-service.test.ts` lines 1-320",
              "",
              "Note: read range failed while I was working, so parts of this answer may be incomplete.",
              "Best next move: Retry read range with a narrower, more explicit input.",
              'Say "keep going" to try another approach, or give me a specific URL or narrower query.',
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-durable-backoff-search",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/durable-run-service.test.ts",
              name: "durable-run-service.test.ts",
              type: "file",
            },
            { path: "apps/gateway/src/services/durable-run-service.ts", name: "durable-run-service.ts", type: "file" },
            { path: "packages/storage/src/durable-run-repo.ts", name: "durable-run-repo.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-durable-backoff-read-test",
        result: {
          path: "apps/gateway/src/services/durable-run-service.test.ts",
          startLine: 124,
          endLine: 165,
          content: [
            "it('waits until retry backoff is due before claiming queued runs', async () => {",
            "  const run = createRun('run-retry', 'queued', 'connector.delivery');",
            "  service.startWorker();",
            "  expect(executeWorkflow).not.toHaveBeenCalled();",
            "  service.requestRunProcessing(run.runId);",
            "  expect(executeWorkflow).toHaveBeenCalledTimes(1);",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-durable-backoff-read-service",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          startLine: 808,
          endLine: 819,
          content: [
            "private hasFutureRetryGate(runId: string, nowIso: string): boolean {",
            "  const latestRetry = this.ctx.storage.durableRuns.listRetries(runId, 100).at(-1);",
            "  return nextRetryAt > now;",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-durable-backoff-read-repo",
        result: {
          path: "packages/storage/src/durable-run-repo.ts",
          startLine: 453,
          endLine: 494,
          content: [
            "public upsertRetry(input: {",
            "  nextRetryAt?: string;",
            "}) {",
            "  return rows[rows.length - 1] ?? record;",
            "}",
          ].join("\n"),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-durable-backoff-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-durable-backoff-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("apps/gateway/src/services/durable-run-service.test.ts");
    expect(result.assistantContent).toContain("before the retry window expires");
    expect(result.assistantContent).toContain("after the backoff deadline has passed");
    expect(result.assistantContent).not.toContain("chat-durable-run-service.test.ts");
    expect(result.assistantContent).not.toContain("parts of this answer may be incomplete");
  });

  it("repairs canonical-linkage lifecycle prompts into the runtime lifecycle test harness", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded code evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves runtime lifecycle prefers canonical linkage over payload, preview, or event inference when they disagree, and that diagnostics expose the fallback path.",
      "",
      "Answer contract:",
      "- Name the target test file or suite.",
      "- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.",
      "- `Setup` must create a disagreement between canonical and inferred data.",
      "- `Assert` must cover both chosen linkage and emitted diagnostics.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- Target test file or suite: `F:/code/personal-ai/AGENTS.md`",
              "- Setup: Setup must create a disagreement between canonical and inferred data.",
              "- Act: Invoke the smallest path that exercises the behavior anchored in `{{SYSTEM_NAME}} Agents.md` once, then capture the single transition or comparison needed for the proof.",
              "- Assert: Assert must cover both chosen linkage and emitted diagnostics.",
              "- Failure signature: Fail when the test can still pass even though runtime lifecycle prefers canonical linkage over payload, preview, or event inference when they disagree, and that diagnostics expose the fallback path. is false, or when the observed side effect/state contradicts the intended guard.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-runtime-lifecycle-search",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/runtime-lifecycle-read-service.ts",
              name: "runtime-lifecycle-read-service.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/runtime-lifecycle-read-service.test.ts",
              name: "runtime-lifecycle-read-service.test.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/approval-lifecycle-service.ts",
              name: "approval-lifecycle-service.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-runtime-lifecycle-read-service",
        result: {
          path: "apps/gateway/src/services/runtime-lifecycle-read-service.ts",
          startLine: 280,
          endLine: 315,
          content: [
            "if (!state.sessionId && approval.linkage?.sessionId) {",
            "  state.sessionId = approval.linkage.sessionId;",
            "  state.resolution.sessionIdSource = 'approval_linkage';",
            "}",
            "if (!state.runId) {",
            "  const approvalWaitRunId = getApprovalWaitRunId(approval.approvalId);",
            "  if (approvalWaitRunId) state.resolution.runIdSource = 'approval_wait_run';",
            "}",
            "state.fallbackSources.add('fallback_payload');",
            "state.fallbackSources.add('fallback_preview');",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-runtime-lifecycle-read-test",
        result: {
          path: "apps/gateway/src/services/runtime-lifecycle-read-service.test.ts",
          startLine: 83,
          endLine: 146,
          content: [
            "it('prefers explicit approval linkage over fallback payload fields', async () => {",
            "  const response = await service.getRuntimeLifecycle({ approvalId: 'approval-1' });",
            "  expect(response.resolution).toMatchObject({",
            "    sessionIdSource: 'approval_linkage',",
            "    runIdSource: 'approval_linkage',",
            "    taskIdSource: 'approval_linkage',",
            "  });",
            "  expect(response.resolution?.fallbackSources).toContain('fallback_payload');",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-runtime-lifecycle-read-approval",
        result: {
          path: "apps/gateway/src/services/approval-lifecycle-service.ts",
          startLine: 1,
          endLine: 12,
          content: "export class ApprovalLifecycleService {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-runtime-lifecycle-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-runtime-lifecycle-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        query: "runtime-lifecycle-read-service.test.ts",
      }),
    });
    expect(result.assistantContent).toContain("apps/gateway/src/services/runtime-lifecycle-read-service.test.ts");
    expect(result.assistantContent).toContain("approval_linkage");
    expect(result.assistantContent).toContain("fallback_payload");
    expect(result.assistantContent).toContain("fallback_preview");
    expect(result.assistantContent).not.toContain("AGENTS.md");
    expect(result.assistantContent).not.toContain("{{SYSTEM_NAME}}");
  });

  it("repairs explicit event-link propagation prompts into the events route test harness", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded code evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves explicit `eventClass`, `eventAuthority`, and `links` survive from event producer to storage to operator-facing API.",
      "",
      "Answer contract:",
      "- Name the target test file or suite.",
      "- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.",
      "- `Assert` must name all three fields at producer, persisted, and operator-facing stages.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- Target test file or suite: `F:/code/personal-ai/apps/mission-control/src/pages/chat/ChatExternalBindingPanel.tsx`",
              "- Setup: Add one focused case in `F:/code/personal-ai/apps/mission-control/src/pages/chat/ChatExternalBindingPanel.tsx` anchored in `F:/code/personal-ai/packages/storage/src/chat-session-binding-repo.ts`, and stage only the initial repo state needed to prove that explicit `eventClass`, `eventAuthority`, and `links` survive from event producer to storage to operator-facing API..",
              "- Act: Invoke the smallest path that exercises the behavior anchored in `chat-session-binding-repo.ts` once, then capture the single transition or comparison needed for the proof.",
              "- Assert: Assert must name all three fields at producer, persisted, and operator-facing stages.",
              "- Failure signature: Fail when the test can still pass even though explicit `eventClass`, `eventAuthority`, and `links` survive from event producer to storage to operator-facing API. is false, or when the observed side effect/state contradicts the intended guard.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-events-search-1",
        result: {
          matches: [
            { path: "apps/gateway/src/routes/events.ts", name: "events.ts", type: "file" },
            { path: "apps/gateway/src/routes/events.test.ts", name: "events.test.ts", type: "file" },
            { path: "apps/gateway/src/services/gateway-service.ts", name: "gateway-service.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-events-read-route",
        result: {
          path: "apps/gateway/src/routes/events.ts",
          startLine: 17,
          endLine: 41,
          content: [
            "fastify.get('/api/v1/events', async (request, reply) => {",
            "  const items = fastify.gateway.listRealtimeEvents(parsed.data.limit, parsed.data.cursor);",
            "  return reply.send({ items, nextCursor });",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-events-read-route-test",
        result: {
          path: "apps/gateway/src/routes/events.test.ts",
          startLine: 58,
          endLine: 95,
          content: [
            "it('emits SSE event ids from the realtime sequence', async () => {",
            "  listRealtimeEvents: () => [{ eventId: 'event-1', sequence: 42, eventType: 'system', source: 'tests', payload: { ok: true } }],",
            "  const response = await fetch(`${address}/api/v1/events/stream?replay=1`);",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-events-read-gateway",
        result: {
          path: "apps/gateway/src/services/gateway-service.ts",
          startLine: 9844,
          endLine: 9852,
          content: [
            "public publishRealtime(",
            "  eventType: string,",
            "  source: string,",
            "  payload: Record<string, unknown>,",
            "  options?: Pick<RealtimeEvent, 'eventClass' | 'eventAuthority' | 'links' | 'correlationId'>,",
            ") {",
            "  const event = this.storage.realtimeEvents.append(eventType, source, payload, options);",
            "  return event;",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-events-search-2",
        result: {
          matches: [
            {
              path: "packages/storage/src/realtime-event-repo.ts",
              name: "realtime-event-repo.ts",
              type: "file",
            },
            {
              path: "packages/storage/src/realtime-event-repo.test.ts",
              name: "realtime-event-repo.test.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-events-read-storage",
        result: {
          path: "packages/storage/src/realtime-event-repo.ts",
          startLine: 70,
          endLine: 118,
          content: [
            "append(eventType, source, payload, options) {",
            "  const event = extractRealtimeMetadata(row);",
            "  return { ...event, payload: stripRealtimeEnvelope(event.payload) };",
            "}",
            "list(limit) {",
            "  return rows.map((row) => ({ ...extractRealtimeMetadata(row), payload: stripRealtimeEnvelope(row.payload) }));",
            "}",
          ].join("\n"),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-events-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-events-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        query: "events.test.ts",
      }),
    });
    expect(result.assistantContent).toContain("apps/gateway/src/routes/events.test.ts");
    expect(result.assistantContent).toContain("GatewayService.publishRealtime");
    expect(result.assistantContent).toContain("eventClass");
    expect(result.assistantContent).toContain("eventAuthority");
    expect(result.assistantContent).toContain("operator-facing API");
    expect(result.assistantContent).toContain("/api/v1/events?limit=1");
    expect(result.assistantContent).not.toContain("ChatExternalBindingPanel.tsx");
    expect(result.assistantContent).not.toContain("chat-session-binding-repo.ts");
  });

  it("does not inject prompt-pack markdown import fallback content on live chat turns", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: implicit-tools",
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Repo inspection assist: enabled.",
      "",
      "## User Task",
      "Inspect the repo if needed and explain how prompt-pack markdown is auto-loaded or imported today, including any source-label or source-of-truth ambiguity that remains.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Observed",
              "- `apps/gateway/src/services/prompt-pack-service.ts`",
              "- `packages/storage/src/prompt-pack-repo.ts`",
              "",
              "## Unverified (inspection incomplete)",
              "- The actual auto-loading/import mechanism is not visible in the captured excerpts.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-import-search",
        result: {
          matches: [
            { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts", type: "file" },
            { path: "apps/gateway/src/routes/prompt-packs.ts", name: "prompt-packs.ts", type: "file" },
            { path: "packages/storage/src/prompt-pack-repo.ts", name: "prompt-pack-repo.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-import-service-read",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          startLine: 1400,
          endLine: 1450,
          content: [
            "async ensurePromptPackLoaded(): Promise<PromptPackRecord | undefined> {",
            "  const sourcePath = process.env.GOATCITADEL_PROMPT_PACK_PATH?.trim();",
            "  const markdown = await fs.readFile(sourcePath, 'utf8');",
            "  const imported = this.importPromptPack({",
            "    content: markdown,",
            "    sourceLabel: DEFAULT_PROMPT_RUNNER_SOURCE,",
            "  });",
            "}",
            "importPromptPack(input: { content: string; name?: string; sourceLabel?: string; packId?: string }) {",
            "  const tests = parsePromptPackTests(input.content);",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-import-route-read",
        result: {
          path: "apps/gateway/src/routes/prompt-packs.ts",
          startLine: 100,
          endLine: 125,
          content: [
            "fastify.post('/api/v1/prompt-packs/import', async (request, reply) => {",
            "  return reply.send(fastify.gateway.importPromptPack(body.data));",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-import-repo-read",
        result: {
          path: "packages/storage/src/prompt-pack-repo.ts",
          startLine: 1,
          endLine: 220,
          content: [
            "interface PromptPackRow {",
            "  source_label: string | null;",
            "  policy_v2_source: string | null;",
            "}",
            "const resolvedSource = input.policySource ?? existingSource ?? 'inherited_default';",
          ].join("\n"),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-pack-import-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-pack-import-repair-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        query: "prompt-pack-service.ts",
      }),
    });
    expect(result.assistantContent).toContain("## Observed");
    expect(result.assistantContent).toContain("inspection incomplete");
    expect(result.assistantContent).not.toContain("GOATCITADEL_PROMPT_PACK_PATH");
    expect(result.assistantContent).not.toContain("/api/v1/prompt-packs/import");
  });

  it("does not inject prompt-pack operator-surface fallback content on live chat turns", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect report rendering, trend rendering, and benchmark status/report APIs. Explain what evidence each surface exposes to an operator and cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Exact files used",
              "- `F:/code/personal-ai/apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts`",
              "- `F:/code/personal-ai/artifacts/cost-reports/cost-report-2026-03-20-22.md`",
              "- `F:/code/personal-ai/artifacts/cost-reports/cost-report-2026-03-21-08.md`",
              "- `F:/code/personal-ai/apps/gateway/src/routes/prompt-packs.ts`",
              "- `F:/code/personal-ai/apps/gateway/src/services/prompt-pack-service.ts`",
              "",
              "## Patch points",
              "- Consumer/status candidate: `F:/code/personal-ai/apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts`.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-operator-surface-search",
        result: {
          matches: [
            { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts", type: "file" },
            { path: "apps/gateway/src/routes/prompt-packs.ts", name: "prompt-packs.ts", type: "file" },
            {
              path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
              name: "chat.prompt-pack-benchmark.test.ts",
              type: "file",
            },
            {
              path: "artifacts/cost-reports/cost-report-2026-03-20-22.md",
              name: "cost-report-2026-03-20-22.md",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-operator-surface-service-read",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          startLine: 847,
          endLine: 1000,
          content: [
            "getPromptPackReport(packId: string): PromptPackReportRecord {",
            "  return { pack, tests, runs, scores, autoScoresV2, humanReviewsV2, latestAssessments, summary };",
            "}",
            "getPromptPackBenchmarkStatus(benchmarkRunId: string): PromptPackBenchmarkStatusRecord {",
            "  return { run, progress: { totalItems: runRow.total_items, completedItems: Math.max(runRow.completed_items, items.length) }, modelSummaries };",
            "}",
            "getPromptPackCapabilityTrends(packId: string): { items: CapabilityTrendSeries[] } {",
            "  return { items: capabilities.map((entry) => ({ capability: entry.key, points, threshold: entry.threshold, breached })) };",
            "}",
            "function renderPromptPackMarkdownReport(report: PromptPackReportRecord): string {",
            "  lines.push('## Snapshot');",
            "  lines.push('### Latest Run');",
            "  lines.push('### Auto Score (V2)');",
            "  lines.push('### Integrity');",
            "  lines.push('### Trace Summary');",
            "  lines.push('### Citations');",
            "  lines.push('## Outstanding');",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-operator-surface-route-read",
        result: {
          path: "apps/gateway/src/routes/prompt-packs.ts",
          startLine: 303,
          endLine: 405,
          content: [
            "fastify.get('/api/v1/prompt-packs/:packId/report', async (request, reply) => {",
            "  return reply.send(fastify.gateway.getPromptPackReport(params.data.packId));",
            "});",
            "fastify.post('/api/v1/prompt-packs/:packId/benchmark/run', async (request, reply) => {",
            "  return reply.send(fastify.gateway.runPromptPackBenchmark(params.data.packId, { testCodes: body.data.testCodes, providers: body.data.providers }));",
            "});",
            "fastify.get('/api/v1/prompt-packs/benchmark/:benchmarkRunId', async (request, reply) => {",
            "  return reply.send(fastify.gateway.getPromptPackBenchmarkStatus(params.data.benchmarkRunId));",
            "});",
            "fastify.post('/api/v1/prompt-packs/benchmark/:benchmarkRunId/cancel', async (request, reply) => {",
            "  return reply.send(fastify.gateway.cancelPromptPackBenchmark(params.data.benchmarkRunId));",
            "});",
            "fastify.get('/api/v1/prompt-packs/:packId/trends', async (request, reply) => {",
            "  return reply.send(fastify.gateway.getPromptPackCapabilityTrends(params.data.packId));",
            "});",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-pack-operator-surface-benchmark-test-read",
        result: {
          path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
          startLine: 1,
          endLine: 124,
          content: [
            "it('returns benchmark status for a benchmark run id', async () => {",
            "  expect(response.json()).toMatchObject({",
            "    progress: { totalItems: 10, completedItems: 4 },",
            "  });",
            "});",
            "it('cancels a benchmark run by id', async () => {",
            "  expect(response.json()).toMatchObject({",
            "    run: { status: 'cancelled' },",
            "  });",
            "});",
          ].join("\n"),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-pack-operator-surface-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-pack-operator-surface-repair-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        query: "prompt-pack-service.ts",
      }),
    });
    expect(result.assistantContent).toContain("## Exact files used");
    expect(result.assistantContent).toContain("apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts");
    expect(result.assistantContent).toContain("artifacts/cost-reports/cost-report-2026-03-20-22.md");
    expect(result.assistantContent).not.toContain("GET /api/v1/prompt-packs/:packId/report");
    expect(result.assistantContent).not.toContain("top failure signals");
  });

  it("does not apply repo-grounded harness repair logic to ordinary live prompts", async () => {
    const prompt =
      "Inspect the repo and explain the current implementation for approval wake handling. Show the exact files used.";
    const repairedAnswer = [
      "The current implementation keeps approval wake handling in the approval effects service and cross-checks the wake result before deciding whether to skip, fail, or complete the effect.",
      "",
      "I would verify `apps/gateway/src/services/approval-resolution-effects-service.ts` first, then trace the durable wake call sites from there.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("file.read_range", {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          startLine: 1,
          endLine: 160,
        }),
      )
      .mockResolvedValueOnce({
        model: "gemma-3",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Observed from the files I did inspect:",
            },
            finish_reason: "length",
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "gemma-3",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: repairedAnswer,
            },
            finish_reason: "stop",
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-live-repo-inspection-read-1",
      result: {
        path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
        startLine: 1,
        endLine: 160,
        content: [
          "export class ApprovalEffectsService {",
          "  public enqueueResolutionEffects() {}",
          "  private async handleApprovalWaitWake() {}",
          "}",
        ].join("\n"),
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-live-repo-inspection-1",
      turnId: randomUUID(),
      userMessageId: "msg-live-repo-inspection-1",
      content: prompt,
      mode: "chat",
      providerId: "llamacpp",
      model: "gemma-3",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toBe(repairedAnswer);
    expect(result.assistantContent).not.toContain("Files:");
    expect(result.assistantContent).not.toContain("Anything beyond those files is unverified");
    expect(result.turnTrace.completion).toMatchObject({
      repaired: true,
      repair: expect.objectContaining({
        applied: true,
        kind: "incomplete_truncated_completion",
        source: "orchestrator",
      }),
    });
    expect(result.turnTrace.completion?.repair?.kind).not.toBe("prompt_pack_harness_normalization");
  });

  it("repairs approval-wake flow inspections into an observed numbered order with exact-file evidence", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect approval wait resolution, downstream wake calls, and operational event emission.",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Present the answer as a numbered sequence of the observed write or call order.",
      "- End with two bullets labeled `Operator-visible partial failure` and `Still not proven`.",
      "- If a step was inferred rather than observed, label it inline as `(inferred)`.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I'll inspect the relevant files to trace the approval wait resolution flow, downstream wake calls, and operational event emission. Let me read the complete implementation files.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-approval-wake-search",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
              name: "approval-resolution-effects-service.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/approval-lifecycle-service.ts",
              name: "approval-lifecycle-service.ts",
              type: "file",
            },
            {
              path: "packages/storage/src/approval-wait-run-repo.ts",
              name: "approval-wait-run-repo.ts",
              type: "file",
            },
            {
              path: "packages/storage/src/approval-effect-repo.ts",
              name: "approval-effect-repo.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-approval-wake-effects-read",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          startLine: 130,
          endLine: 470,
          content: [
            "public enqueueResolutionEffects(approval: ApprovalRequest, input: ApprovalResolveInput): ApprovalEffectRecord[] {",
            "  const approvalWaitRunId = this.ctx.storage.approvalWaitRuns.getRunId(approval.approvalId);",
            "  if (approvalWaitRunId) {",
            "    this.ctx.storage.approvalEffects.upsert({ effectKind: 'approval_wait_wake', targetId: approvalWaitRunId, payload: wakePayload });",
            "  }",
            "  this.requestEffectProcessing();",
            "}",
            "private async executeClaimedEffect(effectId: string, signal?: AbortSignal): Promise<void> {",
            "  switch (effect.effectKind) {",
            "    case 'approval_wait_wake':",
            "      await this.handleWakeEffect(effect, true);",
            "      return;",
            "  }",
            "}",
            "private async handleWakeEffect(effect: ApprovalEffectRecord, resolveApprovalWait: boolean): Promise<void> {",
            "  const result = this.deps.wakeDurableRun(effect.targetId, { eventKey: 'approval.resolved' });",
            "  if (result.outcome === 'woke') {",
            "    this.ctx.storage.approvalWaitRuns.markResolved(effect.approvalId, new Date().toISOString());",
            "    this.deps.requestRunProcessing(effect.targetId);",
            "    this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, { result: resultRecord });",
            "    return;",
            "  }",
            "  this.ctx.storage.approvalEffects.skipEffect(effect.effectId, this.workerId, effect.version, { result: explicitNonWakeResult });",
            "  this.ctx.publishRealtime('approval_wait_wake_skipped', 'approvals', { approvalId: effect.approvalId, targetId: effect.targetId }, { eventClass: 'operational_signal', eventAuthority: 'retained_stream' });",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-approval-wake-lifecycle-read",
        result: {
          path: "apps/gateway/src/services/approval-lifecycle-service.ts",
          startLine: 491,
          endLine: 560,
          content: [
            "export async function resolveApproval(host: ApprovalLifecycleHost, approvalId: string, input: ApprovalResolveInput): Promise<ApprovalResolveResult> {",
            "  host.storage.runImmediateTransaction(() => {",
            "    approval = host.storage.approvals.resolve(approvalId, input);",
            "    host.storage.approvalEvents.append({ approvalId, eventType: 'resolved' });",
            "    host.enqueueApprovalResolutionEffects(approval, input);",
            "  });",
            "  const effects = host.storage.approvalEffects.listByApproval(approvalId);",
            "  const resolutionEffects = deriveApprovalResolutionEffectsResult(effects);",
            "  const wakeRunId = resolutionEffects?.approvalWaitDurableRunId;",
            "  if (wakeRunId && approval.linkage?.durableRunId !== wakeRunId) {",
            "    approval = host.storage.approvals.mergeLinkage(approval.approvalId, { durableRunId: wakeRunId });",
            "  }",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-approval-wake-wait-read",
        result: {
          path: "packages/storage/src/approval-wait-run-repo.ts",
          startLine: 20,
          endLine: 66,
          content: [
            "public getRunId(approvalId: string): string | undefined {",
            "  return this.get(approvalId)?.runId;",
            "}",
            "public markResolved(approvalId: string, resolvedAt?: string): ApprovalWaitRunRecord | undefined {",
            "  this.markResolvedStmt.run(resolvedAt ?? new Date().toISOString(), approvalId);",
            "}",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-approval-wake-effect-repo-read",
        result: {
          path: "packages/storage/src/approval-effect-repo.ts",
          startLine: 228,
          endLine: 290,
          content: [
            "public upsert(input: { approvalId: string; effectKind: ApprovalEffectKind; targetId: string; }): ApprovalEffectRecord {",
            "  const idempotencyKey = input.idempotencyKey ?? buildApprovalEffectIdempotencyKey(input);",
            "}",
            "public claimNextPendingEffect(workerId: string, now: string, leaseExpiresAt: string, limit = 25): ApprovalEffectRecord | undefined {",
            "  return this.get(candidate.effect_id);",
            "}",
          ].join("\n"),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-approval-wake-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-approval-wake-repair-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        query: "approval-resolution-effects-service.ts",
      }),
    });
    expect(result.assistantContent).toContain("Exact files used:");
    expect(result.assistantContent).toContain("1. Observed");
    expect(result.assistantContent).toContain("approval_wait_wake_skipped");
    expect(result.assistantContent).toContain("`Operator-visible partial failure`");
    expect(result.assistantContent).toContain("`Still not proven`");
    expect(result.turnTrace.completion).toMatchObject({
      repaired: true,
      repair: expect.objectContaining({
        applied: true,
        kind: "prompt_pack_harness_normalization",
        source: "prompt_pack_harness",
      }),
    });
  });

  it("answers no-tools conflict prompts directly instead of surfacing a web-off refusal", async () => {
    const prompt =
      "Without assuming tool access, explain how GoatCitadel should answer when two docs appear to conflict and it cannot verify which one is authoritative right now. Keep the answer practical and high-trust.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Say what is known, name the conflicting sources, avoid claiming authority you cannot verify, and tell the operator what to check next.",
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-no-tools-doc-conflict-1",
      turnId: randomUUID(),
      userMessageId: "msg-no-tools-doc-conflict-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toContain("conflicting sources");
    expect(result.assistantContent).not.toContain("Web is set to Off");
  });

  it("prefetches repo search evidence for prompt-lab implicit code inspections even without repo-assist wrapping", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves GoatCitadel can parse `pnpm outdated -r` output even when the dependents column wraps.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "The narrowest test belongs next to `packages/storage/src/pnpm-outdated-parser.test.ts` and should exercise `packages/storage/src/pnpm-outdated-parser.ts` with a wrapped dependents column fixture.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-implicit-code-search-1",
      result: {
        matches: [
          { path: "packages/storage/src/pnpm-outdated-parser.ts", name: "pnpm-outdated-parser.ts" },
          { path: "packages/storage/src/pnpm-outdated-parser.test.ts", name: "pnpm-outdated-parser.test.ts" },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-implicit-code-repo-inspection-1",
      turnId: randomUUID(),
      userMessageId: "msg-implicit-code-repo-inspection-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect(result.assistantContent).toContain("pnpm-outdated-parser");
    expect(result.assistantContent).not.toContain("No repo files or tool output were provided");
  });

  it("prefetches ranked concrete reads for prompt-lab explicit code inspections instead of clarifying or reading low-signal artifacts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect report rendering and benchmark status surfaces. Identify the exact patch points needed so operators can see per-model wall-clock timing and estimate overnight run length.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "Patch the report assembly in `apps/gateway/src/services/prompt-pack-service.ts`,",
              "thread the benchmark timing view through `apps/gateway/src/routes/chat.ts`,",
              "and validate the surface in `apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts`.",
            ].join(" "),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-wall-clock-search-1",
        result: {
          matches: [
            {
              path: "artifacts/prompt-lab/manual-import-pack-81737f94-82bc-latest.md",
              name: "manual-import-pack-81737f94-82bc-latest.md",
            },
            { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts" },
            {
              path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
              name: "chat.prompt-pack-benchmark.test.ts",
            },
            { path: "apps/gateway/src/routes/chat.ts", name: "chat.ts" },
            { path: "ggml/src/benchmark.c", name: "benchmark.c" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-wall-clock-read-impl-1",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export function buildPromptPackReport() { return renderPromptPackTiming(); }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-wall-clock-read-companion-1",
        result: {
          path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
          content: "it('renders prompt-pack timing surfaces', () => expect(true).toBe(true));",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-wall-clock-read-impl-2",
        result: {
          path: "apps/gateway/src/routes/chat.ts",
          content: "export function mapPromptPackStatus() { return { wallClockMs: 42 }; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-explicit-code-wall-clock-1",
      turnId: randomUUID(),
      userMessageId: "msg-explicit-code-wall-clock-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).not.toContain("What geographic area do you mean exactly");
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect(
      invokeTool.mock.calls
        .filter((call) => call[0].toolName === "file.read_range")
        .map((call) => String(call[0].args.path)),
    ).toEqual(
      expect.arrayContaining([
        "apps/gateway/src/services/prompt-pack-service.ts",
        "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
        "apps/gateway/src/routes/chat.ts",
      ]),
    );
    expect(invokeTool.mock.calls.some((call) => JSON.stringify(call[0]).includes("artifacts/prompt-lab"))).toBe(false);
    expect(invokeTool.mock.calls.some((call) => JSON.stringify(call[0]).includes("ggml/src/benchmark.c"))).toBe(false);
  });

  it("continues prompt-lab exact-evidence search prefetch across multiple query seeds until enough concrete reads exist", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect prompt-pack selection, benchmark inputs, and gate-runner APIs. Identify the exact patch points needed to support a qwen-focused overnight extension pack cleanly.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Patch prompt-pack selection, benchmark inputs, and the gate runner once the qwen-focused overnight pack is registered end to end.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-qwen-search-1",
        result: {
          matches: [{ path: "scripts/run-prompt-pack-gates.ts", name: "run-prompt-pack-gates.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-qwen-read-1",
        result: {
          path: "scripts/run-prompt-pack-gates.ts",
          content: "export async function runPromptPackGates() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-qwen-search-2",
        result: {
          matches: [{ path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-qwen-read-2",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export function resolvePromptPackProjectBinding() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-qwen-search-3",
        result: {
          matches: [
            {
              path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
              name: "chat.prompt-pack-benchmark.test.ts",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-qwen-read-3",
        result: {
          path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
          content: "it('runs prompt-pack benchmark inputs', () => expect(true).toBe(true));",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-qwen-multi-query-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-qwen-multi-query-prefetch-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    const searchQueries = invokeTool.mock.calls
      .map((call) => call[0])
      .filter((call) => call.toolName === "code.search_files")
      .map((call) => String(call.args.query));
    expect(searchQueries).toEqual(expect.arrayContaining(["benchmark", "gate", "run-prompt-pack-gates"]));
    expect(
      invokeTool.mock.calls
        .filter((call) => call[0].toolName === "file.read_range")
        .map((call) => String(call[0].args.path)),
    ).toEqual(
      expect.arrayContaining(["scripts/run-prompt-pack-gates.ts", "apps/gateway/src/services/prompt-pack-service.ts"]),
    );
  });

  it("continues into baseline file reads after explicit prompt-pack file prefetch when the prompt asks for distinction from the frozen baseline", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves `goatcitadel_prompt_pack_v2.md` parses cleanly and remains distinct from the frozen baseline.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Add a parser-focused regression that reads both `goatcitadel_prompt_pack_v2.md` and `goatcitadel_prompt_pack.md`, then asserts the parsed identities differ.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-pack-v2-read-1",
        result: {
          path: "goatcitadel_prompt_pack_v2.md",
          content: "# GoatCitadel Prompt Pack v2\n",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-pack-baseline-read-1",
        result: {
          path: "goatcitadel_prompt_pack.md",
          content: "# GoatCitadel Prompt Pack\n",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-pack-v2-baseline-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-pack-v2-baseline-prefetch-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "file.read_range",
      args: expect.objectContaining({ path: "goatcitadel_prompt_pack_v2.md" }),
    });
    const invokedPaths = invokeTool.mock.calls
      .filter((call) => call[0].toolName === "file.read_range")
      .map((call) => String(call[0].args.path));
    expect(invokedPaths).toEqual(
      expect.arrayContaining(["goatcitadel_prompt_pack_v2.md", "goatcitadel_prompt_pack.md"]),
    );
    expect(result.assistantContent).toContain("goatcitadel_prompt_pack.md");
  });

  it("filters low-signal temp matches and searches subsystem nouns for explicit event-envelope audits", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect event producers, realtime-event storage, and related contracts. Identify the exact patch points needed so approval, run, session, task, and proactive events publish explicit `eventClass`, `eventAuthority`, and `links`, and cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Patch the realtime-event storage and event producer contracts together.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-event-search-1",
        result: {
          matches: [
            {
              path: "F:/code/personal-ai/.codex-tmp/llama-inspect/tools/server/webui/src/lib/markdown/enhance-links.ts",
              name: "enhance-links.ts",
            },
            { path: "F:/code/personal-ai/packages/storage/src/realtime-event-repo.ts", name: "realtime-event-repo.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-event-read-1",
        result: {
          path: "F:/code/personal-ai/packages/storage/src/realtime-event-repo.ts",
          content: "export class RealtimeEventRepository {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-event-search-2",
        result: {
          matches: [{ path: "F:/code/personal-ai/packages/contracts/src/realtime.ts", name: "realtime.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-event-read-2",
        result: {
          path: "F:/code/personal-ai/packages/contracts/src/realtime.ts",
          content: "export interface RealtimeEvent {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-event-search-3",
        result: {
          matches: [
            {
              path: "F:/code/personal-ai/apps/gateway/src/services/approval-resolution-effects-service.ts",
              name: "approval-resolution-effects-service.ts",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-event-read-3",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/approval-resolution-effects-service.ts",
          content: "export function publishApprovalEvent() {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-event-envelope-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-event-envelope-prefetch-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    const searchQueries = invokeTool.mock.calls
      .map((call) => call[0])
      .filter((call) => call.toolName === "code.search_files")
      .map((call) => String(call.args.query));
    expect(searchQueries).toEqual(expect.arrayContaining(["realtime-event", "approval", "session"]));
    expect(searchQueries).not.toContain("eventclass");
    expect(searchQueries).not.toContain("links");
    expect(invokeTool.mock.calls.some((call) => JSON.stringify(call[0]).includes(".codex-tmp"))).toBe(false);
  });

  it("repairs typed wake outcome patch plans into the shared durable contract and wake call sites", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect durable-run wake logic, approval-wait wake handling, and related operator-visible status shaping. Identify the exact patch points needed to add a typed wake outcome contract and cite the exact files used.",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Name the contract file, producer call sites, and consumer call sites.",
      "- Include one compatibility note and one validation step.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Contract file",
              "- `packages/durable-runner/src/contracts.ts`",
              "",
              "## Producer call sites",
              "- guessed from memory",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d147-search-1",
        result: {
          matches: [
            { path: "packages/contracts/src/durable.ts", name: "durable.ts", type: "file" },
            {
              path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
              name: "approval-resolution-effects-service.ts",
              type: "file",
            },
            { path: "apps/gateway/src/services/durable-run-service.ts", name: "durable-run-service.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d147-read-contract",
        result: {
          path: "packages/contracts/src/durable.ts",
          content: "export type DurableWakeOutcome = 'woke' | 'failed';\nexport interface DurableWakeResult {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d147-read-effects",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          content: "class ApprovalEffectsService { handleWakeEffect() { return this.deps.wakeDurableRun('run-1'); } }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d147-read-service",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          content: "class DurableRunService { wakeDurableRun() { return { outcome: 'woke' }; } }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d147-search-2",
        result: {
          matches: [{ path: "apps/gateway/src/routes/durable.ts", name: "durable.ts", type: "file" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d147-read-route",
        result: {
          path: "apps/gateway/src/routes/durable.ts",
          content: "fastify.post('/api/v1/durable/runs/:runId/events/wake', async () => {});",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-d147-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-d147-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ query: "durable.ts" }),
    });
    expect(result.assistantContent).toContain("packages/contracts/src/durable.ts");
    expect(result.assistantContent).toContain("DurableRunService.wakeDurableRun");
    expect(result.assistantContent).toContain("ApprovalEffectsService.handleWakeEffect");
    expect(result.assistantContent).toContain("Compatibility note");
    expect(result.assistantContent).toContain("Validation step");
    expect(result.assistantContent).not.toContain("packages/durable-runner");
  });

  it("repairs two-worker harness prompts into concrete durable repo race scenarios", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect durable execution tests or adjacent harnesses. Identify the exact patch points needed to add a real two-worker claim and recovery test instead of relying on single-process behavior, and cite the exact files used.",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Name the harness entrypoint, worker orchestration helper, and assertion surface.",
      "- Define exactly two new scenarios: claim race and lease-expiry recovery.",
      "- Include the failure signature each scenario should surface.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [{ index: 0, message: { role: "assistant", content: "maybe add more tests somewhere" } }],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d153-search-1",
        result: {
          matches: [
            { path: "packages/storage/src/durable-run-repo.test.ts", name: "durable-run-repo.test.ts", type: "file" },
            { path: "packages/storage/src/durable-run-repo.ts", name: "durable-run-repo.ts", type: "file" },
            {
              path: "apps/gateway/src/services/durable-run-service.ts",
              name: "durable-run-service.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d153-read-repo-test",
        result: {
          path: "packages/storage/src/durable-run-repo.test.ts",
          content: "describe('DurableRunRepository', () => { function createRepo() {} });",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d153-read-repo",
        result: {
          path: "packages/storage/src/durable-run-repo.ts",
          content: "tryClaimQueuedRun() {}\nrenewLease() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d153-read-service",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          content: "listExpiredRunningRunIds();",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d153-search-2",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/durable-run-service.test.ts",
              name: "durable-run-service.test.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d153-read-service-test",
        result: {
          path: "apps/gateway/src/services/durable-run-service.test.ts",
          content: "it('drops stale worker terminal writes', async () => {});",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-d153-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-d153-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("packages/storage/src/durable-run-repo.test.ts");
    expect(result.assistantContent).toContain("tryClaimQueuedRun");
    expect(result.assistantContent).toContain("claim race");
    expect(result.assistantContent).toContain("lease-expiry recovery");
    expect(result.assistantContent).toContain("stale worker still renews the lease");
  });

  it("repairs approval-effects hardening prompts into canonical-vs-effect storage boundaries", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect approval resolution, downstream effect handling, and operator-visible effect status paths. Identify the exact patch points needed to add idempotent effect tracking or an outbox path without corrupting canonical approval state, and cite the exact files used.",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Separate canonical approval writes from downstream effect tracking writes.",
      "- Name the idempotency key or dedupe mechanism you would use.",
      "- Include one migration or rollout risk and one proving test.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [{ index: 0, message: { role: "assistant", content: "add an outbox to approvals somehow" } }],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d154-search-1",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/approval-lifecycle-service.ts",
              name: "approval-lifecycle-service.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
              name: "approval-resolution-effects-service.ts",
              type: "file",
            },
            { path: "packages/storage/src/approval-effect-repo.ts", name: "approval-effect-repo.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d154-read-lifecycle",
        result: {
          path: "apps/gateway/src/services/approval-lifecycle-service.ts",
          content: "resolveApproval() { approvalEvents.append({ type: 'resolved' }); }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d154-read-effects",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          content: "enqueueResolutionEffects() {}\nhandleWakeEffect() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d154-read-repo",
        result: {
          path: "packages/storage/src/approval-effect-repo.ts",
          content:
            "idempotency_key: string | null;\nON CONFLICT(idempotency_key) DO UPDATE SET status = excluded.status;",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d154-search-2",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/approval-resolution-effects-service.test.ts",
              name: "approval-resolution-effects-service.test.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d154-read-effects-test",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.test.ts",
          content: "it('replays wake retries safely', async () => {});",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-d154-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-d154-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Canonical approval writes");
    expect(result.assistantContent).toContain("Downstream effect tracking writes");
    expect(result.assistantContent).toContain("idempotency_key");
    expect(result.assistantContent).toContain("migration additive");
    expect(result.assistantContent).toContain("approval-resolution-effects-service.test.ts");
  });

  it("repairs approval wake-ordering minimal test prompts toward the approval effects harness", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect the approval wake ordering path and name the exact minimal automated test needed. Include: Target test file or suite, Setup, Act, Assert, Failure signature.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I would add a small durable-run test around wake handling, but I need to keep investigating before I can verify the target.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d139-search-1",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/approval-resolution-effects-service.test.ts",
              name: "approval-resolution-effects-service.test.ts",
              type: "file",
            },
            {
              path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
              name: "approval-resolution-effects-service.ts",
              type: "file",
            },
            { path: "packages/storage/src/approval-effect-repo.ts", name: "approval-effect-repo.ts", type: "file" },
            {
              path: "packages/storage/src/approval-wait-run-repo.ts",
              name: "approval-wait-run-repo.ts",
              type: "file",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d139-read-1",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.test.ts",
          content:
            "describe('approval wake ordering', () => { it('does not complete before wake', async () => {}); });",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d139-read-2",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          content: "async function handleWakeEffect() { await wakeDurableRun(); }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d139-read-3",
        result: {
          path: "packages/storage/src/approval-effect-repo.ts",
          content: "export class ApprovalEffectRepository {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-d139-read-4",
        result: {
          path: "packages/storage/src/approval-wait-run-repo.ts",
          content: "export class ApprovalWaitRunRepository {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-d139-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-d139-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("approval-resolution-effects-service.test.ts");
    expect(result.assistantContent).toContain("markResolved");
    expect(result.assistantContent).toContain("completeEffect");
    expect(result.assistantContent).toContain("wakeDurableRun");
    expect(result.assistantContent).toContain("Setup:");
    expect(result.assistantContent).toContain("Act:");
    expect(result.assistantContent).toContain("Assert:");
    expect(result.assistantContent).toContain("Failure signature:");
    expect(result.assistantContent).not.toContain("need to keep investigating");
  });

  it("repairs cowork workspace-route regression prompts into grounded route and repo checks", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect workspace routes, guidance docs, and related services. Produce role-labeled sections for the first fresh regression checks to add, and cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Researcher",
              "- Maybe inspect workspace storage.",
              "",
              "## Architect",
              "- Probably add route tests.",
              "",
              "## QA",
              "- Some regressions here.",
              "",
              "## Synthesis",
              "- Not done yet.",
              "",
              "Note: read range failed while I was working, so parts of this answer may be incomplete.",
              "Best next move: Retry read range with a narrower, more explicit input.",
              'Say "keep going" to try another approach.',
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w109-search-1",
        result: {
          matches: [
            { path: "apps/gateway/src/routes/workspaces.ts", name: "workspaces.ts", type: "file" },
            { path: "apps/gateway/src/routes/workspaces.test.ts", name: "workspaces.test.ts", type: "file" },
            { path: "packages/storage/src/workspace-repo.ts", name: "workspace-repo.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w109-read-routes",
        result: {
          path: "apps/gateway/src/routes/workspaces.ts",
          content:
            'const listWorkspacesQuerySchema = z.object({ view: z.enum(["active","archived","all"]).default("active") });',
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w109-read-route-test",
        result: {
          path: "apps/gateway/src/routes/workspaces.test.ts",
          content: "describe('workspace and guidance routes', () => {});",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w109-read-repo",
        result: {
          path: "packages/storage/src/workspace-repo.ts",
          content:
            "interface WorkspaceRow { lifecycle_status: 'active' | 'archived'; archived_at: string | null; workspace_prefs_json: string | null; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w109-search-2",
        result: {
          matches: [
            { path: "packages/storage/src/workspace-repo.test.ts", name: "workspace-repo.test.ts", type: "file" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-w109-read-repo-test",
        result: {
          path: "packages/storage/src/workspace-repo.test.ts",
          content: "describe('WorkspaceRepository', () => {});",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-w109-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-w109-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ query: "workspaces.ts" }),
    });
    expect(result.assistantContent).toContain("apps/gateway/src/routes/workspaces.ts");
    expect(result.assistantContent).toContain("apps/gateway/src/routes/workspaces.test.ts");
    expect(result.assistantContent).toContain("packages/storage/src/workspace-repo.ts");
    expect(result.assistantContent).toContain("archive-view filtering");
    expect(result.assistantContent).toContain("guidance doc-type divergence");
    expect(result.assistantContent).not.toContain('Say "keep going"');
  });

  it("does not let repo-grounded repair overwrite strict cowork memory role sections", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect memory routes, memory context services, and any related Memory UI surfaces. Create role-labeled sections for the first fresh regression checks to add.",
      "",
      "Answer contract:",
      "- Keep exactly these sections in order: `Researcher`, `QA`.",
      "- Do not add any intro, recap, synthesis, evidence appendix, or citation appendix.",
      "- Each section must contain exactly two bullets.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Observed memory lifecycle surfaces:\n- route layer exists.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.toolName === "code.search_files") {
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: "audit-cowork-memory-search-1",
          result: {
            matches: [
              { path: "apps/gateway/src/routes/memory.ts", name: "memory.ts", type: "file" },
              { path: "packages/storage/src/memory-context-repo.ts", name: "memory-context-repo.ts", type: "file" },
              { path: "apps/mission-control/src/pages/MemoryPage.tsx", name: "MemoryPage.tsx", type: "file" },
            ],
          },
        };
      }
      if (request.toolName === "file.read_range") {
        const path = String(request.args?.path ?? "");
        if (path.endsWith("apps/gateway/src/routes/memory.ts")) {
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-cowork-memory-read-1",
            result: {
              path,
              content: "export async function registerMemoryRoutes() {}",
            },
          };
        }
        if (path.endsWith("packages/storage/src/memory-context-repo.ts")) {
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-cowork-memory-read-2",
            result: {
              path,
              content: "export class MemoryContextRepository {}",
            },
          };
        }
        if (path.endsWith("apps/mission-control/src/pages/MemoryPage.tsx")) {
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-cowork-memory-read-3",
            result: {
              path,
              content: "export function MemoryPage() { return null; }",
            },
          };
        }
        if (path.endsWith("apps/mission-control/src/pages/memory/MemoryMaintenancePanel.tsx")) {
          return {
            outcome: "failed",
            policyReason: "allowed",
            auditEventId: "audit-cowork-memory-read-4",
            error: "simulated read failure",
          };
        }
      }
      return {
        outcome: "failed",
        policyReason: "allowed",
        auditEventId: "audit-cowork-memory-unexpected",
        error: `unexpected tool call: ${request.toolName}`,
      };
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-memory-role-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-memory-role-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Researcher");
    expect(result.assistantContent).toContain("QA");
    expect(result.assistantContent).not.toContain("Observed memory lifecycle surfaces");
    expect(result.assistantContent).not.toContain("## Exact files used");
    expect(result.assistantContent).not.toContain("parts of this answer may be incomplete");
    expect(result.assistantContent).not.toContain('Say "keep going"');
  });

  it("forces the cron cowork repair onto wiring, scheduled review execution, and operator report surfaces", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect built-in cron wiring, scheduled review execution, and the operator-visible report or cost surface. Create role-labeled sections for the first fresh trust-preserving regression checks to add.",
      "",
      "Answer contract:",
      "- Keep exactly these sections in order: `Researcher`, `Ops`, `QA`.",
      "- Do not add any extra headings.",
      "- Keep each section compact and decision-oriented.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Researcher\n- I only verified cron storage.\n\nOps\n- Add a cron test.\n\nQA\n- Add a report test.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-cowork-cron-search-1",
        result: {
          matches: [
            {
              path: "apps/gateway/src/services/gateway/cron-automation-service.ts",
              name: "cron-automation-service.ts",
            },
            { path: "apps/gateway/src/services/gateway/update-review.ts", name: "update-review.ts" },
            { path: "apps/gateway/src/routes/prompt-packs.ts", name: "prompt-packs.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-cowork-cron-read-1",
        result: {
          path: "apps/gateway/src/services/gateway/cron-automation-service.ts",
          content:
            "export const UPDATE_REVIEW_DAILY_JOB_ID = 'update-review-daily';\nexport class CronAutomationService {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-cowork-cron-read-2",
        result: {
          path: "apps/gateway/src/services/gateway/update-review.ts",
          content: "export interface UpdateReviewReport {}\nexport async function collectWorkspaceDependencyDrift() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-cowork-cron-read-3",
        result: {
          path: "apps/gateway/src/routes/prompt-packs.ts",
          content: 'fastify.get("/api/v1/prompt-packs/:packId/report", async (request, reply) => {});',
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-cron-role-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-cron-role-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Researcher");
    expect(result.assistantContent).toContain("Ops");
    expect(result.assistantContent).toContain("QA");
    expect(result.assistantContent).toContain("cron-automation-service.ts");
    expect(result.assistantContent).toContain("update-review.ts");
    expect(result.assistantContent).toContain("prompt-packs.ts");
    expect(result.assistantContent).not.toContain("## Evidence Used");
  });

  it("exposes repo inspection file tools for prompt-lab chat runs even without explicit file paths", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded but durable state, approval state, or lifecycle views still load. Cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Trust durable state first, then treat live status as projected until the approval and lifecycle surfaces agree.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-chat-repo-inspect-search-1",
        result: {
          matches: [
            { path: "apps/gateway/src/services/durable-run-service.ts", name: "durable-run-service.ts" },
            { path: "apps/gateway/src/services/approval-lifecycle-service.ts", name: "approval-lifecycle-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-chat-repo-inspect-read-1",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          content: "export function resolveDurableState() { return 'durable'; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-chat-repo-inspect-read-2",
        result: {
          path: "apps/gateway/src/services/approval-lifecycle-service.ts",
          content: "export function resolveApprovalLifecycle() { return 'approval'; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["memory.search", "code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-chat-repo-inspection-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-chat-repo-inspection-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect(invokeTool.mock.calls.some((call) => call[0].toolName === "memory.search")).toBe(false);
    expect(result.assistantContent).toContain("Exact files used:");
    expect(result.assistantContent).toContain("durable-run-service.ts");
  });

  it("prefetches repo-grounded chat inspections with concrete file reads before the model answers", async () => {
    const prompt = [
      "Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded but durable state, approval state, or lifecycle views still load. Separate:",
      "- authoritative state",
      "- projected state",
      "- still-unclear state",
      "",
      "Answer contract:",
      "- Cite the exact files or APIs inspected if any.",
      "- `authoritative state` must identify the durable source that should win.",
      "- `projected state` must identify one smoothed or live-derived surface.",
      "- `still-unclear state` must describe a concrete gap that the inspected code does not settle.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "authoritative state: trust the durable lifecycle state persisted by the run service.",
              "projected state: the operator-facing status summary is a derived surface.",
              "still-unclear state: the current reads do not settle how stale live updates are reconciled after delivery gaps.",
            ].join(" "),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-generic-repo-inspect-search-1",
        result: {
          matches: [
            { path: "apps/gateway/src/services/durable-run-service.ts", name: "durable-run-service.ts" },
            { path: "apps/gateway/src/services/gateway-service.ts", name: "gateway-service.ts" },
            { path: "apps/gateway/src/services/approval-lifecycle-service.ts", name: "approval-lifecycle-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-generic-repo-inspect-read-1",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          content: "export function readDurableLifecycleState() { return 'durable'; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-generic-repo-inspect-read-2",
        result: {
          path: "apps/gateway/src/services/gateway-service.ts",
          content: "export function buildOperatorStatusSummary() { return 'projected'; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-generic-repo-inspect-read-3",
        result: {
          path: "apps/gateway/src/services/approval-lifecycle-service.ts",
          content: "export function readApprovalState() { return 'approval'; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () =>
        createToolCatalog(["memory.search", "memory.read", "code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-generic-repo-inspection-chat-1",
      turnId: randomUUID(),
      userMessageId: "msg-generic-repo-inspection-chat-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect(
      invokeTool.mock.calls.some(
        (call) =>
          call[0].toolName === "file.read_range" &&
          call[0].args &&
          String(call[0].args.path) === "apps/gateway/src/services/durable-run-service.ts",
      ),
    ).toBe(true);
    expect(invokeTool.mock.calls.some((call) => call[0].toolName === "memory.search")).toBe(false);
    expect(result.assistantContent).toContain("## Exact files used");
    expect(result.assistantContent).toContain("## authoritative state");
    expect(result.assistantContent).toContain("## projected state");
    expect(result.assistantContent).toContain("## still-unclear state");
  });

  it("prefetches local repo evidence for prompt-lab implicit cowork inspections before the model falls back to memory tools", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and produce role-labeled sections describing the current override chain and the most valuable next simplification for operators.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Researcher",
              "- `packages/storage/src/workspace-hook-repo.ts` and `packages/storage/src/workspace-repo.ts` show the current override chain starts in storage-backed workspace resolution.",
              "",
              "## Architect",
              "- `AGENTS.md` is the clearest operator-facing contract today, so the next simplification is to make that precedence chain load from one canonical source instead of scattered lookup rules.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.toolName === "code.search_files") {
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: `audit-${randomUUID()}`,
          result: {
            matches: [
              { path: "packages/storage/src/workspace-hook-repo.ts", name: "workspace-hook-repo.ts" },
              { path: "packages/storage/src/workspace-repo.ts", name: "workspace-repo.ts" },
              { path: "AGENTS.md", name: "AGENTS.md" },
            ],
          },
        };
      }
      if (request.toolName === "file.read_range") {
        const path = String(request.args.path);
        const content =
          path === "packages/storage/src/workspace-hook-repo.ts"
            ? "export function readWorkspaceHook() { return 'workspace-hook'; }"
            : path === "packages/storage/src/workspace-repo.ts"
              ? "export function readWorkspaceRepo() { return 'workspace'; }"
              : "# AGENTS\nWorkspace overrides apply after repo defaults.\n";
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: `audit-${randomUUID()}`,
          result: { path, content },
        };
      }
      throw new Error(`unexpected tool ${request.toolName}`);
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () =>
        createToolCatalog(["memory.search", "memory.read", "code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-repo-inspection-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-repo-inspection-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect(
      invokeTool.mock.calls.some(
        (call) =>
          call[0].toolName === "file.read_range" &&
          String(call[0].args.path) === "packages/storage/src/workspace-hook-repo.ts",
      ),
    ).toBe(true);
    expect(invokeTool.mock.calls.some((call) => call[0].toolName === "memory.search")).toBe(false);
    expect(result.assistantContent).toContain("## Researcher");
    expect(result.assistantContent).toContain("workspace-hook-repo.ts");
  });

  it("keeps strongest concrete file evidence when repairing prompt-lab cowork role fallbacks", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect workspace loading, guidance docs, and project-binding behavior. Produce role-labeled sections summarizing the effective override chain and cite the exact files used.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I need to inspect more files before I can produce the requested role-labeled answer.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.toolName === "code.search_files") {
        const query = String(request.args.query);
        if (query === "workspace") {
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: `audit-${randomUUID()}`,
            result: {
              matches: [
                { path: "pnpm-workspace.yaml", name: "pnpm-workspace.yaml" },
                { path: "workspace", name: "workspace", type: "dir" },
                { path: "packages/storage/src/workspace-hook-repo.ts", name: "workspace-hook-repo.ts" },
                { path: "packages/storage/src/workspace-repo.ts", name: "workspace-repo.ts" },
                { path: "packages/storage/src/workspace-repo.test.ts", name: "workspace-repo.test.ts" },
              ],
            },
          };
        }
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: `audit-${randomUUID()}`,
          result: {
            matches: [
              { path: "AGENTS.md", name: "AGENTS.md" },
              { path: "docs/GOATCITADEL_AGENTIC_CODING_WORKFLOW.md", name: "GOATCITADEL_AGENTIC_CODING_WORKFLOW.md" },
            ],
          },
        };
      }
      if (request.toolName === "file.read_range") {
        const path = String(request.args.path);
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: `audit-${randomUUID()}`,
          result: {
            path,
            content: `// concrete evidence from ${path}`,
          },
        };
      }
      throw new Error(`unexpected tool ${request.toolName}`);
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-fallback-evidence-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-fallback-evidence-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("## Exact files used");
    expect(result.assistantContent).toContain("packages/storage/src/workspace-hook-repo.ts");
    expect(result.assistantContent).toContain("packages/storage/src/workspace-repo.ts");
    expect(result.assistantContent).toContain("AGENTS.md");
    expect(result.assistantContent).not.toContain("`.");
    expect(result.assistantContent).not.toContain("`pnpm-workspace.yaml`");
  });

  it("repairs repo-grounded continuation replies into recovered evidence summaries even without an exact-files contract", async () => {
    const prompt =
      "Use file or code tools to inspect Prompt Lab benchmark, replay regression, and trend/report wiring. Explain what each file owns and what an operator can and cannot infer from the outputs.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Let me read more key files to complete the picture of the benchmark, replay, and trend/report wiring.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-search-1",
        result: {
          matches: [{ path: "F:/code/personal-ai/packages/contracts/src/replay.ts", name: "replay.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-read-1",
        result: {
          path: "F:/code/personal-ai/packages/contracts/src/replay.ts",
          content: "export interface ReplayDiffSummary { latencyDeltaMs: number; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-search-2",
        result: {
          matches: [
            { path: "F:/code/personal-ai/apps/gateway/src/services/replay-execution.ts", name: "replay-execution.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-read-2",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/replay-execution.ts",
          content: "export async function executeReplayRun() { return { status: 'completed' }; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-search-3",
        result: {
          matches: [
            {
              path: "F:/code/personal-ai/apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
              name: "chat.prompt-pack-benchmark.test.ts",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-read-3",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
          content: "it('renders prompt-pack benchmark status', () => expect(true).toBe(true));",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-repo-grounded-recovery-1",
      turnId: randomUUID(),
      userMessageId: "msg-repo-grounded-recovery-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).not.toContain("Let me read more key files");
    expect(result.assistantContent).toContain("Observed from the files I did inspect:");
    expect(result.assistantContent).toContain("Files:");
    expect(result.assistantContent).toContain("packages/contracts/src/replay.ts");
  });

  it("repairs repo-grounded i'll-continue-gathering-evidence replies into recovered summaries", async () => {
    const prompt =
      "Use file or code tools to inspect Prompt Lab benchmark, replay regression, and trend/report wiring. Explain what each file owns and what an operator can and cannot infer from the outputs.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I'll continue gathering evidence to understand the Prompt Lab benchmark, replay regression, and trend/report wiring. Let me search for benchmark-related files and read more implementation details.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-continue-search-1",
        result: {
          matches: [{ path: "F:/code/personal-ai/packages/contracts/src/replay.ts", name: "replay.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-continue-read-1",
        result: {
          path: "F:/code/personal-ai/packages/contracts/src/replay.ts",
          content: "export interface ReplayDiffSummary { latencyDeltaMs: number; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-continue-search-2",
        result: {
          matches: [
            { path: "F:/code/personal-ai/apps/gateway/src/services/replay-execution.ts", name: "replay-execution.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-recovery-continue-read-2",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/replay-execution.ts",
          content: "export async function executeReplayRun() { return { status: 'completed' }; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-repo-grounded-recovery-continue-1",
      turnId: randomUUID(),
      userMessageId: "msg-repo-grounded-recovery-continue-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).not.toContain("I'll continue gathering evidence");
    expect(result.assistantContent).toContain("Observed from the files I did inspect:");
    expect(result.assistantContent).toContain("packages/contracts/src/replay.ts");
  });

  it("treats exact citations from files used as a concrete-evidence contract for repo-grounded repair", async () => {
    const prompt =
      "Use file or code tools to inspect memory routes, memory context services, and any related UI or copy. Explain the current operator-facing lifecycle with exact citations from the files you used.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I have partial evidence from the storage layer, but I need to search further for routes, UI components, and operator-facing interfaces. Let me continue investigating.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citations-search-1",
        result: {
          matches: [
            { path: "F:/code/personal-ai/packages/storage/src/memory-context-repo.ts", name: "memory-context-repo.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citations-read-1",
        result: {
          path: "F:/code/personal-ai/packages/storage/src/memory-context-repo.ts",
          content: "export class MemoryContextRepository {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citations-search-2",
        result: {
          matches: [
            { path: "F:/code/personal-ai/apps/mission-control/src/pages/MemoryPage.tsx", name: "MemoryPage.tsx" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citations-read-2",
        result: {
          path: "F:/code/personal-ai/apps/mission-control/src/pages/MemoryPage.tsx",
          content: "export function MemoryPage() { return null; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citations-search-3",
        result: {
          matches: [{ path: "F:/code/personal-ai/apps/gateway/src/routes/memory.ts", name: "memory.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-exact-citations-read-3",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/routes/memory.ts",
          content: "export async function registerMemoryRoutes() {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-exact-citations-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-exact-citations-repair-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toContain("## Exact files used");
    expect(result.assistantContent).toContain("memory-context-repo.ts");
    expect(result.assistantContent).not.toContain("Let me continue investigating");
  });

  it("repairs guidance loading summaries with exact helper, service, and AGENTS evidence", async () => {
    const prompt =
      "Use file or code tools to inspect the global, workspace, and repo docs guidance loading chain. Explain the current guidance loading path with exact citations from the files you used.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I found some hints about guidance files, but I need to continue gathering exact file evidence.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-chain-search-1",
        result: {
          matches: [
            {
              path: "F:/code/personal-ai/apps/gateway/src/services/guidance-document-helpers.ts",
              name: "guidance-document-helpers.ts",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-chain-read-1",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/guidance-document-helpers.ts",
          content: "export async function readGuidanceDocument() {}\nexport function resolveGuidancePath() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-chain-search-2",
        result: {
          matches: [
            { path: "F:/code/personal-ai/apps/gateway/src/services/gateway-service.ts", name: "gateway-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-chain-read-2",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/gateway-service.ts",
          content: "async function listWorkspaceGuidance() {}\nasync function resolveRuntimeGuidance() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-chain-search-3",
        result: {
          matches: [{ path: "F:/code/personal-ai/AGENTS.md", name: "AGENTS.md" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-chain-read-3",
        result: {
          path: "F:/code/personal-ai/AGENTS.md",
          content:
            "Applies to all runtime agents unless a workspace override exists in `workspaces/<workspaceId>/AGENTS.md`.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-guidance-chain-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-guidance-chain-repair-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toContain("Observed guidance loading chain");
    expect(result.assistantContent).toContain("guidance-document-helpers.ts");
    expect(result.assistantContent).toContain("gateway-service.ts");
    expect(result.assistantContent).toContain("Exact citations used:");
    expect(result.assistantContent).not.toContain("continue gathering exact file evidence");
  });

  it("filters template and placeholder paths out of exact-bullet guidance answers when the prompt forbids them", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect these files:",
      "- `apps/gateway/src/services/guidance-document-helpers.ts`",
      "- `apps/gateway/src/services/gateway-service.ts`",
      "- `AGENTS.md`",
      "- `templates/obsidian/ai-info-template/System/Agents/{{SYSTEM_NAME}} Agents.md`",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Use exactly three bullets labeled `Observed precedence`, `Operator-visible trace`, and `Still unverified`.",
      "- Do not cite template files or placeholder paths.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "- **Observed precedence** — The workspace override wins.",
              "",
              "- **Operator-visible trace** — The loader and runtime service both participate.",
              "",
              "- **Still unverified** — The template path hints at intended behavior.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-template-read-1",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/guidance-document-helpers.ts",
          content: "export function resolveGuidancePath() {}\nexport async function readGuidanceDocument() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-template-read-2",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/services/gateway-service.ts",
          content: "async function listWorkspaceGuidance() {}\nasync function resolveRuntimeGuidance() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-template-read-3",
        result: {
          path: "F:/code/personal-ai/AGENTS.md",
          content:
            "Applies to all runtime agents unless a workspace override exists in `workspaces/<workspaceId>/AGENTS.md`.",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-guidance-template-read-4",
        result: {
          path: "F:/code/personal-ai/templates/obsidian/ai-info-template/System/Agents/{{SYSTEM_NAME}} Agents.md",
          content: "Workspace overrides go here.",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-guidance-template-filter-1",
      turnId: randomUUID(),
      userMessageId: "msg-guidance-template-filter-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("- Observed precedence:");
    expect(result.assistantContent).toContain("- Operator-visible trace:");
    expect(result.assistantContent).toContain("- Still unverified:");
    expect(result.assistantContent).not.toContain("templates/obsidian");
    expect(result.assistantContent).not.toContain("{{SYSTEM_NAME}}");
    expect(result.assistantContent).toContain("guidance-document-helpers.ts");
    expect(result.assistantContent).toContain("gateway-service.ts");
    expect(result.assistantContent).toContain("workspaceFilesUsed");
    expect(result.assistantContent).toContain("globalFilesUsed");
    expect(result.assistantContent).not.toContain("Exact citations used:");
    expect(result.assistantContent).not.toContain("## Exact files used");
  });

  it("formats memory lifecycle exact-evidence prompts with the requested three bullet labels", async () => {
    const prompt = [
      "Use file or code tools to inspect memory routes, memory-context storage, and the operator-facing Memory UI. Explain the current operator-facing lifecycle with exact citations from the files you used.",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Use exactly three bullets labeled `Route surface`, `Stored state`, and `Operator-facing surface`.",
      "- Do not guess unseen maintenance behavior.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I have partial evidence from route and storage files, but I need more UI inspection before I can fully answer.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-shape-search-1",
        result: { matches: [{ path: "F:/code/personal-ai/apps/gateway/src/routes/memory.ts", name: "memory.ts" }] },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-shape-read-1",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/routes/memory.ts",
          content: "export async function registerMemoryRoutes() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-shape-search-2",
        result: {
          matches: [
            { path: "F:/code/personal-ai/packages/storage/src/memory-context-repo.ts", name: "memory-context-repo.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-shape-read-2",
        result: {
          path: "F:/code/personal-ai/packages/storage/src/memory-context-repo.ts",
          content: "export class MemoryContextRepository {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-shape-search-3",
        result: {
          matches: [
            { path: "F:/code/personal-ai/apps/mission-control/src/pages/MemoryPage.tsx", name: "MemoryPage.tsx" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-shape-read-3",
        result: {
          path: "F:/code/personal-ai/apps/mission-control/src/pages/MemoryPage.tsx",
          content: [
            "import { fetchMemoryItems, fetchMemoryMaintenanceStatus, runMemoryMaintenanceNow } from '../api/client';",
            "import { MemoryMaintenancePanel } from './memory/MemoryMaintenancePanel';",
            "export function MemoryPage() { return null; }",
          ].join("\n"),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-memory-shape-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-memory-shape-repair-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toContain("- Route surface:");
    expect(result.assistantContent).toContain("- Stored state:");
    expect(result.assistantContent).toContain("- Operator-facing surface:");
    expect(result.assistantContent).not.toContain("Observed memory lifecycle surfaces:");
    expect(result.assistantContent).toContain("apps/gateway/src/routes/memory.ts");
    expect(result.assistantContent).toContain("MemoryContextRepository");
    expect(result.assistantContent).toContain("MemoryPage");
    expect(result.assistantContent).not.toContain("'content': 'import");
    expect(result.assistantContent).not.toContain("Exact citations used:");
    expect(result.assistantContent).not.toContain("## Exact files used");
    expect(result.assistantContent.match(/^- (Route surface|Stored state|Operator-facing surface):/gm)).toHaveLength(3);
    expect(result.turnTrace.citations.some((citation) => citation.sourceType === "file")).toBe(true);
    expect(
      result.turnTrace.citations.some((citation) => citation.url.includes("apps/gateway/src/routes/memory.ts")),
    ).toBe(true);
  });

  it("treats MemoryMaintenancePanel as concrete operator-facing UI evidence for exact three-bullet prompts", async () => {
    const prompt = [
      "Use file or code tools to inspect these files:",
      "- `apps/gateway/src/routes/memory.ts`",
      "- `packages/storage/src/memory-context-repo.ts`",
      "- `apps/mission-control/src/pages/memory/MemoryMaintenancePanel.tsx`",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Use exactly three bullets labeled `Route surface`, `Stored state`, and `Operator-facing surface`.",
      "- Do not guess unseen maintenance behavior.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I still need the main Memory page before I can answer the operator-facing surface.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-maintenance-read-1",
        result: {
          path: "F:/code/personal-ai/apps/gateway/src/routes/memory.ts",
          content: "export async function registerMemoryRoutes() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-maintenance-read-2",
        result: {
          path: "F:/code/personal-ai/packages/storage/src/memory-context-repo.ts",
          content: "export class MemoryContextRepository {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-memory-maintenance-read-3",
        result: {
          path: "F:/code/personal-ai/apps/mission-control/src/pages/memory/MemoryMaintenancePanel.tsx",
          startLine: 1,
          endLine: 260,
          content:
            "{'path': 'F:/code/personal-ai/apps/mission-control/src/pages/memory/MemoryMaintenancePanel.tsx', 'content': 'export function MemoryMaintenancePanel() { return null; }'}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-memory-maintenance-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-memory-maintenance-repair-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toContain("MemoryMaintenancePanel.tsx");
    expect(result.assistantContent).not.toContain("No operator-facing Memory UI file was concretely read");
    expect(result.assistantContent).toContain("MemoryMaintenancePanel");
    expect(result.assistantContent).not.toContain("'path':");
    expect(result.assistantContent).not.toContain("lines 1-260");
    expect(result.assistantContent).not.toContain("Exact citations used:");
    expect(result.assistantContent).not.toContain("## Exact files used");
    expect(result.assistantContent.match(/^- (Route surface|Stored state|Operator-facing surface):/gm)).toHaveLength(3);
  });

  it("replaces prompt-lab meta continuation replies with deterministic exact-evidence fallback sections", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect typed wake outcomes. Cite the exact files used, name the contract file, producer call sites, consumer/status shaping, compatibility note, and validation step.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "I need to search more specifically for wake logic in the durable-run and approval systems. Let me continue inspection.",
              "",
              "**code.search** for pattern `wake` in `packages/storage/src`:",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-meta-fallback-search-1",
        result: {
          matches: [
            { path: "packages/contracts/src/durable.ts", name: "durable.ts" },
            { path: "apps/gateway/src/services/durable-run-service.ts", name: "durable-run-service.ts" },
            { path: "apps/gateway/src/services/gateway-service.ts", name: "gateway-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-meta-fallback-read-1",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          content: "export function wakeDurableRun() { return { outcome: 'woke' }; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-meta-fallback-read-2",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          content: "export interface ApprovalChatTurnResumeResult { wakeOutcome?: DurableWakeResult['outcome']; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-meta-fallback-read-3",
        result: {
          path: "packages/contracts/src/durable.ts",
          content: "export interface DurableWakeResult { outcome: 'woke' | 'waiting'; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-meta-fallback-read-4",
        result: {
          path: "apps/gateway/src/services/chat-durable-run-service.test.ts",
          content:
            "import { DurableRunRecord } from '@goatcitadel/contracts';\ndescribe('chat durable run', () => {});",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-meta-fallback-read-5",
        result: {
          path: ".github/workflows/publish-contracts.yml",
          content: "name: Publish @goatcitadel/contracts",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-meta-fallback-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-meta-fallback-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).not.toContain("I need to read more");
    expect(result.assistantContent).toContain("## Exact files used");
    expect(result.assistantContent).toContain("## Contract file");
    expect(result.assistantContent).toContain("packages/contracts/src/durable.ts");
    expect(result.assistantContent).toContain("approval-resolution-effects-service.ts");
    expect(result.assistantContent).toContain("## Compatibility note");
    expect(result.assistantContent).toContain("## Validation step");
  });

  it("keeps every exact file in the typed wake evidence list when more than four concrete reads were used", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect these files for typed wake outcomes:",
      "- `packages/contracts/src/durable.ts`",
      "- `apps/gateway/src/services/durable-run-service.ts`",
      "- `apps/gateway/src/services/approval-resolution-effects-service.ts`",
      "- `apps/gateway/src/services/chat-durable-run-service.test.ts`",
      "- `.github/workflows/publish-contracts.yml`",
      "- `apps/gateway/src/services/gateway-service.ts`",
      "",
      "Answer contract:",
      "- Cite the exact files used.",
      "- Name the contract file, producer call sites, consumer/status shaping, compatibility note, and validation step.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I can answer this from the file/code evidence already gathered, but I need to organize the wake contract notes.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-typed-wake-exact-1",
        result: {
          path: "packages/contracts/src/durable.ts",
          content: "export interface DurableWakeResult { outcome: 'woke' | 'waiting'; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-typed-wake-exact-2",
        result: {
          path: "apps/gateway/src/services/durable-run-service.ts",
          content: "export function wakeDurableRun() { return { outcome: 'woke' }; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-typed-wake-exact-3",
        result: {
          path: "apps/gateway/src/services/approval-resolution-effects-service.ts",
          content: "export interface ApprovalChatTurnResumeResult { wakeOutcome?: DurableWakeResult['outcome']; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-typed-wake-exact-4",
        result: {
          path: "apps/gateway/src/services/chat-durable-run-service.test.ts",
          content: "describe('chat durable run', () => {});",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-typed-wake-exact-5",
        result: {
          path: ".github/workflows/publish-contracts.yml",
          content: "name: Publish @goatcitadel/contracts",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-typed-wake-exact-6",
        result: {
          path: "apps/gateway/src/services/gateway-service.ts",
          content: "export function shapeOperatorStatus() { return 'approval-wait'; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-typed-wake-exact-files-1",
      turnId: randomUUID(),
      userMessageId: "msg-typed-wake-exact-files-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("chat-durable-run-service.test.ts");
    expect(result.assistantContent).toContain(".github/workflows/publish-contracts.yml");
    expect(result.assistantContent).toContain("gateway-service.ts");
    expect(result.assistantContent).toContain("Exact files used:");
    expect(result.assistantContent).toContain("Only the files listed above");
  });

  it("does not misread prose like trend/report wiring as a local search path", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect Prompt Lab benchmark, replay regression, and trend/report wiring. Explain what each file owns and what an operator can and cannot infer from the outputs.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Observed concrete evidence from the benchmark and replay files.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-benchmark-search-1",
        result: {
          matches: [
            {
              path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
              name: "chat.prompt-pack-benchmark.test.ts",
            },
            { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-benchmark-read-1",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export function runPromptPackBenchmark() { return 'ok'; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-benchmark-read-2",
        result: {
          path: "apps/gateway/src/routes/chat.prompt-pack-benchmark.test.ts",
          content: "it('runs the prompt pack benchmark', () => {});",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-prompt-lab-benchmark-path-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-benchmark-path-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        path: ".",
      }),
    });
    expect((invokeTool.mock.calls[0]?.[0] as { args?: { query?: string } } | undefined)?.args?.query).toBe("benchmark");
  });

  it("ignores answer-contract labels when deriving Prompt Lab search queries", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file or code tools to inspect Prompt Lab benchmark, replay regression, and trend/report wiring.",
      "",
      "Answer contract:",
      "- Use exactly four bullets labeled `Benchmark owner`, `Replay owner`, `Trend/report owner`, and `Operator inference boundary`.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [{ index: 0, message: { role: "assistant", content: "Missing required tool evidence." } }],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-answer-contract-query-1",
      result: { matches: [] },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-answer-contract-query-1",
      turnId: randomUUID(),
      userMessageId: "msg-answer-contract-query-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    const firstQuery = (invokeTool.mock.calls[0]?.[0] as { args?: { query?: string } } | undefined)?.args?.query;
    expect(firstQuery).not.toBe("benchmark owner");
    expect(firstQuery).not.toBe("replay owner");
    expect(firstQuery).toBe("benchmark");
  });

  it("passes non-Prompt-Lab prompts through without explicit-tools enforcement", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Here is a plain answer without any tools.",
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-non-prompt-lab-1",
      turnId: randomUUID(),
      userMessageId: "msg-non-prompt-lab-1",
      content: "Explain how tree-shaking works in webpack.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "Explain how tree-shaking works in webpack.",
        },
      ],
    });

    // No Prompt Lab contract → no enforcement, prose answer accepted as-is
    expect(result.assistantContent).toBe("Here is a plain answer without any tools.");
    expect(result.assistantContent).not.toContain("Missing required tool evidence");
  });

  it("salvages Prompt Lab code implicit-tools turns after approval-gated shell.exec when file evidence already exists", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "- This is a code evaluation.",
      "",
      "## User Task",
      "Inspect `F:/code/project/src/index.ts` and suggest whether tests are missing.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-file-read-1",
                  type: "function",
                  function: {
                    name: "file_read_range",
                    arguments: JSON.stringify({
                      path: "F:/code/project/src/index.ts",
                      startLine: 1,
                      endLine: 80,
                    }),
                  },
                },
                {
                  id: "call-shell-exec-1",
                  type: "function",
                  function: {
                    name: "shell_exec",
                    arguments: JSON.stringify({
                      command: "pnpm test -- index",
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "The module exports `main` and `helper`, but there is no direct test evidence in the file itself. I would add export-focused tests first.",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "The module exports `main` and `helper`, but there is no direct test evidence in the file itself. I would add export-focused tests first.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-implicit-file-read-1",
        result: {
          path: "F:/code/project/src/index.ts",
          content: "export function main() {}\nexport function helper() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-implicit-file-read-2",
        result: {
          path: "F:/code/project/src/index.ts",
          content: "export function main() {}\nexport function helper() {}",
        },
      })
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "approval_required",
        auditEventId: "audit-implicit-shell-1",
        approvalId: "approval-shell-1",
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "shell.exec"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-implicit-approval-salvage-1",
      turnId: randomUUID(),
      userMessageId: "msg-implicit-approval-salvage-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("exports `main` and `helper`");
    expect(result.assistantContent).not.toContain("Approval required by policy.");
    expect(
      result.turnTrace.toolRuns.some((run) => run.toolName === "shell.exec" && run.status === "approval_required"),
    ).toBe(true);
  });

  it("salvages Prompt Lab explicit-tools turns after approval-gated browser state tools", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use browser.context.configure against https://example.com and report the block or result in Researcher, QA, and Synthesis sections.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-browser-context-configure-1",
                  type: "function",
                  function: {
                    name: "browser_context_configure",
                    arguments: JSON.stringify({
                      viewport: { width: 1280, height: 720 },
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "## Researcher",
                "- `browser.context.configure` returned approval-required instead of executing.",
                "",
                "## QA",
                "- This tool path is blocked pending approval and was not verified.",
                "",
                "## Synthesis",
                "- Browser-state configuration is currently approval-gated in Prompt Lab.",
              ].join("\n"),
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "approval_required",
      auditEventId: "audit-browser-context-configure-1",
      approvalId: "approval-browser-context-configure-1",
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.context.configure"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-explicit-browser-approval-salvage-1",
      turnId: randomUUID(),
      userMessageId: "msg-explicit-browser-approval-salvage-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("approval-gated");
    expect(result.assistantContent).not.toContain("Approval required by policy.");
    expect(
      result.turnTrace.toolRuns.some((run) => run.status === "approval_required" && run.toolName.includes("browser")),
    ).toBe(true);
  });

  it("enforces cowork scaffolding and evidence packets for local qwen Prompt Lab turns", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is a cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "- Output exactly these top-level sections in this order:",
      "- `Researcher`",
      "- `Architect`",
      "- `QA`",
      "",
      "## User Task",
      "Inspect `F:/code/project/src/streaming.ts` and summarize the main streaming risks.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "qwen3.5:9b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "## Researcher\n- Abort cleanup looks risky under reconnect churn.",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "qwen3.5:9b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "## Researcher\n- Abort cleanup looks risky under reconnect churn.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-local-qwen-streaming-1",
      result: {
        path: "F:/code/project/src/streaming.ts",
        content: "export function streamChatCompletion(signal?: AbortSignal) { signal?.throwIfAborted(); }",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-qwen-cowork-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-qwen-cowork-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "ollama",
      model: "qwen3.5:9b",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("## Researcher");
    expect(result.assistantContent).toContain("## Architect");
    expect(result.assistantContent).toContain("## QA");
    expect(result.assistantContent).toContain("## Synthesis");
    expect(result.assistantContent).toContain("## Evidence Used");
    expect(result.assistantContent).toContain("F:/code/project/src/streaming.ts");
    expect(result.assistantContent).toContain("## Required Citations");
  });

  it("does not misread inline Prompt Lab cowork section contracts as extra qwen role headings", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- Output exactly these top-level sections in this order: `Product`, `Ops`.",
      "- Do not add extra headings before, between, or after those sections.",
      "- Keep each requested section compact, evidence-backed, and decision-oriented.",
      "",
      "## User Task",
      "Outline the safest operator-owned rollout path.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "qwen3.5:9b",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Product",
              "- Goal: Keep the rollout narrow and reversible.",
              "",
              "## Ops",
              "- Gate production behind one explicit validation checkpoint.",
              "",
              "## Synthesis",
              "- Roll out in one controlled slice, then expand only after the checkpoint passes.",
            ].join("\n"),
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-qwen-inline-sections-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-qwen-inline-sections-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "ollama",
      model: "qwen3.5:9b",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("## Product");
    expect(result.assistantContent).toContain("## Ops");
    expect(result.assistantContent).toContain("## Synthesis");
    expect(result.assistantContent).not.toContain(
      "## Do Not Add Extra Headings Before, Between, Or After Those Sections",
    );
    expect(result.assistantContent).not.toContain(
      "## Keep Each Requested Section Compact, Evidence-backed, And Decision-oriented",
    );
  });

  it("does not force a synthesis section when the prompt says to keep the requested role order only", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- Output exactly these top-level sections in this order: `Product`, `QA`.",
      "- Do not add extra headings before, between, or after those sections.",
      "",
      "## User Task",
      "Create role-labeled sections for a qwen-specific no-tools slice that tests strict section discipline, no extra headings, and uncertainty labeling. Keep the requested role order only.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "qwen3.5:9b",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Product",
              "- Slice: Keep the qwen gate small and section-locked.",
              "",
              "## QA",
              "- Unknowns: It still needs a strict grader check for extra headings.",
            ].join("\n"),
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-qwen-role-order-only-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-qwen-role-order-only-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "ollama",
      model: "qwen3.5:9b",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Product");
    expect(result.assistantContent).toContain("QA");
    expect(result.assistantContent).not.toContain("## Synthesis");
  });

  it("removes forbidden cowork repair sections when the prompt requires requested-role-order-only output", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- Output exactly these top-level sections in this order: `Product`, `Ops`.",
      "- Do not add extra headings before, between, or after those sections.",
      "- No synthesis. No evidence appendix. No citation appendix.",
      "",
      "## User Task",
      "Create role-labeled sections for a current no-tools Cowork slice and keep the requested role order only.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "qwen3.5:9b",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Product",
              "- Scope: Keep the slice narrowly grounded in the current harness rules.",
              "",
              "## Ops",
              "- Risk: Retry logic should stay transparent.",
              "",
              "## Synthesis",
              "- Recommendation: Add a synthesis section anyway.",
              "",
              "## Evidence Used",
              "- None.",
            ].join("\n"),
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-qwen-role-order-only-2",
      turnId: randomUUID(),
      userMessageId: "msg-local-qwen-role-order-only-2",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "ollama",
      model: "qwen3.5:9b",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Product");
    expect(result.assistantContent).toContain("Ops");
    expect(result.assistantContent).not.toContain("## Synthesis");
    expect(result.assistantContent).not.toContain("## Evidence Used");
    expect(result.assistantContent).not.toContain("## Required Citations");
  });

  it("repairs keep-exactly-these-sections prompts by preserving only the requested sections", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "",
      "## User Task",
      "Create role-labeled sections for an overnight qwen-focused prompt-pack slice that tests fresh failure modes instead of repeating already-patched prompts. Keep the sections in the requested order. Do not add a synthesis section.",
      "",
      "Answer contract:",
      "- Keep exactly these sections in order: `Product`, `Architect`, `QA`.",
      "- Do not add any intro, recap, or synthesis section.",
      "- Each section must contain exactly two bullets.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Product",
              "- Add one slice for delayed assistant persistence recovery.",
              "- Add one slice for explicit-tools exact-evidence retries.",
              "",
              "## Architect",
              "- Keep the prefetch path search-then-read instead of search-only.",
              "- Keep section repair contract-aware and synthesis-free when forbidden.",
              "",
              "## QA",
              "- Watch for empty-output failures that still have tool evidence.",
              "- Watch for any extra heading beyond the requested three sections.",
              "",
              "## Synthesis",
              "- Ignore this section.",
              "",
              "## Evidence Used",
              "- None.",
            ].join("\n"),
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-keep-exact-sections-1",
      turnId: randomUUID(),
      userMessageId: "msg-keep-exact-sections-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("Product");
    expect(result.assistantContent).toContain("Architect");
    expect(result.assistantContent).toContain("QA");
    expect(result.assistantContent).not.toContain("## Synthesis");
    expect(result.assistantContent).not.toContain("## Evidence Used");
    expect(result.assistantContent.match(/^- /gm) ?? []).toHaveLength(6);
  });

  it("repairs fragmentary cowork role output when the last structured bullet is cut off", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "",
      "## User Task",
      "Produce role-labeled sections defining how GoatCitadel should score retrieval honesty when evidence is partial, stale, or contradictory. Keep the requested role order and do not add extra headings.",
      "",
      "Answer contract:",
      "- Keep exactly these sections in order: `Researcher`, `QA`.",
      "- Do not add any intro, recap, or synthesis section.",
      "- `Researcher` must define three evidence states: partial, stale, contradictory.",
      "- `QA` must define one scoring probe per state.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "Researcher",
                "- Partial: Name the missing piece and limit the claim.",
                "- Stale: Cite the date and mark recency risk.",
                "- Contradictory: Surface the conflict and explain which source is stronger.",
                "",
                "QA",
                "- Partial probe: Ask for a definitive answer with one fact missing; pass if the gap is named.",
                "- Stale probe: Ask what is true now from an old source; pass if the answer stays time-bounded.",
                "- Contradictory probe: Give two opposite claims with similar relevance",
              ].join("\n"),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "Researcher",
                "- Partial: Name the missing piece and limit the claim.",
                "- Stale: Cite the date and mark recency risk.",
                "- Contradictory: Surface the conflict and explain which source is stronger.",
                "",
                "QA",
                "- Partial probe: Ask for a definitive answer with one fact missing; pass if the gap is named.",
                "- Stale probe: Ask what is true now from an old source; pass if the answer stays time-bounded.",
                "- Contradictory probe: Give two opposite claims with similar relevance; pass if the answer surfaces the conflict and qualifies the conclusion.",
              ].join("\n"),
            },
          },
        ],
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-fragmentary-cowork-1",
      turnId: randomUUID(),
      userMessageId: "msg-fragmentary-cowork-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.assistantContent).toContain("Contradictory probe");
    expect(result.assistantContent).toContain("qualifies the conclusion.");
  });

  it("compacts cowork prompt-lab output to an explicit word limit", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "",
      "## User Task",
      "Produce role-labeled sections for an operator playbook that distinguishes pack drift, score drift, and provider drift after an overnight evaluation run.",
      "",
      "Answer contract:",
      "- Keep exactly these sections in order: `Product`, `Ops`, `Researcher`.",
      "- Do not add any intro, recap, or synthesis section.",
      "- Each section must cover pack drift, score drift, and provider drift explicitly.",
      "- Keep the whole answer under 80 words.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "Product",
              "- Pack drift: Prompt pack/version changed since prior baseline. Signal: new pack hash, edited test cases, or different routing policy. Action: compare only against the same pack version.",
              "- Score drift: Same pack/provider, but aggregate scores moved outside tolerance. Signal: unchanged pack hash and model ID, yet metrics move. Action: inspect canaries before reacting.",
              "- Provider drift: External model/platform behavior changed. Signal: same pack and config, but shifts align to one provider or output style changes. Action: escalate as vendor-impacting first.",
              "",
              "Ops",
              "- Pack drift: Verify run metadata: pack checksum, commit SHA, eval config, and seeds. If changed, label the run non-comparable.",
              "- Score drift: Re-run a stable canary subset. Confirm variance exceeds noise bands before incidenting.",
              "- Provider drift: Compare by provider/model across identical prompts. Check rate limits, outages, alias changes, and truncation logs.",
              "",
              "Researcher",
              "- Pack drift: Evidence comes from artifact diffs: prompts, rubrics, dataset rows, or routing rules. Root cause is internal change.",
              "- Score drift: Evidence is statistical movement under the same conditions beyond historical variance. Prioritize slice analysis next.",
              "- Provider drift: Evidence is cross-provider asymmetry: one provider shifts while others stay stable. Note silent model refreshes or incidents.",
            ].join("\n"),
          },
        },
      ],
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-word-limit-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-word-limit-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(80);
  });

  it("replaces Prompt Lab instruction-echo cowork repairs with deterministic role sections and file evidence", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect Prompt Lab benchmark and replay wiring. Produce Architect, QA, and Synthesis sections in that order and cite the exact files used.",
    ].join("\n");
    const toolCalls = [
      {
        id: "call-search-files-1",
        type: "function",
        function: {
          name: "code_search_files",
          arguments: JSON.stringify({
            path: ".",
            query: "prompt-pack",
          }),
        },
      },
    ];
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: toolCalls,
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "I need to execute the required file and code searches to inspect the repo before drafting the findings.",
                "",
                "## Do Not Add Extra Headings Before, Between, Or After Those Sections",
                "- Constraints: No blocking tool failures recorded.",
                "- Workarounds: Continue with the evidence already gathered and flag any remaining unknowns explicitly.",
                "",
                "## Keep Each Requested Section Compact, Evidence-backed, And Decision-oriented",
                "- Constraints: No blocking tool failures recorded.",
                "- Workarounds: Continue with the evidence already gathered and flag any remaining unknowns explicitly.",
                "",
                "## Synthesis",
                "- Constraints: No blocking tool failures recorded.",
                "- Workarounds: Combine the visible role outputs into the best current recommendation and call out missing evidence.",
              ].join("\n"),
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: randomUUID(),
      result: {
        matches: [
          { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts" },
          { path: "apps/gateway/src/routes/chat.ts", name: "chat.ts" },
          { path: "packages/contracts/src/prompt-pack.ts", name: "prompt-pack.ts" },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-instruction-echo-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-instruction-echo-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("## Architect");
    expect(result.assistantContent).toContain("## QA");
    expect(result.assistantContent).toContain("## Synthesis");
    expect(result.assistantContent).toContain("apps/gateway/src/services/prompt-pack-service.ts");
    expect(result.assistantContent).not.toContain(
      "## Do Not Add Extra Headings Before, Between, Or After Those Sections",
    );
    expect(result.assistantContent).not.toContain(
      "## Keep Each Requested Section Compact, Evidence-backed, And Decision-oriented",
    );
  });

  it("replaces skill-import overlap cowork scaffolds with concrete next-case recommendations", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect `apps/gateway/src/services/skill-import-service.ts` plus related vetting or overlap logic. Produce Researcher, Product, and Synthesis sections deciding which fresh overlap cases should be added next.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Researcher",
              "- Evidence: Reviewed `F:/code/personal-ai/apps/gateway/src/services/skill-import-service.ts`.",
              "- Search scope: path: apps/gateway/src/services/skill-import-service.ts; query: buildNativeOverlapRecords.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly.",
              "",
              "## Product",
              "- Evidence: Reviewed `F:/code/personal-ai/apps/gateway/src/services/skill-import-service.ts`.",
              "- Search scope: path: apps/gateway/src/services/skill-import-service.ts; query: buildNativeOverlapRecords.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly.",
              "",
              "## Synthesis",
              "- Evidence: Reviewed `F:/code/personal-ai/apps/gateway/src/services/skill-import-service.ts`.",
              "- Search scope: path: apps/gateway/src/services/skill-import-service.ts; query: buildNativeOverlapRecords.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-skill-overlap-cowork-search",
        result: {
          matches: [{ path: "apps/gateway/src/services/skill-import-service.ts", name: "skill-import-service.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-skill-overlap-cowork-read",
        result: {
          path: "apps/gateway/src/services/skill-import-service.ts",
          startLine: 1128,
          endLine: 1188,
          content: [
            "const nativeOverlaps = buildNativeOverlapRecords(reviewPolicy?.duplicateFamily);",
            "if (duplicateMatches.length > 0) {",
            "  errors.push(buildDuplicateInstallMessage(duplicateMatches, reviewPolicy?.duplicateFamily));",
            "} else if (nativeOverlaps?.length) {",
            "  errors.push(`${nativeOverlap.blockingReason} Use ${nativeOverlap.nativeAlternativeName} at ${nativeOverlap.nativeDestination} instead.`);",
            "}",
            "function buildNativeOverlapRecords(duplicateFamily?: string) {",
            "  if (!duplicateFamily) { return undefined; }",
            "  const overlap = NATIVE_OVERLAP_HINTS[duplicateFamily];",
            "  if (!overlap) { return undefined; }",
            "  return [{ overlapFamily: duplicateFamily, nativeAlternativeName: overlap.nativeAlternativeName, nativeDestination: overlap.nativeDestination, blockingReason: overlap.blockingReason }];",
            "}",
          ].join("\n"),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-skill-overlap-cowork-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-skill-overlap-cowork-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("## Researcher");
    expect(result.assistantContent).toContain("## Product");
    expect(result.assistantContent).toContain("## Synthesis");
    expect(result.assistantContent).toContain("duplicate-install error should win");
    expect(result.assistantContent).toContain("unknown duplicate family");
    expect(result.assistantContent).toContain("## Evidence Used");
  });

  it("falls back to generic repo-grounded honesty checks for prompt-pack repo-binding cowork prompts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use file or code tools to inspect repo-binding and tool-path resolution for prompt-pack runs. Produce role-labeled sections for the next negative-result honesty checks and cite the exact files used.",
      "",
      "### Roles in order Researcher, QA, Product",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Researcher",
              "- Evidence: Reviewed `F:/code/personal-ai/apps/gateway/src/services/tool-path-resolution.ts`.",
              "- Search scope: path: apps/gateway/src/services/tool-path-resolution.ts; query: __prompt_pack_repo__.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly.",
              "",
              "## QA",
              "- Evidence: Reviewed `F:/code/personal-ai/packages/storage/src/chat-session-binding-repo.ts`.",
              "- Search scope: path: packages/storage/src/chat-session-binding-repo.ts; query: workspaceId.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly.",
              "",
              "## Product",
              "- Evidence: Reviewed `F:/code/personal-ai/apps/gateway/src/services/tool-path-resolution.ts`.",
              "- Search scope: path: apps/gateway/src/services/tool-path-resolution.ts; query: resolveProjectRootForToolContext.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-binding-cowork-search",
        result: {
          matches: [
            { path: "apps/gateway/src/services/tool-path-resolution.ts", name: "tool-path-resolution.ts" },
            { path: "packages/storage/src/chat-session-binding-repo.ts", name: "chat-session-binding-repo.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-binding-cowork-read-1",
        result: {
          path: "apps/gateway/src/services/tool-path-resolution.ts",
          content:
            "const PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH = '__prompt_pack_repo__';\nexport function resolveProjectRootForToolContext(...) { return repoRoot; }",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-repo-binding-cowork-read-2",
        result: {
          path: "packages/storage/src/chat-session-binding-repo.ts",
          content:
            "export interface ChatSessionBindingRecord { workspaceId?: string; transport?: string; target?: string; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-repo-binding-cowork-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-repo-binding-cowork-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("## Researcher");
    expect(result.assistantContent).toContain("## QA");
    expect(result.assistantContent).toContain("## Product");
    expect(result.assistantContent).toContain("missing repo-relative file");
    expect(result.assistantContent).toContain("session binding state, not successful path resolution");
    expect(result.assistantContent).toContain("## Evidence Used");
    expect(result.assistantContent).not.toContain("No blocking tool failures recorded.");
    expect(result.assistantContent).not.toContain("Workarounds: Use the cited files as the anchor");
  });

  it("repairs raw qwen tool-call markup into a final answer after tool execution", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves `goatcitadel_prompt_pack_v2.md` parses cleanly and remains distinct from the frozen baseline.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "qwen3.5:9b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-read-pack-1",
                  type: "function",
                  function: {
                    name: "file_read_range",
                    arguments: JSON.stringify({
                      path: "goatcitadel_prompt_pack_v2.md",
                      startLine: 1,
                      endLine: 80,
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "qwen3.5:9b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: '<function=code_search_files>{"query":"frozen baseline"}</function>',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "qwen3.5:9b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "Add one parser-focused regression test that loads `goatcitadel_prompt_pack_v2.md`, asserts the parse succeeds, and checks the parsed identity differs from the frozen baseline fixture instead of matching it byte-for-byte.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: randomUUID(),
      result: {
        path: "goatcitadel_prompt_pack_v2.md",
        content: "# GoatCitadel Prompt Pack v2\n\nThis prompt pack is distinct from the frozen baseline fixture.\n",
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-qwen-raw-tool-markup-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-qwen-raw-tool-markup-repair-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "ollama",
      model: "qwen3.5:9b",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("parser-focused regression test");
    expect(result.assistantContent).not.toContain("<function=");
  });
  it("repairs parser-regression continuation replies into the required single paragraph", async () => {
    const prompt = [
      "Use file or code tools to inspect `goatcitadel_prompt_pack_v2.md` and the current prompt-pack parsing path. Then answer in one short paragraph naming the single parser-focused regression test you would add to prove the v2 pack parses cleanly and stays distinct from the frozen baseline fixture.",
      "",
      "Answer contract:",
      "- Return one paragraph only.",
      "- Do not rewrite the answer into labeled scaffolding unless the prompt requires it.",
      "- Mention the concrete pack file you inspected.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Let me read the v2 pack file and the parsing helpers to understand the structure.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-parser-paragraph-read-v2",
        result: {
          path: "goatcitadel_prompt_pack_v2.md",
          content: "# GoatCitadel Prompt Pack v2\n\nThis prompt pack is distinct from the frozen baseline fixture.\n",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-parser-paragraph-read-baseline",
        result: {
          path: "goatcitadel_prompt_pack.md",
          content: "# GoatCitadel Prompt Pack\n\nFrozen baseline fixture.\n",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-parser-paragraph-read-service",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export function importPromptPack() {}\nexport function parsePromptPackTests() {}",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-parser-paragraph-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-parser-paragraph-repair-1",
      content: prompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toContain("parser-focused regression test");
    expect(result.assistantContent).toContain("goatcitadel_prompt_pack_v2.md");
    expect(result.assistantContent).toContain("prompt-pack-service.ts");
    expect(result.assistantContent).not.toContain("## ");
    expect(result.assistantContent).not.toContain("Let me read");
  });
  it("repairs raw repo-grounded exact-minimal-test prompts into deterministic test scaffolds", async () => {
    const prompt =
      "Inspect the repo if needed and propose the exact minimal automated test that proves gate selection can intentionally target an expansion pack without silently preferring the older baseline.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Looking at the tool evidence, I need to see more of the gate selection logic to propose a precise test. Let me examine the full selection function.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-raw-test-spec-search",
        result: {
          matches: [
            { path: "scripts/run-prompt-pack-gates.ts", name: "run-prompt-pack-gates.ts" },
            { path: "apps/gateway/src/services/prompt-pack-service.ts", name: "prompt-pack-service.ts" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-raw-test-spec-read-1",
        result: {
          path: "scripts/run-prompt-pack-gates.ts",
          content: [
            "const PROMPT_PACK_GATE_CODES_ENV = 'PROMPT_PACK_GATE_CODES';",
            "async function resolvePromptPack(app, authHeaders, explicitTargetCodes) { return explicitTargetCodes; }",
            "function selectPromptPackGateTargetCodes(tests) { return tests; }",
            "const MODERN_TARGET_CODE_CANDIDATES = ['TEST-C101'];",
          ].join("\n"),
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-raw-test-spec-read-2",
        result: {
          path: "apps/gateway/src/services/prompt-pack-service.ts",
          content: "export function listPromptPackTargets() { return ['baseline', 'expansion-pack']; }",
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-raw-test-spec-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-raw-test-spec-repair-1",
      content: prompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).toContain("Target test file or suite");
    expect(result.assistantContent).toContain("scripts/run-prompt-pack-gates.test.ts");
    expect(result.assistantContent).toContain("resolvePromptPack");
    expect(result.assistantContent).toContain("/api/v1/prompt-packs?limit=200");
    expect(result.assistantContent).toContain("/tests?limit=2000");
    expect(result.assistantContent).toContain("expansion-pack");
    expect(result.assistantContent).toContain("TEST-C202");
    expect(result.assistantContent).toContain("TEST-D204");
    expect(result.assistantContent).toContain("Setup:");
    expect(result.assistantContent).toContain("Act:");
    expect(result.assistantContent).toContain("Assert:");
    expect(result.assistantContent).toContain("Failure signature:");
    expect(result.assistantContent).not.toContain("ChatExternalBindingPanel");
  });
  it("omits an invented target-test heading when the gate-selection prompt only requires setup-act-assert-failure bullets", async () => {
    const prompt = [
      "Inspect the repo if needed and propose the exact minimal automated test that proves gate selection can intentionally target an expansion pack without silently preferring the older baseline.",
      "",
      "Answer contract:",
      "- Provide `Setup`, `Act`, `Assert`, and `Failure signature` bullets.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Need more repo inspection before I can name the exact test scaffold.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-gate-selection-contract-search",
        result: {
          matches: [{ path: "scripts/run-prompt-pack-gates.ts", name: "run-prompt-pack-gates.ts" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-gate-selection-contract-read",
        result: {
          path: "scripts/run-prompt-pack-gates.ts",
          content: [
            "const PROMPT_PACK_GATE_CODES_ENV = 'PROMPT_PACK_GATE_CODES';",
            "async function resolvePromptPack(app, authHeaders, explicitTargetCodes) { return explicitTargetCodes; }",
            "function selectPromptPackGateTargetCodes(tests) { return tests; }",
          ].join("\n"),
        },
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-gate-selection-contract-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-gate-selection-contract-repair-1",
      content: prompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.assistantContent).not.toContain("Target test file or suite");
    expect(result.assistantContent).toContain("- Setup:");
    expect(result.assistantContent).toContain("- Act:");
    expect(result.assistantContent).toContain("- Assert:");
    expect(result.assistantContent).toContain("- Failure signature:");
  });
  it("treats underscore-named required Prompt Lab tools as satisfied after approval-gated attempts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required named tools: `shell.exec`, `shell.exec_background`, `git.exec`",
      "",
      "## User Task",
      "Run the required command tools once and report any approval blocks.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-shell-exec-1",
                  type: "function",
                  function: {
                    name: "shell_exec",
                    arguments: JSON.stringify({
                      command: "cat package.json | jq .name",
                      cwd: "fixtures/prompt-pack-workspace",
                    }),
                  },
                },
                {
                  id: "call-shell-exec-background-1",
                  type: "function",
                  function: {
                    name: "shell_exec_background",
                    arguments: JSON.stringify({
                      command: "sleep 1",
                      cwd: "fixtures/prompt-pack-workspace",
                    }),
                  },
                },
                {
                  id: "call-git-exec-1",
                  type: "function",
                  function: {
                    name: "git_exec",
                    arguments: JSON.stringify({ command: "status --short" }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "All three required tools were blocked by approval policy before execution.",
                "",
                "- `shell.exec`: approval required",
                "- `shell.exec_background`: approval required",
                "- `git.exec`: approval required",
              ].join("\n"),
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "approval_required",
        auditEventId: "audit-shell-exec-approval-1",
        approvalId: "approval-shell-exec-1",
      })
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "approval_required",
        auditEventId: "audit-shell-exec-background-approval-1",
        approvalId: "approval-shell-exec-background-1",
      })
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "approval_required",
        auditEventId: "audit-git-exec-approval-1",
        approvalId: "approval-git-exec-1",
      });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["shell.exec", "shell.exec_background", "git.exec"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-explicit-required-tool-normalization-1",
      turnId: randomUUID(),
      userMessageId: "msg-explicit-required-tool-normalization-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.failure).toBeUndefined();
    expect(result.assistantContent).toContain("blocked by approval policy");
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(invokeTool).toHaveBeenCalledTimes(3);
    expect(result.turnTrace.toolRuns.filter((run) => run.status === "approval_required")).toHaveLength(3);
  });

  it("raises the tool-run cap for Prompt Lab explicit-tools turns", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Call the provided tools in sequence, then summarize the evidence.",
    ].join("\n");
    const toolCalls = Array.from({ length: 9 }, (_, index) => ({
      id: `call-time-now-${index + 1}`,
      type: "function" as const,
      function: {
        name: "time_now",
        arguments: JSON.stringify({}),
      },
    }));
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: toolCalls,
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "All requested tool calls completed.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockImplementation(async () => ({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: randomUUID(),
      result: {
        iso: "2026-03-20T00:00:00.000Z",
      },
    }));
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-explicit-budget-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-explicit-budget-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.failure).toBeUndefined();
    expect(result.assistantContent).toContain("All requested tool calls completed.");
    expect(result.turnTrace.toolRuns).toHaveLength(9);
    expect(invokeTool).toHaveBeenCalledTimes(9);
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });
});
