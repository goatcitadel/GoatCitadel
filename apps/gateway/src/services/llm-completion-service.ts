/**
 * LLM completion service.
 *
 * Owns completion shaping, fallback, hook coordination, and memory-aware
 * request assembly behind an explicit runtime host.
 */

import { randomUUID } from "node:crypto";
import type { ChatCompletionRequest, ChatCompletionResponse, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { shouldAllowCrossProviderFallback } from "./chat-session-utils.js";
import {
  CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT,
  applyNonStreamingTransformLlmOutput,
  applyStreamingTransformLlmOutput,
  buildProviderRetryCooldownExhaustedError,
  buildMemoryContextSystemMessage,
  calculateSavings,
  createChatCompletionDeadline,
  delayChatCompletionRetry,
  getRemainingChatCompletionTimeoutMs,
  normalizeChatCompletionAttemptError,
  normalizeToolProtocolRetryRequest,
  shouldAttemptCrossProviderFallback,
  shouldReportProviderRetryCooldownExhausted,
  shouldRetryToolProtocolError,
  shouldRetryTransientProviderError,
} from "./llm-completion-helpers.js";
import {
  applyLlmRequestHookPatch,
  mergeLlmRequestHookPatch,
  parseLlmModelSelectHookPatch,
  parseLlmRequestHookPatch,
} from "./hook-patch-helpers.js";
import type { LlmCompletionHost } from "./llm-completion-host.js";
import {
  composeChatCompletionMemoryContext,
  shouldUseChatCompletionMemoryContext,
} from "./llm-completion-memory-context.js";
import {
  recordCompletedChatRuntime,
  recordFailedChatRuntime,
  recordStreamRuntime,
} from "./llm-completion-runtime-measurements.js";
import { runtimeLifecycleHookDispatcher } from "./runtime-lifecycle-hook-dispatcher.js";
import { StreamIdleTimeoutError, resolveStreamIdleTimeoutMs, withStreamIdleWatchdog } from "./stream-idle-watchdog.js";

export type { LlmCompletionHost } from "./llm-completion-host.js";

// Retry after normalizing provider tool-call output into GoatCitadel's expected protocol shape.
const TOOL_PROTOCOL_RETRY_NORMALIZED = 1;
// Retry with minimal provider reasoning metadata to reduce tool-call compatibility friction.
const TOOL_PROTOCOL_RETRY_MINIMAL_THINKING = 2;

export async function createChatCompletion(
  host: LlmCompletionHost,
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const completionStartedAt = Date.now();
  host.recordDevDiagnostic({
    level: "debug",
    category: "chat",
    event: "chat.completion.start",
    message: "Starting chat completion",
    sessionId: request.memory?.sessionId,
    taskId: request.memory?.taskId,
    providerId: request.providerId,
    modelId: request.model,
    runtimeKind: "model.call",
    runtimeStatus: "started",
    context: {
      messageCount: request.messages.length,
      stream: request.stream ?? false,
    },
  });
  const memoryInput = request.memory;
  const useMemoryContext = shouldUseChatCompletionMemoryContext(host, memoryInput);
  let response: ChatCompletionResponse | undefined;
  const memoryContext = await composeChatCompletionMemoryContext(host, request, memoryInput);

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

  await runtimeLifecycleHookDispatcher.runObserveHook(host.hooksService, {
    workspaceId: chatHookWorkspaceId,
    trigger: "before_prompt_build",
    entityType: "chat_completion",
    entityId: chatHookEntityId,
    payload: {
      workspaceId: chatHookWorkspaceId,
      sessionId: memoryInput?.sessionId,
      taskId: memoryInput?.taskId,
      providerId: request.providerId,
      model: request.model,
      messageCount: request.messages.length,
      memoryEnabled: useMemoryContext,
      hasMemoryContext: Boolean(memoryContext),
    },
  });

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
    parsePatch: (value) => parseLlmModelSelectHookPatch(value as Record<string, unknown>),
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

  const dispatchHook = await host.hooksService.runInlineHooks({
    workspaceId: chatHookWorkspaceId,
    trigger: "gateway.dispatch.before",
    entityType: "chat_completion",
    entityId: chatHookEntityId,
    payload: {
      providerId: hookableRequest.providerId,
      model: hookableRequest.model,
      messageCount: hookableRequest.messages.length,
      metadata: hookableRequest.metadata ?? {},
    },
    parsePatch: () => undefined,
  });
  if (dispatchHook.blockedBy) {
    throw new Error(dispatchHook.blockedBy.reason);
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
    parsePatch: (value) => parseLlmRequestHookPatch(value as Record<string, unknown>),
    mergePatch: (current, next) => mergeLlmRequestHookPatch(current, next),
  });
  if (llmRequestHook.blockedBy) {
    throw new Error(llmRequestHook.blockedBy.reason);
  }
  if (llmRequestHook.patch) {
    hookableRequest = applyLlmRequestHookPatch(hookableRequest, llmRequestHook.patch);
  }
  host.persistContextManifestForCompletionRequest({
    request: hookableRequest,
    memoryContext,
  });
  await runtimeLifecycleHookDispatcher.runObserveHook(host.hooksService, {
    workspaceId: chatHookWorkspaceId,
    trigger: "llm_input",
    entityType: "chat_completion",
    entityId: chatHookEntityId,
    payload: {
      workspaceId: chatHookWorkspaceId,
      sessionId: memoryInput?.sessionId,
      taskId: memoryInput?.taskId,
      providerId: hookableRequest.providerId,
      model: hookableRequest.model,
      messageCount: hookableRequest.messages.length,
      toolCount: hookableRequest.tools?.length ?? 0,
      metadataKeys: Object.keys(hookableRequest.metadata ?? {}),
      stream: false,
    },
  });

  const runtime = host.llmService.getRuntimeConfig({
    includeKeychainForActiveProvider: true,
    useCache: true,
  });
  const primaryProviderId = hookableRequest.providerId ?? runtime.activeProviderId;
  const primaryProvider = runtime.providers.find((item) => item.providerId === primaryProviderId);
  const primaryModel = hookableRequest.model ?? primaryProvider?.defaultModel ?? runtime.activeModel;
  const primaryRuntimeTarget = { providerId: primaryProviderId, model: primaryModel, provider: primaryProvider };
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
  const effectiveRuntimeTarget = () => ({
    providerId: routing.effectiveProviderId ?? primaryProviderId,
    model: routing.effectiveModel ?? primaryModel,
    providers: runtime.providers,
  });

  const retryAttempts = [
    hookableRequest,
    normalizeToolProtocolRetryRequest(hookableRequest, TOOL_PROTOCOL_RETRY_NORMALIZED),
    normalizeToolProtocolRetryRequest(hookableRequest, TOOL_PROTOCOL_RETRY_MINIMAL_THINKING),
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
          // Level 1 normalizes tool protocol details; level 2 also strips thinking metadata for stricter parsers.
          routing.fallbackReason =
            index === TOOL_PROTOCOL_RETRY_NORMALIZED
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
          taskId: request.memory?.taskId,
          providerId: attemptRequest.providerId ?? primaryProviderId,
          modelId: attemptRequest.model ?? primaryModel,
          durationMs: Date.now() - completionStartedAt,
          runtimeKind: "model.call",
          runtimeStatus: "degraded",
          runtimeError: {
            name: lastError.name,
            message: lastError.message,
            retryable: shouldRetryTransientProviderError(lastError) || shouldRetryToolProtocolError(lastError),
          },
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

  if (!response && allowCrossProviderFallback && (!lastError || shouldAttemptCrossProviderFallback(lastError))) {
    const fallbacks = filterCrossProviderFallbackTargets(
      host.resolveFallbackTargets(runtime, primaryProviderId, primaryModel),
      primaryProviderId,
    );
    for (const fallback of fallbacks) {
      for (
        let transientRetryIndex = 0;
        transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT;
        transientRetryIndex += 1
      ) {
        try {
          const attemptTimeoutMs = getRemainingChatCompletionTimeoutMs(completionDeadline, hookableRequest.timeoutMs);
          response = await host.llmService.chatCompletions({
            ...normalizeToolProtocolRetryRequest(hookableRequest, TOOL_PROTOCOL_RETRY_MINIMAL_THINKING),
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
            taskId: request.memory?.taskId,
            providerId: fallback.providerId,
            modelId: fallback.model,
            durationMs: Date.now() - completionStartedAt,
            runtimeKind: "model.call",
            runtimeStatus: "degraded",
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
    const completedAt = Date.now();
    const finalError =
      lastError && shouldReportProviderRetryCooldownExhausted(lastError)
        ? buildProviderRetryCooldownExhaustedError(lastError, { providerId: primaryProviderId, model: primaryModel })
        : lastError;
    host.recordDevDiagnostic({
      level: "error",
      category: "chat",
      event: "chat.completion.failed",
      message: "Chat completion failed",
      sessionId: request.memory?.sessionId,
      taskId: request.memory?.taskId,
      providerId: primaryProviderId,
      modelId: primaryModel,
      durationMs: Date.now() - completionStartedAt,
      runtimeKind: "model.call",
      runtimeStatus: "failed",
      runtimeError: finalError
        ? {
            name: finalError.name,
            message: finalError.message,
            retryable: false,
          }
        : undefined,
      context: {
        error: finalError?.message,
        retryCooldownExhausted: Boolean(lastError && finalError !== lastError),
      },
    });
    recordFailedChatRuntime(host, request, primaryRuntimeTarget, completionStartedAt, completedAt, finalError?.message);
    throw finalError ?? new Error("chat completion failed");
  }
  const completionCompletedAt = Date.now();
  host.recordDevDiagnostic({
    level: "info",
    category: "chat",
    event: "chat.completion.complete",
    message: "Chat completion completed",
    sessionId: request.memory?.sessionId,
    taskId: request.memory?.taskId,
    providerId: routing.effectiveProviderId ?? primaryProviderId,
    modelId: routing.effectiveModel ?? primaryModel,
    durationMs: Date.now() - completionStartedAt,
    runtimeKind: "model.call",
    runtimeStatus: "completed",
    context: {
      fallbackUsed: routing.fallbackUsed,
    },
  });
  recordCompletedChatRuntime(
    host,
    request,
    effectiveRuntimeTarget(),
    response,
    completionStartedAt,
    completionCompletedAt,
  );

  // transform_llm_output runs before publishRealtime/after-hooks so downstream observers see
  // the post-transform content. Hook llm_output (observe-only) for the raw provider response.
  await applyNonStreamingTransformLlmOutput({
    hooksService: host.hooksService,
    workspaceId: chatHookWorkspaceId,
    entityId: chatHookEntityId,
    providerId: routing.effectiveProviderId ?? primaryProviderId,
    model: routing.effectiveModel ?? primaryModel,
    response,
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
  runtimeLifecycleHookDispatcher.enqueueObserveHook(host.hooksService, {
    workspaceId: chatHookWorkspaceId,
    trigger: "llm_output",
    entityType: "chat_completion",
    entityId: chatHookEntityId,
    payload: {
      workspaceId: chatHookWorkspaceId,
      sessionId: memoryInput?.sessionId,
      taskId: memoryInput?.taskId,
      providerId: hookableRequest.providerId,
      model: hookableRequest.model,
      effectiveProviderId: routing.effectiveProviderId ?? primaryProviderId,
      effectiveModel: routing.effectiveModel ?? primaryModel,
      fallbackUsed: routing.fallbackUsed ?? false,
      stream: false,
      messageCount: hookableRequest.messages.length,
    },
  });
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
  const completionStartedAt = Date.now();
  const chatHookWorkspaceId = host.resolveChatCompletionHookWorkspaceId(request);
  const chatHookEntityId = request.memory?.sessionId?.trim() || randomUUID();
  const memoryInput = request.memory;
  const useMemoryContext = shouldUseChatCompletionMemoryContext(host, memoryInput);
  host.recordDevDiagnostic({
    level: "debug",
    category: "chat",
    event: "chat.completion_stream.start",
    message: "Starting chat completion stream",
    sessionId: memoryInput?.sessionId,
    taskId: memoryInput?.taskId,
    providerId: request.providerId,
    modelId: request.model,
    runtimeKind: "model.call",
    runtimeStatus: "started",
    context: {
      messageCount: request.messages.length,
      stream: true,
    },
  });
  const memoryContext = await composeChatCompletionMemoryContext(host, request, memoryInput);

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
  await runtimeLifecycleHookDispatcher.runObserveHook(host.hooksService, {
    workspaceId: chatHookWorkspaceId,
    trigger: "before_prompt_build",
    entityType: "chat_completion",
    entityId: chatHookEntityId,
    payload: {
      workspaceId: chatHookWorkspaceId,
      sessionId: memoryInput?.sessionId,
      taskId: memoryInput?.taskId,
      providerId: request.providerId,
      model: request.model,
      messageCount: request.messages.length,
      memoryEnabled: useMemoryContext,
      hasMemoryContext: Boolean(memoryContext),
    },
  });
  const dispatchHook = await host.hooksService.runInlineHooks({
    workspaceId: chatHookWorkspaceId,
    trigger: "gateway.dispatch.before",
    entityType: "chat_completion",
    entityId: chatHookEntityId,
    payload: {
      providerId: withContext.providerId,
      model: withContext.model,
      messageCount: withContext.messages.length,
      metadata: withContext.metadata ?? {},
    },
    parsePatch: () => undefined,
  });
  if (dispatchHook.blockedBy) {
    throw new Error(dispatchHook.blockedBy.reason);
  }
  host.persistContextManifestForCompletionRequest({
    request: withContext,
    memoryContext,
  });
  await runtimeLifecycleHookDispatcher.runObserveHook(host.hooksService, {
    workspaceId: chatHookWorkspaceId,
    trigger: "llm_input",
    entityType: "chat_completion",
    entityId: chatHookEntityId,
    payload: {
      workspaceId: chatHookWorkspaceId,
      sessionId: memoryInput?.sessionId,
      taskId: memoryInput?.taskId,
      providerId: withContext.providerId,
      model: withContext.model,
      messageCount: withContext.messages.length,
      toolCount: withContext.tools?.length ?? 0,
      metadataKeys: Object.keys(withContext.metadata ?? {}),
      stream: true,
    },
  });

  const runtime = host.llmService.getRuntimeConfig({
    includeKeychainForActiveProvider: true,
    useCache: true,
  });
  const primaryProviderId = withContext.providerId ?? runtime.activeProviderId;
  const primaryProvider = runtime.providers.find((item) => item.providerId === primaryProviderId);
  const primaryModel = withContext.model ?? primaryProvider?.defaultModel ?? runtime.activeModel;
  const primaryRuntimeTarget = { providerId: primaryProviderId, model: primaryModel, provider: primaryProvider };
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
  const effectiveRuntimeTarget = () => ({
    providerId: routing.effectiveProviderId ?? primaryProviderId,
    model: routing.effectiveModel ?? primaryModel,
    providers: runtime.providers,
  });

  const shouldBufferForTransform = host.hooksService.hasMutateHook(chatHookWorkspaceId, "transform_llm_output");
  const bufferedChunks: Array<Record<string, unknown>> = [];
  const telemetryChunks: Array<Record<string, unknown>> = [];
  const retryAttempts = [
    withContext,
    normalizeToolProtocolRetryRequest(withContext, TOOL_PROTOCOL_RETRY_NORMALIZED),
    normalizeToolProtocolRetryRequest(withContext, TOOL_PROTOCOL_RETRY_MINIMAL_THINKING),
  ];
  const completionDeadline = createChatCompletionDeadline(withContext.timeoutMs);
  const idleWatchdogDisabled = host.config.assistant.features?.streamIdleWatchdogV1Disabled === true;
  const idleTimeoutMs = resolveStreamIdleTimeoutMs(host.config.assistant.streamIdleTimeoutMs);
  let streamed = false;
  let streamFailedAfterEmit = false;
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
        // Round-3 idle watchdog: a hung provider read becomes an in-band
        // stream failure (abort + throw) instead of an indefinite spinner —
        // the existing attempt/salvage handling below does the rest.
        const idleAbort = new AbortController();
        const attemptSignal = idleWatchdogDisabled
          ? attemptRequest.signal
          : attemptRequest.signal
            ? AbortSignal.any([attemptRequest.signal, idleAbort.signal])
            : idleAbort.signal;
        const providerStream = host.llmService.chatCompletionsStream({
          ...attemptRequest,
          stream: true,
          timeoutMs: attemptTimeoutMs ?? attemptRequest.timeoutMs,
          signal: attemptSignal,
        });
        const attemptStream = idleWatchdogDisabled
          ? providerStream
          : withStreamIdleWatchdog(providerStream, {
              idleTimeoutMs,
              abort: () => idleAbort.abort(new StreamIdleTimeoutError(idleTimeoutMs)),
              onTrip: (elapsedMs) => {
                host.recordDevDiagnostic({
                  level: "warn",
                  category: "chat",
                  event: "chat.completion_stream.idle_watchdog_tripped",
                  message: "Provider stream idle watchdog tripped; aborting the attempt",
                  sessionId: memoryInput?.sessionId,
                  taskId: memoryInput?.taskId,
                  providerId: attemptRequest.providerId ?? primaryProviderId,
                  modelId: attemptRequest.model ?? primaryModel,
                  runtimeKind: "model.call",
                  runtimeStatus: "degraded",
                  context: { idleTimeoutMs: elapsedMs, emittedOutput: attemptStreamed },
                });
              },
            });
        for await (const chunk of attemptStream) {
          attemptStreamed = true;
          streamed = true;
          appendTelemetryChunk(telemetryChunks, chunk);
          if (shouldBufferForTransform) {
            bufferedChunks.push(chunk);
          } else {
            yield chunk;
          }
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
          // Level 1 normalizes tool protocol details; level 2 also strips thinking metadata for stricter parsers.
          routing.fallbackReason =
            index === TOOL_PROTOCOL_RETRY_NORMALIZED
              ? "provider compatibility retry (normalized tool protocol)"
              : "provider compatibility retry (minimal thinking metadata)";
        }
        break attemptLoop;
      } catch (error) {
        lastError = normalizeChatCompletionAttemptError(error, withContext.timeoutMs);
        host.recordDevDiagnostic({
          level: "warn",
          category: "chat",
          event: "chat.completion_stream.attempt_failed",
          message: "Chat completion stream attempt failed",
          sessionId: memoryInput?.sessionId,
          taskId: memoryInput?.taskId,
          providerId: attemptRequest.providerId ?? primaryProviderId,
          modelId: attemptRequest.model ?? primaryModel,
          durationMs: Date.now() - completionStartedAt,
          runtimeKind: "model.call",
          runtimeStatus: "degraded",
          runtimeError: {
            name: lastError.name,
            message: lastError.message,
            retryable: shouldRetryTransientProviderError(lastError) || shouldRetryToolProtocolError(lastError),
          },
          context: {
            error: lastError.message,
            retryIndex: index,
            transientRetryIndex,
            emittedOutput: attemptStreamed,
          },
        });
        if (attemptStreamed) {
          streamFailedAfterEmit = true;
          break attemptLoop;
        }
        if (
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

  if (streamFailedAfterEmit) {
    const completedAt = Date.now();
    host.recordDevDiagnostic({
      level: "error",
      category: "chat",
      event: "chat.completion_stream.failed_after_emit",
      message: "Chat completion stream failed after emitting output",
      sessionId: memoryInput?.sessionId,
      taskId: memoryInput?.taskId,
      providerId: routing.effectiveProviderId ?? primaryProviderId,
      modelId: routing.effectiveModel ?? primaryModel,
      durationMs: Date.now() - completionStartedAt,
      runtimeKind: "model.call",
      runtimeStatus: "failed",
      runtimeError: lastError
        ? {
            name: lastError.name,
            message: lastError.message,
            retryable: false,
          }
        : undefined,
    });
    recordStreamRuntime(
      host,
      memoryInput,
      effectiveRuntimeTarget(),
      telemetryChunks,
      completionStartedAt,
      completedAt,
      "partial",
      lastError?.message,
    );
    throw lastError ?? new Error("chat completion stream failed after emitting output");
  }

  if (!streamed && allowCrossProviderFallback) {
    const fallbacks = filterCrossProviderFallbackTargets(
      host.resolveFallbackTargets(runtime, primaryProviderId, primaryModel),
      primaryProviderId,
    );
    for (const fallback of fallbacks) {
      for (
        let transientRetryIndex = 0;
        transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT;
        transientRetryIndex += 1
      ) {
        let attemptStreamed = false;
        try {
          const attemptTimeoutMs = getRemainingChatCompletionTimeoutMs(completionDeadline, withContext.timeoutMs);
          const fallbackRetryRequest = normalizeToolProtocolRetryRequest(
            withContext,
            TOOL_PROTOCOL_RETRY_MINIMAL_THINKING,
          );
          const idleAbort = new AbortController();
          const fallbackSignal = idleWatchdogDisabled
            ? fallbackRetryRequest.signal
            : fallbackRetryRequest.signal
              ? AbortSignal.any([fallbackRetryRequest.signal, idleAbort.signal])
              : idleAbort.signal;
          const fallbackProviderStream = host.llmService.chatCompletionsStream({
            ...fallbackRetryRequest,
            providerId: fallback.providerId,
            model: fallback.model,
            stream: true,
            timeoutMs: attemptTimeoutMs ?? withContext.timeoutMs,
            signal: fallbackSignal,
          });
          const fallbackStream = idleWatchdogDisabled
            ? fallbackProviderStream
            : withStreamIdleWatchdog(fallbackProviderStream, {
                idleTimeoutMs,
                abort: () => idleAbort.abort(new StreamIdleTimeoutError(idleTimeoutMs)),
                onTrip: (elapsedMs) => {
                  host.recordDevDiagnostic({
                    level: "warn",
                    category: "chat",
                    event: "chat.completion_stream.idle_watchdog_tripped",
                    message: "Fallback provider stream idle watchdog tripped; aborting the attempt",
                    sessionId: memoryInput?.sessionId,
                    taskId: memoryInput?.taskId,
                    providerId: fallback.providerId,
                    modelId: fallback.model,
                    runtimeKind: "model.call",
                    runtimeStatus: "degraded",
                    context: { idleTimeoutMs: elapsedMs, emittedOutput: attemptStreamed, fallback: true },
                  });
                },
              });
          for await (const chunk of fallbackStream) {
            attemptStreamed = true;
            streamed = true;
            appendTelemetryChunk(telemetryChunks, chunk);
            if (shouldBufferForTransform) {
              bufferedChunks.push(chunk);
            } else {
              yield chunk;
            }
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
          host.recordDevDiagnostic({
            level: "warn",
            category: "chat",
            event: "chat.completion_stream.fallback_failed",
            message: "Chat completion stream fallback failed",
            sessionId: memoryInput?.sessionId,
            taskId: memoryInput?.taskId,
            providerId: fallback.providerId,
            modelId: fallback.model,
            durationMs: Date.now() - completionStartedAt,
            runtimeKind: "model.call",
            runtimeStatus: "degraded",
            runtimeError: {
              name: lastError.name,
              message: lastError.message,
              retryable: shouldRetryTransientProviderError(lastError),
            },
            context: {
              error: lastError.message,
              emittedOutput: attemptStreamed,
            },
          });
          if (attemptStreamed) {
            streamFailedAfterEmit = true;
            break;
          }
          if (
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

  if (streamFailedAfterEmit) {
    const completedAt = Date.now();
    host.recordDevDiagnostic({
      level: "error",
      category: "chat",
      event: "chat.completion_stream.failed_after_emit",
      message: "Chat completion stream failed after emitting output",
      sessionId: memoryInput?.sessionId,
      taskId: memoryInput?.taskId,
      providerId: routing.effectiveProviderId ?? primaryProviderId,
      modelId: routing.effectiveModel ?? primaryModel,
      durationMs: Date.now() - completionStartedAt,
      runtimeKind: "model.call",
      runtimeStatus: "failed",
      runtimeError: lastError
        ? {
            name: lastError.name,
            message: lastError.message,
            retryable: false,
          }
        : undefined,
    });
    recordStreamRuntime(
      host,
      memoryInput,
      effectiveRuntimeTarget(),
      telemetryChunks,
      completionStartedAt,
      completedAt,
      "partial",
      lastError?.message,
    );
    throw lastError ?? new Error("chat completion stream failed after emitting output");
  }

  if (!streamed) {
    const completedAt = Date.now();
    const finalError =
      lastError && shouldReportProviderRetryCooldownExhausted(lastError)
        ? buildProviderRetryCooldownExhaustedError(lastError, { providerId: primaryProviderId, model: primaryModel })
        : lastError;
    host.recordDevDiagnostic({
      level: "error",
      category: "chat",
      event: "chat.completion_stream.failed",
      message: "Chat completion stream failed",
      sessionId: memoryInput?.sessionId,
      taskId: memoryInput?.taskId,
      providerId: primaryProviderId,
      modelId: primaryModel,
      durationMs: Date.now() - completionStartedAt,
      runtimeKind: "model.call",
      runtimeStatus: "failed",
      runtimeError: finalError
        ? {
            name: finalError.name,
            message: finalError.message,
            retryable: false,
          }
        : undefined,
      context: { retryCooldownExhausted: Boolean(lastError && finalError !== lastError) },
    });
    recordStreamRuntime(
      host,
      memoryInput,
      primaryRuntimeTarget,
      telemetryChunks,
      completionStartedAt,
      completedAt,
      "failed",
      finalError?.message,
    );
    throw finalError ?? new Error("chat completion stream failed");
  }

  // Buffered: assembled content exposed to mutate hooks (synthetic chunks returned). Passthrough: veto-only.
  let transformedChunks: Array<Record<string, unknown>>;
  try {
    transformedChunks = await applyStreamingTransformLlmOutput({
      hooksService: host.hooksService,
      workspaceId: chatHookWorkspaceId,
      entityId: chatHookEntityId,
      providerId: routing.effectiveProviderId ?? primaryProviderId,
      model: routing.effectiveModel ?? primaryModel,
      bufferedChunks,
      shouldBufferForTransform,
    });
  } catch (error) {
    const transformError = error instanceof Error ? error : new Error(String(error));
    host.recordDevDiagnostic({
      level: "error",
      category: "chat",
      event: shouldBufferForTransform ? "chat.completion_stream.failed" : "chat.completion_stream.failed_after_emit",
      message: shouldBufferForTransform
        ? "Chat completion stream transform failed before emitting output"
        : "Chat completion stream transform failed after emitting output",
      sessionId: memoryInput?.sessionId,
      taskId: memoryInput?.taskId,
      providerId: routing.effectiveProviderId ?? primaryProviderId,
      modelId: routing.effectiveModel ?? primaryModel,
      durationMs: Date.now() - completionStartedAt,
      runtimeKind: "model.call",
      runtimeStatus: "failed",
      runtimeError: {
        name: transformError.name,
        message: transformError.message,
        retryable: false,
      },
      context: {
        fallbackUsed: routing.fallbackUsed,
        emittedOutput: !shouldBufferForTransform,
        trigger: "transform_llm_output",
      },
    });
    throw transformError;
  }

  for (const chunk of transformedChunks) {
    yield chunk;
  }

  const streamCompletedAt = Date.now();
  host.recordDevDiagnostic({
    level: "info",
    category: "chat",
    event: "chat.completion_stream.complete",
    message: "Chat completion stream completed",
    sessionId: memoryInput?.sessionId,
    taskId: memoryInput?.taskId,
    providerId: routing.effectiveProviderId ?? primaryProviderId,
    modelId: routing.effectiveModel ?? primaryModel,
    durationMs: Date.now() - completionStartedAt,
    runtimeKind: "model.call",
    runtimeStatus: "completed",
    context: {
      fallbackUsed: routing.fallbackUsed,
    },
  });
  recordStreamRuntime(
    host,
    memoryInput,
    effectiveRuntimeTarget(),
    telemetryChunks,
    completionStartedAt,
    streamCompletedAt,
    "completed",
  );

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
  runtimeLifecycleHookDispatcher.enqueueObserveHook(host.hooksService, {
    workspaceId: chatHookWorkspaceId,
    trigger: "llm_output",
    entityType: "chat_completion",
    entityId: chatHookEntityId,
    payload: {
      workspaceId: chatHookWorkspaceId,
      sessionId: memoryInput?.sessionId,
      taskId: memoryInput?.taskId,
      providerId: withContext.providerId,
      model: withContext.model,
      effectiveProviderId: routing.effectiveProviderId ?? primaryProviderId,
      effectiveModel: routing.effectiveModel ?? primaryModel,
      fallbackUsed: routing.fallbackUsed ?? false,
      stream: true,
      messageCount: withContext.messages.length,
    },
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

function appendTelemetryChunk(target: Array<Record<string, unknown>>, chunk: Record<string, unknown>): void {
  target.push(chunk);
  if (target.length > 20) {
    target.shift();
  }
}

function filterCrossProviderFallbackTargets(
  fallbacks: Array<{ providerId: string; model: string }>,
  primaryProviderId: string,
): Array<{ providerId: string; model: string }> {
  return fallbacks.filter((fallback) => fallback.providerId !== primaryProviderId);
}
