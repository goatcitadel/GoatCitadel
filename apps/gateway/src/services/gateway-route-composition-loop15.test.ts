import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAddonsRoutePort: vi.fn((deps: any) => ({
    publish: () => deps.publishRealtime("addon.changed", "addons", undefined),
    record: () => deps.recordDevDiagnostic({ event: "addon" }),
    service: deps.addonsService,
    slotService: deps.slotService,
  })),
  createCostsRoutePort: vi.fn((deps: any) => ({ storage: deps.storage })),
  getSettings: vi.fn((deps: unknown) => ({ method: "getSettings", deps })),
  getAuthRuntimeSettings: vi.fn((deps: unknown) => ({ method: "getAuthRuntimeSettings", deps })),
  updateSettings: vi.fn((deps: unknown, input: unknown) => ({ method: "updateSettings", deps, input })),
  createSettingsRuntimeDependenciesForGateway: vi.fn((gateway: any) => ({ settingsGateway: gateway })),
  createWorkspacesRoutePortForGateway: vi.fn((gateway: any) => ({
    createWorkspace: (input: unknown) => ({ method: "createWorkspace", gateway, input }),
  })),
  pickConnectorDiagnosticAction: vi.fn((checks: unknown) => ({ method: "pickConnectorDiagnosticAction", checks })),
  recordConnectorHealthRun: vi.fn((deps: unknown, report: unknown) => ({
    method: "recordConnectorHealthRun",
    deps,
    report,
  })),
  completeMcpOAuth: vi.fn(async (deps: any, serverId: string, code: string, state?: string) => {
    await deps.readMcpAuthState();
    await deps.writeMcpAuthState({ [serverId]: { code, state } });
    return {
      method: "completeMcpOAuth",
      deps,
      serverId,
      code,
      state,
    };
  }),
  connectMcpServer: vi.fn(async (deps: any, serverId: string) => {
    const server = await deps.requireMcpServer(serverId);
    await deps.patchMcpServerState(serverId, { status: "connected" });
    await deps.resolveConnectedMcpTools(server, await deps.readMcpTools());
    deps.publishRealtime("mcp.connected", "mcp", { serverId });
    return { method: "connectMcpServer", deps, serverId };
  }),
  createMcpServer: vi.fn(async (deps: any, input: unknown) => {
    await deps.writeMcpServers([...(await deps.readMcpServers()), input]);
    return { method: "createMcpServer", deps, input };
  }),
  deleteMcpServer: vi.fn(async (deps: unknown, serverId: string) => ({ method: "deleteMcpServer", deps, serverId })),
  disconnectMcpServer: vi.fn(async (deps: any, serverId: string) => {
    await deps.writeMcpTools(
      (await deps.readMcpTools()).filter((tool: { serverId?: string }) => tool.serverId !== serverId),
    );
    return {
      method: "disconnectMcpServer",
      deps,
      serverId,
    };
  }),
  startMcpOAuth: vi.fn(async (deps: unknown, serverId: string) => ({ method: "startMcpOAuth", deps, serverId })),
  updateMcpServer: vi.fn(async (deps: unknown, serverId: string, input: unknown) => ({
    method: "updateMcpServer",
    deps,
    serverId,
    input,
  })),
  updateMcpServerPolicy: vi.fn(async (deps: unknown, serverId: string, policy: unknown) => ({
    method: "updateMcpServerPolicy",
    deps,
    serverId,
    policy,
  })),
  listMcpTemplateDiscovery: vi.fn((deps: any) => {
    deps.requireFeatureEnabled("connectorDiagnosticsV1Enabled");
    deps.listMcpTemplates();
    deps.pickConnectorDiagnosticAction([{ status: "ok" }]);
    return { method: "listMcpTemplateDiscovery", deps };
  }),
  runMcpServerHealthCheck: vi.fn((deps: any, serverId: string) => {
    deps.requireMcpServer(serverId);
    deps.recordConnectorHealthRun({ serverId });
    return {
      method: "runMcpServerHealthCheck",
      deps,
      serverId,
    };
  }),
  KnowledgeFacadeService: vi.fn().mockImplementation(function (deps: any) {
    return {
      deps,
      knowledgeDocsIngest: (input: unknown) =>
        deps.invokeAndUnwrap({ toolName: "knowledge.docs.ingest", input }, "knowledge"),
    };
  }),
  SkillEvaluationService: vi.fn().mockImplementation(function (deps: any) {
    return {
      createSkillEvaluationProposal: (runId: string) => deps.createCapabilityProposal({ runId }),
      getSkillEvaluationRun: (runId: string) => ({ runId, storage: deps.storage }),
      listSkillEvaluationRuns: async (skillId: string) => [{ skillId, skills: await deps.listSkills() }],
      previewSkillEvaluation: (skillId: string, input: unknown) => ({ skillId, input, preview: true }),
      runSkillEvaluation: (skillId: string, input: unknown) => {
        deps.recordSkillEvaluationSignal({ skillId, input });
        return { skillId, input, run: true };
      },
    };
  }),
}));

