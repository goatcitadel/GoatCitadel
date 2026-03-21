import { describe, expect, it } from "vitest";
import type { IntegrationConnection, McpServerRecord, McpToolRecord } from "@goatcitadel/contracts";
import { buildGatewayConnectorRecords } from "./connector-registry.js";

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
      integrationConnections: [
        createIntegrationConnection("channel", "slack"),
      ],
      mcpServers: [],
      mcpTools: [],
    });

    const connector = records.find((item) => item.connectorId === "integration:conn-1");
    expect(connector).toBeDefined();
    expect(connector?.capabilities.find((item) => item.id === "approvals")?.enabled).toBe(false);
    expect(connector?.metadata?.approvalDeliveryTarget).toBeUndefined();
    expect(connector?.metadata?.approvalDeliveryReady).toBe(false);
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
