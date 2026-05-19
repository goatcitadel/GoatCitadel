import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator loop37 preflight and fallback behavior", () => {
  it("infers a safe memory search query from the user prompt when the model omits it", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("memory.search", {}))
      .mockResolvedValueOnce(finalCompletion("I checked memory for the planning notes and found no durable match."));
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-loop37-memory-inferred",
      result: {
        items: [],
      },
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["memory.search"]);

    const result = await orchestrator.run(
      turnInput("sess-loop37-memory-inferred", "Release planning notes last sprint rollback windows", {
        memoryMode: "auto",
      }),
    );

    expect(result.assistantContent).toContain("planning notes");
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "memory.search",
        args: {
          query: "Release planning notes last sprint rollback windows",
        },
      }),
    );
    expect(result.turnTrace.toolRuns[0]).toMatchObject({
      toolName: "memory.search",
      status: "executed",
      args: {
        query: "Release planning notes last sprint rollback windows",
      },
    });
  });

  it("blocks memory search when neither model args nor prompt provide a safe query", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("memory.search", {}))
      .mockResolvedValueOnce(finalCompletion("I need a more specific memory query before I can search safely."));
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["memory.search"]);

    const result = await orchestrator.run(
      turnInput("sess-loop37-memory-blocked", "ok", {
        memoryMode: "auto",
      }),
    );

    expect(result.assistantContent).toContain("specific memory query");
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns[0]).toMatchObject({
      toolName: "memory.search",
      status: "blocked",
      args: {},
      error: "execution skipped: memory.search requires query; unable to infer a safe query from the prompt",
      failureGuidance: "Retry search with a narrower, more explicit input.",
    });
    const secondCompletionRequest = createChatCompletion.mock.calls[1]?.[0] as
      | { messages?: Array<{ role?: string; content?: string }> }
      | undefined;
    const toolMessage = secondCompletionRequest?.messages?.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("memory.search requires query");
  });

  it("recovers a deterministic answer when a successful tool run is followed by empty final synthesis", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "goatcitadel runtime coverage" }))
      .mockResolvedValueOnce(finalCompletion(""))
      .mockRejectedValueOnce(new Error("synthesis provider unavailable"));
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-loop37-search-result",
      result: {
        results: [
          {
            title: "Runtime coverage report",
            url: "https://example.test/runtime-coverage",
            snippet: "Coverage report shows chat-agent-orchestrator as a top uncovered runtime file.",
          },
        ],
      },
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["browser.search"]);

    const result = await orchestrator.run(
      turnInput(
        "sess-loop37-empty-synthesis",
        "Search the web for GoatCitadel runtime coverage and summarize the result.",
        {
          mode: "chat",
          webMode: "auto",
        },
      ),
    );

    expect(createChatCompletion).toHaveBeenCalledTimes(3);
    expect(result.assistantContent).toContain("Based on the sources I did retrieve");
    expect(result.assistantContent).toContain("Runtime coverage report");
    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.failure).toMatchObject({
      failureClass: "unknown",
      retryable: true,
    });
    expect(result.turnTrace.completion?.repair).toMatchObject({
      kind: "deterministic_empty_output_synthesis",
      source: "orchestrator",
      applied: true,
    });
  });
});

function createOrchestrator(
  createChatCompletion: () => Promise<ChatCompletionResponse>,
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>,
  toolNames: string[],
): ChatAgentOrchestrator {
  return new ChatAgentOrchestrator({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(toolNames),
    createChatCompletion,
    invokeTool,
  });
}

function turnInput(
  sessionId: string,
  content: string,
  overrides: Partial<{
    mode: "chat" | "cowork" | "code";
    webMode: "off" | "auto" | "deep";
    memoryMode: "auto" | "on" | "off";
  }> = {},
) {
  return {
    sessionId,
    turnId: randomUUID(),
    userMessageId: `${sessionId}-message`,
    content,
    mode: overrides.mode ?? "code",
    providerId: "openai",
    model: "gpt-5.4",
    webMode: overrides.webMode ?? "off",
    memoryMode: overrides.memoryMode ?? "off",
    thinkingLevel: "standard" as const,
    toolAutonomy: "safe_auto" as const,
    historyMessages: [{ role: "user" as const, content }],
  };
}

function finalCompletion(content: string): ChatCompletionResponse {
  return {
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
      },
    ],
  };
}
