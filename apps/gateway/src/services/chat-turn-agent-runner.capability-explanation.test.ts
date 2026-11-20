import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { ChatCompletionRequest, ChatCompletionResponse, ToolAccessEvaluateResponse } from "@goatcitadel/contracts";
import { createDefaultToolRegistry } from "@goatcitadel/policy-engine";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerDeps } from "./chat-turn-agent-runner.js";
import { createMockStorage } from "./chat-turn-agent-runner-test-fixtures.js";

describe("Chat capability explanation exposure", () => {
  it.each(["auto", "deep"] as const)("honors a no-browse instruction with Web %s", async (webMode) => {
    const registry = createDefaultToolRegistry();
    const invokeTool = vi.fn(async () => {
      throw new Error("Unexpected tool dispatch");
    });
    const createChatCompletion = vi.fn(
      async (_request: ChatCompletionRequest): Promise<ChatCompletionResponse> => ({
        model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "I can explain what is available." } }],
      }),
    );
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as ChatTurnAgentRunnerDeps["storage"],
      listToolCatalog: () =>
        ["browser.search", "capabilities.explain"].map((toolName) => ({
          ...registry.get(toolName)!,
          toolName,
          examples: [],
        })),
      createChatCompletion,
      invokeTool,
      boundedToolExposureV1Enabled: async () => true,
      inspectToolAccess: async () =>
        ({ allowed: true, requiresApproval: false, reasonCodes: [] }) as ToolAccessEvaluateResponse,
    });
    const content =
      "Use capabilities.explain to tell me what you can currently do with web search. Only inspect capability status; do not browse the web, change settings, or run code.";
    await runner.run({
      sessionId: "capability-session",
      turnId: randomUUID(),
      userMessageId: "message",
      content,
      mode: "chat",
      providerId: "test",
      model: "test",
      webMode,
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content }],
    });
    expect(invokeTool).not.toHaveBeenCalled();
    const tools = JSON.stringify(createChatCompletion.mock.calls[0]?.[0].tools ?? []);
    expect(tools).toContain("capabilities_explain");
    expect(tools).not.toContain("browser_search");
  });

  it.each([false, true])(
    "offers explanation with bounded discovery %s, through the regular policy filter",
    async (bounded) => {
      const requests: ChatCompletionRequest[] = [];
      const definition = createDefaultToolRegistry().get("capabilities.explain")!;
      const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
        requests.push(request);
        return {
          model: "test",
          choices: [
            { index: 0, message: { role: "assistant", content: "I can check current capability availability." } },
          ],
        };
      });
      let allowed = true;
      const runner = new ChatTurnAgentRunner({
        storage: createMockStorage() as ChatTurnAgentRunnerDeps["storage"],
        listToolCatalog: () => [{ ...definition, toolName: definition.name, examples: [] }],
        createChatCompletion,
        invokeTool: vi.fn(),
        boundedToolExposureV1Enabled: async () => bounded,
        inspectToolAccess: async () =>
          ({
            allowed,
            requiresApproval: false,
            reasonCodes: allowed ? [] : ["policy_deny"],
          }) as ToolAccessEvaluateResponse,
      });
      const input = {
        sessionId: "capability-session",
        turnId: randomUUID(),
        userMessageId: "message",
        content: "What can you do?",
        mode: "chat" as const,
        providerId: "test",
        model: "test",
        webMode: "off" as const,
        memoryMode: "off" as const,
        thinkingLevel: "standard" as const,
        toolAutonomy: "safe_auto" as const,
        historyMessages: [{ role: "user" as const, content: "What can you do?" }],
      };
      await runner.run(input);
      expect(JSON.stringify(requests[0]!.tools)).toContain("capabilities_explain");
      allowed = false;
      requests.length = 0;
      await runner.run({ ...input, turnId: randomUUID() });
      expect(JSON.stringify(requests[0]!.tools ?? [])).not.toContain("capabilities_explain");
    },
  );
});
