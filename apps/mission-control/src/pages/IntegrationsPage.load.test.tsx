import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: unknown) => Promise<void> | void),
}));

const apiMocks = vi.hoisted(() => ({
  approveDiscordPairing: vi.fn(),
  commsReact: vi.fn(),
  commsSend: vi.fn(),
  commsUnsend: vi.fn(),
  createIntegrationConnection: vi.fn(),
  deleteIntegrationConnection: vi.fn(),
  disableIntegrationPlugin: vi.fn(),
  enableIntegrationPlugin: vi.fn(),
  evaluateUiChangeRisk: vi.fn(),
  fetchChannelRuntimeStatus: vi.fn(),
  fetchChannelSetupDefinitions: vi.fn(),
  fetchConnectorRecords: vi.fn(),
  fetchDiscordPairings: vi.fn(),
  fetchIntegrationCatalog: vi.fn(),
  fetchIntegrationConnectionDiagnostics: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  fetchIntegrationFormSchema: vi.fn(),
  fetchIntegrationPlugins: vi.fn(),
  fetchObsidianIntegrationStatus: vi.fn(),
  fetchSettings: vi.fn(),
  invokeIntegrationConnectionAction: vi.fn(),
  installIntegrationPlugin: vi.fn(),
  patchObsidianIntegrationConfig: vi.fn(),
  reconnectDiscordRuntime: vi.fn(),
  revokeDiscordPairing: vi.fn(),
  searchObsidianNotes: vi.fn(),
  testObsidianIntegration: vi.fn(),
  updateIntegrationConnection: vi.fn(),
  uploadChatAttachment: vi.fn(),
  captureObsidianInboxEntry: vi.fn(),
}));

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    approveDiscordPairing: apiMocks.approveDiscordPairing,
    commsReact: apiMocks.commsReact,
    commsSend: apiMocks.commsSend,
    commsUnsend: apiMocks.commsUnsend,
    createIntegrationConnection: apiMocks.createIntegrationConnection,
    deleteIntegrationConnection: apiMocks.deleteIntegrationConnection,
    disableIntegrationPlugin: apiMocks.disableIntegrationPlugin,
    enableIntegrationPlugin: apiMocks.enableIntegrationPlugin,
    evaluateUiChangeRisk: apiMocks.evaluateUiChangeRisk,
    fetchChannelRuntimeStatus: apiMocks.fetchChannelRuntimeStatus,
    fetchChannelSetupDefinitions: apiMocks.fetchChannelSetupDefinitions,
    fetchConnectorRecords: apiMocks.fetchConnectorRecords,
    fetchDiscordPairings: apiMocks.fetchDiscordPairings,
    fetchIntegrationCatalog: apiMocks.fetchIntegrationCatalog,
    fetchIntegrationConnectionDiagnostics: apiMocks.fetchIntegrationConnectionDiagnostics,
    fetchIntegrationConnections: apiMocks.fetchIntegrationConnections,
    fetchIntegrationFormSchema: apiMocks.fetchIntegrationFormSchema,
    fetchIntegrationPlugins: apiMocks.fetchIntegrationPlugins,
    fetchObsidianIntegrationStatus: apiMocks.fetchObsidianIntegrationStatus,
    fetchSettings: apiMocks.fetchSettings,
    invokeIntegrationConnectionAction: apiMocks.invokeIntegrationConnectionAction,
    installIntegrationPlugin: apiMocks.installIntegrationPlugin,
    patchObsidianIntegrationConfig: apiMocks.patchObsidianIntegrationConfig,
    reconnectDiscordRuntime: apiMocks.reconnectDiscordRuntime,
    revokeDiscordPairing: apiMocks.revokeDiscordPairing,
    searchObsidianNotes: apiMocks.searchObsidianNotes,
    testObsidianIntegration: apiMocks.testObsidianIntegration,
    updateIntegrationConnection: apiMocks.updateIntegrationConnection,
    uploadChatAttachment: apiMocks.uploadChatAttachment,
    captureObsidianInboxEntry: apiMocks.captureObsidianInboxEntry,
  };
});

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (
    _topic: string,
    callback: (signal: unknown) => Promise<void> | void,
  ) => {
    refreshState.callback = callback;
  },
}));

