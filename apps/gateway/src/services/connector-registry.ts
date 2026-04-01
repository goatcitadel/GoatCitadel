import type {
  ConnectorCapability,
  ConnectorCapabilityId,
  ConnectorRecord,
  ConnectorType,
  IntegrationConnection,
  McpToolRecord,
  McpServerRecord,
} from "@goatcitadel/contracts";
import { MCP_APPROVAL_DELIVERY_TOOL_NAME } from "./mcp-approval-inbox.js";
import { resolveChannelConfigTarget } from "./channel-config.js";
import { describeChannelCapabilities, describeChannelFeatureMetadata } from "./channel-diagnostics.js";

const CONNECTOR_CAPABILITY_VERSION = "v1";

export function buildGatewayConnectorRecords(input: {
  integrationConnections: IntegrationConnection[];
  mcpServers: McpServerRecord[];
  mcpTools: McpToolRecord[];
}): ConnectorRecord[] {
  return [
    createMissionControlBrowserConnectorRecord(),
    ...input.mcpServers.map((server) =>
      toMcpConnectorRecord(
        server,
        input.mcpTools.filter((tool) => tool.serverId === server.serverId && tool.enabled),
      ),
    ),
    ...input.integrationConnections.map(toIntegrationConnectorRecord),
  ];
}

export function filterConnectorRecords(
  records: ConnectorRecord[],
  connectorType?: ConnectorType,
): ConnectorRecord[] {
  if (!connectorType) {
    return records;
  }
  return records.filter((record) => record.connectorType === connectorType);
}

function createMissionControlBrowserConnectorRecord(): ConnectorRecord {
  return {
    connectorId: "browser:mission-control",
    connectorType: "browser",
    label: "Mission Control Browser",
    sourceId: "mission-control-web",
    status: "active",
    capabilities: [
      createCapability("inbound_messages"),
      createCapability("outbound_messages"),
      createCapability("approvals"),
      createCapability("interactive_actions"),
    ],
    metadata: {
      surface: "mission-control-web",
      approvalDeliveryMode: "browser_realtime",
      approvalDeliveryReady: true,
      approvalDeliveryReason: "Mission Control listens for approval_remote_action_ready and can resolve remote approval tokens.",
    },
  };
}

function toIntegrationConnectorRecord(connection: IntegrationConnection): ConnectorRecord {
  const isChannel = connection.kind === "channel";
  const channelFeatures = isChannel
    ? describeChannelFeatureMetadata(connection.key, connection.config)
    : undefined;
  const status = !connection.enabled
    ? "disabled"
    : connection.lastError
      ? "degraded"
      : connection.status === "connected"
        ? "active"
        : "degraded";
  const approvalDeliveryTarget = resolveIntegrationApprovalDeliveryTarget(connection);
  const approvalDeliveryReady = status === "active" && Boolean(approvalDeliveryTarget);
  return {
    connectorId: `integration:${connection.connectionId}`,
    connectorType: "integration_connection",
    label: connection.label,
    sourceId: connection.connectionId,
    status,
    capabilities: [
      createCapability("health_checks"),
      createCapability("inbound_messages", isChannel),
      createCapability("outbound_messages", isChannel),
      createCapability(
        "interactive_actions",
        isChannel && (channelFeatures?.supportedDeliveryActions.some((action) => action !== "channel.send") ?? false),
      ),
      createCapability("approvals", approvalDeliveryReady),
    ],
    metadata: {
      catalogId: connection.catalogId,
      kind: connection.kind,
      key: connection.key,
      enabled: connection.enabled,
      connectionStatus: connection.status,
      approvalDeliveryMode: isChannel ? "integration_channel_send" : undefined,
      approvalDeliveryReady,
      approvalDeliveryReason: describeIntegrationApprovalDelivery(connection, approvalDeliveryTarget),
      approvalDeliveryTarget,
      channelCapabilities: channelFeatures && connection.kind === "channel"
        ? describeChannelCapabilities(connection.key, connection.config)
        : undefined,
      supportedDeliveryActions: channelFeatures?.supportedDeliveryActions,
      supportedAttachmentSources: channelFeatures?.supportedAttachmentSources,
      channelSupportNotes: channelFeatures?.supportNotes,
      setupDiagnostics: channelFeatures?.setupDiagnostics,
      setupReady: channelFeatures?.setupReady ?? (channelFeatures?.setupDiagnostics.length ?? 0) === 0,
    },
    lastSeenAt: connection.lastSyncAt,
    lastError: connection.lastError,
  };
}

