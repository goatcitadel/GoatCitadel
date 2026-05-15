import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { OnboardingPage } from "./OnboardingPage";

function makeOnboardingState(overrides: Record<string, unknown> = {}) {
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
        activeProviderId: "openai",
        activeModel: "gpt-5.4",
        providers: [
          {
            providerId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            apiStyle: "openai-responses",
            defaultModel: "gpt-5.4",
          },
        ],
      },
      mesh: {
        enabled: false,
        mode: "lan",
        nodeId: "",
        mdns: true,
        staticPeers: [],
        requireMtls: true,
        tailnetEnabled: false,
      },
    },
    ...overrides,
  };
}

function makeDaemonStatus() {
  return {
    running: true,
    controllable: true,
    state: "running",
    host: "127.0.0.1",
    pid: 8787,
    uptimeSeconds: 15,
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

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => nodeText(button.props.children).includes(label));
}

describe("OnboardingPage loop 32 behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    apiMocks.fetchOnboardingState.mockResolvedValue(makeOnboardingState());
    apiMocks.fetchDaemonStatus.mockResolvedValue(makeDaemonStatus());
    apiMocks.evaluateUiChangeRisk.mockResolvedValue({ overall: "safe", items: [] });
    providerCatalogMocks.previewProviderModels.mockResolvedValue({
      items: ["gpt-5.4", "gpt-5.5"],
      source: "remote",
      warning: undefined,
    });
    providerCatalogMocks.reloadProviderCatalog.mockResolvedValue(undefined);
  });

  it("applies loopback, provider credential, model, budget, and custom allowlist edits", async () => {
    const completedState = makeOnboardingState({
      completed: true,
      settings: {
        ...makeOnboardingState().settings,
        auth: {
          mode: "none",
          allowLoopbackBypass: true,
        },
        budgetMode: "power",
        networkAllowlist: ["api.openai.com", "localhost"],
      },
    });
    apiMocks.bootstrapOnboarding.mockResolvedValue({ state: completedState });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage />);
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "wizard-loopback" }).props.onChange({ target: { checked: true } });
      });

      await act(async () => {
        findButton(renderer, "Next")?.props.onClick();
      });
      await flush();
      expect(JSON.stringify(renderer.toJSON())).toContain("Step 2: LLM Provider");

      await act(async () => {
        findButton(renderer, "Back")?.props.onClick();
      });
      await flush();
      expect(JSON.stringify(renderer.toJSON())).toContain("Step 1: Gateway Access");

      await act(async () => {
        findButton(renderer, "Next")?.props.onClick();
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "wizard-provider-api-key" }).props.onChange({
          target: { value: "sk-loop32" },
        });
        renderer.root.findByProps({ id: "wizard-provider-api-key-env" }).props.onChange({
          target: { value: "OPENAI_API_KEY" },
        });
        renderer.root.findByProps({ id: "wizard-provider-default-model" }).props.onChange("gpt-5.5");
      });

      await act(async () => {
        findButton(renderer, "Next")?.props.onClick();
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "wizard-budget" }).props.onChange("power");
        renderer.root.findByProps({ id: "wizard-allowlist" }).props.onChange({
          target: { value: "api.openai.com\nlocalhost\n" },
        });
      });

      await act(async () => {
        findButton(renderer, "Next")?.props.onClick();
      });
      await act(async () => {
        findButton(renderer, "Next")?.props.onClick();
      });
      await flush();

      await act(async () => {
        findButton(renderer, "Apply onboarding")?.props.onClick();
      });
      await flush();

      expect(apiMocks.bootstrapOnboarding).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: expect.objectContaining({
            mode: "none",
            allowLoopbackBypass: true,
          }),
          budgetMode: "power",
          networkAllowlist: ["api.openai.com", "localhost"],
          llm: expect.objectContaining({
            activeProviderId: "openai",
            activeModel: "gpt-5.4",
            upsertProvider: expect.objectContaining({
              providerId: "openai",
              apiKey: "sk-loop32",
              apiKeyEnv: "OPENAI_API_KEY",
              defaultModel: "gpt-5.5",
            }),
          }),
        }),
      );
      expect(providerCatalogMocks.reloadProviderCatalog).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(renderer.toJSON())).toContain("Apply complete. Active provider: openai");
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("shows generated install-token details and daemon control failures", async () => {
    apiMocks.fetchDaemonStatus.mockResolvedValue({
      running: false,
      controllable: true,
      state: "stopped",
      host: "127.0.0.1",
      controlMessage: "Gateway is stopped.",
    });
    apiMocks.resolveGatewayInstallToken.mockResolvedValue({
      source: "generated",
      token: "install-token-loop32",
      warnings: ["Persist this token before exposing the gateway."],
    });
    apiMocks.startDaemon.mockResolvedValue({
      accepted: false,
      reason: "daemon start refused",
      status: {
        running: false,
        controllable: true,
        state: "stopped",
      },
    });
    apiMocks.restartDaemon.mockRejectedValue(new Error("restart failed"));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OnboardingPage />);
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "wizard-auth-mode" }).props.onChange({ target: { value: "token" } });
      });
      await act(async () => {
        findButton(renderer, "Generate install token")?.props.onClick();
      });
      await flush();

      expect(JSON.stringify(renderer.toJSON())).toContain("install-token-loop32");
      expect(JSON.stringify(renderer.toJSON())).toContain("Persist this token");

      await act(async () => {
        findButton(renderer, "Start daemon")?.props.onClick();
      });
      await flush();
      expect(JSON.stringify(renderer.toJSON())).toContain("daemon start refused");

      await act(async () => {
        findButton(renderer, "Restart daemon")?.props.onClick();
      });
      await flush();
      expect(JSON.stringify(renderer.toJSON())).toContain("restart failed");
    } finally {
      renderer.unmount();
    }
  });

  it("uses discovered provider models when the saved provider draft is empty", async () => {
    vi.useFakeTimers();
    try {
      window.setTimeout = globalThis.setTimeout as typeof setTimeout;
      window.clearTimeout = globalThis.clearTimeout as typeof clearTimeout;
      apiMocks.fetchOnboardingState.mockResolvedValue(
        makeOnboardingState({
          activeModel: "",
          providers: [
            {
              providerId: "openai",
              label: "OpenAI",
              baseUrl: "https://api.openai.com/v1",
              apiStyle: "openai-responses",
              defaultModel: "",
            },
          ],
        }),
      );
      providerCatalogMocks.previewProviderModels.mockResolvedValue({
        items: ["gpt-5.5"],
        source: "remote",
        warning: undefined,
      });

      let renderer: ReactTestRenderer = create(<div />);
      try {
        await act(async () => {
          renderer = create(<OnboardingPage />);
        });
        await flush();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(650);
        });
        await flush();

        await act(async () => {
          findButton(renderer, "Next")?.props.onClick();
        });
        await flush();

        expect(renderer.root.findByProps({ id: "wizard-model" }).props.value).toBe("gpt-5.5");
        expect(renderer.root.findByProps({ id: "wizard-provider-default-model" }).props.value).toBe("gpt-5.5");
        expect(JSON.stringify(renderer.toJSON())).toContain("live provider list");
      } finally {
        renderer.unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks critical onboarding apply until explicit operator confirmation", async () => {
    vi.useFakeTimers();
    try {
      window.setTimeout = globalThis.setTimeout as typeof setTimeout;
      window.clearTimeout = globalThis.clearTimeout as typeof clearTimeout;
      apiMocks.evaluateUiChangeRisk.mockResolvedValue({
        overall: "critical",
        items: [{ field: "authMode", level: "critical", hint: "Authentication posture changed." }],
      });

      let renderer: ReactTestRenderer = create(<div />);
      try {
        await act(async () => {
          renderer = create(<OnboardingPage />);
        });
        await flush();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(450);
        });
        await flush();

        for (let index = 0; index < 4; index += 1) {
          await act(async () => {
            findButton(renderer, "Next")?.props.onClick();
          });
          await flush();
        }

        await act(async () => {
          findButton(renderer, "Apply onboarding")?.props.onClick();
        });
        await flush();

        expect(apiMocks.bootstrapOnboarding).not.toHaveBeenCalled();
        expect(JSON.stringify(renderer.toJSON())).toContain("Confirm critical changes before applying onboarding.");

        await act(async () => {
          findButton(renderer, "Confirm critical")?.props.onClick();
        });
        await act(async () => {
          findButton(renderer, "Apply onboarding")?.props.onClick();
        });
        await flush();

        expect(apiMocks.bootstrapOnboarding).toHaveBeenCalledTimes(1);
      } finally {
        renderer.unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
