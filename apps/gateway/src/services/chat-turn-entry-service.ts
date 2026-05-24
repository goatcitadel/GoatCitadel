/* eslint-disable max-lines -- Public-entry helpers stay co-located so chat-turn intake, validation, and persistence remain auditable in one module. */
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
  ChatTurnBranchKind,
  ChatMessageRecord,
  RoutingPreflightRequest,
  RoutingPreflightResult,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSpecialistCandidateSuggestionRecord,
  ChatStreamChunk,
  ChatTurnTraceRecord,
  ProactiveRunRecord,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { SessionAutonomyPrefsRecord, Storage } from "@goatcitadel/storage";
import { looksLowConfidenceResponse } from "./learned-memory-utils.js";
import {
  preflightChatRoute,
  resolveChatRouteDescriptor,
  type ChatRouteResolutionDependencies,
} from "./chat-route-resolution.js";
import {
  buildEmptyAssistantTurnFallbackText,
  ChatTurnCancelledError,
  dedupeChatCitations,
  detectDelegationRoles,
  inferDegradedAssistantTurnFailure,
} from "./chat-turn-helpers.js";
import { buildChatTurnRealtimeOptions } from "./chat-turn-realtime.js";
import type { ChatTurnPrepHost, PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import * as chatTurnDispatchService from "./chat-turn-dispatch-service.js";
import type {
  ChatTurnActiveExecutionControl,
  ChatTurnLeaseControl,
  ChatTurnMemorySideEffects,
  ChatTurnRealtimeEmitter,
  ChatTurnStreamLifecycleControl,
  ChatTurnTranscriptIngress,
} from "./chat-turn-runtime-collaborators.js";

type ChatTurnProactiveTriggerInput = {
  source?: "scheduler" | "manual" | "chat";
  reason?: string;
  prefs?: SessionAutonomyPrefsRecord;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ChatSendMessageRequest["authActorSource"];
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
};

type ChatTurnEntryStorage = ChatTurnPrepHost["storage"] &
  chatTurnDispatchService.ChatTurnDispatchHost["storage"] &
  Pick<Storage, "chatReflectionAttempts" | "chatSessionBindings">;

export interface ChatTurnEntryHost
  extends
    Omit<ChatTurnPrepHost, "storage">,
    Omit<
      chatTurnDispatchService.ChatTurnDispatchHost,
      | "storage"
      | "turnRuntime"
      | keyof ChatTurnActiveExecutionControl
      | keyof ChatTurnLeaseControl
      | keyof ChatTurnMemorySideEffects
      | keyof ChatTurnRealtimeEmitter
      | keyof ChatTurnStreamLifecycleControl
      | keyof ChatTurnTranscriptIngress
    >,
    ChatTurnActiveExecutionControl,
    ChatTurnLeaseControl,
    ChatTurnMemorySideEffects,
    ChatTurnRealtimeEmitter,
    ChatTurnStreamLifecycleControl,
    ChatTurnTranscriptIngress {
  readonly storage: ChatTurnEntryStorage;
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
  requireChatTurnContext(
    sessionId: string,
    turnId: string,
  ): Promise<{
    trace: ChatTurnTraceRecord;
    userMessage: ChatMessageRecord;
    assistantMessage?: ChatMessageRecord;
  }>;
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
      returnOnDurableInterrupt?: boolean;
    },
  ): AsyncGenerator<ChatStreamChunk>;
}

export type ChatTurnPreflightHost = ChatTurnEntryHost & ChatRouteResolutionDependencies;

