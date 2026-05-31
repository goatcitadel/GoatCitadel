import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceAccessGrantListResponse, LocalOperatorOverrideRecord } from "@goatcitadel/contracts";
import { SettingsNativePage } from "./SettingsNativePage";

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn(async () => ({
    auth: {
      mode: "none",
      allowLoopbackBypass: true,
      tokenConfigured: false,
      basicConfigured: false,
    },
    llm: {
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
      providers: [],
      providerConfigs: [],
    },
  })),
  fetchLlmProviderAdvice: vi.fn(async () => ({
    generatedAt: "2026-05-22T00:00:00.000Z",
    preference: "low_cost",
    candidates: [
      {
        providerId: "openai",
        providerLabel: "OpenAI",
        model: "gpt-5.4-mini",
        configured: true,
        estimatedCostUsd: 0.1,
        costSource: "estimated",
        fitScore: 0.82,
        riskNotes: ["No immediate advisory risk noted."],
        requiredKeys: [],
      },
    ],
    advisoryOnly: true,
    mutationPerformed: false,
    warnings: ["Provider advice is advisory only; no provider settings or keys were changed."],
  })),
  fetchDeviceAccessGrants: vi.fn(async (): Promise<DeviceAccessGrantListResponse> => ({ items: [] })),
  fetchDaemonStatus: vi.fn(async () => ({
    running: true,
    pid: 4321,
    uptimeSeconds: 120,
    host: "localhost",
    state: "running" as const,
    supported: true,
    controllable: true,
    controlMessage: "Source checkout controls the gateway.",
  })),
  fetchToolCatalog: vi.fn(async () => ({
    items: [
      {
        toolName: "browser.search",
        category: "browser",
        description: "Search the web",
        pack: "core",
        riskLevel: "low",
      },
    ],
  })),
  fetchToolGrants: vi.fn(async () => ({ items: [] })),
  fetchTrustPolicySnapshot: vi.fn(async () => ({
    generatedAt: "2026-05-30T18:00:00.000Z",
    readOnly: true,
    mutationSemantics: "none",
    enforcementSources: ["tools.permissionProfiles", "capabilities.catalog", "mcp.servers"],
    sources: [],
    permissionProfiles: [
      {
        profileId: "safe",
        label: "Safe profile",
        builtin: true,
        status: "active",
        posture: "callable",
        approvalMode: "approve_all",
        source: "tools.permissionProfiles",
      },
    ],
    toolGrants: [
      {
        grantId: "grant-danger",
        toolPattern: "Dangerous shell",
        decision: "deny",
        posture: "blocked",
        scope: "workspace",
        grantType: "persistent",
        source: "tools.grants",
      },
    ],
    localOperatorOverrides: [],
    capabilities: {
      inspectable: [
        {
          capabilityId: "browser.search",
          kind: "tool",
          category: "browser",
          title: "Browser search",
          summary: "Search the web",
          callable: true,
          posture: "callable",
          source: "capabilities.catalog",
          trustLabel: "trusted",
          declaredTools: ["browser.search"],
        },
      ],
      callable: [
        {
          capabilityId: "browser.search",
          kind: "tool",
          category: "browser",
          title: "Browser search",
          summary: "Search the web",
          callable: true,
          posture: "callable",
          source: "capabilities.catalog",
          trustLabel: "trusted",
          declaredTools: ["browser.search"],
        },
      ],
    },
    mcpServers: [
      {
        serverId: "mcp-quarantined",
        label: "Quarantined MCP",
        enabled: true,
        status: "connected",
        trustTier: "quarantined",
        posture: "quarantined",
        source: "mcp.servers",
        tools: [{ toolName: "mcp.inspect", enabled: true, posture: "quarantined", source: "mcp.tools" }],
      },
    ],
    skills: [],
    addons: [],
    lastUseEvidence: [
      {
        source: "mcp.servers",
        subjectType: "mcp_server",
        subjectId: "mcp-quarantined",
        lastConnectedAt: "2026-05-30T17:45:00.000Z",
        status: "connected",
      },
    ],
  })),
  createToolGrant: vi.fn(async (input) => ({
    grantId: "grant-ttl",
    createdAt: "2026-05-02T18:00:00.000Z",
    createdBy: "operator",
    ...input,
  })),
  revokeToolGrant: vi.fn(async (grantId: string) => ({ revoked: true, grantId, revokedBy: "operator" })),
  fetchPermissionProfiles: vi.fn(async () => ({
    items: [
      {
        profileId: "safe",
        label: "Safe",
        scope: "global",
        builtin: true,
        approvalMode: "approve_all",
        toolPatterns: ["*"],
        createdAt: "2026-05-02T18:00:00.000Z",
        updatedAt: "2026-05-02T18:00:00.000Z",
      },
      {
        profileId: "trusted_local_power",
        label: "Trusted Local Power",
        description: "Run allowed local tools without normal prompts.",
        scope: "global",
        builtin: true,
        approvalMode: "bypass",
        toolPatterns: ["*"],
        allow: ["*"],
        deny: [],
        createdAt: "2026-05-02T18:00:00.000Z",
        updatedAt: "2026-05-02T18:00:00.000Z",
      },
    ],
  })),
  fetchActiveLocalOperatorOverrides: vi.fn(
    async (): Promise<{ items: LocalOperatorOverrideRecord[] }> => ({ items: [] }),
  ),
  fetchEffectivePermissionProfile: vi.fn(async () => ({
    permissionProfileId: "safe",
    permissionProfileLabel: "Safe",
    permissionProfileApprovalMode: "approve_all",
  })),
  createLocalOperatorOverride: vi.fn(async () => ({
    overrideId: "override-session-1",
    operatorId: "operator",
    scope: "session",
    scopeRef: "session-1",
    reason: "Run local tools for this session",
    status: "active",
    createdBy: "operator",
    createdAt: "2026-05-02T18:00:00.000Z",
    expiresAt: "2099-05-02T18:10:00.000Z",
  })),
  createPermissionProfile: vi.fn(async (input) => ({
    profileId: "profile-created",
    scope: "workspace",
    scopeRef: "default",
    builtin: false,
    createdBy: "operator",
    createdAt: "2026-05-02T18:00:00.000Z",
    updatedAt: "2026-05-02T18:00:00.000Z",
    ...input,
  })),
  updatePermissionProfile: vi.fn(async (profileId: string, input) => ({
    profileId,
    label: input.label ?? "Updated profile",
    scope: "workspace",
    scopeRef: "default",
    builtin: false,
    approvalMode: input.approvalMode ?? "approve_all",
    toolPatterns: input.toolPatterns ?? ["session.status"],
    createdAt: "2026-05-02T18:00:00.000Z",
    updatedAt: "2026-05-02T18:10:00.000Z",
  })),
  activatePermissionProfile: vi.fn(async (input) => ({
    activationId: "activation-1",
    createdAt: "2026-05-02T18:00:00.000Z",
    ...input,
  })),
  archivePermissionProfile: vi.fn(async (profileId: string) => ({ archived: true, profileId })),
  revokeLocalOperatorOverride: vi.fn(async (overrideId: string) => ({
    revoked: true,
    overrideId,
    status: "revoked",
    revokedAt: "2026-05-02T18:05:00.000Z",
    revokedBy: "operator",
  })),
  revokeDeviceAccessGrant: vi.fn(async (grantId: string) => ({
    grant: {
      grantId,
      requestId: "request-1",
      actorId: "operator",
      deviceLabel: "Android phone",
      deviceType: "mobile",
      platform: "Android",
      grantedBy: "operator",
      createdAt: "2026-05-02T18:00:00.000Z",
      metadata: {},
      revokedAt: "2026-05-02T19:00:00.000Z",
    },
  })),
  resolveGatewayInstallToken: vi.fn(async () => ({
    token: "install-token-1",
    source: "generated",
  })),
  patchSettings: vi.fn(async () => ({})),
  fetchPersonalities: vi.fn(async () => ({
    defaultPersonalityId: "operator",
    items: [
      {
        id: "default",
        label: "Default",
        category: "core",
        description: "No personality overlay.",
        tone: "",
        style: "",
        systemOverlay: "",
        soulFile: "docs/personalities/core/default.md",
        safetyNotes: ["Personality overlays never override safety policy."],
        visibility: "builtin",
        builtin: true,
        editable: false,
        modified: false,
      },
      {
        id: "operator",
        label: "Operator",
        category: "core",
        description: "Crisp mission-control style.",
        tone: "Composed",
        style: "Operational and compact",
        systemOverlay: "Use crisp mission-control language.",
        soulFile: "docs/personalities/core/operator.md",
        safetyNotes: ["Personality overlays never override safety policy."],
        visibility: "builtin",
        builtin: true,
        editable: true,
        modified: false,
      },
    ],
  })),
  createPersonality: vi.fn(async () => ({ defaultPersonalityId: "operator", items: [] })),
  updatePersonality: vi.fn(async () => ({ defaultPersonalityId: "operator", items: [] })),
  deletePersonality: vi.fn(async () => ({ defaultPersonalityId: "default", items: [] })),
  setDefaultPersonality: vi.fn(async () => ({ defaultPersonalityId: "operator", items: [] })),
  saveProviderSecret: vi.fn(async () => ({
    providerId: "openai",
    hasSecret: true,
    source: "keychain",
  })),
  deleteProviderSecret: vi.fn(async () => ({
    providerId: "openai",
    hasSecret: false,
    source: "none",
  })),
  fetchProviderSecretStatus: vi.fn(async () => ({
    providerId: "openai",
    hasSecret: true,
    source: "keychain",
  })),
  fetchOpenAICodexOAuthStatus: vi.fn(async () => ({
    providerId: "openai-codex",
    available: true,
    connected: false,
    requiresReauth: false,
  })),
  fetchIntegrationCatalog: vi.fn(async () => ({
    items: [
      {
        catalogId: "github",
        key: "github",
        label: "GitHub",
        kind: "service",
        capabilities: ["issues"],
        authMethods: ["token"],
      },
    ],
  })),
  fetchIntegrationConnections: vi.fn(async () => ({ items: [] })),
  fetchIntegrationFormSchema: vi.fn(async () => ({
    catalogId: "github",
    title: "GitHub setup",
    fields: [
      {
        key: "tokenEnv",
        label: "Token environment variable",
        type: "text",
        defaultValue: "GITHUB_TOKEN",
      },
    ],
  })),
  createIntegrationConnection: vi.fn(async () => ({
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
  })),
  fetchSlackOAuthStatus: vi.fn(async () => ({
    configured: true,
    mode: "self_owned",
    scopes: ["chat:write"],
    missing: [],
    connections: [],
  })),
  startSlackOAuth: vi.fn(async () => ({
    authorizationUrl: "https://slack.com/oauth/v2/authorize?state=test",
    state: "state",
    configured: true,
    mode: "self_owned",
    scopes: ["chat:write"],
  })),
  discoverTelegramTargets: vi.fn(async () => ({ items: [] })),
  fetchIntegrationPlugins: vi.fn(async () => ({
    items: [
      {
        pluginId: "dash-plugin",
        label: "Dashboard Plugin",
        version: "1.0.0",
        enabled: true,
        installedAt: "2026-04-24T12:00:00.000Z",
        updatedAt: "2026-04-24T12:00:00.000Z",
        capabilities: ["dashboard"],
        sourceMetadata: {
          type: "npm",
          display: "@goat/plugin-dashboard",
          packageName: "@goat/plugin-dashboard",
          packageVersion: "1.0.0",
          integrityStatus: "verified",
        },
        integrityStatus: "verified",
        trustWarnings: [],
        theme: {
          dashboardVariant: "compact",
          accentColor: "#14b8a6",
        },
      },
    ],
  })),
  fetchGoogleMeetPrerequisiteStatus: vi.fn(async () => ({
    ready: false,
    state: "blocked",
    provider: "openai-realtime",
    checkedAt: "2026-04-24T12:00:00.000Z",
    failureReason: "Google Meet OAuth profile is required before joining.",
    authProfile: {
      available: false,
      source: "missing",
    },
    prerequisites: [
      {
        id: "oauth_profile",
        ready: false,
        message: "Google Meet OAuth profile is required before joining.",
      },
    ],
  })),
  fetchGoogleMeetSessions: vi.fn(async () => []),
  startOpenAICodexOAuthDeviceFlow: vi.fn(async () => ({
    providerId: "openai-codex",
    flowId: "flow-1",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    expiresAt: "2099-04-24T12:00:00.000Z",
    pollAfterMs: 5000,
  })),
  pollOpenAICodexOAuthDeviceFlow: vi.fn(async () => ({
    providerId: "openai-codex",
    flowId: "flow-1",
    status: "connected",
    accountLabel: "user@example.com",
  })),
  deleteOpenAICodexOAuthCredential: vi.fn(async () => ({
    providerId: "openai-codex",
    available: true,
    connected: false,
    requiresReauth: false,
  })),
  fetchOnboardingState: vi.fn(async () => ({
    completed: false,
    checklist: [
      {
        id: "llm",
        label: "Provider configured",
        status: "needs_input",
        detail: "Select an active provider and model.",
      },
      {
        id: "runtime",
        label: "Runtime ready",
        status: "complete",
        detail: "Gateway is reachable.",
      },
    ],
    settings: {
      defaultToolProfile: "standard",
      budgetMode: "balanced",
      networkAllowlist: ["api.openai.com"],
      auth: {
        mode: "none",
        allowLoopbackBypass: true,
        tokenConfigured: false,
        basicConfigured: false,
      },
      llm: {
        activeProviderId: "openai",
        activeModel: "gpt-5.4-mini",
        providers: [],
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
  })),
  fetchDemoState: vi.fn(
    async (): Promise<any> => ({
      status: "ready",
      workspace: { workspaceId: "demo-workspace", name: "Demo", slug: "demo" },
      project: { projectId: "demo-project", name: "Demo Project", workspacePath: "F:\\code\\demo" },
      sessions: [
        { sessionId: "chat-demo", title: "Chat demo", mode: "chat", projectId: "demo-project" },
        { sessionId: "cowork-demo", title: "Cowork demo", mode: "cowork", projectId: "demo-project" },
      ],
      tasks: [],
      starterPrompts: [],
      memorySeeds: [],
      nextRoute: "/chat",
      notes: [],
    }),
  ),
  fetchAgenticRuns: vi.fn(async (): Promise<any> => ({ items: [] })),
  fetchEvidenceEnvelopes: vi.fn(async (): Promise<any> => ({ items: [] })),
  bootstrapDemo: vi.fn(async () => ({
    status: "ready",
    workspace: { workspaceId: "demo-workspace", name: "Demo", slug: "demo" },
    project: { projectId: "demo-project", name: "Demo Project", workspacePath: "F:\\code\\demo" },
    sessions: [
      { sessionId: "chat-demo", title: "Chat demo", mode: "chat", projectId: "demo-project" },
      { sessionId: "cowork-demo", title: "Cowork demo", mode: "cowork", projectId: "demo-project" },
    ],
    tasks: [],
    starterPrompts: [],
    memorySeeds: [],
    nextRoute: "/chat",
    notes: [],
  })),
  bootstrapOnboarding: vi.fn(async () => ({
    state: await mocks.fetchOnboardingState(),
    appliedAt: "2026-05-02T19:00:00.000Z",
  })),
  completeOnboarding: vi.fn(async () => ({ completed: true, completedAt: "2026-05-02T19:00:00.000Z" })),
  fetchMcpServers: vi.fn(async () => ({
    items: [
      {
        serverId: "srv-http",
        label: "Remote HTTP",
        transport: "http",
        url: "https://mcp.example.test",
        authType: "none",
        enabled: true,
        status: "disconnected",
        category: "development",
        trustTier: "restricted",
        costTier: "unknown",
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
  })),
  fetchMcpTemplates: vi.fn(async () => ({
    items: [
      {
        templateId: "stdio-template",
        label: "Local Files",
        description: "Local stdio template",
        transport: "stdio",
        command: "npx",
        authType: "none",
        category: "development",
        trustTier: "trusted",
        costTier: "free",
        policy: {
          requireFirstToolApproval: true,
          redactionMode: "basic",
          allowedToolPatterns: [],
          blockedToolPatterns: [],
        },
        enabledByDefault: true,
      },
    ],
  })),
  fetchMcpRemotePreview: vi.fn(async () => ({
    generatedAt: "2026-05-30T00:00:00.000Z",
    readOnly: true,
    mutationSemantics: "none",
    experimentalRemoteRecordsAllowed: false,
    runtimeSupport: "internal_approval_inbox_only",
    summary: {
      remoteServers: 1,
      remoteTemplates: 1,
      runtimeSupported: 0,
      blocked: 1,
      configuredOnly: 1,
    },
    items: [
      {
        source: "server",
        id: "srv-http",
        label: "Remote HTTP",
        transport: "http",
        url: "https://mcp.example.test",
        authType: "none",
        trustTier: "restricted",
        status: "disconnected",
        enabled: false,
        posture: "configured_only",
        callableState: "not_callable",
        createAllowed: false,
        runtimeSupported: false,
        blockers: ["Generic remote http/sse MCP runtime invocation is not supported in this shell."],
        governance: ["Deny-wins tool policy and MCP approval gates still apply before invocation."],
        evidence: {},
      },
    ],
  })),
  fetchMcpServerModeManifest: vi.fn(async () => ({
    generatedAt: "2026-05-30T00:00:00.000Z",
    readOnly: true,
    mutationSemantics: "none",
    status: "preview",
    protocol: "mcp",
    runtimeSupport: "call_preview",
    server: {
      name: "goatcitadel",
      label: "GoatCitadel governed capability export",
      version: "1.0.0",
      transport: "stdio",
    },
    launch: {
      supported: false,
      command: "goatcitadel",
      args: ["mcp-server"],
      reason: "MCP protocol serving and stdio launch are not wired yet.",
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
        supported: false,
        reason: "No launchable MCP stdio server has been shipped or proven.",
      },
    },
    summary: {
      inspectableCapabilities: 2,
      gatewayCallableCapabilities: 1,
      exportedToolDescriptors: 1,
      blockedDescriptors: 0,
    },
    tools: [
      {
        name: "goatcitadel.fs.read",
        title: "Read file",
        description: "Read a file through Gateway policy.",
        capabilityId: "tool:fs.read",
        capabilityKind: "tool",
        inputSchema: {},
        gatewayCallable: true,
        serverModeState: "call_preview",
        blockers: ["MCP protocol serving and stdio launch are not wired yet."],
        governance: ["Eligible for the operator-authenticated server-mode call preview."],
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
    ],
    governance: [],
    limitations: [],
    evidence: {
      catalogScope: "callable",
      catalogSnapshot: [{ capabilityId: "tool:fs.read", kind: "tool", callable: true }],
    },
  })),
  fetchMcpTools: vi.fn(async () => ({ items: [] })),
  createMcpServer: vi.fn(async () => ({
    serverId: "srv-stdio",
    label: "Local Files",
    transport: "stdio",
    command: "npx",
    authType: "none",
    enabled: true,
    status: "disconnected",
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
  })),
  updateMcpServer: vi.fn(async () => ({})),
  connectMcpServer: vi.fn(async () => ({})),
  disconnectMcpServer: vi.fn(async () => ({})),
  runMcpServerHealthCheck: vi.fn(async () => ({
    status: "ok",
    checkedAt: "2026-04-24T12:00:00.000Z",
    checks: [],
  })),
  deleteMcpServer: vi.fn(async () => ({})),
  loadModelsForProvider: vi.fn(async () => ["gpt-5.4-mini"]),
  getCachedModelProbe: vi.fn((): any => undefined),
  reload: vi.fn(async () => undefined),
  providerCatalogState: {
    config: {
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
      providers: [],
      providerConfigs: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    },
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-5.4-mini",
        apiStyle: "openai-responses",
        resolvedApiStyle: "openai-responses",
        models: ["gpt-5.4-mini"],
        hasApiKey: true,
        apiKeySource: "keychain",
        modelProbeState: "ready" as const,
        modelProbeSource: "live" as const,
        modelProbeCheckedAt: "2026-04-22T10:00:00.000Z",
      },
    ],
    loading: false,
    error: null as string | null,
  } as any,
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", async () => {
  const actual = await vi.importActual<typeof import("@goatcitadel/mission-control-shared/api/client")>(
    "@goatcitadel/mission-control-shared/api/client",
  );
  return {
    ...actual,
    patchSettings: mocks.patchSettings,
    fetchPersonalities: mocks.fetchPersonalities,
    createPersonality: mocks.createPersonality,
    updatePersonality: mocks.updatePersonality,
    deletePersonality: mocks.deletePersonality,
    setDefaultPersonality: mocks.setDefaultPersonality,
    saveProviderSecret: mocks.saveProviderSecret,
    deleteProviderSecret: mocks.deleteProviderSecret,
    fetchProviderSecretStatus: mocks.fetchProviderSecretStatus,
    fetchOpenAICodexOAuthStatus: mocks.fetchOpenAICodexOAuthStatus,
    fetchLlmProviderAdvice: mocks.fetchLlmProviderAdvice,
    fetchSettings: mocks.fetchSettings,
    fetchToolCatalog: mocks.fetchToolCatalog,
    fetchToolGrants: mocks.fetchToolGrants,
    createToolGrant: mocks.createToolGrant,
    revokeToolGrant: mocks.revokeToolGrant,
    fetchDeviceAccessGrants: mocks.fetchDeviceAccessGrants,
    fetchDaemonStatus: mocks.fetchDaemonStatus,
    fetchPermissionProfiles: mocks.fetchPermissionProfiles,
    fetchActiveLocalOperatorOverrides: mocks.fetchActiveLocalOperatorOverrides,
    fetchEffectivePermissionProfile: mocks.fetchEffectivePermissionProfile,
    createLocalOperatorOverride: mocks.createLocalOperatorOverride,
    createPermissionProfile: mocks.createPermissionProfile,
    updatePermissionProfile: mocks.updatePermissionProfile,
    activatePermissionProfile: mocks.activatePermissionProfile,
    archivePermissionProfile: mocks.archivePermissionProfile,
    revokeLocalOperatorOverride: mocks.revokeLocalOperatorOverride,
    revokeDeviceAccessGrant: mocks.revokeDeviceAccessGrant,
    resolveGatewayInstallToken: mocks.resolveGatewayInstallToken,
    bootstrapOnboarding: mocks.bootstrapOnboarding,
    completeOnboarding: mocks.completeOnboarding,
    fetchOnboardingState: mocks.fetchOnboardingState,
    fetchDemoState: mocks.fetchDemoState,
    fetchAgenticRuns: mocks.fetchAgenticRuns,
    fetchEvidenceEnvelopes: mocks.fetchEvidenceEnvelopes,
    bootstrapDemo: mocks.bootstrapDemo,
    fetchIntegrationCatalog: mocks.fetchIntegrationCatalog,
    fetchIntegrationConnections: mocks.fetchIntegrationConnections,
    fetchIntegrationFormSchema: mocks.fetchIntegrationFormSchema,
    createIntegrationConnection: mocks.createIntegrationConnection,
    fetchSlackOAuthStatus: mocks.fetchSlackOAuthStatus,
    startSlackOAuth: mocks.startSlackOAuth,
    discoverTelegramTargets: mocks.discoverTelegramTargets,
    fetchIntegrationPlugins: mocks.fetchIntegrationPlugins,
    fetchGoogleMeetPrerequisiteStatus: mocks.fetchGoogleMeetPrerequisiteStatus,
    fetchGoogleMeetSessions: mocks.fetchGoogleMeetSessions,
    fetchMcpServers: mocks.fetchMcpServers,
    fetchMcpRemotePreview: mocks.fetchMcpRemotePreview,
    fetchMcpServerModeManifest: mocks.fetchMcpServerModeManifest,
    fetchMcpTemplates: mocks.fetchMcpTemplates,
    fetchMcpTools: mocks.fetchMcpTools,
    createMcpServer: mocks.createMcpServer,
    updateMcpServer: mocks.updateMcpServer,
    connectMcpServer: mocks.connectMcpServer,
    disconnectMcpServer: mocks.disconnectMcpServer,
    runMcpServerHealthCheck: mocks.runMcpServerHealthCheck,
    deleteMcpServer: mocks.deleteMcpServer,
    startOpenAICodexOAuthDeviceFlow: mocks.startOpenAICodexOAuthDeviceFlow,
    pollOpenAICodexOAuthDeviceFlow: mocks.pollOpenAICodexOAuthDeviceFlow,
    deleteOpenAICodexOAuthCredential: mocks.deleteOpenAICodexOAuthCredential,
  };
});

