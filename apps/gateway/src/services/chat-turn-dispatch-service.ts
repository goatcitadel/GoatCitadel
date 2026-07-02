/**
 * Chat turn dispatch helpers.
 *
 * Routes prepared chat turns through the narrowed runtime host without
 * depending on the full gateway facade.
 */

import { randomUUID } from "node:crypto";
import { NotFoundError } from "@goatcitadel/contracts";
import type {
  ChatCitationRecord,
  ChatMessageRecord,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionBindingRecord,
  ChatStreamChunkDraft,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { dedupeChatCitations, splitIntoChunks } from "./chat-turn-helpers.js";
import {
  isPersistableChatStreamChunk,
  type InspectableChatStreamChunk,
  type PreparedChatExecutionPlanResolution,
} from "./chat-turn-types.js";
import { buildChatTurnRealtimeOptions } from "./chat-turn-realtime.js";
import { resolvePreparedTurnMode, type PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import * as chatTurnStreamService from "./chat-turn-stream-service.js";
import type {
  ChatTurnDurableRunOwner,
  ChatTurnIntegrationDispatch,
  ChatTurnStreamLifecycleControl,
} from "./chat-turn-runtime-collaborators.js";

export interface ChatTurnDispatchHost
  extends
    chatTurnStreamService.ChatTurnStreamHost,
    ChatTurnDurableRunOwner,
    ChatTurnIntegrationDispatch,
    ChatTurnStreamLifecycleControl {
  readonly storage: chatTurnStreamService.ChatTurnStreamHost["storage"] & Pick<Storage, "durableRuns">;
  updateActiveLeafOrThrow(sessionId: string, previousActiveTurnId: string | undefined, nextActiveTurnId: string): void;
}

export function isDurableExecutionEnabled(host: ChatTurnDispatchHost): boolean {
  return (
    host.config.assistant.durable.enabled &&
    host.config.assistant.durable.executionEnabled &&
    host.isFeatureEnabled("durableKernelV1Enabled")
  );
}

export function shouldUseDurableExecution(
  host: ChatTurnDispatchHost,
  prepared: PreparedAgentChatTurn,
  input: ChatSendMessageRequest,
): boolean {
  if (!isDurableExecutionEnabled(host)) {
    return false;
  }
  if (prepared.normalized.normalizationProfile === "quick_web") {
    return false;
  }
  const mode = resolvePreparedTurnMode(prepared);
  if (mode === "chat" || mode === "cowork" || mode === "code") {
    return true;
  }
  if (mode !== undefined || !host.config.assistant.durable.chatAutoPromoteEnabled) {
    return false;
  }
  const webMode = prepared.normalized.webMode ?? prepared.prefs.webMode;
  if (webMode === "deep") {
    return true;
  }
  if (prepared.autonomy.reflectionMode === "on" || prepared.prefs.reflectionMode === "on") {
    return true;
  }
  const content = prepared.content.toLowerCase();
  return (
    content.includes("http://") ||
    content.includes("https://") ||
    content.includes("browser.navigate") ||
    content.includes("browser.extract") ||
    content.includes("http.get") ||
    content.includes("http.post") ||
    /\b(fetch|scrape|extract|browse|navigate|research|look up|find on the web|http get|http post)\b/i.test(content) ||
    Boolean(input.attachments?.length)
  );
}

export async function consumePreparedAgentChatTurn(
  host: ChatTurnDispatchHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  prepared: PreparedAgentChatTurn,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  resolvedOrchestration?: PreparedChatExecutionPlanResolution,
  options?: { abortSignal?: AbortSignal; onChildDurableRunLaunched?: (runId: string) => void },
): Promise<ChatSendMessageResponse> {
  let assistantMessage: ChatMessageRecord | undefined;
  let trace: ChatTurnTraceRecord | undefined;
  let citations: ChatCitationRecord[] = [];
  const useDurableExecution = shouldUseDurableExecution(host, prepared, input);
  let launchedDurableRunId: string | undefined;
  if (useDurableExecution) {
    launchedDurableRunId = launchPreparedAgentChatTurnStream(
      host,
      sessionId,
      input,
      prepared,
      threadEventType,
      resolvedOrchestration,
    );
    if (launchedDurableRunId && options?.onChildDurableRunLaunched) {
      // Report the launched durable child run id to interested callers (e.g.
      // orchestration phase dispatch) the moment the child run row exists, so a
      // crash mid-turn leaves a harvestable linkage instead of a re-dispatch.
      options.onChildDurableRunLaunched(launchedDurableRunId);
    }
  }
  // Wire the external abort signal to both the in-process turn controller
  // (used by the inline orchestration path that registers via
  // `beginActiveChatTurnExecution`) and, when running durable, the
  // durable-kernel cancel API. For durable runs the worker may execute on
  // another node; calling `cancelDurableChatRun` is a soft cancel that
  // tells the kernel to stop, while aborting the local controller lets
  // the parent's await-loop bail out promptly via `ChatTurnCancelledError`.
  const detachAbortListener = bindConsumeAbortToTurn(host, prepared.turnId, launchedDurableRunId, options?.abortSignal);
  try {
    const source: AsyncGenerator<InspectableChatStreamChunk> = useDurableExecution
      ? host.streamPersistedChatTurnEvents(sessionId, prepared.turnId, {
          liveTail: true,
          returnOnDurableInterrupt: true,
        })
      : chatTurnStreamService.streamPreparedAgentChatTurn(
          host,
          sessionId,
          input,
          prepared,
          threadEventType,
          resolvedOrchestration,
          options?.abortSignal ? { abortSignal: options.abortSignal } : undefined,
        );
    for await (const chunk of source) {
      if (chunk.type === "message_done") {
        assistantMessage = {
          messageId: chunk.messageId,
          sessionId,
          role: "assistant",
          actorType: "agent",
          actorId: "assistant",
          content: chunk.content,
          timestamp: new Date().toISOString(),
        };
      } else if (chunk.type === "trace_update") {
        trace = chunk.trace;
      } else if (chunk.type === "citation") {
        citations = dedupeChatCitations([...citations, chunk.citation]);
      }
    }
    const dedupedTraceCitations = dedupeChatCitations(trace?.citations ?? []);
    return {
      sessionId,
      userMessage: prepared.userMessage,
      assistantMessage,
      transport: "llm",
      model: trace?.model ?? input.model ?? prepared.prefs.model,
      turnId: prepared.turnId,
      trace: trace ? { ...trace, citations: dedupedTraceCitations } : trace,
      citations: dedupeChatCitations(citations),
      routing: trace?.routing,
    };
  } finally {
    detachAbortListener?.();
  }
}

function bindConsumeAbortToTurn(
  host: ChatTurnDispatchHost,
  turnId: string,
  durableRunId: string | undefined,
  externalSignal: AbortSignal | undefined,
): (() => void) | undefined {
  if (!externalSignal) {
    return undefined;
  }
  const fire = (): void => {
    // Soft-cancel the durable kernel run first so the worker stops
    // promptly; the failure handler in `executePreparedAgentChatTurnBackground`
    // then settles the trace. Cancellation faults are swallowed because the
    // parent's local controller abort below still ensures this caller
    // returns control to its parent.
    if (durableRunId && host.cancelDurableChatRun) {
      try {
        host.cancelDurableChatRun(durableRunId, "abort_signal");
      } catch {
        // best effort: cancel API may reject if the run already terminated
      }
    }
    // Abort the in-process controller registered by `beginActiveChatTurnExecution`
    // so `streamPreparedAgentChatTurn` and the orchestration's nested calls
    // observe the abort and bail out via `ChatTurnCancelledError`.
    const active = host.getActiveChatTurnExecution(turnId);
    if (active && !active.controller.signal.aborted) {
      active.controller.abort();
    }
  };
  if (externalSignal.aborted) {
    fire();
    return undefined;
  }
  externalSignal.addEventListener("abort", fire);
  return () => {
    externalSignal.removeEventListener("abort", fire);
  };
}

export async function executePreparedAgentChatTurnBackground(
  host: ChatTurnDispatchHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  prepared: PreparedAgentChatTurn,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  durableRunId?: string,
  resolvedOrchestration?: PreparedChatExecutionPlanResolution,
  options?: {
    skipMessageStart?: boolean;
    abortSignal?: AbortSignal;
  },
): Promise<void> {
  try {
    for await (const rawChunk of chatTurnStreamService.streamPreparedAgentChatTurn(
      host,
      sessionId,
      input,
      prepared,
      threadEventType,
      resolvedOrchestration,
      options,
    )) {
      const chunk =
        rawChunk.type === "trace_update" && durableRunId
          ? {
              ...rawChunk,
              trace: {
                ...rawChunk.trace,
                durable: {
                  runId: durableRunId,
                  status: host.storage.durableRuns.getRun(durableRunId).status,
                  checkpointKind: rawChunk.trace.durable?.checkpointKind ?? "run_started",
                },
              },
            }
          : rawChunk;
      if (isPersistableChatStreamChunk(chunk)) {
        host.persistChatStreamChunk(chunk, durableRunId);
      }
    }
  } catch (error) {
    host.recordDevDiagnostic({
      level: "warn",
      category: "chat",
      event: "chat.dispatch.background_failed",
      message: "Chat turn background execution failed",
      sessionId,
      turnId: prepared.turnId,
      runId: durableRunId,
      taskId: prepared.content ? `chat-turn:${prepared.turnId}` : undefined,
      providerId: input.providerId ?? prepared.prefs.providerId,
      modelId: input.model ?? prepared.prefs.model,
      runtimeKind: "chat.dispatch",
      runtimeStatus: "failed",
      runtimeError: {
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : "Chat stream execution failed.",
        retryable: true,
      },
      context: {
        error: error instanceof Error ? error.message : "Chat stream execution failed.",
        durableRunId,
      },
    });
    let currentTrace: ChatTurnTraceRecord | undefined;
    try {
      currentTrace = host.storage.chatTurnTraces.get(prepared.turnId);
    } catch (lookupError) {
      if (!(lookupError instanceof NotFoundError)) {
        throw lookupError;
      }
    }
    if (currentTrace) {
      const patchedTrace = host.storage.chatTurnTraces.patch(prepared.turnId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        failure: {
          failureClass: "unknown",
          message: error instanceof Error ? error.message : "Chat stream execution failed.",
          retryable: true,
          recommendedAction: "retry",
        },
        completion: {
          finishReason: currentTrace.completion?.finishReason,
          status: "interrupted",
          repaired: Boolean(currentTrace.completion?.repaired),
        },
      });
      host.persistChatStreamChunk(
        {
          type: "trace_update",
          sessionId,
          turnId: prepared.turnId,
          trace: host.createHydratedChatTurnTrace(prepared.turnId, patchedTrace),
        },
        durableRunId,
      );
    }
    host.persistChatStreamChunk(
      {
        type: "error",
        sessionId,
        turnId: prepared.turnId,
        error: error instanceof Error ? error.message : "Chat stream execution failed.",
      },
      durableRunId,
    );
  } finally {
    let finalTrace: ChatTurnTraceRecord | undefined;
    try {
      finalTrace = host.storage.chatTurnTraces.get(prepared.turnId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        // eslint-disable-next-line no-console
        console.error("Failed to load chat turn trace during stream finalization", error);
      }
    }
    if (durableRunId && finalTrace) {
      host.finalizeDurableChatRun(durableRunId, prepared, finalTrace);
    }
    host.completeActiveChatTurnStream(prepared.turnId);
    setTimeout(() => host.closeActiveChatTurnStream(prepared.turnId), 30_000);
  }
}

export function launchPreparedAgentChatTurnStream(
  host: ChatTurnDispatchHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  prepared: PreparedAgentChatTurn,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  resolvedOrchestration?: PreparedChatExecutionPlanResolution,
): string | undefined {
  const durableRequested = shouldUseDurableExecution(host, prepared, input);
  const durableRun = host.beginDurableChatRun(prepared, input, threadEventType);
  host.registerActiveChatTurnStream(sessionId, prepared.turnId, durableRun?.runId);
  host.recordDevDiagnostic({
    level: "info",
    category: "chat",
    event: "chat.dispatch.stream_registered",
    message: "Registered active chat turn stream before dispatch",
    sessionId,
    turnId: prepared.turnId,
    runId: durableRun?.runId,
    taskId: `chat-turn:${prepared.turnId}`,
    providerId: input.providerId ?? prepared.prefs.providerId,
    modelId: input.model ?? prepared.prefs.model,
    runtimeKind: "chat.dispatch",
    runtimeStatus: "started",
    context: {
      durableRequested,
      durableRunId: durableRun?.runId,
      threadEventType,
    },
  });
  if (durableRun) {
    return durableRun.runId;
  }
  if (durableRequested) {
    persistDurableUnavailableFailure(host, sessionId, prepared);
    return undefined;
  }
  const task = executePreparedAgentChatTurnBackground(
    host,
    sessionId,
    input,
    prepared,
    threadEventType,
    undefined,
    resolvedOrchestration,
  );
  task.finally(() => host.backgroundTasks.delete(task));
  host.backgroundTasks.add(task);
  return undefined;
}

function persistDurableUnavailableFailure(
  host: ChatTurnDispatchHost,
  sessionId: string,
  prepared: PreparedAgentChatTurn,
): void {
  host.recordDevDiagnostic({
    level: "warn",
    category: "chat",
    event: "chat.dispatch.durable_unavailable",
    message: "Durable chat dispatch failed before provider execution",
    sessionId,
    turnId: prepared.turnId,
    taskId: `chat-turn:${prepared.turnId}`,
    providerId: prepared.prefs.providerId,
    modelId: prepared.prefs.model,
    runtimeKind: "chat.dispatch",
    runtimeStatus: "failed",
    runtimeError: {
      message: "Durable execution could not start for this shipped operator surface.",
      retryable: false,
    },
    context: {
      failureClass: "durable_unavailable",
      providerCallStarted: false,
    },
  });
  const failedTrace = host.storage.chatTurnTraces.patch(prepared.turnId, {
    status: "failed",
    finishedAt: new Date().toISOString(),
    failure: {
      failureClass: "unknown",
      message: "Durable execution could not start for this shipped operator surface.",
      retryable: false,
      recommendedAction: "check_gateway_connection",
    },
    completion: {
      finishReason: "error",
      status: "interrupted",
      repaired: false,
    },
  });
  host.persistChatStreamChunk({
    type: "trace_update",
    sessionId,
    turnId: prepared.turnId,
    trace: host.createHydratedChatTurnTrace(prepared.turnId, failedTrace),
  });
  host.persistChatStreamChunk({
    type: "error",
    sessionId,
    turnId: prepared.turnId,
    error: "durable_unavailable: shipped Chat/Cowork/Code sends must allocate a durable run before execution.",
  });
  host.completeActiveChatTurnStream(prepared.turnId);
  setTimeout(() => host.closeActiveChatTurnStream(prepared.turnId), 30_000);
}

export async function sendPreparedIntegrationChatTurn(
  host: ChatTurnDispatchHost,
  sessionId: string,
  input: Partial<ChatSendMessageRequest>,
  prepared: PreparedAgentChatTurn,
  binding: ChatSessionBindingRecord,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  options?: { abortSignal?: AbortSignal },
): Promise<ChatSendMessageResponse> {
  const startedAt = new Date().toISOString();
  host.storage.chatTurnTraces.create({
    turnId: prepared.turnId,
    sessionId,
    userMessageId: prepared.userEventId,
    parentTurnId: prepared.parentTurnId,
    branchKind: prepared.branchKind,
    sourceTurnId: prepared.sourceTurnId,
    status: "running",
    mode: resolvePreparedTurnMode(prepared),
    webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
    memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
    thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
    speedMode: prepared.normalized.speedMode ?? prepared.prefs.speedMode,
    subagentPolicy: prepared.normalized.subagentPolicy ?? prepared.prefs.subagentPolicy,
    effectiveToolAutonomy: prepared.effectiveToolAutonomy,
    routing: {},
    startedAt,
  });

  try {
    if (!binding.connectionId || !binding.target) {
      throw new Error("Integration binding is missing connectionId or target");
    }
    if (!binding.writable) {
      throw new Error("Session binding is not writable");
    }
    host.ensureSessionInternalToolGrant(sessionId, "channel.send", "system-integration-compose");
    host.requireExecutedToolResult(
      "channel.send",
      await host.commsSend({
        connectionId: binding.connectionId,
        target: binding.target,
        message: prepared.content,
        sessionId,
        workspaceId: prepared.workspaceId,
        agentId: input.operatorId ?? input.authActorId ?? "operator",
        operatorId: input.operatorId,
        authActorId: input.authActorId,
        authActorSource: input.authActorSource,
        taskId: input.policyTaskId,
        runId: input.policyRunId,
        permissionProfileId: input.permissionProfileId,
        localOperatorOverrideId: input.localOperatorOverrideId,
        surface: input.mode ?? resolvePreparedTurnMode(prepared),
        signal: options?.abortSignal,
      }),
    );
    const assistantContent = `Delivered via integration ${binding.connectionId} to ${binding.target}.`;
    const assistantMessageId = prepared.assistantMessageId;
    await host.ingestEvent(randomUUID(), {
      eventId: assistantMessageId,
      route: prepared.route,
      actor: {
        type: "system",
        id: "integration",
      },
      message: {
        role: "assistant",
        content: assistantContent,
      },
    });
    const assistantMessage: ChatMessageRecord = {
      messageId: assistantMessageId,
      sessionId,
      role: "assistant",
      actorType: "system",
      actorId: "integration",
      content: assistantContent,
      timestamp: new Date().toISOString(),
    };
    const trace = host.storage.chatTurnTraces.patch(prepared.turnId, {
      assistantMessageId,
      status: "completed",
      finishedAt: new Date().toISOString(),
      retrieval: prepared.retrievalTrace,
      reflection: {
        attempted: false,
        attemptCount: 0,
        outcome: "not_needed",
      },
      proactive: {
        runId: prepared.autonomy.lastProactiveRunId,
        mode: prepared.autonomy.proactiveMode,
      },
      guidance: {
        workspaceId: prepared.workspaceId,
        globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
        workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
        truncated: prepared.resolvedGuidance.truncated,
      },
      citations: [],
    });
    const hydratedTrace: ChatTurnTraceRecord = {
      ...trace,
      toolRuns: [],
      citations: [],
    };
    host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, prepared.turnId);
    host.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: threadEventType,
        sessionId,
        turnId: prepared.turnId,
        activeLeafTurnId: prepared.turnId,
      },
      buildChatTurnRealtimeOptions({ sessionId, turnId: prepared.turnId }),
    );
    return {
      sessionId,
      userMessage: prepared.userMessage,
      assistantMessage,
      transport: "integration",
      turnId: prepared.turnId,
      trace: hydratedTrace,
      citations: [],
      routing: hydratedTrace.routing,
    };
  } catch (error) {
    host.storage.chatTurnTraces.patch(prepared.turnId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      retrieval: prepared.retrievalTrace,
      reflection: {
        attempted: false,
        attemptCount: 0,
        outcome: "not_needed",
      },
      proactive: {
        runId: prepared.autonomy.lastProactiveRunId,
        mode: prepared.autonomy.proactiveMode,
      },
      guidance: {
        workspaceId: prepared.workspaceId,
        globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
        workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
        truncated: prepared.resolvedGuidance.truncated,
      },
      citations: [],
    });
    throw error;
  }
}

