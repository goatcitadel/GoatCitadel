import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import { createChatCompletion, createChatCompletionStream, type LlmCompletionHost } from "./llm-completion-service.js";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

function createRequest(): ChatCompletionRequest {
  return {
    messages: [{ role: "user", content: "hello" }],
  } as ChatCompletionRequest;
}

function createHost(
  streamFactory: (request: ChatCompletionRequest) => AsyncGenerator<Record<string, unknown>>,
  fallbacks: Array<{ providerId: string; model: string }> = [{ providerId: "backup", model: "backup-model" }],
): LlmCompletionHost {
  return {
    config: {
      assistant: {
        memory: {
          enabled: false,
          qmd: {
            enabled: false,
            applyToChat: false,
          },
        },
      },
    } as never,
    memoryLifecycleService: {
      composeContext: vi.fn(),
    } as never,
    hooksService: {
      runInlineHooks: vi.fn(async () => ({ runs: [] })),
      enqueueAfterHooks: vi.fn(),
    } as never,
    llmService: {
      chatCompletions: vi.fn(),
      chatCompletionsStream: vi.fn((request: ChatCompletionRequest) => streamFactory(request)),
      getRuntimeConfig: vi.fn(() => ({
        activeProviderId: "primary",
        activeModel: "primary-model",
        providers: [
          { providerId: "primary", defaultModel: "primary-model" },
          { providerId: "backup", defaultModel: "backup-model" },
        ],
      })),
      resolveExecutionApiStyle: vi.fn((providerId: string, model: string) => `${providerId}:${model}`),
    } as never,
    resolveMemoryWorkspaceRelativeDir: vi.fn(() => "workspace"),
    resolveChatCompletionHookWorkspaceId: vi.fn(() => "workspace"),
    parseLlmModelSelectHookPatch: vi.fn(),
    parseLlmRequestHookPatch: vi.fn(),
    mergeLlmRequestHookPatch: vi.fn(),
    applyLlmRequestHookPatch: vi.fn(),
    persistContextManifestForCompletionRequest: vi.fn(),
    resolveFallbackTargets: vi.fn(() => fallbacks),
    recordDevDiagnostic: vi.fn(),
    publishRealtime: vi.fn(),
  } as unknown as LlmCompletionHost;
}

function createCompletionHost(input: {
  completion: (request: ChatCompletionRequest) => Promise<Record<string, unknown>>;
  memoryEnabled?: boolean;
  fallbacks?: Array<{ providerId: string; model: string }>;
}): LlmCompletionHost {
  const memoryContext = {
    contextId: "ctx-1",
    originalTokenEstimate: 1000,
    distilledTokenEstimate: 250,
    citations: [{ title: "Memory source" }],
    quality: { status: "fresh" },
    sections: [{ title: "Relevant memory", content: "Use concise answers." }],
  };
  return {
    config: {
      assistant: {
        memory: {
          enabled: input.memoryEnabled ?? false,
          qmd: {
            enabled: input.memoryEnabled ?? false,
            applyToChat: input.memoryEnabled ?? false,
          },
        },
      },
    } as never,
    memoryLifecycleService: {
      composeContext: vi.fn(async () => memoryContext),
    } as never,
    hooksService: {
      runInlineHooks: vi.fn(async () => ({ runs: [] })),
      enqueueAfterHooks: vi.fn(),
    } as never,
    llmService: {
      chatCompletions: vi.fn(input.completion),
      chatCompletionsStream: vi.fn(),
      getRuntimeConfig: vi.fn(() => ({
        activeProviderId: "primary",
        activeModel: "primary-model",
        providers: [
          { providerId: "primary", defaultModel: "primary-model" },
          { providerId: "backup", defaultModel: "backup-model" },
        ],
      })),
      resolveExecutionApiStyle: vi.fn((providerId: string, model: string) => `${providerId}:${model}`),
    } as never,
    resolveMemoryWorkspaceRelativeDir: vi.fn(() => "workspace"),
    resolveChatCompletionHookWorkspaceId: vi.fn(() => "workspace"),
    persistContextManifestForCompletionRequest: vi.fn(),
    resolveFallbackTargets: vi.fn(() => input.fallbacks ?? [{ providerId: "backup", model: "backup-model" }]),
    recordDevDiagnostic: vi.fn(),
    publishRealtime: vi.fn(),
  } as unknown as LlmCompletionHost;
}

