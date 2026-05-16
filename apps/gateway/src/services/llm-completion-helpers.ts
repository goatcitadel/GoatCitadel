import type { ChatCompletionRequest, ChatCompletionResponse, MemoryContextPack } from "@goatcitadel/contracts";
import { absorbCompletionStreamChunk, createCompletionStreamAggregate } from "./chat-agent-completion-adapters.js";
import { isChatTurnCancelledError } from "./chat-turn-helpers.js";
import { parseTransformLlmOutputHookPatch } from "./hook-patch-helpers.js";
import type { HooksService } from "./hooks-service.js";

export const CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT = 3;

export function extractPromptFromMessages(messages: ChatCompletionRequest["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => {
          const maybeText = (part as Record<string, unknown>).text;
          return typeof maybeText === "string" ? maybeText : "";
        })
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}

export function buildMemoryContextSystemMessage(pack: MemoryContextPack): string {
  return [
    "Distilled context from GoatCitadel memory:",
    pack.contextText,
    "",
    `ContextId: ${pack.contextId}`,
    `Citations: ${pack.citations.length}`,
  ].join("\n");
}

export function calculateSavings(originalTokens: number, distilledTokens: number): number {
  if (originalTokens <= 0) {
    return 0;
  }
  return Number((((originalTokens - distilledTokens) / originalTokens) * 100).toFixed(2));
}

export function shouldRetryToolProtocolError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("invalid_request_error") ||
    message.includes("function name is invalid") ||
    message.includes("reasoning_content is missing") ||
    message.includes("tool call") ||
    message.includes("tool_calls")
  );
}

