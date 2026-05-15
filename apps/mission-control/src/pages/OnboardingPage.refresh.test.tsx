import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as
    | null
    | ((signal: { reason?: string; eventType?: string; source?: string; timestamp: number }) => Promise<void> | void),
  options: null as null | Record<string, unknown>,
}));

const apiMocks = vi.hoisted(() => ({
  bootstrapOnboarding: vi.fn(),
  evaluateUiChangeRisk: vi.fn(),
  fetchDaemonStatus: vi.fn(),
  fetchOnboardingState: vi.fn(),
  resolveGatewayInstallToken: vi.fn(),
  restartDaemon: vi.fn(),
  startDaemon: vi.fn(),
}));

const providerCatalogMocks = vi.hoisted(() => ({
  previewProviderModels: vi.fn(),
  reloadProviderCatalog: vi.fn(),
}));

vi.mock("../api/client", () => ({
  bootstrapOnboarding: apiMocks.bootstrapOnboarding,
  evaluateUiChangeRisk: apiMocks.evaluateUiChangeRisk,
  fetchDaemonStatus: apiMocks.fetchDaemonStatus,
  fetchOnboardingState: apiMocks.fetchOnboardingState,
  resolveGatewayInstallToken: apiMocks.resolveGatewayInstallToken,
  restartDaemon: apiMocks.restartDaemon,
  startDaemon: apiMocks.startDaemon,
}));

vi.mock("../hooks/useProviderModelCatalog", () => ({
  previewProviderModels: providerCatalogMocks.previewProviderModels,
  useProviderModelCatalog: () => ({
    config: null,
    providers: [
      {
        providerId: "llamacpp",
        label: "llama.cpp",
        baseUrl: "http://127.0.0.1:8080/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "gemma-4-local",
      },
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-responses",
        defaultModel: "gpt-5.4",
      },
    ],
    reload: providerCatalogMocks.reloadProviderCatalog,
  }),
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (
    _topic: string,
    callback: (signal: {
      reason?: string;
      eventType?: string;
      source?: string;
      timestamp: number;
    }) => Promise<void> | void,
    options?: Record<string, unknown>,
  ) => {
    refreshState.callback = callback;
    refreshState.options = options ?? null;
  },
}));

