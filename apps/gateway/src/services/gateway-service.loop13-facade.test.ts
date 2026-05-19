import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

vi.mock("./gateway-route-service-composition.js", () => ({
  composeGatewayRouteServices: vi.fn((port) => ({ composed: true, port })),
  createChatThreadKnowledgeDependenciesForGateway: vi.fn((port) => ({ kind: "thread-knowledge", port })),
  createCommsHostForGateway: vi.fn((port, integrationChannel) => ({ kind: "comms", port, integrationChannel })),
  createGatewayRouteCompositionPort: vi.fn((gateway, deps) => ({ kind: "route-port", gateway, deps })),
  createIntegrationChannelServiceForGateway: vi.fn((port, diagnostics) => ({ kind: "channel", port, diagnostics })),
  createIntegrationDiagnosticsServiceForGateway: vi.fn((port) => ({ kind: "diagnostics", port })),
  createSettingsAuthRuntimeDependenciesForGateway: vi.fn((port) => ({ kind: "settings-auth", port })),
  createSettingsRuntimeDependenciesForGateway: vi.fn((port) => ({ kind: "settings", port })),
}));

vi.mock("./chat-session-service.js", () => ({
  assignChatSessionProject: vi.fn((_deps, sessionId: string, projectId?: string) => ({ sessionId, projectId })),
  archiveChatSession: vi.fn((_deps, sessionId: string) => ({ sessionId, archived: true })),
  createChatSession: vi.fn((_deps, input = {}) => ({ sessionId: "created-session", input })),
  getChatSessionPrefs: vi.fn((_deps, sessionId: string) => ({ sessionId, mode: "chat" })),
  listChatSessions: vi.fn((_deps, query = {}) => [{ sessionId: "session-listed", query }]),
  maybeAutoTitleChatSession: vi.fn(),
  setChatSessionBinding: vi.fn((_deps, input) => ({ bindingId: "binding-1", ...input })),
  updateChatSession: vi.fn((_deps, sessionId: string, input) => ({ sessionId, ...input })),
  updateChatSessionPrefs: vi.fn((_deps, sessionId: string, input) => ({ sessionId, ...input })),
}));

vi.mock("./chat-command-service.js", () => ({
  parseChatCommand: vi.fn(async (_gateway, sessionId: string, commandText: string) => ({
    ok: true,
    sessionId,
    command: commandText,
    args: [],
    message: "parsed",
  })),
}));

vi.mock("./chat-turn-prep-service.js", () => ({
  applyApprovedSpecialistsToPlan: vi.fn((_gateway, _prepared, plan) => ({ ...plan, specialistsApplied: true })),
  buildChatOrchestrationSummary: vi.fn((input) => ({ ...input, summaryBuilt: true })),
  generatePreparedExecutionPlanDraft: vi.fn(async (_gateway, _prepared, _routerInput, templatePlan) => ({
    templatePlan,
    draft: true,
  })),
  prepareAgentChatTurn: vi.fn(async (_gateway, sessionId: string, input, options) => ({
    sessionId,
    input,
    options,
    turnId: "turn-prepared",
  })),
  resolvePreparedTurnOrchestration: vi.fn(async (_gateway, prepared) => ({
    prepared,
    resolved: true,
  })),
}));

vi.mock("./chat-durable-run-service.js", () => ({
  beginDurableChatRun: vi.fn((_host, prepared, _input, threadEventType) => ({
    runId: `durable-${prepared.turnId}`,
    threadEventType,
  })),
  finalizeDurableChatRun: vi.fn(),
}));

vi.mock("./llm-completion-service.js", () => ({
  createChatCompletion: vi.fn(async (_gateway, request) => ({ id: "completion-1", request })),
  createChatCompletionStream: vi.fn(async function* (_gateway, request) {
    yield { type: "delta", request };
    yield { type: "done" };
  }),
}));

vi.mock("./mcp-server-admin-service.js", () => ({
  connectMcpServer: vi.fn(async (_gateway, serverId: string) => ({ serverId, status: "connected" })),
  createMcpServer: vi.fn((_gateway, input) => ({ serverId: "server-created", ...input })),
  disconnectMcpServer: vi.fn((_gateway, serverId: string) => ({ serverId, status: "disconnected" })),
}));

vi.mock("./settings-auth-service.js", () => ({
  getAuthRuntimeSettings: vi.fn((deps) => ({ mode: "token", deps, plan: { required: true } })),
  getSettings: vi.fn((deps) => ({ runtime: "settings", deps })),
  updateAuthSettings: vi.fn((deps, input) => ({ mode: input.mode ?? "token", deps, input })),
  updateSettings: vi.fn((deps, input) => ({ runtime: "updated", deps, input })),
  validateCompanionAccessToken: vi.fn((_deps, token: string) =>
    token === "companion-token" ? { sessionId: "companion-session", deviceId: "device-1" } : undefined,
  ),
  validateDeviceAccessToken: vi.fn((_deps, token: string) =>
    token === "device-token" ? { actorId: "operator", deviceId: "device-1", grantId: "grant-1" } : undefined,
  ),
  verifyCompanionRequestSignature: vi.fn(),
}));

vi.mock("./onboarding-state-service.js", () => ({
  getOnboardingStartupState: vi.fn((gateway) => ({ ready: true, gateway })),
}));

vi.mock("./comms-service.js", () => ({
  commsCalendarCreate: vi.fn(async (_host, input) => ({ action: "calendar.create", input })),
  commsCalendarList: vi.fn(async (_host, input) => ({ action: "calendar.list", input })),
  commsGmailRead: vi.fn(async (_host, input) => ({ action: "gmail.read", input })),
  commsGmailSend: vi.fn(async (_host, input) => ({ action: "gmail.send", input })),
  commsReact: vi.fn(async (_host, input) => ({ action: "react", input })),
  commsSend: vi.fn(async (_host, input) => ({ status: "sent", providerMessageId: input.message ?? "sent" })),
  commsTyping: vi.fn(async (_host, input) => ({ typing: true, input })),
  commsUnsend: vi.fn(async (_host, input) => ({ action: "unsend", input })),
}));

vi.mock("./discord-runtime-bridge-service.js", () => ({
  resolveDiscordInboundRoute: vi.fn((_gateway, input) => ({
    peer: input.peer ?? input.target,
    room: input.room,
    threadId: input.threadId,
  })),
  startNewDiscordRouteSession: vi.fn((_gateway, input) => ({ sessionId: "discord-session", ...input })),
}));

vi.mock("./chat-thread-knowledge-service.js", () => ({
  resolveThreadKnowledgeContext: vi.fn(async (deps, sessionId: string, query: string) => ({
    deps,
    sessionId,
    query,
  })),
}));

vi.mock("./chat-turn-trace-hydration.js", () => ({
  buildChatTurnChildrenMap: vi.fn(() => new Map([["turn-1", ["turn-2"]]])),
  createHydratedChatTurnTrace: vi.fn((_gateway, turnId: string, trace) => ({ ...trace, turnId, hydrated: true })),
  listHydratedChatTurnTraces: vi.fn(() => [{ turnId: "turn-1" }, { turnId: "turn-2", parentTurnId: "turn-1" }]),
  resolveChatActiveLeafTurnId: vi.fn(() => "turn-2"),
}));

import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { ChatTurnExecutionRegistry, ChatTurnWriteConflictError } from "./chat-turn-execution-registry.js";
import { GatewayService } from "./gateway-service.js";
import * as chatCommandService from "./chat-command-service.js";
import * as chatDurableRunService from "./chat-durable-run-service.js";
import * as chatSessionService from "./chat-session-service.js";
import * as chatThreadKnowledgeService from "./chat-thread-knowledge-service.js";
import * as chatTurnPrepService from "./chat-turn-prep-service.js";
import * as commsService from "./comms-service.js";
import * as discordRuntimeBridgeService from "./discord-runtime-bridge-service.js";
import * as llmCompletionService from "./llm-completion-service.js";
import * as mcpServerAdminService from "./mcp-server-admin-service.js";
import * as onboardingStateService from "./onboarding-state-service.js";
import * as settingsAuthService from "./settings-auth-service.js";

