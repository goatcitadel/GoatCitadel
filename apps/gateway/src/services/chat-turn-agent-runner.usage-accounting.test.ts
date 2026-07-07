import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ChatStreamUsageRecord, ChatToolRunRecord } from "@goatcitadel/contracts";
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
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content: "What do the design notes say?" }],
  };
}

// Regression coverage for AGENTORCH-004: secondary provider calls (repair /
// synthesis / image generation) must accrue into the turn's usage totals and
// providerCallCount, otherwise turns that trigger them under-report cost.
describe("ChatTurnAgentRunner secondary-call usage accounting", () => {
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
      cachedInputTokens: 0,
      costUsd: mainUsage.cost_usd,
      costSource: "provider_reported",
    });
    // The repair call is still a provider call and is counted.
    expect(result.turnTrace.completion?.providerCallCount).toBe(2);
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
