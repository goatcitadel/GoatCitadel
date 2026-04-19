/**
 * Chat turn public-entry helpers.
 *
 * Public agent chat-turn entry points over the narrowed chat runtime host.
 */

import { randomUUID } from "node:crypto";
import type { TurnRuntime } from "@goatcitadel/orchestration";
import type {
  ChatCapabilityUpgradeSuggestion,
  ChatCancelTurnResponse,
  ChatStreamChunkDraft,
  ChatTurnBranchKind,
  ChatMessageRecord,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSpecialistCandidateSuggestionRecord,
  ChatStreamChunk,
  ChatTurnTraceRecord,
  ProactiveRunRecord,
} from "@goatcitadel/contracts";
import type { SessionAutonomyPrefsRecord } from "@goatcitadel/storage";
import { looksLowConfidenceResponse } from "./learned-memory-utils.js";
import {
  buildEmptyAssistantTurnFallbackText,
  ChatTurnCancelledError,
  dedupeChatCitations,
  detectDelegationRoles,
  inferDegradedAssistantTurnFailure,
} from "./gateway-service.js";
import { buildChatTurnRealtimeOptions } from "./chat-turn-realtime.js";
import type { ChatTurnPrepHost, PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import * as chatTurnDispatchService from "./chat-turn-dispatch-service.js";

type ChatTurnProactiveTriggerInput = {
  source?: "scheduler" | "manual" | "chat";
  reason?: string;
  prefs?: SessionAutonomyPrefsRecord;
};

export interface ChatTurnEntryHost
  extends
    Omit<ChatTurnPrepHost, "storage">,
    Omit<chatTurnDispatchService.ChatTurnDispatchHost, "storage" | "turnRuntime"> {
  readonly storage: ChatTurnPrepHost["storage"] & chatTurnDispatchService.ChatTurnDispatchHost["storage"];
  readonly turnRuntime: Pick<TurnRuntime, "run" | "runStream">;
  prepareAgentChatTurn(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: {
      branchKind?: ChatTurnBranchKind;
      sourceTurnId?: string;
      parentTurnId?: string;
      existingUserMessage?: ChatMessageRecord;
      ingestUserMessage?: boolean;
      turnId?: string;
      assistantMessageId?: string;
    },
  ): Promise<PreparedAgentChatTurn>;
  withChatTurnWriteLease<T>(sessionId: string, operation: string, task: () => Promise<T>): Promise<T>;
  withChatTurnWriteLeaseStream(
    sessionId: string,
    operation: string,
    factory: () => AsyncGenerator<ChatStreamChunk>,
  ): AsyncGenerator<ChatStreamChunk>;
  withEphemeralStreamEnvelope(
    stream: AsyncGenerator<ChatStreamChunkDraft>,
    runId?: string,
  ): AsyncGenerator<ChatStreamChunk>;
  streamPersistedChatTurnEvents(
    sessionId: string,
    turnId: string,
    options?: {
      sinceEventId?: string;
      liveTail?: boolean;
    },
  ): AsyncGenerator<ChatStreamChunk>;
  requireChatTurnContext(
    sessionId: string,
    turnId: string,
  ): Promise<{
    trace: ChatTurnTraceRecord;
    userMessage: ChatMessageRecord;
    assistantMessage?: ChatMessageRecord;
  }>;
  beginActiveChatTurnExecution(sessionId: string, turnId: string, operation: string): AbortController;
  endActiveChatTurnExecution(turnId: string, controller: AbortController): void;
  getActiveChatTurnExecution(turnId: string):
    | {
        sessionId: string;
        controller: AbortController;
      }
    | undefined;
  markChatTurnCancelled(sessionId: string, turnId: string, cancelledBy?: string): ChatTurnTraceRecord;
  collectCapabilityUpgradeSuggestions(input: {
    sessionId: string;
    content: string;
    assistantText: string;
    trace?: ChatTurnTraceRecord;
  }): Promise<ChatCapabilityUpgradeSuggestion[]>;
  collectSpecialistCandidateSuggestions(input: {
    sessionId: string;
    mode: NonNullable<PreparedAgentChatTurn["normalized"]["mode"]> | PreparedAgentChatTurn["prefs"]["mode"];
    content: string;
    capabilitySuggestions: ChatCapabilityUpgradeSuggestion[];
    trace: ChatTurnTraceRecord;
  }): ChatSpecialistCandidateSuggestionRecord[];
  recordCapabilityGapFromTrace(input: {
    sessionId: string;
    turnId: string;
    content: string;
    trace: ChatTurnTraceRecord;
  }): void;
  extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: {
      role: "user" | "assistant";
      sourceRef: string;
      trace?: Pick<ChatTurnTraceRecord, "status" | "toolRuns">;
    },
  ): void;
  isReplayScratchSession(sessionId: string): boolean;
  triggerChatSessionProactive(sessionId: string, input?: ChatTurnProactiveTriggerInput): Promise<ProactiveRunRecord>;
}

