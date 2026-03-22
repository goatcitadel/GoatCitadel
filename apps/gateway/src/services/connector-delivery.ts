import {
  ConflictError,
  ValidationError,
  type ChannelReactInput,
  type ChannelSendInput,
  type ChannelUnsendInput,
  type ConnectorCapabilityId,
  type ConnectorDeliveryWorkflowPayload,
  type ConnectorRecord,
  type McpInvokeRequest,
  type McpInvokeResponse,
  type ToolInvokeResult,
} from "@goatcitadel/contracts";

export interface ConnectorDeliveryDispatchResult {
  capabilityId: ConnectorCapabilityId;
  dispatchKind: "integration_channel_send" | "integration_channel_action" | "mcp_invoke" | "browser_realtime";
  result?: Record<string, unknown>;
}

export async function dispatchConnectorDelivery(
  connector: ConnectorRecord,
  payload: ConnectorDeliveryWorkflowPayload,
  deps: {
    commsSend: (input: ChannelSendInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
    commsReact: (input: ChannelReactInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
    commsUnsend: (input: ChannelUnsendInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
    invokeMcpTool: (input: McpInvokeRequest) => Promise<McpInvokeResponse>;
    publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => void;
  },
): Promise<ConnectorDeliveryDispatchResult> {
  requireActiveConnector(connector);

  switch (connector.connectorType) {
    case "integration_connection":
      if (!["channel.send", "channel.react", "channel.unsend"].includes(payload.action)) {
        throw new ValidationError({
          message: `Connector delivery action ${payload.action} is not supported for integration connectors.`,
        });
      }
      if (payload.action === "channel.send") {
        requireConnectorCapability(connector, "outbound_messages", payload.action);
      } else {
        requireConnectorCapability(connector, "interactive_actions", payload.action);
      }
      return dispatchIntegrationChannelAction(connector, payload, {
        commsSend: deps.commsSend,
        commsReact: deps.commsReact,
        commsUnsend: deps.commsUnsend,
      });

    case "mcp_server":
      if (payload.action !== "mcp.invoke") {
        throw new ValidationError({
          message: `Connector delivery action ${payload.action} is not supported for MCP connectors.`,
        });
      }
      requireConnectorCapability(connector, "interactive_actions", payload.action);
      return dispatchMcpInvoke(connector, payload, deps.invokeMcpTool);

    case "browser":
      if (payload.action !== "realtime.emit") {
        throw new ValidationError({
          message: `Connector delivery action ${payload.action} is not supported for browser connectors.`,
        });
      }
      requireConnectorCapability(connector, "interactive_actions", payload.action);
      return dispatchBrowserRealtime(connector, payload, deps.publishRealtime);

    default:
      throw new ValidationError({
        message: `Connector type ${connector.connectorType} is not supported for durable delivery.`,
      });
  }
}

function requireActiveConnector(connector: ConnectorRecord): void {
  if (connector.status !== "active") {
    throw new ConflictError({
      message: `Connector ${connector.connectorId} is ${connector.status} and cannot accept durable deliveries.`,
    });
  }
}

function requireConnectorCapability(
  connector: ConnectorRecord,
  capabilityId: ConnectorCapabilityId,
  action: string,
): void {
  const capability = connector.capabilities.find((item) => item.id === capabilityId);
  if (!capability?.enabled) {
    throw new ConflictError({
      message: `Connector ${connector.connectorId} does not permit ${action}; capability ${capabilityId} is unavailable.`,
    });
  }
}

async function dispatchIntegrationChannelAction(
  connector: ConnectorRecord,
  payload: ConnectorDeliveryWorkflowPayload,
  deps: {
    commsSend: (input: ChannelSendInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
    commsReact: (input: ChannelReactInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
    commsUnsend: (input: ChannelUnsendInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
  },
): Promise<ConnectorDeliveryDispatchResult> {
  const actionPayload = payload.payload ?? {};
  const target = optionalString(actionPayload.target)
    ? normalizeConnectorDeliveryTarget(connector, requireNonEmptyString(actionPayload.target, "payload.target"))
    : undefined;
  let result: ToolInvokeResult | Record<string, unknown>;
  let dispatchKind: ConnectorDeliveryDispatchResult["dispatchKind"] = "integration_channel_send";

  if (payload.action === "channel.send") {
    const message = requireNonEmptyString(actionPayload.message, "payload.message");
    const attachments = normalizeAttachments(actionPayload.attachments);
    result = await deps.commsSend({
      connectionId: connector.sourceId,
      target: target ?? requireNonEmptyString(actionPayload.target, "payload.target"),
      message,
      attachments,
      sessionId: optionalString(actionPayload.sessionId),
      agentId: optionalString(actionPayload.agentId),
      taskId: optionalString(actionPayload.taskId),
    });
  } else if (payload.action === "channel.react") {
    dispatchKind = "integration_channel_action";
    result = await deps.commsReact({
      connectionId: connector.sourceId,
      target,
      messageId: requireNonEmptyString(actionPayload.messageId, "payload.messageId"),
      reaction: requireNonEmptyString(actionPayload.reaction, "payload.reaction"),
      partIndex: optionalInteger(actionPayload.partIndex),
      messageText: optionalString(actionPayload.messageText),
      sessionId: optionalString(actionPayload.sessionId),
      agentId: optionalString(actionPayload.agentId),
      taskId: optionalString(actionPayload.taskId),
    });
  } else {
    dispatchKind = "integration_channel_action";
    result = await deps.commsUnsend({
      connectionId: connector.sourceId,
      target,
      messageId: requireNonEmptyString(actionPayload.messageId, "payload.messageId"),
      partIndex: optionalInteger(actionPayload.partIndex),
      sessionId: optionalString(actionPayload.sessionId),
      agentId: optionalString(actionPayload.agentId),
      taskId: optionalString(actionPayload.taskId),
    });
  }
  return {
    capabilityId: payload.action === "channel.send" ? "outbound_messages" : "interactive_actions",
    dispatchKind,
    result: unwrapToolInvokeResult(result),
  };
}

async function dispatchMcpInvoke(
  connector: ConnectorRecord,
  payload: ConnectorDeliveryWorkflowPayload,
  invokeMcpTool: (input: McpInvokeRequest) => Promise<McpInvokeResponse>,
): Promise<ConnectorDeliveryDispatchResult> {
  const actionPayload = payload.payload ?? {};
  const toolName = requireNonEmptyString(actionPayload.toolName, "payload.toolName");
  const response = await invokeMcpTool({
    serverId: connector.sourceId,
    toolName,
    arguments: normalizeRecord(actionPayload.arguments),
    sessionId: optionalString(actionPayload.sessionId),
    agentId: optionalString(actionPayload.agentId),
    taskId: optionalString(actionPayload.taskId),
  });
  if (!response.ok) {
    throw new Error(response.error ?? `MCP invoke failed for ${connector.connectorId}/${toolName}.`);
  }
  return {
    capabilityId: "interactive_actions",
    dispatchKind: "mcp_invoke",
    result: response.output ?? {},
  };
}

function dispatchBrowserRealtime(
  connector: ConnectorRecord,
  payload: ConnectorDeliveryWorkflowPayload,
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => void,
): ConnectorDeliveryDispatchResult {
  const actionPayload = payload.payload ?? {};
  const eventType = optionalString(actionPayload.eventType) ?? "connector_delivery_browser_event";
  const source = optionalString(actionPayload.source) ?? "connectors";
  const eventPayload = normalizeRecord(actionPayload.payload);
  publishRealtime(eventType, source, {
    connectorId: connector.connectorId,
    action: payload.action,
    ...eventPayload,
  });
  return {
    capabilityId: "interactive_actions",
    dispatchKind: "browser_realtime",
    result: {
      eventType,
      source,
      payload: eventPayload,
    },
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError({
      message: `${field} is required.`,
    });
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function normalizeConnectorDeliveryTarget(connector: ConnectorRecord, rawTarget: string): string {
  const target = rawTarget.trim();
  const channelKey = readConnectorChannelKey(connector);
  switch (channelKey) {
    case "discord":
      return normalizeDiscordDeliveryTarget(target);
    case "whatsapp":
      return normalizeWhatsAppDeliveryTarget(target);
    default:
      return target;
  }
}

function readConnectorChannelKey(connector: ConnectorRecord): string | undefined {
  const key = connector.metadata?.key;
  return typeof key === "string" && key.trim().length > 0 ? key.trim().toLowerCase() : undefined;
}

function normalizeDiscordDeliveryTarget(target: string): string {
  const channelMention = target.match(/^<#(\d+)>$/);
  if (channelMention) {
    return `channel:${channelMention[1]}`;
  }
  const userMention = target.match(/^<@!?(\d+)>$/);
  if (userMention) {
    return `user:${userMention[1]}`;
  }
  if (/^\d+$/.test(target)) {
    return `channel:${target}`;
  }
  const discordDirect = target.match(/^discord:(\d+)$/i);
  if (discordDirect) {
    return `user:${discordDirect[1]}`;
  }
  return target;
}

function normalizeWhatsAppDeliveryTarget(target: string): string {
  const normalized = normalizeWhatsAppTarget(target);
  if (!normalized) {
    throw new ValidationError({
      message: 'payload.target must be a WhatsApp E.164 number like "+15551234567" or a group JID like "120363123456789@g.us".',
    });
  }
  return normalized;
}

function normalizeWhatsAppTarget(value: string): string | null {
  const candidate = stripWhatsAppPrefixes(value);
  if (!candidate) {
    return null;
  }
  if (isWhatsAppGroupJid(candidate)) {
    const localPart = candidate.slice(0, candidate.length - "@g.us".length);
    return `${localPart}@g.us`;
  }
  const userMatch = candidate.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/i)
    ?? candidate.match(/^(\d+)@lid$/i);
  if (userMatch) {
    const phone = userMatch[1];
    return typeof phone === "string" ? normalizeE164Like(phone) : null;
  }
  if (candidate.includes("@")) {
    return null;
  }
  return normalizeE164Like(candidate);
}

function stripWhatsAppPrefixes(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const next = candidate.replace(/^whatsapp:/i, "").trim();
    if (next === candidate) {
      return candidate;
    }
    candidate = next;
  }
}

function isWhatsAppGroupJid(value: string): boolean {
  const lower = value.toLowerCase();
  if (!lower.endsWith("@g.us")) {
    return false;
  }
  const localPart = value.slice(0, value.length - "@g.us".length);
  if (!localPart || localPart.includes("@")) {
    return false;
  }
  return /^[0-9]+(-[0-9]+)*$/u.test(localPart);
}

function normalizeE164Like(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 2) {
    return null;
  }
  return `+${digits}`;
}

function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeAttachments(value: unknown): ChannelSendInput["attachments"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const attachments = value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const attachment = item as Record<string, unknown>;
      return {
        url: optionalString(attachment.url),
        title: optionalString(attachment.title),
        mimeType: optionalString(attachment.mimeType),
        dataBase64: optionalString(attachment.dataBase64),
        attachmentId: optionalString(attachment.attachmentId),
      };
    })
    .filter((item) => item.url || item.title || item.mimeType || item.dataBase64 || item.attachmentId);
  return attachments.length > 0 ? attachments : undefined;
}

function unwrapToolInvokeResult(result: ToolInvokeResult | Record<string, unknown>): Record<string, unknown> {
  if ("outcome" in result && typeof result.outcome === "string") {
    const invokeResult = result as ToolInvokeResult;
    if (invokeResult.outcome !== "executed") {
      throw new Error(invokeResult.policyReason || `Tool execution returned ${invokeResult.outcome}.`);
    }
    return invokeResult.result ?? {
      outcome: invokeResult.outcome,
      auditEventId: invokeResult.auditEventId,
      policyReason: invokeResult.policyReason,
    };
  }
  return result as Record<string, unknown>;
}