function createGatewayHarness(overrides: Record<string, unknown> = {}) {
  const systemSettingsStore = new Map<string, unknown>();
  const systemSettings = {
    get: vi.fn((key: string) => (systemSettingsStore.has(key) ? { value: systemSettingsStore.get(key) } : undefined)),
    set: vi.fn((key: string, value: unknown) => {
      systemSettingsStore.set(key, value);
    }),
  };
  const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
  Object.assign(gateway, {
    backgroundTasks: new Set<Promise<unknown>>(),
    chatTurnExecutionRegistry: new ChatTurnExecutionRegistry(),
    closing: false,
    config: {
      rootDir: "F:/code/personal-ai",
      assistant: {
        deploymentProfile: "local_dev",
        defaultToolProfile: "minimal",
        durable: { enabled: true },
        features: {
          durableKernelV1Enabled: true,
          replayOverridesV1Enabled: false,
          memoryLifecycleAdminV1Enabled: false,
          memoryLifecycleAutoForgetEnabled: true,
          memoryMaintenanceV1Enabled: false,
          connectorDiagnosticsV1Enabled: false,
          computerUseGuardrailsV1Enabled: true,
          bankrBuiltinEnabled: false,
          cronReviewQueueV1Enabled: false,
          replayRegressionV1Enabled: false,
          codeModeV1Enabled: false,
          improvementLedgerV1Enabled: false,
          improvementActivationV1Enabled: false,
        },
        mesh: { nodeId: "node-1" },
        web: {
          firecrawl: {
            enabled: false,
            baseUrl: "http://127.0.0.1:3002",
            timeoutMs: 20_000,
            defaultReadBackend: "native",
            fallbackToNative: true,
          },
        },
        workspaceDir: "workspace",
      },
      toolPolicy: {
        sandbox: {
          networkAllowlist: ["api.example.test", "127.0.0.1"],
          readOnlyRoots: [],
          writeJailRoots: [],
        },
        tools: {
          approvalMode: "approve_risky",
          profile: "minimal",
        },
      },
    },
    operatorSummaryCache: { invalidate: vi.fn() },
    routeCompositionPort: { kind: "existing-port" },
    storage: {
      chatGeneratedArtifacts: { listBySession: vi.fn(() => []) },
      chatMessages: { list: vi.fn(() => []), upsertMany: vi.fn() },
      chatProjects: { find: vi.fn(() => ({ projectId: "project-1", workspaceId: "workspace-a" })) },
      chatSessionBranchState: {
        get: vi.fn(() => ({ activeLeafTurnId: "turn-current" })),
        setActiveLeafIfCurrent: vi.fn(() => true),
      },
      chatSessionMeta: {
        ensure: vi.fn((_sessionId: string, _title?: string, workspaceId = "default") => ({ workspaceId })),
        get: vi.fn(() => ({ workspaceId: "workspace-a", title: "[Replay scratch] prior run" })),
      },
      chatSessionPrefs: {
        get: vi.fn(() => ({ mode: "cowork" })),
        patch: vi.fn((_sessionId: string, patch: Record<string, unknown>) => ({ sessionId: "session-1", ...patch })),
      },
      chatSessionProjects: { get: vi.fn(() => ({ projectId: "project-1" })) },
      chatStreamEvents: { append: vi.fn(), getLatestSequence: vi.fn(() => 0), purgeBefore: vi.fn() },
      chatTurnTraces: { get: vi.fn(), listBySession: vi.fn(() => []) },
      commsDeliveries: { list: vi.fn(() => []) },
      durableRuns: {
        getRun: vi.fn((runId: string) => ({ runId, status: "running", metadata: {}, version: 1 })),
        listCheckpoints: vi.fn(() => []),
        updateRun: vi.fn((input: Record<string, unknown>) => ({ runId: input.runId, ...input })),
      },
      gatewaySql: { prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(), run: vi.fn() })) },
      integrationConnections: {
        get: vi.fn(() => ({ connectionId: "conn-1", key: "telegram" })),
        list: vi.fn(() => []),
      },
      orchestration: {
        createCheckpoint: vi.fn((input: Record<string, unknown>) => ({ checkpointId: "cp-1", ...input })),
      },
      permissionProfiles: {
        resolveContext: vi.fn((input: Record<string, unknown>) => ({
          permissionProfile: {
            profileId: input.profileId ?? "safe",
            name: "Safe",
            description: "Ask before tool actions.",
            builtIn: true,
            archived: false,
            toolApprovalMode: "approve_all",
            toolProfile: "minimal",
            readAccessMode: "approval_required",
            createdAt: "2026-05-17T00:00:00.000Z",
            updatedAt: "2026-05-17T00:00:00.000Z",
          },
        })),
      },
      remoteActionTokens: {
        findByTokenHash: vi.fn(),
        get: vi.fn(),
        updateState: vi.fn((tokenId: string, state: string, patch?: Record<string, unknown>) => ({
          tokenId,
          state,
          ...patch,
        })),
      },
      sessions: {
        getBySessionId: vi.fn((sessionId: string) => ({ sessionId, lastActivityAt: new Date().toISOString() })),
      },
      sessionAutonomyPrefs: {
        ensure: vi.fn((sessionId: string) => ({
          sessionId,
          proactiveMode: "off",
          maxActionsPerHour: 2,
          maxActionsPerTurn: 1,
          cooldownSeconds: 30,
          retrievalMode: "layered",
          reflectionMode: "off",
        })),
        patch: vi.fn((sessionId: string, input: Record<string, unknown>) => ({ sessionId, ...input })),
      },
      systemSettings,
      transcripts: { read: vi.fn(async () => []) },
    },
  });
  Object.assign(gateway, overrides);
  return { gateway, systemSettings, systemSettingsStore };
}

