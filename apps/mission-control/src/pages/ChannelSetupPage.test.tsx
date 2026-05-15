import React from "react";
import type { ChannelSetupDefinition } from "@goatcitadel/contracts";
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
  GCEmptyState: ({ title, subtitle, action }: { title?: string; subtitle?: string; action?: React.ReactNode }) => (
    <div>
      <strong>{title}</strong>
      <div>{subtitle}</div>
      {action}
    </div>
  ),
}));

import { ChannelSetupPage, formatConnectionTargetSummary, readConnectionString } from "./ChannelSetupPage";

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function catalogButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      typeof node.props.className === "string" &&
      node.props.className.includes("channel-setup-catalog-item") &&
      node.findAllByType("strong").some((strongNode) => strongNode.children.join("") === label),
  )[0];
}

function createDefinition(catalogId: string, label: string): ChannelSetupDefinition {
  return {
    catalog: {
      catalogId,
      key: label.toLowerCase().replace(/\s+/g, "-"),
      label,
      description: `${label} description`,
      kind: "channel",
      capabilities: ["chat"],
      maturity: "beta",
      supportedModes: ["guided", "manual"],
    },
    wizard: {
      archetype: catalogId === "channel.google-chat" ? "webhook_destination" : "workspace_server_token",
      contentVersion: "content.v1",
      estimatedMinutes: 10,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: `${label} setup`,
      prerequisites: [],
      steps: [
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
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
      namespace: "channel_setup.test",
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
      lastReviewedAt: "2026-03-29",
      volatility: "low",
      deprecationRisk: "low",
    },
  };
}

function createSetupDefinitionList(...items: Array<{ catalogId: string; label: string }>) {
  return {
    items: items.map((item) => createDefinition(item.catalogId, item.label)),
  };
}

function createDraft(overrides: Record<string, unknown> = {}) {
  return {
    draftId: "22222222-2222-2222-2222-222222222222",
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
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:05:00.000Z",
    ...overrides,
  };
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => {
    const children = button.props.children;
    return Array.isArray(children) ? children.includes(label) : children === label;
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("ChannelSetupPage", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    recordClientDiagnosticMock.mockReset();

    apiMocks.fetchIntegrationCatalog.mockResolvedValue({
      items: [
        {
          catalogId: "channel.discord",
          label: "Discord",
          description: "Discord",
          kind: "channel",
          capabilities: [],
          maturity: "beta",
          key: "discord",
        },
        {
          catalogId: "channel.slack",
          label: "Slack",
          description: "Slack",
          kind: "channel",
          capabilities: [],
          maturity: "beta",
          key: "slack",
        },
        {
          catalogId: "channel.google-chat",
          label: "Google Chat",
          description: "Google Chat",
          kind: "channel",
          capabilities: [],
          maturity: "beta",
          key: "google-chat",
        },
        {
          catalogId: "channel.teams",
          label: "Teams",
          description: "Teams",
          kind: "channel",
          capabilities: [],
          maturity: "beta",
          key: "teams",
        },
        {
          catalogId: "channel.tui",
          label: "TUI",
          description: "Terminal UI",
          kind: "channel",
          capabilities: [],
          maturity: "beta",
          key: "tui",
        },
      ],
    });
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue(
      createSetupDefinitionList(
        { catalogId: "channel.discord", label: "Discord" },
        { catalogId: "channel.slack", label: "Slack" },
        { catalogId: "channel.google-chat", label: "Google Chat" },
        { catalogId: "channel.teams", label: "Teams" },
      ),
    );
    apiMocks.fetchIntegrationConnections.mockResolvedValue({ items: [] });
    apiMocks.fetchSlackOAuthStatus.mockResolvedValue({
      configured: true,
      mode: "self_owned",
      scopes: ["chat:write"],
      missing: [],
      connections: [],
    });
    apiMocks.fetchChannelSetupDrafts.mockResolvedValue({
      items: [
        {
          draftId: "11111111-1111-1111-1111-111111111111",
          catalogId: "channel.discord",
          lifecycleMode: "repair",
          label: "Discord Repair",
          enabled: true,
          draft: {
            defaultChannel: "#ops",
          },
          contentVersion: "content.v1",
          adapterVersion: "adapter.v1",
          validationVersion: "validation.v1",
          testVersion: "test.v1",
          createdAt: "2026-03-29T00:00:00.000Z",
          updatedAt: "2026-03-29T00:05:00.000Z",
        },
      ],
    });
    apiMocks.fetchChannelSetupDefinition.mockImplementation(async (catalogId: string) => {
      if (catalogId === "channel.google-chat") {
        return createDefinition(catalogId, "Google Chat");
      }
      if (catalogId === "channel.slack") {
        return createDefinition(catalogId, "Slack");
      }
      if (catalogId === "channel.teams") {
        return createDefinition(catalogId, "Teams");
      }
      return createDefinition(catalogId, "Discord");
    });
  });

  it("renders the guided rollout channels and recent drafts", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Slack");
      expect(text).toContain("Google Chat");
      expect(text).toContain("Teams");
      expect(text).toContain("Guided Setup");
      expect(text).toContain("Connect Slack");
      expect(text).toContain("Set up Slack");
      expect(text).toContain("Guided flows are available for Discord, Google Chat, Slack, Teams.");
      expect(text).not.toContain("TUI");
      expect(text).not.toContain("Manual for now");
      expect(text).toContain("Recent drafts");
      expect(text).toContain("Resume Draft");
      expect(apiMocks.fetchChannelSetupDefinitions).toHaveBeenCalledOnce();
      expect(apiMocks.fetchChannelSetupDrafts).toHaveBeenCalledWith({
        catalogId: "channel.slack",
        limit: 12,
      });
    } finally {
      renderer.unmount();
    }
  });

  it("resumes a recent draft and records the lifecycle telemetry event", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });
      await flush();

      const resumeButton = renderer.root.findAllByType("button").find((node) => {
        const children = node.props.children;
        return Array.isArray(children) ? children.includes("Resume Draft") : children === "Resume Draft";
      });

      expect(resumeButton).toBeDefined();

      await act(async () => {
        resumeButton?.props.onClick();
      });

      const text = rendererText(renderer);
      expect(text).toContain("Repair");
      expect(text).toContain("Discord Repair");
      expect(recordClientDiagnosticMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "channel_draft_resumed",
        }),
      );
    } finally {
      renderer.unmount();
    }
  });

  it("hides built-in channels that are outside the guided rollout set", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });

      const tuiButton = catalogButton(renderer, "TUI");
      const text = rendererText(renderer);
      expect(tuiButton).toBeUndefined();
      expect(text).not.toContain("Manual for now");
      expect(text).not.toContain("Guided setup coming later");
      expect(text).not.toContain("Manual path only for now");
      expect(text).not.toContain("later phase");
    } finally {
      renderer.unmount();
    }
  });

  it("fetches the guided setup definition when selecting Teams", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });

      const teamsButton = catalogButton(renderer, "Teams");

      expect(teamsButton).toBeDefined();

      await act(async () => {
        teamsButton?.props.onClick();
      });

      expect(apiMocks.fetchChannelSetupDefinition).toHaveBeenCalledWith("channel.teams");
      const text = rendererText(renderer);
      expect(text).toContain("Teams setup wizard");
    } finally {
      renderer.unmount();
    }
  });

  it("uses the backend setup-definition list to classify guided versus manual channels", async () => {
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue(
      createSetupDefinitionList(
        { catalogId: "channel.discord", label: "Discord" },
        { catalogId: "channel.teams", label: "Teams" },
      ),
    );

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });

      const text = rendererText(renderer);
      expect(text).toContain("Guided flows are available for Discord, Teams.");
      expect(text).not.toContain("Manual for now");
      expect(text).not.toContain("Guided setup coming later");
      expect(text).not.toContain("Manual path only for now");
      expect(text).not.toContain("later phase");

      const slackButton = catalogButton(renderer, "Slack");
      const tuiButton = catalogButton(renderer, "TUI");
      expect(slackButton).toBeUndefined();
      expect(tuiButton).toBeUndefined();
      expect(rendererText(renderer)).not.toContain("Slack");
    } finally {
      renderer.unmount();
    }
  });

  it("shows a neutral empty state when no guided definitions are available", async () => {
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue({ items: [] });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });

      const text = rendererText(renderer);
      expect(text).toContain("No guided channel setup available");
      expect(text).toContain("Use Integrations to manage channel connections until a guided setup appears here.");
      expect(text).not.toContain("Manual for now");
      expect(text).not.toContain("Guided setup coming later");
      expect(text).not.toContain("later phase");
    } finally {
      renderer.unmount();
    }
  });

  it("defaults to the first guided channel when Discord is not in the guided rollout set", async () => {
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue(
      createSetupDefinitionList({ catalogId: "channel.teams", label: "Teams" }),
    );

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });

      const text = rendererText(renderer);
      expect(text).toContain("Guided flows are available for Teams.");
      expect(text).toContain("Teams setup wizard");
      expect(apiMocks.fetchChannelSetupDrafts).toHaveBeenCalledWith({
        catalogId: "channel.teams",
        limit: 12,
      });
    } finally {
      renderer.unmount();
    }
  });

  it("renders only guided-rollout connections in the managed connections panel", async () => {
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue(
      createSetupDefinitionList(
        { catalogId: "channel.discord", label: "Discord" },
        { catalogId: "channel.teams", label: "Teams" },
      ),
    );
    apiMocks.fetchIntegrationConnections.mockResolvedValue({
      items: [
        {
          connectionId: "connection-guided",
          catalogId: "channel.discord",
          label: "Discord Guided",
          status: "connected",
        },
        {
          connectionId: "connection-legacy",
          catalogId: "channel.tui",
          label: "Legacy TUI",
          status: "connected",
        },
      ],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });

      const text = rendererText(renderer);
      expect(text).toContain("Discord Guided");
      expect(text).not.toContain("Legacy TUI");
      expect(text).toContain("Edit");
      expect(text).toContain("Repair");
    } finally {
      renderer.unmount();
    }
  });

  it("runs the guided draft save, validate, test, and finalize lifecycle", async () => {
    const createdDraft = createDraft();
    const updatedDraft = createDraft({
      draft: {
        defaultChannel: "#alerts",
      },
      updatedAt: "2026-05-14T00:06:00.000Z",
    });
    apiMocks.createChannelSetupDraft.mockResolvedValue(createdDraft);
    apiMocks.updateChannelSetupDraft.mockResolvedValue(updatedDraft);
    apiMocks.validateChannelSetupDraft.mockResolvedValue({
      status: "ok",
      checkedAt: "2026-05-14T00:07:00.000Z",
      issues: [],
    });
    apiMocks.testChannelSetupDraft.mockResolvedValue({
      status: "ok",
      checkedAt: "2026-05-14T00:08:00.000Z",
      issues: [],
      probe: {
        steps: [{ key: "auth", label: "Auth", status: "ok", message: "Connected." }],
      },
    });
    apiMocks.finalizeChannelSetupDraft.mockResolvedValue({
      connection: {
        connectionId: "connection-slack",
        catalogId: "channel.slack",
        label: "Slack Ops",
        status: "connected",
        config: { defaultChannel: "#alerts" },
      },
      validation: {
        status: "ok",
        checkedAt: "2026-05-14T00:09:00.000Z",
        issues: [],
      },
      test: {
        status: "ok",
        checkedAt: "2026-05-14T00:10:00.000Z",
        issues: [],
      },
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });

      await act(async () => {
        findButton(renderer, "Set up Slack")?.props.onClick();
      });

      expect(apiMocks.createChannelSetupDraft).toHaveBeenCalledWith({
        catalogId: "channel.slack",
        connectionId: undefined,
        lifecycleMode: "create",
      });
      expect(rendererText(renderer)).toContain("Guided setup started for Slack.");

      await act(async () => {
        renderer.root.findByProps({ id: "channel-setup-defaultChannel" }).props.onChange({
          target: { value: "#alerts" },
        });
      });

      await act(async () => {
        findButton(renderer, "Save Draft")?.props.onClick();
      });
      expect(apiMocks.updateChannelSetupDraft).toHaveBeenLastCalledWith(createdDraft.draftId, {
        label: "Slack",
        enabled: true,
        draft: { defaultChannel: "#alerts" },
      });
      expect(rendererText(renderer)).toContain("Draft saved.");

      await act(async () => {
        findButton(renderer, "Validate")?.props.onClick();
      });
      expect(apiMocks.validateChannelSetupDraft).toHaveBeenCalledWith(createdDraft.draftId);
      expect(rendererText(renderer)).toContain("Validation passed.");

      await act(async () => {
        findButton(renderer, "Test")?.props.onClick();
      });
      expect(apiMocks.testChannelSetupDraft).toHaveBeenCalledWith(createdDraft.draftId);
      expect(rendererText(renderer)).toContain("Live test passed.");

      await act(async () => {
        findButton(renderer, "Finalize")?.props.onClick();
      });
      expect(apiMocks.finalizeChannelSetupDraft).toHaveBeenCalledWith(createdDraft.draftId);
      expect(rendererText(renderer)).toContain("Slack Ops is ready.");
      expect(recordClientDiagnosticMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "channel_finalize_succeeded",
        }),
      );
    } finally {
      renderer.unmount();
    }
  });

  it("applies manual JSON and discovers Telegram targets into the active draft", async () => {
    apiMocks.fetchIntegrationCatalog.mockResolvedValue({
      items: [
        {
          catalogId: "channel.telegram",
          label: "Telegram",
          description: "Telegram",
          kind: "channel",
          capabilities: [],
          maturity: "beta",
          key: "telegram",
        },
      ],
    });
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue(
      createSetupDefinitionList({ catalogId: "channel.telegram", label: "Telegram" }),
    );
    apiMocks.fetchChannelSetupDefinition.mockResolvedValue(createDefinition("channel.telegram", "Telegram"));
    apiMocks.createChannelSetupDraft.mockResolvedValue(
      createDraft({
        catalogId: "channel.telegram",
        label: "Telegram",
        draft: {
          botToken: "telegram-token",
          setupCode: "goat-setup",
        },
      }),
    );
    apiMocks.discoverTelegramTargets.mockResolvedValue({
      items: [
        { id: "ops", label: "Ops", chatId: "100", kind: "group" },
        { id: "alerts", label: "Alerts", chatId: "200", kind: "channel" },
      ],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });

      await act(async () => {
        findButton(renderer, "Set up Telegram")?.props.onClick();
      });
      expect(rendererText(renderer)).toContain("Guided setup started for Telegram.");

      await act(async () => {
        findButton(renderer, "Manual JSON")?.props.onClick();
      });
      await act(async () => {
        renderer.root.findByProps({ id: "channel-manual-json" }).props.onChange({
          target: { value: "{" },
        });
      });
      await act(async () => {
        findButton(renderer, "Apply JSON")?.props.onClick();
      });
      expect(rendererText(renderer)).toContain("Expected property name");

      await act(async () => {
        renderer.root.findByProps({ id: "channel-manual-json" }).props.onChange({
          target: { value: '{"setupCode":"manual-code"}' },
        });
      });
      await act(async () => {
        findButton(renderer, "Apply JSON")?.props.onClick();
      });
      expect(rendererText(renderer)).toContain("Manual JSON applied to the draft.");

      await act(async () => {
        findButton(renderer, "Detect Telegram Chats")?.props.onClick();
      });
      expect(apiMocks.discoverTelegramTargets).toHaveBeenCalledWith({
        botToken: undefined,
        botTokenEnv: undefined,
        setupCode: "manual-code",
      });
      expect(rendererText(renderer)).toContain("Found 2 Telegram targets.");
    } finally {
      renderer.unmount();
    }
  });

  it("runs guided edit, repair, rotate-secret, and re-test actions for existing connections", async () => {
    apiMocks.fetchIntegrationConnections.mockResolvedValue({
      items: [
        {
          connectionId: "connection-slack",
          catalogId: "channel.slack",
          label: "Slack Ops",
          status: "connected",
          config: { defaultChannel: "#ops" },
        },
      ],
    });
    apiMocks.createChannelSetupDraft.mockResolvedValue(createDraft({ lifecycleMode: "edit" }));
    apiMocks.createChannelRepairDraft.mockResolvedValue(
      createDraft({ draftId: "repair-draft", lifecycleMode: "repair", label: "Slack repair" }),
    );
    apiMocks.createChannelRotateSecretDraft.mockResolvedValue(
      createDraft({ draftId: "rotate-draft", lifecycleMode: "rotate_secret", label: "Slack rotate" }),
    );
    apiMocks.retestChannelConnection.mockResolvedValue({
      status: "error",
      checkedAt: "2026-05-14T00:11:00.000Z",
      issues: [{ key: "scope", message: "Missing scope", failureCategory: "oauth_scope" }],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });

      await act(async () => {
        findButton(renderer, "Re-test")?.props.onClick();
      });
      expect(apiMocks.retestChannelConnection).toHaveBeenCalledWith("connection-slack");
      expect(rendererText(renderer)).toContain("Re-test completed for Slack Ops.");
      expect(recordClientDiagnosticMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "channel_test_failed",
        }),
      );

      await act(async () => {
        findButton(renderer, "Edit")?.props.onClick();
      });
      expect(apiMocks.createChannelSetupDraft).toHaveBeenCalledWith({
        catalogId: "channel.slack",
        connectionId: "connection-slack",
        lifecycleMode: "edit",
      });

      await act(async () => {
        findButton(renderer, "Repair")?.props.onClick();
      });
      expect(apiMocks.createChannelRepairDraft).toHaveBeenCalledWith("connection-slack");
      expect(rendererText(renderer)).toContain("Repair draft ready for Slack Ops.");

      await act(async () => {
        findButton(renderer, "Rotate Secret")?.props.onClick();
      });
      expect(apiMocks.createChannelRotateSecretDraft).toHaveBeenCalledWith("connection-slack");
      expect(rendererText(renderer)).toContain("Rotate Secret draft ready for Slack Ops.");
    } finally {
      renderer.unmount();
    }
  });

  it("opens Slack OAuth and resumes the connected workspace into target setup", async () => {
    vi.useFakeTimers();
    const openSpy = vi.fn(() => null);
    vi.stubGlobal("window", {
      open: openSpy,
      setTimeout,
      clearTimeout,
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
        connections: [
          {
            connection: {
              connectionId: "connection-slack-oauth",
              catalogId: "channel.slack",
              label: "Slack OAuth",
              status: "connected",
              config: {
                oauthConnectedAt: "2026-05-14T00:12:00.000Z",
                defaultChannel: "#ops",
              },
            },
          },
        ],
      });
    apiMocks.startSlackOAuth.mockResolvedValue({
      authorizationUrl: "https://slack.test/oauth",
    });
    apiMocks.createChannelSetupDraft.mockResolvedValueOnce(createDraft()).mockResolvedValueOnce(
      createDraft({
        lifecycleMode: "edit",
        connectionId: "connection-slack-oauth",
        label: "Slack OAuth",
        draft: {
          defaultChannel: "#ops",
        },
      }),
    );

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });

      await act(async () => {
        findButton(renderer, "Set up Slack")?.props.onClick();
      });
      expect(rendererText(renderer)).toContain("Guided setup started for Slack.");

      await act(async () => {
        findButton(renderer, "Connect Slack")?.props.onClick();
      });

      expect(apiMocks.startSlackOAuth).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith("https://slack.test/oauth", "_blank", "noopener,noreferrer");
      expect(rendererText(renderer)).toContain("Slack authorization opened.");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(apiMocks.createChannelSetupDraft).toHaveBeenLastCalledWith({
        catalogId: "channel.slack",
        connectionId: "connection-slack-oauth",
        lifecycleMode: "edit",
      });
      expect(rendererText(renderer)).toContain("Edit draft ready for Slack OAuth.");
      expect(rendererText(renderer)).toContain("Slack OAuth");
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      renderer.unmount();
    }
  });

  it("surfaces initial catalog and guided-definition loading failures", async () => {
    apiMocks.fetchIntegrationCatalog.mockRejectedValueOnce(new Error("catalog unavailable"));

    let renderer = create(<div />);
    let text: string;
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });
      await flush();

      text = rendererText(renderer);
      expect(text).toContain("catalog unavailable");
      expect(text).toContain("No guided channel setup available");
    } finally {
      renderer.unmount();
    }

    apiMocks.fetchChannelSetupDefinition.mockRejectedValueOnce(new Error("definition unavailable"));
    renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });
      await flush();

      text = rendererText(renderer);
      expect(text).toContain("Couldn't load this guided channel");
      expect(text).toContain("definition unavailable");
      expect(findButton(renderer, "Set up Slack")?.props.disabled).toBe(true);
    } finally {
      renderer.unmount();
    }
  });

  it("keeps the wizard visible while surfacing save, validation, test, finalize, retest, and OAuth failures", async () => {
    apiMocks.fetchIntegrationConnections.mockResolvedValue({
      items: [
        {
          connectionId: "connection-slack",
          catalogId: "channel.slack",
          label: "Slack Ops",
          status: "connected",
          config: { defaultChannel: "#ops" },
        },
      ],
    });
    apiMocks.createChannelSetupDraft.mockResolvedValue(createDraft());
    apiMocks.updateChannelSetupDraft.mockRejectedValueOnce(new Error("save failed"));
    apiMocks.validateChannelSetupDraft.mockRejectedValueOnce(new Error("validation failed"));
    apiMocks.testChannelSetupDraft.mockRejectedValueOnce(new Error("test failed"));
    apiMocks.finalizeChannelSetupDraft.mockRejectedValueOnce(new Error("finalize failed"));
    apiMocks.retestChannelConnection.mockRejectedValueOnce(new Error("retest failed"));
    apiMocks.startSlackOAuth.mockRejectedValueOnce(new Error("oauth failed"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });
      await flush();

      await act(async () => {
        findButton(renderer, "Set up Slack")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("Guided setup started for Slack.");

      await act(async () => {
        findButton(renderer, "Save Draft")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("save failed");

      apiMocks.updateChannelSetupDraft.mockResolvedValue(createDraft());

      await act(async () => {
        findButton(renderer, "Validate")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("validation failed");

      await act(async () => {
        findButton(renderer, "Test")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("test failed");

      await act(async () => {
        findButton(renderer, "Finalize")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("finalize failed");

      await act(async () => {
        findButton(renderer, "Re-test")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("retest failed");

      await act(async () => {
        findButton(renderer, "Connect Slack")?.props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("oauth failed");
      expect(rendererText(renderer)).toContain("Slack setup wizard");
    } finally {
      renderer.unmount();
    }
  });

  it("reports the no-target Telegram discovery state and uses token env fallbacks", async () => {
    apiMocks.fetchIntegrationCatalog.mockResolvedValue({
      items: [
        {
          catalogId: "channel.telegram",
          label: "Telegram",
          description: "Telegram",
          kind: "channel",
          capabilities: [],
          maturity: "beta",
          key: "telegram",
        },
      ],
    });
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue(
      createSetupDefinitionList({ catalogId: "channel.telegram", label: "Telegram" }),
    );
    apiMocks.fetchChannelSetupDefinition.mockResolvedValue(createDefinition("channel.telegram", "Telegram"));
    apiMocks.createChannelSetupDraft.mockResolvedValue(
      createDraft({
        catalogId: "channel.telegram",
        label: "Telegram",
        draft: {
          tokenEnv: "TELEGRAM_BOT_TOKEN",
          setupCode: "goat-setup",
        },
      }),
    );
    apiMocks.discoverTelegramTargets.mockResolvedValue({ items: [] });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });
      await flush();

      await act(async () => {
        findButton(renderer, "Set up Telegram")?.props.onClick();
      });
      await flush();
      await act(async () => {
        findButton(renderer, "Detect Telegram Chats")?.props.onClick();
      });
      await flush();

      expect(apiMocks.discoverTelegramTargets).toHaveBeenCalledWith({
        botToken: undefined,
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        setupCode: "goat-setup",
      });
      expect(rendererText(renderer)).toContain(
        "No Telegram chats were found yet. Send /start or your setup code in Telegram, then try again.",
      );
    } finally {
      renderer.unmount();
    }
  });

  it("starts field collection from the preview and renders guidance, warnings, and successful retests", async () => {
    const richSlackDefinition = createDefinition("channel.slack", "Slack");
    richSlackDefinition.wizard.prerequisites = ["Create a Slack app"];
    richSlackDefinition.wizard.steps = [
      {
        id: "intro",
        kind: "intro",
        title: "Review Slack setup",
        body: [{ kind: "paragraph", text: "Use this before collecting values." }],
      },
      {
        id: "collect-values",
        kind: "field-collection",
        title: "Paste Slack values",
        description: "Collect the default Slack channel.",
        troubleshooting: [
          {
            id: "missing-scope",
            title: "Missing scope",
            body: "Reinstall the Slack app with chat:write.",
            nextSteps: ["Open OAuth settings", "Reinstall app"],
          },
        ],
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
    ];
    richSlackDefinition.volatility = {
      ...richSlackDefinition.volatility,
      officialDocsUrl: "https://api.slack.com/apps",
      volatility: "medium",
      deprecationRisk: "low",
    };
    apiMocks.fetchChannelSetupDefinition.mockResolvedValue(richSlackDefinition);
    apiMocks.createChannelSetupDraft.mockResolvedValue(
      createDraft({
        hydration: {
          warnings: ["Existing connection omitted an optional channel target."],
          fieldState: {},
        },
      }),
    );
    apiMocks.fetchIntegrationConnections.mockResolvedValue({
      items: [
        {
          connectionId: "connection-slack-ok",
          catalogId: "channel.slack",
          label: "Slack Live",
          status: "degraded",
          config: { defaultChannel: "#ops" },
        },
      ],
    });
    apiMocks.retestChannelConnection.mockResolvedValue({
      status: "ok",
      checkedAt: "2026-05-14T00:11:00.000Z",
      issues: [],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("Create a Slack app");
      expect(rendererText(renderer)).toContain("https://api.slack.com/apps");

      await act(async () => {
        findButton(renderer, "I already have the values")?.props.onClick();
      });
      await flush();

      expect(apiMocks.createChannelSetupDraft).toHaveBeenCalledWith({
        catalogId: "channel.slack",
        connectionId: undefined,
        lifecycleMode: "create",
      });
      const textAfterDraft = rendererText(renderer);
      expect(textAfterDraft).toContain("Paste Slack values");
      expect(textAfterDraft).toContain("Missing scope");
      expect(textAfterDraft).toContain("Existing connection omitted an optional channel target.");

      await act(async () => {
        findButton(renderer, "Re-test")?.props.onClick();
      });
      await flush();

      expect(apiMocks.retestChannelConnection).toHaveBeenCalledWith("connection-slack-ok");
      expect(rendererText(renderer)).toContain("Re-test passed for Slack Live.");
      expect(recordClientDiagnosticMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "channel_retest_completed",
        }),
      );
    } finally {
      renderer.unmount();
    }
  });

  it("keeps setup usable when recent drafts fail to load and Slack OAuth never reports a new workspace", async () => {
    vi.useFakeTimers();
    const openSpy = vi.fn(() => null);
    vi.stubGlobal("window", {
      open: openSpy,
      setTimeout,
      clearTimeout,
    });
    apiMocks.fetchChannelSetupDrafts.mockRejectedValue(new Error("drafts unavailable"));
    apiMocks.startSlackOAuth.mockResolvedValue({
      authorizationUrl: "https://slack.test/oauth",
    });
    apiMocks.fetchSlackOAuthStatus.mockResolvedValue({
      configured: true,
      mode: "self_owned",
      scopes: ["chat:write"],
      missing: [],
      connections: [],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("Set up Slack");
      expect(rendererText(renderer)).not.toContain("Resume Draft");

      await act(async () => {
        findButton(renderer, "Connect Slack")?.props.onClick();
      });
      expect(openSpy).toHaveBeenCalledWith("https://slack.test/oauth", "_blank", "noopener,noreferrer");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      await flush();

      expect(rendererText(renderer)).toContain(
        "Slack authorization opened. If approval finished, refresh connections or start an edit draft for Slack.",
      );
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      renderer.unmount();
    }
  });

  it("summarizes channel connection targets from structured config", () => {
    expect(
      formatConnectionTargetSummary({
        connectionId: "connection-1",
        catalogId: "channel.telegram",
        label: "Telegram",
        status: "connected",
        config: {
          targets: [
            { label: "Ops", chatId: "100", default: true },
            { label: "Alerts", chatId: "200" },
            "invalid-target",
          ],
        },
      } as any),
    ).toBe("channel.telegram · 2 targets · default Ops");
    expect(
      formatConnectionTargetSummary({
        connectionId: "connection-2",
        catalogId: "channel.slack",
        label: "Slack",
        status: "connected",
        config: {
          targets: [{ chatId: "C123" }],
        },
      } as any),
    ).toBe("channel.slack · 1 target · default C123");
    expect(
      formatConnectionTargetSummary({
        connectionId: "connection-3",
        catalogId: "channel.discord",
        label: "Discord",
        status: "connected",
        config: {
          defaultChannel: "ops",
        },
      } as any),
    ).toBe("channel.discord · default ops");
    expect(readConnectionString({ key: "  value  ", empty: " " }, "key")).toBe("value");
    expect(readConnectionString({ key: "  value  ", empty: " " }, "empty")).toBeUndefined();
  });
});
