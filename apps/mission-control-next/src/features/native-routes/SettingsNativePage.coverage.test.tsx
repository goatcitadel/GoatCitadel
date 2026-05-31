import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsNativePage } from "./SettingsNativePage";

const settingsMocks = vi.hoisted(() => {
  const fn = (value: unknown = {}) => vi.fn(async () => value);
  return {
    archiveWorkspace: fn(),
    bootstrapDemo: fn(),
    bootstrapOnboarding: fn(),
    completeOnboarding: fn(),
    connectMcpServer: fn(),
    createChannelSetupDraft: fn(),
    createIntegrationConnection: fn(),
    createMcpServer: fn(),
    createPersonality: fn(),
    createToolGrant: fn(),
    createWorkspace: fn(),
    deleteIntegrationConnection: fn(),
    deleteMcpServer: fn(),
    deleteOpenAICodexOAuthCredential: fn(),
    deletePersonality: fn(),
    deleteProviderSecret: fn(),
    disableAddon: fn(),
    disconnectMcpServer: fn(),
    enableAddon: fn(),
    discoverTelegramTargets: fn(),
    fetchAddonStatus: fn(),
    fetchAddonsCatalog: fn(),
    fetchAgenticRuns: fn(),
    fetchCapabilityPackPreview: fn(),
    fetchCapabilityPacks: fn(),
    fetchLocalCapabilityPackPreview: fn(),
    fetchChannelSetupDefinitions: fn(),
    fetchChannelSetupDrafts: fn(),
    fetchDaemonStatus: fn(),
    fetchDemoState: fn(),
    fetchEvidenceEnvelopes: fn(),
    fetchDeviceAccessGrants: fn(),
    fetchGoogleMeetPrerequisiteStatus: fn(),
    fetchGoogleMeetSessions: fn(),
    fetchInstalledAddons: fn(),
    fetchIntegrationCatalog: fn(),
    fetchIntegrationConnectionDiagnostics: fn(),
    fetchIntegrationConnections: vi.fn(),
    fetchIntegrationFormSchema: fn(),
    fetchIntegrationPlugins: fn(),
    fetchLlamaCppModels: fn(),
    fetchMcpRemotePreview: fn(),
    fetchMcpServers: fn(),
    fetchMcpTemplates: fn(),
    fetchMcpTools: fn(),
    fetchNpuModels: fn(),
    fetchOnboardingState: fn(),
    fetchOpenAICodexOAuthStatus: fn(),
    fetchPersonalities: fn(),
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
    invokeIntegrationConnectionAction: fn(),
    launchAddon: fn(),
    loadModelsForProvider: fn(["gpt-5.4-mini"]),
    patchSettings: fn(),
    pollOpenAICodexOAuthDeviceFlow: fn(),
    refreshLlamaCppRuntime: fn(),
    refreshNpuRuntime: fn(),
    reloadProviderCatalog: fn(),
    resolveGatewayInstallToken: fn(),
    restartDaemon: fn(),
    restoreWorkspace: fn(),
    revokeDeviceAccessGrant: fn(),
    revokeToolGrant: fn(),
    runMcpServerHealthCheck: fn(),
    saveProviderSecret: fn(),
    selectVoiceRuntimeModel: fn(),
    setDefaultPersonality: fn(),
    startDaemon: fn(),
    startLlamaCppRuntime: fn(),
    startNpuRuntime: fn(),
    startOpenAICodexOAuthDeviceFlow: fn(),
    startSlackOAuth: fn(),
    stopAddon: fn(),
    stopDaemon: fn(),
    stopLlamaCppRuntime: fn(),
    stopNpuRuntime: fn(),
    testChannelSetupDraft: fn(),
    uninstallAddon: fn(),
    updateAddon: fn(),
    updateChannelSetupDraft: fn(),
    updateIntegrationConnection: fn(),
    updateMcpServer: fn(),
    updatePersonality: fn(),
    updateWorkspace: fn(),
    validateChannelSetupDraft: fn(),
    providerModelCatalog: {
      config: {
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
  bootstrapDemo: settingsMocks.bootstrapDemo,
  bootstrapOnboarding: settingsMocks.bootstrapOnboarding,
  completeOnboarding: settingsMocks.completeOnboarding,
  connectMcpServer: settingsMocks.connectMcpServer,
  createChannelSetupDraft: settingsMocks.createChannelSetupDraft,
  createIntegrationConnection: settingsMocks.createIntegrationConnection,
  createMcpServer: settingsMocks.createMcpServer,
  createPersonality: settingsMocks.createPersonality,
  createToolGrant: settingsMocks.createToolGrant,
  createWorkspace: settingsMocks.createWorkspace,
  deleteIntegrationConnection: settingsMocks.deleteIntegrationConnection,
  deleteMcpServer: settingsMocks.deleteMcpServer,
  deleteOpenAICodexOAuthCredential: settingsMocks.deleteOpenAICodexOAuthCredential,
  deletePersonality: settingsMocks.deletePersonality,
  deleteProviderSecret: settingsMocks.deleteProviderSecret,
  disableAddon: settingsMocks.disableAddon,
  disconnectMcpServer: settingsMocks.disconnectMcpServer,
  enableAddon: settingsMocks.enableAddon,
  discoverTelegramTargets: settingsMocks.discoverTelegramTargets,
  fetchAddonStatus: settingsMocks.fetchAddonStatus,
  fetchAddonsCatalog: settingsMocks.fetchAddonsCatalog,
  fetchAgenticRuns: settingsMocks.fetchAgenticRuns,
  fetchCapabilityPackPreview: settingsMocks.fetchCapabilityPackPreview,
  fetchCapabilityPacks: settingsMocks.fetchCapabilityPacks,
  fetchLocalCapabilityPackPreview: settingsMocks.fetchLocalCapabilityPackPreview,
  fetchChannelSetupDefinitions: settingsMocks.fetchChannelSetupDefinitions,
  fetchChannelSetupDrafts: settingsMocks.fetchChannelSetupDrafts,
  fetchDaemonStatus: settingsMocks.fetchDaemonStatus,
  fetchDemoState: settingsMocks.fetchDemoState,
  fetchEvidenceEnvelopes: settingsMocks.fetchEvidenceEnvelopes,
  fetchDeviceAccessGrants: settingsMocks.fetchDeviceAccessGrants,
  fetchGoogleMeetPrerequisiteStatus: settingsMocks.fetchGoogleMeetPrerequisiteStatus,
  fetchGoogleMeetSessions: settingsMocks.fetchGoogleMeetSessions,
  fetchInstalledAddons: settingsMocks.fetchInstalledAddons,
  fetchIntegrationCatalog: settingsMocks.fetchIntegrationCatalog,
  fetchIntegrationConnectionDiagnostics: settingsMocks.fetchIntegrationConnectionDiagnostics,
  fetchIntegrationConnections: settingsMocks.fetchIntegrationConnections,
  fetchIntegrationFormSchema: settingsMocks.fetchIntegrationFormSchema,
  fetchIntegrationPlugins: settingsMocks.fetchIntegrationPlugins,
  fetchLlamaCppModels: settingsMocks.fetchLlamaCppModels,
  fetchMcpRemotePreview: settingsMocks.fetchMcpRemotePreview,
  fetchMcpServers: settingsMocks.fetchMcpServers,
  fetchMcpTemplates: settingsMocks.fetchMcpTemplates,
  fetchMcpTools: settingsMocks.fetchMcpTools,
  fetchNpuModels: settingsMocks.fetchNpuModels,
  fetchOnboardingState: settingsMocks.fetchOnboardingState,
  fetchOpenAICodexOAuthStatus: settingsMocks.fetchOpenAICodexOAuthStatus,
  fetchPersonalities: settingsMocks.fetchPersonalities,
  fetchProviderSecretStatus: settingsMocks.fetchProviderSecretStatus,
  fetchSettings: settingsMocks.fetchSettings,
  fetchSlackOAuthStatus: settingsMocks.fetchSlackOAuthStatus,
  fetchToolCatalog: settingsMocks.fetchToolCatalog,
  fetchToolGrants: settingsMocks.fetchToolGrants,
  fetchVoiceRuntimeStatus: settingsMocks.fetchVoiceRuntimeStatus,
  fetchWorkspaces: settingsMocks.fetchWorkspaces,
  finalizeChannelSetupDraft: settingsMocks.finalizeChannelSetupDraft,
  installAddon: settingsMocks.installAddon,
  installCapabilityPack: settingsMocks.installCapabilityPack,
  installLocalCapabilityPack: settingsMocks.installLocalCapabilityPack,
  installVoiceRuntime: settingsMocks.installVoiceRuntime,
  invokeIntegrationConnectionAction: settingsMocks.invokeIntegrationConnectionAction,
  launchAddon: settingsMocks.launchAddon,
  patchSettings: settingsMocks.patchSettings,
  pollOpenAICodexOAuthDeviceFlow: settingsMocks.pollOpenAICodexOAuthDeviceFlow,
  refreshLlamaCppRuntime: settingsMocks.refreshLlamaCppRuntime,
  refreshNpuRuntime: settingsMocks.refreshNpuRuntime,
  resolveGatewayInstallToken: settingsMocks.resolveGatewayInstallToken,
  restartDaemon: settingsMocks.restartDaemon,
  restoreWorkspace: settingsMocks.restoreWorkspace,
  revokeDeviceAccessGrant: settingsMocks.revokeDeviceAccessGrant,
  revokeToolGrant: settingsMocks.revokeToolGrant,
  runMcpServerHealthCheck: settingsMocks.runMcpServerHealthCheck,
  saveProviderSecret: settingsMocks.saveProviderSecret,
  selectVoiceRuntimeModel: settingsMocks.selectVoiceRuntimeModel,
  setDefaultPersonality: settingsMocks.setDefaultPersonality,
  startDaemon: settingsMocks.startDaemon,
  startLlamaCppRuntime: settingsMocks.startLlamaCppRuntime,
  startNpuRuntime: settingsMocks.startNpuRuntime,
  startOpenAICodexOAuthDeviceFlow: settingsMocks.startOpenAICodexOAuthDeviceFlow,
  startSlackOAuth: settingsMocks.startSlackOAuth,
  stopAddon: settingsMocks.stopAddon,
  stopDaemon: settingsMocks.stopDaemon,
  stopLlamaCppRuntime: settingsMocks.stopLlamaCppRuntime,
  stopNpuRuntime: settingsMocks.stopNpuRuntime,
  testChannelSetupDraft: settingsMocks.testChannelSetupDraft,
  uninstallAddon: settingsMocks.uninstallAddon,
  updateAddon: settingsMocks.updateAddon,
  updateChannelSetupDraft: settingsMocks.updateChannelSetupDraft,
  updateIntegrationConnection: settingsMocks.updateIntegrationConnection,
  updateMcpServer: settingsMocks.updateMcpServer,
  updatePersonality: settingsMocks.updatePersonality,
  updateWorkspace: settingsMocks.updateWorkspace,
  validateChannelSetupDraft: settingsMocks.validateChannelSetupDraft,
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", () => ({
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
    name: "Default",
    slug: "default",
    description: "Primary workspace",
    lifecycleStatus: "active",
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
  },
  {
    workspaceId: "archive-1",
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
  settingsMocks.createWorkspace.mockResolvedValue({ ...workspaces[0], workspaceId: "created", name: "Created" });
  settingsMocks.updateWorkspace.mockResolvedValue({ ...workspaces[0], name: "Updated" });
  settingsMocks.archiveWorkspace.mockResolvedValue({ ...workspaces[0], lifecycleStatus: "archived" });
  settingsMocks.restoreWorkspace.mockResolvedValue({ ...workspaces[1], lifecycleStatus: "active" });
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
    },
    items: [],
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
  settingsMocks.saveProviderSecret.mockResolvedValue({ hasSecret: true, source: "keychain" });
  settingsMocks.deleteProviderSecret.mockResolvedValue({ hasSecret: false, source: "missing" });
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
      activeWorkspaceId="default"
      activeWorkspaceName="Default"
      navigate={vi.fn()}
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  installBrowser();
  setupResponses();
});

describe("SettingsNativePage broad native sections", () => {
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
      auth: expect.objectContaining({ token: "new-token" }),
    });
    await click(findButton(access.root, "Generate install token"));
    expect(collectText(access.root)).toContain("install-token");
    await click(findButton(access.root, "Revoke"));
    expect(settingsMocks.revokeDeviceAccessGrant).toHaveBeenCalledWith("device-1");

    const setActiveWorkspaceId = vi.fn();
    const onboardingNavigate = vi.fn();
    const onboarding = await mount("onboarding", { navigate: onboardingNavigate, setActiveWorkspaceId });
    expect(collectText(onboarding.root)).toContain("Start Here");
    await click(findButton(onboarding.root, "Start safe demo"));
    expect(settingsMocks.bootstrapDemo).toHaveBeenCalledTimes(1);
    expect(setActiveWorkspaceId).toHaveBeenCalledWith("demo");
    expect(onboardingNavigate).toHaveBeenCalledWith({ area: "cowork", sessionId: "cowork-demo", theme: "ops" });

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

    await change(runtime.root.findByProps({ value: "http://127.0.0.1:39110" }), "http://127.0.0.1:39111");
    const npuCheckboxes = runtime.root.findAll((node) => node.type === "input" && node.props.type === "checkbox");
    await change(npuCheckboxes[2]!, "", false);
    await change(npuCheckboxes[3]!, "", true);
    await click(buttons(runtime.root, "Save")[1]!);
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      npu: {
        enabled: false,
        autoStart: true,
        sidecarUrl: "http://127.0.0.1:39111",
      },
    });
    await click(buttons(runtime.root, "Start")[2]!);
    await click(buttons(runtime.root, "Stop")[2]!);
    await click(buttons(runtime.root, "Refresh")[1]!);
    expect(settingsMocks.startNpuRuntime).toHaveBeenCalledTimes(1);
    expect(settingsMocks.stopNpuRuntime).toHaveBeenCalledTimes(1);
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
    await change(initialWorkspaceInputs[2]!, "Default edited");
    await change(initialWorkspaceInputs[3]!, "default-edited");
    await change(initialWorkspaceTextareas[1]!, "Updated default workspace description");
    await click(findButton(workspacesPage.root, "Save changes"));
    expect(settingsMocks.updateWorkspace).toHaveBeenCalledWith("default", {
      name: "Default edited",
      slug: "default-edited",
      description: "Updated default workspace description",
    });
    await click(findButton(workspacesPage.root, "Make active"));
    expect(workspaceSetter).toHaveBeenCalledWith("default");
    await click(findExactButton(workspacesPage.root, "Archive"));
    expect(settingsMocks.archiveWorkspace).toHaveBeenCalledWith("default");
    await click(findButton(workspacesPage.root, "Archived"));
    await click(findExactButton(workspacesPage.root, "Restore"));
    expect(settingsMocks.restoreWorkspace).toHaveBeenCalledWith("archive-1");
    const workspaceInputs = workspacesPage.root.findAllByType("input");
    const workspaceTextareas = workspacesPage.root.findAllByType("textarea");
    await change(workspaceInputs[0]!, "Created workspace");
    await change(workspaceInputs[1]!, "created-workspace");
    await change(workspaceTextareas[0]!, "Created workspace description");
    await click(findButton(workspacesPage.root, "Create workspace"));
    expect(settingsMocks.createWorkspace).toHaveBeenCalledWith({
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
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({ toolApprovalMode: "bypass" });
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
    await click(findButton(addons.root, "Install pack"));
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
    await click(findButton(onboarding.root, "Open Cowork"));
    await click(findButton(onboarding.root, "Inspect proof"));
    await click(findButton(onboarding.root, "Access"));
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "providers", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "onboarding", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "cowork", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "library", section: "artifacts", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "access", theme: "ops" });

    await click(findButton(onboarding.root, "Start safe demo"));
    expect(settingsMocks.bootstrapDemo).toHaveBeenCalledTimes(1);
    expect(setActiveWorkspaceId).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ area: "code", sessionId: "code-demo", theme: "ops" });
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

    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    await click(findButton(mcp.root, "Delete"));
    expect(settingsMocks.deleteMcpServer).not.toHaveBeenCalled();
    await click(findButton(mcp.root, "Delete"));
    expect(settingsMocks.deleteMcpServer).toHaveBeenCalledWith("srv-1");
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
      llm: {
        activeProviderId: "anthropic",
        activeModel: "claude-sonnet-5",
      },
    });

    await click(findButton(providers.root, "Save secret"));
    expect(collectText(providers.root)).toContain("Enter a provider secret before saving.");
    await change(providers.root.findByProps({ placeholder: "Paste a new API key to save" }), " sk-live ");
    await click(findButton(providers.root, "Save secret"));
    expect(settingsMocks.saveProviderSecret).toHaveBeenCalledWith("openai", "sk-live");

    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    await click(findButton(providers.root, "Delete secret"));
    expect(settingsMocks.deleteProviderSecret).not.toHaveBeenCalled();
    await click(findButton(providers.root, "Delete secret"));
    expect(settingsMocks.deleteProviderSecret).toHaveBeenCalledWith("openai");

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
