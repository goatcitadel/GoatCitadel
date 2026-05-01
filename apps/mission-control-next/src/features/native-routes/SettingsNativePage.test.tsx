import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsNativePage } from "./SettingsNativePage";

const mocks = vi.hoisted(() => ({
  patchSettings: vi.fn(async () => ({})),
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
        models: ["gpt-5.4-mini"],
        hasApiKey: true,
        apiKeySource: "keychain",
        modelProbeState: "ready" as const,
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
    saveProviderSecret: mocks.saveProviderSecret,
    deleteProviderSecret: mocks.deleteProviderSecret,
    fetchProviderSecretStatus: mocks.fetchProviderSecretStatus,
    fetchOpenAICodexOAuthStatus: mocks.fetchOpenAICodexOAuthStatus,
    fetchIntegrationCatalog: mocks.fetchIntegrationCatalog,
    fetchIntegrationConnections: mocks.fetchIntegrationConnections,
    fetchIntegrationPlugins: mocks.fetchIntegrationPlugins,
    fetchGoogleMeetPrerequisiteStatus: mocks.fetchGoogleMeetPrerequisiteStatus,
    fetchGoogleMeetSessions: mocks.fetchGoogleMeetSessions,
    startOpenAICodexOAuthDeviceFlow: mocks.startOpenAICodexOAuthDeviceFlow,
    pollOpenAICodexOAuthDeviceFlow: mocks.pollOpenAICodexOAuthDeviceFlow,
    deleteOpenAICodexOAuthCredential: mocks.deleteOpenAICodexOAuthCredential,
  };
});

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

beforeEach(() => {
  vi.clearAllMocks();
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
        models: ["gpt-5.4-mini"],
        hasApiKey: true,
        apiKeySource: "keychain",
        modelProbeState: "ready" as const,
        modelProbeCheckedAt: "2026-04-22T10:00:00.000Z",
      },
    ],
    loading: false,
    error: null,
  };
});

describe("SettingsNativePage providers", () => {
  it("renders onboarding, budget, and unknown sections without silently falling through to General", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderPage("onboarding");
    });
    let text = collectText(renderer!.root);
    expect(text).toContain("First-run setup");
    expect(text).toContain("Terminal onboarding");
    expect(text).not.toContain("Mission Control posture");

    await act(async () => {
      renderer = renderPage("budget");
    });
    text = collectText(renderer!.root);
    expect(text).toContain("Budget controls");
    expect(text).toContain("No silent fallback");
    expect(text).not.toContain("Mission Control posture");

    await act(async () => {
      renderer = renderPage("not-real");
    });
    text = collectText(renderer!.root);
    expect(text).toContain("Unknown");
    expect(text).toContain("not registered in the current shell");
    expect(text).toContain("Unknown settings section");
    expect(text).toContain("Open General");
    expect(text).not.toContain("Mission Control posture");
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

      await act(async () => {
        findButton(renderer!.root, "Refresh models").props.onClick();
      });

      expect(mocks.loadModelsForProvider).toHaveBeenCalledWith("openai", { force: true });

      await act(async () => {
        findInputByPlaceholder(renderer!.root, "Paste a new API key to save").props.onChange({
          target: { value: "sk-test-secret" },
        });
      });

      await act(async () => {
        findButton(renderer!.root, "Save secret").props.onClick();
      });

      expect(mocks.saveProviderSecret).toHaveBeenCalledWith("openai", "sk-test-secret");

      await act(async () => {
        findButton(renderer!.root, "Delete secret").props.onClick();
      });

      expect(confirmSpy).toHaveBeenCalled();
      expect(mocks.deleteProviderSecret).toHaveBeenCalledWith("openai");
    } finally {
      Object.assign(globalThis, { window: previousWindow });
    }
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

    const text = collectText(renderer!.root);

    expect(mocks.fetchIntegrationPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.fetchGoogleMeetPrerequisiteStatus).toHaveBeenCalledTimes(1);
    expect(text).toContain("Plugin trust");
    expect(text).toContain("Dashboard Plugin");
    expect(text).toContain("Integrity: verified");
    expect(text).toContain("Theme: compact");
    expect(text).toContain("Google Meet voice");
    expect(text).toContain("OAuth profile");
    expect(text).toContain("Blocked");
  });
});
