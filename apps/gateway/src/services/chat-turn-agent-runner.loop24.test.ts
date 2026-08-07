import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { PolicyViolationError } from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerDeps, ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  EffectAwareChatTurnAgentRunner as ChatTurnAgentRunner,
  createEffectAwareInvokeToolForTest,
  createExecuteToolCallForTest,
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";
import { presentationSourceId } from "./chat-turn-agent-runner/presentation-research-evidence.js";

const WALKING_RESEARCH = [
  "# Daily Walking",
  "## Health benefits",
  "- Regular walking supports cardiovascular health, mobility, energy, and mood when it becomes a repeatable habit.",
  "- Gradual duration increases help people establish a sustainable routine without unnecessary starting friction.",
  "## Practical routine",
  "- Choose a consistent time, comfortable route, supportive shoes, and a realistic duration that fits the day.",
  "- Track consistency and how the walk feels rather than treating speed as the only sign of progress.",
  "## Safety and progression",
  "- Increase duration gradually, adapt for weather and mobility needs, and seek medical guidance when symptoms make exercise unsafe.",
].join("\n");

const FREE_TIME_RESEARCH = [
  "# Top 10 Things To Do In Free Time",
  "## Active and restorative options",
  "- Walk outdoors, exercise, read, cook, learn a skill, make art, volunteer, call a friend, explore locally, and rest deliberately.",
  "## Choosing well",
  "- Match the activity to available time, energy, budget, weather, and whether solitude or company would feel restorative.",
  "- Rotate familiar favorites with low-risk experiments and notice which activities improve energy afterward.",
  "## Making it repeatable",
  "- Keep a short menu of low-friction choices, schedule ambitious options, and review what actually felt worthwhile.",
].join("\n");

const CCG_EVIDENCE = [
  ["magic", "Magic: The Gathering products", "https://magic.wizards.com/en/products", "official"],
  ["pokemon", "Pokémon Trading Card Game", "https://www.pokemon.com/us/pokemon-tcg/", "official"],
  ["yugioh", "Yu-Gi-Oh! Card Game", "https://www.yugioh-card.com/en/", "official"],
  ["one-piece", "One Piece Card Game", "https://en.onepiece-cardgame.com/", "official"],
  ["lorcana", "Disney Lorcana", "https://www.disneylorcana.com/en-US/", "official"],
  ["fab", "Flesh and Blood TCG", "https://fabtcg.com/", "official"],
  ["swu", "Star Wars: Unlimited", "https://starwarsunlimited.com/", "official"],
  ["riftbound", "Riftbound TCG", "https://riftbound.leagueoflegends.com/", "official"],
  ["gundam", "Gundam Card Game", "https://www.gundam-gcg.com/en/", "official"],
  ["tcgplayer", "CCG marketplace signals", "https://www.tcgplayer.com/content/ccg-market", "marketplace"],
  ["icv2", "North American hobby market", "https://icv2.com/articles/markets/view/ccg-market", "independent"],
  ["retailer", "Retail inventory considerations", "https://starcitygames.com/articles/ccg-retail", "retailer"],
] as const;

