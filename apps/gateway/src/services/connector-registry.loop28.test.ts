import { describe, expect, it } from "vitest";
import type { IntegrationConnection, McpServerRecord, McpToolRecord } from "@goatcitadel/contracts";
import { MCP_APPROVAL_DELIVERY_TOOL_NAME } from "./mcp-approval-inbox.js";
import { buildGatewayConnectorRecords, filterConnectorRecords } from "./connector-registry.js";

describe("connector registry loop28 coverage", () => {
  it("builds browser, MCP, and channel connector records with approval delivery posture", () => {
    const records = buildGatewayConnectorRecords({
      mcpServers: [
        mcpServer({ serverId: "srv-active", enabled: true, status: "connected" }),
        mcpServer({ serverId: "srv-disabled", enabled: false, status: "connected" }),
        mcpServer({ serverId: "srv-error", enabled: true, status: "error", lastError: "boot failed" }),
      ],
      mcpTools: [
        mcpTool({
          serverId: "srv-active",
          toolName: MCP_APPROVAL_DELIVERY_TOOL_NAME,
          enabled: true,
        }),
        mcpTool({
          serverId: "srv-disabled",
          toolName: MCP_APPROVAL_DELIVERY_TOOL_NAME,
          enabled: true,
        }),
      ],
      integrationConnections: [
        channelConnection({
          connectionId: "slack-ready",
          key: "slack",
          status: "connected",
          enabled: true,
          config: { defaultChannel: "#ops" },
        }),
        channelConnection({
          connectionId: "telegram-missing-target",
          key: "telegram",
          status: "connected",
          enabled: true,
          config: {},
        }),
        channelConnection({
          connectionId: "disabled-discord",
          key: "discord",
          status: "connected",
          enabled: false,
          config: { defaultChannelId: "123456789012345678" },
        }),
        channelConnection({
          connectionId: "errored-line",
          key: "line",
          status: "connected",
          enabled: true,
          lastError: "signature mismatch",
          config: { defaultTarget: "Utarget" },
        }),
        {
          ...channelConnection({
            connectionId: "oauth-calendar",
            key: "google-calendar",
            status: "connected",
            enabled: true,
            config: {},
          }),
          kind: "oauth",
        } as IntegrationConnection,
      ],
    });

    expect(records[0]).toMatchObject({
      connectorId: "browser:mission-control",
      connectorType: "browser",
      status: "active",
      metadata: {
        approvalDeliveryReady: true,
      },
    });

    expect(records.find((record) => record.connectorId === "mcp:srv-active")).toMatchObject({
      status: "active",
      metadata: {
        approvalDeliveryReady: true,
        approvalDeliveryToolName: MCP_APPROVAL_DELIVERY_TOOL_NAME,
      },
    });
    expect(records.find((record) => record.connectorId === "mcp:srv-disabled")).toMatchObject({
      status: "disabled",
      metadata: {
        approvalDeliveryReady: false,
      },
    });
    expect(records.find((record) => record.connectorId === "mcp:srv-error")).toMatchObject({
      status: "degraded",
      lastError: "boot failed",
      metadata: {
        approvalDeliveryReady: false,
      },
    });

    expect(records.find((record) => record.connectorId === "integration:slack-ready")).toMatchObject({
      status: "active",
      metadata: {
        approvalDeliveryTarget: "#ops",
        approvalDeliveryReason: "Approval deliveries will be sent with channel.send to #ops.",
        setupReady: false,
      },
    });
    expect(records.find((record) => record.connectorId === "integration:telegram-missing-target")).toMatchObject({
      status: "active",
      metadata: {
        approvalDeliveryReady: false,
        approvalDeliveryReason: "Set config.defaultChatId to enable approval delivery.",
      },
    });
    expect(records.find((record) => record.connectorId === "integration:disabled-discord")).toMatchObject({
      status: "disabled",
      metadata: {
        approvalDeliveryReady: false,
        approvalDeliveryReason: "Connection is disabled.",
      },
    });
    expect(records.find((record) => record.connectorId === "integration:errored-line")).toMatchObject({
      status: "degraded",
      lastError: "signature mismatch",
      metadata: {
        approvalDeliveryReason: "Approval deliveries will be sent with channel.send to Utarget.",
      },
    });
    expect(records.find((record) => record.connectorId === "integration:oauth-calendar")).toMatchObject({
      metadata: {
        approvalDeliveryReady: false,
        approvalDeliveryReason: "Only channel integrations can receive approval deliveries.",
      },
    });
    expect(filterConnectorRecords(records)).toHaveLength(records.length);
    expect(filterConnectorRecords(records, "mcp_server").map((record) => record.connectorId)).toEqual([
      "mcp:srv-active",
      "mcp:srv-disabled",
      "mcp:srv-error",
    ]);
  });

  it("reports channel-specific target setup hints for every supported approval delivery channel", () => {
    const channels = [
      ["whatsapp", "Set config.defaultTarget or config.defaultRecipient to enable approval delivery."],
      ["signal", "Set config.defaultRecipient or config.defaultTarget to enable approval delivery."],
      ["imessage", "Set config.defaultHandle or config.defaultTarget to enable approval delivery."],
      ["mattermost", "Set config.defaultChannel or config.defaultTarget to enable approval delivery."],
      ["nextcloud-talk", "Set config.defaultRoomId or config.defaultConversationId to enable approval delivery."],
      [
        "line",
        "Set config.defaultTarget (or config.defaultUserId / config.defaultGroupId / config.defaultRoomId) to enable approval delivery.",
      ],
      ["zalo", "Set config.defaultRecipientId or config.defaultTarget to enable approval delivery."],
      ["zalouser", "Set config.defaultRecipientId or config.defaultTarget to enable approval delivery."],
      ["custom-channel", "Set config.target or config.defaultTarget to enable approval delivery."],
    ] as const;

    const records = buildGatewayConnectorRecords({
      mcpServers: [],
      mcpTools: [],
      integrationConnections: channels.map(([key]) =>
        channelConnection({
          connectionId: `conn-${key}`,
          key,
          enabled: true,
          status: "connected",
          config: {},
        }),
      ),
    });

    for (const [key, reason] of channels) {
      expect(records.find((record) => record.connectorId === `integration:conn-${key}`)).toMatchObject({
        metadata: {
          approvalDeliveryReady: false,
          approvalDeliveryReason: reason,
        },
      });
    }
  });
});

