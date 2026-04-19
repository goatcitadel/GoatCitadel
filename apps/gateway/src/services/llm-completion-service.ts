/**
 * LLM completion service.
 *
 * Owns completion shaping, fallback, hook coordination, and memory-aware
 * request assembly behind an explicit runtime host.
 */

import { randomUUID } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatTurnTraceRecord,
  MemoryContextPack,
} from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import { shouldAllowCrossProviderFallback } from "./chat-session-utils.js";
import type { HooksService } from "./hooks-service.js";
import type { LlmService } from "./llm-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import {
  CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT,
  buildMemoryContextSystemMessage,
  calculateSavings,
  createChatCompletionDeadline,
  delayChatCompletionRetry,
  extractPromptFromMessages,
  getRemainingChatCompletionTimeoutMs,
  normalizeChatCompletionAttemptError,
  normalizeToolProtocolRetryRequest,
  shouldRetryToolProtocolError,
  shouldRetryTransientProviderError,
} from "./gateway-service.js";

type LlmRequestHookPatch = {
  providerId?: string;
  model?: string;
  prependMessages?: ChatCompletionRequest["messages"];
  appendMessages?: ChatCompletionRequest["messages"];
  tools?: Array<Record<string, unknown>>;
  toolChoice?: string | Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export interface LlmCompletionHost {
  readonly config: Pick<GatewayRuntimeConfig, "assistant">;
  readonly memoryLifecycleService: Pick<MemoryLifecycleService, "composeContext">;
  readonly hooksService: Pick<HooksService, "runInlineHooks" | "enqueueAfterHooks">;
  readonly llmService: Pick<
    LlmService,
    "chatCompletions" | "chatCompletionsStream" | "getRuntimeConfig" | "resolveExecutionApiStyle"
  >;
  resolveMemoryWorkspaceRelativeDir(workspace: string | undefined, sessionId: string | undefined): string;
  resolveChatCompletionHookWorkspaceId(request: ChatCompletionRequest): string;
  parseLlmModelSelectHookPatch(value: unknown):
    | {
        providerId?: string;
        model?: string;
      }
    | undefined;
  parseLlmRequestHookPatch(value: unknown): LlmRequestHookPatch | undefined;
  mergeLlmRequestHookPatch(current: LlmRequestHookPatch | undefined, next: LlmRequestHookPatch): LlmRequestHookPatch;
  applyLlmRequestHookPatch(request: ChatCompletionRequest, patch: LlmRequestHookPatch): ChatCompletionRequest;
  persistContextManifestForCompletionRequest(input: {
    request: ChatCompletionRequest;
    memoryContext?: MemoryContextPack;
  }): void;
  resolveFallbackTargets(
    runtime: ReturnType<LlmService["getRuntimeConfig"]>,
    primaryProviderId: string,
    primaryModel: string,
  ): Array<{ providerId: string; model: string }>;
  recordDevDiagnostic(input: {
    level: "debug" | "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    sessionId?: string;
    providerId?: string;
    modelId?: string;
    context?: Record<string, unknown>;
  }): void;
  publishRealtime(channel: string, topic: string, payload: Record<string, unknown>): void;
}

export async function createChatCompletion(
  host: LlmCompletionHost,
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  host.recordDevDiagnostic({
    level: "debug",
    category: "chat",
    event: "chat.completion.start",
    message: "Starting chat completion",
    sessionId: request.memory?.sessionId,
    providerId: request.providerId,
    modelId: request.model,
    context: {
      messageCount: request.messages.length,
      stream: request.stream ?? false,
    },
  });
  let response: ChatCompletionResponse | undefined;
  let memoryContext: MemoryContextPack | undefined;
  const memoryInput = request.memory;
  const useQmd =
    host.config.assistant.memory.enabled &&
    host.config.assistant.memory.qmd.enabled &&
    host.config.assistant.memory.qmd.applyToChat &&
    memoryInput?.mode !== "off" &&
    (memoryInput?.enabled ?? true);

  if (useQmd) {
    const prompt = extractPromptFromMessages(request.messages);
    if (prompt.trim()) {
      memoryContext = await host.memoryLifecycleService.composeContext({
        scope: "chat",
        prompt,
        sessionId: memoryInput?.sessionId,
        taskId: memoryInput?.taskId,
        workspace: host.resolveMemoryWorkspaceRelativeDir(memoryInput?.workspace, memoryInput?.sessionId),
        relationScope: memoryInput?.relationScope,
        maxContextTokens: memoryInput?.maxContextTokens,
        forceRefresh: memoryInput?.forceRefresh,
      });
    }
  }

  const withContext = memoryContext
    ? {
        ...request,
        messages: [
          {
            role: "system" as const,
            content: buildMemoryContextSystemMessage(memoryContext),
          },
          ...request.messages,
        ],
      }
    : request;

  const chatHookWorkspaceId = host.resolveChatCompletionHookWorkspaceId(request);
  const chatHookEntityId = request.memory?.sessionId?.trim() || randomUUID();
  let hookableRequest = withContext;

  const modelSelectHook = await host.hooksService.runInlineHooks<{
    providerId?: string;
    model?: string;
  }>({
    workspaceId: chatHookWorkspaceId,
    trigger: "llm.model.select.before",
    entityType: "chat_completion",
    entityId: chatHookEntityId,
    payload: {
      providerId: hookableRequest.providerId,
      model: hookableRequest.model,
      messageCount: hookableRequest.messages.length,
    },
    parsePatch: (value) => host.parseLlmModelSelectHookPatch(value),
    mergePatch: (current, next) => ({
      ...(current ?? {}),
      ...next,
    }),
  });
  if (modelSelectHook.blockedBy) {
    throw new Error(modelSelectHook.blockedBy.reason);
  }
  if (modelSelectHook.patch) {
    hookableRequest = {
      ...hookableRequest,
      ...modelSelectHook.patch,
    };
  }

  const llmRequestHook = await host.hooksService.runInlineHooks<{
    providerId?: string;
    model?: string;
    prependMessages?: typeof hookableRequest.messages;
    appendMessages?: typeof hookableRequest.messages;
    tools?: Array<Record<string, unknown>>;
    toolChoice?: string | Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>({
    workspaceId: chatHookWorkspaceId,
    trigger: "llm.request.before",
    entityType: "chat_completion",
    entityId: chatHookEntityId,
    payload: {
      providerId: hookableRequest.providerId,
      model: hookableRequest.model,
      messages: hookableRequest.messages,
      tools: hookableRequest.tools ?? [],
      toolChoice: hookableRequest.tool_choice,
      metadata: hookableRequest.metadata ?? {},
    },
    parsePatch: (value) => host.parseLlmRequestHookPatch(value),
    mergePatch: (current, next) => host.mergeLlmRequestHookPatch(current, next),
  });
  if (llmRequestHook.blockedBy) {
    throw new Error(llmRequestHook.blockedBy.reason);
  }
  if (llmRequestHook.patch) {
    hookableRequest = host.applyLlmRequestHookPatch(hookableRequest, llmRequestHook.patch);
  }
  host.persistContextManifestForCompletionRequest({
    request: hookableRequest,
    memoryContext,
  });

  const runtime = host.llmService.getRuntimeConfig({
    includeKeychainForActiveProvider: true,
    useCache: true,
  });
  const primaryProviderId = hookableRequest.providerId ?? runtime.activeProviderId;
  const primaryProvider = runtime.providers.find((item) => item.providerId === primaryProviderId);
  const primaryModel = hookableRequest.model ?? primaryProvider?.defaultModel ?? runtime.activeModel;
  const primaryApiStyle = host.llmService.resolveExecutionApiStyle(primaryProviderId, primaryModel);
  const allowCrossProviderFallback = shouldAllowCrossProviderFallback(hookableRequest);
  const routing: ChatTurnTraceRecord["routing"] = {
    primaryProviderId,
    primaryModel,
    primaryApiStyle,
    effectiveProviderId: primaryProviderId,
    effectiveModel: primaryModel,
    effectiveApiStyle: primaryApiStyle,
    fallbackUsed: false,
  };

  const retryAttempts = [
    hookableRequest,
    normalizeToolProtocolRetryRequest(hookableRequest, 1),
    normalizeToolProtocolRetryRequest(hookableRequest, 2),
  ];
  const completionDeadline = createChatCompletionDeadline(hookableRequest.timeoutMs);
  let lastError: Error | undefined;

  attemptLoop: for (let index = 0; index < retryAttempts.length; index += 1) {
    const attemptRequest = retryAttempts[index]!;
    for (
      let transientRetryIndex = 0;
      transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT;
      transientRetryIndex += 1
    ) {
      try {
        const attemptTimeoutMs = getRemainingChatCompletionTimeoutMs(completionDeadline, hookableRequest.timeoutMs);
        response = await host.llmService.chatCompletions({
          ...attemptRequest,
          timeoutMs: attemptTimeoutMs ?? attemptRequest.timeoutMs,
        });
        routing.effectiveProviderId = attemptRequest.providerId ?? primaryProviderId;
        routing.effectiveModel = response.model ?? attemptRequest.model ?? primaryModel;
        routing.effectiveApiStyle = host.llmService.resolveExecutionApiStyle(
          routing.effectiveProviderId,
          routing.effectiveModel,
        );
        if (index > 0) {
          routing.fallbackUsed = true;
          routing.fallbackProviderId = routing.effectiveProviderId;
          routing.fallbackModel = routing.effectiveModel;
          routing.fallbackApiStyle = routing.effectiveApiStyle;
          routing.fallbackReason =
            index === 1
              ? "provider compatibility retry (normalized tool protocol)"
              : "provider compatibility retry (minimal thinking metadata)";
        }
        break attemptLoop;
      } catch (error) {
        lastError = normalizeChatCompletionAttemptError(error, hookableRequest.timeoutMs);
        host.recordDevDiagnostic({
          level: "warn",
          category: "chat",
          event: "chat.completion.attempt_failed",
          message: "Chat completion attempt failed",
          sessionId: request.memory?.sessionId,
          providerId: attemptRequest.providerId ?? primaryProviderId,
          modelId: attemptRequest.model ?? primaryModel,
          context: {
            error: lastError.message,
            retryIndex: index,
            transientRetryIndex,
          },
        });

        if (
          transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT - 1 &&
          shouldRetryTransientProviderError(lastError)
        ) {
          await delayChatCompletionRetry(completionDeadline, hookableRequest.timeoutMs, transientRetryIndex);
          continue;
        }
        if (index < retryAttempts.length - 1 && shouldRetryToolProtocolError(lastError)) {
          continue attemptLoop;
        }
        if (index < retryAttempts.length - 1 && index === 0) {
          continue attemptLoop;
        }
        break;
      }
    }
  }

  if (!response && allowCrossProviderFallback) {
    const fallbacks = host.resolveFallbackTargets(runtime, primaryProviderId, primaryModel);
    for (const fallback of fallbacks) {
      for (
        let transientRetryIndex = 0;
        transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT;
        transientRetryIndex += 1
      ) {
        try {
          const attemptTimeoutMs = getRemainingChatCompletionTimeoutMs(completionDeadline, hookableRequest.timeoutMs);
          response = await host.llmService.chatCompletions({
            ...normalizeToolProtocolRetryRequest(hookableRequest, 2),
            providerId: fallback.providerId,
            model: fallback.model,
            timeoutMs: attemptTimeoutMs ?? hookableRequest.timeoutMs,
          });
          host.recordDevDiagnostic({
            level: "info",
            category: "chat",
            event: "chat.completion.fallback_applied",
            message: "Applied cross-provider fallback",
            sessionId: request.memory?.sessionId,
            providerId: fallback.providerId,
            modelId: fallback.model,
            context: {
              reason: lastError?.message,
            },
          });
          routing.fallbackUsed = true;
          routing.fallbackProviderId = fallback.providerId;
          routing.fallbackModel = response.model ?? fallback.model;
          routing.fallbackApiStyle = host.llmService.resolveExecutionApiStyle(
            fallback.providerId,
            routing.fallbackModel,
          );
          routing.fallbackReason = `primary failed (${lastError?.message ?? "unknown error"})`;
          routing.effectiveProviderId = fallback.providerId;
          routing.effectiveModel = routing.fallbackModel;
          routing.effectiveApiStyle = routing.fallbackApiStyle;
          break;
        } catch (error) {
          lastError = normalizeChatCompletionAttemptError(error, hookableRequest.timeoutMs);
          if (
            transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT - 1 &&
            shouldRetryTransientProviderError(lastError)
          ) {
            await delayChatCompletionRetry(completionDeadline, hookableRequest.timeoutMs, transientRetryIndex);
            continue;
          }
        }
      }
      if (response) {
        break;
      }
    }
  }

  if (!response) {
    host.recordDevDiagnostic({
      level: "error",
      category: "chat",
      event: "chat.completion.failed",
      message: "Chat completion failed",
      sessionId: request.memory?.sessionId,
      providerId: primaryProviderId,
      modelId: primaryModel,
      context: {
        error: lastError?.message,
      },
    });
    throw lastError ?? new Error("chat completion failed");
  }
  host.recordDevDiagnostic({
    level: "info",
    category: "chat",
    event: "chat.completion.complete",
    message: "Chat completion completed",
    sessionId: request.memory?.sessionId,
    providerId: routing.effectiveProviderId ?? primaryProviderId,
    modelId: routing.effectiveModel ?? primaryModel,
    context: {
      fallbackUsed: routing.fallbackUsed,
    },
  });

  host.publishRealtime("system", "llm", {
    type: "chat_completion",
    providerId: routing.effectiveProviderId ?? primaryProviderId,
    model: routing.effectiveModel ?? primaryModel,
    messageCount: request.messages.length,
    stream: request.stream ?? false,
    memoryContextId: memoryContext?.contextId,
    memoryQmdStatus: memoryContext?.quality.status,
    fallbackUsed: routing.fallbackUsed,
    fallbackProviderId: routing.fallbackProviderId,
    fallbackModel: routing.fallbackModel,
    fallbackReason: routing.fallbackReason,
  });

  if (memoryContext) {
    response.memoryContext = {
      contextId: memoryContext.contextId,
      cacheHit: memoryContext.quality.status === "cache_hit",
      originalTokenEstimate: memoryContext.originalTokenEstimate,
      distilledTokenEstimate: memoryContext.distilledTokenEstimate,
      savingsPercent: calculateSavings(memoryContext.originalTokenEstimate, memoryContext.distilledTokenEstimate),
      citationsCount: memoryContext.citations.length,
    };
  }
  response.routing = routing;
  host.hooksService.enqueueAfterHooks({
    workspaceId: chatHookWorkspaceId,
    trigger: "llm.response.after",
    entityType: "chat_completion",
    entityId: chatHookEntityId,
    payload: {
      providerId: routing.effectiveProviderId ?? primaryProviderId,
      model: routing.effectiveModel ?? primaryModel,
      request: {
        providerId: hookableRequest.providerId,
        model: hookableRequest.model,
        metadata: hookableRequest.metadata ?? {},
        messageCount: hookableRequest.messages.length,
      },
      response,
    },
  });
  return response;
}

export async function* createChatCompletionStream(
  host: LlmCompletionHost,
  request: ChatCompletionRequest,
): AsyncGenerator<Record<string, unknown>> {
  let memoryContext: MemoryContextPack | undefined;
  const memoryInput = request.memory;
  const useQmd =
    host.config.assistant.memory.enabled &&
    host.config.assistant.memory.qmd.enabled &&
    host.config.assistant.memory.qmd.applyToChat &&
    memoryInput?.mode !== "off" &&
    (memoryInput?.enabled ?? true);

  if (useQmd) {
    const prompt = extractPromptFromMessages(request.messages);
    if (prompt.trim()) {
      memoryContext = await host.memoryLifecycleService.composeContext({
        scope: "chat",
        prompt,
        sessionId: memoryInput?.sessionId,
        taskId: memoryInput?.taskId,
        workspace: host.resolveMemoryWorkspaceRelativeDir(memoryInput?.workspace, memoryInput?.sessionId),
        relationScope: memoryInput?.relationScope,
        maxContextTokens: memoryInput?.maxContextTokens,
        forceRefresh: memoryInput?.forceRefresh,
      });
    }
  }

  const withContext = memoryContext
    ? {
        ...request,
        messages: [
          {
            role: "system" as const,
            content: buildMemoryContextSystemMessage(memoryContext),
          },
          ...request.messages,
        ],
      }
    : request;
  host.persistContextManifestForCompletionRequest({
    request: withContext,
    memoryContext,
  });

  const runtime = host.llmService.getRuntimeConfig({
    includeKeychainForActiveProvider: true,
    useCache: true,
  });
  const primaryProviderId = withContext.providerId ?? runtime.activeProviderId;
  const primaryProvider = runtime.providers.find((item) => item.providerId === primaryProviderId);
  const primaryModel = withContext.model ?? primaryProvider?.defaultModel ?? runtime.activeModel;
  const primaryApiStyle = host.llmService.resolveExecutionApiStyle(primaryProviderId, primaryModel);
  const allowCrossProviderFallback = shouldAllowCrossProviderFallback(withContext);
  const routing: ChatTurnTraceRecord["routing"] = {
    primaryProviderId,
    primaryModel,
    primaryApiStyle,
    effectiveProviderId: primaryProviderId,
    effectiveModel: primaryModel,
    effectiveApiStyle: primaryApiStyle,
    fallbackUsed: false,
  };

  const retryAttempts = [
    withContext,
    normalizeToolProtocolRetryRequest(withContext, 1),
    normalizeToolProtocolRetryRequest(withContext, 2),
  ];
  const completionDeadline = createChatCompletionDeadline(withContext.timeoutMs);
  let streamed = false;
  let lastError: Error | undefined;

  attemptLoop: for (let index = 0; index < retryAttempts.length; index += 1) {
    const attemptRequest = retryAttempts[index]!;
    for (
      let transientRetryIndex = 0;
      transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT;
      transientRetryIndex += 1
    ) {
      let attemptStreamed = false;
      try {
        const attemptTimeoutMs = getRemainingChatCompletionTimeoutMs(completionDeadline, withContext.timeoutMs);
        for await (const chunk of host.llmService.chatCompletionsStream({
          ...attemptRequest,
          stream: true,
          timeoutMs: attemptTimeoutMs ?? attemptRequest.timeoutMs,
        })) {
          attemptStreamed = true;
          streamed = true;
          yield chunk;
        }
        routing.effectiveProviderId = attemptRequest.providerId ?? primaryProviderId;
        routing.effectiveModel = attemptRequest.model ?? primaryModel;
        routing.effectiveApiStyle = host.llmService.resolveExecutionApiStyle(
          routing.effectiveProviderId,
          routing.effectiveModel,
        );
        if (index > 0) {
          routing.fallbackUsed = true;
          routing.fallbackProviderId = routing.effectiveProviderId;
          routing.fallbackModel = routing.effectiveModel;
          routing.fallbackApiStyle = routing.effectiveApiStyle;
          routing.fallbackReason =
            index === 1
              ? "provider compatibility retry (normalized tool protocol)"
              : "provider compatibility retry (minimal thinking metadata)";
        }
        break attemptLoop;
      } catch (error) {
        lastError = normalizeChatCompletionAttemptError(error, withContext.timeoutMs);
        if (
          !attemptStreamed &&
          transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT - 1 &&
          shouldRetryTransientProviderError(lastError)
        ) {
          await delayChatCompletionRetry(completionDeadline, withContext.timeoutMs, transientRetryIndex);
          continue;
        }
        if (index < retryAttempts.length - 1 && shouldRetryToolProtocolError(lastError)) {
          continue attemptLoop;
        }
        break;
      }
    }
  }

  if (!streamed && allowCrossProviderFallback) {
    const fallbacks = host.resolveFallbackTargets(runtime, primaryProviderId, primaryModel);
    for (const fallback of fallbacks) {
      for (
        let transientRetryIndex = 0;
        transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT;
        transientRetryIndex += 1
      ) {
        let attemptStreamed = false;
        try {
          const attemptTimeoutMs = getRemainingChatCompletionTimeoutMs(completionDeadline, withContext.timeoutMs);
          for await (const chunk of host.llmService.chatCompletionsStream({
            ...normalizeToolProtocolRetryRequest(withContext, 2),
            providerId: fallback.providerId,
            model: fallback.model,
            stream: true,
            timeoutMs: attemptTimeoutMs ?? withContext.timeoutMs,
          })) {
            attemptStreamed = true;
            streamed = true;
            yield chunk;
          }
          routing.fallbackUsed = true;
          routing.fallbackProviderId = fallback.providerId;
          routing.fallbackModel = fallback.model;
          routing.fallbackApiStyle = host.llmService.resolveExecutionApiStyle(fallback.providerId, fallback.model);
          routing.fallbackReason = `primary failed (${lastError?.message ?? "unknown error"})`;
          routing.effectiveProviderId = fallback.providerId;
          routing.effectiveModel = fallback.model;
          routing.effectiveApiStyle = routing.fallbackApiStyle;
          break;
        } catch (error) {
          lastError = normalizeChatCompletionAttemptError(error, withContext.timeoutMs);
          if (
            !attemptStreamed &&
            transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT - 1 &&
            shouldRetryTransientProviderError(lastError)
          ) {
            await delayChatCompletionRetry(completionDeadline, withContext.timeoutMs, transientRetryIndex);
            continue;
          }
        }
      }
      if (streamed) {
        break;
      }
    }
  }

  if (!streamed) {
    throw lastError ?? new Error("chat completion stream failed");
  }

  host.publishRealtime("system", "llm", {
    type: "chat_completion_stream",
    providerId: routing.effectiveProviderId ?? primaryProviderId,
    model: routing.effectiveModel ?? primaryModel,
    messageCount: request.messages.length,
    stream: true,
    memoryContextId: memoryContext?.contextId,
    memoryQmdStatus: memoryContext?.quality.status,
    fallbackUsed: routing.fallbackUsed,
    fallbackProviderId: routing.fallbackProviderId,
    fallbackModel: routing.fallbackModel,
    fallbackReason: routing.fallbackReason,
  });

  const finalChunk: Record<string, unknown> = {
    routing,
  };
  if (memoryContext) {
    finalChunk.memoryContext = {
      contextId: memoryContext.contextId,
      cacheHit: memoryContext.quality.status === "cache_hit",
      originalTokenEstimate: memoryContext.originalTokenEstimate,
      distilledTokenEstimate: memoryContext.distilledTokenEstimate,
      savingsPercent: calculateSavings(memoryContext.originalTokenEstimate, memoryContext.distilledTokenEstimate),
      citationsCount: memoryContext.citations.length,
    };
  }
  yield finalChunk;
}
