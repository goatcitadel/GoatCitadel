import { describe, expect, it, vi } from "vitest";
import type { ChatTurnAgentRunnerInput, ChatTurnAgentRunnerDeps } from "./chat-turn-agent-runner.js";
import type { ToolCatalogEntry } from "@goatcitadel/contracts";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import { createMockStorage } from "./chat-turn-agent-runner-test-fixtures.js";

const CONTEXT_TOOL_NAMES = ["context.list", "context.grep", "context.query", "context.read_range"];

function catalog(): ToolCatalogEntry[] {
  return CONTEXT_TOOL_NAMES.map((toolName) => ({
    toolName,
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    description: toolName,
    argSchema: { type: "object", properties: {} },
    examples: [],
    pack: "core",
    readOnly: true,
    deterministic: true,
    recommendedContexts: ["chat"],
    preferredForIntents: ["attached_context"],
  }));
}

function input(overrides: Partial<ChatTurnAgentRunnerInput> = {}): ChatTurnAgentRunnerInput {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    userMessageId: "message-1",
    content: "Summarize the attached architecture notes.",
    mode: "chat",
    providerId: "provider-1",
    model: "model-1",
    webMode: "off",
    memoryMode: "off",
    retrievalMode: "standard",
    thinkingLevel: "standard",
    speedMode: "standard",
    subagentPolicy: "off",
    toolAutonomy: "safe_auto",
    routedContextRequested: true,
    historyMessages: [{ role: "user", content: "Summarize the attached architecture notes." }],
    ...overrides,
  };
}

function runner(featureEnabled: boolean): ChatTurnAgentRunner {
  const deps: ChatTurnAgentRunnerDeps = {
    storage: createMockStorage() as ChatTurnAgentRunnerDeps["storage"],
    listToolCatalog: catalog,
    createChatCompletion: vi.fn(),
    invokeTool: vi.fn(),
    evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
    attachedContextToolsV1Enabled: () => featureEnabled,
  };
  return new ChatTurnAgentRunner(deps);
}

describe("ChatTurnAgentRunner attached-context capability exposure", () => {
  it("pins all four safe tools into a routed turn capability profile", async () => {
    const schema = await runner(true).resolveCapabilityToolSchema(input());
    expect([...schema.canonicalToModel.keys()]).toEqual(CONTEXT_TOOL_NAMES);
    expect(schema.policyDecisions).toEqual(
      CONTEXT_TOOL_NAMES.map((toolName) => ({
        toolName,
        allowed: true,
        requiresApproval: false,
        reasonCodes: [],
      })),
    );
  });

  it("does not expose the tools without routed references or while the gate is disabled", async () => {
    expect([
      ...(
        await runner(true).resolveCapabilityToolSchema(input({ routedContextRequested: false }))
      ).canonicalToModel.keys(),
    ]).toEqual([]);
    expect([...(await runner(false).resolveCapabilityToolSchema(input())).canonicalToModel.keys()]).toEqual([]);
  });
});