vi.mock("@goatcitadel/mission-control-shared/api/trust", () => ({
  fetchTrustPolicySnapshot: mocks.fetchTrustPolicySnapshot,
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({
    ...mocks.providerCatalogState,
    loadModelsForProvider: mocks.loadModelsForProvider,
    getCachedModelProbe: mocks.getCachedModelProbe,
    reload: mocks.reload,
  }),
}));

function renderPage(section = "providers"): ReactTestRenderer {
  return create(
    <SettingsNativePage
      route={{ area: "settings", section, theme: "ops" } as any}
      activeWorkspaceId="default"
      activeWorkspaceName="Default"
      navigate={vi.fn()}
      setActiveWorkspaceId={vi.fn()}
    />,
  );
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const match = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!match) {
    throw new Error(`Unable to find button: ${label}`);
  }
  return match;
}

function findInputByPlaceholder(root: ReactTestInstance, placeholder: string): ReactTestInstance {
  const match = root.findAll(
    (node) =>
      node.type === "input" && typeof node.props?.placeholder === "string" && node.props.placeholder === placeholder,
  )[0];
  if (!match) {
    throw new Error(`Unable to find input: ${placeholder}`);
  }
  return match;
}

function findInputsByPlaceholder(root: ReactTestInstance, placeholder: string): ReactTestInstance[] {
  const matches = root.findAll(
    (node) =>
      node.type === "input" && typeof node.props?.placeholder === "string" && node.props.placeholder === placeholder,
  );
  if (!matches.length) {
    throw new Error(`Unable to find inputs: ${placeholder}`);
  }
  return matches;
}

function findFirstSelect(root: ReactTestInstance): ReactTestInstance {
  const match = root.findAllByType("select")[0];
  if (!match) {
    throw new Error("Unable to find select");
  }
  return match;
}

function findTextareas(root: ReactTestInstance): [ReactTestInstance, ReactTestInstance, ReactTestInstance] {
  const matches = root.findAllByType("textarea");
  if (matches.length < 3) {
    throw new Error("Unable to find personality textareas");
  }
  return [matches[0]!, matches[1]!, matches[2]!];
}

function findLoopbackCheckbox(root: ReactTestInstance): ReactTestInstance {
  const match = root.findAll((node) => node.type === "input" && node.props?.type === "checkbox")[0];
  if (!match) {
    throw new Error("Unable to find loopback checkbox");
  }
  return match;
}

function mockSettingsLoopback(allowLoopbackBypass: boolean) {
  mocks.fetchSettings.mockResolvedValueOnce({
    auth: {
      mode: "none",
      allowLoopbackBypass,
      tokenConfigured: false,
      basicConfigured: false,
    },
    llm: {
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
      providers: [],
      providerConfigs: [],
    },
  });
}

const OAUTH_STORAGE_KEY = "goatcitadel:openai-codex:oauth-flow";

function setCodexProviderCatalogState(overrides: Record<string, unknown> = {}) {
  mocks.providerCatalogState = {
    config: {
      activeProviderId: "openai-codex",
      activeModel: "openai-codex/gpt-5.5",
      providers: [],
      providerConfigs: [
        {
          providerId: "openai-codex",
          label: "OpenAI Codex (ChatGPT OAuth)",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          apiStyle: "openai-codex-responses",
          authMode: "codex-oauth",
          defaultModel: "gpt-5.5",
        },
      ],
    },
    providers: [
      {
        providerId: "openai-codex",
        label: "OpenAI Codex (ChatGPT OAuth)",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        defaultModel: "gpt-5.5",
        apiStyle: "openai-codex-responses",
        authMode: "codex-oauth",
        oauthStatus: {
          connected: false,
          requiresReauth: false,
        },
        models: ["gpt-5.5", "gpt-5.5-pro"],
        hasApiKey: false,
        apiKeySource: "none",
        modelProbeState: "ready" as const,
        modelProbeCheckedAt: "2026-04-22T10:00:00.000Z",
        ...overrides,
      },
    ],
    loading: false,
    error: null,
  };
}

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string") {
        return child;
      }
      if (typeof child === "number") {
        return String(child);
      }
      return collectText(child);
    })
    .join(" ");
}

