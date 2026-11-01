import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse, ToolInvokeResult } from "@goatcitadel/contracts";
import { createDefaultToolRegistry } from "@goatcitadel/policy-engine";
import { extendTurnBudgetForBrowserErrand } from "./chat-agent-budget.js";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import { createMockStorage } from "./chat-turn-agent-runner-test-fixtures.js";

const ERRAND_MODEL_TOOL_NAME = "browser_errand";

function finalResponse(): ChatCompletionResponse {
  return {
    id: "chatcmpl-final",
    object: "chat.completion",
    created: 2,
    model: "glm-5",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done." } }],
  } as ChatCompletionResponse;
}

function turnInput(overrides: Partial<ChatTurnAgentRunnerInput> & { sessionSuffix: string }): ChatTurnAgentRunnerInput {
  const { sessionSuffix, ...rest } = overrides;
  return {
    sessionId: `sess-errand-${sessionSuffix}`,
    turnId: `turn-errand-${sessionSuffix}`,
    userMessageId: `msg-errand-${sessionSuffix}`,
    content: "Find a USB-C hub under $40 on the shop site and add it to my cart.",
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "auto",
    memoryMode: "off",
    thinkingLevel: "minimal",
    speedMode: "standard",
    normalizationProfile: "live",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content: "Find a USB-C hub under $40." }],
    ...rest,
  } as ChatTurnAgentRunnerInput;
}

function buildHarness(enabled: boolean | undefined) {
  const completionRequests: ChatCompletionRequest[] = [];
  const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
    completionRequests.push(request);
    return finalResponse();
  });
  const registry = createDefaultToolRegistry();
  const catalog = registry.toCatalog().filter((tool) => ["browser.errand", "memory.read"].includes(tool.toolName));
  const orchestrator = new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () => catalog,
    createChatCompletion: createChatCompletion as never,
    invokeTool: vi.fn(async () => ({ outcome: "executed", result: {} }) as ToolInvokeResult) as never,
    evaluateToolAccess: () => ({ allowed: true, requiresApproval: false, reasonCodes: [] }),
    ...(enabled === undefined ? {} : { browserErrandsEnabled: async () => enabled }),
  } as never);
  return { orchestrator, completionRequests };
}

function exposedToolNames(request: ChatCompletionRequest | undefined): string[] {
  return (request?.tools ?? [])
    .map((tool) => (tool as { function?: { name?: string } }).function?.name)
    .filter((name): name is string => typeof name === "string");
}

describe("ChatTurnAgentRunner browser.errand exposure", () => {
  it("hides browser.errand from the tool schema when the flag is off", async () => {
    for (const [suffix, enabled] of [
      ["off", false],
      ["unwired", undefined],
    ] as const) {
      const harness = buildHarness(enabled);
      await harness.orchestrator.run(turnInput({ sessionSuffix: suffix }));
      const names = exposedToolNames(harness.completionRequests[0]);
      expect(names).not.toContain(ERRAND_MODEL_TOOL_NAME);
    }
  });

  it("offers browser.errand in Chat when the flag is on", async () => {
    const harness = buildHarness(true);
    await harness.orchestrator.run(turnInput({ sessionSuffix: "on" }));
    expect(exposedToolNames(harness.completionRequests[0])).toContain(ERRAND_MODEL_TOOL_NAME);
  });
});

describe("extendTurnBudgetForBrowserErrand", () => {
  it("gives the turn back the time the errand took, and leaves other tools alone", () => {
    const base = { currentTurnBudgetMs: 240_000, turnBudgetDeadline: 1_000_000 };
    expect(extendTurnBudgetForBrowserErrand({ ...base, toolName: "browser.errand", elapsedMs: 600_000 })).toEqual({
      turnBudgetDeadline: 1_600_000,
      effectiveTurnBudgetMs: 840_000,
    });
    expect(extendTurnBudgetForBrowserErrand({ ...base, toolName: "browser.navigate", elapsedMs: 600_000 })).toEqual({
      turnBudgetDeadline: 1_000_000,
      effectiveTurnBudgetMs: 240_000,
    });
  });
});
