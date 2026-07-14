import type { ChatTurnPreflightHost, ChatTurnResumeHost } from "./chat-turn-entry-service.js";
import type {
  ChatTurnActiveExecutionControl,
  ChatTurnDurableRunOwner,
  ChatTurnIntegrationDispatch,
  ChatTurnLeaseControl,
  ChatTurnMemorySideEffects,
  ChatTurnRealtimeEmitter,
  ChatTurnSteerCollaborator,
  ChatTurnStreamLifecycleControl,
  ChatTurnTranscriptIngress,
} from "./chat-turn-runtime-collaborators.js";

export type ChatTurnRuntimeHost = ChatTurnPreflightHost & ChatTurnResumeHost;

export function createChatTurnRuntimeHost(source: ChatTurnRuntimeHost): ChatTurnRuntimeHost {
  const runtimeHost = mergeCollaborators(
    composeRuntimeBase(source),
    composeSessionPreparation(source),
    composeActiveExecution(source),
    composeStreamLifecycle(source),
    composeDurableOwnership(source),
    composeMemorySideEffects(source),
    composeRealtimeEmission(source),
    composeSteerCollaborator(source),
    composeTranscriptIngress(source),
    composeIntegrationDispatch(source),
    composeRoutingAndPlanning(source),
    composeEntryExtras(source),
  );
  return assertCompleteChatTurnRuntimeHost(runtimeHost);
}

function composeRuntimeBase(
  source: ChatTurnRuntimeHost,
): Pick<ChatTurnRuntimeHost, "storage" | "turnRuntime" | "config" | "backgroundTasks" | "hooksService"> {
  return {
    get storage() {
      return source.storage;
    },
    get turnRuntime() {
      return source.turnRuntime;
    },
    get config() {
      return source.config;
    },
    get backgroundTasks() {
      return source.backgroundTasks;
    },
    get hooksService() {
      return source.hooksService;
    },
  };
}

function composeSessionPreparation(
  source: ChatTurnRuntimeHost,
): Pick<
  ChatTurnRuntimeHost,
  | "buildDefaultChatPersonalityOverlay"
  | "buildLlmMessagesFromBranchPath"
  | "composeFrozenOperatorProfileDigest"
  | "ensureChatSessionModelDefaults"
  | "ensureChatSessionRuntimeGrants"
  | "getSession"
  | "getSessionAutonomyPrefs"
  | "llmService"
  | "loadChatTurnSessionState"
  | "maybeAutoTitleChatSession"
  | "normalizeWorkspaceId"
  | "patchSessionAutonomyPrefs"
  | "prepareAgentChatTurn"
  | "recordRuntimeDecision"
  | "resolveBasePromptCapabilityCatalog"
  | "resolveChatRoutedContextSources"
  | "resolveRuntimeGuidance"
  | "resolveThreadKnowledgeContext"
  | "routeFromSession"
> {
  return {
    get llmService() {
      return source.llmService;
    },
    buildDefaultChatPersonalityOverlay: () => source.buildDefaultChatPersonalityOverlay(),
    buildLlmMessagesFromBranchPath: (sessionId, pathTurnIds, currentUserMessage, options, state) =>
      source.buildLlmMessagesFromBranchPath(sessionId, pathTurnIds, currentUserMessage, options, state),
    composeFrozenOperatorProfileDigest: source.composeFrozenOperatorProfileDigest
      ? (workspaceId) => source.composeFrozenOperatorProfileDigest?.(workspaceId)
      : undefined,
    ensureChatSessionModelDefaults: (sessionId, prefs) => source.ensureChatSessionModelDefaults(sessionId, prefs),
    ensureChatSessionRuntimeGrants: (sessionId) => source.ensureChatSessionRuntimeGrants(sessionId),
    getSession: (sessionId) => source.getSession(sessionId),
    getSessionAutonomyPrefs: (sessionId) => source.getSessionAutonomyPrefs(sessionId),
    loadChatTurnSessionState: (sessionId) => source.loadChatTurnSessionState(sessionId),
    maybeAutoTitleChatSession: (sessionId, content) => source.maybeAutoTitleChatSession(sessionId, content),
    normalizeWorkspaceId: (workspaceId) => source.normalizeWorkspaceId(workspaceId),
    patchSessionAutonomyPrefs: (sessionId, input) => source.patchSessionAutonomyPrefs(sessionId, input),
    prepareAgentChatTurn: (sessionId, input, options) => source.prepareAgentChatTurn(sessionId, input, options),
    recordRuntimeDecision: source.recordRuntimeDecision ? (input) => source.recordRuntimeDecision?.(input) : undefined,
    resolveBasePromptCapabilityCatalog: source.resolveBasePromptCapabilityCatalog
      ? () => source.resolveBasePromptCapabilityCatalog?.() ?? { toolNames: [] }
      : undefined,
    resolveChatRoutedContextSources: (input) => source.resolveChatRoutedContextSources(input),
    resolveRuntimeGuidance: (workspaceId) => source.resolveRuntimeGuidance(workspaceId),
    resolveThreadKnowledgeContext: (sessionId, query) => source.resolveThreadKnowledgeContext(sessionId, query),
    routeFromSession: (session) => source.routeFromSession(session),
  };
}