describe("ChatTurnAgentRunner loop 24 coverage", () => {
  it("repairs content-filter interrupted direct completions through the repair pass", async () => {
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            finish_reason: "content_filter",
            message: {
              role: "assistant",
              content: "Partial filtered draft",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Repaired answer from the existing context.",
            },
          },
        ],
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run(
      turnInput({
        content: "Draft a concise project status summary.",
        historyMessages: [{ role: "user", content: "Draft a concise project status summary." }],
      }),
    );

    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.assistantContent).toBe("Repaired answer from the existing context.");
    expect(result.turnTrace.completion).toMatchObject({
      status: "complete",
      repaired: true,
      repair: expect.objectContaining({
        applied: true,
        kind: "incomplete_truncated_completion",
        source: "orchestrator",
      }),
    });
  });

  it("filters denied and failing tool-access checks out of the provider tool schema", async () => {
    let capturedRequest: ChatCompletionRequest | undefined;
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      capturedRequest = request;
      return completion("Tool access was filtered.");
    });
    const evaluateToolAccess = vi.fn((input: { toolName: string }) => {
      if (input.toolName === "browser.search") {
        throw new Error("policy service unavailable");
      }
      const allowed = input.toolName !== "memory.search";
      return {
        allowed,
        requiresApproval: false,
        reasonCodes: allowed ? [] : ["memory_search_denied"],
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["session.status", "memory.search", "browser.search"]),
      createChatCompletion,
      invokeTool: vi.fn(),
      evaluateToolAccess,
    });

    const result = await orchestrator.run(
      turnInput({
        content: "Use `session.status`, `memory.search`, and `browser.search` if available, then summarize readiness.",
        memoryMode: "on",
        webMode: "auto",
        historyMessages: [
          {
            role: "user",
            content:
              "Use `session.status`, `memory.search`, and `browser.search` if available, then summarize readiness.",
          },
        ],
      }),
    );

    const toolNames = extractRequestToolNames(capturedRequest);
    expect(result.assistantContent).toContain("Tool access was filtered");
    expect(evaluateToolAccess).toHaveBeenCalledWith(expect.objectContaining({ toolName: "memory.search" }));
    expect(evaluateToolAccess).toHaveBeenCalledWith(expect.objectContaining({ toolName: "browser.search" }));
    expect(toolNames).toContain("session_status");
    expect(toolNames).not.toContain("memory_search");
    expect(toolNames).not.toContain("browser_search");
  });

  it("probes presentation access with safe args and creates a PPTX fallback when the model answers with text", async () => {
    let capturedRequest: ChatCompletionRequest | undefined;
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      capturedRequest = request;
      return completion("I can outline the deck, but I did not create a PowerPoint file.");
    });
    const evaluateToolAccess = vi.fn((input: { toolName: string; args?: Record<string, unknown> }) => ({
      allowed: input.toolName !== "presentations.create" || typeof input.args?.path === "string",
      requiresApproval: false,
      reasonCodes: [],
    }));
    const invokeTool = vi.fn(
      async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: {
          path: "F:\\code\\personal-ai\\workspace\\goatcitadel_out\\top-10-things-to-do-in-free-time.pptx",
          bytesWritten: 12345,
          format: "pptx",
          title: request.args.title,
          slideCount: 7,
        },
      }),
    );
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["presentations.create"]),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess,
    });

    const result = await orchestrator.run(
      turnInput({
        mode: "cowork",
        content: "Put all that information into a real PowerPoint presentation.",
        historyMessages: [
          {
            role: "user",
            content: "List the top 10 things to do in free time.",
          },
          { role: "assistant", content: FREE_TIME_RESEARCH },
          { role: "user", content: "Put all that information into a real PowerPoint presentation." },
        ],
      }),
    );

    const presentationProbe = evaluateToolAccess.mock.calls.find(
      ([input]) => input.toolName === "presentations.create",
    )?.[0];
    expect(presentationProbe?.args?.path).toBe("./workspace/goatcitadel_out/tool-access-probe.pptx");
    expect(presentationProbe?.args?.design).toMatchObject({
      mode: "polished",
      skillId: "design-intelligence",
    });
    expect(extractRequestToolNames(capturedRequest)).toContain("presentations_create");
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "presentations.create",
        args: expect.objectContaining({
          path: expect.stringContaining("top-10-things-to-do-in-free-time"),
          title: "Top 10 Things to Do in Free Time",
          design: expect.objectContaining({
            mode: "polished",
            skillId: "design-intelligence",
          }),
        }),
      }),
    );
    expect(result.assistantContent).toContain("Created the PowerPoint presentation artifact");
    expect(result.assistantContent).toContain(".pptx");
  });

  it.each(["presentations.create", "documents.create"])(
    "does not invoke %s or repair completion after a provider timeout",
    async (toolName) => {
      const content =
        toolName === "presentations.create"
          ? "Please do some research on funny jokes and put together a PowerPoint presentation on it."
          : "Please do some research on funny jokes and put together a PDF report on it.";
      const createChatCompletion = vi
        .fn<() => Promise<ChatCompletionResponse>>()
        .mockRejectedValue(new Error("provider timed out waiting for completion"));
      const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
      const orchestrator = new ChatTurnAgentRunner({
        storage: createMockStorage() as never,
        listToolCatalog: () => createToolCatalog([toolName]),
        createChatCompletion,
        invokeTool,
      });

      const result = await orchestrator.run(
        turnInput({
          content,
          webMode: "auto",
          historyMessages: [{ role: "user", content }],
        }),
      );

      expect(result.turnTrace.status).toBe("failed");
      expect(result.turnTrace.failure?.failureClass).toBe("provider_timeout");
      expect(result.turnTrace.completion?.repaired).toBe(false);
      expect(invokeTool).not.toHaveBeenCalled();
      expect(result.turnTrace.toolRuns).toEqual([]);
    },
  );

  it("routes the exact market-research deck prompt through search and rejects a generic uncited deck", async () => {
    const content =
      "Can you please do some market research on CCGs and what makes each one unique and better than the competition? Please put it into a powerpoint deck.";
    const providerRequests: ChatCompletionRequest[] = [];
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        providerRequests.push(request);
        return namedToolCallCompletion("presentations.create", {
          path: "./workspace/goatcitadel_out/ccg-market-comparison.pptx",
          title: "Competitive CCG Landscape",
          slides: [
            {
              title: "Category Differentiators",
              bullets: ["Rules accessibility, collection depth, and organized play shape each game's position."],
            },
            {
              title: "Competitive Strengths",
              bullets: ["Distinct mechanics and intellectual property create different reasons to choose each game."],
            },
            {
              title: "Market Positioning",
              bullets: ["Player communities, release cadence, and retail support reinforce long-term differentiation."],
            },
          ],
        });
      })
      .mockImplementationOnce(async (request) => {
        providerRequests.push(request);
        return completion(
          "I researched the CCG market, preserved the source evidence, and created the PowerPoint presentation.",
        );
      });
    const invokeTool = vi.fn(async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
      if (request.toolName === "browser.search") {
        return {
          outcome: "executed",
          result: {
            results: [
              {
                title: "Magic: The Gathering products",
                url: "https://magic.wizards.com/en/products",
                snippet: "Official product information documents Magic's releases and gameplay offerings.",
              },
              {
                title: "Pokémon Trading Card Game",
                url: "https://www.pokemon.com/us/pokemon-tcg/",
                snippet: "Official product information documents Pokémon TCG play, products, and community support.",
              },
            ],
          },
        };
      }
      return {
        outcome: "executed",
        result: {
          path: "F:\\code\\personal-ai\\workspace\\goatcitadel_out\\ccg-market-comparison.pptx",
          bytesWritten: 24_000,
          format: "pptx",
          title: request.args.title,
          slideCount: 4,
        },
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "presentations.create"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run(
      turnInput({
        content,
        webMode: "quick",
        historyMessages: [{ role: "user", content }],
      }),
    );

    expect(invokeTool.mock.calls.map(([request]) => request.toolName)).toEqual(["browser.search"]);
    expect(invokeTool.mock.calls[0]?.[0].args).toMatchObject({
      query: "CCGs and what makes each one unique and better than the competition",
    });
    expect(extractRequestToolNames(providerRequests[0])).toEqual(
      expect.arrayContaining(["browser_search", "presentations_create"]),
    );
    expect(providerRequests[0]).toMatchObject({
      timeoutMs: 300_000,
      max_tokens: 2_400,
    });
    expect(result.turnTrace.routing.executionBudget).toMatchObject({
      profile: "research_artifact",
      promotionReason: "explicit_research_artifact",
      turnBudgetMs: 600_000,
      completionTimeoutMs: 300_000,
      maxToolLoops: 6,
      maxToolRunsPerTurn: 12,
      searchMaxResults: 6,
      maxTokens: 2_400,
    });
    expect(result.turnTrace.completion?.firstProviderRequestUsage?.effectiveInputTokens).toBeLessThan(12_000);
    expect(result.turnTrace.status).toBe("failed");
    expect(result.turnTrace.failure?.failureClass).toBe("tool_blocked");
    expect(
      result.turnTrace.toolRuns
        .filter((run) => run.toolName === "presentations.create")
        .map((run) => run.error)
        .join(" "),
    ).toMatch(/structured research metadata|structured sources registry|uncited legacy string bullet/i);
    expect(result.assistantContent).toContain("No downloadable PowerPoint was produced.");
    expect(result.turnTrace.citations).toHaveLength(2);
  });

  it("routes a context-dependent research follow-up through the structured evidence gate", async () => {
    const content = "Put those findings into a PowerPoint.";
    const priorResearch = [
      "Research competing note-taking apps and compare their feature fit.",
      "The research found distinct capture, organization, collaboration, and export considerations. ".repeat(5),
    ].join(" ");
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("presentations.create", {
          path: "./workspace/goatcitadel_out/note-app-findings.pptx",
          title: "Note-taking app findings",
          slides: [
            {
              title: "Capture",
              bullets: ["Capture methods differ across the reviewed applications and workflows."],
            },
            {
              title: "Organization",
              bullets: ["Organization models create different trade-offs for individual and team use."],
            },
            {
              title: "Decision guide",
              bullets: ["The best fit depends on collaboration, export, and retrieval needs."],
            },
          ],
        }),
      )
      .mockResolvedValue(completion("No deck was written because the research evidence contract was incomplete."));
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["presentations.create"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run(
      turnInput({
        content,
        historyMessages: [
          { role: "user", content: "Research competing note-taking apps and compare their feature fit." },
          { role: "assistant", content: priorResearch },
          { role: "user", content },
        ],
      }),
    );

    expect(invokeTool).not.toHaveBeenCalled();
    const blocked = result.turnTrace.toolRuns.find(
      (run) => run.toolName === "presentations.create" && run.status === "blocked",
    );
    expect(blocked?.error).toMatch(
      /research presentation content\/evidence gate.*structured research metadata.*structured sources registry/i,
    );
    expect(result.turnTrace.status).toBe("failed");
  });

  it("admits a structured evidence-backed deck for the exact CCG market-research prompt", async () => {
    const content =
      "Can you please do some market research on CCGs and what makes each one unique and better than the competition? Please put it into a powerpoint deck.";
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "One Piece Lorcana Flesh and Blood organized play",
          maxResults: 6,
        }),
      )
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "Star Wars Unlimited Riftbound Gundam official support",
          maxResults: 6,
        }),
      )
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "North America CCG marketplace retail signals",
          maxResults: 6,
        }),
      )
      .mockResolvedValueOnce(namedToolCallCompletion("presentations.create", structuredCcgPresentationArgs()))
      .mockResolvedValueOnce(completion("The evidence-backed CCG presentation is complete."));
    const invokeTool = vi.fn(async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
      if (request.toolName === "browser.search") {
        return {
          outcome: "executed",
          result: {
            results: CCG_EVIDENCE.map(([, title, url]) => ({
              title,
              url,
              snippet: `${title} product, play, market, or retail evidence.`,
              publishedAt: "2026-07-01",
            })),
          },
        };
      }
      return {
        outcome: "executed",
        result: {
          path: "F:\\code\\personal-ai\\workspace\\goatcitadel_out\\ccg-competitive-landscape-v2.pptx",
          bytesWritten: 64_000,
          format: "pptx",
          title: request.args.title,
          slideCount: 14,
        },
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "presentations.create"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run(
      turnInput({
        content,
        webMode: "quick",
        historyMessages: [{ role: "user", content }],
      }),
    );

    expect(invokeTool.mock.calls.map(([request]) => request.toolName)).toEqual([
      "browser.search",
      "browser.search",
      "browser.search",
      "browser.search",
      "presentations.create",
    ]);
    const presentationRequest = invokeTool.mock.calls[4]?.[0];
    const sources = presentationRequest?.args.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(12);
    expect(sources[0]).toMatchObject({
      id: presentationSourceId("https://magic.wizards.com/en/products"),
      url: "https://magic.wizards.com/en/products",
      role: "official",
      toolName: "browser.search",
    });
    expect(presentationRequest?.presentationGrounding).toMatchObject({
      sourceUrlCount: 12,
      matchedSourceUrlCount: 12,
    });
    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.toolRuns).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: "presentations.create", status: "executed" })]),
    );
  });

  it("preserves the research grounding receipt through a safe write-jail fallback", async () => {
    const content =
      "Can you please do some market research on CCGs and what makes each one unique and better than the competition? Please put it into a powerpoint deck.";
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "One Piece Lorcana Flesh and Blood organized play",
          maxResults: 6,
        }),
      )
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "Star Wars Unlimited Riftbound Gundam official support",
          maxResults: 6,
        }),
      )
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "North America CCG marketplace retail signals",
          maxResults: 6,
        }),
      )
      .mockResolvedValueOnce(namedToolCallCompletion("presentations.create", structuredCcgPresentationArgs()))
      .mockResolvedValueOnce(completion("The evidence-backed CCG presentation is complete."));
    let presentationAttempt = 0;
    const invokeTool = vi.fn(async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
      if (request.toolName === "browser.search") {
        return {
          outcome: "executed",
          result: {
            results: CCG_EVIDENCE.map(([, title, url]) => ({
              title,
              url,
              snippet: `${title} product, play, market, or retail evidence.`,
              publishedAt: "2026-07-01",
            })),
          },
        };
      }
      presentationAttempt += 1;
      if (presentationAttempt === 1) {
        return {
          outcome: "blocked",
          policyReason: "outside write jail",
          result: { blocked: true },
        };
      }
      return {
        outcome: "executed",
        result: {
          path: request.args.path,
          bytesWritten: 64_000,
          format: "pptx",
          title: request.args.title,
          slideCount: 14,
        },
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "presentations.create"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run(
      turnInput({
        content,
        webMode: "quick",
        historyMessages: [{ role: "user", content }],
      }),
    );

    const presentationRequests = invokeTool.mock.calls
      .map(([request]) => request)
      .filter((request) => request.toolName === "presentations.create");
    expect(presentationRequests).toHaveLength(2);
    expect(presentationRequests[0]?.presentationGrounding).toBeDefined();
    expect(presentationRequests[1]?.presentationGrounding).toEqual(presentationRequests[0]?.presentationGrounding);
    expect(presentationRequests[1]?.args.path).toBe(
      "./workspace/goatcitadel_out/ccg-competitive-landscape-v2-sess-loop24.pptx",
    );
    expect(result.turnTrace.status).toBe("completed");
  });

  it("corrects one scope and citation research-gate failure and then creates the deck", async () => {
    const content =
      "Can you please do some market research on CCGs and what makes each one unique and better than the competition? Please put it into a powerpoint deck.";
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "One Piece Lorcana Flesh and Blood organized play",
          maxResults: 6,
        }),
      )
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "Star Wars Unlimited Riftbound Gundam official support",
          maxResults: 6,
        }),
      )
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "North America CCG marketplace retail signals",
          maxResults: 6,
        }),
      )
      .mockResolvedValueOnce(
        namedToolCallCompletion("presentations.create", scopeAndCitationInvalidCcgPresentationArgs()),
      )
      .mockImplementationOnce(async (request) => {
        expect(request.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "system",
              content: expect.stringMatching(
                /content\/evidence correction attempt 1 of 1.*scope or methodology.*claim citations.*240 characters.*preserve every valid source ID.*retry presentations\.create exactly once/is,
              ),
            }),
          ]),
        );
        return namedToolCallCompletion("presentations.create", structuredCcgPresentationArgs());
      })
      .mockResolvedValueOnce(completion("The corrected evidence-backed CCG presentation is complete."));
    const invokeTool = vi.fn(async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
      if (request.toolName === "presentations.create") {
        return {
          outcome: "executed",
          result: {
            path: "F:\\code\\personal-ai\\workspace\\goatcitadel_out\\ccg-competitive-landscape-v2.pptx",
            bytesWritten: 64_000,
            format: "pptx",
            title: request.args.title,
            slideCount: 14,
          },
        };
      }
      return {
        outcome: "executed",
        result: {
          results: CCG_EVIDENCE.map(([, title, url]) => ({
            title,
            url,
            snippet: `${title} product, play, market, or retail evidence.`,
            publishedAt: "2026-07-01",
          })),
        },
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "presentations.create"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run(
      turnInput({
        content,
        webMode: "quick",
        historyMessages: [{ role: "user", content }],
      }),
    );

    expect(createChatCompletion).toHaveBeenCalledTimes(6);
    const correctionInstructionCount = (createChatCompletion.mock.calls[4]?.[0].messages ?? []).filter(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("Research presentation content/evidence correction attempt 1 of 1."),
    ).length;
    expect(correctionInstructionCount).toBe(1);
    expect(invokeTool.mock.calls.map(([request]) => request.toolName)).toEqual([
      "browser.search",
      "browser.search",
      "browser.search",
      "browser.search",
      "presentations.create",
    ]);
    const blockedPresentationRuns = result.turnTrace.toolRuns.filter(
      (run) => run.toolName === "presentations.create" && run.status === "blocked",
    );
    expect(blockedPresentationRuns).toHaveLength(1);
    expect(blockedPresentationRuns[0]?.error).toMatch(
      /research metadata is missing `geography`|has no canonical citation/i,
    );
    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.failure).toBeUndefined();
  });

  it("uses one shared research correction budget and stops on a distinct second gate failure", async () => {
    const content =
      "Can you please do some market research on CCGs and what makes each one unique and better than the competition? Please put it into a powerpoint deck.";
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "One Piece Lorcana Flesh and Blood organized play",
          maxResults: 6,
        }),
      )
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "Star Wars Unlimited Riftbound Gundam official support",
          maxResults: 6,
        }),
      )
      .mockResolvedValueOnce(
        namedToolCallCompletion("browser.search", {
          query: "North America CCG marketplace retail signals",
          maxResults: 6,
        }),
      )
      .mockResolvedValueOnce(
        namedToolCallCompletion("presentations.create", scopeAndCitationInvalidCcgPresentationArgs()),
      )
      .mockImplementationOnce(async (request) => {
        expect(request.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "system",
              content: expect.stringMatching(/content\/evidence correction attempt 1 of 1/is),
            }),
          ]),
        );
        return namedToolCallCompletion("presentations.create", overlongCcgPresentationArgs(8));
      })
      .mockImplementationOnce(async (request) => {
        expect(request.tools).toBeUndefined();
        return completion(
          "The deck was not written because the corrected presentation still failed research preflight.",
        );
      });
    const invokeTool = vi.fn(async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
      if (request.toolName !== "browser.search") {
        throw new Error("A blocked research deck must not reach the presentation provider.");
      }
      return {
        outcome: "executed",
        result: {
          results: CCG_EVIDENCE.map(([, title, url]) => ({
            title,
            url,
            snippet: `${title} product, play, market, or retail evidence.`,
            publishedAt: "2026-07-01",
          })),
        },
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "presentations.create"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run(
      turnInput({
        content,
        webMode: "quick",
        historyMessages: [{ role: "user", content }],
      }),
    );

    expect(createChatCompletion).toHaveBeenCalledTimes(6);
    const correctionInstructionCount = (createChatCompletion.mock.calls[4]?.[0].messages ?? []).filter(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("Research presentation content/evidence correction attempt 1 of 1."),
    ).length;
    expect(correctionInstructionCount).toBe(1);
    expect(invokeTool.mock.calls.map(([request]) => request.toolName)).toEqual([
      "browser.search",
      "browser.search",
      "browser.search",
      "browser.search",
    ]);
    const blockedPresentationRuns = result.turnTrace.toolRuns.filter(
      (run) => run.toolName === "presentations.create" && run.status === "blocked",
    );
    expect(blockedPresentationRuns).toHaveLength(2);
    expect(blockedPresentationRuns[0]?.error).toMatch(
      /research metadata is missing `geography`|has no canonical citation/i,
    );
    expect(blockedPresentationRuns[1]?.error).toMatch(
      /research bullet on .* is \d+ characters; rewrite it to 240 characters or fewer without dropping its citations/i,
    );
    expect(result.turnTrace.status).toBe("failed");
    expect(result.turnTrace.failure).toMatchObject({ failureClass: "tool_blocked" });
    expect(result.turnTrace.failure?.message).toMatch(
      /research bullet on .* is \d+ characters; rewrite it to 240 characters or fewer without dropping its citations/i,
    );
  });

  it("reuses an approved equivalent search while allowing a distinct gap-closing search", async () => {
    const content = "i want you to research the funniest jokes and then present them in a powerpoint";
    const sessionId = "sess-loop24-approved-research-deck";
    const turnId = "turn-loop24-approved-research-deck";
    const storage = createMockStorage();
    storage.chatToolRuns.create({
      toolRunId: "tool-run-initial-funny-jokes-search",
      turnId,
      sessionId,
      toolName: "browser.search",
      status: "executed",
      args: { query: "funniest jokes research", maxResults: 6, apiKey: "approved-search-secret" },
      result: {
        results: [
          {
            title: "LaughLab and the science of jokes",
            url: "https://example.test/laughlab",
            snippet: "The first search explains incongruity, surprise, and broadly effective joke structure.",
          },
        ],
      },
      startedAt: "2026-08-06T00:00:00.000Z",
      finishedAt: "2026-08-06T00:00:01.000Z",
    });
    storage.chatToolRuns.create({
      toolRunId: "tool-run-approved-funny-jokes-search",
      turnId,
      sessionId,
      toolName: "browser.search",
      status: "executed",
      approvalId: "approval-funny-jokes-search",
      args: {
        query: "LaughLab funniest joke humor research",
        maxResults: 6,
        backend: "official",
      },
      result: { results: [] },
      startedAt: "2026-08-06T00:00:02.000Z",
      finishedAt: "2026-08-06T00:00:03.000Z",
    });
    const providerRequests: ChatCompletionRequest[] = [];
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        providerRequests.push(request);
        return namedToolCallCompletion("browser.search", {
          query: "LaughLab funniest joke humor research",
          maxResults: 6,
          backend: "official",
        });
      })
      .mockImplementationOnce(async (request) => {
        providerRequests.push(request);
        return namedToolCallCompletion("browser.search", {
          backend: "native",
          maxResults: 10,
          query: "site:richardwiseman.wordpress.com LaughLab funniest joke",
        });
      })
      .mockImplementationOnce(async (request) => {
        providerRequests.push(request);
        return namedToolCallCompletion("presentations.create", {
          path: "./workspace/goatcitadel_out/funny-jokes-approved-research.pptx",
          title: "Why Funny Jokes Work",
          slides: [
            {
              title: "Why Funny Jokes Work",
              bullets: ["A research-guided comedy sampler", "Humor remains subjective"],
              visualBrief: "A comedy microphone under a spotlight",
            },
            {
              title: "Why We Laugh",
              bullets: ["Incongruity and surprise overturn the audience's expected interpretation."],
            },
            {
              title: "Reliable Structures",
              bullets: ["Misdirection, callbacks, and the rule of three create comic rhythm."],
            },
            {
              title: "Delivery",
              bullets: ["A concise setup and deliberate timing give the twist room to land."],
            },
          ],
        });
      })
      .mockImplementationOnce(async (request) => {
        providerRequests.push(request);
        return namedToolCallCompletion("presentations.create", {
          path: "./workspace/goatcitadel_out/funny-jokes-approved-research.pptx",
          title: "Why Funny Jokes Work",
          research: {
            asOfDate: "2026-08-06",
            geography: "Global public research context",
            physicalDigitalBoundary: "Humor research across physical and digital publication formats",
            inclusionCriteria: ["Publicly retrievable research or explanatory sources"],
            exclusions: [],
            methodology: ["Synthesize only claims retained in canonical search evidence"],
            limitations: ["Humor remains subjective and the available evidence is bounded"],
            competitors: ["Incongruity", "Misdirection", "Timing"],
            comparisonCriteria: ["explanatory value"],
          },
          sources: [
            {
              id: "laughlab",
              title: "LaughLab and the science of jokes",
              url: "https://example.test/laughlab",
              publisher: "Example research",
              role: "independent",
            },
            {
              id: "duplicate",
              title: "Duplicate search",
              url: "https://example.test/duplicate",
              publisher: "Example research",
              role: "independent",
            },
          ],
          slides: [
            {
              title: "Why We Laugh",
              bullets: [
                {
                  text: "Incongruity and surprise can overturn the audience's expected interpretation.",
                  claimKind: "analysis",
                  sourceIds: ["laughlab"],
                },
              ],
            },
            {
              title: "Reliable Structures",
              bullets: [
                {
                  text: "Misdirection and callbacks are useful structures to examine in joke construction.",
                  claimKind: "analysis",
                  sourceIds: ["laughlab", "duplicate"],
                },
              ],
            },
            {
              title: "Delivery",
              bullets: [
                {
                  text: "Best for a live audience when the setup stays concise and the delivery leaves room for the twist.",
                  claimKind: "recommendation",
                  sourceIds: [],
                },
              ],
            },
          ],
        });
      })
      .mockImplementationOnce(async (request) => {
        providerRequests.push(request);
        return completion(
          "The approved research is incorporated, and the PowerPoint presentation is complete. " +
            "[Download the PowerPoint](sandbox:/mnt/data/wrong-name.pptx)",
        );
      });
    const invokeTool = vi.fn(async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
      if (request.toolName === "browser.search") {
        return {
          outcome: "executed",
          result: { results: [{ title: "duplicate search", url: "https://example.test/duplicate" }] },
        };
      }
      return {
        outcome: "executed",
        result: {
          path: "F:\\code\\personal-ai\\workspace\\goatcitadel_out\\funny-jokes-approved-research.pptx",
          bytesWritten: 24_000,
          format: "pptx",
          title: request.args.title,
          // presentations.create reports the generated cover plus the three
          // content slides supplied in the tool arguments.
          slideCount: 4,
        },
      };
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["browser.search", "presentations.create"]),
      createChatCompletion,
      invokeTool,
      workspaceFileRootDir: "F:\\code\\personal-ai\\workspace",
    });

    const result = await orchestrator.run(
      turnInput({
        sessionId,
        turnId,
        content,
        webMode: "auto",
        historyMessages: [{ role: "user", content }],
      }),
    );

    expect(invokeTool.mock.calls.map(([request]) => request.toolName)).toEqual([
      "browser.search",
      "presentations.create",
    ]);
    expect(invokeTool.mock.calls[0]?.[0].args).toMatchObject({
      query: "site:richardwiseman.wordpress.com LaughLab funniest joke",
    });
    expect(invokeTool.mock.calls[1]?.[0].args).toMatchObject({
      title: "Why Funny Jokes Work",
      slides: [
        expect.objectContaining({ title: "Why We Laugh" }),
        expect.objectContaining({ title: "Reliable Structures" }),
        expect.objectContaining({ title: "Delivery" }),
      ],
    });
    expect(
      providerRequests[0]?.messages.some(
        (message) =>
          message.role === "tool" &&
          typeof message.content === "string" &&
          message.content.includes("LaughLab and the science of jokes"),
      ),
    ).toBe(true);
    expect(
      providerRequests[0]?.messages.some(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Do not repeat an identical or equivalent browser.search"),
      ),
    ).toBe(true);
    expect(
      providerRequests[1]?.messages.some(
        (message) =>
          message.role === "tool" &&
          typeof message.content === "string" &&
          message.content.includes("equivalent_search_reused"),
      ),
    ).toBe(true);
    expect(
      providerRequests[2]?.messages.some(
        (message) =>
          message.role === "tool" &&
          typeof message.content === "string" &&
          message.content.includes("duplicate search"),
      ),
    ).toBe(true);
    expect(
      providerRequests[0]?.messages.some(
        (message) =>
          message.role === "tool" && typeof message.content === "string" && message.content.includes('"results":[]'),
      ),
    ).toBe(true);
    expect(JSON.stringify(providerRequests)).not.toContain("approved-search-secret");
    expect(result.turnTrace.status).toBe("completed");
    const blockedPresentationRuns = result.turnTrace.toolRuns.filter(
      (run) => run.toolName === "presentations.create" && run.status === "blocked",
    );
    expect(blockedPresentationRuns).toHaveLength(1);
    expect(blockedPresentationRuns.map((run) => run.error).join(" ")).toMatch(/duplicates.*title slide/i);
    expect(result.assistantContent).not.toContain("sandbox:/");
    expect(result.assistantContent).toContain(
      "/api/v1/files/download?relativePath=goatcitadel_out%2Ffunny-jokes-approved-research.pptx",
    );
    expect(result.assistantContent).toContain("Slides: 4.");
    expect(result.turnTrace.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolRunId: "tool-run-initial-funny-jokes-search",
          status: "executed",
        }),
        expect.objectContaining({
          toolRunId: "tool-run-approved-funny-jokes-search",
          status: "executed",
          approvalId: "approval-funny-jokes-search",
        }),
        expect.objectContaining({ toolName: "presentations.create", status: "executed" }),
      ]),
    );
  });

  it("defers synthetic presentation visuals until after policy authorization", async () => {
    const createChatCompletion = vi.fn(async (): Promise<ChatCompletionResponse> => {
      return completion("Here is an outline, but I did not create a deck.");
    });
    const generateImage = vi.fn(async () => ({
      providerId: "openai",
      model: "gpt-image-2",
      operation: "generate" as const,
      data: [{ b64Json: "generated-image-base64", revisedPrompt: "A polished presentation visual." }],
    }));
    const invokeTool = vi.fn(
      async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: {
          path: "F:\\code\\personal-ai\\workspace\\goatcitadel_out\\daily-walking.pptx",
          bytesWritten: 12345,
          format: "pptx",
          title: request.args.title,
          slideCount: 5,
        },
      }),
    );
    const storage = createMockStorage() as Record<string, unknown>;
    storage.chatSessionMeta = {
      get: () => ({ workspaceId: "workspace-loop24" }),
    };
    const orchestrator = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["presentations.create"]),
      createChatCompletion,
      generateImage,
      invokeTool,
    });

    const visualTurn = turnInput({
      turnId: "turn-presentation-visual",
      policyRunId: "durable-presentation-visual",
      policyTaskId: "task-presentation-visual",
      mode: "cowork",
      content: "Put all that information into a real PowerPoint presentation.",
      historyMessages: [
        { role: "user", content: "Explain the benefits and a practical routine for daily walking." },
        { role: "assistant", content: WALKING_RESEARCH },
        { role: "user", content: "Put all that information into a real PowerPoint presentation." },
      ],
    });
    await orchestrator.run(visualTurn);

    expect(generateImage).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "presentations.create",
        args: expect.objectContaining({
          slides: expect.arrayContaining([expect.objectContaining({ title: "Health Benefits" })]),
          design: expect.objectContaining({
            mode: "polished",
            skillId: "design-intelligence",
          }),
        }),
      }),
    );
    const presentationArgs = invokeTool.mock.calls[0]?.[0].args;
    expect(JSON.stringify(presentationArgs)).not.toContain("generated-image-base64");
  });

  it("retries a generic model deck once and writes no file when the retry is still ungrounded", async () => {
    const genericArgs = {
      path: "./workspace/goatcitadel_out/generic.pptx",
      title: "Presentation",
      slides: [
        {
          title: "Presentation",
          bullets: ["Summarizes the requested topic", "Keeps the deck concise"],
        },
      ],
    };
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("presentations.create", genericArgs))
      .mockResolvedValueOnce(namedToolCallCompletion("presentations.create", genericArgs))
      .mockResolvedValueOnce(completion("Done. [Download the PowerPoint](sandbox:/mnt/data/fake-presentation.pptx)"));
    const invokeTool = vi.fn();
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["presentations.create"]),
      createChatCompletion,
      invokeTool,
    });
    const result = await runner.run(
      turnInput({
        mode: "cowork",
        content: "Put all that information into a real PowerPoint presentation.",
        historyMessages: [
          { role: "user", content: "Research the benefits and practical routine for daily walking." },
          { role: "assistant", content: WALKING_RESEARCH },
          { role: "user", content: "Put all that information into a real PowerPoint presentation." },
        ],
      }),
    );

    expect(invokeTool).not.toHaveBeenCalled();
    expect(
      result.turnTrace.toolRuns.filter(
        (run) =>
          run.toolName === "presentations.create" && run.error?.includes("research presentation content/evidence gate"),
      ),
    ).toHaveLength(2);
    expect(result.turnTrace.status).toBe("failed");
    expect(result.turnTrace.completion?.status).toBe("interrupted");
    expect(result.turnTrace.failure?.failureClass).toBe("tool_blocked");
    expect(result.assistantContent).toContain("No downloadable PowerPoint was produced.");
    expect(result.assistantContent).not.toContain("sandbox:/");
    expect(result.assistantContent).not.toMatch(/\[Download\b/iu);
  });

  it("uses the configured workspace artifact directory for write-jail fallbacks", async () => {
    const safeWriteFallbackDir = "F:\\code\\personal-ai\\workspace\\goatcitadel_out";
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "blocked",
        policyReason: "Path is outside write jail: F:\\Users\\operator\\Desktop\\deck.pptx",
        auditEventId: "audit-original-blocked",
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-fallback-executed",
        result: {
          path: "fallback-created.pptx",
          bytesWritten: 12345,
          format: "pptx",
          title: "Walking Deck",
          slideCount: 2,
        },
      });
    const executeToolCall = createExecuteToolCallForTest({
      invokeTool,
      invokeToolWithEffectTruth: createEffectAwareInvokeToolForTest(invokeTool),
      toolNames: ["presentations.create"],
      safeWriteFallbackDir,
    });

    const result = await executeToolCall({
      input: turnInput({ mode: "cowork" }),
      turnId: "turn-fallback-dir",
      toolName: "presentations.create",
      rawArgs: {
        path: "F:\\Users\\operator\\Desktop\\deck.pptx",
        title: "Walking Deck",
        slides: [
          { title: "Health", bullets: ["Regular walking supports cardiovascular health, mobility, energy, and mood."] },
          {
            title: "Routine",
            bullets: ["A consistent time, comfortable route, and realistic duration make the habit easier to sustain."],
          },
          {
            title: "Progression",
            bullets: ["Increase duration gradually and adapt the plan for weather, symptoms, and mobility needs."],
          },
        ],
      },
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(invokeTool.mock.calls[1]?.[0].args.path).toContain(safeWriteFallbackDir);
    expect(result.record.status).toBe("executed");
    expect(result.record.result).toMatchObject({
      fallbackApplied: true,
      fallbackPath: expect.stringContaining(safeWriteFallbackDir),
    });
  });

  it("repairs a structurally blocked frozen-profile path before approval without changing the deck payload", async () => {
    const safeWriteFallbackDir = "F:\\code\\personal-ai\\workspace\\goatcitadel_out";
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "approval_required",
      policyReason: "approval required",
      auditEventId: "audit-repaired-approval",
      approvalId: "approval-repaired-deck",
    });
    const evaluateToolAccess = vi.fn((request: { args?: Record<string, unknown> }) => {
      const requestedPath = String(request.args?.path ?? "");
      return requestedPath.startsWith(safeWriteFallbackDir)
        ? { allowed: true, requiresApproval: true, reasonCodes: ["approval_required"] }
        : { allowed: false, requiresApproval: true, reasonCodes: ["structural_safety_block"] };
    });
    const executeToolCall = createExecuteToolCallForTest({
      invokeTool,
      invokeToolWithEffectTruth: createEffectAwareInvokeToolForTest(invokeTool),
      toolNames: ["presentations.create"],
      safeWriteFallbackDir,
      evaluateToolAccess,
    });
    const originalArgs = {
      path: "/workspace/artifacts/research-deck.pptx",
      title: "Research Findings",
      subtitle: "Evidence and practical implications",
      slides: [
        { title: "Context", bullets: ["The source establishes the decision context and the operator constraints."] },
        {
          title: "Evidence",
          bullets: ["The strongest evidence supports the proposed direction and preserves citations."],
          speakerNotes: "Source note",
        },
        {
          title: "Decision",
          bullets: ["Proceed with the bounded option and validate the remaining uncertainty."],
          visualBrief: "A precise decision-path visual",
        },
      ],
      design: { mode: "polished", preset: "editorial", skillId: "compatibility-hint-only" },
      destination: { kind: "local" },
    };
    const profile = {
      profileId: "profile-path-repair",
      identity: { workspaceId: "workspace-loop24" },
      catalog: {
        snapshotId: "snapshot-path-repair",
        inspectableHash: "1".repeat(64),
        callableHash: "2".repeat(64),
        inspectableCount: 1,
        callableCount: 1,
      },
      selection: { tools: [], activatedSkills: [] },
      governance: {
        policyDecisions: [
          {
            toolName: "presentations.create",
            allowed: true,
            requiresApproval: true,
            reasonCodes: ["frozen_approval_required"],
          },
        ],
      },
    } as unknown as ChatTurnAgentRunnerInput["capabilityProfile"];
    const result = await executeToolCall({
      input: turnInput({ capabilityProfile: profile }),
      turnId: "turn-path-repair",
      toolName: "presentations.create",
      rawArgs: originalArgs,
    });

    expect(result.record.status, JSON.stringify(result.record)).toBe("approval_required");
    expect(evaluateToolAccess).toHaveBeenCalledTimes(2);
    const repairedArgs = invokeTool.mock.calls[0]?.[0].args;
    expect(invokeTool.mock.calls[0]?.[0].writePathRepair).toEqual({
      originalPath: originalArgs.path,
      repairedPath: expect.stringContaining(safeWriteFallbackDir),
      originalReasonCodes: ["structural_safety_block"],
      repairedReasonCodes: ["approval_required"],
    });
    expect(repairedArgs.path).toContain(safeWriteFallbackDir);
    const { path: _originalPath, ...originalPayload } = originalArgs;
    const { path: _repairedPath, ...repairedPayload } = repairedArgs;
    expect(repairedPayload).toEqual(originalPayload);
    expect(result.record.result).toMatchObject({
      fallbackApplied: true,
      originalPath: originalArgs.path,
      fallbackPath: expect.stringContaining(safeWriteFallbackDir),
      policyRevalidation: {
        status: "repaired",
        originalReasonCodes: ["structural_safety_block"],
        repairedReasonCodes: ["approval_required"],
      },
    });
  });

  it("records both policy decisions and requests a destination when the repaired path is also denied", async () => {
    const safeWriteFallbackDir = "F:\\code\\personal-ai\\workspace\\goatcitadel_out";
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const evaluateToolAccess = vi.fn((request: { args?: Record<string, unknown> }) => {
      const requestedPath = String(request.args?.path ?? "");
      return requestedPath.startsWith(safeWriteFallbackDir)
        ? { allowed: false, requiresApproval: false, reasonCodes: ["permission_profile_denied"] }
        : { allowed: false, requiresApproval: false, reasonCodes: ["structural_safety_block"] };
    });
    const executeToolCall = createExecuteToolCallForTest({
      invokeTool,
      invokeToolWithEffectTruth: createEffectAwareInvokeToolForTest(invokeTool),
      toolNames: ["presentations.create"],
      safeWriteFallbackDir,
      evaluateToolAccess,
    });
    const profile = {
      profileId: "profile-path-repair-denied",
      identity: { workspaceId: "workspace-loop24" },
      catalog: {
        snapshotId: "snapshot-path-repair-denied",
        inspectableHash: "1".repeat(64),
        callableHash: "2".repeat(64),
        inspectableCount: 1,
        callableCount: 1,
      },
      selection: { tools: [] },
      governance: {
        policyDecisions: [
          {
            toolName: "presentations.create",
            allowed: true,
            requiresApproval: true,
            reasonCodes: ["frozen_approval_required"],
          },
        ],
      },
    } as unknown as ChatTurnAgentRunnerInput["capabilityProfile"];
    const result = await executeToolCall({
      input: turnInput({ capabilityProfile: profile }),
      turnId: "turn-path-repair-denied",
      toolName: "presentations.create",
      rawArgs: {
        path: "/workspace/artifacts/research-deck.pptx",
        title: "Research Findings",
        slides: [
          { title: "Context", bullets: ["The source establishes the decision context and operator constraints."] },
          {
            title: "Evidence",
            bullets: ["The strongest evidence supports the proposed direction and preserves citations."],
          },
          { title: "Decision", bullets: ["Proceed with the bounded option and validate the remaining uncertainty."] },
        ],
      },
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(evaluateToolAccess).toHaveBeenCalledTimes(2);
    expect(result.record).toMatchObject({
      status: "blocked",
      result: {
        policyRevalidation: {
          status: "blocked_after_path_repair",
          reasonCodes: ["permission_profile_denied"],
          originalPath: "/workspace/artifacts/research-deck.pptx",
          repairedPath: expect.stringContaining(safeWriteFallbackDir),
          originalReasonCodes: ["structural_safety_block"],
          repairedReasonCodes: ["permission_profile_denied"],
        },
      },
    });
    expect(result.userInputPrompt).toMatchObject({
      kind: "text",
      title: "Choose artifact destination",
      placeholder: "Enter an allowed destination path",
    });
  });

  it("turns a runtime configuration marker into a Gateway-owned secure prompt", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      result: {
        status: "configuration_required",
        configurationRequired: true,
        targetId: "search.brave",
      },
    });
    const executeToolCall = createExecuteToolCallForTest({
      invokeTool,
      invokeToolWithEffectTruth: createEffectAwareInvokeToolForTest(invokeTool),
      toolNames: ["runtime.configure"],
    });

    const result = await executeToolCall({
      input: turnInput(),
      turnId: "turn-runtime-configuration",
      toolName: "runtime.configure",
      rawArgs: { targetId: "search.brave" },
    });

    expect(result.record.status).toBe("executed");
    expect(result.userInputPrompt).toMatchObject({
      kind: "text",
      title: "Configure Brave Search",
      submitLabel: "Connect, test, and continue",
      secureConfiguration: {
        targetId: "search.brave",
        targetLabel: "Brave Search",
        secretFieldLabel: "Brave Search API key",
        acquisitionUrl: "https://brave.com/search/api/",
        acquisitionLabel: "Get a Brave Search API key",
        storage: "os_keychain",
        scope: "installation",
        verification: "live_probe",
      },
    });
    expect(JSON.stringify(result.userInputPrompt)).not.toContain("secret-value");
  });

  it.each([
    {
      provider: "brave",
      status: "unavailable",
      message: "Brave credential is not configured",
      targetId: "search.brave",
      targetLabel: "Brave Search",
    },
    {
      provider: "parallel",
      status: "blocked",
      message: "Parallel rejected the credential or request",
      targetId: "search.parallel",
      targetLabel: "Parallel Search",
    },
  ])(
    "deterministically opens secure repair for a $provider search credential failure",
    async ({ provider, status, message, targetId, targetLabel }) => {
      const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
        outcome: "executed",
        result: {
          results: [],
          routing: { successfulProviders: [] },
          providerAttempts: [{ provider, status, message }],
        },
      });
      const executeToolCall = createExecuteToolCallForTest({
        invokeTool,
        invokeToolWithEffectTruth: createEffectAwareInvokeToolForTest(invokeTool),
        toolNames: ["browser.search"],
      });

      const result = await executeToolCall({
        input: turnInput({
          content: "Search the web for current evidence.",
          webMode: "auto",
        }),
        turnId: `turn-${provider}-credential-repair`,
        toolName: "browser.search",
        rawArgs: { query: "current search evidence" },
      });

      expect(result.record.result).toMatchObject({
        providerAttempts: [expect.objectContaining({ provider, status })],
      });
      expect(result.userInputPrompt).toMatchObject({
        title: `Configure ${targetLabel}`,
        secureConfiguration: { targetId },
      });
    },
  );

  it("projects a sanitized network prerequisite instead of silently dropping the blocked secure card", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      result: {
        status: "configuration_required",
        configurationRequired: true,
        targetId: "search.brave",
      },
    });
    const executeToolCall = createExecuteToolCallForTest({
      invokeTool,
      invokeToolWithEffectTruth: createEffectAwareInvokeToolForTest(invokeTool),
      toolNames: ["runtime.configure"],
      assertRuntimeConfigurationPromptAvailable: () => {
        throw new PolicyViolationError({
          message: "LEAK_CANARY arbitrary internal failure",
          details: {
            diagnosticCode: "runtime_configuration_network_prerequisite",
            endpointHost: "api.search.brave.com",
          },
        });
      },
    });

    const result = await executeToolCall({
      input: turnInput(),
      turnId: "turn-runtime-configuration-prerequisite",
      toolName: "runtime.configure",
      rawArgs: { targetId: "search.brave" },
    });

    expect(result.userInputPrompt).toBeUndefined();
    expect(result.record.result).toMatchObject({
      runtimeConfiguration: {
        status: "prerequisite_required",
        configurationRequired: false,
        targetId: "search.brave",
        diagnosticCode: "runtime_configuration_network_prerequisite",
        operatorAction: expect.stringContaining("Settings"),
      },
    });
    expect(JSON.stringify(result.record)).not.toContain("LEAK_CANARY");
  });

  it("does not open a dead-end secure form when Ward policy still requires apply-time approval", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      result: {
        status: "configuration_required",
        configurationRequired: true,
        targetId: "search.brave",
      },
    });
    const executeToolCall = createExecuteToolCallForTest({
      invokeTool,
      invokeToolWithEffectTruth: createEffectAwareInvokeToolForTest(invokeTool),
      toolNames: ["runtime.configure"],
      evaluateToolAccess: async () => ({
        allowed: true,
        requiresApproval: true,
        reasonCodes: ["ward_approval_required"],
      }),
    });

    const result = await executeToolCall({
      input: turnInput(),
      turnId: "turn-runtime-configuration-ward",
      toolName: "runtime.configure",
      rawArgs: { targetId: "search.brave" },
    });

    expect(result.userInputPrompt).toBeUndefined();
    expect(result.record.result).toMatchObject({
      runtimeConfiguration: {
        status: "manual_required",
        configurationRequired: false,
        targetId: "search.brave",
        diagnosticCode: "runtime_configuration_preapproval_binding_required",
      },
    });
  });

  it("projects the Ward limitation when an approved runtime.configure result is reused after resume", async () => {
    const sessionId = "sess-runtime-configuration-ward-resume";
    const turnId = "turn-runtime-configuration-ward-resume";
    const storage = createMockStorage() as ReturnType<typeof createMockStorage> & {
      chatToolRuns: { create: (record: Record<string, unknown>) => unknown };
    };
    storage.chatToolRuns.create({
      toolRunId: "tool-run-runtime-configuration-approved",
      turnId,
      sessionId,
      toolName: "runtime.configure",
      status: "executed",
      approvalId: "approval-runtime-configuration",
      args: { targetId: "search.brave" },
      result: {
        status: "configuration_required",
        configurationRequired: true,
        targetId: "search.brave",
      },
      startedAt: "2026-08-07T20:00:00.000Z",
      finishedAt: "2026-08-07T20:00:01.000Z",
    });
    const requests: ChatCompletionRequest[] = [];
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        requests.push(request);
        return namedToolCallCompletion("runtime.configure", { targetId: "search.brave" });
      })
      .mockImplementationOnce(async (request) => {
        requests.push(request);
        return completion("Administrator intervention is required under the current Ward policy.");
      });
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["runtime.configure"]),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: async () => ({
        allowed: true,
        requiresApproval: true,
        reasonCodes: ["ward_approval_required"],
      }),
    });

    const result = await orchestrator.run(
      turnInput({
        sessionId,
        turnId,
        content: "Continue the approved Brave configuration.",
        historyMessages: [{ role: "user", content: "Continue the approved Brave configuration." }],
      }),
    );

    expect(invokeTool).not.toHaveBeenCalled();
    expect(JSON.stringify(requests[1]?.messages)).toContain("runtime_configuration_preapproval_binding_required");
    expect(result.assistantContent).toContain("Administrator intervention");
    expect(result.turnTrace.pendingUserInput).toBeUndefined();
  });

  it.each([
    {
      status: "configuration_required",
      configurationRequired: true,
      targetId: "search.brave",
    },
    {
      results: [],
      routing: { successfulProviders: [] },
      providerAttempts: [{ provider: "brave", status: "unavailable", message: "Brave credential is not configured" }],
    },
  ])("does not let another tool spoof a Gateway secure-configuration card", async (spoofedResult) => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      result: spoofedResult,
    });
    const executeToolCall = createExecuteToolCallForTest({
      invokeTool,
      invokeToolWithEffectTruth: createEffectAwareInvokeToolForTest(invokeTool),
      toolNames: ["session.status"],
    });

    const result = await executeToolCall({
      input: turnInput(),
      turnId: "turn-runtime-configuration-spoof",
      toolName: "session.status",
      rawArgs: {},
    });

    expect(result.userInputPrompt).toBeUndefined();
  });

  it("pauses for a destination prompt when requested and fallback artifact paths are both blocked", async () => {
    const safeWriteFallbackDir = "F:\\code\\personal-ai\\workspace\\goatcitadel_out";
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("presentations.create", {
          path: "F:\\Users\\operator\\Desktop\\daily-walking.pptx",
          title: "Benefits of Daily Walking",
          slides: [
            {
              title: "Physical Health",
              bullets: ["Regular walking supports cardiovascular health, mobility, and daily energy."],
            },
            {
              title: "Practical Routine",
              bullets: ["Use a consistent time, comfortable route, and realistic starting duration."],
            },
            {
              title: "Safe Progression",
              bullets: ["Increase duration gradually and adapt for weather, symptoms, and mobility needs."],
            },
          ],
        }),
      );
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "blocked",
      policyReason: "Path is outside write jail: F:\\code\\personal-ai\\apps\\gateway",
      auditEventId: "audit-write-blocked",
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["presentations.create"]),
      createChatCompletion,
      invokeTool,
      safeWriteFallbackDir,
    });

    const chunks = [];
    for await (const chunk of orchestrator.runStream(
      turnInput({
        mode: "cowork",
        content: "Create a real PowerPoint .pptx presentation about daily walking.",
        historyMessages: [
          { role: "user", content: "Create a real PowerPoint .pptx presentation about daily walking." },
        ],
      }),
    )) {
      chunks.push(chunk);
    }

    const userInputChunk = chunks.find((chunk) => chunk.type === "user_input_required");
    const traceChunk = chunks.filter((chunk) => chunk.type === "trace_update").at(-1);
    expect(userInputChunk).toMatchObject({
      type: "user_input_required",
      prompt: expect.objectContaining({
        kind: "text",
        title: "Choose artifact destination",
        question: expect.stringContaining("outside the configured write jail"),
        placeholder: "Enter an allowed destination path",
      }),
    });
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "presentations.create",
        args: expect.objectContaining({
          design: expect.objectContaining({
            mode: "polished",
            skillId: "design-intelligence",
          }),
        }),
      }),
    );
    expect(traceChunk).toMatchObject({
      trace: expect.objectContaining({
        status: "waiting_for_user_input",
      }),
    });
    expect(chunks.some((chunk) => chunk.type === "message_done")).toBe(false);
  });

  it("probes document access with safe args and creates a document fallback when the model answers with text", async () => {
    let capturedRequest: ChatCompletionRequest | undefined;
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      capturedRequest = request;
      return completion(FREE_TIME_RESEARCH);
    });
    const evaluateToolAccess = vi.fn((input: { toolName: string; args?: Record<string, unknown> }) => ({
      allowed: input.toolName !== "documents.create" || typeof input.args?.path === "string",
      requiresApproval: false,
      reasonCodes: [],
    }));
    const invokeTool = vi.fn(
      async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: {
          path: "F:\\code\\personal-ai\\workspace\\goatcitadel_out\\free-time-report.pdf",
          bytesWritten: 6789,
          format: request.args.format,
          title: request.args.title,
        },
      }),
    );
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["documents.create"]),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess,
    });

    const result = await orchestrator.run(
      turnInput({
        mode: "cowork",
        content: "Create a real PDF report file about the top 10 things to do in free time.",
        historyMessages: [
          {
            role: "user",
            content: "Create a real PDF report file about the top 10 things to do in free time.",
          },
        ],
      }),
    );

    const documentProbe = evaluateToolAccess.mock.calls.find(([input]) => input.toolName === "documents.create")?.[0];
    expect(documentProbe?.args?.path).toBe("./workspace/goatcitadel_out/tool-access-probe.docx");
    expect(documentProbe?.args?.design).toMatchObject({
      mode: "polished",
      skillId: "design-intelligence",
    });
    expect(extractRequestToolNames(capturedRequest)).toContain("documents_create");
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "documents.create",
        args: expect.objectContaining({
          path: expect.stringContaining("top-10-things-to-do-in-free-time"),
          format: "pdf",
          title: "Top 10 Things To Do In Free Time",
          design: expect.objectContaining({
            mode: "polished",
            skillId: "design-intelligence",
          }),
        }),
      }),
    );
    expect(result.assistantContent).toContain("Created the document artifact");
    expect(result.assistantContent).toContain(".pdf");
  });

  it.each([
    {
      toolName: "presentations.create",
      content: "Put all that information into a real PowerPoint presentation.",
      modelContent: "I can outline the deck, but I did not create a PowerPoint file.",
      historyMessages: [
        { role: "user" as const, content: "Explain the benefits and a practical routine for daily walking." },
        { role: "assistant" as const, content: WALKING_RESEARCH },
        { role: "user" as const, content: "Put all that information into a real PowerPoint presentation." },
      ],
    },
    {
      toolName: "documents.create",
      content: "Create a real PDF report file about daily walking.",
      modelContent: WALKING_RESEARCH,
      historyMessages: undefined,
    },
  ])("parks a synthetic $toolName fallback when artifact creation needs approval", async (scenario) => {
    const approvalId = `approval-${scenario.toolName}`;
    const storage = createMockStorage() as {
      chatInlineApprovals: { upsert: ReturnType<typeof vi.fn> };
    };
    storage.chatInlineApprovals.upsert = vi.fn();
    const createChatCompletion = vi.fn(async (): Promise<ChatCompletionResponse> => completion(scenario.modelContent));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "Artifact creation requires operator approval",
      auditEventId: `audit-${scenario.toolName}`,
      approvalId,
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog([scenario.toolName]),
      createChatCompletion,
      invokeTool,
      evaluateToolAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
    });

    const chunks = [];
    for await (const chunk of orchestrator.runStream(
      turnInput({
        mode: "cowork",
        content: scenario.content,
        historyMessages: scenario.historyMessages ?? [{ role: "user", content: scenario.content }],
      }),
    )) {
      chunks.push(chunk);
    }

    expect(chunks.find((chunk) => chunk.type === "approval_required")).toMatchObject({
      type: "approval_required",
      approval: {
        approvalId,
        toolName: scenario.toolName,
      },
    });
    expect(chunks.filter((chunk) => chunk.type === "trace_update").at(-1)).toMatchObject({
      trace: expect.objectContaining({
        status: "waiting_for_approval",
        completion: expect.objectContaining({ status: "backgrounded", repaired: false }),
      }),
    });
    expect(chunks.some((chunk) => chunk.type === "message_done" || chunk.type === "done")).toBe(false);
    expect(storage.chatInlineApprovals.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId,
        sessionId: "sess-loop24",
        toolName: scenario.toolName,
        status: "pending",
      }),
    );
  });

  it("blocks delegated non-code Prompt Lab local file calls before runtime invocation", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const executeToolCall = createExecuteToolCall({ invokeTool });
    const prompt = [
      "## Prompt Lab Run Contract",
      "- Mode: cowork",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Delegated role: Researcher",
      "",
      "Parent objective: Plan a volunteer orientation.",
      "",
      "Current step objective: Draft the public-facing agenda.",
      "",
      "Suggested tools: file.find",
      "",
      "Produce only the delegated output.",
    ].join("\n");

    const result = await executeToolCall({
      input: turnInput({
        content: prompt,
        mode: "cowork",
        normalizationProfile: "prompt_pack_harness",
        historyMessages: [{ role: "user", content: prompt }],
      }),
      turnId: "turn-delegated-local-suppressed",
      toolName: "file.find",
      rawArgs: { path: ".", pattern: "orientation" },
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.record).toMatchObject({
      toolName: "file.find",
      status: "blocked",
      error:
        "execution skipped: local file/code tools were suppressed because this non-code Prompt Lab step does not ask for repository inspection",
    });
  });

  it("blocks browser search calls when a local project prompt has no explicit web intent", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        content: "Inspect `apps/gateway/src/services/chat-turn-agent-runner.ts` and explain the local code path.",
        mode: "code",
        webMode: "auto",
        historyMessages: [
          {
            role: "user",
            content: "Inspect `apps/gateway/src/services/chat-turn-agent-runner.ts` and explain the local code path.",
          },
        ],
      }),
      turnId: "turn-local-browser-suppressed",
      toolName: "browser.search",
      rawArgs: { query: "chat agent orchestrator" },
      localFileIntent: true,
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.record).toMatchObject({
      toolName: "browser.search",
      status: "blocked",
      error: "execution skipped: browser.search was suppressed because the prompt targets local files/project context",
    });
  });

  it("allows delegated local-business research review search even when prior handoffs mention project tools", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      result: {
        results: [
          {
            title: "BGE's Tabletop - board game store",
            url: "https://example.com/bges-tabletop",
            snippet: "Board game store with address, hours, and contact details.",
          },
        ],
      },
    });
    const executeToolCall = createExecuteToolCall({ invokeTool });
    const prompt = [
      "Delegated role: Reviewer",
      "",
      "Parent objective: can you find boardgame and tabletop game stores within 10 miles of 91303 and put a list together, of the store, address, hours, and email address",
      "",
      "Current step objective: Review the current work for correctness risks, regressions, and missing support.",
      "",
      "Suggested tools: code.search, file.read_range, tests.run, lint.run",
      "",
      "Prior handoffs:",
      "Worker: relevant store sites were blocked; verify address, hours, and email before final synthesis.",
    ].join("\n");

    const result = await executeToolCall({
      input: turnInput({
        content: prompt,
        mode: "cowork",
        webMode: "auto",
        historyMessages: [{ role: "user", content: prompt }],
      }),
      turnId: "turn-delegated-live-review-search",
      toolName: "browser.search",
      rawArgs: { query: "boardgame tabletop stores within 10 miles of 91303 hours email" },
      localFileIntent: true,
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({
          query: expect.stringContaining("91303"),
        }),
      }),
    );
    expect(result.record).toMatchObject({
      toolName: "browser.search",
      status: "executed",
    });
  });

  it("leaves approval expiry undefined when both result and approval storage lookup are unavailable", async () => {
    const storage = createMockStorage() as {
      approvals: { get: (approvalId: string) => unknown };
    };
    storage.approvals.get = () => {
      throw new Error("approval row missing");
    };
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "approval required",
      auditEventId: "audit-missing-approval-expiry",
      approvalId: "approval-missing-expiry",
    });
    const executeToolCall = createExecuteToolCall({ storage: storage as never, invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        content: "Run a shell check after approval.",
        mode: "code",
      }),
      turnId: "turn-missing-approval-expiry",
      toolName: "shell.exec",
      rawArgs: { command: "pnpm --version" },
    });

    expect(result.record).toMatchObject({
      status: "approval_required",
      approvalId: "approval-missing-expiry",
    });
    expect(result.approvalExpiresAt).toBeUndefined();
  });

  it("passes degraded prompt-pack answers through verbatim without forced prefetch tool runs", async () => {
    const prompt = [
      "## Prompt Lab Run Contract",
      "- Mode: code",
      "- Tool tier: implicit-tools",
      "",
      "## User Task",
      "Inspect the repo if needed and propose the exact minimal automated test that proves an env-loaded prompt pack preserves its source label.",
      "",
      "Answer contract:",
      "- Include `Setup`, `Act`, `Assert`, and `Failure signature` details.",
    ].join("\n");
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValue(completion("Need answer with observed/inferred maybe incomplete."));
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "code.search_files"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run(
      turnInput({
        content: prompt,
        mode: "code",
        providerId: "openai",
        model: "gpt-5.4",
        thinkingLevel: "extended",
        normalizationProfile: "prompt_pack_harness",
        historyMessages: [{ role: "user", content: prompt }],
      }),
    );

    // Eval-integrity turn: the model's own (even degraded) answer is persisted
    // verbatim. The controller must not execute file reads or repo searches on
    // the model's behalf, and must not substitute canned test scaffolding or
    // append a citation/files appendix.
    expect(result.assistantContent).toBe("Need answer with observed/inferred maybe incomplete.");
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.turnTrace.toolRuns).toEqual([]);
    expect(result.assistantContent).not.toContain("Exact files used:");
    expect(result.assistantContent).not.toContain("Source URLs:");
  });
});

