import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: { reason?: string; eventType?: string; source?: string; timestamp: number }) => Promise<void> | void),
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
    callback: (signal: { reason?: string; eventType?: string; source?: string; timestamp: number }) => Promise<void> | void,
    options?: Record<string, unknown>,
  ) => {
    refreshState.callback = callback;
    refreshState.options = options ?? null;
  },
}));

vi.mock("../components/ChangeReviewPanel", () => ({
  ChangeReviewPanel: () => <div>ChangeReviewPanel</div>,
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
  }) => (
    <select id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import { OnboardingPage } from "./OnboardingPage";

function makeOnboardingState() {
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
      source: "remote",
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
});
