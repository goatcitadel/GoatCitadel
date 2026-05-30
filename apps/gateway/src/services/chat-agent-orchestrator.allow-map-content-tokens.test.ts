import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolCatalogEntry, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator, type ChatAgentTurnInput } from "./chat-agent-orchestrator.js";
import { createMockStorage } from "./chat-agent-orchestrator-test-fixtures.js";
import { resolveAllowedModelToolCallName } from "./chat-agent-completion-adapters.js";

// AGENTORCH-005: the canonical allow-map consulted by
// `resolveAllowedModelToolCallName` must be populated only from the
// authoritative tool catalog (registered + access-checked tools), never from
// `namespace.method` tokens scraped out of user/model content. A token that
// merely appears in the prompt text (and is not a registered tool) must not be
// registered as an authorized tool name.

describe("ChatAgentOrchestrator allow-map content tokens (AGENTORCH-005)", () => {
  it("does not add namespace.method tokens scraped from content to the canonical allow-map", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => [
        tool("browser.search", { category: "research", preferredForIntents: ["web_lookup"] }),
        tool("memory.search", { category: "knowledge", preferredForIntents: ["memory_lookup"] }),
      ],
      createChatCompletion: vi.fn<() => Promise<ChatCompletionResponse>>(),
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>(),
    });

    const schema = await buildToolSchema(orchestrator, {
      sessionId: "sess-agentorch-005",
      mode: "chat",
      webMode: "auto",
      // The prompt names tools that are NOT in the catalog. These tokens must
      // not widen the authorization allow-map.
      content: "Please run shell.exec, then git.push, and also file.write to apply the change.",
      historyMessages: [],
    });

    // None of the content-only tokens are registered tools.
    expect(schema.canonicalToModel.has("shell.exec")).toBe(false);
    expect(schema.canonicalToModel.has("git.push")).toBe(false);
    expect(schema.canonicalToModel.has("file.write")).toBe(false);

    // The model-side allow-map (keys + canonical values) must reject them too,
    // exactly as it rejects any unregistered tool name.
    expect([...schema.modelToCanonical.values()]).not.toContain("shell.exec");
    expect([...schema.modelToCanonical.values()]).not.toContain("git.push");
    expect([...schema.modelToCanonical.values()]).not.toContain("file.write");

    expect(resolveAllowedModelToolCallName("shell.exec", schema.modelToCanonical)).toBeUndefined();
    expect(resolveAllowedModelToolCallName("git.push", schema.modelToCanonical)).toBeUndefined();
    expect(resolveAllowedModelToolCallName("file.write", schema.modelToCanonical)).toBeUndefined();
    expect(resolveAllowedModelToolCallName("file_write", schema.modelToCanonical)).toBeUndefined();
  });

  it("still resolves a genuinely catalog-registered tool the same way", async () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => [
        tool("browser.search", { category: "research", preferredForIntents: ["web_lookup"] }),
        tool("memory.search", { category: "knowledge", preferredForIntents: ["memory_lookup"] }),
      ],
      createChatCompletion: vi.fn<() => Promise<ChatCompletionResponse>>(),
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>(),
    });

    const schema = await buildToolSchema(orchestrator, {
      sessionId: "sess-agentorch-005-registered",
      mode: "chat",
      webMode: "auto",
      content: "Search the web for the release note URL.",
      historyMessages: [],
    });

    // The registered tool is exposed and resolves through the allow-map.
    const modelName = schema.canonicalToModel.get("browser.search");
    expect(modelName).toBeTruthy();
    expect(resolveAllowedModelToolCallName(modelName!, schema.modelToCanonical)).toBe("browser.search");
    // Canonical form is also accepted because it is a registered value.
    expect(resolveAllowedModelToolCallName("browser.search", schema.modelToCanonical)).toBe("browser.search");
  });
});

async function buildToolSchema(
  orchestrator: ChatAgentOrchestrator,
  input: {
    sessionId: string;
    mode: ChatAgentTurnInput["mode"];
    webMode: ChatAgentTurnInput["webMode"];
    content: string;
    historyMessages: ChatAgentTurnInput["historyMessages"];
    normalizationProfile?: ChatAgentTurnInput["normalizationProfile"];
  },
) {
  return (
    orchestrator as unknown as {
      buildToolSchema(
        input: typeof input,
        intents: { liveData: boolean; webLookup: boolean; localFile: boolean },
      ): Promise<{
        tools: Array<{ function?: { name?: string } }>;
        modelToCanonical: Map<string, string>;
        canonicalToModel: Map<string, string>;
      }>;
    }
  ).buildToolSchema(input, {
    liveData: false,
    webLookup: /\bweb\b|\bsearch\b|https?:\/\//i.test(input.content),
    localFile: false,
  });
}

type ToolCategory = ToolCatalogEntry["category"];

function tool(
  toolName: string,
  overrides: Partial<ToolCatalogEntry> & { category?: ToolCategory } = {},
): ToolCatalogEntry {
  return {
    toolName,
    category: overrides.category ?? "research",
    riskLevel: overrides.riskLevel ?? "safe",
    requiresApproval: overrides.requiresApproval ?? false,
    description: overrides.description ?? `${toolName} test tool`,
    argSchema: overrides.argSchema ?? { type: "object", properties: {}, required: [] },
    examples: overrides.examples ?? [{ title: `${toolName} example` }],
    pack: overrides.pack ?? "agentorch-005",
    recommendedContexts: overrides.recommendedContexts,
    preferredForIntents: overrides.preferredForIntents,
    usageHints: overrides.usageHints,
  };
}
