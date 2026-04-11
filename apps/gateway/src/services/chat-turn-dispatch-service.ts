/**
 * Chat turn dispatch helpers.
 *
 * Step 8d (partial) of the gateway-service decomposition plan: extracts the
 * dispatch helpers that route a prepared chat turn through the LLM stream,
 * the durable execution path, or the integration transport. The gateway stays
 * the composition root, but these helpers now depend on an explicit host
 * contract instead of the full GatewayService type.
 */

import { randomUUID } from "node:crypto";
import { NotFoundError } from "@goatcitadel/contracts";
import type {
  ChannelSendInput,
  ChatCitationRecord,
  ChatMessageRecord,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionBindingRecord,
  ChatStreamChunkDraft,
  ChatTurnTraceRecord,
  GatewayEventInput,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import {
  dedupeChatCitations,
  isPersistableChatStreamChunk,
  splitIntoChunks,
  type InspectableChatStreamChunk,
  type PreparedChatExecutionPlanResolution,
} from "./gateway-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import * as chatTurnStreamService from "./chat-turn-stream-service.js";

export interface ChatTurnDispatchHost extends chatTurnStreamService.ChatTurnStreamHost {
  readonly config: {
    assistant: {
      durable: {
        enabled: boolean;
        executionEnabled: boolean;
        chatAutoPromoteEnabled: boolean;
      };
    };
  };
  readonly storage: chatTurnStreamService.ChatTurnStreamHost["storage"] & Pick<Storage, "durableRuns">;
  readonly backgroundTasks: Set<Promise<void>>;
  isFeatureEnabled(flag: string): boolean;
  streamPersistedChatTurnEvents(
    sessionId: string,
    turnId: string,
    options?: { liveTail?: boolean },
  ): AsyncGenerator<InspectableChatStreamChunk>;
  persistChatStreamChunk(chunk: ChatStreamChunkDraft, durableRunId?: string): void;
  createHydratedChatTurnTrace(turnId: string, trace: ChatTurnTraceRecord): ChatTurnTraceRecord;
  finalizeDurableChatRun(runId: string, prepared: PreparedAgentChatTurn, trace: ChatTurnTraceRecord): void;
  completeActiveChatTurnStream(turnId: string): void;
  closeActiveChatTurnStream(turnId: string): void;
  beginDurableChatRun(
    prepared: PreparedAgentChatTurn,
    input: ChatSendMessageRequest,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  ): import("@goatcitadel/contracts").DurableRunRecord | undefined;
  registerActiveChatTurnStream(sessionId: string, turnId: string, durableRunId?: string): void;
  ensureSessionInternalToolGrant(sessionId: string, toolName: string, reason: string): void;
  requireExecutedToolResult(
    toolName: string,
    result: ToolInvokeResult | Record<string, unknown>,
  ): Record<string, unknown>;
  commsSend(input: ChannelSendInput): Promise<ToolInvokeResult | Record<string, unknown>>;
  ingestEvent(idempotencyKey: string, payload: GatewayEventInput): Promise<unknown>;
  updateActiveLeafOrThrow(sessionId: string, previousActiveTurnId: string | undefined, nextActiveTurnId: string): void;
  publishRealtime(channel: string, topic: string, payload: Record<string, unknown>): void;
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
  const mode = prepared.normalized.mode ?? prepared.prefs.mode;
  if (mode === "cowork" || mode === "code") {
    return true;
  }
  if (mode !== "chat" || !host.config.assistant.durable.chatAutoPromoteEnabled) {
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
): Promise<ChatSendMessageResponse> {
  let assistantMessage: ChatMessageRecord | undefined;
  let trace: ChatTurnTraceRecord | undefined;
  let citations: ChatCitationRecord[] = [];
  const useDurableExecution = shouldUseDurableExecution(host, prepared, input);
  if (useDurableExecution) {
    launchPreparedAgentChatTurnStream(host, sessionId, input, prepared, threadEventType, resolvedOrchestration);
  }
  const source: AsyncGenerator<InspectableChatStreamChunk> = useDurableExecution
    ? host.streamPersistedChatTurnEvents(sessionId, prepared.turnId, { liveTail: true })
    : chatTurnStreamService.streamPreparedAgentChatTurn(
        host,
        sessionId,
        input,
        prepared,
        threadEventType,
        resolvedOrchestration,
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
): void {
  const durableRun = host.beginDurableChatRun(prepared, input, threadEventType);
  host.registerActiveChatTurnStream(sessionId, prepared.turnId, durableRun?.runId);
  if (durableRun) {
    return;
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
}

export async function sendPreparedIntegrationChatTurn(
  host: ChatTurnDispatchHost,
  sessionId: string,
  prepared: PreparedAgentChatTurn,
  binding: ChatSessionBindingRecord,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
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
    mode: prepared.normalized.mode ?? prepared.prefs.mode,
    webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
    memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
    thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
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
        agentId: "operator",
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
    host.publishRealtime("chat_thread_updated", "chat", {
      type: threadEventType,
      sessionId,
      turnId: prepared.turnId,
      activeLeafTurnId: prepared.turnId,
    });
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
  prepared: PreparedAgentChatTurn,
  binding: ChatSessionBindingRecord,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
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
  const response = await sendPreparedIntegrationChatTurn(host, sessionId, prepared, binding, threadEventType);
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