export interface ChatTurnResumeHost {
  readonly storage: {
    readonly chatTurnTraces: {
      get(turnId: string): Pick<ChatTurnTraceRecord, "sessionId">;
    };
  };
  streamPersistedChatTurnEvents(
    sessionId: string,
    turnId: string,
    options?: {
      sinceEventId?: string;
      liveTail?: boolean;
    },
  ): AsyncGenerator<ChatStreamChunk>;
}

export async function agentSendChatMessage(
  host: ChatTurnEntryHost,
  sessionId: string,
  input: ChatSendMessageRequest,
): Promise<ChatSendMessageResponse> {
  return host.withChatTurnWriteLease(sessionId, "agent-send", async () => {
    host.recordDevDiagnostic({
      level: "info",
      category: "chat",
      event: "chat.turn.start",
      message: "Starting mission chat turn",
      sessionId,
      providerId: input.providerId,
      modelId: input.model,
      context: {
        mode: input.mode,
        webMode: input.webMode,
        thinkingLevel: input.thinkingLevel,
      },
    });
    const prepared = await host.prepareAgentChatTurn(sessionId, input, {
      branchKind: "append",
    });
    const binding =
      host.storage.chatSessionBindings.get(sessionId) ??
      host.storage.chatSessionBindings.upsert({
        sessionId,
        workspaceId: prepared.workspaceId,
        transport: "llm",
        writable: true,
      });
    if (binding.transport !== "llm") {
      return chatTurnDispatchService.sendPreparedIntegrationChatTurn(
        host,
        sessionId,
        prepared,
        binding,
        "chat_thread_turn_appended",
      );
    }
    const modeOrchestration = await host.resolvePreparedTurnOrchestration(prepared);
    if (modeOrchestration) {
      host.recordDevDiagnostic({
        level: "info",
        category: "orchestration",
        event: "chat.orchestration.selected",
        message: "Routing mission chat turn through orchestration",
        sessionId,
        turnId: prepared.turnId,
      });
      return chatTurnDispatchService.consumePreparedAgentChatTurn(
        host,
        sessionId,
        input,
        prepared,
        "chat_thread_turn_appended",
        modeOrchestration,
      );
    }
    if (chatTurnDispatchService.shouldUseDurableExecution(host, prepared, input)) {
      return chatTurnDispatchService.consumePreparedAgentChatTurn(
        host,
        sessionId,
        input,
        prepared,
        "chat_thread_turn_appended",
      );
    }
    return runAgentSendChatMessageLlmPath(host, sessionId, input, prepared);
  });
}

