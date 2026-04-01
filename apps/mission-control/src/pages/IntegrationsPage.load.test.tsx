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
  fetchConnectorRecords: vi.fn(),
  fetchDiscordPairings: vi.fn(),
  fetchIntegrationCatalog: vi.fn(),
  fetchIntegrationConnectionDiagnostics: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  fetchIntegrationFormSchema: vi.fn(),
  fetchIntegrationPlugins: vi.fn(),
  fetchObsidianIntegrationStatus: vi.fn(),
  fetchSettings: vi.fn(),
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
    fetchConnectorRecords: apiMocks.fetchConnectorRecords,
    fetchDiscordPairings: apiMocks.fetchDiscordPairings,
    fetchIntegrationCatalog: apiMocks.fetchIntegrationCatalog,
    fetchIntegrationConnectionDiagnostics: apiMocks.fetchIntegrationConnectionDiagnostics,
    fetchIntegrationConnections: apiMocks.fetchIntegrationConnections,
    fetchIntegrationFormSchema: apiMocks.fetchIntegrationFormSchema,
    fetchIntegrationPlugins: apiMocks.fetchIntegrationPlugins,
    fetchObsidianIntegrationStatus: apiMocks.fetchObsidianIntegrationStatus,
    fetchSettings: apiMocks.fetchSettings,
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

function baseCatalogEntry() {
  return {
    catalogId: "integration.discord",
    key: "discord",
    kind: "channel" as const,
    label: "Discord",
    description: "Discord channel adapter",
    authMethods: ["bot_token"],
    capabilities: ["messages"],
    maturity: "native" as const,
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
});
