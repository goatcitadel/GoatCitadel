import type {
  ConnectorCapability,
  ConnectorCapabilityId,
  ConnectorRecord,
  ConnectorType,
  IntegrationConnection,
  McpServerRecord,
} from "@goatcitadel/contracts";

const CONNECTOR_CAPABILITY_VERSION = "v1";

export function buildGatewayConnectorRecords(input: {
  integrationConnections: IntegrationConnection[];
  mcpServers: McpServerRecord[];
}): ConnectorRecord[] {
  return [
    createMissionControlBrowserConnectorRecord(),
    ...input.mcpServers.map(toMcpConnectorRecord),
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
    },
  };
}

function toIntegrationConnectorRecord(connection: IntegrationConnection): ConnectorRecord {
  const isChannel = connection.kind === "channel";
  const approvalDeliveryTarget = resolveIntegrationApprovalDeliveryTarget(connection);
  return {
    connectorId: `integration:${connection.connectionId}`,
    connectorType: "integration_connection",
    label: connection.label,
    sourceId: connection.connectionId,
    status: !connection.enabled
      ? "disabled"
      : connection.lastError
        ? "degraded"
        : connection.status === "connected"
          ? "active"
          : "degraded",
    capabilities: [
      createCapability("health_checks"),
      createCapability("inbound_messages", isChannel),
      createCapability("outbound_messages", isChannel),
      createCapability("interactive_actions", isChannel),
      createCapability("approvals", Boolean(approvalDeliveryTarget)),
    ],
    metadata: {
      catalogId: connection.catalogId,
      kind: connection.kind,
      key: connection.key,
      enabled: connection.enabled,
      connectionStatus: connection.status,
      approvalDeliveryTarget,
    },
    lastSeenAt: connection.lastSyncAt,
    lastError: connection.lastError,
  };
}

function toMcpConnectorRecord(server: McpServerRecord): ConnectorRecord {
  return {
    connectorId: `mcp:${server.serverId}`,
    connectorType: "mcp_server",
    label: server.label,
    sourceId: server.serverId,
    status: !server.enabled
      ? "disabled"
      : server.status === "connected"
        ? "active"
        : "degraded",
    capabilities: [
      createCapability("health_checks"),
      createCapability("interactive_actions"),
      createCapability("approvals"),
      createCapability("outbound_messages", false),
      createCapability("inbound_messages", false),
    ],
    metadata: {
      transport: server.transport,
      authType: server.authType,
      category: server.category,
      trustTier: server.trustTier,
      runtimeStatus: server.status,
      approvalDeliveryToolName: "goatcitadel.approval.remote_action_ready",
    },
    lastSeenAt: server.lastConnectedAt,
    lastError: server.lastError,
  };
}

function resolveIntegrationApprovalDeliveryTarget(connection: IntegrationConnection): string | undefined {
  if (connection.kind !== "channel") {
    return undefined;
  }
  const config = connection.config;
  switch (connection.key) {
    case "slack":
      return readConfigString(config, "defaultChannel");
    case "discord":
      return readConfigString(config, "defaultChannelId");
    case "telegram":
      return readConfigString(config, "defaultChatId");
    case "matrix":
      return readConfigString(config, "defaultRoomId");
    case "google-chat":
      return readConfigString(config, "defaultThreadKey");
    default:
      return readConfigString(config, "target") ?? readConfigString(config, "defaultTarget");
  }
}

function readConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function createCapability(id: ConnectorCapabilityId, enabled = true): ConnectorCapability {
  return {
    id,
    enabled,
    version: CONNECTOR_CAPABILITY_VERSION,
  };
}