export async function agentSendChatMessage(
  host: ChatTurnEntryHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  options?: { abortSignal?: AbortSignal },
): Promise<ChatSendMessageResponse> {
  return host.withChatTurnWriteLease(sessionId, "agent-send", async () => {
    const routeDescriptor = resolveChatRouteDescriptor(host as ChatTurnPreflightHost, sessionId, {
      action: "send",
      providerId: input.providerId,
      model: input.model,
      mode: input.mode,
      webMode: input.webMode,
      thinkingLevel: input.thinkingLevel,
      speedMode: input.speedMode,
      subagentPolicy: input.subagentPolicy,
      prefsOverride: input.prefsOverride,
    });
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
        speedMode: input.speedMode,
        subagentPolicy: input.subagentPolicy,
        routePreflight: {
          requestedProviderId: routeDescriptor.requestedProviderId,
          requestedModel: routeDescriptor.requestedModel,
          effectiveProviderId: routeDescriptor.effectiveProviderId,
          effectiveModel: routeDescriptor.effectiveModel,
          selectionSource: routeDescriptor.selectionSource,
          fallbackPolicy: routeDescriptor.fallbackPolicy,
        },
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
        input,
        prepared,
        binding,
        "chat_thread_turn_appended",
        { abortSignal: options?.abortSignal },
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
        { abortSignal: options?.abortSignal },
      );
    }
    if (chatTurnDispatchService.shouldUseDurableExecution(host, prepared, input)) {
      return chatTurnDispatchService.consumePreparedAgentChatTurn(
        host,
        sessionId,
        input,
        prepared,
        "chat_thread_turn_appended",
        undefined,
        { abortSignal: options?.abortSignal },
      );
    }
    return runAgentSendChatMessageLlmPath(host, sessionId, input, prepared, options);
  });
}

async function runAgentSendChatMessageLlmPath(
  host: ChatTurnEntryHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  prepared: PreparedAgentChatTurn,
  options?: { abortSignal?: AbortSignal },
): Promise<ChatSendMessageResponse> {
  const controller = host.beginActiveChatTurnExecution(sessionId, prepared.turnId, "agent-send");
  const externalAbortListener = bindExternalAbortToController(options?.abortSignal, controller);
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
      speedMode: prepared.normalized.speedMode ?? prepared.prefs.speedMode,
      subagentPolicy: prepared.normalized.subagentPolicy ?? prepared.prefs.subagentPolicy,
      normalizationProfile: prepared.normalized.normalizationProfile,
      toolAutonomy: prepared.effectiveToolAutonomy,
      operatorId: input.operatorId,
      authActorId: input.authActorId,
      authActorSource: input.authActorSource,
      permissionProfileId: input.permissionProfileId,
      localOperatorOverrideId: input.localOperatorOverrideId,
      policyRunId: input.policyRunId,
      policyTaskId: input.policyTaskId,
      fullWebAccess: input.fullWebAccess,
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
        speedMode: prepared.normalized.speedMode ?? prepared.prefs.speedMode,
        subagentPolicy: prepared.normalized.subagentPolicy ?? prepared.prefs.subagentPolicy,
        normalizationProfile: prepared.normalized.normalizationProfile,
        toolAutonomy: prepared.effectiveToolAutonomy,
        operatorId: input.operatorId,
        authActorId: input.authActorId,
        authActorSource: input.authActorSource,
        permissionProfileId: input.permissionProfileId,
        localOperatorOverrideId: input.localOperatorOverrideId,
        policyRunId: input.policyRunId,
        policyTaskId: input.policyTaskId,
        fullWebAccess: input.fullWebAccess,
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

    const dedupedTurnCitations = dedupeChatCitations([
      ...(prepared.threadKnowledgeCitations ?? []),
      ...(turnResult.turnTrace.citations ?? []),
    ]);
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
        operatorId: input.operatorId,
        authActorId: input.authActorId,
        authActorSource: input.authActorSource,
        permissionProfileId: input.permissionProfileId,
        localOperatorOverrideId: input.localOperatorOverrideId,
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
    externalAbortListener?.();
    host.endActiveChatTurnExecution(prepared.turnId, controller);
  }
}

function bindExternalAbortToController(
  externalSignal: AbortSignal | undefined,
  controller: AbortController,
): (() => void) | undefined {
  if (!externalSignal) {
    return undefined;
  }
  if (externalSignal.aborted) {
    controller.abort();
    return undefined;
  }
  const onAbort = (): void => {
    controller.abort();
  };
  externalSignal.addEventListener("abort", onAbort);
  return () => {
    externalSignal.removeEventListener("abort", onAbort);
  };
}

