import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import { sanitizeChannelOutboundMessage } from "@goatcitadel/contracts";
import type {
  CalendarCreateEventInput,
  CalendarListQuery,
  ChannelActivityEffectResult,
  ChannelActivityInput,
  ChannelActivityResult,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelSendInput,
  ChannelTypingInput,
  ChannelTypingResult,
  ChannelUnsendInput,
  ChatAttachmentRecord,
  GmailReadQuery,
  GmailSendInput,
  IntegrationConnection,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { resolveChannelSendAttachments } from "./channel-attachment-payload.js";

export interface CommsHost {
  invokeAndUnwrap(
    request: ToolInvokeRequest,
    realtimeType: string,
  ): Promise<ToolInvokeResult | Record<string, unknown>>;
  readChatAttachmentContent(attachmentId: string): Promise<{
    record: ChatAttachmentRecord;
    bytes: Buffer;
  }>;
  getIntegrationConnection(connectionId: string): IntegrationConnection;
  emitDiscordTyping(connection: IntegrationConnection, input: ChannelTypingInput): Promise<ChannelTypingResult>;
  emitTelegramTyping(connection: IntegrationConnection, input: ChannelTypingInput): Promise<ChannelTypingResult>;
  emitChannelActivity(
    connection: IntegrationConnection,
    input: ChannelActivityInput,
    options: {
      emoji?: string;
      activityReactions: string[];
      typing: boolean;
    },
  ): Promise<ChannelActivityEffectResult[]>;
}

const COMMS_SESSION = "session:operator:comms";
const KNOWLEDGE_AGENT = "operator";
const CHANNEL_ACTIVITY_EMOJI: Partial<Record<ChannelActivityInput["phase"], string>> = {
  seen: "👀",
  thinking: "🧠",
  tooling: "🔧",
  waiting_approval: "⚠️",
  failed: "❌",
};
const CHANNEL_ACTIVITY_TYPING_PHASES = new Set<ChannelActivityInput["phase"]>(["thinking", "tooling"]);

function invokeCommsTool(
  host: CommsHost,
  request: ToolInvokeRequest,
  realtimeType: string,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return host.invokeAndUnwrap(request, realtimeType);
}

export async function commsSend(
  host: CommsHost,
  input: ChannelSendInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  throwIfCommsAborted(input.signal);
  const connection = host.getIntegrationConnection(input.connectionId);
  const sanitized = sanitizeChannelOutboundMessage(input.message ?? "", {
    neutralizeMentions: shouldNeutralizeChannelMentions(connection.key),
    maxLength: connection.key === "discord" ? 2000 : undefined,
  });
  const attachments = await resolveChannelSendAttachments(
    { attachments: input.attachments, attachmentIds: input.attachmentIds },
    { readChatAttachmentContent: (attachmentId) => host.readChatAttachmentContent(attachmentId) },
  );
  throwIfCommsAborted(input.signal);
  return invokeCommsTool(
    host,
    {
      toolName: "channel.send",
      args: {
        connectionId: input.connectionId,
        target: input.target,
        message: sanitized.message,
        attachments,
        interactiveActions: input.interactiveActions,
        outboundSanitizer: hasOutboundSanitizerEffect(sanitized)
          ? {
              removedBlockCount: sanitized.removedBlockCount,
              redactedSecretCount: sanitized.redactedSecretCount,
              neutralizedMentionCount: sanitized.neutralizedMentionCount,
              truncated: sanitized.truncated,
              policy: "strip_internal_reasoning_blocks_redact_secrets",
            }
          : undefined,
        replyTo: input.replyToMessageId,
        replyToMessageId: input.replyToMessageId,
        replyToMessageGuid: input.replyToMessageId,
        replyToPartIndex: input.replyToPartIndex,
        effectId: input.effectId,
        subject: input.subject,
      },
      sessionId: input.sessionId ?? COMMS_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
      ...buildChannelToolGovernance(input),
      signal: input.signal,
    },
    "comms_send",
  );
}

function shouldNeutralizeChannelMentions(channelKey: string): boolean {
  return ["discord", "google-chat", "mattermost", "slack", "teams", "webhook"].includes(channelKey);
}

function hasOutboundSanitizerEffect(result: ReturnType<typeof sanitizeChannelOutboundMessage>): boolean {
  return (
    result.removedBlockCount > 0 ||
    result.redactedSecretCount > 0 ||
    result.neutralizedMentionCount > 0 ||
    result.truncated
  );
}

export async function commsReply(
  host: CommsHost,
  input: ChannelReplyInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  throwIfCommsAborted(input.signal);
  if (!input.replyToMessageId?.trim()) {
    throw new Error("replyToMessageId is required for channel replies.");
  }
  return commsSend(host, input);
}

export async function commsReact(
  host: CommsHost,
  input: ChannelReactInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  throwIfCommsAborted(input.signal);
  return invokeCommsTool(
    host,
    {
      toolName: "channel.react",
      args: {
        connectionId: input.connectionId,
        target: input.target,
        messageId: input.messageId,
        reaction: input.reaction,
        partIndex: input.partIndex,
        messageText: input.messageText,
      },
      sessionId: input.sessionId ?? COMMS_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
      ...buildChannelToolGovernance(input),
      signal: input.signal,
    },
    "comms_react",
  );
}

export async function commsUnsend(
  host: CommsHost,
  input: ChannelUnsendInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  throwIfCommsAborted(input.signal);
  return invokeCommsTool(
    host,
    {
      toolName: "channel.unsend",
      args: {
        connectionId: input.connectionId,
        target: input.target,
        messageId: input.messageId,
        partIndex: input.partIndex,
      },
      sessionId: input.sessionId ?? COMMS_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
      ...buildChannelToolGovernance(input),
      signal: input.signal,
    },
    "comms_unsend",
  );
}

export async function commsTyping(host: CommsHost, input: ChannelTypingInput): Promise<ChannelTypingResult> {
  throwIfCommsAborted(input.signal);
  const connection = host.getIntegrationConnection(input.connectionId);
  if (connection.kind !== "channel") {
    throw new Error(`Integration connection ${input.connectionId} is not a channel connection.`);
  }
  const capabilities = describeChannelCapabilities(connection.key, connection.config ?? {});
  if (!capabilities.supportedActions.includes("channel.typing")) {
    return {
      channelKey: connection.key,
      connectionId: input.connectionId,
      target: input.target,
      supported: false,
      status: "unsupported",
      reason: `${connection.label} does not advertise typing support in the current runtime mode.`,
    };
  }

  if (connection.key === "discord") {
    return host.emitDiscordTyping(connection, input);
  }
  if (connection.key === "telegram") {
    return host.emitTelegramTyping(connection, input);
  }

  return {
    channelKey: connection.key,
    connectionId: input.connectionId,
    target: input.target,
    supported: false,
    status: "unsupported",
    reason: `${connection.label} has not wired a typing adapter yet.`,
  };
}

export async function commsActivity(host: CommsHost, input: ChannelActivityInput): Promise<ChannelActivityResult> {
  throwIfCommsAborted(input.signal);
  const connection = host.getIntegrationConnection(input.connectionId);
  if (connection.kind !== "channel") {
    throw new Error(`Integration connection ${input.connectionId} is not a channel connection.`);
  }
  const capabilities = describeChannelCapabilities(connection.key, connection.config);
  const nativeEffects = new Set(capabilities.activityCapabilities.nativeEffects);
  const emoji = CHANNEL_ACTIVITY_EMOJI[input.phase];
  const activityReactions =
    nativeEffects.has("reaction") || nativeEffects.has("reaction_clear")
      ? Object.values(CHANNEL_ACTIVITY_EMOJI).filter((value): value is string => Boolean(value))
      : [];
  const effects = await host.emitChannelActivity(connection, input, {
    emoji,
    activityReactions,
    typing: nativeEffects.has("typing") && CHANNEL_ACTIVITY_TYPING_PHASES.has(input.phase),
  });

  return {
    channelKey: connection.key,
    connectionId: input.connectionId,
    target: input.target,
    messageId: input.messageId,
    phase: input.phase,
    status: summarizeChannelActivityStatus(input.phase, effects),
    ...(emoji ? { emoji } : {}),
    effects,
  };
}

function throwIfCommsAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === "string" ? signal.reason : "Comms delivery aborted.");
}

