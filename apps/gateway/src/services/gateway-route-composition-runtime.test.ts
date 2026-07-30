import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeRuntimeAdminRouteDependencies,
  resolveDevVerificationVaultKey,
} from "./gateway-route-composition-runtime.js";

const mocks = vi.hoisted(() => ({
  createCronRoutePort: vi.fn((service: { ping: () => string }) => ({
    pingCron: () => service.ping(),
  })),
  createDashboardRoutePort: vi.fn(
    (deps: { isFeatureEnabled: (flag: string) => boolean; operatorSummaryCache: { snapshot: () => unknown } }) => ({
      isCodeModeEnabled: () => deps.isFeatureEnabled("codeModeV1Enabled"),
      operatorSummary: () => deps.operatorSummaryCache.snapshot(),
    }),
  ),
  createFilesRoutePort: vi.fn(
    (deps: {
      rootDir: string;
      serializeRootPath: (fullPath: string) => string;
      publishRealtime: (eventType: string, source: string, payload?: unknown) => unknown;
    }) => ({
      rootDir: deps.rootDir,
      publishFileEvent: () => deps.publishRealtime("file.created", "files", { relativePath: "note.md" }),
      serializeRootPath: (fullPath: string) => deps.serializeRootPath(fullPath),
    }),
  ),
  createHooksRoutePort: vi.fn((deps: { normalizeWorkspaceId: (workspaceId?: string) => string }) => ({
    normalize: (workspaceId?: string) => deps.normalizeWorkspaceId(workspaceId),
  })),
  createLlamaCppRoutePort: vi.fn(
    (deps: {
      llamaCppRuntime: { status: () => string };
      publishRealtime: (type: string, source: string) => unknown;
    }) => ({
      status: () => deps.llamaCppRuntime.status(),
      publish: () => deps.publishRealtime("llama.status", "llamacpp"),
    }),
  ),
  createMeshRoutePort: vi.fn(
    (deps: { meshService: { status: () => unknown }; publishRealtime: (type: string, source: string) => unknown }) => ({
      status: () => deps.meshService.status(),
      publish: () => deps.publishRealtime("mesh.status", "mesh"),
    }),
  ),
  createNpuRoutePort: vi.fn(
    (deps: { npuSidecar: { status: () => string }; publishRealtime: (type: string, source: string) => unknown }) => ({
      status: () => deps.npuSidecar.status(),
      publish: () => deps.publishRealtime("npu.status", "npu"),
    }),
  ),
  createSessionsListRoutePort: vi.fn(
    (deps: {
      getSessionSummary: (sessionId: string) => unknown;
      listSessionTimeline: (sessionId: string, limit: number) => unknown;
    }) => ({
      summary: (sessionId: string) => deps.getSessionSummary(sessionId),
      timeline: (sessionId: string) => deps.listSessionTimeline(sessionId, 2),
    }),
  ),
  WorkflowRecipeService: vi.fn().mockImplementation(function (deps: {
    listSkills: () => unknown[];
    listToolNames: () => string[];
    createOrchestrationPlan: (plan: unknown) => unknown;
  }) {
    return {
      createPlanFromRecipe: (input: unknown) =>
        deps.createOrchestrationPlan({
          goal: "recipe",
          input,
          tools: deps.listToolNames(),
          skills: deps.listSkills(),
        }),
      exportActivepiecesTemplate: (input: unknown) => ({ input, format: "activepieces" }),
      exportN8nTemplate: (input: unknown) => ({ input, format: "n8n" }),
      listTemplates: () => [{ templateId: "template-1" }],
      previewRecipe: (input: unknown) => ({ input, tools: deps.listToolNames(), skills: deps.listSkills() }),
    };
  }),
  bootstrapOnboarding: vi.fn((gateway: unknown, input: unknown) => ({ gateway, input, bootstrapped: true })),
  getOnboardingStartupState: vi.fn(() => ({ startup: true })),
  getOnboardingState: vi.fn(() => ({ complete: false })),
  markOnboardingComplete: vi.fn((gateway: unknown, completedBy: string) => ({ gateway, completedBy })),
  createDeviceAccessRequest: vi.fn((deps: unknown, input: unknown, metadata: unknown) => ({ deps, input, metadata })),
  exchangeCompanionSessionFromDeviceGrant: vi.fn((deps: unknown, grantId: string, input: unknown) => ({
    deps,
    grantId,
    input,
  })),
  getAuthRuntimeSettings: vi.fn((deps: unknown) => ({ plan: { deps, mode: "token" } })),
  getCompanionSessionInfo: vi.fn((deps: unknown, sessionId: string) => ({ deps, sessionId, info: true })),
  getCompanionSessionRecord: vi.fn((deps: unknown, sessionId: string) => ({ deps, sessionId, record: true })),
  getDeviceAccessRequestStatus: vi.fn((deps: unknown, requestId: string, secret: string) => ({
    deps,
    requestId,
    secret,
  })),
  listCompanionAuditEvents: vi.fn((deps: unknown, input: unknown) => ({ deps, input, audit: true })),
  listCompanionSessions: vi.fn((deps: unknown, input: unknown) => ({ deps, input, sessions: true })),
  listDeviceAccessGrants: vi.fn((deps: unknown) => ({ deps, grants: true })),
  revokeCompanionSession: vi.fn((deps: unknown, sessionId: string, actorId: string) => ({ deps, sessionId, actorId })),
  revokeDeviceAccessGrant: vi.fn((deps: unknown, grantId: string, actorId: string) => ({ deps, grantId, actorId })),
  rotateCompanionSession: vi.fn((deps: unknown, input: unknown) => ({ deps, input, rotated: true })),
  createSettingsAuthRuntimeDependenciesForGateway: vi.fn(() => ({ kind: "settings-auth" })),
  createSettingsRuntimeDependenciesForGateway: vi.fn(() => ({ kind: "settings-runtime" })),
  createWorkspacesRoutePortForGateway: vi.fn(() => ({
    createWorkspace: (input: unknown) => ({ workspaceId: "workspace-1", input }),
  })),
  getLlmConfigForGateway: vi.fn(() => ({ activeProviderId: "openai" })),
  getProviderSecretStatusForGateway: vi.fn((_gateway: unknown, providerId: string) => ({ providerId, source: "env" })),
  serializePathWithinRoot: vi.fn(
    (
      _rootDir: string,
      _fullPath: string,
      _seen: Set<string>,
      warn: (warning: { fingerprint: string; baseName: string }) => void,
    ) => {
      warn({ fingerprint: "fp-outside", baseName: "secret.txt" });
      return "[outside-root]";
    },
  ),
}));