async function collectStream(stream: AsyncGenerator<Record<string, unknown>>) {
  const chunks: Record<string, unknown>[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GatewayService Loop 13 chat facade forwarding", () => {
  it("forwards chat session and command calls with the route-facing dependency host", async () => {
    const { gateway } = createGatewayHarness({
      clearChatTurnWriteLease: vi.fn(),
      ensureChatSessionModelDefaults: vi.fn((_sessionId: string, prefs: unknown) => prefs),
      ensureChatSessionRuntimeGrants: vi.fn(),
      hydrateChatPrefsWithAutonomy: vi.fn((_sessionId: string, prefs: unknown) => ({ hydrated: true, prefs })),
      normalizeWorkspaceId: vi.fn((workspaceId?: string) => workspaceId?.trim() || "default"),
      patchSessionAutonomyPrefs: vi.fn(),
      publishRealtime: vi.fn(),
      removeChatSessionStoredFile: vi.fn(async () => undefined),
      requireChatSession: vi.fn((sessionId: string) => ({ sessionId, required: true })),
    });

    expect(GatewayService.prototype.createChatSession.call(gateway, { title: "New chat" })).toMatchObject({
      sessionId: "created-session",
    });
    expect(GatewayService.prototype.updateChatSession.call(gateway, "session-1", { title: "Renamed" })).toMatchObject({
      sessionId: "session-1",
      title: "Renamed",
    });
    GatewayService.prototype.maybeAutoTitleChatSession.call(gateway, "session-1", "hello");
    expect(GatewayService.prototype.assignChatSessionProject.call(gateway, "session-1", "project-1")).toMatchObject({
      sessionId: "session-1",
      projectId: "project-1",
    });
    expect(
      GatewayService.prototype.setChatSessionBinding.call(gateway, {
        sessionId: "session-1",
        transport: "integration",
        connectionId: "conn-1",
        target: "room-1",
      }),
    ).toMatchObject({ bindingId: "binding-1", sessionId: "session-1" });
    expect(GatewayService.prototype.getChatSessionPrefs.call(gateway, "session-1")).toMatchObject({
      sessionId: "session-1",
    });
    expect(
      GatewayService.prototype.updateChatSessionPrefs.call(gateway, "session-1", { mode: "cowork" } as never),
    ).toMatchObject({ sessionId: "session-1", mode: "cowork" });

    await expect(GatewayService.prototype.parseChatCommand.call(gateway, "session-1", "/dream")).resolves.toMatchObject(
      {
        ok: true,
        command: "/dream",
      },
    );

    const deps = vi.mocked(chatSessionService.createChatSession).mock.calls[0]?.[0] as Record<string, any>;
    expect(deps.storage).toBe(gateway.storage);
    expect(deps.normalizeWorkspaceId(" team ")).toBe("team");
    expect(deps.getSession("session-2")).toMatchObject({ sessionId: "session-2" });
    expect(deps.requireChatSession("session-2")).toMatchObject({ required: true });
    deps.ensureChatSessionRuntimeGrants("session-2");
    deps.publishRealtime("chat_thread_updated", "chat", { ok: true });
    deps.clearChatTurnWriteLease("session-2");
    await deps.removeChatSessionStoredFile("memory/file.md");
    expect(gateway.ensureChatSessionRuntimeGrants).toHaveBeenCalledWith("session-2");
    expect(gateway.publishRealtime).toHaveBeenCalledWith("chat_thread_updated", "chat", { ok: true });
    expect(chatSessionService.maybeAutoTitleChatSession).toHaveBeenCalledWith(expect.any(Object), "session-1", "hello");
    expect(chatCommandService.parseChatCommand).toHaveBeenCalledWith(gateway, "session-1", "/dream");
  });

  it("forwards chat turn preparation, leasing, durable chat, and completion adapters", async () => {
    const { gateway } = createGatewayHarness({
      createDurableRun: vi.fn((input: Record<string, unknown>) => ({ runId: "run-created", input })),
      durableRunService: { requestRunProcessing: vi.fn() },
      patchDurableTraceIfPresent: vi.fn(),
      persistChatStreamChunk: vi.fn(),
      recordDurableTimelineEvent: vi.fn(),
      storage: {
        ...createGatewayHarness().gateway.storage,
        chatToolArtifacts: {},
        chatToolRuns: {},
        durableRuns: { getRun: vi.fn(), updateRun: vi.fn() },
      },
      chatTurnRuntime: { agentSendChatMessage: vi.fn(async () => ({ turnId: "turn-runtime" })) },
    });

    await expect(
      GatewayService.prototype.prepareAgentChatTurn.call(gateway, "session-1", { content: "hello" } as never, {
        branchKind: "append",
      }),
    ).resolves.toMatchObject({ sessionId: "session-1", turnId: "turn-prepared" });
    await expect(
      GatewayService.prototype.resolvePreparedTurnOrchestration.call(gateway, { turnId: "turn-prepared" } as never),
    ).resolves.toMatchObject({ resolved: true });
    expect(
      GatewayService.prototype.buildChatOrchestrationSummary.call(gateway, {
        runId: "run-1",
        objective: "ship",
        modePolicy: "cowork",
        routeDecision: {} as never,
        stepResults: [],
      }),
    ).toMatchObject({ runId: "run-1", summaryBuilt: true });
    await expect(
      GatewayService.prototype.agentSendChatMessage.call(gateway, "session-1", { content: "hello" } as never),
    ).resolves.toEqual({ turnId: "turn-runtime" });

    await expect(
      GatewayService.prototype.withChatTurnWriteLease.call(gateway, "session-1", "append", async () => "leased"),
    ).resolves.toBe("leased");
    const leaseChunks = [];
    async function* source() {
      yield { type: "delta", sessionId: "session-1", turnId: "turn-1", delta: "one" };
    }
    for await (const chunk of GatewayService.prototype.withChatTurnWriteLeaseStream.call(
      gateway,
      "session-1",
      "stream",
      source,
    )) {
      leaseChunks.push(chunk);
    }
    expect(leaseChunks).toHaveLength(1);
    GatewayService.prototype.clearChatTurnWriteLease.call(gateway, "session-1");
    expect(
      GatewayService.prototype.isChatTurnWriteConflict.call(gateway, new ChatTurnWriteConflictError("conflict")),
    ).toBe(true);
    expect(GatewayService.prototype.isChatTurnWriteConflict.call(gateway, new Error("other"))).toBe(false);

    expect(
      GatewayService.prototype.beginDurableChatRun.call(
        gateway,
        {
          session: { sessionId: "session-1" },
          turnId: "turn-1",
          userEventId: "user-1",
          assistantMessageId: "assistant-1",
          branchKind: "append",
          userMessage: {},
          content: "hello",
        } as never,
        { content: "hello" } as never,
        "chat_thread_turn_appended",
      ),
    ).toMatchObject({ runId: "durable-turn-1" });
    GatewayService.prototype.finalizeDurableChatRun.call(
      gateway,
      "run-1",
      { turnId: "turn-1" } as never,
      {
        turnId: "turn-1",
      } as never,
    );
    expect(chatDurableRunService.finalizeDurableChatRun).toHaveBeenCalled();

    await expect(
      GatewayService.prototype.createChatCompletion.call(gateway, { messages: [] } as never),
    ).resolves.toMatchObject({ id: "completion-1" });
    await expect(
      collectStream(GatewayService.prototype.createChatCompletionStream.call(gateway, { messages: [] } as never)),
    ).resolves.toMatchObject([{ type: "delta" }, { type: "done" }]);
    expect(chatTurnPrepService.prepareAgentChatTurn).toHaveBeenCalledWith(
      gateway,
      "session-1",
      { content: "hello" },
      { branchKind: "append" },
    );
    expect(llmCompletionService.createChatCompletion).toHaveBeenCalledWith(gateway, { messages: [] });
  });
});