function buildChannelToolGovernance(
  input: ChannelSendInput | ChannelReactInput | ChannelUnsendInput | ChannelActivityInput,
): Partial<ToolInvokeRequest> {
  const sessionId = input.sessionId ?? COMMS_SESSION;
  const agentId = input.agentId ?? KNOWLEDGE_AGENT;
  const policyContext =
    input.operatorId ||
    input.authActorId ||
    input.authActorSource ||
    input.workspaceId ||
    input.taskId ||
    input.runId ||
    input.permissionProfileId ||
    input.localOperatorOverrideId ||
    input.surface
      ? {
          operatorId: input.operatorId,
          authActorId: input.authActorId,
          authActorSource: input.authActorSource,
          workspaceId: input.workspaceId,
          sessionId,
          taskId: input.taskId,
          runId: input.runId,
          permissionProfileId: input.permissionProfileId,
          localOperatorOverrideId: input.localOperatorOverrideId,
          surface: input.surface,
        }
      : undefined;
  return {
    workspaceId: input.workspaceId,
    runId: input.runId,
    permissionProfileId: input.permissionProfileId,
    localOperatorOverrideId: input.localOperatorOverrideId,
    surface: input.surface,
    policyContext,
    consentContext: input.operatorId
      ? {
          operatorId: input.operatorId,
          source: "agent",
          reason: `channel delivery ${agentId}`,
        }
      : undefined,
  };
}