vi.mock("./addons-route-service.js", () => ({ createAddonsRoutePort: mocks.createAddonsRoutePort }));
vi.mock("./costs-route-service.js", () => ({ createCostsRoutePort: mocks.createCostsRoutePort }));
vi.mock("./settings-auth-service.js", () => ({
  getAuthRuntimeSettings: mocks.getAuthRuntimeSettings,
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));
vi.mock("./gateway-route-composition-shared.js", () => ({
  DEFAULT_WORKSPACE_ID: "default",
  createSettingsRuntimeDependenciesForGateway: mocks.createSettingsRuntimeDependenciesForGateway,
  createWorkspacesRoutePortForGateway: mocks.createWorkspacesRoutePortForGateway,
  getLlmConfigForGateway: (gateway: any) =>
    gateway.llmService.getRuntimeConfig({ includeKeychainForActiveProvider: true, useCache: true }),
}));
vi.mock("./connector-diagnostics-helpers.js", () => ({
  pickConnectorDiagnosticAction: mocks.pickConnectorDiagnosticAction,
  recordConnectorHealthRun: mocks.recordConnectorHealthRun,
}));
vi.mock("./mcp-server-admin-service.js", () => ({
  completeMcpOAuth: mocks.completeMcpOAuth,
  connectMcpServer: mocks.connectMcpServer,
  createMcpServer: mocks.createMcpServer,
  deleteMcpServer: mocks.deleteMcpServer,
  disconnectMcpServer: mocks.disconnectMcpServer,
  startMcpOAuth: mocks.startMcpOAuth,
  updateMcpServer: mocks.updateMcpServer,
  updateMcpServerPolicy: mocks.updateMcpServerPolicy,
}));
vi.mock("./mcp-diagnostics-service.js", () => ({
  listMcpTemplateDiscovery: mocks.listMcpTemplateDiscovery,
  runMcpServerHealthCheck: mocks.runMcpServerHealthCheck,
}));
vi.mock("./memory-facade-service.js", () => ({ KnowledgeFacadeService: mocks.KnowledgeFacadeService }));
vi.mock("./skill-evaluation-service.js", () => ({ SkillEvaluationService: mocks.SkillEvaluationService }));

import { composeMemoryKnowledgeRouteDependencies } from "./gateway-route-composition-memory.js";
import { composeSystemRouteDependencies } from "./gateway-route-composition-system.js";
import { composeToolsMcpRouteDependencies } from "./gateway-route-composition-tools.js";

function fn<TArgs extends unknown[] = unknown[], TResult = unknown>(impl: (...args: TArgs) => TResult) {
  return vi.fn(impl);
}

function createGateway() {
  return {
    config: {
      rootDir: "F:/code/personal-ai",
      assistant: { deploymentProfile: "local_dev" },
    },
    storage: {
      approvalInbox: { list: fn(() => []) },
      chatSessionMeta: {
        get: fn((sessionId: string) =>
          sessionId === "missing" ? undefined : { sessionId, workspaceId: "workspace-a" },
        ),
      },
      db: createDatabaseStub(),
      gatewaySql: { prepare: fn(() => ({ run: fn(() => undefined) })) },
    },
    addonsService: { list: fn(() => []) },
    addonSlotService: {
      findSlotsForRoute: fn(() => []),
      listAllRegistrations: fn(() => []),
      registerDeclarations: fn(() => undefined),
      unregister: fn(() => undefined),
    },
    approvalRuntime: {
      createToolGrant: fn((input: unknown) => ({ input, grantId: "grant-1" })),
      listToolGrants: fn((scope: string, scopeRef: string, limit?: number) => [{ scope, scopeRef, limit }]),
      revokeToolGrant: fn((grantId: string, revokedBy: string) => ({ grantId, revoked: true, revokedBy })),
    },
    assemblyService: {
      createRun: fn((input: unknown) => ({ input, runId: "assembly-1" })),
      getRunDetail: fn((runId: string) => ({ runId })),
      listReputations: fn((limit?: number) => [{ limit }]),
      listRuns: fn((limit?: number) => [{ limit, runId: "assembly-1" }]),
    },
    autonomyControlService: {
      getStatus: fn((recentLimit?: number) => ({ revision: 8, recentLimit })),
      revertAutonomousChangesSince: fn((sinceIso: string, opts?: unknown) => ({ sinceIso, opts })),
      setKillSwitch: fn(async (disabled: boolean, expectedRevision: number) => ({
        revision: expectedRevision + 1,
        killSwitchEngaged: disabled,
      })),
    },
    capabilityPackService: {
      installLocalPack: fn((input: unknown) => ({ input, local: true })),
      installPack: fn((packId: string, input: unknown) => ({ packId, input })),
      materializeStagedPack: fn((evidenceEnvelopeId: string, input: unknown) => ({ evidenceEnvelopeId, input })),
      listPacks: fn(() => [{ packId: "pack-1" }]),
      previewLocalPack: fn((manifest: unknown) => ({ manifest, localPreview: true })),
      previewPack: fn((packId: string) => ({ packId, preview: true })),
    },
    capabilitySystemService: {
      createProposal: fn((input: unknown) => ({ input, proposalId: "proposal-1" })),
      listCatalog: fn((scope?: string) => [{ scope }]),
      listProposals: fn((limit?: number) => [{ limit }]),
    },
    evidenceEnvelopeService: { listEnvelopes: fn((input: unknown) => ({ input, items: [] })) },
    improvementService: {
      recordSkillEvaluationSignal: fn((input: unknown) => ({ input })),
    },
    llmService: {
      clearInlineProviderApiKey: fn((providerId: string) => ({ providerId })),
      deleteOpenAICodexOAuthCredential: fn(() => ({ deleted: true })),
      exportConfigFile: fn(() => ({ providers: [{ providerId: "openai" }] })),
      generateImage: fn((input: unknown, _attribution?: unknown) => ({ input, imageId: "image-1" })),
      getOpenAICodexOAuthStatus: fn(() => ({ connected: true })),
      getProviderSecretStatus: fn((providerId: string) => ({
        providerId,
        hasApiKey: true,
        apiKeySource: "env",
      })),
      getRuntimeConfig: fn((options: unknown) => ({ activeProviderId: "openai", options })),
      listModelsWithSource: fn((providerId?: string) => [{ providerId, model: "gpt" }]),
      listProviders: fn(() => [{ providerId: "openai" }]),
      pollOpenAICodexOAuthDeviceFlow: fn((flowId: string) => ({ flowId, status: "pending" })),
      previewModels: fn((input: unknown) => ({ input, models: [] })),
      startOpenAICodexOAuthDeviceFlow: fn(() => ({ flowId: "flow-1" })),
      updateRuntimeConfig: fn((input: unknown) => ({ input, updated: true })),
    },
    mediaVoiceService: { status: fn(() => "ready") },
    memoryLifecycleService: { status: fn(() => "memory") },
    personalityCatalogService: {
      createPersonality: fn((input: unknown) => ({ input })),
      deletePersonality: fn((id: string) => ({ id, deleted: true })),
      getCatalog: fn(() => [{ id: "default" }]),
      setDefaultPersonality: fn((id: string) => ({ id })),
      updatePersonality: fn((id: string, input: unknown) => ({ id, input })),
    },
    policyEngine: {
      evaluateAccess: fn((input: unknown) => ({ input, allowed: true })),
      listCatalog: fn(() => [{ name: "browser.search" }]),
    },
    taskLifecycleService: { list: fn(() => []) },
    invokeMcpTool: fn((input: unknown) => ({ input, mcp: true })),
    toolInvocationCoordinator: {
      invokeMcpTool: fn((input: unknown) => ({ input, mcp: true })),
    },
    bulkSetSkillState: fn(
      (skillIds: string[], state: string, note: string | undefined, expectedRevisionsBySkillId: unknown) => [
        { skillIds, state, note, expectedRevisionsBySkillId },
      ],
    ),
    createChatCompletion: fn((request: unknown, _attribution?: unknown) => ({ request, id: "completion-1" })),
    evaluateToolAccess: fn((input: unknown) => ({ input, allowed: true })),
    getSkillActivationPolicy: fn(() => ({ defaultState: "enabled" })),
    installSkillImport: fn((input: unknown) => ({ input, installed: true })),
    invokeAndUnwrap: fn((request: unknown, realtimeType?: string) => ({ request, realtimeType })),
    invokeTool: fn((input: unknown) => ({ input, tool: true })),
    isFeatureEnabled: fn((flag: string) => flag === "computerUseGuardrailsV1Enabled"),
    listMcpServers: fn(async () => [{ serverId: "server-1" }]),
    listMcpTemplates: fn(async () => [{ templateId: "template-1" }]),
    listMcpTools: fn(async (serverId: string) => [{ serverId, toolName: "tool-1" }]),
    listSkillImportHistory: fn((limit?: number) => [{ limit }]),
    listSkillSources: fn((query?: string, limit?: number) => ({ query, limit, items: [] })),
    listSkills: fn(() => [{ skillId: "skill-1" }]),
    lookupSkillSources: fn((queryOrUrl: string, limit?: number) => ({ queryOrUrl, limit, items: [] })),
    patchMcpServerState: fn(async (serverId: string, patch: unknown) => ({ serverId, patch })),
    persistLlmConfig: fn(() => undefined),
    deleteProviderSecret: fn(async (input: unknown) => ({ method: "deleteProviderSecret", input })),
    saveProviderSecret: fn(async (input: unknown) => ({ method: "saveProviderSecret", input })),
    updateSettings: fn(async (input: any) =>
      input.llm ? { revision: 9, llm: { input: input.llm, updated: true } } : { method: "updateSettings", input },
    ),
    readSettingsRevision: fn(() => 8),
    publishRealtime: fn((eventType: string, source: string, payload?: unknown) => ({ eventType, source, payload })),
    readMcpAuthState: fn(async () => ({ "server-1": { state: "connected" } })),
    readMcpServers: fn(async () => [{ serverId: "server-1" }]),
    readMcpTools: fn(async () => [{ serverId: "server-1", toolName: "tool-1" }]),
    recordDevDiagnostic: fn((input: unknown) => ({ input })),
    reloadSkills: fn(() => [{ skillId: "skill-1", reloaded: true }]),
    requireFeatureEnabled: fn((flag: string) => ({ flag })),
    requireMcpServer: fn(async (serverId: string) => ({ serverId })),
    resolveConnectedMcpTools: fn(async (server: unknown, existing: unknown) => ({ server, existing })),
    resolveSkillActivation: fn((input: unknown) => ({ input, resolved: true })),
    setSkillState: fn((skillId: string, state: string, note: string | undefined, expectedRevision: number) => ({
      skillId,
      state,
      note,
      expectedRevision,
    })),
    updateSkillActivationPolicy: fn((input: unknown, expectedRevision: number) => ({
      input,
      expectedRevision,
      updated: true,
    })),
    validateSkillImport: fn((input: unknown) => ({ input, valid: true })),
    listCuratorStatus: fn(() => ({ generatedAt: "2026-05-16T00:00:00Z", cycleDays: 7, items: [] })),
    archiveCuratorSkill: fn((input: unknown) => ({ input, archived: true })),
    pruneCuratorSkill: fn((input: unknown) => ({ input, pruned: true })),
    listCuratorArchived: fn(() => ({ generatedAt: "2026-05-16T00:00:00Z", items: [] })),
    runCurator: fn(async (input: unknown) => ({ input, runId: "curator-run-1" })),
    writeMcpAuthState: fn(async (state: unknown) => ({ state })),
    writeMcpServers: fn(async (servers: unknown) => ({ servers })),
    writeMcpTools: fn(async (tools: unknown) => ({ tools })),
  };
}

function createDatabaseStub() {
  return {
    exec: fn(() => undefined),
    prepare: fn(() => ({
      all: fn(() => []),
      get: fn(() => undefined),
      run: fn(() => undefined),
    })),
    transaction: fn((_mode: string, callback: () => unknown) => callback()),
  };
}

describe("route composition loop 15 delegates", () => {
  it("propagates the config-generation read fence through settings and LLM route composition", async () => {
    const gateway = createGateway();
    const fence = new Error("settings generation is reconciling");
    gateway.readSettingsRevision.mockImplementation(() => {
      throw fence;
    });
    mocks.getSettings.mockImplementationOnce((deps: any) => deps.settingsGateway.readSettingsRevision());

    const systemDeps = composeSystemRouteDependencies(gateway as never) as any;
    const toolsDeps = composeToolsMcpRouteDependencies(gateway as never) as any;

    await expect(systemDeps.settings.getSettings()).rejects.toThrow(fence);
    expect(() => systemDeps.settings.getAuthRuntimeSettings()).toThrow(fence);
    expect(() => toolsDeps.llm.getLlmConfigWithDetails()).toThrow(fence);
  });

  it("wires system route dependencies to runtime services and settings helpers", async () => {
    const gateway = createGateway();
    const deps = composeSystemRouteDependencies(gateway as never) as any;

    expect(deps.addons.service).toBe(gateway.addonsService);
    expect(deps.addons.publish()).toEqual({ eventType: "addon.changed", source: "addons", payload: {} });
    expect(deps.addons.record()).toEqual({ input: { event: "addon" } });
    expect(deps.assembly.createAssemblyRun({ goal: "ship" })).toEqual({ input: { goal: "ship" }, runId: "assembly-1" });
    expect(deps.assembly.getAssemblyRunDetail("run-1")).toEqual({ runId: "run-1" });
    expect(deps.assembly.listAssemblyReputations(3)).toEqual([{ limit: 3 }]);
    expect(deps.assembly.listAssemblyRuns(2)).toEqual([{ limit: 2, runId: "assembly-1" }]);
    await expect(deps.autonomyControl.setKillSwitch(false, 8)).resolves.toEqual({
      revision: 9,
      killSwitchEngaged: false,
    });
    expect(gateway.autonomyControlService.setKillSwitch).toHaveBeenCalledWith(false, 8);
    expect(deps.costs.storage).toBe(gateway.storage);
    expect(deps.media).toBe(gateway.mediaVoiceService);
    expect(deps.settings.createPersonality({ name: "Guide" })).toEqual({ input: { name: "Guide" } });
    expect(deps.settings.deletePersonality("guide")).toEqual({ id: "guide", deleted: true });
    expect(await deps.settings.getAuthRuntimeSettings()).toMatchObject({ method: "getAuthRuntimeSettings" });
    expect(deps.settings.getPersonalityCatalog()).toEqual([{ id: "default" }]);
    expect(await deps.settings.getSettings()).toMatchObject({ method: "getSettings" });
    expect(deps.settings.setDefaultPersonality("guide")).toEqual({ id: "guide" });
    expect(deps.settings.updatePersonality("guide", { tone: "direct" })).toEqual({
      id: "guide",
      input: { tone: "direct" },
    });
    await expect(deps.settings.updateSettings({ deploymentProfile: "trusted_local" })).resolves.toMatchObject({
      method: "updateSettings",
      input: { deploymentProfile: "trusted_local" },
    });
    expect(deps.tasks).toBe(gateway.taskLifecycleService);
    expect(deps.voice).toBe(gateway.mediaVoiceService);
    expect(await deps.workspaces.createWorkspace({ name: "Ops" })).toMatchObject({ method: "createWorkspace" });
  });

  it("wires memory, knowledge, capability, improvement, and skill route dependencies", async () => {
    const gateway = createGateway();
    const deps = composeMemoryKnowledgeRouteDependencies(gateway as never) as any;

    expect(deps.capabilities).toBe(gateway.capabilitySystemService);
    expect(deps.capabilityPacks.installPack("pack-1", { workspaceId: "default" })).toEqual({
      packId: "pack-1",
      input: { workspaceId: "default" },
    });
    expect(deps.capabilityPacks.installLocalPack({ manifest: { packId: "local" } })).toEqual({
      input: { manifest: { packId: "local" } },
      local: true,
    });
    expect(deps.capabilityPacks.materializeStagedPack("env-1", { confirmReview: true })).toEqual({
      evidenceEnvelopeId: "env-1",
      input: { confirmReview: true },
    });
    expect(deps.capabilityPacks.listPacks()).toEqual([{ packId: "pack-1" }]);
    expect(deps.capabilityPacks.previewLocalPack({ packId: "local" })).toEqual({
      manifest: { packId: "local" },
      localPreview: true,
    });
    expect(deps.capabilityPacks.previewPack("pack-1")).toEqual({ packId: "pack-1", preview: true });
    expect(deps.curator.listCuratorStatus()).toMatchObject({ cycleDays: 7 });
    expect(deps.curator.archiveCuratorSkill({ skillId: "skill-1", confirm: true })).toMatchObject({ archived: true });
    expect(deps.curator.pruneCuratorSkill({ skillId: "skill-1", confirm: true })).toMatchObject({ pruned: true });
    expect(deps.curator.listCuratorArchived()).toMatchObject({ items: [] });
    expect(deps.evidence.listEnvelopes({ limit: 1 })).toEqual({ input: { limit: 1 }, items: [] });
    expect(await deps.improvement.audit.getSkillActivationPolicy()).toEqual({ defaultState: "enabled" });
    expect(await deps.improvement.audit.listCapabilityCatalog("chat")).toEqual([{ scope: "chat" }]);
    expect(await deps.improvement.audit.listCapabilityProposals(4)).toEqual([{ limit: 4 }]);
    expect(await deps.improvement.audit.listSkillImportHistory(5)).toEqual([{ limit: 5 }]);
    expect(await deps.improvement.audit.listSkills()).toEqual([{ skillId: "skill-1" }]);
    expect(deps.improvement.improvement).toBe(gateway.improvementService);
    expect(deps.knowledge.knowledgeDocsIngest({ source: "doc" })).toMatchObject({ realtimeType: "knowledge" });
    expect(deps.memory).toBe(gateway.memoryLifecycleService);
    expect(await deps.skills.bulkSetSkillState(["skill-1"], "disabled", "test", { "skill-1": 3 })).toEqual([
      {
        skillIds: ["skill-1"],
        state: "disabled",
        note: "test",
        expectedRevisionsBySkillId: { "skill-1": 3 },
      },
    ]);
    expect(await deps.skills.getSkillActivationPolicy()).toEqual({ defaultState: "enabled" });
    expect(await deps.skills.installSkillImport({ url: "https://example.test" })).toEqual({
      input: { url: "https://example.test" },
      installed: true,
    });
    expect(await deps.skills.listSkillEvaluationRuns("skill-1")).toEqual({
      items: [{ skillId: "skill-1", skills: [{ skillId: "skill-1" }] }],
    });
    expect(await deps.skills.listSkillImportHistory(2)).toEqual([{ limit: 2 }]);
    expect(await deps.skills.listSkillSources("browser", 3)).toEqual({ query: "browser", limit: 3, items: [] });
    expect(await deps.skills.listSkills()).toEqual([{ skillId: "skill-1" }]);
    expect(await deps.skills.lookupSkillSources("browser", 4)).toEqual({ queryOrUrl: "browser", limit: 4, items: [] });
    expect(await deps.skills.previewSkillEvaluation("skill-1", { rubric: "strict" })).toEqual({
      run: { skillId: "skill-1", input: { rubric: "strict" }, preview: true },
    });
    expect(await deps.skills.runSkillEvaluation("skill-1", { rubric: "strict" })).toEqual({
      skillId: "skill-1",
      input: { rubric: "strict" },
      run: true,
    });
    expect(await deps.skills.getSkillEvaluationRun("run-1")).toMatchObject({ runId: "run-1" });
    expect(await deps.skills.createSkillEvaluationProposal("run-1")).toMatchObject({ proposalId: "proposal-1" });
    expect(await deps.skills.reloadSkills()).toEqual([{ skillId: "skill-1", reloaded: true }]);
    expect(await deps.skills.resolveSkillActivation({ skillId: "skill-1" })).toEqual({
      input: { skillId: "skill-1" },
      resolved: true,
    });
    expect(await deps.skills.setSkillState("skill-1", "enabled", "ok", 3)).toEqual({
      skillId: "skill-1",
      state: "enabled",
      note: "ok",
      expectedRevision: 3,
    });
    expect(await deps.skills.updateSkillActivationPolicy({ defaultState: "disabled" }, 5)).toEqual({
      input: { defaultState: "disabled" },
      expectedRevision: 5,
      updated: true,
    });
    expect(await deps.skills.validateSkillImport({ url: "https://example.test" })).toEqual({
      input: { url: "https://example.test" },
      valid: true,
    });
  });

  it("wires tools, MCP, LLM, secret, and tool-invocation route dependencies", async () => {
    const gateway = createGateway();
    const deps = composeToolsMcpRouteDependencies(gateway as never) as any;
    const attribution = { workspaceId: "workspace-a", operationId: "route-operation-1" };

    expect(deps.llm.createChatCompletion({ messages: [] }, attribution)).toEqual({
      request: { messages: [] },
      id: "completion-1",
    });
    expect(gateway.createChatCompletion).toHaveBeenCalledWith({ messages: [] }, attribution);
    expect(deps.llm.generateImage({ prompt: "ship" }, attribution)).toEqual({
      input: { prompt: "ship" },
      imageId: "image-1",
    });
    expect(gateway.llmService.generateImage).toHaveBeenCalledWith({ prompt: "ship" }, attribution);
    expect(deps.llm.getOpenAICodexOAuthStatus()).toEqual({ connected: true });
    expect(deps.llm.getLlmConfigWithDetails()).toMatchObject({
      activeProviderId: "openai",
      providerConfigs: [{ providerId: "openai" }],
    });
    expect(deps.llm.listLlmModels("openai")).toEqual([{ providerId: "openai", model: "gpt" }]);
    expect(deps.llm.listLlmProviders()).toEqual([{ providerId: "openai" }]);
    expect(deps.llm.pollOpenAICodexOAuthDeviceFlow("flow-1")).toEqual({ flowId: "flow-1", status: "pending" });
    expect(deps.llm.previewLlmModels({ providerId: "openai" })).toEqual({
      input: { providerId: "openai" },
      models: [],
    });
    expect(deps.llm.startOpenAICodexOAuthDeviceFlow()).toEqual({ flowId: "flow-1" });
    expect(deps.llm.deleteOpenAICodexOAuthCredential()).toEqual({ deleted: true });
    await expect(deps.llm.updateLlmConfig({ expectedRevision: 8, activeProviderId: "openai" })).resolves.toEqual({
      revision: 9,
      input: { activeProviderId: "openai" },
      updated: true,
    });
    expect(gateway.updateSettings).toHaveBeenCalledWith({
      expectedRevision: 8,
      llm: { activeProviderId: "openai" },
    });

    await expect(deps.mcp.completeMcpOAuth("server-1", "code", "state")).resolves.toMatchObject({
      method: "completeMcpOAuth",
    });
    await expect(deps.mcp.connectMcpServer("server-1")).resolves.toMatchObject({ method: "connectMcpServer" });
    await expect(deps.mcp.createMcpServer({ label: "Server" })).resolves.toMatchObject({
      method: "createMcpServer",
    });
    await expect(deps.mcp.deleteMcpServer("server-1")).resolves.toMatchObject({ method: "deleteMcpServer" });
    await expect(deps.mcp.disconnectMcpServer("server-1")).resolves.toMatchObject({
      method: "disconnectMcpServer",
    });
    expect(deps.mcp.invokeMcpTool({ serverId: "server-1" })).toEqual({
      input: { serverId: "server-1" },
      mcp: true,
    });
    await expect(deps.mcp.listMcpServers()).resolves.toEqual([{ serverId: "server-1" }]);
    await expect(deps.mcp.listMcpTemplateDiscovery()).resolves.toMatchObject({
      method: "listMcpTemplateDiscovery",
    });
    await expect(deps.mcp.listMcpTemplates()).resolves.toEqual([{ templateId: "template-1" }]);
    await expect(deps.mcp.listMcpTools("server-1")).resolves.toEqual([{ serverId: "server-1", toolName: "tool-1" }]);
    await expect(deps.mcp.runMcpServerHealthCheck("server-1")).resolves.toMatchObject({
      method: "runMcpServerHealthCheck",
    });
    await expect(deps.mcp.startMcpOAuth("server-1")).resolves.toMatchObject({ method: "startMcpOAuth" });
    await expect(deps.mcp.updateMcpServer("server-1", { label: "new" })).resolves.toMatchObject({
      method: "updateMcpServer",
    });
    await expect(deps.mcp.updateMcpServerPolicy("server-1", { allowed: true })).resolves.toMatchObject({
      method: "updateMcpServerPolicy",
    });

    await expect(deps.secrets.deleteProviderSecret("openai", 8, "all")).resolves.toEqual({
      method: "deleteProviderSecret",
      input: { providerId: "openai", expectedRevision: 8, storage: "all" },
    });
    expect(deps.secrets.getProviderSecretStatus("openai")).toEqual({
      providerId: "openai",
      hasSecret: true,
      source: "env",
    });
    await expect(deps.secrets.saveProviderSecret("openai", "secret", 8, "env", "OPENAI_API_KEY")).resolves.toEqual({
      method: "saveProviderSecret",
      input: {
        providerId: "openai",
        apiKey: "secret",
        expectedRevision: 8,
        storage: "env",
        envVar: "OPENAI_API_KEY",
      },
    });
    expect(gateway.persistLlmConfig).not.toHaveBeenCalled();

    expect(deps.tools.createToolGrant({ scope: "session" })).toEqual({
      input: { scope: "session" },
      grantId: "grant-1",
    });
    await expect(
      deps.tools.evaluateToolAccess({ sessionId: "session-1", toolName: "browser.search" }),
    ).resolves.toMatchObject({
      allowed: true,
      input: { sessionId: "session-1", toolName: "browser.search", workspaceId: "workspace-a" },
    });
    await expect(
      deps.tools.evaluateToolAccess({ sessionId: "missing", toolName: "browser.search", workspaceId: "explicit" }),
    ).resolves.toMatchObject({
      input: { sessionId: "missing", toolName: "browser.search", workspaceId: "explicit" },
    });
    await expect(
      deps.tools.evaluateToolAccess({ sessionId: "missing", toolName: "browser.search" }),
    ).resolves.toMatchObject({
      input: { sessionId: "missing", toolName: "browser.search", workspaceId: "default" },
    });
    expect(deps.tools.listToolCatalog()).toEqual([{ name: "browser.search" }]);
    expect(deps.tools.listToolGrants("session", "session-1", 9)).toEqual([
      { scope: "session", scopeRef: "session-1", limit: 9 },
    ]);
    expect(deps.tools.revokeToolGrant("grant-1", "operator-test")).toEqual({
      grantId: "grant-1",
      revoked: true,
      revokedBy: "operator-test",
    });
    expect(deps.toolsInvoke.getDeploymentProfile()).toBe("local_dev");
    expect(deps.toolsInvoke.invokeTool({ toolName: "browser.search" })).toEqual({
      input: { toolName: "browser.search" },
      tool: true,
    });
    expect(deps.toolsInvoke.isFeatureEnabled("computerUseGuardrailsV1Enabled")).toBe(true);
  });
});
