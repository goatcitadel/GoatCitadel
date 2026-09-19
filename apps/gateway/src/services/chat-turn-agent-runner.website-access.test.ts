import { describe, expect, it, vi } from "vitest";
import type { ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  createEffectAwareInvokeToolForTest,
  createExecuteToolCallForTest,
  createMockStorage,
  createToolCatalog,
} from "./chat-turn-agent-runner-test-fixtures.js";

const WEB_TOOLS = ["browser.search", "browser.navigate", "http.get"];
const CONTENT =
  "I need you to act like a head of marketing and help me increase traffic to my website, www.irolled20.com.";

function input(overrides: Partial<ChatTurnAgentRunnerInput> = {}): ChatTurnAgentRunnerInput {
  return {
    sessionId: "website-session",
    turnId: "website-turn",
    userMessageId: "website-message",
    content: CONTENT,
    mode: "chat",
    webMode: "auto",
    fullWebAccess: true,
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content: CONTENT }],
    ...overrides,
  };
}

function runner(allowed = true) {
  return new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(WEB_TOOLS),
    createChatCompletion: vi.fn(),
    invokeTool: vi.fn(),
    inspectToolAccess: vi.fn(async () => ({
      allowed,
      requiresApproval: false,
      reasonCodes: allowed ? ["allowed"] : ["policy_deny"],
    })),
  });
}

describe("website tool selection before capability profile freeze", () => {
  it("includes the approved web tools for the supplied website", async () => {
    const schema = await runner().resolveCapabilityToolSchema(input());
    expect([...schema.canonicalToModel.keys()]).toEqual(expect.arrayContaining(WEB_TOOLS));
    expect(schema.policyDecisions).toHaveLength(WEB_TOOLS.length);
  });

  it.each(["browser.navigate", "http.get"])("normalizes the supplied website for %s arguments", async (toolName) => {
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      result: { url: "https://www.irolled20.com", text: "Find tabletop games and players." },
    });
    const execute = createExecuteToolCallForTest({
      invokeTool,
      invokeToolWithEffectTruth: createEffectAwareInvokeToolForTest(invokeTool),
      toolNames: [toolName],
    });
    const result = await execute({ input: input(), turnId: "website-turn", toolName, rawArgs: {} });
    expect(result.record.status).toBe("executed");
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName,
        args: expect.objectContaining({ url: "https://www.irolled20.com" }),
      }),
    );
  });

  it.each([
    { webMode: "off" as const },
    { toolAutonomy: "manual" as const },
    { content: "Tell me about Peaky Blinders." },
  ])("keeps full web access subordinate to turn settings and intent: %j", async (overrides) => {
    const schema = await runner().resolveCapabilityToolSchema(input(overrides));
    expect(schema.tools).toEqual([]);
  });

  it("does not expose policy-denied tools when full web access is enabled", async () => {
    const schema = await runner(false).resolveCapabilityToolSchema(input());
    expect(schema.tools).toEqual([]);
    expect(schema.policyDecisions).toEqual(
      WEB_TOOLS.map((toolName) => ({
        toolName,
        allowed: false,
        requiresApproval: false,
        reasonCodes: ["policy_deny"],
      })),
    );
  });
});
