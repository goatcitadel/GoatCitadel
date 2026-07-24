import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsNativePage } from "./SettingsNativePage";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { __resetFormDirtyRegistryForTests, hasDirtySections } from "./library/use-form-dirty";

const settingsMocks = vi.hoisted(() => {
  const fn = (value: unknown = {}) => vi.fn(async () => value);
  return {
    archiveWorkspace: fn(),
    archiveCitadel: fn(),
    archivePermissionProfile: fn(),
    activatePermissionProfile: fn(),
    bootstrapDemo: fn(),
    bootstrapOnboarding: fn(),
    createExternalSideEffectReplayAuditRun: fn(),
    completeOnboarding: fn(),
    connectMcpServer: fn(),
    createChannelSetupDraft: fn(),
    createIntegrationConnection: fn(),
    createLocalOperatorOverride: fn(),
    createMcpServer: fn(),
    createPersonality: fn(),
    createPermissionProfile: fn(),
    createToolGrant: fn(),
    createWorkspace: fn(),
    createCitadel: fn(),
    deleteIntegrationConnection: fn(),
    deleteMcpServer: fn(),
    deleteOpenAICodexOAuthCredential: fn(),
    deletePersonality: fn(),
    deleteProviderSecret: fn(),
    disableAddon: fn(),
    disconnectMcpServer: fn(),
    enableAddon: fn(),
    exportCapabilityPack: fn(),
    discoverTelegramTargets: fn(),
    fetchAddonStatus: fn(),
    fetchAddonsCatalog: fn(),
    fetchActiveLocalOperatorOverrides: fn(),
    fetchAgenticRuns: fn(),
    fetchAutonomousActivationGrants: fn(),
    fetchCapabilityPackPreview: fn(),
    fetchCapabilityPacks: fn(),
    fetchStagedCapabilityPacks: fn(),
    fetchLocalCapabilityPackPreview: fn(),
    fetchChannelSetupDefinitions: fn(),
    fetchChannelSetupDrafts: fn(),
    fetchDaemonStatus: fn(),
    fetchDemoState: fn(),
    fetchEffectivePermissionProfile: fn(),
    fetchEvidenceEnvelopes: fn(),
    fetchExternalConnectorServices: fn(),
    fetchExternalSideEffectRuns: fn(),
    fetchDeviceAccessGrants: fn(),
    fetchGoogleMeetPrerequisiteStatus: fn(),
    fetchGoogleMeetSessions: fn(),
    fetchInstalledAddons: fn(),
    fetchIntegrationCatalog: fn(),
    fetchIntegrationConnectionDiagnostics: fn(),
    fetchIntegrationConnections: vi.fn(),
    fetchIntegrationFormSchema: fn(),
    fetchIntegrationPlugins: fn(),
    fetchLlmProviderAdvice: fn(),
    fetchLlamaCppModels: fn(),
    fetchLocalAiReadiness: fn(),
    fetchMcpElicitations: fn({ items: [] }),
    fetchMcpRemotePreview: fn(),
    fetchMcpServerModeManifest: fn(),
    fetchMcpServers: fn(),
    fetchMcpTemplates: fn(),
    fetchMcpTools: fn(),
    fetchMeshReadiness: fn({ status: "ready", blockers: [] }),
    fetchNpuModels: fn(),
    fetchOnboardingState: fn(),
    fetchOpenAICodexOAuthStatus: fn(),
    fetchPersonalities: fn(),
    fetchPermissionProfiles: fn(),
    fetchProviderSecretStatus: fn(),
    fetchSettings: fn(),
    fetchSlackOAuthStatus: fn(),
    fetchToolCatalog: fn(),
    fetchToolGrants: fn(),
    fetchVoiceRuntimeStatus: fn(),
    fetchWorkspaces: fn(),
    finalizeChannelSetupDraft: fn(),
    getCachedModelProbe: vi.fn(),
    installAddon: fn(),
    installCapabilityPack: fn(),
    installLocalCapabilityPack: fn(),
    installVoiceRuntime: fn(),
    isApiRequestError: vi.fn(
      (error: unknown) => error instanceof Error && error.name === "ApiRequestError" && "status" in error,
    ),
    invokeIntegrationConnectionAction: fn(),
    launchAddon: fn(),
    listCitadels: fn(),
    materializeStagedCapabilityPack: fn(),
    loadModelsForProvider: fn(["gpt-5.4-mini"]),
    patchSettings: fn(),
    pollOpenAICodexOAuthDeviceFlow: fn(),
    refreshLlamaCppRuntime: fn(),
    refreshNpuRuntime: fn(),
    reloadProviderCatalog: fn(),
    resolveGatewayInstallToken: fn(),
    restartDaemon: fn(),
    restoreWorkspace: fn(),
    restoreCitadel: fn(),
    revokeAutonomousActivationGrant: fn(),
    revokeDeviceAccessGrant: fn(),
    revokeLocalOperatorOverride: fn(),
    revokeToolGrant: fn(),
    runMcpServerHealthCheck: fn(),
    respondMcpElicitation: fn(),
    saveProviderSecret: fn(),
    selectVoiceRuntimeModel: fn(),
    setDefaultPersonality: fn(),
    startDaemon: fn(),
    startLlamaCppRuntime: fn(),
    startLocalAiDownload: fn(),
    startLocalAiServe: fn(),
    startMcpOAuth: fn(),
    startNpuRuntime: fn(),
    startOpenAICodexOAuthDeviceFlow: fn(),
    startSlackOAuth: fn(),
    stageExternalConnectorAction: fn(),
    stopAddon: fn(),
    stopDaemon: fn(),
    stopLlamaCppRuntime: fn(),
    stopNpuRuntime: fn(),
    testChannelSetupDraft: fn(),
    uninstallAddon: fn(),
    updateAddon: fn(),
    updateChannelSetupDraft: fn(),
    updateExternalConnectorActionReviewState: fn(),
    updateExternalConnectorServiceReviewState: fn(),
    updateIntegrationConnection: fn(),
    updateMcpServer: fn(),
    updatePersonality: fn(),
    updatePermissionProfile: fn(),
    updateWorkspace: fn(),
    updateCitadel: fn(),
    validateChannelSetupDraft: fn(),
    providerModelCatalog: {
      config: {
        revision: 31,
        activeProviderId: "openai",
        activeModel: "gpt-5.4-mini",
        providers: [],
        providerConfigs: [],
      },
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-5.4-mini",
          apiStyle: "openai-responses",
          models: ["gpt-5.4-mini"],
          hasApiKey: true,
          apiKeySource: "keychain",
          modelProbeState: "ready",
        },
      ],
    },
  };
});

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  archiveWorkspace: settingsMocks.archiveWorkspace,
  archiveCitadel: settingsMocks.archiveCitadel,
  archivePermissionProfile: settingsMocks.archivePermissionProfile,
  activatePermissionProfile: settingsMocks.activatePermissionProfile,
  bootstrapDemo: settingsMocks.bootstrapDemo,
  bootstrapOnboarding: settingsMocks.bootstrapOnboarding,
  completeOnboarding: settingsMocks.completeOnboarding,
  connectMcpServer: settingsMocks.connectMcpServer,
  createChannelSetupDraft: settingsMocks.createChannelSetupDraft,
  createExternalSideEffectReplayAuditRun: settingsMocks.createExternalSideEffectReplayAuditRun,
  createIntegrationConnection: settingsMocks.createIntegrationConnection,
  createLocalOperatorOverride: settingsMocks.createLocalOperatorOverride,
  createMcpServer: settingsMocks.createMcpServer,
  createPersonality: settingsMocks.createPersonality,
  createPermissionProfile: settingsMocks.createPermissionProfile,
  createToolGrant: settingsMocks.createToolGrant,
  createWorkspace: settingsMocks.createWorkspace,
  createCitadel: settingsMocks.createCitadel,
  deleteIntegrationConnection: settingsMocks.deleteIntegrationConnection,
  deleteMcpServer: settingsMocks.deleteMcpServer,
  deleteOpenAICodexOAuthCredential: settingsMocks.deleteOpenAICodexOAuthCredential,
  deletePersonality: settingsMocks.deletePersonality,
  deleteProviderSecret: settingsMocks.deleteProviderSecret,
  disableAddon: settingsMocks.disableAddon,
  disconnectMcpServer: settingsMocks.disconnectMcpServer,
  enableAddon: settingsMocks.enableAddon,
  exportCapabilityPack: settingsMocks.exportCapabilityPack,
  discoverTelegramTargets: settingsMocks.discoverTelegramTargets,
  fetchAddonStatus: settingsMocks.fetchAddonStatus,
  fetchAddonsCatalog: settingsMocks.fetchAddonsCatalog,
  fetchActiveLocalOperatorOverrides: settingsMocks.fetchActiveLocalOperatorOverrides,
  fetchAgenticRuns: settingsMocks.fetchAgenticRuns,
  fetchAutonomousActivationGrants: settingsMocks.fetchAutonomousActivationGrants,
  fetchCapabilityPackPreview: settingsMocks.fetchCapabilityPackPreview,
  fetchCapabilityPacks: settingsMocks.fetchCapabilityPacks,
  fetchStagedCapabilityPacks: settingsMocks.fetchStagedCapabilityPacks,
  fetchLocalCapabilityPackPreview: settingsMocks.fetchLocalCapabilityPackPreview,
  fetchChannelSetupDefinitions: settingsMocks.fetchChannelSetupDefinitions,
  fetchChannelSetupDrafts: settingsMocks.fetchChannelSetupDrafts,
  fetchDaemonStatus: settingsMocks.fetchDaemonStatus,
  fetchDemoState: settingsMocks.fetchDemoState,
  fetchEffectivePermissionProfile: settingsMocks.fetchEffectivePermissionProfile,
  fetchEvidenceEnvelopes: settingsMocks.fetchEvidenceEnvelopes,
  fetchExternalConnectorServices: settingsMocks.fetchExternalConnectorServices,
  fetchExternalSideEffectRuns: settingsMocks.fetchExternalSideEffectRuns,
  fetchDeviceAccessGrants: settingsMocks.fetchDeviceAccessGrants,
  fetchGoogleMeetPrerequisiteStatus: settingsMocks.fetchGoogleMeetPrerequisiteStatus,
  fetchGoogleMeetSessions: settingsMocks.fetchGoogleMeetSessions,
  fetchInstalledAddons: settingsMocks.fetchInstalledAddons,
  fetchIntegrationCatalog: settingsMocks.fetchIntegrationCatalog,
  fetchIntegrationConnectionDiagnostics: settingsMocks.fetchIntegrationConnectionDiagnostics,
  fetchIntegrationConnections: settingsMocks.fetchIntegrationConnections,
  fetchIntegrationFormSchema: settingsMocks.fetchIntegrationFormSchema,
  fetchIntegrationPlugins: settingsMocks.fetchIntegrationPlugins,
  fetchLlmProviderAdvice: settingsMocks.fetchLlmProviderAdvice,
  fetchLlamaCppModels: settingsMocks.fetchLlamaCppModels,
  fetchMcpElicitations: settingsMocks.fetchMcpElicitations,
  fetchMcpRemotePreview: settingsMocks.fetchMcpRemotePreview,
  fetchMcpServerModeManifest: settingsMocks.fetchMcpServerModeManifest,
  fetchMcpServers: settingsMocks.fetchMcpServers,
  fetchMcpTemplates: settingsMocks.fetchMcpTemplates,
  fetchMcpTools: settingsMocks.fetchMcpTools,
  fetchMeshReadiness: settingsMocks.fetchMeshReadiness,
  fetchNpuModels: settingsMocks.fetchNpuModels,
  fetchOnboardingState: settingsMocks.fetchOnboardingState,
  fetchOpenAICodexOAuthStatus: settingsMocks.fetchOpenAICodexOAuthStatus,
  fetchPersonalities: settingsMocks.fetchPersonalities,
  fetchPermissionProfiles: settingsMocks.fetchPermissionProfiles,
  fetchProviderSecretStatus: settingsMocks.fetchProviderSecretStatus,
  fetchSettings: settingsMocks.fetchSettings,
  fetchSlackOAuthStatus: settingsMocks.fetchSlackOAuthStatus,
  fetchToolCatalog: settingsMocks.fetchToolCatalog,
  fetchToolGrants: settingsMocks.fetchToolGrants,
  fetchVoiceRuntimeStatus: settingsMocks.fetchVoiceRuntimeStatus,
  fetchWorkspaces: settingsMocks.fetchWorkspaces,
  listCitadels: settingsMocks.listCitadels,
  finalizeChannelSetupDraft: settingsMocks.finalizeChannelSetupDraft,
  installAddon: settingsMocks.installAddon,
  installCapabilityPack: settingsMocks.installCapabilityPack,
  installLocalCapabilityPack: settingsMocks.installLocalCapabilityPack,
  installVoiceRuntime: settingsMocks.installVoiceRuntime,
  isApiRequestError: settingsMocks.isApiRequestError,
  invokeIntegrationConnectionAction: settingsMocks.invokeIntegrationConnectionAction,
  launchAddon: settingsMocks.launchAddon,
  materializeStagedCapabilityPack: settingsMocks.materializeStagedCapabilityPack,
  patchSettings: settingsMocks.patchSettings,
  pollOpenAICodexOAuthDeviceFlow: settingsMocks.pollOpenAICodexOAuthDeviceFlow,
  refreshLlamaCppRuntime: settingsMocks.refreshLlamaCppRuntime,
  refreshNpuRuntime: settingsMocks.refreshNpuRuntime,
  resolveGatewayInstallToken: settingsMocks.resolveGatewayInstallToken,
  restartDaemon: settingsMocks.restartDaemon,
  restoreWorkspace: settingsMocks.restoreWorkspace,
  restoreCitadel: settingsMocks.restoreCitadel,
  revokeAutonomousActivationGrant: settingsMocks.revokeAutonomousActivationGrant,
  revokeDeviceAccessGrant: settingsMocks.revokeDeviceAccessGrant,
  revokeLocalOperatorOverride: settingsMocks.revokeLocalOperatorOverride,
  revokeToolGrant: settingsMocks.revokeToolGrant,
  runMcpServerHealthCheck: settingsMocks.runMcpServerHealthCheck,
  respondMcpElicitation: settingsMocks.respondMcpElicitation,
  saveProviderSecret: settingsMocks.saveProviderSecret,
  selectVoiceRuntimeModel: settingsMocks.selectVoiceRuntimeModel,
  setDefaultPersonality: settingsMocks.setDefaultPersonality,
  startDaemon: settingsMocks.startDaemon,
  startLlamaCppRuntime: settingsMocks.startLlamaCppRuntime,
  startMcpOAuth: settingsMocks.startMcpOAuth,
  startNpuRuntime: settingsMocks.startNpuRuntime,
  startOpenAICodexOAuthDeviceFlow: settingsMocks.startOpenAICodexOAuthDeviceFlow,
  startSlackOAuth: settingsMocks.startSlackOAuth,
  stageExternalConnectorAction: settingsMocks.stageExternalConnectorAction,
  stopAddon: settingsMocks.stopAddon,
  stopDaemon: settingsMocks.stopDaemon,
  stopLlamaCppRuntime: settingsMocks.stopLlamaCppRuntime,
  stopNpuRuntime: settingsMocks.stopNpuRuntime,
  testChannelSetupDraft: settingsMocks.testChannelSetupDraft,
  uninstallAddon: settingsMocks.uninstallAddon,
  updateAddon: settingsMocks.updateAddon,
  updateChannelSetupDraft: settingsMocks.updateChannelSetupDraft,
  updateExternalConnectorActionReviewState: settingsMocks.updateExternalConnectorActionReviewState,
  updateExternalConnectorServiceReviewState: settingsMocks.updateExternalConnectorServiceReviewState,
  updateIntegrationConnection: settingsMocks.updateIntegrationConnection,
  updateMcpServer: settingsMocks.updateMcpServer,
  updatePersonality: settingsMocks.updatePersonality,
  updatePermissionProfile: settingsMocks.updatePermissionProfile,
  updateWorkspace: settingsMocks.updateWorkspace,
  updateCitadel: settingsMocks.updateCitadel,
  validateChannelSetupDraft: settingsMocks.validateChannelSetupDraft,
}));

