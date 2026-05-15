import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  clearGatewayAuthState: vi.fn(),
  createLlmChatCompletion: vi.fn(),
  deleteOpenAICodexOAuthCredential: vi.fn(),
  deleteProviderSecret: vi.fn(),
  evaluateUiChangeRisk: vi.fn(),
  fetchDeviceAccessGrants: vi.fn(),
  fetchOpenAICodexOAuthStatus: vi.fn(),
  fetchProviderSecretStatus: vi.fn(),
  fetchSettings: vi.fn(),
  getGatewayAuthStorageMode: vi.fn(),
  patchSettings: vi.fn(),
  persistGatewayAuthState: vi.fn(),
  pollOpenAICodexOAuthDeviceFlow: vi.fn(),
  readStoredGatewayAuthState: vi.fn(),
  revokeDeviceAccessGrant: vi.fn(),
  saveProviderSecret: vi.fn(),
  setGatewayAuthStorageMode: vi.fn(),
  startOpenAICodexOAuthDeviceFlow: vi.fn(),
}));

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: { reason: string; eventType?: string; source?: string }) => Promise<void> | void),
}));

const providerCatalogMocks = vi.hoisted(() => ({
  config: {
    activeProviderId: "openai",
    activeModel: "gpt-5.4",
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-responses",
        resolvedApiStyle: "openai-responses",
        defaultModel: "gpt-5.4",
        apiKeySource: "env",
        apiKeyRef: "OPENAI_API_KEY",
      },
    ],
    providerConfigs: [],
  },
  providers: [
    {
      providerId: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiStyle: "openai-responses",
      resolvedApiStyle: "openai-responses",
      defaultModel: "gpt-5.4",
      apiKeySource: "env",
      apiKeyRef: "OPENAI_API_KEY",
      models: ["gpt-5.4"],
    },
  ],
  previewProviderModels: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("../api/client", () => apiMocks);
vi.mock("../hooks/useProviderModelCatalog", () => ({
  dedupeProviderModels: (values: Array<string | undefined | null>) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const normalized = value?.trim();
      if (normalized && !seen.has(normalized)) {
        out.push(normalized);
        seen.add(normalized);
      }
    }
    return out;
  },
  previewProviderModels: providerCatalogMocks.previewProviderModels,
  useProviderModelCatalog: () => ({
    config: providerCatalogMocks.config,
    providers: providerCatalogMocks.providers,
    reload: providerCatalogMocks.reload,
  }),
}));
vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_topic: string, callback: typeof refreshState.callback) => {
    refreshState.callback = callback;
  },
}));
vi.mock("./settings/useSettingsVoiceRuntime", () => ({
  useSettingsVoiceRuntime: () => ({
    voiceStatus: null,
    voiceRuntime: null,
    voiceTalkSessions: [],
    voiceBusy: false,
    voiceTalkMode: "browser",
    setVoiceTalkMode: vi.fn(),
    voiceFile: null,
    setVoiceFile: vi.fn(),
    voiceTranscriptResult: null,
    voiceActionInfo: null,
    voiceRecoveryActions: [],
    voiceOperatorGuidance: [],
    installedVoiceModelIds: [],
    refreshVoiceRuntime: vi.fn(),
    onInstallManagedVoiceRuntime: vi.fn(),
    onSelectManagedVoiceModel: vi.fn(),
    onRemoveManagedVoiceModel: vi.fn(),
    onStartVoiceTalk: vi.fn(),
    onStopVoiceTalk: vi.fn(),
    onStartWake: vi.fn(),
    onStopWake: vi.fn(),
    onRunVoiceTranscribeTest: vi.fn(),
  }),
}));

