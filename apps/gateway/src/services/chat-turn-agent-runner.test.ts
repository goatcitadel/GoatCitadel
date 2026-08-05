import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatStreamChunkDraft,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerDeps } from "./chat-turn-agent-runner.js";
import { attachChatCompletionFailureContext } from "./llm-completion-helpers.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
  toolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

describe("ChatTurnAgentRunner stream and tool-loop behavior", () => {
  it("preserves the canonical usage event id union through stream chunks and the final result", async () => {
    async function* createChatCompletionStream() {
      yield {
        model_usage_event_id: "usage-stream-first",
        choices: [{ index: 0, delta: { content: "Tracked " } }],
      };
      yield {
        modelUsageEventIds: ["usage-stream-second", "usage-stream-first"],
        choices: [{ index: 0, delta: { content: "answer." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      };
    }
    const createRunner = () =>
      new ChatTurnAgentRunner({
        storage: createMockStorage() as never,
        listToolCatalog: () => [],
        createChatCompletion: vi.fn(),
        createChatCompletionStream,
        invokeTool: vi.fn(),
      });
    const input = {
      sessionId: "sess-stream-usage-ids",
      turnId: randomUUID(),
      userMessageId: "msg-stream-usage-ids",
      content: "Answer directly.",
      mode: "chat" as const,
      providerId: "glm",
      model: "glm-5",
      webMode: "off" as const,
      memoryMode: "off" as const,
      thinkingLevel: "standard" as const,
      toolAutonomy: "safe_auto" as const,
      historyMessages: [{ role: "user" as const, content: "Answer directly." }],
    };

    const chunks: ChatStreamChunkDraft[] = [];
    for await (const chunk of createRunner().runStream(input)) chunks.push(chunk);
    expect(chunks.find((chunk) => chunk.type === "usage")).toMatchObject({
      type: "usage",
      modelUsageEventIds: ["usage-stream-first", "usage-stream-second"],
    });

    const result = await createRunner().run({ ...input, turnId: randomUUID() });
    expect(result.modelUsageEventIds).toEqual(["usage-stream-first", "usage-stream-second"]);
  });

  it("uses non-streaming compatibility recovery only for an explicit tool-protocol failure", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Recovered answer.",
          },
        },
      ],
    });
    const toolProtocolError = attachChatCompletionFailureContext(
      new Error("invalid_request_error: function name is invalid"),
      { deadlineAtMs: Date.now() + 60_000, emittedOutput: false },
    );
    async function* createChatCompletionStream() {
      const unreachableChunks: Record<string, unknown>[] = [];
      yield* unreachableChunks;
      throw toolProtocolError;
    }
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      createChatCompletionStream,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-stream-fallback-before-output",
      turnId: randomUUID(),
      userMessageId: "msg-stream-fallback-before-output",
      content: "Answer directly.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Answer directly." }],
    });

    expect(result.assistantContent).toBe("Recovered answer.");
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("fails closed instead of replaying an unclassified stream failure", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    async function* createChatCompletionStream() {
      const unreachableChunks: Record<string, unknown>[] = [];
      yield* unreachableChunks;
      throw new Error("stream unavailable");
    }
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion,
      createChatCompletionStream,
      invokeTool: vi.fn(),
    });

    const chunks: ChatStreamChunkDraft[] = [];
    for await (const chunk of orchestrator.runStream({
      sessionId: "sess-stream-unknown-before-output",
      turnId: randomUUID(),
      userMessageId: "msg-stream-unknown-before-output",
      content: "Answer directly.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: "Answer directly." }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some((chunk) => chunk.type === "error")).toBe(true);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("does not replay a transient stream failure when the shared deadline has only 4551ms left", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const nativeServerError = Object.assign(
      new Error("responses stream failed: server_error - synthetic near-expiry failure"),
      { providerFailure: { code: "server_error", message: "synthetic near-expiry failure" } },
    );
    attachChatCompletionFailureContext(nativeServerError, {
      deadlineAtMs: Date.now() + 4_551,
      emittedOutput: false,
    });
    async function* createChatCompletionStream() {
      const unreachableChunks: Record<string, unknown>[] = [];
      yield* unreachableChunks;
      throw nativeServerError;
    }
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion,
      createChatCompletionStream,
      invokeTool: vi.fn(),
    });

    const chunks: ChatStreamChunkDraft[] = [];
    for await (const chunk of orchestrator.runStream({
      sessionId: "sess-stream-near-expiry",
      turnId: randomUUID(),
      userMessageId: "msg-stream-near-expiry",
      content: "Answer directly.",
      mode: "chat",
      providerId: "openai",
      model: "gpt-5-verification",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "off",
      toolAutonomy: "manual",
      historyMessages: [{ role: "user", content: "Answer directly." }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some((chunk) => chunk.type === "error")).toBe(true);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("does not replay after a tool-call-only provider chunk", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    async function* createChatCompletionStream() {
      yield {
        id: "stream-tool-call-only",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-tool-only-1",
                  type: "function",
                  function: {
                    name: "browser_search",
                    arguments: JSON.stringify({ query: "current news" }),
                  },
                },
              ],
            },
          },
        ],
      };
      throw new Error("stream interrupted after tool call");
    }
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      createChatCompletionStream,
      invokeTool: vi.fn(),
    });

    const chunks: ChatStreamChunkDraft[] = [];
    for await (const chunk of orchestrator.runStream({
      sessionId: "sess-stream-fallback-tool-call-only",
      turnId: randomUUID(),
      userMessageId: "msg-stream-fallback-tool-call-only",
      content: "Search current news.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search current news." }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some((chunk) => chunk.type === "error")).toBe(true);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("does not silently replace partial streamed output when the stream fails", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Replacement answer.",
          },
        },
      ],
    });
    async function* createChatCompletionStream() {
      yield {
        id: "stream-1",
        choices: [
          {
            index: 0,
            delta: { content: "Partial visible answer." },
          },
        ],
      };
      throw new Error("stream interrupted");
    }
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      createChatCompletionStream,
      invokeTool: vi.fn(),
    });

    const chunks = [];
    for await (const chunk of orchestrator.runStream({
      sessionId: "sess-stream-fallback-after-output",
      turnId: randomUUID(),
      userMessageId: "msg-stream-fallback-after-output",
      content: "Answer directly.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Answer directly." }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some((chunk) => chunk.type === "delta" && chunk.delta === "Partial visible answer.")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "error")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "message_done" && chunk.content === "Replacement answer.")).toBe(
      false,
    );
    expect(chunks.some((chunk) => chunk.type === "trace_update" && chunk.trace.status === "failed")).toBe(true);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("fails loudly if a stream ends without a final trace update", async () => {
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion: vi.fn(),
      invokeTool: vi.fn(),
    });
    vi.spyOn(orchestrator, "runStream").mockImplementation(async function* () {
      yield {
        type: "message_done",
        sessionId: "sess-no-trace",
        turnId: "turn-no-trace",
        content: "done without trace",
      } as never;
    });

    await expect(
      orchestrator.run({
        sessionId: "sess-no-trace",
        turnId: "turn-no-trace",
        userMessageId: "msg-no-trace",
        content: "Answer directly.",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
        historyMessages: [{ role: "user", content: "Answer directly." }],
      }),
    ).rejects.toThrow("Agent turn ended without trace.");
  });

  it("tolerates missing execution-plan storage while building the tool schema", async () => {
    const storage = createMockStorage() as Record<string, unknown>;
    delete storage.chatExecutionPlans;
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Direct answer.",
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-missing-plan-storage-1",
      turnId: randomUUID(),
      userMessageId: "msg-missing-plan-storage-1",
      content: "Answer directly.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Answer directly." }],
    });

    expect(result.assistantContent).toBe("Direct answer.");
    expect(result.turnTrace.failure).toBeUndefined();
  });

  it("returns a bounded local-file access fallback when no local tools are available", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-file-no-tools-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-file-no-tools-1",
      content: "Can you directly read my local project files before I paste docker-compose details?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "Can you directly read my local project files before I paste docker-compose details?",
        },
      ],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("no filesystem read path was available for this turn");
    expect(result.assistantContent).toContain("docker-compose.yml");
    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.toolRuns).toEqual([]);
  });

  it("returns missing-log paste guidance without calling the provider", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-missing-log-payload-1",
      turnId: randomUUID(),
      userMessageId: "msg-missing-log-payload-1",
      content: "I'll paste logs from the gateway in the next message. Can you find the root cause?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "I'll paste logs from the gateway in the next message. Can you find the root cause?",
        },
      ],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("the log blob wasn't pasted");
    expect(result.assistantContent).toContain("first and last fatal/exception blocks");
  });

  it("executes tool loop and returns final assistant message", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(toolCallCompletion("latest ai tooling"))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Final answer",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-1",
      result: {
        results: [{ title: "Result", url: "https://example.com" }],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-1",
      turnId: randomUUID(),
      userMessageId: "msg-user-1",
      content: "Search AI tooling references",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search AI tooling references" }],
    });

    expect(result.turnTrace.status).toBe("completed");
    expect(result.assistantContent).toContain("Final answer");
    expect(result.turnTrace.toolRuns.length).toBeGreaterThanOrEqual(1);
    expect(invokeTool.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("announces a long-running tool immediately and emits honest liveness heartbeats until settlement", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("session.status", {}))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The session is healthy.",
            },
          },
        ],
      });
    let settleTool!: (result: ToolInvokeResult) => void;
    const pendingTool = new Promise<ToolInvokeResult>((resolve) => {
      settleTool = resolve;
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockReturnValue(pendingTool);
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["session.status"]),
      createChatCompletion,
      invokeTool,
      toolActivityHeartbeatMs: 10,
    });
    const chunks: ChatStreamChunkDraft[] = [];
    const streamCompleted = (async () => {
      for await (const chunk of orchestrator.runStream({
        sessionId: "sess-tool-activity",
        turnId: randomUUID(),
        userMessageId: "msg-tool-activity",
        content: "Use session.status, then summarize it.",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
        historyMessages: [{ role: "user", content: "Use session.status, then summarize it." }],
      })) {
        chunks.push(chunk);
      }
    })();

    await vi.waitFor(() => expect(chunks.some((chunk) => chunk.type === "tool_start")).toBe(true));
    await vi.waitFor(() => expect(chunks.some((chunk) => chunk.type === "tool_activity")).toBe(true));
    expect(chunks.some((chunk) => chunk.type === "tool_result")).toBe(false);
    const toolStartIndex = chunks.findIndex((chunk) => chunk.type === "tool_start");
    const toolActivityIndex = chunks.findIndex((chunk) => chunk.type === "tool_activity");
    expect(toolStartIndex).toBeGreaterThanOrEqual(0);
    expect(toolActivityIndex).toBeGreaterThan(toolStartIndex);

    settleTool({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-tool-activity",
      result: { healthy: true },
    });
    await streamCompleted;

    const toolResultIndex = chunks.findIndex((chunk) => chunk.type === "tool_result");
    expect(toolResultIndex).toBeGreaterThan(toolActivityIndex);
    const heartbeatCountAtSettlement = chunks.filter((chunk) => chunk.type === "tool_activity").length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(chunks.filter((chunk) => chunk.type === "tool_activity")).toHaveLength(heartbeatCountAtSettlement);
  });

  it("closes the heartbeat wrapper promptly even when the active tool ignores cancellation", async () => {
    let settleTool!: (result: ToolInvokeResult) => void;
    const pendingTool = new Promise<ToolInvokeResult>((resolve) => {
      settleTool = resolve;
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["session.status"]),
      createChatCompletion: vi
        .fn<() => Promise<ChatCompletionResponse>>()
        .mockResolvedValue(namedToolCallCompletion("session.status", {})),
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>().mockReturnValue(pendingTool),
      toolActivityHeartbeatMs: 10,
    });
    const iterator = orchestrator.runStream({
      sessionId: "sess-tool-close",
      turnId: randomUUID(),
      userMessageId: "msg-tool-close",
      content: "Use session.status.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Use session.status." }],
    });

    let step = await iterator.next();
    while (!step.done && step.value.type !== "tool_start") {
      step = await iterator.next();
    }
    expect(step.done).toBe(false);

    const closeOutcome = await Promise.race([
      iterator.return(undefined).then(() => "closed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 75)),
    ]);
    expect(closeOutcome).toBe("closed");

    settleTool({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-tool-close",
      result: { healthy: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("surfaces dispatch uncertainty when pending inner work has no active tool owner", async () => {
    let settleTool!: (result: ToolInvokeResult) => void;
    const pendingTool = new Promise<ToolInvokeResult>((resolve) => {
      settleTool = resolve;
    });
    const storage = createMockStorage() as {
      chatToolRuns: {
        listByTurn(turnId: string): Array<{ toolRunId: string; status: string }>;
        patch(toolRunId: string, patch: Record<string, unknown>): unknown;
      };
    };
    const turnId = randomUUID();
    const orchestrator = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["session.status"]),
      createChatCompletion: vi
        .fn<() => Promise<ChatCompletionResponse>>()
        .mockResolvedValue(namedToolCallCompletion("session.status", {})),
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>().mockReturnValue(pendingTool),
      toolActivityHeartbeatMs: 10,
    });
    const iterator = orchestrator.runStream({
      sessionId: "sess-unowned-pending",
      turnId,
      userMessageId: "msg-unowned-pending",
      content: "Use session.status.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Use session.status." }],
    });

    let step = await iterator.next();
    while (!step.done && step.value.type !== "tool_start") {
      step = await iterator.next();
    }
    expect(step.done).toBe(false);
    const activeToolRun = storage.chatToolRuns.listByTurn(turnId).find((toolRun) => toolRun.status === "started");
    expect(activeToolRun).toBeDefined();
    storage.chatToolRuns.patch(activeToolRun!.toolRunId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: "tool ownership was lost before cancellation",
    });

    await expect(iterator.return(undefined)).rejects.toMatchObject({
      name: "ModelUsageDispatchUncertainError",
      message: expect.stringContaining("same-generation retry is blocked"),
    });

    settleTool({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-unowned-pending",
      result: { healthy: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("surfaces authoritative usage settlement faults raised by provider-stream cleanup", async () => {
    const settlementError = new Error("canonical stream usage settlement failed");
    settlementError.name = "ModelUsageSettlementError";
    async function* createChatCompletionStream() {
      try {
        yield {
          id: "stream-settlement-return",
          choices: [{ index: 0, delta: { content: "Visible answer" } }],
        };
      } finally {
        await Promise.reject(settlementError);
      }
    }
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion: vi.fn(),
      createChatCompletionStream,
      invokeTool: vi.fn(),
    });
    const iterator = orchestrator.runStream({
      sessionId: "sess-stream-settlement-return",
      turnId: randomUUID(),
      userMessageId: "msg-stream-settlement-return",
      content: "Answer directly.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Answer directly." }],
    });

    let step = await iterator.next();
    while (!step.done && step.value.type !== "delta") {
      step = await iterator.next();
    }
    expect(step.done).toBe(false);
    await expect(iterator.return(undefined)).rejects.toBe(settlementError);
  });

  it("stops heartbeats promptly when an active tool ignores the aborted turn signal", async () => {
    let settleTool!: (result: ToolInvokeResult) => void;
    const pendingTool = new Promise<ToolInvokeResult>((resolve) => {
      settleTool = resolve;
    });
    const controller = new AbortController();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["session.status"]),
      createChatCompletion: vi
        .fn<() => Promise<ChatCompletionResponse>>()
        .mockResolvedValue(namedToolCallCompletion("session.status", {})),
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>().mockReturnValue(pendingTool),
      toolActivityHeartbeatMs: 1_000,
    });
    const iterator = orchestrator.runStream({
      sessionId: "sess-tool-abort",
      turnId: randomUUID(),
      userMessageId: "msg-tool-abort",
      content: "Use session.status.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Use session.status." }],
      signal: controller.signal,
    });

    let step = await iterator.next();
    while (!step.done && step.value.type !== "tool_start") {
      step = await iterator.next();
    }
    expect(step.done).toBe(false);

    const pendingNext = iterator.next();
    controller.abort();
    await expect(pendingNext).rejects.toMatchObject({ name: "AbortError" });

    settleTool({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-tool-abort",
      result: { healthy: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not claim liveness for a started tool record left behind before this execution", async () => {
    const storage = createMockStorage();
    const turnId = randomUUID();
    storage.chatToolRuns.create({
      toolRunId: "stale-tool-run",
      turnId,
      sessionId: "sess-stale-tool-activity",
      toolName: "session.status",
      status: "started",
      startedAt: "2026-07-13T07:00:00.000Z",
    });
    let settleCompletion!: (response: ChatCompletionResponse) => void;
    const pendingCompletion = new Promise<ChatCompletionResponse>((resolve) => {
      settleCompletion = resolve;
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: storage as never,
      listToolCatalog: () => createToolCatalog(["session.status"]),
      createChatCompletion: vi.fn<() => Promise<ChatCompletionResponse>>().mockReturnValue(pendingCompletion),
      invokeTool: vi.fn(),
      toolActivityHeartbeatMs: 10,
    });
    const chunks: ChatStreamChunkDraft[] = [];
    const streamCompleted = (async () => {
      for await (const chunk of orchestrator.runStream({
        sessionId: "sess-stale-tool-activity",
        turnId,
        userMessageId: "msg-stale-tool-activity",
        content: "Answer directly.",
        mode: "chat",
        providerId: "glm",
        model: "glm-5",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        toolAutonomy: "safe_auto",
        historyMessages: [{ role: "user", content: "Answer directly." }],
      })) {
        chunks.push(chunk);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(chunks.some((chunk) => chunk.type === "tool_start" || chunk.type === "tool_activity")).toBe(false);
    settleCompletion({
      model: "glm-5",
      choices: [{ index: 0, message: { role: "assistant", content: "Direct answer." } }],
    });
    await streamCompleted;
  });

  it("infers missing local search and find arguments from the user prompt", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        multiToolCallCompletion([
          { toolName: "code.search", args: {} },
          { toolName: "file.find", args: {} },
        ]),
      )
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Found the route preflight path.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-local-inference",
      result: { matches: [{ path: "apps/gateway/src/routes/chat.messages.ts", line: 1 }] },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search", "file.find"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-arg-inference-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-arg-inference-1",
      content: "Search the whole repository for `routePreflight` in tests and coverage.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "Search the whole repository for `routePreflight` in tests and coverage.",
        },
      ],
    });

    expect(result.assistantContent).toContain("Found the route preflight path");
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "code.search",
        args: {
          path: ".",
          query: "test",
        },
      }),
    );
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "file.find",
        args: {
          path: ".",
          pattern: "routePreflight",
        },
      }),
    );
  });

  it("infers local search query text from explicit file paths", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("code.search", {}))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Searched the explicit file path.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-local-path-query",
      result: { matches: [{ path: "apps/gateway/src/routes/chat.messages.ts", line: 1 }] },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["code.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-path-query-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-path-query-1",
      content: "Search local file `apps/gateway/src/routes/chat.messages.ts`.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search local file `apps/gateway/src/routes/chat.messages.ts`." }],
    });

    expect(result.turnTrace.toolRuns.length).toBeGreaterThan(0);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "code.search",
        args: {
          path: ".",
          query: "chat.messages.ts",
        },
      }),
    );
  });

  it("reroutes a pre-dispatch write-jail block to the safe workspace fallback path", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("fs.write", { path: "Draft Notes.md", content: "hello" }))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Saved to the fallback path.",
            },
          },
        ],
      });
    const invokeTool = vi
      .fn<NonNullable<ChatTurnAgentRunnerDeps["invokeToolWithEffectTruth"]>>()
      .mockResolvedValueOnce({
        outcome: "blocked",
        policyReason: "outside write jail",
        auditEventId: "audit-write-blocked",
        result: { blocked: true },
      })
      .mockImplementationOnce(async (_request, options) => {
        options.executionFence();
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: "audit-write-fallback",
          result: { bytesWritten: 5 },
        };
      });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [
        {
          toolName: "fs.write",
          category: "fs",
          riskLevel: "danger",
          requiresApproval: true,
          description: "Write a local file",
          argSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
          examples: [],
          pack: "devops",
          recommendedContexts: ["code"],
          preferredForIntents: ["local_file"],
        },
      ],
      createChatCompletion,
      invokeTool: vi.fn(async () => {
        throw new Error("legacy invocation seam must not run when effect truth is supported");
      }),
      invokeToolWithEffectTruth: invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-write-jail-1",
      turnId: randomUUID(),
      userMessageId: "msg-write-jail-1",
      content: "Use `fs.write` to save Draft Notes.md in the local workspace.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Use `fs.write` to save Draft Notes.md in the local workspace." }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(invokeTool.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        toolName: "fs.write",
        args: expect.objectContaining({
          path: "./workspace/goatcitadel_out/draft-notes-sess-write-jail-1.md",
          content: "hello",
        }),
      }),
    );
    expect(result.turnTrace.toolRuns[0]).toEqual(
      expect.objectContaining({
        status: "executed",
        result: expect.objectContaining({
          fallbackApplied: true,
          fallbackPath: "./workspace/goatcitadel_out/draft-notes-sess-write-jail-1.md",
          originalPath: "Draft Notes.md",
        }),
      }),
    );
  });

  it("marks the turn cancelled when execution is aborted mid-run", async () => {
    const controller = new AbortController();
    const createChatCompletion = vi.fn(async (_request: ChatCompletionRequest) => {
      controller.abort();
      throw new Error("Chat turn cancelled.");
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-cancel-1",
      turnId: randomUUID(),
      userMessageId: "msg-user-cancel-1",
      content: "Stop this turn.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Stop this turn." }],
      signal: controller.signal,
    });

    expect(result.turnTrace.status).toBe("cancelled");
    expect(result.assistantContent).toBe("");
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("trips circuit breaker for repeated non-retryable tool failures", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValue(toolCallCompletion("latest ai tooling"));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "blocked",
      policyReason: "permission denied",
      auditEventId: "audit-2",
      result: {},
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-2",
      turnId: randomUUID(),
      userMessageId: "msg-user-2",
      content: "Search the web for latest ai tooling",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search the web for latest ai tooling" }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(3);
    expect(result.assistantContent).toContain("exhausted the current tool approaches");
    expect(result.assistantContent).toContain("don't have solid results yet");
    expect(result.assistantContent).not.toContain("Reason:");
    expect(result.assistantContent).not.toContain("permission denied");
    expect(result.turnTrace.failure?.recommendedAction).toBe("retry_narrower");
  });

  it("emits a warning loop event for repeated identical tool calls when detection is enabled", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("time.now", {}))
      .mockResolvedValueOnce(namedToolCallCompletion("time.now", {}))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Final answer with evidence.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-loop-warning",
      result: {
        results: [
          {
            url: "https://example.com/ai-tooling",
            title: "AI tooling",
            snippet: "Evidence from the same repeated search call.",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["time.now"]),
      createChatCompletion,
      invokeTool,
      toolLoopDetection: {
        enabled: true,
        historySize: 6,
        warningThreshold: 2,
        criticalThreshold: 4,
        globalThreshold: 6,
        detectors: {
          repeated_same_call: true,
          no_progress_polling: false,
          ping_pong: false,
        },
      },
    });

    const result = await orchestrator.run({
      sessionId: "sess-loop-warning-1",
      turnId: randomUUID(),
      userMessageId: "msg-user-loop-warning-1",
      content: "Call `time.now` twice and then summarize.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Call `time.now` twice and then summarize." }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(result.turnTrace.loopGuard?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detector: "repeated_same_call",
          severity: "warning",
          suppressed: false,
        }),
      ]),
    );
  });

  it("suppresses further tool execution when repeated identical calls hit the critical threshold", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("time.now", {}))
      .mockResolvedValueOnce(namedToolCallCompletion("time.now", {}))
      .mockResolvedValueOnce(namedToolCallCompletion("time.now", {}));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-loop-critical",
      result: {
        results: [
          {
            url: "https://example.com/ai-tooling",
            title: "AI tooling",
            snippet: "Evidence from the same repeated search call.",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["time.now"]),
      createChatCompletion,
      invokeTool,
      toolLoopDetection: {
        enabled: true,
        historySize: 6,
        warningThreshold: 2,
        criticalThreshold: 3,
        globalThreshold: 5,
        detectors: {
          repeated_same_call: true,
          no_progress_polling: false,
          ping_pong: false,
        },
      },
    });

    const result = await orchestrator.run({
      sessionId: "sess-loop-critical-1",
      turnId: randomUUID(),
      userMessageId: "msg-user-loop-critical-1",
      content: "Keep calling `time.now` until the loop guard stops the repeated call.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Keep calling `time.now` until the loop guard stops the repeated call." },
      ],
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(result.turnTrace.loopGuard?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detector: "repeated_same_call",
          severity: "critical",
          suppressed: true,
        }),
      ]),
    );
    expect(result.assistantContent).toContain("strongest");
    expect(result.turnTrace.failure?.failureClass).toBe("tool_loop_guard");
  });

  it("suppresses no-progress polling after repeated identical status results", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("session.status", {}))
      .mockResolvedValueOnce(namedToolCallCompletion("session.status", {}))
      .mockResolvedValueOnce(namedToolCallCompletion("session.status", {}));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-no-progress",
      result: { status: "still_running", activeStep: "polling" },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["session.status"]),
      createChatCompletion,
      invokeTool,
      toolLoopDetection: {
        enabled: true,
        historySize: 6,
        warningThreshold: 2,
        criticalThreshold: 3,
        globalThreshold: 5,
        detectors: {
          repeated_same_call: false,
          no_progress_polling: true,
          ping_pong: false,
        },
      },
    });

    const result = await orchestrator.run({
      sessionId: "sess-loop-no-progress-1",
      turnId: randomUUID(),
      userMessageId: "msg-loop-no-progress-1",
      content: "Use `session.status` to check whether the session status changed.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Use `session.status` to check whether the session status changed." }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(result.turnTrace.loopGuard?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detector: "no_progress_polling",
          severity: "critical",
          suppressed: true,
        }),
      ]),
    );
    expect(result.turnTrace.failure?.failureClass).toBe("tool_loop_guard");
  });

  it("ranks simultaneous loop-guard candidates without suppressing warning-level execution", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("session.status", {}))
      .mockResolvedValueOnce(namedToolCallCompletion("session.status", {}))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Status checked twice.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-loop-rank",
      result: { status: "still_running" },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["session.status"]),
      createChatCompletion,
      invokeTool,
      toolLoopDetection: {
        enabled: true,
        historySize: 6,
        warningThreshold: 2,
        criticalThreshold: 4,
        globalThreshold: 6,
        detectors: {
          repeated_same_call: true,
          no_progress_polling: true,
          ping_pong: false,
        },
      },
    });

    const result = await orchestrator.run({
      sessionId: "sess-loop-rank-1",
      turnId: randomUUID(),
      userMessageId: "msg-loop-rank-1",
      content: "Use `session.status` twice and then summarize.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Use `session.status` twice and then summarize." }],
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(result.assistantContent).toContain("Status checked twice");
    expect(result.turnTrace.loopGuard?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          suppressed: false,
          repetitionCount: 2,
        }),
      ]),
    );
  });

  it("emits ping-pong loop warnings for alternating tool oscillation", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("session.status", {}))
      .mockResolvedValueOnce(namedToolCallCompletion("time.now", {}))
      .mockResolvedValueOnce(namedToolCallCompletion("session.status", {}))
      .mockResolvedValueOnce(namedToolCallCompletion("time.now", {}))
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Finished after alternating tools.",
            },
          },
        ],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockImplementation(async (request) => ({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: `audit-${request.toolName}`,
      result: request.toolName === "session.status" ? { status: "running" } : { iso: "2026-05-14T00:00:00.000Z" },
    }));
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["session.status", "time.now"]),
      createChatCompletion,
      invokeTool,
      toolLoopDetection: {
        enabled: true,
        historySize: 6,
        warningThreshold: 4,
        criticalThreshold: 6,
        globalThreshold: 8,
        detectors: {
          repeated_same_call: false,
          no_progress_polling: false,
          ping_pong: true,
        },
      },
    });

    const result = await orchestrator.run({
      sessionId: "sess-loop-ping-pong-1",
      turnId: randomUUID(),
      userMessageId: "msg-loop-ping-pong-1",
      content: "Alternate `session.status` and `time.now` checks while monitoring the run.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Alternate `session.status` and `time.now` checks while monitoring the run." },
      ],
    });

    expect(invokeTool).toHaveBeenCalledTimes(4);
    expect(result.assistantContent).toContain("Finished after alternating tools");
    expect(result.turnTrace.loopGuard?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detector: "ping_pong",
          severity: "warning",
          suppressed: false,
          repetitionCount: 4,
        }),
      ]),
    );
  });

  it("does not trip circuit breaker at two attempts for retryable failures", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValue(toolCallCompletion("latest ai tooling"));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockRejectedValue(new Error("network timeout"));
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-3",
      turnId: randomUUID(),
      userMessageId: "msg-user-3",
      content: "Search latest AI tooling",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search latest AI tooling" }],
    });

    expect(invokeTool.mock.calls.length).toBeGreaterThan(2);
    expect(result.assistantContent).not.toContain("I hit the same tool issue repeatedly");
    expect(result.assistantContent).not.toContain("Reason:");
    expect(result.assistantContent).not.toContain("What I need from you next");
  });

  it("marks tool-run budget halts with an explicit failure class", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValue({
      model: "glm-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: new Array(13).fill(null).map((_, index) => ({
              id: `call-${index + 1}`,
              type: "function",
              function: {
                name: "browser_search",
                arguments: JSON.stringify({ query: `latest ai tooling ${index + 1}` }),
              },
            })),
          },
        },
      ],
    });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-tool-run-budget",
      result: {
        results: [
          {
            url: "https://example.com/ai-tooling",
            title: "AI tooling",
            snippet: "Evidence from repeated search calls.",
          },
        ],
      },
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
      toolLoopDetection: {
        enabled: false,
        historySize: 6,
        warningThreshold: 2,
        criticalThreshold: 4,
        globalThreshold: 6,
        detectors: {
          repeated_same_call: true,
          no_progress_polling: true,
          ping_pong: true,
        },
      },
    });

    const result = await orchestrator.run({
      sessionId: "sess-tool-run-budget-1",
      turnId: randomUUID(),
      userMessageId: "msg-tool-run-budget-1",
      content: "Search the web for AI tooling references repeatedly.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search the web for AI tooling references repeatedly." }],
    });

    expect(result.turnTrace.failure?.failureClass).toBe("tool_run_budget_exceeded");
  });

  it("maps auth failures to reconnect auth recovery guidance", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockRejectedValue(new Error("401 unauthorized"));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-auth-1",
      turnId: randomUUID(),
      userMessageId: "msg-user-auth-1",
      content: "Use the locked provider.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Use the locked provider." }],
    });

    expect(result.turnTrace.status).toBe("failed");
    expect(result.turnTrace.failure?.failureClass).toBe("auth_required");
    expect(result.turnTrace.failure?.recommendedAction).toBe("reconnect_auth");
    expect(result.assistantContent).toContain("needs valid auth");
  });

  it.each([
    {
      errorMessage: "provider timed out waiting for completion",
      failureClass: "provider_timeout",
      expectedContent: "timed out",
    },
    {
      errorMessage: "fetch failed: socket hang up",
      failureClass: "network_interrupted",
      expectedContent: "interrupted",
    },
  ])("maps provider errors to $failureClass turn failures", async ({ errorMessage, failureClass, expectedContent }) => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockRejectedValue(new Error(errorMessage));
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      createChatCompletion,
      invokeTool: vi.fn<() => Promise<ToolInvokeResult>>(),
    });

    const result = await orchestrator.run({
      sessionId: `sess-${failureClass}`,
      turnId: randomUUID(),
      userMessageId: `msg-user-${failureClass}`,
      content: "Answer with the current provider.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Answer with the current provider." }],
    });

    expect(result.turnTrace.status).toBe("failed");
    expect(result.turnTrace.failure).toEqual(
      expect.objectContaining({
        failureClass,
        message: errorMessage,
      }),
    );
    expect(result.assistantContent).toContain(expectedContent);
  });
});

function multiToolCallCompletion(
  calls: Array<{ toolName: string; args: Record<string, unknown> }>,
): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: calls.map((call, index) => ({
            id: `call-${index + 1}`,
            type: "function",
            function: {
              name: call.toolName.replace(/\./g, "_"),
              arguments: JSON.stringify(call.args),
            },
          })),
        },
      },
    ],
  };
}
