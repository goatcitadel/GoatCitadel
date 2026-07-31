import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ModelUsageAttributionContext } from "@goatcitadel/contracts";
import { ModelUsageDispatchPersistenceError, ModelUsageDispatchUncertainError } from "@goatcitadel/gateway-core";
import { ChatTurnCancelledError } from "./chat-turn-helpers.js";
import { CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT } from "./llm-completion-helpers.js";
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
      hasMutateHook: vi.fn(() => false),
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
    contextText: "Use concise answers.",
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
      hasMutateHook: vi.fn(() => false),
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
  it.each(["ModelUsageDispatchUncertainError", "ModelUsageSettlementError", "ModelUsageDispatchPersistenceError"])(
    "never retries or falls back after canonical usage persistence fails (%s)",
    async (errorName) => {
      const settlementError = new Error("canonical settlement failed after tool call timeout 503");
      settlementError.name = errorName;
      let calls = 0;
      const host = createHost(async function* () {
        calls += 1;
        const unreachableChunks: Record<string, unknown>[] = [];
        yield* unreachableChunks;
        throw settlementError;
      });

      const result = await collectStream(createChatCompletionStream(host, createRequest()));

      expect(calls).toBe(1);
      expect(result.chunks).toEqual([]);
      expect(result.error).toBe(settlementError);
    },
  );

  it("never retries or falls back after accepted lease renewal persistence fails", async () => {
    const renewalError = new ModelUsageDispatchPersistenceError(
      "usage-renewal-fault",
      "renew_accepted_lease",
      new Error("accepted lease renewal write failed"),
    );
    let calls = 0;
    const host = createHost(async function* () {
      calls += 1;
      const unreachableChunks: Record<string, unknown>[] = [];
      yield* unreachableChunks;
      throw renewalError;
    });

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(calls).toBe(1);
    expect(result.chunks).toEqual([]);
    expect(result.error).toBe(renewalError);
    expect(host.resolveFallbackTargets).not.toHaveBeenCalled();
  });

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

    expect(calls.every((call) => call === "primary:primary-model")).toBe(true);
    expect(calls).not.toContain("backup:backup-model");
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

    expect(calls.every((call) => call === "primary:primary-model")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls).not.toContain("backup:backup-model");
    expect(result.chunks).toEqual([
      {
        choices: [{ delta: { content: "primary " } }],
      },
    ]);
    expect(result.error?.message).toContain("fetch failed");
  });

  it("retries an exact provider server_error before output and then streams successfully", async () => {
    let calls = 0;
    const host = createHost(async function* () {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("responses stream failed: server_error - temporary provider failure"), {
          providerFailure: { code: "server_error", message: "temporary provider failure" },
        });
      }
      yield { choices: [{ delta: { content: "recovered" } }] };
    }, []);

    const result = await collectStream(
      createChatCompletionStream(host, {
        ...createRequest(),
        memory: {
          enabled: false,
          sessionId: "session-server-error",
          turnId: "turn-server-error",
          runId: "run-server-error",
        },
      }),
    );

    expect(calls).toBe(2);
    expect(result.error).toBeUndefined();
    expect(result.chunks[0]).toEqual({ choices: [{ delta: { content: "recovered" } }] });
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion_stream.attempt_failed",
        context: expect.objectContaining({
          emittedOutput: false,
          failureClass: "transient",
          sessionId: "session-server-error",
          turnId: "turn-server-error",
          durableRunId: "run-server-error",
        }),
      }),
    );
  });

  it("does not dispatch a transient retry after the operator cancels during pre-output backoff", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const cancellation = new ChatTurnCancelledError("turn-cancelled", "Chat turn cancelled by operator.");
      let calls = 0;
      const host = createHost(async function* () {
        calls += 1;
        if (calls > 1) {
          yield { choices: [{ delta: { content: "must not dispatch" } }] };
          return;
        }
        throw Object.assign(new Error("responses stream failed: server_error - temporary provider failure"), {
          providerFailure: { code: "server_error", message: "temporary provider failure" },
        });
      }, []);

      const resultPromise = collectStream(
        createChatCompletionStream(host, {
          ...createRequest(),
          signal: controller.signal,
          memory: {
            enabled: false,
            sessionId: "session-cancelled",
            turnId: "turn-cancelled",
            runId: "run-cancelled",
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      controller.abort(cancellation);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(calls).toBe(1);
      expect(result.chunks).toEqual([]);
      expect(result.error).toBe(cancellation);
      expect(host.resolveFallbackTargets).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses every secondary dispatch when 4551ms cannot fund backoff plus the minimum window", async () => {
    let calls = 0;
    const failure = Object.assign(new Error("responses stream failed: server_error - temporary provider failure"), {
      providerFailure: { code: "server_error", message: "temporary provider failure" },
    });
    const host = createHost(async function* () {
      calls += 1;
      yield* [];
      throw failure;
    });

    const result = await collectStream(
      createChatCompletionStream(host, {
        ...createRequest(),
        timeoutMs: 4_551,
        memory: {
          enabled: false,
          sessionId: "session-near-expiry",
          turnId: "turn-near-expiry",
          runId: "run-near-expiry",
        },
      }),
    );

    expect(calls).toBe(1);
    expect(result.error).toBe(failure);
    expect(host.resolveFallbackTargets).toHaveBeenCalledOnce();
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion_stream.failed",
        context: expect.objectContaining({
          emittedOutput: false,
          failureClass: "transient",
          remainingBudgetMs: expect.any(Number),
          sessionId: "session-near-expiry",
          turnId: "turn-near-expiry",
          durableRunId: "run-near-expiry",
        }),
      }),
    );
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

  it("records the provider-returned model for a primary stream", async () => {
    const host = createHost(async function* () {
      yield {
        model: "primary-model-actual",
        choices: [{ delta: { content: "primary stream" } }],
      };
    });

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(result.error).toBeUndefined();
    expect(result.chunks.at(-1)).toEqual(
      expect.objectContaining({
        routing: expect.objectContaining({
          effectiveProviderId: "primary",
          effectiveModel: "primary-model-actual",
        }),
      }),
    );
    expect(host.llmService.resolveExecutionApiStyle).toHaveBeenLastCalledWith("primary", "primary-model");
  });

  it("records the provider-returned model for a fallback stream", async () => {
    const host = createHost(async function* (request) {
      if ((request.providerId ?? "primary") === "primary") {
        throw new Error("primary hard fail");
      }
      yield {
        model: "backup-model-actual",
        choices: [{ delta: { content: "fallback stream" } }],
      };
    });

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(result.error).toBeUndefined();
    expect(result.chunks.at(-1)).toEqual(
      expect.objectContaining({
        routing: expect.objectContaining({
          fallbackProviderId: "backup",
          fallbackModel: "backup-model-actual",
          effectiveProviderId: "backup",
          effectiveModel: "backup-model-actual",
        }),
      }),
    );
    expect(host.llmService.resolveExecutionApiStyle).toHaveBeenLastCalledWith("backup", "backup-model");
  });

  it("keeps Codex API-style resolution on the dispatched prefixed model while recording the returned alias", async () => {
    const host = createHost(async function* () {
      yield {
        model: "gpt-5.6",
        choices: [{ delta: { content: "codex stream" } }],
      };
    });
    host.llmService.getRuntimeConfig = vi.fn(() => ({
      activeProviderId: "openai-codex",
      activeModel: "openai-codex/gpt-5.6",
      providers: [{ providerId: "openai-codex", defaultModel: "gpt-5.5" }],
    })) as never;
    host.llmService.resolveExecutionApiStyle = vi.fn((providerId: string, model: string) => {
      if (providerId === "openai-codex" && !model.startsWith("openai-codex/")) {
        throw new Error("unprefixed future Codex alias is not locally catalogued");
      }
      return "openai-codex-responses";
    }) as never;

    const result = await collectStream(
      createChatCompletionStream(host, {
        ...createRequest(),
        providerId: "openai-codex",
        model: "openai-codex/gpt-5.6",
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.chunks.at(-1)).toEqual(
      expect.objectContaining({
        routing: expect.objectContaining({
          effectiveProviderId: "openai-codex",
          effectiveModel: "gpt-5.6",
          effectiveApiStyle: "openai-codex-responses",
        }),
      }),
    );
    expect(host.llmService.resolveExecutionApiStyle).toHaveBeenCalledWith("openai-codex", "openai-codex/gpt-5.6");
    expect(host.llmService.resolveExecutionApiStyle).not.toHaveBeenCalledWith("openai-codex", "gpt-5.6");
  });

  it("retains canonical stream event ids in the final completion envelope", async () => {
    const host = createHost(async function* () {
      yield {
        choices: [{ delta: { content: "done" } }],
        model_usage_event_id: "usage-event-1",
        model_usage_event_ids: ["usage-event-1", "usage-event-2"],
      };
    });

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(result.error).toBeUndefined();
    expect(result.chunks.at(-1)).toEqual(
      expect.objectContaining({ model_usage_event_ids: ["usage-event-1", "usage-event-2"] }),
    );
  });

  it("skips same-provider stream fallback candidates", async () => {
    const calls: string[] = [];
    const host = createHost(
      async function* (request) {
        const providerId = request.providerId ?? "primary";
        const model = request.model ?? (providerId === "primary" ? "primary-model" : "backup-model");
        calls.push(`${providerId}:${model}`);
        if (providerId !== "backup") {
          throw new Error("primary unavailable");
        }
        yield {
          choices: [{ delta: { content: "backup stream" } }],
        };
      },
      [
        { providerId: "primary", model: "alternate-primary-model" },
        { providerId: "backup", model: "backup-model" },
      ],
    );

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(result.error).toBeUndefined();
    expect(calls).toContain("primary:primary-model");
    expect(calls.at(-1)).toBe("backup:backup-model");
    expect(calls).not.toContain("primary:alternate-primary-model");
    expect(result.chunks.at(-1)).toEqual(
      expect.objectContaining({
        routing: expect.objectContaining({
          fallbackUsed: true,
          fallbackProviderId: "backup",
        }),
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

  it("reports stream retry/cooldown exhaustion explicitly for rate limits before output", async () => {
    const host = createHost(async function* () {
      yield* [] as Iterable<never>;
      throw new Error("provider failed (429): too many requests");
    }, []);

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(result.chunks).toEqual([]);
    expect(result.error?.name).toBe("ProviderRetryCooldownExhaustedError");
    expect(result.error?.message).toContain("Provider retry/cooldown budget exhausted for primary/primary-model");
    expect(result.error?.message).toContain("provider failed (429): too many requests");
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion_stream.failed",
        runtimeStatus: "failed",
        runtimeError: expect.objectContaining({
          name: "ProviderRetryCooldownExhaustedError",
          retryable: false,
        }),
        context: expect.objectContaining({
          retryCooldownExhausted: true,
        }),
      }),
    );
    expect(host.publishRealtime).not.toHaveBeenCalled();
    // A burst rate limit is worth re-attempting inside the ladder.
    expect(vi.mocked(host.llmService.chatCompletionsStream)).toHaveBeenCalledTimes(
      CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT,
    );
  });

  it("dispatches an exhausted provider quota exactly once instead of walking the retry ladder", async () => {
    const host = createHost(async function* () {
      yield* [] as Iterable<never>;
      throw new Error(
        'responses request failed (429 Too Many Requests): {"error":{"type":"usage_limit_reached",' +
          '"message":"The usage limit has been reached","plan_type":"pro","resets_at":1785929657,' +
          '"eligible_promo":null,"resets_in_seconds":393613}}',
      );
    }, []);

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    // The quota resets in ~4.5 days; every extra dispatch is spent against a wall.
    expect(vi.mocked(host.llmService.chatCompletionsStream)).toHaveBeenCalledTimes(1);
    expect(result.chunks).toEqual([]);
    expect(result.error?.name).toBe("ProviderRetryCooldownExhaustedError");
    expect(result.error?.message).toContain("usage_limit_reached");
    expect(host.publishRealtime).not.toHaveBeenCalled();
  });

  it("blocks streaming chat completion when gateway.dispatch.before intercepts", async () => {
    const host = createHost(async function* () {
      yield {
        choices: [{ delta: { content: "should-not-emit" } }],
      };
    });
    host.hooksService.runInlineHooks = vi.fn(async (options: { trigger: string }) =>
      options.trigger === "gateway.dispatch.before"
        ? { runs: [], blockedBy: { type: "block", reason: "policy: stream-blocked" } }
        : { runs: [] },
    ) as never;

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(result.error?.message).toMatch(/stream-blocked/);
    expect(host.llmService.chatCompletionsStream).not.toHaveBeenCalled();
    expect(host.persistContextManifestForCompletionRequest).not.toHaveBeenCalled();
  });

  it("buffers stream and replays patched content when a mutate hook is registered", async () => {
    const host = createHost(async function* () {
      yield { choices: [{ delta: { content: "raw " } }] };
      yield { choices: [{ delta: { content: "stream " } }] };
      yield { choices: [{ delta: { content: "output" } }] };
    });
    host.hooksService.hasMutateHook = vi.fn(
      (_workspaceId: string, trigger: string) => trigger === "transform_llm_output",
    ) as never;
    host.hooksService.runInlineHooks = vi.fn(
      async (options: { trigger: string; parsePatch?: (value: Record<string, unknown>) => unknown }) => {
        if (options.trigger === "transform_llm_output") {
          const patch = options.parsePatch?.({ content: "PATCHED" });
          return { runs: [], patch };
        }
        return { runs: [] };
      },
    ) as never;

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(result.error).toBeUndefined();
    const deltas = result.chunks
      .map((chunk) => {
        const choices = (chunk as { choices?: Array<{ delta?: { content?: unknown } }> }).choices;
        const delta = choices?.[0]?.delta?.content;
        return typeof delta === "string" ? delta : undefined;
      })
      .filter((value): value is string => Boolean(value));
    // In buffered mode the consumer should see ONLY the patched content, not the raw chunks.
    expect(deltas.join("")).toBe("PATCHED");
    expect(deltas).not.toContain("raw ");
    expect(deltas).not.toContain("stream ");
    expect(deltas).not.toContain("output");
  });

  it("falls through to passthrough+veto-only when no mutate hook is registered", async () => {
    const host = createHost(async function* () {
      yield { choices: [{ delta: { content: "raw " } }] };
      yield { choices: [{ delta: { content: "stream" } }] };
    });
    // hasMutateHook defaults to false in createHost — assert the contract explicitly.
    host.hooksService.hasMutateHook = vi.fn(() => false) as never;
    // The transform_llm_output hook still fires veto-only; a content patch would be ignored.
    host.hooksService.runInlineHooks = vi.fn(
      async (options: { trigger: string; parsePatch?: (value: Record<string, unknown>) => unknown }) => {
        if (options.trigger === "transform_llm_output") {
          const patch = options.parsePatch?.({ content: "SHOULD_BE_IGNORED" });
          return { runs: [], patch };
        }
        return { runs: [] };
      },
    ) as never;

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(result.error).toBeUndefined();
    const deltas = result.chunks
      .map((chunk) => {
        const choices = (chunk as { choices?: Array<{ delta?: { content?: unknown } }> }).choices;
        const delta = choices?.[0]?.delta?.content;
        return typeof delta === "string" ? delta : undefined;
      })
      .filter((value): value is string => Boolean(value));
    expect(deltas.join("")).toBe("raw stream");
  });

  it("records passthrough transform vetoes as failed after emitted stream output", async () => {
    const host = createHost(async function* () {
      yield { choices: [{ delta: { content: "raw " } }] };
      yield { choices: [{ delta: { content: "stream" } }] };
    });
    host.hooksService.hasMutateHook = vi.fn(() => false) as never;
    host.hooksService.runInlineHooks = vi.fn(async (options: { trigger: string }) =>
      options.trigger === "transform_llm_output"
        ? { runs: [], blockedBy: { type: "block", reason: "policy: passthrough-veto" } }
        : { runs: [] },
    ) as never;

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(result.error?.message).toMatch(/passthrough-veto/);
    const deltas = result.chunks
      .map((chunk) => {
        const choices = (chunk as { choices?: Array<{ delta?: { content?: unknown } }> }).choices;
        const delta = choices?.[0]?.delta?.content;
        return typeof delta === "string" ? delta : undefined;
      })
      .filter((value): value is string => Boolean(value));
    expect(deltas.join("")).toBe("raw stream");
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion_stream.failed_after_emit",
        runtimeStatus: "failed",
        context: expect.objectContaining({
          emittedOutput: true,
          trigger: "transform_llm_output",
        }),
      }),
    );
    expect(host.recordDevDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion_stream.complete",
      }),
    );
    expect(host.publishRealtime).not.toHaveBeenCalled();
  });

  it("buffered mode still allows intercept veto", async () => {
    const host = createHost(async function* () {
      yield { choices: [{ delta: { content: "x" } }] };
    });
    host.hooksService.hasMutateHook = vi.fn(() => true) as never;
    host.hooksService.runInlineHooks = vi.fn(async (options: { trigger: string }) =>
      options.trigger === "transform_llm_output"
        ? { runs: [], blockedBy: { type: "block", reason: "policy: stream-content-blocked" } }
        : { runs: [] },
    ) as never;

    const result = await collectStream(createChatCompletionStream(host, createRequest()));

    expect(result.error?.message).toMatch(/stream-content-blocked/);
    // In buffered mode raw chunks are withheld; the veto fires before any synthetic emission.
    const deltas = result.chunks
      .map((chunk) => {
        const choices = (chunk as { choices?: Array<{ delta?: { content?: unknown } }> }).choices;
        const delta = choices?.[0]?.delta?.content;
        return typeof delta === "string" ? delta : undefined;
      })
      .filter((value): value is string => Boolean(value));
    expect(deltas).toEqual([]);
  });
});