describe("GatewayService Loop 13 approval, tool, and durable facades", () => {
  it("forwards approval and tool calls while preserving workspace defaults", async () => {
    const { gateway } = createGatewayHarness({
      approvalEffectsService: { enqueueResolutionEffects: vi.fn(() => [{ effectId: "effect-1" }]) },
      approvalRuntime: {
        createApproval: vi.fn(async (input: unknown) => ({ approvalId: "approval-1", input })),
        createApprovalRemoteActionToken: vi.fn((approvalId: string, input: unknown) => ({ approvalId, input })),
        createToolGrant: vi.fn((input: unknown) => ({ grantId: "grant-1", input })),
        getApprovalReplay: vi.fn((approvalId: string, replayedBy: string) => ({ approvalId, replayedBy })),
        listApprovals: vi.fn((status?: string, limit?: number) => [{ status, limit }]),
        listToolGrants: vi.fn((scope?: string, scopeRef?: string, limit?: number) => [{ scope, scopeRef, limit }]),
        resolveApproval: vi.fn(async (approvalId: string, input: unknown) => ({ approvalId, input })),
        resolveApprovalWithRemoteToken: vi.fn(async (input: unknown) => ({ input, remote: true })),
        resolveApprovalWithRemoteTokenId: vi.fn(async (input: unknown) => ({ input, remoteId: true })),
        resolveApprovalsBulk: vi.fn(async (input: unknown) => ({ input, resolved: 2 })),
        revokeToolGrant: vi.fn(
          (grantId: string, revokedBy: string) => grantId === "grant-1" && revokedBy === "operator-test",
        ),
      },
      approvalWaitRunService: {
        buildApprovalLinkage: vi.fn((linkage: unknown) => ({ linkage })),
        buildApprovalRealtimeLinks: vi.fn((approval: { approvalId: string }) => ({ approvalId: approval.approvalId })),
        ensureApprovalWaitDurableRun: vi.fn((approval: { approvalId: string }) => ({
          runId: `wait-${approval.approvalId}`,
        })),
        primeApprovalLifecycle: vi.fn((approvalId: string, linkage: unknown) => ({ approvalId, linkage })),
      },
      chatProactiveService: { findDurableRunIdsForApproval: vi.fn((approvalId: string) => [`run-${approvalId}`]) },
      durableRunService: {
        computeDurableRetryDelayMs: vi.fn((_run: unknown, attemptNo: number) => attemptNo * 1000),
        recordDurableTimelineEvent: vi.fn((runId: string, eventType: string) => ({ runId, eventType })),
        requestRunProcessing: vi.fn(),
      },
      improvementService: { recordDurableRunCompletionSignal: vi.fn() },
      policyEngine: {
        evaluateAccess: vi.fn((input: Record<string, unknown>) => ({ allowed: true, input })),
        listCatalog: vi.fn(() => [{ toolName: "browser.search" }]),
      },
      toolInvocationCoordinator: {
        invokeTool: vi.fn(async (request: unknown) => ({ outcome: "executed", result: { request } })),
      },
    });

    await expect(
      GatewayService.prototype.invokeTool.call(gateway, { toolName: "browser.search" } as never),
    ).resolves.toMatchObject({ outcome: "executed" });
    expect(GatewayService.prototype.listToolCatalog.call(gateway)).toEqual([{ toolName: "browser.search" }]);
    expect(
      GatewayService.prototype.evaluateToolAccess.call(gateway, { sessionId: "session-1" } as never),
    ).toMatchObject({
      allowed: true,
      input: expect.objectContaining({ workspaceId: "workspace-a" }),
    });
    expect(GatewayService.prototype.listToolGrants.call(gateway, "session", "session-1", 5)).toEqual([
      { scope: "session", scopeRef: "session-1", limit: 5 },
    ]);
    expect(
      GatewayService.prototype.createToolGrant.call(gateway, { toolPattern: "browser.search" } as never),
    ).toMatchObject({
      grantId: "grant-1",
    });
    expect(GatewayService.prototype.revokeToolGrant.call(gateway, "grant-1", "operator-test")).toBe(true);
    await expect(
      GatewayService.prototype.createApproval.call(gateway, { kind: "tool" } as never),
    ).resolves.toMatchObject({
      approvalId: "approval-1",
    });
    expect(
      GatewayService.prototype.createApprovalRemoteActionToken.call(gateway, "approval-1", {
        connectorId: "connector-1",
      }),
    ).toMatchObject({ approvalId: "approval-1" });
    await expect(
      GatewayService.prototype.resolveApprovalWithRemoteToken.call(gateway, {
        token: "token",
        decision: "approved",
      } as never),
    ).resolves.toMatchObject({ remote: true });
    await expect(
      GatewayService.prototype.resolveApprovalWithRemoteTokenId.call(gateway, {
        tokenId: "token-id",
        decision: "approved",
      } as never),
    ).resolves.toMatchObject({ remoteId: true });
    expect(GatewayService.prototype.listApprovals.call(gateway, "pending", 10)).toEqual([
      { status: "pending", limit: 10 },
    ]);
    await expect(
      GatewayService.prototype.resolveApprovalsBulk.call(gateway, { decision: "approved" } as never),
    ).resolves.toMatchObject({ resolved: 2 });
    expect(GatewayService.prototype.getApprovalReplay.call(gateway, "approval-1", "tester")).toEqual({
      approvalId: "approval-1",
      replayedBy: "tester",
    });
    await expect(
      GatewayService.prototype.resolveApproval.call(gateway, "approval-1", { decision: "approved" } as never),
    ).resolves.toMatchObject({ approvalId: "approval-1" });
    expect(GatewayService.prototype.findProactiveDurableRunIdsForApproval.call(gateway, "approval-1")).toEqual([
      "run-approval-1",
    ]);
    expect(
      GatewayService.prototype.ensureApprovalWaitDurableRun.call(gateway, { approvalId: "approval-1" } as never),
    ).toMatchObject({ runId: "wait-approval-1" });
    expect(GatewayService.prototype.buildApprovalLinkage.call(gateway, { sessionId: "session-1" } as never)).toEqual({
      linkage: { sessionId: "session-1" },
    });
    expect(
      GatewayService.prototype.buildApprovalRealtimeLinks.call(gateway, { approvalId: "approval-1" } as never),
    ).toEqual({ approvalId: "approval-1" });
    expect(
      GatewayService.prototype.enqueueApprovalResolutionEffects.call(
        gateway,
        { approvalId: "approval-1" } as never,
        { decision: "approved" } as never,
      ),
    ).toEqual([{ effectId: "effect-1" }]);
    expect(GatewayService.prototype.primeApprovalLifecycle.call(gateway, "approval-1")).toMatchObject({
      approvalId: "approval-1",
    });
    GatewayService.prototype.requestDurableRunProcessing.call(gateway, "run-1");
    expect(gateway.durableRunService.requestRunProcessing).toHaveBeenCalledWith("run-1");
    expect(GatewayService.prototype.computeDurableRetryDelayMs.call(gateway, { runId: "run-1" } as never, 3)).toBe(
      3000,
    );
    expect(GatewayService.prototype.recordDurableTimelineEvent.call(gateway, "run-1", "step_started" as never)).toEqual(
      { runId: "run-1", eventType: "step_started" },
    );
    GatewayService.prototype.recordImprovementDurableRunCompletion.call(gateway, { runId: "run-1" } as never, {
      ok: true,
    });
    expect(gateway.improvementService.recordDurableRunCompletionSignal).toHaveBeenCalledWith({
      run: { runId: "run-1" },
      checkpointState: { ok: true },
    });
  });

  it("creates internal grants only when deny-wins and existing allow checks pass", () => {
    const publishRealtime = vi.fn();
    const createGrant = vi.fn();
    const { gateway } = createGatewayHarness({
      listToolGrants: vi.fn(),
      policyEngine: { createGrant },
      publishRealtime,
    });

    gateway.listToolGrants = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ decision: "deny", toolPattern: "browser.*", scope: "global", scopeRef: "global" }])
      .mockReturnValueOnce([]);
    expect(() =>
      GatewayService.prototype.ensureSessionInternalToolGrant.call(gateway, "session-1", "browser.search", "test"),
    ).toThrow(/blocked by an active deny/i);
    expect(createGrant).not.toHaveBeenCalled();

    gateway.listToolGrants = vi
      .fn()
      .mockReturnValueOnce([
        { decision: "allow", toolPattern: "browser.search", scope: "session", scopeRef: "session-1" },
      ])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);
    GatewayService.prototype.ensureSessionInternalToolGrant.call(gateway, "session-1", "browser.search", "test");
    expect(createGrant).not.toHaveBeenCalled();

    gateway.listToolGrants = vi.fn().mockReturnValueOnce([]).mockReturnValueOnce([]).mockReturnValueOnce([]);
    GatewayService.prototype.ensureSessionInternalToolGrant.call(gateway, "session-1", "browser.search", "test");
    expect(createGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        toolPattern: "browser.search",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "ttl",
      }),
    );
    expect(publishRealtime).toHaveBeenLastCalledWith(
      "system",
      "tools",
      expect.objectContaining({ type: "internal_tool_grant_created", toolName: "browser.search" }),
    );
  });

  it("does not resolve local operator overrides in remote hardened deployments", () => {
    const resolveContext = vi.fn((input: Record<string, unknown>) => ({
      permissionProfile: {
        profileId: "safe",
        label: "Safe",
        builtin: true,
        status: "active",
        scope: "global",
        approvalMode: "approve_all",
        toolPatterns: ["*"],
        createdBy: "system",
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
      },
      localOperatorOverride: input.disableLocalOperatorOverrides
        ? undefined
        : {
            overrideId: "local-override-1",
            operatorId: "operator-1",
            scope: "operator",
            reason: "stale local override",
            status: "active",
            createdBy: "operator-1",
            createdAt: "2026-05-17T00:00:00.000Z",
            expiresAt: "2099-05-17T00:00:00.000Z",
          },
    }));
    const { gateway } = createGatewayHarness({
      config: {
        rootDir: "F:/code/personal-ai",
        assistant: {
          deploymentProfile: "remote_hardened",
        },
      },
      storage: {
        permissionProfiles: { resolveContext },
      },
    });

    const context = GatewayService.prototype.resolveToolPolicyContext.call(gateway, {
      operatorId: "operator-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
    });

    expect(context.localOperatorOverrideId).toBeUndefined();
    expect(resolveContext).toHaveBeenCalledWith(expect.objectContaining({ disableLocalOperatorOverrides: true }));
    expect(() =>
      GatewayService.prototype.resolveToolPolicyContext.call(gateway, {
        operatorId: "operator-1",
        localOperatorOverrideId: "local-override-1",
      }),
    ).toThrow(/remote_hardened/);

    resolveContext.mockReturnValueOnce({
      permissionProfile: {
        profileId: "trusted_local_power",
        label: "Trusted Local Power",
        builtin: true,
        status: "active",
        scope: "global",
        approvalMode: "bypass",
        toolPatterns: ["*"],
        createdBy: "system",
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
      },
    });
    expect(() =>
      GatewayService.prototype.resolveToolPolicyContext.call(gateway, {
        operatorId: "operator-1",
        permissionProfileId: "trusted_local_power",
      }),
    ).toThrow(/Bypass permission profiles are unavailable/);
  });

  it("validates remote action tokens and enqueues connector approval delivery runs", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const currentToken = {
      tokenId: "token-1",
      token: "secret",
      actionType: "approval.resolve",
      state: "pending",
      expiresAt: future,
      connectorId: "connector-1",
    };
    const createDurableRun = vi.fn((input: Record<string, unknown>) => ({ runId: "delivery-run", input }));
    const { gateway } = createGatewayHarness({
      createDurableRun,
      getCurrentRequestAttribution: vi.fn(() => ({ traceId: "trace-1", originSurface: "chat" })),
      isFeatureEnabled: vi.fn(() => true),
    });
    gateway.storage.remoteActionTokens.findByTokenHash = vi.fn(() => currentToken);
    gateway.storage.remoteActionTokens.get = vi.fn(() => currentToken);

    expect(
      GatewayService.prototype.consumeRemoteActionToken.call(gateway, " secret ", "approval.resolve"),
    ).toMatchObject({ tokenId: "token-1", state: "consumed" });
    expect(
      GatewayService.prototype.consumeRemoteActionTokenById.call(gateway, " token-1 ", "approval.resolve"),
    ).toMatchObject({ tokenId: "token-1", state: "consumed" });

    gateway.storage.remoteActionTokens.findByTokenHash = vi.fn(() => ({ ...currentToken, actionType: "other.action" }));
    expect(() => GatewayService.prototype.consumeRemoteActionToken.call(gateway, "secret", "approval.resolve")).toThrow(
      ConflictError,
    );
    gateway.storage.remoteActionTokens.findByTokenHash = vi.fn(() => ({ ...currentToken, expiresAt: expired }));
    expect(() => GatewayService.prototype.consumeRemoteActionToken.call(gateway, "secret", "approval.resolve")).toThrow(
      ConflictError,
    );
    expect(gateway.storage.remoteActionTokens.updateState).toHaveBeenCalledWith("token-1", "expired");
    gateway.storage.remoteActionTokens.findByTokenHash = vi.fn(() => undefined);
    expect(() => GatewayService.prototype.consumeRemoteActionToken.call(gateway, "secret", "approval.resolve")).toThrow(
      NotFoundError,
    );
    expect(() => GatewayService.prototype.consumeRemoteActionToken.call(gateway, "   ", "approval.resolve")).toThrow(
      ValidationError,
    );

    const deliveryRun = GatewayService.prototype.enqueueApprovalRemoteTokenDelivery.call(
      gateway,
      {
        approvalId: "approval-1",
        kind: "tool",
        riskLevel: "medium",
        status: "pending",
        preview: { summary: "Approve tool" },
        linkage: {
          originSurface: "cowork",
          runId: "run-approval-1",
          permissionProfileId: "safe",
        },
      } as never,
      {
        connectorId: "browser-1",
        connectorType: "browser",
        status: "active",
        capabilities: [
          { id: "approvals", enabled: true },
          { id: "interactive_actions", enabled: true },
        ],
      } as never,
      { token: "remote-token", tokenId: "token-2", expiresAt: future },
    );
    expect(deliveryRun).toMatchObject({ runId: "delivery-run" });
    expect(createDurableRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowKey: "connector.delivery",
        payload: expect.objectContaining({
          traceId: "trace-1",
          originSurface: "cowork",
          runId: "run-approval-1",
          permissionProfileId: "safe",
        }),
        metadata: expect.objectContaining({ approvalId: "approval-1", connectorId: "browser-1" }),
      }),
    );

    gateway.isFeatureEnabled = vi.fn(() => false);
    expect(
      GatewayService.prototype.enqueueApprovalRemoteTokenDelivery.call(
        gateway,
        { approvalId: "approval-1" } as never,
        { connectorId: "browser-1" } as never,
        { token: "remote-token", tokenId: "token-2", expiresAt: future },
      ),
    ).toBeUndefined();
  });
});

