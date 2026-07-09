import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import {
  ChatTurnAgentRunner,
  type ChatTurnAgentRunnerDeps,
  type ChatTurnAgentRunnerInput,
} from "./chat-turn-agent-runner.js";
import {
  createExecuteToolCallForTest,
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

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
      return { allowed: input.toolName !== "memory.search" };
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
        content: "Create a real PowerPoint .pptx presentation about the top 10 things to do in free time.",
        historyMessages: [
          {
            role: "user",
            content: "Create a real PowerPoint .pptx presentation about the top 10 things to do in free time.",
          },
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
          title: "Top 10 Things To Do In Free Time",
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

  it("attaches a gpt-image-2 visual asset to synthetic presentation fallbacks when image generation is available", async () => {
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
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["presentations.create"]),
      createChatCompletion,
      generateImage,
      invokeTool,
    });

    await orchestrator.run(
      turnInput({
        mode: "cowork",
        content: "Create a real PowerPoint .pptx presentation about daily walking.",
        historyMessages: [
          { role: "user", content: "Create a real PowerPoint .pptx presentation about daily walking." },
        ],
      }),
    );

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai",
        model: "gpt-image-2",
        outputFormat: "png",
        responseFormat: "b64_json",
      }),
    );
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "presentations.create",
        args: expect.objectContaining({
          slides: expect.arrayContaining([
            expect.objectContaining({ title: "Daily Walking" }),
            expect.objectContaining({
              title: "Key Points",
              bullets: expect.arrayContaining([expect.stringContaining("daily walking")]),
            }),
          ]),
          visualAsset: expect.objectContaining({
            bytesBase64: "generated-image-base64",
            source: "openai",
            sourceModel: "gpt-image-2",
          }),
          design: expect.objectContaining({
            mode: "polished",
            skillId: "design-intelligence",
          }),
        }),
      }),
    );
    const presentationArgs = invokeTool.mock.calls[0]?.[0].args;
    expect(JSON.stringify(presentationArgs?.slides ?? [])).not.toContain("starting friction");
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
        slides: [{ title: "Start", bullets: ["Walk daily"] }],
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

  it("pauses for a destination prompt when requested and fallback artifact paths are both blocked", async () => {
    const safeWriteFallbackDir = "F:\\code\\personal-ai\\workspace\\goatcitadel_out";
    const createChatCompletion = vi
      .fn<(request: ChatCompletionRequest) => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("presentations.create", {
          path: "F:\\Users\\operator\\Desktop\\daily-walking.pptx",
          title: "Benefits of Daily Walking",
          slides: [{ title: "Physical Health", bullets: ["Supports heart health"] }],
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
        placeholder: expect.stringContaining(safeWriteFallbackDir),
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
      return completion("I can draft the report, but I did not create a document file.");
    });
    const evaluateToolAccess = vi.fn((input: { toolName: string; args?: Record<string, unknown> }) => ({
      allowed: input.toolName !== "documents.create" || typeof input.args?.path === "string",
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