vi.mock("@goatcitadel/mission-control-shared/api/local-ai", () => ({
  fetchLocalAiReadiness: settingsMocks.fetchLocalAiReadiness,
  startLocalAiDownload: settingsMocks.startLocalAiDownload,
  startLocalAiServe: settingsMocks.startLocalAiServe,
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog")>()),
  useProviderModelCatalog: () => ({
    config: settingsMocks.providerModelCatalog.config,
    providers: settingsMocks.providerModelCatalog.providers,
    loading: false,
    error: null,
    loadModelsForProvider: settingsMocks.loadModelsForProvider,
    getCachedModelProbe: settingsMocks.getCachedModelProbe,
    reload: settingsMocks.reloadProviderCatalog,
  }),
}));

const settings = {
  revision: 29,
  auth: {
    mode: "token",
    allowLoopbackBypass: false,
    tokenConfigured: true,
    basicConfigured: false,
  },
  toolApprovalMode: "approve_risky",
  llm: {
    activeProviderId: "openai",
    activeModel: "gpt-5.4-mini",
    providers: [{ providerId: "openai", label: "OpenAI", hasApiKey: true }],
    providerConfigs: [],
  },
  llamaCpp: {
    enabled: true,
    autoStart: true,
    baseUrl: "http://127.0.0.1:8080/v1",
    command: "llama-server",
    modelsRootPath: "F:/models",
    modelPath: "F:/models/llama-3.gguf",
    alias: "llama-3",
    status: {
      desiredState: "running",
      processState: "running",
      healthy: true,
      activeModelId: "llama-3",
      commandSource: "settings",
      command: "llama-server",
      modelPath: "F:/models/llama-3.gguf",
      leaseDiagnostics: {
        state: "active",
        activeLeaseCount: 2,
        ownership: "owned",
        purposes: [{ purpose: "chat_completion", count: 2 }],
        persistentDemand: { manual: false, api: true, autostart: false },
        evidence: {
          lastProbe: { at: "2026-04-22T00:00:00.000Z", healthy: true },
          lastExit: { at: "2026-04-21T23:50:00.000Z", unexpected: false, code: 0 },
          lastRestart: { at: "2026-04-21T23:51:00.000Z", outcome: "ready" },
        },
      },
    },
  },
  npu: {
    enabled: true,
    autoStart: false,
    sidecarUrl: "http://127.0.0.1:39110",
    status: {
      desiredState: "running",
      processState: "running",
      healthy: true,
      backend: "directml",
      activeModelId: "npu-small",
    },
  },
};

const workspaces = [
  {
    workspaceId: "default",
    revision: 11,
    name: "Default",
    slug: "default",
    description: "Primary workspace",
    lifecycleStatus: "active",
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
  },
  {
    workspaceId: "archive-1",
    revision: 13,
    name: "Archive",
    slug: "archive",
    description: "Archived workspace",
    lifecycleStatus: "archived",
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-23T00:00:00.000Z",
  },
];