async function collectStream(stream: AsyncGenerator<Record<string, unknown>>): Promise<{
  chunks: Array<Record<string, unknown>>;
  error: Error | undefined;
}> {
  const chunks: Array<Record<string, unknown>> = [];
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return { chunks, error: undefined };
  } catch (error) {
    return {
      chunks,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

describe("createChatCompletionStream", () => {
  it("does not retry a tool-protocol failure after partial output was already emitted", async () => {
    const calls: string[] = [];
    const host = createHost(async function* (request) {
      calls.push(`${request.providerId ?? "primary"}:${request.model ?? "primary-model"}`);
      yield {
        choices: [{ delta: { content: "hello " } }],
      };
      throw new Error("invalid_request_error: tool_calls payload invalid");
    });

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(calls).toEqual(["primary:primary-model"]);
    expect(result.chunks).toEqual([
      {
        choices: [{ delta: { content: "hello " } }],
      },
    ]);
    expect(result.error?.message).toContain("invalid_request_error");
  });

  it("does not start a fallback provider stream after a partial primary stream failure", async () => {
    const calls: string[] = [];
    const host = createHost(async function* (request) {
      const providerId = request.providerId ?? "primary";
      const model = request.model ?? (providerId === "primary" ? "primary-model" : "backup-model");
      calls.push(`${providerId}:${model}`);
      yield {
        choices: [{ delta: { content: providerId === "primary" ? "primary " : "fallback " } }],
      };
      throw new Error("fetch failed");
    });

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(calls).toEqual(["primary:primary-model"]);
    expect(result.chunks).toEqual([
      {
        choices: [{ delta: { content: "primary " } }],
      },
    ]);
    expect(result.error?.message).toContain("fetch failed");
  });

  it("emits lifecycle hook events around streaming prompt build, request, and completion", async () => {
    const host = createHost(async function* () {
      yield {
        choices: [{ delta: { content: "hello" } }],
      };
    });

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(result.error).toBeUndefined();
    expect(host.hooksService.runInlineHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "before_prompt_build",
        payload: expect.objectContaining({
          messageCount: 1,
        }),
      }),
    );
    expect(host.hooksService.runInlineHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "llm_input",
        payload: expect.objectContaining({
          messageCount: 1,
          toolCount: 0,
          stream: true,
        }),
      }),
    );
    expect(host.hooksService.enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "llm_output",
        payload: expect.objectContaining({
          fallbackUsed: false,
          stream: true,
        }),
      }),
    );
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion_stream.start",
        runtimeKind: "model.call",
        runtimeStatus: "started",
      }),
    );
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion_stream.complete",
        runtimeKind: "model.call",
        runtimeStatus: "completed",
      }),
    );
  });

  it("streams from a fallback provider when the primary fails before emitting output", async () => {
    const calls: string[] = [];
    const host = createHost(async function* (request) {
      const providerId = request.providerId ?? "primary";
      const model = request.model ?? (providerId === "primary" ? "primary-model" : "backup-model");
      calls.push(`${providerId}:${model}`);
      if (providerId !== "backup") {
        throw new Error("primary hard fail");
      }
      yield {
        choices: [{ delta: { content: "fallback stream" } }],
      };
    });

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(result.error).toBeUndefined();
    expect(calls).toContain("backup:backup-model");
    expect(result.chunks).toEqual([
      {
        choices: [{ delta: { content: "fallback stream" } }],
      },
      expect.objectContaining({
        routing: expect.objectContaining({
          fallbackUsed: true,
          fallbackProviderId: "backup",
          fallbackModel: "backup-model",
          fallbackReason: "primary failed (primary hard fail)",
          effectiveProviderId: "backup",
        }),
      }),
    ]);
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion_stream.attempt_failed",
        runtimeStatus: "degraded",
      }),
    );
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "system",
      "llm",
      expect.objectContaining({
        type: "chat_completion_stream",
        fallbackUsed: true,
        fallbackProviderId: "backup",
      }),
    );
  });

  it("reports final stream failure when every provider fails before output", async () => {
    const host = createHost(async function* () {
      yield* [] as Iterable<never>;
      throw new Error("all providers unavailable");
    }, []);

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(result.chunks).toEqual([]);
    expect(result.error?.message).toContain("all providers unavailable");
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion_stream.failed",
        runtimeStatus: "failed",
        runtimeError: expect.objectContaining({
          message: "all providers unavailable",
        }),
      }),
    );
    expect(host.publishRealtime).not.toHaveBeenCalled();
  });
});