function channelConnection(input: {
  connectionId: string;
  key: string;
  status: IntegrationConnection["status"];
  enabled: boolean;
  config: Record<string, unknown>;
  lastError?: string;
}): IntegrationConnection {
  return {
    connectionId: input.connectionId,
    catalogId: `channel.${input.key}`,
    kind: "channel",
    key: input.key,
    label: input.connectionId,
    enabled: input.enabled,
    status: input.status,
    config: input.config,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    lastSyncAt: "2026-05-15T00:01:00.000Z",
    lastError: input.lastError,
  } as IntegrationConnection;
}

function mcpServer(input: Partial<McpServerRecord> & Pick<McpServerRecord, "serverId">): McpServerRecord {
  return {
    serverId: input.serverId,
    label: input.serverId,
    transport: "stdio",
    command: "node",
    args: [],
    url: undefined,
    authType: "none",
    enabled: input.enabled ?? true,
    status: input.status ?? "connected",
    category: "productivity",
    trustTier: "trusted",
    costTier: "free",
    policy: {},
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    lastConnectedAt: "2026-05-15T00:00:05.000Z",
    lastError: input.lastError,
  } as McpServerRecord;
}

function mcpTool(input: Partial<McpToolRecord> & Pick<McpToolRecord, "serverId" | "toolName">): McpToolRecord {
  return {
    serverId: input.serverId,
    toolName: input.toolName,
    enabled: input.enabled ?? true,
    description: "Approval delivery",
    inputSchema: {},
    lastSeenAt: "2026-05-15T00:00:05.000Z",
  } as McpToolRecord;
}