describe("GatewayService Loop 13 settings, skills, MCP, and model facades", () => {
  it("forwards settings, auth, personality, skill import, and memory facades", async () => {
    const { gateway, systemSettings } = createGatewayHarness({
      capabilitySystemService: {
        ensureSkillLifecycleBackfill: vi.fn(),
        executeApprovedCodeModeRun: vi.fn(async (approvalId: string) => ({ approvalId, executed: true })),
        listSkills: vi.fn(() => [{ skillId: "skill-1" }]),
      },
      ensureSkillStates: vi.fn(),
      guidanceService: { resolveRuntimeGuidance: vi.fn(async (workspaceId: string) => ({ workspaceId })) },
      memoryLifecycleService: {
        listMemoryFiles: vi.fn(async (relativeDir: string) => [{ relativePath: relativeDir }]),
        listMemoryItems: vi.fn((input: unknown) => [{ input }]),
      },
      personalityCatalogService: {
        buildDefaultChatPersonalityOverlay: vi.fn(() => ({ system: "overlay" })),
        getCatalog: vi.fn(() => [{ id: "default" }]),
        setDefaultPersonality: vi.fn((id: string) => ({ id, default: true })),
      },
      skillImportService: {
        listHistory: vi.fn((limit: number) => [{ limit }]),
        listSources: vi.fn(async (query?: string, limit?: number) => ({ query, limit })),
        lookupSources: vi.fn(async (queryOrUrl: string, limit?: number) => ({ queryOrUrl, limit })),
      },
      skillsService: {
        list: vi.fn(() => [{ skillId: "skill-1" }]),
        reload: vi.fn(async () => [{ skillId: "skill-1" }, { skillId: "skill-2" }]),
      },
    });

    expect(GatewayService.prototype.listSkills.call(gateway)).toEqual([{ skillId: "skill-1" }]);
    await expect(GatewayService.prototype.reloadSkills.call(gateway)).resolves.toEqual([{ skillId: "skill-1" }]);
    await expect(GatewayService.prototype.executeCodeModePendingApproval.call(gateway, "approval-1")).resolves.toEqual({
      approvalId: "approval-1",
      executed: true,
    });
    await expect(GatewayService.prototype.listMemoryFiles.call(gateway, "memory/team")).resolves.toEqual([
      { relativePath: "memory/team" },
    ]);
    expect(GatewayService.prototype.listMemoryItems.call(gateway, { namespace: "project" })).toEqual([
      { input: { namespace: "project" } },
    ]);
    expect(GatewayService.prototype.getSettings.call(gateway)).toMatchObject({ runtime: "settings" });
    expect(
      GatewayService.prototype.updateSettings.call(gateway, { deploymentProfile: "trusted_local" } as never),
    ).toMatchObject({ runtime: "updated" });
    expect(GatewayService.prototype.getAuthRuntimeSettings.call(gateway)).toMatchObject({ mode: "token" });
    expect(GatewayService.prototype.updateAuthSettings.call(gateway, { mode: "token" } as never)).toMatchObject({
      mode: "token",
    });
    expect(GatewayService.prototype.getAuthCredentialPlan.call(gateway)).toEqual({ required: true });
    expect(GatewayService.prototype.getOnboardingStartupState.call(gateway)).toMatchObject({ ready: true });
    expect(GatewayService.prototype.validateDeviceAccessToken.call(gateway, "device-token")).toEqual({
      actorId: "operator",
      deviceId: "device-1",
      grantId: "grant-1",
    });
    expect(GatewayService.prototype.validateCompanionAccessToken.call(gateway, "companion-token")).toMatchObject({
      sessionId: "companion-session",
    });
    GatewayService.prototype.verifyCompanionRequestSignature.call(gateway, {
      sessionId: "session-1",
      method: "POST",
      path: "/api/v1/chat",
      timestamp: "2026-05-14T00:00:00.000Z",
      nonce: "nonce",
      signature: "signature",
      body: {},
    });
    expect(settingsAuthService.verifyCompanionRequestSignature).toHaveBeenCalled();
    expect(GatewayService.prototype.getPersonalityCatalog.call(gateway)).toEqual([{ id: "default" }]);
    expect(GatewayService.prototype.setDefaultPersonality.call(gateway, "sharp")).toEqual({
      id: "sharp",
      default: true,
    });
    expect(GatewayService.prototype.buildDefaultChatPersonalityOverlay.call(gateway)).toEqual({ system: "overlay" });
    await expect(GatewayService.prototype.listSkillSources.call(gateway, "browser", 4)).resolves.toEqual({
      query: "browser",
      limit: 4,
    });
    await expect(
      GatewayService.prototype.lookupSkillSources.call(gateway, "https://example.test/skill", 2),
    ).resolves.toEqual({ queryOrUrl: "https://example.test/skill", limit: 2 });
    expect(GatewayService.prototype.listSkillImportHistory.call(gateway, 7)).toEqual([{ limit: 7 }]);

    expect(GatewayService.prototype.getSkillActivationPolicy.call(gateway)).toEqual({
      guardedAutoThreshold: 0.72,
      requireFirstUseConfirmation: true,
    });
    expect(
      GatewayService.prototype.updateSkillActivationPolicy.call(gateway, {
        guardedAutoThreshold: 2,
        requireFirstUseConfirmation: false,
      }),
    ).toEqual({ guardedAutoThreshold: 1, requireFirstUseConfirmation: false });
    expect(systemSettings.set).toHaveBeenCalledWith("skill_activation_policy_v1", {
      guardedAutoThreshold: 1,
      requireFirstUseConfirmation: false,
    });
    await expect(GatewayService.prototype.resolveRuntimeGuidance.call(gateway, "workspace-a")).resolves.toEqual({
      workspaceId: "workspace-a",
    });
    expect(onboardingStateService.getOnboardingStartupState).toHaveBeenCalledWith(gateway);
  });

  it("normalizes MCP state and forwards MCP admin and model calls", async () => {
    const { gateway, systemSettingsStore } = createGatewayHarness({
      llmService: {
        getProviderSecretStatus: vi.fn((providerId: string) => ({
          providerId,
          hasApiKey: true,
          apiKeySource: "env",
        })),
        getRuntimeConfig: vi.fn(() => ({
          activeProviderId: "openai",
          activeModel: "gpt-active",
          providers: [{ providerId: "openai", defaultModel: "gpt-default", hasApiKey: true }],
        })),
        listModels: vi.fn(async (providerId?: string) => [{ providerId, id: "model-1" }]),
      },
      toolInvocationCoordinator: { invokeMcpTool: vi.fn(async (input: unknown) => ({ input, invoked: true })) },
    });
    systemSettingsStore.set("mcp_servers_v1", [
      {
        serverId: "server-1",
        label: "Server One",
        transport: "stdio",
        status: "connected",
        enabled: true,
        policy: {},
      },
      { missing: true },
    ]);
    systemSettingsStore.set("mcp_tools_v1", [
      { serverId: "server-1", toolName: "z.tool" },
      { serverId: "server-1", toolName: "a.tool" },
      { serverId: "", toolName: "ignored" },
    ]);
    systemSettingsStore.set("mcp_auth_state_v1", { "server-1": { connected: true } });
    systemSettingsStore.set("mcp_tool_first_approval_v1", { "server-1": ["a.tool"] });

    expect(GatewayService.prototype.readMcpServers.call(gateway)).toEqual([
      expect.objectContaining({
        serverId: "server-1",
        category: "development",
        trustTier: "restricted",
        costTier: "unknown",
      }),
    ]);
    expect(GatewayService.prototype.requireMcpServer.call(gateway, "server-1")).toMatchObject({ serverId: "server-1" });
    expect(() => GatewayService.prototype.requireMcpServer.call(gateway, "missing")).toThrow(/Unknown MCP server/);
    GatewayService.prototype.writeMcpServers.call(gateway, [{ serverId: "server-2" }] as never);
    expect(gateway.storage.systemSettings.set).toHaveBeenCalledWith("mcp_servers_v1", [{ serverId: "server-2" }]);
    systemSettingsStore.set("mcp_servers_v1", [
      {
        serverId: "server-1",
        label: "Server One",
        transport: "stdio",
        status: "connected",
        enabled: true,
        policy: {},
      },
    ]);
    expect(
      GatewayService.prototype.patchMcpServerState.call(gateway, "server-1", { status: "error", lastError: "boom" }),
    ).toMatchObject({ serverId: "server-1", status: "error", lastError: "boom" });
    expect(GatewayService.prototype.readMcpTools.call(gateway)).toEqual([
      { serverId: "server-1", toolName: "z.tool" },
      { serverId: "server-1", toolName: "a.tool" },
    ]);
    GatewayService.prototype.writeMcpTools.call(gateway, [{ serverId: "server-1", toolName: "new.tool" }] as never);
    expect(gateway.storage.systemSettings.set).toHaveBeenCalledWith("mcp_tools_v1", [
      { serverId: "server-1", toolName: "new.tool" },
    ]);
    expect(GatewayService.prototype.readMcpAuthState.call(gateway)).toEqual({ "server-1": { connected: true } });
    GatewayService.prototype.writeMcpAuthState.call(gateway, { "server-2": { connected: false } } as never);
    expect(gateway.storage.systemSettings.set).toHaveBeenCalledWith("mcp_auth_state_v1", {
      "server-2": { connected: false },
    });
    systemSettingsStore.set("mcp_servers_v1", [
      { serverId: "server-1", label: "Server One", transport: "stdio", status: "connected", enabled: true },
    ]);
    systemSettingsStore.set("mcp_tools_v1", [
      { serverId: "server-1", toolName: "z.tool" },
      { serverId: "server-1", toolName: "a.tool" },
    ]);
    expect(GatewayService.prototype.listMcpServers.call(gateway)).toHaveLength(1);
    expect(
      GatewayService.prototype.listMcpTools
        .call(gateway, "server-1")
        .map((tool: { toolName: string }) => tool.toolName),
    ).toEqual(["a.tool", "z.tool"]);
    expect(GatewayService.prototype.listMcpBrowserFallbackTargets.call(gateway)).toEqual([]);
    expect(GatewayService.prototype.createMcpServer.call(gateway, { label: "New" } as never)).toMatchObject({
      serverId: "server-created",
    });
    await expect(GatewayService.prototype.connectMcpServer.call(gateway, "server-1")).resolves.toMatchObject({
      status: "connected",
    });
    expect(GatewayService.prototype.disconnectMcpServer.call(gateway, "server-1")).toMatchObject({
      status: "disconnected",
    });
    await expect(
      GatewayService.prototype.invokeMcpTool.call(gateway, { serverId: "server-1" } as never),
    ).resolves.toMatchObject({ invoked: true });
    expect(GatewayService.prototype.getProviderSecretStatus.call(gateway, "openai")).toEqual({
      providerId: "openai",
      hasSecret: true,
      source: "env",
    });
    expect(GatewayService.prototype.getLlmConfig.call(gateway)).toMatchObject({ activeProviderId: "openai" });
    await expect(GatewayService.prototype.listLlmModels.call(gateway, "openai")).resolves.toEqual([
      { providerId: "openai", id: "model-1" },
    ]);
    expect(
      GatewayService.prototype.resolveFallbackTargets.call(
        gateway,
        {
          activeProviderId: "openai",
          activeModel: "gpt-active",
          providers: [
            { providerId: "openai", defaultModel: "gpt-default", hasApiKey: true },
            { providerId: "moonshot", defaultModel: "kimi-latest", hasApiKey: true },
            { providerId: "glm", defaultModel: "glm-5", hasApiKey: false },
          ],
        } as never,
        "openai",
        "gpt-active",
      ),
    ).toEqual([{ providerId: "moonshot", model: "kimi-latest" }]);
    expect(mcpServerAdminService.createMcpServer).toHaveBeenCalledWith(gateway, { label: "New" });
  });
});

