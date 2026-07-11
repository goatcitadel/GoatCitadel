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
  ChatMode,
  ChatTurnBranchKind,
  ChatMessageRecord,
  RoutingPreflightRequest,
  RoutingPreflightResult,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSpecialistCandidateSuggestionRecord,
  ChatStreamChunk,
  ChatTurnTraceRecord,
  DurableRunRecord,
  GatewayEventInput,
  ProactiveRunRecord,
} from "@goatcitadel/contracts";
import { isChatTurnActiveStatus, isChatTurnTerminalStatus, NotFoundError } from "@goatcitadel/contracts";
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
  patchChatTurnTraceIfStatus,
} from "./chat-turn-helpers.js";
import { buildChatTurnRealtimeOptions } from "./chat-turn-realtime.js";
import { isAutonomousTurnRequest } from "./gateway/autonomous-turn-policy.js";
import {
  resolvePreparedTurnMode,
  type ChatTurnPrepHost,
  type PreparedAgentChatTurn,
} from "./chat-turn-prep-service.js";
import * as chatTurnDispatchService from "./chat-turn-dispatch-service.js";
import { shouldRegisterSubagentFanoutExecutor } from "./chat-subagent-fanout-service.js";
import { createTurnSubagentFanoutExecutor } from "./chat-turn-stream-service.js";
import { applySurfaceRoutingPreflight } from "./surface-router-entry.js";
import type { SurfaceClassification } from "./surface-router-heuristics.js";
import type { SurfaceRouteRequest } from "./surface-router-service.js";
import type { SurfaceRouteOverrideSignalInput } from "./improvement-service.js";
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
  // Optional surface-router hooks — provided by the composition root when the auto-router is wired up.
  surfaceRouter?: { route(req: SurfaceRouteRequest): Promise<SurfaceClassification> };
  readChatSessionMode?(sessionId: string): ChatMode | undefined;
  persistChatSessionMode?(sessionId: string, mode: ChatMode): void;
  recordSurfaceRouteOverrideSignal?(input: SurfaceRouteOverrideSignalInput): void;
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
  options?: { abortSignal?: AbortSignal; onChildDurableRunLaunched?: (runId: string) => void },
): Promise<ChatSendMessageResponse> {
  return host.withChatTurnWriteLease(sessionId, "agent-send", async () => {
    input = await applySurfaceRoutingPreflight(host, sessionId, input, (error) => {
      host.recordDevDiagnostic({
        level: "warn",
        category: "chat",
        event: "chat.surface_router.failed",
        message: "Surface auto-router failed; continuing with the provided/default mode",
        sessionId,
        context: { error: error instanceof Error ? error.message : String(error) },
      });
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
        { abortSignal: options?.abortSignal, onChildDurableRunLaunched: options?.onChildDurableRunLaunched },
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
        { abortSignal: options?.abortSignal, onChildDurableRunLaunched: options?.onChildDurableRunLaunched },
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
  const mode = resolvePreparedTurnMode(prepared);
  // R3-8: expose the turn-scoped `agent.fanout` executor for the lifetime of
  // this buffered turn. Gated on the turn's own eligibility so a delegated
  // child (floored to subagentPolicy "off") never holds a live executor.
  // Rebound to the retry turn on the reflection path (turn attribution) and
  // disposed in the finally below.
  const subagentFanoutExecutorOptions = {
    signal: controller.signal,
    operatorId: input.operatorId,
    authActorId: input.authActorId,
    authActorSource: input.authActorSource,
    permissionProfileId: input.permissionProfileId,
    localOperatorOverrideId: input.localOperatorOverrideId,
    fullWebAccess: input.fullWebAccess,
  };
  let disposeSubagentFanout = shouldRegisterSubagentFanoutExecutor(
    prepared,
    subagentFanoutExecutorOptions.permissionProfileId,
  )
    ? host.subagentFanout?.register(
        sessionId,
        createTurnSubagentFanoutExecutor(host, prepared, subagentFanoutExecutorOptions),
      )
    : undefined;
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
      mode,
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
      modelRouter: prepared.modelRouterDecision,
      signal: controller.signal,
    });
    assertChatTurnCompletionWritable(host, prepared.turnId, controller.signal, [turnResult.turnTrace.status]);
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
      // R3-8: rebind the fan-out executor to the retry turn so any
      // agent.fanout work during the retry is attributed to the retry turn's
      // id (child runIds and delegated diagnostics derive from
      // prepared.turnId), not the failed original.
      if (shouldRegisterSubagentFanoutExecutor(prepared, subagentFanoutExecutorOptions.permissionProfileId)) {
        disposeSubagentFanout?.();
        disposeSubagentFanout = host.subagentFanout?.register(
          sessionId,
          createTurnSubagentFanoutExecutor(host, { ...prepared, turnId: retryTurnId }, subagentFanoutExecutorOptions),
        );
      }
      const retryResult = await host.turnRuntime.run({
        sessionId,
        turnId: retryTurnId,
        userMessageId: prepared.userEventId,
        parentTurnId: prepared.parentTurnId,
        branchKind: "retry",
        sourceTurnId: turnId,
        content: retryPrompt,
        mode,
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
        modelRouter: prepared.modelRouterDecision,
        signal: controller.signal,
      });
      assertChatTurnCompletionWritable(host, retryTurnId, controller.signal, [retryResult.turnTrace.status]);
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
    const assistantUsage = withCostAttribution(turnResult.usage, {
      providerId: turnResult.turnTrace.routing.effectiveProviderId ?? input.providerId ?? prepared.prefs.providerId,
      model:
        turnResult.turnTrace.routing.effectiveModel ?? turnResult.assistantModel ?? input.model ?? prepared.prefs.model,
    });
    const assistantEventId = prepared.assistantMessageId;
    const storage = host.storage;
    const finalTraceStatus = turnResult.turnTrace.status === "failed" ? "failed" : "completed";
    const finalTracePatch: Parameters<Storage["chatTurnTraces"]["patch"]>[1] = {
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
    };
    const completionOwnerStatuses = [
      ...new Set(["running", turnResult.turnTrace.status]),
    ] as ChatTurnTraceRecord["status"][];
    let trace: ChatTurnTraceRecord | undefined;
    assertChatTurnCompletionWritable(host, turnId, controller.signal, completionOwnerStatuses);
    await host.ingestEvent(
      randomUUID(),
      {
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
      },
      {
        onCommit: () => {
          trace = patchChatTurnTraceIfStatus(storage.chatTurnTraces, turnId, completionOwnerStatuses, finalTracePatch);
        },
      },
    );
    trace ??= patchChatTurnTraceIfStatus(storage.chatTurnTraces, turnId, completionOwnerStatuses, finalTracePatch);
    const assistantMessage: ChatMessageRecord = {
      messageId: assistantEventId,
      sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: assistantText,
      timestamp: new Date().toISOString(),
    };
    let hydratedTrace: ChatTurnTraceRecord = {
      ...trace,
      citations: dedupedTurnCitations,
      toolRuns: storage.chatToolRuns.listByTurn(turnId),
    };
    const capabilityUpgradeSuggestions = await host.collectCapabilityUpgradeSuggestions({
      sessionId,
      content: prepared.content,
      assistantText,
      trace: hydratedTrace,
    });
    const specialistCandidateSuggestions = host.collectSpecialistCandidateSuggestions({
      sessionId,
      mode,
      content: prepared.content,
      capabilitySuggestions: capabilityUpgradeSuggestions,
      trace: hydratedTrace,
    });
    if (capabilityUpgradeSuggestions.length > 0 || specialistCandidateSuggestions.length > 0) {
      hydratedTrace = storage.chatTurnTraces.patch(turnId, {
        capabilityUpgradeSuggestions: capabilityUpgradeSuggestions.length > 0 ? capabilityUpgradeSuggestions : [],
        specialistCandidateSuggestions: specialistCandidateSuggestions.length > 0 ? specialistCandidateSuggestions : [],
      });
      hydratedTrace = {
        ...hydratedTrace,
        toolRuns: storage.chatToolRuns.listByTurn(turnId),
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
    // P1-F3: infer future follow-up check-ins from a successful turn's transcript
    // (fire-and-forget, beside learned-memory). The host applies the autonomy /
    // eval-integrity / non-human guards and swallows errors. Autonomous self-wake
    // turns are excluded (no self-feeding classifier/review loop on their output).
    if (finalTraceStatus === "completed") {
      const autonomousTurn = isAutonomousTurnRequest(input);
      host.recordTurnCommitments({
        sessionId,
        workspaceId: prepared.workspaceId,
        userText: prepared.content,
        assistantText,
        autonomous: autonomousTurn,
      });
      // P2-S1: counter-gated self-improvement review (fire-and-forget). The host
      // gates on master autonomy / eval-integrity / non-human + the turn counter.
      host.scheduleBackgroundReviewIfDue({
        sessionId,
        workspaceId: prepared.workspaceId,
        userText: prepared.content,
        assistantText,
        parentTurnId: prepared.parentTurnId,
        autonomous: autonomousTurn,
      });
    }
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
    disposeSubagentFanout?.();
    externalAbortListener?.();
    host.endActiveChatTurnExecution(prepared.turnId, controller);
  }
}

function assertChatTurnCompletionWritable(
  host: Pick<ChatTurnEntryHost, "storage">,
  turnId: string,
  signal: AbortSignal,
  allowedTerminalStatuses: readonly ChatTurnTraceRecord["status"][] = [],
): void {
  if (signal.aborted) {
    throw new ChatTurnCancelledError(turnId);
  }
  let status: ChatTurnTraceRecord["status"];
  try {
    status = host.storage.chatTurnTraces.get(turnId).status;
  } catch (error) {
    if (error instanceof NotFoundError) {
      // The turn runtime may not have persisted its trace yet. The abort
      // signal remains the completion fence in that compatibility case.
      return;
    }
    throw error;
  }
  if (status === "cancelled") {
    throw new ChatTurnCancelledError(turnId);
  }
  if (isChatTurnTerminalStatus(status) && !allowedTerminalStatuses.includes(status)) {
    throw new Error(`Chat turn ${turnId} completion lost lifecycle ownership to ${status}.`);
  }
}

function withCostAttribution(
  usage: GatewayEventInput["usage"] | undefined,
  attribution: { providerId?: string; model?: string },
): GatewayEventInput["usage"] {
  return {
    ...(usage ?? {}),
    ...(attribution.providerId ? { providerId: attribution.providerId } : {}),
    ...(attribution.model ? { model: attribution.model } : {}),
  };
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
      input = await applySurfaceRoutingPreflight(host, sessionId, input, (error) => {
        host.recordDevDiagnostic({
          level: "warn",
          category: "chat",
          event: "chat.surface_router.failed",
          message: "Surface auto-router failed; continuing with the provided/default mode",
          sessionId,
          context: { error: error instanceof Error ? error.message : String(error) },
        });
      });
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
  const storage = host.storage;
  const cancelDurableChatRun = host.cancelDurableChatRun;
  let current: ChatTurnTraceRecord | undefined;
  try {
    current = storage.chatTurnTraces.get(turnId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
  const activeStream = host.getActiveChatTurnStream(turnId);
  const writableActiveStream = activeStream && !activeStream.completed ? activeStream : undefined;
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
  let durableCancellation: DurableRunRecord | undefined;
  let durableCancellationError: unknown;
  if (durableRunId && cancelDurableChatRun) {
    try {
      durableCancellation = cancelDurableChatRun(durableRunId, cancelledBy ?? "operator");
    } catch (error) {
      durableCancellationError = error;
      try {
        durableCancellation = storage.durableRuns.getRun(durableRunId);
      } catch {
        // Preserve the original cancellation error when canonical run truth is unavailable.
      }
    }
  }
  const durableTerminalWinner =
    durableCancellation &&
    (durableCancellation.status === "completed" ||
      durableCancellation.status === "failed" ||
      durableCancellation.status === "dead_lettered");
  if (durableCancellationError && !durableTerminalWinner && durableCancellation?.status !== "cancelled") {
    throw durableCancellationError;
  }
  const trace = durableTerminalWinner
    ? (() => {
        try {
          return storage.chatTurnTraces.get(turnId);
        } catch {
          if (current) {
            return current;
          }
          throw durableCancellationError ?? new Error(`Chat turn ${turnId} terminal projection is unavailable.`);
        }
      })()
    : host.markChatTurnCancelled(sessionId, turnId, cancelledBy);
  const durableTerminalProjectionAligned =
    !durableTerminalWinner ||
    (durableCancellation?.status === "completed" && trace.status === "completed") ||
    ((durableCancellation?.status === "failed" || durableCancellation?.status === "dead_lettered") &&
      trace.status === "failed");
  if (!durableTerminalProjectionAligned || (durableTerminalWinner && isChatTurnActiveStatus(trace.status))) {
    return {
      sessionId,
      turnId,
      cancelled: false,
      trace,
    };
  }
  host.persistChatStreamChunk(
    {
      type: "trace_update",
      sessionId,
      turnId,
      trace,
    },
    durableRunId,
    writableActiveStream,
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
      writableActiveStream,
    );
  }
  if (writableActiveStream) {
    host.completeActiveChatTurnStream(turnId, writableActiveStream.registrationId);
    setTimeout(() => host.closeActiveChatTurnStream(turnId, writableActiveStream.registrationId), 30_000);
  }
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