function summarizeChannelActivityStatus(
  phase: ChannelActivityInput["phase"],
  effects: ChannelActivityEffectResult[],
): ChannelActivityResult["status"] {
  if (phase === "clear") {
    return effects.some((effect) => effect.status === "failed") ? "partial" : "cleared";
  }
  const failed = effects.some((effect) => effect.status === "failed");
  const sent = effects.some((effect) => effect.status === "sent" || effect.status === "cleared");
  if (failed && sent) {
    return "partial";
  }
  if (failed) {
    return "failed";
  }
  return sent ? "sent" : "unsupported";
}

export async function commsGmailRead(
  host: CommsHost,
  input: GmailReadQuery,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return invokeCommsTool(
    host,
    {
      toolName: "gmail.read",
      args: {
        connectionId: input.connectionId,
        query: input.query,
        maxResults: input.maxResults,
      },
      sessionId: input.sessionId ?? COMMS_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "comms_gmail_read",
  );
}

export async function commsGmailSend(
  host: CommsHost,
  input: GmailSendInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return invokeCommsTool(
    host,
    {
      toolName: "gmail.send",
      args: {
        connectionId: input.connectionId,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml,
      },
      sessionId: input.sessionId ?? COMMS_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "comms_gmail_send",
  );
}

export async function commsCalendarList(
  host: CommsHost,
  input: CalendarListQuery,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return invokeCommsTool(
    host,
    {
      toolName: "calendar.list",
      args: {
        connectionId: input.connectionId,
        calendarId: input.calendarId,
        fromIso: input.fromIso,
        toIso: input.toIso,
        maxResults: input.maxResults,
      },
      sessionId: input.sessionId ?? COMMS_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "comms_calendar_list",
  );
}

export async function commsCalendarCreate(
  host: CommsHost,
  input: CalendarCreateEventInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return invokeCommsTool(
    host,
    {
      toolName: "calendar.create_event",
      args: {
        connectionId: input.connectionId,
        calendarId: input.calendarId,
        title: input.title,
        description: input.description,
        startIso: input.startIso,
        endIso: input.endIso,
        attendees: input.attendees,
        timeZone: input.timeZone,
      },
      sessionId: input.sessionId ?? COMMS_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "comms_calendar_create",
  );
}
