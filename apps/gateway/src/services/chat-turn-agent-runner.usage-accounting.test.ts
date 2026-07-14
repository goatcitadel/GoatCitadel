import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionResponse,
  ChatStreamUsageRecord,
  ChatToolRunRecord,
  ModelUsageAttributionContext,
} from "@goatcitadel/contracts";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { createMockStorage, createToolCatalog } from "./chat-turn-agent-runner-test-fixtures.js";

type SynthesizeToolOutcomeFallback = (input: {
  input: ChatTurnAgentRunnerInput;
  toolRuns: ChatToolRunRecord[];
  circuitBreakerReason?: string;
  turnBudgetDeadline?: number;
  allowOverBudget?: boolean;
}) => Promise<{
  content: string;
  deterministic: boolean;
  usage: ChatStreamUsageRecord | null;
  providerCalls: number;
}>;

function baseTurnInput(): ChatTurnAgentRunnerInput {
  return {
    sessionId: "sess-synth-unit-1",
    turnId: randomUUID(),
    userMessageId: "msg-synth-unit-1",
    content: "What do the design notes say?",
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "off",
    memoryMode: "off",
    retrievalMode: "standard",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content: "What do the design notes say?" }],
  };
}

// Regression coverage for AGENTORCH-004: secondary provider calls (repair /
// synthesis / image generation) must accrue into the turn's usage totals and
// providerCallCount, otherwise turns that trigger them under-report cost.
describe("ChatTurnAgentRunner secondary-call usage accounting", () => {
  it("carries only server-owned routed-context bindings across initial, recovery, tool-loop, and repair calls", async () => {
    const attributions: ModelUsageAttributionContext[] = [];
    let completionCall = 0;
    const createChatCompletion = vi.fn(
      async (_request: unknown, attribution?: ModelUsageAttributionContext): Promise<ChatCompletionResponse> => {
        if (attribution) attributions.push(attribution);
        completionCall += 1;
        if (completionCall === 1) {
          return {
            model: "glm-5",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-memory",
                      type: "function",
                      function: { name: "memory.search", arguments: JSON.stringify({ query: "design notes" }) },
                    },
                  ],
                },
              },
            ],
          };
        }
        if (completionCall === 2) {
          return {
            model: "glm-5",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "The routed answer was cut short" },
                finish_reason: "length",
              },
            ],
          };
        }
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "The routed answer is now complete." },
              finish_reason: "stop",
            },
          ],
        };
      },
    );
    const createChatCompletionStream = async function* (
      _request: unknown,
      attribution?: ModelUsageAttributionContext,
    ): AsyncGenerator<Record<string, unknown>> {
      if (attribution) attributions.push(attribution);
      const unreachableChunks: Record<string, unknown>[] = [];
      yield* unreachableChunks;
      throw new Error("force the pre-token non-stream recovery path");
    };
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["memory.search"]),
      createChatCompletion,
      createChatCompletionStream,
      invokeTool: vi.fn(async () => ({ outcome: "executed", result: { items: ["bounded compaction"] } })) as never,
    });
    const serverContextUsageAttribution = Object.freeze({
      contextSnapshotId: "snapshot-final-1",
      contextIntentHash: "source-request-hash-1",
      contextResolutionHash: "snapshot-hash-1",
    });

    await orchestrator.run({
      ...baseTurnInput(),
      content: "Search memory for the design notes.",
      historyMessages: [{ role: "user", content: "Search memory for the design notes." }],
      serverContextUsageAttribution,
    });

    expect(attributions.map((attribution) => attribution.callKind)).toEqual([
      "chat_initial",
      "chat_initial",
      "chat_tool_loop",
      "chat_tool_loop",
      "chat_repair",
    ]);
    for (const attribution of attributions) {
      expect(attribution).toMatchObject(serverContextUsageAttribution);
      expect(
        Object.keys(attribution)
          .filter((key) => key.startsWith("context"))
          .sort(),
      ).toEqual(["contextIntentHash", "contextResolutionHash", "contextSnapshotId"]);
    }

    const unroutedAttributions: ModelUsageAttributionContext[] = [];
    const unroutedRunner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion: vi.fn(async (_request, attribution) => {
        if (attribution) unroutedAttributions.push(attribution);
        return {
          model: "glm-5",
          choices: [{ index: 0, message: { role: "assistant", content: "No routed context." }, finish_reason: "stop" }],
        };
      }),
      invokeTool: vi.fn(),
    });

    await unroutedRunner.run(baseTurnInput());

    expect(unroutedAttributions).toHaveLength(1);
    expect(Object.keys(unroutedAttributions[0]!).filter((key) => key.startsWith("context"))).toEqual([]);
  });

  it("attributes delegated worker calls to the persisted step and preserves worker identity on repair", async () => {
    const attributions: ModelUsageAttributionContext[] = [];
    const createChatCompletion = vi.fn(
      async (_request: unknown, attribution?: ModelUsageAttributionContext): Promise<ChatCompletionResponse> => {
        if (attribution) attributions.push(attribution);
        if (attributions.length === 1) {
          return {
            model: "glm-5",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Partial delegated answer" },
                finish_reason: "length",
              },
            ],
          };
        }
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Complete delegated worker answer." },
              finish_reason: "stop",
            },
          ],
        };
      },
    );
    const storage = createMockStorage() as {
      chatDelegationSteps: {
        get(stepId: string): {
          stepId: string;
          runId: string;
          role: string;
          childSessionId: string;
        };
      };
      chatSessionMeta: { get(sessionId: string): { workspaceId: string } };
    };
    storage.chatDelegationSteps = {
      get: (stepId) => ({
        stepId,
        runId: "delegation-run-1",
        role: "researcher",
        childSessionId: "worker-session-1",
      }),
    };
    storage.chatSessionMeta = { get: () => ({ workspaceId: "workspace-1" }) };
    const orchestrator = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => [],
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    await orchestrator.run({
      ...baseTurnInput(),
      sessionId: "worker-session-1",
      parentDelegationStepId: "delegation-step-1",
      policyTaskId: "task-1",
    });

    expect(attributions).toHaveLength(2);
    expect(attributions[0]).toMatchObject({
      callKind: "delegation_worker",
      workspaceId: "workspace-1",
      sessionId: "worker-session-1",
      durableRunId: "delegation-run-1",
      taskId: "task-1",
      agentId: "researcher",
      workerId: "delegation-step-1",
      parentOperationId: "delegation-run:delegation-run-1:step:delegation-step-1",
    });
    expect(attributions[1]).toMatchObject({
      callKind: "chat_repair",
      agentId: "researcher",
      workerId: "delegation-step-1",
      parentOperationId: "delegation-run:delegation-run-1:step:delegation-step-1",
    });
  });

  it("fails delegated usage attribution closed when the persisted step belongs to another child session", async () => {
    const storage = createMockStorage() as {
      chatDelegationSteps: {
        get(stepId: string): {
          stepId: string;
          runId: string;
          role: string;
          childSessionId: string;
        };
      };
    };
    storage.chatDelegationSteps = {
      get: (stepId) => ({
        stepId,
        runId: "delegation-run-1",
        role: "researcher",
        childSessionId: "different-worker-session",
      }),
    };
    const createChatCompletion = vi.fn();
    const orchestrator = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => [],
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    await expect(
      orchestrator.run({
        ...baseTurnInput(),
        sessionId: "worker-session-1",
        parentDelegationStepId: "delegation-step-1",
      }),
    ).rejects.toThrow("is not bound to child session");
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("fails delegated usage attribution closed when the persisted step has no child-session binding", async () => {
    const storage = createMockStorage() as {
      chatDelegationSteps: {
        get(stepId: string): {
          stepId: string;
          runId: string;
          role: string;
          childSessionId?: string;
        };
      };
    };
    storage.chatDelegationSteps = {
      get: (stepId) => ({
        stepId,
        runId: "delegation-run-1",
        role: "researcher",
      }),
    };
    const createChatCompletion = vi.fn();
    const orchestrator = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => [],
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    await expect(
      orchestrator.run({
        ...baseTurnInput(),
        sessionId: "worker-session-1",
        parentDelegationStepId: "delegation-step-1",
      }),
    ).rejects.toThrow("is not bound to child session");
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("keeps first-request input usage distinct from aggregate tool-loop usage", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        modelUsageEventIds: ["usage-tool-loop-first"],
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-memory",
                  type: "function",
                  function: { name: "memory.search", arguments: JSON.stringify({ query: "design notes" }) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 8 },
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        modelUsageEventIds: ["usage-tool-loop-second", "usage-tool-loop-first"],
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "The design notes favor bounded compaction." },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 12 },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["memory.search"]),
      createChatCompletion,
      invokeTool: vi.fn(async () => ({ outcome: "executed", result: { items: ["bounded compaction"] } })) as never,
    });

    const result = await orchestrator.run({
      ...baseTurnInput(),
      content: "Search memory for the design notes.",
      historyMessages: [{ role: "user", content: "Search memory for the design notes." }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.modelUsageEventIds).toEqual(["usage-tool-loop-first", "usage-tool-loop-second"]);
    expect(result.turnTrace.completion?.usage?.inputTokens).toBe(150);
    expect(result.turnTrace.completion?.firstProviderRequestUsage).toMatchObject({
      reportedInputTokens: 100,
      effectiveInputTokens: 100,
      source: "provider_reported",
      availability: "reported",
    });
  });

  it("folds the incomplete-completion repair call usage into the turn totals", async () => {
    const mainUsage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      cached_prompt_tokens: 5,
      cost_usd: 0.01,
      cost_source: "provider_reported",
    };
    const repairUsage = {
      prompt_tokens: 40,
      completion_tokens: 60,
      cached_prompt_tokens: 3,
      cost_usd: 0.02,
      cost_source: "provider_reported",
    };
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      // Main completion: truncated answer that forces the repair pass.
      .mockResolvedValueOnce({
        model: "glm-5",
        modelUsageEventIds: ["usage-repair-main"],
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Here is the start of the answer but it got cut" },
            finish_reason: "length",
          },
        ],
        usage: mainUsage,
      })
      // Repair completion (repairIncompleteAssistantCompletion).
      .mockResolvedValueOnce({
        model: "glm-5",
        modelUsageEventIds: ["usage-repair-pass", "usage-repair-main"],
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Here is the complete, repaired answer to the original request.",
            },
            finish_reason: "stop",
          },
        ],
        usage: repairUsage,
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-usage-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-usage-repair-1",
      content: "Explain the change end to end.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Explain the change end to end." }],
    });

    // The repair pass actually ran.
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.modelUsageEventIds).toEqual(["usage-repair-main", "usage-repair-pass"]);
    expect(result.turnTrace.completion).toMatchObject({
      repaired: true,
      repair: expect.objectContaining({ kind: "incomplete_truncated_completion", source: "orchestrator" }),
    });

    // Totals must be the SUM of the main call and the repair call, not just the main call.
    expect(result.turnTrace.completion?.usage).toEqual({
      inputTokens: mainUsage.prompt_tokens + repairUsage.prompt_tokens,
      outputTokens: mainUsage.completion_tokens + repairUsage.completion_tokens,
      cachedInputTokens: mainUsage.cached_prompt_tokens + repairUsage.cached_prompt_tokens,
      costUsd: mainUsage.cost_usd + repairUsage.cost_usd,
      costSource: "provider_reported",
    });
    expect(result.turnTrace.completion?.providerCallCount).toBe(2);
    expect(result.turnTrace.completion?.firstProviderRequestUsage).toMatchObject({
      reportedInputTokens: mainUsage.prompt_tokens,
      effectiveInputTokens: mainUsage.prompt_tokens,
      source: "provider_reported",
      availability: "reported",
    });
    expect(result.usage).toEqual(result.turnTrace.completion?.usage);
  });

  it("counts the repair provider call even when it reports no usage (no NaN)", async () => {
    const mainUsage = {
      prompt_tokens: 80,
      completion_tokens: 10,
      cost_usd: 0.005,
      cost_source: "provider_reported",
    };
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Partial answer that is truncated" },
            finish_reason: "length",
          },
        ],
        usage: mainUsage,
      })
      // Repair completion WITHOUT a usage payload.
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "A clean repaired answer with no usage payload." },
            finish_reason: "stop",
          },
        ],
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-usage-repair-no-usage-1",
      turnId: randomUUID(),
      userMessageId: "msg-usage-repair-no-usage-1",
      content: "Summarize the design.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Summarize the design." }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    // Token totals stay equal to the main call (no NaN from the usage-less repair call).
    expect(result.turnTrace.completion?.usage).toEqual({
      inputTokens: mainUsage.prompt_tokens,
      outputTokens: mainUsage.completion_tokens,
      costUsd: mainUsage.cost_usd,
      costSource: "provider_reported",
    });
    // The repair call is still a provider call and is counted.
    expect(result.turnTrace.completion?.providerCallCount).toBe(2);
    expect(result.turnTrace.completion?.firstProviderRequestUsage?.effectiveInputTokens).toBe(mainUsage.prompt_tokens);
  });

  it("marks a usage-less first request unavailable and stores a deterministic estimate", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValue({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "A complete response without provider usage." },
          finish_reason: "stop",
        },
      ],
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion,
      invokeTool: vi.fn(),
    });
    const input = {
      ...baseTurnInput(),
      compactionDimensionHash: "dimension-usage-less",
    };

    const first = await orchestrator.run(input);
    const secondOrchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion,
      invokeTool: vi.fn(),
    });
    const second = await secondOrchestrator.run({ ...input, turnId: randomUUID() });

    expect(first.turnTrace.completion?.firstProviderRequestUsage).toEqual({
      effectiveInputTokens: expect.any(Number),
      source: "deterministic_estimate",
      availability: "unavailable",
      unavailableReason: "provider_usage_missing",
      providerId: "glm",
      model: "glm-5",
      compactionDimensionHash: "dimension-usage-less",
    });
    expect(first.turnTrace.completion?.firstProviderRequestUsage?.effectiveInputTokens).toBeGreaterThan(0);
    expect(second.turnTrace.completion?.firstProviderRequestUsage?.effectiveInputTokens).toBe(
      first.turnTrace.completion?.firstProviderRequestUsage?.effectiveInputTokens,
    );
  });

  it("fails compaction-dimension binding closed when the first response used a fallback route", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValue({
      model: "gpt-4.1",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Fallback response." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 321, completion_tokens: 12 },
      routing: {
        primaryProviderId: "glm",
        primaryModel: "glm-5",
        effectiveProviderId: "openai",
        effectiveModel: "gpt-4.1",
        fallbackProviderId: "openai",
        fallbackModel: "gpt-4.1",
        fallbackUsed: true,
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      ...baseTurnInput(),
      compactionDimensionHash: "glm-dimension",
    });

    expect(result.turnTrace.completion?.firstProviderRequestUsage).toMatchObject({
      reportedInputTokens: 321,
      effectiveInputTokens: 321,
      providerId: "openai",
      model: "gpt-4.1",
      availability: "reported",
    });
    expect(result.turnTrace.completion?.firstProviderRequestUsage?.compactionDimensionHash).toBeUndefined();
  });

  it("retains compaction-dimension binding when response routing confirms the sealed first route", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValue({
      model: "glm-5-provider-version",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Primary response." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 222, completion_tokens: 10 },
      routing: {
        primaryProviderId: "glm",
        primaryModel: "glm-5",
        effectiveProviderId: "glm",
        effectiveModel: "glm-5",
        fallbackUsed: false,
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      ...baseTurnInput(),
      compactionDimensionHash: "glm-dimension",
    });

    expect(result.turnTrace.completion?.firstProviderRequestUsage).toMatchObject({
      providerId: "glm",
      model: "glm-5",
      compactionDimensionHash: "glm-dimension",
    });
  });

  it("never substitutes non-stream fallback usage for a failed first streaming request", async () => {
    const fallbackUsage = {
      prompt_tokens: 777,
      completion_tokens: 12,
      cost_usd: 0.01,
      cost_source: "provider_reported",
    };
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValue({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Recovered through the non-streaming fallback." },
          finish_reason: "stop",
        },
      ],
      usage: fallbackUsage,
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion,
      createChatCompletionStream: async function* () {
        const unreachableChunks: Record<string, unknown>[] = [];
        yield* unreachableChunks;
        throw new Error("stream failed before usage");
      },
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run(baseTurnInput());

    expect(result.turnTrace.completion?.usage?.inputTokens).toBe(fallbackUsage.prompt_tokens);
    expect(result.turnTrace.completion?.providerCallCount).toBe(2);
    expect(result.turnTrace.completion?.firstProviderRequestUsage).toMatchObject({
      source: "deterministic_estimate",
      availability: "unavailable",
      unavailableReason: "request_failed_before_usage",
    });
    expect(result.turnTrace.completion?.firstProviderRequestUsage?.reportedInputTokens).toBeUndefined();
    expect(result.turnTrace.completion?.firstProviderRequestUsage?.effectiveInputTokens).not.toBe(
      fallbackUsage.prompt_tokens,
    );
  });

  // The synthesis fallback path inside a full turn depends on several content
  // heuristics that are awkward to drive deterministically, so its usage
  // surfacing is verified directly at the method boundary. The call sites fold
  // this returned usage in with the SAME accrueCompletionUsage helper exercised
  // end to end by the repair-path tests above.
  it("synthesizeToolOutcomeFallback surfaces the provider call usage and count", async () => {
    const synthesisUsage = {
      prompt_tokens: 30,
      completion_tokens: 25,
      cached_prompt_tokens: 4,
      cost_usd: 0.006,
      cost_source: "provider_reported",
    };
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValue({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "A synthesized answer built from the captured tool evidence." },
          finish_reason: "stop",
        },
      ],
      usage: synthesisUsage,
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });
    const synthesize = (
      orchestrator as unknown as { synthesizeToolOutcomeFallback: SynthesizeToolOutcomeFallback }
    ).synthesizeToolOutcomeFallback.bind(orchestrator);

    const fallback = await synthesize({
      input: baseTurnInput(),
      toolRuns: [],
      allowOverBudget: true,
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(fallback.deterministic).toBe(false);
    expect(fallback.providerCalls).toBe(1);
    expect(fallback.usage).toEqual({
      inputTokens: synthesisUsage.prompt_tokens,
      outputTokens: synthesisUsage.completion_tokens,
      cachedInputTokens: synthesisUsage.cached_prompt_tokens,
      costUsd: synthesisUsage.cost_usd,
      costSource: "provider_reported",
    });
  });

  it("synthesizeToolOutcomeFallback counts the provider call even when it throws (no usage)", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockRejectedValue(new Error("provider unavailable"));
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });
    const synthesize = (
      orchestrator as unknown as { synthesizeToolOutcomeFallback: SynthesizeToolOutcomeFallback }
    ).synthesizeToolOutcomeFallback.bind(orchestrator);

    const fallback = await synthesize({
      input: baseTurnInput(),
      toolRuns: [],
      allowOverBudget: true,
    });

    // The deterministic fallback is used, but the failed provider call is still counted with no usage.
    expect(fallback.deterministic).toBe(true);
    expect(fallback.providerCalls).toBe(1);
    expect(fallback.usage).toBeNull();
  });
});
