import type { ChatTurnPreflightHost, ChatTurnResumeHost } from "./chat-turn-entry-service.js";

export type ChatTurnRuntimeHost = ChatTurnPreflightHost & ChatTurnResumeHost;

export function createChatTurnRuntimeHost(source: ChatTurnRuntimeHost): ChatTurnRuntimeHost {
  const runtimeHost: ChatTurnRuntimeHost = {
    get storage() {
      return source.storage;
    },
    get turnRuntime() {
      return source.turnRuntime;
    },
    get llmService() {
      return source.llmService;
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
    agentSendChatMessage: (sessionId, input) => source.agentSendChatMessage(sessionId, input),
    beginActiveChatTurnExecution: (sessionId, turnId, operation) =>
      source.beginActiveChatTurnExecution(sessionId, turnId, operation),
    beginDurableChatRun: (prepared, input, threadEventType) =>
      source.beginDurableChatRun(prepared, input, threadEventType),
    buildChatOrchestrationSummary: (input) => source.buildChatOrchestrationSummary(input),
    buildDefaultChatPersonalityOverlay: () => source.buildDefaultChatPersonalityOverlay(),
    buildLlmMessagesFromBranchPath: (sessionId, pathTurnIds, currentUserMessage, options, state) =>
      source.buildLlmMessagesFromBranchPath(sessionId, pathTurnIds, currentUserMessage, options, state),
    closeActiveChatTurnStream: (turnId) => source.closeActiveChatTurnStream(turnId),
    collectCapabilityUpgradeSuggestions: (input) => source.collectCapabilityUpgradeSuggestions(input),
    collectSpecialistCandidateSuggestions: (input) => source.collectSpecialistCandidateSuggestions(input),
    commsSend: (input) => source.commsSend(input),
    completeActiveChatTurnStream: (turnId) => source.completeActiveChatTurnStream(turnId),
    createChatCompletion: (request) => source.createChatCompletion(request),
    createChatSession: (input) => source.createChatSession(input),
    createHydratedChatTurnTrace: (turnId, trace) => source.createHydratedChatTurnTrace(turnId, trace),
    endActiveChatTurnExecution: (turnId, controller) => source.endActiveChatTurnExecution(turnId, controller),
    ensureChatSessionModelDefaults: (sessionId, prefs) => source.ensureChatSessionModelDefaults(sessionId, prefs),
    ensureChatSessionRuntimeGrants: (sessionId) => source.ensureChatSessionRuntimeGrants(sessionId),
    ensureSessionInternalToolGrant: (sessionId, toolName, reason) =>
      source.ensureSessionInternalToolGrant(sessionId, toolName, reason),
    extractAndPersistLearnedMemory: (sessionId, content, sourceRef) =>
      source.extractAndPersistLearnedMemory(sessionId, content, sourceRef),
    finalizeDurableChatRun: (runId, prepared, trace) => source.finalizeDurableChatRun(runId, prepared, trace),
    getActiveChatTurnExecution: (turnId) => source.getActiveChatTurnExecution(turnId),
    getSession: (sessionId) => source.getSession(sessionId),
    getSessionAutonomyPrefs: (sessionId) => source.getSessionAutonomyPrefs(sessionId),
    ingestEvent: (idempotencyKey, payload) => source.ingestEvent(idempotencyKey, payload),
    inheritDelegatedSessionToolGrants: (sessionId, delegatedSessionId) =>
      source.inheritDelegatedSessionToolGrants(sessionId, delegatedSessionId),
    isFeatureEnabled: (flag) => source.isFeatureEnabled(flag),
    isReplayScratchSession: (sessionId) => source.isReplayScratchSession(sessionId),
    listLlmModels: source.listLlmModels
      ? (providerId) => source.listLlmModels?.(providerId) ?? Promise.resolve([])
      : undefined,
    loadChatTurnSessionState: (sessionId) => source.loadChatTurnSessionState(sessionId),
    markChatTurnCancelled: (sessionId, turnId, cancelledBy) =>
      source.markChatTurnCancelled(sessionId, turnId, cancelledBy),
    maybeAutoTitleChatSession: (sessionId, content) => source.maybeAutoTitleChatSession(sessionId, content),
    normalizeWorkspaceId: (workspaceId) => source.normalizeWorkspaceId(workspaceId),
    patchSessionAutonomyPrefs: (sessionId, input) => source.patchSessionAutonomyPrefs(sessionId, input),
    persistChatStreamChunk: (chunk, durableRunId) => source.persistChatStreamChunk(chunk, durableRunId),
    prepareAgentChatTurn: (sessionId, input, options) => source.prepareAgentChatTurn(sessionId, input, options),
    publishRealtime: (channel, topic, payload, options) => source.publishRealtime(channel, topic, payload, options),
    recordCapabilityGapFromTrace: (input) => source.recordCapabilityGapFromTrace(input),
    recordDevDiagnostic: (input) => source.recordDevDiagnostic(input),
    registerActiveChatTurnStream: (sessionId, turnId, durableRunId) =>
      source.registerActiveChatTurnStream(sessionId, turnId, durableRunId),
    requireChatTurnContext: (sessionId, turnId) => source.requireChatTurnContext(sessionId, turnId),
    requireExecutedToolResult: (toolName, result) => source.requireExecutedToolResult(toolName, result),
    resolveFallbackTargets: (runtime, primaryProviderId, primaryModel) =>
      source.resolveFallbackTargets(runtime, primaryProviderId, primaryModel),
    resolvePreparedTurnOrchestration: (prepared) => source.resolvePreparedTurnOrchestration(prepared),
    resolveRuntimeGuidance: (workspaceId) => source.resolveRuntimeGuidance(workspaceId),
    resolveThreadKnowledgeContext: (sessionId, query) => source.resolveThreadKnowledgeContext(sessionId, query),
    routeFromSession: (session) => source.routeFromSession(session),
    scheduleChatMemoryContextPrewarm: (input) => source.scheduleChatMemoryContextPrewarm(input),
    scheduleMemoryMaintenancePostTurnEvaluation: (sessionId, parentTurnId) =>
      source.scheduleMemoryMaintenancePostTurnEvaluation(sessionId, parentTurnId),
    streamPersistedChatTurnEvents: (sessionId, turnId, options) =>
      source.streamPersistedChatTurnEvents(sessionId, turnId, options),
    triggerChatSessionProactive: (sessionId, input) => source.triggerChatSessionProactive(sessionId, input),
    updateActiveLeafOrThrow: (sessionId, previousActiveTurnId, nextActiveTurnId) =>
      source.updateActiveLeafOrThrow(sessionId, previousActiveTurnId, nextActiveTurnId),
    updateChatSessionPrefs: (sessionId, input) => source.updateChatSessionPrefs(sessionId, input),
    withChatTurnWriteLease: (sessionId, operation, task) => source.withChatTurnWriteLease(sessionId, operation, task),
    withChatTurnWriteLeaseStream: (sessionId, operation, factory) =>
      source.withChatTurnWriteLeaseStream(sessionId, operation, factory),
    withEphemeralStreamEnvelope: (stream, runId) => source.withEphemeralStreamEnvelope(stream, runId),
  };
  return runtimeHost;
}
