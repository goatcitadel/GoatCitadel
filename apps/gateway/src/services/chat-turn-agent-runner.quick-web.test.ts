import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import { DEEP_RESEARCH_THIN_EVIDENCE_FOOTER } from "./chat-turn-agent-runner/deep-research-evidence.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
  toolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

describe("ChatTurnAgentRunner quick_web profile", () => {
  it("prefetches one bounded search and synthesizes without exposing more tools", async () => {
    const completionRequests: ChatCompletionRequest[] = [];
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      completionRequests.push(request);
      return {
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Eat sushi in one bite when practical, fish-side down, and use soy sparingly. Sources: example.",
            },
          },
        ],
      };
    });
    const invokeTool = vi.fn(async (): Promise<ToolInvokeResult> => {
      return {
        outcome: "executed",
        result: {
          results: [
            {
              title: "Sushi etiquette",
              url: "https://example.test/sushi",
              snippet: "Use soy sparingly and eat nigiri fish-side down.",
            },
            {
              title: "More sushi etiquette",
              url: "https://example.test/more-sushi",
              snippet: "Eat nigiri in one bite when practical.",
            },
          ],
        },
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () =>
        createToolCatalog([
          "browser.search",
          "browser.navigate",
          "http.get",
          "memory.search",
          "fs.list",
          "file.read_range",
          "shell.exec",
          "time.now",
        ]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "session-quick-web",
      turnId: "turn-quick-web",
      userMessageId: "msg-quick-web",
      content: "please look up the best way to eat sushi",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "minimal",
      speedMode: "fast",
      subagentPolicy: "off",
      normalizationProfile: "quick_web",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: "please look up the best way to eat sushi" }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({ query: "the best way to eat sushi", maxResults: 3 }),
      }),
    );
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(completionRequests[0]?.tools).toBeUndefined();
    expect(JSON.stringify(completionRequests[0]?.messages)).toContain("Sushi etiquette");
    expect(result.turnTrace.routing.executionProfile).toBe("quick_web");
    expect(result.turnTrace.routing.promptContextBudget).toEqual(
      expect.objectContaining({
        executionProfile: "quick_web",
        toolSchemaCount: 0,
        toolResultCount: 1,
      }),
    );
    expect(result.turnTrace.toolRuns.map((run) => run.toolName)).toEqual(["browser.search"]);
  });

  it("retains bounded search evidence without repairing a quick synthesis timeout", async () => {
    const createChatCompletion = vi.fn(async (): Promise<ChatCompletionResponse> => {
      throw new Error("provider timeout");
    });
    const invokeTool = vi.fn(async (): Promise<ToolInvokeResult> => {
      return {
        outcome: "executed",
        result: {
          results: [
            {
              title: "Sushi etiquette",
              url: "https://example.test/sushi",
              snippet: "Use soy sparingly and eat nigiri in one bite when practical.",
            },
          ],
        },
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.get", "memory.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "session-quick-web-timeout",
      turnId: "turn-quick-web-timeout",
      userMessageId: "msg-quick-web-timeout",
      content: "please look up the best way to eat sushi",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "minimal",
      speedMode: "fast",
      subagentPolicy: "off",
      normalizationProfile: "quick_web",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: "please look up the best way to eat sushi" }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toContain("strongest relevant points");
    expect(result.assistantContent).toContain("Use soy sparingly");
    expect(result.assistantContent).toContain("https://example.test/sushi");
    expect(result.turnTrace.status).toBe("failed");
    expect(result.turnTrace.failure).toEqual(
      expect.objectContaining({
        failureClass: "provider_timeout",
        recommendedAction: "retry",
      }),
    );
    expect(result.turnTrace.toolRuns.map((run) => run.toolName)).toEqual(["browser.search"]);
  });

  it("does not spend a repair call when quick synthesis returns an incomplete draft", async () => {
    const createChatCompletion = vi.fn(async (): Promise<ChatCompletionResponse> => {
      return {
        model: "glm-5",
        choices: [
          {
            index: 0,
            finish_reason: "length",
            message: {
              role: "assistant",
              content: "The best way to eat sushi is to treat the seasoning lightly and",
            },
          },
        ],
      };
    });
    const invokeTool = vi.fn(async (): Promise<ToolInvokeResult> => {
      return {
        outcome: "executed",
        result: {
          results: [
            {
              title: "Sushi etiquette",
              url: "https://example.test/sushi",
              snippet: "Use soy sparingly and eat nigiri in one bite when practical.",
            },
          ],
        },
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "http.get", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "session-quick-web-incomplete",
      turnId: "turn-quick-web-incomplete",
      userMessageId: "msg-quick-web-incomplete",
      content: "please look up the best way to eat sushi",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "minimal",
      speedMode: "fast",
      subagentPolicy: "off",
      normalizationProfile: "quick_web",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: "please look up the best way to eat sushi" }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toContain("strongest relevant points");
    expect(result.assistantContent).toContain("Use soy sparingly");
    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.completion?.providerCallCount).toBe(1);
    expect(result.turnTrace.failure).toEqual(
      expect.objectContaining({
        recommendedAction: "retry",
      }),
    );
  });

  it("keeps a substantive quick draft instead of replacing it with search boilerplate", async () => {
    const draft =
      "The best way to eat sushi is to keep each bite balanced: use a small amount of soy sauce, eat nigiri in one bite when practical, use ginger between pieces, and avoid overpowering the fish with extra wasabi.";
    const createChatCompletion = vi.fn(async (): Promise<ChatCompletionResponse> => {
      return {
        model: "glm-5",
        choices: [
          {
            index: 0,
            finish_reason: "length",
            message: {
              role: "assistant",
              content: draft,
            },
          },
        ],
      };
    });
    const invokeTool = vi.fn(async (): Promise<ToolInvokeResult> => {
      return {
        outcome: "executed",
        result: {
          results: [
            {
              title: "Sushi etiquette",
              url: "https://example.test/sushi",
              snippet: "Use soy sparingly and eat nigiri in one bite when practical.",
            },
          ],
        },
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "http.get", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "session-quick-web-substantive",
      turnId: "turn-quick-web-substantive",
      userMessageId: "msg-quick-web-substantive",
      content: "please look up the best way to eat sushi",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "minimal",
      speedMode: "fast",
      subagentPolicy: "off",
      normalizationProfile: "quick_web",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: "please look up the best way to eat sushi" }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toBe(draft);
    expect(result.turnTrace.completion?.providerCallCount).toBe(1);
    expect(result.turnTrace.failure).toBeUndefined();
  });

  it("does not prefetch a search whose query carries secret text", async () => {
    const content = "please look up why my deploy fails OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const createChatCompletion = vi.fn(
      async (): Promise<ChatCompletionResponse> => ({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "Check the deploy logs first." } }],
      }),
    );
    const invokeTool = vi.fn(async (): Promise<ToolInvokeResult> => ({ outcome: "executed", result: { results: [] } }));
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "http.get", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "session-quick-web-secret",
      turnId: "turn-quick-web-secret",
      userMessageId: "msg-quick-web-secret",
      content,
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "minimal",
      speedMode: "fast",
      subagentPolicy: "off",
      normalizationProfile: "quick_web",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content }],
    });

    expect(invokeTool).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: "browser.search" }));
    expect(createChatCompletion).toHaveBeenCalled();
  });
});

