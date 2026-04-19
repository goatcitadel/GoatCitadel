import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import type {
  CalendarCreateEventInput,
  CalendarListQuery,
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
}

const COMMS_SESSION = "session:operator:comms";
const KNOWLEDGE_AGENT = "operator";

export async function commsSend(
  host: CommsHost,
  input: ChannelSendInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  throwIfCommsAborted(input.signal);
  const attachments = await resolveChannelSendAttachments(
    { attachments: input.attachments, attachmentIds: input.attachmentIds },
    { readChatAttachmentContent: (attachmentId) => host.readChatAttachmentContent(attachmentId) },
  );
  throwIfCommsAborted(input.signal);
  return host.invokeAndUnwrap(
    {
      toolName: "channel.send",
      args: {
        connectionId: input.connectionId,
        target: input.target,
        message: input.message,
        attachments,
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
      signal: input.signal,
    },
    "comms_send",
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
  return host.invokeAndUnwrap(
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
  return host.invokeAndUnwrap(
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
  const capabilities = describeChannelCapabilities(connection.key, connection.config);
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

function throwIfCommsAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === "string" ? signal.reason : "Comms delivery aborted.");
}

export async function commsGmailRead(
  host: CommsHost,
  input: GmailReadQuery,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return host.invokeAndUnwrap(
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
  return host.invokeAndUnwrap(
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
  return host.invokeAndUnwrap(
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
  return host.invokeAndUnwrap(
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
