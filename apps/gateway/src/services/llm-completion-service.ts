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
  ModelUsageAttributionContext,
} from "@goatcitadel/contracts";
import { shouldAllowCrossProviderFallback } from "./chat-session-utils.js";
import { ChatTurnCancelledError, isChatTurnCancelledError } from "./chat-turn-helpers.js";
import {
  CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT,
  applyNonStreamingTransformLlmOutput,
  applyStreamingTransformLlmOutput,
  attachChatCompletionFailureContext,
  buildProviderRetryCooldownExhaustedError,
  calculateSavings,
  classifyProviderFailure,
  createChatCompletionDeadline,
  delayChatCompletionRetry,
  getRemainingChatCompletionBudgetMs,
  getRemainingChatCompletionTimeoutMs,
  normalizeChatCompletionAttemptError,
  normalizeToolProtocolRetryRequest,
  insertMemoryContextMessage,
  isAuthoritativeModelUsageAccountingError,
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
  attributionInput: ModelUsageAttributionContext = {},
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
  const memoryContextInsertion = memoryContext ? insertMemoryContextMessage(request, memoryContext) : undefined;
  const withContext = memoryContextInsertion?.request ?? request;
  const memoryContextPlacement = memoryContextInsertion?.placement;

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
    memoryContextPlacement,
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
  const usageAttribution = createCompletionUsageAttribution({
    input: attributionInput,
    defaultCallKind: "chat_initial",
    workspaceId: chatHookWorkspaceId,
    sessionId: memoryInput?.sessionId,
    turnId: memoryInput?.turnId,
    durableRunId: memoryInput?.runId,
    taskId: memoryInput?.taskId,
    requestedProviderId: primaryProviderId,
    requestedModelId: primaryModel,
    requestedReasoningLevel: hookableRequest.reasoning?.effort,
  });
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
        throwIfChatCompletionRequestAborted(attemptRequest.signal, memoryInput?.turnId);
        const attemptTimeoutMs = getRemainingChatCompletionTimeoutMs(completionDeadline, hookableRequest.timeoutMs);
        response = await host.llmService.chatCompletions(
          {
            ...attemptRequest,
            timeoutMs: attemptTimeoutMs ?? attemptRequest.timeoutMs,
          },
          usageAttribution.next({
            callKind: index === 0 ? undefined : "chat_repair",
            repairIndex: index,
            dispatchedReasoningEffort: attemptRequest.reasoning?.effort,
          }),
        );
        throwIfChatCompletionRequestAborted(attemptRequest.signal, memoryInput?.turnId);
        routing.effectiveProviderId = attemptRequest.providerId ?? primaryProviderId;
        routing.effectiveModel = response.model ?? attemptRequest.model ?? primaryModel;
        routing.effectiveApiStyle = host.llmService.resolveExecutionApiStyle(
          routing.effectiveProviderId,
          attemptRequest.model ?? primaryModel,
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
        lastError =
          resolveChatCompletionRequestAbortError(attemptRequest.signal, memoryInput?.turnId) ??
          normalizeChatCompletionAttemptError(error, hookableRequest.timeoutMs);
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
            remainingBudgetMs: getRemainingChatCompletionBudgetMs(completionDeadline),
            emittedOutput: false,
            failureClass: classifyProviderFailure(lastError),
            sessionId: memoryInput?.sessionId,
            turnId: memoryInput?.turnId,
            durableRunId: memoryInput?.runId,
          },
        });

        if (isAuthoritativeModelUsageAccountingError(lastError)) {
          break attemptLoop;
        }

        if (
          transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT - 1 &&
          shouldRetryTransientProviderError(lastError)
        ) {
          if (
            await delayChatCompletionRetry(
              completionDeadline,
              hookableRequest.timeoutMs,
              transientRetryIndex,
              attemptRequest.signal,
            )
          ) {
            continue;
          }
          lastError = resolveChatCompletionRequestAbortError(attemptRequest.signal, memoryInput?.turnId) ?? lastError;
          break attemptLoop;
        }
        if (index < retryAttempts.length - 1 && shouldRetryToolProtocolError(lastError)) {
          if (
            await delayChatCompletionRetry(completionDeadline, hookableRequest.timeoutMs, index, attemptRequest.signal)
          ) {
            continue attemptLoop;
          }
          lastError = resolveChatCompletionRequestAbortError(attemptRequest.signal, memoryInput?.turnId) ?? lastError;
        }
        break attemptLoop;
      }
    }
  }

  lastError = resolveChatCompletionRequestAbortError(hookableRequest.signal, memoryInput?.turnId) ?? lastError;
  if (!response && allowCrossProviderFallback && (!lastError || shouldAttemptCrossProviderFallback(lastError))) {
    const fallbackRequiresToolProtocolNormalization = Boolean(lastError && shouldRetryToolProtocolError(lastError));
    const fallbacks = filterCrossProviderFallbackTargets(
      host.resolveFallbackTargets(runtime, primaryProviderId, primaryModel),
      primaryProviderId,
    );
    fallbackLoop: for (const [fallbackOrdinal, fallback] of fallbacks.entries()) {
      if (
        !(await delayChatCompletionRetry(
          completionDeadline,
          hookableRequest.timeoutMs,
          fallbackOrdinal,
          hookableRequest.signal,
        ))
      ) {
        lastError = resolveChatCompletionRequestAbortError(hookableRequest.signal, memoryInput?.turnId) ?? lastError;
        break;
      }
      for (
        let transientRetryIndex = 0;
        transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT;
        transientRetryIndex += 1
      ) {
        try {
          throwIfChatCompletionRequestAborted(hookableRequest.signal, memoryInput?.turnId);
          const attemptTimeoutMs = getRemainingChatCompletionTimeoutMs(completionDeadline, hookableRequest.timeoutMs);
          const fallbackRequest = fallbackRequiresToolProtocolNormalization
            ? normalizeToolProtocolRetryRequest(hookableRequest, TOOL_PROTOCOL_RETRY_MINIMAL_THINKING)
            : hookableRequest;
          response = await host.llmService.chatCompletions(
            {
              ...fallbackRequest,
              providerId: fallback.providerId,
              model: fallback.model,
              timeoutMs: attemptTimeoutMs ?? hookableRequest.timeoutMs,
            },
            usageAttribution.next({
              callKind: "chat_fallback",
              fallbackIndex: fallbackOrdinal + 1,
              repairIndex: fallbackRequiresToolProtocolNormalization ? TOOL_PROTOCOL_RETRY_MINIMAL_THINKING : 0,
              dispatchedReasoningEffort: fallbackRequest.reasoning?.effort,
            }),
          );
          throwIfChatCompletionRequestAborted(hookableRequest.signal, memoryInput?.turnId);
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
          routing.fallbackApiStyle = host.llmService.resolveExecutionApiStyle(fallback.providerId, fallback.model);
          routing.fallbackReason = `primary failed (${lastError?.message ?? "unknown error"})`;
          routing.effectiveProviderId = fallback.providerId;
          routing.effectiveModel = routing.fallbackModel;
          routing.effectiveApiStyle = routing.fallbackApiStyle;
          break;
        } catch (error) {
          lastError =
            resolveChatCompletionRequestAbortError(hookableRequest.signal, memoryInput?.turnId) ??
            normalizeChatCompletionAttemptError(error, hookableRequest.timeoutMs);
          if (isAuthoritativeModelUsageAccountingError(lastError)) {
            break fallbackLoop;
          }
          if (
            transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT - 1 &&
            shouldRetryTransientProviderError(lastError)
          ) {
            if (
              await delayChatCompletionRetry(
                completionDeadline,
                hookableRequest.timeoutMs,
                transientRetryIndex,
                hookableRequest.signal,
              )
            ) {
              continue;
            }
            lastError =
              resolveChatCompletionRequestAbortError(hookableRequest.signal, memoryInput?.turnId) ?? lastError;
            break fallbackLoop;
          }
          break;
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
        remainingBudgetMs: getRemainingChatCompletionBudgetMs(completionDeadline),
        emittedOutput: false,
        failureClass: finalError ? classifyProviderFailure(finalError) : "unknown",
        sessionId: memoryInput?.sessionId,
        turnId: memoryInput?.turnId,
        durableRunId: memoryInput?.runId,
      },
    });
    recordFailedChatRuntime(host, request, primaryRuntimeTarget, completionStartedAt, completedAt, finalError?.message);
    throw attachChatCompletionFailureContext(finalError ?? new Error("chat completion failed"), {
      deadlineAtMs: completionDeadline,
      emittedOutput: false,
    });
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
  attributionInput: ModelUsageAttributionContext = {},
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
  const memoryContextInsertion = memoryContext ? insertMemoryContextMessage(request, memoryContext) : undefined;
  const withContext = memoryContextInsertion?.request ?? request;
  const memoryContextPlacement = memoryContextInsertion?.placement;
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
    memoryContextPlacement,
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
  const usageAttribution = createCompletionUsageAttribution({
    input: attributionInput,
    defaultCallKind: "chat_initial",
    workspaceId: chatHookWorkspaceId,
    sessionId: memoryInput?.sessionId,
    turnId: memoryInput?.turnId,
    durableRunId: memoryInput?.runId,
    taskId: memoryInput?.taskId,
    requestedProviderId: primaryProviderId,
    requestedModelId: primaryModel,
    requestedReasoningLevel: withContext.reasoning?.effort,
  });
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
  const canonicalUsageEventIds = new Set<string>();
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
        throwIfChatCompletionRequestAborted(attemptRequest.signal, memoryInput?.turnId);
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
        const providerStream = host.llmService.chatCompletionsStream(
          {
            ...attemptRequest,
            stream: true,
            timeoutMs: attemptTimeoutMs ?? attemptRequest.timeoutMs,
            signal: attemptSignal,
          },
          usageAttribution.next({
            callKind: index === 0 ? undefined : "chat_repair",
            repairIndex: index,
            dispatchedReasoningEffort: attemptRequest.reasoning?.effort,
          }),
        );
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
        let returnedModel: string | undefined;
        for await (const chunk of attemptStream) {
          throwIfChatCompletionRequestAborted(attemptRequest.signal, memoryInput?.turnId);
          attemptStreamed = true;
          streamed = true;
          returnedModel = readReturnedStreamModel(chunk) ?? returnedModel;
          appendTelemetryChunk(telemetryChunks, chunk);
          collectCanonicalUsageEventIds(canonicalUsageEventIds, chunk);
          if (shouldBufferForTransform) {
            bufferedChunks.push(chunk);
          } else {
            yield chunk;
          }
        }
        throwIfChatCompletionRequestAborted(attemptRequest.signal, memoryInput?.turnId);
        routing.effectiveProviderId = attemptRequest.providerId ?? primaryProviderId;
        routing.effectiveModel = returnedModel ?? attemptRequest.model ?? primaryModel;
        routing.effectiveApiStyle = host.llmService.resolveExecutionApiStyle(
          routing.effectiveProviderId,
          attemptRequest.model ?? primaryModel,
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
        lastError =
          resolveChatCompletionRequestAbortError(attemptRequest.signal, memoryInput?.turnId) ??
          normalizeChatCompletionAttemptError(error, withContext.timeoutMs);
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
            remainingBudgetMs: getRemainingChatCompletionBudgetMs(completionDeadline),
            failureClass: classifyProviderFailure(lastError),
            sessionId: memoryInput?.sessionId,
            turnId: memoryInput?.turnId,
            durableRunId: memoryInput?.runId,
          },
        });
        if (isAuthoritativeModelUsageAccountingError(lastError)) {
          if (attemptStreamed) streamFailedAfterEmit = true;
          break attemptLoop;
        }
        if (attemptStreamed) {
          streamFailedAfterEmit = true;
          break attemptLoop;
        }
        if (
          transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT - 1 &&
          shouldRetryTransientProviderError(lastError)
        ) {
          if (
            await delayChatCompletionRetry(
              completionDeadline,
              withContext.timeoutMs,
              transientRetryIndex,
              attemptRequest.signal,
            )
          ) {
            continue;
          }
          lastError = resolveChatCompletionRequestAbortError(attemptRequest.signal, memoryInput?.turnId) ?? lastError;
          break attemptLoop;
        }
        if (index < retryAttempts.length - 1 && shouldRetryToolProtocolError(lastError)) {
          if (await delayChatCompletionRetry(completionDeadline, withContext.timeoutMs, index, attemptRequest.signal)) {
            continue attemptLoop;
          }
          lastError = resolveChatCompletionRequestAbortError(attemptRequest.signal, memoryInput?.turnId) ?? lastError;
        }
        break attemptLoop;
      }
    }
  }

  lastError = resolveChatCompletionRequestAbortError(withContext.signal, memoryInput?.turnId) ?? lastError;

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
      context: {
        remainingBudgetMs: getRemainingChatCompletionBudgetMs(completionDeadline),
        emittedOutput: true,
        failureClass: lastError ? classifyProviderFailure(lastError) : "unknown",
        sessionId: memoryInput?.sessionId,
        turnId: memoryInput?.turnId,
        durableRunId: memoryInput?.runId,
      },
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
    throw attachChatCompletionFailureContext(
      lastError ?? new Error("chat completion stream failed after emitting output"),
      {
        deadlineAtMs: completionDeadline,
        emittedOutput: true,
      },
    );
  }

  if (!streamed && allowCrossProviderFallback && (!lastError || shouldAttemptCrossProviderFallback(lastError))) {
    const fallbackRequiresToolProtocolNormalization = Boolean(lastError && shouldRetryToolProtocolError(lastError));
    const fallbacks = filterCrossProviderFallbackTargets(
      host.resolveFallbackTargets(runtime, primaryProviderId, primaryModel),
      primaryProviderId,
    );
    fallbackLoop: for (const [fallbackOrdinal, fallback] of fallbacks.entries()) {
      if (
        !(await delayChatCompletionRetry(
          completionDeadline,
          withContext.timeoutMs,
          fallbackOrdinal,
          withContext.signal,
        ))
      ) {
        lastError = resolveChatCompletionRequestAbortError(withContext.signal, memoryInput?.turnId) ?? lastError;
        break;
      }
      for (
        let transientRetryIndex = 0;
        transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT;
        transientRetryIndex += 1
      ) {
        let attemptStreamed = false;
        try {
          throwIfChatCompletionRequestAborted(withContext.signal, memoryInput?.turnId);
          const attemptTimeoutMs = getRemainingChatCompletionTimeoutMs(completionDeadline, withContext.timeoutMs);
          const fallbackRetryRequest = fallbackRequiresToolProtocolNormalization
            ? normalizeToolProtocolRetryRequest(withContext, TOOL_PROTOCOL_RETRY_MINIMAL_THINKING)
            : withContext;
          const idleAbort = new AbortController();
          const fallbackSignal = idleWatchdogDisabled
            ? fallbackRetryRequest.signal
            : fallbackRetryRequest.signal
              ? AbortSignal.any([fallbackRetryRequest.signal, idleAbort.signal])
              : idleAbort.signal;
          const fallbackProviderStream = host.llmService.chatCompletionsStream(
            {
              ...fallbackRetryRequest,
              providerId: fallback.providerId,
              model: fallback.model,
              stream: true,
              timeoutMs: attemptTimeoutMs ?? withContext.timeoutMs,
              signal: fallbackSignal,
            },
            usageAttribution.next({
              callKind: "chat_fallback",
              fallbackIndex: fallbackOrdinal + 1,
              repairIndex: fallbackRequiresToolProtocolNormalization ? TOOL_PROTOCOL_RETRY_MINIMAL_THINKING : 0,
              dispatchedReasoningEffort: fallbackRetryRequest.reasoning?.effort,
            }),
          );
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
          let returnedModel: string | undefined;
          for await (const chunk of fallbackStream) {
            throwIfChatCompletionRequestAborted(withContext.signal, memoryInput?.turnId);
            attemptStreamed = true;
            streamed = true;
            returnedModel = readReturnedStreamModel(chunk) ?? returnedModel;
            appendTelemetryChunk(telemetryChunks, chunk);
            collectCanonicalUsageEventIds(canonicalUsageEventIds, chunk);
            if (shouldBufferForTransform) {
              bufferedChunks.push(chunk);
            } else {
              yield chunk;
            }
          }
          throwIfChatCompletionRequestAborted(withContext.signal, memoryInput?.turnId);
          routing.fallbackUsed = true;
          routing.fallbackProviderId = fallback.providerId;
          routing.fallbackModel = returnedModel ?? fallback.model;
          routing.fallbackApiStyle = host.llmService.resolveExecutionApiStyle(fallback.providerId, fallback.model);
          routing.fallbackReason = `primary failed (${lastError?.message ?? "unknown error"})`;
          routing.effectiveProviderId = fallback.providerId;
          routing.effectiveModel = routing.fallbackModel;
          routing.effectiveApiStyle = routing.fallbackApiStyle;
          break;
        } catch (error) {
          lastError =
            resolveChatCompletionRequestAbortError(withContext.signal, memoryInput?.turnId) ??
            normalizeChatCompletionAttemptError(error, withContext.timeoutMs);
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
              remainingBudgetMs: getRemainingChatCompletionBudgetMs(completionDeadline),
              failureClass: classifyProviderFailure(lastError),
              sessionId: memoryInput?.sessionId,
              turnId: memoryInput?.turnId,
              durableRunId: memoryInput?.runId,
            },
          });
          if (isAuthoritativeModelUsageAccountingError(lastError)) {
            if (attemptStreamed) streamFailedAfterEmit = true;
            break fallbackLoop;
          }
          if (attemptStreamed) {
            streamFailedAfterEmit = true;
            break;
          }
          if (
            transientRetryIndex < CHAT_COMPLETION_TRANSIENT_RETRY_LIMIT - 1 &&
            shouldRetryTransientProviderError(lastError)
          ) {
            if (
              await delayChatCompletionRetry(
                completionDeadline,
                withContext.timeoutMs,
                transientRetryIndex,
                withContext.signal,
              )
            ) {
              continue;
            }
            lastError = resolveChatCompletionRequestAbortError(withContext.signal, memoryInput?.turnId) ?? lastError;
            break fallbackLoop;
          }
          break;
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
      context: {
        remainingBudgetMs: getRemainingChatCompletionBudgetMs(completionDeadline),
        emittedOutput: true,
        failureClass: lastError ? classifyProviderFailure(lastError) : "unknown",
        sessionId: memoryInput?.sessionId,
        turnId: memoryInput?.turnId,
        durableRunId: memoryInput?.runId,
      },
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
    throw attachChatCompletionFailureContext(
      lastError ?? new Error("chat completion stream failed after emitting output"),
      {
        deadlineAtMs: completionDeadline,
        emittedOutput: true,
      },
    );
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
      context: {
        retryCooldownExhausted: Boolean(lastError && finalError !== lastError),
        remainingBudgetMs: getRemainingChatCompletionBudgetMs(completionDeadline),
        emittedOutput: false,
        failureClass: finalError ? classifyProviderFailure(finalError) : "unknown",
        sessionId: memoryInput?.sessionId,
        turnId: memoryInput?.turnId,
        durableRunId: memoryInput?.runId,
      },
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
    throw attachChatCompletionFailureContext(finalError ?? new Error("chat completion stream failed"), {
      deadlineAtMs: completionDeadline,
      emittedOutput: false,
    });
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
    ...(canonicalUsageEventIds.size > 0 ? { model_usage_event_ids: [...canonicalUsageEventIds] } : {}),
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

function createCompletionUsageAttribution(input: {
  input: ModelUsageAttributionContext;
  defaultCallKind: NonNullable<ModelUsageAttributionContext["callKind"]>;
  workspaceId?: string;
  sessionId?: string;
  turnId?: string;
  durableRunId?: string;
  taskId?: string;
  requestedProviderId: string;
  requestedModelId: string;
  requestedReasoningLevel?: string;
}): {
  next: (
    overrides?: Pick<
      ModelUsageAttributionContext,
      "callKind" | "fallbackIndex" | "repairIndex" | "dispatchedReasoningEffort"
    >,
  ) => ModelUsageAttributionContext;
} {
  const base: ModelUsageAttributionContext = {
    ...input.input,
    operationId: input.input.operationId?.trim() || `completion:${randomUUID()}`,
    dispatchGeneration: input.input.dispatchGeneration?.trim() || randomUUID(),
    callKind: input.input.callKind ?? input.defaultCallKind,
    requestedProviderId: input.input.requestedProviderId?.trim() || input.requestedProviderId,
    requestedModelId: input.input.requestedModelId?.trim() || input.requestedModelId,
    requestedReasoningLevel:
      input.input.requestedReasoningLevel?.trim() || input.requestedReasoningLevel?.trim() || undefined,
    workspaceId: input.input.workspaceId?.trim() || input.workspaceId?.trim() || undefined,
    sessionId: input.input.sessionId?.trim() || input.sessionId?.trim() || undefined,
    turnId: input.input.turnId?.trim() || input.turnId?.trim() || undefined,
    durableRunId: input.input.durableRunId?.trim() || input.durableRunId?.trim() || undefined,
    taskId: input.input.taskId?.trim() || input.taskId?.trim() || undefined,
    fallbackIndex: input.input.fallbackIndex ?? 0,
    repairIndex: input.input.repairIndex ?? 0,
  };
  let nextAttemptIndex = input.input.attemptIndex ?? 0;
  return {
    next: (overrides = {}) => {
      const requestedReasoningLevel = base.requestedReasoningLevel?.trim() || undefined;
      const dispatchedReasoningEffort =
        overrides.dispatchedReasoningEffort?.trim() || base.dispatchedReasoningEffort?.trim() || undefined;
      const derivedReasoning = deriveReasoningDisposition(requestedReasoningLevel, dispatchedReasoningEffort);
      return {
        ...base,
        ...overrides,
        callKind: overrides.callKind ?? base.callKind,
        attemptIndex: nextAttemptIndex++,
        fallbackIndex: overrides.fallbackIndex ?? base.fallbackIndex,
        repairIndex: overrides.repairIndex ?? base.repairIndex,
        requestedReasoningLevel,
        dispatchedReasoningEffort,
        reasoningDisposition: base.reasoningDisposition ?? derivedReasoning.disposition,
        reasoningReasonCode: base.reasoningReasonCode?.trim() || derivedReasoning.reasonCode,
      };
    },
  };
}

function deriveReasoningDisposition(
  requestedReasoningLevel: string | undefined,
  dispatchedReasoningEffort: string | undefined,
): {
  disposition: NonNullable<ModelUsageAttributionContext["reasoningDisposition"]>;
  reasonCode: string;
} {
  if (!requestedReasoningLevel) {
    return { disposition: "provider_default", reasonCode: "no_explicit_reasoning_request" };
  }
  if (requestedReasoningLevel === dispatchedReasoningEffort) {
    return { disposition: "honored", reasonCode: "requested_reasoning_preserved" };
  }
  return {
    disposition: "downgraded",
    reasonCode: dispatchedReasoningEffort
      ? "reasoning_effort_changed_before_dispatch"
      : "reasoning_effort_removed_before_dispatch",
  };
}

function collectCanonicalUsageEventIds(target: Set<string>, chunk: Record<string, unknown>): void {
  const candidates = [
    ...(Array.isArray(chunk.model_usage_event_ids) ? chunk.model_usage_event_ids : []),
    chunk.model_usage_event_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized && normalized.length <= 256 && target.size < 256) target.add(normalized);
  }
}

function readReturnedStreamModel(chunk: Record<string, unknown>): string | undefined {
  if (typeof chunk.model !== "string") return undefined;
  const normalized = chunk.model.trim();
  return normalized && normalized.length <= 512 ? normalized : undefined;
}

function resolveChatCompletionRequestAbortError(
  signal: AbortSignal | undefined,
  turnId: string | undefined,
): Error | undefined {
  if (!signal?.aborted) return undefined;
  const reason = signal.reason;
  if (reason instanceof Error && isChatTurnCancelledError(reason)) {
    return reason;
  }
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.trim()
        ? reason.trim()
        : "Chat turn cancelled.";
  return new ChatTurnCancelledError(turnId?.trim() || "unknown", message);
}

function throwIfChatCompletionRequestAborted(signal: AbortSignal | undefined, turnId: string | undefined): void {
  const error = resolveChatCompletionRequestAbortError(signal, turnId);
  if (error) throw error;
}

function filterCrossProviderFallbackTargets(
  fallbacks: Array<{ providerId: string; model: string }>,
  primaryProviderId: string,
): Array<{ providerId: string; model: string }> {
  return fallbacks.filter((fallback) => fallback.providerId !== primaryProviderId);
}