async function flushAsyncUpdates() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function installBrowserStorageMock(
  initial: Record<string, string> | { local?: Record<string, string>; session?: Record<string, string> } = {},
) {
  const partitioned = "local" in initial || "session" in initial;
  const localStore = new Map(Object.entries(partitioned ? (initial.local ?? {}) : initial));
  const sessionStore = new Map(Object.entries(partitioned ? (initial.session ?? {}) : initial));
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  const buildStorage = (store: Map<string, string>) => ({
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
  });
  const localStorage = buildStorage(localStore);
  const sessionStorage = buildStorage(sessionStore);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorage,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: sessionStorage,
  });
  return () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: previousLocalStorage,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: previousSessionStorage,
    });
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.fetchSettings.mockResolvedValue({
    auth: {
      mode: "none",
      allowLoopbackBypass: true,
      tokenConfigured: false,
      basicConfigured: false,
    },
    llm: {
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
      providers: [],
      providerConfigs: [],
    },
  });
  mocks.fetchPersonalities.mockResolvedValue({
    defaultPersonalityId: "operator",
    items: [
      {
        id: "default",
        label: "Default",
        category: "core",
        description: "No personality overlay.",
        tone: "",
        style: "",
        systemOverlay: "",
        soulFile: "docs/personalities/core/default.md",
        safetyNotes: ["Personality overlays never override safety policy."],
        visibility: "builtin",
        builtin: true,
        editable: false,
        modified: false,
      },
      {
        id: "operator",
        label: "Operator",
        category: "core",
        description: "Crisp mission-control style.",
        tone: "Composed",
        style: "Operational and compact",
        systemOverlay: "Use crisp mission-control language.",
        soulFile: "docs/personalities/core/operator.md",
        safetyNotes: ["Personality overlays never override safety policy."],
        visibility: "builtin",
        builtin: true,
        editable: true,
        modified: true,
      },
      {
        id: "direct-custom",
        label: "Direct Custom",
        category: "execution",
        description: "Custom direct operator tone.",
        tone: "Direct",
        style: "Short",
        systemOverlay: "Keep it blunt and useful.",
        soulFile: "",
        safetyNotes: ["Personality overlays never override safety policy."],
        visibility: "custom",
        builtin: false,
        editable: true,
        modified: true,
      },
    ],
  });
  mocks.createPersonality.mockResolvedValue({ defaultPersonalityId: "operator", items: [] });
  mocks.updatePersonality.mockResolvedValue({ defaultPersonalityId: "operator", items: [] });
  mocks.deletePersonality.mockResolvedValue({ defaultPersonalityId: "default", items: [] });
  mocks.setDefaultPersonality.mockResolvedValue({ defaultPersonalityId: "operator", items: [] });
  mocks.fetchDeviceAccessGrants.mockResolvedValue({ items: [] });
  mocks.fetchPermissionProfiles.mockResolvedValue({
    items: [
      {
        profileId: "safe",
        label: "Safe",
        scope: "global",
        builtin: true,
        approvalMode: "approve_all",
        toolPatterns: ["*"],
        createdAt: "2026-05-02T18:00:00.000Z",
        updatedAt: "2026-05-02T18:00:00.000Z",
      },
      {
        profileId: "trusted_local_power",
        label: "Trusted Local Power",
        description: "Run allowed local tools without normal prompts.",
        scope: "global",
        builtin: true,
        approvalMode: "bypass",
        toolPatterns: ["*"],
        allow: ["*"],
        deny: [],
        createdAt: "2026-05-02T18:00:00.000Z",
        updatedAt: "2026-05-02T18:00:00.000Z",
      },
    ],
  });
  mocks.fetchActiveLocalOperatorOverrides.mockResolvedValue({ items: [] });
  mocks.fetchEffectivePermissionProfile.mockResolvedValue({
    permissionProfileId: "safe",
    permissionProfileLabel: "Safe",
    permissionProfileApprovalMode: "approve_all",
  });
  mocks.createLocalOperatorOverride.mockResolvedValue({
    overrideId: "override-session-1",
    operatorId: "operator",
    scope: "session",
    scopeRef: "session-1",
    reason: "Run local tools for this session",
    status: "active",
    createdBy: "operator",
    createdAt: "2026-05-02T18:00:00.000Z",
    expiresAt: "2099-05-02T18:10:00.000Z",
  });
  mocks.revokeLocalOperatorOverride.mockResolvedValue({
    revoked: true,
    overrideId: "override-session-1",
    status: "revoked",
    revokedAt: "2026-05-02T18:05:00.000Z",
    revokedBy: "operator",
  });
  mocks.fetchOnboardingState.mockResolvedValue({
    completed: false,
    checklist: [
      {
        id: "llm",
        label: "Provider configured",
        status: "needs_input",
        detail: "Select an active provider and model.",
      },
      {
        id: "runtime",
        label: "Runtime ready",
        status: "complete",
        detail: "Gateway is reachable.",
      },
    ],
    settings: {
      defaultToolProfile: "standard",
      budgetMode: "balanced",
      networkAllowlist: ["api.openai.com"],
      auth: {
        mode: "none",
        allowLoopbackBypass: true,
        tokenConfigured: false,
        basicConfigured: false,
      },
      llm: {
        activeProviderId: "openai",
        activeModel: "gpt-5.4-mini",
        providers: [],
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
  mocks.fetchAgenticRuns.mockResolvedValue({ items: [] });
  mocks.fetchEvidenceEnvelopes.mockResolvedValue({ items: [] });
  mocks.bootstrapOnboarding.mockResolvedValue({
    state: await mocks.fetchOnboardingState(),
    appliedAt: "2026-05-02T19:00:00.000Z",
  });
  mocks.completeOnboarding.mockResolvedValue({ completed: true, completedAt: "2026-05-02T19:00:00.000Z" });
  mocks.fetchIntegrationFormSchema.mockResolvedValue({
    catalogId: "github",
    title: "GitHub setup",
    fields: [
      {
        key: "tokenEnv",
        label: "Token environment variable",
        type: "text",
        defaultValue: "GITHUB_TOKEN",
      },
    ],
  });
  mocks.createIntegrationConnection.mockResolvedValue({
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
  });
  mocks.revokeDeviceAccessGrant.mockResolvedValue({
    grant: {
      grantId: "grant-1",
      requestId: "request-1",
      actorId: "operator",
      deviceLabel: "Android phone",
      deviceType: "mobile",
      platform: "Android",
      grantedBy: "operator",
      createdAt: "2026-05-02T18:00:00.000Z",
      metadata: {},
      revokedAt: "2026-05-02T19:00:00.000Z",
    },
  });
  mocks.resolveGatewayInstallToken.mockResolvedValue({
    token: "install-token-1",
    source: "generated",
  });
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
  mocks.fetchOpenAICodexOAuthStatus.mockResolvedValue({
    providerId: "openai-codex",
    available: true,
    connected: false,
    requiresReauth: false,
  });
  mocks.startOpenAICodexOAuthDeviceFlow.mockResolvedValue({
    providerId: "openai-codex",
    flowId: "flow-1",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    expiresAt: "2099-04-24T12:00:00.000Z",
    pollAfterMs: 5000,
  });
  mocks.pollOpenAICodexOAuthDeviceFlow.mockResolvedValue({
    providerId: "openai-codex",
    flowId: "flow-1",
    status: "connected",
    accountLabel: "user@example.com",
  });
  mocks.loadModelsForProvider = vi.fn(async () => ["gpt-5.4-mini"]);
  mocks.getCachedModelProbe = vi.fn(() => undefined);
  mocks.reload = vi.fn(async () => undefined);
  mocks.providerCatalogState = {
    config: {
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
      providers: [],
      providerConfigs: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    },
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-5.4-mini",
        apiStyle: "openai-responses",
        resolvedApiStyle: "openai-responses",
        models: ["gpt-5.4-mini"],
        hasApiKey: true,
        apiKeySource: "keychain",
        modelProbeState: "ready" as const,
        modelProbeSource: "live" as const,
        modelProbeCheckedAt: "2026-04-22T10:00:00.000Z",
      },
    ],
    loading: false,
    error: null,
  };
});

describe("SettingsNativePage personalities", () => {
  it("renders the catalog and calls create, save, reset, remove, and default APIs", async () => {
    const previousWindow = globalThis.window;
    const confirmSpy = vi.fn(() => true);
    Object.assign(globalThis, {
      window: {
        confirm: confirmSpy,
      },
    });
    let renderer: ReactTestRenderer | null = null;

    try {
      await act(async () => {
        renderer = renderPage("personalities");
      });

      let text = collectText(renderer!.root);
      expect(text).toContain("Personality catalog");
      expect(text).toContain("Operator");
      expect(text).toContain("Chat default");
      expect(text).toContain("Add custom personality");

      await act(async () => {
        findButton(renderer!.root, "Refresh").props.onClick();
      });
      expect(mocks.fetchPersonalities).toHaveBeenCalledTimes(2);

      await act(async () => {
        findInputByPlaceholder(renderer!.root, "Direct Operator").props.onChange({
          target: { value: "Operator Prime" },
        });
      });
      await act(async () => {
        findInputByPlaceholder(renderer!.root, "Composed").props.onChange({
          target: { value: "Measured" },
        });
      });
      await act(async () => {
        findInputByPlaceholder(renderer!.root, "Operational and compact").props.onChange({
          target: { value: "Brief and directive" },
        });
      });
      const [operatorDescription, operatorOverlay, operatorSafety] = findTextareas(renderer!.root);
      await act(async () => {
        operatorDescription.props.onChange({
          target: { value: "Updated built-in operator framing." },
        });
      });
      await act(async () => {
        operatorOverlay.props.onChange({
          target: { value: "Use updated operator-prime language." },
        });
      });
      await act(async () => {
        operatorSafety.props.onChange({
          target: { value: "Never override approvals.\nNever hide uncertainty." },
        });
      });
      await act(async () => {
        findButton(renderer!.root, "Save edits").props.onClick();
      });
      expect(mocks.updatePersonality).toHaveBeenCalledWith(
        "operator",
        expect.objectContaining({
          id: "operator",
          label: "Operator Prime",
          description: "Updated built-in operator framing.",
          tone: "Measured",
          style: "Brief and directive",
          systemOverlay: "Use updated operator-prime language.",
          safetyNotes: ["Never override approvals.", "Never hide uncertainty."],
        }),
      );

      await act(async () => {
        findButton(renderer!.root, "Set as Chat default").props.onClick();
      });
      expect(mocks.setDefaultPersonality).toHaveBeenCalledWith("operator");

      await act(async () => {
        findButton(renderer!.root, "Reset built-in").props.onClick();
      });
      expect(mocks.deletePersonality).toHaveBeenCalledWith("operator");

      await act(async () => {
        findButton(renderer!.root, "Direct Custom").props.onClick();
      });
      await act(async () => {
        findButton(renderer!.root, "Remove custom").props.onClick();
      });
      expect(confirmSpy).toHaveBeenCalledWith("Remove Direct Custom?");
      expect(mocks.deletePersonality).toHaveBeenCalledWith("direct-custom");

      await act(async () => {
        findButton(renderer!.root, "Add custom personality").props.onClick();
      });
      await act(async () => {
        findInputByPlaceholder(renderer!.root, "direct-operator").props.onChange({
          target: { value: "night-shift" },
        });
      });
      await act(async () => {
        findInputByPlaceholder(renderer!.root, "Direct Operator").props.onChange({
          target: { value: "Night Shift" },
        });
      });
      await act(async () => {
        findFirstSelect(renderer!.root).props.onChange({
          target: { value: "execution" },
        });
      });
      await act(async () => {
        findInputByPlaceholder(renderer!.root, "Composed").props.onChange({
          target: { value: "Steady" },
        });
      });
      await act(async () => {
        findInputByPlaceholder(renderer!.root, "Operational and compact").props.onChange({
          target: { value: "Checklist first" },
        });
      });
      const [customDescription, customOverlay, customSafety] = findTextareas(renderer!.root);
      await act(async () => {
        customDescription.props.onChange({
          target: { value: "Keeps late work direct and calm." },
        });
      });
      await act(async () => {
        customOverlay.props.onChange({
          target: { value: "Prefer short status-first answers." },
        });
      });
      await act(async () => {
        customSafety.props.onChange({
          target: { value: "Do not bypass policy.\nAsk before risky actions." },
        });
      });
      await act(async () => {
        findButton(renderer!.root, "Create personality").props.onClick();
      });
      expect(mocks.createPersonality).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "night-shift",
          label: "Night Shift",
          category: "execution",
          description: "Keeps late work direct and calm.",
          tone: "Steady",
          style: "Checklist first",
          systemOverlay: "Prefer short status-first answers.",
          safetyNotes: ["Do not bypass policy.", "Ask before risky actions."],
        }),
      );

      text = collectText(renderer!.root);
      expect(text).toContain("Personality overlays affect Chat tone and framing only");
    } finally {
      Object.assign(globalThis, { window: previousWindow });
    }
  });

  it("covers personality validation, locked rows, clear-default, and remove failure branches", async () => {
    const previousWindow = globalThis.window;
    const confirmSpy = vi.fn(() => false);
    Object.assign(globalThis, {
      window: {
        confirm: confirmSpy,
      },
    });
    let renderer: ReactTestRenderer | null = null;

    try {
      await act(async () => {
        renderer = renderPage("personalities");
      });

      await act(async () => {
        findButton(renderer!.root, "Add custom personality").props.onClick();
      });
      await act(async () => {
        findButton(renderer!.root, "Create personality").props.onClick();
      });
      expect(collectText(renderer!.root)).toContain("Personality label is required.");
      expect(mocks.createPersonality).not.toHaveBeenCalled();

      await act(async () => {
        findButton(renderer!.root, "Cancel").props.onClick();
      });
      expect(collectText(renderer!.root)).toContain("Operator");

      mocks.updatePersonality.mockRejectedValueOnce(new Error("save failed"));
      await act(async () => {
        findButton(renderer!.root, "Save edits").props.onClick();
      });
      expect(collectText(renderer!.root)).toContain("save failed");

      await act(async () => {
        findButton(renderer!.root, "Default").props.onClick();
      });
      const lockedSave = findButton(renderer!.root, "Save edits");
      expect(lockedSave.props.disabled).toBe(true);
      await act(async () => {
        lockedSave.props.onClick();
      });
      expect(collectText(renderer!.root)).toContain("This personality cannot be edited.");

      await act(async () => {
        findButton(renderer!.root, "Clear Chat default").props.onClick();
      });
      expect(mocks.setDefaultPersonality).toHaveBeenCalledWith("default");
      expect(collectText(renderer!.root)).toContain("Chat personality cleared.");

      await act(async () => {
        findButton(renderer!.root, "Direct Custom").props.onClick();
      });
      await act(async () => {
        findButton(renderer!.root, "Remove custom").props.onClick();
      });
      expect(confirmSpy).toHaveBeenCalledWith("Remove Direct Custom?");
      expect(mocks.deletePersonality).not.toHaveBeenCalled();

      confirmSpy.mockReturnValue(true);
      mocks.deletePersonality.mockRejectedValueOnce(new Error("remove failed"));
      await act(async () => {
        findButton(renderer!.root, "Remove custom").props.onClick();
      });
      expect(collectText(renderer!.root)).toContain("remove failed");
    } finally {
      Object.assign(globalThis, { window: previousWindow });
    }
  });
});

