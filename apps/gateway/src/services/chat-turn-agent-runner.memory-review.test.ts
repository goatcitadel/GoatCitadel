import { expect, it, vi } from "vitest";
import {
  ChatTurnAgentRunner,
  type ChatTurnAgentRunnerDeps,
  type ChatTurnAgentRunnerInput,
} from "./chat-turn-agent-runner.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

function harness() {
  const invokeTool = vi.fn(async () => ({ ok: true }));
  const createChatCompletion = vi.fn().mockResolvedValue({
    model: "test",
    choices: [{ index: 0, message: { role: "assistant", content: "Your preference is awaiting review." } }],
  });
  const runner = new ChatTurnAgentRunner({
    storage: createMockStorage() as ChatTurnAgentRunnerDeps["storage"],
    listToolCatalog: () => createToolCatalog(["memory.write", "memory.upsert", "memory.search"]),
    createChatCompletion,
    invokeTool,
    evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
  });
  const input: ChatTurnAgentRunnerInput = {
    sessionId: "s",
    turnId: "t",
    userMessageId: "u",
    content: "Remember that I prefer concise replies.",
    mode: "chat",
    providerId: "test",
    model: "test",
    webMode: "off",
    memoryMode: "on",
    retrievalMode: "standard",
    thinkingLevel: "off",
    speedMode: "standard",
    subagentPolicy: "off",
    toolAutonomy: "safe_auto",
    naturalMemoryReviewOnly: true,
    historyMessages: [{ role: "user", content: "Remember that I prefer concise replies." }],
  };
  return { runner, input, invokeTool, createChatCompletion };
}
it("withholds duplicate memory writes from the provider and both execution allow maps", async () => {
  const { runner, input } = harness();
  const schema = await runner.resolveCapabilityToolSchema(input);
  expect(schema.tools).toEqual([]);
  expect(schema.canonicalToModel.has("memory.search")).toBe(false);
  for (const name of ["memory.write", "memory.upsert"]) {
    expect(schema.canonicalToModel.has(name)).toBe(false);
    expect([...schema.modelToCanonical.values()]).not.toContain(name);
  }
  expect(JSON.stringify(schema.tools)).not.toMatch(/memory_(?:write|upsert)/);
  const ordinary = await runner.resolveCapabilityToolSchema({ ...input, naturalMemoryReviewOnly: false });
  expect(ordinary.canonicalToModel.has("memory.write")).toBe(true);
});
it("does not dispatch a hallucinated memory write while its preference is already on the review path", async () => {
  const { runner, input, invokeTool, createChatCompletion } = harness();
  createChatCompletion.mockResolvedValueOnce(
    namedToolCallCompletion("memory.write", { content: "I prefer concise replies.", namespace: "preferences" }),
  );
  await runner.run(input);
  expect(invokeTool).not.toHaveBeenCalled();
  expect(createChatCompletion).toHaveBeenCalled();
});

it("finishes a preference-only review without dispatching a model-requested search that would introduce another approval", async () => {
  const { runner, input, invokeTool, createChatCompletion } = harness();
  createChatCompletion.mockResolvedValueOnce(namedToolCallCompletion("memory.search", { query: "concise replies" }));
  await runner.run(input);
  expect(invokeTool).not.toHaveBeenCalled();
  const ordinary = await runner.resolveCapabilityToolSchema({ ...input, naturalMemoryReviewOnly: false });
  expect(ordinary.canonicalToModel.has("memory.search")).toBe(true);
});
