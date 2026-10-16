import type {
  ApprovalCreateInput,
  ApprovalRequest,
  CalendarAccountRecord,
  CalendarEventRecord,
  CalendarListQuery,
  CommunicationsDashboardResponse,
  ContactRecord,
  GmailReadQuery,
  IntegrationConnection,
  IntegrationKind,
  MailAccountRecord,
  MailDraftRecord,
  MailMessageSummary,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  COMMUNICATIONS_IDEMPOTENCY_PREFIX,
  computeCommunicationsPayloadHash,
  type CalendarCreateApprovalInput,
  type MailSendApprovalInput,
} from "./communications-approval-payload.js";

export type CommunicationsMailDraftStore = Pick<AsyncStorage["mailDrafts"], "create" | "find" | "transition">;

export type CreateCalendarEventInput = Omit<CalendarEventRecord, "eventId" | "createdAt" | "updatedAt"> & {
  workspaceId?: string;
};

/** Raised when draft persistence was not composed; routes answer 503 rather than keeping drafts in memory. */
export class MailDraftStoreUnavailableError extends Error {
  public constructor() {
    super("Mail draft storage is unavailable.");
    this.name = "MailDraftStoreUnavailableError";
  }
}

export interface CreateMailDraftInput {
  workspaceId?: string;
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
}

export interface CommunicationsDashboardQuery {
  workspaceId?: string;
  inboxLimit?: number;
  agendaLimit?: number;
}

export interface CommunicationsDashboardServiceDependencies {
  now?: () => Date;
  createApproval?: (input: ApprovalCreateInput) => Promise<ApprovalRequest>;
  listIntegrationConnections?: (
    kind?: IntegrationKind,
    limit?: number,
  ) => IntegrationConnection[] | Promise<IntegrationConnection[]>;
  commsGmailRead?: (input: GmailReadQuery) => Promise<ToolInvokeResult | Record<string, unknown>>;
  commsCalendarList?: (input: CalendarListQuery) => Promise<ToolInvokeResult | Record<string, unknown>>;
  listContacts?: (workspaceId: string) => ContactRecord[];
  /** Durable draft store; required by the draft methods, which fail closed without it. */
  mailDrafts?: CommunicationsMailDraftStore;
}

const DEFAULT_WORKSPACE_ID = "default";
const MAIL_SEND_EXECUTION_COPY = "Approving sends this exact message once through the connected account.";
const CALENDAR_CREATE_EXECUTION_COPY = "Approving creates this exact event once on the connected calendar.";
const SEND_APPROVAL_UNCERTAIN_REASON =
  "The send approval request did not complete, so nothing was sent and this draft will not request another approval.";