vi.mock("../components/ChangeReviewPanel", () => ({
  ChangeReviewPanel: (props: {
    overall: string;
    criticalConfirmed?: boolean;
    onCriticalConfirmChange?: (checked: boolean) => void;
  }) => (
    <div>
      ChangeReviewPanel:{props.overall}
      <button type="button" onClick={() => props.onCriticalConfirmChange?.(!props.criticalConfirmed)}>
        Confirm critical
      </button>
    </div>
  ),
}));
vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: () => <div>PageGuideCard</div>,
}));
vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <header>
      {title}
      {children}
    </header>
  ),
}));
vi.mock("./settings/SettingsSectionNav", () => ({
  SettingsSectionNav: (props: { onNavigate: (sectionId: string, behavior?: ScrollBehavior) => void }) => (
    <button type="button" onClick={() => props.onNavigate("settings-runtime", "auto")}>
      Jump runtime
    </button>
  ),
}));
vi.mock("./settings/SettingsOverviewSection", () => ({
  SettingsOverviewSection: (props: { activeProviderId: string; activeModel: string }) => (
    <section>
      Overview:{props.activeProviderId}:{props.activeModel}
    </section>
  ),
}));
vi.mock("./settings/SettingsVoiceSection", () => ({
  SettingsVoiceSection: () => <section>Voice settings</section>,
}));
vi.mock("./settings/SettingsAccessSection", () => ({
  SettingsAccessSection: (props: {
    authMode: string;
    onAuthModeChange: (value: "token" | "none") => void;
    onAuthTokenChange: (value: string) => void;
    onAuthStorageModeChange: (value: "persistent") => void;
    onSaveAuth: () => void;
    deviceGrants: Array<{ grantId: string }>;
    onRevokeDeviceGrant: (grantId: string) => void;
  }) => (
    <section>
      Access:{props.authMode}
      <button type="button" onClick={() => props.onAuthModeChange("token")}>
        Token auth
      </button>
      <button type="button" onClick={() => props.onAuthModeChange("none")}>
        No auth
      </button>
      <button type="button" onClick={() => props.onAuthStorageModeChange("persistent")}>
        Persist auth
      </button>
      <button type="button" onClick={() => props.onAuthTokenChange("secret-token")}>
        Set token
      </button>
      <button type="button" onClick={props.onSaveAuth}>
        Save Access Control
      </button>
      <button type="button" onClick={() => props.onRevokeDeviceGrant(props.deviceGrants[0]?.grantId ?? "grant-1")}>
        Revoke device
      </button>
    </section>
  ),
}));
vi.mock("./settings/SettingsRuntimeSection", () => ({
  SettingsRuntimeSection: (props: {
    deploymentProfile: string;
    onDeploymentProfileChange: (value: "remote_hardened") => void;
    onAllowlistPresetChange: (value: string) => void;
    onNetworkAllowlistTextChange: (value: string) => void;
    onFirecrawlEnabledChange: (value: boolean) => void;
    onSaveRuntime: () => void;
  }) => (
    <section>
      Runtime:{props.deploymentProfile}
      <button type="button" onClick={() => props.onDeploymentProfileChange("remote_hardened")}>
        Harden runtime
      </button>
      <button type="button" onClick={() => props.onAllowlistPresetChange("local")}>
        Local allowlist
      </button>
      <button type="button" onClick={() => props.onNetworkAllowlistTextChange("api.openai.com\nlocalhost")}>
        Custom allowlist
      </button>
      <button type="button" onClick={() => props.onFirecrawlEnabledChange(true)}>
        Enable Firecrawl
      </button>
      <button type="button" onClick={props.onSaveRuntime}>
        Save Runtime Controls
      </button>
    </section>
  ),
}));
vi.mock("./settings/SettingsModelsSection", () => ({
  SettingsModelsSection: (props: {
    applyLocalProviderPreset: (value: "llamacpp") => void;
    activeProviderId: string;
    activeModel: string;
    onActiveProviderIdChange: (value: string) => void;
    onActiveModelChange: (value: string) => void;
    onSaveActiveLlm: () => void;
    onLoadModels: () => void;
    onToggleAdvanced: () => void;
    onProviderIdChange: (value: string) => void;
    onProviderLabelChange: (value: string) => void;
    onProviderBaseUrlChange: (value: string) => void;
    onProviderApiStyleChange: (value: "openai-chat-completions") => void;
    onProviderDefaultModelChange: (value: string) => void;
    onProviderApiKeyChange: (value: string) => void;
    onSaveProviderKeyToSecureStore: () => void;
    onDeleteProviderKeyFromSecureStore: () => void;
    onStartCodexOAuthDeviceFlow: () => void;
    onPollCodexOAuthDeviceFlow: () => void;
    onDisconnectCodexOAuth: () => void;
    onProviderApiKeyEnvChange: (value: string) => void;
    onProviderRequestDraftChange: (value: unknown) => void;
    onSaveProvider: () => void;
  }) => (
    <section>
      Models:{props.activeProviderId}:{props.activeModel}
      <button type="button" onClick={() => props.onActiveProviderIdChange("llamacpp")}>
        Use llama.cpp
      </button>
      <button type="button" onClick={() => props.applyLocalProviderPreset("llamacpp")}>
        Use local preset
      </button>
      <button type="button" onClick={() => props.onActiveModelChange("gemma-4")}>
        Set active model
      </button>
      <button type="button" onClick={props.onSaveActiveLlm}>
        Save Active Provider/Model
      </button>
      <button type="button" onClick={props.onLoadModels}>
        Refresh Models
      </button>
      <button type="button" onClick={props.onToggleAdvanced}>
        Toggle advanced
      </button>
      <button type="button" onClick={() => props.onProviderIdChange("openai-codex")}>
        Use Codex provider
      </button>
      <button type="button" onClick={() => props.onProviderIdChange("openai")}>
        Use current provider
      </button>
      <button type="button" onClick={() => props.onProviderLabelChange("Codex OAuth")}>
        Set provider label
      </button>
      <button type="button" onClick={() => props.onProviderBaseUrlChange("http://127.0.0.1:8080/v1")}>
        Set provider URL
      </button>
      <button type="button" onClick={() => props.onProviderBaseUrlChange("")}>
        Clear provider URL
      </button>
      <button type="button" onClick={() => props.onProviderApiStyleChange("openai-chat-completions")}>
        Set API style
      </button>
      <button type="button" onClick={() => props.onProviderDefaultModelChange("codex-gpt-5")}>
        Set default model
      </button>
      <button type="button" onClick={() => props.onProviderApiKeyChange("provider-secret")}>
        Set provider key
      </button>
      <button type="button" onClick={() => props.onProviderApiKeyChange("")}>
        Clear provider key
      </button>
      <button type="button" onClick={props.onSaveProviderKeyToSecureStore}>
        Save provider key
      </button>
      <button type="button" onClick={props.onDeleteProviderKeyFromSecureStore}>
        Delete provider key
      </button>
      <button type="button" onClick={props.onStartCodexOAuthDeviceFlow}>
        Start OAuth
      </button>
      <button type="button" onClick={props.onPollCodexOAuthDeviceFlow}>
        Poll OAuth
      </button>
      <button type="button" onClick={props.onDisconnectCodexOAuth}>
        Disconnect OAuth
      </button>
      <button type="button" onClick={() => props.onProviderApiKeyEnvChange("CODEX_API_KEY")}>
        Set provider env
      </button>
      <button type="button" onClick={() => props.onProviderRequestDraftChange({ headers: [] })}>
        Set request draft
      </button>
      <button type="button" onClick={() => props.onProviderRequestDraftChange(makeInvalidTransportDraft())}>
        Set invalid request draft
      </button>
      <button type="button" onClick={props.onSaveProvider}>
        Save Provider Settings
      </button>
    </section>
  ),
}));
vi.mock("./settings/SettingsTestsSection", () => ({
  SettingsTestsSection: (props: {
    chatResponse: string;
    onChatPromptChange: (value: string) => void;
    onChatUseMemoryChange: (value: boolean) => void;
    onTestChat: () => void;
  }) => (
    <section>
      Tests:{props.chatResponse}
      <button type="button" onClick={() => props.onChatPromptChange("Ping")}>
        Set prompt
      </button>
      <button type="button" onClick={() => props.onChatUseMemoryChange(true)}>
        Use memory
      </button>
      <button type="button" onClick={props.onTestChat}>
        Run Test Prompt
      </button>
    </section>
  ),
}));