vi.mock("../components/ChangeReviewPanel", () => ({
  ChangeReviewPanel: (props: {
    overall?: string;
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

vi.mock("../components/HelpHint", () => ({
  HelpHint: () => <span>HelpHint</span>,
}));

vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: () => <div>PageGuideCard</div>,
}));

vi.mock("../components/SelectOrCustom", () => ({
  SelectOrCustom: (props: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => {
    const seen = new Set<string>();
    const options = props.options.filter((option) => {
      if (seen.has(option.value)) {
        return false;
      }
      seen.add(option.value);
      return true;
    });
    return (
      <select id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  },
}));

import { isAbortError, OnboardingPage } from "./OnboardingPage";

function makeProvider(input: {
  providerId: string;
  label: string;
  baseUrl: string;
  apiStyle: "openai-chat-completions" | "openai-responses" | "openai-codex-responses";
  defaultModel: string;
}) {
  return {
    providerId: input.providerId,
    label: input.label,
    baseUrl: input.baseUrl,
    apiStyle: input.apiStyle,
    defaultModel: input.defaultModel,
  };
}

function makeOnboardingState(
  overrides: {
    activeProviderId?: string;
    activeModel?: string;
    providers?: Array<ReturnType<typeof makeProvider>>;
  } = {},
) {
  const providers = overrides.providers ?? [
    makeProvider({
      providerId: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiStyle: "openai-responses",
      defaultModel: "gpt-5.4",
    }),
  ];
  return {
    completed: false,
    completedAt: undefined,
    completedBy: undefined,
    checklist: [
      {
        id: "auth",
        label: "Gateway access",
        status: "pending",
        detail: "Configure gateway access.",
      },
    ],
    settings: {
      auth: {
        mode: "none",
        allowLoopbackBypass: false,
      },
      defaultToolProfile: "minimal",
      budgetMode: "balanced",
      networkAllowlist: ["127.0.0.1", "localhost"],
      llm: {
        activeProviderId: overrides.activeProviderId ?? providers[0]?.providerId ?? "openai",
        activeModel: overrides.activeModel ?? providers[0]?.defaultModel ?? "gpt-5.4",
        providers,
      },
      mesh: {
        enabled: false,
        mode: "lan",
        nodeId: "",
        mdns: true,
        staticPeers: [] as string[],
        requireMtls: true,
        tailnetEnabled: false,
      },
    },
  };
}

function makeDaemonStatus() {
  return {
    running: true,
    controllable: true,
    state: "running",
    host: "127.0.0.1",
    pid: 8787,
    uptimeSeconds: 12,
    controlMessage: "",
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => button.props.children === label);
}

function nodeText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeText(child)).join(" ");
  }
  if (node && typeof node === "object" && "props" in node) {
    return nodeText((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function findButtonContaining(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => nodeText(button.props.children).includes(label));
}

describe("OnboardingPage refresh discipline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    refreshState.options = null;
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    apiMocks.fetchOnboardingState.mockResolvedValue(makeOnboardingState());
    apiMocks.fetchDaemonStatus.mockResolvedValue(makeDaemonStatus());
    apiMocks.evaluateUiChangeRisk.mockResolvedValue({
      overall: "safe",
      items: [],
    });
    providerCatalogMocks.previewProviderModels.mockResolvedValue({
      items: ["gpt-5.4"],
      source: "live",
      warning: undefined,
    });
  });

  it("does not enable fallback polling while the onboarding wizard is open", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage />);
      });
      await flush();

      expect(refreshState.options).toMatchObject({
        enabled: true,
        coalesceMs: 900,
      });
      expect(refreshState.options?.staleMs).toBeUndefined();
      expect(refreshState.options?.pollIntervalMs).toBeUndefined();
    } finally {
      renderer.unmount();
    }
  });

  it("preserves in-progress onboarding edits during a background refresh signal", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage />);
      });
      await flush();

      const authMode = renderer.root.findByProps({ id: "wizard-auth-mode" });
      await act(async () => {
        authMode.props.onChange({ target: { value: "token" } });
      });
      await flush();

      const tokenInput = renderer.root.findByProps({ id: "wizard-token" });
      await act(async () => {
        tokenInput.props.onChange({ target: { value: "draft-token" } });
      });

      expect(apiMocks.fetchOnboardingState).toHaveBeenCalledTimes(1);
      expect(refreshState.callback).toBeTypeOf("function");

      await act(async () => {
        await refreshState.callback?.({
          topic: "system",
          timestamp: Date.now(),
          reason: "settings-updated",
          source: "test",
        } as never);
      });
      await flush();

      expect(apiMocks.fetchOnboardingState).toHaveBeenCalledTimes(2);
      expect(renderer.root.findByProps({ id: "wizard-auth-mode" }).props.value).toBe("token");
      expect(renderer.root.findByProps({ id: "wizard-token" }).props.value).toBe("draft-token");
    } finally {
      renderer.unmount();
    }
  });

  it("preserves provider selection when a refresh lands right after the operator switches providers", async () => {
    const runtimeState = makeOnboardingState({
      activeProviderId: "llamacpp",
      activeModel: "gemma-4-local",
      providers: [
        makeProvider({
          providerId: "llamacpp",
          label: "llama.cpp",
          baseUrl: "http://127.0.0.1:8080/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gemma-4-local",
        }),
        makeProvider({
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4",
        }),
      ],
    });
    apiMocks.fetchOnboardingState.mockResolvedValue(runtimeState);
    providerCatalogMocks.previewProviderModels.mockResolvedValue({
      items: ["gpt-5.4"],
      source: "live",
      warning: undefined,
    });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage />);
      });
      await flush();

      const nextButton = renderer.root.findAllByType("button").find((node) => node.props.children === "Next");
      expect(nextButton).toBeDefined();
      await act(async () => {
        nextButton?.props.onClick();
      });

      const providerSelect = renderer.root.findByProps({ id: "wizard-provider-id" });
      expect(providerSelect.props.value).toBe("llamacpp");

      await act(async () => {
        providerSelect.props.onChange("openai");
        await refreshState.callback?.({
          topic: "system",
          timestamp: Date.now(),
          reason: "settings-updated",
          source: "test",
        } as never);
      });
      await flush();

      expect(apiMocks.fetchOnboardingState).toHaveBeenCalledTimes(2);
      expect(renderer.root.findByProps({ id: "wizard-provider-id" }).props.value).toBe("openai");
    } finally {
      renderer.unmount();
    }
  });

  it("renders the wizard after onboarding state resolves even when daemon status is still pending", async () => {
    apiMocks.fetchDaemonStatus.mockImplementation(() => new Promise(() => undefined));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage />);
      });
      await flush();

      const text = renderer.toJSON();
      const flattened = JSON.stringify(text);
      expect(flattened).not.toContain("Loading Launch Wizard");
      expect(flattened).toContain("Launch Readiness");
      expect(flattened).toContain("Setup Steps");
      expect(flattened).toContain("Gateway Access");
      expect(flattened).toContain("Daemon status is unavailable right now.");
      const quickstartDetails = renderer.root.findAll((node) => node.type === "details")[0];
      expect(quickstartDetails?.props.open).toBeUndefined();
    } finally {
      renderer.unmount();
    }
  });

  it("keeps loopback bypass off for user-facing quickstart profiles unless explicitly enabled", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage />);
      });
      await flush();

      expect(renderer.root.findByProps({ id: "wizard-loopback" }).props.checked).toBe(false);
      expect(JSON.stringify(renderer.toJSON())).toContain("trusted single-machine development");

      const loadProfileButtons = renderer.root
        .findAllByType("button")
        .filter((node) => node.props.children === "Load profile");
      expect(loadProfileButtons.length).toBeGreaterThanOrEqual(2);

      await act(async () => {
        loadProfileButtons[0]?.props.onClick();
      });
      expect(renderer.root.findByProps({ id: "wizard-loopback" }).props.checked).toBe(false);

      await act(async () => {
        loadProfileButtons[1]?.props.onClick();
      });
      expect(renderer.root.findByProps({ id: "wizard-loopback" }).props.checked).toBe(false);
    } finally {
      renderer.unmount();
    }
  });

  it("resolves an install token, restarts the daemon, and submits onboarding", async () => {
    const completedState = makeOnboardingState();
    completedState.completed = true;
    completedState.settings.auth.mode = "token";
    completedState.settings.llm.activeProviderId = "openai";
    completedState.settings.llm.activeModel = "gpt-5.4";
    apiMocks.resolveGatewayInstallToken.mockResolvedValue({
      source: "generated",
      token: "install-token",
      warnings: ["Persist it before exposing the gateway."],
    });
    apiMocks.restartDaemon.mockResolvedValue({
      accepted: true,
      status: {
        running: true,
        controllable: true,
        state: "running",
        host: "127.0.0.1",
        pid: 8788,
        uptimeSeconds: 1,
        controlMessage: "Restarted.",
      },
    });
    apiMocks.bootstrapOnboarding.mockResolvedValue({
      state: completedState,
    });
    const onCompleted = vi.fn();

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage onCompleted={onCompleted} />);
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "wizard-auth-mode" }).props.onChange({ target: { value: "token" } });
      });
      await act(async () => {
        findButton(renderer, "Generate install token")?.props.onClick();
      });
      await flush();

      expect(apiMocks.resolveGatewayInstallToken).toHaveBeenCalledWith({
        generateWhenMissing: true,
        persistToEnv: false,
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("install-token");

      await act(async () => {
        findButton(renderer, "Restart daemon")?.props.onClick();
      });
      await flush();
      expect(apiMocks.restartDaemon).toHaveBeenCalledTimes(1);

      for (let index = 0; index < 4; index += 1) {
        await act(async () => {
          findButton(renderer, "Next")?.props.onClick();
        });
      }

      await act(async () => {
        renderer.root.findByProps({ id: "wizard-mark-complete" }).props.onChange({ target: { checked: true } });
      });
      await act(async () => {
        findButton(renderer, "Apply onboarding")?.props.onClick();
      });
      await flush();

      expect(apiMocks.bootstrapOnboarding).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: expect.objectContaining({
            mode: "token",
            token: "",
          }),
          llm: expect.objectContaining({
            activeProviderId: "openai",
            activeModel: "gpt-5.4",
          }),
          markComplete: true,
          completedBy: "mission-control",
        }),
      );
      expect(providerCatalogMocks.reloadProviderCatalog).toHaveBeenCalled();
      expect(onCompleted).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(renderer.toJSON())).toContain("Apply complete. Active provider: openai");
    } finally {
      renderer.unmount();
    }
  });

  it("submits basic auth and mesh form edits without losing user-entered values", async () => {
    const completedState = makeOnboardingState();
    completedState.completed = true;
    completedState.settings.auth.mode = "basic";
    completedState.settings.mesh.enabled = true;
    completedState.settings.mesh.mode = "tailnet";
    completedState.settings.mesh.nodeId = "node-alpha";
    completedState.settings.mesh.staticPeers = ["https://peer-a.local"];
    completedState.settings.mesh.requireMtls = false;
    completedState.settings.mesh.tailnetEnabled = true;
    apiMocks.bootstrapOnboarding.mockResolvedValue({
      state: completedState,
    });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage />);
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "wizard-auth-mode" }).props.onChange({ target: { value: "basic" } });
      });
      await act(async () => {
        renderer.root.findByProps({ id: "wizard-basic-username" }).props.onChange({
          target: { value: "operator" },
        });
        renderer.root.findByProps({ id: "wizard-basic-password" }).props.onChange({
          target: { value: "correct-horse" },
        });
      });

      for (let index = 0; index < 3; index += 1) {
        await act(async () => {
          findButton(renderer, "Next")?.props.onClick();
        });
      }

      await act(async () => {
        renderer.root.findByProps({ id: "wizard-mesh-enabled" }).props.onChange({ target: { checked: true } });
      });
      await act(async () => {
        renderer.root.findByProps({ id: "wizard-mesh-mode" }).props.onChange({ target: { value: "tailnet" } });
        renderer.root.findByProps({ id: "wizard-mesh-node-id" }).props.onChange({
          target: { value: "node-alpha" },
        });
        renderer.root.findByProps({ id: "wizard-mesh-mdns" }).props.onChange({ target: { checked: false } });
        renderer.root.findByProps({ id: "wizard-mesh-mtls" }).props.onChange({ target: { checked: false } });
        renderer.root.findByProps({ id: "wizard-mesh-tailnet" }).props.onChange({ target: { checked: true } });
        renderer.root.findByProps({ id: "wizard-mesh-peers" }).props.onChange({
          target: { value: "https://peer-a.local\nhttps://peer-b.local" },
        });
      });

      await act(async () => {
        findButton(renderer, "Next")?.props.onClick();
      });
      await act(async () => {
        renderer.root.findByProps({ id: "wizard-mark-complete" }).props.onChange({ target: { checked: true } });
      });
      await act(async () => {
        findButton(renderer, "Apply onboarding")?.props.onClick();
      });
      await flush();

      expect(apiMocks.bootstrapOnboarding).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: expect.objectContaining({
            mode: "basic",
            basicUsername: "operator",
            basicPassword: "correct-horse",
          }),
          mesh: {
            enabled: true,
            mode: "tailnet",
            nodeId: "node-alpha",
            mdns: false,
            staticPeers: ["https://peer-a.local", "https://peer-b.local"],
            requireMtls: false,
            tailnetEnabled: true,
          },
          markComplete: true,
        }),
      );
      expect(JSON.stringify(renderer.toJSON())).toContain("Apply complete. Active provider: openai");
    } finally {
      renderer.unmount();
    }
  });

  it("applies quickstart and allowlist presets while surfacing daemon start failures", async () => {
    apiMocks.fetchDaemonStatus.mockResolvedValue({
      running: false,
      controllable: true,
      state: "stopped",
      host: "127.0.0.1",
      pid: undefined,
      uptimeSeconds: 0,
      controlMessage: "Stopped.",
    });
    apiMocks.startDaemon.mockResolvedValue({
      accepted: false,
      reason: "daemon start refused",
      status: {
        running: false,
        controllable: true,
        state: "stopped",
        host: "127.0.0.1",
        controlMessage: "Stopped.",
      },
    });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage />);
      });
      await flush();

      await act(async () => {
        findButton(renderer, "Start daemon")?.props.onClick();
      });
      await flush();
      expect(apiMocks.startDaemon).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(renderer.toJSON())).toContain("daemon start refused");

      const loadProfileButtons = renderer.root
        .findAllByType("button")
        .filter((node) => node.props.children === "Load profile");
      await act(async () => {
        loadProfileButtons[2]?.props.onClick();
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Loaded Remote Hardened defaults.");

      await act(async () => {
        findButton(renderer, "Next")?.props.onClick();
      });
      await act(async () => {
        findButton(renderer, "Next")?.props.onClick();
      });

      const allowlistPreset = renderer.root.findByProps({ id: "wizard-allowlist-preset" });
      await act(async () => {
        allowlistPreset.props.onChange("common");
      });

      expect(renderer.root.findByProps({ id: "wizard-allowlist" }).props.value).toContain("api.openai.com");
      expect(renderer.root.findByProps({ id: "wizard-allowlist" }).props.value).toContain("openrouter.ai");

      await act(async () => {
        allowlistPreset.props.onChange("custom");
      });
      expect(renderer.root.findByProps({ id: "wizard-allowlist-preset" }).props.value).toBe("custom");
    } finally {
      renderer.unmount();
    }
  });

  it("runs debounced risk review and live model discovery without overwriting provider choices", async () => {
    vi.useFakeTimers();
    try {
      window.setTimeout = globalThis.setTimeout as typeof setTimeout;
      window.clearTimeout = globalThis.clearTimeout as typeof clearTimeout;
      providerCatalogMocks.previewProviderModels.mockResolvedValueOnce({
        items: ["gpt-5.5", "gpt-5.4"],
        source: "remote",
        warning: "catalog warning",
      });

      let renderer: ReactTestRenderer = create(<div />);
      try {
        await act(async () => {
          renderer = create(<OnboardingPage />);
        });
        await flush();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });
        await flush();

        expect(apiMocks.evaluateUiChangeRisk).toHaveBeenCalledWith(
          expect.objectContaining({ pageId: "onboarding" }),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );

        await act(async () => {
          await vi.advanceTimersByTimeAsync(600);
        });
        await flush();

        expect(providerCatalogMocks.previewProviderModels).toHaveBeenCalledWith(
          expect.objectContaining({
            providerId: "openai",
            baseUrl: "https://api.openai.com/v1",
            fallbackModel: "gpt-5.4",
          }),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );

        await act(async () => {
          findButton(renderer, "Next")?.props.onClick();
        });
        await flush();

        const text = JSON.stringify(renderer.toJSON());
        expect(text).toContain("Model discovery:");
        expect(text).toContain("live provider list");
        expect(text).toContain("catalog warning");
        expect(renderer.root.findByProps({ id: "wizard-model" }).props.value).toBe("gpt-5.4");
      } finally {
        renderer.unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces initial onboarding load failures", async () => {
    apiMocks.fetchOnboardingState.mockRejectedValueOnce(new Error("onboarding unavailable"));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage />);
      });
      await flush();

      const text = JSON.stringify(renderer.toJSON());
      expect(text).toContain("onboarding unavailable");
      expect(text).toContain("Gateway");
      expect(text).toContain("needs attention");
    } finally {
      renderer.unmount();
    }
  });

  it("blocks invalid provider transport config and surfaces apply failures", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage />);
      });
      await flush();

      await act(async () => {
        findButton(renderer, "Next")?.props.onClick();
      });
      await act(async () => {
        renderer.root.findByProps({ id: "wizard-provider-transport-request-headers" }).props.onChange({
          target: { value: "{" },
        });
      });
      for (let index = 0; index < 3; index += 1) {
        await act(async () => {
          findButton(renderer, "Next")?.props.onClick();
        });
      }
      await act(async () => {
        renderer.root.findByProps({ id: "wizard-mark-complete" }).props.onChange({ target: { checked: true } });
      });
      await act(async () => {
        findButton(renderer, "Apply onboarding")?.props.onClick();
      });
      await flush();

      expect(JSON.stringify(renderer.toJSON())).toContain("Custom headers must be valid JSON.");
      expect(apiMocks.bootstrapOnboarding).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
    }

    apiMocks.bootstrapOnboarding.mockRejectedValueOnce(new Error("bootstrap refused"));
    renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage />);
      });
      await flush();

      for (let index = 0; index < 4; index += 1) {
        await act(async () => {
          findButton(renderer, "Next")?.props.onClick();
        });
      }
      await act(async () => {
        renderer.root.findByProps({ id: "wizard-mark-complete" }).props.onChange({ target: { checked: true } });
      });
      await act(async () => {
        findButton(renderer, "Apply onboarding")?.props.onClick();
      });
      await flush();

      expect(apiMocks.bootstrapOnboarding).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(renderer.toJSON())).toContain("bootstrap refused");
    } finally {
      renderer.unmount();
    }
  });

  it("supports direct step navigation and explicit side-panel refresh actions", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage />);
      });
      await flush();

      await act(async () => {
        findButtonContaining(renderer, "Runtime Defaults")?.props.onClick();
      });
      await flush();
      expect(JSON.stringify(renderer.toJSON())).toContain("Step 3: Runtime Defaults");

      const callsAfterInitialLoad = apiMocks.fetchOnboardingState.mock.calls.length;
      await act(async () => {
        findButton(renderer, "Refresh readiness")?.props.onClick();
      });
      await flush();
      await act(async () => {
        findButton(renderer, "Refresh")?.props.onClick();
      });
      await flush();

      expect(apiMocks.fetchOnboardingState.mock.calls.length).toBeGreaterThanOrEqual(callsAfterInitialLoad + 2);
    } finally {
      renderer.unmount();
    }
  });

  it("classifies abort errors without treating ordinary failures as aborts", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError(new Error("network failed"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
