import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type {
  ChatCompletionResponse,
  ChatTurnTraceRecord,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import { createMockStorage, createToolCatalog } from "./chat-turn-agent-runner-test-fixtures.js";

const MODEL_OUTPUT = "I can help with that, but I need to keep the plan concise.";

describe("ChatTurnAgentRunner loop38 cowork delegation eval-integrity behavior", () => {
  it("passes memory-only planning output through verbatim without injecting memory provenance scaffolds", async () => {
    const result = await runCoworkEvalTurn({
      sessionId: "sess-loop38-memory-planning",
      task: 'Cowork request: "Use memory tools only to check whether I have stored travel scheduling planning preferences before making a plan."',
      instruction:
        "Return Researcher and Operator Handoff sections. Do not invent durable preferences if memory evidence is absent.",
    });

    expect(result.assistantContent).toBe(MODEL_OUTPUT);
    expect(result.assistantContent).not.toContain("## Researcher");
    expect(result.assistantContent).not.toContain("Memory provenance");
    expect(result.invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.status).toBe("completed");
  });

  it("passes topical web-evidence cowork output through verbatim without appended sources or prefetch tool runs", async () => {
    const result = await runCoworkEvalTurn({
      sessionId: "sess-loop38-household-storm",
      task: 'Cowork request: "Find two practical household tips before a severe storm and keep local uncertainty visible."',
      instruction: "Use public-source framing if useful. Return Researcher, Synthesis, and Operator Handoff sections.",
    });

    expect(result.assistantContent).toBe(MODEL_OUTPUT);
    expect(result.assistantContent).not.toContain("## Sources Used");
    expect(result.assistantContent).not.toContain("Source URLs:");
    expect(result.turnTrace.toolRuns).toHaveLength(0);
    expect(result.invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.status).toBe("completed");
  });

  it("passes everyday cowork delegation output through verbatim without role-contract rewriting", async () => {
    const result = await runCoworkEvalTurn({
      sessionId: "sess-loop38-community-workshop",
      task: 'Cowork request: "Evaluate whether a community workshop next month is worth organizing, but stop before booking or publishing."',
      instruction: "Produce role-labeled sections for Researcher, Product, Operator, Planner, and Risk Review.",
    });

    expect(result.assistantContent).toBe(MODEL_OUTPUT);
    expect(result.assistantContent).not.toContain("Required Citations");
    expect(result.assistantContent).not.toContain("Operator Handoff");
    expect(result.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.turnTrace.status).toBe("completed");
  });
});

async function runCoworkEvalTurn(input: { sessionId: string; task: string; instruction: string }): Promise<{
  assistantContent: string;
  turnTrace: ChatTurnTraceRecord;
  invokeTool: Mock<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>;
  createChatCompletion: Mock<() => Promise<ChatCompletionResponse>>;
}> {
  const wrappedPrompt = [
    "## Prompt Lab Run Contract",
    "- Mode: cowork",
    "- Tool tier: no-tools",
    "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
    "",
    "## User Task",
    input.task,
    "",
    input.instruction,
  ].join("\n");
  const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
    model: "gpt-5.5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: MODEL_OUTPUT,
        },
      },
    ],
  });
  const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
  const orchestrator = new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog([]),
    createChatCompletion,
    invokeTool,
  });

  const result = await orchestrator.run({
    sessionId: input.sessionId,
    turnId: randomUUID(),
    userMessageId: `${input.sessionId}-message`,
    content: wrappedPrompt,
    mode: "cowork",
    providerId: "openai-codex",
    model: "gpt-5.5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "extended",
    toolAutonomy: "manual",
    normalizationProfile: "prompt_pack_harness",
    historyMessages: [{ role: "user", content: wrappedPrompt }],
  });

  return {
    assistantContent: result.assistantContent,
    turnTrace: result.turnTrace,
    invokeTool,
    createChatCompletion,
  };
}