function composeActiveExecution(source: ChatTurnRuntimeHost): ChatTurnActiveExecutionControl & ChatTurnLeaseControl {
  return {
    beginActiveChatTurnExecution: (sessionId, turnId, operation) =>
      source.beginActiveChatTurnExecution(sessionId, turnId, operation),
    endActiveChatTurnExecution: (turnId, controller) => source.endActiveChatTurnExecution(turnId, controller),
    getActiveChatTurnExecution: (turnId) => source.getActiveChatTurnExecution(turnId),
    markChatTurnCancelled: (sessionId, turnId, cancelledBy) =>
      source.markChatTurnCancelled(sessionId, turnId, cancelledBy),
    withChatTurnWriteLease: (sessionId, operation, task) => source.withChatTurnWriteLease(sessionId, operation, task),
    withChatTurnWriteLeaseStream: (sessionId, operation, factory) =>
      source.withChatTurnWriteLeaseStream(sessionId, operation, factory),
  };
}

function composeStreamLifecycle(source: ChatTurnRuntimeHost): ChatTurnStreamLifecycleControl {
  return {
    closeActiveChatTurnStream: (turnId, registrationId) => source.closeActiveChatTurnStream(turnId, registrationId),
    completeActiveChatTurnStream: (turnId, registrationId) =>
      source.completeActiveChatTurnStream(turnId, registrationId),
    createHydratedChatTurnTrace: (turnId, trace) => source.createHydratedChatTurnTrace(turnId, trace),
    getActiveChatTurnStream: (turnId) => source.getActiveChatTurnStream(turnId),
    persistChatStreamChunk: (chunk, durableRunId, streamRegistration) =>
      source.persistChatStreamChunk(chunk, durableRunId, streamRegistration),
    registerActiveChatTurnStream: (sessionId, turnId, durableRunId, options) =>
      source.registerActiveChatTurnStream(sessionId, turnId, durableRunId, options),
    streamPersistedChatTurnEvents: (sessionId, turnId, options) =>
      source.streamPersistedChatTurnEvents(sessionId, turnId, options),
    withEphemeralStreamEnvelope: (stream, runId) => source.withEphemeralStreamEnvelope(stream, runId),
  };
}

function composeDurableOwnership(source: ChatTurnRuntimeHost): ChatTurnDurableRunOwner {
  return {
    get config() {
      return source.config;
    },
    get backgroundTasks() {
      return source.backgroundTasks;
    },
    beginDurableChatRun: (prepared, input, threadEventType, options) =>
      source.beginDurableChatRun(prepared, input, threadEventType, options),
    finalizeDurableChatRun: (runId, prepared, trace, expectedLeaseOwnerId) =>
      source.finalizeDurableChatRun(runId, prepared, trace, expectedLeaseOwnerId),
    isFeatureEnabled: (flag) => source.isFeatureEnabled(flag),
    cancelDurableChatRun: source.cancelDurableChatRun
      ? (runId, actorId) => source.cancelDurableChatRun?.(runId, actorId)
      : undefined,
  };
}

function composeMemorySideEffects(source: ChatTurnRuntimeHost): ChatTurnMemorySideEffects {
  return {
    extractAndPersistLearnedMemory: (sessionId, content, sourceRef) =>
      source.extractAndPersistLearnedMemory(sessionId, content, sourceRef),
    recordTurnCommitments: (input) => source.recordTurnCommitments(input),
    recordCapabilityGapFromTrace: (input) => source.recordCapabilityGapFromTrace(input),
    scheduleChatMemoryContextPrewarm: (input) => source.scheduleChatMemoryContextPrewarm(input),
    scheduleMemoryMaintenancePostTurnEvaluation: (input) => source.scheduleMemoryMaintenancePostTurnEvaluation(input),
    scheduleBackgroundReviewIfDue: (input) => source.scheduleBackgroundReviewIfDue(input),
  };
}

function composeRealtimeEmission(source: ChatTurnRuntimeHost): ChatTurnRealtimeEmitter {
  return {
    publishRealtime: (channel, topic, payload, options) => source.publishRealtime(channel, topic, payload, options),
  };
}

function composeSteerCollaborator(source: ChatTurnRuntimeHost): ChatTurnSteerCollaborator {
  return {
    get steerService() {
      return source.steerService;
    },
  };
}

function composeTranscriptIngress(source: ChatTurnRuntimeHost): ChatTurnTranscriptIngress {
  return {
    ingestEvent: (idempotencyKey, payload, options) => source.ingestEvent(idempotencyKey, payload, options),
  };
}

function composeIntegrationDispatch(source: ChatTurnRuntimeHost): ChatTurnIntegrationDispatch {
  return {
    commsSend: (input) => source.commsSend(input),
    ensureSessionInternalToolGrant: (sessionId, toolName, reason) =>
      source.ensureSessionInternalToolGrant(sessionId, toolName, reason),
    requireExecutedToolResult: (toolName, result) => source.requireExecutedToolResult(toolName, result),
  };
}

