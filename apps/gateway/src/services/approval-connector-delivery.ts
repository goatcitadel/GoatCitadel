import type {
  ApprovalRequest,
  ConnectorDeliveryWorkflowPayload,
  ConnectorCapabilityId,
  ConnectorRecord,
} from "@goatcitadel/contracts";

const MCP_APPROVAL_DELIVERY_TOOL_NAME = "goatcitadel.approval.remote_action_ready";

export function buildApprovalRemoteTokenConnectorDeliveryPayload(input: {
  approval: ApprovalRequest;
  connector: ConnectorRecord;
  token: string;
  tokenId: string;
  expiresAt: string;
}): ConnectorDeliveryWorkflowPayload | undefined {
  if (input.connector.status !== "active") {
    return undefined;
  }
  switch (input.connector.connectorType) {
    case "browser":
      if (!hasEnabledCapability(input.connector, "approvals") || !hasEnabledCapability(input.connector, "interactive_actions")) {
        return undefined;
      }
      return {
        version: "connector.delivery.v1",
        connectorId: input.connector.connectorId,
        connectorType: input.connector.connectorType,
        action: "realtime.emit",
        correlationId: input.approval.approvalId,
        payload: {
          eventType: "approval_remote_action_ready",
          source: "approvals",
          payload: buildApprovalDeliveryEnvelope(input),
        },
      };

    case "integration_connection": {
      if (!hasEnabledCapability(input.connector, "approvals") || !hasEnabledCapability(input.connector, "outbound_messages")) {
        return undefined;
      }
      const target = readMetadataString(input.connector, "approvalDeliveryTarget");
      if (!target) {
        return undefined;
      }
      return {
        version: "connector.delivery.v1",
        connectorId: input.connector.connectorId,
        connectorType: input.connector.connectorType,
        action: "channel.send",
        correlationId: input.approval.approvalId,
        payload: {
          target,
          message: buildIntegrationApprovalDeliveryMessage(input),
        },
      };
    }

    case "mcp_server": {
      if (!hasEnabledCapability(input.connector, "approvals") || !hasEnabledCapability(input.connector, "interactive_actions")) {
        return undefined;
      }
      return {
        version: "connector.delivery.v1",
        connectorId: input.connector.connectorId,
        connectorType: input.connector.connectorType,
        action: "mcp.invoke",
        correlationId: input.approval.approvalId,
        payload: {
          toolName: readMetadataString(input.connector, "approvalDeliveryToolName") ?? MCP_APPROVAL_DELIVERY_TOOL_NAME,
          arguments: buildApprovalDeliveryEnvelope(input),
        },
      };
    }

    default:
      return undefined;
  }
}

function hasEnabledCapability(connector: ConnectorRecord, capabilityId: ConnectorCapabilityId): boolean {
  return connector.capabilities.some((item) => item.id === capabilityId && item.enabled);
}

function readMetadataString(connector: ConnectorRecord, key: string): string | undefined {
  const value = connector.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildApprovalDeliveryEnvelope(input: {
  approval: ApprovalRequest;
  token: string;
  tokenId: string;
  expiresAt: string;
}): Record<string, unknown> {
  return {
    approvalId: input.approval.approvalId,
    kind: input.approval.kind,
    riskLevel: input.approval.riskLevel,
    status: input.approval.status,
    preview: input.approval.preview,
    tokenId: input.tokenId,
    token: input.token,
    actionType: "approval.resolve",
    expiresAt: input.expiresAt,
  };
}

function buildIntegrationApprovalDeliveryMessage(input: {
  approval: ApprovalRequest;
  token: string;
  tokenId: string;
  expiresAt: string;
}): string {
  const summary = summarizeApprovalPreview(input.approval.preview);
  const lines = [
    "GoatCitadel approval action requested.",
    `Approval ID: ${input.approval.approvalId}`,
    `Kind: ${input.approval.kind}`,
    `Risk: ${input.approval.riskLevel}`,
    `Status: ${input.approval.status}`,
    summary ? `Preview: ${summary}` : undefined,
    `Action token ID: ${input.tokenId}`,
    `Action token: ${input.token}`,
    `Expires at: ${input.expiresAt}`,
    "Resolve via POST /api/v1/approvals/remote-resolve with { token, decision }.",
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function summarizeApprovalPreview(preview: Record<string, unknown>): string | undefined {
  const summary = preview.summary;
  if (typeof summary === "string" && summary.trim().length > 0) {
    return summary.trim();
  }
  const serialized = JSON.stringify(preview);
  if (!serialized || serialized === "{}") {
    return undefined;
  }
  return serialized.length <= 180 ? serialized : `${serialized.slice(0, 177)}...`;
}
