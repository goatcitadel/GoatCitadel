import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: unknown) => Promise<void> | void),
}));

const apiMocks = vi.hoisted(() => ({
  approveDiscordPairing: vi.fn(),
  captureObsidianInboxEntry: vi.fn(),
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
  installIntegrationPlugin: vi.fn(),
  invokeIntegrationConnectionAction: vi.fn(),
  patchObsidianIntegrationConfig: vi.fn(),
  reconnectDiscordRuntime: vi.fn(),
  revokeDiscordPairing: vi.fn(),
  searchObsidianNotes: vi.fn(),
  testObsidianIntegration: vi.fn(),
  uploadChatAttachment: vi.fn(),
  updateIntegrationConnection: vi.fn(),
}));

vi.mock("../api/client", () => ({
  approveDiscordPairing: apiMocks.approveDiscordPairing,
  captureObsidianInboxEntry: apiMocks.captureObsidianInboxEntry,
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
  installIntegrationPlugin: apiMocks.installIntegrationPlugin,
  invokeIntegrationConnectionAction: apiMocks.invokeIntegrationConnectionAction,
  patchObsidianIntegrationConfig: apiMocks.patchObsidianIntegrationConfig,
  reconnectDiscordRuntime: apiMocks.reconnectDiscordRuntime,
  revokeDiscordPairing: apiMocks.revokeDiscordPairing,
  searchObsidianNotes: apiMocks.searchObsidianNotes,
  testObsidianIntegration: apiMocks.testObsidianIntegration,
  uploadChatAttachment: apiMocks.uploadChatAttachment,
}));

vi.mock("../api/integrations", () => ({
  updateIntegrationConnection: apiMocks.updateIntegrationConnection,
}));

vi.mock("../hooks/useAction", () => ({
  useAction: () => ({
    pending: false,
    run: async <T,>(work: () => Promise<T>) => work(),
  }),
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_topic: string, callback: (signal: unknown) => Promise<void> | void) => {
    refreshState.callback = callback;
  },
}));

vi.mock("../components/ChangeReviewPanel", () => ({
  ChangeReviewPanel: ({
    criticalConfirmed,
    onCriticalConfirmChange,
    overall,
  }: {
    criticalConfirmed?: boolean;
    onCriticalConfirmChange?: (value: boolean) => void;
    overall?: string;
  }) => (
    <section>
      <span>Risk {overall}</span>
      <button type="button" onClick={() => onCriticalConfirmChange?.(!criticalConfirmed)}>
        Toggle critical confirm
      </button>
    </section>
  ),
}));

vi.mock("../components/ConfirmModal", () => ({
  ConfirmModal: ({
    confirmLabel,
    message,
    onCancel,
    onConfirm,
    open,
    title,
  }: {
    confirmLabel?: string;
    message?: string;
    onCancel?: () => void;
    onConfirm?: () => void;
    open?: boolean;
    title?: string;
  }) =>
    open ? (
      <div>
        <p>{title}</p>
        <p>{message}</p>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel ?? "Confirm"}
        </button>
      </div>
    ) : null,
}));

