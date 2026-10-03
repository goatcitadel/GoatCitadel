import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse, ToolInvokeResult } from "@goatcitadel/contracts";
import { buildModelVisibleContextBudget } from "./chat-agent-prompt-budget-receipt.js";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  EffectAwareChatTurnAgentRunner,
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

const request: ChatCompletionRequest = {
  providerId: "frozen-provider",
  model: "frozen-model",
  max_tokens: 1000,
  messages: [{ role: "user", content: "A private question" }],
  tools: [{ type: "function", function: { name: "session_status", parameters: { type: "object" } } }],
};

describe("model-visible context estimates", () => {
  it("accounts for tools, new results, and output reserve without returning content", () => {
    const initial = buildModelVisibleContextBudget(request, 8000);
    const next = buildModelVisibleContextBudget(
      {
        ...request,
        messages: [...request.messages, { role: "tool", tool_call_id: "call-1", content: "long result ".repeat(200) }],
      },
      8000,
    );
    expect(next.estimatedInputTokens).toBeGreaterThan(initial.estimatedInputTokens);
    expect(next.remainingInputTokens).toBe(8000 - next.estimatedInputTokens - 1000);
    expect(buildModelVisibleContextBudget({ ...request, tools: [] }, 8000).estimatedInputTokens).toBeLessThan(
      initial.estimatedInputTokens,
    );
    expect(JSON.stringify(next)).not.toContain("A private question");
    expect(next.basis).toBe("next_provider_request_estimate");
  });

  it.each([undefined, 0, -1, NaN, Infinity, 2.5])("reports an unknown invalid model limit %s", (limit) => {
    expect(buildModelVisibleContextBudget(request, limit)).toMatchObject({
      contextWindowTokens: null,
      remainingInputTokens: null,
    });
  });

  it("preserves unknown output reserve and clamps exhausted headroom", () => {
    expect(buildModelVisibleContextBudget({ ...request, max_tokens: undefined }, 8000).remainingInputTokens).toBeNull();
    expect(buildModelVisibleContextBudget(request, 10).remainingInputTokens).toBe(0);
  });

  it.each([undefined, false, true])(
    "gates enrichment behind explicit opt-in %s using the exact route",
    async (enabled) => {
      const requests: ChatCompletionRequest[] = [];
      const getModelContextWindow = vi.fn(() => 8000);
      const invokeTool = vi.fn(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          auditEventId: "audit-status-1",
          result: { ok: true, sessionId: "sess-1" },
        }),
      );
      const runner = new EffectAwareChatTurnAgentRunner({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog(["session.status"]),
        createChatCompletion: async (input): Promise<ChatCompletionResponse> => {
          requests.push({ ...input, messages: [...input.messages] });
          return requests.length === 1
            ? namedToolCallCompletion("session.status", {})
            : {
                model: "frozen-model",
                choices: [{ index: 0, message: { role: "assistant", content: "Status inspected." } }],
              };
        },
        invokeTool,
        getModelContextWindow,
        ...(enabled === undefined ? {} : { chatContextBudgetVisibilityV1Enabled: () => enabled }),
      });
      const input: ChatTurnAgentRunnerInput = {
        sessionId: "sess-1",
        turnId: "turn-1",
        userMessageId: "msg-1",
        content: "Use session.status and explain readiness.",
        mode: "chat",
        providerId: "frozen-provider",
        model: "frozen-model",
        webMode: "off",
        memoryMode: "off",
        retrievalMode: "standard",
        thinkingLevel: "standard",
        speedMode: "standard",
        subagentPolicy: "off",
        toolAutonomy: "safe_auto",
        historyMessages: [{ role: "user", content: "Use session.status and explain readiness." }],
      };
      const result = await runner.run(input);
      expect(invokeTool).toHaveBeenCalledTimes(1);
      expect(result.turnTrace.toolRuns[0]?.status).toBe("executed");
      const providerResult = requests[1]?.messages.find((message) => message.role === "tool");
      const projected = JSON.parse(providerResult?.content as string);
      if (enabled) {
        expect(getModelContextWindow).toHaveBeenCalledWith("frozen-provider", "frozen-model");
        expect(projected.contextBudget).toMatchObject({
          providerId: "frozen-provider",
          model: "frozen-model",
          contextWindowTokens: 8000,
        });
        expect(result.turnTrace.toolRuns[0]?.result?.contextBudget).toEqual(projected.contextBudget);
      } else {
        expect(getModelContextWindow).not.toHaveBeenCalled();
        expect(projected.contextBudget).toBeUndefined();
      }
    },
  );
});
