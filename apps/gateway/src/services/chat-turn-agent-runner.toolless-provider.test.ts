import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse, ToolInvokeResult } from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  EffectAwareChatTurnAgentRunner as ChatTurnAgentRunner,
  createMockStorage,
  createToolCatalog,
} from "./chat-turn-agent-runner-test-fixtures.js";

// The 2026-10-20 chat: a report/PDF request on the Claude Code CLI provider,
// which drops Gateway tools. The guard replaced the whole answer with
// "The requested file was not created." and gave no reason. The prompt drops the
// research wording so these Web-off turns reach the model.
const PDF_REPORT_PROMPT = "Write a short report on full stack web languages and then put it into a pdf.";
const CLI_LABEL = "Claude Code CLI (local login)";
const REPORT_TEXT = "## Full stack languages in 2026\n\nTypeScript leads for full stack web work.";

describe("ChatTurnAgentRunner file requests on a text-only provider", () => {
  it("keeps the answer, explains why no file exists, and skips the artifact retry", async () => {
    const providerRequests: ChatCompletionRequest[] = [];
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementation(async (request) => {
        providerRequests.push(request);
        return completion(REPORT_TEXT);
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["documents.create"]),
      createChatCompletion,
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>(),
      describeProviderToolSupport: (providerId) =>
        providerId === "claude-code-cli" ? { label: CLI_LABEL, toolCalling: false } : undefined,
    });

    const result = await orchestrator.run(turnInput({ content: PDF_REPORT_PROMPT }));

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(
      providerRequests[0]?.messages.some(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Write the complete requested content directly in your reply."),
      ),
    ).toBe(true);
    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain(`No file was created: ${CLI_LABEL} cannot use GoatCitadel tools`);
    expect(result.assistantContent).toContain("TypeScript leads for full stack web work.");
    expect(result.assistantContent).not.toContain("There is no successful artifact result");
  });

  it("keeps a deck answer on a text-only provider instead of failing the turn", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValue(completion("Slide 1: Why TypeScript"));
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["presentations.create"]),
      createChatCompletion,
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>(),
      describeProviderToolSupport: () => ({ label: CLI_LABEL, toolCalling: false }),
    });

    const result = await orchestrator.run(
      turnInput({ content: "Make me a PowerPoint deck about full stack languages." }),
    );

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain(`No file was created: ${CLI_LABEL}`);
    expect(result.assistantContent).toContain("Slide 1: Why TypeScript");
  });

  it("still drops a tool-capable provider's text when it made no file, since it may claim one", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValue(completion(REPORT_TEXT));
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["documents.create"]),
      createChatCompletion,
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>(),
      describeProviderToolSupport: () => ({ label: "GLM", toolCalling: true }),
    });

    const result = await orchestrator.run(turnInput({ content: PDF_REPORT_PROMPT, providerId: "glm", model: "glm-5" }));

    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.assistantContent).toBe(
      "The requested file was not created. There is no successful artifact result for this turn.",
    );
  });

  it("follows the provider that answered when a tool-capable primary falls back to a text-only one", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValue(fallbackCompletion(REPORT_TEXT, { from: "glm", to: "claude-code-cli" }));
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["documents.create"]),
      createChatCompletion,
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>(),
      describeProviderToolSupport: describeSupport,
    });

    const result = await orchestrator.run(turnInput({ content: PDF_REPORT_PROMPT, providerId: "glm", model: "glm-5" }));

    // No wasted artifact retry on the CLI, and its inline answer survives under the notice.
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toContain(`No file was created: ${CLI_LABEL}`);
    expect(result.assistantContent).toContain("TypeScript leads for full stack web work.");
  });

  it("follows the provider that answered when a text-only primary falls back to a tool-capable one", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValue(fallbackCompletion("I could not make the file.", { from: "claude-code-cli", to: "glm" }));
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["documents.create"]),
      createChatCompletion,
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>(),
      describeProviderToolSupport: describeSupport,
    });

    const result = await orchestrator.run(turnInput({ content: PDF_REPORT_PROMPT }));

    // The tool-capable fallback gets its artifact retry, and the tool-capable guard applies.
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.assistantContent).toBe(
      "The requested file was not created. There is no successful artifact result for this turn.",
    );
  });
});

function describeSupport(providerId: string): { label: string; toolCalling: boolean } | undefined {
  if (providerId === "claude-code-cli") return { label: CLI_LABEL, toolCalling: false };
  return providerId === "glm" ? { label: "GLM", toolCalling: true } : undefined;
}

function fallbackCompletion(content: string, route: { from: string; to: string }): ChatCompletionResponse {
  const model = route.to === "glm" ? "glm-5" : "claude-sonnet-5-5";
  return {
    ...completion(content),
    model,
    routing: {
      primaryProviderId: route.from,
      primaryModel: route.from === "glm" ? "glm-5" : "claude-sonnet-5-5",
      effectiveProviderId: route.to,
      effectiveModel: model,
      fallbackProviderId: route.to,
      fallbackModel: model,
      fallbackUsed: true,
    },
  } as ChatCompletionResponse;
}

function turnInput(overrides: Partial<ChatTurnAgentRunnerInput> = {}): ChatTurnAgentRunnerInput {
  const content = overrides.content ?? "Answer directly.";
  return {
    sessionId: "sess-toolless",
    turnId: randomUUID(),
    userMessageId: "msg-toolless",
    content,
    mode: "chat",
    providerId: "claude-code-cli",
    model: "claude-sonnet-5-5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
    ...overrides,
  };
}

function completion(content: string): ChatCompletionResponse {
  return {
    model: "claude-sonnet-5-5",
    choices: [{ index: 0, message: { role: "assistant", content } }],
  };
}
