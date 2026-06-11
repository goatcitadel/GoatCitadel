import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionResponse,
  ChatToolRunRecord,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator loop39 runtime and delegation repair behavior", () => {
  it("grounds continuation browser search preflight with the prior meaningful search query", () => {
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          historyMessages: Array<{ role: "user"; content: string }>;
          webMode: "auto";
          mode: "chat";
          priorToolRuns: ChatToolRunRecord[];
        }): { toolName: string; args: Record<string, unknown> };
      }
    ).preflightToolInvocation({
      toolName: "browser.search",
      rawArgs: {},
      userContent: "continue",
      historyMessages: [{ role: "user", content: "continue" }],
      webMode: "auto",
      mode: "chat",
      priorToolRuns: [
        {
          toolRunId: "prior-search-run",
          turnId: "turn-loop39-grounded-search",
          sessionId: "sess-loop39-grounded-search",
          toolName: "browser.search",
          status: "executed",
          args: {
            query: "Los Angeles library rainy day events",
          },
          result: {
            results: [
              {
                title: "Library events",
                url: "https://example.test/library-events",
                snippet: "Rainy day library events.",
              },
            ],
          },
          startedAt: "2026-05-15T17:00:00.000Z",
          finishedAt: "2026-05-15T17:00:01.000Z",
        },
      ],
    });

    expect(preflight).toMatchObject({
      toolName: "browser.search",
      args: {
        query: "Los Angeles library rainy day events",
      },
    });
  });

  it("records blocked alternate built-in browser attempts in the fallback chain", async () => {
    const storage = createMockStorage() as {
      chatToolRuns: {
        create(input: ChatToolRunRecord): ChatToolRunRecord;
      };
    };
    const sessionId = "sess-loop39-alt-browser-block";
    const turnId = "turn-loop39-alt-browser-block";
    storage.chatToolRuns.create({
      toolRunId: "prior-search-run",
      turnId,
      sessionId,
      toolName: "browser.search",
      status: "executed",
      args: { query: "runtime fallback article" },
      result: {
        results: [
          {
            title: "Blocked primary",
            url: "https://blocked.example/article",
            snippet: "runtime fallback article blocked primary",
          },
          {
            title: "Alternate mirror",
            url: "https://alternate.example/article",
            snippet: "runtime fallback article alternate mirror",
          },
        ],
      },
      startedAt: "2026-05-15T17:00:00.000Z",
      finishedAt: "2026-05-15T17:00:01.000Z",
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(async (request) => {
      if (request.args.url === "https://alternate.example/article") {
        return {
          outcome: "blocked",
          policyReason: "alternate host blocked by policy",
          auditEventId: "audit-loop39-alt-blocked",
        };
      }
      return {
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-loop39-primary-blocked",
        result: {
          url: request.args.url,
          finalUrl: request.args.url,
          status: 403,
          title: "Attention Required! | Cloudflare",
          textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
        },
      };
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool,
    });

    const executed = await (
      orchestrator as unknown as {
        executeToolCall(input: {
          input: ReturnType<typeof turnInput>;
          turnId: string;
          toolName: string;
          rawArgs: Record<string, unknown>;
        }): Promise<{ record: ChatToolRunRecord }>;
      }
    ).executeToolCall({
      input: turnInput(sessionId, "Open the alternate mirror runtime fallback article.", {
        mode: "chat",
        webMode: "auto",
        historyMessages: [{ role: "user", content: "runtime fallback article alternate mirror" }],
      }),
      turnId,
      toolName: "browser.navigate",
      rawArgs: { url: "https://blocked.example/article" },
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(invokeTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        args: expect.objectContaining({ url: "https://alternate.example/article" }),
      }),
    );
    expect(executed.record.status).toBe("failed");
    expect(executed.record.result?.fallbackChain).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://alternate.example/article",
          status: "failed",
          error: "alternate host blocked by policy",
        }),
      ]),
    );
  });

  it("passes cowork eval-turn model output through verbatim without role-contract rewriting", async () => {
    const result = await runCoworkEvalTurn({
      sessionId: "sess-loop39-book-club",
      task: 'Cowork request: "Coordinate a decision about whether our book club should switch from monthly to biweekly meetings."',
      instruction:
        "Use role-labeled sections in this exact order: `Planner`, `Operator Handoff`, `Members`, `Organizer`, `Risk Review`, `Synthesis`. End with a single recommendation.",
    });

    expect(result.assistantContent).toBe(
      "I can give a brief plan, but the exact roles are not expanded yet.",
    );
  });
});

async function runCoworkEvalTurn(input: {
  sessionId: string;
  task: string;
  instruction: string;
}): Promise<{ assistantContent: string }> {
  const wrappedPrompt = [
    "## Prompt Lab Run Contract",
    "- Mode: cowork",
    "- Tool tier: no-tools",
    "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
    "",
    "## User Task",
    input.task,
    "",
    input.instruction,
  ].join("\n");
  const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
    model: "gpt-5.5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "I can give a brief plan, but the exact roles are not expanded yet.",
        },
      },
    ],
  });
  const orchestrator = new ChatAgentOrchestrator({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog([]),
    createChatCompletion,
    invokeTool: vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(),
  });

  return orchestrator.run({
    sessionId: input.sessionId,
    turnId: randomUUID(),
    userMessageId: `${input.sessionId}-message`,
    content: wrappedPrompt,
    mode: "cowork",
    providerId: "openai-codex",
    model: "gpt-5.5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "extended",
    toolAutonomy: "manual",
    normalizationProfile: "prompt_pack_harness",
    historyMessages: [{ role: "user", content: wrappedPrompt }],
  });
}

function turnInput(
  sessionId: string,
  content: string,
  overrides: Partial<{
    mode: "chat" | "cowork" | "code";
    webMode: "off" | "auto" | "deep";
    memoryMode: "auto" | "on" | "off";
    historyMessages: Array<{ role: "user" | "assistant"; content: string }>;
  }> = {},
) {
  return {
    sessionId,
    turnId: randomUUID(),
    userMessageId: `${sessionId}-message`,
    content,
    mode: overrides.mode ?? "code",
    providerId: "openai",
    model: "gpt-5.4",
    webMode: overrides.webMode ?? "off",
    memoryMode: overrides.memoryMode ?? "off",
    thinkingLevel: "standard" as const,
    toolAutonomy: "safe_auto" as const,
    historyMessages: overrides.historyMessages ?? [{ role: "user" as const, content }],
  };
}