export async function* agentSendChatMessageStream(
  host: ChatTurnEntryHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  options?: { abortSignal?: AbortSignal },
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
          speedMode: input.speedMode,
          subagentPolicy: input.subagentPolicy,
        },
      });
      const routeDescriptor = resolveChatRouteDescriptor(host as ChatTurnPreflightHost, sessionId, {
        action: "send",
        providerId: input.providerId,
        model: input.model,
        mode: input.mode,
        webMode: input.webMode,
        thinkingLevel: input.thinkingLevel,
        speedMode: input.speedMode,
        subagentPolicy: input.subagentPolicy,
        prefsOverride: input.prefsOverride,
      });
      host.recordDevDiagnostic({
        level: "info",
        category: "chat",
        event: "chat.stream.preflight",
        message: "Resolved streamed send routing before execution",
        sessionId,
        providerId: routeDescriptor.effectiveProviderId,
        modelId: routeDescriptor.effectiveModel,
        context: {
          selectionSource: routeDescriptor.selectionSource,
          fallbackPolicy: routeDescriptor.fallbackPolicy,
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
        const stream = options?.abortSignal
          ? chatTurnDispatchService.streamPreparedIntegrationChatTurn(
              host,
              sessionId,
              input,
              prepared,
              binding,
              "chat_thread_turn_appended",
              { abortSignal: options.abortSignal },
            )
          : chatTurnDispatchService.streamPreparedIntegrationChatTurn(
              host,
              sessionId,
              input,
              prepared,
              binding,
              "chat_thread_turn_appended",
            );
        yield* host.withEphemeralStreamEnvelope(stream);
        return;
      }
      const durableRunId = chatTurnDispatchService.launchPreparedAgentChatTurnStream(
        host,
        sessionId,
        input,
        prepared,
        "chat_thread_turn_appended",
      );
      const detachAbortListener = bindStreamAbortToTurn(host, prepared.turnId, durableRunId, options?.abortSignal);
      try {
        yield* host.streamPersistedChatTurnEvents(sessionId, prepared.turnId, {
          liveTail: true,
          ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
        });
      } finally {
        detachAbortListener?.();
      }
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
      speedMode: overrides.speedMode,
      subagentPolicy: overrides.subagentPolicy,
      commandText: overrides.commandText,
      prefsOverride: overrides.prefsOverride,
      operatorId: overrides.operatorId,
      authActorId: overrides.authActorId,
      authActorSource: overrides.authActorSource,
      permissionProfileId: overrides.permissionProfileId,
      localOperatorOverrideId: overrides.localOperatorOverrideId,
      policyRunId: overrides.policyRunId,
      policyTaskId: overrides.policyTaskId,
    };
    const routeDescriptor = resolveChatRouteDescriptor(host as ChatTurnPreflightHost, sessionId, {
      action: "retry",
      turnId,
      providerId: request.providerId,
      model: request.model,
      mode: request.mode,
      webMode: request.webMode,
      thinkingLevel: request.thinkingLevel,
      speedMode: request.speedMode,
      subagentPolicy: request.subagentPolicy,
      prefsOverride: request.prefsOverride,
    });
    host.recordDevDiagnostic({
      level: "info",
      category: "chat",
      event: "chat.turn.retry_preflight",
      message: "Resolved retry routing before execution",
      sessionId,
      turnId,
      providerId: routeDescriptor.effectiveProviderId,
      modelId: routeDescriptor.effectiveModel,
      context: {
        selectionSource: routeDescriptor.selectionSource,
        fallbackPolicy: routeDescriptor.fallbackPolicy,
      },
    });
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
        request,
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
  options?: { abortSignal?: AbortSignal },
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
        speedMode: overrides.speedMode,
        subagentPolicy: overrides.subagentPolicy,
        commandText: overrides.commandText,
        prefsOverride: overrides.prefsOverride,
        operatorId: overrides.operatorId,
        authActorId: overrides.authActorId,
        authActorSource: overrides.authActorSource,
        permissionProfileId: overrides.permissionProfileId,
        localOperatorOverrideId: overrides.localOperatorOverrideId,
        policyRunId: overrides.policyRunId,
        policyTaskId: overrides.policyTaskId,
      };
      const routeDescriptor = resolveChatRouteDescriptor(host as ChatTurnPreflightHost, sessionId, {
        action: "retry",
        turnId,
        providerId: request.providerId,
        model: request.model,
        mode: request.mode,
        webMode: request.webMode,
        thinkingLevel: request.thinkingLevel,
        speedMode: request.speedMode,
        subagentPolicy: request.subagentPolicy,
        prefsOverride: request.prefsOverride,
      });
      host.recordDevDiagnostic({
        level: "info",
        category: "chat",
        event: "chat.turn.retry_stream_preflight",
        message: "Resolved streamed retry routing before execution",
        sessionId,
        turnId,
        providerId: routeDescriptor.effectiveProviderId,
        modelId: routeDescriptor.effectiveModel,
        context: {
          selectionSource: routeDescriptor.selectionSource,
          fallbackPolicy: routeDescriptor.fallbackPolicy,
        },
      });
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
        const stream = options?.abortSignal
          ? chatTurnDispatchService.streamPreparedIntegrationChatTurn(
              host,
              sessionId,
              request,
              prepared,
              binding,
              "chat_thread_turn_retried",
              { abortSignal: options.abortSignal },
            )
          : chatTurnDispatchService.streamPreparedIntegrationChatTurn(
              host,
              sessionId,
              request,
              prepared,
              binding,
              "chat_thread_turn_retried",
            );
        yield* host.withEphemeralStreamEnvelope(stream);
        return;
      }
      const durableRunId = chatTurnDispatchService.launchPreparedAgentChatTurnStream(
        host,
        sessionId,
        request,
        prepared,
        "chat_thread_turn_retried",
      );
      const detachAbortListener = bindStreamAbortToTurn(host, prepared.turnId, durableRunId, options?.abortSignal);
      try {
        yield* host.streamPersistedChatTurnEvents(sessionId, prepared.turnId, {
          liveTail: true,
          ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
        });
      } finally {
        detachAbortListener?.();
      }
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
    const routeDescriptor = resolveChatRouteDescriptor(host as ChatTurnPreflightHost, sessionId, {
      action: "edit",
      turnId,
      providerId: request.providerId,
      model: request.model,
      mode: request.mode,
      webMode: request.webMode,
      thinkingLevel: request.thinkingLevel,
      speedMode: request.speedMode,
      subagentPolicy: request.subagentPolicy,
      prefsOverride: request.prefsOverride,
    });
    host.recordDevDiagnostic({
      level: "info",
      category: "chat",
      event: "chat.turn.edit_preflight",
      message: "Resolved edit routing before execution",
      sessionId,
      turnId,
      providerId: routeDescriptor.effectiveProviderId,
      modelId: routeDescriptor.effectiveModel,
      context: {
        selectionSource: routeDescriptor.selectionSource,
        fallbackPolicy: routeDescriptor.fallbackPolicy,
      },
    });
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
        request,
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
  options?: { abortSignal?: AbortSignal },
): AsyncGenerator<ChatStreamChunk> {
  yield* host.withChatTurnWriteLeaseStream(sessionId, "edit-turn/stream", () => {
    return (async function* (): AsyncGenerator<ChatStreamChunk> {
      const current = await host.requireChatTurnContext(sessionId, turnId);
      const request: ChatSendMessageRequest = {
        ...input,
        attachments: input.attachments ?? current.userMessage.attachments?.map((item) => item.attachmentId),
      };
      const routeDescriptor = resolveChatRouteDescriptor(host as ChatTurnPreflightHost, sessionId, {
        action: "edit",
        turnId,
        providerId: request.providerId,
        model: request.model,
        mode: request.mode,
        webMode: request.webMode,
        thinkingLevel: request.thinkingLevel,
        speedMode: request.speedMode,
        subagentPolicy: request.subagentPolicy,
        prefsOverride: request.prefsOverride,
      });
      host.recordDevDiagnostic({
        level: "info",
        category: "chat",
        event: "chat.turn.edit_stream_preflight",
        message: "Resolved streamed edit routing before execution",
        sessionId,
        turnId,
        providerId: routeDescriptor.effectiveProviderId,
        modelId: routeDescriptor.effectiveModel,
        context: {
          selectionSource: routeDescriptor.selectionSource,
          fallbackPolicy: routeDescriptor.fallbackPolicy,
        },
      });
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
        const stream = options?.abortSignal
          ? chatTurnDispatchService.streamPreparedIntegrationChatTurn(
              host,
              sessionId,
              request,
              prepared,
              binding,
              "chat_thread_turn_edited",
              { abortSignal: options.abortSignal },
            )
          : chatTurnDispatchService.streamPreparedIntegrationChatTurn(
              host,
              sessionId,
              request,
              prepared,
              binding,
              "chat_thread_turn_edited",
            );
        yield* host.withEphemeralStreamEnvelope(stream);
        return;
      }
      const durableRunId = chatTurnDispatchService.launchPreparedAgentChatTurnStream(
        host,
        sessionId,
        request,
        prepared,
        "chat_thread_turn_edited",
      );
      const detachAbortListener = bindStreamAbortToTurn(host, prepared.turnId, durableRunId, options?.abortSignal);
      try {
        yield* host.streamPersistedChatTurnEvents(sessionId, prepared.turnId, {
          liveTail: true,
          ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
        });
      } finally {
        detachAbortListener?.();
      }
    })();
  });
}