describe("GatewayService Loop 13 channel, lifecycle, and runtime facade behavior", () => {
  it("queues channel sends, forwards comms adapters, and merges delivery runtime rows", async () => {
    const { gateway } = createGatewayHarness({
      channelDeliveryRuntimeService: {
        drainDue: vi.fn(async (limit: number) => [{ deliveryId: "drained", limit }]),
        enqueue: vi
          .fn()
          .mockReturnValueOnce({
            deliveryId: "delivery-queued",
            status: "queued",
            channelKey: "telegram",
            target: "room",
            deliveryStatus: "retrying",
            createdAt: "2026-05-14T00:00:00.000Z",
            updatedAt: "2026-05-14T00:00:00.000Z",
          })
          .mockReturnValueOnce({
            deliveryId: "delivery-sent",
            status: "sent",
            channelKey: "telegram",
            target: "room",
            providerMessageId: "provider-1",
            createdAt: "2026-05-14T00:00:01.000Z",
            updatedAt: "2026-05-14T00:00:01.000Z",
          }),
        list: vi.fn(() => [
          {
            deliveryId: "runtime-newer",
            updatedAt: "2026-05-14T00:00:03.000Z",
            deliveryStatus: "sent",
          },
        ]),
      },
      scheduleChannelDeliveryDrain: vi.fn(),
    });
    gateway.storage.commsDeliveries.list = vi.fn(() => [
      {
        deliveryId: "persisted",
        connectionId: "conn-1",
        channelKey: "telegram",
        target: "room",
        status: "queued",
        deliveryStatus: "retrying",
        idempotencyKey: "key-1",
        payloadHash: "hash-1",
        attempts: 1,
        maxAttempts: 3,
        updatedAt: "2026-05-14T00:00:02.000Z",
        createdAt: "2026-05-14T00:00:02.000Z",
      },
    ]);

    await expect(
      GatewayService.prototype.commsSend.call(gateway, {
        connectionId: "conn-1",
        target: "room",
        message: "hello",
      } as never),
    ).resolves.toMatchObject({ deliveryId: "delivery-queued", status: "queued" });
    await expect(
      GatewayService.prototype.commsReply.call(gateway, {
        connectionId: "conn-1",
        target: "room",
        message: "reply",
        replyToMessageId: "message-1",
      } as never),
    ).resolves.toMatchObject({ deliveryId: "delivery-sent", status: "sent", providerMessageId: "provider-1" });
    await expect(
      GatewayService.prototype.commsReply.call(gateway, {
        connectionId: "conn-1",
        target: "room",
        message: "reply",
      } as never),
    ).rejects.toThrow(/replyToMessageId is required/);
    await expect(
      GatewayService.prototype.commsReact.call(gateway, { connectionId: "conn-1" } as never),
    ).resolves.toMatchObject({ action: "react" });
    await expect(
      GatewayService.prototype.commsUnsend.call(gateway, { connectionId: "conn-1" } as never),
    ).resolves.toMatchObject({ action: "unsend" });
    await expect(
      GatewayService.prototype.commsTyping.call(gateway, { connectionId: "conn-1" } as never),
    ).resolves.toMatchObject({ typing: true });
    await expect(
      GatewayService.prototype.commsGmailRead.call(gateway, { connectionId: "conn-1" } as never),
    ).resolves.toMatchObject({ action: "gmail.read" });
    await expect(
      GatewayService.prototype.commsGmailSend.call(gateway, { connectionId: "conn-1" } as never),
    ).resolves.toMatchObject({ action: "gmail.send" });
    await expect(
      GatewayService.prototype.commsCalendarList.call(gateway, { connectionId: "conn-1" } as never),
    ).resolves.toMatchObject({ action: "calendar.list" });
    await expect(
      GatewayService.prototype.commsCalendarCreate.call(gateway, { connectionId: "conn-1" } as never),
    ).resolves.toMatchObject({ action: "calendar.create" });
    await expect(GatewayService.prototype.drainDueChannelDeliveries.call(gateway, 9)).resolves.toEqual([
      { deliveryId: "drained", limit: 9 },
    ]);
    expect(
      GatewayService.prototype.listChannelDeliveryRuntime
        .call(gateway)
        .map((item: { deliveryId: string }) => item.deliveryId),
    ).toEqual(["runtime-newer", "persisted"]);
    expect(commsService.commsReact).toHaveBeenCalledWith(expect.objectContaining({ kind: "comms" }), {
      connectionId: "conn-1",
    });
  });

  it("ingests channel messages and gateway events with realtime invalidation semantics", async () => {
    const publishRealtime = vi.fn();
    const ingest = vi.fn(async (_input: unknown) => ({
      deduped: false,
      session: { sessionId: "session-1", sessionKey: "sms:acct:peer" },
    }));
    const { gateway } = createGatewayHarness({
      eventIngestService: { ingest },
      publishRealtime,
    });

    await expect(
      GatewayService.prototype.ingestEvent.call(gateway, "idem-1", {
        eventId: "event-1",
        route: { channel: "sms", account: "acct", peer: "peer" },
        actor: { type: "user", id: "user-1" },
        message: { role: "user", content: "hello" },
        taskId: "task-1",
      } as never),
    ).resolves.toMatchObject({ session: { sessionId: "session-1" } });
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/api/v1/gateway/events",
        idempotencyKey: "idem-1",
      }),
    );
    expect(gateway.operatorSummaryCache.invalidate).toHaveBeenCalledTimes(1);
    expect(publishRealtime).toHaveBeenCalledWith(
      "session_event",
      "gateway",
      expect.objectContaining({ eventId: "event-1", sessionId: "session-1", deduped: false }),
      expect.objectContaining({ eventClass: "domain_fact" }),
    );

    gateway.ingestEvent = vi.fn(async (_idempotencyKey: string, payload: Record<string, unknown>) => ({
      session: { sessionId: "session-channel" },
      payload,
    }));
    await expect(
      GatewayService.prototype.ingestChannelMessage.call(gateway, "telegram", "idem-2", {
        account: "bot",
        actorId: "user-2",
        content: "hi",
        eventId: "channel-event-1",
        peer: "peer-2",
        role: "user",
      } as never),
    ).resolves.toMatchObject({ session: { sessionId: "session-channel" } });
    expect(gateway.ingestEvent).toHaveBeenCalledWith(
      "idem-2",
      expect.objectContaining({
        eventId: "channel-event-1",
        route: expect.objectContaining({ channel: "telegram", account: "bot", peer: "peer-2" }),
        actor: { type: "user", id: "user-2" },
        message: { role: "user", content: "hi" },
      }),
    );
    expect(publishRealtime).toHaveBeenLastCalledWith(
      "system",
      "channels",
      expect.objectContaining({ type: "channel_message_ingested", sessionId: "session-channel" }),
    );
  });

  it("runs init, deferred init, close, and Discord sync lifecycle facades", async () => {
    const deferred = Promise.resolve();
    const { gateway } = createGatewayHarness({
      applyStoredFeatureFlags: vi.fn(),
      approvalEffectsService: { stopWorker: vi.fn() },
      assemblyService: { close: vi.fn(async () => undefined) },
      chatProactiveService: { stopScheduler: vi.fn() },
      discordRuntimeService: { close: vi.fn(async () => undefined), sync: vi.fn(async () => undefined) },
      durableRunService: { stopWorker: vi.fn() },
      improvementService: { stopScheduler: vi.fn() },
      initCritical: vi.fn(async () => undefined),
      llamaCppRuntime: { close: vi.fn(async () => undefined) },
      loadOnboardingMarker: vi.fn(async () => undefined),
      npuSidecar: { close: vi.fn(async () => undefined) },
      recordDevDiagnostic: vi.fn(),
      runDeferredInit: vi.fn(() => deferred),
      skillsService: { reload: vi.fn(async () => [{ skillId: "skill-1" }]) },
      startDeferredInit: vi.fn(async () => undefined),
      storage: {
        ...createGatewayHarness().gateway.storage,
        agentProfiles: { seedBuiltins: vi.fn() },
        close: vi.fn(),
      },
    });

    await GatewayService.prototype.init.call(gateway);
    expect(gateway.initCritical).toHaveBeenCalled();
    expect(gateway.startDeferredInit).toHaveBeenCalled();

    gateway.criticalInitComplete = false;
    await GatewayService.prototype.initCritical.call(gateway);
    expect(gateway.loadOnboardingMarker).toHaveBeenCalled();
    expect(gateway.storage.agentProfiles.seedBuiltins).toHaveBeenCalled();
    expect(gateway.criticalInitComplete).toBe(true);
    await GatewayService.prototype.initCritical.call(gateway);
    expect(gateway.skillsService.reload).toHaveBeenCalledTimes(1);

    gateway.criticalInitComplete = false;
    expect(() => GatewayService.prototype.startDeferredInit.call(gateway)).toThrow(/critical init/);
    gateway.criticalInitComplete = true;
    const started = GatewayService.prototype.startDeferredInit.call(gateway);
    expect(gateway.runDeferredInit).toHaveBeenCalledTimes(1);
    expect(gateway.backgroundTasks.has(started)).toBe(true);
    expect(GatewayService.prototype.startDeferredInit.call(gateway)).toBe(started);
    await started;

    await GatewayService.prototype.syncDiscordRuntime.call(gateway);
    gateway.discordRuntimeService.sync = vi.fn(async () => {
      throw new Error("discord offline");
    });
    await GatewayService.prototype.syncDiscordRuntime.call(gateway);
    expect(gateway.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "discord.runtime.sync_failed" }),
    );

    gateway.backgroundTasks.add(Promise.resolve("done"));
    await GatewayService.prototype.close.call(gateway);
    expect(gateway.chatProactiveService.stopScheduler).toHaveBeenCalled();
    expect(gateway.approvalEffectsService.stopWorker).toHaveBeenCalled();
    expect(gateway.storage.close).toHaveBeenCalled();
    expect(gateway.closing).toBe(true);
  });
});

