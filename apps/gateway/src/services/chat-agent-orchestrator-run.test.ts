import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator, type ChatAgentTurnInput } from "./chat-agent-orchestrator.js";
import { createMockStorage } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator run", () => {
  it("aggregates stream output, trace, model, and empty approval state", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion: vi.fn<() => Promise<ChatCompletionResponse>>(),
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run(turnInput("I'll paste logs after this message."));

    expect(result.assistantContent).toContain("the log blob wasn't pasted");
    expect(result.assistantModel).toBe("glm-5");
    expect(result.requiresApproval).toBeUndefined();
    expect(result.turnTrace).toMatchObject({
      sessionId: "sess-run-coverage",
      turnId: "turn-run-coverage",
      status: "completed",
      model: "glm-5",
    });
  });
});

function turnInput(content: string): ChatAgentTurnInput {
  return {
    sessionId: "sess-run-coverage",
    turnId: "turn-run-coverage",
    userMessageId: "msg-run-coverage",
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
