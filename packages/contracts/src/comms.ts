export interface ChannelAttachmentInput {
  url?: string;
  title?: string;
  mimeType?: string;
  dataBase64?: string;
  attachmentId?: string;
}

export interface ChannelSendInput {
  connectionId: string;
  target: string;
  message: string;
  attachments?: ChannelAttachmentInput[];
  attachmentIds?: string[];
  replyToMessageId?: string;
  replyToPartIndex?: number;
  effectId?: string;
  subject?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface ChannelReactInput {
  connectionId: string;
  messageId: string;
  reaction: string;
  target?: string;
  partIndex?: number;
  messageText?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface ChannelReplyInput extends ChannelSendInput {
  replyToMessageId: string;
}

export interface ChannelUnsendInput {
  connectionId: string;
  messageId: string;
  target?: string;
  partIndex?: number;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface ChannelTypingInput {
  connectionId: string;
  target: string;
  threadId?: string;
  durationMs?: number;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface ChannelTypingResult {
  channelKey: string;
  connectionId: string;
  target: string;
  supported: boolean;
  status: "sent" | "unsupported";
  reason?: string;
  expiresAt?: string;
}

export interface GmailSendInput {
  connectionId: string;
  to: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  cc?: string[];
  bcc?: string[];
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface GmailReadQuery {
  connectionId: string;
  query?: string;
  maxResults?: number;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface CalendarCreateEventInput {
  connectionId: string;
  calendarId?: string;
  title: string;
  description?: string;
  startIso: string;
  endIso: string;
  attendees?: string[];
  timeZone?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface CalendarListQuery {
  connectionId: string;
  calendarId?: string;
  fromIso?: string;
  toIso?: string;
  maxResults?: number;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface CommsSendResult {
  deliveryId: string;
  status: "queued" | "sent" | "failed";
  providerMessageId?: string;
  channelKey: string;
  target: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommsSyncResult {
  status: "ok" | "failed";
  channelKey: string;
  records: unknown[];
  error?: string;
}