describe("createChatCompletion", () => {
  it("keeps Codex API-style resolution on the dispatched prefixed model while recording the returned alias", async () => {
    const host = createCompletionHost({
      completion: async () => ({
        model: "gpt-5.6",
        choices: [{ index: 0, message: { role: "assistant", content: "codex response" }, finish_reason: "stop" }],
      }),
    });
    host.llmService.getRuntimeConfig = vi.fn(() => ({
      activeProviderId: "openai-codex",
      activeModel: "openai-codex/gpt-5.6",
      providers: [{ providerId: "openai-codex", defaultModel: "gpt-5.5" }],
    })) as never;
    host.llmService.resolveExecutionApiStyle = vi.fn((providerId: string, model: string) => {
      if (providerId === "openai-codex" && !model.startsWith("openai-codex/")) {
        throw new Error("unprefixed future Codex alias is not locally catalogued");
      }
      return "openai-codex-responses";
    }) as never;

    const response = await createChatCompletion(host, {
      ...createRequest(),
      providerId: "openai-codex",
      model: "openai-codex/gpt-5.6",
    });

    expect(response).toEqual(
      expect.objectContaining({
        model: "gpt-5.6",
        routing: expect.objectContaining({
          effectiveProviderId: "openai-codex",
          effectiveModel: "gpt-5.6",
          effectiveApiStyle: "openai-codex-responses",
        }),
      }),
    );
    expect(host.llmService.resolveExecutionApiStyle).toHaveBeenCalledWith("openai-codex", "openai-codex/gpt-5.6");
    expect(host.llmService.resolveExecutionApiStyle).not.toHaveBeenCalledWith("openai-codex", "gpt-5.6");
  });

  it.each(["ModelUsageDispatchUncertainError", "ModelUsageSettlementError", "ModelUsageDispatchPersistenceError"])(
    "never retries or falls back after canonical usage persistence fails (%s)",
    async (errorName) => {
      const settlementError = new Error("canonical settlement failed after tool call timeout 503");
      settlementError.name = errorName;
      const completion = vi.fn(async () => {
        throw settlementError;
      });
      const host = createCompletionHost({ completion });

      await expect(createChatCompletion(host, createRequest())).rejects.toBe(settlementError);
      expect(completion).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry or fall back when a second stable-generation invocation collides with canonical dispatch identity", async () => {
    const duplicate = new ModelUsageDispatchUncertainError(
      "Provider dispatch identity already exists (succeeded); advance dispatchGeneration before re-dispatch",
      { eventId: "usage-existing-generation" },
    );
    const completion = vi
      .fn()
      .mockResolvedValueOnce({
        model: "primary-model",
        choices: [{ index: 0, message: { role: "assistant", content: "first result" }, finish_reason: "stop" }],
      })
      .mockRejectedValueOnce(duplicate);
    const host = createCompletionHost({ completion });
    const stableAttribution = {
      operationId: "stable-operation",
      dispatchGeneration: "stable-operation:generation-1",
    };

    await createChatCompletion(host, createRequest(), stableAttribution);
    await expect(createChatCompletion(host, createRequest(), stableAttribution)).rejects.toBe(duplicate);

    expect(completion).toHaveBeenCalledTimes(2);
    expect(host.resolveFallbackTargets).not.toHaveBeenCalled();
  });

  it("uses one logical operation and explicit repair/fallback ordinals for every provider call", async () => {
    const host = createCompletionHost({
      completion: async () => ({
        model: "unused",
        choices: [{ index: 0, message: { role: "assistant", content: "unused" }, finish_reason: "stop" }],
      }),
    });
    const attributions: ModelUsageAttributionContext[] = [];
    host.llmService.chatCompletions = vi.fn(
      async (request: ChatCompletionRequest, attribution: ModelUsageAttributionContext) => {
        attributions.push(attribution);
        const providerId = request.providerId ?? "primary";
        if (providerId === "primary") throw new Error("primary hard fail");
        return {
          model: request.model ?? "backup-model",
          choices: [{ index: 0, message: { role: "assistant", content: "fallback" }, finish_reason: "stop" }],
          modelUsageEventIds: ["usage-fallback"],
        };
      },
    ) as never;
    const request = {
      ...createRequest(),
      reasoning: { effort: "high" as const },
      memory: { sessionId: "session-1", turnId: "turn-1", runId: "durable-1", taskId: "task-1" },
    };

    const response = await createChatCompletion(host, request, {
      operationId: "operation-1",
      dispatchGeneration: "generation-1",
      workspaceId: "workspace-trusted",
    });

    expect(response.modelUsageEventIds).toEqual(["usage-fallback"]);
    expect(attributions).toHaveLength(2);
    expect(attributions.map((item) => item.operationId)).toEqual(Array(2).fill("operation-1"));
    expect(attributions.map((item) => item.dispatchGeneration)).toEqual(Array(2).fill("generation-1"));
    expect(attributions.map((item) => item.attemptIndex)).toEqual([0, 1]);
    expect(attributions.map((item) => item.repairIndex)).toEqual([0, 0]);
    expect(attributions.map((item) => item.fallbackIndex)).toEqual([0, 1]);
    expect(attributions.map((item) => item.callKind)).toEqual(["chat_initial", "chat_fallback"]);
    expect(attributions.every((item) => item.requestedProviderId === "primary")).toBe(true);
    expect(attributions.every((item) => item.requestedModelId === "primary-model")).toBe(true);
    expect(attributions.every((item) => item.reasoningDisposition === "honored")).toBe(true);
    expect(attributions.every((item) => item.reasoningReasonCode === "requested_reasoning_preserved")).toBe(true);
    expect(attributions.every((item) => item.workspaceId === "workspace-trusted")).toBe(true);
    expect(attributions.every((item) => item.sessionId === "session-1")).toBe(true);
  });

  it("records provider-default reasoning when no effort was explicitly requested", async () => {
    const host = createCompletionHost({
      completion: async () => ({
        model: "primary-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
    });

    await createChatCompletion(host, createRequest());

    const attribution = (host.llmService.chatCompletions as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as
      | ModelUsageAttributionContext
      | undefined;
    expect(attribution?.reasoningDisposition).toBe("provider_default");
    expect(attribution?.reasoningReasonCode).toBe("no_explicit_reasoning_request");
  });

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
      expect.objectContaining({ callKind: "chat_initial", attemptIndex: 0 }),
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
          messages: [
            expect.objectContaining({
              role: "system",
              content: expect.stringContaining("Retrieved non-authoritative GoatCitadel memory context"),
            }),
            expect.objectContaining({ role: "user", content: "hello" }),
          ],
        }),
        memoryContextPlacement: expect.objectContaining({
          position: "before_final_user_message",
          insertedIndex: 0,
          finalUserMessageIndex: 0,
          leadingSystemMessageCount: 0,
          copyMode: "retrieved_non_authoritative",
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

  it("skips same-provider completion fallback candidates", async () => {
    const calls: string[] = [];
    const host = createCompletionHost({
      fallbacks: [
        { providerId: "primary", model: "alternate-primary-model" },
        { providerId: "backup", model: "backup-model" },
      ],
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

    expect(calls).toContain("primary:primary-model");
    expect(calls.at(-1)).toBe("backup:backup-model");
    expect(calls).not.toContain("primary:alternate-primary-model");
    expect(response.routing).toEqual(
      expect.objectContaining({
        fallbackUsed: true,
        fallbackProviderId: "backup",
        effectiveProviderId: "backup",
      }),
    );
  });

  it("does not silently fall back to a smaller model when the provider reports context overflow", async () => {
    const calls: string[] = [];
    const host = createCompletionHost({
      completion: async (request) => {
        const providerId = request.providerId ?? "primary";
        const model = request.model ?? (providerId === "primary" ? "primary-model" : "backup-model");
        calls.push(`${providerId}:${model}`);
        throw new Error("maximum context window exceeded");
      },
    });

    await expect(createChatCompletion(host, createRequest())).rejects.toThrow("maximum context window exceeded");

    expect(calls.every((call) => call === "primary:primary-model")).toBe(true);
    expect(calls).not.toContain("backup:backup-model");
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion.failed",
        runtimeStatus: "failed",
        runtimeError: expect.objectContaining({
          message: "maximum context window exceeded",
        }),
      }),
    );
    expect(host.publishRealtime).not.toHaveBeenCalledWith(
      "system",
      "llm",
      expect.objectContaining({ fallbackUsed: true }),
    );
  });

  it("records a failed completion diagnostic when all attempts fail and fallback is unavailable", async () => {
    const host = createCompletionHost({
      fallbacks: [],
      completion: async () => {
        throw new Error("provider exhausted");
      },
    });

    await expect(
      createChatCompletion(host, {
        ...createRequest(),
        memory: {
          enabled: false,
          sessionId: "session-terminal",
          turnId: "turn-terminal",
          runId: "run-terminal",
        },
      }),
    ).rejects.toThrow("provider exhausted");

    expect(host.llmService.chatCompletions).toHaveBeenCalledTimes(1);

    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion.failed",
        runtimeStatus: "failed",
        runtimeError: expect.objectContaining({
          message: "provider exhausted",
        }),
        context: expect.objectContaining({
          emittedOutput: false,
          sessionId: "session-terminal",
          turnId: "turn-terminal",
          durableRunId: "run-terminal",
        }),
      }),
    );
    expect(host.publishRealtime).not.toHaveBeenCalled();
  });

  it("uses compatibility retries only for an actual tool-protocol failure", async () => {
    const requests: ChatCompletionRequest[] = [];
    const host = createCompletionHost({
      fallbacks: [],
      completion: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          throw new Error("invalid_request_error: function name is invalid");
        }
        return {
          model: "primary-model",
          choices: [{ index: 0, message: { role: "assistant", content: "repaired" }, finish_reason: "stop" }],
        };
      },
    });
    const request = {
      ...createRequest(),
      tools: [{ type: "function" as const, function: { name: "bad tool.name" } }],
    };

    await expect(createChatCompletion(host, request)).resolves.toEqual(
      expect.objectContaining({ choices: [expect.objectContaining({ finish_reason: "stop" })] }),
    );

    expect(requests).toHaveLength(2);
    expect((requests[0]?.tools?.[0] as { function?: { name?: string } }).function?.name).toBe("bad tool.name");
    expect((requests[1]?.tools?.[0] as { function?: { name?: string } }).function?.name).toBe("bad_tool_name");
  });

  it("does not compatibility-retry a generic provider invalid-request failure", async () => {
    const requests: ChatCompletionRequest[] = [];
    const host = createCompletionHost({
      fallbacks: [],
      completion: async (request) => {
        requests.push(request);
        throw new Error("invalid_request_error: model not found");
      },
    });

    await expect(createChatCompletion(host, createRequest())).rejects.toThrow("model not found");

    expect(requests).toHaveLength(1);
  });

  it("keeps tool-protocol normalization across a transient fallback-provider retry", async () => {
    const requests: ChatCompletionRequest[] = [];
    let fallbackCalls = 0;
    const host = createCompletionHost({
      completion: async (request) => {
        requests.push(request);
        if ((request.providerId ?? "primary") === "primary") {
          throw new Error("invalid_request_error: function name is invalid");
        }
        fallbackCalls += 1;
        if (fallbackCalls === 1) throw new Error("fetch failed: ECONNRESET");
        return {
          model: "backup-model",
          choices: [{ index: 0, message: { role: "assistant", content: "repaired" }, finish_reason: "stop" }],
        };
      },
    });
    const request = {
      ...createRequest(),
      tools: [{ type: "function" as const, function: { name: "bad tool.name" } }],
    };

    await expect(createChatCompletion(host, request)).resolves.toEqual(
      expect.objectContaining({ choices: [expect.objectContaining({ finish_reason: "stop" })] }),
    );

    const fallbackRequests = requests.filter((candidate) => candidate.providerId === "backup");
    expect(fallbackRequests).toHaveLength(2);
    expect(
      fallbackRequests.map((candidate) => (candidate.tools?.[0] as { function?: { name?: string } }).function?.name),
    ).toEqual(["bad_tool_name", "bad_tool_name"]);
  });

  it("reports completion retry/cooldown exhaustion explicitly for rate limits", async () => {
    const host = createCompletionHost({
      fallbacks: [],
      completion: async () => {
        throw new Error("provider failed (429): rate limit");
      },
    });

    await expect(createChatCompletion(host, createRequest())).rejects.toThrow(
      "Provider retry/cooldown budget exhausted for primary/primary-model",
    );

    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.completion.failed",
        runtimeStatus: "failed",
        runtimeError: expect.objectContaining({
          name: "ProviderRetryCooldownExhaustedError",
          retryable: false,
        }),
        context: expect.objectContaining({
          retryCooldownExhausted: true,
        }),
      }),
    );
    expect(host.publishRealtime).not.toHaveBeenCalled();
  });

  it("fires gateway.dispatch.before before llm.request.before", async () => {
    const host = createCompletionHost({
      completion: async (request) => ({
        model: request.model ?? "primary-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
    });
    const inlineHookTriggers: string[] = [];
    host.hooksService.runInlineHooks = vi.fn(async (options: { trigger: string }) => {
      inlineHookTriggers.push(options.trigger);
      return { runs: [] };
    }) as never;

    await createChatCompletion(host, createRequest());

    const dispatchIndex = inlineHookTriggers.indexOf("gateway.dispatch.before");
    const requestIndex = inlineHookTriggers.indexOf("llm.request.before");
    expect(dispatchIndex).toBeGreaterThanOrEqual(0);
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(dispatchIndex).toBeLessThan(requestIndex);
  });

  it("blocks chat completion when gateway.dispatch.before intercepts", async () => {
    const host = createCompletionHost({
      completion: async () => ({
        model: "never",
        choices: [{ index: 0, message: { role: "assistant", content: "never" }, finish_reason: "stop" }],
      }),
    });
    host.hooksService.runInlineHooks = vi.fn(async (options: { trigger: string }) =>
      options.trigger === "gateway.dispatch.before"
        ? { runs: [], blockedBy: { reason: "dispatch blocked by policy" } }
        : { runs: [] },
    ) as never;

    await expect(createChatCompletion(host, createRequest())).rejects.toThrow("dispatch blocked by policy");

    expect(host.llmService.chatCompletions).not.toHaveBeenCalled();
    expect(host.persistContextManifestForCompletionRequest).not.toHaveBeenCalled();
  });

  it("applies transform_llm_output content override before publishing the response", async () => {
    const host = createCompletionHost({
      completion: async (request) => ({
        model: request.model ?? "primary-model",
        choices: [{ index: 0, message: { role: "assistant", content: "raw-output" }, finish_reason: "stop" }],
      }),
    });
    host.hooksService.runInlineHooks = vi.fn(
      async (options: { trigger: string; parsePatch?: (value: Record<string, unknown>) => unknown }) => {
        if (options.trigger === "transform_llm_output") {
          const patch = options.parsePatch?.({ content: "scrubbed" });
          return { runs: [], patch };
        }
        return { runs: [] };
      },
    ) as never;
    // Snapshot the after-hook payload's content AT CALL TIME so we can verify the mutation
    // happened BEFORE enqueueAfterHooks fired. Plain expect().toHaveBeenCalledWith() captures
    // the payload by reference, so a delayed mutation would still satisfy the assertion — only
    // an at-call-time read inside mockImplementation can detect reordering.
    let afterHookContentAtCall: string | undefined;
    const enqueueAfterHooksMock = host.hooksService.enqueueAfterHooks as ReturnType<typeof vi.fn>;
    enqueueAfterHooksMock.mockImplementation(
      (options: {
        trigger: string;
        payload?: { response?: { choices?: Array<{ message?: { content?: string } }> } };
      }) => {
        if (options.trigger === "llm.response.after") {
          afterHookContentAtCall = options.payload?.response?.choices?.[0]?.message?.content;
        }
      },
    );

    const response = await createChatCompletion(host, createRequest());

    expect(response.choices[0]?.message?.content).toBe("scrubbed");
    // publishRealtime fires between the mutation and enqueueAfterHooks (per source order). It
    // must have been called — if the mutation moved AFTER publishRealtime, this assertion plus
    // afterHookContentAtCall together still anchor the contract: any observer downstream of the
    // mutation point sees the canonical (post-transform) content.
    expect(host.publishRealtime).toHaveBeenCalled();
    expect(afterHookContentAtCall).toBe("scrubbed");
  });

  it("blocks chat completion when transform_llm_output intercepts", async () => {
    const host = createCompletionHost({
      completion: async () => ({
        model: "primary-model",
        choices: [{ index: 0, message: { role: "assistant", content: "leak" }, finish_reason: "stop" }],
      }),
    });
    host.hooksService.runInlineHooks = vi.fn(async (options: { trigger: string }) =>
      options.trigger === "transform_llm_output"
        ? { runs: [], blockedBy: { type: "block", reason: "policy: bad-output" } }
        : { runs: [] },
    ) as never;

    await expect(createChatCompletion(host, createRequest())).rejects.toThrow(/bad-output/);

    expect(host.publishRealtime).not.toHaveBeenCalled();
  });
});

