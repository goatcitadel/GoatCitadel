import React from "react";
import type { ChannelSetupDefinition, IntegrationCatalogEntry, IntegrationConnection } from "@goatcitadel/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  createChannelRepairDraft: vi.fn(),
  createChannelRotateSecretDraft: vi.fn(),
  createChannelSetupDraft: vi.fn(),
  fetchChannelSetupDefinition: vi.fn(),
  fetchChannelSetupDefinitions: vi.fn(),
  fetchChannelSetupDrafts: vi.fn(),
  fetchSlackOAuthStatus: vi.fn(),
  fetchIntegrationCatalog: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  finalizeChannelSetupDraft: vi.fn(),
  discoverTelegramTargets: vi.fn(),
  retestChannelConnection: vi.fn(),
  startSlackOAuth: vi.fn(),
  testChannelSetupDraft: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  validateChannelSetupDraft: vi.fn(),
}));

const recordClientDiagnosticMock = vi.hoisted(() => vi.fn());

vi.mock("../api/client", () => apiMocks);
vi.mock("../state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: recordClientDiagnosticMock,
}));
vi.mock("../components/ActionButton", () => ({
  ActionButton: ({ label, onClick, disabled }: { label: string; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {label}
    </button>
  ),
}));
vi.mock("../components/CardSkeleton", () => ({
  CardSkeleton: () => <div>CardSkeleton</div>,
}));
vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));
vi.mock("../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    actions,
    children,
  }: {
    title?: string;
    subtitle?: string;
    actions?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {subtitle ? <p>{subtitle}</p> : null}
      {actions}
      {children}
    </section>
  ),
}));
vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/ui/GCEmptyState", () => ({
  GCEmptyState: ({ title, subtitle }: { title?: string; subtitle?: string }) => (
    <div>
      <strong>{title}</strong>
      <div>{subtitle}</div>
    </div>
  ),
}));

import { ChannelSetupPage } from "./ChannelSetupPage";

