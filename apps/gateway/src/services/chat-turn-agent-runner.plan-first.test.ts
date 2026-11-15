import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

// Plan first asks the model for a plan with manual tool autonomy (the Gateway forces it for advisory planning).
// The turn must stay advisory: the model is offered no tools and nothing it returns is executed.
function planFirstInput(content: string): ChatTurnAgentRunnerInput {
  return {
    sessionId: "sess-plan-first",
    turnId: "turn-plan-first",
    userMessageId: "msg-plan-first",
    content,
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "auto",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "manual",
    historyMessages: [{ role: "user", content }],
  };
}

describe("ChatTurnAgentRunner Plan first turn", () => {
  it("makes one model call that offers no tools and returns the model's plan", async () => {
    const plan = "1. Clear the shelf.\n2. Sort the books.\n3. Put them back.";
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValue({
        model: "glm-5",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: plan } }],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "fs.write", "agent.fanout"]),
      createChatCompletion,
      invokeTool: invokeTool as never,
    });

    const result = await runner.run(planFirstInput("Plan three steps to tidy a small bookshelf."));

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(createChatCompletion.mock.calls[0]?.[0].tools ?? []).toEqual([]);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toBe(plan);
    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.toolRuns ?? []).toEqual([]);
  });

  it("does not run a tool call the model returns anyway", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValue(namedToolCallCompletion("fs.write", { path: "notes.txt", content: "changed" }));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "fs.write", "agent.fanout"]),
      createChatCompletion,
      invokeTool: invokeTool as never,
    });

    const result = await runner.run(planFirstInput("Plan the cleanup and write it to notes.txt."));

    // The empty-answer recovery may ask once more; no request ever offers a tool and none is executed.
    expect(createChatCompletion).toHaveBeenCalled();
    for (const [request] of createChatCompletion.mock.calls) {
      expect(request.tools ?? []).toEqual([]);
    }
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns ?? []).toEqual([]);
  });
});
