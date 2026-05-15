import { describe, expect, it, vi } from "vitest";
import { createChatTurnRuntimeHost, type ChatTurnRuntimeHost } from "./chat-turn-runtime-host-composition.js";

describe("createChatTurnRuntimeHost", () => {
  it("preserves dynamic base collaborators through getters", () => {
    const source = createSourceHost();
    const host = createChatTurnRuntimeHost(source.host);

    expect(host.storage).toBe(source.values.storage);
    expect(host.turnRuntime).toBe(source.values.turnRuntime);
    expect(host.config).toBe(source.values.config);
    expect(host.backgroundTasks).toBe(source.values.backgroundTasks);
    expect(host.hooksService).toBe(source.values.hooksService);
    expect(host.llmService).toBe(source.values.llmService);

    source.values.config = { assistant: { durable: { enabled: false } } };
    expect(host.config).toBe(source.values.config);
  });

  it("forwards session preparation, execution, stream, durable, and entry collaborators", async () => {
    const source = createSourceHost();
    const host = createChatTurnRuntimeHost(source.host);
    const stream = asyncGenerator("event");
    const wrappedStream = asyncGenerator("wrapped");
    source.fns.withChatTurnWriteLease.mockImplementation(async (_sessionId, _operation, task) => task());
    source.fns.withChatTurnWriteLeaseStream.mockImplementation((_sessionId, _operation, factory) => factory());
    source.fns.streamPersistedChatTurnEvents.mockReturnValue(stream);
    source.fns.withEphemeralStreamEnvelope.mockReturnValue(wrappedStream);
    source.fns.listLlmModels.mockResolvedValue(["model-a"]);

    await expect(host.buildLlmMessagesFromBranchPath("session-1", ["turn-1"], "hello", {}, {} as never)).resolves.toBe(
      "messages",
    );
    await expect(host.ensureChatSessionModelDefaults("session-1", { providerId: "openai" } as never)).resolves.toBe(
      "model-defaults",
    );
    await expect(host.ensureChatSessionRuntimeGrants("session-1")).resolves.toBe("runtime-grants");
    expect(host.buildDefaultChatPersonalityOverlay()).toBe("overlay");
    expect(host.getSession("session-1")).toBe("session");
    expect(host.getSessionAutonomyPrefs("session-1")).toBe("autonomy");
    expect(host.loadChatTurnSessionState("session-1")).toBe("session-state");
    expect(host.maybeAutoTitleChatSession("session-1", "hello")).toBe("title");
    expect(host.normalizeWorkspaceId("workspace-1")).toBe("workspace");
    expect(host.patchSessionAutonomyPrefs("session-1", { proactiveMode: "off" } as never)).toBe("patched-autonomy");
    await expect(host.prepareAgentChatTurn("session-1", { content: "hello" } as never, {})).resolves.toBe("prepared");
    expect(host.resolveRuntimeGuidance("workspace-1")).toBe("guidance");
    expect(host.resolveThreadKnowledgeContext("session-1", "query")).toBe("knowledge");
    expect(host.routeFromSession({ sessionId: "session-1" } as never)).toBe("route");

    const leaseResult = await host.withChatTurnWriteLease("session-1", "send", async () => "leased");
    expect(leaseResult).toBe("leased");
    expect(host.withChatTurnWriteLeaseStream("session-1", "send", () => "lease-stream" as never)).toBe("lease-stream");
    expect(host.beginActiveChatTurnExecution("session-1", "turn-1", "send")).toBe("controller");
    expect(host.endActiveChatTurnExecution("turn-1", {} as never)).toBe("ended");
    expect(host.getActiveChatTurnExecution("turn-1")).toBe("active");
    expect(host.markChatTurnCancelled("session-1", "turn-1", "operator")).toBe("cancelled");

    expect(host.closeActiveChatTurnStream("turn-1")).toBe("closed");
    expect(host.completeActiveChatTurnStream("turn-1")).toBe("completed");
    expect(host.createHydratedChatTurnTrace("turn-1", {} as never)).toBe("hydrated");
    expect(host.persistChatStreamChunk({ type: "done" } as never, "run-1")).toBe("persisted");
    expect(host.registerActiveChatTurnStream("session-1", "turn-1", "run-1")).toBe("registered");
    expect(host.streamPersistedChatTurnEvents("session-1", "turn-1")).toBe(stream);
    expect(host.withEphemeralStreamEnvelope(asyncGenerator("raw"), "run-1")).toBe(wrappedStream);

    expect(host.beginDurableChatRun({} as never, { content: "hello" } as never, "chat_thread_turn_appended")).toBe(
      "durable-run",
    );
    expect(host.finalizeDurableChatRun("run-1", {} as never, {} as never)).toBe("finalized");
    expect(host.isFeatureEnabled("durableKernelV1Enabled")).toBe("enabled");

    await expect(host.ingestEvent("event-1", { type: "chat" } as never)).resolves.toBe("ingested");
    expect(host.extractAndPersistLearnedMemory("session-1", "answer", { role: "assistant" } as never)).toBe("memory");
    expect(host.recordCapabilityGapFromTrace({ sessionId: "session-1" } as never)).toBe("gap");
    expect(host.scheduleChatMemoryContextPrewarm({ sessionId: "session-1" } as never)).toBe("prewarm");
    expect(host.scheduleMemoryMaintenancePostTurnEvaluation("session-1", "turn-1")).toBe("maintenance");
    expect(host.publishRealtime("chat_thread_updated", "chat", {}, undefined)).toBe("published");
    expect(host.commsSend({ message: "hello" } as never)).toBe("sent");
    expect(host.ensureSessionInternalToolGrant("session-1", "tool", "reason")).toBe("grant");
    expect(host.requireExecutedToolResult("tool", {})).toBe("required");

    expect(host.buildChatOrchestrationSummary({ runId: "run-1" } as never)).toBe("summary");
    await expect(host.collectCapabilityUpgradeSuggestions({ sessionId: "session-1" } as never)).resolves.toBe(
      "capabilities",
    );
    expect(host.collectSpecialistCandidateSuggestions({ sessionId: "session-1" } as never)).toBe("specialists");
    await expect(host.createChatCompletion({ messages: [] } as never)).resolves.toBe("completion");
    await expect(host.listLlmModels?.("openai")).resolves.toEqual(["model-a"]);
    expect(host.recordDevDiagnostic({ event: "test" } as never)).toBe("diagnostic");
    expect(host.resolveFallbackTargets({}, "openai", "gpt")).toBe("fallbacks");
    await expect(host.resolvePreparedTurnOrchestration({} as never)).resolves.toBe("orchestration");

    await expect(host.agentSendChatMessage("session-1", { content: "hello" } as never)).resolves.toBe("agent-send");
    expect(host.createChatSession({ title: "Delegate" } as never)).toBe("created-session");
    expect(host.inheritDelegatedSessionToolGrants("session-1", "delegate-session")).toBe("inherited");
    expect(host.isReplayScratchSession("session-1")).toBe("scratch");
    await expect(host.requireChatTurnContext("session-1", "turn-1")).resolves.toBe("context");
    await expect(host.triggerChatSessionProactive("session-1", { source: "manual" })).resolves.toBe("proactive");
    expect(host.updateActiveLeafOrThrow("session-1", "turn-0", "turn-1")).toBe("leaf");
    expect(host.updateChatSessionPrefs("session-1", { mode: "chat" } as never)).toBe("prefs");

    expect(source.fns.buildLlmMessagesFromBranchPath).toHaveBeenCalledWith("session-1", ["turn-1"], "hello", {}, {});
    expect(source.fns.persistChatStreamChunk).toHaveBeenCalledWith({ type: "done" }, "run-1");
    expect(source.fns.resolveFallbackTargets).toHaveBeenCalledWith({}, "openai", "gpt");
  });

  it("omits optional model listing when the source host does not expose it", () => {
    const source = createSourceHost({ listLlmModels: false });
    const host = createChatTurnRuntimeHost(source.host);

    expect(host.listLlmModels).toBeUndefined();
  });
});

