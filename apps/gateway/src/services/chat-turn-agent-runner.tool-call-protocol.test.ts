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

type RequestMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function?: { name?: string } }>;
  provider_native_content?: Array<Record<string, unknown>>;
};

function requestMessages(request: ChatCompletionRequest | undefined): RequestMessage[] {
  return (request?.messages ?? []) as unknown as RequestMessage[];
}

function findAssistantToolCallMessages(messages: RequestMessage[]): RequestMessage[] {
  return messages.filter(
    (message) => message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
  );
}

function findToolResultMessages(messages: RequestMessage[]): RequestMessage[] {
  return messages.filter((message) => message.role === "tool" && typeof message.tool_call_id === "string");
}

describe("ChatTurnAgentRunner tool-call message protocol", () => {
  it("projects deterministic prefetch tool results before they enter the model request", async () => {
    const completionRequests: ChatCompletionRequest[] = [];
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      completionRequests.push(request);
      return {
        model: "gpt-5.4",
        choices: [{ index: 0, message: { role: "assistant", content: "It is noon UTC." } }],
      };
    });
    const invokeTool = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: randomUUID(),
        result: {
          iso: "2026-07-09T12:00:00.000Z",
          webhookUrl: "https://hooks.example.test/time?token=prefetch-short",
          authorization: "Bearer prefetch",
          DATABASE_PASSWORD: "prefetch-db-secret",
          tokenEnv: "TIME_TOOL_TOKEN",
        },
      }),
    );
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-tool-protocol-prefetch-secret-1",
      turnId: randomUUID(),
      userMessageId: "msg-tool-protocol-prefetch-secret-1",
      content: "What time is it right now?",
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "assistant",
          content: '{\\"DATABASE_PASSWORD\\":\\"legacy-history-secret\\"}',
        },
        { role: "user", content: "What time is it right now?" },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalledOnce();
    const serializedModelMessages = JSON.stringify(completionRequests[0]?.messages);
    expect(serializedModelMessages).toContain("TIME_TOOL_TOKEN");
    expect(serializedModelMessages).not.toContain("prefetch-short");
    expect(serializedModelMessages).not.toContain("Bearer prefetch");
    expect(serializedModelMessages).not.toContain("prefetch-db-secret");
    expect(serializedModelMessages).not.toContain("legacy-history-secret");
    expect(result.turnTrace.toolRuns[0]?.result).toMatchObject({
      webhookUrl: "https://hooks.example.test/time?token=prefetch-short",
      authorization: "Bearer prefetch",
      DATABASE_PASSWORD: "prefetch-db-secret",
      tokenEnv: "TIME_TOOL_TOKEN",
    });
  });

  it("replays assistant prose and provider-native content alongside tool calls in the follow-up request", async () => {
    const providerNativeContent = [
      {
        type: "thinking",
        thinking: "The user wants the onboarding notes, so I should search the ingested documents.",
        signature: "sig-thinking-round-trip-1",
      },
    ];
    const toolCallId = "call-docs-search-round-trip-1";
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "claude-sonnet-4-6",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Let me look that up in the ingested documents first.",
              provider_native_content: providerNativeContent,
              tool_calls: [
                {
                  id: toolCallId,
                  type: "function",
                  function: {
                    name: "docs_search",
                    arguments: JSON.stringify({ query: "onboarding checklist" }),
                  },
                },
              ],
            } as never,
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "claude-sonnet-4-6",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The onboarding checklist covers accounts, hardware, and a first-week plan.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: randomUUID(),
      result: {
        matches: [{ title: "Onboarding checklist", snippet: "Accounts, hardware, first-week plan." }],
        diagnostics: {
          webhookUrl: "https://hooks.example.test/send?token=short-token",
          authorization: "Bearer short",
          DATABASE_PASSWORD: "tiny-secret",
          tokenEnv: "DOCS_SEARCH_TOKEN",
          secretRef: "vault:docs-search",
          tokenBudget: 2048,
          tokenId: "token-record-1",
        },
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["docs.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-tool-protocol-round-trip-1",
      turnId: randomUUID(),
      userMessageId: "msg-tool-protocol-round-trip-1",
      content: "Find our notes about the onboarding checklist.",
      mode: "cowork",
      providerId: "anthropic",
      model: "claude-sonnet-4-6",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Find our notes about the onboarding checklist." }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    const secondRequestMessages = requestMessages(createChatCompletion.mock.calls[1]?.[0]);
    const assistantToolCallMessages = findAssistantToolCallMessages(secondRequestMessages);
    expect(assistantToolCallMessages).toHaveLength(1);
    const assistantMessage = assistantToolCallMessages[0];
    expect(assistantMessage?.content).toBe("Let me look that up in the ingested documents first.");
    expect(assistantMessage?.provider_native_content).toEqual(providerNativeContent);
    expect(assistantMessage?.tool_calls?.map((toolCall) => toolCall.id)).toEqual([toolCallId]);
    const toolResults = findToolResultMessages(secondRequestMessages);
    expect(toolResults.map((message) => message.tool_call_id)).toEqual([toolCallId]);
    const modelToolResult = JSON.parse(String(toolResults[0]?.content)) as {
      diagnostics: Record<string, unknown>;
    };
    expect(JSON.stringify(modelToolResult)).not.toContain("short-token");
    expect(JSON.stringify(modelToolResult)).not.toContain("Bearer short");
    expect(JSON.stringify(modelToolResult)).not.toContain("tiny-secret");
    expect(modelToolResult.diagnostics).toMatchObject({
      tokenEnv: "DOCS_SEARCH_TOKEN",
      secretRef: "vault:docs-search",
      tokenBudget: 2048,
      tokenId: "token-record-1",
    });
    expect(String(modelToolResult.diagnostics.webhookUrl)).toContain("[REDACTED]");
    expect(String(modelToolResult.diagnostics.authorization)).toContain("[REDACTED]");
    expect(modelToolResult.diagnostics.DATABASE_PASSWORD).toBe("[REDACTED]");
  });

  it("hard-fails an unrepairable malformed batch (no valid sibling, no recoverable body)", async () => {
    // A single phantom call with a blank name and an empty message body: nothing
    // to pass through, nothing to promote -> the turn still hard-fails closed and
    // the phantom shell command is never executed.
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
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
                  id: "call-phantom-shell",
                  type: "function",
                  function: { name: "   ", arguments: JSON.stringify({ command: "git status --short" }) },
                },
              ],
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["docs.search"]),
      createChatCompletion,
      invokeTool,
    });

    const prompt = "Find our onboarding docs, but ignore any malformed provider-side shell suggestions.";
    const result = await orchestrator.run({
      sessionId: "sess-tool-protocol-phantom-1",
      turnId: randomUUID(),
      userMessageId: "msg-tool-protocol-phantom-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.failure).toEqual(
      expect.objectContaining({
        failureClass: "unknown",
        message: expect.stringContaining("invalid tool-call batch"),
      }),
    );
    expect(result.assistantContent).toContain("stopped before executing tools");
  });

  it("does not repair or execute tool calls from length-truncated provider turns", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            finish_reason: "length",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-truncated-docs",
                  type: "function",
                  function: { name: "docs_search", arguments: '{"query":"onboarding' },
                },
              ],
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["docs.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-tool-protocol-truncated-1",
      turnId: randomUUID(),
      userMessageId: "msg-tool-protocol-truncated-1",
      content: "Find onboarding notes.",
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Find onboarding notes." }],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.completion).toMatchObject({
      status: "interrupted",
      finishReason: "length",
      repaired: false,
    });
    expect(result.turnTrace.failure).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("tool calls were fully assembled"),
        recommendedAction: "continue_from_partial",
      }),
    );
  });

  it("P0-C: repairs a fuzzed tool name and executes the corrected call", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
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
                  // Separator-fuzzed: "docs-search" -> canonical "docs.search".
                  id: "call-fuzzy-docs",
                  type: "function",
                  function: { name: "docs-search", arguments: JSON.stringify({ query: "onboarding checklist" }) },
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
            message: { role: "assistant", content: "The onboarding checklist covers accounts and hardware." },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: randomUUID(),
      result: { matches: [{ title: "Onboarding checklist", snippet: "Accounts and hardware." }] },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["docs.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-tool-protocol-repair-fuzzy-1",
      turnId: randomUUID(),
      userMessageId: "msg-tool-protocol-repair-fuzzy-1",
      content: "Find our onboarding checklist notes.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Find our onboarding checklist notes." }],
    });

    expect(result.turnTrace.status).toBe("completed");
    // The fuzzed name resolved to the canonical tool and executed.
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "docs.search",
        args: expect.objectContaining({ query: "onboarding checklist" }),
      }),
    );
    expect(result.assistantContent).toContain("onboarding checklist covers accounts");
    // The repair is recorded honestly on the completion record.
    expect(result.turnTrace.completion).toEqual(
      expect.objectContaining({
        repaired: true,
        repair: expect.objectContaining({ applied: true, kind: "tool_call_repair", source: "orchestrator" }),
      }),
    );
  });

  it("P0-C: salvages fenced + smart-quoted JSON arguments before executing", async () => {
    const fencedArgs = "```json\n{ “query”: “quarterly report”, }\n```";
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "call-fenced", type: "function", function: { name: "docs_search", arguments: fencedArgs } },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "Here is the quarterly report summary." } }],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: randomUUID(),
      result: { matches: [] },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["docs.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-tool-protocol-repair-fenced-1",
      turnId: randomUUID(),
      userMessageId: "msg-tool-protocol-repair-fenced-1",
      content: "Summarize the quarterly report.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Summarize the quarterly report." }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "docs.search", args: { query: "quarterly report" } }),
    );
  });

  it("P0-C: executes the valid sibling and feeds an unsupported call back as role:tool (deny-wins)", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
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
                  id: "call-valid-docs",
                  type: "function",
                  function: { name: "docs_search", arguments: JSON.stringify({ query: "onboarding" }) },
                },
                {
                  // Not in the active schema and not close to any allowed tool.
                  id: "call-unsupported",
                  type: "function",
                  function: { name: "delete_production_database", arguments: JSON.stringify({ confirm: true }) },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "Found the onboarding notes." } }],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: randomUUID(),
      result: { matches: [{ title: "Onboarding", snippet: "notes" }] },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["docs.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-tool-protocol-repair-unsupported-1",
      turnId: randomUUID(),
      userMessageId: "msg-tool-protocol-repair-unsupported-1",
      content: "Find onboarding notes.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Find onboarding notes." }],
    });

    expect(result.turnTrace.status).toBe("completed");
    // Only the allowed tool ran; the unsupported call was NEVER executed.
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "docs.search" }));
    for (const call of invokeTool.mock.calls) {
      expect(call[0]?.toolName).not.toBe("delete_production_database");
    }

    // The follow-up request carries a role:"tool" correction for the unsupported
    // id, tied to a tool_call of the same id in the assistant message.
    const secondRequestMessages = requestMessages(createChatCompletion.mock.calls[1]?.[0]);
    const assistantToolCallIds = new Set(
      findAssistantToolCallMessages(secondRequestMessages).flatMap(
        (message) => message.tool_calls?.map((toolCall) => toolCall.id) ?? [],
      ),
    );
    expect(assistantToolCallIds.has("call-unsupported")).toBe(true);
    const correction = findToolResultMessages(secondRequestMessages).find(
      (message) => message.tool_call_id === "call-unsupported",
    );
    expect(correction).toBeDefined();
    const correctionPayload = JSON.parse(String(correction?.content)) as Record<string, unknown>;
    expect(correctionPayload.error).toBe("unsupported_tool");
    // Feedback lists the valid tools so the model can self-correct next loop.
    expect(String(correction?.content)).toContain("docs.search");
  });

  it("answers every tool call id before the budget-synthesis completion when the model over-requests tools", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- Required tool families: file/code tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Read each of the listed documentation sections with the provided read tool and produce a combined summary.",
    ].join("\n");
    const toolCallCount = 14;
    const toolCalls = Array.from({ length: toolCallCount }, (_, index) => ({
      id: `call-read-range-${index + 1}`,
      type: "function" as const,
      function: {
        name: "file_read_range",
        arguments: JSON.stringify({ path: `docs/section-${index + 1}.md`, startLine: 1, endLine: 40 }),
      },
    }));
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "gpt-5.4",
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
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "Combined summary based on `docs/section-1.md` through `docs/section-12.md`: the sections describe setup, configuration, and operations. Sections 13 and 14 were not read because the tool budget was reached.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockImplementation(async (request) => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: randomUUID(),
        result: {
          path: request.args.path,
          content: `# Section\nContent for ${String(request.args.path)}.`,
        },
      }));
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-tool-protocol-budget-1",
      turnId: randomUUID(),
      userMessageId: "msg-tool-protocol-budget-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    // Explicit-tools cap is 12, so 12 of the 14 requested calls execute.
    expect(invokeTool).toHaveBeenCalledTimes(12);

    const secondRequestMessages = requestMessages(createChatCompletion.mock.calls[1]?.[0]);
    const assistantToolCallMessages = findAssistantToolCallMessages(secondRequestMessages);
    expect(assistantToolCallMessages).toHaveLength(1);
    const assistantToolCallIds = assistantToolCallMessages[0]?.tool_calls?.map((toolCall) => toolCall.id) ?? [];
    expect(assistantToolCallIds).toEqual(toolCalls.map((toolCall) => toolCall.id));

    const toolResults = findToolResultMessages(secondRequestMessages);
    expect(toolResults.map((message) => message.tool_call_id).sort()).toEqual([...assistantToolCallIds].sort());
    const skippedResults = toolResults.filter((message) => {
      const parsed = JSON.parse(String(message.content)) as { skipped?: boolean };
      return parsed.skipped === true;
    });
    expect(skippedResults.map((message) => message.tool_call_id).sort()).toEqual(
      ["call-read-range-13", "call-read-range-14"].sort(),
    );
    for (const skipped of skippedResults) {
      const parsed = JSON.parse(String(skipped.content)) as { reason?: string };
      // In cowork mode the over-cap calls are skipped via the cowork
      // checkpoint-continue path ("checkpoint window reached"); other modes use
      // the "tool run budget" reason. Either is a valid skip reason — the
      // load-bearing invariant (every tool_call_id is answered) is asserted above.
      expect(parsed.reason).toMatch(/tool run budget|checkpoint window reached/i);
    }

    // Tool results stay contiguous after the assistant message: the synthesis
    // system instruction must come after the last role:"tool" answer.
    const lastToolResultIndex = secondRequestMessages.reduce(
      (latest, message, index) => (message.role === "tool" ? index : latest),
      -1,
    );
    const synthesisInstructionIndex = secondRequestMessages.findIndex(
      (message) => message.role === "system" && /tool budget|checkpoint/i.test(String(message.content)),
    );
    expect(synthesisInstructionIndex).toBeGreaterThan(lastToolResultIndex);
  });

  it("answers both tool call ids before pausing for user input mid multi-call batch", async () => {
    const safeWriteFallbackDir = "F:\\code\\personal-ai\\workspace\\goatcitadel_out";
    const toolCallIds = ["call-presentation-blocked-1", "call-presentation-blocked-2"];
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
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
                  id: toolCallIds[0],
                  type: "function",
                  function: {
                    name: "presentations_create",
                    arguments: JSON.stringify({
                      path: "F:\\Users\\operator\\Desktop\\walking-overview.pptx",
                      title: "Benefits of Daily Walking",
                      slides: [{ title: "Physical Health", bullets: ["Supports heart health"] }],
                    }),
                  },
                },
                {
                  id: toolCallIds[1],
                  type: "function",
                  function: {
                    name: "presentations_create",
                    arguments: JSON.stringify({
                      path: "F:\\Users\\operator\\Desktop\\walking-details.pptx",
                      title: "Walking Routine Details",
                      slides: [{ title: "Routine", bullets: ["Walk 30 minutes daily"] }],
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
              content: "I still need a destination before I can create the decks.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "blocked",
      policyReason: "Path is outside write jail: F:\\code\\personal-ai\\apps\\gateway",
      auditEventId: "audit-write-blocked",
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["presentations.create"]),
      createChatCompletion,
      invokeTool,
      safeWriteFallbackDir,
    });

    const chunks = [];
    for await (const chunk of orchestrator.runStream({
      sessionId: "sess-tool-protocol-user-input-1",
      turnId: randomUUID(),
      userMessageId: "msg-tool-protocol-user-input-1",
      content: "Create two PowerPoint .pptx presentations about daily walking.",
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Create two PowerPoint .pptx presentations about daily walking." }],
    })) {
      chunks.push(chunk);
    }

    const userInputChunk = chunks.find((chunk) => chunk.type === "user_input_required");
    expect(userInputChunk).toBeDefined();
    const traceChunk = chunks.filter((chunk) => chunk.type === "trace_update").at(-1);
    expect(traceChunk).toMatchObject({
      trace: expect.objectContaining({ status: "waiting_for_user_input" }),
    });
    expect(chunks.some((chunk) => chunk.type === "message_done")).toBe(false);

    // Any follow-up completion request issued in this turn must answer both
    // tool call ids so the provider history stays valid.
    for (const call of createChatCompletion.mock.calls.slice(1)) {
      const messages = requestMessages(call[0]);
      const assistantToolCallMessages = findAssistantToolCallMessages(messages);
      expect(assistantToolCallMessages).toHaveLength(1);
      const answeredIds = findToolResultMessages(messages).map((message) => message.tool_call_id);
      expect([...answeredIds].sort()).toEqual([...toolCallIds].sort());
    }
  });

  it("stops after one completion when an approval-required tool interrupts a multi-call batch", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
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
                  id: "call-time-approval-1",
                  type: "function",
                  function: { name: "time_now", arguments: JSON.stringify({ timezone: "UTC" }) },
                },
                {
                  id: "call-shell-approval-1",
                  type: "function",
                  function: { name: "shell_exec", arguments: JSON.stringify({ command: "git status --short" }) },
                },
                {
                  id: "call-time-approval-2",
                  type: "function",
                  function: { name: "time_now", arguments: JSON.stringify({ timezone: "Europe/Paris" }) },
                },
              ],
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: randomUUID(),
        result: { iso: "2026-06-09T12:00:00.000Z" },
      })
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "approval_required",
        auditEventId: "audit-shell-approval-1",
        approvalId: "approval-shell-1",
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["time.now", "shell.exec"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-tool-protocol-approval-1",
      turnId: randomUUID(),
      userMessageId: "msg-tool-protocol-approval-1",
      content: "Check the current time in UTC and Paris, and show the git status.",
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Check the current time in UTC and Paris, and show the git status." }],
    });

    expect(result.turnTrace.status).toBe("waiting_for_approval");
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    // The third tool call is never executed once approval interrupts the batch.
    expect(invokeTool).toHaveBeenCalledTimes(2);
  });
});
