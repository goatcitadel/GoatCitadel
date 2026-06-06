export type PersonalOpsLifecycleStatus = "active" | "archived";

export interface NoteRecord {
  noteId: string;
  workspaceId: string;
  title: string;
  body: string;
  tags: string[];
  sourceRefs: string[];
  lifecycleStatus: PersonalOpsLifecycleStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ReminderRecord {
  reminderId: string;
  workspaceId: string;
  title: string;
  dueAt: string;
  recurrenceRule?: string;
  status: "scheduled" | "completed" | "cancelled";
  sourceRef?: string;
  approvalId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContactRecord {
  contactId: string;
  workspaceId: string;
  displayName: string;
  emailAddresses: string[];
  phoneNumbers: string[];
  company?: string;
  role?: string;
  externalRefs: Array<{
    provider: "google" | "caldav" | "carddav" | "manual" | string;
    externalId: string;
  }>;
  lifecycleStatus: PersonalOpsLifecycleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MailAccountRecord {
  accountId: string;
  workspaceId: string;
  provider: "gmail" | "imap" | "smtp" | "manual" | string;
  label: string;
  address?: string;
  connectionId?: string;
  secretRef?: string;
  syncStatus: "not_configured" | "ready" | "syncing" | "degraded" | "failed";
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MailMessageSummary {
  messageId: string;
  accountId: string;
  threadId?: string;
  from?: string;
  to: string[];
  subject?: string;
  snippet?: string;
  receivedAt?: string;
  labels: string[];
  triage?: {
    urgency: "low" | "normal" | "high";
    category: "reply" | "review" | "schedule" | "archive" | "unknown";
    summary?: string;
  };
}

export interface MailDraftRecord {
  draftId: string;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  approvalId?: string;
  status: "draft" | "approval_required" | "sent" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface CalendarAccountRecord {
  accountId: string;
  workspaceId: string;
  provider: "google" | "caldav" | "manual" | string;
  label: string;
  connectionId?: string;
  secretRef?: string;
  syncStatus: "not_configured" | "ready" | "syncing" | "degraded" | "failed";
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEventRecord {
  eventId: string;
  accountId: string;
  calendarId?: string;
  title: string;
  description?: string;
  startIso: string;
  endIso: string;
  attendees: string[];
  location?: string;
  approvalId?: string;
  externalId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteMutationInput {
  workspaceId?: string;
  title: string;
  body?: string;
  tags?: string[];
  sourceRefs?: string[];
}

export interface ReminderMutationInput {
  workspaceId?: string;
  title: string;
  dueAt: string;
  recurrenceRule?: string;
  sourceRef?: string;
}

export interface CommunicationsDashboardResponse {
  mailAccounts: MailAccountRecord[];
  calendarAccounts: CalendarAccountRecord[];
  messages: MailMessageSummary[];
  events: CalendarEventRecord[];
  contacts: ContactRecord[];
}
