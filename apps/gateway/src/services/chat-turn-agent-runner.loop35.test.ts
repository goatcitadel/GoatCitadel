import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import { createMockStorage, createToolCatalog } from "./chat-turn-agent-runner-test-fixtures.js";

describe("ChatTurnAgentRunner loop35 prompt-lab approval coverage", () => {
  it("soft-fails a model-initiated repo search that requires approval on prompt-lab eval turns", async () => {
    const finalAnswer = [
      "Evidence review based on the available conversation context:",
      "the repo search tool is approval-gated in this environment, so I could not",
      "inspect skill-import-service.ts directly. The skill import path, overlap",
      "detection behavior, and provenance metadata claims below are therefore",
      "stated as unverified pending operator review.",
    ].join(" ");
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        toolCallCompletion("call-loop35-search-1", "code_search_files", { path: ".", query: "skill import" }),
      )
      .mockResolvedValueOnce(textCompletion(finalAnswer));
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "code search requires approval",
      auditEventId: "audit-loop35-search-approval",
      approvalId: "approval-loop35-search",
      expiresAt: "2026-03-22T14:00:00.000Z",
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool);
    const input = promptLabTurnInput(
      "sess-loop35-search-approval",
      [
        "Use file or code tools to inspect the skill import path, overlap detection behavior, and repo-managed skill provenance metadata.",
        "Summarize the concrete evidence an operator can review today and cite the exact files used.",
      ].join(" "),
    );

    const result = await orchestrator.run(input);

    // No controller prefetch: the only tool run is the one the model requested.
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "code.search_files",
        args: expect.objectContaining({ path: ".", query: "skill import" }),
      }),
    );
    // Approval soft-fails: the eval turn is never parked on an approval.
    expect(result.requiresApproval).toBeUndefined();
    expect(result.turnTrace.status).toBe("completed");
    expect(
      result.turnTrace.toolRuns.some(
        (run) => run.toolName === "code.search_files" && run.status === "approval_required",
      ),
    ).toBe(true);
    // The model is told not to retry the gated tool and continues the turn.
    const followUpMessages = requestMessages(createChatCompletion.mock.calls[1]?.[0]);
    expect(
      followUpMessages.some(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("do not request `code.search_files` again"),
      ),
    ).toBe(true);
    // The model's own answer passes through verbatim.
    expect(result.assistantContent).toBe(finalAnswer);
  });

  it("soft-fails a model-initiated concrete read that requires approval after search hits on prompt-lab eval turns", async () => {
    const finalAnswer = [
      "Search results located apps/gateway/src/services/skill-import-service.ts and",
      "docs/SKILL_ADOPTION_MATRIX.md, but reading skill-import-service.ts is",
      "approval-gated here, so its contents remain unverified. Operators can review",
      "those two files directly; I have only the search-hit paths as evidence.",
    ].join(" ");
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        toolCallCompletion("call-loop35-search-2", "code_search_files", { path: ".", query: "skill import" }),
      )
      .mockResolvedValueOnce(
        toolCallCompletion("call-loop35-read-1", "file_read_range", {
          path: "apps/gateway/src/services/skill-import-service.ts",
          startLine: 1,
          endLine: 120,
        }),
      )
      .mockResolvedValueOnce(textCompletion(finalAnswer));
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-loop35-search-hit",
        result: {
          matches: [
            { path: "apps/gateway/src/services/skill-import-service.ts", name: "skill-import-service.ts" },
            { path: "docs/SKILL_ADOPTION_MATRIX.md", name: "SKILL_ADOPTION_MATRIX.md" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "file read requires approval",
        auditEventId: "audit-loop35-read-approval",
        approvalId: "approval-loop35-read",
        expiresAt: "2026-03-22T14:30:00.000Z",
      });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool);
    const input = promptLabTurnInput(
      "sess-loop35-read-approval",
      [
        "Use file or code tools to inspect the skill import path, overlap detection behavior, and repo-managed skill provenance metadata.",
        "Summarize the concrete evidence an operator can review today and cite the exact files used.",
      ].join(" "),
    );

    const result = await orchestrator.run(input);

    // Both tool runs are model-initiated; the controller adds none of its own.
    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect(invokeTool.mock.calls[1]?.[0]).toMatchObject({
      toolName: "file.read_range",
      args: expect.objectContaining({
        path: "apps/gateway/src/services/skill-import-service.ts",
      }),
    });
    // The approval-gated read soft-fails instead of parking the eval turn.
    expect(result.requiresApproval).toBeUndefined();
    expect(result.turnTrace.status).toBe("completed");
    expect(
      result.turnTrace.toolRuns.some((run) => run.toolName === "file.read_range" && run.status === "approval_required"),
    ).toBe(true);
    const followUpMessages = requestMessages(createChatCompletion.mock.calls[2]?.[0]);
    expect(
      followUpMessages.some(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("do not request `file.read_range` again"),
      ),
    ).toBe(true);
    // The model's own answer passes through verbatim.
    expect(result.assistantContent).toBe(finalAnswer);
  });

  it("persists approval state when live-data browser search requires approval", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "browser search requires approval",
      auditEventId: "audit-loop35-browser-search-approval",
      approvalId: "approval-loop35-browser-search",
      expiresAt: "2026-03-22T15:00:00.000Z",
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["browser.search", "browser.navigate"]);

    const result = await orchestrator.run({
      sessionId: "sess-loop35-browser-search-approval",
      turnId: randomUUID(),
      userMessageId: "msg-loop35-browser-search-approval",
      content: "What are the latest news headlines today?",
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What are the latest news headlines today?" }],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({ query: "What are the latest news headlines today" }),
      }),
    );
    expect(result.requiresApproval).toEqual({
      approvalId: "approval-loop35-browser-search",
      toolName: "browser.search",
      reason: "Approval required by policy.",
      expiresAt: "2026-03-22T15:00:00.000Z",
    });
    expect(result.turnTrace).toMatchObject({
      status: "waiting_for_approval",
      failure: expect.objectContaining({ failureClass: "approval_required" }),
    });
  });

  it("persists approval state when proactive live-data navigation requires approval after search evidence", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-loop35-browser-search-hit",
        result: {
          results: [
            {
              title: "Latest headlines today",
              url: "https://example.com/news/today",
              snippet: "Current top stories.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "browser navigate requires approval",
        auditEventId: "audit-loop35-browser-navigate-approval",
        approvalId: "approval-loop35-browser-navigate",
        expiresAt: "2026-03-22T15:30:00.000Z",
      });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["browser.search", "browser.navigate"]);

    const result = await orchestrator.run({
      sessionId: "sess-loop35-browser-navigate-approval",
      turnId: randomUUID(),
      userMessageId: "msg-loop35-browser-navigate-approval",
      content: "What are the latest news headlines today?",
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What are the latest news headlines today?" }],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({ query: "What are the latest news headlines today" }),
    });
    expect(invokeTool.mock.calls[1]?.[0]).toMatchObject({
      toolName: "browser.navigate",
      args: expect.objectContaining({ url: "https://example.com/news/today" }),
    });
    expect(result.requiresApproval).toEqual({
      approvalId: "approval-loop35-browser-navigate",
      toolName: "browser.navigate",
      reason: "Approval required by policy.",
      expiresAt: "2026-03-22T15:30:00.000Z",
    });
    expect(result.turnTrace).toMatchObject({
      status: "waiting_for_approval",
      failure: expect.objectContaining({ failureClass: "approval_required" }),
    });
  });
});

