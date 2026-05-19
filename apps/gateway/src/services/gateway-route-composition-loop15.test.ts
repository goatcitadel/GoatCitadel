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
  deleteProviderApiKeyWithFallback: vi.fn((input: unknown) => ({ method: "deleteProviderApiKeyWithFallback", input })),
  persistProviderApiKeyWithFallback: vi.fn((input: unknown) => ({
    method: "persistProviderApiKeyWithFallback",
    input,
  })),
  pickConnectorDiagnosticAction: vi.fn((checks: unknown) => ({ method: "pickConnectorDiagnosticAction", checks })),
  recordConnectorHealthRun: vi.fn((deps: unknown, report: unknown) => ({
    method: "recordConnectorHealthRun",
    deps,
    report,
  })),
  completeMcpOAuth: vi.fn((deps: any, serverId: string, code: string, state?: string) => {
    deps.readMcpAuthState();
    deps.writeMcpAuthState({ [serverId]: { code, state } });
    return {
      method: "completeMcpOAuth",
      deps,
      serverId,
      code,
      state,
    };
  }),
  connectMcpServer: vi.fn((deps: any, serverId: string) => {
    const server = deps.requireMcpServer(serverId);
    deps.patchMcpServerState(serverId, { status: "connected" });
    deps.resolveConnectedMcpTools(server, deps.readMcpTools());
    deps.publishRealtime("mcp.connected", "mcp", { serverId });
    return { method: "connectMcpServer", deps, serverId };
  }),
  createMcpServer: vi.fn((deps: any, input: unknown) => {
    deps.writeMcpServers([...deps.readMcpServers(), input]);
    return { method: "createMcpServer", deps, input };
  }),
  deleteMcpServer: vi.fn((deps: unknown, serverId: string) => ({ method: "deleteMcpServer", deps, serverId })),
  disconnectMcpServer: vi.fn((deps: any, serverId: string) => {
    deps.writeMcpTools(deps.readMcpTools().filter((tool: { serverId?: string }) => tool.serverId !== serverId));
    return {
      method: "disconnectMcpServer",
      deps,
      serverId,
    };
  }),
  startMcpOAuth: vi.fn((deps: unknown, serverId: string) => ({ method: "startMcpOAuth", deps, serverId })),
  updateMcpServer: vi.fn((deps: unknown, serverId: string, input: unknown) => ({
    method: "updateMcpServer",
    deps,
    serverId,
    input,
  })),
  updateMcpServerPolicy: vi.fn((deps: unknown, serverId: string, policy: unknown) => ({
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
  KnowledgeFacadeService: vi.fn().mockImplementation((deps: any) => ({
    deps,
    knowledgeDocsIngest: (input: unknown) =>
      deps.invokeAndUnwrap({ toolName: "knowledge.docs.ingest", input }, "knowledge"),
  })),
  SkillEvaluationService: vi.fn().mockImplementation((deps: any) => ({
    createSkillEvaluationProposal: (runId: string) => deps.createCapabilityProposal({ runId }),
    getSkillEvaluationRun: (runId: string) => ({ runId, storage: deps.storage }),
    listSkillEvaluationRuns: (skillId: string) => [{ skillId, skills: deps.listSkills() }],
    previewSkillEvaluation: (skillId: string, input: unknown) => ({ skillId, input, preview: true }),
    runSkillEvaluation: (skillId: string, input: unknown) => {
      deps.recordSkillEvaluationSignal({ skillId, input });
      return { skillId, input, run: true };
    },
  })),
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
vi.mock("./provider-secret-persistence.js", () => ({
  deleteProviderApiKeyWithFallback: mocks.deleteProviderApiKeyWithFallback,
  persistProviderApiKeyWithFallback: mocks.persistProviderApiKeyWithFallback,
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
    capabilityPackService: {
      installPack: fn((packId: string, input: unknown) => ({ packId, input })),
      listPacks: fn(() => [{ packId: "pack-1" }]),
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
      generateImage: fn((input: unknown) => ({ input, imageId: "image-1" })),
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
    toolInvocationCoordinator: {
      invokeMcpTool: fn((input: unknown) => ({ input, mcp: true })),
    },
    bulkSetSkillState: fn((skillIds: string[], state: string, note?: string) => [{ skillIds, state, note }]),
    createChatCompletion: fn((request: unknown) => ({ request, id: "completion-1" })),
    evaluateToolAccess: fn((input: unknown) => ({ input, allowed: true })),
    getSkillActivationPolicy: fn(() => ({ defaultState: "enabled" })),
    installSkillImport: fn((input: unknown) => ({ input, installed: true })),
    invokeAndUnwrap: fn((request: unknown, realtimeType?: string) => ({ request, realtimeType })),
    invokeTool: fn((input: unknown) => ({ input, tool: true })),
    isFeatureEnabled: fn((flag: string) => flag === "computerUseGuardrailsV1Enabled"),
    listMcpServers: fn(() => [{ serverId: "server-1" }]),
    listMcpTemplates: fn(() => [{ templateId: "template-1" }]),
    listMcpTools: fn((serverId: string) => [{ serverId, toolName: "tool-1" }]),
    listSkillImportHistory: fn((limit?: number) => [{ limit }]),
    listSkillSources: fn((query?: string, limit?: number) => ({ query, limit, items: [] })),
    listSkills: fn(() => [{ skillId: "skill-1" }]),
    lookupSkillSources: fn((queryOrUrl: string, limit?: number) => ({ queryOrUrl, limit, items: [] })),
    patchMcpServerState: fn((serverId: string, patch: unknown) => ({ serverId, patch })),
    persistLlmConfig: fn(() => undefined),
    publishRealtime: fn((eventType: string, source: string, payload?: unknown) => ({ eventType, source, payload })),
    readMcpAuthState: fn(() => ({ "server-1": { state: "connected" } })),
    readMcpServers: fn(() => [{ serverId: "server-1" }]),
    readMcpTools: fn(() => [{ serverId: "server-1", toolName: "tool-1" }]),
    recordDevDiagnostic: fn((input: unknown) => ({ input })),
    reloadSkills: fn(() => [{ skillId: "skill-1", reloaded: true }]),
    requireFeatureEnabled: fn((flag: string) => ({ flag })),
    requireMcpServer: fn((serverId: string) => ({ serverId })),
    resolveConnectedMcpTools: fn((server: unknown, existing: unknown) => ({ server, existing })),
    resolveSkillActivation: fn((input: unknown) => ({ input, resolved: true })),
    setSkillState: fn((skillId: string, state: string, note?: string) => ({ skillId, state, note })),
    updateSkillActivationPolicy: fn((input: unknown) => ({ input, updated: true })),
    validateSkillImport: fn((input: unknown) => ({ input, valid: true })),
    listCuratorStatus: fn(() => ({ generatedAt: "2026-05-16T00:00:00Z", cycleDays: 7, items: [] })),
    archiveCuratorSkill: fn((input: unknown) => ({ input, archived: true })),
    pruneCuratorSkill: fn((input: unknown) => ({ input, pruned: true })),
    listCuratorArchived: fn(() => ({ generatedAt: "2026-05-16T00:00:00Z", items: [] })),
    runCurator: fn(async (input: unknown) => ({ input, runId: "curator-run-1" })),
    writeMcpAuthState: fn((state: unknown) => ({ state })),
    writeMcpServers: fn((servers: unknown) => ({ servers })),
    writeMcpTools: fn((tools: unknown) => ({ tools })),
  };
}

describe("route composition loop 15 delegates", () => {
  it("wires system route dependencies to runtime services and settings helpers", () => {
    const gateway = createGateway();
    const deps = composeSystemRouteDependencies(gateway as never) as any;

    expect(deps.addons.service).toBe(gateway.addonsService);
    expect(deps.addons.publish()).toEqual({ eventType: "addon.changed", source: "addons", payload: {} });
    expect(deps.addons.record()).toEqual({ input: { event: "addon" } });
    expect(deps.assembly.createAssemblyRun({ goal: "ship" })).toEqual({ input: { goal: "ship" }, runId: "assembly-1" });
    expect(deps.assembly.getAssemblyRunDetail("run-1")).toEqual({ runId: "run-1" });
    expect(deps.assembly.listAssemblyReputations(3)).toEqual([{ limit: 3 }]);
    expect(deps.assembly.listAssemblyRuns(2)).toEqual([{ limit: 2, runId: "assembly-1" }]);
    expect(deps.costs.storage).toBe(gateway.storage);
    expect(deps.media).toBe(gateway.mediaVoiceService);
    expect(deps.settings.createPersonality({ name: "Guide" })).toEqual({ input: { name: "Guide" } });
    expect(deps.settings.deletePersonality("guide")).toEqual({ id: "guide", deleted: true });
    expect(deps.settings.getAuthRuntimeSettings()).toMatchObject({ method: "getAuthRuntimeSettings" });
    expect(deps.settings.getPersonalityCatalog()).toEqual([{ id: "default" }]);
    expect(deps.settings.getSettings()).toMatchObject({ method: "getSettings" });
    expect(deps.settings.setDefaultPersonality("guide")).toEqual({ id: "guide" });
    expect(deps.settings.updatePersonality("guide", { tone: "direct" })).toEqual({
      id: "guide",
      input: { tone: "direct" },
    });
    expect(deps.settings.updateSettings({ deploymentProfile: "trusted_local" })).toMatchObject({
      method: "updateSettings",
      input: { deploymentProfile: "trusted_local" },
    });
    expect(deps.tasks).toBe(gateway.taskLifecycleService);
    expect(deps.voice).toBe(gateway.mediaVoiceService);
    expect(deps.workspaces.createWorkspace({ name: "Ops" })).toMatchObject({ method: "createWorkspace" });
  });

  it("wires memory, knowledge, capability, improvement, and skill route dependencies", () => {
    const gateway = createGateway();
    const deps = composeMemoryKnowledgeRouteDependencies(gateway as never) as any;

    expect(deps.capabilities).toBe(gateway.capabilitySystemService);
    expect(deps.capabilityPacks.installPack("pack-1", { workspaceId: "default" })).toEqual({
      packId: "pack-1",
      input: { workspaceId: "default" },
    });
    expect(deps.capabilityPacks.listPacks()).toEqual([{ packId: "pack-1" }]);
    expect(deps.capabilityPacks.previewPack("pack-1")).toEqual({ packId: "pack-1", preview: true });
    expect(deps.curator.listCuratorStatus()).toMatchObject({ cycleDays: 7 });
    expect(deps.curator.archiveCuratorSkill({ skillId: "skill-1", confirm: true })).toMatchObject({ archived: true });
    expect(deps.curator.pruneCuratorSkill({ skillId: "skill-1", confirm: true })).toMatchObject({ pruned: true });
    expect(deps.curator.listCuratorArchived()).toMatchObject({ items: [] });
    expect(deps.evidence.listEnvelopes({ limit: 1 })).toEqual({ input: { limit: 1 }, items: [] });
    expect(deps.improvement.audit.getSkillActivationPolicy()).toEqual({ defaultState: "enabled" });
    expect(deps.improvement.audit.listCapabilityCatalog("chat")).toEqual([{ scope: "chat" }]);
    expect(deps.improvement.audit.listCapabilityProposals(4)).toEqual([{ limit: 4 }]);
    expect(deps.improvement.audit.listSkillImportHistory(5)).toEqual([{ limit: 5 }]);
    expect(deps.improvement.audit.listSkills()).toEqual([{ skillId: "skill-1" }]);
    expect(deps.improvement.improvement).toBe(gateway.improvementService);
    expect(deps.knowledge.knowledgeDocsIngest({ source: "doc" })).toMatchObject({ realtimeType: "knowledge" });
    expect(deps.memory).toBe(gateway.memoryLifecycleService);
    expect(deps.skills.bulkSetSkillState(["skill-1"], "disabled", "test")).toEqual([
      { skillIds: ["skill-1"], state: "disabled", note: "test" },
    ]);
    expect(deps.skills.getSkillActivationPolicy()).toEqual({ defaultState: "enabled" });
    expect(deps.skills.installSkillImport({ url: "https://example.test" })).toEqual({
      input: { url: "https://example.test" },
      installed: true,
    });
    expect(deps.skills.listSkillEvaluationRuns("skill-1")).toEqual({
      items: [{ skillId: "skill-1", skills: [{ skillId: "skill-1" }] }],
    });
    expect(deps.skills.listSkillImportHistory(2)).toEqual([{ limit: 2 }]);
    expect(deps.skills.listSkillSources("browser", 3)).toEqual({ query: "browser", limit: 3, items: [] });
    expect(deps.skills.listSkills()).toEqual([{ skillId: "skill-1" }]);
    expect(deps.skills.lookupSkillSources("browser", 4)).toEqual({ queryOrUrl: "browser", limit: 4, items: [] });
    expect(deps.skills.previewSkillEvaluation("skill-1", { rubric: "strict" })).toEqual({
      run: { skillId: "skill-1", input: { rubric: "strict" }, preview: true },
    });
    expect(deps.skills.runSkillEvaluation("skill-1", { rubric: "strict" })).toEqual({
      skillId: "skill-1",
      input: { rubric: "strict" },
      run: true,
    });
    expect(deps.skills.getSkillEvaluationRun("run-1")).toMatchObject({ runId: "run-1" });
    expect(deps.skills.createSkillEvaluationProposal("run-1")).toMatchObject({ proposalId: "proposal-1" });
    expect(deps.skills.reloadSkills()).toEqual([{ skillId: "skill-1", reloaded: true }]);
    expect(deps.skills.resolveSkillActivation({ skillId: "skill-1" })).toEqual({
      input: { skillId: "skill-1" },
      resolved: true,
    });
    expect(deps.skills.setSkillState("skill-1", "enabled", "ok")).toEqual({
      skillId: "skill-1",
      state: "enabled",
      note: "ok",
    });
    expect(deps.skills.updateSkillActivationPolicy({ defaultState: "disabled" })).toEqual({
      input: { defaultState: "disabled" },
      updated: true,
    });
    expect(deps.skills.validateSkillImport({ url: "https://example.test" })).toEqual({
      input: { url: "https://example.test" },
      valid: true,
    });
  });

  it("wires tools, MCP, LLM, secret, and tool-invocation route dependencies", () => {
    const gateway = createGateway();
    const deps = composeToolsMcpRouteDependencies(gateway as never) as any;

    expect(deps.llm.createChatCompletion({ messages: [] })).toEqual({ request: { messages: [] }, id: "completion-1" });
    expect(deps.llm.generateImage({ prompt: "ship" })).toEqual({ input: { prompt: "ship" }, imageId: "image-1" });
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
    expect(deps.llm.updateLlmConfig({ activeProviderId: "openai" })).toEqual({
      input: { activeProviderId: "openai" },
      updated: true,
    });
    expect(gateway.persistLlmConfig).toHaveBeenCalledTimes(1);

    expect(deps.mcp.completeMcpOAuth("server-1", "code", "state")).toMatchObject({ method: "completeMcpOAuth" });
    expect(deps.mcp.connectMcpServer("server-1")).toMatchObject({ method: "connectMcpServer" });
    expect(deps.mcp.createMcpServer({ label: "Server" })).toMatchObject({ method: "createMcpServer" });
    expect(deps.mcp.deleteMcpServer("server-1")).toMatchObject({ method: "deleteMcpServer" });
    expect(deps.mcp.disconnectMcpServer("server-1")).toMatchObject({ method: "disconnectMcpServer" });
    expect(deps.mcp.invokeMcpTool({ serverId: "server-1" })).toEqual({
      input: { serverId: "server-1" },
      mcp: true,
    });
    expect(deps.mcp.listMcpServers()).toEqual([{ serverId: "server-1" }]);
    expect(deps.mcp.listMcpTemplateDiscovery()).toMatchObject({ method: "listMcpTemplateDiscovery" });
    expect(deps.mcp.listMcpTemplates()).toEqual([{ templateId: "template-1" }]);
    expect(deps.mcp.listMcpTools("server-1")).toEqual([{ serverId: "server-1", toolName: "tool-1" }]);
    expect(deps.mcp.runMcpServerHealthCheck("server-1")).toMatchObject({ method: "runMcpServerHealthCheck" });
    expect(deps.mcp.startMcpOAuth("server-1")).toMatchObject({ method: "startMcpOAuth" });
    expect(deps.mcp.updateMcpServer("server-1", { label: "new" })).toMatchObject({ method: "updateMcpServer" });
    expect(deps.mcp.updateMcpServerPolicy("server-1", { allowed: true })).toMatchObject({
      method: "updateMcpServerPolicy",
    });

    expect(deps.secrets.deleteProviderSecret("openai")).toMatchObject({ method: "deleteProviderApiKeyWithFallback" });
    expect(deps.secrets.getProviderSecretStatus("openai")).toEqual({
      providerId: "openai",
      hasSecret: true,
      source: "env",
    });
    expect(deps.secrets.saveProviderSecret("openai", "secret")).toMatchObject({
      method: "persistProviderApiKeyWithFallback",
    });
    expect(gateway.llmService.clearInlineProviderApiKey).toHaveBeenCalledWith("openai");
    expect(gateway.persistLlmConfig).toHaveBeenCalledTimes(2);

    expect(deps.tools.createToolGrant({ scope: "session" })).toEqual({
      input: { scope: "session" },
      grantId: "grant-1",
    });
    expect(deps.tools.evaluateToolAccess({ sessionId: "session-1", toolName: "browser.search" })).toMatchObject({
      allowed: true,
      input: { sessionId: "session-1", toolName: "browser.search", workspaceId: "workspace-a" },
    });
    expect(
      deps.tools.evaluateToolAccess({ sessionId: "missing", toolName: "browser.search", workspaceId: "explicit" }),
    ).toMatchObject({
      input: { sessionId: "missing", toolName: "browser.search", workspaceId: "explicit" },
    });
    expect(deps.tools.evaluateToolAccess({ sessionId: "missing", toolName: "browser.search" })).toMatchObject({
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