function structuredCcgPresentationArgs(): Record<string, unknown> {
  const competitors = [
    "Magic: The Gathering",
    "Pokémon",
    "Yu-Gi-Oh!",
    "One Piece",
    "Disney Lorcana",
    "Flesh and Blood",
    "Star Wars: Unlimited",
    "Riftbound",
    "Gundam",
  ];
  const profileSlides = CCG_EVIDENCE.slice(0, 9).map(([id, title]) => ({
    title: `${title} fit`,
    archetype: "narrative",
    bullets: [
      {
        text: `${title} mechanics/player benefit: documented gameplay creates a distinct player experience. Learning curve/strategic depth: documented rules support a qualitative fit.`,
        claimKind: "fact",
        sourceIds: [id],
      },
      {
        text: "Entry-product and ongoing cost: not measured comparably. IP/collectibility appeal: documented brand proposition. Format/organized play: documented support.",
        claimKind: "analysis",
        sourceIds: [id],
      },
      {
        text: "Local play/digital access: reviewed separately. Retail demand/community building: not measured. Release/SKU burden, singles liquidity, and inventory risk: not measured.",
        claimKind: "analysis",
        sourceIds: [id],
      },
      {
        text: `Recommendation: Best fit for players or retailers aligned with ${title}; trade-off: verify local demand and community depth.`,
        claimKind: "recommendation",
        sourceIds: [],
      },
    ],
  }));
  return {
    path: "./workspace/goatcitadel_out/ccg-competitive-landscape-v2.pptx",
    title: "CCG Competitive Landscape 2026: Best Fits for Players and Retailers",
    research: {
      asOfDate: "2026-08-06",
      geography: "North America with global scale context",
      physicalDigitalBoundary: "Physical CCGs in the core comparison; digital clients in an appendix",
      inclusionCriteria: ["Active North American retail distribution and organized play"],
      exclusions: ["Digital-only games are separated from the physical comparison"],
      methodology: ["Apply one player and retailer rubric to every core physical game"],
      limitations: ["Public sources do not expose directly comparable revenue for every title"],
      competitors,
      comparisonCriteria: [
        "Signature mechanics and resulting player benefit",
        "Learning curve and strategic depth",
        "Dated entry-product and ongoing cost, or explicit not measured",
        "IP and collectibility appeal",
        "Format and organized-play support",
        "Local-play and digital access",
        "Retail demand and community-building potential",
        "Release or SKU burden, singles liquidity, and inventory risk",
        "Best-fit player or store profile and major trade-off",
      ],
    },
    sources: CCG_EVIDENCE.map(([id, title, url, role]) => ({
      id,
      title,
      url,
      publisher: new URL(url).hostname,
      role,
    })),
    slides: [
      ...profileSlides,
      {
        title: "Physical CCG comparison matrix",
        archetype: "matrix",
        table: {
          headers: ["Game", "Differentiated fit"],
          rows: CCG_EVIDENCE.slice(0, 9).map(([id, title]) => [
            { text: title, sourceIds: [id] },
            { text: "Documented differentiated fit", sourceIds: [id] },
          ]),
        },
      },
      {
        title: "Qualitative positioning map",
        archetype: "comparison",
        bullets: [
          {
            text: "The positioning spectrum separates documented ecosystem breadth from the amount of local validation still required.",
            claimKind: "analysis",
            sourceIds: ["tcgplayer", "icv2", "retailer"],
          },
        ],
        table: {
          headers: ["Positioning axis", "Qualitative interpretation"],
          rows: [
            [
              { text: "Established ecosystem", sourceIds: ["tcgplayer", "icv2"] },
              { text: "Broader documented retail and play signals", sourceIds: ["tcgplayer", "icv2"] },
            ],
            [
              { text: "Local validation needed", sourceIds: ["retailer"] },
              { text: "Test community depth before expanding inventory", sourceIds: ["retailer"] },
            ],
          ],
        },
      },
      {
        title: "Player fit guide",
        archetype: "comparison",
        bullets: [
          {
            text: "Best for each player need depends on learning curve, organized play, collectibility, and local availability.",
            claimKind: "recommendation",
            sourceIds: [],
          },
        ],
      },
    ],
  };
}