function createDefinition(): ChannelSetupDefinition {
  return {
    catalog: {
      catalogId: "channel.slack",
      key: "slack",
      label: "Slack",
      description: "Slack",
      kind: "channel",
      capabilities: ["chat"],
      maturity: "beta",
      supportedModes: ["guided", "manual"],
    },
    wizard: {
      archetype: "workspace_server_token",
      contentVersion: "content.v1",
      estimatedMinutes: 10,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Slack setup",
      prerequisites: [],
      steps: [
        {
          id: "intro",
          kind: "intro",
          title: "Review Slack setup",
          checklist: [
            {
              id: "app",
              label: "Create a Slack app",
              detail: "Use the workspace where GoatCitadel should post.",
            },
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste Slack values",
          description: "Collect the default channel.",
          fields: [
            {
              key: "defaultChannel",
              label: "Default Channel",
              type: "text",
              required: true,
              explanation: "Channel",
            },
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish",
        },
      ],
    },
    adapter: {
      adapterVersion: "adapter.v1",
      secretFieldKeys: [],
    },
    validation: {
      validationVersion: "validation.v1",
      levels: ["structural"],
    },
    testing: {
      testVersion: "test.v1",
      levels: ["manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_1",
      namespace: "channel_setup.slack",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      lastReviewedAt: "2026-05-15",
      volatility: "low",
      deprecationRisk: "low",
    },
  };
}

function createTelegramDefinition(): ChannelSetupDefinition {
  return {
    ...createDefinition(),
    catalog: {
      catalogId: "channel.telegram",
      key: "telegram",
      label: "Telegram",
      description: "Telegram",
      kind: "channel",
      capabilities: ["chat"],
      maturity: "beta",
      supportedModes: ["guided", "manual"],
    },
    wizard: {
      ...createDefinition().wizard,
      introSummary: "Telegram setup",
      steps: [
        {
          id: "intro",
          kind: "intro",
          title: "Review Telegram setup",
          checklist: [
            {
              id: "bot",
              label: "Create a Telegram bot",
              detail: "Use BotFather and send the setup code to the chat.",
            },
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste Telegram values",
          description: "Collect bot and target values.",
          fields: [
            {
              key: "tokenEnv",
              label: "Bot token env",
              type: "text",
              required: true,
              explanation: "Environment variable for the bot token.",
            },
            {
              key: "setupCode",
              label: "Setup code",
              type: "text",
              required: false,
              explanation: "Code sent to Telegram.",
            },
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish",
        },
      ],
    },
    telemetry: {
      tier: "tier_1",
      namespace: "channel_setup.telegram",
    },
  };
}

function createCatalogEntry(overrides: Partial<IntegrationCatalogEntry> = {}): IntegrationCatalogEntry {
  const entry: IntegrationCatalogEntry = {
    catalogId: "channel.slack",
    label: "Slack",
    description: "Slack",
    kind: "channel",
    capabilities: [],
    maturity: "beta",
    key: "slack",
    authMethods: [],
  };
  return { ...entry, ...overrides } as IntegrationCatalogEntry;
}

function createDraft(overrides: Record<string, unknown> = {}) {
  return {
    draftId: "draft-loop32",
    catalogId: "channel.slack",
    lifecycleMode: "create",
    label: "Slack",
    enabled: true,
    draft: {
      defaultChannel: "#ops",
    },
    contentVersion: "content.v1",
    adapterVersion: "adapter.v1",
    validationVersion: "validation.v1",
    testVersion: "test.v1",
    createdAt: "2026-05-15T12:00:00.000Z",
    updatedAt: "2026-05-15T12:01:00.000Z",
    ...overrides,
  };
}

function createConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  const connection: IntegrationConnection = {
    connectionId: "conn-slack-1",
    catalogId: "channel.slack",
    kind: "channel",
    key: "slack",
    label: "Slack Primary",
    status: "connected",
    enabled: true,
    config: {
      defaultChannel: "#ops",
      oauthConnectedAt: "2026-05-15T12:00:00.000Z",
    },
    createdAt: "2026-05-15T12:00:00.000Z",
    updatedAt: "2026-05-15T12:00:00.000Z",
  };
  return { ...connection, ...overrides } as IntegrationConnection;
}

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
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

function findExactButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => nodeText(button.props.children).trim() === label);
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("ChannelSetupPage loop 32 behavior", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    recordClientDiagnosticMock.mockReset();
    apiMocks.fetchIntegrationCatalog.mockResolvedValue({
      items: [
        {
          ...createCatalogEntry(),
        },
      ],
    });
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue({ items: [createDefinition()] });
    apiMocks.fetchChannelSetupDefinition.mockResolvedValue(createDefinition());
    apiMocks.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
    apiMocks.fetchIntegrationConnections.mockResolvedValue({ items: [] });
    apiMocks.fetchSlackOAuthStatus.mockResolvedValue({
      configured: true,
      mode: "self_owned",
      scopes: ["chat:write"],
      missing: [],
      connections: [],
    });
  });

  it("starts from the preview footer and keeps Back and Next wizard navigation local", async () => {
    apiMocks.createChannelSetupDraft.mockResolvedValue(createDraft());

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });
      await flush();

      await act(async () => {
        findButton(renderer, "Start guided setup for Slack")?.props.onClick();
      });
      await flush();

      expect(apiMocks.createChannelSetupDraft).toHaveBeenCalledWith({
        catalogId: "channel.slack",
        connectionId: undefined,
        lifecycleMode: "create",
      });
      expect(rendererText(renderer)).toContain("Create a Slack app");
      expect(findButton(renderer, "Back")?.props.disabled).toBe(true);

      await act(async () => {
        findButton(renderer, "Next")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("Collect the default channel.");
      expect(findButton(renderer, "Back")?.props.disabled).toBe(false);

      await act(async () => {
        findButton(renderer, "Back")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("Review Slack setup");

      await act(async () => {
        findButton(renderer, "Finish")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("Finish");
      expect(recordClientDiagnosticMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "channel_wizard_started",
        }),
      );
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces draft lifecycle failures while preserving local field edits", async () => {
    apiMocks.fetchChannelSetupDrafts.mockRejectedValueOnce(new Error("draft list offline"));
    apiMocks.createChannelSetupDraft.mockRejectedValueOnce(new Error("draft start failed"));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });
      await flush();

      await act(async () => {
        findButton(renderer, "Start guided setup for Slack")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("draft start failed");

      apiMocks.createChannelSetupDraft.mockResolvedValue(createDraft());
      await act(async () => {
        findButton(renderer, "Start guided setup for Slack")?.props.onClick();
      });
      await flush();
      await act(async () => {
        findButton(renderer, "Next")?.props.onClick();
      });
      await flush();

      await act(async () => {
        renderer.root.findByProps({ id: "channel-setup-defaultChannel" }).props.onChange({
          target: { value: "#incidents" },
        });
      });

      apiMocks.updateChannelSetupDraft.mockRejectedValueOnce(new Error("draft save failed"));
      await act(async () => {
        findButton(renderer, "Save Draft")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("draft save failed");

      apiMocks.updateChannelSetupDraft.mockResolvedValue(createDraft({ draft: { defaultChannel: "#incidents" } }));
      apiMocks.validateChannelSetupDraft.mockRejectedValueOnce(new Error("validation offline"));
      await act(async () => {
        findButton(renderer, "Validate")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("validation offline");

      apiMocks.testChannelSetupDraft.mockRejectedValueOnce(new Error("test offline"));
      await act(async () => {
        findButton(renderer, "Test")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("test offline");

      apiMocks.updateChannelSetupDraft.mockResolvedValue(createDraft({ draft: { defaultChannel: "#incidents" } }));
      await act(async () => {
        findButton(renderer, "Save Draft")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("Draft saved.");

      apiMocks.finalizeChannelSetupDraft.mockRejectedValueOnce(new Error("finalize refused"));
      await act(async () => {
        findExactButton(renderer, "Finalize")?.props.onClick();
      });
      await flush();
      expect(apiMocks.finalizeChannelSetupDraft).toHaveBeenCalledWith("draft-loop32");
      expect(rendererText(renderer)).toContain("finalize refused");

      expect(apiMocks.updateChannelSetupDraft).toHaveBeenCalledWith(
        "draft-loop32",
        expect.objectContaining({
          draft: expect.objectContaining({
            defaultChannel: "#incidents",
          }),
        }),
      );
    } finally {
      renderer.unmount();
    }
  });

  it("opens Slack OAuth and turns the installed workspace into an edit draft", async () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const installedConnection = createConnection({
      connectionId: "conn-slack-installed",
      config: {
        defaultChannel: "#alerts",
        oauthConnectedAt: "2026-05-15T12:05:00.000Z",
      },
    });
    vi.stubGlobal("window", {
      open,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    apiMocks.fetchSlackOAuthStatus
      .mockResolvedValueOnce({
        configured: true,
        mode: "self_owned",
        scopes: ["chat:write"],
        missing: [],
        connections: [],
      })
      .mockResolvedValueOnce({
        configured: true,
        mode: "self_owned",
        scopes: ["chat:write"],
        missing: [],
        connections: [{ connection: installedConnection }],
      });
    apiMocks.startSlackOAuth.mockResolvedValue({ authorizationUrl: "https://slack.example/oauth" });
    apiMocks.createChannelSetupDraft.mockResolvedValue(
      createDraft({
        draftId: "draft-slack-edit",
        lifecycleMode: "edit",
        label: "Slack Primary",
        draft: { defaultChannel: "#alerts" },
      }),
    );

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });
      await flush();

      await act(async () => {
        findExactButton(renderer, "Connect Slack")?.props.onClick();
      });
      await flush();

      expect(open).toHaveBeenCalledWith("https://slack.example/oauth", "_blank", "noopener,noreferrer");
      expect(rendererText(renderer)).toContain("Slack authorization opened.");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await flush();

      expect(apiMocks.createChannelSetupDraft).toHaveBeenCalledWith({
        catalogId: "channel.slack",
        connectionId: "conn-slack-installed",
        lifecycleMode: "edit",
      });
      expect(rendererText(renderer)).toContain("Edit draft ready for Slack Primary.");
      expect(rendererText(renderer)).toContain("Paste Slack values");
    } finally {
      renderer.unmount();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("uses wizard header actions to connect Slack and jump directly to value collection", async () => {
    vi.useFakeTimers();
    const open = vi.fn();
    vi.stubGlobal("window", {
      open,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    apiMocks.createChannelSetupDraft.mockResolvedValue(createDraft());
    apiMocks.startSlackOAuth.mockResolvedValue({ authorizationUrl: "https://slack.example/header-oauth" });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });
      await flush();

      await act(async () => {
        findButton(renderer, "Start guided setup for Slack")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("Review Slack setup");

      const headerConnect = renderer.root
        .findAllByType("button")
        .filter((button) => nodeText(button.props.children).trim() === "Connect Slack")
        .at(-1);
      await act(async () => {
        headerConnect?.props.onClick();
      });
      await flush();

      expect(open).toHaveBeenCalledWith("https://slack.example/header-oauth", "_blank", "noopener,noreferrer");
      expect(rendererText(renderer)).toContain("Slack authorization opened.");

      const headerJump = renderer.root
        .findAllByType("button")
        .filter((button) => nodeText(button.props.children).trim() === "I already have the values")
        .at(-1);
      await act(async () => {
        headerJump?.props.onClick();
      });
      await flush();

      expect(rendererText(renderer)).toContain("Collect the default channel.");
      expect(rendererText(renderer)).toContain("Default Channel");
    } finally {
      renderer.unmount();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("detects Telegram targets from draft values and preserves empty/error discovery feedback", async () => {
    const telegramDefinition = createTelegramDefinition();
    apiMocks.fetchIntegrationCatalog.mockResolvedValue({
      items: [
        createCatalogEntry({
          catalogId: "channel.telegram",
          key: "telegram",
          label: "Telegram",
          description: "Telegram",
        }),
      ],
    });
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue({ items: [telegramDefinition] });
    apiMocks.fetchChannelSetupDefinition.mockResolvedValue(telegramDefinition);
    apiMocks.createChannelSetupDraft.mockResolvedValue(
      createDraft({
        catalogId: "channel.telegram",
        label: "Telegram",
        draft: {
          tokenEnv: "TELEGRAM_BOT_TOKEN",
          setupCode: "join-goat",
        },
      }),
    );
    apiMocks.discoverTelegramTargets
      .mockResolvedValueOnce({
        items: [{ id: "chat-1", label: "Ops Chat", chatId: "-1001", kind: "group" }],
      })
      .mockResolvedValueOnce({ items: [] })
      .mockRejectedValueOnce(new Error("telegram discovery offline"));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });
      await flush();

      await act(async () => {
        findButton(renderer, "Start guided setup for Telegram")?.props.onClick();
      });
      await flush();

      await act(async () => {
        findExactButton(renderer, "Detect Telegram Chats")?.props.onClick();
      });
      await flush();

      expect(apiMocks.discoverTelegramTargets).toHaveBeenCalledWith({
        botToken: undefined,
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        setupCode: "join-goat",
      });
      expect(rendererText(renderer)).toContain("Found 1 Telegram target.");

      await act(async () => {
        findExactButton(renderer, "Detect Telegram Chats")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("No Telegram chats were found yet.");

      await act(async () => {
        findExactButton(renderer, "Detect Telegram Chats")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("telegram discovery offline");
    } finally {
      renderer.unmount();
    }
  });
});