import { SettingsPage } from "./SettingsPage";

function makeProviderCatalog() {
  return [
    {
      providerId: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiStyle: "openai-responses",
      resolvedApiStyle: "openai-responses",
      defaultModel: "gpt-5.4",
      apiKeySource: "env",
      apiKeyRef: "OPENAI_API_KEY",
      models: ["gpt-5.4"],
    },
  ];
}

function makeLlmConfig() {
  return {
    activeProviderId: "openai",
    activeModel: "gpt-5.4",
    providers: makeProviderCatalog(),
    providerConfigs: [],
  };
}

function makeSettings() {
  return {
    environment: "test",
    deploymentProfile: "local_dev",
    defaultToolProfile: "standard",
    budgetMode: "balanced",
    workspaceDir: "F:\\code\\personal-ai",
    writeJailRoots: ["F:\\code\\personal-ai"],
    readOnlyRoots: [],
    readAccessMode: "roots_only",
    networkAllowlist: [],
    approvalExplainer: {
      enabled: false,
      mode: "async",
      minRiskLevel: "danger",
      timeoutMs: 1000,
      maxPayloadChars: 1000,
    },
    memory: {
      enabled: true,
      qmd: {
        enabled: true,
        applyToChat: true,
        applyToOrchestration: true,
        minPromptChars: 20,
        maxContextTokens: 2000,
        cacheTtlSeconds: 30,
      },
    },
    auth: {
      mode: "none",
      allowLoopbackBypass: false,
      tokenConfigured: false,
      basicConfigured: false,
    },
    llm: makeLlmConfig(),
    web: {
      firecrawl: {
        enabled: false,
        baseUrl: "http://127.0.0.1:3002",
        apiKeyEnv: "FIRECRAWL_API_KEY",
        timeoutMs: 20000,
        defaultReadBackend: "native",
        fallbackToNative: true,
      },
    },
  };
}