async function runAgentSendChatMessageLlmPath(
  host: ChatTurnEntryHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  prepared: PreparedAgentChatTurn,
): Promise<ChatSendMessageResponse> {
  const controller = host.beginActiveChatTurnExecution(sessionId, prepared.turnId, "agent-send");
  try {
    let turnId = prepared.turnId;
    let turnResult = await host.turnRuntime.run({
      sessionId,
      turnId,
      userMessageId: prepared.userEventId,
      parentTurnId: prepared.parentTurnId,
      branchKind: prepared.branchKind,
      sourceTurnId: prepared.sourceTurnId,
      content: prepared.content,
      mode: prepared.normalized.mode ?? prepared.prefs.mode,
      providerId: input.providerId ?? prepared.prefs.providerId,
      model: input.model ?? prepared.prefs.model,
      webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
      memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
      thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
      normalizationProfile: prepared.normalized.normalizationProfile,
      toolAutonomy: prepared.effectiveToolAutonomy,
      historyMessages: prepared.history,
      outputMessageId: prepared.assistantMessageId,
      signal: controller.signal,
    });
    let reflectionTrace: ChatTurnTraceRecord["reflection"] = {
      attempted: false,
      attemptCount: 0,
      outcome: "not_needed",
    };

    const shouldAttemptReflection =
      prepared.autonomy.reflectionMode === "on" &&
      prepared.prefs.planningMode !== "advisory" &&
      !controller.signal.aborted &&
      !turnResult.requiresApproval &&
      (turnResult.turnTrace.status === "failed" || looksLowConfidenceResponse(turnResult.assistantContent));

    if (shouldAttemptReflection) {
      const retryTurnId = randomUUID();
      const retryReason =
        turnResult.turnTrace.status === "failed" ? "tool failure or completion failure" : "low confidence response";
      reflectionTrace = {
        attempted: true,
        attemptCount: 1,
        reason: retryReason,
        outcome: "still_failed",
      };
      host.storage.chatReflectionAttempts.create({
        attemptId: randomUUID(),
        turnId: retryTurnId,
        sessionId,
        reason: retryReason,
        outcome: "still_failed",
        attemptCount: 1,
        strategy: "single retry with alternate tool/query strategy",
        error: turnResult.turnTrace.status === "failed" ? turnResult.assistantContent.slice(0, 500) : null,
      });

      const retryHistory = prepared.history;
      const retryPrompt = `${prepared.content}\n\nRetry guidance: last attempt was incomplete. Use a different approach or tool and be explicit about limits.`;
      const retryResult = await host.turnRuntime.run({
        sessionId,
        turnId: retryTurnId,
        userMessageId: prepared.userEventId,
        parentTurnId: prepared.parentTurnId,
        branchKind: "retry",
        sourceTurnId: turnId,
        content: retryPrompt,
        mode: prepared.normalized.mode ?? prepared.prefs.mode,
        providerId: input.providerId ?? prepared.prefs.providerId,
        model: input.model ?? prepared.prefs.model,
        webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
        memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
        thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
        normalizationProfile: prepared.normalized.normalizationProfile,
        toolAutonomy: prepared.effectiveToolAutonomy,
        historyMessages: retryHistory,
        outputMessageId: prepared.assistantMessageId,
        signal: controller.signal,
      });
      if (retryResult.turnTrace.status === "completed" && retryResult.assistantContent.trim().length > 0) {
        turnId = retryTurnId;
        turnResult = retryResult;
        reflectionTrace = {
          attempted: true,
          attemptCount: 1,
          reason: retryReason,
          outcome: "recovered",
        };
      }
    }

    const dedupedTurnCitations = dedupeChatCitations(turnResult.turnTrace.citations ?? []);
    const persistedTurnFailure =
      turnResult.turnTrace.failure ?? inferDegradedAssistantTurnFailure(turnResult.assistantContent);
    if (turnResult.requiresApproval || turnResult.turnTrace.status === "cancelled") {
      let traceWithMeta: ChatTurnTraceRecord = host.storage.chatTurnTraces.patch(turnId, {
        retrieval: prepared.retrievalTrace,
        reflection: reflectionTrace,
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
        citations: dedupedTurnCitations,
        failure: persistedTurnFailure,
      });
      const capabilityUpgradeSuggestions = await host.collectCapabilityUpgradeSuggestions({
        sessionId,
        content: prepared.content,
        assistantText: turnResult.assistantContent,
        trace: {
          ...traceWithMeta,
          toolRuns: host.storage.chatToolRuns.listByTurn(turnId),
        },
      });
      if (capabilityUpgradeSuggestions.length > 0) {
        traceWithMeta = host.storage.chatTurnTraces.patch(turnId, {
          capabilityUpgradeSuggestions,
        });
      }
      host.recordCapabilityGapFromTrace({
        sessionId,
        turnId,
        content: prepared.content,
        trace: {
          ...traceWithMeta,
          citations: dedupedTurnCitations,
          toolRuns: host.storage.chatToolRuns.listByTurn(turnId),
        },
      });
      if (turnResult.turnTrace.status !== "cancelled") {
        host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
        host.publishRealtime(
          "chat_thread_updated",
          "chat",
          {
            type: "chat_thread_turn_appended",
            sessionId,
            turnId,
            activeLeafTurnId: turnId,
          },
          buildChatTurnRealtimeOptions({ sessionId, turnId }),
        );
      }
      return {
        sessionId,
        userMessage: prepared.userMessage,
        assistantMessage: undefined,
        transport: "llm",
        model: turnResult.assistantModel,
        turnId,
        trace: {
          ...traceWithMeta,
          citations: dedupedTurnCitations,
          toolRuns: host.storage.chatToolRuns.listByTurn(turnId),
        },
        citations: dedupedTurnCitations,
        routing: turnResult.turnTrace.routing,
      };
    }

    const assistantText =
      turnResult.assistantContent.trim().length > 0
        ? turnResult.assistantContent
        : buildEmptyAssistantTurnFallbackText();
    const assistantUsage = turnResult.usage;
    const assistantEventId = prepared.assistantMessageId;
    await host.ingestEvent(randomUUID(), {
      eventId: assistantEventId,
      route: prepared.route,
      actor: {
        type: "agent",
        id: "assistant",
      },
      message: {
        role: "assistant",
        content: assistantText,
      },
      usage: assistantUsage,
    });
    const assistantMessage: ChatMessageRecord = {
      messageId: assistantEventId,
      sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: assistantText,
      timestamp: new Date().toISOString(),
    };
    const finalTraceStatus = turnResult.turnTrace.status === "failed" ? "failed" : "completed";
    const trace = host.storage.chatTurnTraces.patch(turnId, {
      assistantMessageId: assistantEventId,
      status: finalTraceStatus,
      finishedAt: new Date().toISOString(),
      retrieval: prepared.retrievalTrace,
      reflection: reflectionTrace,
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
      citations: dedupedTurnCitations,
      failure: persistedTurnFailure,
    });
    let hydratedTrace: ChatTurnTraceRecord = {
      ...trace,
      citations: dedupedTurnCitations,
      toolRuns: host.storage.chatToolRuns.listByTurn(turnId),
    };
    const capabilityUpgradeSuggestions = await host.collectCapabilityUpgradeSuggestions({
      sessionId,
      content: prepared.content,
      assistantText,
      trace: hydratedTrace,
    });
    const specialistCandidateSuggestions = host.collectSpecialistCandidateSuggestions({
      sessionId,
      mode: prepared.normalized.mode ?? prepared.prefs.mode,
      content: prepared.content,
      capabilitySuggestions: capabilityUpgradeSuggestions,
      trace: hydratedTrace,
    });
    if (capabilityUpgradeSuggestions.length > 0 || specialistCandidateSuggestions.length > 0) {
      hydratedTrace = host.storage.chatTurnTraces.patch(turnId, {
        capabilityUpgradeSuggestions: capabilityUpgradeSuggestions.length > 0 ? capabilityUpgradeSuggestions : [],
        specialistCandidateSuggestions: specialistCandidateSuggestions.length > 0 ? specialistCandidateSuggestions : [],
      });
      hydratedTrace = {
        ...hydratedTrace,
        toolRuns: host.storage.chatToolRuns.listByTurn(turnId),
      };
    }
    host.recordCapabilityGapFromTrace({
      sessionId,
      turnId,
      content: prepared.content,
      trace: hydratedTrace,
    });

    host.extractAndPersistLearnedMemory(sessionId, prepared.content, {
      role: "user",
      sourceRef: prepared.userEventId,
      trace: hydratedTrace,
    });
    host.extractAndPersistLearnedMemory(sessionId, assistantText, {
      role: "assistant",
      sourceRef: assistantEventId,
      trace: hydratedTrace,
    });
    host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
    host.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: "chat_thread_turn_appended",
        sessionId,
        turnId,
        activeLeafTurnId: turnId,
      },
      buildChatTurnRealtimeOptions({ sessionId, turnId }),
    );
    const delegationDetection = detectDelegationRoles(prepared.content);
    if (
      !host.isReplayScratchSession(sessionId) &&
      prepared.prefs.planningMode !== "advisory" &&
      delegationDetection.length > 1
    ) {
      await host.triggerChatSessionProactive(sessionId, {
        source: "chat",
        reason: "Detected multi-role phrasing; generated delegation suggestion.",
      });
    }

    return {
      sessionId,
      userMessage: prepared.userMessage,
      assistantMessage,
      transport: "llm",
      model: turnResult.assistantModel,
      turnId,
      trace: hydratedTrace,
      citations: hydratedTrace.citations,
      routing: hydratedTrace.routing,
    };
  } finally {
    host.endActiveChatTurnExecution(prepared.turnId, controller);
  }
}

