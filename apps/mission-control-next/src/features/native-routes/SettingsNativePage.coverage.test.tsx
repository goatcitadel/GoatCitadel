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
    disconnectMcpServer: fn(),
    discoverTelegramTargets: fn(),
    fetchAddonStatus: fn(),
    fetchAddonsCatalog: fn(),
    fetchCapabilityPackPreview: fn(),
    fetchCapabilityPacks: fn(),
    fetchChannelSetupDefinitions: fn(),
    fetchChannelSetupDrafts: fn(),
    fetchDaemonStatus: fn(),
    fetchDemoState: fn(),
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
  disconnectMcpServer: settingsMocks.disconnectMcpServer,
  discoverTelegramTargets: settingsMocks.discoverTelegramTargets,
  fetchAddonStatus: settingsMocks.fetchAddonStatus,
  fetchAddonsCatalog: settingsMocks.fetchAddonsCatalog,
  fetchCapabilityPackPreview: settingsMocks.fetchCapabilityPackPreview,
  fetchCapabilityPacks: settingsMocks.fetchCapabilityPacks,
  fetchChannelSetupDefinitions: settingsMocks.fetchChannelSetupDefinitions,
  fetchChannelSetupDrafts: settingsMocks.fetchChannelSetupDrafts,
  fetchDaemonStatus: settingsMocks.fetchDaemonStatus,
  fetchDemoState: settingsMocks.fetchDemoState,
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
      installWarnings: ["Review before install."],
    },
    reviewRequired: true,
    policyChanges: { redactionMode: "basic" },
    unsupportedAssets: [],
    installPlan: [{ kind: "skill", assetId: "skill-1", reason: "Adds workflow", outcome: "stage" }],
  });
  settingsMocks.installCapabilityPack.mockResolvedValue({ ok: true });
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
}

function installBrowser() {
  vi.stubGlobal("window", {
    confirm: vi.fn(() => true),
    open: vi.fn(),
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
  it("renders general, access, onboarding demo, runtime, workspace, channel, tool, and add-on flows", async () => {
    const generalNavigate = vi.fn();
    const general = await mount("general", { navigate: generalNavigate });
    expect(collectText(general.root)).toContain("Mission Control posture");
    expect(collectText(general.root)).toContain("Quick routes");
    await click(buttons(general.root, "Open")[0]!);
    expect(generalNavigate).toHaveBeenCalledWith({ area: "settings", section: "providers", theme: "ops" });

    const access = await mount("access");
    expect(collectText(access.root)).toContain("Gateway access");
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
    await click(findButton(runtime.root, "Install starter model"));
    await click(findButton(runtime.root, "Activate first installed"));
    expect(settingsMocks.installVoiceRuntime).toHaveBeenCalledWith({ modelId: "base.en", activate: true });
    expect(settingsMocks.selectVoiceRuntimeModel).toHaveBeenCalledWith("base.en");

    const workspaceSetter = vi.fn();
    const workspacesPage = await mount("workspaces", { setActiveWorkspaceId: workspaceSetter });
    expect(collectText(workspacesPage.root)).toContain("Workspace directory");
    await click(findButton(workspacesPage.root, "Make active"));
    expect(workspaceSetter).toHaveBeenCalledWith("default");
    await click(findExactButton(workspacesPage.root, "Archive"));
    expect(settingsMocks.archiveWorkspace).toHaveBeenCalledWith("default");
    const workspaceInputs = workspacesPage.root.findAllByType("input");
    await change(workspaceInputs[0]!, "Created workspace");
    await change(workspaceInputs[1]!, "created-workspace");
    await click(findButton(workspacesPage.root, "Create workspace"));
    expect(settingsMocks.createWorkspace).toHaveBeenCalledWith({
      name: "Created workspace",
      slug: "created-workspace",
      description: undefined,
    });

    const channels = await mount("channels");
    expect(collectText(channels.root)).toContain("Channel definitions");
    await click(findButton(channels.root, "Detect Telegram Chats"));
    expect(settingsMocks.discoverTelegramTargets).toHaveBeenCalledWith({
      botToken: undefined,
      botTokenEnv: "TELEGRAM_TOKEN",
      setupCode: "SETUP",
    });
    await click(findButton(channels.root, "Save draft"));
    await click(findButton(channels.root, "Validate"));
    await click(findButton(channels.root, "Test"));
    await click(findButton(channels.root, "Finalize"));
    expect(settingsMocks.updateChannelSetupDraft).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({ enabled: true }),
    );
    expect(settingsMocks.validateChannelSetupDraft).toHaveBeenCalledWith("draft-1");
    expect(settingsMocks.testChannelSetupDraft).toHaveBeenCalledWith("draft-1");
    expect(settingsMocks.finalizeChannelSetupDraft).toHaveBeenCalledWith("draft-1");

    const tools = await mount("tools");
    expect(collectText(tools.root)).toContain("Tool catalog");
    await click(findButton(tools.root, "Save mode"));
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({ toolApprovalMode: "approve_risky" });
    await click(findButton(tools.root, "Create grant"));
    expect(settingsMocks.createToolGrant).toHaveBeenCalledWith(
      expect.objectContaining({ toolPattern: "shell.run", scopeRef: "default" }),
    );
    await click(findButton(tools.root, "Revoke"));
    expect(settingsMocks.revokeToolGrant).toHaveBeenCalledWith("grant-1");

    const addons = await mount("addons");
    await flush();
    expect(collectText(addons.root)).toContain("Add-on catalog");
    await click(findButton(addons.root, "Install"));
    await click(findButton(addons.root, "Update"));
    await click(findButton(addons.root, "Launch"));
    await click(findButton(addons.root, "Stop"));
    await click(findButton(addons.root, "Uninstall"));
    await click(findButton(addons.root, "Install disabled"));
    expect(settingsMocks.installAddon).toHaveBeenCalledWith("pixel-office", {
      actorId: "operator",
      confirmRepoDownload: true,
    });
    expect(settingsMocks.updateAddon).toHaveBeenCalledWith("pixel-office");
    expect(settingsMocks.launchAddon).toHaveBeenCalledWith("pixel-office");
    expect(settingsMocks.stopAddon).toHaveBeenCalledWith("pixel-office");
    expect(settingsMocks.uninstallAddon).toHaveBeenCalledWith("pixel-office");
    expect(settingsMocks.installCapabilityPack).toHaveBeenCalledWith("operator-pack", { actorId: "operator" });
  });

  it("covers integration detail actions and native load warnings", async () => {
    const integrations = await mount("integrations");
    expect(collectText(integrations.root)).toContain("GitHub");
    await click(findButton(integrations.root, "Run diagnostics"));
    expect(settingsMocks.fetchIntegrationConnectionDiagnostics).toHaveBeenCalledWith("conn-1");
    await click(findButton(integrations.root, "Save changes"));
    expect(settingsMocks.updateIntegrationConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({ enabled: true }),
    );
    await click(findButton(integrations.root, "Delete"));
    expect(settingsMocks.deleteIntegrationConnection).toHaveBeenCalledWith("conn-1");

    settingsMocks.fetchMcpServers.mockRejectedValueOnce(new Error("mcp offline"));
    const general = await mount("general");
    expect(collectText(general.root)).toContain("Some data could not load");
    expect(collectText(general.root)).toContain("mcp offline");
    await click(findButton(general.root, "Retry"));
    expect(settingsMocks.fetchMcpServers).toHaveBeenCalled();
  });
});