describe("ChatTurnAgentRunner Deep research evidence note", () => {
  function deepInput(content: string) {
    return {
      sessionId: "session-deep-note",
      turnId: `turn-deep-note-${Math.random().toString(36).slice(2)}`,
      userMessageId: "msg-deep-note",
      content,
      mode: "chat" as const,
      providerId: "glm",
      model: "glm-5",
      webMode: "deep" as const,
      memoryMode: "off" as const,
      thinkingLevel: "standard" as const,
      toolAutonomy: "safe_auto" as const,
      historyMessages: [{ role: "user" as const, content }],
    };
  }

  it("does not add the note to a Deep turn that ends paused for approval", async () => {
    const createChatCompletion = vi.fn(
      async (): Promise<ChatCompletionResponse> => toolCallCompletion("debezium release notes 2026"),
    );
    // The effect-truth seam reports approval before any executor dispatch, as the policy engine does.
    const invokeToolWithEffectTruth = vi.fn(async (): Promise<ToolInvokeResult> => {
      if (invokeToolWithEffectTruth.mock.calls.length === 1) {
        return {
          outcome: "executed",
          policyReason: "allowed",
          result: { results: [{ title: "Debezium", url: "https://debezium.example/docs", snippet: "CDC" }] },
        };
      }
      return {
        outcome: "approval_required",
        policyReason: "search requires approval",
        auditEventId: "audit-deep-note-approval",
        approvalId: "approval-deep-note",
        expiresAt: "2026-10-22T13:30:00.000Z",
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn(async () => {
        throw new Error("legacy invocation seam must not run when effect truth is supported");
      }),
      invokeToolWithEffectTruth: invokeToolWithEffectTruth as never,
    });

    const result = await orchestrator.run(
      deepInput("Compare Debezium vs Postgres logical replication for change data capture."),
    );

    expect(result.turnTrace.toolRuns).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: "browser.search", status: "approval_required" })]),
    );
    expect(result.assistantContent).not.toContain(DEEP_RESEARCH_THIN_EVIDENCE_FOOTER);
  });

  it("does not add the note when the only web tool was http.post", async () => {
    const createChatCompletion = vi.fn(async (): Promise<ChatCompletionResponse> => {
      if (createChatCompletion.mock.calls.length === 1) {
        return namedToolCallCompletion("http.post", { url: "https://hooks.example.test/notify", body: "{}" });
      }
      return {
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "I sent the notification." } }],
      };
    });
    const invokeTool = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed",
        result: { status: 200, body: "ok" },
      }),
    );
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["http.post"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run(deepInput("Send the deploy notification to my webhook."));

    expect(result.turnTrace.toolRuns).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: "http.post", status: "executed" })]),
    );
    expect(result.assistantContent).not.toContain(DEEP_RESEARCH_THIN_EVIDENCE_FOOTER);
  });
});
