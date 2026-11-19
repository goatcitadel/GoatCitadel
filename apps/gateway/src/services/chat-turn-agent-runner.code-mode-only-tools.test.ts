import { describe, expect, it, vi } from "vitest";
import type { ChatTurnAgentRunnerInput, ChatTurnAgentRunnerDeps } from "./chat-turn-agent-runner.js";
import type { ToolCatalogEntry } from "@goatcitadel/contracts";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import { createMockStorage } from "./chat-turn-agent-runner-test-fixtures.js";

const DOC_HELPER_TOOL_NAMES = ["docs.read_bytes", "docs.extract_text", "docs.decompress"];

function catalog(): ToolCatalogEntry[] {
  return ["fs.read", ...DOC_HELPER_TOOL_NAMES].map((toolName) => ({
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
    codeModeAllowed: true,
    // Even a registry entry that recommends chat must not reach the model.
    recommendedContexts: ["chat", "project_bound"],
  }));
}

function input(content: string): ChatTurnAgentRunnerInput {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    userMessageId: "message-1",
    content,
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
    historyMessages: [{ role: "user", content }],
  };
}

function runner(): ChatTurnAgentRunner {
  const deps: ChatTurnAgentRunnerDeps = {
    storage: createMockStorage() as ChatTurnAgentRunnerDeps["storage"],
    listToolCatalog: catalog,
    createChatCompletion: vi.fn(),
    invokeTool: vi.fn(),
    evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
  };
  return new ChatTurnAgentRunner(deps);
}

describe("ChatTurnAgentRunner Code Mode-only document helpers", () => {
  it("completes a standalone Code Mode turn from its recorded approval result without a model call", async () => {
    const storage = createMockStorage() as ChatTurnAgentRunnerDeps["storage"];
    const createChatCompletion = vi.fn();
    const invokeTool = vi.fn();
    const request = input(
      "Use the governed code_mode.request tool and open its operator approval card. Goal: verify 6 × 7. Language: JavaScript. Source: return 6 * 7; Reads: none.",
    );
    await storage.chatToolRuns.create({
      toolRunId: "test-tool",
      sessionId: request.sessionId,
      turnId: request.turnId,
      approvalId: "test-approval",
      toolName: "code_mode.request",
      status: "executed",
      startedAt: "2026-11-18T15:31:20.000Z",
      finishedAt: "2026-11-18T15:31:23.000Z",
      args: { source: "return 6 * 7;", reads: [] },
      result: { status: "completed", runId: "test-code-run", result: { value: 42 } },
    });
    const agent = new ChatTurnAgentRunner({ storage, listToolCatalog: catalog, createChatCompletion, invokeTool });
    const result = await agent.run({ ...request, authActorSource: "loopback" });
    expect(result.assistantContent).toBe("Code Mode returned **42**.");
    expect(result.turnTrace).toMatchObject({
      status: "completed",
      completion: { providerCallCount: 0 },
      toolRuns: [{ toolRunId: "test-tool", status: "executed" }],
    });
    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("gives an explicit Code Mode run request the sign-in steps without asking a model", async () => {
    const createChatCompletion = vi.fn();
    const invokeTool = vi.fn();
    const agent = new ChatTurnAgentRunner({
      storage: createMockStorage() as ChatTurnAgentRunnerDeps["storage"],
      listToolCatalog: catalog,
      createChatCompletion,
      invokeTool,
      getCodeModeReadiness: async () => ({
        enabled: false,
        sandboxEnabled: false,
        sandboxSupported: true,
        canRun: false,
        reason: "code_mode_off",
      }),
    });
    const result = await agent.run({
      ...input("For this synthetic test, please ask me to approve a Code Mode run that returns 42."),
      authActorSource: "none",
    });
    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("[Settings › Access](/settings/access)");
    expect(result.assistantContent).toContain("Turn on Code Mode and run");
    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("never exposes docs.read_bytes, docs.extract_text or docs.decompress to the chat model", async () => {
    for (const content of [
      "Read the file ./report.pdf and tell me what it says.",
      `Please call ${DOC_HELPER_TOOL_NAMES.join(", ")} on ./report.pdf.`,
    ]) {
      const schema = await runner().resolveCapabilityToolSchema(input(content));
      const exposed = [...schema.canonicalToModel.keys()];
      for (const name of DOC_HELPER_TOOL_NAMES) expect(exposed, `${name} for "${content}"`).not.toContain(name);
    }
  });
});
