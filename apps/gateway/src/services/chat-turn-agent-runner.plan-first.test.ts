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

  it("asks the model for the plan when the request mentions a web lookup, instead of the settings-conflict answer", async () => {
    const plan = "1. Pick the area. 2. List candidate places. 3. Compare them.";
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValue({
        model: "glm-5",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: plan } }],
      });
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn() as never,
    });
    const prompt = "Look online and tell me the 5 most interesting things that happened today.";

    const result = await runner.run({ ...planFirstInput(prompt), planningMode: "advisory" });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(createChatCompletion.mock.calls[0]?.[0].tools ?? []).toEqual([]);
    expect(result.assistantContent).toBe(plan);
    expect(result.assistantContent).not.toContain("tool autonomy");
  });

  it("keeps the settings-conflict answer for a web lookup with manual autonomy when Plan first is off", async () => {
    const createChatCompletion = vi.fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>();
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn() as never,
    });

    const result = await runner.run({
      ...planFirstInput("Look online and tell me the 5 most interesting things that happened today."),
      planningMode: "off",
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("tool autonomy is set to Manual");
  });
  async function planFor(prompt: string) {
    const plan = "1. Outline the sections. 2. Draft each one. 3. Review it.";
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValue({
        model: "glm-5",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: plan } }],
      });
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "fs.write", "presentations.create"]),
      createChatCompletion,
      invokeTool: vi.fn() as never,
    });
    const result = await runner.run({ ...planFirstInput(prompt), planningMode: "advisory" });
    return { plan, result, createChatCompletion };
  }

  it("returns the model plan for a request that names a PowerPoint, not a missing-file failure", async () => {
    const { plan, result, createChatCompletion } = await planFor(
      "Create a PowerPoint presentation about our release plan.",
    );

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toBe(plan);
    expect(result.turnTrace.status).toBe("completed");
  });

  it("returns the model plan for a request that names a document, a file or a PDF deck", async () => {
    const document = await planFor("Write a report document about our release plan and save it as release.docx.");
    const deck = await planFor("Create a PDF slide deck about our release plan.");

    expect(document.result.assistantContent).toBe(document.plan);
    expect(deck.result.assistantContent).toBe(deck.plan);
  });

  it("asks the model for the plan when the question would otherwise get a clarifying question first", async () => {
    const { plan, result, createChatCompletion } = await planFor("Estimate how many people live in my city?");

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toBe(plan);
  });
  it("asks the model for the plan when the request says a log will be pasted", async () => {
    const { plan, result } = await planFor("Plan how we will find the root cause once I paste the logs.");

    expect(result.assistantContent).toBe(plan);
  });
  it("never offers or resolves a delegation under Plan first, and still does when it is off", async () => {
    const prompt = "Research the best bookshelf designs then implement the build plan.";
    const build = (resolveConfirmedDelegation: ReturnType<typeof vi.fn>) =>
      new ChatTurnAgentRunner({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog(["browser.search", "agent.fanout"]),
        createChatCompletion: vi.fn(async () => ({
          model: "glm-5",
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "1. Research. 2. Build." } },
          ],
        })) as never,
        invokeTool: vi.fn() as never,
        resolveConfirmedDelegation: resolveConfirmedDelegation as never,
      });
    const resolveAdvisory = vi.fn(async () => ({ prompt: { promptId: "p", question: "Delegate this task?" } }));
    const advisory = await build(resolveAdvisory).run({
      ...planFirstInput(prompt),
      subagentPolicy: "ask_when_useful",
      planningMode: "advisory",
    });

    expect(resolveAdvisory).not.toHaveBeenCalled();
    expect(advisory.assistantContent).toBe("1. Research. 2. Build.");

    const resolveOff = vi.fn(async () => undefined);
    await build(resolveOff).run({ ...planFirstInput(prompt), subagentPolicy: "ask_when_useful", planningMode: "off" });
    expect(resolveOff).toHaveBeenCalledTimes(1);
  });
});
