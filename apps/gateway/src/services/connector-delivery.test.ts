import { describe, expect, it, vi } from "vitest";
import type {
  ChannelSendInput,
  ConnectorDeliveryWorkflowPayload,
  ConnectorRecord,
  McpInvokeRequest,
  McpInvokeResponse,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { dispatchConnectorDelivery } from "./connector-delivery.js";

describe("dispatchConnectorDelivery", () => {
  it("sends outbound channel messages through integration connectors", async () => {
    const commsSend = vi.fn(async (_input: ChannelSendInput): Promise<ToolInvokeResult> => ({
      outcome: "executed",
      auditEventId: "audit-1",
      policyReason: "allowed",
      result: { deliveryId: "delivery-1", status: "sent" },
    }));
    const invokeMcpTool = vi.fn(async (_input: McpInvokeRequest): Promise<McpInvokeResponse> => ({
      ok: true,
      output: {},
    }));
    const publishRealtime = vi.fn();

    const result = await dispatchConnectorDelivery(
      createConnector("integration_connection", "integration:channel-1", "channel-1", ["outbound_messages"]),
      createPayload("channel.send", {
        target: "#ops",
        message: "hello from durable delivery",
      }),
      {
        commsSend,
        invokeMcpTool,
        publishRealtime,
      },
    );

    expect(commsSend).toHaveBeenCalledWith({
      connectionId: "channel-1",
      target: "#ops",
      message: "hello from durable delivery",
      attachments: undefined,
      sessionId: undefined,
      agentId: undefined,
      taskId: undefined,
    });
    expect(result).toMatchObject({
      capabilityId: "outbound_messages",
      dispatchKind: "integration_channel_send",
      result: { deliveryId: "delivery-1", status: "sent" },
    });
  });

  it("invokes MCP tools through MCP connectors", async () => {
    const commsSend = vi.fn(async (_input: ChannelSendInput) => ({}));
    const invokeMcpTool = vi.fn(async (_input: McpInvokeRequest): Promise<McpInvokeResponse> => ({
      ok: true,
      output: { toolResult: "ok" },
    }));
    const publishRealtime = vi.fn();

    const result = await dispatchConnectorDelivery(
      createConnector("mcp_server", "mcp:server-1", "server-1", ["interactive_actions"]),
      createPayload("mcp.invoke", {
        toolName: "search.docs",
        arguments: { q: "durable workflows" },
        sessionId: "sess-1",
      }),
      {
        commsSend,
        invokeMcpTool,
        publishRealtime,
      },
    );

    expect(invokeMcpTool).toHaveBeenCalledWith({
      serverId: "server-1",
      toolName: "search.docs",
      arguments: { q: "durable workflows" },
      sessionId: "sess-1",
      agentId: undefined,
      taskId: undefined,
    });
    expect(result).toMatchObject({
      capabilityId: "interactive_actions",
      dispatchKind: "mcp_invoke",
      result: { toolResult: "ok" },
    });
  });

  it("emits realtime events for browser connectors", async () => {
    const commsSend = vi.fn(async (_input: ChannelSendInput) => ({}));
    const invokeMcpTool = vi.fn(async (_input: McpInvokeRequest): Promise<McpInvokeResponse> => ({
      ok: true,
      output: {},
    }));
    const publishRealtime = vi.fn();

    const result = await dispatchConnectorDelivery(
      createConnector("browser", "browser:mission-control", "mission-control-web", ["interactive_actions"]),
      createPayload("realtime.emit", {
        eventType: "approval_delivery_requested",
        source: "approvals",
        payload: { approvalId: "approval-1" },
      }),
      {
        commsSend,
        invokeMcpTool,
        publishRealtime,
      },
    );

    expect(publishRealtime).toHaveBeenCalledWith("approval_delivery_requested", "approvals", {
      connectorId: "browser:mission-control",
      action: "realtime.emit",
      approvalId: "approval-1",
    });
    expect(result).toMatchObject({
      capabilityId: "interactive_actions",
      dispatchKind: "browser_realtime",
    });
  });

  it("rejects action and capability mismatches", async () => {
    const commsSend = vi.fn(async (_input: ChannelSendInput) => ({}));
    const invokeMcpTool = vi.fn(async (_input: McpInvokeRequest): Promise<McpInvokeResponse> => ({
      ok: true,
      output: {},
    }));
    const publishRealtime = vi.fn();

    await expect(() =>
      dispatchConnectorDelivery(
        createConnector("integration_connection", "integration:calendar-1", "calendar-1", ["health_checks"]),
        createPayload("channel.send", {
          target: "#ops",
          message: "blocked",
        }),
        {
          commsSend,
          invokeMcpTool,
          publishRealtime,
        },
      )).rejects.toThrow("capability outbound_messages is unavailable");
  });
});

function createConnector(
  connectorType: ConnectorRecord["connectorType"],
  connectorId: string,
  sourceId: string,
  enabledCapabilityIds: Array<ConnectorRecord["capabilities"][number]["id"]>,
): ConnectorRecord {
  return {
    connectorId,
    connectorType,
    label: connectorId,
    sourceId,
    status: "active",
    capabilities: enabledCapabilityIds.map((id) => ({
      id,
      enabled: true,
      version: "v1",
    })),
    metadata: {},
  };
}

function createPayload(
  action: ConnectorDeliveryWorkflowPayload["action"],
  payload?: Record<string, unknown>,
): ConnectorDeliveryWorkflowPayload {
  return {
    version: "connector.delivery.v1",
    connectorId: "unused-by-helper",
    action,
    payload,
  };
}