describe("SettingsNativePage permissions", () => {
  it("keeps all-surfaces activation as one dedicated action", async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPage("permissions");
    });
    await flushAsyncUpdates();

    const activationLabels = renderer!.root
      .findAll((node) => node.type === "button" && collectText(node).includes("Use for"))
      .map((node) => collectText(node).trim().toLowerCase());
    expect(activationLabels).toContain("use for all surfaces");
    expect(activationLabels).toContain("use for code");
    expect(activationLabels.some((label) => label !== "use for all surfaces" && label !== "use for code")).toBe(true);
    expect(activationLabels).not.toContain("use for all");

    await act(async () => {
      findButton(renderer!.root, "Use for all surfaces").props.onClick();
    });
    await flushAsyncUpdates();
    expect(mocks.activatePermissionProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "safe", workspaceId: "default", surface: "all" }),
    );
  });

  it("edits and archives custom permission profiles", async () => {
    mocks.fetchPermissionProfiles.mockResolvedValue({
      items: [
        {
          profileId: "safe",
          label: "Safe",
          scope: "global",
          builtin: true,
          approvalMode: "approve_all",
          toolPatterns: ["*"],
          createdAt: "2026-05-02T18:00:00.000Z",
          updatedAt: "2026-05-02T18:00:00.000Z",
        },
        {
          profileId: "profile-review",
          label: "Review profile",
          description: "Initial profile",
          scope: "workspace",
          scopeRef: "default",
          builtin: false,
          approvalMode: "approve_risky",
          toolPatterns: ["session.status", "browser.search"],
          allow: ["browser.search"],
          deny: ["shell.exec"],
          readAccessMode: "roots_only",
          defaultForSurfaces: ["code"],
          createdBy: "operator",
          createdAt: "2026-05-02T18:00:00.000Z",
          updatedAt: "2026-05-02T18:00:00.000Z",
        },
      ],
    } as any);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPage("permissions");
    });
    await flushAsyncUpdates();

    await act(async () => {
      findInputByPlaceholder(renderer!.root, "Review mode, research mode, release captain").props.onChange({
        target: { value: "Research fast path" },
      });
    });
    const createTextareas = renderer!.root.findAllByType("textarea");
    await act(async () => {
      createTextareas
        .find((node) => node.props.placeholder === "Why this profile exists and when to use it")!
        .props.onChange({ target: { value: "Use for local research runs." } });
      createTextareas
        .find((node) => node.props.placeholder === "Optional allow patterns")!
        .props.onChange({ target: { value: "browser.search\nmemory.read" } });
      createTextareas
        .find((node) => node.props.placeholder === "Optional deny patterns")!
        .props.onChange({ target: { value: "shell.exec" } });
    });
    const createSelects = renderer!.root.findAllByType("select");
    await act(async () => {
      createSelects.find((node) => node.props.value === "")!.props.onChange({ target: { value: "full_disk" } });
    });
    const createSurfaceCheckboxes = renderer!.root.findAll(
      (node) => node.type === "input" && node.props.type === "checkbox",
    );
    await act(async () => {
      createSurfaceCheckboxes[2]!.props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      findButton(renderer!.root, "Create profile").props.onClick();
    });
    await flushAsyncUpdates();
    expect(mocks.createPermissionProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Research fast path",
        description: "Use for local research runs.",
        scope: "workspace",
        scopeRef: "default",
        allow: ["browser.search", "memory.read"],
        deny: ["shell.exec"],
        readAccessMode: "full_disk",
        defaultForSurfaces: ["code"],
      }),
    );

    await act(async () => {
      findButton(renderer!.root, "Review profile").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("Edit custom profile");

    const nameInput = renderer!.root.findAll(
      (node) => node.type === "input" && node.props.value === "Review profile",
    )[0];
    await act(async () => {
      nameInput!.props.onChange({ target: { value: "Review profile v2" } });
    });
    const descriptionTextarea = renderer!.root.findAll(
      (node) => node.type === "textarea" && node.props.value === "Initial profile",
    )[0];
    await act(async () => {
      descriptionTextarea!.props.onChange({ target: { value: "Tighter review profile" } });
    });
    const patternsTextarea = renderer!.root.findAll(
      (node) => node.type === "textarea" && node.props.value === "session.status\nbrowser.search",
    )[0];
    await act(async () => {
      patternsTextarea!.props.onChange({ target: { value: "session.status\nbrowser.open" } });
    });
    const allowTextarea = renderer!.root.findAll(
      (node) => node.type === "textarea" && node.props.value === "browser.search",
    )[0];
    const denyTextarea = renderer!.root.findAll(
      (node) => node.type === "textarea" && node.props.value === "shell.exec",
    )[0];
    await act(async () => {
      allowTextarea!.props.onChange({ target: { value: "browser.search\nfs.read" } });
      denyTextarea!.props.onChange({ target: { value: "shell.exec\nbrowser.open" } });
    });
    const readAccessSelect = renderer!.root.findAll(
      (node) => node.type === "select" && node.props.value === "roots_only",
    )[0];
    await act(async () => {
      readAccessSelect!.props.onChange({ target: { value: "approval_required" } });
    });
    const editSurfaceCheckboxes = renderer!.root.findAll(
      (node) => node.type === "input" && node.props.type === "checkbox",
    );
    await act(async () => {
      editSurfaceCheckboxes[0]!.props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      findButton(renderer!.root, "Save profile").props.onClick();
    });
    await flushAsyncUpdates();

    expect(mocks.updatePermissionProfile).toHaveBeenCalledWith(
      "profile-review",
      expect.objectContaining({
        label: "Review profile v2",
        description: "Tighter review profile",
        toolPatterns: ["session.status", "browser.open"],
        allow: ["browser.search", "fs.read"],
        deny: ["shell.exec", "browser.open"],
        readAccessMode: "approval_required",
        defaultForSurfaces: ["code", "chat"],
      }),
    );

    const previousWindow = globalThis.window;
    const confirmSpy = vi.fn(() => false);
    Object.assign(globalThis, {
      window: {
        confirm: confirmSpy,
      },
    });
    try {
      await act(async () => {
        findButton(renderer!.root, "Archive profile").props.onClick();
      });
      await flushAsyncUpdates();
      expect(confirmSpy).toHaveBeenCalledWith("Archive permission profile Review profile?");
      expect(mocks.archivePermissionProfile).not.toHaveBeenCalled();

      confirmSpy.mockReturnValue(true);
      await act(async () => {
        findButton(renderer!.root, "Archive profile").props.onClick();
      });
      await flushAsyncUpdates();
      expect(mocks.archivePermissionProfile).toHaveBeenCalledWith("profile-review");
    } finally {
      Object.assign(globalThis, { window: previousWindow });
    }
  });

  it("keeps skip-routine custom profiles unavailable in Remote Hardened mode", async () => {
    mocks.fetchSettings.mockResolvedValueOnce({
      auth: {
        mode: "token",
        allowLoopbackBypass: false,
        tokenConfigured: true,
        basicConfigured: false,
      },
      llm: {
        activeProviderId: "openai",
        activeModel: "gpt-5.4-mini",
        providers: [],
        providerConfigs: [],
      },
      deploymentProfile: "remote_hardened",
      toolApprovalMode: "approve_risky",
    } as any);
    mocks.fetchPermissionProfiles.mockResolvedValue({
      items: [
        {
          profileId: "safe",
          label: "Safe",
          scope: "global",
          builtin: true,
          approvalMode: "approve_all",
          toolPatterns: ["*"],
          createdAt: "2026-05-02T18:00:00.000Z",
          updatedAt: "2026-05-02T18:00:00.000Z",
        },
        {
          profileId: "trusted_local_power",
          label: "Trusted Local Power",
          scope: "global",
          builtin: true,
          approvalMode: "bypass",
          toolPatterns: ["*"],
          createdAt: "2026-05-02T18:00:00.000Z",
          updatedAt: "2026-05-02T18:00:00.000Z",
        },
        {
          profileId: "profile-fast",
          label: "Fast profile",
          scope: "workspace",
          scopeRef: "default",
          builtin: false,
          approvalMode: "bypass",
          toolPatterns: ["*"],
          createdBy: "operator",
          createdAt: "2026-05-02T18:00:00.000Z",
          updatedAt: "2026-05-02T18:00:00.000Z",
        },
      ],
    } as any);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPage("permissions");
    });
    await flushAsyncUpdates();

    const bypassOptions = renderer!.root.findAll((node) => node.type === "option" && node.props.value === "bypass");
    expect(bypassOptions.length).toBeGreaterThan(0);
    expect(bypassOptions.every((node) => node.props.disabled === true)).toBe(true);
    expect(collectText(renderer!.root)).toContain(
      "Remote Hardened keeps profiles that skip normal prompts unavailable.",
    );

    await act(async () => {
      findButton(renderer!.root, "Trusted Local Power").props.onClick();
    });
    const disabledActivationButtons = renderer!.root.findAll(
      (node) => node.type === "button" && collectText(node).includes("Use for"),
    );
    expect(disabledActivationButtons.length).toBeGreaterThan(0);
    expect(disabledActivationButtons.every((button) => button.props.disabled === true)).toBe(true);
    await act(async () => {
      disabledActivationButtons[0]!.props.onClick();
    });
    await flushAsyncUpdates();
    expect(mocks.activatePermissionProfile).not.toHaveBeenCalled();
    expect(collectText(renderer!.root)).toContain(
      "Remote Hardened keeps profiles that skip normal prompts unavailable.",
    );

    await act(async () => {
      findButton(renderer!.root, "Fast profile").props.onClick();
    });
    await act(async () => {
      findButton(renderer!.root, "Save profile").props.onClick();
    });
    await flushAsyncUpdates();

    expect(mocks.updatePermissionProfile).not.toHaveBeenCalled();
    expect(collectText(renderer!.root)).toContain(
      "Remote Hardened keeps profiles that skip normal prompts unavailable.",
    );

    const overrideButton = findButton(renderer!.root, "Start temporary override");
    expect(overrideButton.props.disabled).toBe(true);
    await act(async () => {
      overrideButton.props.onClick();
    });
    await flushAsyncUpdates();
    expect(mocks.createLocalOperatorOverride).not.toHaveBeenCalled();
    expect(collectText(renderer!.root)).toContain("Remote Hardened mode keeps Local Operator Override unavailable.");
  });

  it("fails closed for prompt-skipping controls when settings cannot be loaded", async () => {
    mocks.fetchSettings.mockRejectedValueOnce(new Error("settings unavailable"));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPage("permissions");
    });
    await flushAsyncUpdates();

    await act(async () => {
      findButton(renderer!.root, "Trusted Local Power").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain(
      "Settings could not be loaded, so profiles that skip normal prompts stay unavailable.",
    );

    const disabledActivationButtons = renderer!.root.findAll(
      (node) => node.type === "button" && collectText(node).includes("Use for"),
    );
    expect(disabledActivationButtons.length).toBeGreaterThan(0);
    expect(disabledActivationButtons.every((button) => button.props.disabled === true)).toBe(true);
    await act(async () => {
      disabledActivationButtons[0]!.props.onClick();
    });
    await flushAsyncUpdates();
    expect(mocks.activatePermissionProfile).not.toHaveBeenCalled();

    const overrideButton = findButton(renderer!.root, "Start temporary override");
    expect(overrideButton.props.disabled).toBe(true);
    await act(async () => {
      overrideButton.props.onClick();
    });
    await flushAsyncUpdates();
    expect(mocks.createLocalOperatorOverride).not.toHaveBeenCalled();
    expect(collectText(renderer!.root)).toContain(
      "Settings could not be loaded, so Local Operator Override stays unavailable.",
    );
  });

  it("keeps session-scoped Local Operator Override evidence visible after effective-state reloads", async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPage("permissions");
    });
    await flushAsyncUpdates();

    const scopeSelect = renderer!.root.findAllByType("select").find((node) => node.props.value === "workspace");
    expect(scopeSelect).toBeDefined();
    await act(async () => {
      scopeSelect!.props.onChange({ target: { value: "session" } });
    });
    await act(async () => {
      findInputByPlaceholder(renderer!.root, "session id").props.onChange({ target: { value: "session-1" } });
    });
    const reasonTextarea = renderer!.root.findAll(
      (node) =>
        node.type === "textarea" && node.props.placeholder === "Why this local run needs temporary fast-path execution",
    )[0];
    expect(reasonTextarea).toBeDefined();
    await act(async () => {
      reasonTextarea!.props.onChange({ target: { value: "Run local tools for this session" } });
    });
    const overrideButton = findButton(renderer!.root, "Start temporary override");
    expect(overrideButton.props.disabled).toBe(true);
    const overrideAcknowledgement = renderer!.root
      .findAll((node) => node.type === "input" && node.props.type === "checkbox" && node.props.disabled !== true)
      .at(-1);
    expect(overrideAcknowledgement).toBeDefined();
    await act(async () => {
      overrideAcknowledgement!.props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      findButton(renderer!.root, "Start temporary override").props.onClick();
    });
    await flushAsyncUpdates();

    expect(mocks.createLocalOperatorOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "session",
        scopeRef: "session-1",
      }),
    );
    expect(collectText(renderer!.root)).toContain("override-session-1");
    expect(findButton(renderer!.root, "End")).toBeDefined();
    const initialText = collectText(renderer!.root);
    expect(initialText).toContain("broad local tool access");
    expect(initialText).toContain("normal prompts");

    await act(async () => {
      renderer!.unmount();
    });
    mocks.fetchActiveLocalOperatorOverrides.mockResolvedValue({
      items: [
        {
          overrideId: "override-session-1",
          operatorId: "operator",
          scope: "session",
          scopeRef: "session-1",
          reason: "Run local tools for this session",
          status: "active",
          createdBy: "operator",
          createdAt: "2026-05-02T18:00:00.000Z",
          expiresAt: "2099-05-02T18:10:00.000Z",
        },
        {
          overrideId: "override-run-2",
          operatorId: "operator",
          scope: "run",
          scopeRef: "run-2",
          reason: "Run local tools for this run",
          status: "active",
          createdBy: "operator",
          createdAt: "2026-05-02T18:00:00.000Z",
          expiresAt: "2099-05-02T18:20:00.000Z",
        },
      ],
    });
    await act(async () => {
      renderer = renderPage("permissions");
    });
    await flushAsyncUpdates();
    expect(collectText(renderer!.root)).toContain("override-session-1");
    expect(collectText(renderer!.root)).toContain("override-run-2");
    expect(renderer!.root.findAll((node) => node.type === "button" && collectText(node).includes("End"))).toHaveLength(
      2,
    );
  });

  it("reads nested effective permission profiles from the gateway response", async () => {
    mocks.fetchEffectivePermissionProfile.mockResolvedValue({
      permissionProfile: {
        profileId: "safe",
        label: "Nested Safe",
        approvalMode: "approve_all",
      },
      localOperatorOverride: {
        overrideId: "override-nested",
        operatorId: "operator",
        scope: "session",
        scopeRef: "session-1",
        reason: "Nested gateway state",
        status: "active",
        createdBy: "operator",
        createdAt: "2026-05-02T18:00:00.000Z",
        expiresAt: "2099-05-02T18:10:00.000Z",
      },
    } as any);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPage("permissions");
    });
    await flushAsyncUpdates();

    const text = collectText(renderer!.root);
    expect(text).toContain("Nested Safe");
    expect(text).toContain("override-nested");
  });
});

