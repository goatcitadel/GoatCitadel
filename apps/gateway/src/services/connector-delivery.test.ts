import { describe, expect, it, vi } from "vitest";
import type {
  ChannelReplyInput,
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
      {
        ...createPayload("channel.send", {
          target: "#ops",
          message: "hello from durable delivery",
        }),
        workspaceId: "workspace-1",
        taskId: "root-task-1",
        runId: "run-1",
        permissionProfileId: "trusted_local_power",
        localOperatorOverrideId: "local-override-1",
        originSurface: "cowork",
      },
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

    expect(commsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "channel-1",
        target: "#ops",
        message: "hello from durable delivery",
        workspaceId: "workspace-1",
        taskId: "root-task-1",
        runId: "run-1",
        permissionProfileId: "trusted_local_power",
        localOperatorOverrideId: "local-override-1",
        surface: "cowork",
      }),
    );
    expect(result).toMatchObject({
      capabilityId: "outbound_messages",
      dispatchKind: "integration_channel_send",
      result: { deliveryId: "delivery-1", status: "sent" },
    });
  });

  it("passes abort signals through integration channel sends and rejects on lease-loss abort", async () => {
    const signal = AbortSignal.abort(new Error("lease lost"));
    const commsSend = vi.fn(async (input: ChannelSendInput): Promise<ToolInvokeResult> => {
      expect(input.signal).toBe(signal);
      throw input.signal?.reason;
    });

    await expect(
      dispatchConnectorDelivery(
        createConnector("integration_connection", "integration:channel-1", "channel-1", ["outbound_messages"]),
        createPayload("channel.send", {
          target: "#ops",
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
          signal,
        },
      ),
    ).rejects.toThrow("lease lost");
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

  it("canonicalizes WhatsApp group and LID identities before dispatch", async () => {
    const commsSend = vi.fn(
      async (_input: ChannelSendInput): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "audit-1",
        policyReason: "allowed",
        result: { deliveryId: "delivery-1", status: "sent" },
      }),
    );

    for (const [target, expected] of [
      ["WHATSAPP:120363123456789@G.US", "120363123456789@g.us"],
      ["15551234567@lid", "+15551234567"],
    ] as const) {
      await dispatchConnectorDelivery(
        createConnector("integration_connection", "integration:whatsapp-1", "whatsapp-1", ["outbound_messages"], {
          key: "whatsapp",
        }),
        createPayload("channel.send", {
          target,
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

      expect(commsSend).toHaveBeenLastCalledWith(
        expect.objectContaining({
          connectionId: "whatsapp-1",
          target: expected,
        }),
      );
    }
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
    });
    expect(result).toMatchObject({
      capabilityId: "interactive_actions",
      dispatchKind: "mcp_invoke",
      result: { toolResult: "ok" },
    });
  });

  it("passes durable MCP lineage context when provided", async () => {
    const invokeMcpTool = vi.fn(
      async (_input: McpInvokeRequest): Promise<McpInvokeResponse> => ({
        ok: true,
        output: { toolResult: "ok" },
      }),
    );

    await dispatchConnectorDelivery(
      createConnector("mcp_server", "mcp:server-1", "server-1", ["interactive_actions"]),
      createPayload("mcp.invoke", {
        toolName: "search.docs",
        arguments: { q: "durable workflows" },
        sessionId: "sess-1",
      }),
      {
        commsSend: vi.fn(),
        commsReply: vi.fn(),
        commsReact: vi.fn(),
        commsUnsend: vi.fn(),
        commsTyping: vi.fn(),
        invokeMcpTool,
        publishRealtime: vi.fn(),
        mcpInvokeContext: {
          workspaceId: "workspace-1",
          taskId: "task-1",
          runId: "durable-run-1",
          permissionProfileId: "profile-safe",
          localOperatorOverrideId: "override-1",
          surface: "cowork",
          consentContext: {
            operatorId: "system-durable",
            source: "agent",
            reason: "durable connector delivery:durable-run-1",
          },
        },
      },
    );

    expect(invokeMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        taskId: "task-1",
        runId: "durable-run-1",
        permissionProfileId: "profile-safe",
        localOperatorOverrideId: "override-1",
        surface: "cowork",
        consentContext: expect.objectContaining({
          operatorId: "system-durable",
        }),
      }),
    );
  });

  it("fails closed when MCP approval delivery is missing workspace lineage", async () => {
    await expect(
      dispatchConnectorDelivery(
        createConnector("mcp_server", "mcp:server-1", "server-1", ["interactive_actions"]),
        createPayload("mcp.invoke", {
          approvalId: "approval-1",
          toolName: "goatcitadel.approval.remote_action_ready",
          arguments: { approvalId: "approval-1", actionType: "approval.resolve" },
        }),
        {
          commsSend: vi.fn(),
          commsReply: vi.fn(),
          commsReact: vi.fn(),
          commsUnsend: vi.fn(),
          commsTyping: vi.fn(),
          invokeMcpTool: vi.fn(),
          publishRealtime: vi.fn(),
        },
      ),
    ).rejects.toThrow("workspaceId policy lineage");
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

describe("dispatchConnectorDelivery with [[as_document]] directives", () => {
  it("converts a single [[as_document]] block to an attachment and strips it from the message text", async () => {
    const commsSend = vi.fn(
      async (input: ChannelSendInput): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "audit-doc",
        policyReason: "allowed",
        result: { delivered: true, message: input.message, attachments: input.attachments ?? null },
      }),
    );

    await dispatchConnectorDelivery(
      createConnector("integration_connection", "integration:slack-1", "slack-1", ["outbound_messages"], {
        key: "slack",
      }),
      createPayload("channel.send", {
        target: "#ops",
        message:
          "Here is your report:\n[[as_document fileName=report.md mimeType=text/markdown]]\n# Q3 Report\nNumbers and figures.\n[[/as_document]]\nEnd.",
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

    expect(commsSend).toHaveBeenCalledTimes(1);
    const sendArgs = commsSend.mock.calls[0]![0];
    expect(sendArgs.message).toMatch(/Here is your report:/);
    expect(sendArgs.message).toMatch(/End\./);
    expect(sendArgs.message).not.toMatch(/as_document/);
    expect(sendArgs.attachments).toHaveLength(1);
    expect(sendArgs.attachments?.[0]).toMatchObject({
      title: "report.md",
      mimeType: "text/markdown",
      dataBase64: Buffer.from("# Q3 Report\nNumbers and figures.", "utf-8").toString("base64"),
    });
  });

  it("appends document attachments alongside existing attachments", async () => {
    const commsSend = vi.fn(
      async (_input: ChannelSendInput): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "audit-doc",
        policyReason: "allowed",
        result: { delivered: true },
      }),
    );

    await dispatchConnectorDelivery(
      createConnector("integration_connection", "integration:slack-1", "slack-1", ["outbound_messages"], {
        key: "slack",
      }),
      createPayload("channel.send", {
        target: "#ops",
        message: "[[as_document fileName=doc.txt]]content[[/as_document]]",
        attachments: [{ url: "https://example.com/existing.png", mimeType: "image/png" }],
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

    const sendArgs = commsSend.mock.calls[0]![0];
    expect(sendArgs.attachments).toHaveLength(2);
    expect(sendArgs.attachments?.[0]).toMatchObject({ url: "https://example.com/existing.png" });
    expect(sendArgs.attachments?.[1]).toMatchObject({
      title: "doc.txt",
      mimeType: "text/plain",
      dataBase64: Buffer.from("content", "utf-8").toString("base64"),
    });
  });

  it("is a no-op when no directives are present", async () => {
    const commsSend = vi.fn(
      async (_input: ChannelSendInput): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "audit-plain",
        policyReason: "allowed",
        result: { delivered: true },
      }),
    );

    await dispatchConnectorDelivery(
      createConnector("integration_connection", "integration:slack-1", "slack-1", ["outbound_messages"], {
        key: "slack",
      }),
      createPayload("channel.send", {
        target: "#ops",
        message: "plain text",
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

    const sendArgs = commsSend.mock.calls[0]![0];
    expect(sendArgs.message).toBe("plain text");
    expect(sendArgs.attachments).toBeUndefined();
  });

  it("applies directive extraction to channel.reply as well", async () => {
    const commsReply = vi.fn(
      async (_input: ChannelReplyInput): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "audit-reply-doc",
        policyReason: "allowed",
        result: { delivered: true },
      }),
    );

    await dispatchConnectorDelivery(
      createConnector("integration_connection", "integration:slack-1", "slack-1", ["outbound_messages"], {
        key: "slack",
      }),
      createPayload("channel.reply", {
        target: "#ops",
        message: "[[as_document fileName=note.md]]hello[[/as_document]]",
        replyToMessageId: "M999",
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

    expect(commsReply).toHaveBeenCalledTimes(1);
    const replyArgs = commsReply.mock.calls[0]![0];
    expect(replyArgs.attachments).toHaveLength(1);
    expect(replyArgs.attachments?.[0]?.title).toBe("note.md");
    expect(replyArgs.attachments?.[0]?.dataBase64).toBe(Buffer.from("hello", "utf-8").toString("base64"));
    expect(replyArgs.message).not.toMatch(/as_document/);
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