export async function* agentSendChatMessageStream(
  host: ChatTurnEntryHost,
  sessionId: string,
  input: ChatSendMessageRequest,
): AsyncGenerator<ChatStreamChunk> {
  yield* host.withChatTurnWriteLeaseStream(sessionId, "agent-send/stream", () => {
    return (async function* (): AsyncGenerator<ChatStreamChunk> {
      host.recordDevDiagnostic({
        level: "info",
        category: "chat",
        event: "chat.stream.start",
        message: "Starting streamed mission chat turn",
        sessionId,
        providerId: input.providerId,
        modelId: input.model,
        context: {
          mode: input.mode,
          webMode: input.webMode,
          thinkingLevel: input.thinkingLevel,
        },
      });
      const prepared = await host.prepareAgentChatTurn(sessionId, input, {
        branchKind: "append",
      });
      const binding =
        host.storage.chatSessionBindings.get(sessionId) ??
        host.storage.chatSessionBindings.upsert({
          sessionId,
          workspaceId: prepared.workspaceId,
          transport: "llm",
          writable: true,
        });
      if (binding.transport !== "llm") {
        yield* host.withEphemeralStreamEnvelope(
          chatTurnDispatchService.streamPreparedIntegrationChatTurn(
            host,
            sessionId,
            prepared,
            binding,
            "chat_thread_turn_appended",
          ),
        );
        return;
      }
      chatTurnDispatchService.launchPreparedAgentChatTurnStream(
        host,
        sessionId,
        input,
        prepared,
        "chat_thread_turn_appended",
      );
      yield* host.streamPersistedChatTurnEvents(sessionId, prepared.turnId, { liveTail: true });
    })();
  });
}