import { IntegrationsPage } from "./IntegrationsPage";

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const collectText = (value: unknown): string => {
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => collectText(item)).join(" ");
    }
    if (!value || typeof value !== "object" || !("props" in value)) {
      return "";
    }
    return collectText((value as { props?: { children?: unknown } }).props?.children);
  };
  const button = root.findAllByType("button").find((node) => {
    return collectText(node).includes(label);
  });
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function rendererText(renderer: ReactTestRenderer): string {
  const collectText = (value: unknown): string => {
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => collectText(item)).join(" ");
    }
    if (!value || typeof value !== "object") {
      return "";
    }
    if ("children" in value) {
      return collectText((value as { children?: unknown }).children);
    }
    if ("props" in value) {
      return collectText((value as { props?: { children?: unknown } }).props?.children);
    }
    return "";
  };
  return collectText(renderer.toJSON());
}

function baseCatalogEntry() {
  return {
    catalogId: "channel.discord",
    key: "discord",
    kind: "channel" as const,
    label: "Discord",
    description: "Discord channel adapter",
    authMethods: ["bot_token"],
    capabilities: ["messages"],
    maturity: "native" as const,
    runtimeAvailability: "runnable" as const,
    docsUrl: null,
  };
}

function baseObsidianStatus() {
  return {
    enabled: false,
    vaultPath: "",
    vaultReachable: false,
    mode: "read_append" as const,
    allowedSubpaths: [],
    checkedAt: "2026-04-01T00:00:00.000Z",
    lastOperationAt: null,
    lastError: null,
  };
}

