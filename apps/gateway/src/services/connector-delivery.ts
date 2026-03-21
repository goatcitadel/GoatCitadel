import {
  ConflictError,
  ValidationError,
  type ChannelSendInput,
  type ConnectorCapabilityId,
  type ConnectorDeliveryWorkflowPayload,
  type ConnectorRecord,
  type McpInvokeRequest,
  type McpInvokeResponse,
  type ToolInvokeResult,
} from "@goatcitadel/contracts";

export interface ConnectorDeliveryDispatchResult {
  capabilityId: ConnectorCapabilityId;
  dispatchKind: "integration_channel_send" | "mcp_invoke" | "browser_realtime";
  result?: Record<string, unknown>;
}

export async function dispatchConnectorDelivery(
  connector: ConnectorRecord,
  payload: ConnectorDeliveryWorkflowPayload,
  deps: {
    commsSend: (input: ChannelSendInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
    invokeMcpTool: (input: McpInvokeRequest) => Promise<McpInvokeResponse>;
    publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => void;
  },
): Promise<ConnectorDeliveryDispatchResult> {
  requireActiveConnector(connector);

  switch (connector.connectorType) {
    case "integration_connection":
      if (payload.action !== "channel.send") {
        throw new ValidationError({
          message: `Connector delivery action ${payload.action} is not supported for integration connectors.`,
        });
      }
      requireConnectorCapability(connector, "outbound_messages", payload.action);
      return dispatchIntegrationChannelSend(connector, payload, deps.commsSend);

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

async function dispatchIntegrationChannelSend(
  connector: ConnectorRecord,
  payload: ConnectorDeliveryWorkflowPayload,
  commsSend: (input: ChannelSendInput) => Promise<ToolInvokeResult | Record<string, unknown>>,
): Promise<ConnectorDeliveryDispatchResult> {
  const actionPayload = payload.payload ?? {};
  const target = requireNonEmptyString(actionPayload.target, "payload.target");
  const message = requireNonEmptyString(actionPayload.message, "payload.message");
  const attachments = normalizeAttachments(actionPayload.attachments);
  const result = await commsSend({
    connectionId: connector.sourceId,
    target,
    message,
    attachments,
    sessionId: optionalString(actionPayload.sessionId),
    agentId: optionalString(actionPayload.agentId),
    taskId: optionalString(actionPayload.taskId),
  });
  return {
    capabilityId: "outbound_messages",
    dispatchKind: "integration_channel_send",
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
      };
    })
    .filter((item) => item.url || item.title || item.mimeType);
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