export async function* streamPreparedIntegrationChatTurn(
  host: ChatTurnDispatchHost,
  sessionId: string,
  input: Partial<ChatSendMessageRequest>,
  prepared: PreparedAgentChatTurn,
  binding: ChatSessionBindingRecord,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  options?: { abortSignal?: AbortSignal },
): AsyncGenerator<ChatStreamChunkDraft> {
  yield {
    type: "message_start",
    sessionId,
    turnId: prepared.turnId,
    messageId: prepared.assistantMessageId,
    parentTurnId: prepared.parentTurnId,
    branchKind: prepared.branchKind,
    sourceTurnId: prepared.sourceTurnId,
  };
  const response = await sendPreparedIntegrationChatTurn(
    host,
    sessionId,
    input,
    prepared,
    binding,
    threadEventType,
    options,
  );
  const content = response.assistantMessage?.content ?? "";
  for (const delta of splitIntoChunks(content, 120)) {
    yield {
      type: "delta",
      sessionId,
      turnId: prepared.turnId,
      messageId: prepared.assistantMessageId,
      delta,
    };
  }
  yield {
    type: "message_done",
    sessionId,
    turnId: prepared.turnId,
    messageId: prepared.assistantMessageId,
    content,
    repaired: Boolean(response.trace?.completion?.repaired),
  };
  yield {
    type: "trace_update",
    sessionId,
    turnId: prepared.turnId,
    trace: response.trace!,
  };
  yield {
    type: "done",
    sessionId,
    turnId: prepared.turnId,
    messageId: prepared.assistantMessageId,
  };
}