describe("createChatCompletionStream idle watchdog", () => {
  it("aborts a stream that hangs after emitting and throws the idle error after salvage diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const host = createHost(async function* () {
        yield { id: "chunk-1", choices: [{ delta: { content: "partial" } }] };
        await new Promise(() => {});
      });
      (host.config.assistant as { streamIdleTimeoutMs?: number }).streamIdleTimeoutMs = 5_000;

      const consumed: unknown[] = [];
      let failure: unknown;
      const run = (async () => {
        try {
          for await (const chunk of createChatCompletionStream(host, createRequest())) {
            consumed.push(chunk);
          }
        } catch (error) {
          failure = error;
        }
      })();
      await vi.advanceTimersByTimeAsync(6_000);
      await run;

      expect(consumed).toHaveLength(1);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as { code?: string }).code).toBe("stream_idle_timeout");
      expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ event: "chat.completion_stream.idle_watchdog_tripped" }),
      );
      expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ event: "chat.completion_stream.failed_after_emit" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms the provider request with an abort signal only when the watchdog is enabled", async () => {
    const seenSignals: Array<AbortSignal | undefined> = [];
    const buildHost = (watchdogDisabled: boolean) => {
      const host = createHost(async function* (request: ChatCompletionRequest) {
        seenSignals.push(request.signal as AbortSignal | undefined);
        yield { id: "chunk-1", choices: [{ delta: { content: "done" } }] };
      });
      (host.config.assistant as { features?: Record<string, boolean> }).features = {
        streamIdleWatchdogV1Disabled: watchdogDisabled,
      };
      return host;
    };

    for await (const chunk of createChatCompletionStream(buildHost(false), createRequest())) {
      void chunk;
    }
    for await (const chunk of createChatCompletionStream(buildHost(true), createRequest())) {
      void chunk;
    }

    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
    expect(seenSignals[1]).toBeUndefined();
  });
});