describe("IntegrationsPage load discipline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });
    apiMocks.fetchIntegrationCatalog.mockResolvedValue({ items: [baseCatalogEntry()] });
    apiMocks.fetchIntegrationConnections.mockResolvedValue({ items: [] });
    apiMocks.fetchConnectorRecords.mockResolvedValue({ items: [] });
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue({ items: [] });
    apiMocks.fetchSettings.mockResolvedValue({
      features: {
        connectorDiagnosticsV1Enabled: true,
      },
    });
    apiMocks.fetchIntegrationPlugins.mockResolvedValue({ items: [] });
    apiMocks.fetchObsidianIntegrationStatus.mockResolvedValue(baseObsidianStatus());
    apiMocks.fetchIntegrationFormSchema.mockResolvedValue({
      title: "Discord setup",
      description: "",
      fields: [],
    });
    apiMocks.evaluateUiChangeRisk.mockResolvedValue({
      overall: "safe",
      items: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips runtime settings fetches during background refresh", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<IntegrationsPage />);
      });
      await flush();

      expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(1);
      expect(refreshState.callback).toBeTypeOf("function");

      await act(async () => {
        await refreshState.callback?.({
          topic: "integrations",
          timestamp: Date.now(),
          reason: "test-refresh",
        });
      });
      await flush();

      expect(apiMocks.fetchIntegrationCatalog).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchIntegrationConnections).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchConnectorRecords).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchIntegrationPlugins).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchObsidianIntegrationStatus).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(1);
    } finally {
      renderer.unmount();
    }
  });

  it("debounces remote change-risk evaluation while config is being edited", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<IntegrationsPage />);
      });
      await flush();

      apiMocks.evaluateUiChangeRisk.mockClear();

      await act(async () => {
        findButton(renderer!.root, "Advanced JSON").props.onClick();
      });

      const textarea = renderer!.root.findByProps({ id: "connectionConfig" });
      await act(async () => {
        textarea.props.onChange({ target: { value: "{\"token\":\"one\"}" } });
        textarea.props.onChange({ target: { value: "{\"token\":\"two\"}" } });
      });

      await act(async () => {
        vi.advanceTimersByTime(399);
      });
      expect(apiMocks.evaluateUiChangeRisk).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      await flush();

      expect(apiMocks.evaluateUiChangeRisk).toHaveBeenCalledTimes(1);
    } finally {
      renderer.unmount();
    }
  });

  it("allows runnable beta entries to be created", async () => {
    apiMocks.fetchIntegrationCatalog.mockResolvedValue({
      items: [{
        ...baseCatalogEntry(),
        catalogId: "channel.whatsapp",
        key: "whatsapp",
        label: "WhatsApp",
        description: "WhatsApp Cloud bridge",
        maturity: "beta" as const,
        runtimeAvailability: "runnable" as const,
      }],
    });
    apiMocks.createIntegrationConnection.mockResolvedValue({
      connectionId: "connection-1",
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<IntegrationsPage />);
      });
      await flush();

      await act(async () => {
        findButton(renderer.root, "Save Connection").props.onClick();
      });
      await flush();

      expect(apiMocks.createIntegrationConnection).toHaveBeenCalledWith(expect.objectContaining({
        catalogId: "channel.whatsapp",
      }));
    } finally {
      renderer.unmount();
    }
  });

  it("keeps blocked visible entries non-runnable", async () => {
    apiMocks.fetchIntegrationCatalog.mockResolvedValue({
      items: [{
        ...baseCatalogEntry(),
        catalogId: "automation.image-gen",
        key: "image-gen",
        label: "Image Generation",
        description: "Image generation route",
        kind: "automation" as const,
        maturity: "beta" as const,
        runtimeAvailability: "blocked" as const,
      }],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<IntegrationsPage />);
      });
      await flush();

      expect(findButton(renderer.root, "Save Connection").props.disabled).toBe(true);
      expect(apiMocks.createIntegrationConnection).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
    }
  });

  it("shows guided vs manual-only setup truth for channels", async () => {
    apiMocks.fetchIntegrationCatalog.mockResolvedValue({
      items: [
        {
          ...baseCatalogEntry(),
          catalogId: "channel.discord",
          key: "discord",
          label: "Discord",
        },
        {
          ...baseCatalogEntry(),
          catalogId: "channel.whatsapp",
          key: "whatsapp",
          label: "WhatsApp",
          description: "WhatsApp Cloud bridge",
          maturity: "beta" as const,
          runtimeAvailability: "runnable" as const,
        },
      ],
    });
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue({
      items: [
        {
          catalog: {
            catalogId: "channel.discord",
            key: "discord",
            label: "Discord",
          },
        },
      ],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<IntegrationsPage view="channels" />);
      });
      await flush();

      expect(rendererText(renderer)).toMatch(/1\s+guided/);
      expect(rendererText(renderer)).toMatch(/1\s+manual only/);
      expect(rendererText(renderer)).toMatch(/Setup path:\s+Guided setup available/);

      await act(async () => {
        findButton(renderer.root, "WhatsApp").props.onClick();
      });
      await flush();

      expect(rendererText(renderer)).toMatch(/Setup path:\s+Manual path only for now/);
    } finally {
      renderer.unmount();
    }
  });

  it("shows blocked channels as unavailable in the current runtime", async () => {
    apiMocks.fetchIntegrationCatalog.mockResolvedValue({
      items: [{
        ...baseCatalogEntry(),
        catalogId: "channel.signal",
        key: "signal",
        label: "Signal",
        description: "Signal bridge",
        maturity: "beta" as const,
        runtimeAvailability: "blocked" as const,
      }],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<IntegrationsPage view="channels" />);
      });
      await flush();

      expect(rendererText(renderer)).toMatch(/Setup path:\s+Unavailable in current runtime/);
      expect(rendererText(renderer)).toContain("current runtime posture still blocks a runnable connection");
    } finally {
      renderer.unmount();
    }
  });

  it("shows runnable operator actions for visible non-channel entries", async () => {
    apiMocks.fetchIntegrationCatalog.mockResolvedValue({
      items: [{
        catalogId: "productivity.apple-notes",
        key: "apple-notes",
        kind: "productivity" as const,
        label: "Apple Notes",
        description: "Apple Notes local bridge",
        authMethods: ["bridge"],
        capabilities: ["read", "write"],
        maturity: "beta" as const,
        runtimeAvailability: "runnable" as const,
        operatorActions: [
          {
            actionId: "read",
            label: "Read Sample",
            description: "Fetch a sample note payload.",
            capability: "read",
          },
        ],
      }],
    });
    apiMocks.fetchIntegrationConnections.mockResolvedValue({
      items: [{
        connectionId: "connection-apple-notes",
        catalogId: "productivity.apple-notes",
        kind: "productivity" as const,
        key: "apple-notes",
        label: "Apple Notes Bridge",
        enabled: true,
        status: "connected" as const,
        config: { bridgeUrl: "http://127.0.0.1:4040" },
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      }],
    });
    apiMocks.invokeIntegrationConnectionAction.mockResolvedValue({
      connectionId: "connection-apple-notes",
      catalogId: "productivity.apple-notes",
      actionId: "read",
      status: "executed",
      message: "Fetched sample note payload.",
      checkedAt: "2026-04-10T00:00:00.000Z",
      output: {
        items: [{ title: "Sample note" }],
      },
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<IntegrationsPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("Operator Actions");
      await act(async () => {
        findButton(renderer.root, "Run Read Sample").props.onClick();
      });
      await flush();

      expect(apiMocks.invokeIntegrationConnectionAction).toHaveBeenCalledWith(
        "connection-apple-notes",
        "read",
        { input: {} },
      );
      expect(rendererText(renderer)).toContain("Fetched sample note payload.");
    } finally {
      renderer.unmount();
    }
  });
});
