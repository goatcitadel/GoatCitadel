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
    const commsSend = vi.fn(
      async (_input: ChannelSendInput): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "audit-1",
        policyReason: "allowed",
        result: { deliveryId: "delivery-1", status: "sent" },
      }),
    );
    const commsReact = vi.fn();
    const commsUnsend = vi.fn();
    const invokeMcpTool = vi.fn(
      async (_input: McpInvokeRequest): Promise<McpInvokeResponse> => ({
        ok: true,
        output: {},
      }),
    );
    const publishRealtime = vi.fn();

    const result = await dispatchConnectorDelivery(
      createConnector("integration_connection", "integration:channel-1", "channel-1", ["outbound_messages"]),
      createPayload("channel.send", {
        target: "#ops",
        message: "hello from durable delivery",
      }),
      {
        commsSend,
        commsReply: vi.fn(async () => ({})),
        commsReact,
        commsUnsend,
        commsTyping: vi.fn(async () => createTypingResult()),
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

  it("normalizes Discord connector targets before dispatch", async () => {
    const commsSend = vi.fn(
      async (_input: ChannelSendInput): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "audit-1",
        policyReason: "allowed",
        result: { deliveryId: "delivery-1", status: "sent" },
      }),
    );

    await dispatchConnectorDelivery(
      createConnector("integration_connection", "integration:discord-1", "discord-1", ["outbound_messages"], {
        key: "discord",
      }),
      createPayload("channel.send", {
        target: "<#1234567890>",
        message: "hello from durable delivery",
      }),
      {
        commsSend,
        commsReply: vi.fn(async () => ({})),
        commsReact: vi.fn(),
        commsUnsend: vi.fn(),
        commsTyping: vi.fn(async () => createTypingResult()),
        invokeMcpTool: vi.fn(),
        publishRealtime: vi.fn(),
      },
    );

    expect(commsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "discord-1",
        target: "channel:1234567890",
      }),
    );
  });

  it("normalizes WhatsApp direct targets before dispatch", async () => {
    const commsSend = vi.fn(
      async (_input: ChannelSendInput): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "audit-1",
        policyReason: "allowed",
        result: { deliveryId: "delivery-1", status: "sent" },
      }),
    );

    await dispatchConnectorDelivery(
      createConnector("integration_connection", "integration:whatsapp-1", "whatsapp-1", ["outbound_messages"], {
        key: "whatsapp",
      }),
      createPayload("channel.send", {
        target: "whatsapp:15551234567@s.whatsapp.net",
        message: "hello from durable delivery",
      }),
      {
        commsSend,
        commsReply: vi.fn(async () => ({})),
        commsReact: vi.fn(),
        commsUnsend: vi.fn(),
        commsTyping: vi.fn(async () => createTypingResult()),
        invokeMcpTool: vi.fn(),
        publishRealtime: vi.fn(),
      },
    );

    expect(commsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "whatsapp-1",
        target: "+15551234567",
      }),
    );
  });

  it("rejects invalid WhatsApp JID-shaped targets", async () => {
    const commsSend = vi.fn(
      async (_input: ChannelSendInput): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "audit-1",
        policyReason: "allowed",
        result: { deliveryId: "delivery-1", status: "sent" },
      }),
    );

    await expect(() =>
      dispatchConnectorDelivery(
        createConnector("integration_connection", "integration:whatsapp-1", "whatsapp-1", ["outbound_messages"], {
          key: "whatsapp",
        }),
        createPayload("channel.send", {
          target: "group:120363123456789@g.us",
          message: "blocked",
        }),
        {
          commsSend,
          commsReply: vi.fn(async () => ({})),
          commsReact: vi.fn(),
          commsUnsend: vi.fn(),
          commsTyping: vi.fn(async () => createTypingResult()),
          invokeMcpTool: vi.fn(),
          publishRealtime: vi.fn(),
        },
      ),
    ).rejects.toThrow("payload.target must be a WhatsApp E.164 number");
  });

  it("invokes MCP tools through MCP connectors", async () => {
    const commsSend = vi.fn(async (_input: ChannelSendInput) => ({}));
    const commsReply = vi.fn(async () => ({}));
    const commsReact = vi.fn(async () => ({}));
    const commsUnsend = vi.fn(async () => ({}));
    const commsTyping = vi.fn(async () => createTypingResult());
    const invokeMcpTool = vi.fn(
      async (_input: McpInvokeRequest): Promise<McpInvokeResponse> => ({
        ok: true,
        output: { toolResult: "ok" },
      }),
    );
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
        commsReply,
        commsReact,
        commsUnsend,
        commsTyping,
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
    const commsReply = vi.fn(async () => ({}));
    const commsReact = vi.fn(async () => ({}));
    const commsUnsend = vi.fn(async () => ({}));
    const commsTyping = vi.fn(async () => createTypingResult());
    const invokeMcpTool = vi.fn(
      async (_input: McpInvokeRequest): Promise<McpInvokeResponse> => ({
        ok: true,
        output: {},
      }),
    );
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
        commsReply,
        commsReact,
        commsUnsend,
        commsTyping,
        invokeMcpTool,
        publishRealtime,
      },
    );

    expect(publishRealtime).toHaveBeenCalledWith(
      "approval_delivery_requested",
      "approvals",
      {
        connectorId: "browser:mission-control",
        action: "realtime.emit",
        approvalId: "approval-1",
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          connectorId: "browser:mission-control",
          approvalId: "approval-1",
        },
      },
    );
    expect(result).toMatchObject({
      capabilityId: "interactive_actions",
      dispatchKind: "browser_realtime",
    });
  });

  it("rejects action and capability mismatches", async () => {
    const commsSend = vi.fn(async (_input: ChannelSendInput) => ({}));
    const commsReply = vi.fn(async () => ({}));
    const commsReact = vi.fn(async () => ({}));
    const commsUnsend = vi.fn(async () => ({}));
    const commsTyping = vi.fn(async () => createTypingResult());
    const invokeMcpTool = vi.fn(
      async (_input: McpInvokeRequest): Promise<McpInvokeResponse> => ({
        ok: true,
        output: {},
      }),
    );
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
          commsReply,
          commsReact,
          commsUnsend,
          commsTyping,
          invokeMcpTool,
          publishRealtime,
        },
      ),
    ).rejects.toThrow("capability outbound_messages is unavailable");
  });

  it("routes interactive channel reactions through integration connectors", async () => {
    const commsReact = vi.fn(
      async () =>
        ({
          outcome: "executed",
          auditEventId: "audit-react",
          policyReason: "allowed",
          result: { deliveryId: "delivery-react", status: "sent" },
        }) satisfies ToolInvokeResult,
    );

    const result = await dispatchConnectorDelivery(
      createConnector("integration_connection", "integration:imessage-1", "imessage-1", ["interactive_actions"], {
        key: "imessage",
      }),
      createPayload("channel.react", {
        target: "imessage:+15551234567",
        messageId: "msg-123",
        reaction: "love",
        partIndex: 1,
      }),
      {
        commsSend: vi.fn(),
        commsReply: vi.fn(async () => ({})),
        commsReact,
        commsUnsend: vi.fn(),
        commsTyping: vi.fn(async () => createTypingResult()),
        invokeMcpTool: vi.fn(),
        publishRealtime: vi.fn(),
      },
    );

    expect(commsReact).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "imessage-1",
        target: "imessage:+15551234567",
        messageId: "msg-123",
        reaction: "love",
        partIndex: 1,
      }),
    );
    expect(result).toMatchObject({
      capabilityId: "interactive_actions",
      dispatchKind: "integration_channel_action",
    });
  });

  it("routes interactive channel unsend requests through integration connectors", async () => {
    const commsUnsend = vi.fn(
      async () =>
        ({
          outcome: "executed",
          auditEventId: "audit-unsend",
          policyReason: "allowed",
          result: { deliveryId: "delivery-unsend", status: "sent" },
        }) satisfies ToolInvokeResult,
    );

    const result = await dispatchConnectorDelivery(
      createConnector("integration_connection", "integration:imessage-1", "imessage-1", ["interactive_actions"], {
        key: "imessage",
      }),
      createPayload("channel.unsend", {
        messageId: "msg-456",
        partIndex: 0,
      }),
      {
        commsSend: vi.fn(),
        commsReply: vi.fn(async () => ({})),
        commsReact: vi.fn(),
        commsUnsend,
        commsTyping: vi.fn(async () => createTypingResult()),
        invokeMcpTool: vi.fn(),
        publishRealtime: vi.fn(),
      },
    );

    expect(commsUnsend).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "imessage-1",
        messageId: "msg-456",
        partIndex: 0,
      }),
    );
    expect(result).toMatchObject({
      capabilityId: "interactive_actions",
      dispatchKind: "integration_channel_action",
    });
  });

  it("routes explicit channel replies through integration connectors", async () => {
    const commsReply = vi.fn(
      async () =>
        ({
          outcome: "executed",
          auditEventId: "audit-reply",
          policyReason: "allowed",
          result: { deliveryId: "delivery-reply", status: "sent" },
        }) satisfies ToolInvokeResult,
    );

    const result = await dispatchConnectorDelivery(
      createConnector("integration_connection", "integration:slack-1", "slack-1", ["outbound_messages"], {
        key: "slack",
      }),
      createPayload("channel.reply", {
        target: "#ops",
        replyToMessageId: "1712345678.000200",
        message: "reply body",
      }),
      {
        commsSend: vi.fn(),
        commsReply,
        commsReact: vi.fn(),
        commsUnsend: vi.fn(),
        commsTyping: vi.fn(async () => createTypingResult()),
        invokeMcpTool: vi.fn(),
        publishRealtime: vi.fn(),
      },
    );

    expect(commsReply).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "slack-1",
        target: "#ops",
        replyToMessageId: "1712345678.000200",
        message: "reply body",
      }),
    );
    expect(result).toMatchObject({
      capabilityId: "outbound_messages",
      dispatchKind: "integration_channel_send",
    });
  });

  it("routes typing indicators through interactive channel actions", async () => {
    const commsTyping = vi.fn(async () => ({
      channelKey: "discord",
      connectionId: "discord-1",
      target: "channel:123",
      supported: true,
      status: "sent" as const,
    }));

    const result = await dispatchConnectorDelivery(
      createConnector("integration_connection", "integration:discord-1", "discord-1", ["interactive_actions"], {
        key: "discord",
      }),
      createPayload("channel.typing", {
        target: "channel:123",
        durationMs: 4000,
      }),
      {
        commsSend: vi.fn(),
        commsReply: vi.fn(async () => ({})),
        commsReact: vi.fn(),
        commsUnsend: vi.fn(),
        commsTyping,
        invokeMcpTool: vi.fn(),
        publishRealtime: vi.fn(),
      },
    );

    expect(commsTyping).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "discord-1",
        target: "channel:123",
        durationMs: 4000,
      }),
    );
    expect(result).toMatchObject({
      capabilityId: "interactive_actions",
      dispatchKind: "integration_channel_action",
      result: { supported: true, status: "sent" },
    });
  });
});

function createConnector(
  connectorType: ConnectorRecord["connectorType"],
  connectorId: string,
  sourceId: string,
  enabledCapabilityIds: Array<ConnectorRecord["capabilities"][number]["id"]>,
  metadata: ConnectorRecord["metadata"] = {},
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
    metadata,
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

function createTypingResult() {
  return {
    channelKey: "discord",
    connectionId: "conn-1",
    target: "#ops",
    supported: false,
    status: "unsupported" as const,
  };
}
