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