describe("SettingsNativePage tools", () => {
  it("keeps approval bypass unavailable in Remote Hardened mode", async () => {
    mocks.fetchSettings.mockResolvedValueOnce({
      auth: {
        mode: "token",
        allowLoopbackBypass: false,
        tokenConfigured: true,
        basicConfigured: false,
      },
      llm: {
        activeProviderId: "openai",
        activeModel: "gpt-5.4-mini",
        providers: [],
        providerConfigs: [],
      },
      deploymentProfile: "remote_hardened",
      toolApprovalMode: "approve_risky",
    } as any);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderPage("tools");
    });
    await flushAsyncUpdates();

    const bypassOption = renderer!.root.findAll((node) => node.type === "option" && node.props.value === "bypass")[0];
    expect(bypassOption).toBeDefined();
    expect(bypassOption!.props.disabled).toBe(true);
    expect(collectText(renderer!.root)).toContain("Remote Hardened mode keeps routine prompt skipping unavailable");

    const approvalSelect = renderer!.root.findAll(
      (node) => node.type === "select" && node.props.value === "approve_risky",
    )[0];
    expect(approvalSelect).toBeDefined();
    await act(async () => {
      approvalSelect!.props.onChange({ target: { value: "bypass" } });
    });
    await act(async () => {
      findButton(renderer!.root, "Save mode").props.onClick();
    });
    await flushAsyncUpdates();

    expect(mocks.patchSettings).not.toHaveBeenCalledWith(expect.objectContaining({ toolApprovalMode: "bypass" }));
    expect(mocks.patchSettings).toHaveBeenCalledWith({ toolApprovalMode: "approve_risky" });
  });

  it("keeps approval bypass unavailable when settings cannot be loaded", async () => {
    mocks.fetchSettings.mockRejectedValueOnce(new Error("settings unavailable"));
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderPage("tools");
    });
    await flushAsyncUpdates();

    const bypassOption = renderer!.root.findAll((node) => node.type === "option" && node.props.value === "bypass")[0];
    expect(bypassOption).toBeDefined();
    expect(bypassOption!.props.disabled).toBe(true);
    const text = collectText(renderer!.root);
    expect(text).toContain("Settings could not be loaded, so routine prompt skipping stays unavailable.");
    expect(text).toContain("Unavailable Current");

    const approvalSelect = renderer!.root.findAll(
      (node) => node.type === "select" && node.props.value === "approve_risky",
    )[0];
    await act(async () => {
      approvalSelect!.props.onChange({ target: { value: "bypass" } });
    });
    await act(async () => {
      findButton(renderer!.root, "Save mode").props.onClick();
    });
    await flushAsyncUpdates();

    expect(mocks.patchSettings).not.toHaveBeenCalledWith(expect.objectContaining({ toolApprovalMode: "bypass" }));
  });

  it("counts only usable matching grants as available for a selected tool", async () => {
    mocks.fetchToolGrants.mockResolvedValueOnce({
      items: [
        {
          grantId: "grant-active",
          toolPattern: "browser.*",
          decision: "allow",
          scope: "workspace",
          scopeRef: "default",
          grantType: "persistent",
          createdBy: "operator",
          createdAt: "2026-05-02T18:00:00.000Z",
        },
        {
          grantId: "grant-revoked",
          toolPattern: "browser.search",
          decision: "allow",
          scope: "workspace",
          scopeRef: "default",
          grantType: "persistent",
          createdBy: "operator",
          createdAt: "2026-05-02T18:00:00.000Z",
          revokedAt: "2026-05-02T19:00:00.000Z",
        },
        {
          grantId: "grant-expired",
          toolPattern: "browser.search",
          decision: "allow",
          scope: "workspace",
          scopeRef: "default",
          grantType: "ttl",
          createdBy: "operator",
          createdAt: "2026-05-02T18:00:00.000Z",
          expiresAt: "2026-05-02T19:00:00.000Z",
        },
        {
          grantId: "grant-spent",
          toolPattern: "browser.search",
          decision: "allow",
          scope: "workspace",
          scopeRef: "default",
          grantType: "one_time",
          createdBy: "operator",
          createdAt: "2026-05-02T18:00:00.000Z",
          usesRemaining: 0,
        },
        {
          grantId: "grant-other",
          toolPattern: "fs.write",
          decision: "allow",
          scope: "workspace",
          scopeRef: "default",
          grantType: "persistent",
          createdBy: "operator",
          createdAt: "2026-05-02T18:00:00.000Z",
        },
      ],
    } as any);
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderPage("tools");
    });
    await flushAsyncUpdates();

    const availableMetric = renderer!.root
      .findAll((node) => node.props.className === "mc-next-settings-metric")
      .find((node) => collectText(node).includes("Available grants"));

    expect(availableMetric).toBeDefined();
    expect(collectText(availableMetric!)).toContain("Available grants 1 Active, unexpired matches");
  });

  it("submits TTL grants with an explicit expiry", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderPage("tools");
    });
    await flushAsyncUpdates();

    const grantTypeSelect = renderer!.root.findAll(
      (node) => node.type === "select" && node.props?.value === "persistent",
    )[0];
    await act(async () => {
      grantTypeSelect!.props.onChange({ target: { value: "ttl" } });
    });

    const expiresAtInput = findInputByPlaceholder(renderer!.root, "2099-01-01T00:00:00.000Z");
    await act(async () => {
      expiresAtInput.props.onChange({ target: { value: "2099-01-01T00:00:00.000Z" } });
    });
    await act(async () => {
      findButton(renderer!.root, "Create grant").props.onClick();
    });
    await flushAsyncUpdates();

    expect(mocks.createToolGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        toolPattern: "browser.search",
        grantType: "ttl",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    );
    expect(collectText(renderer!.root)).toContain("Create a scoped policy grant for the selected tool.");
  });

  it("clears workspace scope refs before creating non-workspace tool grants", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderPage("tools");
    });
    await flushAsyncUpdates();

    const scopeSelect = renderer!.root.findAll(
      (node) => node.type === "select" && node.props?.value === "workspace",
    )[0];
    await act(async () => {
      scopeSelect!.props.onChange({ target: { value: "session" } });
    });
    const scopeRefInput = renderer!.root.findAll(
      (node) =>
        node.type === "input" &&
        node.props.className === "mc-next-settings-input" &&
        !node.props.placeholder &&
        node.props.disabled !== true &&
        node.props.value === "",
    )[0];
    expect(scopeRefInput).toBeDefined();

    await act(async () => {
      findButton(renderer!.root, "Create grant").props.onClick();
    });
    await flushAsyncUpdates();
    expect(mocks.createToolGrant).not.toHaveBeenCalled();
    expect(collectText(renderer!.root)).toContain("Add a session id before creating this tool grant.");

    await act(async () => {
      scopeRefInput!.props.onChange({ target: { value: "session-1" } });
    });
    await act(async () => {
      findButton(renderer!.root, "Create grant").props.onClick();
    });
    await flushAsyncUpdates();

    expect(mocks.createToolGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "session",
        scopeRef: "session-1",
      }),
    );
  });
});