function overlongCcgPresentationArgs(repetitions: number): Record<string, unknown> {
  const args = structuredCcgPresentationArgs();
  const slides = args.slides as Array<Record<string, unknown>>;
  const bullets = slides[0]?.bullets as Array<Record<string, unknown>>;
  bullets[0] = {
    ...bullets[0],
    text: [
      "Magic has a documented product and organized-play proposition with a detailed strategic profile.",
      ...Array.from({ length: repetitions }, () => "Its official materials document strategic depth and play support."),
    ].join(" "),
  };
  return args;
}

function scopeAndCitationInvalidCcgPresentationArgs(): Record<string, unknown> {
  const args = structuredCcgPresentationArgs();
  delete (args.research as Record<string, unknown>).geography;
  const slides = args.slides as Array<Record<string, unknown>>;
  const bullets = slides[0]?.bullets as Array<Record<string, unknown>>;
  bullets[0] = {
    ...bullets[0],
    sourceIds: [],
  };
  return args;
}

function createExecuteToolCall(input: {
  storage?: ChatTurnAgentRunnerDeps["storage"];
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
}) {
  return createExecuteToolCallForTest({
    storage: input.storage,
    invokeTool: input.invokeTool,
    invokeToolWithEffectTruth: createEffectAwareInvokeToolForTest(input.invokeTool),
    toolNames: ["browser.search", "file.find", "shell.exec", "session.status", "memory.search"],
  });
}

function turnInput(overrides: Partial<ChatTurnAgentRunnerInput> = {}): ChatTurnAgentRunnerInput {
  const content = overrides.content ?? "Answer directly.";
  return {
    sessionId: "sess-loop24",
    turnId: randomUUID(),
    userMessageId: "msg-loop24",
    content,
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
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
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
      },
    ],
  };
}

function extractRequestToolNames(request: ChatCompletionRequest | undefined): string[] {
  return (request?.tools ?? [])
    .map((tool) => {
      const record = tool as { function?: { name?: unknown } };
      return typeof record.function?.name === "string" ? record.function.name : undefined;
    })
    .filter((name): name is string => Boolean(name));
}
