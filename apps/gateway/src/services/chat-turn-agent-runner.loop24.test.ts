import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerDeps, ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  EffectAwareChatTurnAgentRunner as ChatTurnAgentRunner,
  createEffectAwareInvokeToolForTest,
  createExecuteToolCallForTest,
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

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
            content: "Research the top 10 things to do in free time.",
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

  it("routes the exact research-deck prompt through a cleaned search before presentation creation", async () => {
    const content = "Please do some research on funny jokes and put together a PowerPoint presentation on it.";
    const providerRequests: ChatCompletionRequest[] = [];
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockImplementationOnce(async (request) => {
        providerRequests.push(request);
        return namedToolCallCompletion("presentations.create", {
          path: "./workspace/goatcitadel_out/funny-jokes.pptx",
          title: "Why Funny Jokes Work",
          slides: [
            {
              title: "What Makes a Joke Funny",
              bullets: ["Surprise changes the expected interpretation at the punchline."],
            },
            {
              title: "Reliable Joke Structures",
              bullets: ["Misdirection, callbacks, and the rule of three create recognizable comic rhythm."],
            },
            {
              title: "Examples and Delivery",
              bullets: ["Concise setup and deliberate timing give the audience room to recognize the twist."],
            },
          ],
        });
      })
      .mockImplementationOnce(async (request) => {
        providerRequests.push(request);
        return completion(
          "I researched common joke structures, preserved the source evidence, and created the PowerPoint presentation.",
        );
      });
    const invokeTool = vi.fn(async (request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
      if (request.toolName === "browser.search") {
        return {
          outcome: "executed",
          result: {
            results: [
              {
                title: "Humor and incongruity",
                url: "https://www.britannica.com/art/humour",
                snippet: "Research describes incongruity and resolution as common mechanisms in humor.",
              },
              {
                title: "Comedy writing structures",
                url: "https://www.masterclass.com/articles/how-to-write-comedy",
                snippet: "Callbacks, misdirection, and the rule of three are common joke-writing structures.",
              },
            ],
          },
        };
      }
      return {
        outcome: "executed",
        result: {
          path: "F:\\code\\personal-ai\\workspace\\goatcitadel_out\\funny-jokes.pptx",
          bytesWritten: 24_000,
          format: "pptx",
          title: request.args.title,
          slideCount: 3,
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
        webMode: "auto",
        historyMessages: [{ role: "user", content }],
      }),
    );

    expect(invokeTool.mock.calls.map(([request]) => request.toolName)).toEqual([
      "browser.search",
      "presentations.create",
    ]);
    expect(invokeTool.mock.calls[0]?.[0].args).toMatchObject({ query: "funny jokes" });
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
    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.citations).toHaveLength(2);
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
        { role: "user", content: "Research the benefits and practical routine for daily walking." },
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
      .mockResolvedValueOnce(completion("I could not produce a grounded deck from that generic draft."));
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
        (run) => run.toolName === "presentations.create" && run.error?.includes("content quality gate"),
      ),
    ).toHaveLength(2);
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
        { role: "user" as const, content: "Research the benefits and practical routine for daily walking." },
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
