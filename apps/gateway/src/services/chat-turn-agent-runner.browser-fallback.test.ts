import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatToolRunRecord,
  ChatWebMode,
  McpInvokeRequest,
  McpInvokeResponse,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { CHAT_COMPLETION_TIMEOUT_MS_BY_MODE } from "./chat-agent-budget.js";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import {
  createExecuteToolCallForTest,
  createMockStorage,
  createToolCatalog,
  extractToolCallCompletion,
  httpGetToolCallCompletion,
  namedToolCallCompletion,
  navigateToolCallCompletion,
  toolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

describe("ChatTurnAgentRunner browser fallback behavior", () => {
  it("continues Cowork from checkpoint-window evidence when maxToolLoops is exhausted", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("cowork checkpoint evidence 1"))
      .mockResolvedValueOnce(toolCallCompletion("cowork checkpoint evidence 2"))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Finished from checkpoint evidence.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-cowork-checkpoint-1",
        result: {
          results: [
            {
              title: "Checkpoint evidence 1",
              url: "https://example.com/cowork/checkpoint-1",
              snippet: "First evidence item",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-cowork-checkpoint-2",
        result: {
          results: [
            {
              title: "Checkpoint evidence 2",
              url: "https://example.com/cowork/checkpoint-2",
              snippet: "Second evidence item",
            },
          ],
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-checkpoint",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-checkpoint",
      content: "Cowork: use web lookup to gather evidence, then synthesize a brief operator handoff.",
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "Cowork: use web lookup to gather evidence, then synthesize a brief operator handoff.",
        },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(3);
    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(result.assistantContent).toContain("Finished from checkpoint evidence.");
    expect(result.turnTrace.routing.fallbackReason).toContain("Cowork loop checkpoint 1");
    expect(result.turnTrace.failure).toBeUndefined();
  });

  it("stops Cowork after two checkpoint windows without new progress", async () => {
    const prompt =
      "Cowork: locate boardgame/tabletop game stores within a 10-mile radius of 91303 and find email addresses plus who I should address in them, but stop visibly if the tool loop makes no progress.";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("memory.search", { query: "cowork empty checkpoint 1" }))
      .mockResolvedValueOnce(namedToolCallCompletion("memory.search", { query: "cowork empty checkpoint 2" }))
      .mockResolvedValueOnce(namedToolCallCompletion("memory.search", { query: "cowork empty checkpoint 3" }))
      .mockResolvedValueOnce(namedToolCallCompletion("memory.search", { query: "cowork empty checkpoint 4" }));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-cowork-empty-checkpoint",
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["memory.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-repeated-loop",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-repeated-loop",
      content: prompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(4);
    expect(invokeTool).toHaveBeenCalledTimes(4);
    expect(result.turnTrace.failure).toEqual(
      expect.objectContaining({
        failureClass: "tool_loop_guard",
        message: expect.stringContaining("repeated_tool_loop"),
        recommendedAction: "retry_narrower",
      }),
    );
    expect(result.turnTrace.failure?.message).toContain("candidate_discovery_incomplete");
    expect(result.turnTrace.routing.fallbackReason).toContain("repeated_tool_loop");
  });

  it("treats structured local-business blockers as Cowork checkpoint progress before blocking repeated loops", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("memory.search", { query: "board game stores 91303 email" }))
      .mockResolvedValueOnce(namedToolCallCompletion("memory.search", { query: "tabletop stores 91303 contacts" }))
      .mockResolvedValueOnce(namedToolCallCompletion("memory.search", { query: "board game stores 91303 email" }))
      .mockResolvedValueOnce(namedToolCallCompletion("memory.search", { query: "tabletop stores 91303 contacts" }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "Checkpointed partial handoff: listing sources blocked access, and email/name verification remains open.",
            },
          },
        ],
      });
    const blockedLocalBusinessResult = (attempt: number): ToolInvokeResult => ({
      outcome: "blocked",
      policyReason: `local-business provider unavailable attempt ${attempt}`,
      auditEventId: `audit-local-business-blocked-${attempt}`,
      result: {
        localBusinessResearch: {
          kind: "local_business_contact_research",
          workflow: "local_business.research",
          candidates: [],
          blockers: ["Yelp returned 403"],
          unresolvedNextSteps: ["Use an official source or configured local-business provider."],
        },
      },
    });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce(blockedLocalBusinessResult(1))
      .mockResolvedValueOnce(blockedLocalBusinessResult(2))
      .mockResolvedValueOnce(blockedLocalBusinessResult(3))
      .mockResolvedValueOnce(blockedLocalBusinessResult(4));
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["memory.search"]),
      createChatCompletion,
      invokeTool,
    });

    const prompt =
      "Cowork: locate boardgame/tabletop game stores within a 10-mile radius of 91303 and find email addresses plus who I should address in them.";
    const result = await orchestrator.run({
      sessionId: "sess-cowork-local-business-blockers",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-local-business-blockers",
      content: prompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(5);
    expect(invokeTool).toHaveBeenCalledTimes(4);
    expect(result.assistantContent).toContain("Checkpointed partial handoff");
    expect(result.turnTrace.failure).toBeUndefined();
    expect(result.turnTrace.routing.fallbackReason).toContain("Cowork loop checkpoint 2");
    expect(result.turnTrace.routing.fallbackReason).not.toContain("repeated_tool_loop");
  });

  it("retains local-business research evidence when final citations come from navigation instead of search annotation", async () => {
    const prompt =
      "Can you locate all the boardgame/tabletop game stores within a 10-mile radius of 91303 and find the email addresses and who I should address in them?";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://cashcardsunlimited.example/contact",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "Partial verified handoff:\n- Cash Cards Unlimited - info@cashcardsunlimited.com; no named contact verified.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-cash-cards-contact",
      result: {
        finalUrl: "https://cashcardsunlimited.example/contact",
        title: "Cash Cards Unlimited - Contact",
        textSnippet:
          "Cash Cards Unlimited is a card and tabletop game store near Canoga Park, CA 91303. Contact: info@cashcardsunlimited.com.",
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate", "local_business.research"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-local-business-final-evidence",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-local-business-final-evidence",
      content: prompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: prompt }],
    });

    const retainedResearchRun = result.turnTrace.toolRuns.find(
      (toolRun) => toolRun.toolName === "local_business.research",
    );
    expect(retainedResearchRun).toMatchObject({
      status: "executed",
      result: expect.objectContaining({
        kind: "local_business_contact_research",
        workflow: "local_business.research",
        candidates: expect.arrayContaining([
          expect.objectContaining({
            storeName: "Cash Cards Unlimited",
            email: "info@cashcardsunlimited.com",
            verificationStatus: "partial",
          }),
        ]),
      }),
    });
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(result.turnTrace.toolRuns.filter((toolRun) => toolRun.toolName === "browser.search")).toHaveLength(0);
  });

  it("merges final cited local-business evidence even after earlier search progress exists", async () => {
    const prompt =
      "Can you locate all the boardgame/tabletop game stores within a 10-mile radius of 91303 and find the email addresses and who I should address in them?";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", { query: "board game store 91303 contact email" }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "Partial verified handoff:\n- Cash Cards Unlimited - info@cashcardsunlimited.com; no named contact verified.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-cash-cards-search",
      result: {
        results: [
          {
            title: "Cash Cards Unlimited - Contact",
            url: "https://cashcardsunlimited.example/contact",
            snippet:
              "Cash Cards Unlimited is a card and tabletop game store near Canoga Park, CA 91303. Contact: info@cashcardsunlimited.com.",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "local_business.research"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-local-business-search-final-evidence",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-local-business-search-final-evidence",
      content: prompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(result.turnTrace.toolRuns.filter((toolRun) => toolRun.toolName === "browser.search")).toHaveLength(1);
    const retainedResearchRun = result.turnTrace.toolRuns.find(
      (toolRun) => toolRun.toolName === "local_business.research",
    );
    expect(retainedResearchRun).toMatchObject({
      status: "executed",
      result: expect.objectContaining({
        kind: "local_business_contact_research",
        workflow: "local_business.research",
        candidates: expect.arrayContaining([
          expect.objectContaining({
            storeName: "Cash Cards Unlimited",
            email: "info@cashcardsunlimited.com",
          }),
        ]),
      }),
    });
  });

  it("grounds browser.navigate from the most recent browser.search results", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({}))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Grounded answer",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-search",
        result: {
          results: [{ title: "News", url: "https://example.com/news/kristi-noem", snippet: "snippet" }],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav",
        result: {
          finalUrl: "https://example.com/news/kristi-noem",
          title: "News",
          textSnippet: "Latest coverage",
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-4",
      turnId: randomUUID(),
      userMessageId: "msg-user-4",
      content: "What's the latest news on Kristi Noem?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What's the latest news on Kristi Noem?" }],
    });

    expect(invokeTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toolName: "browser.navigate",
        args: expect.objectContaining({
          url: "https://example.com/news/kristi-noem",
        }),
      }),
    );
    expect(invokeTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        toolName: "browser.search",
      }),
    );
    expect(result.assistantContent).toContain("Grounded answer");
  });

  it("normalizes generic live-news prompts into a cleaner search query", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I found some headlines.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-search-cleanup",
      result: {
        results: [{ title: "Headline", url: "https://example.com/news/today", snippet: "top stories" }],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-live-cleanup-1",
      turnId: randomUUID(),
      userMessageId: "msg-live-cleanup-1",
      content: "Look online and tell me the 5 most interesting things that happened today.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Look online and tell me the 5 most interesting things that happened today." },
      ],
    });

    expect(invokeTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({
          query: "top news headlines today",
        }),
      }),
    );
  });

  it("grounds local-business contact research from the original objective instead of delegation wrapper text", async () => {
    const originalPrompt =
      "Can you locate all the boardgame/tabletop game stores within a 10-mile radius of 91303 and find the email addresses and who I should address in them?";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: 'Delegated role: Researcher Parent objective: Execute the main workstream "Yelp boardgame stores"',
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I found partial, source-backed local business leads.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-local-business-search",
      result: {
        results: [
          {
            title: "Game N Grounds - Contact Us",
            url: "https://gamengrounds.example/contact",
            snippet: "Game N Grounds serves Canoga Park, CA 91303.",
          },
        ],
      },
    });
    const storage = createMockStorage() as {
      chatToolRuns: { listByTurn: (turnId: string) => ChatToolRunRecord[] };
    };
    const orchestrator = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });
    const turnId = randomUUID();

    await orchestrator.run({
      sessionId: "sess-local-business-91303",
      turnId,
      userMessageId: "msg-local-business-91303",
      content: originalPrompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "deep",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: originalPrompt }],
    });

    const firstInvokeCall = (
      invokeTool.mock.calls as unknown as Array<
        [
          {
            toolName: string;
            args: Record<string, unknown>;
          },
        ]
      >
    )[0]?.[0];
    const query = String(firstInvokeCall?.args.query ?? "");
    expect(firstInvokeCall?.toolName).toBe("browser.search");
    expect(query).toBe("Canoga Park 91303 TCG contact game store official email 10 mile radius");
    expect(query).not.toMatch(/Delegated role|Execute the main workstream|Yelp|"/i);
    expect(storage.chatToolRuns.listByTurn(turnId)[0]?.result).toMatchObject({
      localBusinessResearch: {
        kind: "local_business_contact_research",
        candidates: [
          expect.objectContaining({
            storeName: "Game N Grounds",
            verificationStatus: "partial",
            blockers: ["email_not_verified_from_search_result", "contact_name_not_verified_from_search_result"],
          }),
        ],
      },
    });
  });

  it("recovers missing http.get url from the most recent visited page", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({}))
      .mockResolvedValueOnce(navigateToolCallCompletion({}))
      .mockResolvedValueOnce(httpGetToolCallCompletion({}))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Kristi Noem is in the news again.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-search-http",
        result: {
          results: [
            {
              title: "Kristi Noem latest news",
              url: "https://example.com/news/kristi-noem",
              snippet: "latest coverage",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-http-1",
        result: {
          finalUrl: "https://example.com/news/kristi-noem",
          title: "Kristi Noem latest news",
          textSnippet: "first article page",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-http-2",
        result: {
          finalUrl: "https://example.com/news/kristi-noem/analysis",
          title: "Kristi Noem analysis",
          textSnippet: "second article page",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-http-get",
        result: {
          url: "https://example.com/news/kristi-noem/analysis",
          status: 200,
          bodySnippet: "analysis body",
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.get"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-http-get-1",
      turnId: randomUUID(),
      userMessageId: "msg-http-get-1",
      content: "what's the latest news on Kristi Noem?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "what's the latest news on Kristi Noem?" }],
    });

    const invokeToolCalls = invokeTool.mock.calls as unknown as Array<
      [
        {
          toolName: string;
          args: Record<string, unknown>;
        },
      ]
    >;
    const lastInvokeToolCall = invokeToolCalls.at(-1)?.[0];
    expect(lastInvokeToolCall).toMatchObject({
      toolName: "http.get",
      args: expect.objectContaining({
        url: "https://example.com/news/kristi-noem/analysis",
      }),
    });
    expect(result.assistantContent).toContain("Kristi Noem is in the news again.");
    expect(result.assistantContent).not.toContain("execution error: url is required");
  });

  it("uses the most recent visited page before falling back to prior search results for http.get", async () => {
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.get"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
          failureReason?: string;
        };
      }
    ).preflightToolInvocation({
      toolName: "http.get",
      rawArgs: {},
      userContent: "what's the latest news on Kristi Noem?",
      priorToolRuns: [
        {
          toolRunId: "tool-search-http-1",
          turnId: "turn-http-1",
          sessionId: "sess-http-2",
          toolName: "browser.search",
          status: "executed",
          args: { query: "latest news on Kristi Noem" },
          result: {
            results: [
              { title: "Kristi Noem latest news", url: "https://example.com/news/kristi-noem", snippet: "snippet" },
            ],
          },
          startedAt: "2026-03-06T23:10:00.000Z",
          finishedAt: "2026-03-06T23:10:01.000Z",
        },
        {
          toolRunId: "tool-nav-http-1",
          turnId: "turn-http-1",
          sessionId: "sess-http-2",
          toolName: "browser.navigate",
          status: "executed",
          args: { url: "https://example.com/news/kristi-noem" },
          result: {
            finalUrl: "https://example.com/news/kristi-noem/live-blog",
            title: "Kristi Noem live blog",
            textSnippet: "live updates",
          },
          startedAt: "2026-03-06T23:10:02.000Z",
          finishedAt: "2026-03-06T23:10:03.000Z",
        },
      ],
    });

    expect(preflight.failureReason).toBeUndefined();
    expect(preflight.args).toMatchObject({
      url: "https://example.com/news/kristi-noem/live-blog",
    });
  });

  it("ignores search-portal navigations when grounding a follow-up http.get", async () => {
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.get"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
          failureReason?: string;
        };
      }
    ).preflightToolInvocation({
      toolName: "http.get",
      rawArgs: {},
      userContent: "what's the latest news on Kristi Noem?",
      priorToolRuns: [
        {
          toolRunId: "tool-search-http-portal",
          turnId: "turn-http-portal",
          sessionId: "sess-http-portal",
          toolName: "browser.search",
          status: "executed",
          args: { query: "latest news on Kristi Noem" },
          result: {
            results: [
              { title: "Kristi Noem latest news", url: "https://example.com/news/kristi-noem", snippet: "snippet" },
            ],
          },
          startedAt: "2026-03-06T23:10:00.000Z",
          finishedAt: "2026-03-06T23:10:01.000Z",
        },
        {
          toolRunId: "tool-nav-http-portal",
          turnId: "turn-http-portal",
          sessionId: "sess-http-portal",
          toolName: "browser.navigate",
          status: "executed",
          args: { url: "https://lite.duckduckgo.com/lite/?q=latest+news+on+kristi+noem" },
          result: {
            finalUrl: "https://lite.duckduckgo.com/lite/?q=latest+news+on+kristi+noem",
            title: "DuckDuckGo",
            textSnippet: "Please complete the challenge to confirm this search was made by a human.",
          },
          startedAt: "2026-03-06T23:10:02.000Z",
          finishedAt: "2026-03-06T23:10:03.000Z",
        },
      ],
    });

    expect(preflight.failureReason).toBeUndefined();
    expect(preflight.args).toMatchObject({
      url: "https://example.com/news/kristi-noem",
    });
  });

  it("does not infer recent-run urls for http.post", async () => {
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.post"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
          failureReason?: string;
        };
      }
    ).preflightToolInvocation({
      toolName: "http.post",
      rawArgs: {},
      userContent: "what's the latest news on Kristi Noem?",
      priorToolRuns: [
        {
          toolRunId: "tool-search-post-1",
          turnId: "turn-post-1",
          sessionId: "sess-post-1",
          toolName: "browser.search",
          status: "executed",
          args: { query: "latest news on Kristi Noem" },
          result: {
            results: [
              { title: "Kristi Noem latest news", url: "https://example.com/news/kristi-noem", snippet: "snippet" },
            ],
          },
          startedAt: "2026-03-06T23:11:00.000Z",
          finishedAt: "2026-03-06T23:11:01.000Z",
        },
        {
          toolRunId: "tool-nav-post-1",
          turnId: "turn-post-1",
          sessionId: "sess-post-1",
          toolName: "browser.navigate",
          status: "executed",
          args: { url: "https://example.com/news/kristi-noem" },
          result: {
            finalUrl: "https://example.com/news/kristi-noem/live-blog",
          },
          startedAt: "2026-03-06T23:11:02.000Z",
          finishedAt: "2026-03-06T23:11:03.000Z",
        },
      ],
    });

    expect(preflight.failureReason).toBe("execution error: url is required");
  });

  it("keeps http.get unresolved when no prompt or recent-run url is available", async () => {
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["http.get"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
          failureReason?: string;
        };
      }
    ).preflightToolInvocation({
      toolName: "http.get",
      rawArgs: {},
      userContent: "tell me what's going on with Kristi Noem",
      priorToolRuns: [],
    });

    expect(preflight.failureReason).toBe("execution error: url is required");
  });

  it("promotes repeated live-data browser.search calls into browser.navigate during preflight", async () => {
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
        };
      }
    ).preflightToolInvocation({
      toolName: "browser.search",
      rawArgs: {
        query: "latest news on Kristi Noem",
      },
      userContent: "what's going on with kristi noem lately?",
      priorToolRuns: [
        {
          toolRunId: "tool-search-1",
          turnId: "turn-1",
          sessionId: "sess-6",
          toolName: "browser.search",
          status: "executed",
          args: { query: "latest news on Kristi Noem" },
          result: {
            results: [
              {
                title: "Generic search results",
                url: "https://www.google.com/search?q=kristi+noem",
                snippet: "portal",
              },
              { title: "Kristi Noem latest news", url: "https://example.com/news/kristi-noem-1", snippet: "snippet 1" },
            ],
          },
          startedAt: "2026-03-06T22:30:00.000Z",
          finishedAt: "2026-03-06T22:30:01.000Z",
        },
      ],
    });

    expect(preflight.toolName).toBe("browser.navigate");
    expect(preflight.args).toMatchObject({
      url: "https://example.com/news/kristi-noem-1",
      maxChars: 6000,
    });
  });

  it("rewrites search-portal browser.navigate urls to the strongest grounded result url", async () => {
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
        };
      }
    ).preflightToolInvocation({
      toolName: "browser.navigate",
      rawArgs: {
        url: "https://lite.duckduckgo.com/lite/?q=top+news+headlines+today",
      },
      userContent: "Look online and tell me the 5 most interesting things that happened today.",
      priorToolRuns: [
        {
          toolRunId: "tool-search-nav-redirect",
          turnId: "turn-nav-redirect",
          sessionId: "sess-nav-redirect",
          toolName: "browser.search",
          status: "executed",
          args: { query: "top news headlines today" },
          result: {
            results: [
              {
                title: "Google News - Headlines",
                url: "https://news.google.com/topics/CAAqKggKIiRDQkFTRlFvSUwyMHZNRFZxYUdjU0JXVnVMVWRDR2dKVFJ5Z0FQAQ",
                snippet: "Headlines topic",
              },
              { title: "Reuters Top News", url: "https://www.reuters.com/world/", snippet: "Top stories from Reuters" },
            ],
          },
          startedAt: "2026-03-06T22:30:00.000Z",
          finishedAt: "2026-03-06T22:30:01.000Z",
        },
      ],
    });

    expect(preflight.toolName).toBe("browser.navigate");
    expect(preflight.args.url).toBe("https://www.reuters.com/world/");
  });

  it("normalizes explicit web lookup prompts before the synthetic browser.search runs", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "REST APIs are widely used for app backends, integrations, microservices, IoT, and public data APIs.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-query-normalization-search",
        result: {
          query: "the top 5 uses for REST APIs",
          results: [
            {
              title: "What is a REST API? Benefits, Uses, Examples - TechTarget",
              url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
              snippet: "REST APIs are a vital mechanism for software interoperability.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-query-normalization-navigate",
        result: {
          url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          finalUrl: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          status: 200,
          title: "What is a REST API? Benefits, Uses, Examples - TechTarget",
          textSnippet: "REST APIs are widely used for software interoperability and web services.",
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-query-normalization-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-query-normalization-1",
      content: "Can you look online and find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
    });

    const firstInvokeCall = (
      invokeTool.mock.calls as unknown as Array<
        [
          {
            toolName: string;
            args: Record<string, unknown>;
          },
        ]
      >
    )[0]?.[0];
    expect(firstInvokeCall).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({
        query: "the top 5 uses for REST APIs",
      }),
    });
    expect(result.assistantContent).toContain("REST APIs are widely used");
  });

  it("keeps entity-rich benchmark queries instead of drifting into citation instructions", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I found benchmark coverage for the three runtimes.",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The file exports `main` and `helper`.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-runtime-benchmarks-1",
      result: {
        results: [
          {
            title: "Node.js vs Bun vs Deno benchmarks",
            url: "https://example.com/benchmarks/node-bun-deno",
            snippet: "Recent runtime benchmark comparison.",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-runtime-benchmarks-1",
      turnId: randomUUID(),
      userMessageId: "msg-runtime-benchmarks-1",
      content:
        "Compare Node.js, Bun, and Deno runtime benchmarks. If you can find recent benchmarks or comparisons, cite them.",
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Compare Node.js, Bun, and Deno runtime benchmarks. If you can find recent benchmarks or comparisons, cite them.",
        },
      ],
    });

    const firstInvokeCall = (
      invokeTool.mock.calls as unknown as Array<
        [
          {
            toolName: string;
            args: Record<string, unknown>;
          },
        ]
      >
    )[0]?.[0];
    const query = String(firstInvokeCall?.args.query ?? "");
    expect(firstInvokeCall?.toolName).toBe("browser.search");
    expect(query).toMatch(/\bnode(?:\.js)?\b/i);
    expect(query).toMatch(/\bbun\b/i);
    expect(query).toMatch(/\bdeno\b/i);
    expect(query).not.toMatch(/\bcite\b/i);
    expect(query).not.toMatch(/\bsources?\b/i);
  });

  it("ignores Prompt Lab tooling contract text when grounding browser.search queries", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Tooling Contract",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: web lookup tools",
      "- Do not substitute memory tools unless the prompt explicitly asks for memory.",
      "",
      "## User Task",
      "Use browser.search to find the current Node.js LTS version.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query:
            "navigate - Required tool families: web lookup tools - Do not substitute memory tools unless the prompt explicitly asks for memory.",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Node.js 22 is the current LTS line.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-node-lts-grounded-1",
      result: {
        query: "current Node.js LTS version",
        results: [
          {
            title: "Node.js Releases",
            url: "https://nodejs.org/en/about/previous-releases",
            snippet: "Node.js release schedule and LTS lines.",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-browser-search-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-browser-search-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    const firstInvokeCall = (
      invokeTool.mock.calls as unknown as Array<
        [
          {
            toolName: string;
            args: Record<string, unknown>;
          },
        ]
      >
    )[0]?.[0];
    expect(firstInvokeCall).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({
        query: expect.stringMatching(/node\.js lts/i),
      }),
    });
    expect(String(firstInvokeCall?.args.query)).not.toMatch(/required tool families|memory tools/i);
    expect(result.assistantContent).toContain("Node.js 22");
  });

  it("does not force implicit recency searches on Prompt Lab eval turns", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: implicit-tools",
      "- Finish with a complete answer in one turn.",
      "",
      "## User Task",
      'The user asks: "What\'s the current public status of a major airport closure I heard about today?"',
      "",
      "Answer in Chat mode. If live lookup is available, check before answering and cite the source.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I checked for current airport closure signals but need the airport name to verify a specific case.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-airport-status-1",
      result: {
        query: "current public status major airport closure today",
        results: [
          {
            title: "National Airspace System - Federal Aviation Administration",
            url: "https://nasstatus.faa.gov/list",
            snippet: "FAA National Airspace System status.",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-airport-status-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-airport-status-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns ?? []).toHaveLength(0);
    expect(result.assistantContent).toContain(
      "I checked for current airport closure signals but need the airport name to verify a specific case.",
    );
  });

  it("redirects community browser.navigate urls to a better recent source when the prompt did not ask for community results", async () => {
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          historyMessages: ChatCompletionRequest["messages"];
          webMode: ChatWebMode;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
        };
      }
    ).preflightToolInvocation({
      toolName: "browser.navigate",
      rawArgs: {
        url: "https://www.reddit.com/r/learnprogramming/comments/17kkjas/what_actually_is_a_rest_api_can_someone_provide/",
      },
      userContent: "Can you look online and find out the top 5 uses for REST APIs?",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
      webMode: "auto",
      priorToolRuns: [
        {
          toolRunId: "tool-search-community-redirect",
          turnId: "turn-community-redirect",
          sessionId: "sess-community-redirect",
          toolName: "browser.search",
          status: "executed",
          args: { query: "the top 5 uses for REST APIs" },
          result: {
            results: [
              {
                title: "What Is a REST API? Examples, Uses & Challenges - Postman Blog",
                url: "https://blog.postman.com/rest-api-examples/",
                snippet: "REST API examples and use cases.",
              },
              {
                title: "what actually is a REST api? Can someone provide an example it ... - Reddit",
                url: "https://www.reddit.com/r/learnprogramming/comments/17kkjas/what_actually_is_a_rest_api_can_someone_provide/",
                snippet: "Community discussion.",
              },
              {
                title: "What is a REST API? Benefits, Uses, Examples - TechTarget",
                url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
                snippet: "REST APIs are used for software interoperability.",
              },
            ],
          },
          startedAt: "2026-03-12T22:30:00.000Z",
          finishedAt: "2026-03-12T22:30:01.000Z",
        },
      ],
    });

    expect(preflight.toolName).toBe("browser.navigate");
    expect(preflight.args.url).not.toBe(
      "https://www.reddit.com/r/learnprogramming/comments/17kkjas/what_actually_is_a_rest_api_can_someone_provide/",
    );
    expect([
      "https://blog.postman.com/rest-api-examples/",
      "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
    ]).toContain(preflight.args.url);
  });

  it("does not inject browser.search for generic duration prompts containing time", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Cold brew usually takes 12 to 24 hours.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-time-1",
      turnId: randomUUID(),
      userMessageId: "msg-time-1",
      content: "how much time does it take to learn Go?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "how much time does it take to learn Go?" }],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.routing?.liveDataIntent).toBe(false);
    expect(result.assistantContent).toContain("12 to 24 hours");
  });

  it("treats explicit clock-time questions as time intent without using browser.search", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "It is currently 9:00 AM in Tokyo.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-time",
      result: {
        iso: "2026-03-06T17:00:00.000Z",
        timezone: "Asia/Tokyo",
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-time-2",
      turnId: randomUUID(),
      userMessageId: "msg-time-2",
      content: "what time is it in Tokyo right now?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "what time is it in Tokyo right now?" }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "time.now",
      }),
    );
  });

  it("does not promote repeated search when recent results have no sufficiently relevant URL", async () => {
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
        };
      }
    ).preflightToolInvocation({
      toolName: "browser.search",
      rawArgs: {
        query: "latest weather in Paris",
      },
      userContent: "what's the latest weather in Paris?",
      priorToolRuns: [
        {
          toolRunId: "tool-search-2",
          turnId: "turn-2",
          sessionId: "sess-7",
          toolName: "browser.search",
          status: "executed",
          args: { query: "latest weather in Paris" },
          result: {
            results: [{ title: "Search results", url: "https://www.google.com/search?q=weather+paris" }],
          },
          startedAt: "2026-03-06T22:31:00.000Z",
          finishedAt: "2026-03-06T22:31:01.000Z",
        },
      ],
    });

    expect(preflight.toolName).toBe("browser.search");
    expect(preflight.args).toMatchObject({
      query: "latest weather in Paris",
    });
  });

  it("stops immediately on non-recoverable missing-argument failures", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValue(navigateToolCallCompletion({}));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-5",
      turnId: randomUUID(),
      userMessageId: "msg-user-5",
      content: "What's the latest news on Kristi Noem?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What's the latest news on Kristi Noem?" }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("can't be retried safely");
    expect(result.assistantContent).toContain("sticking point was navigate");
    expect(result.assistantContent).not.toContain("execution error: url is required");
  });

  it("injects evidence grounding instruction when live-data intent triggers a proactive search", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Here are headlines based on search results.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-grounding",
      result: {
        results: [{ title: "Top story", url: "https://example.com/top-story", snippet: "Important news" }],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-grounding-1",
      turnId: randomUUID(),
      userMessageId: "msg-grounding-1",
      content: "What are the latest news headlines today?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What are the latest news headlines today?" }],
    });

    expect(createChatCompletion).toHaveBeenCalled();
    const completionCall = (createChatCompletion as any).mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const messages = completionCall?.messages as Array<{ role: string; content?: unknown }> | undefined;
    const systemMessages = messages?.filter((msg) => msg.role === "system") ?? [];
    const groundingMsg = systemMessages.find(
      (msg) => typeof msg.content === "string" && msg.content.includes("Evidence grounding"),
    );
    expect(groundingMsg).toBeDefined();
    expect(groundingMsg?.content as string).toContain("strictly on the tool results");
  });

  it("proactively opens the strongest live-data search result before synthesis when navigate is available", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "A humor roundup says a goat briefly disrupted a small-town parade yesterday.",
          },
        },
      ],
    });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-proactive-search",
        result: {
          results: [
            {
              title: "Funny news yesterday: goat disrupts small-town parade",
              url: "https://example.com/news/odd-roundup",
              snippet: "A funny news roundup from yesterday says a goat briefly disrupted a small-town parade.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-proactive-navigate",
        result: {
          url: "https://example.com/news/odd-roundup",
          finalUrl: "https://example.com/news/odd-roundup",
          title: "Odd News Roundup",
          content: "A goat briefly disrupted a small-town parade yesterday, drawing laughs from spectators.",
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-proactive-live-followthrough-1",
      turnId: randomUUID(),
      userMessageId: "msg-proactive-live-followthrough-1",
      content: "tell me something funny that happened in the news yesterday",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "tell me something funny that happened in the news yesterday" }],
    });

    const invokedToolNames = (invokeTool.mock.calls as unknown as Array<[{ toolName: string }]>).map(
      (call) => call[0].toolName,
    );
    expect(invokedToolNames).toEqual(["browser.search", "browser.navigate"]);
  });

  it("detects explicit web lookup phrases like 'search online' as live-data intent", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Search results found.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-search-online",
      result: {
        results: [{ title: "Result", url: "https://example.com", snippet: "snippet" }],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-search-online-1",
      turnId: randomUUID(),
      userMessageId: "msg-search-online-1",
      content: "Search online for the best project management tools",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search online for the best project management tools" }],
    });

    expect(result.turnTrace.routing?.liveDataIntent).toBe(true);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
      }),
    );
  });

  it("does not trigger proactive web search for generic current-state prompts", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Here is a local summary.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-current-architecture-1",
      turnId: randomUUID(),
      userMessageId: "msg-current-architecture-1",
      content: "Summarize the current architecture of the app.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Summarize the current architecture of the app." }],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.routing?.liveDataIntent).toBe(false);
  });

  it("does not expose web tools for stable conceptual chat prompts in auto mode", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        const toolNames = (request.tools ?? [])
          .map((tool) => (tool.function as { name?: string } | undefined)?.name)
          .filter((name): name is string => Boolean(name));
        expect(toolNames).not.toContain("browser_search");
        expect(toolNames).not.toContain("browser_navigate");
        expect(toolNames).not.toContain("http_get");
        expect(toolNames).toContain("time_now");
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  "REST APIs are commonly used for client-server CRUD backends, third-party integrations, mobile app data sync, workflow automation, and public partner APIs.",
              },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.get", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-api-stable-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-api-stable-1",
      content: "Can you find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you find out the top 5 uses for REST APIs?" }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("client-server CRUD backends");
  });

  it("keeps web tools exposed for direct-url chat prompts in auto mode", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        const toolNames = (request.tools ?? [])
          .map((tool) => (tool.function as { name?: string } | undefined)?.name)
          .filter((name): name is string => Boolean(name));
        expect(toolNames).toContain("browser_search");
        expect(toolNames).toContain("browser_navigate");
        expect(toolNames).toContain("http_get");
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "I can inspect that page.",
              },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.get", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-direct-url-chat-1",
      turnId: randomUUID(),
      userMessageId: "msg-direct-url-chat-1",
      content: "Summarize https://www.rfc-editor.org/rfc/rfc9110 from the page itself.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Summarize https://www.rfc-editor.org/rfc/rfc9110 from the page itself." },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("inspect that page");
  });

  it("executes explicit browser.search requests in chat mode and allows fallback retries", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        const toolNames = (request.tools ?? [])
          .map((tool) => (tool.function as { name?: string } | undefined)?.name)
          .filter((name): name is string => Boolean(name));
        expect(toolNames).toContain("browser_search");
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "I can use browser.search for that.",
              },
            },
          ],
        };
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-explicit-browser-search-1",
        result: {
          results: [],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-explicit-browser-search-2",
        result: {
          results: [
            {
              title: "Node.js releases",
              url: "https://nodejs.org/en/about/previous-releases",
              snippet: "The current LTS line is available on the Node.js release schedule.",
            },
          ],
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "http.get", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-explicit-browser-search-1",
      turnId: randomUUID(),
      userMessageId: "msg-explicit-browser-search-1",
      content: "Use browser.search to find the current Node.js LTS version.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Use browser.search to find the current Node.js LTS version." }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledTimes(2);
    const explicitSearchCalls = invokeTool.mock.calls as unknown as Array<
      [{ toolName: string; args: Record<string, unknown> }]
    >;
    const initialSearchCall = explicitSearchCalls[0]![0]!;
    const fallbackSearchCall = explicitSearchCalls[1]![0]!;
    expect(initialSearchCall).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({
        query: expect.stringMatching(/lts version/i),
      }),
    });
    expect(fallbackSearchCall).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({
        engine: "bing",
      }),
    });
    expect(fallbackSearchCall.args.query).toBe(initialSearchCall.args.query);
  });

  it("exposes memory write and lookup tools for explicit save-and-confirm chat prompts", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        const toolNames = (request.tools ?? [])
          .map((tool) => (tool.function as { name?: string } | undefined)?.name)
          .filter((name): name is string => Boolean(name));
        expect(toolNames).toContain("memory_write");
        expect(toolNames).toContain("memory_search");
        expect(toolNames).toContain("memory_read");
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "I can save that and verify it.",
              },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["memory.write", "memory.search", "memory.read", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-memory-save-confirm-1",
      turnId: randomUUID(),
      userMessageId: "msg-memory-save-confirm-1",
      content:
        "Remember this as a memory note: I prefer concise status updates. Then search memory to confirm it was saved.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "on",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Remember this as a memory note: I prefer concise status updates. Then search memory to confirm it was saved.",
        },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("prefers file and code tools over memory lookup for code file-analysis prompts", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementation(async (request) => {
        const toolNames = (request.tools ?? [])
          .map((tool) => (tool.function as { name?: string } | undefined)?.name)
          .filter((name): name is string => Boolean(name));
        expect(toolNames).toContain("file_read_range");
        expect(toolNames).toContain("code_search");
        expect(toolNames).toContain("code_search_files");
        expect(toolNames).not.toContain("memory_search");
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "I can inspect the local files directly.",
              },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () =>
        createToolCatalog([
          "memory.search",
          "file.read_range",
          "file.find",
          "code.search",
          "code.search_files",
          "time.now",
        ]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-code-file-tools-1",
      turnId: randomUUID(),
      userMessageId: "msg-code-file-tools-1",
      content: "Read fixtures/prompt-pack-workspace/package.json using file tools and analyze the scripts section.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "auto",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "Read fixtures/prompt-pack-workspace/package.json using file tools and analyze the scripts section.",
        },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalled();
    const invokedToolNames = (invokeTool.mock.calls as unknown as Array<[{ toolName: string }]>)
      .map((call) => call[0]?.toolName)
      .filter((toolName): toolName is string => Boolean(toolName));
    expect(invokedToolNames).not.toContain("memory.search");
  });

  it("infers a missing file.find path from explicit local file prompts", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("file.find", { pattern: "tasks" }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The file defines a task map and CRUD routes.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-file-find-inferred-path-1",
      result: {
        path: "src/index.ts",
        pattern: "tasks",
        count: 1,
        matches: [{ path: "src/index.ts", line: 15, lineText: "const tasks: Map<string, Task> = new Map();" }],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.find"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-file-find-inferred-path-1",
      turnId: randomUUID(),
      userMessageId: "msg-file-find-inferred-path-1",
      content: "Look at src/index.ts and identify code quality improvements around task handling.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "Look at src/index.ts and identify code quality improvements around task handling.",
        },
      ],
    });

    const firstInvokeCall = (
      invokeTool.mock.calls as unknown as Array<
        [
          {
            toolName: string;
            args: Record<string, unknown>;
          },
        ]
      >
    )[0]?.[0];
    expect(firstInvokeCall).toMatchObject({
      toolName: "file.find",
      args: expect.objectContaining({
        path: "src/index.ts",
        pattern: "tasks",
      }),
    });
  });

  it("infers missing code.search_files args for full-project file audits", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("code.search_files", {}))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The fixture project contains package.json, tsconfig.json, and two source files.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-code-search-files-inferred-1",
      result: {
        path: "fixtures/prompt-pack-workspace/",
        query: ".",
        count: 4,
        matches: [{ path: "fixtures/prompt-pack-workspace/package.json", name: "package.json", type: "file" }],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-code-search-files-inferred-1",
      turnId: randomUUID(),
      userMessageId: "msg-code-search-files-inferred-1",
      content:
        "Read all source files in fixtures/prompt-pack-workspace/ using file tools. Produce a project audit report covering structure, code quality, and test coverage gaps.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Read all source files in fixtures/prompt-pack-workspace/ using file tools. Produce a project audit report covering structure, code quality, and test coverage gaps.",
        },
      ],
    });

    const firstInvokeCall = (
      invokeTool.mock.calls as unknown as Array<
        [
          {
            toolName: string;
            args: Record<string, unknown>;
          },
        ]
      >
    )[0]?.[0];
    expect(firstInvokeCall).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({
        path: "fixtures/prompt-pack-workspace/",
      }),
    });
    expect([".", "read", "report"]).toContain(String(firstInvokeCall?.args?.query ?? ""));
  });

  it("does not invent local file paths from bare technology names", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("file.read_range", {
          startLine: 1,
          endLine: 20,
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I need an actual project file path before I can inspect local code.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-no-bogus-tech-path-1",
      turnId: randomUUID(),
      userMessageId: "msg-no-bogus-tech-path-1",
      content: "Explain whether this project should upgrade Node.js and TypeScript next quarter.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "Explain whether this project should upgrade Node.js and TypeScript next quarter.",
        },
      ],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("treats release-window prompts like this week as live-data intent", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Here are the strongest current leads.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-movies-week-1",
      result: {
        results: [
          {
            title: "IMDb upcoming releases",
            url: "https://www.imdb.com/calendar/",
            snippet: "Upcoming movie releases this week.",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-movies-week-1",
      turnId: randomUUID(),
      userMessageId: "msg-movies-week-1",
      content: "What movies are coming out this week?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What movies are coming out this week?" }],
    });

    expect(result.turnTrace.routing?.liveDataIntent).toBe(true);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({
          query: "What movies are coming out this week",
        }),
      }),
    );
  });

  it("retries remote-blocked browser navigation through MCP fallback tiers", async () => {
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-remote-blocked-1",
      result: {
        url: "https://movieinsider.com/movies",
        finalUrl: "https://movieinsider.com/movies",
        status: 403,
        title: "Attention Required! | Cloudflare",
        textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
      },
    });
    const invokeMcpTool = vi.fn<() => Promise<McpInvokeResponse>>().mockResolvedValueOnce({
      ok: true,
      output: {
        structuredContent: {
          url: "https://www.imdb.com/calendar/",
          finalUrl: "https://www.imdb.com/calendar/",
          status: 200,
          title: "IMDb Release Calendar",
          textSnippet: "Upcoming movies this week.",
        },
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool,
      invokeMcpTool,
      listMcpBrowserFallbackTargets: () => [
        {
          serverId: "srv-playwright",
          label: "Playwright MCP",
          tier: "playwright_mcp",
          navigateToolName: "browser.navigate",
          extractToolName: "browser.extract",
        },
      ],
    });

    const executed = await (
      orchestrator as unknown as {
        executeToolCall(input: {
          input: {
            sessionId: string;
            content: string;
            mode: "chat";
            providerId: string;
            model: string;
            webMode: "auto";
            memoryMode: "off";
            thinkingLevel: "standard";
            toolAutonomy: "safe_auto";
          };
          turnId: string;
          toolName: string;
          rawArgs: Record<string, unknown>;
        }): Promise<{ record: ChatToolRunRecord }>;
      }
    ).executeToolCall({
      input: {
        sessionId: "sess-mcp-fallback-1",
        content: "What movies are coming out this week?",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "auto",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
      },
      turnId: "turn-mcp-fallback-1",
      toolName: "browser.navigate",
      rawArgs: {
        url: "https://movieinsider.com/movies",
      },
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "srv-playwright",
        toolName: "browser.navigate",
        arguments: expect.objectContaining({
          url: "https://movieinsider.com/movies",
        }),
      }),
    );
    expect(executed.record.status).toBe("executed");
    expect(executed.record.result).toMatchObject({
      engineTier: "playwright_mcp",
      engineLabel: "Playwright MCP",
      finalUrl: "https://www.imdb.com/calendar/",
    });
    expect(Array.isArray(executed.record.result?.fallbackChain)).toBe(true);
    expect((executed.record.result?.fallbackChain as Array<Record<string, unknown>>)[0]).toMatchObject({
      engineTier: "builtin",
      browserFailureClass: "remote_blocked",
      status: "failed",
    });
  });

  it("stops MCP browser fallback tiers when the turn budget expires mid-fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T20:00:00.000Z"));
    try {
      const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-mcp-budget-nav-1",
        result: {
          url: "https://blocked-site.com/article",
          finalUrl: "https://blocked-site.com/article",
          status: 403,
          title: "Attention Required! | Cloudflare",
          textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
        },
      });
      const invokeMcpTool = vi
        .fn<(request: McpInvokeRequest) => Promise<McpInvokeResponse>>()
        .mockImplementation(async (request: McpInvokeRequest) => {
          vi.setSystemTime(new Date(Date.now() + 15000));
          return {
            ok: false,
            error: `${request.serverId} timed out`,
          };
        });
      const orchestrator = new ChatTurnAgentRunner({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog(["browser.navigate"]),
        createChatCompletion: vi.fn(),
        invokeTool,
        invokeMcpTool,
        listMcpBrowserFallbackTargets: () => [
          {
            serverId: "srv-playwright",
            label: "Playwright MCP",
            tier: "playwright_mcp",
            navigateToolName: "browser.navigate",
            extractToolName: "browser.extract",
          },
          {
            serverId: "srv-browserbase",
            label: "Browserbase MCP",
            tier: "browser_mcp",
            navigateToolName: "browser.navigate",
            extractToolName: "browser.extract",
          },
          {
            serverId: "srv-cdp",
            label: "CDP MCP",
            tier: "browser_mcp",
            navigateToolName: "browser.navigate",
            extractToolName: "browser.extract",
          },
        ],
      });

      const executed = await (
        orchestrator as unknown as {
          executeToolCall(input: {
            input: {
              sessionId: string;
              content: string;
              mode: "chat";
              providerId: string;
              model: string;
              webMode: "auto";
              memoryMode: "off";
              thinkingLevel: "standard";
              toolAutonomy: "safe_auto";
            };
            turnId: string;
            toolName: string;
            rawArgs: Record<string, unknown>;
            turnBudgetDeadline?: number;
          }): Promise<{ record: ChatToolRunRecord }>;
        }
      ).executeToolCall({
        input: {
          sessionId: "sess-mcp-budget-1",
          content: "What's the latest news today?",
          mode: "chat",
          providerId: "glm",
          model: "glm-5",
          webMode: "auto",
          memoryMode: "off",
          thinkingLevel: "standard",
          toolAutonomy: "safe_auto",
        },
        turnId: "turn-mcp-budget-1",
        toolName: "browser.navigate",
        rawArgs: {
          url: "https://blocked-site.com/article",
        },
        turnBudgetDeadline: Date.now() + 25000,
      });

      expect(invokeMcpTool).toHaveBeenCalledTimes(2);
      expect(executed.record.status).toBe("failed");
      expect(Array.isArray(executed.record.result?.fallbackChain)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("poisons blocked hosts when selecting the next grounded browser result", async () => {
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
        };
      }
    ).preflightToolInvocation({
      toolName: "browser.navigate",
      rawArgs: { url: "https://lite.duckduckgo.com/lite/?q=movies+this+week" },
      userContent: "What movies are coming out this week?",
      priorToolRuns: [
        {
          toolRunId: "tool-search-movies-1",
          turnId: "turn-movies-1",
          sessionId: "sess-movies-1",
          toolName: "browser.search",
          status: "executed",
          args: { query: "movies coming out this week" },
          result: {
            results: [
              { title: "Movie Insider releases", url: "https://www.movieinsider.com/movies", snippet: "Releases" },
              {
                title: "Movies coming out this week - IMDb",
                url: "https://www.imdb.com/calendar/",
                snippet: "Upcoming releases this week.",
              },
            ],
          },
          startedAt: "2026-03-10T01:00:00.000Z",
          finishedAt: "2026-03-10T01:00:01.000Z",
        },
        {
          toolRunId: "tool-nav-movies-1",
          turnId: "turn-movies-1",
          sessionId: "sess-movies-1",
          toolName: "browser.navigate",
          status: "failed",
          args: { url: "https://www.movieinsider.com/movies" },
          result: {
            url: "https://www.movieinsider.com/movies",
            finalUrl: "https://www.movieinsider.com/movies",
            status: 403,
            browserFailureClass: "remote_blocked",
          },
          error: "remote site blocked automation (Cloudflare 403)",
          startedAt: "2026-03-10T01:00:02.000Z",
          finishedAt: "2026-03-10T01:00:03.000Z",
        },
      ],
    });

    expect(preflight.toolName).toBe("browser.navigate");
    expect(preflight.args).toMatchObject({
      url: "https://www.imdb.com/calendar/",
    });
  });

  it("poisons policy-blocked navigate hosts even when policy returns no result payload", async () => {
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
          blockedReason?: string;
        };
      }
    ).preflightToolInvocation({
      toolName: "browser.navigate",
      rawArgs: { url: "https://www.lgsfinder.org/stores/canoga-park" },
      userContent:
        "Find boardgame and tabletop game stores within 10 miles of 91303 with address, hours, and email address.",
      priorToolRuns: [
        {
          toolRunId: "tool-search-stores-1",
          turnId: "turn-stores-1",
          sessionId: "sess-stores-1",
          toolName: "browser.search",
          status: "executed",
          args: { query: "boardgame tabletop stores 91303 hours email" },
          result: {
            results: [
              {
                title: "LGS Finder - Canoga Park game stores",
                url: "https://www.lgsfinder.org/stores/canoga-park",
                snippet: "Local game store directory for tabletop games.",
              },
              {
                title: "Fire and Dice Games - Canoga Park board game store contact",
                url: "https://www.fireanddicegames.com/contact",
                snippet: "Board game store near Canoga Park with hours, address, contact, and email details.",
              },
            ],
          },
          startedAt: "2026-05-21T01:00:00.000Z",
          finishedAt: "2026-05-21T01:00:01.000Z",
        },
        {
          toolRunId: "tool-nav-stores-1",
          turnId: "turn-stores-1",
          sessionId: "sess-stores-1",
          toolName: "browser.navigate",
          status: "blocked",
          args: { url: "https://www.lgsfinder.org/stores/canoga-park" },
          error: "browser.navigate host is not yet allowlisted",
          startedAt: "2026-05-21T01:00:02.000Z",
          finishedAt: "2026-05-21T01:00:03.000Z",
        },
      ],
    });

    expect(preflight.toolName).toBe("browser.navigate");
    expect(preflight.args).toMatchObject({
      url: "https://www.fireanddicegames.com/contact",
    });
    expect(preflight.blockedReason).toBeUndefined();
  });

  it("pauses repeated policy-blocked navigate hosts when no alternate search result exists", async () => {
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });

    const preflight = (
      orchestrator as unknown as {
        preflightToolInvocation(input: {
          toolName: string;
          rawArgs: Record<string, unknown>;
          userContent: string;
          priorToolRuns?: ChatToolRunRecord[];
        }): {
          toolName: string;
          args: Record<string, unknown>;
          blockedReason?: string;
        };
      }
    ).preflightToolInvocation({
      toolName: "browser.navigate",
      rawArgs: { url: "https://www.lgsfinder.org/stores/canoga-park" },
      userContent:
        "Find boardgame and tabletop game stores within 10 miles of 91303 with address, hours, and email address.",
      priorToolRuns: [
        {
          toolRunId: "tool-nav-stores-2",
          turnId: "turn-stores-2",
          sessionId: "sess-stores-2",
          toolName: "browser.navigate",
          status: "blocked",
          args: { url: "https://www.lgsfinder.org/stores/canoga-park" },
          error: "browser.navigate host is not yet allowlisted",
          startedAt: "2026-05-21T01:00:02.000Z",
          finishedAt: "2026-05-21T01:00:03.000Z",
        },
      ],
    });

    expect(preflight.blockedReason).toContain("already blocked earlier in this turn");
    expect(preflight.blockedReason).toContain("Request allowlist approval");
  });

  it("surfaces blocked-source fallback copy instead of generic retry wording", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://www.movieinsider.com/movies" }))
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://www.movieinsider.com/movies" }));
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-movieinsider-blocked",
      result: {
        url: "https://www.movieinsider.com/movies",
        finalUrl: "https://www.movieinsider.com/movies",
        status: 403,
        title: "Attention Required! | Cloudflare",
        textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-movieinsider-blocked-1",
      turnId: randomUUID(),
      userMessageId: "msg-movieinsider-blocked-1",
      content: "What movies are coming out this week?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What movies are coming out this week?" }],
    });

    expect(result.assistantContent).toContain("movieinsider.com");
    expect(result.assistantContent).toContain("blocked");
  });

  it("grounds vague retry prompts to the prior topic instead of searching the literal phrase", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("retry with a better fallback"))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "The main REST API use cases are CRUD, integrations, mobile backends, automation, and partner-facing services.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-rest-retry-grounded-1",
      result: {
        query: "top 5 ways REST APIs are used",
        results: [
          {
            title: "What Is REST API? Examples, Uses & Challenges - Postman Blog",
            url: "https://blog.postman.com/rest-api-examples/",
            snippet: "Examples and common use cases.",
          },
          {
            title: "REST API Introduction - GeeksforGeeks",
            url: "https://www.geeksforgeeks.org/rest-api-introduction/",
            snippet: "REST principles and use cases.",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-retry-grounded-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-retry-grounded-1",
      content: "Please retry with a better fallback",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Can you look into the top 5 ways that a REST API can be used?" },
        {
          role: "assistant",
          content: [
            "A source blocked automated browsing on blog.postman.com, so I'm falling back to the strongest leads I recovered so far:",
            "",
            "1. What Is a REST API? Examples, Uses & Challenges - Postman Blog",
            "2. REST API Introduction - GeeksforGeeks",
          ].join("\n"),
        },
        { role: "user", content: "Please retry with a better fallback" },
      ],
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    const groundedRetryCalls = invokeTool.mock.calls as unknown as Array<
      [{ toolName: string; args: Record<string, unknown> }]
    >;
    const groundedRetryCall = groundedRetryCalls[0]![0]!;
    expect(groundedRetryCall).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({
        query: expect.stringMatching(/rest api/i),
      }),
    });
    expect(String(groundedRetryCall.args.query)).not.toMatch(/better fallback/i);
    expect(result.assistantContent).toContain("REST API");
  });

  it("prefers structured browser search alternatives over literal retry text", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "kimi-k2.6",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-search-kimi-1",
                  type: "function",
                  function: {
                    name: "browser_search",
                    arguments: JSON.stringify({
                      query: "Try the search one more time",
                      queries: [
                        "top 5 ways REST APIs are used common use cases",
                        "REST API use cases examples applications",
                        "how are REST APIs commonly used real world",
                      ],
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "kimi-k2.6",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Here are the top ways REST APIs are used in practice.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-rest-queries-grounded-1",
      result: {
        query: "top 5 ways REST APIs are used common use cases",
        results: [
          {
            title: "What Is REST API? Examples, Uses & Challenges - Postman Blog",
            url: "https://blog.postman.com/rest-api-examples/",
            snippet: "Examples and common use cases.",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-rest-queries-grounded-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-queries-grounded-1",
      content: "Try the search one more time",
      mode: "chat",
      providerId: "moonshot",
      model: "kimi-k2.6",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Can you look online and find the top 5 ways rest apis are used?" },
        {
          role: "assistant",
          content:
            "A source blocked automated browsing on blog.postman.com, so I'm falling back to the strongest leads I recovered so far.",
        },
        { role: "user", content: "Try the search one more time" },
      ],
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
    const kimiRetryCalls = invokeTool.mock.calls as unknown as Array<[{ args: Record<string, unknown> }]>;
    const kimiRetryCall = kimiRetryCalls[0]![0]!;
    expect(String(kimiRetryCall.args.query)).toMatch(/rest api/i);
    expect(String(kimiRetryCall.args.query)).not.toMatch(/one more time/i);
  });

  it("retries a blocked browser navigate against the next ranked search result in the same turn", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://blog.postman.com/rest-api-examples/" }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "REST APIs are commonly used for CRUD app backends, third-party integrations, mobile app services, workflow automation, and partner/public APIs.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-search-1",
        result: {
          query: "top 5 ways REST APIs are used",
          results: [
            {
              title: "What Is REST API? Examples, Uses & Challenges - Postman Blog",
              url: "https://blog.postman.com/rest-api-examples/",
              snippet: "Examples and use cases.",
            },
            {
              title: "How to Use REST API: Examples, Key Features, and Applications - ClickUp",
              url: "https://clickup.com/blog/rest-api-examples/",
              snippet: "Key features and real-world applications.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-postman-blocked-1",
        result: {
          url: "https://blog.postman.com/rest-api-examples/",
          finalUrl: "https://blog.postman.com/rest-api-examples/",
          status: 403,
          title: "Just a moment...",
          textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-clickup-1",
        result: {
          url: "https://clickup.com/blog/rest-api-examples/",
          finalUrl: "https://clickup.com/blog/rest-api-examples/",
          status: 200,
          title: "How to Use REST API: Examples, Key Features, and Applications - ClickUp",
          textSnippet: "REST APIs are used for integrations, automation, mobile and web backends, and partner systems.",
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-blocked-retry-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-blocked-retry-1",
      content: "Can you look online into the top 5 ways that a REST API can be used?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Can you look online into the top 5 ways that a REST API can be used?" },
      ],
    });

    expect(invokeTool).toHaveBeenCalledTimes(3);
    const navigateRetryCalls = invokeTool.mock.calls as unknown as Array<
      [{ toolName: string; args: Record<string, unknown> }]
    >;
    const firstNavigateCall = navigateRetryCalls[1]![0]!;
    const secondNavigateCall = navigateRetryCalls[2]![0]!;
    expect(firstNavigateCall).toMatchObject({
      toolName: "browser.navigate",
      args: expect.objectContaining({
        url: "https://blog.postman.com/rest-api-examples/",
      }),
    });
    expect(secondNavigateCall).toMatchObject({
      toolName: "browser.navigate",
      args: expect.objectContaining({
        url: "https://clickup.com/blog/rest-api-examples/",
      }),
    });
    expect(result.assistantContent).toContain("REST APIs");
  });

  it("prefers direct news publishers over portal reposts after a blocked current-events source", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://www.reuters.com/world/iran/" }))
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "ABC reported that search efforts intensified for a missing US crew member as the conflict escalated.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-us-iran-search-1",
        result: {
          query: "latest news today us iran",
          results: [
            {
              title: "Iran War: Latest Breaking News, Updates & Analysis | Reuters",
              url: "https://www.reuters.com/world/iran/",
              snippet: "Live coverage and analysis from Reuters.",
            },
            {
              title: "Iran live updates: Search for missing US crew member intensifies",
              url: "https://abcnews.com/International/live-updates/iran-live-updates-trump-touts-big-day-iran/?id=131532311",
              snippet: "ABC News live updates on the US and Iran.",
            },
            {
              title: "Tehran Dismisses U.S. Cease-Fire Conditions as Israel Steps Up Attacks",
              url: "https://www.nytimes.com/live/2026/03/25/world/iran-war-trump-oil-news",
              snippet: "New York Times live coverage of the conflict.",
            },
            {
              title: "Iran live updates: 290 American troops wounded in Iran war - Yahoo",
              url: "https://www.yahoo.com/news/articles/iran-live-updates-trumps-48-090509033.html",
              snippet: "Yahoo's live updates page covering the US and Iran.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-us-iran-reuters-blocked-1",
        result: {
          url: "https://www.reuters.com/world/iran/",
          finalUrl: "https://www.reuters.com/world/iran/",
          status: 401,
          title: "Reuters",
          textSnippet: "Automation blocked",
          browserFailureClass: "remote_blocked",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-us-iran-abc-1",
        result: {
          url: "https://abcnews.com/International/live-updates/iran-live-updates-trump-touts-big-day-iran/?id=131532311",
          finalUrl:
            "https://abcnews.com/International/live-updates/iran-live-updates-trump-touts-big-day-iran/?id=131532311",
          status: 200,
          title: "Iran live updates: Search for missing US crew member intensifies",
          textSnippet: "ABC News reports that search efforts intensified for a missing US crew member.",
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-us-iran-news-fallback-1",
      turnId: randomUUID(),
      userMessageId: "msg-us-iran-news-fallback-1",
      content: "tell me something that happened today regarding the us and iran",
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "tell me something that happened today regarding the us and iran" }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(3);
    const navigateRetryCalls = invokeTool.mock.calls as unknown as Array<
      [{ toolName: string; args: Record<string, unknown> }]
    >;
    const firstNavigateCall = navigateRetryCalls[1]![0]!;
    const secondNavigateCall = navigateRetryCalls[2]![0]!;
    expect(firstNavigateCall).toMatchObject({
      toolName: "browser.navigate",
      args: expect.objectContaining({
        url: "https://www.reuters.com/world/iran/",
      }),
    });
    expect(secondNavigateCall).toMatchObject({
      toolName: "browser.navigate",
      args: expect.objectContaining({
        url: "https://abcnews.com/International/live-updates/iran-live-updates-trump-touts-big-day-iran/?id=131532311",
      }),
    });
    expect(result.assistantContent).toContain("ABC reported");
  });

  it("prefers use-case result pages over definition pages after a blocked first source", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://blog.postman.com/rest-api-examples/" }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "REST APIs are commonly used for web and mobile apps, integrations, microservices, IoT, and internal tooling.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-usecase-search-1",
        result: {
          query: "the top 5 uses for REST APIs",
          results: [
            {
              title: "What Is a REST API? Examples, Uses & Challenges - Postman Blog",
              url: "https://blog.postman.com/rest-api-examples/",
              snippet: "What is a REST API? Examples, Uses & Challenges - Postman Blog.",
            },
            {
              title: "What is a REST API? Benefits, Uses, Examples - TechTarget",
              url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
              snippet:
                "A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data.",
            },
            {
              title: "What is a REST API? Examples, Use Cases, and Best Practices",
              url: "https://www.browserstack.com/guide/rest-api",
              snippet:
                "Learn REST API basics with real-world REST API examples, key principles, architectural constraints, and best practices for reliable design.",
            },
            {
              title: "REST API basics and implementation | Google Cloud",
              url: "https://cloud.google.com/discover/what-is-rest-api",
              snippet: "Learn what a REST API is, how it works, and its core principles.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-usecase-postman-blocked-1",
        result: {
          url: "https://blog.postman.com/rest-api-examples/",
          finalUrl: "https://blog.postman.com/rest-api-examples/",
          status: 403,
          title: "Just a moment...",
          textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-usecase-browserstack-1",
        result: {
          url: "https://www.browserstack.com/guide/rest-api",
          finalUrl: "https://www.browserstack.com/guide/rest-api",
          status: 200,
          title: "What is a REST API? Examples, Use Cases, and Best Practices",
          textSnippet:
            "REST APIs are used for web and mobile backends, integrations with third-party services, partner APIs, and automation workflows.",
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-rest-usecase-ranking-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-usecase-ranking-1",
      content: "Can you look online and find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
    });

    const navigateCalls = (
      invokeTool.mock.calls as unknown as Array<[{ toolName: string; args: Record<string, unknown> }]>
    )
      .map((call) => call[0])
      .filter((call) => call.toolName === "browser.navigate");
    expect(navigateCalls).toHaveLength(2);
    expect(navigateCalls[1]).toMatchObject({
      args: expect.objectContaining({
        url: "https://www.browserstack.com/guide/rest-api",
      }),
    });
  });

  it("gives live-data browse turns enough time to synthesize after a successful navigate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T18:33:34.000Z"));
    try {
      const createChatCompletion = vi
        .fn<() => Promise<ChatCompletionResponse>>()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 9000));
          return navigateToolCallCompletion({
            url: "https://www.techtarget.com/searchapparchitecture/tip/The-5-essential-HTTP-methods-in-RESTful-API-development",
          });
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 2000));
          return {
            model: "glm-5",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    "The top REST API uses are CRUD backends, third-party integrations, mobile app services, workflow automation, and partner-facing APIs.",
                },
              },
            ],
          };
        });
      const invokeTool = vi
        .fn<() => Promise<ToolInvokeResult>>()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 3000));
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-rest-budget-search-1",
            result: {
              query: "top 5 ways REST APIs are used",
              results: [
                {
                  title: "What is a REST API? Examples, Use Cases, and Best Practices",
                  url: "https://www.browserstack.com/guide/rest-api",
                  snippet: "REST APIs are commonly used for integrations, CRUD backends, and automation.",
                },
                {
                  title: "The 5 essential HTTP methods in RESTful API development",
                  url: "https://www.techtarget.com/searchapparchitecture/tip/The-5-essential-HTTP-methods-in-RESTful-API-development",
                  snippet: "RESTful services use HTTP methods and commonly back web, mobile, and partner systems.",
                },
              ],
            },
          };
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 15000));
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-rest-budget-navigate-1",
            result: {
              url: "https://www.techtarget.com/searchapparchitecture/tip/The-5-essential-HTTP-methods-in-RESTful-API-development",
              finalUrl:
                "https://www.techtarget.com/searchapparchitecture/tip/The-5-essential-HTTP-methods-in-RESTful-API-development",
              status: 200,
              title: "The 5 essential HTTP methods in RESTful API development | TechTarget",
              textSnippet:
                "REST APIs are widely used for web and mobile backends, app integrations, automation flows, and partner-facing services.",
            },
          };
        });
      const orchestrator = new ChatTurnAgentRunner({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
        createChatCompletion,
        invokeTool,
      });

      const result = await orchestrator.run({
        sessionId: "sess-rest-budget-extension-1",
        turnId: randomUUID(),
        userMessageId: "msg-rest-budget-extension-1",
        content: "Can you look online and find the top 5 ways rest apis are used?",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "auto",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
        historyMessages: [{ role: "user", content: "Can you look online and find the top 5 ways rest apis are used?" }],
      });

      expect(result.assistantContent).toContain("top REST API uses");
      expect(result.turnTrace.failure).toBeUndefined();
      expect(createChatCompletion).toHaveBeenCalledTimes(2);
      expect(invokeTool).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters cookie-banner and nav boilerplate out of recovered fetched-content fallbacks", async () => {
    const articleUrl = "https://dnsmadeeasy.com/resources/rest-apis-explained-how-they-work-and-why-theyre-essential";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("find out the top 5 uses for REST APIs"))
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: articleUrl }))
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: articleUrl }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
            },
          },
        ],
      })
      .mockRejectedValueOnce(new Error("synthesis timeout"));
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-cookie-search-1",
        result: {
          query: "find out the top 5 uses for REST APIs",
          results: [
            {
              title: "REST APIs Explained: How They Work and Why They're Essential",
              url: articleUrl,
              snippet: "REST APIs are widely used to build web services and integrate different applications.",
            },
          ],
        },
      })
      .mockResolvedValue({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-cookie-navigate-1",
        result: {
          url: articleUrl,
          finalUrl: articleUrl,
          status: 200,
          title: "REST APIs Explained: How They Work and Why They're Essential",
          textSnippet: [
            "This website uses cookies to ensure you get the best experience on our website.",
            "Learn more Got it! Skip to content Product Integrations Pricing Resources Company FREE TRIAL BOOK DEMO Search Support Login BLOG.",
            "APIs are an essential tool that facilitates communication between software and applications.",
            "REST APIs are widely used to build web services and integrate different applications.",
            "An online store might use a RESTful API to connect its inventory system with its website and mobile app.",
            "Another common use is workflow automation between internal systems and partner-facing services.",
          ].join(" "),
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-cookie-fallback-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-cookie-fallback-1",
      content: "Can you look online and find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
    });

    expect(result.assistantContent).toContain(
      "REST APIs are widely used to build web services and integrate different applications.",
    );
    expect(result.assistantContent).toContain("An online store might use a RESTful API");
    expect(result.assistantContent).not.toContain("This website uses cookies");
    expect(result.assistantContent).not.toContain("Skip to content");
    expect(result.assistantContent).not.toContain("FREE TRIAL");
    expect(result.turnTrace.failure?.failureClass).toBe("unknown");
  });

  it("extends auto-mode budget when a non-live-data turn actually enters browser-backed execution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T19:10:00.000Z"));
    try {
      const createChatCompletion = vi
        .fn<() => Promise<ChatCompletionResponse>>()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 15000));
          return navigateToolCallCompletion({
            url: "https://example.com/protobuf-vs-json-schema",
          });
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 15000));
          return {
            model: "glm-5",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    "Protobuf is usually better for compact binary transport, while JSON Schema is stronger for JSON validation, interoperability, and contract tooling.",
                },
              },
            ],
          };
        });
      const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(Date.now() + 15000));
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: "audit-browser-extension-navigate-1",
          result: {
            url: "https://example.com/protobuf-vs-json-schema",
            finalUrl: "https://example.com/protobuf-vs-json-schema",
            status: 200,
            title: "Protobuf vs JSON Schema for service contracts",
            textSnippet:
              "Protobuf favors binary efficiency and typed contracts. JSON Schema favors human-readable JSON validation and broader ecosystem interoperability.",
          },
        };
      });
      const orchestrator = new ChatTurnAgentRunner({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
        createChatCompletion,
        invokeTool,
      });

      const result = await orchestrator.run({
        sessionId: "sess-browser-extension-1",
        turnId: randomUUID(),
        userMessageId: "msg-browser-extension-1",
        content: "Compare protobuf and JSON Schema tradeoffs using https://example.com/protobuf-vs-json-schema.",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "auto",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
        historyMessages: [
          {
            role: "user",
            content: "Compare protobuf and JSON Schema tradeoffs using https://example.com/protobuf-vs-json-schema.",
          },
        ],
      });

      expect(result.turnTrace.routing?.liveDataIntent).toBe(false);
      expect(result.assistantContent).toContain("Protobuf");
      expect(result.turnTrace.failure).toBeUndefined();
      expect(createChatCompletion).toHaveBeenCalledTimes(2);
      expect(invokeTool).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses fetched page content in the budget fallback after a successful navigate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));
    try {
      const createChatCompletion = vi
        .fn<() => Promise<ChatCompletionResponse>>()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 12000));
          return toolCallCompletion("help me leveling my skinning profession in world of warcraft midnight");
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 10000));
          return navigateToolCallCompletion({
            url: "https://www.wowhead.com/guide/midnight/professions/skinning-overview-trainer-locations-hides-tracking-tools",
          });
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 20000));
          return navigateToolCallCompletion({
            url: "https://www.wowhead.com/guide/midnight/professions/skinning-overview-trainer-locations-hides-tracking-tools#leveling",
          });
        });
      const invokeTool = vi
        .fn<() => Promise<ToolInvokeResult>>()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 5000));
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-skinning-search-1",
            result: {
              query: "help me leveling my skinning profession in world of warcraft midnight",
              results: [
                {
                  title: "Midnight Skinning Profession Overview - Wowhead",
                  url: "https://www.wowhead.com/guide/midnight/professions/skinning-overview-trainer-locations-hides-tracking-tools",
                  snippet:
                    "Skinning in WoW Midnight covers leveling, trainer locations, hides, tracking, and profession tools.",
                },
              ],
            },
          };
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-skinning-navigate-1",
            result: {
              url: "https://www.wowhead.com/guide/midnight/professions/skinning-overview-trainer-locations-hides-tracking-tools",
              finalUrl:
                "https://www.wowhead.com/guide/midnight/professions/skinning-overview-trainer-locations-hides-tracking-tools",
              status: 200,
              title: "Midnight Skinning Profession Overview - Wowhead",
              textSnippet: [
                "Skinning in Midnight focuses on gathering leather and hides from beasts across the new zones.",
                "Leveling is primarily done by skinning beasts close to your current profession skill, then shifting to higher-rank creature families as recipes and drop ranks improve.",
                "Tracking, profession tools, and route selection matter because dense beast camps dramatically improve leveling speed.",
              ].join(" "),
            },
          };
        });
      const orchestrator = new ChatTurnAgentRunner({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
        createChatCompletion,
        invokeTool,
      });

      const result = await orchestrator.run({
        sessionId: "sess-skinning-budget-fallback-1",
        turnId: randomUUID(),
        userMessageId: "msg-skinning-budget-fallback-1",
        content: "Look online and help me leveling my skinning profession in world of warcraft midnight.",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "auto",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
        historyMessages: [
          {
            role: "user",
            content: "Look online and help me leveling my skinning profession in world of warcraft midnight.",
          },
        ],
      });

      expect(result.turnTrace.failure?.failureClass).toBeDefined();
      expect(result.assistantContent).toContain("Midnight Skinning Profession Overview - Wowhead");
      expect(result.assistantContent).toContain(
        "Leveling is primarily done by skinning beasts close to your current profession skill",
      );
      expect(result.assistantContent).not.toContain("strongest leads so far");
      expect(createChatCompletion.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(invokeTool).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("repairs degraded fallback-style assistant answers after successful tool execution", async () => {
    const badFallback = [
      "I ran out of time before I could finish a full pass, but I did recover useful content from What is a REST API? Benefits, uses, examples:",
      "",
      "1. The REST API supports data formats such as application/json and application/xml.",
      "2. A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data.",
      "3. REST APIs are also referred to as RESTful web services and RESTful APIs.",
      "",
      "Source: What is a REST API? Benefits, uses, examples - https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
      "",
      "If you want, ask me to continue from this page with a narrower follow-up, or retry in Deep mode for a slower pass.",
    ].join("\n");
    const repairedAnswer = [
      "The retrieved sources point to a few common REST API uses, even though I did not get a clean ranked top-5 article.",
      "",
      "1. Moving data between frontends and backends for web and mobile apps.",
      "2. User and account management workflows.",
      "3. E-commerce operations such as catalog, cart, and order flows.",
      "4. Payment and transaction processing integrations.",
      "5. Third-party service integrations and workflow automation.",
      "",
      "Primary sources I recovered: TechTarget, Requestly, and Postman.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("the top 5 uses for REST APIs"))
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://blog.postman.com/rest-api-examples/",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: badFallback,
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: repairedAnswer,
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-search-1",
        result: {
          query: "the top 5 uses for REST APIs",
          results: [
            {
              title: "What Is a REST API? Examples, Uses & Challenges - Postman Blog",
              url: "https://blog.postman.com/rest-api-examples/",
              snippet:
                "A REST API is a simple uniform interface used to make digital resources available through web URLs.",
            },
            {
              title: "What is REST API: Examples, Principles, and Use Cases",
              url: "https://requestly.com/blog/rest-api-examples/",
              snippet:
                "Learn what REST APIs are with practical examples such as user management, e-commerce, and payment systems.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-navigate-1",
        result: {
          url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          finalUrl: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          status: 200,
          title: "What is a REST API? Benefits, uses, examples",
          textSnippet: [
            "A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data.",
            "That data can be used to GET, PUT, POST and DELETE data types, which refers to reading, updating, creating and deleting operations related to resources.",
            "REST APIs are also referred to as RESTful web services and RESTful APIs.",
          ].join(" "),
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-fallback-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-fallback-repair-1",
      content: "Can you look online and find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
    });

    expect(result.assistantContent).toContain("Moving data between frontends and backends");
    expect(result.assistantContent).not.toContain("I ran out of time before I could finish a full pass");
    expect(result.turnTrace.failure?.failureClass).toBe("unknown");
    expect(result.turnTrace.completion).toMatchObject({
      repaired: true,
      repair: {
        applied: true,
        kind: "degraded_answer_synthesis",
        source: "orchestrator",
        preRepairContent: badFallback,
        postRepairContent: repairedAnswer,
      },
    });
    expect(createChatCompletion).toHaveBeenCalledTimes(4);
    const invokedToolNames = (invokeTool.mock.calls as unknown as Array<[{ toolName: string }]>).map(
      (call) => call[0].toolName,
    );
    expect(invokedToolNames).toContain("browser.search");
    expect(invokedToolNames).toContain("browser.navigate");
  });

  it("falls back to a direct recovered-evidence answer when degraded-answer repair times out", async () => {
    const badFallback = [
      "I ran out of time before I could finish a full pass, but I did recover useful content from What is a REST API? Benefits, uses, examples:",
      "",
      "1. The REST API supports data formats such as application/json and application/xml.",
      "2. A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data.",
      "3. REST APIs are also referred to as RESTful web services and RESTful APIs.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("the top 5 uses for REST APIs"))
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://blog.postman.com/rest-api-examples/",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: badFallback,
            },
          },
        ],
      })
      .mockRejectedValueOnce(new Error("Chat completion timed out after 20000ms."));
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-search-timeout-1",
        result: {
          query: "the top 5 uses for REST APIs",
          results: [
            {
              title: "What is REST API: Examples, Principles, and Use Cases",
              url: "https://requestly.com/blog/rest-api-examples/",
              snippet:
                "REST APIs are often used for user management, e-commerce workflows, payment processing, and automation across third-party services.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-navigate-timeout-1",
        result: {
          url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          finalUrl: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          status: 200,
          title: "What is a REST API? Benefits, uses, examples",
          textSnippet: [
            "REST APIs are commonly used to integrate applications and services across distributed environments.",
            "Teams use them for web and mobile backends, partner integrations, workflow automation, and exchanging data between systems.",
            "They are also used to manage resources through standard HTTP operations.",
          ].join(" "),
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-fallback-timeout-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-fallback-timeout-1",
      content: "Can you look online and find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
    });

    expect(result.assistantContent).toContain("Based on the sources I did retrieve");
    expect(result.assistantContent).toContain("web and mobile backends");
    expect(result.assistantContent).toContain("partner integrations");
    expect(result.assistantContent).not.toContain("I ran out of time before I could finish a full pass");
    expect(result.turnTrace.failure?.failureClass).toBe("unknown");
  });

  it("deprioritizes definition-page mechanics when recovering use-case answers from fetched content", async () => {
    const badFallback = [
      "I ran out of time before I could finish a full pass, but I did recover useful content from What is a REST API? Benefits, uses, examples:",
      "",
      "1. The REST API supports data formats such as application/json and application/xml.",
      "2. A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data.",
      "3. REST APIs are also referred to as RESTful web services and RESTful APIs.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("the top 5 uses for REST APIs"))
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://blog.postman.com/rest-api-examples/",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: badFallback,
            },
          },
        ],
      })
      .mockRejectedValueOnce(new Error("Chat completion timed out after 20000ms."));
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-search-timeout-live-1",
        result: {
          query: "the top 5 uses for REST APIs",
          results: [
            {
              title: "What Is a REST API? Examples, Uses & Challenges - Postman Blog",
              url: "https://blog.postman.com/rest-api-examples/",
              snippet: "What Is a REST API? Examples, Uses & Challenges - Postman Blog.",
            },
            {
              title: "What is a REST API? Benefits, Uses, Examples - TechTarget",
              url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
              snippet:
                "A REST API is an architectural style for an application programming interface that uses HTTP requests to access and use data.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-rest-navigate-timeout-live-1",
        result: {
          url: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          finalUrl: "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API",
          status: 200,
          title: "What is a REST API? Benefits, uses, examples",
          textSnippet:
            "Search the TechTarget Network Login Register TechTarget Network Software Quality Cloud Computing TheServerSide Search App Architecture API Management App Development & Design App Management Tools Architecture Management EAI News Features Tips Webinars Sponsored Sites More Follow: Home API design and management Tech Accelerator Guide to building an enterprise API strategy PREV NEXT DEFINITION What is a REST API? Benefits, Uses, Examples By Scott Robinson, New Era Technology Stephen J. Bigelow, Senior Technology Editor Alexander S. Gillis, Technical Writer and Editor Published: Sep 30, 2025 A REST API is an architectural style for an application programming interface that uses Hypertext Transfer Protocol (HTTP) requests to access and use data. That data can be used to GET, PUT, POST and DELETE data types, which refers to reading, updating, creating and deleting operations related to resources. The API's design spells out the proper way for a developer to write a program, or client, that uses the API to request services from another application, or the server. APIs are a vital mechanism for software interoperability. REST APIs are also referred to as RESTful web services and RESTful APIs. This approach can also facilitate communication between other application types. REST technology is generally preferred over similar technologies because it uses less bandwidth, making it more efficient for internet use. REST APIs can also be built with common programming languages such as PHP, JavaScript and Python. Cloud consumers use APIs to expose and organize access to web services. REST is a logical choice for building APIs to provide users with ways to flexibly connect to, manage and interact with cloud services in distributed environments. Sites such as Amazon, Google, LinkedIn and Twitter use REST APIs. A REST API fundamentally relies on the following three major elements: Client. The client is the software code or application that requests a resource from a server. The server is the software code or application that controls the resource and responds to client requests for the resource. The REST API supports data formats such as application/json, application/xml, application/x-web+xml, application/x-www-form-urlencoded and multipart.",
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-rest-fallback-timeout-live-1",
      turnId: randomUUID(),
      userMessageId: "msg-rest-fallback-timeout-live-1",
      content: "Can you look online and find out the top 5 uses for REST APIs?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Can you look online and find out the top 5 uses for REST APIs?" }],
    });

    expect(result.assistantContent).toContain("Based on the sources I did retrieve");
    expect(result.assistantContent).toContain("cloud services");
    expect(result.assistantContent).not.toContain("application/json");
    expect(result.assistantContent).not.toContain("technical writer");
    expect(result.assistantContent).not.toContain("common programming languages");
    expect(result.turnTrace.failure?.failureClass).toBe("unknown");
  });

  it("reuses duplicate explicit http.get calls for the same URL", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        httpGetToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce(
        httpGetToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Here is the synthesized answer.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-http-get-reuse-1",
      result: {
        url: "https://example.com/research",
        finalUrl: "https://example.com/research",
        status: 200,
        text: "Fetched content for reuse.",
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["http.get"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-http-get-reuse-1",
      turnId: "turn-http-get-reuse-1",
      userMessageId: "msg-http-get-reuse-1",
      content: "Fetch https://example.com/research again.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Fetch https://example.com/research again." }],
    });

    expect(result.turnTrace.failure).toBeUndefined();
    expect(result.assistantContent).toContain("Here is the synthesized answer.");
    expect(invokeTool).toHaveBeenCalledTimes(1);
    const toolRuns = result.turnTrace.toolRuns;
    expect(toolRuns).toHaveLength(2);
    expect(toolRuns[0]?.toolName).toBe("http.get");
    expect(toolRuns[1]?.toolName).toBe("http.get");
    expect(toolRuns[1]).toMatchObject({
      reused: true,
      reusedFromToolRunId: toolRuns[0]?.toolRunId,
      reuseReason: "matching_recent_browser_result",
    });
    expect(toolRuns[1]?.result).toMatchObject({
      reusedNotice: expect.stringContaining(toolRuns[0]?.toolRunId ?? ""),
      reusedResult: true,
      reusedPriorToolRunId: toolRuns[0]?.toolRunId,
      reuseReason: "matching_recent_browser_result",
    });
  });

  it("does not reuse a prior browser result when the current call is preflight-blocked", async () => {
    const storage = createMockStorage();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const executeToolCall = createExecuteToolCallForTest({
      storage: storage as never,
      invokeTool,
      toolNames: ["http.get"],
    });
    const priorToolRun: ChatToolRunRecord = {
      toolRunId: "prior-http-get-run",
      turnId: "prior-turn",
      sessionId: "sess-blocked-reuse",
      toolName: "http.get",
      status: "executed",
      args: { url: "https://example.com/research" },
      result: {
        url: "https://example.com/research",
        finalUrl: "https://example.com/research",
        status: 200,
        text: "Previously fetched content.",
      },
      startedAt: "2026-05-07T00:00:00.000Z",
      finishedAt: "2026-05-07T00:00:01.000Z",
    };

    const result = await executeToolCall({
      input: {
        sessionId: "sess-blocked-reuse",
        turnId: "turn-blocked-reuse",
        userMessageId: "msg-blocked-reuse",
        content: "Fetch https://example.com/research",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
        historyMessages: [{ role: "user", content: "Fetch https://example.com/research" }],
      },
      turnId: "turn-blocked-reuse",
      toolName: "http.get",
      rawArgs: { url: "https://example.com/research" },
      priorToolRuns: [priorToolRun],
    });

    expect(result.record.status).toBe("blocked");
    expect(result.record.reused).not.toBe(true);
    expect(result.record.reusedFromToolRunId).toBeUndefined();
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("reuses an immediate duplicate browser.navigate call to the same URL when no browser state changed", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Done.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-nav-no-reuse",
      result: {
        url: "https://example.com/research",
        finalUrl: "https://example.com/research",
        status: 200,
        title: "Example research",
        textSnippet: "Example content",
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-nav-no-reuse-1",
      turnId: "turn-nav-no-reuse-1",
      userMessageId: "msg-nav-no-reuse-1",
      content: "Open https://example.com/research twice.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Open https://example.com/research twice." }],
    });

    expect(result.turnTrace.failure).toBeUndefined();
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(result.turnTrace.toolRuns[1]).toMatchObject({
      reused: true,
      reusedFromToolRunId: result.turnTrace.toolRuns[0]?.toolRunId,
      reuseReason: "matching_recent_browser_result",
    });
    expect(result.turnTrace.toolRuns[1]?.result).toMatchObject({
      reusedResult: true,
      reusedPriorToolRunId: result.turnTrace.toolRuns[0]?.toolRunId,
      reuseReason: "matching_recent_browser_result",
    });
  });

  it("does not reuse duplicate browser.navigate calls when a different page was opened in between", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/other",
        }),
      )
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Done.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-reuse-blocked-1",
        result: {
          url: "https://example.com/research",
          finalUrl: "https://example.com/research",
          status: 200,
          title: "Example research",
          textSnippet: "Example content",
          browserSessionId: "sess-nav-reuse-blocked-1",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-reuse-blocked-2",
        result: {
          url: "https://example.com/other",
          finalUrl: "https://example.com/other",
          status: 200,
          title: "Example other page",
          textSnippet: "Other page content",
          browserSessionId: "sess-nav-reuse-blocked-1",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-reuse-blocked-3",
        result: {
          url: "https://example.com/research",
          finalUrl: "https://example.com/research",
          status: 200,
          title: "Example research",
          textSnippet: "Example content after visiting another page",
          browserSessionId: "sess-nav-reuse-blocked-1",
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-nav-reuse-blocked-1",
      turnId: "turn-nav-reuse-blocked-1",
      userMessageId: "msg-nav-reuse-blocked-1",
      content: "Open the page, open another page, then open the first page again.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Open the page, open another page, then open the first page again." }],
    });

    expect(result.turnTrace.failure).toBeUndefined();
    expect(invokeTool).toHaveBeenCalledTimes(3);
    expect(result.turnTrace.toolRuns.every((run) => run.result?.reusedResult !== true)).toBe(true);
  });

  it("bypasses browser.navigate reuse when bypassCache is requested", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/research",
        }),
      )
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://example.com/research",
          bypassCache: true,
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Done.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-bypass-cache-1",
        result: {
          url: "https://example.com/research",
          finalUrl: "https://example.com/research",
          status: 200,
          title: "Example research",
          textSnippet: "Example content",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-bypass-cache-2",
        result: {
          url: "https://example.com/research",
          finalUrl: "https://example.com/research",
          status: 200,
          title: "Example research refreshed",
          textSnippet: "Fresh example content",
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-nav-bypass-cache-1",
      turnId: "turn-nav-bypass-cache-1",
      userMessageId: "msg-nav-bypass-cache-1",
      content: "Open the page, then force-refresh it.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Open the page, then force-refresh it." }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(result.turnTrace.toolRuns.every((run) => run.reused !== true)).toBe(true);
    expect(result.turnTrace.toolRuns.every((run) => run.result?.reusedResult !== true)).toBe(true);
  });

  it("reuses a follow-up browser.navigate when the prior navigate already resolved to that final URL", async () => {
    const finalUrl = "https://www.techtarget.com/searchapparchitecture/definition/RESTful-API";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: "https://blog.postman.com/rest-api-examples/",
        }),
      )
      .mockResolvedValueOnce(
        navigateToolCallCompletion({
          url: finalUrl,
        }),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Here are the common REST API uses.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-nav-final-url-reuse-1",
      result: {
        url: finalUrl,
        finalUrl,
        status: 200,
        title: "What is a REST API? Benefits, uses, examples",
        textSnippet:
          "A REST API uses HTTP requests to access and use data. REST APIs are also referred to as RESTful web services.",
        fallbackChain: [
          {
            toolName: "browser.navigate",
            engineTier: "builtin",
            engineLabel: "Built-in browser",
            status: "failed",
            url: "https://blog.postman.com/rest-api-examples/",
            finalUrl: "https://blog.postman.com/rest-api-examples/",
            httpStatus: 403,
            browserFailureClass: "remote_blocked",
            error: "remote site blocked automation (automation block 403)",
          },
          {
            toolName: "browser.navigate",
            engineTier: "builtin",
            engineLabel: "Built-in browser",
            status: "executed",
            url: finalUrl,
            finalUrl,
            httpStatus: 200,
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-nav-final-url-reuse-1",
      turnId: "turn-nav-final-url-reuse-1",
      userMessageId: "msg-nav-final-url-reuse-1",
      content: "Search the web for the top 5 uses for REST APIs.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search the web for the top 5 uses for REST APIs." }],
    });

    expect(result.turnTrace.failure).toBeUndefined();
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(result.turnTrace.toolRuns[1]?.result).toMatchObject({
      reusedResult: true,
      reusedPriorToolRunId: result.turnTrace.toolRuns[0]?.toolRunId,
    });
  });

  it("reuses an immediate browser.extract call from the same successful browser.navigate result", async () => {
    const pageUrl = "https://example.com/research";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: pageUrl }))
      .mockResolvedValueOnce(extractToolCallCompletion({ url: pageUrl, maxChars: 6000 }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Done.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-nav-extract-reuse-1",
      result: {
        url: pageUrl,
        finalUrl: pageUrl,
        status: 200,
        title: "Example research",
        textSnippet:
          "REST APIs are used for backend services, third-party integrations, mobile apps, automation workflows, and partner APIs. This page explains those uses in detail with examples and implementation notes.",
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate", "browser.extract"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-nav-extract-reuse-1",
      turnId: "turn-nav-extract-reuse-1",
      userMessageId: "msg-nav-extract-reuse-1",
      content: "Open the page, then extract the text from that same page.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Open the page, then extract the text from that same page." }],
    });

    expect(result.turnTrace.failure).toBeUndefined();
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(result.turnTrace.toolRuns).toHaveLength(2);
    expect(result.turnTrace.toolRuns[1]?.toolName?.replace(/_/g, ".")).toBe("browser.extract");
    expect(result.turnTrace.toolRuns[1]?.result).toMatchObject({
      reusedResult: true,
      reusedPriorToolRunId: result.turnTrace.toolRuns[0]?.toolRunId,
    });
  });

  it("does not reuse browser.extract when another stateful page open happened in between", async () => {
    const pageUrl = "https://example.com/research";
    const otherUrl = "https://example.com/other";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: pageUrl }))
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: otherUrl }))
      .mockResolvedValueOnce(extractToolCallCompletion({ url: pageUrl, maxChars: 6000 }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Done.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-extract-no-reuse-1",
        result: {
          url: pageUrl,
          finalUrl: pageUrl,
          status: 200,
          title: "Example research",
          textSnippet: "Useful research page content that would otherwise be reusable if nothing changed afterward.",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-extract-no-reuse-2",
        result: {
          url: otherUrl,
          finalUrl: otherUrl,
          status: 200,
          title: "Other page",
          textSnippet: "A different page was opened, so the previous page state is no longer safe to reuse.",
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-nav-extract-no-reuse-3",
        result: {
          url: pageUrl,
          finalUrl: pageUrl,
          status: 200,
          title: "Example research",
          textSnippet: "Freshly extracted text from the original page after another navigation happened.",
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.navigate", "browser.extract"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-nav-extract-no-reuse-1",
      turnId: "turn-nav-extract-no-reuse-1",
      userMessageId: "msg-nav-extract-no-reuse-1",
      content: "Open one page, open another page, then extract the first page again.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Open one page, open another page, then extract the first page again." },
      ],
    });

    expect(result.turnTrace.failure).toBeUndefined();
    expect(invokeTool).toHaveBeenCalledTimes(3);
    expect(result.turnTrace.toolRuns.every((run) => run.result?.reusedResult !== true)).toBe(true);
  });

  it("asks for clarification instead of faking an estimate for ambiguous local-area prompts", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-lonely-area-1",
      turnId: randomUUID(),
      userMessageId: "msg-lonely-area-1",
      content:
        "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
        },
      ],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("answering that responsibly");
    expect(result.assistantContent).toContain("geographic area");
    expect(result.assistantContent).toContain("threshold");
  });

  it("still asks about subjective qualifier when geography is named but definition is ambiguous", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-lonely-seattle-1",
      turnId: randomUUID(),
      userMessageId: "msg-lonely-seattle-1",
      content:
        "Estimate the number of genuinely lonely singles in Seattle by combining demographic data, social indicators, and digital behavior patterns.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Estimate the number of genuinely lonely singles in Seattle by combining demographic data, social indicators, and digital behavior patterns.",
        },
      ],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("answering that responsibly");
    expect(result.assistantContent).toContain("threshold");
    expect(result.assistantContent).not.toContain("geographic area");
  });

  it("does not force clarification when both geography and qualifier are concrete", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I can estimate that for Seattle with stated assumptions.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-seattle-concrete-1",
      turnId: randomUUID(),
      userMessageId: "msg-seattle-concrete-1",
      content:
        "Estimate the number of single adults in Seattle by combining demographic data and digital behavior patterns.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Estimate the number of single adults in Seattle by combining demographic data and digital behavior patterns.",
        },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toContain("Seattle");
  });

  it("does not short-circuit delegated orchestration prompts with the estimate clarification gate", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Synthesized launch plan with the geography gap called out as a blocker.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool,
    });
    const delegatedPrompt = [
      "Delegated role: Synthesizer",
      "Parent objective: Create a business plan and launch plan for iRolled20.",
      "Current step objective: Merge the planner, worker, and reviewer handoffs into a final answer.",
      "Prior handoffs:",
      "Reviewer: Estimate the number of genuinely active local GMs in the area before choosing launch channels.",
      "Produce only the delegated output for this step.",
    ].join("\n\n");

    const result = await orchestrator.run({
      sessionId: "sess-delegated-clarification-1",
      turnId: randomUUID(),
      userMessageId: "msg-delegated-clarification-1",
      content: delegatedPrompt,
      mode: "cowork",
      providerId: "openai-codex",
      model: "gpt-5.5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: delegatedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toContain("Synthesized launch plan");
    expect(result.assistantContent).not.toContain("What geographic area do you mean exactly");
  });

  it("carries clarification context forward instead of searching on a partial follow-up answer", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-lonely-followup-1",
      turnId: randomUUID(),
      userMessageId: "msg-lonely-followup-1",
      content: 'Suburbs generally lonely is defined as "I cry myself to sleep all alone".',
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
        },
        {
          role: "assistant",
          content: [
            "I need a quick clarification before answering that responsibly:",
            "- What geographic area do you mean exactly: city, metro, county, state, or country?",
            "- How are you defining that qualifier — what threshold or criteria should I use?",
            "Once you answer, I can give you a grounded response.",
          ].join("\n"),
        },
      ],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("answering that responsibly");
    expect(result.assistantContent).toContain("geographic area");
    expect(result.assistantContent).not.toContain("threshold");
  });

  it("returns a deterministic settings note for live-data prompts when web mode is off", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-web-off-live-data-1",
      turnId: randomUUID(),
      userMessageId: "msg-web-off-live-data-1",
      content: "What are the latest news headlines about OpenAI today?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What are the latest news headlines about OpenAI today?" }],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("Web is set to Off");
    expect(result.assistantContent).toContain("Auto, Quick, or Deep");
  });

  it("lets Prompt Lab no-tools source-uncertainty prompts answer instead of short-circuiting on web-off", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: no-tools",
      "",
      "## User Task",
      'The user asks for the "latest public guidance" from a government agency, but no web access is available.',
      "",
      "Respond helpfully without inventing quotes, links, or dates. Explain what a trustworthy answer would need and give a short template for what to check.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I cannot verify the latest guidance without live access. A trustworthy answer would need the agency page, publication date, and any update notice.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-web-off-source-uncertainty-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-web-off-source-uncertainty-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "manual",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("cannot verify");
    expect(result.assistantContent).not.toContain("Web is set to Off");
  });

  it("returns a useful no-web guidance template for raw agentic source-uncertainty turns", async () => {
    const prompt = [
      'The user asks for the "latest public guidance" from a government agency, but no web access is available.',
      "",
      "Respond helpfully without inventing quotes, links, or dates. Explain what a trustworthy answer would need and give a short template for what to check.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-raw-agentic-web-off-source-uncertainty-1",
      turnId: randomUUID(),
      userMessageId: "msg-raw-agentic-web-off-source-uncertainty-1",
      content: prompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("A trustworthy answer would need");
    expect(result.assistantContent).toContain("Check template");
    expect(result.assistantContent).not.toContain("Switch Web to Auto");
  });

  it("does not short-circuit cowork prompt-pack planning turns that mention recently added repo functionality", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "",
      "## User Task",
      "Create a short role-labeled plan for how GoatCitadel prompt-pack v2 should test recently added functionality without repeating the old 108-test balance. Keep the sections in the requested role order.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Product",
              "- Focus the slice on new v2-only capabilities instead of re-running the frozen baseline.",
              "",
              "## Architect",
              "- Group tests around recently added retrieval, provenance, and prompt-pack routing behaviors.",
              "",
              "## QA",
              "- Gate the slice on score deltas plus one replay pass for the touched cases.",
              "",
              "## Synthesis",
              "- Start with a narrow v2-only regression slice, then expand only after those tests stabilize.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-recent-internal-1",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-recent-internal-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toContain("## Product");
    expect(result.assistantContent).not.toContain("Web is set to Off");
  });

  it("does not short-circuit chat prompt-pack no-tools runs that mention recently changed local facts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: no-tools",
      "",
      "## User Task",
      "You are given:",
      "- A test failed",
      "- Logs are incomplete",
      "- One config file was recently changed",
      "",
      "Explain:",
      "- most likely causes, ranked",
      "- the weakest assumption in your reasoning",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "1. Config drift is most likely because the only explicitly changed fact is the config file.",
              "2. Incomplete logs could hide a deployment mismatch or stale environment override.",
              "3. A secondary code regression is possible, but the prompt gives less direct evidence for it.",
              "",
              "Weakest assumption: that the recent config change actually touched a runtime-loaded setting rather than an unrelated comment or dead path.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-chat-recent-internal-1",
      turnId: randomUUID(),
      userMessageId: "msg-chat-recent-internal-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("Config drift is most likely");
    expect(result.assistantContent).not.toContain("Web is set to Off");
  });

  it("does not short-circuit code prompt-pack planning turns that only use recent as repo scope", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: no-tools",
      "- This is a Code evaluation. Stay project-bound, concrete, and evidence-backed.",
      "",
      "## User Task",
      "Propose the smallest Prompt Lab rollout slice for the new v2 pack so GoatCitadel can tighten recent feature quality without immediately rerunning the entire v1 baseline.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Findings / Plan",
              "- Start with the v2-only prompts that cover newly added provenance, replay, and focused-pack behavior.",
              "",
              "## Changes",
              "- Add a dedicated v2 target list for those tests instead of touching the full v1 matrix.",
              "",
              "## Validation",
              "- Re-run only the focused slice and compare score deltas before widening scope.",
              "",
              "## Risks",
              "- The slice must stay narrow enough that failures map back to the new work rather than generic baseline noise.",
            ].join("\n"),
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-code-recent-internal-1",
      turnId: randomUUID(),
      userMessageId: "msg-code-recent-internal-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.assistantContent).toContain("## Findings / Plan");
    expect(result.assistantContent).not.toContain("Web is set to Off");
  });

  it("routes Prompt Lab explicit web requirements to browser search without local code search", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: web lookup tools",
      "",
      "## User Task",
      'Use web lookup to answer: "What are two current public safety tips for severe heat?" Provide a short answer, then a "Source used" line.',
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "current public safety tips severe heat",
          maxResults: 5,
        }),
      )
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Stay hydrated and check on vulnerable neighbors.\n\nSource used: public health search result.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-web-1",
      result: {
        query: "current public safety tips severe heat",
        results: [{ title: "Heat safety", url: "https://example.test/heat", snippet: "Drink water." }],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate", "code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-explicit-web-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-explicit-web-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool).toHaveBeenCalled();
    expect(invokeTool.mock.calls.map((call) => call[0].toolName)).toContain("browser.search");
    expect(invokeTool.mock.calls.map((call) => call[0].toolName)).not.toContain("code.search_files");
    expect(result.turnTrace.toolRuns?.map((run) => run.toolName)).not.toContain("code.search_files");
    expect(result.assistantContent).toContain("Source used");
  });

  it("passes the model's own current-hours web query through unmodified on eval turns", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: web lookup tools",
      "",
      "## User Task",
      "Use a web lookup to answer a current-hours question for a named public place of your choice. If the lookup fails, do not retry more than once. Explain the failure and provide a practical next step.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "Use a web lookup to answer a current-hours question for a named public place of your choice",
        }),
      )
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "The public place I checked was the NYPL Stephen A. Schwarzman Building. Verify today's hours on the official NYPL page.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-hours-query-1",
      result: {
        query: "New York Public Library Stephen A. Schwarzman Building hours official",
        results: [
          {
            title: "Stephen A. Schwarzman Building | The New York Public Library",
            url: "https://www.nypl.org/locations/schwarzman",
            snippet: "Hours and location.",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-prompt-lab-current-hours-query-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-current-hours-query-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(["browser.search", "browser_search"]).toContain(String(invokeTool.mock.calls[0]?.[0].toolName ?? ""));
    // Eval-integrity turns never rewrite the model's tool arguments: the
    // vague query is the model's own choice and is what gets scored.
    expect(invokeTool.mock.calls[0]?.[0].args).toMatchObject({
      query: "Use a web lookup to answer a current-hours question for a named public place of your choice",
    });
  });

  it("does not append unrelated recovered URLs when a Prompt Lab answer already has a source-used URL", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: web lookup tools",
      "",
      "## User Task",
      'Use web lookup to answer: "What are two current public safety tips for severe heat?" Provide a short answer, then a "Source used" line.',
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "use" }))
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "Two public safety tips for severe heat:",
                "- Stay in an air-conditioned indoor location as much as possible.",
                "- Drink plenty of fluids.",
                "",
                "Source used: CDC, Protect Yourself From the Dangers of Extreme Heat — https://www.cdc.gov/climate-health/php/resources/protect-yourself-from-the-dangers-of-extreme-heat.html",
              ].join("\n"),
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-source-used-no-noise-1",
      result: {
        query: "CDC severe heat public safety tips official",
        results: [
          { title: "Use Definition", url: "https://www.merriam-webster.com/dictionary/use" },
          {
            title: "Protect Yourself From the Dangers of Extreme Heat",
            url: "https://www.cdc.gov/climate-health/php/resources/protect-yourself-from-the-dangers-of-extreme-heat.html",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-source-used-no-noise-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-source-used-no-noise-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.assistantContent).toContain(
      "https://www.cdc.gov/climate-health/php/resources/protect-yourself-from-the-dangers-of-extreme-heat.html",
    );
    expect(result.assistantContent).not.toContain("merriam-webster.com");
    expect(result.assistantContent).not.toContain("Source URLs:");
  });

  it("does not infer code roles from Cowork harness guardrails on web-only prompts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- For non-trivial everyday tasks, use at least two role-labeled sections chosen from Planner, Researcher, Risk Review, Operator Handoff, or Synthesis.",
      "- Do not default to Coder, Architect, QA, Ops, repo, source-file, or code-review framing unless the user task explicitly asks for software, files, or implementation work.",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: web lookup tools",
      "",
      "## User Task",
      "Use web lookup. Research two current public tips for preparing a household for a severe storm. Keep this focused on household planning. Return a short role-labeled synthesis and cite the source used.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "current public tips household severe storm preparedness official source",
          maxResults: 5,
        }),
      )
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.navigate", {
          url: "https://blocked.example/storm",
        }),
      )
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "## Researcher",
                "- Secure outdoor objects and prepare emergency supplies before conditions worsen.",
                "- Use public alerts to decide when to shelter or evacuate.",
                "",
                "## Synthesis",
                "- Best move: make a basic emergency kit, then monitor the local alert source you cited.",
                "- Source used: Storm safety.",
              ].join("\n"),
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-cowork-web-1",
        result: {
          query: "current public tips household severe storm preparedness official source",
          results: [
            {
              title: "Storm safety",
              url: "https://example.test/storm",
              snippet: "Prepare supplies and follow local alerts.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "failed",
        policyReason: "allowed",
        auditEventId: "audit-prompt-lab-cowork-web-2",
        error: "remote site blocked automation",
        result: null,
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-web-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-web-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.toolRuns?.map((run) => run.toolName)).not.toContain("code.search_files");
    expect(result.assistantContent).toContain("## Researcher");
    expect(result.assistantContent).toContain("## Synthesis");
    expect(result.assistantContent).toContain("Source used: Storm safety.");
    expect(result.assistantContent).not.toContain("Source URLs:");
    expect(result.assistantContent).not.toContain("## Coder");
    expect(result.assistantContent).not.toContain("## Architect");
    expect(result.assistantContent).not.toContain("file-specific evidence");
    expect(result.assistantContent).not.toContain("repo-level claims");
    expect(result.assistantContent).not.toContain("parts of this answer may be incomplete");
    expect(result.assistantContent).not.toContain('Say "keep going"');
  });

  it("passes vague cowork web queries through unmodified without rewriting the model answer into role scaffolds", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: web lookup tools",
      "",
      "## User Task",
      "Use web lookup. Coordinate three roles in this exact order: Researcher, Planner, Risk Review. Decide whether a public outdoor activity is a good idea this weekend in a city of your choice. Cite sources and separate checked facts from inferred judgment.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "Decide whether a public outdoor activity is a good idea this weekend in a city of your choice.",
          maxResults: 5,
        }),
      )
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I found a few sources, but the result needs a structured handoff.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-cowork-web-exact-roles-1",
      result: {
        query: "Seattle this weekend weather forecast outdoor public events parks official",
        results: [
          {
            title: "Seattle Forecast - National Weather Service",
            url: "https://forecast.weather.gov/MapClick.php?lat=47.6&lon=-122.3",
            snippet: "Seattle weekend forecast and conditions from the National Weather Service.",
          },
          {
            title: "Seattle Parks and Recreation events",
            url: "https://www.seattle.gov/parks",
            snippet: "Official Seattle parks information for public outdoor activities.",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-web-exact-roles-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-web-exact-roles-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    // Eval-integrity turns never rewrite the model's tool arguments: even a
    // vague query is the model's own choice and is what gets scored.
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({
        query: "Decide whether a public outdoor activity is a good idea this weekend in a city of your choice.",
      }),
    });
    expect(result.turnTrace.toolRuns?.map((run) => run.toolName)).not.toContain("code.search_files");
    expect(result.assistantContent).toBe("I found a few sources, but the result needs a structured handoff.");
    expect(result.assistantContent).not.toContain("## Sources Used");
    expect(result.assistantContent).not.toContain("Source URLs:");
    expect(result.assistantContent).not.toContain("file-specific evidence");
    expect(result.assistantContent).not.toContain("repo-level claims");
    expect(result.assistantContent).not.toContain("Cannot read properties");
  });

  it("does not expose local file tools to non-code Prompt Lab Cowork web prompts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: web lookup tools",
      "",
      "## User Task",
      "Use web lookup. Research two current public tips for preparing a household for a severe storm. Return a short role-labeled synthesis and cite the source used.",
    ].join("\n");
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      const tools = JSON.stringify(request.tools ?? []);
      expect(tools).toContain("browser_search");
      expect(tools).not.toContain("code_search_files");
      expect(tools).not.toContain("file_read_range");
      return {
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "## Researcher",
                "- Source checked: Ready.gov says to make a household plan and prepare supplies.",
                "",
                "## Synthesis",
                "- Make a household emergency plan and prepare basic supplies before the storm.",
                "- Source used: https://www.ready.gov/plan",
              ].join("\n"),
            },
          },
        ],
      };
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-cowork-web-no-local-tools-1",
      result: {
        query: "household severe storm preparedness tips official source",
        results: [{ title: "Make A Plan", url: "https://www.ready.gov/plan", snippet: "Make a plan." }],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-web-no-local-tools-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-web-no-local-tools-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.toolRuns?.map((run) => run.toolName)).not.toContain("code.search_files");
    expect(result.turnTrace.toolRuns?.map((run) => run.toolName)).not.toContain("file.read_range");
    expect(result.assistantContent).toContain("https://www.ready.gov/plan");
    expect(result.assistantContent).not.toContain("file-specific evidence");
  });

  it("does not expose local file tools to non-code Prompt Lab Cowork tool-choice prompts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: implicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- For non-trivial everyday tasks, use at least two role-labeled sections chosen from Planner, Researcher, Risk Review, Operator Handoff, or Synthesis.",
      "- Do not mention repo paths, source files, tool traces, local-file evidence, or repository-wide claims unless the user explicitly asks for local file, code, or repository inspection.",
      "",
      "## User Task",
      'Cowork request: "Help me decide between two possible names for a local discussion club: Open Table and Friday Circle."',
      "",
      "Use tools only if useful. Keep the response as a coordinated decision aid with criteria, a recommendation, and what would change the answer.",
    ].join("\n");
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      const tools = JSON.stringify(request.tools ?? []);
      expect(tools).not.toContain("code_search_files");
      expect(tools).not.toContain("code_search");
      expect(tools).not.toContain("file_read_range");
      return {
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "## Planner",
                "- Criteria: warmth, clarity, flexibility, memorability, and fit with the club's tone.",
                "",
                "## Operator Handoff",
                "- Recommendation: Open Table, unless the Friday ritual is central to the group identity.",
              ].join("\n"),
            },
          },
        ],
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () =>
        createToolCatalog(["memory.search", "code.search_files", "code.search", "file.read_range"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-tool-choice-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-tool-choice-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.toolRuns?.map((run) => run.toolName) ?? []).not.toContain("code.search_files");
    expect(result.assistantContent).toContain("## Planner");
    expect(result.assistantContent).toContain("## Operator Handoff");
    expect(result.assistantContent).not.toContain("file-specific evidence");
  });

  it("preserves substantive delegated Cowork reports instead of replacing them with role scaffolds", async () => {
    const delegatedPrompt = [
      "Delegated role: synthesizer",
      "",
      "Parent objective: I want you to research the best agentic harnesses out there and create a report that shows the pros and cons of each",
      "",
      "Plan summary: Research and synthesize a comparative report on leading agentic harnesses.",
      "",
      "Prior handoffs:",
      "Researcher (completed): LangGraph, AutoGen, CrewAI, LlamaIndex, Semantic Kernel, Haystack, PydanticAI, and managed cloud agents were assessed.",
      "Critic (completed): Caveat freshness and source coverage.",
      "",
      "Produce only the delegated output for this step. Be concrete, cite evidence when available, and name any blocking issue explicitly.",
    ].join("\n");
    const report = [
      "# Report: Best Agentic Harnesses",
      "",
      "## Executive summary",
      "- Best overall production harness: LangGraph.",
      "- Best RAG-heavy option: LlamaIndex or Haystack.",
      "- Best multi-agent experimentation option: AutoGen.",
      "",
      "## Comparison table",
      "| Harness | Pros | Cons |",
      "| --- | --- | --- |",
      "| LangGraph | Stateful workflows and human-in-the-loop control | More engineering overhead |",
      "| CrewAI | Fast role/task prototypes | Less control for production state |",
      "| AutoGen | Strong multi-agent conversation model | Harder to make deterministic |",
      "",
      "## Bottom line",
      "Start with LangGraph unless RAG, Microsoft enterprise fit, or managed cloud alignment is the main constraint.",
    ].join("\n");
    const createChatCompletion = vi.fn(
      async (): Promise<ChatCompletionResponse> => ({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: report,
            },
          },
        ],
      }),
    );
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-cowork-delegated-report",
      turnId: randomUUID(),
      userMessageId: "msg-cowork-delegated-report",
      content: delegatedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: delegatedPrompt }],
    });

    expect(result.assistantContent).toContain("# Report: Best Agentic Harnesses");
    expect(result.assistantContent).toContain("LangGraph");
    expect(result.assistantContent).not.toContain("No file-specific evidence was retained");
    expect(result.assistantContent).not.toContain("repo-level claims as unknown");
    expect(result.turnTrace.completion?.repair?.kind).not.toBe("cowork_contract_normalization");
  });

  it("keeps non-code Prompt Lab memory-only prompts from seeing local file tools", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: memory tools",
      "",
      "## User Task",
      "Use memory tools only to inspect whether there are stored planning preferences relevant to travel or scheduling. Do not create or update memory. Then produce a Cowork-style planning handoff that says exactly what memory was or was not used.",
    ].join("\n");
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      const tools = JSON.stringify(request.tools ?? []);
      expect(tools).toContain("memory_search");
      expect(tools).not.toContain("code_search_files");
      expect(tools).not.toContain("file_read_range");
      return {
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "## Researcher\n- Memory inspected: no relevant travel or scheduling preference was found.\n\n## Operator Handoff\n- Planning should proceed from the current request only.",
            },
          },
        ],
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () =>
        createToolCatalog(["memory.search", "memory.read", "code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-memory-only-no-local-tools-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-memory-only-no-local-tools-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.toolRuns?.map((run) => run.toolName) ?? []).not.toContain("code.search_files");
    expect(result.assistantContent).toContain("Memory inspected");
    expect(result.assistantContent).not.toContain("read range failed");
  });

  it("prefetches memory for raw agentic memory-tools-only Cowork prompts", async () => {
    const prompt =
      "Use memory tools only to inspect whether there are stored planning preferences relevant to travel or scheduling. Do not create or update memory. Then produce a Cowork-style planning handoff that says exactly what memory was or was not used.";
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "## Researcher\n- Memory inspected: no relevant travel or scheduling preference was found.\n\n## Operator Handoff\n- Memory used: none.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-memory-planning-prefetch-1",
      result: {
        memories: [],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["memory.search", "memory.read"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-raw-cowork-memory-only-1",
      turnId: randomUUID(),
      userMessageId: "msg-raw-cowork-memory-only-1",
      content: prompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: prompt }],
    });

    expect(invokeTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "memory.search" }));
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          query: "travel scheduling planning preferences dates availability itinerary constraints",
        }),
      }),
    );
    expect(result.turnTrace.toolRuns.map((run) => run.toolName)).toContain("memory.search");
    expect(result.assistantContent).toContain("Memory inspected");
  });

  it("does not prefetch memory searches for Prompt Lab memory preference prompts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: memory tools",
      "",
      "## User Task",
      "Use available memory tools only to inspect whether there is already a stored preference about answer length. Do not create or update any memory. Then tell the user what you found and what you would need before storing a new preference.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I used memory.search with an answer-length preference query and found no stored preference. I did not create or update memory.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-memory-answer-length-prefetch-1",
      result: { memories: [] },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["memory.search", "memory.read"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-answer-length-memory-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-answer-length-memory-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns ?? []).toHaveLength(0);
    expect(result.assistantContent).toContain("answer-length preference");
    expect(result.assistantContent).toContain("I did not create or update memory.");
  });

  it("does not prefetch session status for Prompt Lab Cowork planning-tool approval prompts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "",
      "## User Task",
      "Use available planning tools if present, but do not send messages, submit forms, or make reservations. Create a three-phase plan for organizing a small volunteer orientation and pause at the approval checkpoint.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "## Planner\n- Phase 1 - Prepare.\n- Phase 2 - Draft.\n- Phase 3 - Run after approval only.\n\n## Operator Handoff\n- Approval checkpoint: stop here.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-session-status-planning-prefetch-1",
      result: {
        status: "active",
        approvals: [],
        activePlan: null,
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["session.status", "code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-planning-status-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-planning-status-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns ?? []).toHaveLength(0);
    expect(result.assistantContent).toContain("Approval checkpoint: stop here.");
  });

  it("keeps delegated Prompt Lab Cowork web turns from honoring suggested local code tools", async () => {
    const delegatedPrompt = [
      "Delegated role: Researcher",
      "Parent objective: Use web lookup to decide whether a public outdoor activity is a good idea this weekend.",
      "Current step objective: Check current public conditions and cite sources.",
      "Suggested tools: code.search_files, browser.search",
      "Produce only the delegated output for this step.",
    ].join("\n\n");
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      const tools = JSON.stringify(request.tools ?? []);
      expect(tools).toContain("browser_search");
      expect(tools).not.toContain("code_search_files");
      expect(tools).not.toContain("file_read_range");
      return {
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Researcher\n- Checked source: National Weather Service.\n- Source: https://www.weather.gov/",
            },
          },
        ],
      };
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-delegated-web-no-local-tools-1",
      result: {
        query: "public outdoor activity this weekend weather official source",
        results: [{ title: "National Weather Service", url: "https://www.weather.gov/", snippet: "Weather." }],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-delegated-cowork-web-no-local-tools-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-delegated-cowork-web-no-local-tools-1",
      content: delegatedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: delegatedPrompt }],
    });

    expect(result.turnTrace.toolRuns?.map((run) => run.toolName)).not.toContain("code.search_files");
    expect(result.turnTrace.toolRuns?.map((run) => run.toolName)).not.toContain("file.read_range");
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("National Weather Service");
  });

  it("suppresses suggested local code tools on raw delegated non-code Cowork turns", async () => {
    const delegatedPrompt = [
      "Delegated role: Researcher",
      "Parent objective: Use memory tools only to inspect planning preferences relevant to travel or scheduling.",
      "Current step objective: Search memory and report provenance.",
      "Suggested tools: code.search_files, memory.search",
      "Produce only the delegated output for this step.",
    ].join("\n\n");
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      const tools = JSON.stringify(request.tools ?? []);
      expect(tools).toContain("memory_search");
      expect(tools).not.toContain("code_search_files");
      expect(tools).not.toContain("file_read_range");
      return {
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Researcher\n- Memory provenance: no relevant travel or scheduling preference was found.",
            },
          },
        ],
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["memory.search", "code.search_files", "file.read_range"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-raw-delegated-cowork-memory-no-local-tools-1",
      turnId: randomUUID(),
      userMessageId: "msg-raw-delegated-cowork-memory-no-local-tools-1",
      content: delegatedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: delegatedPrompt }],
    });

    expect(result.turnTrace.toolRuns?.map((run) => run.toolName) ?? []).not.toContain("code.search_files");
    expect(result.assistantContent).toContain("Memory provenance");
  });

  it("passes non-code Prompt Lab Cowork answers through without deterministic everyday-planning repair", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "",
      "## User Task",
      'Cowork request: "This may take longer than one turn. Structure a durable work plan for comparing three apartment options later."',
      "",
      "No tools are available. Produce a resumable plan with phases, saved assumptions, and the exact next question to ask when work resumes.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "## Researcher",
              "- Evidence: No file-specific evidence was retained from the tool trace.",
              "- Search scope: No explicit search scope was retained.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Continue only with the captured evidence and label any repo-level claims as unknown.",
              "",
              "## Synthesis",
              "- Evidence: No file-specific evidence was retained from the tool trace.",
              "- Constraints: No blocking tool failures recorded.",
              "- Workarounds: Combine the cited evidence into the best current recommendation and flag remaining gaps explicitly.",
            ].join("\n"),
          },
        },
      ],
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search_files"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-everyday-repair-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-everyday-repair-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "manual",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(result.turnTrace.toolRuns ?? []).toHaveLength(0);
    expect(result.assistantContent).toContain("No file-specific evidence was retained from the tool trace.");
    expect(result.assistantContent).not.toContain("Phase 1");
    expect(result.assistantContent).not.toContain("Saved assumptions");
    expect(result.assistantContent).not.toContain("Resume question");
  });

  it("does not append web citation URLs to Prompt Lab source-conflict answers", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: explicit-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: web lookup tools",
      "",
      "## User Task",
      "Use web lookup to compare public information about whether a city service is available on a holiday. If sources conflict, preserve the conflict in the handoff instead of smoothing it away.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("browser.search", { query: "city service holiday availability" }))
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "## Researcher",
                "- NYC311 and DSNY appear to be the relevant public sources for NYC collection schedules.",
                "",
                "## Operator Handoff",
                "- If NYC311 and DSNY differ for a date/address, preserve the conflict and verify with the agency.",
                "",
                "Source URLs:",
                "- NYC Garbage Collection Schedule 2026: https://mygarbagecollection.com/nyc-garbage-collection-schedule/",
              ].join("\n"),
            },
          },
        ],
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-cowork-web-citation-filter-1",
      result: {
        query: "NYC DSNY holiday schedule NYC311 trash recycling compost collection holiday",
        results: [
          { title: "Look Up Service Requests - NYC311", url: "https://portal.311.nyc.gov/check-status/" },
          { title: "User account result", url: "https://user.com/not-a-source" },
          { title: "User docs result", url: "https://docs.user.com/not-a-source" },
          { title: "MyLA311 - City of Los Angeles", url: "https://lacity.gov/myla311" },
          { title: "311 City Services - City of Chicago", url: "https://www.chicago.gov/city/en/depts/311.html" },
          {
            title: "Holiday Schedule - DSNY - NYC.gov",
            url: "https://www.nyc.gov/site/dsny/collection/residents/holiday-schedule.page",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-web-citation-filter-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-web-citation-filter-1",
      content: wrappedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    // Eval-integrity turns never rewrite the model's tool arguments.
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({
        query: "city service holiday availability",
      }),
    });
    expect(result.assistantContent).toContain("https://mygarbagecollection.com/nyc-garbage-collection-schedule/");
    expect(result.assistantContent.match(/Source URLs:/g)).toHaveLength(1);
    expect(result.assistantContent).not.toContain("https://portal.311.nyc.gov/check-status/");
    expect(result.assistantContent).not.toContain(
      "https://www.nyc.gov/site/dsny/collection/residents/holiday-schedule.page",
    );
    expect(result.assistantContent).not.toContain("https://user.com/not-a-source");
    expect(result.assistantContent).not.toContain("https://docs.user.com/not-a-source");
    expect(result.assistantContent).not.toContain("https://lacity.gov/myla311");
    expect(result.assistantContent).not.toContain("https://www.chicago.gov/city/en/depts/311.html");
    expect((result.turnTrace.citations ?? []).map((citation) => citation.url)).not.toContain(
      "https://docs.user.com/not-a-source",
    );
  });

  it("does not prefetch web evidence for Prompt Lab Chat source-conflict prompts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: web lookup tools",
      "",
      "## User Task",
      "Use web lookup to check whether a public event is still scheduled for this weekend. If two credible sources disagree, say that they disagree and identify which source you would trust more and why.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "I checked a concrete public-event example and would trust the official venue/organizer page over a secondary listing if the two disagree.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-chat-source-conflict-prefetch-1",
      result: {
        query: "Seattle Center official events this weekend schedule",
        results: [{ title: "Seattle Center Events", url: "https://www.seattlecenter.com/events" }],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-chat-source-conflict-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-chat-source-conflict-prefetch-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns ?? []).toHaveLength(0);
    expect(result.assistantContent).toContain("official venue/organizer page");
  });

  it("suppresses all tools for Prompt Lab explicit negative controls", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: chat",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation, but the user task explicitly forbids tool use. Do not call tools.",
      "",
      "## User Task",
      'Tools are available, but the user says: "Please do not look anything up. I only want a quick gut-check based on the details I typed."',
      "",
      "Answer without tools. Give a concise gut-check and clearly label it as non-verified.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        expect(request.tools ?? []).toHaveLength(0);
        return {
          model: "gpt-5.4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  "Non-verified gut-check: based only on what you typed, the plan sounds plausible but incomplete.",
              },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "code.search_files", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-no-lookup-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-no-lookup-1",
      content: wrappedPrompt,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("Non-verified gut-check");
  });

  it("does not prefetch the Mission Control Next prompt-pack workbench for explicit UI inspection prompts", async () => {
    const wrappedPrompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: explicit-tools",
      "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
      "- Required tool families: file/code tools",
      "",
      "## User Task",
      "Use file search and file read tools. Inspect the Mission Control Next prompt-pack workbench component and recommend where a Harness/Agentic segmented control belongs. Do not edit files.",
    ].join("\n");
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "The workbench component is the right UI surface. Place the Harness/Agentic segmented control near the run controls and mirror it in run details.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-prompt-lab-ui-prefetch-1",
      result: {
        path: "apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.tsx",
        startLine: 1,
        endLine: 220,
        content: "export function PromptPacksWorkbenchPage() { return null; }",
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-ui-prefetch-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-ui-prefetch-1",
      content: wrappedPrompt,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [{ role: "user", content: wrappedPrompt }],
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns ?? []).toHaveLength(0);
    expect(result.assistantContent).toContain(
      "Place the Harness/Agentic segmented control near the run controls and mirror it in run details.",
    );
  });

  it("strips web tools from normal turns when web mode is off", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        const toolNames = (request.tools ?? [])
          .map((tool) => (tool.function as { name?: string } | undefined)?.name)
          .filter((name): name is string => Boolean(name));
        expect(toolNames).not.toContain("browser_search");
        expect(toolNames).toContain("time_now");
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Local-only answer.",
              },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-web-off-local-only-1",
      turnId: randomUUID(),
      userMessageId: "msg-web-off-local-only-1",
      content: "Explain HTTP status codes for an internal API.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Explain HTTP status codes for an internal API." }],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("Local-only answer");
  });

  it("returns a deterministic settings note for live-data prompts when tool autonomy is manual", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-manual-live-data-1",
      turnId: randomUUID(),
      userMessageId: "msg-manual-live-data-1",
      content: "Look online and tell me the 5 most interesting things that happened today.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "manual",
      historyMessages: [
        { role: "user", content: "Look online and tell me the 5 most interesting things that happened today." },
      ],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("tool autonomy is set to Manual");
    expect(result.assistantContent).toContain("Safe Auto");
  });

  it("does not trap a fresh standalone prompt in an old clarification exchange", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The capital of France is Paris.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-clarification-reset-1",
      turnId: randomUUID(),
      userMessageId: "msg-clarification-reset-1",
      content: "What is the capital of France?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
        },
        {
          role: "assistant",
          content: [
            "I need a quick clarification before answering that responsibly:",
            "- What geographic area do you mean exactly: city, metro, county, state, or country?",
            "- How are you defining that qualifier — what threshold or criteria should I use?",
            "Once you answer, I can give you a grounded response.",
          ].join("\n"),
        },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("Paris");
  });

  it("ignores stale clarifications once a later assistant turn has moved on", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The capital of France is Paris.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-clarification-reset-2",
      turnId: randomUUID(),
      userMessageId: "msg-clarification-reset-2",
      content: "What is the capital of France?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Estimate the number of genuinely lonely singles in the area by combining demographic data, social indicators, and digital behavior patterns.",
        },
        {
          role: "assistant",
          content: [
            "I need a quick clarification before answering that responsibly:",
            "- What geographic area do you mean exactly: city, metro, county, state, or country?",
            "- How are you defining that qualifier — what threshold or criteria should I use?",
            "Once you answer, I can give you a grounded response.",
          ].join("\n"),
        },
        {
          role: "user",
          content: "Never mind.",
        },
        {
          role: "assistant",
          content: "Okay, we can drop that one.",
        },
      ],
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("Paris");
  });

  it("preserves streamed text parts when later chunks use nested text.value content", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const createChatCompletionStream = vi.fn(async function* () {
      yield {
        id: "chunk_1",
        model: "glm-5",
        choices: [
          {
            index: 0,
            delta: {
              content:
                "I'd be happy to help you find weekend activities! Since it's currently Wednesday, March 11th, you're asking about the upcoming weekend (March 14-15, 2026).\n\nTo give you the best recommendations, I",
            },
          },
        ],
      };
      yield {
        id: "chunk_2",
        model: "glm-5",
        usage: {
          prompt_tokens: 1140,
          completion_tokens: 191,
        },
        choices: [
          {
            index: 0,
            delta: {
              content: [
                {
                  type: "output_text",
                  text: {
                    value:
                      " need a bit more information about your location and interests before I suggest specific plans.",
                  },
                },
              ],
            },
          },
        ],
      };
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      createChatCompletionStream,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-streamed-parts-1",
      turnId: randomUUID(),
      userMessageId: "msg-streamed-parts-1",
      content: "Help me plan something fun.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Help me plan something fun." }],
    });

    expect(createChatCompletionStream).toHaveBeenCalledTimes(1);
    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("To give you the best recommendations, I need a bit more information");
    expect(result.assistantContent).toContain("location and interests");
  });

  it("uses the bounded per-mode completion timeout, not the provider default", async () => {
    let capturedTimeoutMs: number | undefined;
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementation(async (request: ChatCompletionRequest) => {
        capturedTimeoutMs = request.timeoutMs;
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Synthesized answer from tool output.",
              },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-synthesis-timeout-1",
      result: {
        results: [{ title: "Result", url: "https://example.com/synth" }],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    await orchestrator.run({
      sessionId: "sess-synth-timeout-1",
      turnId: randomUUID(),
      userMessageId: "msg-synth-timeout-1",
      content: "Search the web for AI tooling references",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search the web for AI tooling references" }],
    });

    // The bounded per-mode completion timeout is passed through to the provider
    // call instead of the provider's own default. This is a chat/auto turn with
    // no live-data intent, so it resolves to the default-mode completion budget.
    expect(capturedTimeoutMs).toBeDefined();
    expect(capturedTimeoutMs).toBe(CHAT_COMPLETION_TIMEOUT_MS_BY_MODE.default);
  });

  it("stops alternate-URL retries when the turn budget expires mid-fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T20:00:00.000Z"));
    try {
      let navigateCallCount = 0;
      const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockImplementation(async () => {
        vi.setSystemTime(new Date(Date.now() + 5000));
        return navigateToolCallCompletion({
          url: "https://blocked-site.com/article",
        });
      });
      const invokeTool = vi
        .fn<() => Promise<ToolInvokeResult>>()
        .mockImplementationOnce(async () => {
          vi.setSystemTime(new Date(Date.now() + 2000));
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-budget-search",
            result: {
              results: [
                { title: "Site A", url: "https://blocked-site.com/article", snippet: "news" },
                { title: "Site B", url: "https://alt1.com/article", snippet: "more news" },
                { title: "Site C", url: "https://alt2.com/article", snippet: "even more" },
              ],
            },
          };
        })
        .mockImplementation(async () => {
          navigateCallCount += 1;
          // Each navigate takes 20s, eating deep into budget.
          vi.setSystemTime(new Date(Date.now() + 20000));
          return {
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: `audit-budget-nav-${navigateCallCount}`,
            result: {
              url: "https://blocked-site.com/article",
              finalUrl: "https://blocked-site.com/article",
              status: 403,
              title: "Blocked",
              textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
            },
          };
        });
      const orchestrator = new ChatTurnAgentRunner({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
        createChatCompletion,
        invokeTool,
      });

      const result = await orchestrator.run({
        sessionId: "sess-budget-alt-retry-1",
        turnId: randomUUID(),
        userMessageId: "msg-budget-alt-retry-1",
        content: "What's the latest news today?",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "auto",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
        historyMessages: [{ role: "user", content: "What's the latest news today?" }],
      });

      // The alternate retry loop should NOT try all 3 URLs (2 alternates) since
      // the budget deadline is hit. We expect fewer navigate calls than the
      // maximum possible (1 original + 2 alternates = 3 total).
      const totalNavigateCalls = (invokeTool.mock.calls as unknown as Array<[{ toolName: string }]>).filter(
        (call) => call[0].toolName === "browser.navigate",
      ).length;
      // At least 1 navigate was attempted (the original), but not all 3.
      expect(totalNavigateCalls).toBeLessThan(3);
      expect(result.turnTrace.status).not.toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("poisons hosts from fallback chain entries in executed runs recovered via MCP", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://blocked-host.com/page2" }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Here is what I found.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-poison-search",
        result: {
          results: [
            { title: "Good article", url: "https://blocked-host.com/page1", snippet: "news" },
            { title: "Backup article", url: "https://blocked-host.com/page2", snippet: "more" },
            { title: "Clean article", url: "https://clean-host.com/page1", snippet: "other" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-poison-navigate",
        result: {
          url: "https://blocked-host.com/page1",
          finalUrl: "https://blocked-host.com/page1",
          status: 403,
          title: "Blocked",
          textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
          // Simulates a run that was classified as blocked but recovered via MCP fallback.
          // After recovery the run status is "executed" but the fallback chain records the block.
          fallbackChain: [
            {
              toolName: "browser.navigate",
              engineTier: "builtin",
              engineLabel: "Built-in browser",
              status: "failed",
              browserFailureClass: "remote_blocked",
              url: "https://blocked-host.com/page1",
              finalUrl: "https://blocked-host.com/page1",
            },
            {
              toolName: "mcp_navigate",
              engineTier: "premium",
              engineLabel: "Premium browser",
              status: "executed",
              url: "https://blocked-host.com/page1",
              finalUrl: "https://blocked-host.com/page1",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-poison-navigate-2",
        result: {
          url: "https://clean-host.com/page1",
          finalUrl: "https://clean-host.com/page1",
          status: 200,
          title: "Clean article",
          textSnippet: "This article has useful content about the topic.",
        },
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-poison-chain-1",
      turnId: randomUUID(),
      userMessageId: "msg-poison-chain-1",
      content: "What's the latest news today?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What's the latest news today?" }],
    });

    // The second navigate call should NOT use blocked-host.com/page2 because
    // blocked-host.com should be poisoned from the fallback chain of the first navigate.
    // It should instead use clean-host.com.
    const navigateCalls = (
      invokeTool.mock.calls as unknown as Array<[{ toolName: string; args: Record<string, unknown> }]>
    )
      .map((call) => call[0])
      .filter((arg) => arg.toolName === "browser.navigate");
    if (navigateCalls.length >= 2) {
      expect(String(navigateCalls[1]!.args.url)).not.toContain("blocked-host.com");
    }
    expect(result.turnTrace.status).not.toBe("running");
  });

  it("passes abort signal to main loop LLM completion calls", async () => {
    const controller = new AbortController();
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementation(async (request) => {
        // Capture the signal from the first completion request, then abort.
        if (request.signal) {
          controller.abort();
        }
        // Simulate an abort error since the signal is now aborted.
        if (request.signal?.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return {
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Final answer" },
            },
          ],
        };
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-signal-1",
      result: { results: [{ title: "R", url: "https://example.com" }] },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-signal-1",
      turnId: randomUUID(),
      userMessageId: "msg-signal-1",
      content: "Find AI references",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Find AI references" }],
      signal: controller.signal,
    });

    // The completion was called with the signal present.
    expect(createChatCompletion.mock.calls.length).toBeGreaterThanOrEqual(1);
    const firstCall = createChatCompletion.mock.calls[0]?.[0] as ChatCompletionRequest | undefined;
    expect(firstCall?.signal).toBe(controller.signal);
    // Turn should be cancelled since the signal was aborted.
    expect(result.turnTrace.status).toBe("cancelled");
  });

  it("passes prompt-lab OpenAI reasoning controls for cowork runs", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Researcher: risk is concentrated in migrations.\n\nArchitect: phase the rollout.\n\nSynthesis: keep the cutover staged.",
          },
        },
      ],
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });
    const content = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: no-tools",
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
      "",
      "## User Task",
      "Assess the migration risk and recommend a rollout plan.",
    ].join("\n");

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-cowork-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-cowork-1",
      content,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content }],
    });

    expect(result.turnTrace.status).toBe("completed");
    const firstCall = (createChatCompletion.mock.calls as unknown as Array<[ChatCompletionRequest]>)[0]?.[0];
    expect(firstCall?.reasoning).toEqual({ effort: "high" });
    expect(firstCall?.verbosity).toBe("medium");
  });

  it("passes prompt-lab OpenAI reasoning controls for code runs", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Plan: inspect the repo.\n\nChanges: update the config.\n\nValidation: run the tests.\n\nRisks: watch for regressions.",
          },
        },
      ],
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });
    const content = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: no-tools",
      "- This is a Code evaluation. Stay project-bound, concrete, and evidence-backed.",
      "",
      "## User Task",
      "Inspect the config surface and propose the smallest fix.",
    ].join("\n");

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-code-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-code-1",
      content,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4-mini",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content }],
    });

    expect(result.turnTrace.status).toBe("completed");
    const firstCall = (createChatCompletion.mock.calls as unknown as Array<[ChatCompletionRequest]>)[0]?.[0];
    expect(firstCall?.reasoning).toEqual({ effort: "medium" });
    expect(firstCall?.verbosity).toBe("low");
  });

  it("preserves OpenAI reasoning controls on tool-enabled turns", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I should inspect the files first.",
          },
        },
      ],
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });
    const content = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "- This is a Code evaluation. Stay project-bound, concrete, and evidence-backed.",
      "",
      "## User Task",
      "Inspect the config surface and propose the smallest fix.",
    ].join("\n");

    const result = await orchestrator.run({
      sessionId: "sess-prompt-lab-code-tools-1",
      turnId: randomUUID(),
      userMessageId: "msg-prompt-lab-code-tools-1",
      content,
      mode: "code",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content }],
    });

    expect(result.turnTrace.status).toBe("completed");
    const firstCall = (createChatCompletion.mock.calls as unknown as Array<[ChatCompletionRequest]>)[0]?.[0];
    expect(firstCall?.reasoning).toEqual({ effort: "high" });
    expect(firstCall?.verbosity).toBe("medium");
  });

  it("continues MCP fallback tiers when one tier throws instead of returning", async () => {
    let mcpInvokeCallCount = 0;
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://blocked-site.com/page" }))
      .mockResolvedValue({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "Here is the answer." } }],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-mcp-throw-search",
        result: {
          results: [{ title: "Article", url: "https://blocked-site.com/page", snippet: "news" }],
        },
      })
      .mockResolvedValue({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-mcp-throw-nav",
        result: {
          url: "https://blocked-site.com/page",
          finalUrl: "https://blocked-site.com/page",
          status: 403,
          title: "Blocked",
          textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
        },
      });
    const invokeMcpTool = vi
      .fn<(request: McpInvokeRequest) => Promise<McpInvokeResponse>>()
      .mockImplementation(async () => {
        mcpInvokeCallCount += 1;
        if (mcpInvokeCallCount === 1) {
          throw new Error("MCP server removed unexpectedly.");
        }
        return {
          ok: true,
          output: {
            contentText: "This is the article content from the second MCP tier.",
          },
        };
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
      invokeMcpTool,
      listMcpBrowserFallbackTargets: () => [
        {
          serverId: "srv-broken",
          label: "Broken MCP",
          tier: "playwright_mcp" as const,
          navigateToolName: "mcp_navigate",
        },
        { serverId: "srv-good", label: "Good MCP", tier: "browser_mcp" as const, navigateToolName: "mcp_navigate" },
      ],
    });

    const result = await orchestrator.run({
      sessionId: "sess-mcp-throw-1",
      turnId: randomUUID(),
      userMessageId: "msg-mcp-throw-1",
      content: "What's the latest news today?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What's the latest news today?" }],
    });

    // Both MCP tiers should be attempted: first throws, second succeeds.
    expect(mcpInvokeCallCount).toBe(2);
    expect(result.turnTrace.status).not.toBe("running");
  });

  it("stops alternate-URL retries when abort signal fires mid-fallback", async () => {
    const controller = new AbortController();
    let navigateCallCount = 0;
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(navigateToolCallCompletion({ url: "https://site-a.com/page" }))
      .mockResolvedValue({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: "Done." } }],
      });
    const invokeTool = vi
      .fn<() => Promise<ToolInvokeResult>>()
      // Pre-loop synthetic search with alternate URLs.
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-abort-search",
        result: {
          results: [
            { title: "Site A", url: "https://site-a.com/page", snippet: "news" },
            { title: "Site B", url: "https://alt-b.com/page", snippet: "more" },
            { title: "Site C", url: "https://alt-c.com/page", snippet: "even more" },
          ],
        },
      })
      .mockImplementation(async () => {
        navigateCallCount += 1;
        // After first navigate attempt, fire the abort signal.
        if (navigateCallCount >= 1) {
          controller.abort();
        }
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: `audit-abort-nav-${navigateCallCount}`,
          result: {
            url: "https://site-a.com/page",
            finalUrl: "https://site-a.com/page",
            status: 403,
            title: "Blocked",
            textSnippet: "Sorry, you have been blocked. Cloudflare Ray ID.",
          },
        };
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "browser.navigate"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-abort-alt-1",
      turnId: randomUUID(),
      userMessageId: "msg-abort-alt-1",
      content: "What's the latest news today?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What's the latest news today?" }],
      signal: controller.signal,
    });

    // Abort should stop the alternate retry loop. We expect at most 2 navigate
    // calls (original + at most 1 alternate before signal fires) instead of 3.
    const totalNavigateCalls = (invokeTool.mock.calls as unknown as Array<[{ toolName: string }]>).filter(
      (call) => call[0].toolName === "browser.navigate",
    ).length;
    expect(totalNavigateCalls).toBeLessThanOrEqual(2);
    expect(result.turnTrace.status).toBe("cancelled");
  });

  it("promotes a recovered no-tool failure back to completed", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "Adopt event sourcing only if auditability and replay are first-order billing requirements; otherwise keep the current model and add targeted ledger controls.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-recover-no-tools-1",
      turnId: randomUUID(),
      userMessageId: "msg-recover-no-tools-1",
      content: "Assess whether to adopt event sourcing for a billing system. Include one final recommendation.",
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [
        {
          role: "user",
          content: "Assess whether to adopt event sourcing for a billing system. Include one final recommendation.",
        },
      ],
    });

    expect(result.assistantContent).toContain(
      "Adopt event sourcing only if auditability and replay are first-order billing requirements",
    );
    expect(result.assistantContent).not.toContain("This turn failed before completion.");
    expect(result.turnTrace.status).toBe("completed");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("repairs hallucinated continuation references in standalone no-tool answers", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: [
                "If Kubernetes is still the right answer, treat the nine workstreams above as your migration backlog.",
                "Sequence them in the order listed within each lens and do not begin cutover until each workstream above has a verified deliverable.",
              ].join(" "),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "Recommendation: stay on Heroku unless you need Kubernetes-specific controls that clearly outweigh platform simplicity.",
                "Evaluate the move across three lenses:",
                "1. Delivery risk: cluster operations, deployment safety, and staffing overhead increase immediately.",
                "2. Operational burden: observability, patching, scaling policy, and incident ownership move onto your team.",
                "3. Rollback readiness: you need rehearsed rollback drills, migration checkpoints, and database escape hatches before cutover.",
              ].join("\n"),
            },
          },
        ],
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-broken-standalone-1",
      turnId: randomUUID(),
      userMessageId: "msg-broken-standalone-1",
      content:
        "Evaluate whether a team should move from Heroku to Kubernetes across delivery risk, operational burden, and rollback readiness, then give one recommendation.",
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [
        {
          role: "user",
          content:
            "Evaluate whether a team should move from Heroku to Kubernetes across delivery risk, operational burden, and rollback readiness, then give one recommendation.",
        },
      ],
    });

    expect(result.assistantContent).toContain(
      "Recommendation: stay on Heroku unless you need Kubernetes-specific controls",
    );
    expect(result.assistantContent).not.toContain("nine workstreams above");
    expect(result.turnTrace.status).toBe("completed");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("repairs structured answers that end mid-clause despite a stop finish reason", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: [
                "# Migration Recommendation",
                "",
                "## Assumptions",
                "",
                "| # | Assumption | Impact if wrong |",
                "|---|---|---|",
                "| A1 | Existing Sentry SDKs are recent | Older SDKs may need migration work |",
                "| A2 | The team can run Docker or Kubernetes | Managed hosting cost changes the math |",
                "",
                "## Technical Feasibility",
                "",
                "- **GlitchTip**: near-zero SDK migration path for error tracking.",
                "- **Grafana Loki + Tempo**: add OpenTelemetry during parallel run;",
              ].join("\n"),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "# Migration Recommendation",
                "",
                "Use GlitchTip first for Sentry-compatible error tracking, then add Loki + Tempo if you need broader observability.",
                "",
                "Next step: run GlitchTip in parallel for two weeks, compare error capture coverage, and only then decide whether to add Loki + Tempo.",
              ].join("\n"),
            },
          },
        ],
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-fragmentary-stop-1",
      turnId: randomUUID(),
      userMessageId: "msg-fragmentary-stop-1",
      content: "Recommend an open-source replacement for Sentry and explain the migration path.",
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [
        {
          role: "user",
          content: "Recommend an open-source replacement for Sentry and explain the migration path.",
        },
      ],
    });

    expect(result.assistantContent).toContain("Use GlitchTip first for Sentry-compatible error tracking");
    expect(result.assistantContent).not.toContain("during parallel run;");
    expect(result.turnTrace.status).toBe("completed");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("repairs structured answers that end on a hanging markdown bullet", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: [
                "# Migration Recommendation",
                "",
                "## Delivery Risk",
                "",
                "- Heroku lowers platform-operating risk for small teams.",
                "- Kubernetes increases flexibility but raises the number of failure domains.",
                "",
                "## Operational Burden",
                "",
                "- **Cluster lifecycle management**: upgrades, patching, and capacity planning.",
                "- **Observability and incident response**: metrics, logs, traces, and runbooks.",
                "- **People burden",
              ].join("\n"),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "# Migration Recommendation",
                "",
                "Recommendation: stay on Heroku unless you need Kubernetes-specific controls or platform-level compliance guarantees.",
                "",
                "If you do move, staff platform ownership first: upgrades, observability, rollback drills, and security operations all become an ongoing team obligation.",
              ].join("\n"),
            },
          },
        ],
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-fragmentary-bullet-1",
      turnId: randomUUID(),
      userMessageId: "msg-fragmentary-bullet-1",
      content:
        "Evaluate whether a team should move from Heroku to Kubernetes across delivery risk, operational burden, and rollback readiness, then give one recommendation.",
      mode: "cowork",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "extended",
      toolAutonomy: "manual",
      historyMessages: [
        {
          role: "user",
          content:
            "Evaluate whether a team should move from Heroku to Kubernetes across delivery risk, operational burden, and rollback readiness, then give one recommendation.",
        },
      ],
    });

    expect(result.assistantContent).toContain("Recommendation: stay on Heroku");
    expect(result.assistantContent).not.toContain("- **People burden");
    expect(result.turnTrace.status).toBe("completed");
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });
});