function makeInvalidTransportDraft() {
  const emptyTls = {
    insecureSkipVerify: false,
    caCertPath: "",
    clientCertPath: "",
    clientKeyPath: "",
    serverName: "",
  };
  return {
    headersJson: "{",
    auth: {
      mode: "none",
      headerName: "",
      queryParam: "",
      token: "",
      tokenEnv: "",
      value: "",
      valueEnv: "",
      scheme: "",
      prefix: false,
    },
    proxyUrl: "",
    proxyBypassHostsText: "",
    proxyAuth: {
      mode: "none",
      headerName: "",
      token: "",
      tokenEnv: "",
      value: "",
      valueEnv: "",
      scheme: "",
    },
    tls: emptyTls,
    proxyTls: emptyTls,
  };
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((node) => node.props.children === label);
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("SettingsPage behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
      cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
      setTimeout,
      clearTimeout,
    });
    apiMocks.fetchSettings.mockResolvedValue(makeSettings());
    apiMocks.patchSettings.mockImplementation(async (patch: Record<string, unknown>) => ({
      ...makeSettings(),
      ...patch,
      llm: { ...makeSettings().llm, ...(patch.llm as object | undefined) },
      auth: { ...makeSettings().auth, ...(patch.auth as object | undefined) },
      web: { ...makeSettings().web, ...(patch.web as object | undefined) },
    }));
    apiMocks.evaluateUiChangeRisk.mockResolvedValue({ overall: "safe", items: [] });
    apiMocks.fetchDeviceAccessGrants.mockResolvedValue({
      items: [
        {
          grantId: "grant-1",
          deviceLabel: "Phone",
          deviceType: "mobile",
          actorId: "operator",
          grantedBy: "operator",
          createdAt: "2026-05-14T00:00:00.000Z",
        },
      ],
    });
    apiMocks.revokeDeviceAccessGrant.mockResolvedValue({
      grant: { grantId: "grant-1", revokedAt: "2026-05-14T00:00:00.000Z" },
    });
    apiMocks.fetchProviderSecretStatus.mockResolvedValue({ providerId: "openai", configured: false });
    apiMocks.fetchOpenAICodexOAuthStatus.mockResolvedValue({
      providerId: "openai-codex",
      available: true,
      connected: false,
      requiresReauth: false,
    });
    apiMocks.getGatewayAuthStorageMode.mockReturnValue("session");
    apiMocks.readStoredGatewayAuthState.mockReturnValue(null);
    apiMocks.createLlmChatCompletion.mockResolvedValue({
      choices: [{ message: { content: "pong" } }],
    });
    apiMocks.saveProviderSecret.mockResolvedValue({ providerId: "openai", configured: true });
    apiMocks.deleteProviderSecret.mockResolvedValue({ providerId: "openai", configured: false });
    apiMocks.startOpenAICodexOAuthDeviceFlow.mockResolvedValue({
      providerId: "openai-codex",
      deviceCode: "device",
      userCode: "USER-CODE",
      verificationUri: "https://example.test",
      expiresAt: "2026-05-14T01:00:00.000Z",
      intervalSeconds: 5,
    });
    apiMocks.pollOpenAICodexOAuthDeviceFlow.mockResolvedValue({
      status: "authorized",
      oauth: { providerId: "openai-codex", available: true, connected: true, requiresReauth: false },
    });
    apiMocks.deleteOpenAICodexOAuthCredential.mockResolvedValue({
      providerId: "openai-codex",
      available: true,
      connected: false,
      requiresReauth: false,
    });
    providerCatalogMocks.previewProviderModels.mockResolvedValue({ items: ["gemma-4"], source: "fallback" });
    providerCatalogMocks.reload.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a loading state before settings arrive", async () => {
    apiMocks.fetchSettings.mockReturnValue(new Promise(() => undefined));
    const renderer = create(<SettingsPage />);

    expect(JSON.stringify(renderer.toJSON())).toContain("Loading Forge settings");

    renderer.unmount();
  });

  it("saves runtime, auth, provider, and test-chat changes from visible sections", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SettingsPage />);
      });
      await flush();

      await act(async () => {
        button(renderer, "Harden runtime")?.props.onClick();
        button(renderer, "Custom allowlist")?.props.onClick();
        button(renderer, "Enable Firecrawl")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Save Runtime Controls")?.props.onClick();
      });

      expect(apiMocks.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentProfile: "remote_hardened",
          networkAllowlist: ["api.openai.com", "localhost"],
          web: expect.objectContaining({
            firecrawl: expect.objectContaining({ enabled: true }),
          }),
        }),
      );

      await act(async () => {
        button(renderer, "Token auth")?.props.onClick();
        button(renderer, "Persist auth")?.props.onClick();
        button(renderer, "Set token")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Save Access Control")?.props.onClick();
      });

      expect(apiMocks.persistGatewayAuthState).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "token", token: "secret-token" }),
        "persistent",
      );

      await act(async () => {
        button(renderer, "Use llama.cpp")?.props.onClick();
        button(renderer, "Set active model")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Save Active Provider/Model")?.props.onClick();
      });

      expect(apiMocks.patchSettings).toHaveBeenCalledWith({
        llm: expect.objectContaining({ activeProviderId: "llamacpp", activeModel: "gemma-4" }),
      });

      await act(async () => {
        button(renderer, "Set provider URL")?.props.onClick();
        button(renderer, "Set provider key")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Save provider key")?.props.onClick();
        button(renderer, "Save Provider Settings")?.props.onClick();
      });

      expect(apiMocks.saveProviderSecret).toHaveBeenCalledWith("llamacpp", "provider-secret");
      expect(apiMocks.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          llm: expect.objectContaining({
            upsertProvider: expect.objectContaining({ providerId: "llamacpp" }),
          }),
        }),
      );

      await act(async () => {
        button(renderer, "Set prompt")?.props.onClick();
        button(renderer, "Use memory")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Run Test Prompt")?.props.onClick();
      });
      await flush();

      expect(apiMocks.createLlmChatCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: "user", content: "Ping" }],
          memory: { mode: "qmd", enabled: true },
        }),
      );
      expect(JSON.stringify(renderer.toJSON())).toContain("pong");
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces fetch and action errors while keeping operator navigation callable", async () => {
    const scrollIntoView = vi.fn();
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => ({ scrollIntoView })),
    });
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SettingsPage focusSectionId="settings-runtime" />);
      });
      await flush();

      expect(scrollIntoView).toHaveBeenCalled();

      apiMocks.revokeDeviceAccessGrant.mockRejectedValueOnce(new Error("revoke failed"));

      await act(async () => {
        button(renderer, "Revoke device")?.props.onClick();
      });
      await flush();

      expect(JSON.stringify(renderer.toJSON())).toContain("revoke failed");
    } finally {
      vi.restoreAllMocks();
      renderer.unmount();
    }
  });

  it("loads provider models and runs Codex OAuth plus credential maintenance flows", async () => {
    apiMocks.startOpenAICodexOAuthDeviceFlow.mockResolvedValueOnce({
      providerId: "openai-codex",
      flowId: "flow-1",
      deviceCode: "device",
      userCode: "USER-CODE",
      verificationUrl: "https://chatgpt.com/activate",
      expiresAt: "2026-05-14T01:00:00.000Z",
      intervalSeconds: 5,
    });
    apiMocks.pollOpenAICodexOAuthDeviceFlow.mockResolvedValueOnce({
      status: "connected",
      oauth: { providerId: "openai-codex", available: true, connected: true, requiresReauth: false },
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SettingsPage activeTab="providers" />);
      });
      await flush();

      await act(async () => {
        button(renderer, "Refresh Models")?.props.onClick();
      });
      await flush();

      expect(providerCatalogMocks.previewProviderModels).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "openai",
          baseUrl: "https://api.openai.com/v1",
          fallbackModel: "gpt-5.4",
        }),
        expect.objectContaining({ signal: undefined }),
      );

      await act(async () => {
        button(renderer, "Use Codex provider")?.props.onClick();
        button(renderer, "Set provider label")?.props.onClick();
        button(renderer, "Set API style")?.props.onClick();
        button(renderer, "Set default model")?.props.onClick();
        button(renderer, "Set provider env")?.props.onClick();
        button(renderer, "Set request draft")?.props.onClick();
      });
      await flush();

      await act(async () => {
        button(renderer, "Start OAuth")?.props.onClick();
      });
      await flush();
      await act(async () => {
        button(renderer, "Poll OAuth")?.props.onClick();
      });
      await flush();
      await act(async () => {
        button(renderer, "Disconnect OAuth")?.props.onClick();
        button(renderer, "Delete provider key")?.props.onClick();
      });
      await flush();

      expect(apiMocks.startOpenAICodexOAuthDeviceFlow).toHaveBeenCalledTimes(1);
      expect(apiMocks.pollOpenAICodexOAuthDeviceFlow).toHaveBeenCalledWith("flow-1");
      expect(apiMocks.deleteOpenAICodexOAuthCredential).toHaveBeenCalledTimes(1);
      expect(apiMocks.deleteProviderSecret).toHaveBeenCalledWith("openai-codex");
      expect(providerCatalogMocks.reload).toHaveBeenCalled();
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces provider model load failures as visible settings errors", async () => {
    providerCatalogMocks.previewProviderModels.mockRejectedValueOnce(new Error("model endpoint unavailable"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SettingsPage activeTab="providers" />);
      });
      await flush();

      await act(async () => {
        button(renderer, "Refresh Models")?.props.onClick();
      });
      await flush();

      expect(JSON.stringify(renderer.toJSON())).toContain("model endpoint unavailable");
    } finally {
      renderer.unmount();
    }
  });

  it("blocks critical settings saves until the operator confirms and applies local provider presets", async () => {
    apiMocks.evaluateUiChangeRisk.mockResolvedValue({
      overall: "critical",
      items: [{ field: "deploymentProfile", level: "critical", hint: "Remote exposure requires review." }],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SettingsPage />);
      });
      await flush();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 450));
      });
      await flush();

      await act(async () => {
        button(renderer, "Harden runtime")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Save Runtime Controls")?.props.onClick();
      });
      await flush();

      expect(apiMocks.patchSettings).not.toHaveBeenCalled();
      expect(JSON.stringify(renderer.toJSON())).toContain("Confirm critical changes before saving.");

      await act(async () => {
        button(renderer, "Confirm critical")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Save Runtime Controls")?.props.onClick();
      });
      await flush();

      expect(apiMocks.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentProfile: "remote_hardened",
        }),
      );

      await act(async () => {
        button(renderer, "Use local preset")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Save Active Provider/Model")?.props.onClick();
      });
      await flush();

      expect(apiMocks.patchSettings).toHaveBeenCalledWith({
        llm: expect.objectContaining({
          activeProviderId: "llamacpp",
        }),
      });
    } finally {
      renderer.unmount();
    }
  });

  it("clears stored credentials for no-auth mode and updates revoked device grants", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SettingsPage activeTab="access" />);
      });
      await flush();

      await act(async () => {
        button(renderer, "Revoke device")?.props.onClick();
      });
      await flush();
      expect(apiMocks.revokeDeviceAccessGrant).toHaveBeenCalledWith("grant-1");

      await act(async () => {
        button(renderer, "Persist auth")?.props.onClick();
        button(renderer, "No auth")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Save Access Control")?.props.onClick();
      });
      await flush();

      expect(apiMocks.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: expect.objectContaining({ mode: "none" }),
        }),
      );
      expect(apiMocks.clearGatewayAuthState).toHaveBeenCalledTimes(1);
      expect(apiMocks.setGatewayAuthStorageMode).toHaveBeenCalledWith("session");
      expect(apiMocks.persistGatewayAuthState).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces risk-review fallback and provider validation errors", async () => {
    vi.useFakeTimers();
    try {
      window.setTimeout = globalThis.setTimeout as typeof setTimeout;
      window.clearTimeout = globalThis.clearTimeout as typeof clearTimeout;
      apiMocks.evaluateUiChangeRisk.mockRejectedValueOnce(new Error("risk offline"));

      let renderer = create(<div />);
      try {
        await act(async () => {
          renderer = create(<SettingsPage activeTab="providers" />);
        });
        await flush();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });
        await flush();
        const riskText = JSON.stringify(renderer.toJSON());
        expect(riskText).toContain("ChangeReviewPanel");
        expect(riskText).toContain("warning");

        await act(async () => {
          button(renderer, "Clear provider URL")?.props.onClick();
        });
        await act(async () => {
          button(renderer, "Refresh Models")?.props.onClick();
        });
        await flush();
        expect(providerCatalogMocks.previewProviderModels).not.toHaveBeenCalled();

        await act(async () => {
          button(renderer, "Clear provider key")?.props.onClick();
        });
        await act(async () => {
          button(renderer, "Save provider key")?.props.onClick();
        });
        await flush();
        expect(JSON.stringify(renderer.toJSON())).toContain("Enter a provider API key first.");

        await act(async () => {
          button(renderer, "Set invalid request draft")?.props.onClick();
        });
        await act(async () => {
          button(renderer, "Save Provider Settings")?.props.onClick();
        });
        await flush();
        expect(JSON.stringify(renderer.toJSON())).toContain("Custom headers must be valid JSON.");
      } finally {
        renderer.unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles Codex OAuth missing-flow, failed, expired, and thrown errors", async () => {
    apiMocks.startOpenAICodexOAuthDeviceFlow
      .mockRejectedValueOnce(new Error("oauth start failed"))
      .mockResolvedValueOnce({
        providerId: "openai-codex",
        flowId: "flow-2",
        deviceCode: "device-2",
        userCode: "USER-CODE-2",
        verificationUrl: "https://chatgpt.com/activate",
        expiresAt: "2026-05-14T01:00:00.000Z",
        intervalSeconds: 5,
      });
    apiMocks.pollOpenAICodexOAuthDeviceFlow
      .mockResolvedValueOnce({ status: "failed", error: "operator denied" })
      .mockResolvedValueOnce({ status: "expired" });
    apiMocks.deleteOpenAICodexOAuthCredential.mockRejectedValueOnce(new Error("disconnect failed"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SettingsPage activeTab="providers" />);
      });
      await flush();

      await act(async () => {
        button(renderer, "Use Codex provider")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Poll OAuth")?.props.onClick();
      });
      await flush();
      expect(JSON.stringify(renderer.toJSON())).toContain("Start OpenAI Codex device pairing first.");

      await act(async () => {
        button(renderer, "Start OAuth")?.props.onClick();
      });
      await flush();
      expect(JSON.stringify(renderer.toJSON())).toContain("oauth start failed");

      await act(async () => {
        button(renderer, "Start OAuth")?.props.onClick();
      });
      await flush();
      await act(async () => {
        button(renderer, "Poll OAuth")?.props.onClick();
      });
      await flush();
      expect(JSON.stringify(renderer.toJSON())).toContain("operator denied");

      await act(async () => {
        button(renderer, "Poll OAuth")?.props.onClick();
      });
      await flush();
      expect(JSON.stringify(renderer.toJSON())).toContain(
        "OpenAI Codex OAuth pairing expired. Start a new device pairing flow.",
      );

      await act(async () => {
        button(renderer, "Disconnect OAuth")?.props.onClick();
      });
      await flush();
      expect(JSON.stringify(renderer.toJSON())).toContain("disconnect failed");
    } finally {
      renderer.unmount();
    }
  });

  it("renders non-chat-completion test responses as JSON and reports test failures", async () => {
    apiMocks.createLlmChatCompletion
      .mockResolvedValueOnce({ choices: [{ message: { content: null } }], usage: { totalTokens: 3 } })
      .mockRejectedValueOnce(new Error("chat test failed"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SettingsPage activeTab="providers" />);
      });
      await flush();

      await act(async () => {
        button(renderer, "Run Test Prompt")?.props.onClick();
      });
      await flush();
      expect(JSON.stringify(renderer.toJSON())).toContain("totalTokens");

      await act(async () => {
        button(renderer, "Run Test Prompt")?.props.onClick();
      });
      await flush();
      expect(JSON.stringify(renderer.toJSON())).toContain("chat test failed");
    } finally {
      renderer.unmount();
    }
  });

  it("refreshes settings only for relevant system signals and reports runtime save failures", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SettingsPage activeTab="runtime" />);
      });
      await flush();

      const callsAfterInitialLoad = apiMocks.fetchSettings.mock.calls.length;
      await act(async () => {
        await refreshState.callback?.({ reason: "chat_message_created", eventType: "chat", source: "chat" });
      });
      await flush();
      expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(callsAfterInitialLoad);

      await act(async () => {
        await refreshState.callback?.({ reason: "settings saved", eventType: "settings", source: "system" });
      });
      await flush();
      expect(apiMocks.fetchSettings.mock.calls.length).toBeGreaterThan(callsAfterInitialLoad);

      apiMocks.patchSettings.mockRejectedValueOnce(new Error("runtime save failed"));
      await act(async () => {
        button(renderer, "Harden runtime")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Save Runtime Controls")?.props.onClick();
      });
      await flush();

      expect(JSON.stringify(renderer.toJSON())).toContain("runtime save failed");
    } finally {
      renderer.unmount();
    }
  });

  it("applies runtime presets and surfaces active-model and provider save failures", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SettingsPage activeTab="runtime" />);
      });
      await flush();

      await act(async () => {
        button(renderer, "Local allowlist")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Save Runtime Controls")?.props.onClick();
      });
      await flush();

      expect(apiMocks.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          networkAllowlist: ["127.0.0.1", "localhost"],
        }),
      );
    } finally {
      renderer.unmount();
    }

    apiMocks.patchSettings
      .mockRejectedValueOnce(new Error("active model save failed"))
      .mockRejectedValueOnce(new Error("provider save failed"));

    renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SettingsPage activeTab="providers" />);
      });
      await flush();

      await act(async () => {
        button(renderer, "Toggle advanced")?.props.onClick();
        button(renderer, "Set active model")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Save Active Provider/Model")?.props.onClick();
      });
      await flush();

      expect(JSON.stringify(renderer.toJSON())).toContain("active model save failed");

      await act(async () => {
        button(renderer, "Set provider URL")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Save Provider Settings")?.props.onClick();
      });
      await flush();

      expect(JSON.stringify(renderer.toJSON())).toContain("provider save failed");
    } finally {
      renderer.unmount();
    }
  });

  it("blocks critical provider and active-model saves while surfacing credential maintenance failures", async () => {
    vi.useFakeTimers();
    try {
      window.setTimeout = globalThis.setTimeout as typeof setTimeout;
      window.clearTimeout = globalThis.clearTimeout as typeof clearTimeout;
      apiMocks.evaluateUiChangeRisk.mockResolvedValue({
        overall: "critical",
        items: [{ field: "llm", level: "critical", hint: "Provider change requires review." }],
      });
      apiMocks.saveProviderSecret.mockRejectedValueOnce(new Error("secure store unavailable"));
      apiMocks.deleteProviderSecret.mockRejectedValueOnce(new Error("secure delete failed"));

      let renderer = create(<div />);
      try {
        await act(async () => {
          renderer = create(<SettingsPage />);
        });
        await flush();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(450);
        });
        await flush();

        await act(async () => {
          button(renderer, "Set active model")?.props.onClick();
        });
        await act(async () => {
          button(renderer, "Save Active Provider/Model")?.props.onClick();
        });
        await flush();
        expect(apiMocks.patchSettings).not.toHaveBeenCalled();
        expect(JSON.stringify(renderer.toJSON())).toContain("Confirm critical changes before saving.");

        await act(async () => {
          button(renderer, "Save Provider Settings")?.props.onClick();
        });
        await flush();
        expect(apiMocks.patchSettings).not.toHaveBeenCalled();

        await act(async () => {
          button(renderer, "Confirm critical")?.props.onClick();
          button(renderer, "Use current provider")?.props.onClick();
          button(renderer, "Set provider key")?.props.onClick();
        });
        await act(async () => {
          button(renderer, "Save provider key")?.props.onClick();
        });
        await flush();
        expect(JSON.stringify(renderer.toJSON())).toContain("secure store unavailable");

        await act(async () => {
          button(renderer, "Delete provider key")?.props.onClick();
        });
        await flush();
        expect(JSON.stringify(renderer.toJSON())).toContain("secure delete failed");
      } finally {
        renderer.unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps provider model discovery local when validation fails before preview", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<SettingsPage activeTab="providers" />);
      });
      await flush();
      providerCatalogMocks.previewProviderModels.mockClear();

      await act(async () => {
        button(renderer, "Set invalid request draft")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Refresh Models")?.props.onClick();
      });
      await flush();

      expect(providerCatalogMocks.previewProviderModels).not.toHaveBeenCalled();
      const treeText = JSON.stringify(renderer.toJSON());
      expect(treeText).toContain("Models:");
      expect(treeText).toContain("openai");
      expect(treeText).toContain("gpt-5.4");
    } finally {
      renderer.unmount();
    }
  });
});
