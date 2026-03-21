export type ConnectorType =
  | "browser"
  | "mcp_server"
  | "integration_connection";

export type ConnectorCapabilityId =
  | "inbound_messages"
  | "outbound_messages"
  | "approvals"
  | "health_checks"
  | "interactive_actions";

export interface ConnectorCapability {
  id: ConnectorCapabilityId;
  version: string;
  enabled: boolean;
}

export interface ConnectorRecord {
  connectorId: string;
  connectorType: ConnectorType;
  label: string;
  sourceId: string;
  status: "active" | "disabled" | "degraded";
  capabilities: ConnectorCapability[];
  metadata?: Record<string, unknown>;
  lastSeenAt?: string;
  lastError?: string;
}

export interface IConnector {
  readonly connectorId: string;
  readonly connectorType: ConnectorType;
  readonly capabilities: ConnectorCapability[];
}
