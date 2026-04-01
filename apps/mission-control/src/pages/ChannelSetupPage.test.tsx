import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  createChannelRepairDraft: vi.fn(),
  createChannelRotateSecretDraft: vi.fn(),
  createChannelSetupDraft: vi.fn(),
  fetchChannelSetupDefinition: vi.fn(),
  fetchChannelSetupDefinitions: vi.fn(),
  fetchChannelSetupDrafts: vi.fn(),
  fetchIntegrationCatalog: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  finalizeChannelSetupDraft: vi.fn(),
  retestChannelConnection: vi.fn(),
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
    <button disabled={disabled} onClick={onClick}>{label}</button>
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
  Panel: ({ title, subtitle, actions, children }: { title?: string; subtitle?: string; actions?: React.ReactNode; children?: React.ReactNode }) => (
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

import { ChannelSetupPage } from "./ChannelSetupPage";

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function catalogButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll((node) => (
    node.type === "button"
    && typeof node.props.className === "string"
    && node.props.className.includes("channel-setup-catalog-item")
    && node.findAllByType("strong").some((strongNode) => strongNode.children.join("") === label)
  ))[0];
}

function createDefinition(catalogId: string, label: string) {
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
          fields: [{
            key: "defaultChannel",
            label: "Default Channel",
            type: "text",
            required: true,
            explanation: "Channel",
          }],
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

describe("ChannelSetupPage", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    recordClientDiagnosticMock.mockReset();

    apiMocks.fetchIntegrationCatalog.mockResolvedValue({
      items: [
        { catalogId: "channel.discord", label: "Discord", description: "Discord", kind: "channel", capabilities: [], maturity: "beta", key: "discord" },
        { catalogId: "channel.slack", label: "Slack", description: "Slack", kind: "channel", capabilities: [], maturity: "beta", key: "slack" },
        { catalogId: "channel.google-chat", label: "Google Chat", description: "Google Chat", kind: "channel", capabilities: [], maturity: "beta", key: "google-chat" },
        { catalogId: "channel.teams", label: "Teams", description: "Teams", kind: "channel", capabilities: [], maturity: "beta", key: "teams" },
        { catalogId: "channel.tui", label: "TUI", description: "Terminal UI", kind: "channel", capabilities: [], maturity: "beta", key: "tui" },
      ],
    });
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue(createSetupDefinitionList(
      { catalogId: "channel.discord", label: "Discord" },
      { catalogId: "channel.slack", label: "Slack" },
      { catalogId: "channel.google-chat", label: "Google Chat" },
      { catalogId: "channel.teams", label: "Teams" },
    ));
    apiMocks.fetchIntegrationConnections.mockResolvedValue({ items: [] });
    apiMocks.fetchChannelSetupDrafts.mockResolvedValue({
      items: [{
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
      }],
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

      const text = rendererText(renderer);
      expect(text).toContain("Slack");
      expect(text).toContain("Google Chat");
      expect(text).toContain("Teams");
      expect(text).toContain("Guided Setup");
      expect(text).toContain("Start guided setup for Discord");
      expect(text).toContain("Guided flows are available for Discord, Google Chat, Slack, Teams.");
      expect(text).toContain("Recent drafts");
      expect(text).toContain("Resume Draft");
      expect(apiMocks.fetchChannelSetupDefinitions).toHaveBeenCalledOnce();
      expect(apiMocks.fetchChannelSetupDrafts).toHaveBeenCalledWith({
        catalogId: "channel.discord",
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
      expect(recordClientDiagnosticMock).toHaveBeenCalledWith(expect.objectContaining({
        event: "channel_draft_resumed",
      }));
    } finally {
      renderer.unmount();
    }
  });

  it("does not fetch guided setup definitions for manual-only channels", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });

      const tuiButton = catalogButton(renderer, "TUI");

      expect(tuiButton).toBeDefined();

      const initialCalls = apiMocks.fetchChannelSetupDefinition.mock.calls.length;

      await act(async () => {
        tuiButton?.props.onClick();
      });

      expect(apiMocks.fetchChannelSetupDefinition.mock.calls.length).toBe(initialCalls);
      const text = rendererText(renderer);
      expect(text).toContain("Manual path only for now");
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
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue(createSetupDefinitionList(
      { catalogId: "channel.discord", label: "Discord" },
      { catalogId: "channel.teams", label: "Teams" },
    ));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ChannelSetupPage />);
      });

      const text = rendererText(renderer);
      expect(text).toContain("Guided flows are available for Discord, Teams.");
      expect(text).toContain("Manual for now");

      const slackButton = catalogButton(renderer, "Slack");
      expect(slackButton).toBeDefined();

      await act(async () => {
        slackButton?.props.onClick();
      });

      expect(apiMocks.fetchChannelSetupDefinition).not.toHaveBeenCalledWith("channel.slack");
      expect(rendererText(renderer)).toContain("Guided coverage: ");
      expect(rendererText(renderer)).toContain("Discord, Teams");
    } finally {
      renderer.unmount();
    }
  });

  it("defaults to the first guided channel when Discord is not in the guided rollout set", async () => {
    apiMocks.fetchChannelSetupDefinitions.mockResolvedValue(createSetupDefinitionList(
      { catalogId: "channel.teams", label: "Teams" },
    ));

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
});
