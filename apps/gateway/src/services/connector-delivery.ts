import {
  ConflictError,
  redactStructuredSecrets,
  type ChannelActivityInput,
  type ChannelActivityResult,
  type ChannelAttachmentInput,
  type ChannelGovernanceInput,
  type ChannelReplyInput,
  ValidationError,
  type ChannelReactInput,
  type ChannelSendInput,
  type ChannelTypingInput,
  type ChannelTypingResult,
  type ChannelUnsendInput,
  type ConnectorCapabilityId,
  type ConnectorDeliveryWorkflowPayload,
  type ConnectorRecord,
  type McpInvokeRequest,
  type McpInvokeResponse,
  type RealtimeEvent,
  type ToolInvokeResult,
} from "@goatcitadel/contracts";
import { parseSkillOutputDirectives } from "./skill-output-directives.js";

export interface ConnectorDeliveryDispatchResult {
  capabilityId: ConnectorCapabilityId;
  dispatchKind: "integration_channel_send" | "integration_channel_action" | "mcp_invoke" | "browser_realtime";
  result?: Record<string, unknown>;
}

type ConnectorActionResult = ToolInvokeResult | Record<string, unknown> | ChannelTypingResult | ChannelActivityResult;

export async function dispatchConnectorDelivery(
  connector: ConnectorRecord,
  payload: ConnectorDeliveryWorkflowPayload,
  deps: {
    commsSend: (input: ChannelSendInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
    commsReply: (input: ChannelReplyInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
    commsReact: (input: ChannelReactInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
    commsUnsend: (input: ChannelUnsendInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
    commsTyping: (input: ChannelTypingInput) => Promise<ChannelTypingResult | Record<string, unknown>>;
    commsActivity?: (input: ChannelActivityInput) => Promise<ChannelActivityResult | Record<string, unknown>>;
    invokeMcpTool: (input: McpInvokeRequest) => Promise<McpInvokeResponse>;
    mcpInvokeContext?: Pick<
      McpInvokeRequest,
      | "workspaceId"
      | "taskId"
      | "runId"
      | "permissionProfileId"
      | "localOperatorOverrideId"
      | "surface"
      | "policyContext"
      | "consentContext"
    >;
    publishRealtime: (
      eventType: string,
      source: string,
      payload: Record<string, unknown>,
      options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
    ) => void;
    markExternalCallStarted?: () => void;
    deliveryEffectId?: string;
    signal?: AbortSignal;
  },
): Promise<ConnectorDeliveryDispatchResult> {
  throwIfConnectorDeliveryAborted(deps.signal);
  requireActiveConnector(connector);

  switch (connector.connectorType) {
    case "integration_connection":
      if (
        ![
          "channel.send",
          "channel.reply",
          "channel.react",
          "channel.unsend",
          "channel.typing",
          "channel.activity",
        ].includes(payload.action)
      ) {
        throw new ValidationError({
          message: `Connector delivery action ${payload.action} is not supported for integration connectors.`,
        });
      }
      if (payload.action === "channel.send" || payload.action === "channel.reply") {
        requireConnectorCapability(connector, "outbound_messages", payload.action);
      } else {
        requireConnectorCapability(connector, "interactive_actions", payload.action);
      }
      return dispatchIntegrationChannelAction(connector, payload, {
        commsSend: deps.commsSend,
        commsReply: deps.commsReply,
        commsReact: deps.commsReact,
        commsUnsend: deps.commsUnsend,
        commsTyping: deps.commsTyping,
        commsActivity: deps.commsActivity,
        markExternalCallStarted: deps.markExternalCallStarted,
        deliveryEffectId: deps.deliveryEffectId,
        signal: deps.signal,
      });

    case "mcp_server":
      if (payload.action !== "mcp.invoke") {
        throw new ValidationError({
          message: `Connector delivery action ${payload.action} is not supported for MCP connectors.`,
        });
      }
      requireConnectorCapability(connector, "interactive_actions", payload.action);
      return dispatchMcpInvoke(
        connector,
        payload,
        deps.invokeMcpTool,
        deps.signal,
        deps.mcpInvokeContext,
        deps.markExternalCallStarted,
      );

    case "browser":
      if (payload.action !== "realtime.emit") {
        throw new ValidationError({
          message: `Connector delivery action ${payload.action} is not supported for browser connectors.`,
        });
      }
      requireConnectorCapability(connector, "interactive_actions", payload.action);
      return dispatchBrowserRealtime(connector, payload, deps.publishRealtime, deps.markExternalCallStarted);

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
    commsReply: (input: ChannelReplyInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
    commsReact: (input: ChannelReactInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
    commsUnsend: (input: ChannelUnsendInput) => Promise<ToolInvokeResult | Record<string, unknown>>;
    commsTyping: (input: ChannelTypingInput) => Promise<ChannelTypingResult | Record<string, unknown>>;
    commsActivity?: (input: ChannelActivityInput) => Promise<ChannelActivityResult | Record<string, unknown>>;
    markExternalCallStarted?: () => void;
    deliveryEffectId?: string;
    signal?: AbortSignal;
  },
): Promise<ConnectorDeliveryDispatchResult> {
  throwIfConnectorDeliveryAborted(deps.signal);
  const actionPayload = payload.payload ?? {};
  const governance = buildChannelGovernanceContext(actionPayload, payload);
  const target = optionalString(actionPayload.target)
    ? normalizeConnectorDeliveryTarget(connector, requireNonEmptyString(actionPayload.target, "payload.target"))
    : undefined;
  let result: ConnectorActionResult;
  let dispatchKind: ConnectorDeliveryDispatchResult["dispatchKind"] = "integration_channel_send";

  if (payload.action === "channel.send") {
    const rawMessage = requireNonEmptyString(actionPayload.message, "payload.message");
    const rawAttachments = normalizeAttachments(actionPayload.attachments);
    const { message, attachments } = applyAsDocumentDirectives(rawMessage, rawAttachments);
    deps.markExternalCallStarted?.();
    result = await deps.commsSend({
      connectionId: connector.sourceId,
      target: target ?? requireNonEmptyString(actionPayload.target, "payload.target"),
      message,
      attachments,
      interactiveActions: normalizeInteractiveActions(actionPayload.interactiveActions),
      interactiveActionTemplate: normalizeInteractiveActionTemplate(actionPayload.interactiveActionTemplate),
      commitmentId: optionalString(actionPayload.commitmentId),
      effectId: deps.deliveryEffectId,
      ...governance,
      signal: deps.signal,
    });
  } else if (payload.action === "channel.reply") {
    const rawMessage = requireNonEmptyString(actionPayload.message, "payload.message");
    const rawAttachments = normalizeAttachments(actionPayload.attachments);
    const { message, attachments } = applyAsDocumentDirectives(rawMessage, rawAttachments);
    deps.markExternalCallStarted?.();
    result = await deps.commsReply({
      connectionId: connector.sourceId,
      target: target ?? requireNonEmptyString(actionPayload.target, "payload.target"),
      message,
      attachments,
      interactiveActions: normalizeInteractiveActions(actionPayload.interactiveActions),
      interactiveActionTemplate: normalizeInteractiveActionTemplate(actionPayload.interactiveActionTemplate),
      replyToMessageId: requireNonEmptyString(actionPayload.replyToMessageId, "payload.replyToMessageId"),
      replyToPartIndex: optionalInteger(actionPayload.replyToPartIndex),
      commitmentId: optionalString(actionPayload.commitmentId),
      effectId: deps.deliveryEffectId,
      ...governance,
      signal: deps.signal,
    });
  } else if (payload.action === "channel.react") {
    dispatchKind = "integration_channel_action";
    deps.markExternalCallStarted?.();
    result = await deps.commsReact({
      connectionId: connector.sourceId,
      target,
      messageId: requireNonEmptyString(actionPayload.messageId, "payload.messageId"),
      reaction: requireNonEmptyString(actionPayload.reaction, "payload.reaction"),
      partIndex: optionalInteger(actionPayload.partIndex),
      messageText: optionalString(actionPayload.messageText),
      ...governance,
      signal: deps.signal,
    });
  } else if (payload.action === "channel.typing") {
    dispatchKind = "integration_channel_action";
    deps.markExternalCallStarted?.();
    result = await deps.commsTyping({
      connectionId: connector.sourceId,
      target: target ?? requireNonEmptyString(actionPayload.target, "payload.target"),
      threadId: optionalString(actionPayload.threadId),
      durationMs: optionalInteger(actionPayload.durationMs),
      ...governance,
      signal: deps.signal,
    });
  } else if (payload.action === "channel.activity") {
    if (!deps.commsActivity) {
      throw new ValidationError({ message: "Connector delivery action channel.activity is not available." });
    }
    dispatchKind = "integration_channel_action";
    deps.markExternalCallStarted?.();
    result = await deps.commsActivity({
      connectionId: connector.sourceId,
      target: target ?? requireNonEmptyString(actionPayload.target, "payload.target"),
      messageId: requireNonEmptyString(actionPayload.messageId, "payload.messageId"),
      phase: normalizeChannelActivityPhase(actionPayload.phase),
      threadId: optionalString(actionPayload.threadId),
      turnId: optionalString(actionPayload.turnId),
      correlationId: optionalString(actionPayload.correlationId) ?? payload.correlationId,
      label: optionalString(actionPayload.label),
      ...governance,
      signal: deps.signal,
    });
  } else {
    dispatchKind = "integration_channel_action";
    deps.markExternalCallStarted?.();
    result = await deps.commsUnsend({
      connectionId: connector.sourceId,
      target,
      messageId: requireNonEmptyString(actionPayload.messageId, "payload.messageId"),
      partIndex: optionalInteger(actionPayload.partIndex),
      ...governance,
      signal: deps.signal,
    });
  }
  return {
    capabilityId:
      payload.action === "channel.send" || payload.action === "channel.reply"
        ? "outbound_messages"
        : "interactive_actions",
    dispatchKind,
    result: unwrapToolInvokeResult(result),
  };
}

function buildChannelGovernanceContext(
  actionPayload: Record<string, unknown>,
  payload: ConnectorDeliveryWorkflowPayload,
): ChannelGovernanceInput {
  const context: ChannelGovernanceInput = {};
  assignChannelOptional(context, "workspaceId", optionalString(actionPayload.workspaceId) ?? payload.workspaceId);
  assignChannelOptional(context, "sessionId", optionalString(actionPayload.sessionId) ?? payload.sessionId);
  assignChannelOptional(context, "agentId", optionalString(actionPayload.agentId) ?? payload.agentId);
  assignChannelOptional(context, "taskId", optionalString(actionPayload.taskId) ?? payload.taskId);
  assignChannelOptional(context, "runId", optionalString(actionPayload.runId) ?? payload.runId);
  assignChannelOptional(context, "operatorId", optionalString(actionPayload.operatorId) ?? payload.operatorId);
  assignChannelOptional(context, "authActorId", optionalString(actionPayload.authActorId) ?? payload.authActorId);
  assignChannelOptional(
    context,
    "authActorSource",
    normalizeAuthActorSource(actionPayload.authActorSource) ?? normalizeAuthActorSource(payload.authActorSource),
  );
  assignChannelOptional(
    context,
    "permissionProfileId",
    optionalString(actionPayload.permissionProfileId) ?? payload.permissionProfileId,
  );
  assignChannelOptional(
    context,
    "localOperatorOverrideId",
    optionalString(actionPayload.localOperatorOverrideId) ?? payload.localOperatorOverrideId,
  );
  assignChannelOptional(
    context,
    "surface",
    normalizeMcpSurface(actionPayload.surface) ?? normalizeMcpSurface(payload.originSurface),
  );
  return context;
}

function assignChannelOptional<TKey extends keyof ChannelGovernanceInput>(
  context: ChannelGovernanceInput,
  key: TKey,
  value: ChannelGovernanceInput[TKey] | undefined,
): void {
  if (value !== undefined) {
    context[key] = value;
  }
}

function normalizeAuthActorSource(value: unknown): ChannelGovernanceInput["authActorSource"] | undefined {
  return value === "none" ||
    value === "token" ||
    value === "basic" ||
    value === "loopback" ||
    value === "sse" ||
    value === "device" ||
    value === "companion"
    ? value
    : undefined;
}

async function dispatchMcpInvoke(
  connector: ConnectorRecord,
  payload: ConnectorDeliveryWorkflowPayload,
  invokeMcpTool: (input: McpInvokeRequest) => Promise<McpInvokeResponse>,
  signal?: AbortSignal,
  context?: Pick<
    McpInvokeRequest,
    | "workspaceId"
    | "taskId"
    | "runId"
    | "permissionProfileId"
    | "localOperatorOverrideId"
    | "surface"
    | "policyContext"
    | "consentContext"
  >,
  markExternalCallStarted?: () => void,
): Promise<ConnectorDeliveryDispatchResult> {
  const actionPayload = payload.payload ?? {};
  const toolName = requireNonEmptyString(actionPayload.toolName, "payload.toolName");
  throwIfConnectorDeliveryAborted(signal);
  const request: McpInvokeRequest = {
    serverId: connector.sourceId,
    toolName,
    arguments: normalizeRecord(actionPayload.arguments),
  };
  assignOptional(request, "sessionId", optionalString(actionPayload.sessionId) ?? payload.sessionId);
  assignOptional(request, "agentId", optionalString(actionPayload.agentId) ?? payload.agentId);
  assignOptional(
    request,
    "workspaceId",
    optionalString(actionPayload.workspaceId) ?? payload.workspaceId ?? context?.workspaceId,
  );
  assignOptional(request, "taskId", optionalString(actionPayload.taskId) ?? payload.taskId ?? context?.taskId);
  assignOptional(request, "runId", optionalString(actionPayload.runId) ?? payload.runId ?? context?.runId);
  assignOptional(
    request,
    "permissionProfileId",
    optionalString(actionPayload.permissionProfileId) ?? payload.permissionProfileId ?? context?.permissionProfileId,
  );
  assignOptional(
    request,
    "localOperatorOverrideId",
    optionalString(actionPayload.localOperatorOverrideId) ??
      payload.localOperatorOverrideId ??
      context?.localOperatorOverrideId,
  );
  assignOptional(request, "surface", normalizeMcpSurface(actionPayload.surface) ?? context?.surface);
  assignOptional(request, "policyContext", context?.policyContext);
  assignOptional(request, "consentContext", context?.consentContext);
  assignOptional(request, "signal", signal);
  if (optionalString(actionPayload.approvalId) && !request.workspaceId) {
    throw new ValidationError({
      message: "MCP approval delivery requires workspaceId policy lineage.",
    });
  }
  markExternalCallStarted?.();
  const response = await invokeMcpTool(request);
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
  publishRealtime: (
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ) => void,
  markExternalCallStarted?: () => void,
): ConnectorDeliveryDispatchResult {
  const actionPayload = payload.payload ?? {};
  const eventType = optionalString(actionPayload.eventType) ?? "connector_delivery_browser_event";
  const source = optionalString(actionPayload.source) ?? "connectors";
  const eventPayload = normalizeRecord(actionPayload.payload);
  markExternalCallStarted?.();
  publishRealtime(
    eventType,
    source,
    {
      connectorId: connector.connectorId,
      action: payload.action,
      ...eventPayload,
    },
    {
      eventClass: "operational_signal",
      eventAuthority: "retained_stream",
      links: buildConnectorRealtimeLinks(connector.connectorId, eventPayload ?? {}),
    },
  );
  return {
    capabilityId: "interactive_actions",
    dispatchKind: "browser_realtime",
    result: {
      eventType,
      source,
      payload: redactStructuredSecrets(eventPayload).value,
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

function normalizeChannelActivityPhase(value: unknown): ChannelActivityInput["phase"] {
  const phase = optionalString(value);
  if (
    phase === "seen" ||
    phase === "thinking" ||
    phase === "tooling" ||
    phase === "waiting_approval" ||
    phase === "failed" ||
    phase === "clear"
  ) {
    return phase;
  }
  throw new ValidationError({ message: "payload.phase must be a supported channel activity phase." });
}

function normalizeMcpSurface(value: unknown): McpInvokeRequest["surface"] | undefined {
  const surface = optionalString(value);
  return surface === "chat" ||
    surface === "cowork" ||
    surface === "code" ||
    surface === "tools" ||
    surface === "mcp" ||
    surface === "all"
    ? surface
    : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function assignOptional<TKey extends keyof McpInvokeRequest>(
  request: McpInvokeRequest,
  key: TKey,
  value: McpInvokeRequest[TKey] | undefined,
): void {
  if (value !== undefined) {
    request[key] = value;
  }
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
      message:
        'payload.target must be a WhatsApp E.164 number like "+15551234567" or a group JID like "120363123456789@g.us".',
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
  const userMatch = candidate.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/i) ?? candidate.match(/^(\d+)@lid$/i);
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

function applyAsDocumentDirectives(
  message: string,
  existing: ChannelAttachmentInput[] | undefined,
): { message: string; attachments: ChannelAttachmentInput[] | undefined } {
  const parsed = parseSkillOutputDirectives(message);
  if (parsed.directives.length === 0) {
    return { message, attachments: existing };
  }
  const directiveAttachments: ChannelAttachmentInput[] = parsed.directives.map((directive) => ({
    title: directive.fileName,
    mimeType: directive.mimeType,
    dataBase64: Buffer.from(directive.content, "utf-8").toString("base64"),
  }));
  return {
    message: parsed.text,
    attachments: [...(existing ?? []), ...directiveAttachments],
  };
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

function normalizeInteractiveActions(value: unknown): ChannelSendInput["interactiveActions"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const recordValue = value as Record<string, unknown>;
  if (!Array.isArray(recordValue.buttons)) {
    return undefined;
  }
  const buttons = recordValue.buttons
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const button = item as Record<string, unknown>;
      return {
        label: optionalString(button.label) ?? "",
        callbackData: optionalString(button.callbackData) ?? "",
      };
    })
    .filter((item) => item.label && item.callbackData)
    .slice(0, 8);
  if (buttons.length === 0) {
    return undefined;
  }
  return {
    platform: optionalString(recordValue.platform),
    tokenId: optionalString(recordValue.tokenId),
    buttons,
  };
}

function normalizeInteractiveActionTemplate(value: unknown): ChannelSendInput["interactiveActionTemplate"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError({ message: "Approval action template is invalid." });
  }
  const recordValue = value as Record<string, unknown>;
  const tokenId = optionalString(recordValue.tokenId);
  const tokenRef = optionalString(recordValue.tokenRef);
  const expiresAt = optionalString(recordValue.expiresAt);
  if (
    !tokenId ||
    !tokenRef ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    !Array.isArray(recordValue.buttons)
  ) {
    throw new ValidationError({ message: "Approval action template is invalid." });
  }
  const buttons = recordValue.buttons
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const button = item as Record<string, unknown>;
      const decision = button.decision === "a" || button.decision === "r" ? button.decision : undefined;
      return {
        label: optionalString(button.label) ?? "",
        decision,
      };
    })
    .filter((item): item is { label: string; decision: "a" | "r" } => Boolean(item.label && item.decision));
  if (buttons.length === 0 || buttons.length !== recordValue.buttons.length) {
    throw new ValidationError({ message: "Approval action template is invalid." });
  }
  return {
    platform: optionalString(recordValue.platform),
    tokenId,
    tokenRef,
    expiresAt,
    buttons,
  };
}

function unwrapToolInvokeResult(result: ConnectorActionResult): Record<string, unknown> {
  if ("outcome" in result && typeof result.outcome === "string") {
    const invokeResult = result as ToolInvokeResult;
    if (invokeResult.outcome !== "executed") {
      throw new Error(invokeResult.policyReason || `Tool execution returned ${invokeResult.outcome}.`);
    }
    return (
      invokeResult.result ?? {
        outcome: invokeResult.outcome,
        auditEventId: invokeResult.auditEventId,
        policyReason: invokeResult.policyReason,
      }
    );
  }
  return { ...result };
}

function throwIfConnectorDeliveryAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  throw reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" ? reason : "Connector delivery aborted.");
}

function buildConnectorRealtimeLinks(
  connectorId: string,
  payload: Record<string, unknown>,
): NonNullable<RealtimeEvent["links"]> {
  return {
    connectorId,
    ...(optionalString(payload.sessionId) ? { sessionId: optionalString(payload.sessionId) } : {}),
    ...(optionalString(payload.runId) ? { runId: optionalString(payload.runId) } : {}),
    ...(optionalString(payload.proactiveRunId) ? { proactiveRunId: optionalString(payload.proactiveRunId) } : {}),
    ...(optionalString(payload.approvalId) ? { approvalId: optionalString(payload.approvalId) } : {}),
    ...(optionalString(payload.taskId) ? { taskId: optionalString(payload.taskId) } : {}),
    ...(optionalString(payload.workspaceId) ? { workspaceId: optionalString(payload.workspaceId) } : {}),
    ...(optionalString(payload.messageId) ? { messageId: optionalString(payload.messageId) } : {}),
    ...(optionalString(payload.turnId) ? { turnId: optionalString(payload.turnId) } : {}),
  };
}