vi.mock("../components/OperatorSplitLayout", () => ({
  OperatorSplitLayout: ({ inspector, primary }: { inspector?: React.ReactNode; primary?: React.ReactNode }) => (
    <div>
      {primary}
      {inspector}
    </div>
  ),
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("./integrations/IntegrationsPageIntro", () => ({
  IntegrationsPageIntro: ({
    error,
    headerActions,
    headerTitle,
  }: {
    error?: string | null;
    headerActions?: React.ReactNode;
    headerTitle?: string;
  }) => (
    <header>
      <h1>{headerTitle}</h1>
      {headerActions}
      {error ? <p>{error}</p> : null}
    </header>
  ),
}));

vi.mock("./integrations/IntegrationsCatalogPicker", () => ({
  IntegrationsCatalogPicker: ({
    catalog,
    onKindFilterChange,
    onSelectCatalogId,
  }: {
    catalog: Array<{ catalogId: string; label: string }>;
    onKindFilterChange: (value: "all" | "channel" | "productivity") => void;
    onSelectCatalogId: (value: string) => void;
  }) => (
    <section>
      {catalog.map((entry) => (
        <button key={entry.catalogId} type="button" onClick={() => onSelectCatalogId(entry.catalogId)}>
          Pick {entry.label}
        </button>
      ))}
      <button type="button" onClick={() => onKindFilterChange("productivity")}>
        Filter productivity
      </button>
    </section>
  ),
}));

vi.mock("./integrations/IntegrationsCreateConnectionPanel", () => ({
  IntegrationsCreateConnectionPanel: ({
    blockCreate,
    configJson,
    enabled,
    guidedConfig,
    onConfigJsonChange,
    onCreate,
    onEnabledChange,
    onGuidedConfigChange,
    onLabelChange,
    onShowAdvancedJsonChange,
    onStatusChange,
    showAdvancedJson,
  }: {
    blockCreate?: boolean;
    configJson: string;
    enabled: boolean;
    guidedConfig: Record<string, unknown>;
    onConfigJsonChange: (value: string) => void;
    onCreate: () => void;
    onEnabledChange: (value: boolean) => void;
    onGuidedConfigChange: (value: Record<string, unknown>) => void;
    onLabelChange: (value: string) => void;
    onShowAdvancedJsonChange: (value: boolean) => void;
    onStatusChange: (value: "connected" | "paused") => void;
    showAdvancedJson: boolean;
  }) => (
    <section>
      <span>{blockCreate ? "blocked" : "runnable"}</span>
      <span>{configJson}</span>
      <span>{JSON.stringify(guidedConfig)}</span>
      <button type="button" onClick={() => onLabelChange("Loop 37 connection")}>
        Set label
      </button>
      <button type="button" onClick={() => onGuidedConfigChange({ defaultChannel: "ops", label: "Guided label" })}>
        Set guided config
      </button>
      <button type="button" onClick={() => onShowAdvancedJsonChange(!showAdvancedJson)}>
        Toggle advanced JSON
      </button>
      <button type="button" onClick={() => onConfigJsonChange("{")}>
        Set invalid JSON
      </button>
      <button type="button" onClick={() => onEnabledChange(!enabled)}>
        Toggle enabled
      </button>
      <button type="button" onClick={() => onStatusChange("paused")}>
        Set paused
      </button>
      <button type="button" onClick={onCreate}>
        Save Connection
      </button>
    </section>
  ),
}));

vi.mock("./integrations/IntegrationsConnectionsTable", () => ({
  IntegrationsConnectionsTable: ({
    filteredConnections,
    onConnectionSearchChange,
    onRunDiagnostics,
    onSetDeleteTarget,
    onToggle,
    selectedDiagnostics,
  }: {
    filteredConnections: Array<{ connectionId: string; label: string }>;
    onConnectionSearchChange: (value: string) => void;
    onRunDiagnostics: (connectionId: string) => void;
    onSetDeleteTarget: (connection: unknown) => void;
    onToggle: (connection: unknown) => void;
    selectedDiagnostics?: { status?: string };
  }) => (
    <section>
      <input aria-label="Connection search" onChange={(event) => onConnectionSearchChange(event.target.value)} />
      {selectedDiagnostics ? <span>Diagnostics {selectedDiagnostics.status}</span> : null}
      {filteredConnections.map((connection) => (
        <div key={connection.connectionId}>
          <span>{connection.label}</span>
          <button type="button" onClick={() => onToggle(connection)}>
            Toggle {connection.label}
          </button>
          <button type="button" onClick={() => onRunDiagnostics(connection.connectionId)}>
            Diagnose {connection.label}
          </button>
          <button type="button" onClick={() => onSetDeleteTarget(connection)}>
            Delete {connection.label}
          </button>
        </div>
      ))}
    </section>
  ),
}));

vi.mock("./integrations/IntegrationsOperatorActionsPanel", () => ({
  IntegrationsOperatorActionsPanel: ({
    catalog,
    connections,
    result,
    onRunAction,
  }: {
    catalog: Array<{ catalogId: string; operatorActions?: Array<{ actionId: string; label: string }> }>;
    connections: Array<{ catalogId: string }>;
    result?: { message?: string } | null;
    onRunAction: (connection: unknown, action: { actionId: string }, input: Record<string, unknown>) => void;
  }) => {
    const entry = catalog.find((item) => item.operatorActions?.length);
    const connection = connections.find((item) => item.catalogId === entry?.catalogId);
    const action = entry?.operatorActions?.[0];
    return (
      <section>
        {result?.message ? <p>{result.message}</p> : null}
        {entry && connection && action ? (
          <button type="button" onClick={() => onRunAction(connection, action, { sample: true })}>
            Run {action.label}
          </button>
        ) : null}
      </section>
    );
  },
}));

vi.mock("./integrations/IntegrationsChannelTestBench", () => ({
  IntegrationsChannelTestBench: ({
    channelActionResult,
    channelTestResult,
    onApproveDiscordPairing,
    onChannelReactionEmojiChange,
    onChannelReactionMessageIdChange,
    onChannelTestMessageChange,
    onChannelTestTargetChange,
    onReactChannelTest,
    onReconnectDiscordRuntime,
    onRemoveUploadedChannelAttachment,
    onRevokeDiscordPairing,
    onSendChannelTest,
    onUnsendChannelTest,
    onUploadChannelAttachments,
    selectedChannelConnection,
    uploadedChannelAttachments,
    onChannelUnsendMessageIdChange,
  }: {
    channelActionResult?: string | null;
    channelTestResult?: string | null;
    onApproveDiscordPairing: (connectionId: string, pairingId: string) => void;
    onChannelReactionEmojiChange: (value: string) => void;
    onChannelReactionMessageIdChange: (value: string) => void;
    onChannelTestMessageChange: (value: string) => void;
    onChannelTestTargetChange: (value: string) => void;
    onReactChannelTest: () => void;
    onReconnectDiscordRuntime: (connectionId: string) => void;
    onRemoveUploadedChannelAttachment: (attachmentId: string) => void;
    onRevokeDiscordPairing: (connectionId: string, pairingId: string) => void;
    onSendChannelTest: () => void;
    onUnsendChannelTest: () => void;
    onUploadChannelAttachments: (files: FileList | null) => void;
    selectedChannelConnection?: { connectionId: string } | null;
    uploadedChannelAttachments: Array<{ attachmentId: string }>;
    onChannelUnsendMessageIdChange: (value: string) => void;
  }) => (
    <section>
      {channelTestResult ? <p>{channelTestResult}</p> : null}
      {channelActionResult ? <p>{channelActionResult}</p> : null}
      <button type="button" onClick={() => onChannelTestTargetChange("ops")}>
        Set channel target
      </button>
      <button type="button" onClick={() => onChannelTestMessageChange("Loop 37 message")}>
        Set channel message
      </button>
      <button type="button" onClick={onSendChannelTest}>
        Send channel test
      </button>
      <button type="button" onClick={() => onChannelReactionMessageIdChange("provider-1")}>
        Set reaction message
      </button>
      <button type="button" onClick={() => onChannelReactionEmojiChange("+1")}>
        Set reaction emoji
      </button>
      <button type="button" onClick={onReactChannelTest}>
        React channel
      </button>
      <button type="button" onClick={() => onChannelUnsendMessageIdChange("provider-1")}>
        Set unsend message
      </button>
      <button type="button" onClick={onUnsendChannelTest}>
        Unsend channel
      </button>
      <button
        type="button"
        onClick={() =>
          onUploadChannelAttachments({
            0: { name: "proof.txt" },
            length: 1,
            item: () => ({ name: "proof.txt" }),
          } as unknown as FileList)
        }
      >
        Upload channel attachment
      </button>
      {uploadedChannelAttachments.slice(0, 1).map((attachment) => (
        <button
          key={attachment.attachmentId}
          type="button"
          onClick={() => onRemoveUploadedChannelAttachment(attachment.attachmentId)}
        >
          Remove uploaded attachment
        </button>
      ))}
      {selectedChannelConnection ? (
        <>
          <button type="button" onClick={() => onReconnectDiscordRuntime(selectedChannelConnection.connectionId)}>
            Reconnect Discord
          </button>
          <button
            type="button"
            onClick={() => onApproveDiscordPairing(selectedChannelConnection.connectionId, "pair-1")}
          >
            Approve pairing
          </button>
          <button
            type="button"
            onClick={() => onRevokeDiscordPairing(selectedChannelConnection.connectionId, "pair-1")}
          >
            Revoke pairing
          </button>
        </>
      ) : null}
    </section>
  ),
}));

vi.mock("./integrations/IntegrationsObsidianPanel", () => ({
  IntegrationsObsidianPanel: ({
    obsidianSearchResults,
    onCaptureObsidianInbox,
    onObsidianAllowedSubpathsChange,
    onObsidianEnabledChange,
    onObsidianInboxRequestChange,
    onObsidianModeChange,
    onObsidianQueryChange,
    onObsidianVaultPathChange,
    onSaveObsidianConfig,
    onSearchObsidian,
    onTestObsidian,
  }: {
    obsidianSearchResults: Array<{ title: string }>;
    onCaptureObsidianInbox: () => void;
    onObsidianAllowedSubpathsChange: (value: string) => void;
    onObsidianEnabledChange: (value: boolean) => void;
    onObsidianInboxRequestChange: (value: string) => void;
    onObsidianModeChange: (value: "read_append" | "read_only") => void;
    onObsidianQueryChange: (value: string) => void;
    onObsidianVaultPathChange: (value: string) => void;
    onSaveObsidianConfig: () => void;
    onSearchObsidian: () => void;
    onTestObsidian: () => void;
  }) => (
    <section>
      {obsidianSearchResults.map((item) => (
        <span key={item.title}>{item.title}</span>
      ))}
      <button type="button" onClick={() => onObsidianEnabledChange(true)}>
        Enable Obsidian
      </button>
      <button type="button" onClick={() => onObsidianVaultPathChange("F:/Vault")}>
        Set vault
      </button>
      <button type="button" onClick={() => onObsidianModeChange("read_only")}>
        Set read only
      </button>
      <button type="button" onClick={() => onObsidianAllowedSubpathsChange("Inbox, Projects")}>
        Set subpaths
      </button>
      <button type="button" onClick={onSaveObsidianConfig}>
        Save Obsidian
      </button>
      <button type="button" onClick={onTestObsidian}>
        Test Obsidian
      </button>
      <button type="button" onClick={onSearchObsidian}>
        Search Obsidian
      </button>
      <button type="button" onClick={() => onObsidianQueryChange("Prompt Lab")}>
        Set Obsidian query
      </button>
      <button type="button" onClick={() => onObsidianInboxRequestChange("Capture this")}>
        Set inbox request
      </button>
      <button type="button" onClick={onCaptureObsidianInbox}>
        Capture Obsidian
      </button>
    </section>
  ),
}));

vi.mock("./integrations/IntegrationsPluginsPanel", () => ({
  IntegrationsPluginsPanel: ({
    onInstallPlugin,
    onPluginSourceChange,
    onTogglePlugin,
    plugins,
  }: {
    onInstallPlugin: () => void;
    onPluginSourceChange: (value: string) => void;
    onTogglePlugin: (pluginId: string, enabled: boolean) => void;
    plugins: Array<{ pluginId: string; enabled: boolean }>;
  }) => (
    <section>
      <button type="button" onClick={() => onPluginSourceChange("github:goat/plugin")}>
        Set plugin source
      </button>
      <button type="button" onClick={onInstallPlugin}>
        Install plugin
      </button>
      {plugins.map((plugin) => (
        <button key={plugin.pluginId} type="button" onClick={() => onTogglePlugin(plugin.pluginId, plugin.enabled)}>
          Toggle plugin {plugin.pluginId}
        </button>
      ))}
    </section>
  ),
}));

vi.mock("../content/copy", () => ({
  pageCopy: {
    integrations: {
      title: "Integrations",
      subtitle: "Connect services.",
    },
  },
}));

import { IntegrationsPage } from "./IntegrationsPage";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function instanceText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((child) => instanceText(child)).join(" ");
  }
  if (value && typeof value === "object" && "children" in value) {
    return instanceText((value as { children?: unknown }).children);
  }
  return "";
}

function button(renderer: ReactTestRenderer, label: string) {
  const match = renderer.root
    .findAllByType("button")
    .find((node) => instanceText(node).replace(/\s+/g, " ").trim().includes(label));
  if (!match) {
    const labels = renderer.root.findAllByType("button").map((node) => instanceText(node).replace(/\s+/g, " ").trim());
    throw new Error(`Button not found: ${label}. Buttons: ${labels.join(" | ")}`);
  }
  return match;
}

async function click(renderer: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    button(renderer, label).props.onClick();
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }
  });
}

