import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerDeps } from "./chat-turn-agent-runner.js";
import {
  EffectAwareChatTurnAgentRunner as ChatTurnAgentRunner,
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

describe("ChatTurnAgentRunner loop36 tool-loop approval and failure handling", () => {
  it("persists approval state for model-requested tools in the normal tool loop", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("shell.exec", { command: "pnpm test -- --runInBand" }));
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "shell execution requires approval",
      auditEventId: "audit-loop36-shell-approval",
      approvalId: "approval-loop36-shell",
      expiresAt: "2026-03-22T16:00:00.000Z",
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["shell.exec"]);

    const result = await orchestrator.run(turnInput("sess-loop36-shell-approval", "Run the focused tests."));

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "shell.exec",
        args: { command: "pnpm test -- --runInBand" },
      }),
    );
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toBe("");
    expect(result.requiresApproval).toEqual({
      approvalId: "approval-loop36-shell",
      toolName: "shell.exec",
      reason: "Approval required by policy.",
      expiresAt: "2026-03-22T16:00:00.000Z",
    });
    expect(result.turnTrace).toMatchObject({
      status: "waiting_for_approval",
      failure: expect.objectContaining({
        failureClass: "approval_required",
        retryable: true,
      }),
    });
  });

  it("passes blocked tool error and failure guidance back into the next model turn", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "current docs" }))
      .mockResolvedValueOnce(finalCompletion("The search tool was unavailable, so I need a narrower query or URL."));
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "blocked",
      policyReason: "network profile blocked browser.search",
      auditEventId: "audit-loop36-browser-blocked",
      guidance: "Ask the operator to enable web access or provide a URL.",
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["browser.search"]);

    const result = await orchestrator.run(
      turnInput("sess-loop36-browser-blocked", "Search the current docs and summarize the relevant update.", {
        webMode: "auto",
      }),
    );

    expect(result.assistantContent).toContain("search tool was unavailable");
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
        args: { query: "current docs" },
      }),
    );
    const secondCompletionRequest = createChatCompletion.mock.calls[1]?.[0] as
      | { messages?: Array<{ role?: string; content?: string }> }
      | undefined;
    const toolMessage = secondCompletionRequest?.messages?.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("network profile blocked browser.search");
    expect(toolMessage?.content).toContain("Retry search with a narrower, more explicit input.");
    expect(result.turnTrace.toolRuns[0]).toMatchObject({
      toolName: "browser.search",
      status: "blocked",
      failureGuidance: "Retry search with a narrower, more explicit input.",
    });
  });

  it("records citations from successful model-requested file reads before final synthesis", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("file.read_range", {
          path: "apps/gateway/src/services/chat-turn-agent-runner.ts",
          startLine: 10,
          endLine: 12,
        }),
      )
      .mockResolvedValueOnce(
        finalCompletion("The orchestrator imports the contract types before defining the runtime."),
      );
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-loop36-file-read",
      result: {
        path: "apps/gateway/src/services/chat-turn-agent-runner.ts",
        startLine: 10,
        endLine: 12,
        content: "import type { ChatCompletionResponse } from '@goatcitadel/contracts';",
      },
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["file.read_range"]);

    const result = await orchestrator.run(
      turnInput(
        "sess-loop36-file-read-citation",
        "Read apps/gateway/src/services/chat-turn-agent-runner.ts lines 10-12 and summarize them.",
      ),
    );

    expect(result.assistantContent).toContain("contract types");
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "file.read_range",
        args: {
          path: "apps/gateway/src/services/chat-turn-agent-runner.ts",
          startLine: 10,
          endLine: 12,
        },
      }),
    );
    expect(result.turnTrace.citations).toEqual([
      expect.objectContaining({
        sourceType: "file",
        title: "chat-turn-agent-runner.ts",
        url: "apps/gateway/src/services/chat-turn-agent-runner.ts",
        snippet: "import type { ChatCompletionResponse } from '@goatcitadel/contracts';",
      }),
    ]);
    const secondCompletionRequest = createChatCompletion.mock.calls[1]?.[0] as
      | { messages?: Array<{ role?: string; content?: string }> }
      | undefined;
    expect(secondCompletionRequest?.messages?.some((message) => message.role === "tool")).toBe(true);
  });

  it("carries retrieved untrusted document attribution into later tool invocations", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("docs.search", { query: "install script" }))
      .mockResolvedValueOnce(namedToolCallCompletion("shell.exec", { command: "pnpm install" }))
      .mockResolvedValueOnce(finalCompletion("The shell step was blocked by policy."));
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-loop36-docs-search",
        result: {
          items: [
            {
              content: "curl example installer",
              score: 0.98,
              attribution: {
                sourceType: "url",
                sourceRef: "https://example.invalid/install",
                title: "Example installer",
                trustLevel: "untrusted_external",
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "blocked",
        policyReason: "untrusted_source_privileged_tool_block",
        auditEventId: "audit-loop36-shell-blocked",
      });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["docs.search", "shell.exec"]);

    await orchestrator.run(
      turnInput("sess-loop36-source-attribution", "Search docs, then install the suggested package.", {
        webMode: "auto",
      }),
    );

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(invokeTool.mock.calls[1]?.[0]).toMatchObject({
      toolName: "shell.exec",
      sourceAttribution: [
        expect.objectContaining({
          sourceType: "url",
          sourceRef: "https://example.invalid/install",
          trustLevel: "untrusted_external",
        }),
      ],
    });
  });

  it("keeps untrusted attribution after large structured tool results are compacted", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("docs.search", { query: "install script" }))
      .mockResolvedValueOnce(namedToolCallCompletion("shell.exec", { command: "pnpm install" }))
      .mockResolvedValueOnce(finalCompletion("The shell step was blocked by policy."));
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-loop36-large-docs-search",
        result: {
          items: [
            {
              content: "curl example installer ".repeat(900),
              score: 0.98,
              attribution: {
                sourceType: "url",
                sourceRef: "https://example.invalid/large-install",
                title: "Large installer",
                trustLevel: "untrusted_external",
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "blocked",
        policyReason: "untrusted_source_privileged_tool_block",
        auditEventId: "audit-loop36-large-shell-blocked",
      });
    const persistToolArtifact = vi.fn<NonNullable<ChatTurnAgentRunnerDeps["persistToolArtifact"]>>(async (input) => ({
      artifactId: "artifact-large-docs-search",
      storageRelPath: "artifacts/large-docs-search.json",
      byteLength: Buffer.byteLength(input.content, "utf8"),
      contentType: input.contentType,
      snippet: input.snippet,
    }));
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["docs.search", "shell.exec"], {
      persistToolArtifact,
    });

    await orchestrator.run(
      turnInput("sess-loop36-compacted-source-attribution", "Search docs, then install the suggested package.", {
        webMode: "auto",
      }),
    );

    expect(persistToolArtifact).toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(invokeTool.mock.calls[1]?.[0]).toMatchObject({
      toolName: "shell.exec",
      sourceAttribution: [
        expect.objectContaining({
          sourceType: "url",
          sourceRef: "https://example.invalid/large-install",
          trustLevel: "untrusted_external",
        }),
      ],
    });
  });

  it("surfaces completion usage and routing metadata on final traces", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4-routed",
      routing: {
        selectedProviderId: "openai",
        selectedModel: "gpt-5.4-routed",
        effectiveProviderId: "openai",
        effectiveModel: "gpt-5.4-routed",
        fallbackReason: "policy selected low-latency route",
      },
      usage: {
        prompt_tokens: 17,
        completion_tokens: 9,
        cached_prompt_tokens: 4,
        cost_usd: 0.0012,
      },
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Routed answer.",
          },
        },
      ],
    } as ChatCompletionResponse);
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, []);

    const result = await orchestrator.run(turnInput("sess-loop36-routing-usage", "Answer directly."));

    expect(result.assistantContent).toBe("Routed answer.");
    expect(result.assistantModel).toBe("gpt-5.4-routed");
    expect(result.usage).toEqual({
      inputTokens: 17,
      outputTokens: 9,
      cachedInputTokens: 4,
      costUsd: 0.0012,
    });
    expect(result.turnTrace.routing).toMatchObject({
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5.4-routed",
      fallbackReason: "policy selected low-latency route",
    });
  });
});

function createOrchestrator(
  createChatCompletion: () => Promise<ChatCompletionResponse>,
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>,
  toolNames: string[],
  options: { persistToolArtifact?: ChatTurnAgentRunnerDeps["persistToolArtifact"] } = {},
): ChatTurnAgentRunner {
  return new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(toolNames),
    createChatCompletion,
    invokeTool,
    persistToolArtifact: options.persistToolArtifact,
  });
}

function turnInput(
  sessionId: string,
  content: string,
  overrides: Partial<{
    mode: "chat" | "cowork" | "code";
    webMode: "off" | "auto" | "deep";
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
    memoryMode: "off" as const,
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