function composeRoutingAndPlanning(
  source: ChatTurnRuntimeHost,
): Pick<
  ChatTurnRuntimeHost,
  | "buildChatOrchestrationSummary"
  | "collectCapabilityUpgradeSuggestions"
  | "collectSpecialistCandidateSuggestions"
  | "createChatCompletion"
  | "executeChatModelCouncil"
  | "listLlmModels"
  | "recordDevDiagnostic"
  | "resolveFallbackTargets"
  | "resolvePreparedTurnOrchestration"
  | "resolveToolPolicyContext"
> {
  return {
    buildChatOrchestrationSummary: (input) => source.buildChatOrchestrationSummary(input),
    collectCapabilityUpgradeSuggestions: (input) => source.collectCapabilityUpgradeSuggestions(input),
    collectSpecialistCandidateSuggestions: (input) => source.collectSpecialistCandidateSuggestions(input),
    createChatCompletion: (request, attribution) => source.createChatCompletion(request, attribution),
    executeChatModelCouncil: source.executeChatModelCouncil
      ? (prepared, signal) =>
          source.executeChatModelCouncil?.(prepared, signal) as ReturnType<
            NonNullable<ChatTurnRuntimeHost["executeChatModelCouncil"]>
          >
      : undefined,
    listLlmModels: source.listLlmModels
      ? (providerId) => source.listLlmModels?.(providerId) ?? Promise.resolve([])
      : undefined,
    recordDevDiagnostic: (input) => source.recordDevDiagnostic(input),
    resolveFallbackTargets: (runtime, primaryProviderId, primaryModel) =>
      source.resolveFallbackTargets(runtime, primaryProviderId, primaryModel),
    resolvePreparedTurnOrchestration: (prepared) => source.resolvePreparedTurnOrchestration(prepared),
    resolveToolPolicyContext: source.resolveToolPolicyContext
      ? (input) => source.resolveToolPolicyContext!(input)
      : undefined,
  };
}

function composeEntryExtras(
  source: ChatTurnRuntimeHost,
): Pick<
  ChatTurnRuntimeHost,
  | "agentSendChatMessage"
  | "agentSendChatMessageStream"
  | "createChatSession"
  | "inheritDelegatedSessionToolGrants"
  | "isReplayScratchSession"
  | "requireChatTurnContext"
  | "triggerChatSessionProactive"
  | "updateActiveLeafOrThrow"
  | "updateChatSessionPrefs"
  | "surfaceRouter"
  | "readChatSessionMode"
  | "persistChatSessionMode"
  | "recordSurfaceRouteOverrideSignal"
  | "subagentFanout"
> {
  return {
    agentSendChatMessage: (sessionId, input, options) => source.agentSendChatMessage(sessionId, input, options),
    agentSendChatMessageStream: (sessionId, input, options) =>
      source.agentSendChatMessageStream(sessionId, input, options),
    createChatSession: (input) => source.createChatSession(input),
    inheritDelegatedSessionToolGrants: (sessionId, delegatedSessionId) =>
      source.inheritDelegatedSessionToolGrants(sessionId, delegatedSessionId),
    isReplayScratchSession: (sessionId) => source.isReplayScratchSession(sessionId),
    requireChatTurnContext: (sessionId, turnId) => source.requireChatTurnContext(sessionId, turnId),
    triggerChatSessionProactive: (sessionId, input) => source.triggerChatSessionProactive(sessionId, input),
    updateActiveLeafOrThrow: (sessionId, previousActiveTurnId, nextActiveTurnId) =>
      source.updateActiveLeafOrThrow(sessionId, previousActiveTurnId, nextActiveTurnId),
    updateChatSessionPrefs: (sessionId, input) => source.updateChatSessionPrefs(sessionId, input),
    surfaceRouter: source.surfaceRouter,
    readChatSessionMode: source.readChatSessionMode,
    persistChatSessionMode: source.persistChatSessionMode,
    recordSurfaceRouteOverrideSignal: source.recordSurfaceRouteOverrideSignal,
    // R3-8: the turn services register turn-scoped agent.fanout executors on
    // this registry; dropping it here silently kills the tool in production
    // (the member is optional, so the compiler cannot catch the omission).
    get subagentFanout() {
      return source.subagentFanout;
    },
  };
}

type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (
  value: infer TIntersection,
) => void
  ? TIntersection
  : never;

function assertCompleteChatTurnRuntimeHost(runtimeHost: ChatTurnRuntimeHost): ChatTurnRuntimeHost {
  return runtimeHost;
}

function mergeCollaborators<TCollaborators extends readonly object[]>(
  ...collaborators: TCollaborators
): UnionToIntersection<TCollaborators[number]> {
  const target = {};
  for (const collaborator of collaborators) {
    Object.defineProperties(target, Object.getOwnPropertyDescriptors(collaborator));
  }
  return target as UnionToIntersection<TCollaborators[number]>;
}