function setupResponses() {
  settingsMocks.providerModelCatalog.config = {
    revision: 31,
    activeProviderId: "openai",
    activeModel: "gpt-5.4-mini",
    providers: [],
    providerConfigs: [],
  };
  settingsMocks.providerModelCatalog.providers = [
    {
      providerId: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-5.4-mini",
      apiStyle: "openai-responses",
      models: ["gpt-5.4-mini"],
      hasApiKey: true,
      apiKeySource: "keychain",
      modelProbeState: "ready",
    },
  ];
  settingsMocks.fetchSettings.mockResolvedValue(settings);
  settingsMocks.fetchWorkspaces.mockResolvedValue({ items: workspaces });
  settingsMocks.listCitadels.mockResolvedValue({
    items: [
      {
        citadelId: "personal",
        slug: "personal",
        name: "Personal",
        kind: "personal",
        description: "Personal operating world",
        lifecycleStatus: "active",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
      {
        citadelId: "company",
        slug: "company",
        name: "Company",
        kind: "company",
        description: "Company operating world",
        lifecycleStatus: "active",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    ],
  });
  settingsMocks.createWorkspace.mockResolvedValue({ ...workspaces[0], workspaceId: "created", name: "Created" });
  settingsMocks.updateWorkspace.mockResolvedValue({ ...workspaces[0], name: "Updated" });
  settingsMocks.archiveWorkspace.mockResolvedValue({ ...workspaces[0], lifecycleStatus: "archived" });
  settingsMocks.restoreWorkspace.mockResolvedValue({ ...workspaces[1], lifecycleStatus: "active" });
  settingsMocks.createCitadel.mockResolvedValue({
    citadelId: "created-citadel",
    slug: "created-citadel",
    name: "Created Citadel",
    kind: "custom",
    lifecycleStatus: "active",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  });
  settingsMocks.updateCitadel.mockResolvedValue({
    citadelId: "company",
    slug: "company",
    name: "Company updated",
    kind: "company",
    lifecycleStatus: "active",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  });
  settingsMocks.archiveCitadel.mockResolvedValue({ citadelId: "company", lifecycleStatus: "archived" });
  settingsMocks.restoreCitadel.mockResolvedValue({ citadelId: "company", lifecycleStatus: "active" });
  settingsMocks.fetchIntegrationCatalog.mockResolvedValue({
    items: [
      {
        catalogId: "github",
        key: "github",
        label: "GitHub",
        description: "GitHub issues and pulls",
        kind: "service",
        capabilities: ["issues"],
        authMethods: ["token"],
        operatorActions: [
          {
            actionId: "sync-issues",
            label: "Sync issues",
            description: "Queue an issue sync",
            capability: "issues.sync",
          },
        ],
      },
      {
        catalogId: "channel.telegram",
        key: "telegram",
        label: "Telegram",
        description: "Telegram channel",
        kind: "channel",
        capabilities: ["messages"],
        authMethods: ["bot_token"],
      },
    ],
  });
  settingsMocks.fetchIntegrationConnections.mockImplementation(async (kind?: string) => ({
    items:
      kind === "channel"
        ? [
            {
              connectionId: "channel-1",
              catalogId: "channel.telegram",
              key: "telegram",
              label: "Telegram ops",
              kind: "channel",
              enabled: true,
              status: "connected",
              config: {},
              createdAt: "2026-04-24T12:00:00.000Z",
              updatedAt: "2026-04-24T12:00:00.000Z",
            },
          ]
        : [
            {
              connectionId: "conn-1",
              catalogId: "github",
              key: "github",
              label: "GitHub",
              kind: "service",
              enabled: true,
              status: "connected",
              config: { tokenEnv: "GITHUB_TOKEN" },
              createdAt: "2026-04-24T12:00:00.000Z",
              updatedAt: "2026-04-24T12:00:00.000Z",
            },
          ],
  }));
  settingsMocks.fetchIntegrationFormSchema.mockResolvedValue({
    catalogId: "github",
    title: "GitHub setup",
    fields: [{ key: "tokenEnv", label: "Token environment variable", type: "text", defaultValue: "GITHUB_TOKEN" }],
  });
  settingsMocks.updateIntegrationConnection.mockResolvedValue({ connectionId: "conn-1" });
  settingsMocks.deleteIntegrationConnection.mockResolvedValue({ ok: true });
  settingsMocks.fetchIntegrationConnectionDiagnostics.mockResolvedValue({
    status: "ok",
    checks: [{ key: "token", status: "ok", message: "Token resolved" }],
    recommendedNextAction: "Keep monitoring.",
  });
  settingsMocks.invokeIntegrationConnectionAction.mockResolvedValue({ message: "Synced issues." });
  settingsMocks.fetchIntegrationPlugins.mockResolvedValue({ items: [] });
  settingsMocks.fetchExternalConnectorServices.mockResolvedValue({ items: [] });
  settingsMocks.createExternalSideEffectReplayAuditRun.mockResolvedValue({ runId: "external-run-1" });
  settingsMocks.stageExternalConnectorAction.mockResolvedValue({ status: "staged", approvalRequired: true });
  settingsMocks.updateExternalConnectorActionReviewState.mockResolvedValue({ ok: true });
  settingsMocks.updateExternalConnectorServiceReviewState.mockResolvedValue({ ok: true });
  settingsMocks.fetchExternalSideEffectRuns.mockResolvedValue({ items: [] });
  settingsMocks.fetchLlmProviderAdvice.mockResolvedValue({
    recommendations: [],
    activeProviderId: "openai",
    activeModel: "gpt-5.4-mini",
  });
  settingsMocks.fetchEffectivePermissionProfile.mockResolvedValue({ items: [] });
  settingsMocks.fetchPermissionProfiles.mockResolvedValue({ items: [] });
  settingsMocks.fetchActiveLocalOperatorOverrides.mockResolvedValue({ items: [] });
  settingsMocks.fetchAutonomousActivationGrants.mockResolvedValue({ items: [] });
  settingsMocks.createPermissionProfile.mockResolvedValue({ profileId: "profile-created" });
  settingsMocks.updatePermissionProfile.mockResolvedValue({ profileId: "profile-1" });
  settingsMocks.activatePermissionProfile.mockResolvedValue({ active: true });
  settingsMocks.archivePermissionProfile.mockResolvedValue({ profileId: "profile-1", lifecycleStatus: "archived" });
  settingsMocks.createLocalOperatorOverride.mockResolvedValue({ overrideId: "override-1" });
  settingsMocks.revokeLocalOperatorOverride.mockResolvedValue({ revoked: true });
  settingsMocks.revokeAutonomousActivationGrant.mockResolvedValue({ revoked: true });
  settingsMocks.startMcpOAuth.mockResolvedValue({ authorizationUrl: "https://oauth.example/start" });
  settingsMocks.fetchGoogleMeetPrerequisiteStatus.mockResolvedValue({
    ready: true,
    state: "ready",
    provider: "openai-realtime",
    checkedAt: "2026-04-24T12:00:00.000Z",
    authProfile: {
      available: true,
      source: "configured",
      accountRef: "operator@example.com",
    },
    prerequisites: [],
  });
  settingsMocks.fetchGoogleMeetSessions.mockResolvedValue([
    {
      sessionId: "meet-1",
      displayName: "Weekly",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      provider: "openai-realtime",
      state: "ready",
      transcript: [{ speaker: "operator", text: "Hello", atMs: 0 }],
      updatedAt: "2026-04-24T12:00:00.000Z",
    },
  ]);
  settingsMocks.fetchDaemonStatus.mockResolvedValue({
    running: true,
    pid: 1234,
    uptimeSeconds: 60,
    host: "localhost",
    state: "running",
    supported: true,
    controllable: true,
  });
  settingsMocks.fetchLlamaCppModels.mockResolvedValue({
    degraded: false,
    items: [
      {
        modelId: "llama-3",
        filePath: "F:/models/llama-3.gguf",
        relativePath: "llama-3.gguf",
        sizeBytes: 1024,
        modifiedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
  });
  settingsMocks.fetchNpuModels.mockResolvedValue({ items: [{ modelId: "npu-small", label: "NPU Small" }] });
  settingsMocks.fetchVoiceRuntimeStatus.mockResolvedValue({
    provider: "whisper.cpp",
    source: "managed",
    readiness: "ready",
    binaryReady: true,
    ffmpegReady: true,
    selectedModelId: "base.en",
    selectedModelPath: "F:/models/base.en.bin",
    installedModels: [{ modelId: "base.en", path: "F:/models/base.en.bin" }],
    catalog: [
      {
        id: "base.en",
        label: "Base English",
        languageScope: "English",
        approxSizeLabel: "150 MB",
        defaultInstall: true,
      },
    ],
  });
  settingsMocks.startDaemon.mockResolvedValue({ ok: true });
  settingsMocks.stopDaemon.mockResolvedValue({ ok: true });
  settingsMocks.restartDaemon.mockResolvedValue({ ok: true });
  settingsMocks.startLlamaCppRuntime.mockResolvedValue({ ok: true });
  settingsMocks.stopLlamaCppRuntime.mockResolvedValue({ ok: true });
  settingsMocks.refreshLlamaCppRuntime.mockResolvedValue({ ok: true });
  settingsMocks.startNpuRuntime.mockResolvedValue({ ok: true });
  settingsMocks.stopNpuRuntime.mockResolvedValue({ ok: true });
  settingsMocks.refreshNpuRuntime.mockResolvedValue({ ok: true });
  settingsMocks.installVoiceRuntime.mockResolvedValue({ ok: true });
  settingsMocks.selectVoiceRuntimeModel.mockResolvedValue({ ok: true });
  settingsMocks.fetchOnboardingState.mockResolvedValue({
    completed: false,
    checklist: [
      { id: "llm", label: "Provider configured", status: "needs_input", detail: "Select a provider." },
      { id: "runtime", label: "Runtime ready", status: "complete", detail: "Gateway is reachable." },
      { id: "auth", label: "Auth posture", status: "optional", detail: "Local only." },
    ],
    settings: {
      defaultToolProfile: "standard",
      toolApprovalMode: "approve_risky",
      budgetMode: "balanced",
      networkAllowlist: ["api.openai.com"],
      auth: settings.auth,
      llm: {
        activeProviderId: "openai",
        activeModel: "gpt-5.4-mini",
        providers: [{ providerId: "openai", label: "OpenAI", hasApiKey: true }],
      },
      mesh: {
        enabled: false,
        mode: "lan",
        nodeId: "",
        mdns: true,
        staticPeers: [],
        requireMtls: false,
        tailnetEnabled: false,
      },
    },
  });
  settingsMocks.fetchAgenticRuns.mockResolvedValue({ items: [] });
  settingsMocks.fetchEvidenceEnvelopes.mockResolvedValue({ items: [] });
  settingsMocks.fetchMcpServers.mockResolvedValue({
    items: [
      {
        serverId: "srv-1",
        label: "Approval Inbox",
        transport: "http",
        url: "goatcitadel://approval-inbox",
        authType: "none",
        enabled: true,
        status: "connected",
        category: "system",
        trustTier: "trusted",
        costTier: "free",
        policy: {
          requireFirstToolApproval: true,
          redactionMode: "basic",
          allowedToolPatterns: [],
          blockedToolPatterns: [],
        },
        createdAt: "2026-04-24T12:00:00.000Z",
        updatedAt: "2026-04-24T12:00:00.000Z",
      },
    ],
  });
  settingsMocks.fetchMcpTemplates.mockResolvedValue({ items: [] });
  settingsMocks.fetchMcpElicitations.mockResolvedValue({ items: [] });
  settingsMocks.fetchMcpRemotePreview.mockResolvedValue({
    generatedAt: "2026-05-30T00:00:00.000Z",
    readOnly: true,
    mutationSemantics: "none",
    experimentalRemoteRecordsAllowed: false,
    runtimeSupport: "internal_approval_inbox_only",
    summary: {
      remoteServers: 0,
      remoteTemplates: 0,
      runtimeSupported: 0,
      blocked: 0,
      configuredOnly: 0,
      notCallable: 0,
      experimentalRecords: 0,
      quarantined: 0,
      needsAuth: 0,
    },
    items: [],
  });
  settingsMocks.fetchMcpServerModeManifest.mockResolvedValue({
    generatedAt: "2026-05-31T00:00:00.000Z",
    readOnly: true,
    mutationSemantics: "none",
    status: "preview",
    protocol: "mcp",
    runtimeSupport: "stdio_proxy",
    server: {
      name: "goatcitadel",
      label: "GoatCitadel governed capability export",
      version: "1.0.0",
      transport: "stdio",
    },
    launch: {
      supported: true,
      command: "goatcitadel",
      args: ["mcp-server"],
      reason: "Preview only",
    },
    runtime: {
      callPreview: {
        supported: true,
        endpoint: "/api/v1/mcp/server-mode/call",
        requiresGatewayAuth: true,
        readOnlyOnly: true,
        requiredCallContext: ["agentId", "sessionId"],
      },
      stdio: {
        supported: true,
        command: "goatcitadel",
        args: ["mcp-server"],
        requiresGatewayAuth: true,
        gatewayEndpoint: "/api/v1/mcp/server-mode/manifest",
        reason: "Gateway-backed stdio proxy.",
      },
    },
    summary: {
      inspectableCapabilities: 1,
      gatewayCallableCapabilities: 1,
      exportedToolDescriptors: 1,
      blockedDescriptors: 0,
    },
    tools: [],
    governance: [],
    limitations: ["Preview only"],
    evidence: {
      catalogScope: "callable",
      catalogSnapshot: [],
    },
  });
  settingsMocks.fetchMcpTools.mockResolvedValue({ items: [] });
  settingsMocks.fetchChannelSetupDefinitions.mockResolvedValue({
    items: [
      {
        catalog: {
          catalogId: "channel.slack",
          key: "slack",
          label: "Slack",
          description: "Slack workspace",
        },
        wizard: {
          difficulty: "guided",
          estimatedMinutes: 4,
          steps: [{ fields: [{ key: "channelId", label: "Channel", type: "text", explanation: "Target channel" }] }],
        },
        validation: { levels: ["config"] },
        testing: { levels: ["send"] },
      },
      {
        catalog: {
          catalogId: "channel.telegram",
          key: "telegram",
          label: "Telegram",
          description: "Telegram bot",
        },
        wizard: {
          difficulty: "guided",
          estimatedMinutes: 3,
          steps: [{ fields: [{ key: "botTokenEnv", label: "Token env", type: "text", explanation: "Bot token" }] }],
        },
        validation: { levels: ["config"] },
        testing: { levels: ["send"] },
      },
    ],
  });
  settingsMocks.fetchChannelSetupDrafts.mockResolvedValue({
    items: [
      {
        draftId: "draft-1",
        catalogId: "channel.telegram",
        label: "Telegram setup",
        enabled: true,
        lifecycleMode: "create",
        draft: { botTokenEnv: "TELEGRAM_TOKEN", setupCode: "SETUP" },
        createdAt: "2026-04-24T12:00:00.000Z",
        updatedAt: "2026-04-24T12:00:00.000Z",
      },
    ],
  });
  settingsMocks.createChannelSetupDraft.mockResolvedValue({
    draftId: "draft-2",
    catalogId: "channel.slack",
    enabled: true,
    draft: {},
    lifecycleMode: "create",
    updatedAt: "2026-04-24T12:00:00.000Z",
  });
  settingsMocks.discoverTelegramTargets.mockResolvedValue({
    items: [{ id: "chat-1", label: "Ops Chat", chatId: "123", kind: "group" }],
  });
  settingsMocks.updateChannelSetupDraft.mockResolvedValue({ ok: true });
  settingsMocks.validateChannelSetupDraft.mockResolvedValue({
    status: "ok",
    issues: [{ level: "info", message: "Looks good" }],
  });
  settingsMocks.testChannelSetupDraft.mockResolvedValue({
    status: "warn",
    issues: [{ level: "warn", message: "Dry run only" }],
    recommendedNextAction: "Review target.",
  });
  settingsMocks.finalizeChannelSetupDraft.mockResolvedValue({
    connection: { label: "Telegram ops" },
  });
  settingsMocks.fetchToolCatalog.mockResolvedValue({
    items: [
      {
        toolName: "shell.run",
        category: "filesystem",
        description: "Run a bounded shell command",
        pack: "core",
        riskLevel: "medium",
      },
    ],
  });
  settingsMocks.fetchToolGrants.mockResolvedValue({
    items: [
      {
        grantId: "grant-1",
        toolPattern: "shell.*",
        decision: "allow",
        scope: "workspace",
        scopeRef: "default",
        grantType: "persistent",
        createdBy: "operator",
        createdAt: "2026-04-24T12:00:00.000Z",
      },
    ],
  });
  settingsMocks.createToolGrant.mockResolvedValue({ grantId: "grant-2" });
  settingsMocks.revokeToolGrant.mockResolvedValue({ ok: true });
  settingsMocks.fetchDeviceAccessGrants.mockResolvedValue({
    items: [
      {
        grantId: "device-1",
        requestId: "request-1",
        actorId: "operator",
        deviceLabel: "Android phone",
        deviceType: "mobile",
        platform: "Android",
        grantedBy: "operator",
        metadata: { origin: "companion" },
        createdAt: "2026-05-02T18:00:00.000Z",
      },
    ],
  });
  settingsMocks.resolveGatewayInstallToken.mockResolvedValue({ token: "install-token", source: "generated" });
  settingsMocks.revokeDeviceAccessGrant.mockResolvedValue({ grantId: "device-1" });
  settingsMocks.fetchAddonsCatalog.mockResolvedValue({
    items: [
      {
        addonId: "pixel-office",
        label: "Pixel Office",
        description: "Workspace visualizer",
        category: "visual",
        trustTier: "trusted",
        owner: "goatcitadel",
        runtimeType: "web",
        webEntryMode: "iframe",
        launchUrl: "http://localhost:9000",
        installCommands: [{ command: "pnpm", args: ["install"], note: "Install assets" }],
      },
    ],
  });
  settingsMocks.fetchInstalledAddons.mockResolvedValue({
    items: [{ addonId: "pixel-office", runtimeStatus: "running", installedAt: "2026-04-24T12:00:00.000Z" }],
  });
  settingsMocks.fetchAddonStatus.mockResolvedValue({
    addonId: "pixel-office",
    status: "running",
    healthChecks: [{ key: "http", status: "ok", message: "Serving" }],
  });
  settingsMocks.installAddon.mockResolvedValue({ ok: true });
  settingsMocks.updateAddon.mockResolvedValue({ ok: true });
  settingsMocks.enableAddon.mockResolvedValue({ ok: true });
  settingsMocks.disableAddon.mockResolvedValue({ ok: true });
  settingsMocks.launchAddon.mockResolvedValue({ ok: true });
  settingsMocks.stopAddon.mockResolvedValue({ ok: true });
  settingsMocks.uninstallAddon.mockResolvedValue({ ok: true });
  settingsMocks.fetchCapabilityPacks.mockResolvedValue({
    items: [
      {
        packId: "operator-pack",
        name: "Operator Pack",
        version: "1.0.0",
        description: "Adds operator-facing capabilities",
        trustTier: "trusted",
        tags: ["ops"],
        assets: [{ assetId: "skill-1", kind: "skill" }],
      },
    ],
  });
  settingsMocks.fetchStagedCapabilityPacks.mockResolvedValue({
    items: [
      {
        packId: "operator-pack",
        name: "Operator Pack",
        version: "1.0.0",
        trustTier: "trusted",
        source: "bundled",
        actorId: "operator",
        stagedAt: "2026-05-31T00:00:00.000Z",
        status: "staged_for_review",
        reviewRequired: true,
        stagedAssets: [{ kind: "skill", assetId: "skill-1", reason: "Review required", outcome: "review_required" }],
        evidenceEnvelopeId: "env-pack",
      },
    ],
  });
  settingsMocks.fetchCapabilityPackPreview.mockResolvedValue({
    manifest: {
      packId: "operator-pack",
      trustTier: "trusted",
      name: "Operator Pack",
      installWarnings: ["Review before install."],
      provenance: { source: "bundled" },
    },
    reviewRequired: true,
    policyChanges: { redactionMode: "basic" },
    unsupportedAssets: [],
    installPlan: [{ kind: "skill", assetId: "skill-1", reason: "Adds workflow", outcome: "stage" }],
  });
  settingsMocks.fetchLocalCapabilityPackPreview.mockResolvedValue({
    manifest: {
      packId: "local-pack",
      name: "Local Pack",
      trustTier: "community",
      installWarnings: ["Review local assets."],
      provenance: { source: "local_file" },
    },
    reviewRequired: true,
    policyChanges: { redactionMode: "strict" },
    unsupportedAssets: [],
    installPlan: [{ kind: "addon", assetId: "addon:local", reason: "Review required", outcome: "review_required" }],
  });
  settingsMocks.installCapabilityPack.mockResolvedValue({ ok: true });
  settingsMocks.materializeStagedCapabilityPack.mockResolvedValue({
    packId: "operator-pack",
    actorId: "operator",
    materializedAt: "2026-05-31T00:02:00.000Z",
    status: "materialization_recorded",
    sourceEvidenceEnvelopeId: "env-pack",
    evidenceEnvelopeId: "env-materialized",
    assets: [{ assetId: "skill-1", kind: "skill", requested: true, outcome: "review_recorded" }],
    limitations: ["evidence only"],
  });
  settingsMocks.exportCapabilityPack.mockResolvedValue({
    exportedAt: "2026-05-31T00:00:00.000Z",
    readOnly: true,
    mutationSemantics: "none",
    manifest: {
      packId: "operator-pack",
      name: "Operator Pack",
      version: "1.0.0",
      description: "Adds operator-facing capabilities",
      trustTier: "trusted",
      tags: ["ops"],
      assets: [],
      policyDefaults: {
        requireFirstUseApproval: true,
        memoryWriteAuthority: "operator_controlled",
        redactionMode: "strict",
        autoRunEnabled: false,
      },
      provenance: { source: "bundled", publisher: "goatcitadel" },
      installWarnings: [],
    },
    evidence: { source: "staged_evidence", evidenceEnvelopeId: "env-pack" },
    limitations: ["read-only"],
  });
  settingsMocks.installLocalCapabilityPack.mockResolvedValue({
    preview: {
      manifest: {
        packId: "local-pack",
        name: "Local Pack",
        trustTier: "community",
        installWarnings: ["Review local assets."],
        provenance: { source: "local_file" },
      },
      reviewRequired: true,
      policyChanges: { redactionMode: "strict" },
      unsupportedAssets: [],
      installPlan: [{ kind: "addon", assetId: "addon:local", reason: "Review required", outcome: "review_required" }],
    },
  });
  settingsMocks.fetchDemoState.mockResolvedValue({
    status: "empty",
    workspace: null,
    sessions: [],
    starterPrompts: [
      { surface: "chat", title: "Ask a quick question", prompt: "Summarize the demo." },
      { surface: "cowork", title: "Plan a mission", prompt: "Plan a launch." },
    ],
  });
  settingsMocks.bootstrapDemo.mockResolvedValue({
    status: "ready",
    notes: ["Demo ready."],
    workspace: { workspaceId: "demo", name: "Demo" },
    sessions: [{ sessionId: "cowork-demo", mode: "cowork" }],
  });
  settingsMocks.fetchProviderSecretStatus.mockResolvedValue({ hasSecret: false, source: "missing" });
  settingsMocks.saveProviderSecret.mockResolvedValue({ revision: 32, hasSecret: true, source: "keychain" });
  settingsMocks.deleteProviderSecret.mockResolvedValue({ revision: 32, hasSecret: false, source: "missing" });
  settingsMocks.fetchOpenAICodexOAuthStatus.mockResolvedValue({ connected: false, requiresReauth: false });
  settingsMocks.startOpenAICodexOAuthDeviceFlow.mockResolvedValue({
    providerId: "openai-codex",
    flowId: "flow-1",
    verificationUrl: "https://auth.openai.com/activate",
    userCode: "ABCD-EFGH",
    expiresAt: "2026-05-15T12:05:00.000Z",
    pollAfterMs: 5000,
  });
  settingsMocks.pollOpenAICodexOAuthDeviceFlow.mockResolvedValue({ status: "pending", retryAfterMs: 5000 });
  settingsMocks.deleteOpenAICodexOAuthCredential.mockResolvedValue({ connected: false, requiresReauth: false });
}

function installBrowser() {
  const open = vi.fn();
  vi.stubGlobal("open", open);
  vi.stubGlobal("window", {
    confirm: vi.fn(() => true),
    open,
    setTimeout,
    clearTimeout,
  });
}

function renderPage(section: string, extras: Record<string, unknown> = {}) {
  return create(
    <SettingsNativePage
      route={{ area: "settings", section, theme: "ops" } as any}
      activeCitadelId="personal"
      activeCitadelName="Personal"
      activeWorkspaceId="default"
      activeWorkspaceName="Default"
      navigate={vi.fn()}
      setActiveCitadelId={vi.fn()}
      setActiveWorkspaceId={vi.fn()}
      {...extras}
    />,
  );
}

async function mount(section: string, extras: Record<string, unknown> = {}) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderPage(section, extras);
  });
  await flush();
  return renderer;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      return collectText(child as ReactTestInstance);
    })
    .join(" ");
}

function findButton(root: ReactTestInstance, label: string) {
  const match = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!match) {
    throw new Error(`Missing button ${label}`);
  }
  return match;
}

function buttons(root: ReactTestInstance, label: string) {
  return root.findAll((node) => node.type === "button" && collectText(node).includes(label));
}

function findExactButton(root: ReactTestInstance, label: string) {
  const match = root.findAll((node) => node.type === "button" && collectText(node).trim() === label)[0];
  if (!match) {
    throw new Error(`Missing exact button ${label}`);
  }
  return match;
}

function exactButtons(root: ReactTestInstance, label: string) {
  return root.findAll((node) => node.type === "button" && collectText(node).trim() === label);
}

async function click(button: ReactTestInstance) {
  await act(async () => {
    button.props.onClick();
  });
  await flush();
}

async function change(node: ReactTestInstance, value: string, checked?: boolean) {
  await act(async () => {
    node.props.onChange({ target: { value, checked: checked ?? false } });
  });
  await flush();
}

