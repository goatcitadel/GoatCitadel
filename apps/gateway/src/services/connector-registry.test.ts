import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection, McpServerRecord, McpToolRecord } from "@goatcitadel/contracts";
import { buildGatewayConnectorRecords } from "./connector-registry.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildGatewayConnectorRecords", () => {
  it("enables approval delivery for channel integrations with a configured default target", () => {
    const records = buildGatewayConnectorRecords({
      integrationConnections: [
        createIntegrationConnection("channel", "slack", {
          defaultChannel: "#ops-approvals",
        }),
      ],
      mcpServers: [],
      mcpTools: [],
    });

    const connector = records.find((item) => item.connectorId === "integration:conn-1");
    expect(connector).toBeDefined();
    expect(connector?.capabilities.find((item) => item.id === "approvals")?.enabled).toBe(true);
    expect(connector?.metadata?.approvalDeliveryTarget).toBe("#ops-approvals");
    expect(connector?.metadata?.approvalDeliveryReady).toBe(true);
  });

  it("keeps approval delivery disabled for channel integrations without a usable default target", () => {
    const records = buildGatewayConnectorRecords({
      integrationConnections: [createIntegrationConnection("channel", "slack")],
      mcpServers: [],
      mcpTools: [],
    });

    const connector = records.find((item) => item.connectorId === "integration:conn-1");
    expect(connector).toBeDefined();
    expect(connector?.capabilities.find((item) => item.id === "approvals")?.enabled).toBe(false);
    expect(connector?.metadata?.approvalDeliveryTarget).toBeUndefined();
    expect(connector?.metadata?.approvalDeliveryReady).toBe(false);
  });

  it("extracts approval delivery targets from additional channel-specific config keys", () => {
    const cases = [
      {
        key: "signal",
        config: { defaultRecipient: "+15551234567" },
        expectedTarget: "+15551234567",
      },
      {
        key: "imessage",
        config: { defaultHandle: "+15557654321" },
        expectedTarget: "+15557654321",
      },
      {
        key: "nextcloud-talk",
        config: { defaultConversationId: "room-42" },
        expectedTarget: "room-42",
      },
      {
        key: "line",
        config: { defaultUserId: "U1234567890" },
        expectedTarget: "U1234567890",
      },
      {
        key: "zalo",
        config: { defaultRecipientId: "zalo-user-123" },
        expectedTarget: "zalo-user-123",
      },
    ] as const;

    for (const testCase of cases) {
      const records = buildGatewayConnectorRecords({
        integrationConnections: [createIntegrationConnection("channel", testCase.key, testCase.config)],
        mcpServers: [],
        mcpTools: [],
      });

      const connector = records.find((item) => item.connectorId === "integration:conn-1");
      expect(connector?.metadata?.approvalDeliveryTarget).toBe(testCase.expectedTarget);
      expect(connector?.metadata?.approvalDeliveryReady).toBe(true);
    }
  });

  it("publishes channel-specific guidance for missing approval delivery targets", () => {
    const records = buildGatewayConnectorRecords({
      integrationConnections: [createIntegrationConnection("channel", "imessage")],
      mcpServers: [],
      mcpTools: [],
    });

    const connector = records.find((item) => item.connectorId === "integration:conn-1");
    expect(connector?.metadata?.approvalDeliveryTarget).toBeUndefined();
    expect(connector?.metadata?.approvalDeliveryReason).toBe(
      "Set config.defaultHandle or config.defaultTarget to enable approval delivery.",
    );
  });

  it("advertises richer channel actions and diagnostics only when the configured bridge mode supports them", () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "resolved-telegram-webhook-secret");
    const imessageRecords = buildGatewayConnectorRecords({
      integrationConnections: [
        createIntegrationConnection("channel", "imessage", {
          bridgeUrl: "http://127.0.0.1:1234",
          passwordEnv: "IMESSAGE_PASSWORD",
          defaultHandle: "imessage:+15551234567",
        }),
      ],
      mcpServers: [],
      mcpTools: [],
    });
    const slackRecords = buildGatewayConnectorRecords({
      integrationConnections: [
        createIntegrationConnection("channel", "slack", {
          defaultChannel: "#ops",
          botTokenEnv: "SLACK_BOT_TOKEN",
        }),
      ],
      mcpServers: [],
      mcpTools: [],
    });
    const discordWebhookRecords = buildGatewayConnectorRecords({
      integrationConnections: [
        createIntegrationConnection("channel", "discord", {
          defaultChannelId: "1234567890",
          webhookUrl: "https://discord.com/api/webhooks/123/test",
        }),
      ],
      mcpServers: [],
      mcpTools: [],
    });
    const googleChatRecords = buildGatewayConnectorRecords({
      integrationConnections: [
        createIntegrationConnection("channel", "google-chat", {
          webhookUrl: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=test&token=test",
          defaultThreadKey: "ops-thread",
        }),
      ],
      mcpServers: [],
      mcpTools: [],
    });
    const teamsRecords = buildGatewayConnectorRecords({
      integrationConnections: [
        createIntegrationConnection("channel", "teams", {
          webhookUrl: "https://outlook.office.com/webhook/example",
        }),
      ],
      mcpServers: [],
      mcpTools: [],
    });
    const telegramRecords = buildGatewayConnectorRecords({
      integrationConnections: [
        createIntegrationConnection("channel", "telegram", {
          botTokenEnv: "TELEGRAM_BOT_TOKEN",
          webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET",
          defaultChatId: "-1001234567890",
        }),
      ],
      mcpServers: [],
      mcpTools: [],
    });
    const whatsappRecords = buildGatewayConnectorRecords({
      integrationConnections: [
        createIntegrationConnection("channel", "whatsapp", {
          phoneNumberId: "123456789012345",
          accessTokenEnv: "WHATSAPP_ACCESS_TOKEN",
          defaultTarget: "+15551234567",
        }),
      ],
      mcpServers: [],
      mcpTools: [],
    });

    const imessage = imessageRecords.find((item) => item.connectorId === "integration:conn-1");
    expect(imessage?.capabilities.find((item) => item.id === "interactive_actions")?.enabled).toBe(true);
    expect(imessage?.metadata?.approvalInlineActionsReady).toBe(false);
    expect(imessage?.metadata?.supportedDeliveryActions).toEqual(
      expect.arrayContaining(["channel.send", "channel.reply", "channel.react", "channel.unsend"]),
    );
    expect(imessage?.metadata?.setupReady).toBe(true);
    expect(imessage?.metadata?.channelSupportNotes).toEqual(
      expect.arrayContaining(["Reactions and unsend require BlueBubbles Private API support."]),
    );
    expect(
      (imessage?.metadata?.channelCapabilities as { runtimePolicy?: { typing?: boolean } })?.runtimePolicy?.typing,
    ).toBe(false);

    const slack = slackRecords.find((item) => item.connectorId === "integration:conn-1");
    expect(slack?.capabilities.find((item) => item.id === "interactive_actions")?.enabled).toBe(true);
    expect(slack?.metadata?.approvalInlineActionsReady).toBe(false);
    expect(slack?.metadata?.supportedDeliveryActions).toEqual(
      expect.arrayContaining(["channel.send", "channel.reply", "channel.react", "channel.unsend"]),
    );
    expect(slack?.metadata?.supportedAttachmentSources).toEqual(["url", "inline"]);
    expect(slack?.metadata?.channelSupportNotes).toEqual(
      expect.arrayContaining([
        "Guided setup can run a sandbox send/delete probe on the bot-token path before finalize.",
        "Slack inbound routing remains disabled until a signing secret is configured.",
      ]),
    );

    const discordWebhook = discordWebhookRecords.find((item) => item.connectorId === "integration:conn-1");
    expect(discordWebhook?.capabilities.find((item) => item.id === "interactive_actions")?.enabled).toBe(true);
    expect(discordWebhook?.metadata?.approvalInlineActionsReady).toBe(false);
    expect(discordWebhook?.metadata?.supportedDeliveryActions).toEqual([
      "channel.send",
      "channel.unsend",
      "channel.activity",
    ]);
    expect(discordWebhook?.metadata?.supportedAttachmentSources).toEqual(["url", "inline"]);
    expect(discordWebhook?.metadata?.channelSupportNotes).toEqual(
      expect.arrayContaining([
        "Webhook-only Discord connections can unsend webhook-authored messages, but cannot add reactions, send typing indicators, or accept inbound traffic.",
      ]),
    );
    expect(
      (discordWebhook?.metadata?.channelCapabilities as { inboundModes?: string[] } | undefined)?.inboundModes,
    ).toEqual(["none"]);

    const googleChat = googleChatRecords.find((item) => item.connectorId === "integration:conn-1");
    expect(googleChat?.metadata?.supportedAttachmentSources).toEqual(["url"]);
    expect(googleChat?.metadata?.channelSupportNotes).toEqual(
      expect.arrayContaining([
        "Guided setup can run a sandbox webhook probe before finalize, but destination confirmation is still manual.",
        "Google Chat webhook mode is outbound only and does not provide inbound routing.",
      ]),
    );

    const teams = teamsRecords.find((item) => item.connectorId === "integration:conn-1");
    expect(teams?.metadata?.supportedAttachmentSources).toEqual(["url"]);
    expect(teams?.metadata?.channelSupportNotes).toEqual(
      expect.arrayContaining([
        "Guided setup can run a sandbox webhook probe before finalize, but destination confirmation is still manual.",
        "Teams webhook mode is outbound only and does not provide inbound routing.",
      ]),
    );

    const telegram = telegramRecords.find((item) => item.connectorId === "integration:conn-1");
    expect(telegram?.metadata?.approvalInlineActionsReady).toBe(true);
    expect(telegram?.metadata?.supportedDeliveryActions).toEqual(
      expect.arrayContaining(["channel.send", "channel.reply", "channel.react", "channel.unsend", "channel.typing"]),
    );
    expect(
      (telegram?.metadata?.channelCapabilities as { runtimePolicy?: { typing?: boolean } })?.runtimePolicy?.typing,
    ).toBe(true);
    expect(telegram?.metadata?.channelSupportNotes).toEqual(
      expect.arrayContaining([
        "Guided setup can run a sandbox send/delete probe before finalize.",
        "Telegram inbound webhook routing is enabled through the Bot API secret-token webhook path.",
      ]),
    );

    const whatsapp = whatsappRecords.find((item) => item.connectorId === "integration:conn-1");
    expect(whatsapp?.metadata?.supportedDeliveryActions).toEqual(
      expect.arrayContaining(["channel.send", "channel.reply", "channel.react"]),
    );
    expect(whatsapp?.metadata?.supportedAttachmentSources).toEqual(["url", "inline"]);
    expect(whatsapp?.metadata?.channelSupportNotes).toEqual(
      expect.arrayContaining([
        "WhatsApp Cloud API rich sends support public URL media and uploaded inline files for supported image, video, audio, and document types.",
      ]),
    );
  });

  it("does not advertise inline approval actions for outbound-only Telegram connections", () => {
    const records = buildGatewayConnectorRecords({
      integrationConnections: [
        createIntegrationConnection("channel", "telegram", {
          botTokenEnv: "TELEGRAM_BOT_TOKEN",
          defaultChatId: "-1001234567890",
        }),
      ],
      mcpServers: [],
      mcpTools: [],
    });

    const connector = records.find((item) => item.connectorId === "integration:conn-1");
    expect(connector?.metadata?.approvalDeliveryReady).toBe(true);
    expect(connector?.metadata?.approvalInlineActionsReady).toBe(false);
  });

  it("does not advertise inline approval actions when the configured Telegram webhook secret env is unresolved", () => {
    vi.stubEnv("GOATCITADEL_TELEGRAM_REVIEW_WEBHOOK_SECRET", "");
    const records = buildGatewayConnectorRecords({
      integrationConnections: [
        createIntegrationConnection("channel", "telegram", {
          botTokenEnv: "TELEGRAM_BOT_TOKEN",
          webhookSecretEnv: "GOATCITADEL_TELEGRAM_REVIEW_WEBHOOK_SECRET",
          defaultChatId: "-1001234567890",
        }),
      ],
      mcpServers: [],
      mcpTools: [],
    });

    const connector = records.find((item) => item.connectorId === "integration:conn-1");
    expect(connector?.metadata?.approvalDeliveryReady).toBe(true);
    expect(connector?.metadata?.approvalInlineActionsReady).toBe(false);
  });

  it("publishes setup diagnostics for incomplete channel bridge configs", () => {
    const records = buildGatewayConnectorRecords({
      integrationConnections: [
        createIntegrationConnection("channel", "imessage", {
          defaultHandle: "imessage:+15551234567",
        }),
      ],
      mcpServers: [],
      mcpTools: [],
    });

    const connector = records.find((item) => item.connectorId === "integration:conn-1");
    expect(connector?.metadata?.setupReady).toBe(false);
    expect(connector?.metadata?.setupDiagnostics).toEqual(
      expect.arrayContaining([
        "Missing one of: config.bridgeUrl, config.baseUrl, config.serverUrl.",
        "Missing one of: config.passwordEnv, config.password, config.apiPasswordEnv, config.apiPassword.",
      ]),
    );
  });

  it("publishes the MCP approval delivery tool contract in connector metadata when the tool exists", () => {
    const records = buildGatewayConnectorRecords({
      integrationConnections: [],
      mcpServers: [createMcpServer()],
      mcpTools: [createMcpTool("server-1", "goatcitadel.approval.remote_action_ready")],
    });

    const connector = records.find((item) => item.connectorId === "mcp:server-1");
    expect(connector).toBeDefined();
    expect(connector?.metadata?.approvalDeliveryToolName).toBe("goatcitadel.approval.remote_action_ready");
    expect(connector?.capabilities.find((item) => item.id === "approvals")?.enabled).toBe(true);
    expect(connector?.metadata?.approvalDeliveryReady).toBe(true);
  });

  it("does not advertise approval delivery readiness for degraded connectors", () => {
    const records = buildGatewayConnectorRecords({
      integrationConnections: [
        {
          ...createIntegrationConnection("channel", "slack", {
            defaultChannel: "#ops-approvals",
          }),
          lastError: "delivery failed",
        },
      ],
      mcpServers: [
        {
          ...createMcpServer(),
          status: "disconnected",
        },
      ],
      mcpTools: [createMcpTool("server-1", "goatcitadel.approval.remote_action_ready")],
    });

    const integrationConnector = records.find((item) => item.connectorId === "integration:conn-1");
    expect(integrationConnector?.status).toBe("degraded");
    expect(integrationConnector?.capabilities.find((item) => item.id === "approvals")?.enabled).toBe(false);
    expect(integrationConnector?.metadata?.approvalDeliveryReady).toBe(false);

    const mcpConnector = records.find((item) => item.connectorId === "mcp:server-1");
    expect(mcpConnector?.status).toBe("degraded");
    expect(mcpConnector?.capabilities.find((item) => item.id === "approvals")?.enabled).toBe(false);
    expect(mcpConnector?.metadata?.approvalDeliveryReady).toBe(false);
  });

  it("keeps MCP approval delivery disabled when the receiver tool is missing", () => {
    const records = buildGatewayConnectorRecords({
      integrationConnections: [],
      mcpServers: [createMcpServer()],
      mcpTools: [createMcpTool("server-1", "docs.search")],
    });

    const connector = records.find((item) => item.connectorId === "mcp:server-1");
    expect(connector).toBeDefined();
    expect(connector?.capabilities.find((item) => item.id === "approvals")?.enabled).toBe(false);
    expect(connector?.metadata?.approvalDeliveryToolName).toBeUndefined();
    expect(connector?.metadata?.approvalDeliveryReady).toBe(false);
  });
});

function createIntegrationConnection(
  kind: IntegrationConnection["kind"],
  key: IntegrationConnection["key"],
  config: Record<string, unknown> = {},
): IntegrationConnection {
  return {
    connectionId: "conn-1",
    catalogId: `${kind}.${key}`,
    kind,
    key,
    label: "Connection",
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-03-20T10:00:00.000Z",
    updatedAt: "2026-03-20T10:00:00.000Z",
  };
}

function createMcpServer(): McpServerRecord {
  return {
    serverId: "server-1",
    label: "Docs MCP",
    transport: "stdio",
    authType: "none",
    enabled: true,
    status: "connected",
    category: "research",
    trustTier: "restricted",
    costTier: "free",
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "basic",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    createdAt: "2026-03-20T10:00:00.000Z",
    updatedAt: "2026-03-20T10:00:00.000Z",
  };
}

function createMcpTool(serverId: string, toolName: string): McpToolRecord {
  return {
    serverId,
    toolName,
    enabled: true,
    updatedAt: "2026-03-20T10:00:00.000Z",
  };
}