export async function retryChatTurn(
  host: ChatTurnEntryHost,
  sessionId: string,
  turnId: string,
  overrides: Partial<ChatSendMessageRequest> = {},
): Promise<ChatSendMessageResponse> {
  return host.withChatTurnWriteLease(sessionId, "retry-turn", async () => {
    const current = await host.requireChatTurnContext(sessionId, turnId);
    const request: ChatSendMessageRequest = {
      content: current.userMessage.content,
      attachments: current.userMessage.attachments?.map((item) => item.attachmentId),
      providerId: overrides.providerId,
      model: overrides.model,
      useMemory: overrides.useMemory,
      mode: overrides.mode,
      webMode: overrides.webMode,
      memoryMode: overrides.memoryMode,
      thinkingLevel: overrides.thinkingLevel,
      commandText: overrides.commandText,
      prefsOverride: overrides.prefsOverride,
    };
    const prepared = await host.prepareAgentChatTurn(sessionId, request, {
      branchKind: "retry",
      sourceTurnId: turnId,
      parentTurnId: current.trace.parentTurnId,
      existingUserMessage: current.userMessage,
      ingestUserMessage: false,
    });
    const binding =
      host.storage.chatSessionBindings.get(sessionId) ??
      host.storage.chatSessionBindings.upsert({
        sessionId,
        workspaceId: prepared.workspaceId,
        transport: "llm",
        writable: true,
      });
    if (binding.transport !== "llm") {
      return chatTurnDispatchService.sendPreparedIntegrationChatTurn(
        host,
        sessionId,
        prepared,
        binding,
        "chat_thread_turn_retried",
      );
    }
    return chatTurnDispatchService.consumePreparedAgentChatTurn(
      host,
      sessionId,
      request,
      prepared,
      "chat_thread_turn_retried",
    );
  });
}