vi.mock("./cron-route-service.js", () => ({ createCronRoutePort: mocks.createCronRoutePort }));
vi.mock("./dashboard-route-service.js", () => ({ createDashboardRoutePort: mocks.createDashboardRoutePort }));
vi.mock("./files-route-service.js", () => ({ createFilesRoutePort: mocks.createFilesRoutePort }));
vi.mock("./hooks-route-service.js", () => ({ createHooksRoutePort: mocks.createHooksRoutePort }));
vi.mock("./llama-cpp-route-service.js", () => ({ createLlamaCppRoutePort: mocks.createLlamaCppRoutePort }));
vi.mock("./mesh-route-service.js", () => ({ createMeshRoutePort: mocks.createMeshRoutePort }));
vi.mock("./npu-route-service.js", () => ({ createNpuRoutePort: mocks.createNpuRoutePort }));
vi.mock("./sessions-list-route-service.js", () => ({ createSessionsListRoutePort: mocks.createSessionsListRoutePort }));
vi.mock("./workflow-recipe-service.js", () => ({ WorkflowRecipeService: mocks.WorkflowRecipeService }));
vi.mock("./onboarding-state-service.js", () => ({
  bootstrapOnboarding: mocks.bootstrapOnboarding,
  getOnboardingStartupState: mocks.getOnboardingStartupState,
  getOnboardingState: mocks.getOnboardingState,
  markOnboardingComplete: mocks.markOnboardingComplete,
}));
vi.mock("./settings-auth-service.js", () => ({
  createDeviceAccessRequest: mocks.createDeviceAccessRequest,
  exchangeCompanionSessionFromDeviceGrant: mocks.exchangeCompanionSessionFromDeviceGrant,
  getAuthRuntimeSettings: mocks.getAuthRuntimeSettings,
  getCompanionSessionInfo: mocks.getCompanionSessionInfo,
  getCompanionSessionRecord: mocks.getCompanionSessionRecord,
  getDeviceAccessRequestStatus: mocks.getDeviceAccessRequestStatus,
  listCompanionAuditEvents: mocks.listCompanionAuditEvents,
  listCompanionSessions: mocks.listCompanionSessions,
  listDeviceAccessGrants: mocks.listDeviceAccessGrants,
  revokeCompanionSession: mocks.revokeCompanionSession,
  revokeDeviceAccessGrant: mocks.revokeDeviceAccessGrant,
  rotateCompanionSession: mocks.rotateCompanionSession,
}));
vi.mock("./gateway-route-composition-shared.js", () => ({
  createSettingsAuthRuntimeDependenciesForGateway: mocks.createSettingsAuthRuntimeDependenciesForGateway,
  createSettingsRuntimeDependenciesForGateway: mocks.createSettingsRuntimeDependenciesForGateway,
  createWorkspacesRoutePortForGateway: mocks.createWorkspacesRoutePortForGateway,
  getLlmConfigForGateway: mocks.getLlmConfigForGateway,
  getProviderSecretStatusForGateway: mocks.getProviderSecretStatusForGateway,
}));
vi.mock("./security-utils.js", () => ({ serializePathWithinRoot: mocks.serializePathWithinRoot }));