function revisionConflict(
  expectedRevision: number,
  currentRevision: number,
  path = "/api/v1/settings",
  method = "PATCH",
) {
  return new ApiRequestError("stale settings", {
    kind: "http",
    method,
    path,
    status: 409,
    body: { code: "WRITE_CONFLICT", details: { expectedRevision, currentRevision } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  installBrowser();
  setupResponses();
});

afterEach(() => {
  __resetFormDirtyRegistryForTests();
});

describe("SettingsNativePage broad native sections", () => {
  it("preserves a workspace draft, reloads the current revision, and retries after a 409", async () => {
    const page = await mount("workspaces");
    const nameInput = page.root.findAllByType("input")[8]!;
    await change(nameInput, "Local workspace draft");

    const staleError = new ApiRequestError("stale workspace", {
      kind: "http",
      method: "PATCH",
      path: "/api/v1/workspaces/default",
      status: 409,
      body: { code: "WRITE_CONFLICT", details: { expectedRevision: 11, currentRevision: 12 } },
    });
    settingsMocks.updateWorkspace.mockRejectedValueOnce(staleError).mockResolvedValueOnce({
      ...workspaces[0],
      revision: 13,
      name: "Local workspace draft",
    });
    settingsMocks.fetchWorkspaces.mockResolvedValueOnce({
      items: [{ ...workspaces[0], revision: 12, name: "Remote workspace update" }, workspaces[1]],
    });

    await click(findButton(page.root, "Save changes"));

    expect(settingsMocks.updateWorkspace).toHaveBeenNthCalledWith(1, "default", {
      expectedRevision: 11,
      name: "Local workspace draft",
      description: "Primary workspace",
      slug: "default",
    });
    expect(settingsMocks.fetchWorkspaces).toHaveBeenCalledTimes(2);
    expect(collectText(page.root)).toContain("Your draft is preserved and the current revision was reloaded");
    expect(
      page.root.findAll((node) => node.type === "input" && node.props.value === "Local workspace draft"),
    ).toHaveLength(1);

    await click(findButton(page.root, "Save changes"));
    expect(settingsMocks.updateWorkspace).toHaveBeenNthCalledWith(2, "default", {
      expectedRevision: 12,
      name: "Local workspace draft",
      description: "Primary workspace",
      slug: "default",
    });
  });

  it("preserves the access draft and retries with the refreshed settings revision after a 409", async () => {
    settingsMocks.fetchSettings.mockResolvedValueOnce({ ...settings, revision: 41 }).mockResolvedValueOnce({
      ...settings,
      revision: 42,
      auth: { ...settings.auth, mode: "none", allowLoopbackBypass: true },
    });
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(41, 42)).mockResolvedValueOnce({});

    const access = await mount("access");
    const authMode = access.root.findAllByType("select").find((select) => collectText(select).includes("Basic"))!;
    const token = access.root.findByProps({ placeholder: "Only enter a new token when rotating credentials" });
    await change(authMode, "basic");
    await change(token, "local-token");
    await click(findButton(access.root, "Save access settings"));

    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(1, {
      expectedRevision: 41,
      auth: {
        mode: "basic",
        allowLoopbackBypass: false,
        token: "local-token",
        basicUsername: undefined,
        basicPassword: undefined,
      },
    });
    expect(settingsMocks.fetchSettings).toHaveBeenCalledTimes(2);
    const refreshedAuthMode = access.root
      .findAllByType("select")
      .find((select) => collectText(select).includes("Basic"))!;
    const refreshedToken = access.root.findByProps({
      placeholder: "Only enter a new token when rotating credentials",
    });
    expect(refreshedAuthMode.props.value).toBe("basic");
    expect(refreshedToken.props.value).toBe("local-token");
    expect(collectText(access.root)).toContain("Your draft is preserved");

    await click(findButton(access.root, "Save access settings"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(2, {
      expectedRevision: 42,
      auth: {
        mode: "basic",
        allowLoopbackBypass: false,
        token: "local-token",
        basicUsername: undefined,
        basicPassword: undefined,
      },
    });
  });

  it("preserves the budget draft and retries with the refreshed settings revision after a 409", async () => {
    settingsMocks.fetchSettings
      .mockResolvedValueOnce({ ...settings, revision: 51, budgetMode: "balanced" })
      .mockResolvedValueOnce({ ...settings, revision: 52, budgetMode: "power" });
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(51, 52)).mockResolvedValueOnce({});

    const budget = await mount("budget");
    const mode = budget.root.findByType("select");
    await change(mode, "saver");
    await click(findButton(budget.root, "Save budget mode"));

    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(1, {
      expectedRevision: 51,
      budgetMode: "saver",
    });
    expect(settingsMocks.fetchSettings).toHaveBeenCalledTimes(2);
    expect(budget.root.findByType("select").props.value).toBe("saver");
    expect(collectText(budget.root)).toContain("Your draft is preserved");

    await click(findButton(budget.root, "Save budget mode"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(2, {
      expectedRevision: 52,
      budgetMode: "saver",
    });
  });

  it("preserves the tool approval draft and retries with the refreshed settings revision after a 409", async () => {
    settingsMocks.fetchSettings
      .mockResolvedValueOnce({ ...settings, revision: 61, toolApprovalMode: "approve_risky" })
      .mockResolvedValueOnce({ ...settings, revision: 62, toolApprovalMode: "approve_all" });
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(61, 62)).mockResolvedValueOnce({});

    const tools = await mount("tools");
    const approvalMode = tools.root
      .findAllByType("select")
      .find((select) => collectText(select).includes("Skip normal prompts"))!;
    await change(approvalMode, "bypass");
    await click(findButton(tools.root, "Save mode"));

    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(1, {
      expectedRevision: 61,
      toolApprovalMode: "bypass",
    });
    expect(settingsMocks.fetchSettings).toHaveBeenCalledTimes(2);
    expect(
      tools.root.findAllByType("select").find((select) => collectText(select).includes("Skip normal prompts"))?.props
        .value,
    ).toBe("bypass");
    expect(collectText(tools.root)).toContain("approval-mode draft is preserved");

    await click(findButton(tools.root, "Save mode"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(2, {
      expectedRevision: 62,
      toolApprovalMode: "bypass",
    });
  });

  it("preserves onboarding defaults and retries against the refreshed runtime revision after a 409", async () => {
    const onboardingBase = {
      completed: false,
      checklist: [],
      settings: {
        defaultToolProfile: "standard",
        toolApprovalMode: "approve_risky",
        budgetMode: "balanced",
        networkAllowlist: ["api.old.example"],
        auth: settings.auth,
        llm: settings.llm,
        mesh: { enabled: false, mode: "lan", nodeId: "", mdns: true, staticPeers: [], requireMtls: false },
      },
    };
    settingsMocks.fetchOnboardingState.mockResolvedValueOnce(onboardingBase).mockResolvedValueOnce({
      ...onboardingBase,
      settings: {
        ...onboardingBase.settings,
        budgetMode: "power",
        networkAllowlist: ["api.remote.example"],
      },
    });
    settingsMocks.fetchSettings
      .mockResolvedValueOnce({ ...settings, revision: 71 })
      .mockResolvedValueOnce({ ...settings, revision: 72 });
    settingsMocks.bootstrapOnboarding
      .mockRejectedValueOnce(revisionConflict(71, 72, "/api/v1/onboarding/bootstrap", "POST"))
      .mockResolvedValueOnce({});

    const onboarding = await mount("onboarding");
    const budgetMode = onboarding.root.findAllByType("select").find((select) => select.props.value === "balanced")!;
    const allowlist = onboarding.root.findByProps({ placeholder: "example.com, api.example.com" });
    await change(budgetMode, "saver");
    await change(allowlist, "local.example, api.local.example");
    await click(findButton(onboarding.root, "Apply defaults"));

    expect(settingsMocks.bootstrapOnboarding).toHaveBeenNthCalledWith(1, {
      expectedRevision: 71,
      defaultToolProfile: "standard",
      toolApprovalMode: "approve_risky",
      budgetMode: "saver",
      networkAllowlist: ["local.example", "api.local.example"],
      auth: { allowLoopbackBypass: false },
    });
    expect(settingsMocks.fetchSettings).toHaveBeenCalledTimes(2);
    expect(onboarding.root.findAllByType("select").find((select) => select.props.value === "saver")).toBeTruthy();
    expect(onboarding.root.findByProps({ placeholder: "example.com, api.example.com" }).props.value).toBe(
      "local.example, api.local.example",
    );
    expect(collectText(onboarding.root)).toContain("defaults draft is preserved");

    await click(findButton(onboarding.root, "Apply defaults"));
    expect(settingsMocks.bootstrapOnboarding).toHaveBeenNthCalledWith(2, {
      expectedRevision: 72,
      defaultToolProfile: "standard",
      toolApprovalMode: "approve_risky",
      budgetMode: "saver",
      networkAllowlist: ["local.example", "api.local.example"],
      auth: { allowLoopbackBypass: false },
    });
  });

  it("preserves the llama.cpp draft and retries with the refreshed settings revision after a 409", async () => {
    settingsMocks.fetchSettings.mockResolvedValueOnce({ ...settings, revision: 81 }).mockResolvedValueOnce({
      ...settings,
      revision: 82,
      llamaCpp: { ...settings.llamaCpp, command: "remote-llama-command" },
    });
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(81, 82)).mockResolvedValueOnce({});

    const runtime = await mount("runtime");
    const command = runtime.root.findByProps({ value: "llama-server" });
    await change(command, "local-llama-command");
    await click(buttons(runtime.root, "Save")[0]!);

    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(1, {
      expectedRevision: 81,
      llamaCpp: expect.objectContaining({ command: "local-llama-command" }),
    });
    expect(settingsMocks.fetchSettings).toHaveBeenCalledTimes(2);
    expect(runtime.root.findByProps({ value: "local-llama-command" })).toBeTruthy();
    expect(collectText(runtime.root)).toContain("llama.cpp draft is preserved");

    await click(buttons(runtime.root, "Save")[0]!);
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(2, {
      expectedRevision: 82,
      llamaCpp: expect.objectContaining({ command: "local-llama-command" }),
    });
  });

  it("renders compact llama.cpp lease truth and handles older Gateway status", async () => {
    const runtime = await mount("runtime");
    const text = collectText(runtime.root);

    expect(text).toContain("Lifecycle");
    expect(text).toContain("Active leases");
    expect(text).toContain("Chat completion ×2");
    expect(text).toContain("Persistent demand");
    expect(text).toContain("Api");
    expect(text).toContain("Latest probe");
    expect(text).toContain("Latest process exit");
    expect(text).toContain("Latest restart");
    expect(runtime.root.findByProps({ "aria-label": "llama.cpp lease lifecycle" }).props).toMatchObject({
      role: "group",
      "aria-live": "polite",
    });
    runtime.unmount();

    const { leaseDiagnostics, ...legacyStatus } = settings.llamaCpp.status;
    expect(leaseDiagnostics).toBeDefined();
    settingsMocks.fetchSettings.mockResolvedValueOnce({
      ...settings,
      llamaCpp: { ...settings.llamaCpp, status: legacyStatus },
    });
    const legacyRuntime = await mount("runtime");
    expect(collectText(legacyRuntime.root)).toContain(
      "Lease lifecycle diagnostics are unavailable from this Gateway version.",
    );
    expect(
      legacyRuntime.root.findAll((node) => node.props.role === "status" && collectText(node).includes("unavailable")),
    ).toHaveLength(1);
  });

  it("reloads retired NPU state and retries normalization with the refreshed revision after a 409", async () => {
    settingsMocks.fetchSettings.mockResolvedValueOnce({ ...settings, revision: 83 }).mockResolvedValueOnce({
      ...settings,
      revision: 84,
      npu: { ...settings.npu, sidecarUrl: "http://127.0.0.1:49220" },
    });
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(83, 84)).mockResolvedValueOnce({});

    const runtime = await mount("runtime");
    await click(findButton(runtime.root, "Normalize"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(1, {
      expectedRevision: 83,
      npu: { enabled: false, autoStart: false, sidecarUrl: "http://127.0.0.1:39110" },
    });
    expect(collectText(runtime.root)).toContain("Current NPU settings were reloaded");

    await click(findButton(runtime.root, "Normalize"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(2, {
      expectedRevision: 84,
      npu: { enabled: false, autoStart: false, sidecarUrl: "http://127.0.0.1:49220" },
    });
  });

  it("preserves only the provider routing draft and retries with the refreshed config revision after a 409", async () => {
    settingsMocks.providerModelCatalog.config = {
      ...settingsMocks.providerModelCatalog.config,
      revision: 91,
    };
    settingsMocks.providerModelCatalog.providers = [
      ...settingsMocks.providerModelCatalog.providers,
      {
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        defaultModel: "claude-sonnet-5",
        apiStyle: "anthropic-messages",
        models: ["claude-sonnet-5"],
        hasApiKey: true,
        apiKeySource: "env",
        modelProbeState: "ready",
      },
    ];
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(91, 92)).mockResolvedValueOnce({});
    settingsMocks.reloadProviderCatalog.mockImplementationOnce(async () => {
      settingsMocks.providerModelCatalog.config = {
        ...settingsMocks.providerModelCatalog.config,
        revision: 92,
        activeProviderId: "openai",
        activeModel: "gpt-remote",
      };
      settingsMocks.providerModelCatalog.providers = settingsMocks.providerModelCatalog.providers.map((provider) =>
        provider.providerId === "anthropic" ? { ...provider, label: "Remote Anthropic" } : provider,
      );
    });

    const providers = await mount("providers");
    const routingProvider = providers.root
      .findAllByType("select")
      .find((select) => collectText(select).includes("Anthropic"))!;
    await change(routingProvider, "anthropic");
    await click(findButton(providers.root, "Save routing"));

    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(1, {
      expectedRevision: 91,
      llm: { activeProviderId: "anthropic", activeModel: "claude-sonnet-5" },
    });
    expect(routingProvider.props.value).toBe("anthropic");
    expect(providers.root.findByProps({ placeholder: "OpenAI-compatible" }).props.value).toBe("Remote Anthropic");
    expect(collectText(providers.root)).toContain("routing draft is preserved");

    await click(findButton(providers.root, "Save routing"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(2, {
      expectedRevision: 92,
      llm: { activeProviderId: "anthropic", activeModel: "claude-sonnet-5" },
    });
  });

  it("preserves only the provider editor draft and retries with the refreshed config revision after a 409", async () => {
    settingsMocks.providerModelCatalog.config = {
      ...settingsMocks.providerModelCatalog.config,
      revision: 93,
    };
    settingsMocks.providerModelCatalog.providers = [
      ...settingsMocks.providerModelCatalog.providers,
      {
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        defaultModel: "claude-sonnet-5",
        apiStyle: "anthropic-messages",
        models: ["claude-sonnet-5"],
        hasApiKey: true,
        apiKeySource: "env",
        modelProbeState: "ready",
      },
    ];
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(93, 94)).mockResolvedValueOnce({});
    settingsMocks.reloadProviderCatalog.mockImplementationOnce(async () => {
      settingsMocks.providerModelCatalog.config = {
        ...settingsMocks.providerModelCatalog.config,
        revision: 94,
        activeProviderId: "anthropic",
        activeModel: "claude-sonnet-5",
      };
    });

    const providers = await mount("providers");
    const providerLabel = providers.root.findByProps({ placeholder: "OpenAI-compatible" });
    await change(providerLabel, "Local OpenAI draft");
    await click(findButton(providers.root, "Save provider"));

    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedRevision: 93,
        llm: { upsertProvider: expect.objectContaining({ providerId: "openai", label: "Local OpenAI draft" }) },
      }),
    );
    expect(providerLabel.props.value).toBe("Local OpenAI draft");
    expect(
      providers.root.findAllByType("select").find((select) => collectText(select).includes("Anthropic"))?.props.value,
    ).toBe("anthropic");
    expect(collectText(providers.root)).toContain("provider draft is preserved");

    await click(findButton(providers.root, "Save provider"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedRevision: 94,
        llm: { upsertProvider: expect.objectContaining({ providerId: "openai", label: "Local OpenAI draft" }) },
      }),
    );
  });

  it("reloads provider state and retries ChatGPT setup with the refreshed config revision after a 409", async () => {
    settingsMocks.providerModelCatalog.config = {
      ...settingsMocks.providerModelCatalog.config,
      revision: 95,
    };
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(95, 96)).mockResolvedValueOnce({});
    settingsMocks.reloadProviderCatalog.mockImplementationOnce(async () => {
      settingsMocks.providerModelCatalog.config = {
        ...settingsMocks.providerModelCatalog.config,
        revision: 96,
      };
    });

    const providers = await mount("providers");
    await click(findButton(providers.root, "Add ChatGPT setup"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedRevision: 95,
        llm: { upsertProvider: expect.objectContaining({ providerId: "openai-codex" }) },
      }),
    );
    expect(collectText(providers.root)).toContain("add ChatGPT setup again");

    await click(findButton(providers.root, "Add ChatGPT setup"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedRevision: 96,
        llm: { upsertProvider: expect.objectContaining({ providerId: "openai-codex" }) },
      }),
    );
  });

  it("covers settings fallback stats and route action tails without silently falling through", async () => {
    settingsMocks.fetchSettings.mockRejectedValueOnce(new Error("settings offline"));
    const navigate = vi.fn();
    const general = await mount("general", { navigate });

    const generalText = collectText(general.root);
    expect(generalText).toContain("Some data could not load");
    expect(generalText).toContain("settings offline");
    expect(generalText).toContain("unknown");
    expect(generalText).toContain("n/a");
    expect(generalText).toContain("No active provider");

    const quickRouteButtons = buttons(general.root, "Open");
    expect(quickRouteButtons).toHaveLength(18);
    for (const button of quickRouteButtons) {
      await click(button);
    }
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "onboarding", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "budget", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "providers", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "personalities", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "runtime", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "workspaces", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "integrations", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "channels", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "mcp", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "tools", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "permissions", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "addons", theme: "ops" });

    navigate.mockClear();
    const budget = await mount("budget", { navigate });
    await click(buttons(budget.root, "Open")[0]!);
    await click(buttons(budget.root, "Open")[1]!);
    expect(navigate).toHaveBeenCalledWith({ area: "ops", section: "costs", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "providers", theme: "ops" });
    expect(collectText(budget.root)).toContain("Budget mode");
    expect(collectText(budget.root)).toContain("Cost evidence");

    navigate.mockClear();
    const unknown = await mount("missing-section", { navigate });
    await click(buttons(unknown.root, "Open")[0]!);
    await click(buttons(unknown.root, "Open")[1]!);
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "general", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "providers", theme: "ops" });
  });

  it("renders general, access, onboarding demo, runtime, workspace, channel, tool, and add-on flows", async () => {
    const generalNavigate = vi.fn();
    const general = await mount("general", { navigate: generalNavigate });
    expect(collectText(general.root)).toContain("Mission Control posture");
    expect(collectText(general.root)).toContain(
      "Configured and enabled posture for providers, MCP servers, integrations, and identity at a glance.",
    );
    expect(collectText(general.root)).not.toContain("Live status of providers");
    expect(collectText(general.root)).toContain("Quick routes");
    await click(buttons(general.root, "Open")[0]!);
    expect(generalNavigate).toHaveBeenCalledWith({ area: "settings", section: "providers", theme: "ops" });

    const access = await mount("access");
    expect(collectText(access.root)).toContain("Gateway access");
    expect(collectText(access.root)).toContain("Desktop/mobile continuity");
    expect(collectText(access.root)).toContain("Mobile approval path");
    await change(
      access.root.findByProps({ placeholder: "Only enter a new token when rotating credentials" }),
      "new-token",
    );
    await click(findButton(access.root, "Save access settings"));
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 29,
      auth: expect.objectContaining({ token: "new-token" }),
    });
    await click(findButton(access.root, "Generate install token"));
    expect(collectText(access.root)).toContain("install-token");
    await click(findButton(access.root, "Revoke"));
    const revokeModal = access.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Revoke device access?");
    await act(async () => {
      await revokeModal?.props.onConfirm();
    });
    expect(settingsMocks.revokeDeviceAccessGrant).toHaveBeenCalledWith("device-1");

    const setActiveWorkspaceId = vi.fn();
    const onboardingNavigate = vi.fn();
    const onboarding = await mount("onboarding", { navigate: onboardingNavigate, setActiveWorkspaceId });
    expect(collectText(onboarding.root)).toContain("Start Here");
    await click(findButton(onboarding.root, "Start safe demo"));
    expect(settingsMocks.bootstrapDemo).toHaveBeenCalledTimes(1);
    expect(setActiveWorkspaceId).toHaveBeenCalledWith("demo");
    expect(onboardingNavigate).toHaveBeenCalledWith({ area: "chat", sessionId: "cowork-demo", theme: "ops" });

    const runtime = await mount("runtime");
    expect(collectText(runtime.root)).toContain("Runtime posture");
    await click(buttons(runtime.root, "Start")[0]!);
    await click(buttons(runtime.root, "Stop")[0]!);
    await click(findButton(runtime.root, "Restart"));
    expect(settingsMocks.startDaemon).toHaveBeenCalledTimes(1);
    expect(settingsMocks.stopDaemon).toHaveBeenCalledTimes(1);
    expect(settingsMocks.restartDaemon).toHaveBeenCalledTimes(1);

    await change(runtime.root.findByProps({ value: "http://127.0.0.1:8080/v1" }), "http://127.0.0.1:9090/v1");
    await change(runtime.root.findByProps({ value: "llama-server" }), "llama-server --port 9090");
    await change(runtime.root.findByProps({ value: "F:/models" }), "F:/models/custom");
    await change(
      runtime.root.findAll((node) => node.type === "input" && node.props.value === "F:/models/llama-3.gguf")[0]!,
      "F:/models/custom/llama-3.gguf",
    );
    await change(
      runtime.root.findAllByType("select").find((select) => collectText(select).includes("llama-3.gguf"))!,
      "F:/models/llama-3.gguf",
    );
    await change(runtime.root.findByProps({ value: "llama-3" }), "llama-custom");
    const runtimeCheckboxes = runtime.root.findAll((node) => node.type === "input" && node.props.type === "checkbox");
    await change(runtimeCheckboxes[0]!, "", false);
    await change(runtimeCheckboxes[1]!, "", false);
    await click(buttons(runtime.root, "Save")[0]!);
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 29,
      llamaCpp: {
        enabled: false,
        autoStart: false,
        baseUrl: "http://127.0.0.1:9090/v1",
        command: "llama-server --port 9090",
        modelsRootPath: "F:/models/custom",
        modelPath: "F:/models/llama-3.gguf",
        alias: "llama-custom",
      },
    });
    await click(buttons(runtime.root, "Start")[1]!);
    await click(buttons(runtime.root, "Stop")[1]!);
    await click(buttons(runtime.root, "Refresh")[0]!);
    expect(settingsMocks.startLlamaCppRuntime).toHaveBeenCalledTimes(1);
    expect(settingsMocks.stopLlamaCppRuntime).toHaveBeenCalledTimes(1);
    expect(settingsMocks.refreshLlamaCppRuntime).toHaveBeenCalledTimes(1);

    // NPU sidecar support is retired from the shipped 1.0 runtime, so the
    // "Local acceleration" panel no longer exposes a sidecar URL field,
    // enable/auto-start toggles, or start/stop controls. It only normalizes the
    // retired settings (forcing disabled, preserving the recorded sidecar URL)
    // and refreshes status.
    await click(findButton(runtime.root, "Normalize"));
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 29,
      npu: {
        enabled: false,
        autoStart: false,
        sidecarUrl: "http://127.0.0.1:39110",
      },
    });
    await click(buttons(runtime.root, "Refresh")[1]!);
    expect(settingsMocks.refreshNpuRuntime).toHaveBeenCalledTimes(1);

    await click(findButton(runtime.root, "Install starter model"));
    await click(findButton(runtime.root, "Activate first installed"));
    await click(findExactButton(runtime.root, "Active"));
    expect(settingsMocks.installVoiceRuntime).toHaveBeenCalledWith({ modelId: "base.en", activate: true });
    expect(settingsMocks.selectVoiceRuntimeModel).toHaveBeenCalledWith("base.en");

    const workspaceSetter = vi.fn();
    const workspacesPage = await mount("workspaces", { setActiveWorkspaceId: workspaceSetter });
    expect(collectText(workspacesPage.root)).toContain("Workspace directory");
    const initialWorkspaceInputs = workspacesPage.root.findAllByType("input");
    const initialWorkspaceTextareas = workspacesPage.root.findAllByType("textarea");
    await change(initialWorkspaceInputs[8]!, "Default edited");
    await change(initialWorkspaceInputs[9]!, "default-edited");
    await change(initialWorkspaceTextareas[1]!, "Updated default workspace description");
    await click(findButton(workspacesPage.root, "Save changes"));
    expect(settingsMocks.updateWorkspace).toHaveBeenCalledWith("default", {
      expectedRevision: 11,
      name: "Default edited",
      slug: "default-edited",
      description: "Updated default workspace description",
    });
    await click(exactButtons(workspacesPage.root, "Make active")[1]!);
    expect(workspaceSetter).toHaveBeenCalledWith("default");
    await click(exactButtons(workspacesPage.root, "Archive")[1]!);
    let archiveModal = workspacesPage.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Archive workspace?");
    expect(archiveModal?.props.open).toBe(true);
    await act(async () => {
      archiveModal?.props.onCancel();
    });
    expect(settingsMocks.archiveWorkspace).not.toHaveBeenCalled();
    await click(exactButtons(workspacesPage.root, "Archive")[1]!);
    archiveModal = workspacesPage.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Archive workspace?");
    await act(async () => {
      await archiveModal?.props.onConfirm();
    });
    await flush();
    expect(settingsMocks.archiveWorkspace).toHaveBeenCalledWith("default", 11);
    await click(buttons(workspacesPage.root, "Archived")[1]!);
    await click(findExactButton(workspacesPage.root, "Restore"));
    expect(settingsMocks.restoreWorkspace).toHaveBeenCalledWith("archive-1", 13);
    const workspaceInputs = workspacesPage.root.findAllByType("input");
    const workspaceTextareas = workspacesPage.root.findAllByType("textarea");
    await change(workspaceInputs[6]!, "Created workspace");
    await change(workspaceInputs[7]!, "created-workspace");
    await change(workspaceTextareas[0]!, "Created workspace description");
    await click(findButton(workspacesPage.root, "Create workspace"));
    expect(settingsMocks.createWorkspace).toHaveBeenCalledWith({
      citadelId: "personal",
      name: "Created workspace",
      slug: "created-workspace",
      description: "Created workspace description",
    });

    const channels = await mount("channels");
    expect(collectText(channels.root)).toContain("Channel definitions");
    await click(findExactButton(channels.root, "Use"));
    await change(
      channels.root.findAllByType("select").find((select) => collectText(select).includes("Telegram"))!,
      "channel.telegram",
    );
    await click(findButton(channels.root, "Telegram setup"));
    await change(channels.root.findByProps({ value: "Telegram setup" }), "Telegram production");
    await change(channels.root.findAllByType("input").find((input) => input.props.type === "checkbox")!, "", false);
    await change(
      channels.root.findByType("textarea"),
      '{\n  "botTokenEnv": "TELEGRAM_TOKEN",\n  "setupCode": "SETUP2"\n}',
    );
    await click(findButton(channels.root, "Detect Telegram Chats"));
    expect(settingsMocks.discoverTelegramTargets).toHaveBeenCalledWith({
      botToken: undefined,
      botTokenEnv: "TELEGRAM_TOKEN",
      setupCode: "SETUP2",
    });
    await click(findButton(channels.root, "Save draft"));
    await click(findButton(channels.root, "Validate"));
    await click(findButton(channels.root, "Test"));
    await click(findButton(channels.root, "Finalize"));
    expect(settingsMocks.updateChannelSetupDraft).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({
        enabled: false,
        label: "Telegram production",
        draft: expect.objectContaining({ setupCode: "SETUP2" }),
      }),
    );
    expect(settingsMocks.validateChannelSetupDraft).toHaveBeenCalledWith("draft-1");
    expect(settingsMocks.testChannelSetupDraft).toHaveBeenCalledWith("draft-1");
    expect(settingsMocks.finalizeChannelSetupDraft).toHaveBeenCalledWith("draft-1");

    const tools = await mount("tools");
    expect(collectText(tools.root)).toContain("Tool catalog");
    await change(
      tools.root.findAllByType("select").find((select) => select.props.value === "approve_risky")!,
      "bypass",
    );
    await click(findButton(tools.root, "Save mode"));
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 29,
      toolApprovalMode: "bypass",
    });
    await change(tools.root.findByProps({ placeholder: "Search tool name, category, or description" }), "shell");
    await change(tools.root.findAllByType("input").find((input) => input.props.value === "shell.run")!, "shell.exec");
    await change(tools.root.findAllByType("select").find((select) => select.props.value === "allow")!, "deny");
    await change(tools.root.findAllByType("select").find((select) => select.props.value === "workspace")!, "session");
    await change(
      tools.root
        .findAllByType("input")
        .find(
          (input) =>
            input.props.className === "mc-next-settings-input" && input.props.value === "" && !input.props.disabled,
        )!,
      "session-1",
    );
    await change(tools.root.findAllByType("select").find((select) => select.props.value === "persistent")!, "one_time");
    await click(findButton(tools.root, "Create grant"));
    expect(settingsMocks.createToolGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        toolPattern: "shell.exec",
        decision: "deny",
        scope: "session",
        scopeRef: "session-1",
        grantType: "one_time",
      }),
    );
    await click(findButton(tools.root, "Revoke"));
    const toolRevokeModal = tools.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Revoke tool grant?");
    await act(async () => {
      await toolRevokeModal?.props.onConfirm();
    });
    expect(settingsMocks.revokeToolGrant).toHaveBeenCalledWith("grant-1");

    const addons = await mount("addons");
    await flush();
    expect(collectText(addons.root)).toContain("1.0 add-on posture");
    expect(collectText(addons.root)).toContain("Experimental local extensions");
    expect(collectText(addons.root)).toContain("Local-only boundary");
    expect(collectText(addons.root)).toContain("Add-on catalog");
    await click(findButton(addons.root, "Install"));
    await click(findButton(addons.root, "Update"));
    await click(findButton(addons.root, "Disable"));
    await click(findButton(addons.root, "Launch"));
    await click(findButton(addons.root, "Stop"));
    await click(findButton(addons.root, "Uninstall"));
    let uninstallModal = addons.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Uninstall add-on?");
    expect(uninstallModal?.props.open).toBe(true);
    await act(async () => {
      uninstallModal?.props.onCancel();
    });
    expect(settingsMocks.uninstallAddon).not.toHaveBeenCalled();
    await click(findButton(addons.root, "Uninstall"));
    uninstallModal = addons.root.findAllByType(ConfirmModal).find((modal) => modal.props.title === "Uninstall add-on?");
    await act(async () => {
      await uninstallModal?.props.onConfirm();
    });
    await flush();
    await click(findButton(addons.root, "Stage pack"));
    await click(findButton(addons.root, "Export manifest"));
    await click(findButton(addons.root, "Record review"));
    const portableManifest = {
      packId: "local-pack",
      name: "Local Pack",
      description: "Local portable pack",
      version: "1.0.0",
      trustTier: "community",
      tags: ["local"],
      assets: [
        {
          kind: "addon",
          id: "addon:local",
          label: "Local add-on",
          runtimeSupport: "requires_configuration",
          installMode: "enabled",
        },
      ],
      policyDefaults: {
        requireFirstUseApproval: true,
        memoryWriteAuthority: "operator_controlled",
        redactionMode: "strict",
        autoRunEnabled: false,
      },
      provenance: { source: "local_file", publisher: "Workspace" },
      installWarnings: ["Review local assets."],
    };
    await change(
      addons.root
        .findAllByType("textarea")
        .find((textarea) => textarea.props.placeholder?.includes('"packId":"local-pack"'))!,
      JSON.stringify(portableManifest),
    );
    await click(findButton(addons.root, "Preview local pack"));
    await flush();
    expect(collectText(addons.root)).toContain("Local Pack");
    await click(findButton(addons.root, "Stage local pack"));
    expect(settingsMocks.installAddon).toHaveBeenCalledWith("pixel-office", {
      actorId: "operator",
      confirmRepoDownload: true,
    });
    expect(settingsMocks.updateAddon).toHaveBeenCalledWith("pixel-office");
    expect(settingsMocks.disableAddon).toHaveBeenCalledWith("pixel-office");
    expect(settingsMocks.launchAddon).toHaveBeenCalledWith("pixel-office");
    expect(settingsMocks.stopAddon).toHaveBeenCalledWith("pixel-office");
    expect(settingsMocks.uninstallAddon).toHaveBeenCalledWith("pixel-office");
    expect(settingsMocks.installCapabilityPack).toHaveBeenCalledWith("operator-pack", { actorId: "operator" });
    expect(settingsMocks.exportCapabilityPack).toHaveBeenCalledWith("operator-pack");
    expect(settingsMocks.materializeStagedCapabilityPack).toHaveBeenCalledWith("env-pack", {
      actorId: "operator",
      confirmReview: true,
      assetIds: ["skill-1"],
      note: "Operator recorded reviewed materialization from Settings Add-ons.",
    });
    expect(settingsMocks.fetchLocalCapabilityPackPreview).toHaveBeenCalledWith(portableManifest);
    expect(settingsMocks.installLocalCapabilityPack).toHaveBeenCalledWith(portableManifest, { actorId: "operator" });
  });

  it("renders gateway auth credential-plan warnings on the access page", async () => {
    settingsMocks.fetchSettings.mockResolvedValueOnce({
      ...settings,
      auth: {
        ...settings.auth,
        plan: {
          mode: "token",
          warnings: ["Gateway auth mode is token, but no token is configured."],
          token: { configured: false, source: "none" },
          basicUsername: { configured: false, source: "none" },
          basicPassword: { configured: false, source: "none" },
        },
      },
    });

    const access = await mount("access");

    expect(collectText(access.root)).toContain("Gateway auth mode is token, but no token is configured.");
  });

  it("covers integration detail actions and native load warnings", async () => {
    const integrations = await mount("integrations");
    expect(collectText(integrations.root)).toContain("GitHub");
    await change(
      integrations.root.findAllByType("select").find((select) => collectText(select).includes("GitHub"))!,
      "github",
    );
    await change(integrations.root.findByProps({ placeholder: "Optional connection label" }), "GitHub custom");
    await click(findButton(integrations.root, "Advanced JSON"));
    await change(
      integrations.root.findAllByType("textarea").find((textarea) => textarea.props.value === "{}")!,
      '{\n  "tokenEnv": "GH_JSON"\n}',
    );
    await click(findButton(integrations.root, "Create connection"));
    expect(settingsMocks.createIntegrationConnection).toHaveBeenCalledWith({
      catalogId: "github",
      label: "GitHub custom",
      enabled: true,
      config: { tokenEnv: "GH_JSON" },
    });
    await click(findButton(integrations.root, "GitHub"));
    await change(
      integrations.root.findAllByType("input").find((input) => input.props.value === "GitHub")!,
      "GitHub ops",
    );
    await change(
      integrations.root.findAllByType("select").find((select) => select.props.value === "connected")!,
      "paused",
    );
    await change(integrations.root.findAllByType("input").find((input) => input.props.type === "checkbox")!, "", false);
    await click(findButton(integrations.root, "Advanced JSON"));
    await change(
      integrations.root
        .findAllByType("textarea")
        .find((textarea) => String(textarea.props.value).includes("GITHUB_TOKEN"))!,
      '{\n  "tokenEnv": "GH_DETAIL"\n}',
    );
    await click(findButton(integrations.root, "Run diagnostics"));
    expect(settingsMocks.fetchIntegrationConnectionDiagnostics).toHaveBeenCalledWith("conn-1");
    await click(findButton(integrations.root, "Save changes"));
    expect(settingsMocks.updateIntegrationConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({
        label: "GitHub ops",
        status: "paused",
        enabled: false,
        config: { tokenEnv: "GH_DETAIL" },
      }),
    );
    await click(findExactButton(integrations.root, "Run"));
    expect(settingsMocks.invokeIntegrationConnectionAction).toHaveBeenCalledWith("conn-1", "sync-issues", {});
    await click(findButton(integrations.root, "Delete"));
    let deleteConnectionModal = integrations.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Delete integration connection?");
    expect(deleteConnectionModal?.props.open).toBe(true);
    await act(async () => {
      deleteConnectionModal?.props.onCancel();
    });
    expect(settingsMocks.deleteIntegrationConnection).not.toHaveBeenCalled();
    await click(findButton(integrations.root, "Delete"));
    deleteConnectionModal = integrations.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Delete integration connection?");
    await act(async () => {
      await deleteConnectionModal?.props.onConfirm();
    });
    await flush();
    expect(settingsMocks.deleteIntegrationConnection).toHaveBeenCalledWith("conn-1");

    settingsMocks.fetchMcpServers.mockRejectedValueOnce(new Error("mcp offline"));
    const general = await mount("general");
    expect(collectText(general.root)).toContain("Some data could not load");
    expect(collectText(general.root)).toContain("mcp offline");
    await click(findButton(general.root, "Retry"));
    expect(settingsMocks.fetchMcpServers).toHaveBeenCalled();
  });

  it("covers onboarding defaults, navigation actions, and fallback demo routing branches", async () => {
    settingsMocks.bootstrapOnboarding.mockRejectedValueOnce(new Error("defaults failed"));
    settingsMocks.completeOnboarding.mockRejectedValueOnce(new Error("complete failed"));
    settingsMocks.bootstrapDemo.mockResolvedValueOnce({
      status: "partial",
      notes: [],
      workspace: null,
      sessions: [{ sessionId: "code-demo", mode: "code" }],
    });

    const navigate = vi.fn();
    const setActiveWorkspaceId = vi.fn();
    const onboarding = await mount("onboarding", { navigate, setActiveWorkspaceId });

    const selects = onboarding.root.findAllByType("select");
    await change(selects[0]!, "danger");
    await change(selects[1]!, "bypass");
    await change(selects[2]!, "power");
    await change(
      onboarding.root.findByProps({ placeholder: "example.com, api.example.com" }),
      "api.example.com, localhost",
    );
    await click(findButton(onboarding.root, "Apply defaults"));
    expect(settingsMocks.bootstrapOnboarding).toHaveBeenCalledWith({
      expectedRevision: 29,
      defaultToolProfile: "danger",
      toolApprovalMode: "bypass",
      budgetMode: "power",
      networkAllowlist: ["api.example.com", "localhost"],
      auth: {
        allowLoopbackBypass: false,
      },
    });
    expect(collectText(onboarding.root)).toContain("defaults failed");

    await click(findButton(onboarding.root, "Mark complete"));
    expect(settingsMocks.completeOnboarding).toHaveBeenCalledWith("operator");
    expect(collectText(onboarding.root)).toContain("complete failed");

    await click(findButton(onboarding.root, "Configure"));
    await click(findButton(onboarding.root, "Start demo/local"));
    await click(findButton(onboarding.root, "Open Chat"));
    await click(findButton(onboarding.root, "Inspect proof"));
    await click(findButton(onboarding.root, "Access"));
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "providers", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "onboarding", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "chat", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "library", section: "artifacts", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "access", theme: "ops" });

    await click(findButton(onboarding.root, "Start safe demo"));
    expect(settingsMocks.bootstrapDemo).toHaveBeenCalledTimes(1);
    expect(setActiveWorkspaceId).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ area: "chat", sessionId: "code-demo", theme: "ops" });
    expect(collectText(onboarding.root)).toContain("Demo ready.");

    await click(buttons(onboarding.root, "Refresh").at(-1)!);
    expect(collectText(onboarding.root)).toContain("Start Here");
  });

  it("disables Gateway daemon controls when the daemon status is read-only", async () => {
    settingsMocks.fetchDaemonStatus.mockResolvedValueOnce({
      running: false,
      pid: 0,
      uptimeSeconds: 0,
      host: "localhost",
      state: "stopped",
      supported: true,
      controllable: false,
      controlMessage: "Managed outside Mission Control.",
    });

    const runtime = await mount("runtime");

    expect(collectText(runtime.root)).toContain("Read-only");
    expect(collectText(runtime.root)).toContain("Managed outside Mission Control.");
    expect(buttons(runtime.root, "Start")[0]!.props.disabled).toBe(true);
    expect(buttons(runtime.root, "Stop")[0]!.props.disabled).toBe(true);
    expect(findButton(runtime.root, "Restart").props.disabled).toBe(true);
    expect(settingsMocks.startDaemon).not.toHaveBeenCalled();
    expect(settingsMocks.stopDaemon).not.toHaveBeenCalled();
    expect(settingsMocks.restartDaemon).not.toHaveBeenCalled();
  });

  it("covers demo load, ready, and bootstrap error branches", async () => {
    settingsMocks.fetchDemoState.mockResolvedValue({
      status: "ready",
      workspace: { workspaceId: "demo-existing", name: "Existing Demo" },
      sessions: [{ sessionId: "chat-demo", mode: "chat" }],
      starterPrompts: [],
    });
    settingsMocks.bootstrapDemo.mockReset();
    settingsMocks.bootstrapDemo.mockRejectedValueOnce(new Error("demo bootstrap failed"));

    const navigate = vi.fn();
    const setActiveWorkspaceId = vi.fn();
    const readyDemo = await mount("onboarding", { navigate, setActiveWorkspaceId });
    const readyText = collectText(readyDemo.root);
    expect(readyText).toContain("Existing demo workspace will be reused.");
    expect(readyText).toContain("Open demo");

    await click(findButton(readyDemo.root, "Open demo"));
    expect(collectText(readyDemo.root)).toContain("demo bootstrap failed");
    expect(navigate).not.toHaveBeenCalled();

    settingsMocks.fetchDemoState.mockReset();
    settingsMocks.fetchDemoState
      .mockRejectedValueOnce(new Error("demo state offline"))
      .mockRejectedValueOnce(new Error("demo state offline"))
      .mockResolvedValueOnce({
        status: "empty",
        workspace: null,
        sessions: [],
        starterPrompts: [],
      });
    const failedDemo = await mount("onboarding", { navigate, setActiveWorkspaceId });
    await flush();
    expect(collectText(failedDemo.root)).toContain("demo state offline");
    await click(findButton(failedDemo.root, "Refresh"));
    expect(settingsMocks.fetchDemoState).toHaveBeenCalled();
  });

  it("covers MCP create, edit, runtime actions, diagnostics, and delete branches", async () => {
    const createdServer = {
      serverId: "srv-created",
      label: "Template stdio",
      transport: "stdio",
      command: "npx template-server",
      authType: "none",
      enabled: true,
      status: "connected",
      category: "development",
      trustTier: "trusted",
      costTier: "free",
      policy: {
        requireFirstToolApproval: true,
        redactionMode: "basic",
        allowedToolPatterns: [],
        blockedToolPatterns: [],
      },
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z",
    };
    settingsMocks.fetchMcpServers.mockResolvedValue({
      items: [
        {
          serverId: "srv-1",
          label: "Approval Inbox",
          transport: "http",
          url: "goatcitadel://approval-inbox",
          authType: "none",
          enabled: true,
          status: "connected",
          category: "system",
          trustTier: "trusted",
          costTier: "free",
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
          createdAt: "2026-04-24T12:00:00.000Z",
          updatedAt: "2026-04-24T12:00:00.000Z",
        },
        {
          serverId: "srv-stdio",
          label: "Local Research",
          transport: "stdio",
          command: "node research.js",
          authType: "none",
          enabled: true,
          status: "disconnected",
          category: "research",
          trustTier: "trusted",
          costTier: "free",
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
          createdAt: "2026-04-24T12:00:00.000Z",
          updatedAt: "2026-04-24T12:00:00.000Z",
        },
      ],
    });
    settingsMocks.fetchMcpTemplates.mockResolvedValue({
      items: [
        {
          templateId: "stdio-template",
          label: "Template stdio",
          description: "Local template",
          transport: "stdio",
          command: "npx template-server",
          authType: "none",
          category: "development",
          trustTier: "trusted",
          costTier: "free",
          enabledByDefault: true,
          installed: false,
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
        },
        {
          templateId: "http-template",
          label: "Template URL",
          description: "Remote template",
          transport: "http",
          url: "https://mcp.example.test/sse",
          authType: "none",
          category: "research",
          trustTier: "trusted",
          costTier: "free",
          enabledByDefault: false,
          installed: false,
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
        },
      ],
    });
    settingsMocks.fetchMcpTools.mockResolvedValue({
      items: [{ toolName: "approval.inspect", description: "Inspect pending approvals" }],
    });
    settingsMocks.createMcpServer.mockResolvedValueOnce(createdServer);
    settingsMocks.runMcpServerHealthCheck.mockResolvedValueOnce({
      status: "ok",
      checks: [{ key: "connect", status: "ok", message: "Connected" }],
      recommendedNextAction: "Ready.",
    });

    const mcp = await mount("mcp");
    await click(findButton(mcp.root, "Create MCP server"));
    expect(collectText(mcp.root)).toContain("Server label is required.");

    await click(buttons(mcp.root, "Use")[1]!);
    await change(mcp.root.findByProps({ value: "https://mcp.example.test/sse" }), "https://mcp.example.test/updated");
    await click(buttons(mcp.root, "Use")[0]!);
    await change(mcp.root.findByProps({ value: "Template stdio" }), "Manual Template");
    await change(mcp.root.findByProps({ value: "npx template-server" }), "npx template-server --stdio");
    await change(mcp.root.findAllByType("input").find((input) => input.props.type === "checkbox")!, "", false);
    await click(findButton(mcp.root, "Create MCP server"));
    expect(settingsMocks.createMcpServer).toHaveBeenCalledWith({
      label: "Manual Template",
      transport: "stdio",
      command: "npx template-server --stdio",
      url: undefined,
      enabled: false,
      authType: "none",
      oauth: undefined,
    });
    expect(collectText(mcp.root)).toContain("MCP server Template stdio created.");

    await click(findButton(mcp.root, "Local Research"));
    await change(mcp.root.findByProps({ value: "node research.js" }), "node research-updated.js");
    await click(findButton(mcp.root, "Save changes"));
    expect(settingsMocks.updateMcpServer).toHaveBeenCalledWith(
      "srv-stdio",
      expect.objectContaining({ command: "node research-updated.js" }),
    );

    await click(findButton(mcp.root, "Approval Inbox"));
    const editLabelInput = mcp.root.findAllByType("input").find((input) => input.props.value === "Approval Inbox");
    expect(editLabelInput).toBeTruthy();
    await change(editLabelInput!, "Approval Inbox Renamed");
    await change(
      mcp.root.findByProps({ value: "goatcitadel://approval-inbox" }),
      "goatcitadel://approval-inbox-updated",
    );
    const categorySelect = mcp.root.findAllByType("select")[0]!;
    await change(categorySelect, "automation");
    await change(
      mcp.root
        .findAllByType("input")
        .filter((input) => input.props.type === "checkbox")
        .at(-1)!,
      "",
      false,
    );
    await click(findButton(mcp.root, "Save changes"));
    expect(settingsMocks.updateMcpServer).toHaveBeenCalledWith(
      "srv-1",
      expect.objectContaining({
        label: "Approval Inbox Renamed",
        category: "automation",
        url: "goatcitadel://approval-inbox-updated",
        enabled: false,
      }),
    );

    await click(findButton(mcp.root, "Connect"));
    await click(findButton(mcp.root, "Disconnect"));
    await click(findButton(mcp.root, "Health check"));
    expect(settingsMocks.connectMcpServer).toHaveBeenCalledWith("srv-1");
    expect(settingsMocks.disconnectMcpServer).toHaveBeenCalledWith("srv-1");
    expect(settingsMocks.runMcpServerHealthCheck).toHaveBeenCalledWith("srv-1");
    expect(collectText(mcp.root)).toContain("Inspect pending approvals");
    expect(collectText(mcp.root)).toContain("Ready.");

    await click(findButton(mcp.root, "Delete"));
    let mcpDeleteModal = mcp.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Delete MCP server?");
    expect(mcpDeleteModal?.props.open).toBe(true);
    await act(async () => {
      mcpDeleteModal?.props.onCancel();
    });
    expect(settingsMocks.deleteMcpServer).not.toHaveBeenCalled();
    expect(collectText(mcp.root)).not.toContain("MCP server Approval Inbox deleted.");
    await click(findButton(mcp.root, "Delete"));
    mcpDeleteModal = mcp.root.findAllByType(ConfirmModal).find((modal) => modal.props.title === "Delete MCP server?");
    await act(async () => {
      await mcpDeleteModal?.props.onConfirm();
    });
    await flush();
    expect(settingsMocks.deleteMcpServer).toHaveBeenCalledWith("srv-1");
    expect(collectText(mcp.root)).toContain("MCP server Approval Inbox deleted.");
  });

  it("guards dirty provider selection, preserves edits on cancel, and stays silent after save", async () => {
    settingsMocks.providerModelCatalog.providers = [
      ...settingsMocks.providerModelCatalog.providers,
      {
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        defaultModel: "claude-sonnet-5",
        apiStyle: "anthropic-messages",
        models: ["claude-sonnet-5"],
        hasApiKey: true,
        apiKeySource: "env",
        modelProbeState: "ready",
      },
    ];
    const providers = await mount("providers");
    const providerLabel = providers.root.findByProps({ placeholder: "OpenAI-compatible" });
    await change(providerLabel, "OpenAI dirty");
    expect(hasDirtySections()).toBe(true);

    await click(findButton(providers.root, "Anthropic"));
    let discardModal = providers.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Discard provider changes?");
    expect(discardModal?.props.open).toBe(true);
    await act(async () => {
      discardModal?.props.onCancel();
    });
    expect(providers.root.findByProps({ placeholder: "OpenAI-compatible" }).props.value).toBe("OpenAI dirty");

    await click(findButton(providers.root, "Anthropic"));
    discardModal = providers.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Discard provider changes?");
    await act(async () => {
      discardModal?.props.onConfirm();
    });
    await flush();
    expect(providers.root.findByProps({ placeholder: "OpenAI-compatible" }).props.value).toBe("Anthropic");

    await change(providers.root.findByProps({ placeholder: "OpenAI-compatible" }), "Anthropic saved");
    await click(findButton(providers.root, "Save provider"));
    await click(findButton(providers.root, "OpenAI"));
    discardModal = providers.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Discard provider changes?");
    expect(discardModal?.props.open).toBe(false);
  });

  it("guards dirty MCP server selection and resets only after confirmed discard", async () => {
    settingsMocks.fetchMcpServers.mockResolvedValue({
      items: [
        {
          serverId: "srv-1",
          label: "Approval Inbox",
          transport: "http",
          url: "goatcitadel://approval-inbox",
          authType: "none",
          enabled: true,
          status: "connected",
          category: "system",
          trustTier: "trusted",
          costTier: "free",
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
          createdAt: "2026-04-24T12:00:00.000Z",
          updatedAt: "2026-04-24T12:00:00.000Z",
        },
        {
          serverId: "srv-stdio",
          label: "Local Research",
          transport: "stdio",
          command: "node research.js",
          authType: "none",
          enabled: true,
          status: "disconnected",
          category: "research",
          trustTier: "trusted",
          costTier: "free",
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
          createdAt: "2026-04-24T12:00:00.000Z",
          updatedAt: "2026-04-24T12:00:00.000Z",
        },
      ],
    });
    const mcp = await mount("mcp");
    const labelInput = mcp.root.findByProps({ value: "Approval Inbox" });
    await change(labelInput, "Approval Inbox draft");
    expect(hasDirtySections()).toBe(true);

    await click(findButton(mcp.root, "Local Research"));
    let discardModal = mcp.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Discard MCP server changes?");
    expect(discardModal?.props.open).toBe(true);
    await act(async () => {
      discardModal?.props.onCancel();
    });
    expect(mcp.root.findByProps({ value: "Approval Inbox draft" })).toBeTruthy();

    await click(findButton(mcp.root, "Local Research"));
    discardModal = mcp.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Discard MCP server changes?");
    await act(async () => {
      discardModal?.props.onConfirm();
    });
    await flush();
    expect(mcp.root.findByProps({ value: "Local Research" })).toBeTruthy();
  });

  it("guards both Citadel and workspace editor selection without discarding on cancel", async () => {
    const workspacesPage = await mount("workspaces");
    await change(workspacesPage.root.findByProps({ value: "Personal" }), "Personal draft");
    expect(hasDirtySections()).toBe(true);

    await click(findButton(workspacesPage.root, "Company"));
    let discardCitadel = workspacesPage.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Discard Citadel changes?");
    expect(discardCitadel?.props.open).toBe(true);
    await act(async () => {
      discardCitadel?.props.onCancel();
    });
    expect(workspacesPage.root.findByProps({ value: "Personal draft" })).toBeTruthy();

    await click(findButton(workspacesPage.root, "Company"));
    discardCitadel = workspacesPage.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Discard Citadel changes?");
    await act(async () => {
      discardCitadel?.props.onConfirm();
    });
    await flush();
    expect(workspacesPage.root.findByProps({ value: "Company" })).toBeTruthy();

    await change(workspacesPage.root.findByProps({ value: "Default" }), "Default draft");
    const archivedWorkspaceButton = workspacesPage.root
      .findAllByType("button")
      .find((button) => collectText(button).includes("Archived workspace"));
    expect(archivedWorkspaceButton).toBeTruthy();
    await click(archivedWorkspaceButton!);
    const discardWorkspace = workspacesPage.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Discard workspace changes?");
    expect(discardWorkspace?.props.open).toBe(true);
    await act(async () => {
      discardWorkspace?.props.onCancel();
    });
    expect(workspacesPage.root.findByProps({ value: "Default draft" })).toBeTruthy();

    await click(archivedWorkspaceButton!);
    const confirmedWorkspaceDiscard = workspacesPage.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Discard workspace changes?");
    await act(async () => {
      confirmedWorkspaceDiscard?.props.onConfirm();
    });
    await flush();
    expect(workspacesPage.root.findByProps({ value: "Archive" })).toBeTruthy();
  });

  it("covers channel draft selection warnings and Slack OAuth polling branches", async () => {
    settingsMocks.fetchChannelSetupDefinitions.mockResolvedValueOnce({ items: [] });
    const emptyChannels = await mount("channels");
    await click(findButton(emptyChannels.root, "Create setup draft"));
    expect(collectText(emptyChannels.root)).toContain("Choose a channel definition first.");

    const channels = await mount("channels");
    await click(findButton(channels.root, "Create setup draft"));
    expect(settingsMocks.createChannelSetupDraft).toHaveBeenCalledWith({ catalogId: "channel.slack" });

    settingsMocks.fetchSlackOAuthStatus.mockResolvedValueOnce({
      configured: false,
      mode: "self_owned",
      scopes: [],
      missing: [],
      connections: [],
    });
    const unconfiguredSlack = await mount("channels");
    await click(findButton(unconfiguredSlack.root, "Connect Slack"));
    expect(collectText(unconfiguredSlack.root)).toContain(
      "Slack OAuth needs configuration first: missing OAuth settings.",
    );

    vi.useFakeTimers();
    installBrowser();
    settingsMocks.createChannelSetupDraft.mockClear();
    settingsMocks.startSlackOAuth.mockResolvedValueOnce({
      authorizationUrl: "https://slack.com/oauth/v2/authorize?state=loop24",
      state: "loop24",
      configured: true,
      mode: "self_owned",
      scopes: ["chat:write"],
    });
    settingsMocks.fetchSlackOAuthStatus
      .mockResolvedValueOnce({
        configured: true,
        mode: "self_owned",
        scopes: ["chat:write"],
        missing: [],
        connections: [
          {
            connection: {
              connectionId: "slack-old",
              config: { oauthConnectedAt: "2026-05-14T00:00:00.000Z" },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        configured: true,
        mode: "self_owned",
        scopes: ["chat:write"],
        missing: [],
        connections: [
          {
            connection: {
              connectionId: "slack-new",
              config: { oauthConnectedAt: "2026-05-15T00:00:00.000Z" },
            },
          },
        ],
      });
    settingsMocks.createChannelSetupDraft.mockResolvedValueOnce({
      draftId: "draft-slack",
      catalogId: "channel.slack",
      enabled: true,
      draft: {},
      lifecycleMode: "edit",
      updatedAt: "2026-05-15T00:00:00.000Z",
    });

    try {
      const configuredSlack = await mount("channels");
      await click(findButton(configuredSlack.root, "Connect Slack"));
      expect(window.open).toHaveBeenCalledWith(
        "https://slack.com/oauth/v2/authorize?state=loop24",
        "_blank",
        "noopener,noreferrer",
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await flush();
      expect(settingsMocks.createChannelSetupDraft).toHaveBeenCalledWith({
        catalogId: "channel.slack",
        connectionId: "slack-new",
        lifecycleMode: "edit",
      });
      expect(collectText(configuredSlack.root)).toContain("Slack workspace connected.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("covers integration catalog list selection and selected Slack draft connect branches", async () => {
    settingsMocks.fetchIntegrationCatalog.mockResolvedValueOnce({
      items: [
        {
          catalogId: "github",
          key: "github",
          label: "GitHub",
          description: "GitHub issues and pulls",
          kind: "service",
          capabilities: ["issues"],
          authMethods: ["token"],
          operatorActions: [],
        },
        {
          catalogId: "linear",
          key: "linear",
          label: "Linear",
          description: "Linear issues",
          kind: "service",
          capabilities: ["issues"],
          authMethods: ["token"],
          operatorActions: [],
        },
      ],
    });
    settingsMocks.fetchIntegrationConnections.mockResolvedValueOnce({ items: [] });
    const integrations = await mount("integrations");
    await click(findExactButton(integrations.root, "Use"));
    expect(collectText(integrations.root)).toContain("GitHub");

    settingsMocks.fetchChannelSetupDrafts.mockResolvedValueOnce({
      items: [
        {
          draftId: "draft-slack-selected",
          catalogId: "channel.slack",
          label: "Slack setup",
          enabled: true,
          lifecycleMode: "create",
          draft: {},
          createdAt: "2026-04-24T12:00:00.000Z",
          updatedAt: "2026-04-24T12:00:00.000Z",
        },
      ],
    });
    settingsMocks.fetchSlackOAuthStatus.mockResolvedValueOnce({
      configured: false,
      mode: "self_owned",
      scopes: [],
      missing: [],
      connections: [],
    });
    const slackDraft = await mount("channels");
    const slackConnectButtons = buttons(slackDraft.root, "Connect Slack");
    expect(slackConnectButtons.length).toBeGreaterThanOrEqual(2);
    await click(slackConnectButtons.at(-1)!);
    expect(collectText(slackDraft.root)).toContain("Slack OAuth needs configuration first: missing OAuth settings.");
  });

  it("covers provider editor, secret, model probe, and ChatGPT OAuth setup branches", async () => {
    settingsMocks.getCachedModelProbe.mockReturnValueOnce({
      state: "fallback",
      source: "error_fallback",
      warning: "catalog timeout",
    });
    settingsMocks.loadModelsForProvider.mockResolvedValueOnce(["gpt-5.4-mini"]);
    settingsMocks.providerModelCatalog.providers = [
      ...settingsMocks.providerModelCatalog.providers,
      {
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        defaultModel: "claude-opus-5",
        apiStyle: "anthropic-messages",
        models: ["claude-opus-5", "claude-sonnet-5"],
        hasApiKey: true,
        apiKeySource: "env",
        modelProbeState: "ready",
      },
    ];

    const providers = await mount("providers");
    const routingProviderSelect = providers.root
      .findAllByType("select")
      .find((select) => collectText(select).includes("Anthropic"));
    expect(routingProviderSelect).toBeTruthy();
    await change(routingProviderSelect!, "anthropic");
    const routingModelSelect = providers.root
      .findAllByType("select")
      .find((select) => collectText(select).includes("claude-sonnet-5"));
    expect(routingModelSelect).toBeTruthy();
    await change(routingModelSelect!, "claude-sonnet-5");
    expect(collectText(providers.root)).toContain("Anthropic");

    const providerListItem = providers.root
      .findAll((node) => node.type === "button" && collectText(node).includes("OpenAI"))
      .find((button) => collectText(button).includes("openai"));
    expect(providerListItem).toBeTruthy();
    await click(providerListItem!);

    await click(findButton(providers.root, "Save routing"));
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 31,
      llm: {
        activeProviderId: "anthropic",
        activeModel: "claude-sonnet-5",
      },
    });

    await click(findButton(providers.root, "Save secret"));
    expect(collectText(providers.root)).toContain("Enter a provider secret before saving.");
    await change(providers.root.findByProps({ placeholder: "Paste a new API key to save" }), " sk-live ");
    await click(findButton(providers.root, "Save secret"));
    expect(settingsMocks.saveProviderSecret).toHaveBeenCalledWith("openai", "sk-live", 31);

    await click(findButton(providers.root, "Delete secret"));
    let secretModal = providers.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Delete provider secret?");
    expect(secretModal?.props.open).toBe(true);
    await act(async () => {
      secretModal?.props.onCancel();
    });
    expect(settingsMocks.deleteProviderSecret).not.toHaveBeenCalled();
    await click(findButton(providers.root, "Delete secret"));
    secretModal = providers.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Delete provider secret?");
    await act(async () => {
      await secretModal?.props.onConfirm();
    });
    await flush();
    expect(settingsMocks.deleteProviderSecret).toHaveBeenCalledWith("openai", 31);

    await click(findButton(providers.root, "Refresh models"));
    expect(collectText(providers.root)).toContain("live discovery failed: catalog timeout");

    await click(findButton(providers.root, "New provider draft"));
    await click(findButton(providers.root, "Probe from editor"));

    const inputs = providers.root.findAllByType("input");
    await change(inputs.find((input) => input.props.placeholder === "openai-compatible")!, " local-openai ");
    await change(inputs.find((input) => input.props.placeholder === "OpenAI-compatible")!, " Local OpenAI ");
    await change(
      inputs.find((input) => input.props.placeholder === "https://llm.example.test/v1")!,
      " http://127.0.0.1:11434/v1 ",
    );
    await change(
      providers.root.findAllByType("select").find((select) => collectText(select).includes("OpenAI Chat Completions"))!,
      "openai-chat-completions",
    );
    await change(inputs.find((input) => input.props.placeholder === "gpt-5.4-mini")!, " llama3 ");
    await change(inputs.find((input) => input.props.placeholder === "OPENAI_API_KEY")!, " LOCAL_KEY ");
    await click(findButton(providers.root, "Save provider"));
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 31,
      llm: {
        upsertProvider: expect.objectContaining({
          providerId: "local-openai",
          label: "Local OpenAI",
          baseUrl: "http://127.0.0.1:11434/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "llama3",
          apiKeyEnv: "LOCAL_KEY",
        }),
      },
    });
    await click(findButton(providers.root, "Reload selected"));

    await click(findButton(providers.root, "Add provider and continue"));
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 31,
      llm: {
        upsertProvider: expect.objectContaining({
          providerId: "openai-codex",
          authMode: "codex-oauth",
        }),
      },
    });
  });

  it("covers connected Codex OAuth provider controls and manual polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    installBrowser();
    settingsMocks.providerModelCatalog.providers = [
      {
        providerId: "openai-codex",
        label: "OpenAI Codex",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        defaultModel: "gpt-5-codex",
        apiStyle: "openai-codex-responses",
        models: ["gpt-5-codex"],
        hasApiKey: false,
        apiKeySource: "none",
        modelProbeState: "fallback",
      },
    ];
    settingsMocks.providerModelCatalog.config = {
      revision: 31,
      activeProviderId: "openai-codex",
      activeModel: "gpt-5-codex",
      providers: [],
      providerConfigs: [],
    };
    settingsMocks.fetchOpenAICodexOAuthStatus.mockResolvedValue({
      connected: true,
      requiresReauth: false,
      accountLabel: "operator@example.com",
    });
    settingsMocks.startOpenAICodexOAuthDeviceFlow
      .mockResolvedValueOnce({
        providerId: "openai-codex",
        flowId: "flow-2",
        verificationUrl: "https://auth.openai.com/activate",
        userCode: "WXYZ-1234",
        expiresAt: "2026-05-15T12:05:00.000Z",
        pollAfterMs: 5000,
      })
      .mockResolvedValueOnce({
        providerId: "openai-codex",
        flowId: "flow-3",
        verificationUrl: "https://auth.openai.com/activate",
        userCode: "NEWC-1234",
        expiresAt: "2026-05-15T12:06:00.000Z",
        pollAfterMs: 5000,
      });
    settingsMocks.pollOpenAICodexOAuthDeviceFlow
      .mockResolvedValueOnce({ status: "pending", retryAfterMs: 5000 })
      .mockResolvedValueOnce({ status: "pending", retryAfterMs: 5000 })
      .mockResolvedValueOnce({ status: "connected" });

    try {
      const providers = await mount("providers");
      expect(collectText(providers.root)).toContain("OpenAI Codex OAuth connected as operator@example.com.");

      await click(findButton(providers.root, "ChatGPT setup"));
      expect(collectText(providers.root)).toContain("OpenAI Codex is already configured.");

      await click(findButton(providers.root, "Reconnect ChatGPT"));
      await flush();
      expect(window.open).toHaveBeenCalledWith("https://auth.openai.com/activate", "_blank", "noopener,noreferrer");
      expect(providers.root.findAllByType("input").some((input) => input.props.value === "WXYZ-1234")).toBe(true);

      await click(findButton(providers.root, "Open OpenAI page"));
      expect(window.open).toHaveBeenCalledTimes(2);
      await click(findButton(providers.root, "Get a new code"));
      expect(providers.root.findAllByType("input").some((input) => input.props.value === "NEWC-1234")).toBe(true);
      await click(findButton(providers.root, "I approved, check now"));
      expect(settingsMocks.pollOpenAICodexOAuthDeviceFlow).toHaveBeenLastCalledWith("flow-3");
      expect(collectText(providers.root)).toContain("OpenAI Codex OAuth connected.");

      await click(findButton(providers.root, "Advanced details"));
      expect(collectText(providers.root)).toContain("Credential posture");

      await click(findButton(providers.root, "Disconnect"));
      expect(settingsMocks.deleteOpenAICodexOAuthCredential).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SettingsNativePage partial gateway responses", () => {
  // Well-formed-but-partial gateway responses: a stub gateway can return
  // HTTP 200 with {} (or a ready-flags-only payload) for any settings
  // endpoint, so nested blocks the response contracts declare required may
  // be absent at runtime. nativeLoad only falls back on rejected fetches and
  // useAsyncLoad only catches thrown loads, so a 200 with an empty body
  // reaches render as truthy-but-empty data.

  it("keeps the runtime voice card defensive when the voice runtime status omits installed models and catalog", async () => {
    settingsMocks.fetchVoiceRuntimeStatus.mockResolvedValue({
      provider: "whisper.cpp",
      source: "managed",
      readiness: "ready",
      binaryReady: true,
      ffmpegReady: true,
    });

    const runtime = await mount("runtime");

    const text = collectText(runtime.root);
    expect(text).toContain("0 installed");
    expect(text).toContain("No voice model catalog available.");
    expect(buttons(runtime.root, "Activate first installed")).toHaveLength(0);

    await click(findButton(runtime.root, "Install starter model"));
    expect(settingsMocks.installVoiceRuntime).toHaveBeenCalledWith({});
  });

  it("renders the local AI section when the readiness payload is empty", async () => {
    settingsMocks.fetchLocalAiReadiness.mockResolvedValue({});

    const localAi = await mount("local-ai");

    const text = collectText(localAi.root);
    expect(text).toContain("Hardware readiness");
    expect(text).toContain("Unknown");
    expect(text).toContain("Serve jobs");
  });

  it("renders the general section when the settings payload is empty", async () => {
    settingsMocks.fetchSettings.mockResolvedValue({});

    const general = await mount("general");

    const text = collectText(general.root);
    expect(text).toContain("Mission Control posture");
    expect(text).toContain("No active provider");
    expect(text).toContain("unknown");
  });

  it("renders the onboarding demo card when the demo state payload is empty", async () => {
    settingsMocks.fetchDemoState.mockResolvedValue({});

    const onboarding = await mount("onboarding");

    const text = collectText(onboarding.root);
    expect(text).toContain("Start Here");
    expect(text).toContain("Not created");
  });

  it("renders the personalities section when the personalities payload is empty", async () => {
    settingsMocks.fetchPersonalities.mockResolvedValue({});

    const personalities = await mount("personalities");

    expect(collectText(personalities.root)).toContain("Personality catalog");
  });

  it("renders the workspaces section when workspace and citadel payloads are empty", async () => {
    settingsMocks.fetchWorkspaces.mockResolvedValue({});
    settingsMocks.listCitadels.mockResolvedValue({});

    const workspaces = await mount("workspaces");

    const text = collectText(workspaces.root);
    expect(text).toContain("Citadel manager");
    expect(text).toContain("Workspace directory");
  });

  it("renders the channels section when definitions and drafts payloads are empty", async () => {
    settingsMocks.fetchChannelSetupDefinitions.mockResolvedValue({});
    settingsMocks.fetchChannelSetupDrafts.mockResolvedValue({});

    const channels = await mount("channels");

    expect(collectText(channels.root)).toContain("Channel definitions");
  });

  it("renders the MCP section when server, preview, server-mode, and elicitation payloads are empty", async () => {
    settingsMocks.fetchMcpServers.mockResolvedValue({});
    settingsMocks.fetchMcpRemotePreview.mockResolvedValue({});
    settingsMocks.fetchMcpServerModeManifest.mockResolvedValue({});
    settingsMocks.fetchMcpElicitations.mockResolvedValue({});

    const mcp = await mount("mcp");

    expect(collectText(mcp.root)).toContain("MCP servers");
  });

  it("renders the permissions section when the profiles payload is empty", async () => {
    settingsMocks.fetchPermissionProfiles.mockResolvedValue({});

    const permissions = await mount("permissions");

    expect(collectText(permissions.root)).toContain("Permission profiles");
  });

  it("renders the add-ons section when catalog and pack payloads are empty", async () => {
    settingsMocks.fetchAddonsCatalog.mockResolvedValue({});
    settingsMocks.fetchInstalledAddons.mockResolvedValue({});
    settingsMocks.fetchCapabilityPacks.mockResolvedValue({});
    settingsMocks.fetchStagedCapabilityPacks.mockResolvedValue({});

    const addons = await mount("addons");

    expect(collectText(addons.root)).toContain("Add-on catalog");
  });

  it("keeps provider advice defensive when the advice payload is empty", async () => {
    settingsMocks.fetchLlmProviderAdvice.mockResolvedValue({});

    const providers = await mount("providers");
    await click(findButton(providers.root, "Load advice"));

    const text = collectText(providers.root);
    expect(text).toContain("Provider advice");
    expect(text).toContain("Provider advice is advisory only.");
  });

  it("renders the general posture counts when workspace, integration, MCP, tool, and add-on payloads are empty", async () => {
    settingsMocks.fetchWorkspaces.mockResolvedValue({});
    settingsMocks.fetchIntegrationConnections.mockResolvedValue({});
    settingsMocks.fetchMcpServers.mockResolvedValue({});
    settingsMocks.fetchToolCatalog.mockResolvedValue({});
    settingsMocks.fetchInstalledAddons.mockResolvedValue({});

    const general = await mount("general");

    const text = collectText(general.root);
    expect(text).toContain("Mission Control posture");
    expect(text).toContain("Contexts available to switch or edit");
    expect(text).toContain("0 configured");
  });

  it("renders the access section when the device grant payload is empty", async () => {
    settingsMocks.fetchDeviceAccessGrants.mockResolvedValue({});

    const access = await mount("access");

    const text = collectText(access.root);
    expect(text).toContain("Approved devices");
    expect(text).toContain("No device grants found.");
  });

  it("renders the access section when the settings payload is empty", async () => {
    settingsMocks.fetchSettings.mockResolvedValue({});

    const access = await mount("access");

    const text = collectText(access.root);
    expect(text).toContain("Gateway access");
    expect(text).toContain("Current posture");
    expect(text).toContain("Desktop/mobile continuity");
    expect(text).toContain("unknown");
    expect(text).toContain("Missing");
  });

  it("renders the runtime posture when llama.cpp and NPU model payloads are empty", async () => {
    settingsMocks.fetchLlamaCppModels.mockResolvedValue({});
    settingsMocks.fetchNpuModels.mockResolvedValue({});

    const runtime = await mount("runtime");

    expect(collectText(runtime.root)).toContain("0 models discovered");
  });

  it("renders the runtime section when the settings payload is empty", async () => {
    settingsMocks.fetchSettings.mockResolvedValue({});

    const runtime = await mount("runtime");

    const text = collectText(runtime.root);
    expect(text).toContain("Runtime posture");
    expect(text).toContain("llama.cpp runtime");
    expect(text).toContain("Local acceleration");
    expect(text).toContain("unknown");
    expect(settingsMocks.fetchNpuModels).not.toHaveBeenCalled();
  });

  it("skips NPU model discovery without error-bannering when npu settings omit status", async () => {
    settingsMocks.fetchSettings.mockResolvedValue({
      npu: { enabled: true, autoStart: false, sidecarUrl: "http://127.0.0.1:39110" },
    });

    const runtime = await mount("runtime");

    const text = collectText(runtime.root);
    expect(text).toContain("Runtime posture");
    expect(text).toContain("Local acceleration");
    expect(settingsMocks.fetchNpuModels).not.toHaveBeenCalled();
  });

  it("renders the integrations section with inert fallbacks when every integration payload is empty", async () => {
    settingsMocks.fetchIntegrationCatalog.mockResolvedValue({});
    settingsMocks.fetchIntegrationConnections.mockResolvedValue({});
    settingsMocks.fetchIntegrationPlugins.mockResolvedValue({});
    settingsMocks.fetchGoogleMeetPrerequisiteStatus.mockResolvedValue({});
    settingsMocks.fetchGoogleMeetSessions.mockResolvedValue({});
    settingsMocks.fetchExternalSideEffectRuns.mockResolvedValue({});
    settingsMocks.fetchExternalConnectorServices.mockResolvedValue({});

    const integrations = await mount("integrations");

    const text = collectText(integrations.root);
    expect(text).toContain("Connected integrations");
    expect(text).toContain("No integration connections yet.");
    expect(text).toContain("No integration plugins installed.");
    expect(text).toContain("Google Meet voice");
    expect(text).toContain("No Google Meet sessions recorded.");
  });

  it("renders the permissions grant panels when override and autonomy grant payloads are empty", async () => {
    settingsMocks.fetchActiveLocalOperatorOverrides.mockResolvedValue({});
    settingsMocks.fetchAutonomousActivationGrants.mockResolvedValue({});

    const permissions = await mount("permissions");

    const text = collectText(permissions.root);
    expect(text).toContain("Autonomous activation grants");
    expect(text).toContain("No autonomous activation grants recorded.");
  });

  it("renders the tools section when tool catalog and grant payloads are empty", async () => {
    settingsMocks.fetchToolCatalog.mockResolvedValue({});
    settingsMocks.fetchToolGrants.mockResolvedValue({});

    const tools = await mount("tools");

    const text = collectText(tools.root);
    expect(text).toContain("Tool catalog");
    expect(text).toContain("No tool grants created yet.");
  });

  it("renders the onboarding section when the onboarding payload is empty", async () => {
    settingsMocks.fetchOnboardingState.mockResolvedValue({});

    const onboarding = await mount("onboarding");

    const text = collectText(onboarding.root);
    expect(text).toContain("First trusted outcome");
    expect(text).toContain("Setup Center");
    expect(text).toContain("Provider smoke evidence");
    expect(text).toContain("First-run setup");
    expect(text).toContain("Apply first-run defaults");
    expect(text).toContain("Choose an active provider before sending cloud-backed work.");
    expect(text).toContain("Unset");
  });

  it("renders the onboarding section when agentic run and evidence payloads are empty", async () => {
    settingsMocks.fetchAgenticRuns.mockResolvedValue({});
    settingsMocks.fetchEvidenceEnvelopes.mockResolvedValue({});

    const onboarding = await mount("onboarding");

    const text = collectText(onboarding.root);
    expect(text).toContain("First trusted outcome");
    expect(text).toContain("First-run setup");
    expect(text).toContain("No proof artifact or trace is recorded yet.");
  });

  it("renders the remote profile readiness card when the setup readiness payload is partial", async () => {
    settingsMocks.fetchOnboardingState.mockResolvedValue({ setupReadiness: {} });

    const onboarding = await mount("onboarding");

    const text = collectText(onboarding.root);
    expect(text).toContain("Remote profile readiness");
    expect(text).toContain("unknown");
  });
});
