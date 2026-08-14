import { describe, expect, it, vi } from "vitest";
import type { ChatSessionPrefsRecord } from "@goatcitadel/contracts";
import type { SessionAutonomyPrefsRecord } from "@goatcitadel/storage";
import { prepareAgentChatTurn, type ChatTurnPrepHost, type ChatTurnSessionState } from "./chat-turn-prep-service.js";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";

const SESSION_ID = "session-heartbeat";
const TURN_ID = "turn-heartbeat";
const INTERNAL_MESSAGE_ID = "heartbeat-input-message";
const ASSISTANT_MESSAGE_ID = "heartbeat-assistant-message";
const OBJECTIVE = "Perform the exact silent heartbeat decision.";
const OCCURRENCE_ID = "heartbeat-occurrence";
const CLAIM_SHA256 = "b".repeat(64);
const DURABLE_RUN_ID = "heartbeat-run";
const HEARTBEAT_POSTURE = {
  kind: "system_heartbeat" as const,
  actorId: "system-heartbeat" as const,
  operation: "chat_system_heartbeat" as const,
  occurrenceId: OCCURRENCE_ID,
  claimSha256: CLAIM_SHA256,
  durableRunId: DURABLE_RUN_ID,
};

describe("prepareAgentChatTurn system-heartbeat posture", () => {
  it("keeps the objective ephemeral under system provenance and performs zero operator-semantic writes", async () => {
    const harness = buildHeartbeatPrepHarness();

    const prepared = await prepareAgentChatTurn(harness.host, SESSION_ID, harness.request, {
      ingestUserMessage: false,
      userMessageId: INTERNAL_MESSAGE_ID,
      turnId: TURN_ID,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
      turnAdmission: harness.admission,
      serverOnlyPosture: HEARTBEAT_POSTURE,
    });

    expect(prepared.userEventId).toBe(INTERNAL_MESSAGE_ID);
    expect(prepared.serverOnlyPosture).toEqual(HEARTBEAT_POSTURE);
    expect(Object.isFrozen(prepared.serverOnlyPosture)).toBe(true);
    expect(prepared.userMessage).toMatchObject({
      messageId: INTERNAL_MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "user",
      actorType: "system",
      actorId: "system-heartbeat",
      content: OBJECTIVE,
    });
    expect(prepared.conversationMessages.at(-1)).toEqual(prepared.userMessage);
    expect(harness.buildLlmMessagesFromBranchPath).toHaveBeenCalledWith(
      SESSION_ID,
      [],
      expect.objectContaining({
        messageId: INTERNAL_MESSAGE_ID,
        role: "user",
        actorType: "system",
        actorId: "system-heartbeat",
        content: OBJECTIVE,
      }),
      expect.objectContaining({ compactionDimension: expect.objectContaining({ persistState: false }) }),
      expect.any(Object),
    );

    expect(harness.ingestEvent).not.toHaveBeenCalled();
    expect(harness.ensureChatSessionRuntimeGrants).not.toHaveBeenCalled();
    expect(harness.maybeAutoTitleChatSession).not.toHaveBeenCalled();
    expect(harness.chatSessionPrefsEnsure).not.toHaveBeenCalled();
    expect(harness.chatSessionPrefsPatch).not.toHaveBeenCalled();
    expect(harness.patchSessionAutonomyPrefs).not.toHaveBeenCalled();
    expect(harness.ensureChatSessionModelDefaults).not.toHaveBeenCalled();
    expect(harness.getSessionAutonomyPrefs).not.toHaveBeenCalled();
    expect(harness.incrementGoalTurnsUsed).not.toHaveBeenCalled();
    expect(harness.patchMetaWithRevision).not.toHaveBeenCalled();
    expect(harness.resolvePendingCompactionBreakerForceAction).not.toHaveBeenCalled();
    expect(harness.recordRuntimeDecision).not.toHaveBeenCalled();
    expect(harness.runImmediateTransaction).not.toHaveBeenCalled();
  });

  it("fails closed if raw storage substituted a persisted message at the internal input identity", async () => {
    const persisted = {
      messageId: INTERNAL_MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "user" as const,
      actorType: "user" as const,
      actorId: "operator",
      content: OBJECTIVE,
      timestamp: "2026-07-15T00:00:00.000Z",
    };
    const harness = buildHeartbeatPrepHarness({
      sessionState: {
        traces: [],
        tracesById: new Map(),
        messages: [persisted],
        messagesById: new Map([[persisted.messageId, persisted]]),
        childrenByTurnId: new Map(),
        turnLineageById: new Map(),
      },
    });

    await expect(
      prepareAgentChatTurn(harness.host, SESSION_ID, harness.request, {
        ingestUserMessage: false,
        userMessageId: INTERNAL_MESSAGE_ID,
        turnId: TURN_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
        turnAdmission: harness.admission,
        serverOnlyPosture: HEARTBEAT_POSTURE,
      }),
    ).rejects.toThrow(/conflicts with a persisted Chat message/u);
    expect(harness.ingestEvent).not.toHaveBeenCalled();
    expect(harness.runImmediateTransaction).not.toHaveBeenCalled();
  });

  it("rejects the posture unless the admission actor and auth source are exact", async () => {
    const harness = buildHeartbeatPrepHarness();
    const wrongActor = {
      ...harness.admission,
      requestActor: { actorKind: "system" as const, actorId: "system-cron" },
    };

    await expect(
      prepareAgentChatTurn(harness.host, SESSION_ID, harness.request, {
        ingestUserMessage: false,
        userMessageId: INTERNAL_MESSAGE_ID,
        turnId: TURN_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
        turnAdmission: wrongActor,
        serverOnlyPosture: HEARTBEAT_POSTURE,
      }),
    ).rejects.toThrow(/exact server-only admission posture/u);
    expect(harness.ensureChatSessionRuntimeGrants).not.toHaveBeenCalled();
  });

  // HX-408 M1-review mandate: the heartbeat posture gate treats non-`none`
  // sources as authenticated. Pin that an admitted mesh node's machine
  // identity can never satisfy the server-only heartbeat admission posture.
  it("rejects a mesh_node actor source at the server-only heartbeat posture gate", async () => {
    const harness = buildHeartbeatPrepHarness();
    const meshRequest = {
      ...harness.request,
      authActorId: "node-1",
      authActorSource: "mesh_node" as const,
    };

    await expect(
      prepareAgentChatTurn(harness.host, SESSION_ID, meshRequest, {
        ingestUserMessage: false,
        userMessageId: INTERNAL_MESSAGE_ID,
        turnId: TURN_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
        turnAdmission: harness.admission,
        serverOnlyPosture: HEARTBEAT_POSTURE,
      }),
    ).rejects.toThrow(/exact server-only admission posture/u);
    expect(harness.ensureChatSessionRuntimeGrants).not.toHaveBeenCalled();
    expect(harness.ingestEvent).not.toHaveBeenCalled();
  });

  it("rejects a generic system-heartbeat actor admission without the exact occurrence discriminator", async () => {
    const harness = buildHeartbeatPrepHarness();
    const genericSystemAdmission = { ...harness.admission, systemHeartbeatOccurrence: undefined };

    await expect(
      prepareAgentChatTurn(harness.host, SESSION_ID, harness.request, {
        ingestUserMessage: false,
        userMessageId: INTERNAL_MESSAGE_ID,
        turnId: TURN_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
        turnAdmission: genericSystemAdmission,
        serverOnlyPosture: HEARTBEAT_POSTURE,
      }),
    ).rejects.toThrow(/exact server-only admission posture/u);
    expect(harness.ensureChatSessionRuntimeGrants).not.toHaveBeenCalled();
  });
});