describe("composeRuntimeAdminRouteDependencies", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts an exact deterministic Vault key only in dev-verification mode", () => {
    const encodedKey = Buffer.alloc(32, 0x76).toString("base64");

    expect(resolveDevVerificationVaultKey(true, encodedKey)).toEqual(Buffer.alloc(32, 0x76));
    expect(resolveDevVerificationVaultKey(false, encodedKey)).toBeUndefined();
    expect(resolveDevVerificationVaultKey(false, "not-a-key")).toBeUndefined();
    expect(() => resolveDevVerificationVaultKey(true, "not-a-key")).toThrow(/canonical base64-encoded 32-byte key/u);
  });

  it("uses verifier Vault key precedence only while dev verification is enabled and returns defensive copies", () => {
    const expected = Buffer.alloc(32, 0x76);
    vi.stubEnv("GOATCITADEL_VERIFY_VAULT_KEY_BASE64", expected.toString("base64"));
    const gateway = createGateway();
    const getSecret = vi.fn(() => Buffer.alloc(32, 0x55).toString("base64"));
    const setSecret = vi.fn();
    (gateway as any).secretStore = { isAvailable: vi.fn(() => true), getSecret, setSecret };
    const deps = composeRuntimeAdminRouteDependencies(gateway as never) as any;

    const first = deps.vaultKey("citadel-a") as Buffer;
    expect(first).toEqual(expected);
    first[0] = 0;
    expect(deps.vaultKey("citadel-a")).toEqual(expected);
    expect(getSecret).not.toHaveBeenCalled();
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("ignores the verifier Vault key when dev verification is disabled and preserves keychain fallback/fail-closed behavior", () => {
    vi.stubEnv("GOATCITADEL_VERIFY_VAULT_KEY_BASE64", Buffer.alloc(32, 0x76).toString("base64"));
    const storedKey = Buffer.alloc(32, 0x55);
    const gateway = createGateway();
    gateway.devDiagnostics.isEnabled.mockReturnValue(false);
    const getSecret = vi.fn(() => storedKey.toString("base64"));
    const setSecret = vi.fn();
    (gateway as any).secretStore = { isAvailable: vi.fn(() => true), getSecret, setSecret };
    const deps = composeRuntimeAdminRouteDependencies(gateway as never) as any;

    expect(deps.vaultKey("citadel-a")).toEqual(storedKey);
    expect(getSecret).toHaveBeenCalledWith("citadel:citadel-a:vault_master_key");
    expect(setSecret).not.toHaveBeenCalled();

    const unavailableGateway = createGateway();
    unavailableGateway.devDiagnostics.isEnabled.mockReturnValue(false);
    const unavailableGetSecret = vi.fn();
    (unavailableGateway as any).secretStore = {
      isAvailable: vi.fn(() => false),
      getSecret: unavailableGetSecret,
      setSecret: vi.fn(),
    };
    const unavailableDeps = composeRuntimeAdminRouteDependencies(unavailableGateway as never) as any;
    expect(unavailableDeps.vaultKey("citadel-a")).toBeUndefined();
    expect(unavailableGetSecret).not.toHaveBeenCalled();
  });

  it("wires runtime/admin route domains to the gateway facade and extracted route ports", async () => {
    const gateway = createGateway();
    const deps = composeRuntimeAdminRouteDependencies(gateway as never) as any;

    expect(deps.authAdmin.getAuthCredentialPlan()).toMatchObject({ mode: "token" });
    expect(deps.authAdmin.createDeviceAccessRequest({ label: "phone" }, { ip: "127.0.0.1" })).toMatchObject({
      input: { label: "phone" },
      metadata: { ip: "127.0.0.1" },
    });
    expect(deps.authAdmin.exchangeCompanionSessionFromDeviceGrant("grant-1", { deviceName: "phone" })).toMatchObject({
      grantId: "grant-1",
    });
    expect(deps.authAdmin.getCompanionSessionInfo("session-1")).toMatchObject({ info: true });
    expect(deps.authAdmin.getCompanionSessionRecord("session-1")).toMatchObject({ record: true });
    expect(deps.authAdmin.getDeviceAccessRequestStatus("request-1", "secret")).toMatchObject({
      requestId: "request-1",
    });
    expect(deps.authAdmin.getRetentionPolicy()).toEqual({ keepDays: 7 });
    expect(deps.authAdmin.listBackups(3)).toEqual([{ backupId: "backup-1", limit: 3 }]);
    expect(deps.authAdmin.listCompanionAuditEvents({ limit: 1 })).toMatchObject({ audit: true });
    expect(deps.authAdmin.listCompanionSessions({ limit: 1 })).toMatchObject({ sessions: true });
    expect(deps.authAdmin.listDeviceAccessGrants()).toMatchObject({ grants: true });
    expect(deps.authAdmin.pruneRetention({ dryRun: true })).toEqual({ pruned: true });
    expect(deps.authAdmin.resolveGatewayInstallToken({ token: "x" })).toEqual({ token: "x", resolved: true });
    expect(deps.authAdmin.revokeCompanionSession("session-1", "operator")).toMatchObject({ actorId: "operator" });
    expect(deps.authAdmin.revokeDeviceAccessGrant("grant-1", "operator")).toMatchObject({ grantId: "grant-1" });
    expect(deps.authAdmin.rotateCompanionSession({ sessionId: "session-1" })).toMatchObject({ rotated: true });
    const cutoverInput = { profile: "local", execute: true, confirm: true, expectedRevision: 6 };
    expect(deps.authAdmin.runDatabaseCutover(cutoverInput)).toEqual({ cutover: true });
    expect(gateway.runDatabaseCutover).toHaveBeenCalledWith(cutoverInput);
    expect(deps.authAdmin.updateRetentionPolicy({ keepDays: 3 })).toEqual({ keepDays: 3 });
    expect(deps.authAdmin.createBackup({ reason: "manual" })).toEqual({ backupId: "created-backup" });
    expect(deps.authAdmin.verifyBackup({ backupId: "backup-1" })).toEqual({ verified: true });
    expect(deps.authAdmin.verifyDatabaseCutover({ dryRun: true })).toEqual({ database: "ok" });

    expect(deps.approvals).toBe(gateway.approvalRuntime);
    expect(deps.cron.pingCron()).toBe("cron-ok");
    expect(deps.dashboard.isCodeModeEnabled()).toBe(true);
    expect(deps.dashboard.operatorSummary()).toEqual({ operator: "ready" });
    expect(deps.daemon.systemSettings).toBe(gateway.storage.systemSettings);
    expect(deps.devDiagnostics.isDevDiagnosticsEnabled()).toBe(true);
    expect(deps.devDiagnostics.getStartupPhaseSnapshot()).toMatchObject({
      phases: [],
      inProgress: [],
      ready: false,
    });
    expect(deps.devDiagnostics.listDevDiagnostics({ limit: 1 })).toEqual([{ diagnosticId: "diag-1" }]);
    expect(deps.devDiagnostics.subscribeDevDiagnostics(() => undefined)).toBe("unsub");

    expect(deps.devVerification.createWorkspace({ name: "Workspace" })).toMatchObject({ workspaceId: "workspace-1" });
    expect(deps.devVerification.getLlmConfig()).toEqual({ activeProviderId: "openai" });
    expect(deps.devVerification.getProviderSecretStatus("openai")).toEqual({ providerId: "openai", source: "env" });
    expect(deps.devVerification.getRealtimeEventSequenceBounds()).toEqual({ newestSequence: 9 });
    expect(deps.devVerification.createApproval({ kind: "tool" })).toMatchObject({ approvalId: "approval-1" });
    expect(deps.devVerification.createChatCompletion({ messages: [] })).toMatchObject({ id: "completion-1" });
    expect(deps.devVerification.createChatCompletionStream({ messages: [] })).toEqual(["delta"]);
    expect(deps.devVerification.createChatSession({ title: "Chat" })).toMatchObject({ sessionId: "session-1" });
    expect(deps.devVerification.publishRealtime("event", "tests", { ok: true })).toEqual({ eventId: "event-1" });
    const embeddingSignal = new AbortController().signal;
    const embeddingLease = await deps.devVerification.acquireLocalEmbeddingLease({
      providerId: "llamacpp",
      url: "http://127.0.0.1:8080/embedding",
      purpose: "memory_write",
      signal: embeddingSignal,
    });
    expect(embeddingLease).toBeDefined();
    expect(gateway.readSettingsRevision).toHaveBeenCalledTimes(1);
    expect(gateway.llamaCppRuntime.acquireLease).toHaveBeenCalledWith(
      { purpose: "memory_write" },
      { signal: embeddingSignal },
    );
    await embeddingLease?.release();

    expect(deps.durable).toBe(gateway.durableOperatorService);
    expect(deps.files.rootDir).toBe("F:/code/personal-ai");
    expect(deps.files.serializeRootPath("C:/outside/secret.txt")).toBe("[outside-root]");
    expect(deps.files.publishFileEvent()).toEqual({ eventId: "event-1" });
    expect(gateway.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "security",
        context: { fingerprint: "fp-outside", baseName: "secret.txt" },
      }),
    );
    expect(deps.gatewayEvents.ingestEvent("key-1", { type: "x" })).toEqual({ ingested: true });
    expect(deps.health.getDatabaseHealthSnapshot()).toEqual({ healthy: true });
    expect(deps.hooks.normalize(" Team ")).toBe("workspace:Team");
    expect(deps.llamaCpp.status()).toBe("llama-ready");
    expect(deps.llamaCpp.publish()).toEqual({ eventId: "event-1" });
    expect(deps.mesh.status()).toEqual({ mesh: "online" });
    expect(deps.mesh.publish()).toEqual({ eventId: "event-1" });
    expect(deps.npu.status()).toBe("npu-ready");
    expect(deps.npu.publish()).toEqual({ eventId: "event-1" });

    expect(deps.onboarding.bootstrapOnboarding({ level: "beginner" })).toMatchObject({ bootstrapped: true });
    expect(deps.onboarding.getOnboardingStartupState()).toEqual({ startup: true });
    expect(deps.onboarding.getOnboardingState()).toEqual({ complete: false });
    expect(deps.onboarding.markOnboardingComplete("operator")).toMatchObject({ completedBy: "operator" });

    expect(deps.orchestration.createOrchestrationPlan({ goal: "ship" })).toEqual({
      planId: "plan-1",
      plan: { goal: "ship" },
    });
    expect(deps.orchestration.createPlanFromRecipe({ templateId: "template-1" })).toMatchObject({
      planId: "plan-1",
      plan: expect.objectContaining({ goal: "recipe", tools: ["tool.a", "tool.b", "tool.c", ""] }),
    });
    expect(deps.orchestration.listRecipeTemplates()).toEqual({ items: [{ templateId: "template-1" }] });
    expect(deps.orchestration.previewRecipe({ templateId: "template-1" })).toMatchObject({
      tools: ["tool.a", "tool.b", "tool.c", ""],
    });
    expect(deps.orchestration.exportActivepiecesTemplate({ templateId: "template-1" })).toEqual({
      input: { templateId: "template-1" },
      format: "activepieces",
    });
    expect(deps.orchestration.exportN8nTemplate({ templateId: "template-1" })).toEqual({
      input: { templateId: "template-1" },
      format: "n8n",
    });
    expect(deps.orchestration.runOrchestrationPlan("plan-1")).toEqual({ runId: "run-1" });
    expect(deps.orchestration.approvePhase("run-1", "phase-1", "operator", 0.5, "workspace-1")).toEqual({
      approved: true,
    });
    expect(deps.orchestration.getRun("run-1", "workspace-1")).toEqual({ runId: "run-1" });
    expect(deps.orchestration.listRunCheckpoints("run-1", "workspace-1")).toEqual([{ checkpointId: "cp-1" }]);
    expect(deps.orchestration.getRunTrace("run-1", "workspace-1")).toEqual({ runId: "run-1", trace: true });
    expect(deps.orchestration.listRunContexts("run-1")).toEqual([{ contextId: "ctx-1" }]);
    expect(deps.promptPacks).toBe(gateway.promptPackService);
    expect(deps.modelComparisons.listComparisons(1)).toEqual({ items: [] });
    expect(deps.realtimeEvents).toBe(gateway.realtimeEventService);
    expect(deps.runtimeLifecycle.getRuntimeLifecycle({ limit: 1 })).toEqual({ lifecycle: true });
    expect(deps.runtimeLifecycle.getTranscript("session-1")).toEqual([{ role: "user" }]);
    expect(deps.runtimeLifecycle.listSessionTimeline("session-1", 2)).toEqual([{ timelineId: "timeline-1" }]);
    expect(deps.sessionsList.summary("session-1")).toEqual({ sessionId: "session-1" });
    expect(deps.sessionsList.timeline("session-1")).toEqual([{ timelineId: "timeline-1" }]);
  });

  it.each(["ModelUsageSettlementError", "ModelUsageDispatchPersistenceError", "ModelUsageDispatchUncertainError"])(
    "does not hide Mason %s failures behind its best-effort fallback",
    async (faultName) => {
      const gateway = createGateway();
      const accountingFault = Object.assign(new Error("canonical accounting failed"), { name: faultName });
      gateway.llmService.chatCompletions.mockRejectedValueOnce(accountingFault);
      const deps = composeRuntimeAdminRouteDependencies(gateway as never) as any;

      await expect(deps.masonInterpret("extract answers", {})).rejects.toBe(accountingFault);
    },
  );

  it("keeps Mason's empty fallback for ordinary provider failures", async () => {
    const gateway = createGateway();
    gateway.llmService.chatCompletions.mockRejectedValueOnce(new Error("provider unavailable"));
    const deps = composeRuntimeAdminRouteDependencies(gateway as never) as any;

    await expect(deps.masonInterpret("extract answers", {})).resolves.toBe("");
  });
});