export function shouldRetryTransientProviderError(error: Error): boolean {
  const message = error.message.toLowerCase();
  const statusMatch = error.message.match(/\((\d{3})(?:\s|[)])?/);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;

  if (status !== undefined && [408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  if (status !== undefined && [401, 403].includes(status)) {
    return /(tempor|timeout|upstream|gateway|proxy|connect|connection|network|unavailable|overload|retry)/.test(
      message,
    );
  }

  return (
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("service unavailable") ||
    message.includes("gateway timeout") ||
    message.includes("temporarily unavailable") ||
    message.includes("too many requests") ||
    message.includes("rate limit")
  );
}

export async function delayChatCompletionRetry(
  deadline: number | undefined,
  timeoutMs: number | undefined,
  retryIndex: number,
): Promise<void> {
  const delayMs = retryIndex === 0 ? 250 : 750;
  if (deadline !== undefined && Date.now() + delayMs >= deadline) {
    throw buildChatCompletionTimeoutError(timeoutMs);
  }
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function normalizeToolProtocolRetryRequest(
  request: ChatCompletionRequest,
  attempt: 1 | 2,
): ChatCompletionRequest {
  const modelToolNameMap = new Map<string, string>();
  const tools = Array.isArray(request.tools)
    ? request.tools.map((tool) => {
        const record = tool as Record<string, unknown>;
        if (record.type !== "function") {
          return tool;
        }
        const fn = (record.function ?? {}) as Record<string, unknown>;
        const rawName = typeof fn.name === "string" ? fn.name : "tool_fn";
        const normalizedName = rawName
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .replace(/_+/g, "_")
          .replace(/^_+|_+$/g, "");
        const finalName = /^[a-zA-Z]/.test(normalizedName) ? normalizedName : `tool_${normalizedName || "fn"}`;
        modelToolNameMap.set(rawName, finalName);
        return {
          ...record,
          function: {
            ...fn,
            name: finalName,
          },
        };
      })
    : request.tools;

  const messages = request.messages.map((message) => {
    const value = toPlainRecord(message);
    if (message.role === "assistant" && value && Array.isArray(value.tool_calls)) {
      const toolCalls = value.tool_calls.map((toolCall) => {
        const tc = toPlainRecord(toolCall) ?? {};
        const fn = toPlainRecord(tc.function) ?? {};
        const rawName = typeof fn.name === "string" ? fn.name : "";
        const normalized = modelToolNameMap.get(rawName) ?? rawName;
        const rawArgs = fn.arguments;
        const normalizedArgs = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
        return {
          ...tc,
          type: "function",
          function: {
            ...fn,
            name: normalized || "tool_fn",
            arguments: normalizedArgs,
          },
        };
      });
      const next: ChatCompletionRequest["messages"][number] & Record<string, unknown> = {
        ...message,
        tool_calls: toolCalls,
      };
      if (attempt === 2 && typeof next.reasoning_content !== "string") {
        next.reasoning_content = "Using tool outputs to continue the response.";
      }
      return next;
    }
    return message;
  });

  return {
    ...request,
    tools,
    messages,
  };
}

export function createChatCompletionDeadline(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Date.now() + Math.floor(timeoutMs);
}

export function getRemainingChatCompletionTimeoutMs(
  deadline: number | undefined,
  timeoutMs: number | undefined,
): number | undefined {
  if (deadline === undefined) {
    return timeoutMs;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw buildChatCompletionTimeoutError(timeoutMs);
  }
  return Math.max(1, remaining);
}

export function normalizeChatCompletionAttemptError(error: unknown, timeoutMs: number | undefined): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (isChatTurnCancelledError(normalized)) {
    return normalized;
  }
  const name = normalized.name.toLowerCase();
  const message = normalized.message.toLowerCase();
  if (name.includes("cancel") || message.includes("cancelled")) {
    return normalized;
  }
  if (
    name.includes("timeout") ||
    name.includes("abort") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("aborted")
  ) {
    return buildChatCompletionTimeoutError(timeoutMs);
  }
  return normalized;
}

function buildChatCompletionTimeoutError(timeoutMs: number | undefined): Error {
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return new Error(`Chat completion timed out after ${Math.floor(timeoutMs)}ms.`);
  }
  return new Error("Chat completion timed out.");
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? { ...value } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface ApplyNonStreamingTransformInput {
  hooksService: Pick<HooksService, "runInlineHooks">;
  workspaceId: string;
  entityId: string;
  providerId: string;
  model: string;
  response: ChatCompletionResponse;
}

/**
 * Runs the `transform_llm_output` hook for a non-streamed chat completion. Mutates `response`
 * in place when the hook returns a content patch so that downstream observers
 * (publishRealtime, after-hooks, persistence) see the canonical post-transform content.
 *
 * Throws when the hook intercepts the response.
 */
export async function applyNonStreamingTransformLlmOutput(input: ApplyNonStreamingTransformInput): Promise<void> {
  const transformHook = await input.hooksService.runInlineHooks<{
    content?: string;
    metadata?: Record<string, unknown>;
  }>({
    workspaceId: input.workspaceId,
    trigger: "transform_llm_output",
    entityType: "chat_completion",
    entityId: input.entityId,
    payload: {
      providerId: input.providerId,
      model: input.model,
      response: input.response,
    },
    parsePatch: (value) => parseTransformLlmOutputHookPatch(value),
    mergePatch: (current, next) => ({ ...(current ?? {}), ...next }),
  });
  if (transformHook.blockedBy) {
    throw new Error(transformHook.blockedBy.reason);
  }
  if (transformHook.patch?.content) {
    const firstChoice = input.response.choices?.[0];
    if (firstChoice?.message) {
      firstChoice.message.content = transformHook.patch.content;
    }
  }
}

export interface ApplyStreamingTransformInput {
  hooksService: Pick<HooksService, "runInlineHooks">;
  workspaceId: string;
  entityId: string;
  providerId: string;
  model: string;
  bufferedChunks: ReadonlyArray<Record<string, unknown>>;
  shouldBufferForTransform: boolean;
}

/**
 * Runs the `transform_llm_output` hook for a streamed chat completion and returns the chunks the
 * caller should yield to the consumer.
 *
 * - In buffered mode the assembled content is exposed to mutate hooks; the returned chunks are a
 *   single synthetic content delta followed by a finish marker derived from the original stream.
 * - In passthrough mode the hook fires veto-only and no extra chunks are returned (raw chunks
 *   were already yielded before this call).
 *
 * Throws when the hook intercepts the response.
 */
export async function applyStreamingTransformLlmOutput(
  input: ApplyStreamingTransformInput,
): Promise<Array<Record<string, unknown>>> {
  if (!input.shouldBufferForTransform) {
    const passthroughHook = await input.hooksService.runInlineHooks({
      workspaceId: input.workspaceId,
      trigger: "transform_llm_output",
      entityType: "chat_completion",
      entityId: input.entityId,
      payload: {
        providerId: input.providerId,
        model: input.model,
        stream: true,
      },
    });
    if (passthroughHook.blockedBy) {
      throw new Error(passthroughHook.blockedBy.reason);
    }
    return [];
  }

  const aggregate = createCompletionStreamAggregate();
  for (const chunk of input.bufferedChunks) {
    absorbCompletionStreamChunk(aggregate, chunk);
  }
  const assembledContent = aggregate.content;
  const bufferedHook = await input.hooksService.runInlineHooks<{
    content?: string;
    metadata?: Record<string, unknown>;
  }>({
    workspaceId: input.workspaceId,
    trigger: "transform_llm_output",
    entityType: "chat_completion",
    entityId: input.entityId,
    payload: {
      providerId: input.providerId,
      model: input.model,
      stream: true,
      content: assembledContent,
    },
    parsePatch: (value) => parseTransformLlmOutputHookPatch(value),
    mergePatch: (current, next) => ({ ...(current ?? {}), ...next }),
  });
  if (bufferedHook.blockedBy) {
    throw new Error(bufferedHook.blockedBy.reason);
  }
  const finalContent = bufferedHook.patch?.content ?? assembledContent;
  return [
    { choices: [{ delta: { content: finalContent } }] },
    { choices: [{ finish_reason: aggregate.finishReason ?? "stop", delta: {} }] },
  ];
}
