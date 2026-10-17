export type PersonalOpsLifecycleStatus = "active" | "archived";

export interface NoteRecord {
  noteId: string;
  workspaceId: string;
  title: string;
  body: string;
  tags: string[];
  sourceRefs: string[];
  lifecycleStatus: PersonalOpsLifecycleStatus;
  /** Monotonic optimistic-concurrency revision. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface NoteRevisionRecord {
  noteId: string;
  workspaceId: string;
  revision: number;
  title: string;
  body: string;
  tags: string[];
  sourceRefs: string[];
  contentHash: string;
  actorId: string;
  source: "operator" | "proposal" | "migration";
  proposalId?: string;
  createdAt: string;
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
  workspaceId?: string;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  approvalId?: string;
  /** `outcome_unknown`: the provider may have delivered; never resent or promoted to `sent` automatically. */
  status: "draft" | "approval_required" | "sent" | "failed" | "send_unavailable" | "outcome_unknown";
  failureReason?: string;
  sentAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Result of `POST /api/v1/mail/drafts/:draftId/release`, which recovers a draft whose send request was
 * interrupted after the draft was fenced (`approval_required`) but before an approval id was recorded.
 * - `released`: no send approval names the draft; it is a `draft` again and may request one approval.
 * - `relinked`: a send approval for the draft did persist; the draft now carries its id, so Inbox decides it.
 * - `not_interrupted`: the draft is not in the interrupted state; nothing changed.
 * - `too_recent`: the interrupted request may still be running; retry after `retryAfterSeconds`.
 */
export interface MailDraftReleaseResponse {
  outcome: "released" | "relinked" | "not_interrupted" | "too_recent";
  draft: MailDraftRecord;
  retryAfterSeconds?: number;
}

/**
 * Operator-facing failure reasons the Gateway records on a mail draft. Clients map these exact
 * strings to their own copy; any other recorded reason is raw provider or Gateway detail.
 */
export const MAIL_DRAFT_FAILURE_REASONS = {
  rejected: "Send approval was rejected; nothing was sent.",
  expired: "Send approval expired; nothing was sent.",
  outcomeUnknown: "Delivery outcome is unknown; check the mailbox before retrying.",
  payloadChanged: "The approved message no longer matches its approval; nothing was sent.",
  connectionChanged: "The mail account changed after approval; nothing was sent. Request approval again.",
  connectionMissing: "The approved account is no longer connected; nothing was sent.",
  approvalMissingWorkspace: "The mail send approval names no workspace; nothing was sent.",
  approvalForeignWorkspace: "The mail account belongs to a different workspace than this approval; nothing was sent.",
  approvalAlreadyUsed: "This approval was already used; nothing was sent again.",
} as const;

export type MailDraftFailureReasonKey = keyof typeof MAIL_DRAFT_FAILURE_REASONS;

/** Prefixes of failure reasons that end in raw provider or Gateway text after the prefix. */
export const MAIL_DRAFT_FAILURE_DETAIL_PREFIXES = {
  deliveryFailed: "Mail send failed: ",
  notExecuted: "Mail send was not executed: ",
  approvalRequestFailed: "The send approval request failed (",
  providerCannotSend: "This mail account (",
} as const;

export type MailDraftFailureDetailKey = keyof typeof MAIL_DRAFT_FAILURE_DETAIL_PREFIXES;

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

export interface NoteUpdateInput extends Partial<NoteMutationInput> {
  expectedRevision: number;
  actorId?: string;
  proposalId?: string;
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