describe("GatewayService Loop 13 workspace and runtime helpers", () => {
  it("resolves runtime workspace, Discord, connector, and transcript helpers", async () => {
    vi.stubEnv("LOOP13_SECRET", "resolved-secret");
    const { gateway } = createGatewayHarness({
      buildChatThreadKnowledgeDependencies: vi.fn(() => ({ deps: true })),
      guidanceService: { resolveRuntimeGuidance: vi.fn(async (workspaceId: string) => ({ workspaceId })) },
      readTranscriptOrEmpty: vi.fn(async () => [
        {
          eventId: "event-1",
          timestamp: "2026-05-14T00:00:00.000Z",
          type: "message.user",
          actorType: "user",
          actorId: "operator",
          payload: { content: "First message" },
        },
        {
          eventId: "event-2",
          timestamp: "2026-05-14T00:01:00.000Z",
          type: "message.assistant",
          actorType: "agent",
          actorId: "assistant",
          payload: { content: "Second message" },
        },
      ]),
    });

    expect(GatewayService.prototype.readConnectionConfigValue.call(gateway, { token: "  direct " }, "token")).toBe(
      "direct",
    );
    expect(GatewayService.prototype.readConnectionConfigValue.call(gateway, { token: " " }, "token")).toBeUndefined();
    expect(
      GatewayService.prototype.resolveConnectionSecret.call(
        gateway,
        { tokenEnv: " LOOP13_SECRET " },
        "token",
        "tokenEnv",
      ),
    ).toBe("resolved-secret");
    expect(
      GatewayService.prototype.resolveConnectionSecret.call(gateway, { token: " direct-secret " }, "token", "tokenEnv"),
    ).toBe("direct-secret");
    expect(GatewayService.prototype.isConnectionUrlAllowlisted.call(gateway, "https://api.example.test/v1")).toBe(true);
    expect(GatewayService.prototype.isConnectionUrlAllowlisted.call(gateway, "not a url")).toBe(false);
    expect(GatewayService.prototype.tryParseJson.call(gateway, '{"ok":true}', {})).toEqual({ ok: true });
    expect(GatewayService.prototype.tryParseJson.call(gateway, "{", { ok: false })).toEqual({ ok: false });
    expect(GatewayService.prototype.normalizeWorkspaceId.call(gateway, " Team-1 ")).toBe("Team-1");
    expect(GatewayService.prototype.normalizeWorkspaceId.call(gateway)).toBe("default");
    expect(() => GatewayService.prototype.normalizeWorkspaceId.call(gateway, "../bad")).toThrow(/unsupported/);
    expect(GatewayService.prototype.resolveMemoryWorkspaceRelativeDir.call(gateway, "custom/memory", "session-1")).toBe(
      "custom/memory",
    );
    expect(GatewayService.prototype.resolveMemoryWorkspaceRelativeDir.call(gateway, undefined, "session-1")).toBe(
      "workspaces/workspace-a/memory",
    );
    expect(
      GatewayService.prototype.resolveChatCompletionHookWorkspaceId.call(gateway, {
        memory: { workspace: "hook-workspace" },
      } as never),
    ).toBe("hook-workspace");
    expect(
      GatewayService.prototype.resolveChatCompletionHookWorkspaceId.call(gateway, {
        memory: { sessionId: "session-1" },
      } as never),
    ).toBe("workspace-a");
    expect(
      GatewayService.prototype.resolveApprovalHookWorkspaceId.call(gateway, { workspaceId: "approval-workspace" }),
    ).toBe("approval-workspace");
    expect(GatewayService.prototype.resolveApprovalHookWorkspaceId.call(gateway, { sessionId: "session-1" })).toBe(
      "workspace-a",
    );
    expect(
      GatewayService.prototype.resolveDiscordInboundRoute.call(gateway, { connectionId: "conn", target: "peer" }),
    ).toMatchObject({ peer: "peer" });
    expect(
      GatewayService.prototype.startNewDiscordRouteSession.call(gateway, { connectionId: "conn", target: "peer" }),
    ).toMatchObject({ sessionId: "discord-session" });
    expect(
      GatewayService.prototype.routeFromSession.call(gateway, {
        kind: "dm",
        channel: "sms",
        account: "acct",
        sessionKey: "sms:acct:peer",
      } as never),
    ).toEqual({ channel: "sms", account: "acct", peer: "peer" });
    expect(
      GatewayService.prototype.routeFromSession.call(gateway, {
        kind: "group",
        channel: "sms",
        account: "acct",
        sessionKey: "sms:acct:room",
      } as never),
    ).toEqual({ channel: "sms", account: "acct", room: "room" });
    expect(
      GatewayService.prototype.routeFromSession.call(gateway, {
        kind: "thread",
        channel: "sms",
        account: "acct",
        sessionKey: "sms:acct:room:thread",
      } as never),
    ).toEqual({ channel: "sms", account: "acct", room: "room", threadId: "thread" });
    expect(GatewayService.prototype.isReplayScratchSession.call(gateway, "session-1")).toBe(true);
    await expect(GatewayService.prototype.resolveRuntimeGuidance.call(gateway, "workspace-a")).resolves.toEqual({
      workspaceId: "workspace-a",
    });
    await expect(
      GatewayService.prototype.resolveThreadKnowledgeContext.call(gateway, "session-1", "what changed?"),
    ).resolves.toMatchObject({ sessionId: "session-1", query: "what changed?" });
    expect(chatThreadKnowledgeService.resolveThreadKnowledgeContext).toHaveBeenCalledWith(
      { deps: true },
      "session-1",
      "what changed?",
    );
    await expect(GatewayService.prototype.getTranscript.call(gateway, "session-1")).resolves.toEqual([]);
    await expect(GatewayService.prototype.getSessionSummary.call(gateway, "session-1")).resolves.toMatchObject({
      session: expect.objectContaining({ sessionId: "session-1" }),
      transcriptEventCount: 2,
      latestEventType: "message.assistant",
      lastMessagePreview: "Second message",
      countsByType: { "message.user": 1, "message.assistant": 1 },
    });
    await expect(GatewayService.prototype.listSessionTimeline.call(gateway, "session-1", 1)).resolves.toMatchObject([
      { eventId: "event-2", preview: "Second message" },
    ]);
    expect(discordRuntimeBridgeService.resolveDiscordInboundRoute).toHaveBeenCalledWith(gateway, {
      connectionId: "conn",
      target: "peer",
    });
  });

  it("resolves durable hook workspace ids for every workflow payload shape", () => {
    const { gateway } = createGatewayHarness({
      parseApprovalWaitWorkflowPayload: vi.fn((run: { workflowKey: string }) =>
        run.workflowKey === "approval.wait" ? { approvalId: "approval-1" } : undefined,
      ),
      parseConnectorDeliveryWorkflowPayload: vi.fn((run: { workflowKey: string }) =>
        run.workflowKey === "connector.delivery" ? { payload: { workspaceId: "connector-workspace" } } : undefined,
      ),
      parseDurableChatTurnPayload: vi.fn((run: { workflowKey: string }) =>
        run.workflowKey === "chat.turn.execute" ? { sessionId: "session-1" } : undefined,
      ),
      parseHookDeliveryWorkflowPayload: vi.fn((run: { workflowKey: string }) =>
        run.workflowKey === "hook.delivery" ? { workspaceId: "hook-workspace" } : undefined,
      ),
      parseMemoryMaintenanceWorkflowPayload: vi.fn((run: { workflowKey: string }) =>
        run.workflowKey === "memory.maintenance" ? { workspaceId: "memory-workspace" } : undefined,
      ),
      parseOrchestrationWorkflowPayload: vi.fn((run: { workflowKey: string }) =>
        run.workflowKey === "orchestration.plan.execute" ? { workspaceId: "orchestration-workspace" } : undefined,
      ),
      parseProactiveTickWorkflowPayload: vi.fn((run: { workflowKey: string }) =>
        run.workflowKey === "proactive.tick" ? { sessionId: "session-1" } : undefined,
      ),
    });
    gateway.storage.approvals = {
      get: vi.fn(() => ({ approvalId: "approval-1", payload: { workspaceId: "approval-workspace" } })),
    };

    expect(
      GatewayService.prototype.resolveDurableRunHookWorkspaceId.call(gateway, {
        workflowKey: "memory.maintenance",
      } as never),
    ).toBe("memory-workspace");
    expect(
      GatewayService.prototype.resolveDurableRunHookWorkspaceId.call(gateway, {
        workflowKey: "hook.delivery",
      } as never),
    ).toBe("hook-workspace");
    expect(
      GatewayService.prototype.resolveDurableRunHookWorkspaceId.call(gateway, {
        workflowKey: "connector.delivery",
      } as never),
    ).toBe("connector-workspace");
    expect(
      GatewayService.prototype.resolveDurableRunHookWorkspaceId.call(gateway, {
        workflowKey: "approval.wait",
      } as never),
    ).toBe("approval-workspace");
    expect(
      GatewayService.prototype.resolveDurableRunHookWorkspaceId.call(gateway, {
        workflowKey: "chat.turn.execute",
      } as never),
    ).toBe("workspace-a");
    expect(
      GatewayService.prototype.resolveDurableRunHookWorkspaceId.call(gateway, {
        workflowKey: "proactive.tick",
      } as never),
    ).toBe("workspace-a");
    expect(
      GatewayService.prototype.resolveDurableRunHookWorkspaceId.call(gateway, {
        workflowKey: "orchestration.plan.execute",
      } as never),
    ).toBe("orchestration-workspace");
    expect(
      GatewayService.prototype.resolveDurableRunHookWorkspaceId.call(gateway, { workflowKey: "unknown" } as never),
    ).toBe("default");
  });
});