function baseCatalog() {
  return [
    {
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
    },
    {
      catalogId: "productivity.apple-notes",
      key: "apple-notes",
      kind: "productivity" as const,
      label: "Apple Notes",
      description: "Apple Notes bridge",
      authMethods: ["bridge"],
      capabilities: ["read"],
      maturity: "beta" as const,
      runtimeAvailability: "runnable" as const,
      operatorActions: [{ actionId: "read", label: "Read Sample", description: "Read a sample note." }],
    },
  ];
}

function baseConnections() {
  return [
    {
      connectionId: "conn-discord",
      catalogId: "channel.discord",
      kind: "channel" as const,
      key: "discord",
      label: "Discord Gateway",
      enabled: true,
      status: "connected" as const,
      config: { runtimeMode: "gateway", defaultChannel: "ops" },
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z",
    },
    {
      connectionId: "conn-notes",
      catalogId: "productivity.apple-notes",
      kind: "productivity" as const,
      key: "apple-notes",
      label: "Apple Notes Bridge",
      enabled: true,
      status: "connected" as const,
      config: {},
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z",
    },
  ];
}

function obsidianStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: false,
    vaultPath: "",
    vaultReachable: false,
    mode: "read_append" as const,
    allowedSubpaths: [],
    checkedAt: "2026-05-15T00:00:00.000Z",
    lastOperationAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("IntegrationsPage loop 37 behavior", () => {
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
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });
    vi.spyOn(Date, "now").mockReturnValue(1_778_800_000_000);

    apiMocks.fetchIntegrationCatalog.mockResolvedValue({ items: baseCatalog() });
    apiMocks.fetchIntegrationConnections.mockResolvedValue({ items: baseConnections() });
    apiMocks.fetchConnectorRecords.mockResolvedValue({
      items: [
        {
          connectorId: "connector-discord",
          sourceId: "conn-discord",
          sourceType: "integration_connection",
          metadata: {
            channelCapabilities: {
              supportedActions: ["channel.react", "channel.unsend"],
            },
          },
        },
      ],
    });
    apiMocks.fetchSettings.mockResolvedValue({ features: { connectorDiagnosticsV1Enabled: true } });
    apiMocks.fetchIntegrationPlugins.mockResolvedValue({
      items: [{ pluginId: "plugin-1", enabled: true, label: "Plugin One" }],
    });
    apiMocks.fetchObsidianIntegrationStatus.mockResolvedValue(obsidianStatus());
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue({ items: [] });
    apiMocks.fetchIntegrationFormSchema.mockResolvedValue({
      title: "Integration setup",
      fields: [{ key: "defaultChannel", defaultValue: "ops" }],
    });
    apiMocks.fetchChannelRuntimeStatus.mockResolvedValue({ status: "ready" });
    apiMocks.fetchDiscordPairings.mockResolvedValue({
      runtime: { status: "connected" },
      items: [{ pairingId: "pair-1", status: "pending" }],
    });
    apiMocks.fetchIntegrationConnectionDiagnostics.mockResolvedValue({ status: "ok" });
    apiMocks.evaluateUiChangeRisk.mockResolvedValue({ overall: "safe", items: [] });
    apiMocks.patchObsidianIntegrationConfig.mockResolvedValue(
      obsidianStatus({
        enabled: true,
        vaultPath: "F:/Vault",
        mode: "read_only",
        allowedSubpaths: ["Inbox", "Projects"],
      }),
    );
    apiMocks.testObsidianIntegration.mockResolvedValue(obsidianStatus({ enabled: true, vaultReachable: true }));
    apiMocks.searchObsidianNotes.mockResolvedValue({
      items: [{ relativePath: "Prompt Lab.md", title: "Prompt Lab", snippet: "score review", score: 0.9 }],
    });
    apiMocks.captureObsidianInboxEntry.mockResolvedValue({ ok: true });
    apiMocks.createIntegrationConnection.mockResolvedValue({ connectionId: "new-connection" });
    apiMocks.updateIntegrationConnection.mockResolvedValue({ ok: true });
    apiMocks.deleteIntegrationConnection.mockResolvedValue({ ok: true });
    apiMocks.installIntegrationPlugin.mockResolvedValue({ ok: true });
    apiMocks.disableIntegrationPlugin.mockResolvedValue({ ok: true });
    apiMocks.invokeIntegrationConnectionAction.mockResolvedValue({
      status: "executed",
      message: "Read sample complete.",
    });
    apiMocks.commsSend.mockResolvedValue({ status: "sent", providerMessageId: "provider-1" });
    apiMocks.commsReact.mockResolvedValue({ status: "reacted" });
    apiMocks.commsUnsend.mockResolvedValue({ status: "unsent" });
    apiMocks.uploadChatAttachment.mockResolvedValue({ attachmentId: "upload-1", name: "proof.txt" });
    apiMocks.reconnectDiscordRuntime.mockResolvedValue({ status: "connected" });
    apiMocks.approveDiscordPairing.mockResolvedValue({ ok: true });
    apiMocks.revokeDiscordPairing.mockResolvedValue({ ok: true });
  });

  it("drives Obsidian save/test/search/capture through the page callbacks", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<IntegrationsPage />);
      });
      await flush();

      await click(renderer, "Enable Obsidian");
      await click(renderer, "Set vault");
      await click(renderer, "Set read only");
      await click(renderer, "Set subpaths");
      await click(renderer, "Save Obsidian");

      expect(apiMocks.patchObsidianIntegrationConfig).toHaveBeenCalledWith({
        enabled: true,
        vaultPath: "F:/Vault",
        mode: "read_only",
        allowedSubpaths: ["Inbox", "Projects"],
      });

      await click(renderer, "Test Obsidian");
      expect(apiMocks.testObsidianIntegration).toHaveBeenCalled();

      await click(renderer, "Search Obsidian");
      expect(rendererText(renderer)).toContain("Enter a search query for Obsidian notes.");

      await click(renderer, "Set Obsidian query");
      await click(renderer, "Search Obsidian");
      expect(apiMocks.searchObsidianNotes).toHaveBeenCalledWith({ query: "Prompt Lab", limit: 8 });
      expect(rendererText(renderer)).toContain("Prompt Lab");

      await click(renderer, "Set inbox request");
      await click(renderer, "Capture Obsidian");
      expect(apiMocks.captureObsidianInboxEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "GC-IN-1778800000",
          request: "Capture this",
        }),
      );
    } finally {
      renderer.unmount();
      vi.restoreAllMocks();
    }
  });

  it("drives connection create, toggle, diagnostics, operator action, plugin, and delete confirmation paths", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<IntegrationsPage />);
      });
      await flush();

      await click(renderer, "Set label");
      await click(renderer, "Set guided config");
      await click(renderer, "Save Connection");
      expect(apiMocks.createIntegrationConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          catalogId: "channel.discord",
          label: "Loop 37 connection",
          enabled: true,
          status: "connected",
          config: { defaultChannel: "ops" },
        }),
      );

      await click(renderer, "Toggle Discord Gateway");
      expect(apiMocks.updateIntegrationConnection).toHaveBeenCalledWith("conn-discord", {
        enabled: false,
        status: "paused",
      });

      await click(renderer, "Diagnose Discord Gateway");
      expect(apiMocks.fetchIntegrationConnectionDiagnostics).toHaveBeenCalledWith("conn-discord");
      expect(rendererText(renderer)).toContain("Diagnostics ok");

      await click(renderer, "Run Read Sample");
      expect(apiMocks.invokeIntegrationConnectionAction).toHaveBeenCalledWith("conn-notes", "read", {
        input: { sample: true },
      });
      expect(rendererText(renderer)).toContain("Read sample complete.");

      await click(renderer, "Install plugin");
      expect(rendererText(renderer)).toContain("Enter a plugin source first.");

      await click(renderer, "Set plugin source");
      await click(renderer, "Install plugin");
      expect(apiMocks.installIntegrationPlugin).toHaveBeenCalledWith({ source: "github:goat/plugin" });

      await click(renderer, "Toggle plugin plugin-1");
      expect(apiMocks.disableIntegrationPlugin).toHaveBeenCalledWith("plugin-1");

      await click(renderer, "Delete Discord Gateway");
      expect(rendererText(renderer)).toContain("Remove Integration Connection");
      await click(renderer, "Cancel");
      expect(apiMocks.deleteIntegrationConnection).not.toHaveBeenCalled();

      await click(renderer, "Delete Discord Gateway");
      await click(renderer, "Remove");
      expect(apiMocks.deleteIntegrationConnection).toHaveBeenCalledWith("conn-discord");
    } finally {
      renderer.unmount();
      vi.restoreAllMocks();
    }
  });

  it("drives channel delivery, upload, reaction, unsend, and Discord pairing callbacks", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<IntegrationsPage />);
      });
      await flush();

      await click(renderer, "Set channel target");
      await click(renderer, "Set channel message");
      await click(renderer, "Send channel test");
      expect(apiMocks.commsSend).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: "conn-discord",
          target: "ops",
          message: "Loop 37 message",
        }),
      );
      expect(rendererText(renderer)).toContain("Delivered with status sent");

      await click(renderer, "Set reaction message");
      await click(renderer, "Set reaction emoji");
      await click(renderer, "React channel");
      expect(apiMocks.commsReact).toHaveBeenCalledWith({
        connectionId: "conn-discord",
        target: "ops",
        messageId: "provider-1",
        reaction: "+1",
      });

      await click(renderer, "Set unsend message");
      await click(renderer, "Unsend channel");
      expect(apiMocks.commsUnsend).toHaveBeenCalledWith({
        connectionId: "conn-discord",
        target: "ops",
        messageId: "provider-1",
      });

      await click(renderer, "Upload channel attachment");
      expect(apiMocks.uploadChatAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session:operator:integrations",
        }),
      );
      await click(renderer, "Remove uploaded attachment");

      await click(renderer, "Reconnect Discord");
      expect(apiMocks.reconnectDiscordRuntime).toHaveBeenCalledWith("conn-discord");

      await click(renderer, "Approve pairing");
      expect(apiMocks.approveDiscordPairing).toHaveBeenCalledWith("conn-discord", "pair-1");

      await click(renderer, "Revoke pairing");
      expect(apiMocks.revokeDiscordPairing).toHaveBeenCalledWith("conn-discord", "pair-1");
    } finally {
      renderer.unmount();
      vi.restoreAllMocks();
    }
  });
});
