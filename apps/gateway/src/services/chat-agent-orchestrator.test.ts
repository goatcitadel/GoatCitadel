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
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import type { McpBrowserFallbackTarget } from "./mcp-runtime.js";

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
        preferredForIntents: ["local_file", "inspect_code", toolName === "code.search" ? "search_code" : "search_files"],
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

function httpPostToolCallCompletion(args: Record<string, unknown>): ChatCompletionResponse {
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
              id: "call-http-post-1",
              type: "function",
              function: {
                name: "http_post",
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
  };
}

describe("ChatAgentOrchestrator", () => {
  it("tolerates missing execution-plan storage while building the tool schema", async () => {
    const storage = createMockStorage() as Record<string, unknown>;
    delete storage.chatExecutionPlans;
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValue(
      toolCallCompletion("latest ai tooling"),
    );
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

  it("maps auth failures to reconnect auth recovery guidance", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>()
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
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>()
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

    expect(invokeTool).toHaveBeenNthCalledWith(2, expect.objectContaining({
      toolName: "browser.navigate",
      args: expect.objectContaining({
        url: "https://example.com/news/kristi-noem",
      }),
    }));
    expect(invokeTool).toHaveBeenNthCalledWith(1, expect.objectContaining({
      toolName: "browser.search",
    }));
    expect(result.assistantContent).toContain("Grounded answer");
  });

  it("normalizes generic live-news prompts into a cleaner search query", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-search-cleanup",
        result: {
          results: [
            { title: "Headline", url: "https://example.com/news/today", snippet: "top stories" },
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
      historyMessages: [{ role: "user", content: "Look online and tell me the 5 most interesting things that happened today." }],
    });

    expect(invokeTool).toHaveBeenNthCalledWith(1, expect.objectContaining({
      toolName: "browser.search",
      args: expect.objectContaining({
        query: "top news headlines today",
      }),
    }));
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
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-search-http",
        result: {
          results: [
            { title: "Kristi Noem latest news", url: "https://example.com/news/kristi-noem", snippet: "latest coverage" },
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

    const invokeToolCalls = invokeTool.mock.calls as unknown as Array<[{
      toolName: string;
      args: Record<string, unknown>;
    }]>;
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

    const preflight = (orchestrator as unknown as {
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
    }).preflightToolInvocation({
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

    const preflight = (orchestrator as unknown as {
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
    }).preflightToolInvocation({
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

    const preflight = (orchestrator as unknown as {
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
    }).preflightToolInvocation({
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

    const preflight = (orchestrator as unknown as {
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
    }).preflightToolInvocation({
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

    const preflight = (orchestrator as unknown as {
      preflightToolInvocation(input: {
        toolName: string;
        rawArgs: Record<string, unknown>;
        userContent: string;
        priorToolRuns?: ChatToolRunRecord[];
      }): {
        toolName: string;
        args: Record<string, unknown>;
      };
    }).preflightToolInvocation({
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
              { title: "Generic search results", url: "https://www.google.com/search?q=kristi+noem", snippet: "portal" },
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

  it("rewrites search-portal browser.navigate urls to a grounded result url", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (orchestrator as unknown as {
      preflightToolInvocation(input: {
        toolName: string;
        rawArgs: Record<string, unknown>;
        userContent: string;
        priorToolRuns?: ChatToolRunRecord[];
      }): {
        toolName: string;
        args: Record<string, unknown>;
      };
    }).preflightToolInvocation({
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
              { title: "Google News - Headlines", url: "https://news.google.com/topics/CAAqKggKIiRDQkFTRlFvSUwyMHZNRFZxYUdjU0JXVnVMVWRDR2dKVFJ5Z0FQAQ", snippet: "Headlines topic" },
              { title: "Reuters Top News", url: "https://www.reuters.com/world/", snippet: "Top stories from Reuters" },
            ],
          },
          startedAt: "2026-03-06T22:30:00.000Z",
          finishedAt: "2026-03-06T22:30:01.000Z",
        },
      ],
    });

    expect(preflight.toolName).toBe("browser.navigate");
    expect(preflight.args.url).toBe("https://news.google.com/topics/CAAqKggKIiRDQkFTRlFvSUwyMHZNRFZxYUdjU0JXVnVMVWRDR2dKVFJ5Z0FQAQ");
  });

  it("normalizes explicit web lookup prompts before the synthetic browser.search runs", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({
        url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
      }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "REST APIs are widely used for app backends, integrations, microservices, IoT, and public data APIs.",
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

    const firstInvokeCall = (invokeTool.mock.calls as unknown as Array<[{
      toolName: string;
      args: Record<string, unknown>;
    }]>) [0]?.[0];
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
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
      content: "Compare Node.js, Bun, and Deno runtime benchmarks. If you can find recent benchmarks or comparisons, cite them.",
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{
        role: "user",
        content: "Compare Node.js, Bun, and Deno runtime benchmarks. If you can find recent benchmarks or comparisons, cite them.",
      }],
    });

    const firstInvokeCall = (invokeTool.mock.calls as unknown as Array<[{
      toolName: string;
      args: Record<string, unknown>;
    }]>) [0]?.[0];
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
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", {
        query: "navigate - Required tool families: web lookup tools - Do not substitute memory tools unless the prompt explicitly asks for memory.",
      }))
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
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

    const firstInvokeCall = (invokeTool.mock.calls as unknown as Array<[{
      toolName: string;
      args: Record<string, unknown>;
    }]>) [0]?.[0];
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

    const preflight = (orchestrator as unknown as {
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
    }).preflightToolInvocation({
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
              { title: "What Is a REST API? Examples, Uses & Challenges - Postman Blog", url: "https://blog.postman.com/rest-api-examples/", snippet: "REST API examples and use cases." },
              { title: "what actually is a REST api? Can someone provide an example it ... - Reddit", url: "https://www.reddit.com/r/learnprogramming/comments/17kkjas/what_actually_is_a_rest_api_can_someone_provide/", snippet: "Community discussion." },
              { title: "What is a REST API? Benefits, Uses, Examples - TechTarget", url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API", snippet: "REST APIs are used for software interoperability." },
            ],
          },
          startedAt: "2026-03-12T22:30:00.000Z",
          finishedAt: "2026-03-12T22:30:01.000Z",
        },
      ],
    });

    expect(preflight.toolName).toBe("browser.navigate");
    expect(preflight.args.url).not.toBe("https://www.reddit.com/r/learnprogramming/comments/17kkjas/what_actually_is_a_rest_api_can_someone_provide/");
    expect([
      "https://blog.postman.com/rest-api-examples/",
      "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
    ]).toContain(preflight.args.url);
  });

  it("does not inject browser.search for generic duration prompts containing time", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
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
    expect(invokeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "time.now",
    }));
  });

  it("does not promote repeated search when recent results have no sufficiently relevant URL", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (orchestrator as unknown as {
      preflightToolInvocation(input: {
        toolName: string;
        rawArgs: Record<string, unknown>;
        userContent: string;
        priorToolRuns?: ChatToolRunRecord[];
      }): {
        toolName: string;
        args: Record<string, unknown>;
      };
    }).preflightToolInvocation({
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
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-grounding",
        result: {
          results: [
            { title: "Top story", url: "https://example.com/top-story", snippet: "Important news" },
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const completionCall = (createChatCompletion as any).mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const messages = completionCall?.messages as Array<{ role: string; content?: unknown }> | undefined;
    const systemMessages = messages?.filter((msg) => msg.role === "system") ?? [];
    const groundingMsg = systemMessages.find(
      (msg) => typeof msg.content === "string" && msg.content.includes("Evidence grounding"),
    );
    expect(groundingMsg).toBeDefined();
    expect(groundingMsg?.content as string).toContain("strictly on the tool results");
  });

  it("detects explicit web lookup phrases like 'search online' as live-data intent", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
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
    expect(invokeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "browser.search",
    }));
  });

  it("does not trigger proactive web search for generic current-state prompts", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
                content: "REST APIs are commonly used for client-server CRUD backends, third-party integrations, mobile app data sync, workflow automation, and public partner APIs.",
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
      historyMessages: [{ role: "user", content: "Summarize https://www.rfc-editor.org/rfc/rfc9110 from the page itself." }],
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
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>()
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
    const explicitSearchCalls = invokeTool.mock.calls as unknown as Array<[{ toolName: string; args: Record<string, unknown> }]>;
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
      content: "Remember this as a memory note: I prefer concise status updates. Then search memory to confirm it was saved.",
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
          content: "Remember this as a memory note: I prefer concise status updates. Then search memory to confirm it was saved.",
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
      listToolCatalog: () => createToolCatalog([
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-file-find-inferred-path-1",
        result: {
          path: "src/index.ts",
          pattern: "tasks",
          count: 1,
          matches: [
            { path: "src/index.ts", line: 15, lineText: "const tasks: Map<string, Task> = new Map();" },
          ],
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

    const firstInvokeCall = (invokeTool.mock.calls as unknown as Array<[{
      toolName: string;
      args: Record<string, unknown>;
    }]>) [0]?.[0];
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-code-search-files-inferred-1",
        result: {
          path: "fixtures/prompt-pack-workspace/",
          query: ".",
          count: 4,
          matches: [
            { path: "fixtures/prompt-pack-workspace/package.json", name: "package.json", type: "file" },
          ],
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
      content: "Read all source files in fixtures/prompt-pack-workspace/ using file tools. Produce a project audit report covering structure, code quality, and test coverage gaps.",
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
          content: "Read all source files in fixtures/prompt-pack-workspace/ using file tools. Produce a project audit report covering structure, code quality, and test coverage gaps.",
        },
      ],
    });

    const firstInvokeCall = (invokeTool.mock.calls as unknown as Array<[{
      toolName: string;
      args: Record<string, unknown>;
    }]>) [0]?.[0];
    expect(firstInvokeCall).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        path: "fixtures/prompt-pack-workspace/",
        query: ".",
      }),
    });
  });

  it("does not invent local file paths from bare technology names", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("file.read_range", {
        startLine: 1,
        endLine: 20,
      }))
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
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
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
    expect(invokeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "browser.search",
      args: expect.objectContaining({
        query: "What movies are coming out this week",
      }),
    }));
  });

  it("retries remote-blocked browser navigation through MCP fallback tiers", async () => {
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
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
    const invokeMcpTool = vi
      .fn<() => Promise<McpInvokeResponse>>()
      .mockResolvedValueOnce({
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

    const executed = await (orchestrator as unknown as {
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
    }).executeToolCall({
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
    expect(invokeMcpTool).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "srv-playwright",
      toolName: "browser.navigate",
      arguments: expect.objectContaining({
        url: "https://movieinsider.com/movies",
      }),
    }));
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
      const invokeTool = vi
        .fn<() => Promise<ToolInvokeResult>>()
        .mockResolvedValueOnce({
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

      const executed = await (orchestrator as unknown as {
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
      }).executeToolCall({
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

    const preflight = (orchestrator as unknown as {
      preflightToolInvocation(input: {
        toolName: string;
        rawArgs: Record<string, unknown>;
        userContent: string;
        priorToolRuns?: ChatToolRunRecord[];
      }): {
        toolName: string;
        args: Record<string, unknown>;
      };
    }).preflightToolInvocation({
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
              { title: "Movies coming out this week - IMDb", url: "https://www.imdb.com/calendar/", snippet: "Upcoming releases this week." },
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValue({
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
              content: "The main REST API use cases are CRUD, integrations, mobile backends, automation, and partner-facing services.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValue({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-retry-grounded-1",
        result: {
          query: "top 5 ways REST APIs are used",
          results: [
            { title: "What Is REST API? Examples, Uses & Challenges - Postman Blog", url: "https://blog.postman.com/rest-api-examples/", snippet: "Examples and common use cases." },
            { title: "REST API Introduction - GeeksforGeeks", url: "https://www.geeksforgeeks.org/rest-api-introduction/", snippet: "REST principles and use cases." },
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
    const groundedRetryCalls = invokeTool.mock.calls as unknown as Array<[{ toolName: string; args: Record<string, unknown> }]>;
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValue({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-queries-grounded-1",
        result: {
          query: "top 5 ways REST APIs are used common use cases",
          results: [
            { title: "What Is REST API? Examples, Uses & Challenges - Postman Blog", url: "https://blog.postman.com/rest-api-examples/", snippet: "Examples and common use cases." },
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
          content: "A source blocked automated browsing on blog.postman.com, so I'm falling back to the strongest leads I recovered so far.",
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
              content: "REST APIs are commonly used for CRUD app backends, third-party integrations, mobile app services, workflow automation, and partner/public APIs.",
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
            { title: "What Is REST API? Examples, Uses & Challenges - Postman Blog", url: "https://blog.postman.com/rest-api-examples/", snippet: "Examples and use cases." },
            { title: "How to Use REST API: Examples, Key Features, and Applications - ClickUp", url: "https://clickup.com/blog/rest-api-examples/", snippet: "Key features and real-world applications." },
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
      historyMessages: [{ role: "user", content: "Can you look online into the top 5 ways that a REST API can be used?" }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(3);
    const navigateRetryCalls = invokeTool.mock.calls as unknown as Array<[{ toolName: string; args: Record<string, unknown> }]>;
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
              content: "REST APIs are commonly used for web and mobile apps, integrations, microservices, IoT, and internal tooling.",
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
            { title: "What Is a REST API? Examples, Uses & Challenges - Postman Blog", url: "https://blog.postman.com/rest-api-examples/", snippet: "What is a REST API? Examples, Uses & Challenges - Postman Blog." },
            { title: "What is a REST API? Benefits, Uses, Examples - TechTarget", url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API", snippet: "A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data." },
            { title: "What is a REST API? Examples, Use Cases, and Best Practices", url: "https://www.browserstack.com/guide/rest-api", snippet: "Learn REST API basics with real-world REST API examples, key principles, architectural constraints, and best practices for reliable design." },
            { title: "REST API basics and implementation | Google Cloud", url: "https://cloud.google.com/discover/what-is-rest-api", snippet: "Learn what a REST API is, how it works, and its core principles." },
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
          textSnippet: "REST APIs are used for web and mobile backends, integrations with third-party services, partner APIs, and automation workflows.",
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

    const navigateCalls = (invokeTool.mock.calls as unknown as Array<[{ toolName: string; args: Record<string, unknown> }]>)
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
                  content: "The top REST API uses are CRUD backends, third-party integrations, mobile app services, workflow automation, and partner-facing APIs.",
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
              finalUrl: "https://www.techtarget.com/searchapparchitecture/tip/The-5-essential-HTTP-methods-in-RESTful-API-development",
              status: 200,
              title: "The 5 essential HTTP methods in RESTful API development | TechTarget",
              textSnippet: "REST APIs are widely used for web and mobile backends, app integrations, automation flows, and partner-facing services.",
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

    expect(result.assistantContent).toContain("REST APIs are widely used to build web services and integrate different applications.");
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
                  content: "Protobuf is usually better for compact binary transport, while JSON Schema is stronger for JSON validation, interoperability, and contract tooling.",
                },
              },
            ],
          };
        });
      const invokeTool = vi
        .fn<() => Promise<ToolInvokeResult>>()
        .mockImplementationOnce(async () => {
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
              textSnippet: "Protobuf favors binary efficiency and typed contracts. JSON Schema favors human-readable JSON validation and broader ecosystem interoperability.",
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
        historyMessages: [{ role: "user", content: "Compare protobuf and JSON Schema tradeoffs using https://example.com/protobuf-vs-json-schema." }],
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
                  snippet: "Skinning in WoW Midnight covers leveling, trainer locations, hides, tracking, and profession tools.",
                },
              ],
            },
          };
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + (31 * 60 * 1000)));
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-skinning-navigate-1",
            result: {
              url: "https://www.wowhead.com/guide/midnight/professions/skinning-overview-trainer-locations-hides-tracking-tools",
              finalUrl: "https://www.wowhead.com/guide/midnight/professions/skinning-overview-trainer-locations-hides-tracking-tools",
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
        historyMessages: [{ role: "user", content: "Look online and help me leveling my skinning profession in world of warcraft midnight." }],
      });

      expect(result.turnTrace.failure?.failureClass).toBeDefined();
      expect(result.assistantContent).toContain("Midnight Skinning Profession Overview - Wowhead");
      expect(result.assistantContent).toContain("Leveling is primarily done by skinning beasts close to your current profession skill");
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
      .mockResolvedValueOnce(navigateToolCallCompletion({
        url: "https://blog.postman.com/rest-api-examples/",
      }))
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
              snippet: "A REST API is a simple uniform interface used to make digital resources available through web URLs.",
            },
            {
              title: "What is REST API: Examples, Principles, and Use Cases",
              url: "https://requestly.com/blog/rest-api-examples/",
              snippet: "Learn what REST APIs are with practical examples such as user management, e-commerce, and payment systems.",
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
    expect(createChatCompletion).toHaveBeenCalledTimes(4);
    const invokedToolNames = (invokeTool.mock.calls as unknown as Array<[{ toolName: string }]>).map((call) => call[0].toolName);
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
      .mockResolvedValueOnce(navigateToolCallCompletion({
        url: "https://blog.postman.com/rest-api-examples/",
      }))
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
              snippet: "REST APIs are often used for user management, e-commerce workflows, payment processing, and automation across third-party services.",
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
      .mockResolvedValueOnce(navigateToolCallCompletion({
        url: "https://blog.postman.com/rest-api-examples/",
      }))
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
              snippet: "A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data.",
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
          textSnippet: "Search the TechTarget Network Login Register TechTarget Network Software Quality Cloud Computing TheServerSide Search App Architecture API Management App Development & Design App Management Tools Architecture Management EAI News Features Tips Webinars Sponsored Sites More Follow: Home API design and management Tech Accelerator Guide to building an enterprise API strategy PREV NEXT DEFINITION What is a REST API? Benefits, Uses, Examples By Scott Robinson, New Era Technology Stephen J. Bigelow, Senior Technology Editor Alexander S. Gillis, Technical Writer and Editor Published: Sep 30, 2025 A REST API is an architectural style for an application programming interface that uses Hypertext Transfer Protocol (HTTP) requests to access and use data. That data can be used to GET, PUT, POST and DELETE data types, which refers to reading, updating, creating and deleting operations related to resources. The API's design spells out the proper way for a developer to write a program, or client, that uses the API to request services from another application, or the server. APIs are a vital mechanism for software interoperability. REST APIs are also referred to as RESTful web services and RESTful APIs. This approach can also facilitate communication between other application types. REST technology is generally preferred over similar technologies because it uses less bandwidth, making it more efficient for internet use. REST APIs can also be built with common programming languages such as PHP, JavaScript and Python. Cloud consumers use APIs to expose and organize access to web services. REST is a logical choice for building APIs to provide users with ways to flexibly connect to, manage and interact with cloud services in distributed environments. Sites such as Amazon, Google, LinkedIn and Twitter use REST APIs. A REST API fundamentally relies on the following three major elements: Client. The client is the software code or application that requests a resource from a server. The server is the software code or application that controls the resource and responds to client requests for the resource. The REST API supports data formats such as application/json, application/xml, application/x-web+xml, application/x-www-form-urlencoded and multipart.",
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
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
    expect(toolRuns[1]?.result).toMatchObject({
      reusedResult: true,
      reusedPriorToolRunId: toolRuns[0]?.toolRunId,
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValue({
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
    expect(result.turnTrace.toolRuns[1]?.result).toMatchObject({
      reusedResult: true,
      reusedPriorToolRunId: result.turnTrace.toolRuns[0]?.toolRunId,
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-final-url-reuse-1",
        result: {
          url: finalUrl,
          finalUrl,
          status: 200,
          title: "What is a REST API? Benefits, uses, examples",
          textSnippet: "A REST API uses HTTP requests to access and use data. REST APIs are also referred to as RESTful web services.",
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-extract-reuse-1",
        result: {
          url: pageUrl,
          finalUrl: pageUrl,
          status: 200,
          title: "Example research",
          textSnippet: "REST APIs are used for backend services, third-party integrations, mobile apps, automation workflows, and partner APIs. This page explains those uses in detail with examples and implementation notes.",
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
      historyMessages: [{ role: "user", content: "Open one page, open another page, then extract the first page again." }],
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
      content: "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns." }],
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
      content: "Estimate the number of genuinely lonely singles in Seattle by combining demographic data, social indicators, and digital behavior patterns.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Estimate the number of genuinely lonely singles in Seattle by combining demographic data, social indicators, and digital behavior patterns." }],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("answering that responsibly");
    expect(result.assistantContent).toContain("threshold");
    expect(result.assistantContent).not.toContain("geographic area");
  });

  it("does not force clarification when both geography and qualifier are concrete", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
      content: "Estimate the number of single adults in Seattle by combining demographic data and digital behavior patterns.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Estimate the number of single adults in Seattle by combining demographic data and digital behavior patterns." }],
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
      content: "Suburbs generally lonely is defined as \"I cry myself to sleep all alone\".",
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
          content: "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
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
      historyMessages: [{ role: "user", content: "Look online and tell me the 5 most interesting things that happened today." }],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("tool autonomy is set to Manual");
    expect(result.assistantContent).toContain("Safe Auto");
  });

  it("does not trap a fresh standalone prompt in an old clarification exchange", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
          content: "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
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
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
          content: "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
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
              content: "I'd be happy to help you find weekend activities! Since it's currently Wednesday, March 11th, you're asking about the upcoming weekend (March 14-15, 2026).\n\nTo give you the best recommendations, I",
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
                { type: "output_text", text: { value: " need a bit more information about your location and interests before I suggest specific plans." } },
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
    expect(capturedTimeoutMs).toBe(30 * 60 * 1000);
  });

  it("stops alternate-URL retries when the turn budget expires mid-fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T20:00:00.000Z"));
    try {
      let navigateCallCount = 0;
      const createChatCompletion = vi
        .fn<() => Promise<ChatCompletionResponse>>()
        .mockImplementation(async () => {
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
    const navigateCalls = (invokeTool.mock.calls as unknown as Array<[{ toolName: string; args: Record<string, unknown> }]>)
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
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Researcher: risk is concentrated in migrations.\n\nArchitect: phase the rollout.\n\nSynthesis: keep the cutover staged.",
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
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Plan: inspect the repo.\n\nChanges: update the config.\n\nValidation: run the tests.\n\nRisks: watch for regressions.",
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
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
          results: [
            { title: "Article", url: "https://blocked-site.com/page", snippet: "news" },
          ],
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
        { serverId: "srv-broken", label: "Broken MCP", tier: "playwright_mcp" as const, navigateToolName: "mcp_navigate" },
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
              content: "Adopt event sourcing only if auditability and replay are first-order billing requirements; otherwise keep the current model and add targeted ledger controls.",
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

    expect(result.assistantContent).toContain("Adopt event sourcing only if auditability and replay are first-order billing requirements");
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
      content: "Evaluate whether a team should move from Heroku to Kubernetes across delivery risk, operational burden, and rollback readiness, then give one recommendation.",
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
          content: "Evaluate whether a team should move from Heroku to Kubernetes across delivery risk, operational burden, and rollback readiness, then give one recommendation.",
        },
      ],
    });

    expect(result.assistantContent).toContain("Recommendation: stay on Heroku unless you need Kubernetes-specific controls");
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
      content: "Evaluate whether a team should move from Heroku to Kubernetes across delivery risk, operational burden, and rollback readiness, then give one recommendation.",
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
          content: "Evaluate whether a team should move from Heroku to Kubernetes across delivery risk, operational burden, and rollback readiness, then give one recommendation.",
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
        content: "{\n  \"name\": \"prompt-pack-workspace\",\n  \"scripts\": {\n    \"build\": \"tsc\"\n  }\n}",
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
      content: "Read fixtures/prompt-pack-workspace/package.json using file tools. Analyze the scripts section and suggest missing scripts.",
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
          content: "Read fixtures/prompt-pack-workspace/package.json using file tools. Analyze the scripts section and suggest missing scripts.",
        },
      ],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).not.toContain("recovered item(s)");
    expect(result.assistantContent).not.toContain("deterministic crawl");
    expect(result.assistantContent).toContain("I couldn't finish that cleanly because");
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
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Researcher\n- The streaming path has abort and cleanup risk.\n\nSynthesis\n- Audit cleanup and idempotency first.",
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

    const invokedPaths = (invokeTool.mock.calls as unknown as Array<[{
      toolName: string;
      args: Record<string, unknown>;
    }]>)
      .map((call) => call[0])
      .filter((call) => call.toolName === "file.read_range")
      .map((call) => String(call.args.path));
    expect(invokedPaths).toEqual([
      "F:/code/personal-ai-mobile-app/src/api/streaming.ts",
      "F:/code/personal-ai-mobile-app/src/api/client.ts",
    ]);
    expect(result.turnTrace.toolRuns).toHaveLength(2);
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools");
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
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
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain("exports `main` and `helper`");
    expect(result.assistantContent).not.toContain("I couldn't verify that with the required tools before answering.");
    expect(createChatCompletion).toHaveBeenCalledTimes(3);
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
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
    expect(result.assistantContent).toContain("Missing required tool evidence: file/code tools.");
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
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
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
    // Two completions should have been requested (initial + retry)
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("passes non-Prompt-Lab prompts through without explicit-tools enforcement", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
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
              content: "The module exports `main` and `helper`, but there is no direct test evidence in the file itself. I would add export-focused tests first.",
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
              content: "The module exports `main` and `helper`, but there is no direct test evidence in the file itself. I would add export-focused tests first.",
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
    expect(result.turnTrace.toolRuns.some((run) => run.toolName === "shell.exec" && run.status === "approval_required")).toBe(true);
  });
});
