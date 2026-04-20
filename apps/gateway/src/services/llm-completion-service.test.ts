import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import { createChatCompletionStream, type LlmCompletionHost } from "./llm-completion-service.js";

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
      runInlineHooks: vi.fn(),
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
});