const DEFAULT_INBOX_LIMIT = 10;
const DEFAULT_AGENDA_LIMIT = 20;
const INTEGRATION_CONNECTION_LIMIT = 200;
const DEFAULT_AGENDA_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export class CommunicationsDashboardService {
  // De-dupes concurrent sends within this process only; the draft store is the durable record.
  private readonly sending = new Map<string, Promise<MailDraftRecord>>();

  public constructor(private readonly deps: CommunicationsDashboardServiceDependencies = {}) {}

  public async getDashboard(query: CommunicationsDashboardQuery = {}): Promise<CommunicationsDashboardResponse> {
    const workspaceId = normalizeWorkspaceId(query.workspaceId);
    const connections = await this.listWorkspaceConnections(workspaceId);
    const mailAccounts = connections.flatMap((connection) => this.toMailAccount(connection, workspaceId));
    const calendarAccounts = connections.flatMap((connection) => this.toCalendarAccount(connection, workspaceId));
    const [messages, events] = await Promise.all([
      this.listMessages(mailAccounts, query.inboxLimit ?? DEFAULT_INBOX_LIMIT),
      this.listEvents(calendarAccounts, query.agendaLimit ?? DEFAULT_AGENDA_LIMIT),
    ]);
    const contacts = this.listContacts(workspaceId, messages, connections);

    return {
      mailAccounts,
      calendarAccounts,
      messages,
      events,
      contacts,
    };
  }

  public async createDraft(input: CreateMailDraftInput): Promise<MailDraftRecord> {
    const store = this.requireDraftStore();
    const now = this.nowIso();
    const draft: MailDraftRecord = {
      draftId: createStableDraftId(now, input.accountId, input.to, input.subject),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      accountId: input.accountId,
      to: input.to,
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      subject: input.subject,
      bodyText: input.bodyText,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    return await store.create(draft);
  }

  /** The persisted draft, or undefined when this Gateway holds no draft with that id. */
  public async getDraft(draftId: string): Promise<MailDraftRecord | undefined> {
    return await this.requireDraftStore().find(draftId);
  }

  /** True only when the account is a mail account projected into this workspace's dashboard. */
  public async isMailAccountVisible(workspaceId: string, accountId: string): Promise<boolean> {
    const normalized = normalizeWorkspaceId(workspaceId);
    const connections = await this.listWorkspaceConnections(normalized);
    return connections.some((connection) =>
      this.toMailAccount(connection, normalized).some((account) => account.accountId === accountId),
    );
  }

  /** True only when the account is a calendar account projected into this workspace's dashboard. */
  public async isCalendarAccountVisible(workspaceId: string, accountId: string): Promise<boolean> {
    const normalized = normalizeWorkspaceId(workspaceId);
    const connections = await this.listWorkspaceConnections(normalized);
    return connections.some((connection) =>
      this.toCalendarAccount(connection, normalized).some((account) => account.accountId === accountId),
    );
  }

  public async sendDraft(draftId: string): Promise<MailDraftRecord> {
    const store = this.requireDraftStore();
    // A replay that arrives while the original is still in flight shares it.
    const inFlight = this.sending.get(draftId);
    if (inFlight) {
      return inFlight;
    }
    const pending = this.requestSendApproval(store, draftId).finally(() => this.sending.delete(draftId));
    this.sending.set(draftId, pending);
    return pending;
  }

  private async requestSendApproval(store: CommunicationsMailDraftStore, draftId: string): Promise<MailDraftRecord> {
    const existing = await store.find(draftId);
    const now = this.nowIso();
    if (!existing) {
      // Transient answer only: an unknown id is never persisted.
      return {
        draftId,
        accountId: "unknown",
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        bodyText: "",
        status: "failed",
        createdAt: now,
        updatedAt: now,
      };
    }
    if (existing.status !== "draft") {
      // Replaying a send whose response was lost returns the recorded outcome
      // instead of requesting a second high-risk approval for the same draft.
      return existing;
    }
    let approvalId: string;
    try {
      approvalId = await this.createSendApproval(existing);
    } catch (error) {
      // The approval may have persisted before the failure. Never request another one for this draft.
      await store.transition(draftId, ["draft"], {
        status: "failed",
        failureReason: SEND_APPROVAL_UNCERTAIN_REASON,
        updatedAt: now,
      });
      throw error;
    }
    const settled = await store.transition(draftId, ["draft"], {
      status: "approval_required",
      approvalId,
      updatedAt: now,
    });
    // When another process settled the draft first, its recorded outcome is the truth.
    return settled ?? (await store.find(draftId)) ?? { ...existing, approvalId, status: "approval_required" };
  }

  private createSendApproval(existing: MailDraftRecord): Promise<string> {
    const hashed: MailSendApprovalInput = {
      draftId: existing.draftId,
      accountId: existing.accountId,
      to: existing.to,
      cc: existing.cc,
      bcc: existing.bcc,
      subject: existing.subject,
      bodyText: existing.bodyText,
    };
    return this.requestApproval(existing.approvalId ?? `approval_required:${existing.draftId}`, {
      kind: "communications.mail.send",
      riskLevel: "danger",
      payload: {
        action: "mail_send",
        ...hashed,
        payloadHash: computeCommunicationsPayloadHash(hashed),
        idempotencyKeyPrefix: COMMUNICATIONS_IDEMPOTENCY_PREFIX,
      },
      preview: {
        title: "Send mail draft",
        draftId: existing.draftId,
        accountId: existing.accountId,
        to: existing.to,
        cc: existing.cc,
        bcc: existing.bcc,
        subject: existing.subject,
        execution: MAIL_SEND_EXECUTION_COPY,
      },
      linkage: {
        actionType: "communications.mail.send",
        connectorId: existing.accountId,
        ...(existing.workspaceId ? { workspaceId: existing.workspaceId } : {}),
      },
    });
  }

  public async createCalendarEventPlaceholder(input: CreateCalendarEventInput): Promise<CalendarEventRecord> {
    const { workspaceId, ...event } = input;
    const now = this.nowIso();
    const eventId = createStableDraftId(now, event.accountId, event.attendees, event.title).replace(
      "mail_draft_",
      "calendar_event_",
    );
    const hashed: CalendarCreateApprovalInput = {
      eventId,
      accountId: event.accountId,
      ...(event.calendarId === undefined ? {} : { calendarId: event.calendarId }),
      title: event.title,
      ...(event.description === undefined ? {} : { description: event.description }),
      startIso: event.startIso,
      endIso: event.endIso,
      attendees: event.attendees,
      ...(event.location === undefined ? {} : { location: event.location }),
    };
    const approvalId = await this.requestApproval(event.approvalId ?? `approval_required:${eventId}`, {
      kind: "communications.calendar.create",
      riskLevel: "caution",
      payload: {
        action: "calendar_event_create",
        ...hashed,
        payloadHash: computeCommunicationsPayloadHash(hashed),
        idempotencyKeyPrefix: COMMUNICATIONS_IDEMPOTENCY_PREFIX,
      },
      preview: {
        title: "Create calendar event",
        eventId,
        accountId: event.accountId,
        calendarId: event.calendarId,
        summary: event.title,
        startIso: event.startIso,
        endIso: event.endIso,
        attendees: event.attendees,
        execution: CALENDAR_CREATE_EXECUTION_COPY,
      },
      linkage: {
        actionType: "communications.calendar.create",
        connectorId: event.accountId,
        ...(workspaceId ? { workspaceId } : {}),
      },
    });
    return {
      ...event,
      eventId,
      approvalId,
      createdAt: now,
      updatedAt: now,
    };
  }

  private requestApproval(fallbackApprovalId: string, input: ApprovalCreateInput): Promise<string> {
    return createCommunicationsApproval(this.deps.createApproval, fallbackApprovalId, input);
  }

  private requireDraftStore(): CommunicationsMailDraftStore {
    const store = this.deps.mailDrafts;
    if (!store) {
      throw new MailDraftStoreUnavailableError();
    }
    return store;
  }

  private async listMessages(accounts: MailAccountRecord[], limit: number): Promise<MailMessageSummary[]> {
    const read = this.deps.commsGmailRead;
    if (!read) {
      return [];
    }

    const messages: MailMessageSummary[] = [];
    for (const account of accounts) {
      if (messages.length >= limit || account.provider !== "gmail" || !account.connectionId) {
        continue;
      }
      try {
        const response = await read({
          connectionId: account.connectionId,
          query: "in:inbox",
          maxResults: Math.max(1, Math.min(limit - messages.length, DEFAULT_INBOX_LIMIT)),
        });
        messages.push(...normalizeMailMessages(response, account.accountId));
      } catch {
        continue;
      }
    }
    return messages.slice(0, limit);
  }

  private async listEvents(accounts: CalendarAccountRecord[], limit: number): Promise<CalendarEventRecord[]> {
    const list = this.deps.commsCalendarList;
    if (!list) {
      return [];
    }

    const now = this.nowDate();
    const fromIso = now.toISOString();
    const toIso = new Date(now.getTime() + DEFAULT_AGENDA_WINDOW_MS).toISOString();
    const events: CalendarEventRecord[] = [];
    for (const account of accounts) {
      if (events.length >= limit || !account.connectionId) {
        continue;
      }
      try {
        const response = await list({
          connectionId: account.connectionId,
          fromIso,
          toIso,
          maxResults: Math.max(1, Math.min(limit - events.length, DEFAULT_AGENDA_LIMIT)),
        });
        events.push(...normalizeCalendarEvents(response, account.accountId, this.nowIso()));
      } catch {
        continue;
      }
    }
    return events.slice(0, limit);
  }

  private listContacts(
    workspaceId: string,
    messages: MailMessageSummary[],
    connections: IntegrationConnection[],
  ): ContactRecord[] {
    const configuredContacts = this.deps.listContacts?.(workspaceId) ?? [];
    const contactMap = new Map<string, ContactRecord>();
    for (const contact of configuredContacts) {
      contactMap.set(contact.contactId, sanitizeContact(contact, workspaceId));
    }
    for (const connection of connections) {
      for (const contact of normalizeConfigContacts(connection.config, workspaceId, this.nowIso())) {
        contactMap.set(contact.contactId, contact);
      }
    }
    for (const message of messages) {
      for (const email of [message.from, ...message.to].filter((value): value is string => Boolean(value))) {
        const normalized = email.trim().toLowerCase();
        if (!normalized || contactMap.has(`email:${normalized}`)) {
          continue;
        }
        contactMap.set(`email:${normalized}`, {
          contactId: `email:${normalized}`,
          workspaceId,
          displayName: email,
          emailAddresses: [email],
          phoneNumbers: [],
          externalRefs: [{ provider: "manual", externalId: `mail:${normalized}` }],
          lifecycleStatus: "active",
          createdAt: this.nowIso(),
          updatedAt: this.nowIso(),
        });
      }
    }
    return [...contactMap.values()];
  }

  private async listConnections(): Promise<IntegrationConnection[]> {
    const connections = await this.deps.listIntegrationConnections?.(undefined, INTEGRATION_CONNECTION_LIMIT);
    return Array.isArray(connections) ? connections : [];
  }

  /** Unbound connections belong to the default personal citadel and stay visible; bound ones only in their workspace. */
  private async listWorkspaceConnections(workspaceId: string): Promise<IntegrationConnection[]> {
    const connections = await this.listConnections();
    return connections.filter((connection) => !connection.workspaceId || connection.workspaceId === workspaceId);
  }

  private toMailAccount(connection: IntegrationConnection, workspaceId: string): MailAccountRecord[] {
    const provider = resolveMailProvider(connection);
    if (!provider) {
      return [];
    }
    const now = this.nowIso();
    return [
      {
        accountId: connection.connectionId,
        workspaceId,
        provider,
        label: connection.label,
        address: readString(connection.config, "address", "email", "emailAddress", "fromAddress"),
        connectionId: connection.connectionId,
        secretRef: readSecretRef(connection.config),
        syncStatus: resolveSyncStatus(connection),
        lastSyncedAt: connection.lastSyncAt,
        createdAt: connection.createdAt ?? now,
        updatedAt: connection.updatedAt ?? now,
      },
    ];
  }

  private toCalendarAccount(connection: IntegrationConnection, workspaceId: string): CalendarAccountRecord[] {
    const provider = resolveCalendarProvider(connection);
    if (!provider) {
      return [];
    }
    const now = this.nowIso();
    return [
      {
        accountId: connection.connectionId,
        workspaceId,
        provider,
        label: connection.label,
        connectionId: connection.connectionId,
        secretRef: readSecretRef(connection.config),
        syncStatus: resolveSyncStatus(connection),
        lastSyncedAt: connection.lastSyncAt,
        createdAt: connection.createdAt ?? now,
        updatedAt: connection.updatedAt ?? now,
      },
    ];
  }

  private nowDate(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.nowDate().toISOString();
  }
}

export function createCommunicationsDashboardService(
  deps: CommunicationsDashboardServiceDependencies = {},
): CommunicationsDashboardService {
  return new CommunicationsDashboardService(deps);
}

function normalizeWorkspaceId(workspaceId: string | undefined): string {
  const normalized = workspaceId?.trim();
  return normalized || DEFAULT_WORKSPACE_ID;
}

export function resolveMailProvider(connection: IntegrationConnection): MailAccountRecord["provider"] | undefined {
  const key = `${connection.catalogId}:${connection.key}`.toLowerCase();
  if (key.includes("gmail")) {
    return "gmail";
  }
  if (key.includes("imap")) {
    return "imap";
  }
  if (key.includes("smtp")) {
    return "smtp";
  }
  if (key.includes("mail")) {
    return "manual";
  }
  return undefined;
}

function resolveCalendarProvider(connection: IntegrationConnection): CalendarAccountRecord["provider"] | undefined {
  const key = `${connection.catalogId}:${connection.key}`.toLowerCase();
  if (key.includes("calendar") || key.includes("gmail")) {
    return "google";
  }
  if (key.includes("caldav")) {
    return "caldav";
  }
  return undefined;
}

function resolveSyncStatus(connection: IntegrationConnection): MailAccountRecord["syncStatus"] {
  if (!connection.enabled) {
    return "not_configured";
  }
  switch (connection.status) {
    case "connected":
      return "ready";
    case "error":
      return "failed";
    case "paused":
    case "disconnected":
      return "degraded";
    default:
      return "degraded";
  }
}

function readSecretRef(config: Record<string, unknown>): string | undefined {
  return readString(
    config,
    "secretRef",
    "refreshTokenHandle",
    "accessTokenEnv",
    "tokenEnv",
    "clientIdEnv",
    "clientSecretEnv",
    "apiKeyEnv",
  );
}

function readString(config: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeMailMessages(
  response: ToolInvokeResult | Record<string, unknown>,
  accountId: string,
): MailMessageSummary[] {
  const envelope = unwrapResponse(response);
  const items = readArray(envelope, "messages", "items");
  return items.flatMap((item, index) => {
    if (!isRecord(item)) {
      return [];
    }
    const messageId = readString(item, "messageId", "id") ?? `${accountId}:message:${index}`;
    return [
      {
        messageId,
        accountId,
        threadId: readString(item, "threadId"),
        from: readString(item, "from", "sender"),
        to: readStringArray(item, "to", "recipients"),
        subject: readString(item, "subject"),
        snippet: readString(item, "snippet", "preview"),
        receivedAt: readString(item, "receivedAt", "date", "internalDate"),
        labels: readStringArray(item, "labels", "labelIds"),
      },
    ];
  });
}

function normalizeCalendarEvents(
  response: ToolInvokeResult | Record<string, unknown>,
  accountId: string,
  fallbackIso: string,
): CalendarEventRecord[] {
  const envelope = unwrapResponse(response);
  const items = readArray(envelope, "events", "items");
  return items.flatMap((item, index) => {
    if (!isRecord(item)) {
      return [];
    }
    const startIso = readDateLike(item, "startIso", "start");
    const endIso = readDateLike(item, "endIso", "end");
    if (!startIso || !endIso) {
      return [];
    }
    return [
      {
        eventId: readString(item, "eventId", "id") ?? `${accountId}:event:${index}`,
        accountId,
        calendarId: readString(item, "calendarId"),
        title: readString(item, "title", "summary") ?? "Untitled event",
        description: readString(item, "description"),
        startIso,
        endIso,
        attendees: readStringArray(item, "attendees"),
        location: readString(item, "location"),
        externalId: readString(item, "externalId", "id"),
        createdAt: readString(item, "createdAt") ?? fallbackIso,
        updatedAt: readString(item, "updatedAt") ?? fallbackIso,
      },
    ];
  });
}

function unwrapResponse(response: ToolInvokeResult | Record<string, unknown>): Record<string, unknown> {
  if (isToolInvokeResult(response)) {
    return unwrapResponse(response.result ?? {});
  }
  const output = response.output;
  if (isRecord(output)) {
    return output;
  }
  const result = response.result;
  if (isRecord(result)) {
    return unwrapResponse(result);
  }
  return response;
}

function isToolInvokeResult(value: unknown): value is ToolInvokeResult {
  return isRecord(value) && typeof value.outcome === "string" && typeof value.auditEventId === "string";
}

function readArray(record: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function readStringArray(record: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }
    if (typeof value === "string" && value.trim()) {
      return [value.trim()];
    }
  }
  return [];
}

function readDateLike(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (isRecord(value)) {
      const nested = readString(value, "dateTime", "date");
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

function normalizeConfigContacts(
  config: Record<string, unknown>,
  workspaceId: string,
  fallbackIso: string,
): ContactRecord[] {
  return readArray(config, "contacts").flatMap((item, index) => {
    if (!isRecord(item)) {
      return [];
    }
    const emails = readStringArray(item, "emailAddresses", "emails", "email");
    const displayName = readString(item, "displayName", "name") ?? emails[0];
    if (!displayName) {
      return [];
    }
    return [
      {
        contactId: readString(item, "contactId", "id") ?? `config_contact:${index}:${displayName.toLowerCase()}`,
        workspaceId,
        displayName,
        emailAddresses: emails,
        phoneNumbers: readStringArray(item, "phoneNumbers", "phones", "phone"),
        company: readString(item, "company"),
        role: readString(item, "role"),
        externalRefs: [
          {
            provider: readString(item, "provider") ?? "manual",
            externalId: readString(item, "externalId") ?? displayName,
          },
        ],
        lifecycleStatus: "active",
        createdAt: readString(item, "createdAt") ?? fallbackIso,
        updatedAt: readString(item, "updatedAt") ?? fallbackIso,
      },
    ];
  });
}

function sanitizeContact(contact: ContactRecord, workspaceId: string): ContactRecord {
  return {
    contactId: contact.contactId,
    workspaceId,
    displayName: contact.displayName,
    emailAddresses: contact.emailAddresses,
    phoneNumbers: contact.phoneNumbers,
    company: contact.company,
    role: contact.role,
    externalRefs: contact.externalRefs,
    lifecycleStatus: contact.lifecycleStatus,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  };
}

async function createCommunicationsApproval(
  createApproval: CommunicationsDashboardServiceDependencies["createApproval"],
  fallbackApprovalId: string,
  input: ApprovalCreateInput,
): Promise<string> {
  if (!createApproval) {
    return fallbackApprovalId;
  }
  const approval = await createApproval(input);
  return approval.approvalId;
}

function createStableDraftId(nowIso: string, accountId: string, recipients: string[], subject: string): string {
  const seed = `${nowIso}:${accountId}:${recipients.join(",")}:${subject}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return `mail_draft_${hash.toString(16)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