describe("createChatCompletion", () => {
  it("applies model-selection and request hook patches before the provider call", async () => {
    const host = createCompletionHost({
      completion: async (request) => ({
        model: request.model ?? "primary-model",
        choices: [{ index: 0, message: { role: "assistant", content: "hooked" }, finish_reason: "stop" }],
      }),
    });
    const runInlineHooks = vi.fn(
      async (options: {
        trigger: string;
        parsePatch?: (value: Record<string, unknown>) => unknown;
        mergePatch?: (current: unknown, next: never) => unknown;
      }) => {
        if (options.trigger === "llm.model.select.before") {
          const parsed = options.parsePatch?.({ providerId: " primary ", model: " patched-model " });
          return { runs: [], patch: options.mergePatch?.(undefined, parsed as never) ?? parsed };
        }
        if (options.trigger === "llm.request.before") {
          const first = options.parsePatch?.({
            metadata: { first: true },
            prependMessages: [{ role: "system", content: "prepended" }],
          });
          const second = options.parsePatch?.({
            metadata: { second: true },
            appendMessages: [{ role: "user", content: "appended" }],
            tools: [{ type: "function", function: { name: "lookup" } }],
            toolChoice: "auto",
          });
          return { runs: [], patch: options.mergePatch?.(first, second as never) ?? second };
        }
        return { runs: [] };
      },
    );
    host.hooksService.runInlineHooks = runInlineHooks as never;

    const response = await createChatCompletion(host, {
      ...createRequest(),
      metadata: { original: true },
    });

    expect(host.llmService.chatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "primary",
        model: "patched-model",
        metadata: { original: true, first: true, second: true },
        tool_choice: "auto",
        tools: [{ type: "function", function: { name: "lookup" } }],
        messages: [
          { role: "system", content: "prepended" },
          { role: "user", content: "hello" },
          { role: "user", content: "appended" },
        ],
      }),
    );
    expect(response.routing).toEqual(
      expect.objectContaining({
        effectiveModel: "patched-model",
        primaryModel: "patched-model",
      }),
    );
  });

  it("stops before persistence when a model-selection hook blocks the request", async () => {
    const host = createCompletionHost({
      completion: async () => ({
        model: "never",
        choices: [{ index: 0, message: { role: "assistant", content: "never" }, finish_reason: "stop" }],
      }),
    });
    host.hooksService.runInlineHooks = vi.fn(async (options: { trigger: string }) =>
      options.trigger === "llm.model.select.before"
        ? { runs: [], blockedBy: { reason: "model disabled by policy" } }
        : { runs: [] },
    ) as never;

    await expect(createChatCompletion(host, createRequest())).rejects.toThrow("model disabled by policy");

    expect(host.persistContextManifestForCompletionRequest).not.toHaveBeenCalled();
    expect(host.llmService.chatCompletions).not.toHaveBeenCalled();
  });

  it("attaches memory context, lifecycle hooks, realtime routing, and response metadata", async () => {
    const host = createCompletionHost({
      memoryEnabled: true,
      completion: async (request) => ({
        model: request.model ?? "primary-model",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      }),
    });

    const response = await createChatCompletion(host, {
      ...createRequest(),
      memory: { enabled: true, mode: "auto", sessionId: "session-1", workspace: "default" },
    });

    expect(host.memoryLifecycleService.composeContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "chat",
        prompt: "hello",
        sessionId: "session-1",
        workspace: "workspace",
      }),
    );
    expect(host.persistContextManifestForCompletionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          messages: expect.arrayContaining([expect.objectContaining({ role: "system" })]),
        }),
      }),
    );
    expect(response.memoryContext).toEqual(
      expect.objectContaining({
        contextId: "ctx-1",
        cacheHit: false,
        savingsPercent: 75,
        citationsCount: 1,
      }),
    );
    expect(response.routing).toEqual(
      expect.objectContaining({
        primaryProviderId: "primary",
        effectiveProviderId: "primary",
        effectiveModel: "primary-model",
        fallbackUsed: false,
      }),
    );
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "system",
      "llm",
      expect.objectContaining({
        type: "chat_completion",
        memoryContextId: "ctx-1",
        fallbackUsed: false,
      }),
    );
    expect(host.hooksService.enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "llm.response.after",
        payload: expect.objectContaining({
          providerId: "primary",
          model: "primary-model",
        }),
      }),
    );
  });

  it("uses cross-provider fallback after primary completion failures and records diagnostics", async () => {
    const calls: string[] = [];
    const host = createCompletionHost({
      completion: async (request) => {
        const providerId = request.providerId ?? "primary";
        const model = request.model ?? (providerId === "primary" ? "primary-model" : "backup-model");
        calls.push(`${providerId}:${model}`);
        if (providerId === "primary") {
          throw new Error("primary offline");
        }
        return {
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "fallback" }, finish_reason: "stop" }],
        };
      },
    });

    const response = await createChatCompletion(host, createRequest());

    expect(calls).toContain("backup:backup-model");
    expect(response.routing).toEqual(
      expect.objectContaining({
        fallbackUsed: true,
        fallbackProviderId: "backup",
        fallbackModel: "backup-model",
        effectiveProviderId: "backup",
      }),
    );
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion.fallback_applied",
        providerId: "backup",
        modelId: "backup-model",
      }),
    );
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "system",
      "llm",
      expect.objectContaining({
        fallbackUsed: true,
        fallbackProviderId: "backup",
        fallbackModel: "backup-model",
      }),
    );
  });

  it("records a failed completion diagnostic when all attempts fail and fallback is unavailable", async () => {
    const host = createCompletionHost({
      fallbacks: [],
      completion: async () => {
        throw new Error("provider exhausted");
      },
    });

    await expect(createChatCompletion(host, createRequest())).rejects.toThrow("provider exhausted");

    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion.failed",
        runtimeStatus: "failed",
        runtimeError: expect.objectContaining({
          message: "provider exhausted",
        }),
      }),
    );
    expect(host.publishRealtime).not.toHaveBeenCalled();
  });
});