describe("SettingsNativePage providers", () => {
  it("loads provider advice without mutating provider settings", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderPage("providers");
    });
    await flushAsyncUpdates();

    expect(collectText(renderer!.root)).toContain("Provider advice");
    expect(collectText(renderer!.root)).toContain("without changing settings");

    await act(async () => {
      findButton(renderer!.root, "Load advice").props.onClick();
    });
    await flushAsyncUpdates();

    const text = collectText(renderer!.root);
    expect(mocks.fetchLlmProviderAdvice).toHaveBeenCalledWith({
      preference: "runtime_fit",
      taskHint: "general GoatCitadel chat, code, and orchestration routing",
      maxCandidates: 5,
    });
    expect(text).toContain("OpenAI");
    expect(text).toContain("gpt-5.4-mini");
    expect(text).toContain("no provider settings or keys were changed");
  });

  it("renders onboarding, budget, and unknown sections without silently falling through to General", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderPage("onboarding");
    });
    await flushAsyncUpdates();
    let text = collectText(renderer!.root);
    expect(text).toContain("First-run setup");
    expect(text).toContain("First trusted outcome");
    expect(text).toContain("Provider-ready path");
    expect(text).toContain("first-task-pending");
    expect(text).toContain("Ecosystem proof lanes");
    expect(text).toContain("Voice Wake / Talk Mode");
    expect(text).toContain("Provider configured");
    expect(text).toContain("Apply first-run defaults");
    expect(text).toContain("Tool profile");
    expect(text).toContain("Balanced default for normal local work");
    expect(text).toContain("Store a balanced budget preference");
    expect(text).not.toContain("Terminal onboarding");
    expect(text).not.toContain("Mission Control posture");
    const onboardingBudgetSelect = renderer!.root.findAll(
      (node) => node.type === "select" && node.props.className === "mc-next-settings-input",
    )[2];
    expect(onboardingBudgetSelect!.findAllByType("option").map((option) => collectText(option))).toEqual([
      "Saver",
      "Balanced",
      "Power",
    ]);

    await act(async () => {
      findButton(renderer!.root, "Apply defaults").props.onClick();
    });
    expect(mocks.bootstrapOnboarding).toHaveBeenCalledWith({
      defaultToolProfile: "standard",
      toolApprovalMode: "approve_risky",
      budgetMode: "balanced",
      networkAllowlist: ["api.openai.com"],
      auth: {
        allowLoopbackBypass: false,
      },
    });

    await act(async () => {
      findButton(renderer!.root, "Mark complete").props.onClick();
    });
    expect(mocks.completeOnboarding).toHaveBeenCalledWith("operator");

    await act(async () => {
      renderer = renderPage("budget");
    });
    await flushAsyncUpdates();
    text = collectText(renderer!.root);
    expect(text).toContain("Budget mode");
    expect(text).toContain("Cost evidence");
    expect(text).toContain("Store a balanced budget preference");
    expect(text).not.toContain("Mission Control posture");

    const budgetSelect = renderer!.root.findAll(
      (node) => node.type === "select" && node.props.className === "mc-next-settings-input",
    )[0];
    await act(async () => {
      budgetSelect!.props.onChange({ target: { value: "power" } });
    });
    await act(async () => {
      findButton(renderer!.root, "Save budget mode").props.onClick();
    });
    await flushAsyncUpdates();
    expect(mocks.patchSettings).toHaveBeenCalledWith({ budgetMode: "power" });

    await act(async () => {
      renderer = renderPage("not-real");
    });
    text = collectText(renderer!.root);
    expect(text).toContain("Unknown");
    expect(text).toContain("not registered.");
    expect(text).toContain("Unknown settings section");
    expect(text).toContain("Open General");
    expect(text).not.toContain("Mission Control posture");
  });

  it("offers a truthful demo/local path when no provider is configured", async () => {
    mocks.fetchOnboardingState.mockResolvedValueOnce({
      completed: false,
      checklist: [
        { id: "llm", label: "Provider configured", status: "needs_input", detail: "Select an active provider." },
        { id: "runtime", label: "Runtime ready", status: "complete", detail: "Gateway is reachable." },
      ],
      settings: {
        defaultToolProfile: "standard",
        budgetMode: "balanced",
        networkAllowlist: [],
        auth: {
          mode: "none",
          allowLoopbackBypass: true,
          tokenConfigured: false,
          basicConfigured: false,
        },
        llm: {
          activeProviderId: "",
          activeModel: "",
          providers: [],
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
    mocks.fetchDemoState.mockResolvedValueOnce({
      status: "not_started",
      sessions: [],
      tasks: [],
      starterPrompts: [],
      memorySeeds: [],
      nextRoute: "/settings/onboarding",
      notes: [],
    } as any);

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderPage("onboarding");
    });
    await flushAsyncUpdates();

    const text = collectText(renderer!.root);
    expect(text).toContain("provider-missing");
    expect(text).toContain("demo/local");
    expect(text).toContain("No provider or local endpoint is configured");
    expect(text).toContain("does not send work to a cloud provider");
    expect(text).not.toContain("hostile-code sandboxing");
    expect(text).not.toContain("autonomous high-risk");
  });

  it("marks proof complete from evidence and links to the run surface", async () => {
    mocks.fetchAgenticRuns.mockResolvedValueOnce({
      items: [
        {
          taskId: "task-1",
          runId: "run-first-proof",
          title: "First governed task",
          taskStatus: "done",
          status: "completed",
          surface: "cowork",
          parentSessionId: "cowork-session",
          updatedAt: "2026-05-30T00:00:00.000Z",
        },
      ],
    } as any);
    mocks.fetchEvidenceEnvelopes.mockResolvedValueOnce({
      items: [
        {
          envelopeId: "evidence-envelope-1",
          eventKind: "durable_checkpoint",
          runId: "run-first-proof",
          contentHash: "content-hash",
          payloadHash: "payload-hash",
          toolCallHashes: [],
          memoryLineage: [],
          signatureStatus: "unsigned_local",
          metadata: {},
          createdAt: "2026-05-30T00:00:00.000Z",
        },
      ],
    } as any);
    const navigate = vi.fn();
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <SettingsNativePage
          route={{ area: "settings", section: "onboarding", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          navigate={navigate}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });
    await flushAsyncUpdates();

    const text = collectText(renderer!.root);
    expect(text).toContain("proof-complete");
    expect(text).toContain("Evidence envelope evidence");

    await act(async () => {
      findButton(renderer!.root, "Open Run Detail").props.onClick();
    });

    expect(navigate).toHaveBeenCalledWith({ area: "cowork", sessionId: "cowork-session", theme: "ops" });
  });

  it("keeps budget evidence navigation and retry visible when budget settings fail to load", async () => {
    const navigate = vi.fn();
    mocks.fetchSettings.mockRejectedValueOnce(new Error("settings down"));
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <SettingsNativePage
          route={{ area: "settings", section: "budget", theme: "ops" } as any}
          activeWorkspaceId="default"
          activeWorkspaceName="Default"
          navigate={navigate}
          setActiveWorkspaceId={vi.fn()}
        />,
      );
    });
    await flushAsyncUpdates();

    let text = collectText(renderer!.root);
    expect(text).toContain("settings down");
    expect(text).toContain("Budget mode unavailable");
    expect(text).toContain("Cost evidence");
    expect(text).toContain("Open cost telemetry");
    expect(text).toContain("Tune provider routing");

    const actionRows = renderer!.root.findAll(
      (node) => typeof node.props.className === "string" && node.props.className === "mc-next-settings-action-row",
    );
    const costTelemetryRow = actionRows.find((row) => collectText(row).includes("Open cost telemetry"));
    const providerRoutingRow = actionRows.find((row) => collectText(row).includes("Tune provider routing"));
    expect(costTelemetryRow).toBeDefined();
    expect(providerRoutingRow).toBeDefined();

    await act(async () => {
      costTelemetryRow!.findByType("button").props.onClick();
    });
    expect(navigate).toHaveBeenCalledWith({ area: "ops", section: "costs", theme: "ops" });

    await act(async () => {
      providerRoutingRow!.findByType("button").props.onClick();
    });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "providers", theme: "ops" });

    await act(async () => {
      findButton(renderer!.root, "Refresh").props.onClick();
    });
    await flushAsyncUpdates();
    text = collectText(renderer!.root);
    expect(text).toContain("Budget mode");
  });

  it("disables duplicate budget saves while the update is in flight", async () => {
    let resolvePatch: ((value: Record<string, never>) => void) | undefined;
    mocks.patchSettings.mockImplementationOnce(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          resolvePatch = resolve;
        }),
    );
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderPage("budget");
    });
    await flushAsyncUpdates();

    const budgetSelect = renderer!.root.findAll(
      (node) => node.type === "select" && node.props.className === "mc-next-settings-input",
    )[0];
    await act(async () => {
      budgetSelect!.props.onChange({ target: { value: "power" } });
    });

    const save = findButton(renderer!.root, "Save budget mode");
    await act(async () => {
      save.props.onClick();
    });
    expect(mocks.patchSettings).toHaveBeenCalledTimes(1);
    expect(findButton(renderer!.root, "Saving...").props.disabled).toBe(true);

    await act(async () => {
      findButton(renderer!.root, "Saving...").props.onClick();
    });
    expect(mocks.patchSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePatch?.({});
    });
    await flushAsyncUpdates();
  });

  it("keeps prompt-skipping first-run defaults unavailable in Remote Hardened mode", async () => {
    mocks.fetchSettings.mockResolvedValueOnce({
      auth: {
        mode: "token",
        allowLoopbackBypass: false,
        tokenConfigured: true,
        basicConfigured: false,
      },
      llm: {
        activeProviderId: "openai",
        activeModel: "gpt-5.4-mini",
        providers: [],
        providerConfigs: [],
      },
      deploymentProfile: "remote_hardened",
    } as any);
    mocks.fetchOnboardingState.mockResolvedValueOnce({
      completed: false,
      checklist: [
        {
          id: "llm",
          label: "Provider configured",
          status: "complete",
          detail: "Ready.",
        },
      ],
      settings: {
        defaultToolProfile: "danger",
        toolApprovalMode: "bypass",
        budgetMode: "balanced",
        networkAllowlist: ["api.openai.com"],
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          tokenConfigured: true,
          basicConfigured: false,
        },
        llm: {
          activeProviderId: "openai",
          activeModel: "gpt-5.4-mini",
          providers: [],
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
    } as any);
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderPage("onboarding");
    });
    await flushAsyncUpdates();

    const dangerOption = renderer!.root.findAll((node) => node.type === "option" && node.props.value === "danger")[0];
    const bypassOption = renderer!.root.findAll((node) => node.type === "option" && node.props.value === "bypass")[0];
    expect(dangerOption?.props.disabled).toBe(true);
    expect(bypassOption?.props.disabled).toBe(true);
    expect(collectText(renderer!.root)).toContain(
      "Remote Hardened keeps first-run defaults that skip normal prompts unavailable.",
    );

    await act(async () => {
      findButton(renderer!.root, "Apply defaults").props.onClick();
    });
    await flushAsyncUpdates();

    expect(mocks.bootstrapOnboarding).not.toHaveBeenCalled();
    expect(collectText(renderer!.root)).toContain(
      "Remote Hardened keeps first-run defaults that skip normal prompts unavailable.",
    );
  });

  it("renders repeated device access grants without duplicate row keys", async () => {
    mocks.fetchDeviceAccessGrants.mockResolvedValue({
      items: [
        {
          grantId: "grant-android-1",
          requestId: "request-1",
          actorId: "operator",
          deviceLabel: "Android phone",
          deviceType: "mobile",
          platform: "Android",
          grantedBy: "operator",
          createdAt: "2026-05-02T18:00:00.000Z",
          metadata: {},
        },
        {
          grantId: "grant-android-2",
          requestId: "request-2",
          actorId: "operator",
          deviceLabel: "Android phone",
          deviceType: "mobile",
          platform: "Android",
          grantedBy: "operator",
          createdAt: "2026-05-02T18:05:00.000Z",
          metadata: {},
        },
      ],
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let renderer: ReactTestRenderer | null = null;

    try {
      await act(async () => {
        renderer = renderPage("access");
      });

      const text = collectText(renderer!.root);
      expect(text).toContain("Approved devices");
      expect(text).toContain("Desktop/mobile continuity");
      expect(text).toContain("2 active mobile/tablet device grant(s)");
      expect(text).toContain("Android phone");
      expect(
        consoleErrorSpy.mock.calls.filter((call) =>
          call.some((argument) => String(argument).includes("Encountered two children with the same key")),
        ),
      ).toHaveLength(0);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("saves provider upserts through patchSettings", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderPage();
    });

    await act(async () => {
      findButton(renderer!.root, "New provider draft").props.onClick();
    });

    await act(async () => {
      findInputByPlaceholder(renderer!.root, "openai-compatible").props.onChange({
        target: { value: "local-gateway" },
      });
      findInputByPlaceholder(renderer!.root, "OpenAI-compatible").props.onChange({
        target: { value: "Local Gateway" },
      });
      findInputByPlaceholder(renderer!.root, "https://llm.example.test/v1").props.onChange({
        target: { value: "http://127.0.0.1:11434/v1" },
      });
      findInputByPlaceholder(renderer!.root, "gpt-5.4-mini").props.onChange({ target: { value: "llama3.2" } });
      findInputByPlaceholder(renderer!.root, "OPENAI_API_KEY").props.onChange({
        target: { value: "LOCAL_GATEWAY_API_KEY" },
      });
    });

    await act(async () => {
      findButton(renderer!.root, "Save provider").props.onClick();
    });

    expect(mocks.patchSettings).toHaveBeenCalledWith({
      llm: {
        upsertProvider: {
          providerId: "local-gateway",
          label: "Local Gateway",
          baseUrl: "http://127.0.0.1:11434/v1",
          apiStyle: "openai-responses",
          defaultModel: "llama3.2",
          apiKeyEnv: "LOCAL_GATEWAY_API_KEY",
          request: undefined,
        },
      },
    });
  });

  it("can add the ChatGPT OAuth provider from Settings when it is not already configured", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderPage();
    });

    await act(async () => {
      findButton(renderer!.root, "Add provider and continue").props.onClick();
    });

    expect(mocks.patchSettings).toHaveBeenCalledWith({
      llm: {
        upsertProvider: {
          providerId: "openai-codex",
          label: "OpenAI Codex (ChatGPT OAuth)",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          apiStyle: "openai-codex-responses",
          authMode: "codex-oauth",
          defaultModel: "gpt-5.5",
        },
      },
    });
    expect(mocks.reload).toHaveBeenCalled();
    expect(mocks.loadModelsForProvider).toHaveBeenCalledWith("openai-codex", { force: true });
  });

  it("supports forced model probes and secure secret save/delete flows", async () => {
    let renderer: ReactTestRenderer | null = null;
    const previousWindow = globalThis.window;
    const confirmSpy = vi.fn(() => true);
    Object.assign(globalThis, {
      window: {
        confirm: confirmSpy,
      },
    });

    try {
      await act(async () => {
        renderer = renderPage();
      });

      const initialText = collectText(renderer!.root);
      expect(initialText).toContain("Providers & Models");
      expect(initialText).toContain("Provider API style");
      expect(initialText).toContain("Use for modern OpenAI-compatible Responses endpoints");
      expect(initialText).toContain("Configured API");
      expect(initialText).toContain("Execution API");
      expect(initialText).toContain("Matches configured API");
      expect(initialText).toContain("Key on file in OS keychain");
      expect(initialText).toContain("Saved key values do not roundtrip back to the browser");
      expect(initialText).toContain("local .env fallback");
      expect(initialText).toContain("Provider models");
      expect(initialText).toContain("Live verified");

      await act(async () => {
        findButton(renderer!.root, "Refresh models").props.onClick();
      });

      expect(mocks.loadModelsForProvider).toHaveBeenCalledWith("openai", { force: true });

      await act(async () => {
        findInputByPlaceholder(renderer!.root, "Paste a new API key to save").props.onChange({
          target: { value: "sk-test-secret" },
        });
      });

      mocks.saveProviderSecret.mockResolvedValueOnce({
        providerId: "openai",
        hasSecret: true,
        source: "env",
      });
      await act(async () => {
        findButton(renderer!.root, "Save secret").props.onClick();
      });

      expect(mocks.saveProviderSecret).toHaveBeenCalledWith("openai", "sk-test-secret");
      expect(collectText(renderer!.root)).toContain("Provider secret saved. Stored in local .env fallback.");

      await act(async () => {
        findButton(renderer!.root, "Delete secret").props.onClick();
      });

      expect(confirmSpy).toHaveBeenCalled();
      expect(mocks.deleteProviderSecret).toHaveBeenCalledWith("openai");
      expect(collectText(renderer!.root)).toContain("Provider secret removed. No key remains on file.");
    } finally {
      Object.assign(globalThis, { window: previousWindow });
    }
  });

  it("shows configured versus execution API style and cautious model-probe truth", async () => {
    mocks.providerCatalogState = {
      config: {
        activeProviderId: "custom",
        activeModel: "custom-model",
        providers: [],
        providerConfigs: [
          {
            providerId: "custom",
            label: "Custom",
            baseUrl: "https://custom.example/v1",
            apiStyle: "openai-codex-responses",
            defaultModel: "custom-model",
          },
        ],
      },
      providers: [
        {
          providerId: "custom",
          label: "Custom",
          baseUrl: "https://custom.example/v1",
          defaultModel: "custom-model",
          apiStyle: "openai-codex-responses",
          resolvedApiStyle: "openai-chat-completions",
          models: [],
          hasApiKey: false,
          apiKeySource: "none",
          modelProbeState: "not_checked" as const,
        },
      ],
      loading: false,
      error: null,
    };

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderPage();
    });
    const text = collectText(renderer!.root);

    expect(text).toContain("Configured API");
    expect(text).toContain("openai-codex-responses");
    expect(text).toContain("Execution API");
    expect(text).toContain("openai-chat-completions");
    expect(text).toContain("Gateway executes openai-chat-completions");
    expect(text).toContain("Not probed");
    expect(text).toContain("Codex Responses is only executed for the built-in OpenAI Codex OAuth provider");
  });

  it("renders OAuth controls and hides API-key controls for OpenAI Codex", async () => {
    mocks.pollOpenAICodexOAuthDeviceFlow.mockResolvedValue({
      providerId: "openai-codex",
      flowId: "flow-1",
      status: "pending",
      retryAfterMs: 5000,
    } as any);
    mocks.providerCatalogState = {
      config: {
        activeProviderId: "openai-codex",
        activeModel: "openai-codex/gpt-5.5",
        providers: [],
        providerConfigs: [
          {
            providerId: "openai-codex",
            label: "OpenAI Codex (ChatGPT OAuth)",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            apiStyle: "openai-codex-responses",
            authMode: "codex-oauth",
            defaultModel: "gpt-5.5",
          },
        ],
      },
      providers: [
        {
          providerId: "openai-codex",
          label: "OpenAI Codex (ChatGPT OAuth)",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          defaultModel: "gpt-5.5",
          apiStyle: "openai-codex-responses",
          authMode: "codex-oauth",
          oauthStatus: {
            connected: false,
            requiresReauth: false,
          },
          models: ["gpt-5.5", "gpt-5.5-pro"],
          hasApiKey: false,
          apiKeySource: "none",
          modelProbeState: "ready" as const,
          modelProbeCheckedAt: "2026-04-22T10:00:00.000Z",
        },
      ],
      loading: false,
      error: null,
    };

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderPage();
    });

    const text = collectText(renderer!.root);

    expect(mocks.fetchOpenAICodexOAuthStatus).toHaveBeenCalledTimes(1);
    expect(text).toContain("OpenAI Codex (ChatGPT OAuth)");
    expect(text).toContain("openai-codex-responses");
    expect(text).toContain("ChatGPT/Codex plan");
    expect(text).toContain("ChatGPT setup");
    expect(text).toContain("Provider");
    expect(text).toContain("ChatGPT login");
    expect(text).toContain("OpenAI approval");
    expect(text).toContain("OAuth missing");
    expect(text).toContain("Done");
    expect(text).toContain("Start ChatGPT login");
    expect(text).toContain("No API key goes here.");
    expect(text).toContain("ChatGPT login is managed by the setup card above.");
    expect(text).not.toContain("Draft ChatGPT OAuth provider");
    expect(text).not.toContain("Save secret");
    expect(text).not.toContain("Delete secret");
    expect(renderer!.root.findAllByProps({ placeholder: "Paste a new API key to save" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ placeholder: "OPENAI_API_KEY" })).toHaveLength(0);
    expect(
      renderer!.root.findAll((node) => node.type === "button" && collectText(node).includes("Start ChatGPT login")),
    ).toHaveLength(1);

    await act(async () => {
      findButton(renderer!.root, "Start ChatGPT login").props.onClick();
    });

    expect(mocks.startOpenAICodexOAuthDeviceFlow).toHaveBeenCalledTimes(1);
    const pairingText = collectText(renderer!.root);
    expect(pairingText).toContain("ABCD-EFGH");
    expect(pairingText).toContain("Open OpenAI page");
    expect(pairingText).toContain("Use this exact OpenAI code");
    expect(pairingText).toContain("I approved, check now");
    expect(pairingText).toContain("Get a new code");
    expect(
      renderer!.root.findAll((node) => node.type === "button" && collectText(node).includes("Open OpenAI page")),
    ).toHaveLength(1);
    expect(
      renderer!.root.findAll((node) => node.type === "button" && collectText(node).includes("I approved, check now")),
    ).toHaveLength(1);
    expect(
      renderer!.root.findAll((node) => node.type === "button" && collectText(node).includes("Get a new code")),
    ).toHaveLength(1);
  });

  it("renders the browser callback ChatGPT OAuth flow when OpenAI does not return a device code", async () => {
    mocks.pollOpenAICodexOAuthDeviceFlow.mockResolvedValue({
      providerId: "openai-codex",
      flowId: "browser-flow",
      status: "pending",
      retryAfterMs: 5000,
    } as any);
    mocks.startOpenAICodexOAuthDeviceFlow.mockResolvedValue({
      providerId: "openai-codex",
      flowId: "browser-flow",
      verificationUrl:
        "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann",
      expiresAt: "2099-04-24T12:00:00.000Z",
      pollAfterMs: 5000,
    } as any);
    setCodexProviderCatalogState({ hasApiKey: false });

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderPage();
    });

    await act(async () => {
      findButton(renderer!.root, "Start ChatGPT login").props.onClick();
    });

    const text = collectText(renderer!.root);
    expect(text).toContain("OpenAI browser login");
    expect(text).toContain("Awaiting approval");
    expect(text).toContain("Complete the OpenAI browser approval");
    expect(text).toContain("Open OpenAI page");
    expect(text).toContain("I approved, check now");
    expect(text).toContain("Restart login");
    expect(text).not.toContain("Use this exact OpenAI code");
    expect(text).not.toContain("Current code");
  });

  it("surfaces invalid and expired ChatGPT OAuth pairing branches", async () => {
    setCodexProviderCatalogState({ hasApiKey: false });
    mocks.startOpenAICodexOAuthDeviceFlow.mockResolvedValueOnce({
      providerId: "wrong-provider",
      flowId: "bad-flow",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "BAD-CODE",
      expiresAt: "2099-04-24T12:00:00.000Z",
      pollAfterMs: 5000,
    } as any);

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderPage();
    });
    await act(async () => {
      findButton(renderer!.root, "Start ChatGPT login").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("OpenAI Codex OAuth start returned an invalid login flow.");
    renderer!.unmount();

    mocks.pollOpenAICodexOAuthDeviceFlow.mockResolvedValueOnce({
      providerId: "openai-codex",
      flowId: "expired-flow",
      status: "expired",
    } as any);
    const restoreBrowserStorage = installBrowserStorageMock({
      session: {
        [OAUTH_STORAGE_KEY]: JSON.stringify({
          providerId: "openai-codex",
          flowId: "expired-flow",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "EXPD-CODE",
          expiresAt: "2099-04-24T12:00:00.000Z",
          pollAfterMs: 5000,
        }),
      },
    });

    try {
      await act(async () => {
        renderer = renderPage();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(collectText(renderer!.root)).toContain("OpenAI Codex OAuth login expired. Start ChatGPT login again.");
    } finally {
      restoreBrowserStorage();
    }
  });

  it("keeps connected ChatGPT OAuth status from being overwritten by a stale status read", async () => {
    let resolveInitialStatus: (value: unknown) => void = () => undefined;
    const initialStatus = new Promise((resolve) => {
      resolveInitialStatus = resolve;
    });
    mocks.fetchOpenAICodexOAuthStatus
      .mockImplementationOnce(() => initialStatus as any)
      .mockResolvedValue({
        providerId: "openai-codex",
        available: true,
        connected: true,
        accountLabel: "user@example.com",
        requiresReauth: false,
      } as any);
    mocks.pollOpenAICodexOAuthDeviceFlow.mockResolvedValue({
      providerId: "openai-codex",
      flowId: "flow-1",
      status: "connected",
      accountLabel: "user@example.com",
    } as any);
    setCodexProviderCatalogState({ hasApiKey: false });
    const restoreBrowserStorage = installBrowserStorageMock({
      session: {
        [OAUTH_STORAGE_KEY]: JSON.stringify({
          providerId: "openai-codex",
          flowId: "flow-1",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
          expiresAt: "2099-04-24T12:00:00.000Z",
          pollAfterMs: 5000,
        }),
      },
    });

    try {
      let renderer: ReactTestRenderer | null = null;
      await act(async () => {
        renderer = renderPage();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        resolveInitialStatus({
          providerId: "openai-codex",
          available: true,
          connected: false,
          requiresReauth: false,
        });
        await initialStatus;
      });

      const text = collectText(renderer!.root);
      expect(text).toContain("OpenAI Codex OAuth connected.");
      expect(text).toContain("OAuth connected");
      expect(text).toContain("Done. ChatGPT OAuth is connected as user@example.com");
      expect(text).not.toContain("OpenAI approved the login, but GoatCitadel could not confirm");
    } finally {
      restoreBrowserStorage();
    }
  });

  it("does not show a connected success banner when status confirmation stays disconnected", async () => {
    mocks.fetchOpenAICodexOAuthStatus.mockResolvedValue({
      providerId: "openai-codex",
      available: true,
      connected: false,
      requiresReauth: false,
    } as any);
    mocks.pollOpenAICodexOAuthDeviceFlow.mockResolvedValue({
      providerId: "openai-codex",
      flowId: "flow-1",
      status: "connected",
      accountLabel: "user@example.com",
    } as any);
    setCodexProviderCatalogState({ hasApiKey: false });
    const restoreBrowserStorage = installBrowserStorageMock({
      session: {
        [OAUTH_STORAGE_KEY]: JSON.stringify({
          providerId: "openai-codex",
          flowId: "flow-1",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
          expiresAt: "2099-04-24T12:00:00.000Z",
          pollAfterMs: 5000,
        }),
      },
    });

    try {
      let renderer: ReactTestRenderer | null = null;
      await act(async () => {
        renderer = renderPage();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const text = collectText(renderer!.root);
      expect(text).toContain("OpenAI approved the login, but GoatCitadel could not confirm");
      expect(text).toContain("OAuth missing");
      expect(text).not.toContain("OpenAI Codex OAuth connected.");
    } finally {
      restoreBrowserStorage();
    }
  });

  it("restores an in-progress ChatGPT OAuth pairing after a Settings refresh", async () => {
    mocks.pollOpenAICodexOAuthDeviceFlow.mockResolvedValue({
      providerId: "openai-codex",
      flowId: "flow-1",
      status: "pending",
      retryAfterMs: 5000,
    } as any);
    const restoreBrowserStorage = installBrowserStorageMock({
      "goatcitadel:openai-codex:oauth-flow": JSON.stringify({
        providerId: "openai-codex",
        flowId: "flow-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
        expiresAt: "2099-04-24T12:00:00.000Z",
        pollAfterMs: 5000,
      }),
    });
    mocks.providerCatalogState = {
      config: {
        activeProviderId: "openai-codex",
        activeModel: "openai-codex/gpt-5.5",
        providers: [],
        providerConfigs: [
          {
            providerId: "openai-codex",
            label: "OpenAI Codex (ChatGPT OAuth)",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            apiStyle: "openai-codex-responses",
            authMode: "codex-oauth",
            defaultModel: "gpt-5.5",
          },
        ],
      },
      providers: [
        {
          providerId: "openai-codex",
          label: "OpenAI Codex (ChatGPT OAuth)",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          defaultModel: "gpt-5.5",
          apiStyle: "openai-codex-responses",
          authMode: "codex-oauth",
          oauthStatus: {
            connected: false,
            requiresReauth: false,
          },
          models: ["gpt-5.5"],
          hasApiKey: false,
          apiKeySource: "none",
          modelProbeState: "ready" as const,
          modelProbeCheckedAt: "2026-04-22T10:00:00.000Z",
        },
      ],
      loading: false,
      error: null,
    };

    try {
      let renderer: ReactTestRenderer | null = null;
      await act(async () => {
        renderer = renderPage();
      });

      const text = collectText(renderer!.root);
      expect(text).toContain("Use this exact OpenAI code");
      expect(text).toContain("ABCD-EFGH");
      expect(text).toContain("Open OpenAI page");
    } finally {
      restoreBrowserStorage();
    }
  });

  it("prefers a valid session OAuth flow over stale local storage", async () => {
    mocks.pollOpenAICodexOAuthDeviceFlow.mockResolvedValue({
      providerId: "openai-codex",
      flowId: "session-flow",
      status: "pending",
      retryAfterMs: 5000,
    } as any);
    setCodexProviderCatalogState({ models: ["gpt-5.5"] });
    const restoreBrowserStorage = installBrowserStorageMock({
      local: {
        [OAUTH_STORAGE_KEY]: JSON.stringify({
          providerId: "openai-codex",
          flowId: "expired-flow",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "OLD-CODE",
          expiresAt: "2026-04-24T12:00:00.000Z",
          pollAfterMs: 5000,
        }),
      },
      session: {
        [OAUTH_STORAGE_KEY]: JSON.stringify({
          providerId: "openai-codex",
          flowId: "session-flow",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "SESSION-CODE",
          expiresAt: "2099-04-24T12:00:00.000Z",
          pollAfterMs: 5000,
        }),
      },
    });

    try {
      let renderer: ReactTestRenderer | null = null;
      await act(async () => {
        renderer = renderPage();
      });

      const text = collectText(renderer!.root);
      expect(text).toContain("SESSION-CODE");
      expect(text).not.toContain("OLD-CODE");
      expect(globalThis.localStorage.getItem(OAUTH_STORAGE_KEY)).toBeNull();
      expect(globalThis.sessionStorage.getItem(OAUTH_STORAGE_KEY)).toContain("SESSION-CODE");
    } finally {
      restoreBrowserStorage();
    }
  });

  it("rejects invalid stored OAuth expiry and untrusted verification URLs", async () => {
    setCodexProviderCatalogState({ models: ["gpt-5.5"] });
    const restoreBrowserStorage = installBrowserStorageMock({
      session: {
        [OAUTH_STORAGE_KEY]: JSON.stringify({
          providerId: "openai-codex",
          flowId: "bad-flow",
          verificationUrl: "https://evil.example.test/codex/device",
          userCode: "EVIL-CODE",
          expiresAt: "not-a-date",
          pollAfterMs: 5000,
        }),
      },
    });

    try {
      let renderer: ReactTestRenderer | null = null;
      await act(async () => {
        renderer = renderPage();
      });

      const text = collectText(renderer!.root);
      expect(text).toContain("Start ChatGPT login");
      expect(text).not.toContain("EVIL-CODE");
      expect(globalThis.sessionStorage.getItem(OAUTH_STORAGE_KEY)).toBeNull();
    } finally {
      restoreBrowserStorage();
    }
  });

  it("does not overlap automatic OAuth polling and honors retryAfterMs", async () => {
    vi.useFakeTimers();
    setCodexProviderCatalogState({ models: ["gpt-5.5"] });
    let resolveFirstPoll: (value: unknown) => void = () => undefined;
    const firstPoll = new Promise((resolve) => {
      resolveFirstPoll = resolve;
    });
    mocks.pollOpenAICodexOAuthDeviceFlow
      .mockImplementationOnce(() => firstPoll as any)
      .mockResolvedValue({
        providerId: "openai-codex",
        flowId: "flow-1",
        status: "pending",
        retryAfterMs: 7000,
      } as any);
    const restoreBrowserStorage = installBrowserStorageMock({
      session: {
        [OAUTH_STORAGE_KEY]: JSON.stringify({
          providerId: "openai-codex",
          flowId: "flow-1",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
          expiresAt: "2099-04-24T12:00:00.000Z",
          pollAfterMs: 5000,
        }),
      },
    });

    try {
      let renderer: ReactTestRenderer | null = null;
      await act(async () => {
        renderer = renderPage();
      });
      expect(mocks.pollOpenAICodexOAuthDeviceFlow).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(mocks.pollOpenAICodexOAuthDeviceFlow).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveFirstPoll({
          providerId: "openai-codex",
          flowId: "flow-1",
          status: "pending",
          retryAfterMs: 7000,
        });
        await firstPoll;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6999);
      });
      expect(mocks.pollOpenAICodexOAuthDeviceFlow).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(mocks.pollOpenAICodexOAuthDeviceFlow).toHaveBeenCalledTimes(2);
      renderer!.unmount();
    } finally {
      restoreBrowserStorage();
    }
  });

  it("shows and can disconnect an orphan ChatGPT OAuth credential", async () => {
    mocks.fetchOpenAICodexOAuthStatus.mockResolvedValue({
      providerId: "openai-codex",
      available: true,
      connected: true,
      accountLabel: "user@example.com",
      requiresReauth: false,
    } as any);

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderPage();
    });

    const text = collectText(renderer!.root);
    expect(text).toContain("credential exists in secure storage");
    expect(text).toContain("provider is missing");

    await act(async () => {
      findButton(renderer!.root, "Disconnect").props.onClick();
    });
    expect(mocks.deleteOpenAICodexOAuthCredential).toHaveBeenCalledTimes(1);
  });

  it("labels fallback-only Codex model catalogs as suggested and unverified", async () => {
    setCodexProviderCatalogState({
      modelProbeState: "fallback" as const,
      modelProbeSource: "template_fallback" as const,
      models: ["gpt-5.5"],
    });
    mocks.getCachedModelProbe.mockReturnValue({
      items: ["gpt-5.5"],
      expiresAt: Date.now() + 60_000,
      state: "fallback",
      source: "template_fallback",
      checkedAt: "2026-04-22T10:00:00.000Z",
    });

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderPage();
    });

    let text = collectText(renderer!.root);
    expect(text).toContain("Suggested");
    expect(text).toContain("Template suggestions; not account-verified");

    await act(async () => {
      findButton(renderer!.root, "Refresh models").props.onClick();
    });

    text = collectText(renderer!.root);
    expect(text).toContain("not verified against your account");
  });

  it("covers empty provider catalogs, editor guards, and probe failures", async () => {
    mocks.providerCatalogState = {
      config: null,
      providers: [],
      loading: false,
      error: null,
    };
    mocks.patchSettings.mockRejectedValueOnce(new Error("provider save failed"));
    mocks.loadModelsForProvider.mockRejectedValueOnce(new Error("probe failed"));

    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderPage();
    });

    expect(collectText(renderer!.root)).toContain("No providers returned from runtime settings.");
    expect(collectText(renderer!.root)).toContain("Choose a provider to inspect routing and secret posture.");

    await act(async () => {
      findButton(renderer!.root, "Save routing").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("Choose both a provider and a model before saving routing.");

    await act(async () => {
      findButton(renderer!.root, "Probe from editor").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("Choose or save a provider before probing models.");

    await act(async () => {
      findButton(renderer!.root, "Save provider").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("Provide both a provider id and base URL before saving.");

    await act(async () => {
      findButton(renderer!.root, "New provider draft").props.onClick();
    });
    await act(async () => {
      findInputByPlaceholder(renderer!.root, "openai-compatible").props.onChange({ target: { value: "local" } });
      findInputByPlaceholder(renderer!.root, "https://llm.example.test/v1").props.onChange({
        target: { value: "http://127.0.0.1:11434/v1" },
      });
    });
    await act(async () => {
      findButton(renderer!.root, "Save provider").props.onClick();
    });
    await flushAsyncUpdates();
    expect(collectText(renderer!.root)).toContain("provider save failed");

    await act(async () => {
      findButton(renderer!.root, "Probe from editor").props.onClick();
    });
    await flushAsyncUpdates();
    expect(collectText(renderer!.root)).toContain("probe failed");
  });

  it("covers provider secret failure, routing save errors, and delete cancellation", async () => {
    mocks.fetchProviderSecretStatus.mockRejectedValueOnce(new Error("secret status offline"));
    mocks.patchSettings.mockRejectedValueOnce(new Error("routing save failed"));
    mocks.saveProviderSecret.mockRejectedValueOnce(new Error("secret save failed"));
    mocks.deleteProviderSecret.mockRejectedValueOnce(new Error("secret delete failed"));
    mocks.loadModelsForProvider.mockResolvedValueOnce([]);
    mocks.getCachedModelProbe.mockReturnValueOnce({
      items: [],
      state: "fallback",
      source: "error_fallback",
      warning: "401",
    });

    const previousWindow = globalThis.window;
    const confirmSpy = vi.fn(() => false);
    Object.assign(globalThis, {
      window: {
        confirm: confirmSpy,
      },
    });

    try {
      let renderer: ReactTestRenderer | null = null;
      await act(async () => {
        renderer = renderPage();
      });
      await act(async () => undefined);

      expect(collectText(renderer!.root)).toContain("secret status offline");

      await act(async () => {
        findButton(renderer!.root, "Save routing").props.onClick();
      });
      await flushAsyncUpdates();
      expect(collectText(renderer!.root)).toContain("routing save failed");

      await act(async () => {
        findButton(renderer!.root, "Save secret").props.onClick();
      });
      expect(collectText(renderer!.root)).toContain("Enter a provider secret before saving.");

      await act(async () => {
        findInputByPlaceholder(renderer!.root, "Paste a new API key to save").props.onChange({
          target: { value: "sk-error-secret" },
        });
      });
      await act(async () => {
        findButton(renderer!.root, "Save secret").props.onClick();
      });
      await flushAsyncUpdates();
      expect(collectText(renderer!.root)).toContain("secret save failed");

      await act(async () => {
        findButton(renderer!.root, "Refresh models").props.onClick();
      });
      await flushAsyncUpdates();
      expect(collectText(renderer!.root)).toContain("live discovery failed: 401");

      await act(async () => {
        findButton(renderer!.root, "Delete secret").props.onClick();
      });
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(mocks.deleteProviderSecret).not.toHaveBeenCalled();

      confirmSpy.mockReturnValue(true);
      await act(async () => {
        findButton(renderer!.root, "Delete secret").props.onClick();
      });
      await flushAsyncUpdates();
      expect(collectText(renderer!.root)).toContain("secret delete failed");
    } finally {
      Object.assign(globalThis, { window: previousWindow });
    }
  });
});

describe("SettingsNativePage access", () => {
  it("keeps loopback bypass off by default and mirrors the loaded server posture", async () => {
    let renderer: ReactTestRenderer | null = null;

    mockSettingsLoopback(false);
    await act(async () => {
      renderer = renderPage("access");
    });
    expect(findLoopbackCheckbox(renderer!.root).props.checked).toBe(false);
    expect(collectText(renderer!.root)).toContain("trusted single-machine development");
    expect(collectText(renderer!.root)).toContain("Disabled");

    mockSettingsLoopback(true);
    await act(async () => {
      renderer = renderPage("access");
    });
    expect(findLoopbackCheckbox(renderer!.root).props.checked).toBe(true);
    expect(collectText(renderer!.root)).toContain("Enabled");
  });

  it("saves edited access credentials, resolves install tokens, and revokes device grants", async () => {
    mocks.fetchDeviceAccessGrants.mockResolvedValue({
      items: [
        {
          grantId: "grant-active",
          requestId: "request-active",
          actorId: "operator",
          deviceLabel: "Operator tablet",
          deviceType: "tablet",
          platform: "Windows",
          grantedBy: "operator",
          createdAt: "2026-05-02T18:00:00.000Z",
          metadata: { origin: "LAN" },
        },
      ],
    });
    const previousWindow = globalThis.window;
    const confirmSpy = vi.fn(() => true);
    Object.assign(globalThis, {
      window: {
        confirm: confirmSpy,
      },
    });
    let renderer: ReactTestRenderer | null = null;

    try {
      await act(async () => {
        renderer = renderPage("access");
      });
      expect(collectText(renderer!.root)).toContain("Desktop runtime anchor");
      expect(collectText(renderer!.root)).toContain("Operator tablet");

      await act(async () => {
        findFirstSelect(renderer!.root).props.onChange({ target: { value: "basic" } });
        findLoopbackCheckbox(renderer!.root).props.onChange({ target: { checked: false } });
        findInputByPlaceholder(renderer!.root, "Only enter a new token when rotating credentials").props.onChange({
          target: { value: "rotated-token" },
        });
        const optionalInputs = findInputsByPlaceholder(renderer!.root, "Optional");
        optionalInputs[0]!.props.onChange({ target: { value: "goat-admin" } });
        optionalInputs[1]!.props.onChange({ target: { value: "basic-secret" } });
      });

      await act(async () => {
        findButton(renderer!.root, "Save access settings").props.onClick();
      });
      await flushAsyncUpdates();

      expect(mocks.patchSettings).toHaveBeenCalledWith({
        auth: {
          mode: "basic",
          allowLoopbackBypass: false,
          token: "rotated-token",
          basicUsername: "goat-admin",
          basicPassword: "basic-secret",
        },
      });
      expect(collectText(renderer!.root)).toContain("Access posture updated.");

      await act(async () => {
        findButton(renderer!.root, "Generate install token").props.onClick();
      });
      await flushAsyncUpdates();
      expect(mocks.resolveGatewayInstallToken).toHaveBeenCalledWith({
        generateWhenMissing: true,
        persistToEnv: false,
      });
      expect(collectText(renderer!.root)).toContain("install-token-1");

      await act(async () => {
        findButton(renderer!.root, "Revoke").props.onClick();
      });
      await flushAsyncUpdates();
      expect(confirmSpy).toHaveBeenCalledWith("Revoke this device access grant?");
      expect(mocks.revokeDeviceAccessGrant).toHaveBeenCalledWith("grant-active");
      expect(collectText(renderer!.root)).toContain("Device access revoked.");
    } finally {
      Object.assign(globalThis, { window: previousWindow });
    }
  });
});

describe("SettingsNativePage Trust & Policy", () => {
  it("renders the unified trust matrix without replacing owner editors", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderPage("trust-policy");
    });
    await act(async () => undefined);

    let text = collectText(renderer!.root);
    expect(mocks.fetchTrustPolicySnapshot).toHaveBeenCalledTimes(1);
    expect(text).toContain("Trust & Policy snapshot");
    expect(text).toContain("Trust matrix");
    expect(text).toContain("Browser search");
    expect(text).toContain("Dangerous shell");
    expect(text).toContain("Ready");
    expect(text).toContain("Approval required");
    expect(text).toContain("Quarantined");
    expect(text).toContain("Not callable");
    expect(text).toContain("Permissions");
    expect(text).toContain("Tools");
    expect(text).toContain("MCP");
    expect(text).toContain("Skills");
    expect(text).toContain("Capabilities");
    expect(text).toContain("Approvals");

    await act(async () => {
      findInputByPlaceholder(renderer!.root, "Search trust, grants, blockers, or source").props.onChange({
        target: { value: "Dangerous shell" },
      });
    });
    text = collectText(renderer!.root);
    expect(text).toMatch(/Showing\s+1\s+of\s+5/);
    expect(text).toContain("Dangerous shell");
    expect(text).not.toContain("Browser search");
  });

  it("fails closed into warnings and an empty dashboard when the snapshot API is absent", async () => {
    mocks.fetchTrustPolicySnapshot.mockRejectedValueOnce(new Error("snapshot route missing"));
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderPage("trust-policy");
    });
    await act(async () => undefined);

    const text = collectText(renderer!.root);
    expect(text).toContain("Some data could not load");
    expect(text).toContain("snapshot route missing");
    expect(text).toContain("Trust & Policy snapshot is unavailable");
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SettingsNativePage integrations", () => {
  it("renders plugin trust metadata and blocked Google Meet prerequisites", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderPage("integrations");
    });
    await act(async () => undefined);

    const text = collectText(renderer!.root);

    expect(mocks.fetchIntegrationPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.fetchIntegrationFormSchema).toHaveBeenCalledWith("github");
    expect(mocks.fetchGoogleMeetPrerequisiteStatus).toHaveBeenCalledTimes(1);
    expect(text).toContain("GitHub setup");
    expect(text).toContain("Token environment variable");
    expect(text).toContain("Advanced JSON");
    expect(text).toContain("Plugin trust");
    expect(text).toContain("Dashboard Plugin");
    expect(text).toContain("Integrity: verified");
    expect(text).toContain("Theme: compact");
    expect(text).toContain("Google Meet voice");
    expect(text).toContain("OAuth profile");
    expect(text).toContain("Blocked");
  });

  it("creates integration connections from guided schema fields by default", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderPage("integrations");
    });
    await act(async () => undefined);

    const schemaInput = renderer!.root.findAll(
      (node) => node.type === "input" && node.props?.id === "integration-field-tokenEnv",
    )[0];
    expect(schemaInput).toBeDefined();

    await act(async () => {
      schemaInput!.props.onChange({ target: { value: "GH_TOKEN" } });
    });
    await act(async () => {
      findButton(renderer!.root, "Create connection").props.onClick();
    });

    expect(mocks.createIntegrationConnection).toHaveBeenCalledWith({
      catalogId: "github",
      label: undefined,
      enabled: true,
      config: { tokenEnv: "GH_TOKEN" },
    });
  });
});

describe("SettingsNativePage MCP", () => {
  it("keeps generic MCP creation on stdio and disables runtime actions for unsupported URL servers", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderPage("mcp");
    });

    const optionValues = renderer!.root.findAllByType("option").map((option) => option.props.value);
    expect(optionValues).not.toContain("http");
    expect(optionValues).not.toContain("sse");

    const text = collectText(renderer!.root);
    expect(text).toContain("Configured only; runtime actions are disabled.");
    expect(text).toContain("Generic http/sse runtime invocation is not supported");
    expect(text).toContain("Remote MCP preview");
    expect(text).toContain("Generic remote http/sse MCP remains not callable here.");
    expect(text).toContain("Remote HTTP");
    expect(text).toContain("Server mode preview");
    expect(text).toContain("Read-only, closed-world descriptors can re-enter Gateway policy");
    expect(text).toContain("goatcitadel.fs.read");
    expect(findButton(renderer!.root, "Connect").props.disabled).toBe(true);
    expect(findButton(renderer!.root, "Health check").props.disabled).toBe(true);
  });
});