function toMcpConnectorRecord(server: McpServerRecord, tools: McpToolRecord[]): ConnectorRecord {
  const status = !server.enabled
    ? "disabled"
    : server.status === "connected"
      ? "active"
      : "degraded";
  const approvalDeliveryTool = tools.find((tool) => tool.toolName === MCP_APPROVAL_DELIVERY_TOOL_NAME);
  const approvalDeliveryReady = status === "active" && Boolean(approvalDeliveryTool);
  return {
    connectorId: `mcp:${server.serverId}`,
    connectorType: "mcp_server",
    label: server.label,
    sourceId: server.serverId,
    status,
    capabilities: [
      createCapability("health_checks"),
      createCapability("interactive_actions"),
      createCapability("approvals", approvalDeliveryReady),
      createCapability("outbound_messages", false),
      createCapability("inbound_messages", false),
    ],
    metadata: {
      transport: server.transport,
      authType: server.authType,
      category: server.category,
      trustTier: server.trustTier,
      runtimeStatus: server.status,
      approvalDeliveryMode: "mcp_invoke",
      approvalDeliveryReady,
      approvalDeliveryReason: approvalDeliveryReady
        ? `Tool ${MCP_APPROVAL_DELIVERY_TOOL_NAME} is enabled on this MCP server.`
        : `Tool ${MCP_APPROVAL_DELIVERY_TOOL_NAME} is not enabled on this MCP server.`,
      approvalDeliveryToolName: approvalDeliveryTool?.toolName,
    },
    lastSeenAt: server.lastConnectedAt,
    lastError: server.lastError,
  };
}

function resolveIntegrationApprovalDeliveryTarget(connection: IntegrationConnection): string | undefined {
  if (connection.kind !== "channel") {
    return undefined;
  }
  return resolveChannelConfigTarget(connection.key, connection.config);
}

function describeIntegrationApprovalDelivery(
  connection: IntegrationConnection,
  approvalDeliveryTarget: string | undefined,
): string {
  if (connection.kind !== "channel") {
    return "Only channel integrations can receive approval deliveries.";
  }
  if (!connection.enabled) {
    return "Connection is disabled.";
  }
  if (connection.status !== "connected") {
    return `Connection status is ${connection.status}.`;
  }
  if (approvalDeliveryTarget) {
    return `Approval deliveries will be sent with channel.send to ${approvalDeliveryTarget}.`;
  }
  switch (connection.key) {
    case "slack":
      return "Set config.defaultChannel to enable approval delivery.";
    case "discord":
      return "Set config.defaultChannelId to enable approval delivery.";
    case "telegram":
      return "Set config.defaultChatId to enable approval delivery.";
    case "google-chat":
      return "Set config.defaultThreadKey to enable approval delivery.";
    case "whatsapp":
      return "Set config.defaultTarget or config.defaultRecipient to enable approval delivery.";
    case "signal":
      return "Set config.defaultRecipient or config.defaultTarget to enable approval delivery.";
    case "imessage":
      return "Set config.defaultHandle or config.defaultTarget to enable approval delivery.";
    case "mattermost":
      return "Set config.defaultChannel or config.defaultTarget to enable approval delivery.";
    case "nextcloud-talk":
      return "Set config.defaultRoomId or config.defaultConversationId to enable approval delivery.";
    case "line":
      return "Set config.defaultTarget (or config.defaultUserId / config.defaultGroupId / config.defaultRoomId) to enable approval delivery.";
    case "zalo":
    case "zalouser":
      return "Set config.defaultRecipientId or config.defaultTarget to enable approval delivery.";
    default:
      return "Set config.target or config.defaultTarget to enable approval delivery.";
  }
}

function createCapability(id: ConnectorCapabilityId, enabled = true): ConnectorCapability {
  return {
    id,
    enabled,
    version: CONNECTOR_CAPABILITY_VERSION,
  };
}