function createSourceHost(options: { listLlmModels?: boolean } = {}) {
  const values = {
    storage: { kind: "storage" },
    turnRuntime: { kind: "runtime" },
    config: { assistant: { durable: { enabled: true } } },
    backgroundTasks: new Set(),
    hooksService: { kind: "hooks" },
    llmService: { kind: "llm" },
  };
  const fns = {
    buildDefaultChatPersonalityOverlay: vi.fn(() => "overlay"),
    buildLlmMessagesFromBranchPath: vi.fn(async () => "messages"),
    ensureChatSessionModelDefaults: vi.fn(async () => "model-defaults"),
    ensureChatSessionRuntimeGrants: vi.fn(async () => "runtime-grants"),
    getSession: vi.fn(() => "session"),
    getSessionAutonomyPrefs: vi.fn(() => "autonomy"),
    loadChatTurnSessionState: vi.fn(() => "session-state"),
    maybeAutoTitleChatSession: vi.fn(() => "title"),
    normalizeWorkspaceId: vi.fn(() => "workspace"),
    patchSessionAutonomyPrefs: vi.fn(() => "patched-autonomy"),
    prepareAgentChatTurn: vi.fn(async () => "prepared"),
    resolveRuntimeGuidance: vi.fn(() => "guidance"),
    resolveThreadKnowledgeContext: vi.fn(() => "knowledge"),
    routeFromSession: vi.fn(() => "route"),
    beginActiveChatTurnExecution: vi.fn(() => "controller"),
    endActiveChatTurnExecution: vi.fn(() => "ended"),
    getActiveChatTurnExecution: vi.fn(() => "active"),
    markChatTurnCancelled: vi.fn(() => "cancelled"),
    withChatTurnWriteLease: vi.fn(),
    withChatTurnWriteLeaseStream: vi.fn(),
    closeActiveChatTurnStream: vi.fn(() => "closed"),
    completeActiveChatTurnStream: vi.fn(() => "completed"),
    createHydratedChatTurnTrace: vi.fn(() => "hydrated"),
    persistChatStreamChunk: vi.fn(() => "persisted"),
    registerActiveChatTurnStream: vi.fn(() => "registered"),
    streamPersistedChatTurnEvents: vi.fn(),
    withEphemeralStreamEnvelope: vi.fn(),
    beginDurableChatRun: vi.fn(() => "durable-run"),
    finalizeDurableChatRun: vi.fn(() => "finalized"),
    isFeatureEnabled: vi.fn(() => "enabled"),
    extractAndPersistLearnedMemory: vi.fn(() => "memory"),
    recordCapabilityGapFromTrace: vi.fn(() => "gap"),
    scheduleChatMemoryContextPrewarm: vi.fn(() => "prewarm"),
    scheduleMemoryMaintenancePostTurnEvaluation: vi.fn(() => "maintenance"),
    publishRealtime: vi.fn(() => "published"),
    ingestEvent: vi.fn(async () => "ingested"),
    commsSend: vi.fn(() => "sent"),
    ensureSessionInternalToolGrant: vi.fn(() => "grant"),
    requireExecutedToolResult: vi.fn(() => "required"),
    buildChatOrchestrationSummary: vi.fn(() => "summary"),
    collectCapabilityUpgradeSuggestions: vi.fn(async () => "capabilities"),
    collectSpecialistCandidateSuggestions: vi.fn(() => "specialists"),
    createChatCompletion: vi.fn(async () => "completion"),
    listLlmModels: vi.fn(),
    recordDevDiagnostic: vi.fn(() => "diagnostic"),
    resolveFallbackTargets: vi.fn(() => "fallbacks"),
    resolvePreparedTurnOrchestration: vi.fn(async () => "orchestration"),
    agentSendChatMessage: vi.fn(async () => "agent-send"),
    createChatSession: vi.fn(() => "created-session"),
    inheritDelegatedSessionToolGrants: vi.fn(() => "inherited"),
    isReplayScratchSession: vi.fn(() => "scratch"),
    requireChatTurnContext: vi.fn(async () => "context"),
    triggerChatSessionProactive: vi.fn(async () => "proactive"),
    updateActiveLeafOrThrow: vi.fn(() => "leaf"),
    updateChatSessionPrefs: vi.fn(() => "prefs"),
  };
  const host = {
    get storage() {
      return values.storage;
    },
    get turnRuntime() {
      return values.turnRuntime;
    },
    get config() {
      return values.config;
    },
    get backgroundTasks() {
      return values.backgroundTasks;
    },
    get hooksService() {
      return values.hooksService;
    },
    get llmService() {
      return values.llmService;
    },
    ...fns,
    ...(options.listLlmModels === false ? { listLlmModels: undefined } : {}),
  } as unknown as ChatTurnRuntimeHost;
  return { fns, host, values };
}

async function* asyncGenerator(value: string) {
  yield value;
}
