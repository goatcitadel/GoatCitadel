import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog, toolCallCompletion } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator stream and tool-loop behavior", () => {
  it("falls back to non-streaming completion when the stream fails before visible output", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Recovered answer.",
          },
        },
      ],
    });
    async function* createChatCompletionStream() {
      const unreachableChunks: Record<string, unknown>[] = [];
      yield* unreachableChunks;
      throw new Error("stream unavailable");
    }
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      createChatCompletionStream,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-stream-fallback-before-output",
      turnId: randomUUID(),
      userMessageId: "msg-stream-fallback-before-output",
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

    expect(result.assistantContent).toBe("Recovered answer.");
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("falls back to non-streaming completion when a tool-call-only stream fails", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Recovered after tool-call-only stream.",
          },
        },
      ],
    });
    async function* createChatCompletionStream() {
      yield {
        id: "stream-tool-call-only",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-tool-only-1",
                  type: "function",
                  function: {
                    name: "browser_search",
                    arguments: JSON.stringify({ query: "current news" }),
                  },
                },
              ],
            },
          },
        ],
      };
      throw new Error("stream interrupted after tool call");
    }
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      createChatCompletionStream,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-stream-fallback-tool-call-only",
      turnId: randomUUID(),
      userMessageId: "msg-stream-fallback-tool-call-only",
      content: "Search current news.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search current news." }],
    });

    expect(result.assistantContent).toContain("Recovered after tool-call-only stream.");
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("does not silently replace partial streamed output when the stream fails", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Replacement answer.",
          },
        },
      ],
    });
    async function* createChatCompletionStream() {
      yield {
        id: "stream-1",
        choices: [
          {
            index: 0,
            delta: { content: "Partial visible answer." },
          },
        ],
      };
      throw new Error("stream interrupted");
    }
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      createChatCompletionStream,
      invokeTool: vi.fn(),
    });

    const chunks = [];
    for await (const chunk of orchestrator.runStream({
      sessionId: "sess-stream-fallback-after-output",
      turnId: randomUUID(),
      userMessageId: "msg-stream-fallback-after-output",
      content: "Answer directly.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Answer directly." }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some((chunk) => chunk.type === "delta" && chunk.delta === "Partial visible answer.")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "error")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "message_done" && chunk.content === "Replacement answer.")).toBe(
      false,
    );
    expect(chunks.some((chunk) => chunk.type === "trace_update" && chunk.trace.status === "failed")).toBe(true);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

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
});
