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
    ensureChatSessionModelDefaults: (sessionId, prefs) => source.ensureChatSessionModelDefaults(sessionId, prefs),
    ensureChatSessionRuntimeGrants: (sessionId) => source.ensureChatSessionRuntimeGrants(sessionId),
    getSession: (sessionId) => source.getSession(sessionId),
    getSessionAutonomyPrefs: (sessionId) => source.getSessionAutonomyPrefs(sessionId),
    loadChatTurnSessionState: (sessionId) => source.loadChatTurnSessionState(sessionId),
    maybeAutoTitleChatSession: (sessionId, content) => source.maybeAutoTitleChatSession(sessionId, content),
    normalizeWorkspaceId: (workspaceId) => source.normalizeWorkspaceId(workspaceId),
    patchSessionAutonomyPrefs: (sessionId, input) => source.patchSessionAutonomyPrefs(sessionId, input),
    prepareAgentChatTurn: (sessionId, input, options) => source.prepareAgentChatTurn(sessionId, input, options),
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
    closeActiveChatTurnStream: (turnId) => source.closeActiveChatTurnStream(turnId),
    completeActiveChatTurnStream: (turnId) => source.completeActiveChatTurnStream(turnId),
    createHydratedChatTurnTrace: (turnId, trace) => source.createHydratedChatTurnTrace(turnId, trace),
    persistChatStreamChunk: (chunk, durableRunId) => source.persistChatStreamChunk(chunk, durableRunId),
    registerActiveChatTurnStream: (sessionId, turnId, durableRunId) =>
      source.registerActiveChatTurnStream(sessionId, turnId, durableRunId),
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
    beginDurableChatRun: (prepared, input, threadEventType) =>
      source.beginDurableChatRun(prepared, input, threadEventType),
    finalizeDurableChatRun: (runId, prepared, trace) => source.finalizeDurableChatRun(runId, prepared, trace),
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
    recordCapabilityGapFromTrace: (input) => source.recordCapabilityGapFromTrace(input),
    scheduleChatMemoryContextPrewarm: (input) => source.scheduleChatMemoryContextPrewarm(input),
    scheduleMemoryMaintenancePostTurnEvaluation: (sessionId, parentTurnId) =>
      source.scheduleMemoryMaintenancePostTurnEvaluation(sessionId, parentTurnId),
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
    ingestEvent: (idempotencyKey, payload) => source.ingestEvent(idempotencyKey, payload),
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
  | "listLlmModels"
  | "recordDevDiagnostic"
  | "resolveFallbackTargets"
  | "resolvePreparedTurnOrchestration"
> {
  return {
    buildChatOrchestrationSummary: (input) => source.buildChatOrchestrationSummary(input),
    collectCapabilityUpgradeSuggestions: (input) => source.collectCapabilityUpgradeSuggestions(input),
    collectSpecialistCandidateSuggestions: (input) => source.collectSpecialistCandidateSuggestions(input),
    createChatCompletion: (request) => source.createChatCompletion(request),
    listLlmModels: source.listLlmModels
      ? (providerId) => source.listLlmModels?.(providerId) ?? Promise.resolve([])
      : undefined,
    recordDevDiagnostic: (input) => source.recordDevDiagnostic(input),
    resolveFallbackTargets: (runtime, primaryProviderId, primaryModel) =>
      source.resolveFallbackTargets(runtime, primaryProviderId, primaryModel),
    resolvePreparedTurnOrchestration: (prepared) => source.resolvePreparedTurnOrchestration(prepared),
  };
}

function composeEntryExtras(
  source: ChatTurnRuntimeHost,
): Pick<
  ChatTurnRuntimeHost,
  | "agentSendChatMessage"
  | "createChatSession"
  | "inheritDelegatedSessionToolGrants"
  | "isReplayScratchSession"
  | "requireChatTurnContext"
  | "triggerChatSessionProactive"
  | "updateActiveLeafOrThrow"
  | "updateChatSessionPrefs"
> {
  return {
    agentSendChatMessage: (sessionId, input, options) => source.agentSendChatMessage(sessionId, input, options),
    createChatSession: (input) => source.createChatSession(input),
    inheritDelegatedSessionToolGrants: (sessionId, delegatedSessionId) =>
      source.inheritDelegatedSessionToolGrants(sessionId, delegatedSessionId),
    isReplayScratchSession: (sessionId) => source.isReplayScratchSession(sessionId),
    requireChatTurnContext: (sessionId, turnId) => source.requireChatTurnContext(sessionId, turnId),
    triggerChatSessionProactive: (sessionId, input) => source.triggerChatSessionProactive(sessionId, input),
    updateActiveLeafOrThrow: (sessionId, previousActiveTurnId, nextActiveTurnId) =>
      source.updateActiveLeafOrThrow(sessionId, previousActiveTurnId, nextActiveTurnId),
    updateChatSessionPrefs: (sessionId, input) => source.updateChatSessionPrefs(sessionId, input),
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