function createOrchestrator(
  createChatCompletion: (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>,
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>,
  toolNames = ["code.search_files", "file.read_range"],
): ChatTurnAgentRunner {
  return new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(toolNames),
    createChatCompletion,
    invokeTool,
  });
}

function requestMessages(request: ChatCompletionRequest | undefined): Array<{ role: string; content?: unknown }> {
  return (request?.messages ?? []) as unknown as Array<{ role: string; content?: unknown }>;
}

function toolCallCompletion(
  toolCallId: string,
  functionName: string,
  args: Record<string, unknown>,
): ChatCompletionResponse {
  return {
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: toolCallId,
              type: "function",
              function: {
                name: functionName,
                arguments: JSON.stringify(args),
              },
            },
          ],
        } as never,
      },
    ],
  };
}

function textCompletion(content: string): ChatCompletionResponse {
  return {
    model: "gpt-5.4",
    choices: [{ index: 0, message: { role: "assistant", content } }],
  };
}

function promptLabTurnInput(sessionId: string, task: string) {
  const content = [
    "## Prompt Lab Run Contract",
    "- Mode: chat",
    "- Tool tier: explicit-tools",
    "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
    "- Required tool families: file/code tools",
    "",
    "## User Task",
    task,
  ].join("\n");
  return {
    sessionId,
    turnId: randomUUID(),
    userMessageId: `${sessionId}-message`,
    content,
    mode: "chat" as const,
    providerId: "openai",
    model: "gpt-5.4",
    webMode: "off" as const,
    memoryMode: "off" as const,
    thinkingLevel: "extended" as const,
    toolAutonomy: "safe_auto" as const,
    normalizationProfile: "prompt_pack_harness" as const,
    historyMessages: [{ role: "user" as const, content }],
  };
}