function buildHeartbeatPrepHarness(options: { sessionState?: ChatTurnSessionState } = {}) {
  const prefs: ChatSessionPrefsRecord = {
    sessionId: SESSION_ID,
    mode: "chat",
    planningMode: "off",
    providerId: "openai",
    model: "gpt-5.4-mini",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    speedMode: "standard",
    subagentPolicy: "off",
    toolAutonomy: "manual",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  } as ChatSessionPrefsRecord;
  const autonomy: SessionAutonomyPrefsRecord = {
    sessionId: SESSION_ID,
    proactiveMode: "off",
    maxActionsPerHour: 6,
    maxActionsPerTurn: 2,
    cooldownSeconds: 0,
    retrievalMode: "standard",
    reflectionMode: "off",
    heartbeatEnabled: true,
    heartbeatIntervalSeconds: 3600,
    activeHours: { start: 0, end: 0 },
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
  const request = {
    content: OBJECTIVE,
    operatorId: "system-heartbeat",
    authActorId: "system-heartbeat",
    authActorSource: "none" as const,
    permissionProfileId: "heartbeat-restricted",
  };
  const admission: ActiveTurnAdmission = {
    identity: {
      admissionId: "heartbeat-admission",
      sessionIncarnationId: "heartbeat-incarnation",
      workspaceId: "default",
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      aggregateRevision: 1,
      controllerGeneration: 1,
      materialSha256: "a".repeat(64),
    },
    admittedRequest: request,
    requestActor: { actorKind: "system", actorId: "system-heartbeat" },
    systemHeartbeatOccurrence: {
      kind: "system_heartbeat_occurrence",
      operation: "chat_system_heartbeat",
      occurrenceId: OCCURRENCE_ID,
      correlationId: OCCURRENCE_ID,
      claimSha256: CLAIM_SHA256,
      durableRunId: DURABLE_RUN_ID,
    },
    requestClaim: { runtimeOwnerId: "heartbeat-runtime", leaseRevision: 1 },
  };
  const sessionState: ChatTurnSessionState = options.sessionState ?? {
    traces: [],
    tracesById: new Map(),
    messages: [],
    messagesById: new Map(),
    childrenByTurnId: new Map(),
    turnLineageById: new Map(),
  };
  const ingestEvent = vi.fn(async () => undefined);
  const ensureChatSessionRuntimeGrants = vi.fn();
  const maybeAutoTitleChatSession = vi.fn();
  const chatSessionPrefsEnsure = vi.fn(() => prefs);
  const chatSessionPrefsPatch = vi.fn(() => prefs);
  const patchSessionAutonomyPrefs = vi.fn(() => autonomy);
  const ensureChatSessionModelDefaults = vi.fn(() => prefs);
  const getSessionAutonomyPrefs = vi.fn(() => autonomy);
  const incrementGoalTurnsUsed = vi.fn(() => 3);
  const patchMetaWithRevision = vi.fn();
  const resolvePendingCompactionBreakerForceAction = vi.fn(() => ({ actionId: "force", actorHash: "hash" }));
  const recordRuntimeDecision = vi.fn();
  const runImmediateTransaction = vi.fn((callback: () => unknown) => callback());
  const buildLlmMessagesFromBranchPath = vi.fn(async (_sessionId, _path, currentMessage) => [
    { role: "user" as const, content: currentMessage?.content ?? "" },
  ]);
  const host = {
    storage: {
      chatSessionMeta: {
        get: vi.fn(() => ({
          sessionId: SESSION_ID,
          workspaceId: "default",
          lifecycleStatus: "active",
          pinnedGoal: "Keep the operator goal unchanged",
          goalTurnBudget: 4,
          goalTurnsUsed: 2,
          revision: 7,
        })),
        incrementGoalTurnsUsed,
        patchWithRevision: patchMetaWithRevision,
      },
      chatAttachments: { listByIds: vi.fn(() => []) },
      chatSessionPrefs: {
        get: vi.fn(() => prefs),
        ensure: chatSessionPrefsEnsure,
        patch: chatSessionPrefsPatch,
      },
      sessionAutonomyPrefs: { get: vi.fn(() => autonomy) },
      chatSessionProjects: { get: vi.fn(() => undefined) },
      chatFanoutInvocations: { listActive: vi.fn(() => []) },
      chatSideChats: { getByChildSession: vi.fn(() => undefined) },
      chatSpecialistCandidates: { listAutoRoutable: vi.fn(() => []) },
      systemSettings: { get: vi.fn(() => undefined) },
      workspaces: { find: vi.fn(() => ({ citadelId: "personal" })) },
      runImmediateTransaction,
    },
    assertTurnAdmissionWrite: vi.fn(),
    llmService: {
      getRuntimeConfig: vi.fn(() => ({ providers: [] })),
      getModelContextWindow: vi.fn(() => 128_000),
    },
    getSession: vi.fn(() => ({ sessionId: SESSION_ID, channel: "mission", account: "operator" })),
    ensureChatSessionRuntimeGrants,
    maybeAutoTitleChatSession,
    normalizeWorkspaceId: vi.fn((workspaceId?: string) => workspaceId ?? "default"),
    routeFromSession: vi.fn(() => ({ channel: "mission", account: "operator" })),
    ingestEvent,
    patchSessionAutonomyPrefs,
    ensureChatSessionModelDefaults,
    getSessionAutonomyPrefs,
    buildDefaultChatPersonalityOverlay: vi.fn(() => undefined),
    resolveRuntimeGuidance: vi.fn(async () => ({
      workspaceId: "default",
      globalFilesUsed: [],
      workspaceFilesUsed: [],
      truncated: false,
    })),
    resolveThreadKnowledgeContext: vi.fn(async () => ({ citations: [], attachments: [] })),
    loadChatTurnSessionState: vi.fn(async () => sessionState),
    buildLlmMessagesFromBranchPath,
    createChatCompletion: vi.fn(),
    recordRuntimeDecision,
    isFeatureEnabled: vi.fn(() => true),
    resolvePendingCompactionBreakerForceAction,
  } as unknown as ChatTurnPrepHost;
  return {
    host,
    request,
    admission,
    ingestEvent,
    ensureChatSessionRuntimeGrants,
    maybeAutoTitleChatSession,
    chatSessionPrefsEnsure,
    chatSessionPrefsPatch,
    patchSessionAutonomyPrefs,
    ensureChatSessionModelDefaults,
    getSessionAutonomyPrefs,
    incrementGoalTurnsUsed,
    patchMetaWithRevision,
    resolvePendingCompactionBreakerForceAction,
    recordRuntimeDecision,
    runImmediateTransaction,
    buildLlmMessagesFromBranchPath,
  };
}