export async function* retryChatTurnStream(
  host: ChatTurnEntryHost,
  sessionId: string,
  turnId: string,
  overrides: Partial<ChatSendMessageRequest> = {},
): AsyncGenerator<ChatStreamChunk> {
  yield* host.withChatTurnWriteLeaseStream(sessionId, "retry-turn/stream", () => {
    return (async function* (): AsyncGenerator<ChatStreamChunk> {
      const current = await host.requireChatTurnContext(sessionId, turnId);
      const request: ChatSendMessageRequest = {
        content: current.userMessage.content,
        attachments: current.userMessage.attachments?.map((item) => item.attachmentId),
        providerId: overrides.providerId,
        model: overrides.model,
        useMemory: overrides.useMemory,
        mode: overrides.mode,
        webMode: overrides.webMode,
        memoryMode: overrides.memoryMode,
        thinkingLevel: overrides.thinkingLevel,
        commandText: overrides.commandText,
        prefsOverride: overrides.prefsOverride,
      };
      const prepared = await host.prepareAgentChatTurn(sessionId, request, {
        branchKind: "retry",
        sourceTurnId: turnId,
        parentTurnId: current.trace.parentTurnId,
        existingUserMessage: current.userMessage,
        ingestUserMessage: false,
      });
      const binding =
        host.storage.chatSessionBindings.get(sessionId) ??
        host.storage.chatSessionBindings.upsert({
          sessionId,
          workspaceId: prepared.workspaceId,
          transport: "llm",
          writable: true,
        });
      if (binding.transport !== "llm") {
        yield* host.withEphemeralStreamEnvelope(
          chatTurnDispatchService.streamPreparedIntegrationChatTurn(
            host,
            sessionId,
            prepared,
            binding,
            "chat_thread_turn_retried",
          ),
        );
        return;
      }
      chatTurnDispatchService.launchPreparedAgentChatTurnStream(
        host,
        sessionId,
        request,
        prepared,
        "chat_thread_turn_retried",
      );
      yield* host.streamPersistedChatTurnEvents(sessionId, prepared.turnId, { liveTail: true });
    })();
  });
}