function bindStreamAbortToTurn(
  host: ChatTurnEntryHost,
  turnId: string,
  durableRunId: string | undefined,
  externalSignal: AbortSignal | undefined,
): (() => void) | undefined {
  if (!externalSignal) {
    return undefined;
  }
  const fire = (): void => {
    if (durableRunId) {
      // A passive SSE disconnect is not operator intent to cancel a durable Chat/Cowork/Code turn.
      // Explicit stop still flows through cancelChatTurn, which cancels the durable run with evidence.
      return;
    }
    const active = host.getActiveChatTurnExecution(turnId);
    if (active && !active.controller.signal.aborted) {
      active.controller.abort(new ChatTurnCancelledError(turnId));
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

export async function cancelChatTurn(
  host: ChatTurnEntryHost,
  sessionId: string,
  turnId: string,
  cancelledBy?: string,
): Promise<ChatCancelTurnResponse> {
  let current: ChatTurnTraceRecord | undefined;
  try {
    current = host.storage.chatTurnTraces.get(turnId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
  const activeStream = host.getActiveChatTurnStream(turnId);
  if (current?.sessionId !== undefined && current.sessionId !== sessionId) {
    throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
  }
  if (!current) {
    if (!activeStream) {
      throw new NotFoundError({ entity: "Chat turn", id: turnId });
    }
    if (activeStream.sessionId !== sessionId) {
      throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
    }
  }
  const active = host.getActiveChatTurnExecution(turnId);
  if (active?.sessionId === sessionId && !active.controller.signal.aborted) {
    active.controller.abort(new ChatTurnCancelledError(turnId));
  }
  const durableRunId = current?.durable?.runId ?? activeStream?.runId;
  if (durableRunId && host.cancelDurableChatRun) {
    try {
      host.cancelDurableChatRun(durableRunId, cancelledBy ?? "operator");
    } catch {
      // The chat trace still records the operator cancel even if the durable run already settled.
    }
  }
  const trace = host.markChatTurnCancelled(sessionId, turnId, cancelledBy);
  host.persistChatStreamChunk(
    {
      type: "trace_update",
      sessionId,
      turnId,
      trace,
    },
    durableRunId,
  );
  if (trace.assistantMessageId) {
    host.persistChatStreamChunk(
      {
        type: "done",
        sessionId,
        turnId,
        messageId: trace.assistantMessageId,
      },
      durableRunId,
    );
  }
  host.completeActiveChatTurnStream(turnId);
  setTimeout(() => host.closeActiveChatTurnStream(turnId), 30_000);
  return {
    sessionId,
    turnId,
    cancelled: trace.status === "cancelled",
    trace,
  };
}

export async function routePreflight(
  host: ChatTurnPreflightHost,
  sessionId: string,
  input: RoutingPreflightRequest,
): Promise<RoutingPreflightResult> {
  return preflightChatRoute(host, sessionId, input);
}

export async function* resumeAgentChatTurnStream(
  host: ChatTurnResumeHost,
  sessionId: string,
  turnId: string,
  sinceEventId?: string,
  options?: { abortSignal?: AbortSignal },
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
    ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
  });
}