function createGateway() {
  return {
    config: {
      rootDir: "F:/code/personal-ai",
      assistant: {
        workspaceDir: "workspace",
        llamaCpp: { server: { baseUrl: "http://127.0.0.1:8080/v1" } },
      },
      toolPolicy: {
        sandbox: {
          readOnlyRoots: ["F:/code/personal-ai"],
          writeJailRoots: ["F:/code/personal-ai/workspace"],
        },
      },
    },
    approvalRuntime: { approvals: true },
    backupRetentionService: {
      getRetentionPolicy: vi.fn(() => ({ keepDays: 7 })),
      listBackups: vi.fn((limit: number) => [{ backupId: "backup-1", limit }]),
      pruneRetention: vi.fn(() => ({ pruned: true })),
      updateRetentionPolicy: vi.fn((patch: unknown) => patch),
      createBackup: vi.fn(() => ({ backupId: "created-backup" })),
    },
    cronAutomationService: { ping: () => "cron-ok" },
    databaseCutoverService: { getHealthSnapshot: vi.fn(() => ({ healthy: true })) },
    devDiagnostics: {
      isEnabled: vi.fn(() => true),
      list: vi.fn(() => [{ diagnosticId: "diag-1" }]),
      subscribe: vi.fn(() => "unsub"),
    },
    durableOperatorService: { durable: true },
    hooksService: { hooks: true },
    llamaCppRuntime: {
      status: () => "llama-ready",
      acquireLease: vi.fn(async () => ({ release: vi.fn() })),
    },
    llmService: {
      chatCompletions: vi.fn(async () => ({ choices: [{ message: { content: "{}" } }] })),
    },
    memoryLifecycleService: { listRunContexts: vi.fn(() => [{ contextId: "ctx-1" }]) },
    meshService: { status: () => ({ mesh: "online" }) },
    npuSidecar: { status: () => "npu-ready" },
    operatorSummaryCache: { snapshot: () => ({ operator: "ready" }) },
    policyEngine: {
      listCatalog: vi.fn(() => [{ name: "tool.a" }, { toolName: "tool.b" }, { id: "tool.c" }, {}]),
    },
    promptPackService: {
      listPromptPackTests: vi.fn(() => []),
      promptPacks: true,
    },
    realtimeEventService: {
      getRealtimeEventSequenceBounds: vi.fn(() => ({ newestSequence: 9 })),
    },
    runtimeLifecycleReadService: { getRuntimeLifecycle: vi.fn(() => ({ lifecycle: true })) },
    storage: {
      db: createDatabaseStub(),
      promptPackRuns: { listByTest: vi.fn(() => []) },
      systemSettings: { get: vi.fn() },
    },
    createApproval: vi.fn((input: unknown) => ({ approvalId: "approval-1", input })),
    createChatCompletion: vi.fn((input: unknown) => ({ id: "completion-1", input })),
    createChatCompletionStream: vi.fn(() => ["delta"]),
    createChatSession: vi.fn((input: unknown) => ({ sessionId: "session-1", input })),
    createOrchestrationPlan: vi.fn((plan: unknown) => ({ planId: "plan-1", plan })),
    getRun: vi.fn((runId: string) => ({ runId })),
    getRunTrace: vi.fn((runId: string) => ({ runId, trace: true })),
    getSessionSummary: vi.fn((sessionId: string) => ({ sessionId })),
    getTranscript: vi.fn(() => [{ role: "user" }]),
    ingestEvent: vi.fn(() => ({ ingested: true })),
    isFeatureEnabled: vi.fn((flag: string) => flag === "codeModeV1Enabled"),
    listRunCheckpoints: vi.fn(() => [{ checkpointId: "cp-1" }]),
    listSessionTimeline: vi.fn(() => [{ timelineId: "timeline-1" }]),
    listSkills: vi.fn(() => [{ skillId: "skill-1" }]),
    normalizeWorkspaceId: vi.fn((workspaceId?: string) => `workspace:${workspaceId?.trim() ?? "default"}`),
    publishRealtime: vi.fn(() => ({ eventId: "event-1" })),
    readSettingsRevision: vi.fn(() => 12),
    recordDevDiagnostic: vi.fn(),
    resolveGatewayInstallToken: vi.fn((input: unknown) => ({ ...(input as object), resolved: true })),
    runDatabaseCutover: vi.fn(() => ({ cutover: true })),
    runOrchestrationPlan: vi.fn((planId: string) => ({ runId: planId.replace("plan", "run") })),
    approvePhase: vi.fn(() => ({ approved: true })),
    verifyBackup: vi.fn(() => ({ verified: true })),
    verifyDatabaseCutover: vi.fn(() => ({ database: "ok" })),
  };
}

function createDatabaseStub() {
  return {
    exec: vi.fn(),
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => undefined),
      run: vi.fn(),
    })),
    transaction: vi.fn((_mode: string, callback: () => unknown) => callback()),
  };
}
