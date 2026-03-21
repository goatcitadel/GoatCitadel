import { describe, expect, it } from "vitest";
import type { ApprovalRequest, ConnectorRecord } from "@goatcitadel/contracts";
import { buildApprovalRemoteTokenConnectorDeliveryPayload } from "./approval-connector-delivery.js";

describe("buildApprovalRemoteTokenConnectorDeliveryPayload", () => {
  it("builds browser delivery payloads for active approval-capable mission control connectors", () => {
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector("browser", "active", ["approvals", "interactive_actions"]),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });

    expect(payload).toMatchObject({
      version: "connector.delivery.v1",
      connectorId: "browser:mission-control",
      connectorType: "browser",
      action: "realtime.emit",
      correlationId: "apr_123",
      payload: {
        eventType: "approval_remote_action_ready",
        source: "approvals",
        payload: {
          approvalId: "apr_123",
          tokenId: "rat_123",
          token: "grat_token",
          actionType: "approval.resolve",
          expiresAt: "2026-03-20T12:00:00.000Z",
        },
      },
    });
  });

  it("builds integration channel delivery payloads when a default target is available", () => {
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector(
        "integration_connection",
        "active",
        ["approvals", "outbound_messages"],
        {
          approvalDeliveryTarget: "#ops-approvals",
        },
      ),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });

    expect(payload).toMatchObject({
      version: "connector.delivery.v1",
      connectorId: "integration:channel-1",
      connectorType: "integration_connection",
      action: "channel.send",
      correlationId: "apr_123",
      payload: {
        target: "#ops-approvals",
      },
    });
    expect(payload?.payload?.message).toContain("GoatCitadel approval action requested.");
    expect(payload?.payload?.message).toContain("Action token: grat_token");
    expect(payload?.payload?.message).toContain("Resolve via POST /api/v1/approvals/remote-resolve");
  });

  it("builds MCP invoke payloads for approval-capable MCP connectors", () => {
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector("mcp_server", "active", ["approvals", "interactive_actions"]),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });

    expect(payload).toMatchObject({
      version: "connector.delivery.v1",
      connectorId: "mcp:server-1",
      connectorType: "mcp_server",
      action: "mcp.invoke",
      correlationId: "apr_123",
      payload: {
        toolName: "goatcitadel.approval.remote_action_ready",
        arguments: {
          approvalId: "apr_123",
          tokenId: "rat_123",
          token: "grat_token",
          actionType: "approval.resolve",
          expiresAt: "2026-03-20T12:00:00.000Z",
        },
      },
    });
  });

  it("skips connectors without the required delivery capabilities or metadata", () => {
    expect(buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector("mcp_server", "active", ["approvals", "interactive_actions"]),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    })).toBeDefined();

    expect(buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector("browser", "active", ["approvals"]),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    })).toBeUndefined();

    expect(buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector("integration_connection", "active", ["approvals", "outbound_messages"]),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    })).toBeUndefined();

    expect(buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector("browser", "degraded", ["approvals", "interactive_actions"]),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    })).toBeUndefined();
  });
});

function createApproval(): ApprovalRequest {
  return {
    approvalId: "apr_123",
    kind: "tool.invoke",
    riskLevel: "danger",
    status: "pending",
    payload: { toolName: "fs.write" },
    preview: { summary: "Write file" },
    createdAt: "2026-03-20T11:00:00.000Z",
    explanationStatus: "not_requested",
  };
}

function createConnector(
  connectorType: ConnectorRecord["connectorType"],
  status: ConnectorRecord["status"],
  capabilityIds: Array<ConnectorRecord["capabilities"][number]["id"]>,
  metadata: Record<string, unknown> = {},
): ConnectorRecord {
  return {
    connectorId: connectorType === "browser"
      ? "browser:mission-control"
      : connectorType === "mcp_server"
        ? "mcp:server-1"
        : "integration:channel-1",
    connectorType,
    label: "Connector",
    sourceId: connectorType === "browser"
      ? "mission-control-web"
      : connectorType === "mcp_server"
        ? "server-1"
        : "channel-1",
    status,
    capabilities: capabilityIds.map((id) => ({
      id,
      enabled: true,
      version: "v1",
    })),
    metadata,
  };
}