export async function editChatTurn(
  host: ChatTurnEntryHost,
  sessionId: string,
  turnId: string,
  input: ChatSendMessageRequest,
): Promise<ChatSendMessageResponse> {
  return host.withChatTurnWriteLease(sessionId, "edit-turn", async () => {
    const current = await host.requireChatTurnContext(sessionId, turnId);
    const request: ChatSendMessageRequest = {
      ...input,
      attachments: input.attachments ?? current.userMessage.attachments?.map((item) => item.attachmentId),
    };
    const prepared = await host.prepareAgentChatTurn(sessionId, request, {
      branchKind: "edit",
      sourceTurnId: turnId,
      parentTurnId: current.trace.parentTurnId,
    });
    const binding =
      host.storage.chatSessionBindings.get(sessionId) ??
      host.storage.chatSessionBindings.upsert({
        sessionId,
        workspaceId: prepared.workspaceId,
        transport: "llm",
        writable: true,
      });
    if (binding.transport !== "llm") {
      return chatTurnDispatchService.sendPreparedIntegrationChatTurn(
        host,
        sessionId,
        prepared,
        binding,
        "chat_thread_turn_edited",
      );
    }
    return chatTurnDispatchService.consumePreparedAgentChatTurn(
      host,
      sessionId,
      request,
      prepared,
      "chat_thread_turn_edited",
    );
  });
}

export async function* editChatTurnStream(
  host: ChatTurnEntryHost,
  sessionId: string,
  turnId: string,
  input: ChatSendMessageRequest,
): AsyncGenerator<ChatStreamChunk> {
  yield* host.withChatTurnWriteLeaseStream(sessionId, "edit-turn/stream", () => {
    return (async function* (): AsyncGenerator<ChatStreamChunk> {
      const current = await host.requireChatTurnContext(sessionId, turnId);
      const request: ChatSendMessageRequest = {
        ...input,
        attachments: input.attachments ?? current.userMessage.attachments?.map((item) => item.attachmentId),
      };
      const prepared = await host.prepareAgentChatTurn(sessionId, request, {
        branchKind: "edit",
        sourceTurnId: turnId,
        parentTurnId: current.trace.parentTurnId,
      });
      const binding =
        host.storage.chatSessionBindings.get(sessionId) ??
        host.storage.chatSessionBindings.upsert({
          sessionId,
          workspaceId: prepared.workspaceId,
          transport: "llm",
          writable: true,
        });
      if (binding.transport !== "llm") {
        yield* host.withEphemeralStreamEnvelope(
          chatTurnDispatchService.streamPreparedIntegrationChatTurn(
            host,
            sessionId,
            prepared,
            binding,
            "chat_thread_turn_edited",
          ),
        );
        return;
      }
      chatTurnDispatchService.launchPreparedAgentChatTurnStream(
        host,
        sessionId,
        request,
        prepared,
        "chat_thread_turn_edited",
      );
      yield* host.streamPersistedChatTurnEvents(sessionId, prepared.turnId, { liveTail: true });
    })();
  });
}

export async function cancelChatTurn(
  host: ChatTurnEntryHost,
  sessionId: string,
  turnId: string,
  cancelledBy?: string,
): Promise<ChatCancelTurnResponse> {
  const current = host.storage.chatTurnTraces.get(turnId);
  if (current.sessionId !== sessionId) {
    throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
  }
  const active = host.getActiveChatTurnExecution(turnId);
  if (active?.sessionId === sessionId && !active.controller.signal.aborted) {
    active.controller.abort(new ChatTurnCancelledError(turnId));
  }
  const trace = host.markChatTurnCancelled(sessionId, turnId, cancelledBy);
  return {
    sessionId,
    turnId,
    cancelled: trace.status === "cancelled",
    trace,
  };
}

export async function* resumeAgentChatTurnStream(
  host: ChatTurnResumeHost,
  sessionId: string,
  turnId: string,
  sinceEventId?: string,
): AsyncGenerator<ChatStreamChunk> {
  const trace = host.storage.chatTurnTraces.get(turnId);
  if (trace.sessionId !== sessionId) {
    throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
  }

  // Durable-linked turns should resume from retained stream state first. Legacy
  // traces without durable linkage still flow through the same persisted stream
  // path as a compatibility fallback.
  yield* host.streamPersistedChatTurnEvents(sessionId, turnId, {
    sinceEventId,
    liveTail: true,
  });
}
